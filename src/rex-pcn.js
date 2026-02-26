// ═══════════════════════════════════════════════════════════════════
// PCN TRANSDUCER — Predictive Coding Namespace
// Learns patterns from behaviour events via GPU compute.
// Memory matrix M[2048][2048] with surprise-modulated Hebbian learning.
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
        target: u32,
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
        atomicAdd(&deltas[conn.target], delta_fixed);
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
    return {
      episodes: this._episodeCount,
      agents: this._registry.bySlot.size,
      connections: this._connectionCount || 0,
      freeSlots: this._registry.freeSlots.length,
      shrubPeriods: Object.fromEntries(this._shrubPeriods),
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
