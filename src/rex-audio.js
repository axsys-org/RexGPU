// ═══════════════════════════════════════════════════════════════════════
// AUDIO TRANSDUCER
// Pattern-based live-coding audio engine for Rex notation
//
// Compile/execute split matching GPU + Surface + Behaviour transducers:
//   transduce(tree, structureChanged) → compile if dirty, then execute
//   compile(tree)  → _clocks, _patterns, _synths, _instruments, _buses, _effects, _scores, _plugins
//   execute()      → tick scheduler, dispatch Web Audio events, update FFT
//
// Pattern model: Pattern = Arc → Event[]  (TidalCycles/Strudel algebra)
// Scheduling:    dual-clock (setInterval lookahead + AudioContext.currentTime)
// Synthesis:     AudioWorklet (PolyBLEP + SVF) + Web Audio node graph
//
// Extension protocol (matches GPU/Surface/Behaviour transducers):
//   registerSynthType(name, { compile(node)→def, create(ctx,def,params)→{node,stop} })
//   registerEffectType(name, { compile(node)→def, create(ctx,def)→{input,output} })
//   registerPatternFn(name, (node, patEnv)→Pattern)
//   registerClock(name, (node)→{ cps:()→number, phase:()→Frac })
// ═══════════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';

// ── Rational arithmetic (exact cycle time, no float drift) ──────────────
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }

class Frac {
  constructor(n, d = 1) {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(Math.abs(n), d);
    this.n = n / g;
    this.d = d / g;
  }
  add(b) { return new Frac(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b) { return new Frac(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b) { return new Frac(this.n * b.n, this.d * b.d); }
  div(b) { return new Frac(this.n * b.d, this.d * b.n); }
  lt(b)  { return this.n * b.d < b.n * this.d; }
  lte(b) { return this.n * b.d <= b.n * this.d; }
  eq(b)  { return this.n * b.d === b.n * this.d; }
  floor(){ return Math.floor(this.n / this.d); }
  valueOf() { return this.n / this.d; }
  toString() { return `${this.n}/${this.d}`; }
  static of(v) {
    if (Number.isInteger(v)) return new Frac(v);
    const d = 48;
    return new Frac(Math.round(v * d), d);
  }
}

// ── Arc (time interval in cycle space) ──────────────────────────────────
class Arc {
  constructor(begin, end) {
    this.begin = begin instanceof Frac ? begin : new Frac(begin);
    this.end   = end   instanceof Frac ? end   : new Frac(end);
  }
  intersect(other) {
    const b = this.begin.lt(other.begin) ? other.begin : this.begin;
    const e = this.end.lt(other.end)     ? this.end    : other.end;
    return b.lt(e) ? new Arc(b, e) : null;
  }
  spanCycles() {
    const arcs = [];
    let s = this.begin;
    while (s.lt(this.end)) {
      const next = new Frac(s.floor() + 1);
      const e = next.lt(this.end) ? next : this.end;
      arcs.push(new Arc(s, e));
      s = next;
    }
    return arcs;
  }
  toString() { return `[${this.begin}..${this.end}]`; }
}

// ── Event ────────────────────────────────────────────────────────────────
class Event {
  constructor(whole, part, value) {
    this.whole = whole;
    this.part  = part;
    this.value = value;
  }
  withValue(v) { return new Event(this.whole, this.part, v); }
  key() { return this.whole ? this.whole.toString() : this.part.toString(); }
}

// ── Pattern ──────────────────────────────────────────────────────────────
class Pattern {
  constructor(queryFn) { this._q = queryFn; }
  query(arc)   { return this._q(arc); }
  fmap(f)      { return new Pattern(a => this._q(a).map(e => e.withValue(f(e.value)))); }
  // Monad bind: f(value) → Pattern — pattern-indexed pattern selection
  flatMap(f)   {
    return new Pattern(arc => {
      const outer = this._q(arc);
      return outer.flatMap(e => {
        const inner = f(e.value);
        return inner.query(e.part).map(ie => {
          const wh = e.whole && ie.whole ? e.whole.intersect(ie.whole) : (e.whole || ie.whole);
          return new Event(wh, ie.part, ie.value);
        });
      });
    });
  }
  fast(n)      { return _fast(new Frac(n), this); }
  slow(n)      { return _fast(new Frac(1, n), this); }
  every(n, f)  { return _every(n, f, this); }
}

function silence() { return new Pattern(() => []); }

function pure(v) {
  return new Pattern(arc => {
    return arc.spanCycles().map(a => {
      const w = new Arc(new Frac(a.begin.floor()), new Frac(a.begin.floor() + 1));
      const part = w.intersect(arc);
      return part ? new Event(w, part, v) : null;
    }).filter(Boolean);
  });
}

function stack(pats) {
  return new Pattern(arc => pats.flatMap(p => p.query(arc)));
}

function _fast(factor, pat) {
  return new Pattern(arc => {
    const qArc = new Arc(arc.begin.mul(factor), arc.end.mul(factor));
    return pat.query(qArc).map(e => new Event(
      e.whole ? new Arc(e.whole.begin.div(factor), e.whole.end.div(factor)) : null,
      new Arc(e.part.begin.div(factor), e.part.end.div(factor)),
      e.value
    ));
  });
}

function fastcat(pats) {
  if (!pats.length) return silence();
  const n = new Frac(pats.length);
  return _fast(n, _cat(pats));
}

function _cat(pats) {
  return new Pattern(arc => {
    const len = pats.length;
    return arc.spanCycles().flatMap(a => {
      const i = ((a.begin.floor() % len) + len) % len;
      const offset = new Frac(a.begin.floor() - (a.begin.floor() - i) % len);
      const shifted = new Arc(a.begin.sub(offset), a.end.sub(offset));
      return pats[i].query(shifted).map(e => new Event(
        e.whole ? new Arc(e.whole.begin.add(offset), e.whole.end.add(offset)) : null,
        new Arc(e.part.begin.add(offset), e.part.end.add(offset)),
        e.value
      ));
    });
  });
}

function slowcat(pats) { return _cat(pats); }

function _every(n, f, pat) {
  return new Pattern(arc =>
    arc.spanCycles().flatMap(a => {
      const c = a.begin.floor();
      const p = c % n === 0 ? f(pat) : pat;
      return p.query(a);
    })
  );
}

// ── Euclidean rhythm — Bjorklund algorithm ────────────────────────────────
function bjorklund(k, n) {
  if (k <= 0) return Array(n).fill(false);
  if (k >= n) return Array(n).fill(true);
  let ones = Array(k).fill([true]);
  let zeros = Array(n - k).fill([false]);
  function distribute(o, z) {
    if (z.length <= 1) return o.map(a => [...a, ...z.flat()]);
    const pairs = o.map((a, i) => i < z.length ? [...a, ...z[i]] : a);
    const rem = z.length > o.length ? z.slice(o.length) : pairs.slice(z.length);
    const base = z.length > o.length ? pairs : pairs.slice(0, z.length);
    return distribute(base, rem);
  }
  return distribute(ones, zeros).flat();
}

function euclidPat(k, n, rotation = 0) {
  const bits = bjorklund(k, n);
  const rot = ((rotation % n) + n) % n;
  const rotated = [...bits.slice(rot), ...bits.slice(0, rot)];
  return fastcat(rotated.map(b => b ? pure(true) : silence()));
}

function struct(boolPat, soundPat) {
  return new Pattern(arc => {
    const bs = boolPat.query(arc);
    const ss = soundPat.query(arc);
    const result = [];
    for (const be of bs) {
      if (!be.value) continue;
      for (const se of ss) {
        const part = be.part.intersect(se.part);
        if (!part) continue;
        const wh = be.whole && se.whole ? be.whole.intersect(se.whole) : (be.whole || se.whole);
        result.push(new Event(wh, part, se.value));
      }
    }
    return result;
  });
}

// ── Markov chain pattern ───────────────────────────────────────────────────
// matrix: Map(fromValue → [{to, weight}])
function markovPat(initial, matrix) {
  let current = initial;
  return new Pattern(arc => {
    return arc.spanCycles().flatMap(a => {
      const w = new Arc(new Frac(a.begin.floor()), new Frac(a.begin.floor() + 1));
      const part = w.intersect(arc);
      if (!part) return [];
      const ev = new Event(w, part, current);
      // Transition for next cycle
      const row = matrix.get(current);
      if (row && row.length) {
        const total = row.reduce((s, e) => s + e.weight, 0);
        let r = Math.random() * total;
        for (const { to, weight } of row) {
          r -= weight;
          if (r <= 0) { current = to; break; }
        }
      }
      return [ev];
    });
  });
}

// ── Note helpers ──────────────────────────────────────────────────────────
const NOTE_NAMES = { c:0, d:2, e:4, f:5, g:7, a:9, b:11 };
function noteToFreq(name) {
  if (typeof name === 'number') return name;
  const m = String(name).toLowerCase().match(/^([a-g])([#b]?)(-?\d+)$/);
  if (!m) return 440;
  const base = NOTE_NAMES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const oct  = parseInt(m[3]);
  const midi = 12 * (oct + 1) + base;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ── Scale helpers ──────────────────────────────────────────────────────────
const SCALES = {
  major:       [0,2,4,5,7,9,11],
  minor:       [0,2,3,5,7,8,10],
  dorian:      [0,2,3,5,7,9,10],
  phrygian:    [0,1,3,5,7,8,10],
  lydian:      [0,2,4,6,7,9,11],
  mixolydian:  [0,2,4,5,7,9,10],
  locrian:     [0,1,3,5,6,8,10],
  pentatonic:  [0,2,4,7,9],
  blues:       [0,3,5,6,7,10],
  chromatic:   [0,1,2,3,4,5,6,7,8,9,10,11],
  wholetone:   [0,2,4,6,8,10],
  diminished:  [0,2,3,5,6,8,9,11],
};

// Degree (0-based) → semitone offset within scale, then → Hz
function degreeToFreq(degree, scale, rootMidi = 60) {
  const steps = SCALES[scale] || SCALES.major;
  const octave = Math.floor(degree / steps.length);
  const idx = ((degree % steps.length) + steps.length) % steps.length;
  const semitone = rootMidi + steps[idx] + octave * 12;
  return 440 * Math.pow(2, (semitone - 69) / 12);
}

// ── Mini-notation parser ──────────────────────────────────────────────────
function parseMini(str) {
  str = str.trim();
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    if (/\s/.test(str[i])) { i++; continue; }
    if (str[i] === '[') { tokens.push({t:'['}); i++; }
    else if (str[i] === ']') { tokens.push({t:']'}); i++; }
    else if (str[i] === '<') { tokens.push({t:'<'}); i++; }
    else if (str[i] === '>') { tokens.push({t:'>'}); i++; }
    else {
      let w = '';
      while (i < str.length && !/[\s\[\]<>]/.test(str[i])) { w += str[i++]; }
      tokens.push({t:'w', v:w});
    }
  }

  function parseSeq(toks) {
    const elems = [];
    let j = 0;
    while (j < toks.length) {
      const tk = toks[j];
      if (tk.t === '[') {
        let depth = 1, k = j + 1;
        while (k < toks.length && depth > 0) { if (toks[k].t === '[') depth++; else if (toks[k].t === ']') depth--; k++; }
        const inner = toks.slice(j + 1, k - 1);
        let node = parseSeq(inner);
        j = k;
        node = applyModifier(node, toks, j);
        j = skipModifier(toks, j);
        elems.push(node);
      } else if (tk.t === '<') {
        let depth = 1, k = j + 1;
        while (k < toks.length && depth > 0) { if (toks[k].t === '<') depth++; else if (toks[k].t === '>') depth--; k++; }
        const inner = toks.slice(j + 1, k - 1);
        const parts = splitAtTopLevel(inner);
        const altPats = parts.map(p => miniToPat([{t:'w',v:p.map(x=>x.v||'').join(' ')}]));
        let node = slowcat(altPats);
        j = k;
        node = applyModifier(node, toks, j);
        j = skipModifier(toks, j);
        elems.push(node);
      } else if (tk.t === 'w') {
        let node = atomPat(tk.v);
        j++;
        node = applyModifier(node, toks, j);
        j = skipModifier(toks, j);
        elems.push(node);
      } else { j++; }
    }
    return elems.length === 0 ? silence()
         : elems.length === 1 ? elems[0]
         : fastcat(elems);
  }

  function atomPat(v) {
    const em = v.match(/^(.+?)\((\d+),(\d+)(?:,(\d+))?\)$/);
    if (em) {
      const base = atomPat(em[1]);
      const k = parseInt(em[2]), n = parseInt(em[3]), r = parseInt(em[4] || '0');
      return struct(euclidPat(k, n, r), base);
    }
    const f = noteToFreq(v);
    const isNote = /^[a-gA-G][#b]?\d+$/.test(v);
    return pure(isNote ? { s: v, freq: f, note: v } : { s: v });
  }

  function applyModifier(node, toks, j) {
    if (j >= toks.length || toks[j].t !== 'w') return node;
    const v = toks[j].v;
    if (v.startsWith('*')) { const n = parseFloat(v.slice(1)); if (!isNaN(n)) return node.fast(n); }
    else if (v.startsWith('/')) { const n = parseFloat(v.slice(1)); if (!isNaN(n)) return node.slow(n); }
    return node;
  }

  function skipModifier(toks, j) {
    if (j < toks.length && toks[j].t === 'w') {
      const v = toks[j].v;
      if (v.startsWith('*') || v.startsWith('/') || v.startsWith('!') || v.startsWith('@')) return j + 1;
    }
    return j;
  }

  function splitAtTopLevel(toks) {
    return toks.filter(t => t.t === 'w').map(t => [t]);
  }

  function miniToPat(toks) { return parseSeq(toks); }

  return parseSeq(tokens);
}

// ── Voice allocator ───────────────────────────────────────────────────────
// Manages a fixed polyphony pool using steal-oldest policy
class VoiceAllocator {
  constructor(maxVoices = 8) {
    this.maxVoices = maxVoices;
    this._voices = []; // [{key, node, stopFn, startedAt}]
  }

  alloc(key) {
    // If voice for this key exists, return it (retrigger)
    const existing = this._voices.find(v => v.key === key);
    if (existing) return existing;
    // If pool is full, steal oldest
    if (this._voices.length >= this.maxVoices) {
      const oldest = this._voices.shift();
      try { oldest.stopFn(0); } catch(e) {}
    }
    const slot = { key, node: null, stopFn: () => {}, startedAt: 0 };
    this._voices.push(slot);
    return slot;
  }

  release(key) {
    const idx = this._voices.findIndex(v => v.key === key);
    if (idx !== -1) this._voices.splice(idx, 1);
  }

  releaseAll() {
    for (const v of this._voices) try { v.stopFn(0); } catch(e) {}
    this._voices = [];
  }
}

// ── RexAudio Transducer ───────────────────────────────────────────────────
export class RexAudio {
  constructor(log) {
    this.log = log || (() => {});
    this._ctx       = null;
    this._master    = null;
    this._analyser  = null;
    this._compiled  = false;

    // Compiled data from tree
    this._clocks      = new Map(); // name → { bpm, meter, swing }
    this._patterns    = new Map(); // name → { pattern, clock, enabled }
    this._synths      = new Map(); // name → synthDef (built-in or from handler)
    this._instruments = new Map(); // name → { synthName, polyphony, steal, allocator }
    this._buses       = new Map(); // name → { input: AudioNode, output: AudioNode }
    this._effects     = new Map(); // name → { node, wet, type } | custom handler result
    this._scores      = new Map(); // name → { sections: [{start,end,patternName}] }
    this._plugins     = new Map(); // name → loaded WAM2/WASM module

    // Scheduler state
    this._cycleStart  = 0;
    this._scheduled   = new Set();
    this._prevCycle   = 0;
    this._tickTimer   = null;
    this._activePattern = null;

    // AudioWorklet state
    this._workletReady = false;
    this._sampleCache  = new Map(); // name → AudioBuffer (or pending Promise)
    // Sample map: { _base, name → [relPath, ...] } — loaded from @samples :map url
    this._sampleMap    = new Map(); // name → [url, ...] (absolute URLs, ready to fetch)
    this._sampleMapLoading = new Set(); // map URLs in flight

    // FFT data for GPU texture upload
    this._fftData    = null;
    this._waveData   = null;

    // Callbacks (cross-transducer bridges)
    this.onFftData   = null; // (Uint8Array fft, Uint8Array wave)
    this.onBeat      = null; // (val, audioTime) — rhythmic event for behaviour

    // ── Extension hooks (interface table pattern) ──────────────────────
    // SynthType: { compile(node)→def, create(ctx, def, params)→{node:AudioNode, stop(t)} }
    this._synthHandlers  = new Map();
    // EffectType: { compile(node)→def, create(ctx, def)→{input:AudioNode, output:AudioNode} }
    this._effectHandlers = new Map();
    // PatternFn: (node, patternEnv)→Pattern
    this._patternFns     = new Map();
    // ClockFn: (node)→{ cps:()→number, phase:()→Frac }
    this._clockHandlers  = new Map();

    this._warnedTypes = new Set();
  }

  // ── Extension registration ────────────────────────────────────────────

  registerSynthType(name, handler) {
    // handler: { compile(node)→def, create(ctx, def, params)→{node, stop(t)} }
    this._synthHandlers.set(name, handler);
  }

  registerEffectType(name, handler) {
    // handler: { compile(node)→def, create(ctx, def)→{input, output} }
    this._effectHandlers.set(name, handler);
  }

  registerPatternFn(name, fn) {
    // fn: (node, patternEnv: Map<name→Pattern>)→Pattern
    this._patternFns.set(name, fn);
  }

  registerClock(name, handler) {
    // handler: (node)→{ cps:()→number, phase:()→Frac }
    this._clockHandlers.set(name, handler);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async init() {
    if (this._ctx) return true;
    try {
      this._ctx = new AudioContext({ latencyHint: 'interactive' });
      await this._ctx.resume();

      this._master = this._ctx.createGain();
      this._master.gain.value = 0.85;
      this._master.connect(this._ctx.destination);

      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this._analyser.smoothingTimeConstant = 0.8;
      this._master.connect(this._analyser);
      this._fftData  = new Uint8Array(this._analyser.frequencyBinCount);
      this._waveData = new Uint8Array(this._analyser.fftSize);

      try {
        const url = new URL('./synth-processor.js', document.baseURI).href;
        await this._ctx.audioWorklet.addModule(url);
        this._workletReady = true;
        this.log('audio: worklet loaded', 'ok');
      } catch(e) {
        this.log(`audio: worklet load failed (${e.message}) — using OscillatorNode fallback`, 'warn');
      }

      this._cycleStart = this._ctx.currentTime;
      this.log(`audio: AudioContext ready @ ${this._ctx.sampleRate}Hz`, 'ok');
      return true;
    } catch(e) {
      this.log(`audio: init failed: ${e.message}`, 'err');
      return false;
    }
  }

  async resume() {
    if (!this._ctx) return this.init();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    return true;
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    // Release all instrument voice allocators
    for (const [, inst] of this._instruments) inst.allocator.releaseAll();
  }

  // ── Transduce (unified protocol matching other transducers) ────────────

  transduce(tree, structureChanged) {
    if (structureChanged || !this._compiled) {
      this.compile(tree);
    }
    this.execute();
  }

  // ── Compile ──────────────────────────────────────────────────────────

  compile(tree) {
    // Stop scheduler during recompile so stale patterns don't fire
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    this._scheduled.clear();

    this._clocks.clear();
    this._patterns.clear();
    this._synths.clear();
    this._instruments.clear();
    this._buses.clear();
    this._effects.clear();
    this._scores.clear();
    this._warnedTypes.clear();
    // Note: _plugins are not cleared on recompile — they are loaded async and persist

    // 1. @clock — time sources
    for (const n of Rex.findAll(tree, 'clock')) this._compileClock(n);
    if (!this._clocks.has('main')) this._clocks.set('main', { bpm: 120, meter: 4, swing: 0 });

    // 2. @synth — voice definitions
    for (const n of Rex.findAll(tree, 'synth')) this._compileSynth(n);

    // 3. @instrument — voice allocators wrapping synths
    for (const n of Rex.findAll(tree, 'instrument')) this._compileInstrument(n);

    // 4. @bus — routing matrix
    if (this._ctx) for (const n of Rex.findAll(tree, 'bus')) this._compileBus(n);

    // 5. @effect — DSP inserts/sends
    if (this._ctx) for (const n of Rex.findAll(tree, 'effect')) this._compileEffect(n);

    // 6. @plugin — WAM2/WASM external DSP
    for (const n of Rex.findAll(tree, 'plugin')) this._compilePlugin(n);

    // 7a. @samples — load a sample map (JSON with _base + name→[paths])
    for (const n of Rex.findAll(tree, 'samples')) this._compileSampleMap(n);
    // 7b. @sample — preload individual AudioBuffers by URL
    if (this._ctx) for (const n of Rex.findAll(tree, 'sample')) this._compileSample(n);

    // 8. @pattern — event streams
    for (const n of Rex.findAll(tree, 'pattern')) this._compilePattern(n);

    // 9. @score — arrangement (sections referencing patterns)
    for (const n of Rex.findAll(tree, 'score')) this._compileScore(n);

    // 10. @audio root — global overrides
    const audioRoot = Rex.find(tree, 'audio');
    if (audioRoot) this._compileAudioRoot(audioRoot);

    this._rebuildActivePattern();
    this._compiled = true;
  }

  // ── Node compilers ────────────────────────────────────────────────────

  _compileClock(node) {
    const name   = node.attrs.name || node.children[0]?.name || 'main';
    const type   = node.attrs.type || 'internal';

    // Custom clock handler
    const handler = this._clockHandlers.get(type);
    if (handler) {
      this._clocks.set(name, handler(node));
      return;
    }

    const bpm   = parseFloat(node.attrs.bpm  || node.attrs.tempo || 120);
    const meter = parseInt(node.attrs.meter || 4);
    const swing = parseFloat(node.attrs.swing || 0); // 0..0.5 delay on off-beats
    this._clocks.set(name, { bpm, meter, swing, cps: null }); // cps computed lazily
  }

  _compileSynth(node) {
    const name = node.attrs.name || node.children[0]?.name || `synth_${this._synths.size}`;
    const type = node.attrs.type || 'worklet';

    // Custom synth type handler
    const handler = this._synthHandlers.get(type);
    if (handler) {
      this._synths.set(name, { _custom: true, _handler: handler, _def: handler.compile(node), type });
      return;
    }

    // Built-in synth types
    const wave = node.attrs.wave || node.attrs.waveform || 'saw';
    const waveMap = { saw: 0, square: 1, sq: 1, tri: 2, triangle: 2, sine: 3, sin: 3 };
    this._synths.set(name, {
      type,
      waveform: waveMap[wave] ?? 0,
      attack:   parseFloat(node.attrs.attack  || 0.01),
      decay:    parseFloat(node.attrs.decay   || 0.1),
      sustain:  parseFloat(node.attrs.sustain || 0.6),
      release:  parseFloat(node.attrs.release || 0.3),
      cutoff:   parseFloat(node.attrs.cutoff  || node.attrs.filter || 4000),
      resonance:parseFloat(node.attrs.resonance || node.attrs.res || 0.3),
      gain:     parseFloat(node.attrs.gain    || 0.3),
      // Scale context for degree-based patterns
      scale:    node.attrs.scale  || null,
      root:     node.attrs.root   || 'c4',
    });
  }

  _compileInstrument(node) {
    const name      = node.attrs.name || node.children[0]?.name || `inst_${this._instruments.size}`;
    const synthName = node.attrs.synth || node.attrs.type || name;
    const polyphony = parseInt(node.attrs.polyphony || node.attrs.voices || 8);
    const steal     = node.attrs.steal || 'oldest'; // oldest | quietest | none

    // Reuse existing allocator if polyphony matches (avoid re-creating on hot-reload)
    const existing = this._instruments.get(name);
    const allocator = (existing && existing.polyphony === polyphony)
      ? existing.allocator
      : new VoiceAllocator(polyphony);

    this._instruments.set(name, { synthName, polyphony, steal, allocator });
  }

  _compileBus(node) {
    if (!this._ctx) return;
    const name   = node.attrs.name || node.children[0]?.name || `bus_${this._buses.size}`;
    const gain   = parseFloat(node.attrs.gain || 1.0);

    const inputGain  = this._ctx.createGain();
    const outputGain = this._ctx.createGain();
    inputGain.gain.value  = gain;
    outputGain.gain.value = 1.0;
    inputGain.connect(outputGain);

    // Sends: :send [effect1 effect2]
    const sends = (node.attrs.send || '').split(/\s+/).filter(Boolean);
    outputGain.connect(this._master); // always connect to master
    this._buses.set(name, { input: inputGain, output: outputGain, sends, _pendingSends: sends });
  }

  _compileEffect(node) {
    if (!this._ctx) return;
    const name = node.attrs.name || node.children[0]?.name || `fx_${this._effects.size}`;
    const type = node.attrs.type || node.children[0]?.name || 'reverb';

    // Custom effect handler
    const handler = this._effectHandlers.get(type);
    if (handler) {
      const def    = handler.compile(node);
      const result = handler.create(this._ctx, def);
      result.output.connect(this._master);
      this._effects.set(name, { ...result, type, _custom: true });
      return;
    }

    // Built-in effects
    switch (type) {
      case 'reverb': {
        const conv = this._ctx.createConvolver();
        conv.buffer = this._makeReverbIR(
          parseFloat(node.attrs.room || node.attrs.size || 0.6),
          parseFloat(node.attrs.decay || 2.0)
        );
        const wet = this._ctx.createGain();
        wet.gain.value = parseFloat(node.attrs.wet || 0.3);
        conv.connect(wet);
        wet.connect(this._master);
        this._effects.set(name, { node: conv, wet, input: conv, output: wet, type: 'reverb' });
        break;
      }
      case 'delay': {
        const dt  = parseFloat(node.attrs.time || node.attrs.delay || 0.375);
        const fb  = parseFloat(node.attrs.feedback || 0.4);
        const del = this._ctx.createDelay(5.0);
        del.delayTime.value = dt;
        const fbGain = this._ctx.createGain();
        fbGain.gain.value = Math.min(fb, 0.95);
        del.connect(fbGain);
        fbGain.connect(del);
        const wet = this._ctx.createGain();
        wet.gain.value = parseFloat(node.attrs.wet || 0.25);
        del.connect(wet);
        wet.connect(this._master);
        this._effects.set(name, { node: del, wet, fbGain, input: del, output: wet, type: 'delay' });
        break;
      }
      case 'filter': {
        const bq   = this._ctx.createBiquadFilter();
        bq.type    = node.attrs.mode || 'lowpass';
        bq.frequency.value = parseFloat(node.attrs.cutoff || 2000);
        bq.Q.value         = parseFloat(node.attrs.q || node.attrs.resonance || 1.0);
        bq.connect(this._master);
        this._effects.set(name, { node: bq, input: bq, output: bq, type: 'filter' });
        break;
      }
      case 'compressor': {
        const comp = this._ctx.createDynamicsCompressor();
        comp.threshold.value = parseFloat(node.attrs.threshold || -24);
        comp.knee.value      = parseFloat(node.attrs.knee      || 10);
        comp.ratio.value     = parseFloat(node.attrs.ratio     || 4);
        comp.attack.value    = parseFloat(node.attrs.attack    || 0.003);
        comp.release.value   = parseFloat(node.attrs.release   || 0.25);
        comp.connect(this._master);
        this._effects.set(name, { node: comp, input: comp, output: comp, type: 'compressor' });
        break;
      }
      case 'distortion': {
        const ws   = this._ctx.createWaveShaper();
        const amt  = parseFloat(node.attrs.amount || node.attrs.drive || 50);
        ws.curve   = this._makeDistortionCurve(amt);
        ws.oversample = '4x';
        const wet  = this._ctx.createGain();
        wet.gain.value = parseFloat(node.attrs.wet || 0.8);
        ws.connect(wet);
        wet.connect(this._master);
        this._effects.set(name, { node: ws, wet, input: ws, output: wet, type: 'distortion' });
        break;
      }
      default: {
        if (!this._warnedTypes.has(`effect:${type}`)) {
          this.log(`audio: unknown @effect type "${type}"`, 'warn');
          this._warnedTypes.add(`effect:${type}`);
        }
      }
    }
  }

  // WAM2/WASM plugin: dynamic ES module import
  _compilePlugin(node) {
    const name = node.attrs.name || node.children[0]?.name || `plugin_${this._plugins.size}`;
    const url  = node.attrs.url  || node.attrs.src || null;
    const type = node.attrs.type || 'wam2'; // wam2 | wasm | faust

    if (!url) {
      if (!this._warnedTypes.has(`plugin:${name}:no-url`)) {
        this.log(`audio: @plugin "${name}" has no :url`, 'warn');
        this._warnedTypes.add(`plugin:${name}:no-url`);
      }
      return;
    }

    // Only load once (plugins persist across recompiles)
    if (this._plugins.has(name)) return;

    // Async load — plugin becomes available after promise resolves
    this._plugins.set(name, { url, type, state: 'loading', instance: null });
    this._loadPlugin(name, url, type).catch(e => {
      this.log(`audio: @plugin "${name}" load failed: ${e.message}`, 'err');
      this._plugins.set(name, { url, type, state: 'failed', instance: null });
    });
  }

  async _loadPlugin(name, url, type) {
    if (!this._ctx) return;
    if (type === 'wam2') {
      // WAM2: ES module exports a WAM class with createInstance
      const mod = await import(/* webpackIgnore: true */ url);
      const WAM = mod.default || mod;
      const hostGroupId = `rex-audio-${Date.now()}`;
      const [instance] = await WAM.createInstance(hostGroupId, this._ctx);
      instance.audioNode.connect(this._master);
      this._plugins.set(name, { url, type, state: 'ready', instance });
      this.log(`audio: @plugin "${name}" (WAM2) loaded`, 'ok');
    } else if (type === 'wasm') {
      // Raw WASM: load and wrap as AudioWorkletNode (user provides a processor name)
      const resp = await fetch(url);
      const buf  = await resp.arrayBuffer();
      const mod  = await WebAssembly.compile(buf);
      this._plugins.set(name, { url, type, state: 'ready', instance: mod });
      this.log(`audio: @plugin "${name}" (WASM) compiled`, 'ok');
    }
    // Faust: would use libfaust.wasm — omitted pending user request
  }

  // Load a sample map JSON — { "_base": "...", "name": ["rel/path.wav", ...] }
  // @samples :map "https://..." or :map dirt (shorthand for Dirt-Samples)
  _compileSampleMap(node) {
    const DIRT_MAP = 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json';
    let mapUrl = node.attrs.map || node.attrs.url || node.attrs.src || node.children[0]?.name || '';
    if (mapUrl === 'dirt' || mapUrl === 'tidalcycles' || mapUrl === '') mapUrl = DIRT_MAP;

    if (this._sampleMapLoading.has(mapUrl)) return; // already in flight
    this._sampleMapLoading.add(mapUrl);
    this._loadSampleMap(mapUrl).catch(e => {
      this.log(`audio: @samples map load failed (${e.message}): ${mapUrl}`, 'err');
      this._sampleMapLoading.delete(mapUrl);
    });
  }

  async _loadSampleMap(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const base = json._base || '';
    let count = 0;
    for (const [name, paths] of Object.entries(json)) {
      if (name.startsWith('_')) continue; // skip _base, _version etc.
      if (this._sampleMap.has(name)) continue; // don't overwrite already-loaded maps
      const urls = Array.isArray(paths)
        ? paths.map(p => base + p)
        : [base + paths];
      this._sampleMap.set(name, urls);
      count++;
    }
    this._sampleMapLoading.delete(url);
    this.log(`audio: sample map loaded — ${count} banks from ${url.split('/').slice(-1)[0]}`, 'ok');
  }

  // Preload sample buffers declared via @sample
  _compileSample(node) {
    const name = node.attrs.name || node.children[0]?.name;
    const src  = node.attrs.src  || node.attrs.url || node.attrs.path;
    if (name && src && !this._sampleCache.has(name)) {
      this._loadSampleUrl(name, src);
    }
  }

  _compilePattern(node) {
    const name      = node.attrs.name || node.children[0]?.name || `pat_${this._patterns.size}`;
    const clockName = node.attrs.clock || 'main';
    const clock     = this._clocks.get(clockName) || { bpm: 120, meter: 4, swing: 0 };
    const type      = node.attrs.type || 'sequence';

    // Custom pattern function
    const customFn = this._patternFns.get(type);
    if (customFn) {
      const patEnv = new Map([...this._patterns.entries()].map(([k,v]) => [k, v.pattern]));
      const pattern = customFn(node, patEnv);
      const patParams = this._extractPatParams(node);
      const merged = pattern.fmap(v => ({ ...patParams, ...(typeof v === 'object' ? v : { s: v }) }));
      this._patterns.set(name, { pattern: merged, clock, enabled: node.attrs.mute !== 'true' });
      return;
    }

    // Markov pattern type
    if (type === 'markov') {
      this._compileMarkovPattern(node, name, clock);
      return;
    }

    // Standard sequence/euclid pattern
    const seqAttr = node.attrs.seq || node.attrs.sound || node.attrs.note || '';
    const seqNode = Rex.find(node, 'seq') || Rex.find(node, 'sound') || Rex.find(node, 'note');
    const seqStr  = seqAttr || (seqNode ? (seqNode.attrs.value || seqNode.children[0]?.name || '') : '');

    let pattern;
    if (node.attrs.euclid) {
      const parts = node.attrs.euclid.split(',').map(s => parseInt(s.trim()));
      const k = parts[0] || 3, n = parts[1] || 8, r = parts[2] || 0;
      const soundPat = seqStr ? parseMini(seqStr) : pure({ s: name });
      pattern = struct(euclidPat(k, n, r), soundPat);
    } else if (node.attrs.pulses && node.attrs.steps) {
      const k = parseInt(node.attrs.pulses), n = parseInt(node.attrs.steps);
      const r = parseInt(node.attrs.rotation || 0);
      const soundPat = seqStr ? parseMini(seqStr) : pure({ s: name });
      pattern = struct(euclidPat(k, n, r), soundPat);
    } else if (seqStr) {
      pattern = parseMini(seqStr);
    } else if (node.children.length > 0) {
      const parts = node.children.filter(c => c.name).map(c => {
        const f = noteToFreq(c.name);
        const isNote = /^[a-gA-G][#b]?\d+$/.test(c.name);
        return pure(isNote ? { s: c.name, freq: f, note: c.name } : { s: c.name });
      });
      pattern = parts.length ? fastcat(parts) : silence();
    } else {
      pattern = silence();
    }

    const patParams = this._extractPatParams(node);
    if (node.attrs.fast) pattern = pattern.fast(parseFloat(node.attrs.fast));
    if (node.attrs.slow) pattern = pattern.slow(parseFloat(node.attrs.slow));

    const merged = pattern.fmap(v => ({ ...patParams, ...(typeof v === 'object' ? v : { s: v }) }));
    this._patterns.set(name, {
      pattern: merged,
      clock,
      enabled: node.attrs.mute !== 'true' && node.attrs.enabled !== 'false',
    });
  }

  _compileMarkovPattern(node, name, clock) {
    // :states "a b c" :from-a "b:0.7 c:0.3" :from-b "a:0.5 c:0.5" etc.
    const statesStr = node.attrs.states || '';
    const states    = statesStr.split(/\s+/).filter(Boolean);
    const initial   = node.attrs.initial || states[0] || 'a';

    const matrix = new Map();
    for (const s of states) {
      const rowStr = node.attrs[`from-${s}`] || '';
      const row = rowStr.split(/\s+/).filter(Boolean).map(entry => {
        const [to, wStr] = entry.split(':');
        return { to: to || s, weight: parseFloat(wStr || '1') };
      });
      if (row.length) matrix.set(s, row);
    }

    // Map state names to sound events
    const soundMap = new Map();
    for (const s of states) {
      const snd = node.attrs[`sound-${s}`] || node.attrs[`note-${s}`] || s;
      soundMap.set(s, snd);
    }

    const basePat = markovPat(initial, matrix);
    const mapped  = basePat.fmap(state => {
      const snd = soundMap.get(state) || state;
      const freq = noteToFreq(snd);
      const isNote = /^[a-gA-G][#b]?\d+$/.test(snd);
      return isNote ? { s: snd, freq, note: snd } : { s: snd };
    });

    const patParams = this._extractPatParams(node);
    const merged = mapped.fmap(v => ({ ...patParams, ...v }));
    this._patterns.set(name, { pattern: merged, clock, enabled: node.attrs.mute !== 'true' });
  }

  _compileScore(node) {
    const name = node.attrs.name || node.children[0]?.name || `score_${this._scores.size}`;
    // Children are @section nodes: :start 0 :end 4 :pattern name
    const sections = node.children
      .filter(c => c.name === 'section')
      .map(c => ({
        start:   parseFloat(c.attrs.start || 0),
        end:     parseFloat(c.attrs.end   || 4),
        pattern: c.attrs.pattern || c.children[0]?.name || null,
      }));
    this._scores.set(name, { sections, active: node.attrs.play === 'true' });
  }

  _compileAudioRoot(node) {
    if (node.attrs.bpm) {
      const bpm = parseFloat(node.attrs.bpm);
      for (const [, c] of this._clocks) if (typeof c.bpm !== 'undefined') c.bpm = bpm;
    }
    if (node.attrs.gain && this._master) {
      this._master.gain.value = parseFloat(node.attrs.gain);
    }
  }

  _extractPatParams(node) {
    return {
      gain:       parseFloat(node.attrs.gain       || 1.0),
      speed:      parseFloat(node.attrs.speed      || 1.0),
      pan:        parseFloat(node.attrs.pan        || 0.5),
      synth:      node.attrs.synth       || null,
      instrument: node.attrs.instrument  || null,
      effect:     node.attrs.effect      || null,
      bus:        node.attrs.bus         || null,
    };
  }

  _rebuildActivePattern() {
    const enabled = [...this._patterns.values()].filter(p => p.enabled).map(p => p.pattern);
    this._activePattern = enabled.length ? stack(enabled) : null;
  }

  // ── Execute ───────────────────────────────────────────────────────────

  execute() {
    if (!this._ctx || !this._compiled) return;

    if (!this._tickTimer) this._startScheduler();

    if (this._analyser && this._fftData && this.onFftData) {
      this._analyser.getByteFrequencyData(this._fftData);
      this._analyser.getByteTimeDomainData(this._waveData);
      this.onFftData(this._fftData, this._waveData);
    }
  }

  // ── Scheduler ────────────────────────────────────────────────────────

  _startScheduler() {
    const LOOKAHEAD = 0.1;
    const TICK_MS   = 25;

    const tick = () => {
      if (!this._ctx || !this._activePattern) return;
      const now   = this._ctx.currentTime;
      const clock = [...this._clocks.values()][0] || { bpm: 120, swing: 0 };
      const cps   = clock.bpm / 60.0;

      const nowCycle = (now - this._cycleStart) * cps;
      const endCycle = nowCycle + LOOKAHEAD * cps;

      const boundary = Math.floor(nowCycle);
      if (boundary > this._prevCycle) {
        this._scheduled.clear();
        this._prevCycle = boundary;
      }

      const arc = new Arc(new Frac(nowCycle), new Frac(endCycle));
      let events;
      try { events = this._activePattern.query(arc); }
      catch(e) { return; }

      for (const ev of events) {
        const key = ev.key();
        if (this._scheduled.has(key)) continue;
        this._scheduled.add(key);

        const onsetCycle = ev.whole ? ev.whole.begin.valueOf() : ev.part.begin.valueOf();
        let audioTime    = this._cycleStart + onsetCycle / cps;

        // Swing: delay off-beat subdivisions
        if (clock.swing && clock.swing > 0) {
          const beatPhase = (onsetCycle * 2) % 1;
          if (beatPhase > 0.4) audioTime += clock.swing / cps;
        }

        if (audioTime >= now && audioTime < now + LOOKAHEAD) {
          const durCycle = ev.whole
            ? (ev.whole.end.valueOf() - ev.whole.begin.valueOf())
            : (ev.part.end.valueOf()  - ev.part.begin.valueOf());
          const durSec = durCycle / cps;
          this._scheduleEvent(ev.value, audioTime, durSec);
        }
      }
    };

    this._tickTimer = setInterval(tick, TICK_MS);
  }

  _scheduleEvent(val, atTime, durSec) {
    if (!val || !this._ctx) return;

    const freq = val.freq || (val.note ? noteToFreq(val.note) : (val.s ? noteToFreq(val.s) : 0));
    const gain = val.gain !== undefined ? val.gain : 0.3;
    const pan  = val.pan  !== undefined ? val.pan  : 0.5;

    // Resolve synth/instrument
    const instName  = val.instrument;
    const inst      = instName ? this._instruments.get(instName) : null;
    const synthName = inst ? inst.synthName : val.synth;
    const synthDef  = synthName ? this._synths.get(synthName) : null;

    const A = parseFloat(synthDef?.attack  ?? val.attack  ?? 0.01);
    const D = parseFloat(synthDef?.decay   ?? val.decay   ?? 0.1);
    const S = parseFloat(synthDef?.sustain ?? val.sustain ?? 0.6);
    const R = parseFloat(synthDef?.release ?? val.release ?? 0.3);

    // Resolve output node: bus → effect → master
    const busName = val.bus || synthDef?.bus;
    const bus     = busName ? this._buses.get(busName) : null;
    const fxName  = val.effect || synthDef?.effect;
    const fx      = fxName ? this._effects.get(fxName) : null;
    const output  = bus ? bus.input : (fx ? (fx.input || fx.node) : this._master);

    // Custom synth handler
    if (synthDef?._custom) {
      const result = synthDef._handler.create(this._ctx, synthDef._def, {
        freq, gain, pan, A, D, S, R, atTime, durSec, output,
      });
      if (result?.node) {
        setTimeout(() => { try { result.node.disconnect(); } catch(e) {} },
          (atTime + durSec + R + 0.1 - this._ctx.currentTime) * 1000 + 50);
      }
      if (this.onBeat) this.onBeat(val, atTime);
      return;
    }

    if (freq > 0 && this._workletReady) {
      this._scheduleWorkletNote(freq, atTime, durSec, { A, D, S, R, gain, pan, synthDef, output });
    } else if (freq > 0) {
      this._scheduleOscNote(freq, atTime, durSec, { A, D, S, R, gain, pan, output });
    } else if (val.s && !(/^[a-gA-G][#b]?\d+$/.test(val.s))) {
      this._scheduleSample(val.s, atTime, durSec, { gain, pan, speed: val.speed || 1, output });
    }

    if (this.onBeat) this.onBeat(val, atTime);
  }

  _scheduleWorkletNote(freq, atTime, durSec, { A, D, S, R, gain, pan, synthDef, output }) {
    const ctx  = this._ctx;
    const node = new AudioWorkletNode(ctx, 'rex-synth', { numberOfOutputs: 1, outputChannelCount: [2] });

    const ampEnv = ctx.createGain();
    ampEnv.gain.setValueAtTime(0, atTime);
    ampEnv.gain.linearRampToValueAtTime(gain, atTime + A);
    ampEnv.gain.exponentialRampToValueAtTime(Math.max(gain * S, 0.0001), atTime + A + D);
    const noteEnd = atTime + Math.max(durSec, A + D);
    ampEnv.gain.setValueAtTime(Math.max(gain * S, 0.0001), noteEnd);
    ampEnv.gain.setTargetAtTime(0.0001, noteEnd, R / 3);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan * 2 - 1, atTime);

    node.parameters.get('frequency').setValueAtTime(freq, atTime);
    node.parameters.get('gain').setValueAtTime(1.0, atTime);
    if (synthDef) {
      node.parameters.get('cutoff').setValueAtTime(synthDef.cutoff, atTime);
      node.parameters.get('resonance').setValueAtTime(synthDef.resonance, atTime);
      node.parameters.get('waveform').setValueAtTime(synthDef.waveform, atTime);
    }

    node.connect(ampEnv);
    ampEnv.connect(panner);
    panner.connect(output);

    const stopAt = noteEnd + R + 0.05;
    setTimeout(() => {
      try { node.disconnect(); ampEnv.disconnect(); panner.disconnect(); } catch(e) {}
    }, (stopAt - ctx.currentTime) * 1000 + 50);
  }

  _scheduleOscNote(freq, atTime, durSec, { A, D, S, R, gain, pan, output }) {
    const ctx    = this._ctx;
    const osc    = ctx.createOscillator();
    const ampEnv = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, atTime);

    ampEnv.gain.setValueAtTime(0, atTime);
    ampEnv.gain.linearRampToValueAtTime(gain, atTime + A);
    ampEnv.gain.exponentialRampToValueAtTime(Math.max(gain * S, 0.0001), atTime + A + D);
    const noteEnd = atTime + Math.max(durSec, A + D);
    ampEnv.gain.setValueAtTime(Math.max(gain * S, 0.0001), noteEnd);
    ampEnv.gain.setTargetAtTime(0.0001, noteEnd, R / 3);

    panner.pan.setValueAtTime(pan * 2 - 1, atTime);

    osc.connect(ampEnv);
    ampEnv.connect(panner);
    panner.connect(output);

    osc.start(atTime);
    osc.stop(noteEnd + R + 0.1);
    osc.addEventListener('ended', () => {
      try { osc.disconnect(); ampEnv.disconnect(); panner.disconnect(); } catch(e) {}
    });
  }

  async _scheduleSample(name, atTime, durSec, { gain, pan, speed, output }) {
    if (!this._ctx) return;
    const buf = await this._loadSample(name);
    if (!buf) return;
    const ctx    = this._ctx;
    const src    = ctx.createBufferSource();
    const ampEnv = ctx.createGain();
    const panner = ctx.createStereoPanner();

    src.buffer = buf;
    src.playbackRate.value = speed || 1;
    ampEnv.gain.setValueAtTime(gain, atTime);
    ampEnv.gain.setTargetAtTime(0.0001, atTime + durSec, 0.05);
    panner.pan.setValueAtTime(pan * 2 - 1, atTime);

    src.connect(ampEnv);
    ampEnv.connect(panner);
    panner.connect(output);

    src.start(atTime);
    src.stop(atTime + durSec + 0.1);
    src.addEventListener('ended', () => {
      try { src.disconnect(); ampEnv.disconnect(); panner.disconnect(); } catch(e) {}
    });
  }

  async _loadSample(name) {
    if (this._sampleCache.has(name)) return this._sampleCache.get(name);

    // Support "name:index" syntax — bd:2 = third sample in bd bank
    let bankName = name, bankIndex = 0;
    const colonIdx = name.lastIndexOf(':');
    if (colonIdx !== -1) {
      bankName  = name.slice(0, colonIdx);
      bankIndex = parseInt(name.slice(colonIdx + 1)) || 0;
    }

    // Check sample map (Dirt-Samples or custom map)
    const mapUrls = this._sampleMap.get(bankName);
    if (mapUrls && mapUrls.length) {
      const idx = ((bankIndex % mapUrls.length) + mapUrls.length) % mapUrls.length;
      const url = mapUrls[idx];
      try {
        const r = await fetch(url);
        if (r.ok) {
          const ab  = await r.arrayBuffer();
          const buf = await this._ctx.decodeAudioData(ab);
          this._sampleCache.set(name, buf);
          return buf;
        }
      } catch(e) { /* fall through to local paths */ }
    }

    // Fallback: local server paths
    const paths = [`/samples/${name}.wav`, `/samples/${name}.mp3`, `/audio/${name}.wav`, `/audio/${name}.mp3`];
    for (const p of paths) {
      try {
        const r = await fetch(p);
        if (!r.ok) continue;
        const ab  = await r.arrayBuffer();
        const buf = await this._ctx.decodeAudioData(ab);
        this._sampleCache.set(name, buf);
        return buf;
      } catch(e) { /* try next */ }
    }
    return null;
  }

  async _loadSampleUrl(name, url) {
    if (this._sampleCache.has(name)) return;
    if (!this._ctx) return;
    try {
      const r   = await fetch(url);
      if (!r.ok) return;
      const ab  = await r.arrayBuffer();
      const buf = await this._ctx.decodeAudioData(ab);
      this._sampleCache.set(name, buf);
      this.log(`audio: sample "${name}" loaded`, 'ok');
    } catch(e) {
      this.log(`audio: sample "${name}" load failed: ${e.message}`, 'warn');
    }
  }

  // ── Parameter updates from behaviour channels ─────────────────────────

  setParam(patternName, paramName, value) {
    if (!this._ctx) return;

    // Global params
    if (patternName === '_audio' || patternName === 'audio') {
      if (paramName === 'bpm' || paramName === 'tempo') this.setBpm(value);
      if (paramName === 'gain' && this._master) this._master.gain.value = value;
      return;
    }

    // Clock params
    const clk = this._clocks.get(patternName);
    if (clk) {
      if (paramName === 'bpm' || paramName === 'tempo') clk.bpm = value;
      if (paramName === 'swing') clk.swing = value;
      return;
    }

    // Pattern params
    const pat = this._patterns.get(patternName);
    if (pat) {
      if (paramName === 'bpm' || paramName === 'tempo') pat.clock.bpm = value;
      else if (paramName === 'mute') { pat.enabled = !value; this._rebuildActivePattern(); }
      else if (paramName === 'gain') pat.pattern = pat.pattern.fmap(v => ({ ...v, gain: value }));
      else if (paramName === 'pan')  pat.pattern = pat.pattern.fmap(v => ({ ...v, pan: value }));
      return;
    }

    // Effect params
    const fx = this._effects.get(patternName);
    if (fx) {
      if (paramName === 'wet' && fx.wet) fx.wet.gain.setTargetAtTime(value, this._ctx.currentTime, 0.01);
      if (paramName === 'cutoff' && fx.node?.frequency) fx.node.frequency.setTargetAtTime(value, this._ctx.currentTime, 0.01);
      return;
    }
  }

  setBpm(bpm) {
    for (const [, c] of this._clocks) if (typeof c.bpm !== 'undefined') c.bpm = bpm;
  }

  // ── DSP helpers ───────────────────────────────────────────────────────

  _makeReverbIR(roomSize = 0.6, decayTime = 2.0) {
    if (!this._ctx) return null;
    const sr  = this._ctx.sampleRate;
    const len = Math.ceil(sr * Math.max(decayTime, 0.1));
    const ir  = this._ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      const predelay = Math.floor(0.02 * sr);
      const decay    = 3.0 * roomSize + 0.5;
      for (let i = 0; i < len; i++) {
        if (i < predelay) { d[i] = 0; continue; }
        const t = (i - predelay) / sr;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-decay * t);
      }
    }
    return ir;
  }

  _makeDistortionCurve(amount) {
    const n   = 256;
    const curve = new Float32Array(n);
    const k   = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  getInfo() {
    return {
      patterns:    [...this._patterns.keys()],
      clocks:      [...this._clocks.entries()].map(([n, c]) => `${n}@${c.bpm||'?'}bpm`),
      synths:      [...this._synths.keys()],
      instruments: [...this._instruments.keys()],
      buses:       [...this._buses.keys()],
      effects:     [...this._effects.keys()],
      scores:      [...this._scores.keys()],
      plugins:     [...this._plugins.entries()].map(([n, p]) => `${n}:${p.state}`),
      sampleBanks: this._sampleMap.size,
      sampleBankNames: [...this._sampleMap.keys()].slice(0, 20),
      cachedBuffers: this._sampleCache.size,
      worklet:     this._workletReady,
      ctxState:    this._ctx?.state ?? 'none',
      sampleRate:  this._ctx?.sampleRate ?? 0,
    };
  }

  // Pattern algebra helpers — exposed for use in registerPatternFn implementations
  static get Pattern() { return Pattern; }
  static get Frac()    { return Frac; }
  static get Arc()     { return Arc; }
  static get Event()   { return Event; }
  static silence()     { return silence(); }
  static pure(v)       { return pure(v); }
  static stack(pats)   { return stack(pats); }
  static fastcat(pats) { return fastcat(pats); }
  static slowcat(pats) { return slowcat(pats); }
  static euclidPat(k, n, r) { return euclidPat(k, n, r); }
  static struct(b, s)  { return struct(b, s); }
  static markovPat(i, m) { return markovPat(i, m); }
  static parseMini(s)  { return parseMini(s); }
  static noteToFreq(n) { return noteToFreq(n); }
  static degreeToFreq(d, scale, root) { return degreeToFreq(d, scale, root); }
  static SCALES        = SCALES;
}
