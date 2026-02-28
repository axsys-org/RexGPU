// ═══════════════════════════════════════════════════════════════════════
// SYNTH PROCESSOR — AudioWorkletGlobalScope
// PolyBLEP band-limited oscillator + State Variable Filter (LP/HP/BP)
// Loaded via audioCtx.audioWorklet.addModule()
// ═══════════════════════════════════════════════════════════════════════

class SynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency',  defaultValue: 440,  minValue: 20,    maxValue: 20000, automationRate: 'a-rate' },
      { name: 'detune',     defaultValue: 0,    minValue: -1200, maxValue: 1200,  automationRate: 'k-rate' },
      { name: 'cutoff',     defaultValue: 4000, minValue: 20,    maxValue: 20000, automationRate: 'k-rate' },
      { name: 'resonance',  defaultValue: 0.5,  minValue: 0.001, maxValue: 0.98,  automationRate: 'k-rate' },
      { name: 'filterMode', defaultValue: 0,    minValue: 0,     maxValue: 2,     automationRate: 'k-rate' },
      // filterMode: 0=lowpass, 1=highpass, 2=bandpass
      { name: 'gain',       defaultValue: 0.3,  minValue: 0,     maxValue: 1,     automationRate: 'k-rate' },
      { name: 'waveform',   defaultValue: 0,    minValue: 0,     maxValue: 3,     automationRate: 'k-rate' },
      // waveform: 0=saw, 1=square, 2=triangle, 3=sine
    ];
  }

  constructor() {
    super();
    this._phase = 0;   // [0, 1)
    this._s1 = 0;      // SVF integrator 1
    this._s2 = 0;      // SVF integrator 2
    // Message port for note triggers, param changes
    this.port.onmessage = (e) => {
      if (e.data.type === 'reset') { this._phase = 0; this._s1 = 0; this._s2 = 0; }
    };
  }

  // PolyBLEP correction — smooths discontinuities for saw/square
  _polyblep(t, dt) {
    if (t < dt) {
      t /= dt;
      return t + t - t * t - 1.0;
    } else if (t > 1.0 - dt) {
      t = (t - 1.0) / dt;
      return t * t + t + t + 1.0;
    }
    return 0.0;
  }

  // One sample of the selected waveform
  _osc(dt, waveform) {
    const t = this._phase;
    this._phase += dt;
    if (this._phase >= 1.0) this._phase -= 1.0;

    switch (Math.round(waveform)) {
      case 0: { // Band-limited sawtooth
        let saw = 2.0 * t - 1.0;
        saw -= this._polyblep(t, dt);
        return saw;
      }
      case 1: { // Band-limited square
        let sq = t < 0.5 ? 1.0 : -1.0;
        sq += this._polyblep(t, dt);
        sq -= this._polyblep((t + 0.5) % 1.0, dt);
        return sq;
      }
      case 2: { // Triangle (integrated square, naturally band-limited)
        // Leaky integrator from square approximation
        let sq = t < 0.5 ? 1.0 : -1.0;
        sq += this._polyblep(t, dt);
        sq -= this._polyblep((t + 0.5) % 1.0, dt);
        // Integrate: y[n] = y[n-1] * (1 - dt*2) + sq * dt*2
        // Simpler: just use analytic triangle
        return 1.0 - 4.0 * Math.abs(t - 0.5);
      }
      case 3: // Sine
      default:
        return Math.sin(2.0 * Math.PI * t);
    }
  }

  // Chamberlin State Variable Filter — one sample
  // Returns { lp, hp, bp } simultaneously without recomputing
  _svf(input, g, k) {
    const hp = (input - (k + g) * this._s1 - this._s2) / (1.0 + g * (k + g));
    const bp = g * hp + this._s1;
    const lp = g * bp + this._s2;
    // Update integrators (Runge-Kutta correction avoids resonance blowup)
    this._s1 = 2.0 * bp - this._s1;
    this._s2 = 2.0 * lp - this._s2;
    return { lp, hp, bp };
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    const freqArr  = parameters.frequency;
    const detune   = parameters.detune[0];
    const cutoff   = Math.min(Math.max(parameters.cutoff[0], 20), sampleRate * 0.49);
    const res      = Math.min(Math.max(parameters.resonance[0], 0.001), 0.98);
    const mode     = Math.round(parameters.filterMode[0]);
    const gain     = parameters.gain[0];
    const waveform = parameters.waveform[0];

    // SVF coefficients — k-rate, computed once per block
    const g = Math.tan(Math.PI * cutoff / sampleRate);
    const k = 1.0 / Math.max(res, 0.001) - g; // Zolzer formulation: avoids divide-by-zero

    for (let i = 0; i < out.length; i++) {
      const freq  = freqArr.length > 1 ? freqArr[i] : freqArr[0];
      // Apply detune (cents → frequency multiplier)
      const f     = freq * Math.pow(2.0, detune / 1200.0);
      const dt    = Math.min(f / sampleRate, 0.499); // clamp below Nyquist

      const raw = this._osc(dt, waveform);
      const { lp, hp, bp } = this._svf(raw, g, k);

      out[i] = (mode === 0 ? lp : mode === 1 ? hp : bp) * gain;
    }

    // Stereo: copy mono to right channel if present
    const outR = outputs[0][1];
    if (outR) outR.set(out);

    return true;
  }
}

registerProcessor('rex-synth', SynthProcessor);
