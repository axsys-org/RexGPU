// ═══════════════════════════════════════════════════════════════════
// PCN TRANSDUCER — Predictive Coding Namespace
// Learns patterns from behaviour events via GPU compute.
// Memory matrix M[2048][2048] with surprise-modulated Hebbian learning.
// ShrubLM: per-shrub reference frame learning modules (Thousand Brains).
// SDR encoding: path → sparse distributed representation (2048 bits, ~50 active).
// ═══════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';

// ── Constants ──
const SDR_BITS       = 2048;
const SDR_ACTIVE     = 50;     // ~50 active bits per SDR
const MODULE_BITS    = 15;
const PATH_BITS      = 20;
const ACTION_BITS    = 15;
const MATRIX_DIM     = SDR_BITS;  // 2048x2048
const RING_CAPACITY  = 4096;      // episode ring buffer entries
const EVENT_BYTES    = 32;        // bytes per event record
const MAX_AGENTS     = 1024;      // max belief agents (start conservative)
const MAX_CONNECTIONS = 4096;     // max connectome edges
const EMBED_DIM      = 128;       // reduced embedding dim for WebGPU (not 384 — save bandwidth)
const LEARNING_RATE  = 0.01;
const SURPRISE_BETA  = 2.0;
const DECAY_RATE     = 0.999;     // per-event diagonal decay
const ENERGY_DECAY   = 0.85;      // per-iteration propagation decay
const PROPAGATION_ITERS = 3;
const COALITION_TOP_K = 8;
const CRYSTALLIZE_THRESHOLD = 0.8;
const CRYSTALLIZE_MIN_COUNT = 20;

// ── ShrubLM Constants ──
const LM_CRYSTALLIZE_COUNT = 20;       // observations before a prototype can crystallize
const LM_VARIANCE_THRESHOLD = 0.25;    // max normalized variance for crystallization
const LM_SURPRISE_SIGMA = 3.0;         // Mahalanobis distance threshold for surprise
const LM_VOTE_CONFIRM_WEIGHT = 1.0;    // evidence weight for confirming votes
const LM_VOTE_CONTRADICT_WEIGHT = 0.3; // evidence weight for contradicting votes (asymmetric)
const LM_BUFFER_SIZE = 50;             // rolling observation buffer per shrub

// ═══════════════════════════════════════════════════════════════════
// ShrubLM — Per-Shrub Reference Frame Learning Module
// Slot-space as reference frame: N numeric slots → N-dimensional space.
// Talks are displacement vectors. :min/:max normalization = scale invariance.
// Prototype graph learned via Welford running mean/variance.
// Surprise = Mahalanobis distance > 3σ from prototype.
// ═══════════════════════════════════════════════════════════════════

class ShrubLM {
  constructor(shrubName, slotNames, slotRanges) {
    this.shrubName = shrubName;
    this.slotNames = slotNames;         // string[] — ordered numeric slot names (reference frame axes)
    this.slotRanges = slotRanges;       // Map<slotName, {min, max}> — from schema or observed
    this.dim = slotNames.length;

    // Prototype graph: talkName → displacement prototype
    // Each node: {mean: Float64Array, m2: Float64Array, count, rejectCount, crystallized, lastSeen}
    this.prototypes = new Map();

    // Short-term memory: rolling window of recent observations
    this.buffer = [];

    // Evidence state for current inference cycle
    this.evidence = new Map();          // talkName → accumulated evidence

    // Pending votes from lateral connections
    this.pendingVotes = [];

    // CMP port weights: neighborShrub → weight (0..1)
    // Learned via vote accuracy. Ports below 0.05 are pruned.
    this.portWeights = new Map();

    // Pending crystallizations: passed local threshold, awaiting lateral confirmation.
    // talkName → {proto, timestamp}
    this.pendingCrystallizations = new Map();

    // Overall LM state
    this.confidence = 0;
    this.ready = false;                 // all prototypes crystallized
    this.totalObservations = 0;
    this.naturalPeriod = 0;            // set from RexPCN._shrubPeriods — 0 means unknown
  }

  // Normalize a slot delta into [0,1] range using schema/observed ranges
  _normalizeDisplacement(slotDeltas) {
    const disp = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const name = this.slotNames[i];
      const delta = slotDeltas.get(name) || 0;
      const range = this.slotRanges.get(name);
      if (range && range.max > range.min) {
        disp[i] = delta / (range.max - range.min);
      } else {
        disp[i] = delta; // no range info yet — use raw delta
      }
    }
    return disp;
  }

  // Normalize current slot values into [0,1] reference frame coordinates
  _normalizePosition(slots) {
    const pos = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const name = this.slotNames[i];
      const val = slots.get(name);
      if (val === undefined || typeof val !== 'number') continue;
      const range = this.slotRanges.get(name);
      if (range && range.max > range.min) {
        pos[i] = (val - range.min) / (range.max - range.min);
      } else {
        pos[i] = val;
      }
    }
    return pos;
  }

  // Observe a talk event — update prototype graph, detect surprise
  // Returns: {surprise: number, prototype: object|null}
  observe(talkName, slotDeltas, slots, timestamp) {
    if (this.dim === 0 || slotDeltas.size === 0) return { surprise: 0, prototype: null };

    const disp = this._normalizeDisplacement(slotDeltas);
    this.totalObservations++;

    // Update observed ranges from actual slot values
    for (const [name, val] of slots) {
      if (typeof val !== 'number') continue;
      const range = this.slotRanges.get(name);
      if (range) {
        if (range._observed) {
          range._observed.min = Math.min(range._observed.min, val);
          range._observed.max = Math.max(range._observed.max, val);
        } else {
          range._observed = { min: val, max: val };
        }
        // If no schema range, use observed
        if (range.min === undefined || range.max === undefined) {
          range.min = range._observed.min;
          range.max = range._observed.max;
        }
      }
    }

    // Buffer the observation
    this.buffer.push({ talk: talkName, disp, timestamp });
    if (this.buffer.length > LM_BUFFER_SIZE) this.buffer.shift();

    // Normalize current slot positions for pre-state tracking
    const pos = this._normalizePosition(slots);

    // Get or create prototype node
    let proto = this.prototypes.get(talkName);
    if (!proto) {
      proto = {
        mean: new Float64Array(this.dim),
        m2: new Float64Array(this.dim),        // sum of squared differences (Welford) — displacement
        preState: {                            // pre-state: slot positions at talk invocation
          mean: new Float64Array(this.dim),
          m2: new Float64Array(this.dim),
        },
        count: 0,
        rejectCount: 0,
        crystallized: false,
        _notified: false,                      // true once crystallization event has been emitted
        firstSeen: timestamp,
        lastSeen: timestamp,
      };
      this.prototypes.set(talkName, proto);
    }

    // Compute surprise BEFORE updating (compare against current model)
    let surprise = 0;
    if (proto.count >= 3) {
      surprise = this._mahalanobis(disp, proto);
    }

    // Welford online update: displacement mean and variance
    const wasCrystallized = proto.crystallized;
    proto.count++;
    proto.lastSeen = timestamp;
    for (let i = 0; i < this.dim; i++) {
      // Displacement prototype
      const delta1 = disp[i] - proto.mean[i];
      proto.mean[i] += delta1 / proto.count;
      const delta2 = disp[i] - proto.mean[i];
      proto.m2[i] += delta1 * delta2;
      // Pre-state position prototype (same Welford, on absolute position)
      const pd1 = pos[i] - proto.preState.mean[i];
      proto.preState.mean[i] += pd1 / proto.count;
      const pd2 = pos[i] - proto.preState.mean[i];
      proto.preState.m2[i] += pd1 * pd2;
    }

    // Check crystallization: count threshold + time span requirement.
    // A 60Hz game talk needs the same temporal coverage as a weekly checkout talk.
    // Minimum: 20 observations AND span >= 3 natural periods (or 10s if period unknown).
    if (!proto.crystallized && proto.count >= LM_CRYSTALLIZE_COUNT) {
      const span = timestamp - proto.firstSeen;
      const minSpan = this.naturalPeriod > 0 ? this.naturalPeriod * 3 : 10000; // 3 periods or 10s
      if (span >= minSpan) {
        let allLowVariance = true;
        for (let i = 0; i < this.dim; i++) {
          const variance = proto.m2[i] / proto.count;
          if (variance > LM_VARIANCE_THRESHOLD) { allLowVariance = false; break; }
        }
        if (allLowVariance && !this.pendingCrystallizations.has(talkName)) {
          // Enter pending state — requires lateral confirmation before fully crystallizing.
          // If this LM has no known lateral ports, crystallize immediately (isolated shrub).
          if (this.portWeights.size === 0) {
            proto.crystallized = true;
          } else {
            this.pendingCrystallizations.set(talkName, { proto, timestamp });
          }
        }
      }
    }

    // Update overall LM confidence and ready state
    this._updateConfidence();

    // Signal first-time crystallization (for rule synthesis)
    const justCrystallized = proto.crystallized && !wasCrystallized;

    return { surprise, prototype: proto, justCrystallized };
  }

  // Record a guard rejection for a talk pattern
  recordReject(talkName) {
    const proto = this.prototypes.get(talkName);
    if (proto) proto.rejectCount++;
  }

  // Mahalanobis distance from observation to prototype
  _mahalanobis(disp, proto) {
    if (proto.count < 2) return 0;
    let sum = 0;
    for (let i = 0; i < this.dim; i++) {
      const variance = proto.m2[i] / (proto.count - 1);
      if (variance < 1e-10) continue; // skip zero-variance dimensions
      const diff = disp[i] - proto.mean[i];
      sum += (diff * diff) / variance;
    }
    return Math.sqrt(sum);
  }

  // Check if a talk + current state is prototypical (within 2σ, never rejected)
  isPrototypical(talkName, slotDeltas) {
    const proto = this.prototypes.get(talkName);
    if (!proto || !proto.crystallized || proto.rejectCount > 0) return false;
    if (slotDeltas.size === 0) return proto.crystallized; // no-delta talk, just check crystallization

    const disp = this._normalizeDisplacement(slotDeltas);
    const dist = this._mahalanobis(disp, proto);
    return dist < 2.0; // within 2σ
  }

  // Process a lateral vote from another ShrubLM
  receiveVote(vote) {
    this.pendingVotes.push(vote);
  }

  // Process all pending votes — update evidence, port weights, and confirm crystallizations.
  // Returns array of talkNames that just got laterally confirmed (for RexPCN to emit).
  processVotes() {
    const confirmed = [];
    if (this.pendingVotes.length === 0) return confirmed;

    for (const vote of this.pendingVotes) {
      let anyConfirm = false;
      let anyContradict = false;

      // Evidence update + detect confirmation for pending crystallizations
      for (const [talkName, proto] of this.prototypes) {
        if (proto.count < 3) continue;
        const similarity = this._cosineSimilarity(vote.displacement, proto.mean);
        const prevEvidence = this.evidence.get(talkName) || 0;
        const weight = this.portWeights.get(vote.sender) || 0.5;

        if (similarity > 0.5) {
          this.evidence.set(talkName, prevEvidence + vote.confidence * similarity * weight * LM_VOTE_CONFIRM_WEIGHT);
          anyConfirm = true;
          // Lateral confirmation: promote pending crystallization
          if (this.pendingCrystallizations.has(talkName)) {
            const { proto: pendingProto } = this.pendingCrystallizations.get(talkName);
            pendingProto.crystallized = true;
            this.pendingCrystallizations.delete(talkName);
            confirmed.push(talkName);
          }
        } else if (similarity < -0.3) {
          this.evidence.set(talkName, prevEvidence - vote.confidence * Math.abs(similarity) * weight * LM_VOTE_CONTRADICT_WEIGHT);
          anyContradict = true;
        }
      }

      // Update port weight for this sender based on vote accuracy
      const prev = this.portWeights.get(vote.sender) || 0.5;
      if (anyConfirm && !anyContradict) {
        this.portWeights.set(vote.sender, Math.min(1.0, prev + 0.1));
      } else if (anyContradict && !anyConfirm) {
        const next = prev - 0.2;
        if (next < 0.05) {
          this.portWeights.delete(vote.sender); // prune dead port
        } else {
          this.portWeights.set(vote.sender, next);
        }
      }
    }
    this.pendingVotes = [];

    // Expire pending crystallizations older than 30s (no lateral ever came — go solo)
    const now = performance.now();
    for (const [talkName, { proto, timestamp }] of this.pendingCrystallizations) {
      if (now - timestamp > 30000) {
        proto.crystallized = true;
        this.pendingCrystallizations.delete(talkName);
        confirmed.push(talkName);
      }
    }

    return confirmed;
  }

  // Called by RexPCN when a new lateral neighbor is discovered (co-firing detection).
  // Initializes port weight if not already known.
  addPort(neighborShrub) {
    if (!this.portWeights.has(neighborShrub)) {
      this.portWeights.set(neighborShrub, 0.1); // tentative — must earn its weight
    }
  }

  _cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 1e-10 ? dot / denom : 0;
  }

  _updateConfidence() {
    if (this.prototypes.size === 0) { this.confidence = 0; return; }
    let crystallizedCount = 0;
    for (const proto of this.prototypes.values()) {
      if (proto.crystallized) crystallizedCount++;
    }
    this.confidence = crystallizedCount / this.prototypes.size;
    this.ready = this.confidence >= CRYSTALLIZE_THRESHOLD && this.prototypes.size > 0;
  }

  // Build a vote record to send to dependent shrubs
  buildVote(talkName) {
    const proto = this.prototypes.get(talkName);
    if (!proto || proto.count < 3) return null;
    return {
      sender: this.shrubName,
      hypothesis: talkName,
      confidence: this.confidence,
      displacement: Array.from(proto.mean),
      evidence: this.evidence.get(talkName) || 0,
    };
  }

  // Get per-slot confidence for derive gating
  getSlotConfidence(slotName) {
    if (!this.ready) return 1.0; // not crystallized yet — trust derives fully
    // Confidence = average evidence across prototypes that touch this slot
    let total = 0, count = 0;
    const idx = this.slotNames.indexOf(slotName);
    if (idx === -1) return 1.0;
    for (const [, proto] of this.prototypes) {
      if (proto.count < 3) continue;
      if (Math.abs(proto.mean[idx]) > 1e-6) { // this prototype touches this slot
        total += (this.evidence.get(proto) || 0.5);
        count++;
      }
    }
    return count > 0 ? Math.max(0, Math.min(1, total / count)) : 1.0;
  }

  // Find the talk whose displacement best recovers a slot to targetValue.
  //
  // Backward pass (Glass optic backward direction):
  // Instead of asking "which talk moves slot X in the right direction?" (1D brute
  // force), we ask: "which talk, fired from the current N-dimensional position,
  // projects a landing point closest to the target in the full slot space?"
  //
  // Scoring:
  //   1. Primary: distance of (currentPos + displacement)[idx] to normalizedTarget
  //   2. Tiebreak: Mahalanobis distance from currentPos to proto.preState.mean —
  //      how plausible is the current position as a starting point for this talk?
  //      Talks with mismatched preState are penalized (they'd likely be guard-rejected).
  //
  // Returns: {talk, expectedDelta} | null
  findGoalTalk(slotName, targetValue, currentSlots) {
    const idx = this.slotNames.indexOf(slotName);
    if (idx === -1) return null;

    const slots = currentSlots instanceof Map ? currentSlots : new Map(Object.entries(currentSlots || {}));
    const currentVal = slots.get(slotName);
    if (typeof currentVal !== 'number') return null;

    // Normalize current full position into reference frame
    const currentPos = this._normalizePosition(slots);

    // Normalize target value for the surprise slot
    const range = this.slotRanges.get(slotName);
    let normalizedTarget;
    if (range && range.max > range.min) {
      normalizedTarget = (targetValue - range.min) / (range.max - range.min);
    } else {
      normalizedTarget = targetValue;
    }

    if (Math.abs(normalizedTarget - currentPos[idx]) < 1e-8) return null; // already at target

    let bestTalk = null;
    let bestScore = Infinity;

    for (const [talkName, proto] of this.prototypes) {
      if (proto.rejectCount > 0 || proto.count < 3) continue;
      const meanDisp = proto.mean[idx];
      if (Math.abs(meanDisp) < 1e-6) continue; // talk doesn't move this slot

      // Primary: projected landing distance on the surprise slot axis
      const landingIdx = currentPos[idx] + meanDisp;
      const primaryDist = Math.abs(normalizedTarget - landingIdx);

      // Tiebreak: Mahalanobis-style pre-state plausibility (diagonal covariance)
      // How far is the current position from where this talk is typically invoked?
      let preStatePenalty = 0;
      if (proto.preState && proto.count > 1) {
        for (let i = 0; i < this.dim; i++) {
          const variance = proto.preState.m2[i] / (proto.count - 1);
          if (variance < 1e-8) continue;
          const diff = currentPos[i] - proto.preState.mean[i];
          preStatePenalty += (diff * diff) / variance;
        }
        preStatePenalty = Math.sqrt(preStatePenalty / this.dim); // normalize by dim
      }

      // Combined score: primary distance + 10% preState penalty weight
      const score = primaryDist + 0.1 * preStatePenalty;
      if (score < bestScore) {
        bestScore = score;
        bestTalk = talkName;
      }
    }

    if (!bestTalk) return null;

    // Denormalize expected delta back to raw slot units
    const proto = this.prototypes.get(bestTalk);
    let expectedDelta = proto.mean[idx];
    if (range && range.max > range.min) {
      expectedDelta *= (range.max - range.min);
    }

    return { talk: bestTalk, expectedDelta };
  }

  // Synthesize a Rex guard expression from the pre-state statistics of a crystallized prototype.
  // Only produces a guard when the prototype has been rejected at least once (rejectCount > 0),
  // meaning the learned bounds actually protect against observed failure patterns.
  // Returns: string (Rex expression) | null
  synthesizeGuard(talkName) {
    const proto = this.prototypes.get(talkName);
    if (!proto || !proto.crystallized || proto.rejectCount === 0) return null;
    if (proto.count < 2 || !proto.preState) return null;

    const clauses = [];
    for (let i = 0; i < this.dim; i++) {
      const variance = proto.preState.m2[i] / (proto.count - 1);
      if (variance < 1e-8) continue;        // zero-variance dimension — no useful bound
      if (Math.abs(proto.mean[i]) < 1e-6) continue; // talk doesn't displace this slot

      const name = this.slotNames[i];
      const range = this.slotRanges.get(name);
      const sigma2 = 2 * Math.sqrt(variance);

      // Compute normalized bounds from pre-state mean ± 2σ
      let lower = proto.preState.mean[i] - sigma2;
      let upper = proto.preState.mean[i] + sigma2;

      // Denormalize back to raw slot units
      if (range && range.max > range.min) {
        const span = range.max - range.min;
        lower = lower * span + range.min;
        upper = upper * span + range.min;
      }

      // Round for readability
      lower = Math.round(lower * 10000) / 10000;
      upper = Math.round(upper * 10000) / 10000;

      // Only emit bounds that are tighter than schema range
      if (range && range.min !== undefined && lower > range.min) {
        clauses.push(`(gte /${name} ${lower})`);
      }
      if (range && range.max !== undefined && upper < range.max) {
        clauses.push(`(lte /${name} ${upper})`);
      }
    }

    if (clauses.length === 0) return null;
    if (clauses.length === 1) return clauses[0];
    return `(and ${clauses.join(' ')})`;
  }

  getStats() {
    const protos = {};
    for (const [name, proto] of this.prototypes) {
      protos[name] = {
        count: proto.count,
        crystallized: proto.crystallized,
        rejectCount: proto.rejectCount,
        mean: Array.from(proto.mean),
        variance: proto.count > 1 ? Array.from(proto.m2).map(v => v / (proto.count - 1)) : [],
        preState: proto.preState ? {
          mean: Array.from(proto.preState.mean),
          variance: proto.count > 1 ? Array.from(proto.preState.m2).map(v => v / (proto.count - 1)) : [],
        } : null,
      };
    }
    return {
      shrub: this.shrubName,
      dim: this.dim,
      slots: this.slotNames,
      confidence: this.confidence,
      ready: this.ready,
      totalObservations: this.totalObservations,
      prototypes: protos,
      portWeights: Object.fromEntries(this.portWeights),
      pendingCrystallizations: [...this.pendingCrystallizations.keys()],
    };
  }
}

export class RexPCN {
  constructor(device, log) {
    this.device = device;
    this.log = log || (() => {});
    this._compiled = false;

    // ── GPU resources ──
    this._matrixBuffer = null;      // M[2048][2048] as f32 = 16MB
    this._sdrBuffer = null;         // current SDR vector (2048 u32 bits packed as 64 u32s)
    this._prevSdrBuffer = null;     // previous SDR for transition learning
    this._ringBuffer = null;        // episode ring buffer
    this._ringMetaBuffer = null;    // ring head/tail/count
    this._agentBuffer = null;       // agent data (energy, confidence, state, embedding)
    this._connectionBuffer = null;  // connectome edges
    this._signalBuffer = null;      // outbound signals (crystallize, reflect, etc)
    this._paramsBuffer = null;      // learning rate, decay, etc

    // ── Pipelines ──
    this._pcnUpdatePipeline = null;
    this._cuePipeline = null;
    this._propagationAccPipeline = null;
    this._propagationApplyPipeline = null;
    this._decayPipeline = null;
    this._crystallizePipeline = null;

    // ── JS-side state ──
    this._agents = new Map();         // name → {slot, name, description, affordances, confidence, state}
    this._registry = {
      bySlot: new Map(),              // slot → agent entry
      byPath: new Map(),              // path → slot
      nextSlot: 0,
      freeSlots: [],
    };
    this._episodeCount = 0;
    this._ringHead = 0;
    this._pendingEvents = [];         // events to upload this frame
    this._lastSdr = new Uint32Array(SDR_BITS / 32);  // packed bits
    this._signals = [];               // outbound signals to process

    // ── Timescale tracking ──
    this._shrubTimestamps = new Map();  // shrub → [timestamps] for median interval
    this._shrubPeriods = new Map();     // shrub → natural_period

    // ── Readback ──
    this._readbackBuffer = null;
    this._readbackPending = false;

    // ── ShrubLM layer (Thousand Brains) ──
    this._shrubLMs = new Map();         // shrubName → ShrubLM
    this._depGraph = [];                // cached [{from, to, label, path}] for vote routing
    this._pendingVotes = new Map();     // shrubName → VoteRecord[]
    this._recentFirings = new Map();    // shrubName → timestamp — for co-firing port discovery
    this._coFiringWindow = 50;          // ms — two shrubs firing within this window → candidate port
    this.onSurpriseSignal = null;       // callback(shrub, slot, value, {min,max}) — LM-detected surprise
    this.onCrystallize = null;          // callback({shrub, talk, guard}) — synthesized rule from crystallization
  }

  // ════════════════════════════════════════════════════════════════
  // INIT — Create GPU buffers and compile shaders
  // ════════════════════════════════════════════════════════════════

  async init() {
    if (!this.device) return false;

    // Memory matrix: 2048 * 2048 * 4 bytes = 16,777,216 bytes (16MB)
    const matrixSize = MATRIX_DIM * MATRIX_DIM * 4;
    this._matrixBuffer = this.device.createBuffer({
      label: 'pcn-matrix',
      size: matrixSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // SDR buffers: packed as u32 words. 2048 bits = 64 u32s = 256 bytes
    // But for compute shader convenience, store as f32[2048] (0.0 or 1.0)
    const sdrSize = SDR_BITS * 4;
    this._sdrBuffer = this.device.createBuffer({
      label: 'pcn-sdr',
      size: sdrSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._prevSdrBuffer = this.device.createBuffer({
      label: 'pcn-prev-sdr',
      size: sdrSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Observed SDR (target for learning)
    this._observedSdrBuffer = this.device.createBuffer({
      label: 'pcn-observed-sdr',
      size: sdrSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Episode ring buffer: RING_CAPACITY * EVENT_BYTES
    this._ringBuffer = this.device.createBuffer({
      label: 'pcn-ring',
      size: RING_CAPACITY * EVENT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Ring metadata: [head, tail, count, capacity]
    this._ringMetaBuffer = this.device.createBuffer({
      label: 'pcn-ring-meta',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Agent buffer: MAX_AGENTS * agent_stride
    // Per agent: energy(f32) + confidence(f32) + energyPool(f32) + state(u32) + embedding(EMBED_DIM * f32)
    const agentStride = (4 + EMBED_DIM) * 4;  // 132 * 4 = 528 bytes
    this._agentBuffer = this.device.createBuffer({
      label: 'pcn-agents',
      size: MAX_AGENTS * agentStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Delta buffer for two-pass propagation (avoids f32 atomics race)
    // One f32 per agent — accumulates energy deltas before applying
    this._deltaBuffer = this.device.createBuffer({
      label: 'pcn-deltas',
      size: MAX_AGENTS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Connection buffer: MAX_CONNECTIONS * connection_stride
    // Per connection: source(u32) + target(u32) + gate(f32) + weight(f32) + sign(f32)
    this._connectionBuffer = this.device.createBuffer({
      label: 'pcn-connections',
      size: MAX_CONNECTIONS * 20,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Params buffer: uniforms for shaders
    // [learningRate, surpriseBeta, decayRate, energyDecay, matrixDim, numAgents, numConnections, iterCount]
    this._paramsBuffer = this.device.createBuffer({
      label: 'pcn-params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Signal buffer for readback (crystallization signals)
    this._signalBuffer = this.device.createBuffer({
      label: 'pcn-signals',
      size: MAX_AGENTS * 8,  // per agent: strength(f32) + flags(u32)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Readback staging buffer
    this._readbackBuffer = this.device.createBuffer({
      label: 'pcn-readback',
      size: MAX_AGENTS * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Write initial params
    this._uploadParams();

    // Compile compute shaders
    await this._compilePipelines();

    this._compiled = true;
    this.log(`pcn: initialized — ${(matrixSize / 1024 / 1024).toFixed(1)}MB matrix, ${RING_CAPACITY} ring slots, ${MAX_AGENTS} agent slots`, 'ok');
    return true;
  }

  _uploadParams() {
    const params = new Float32Array([
      LEARNING_RATE, SURPRISE_BETA, DECAY_RATE, ENERGY_DECAY,
      MATRIX_DIM, 0, 0, 0,  // numAgents and numConnections set per frame
    ]);
    this.device.queue.writeBuffer(this._paramsBuffer, 0, params);
  }

  // ════════════════════════════════════════════════════════════════
  // SDR ENCODING — path → sparse distributed representation
  // ════════════════════════════════════════════════════════════════

  encodeSdr(shrubPath, actionType, moduleName) {
    const sdr = new Float32Array(SDR_BITS);

    // Module bits (if present)
    if (moduleName) {
      const moduleBits = this._hashToBits(moduleName, MODULE_BITS, 0);
      for (const bit of moduleBits) sdr[bit] = 1.0;
    }

    // Path bits — each segment hashed with depth
    const segments = shrubPath.split('/').filter(Boolean);
    const pathBitCount = moduleName ? PATH_BITS : (PATH_BITS + MODULE_BITS);
    const pathBits = new Set();
    for (let depth = 0; depth < segments.length; depth++) {
      const segBits = this._hashToBits(`${segments[depth]}:${depth}`, Math.ceil(pathBitCount / Math.max(segments.length, 1)), 7919);
      for (const bit of segBits) pathBits.add(bit);
    }
    for (const bit of pathBits) sdr[bit] = 1.0;

    // Action bits (if present)
    if (actionType) {
      const actionBits = this._hashToBits(actionType, ACTION_BITS, 104729);
      for (const bit of actionBits) sdr[bit] = 1.0;
    }

    return sdr;
  }

  _hashToBits(str, count, seed) {
    const bits = new Set();
    let h = seed || 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    // Generate `count` distinct bit positions via simple multiplicative hash
    for (let i = 0; bits.size < count && i < count * 10; i++) {
      h = Math.imul(h, 2654435761) + i;
      const bit = ((h >>> 0) % SDR_BITS);
      bits.add(bit);
    }
    return bits;
  }

  sdrSimilarity(a, b) {
    let intersection = 0, union = 0;
    for (let i = 0; i < SDR_BITS; i++) {
      const aOn = a[i] > 0.5;
      const bOn = b[i] > 0.5;
      if (aOn && bOn) intersection++;
      if (aOn || bOn) union++;
    }
    return union > 0 ? intersection / union : 0;
  }

  // ════════════════════════════════════════════════════════════════
  // EPISODE INGESTION — from behaviour events
  // ════════════════════════════════════════════════════════════════

  pushEpisode(episode) {
    // Episode: { source, shrub, path, talk, mode, timestamp }
    this._pendingEvents.push(episode);

    // Track timescale
    const ts = episode.timestamp || performance.now();
    if (!this._shrubTimestamps.has(episode.shrub)) {
      this._shrubTimestamps.set(episode.shrub, []);
    }
    const stamps = this._shrubTimestamps.get(episode.shrub);
    stamps.push(ts);
    if (stamps.length > 100) stamps.shift();  // rolling window
    if (stamps.length > 2) {
      this._updateNaturalPeriod(episode.shrub, stamps);
    }

    this._episodeCount++;
  }

  _updateNaturalPeriod(shrub, stamps) {
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) {
      gaps.push(stamps[i] - stamps[i - 1]);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    const natural = median * 100;  // observation_multiplier = 100
    const clamped = Math.max(3600000, Math.min(365 * 86400000, natural));  // 1hr to 1yr

    const prev = this._shrubPeriods.get(shrub);
    if (prev) {
      // Smoothed adaptation: α=0.15, clamp ±25%
      const adapted = prev + 0.15 * (clamped - prev);
      const lo = prev * 0.75, hi = prev * 1.25;
      this._shrubPeriods.set(shrub, Math.max(lo, Math.min(hi, adapted)));
    } else {
      this._shrubPeriods.set(shrub, clamped);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // TRANSDUCE — called each frame from main loop
  // ════════════════════════════════════════════════════════════════

  transduce(commandEncoder) {
    // Process ShrubLM lateral votes every cycle (JS-side, no GPU needed)
    this._processAllVotes();

    if (!this._compiled || this._pendingEvents.length === 0) return;

    // Process pending events: encode SDRs, upload, dispatch compute
    for (const event of this._pendingEvents) {
      this._processEvent(event, commandEncoder);
    }
    this._pendingEvents = [];
  }

  _processEvent(event, enc) {
    // 1. Encode current event as SDR
    const currentSdr = this.encodeSdr(
      `${event.shrub}/${event.path || ''}`,
      event.talk || event.mode || 'dif',
      null  // module detection TBD
    );

    // 2. Upload SDRs to GPU
    // Previous SDR becomes input, current SDR becomes observed (target)
    this.device.queue.writeBuffer(this._sdrBuffer, 0, this._lastSdr);
    this.device.queue.writeBuffer(this._observedSdrBuffer, 0, currentSdr);

    // 3. Update params with current agent/connection counts
    const params = new Float32Array([
      LEARNING_RATE, SURPRISE_BETA, DECAY_RATE, ENERGY_DECAY,
      MATRIX_DIM, this._registry.nextSlot, 0, 0,
    ]);
    this.device.queue.writeBuffer(this._paramsBuffer, 0, params);

    // 4. Dispatch PCN update kernel
    if (this._pcnUpdatePipeline) {
      const pass = enc.beginComputePass({ label: 'pcn-update' });
      pass.setPipeline(this._pcnUpdatePipeline);
      pass.setBindGroup(0, this._pcnUpdateBindGroup);
      // One workgroup per matrix row (2048 rows, 256 threads per workgroup = 8 rows per dispatch)
      pass.dispatchWorkgroups(Math.ceil(MATRIX_DIM / 256));
      pass.end();
    }

    // 5. Dispatch crystallization check
    if (this._crystallizePipeline && this._registry.nextSlot > 0) {
      const pass = enc.beginComputePass({ label: 'pcn-crystallize' });
      pass.setPipeline(this._crystallizePipeline);
      pass.setBindGroup(0, this._crystallizeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MATRIX_DIM / 256));
      pass.end();
    }

    // 6. Save current SDR as previous for next event
    this._lastSdr = currentSdr;
  }

  // ════════════════════════════════════════════════════════════════
  // CUE — fire a query through the connectome
  // ════════════════════════════════════════════════════════════════

  cue(querySdr, commandEncoder) {
    if (!this._compiled || !this._cuePipeline) return;

    // Upload query SDR
    this.device.queue.writeBuffer(this._sdrBuffer, 0, querySdr);

    // Update agent count
    const params = new Float32Array([
      LEARNING_RATE, SURPRISE_BETA, DECAY_RATE, ENERGY_DECAY,
      MATRIX_DIM, this._registry.nextSlot, this._connectionCount || 0, PROPAGATION_ITERS,
    ]);
    this.device.queue.writeBuffer(this._paramsBuffer, 0, params);

    // 1. Cue kernel: dot product of query against all agent embeddings
    {
      const pass = commandEncoder.beginComputePass({ label: 'pcn-cue' });
      pass.setPipeline(this._cuePipeline);
      pass.setBindGroup(0, this._cueBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_AGENTS / 64));
      pass.end();
    }

    // 2. Settle loop: propagate → normalize, repeated NUM_STEPS times
    const agentWgs = Math.ceil(MAX_AGENTS / 256);
    const connWgs = Math.ceil(MAX_CONNECTIONS / 64);
    for (let step = 0; step < PROPAGATION_ITERS; step++) {
      // Two-pass propagation: accumulate deltas, then apply (avoids f32 atomics race)
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-propagate-acc-${step}` });
        pass.setPipeline(this._propagationAccPipeline);
        pass.setBindGroup(0, this._propagationAccBindGroup);
        pass.dispatchWorkgroups(connWgs);
        pass.end();
      }
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-propagate-apply-${step}` });
        pass.setPipeline(this._propagationApplyPipeline);
        pass.setBindGroup(0, this._propagationApplyBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
      // Normalize: sum energies then redistribute to conserve budget
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-norm-sum-${step}` });
        pass.setPipeline(this._normSumPipeline);
        pass.setBindGroup(0, this._normSumBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-norm-apply-${step}` });
        pass.setPipeline(this._normApplyPipeline);
        pass.setBindGroup(0, this._normApplyBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
    }

    // 3. Sparsify: zero agents below top-K threshold, write to signal buffer
    {
      const pass = commandEncoder.beginComputePass({ label: 'pcn-sparsify' });
      pass.setPipeline(this._sparsifyPipeline);
      pass.setBindGroup(0, this._sparsifyBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_AGENTS / 64));
      pass.end();
    }

    // 4. Decay all energies back toward zero (ready for next cue)
    {
      const pass = commandEncoder.beginComputePass({ label: 'pcn-decay' });
      pass.setPipeline(this._decayPipeline);
      pass.setBindGroup(0, this._decayBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_AGENTS / 64));
      pass.end();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // READBACK — get coalition results from GPU
  // ════════════════════════════════════════════════════════════════

  async readCoalition() {
    if (this._readbackPending || !this._compiled) return null;
    this._readbackPending = true;

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this._signalBuffer, 0, this._readbackBuffer, 0, MAX_AGENTS * 8);
    this.device.queue.submit([enc.finish()]);

    await this._readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this._readbackBuffer.getMappedRange().slice(0));
    this._readbackBuffer.unmap();
    this._readbackPending = false;

    // Parse coalition: agents with energy above threshold
    const coalition = [];
    for (let i = 0; i < MAX_AGENTS; i++) {
      const energy = data[i * 2];
      const flags = new Uint32Array(data.buffer, (i * 2 + 1) * 4, 1)[0];
      if (energy > 0.1) {
        const agent = this._registry.bySlot.get(i);
        if (agent) {
          coalition.push({ slot: i, energy, flags, ...agent });
        }
      }
    }

    // Sort by energy descending, take top K
    coalition.sort((a, b) => b.energy - a.energy);
    return coalition.slice(0, COALITION_TOP_K);
  }

  // ════════════════════════════════════════════════════════════════
  // AGENT MANAGEMENT — JS-side registry
  // ════════════════════════════════════════════════════════════════

  spawnAgent(name, description, affordances, sourceShrubs) {
    const slot = this._registry.freeSlots.length > 0
      ? this._registry.freeSlots.pop()
      : this._registry.nextSlot++;

    if (slot >= MAX_AGENTS) {
      this.log(`pcn: agent limit reached (${MAX_AGENTS})`, 'warn');
      return null;
    }

    const entry = {
      slot,
      name,
      description: description || '',
      affordances: affordances || [],
      confidence: 0.5,
      energyPool: 50.0,
      state: 'alive',
      sourceShrubs: sourceShrubs || [],
      born: performance.now(),
      lastConfirmed: performance.now(),
    };

    this._registry.bySlot.set(slot, entry);
    this._registry.byPath.set(name, slot);
    this._agents.set(name, entry);

    // Upload agent data to GPU
    this._uploadAgent(slot, entry);

    this.log(`pcn: agent spawned "${name}" @ slot ${slot}`, 'ok');
    return entry;
  }

  _uploadAgent(slot, entry) {
    // Agent stride: energy(f32) + confidence(f32) + energyPool(f32) + state(u32) + embedding[EMBED_DIM]
    const stride = (4 + EMBED_DIM);
    const data = new Float32Array(stride);
    data[0] = 0;                    // energy (starts at 0)
    data[1] = entry.confidence;
    data[2] = entry.energyPool;
    data[3] = entry.state === 'alive' ? 1.0 : 0.0;

    // Simple embedding from description text (hash-based, no LLM yet)
    const desc = entry.description || entry.name;
    for (let i = 0; i < EMBED_DIM; i++) {
      let h = i * 7919;
      for (let j = 0; j < desc.length; j++) {
        h = ((h << 5) - h + desc.charCodeAt(j)) | 0;
      }
      data[4 + i] = (((h >>> 0) % 2000) - 1000) / 1000.0;  // normalize to [-1, 1]
    }

    this.device.queue.writeBuffer(this._agentBuffer, slot * stride * 4, data);
  }

  killAgent(name) {
    const slot = this._registry.byPath.get(name);
    if (slot === undefined) return;

    const entry = this._registry.bySlot.get(slot);
    if (entry) entry.state = 'retired';

    // Zero out GPU slot
    const stride = (4 + EMBED_DIM);
    const zeros = new Float32Array(stride);
    this.device.queue.writeBuffer(this._agentBuffer, slot * stride * 4, zeros);

    this._registry.bySlot.delete(slot);
    this._registry.byPath.delete(name);
    this._agents.delete(name);
    this._registry.freeSlots.push(slot);

    this.log(`pcn: agent killed "${name}" — slot ${slot} freed`, 'ok');
  }

  // ════════════════════════════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ════════════════════════════════════════════════════════════════

  addConnection(sourceSlot, targetSlot, weight, gate, sign) {
    const idx = this._connectionCount || 0;
    if (idx >= MAX_CONNECTIONS) {
      this.log('pcn: connection limit reached', 'warn');
      return;
    }

    // Connection: source(u32) + target(u32) + gate(f32) + weight(f32) + sign(f32) = 20 bytes
    const data = new ArrayBuffer(20);
    const u32 = new Uint32Array(data, 0, 2);
    const f32 = new Float32Array(data, 8, 3);
    u32[0] = sourceSlot;
    u32[1] = targetSlot;
    f32[0] = gate || 0.1;
    f32[1] = weight || 1.0;
    f32[2] = sign || 1.0;

    this.device.queue.writeBuffer(this._connectionBuffer, idx * 20, data);
    this._connectionCount = idx + 1;
  }

  // ════════════════════════════════════════════════════════════════
  // COMPILE PIPELINES — WGSL compute shaders
  // ════════════════════════════════════════════════════════════════

  async _compilePipelines() {
    // ── PCN Update Kernel ──
    // Hebbian learning: M += α × outer(input, observed) × (1 + β × error)
    const pcnUpdateCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read_write> matrix: array<f32>;
      @group(0) @binding(1) var<storage, read>       input_sdr: array<f32>;
      @group(0) @binding(2) var<storage, read>       observed_sdr: array<f32>;
      @group(0) @binding(3) var<uniform>             params: Params;

      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let row = gid.x;
        let dim = u32(params.matrixDim);
        if (row >= dim) { return; }

        let input_val = input_sdr[row];
        if (input_val < 0.5) { return; }  // sparse: skip inactive rows

        // Predict: y[row] = dot(M[row], input)
        var predicted: f32 = 0.0;
        for (var j: u32 = 0u; j < dim; j++) {
          predicted += matrix[row * dim + j] * input_sdr[j];
        }

        // Update row: M[row][j] += α × input[row] × observed[j] × (1 + β × |error_j|)
        for (var j: u32 = 0u; j < dim; j++) {
          let observed_val = observed_sdr[j];
          let error = abs(observed_val - predicted);
          let surprise = 1.0 + params.surpriseBeta * error;
          let delta = params.learningRate * input_val * observed_val * surprise;

          let idx = row * dim + j;
          matrix[idx] = matrix[idx] * params.decayRate + delta;
        }
      }
    `;

    // ── Cue Kernel ──
    // dot(query_embedding, agent_embedding) → initial energy
    const cueCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      // Agent layout: [energy, confidence, energyPool, state, embedding[${EMBED_DIM}]...]
      @group(0) @binding(0) var<storage, read_write> agents: array<f32>;
      @group(0) @binding(1) var<storage, read>       query_sdr: array<f32>;
      @group(0) @binding(2) var<uniform>             params: Params;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;
      const EMBED_OFFSET: u32 = 4u;
      const EMBED_DIM: u32 = ${EMBED_DIM}u;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let agent_id = gid.x;
        if (agent_id >= u32(params.numAgents)) { return; }

        let base = agent_id * AGENT_STRIDE;
        let state = agents[base + 3u];
        if (state < 0.5) { return; }  // dead agent

        // Compute SDR-based similarity using matrix prediction
        // For now: use embedding dot product as proxy
        var sim: f32 = 0.0;
        for (var d: u32 = 0u; d < EMBED_DIM; d++) {
          // Use a portion of query_sdr as pseudo-embedding
          let q_idx = d % ${SDR_BITS}u;
          sim += query_sdr[q_idx] * agents[base + EMBED_OFFSET + d];
        }

        // Write initial energy (clamped positive)
        agents[base] = max(0.0, sim);
      }
    `;

    // ── Propagation Kernels (two-pass to avoid f32 atomics race) ──
    // Pass 1: Accumulate deltas into separate buffer using atomicAdd on i32 (fixed-point)
    // Pass 2: Apply accumulated deltas back to agent energy
    const propagationAccumulateCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      struct Connection {
        source: u32,
        dst:    u32,
        gate:   f32,
        weight: f32,
        sign:   f32,
      }

      @group(0) @binding(0) var<storage, read> agents: array<f32>;
      @group(0) @binding(1) var<storage, read> connections: array<Connection>;
      @group(0) @binding(2) var<uniform>       params: Params;
      @group(0) @binding(3) var<storage, read_write> deltas: array<atomic<i32>>;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;
      const FIXED_SCALE: f32 = 65536.0;  // f32 → i32 fixed-point scale

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let conn_id = gid.x;
        if (conn_id >= u32(params.numConns)) { return; }

        let conn = connections[conn_id];
        let source_base = conn.source * AGENT_STRIDE;

        let source_energy = agents[source_base];
        if (source_energy <= conn.gate) { return; }

        let transmitted = (source_energy - conn.gate) * conn.weight * conn.sign;

        // Accumulate as fixed-point i32 to use atomicAdd (no f32 atomics in WGSL)
        let delta_fixed = i32(transmitted * FIXED_SCALE);
        atomicAdd(&deltas[conn.dst], delta_fixed);
      }
    `;

    const propagationApplyCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read_write> agents: array<f32>;
      @group(0) @binding(1) var<storage, read_write> deltas: array<atomic<i32>>;
      @group(0) @binding(2) var<uniform>             params: Params;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;
      const FIXED_SCALE: f32 = 65536.0;

      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let agent_id = gid.x;
        if (agent_id >= u32(params.numAgents)) { return; }

        let base = agent_id * AGENT_STRIDE;
        let delta_fixed = atomicExchange(&deltas[agent_id], 0);  // read and clear
        let delta = f32(delta_fixed) / FIXED_SCALE;
        agents[base] = agents[base] + delta;
      }
    `;

    // ── Normalization Kernel ──
    // Conserve total energy budget after each propagation step
    // Two-pass: (1) compute sum in shared memory, (2) normalize each agent
    const normalizeCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read_write> agents: array<f32>;
      @group(0) @binding(1) var<storage, read_write> scratch: array<f32>;
      @group(0) @binding(2) var<uniform>             params: Params;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;
      const ENERGY_BUDGET: f32 = 10.0;

      var<workgroup> shared_sum: array<f32, 256>;

      @compute @workgroup_size(256)
      fn sum_pass(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
        let agent_id = gid.x;
        let n = u32(params.numAgents);
        var val: f32 = 0.0;
        if (agent_id < n) {
          val = max(0.0, agents[agent_id * AGENT_STRIDE]);
        }
        shared_sum[lid] = val;
        workgroupBarrier();
        // Tree reduction
        for (var stride: u32 = 128u; stride > 0u; stride >>= 1u) {
          if (lid < stride) { shared_sum[lid] += shared_sum[lid + stride]; }
          workgroupBarrier();
        }
        if (lid == 0u) { scratch[gid.x / 256u] = shared_sum[0]; }
      }

      @compute @workgroup_size(256)
      fn normalize_pass(@builtin(global_invocation_id) gid: vec3u) {
        let agent_id = gid.x;
        let n = u32(params.numAgents);
        if (agent_id >= n) { return; }

        // Sum the partial sums from scratch (max ~4 workgroups for 1024 agents)
        var total: f32 = 0.0;
        let num_groups = (n + 255u) / 256u;
        for (var i: u32 = 0u; i < num_groups; i++) { total += scratch[i]; }

        if (total > 0.001) {
          let base = agent_id * AGENT_STRIDE;
          let e = agents[base];
          agents[base] = max(0.0, e) / total * ENERGY_BUDGET;
        }
      }
    `;

    // ── Sparsification Kernel ──
    // Zero out agents below top-K threshold
    const sparsifyCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read_write> agents: array<f32>;
      @group(0) @binding(1) var<storage, read_write> signals: array<f32>;
      @group(0) @binding(2) var<uniform>             params: Params;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;
      const TOP_K: u32 = ${COALITION_TOP_K}u;

      // Simple threshold: find the TOP_K-th highest energy via insertion sort in shared mem
      var<workgroup> top_energies: array<f32, ${COALITION_TOP_K}>;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
        let agent_id = gid.x;
        let n = u32(params.numAgents);

        // Initialize top_energies with -1
        if (lid < TOP_K) { top_energies[lid] = -1.0; }
        workgroupBarrier();

        // Each thread checks its agent and tries to insert into top-K
        if (agent_id < n) {
          let e = agents[agent_id * AGENT_STRIDE];
          if (e > top_energies[TOP_K - 1u]) {
            // Simple bubble insert (approximate — races are OK, we just need a threshold)
            top_energies[TOP_K - 1u] = e;
            // Bubble up
            for (var k: u32 = TOP_K - 1u; k > 0u; k--) {
              if (top_energies[k] > top_energies[k - 1u]) {
                let tmp = top_energies[k]; top_energies[k] = top_energies[k - 1u]; top_energies[k - 1u] = tmp;
              }
            }
          }
        }
        workgroupBarrier();

        // Zero agents below threshold
        if (agent_id < n) {
          let base = agent_id * AGENT_STRIDE;
          let e = agents[base];
          let threshold = top_energies[TOP_K - 1u];
          if (e < threshold && threshold > 0.0) {
            agents[base] = 0.0;
          }
          // Write final energy to signal buffer for readback
          signals[agent_id * 2u] = agents[base];
          signals[agent_id * 2u + 1u] = agents[base + 1u]; // confidence
        }
      }
    `;

    // ── Decay Kernel ──
    // Apply energy decay after full settle cycle
    const decayCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read_write> agents: array<f32>;
      @group(0) @binding(1) var<storage, read_write> signals: array<f32>;
      @group(0) @binding(2) var<uniform>             params: Params;

      const AGENT_STRIDE: u32 = ${4 + EMBED_DIM}u;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let agent_id = gid.x;
        if (agent_id >= u32(params.numAgents)) { return; }

        let base = agent_id * AGENT_STRIDE;
        let state = agents[base + 3u];
        if (state < 0.5) { return; }

        // Decay energy
        agents[base] = agents[base] * params.energyDecay;

        // Write to signal buffer for readback
        signals[agent_id * 2u] = agents[base];         // energy
        signals[agent_id * 2u + 1u] = agents[base + 1u]; // confidence (as float bits)
      }
    `;

    // ── Crystallization Check ──
    // Check diagonal of matrix for self-correlation strength
    const crystallizeCode = /* wgsl */ `
      struct Params {
        learningRate: f32,
        surpriseBeta: f32,
        decayRate:    f32,
        energyDecay:  f32,
        matrixDim:    f32,
        numAgents:    f32,
        numConns:     f32,
        iterCount:    f32,
      }

      @group(0) @binding(0) var<storage, read>       matrix: array<f32>;
      @group(0) @binding(1) var<storage, read_write>  signals: array<f32>;
      @group(0) @binding(2) var<uniform>              params: Params;

      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let idx = gid.x;
        let dim = u32(params.matrixDim);
        if (idx >= dim) { return; }

        // Self-correlation: M[idx][idx]
        let self_corr = matrix[idx * dim + idx];

        // Write crystallization strength to signal buffer
        // We pack bit index and strength for JS-side processing
        if (self_corr > ${CRYSTALLIZE_THRESHOLD}) {
          // Mark bit as crystallized — JS will aggregate SDR patterns
          signals[idx * 2u] = self_corr;
          signals[idx * 2u + 1u] = 1.0;  // crystallized flag
        }
      }
    `;

    // Scratch buffer for normalization reduction
    this._scratchBuffer = this.device.createBuffer({
      label: 'pcn-scratch', size: 256 * 4, // max workgroups * f32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create shader modules
    try {
      const pcnUpdateModule = this.device.createShaderModule({ label: 'pcn-update', code: pcnUpdateCode });
      const cueModule = this.device.createShaderModule({ label: 'pcn-cue', code: cueCode });
      const propagationAccModule = this.device.createShaderModule({ label: 'pcn-propagation-accumulate', code: propagationAccumulateCode });
      const propagationApplyModule = this.device.createShaderModule({ label: 'pcn-propagation-apply', code: propagationApplyCode });
      const normSumModule = this.device.createShaderModule({ label: 'pcn-norm-sum', code: normalizeCode });
      const normApplyModule = this.device.createShaderModule({ label: 'pcn-norm-apply', code: normalizeCode });
      const sparsifyModule = this.device.createShaderModule({ label: 'pcn-sparsify', code: sparsifyCode });
      const decayModule = this.device.createShaderModule({ label: 'pcn-decay', code: decayCode });
      const crystallizeModule = this.device.createShaderModule({ label: 'pcn-crystallize', code: crystallizeCode });

      // Create pipelines
      this._pcnUpdatePipeline = this.device.createComputePipeline({
        label: 'pcn-update', layout: 'auto',
        compute: { module: pcnUpdateModule, entryPoint: 'main' },
      });
      this._cuePipeline = this.device.createComputePipeline({
        label: 'pcn-cue', layout: 'auto',
        compute: { module: cueModule, entryPoint: 'main' },
      });
      this._propagationAccPipeline = this.device.createComputePipeline({
        label: 'pcn-propagation-accumulate', layout: 'auto',
        compute: { module: propagationAccModule, entryPoint: 'main' },
      });
      this._propagationApplyPipeline = this.device.createComputePipeline({
        label: 'pcn-propagation-apply', layout: 'auto',
        compute: { module: propagationApplyModule, entryPoint: 'main' },
      });
      this._normSumPipeline = this.device.createComputePipeline({
        label: 'pcn-norm-sum', layout: 'auto',
        compute: { module: normSumModule, entryPoint: 'sum_pass' },
      });
      this._normApplyPipeline = this.device.createComputePipeline({
        label: 'pcn-norm-apply', layout: 'auto',
        compute: { module: normApplyModule, entryPoint: 'normalize_pass' },
      });
      this._sparsifyPipeline = this.device.createComputePipeline({
        label: 'pcn-sparsify', layout: 'auto',
        compute: { module: sparsifyModule, entryPoint: 'main' },
      });
      this._decayPipeline = this.device.createComputePipeline({
        label: 'pcn-decay', layout: 'auto',
        compute: { module: decayModule, entryPoint: 'main' },
      });
      this._crystallizePipeline = this.device.createComputePipeline({
        label: 'pcn-crystallize', layout: 'auto',
        compute: { module: crystallizeModule, entryPoint: 'main' },
      });

      // Create bind groups
      this._pcnUpdateBindGroup = this.device.createBindGroup({
        layout: this._pcnUpdatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._matrixBuffer } },
          { binding: 1, resource: { buffer: this._sdrBuffer } },
          { binding: 2, resource: { buffer: this._observedSdrBuffer } },
          { binding: 3, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._cueBindGroup = this.device.createBindGroup({
        layout: this._cuePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._sdrBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._propagationAccBindGroup = this.device.createBindGroup({
        layout: this._propagationAccPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._connectionBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
          { binding: 3, resource: { buffer: this._deltaBuffer } },
        ],
      });
      this._propagationApplyBindGroup = this.device.createBindGroup({
        layout: this._propagationApplyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._deltaBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._decayBindGroup = this.device.createBindGroup({
        layout: this._decayPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._signalBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._normSumBindGroup = this.device.createBindGroup({
        layout: this._normSumPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._scratchBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._normApplyBindGroup = this.device.createBindGroup({
        layout: this._normApplyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._scratchBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._sparsifyBindGroup = this.device.createBindGroup({
        layout: this._sparsifyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._agentBuffer } },
          { binding: 1, resource: { buffer: this._signalBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this._crystallizeBindGroup = this.device.createBindGroup({
        layout: this._crystallizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._matrixBuffer } },
          { binding: 1, resource: { buffer: this._signalBuffer } },
          { binding: 2, resource: { buffer: this._paramsBuffer } },
        ],
      });

      this.log('pcn: 8 compute pipelines compiled', 'ok');
    } catch (e) {
      this.log(`pcn: shader compile error: ${e.message}`, 'err');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // RIGHT-CLICK LOCALITY CUE — inject energy by dep path, no LLM
  // ════════════════════════════════════════════════════════════════

  cueByLocality(shrubPaths, commandEncoder) {
    if (!this._compiled || !this._cuePipeline) return;

    // Find agents that have deps on any of the given shrub paths
    const agentSlots = new Set();
    for (const [name, entry] of this._agents) {
      if (entry.sourceShrubs) {
        for (const src of entry.sourceShrubs) {
          if (shrubPaths.some(p => src.startsWith(p) || p.startsWith(src))) {
            agentSlots.add(entry.slot);
          }
        }
      }
    }

    if (agentSlots.size === 0) return;

    // Direct energy injection: write initial energy to agent buffer for matching slots
    const stride = 4 + EMBED_DIM;
    for (const slot of agentSlots) {
      const data = new Float32Array(1);
      data[0] = 1.0; // initial energy = 1.0 (locality cue strength)
      this.device.queue.writeBuffer(this._agentBuffer, slot * stride * 4, data);
    }

    // Run the settle cycle (propagate + normalize + sparsify + decay)
    const agentWgs = Math.ceil(MAX_AGENTS / 256);
    const connWgs = Math.ceil(MAX_CONNECTIONS / 64);

    for (let step = 0; step < PROPAGATION_ITERS; step++) {
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-loc-propagate-acc-${step}` });
        pass.setPipeline(this._propagationAccPipeline);
        pass.setBindGroup(0, this._propagationAccBindGroup);
        pass.dispatchWorkgroups(connWgs);
        pass.end();
      }
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-loc-propagate-apply-${step}` });
        pass.setPipeline(this._propagationApplyPipeline);
        pass.setBindGroup(0, this._propagationApplyBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-loc-norm-sum-${step}` });
        pass.setPipeline(this._normSumPipeline);
        pass.setBindGroup(0, this._normSumBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
      {
        const pass = commandEncoder.beginComputePass({ label: `pcn-loc-norm-apply-${step}` });
        pass.setPipeline(this._normApplyPipeline);
        pass.setBindGroup(0, this._normApplyBindGroup);
        pass.dispatchWorkgroups(agentWgs);
        pass.end();
      }
    }

    {
      const pass = commandEncoder.beginComputePass({ label: 'pcn-loc-sparsify' });
      pass.setPipeline(this._sparsifyPipeline);
      pass.setBindGroup(0, this._sparsifyBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_AGENTS / 64));
      pass.end();
    }

    {
      const pass = commandEncoder.beginComputePass({ label: 'pcn-loc-decay' });
      pass.setPipeline(this._decayPipeline);
      pass.setBindGroup(0, this._decayBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_AGENTS / 64));
      pass.end();
    }

    this.log(`pcn: locality cue on ${shrubPaths.join(', ')} → ${agentSlots.size} agents ignited`, 'ok');
  }

  // ════════════════════════════════════════════════════════════════
  // BEHAVIOUR EVENT BRIDGE — auto-ingest from behaviour transducer
  // ════════════════════════════════════════════════════════════════

  bridgeBehaviourEvent(source, shrubName, path, talk, mode) {
    this.pushEpisode({
      source: source || 'talk',
      shrub: shrubName,
      path: path || '',
      talk: talk || null,
      mode: mode || 'dif',
      timestamp: performance.now(),
    });
  }

  // Bridge a form field change as a render-input episode
  bridgeFormEvent(fieldName, value) {
    this.pushEpisode({
      source: 'render-input',
      shrub: 'form',
      path: fieldName,
      talk: null,
      mode: 'dif',
      timestamp: performance.now(),
    });
  }

  // ════════════════════════════════════════════════════════════════
  // BEHAVIOUR-FIRST API
  // ════════════════════════════════════════════════════════════════

  // Register a @shrub as a named PCN agent. Idempotent — safe to call on every compile.
  registerShrubAgent(shrubName, talkNames) {
    if (this._agents.has(shrubName)) {
      this._agents.get(shrubName).affordances = talkNames || [];
      return this._agents.get(shrubName);
    }
    return this.spawnAgent(
      shrubName,
      `shrub:${shrubName} talks:[${(talkNames || []).join(',')}]`,
      talkNames || [],
      [shrubName],
    );
  }

  // Auto-wire cross-shrub dep paths as connectome edges. Idempotent.
  wireConnectomeFromDeps(edges) {
    if (!this._wiredEdges) this._wiredEdges = new Set();
    for (const edge of edges) {
      const key = `${edge.from}->${edge.to}`;
      if (this._wiredEdges.has(key)) continue;
      const fromSlot = this._registry.byPath.get(edge.from);
      const toSlot   = this._registry.byPath.get(edge.to);
      if (fromSlot === undefined || toSlot === undefined) continue;
      this.addConnection(fromSlot, toSlot, 0.5, 0.05, 1.0);
      this._wiredEdges.add(key);
      this.log(`pcn: connectome ${edge.from} → ${edge.to} (dep:${edge.label})`, 'ok');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // SHRUB-LM LAYER — Per-shrub reference frame learning modules
  // ════════════════════════════════════════════════════════════════

  // Register schema info for a shrub so its ShrubLM knows slot ranges.
  // Called from main.js on recompile.
  registerShrubSchema(shrubName, schema) {
    const slotNames = [];
    const slotRanges = new Map();
    for (const [key, def] of Object.entries(schema)) {
      if (key.startsWith('_')) continue; // skip internal
      const val = def.default !== undefined ? def.default : def;
      if (typeof val === 'number' || def.type === 'number') {
        slotNames.push(key);
        slotRanges.set(key, {
          min: def.min !== undefined ? def.min : undefined,
          max: def.max !== undefined ? def.max : undefined,
        });
      }
    }
    if (slotNames.length === 0) return; // no numeric slots → no reference frame
    const existing = this._shrubLMs.get(shrubName);
    if (existing) {
      // Update ranges but keep learned prototypes
      existing.slotRanges = slotRanges;
    } else {
      this._shrubLMs.set(shrubName, new ShrubLM(shrubName, slotNames, slotRanges));
    }
  }

  // Get or create ShrubLM for a shrub (lazy init from observation data).
  _ensureShrubLM(shrubName, slotDeltas) {
    let lm = this._shrubLMs.get(shrubName);
    if (lm) return lm;
    // No schema was registered — infer slot names from the deltas
    if (!slotDeltas || slotDeltas.size === 0) return null;
    const slotNames = [];
    const slotRanges = new Map();
    for (const [key, val] of slotDeltas) {
      if (typeof val === 'number') {
        slotNames.push(key);
        slotRanges.set(key, { min: undefined, max: undefined });
      }
    }
    if (slotNames.length === 0) return null;
    lm = new ShrubLM(shrubName, slotNames, slotRanges);
    this._shrubLMs.set(shrubName, lm);
    return lm;
  }

  // Cache the dep graph for vote routing (called from main.js on recompile).
  // Known dep edges are seeded at port weight 0.5 (trusted, not tentative).
  setDepGraph(edges) {
    this._depGraph = edges || [];
    for (const edge of this._depGraph) {
      const fromLM = this._shrubLMs.get(edge.from);
      const toLM = this._shrubLMs.get(edge.to);
      // Seed both directions at 0.5 only if no existing weight (preserve learned weights)
      if (fromLM && !fromLM.portWeights.has(edge.to)) fromLM.portWeights.set(edge.to, 0.5);
      if (toLM && !toLM.portWeights.has(edge.from)) toLM.portWeights.set(edge.from, 0.5);
    }
  }

  // Emit votes from a ShrubLM to all lateral neighbors.
  // Routes along dep graph edges AND discovered co-firing ports.
  // Vote confidence is scaled by the sender's port weight toward each recipient.
  _emitVotes(shrubName, talkName) {
    const lm = this._shrubLMs.get(shrubName);
    if (!lm) return;
    const vote = lm.buildVote(talkName);
    if (!vote) return;

    // Collect all target LMs: dep graph edges + LMs that have this shrub as a port
    const targets = new Set();
    for (const edge of this._depGraph) {
      if (edge.to === shrubName) targets.add(edge.from);
      if (edge.from === shrubName) targets.add(edge.to);
    }
    // Also include any LM that has a port weight for this shrub
    for (const [name, targetLM] of this._shrubLMs) {
      if (name !== shrubName && targetLM.portWeights.has(shrubName)) {
        targets.add(name);
      }
    }

    for (const targetName of targets) {
      const targetLM = this._shrubLMs.get(targetName);
      if (!targetLM) continue;
      // Scale vote confidence by the target's port weight toward this sender
      const portWeight = targetLM.portWeights.get(shrubName) || 0.5;
      if (portWeight < 0.05) continue; // pruned port — skip
      const weightedVote = { ...vote, confidence: vote.confidence * portWeight };
      targetLM.receiveVote(weightedVote);
    }
  }

  // Detect co-firing between shrubs and create tentative CMP ports.
  // Two shrubs firing within _coFiringWindow ms → add each other as candidate neighbors.
  // New ports start at weight 0.1 and must earn weight through vote accuracy.
  _discoverPorts(shrubName, timestamp) {
    const lm = this._shrubLMs.get(shrubName);
    if (!lm) return;

    // Check all other recently-fired shrubs
    for (const [otherName, otherTs] of this._recentFirings) {
      if (otherName === shrubName) continue;
      if (Math.abs(timestamp - otherTs) <= this._coFiringWindow) {
        const otherLM = this._shrubLMs.get(otherName);
        if (!otherLM) continue;
        // Add port in both directions if not already known
        const isNew = !lm.portWeights.has(otherName);
        lm.addPort(otherName);
        otherLM.addPort(shrubName);
        if (isNew) {
          this.log(`pcn: discovered CMP port ${shrubName} ↔ ${otherName} (co-firing)`, 'ok');
        }
      }
    }

    // Record this firing (prune stale entries older than window)
    this._recentFirings.set(shrubName, timestamp);
    if (this._recentFirings.size > 64) {
      // Evict entries older than 2x the window
      for (const [name, ts] of this._recentFirings) {
        if (timestamp - ts > this._coFiringWindow * 2) this._recentFirings.delete(name);
      }
    }
  }

  // Process pending votes on all ShrubLMs — call once per transduce cycle.
  // Collects laterally-confirmed crystallizations and emits onCrystallize.
  _processAllVotes() {
    for (const [shrubName, lm] of this._shrubLMs) {
      const confirmed = lm.processVotes();
      if (confirmed.length > 0 && this.onCrystallize) {
        for (const talkName of confirmed) {
          const rule = this.synthesizeRule(shrubName, talkName);
          if (rule) this.onCrystallize(rule);
        }
      }
    }
  }

  // Get ShrubLM for external access (behaviour guard bypass, diagnostics).
  getShrubLM(shrubName) {
    return this._shrubLMs.get(shrubName) || null;
  }

  // Synthesize a Rex guard rule from a crystallized prototype.
  // Validates the expression via Rex.compileExpr before returning.
  synthesizeRule(shrubName, talkName) {
    const lm = this._shrubLMs.get(shrubName);
    if (!lm) return null;
    const guard = lm.synthesizeGuard(talkName);
    if (!guard) return null;
    // Validate: must be parseable Rex
    try {
      const compiled = Rex.compileExpr({ expr: guard });
      if (!compiled) return null;
    } catch (e) {
      this.log(`pcn: synthesized guard failed to compile: ${guard} — ${e.message}`, 'err');
      return null;
    }
    this.log(`pcn: synthesized guard for ${shrubName}/${talkName}: ${guard}`, 'ok');
    return { shrub: shrubName, talk: talkName, guard };
  }

  // Find the best corrective talk to move a slot toward a target value.
  // Used by the recovery policy in rex-behaviour.js.
  findGoalState(shrubName, slotName, targetValue, currentSlots) {
    const lm = this._shrubLMs.get(shrubName);
    if (!lm) return null;
    return lm.findGoalTalk(slotName, targetValue, currentSlots);
  }

  // Primary intake for rich behaviour events from onTalkFired.
  pushBehaviourEvent(record) {
    const ts = record.timestamp || performance.now();

    // ── ShrubLM observation ──
    const slotDeltas = record.slot_deltas instanceof Map
      ? record.slot_deltas
      : new Map(Object.entries(record.slot_deltas || {}));
    const lm = this._ensureShrubLM(record.shrub, slotDeltas);
    if (lm) {
      // Sync natural period so crystallization is time-aware
      const period = this._shrubPeriods.get(record.shrub);
      if (period) lm.naturalPeriod = period;

      // Build pre-state slot map (values BEFORE the talk) for position prototype tracking
      const preSlots = new Map();
      for (const { path, old_val, new_val } of (record.mutations_fired || [])) {
        const slotName = path.includes('/') ? path.split('/').pop() : path;
        const pre = typeof old_val === 'number' ? old_val : (typeof new_val === 'number' ? new_val : null);
        if (pre !== null) preSlots.set(slotName, pre);
      }
      const { surprise, justCrystallized } = lm.observe(record.talk, slotDeltas, preSlots, ts);

      // LM-detected surprise → fire surprise signal
      if (surprise > LM_SURPRISE_SIGMA && this.onSurpriseSignal) {
        this.onSurpriseSignal(record.shrub, record.talk, surprise, {
          threshold: LM_SURPRISE_SIGMA, mahalanobis: surprise,
        });
      }

      // Guard rejection → record in prototype
      if (!record.guard_result) lm.recordReject(record.talk);

      // First-time crystallization with rejections → synthesize rule
      if (justCrystallized && this.onCrystallize) {
        const rule = this.synthesizeRule(record.shrub, record.talk);
        if (rule) this.onCrystallize(rule);
      }

      // Emit votes to lateral neighbors
      this._emitVotes(record.shrub, record.talk);

      // Port discovery: detect co-firing within window → tentative new port
      this._discoverPorts(record.shrub, ts);
    }

    // ── Existing Hebbian matrix integration ──
    // Main episode for the Hebbian matrix
    this.pushEpisode({ source: 'talk', shrub: record.shrub, path: record.talk,
      talk: record.talk, mode: 'talk', timestamp: ts });

    // Per-slot mutation episodes — matrix learns slot-action co-occurrence
    for (const { path } of (record.mutations_fired || [])) {
      this.pushEpisode({ source: 'mutation', shrub: record.shrub, path,
        talk: record.talk, mode: 'dif', timestamp: ts });
    }

    // Guard rejection — inhibitory signal
    if (!record.guard_result) {
      this.pushEpisode({ source: 'guard-reject', shrub: record.shrub, path: record.talk,
        talk: record.talk, mode: 'inhibit', timestamp: ts });
    }

    // Track observed value ranges per agent for feedback constraint generation
    const agentEntry = this._agents.get(record.shrub);
    if (agentEntry) {
      for (const { path, new_val } of (record.mutations_fired || [])) {
        if (typeof new_val !== 'number') continue;
        if (!agentEntry._observedRanges) agentEntry._observedRanges = new Map();
        const r = agentEntry._observedRanges.get(path);
        if (!r) {
          agentEntry._observedRanges.set(path, { min: new_val, max: new_val, count: 1 });
        } else {
          r.min = Math.min(r.min, new_val);
          r.max = Math.max(r.max, new_val);
          r.count++;
        }
      }
    }
  }

  // Called when a @derive value exits schema-declared range — high-surprise signal.
  pushSurpriseSignal(shrubName, slotName, value, schemaRange) {
    // Boost agent energy on GPU to strengthen learning signal
    const agentEntry = this._agents.get(shrubName);
    if (agentEntry && this.device && this._agentBuffer) {
      const stride = (4 + EMBED_DIM);
      const energyBoost = new Float32Array([2.0]);
      this.device.queue.writeBuffer(this._agentBuffer, agentEntry.slot * stride * 4, energyBoost);
    }
    // Hebbian episode for the surprise event
    this.pushEpisode({ source: 'surprise', shrub: shrubName, path: slotName,
      talk: null, mode: 'surprise', timestamp: performance.now() });
  }

  // Return crystallized behavioural constraints derived from observed slot ranges.
  // [{shrub, slot, suggestedMin, suggestedMax, confidence}]
  getFeedbackConstraints() {
    const constraints = [];
    for (const [name, agent] of this._agents) {
      if (agent.confidence <= CRYSTALLIZE_THRESHOLD || !agent._observedRanges) continue;
      for (const [slot, range] of agent._observedRanges) {
        if (range.count >= CRYSTALLIZE_MIN_COUNT) {
          constraints.push({ shrub: name, slot,
            suggestedMin: range.min, suggestedMax: range.max,
            confidence: agent.confidence });
        }
      }
    }
    return constraints;
  }

  // ════════════════════════════════════════════════════════════════
  // CRYSTALLIZATION SIGNAL PROCESSING — JS-side
  // ════════════════════════════════════════════════════════════════

  async processSignals() {
    const coalition = await this.readCoalition();
    if (!coalition || coalition.length === 0) return [];

    const signals = [];
    for (const agent of coalition) {
      // Check confidence for crystallization
      if (agent.confidence > CRYSTALLIZE_THRESHOLD && agent.state === 'alive') {
        signals.push({ type: 'crystallize', agent: agent.name, confidence: agent.confidence, energy: agent.energy });
      }
    }

    // Check for weak agents that should be pruned
    for (const [name, entry] of this._agents) {
      if (entry.energyPool < 5.0 && entry.state === 'alive') {
        // Drain agent — hasn't been activated in a long time
        const age = performance.now() - entry.born;
        const period = this._shrubPeriods.get(entry.sourceShrubs?.[0]) || 86400000;
        if (age > period * 3) {
          signals.push({ type: 'reflect', agent: name, energyPool: entry.energyPool });
        }
      }
    }

    return signals;
  }

  // ════════════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════════════

  getStats() {
    const shrubLMs = {};
    for (const [name, lm] of this._shrubLMs) {
      shrubLMs[name] = lm.getStats();
    }
    return {
      episodes: this._episodeCount,
      agents: this._registry.bySlot.size,
      connections: this._connectionCount || 0,
      freeSlots: this._registry.freeSlots.length,
      shrubPeriods: Object.fromEntries(this._shrubPeriods),
      shrubLMs,
    };
  }

  destroy() {
    for (const buf of [
      this._matrixBuffer, this._sdrBuffer, this._prevSdrBuffer,
      this._observedSdrBuffer, this._ringBuffer, this._ringMetaBuffer,
      this._agentBuffer, this._connectionBuffer, this._signalBuffer,
      this._paramsBuffer, this._readbackBuffer, this._scratchBuffer,
    ]) {
      if (buf) buf.destroy();
    }
    this._compiled = false;
  }
}
