// ═══════════════════════════
// GPU TRANSDUCER
// ═══════════════════════════

import { Rex } from './rex-parser.js';

export class RexGPU {
  constructor(canvas, log) {
    this.canvas = canvas; this.log = log; this.device = null;
    this.pipelines = new Map(); this.shaderModules = new Map();
    this.startTime = performance.now()/1000; this.frameCount = 0;
    this._structs = new Map();
    this._wgslStructs = new Map();
    this._wgslLibs = new Map();
    this._lastGoodShaders = new Map();

    // ── Zero-copy heap with double-buffered staging ──
    this._heapBuffer = null;
    this._stagingBuffers = [null,null];
    this._stagingViews = [null,null];
    this._writeSlot = 0;
    this._heapView = null;
    this._heapSize = 0;
    this._heapLayout = new Map();
    this._bindGroups = new Map();

    // ── Storage buffers (read-write GPU side) ──
    this._storageBuffers = new Map();

    // ── Texture resources ──
    this._textures = new Map();
    this._samplers = new Map();

    // ── Vertex/index buffers ──
    this._vertexBuffers = new Map();
    this._indexBuffers = new Map();

    // ── Compiled optics ──
    this._optics = [];
    this._formOptics = new Map();
    this._builtinOptics = [];

    // ── Frame state ──
    this._dirtyMin = 0;
    this._dirtyMax = 0;
    this._frameDirty = true;
    this.formState = {};

    // ── Input state (WASD, mouse, etc) ──
    this.inputState = {
      keys: new Set(),
      // WASD aggregated into movement vector
      moveX: 0, moveY: 0, moveZ: 0,
      // Mouse
      mouseX: 0, mouseY: 0,
      mouseDX: 0, mouseDY: 0,
      mouseButtons: 0,
      mouseWheel: 0,
      // Pointer lock
      pointerLocked: false,
    };

    // ── Compile-phase analysis ──
    this._barrierSchedule = [];
    this._aliasingPlan = [];
    this._heapInfo = '';
    this._barrierViolations = 0;
    this._opticAccessMap = new Map();  // bufferName/fieldName → [{passIndex, access, stage}]

    // ── Readback enhancements ──
    this._readbackPrevValues = new Map();

    // ── Hot shader patching ──
    this._filterParamClassification = new Map();
    this._pipelineOverrides = new Map();
    this._prevFilterParams = new Map();

    // ── Incremental recompilation ──
    this._prevTree = null;
    this._prevHeapLayout = null;

    // ── GPU feature detection ──
    this._features = new Set();

    // ── Async asset loading ──
    this._loadGeneration = 0;

    // ── Extension hooks ──
    this._compileHandlers = new Map();
    this._commandHandlers = new Map();
    this._resourceHandlers = new Map();
    this._warnedTypes = new Set();

    // ── Readback (GPU → CPU) ──
    this._readbacks = [];           // [{srcBuffer, srcOffset, size, staging, pending, callback}]
    this.onReadback = null;         // callback(name, values) — GPU readback results

    // ── MSAA ──
    this._msaaTextures = new Map();

    // ── Render bundles ──
    this._renderBundles = new Map();

    // ── Queries (timestamp, occlusion) ──
    this._querySets = new Map();

    // ── Video / external textures ──
    this._videoTextures = new Map();
    this._externalTextures = new Map();

    // ── Mipmap generation pipeline (lazy) ──
    this._mipPipeline = null;
    this._mipSampler = null;

    // ── Derive compute (GPU-side @derive evaluation) ──
    this._deriveComputePipeline = null;
    this._deriveStorageBuffer = null;
    this._deriveBindGroup = null;
    this._deriveFieldCount = 0;
    this._deriveFields = [];   // [{name, wgslField}] — maps field index → derive name

    // ── Shader module linking ──
    this._shaderHashCache = new Map();   // hash → GPUShaderModule
    this._wgslLibSymbols = new Map();    // libName → Set<symbolName>
    this._libHashes = new Map();         // libName → hash (invalidation tracking)
    this._nsCounter = 0;                 // namespace counter for this compile cycle
  }

  registerCompileType(typeName, handler) { this._compileHandlers.set(typeName, handler); }
  registerCommandType(typeName, handler) { this._commandHandlers.set(typeName, handler); }
  registerResourceType(typeName, handler) { this._resourceHandlers.set(typeName, handler); }
  registerInputKey(code) { this._inputKeys.add(code); }
  registerKeyBinding(code, axis, value) { this._inputKeys.add(code); this._keyBindings.set(code, {axis, value}); }
  registerFilterType(name, def) { this._filterLibrary.set(name, def); }

  // ════════════════════════════════════════════════════════════════
  // BUILT-IN FILTER LIBRARY — pixel-level FX templates
  // Each entry: { wgsl, params, passes, needsNeighbors }
  //   wgsl: pixel body injected into compute template (has `color`, `uv`, `px`, `dims`, `src`)
  //   params: { name: defaultValue } → injected as WGSL `const PARAM_name`
  //   passes: number of passes (default 1; blur = 2 for separable H+V)
  //   needsNeighbors: if true, src is texture_2d for textureLoad neighbor access
  // ════════════════════════════════════════════════════════════════

  _filterLibrary = new Map([
    ['grayscale', {
      wgsl: `let lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  color = vec4f(vec3f(lum), color.a);`,
      params: {}, passes: 1, needsNeighbors: false,
    }],
    ['sepia', {
      wgsl: `let lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let sep = vec3f(lum * 1.2, lum * 1.0, lum * 0.8);
  color = vec4f(mix(color.rgb, sep, PARAM_intensity), color.a);`,
      params: { intensity: 1.0 }, passes: 1, needsNeighbors: false,
    }],
    ['invert', {
      wgsl: `color = vec4f(1.0 - color.rgb, color.a);`,
      params: {}, passes: 1, needsNeighbors: false,
    }],
    ['brightness', {
      wgsl: `color = vec4f(color.rgb * PARAM_amount, color.a);`,
      params: { amount: 1.2 }, passes: 1, needsNeighbors: false,
    }],
    ['contrast', {
      wgsl: `color = vec4f((color.rgb - 0.5) * PARAM_amount + 0.5, color.a);`,
      params: { amount: 1.5 }, passes: 1, needsNeighbors: false,
    }],
    ['saturate', {
      wgsl: `let sat_lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  color = vec4f(mix(vec3f(sat_lum), color.rgb, PARAM_amount), color.a);`,
      params: { amount: 1.5 }, passes: 1, needsNeighbors: false,
    }],
    ['hue-rotate', {
      wgsl: `let hr_rad = PARAM_angle * 3.14159265 / 180.0;
  let hr_cos = cos(hr_rad); let hr_sin = sin(hr_rad);
  let hr_mat = mat3x3f(
    0.213 + 0.787*hr_cos - 0.213*hr_sin, 0.213 - 0.213*hr_cos + 0.143*hr_sin, 0.213 - 0.213*hr_cos - 0.787*hr_sin,
    0.715 - 0.715*hr_cos - 0.715*hr_sin, 0.715 + 0.285*hr_cos + 0.140*hr_sin, 0.715 - 0.715*hr_cos + 0.715*hr_sin,
    0.072 - 0.072*hr_cos + 0.928*hr_sin, 0.072 - 0.072*hr_cos - 0.283*hr_sin, 0.072 + 0.928*hr_cos + 0.072*hr_sin
  );
  color = vec4f(hr_mat * color.rgb, color.a);`,
      params: { angle: 90.0 }, passes: 1, needsNeighbors: false,
    }],
    ['threshold', {
      wgsl: `let thr_lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let thr_v = select(0.0, 1.0, thr_lum >= PARAM_level);
  color = vec4f(vec3f(thr_v), color.a);`,
      params: { level: 0.5 }, passes: 1, needsNeighbors: false,
    }],
    ['posterize', {
      wgsl: `color = vec4f(floor(color.rgb * PARAM_levels + 0.5) / PARAM_levels, color.a);`,
      params: { levels: 4.0 }, passes: 1, needsNeighbors: false,
    }],
    ['color-matrix', {
      wgsl: `let cm = mat4x4f(
    PARAM_m0, PARAM_m1, PARAM_m2, PARAM_m3,
    PARAM_m4, PARAM_m5, PARAM_m6, PARAM_m7,
    PARAM_m8, PARAM_m9, PARAM_m10, PARAM_m11,
    PARAM_m12, PARAM_m13, PARAM_m14, PARAM_m15
  );
  color = cm * color;`,
      params: { m0:1,m1:0,m2:0,m3:0, m4:0,m5:1,m6:0,m7:0, m8:0,m9:0,m10:1,m11:0, m12:0,m13:0,m14:0,m15:1 },
      passes: 1, needsNeighbors: false,
    }],
    ['blur', {
      // Separable Gaussian: pass 0 = horizontal, pass 1 = vertical
      wgslH: `var blur_acc = vec4f(0.0);
  var blur_wt = 0.0;
  let blur_r = i32(PARAM_radius);
  for (var bx = -blur_r; bx <= blur_r; bx++) {
    let sp = vec2i(i32(px.x) + bx, i32(px.y));
    if (sp.x >= 0 && sp.x < i32(dims.x)) {
      let w = exp(-f32(bx*bx) / (2.0 * PARAM_radius * PARAM_radius / 4.0));
      blur_acc += textureLoad(src, sp, 0) * w;
      blur_wt += w;
    }
  }
  color = blur_acc / blur_wt;`,
      wgslV: `var blur_acc = vec4f(0.0);
  var blur_wt = 0.0;
  let blur_r = i32(PARAM_radius);
  for (var by = -blur_r; by <= blur_r; by++) {
    let sp = vec2i(i32(px.x), i32(px.y) + by);
    if (sp.y >= 0 && sp.y < i32(dims.y)) {
      let w = exp(-f32(by*by) / (2.0 * PARAM_radius * PARAM_radius / 4.0));
      blur_acc += textureLoad(src, sp, 0) * w;
      blur_wt += w;
    }
  }
  color = blur_acc / blur_wt;`,
      params: { radius: 5.0 }, passes: 2, needsNeighbors: true,
    }],
    ['sharpen', {
      wgsl: `let sc = textureLoad(src, vec2i(px), 0);
  let sl = textureLoad(src, vec2i(i32(px.x)-1, i32(px.y)), 0);
  let sr = textureLoad(src, vec2i(i32(px.x)+1, i32(px.y)), 0);
  let su = textureLoad(src, vec2i(i32(px.x), i32(px.y)-1), 0);
  let sd = textureLoad(src, vec2i(i32(px.x), i32(px.y)+1), 0);
  let unsharp = sc * (1.0 + 4.0 * PARAM_amount) - (sl + sr + su + sd) * PARAM_amount;
  color = vec4f(clamp(unsharp.rgb, vec3f(0.0), vec3f(1.0)), sc.a);`,
      params: { amount: 1.0 }, passes: 1, needsNeighbors: true,
    }],
    ['edge-detect', {
      wgsl: `let ec = textureLoad(src, vec2i(px), 0).rgb;
  let el = textureLoad(src, vec2i(i32(px.x)-1, i32(px.y)), 0).rgb;
  let er = textureLoad(src, vec2i(i32(px.x)+1, i32(px.y)), 0).rgb;
  let eu = textureLoad(src, vec2i(i32(px.x), i32(px.y)-1), 0).rgb;
  let ed = textureLoad(src, vec2i(i32(px.x), i32(px.y)+1), 0).rgb;
  let gx = er - el;
  let gy = ed - eu;
  let edge = sqrt(gx * gx + gy * gy);
  color = vec4f(clamp(edge, vec3f(0.0), vec3f(1.0)), 1.0);`,
      params: {}, passes: 1, needsNeighbors: true,
    }],
    ['pixelate', {
      wgsl: `let pxl_sz = max(PARAM_size, 1.0);
  let block = floor(vec2f(px) / pxl_sz) * pxl_sz + pxl_sz * 0.5;
  color = textureSampleLevel(src, filter_samp, block / dims, 0.0);`,
      params: { size: 8.0 }, passes: 1, needsNeighbors: false,
    }],
    ['noise', {
      wgsl: `let nf = fract(sin(dot(vec2f(px) + PARAM_seed, vec2f(12.9898, 78.233))) * 43758.5453);
  color = vec4f(color.rgb + (nf - 0.5) * PARAM_amount, color.a);`,
      params: { amount: 0.1, seed: 0.0 }, passes: 1, needsNeighbors: false,
    }],
    ['vignette', {
      wgsl: `let vig_d = distance(uv, vec2f(0.5));
  let vig_f = smoothstep(PARAM_radius, PARAM_radius - PARAM_softness, vig_d);
  color = vec4f(color.rgb * vig_f, color.a);`,
      params: { radius: 0.75, softness: 0.4 }, passes: 1, needsNeighbors: false,
    }],
    ['bloom', {
      // Single-pass bloom: threshold extract + 2D box blur (5x5) + additive blend with original
      wgsl: `let orig = color;
  var bl_acc = vec4f(0.0); var bl_wt = 0.0;
  let bl_r = 4;
  for (var by = -bl_r; by <= bl_r; by++) {
    for (var bx = -bl_r; bx <= bl_r; bx++) {
      let sp = vec2i(i32(px.x) + bx, i32(px.y) + by);
      if (sp.x >= 0 && sp.x < i32(dims.x) && sp.y >= 0 && sp.y < i32(dims.y)) {
        let s = textureLoad(src, sp, 0);
        let sl = dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722));
        let bright = s * step(PARAM_threshold, sl);
        let w = exp(-f32(bx*bx + by*by) / 8.0);
        bl_acc += bright * w;
        bl_wt += w;
      }
    }
  }
  color = orig + bl_acc / max(bl_wt, 1.0) * PARAM_intensity;`,
      params: { threshold: 0.8, intensity: 0.5 }, passes: 1, needsNeighbors: true,
    }],
    ['chromatic-aberration', {
      wgsl: `let ca_dir = (uv - 0.5) * PARAM_offset / dims;
  let ca_r = textureSampleLevel(src, filter_samp, uv + ca_dir, 0.0).r;
  let ca_g = color.g;
  let ca_b = textureSampleLevel(src, filter_samp, uv - ca_dir, 0.0).b;
  color = vec4f(ca_r, ca_g, ca_b, color.a);`,
      params: { offset: 3.0 }, passes: 1, needsNeighbors: false,
    }],
    ['color-balance', {
      wgsl: `let cb_lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let cb_shadows = clamp(1.0 - cb_lum * 2.0, 0.0, 1.0);
  let cb_highlights = clamp(cb_lum * 2.0 - 1.0, 0.0, 1.0);
  let cb_midtones = 1.0 - cb_shadows - cb_highlights;
  color = vec4f(color.rgb + vec3f(PARAM_sr, PARAM_sg, PARAM_sb) * cb_shadows
    + vec3f(PARAM_mr, PARAM_mg, PARAM_mb) * cb_midtones
    + vec3f(PARAM_hr, PARAM_hg, PARAM_hb) * cb_highlights, color.a);`,
      params: { sr:0,sg:0,sb:0, mr:0,mg:0,mb:0, hr:0,hg:0,hb:0 }, passes: 1, needsNeighbors: false,
    }],
    ['ssao', {
      wgsl: `// Screen-space ambient occlusion (8-tap kernel)
  let ssao_px = vec2i(i32(px.x), i32(px.y));
  let ssao_lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  var ao = 0.0;
  let ssao_r = i32(PARAM_radius);
  let ssao_offsets = array<vec2i, 8>(
    vec2i(-1,-1), vec2i(0,-1), vec2i(1,-1), vec2i(-1,0),
    vec2i(1,0), vec2i(-1,1), vec2i(0,1), vec2i(1,1)
  );
  for (var si = 0; si < 8; si++) {
    let sp = ssao_px + ssao_offsets[si] * ssao_r;
    let sc = textureLoad(src, clamp(sp, vec2i(0), dims - vec2i(1)));
    let sl = dot(sc.rgb, vec3f(0.2126, 0.7152, 0.0722));
    ao += select(0.0, 1.0, sl > ssao_lum + PARAM_bias);
  }
  ao = ao / 8.0;
  let occlusion = 1.0 - ao * PARAM_strength;
  color = vec4f(color.rgb * occlusion, color.a);`,
      params: { radius: 4.0, strength: 0.5, bias: 0.025 }, passes: 1, needsNeighbors: true,
    }],
    ['oit-resolve', {
      wgsl: `// Order-independent transparency resolve (weighted blended)
  // Expects pre-multiplied alpha accumulation in RGB, weight sum in A
  let oit_a = max(color.a, 1e-5);
  let oit_rgb = color.rgb / oit_a;
  let oit_alpha = clamp(1.0 - pow(max(0.0, 1.0 - oit_a / PARAM_weight_scale), PARAM_power), 0.0, 1.0);
  color = vec4f(oit_rgb * oit_alpha, oit_alpha);`,
      params: { weight_scale: 1.0, power: 3.0 }, passes: 1, needsNeighbors: false,
    }],
    ['tone-map', {
      wgsl: `// ACES filmic tone mapping
  let tm_a = 2.51; let tm_b = 0.03; let tm_c = 2.43; let tm_d = 0.59; let tm_e = 0.14;
  let tm_x = color.rgb * PARAM_exposure;
  let tm_mapped = clamp((tm_x * (tm_a * tm_x + tm_b)) / (tm_x * (tm_c * tm_x + tm_d) + tm_e), vec3f(0.0), vec3f(1.0));
  let tm_gamma = pow(tm_mapped, vec3f(1.0 / PARAM_gamma));
  color = vec4f(tm_gamma, color.a);`,
      params: { exposure: 1.0, gamma: 2.2 }, passes: 1, needsNeighbors: false,
    }],
    ['outline', {
      wgsl: `// Edge-based outline
  let ol_px = vec2i(i32(px.x), i32(px.y));
  var ol_edge = 0.0;
  let ol_w = i32(PARAM_width);
  for (var oi = -ol_w; oi <= ol_w; oi++) {
    for (var oj = -ol_w; oj <= ol_w; oj++) {
      if (oi == 0 && oj == 0) { continue; }
      let sp = ol_px + vec2i(oi, oj);
      let sc = textureLoad(src, clamp(sp, vec2i(0), dims - vec2i(1)));
      let diff = length(sc.rgb - color.rgb);
      ol_edge = max(ol_edge, diff);
    }
  }
  let ol_t = smoothstep(PARAM_threshold - 0.1, PARAM_threshold + 0.1, ol_edge);
  let ol_color = vec3f(PARAM_r, PARAM_g, PARAM_b);
  color = vec4f(mix(color.rgb, ol_color, ol_t * PARAM_strength), color.a);`,
      params: { width: 1.0, threshold: 0.1, strength: 1.0, r: 0.0, g: 0.0, b: 0.0 }, passes: 1, needsNeighbors: true,
    }],
  ]);

  async init() {
    if (!navigator.gpu) { this.log('WebGPU not available','err'); return false; }
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) { this.log('No GPU adapter','err'); return false; }

    // Feature probing — request all useful features the adapter supports
    const DESIRED = [
      'timestamp-query','shader-f16','float32-filterable',
      'indirect-first-instance','bgra8unorm-storage',
      'rg11b10ufloat-renderable','depth-clip-control',
      'float32-blendable','dual-source-blending',
      'subgroups','subgroups-f16','clip-distances',
      'depth32float-stencil8','chromium-experimental-subgroups',
    ];
    const available = DESIRED.filter(f => ad.features.has(f));
    this._features = new Set(available);

    this.device = await ad.requestDevice({
      requiredFeatures: available,
      requiredLimits: {
        maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize,
        maxBufferSize: ad.limits.maxBufferSize,
      }
    });
    this.device.addEventListener('uncapturederror', (e) => {
      this.log(`GPU ERROR: ${e.error.message}`, 'err');
    });
    this.context = this.canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device:this.device, format:this.format, alphaMode:'premultiplied' });

    // Capture device limits for compile-time decisions
    const dl = this.device.limits;
    this._limits = {
      maxStorageBufferBindingSize: dl.maxStorageBufferBindingSize,
      maxBufferSize: dl.maxBufferSize,
      maxTextureDimension2D: dl.maxTextureDimension2D,
      maxTextureArrayLayers: dl.maxTextureArrayLayers,
      maxBindGroups: dl.maxBindGroups,
      maxBindingsPerBindGroup: dl.maxBindingsPerBindGroup,
      maxComputeWorkgroupSizeX: dl.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: dl.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: dl.maxComputeWorkgroupSizeZ,
      maxComputeInvocationsPerWorkgroup: dl.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupStorageSize: dl.maxComputeWorkgroupStorageSize,
      maxComputeWorkgroupsPerDimension: dl.maxComputeWorkgroupsPerDimension,
      maxStorageBuffersPerShaderStage: dl.maxStorageBuffersPerShaderStage,
      maxUniformBufferBindingSize: dl.maxUniformBufferBindingSize,
      maxSamplersPerShaderStage: dl.maxSamplersPerShaderStage,
      maxDynamicUniformBuffersPerPipelineLayout: dl.maxDynamicUniformBuffersPerPipelineLayout,
      maxDynamicStorageBuffersPerPipelineLayout: dl.maxDynamicStorageBuffersPerPipelineLayout,
    };

    if (available.length > 0) this.log('GPU features: '+available.join(', '),'ok');
    this.log(`GPU limits: ${(dl.maxBufferSize/1048576)|0}MB buf, ${dl.maxTextureDimension2D}px tex, ${dl.maxStorageBuffersPerShaderStage} storage/stage`, 'ok');
    this.log('WebGPU initialized \u00b7 format: '+this.format, 'ok');
    this._setupInput();
    return true;
  }

  hasFeature(name) { return this._features.has(name); }
  getLimit(name) { return this._limits?.[name] ?? 0; }
  getLimits() { return { ...this._limits }; }

  // Pipeline reflection — get bind group layouts and compilation info
  getPipelineInfo(name) {
    const entry = this.pipelines.get(name);
    if (!entry) return null;
    const info = { name, type: entry.type, activeGroups: [...(entry.activeGroups || [])] };
    // Reflect bind group layouts
    try {
      const layouts = [];
      for (const g of (entry.activeGroups || [])) {
        layouts.push({ group: g, layout: entry.pipeline.getBindGroupLayout(g) });
      }
      info.bindGroupLayouts = layouts;
    } catch (e) { /* some pipelines may not support reflection */ }
    if (entry.type === 'render') {
      info.format = entry.format;
      info.sampleCount = entry.sampleCount;
    }
    if (entry.type === 'compute') {
      info.shaderKey = entry.shaderKey;
    }
    info.resourceScope = entry.resourceScope;
    return info;
  }

  // Get shader compilation info (async)
  async getShaderCompilationInfo(name) {
    const mod = this.shaderModules.get(name);
    if (!mod) return null;
    if (!mod.getCompilationInfo) return { messages: [] };
    const info = await mod.getCompilationInfo();
    return {
      messages: info.messages.map(m => ({
        type: m.type, lineNum: m.lineNum, linePos: m.linePos,
        offset: m.offset, length: m.length, message: m.message,
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // INPUT SYSTEM — WASD, mouse, pointer lock
  // ════════════════════════════════════════════════════════════════

  _setupInput() {
    const c = this.canvas;

    // Keyboard — preventDefault for keys the input system handles
    this._inputKeys = new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE',
      'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight']);
    this._keyBindings = new Map(); // code → {axis, value} for custom movement mappings
    document.addEventListener('keydown', e => {
      // Only consume game keys when canvas is focused or pointer-locked
      if (document.pointerLockElement !== c && document.activeElement !== c) return;
      this.inputState.keys.add(e.code);
      if (this._inputKeys.has(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', e => {
      this.inputState.keys.delete(e.code);
    });

    // Mouse move — pointer-locked events fire on document, unlocked on canvas
    const onMouseMove = e => {
      if (document.pointerLockElement === c) {
        this.inputState.mouseDX += e.movementX;
        this.inputState.mouseDY += e.movementY;
      } else {
        const rect = c.getBoundingClientRect();
        this.inputState.mouseX = (e.clientX - rect.left) / rect.width;
        this.inputState.mouseY = (e.clientY - rect.top) / rect.height;
        this.inputState.mouseDX += e.movementX;
        this.inputState.mouseDY += e.movementY;
      }
    };
    c.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement === c) onMouseMove(e);
    });

    c.addEventListener('mousedown', e => {
      this.inputState.mouseButtons = e.buttons;
      // Double-click to enter pointer lock for FPS-style
      c.focus();
    });
    c.addEventListener('mouseup', e => { this.inputState.mouseButtons = e.buttons; });
    c.addEventListener('dblclick', () => {
      if (!document.pointerLockElement) c.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.inputState.pointerLocked = document.pointerLockElement === c;
    });

    // Wheel
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.inputState.mouseWheel += e.deltaY * 0.001;
    }, {passive:false});
  }

  _updateInputBuiltins() {
    const ks = this.inputState.keys;
    // WASD → movement vector (also arrows)
    let mx=0, my=0, mz=0;
    if (ks.has('KeyW') || ks.has('ArrowUp'))    mz -= 1;
    if (ks.has('KeyS') || ks.has('ArrowDown'))  mz += 1;
    if (ks.has('KeyA') || ks.has('ArrowLeft'))   mx -= 1;
    if (ks.has('KeyD') || ks.has('ArrowRight'))  mx += 1;
    if (ks.has('Space'))  my += 1;
    if (ks.has('ShiftLeft') || ks.has('ShiftRight'))  my -= 1;
    // Custom key bindings
    for (const [code, {axis, value}] of this._keyBindings) {
      if (ks.has(code)) {
        if (axis === 'x') mx += value; else if (axis === 'y') my += value; else if (axis === 'z') mz += value;
      }
    }
    this.inputState.moveX = mx;
    this.inputState.moveY = my;
    this.inputState.moveZ = mz;
  }

  transduce(tree, structureChanged) {
    if (structureChanged) {
      // Try hot patch first (filter param override changes only)
      if (this._tryHotPatchFilters(tree)) {
        // Hot patch succeeded — skip full compile
      } else if (this._prevTree) {
        // Try incremental recompilation
        const changes = this._diffShrub(this._prevTree, tree);
        const phases = this._mapChangesToPhases(changes);
        if (phases.size > 0 && this._canIncrementalCompile(phases)) {
          this._incrementalCompile(tree, phases);
        } else {
          this._compile(tree);
        }
      } else {
        this._compile(tree);
      }
      this._prevTree = JSON.parse(JSON.stringify(tree));
    }
    this._execute();
    this.frameCount++;
  }

  invalidate() {
    this._bindGroups.clear();
    this._structureChanged = true;
    this._frameDirty = true;
    this._dirtyMin = 0;
    this._dirtyMax = this._heapSize||256;
    // MSAA textures are resolution-dependent — must recreate
    for (const [,t] of this._msaaTextures) t.destroy();
    this._msaaTextures.clear();
  }

  destroy() {
    this._loadGeneration++;
    // Cleanup GPU resources for tab suspension
    if (this._heapBuffer) { this._heapBuffer.destroy(); this._heapBuffer = null; }
    for (const [,sb] of this._storageBuffers) sb.destroy();
    this._storageBuffers.clear();
    for (const [,t] of this._textures) t.destroy();
    this._textures.clear();
    for (const [,vb] of this._vertexBuffers) vb.destroy();
    this._vertexBuffers.clear();
    for (const [,ib] of this._indexBuffers) ib.destroy();
    this._indexBuffers.clear();
    this._bindGroups.clear();
    this.pipelines.clear();
    this.shaderModules.clear();
    // MSAA textures
    for (const [,t] of this._msaaTextures) t.destroy();
    this._msaaTextures.clear();
    // Render bundles
    this._renderBundles.clear();
    // Query sets
    for (const [,qs] of this._querySets) { qs.querySet.destroy(); qs.resolveBuffer.destroy(); qs.readBuffer.destroy(); }
    this._querySets.clear();
    // Video textures
    this._videoTextures.clear();
    this._externalTextures.clear();
    // Mipmap pipeline
    this._mipPipeline = null;
    this._mipSampler = null;
    // Spec v1.1 state
    this._opticAccessMap.clear();
    this._readbackPrevValues.clear();
    this._filterParamClassification.clear();
    this._pipelineOverrides.clear();
    this._prevFilterParams.clear();
    this._prevTree = null;
    this._prevHeapLayout = null;
    this._barrierViolations = 0;
  }

  // ════════════════════════════════════════════════════════════════
  // COMPILE PHASE
  // ════════════════════════════════════════════════════════════════

  _compile(tree) {
    this.log('\u2500\u2500 COMPILE PHASE \u2500\u2500','cmd');
    this._warnedTypes.clear();

    // 0. Shared libs — compile @lib nodes into importable WGSL
    this._compileLibs(tree);

    // 0.5. Canvas configuration
    this._configureCanvas(tree);

    // 1. Structs
    this._compileStructs(tree);

    // 1.1. Unified heap notation — @heap nodes → synthetic structs + buffers
    this._compileHeap(tree);

    // 1.5. Filters — expand @filter nodes into synthetic textures/shaders/pipelines/dispatches
    this._compileFilters(tree);

    // 1.5b. Fields — expand @field nodes into synthetic textures/shaders/pipelines/dispatches
    this._compileFields(tree);

    // 2. Heap layout (before shaders so #import heap / #link get_* resolves)
    this._compileHeapLayout(tree);

    // 3. Shaders (resolve #import for structs AND libs, auto-inject WGSL enables)
    this._compileShaders(tree);

    // 4. Optics
    this._compileOptics(tree);

    // 4.5. Heap compaction — liveness analysis + dead optic elimination
    this._compactHeap();

    // 5. Allocate heap
    this._allocateHeap(tree);
    this._prevHeapLayout = new Map(this._heapLayout);

    // 6. Storage buffers
    this._compileStorageBuffers(tree);

    // 7. Textures (mipmaps, views, video, transient, array/cube)
    this._compileTextures(tree);

    // 8. Vertex/Index buffers
    this._compileVertexBuffers(tree);

    // 8.5. Resource scopes (@resources → shared bind group layouts)
    this._compileResourceScopes(tree);

    // 9. Pipelines (MSAA, stencil, blend modes, write mask, dual-source)
    for (const p of Rex.findAll(tree,'pipeline')) this._buildPipeline(p.name, p);

    // 9.5. Render bundles
    this._compileRenderBundles(tree);

    // 10. Barrier schedule
    this._compileBarrierSchedule(tree);

    // 11. Resource aliasing
    this._compileAliasingPlan(tree);

    // 12. Command list (stencil, MSAA, bundles, indirect dispatch, queries)
    this._compileCommandList(tree);

    // 12.5. Optic access annotation — track per-pass read/write on resources
    this._annotateOpticAccesses();

    // 12.6. Derive barriers from optic access patterns
    this._deriveBarriersFromOptics();

    // 13. Write defaults
    this._writeDefaults();

    // 14. Readback descriptors
    this._compileReadbacks(tree);

    // 14.5. Query sets (timestamp, occlusion)
    this._compileQueries(tree);

    // 15. Extension compile hooks
    for (const [typeName, handler] of this._compileHandlers) {
      const nodes = Rex.findAll(tree, typeName);
      if (nodes.length > 0) handler(nodes, tree, this);
    }

    this.log(`compile complete: ${this._heapSize}B heap, ${this._optics.length} optics, ${this._storageBuffers.size} storage, ${this._textures.size} textures`,'ok');
  }

  _compileReadbacks(tree) {
    // Destroy old staging buffers
    for (const rb of this._readbacks) { if (rb.staging) rb.staging.destroy(); }
    this._readbacks = [];
    this._readbackPrevValues.clear();
    for (const node of Rex.findAll(tree, 'readback')) {
      const path = node.attrs.path;
      if (path) {
        // Optic-driven readback: resolve path through optic table
        const resolved = this._resolveOpticPath(path);
        if (!resolved) { this.log(`readback "${node.name||'?'}": path "${path}" not resolved`, 'err'); continue; }
        const srcBuf = resolved.isHeap ? this._heapBuffer : this._storageBuffers.get(resolved.buffer);
        if (!srcBuf) { this.log(`readback "${node.name||'?'}": buffer "${resolved.buffer}" not found`, 'err'); continue; }
        const staging = this.device.createBuffer({ size: resolved.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const mode = node.attrs['on-change'] ? 'on-change' : node.attrs.every ? 'every' : 'one-shot';
        this._readbacks.push({
          name: node.name || path, srcBuffer: srcBuf, srcOffset: resolved.offset,
          size: resolved.size, staging, pending: false,
          path, structLayout: resolved.structLayout, type: resolved.type, mode,
          every: +(node.attrs.every || 1), lastReadFrame: -Infinity,
          toSlot: node.attrs.to || null, isHeapBuffer: resolved.isHeap,
        });
        this.log(`readback: "${node.name||path}" via optic path "${path}" (${mode})`, 'ok');
      } else {
        // Legacy raw byte range readback
        const from = node.attrs.from;
        const offset = +(node.attrs.offset || 0);
        const count = +(node.attrs.count || 1);
        const size = count * 4;
        const srcBuf = this._storageBuffers.get(from);
        if (!srcBuf) { this.log(`readback "${node.name||'?'}": buffer "${from}" not found`, 'err'); continue; }
        const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        this._readbacks.push({
          name: node.name || from, srcBuffer: srcBuf, srcOffset: offset, size, staging, pending: false,
          path: null, structLayout: null, type: null, mode: 'one-shot',
          every: 1, lastReadFrame: -Infinity, toSlot: null, isHeapBuffer: false,
        });
        this.log(`readback: "${node.name||from}" ${count} floats from "${from}"+${offset}`, 'ok');
      }
    }
  }

  _configureCanvas(tree) {
    const canvasNode = Rex.findAll(tree, 'canvas')[0];
    if (!canvasNode) return;
    const config = { device: this.device, format: this.format, alphaMode: canvasNode.attrs['alpha-mode'] || 'premultiplied' };
    const toneMapping = canvasNode.attrs['tone-mapping'];
    const colorSpace = canvasNode.attrs['color-space'];
    if (toneMapping) config.toneMapping = { mode: toneMapping };
    if (colorSpace) config.colorSpace = colorSpace;
    this.context.configure(config);
    this.log(`canvas: alpha=${config.alphaMode}${toneMapping ? ` tone=${toneMapping}` : ''}${colorSpace ? ` color-space=${colorSpace}` : ''}`,'ok');
  }

  _compileQueries(tree) {
    for (const [,qs] of this._querySets) { qs.querySet.destroy(); qs.resolveBuffer.destroy(); qs.readBuffer.destroy(); }
    this._querySets.clear();
    for (const q of Rex.findAll(tree, 'query')) {
      const type = q.attrs.type || 'timestamp';
      if (type === 'timestamp' && !this._features.has('timestamp-query')) {
        this.log(`query "${q.name}": timestamp-query feature not available`,'warn');
        continue;
      }
      const count = +(q.attrs.count || 2);
      const querySet = this.device.createQuerySet({ type, count });
      const resolveBuffer = this.device.createBuffer({
        size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      const readBuffer = this.device.createBuffer({
        size: count * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this._querySets.set(q.name, { querySet, resolveBuffer, readBuffer, count, type, nextIndex: 0, readPending: false });
      this.log(`query: "${q.name}" ${type} x${count}`,'ok');
    }
  }

  _compileRenderBundles(tree) {
    this._renderBundles.clear();
    for (const bundle of Rex.findAll(tree, 'bundle')) {
      const name = bundle.name;
      if (!name) continue;
      const draws = Rex.findAll(bundle, 'draw');
      if (draws.length === 0) continue;
      const firstPe = this.pipelines.get(draws[0].attrs.pipeline);
      if (!firstPe) continue;
      const depthFmt = bundle.attrs['depth-format'] || (bundle.attrs.depth ? 'depth24plus' : undefined);
      const bundleEnc = this.device.createRenderBundleEncoder({
        colorFormats: [firstPe.format || this.format],
        depthStencilFormat: depthFmt,
        sampleCount: firstPe.sampleCount || 1,
      });
      for (const draw of draws) {
        const pe = this.pipelines.get(draw.attrs.pipeline);
        if (!pe) continue;
        bundleEnc.setPipeline(pe.pipeline);
        if (pe.resourceScope && this._resourceScopes?.has(pe.resourceScope)) {
          bundleEnc.setBindGroup(0, this._resourceScopes.get(pe.resourceScope).bindGroup);
        }
        for (const b of draw.children.filter(c => c.type === 'bind')) {
          this._setBindGroup(bundleEnc, pe, {
            group: Number(b.name)||0, buffer: b.attrs.buffer,
            texture: b.attrs.texture, sampler: b.attrs.sampler, storage: b.attrs.storage,
          });
        }
        if (draw.attrs.bind) this._setBindGroup(bundleEnc, pe, { group: 0, buffer: draw.attrs.bind });
        if (draw.attrs['vertex-buffer']) {
          const vb = this._vertexBuffers.get(draw.attrs['vertex-buffer']);
          if (vb) bundleEnc.setVertexBuffer(0, vb);
        }
        if (draw.attrs['index-buffer'] && draw.attrs['index-count']) {
          const ib = this._indexBuffers.get(draw.attrs['index-buffer']);
          if (ib) { bundleEnc.setIndexBuffer(ib, 'uint32'); bundleEnc.drawIndexed(+(draw.attrs['index-count']), +(draw.attrs.instances||1)); }
        } else {
          bundleEnc.draw(+(draw.attrs.vertices||3), +(draw.attrs.instances||1));
        }
      }
      this._renderBundles.set(name, bundleEnc.finish());
      this.log(`bundle: "${name}" ${draws.length} draws recorded`,'ok');
    }
  }

  _rebuildVideoScope(scopeName) {
    const scope = this._resourceScopes.get(scopeName);
    if (!scope || !scope._layoutEntries) return;
    const entries = [];
    for (const le of scope._entries) {
      if (le._videoName) {
        const extTex = this._externalTextures.get(le._videoName);
        if (extTex) entries.push({ binding: le.binding, resource: extTex });
        else return; // skip rebuild if video not ready
      } else {
        entries.push(le);
      }
    }
    scope.bindGroup = this.device.createBindGroup({ layout: scope.layout, entries });
  }

  _compileLibs(tree) {
    this._wgslLibs = new Map();
    for (const lib of Rex.findAll(tree, 'lib')) {
      const key = lib.name || 'unnamed';
      let code = lib.content?.trim();
      if (!code) continue;
      this._wgslLibs.set(key, code);
      this.log(`lib: ${key} (${code.split('\n').length} lines)`,'ok');
    }
  }

  _compileStructs(tree) {
    this._structs = new Map();
    this._wgslStructs = new Map();
    for (const s of Rex.findAll(tree,'struct')) {
      // Note: Rex.findAll searches the full subtree. @field must be inside @struct, not @shader.
      // If @field appears inside @shader content it's WGSL syntax, not a Shrub @field node.
      const fields = Rex.findAll(s,'field');
      let size = 0; const layout = [];
      for (const f of fields) {
        const type = f.attrs.type || 'f32';
        const bs = this._typeSize(type);
        const align = Math.max(4, bs <= 4 ? 4 : bs <= 8 ? 8 : 16);
        size = Math.ceil(size/align)*align;
        layout.push({name:f.name, type, offset:size, size:bs});
        size += bs;
      }
      size = Math.ceil(size/16)*16;
      this._structs.set(s.name, {size,layout});
      const wgsl = `struct ${s.name} {\n${layout.map(l => `  ${l.name}: ${this._toWGSL(l.type)},`).join('\n')}\n}`;
      this._wgslStructs.set(s.name, wgsl);
      this.log(`struct ${s.name}: ${size}B [${layout.map(l=>`${l.name}@${l.offset}`).join(', ')}]`,'cmd');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // HOT SHADER PATCHING — pipeline-overridable constants (Spec §5)
  // ════════════════════════════════════════════════════════════════

  _classifyFilterParam(filterName, paramName, value, nodeAttrs) {
    const attrVal = nodeAttrs[paramName];
    // Expression → per-frame uniform (future: uniform buffer path)
    if (attrVal && typeof attrVal === 'object' && attrVal.expr) return 'uniform';
    // Literal matching builtin default → compile-time const
    const builtin = this._filterLibrary.get(filterName);
    if (builtin && builtin.params && builtin.params[paramName] === value) return 'const';
    // Literal differing from default → pipeline override
    return 'override';
  }

  _tryHotPatchFilters(tree) {
    if (this._prevFilterParams.size === 0) return false;
    const filters = Rex.findAll(tree, 'filter');
    if (filters.length === 0) return false;

    let canHotPatch = true;
    const patchOps = []; // [{pipelineKey, newOverrides}]

    for (let fi = 0; fi < filters.length; fi++) {
      const f = filters[fi];
      const filterName = f.name || f.attrs.type || `filter_${fi}`;
      const prevParams = this._prevFilterParams.get(filterName);
      if (!prevParams) { canHotPatch = false; break; }

      const builtin = this._filterLibrary.get(filterName);
      const params = { ...(builtin?.params || {}) };
      // Override from attrs
      for (const [k, v] of Object.entries(f.attrs)) {
        if (k !== 'src' && k !== 'out' && k !== 'type' && k !== 'matrix' && k in params) {
          params[k] = typeof v === 'number' ? v : +v;
        }
      }

      // Check what changed
      const classifications = this._filterParamClassification.get(filterName);
      if (!classifications) { canHotPatch = false; break; }

      let hasNonOverrideChange = false;
      let hasOverrideChange = false;
      for (const [k, v] of Object.entries(params)) {
        if (prevParams[k] !== v) {
          const cls = classifications.get(k);
          if (cls === 'override') {
            hasOverrideChange = true;
          } else {
            hasNonOverrideChange = true;
            break;
          }
        }
      }
      if (hasNonOverrideChange) { canHotPatch = false; break; }

      if (hasOverrideChange) {
        // Find all pipeline keys for this filter's passes
        const passes = builtin?.passes || 1;
        for (let pass = 0; pass < passes; pass++) {
          const pfx = `_filter_${fi}_${pass}`;
          const pipeKey = `${pfx}_pipe`;
          const newOverrides = {};
          for (const [k, v] of Object.entries(params)) {
            if (classifications.get(k) === 'override') {
              newOverrides[`PARAM_${k}`] = Number(v);
            }
          }
          patchOps.push({ pipelineKey: pipeKey, newOverrides });
        }
        this._prevFilterParams.set(filterName, { ...params });
      }
    }

    if (!canHotPatch || patchOps.length === 0) return false;

    // Apply hot patches — recreate pipelines with new constants
    for (const op of patchOps) {
      const pe = this.pipelines.get(op.pipelineKey);
      if (!pe || pe.type !== 'compute') continue;
      const mod = this.shaderModules.get(pe.shaderKey);
      if (!mod) continue;
      const resScope = pe.resourceScope ? this._resourceScopes?.get(pe.resourceScope) : null;
      const layout = resScope
        ? this.device.createPipelineLayout({ bindGroupLayouts: [resScope.layout] })
        : 'auto';
      const newPipeline = this.device.createComputePipeline({
        layout, compute: { module: mod, entryPoint: 'main', constants: op.newOverrides },
      });
      pe.pipeline = newPipeline;
      pe.overrides = { ...op.newOverrides };
      this.log(`hot-patch: ${op.pipelineKey} overrides updated`, 'ok');
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  // FILTER EXPANSION — @filter nodes → synthetic textures/shaders/pipelines/dispatches
  // ════════════════════════════════════════════════════════════════

  _compileFilters(tree) {
    const filters = Rex.findAll(tree, 'filter');
    if (!filters.length) return;

    const filterOutputs = new Map();
    const batches = this._buildFusionBatches(filters, tree);
    let filterIdx = 0;
    let fusedBatches = 0;

    for (const batch of batches) {
      if (batch.fusible && batch.filters.length > 1) {
        this._emitFusedShader(batch, filterIdx, tree, filterOutputs);
        fusedBatches++;
        filterIdx += batch.filters.length;
      } else {
        for (const f of batch.filters) {
          this._emitSingleFilter(f, filterIdx, tree, filterOutputs);
          filterIdx++;
        }
      }
    }

    this.log(`filters: ${filterIdx} expanded${fusedBatches > 0 ? ` (${fusedBatches} fused batches)` : ''}`, 'ok');
  }

  _buildFusionBatches(filters, tree) {
    const batches = [];
    let currentBatch = { filters: [], fusible: true, srcName: null, texW: 0, texH: 0 };

    for (const f of filters) {
      const filterName = f.name || f.attrs.type;
      const srcName = f.attrs.src;
      if (!srcName) { batches.push({ filters: [f], fusible: false }); continue; }

      const builtin = this._filterLibrary.get(filterName);
      const customCode = f.content?.trim();
      const needsNeighbors = builtin?.needsNeighbors || (customCode && /textureLoad\s*\(\s*src/.test(customCode));
      const multiPass = (builtin?.passes || 1) > 1;
      const hasExternalOut = f.attrs.out != null;

      // Resolve texture dimensions
      const srcTex = Rex.findAll(tree, 'texture').find(t => t.name === srcName);
      const texW = srcTex?.attrs?.width || 512;
      const texH = srcTex?.attrs?.height || 512;

      const canFuse = !needsNeighbors && !multiPass && !hasExternalOut;

      if (canFuse && currentBatch.filters.length > 0 && currentBatch.fusible) {
        // Check same source chain and dimensions
        const firstSrc = currentBatch.srcName;
        if (srcName === firstSrc && texW === currentBatch.texW && texH === currentBatch.texH) {
          currentBatch.filters.push(f);
          continue;
        }
      }

      // Close current batch and start new
      if (currentBatch.filters.length > 0) batches.push(currentBatch);
      currentBatch = { filters: [f], fusible: canFuse, srcName, texW, texH };
    }
    if (currentBatch.filters.length > 0) batches.push(currentBatch);
    return batches;
  }

  _emitFusedShader(batch, filterIdxBase, tree, filterOutputs) {
    const texFmt = 'rgba8unorm';
    const srcName = batch.srcName;
    const effectiveSrc = filterOutputs.get(srcName) || srcName;
    const pfx = `_fused_${filterIdxBase}`;
    const dstName = `${pfx}_out`;

    // Collect all pixel bodies and params with namespaced prefixes
    const allParamDecls = [];
    const allOverrides = {};
    const allBodies = [];

    for (let i = 0; i < batch.filters.length; i++) {
      const f = batch.filters[i];
      const filterName = f.name || f.attrs.type || `filter_${filterIdxBase + i}`;
      const builtin = this._filterLibrary.get(filterName);
      const customCode = f.content?.trim();

      // Resolve params
      const params = { ...(builtin?.params || {}) };
      if (builtin) {
        if (filterName === 'color-matrix' && f.attrs.matrix && Array.isArray(f.attrs.matrix)) {
          const m = f.attrs.matrix;
          for (let j = 0; j < 16; j++) params[`m${j}`] = +(m[j] ?? (j % 5 === 0 ? 1 : 0));
        }
        for (const [k, v] of Object.entries(f.attrs)) {
          if (k !== 'src' && k !== 'out' && k !== 'type' && k !== 'matrix' && k in params) {
            params[k] = typeof v === 'number' ? v : +v;
          }
        }
      }

      // Classify params and emit with namespaced prefix
      const classifications = new Map();
      for (const [k, v] of Object.entries(params)) {
        const cls = this._classifyFilterParam(filterName, k, v, f.attrs);
        classifications.set(k, cls);
        const nsKey = `PARAM_${filterName}_${k}`;
        if (cls === 'override') {
          allParamDecls.push(`override ${nsKey}: f32 = ${Number(v).toFixed(6)};`);
          allOverrides[nsKey] = Number(v);
        } else {
          allParamDecls.push(`const ${nsKey}: f32 = ${Number(v).toFixed(6)};`);
        }
      }
      this._filterParamClassification.set(filterName, classifications);
      this._prevFilterParams.set(filterName, { ...params });

      // Get pixel body and rewrite PARAM_ references to namespaced versions
      let pixelBody = customCode || builtin.wgsl;
      // Rewrite PARAM_xyz → PARAM_filterName_xyz for params that belong to this filter
      for (const k of Object.keys(params)) {
        pixelBody = pixelBody.replace(new RegExp(`PARAM_${k}\\b`, 'g'), `PARAM_${filterName}_${k}`);
      }

      allBodies.push(`  // ── ${filterName} ──\n  ${pixelBody}`);
    }

    // Build fused shader
    const shaderCode = `@group(0) @binding(0) var filter_samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<${texFmt}, write>;

${allParamDecls.join('\n')}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2f(textureDimensions(src));
  let px = gid.xy;
  if (px.x >= u32(dims.x) || px.y >= u32(dims.y)) { return; }
  let uv = (vec2f(px) + 0.5) / dims;
  var color = textureSampleLevel(src, filter_samp, uv, 0.0);

${allBodies.join('\n\n')}

  textureStore(dst, px, color);
}`;

    // Inject ONE set of synthetic nodes
    const existingTex = Rex.findAll(tree, 'texture').find(t => t.name === dstName);
    if (!existingTex) {
      tree.children.push({ type: 'texture', name: dstName, attrs: { width: batch.texW, height: batch.texH, format: texFmt, storage: true }, children: [], content: null, _d: 1 });
    }
    tree.children.push({ type: 'shader', name: pfx, attrs: {}, children: [], content: shaderCode, _d: 1 });
    tree.children.push({ type: 'resources', name: `${pfx}_res`, attrs: {}, children: [
      { type: 'texture', name: effectiveSrc, attrs: {}, children: [], content: null, _d: 2 },
      { type: 'texture', name: dstName, attrs: { storage: true, format: texFmt }, children: [], content: null, _d: 2 },
    ], content: null, _d: 1 });
    tree.children.push({ type: 'pipeline', name: `${pfx}_pipe`, attrs: {
      compute: pfx, resources: `${pfx}_res`,
      _overrides: Object.keys(allOverrides).length > 0 ? allOverrides : undefined,
    }, children: [], content: null, _d: 1 });
    tree.children.push({ type: 'dispatch', name: null, attrs: {
      pipeline: `${pfx}_pipe`, grid: [Math.ceil(batch.texW / 8), Math.ceil(batch.texH / 8), 1],
    }, children: [], content: null, _d: 1 });

    // Track output for chaining
    filterOutputs.set(srcName, dstName);
    this.log(`fused: ${batch.filters.length} filters → ${pfx} (${effectiveSrc} → ${dstName})`, 'ok');
  }

  _emitSingleFilter(f, filterIdx, tree, filterOutputs) {
    const filterName = f.name || f.attrs.type || `filter_${filterIdx}`;
    const srcName = f.attrs.src;
    if (!srcName) { this.log(`filter "${filterName}": missing :src attribute`, 'err'); return; }

    const effectiveSrc = filterOutputs.get(srcName) || srcName;
    const srcTex = Rex.findAll(tree, 'texture').find(t => t.name === srcName) ||
                   Rex.findAll(tree, 'texture').find(t => t.name === effectiveSrc);
    const texW = srcTex?.attrs?.width || 512;
    const texH = srcTex?.attrs?.height || 512;
    const texFmt = 'rgba8unorm';

    const builtin = this._filterLibrary.get(filterName);
    const customCode = f.content?.trim();
    if (!builtin && !customCode) { this.log(`filter "${filterName}": unknown filter and no custom code`, 'err'); return; }

    const outName = f.attrs.out || null;
    const passes = builtin?.passes || 1;

    const params = { ...(builtin?.params || {}) };
    if (builtin) {
      if (filterName === 'color-matrix' && f.attrs.matrix && Array.isArray(f.attrs.matrix)) {
        const m = f.attrs.matrix;
        for (let i = 0; i < 16; i++) params[`m${i}`] = +(m[i] ?? (i % 5 === 0 ? 1 : 0));
      }
      for (const [k, v] of Object.entries(f.attrs)) {
        if (k !== 'src' && k !== 'out' && k !== 'type' && k !== 'matrix' && k in params) {
          params[k] = typeof v === 'number' ? v : +v;
        }
      }
    }

    // Classify and generate WGSL declarations for params (hot shader patching)
    const classifications = new Map();
    const paramDecls = [];
    const overrides = {};
    for (const [k, v] of Object.entries(params)) {
      const cls = this._classifyFilterParam(filterName, k, v, f.attrs);
      classifications.set(k, cls);
      if (cls === 'override') {
        paramDecls.push(`override PARAM_${k}: f32 = ${Number(v).toFixed(6)};`);
        overrides[`PARAM_${k}`] = Number(v);
      } else {
        paramDecls.push(`const PARAM_${k}: f32 = ${Number(v).toFixed(6)};`);
      }
    }
    const paramConsts = paramDecls.join('\n');
    this._filterParamClassification.set(filterName, classifications);
    this._prevFilterParams.set(filterName, { ...params });

    let currentSrc = effectiveSrc;
    for (let pass = 0; pass < passes; pass++) {
      const pfx = `_filter_${filterIdx}_${pass}`;
      const isLastPass = pass === passes - 1;
      const dstName = isLastPass && outName ? outName : `${pfx}_out`;

      let pixelBody;
      if (customCode) { pixelBody = customCode; }
      else if (passes === 1) { pixelBody = builtin.wgsl; }
      else { pixelBody = pass === 0 ? builtin.wgslH : builtin.wgslV; }

      const needsNeighbors = builtin?.needsNeighbors || /textureLoad\s*\(\s*src/.test(pixelBody);

      const shaderCode = `@group(0) @binding(0) var filter_samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<${texFmt}, write>;

${paramConsts}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2f(textureDimensions(src));
  let px = gid.xy;
  if (px.x >= u32(dims.x) || px.y >= u32(dims.y)) { return; }
  let uv = (vec2f(px) + 0.5) / dims;
  var color = ${needsNeighbors ? 'textureLoad(src, vec2i(px), 0)' : 'textureSampleLevel(src, filter_samp, uv, 0.0)'};

  ${pixelBody}

  textureStore(dst, px, color);
}`;

      const existingTex = Rex.findAll(tree, 'texture').find(t => t.name === dstName);
      if (!existingTex) {
        tree.children.push({ type: 'texture', name: dstName, attrs: { width: texW, height: texH, format: texFmt, storage: true }, children: [], content: null, _d: 1 });
      }
      tree.children.push({ type: 'shader', name: pfx, attrs: {}, children: [], content: shaderCode, _d: 1 });
      tree.children.push({ type: 'resources', name: `${pfx}_res`, attrs: {}, children: [
        { type: 'texture', name: currentSrc, attrs: {}, children: [], content: null, _d: 2 },
        { type: 'texture', name: dstName, attrs: { storage: true, format: texFmt }, children: [], content: null, _d: 2 },
      ], content: null, _d: 1 });
      tree.children.push({ type: 'pipeline', name: `${pfx}_pipe`, attrs: {
        compute: pfx, resources: `${pfx}_res`,
        _overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      }, children: [], content: null, _d: 1 });
      tree.children.push({ type: 'dispatch', name: null, attrs: {
        pipeline: `${pfx}_pipe`, grid: [Math.ceil(texW / 8), Math.ceil(texH / 8), 1],
      }, children: [], content: null, _d: 1 });

      this.log(`filter "${filterName}" pass ${pass}: ${pfx} (${currentSrc} → ${dstName})`, 'ok');
      currentSrc = dstName;
    }

    const finalOut = outName || `_filter_${filterIdx}_${passes - 1}_out`;
    filterOutputs.set(srcName, finalOut);
    if (outName) filterOutputs.set(outName, finalOut);
  }

  // ════════════════════════════════════════════════════════════════
  // SCALAR FIELD SYSTEM — @field sugar expansion
  // Same pattern as @filter: find @field nodes → emit synthetic
  // @texture + @shader + @resources + @pipeline + @dispatch.
  // ════════════════════════════════════════════════════════════════

  _compileFields(tree) {
    // Remove previously emitted synthetic field nodes
    tree.children = tree.children.filter(c => {
      if (c.name && String(c.name).startsWith('_field_')) return false;
      // Also remove anonymous dispatches/passes that reference _field_ pipelines
      if (!c.name && c.attrs && typeof c.attrs.pipeline === 'string' && c.attrs.pipeline.startsWith('_field_')) return false;
      return true;
    });

    const fields = Rex.findAll(tree, 'field');
    // Disambiguate: @field inside @struct (struct fields) vs top-level @field (scalar fields)
    const realFields = fields.filter(f =>
      f.children.some(c => c.type === 'source' || c.type === 'visualize') ||
      f.attrs.resolution || f.attrs.composition
    );
    if (!realFields.length) return;
    this._fieldConfigs = new Map();

    for (let i = 0; i < realFields.length; i++) {
      this._emitField(realFields[i], i, tree);
    }
    this.log(`fields: ${realFields.length} expanded`, 'ok');
  }

  // Resolve attr value that may be a string, number, or {expr: "..."} object from Rex parser
  _fieldAttr(attrs, key, fallback) {
    let v = attrs[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'object' && v.expr) return v.expr;
    return v;
  }

  _parseFieldColor(value) {
    if (!value) return [1, 1, 1, 1];
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string' && value.startsWith('#')) {
      const hex = value.slice(1);
      if (hex.length === 8) return [
        parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255,
        parseInt(hex.slice(4,6),16)/255, parseInt(hex.slice(6,8),16)/255,
      ];
      if (hex.length === 6) return [
        parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255,
        parseInt(hex.slice(4,6),16)/255, 1,
      ];
    }
    return [1, 1, 1, 1];
  }

  _colorToWgsl(c) {
    return `${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)}, ${c[3].toFixed(4)}`;
  }

  _parseFieldSourceParam(value) {
    // Returns { static: bool, value: number|null, expr: string|null }
    if (value === undefined || value === null) return { static: true, value: 0, expr: null };
    if (typeof value === 'number') return { static: true, value, expr: null };
    if (typeof value === 'string') {
      const n = Number(value);
      if (!isNaN(n)) return { static: true, value: n, expr: null };
      // It's a builtin name like "mouse-x"
      return { static: false, value: 0, expr: value };
    }
    if (typeof value === 'object' && value.expr) return { static: false, value: 0, expr: value.expr };
    return { static: true, value: +value || 0, expr: null };
  }

  _falloffTypeIndex(name) {
    switch (name) {
      case 'inverse-square': return 0;
      case 'gaussian': return 1;
      case 'exponential': return 2;
      case 'linear': return 3;
      default: return 1; // default gaussian
    }
  }

  _emitField(node, idx, tree) {
    const name = node.name || `field_${idx}`;

    // Parse field config
    let resAttr = node.attrs.resolution;
    // Handle expression objects from paren syntax, e.g. (512 512) → {expr: "512 512"}
    if (resAttr && typeof resAttr === 'object' && resAttr.expr) {
      const parts = resAttr.expr.trim().split(/\s+/).map(Number);
      resAttr = parts.length >= 2 ? parts : parts[0] || 512;
    }
    const resX = (Array.isArray(resAttr) ? +resAttr[0] : (resAttr ? +resAttr : 512)) || 512;
    const resY = (Array.isArray(resAttr) ? +resAttr[1] : (resAttr ? +resAttr : 512)) || 512;
    // Composition may be string or {expr:"smooth-min"} depending on parser hyphen handling
    let rawComp = node.attrs.composition || 'smooth-min';
    if (typeof rawComp === 'object' && rawComp.expr) rawComp = rawComp.expr;
    const composition = String(rawComp);
    // blend-k: Rex parser may split hyphenated keys — try multiple key forms
    const blendKRaw = node.attrs['blend-k'] ?? node.attrs.blendK ?? node.attrs.blend?.k ?? 0.3;
    const blendK = +(typeof blendKRaw === 'object' && blendKRaw.expr ? blendKRaw.expr : blendKRaw) || 0.3;

    // Parse sources
    const sourceNodes = node.children.filter(c => c.type === 'source');
    const sources = sourceNodes.map((s, si) => {
      const posAttr = s.attrs.pos;
      let posX, posY, posXExpr, posYExpr, posDynamic;
      if (Array.isArray(posAttr)) {
        // Bracket syntax: [150 256]
        const px = this._parseFieldSourceParam(posAttr[0]);
        const py = this._parseFieldSourceParam(posAttr[1]);
        posX = px.value; posY = py.value;
        posXExpr = px.expr; posYExpr = py.expr;
        posDynamic = !px.static || !py.static;
      } else if (posAttr && typeof posAttr === 'object' && posAttr.expr) {
        // Paren syntax: (150 256) or (mouse-x mouse-y) — parsed as {expr: "150 256"} or {expr: "mouse-x mouse-y"}
        const parts = posAttr.expr.trim().split(/\s+/);
        const px = this._parseFieldSourceParam(parts[0]);
        const py = this._parseFieldSourceParam(parts[1] ?? parts[0]);
        posX = px.value; posY = py.value;
        posXExpr = px.expr; posYExpr = py.expr;
        posDynamic = !px.static || !py.static;
      } else if (posAttr !== undefined && posAttr !== null) {
        // Single value or other — treat as static
        const v = +posAttr || 0;
        posX = v; posY = v; posXExpr = null; posYExpr = null; posDynamic = false;
      } else {
        posX = 0; posY = 0; posXExpr = null; posYExpr = null; posDynamic = false;
      }

      const strengthParam = this._parseFieldSourceParam(s.attrs.strength ?? 1.0);
      const radiusParam = this._parseFieldSourceParam(s.attrs.radius ?? s.attrs.sigma ?? 50);
      const falloffType = this._falloffTypeIndex(s.attrs.falloff);

      return {
        name: s.name || `source_${si}`,
        posX, posY, posXExpr, posYExpr,
        strength: strengthParam.value, strengthExpr: strengthParam.expr,
        radius: radiusParam.value, radiusExpr: radiusParam.expr,
        falloffType,
        dynamic: posDynamic,
        dynamicStrength: !strengthParam.static,
        dynamicRadius: !radiusParam.static,
      };
    });

    const hasDynamic = sources.some(s => s.dynamic || s.dynamicStrength || s.dynamicRadius);
    const sourceCount = sources.length;

    // Parse visualize nodes
    const vizNodes = node.children.filter(c => c.type === 'visualize');
    if (vizNodes.length === 0) {
      vizNodes.push({ type: 'visualize', name: null, attrs: { mode: 'isosurface' }, children: [], content: null });
    }

    // ── Emit source storage buffer ──
    const srcBufName = `_field_${name}_sources`;
    const srcBufSize = Math.max(64, sourceCount * 24); // 6 floats × 4 bytes each
    tree.children.push({
      type: 'buffer', name: srcBufName,
      attrs: { size: srcBufSize, usage: ['storage'] },
      children: [], content: null, _d: 1,
    });

    // ── Emit field grid texture (rgba16float — filterable, HDR precision) ──
    const gridTexName = `_field_${name}_grid`;
    tree.children.push({
      type: 'texture', name: gridTexName,
      attrs: { width: resX, height: resY, format: 'rgba16float', storage: true, filter: 'linear' },
      children: [], content: null, _d: 1,
    });

    // ── Emit eval compute shader ──
    const evalShaderName = `_field_${name}_eval`;
    const evalShaderCode = this._generateFieldEvalShader(name, sourceCount, composition, blendK, resX, resY);
    tree.children.push({
      type: 'shader', name: evalShaderName,
      attrs: {}, children: [], content: evalShaderCode, _d: 1,
    });

    // ── Emit eval resources ──
    const evalResName = `_field_${name}_eval_res`;
    tree.children.push({
      type: 'resources', name: evalResName, attrs: {}, children: [
        { type: 'buffer', name: srcBufName, attrs: { usage: ['storage'], access: 'read' }, children: [], content: null, _d: 2 },
        { type: 'texture', name: gridTexName, attrs: { storage: true, format: 'rgba16float' }, children: [], content: null, _d: 2 },
      ], content: null, _d: 1,
    });

    // ── Emit eval pipeline ──
    const evalPipeName = `_field_${name}_eval_pipe`;
    tree.children.push({
      type: 'pipeline', name: evalPipeName,
      attrs: { compute: evalShaderName, resources: evalResName },
      children: [], content: null, _d: 1,
    });

    // ── Emit eval dispatch ──
    const wgEvalX = Math.ceil(resX / 16) | 0, wgEvalY = Math.ceil(resY / 16) | 0;
    tree.children.push({
      type: 'dispatch', name: null,
      attrs: { pipeline: evalPipeName, grid: [wgEvalX, wgEvalY, 1] },
      children: [], content: null, _d: 1,
    });

    // ── Per @visualize: emit viz shader + resources + pipeline + dispatch ──
    const vizOutputNames = [];
    for (let vi = 0; vi < vizNodes.length; vi++) {
      const viz = vizNodes[vi];
      const vizName = viz.name || `${vi}`;
      const outName = viz.attrs.out || `_field_${name}_viz_${vizName}`;
      vizOutputNames.push(outName);

      // Viz output texture
      tree.children.push({
        type: 'texture', name: outName,
        attrs: { width: resX, height: resY, format: 'rgba8unorm', storage: true },
        children: [], content: null, _d: 1,
      });

      // Viz shader
      const vizShaderName = `_field_${name}_viz_${vizName}`;
      const vizShaderCode = this._generateFieldVizShader(name, viz.attrs, resX, resY);
      tree.children.push({
        type: 'shader', name: vizShaderName,
        attrs: {}, children: [], content: vizShaderCode, _d: 1,
      });

      // Viz resources: sampler + grid (sampled) + output (storage)
      const vizResName = `_field_${name}_viz_${vizName}_res`;
      tree.children.push({
        type: 'resources', name: vizResName, attrs: {}, children: [
          { type: 'texture', name: gridTexName, attrs: {}, children: [], content: null, _d: 2 },
          { type: 'texture', name: outName, attrs: { storage: true, format: 'rgba8unorm' }, children: [], content: null, _d: 2 },
        ], content: null, _d: 1,
      });

      // Viz pipeline
      const vizPipeName = `_field_${name}_viz_${vizName}_pipe`;
      tree.children.push({
        type: 'pipeline', name: vizPipeName,
        attrs: { compute: vizShaderName, resources: vizResName },
        children: [], content: null, _d: 1,
      });

      // Viz dispatch
      const wgVizX = Math.ceil(resX / 8) | 0, wgVizY = Math.ceil(resY / 8) | 0;
      tree.children.push({
        type: 'dispatch', name: null,
        attrs: { pipeline: vizPipeName, grid: [wgVizX, wgVizY, 1] },
        children: [], content: null, _d: 1,
      });
    }

    // ── Emit blit pass: draw field viz to canvas ──
    const blitShaderName = `_field_${name}_blit`;
    const blitPipeName = `_field_${name}_blit_pipe`;
    const blitResName = `_field_${name}_blit_res`;
    const primaryViz = vizOutputNames[0];

    // Blit shader — fullscreen vertex+fragment, samples viz texture
    const blitShaderCode = `
@group(0) @binding(0) var blit_samp: sampler;
@group(0) @binding(1) var blit_tex: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, }
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VSOut;
  out.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSample(blit_tex, blit_samp, in.uv);
}
`;
    tree.children.push({ type: 'shader', name: blitShaderName, attrs: {}, children: [], content: blitShaderCode, _d: 1 });

    // Blit resources
    tree.children.push({
      type: 'resources', name: blitResName, attrs: {}, children: [
        { type: 'texture', name: primaryViz, attrs: {}, children: [], content: null, _d: 2 },
      ], content: null, _d: 1,
    });

    // Blit pipeline (render, not compute)
    tree.children.push({
      type: 'pipeline', name: blitPipeName,
      attrs: { vertex: blitShaderName, fragment: blitShaderName, resources: blitResName,
               blend: 'alpha', format: 'canvas' },
      children: [], content: null, _d: 1,
    });

    // Blit pass — fullscreen draw to canvas
    tree.children.push({
      type: 'pass', name: `_field_${name}_blit_pass`,
      attrs: { clear: [0, 0, 0, 0], load: 'clear' },
      children: [{
        type: 'draw', name: null,
        attrs: { pipeline: blitPipeName, vertices: 3 },
        children: [], content: null, _d: 2,
      }],
      content: null, _d: 1,
    });

    // ── Store config for per-frame dynamic updates ──
    this._fieldConfigs.set(name, {
      sources, resX, resY,
      dynamicSources: sources.filter(s => s.dynamic || s.dynamicStrength || s.dynamicRadius),
      bufferName: srcBufName,
      vizOutputs: vizOutputNames,
      hasDynamic,
    });

    this.log(`field "${name}": ${sourceCount} sources, ${vizNodes.length} viz, ${resX}×${resY} ${composition}`, 'ok');
  }

  _generateFieldEvalShader(name, sourceCount, composition, blendK, resX, resY) {
    // Composition logic
    let compositionCode;
    switch (composition) {
      case 'additive': compositionCode = '    val += c;'; break;
      case 'max': compositionCode = '    val = max(val, c);'; break;
      case 'min': compositionCode = '    if (i == 0u) { val = c; } else { val = min(val, c); }'; break;
      case 'blend': compositionCode = `    val += c / f32(SOURCE_COUNT);`; break;
      case 'smooth-min':
      default:
        // For field sources (positive contributions), smooth-min gives merging behavior
        // We accumulate additively — this IS the metaball model
        // smooth-min would be for SDF composition; additive is correct for field strengths
        compositionCode = '    val += c;';
        break;
    }

    return `struct FieldSource {
  pos: vec2f,
  strength: f32,
  radius: f32,
  falloff_type: f32,
  _pad: f32,
}

const FIELD_RES = vec2u(${resX}u, ${resY}u);
const SOURCE_COUNT = ${sourceCount}u;
const BLEND_K: f32 = ${blendK.toFixed(6)};

@group(0) @binding(0) var<storage, read> sources: array<FieldSource>;
@group(0) @binding(1) var grid: texture_storage_2d<rgba16float, write>;

fn eval_source(pixel: vec2f, src: FieldSource) -> f32 {
  let d = distance(pixel, src.pos);
  let ft = u32(src.falloff_type);
  if (ft == 0u) { return src.strength / (d * d + 0.001); }
  if (ft == 1u) { return src.strength * exp(-(d * d) / (2.0 * src.radius * src.radius + 0.001)); }
  if (ft == 2u) { return src.strength * exp(-d / max(src.radius, 0.001)); }
  return src.strength * max(0.0, 1.0 - d / max(src.radius, 0.001));
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0);
  return min(a, b) - h * h / (4.0 * k + 0.0001);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FIELD_RES.x || gid.y >= FIELD_RES.y) { return; }
  let pixel = vec2f(f32(gid.x), f32(gid.y));

  var val: f32 = 0.0;
  for (var i = 0u; i < SOURCE_COUNT; i++) {
    let c = eval_source(pixel, sources[i]);
${compositionCode}
  }

  textureStore(grid, vec2i(gid.xy), vec4f(val, 0.0, 0.0, 0.0));
}`;
  }

  _generateFieldVizShader(name, vizAttrs, resX, resY) {
    const A = (k, fb) => this._fieldAttr(vizAttrs, k, fb);
    const mode = A('mode', 'isosurface');
    let vizBody = '';
    let extraConsts = '';

    switch (mode) {
      case 'isosurface': {
        const threshold = +(A('threshold', 0.5));
        const feather = +(A('feather', 2.0));
        const colorIn = this._parseFieldColor(A('color-inside', '#ffffffff'));
        const colorOut = this._parseFieldColor(A('color-outside', '#00000000'));
        extraConsts = `const THRESHOLD: f32 = ${threshold.toFixed(6)};
const FEATHER: f32 = ${(feather * 0.01).toFixed(6)};
const COLOR_IN = vec4f(${this._colorToWgsl(colorIn)});
const COLOR_OUT = vec4f(${this._colorToWgsl(colorOut)});`;
        vizBody = `  let edge = smoothstep(THRESHOLD - FEATHER, THRESHOLD + FEATHER, d);
  var color = mix(COLOR_OUT, COLOR_IN, edge);`;
        break;
      }
      case 'heatmap': {
        const rangeMin = +(A('range-min', 0.0));
        const rangeMax = +(A('range-max', 1.0));
        extraConsts = `const RANGE_MIN: f32 = ${rangeMin.toFixed(6)};
const RANGE_MAX: f32 = ${rangeMax.toFixed(6)};`;
        vizBody = `  let t = clamp((d - RANGE_MIN) / (RANGE_MAX - RANGE_MIN + 0.0001), 0.0, 1.0);
  let r = smoothstep(0.4, 0.7, t) + smoothstep(0.85, 1.0, t) * 0.5;
  let g = smoothstep(0.2, 0.5, t) - smoothstep(0.7, 0.9, t) * 0.5 + smoothstep(0.9, 1.0, t) * 0.5;
  let b = smoothstep(0.0, 0.3, t) - smoothstep(0.5, 0.7, t);
  var color = vec4f(r, g, b, 1.0);`;
        break;
      }
      case 'contour': {
        const density = +(A('density', 5.0));
        const lineColor = this._parseFieldColor(A('line-color', '#ffffffff'));
        const bgColor = this._parseFieldColor(A('bg-color', '#00000044'));
        extraConsts = `const DENSITY: f32 = ${density.toFixed(6)};
const LINE_COLOR = vec4f(${this._colorToWgsl(lineColor)});
const BG_COLOR = vec4f(${this._colorToWgsl(bgColor)});`;
        vizBody = `  let contour = fract(d * DENSITY);
  let line = smoothstep(0.02, 0.0, abs(contour - 0.5));
  var color = mix(BG_COLOR, LINE_COLOR, line);`;
        break;
      }
      case 'dot-grid': {
        const gridSpacing = +(A('grid-spacing', 8.0));
        const baseRadius = +(A('base-radius', 2.0));
        const response = +(A('response', 3.0));
        const scale = +(A('scale', 0.5));
        const dotColor = this._parseFieldColor(A('dot-color', '#888888ff'));
        extraConsts = `const GRID_SPACING: f32 = ${gridSpacing.toFixed(6)};
const BASE_RADIUS: f32 = ${baseRadius.toFixed(6)};
const RESPONSE: f32 = ${response.toFixed(6)};
const SCALE: f32 = ${scale.toFixed(6)};
const DOT_COLOR = vec4f(${this._colorToWgsl(dotColor)});`;
        // dot-grid uses textureLoad instead of textureSampleLevel
        return `const FIELD_RES = vec2u(${resX}u, ${resY}u);
${extraConsts}

@group(0) @binding(0) var grid_samp: sampler;
@group(0) @binding(1) var grid: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FIELD_RES.x || gid.y >= FIELD_RES.y) { return; }
  let grid_pos = vec2f(gid.xy);
  let cell = floor(grid_pos / GRID_SPACING);
  let center = (cell + 0.5) * GRID_SPACING;
  let center_i = clamp(vec2i(center), vec2i(0), vec2i(FIELD_RES) - 1);
  let fv = textureLoad(grid, center_i, 0).r;
  let gx = textureLoad(grid, clamp(center_i + vec2i(1,0), vec2i(0), vec2i(FIELD_RES)-1), 0).r
         - textureLoad(grid, clamp(center_i - vec2i(1,0), vec2i(0), vec2i(FIELD_RES)-1), 0).r;
  let gy = textureLoad(grid, clamp(center_i + vec2i(0,1), vec2i(0), vec2i(FIELD_RES)-1), 0).r
         - textureLoad(grid, clamp(center_i - vec2i(0,1), vec2i(0), vec2i(FIELD_RES)-1), 0).r;
  let grad = vec2f(gx, gy) * 0.5;
  let displaced = center + grad * fv * RESPONSE;
  let dist_to_dot = distance(grid_pos, displaced);
  let dot_radius = BASE_RADIUS * (1.0 + fv * SCALE);
  let alpha = smoothstep(dot_radius, dot_radius - 1.0, dist_to_dot);
  var color = DOT_COLOR * alpha;
  textureStore(output, vec2i(gid.xy), color);
}`;
      }
      case 'refraction': {
        const refractStrength = +(A('refract-strength', 5.0));
        const glowColor = this._parseFieldColor(A('glow-color', '#88ccffaa'));
        extraConsts = `const REFRACT_STRENGTH: f32 = ${refractStrength.toFixed(6)};
const GLOW_COLOR = vec4f(${this._colorToWgsl(glowColor)});`;
        vizBody = `  let gx = textureSampleLevel(grid, grid_samp, uv + vec2f(1.0/f32(FIELD_RES.x), 0.0), 0.0).r
         - textureSampleLevel(grid, grid_samp, uv - vec2f(1.0/f32(FIELD_RES.x), 0.0), 0.0).r;
  let gy = textureSampleLevel(grid, grid_samp, uv + vec2f(0.0, 1.0/f32(FIELD_RES.y)), 0.0).r
         - textureSampleLevel(grid, grid_samp, uv - vec2f(0.0, 1.0/f32(FIELD_RES.y)), 0.0).r;
  let grad = vec2f(gx, gy) * 0.5;
  let mag = length(grad);
  let normal = select(vec2f(0.0), grad / mag, mag > 0.001);
  let view_dot = abs(normal.y);
  let fresnel = pow(1.0 - view_dot, 3.0);
  var color = GLOW_COLOR * fresnel * smoothstep(0.0, 0.3, d);`;
        break;
      }
      case 'gradient':
      default: {
        vizBody = `  let gx = textureSampleLevel(grid, grid_samp, uv + vec2f(1.0/f32(FIELD_RES.x), 0.0), 0.0).r
         - textureSampleLevel(grid, grid_samp, uv - vec2f(1.0/f32(FIELD_RES.x), 0.0), 0.0).r;
  let gy = textureSampleLevel(grid, grid_samp, uv + vec2f(0.0, 1.0/f32(FIELD_RES.y)), 0.0).r
         - textureSampleLevel(grid, grid_samp, uv - vec2f(0.0, 1.0/f32(FIELD_RES.y)), 0.0).r;
  let grad = vec2f(gx, gy) * 0.5;
  let angle = atan2(grad.y, grad.x);
  let mag = length(grad);
  var color = vec4f(cos(angle)*0.5+0.5, sin(angle)*0.5+0.5, mag, 1.0);`;
        break;
      }
    }

    return `const FIELD_RES = vec2u(${resX}u, ${resY}u);
${extraConsts}

@group(0) @binding(0) var grid_samp: sampler;
@group(0) @binding(1) var grid: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FIELD_RES.x || gid.y >= FIELD_RES.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(FIELD_RES);
  let d = textureSampleLevel(grid, grid_samp, uv, 0.0).r;

${vizBody}

  textureStore(output, vec2i(gid.xy), color);
}`;
  }

  _resolveFieldExpr(expr, cfg) {
    if (expr === null || expr === undefined) return 0;
    if (typeof expr === 'number') return expr;
    // Known builtins — scale from normalized [0,1] to field pixel coords
    switch (expr) {
      case 'mouse-x': return this.inputState.mouseX * cfg.resX;
      case 'mouse-y': return this.inputState.mouseY * cfg.resY;
      case 'mouse-dx': return this.inputState.mouseDX;
      case 'mouse-dy': return this.inputState.mouseDY;
      case 'pointer-pressure': return this.inputState.pointerPressure ?? 1.0;
      case 'elapsed': return (performance.now()/1000) - this.startTime;
      default: {
        // Try form state
        if (expr.startsWith('form/')) return +(this.formState[expr.slice(5)] ?? 0);
        return +expr || 0;
      }
    }
  }

  _updateFieldSources() {
    if (!this._fieldConfigs) return;
    for (const [name, cfg] of this._fieldConfigs) {
      if (!cfg.hasDynamic) continue;
      const sb = this._storageBuffers.get(cfg.bufferName);
      if (!sb) continue;
      const dataBytes = cfg.sources.length * 6 * 4;
      if (dataBytes > sb.size) { console.warn(`[RPE] field source data (${dataBytes}B) exceeds buffer "${cfg.bufferName}" (${sb.size}B)`); continue; }
      const data = new Float32Array(cfg.sources.length * 6);
      for (let i = 0; i < cfg.sources.length; i++) {
        const s = cfg.sources[i];
        const off = i * 6;
        data[off]     = s.dynamic ? (s.posXExpr ? this._resolveFieldExpr(s.posXExpr, cfg) : s.posX) : s.posX;
        data[off + 1] = s.dynamic ? (s.posYExpr ? this._resolveFieldExpr(s.posYExpr, cfg) : s.posY) : s.posY;
        data[off + 2] = s.dynamicStrength ? this._resolveFieldExpr(s.strengthExpr, cfg) : s.strength;
        data[off + 3] = s.dynamicRadius ? this._resolveFieldExpr(s.radiusExpr, cfg) : s.radius;
        data[off + 4] = s.falloffType;
        data[off + 5] = 0;
      }
      try { this.device.queue.writeBuffer(sb, 0, data); } catch(e) { console.error(`[RPE] field writeBuffer failed:`, e); }
    }
  }

  _writeFieldDefaults() {
    if (!this._fieldConfigs) return;
    for (const [name, cfg] of this._fieldConfigs) {
      const sb = this._storageBuffers.get(cfg.bufferName);
      if (!sb) continue;
      const dataBytes = cfg.sources.length * 6 * 4;
      if (dataBytes > sb.size) { console.warn(`[RPE] field defaults data (${dataBytes}B) exceeds buffer "${cfg.bufferName}" (${sb.size}B)`); continue; }
      const data = new Float32Array(cfg.sources.length * 6);
      for (let i = 0; i < cfg.sources.length; i++) {
        const s = cfg.sources[i];
        data[i*6]     = s.posX;
        data[i*6 + 1] = s.posY;
        data[i*6 + 2] = s.strength;
        data[i*6 + 3] = s.radius;
        data[i*6 + 4] = s.falloffType;
        data[i*6 + 5] = 0;
      }
      try { this.device.queue.writeBuffer(sb, 0, data); } catch(e) { console.error(`[RPE] field defaults writeBuffer failed:`, e); }
    }
  }

  // ── Shader Module Linking ──
  // Namespace isolation, selective imports, tree-shaking, structural hash caching.
  // Adapted from use.gpu link.ts.

  _hashWgsl(code) {
    // FNV-1a 32-bit hash
    let h = 0x811c9dc5;
    for (let i = 0; i < code.length; i++) {
      h ^= code.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  _resolveImports(code) {
    // Parse #import and #link directives, returning clean code + import list + link list
    // Supports: #import name          (whole module)
    //           #import name { a, b } (selective)
    //           #link symbolName       (cross-module symbol resolution — search all libs for exported symbol)
    const imports = [];
    const links = [];
    const cleanCode = code.replace(/^[ \t]*#(import|link)\s+(\S+)(?:\s*\{([^}]+)\})?\s*$/gm, (_, directive, name, selectors) => {
      if (directive === 'link') {
        // #link symbolName — resolve from any lib that exports it
        links.push(name);
      } else {
        const symbols = selectors ? selectors.split(',').map(s => s.trim()).filter(Boolean) : null;
        imports.push({ name, symbols });
      }
      return '';
    });
    return { imports, links, cleanCode };
  }

  _parseWgslDeclarations(code) {
    // Extract top-level WGSL declarations: fn, var, const, struct, let
    // Returns Map<name, {kind, start, end, body, exported, link, optional, infer, global}>
    // Attribute prefixes: @export (visible for cross-module #link), @link (slot to be filled),
    //   @optional (link slot with fallback body), @infer (type inferred from linked module),
    //   @global (no namespace prefixing)
    const decls = new Map();
    // Match fn declarations with body (optional attribute prefixes)
    const attrPat = '(?:@(?:export|link|optional|infer|global)\\s+)*';
    const fnRe = new RegExp('^(' + attrPat + ')(fn\\s+(\\w+)\\s*\\([^)]*\\)(?:\\s*->\\s*[^{]+)?\\s*\\{)', 'gm');
    let m;
    while ((m = fnRe.exec(code)) !== null) {
      const attrs = m[1].trim();
      const exported = attrs.includes('@export');
      const link = attrs.includes('@link');
      const optional = attrs.includes('@optional');
      const infer = attrs.includes('@infer');
      const global = attrs.includes('@global');
      const name = m[3];
      const start = m.index;
      // Find matching closing brace
      let depth = 1, pos = m.index + m[0].length;
      while (pos < code.length && depth > 0) {
        if (code[pos] === '{') depth++;
        else if (code[pos] === '}') depth--;
        pos++;
      }
      const body = code.slice(start, pos);
      // Store body without attribute prefixes for clean emission
      const cleanBody = body.replace(/^(?:@(?:export|link|optional|infer|global)\s+)+/, '');
      decls.set(name, { kind: 'fn', start, end: pos, body: cleanBody, exported, link, optional, infer, global });
    }
    // Match var/const/let/override declarations (optional attribute prefixes)
    const varRe = new RegExp('^(' + attrPat + ')((?:var|const|let|override)\\s*(?:<[^>]+>)?\\s+(\\w+)\\s*(?::\\s*[^=;]+)?(?:\\s*=[^;]*)?;)', 'gm');
    while ((m = varRe.exec(code)) !== null) {
      const attrs = m[1].trim();
      const exported = attrs.includes('@export');
      const global = attrs.includes('@global');
      const name = m[3];
      if (!decls.has(name)) {
        decls.set(name, { kind: 'var', start: m.index, end: m.index + m[0].length, body: m[2], exported, global });
      }
    }
    // Match struct declarations (optional attribute prefixes)
    const structRe = new RegExp('^(' + attrPat + ')(struct\\s+(\\w+)\\s*\\{[^}]*\\})', 'gm');
    while ((m = structRe.exec(code)) !== null) {
      const attrs = m[1].trim();
      const exported = attrs.includes('@export');
      const global = attrs.includes('@global');
      const name = m[3];
      if (!decls.has(name)) {
        decls.set(name, { kind: 'struct', start: m.index, end: m.index + m[0].length, body: m[2], exported, global });
      }
    }
    return decls;
  }

  _buildUsageGraph(decls) {
    // For each declaration, find which other declarations it references
    const graph = new Map(); // name → Set<name>
    const allNames = [...decls.keys()];
    for (const [name, decl] of decls) {
      const refs = new Set();
      for (const other of allNames) {
        if (other === name) continue;
        // Check if `other` appears as a word in this declaration's body
        const re = new RegExp('\\b' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (re.test(decl.body)) refs.add(other);
      }
      graph.set(name, refs);
    }
    return graph;
  }

  _shakeModule(code, decls, usedSymbols) {
    // Remove unused top-level declarations via reachability from usedSymbols
    const graph = this._buildUsageGraph(decls);
    const reachable = new Set();
    const walk = (name) => {
      if (reachable.has(name)) return;
      reachable.add(name);
      const refs = graph.get(name);
      if (refs) for (const r of refs) walk(r);
    };
    for (const s of usedSymbols) walk(s);

    // Remove unreachable declarations (in reverse order to preserve offsets)
    const toRemove = [];
    for (const [name, decl] of decls) {
      if (!reachable.has(name)) toRemove.push(decl);
    }
    toRemove.sort((a, b) => b.start - a.start); // reverse order
    let result = code;
    for (const decl of toRemove) {
      result = result.slice(0, decl.start) + result.slice(decl.end);
    }
    // Strip @export markers from output (they're metadata, not valid WGSL)
    result = result.replace(/^@export\s+/gm, '');
    return result;
  }

  _namespaceModule(code, ns, decls, globalTypes) {
    // Prefix all non-global symbols with namespace _XX_
    let result = code;
    for (const [name, decl] of decls) {
      if (globalTypes.has(name)) continue; // struct types shared globally
      if (decl.global) continue; // @global vars skip namespace prefixing
      const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      result = result.replace(re, ns + name);
    }
    return result;
  }

  _linkShader(code, shaderName) {
    const { imports, links, cleanCode } = this._resolveImports(code);
    const hasSlotDecls = /@(?:link|optional|infer)\s+fn\s/.test(code);
    if (imports.length === 0 && links.length === 0 && !hasSlotDecls) return code; // no imports/links/slots, pass through

    let linked = cleanCode;
    let uniformEmitted = false;
    const hasManualU = /var\s*<\s*uniform\s*>\s*u\s*:/.test(code);
    const preambles = [];
    const aliases = []; // [{from, to}] — rename namespaced symbols for selective imports

    // Collect all struct type names as globals (shared, not namespaced)
    const globalTypes = new Set();
    for (const [name] of this._wgslStructs) globalTypes.add(name);

    for (const imp of imports) {
      // Struct import (from @struct nodes) — auto-generates binding boilerplate
      if (this._wgslStructs.has(imp.name)) {
        const structWgsl = this._wgslStructs.get(imp.name);
        if (!uniformEmitted && !hasManualU) {
          uniformEmitted = true;
          // Support custom group/binding via import syntax: #import StructName { @group=1, @binding=2 }
          const groupIdx = imp.symbols?.find(s => s.startsWith('@group='));
          const bindIdx = imp.symbols?.find(s => s.startsWith('@binding='));
          const group = groupIdx ? groupIdx.split('=')[1] : '0';
          const binding = bindIdx ? bindIdx.split('=')[1] : '0';
          preambles.push(`${structWgsl}\n@group(${group}) @binding(${binding}) var<uniform> u: ${imp.name};`);
        } else {
          preambles.push(structWgsl);
        }
        continue;
      }

      // Lib import (from @lib nodes)
      if (this._wgslLibs.has(imp.name)) {
        let libCode = this._wgslLibs.get(imp.name);
        const decls = this._parseWgslDeclarations(libCode);

        // Tree-shake if selective import
        if (imp.symbols) {
          libCode = this._shakeModule(libCode, decls, new Set(imp.symbols));
        }

        // Namespace isolation
        const ns = `_${(this._nsCounter++).toString(36).padStart(2, '0')}_`;
        const namespacedDecls = this._parseWgslDeclarations(libCode); // re-parse after shaking
        const namespacedCode = this._namespaceModule(libCode, ns, namespacedDecls, globalTypes);

        // Build aliases for imported symbols → namespaced versions
        if (imp.symbols) {
          for (const sym of imp.symbols) {
            if (namespacedDecls.has(sym)) {
              aliases.push({ from: ns + sym, to: sym });
            }
          }
        } else {
          // Whole-module import: alias all declarations back to original names
          for (const [name] of namespacedDecls) {
            if (!globalTypes.has(name)) {
              aliases.push({ from: ns + name, to: name });
            }
          }
        }

        preambles.push(namespacedCode);
        continue;
      }

      // Not found
      this.log(`shader "${shaderName}": #import ${imp.name} not found`, 'warn');
      preambles.push(`// #import ${imp.name} \u2014 NOT FOUND`);
    }

    // Resolve #link directives: search all libs for exported symbols
    for (const linkSym of links) {
      let found = false;
      for (const [libName, libCode] of this._wgslLibs) {
        const decls = this._parseWgslDeclarations(libCode);
        const decl = decls.get(linkSym);
        if (decl && decl.exported) {
          // Tree-shake: extract symbol + transitive deps
          const shakenCode = this._shakeModule(libCode, decls, new Set([linkSym]));
          const shakenDecls = this._parseWgslDeclarations(shakenCode);
          const ns = `_${(this._nsCounter++).toString(36).padStart(2, '0')}_`;
          const namespacedCode = this._namespaceModule(shakenCode, ns, shakenDecls, globalTypes);
          // Alias the linked symbol back to its original name
          aliases.push({ from: ns + linkSym, to: linkSym });
          preambles.push(namespacedCode);
          found = true;
          break;
        }
      }
      if (!found) {
        this.log(`shader "${shaderName}": #link ${linkSym} not found in any lib`, 'warn');
        preambles.push(`// #link ${linkSym} \u2014 NOT FOUND`);
      }
    }

    // Apply aliases: replace original symbol names in the shader body with namespaced versions
    for (const { from, to } of aliases) {
      const re = new RegExp('\\b' + to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      linked = linked.replace(re, from);
    }

    let result = preambles.join('\n\n') + '\n\n' + linked;

    // ── Resolve @link / @optional / @infer slot declarations in the shader body ──
    // Scan the assembled shader for @link fn declarations and fill them from preambles
    const finalDecls = this._parseWgslDeclarations(result);
    for (const [name, decl] of finalDecls) {
      if (!decl.link && !decl.optional && !decl.infer) continue;
      // Search preambles for an exported implementation of this symbol
      let implFound = false;
      for (const [libName, libCode] of this._wgslLibs) {
        const libDecls = this._parseWgslDeclarations(libCode);
        const impl = libDecls.get(name);
        if (impl && impl.exported) {
          // Extract implementation + transitive deps, namespace, prepend
          const shakenCode = this._shakeModule(libCode, libDecls, new Set([name]));
          const shakenDecls = this._parseWgslDeclarations(shakenCode);
          const ns = `_${(this._nsCounter++).toString(36).padStart(2, '0')}_`;
          const namespacedCode = this._namespaceModule(shakenCode, ns, shakenDecls, globalTypes);
          // Replace the @link slot declaration with the implementation
          // The slot body gets replaced; the namespaced impl is prepended
          const slotRe = new RegExp('(?:@(?:link|optional|infer)\\s+)+fn\\s+' + name + '\\s*\\([^)]*\\)(?:\\s*->\\s*[^{]+)?\\s*\\{[^}]*\\}');
          if (slotRe.test(result)) {
            // For @infer: extract return type from implementation signature
            const implSig = impl.body.match(/fn\s+\w+\s*\([^)]*\)(?:\s*->\s*([^{]+?))\s*\{/);
            const implRetType = implSig ? implSig[1].trim() : null;
            // Remove the slot declaration from result (impl replaces it)
            result = result.replace(slotRe, '');
            // Prepend implementation (with namespace)
            result = namespacedCode + '\n' + result;
            // Alias: the namespaced name should be callable as the original name
            const aliasRe = new RegExp('\\b' + name + '\\b', 'g');
            result = result.replace(aliasRe, ns + name);
            // But un-namespace the declaration itself
            result = result.replace(new RegExp('\\b' + ns + ns + name + '\\b', 'g'), ns + name);
          }
          implFound = true;
          break;
        }
      }
      if (!implFound && decl.link && !decl.optional) {
        // Required @link slot not filled — warn
        this.log(`shader "${shaderName}": @link slot "${name}" not filled by any lib`, 'warn');
      }
      if (!implFound && (decl.optional || decl.infer)) {
        // @optional: keep the fallback body, just strip the attribute prefix
        result = result.replace(/(?:@(?:optional|infer)\s+)+fn\s+/g, 'fn ');
      }
    }
    // Clean any remaining @link/@optional/@infer markers
    result = result.replace(/^@(?:link|optional|infer|global)\s+/gm, '');

    return result;
  }

  _compileShaders(tree) {
    this._shaderEntries = new Map();
    this._nsCounter = 0; // reset namespace counter per compile cycle

    // Pre-parse lib symbols for diagnostics
    this._wgslLibSymbols = new Map();
    for (const [name, code] of this._wgslLibs) {
      const decls = this._parseWgslDeclarations(code);
      this._wgslLibSymbols.set(name, new Set(decls.keys()));
      // Track lib content hash for cache invalidation
      this._libHashes.set(name, this._hashWgsl(code));
    }

    for (const s of Rex.findAll(tree,'shader')) {
      const key = s.name || s.type;
      let code = s.content?.trim();
      if (!code) { this.log(`shader "${key}" has no content`,'warn'); continue; }

      // Link: resolve imports with namespace isolation + tree-shaking
      code = this._linkShader(code, key);

      // Auto-inject WGSL feature enables
      const enables = [];
      if (this._features.has('shader-f16') && /\bf16\b/.test(code)) enables.push('enable f16;');
      if (this._features.has('subgroups') && /subgroup/.test(code)) enables.push('enable subgroups;');
      if (this._features.has('subgroups-f16') && /subgroup/.test(code) && /\bf16\b/.test(code)) enables.push('enable subgroups_f16;');
      if (this._features.has('clip-distances') && /clip_distances/.test(code)) enables.push('enable clip_distances;');
      if (this._features.has('dual-source-blending') && /blend_src/.test(code)) enables.push('enable dual_source_blending;');
      if (enables.length > 0) code = enables.join('\n') + '\n' + code;

      // Structural hash cache — reuse GPUShaderModule if WGSL unchanged
      const hash = this._hashWgsl(code);
      const cached = this._shaderHashCache.get(hash);
      if (cached) {
        this.shaderModules.set(key, cached);
        this._lastGoodShaders.set(key, code);
        this.log(`shader: ${key} \u2713 (cached)`,'ok');
        continue;
      }

      try {
        const mod = this.device.createShaderModule({code});
        // Catch async WGSL compile errors (deferred by the browser)
        if (mod.getCompilationInfo) {
          mod.getCompilationInfo().then(info => {
            for (const msg of info.messages) {
              if (msg.type === 'error') {
                console.error(`[SHADER] "${key}" line ${msg.lineNum}: ${msg.message}`);
                this.log(`shader "${key}" line ${msg.lineNum}: ${msg.message}`, 'err');
              }
              else if (msg.type === 'warning') this.log(`shader "${key}" line ${msg.lineNum}: ${msg.message}`, 'warn');
            }
          });
        }
        this.shaderModules.set(key, mod);
        this._shaderHashCache.set(hash, mod);
        this._lastGoodShaders.set(key, code);
        this.log(`shader: ${key} \u2713`,'ok');
      } catch(e) {
        this.log(`shader "${key}": ${e.message}`,'err');
        if (this.shaderModules.has(key)) {
          this.log(`shader "${key}": using last-good module`,'warn');
        } else {
          this.log(`shader "${key}": no fallback available`,'err');
        }
      }
    }
  }

  _compileHeapLayout(tree) {
    this._heapLayout = new Map();
    let heapOffset = 0;
    for (const b of Rex.findAll(tree,'buffer')) {
      if (b.attrs.usage && Array.isArray(b.attrs.usage) && b.attrs.usage.includes('storage')) continue;
      const sd = this._structs.get(b.attrs.struct);
      const size = b.attrs.size || (sd ? sd.size : 256);
      heapOffset = Math.ceil(heapOffset / 256) * 256;
      this._heapLayout.set(b.name, { offset: heapOffset, size, structDef: sd, structName: b.attrs.struct });
      this.log(`heap: "${b.name}" @ offset ${heapOffset}, ${size}B`,'cmd');
      heapOffset += size;
    }
    this._heapSize = Math.max(Math.ceil(heapOffset / 256) * 256, 256);
    // Generate virtual heap accessor lib
    this._generateHeapAccessors();
  }

  _generateHeapAccessors() {
    // Generate WGSL accessor functions for each field in each heap buffer.
    // Shaders can `#import heap { get_camera_x, get_camera_y }` to access heap fields.
    const lines = [];
    for (const [bufName, hl] of this._heapLayout) {
      if (!hl.structDef) continue;
      for (const field of hl.structDef.layout) {
        const fnName = `get_${bufName}_${field.name}`;
        const wgslType = this._toWGSL(field.type);
        const byteOffset = hl.offset + field.offset;
        // Generate accessor that reads from the uniform buffer at the compiled byte offset
        // Note: actual binding depends on shader context — this generates the read logic
        lines.push(`@export fn ${fnName}() -> ${wgslType} { return u.${field.name}; }`);
      }
    }
    if (lines.length > 0) {
      this._wgslLibs.set('heap', lines.join('\n'));
    }
  }

  _compileOptics(tree) {
    this._optics = [];
    this._formOptics = new Map();
    this._builtinOptics = [];

    for (const b of Rex.findAll(tree,'buffer')) {
      const hl = this._heapLayout.get(b.name);
      if (!hl || !hl.structDef) continue;

      const dataNode = Rex.find(b, 'data');
      const src = dataNode ? dataNode.attrs : b.attrs;

      for (const field of hl.structDef.layout) {
        const val = src[field.name];
        const absOffset = hl.offset + field.offset;
        const optic = { heapOffset: absOffset, type: field.type, fieldName: field.name, bufferName: b.name };

        if (val && typeof val === 'object' && val.expr) {
          const expr = val.expr;
          if (expr.startsWith('form/')) {
            const formKey = expr.slice(5);
            optic.source = 'form'; optic.key = formKey;
            if (!this._formOptics.has(formKey)) this._formOptics.set(formKey, []);
            this._formOptics.get(formKey).push({ heapOffset: absOffset, type: field.type });
          } else {
            optic.source = 'builtin'; optic.key = expr;
            // Pre-compile expression and detect special compound optics
            const special =
              expr === 'canvas-size' ? 1 :
              expr === 'mouse-pos' ? 2 :
              expr === 'mouse-delta' ? 3 :
              expr === 'move-dir' ? 4 : 0;
            const compiled = special === 0 ? Rex.compileExpr(val) : null;
            this._builtinOptics.push({ heapOffset: absOffset, type: field.type, expr, special, compiled });
          }
        } else if (val !== undefined) {
          optic.source = 'const'; optic.constVal = val;
        } else {
          optic.source = 'const'; optic.constVal = 0;
        }
        this._optics.push(optic);
      }
    }

    this.log(`optics: ${this._formOptics.size} form paths, ${this._builtinOptics.length} builtins, ${this._optics.length} total`,'ok');
  }

  // Build a GPU evaluation context for Rex.evalExpr — resolves builtins + form refs
  _makeGpuEvalContext(builtins) {
    const formState = this.formState;
    return {
      resolve(op, key, args) {
        if (op === 'ident') return builtins[key] !== undefined ? builtins[key] : Number(key) || 0;
        if (op === 'slot') {
          // /form/key → form state lookup
          if (key.startsWith('form/')) return formState[key.slice(5)] ?? 0;
          return builtins[key] !== undefined ? builtins[key] : 0;
        }
        if (op === 'dep') return builtins[key] !== undefined ? builtins[key] : 0;
        // Zero-arg call: treat as ident (handles `(move-x)`, `(elapsed)`, etc.)
        if (op === 'call' && (!args || args.length === 0)) {
          if (key.startsWith('form/')) return formState[key.slice(5)] ?? 0;
          return builtins[key] !== undefined ? builtins[key] : 0;
        }
        return undefined;
      }
    };
  }

  _allocateHeap(tree) {
    if (this._heapBuffer) { this._heapBuffer.destroy(); this._heapBuffer = null; }
    this._bindGroups.clear();
    if (this._heapSize === 0) return;
    this._heapBuffer = this.device.createBuffer({
      size: this._heapSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._stagingBuffers = [new ArrayBuffer(this._heapSize), new ArrayBuffer(this._heapSize)];
    this._stagingViews = [new DataView(this._stagingBuffers[0]), new DataView(this._stagingBuffers[1])];
    this._writeSlot = 0;
    this._heapView = this._stagingViews[0];
    this.log(`heap allocated: ${this._heapSize}B (1 GPU + 2 staging)`,'ok');
    this._buildHeapInfo();
  }

  // ── Storage buffers ──
  _compileStorageBuffers(tree) {
    for (const [,sb] of this._storageBuffers) sb.destroy();
    this._storageBuffers.clear();
    for (const b of Rex.findAll(tree,'buffer')) {
      if (b._d >= 2) continue; // Skip resource-scope children — they're binding references, not definitions
      const usage = b.attrs.usage;
      if (!usage || !Array.isArray(usage) || !usage.includes('storage')) continue;
      const size = b.attrs.size || 1024;
      let gpuUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      if (usage.includes('indirect')) gpuUsage |= GPUBufferUsage.INDIRECT;
      const gpuBuf = this.device.createBuffer({ size, usage: gpuUsage });
      this._storageBuffers.set(b.name, gpuBuf);
      // Write initial f32 values from @data :f0 v :f1 v ... (byte offset = index*4)
      const dataNode = b.children.find(c => c.type === 'data');
      if (dataNode) {
        const maxFloats = size / 4;
        const initBuf = new Float32Array(maxFloats);
        const keys = Object.keys(dataNode.attrs);
        for (let ki = 0; ki < keys.length && ki < maxFloats; ki++) {
          const v = Rex.evalExpr(Rex.compileExpr(dataNode.attrs[keys[ki]]), { resolve: () => 0 });
          if (typeof v === 'number') initBuf[ki] = v;
        }
        try {
          this.device.queue.writeBuffer(gpuBuf, 0, initBuf);
        } catch(e) {
          console.error(`[RPE] storage init writeBuffer failed for "${b.name}":`, e);
        }
      }
      this.log(`storage buffer: "${b.name}" ${size}B${usage.includes('indirect')?' [indirect]':''}`,'ok');
    }
    this.log(`storage buffers compiled: [${[...this._storageBuffers.keys()].join(', ')}]`,'ok');
  }

  // ── Textures ──
  _compileTextures(tree) {
    for (const [,t] of this._textures) t.destroy();
    this._textures.clear();
    this._textureViews = new Map(); // Phase 3A: cached texture views
    this._samplers.clear();
    const generation = ++this._loadGeneration;

    for (const tex of Rex.findAll(tree, 'texture')) {
      // Skip resource-scope children (_d >= 2) — they're binding references, not definitions
      if (tex._d >= 2) continue;
      const name = tex.name;

      // View-of: create a view referencing another texture
      if (tex.attrs['view-of']) {
        const parentTex = this._textures.get(tex.attrs['view-of']);
        if (!parentTex) { this.log(`texture "${name}": view-of "${tex.attrs['view-of']}" not found`,'err'); continue; }
        const viewDesc = {};
        if (tex.attrs['base-mip-level'] !== undefined) viewDesc.baseMipLevel = +tex.attrs['base-mip-level'];
        if (tex.attrs['mip-level-count'] !== undefined) viewDesc.mipLevelCount = +tex.attrs['mip-level-count'];
        if (tex.attrs['base-array-layer'] !== undefined) viewDesc.baseArrayLayer = +tex.attrs['base-array-layer'];
        if (tex.attrs['array-layer-count'] !== undefined) viewDesc.arrayLayerCount = +tex.attrs['array-layer-count'];
        if (tex.attrs['view-dimension']) viewDesc.dimension = tex.attrs['view-dimension'];
        this._textures.set(name, parentTex); // share same GPUTexture
        this._textureViews.set(name, parentTex.createView(viewDesc));
        this.log(`texture: "${name}" view-of "${tex.attrs['view-of']}"`,'ok');
        continue;
      }

      // Video textures — handled per-frame
      if (tex.attrs.type === 'video' || tex.attrs.video) {
        const videoId = tex.attrs['video-element'] || tex.attrs.video;
        this._videoTextures.set(name, { elementId: videoId, name });
        this.log(`texture: "${name}" [video: ${videoId}]`,'ok');
        continue;
      }

      const fmt = tex.attrs.format || 'rgba8unorm';
      const isDepth = fmt.startsWith('depth');
      const hasSrc = !!tex.attrs.src && !isDepth;
      const w = tex.attrs.width || (hasSrc ? 4 : 256);
      const h = tex.attrs.height || (hasSrc ? 4 : 256);
      const wantMips = tex.attrs.mipmaps === true;
      const mipLevelCount = wantMips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : +(tex.attrs['mip-levels'] || 1);
      const dim = tex.attrs.dimension || '2d';
      const depthOrArrayLayers = +(tex.attrs['array-layers'] || tex.attrs['depth-layers'] || 1);
      const isTransient = tex.attrs.transient === true;
      const sampleCount = +(tex.attrs['sample-count'] || 1);
      const usage = (isTransient ? 0 : (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST)) |
                    (tex.attrs.render || wantMips ? GPUTextureUsage.RENDER_ATTACHMENT : 0) |
                    (tex.attrs.storage ? GPUTextureUsage.STORAGE_BINDING : 0) |
                    (isTransient ? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TRANSIENT_ATTACHMENT) : 0);

      const texDesc = {
        size: { width: w, height: h, depthOrArrayLayers },
        format: fmt, usage, mipLevelCount,
        dimension: (dim === '2d-array' || dim === 'cube' || dim === 'cube-array') ? '2d' : dim,
      };
      if (sampleCount > 1) texDesc.sampleCount = sampleCount;

      const gpuTex = this.device.createTexture(texDesc);
      this._textures.set(name, gpuTex);

      // Build view descriptor
      const viewDesc = {};
      if (tex.attrs['view-dimension']) viewDesc.dimension = tex.attrs['view-dimension'];
      else if (dim === '2d-array') viewDesc.dimension = '2d-array';
      else if (dim === 'cube') viewDesc.dimension = 'cube';
      else if (dim === 'cube-array') viewDesc.dimension = 'cube-array';
      if (tex.attrs['base-mip-level'] !== undefined) viewDesc.baseMipLevel = +tex.attrs['base-mip-level'];
      if (tex.attrs['mip-level-count'] !== undefined) viewDesc.mipLevelCount = +tex.attrs['mip-level-count'];
      if (tex.attrs['base-array-layer'] !== undefined) viewDesc.baseArrayLayer = +tex.attrs['base-array-layer'];
      if (tex.attrs['array-layer-count'] !== undefined) viewDesc.arrayLayerCount = +tex.attrs['array-layer-count'];
      this._textureViews.set(name, gpuTex.createView(Object.keys(viewDesc).length ? viewDesc : undefined));

      // Create matching sampler
      const filterMode = tex.attrs.filter || 'linear';
      const addressMode = tex.attrs.wrap || 'repeat';
      const aniso = +(tex.attrs.anisotropy || tex.attrs['max-anisotropy'] || 1);
      const mipFilter = tex.attrs['mipmap-filter'] || (aniso > 1 ? 'linear' : 'nearest');
      const compareFunc = tex.attrs.compare; // 'less', 'greater', 'equal', etc.
      if (aniso > 1 && filterMode !== 'linear') this.log(`texture "${name}": anisotropy requires linear filtering`,'warn');
      const samplerDesc = {
        magFilter: filterMode, minFilter: filterMode,
        mipmapFilter: mipFilter,
        addressModeU: addressMode, addressModeV: addressMode,
        addressModeW: tex.attrs['wrap-w'] || addressMode,
      };
      if (aniso > 1) samplerDesc.maxAnisotropy = Math.min(aniso, 16);
      if (compareFunc) samplerDesc.compare = compareFunc;
      if (tex.attrs['lod-min'] !== undefined) samplerDesc.lodMinClamp = +tex.attrs['lod-min'];
      if (tex.attrs['lod-max'] !== undefined) samplerDesc.lodMaxClamp = +tex.attrs['lod-max'];
      const sampler = this.device.createSampler(samplerDesc);
      this._samplers.set(name, { sampler, comparison: !!compareFunc });

      // Fill strategy
      if (hasSrc) {
        const resolvedSrc = this._resolveAssetSource(tex.attrs.src);
        if (resolvedSrc) {
          if (!isDepth) this._fillPlaceholder(gpuTex, w, h);
          this._loadTextureAsync(name, resolvedSrc, tex.attrs, generation);
        }
      } else if (tex.attrs.fill === 'checkerboard') {
        this._fillCheckerboard(gpuTex, w, h);
      } else if (tex.attrs.fill === 'noise') {
        this._fillNoise(gpuTex, w, h);
      }

      // Generate mipmaps for non-async textures
      if (wantMips && !hasSrc && !isDepth) this._generateMipmaps(gpuTex, w, h, fmt);

      const extras = [];
      if (wantMips) extras.push(`${mipLevelCount} mips`);
      if (depthOrArrayLayers > 1) extras.push(`${depthOrArrayLayers} layers`);
      if (sampleCount > 1) extras.push(`${sampleCount}x MSAA`);
      if (isTransient) extras.push('transient');
      if (aniso > 1) extras.push(`aniso ${aniso}`);
      if (compareFunc) extras.push(`compare: ${compareFunc}`);
      this.log(`texture: "${name}" ${w}x${h} ${fmt}${hasSrc?' [loading]':''}${extras.length?' ['+extras.join(', ')+']':''}`,'ok');
    }
  }

  _resolveAssetSource(src) {
    if (typeof src !== 'string') return null;
    if (src.startsWith('data:')) return src;
    if (src.startsWith('http://') || src.startsWith('https://')) return src;
    if (src.startsWith('shrine://')) {
      this.log(`asset: Shrine paths not yet resolved: ${src}`,'warn');
      return null;
    }
    return src;
  }

  _fillPlaceholder(tex, w, h) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i+1] = 0; data[i+2] = 255; data[i+3] = 255;
    }
    this.device.queue.writeTexture({texture:tex}, data, {bytesPerRow:w*4}, [w,h]);
  }

  async _loadTextureAsync(name, src, attrs, generation) {
    try {
      const resp = await fetch(src);
      if (!resp.ok) { this.log(`texture "${name}": fetch failed (${resp.status})`,'err'); return; }
      const blob = await resp.blob();
      const bmpOpts = { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' };
      if (attrs.width) bmpOpts.resizeWidth = attrs.width;
      if (attrs.height) bmpOpts.resizeHeight = attrs.height;
      const bitmap = await createImageBitmap(blob, bmpOpts);
      if (this._loadGeneration !== generation) { bitmap.close(); return; }

      const oldTex = this._textures.get(name);
      if (oldTex) oldTex.destroy();

      const w = bitmap.width, h = bitmap.height;
      const fmt = attrs.format || 'rgba8unorm';
      const wantMips = attrs.mipmaps === true;
      const mipLevelCount = wantMips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : +(attrs['mip-levels'] || 1);
      const newTex = this.device.createTexture({
        size: [w, h], format: fmt, mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               (attrs.render || wantMips ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap }, { texture: newTex }, [w, h]
      );
      bitmap.close();
      if (wantMips) this._generateMipmaps(newTex, w, h, fmt);
      this._textures.set(name, newTex);
      this._bindGroups.clear();
      this._frameDirty = true;
      this.log(`texture "${name}": loaded ${w}x${h}`,'ok');
    } catch (e) {
      this.log(`texture "${name}": load error: ${e.message}`,'err');
    }
  }

  _fillCheckerboard(tex, w, h) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = ((x >> 4) ^ (y >> 4)) & 1 ? 200 : 40;
      data[i] = c; data[i+1] = c; data[i+2] = c; data[i+3] = 255;
    }
    this.device.queue.writeTexture({texture:tex}, data, {bytesPerRow:w*4}, [w,h]);
  }

  _fillNoise(tex, w, h) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255 | 0;
      data[i] = v; data[i+1] = v; data[i+2] = v; data[i+3] = 255;
    }
    this.device.queue.writeTexture({texture:tex}, data, {bytesPerRow:w*4}, [w,h]);
  }

  _generateMipmaps(texture, width, height, format) {
    if (!this._mipPipeline) {
      const mod = this.device.createShaderModule({ code: `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return VSOut(vec4f(uv * 2.0 - 1.0, 0.0, 1.0), vec2f(uv.x, 1.0 - uv.y));
}
@fragment fn fs(v: VSOut) -> @location(0) vec4f {
  return textureSample(t, s, v.uv);
}` });
      this._mipPipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this._mipSampler = this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    }
    const enc = this.device.createCommandEncoder();
    const mipCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    for (let level = 1; level < mipCount; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: this._mipPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this._mipSampler },
          { binding: 1, resource: srcView },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: {r:0,g:0,b:0,a:0} }],
      });
      pass.setPipeline(this._mipPipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }

  // ── Vertex / Index buffers ──
  _compileVertexBuffers(tree) {
    for (const [,vb] of this._vertexBuffers) vb.destroy();
    this._vertexBuffers.clear();
    for (const [,ib] of this._indexBuffers) ib.destroy();
    this._indexBuffers.clear();

    for (const vb of Rex.findAll(tree, 'vertex-buffer')) {
      const name = vb.name;
      const dataAttr = vb.attrs.data;
      let floatData;
      if (Array.isArray(dataAttr)) {
        floatData = new Float32Array(dataAttr.map(Number));
      } else {
        floatData = new Float32Array(0);
      }
      const gpuBuf = this.device.createBuffer({
        size: Math.max(floatData.byteLength, 16),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(gpuBuf.getMappedRange()).set(floatData);
      gpuBuf.unmap();
      this._vertexBuffers.set(name, gpuBuf);
      this.log(`vertex-buffer: "${name}" ${floatData.length} floats`,'ok');
    }

    for (const ib of Rex.findAll(tree, 'index-buffer')) {
      const name = ib.name;
      const dataAttr = ib.attrs.data;
      let indexData;
      if (Array.isArray(dataAttr)) {
        indexData = new Uint32Array(dataAttr.map(Number));
      } else {
        indexData = new Uint32Array(0);
      }
      const gpuBuf = this.device.createBuffer({
        size: Math.max(indexData.byteLength, 16),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(gpuBuf.getMappedRange()).set(indexData);
      gpuBuf.unmap();
      this._indexBuffers.set(name, gpuBuf);
      this.log(`index-buffer: "${name}" ${indexData.length} indices`,'ok');
    }
  }

  // ── Resource scopes: @resources → shared GPUBindGroupLayout + GPUBindGroup ──
  // ── Bind Group Auto-Generation ──
  // Parse WGSL binding declarations to auto-generate GPUBindGroupLayout + GPUBindGroup.
  // Adapted from use.gpu bindgroup.ts — duck-types binding sources by WGSL var type.

  _autoResourceScope(res) {
    // Find which shader(s) this resource scope serves
    const shaderNames = [];
    for (const child of res.children) {
      if (child.type === 'shader' || child.type === 'pipeline') {
        const sn = child.name || child.attrs.shader || child.attrs.vertex || child.attrs.fragment || child.attrs.compute;
        if (sn) shaderNames.push(sn);
      }
    }
    // Also check :shader attribute on the @resources node itself
    const attrShader = res.attrs.shader;
    if (attrShader) {
      if (Array.isArray(attrShader)) shaderNames.push(...attrShader);
      else shaderNames.push(attrShader);
    }

    if (shaderNames.length === 0) {
      this.log(`resources "${res.name}": :auto requires @shader children or :shader attr`, 'warn');
      return;
    }

    // Parse WGSL binding declarations from all referenced shaders
    const bindingRe = /@group\(\d+\)\s*@binding\((\d+)\)\s*var\s*<([^>]+)>\s*(\w+)\s*:\s*([^;]+);/g;
    const bindingMap = new Map(); // slot → {varType, varName, wgslType}
    let visibility = 0;

    for (const sn of shaderNames) {
      const wgsl = this._lastGoodShaders.get(sn);
      if (!wgsl) {
        this.log(`resources "${res.name}": shader "${sn}" not found for auto-gen`, 'warn');
        continue;
      }

      // Detect shader stages for visibility
      if (/@vertex\s+fn\b/.test(wgsl)) visibility |= GPUShaderStage.VERTEX;
      if (/@fragment\s+fn\b/.test(wgsl)) visibility |= GPUShaderStage.FRAGMENT;
      if (/@compute\s+fn\b/.test(wgsl)) visibility |= GPUShaderStage.COMPUTE;

      let m;
      bindingRe.lastIndex = 0;
      while ((m = bindingRe.exec(wgsl)) !== null) {
        const slot = parseInt(m[1]);
        const varType = m[2].trim();
        const varName = m[3];
        const wgslType = m[4].trim();
        if (!bindingMap.has(slot)) {
          bindingMap.set(slot, { varType, varName, wgslType });
        }
      }
    }

    if (visibility === 0) visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;

    // Sort by binding slot
    const slots = [...bindingMap.entries()].sort((a, b) => a[0] - b[0]);
    const entries = [];
    const layoutEntries = [];
    let hasVideo = false;

    for (const [slot, { varType, varName, wgslType }] of slots) {
      // Duck-type by WGSL var type
      if (varType === 'uniform') {
        // Uniform buffer — resolve from heap layout or structs
        const hl = this._heapLayout.get(varName);
        const structName = wgslType.trim();
        const sd = this._structs.get(structName);
        const size = hl ? hl.size : (sd ? sd.size : 256);

        if (hl && this._heapBuffer) {
          layoutEntries.push({ binding: slot, visibility, buffer: { type: 'uniform', minBindingSize: size } });
          entries.push({ binding: slot, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
        } else {
          this.log(`resources "${res.name}": uniform "${varName}" not found in heap`, 'warn');
        }
      } else if (varType.startsWith('storage')) {
        // Storage buffer
        const isReadOnly = varType.includes('read') && !varType.includes('read_write');
        const bufType = isReadOnly ? 'read-only-storage' : 'storage';
        const sb = this._storageBuffers.get(varName);
        if (sb) {
          layoutEntries.push({ binding: slot, visibility, buffer: { type: bufType } });
          entries.push({ binding: slot, resource: { buffer: sb } });
        } else {
          this.log(`resources "${res.name}": storage buffer "${varName}" not found`, 'warn');
        }
      } else if (wgslType.startsWith('texture_storage')) {
        // Storage texture
        const fmtMatch = wgslType.match(/texture_storage_\w+<(\w+),\s*(\w+)>/);
        const storageFmt = fmtMatch ? fmtMatch[1] : 'rgba8unorm';
        const access = fmtMatch ? fmtMatch[2].replace('_', '-') : 'write-only';
        const tex = this._textures.get(varName);
        if (tex) {
          layoutEntries.push({ binding: slot, visibility: GPUShaderStage.COMPUTE, storageTexture: { access, format: storageFmt } });
          entries.push({ binding: slot, resource: (this._textureViews?.get(varName)) || tex.createView() });
        }
      } else if (wgslType.startsWith('texture')) {
        // Sampled texture
        const tex = this._textures.get(varName);
        if (tex) {
          const isDepth = (tex.format || '').startsWith('depth');
          layoutEntries.push({ binding: slot, visibility, texture: isDepth ? { sampleType: 'depth' } : {} });
          entries.push({ binding: slot, resource: (this._textureViews?.get(varName)) || tex.createView() });
        }
      } else if (wgslType === 'sampler' || wgslType === 'sampler_comparison') {
        // Sampler
        const isComparison = wgslType === 'sampler_comparison';
        // Try to match sampler to a texture with similar name
        const samp = this._samplers.get(varName) || this._samplers.get(varName.replace(/[-_]sampler$/, ''));
        if (samp) {
          layoutEntries.push({ binding: slot, visibility, sampler: { type: isComparison ? 'comparison' : 'filtering' } });
          entries.push({ binding: slot, resource: samp.sampler });
        } else {
          // Create default filtering sampler
          const defaultSamp = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
          layoutEntries.push({ binding: slot, visibility, sampler: { type: 'filtering' } });
          entries.push({ binding: slot, resource: defaultSamp });
        }
      } else {
        this.log(`resources "${res.name}": unknown var type "${varType}" for "${varName}"`, 'warn');
      }
    }

    if (layoutEntries.length > 0) {
      const layout = this.device.createBindGroupLayout({ entries: layoutEntries });
      const bindGroup = this.device.createBindGroup({ layout, entries });
      this._resourceScopes.set(res.name, { layout, bindGroup, entries: layoutEntries.length, hasVideo, _layoutEntries: layoutEntries, _entries: entries });
      this.log(`resources: "${res.name}" ${layoutEntries.length} bindings (auto)`, 'ok');
    }
  }

  _compileResourceScopes(tree) {
    this._resourceScopes = new Map();
    for (const res of Rex.findAll(tree, 'resources')) {
      const name = res.name;
      if (!name) continue;

      // Auto-generation: derive layout from shader WGSL declarations
      if (res.attrs.auto === true || res.attrs.auto === 'true') {
        this._autoResourceScope(res);
        continue;
      }

      const entries = [];
      const layoutEntries = [];
      let binding = 0;
      let hasVideo = false;

      for (const child of res.children) {
        if (child.type === 'buffer') {
          const usage = child.attrs.usage;
          const isStorage = usage && Array.isArray(usage) && usage.includes('storage');
          const bufName = child.name;
          const dynamic = child.attrs.dynamic === true;

          if (isStorage) {
            const sb = this._storageBuffers.get(bufName);
            if (sb) {
              const readOnly = child.attrs.access === 'read' || child.attrs.access === 'read-only';
              const bufType = readOnly ? 'read-only-storage' : 'storage';
              const vis = readOnly
                ? (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE)
                : (GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE);
              layoutEntries.push({ binding, visibility: vis, buffer: { type: bufType, hasDynamicOffset: dynamic } });
              entries.push({ binding, resource: { buffer: sb } });
              if (dynamic) this.log(`resources "${name}": buffer "${bufName}" has dynamic offset`,'ok');
              binding++;
            }
          } else {
            const hl = this._heapLayout.get(bufName);
            if (hl && this._heapBuffer) {
              layoutEntries.push({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: dynamic, minBindingSize: hl.size } });
              entries.push({ binding, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
              binding++;
            }
          }
        } else if (child.type === 'texture') {
          const texName = child.name;

          // Video / external texture
          if (this._videoTextures.has(texName)) {
            layoutEntries.push({ binding, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} });
            const extTex = this._externalTextures.get(texName);
            if (extTex) {
              entries.push({ binding, resource: extTex });
            } else {
              // Placeholder — will be rebuilt per-frame
              entries.push({ binding, resource: this.device.importExternalTexture({ source: new VideoFrame(new Uint8Array(4), { timestamp: 0, codedWidth: 1, codedHeight: 1, format: 'RGBA' }) }) });
            }
            entries[entries.length - 1]._videoName = texName;
            hasVideo = true;
            binding++;
            continue;
          }

          const tex = this._textures.get(texName);
          const samp = this._samplers.get(texName);
          const isStorageTex = child.attrs.storage === true || child.attrs.usage === 'storage';
          if (isStorageTex) {
            if (tex) {
              const storageFmt = child.attrs.format || 'rgba8unorm';
              const access = child.attrs.access || 'write-only';
              layoutEntries.push({ binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access, format: storageFmt } });
              entries.push({ binding, resource: (this._textureViews && this._textureViews.get(texName)) || tex.createView() });
              binding++;
            }
          } else {
            if (samp) {
              const isComparison = samp.comparison;
              layoutEntries.push({ binding, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: { type: isComparison ? 'comparison' : 'filtering' } });
              entries.push({ binding, resource: samp.sampler });
              binding++;
            }
            if (tex) {
              const isDepthTex = (tex.format || '').startsWith('depth');
              layoutEntries.push({ binding, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: isDepthTex ? { sampleType: 'depth' } : {} });
              entries.push({ binding, resource: (this._textureViews && this._textureViews.get(texName)) || tex.createView() });
              binding++;
            }
          }
        } else {
          const rh = this._resourceHandlers.get(child.type);
          if (rh) rh(child, entries, layoutEntries, binding++, this);
        }
      }

      if (layoutEntries.length > 0) {
        const layout = this.device.createBindGroupLayout({ entries: layoutEntries });
        const bindGroup = this.device.createBindGroup({ layout, entries });
        this._resourceScopes.set(name, { layout, bindGroup, entries: layoutEntries.length, hasVideo, _layoutEntries: layoutEntries, _entries: entries });
        this.log(`resources: "${name}" ${layoutEntries.length} bindings${hasVideo ? ' [video]' : ''}`, 'ok');
      }
    }
  }

  _writeDefaults() {
    for (const op of this._optics) {
      if (op.source === 'const') this._writeToHeap(op.heapOffset, op.type, op.constVal);
    }
    for (const [key, targets] of this._formOptics) {
      const val = this.formState[key];
      if (val !== undefined) {
        for (const t of targets) this._writeToHeap(t.heapOffset, t.type, val);
      }
    }
    this._dirtyMin = 0;
    this._dirtyMax = this._heapSize;
    this._frameDirty = true;

    // Write initial field source data to storage buffers
    this._writeFieldDefaults();
  }

  _compileCommandList(tree) {
    this._commandList = [];
    this._compileCommands(tree);
    this.log(`commands: ${this._commandList.length} compiled`,'ok');
  }

  _compileCommands(node) {
    switch(node.type) {
      case 'pass': {
        const cc = node.attrs.clear;
        const ca = Array.isArray(cc) ? cc : [0,0,0,1];
        const passCmd = {
          type: 'pass',
          clearValue: { r:ca[0]||0, g:ca[1]||0, b:ca[2]||0, a:ca[3]??1 },
          loadOp: node.attrs.load||'clear', storeOp: node.attrs.store||'store',
          depth: node.attrs.depth === true,
          draws: [],
          target: node.attrs.target || null,
          targets: node.attrs.targets || null,
          depthTarget: node.attrs['depth-target'] || null,
          // Stencil
          stencilClearValue: +(node.attrs['stencil-clear'] ?? 0),
          stencilLoadOp: node.attrs['stencil-load'] || 'clear',
          stencilStoreOp: node.attrs['stencil-store'] || 'store',
          stencilRef: +(node.attrs['stencil-ref'] ?? 0),
          // Queries
          query: node.attrs.query || null,
          occlusionQuery: node.attrs['occlusion-query'] || null,
          // Bundles
          executeBundles: node.attrs['execute-bundle']
            ? (Array.isArray(node.attrs['execute-bundle']) ? node.attrs['execute-bundle'] : [node.attrs['execute-bundle']])
            : null,
        };
        for (const child of node.children) {
          if (child.type === 'draw') {
            const draw = {
              pipelineKey: child.attrs.pipeline,
              // Store raw attr values for dynamic fields — resolved at execute time via _resolveDynamic
              vertices: child.attrs.vertices ?? 3,
              instances: child.attrs.instances ?? 1,
              binds: [],
              vertexBuffer: child.attrs['vertex-buffer'] || null,
              indexBuffer: child.attrs['index-buffer'] || null,
              indexCount: child.attrs['index-count'] ?? 0,
              indirect: child.attrs.indirect === true,
              indirectBuffer: child.attrs['indirect-buffer'] || null,
              indirectOffset: this._resolveDrawValue(child.attrs['indirect-offset']) || 0,
              // Dynamic offsets
              dynamicOffsets: child.attrs['dynamic-offsets']
                ? child.attrs['dynamic-offsets'].map(v => +v) : null,
              // Occlusion query per-draw
              occlusionIndex: +(child.attrs['occlusion-index'] ?? -1),
            };
            for (const b of child.children.filter(c=>c.type==='bind')) {
              draw.binds.push({
                group: Number(b.name)||0,
                buffer: b.attrs.buffer,
                texture: b.attrs.texture,
                sampler: b.attrs.sampler,
                storage: b.attrs.storage,
              });
            }
            if (child.attrs.bind) draw.binds.push({ group: 0, buffer: child.attrs.bind });
            passCmd.draws.push(draw);
          }
        }
        // Derive MSAA sample count from pipeline draws
        let maxMsaa = 1;
        for (const d of passCmd.draws) {
          const pe = this.pipelines.get(d.pipelineKey);
          if (pe?.sampleCount > maxMsaa) maxMsaa = pe.sampleCount;
        }
        passCmd.sampleCount = maxMsaa;
        this._commandList.push(passCmd);
        return;
      }
      case 'dispatch': {
        const grid = node.attrs.grid || [1,1,1];
        const dispCmd = {
          type: 'dispatch',
          pipelineKey: node.attrs.pipeline,
          // Store raw grid values for dynamic resolution at execute time
          grid: Array.isArray(grid) ? [...grid] : [grid, 1, 1],
          binds: [],
          indirect: node.attrs.indirect === true,
          indirectBuffer: node.attrs['indirect-buffer'] || null,
          indirectOffset: +(node.attrs['indirect-offset'] || 0),
          query: node.attrs.query || null,
        };
        for (const b of node.children.filter(c=>c.type==='bind')) {
          dispCmd.binds.push({
            group: Number(b.name)||0,
            buffer: b.attrs.buffer,
            storage: b.attrs.storage,
          });
        }
        this._commandList.push(dispCmd);
        return;
      }
      default: {
        const h = this._commandHandlers.get(node.type);
        if (h) { h.compile(node, this._commandList, this); }
        else for (const c of node.children) this._compileCommands(c);
        break;
      }
    }
  }

  // ── Derive compute: generate a single compute shader from GPU-eligible @derive expressions ──
  // Takes classified GPU derives from behaviour transducer, generates DeriveState struct,
  // compute shader body (topological order), pipeline, storage buffer, bind group.
  // The storage buffer is then bindable by render passes — zero CPU round-trip.
  _compileDeriveCompute(gpuDerives) {
    // Clean up previous derive compute resources
    this._deriveComputePipeline = null;
    this._deriveBindGroup = null;
    this._deriveFields = [];
    this._deriveFieldCount = 0;
    if (this._deriveStorageBuffer) {
      this._deriveStorageBuffer.destroy();
      this._deriveStorageBuffer = null;
    }

    if (!gpuDerives || gpuDerives.length === 0 || !this.device) return;

    // Build DeriveState struct fields (one f32 per derive, topological order)
    const fields = [];
    for (const d of gpuDerives) {
      const wf = d._wgslField;
      if (!fields.find(f => f.wgslField === wf)) {
        fields.push({ name: `${d.shrub}/${d.slot}`, wgslField: wf });
      }
    }
    this._deriveFields = fields;
    this._deriveFieldCount = fields.length;

    // Generate WGSL
    const structFields = fields.map((f, i) => `  ${f.wgslField}: f32, // [${i}] ${f.name}`).join('\n');

    // Find which heap buffer the derives reference (first one found in params.* references)
    // We bind the heap uniform so the compute shader can read current params
    let heapBufferName = null;
    for (const d of gpuDerives) {
      if (d._wgsl && d._wgsl.includes('params.')) {
        // Find the heap layout entry this maps to
        for (const [name] of this._heapLayout) {
          heapBufferName = name;
          break;
        }
        if (heapBufferName) break;
      }
    }

    // Build the struct for heap uniform (mirror the existing struct)
    let paramsStruct = '';
    let paramsBinding = '';
    if (heapBufferName) {
      const hl = this._heapLayout.get(heapBufferName);
      if (hl && hl.structDef) {
        const pFields = hl.structDef.layout.map(f => {
          const wt = f.type === 'f32' ? 'f32' : f.type === 'i32' ? 'i32' : f.type === 'u32' ? 'u32' : 'f32';
          return `  ${f.name.replace(/-/g, '_')}: ${wt},`;
        }).join('\n');
        paramsStruct = `struct Params {\n${pFields}\n}\n`;
        paramsBinding = `@group(0) @binding(1) var<uniform> params: Params;`;
      }
    }

    // Compute body: one assignment per derive in topological order
    const assignments = gpuDerives.map(d => `  derives.${d._wgslField} = ${d._wgsl};`).join('\n');

    const shaderCode = `
${paramsStruct}
struct DeriveState {
${structFields}
}

@group(0) @binding(0) var<storage, read_write> derives: DeriveState;
${paramsBinding}

@compute @workgroup_size(1)
fn main() {
${assignments}
}
`.trim();

    // Create shader module
    let mod;
    try {
      mod = this.device.createShaderModule({ code: shaderCode });
      if (mod.getCompilationInfo) {
        mod.getCompilationInfo().then(info => {
          for (const msg of info.messages) {
            if (msg.type === 'error') {
              this.log(`derive compute shader error: ${msg.message} (line ${msg.lineNum})`, 'err');
            }
          }
        });
      }
    } catch (e) {
      this.log(`derive compute: shader creation failed: ${e.message}`, 'err');
      return;
    }

    // Storage buffer: one f32 per derive field (16-byte aligned minimum)
    const bufSize = Math.max(16, Math.ceil(fields.length * 4 / 16) * 16);
    this._deriveStorageBuffer = this.device.createBuffer({
      size: bufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Create pipeline with auto layout
    try {
      this._deriveComputePipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: mod, entryPoint: 'main' },
      });
    } catch (e) {
      this.log(`derive compute: pipeline creation failed: ${e.message}`, 'err');
      this._deriveStorageBuffer.destroy();
      this._deriveStorageBuffer = null;
      return;
    }

    // Create bind group
    const entries = [{ binding: 0, resource: { buffer: this._deriveStorageBuffer } }];
    if (heapBufferName && this._heapBuffer) {
      const hl = this._heapLayout.get(heapBufferName);
      if (hl) {
        entries.push({ binding: 1, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
      }
    }
    try {
      this._deriveBindGroup = this.device.createBindGroup({
        layout: this._deriveComputePipeline.getBindGroupLayout(0),
        entries,
      });
    } catch (e) {
      this.log(`derive compute: bind group creation failed: ${e.message}`, 'err');
      this._deriveComputePipeline = null;
      return;
    }

    // Register derive buffer as a named storage buffer so @bind :storage _derives works
    this._storageBuffers.set('_derives', this._deriveStorageBuffer);

    this.log(`derive compute: ${fields.length} fields, shader compiled ✓`, 'ok');
  }

  // Execute the derive compute dispatch — called before render passes in _execute()
  _executeDeriveDispatch(enc) {
    if (!this._deriveComputePipeline || !this._deriveBindGroup) return;
    const cp = enc.beginComputePass();
    cp.setPipeline(this._deriveComputePipeline);
    cp.setBindGroup(0, this._deriveBindGroup);
    cp.dispatchWorkgroups(1);
    cp.end();
  }

  // Get the derive storage buffer for downstream binding
  getDeriveStorageBuffer() { return this._deriveStorageBuffer; }
  getDeriveFields() { return this._deriveFields; }

  _compileBarrierSchedule(tree) {
    this._barrierSchedule = [];
    const passes = Rex.findAll(tree, 'pass');
    const dispatches = Rex.findAll(tree, 'dispatch');
    const allStages = [...passes, ...dispatches];
    if (allStages.length < 2) {
      if (allStages.length === 1) this.log('barrier: single stage \u2014 no barriers needed','ok');
      return;
    }
    const timeline = [];
    // Helper: extract reads/writes from bind children
    const extractBinds = (node, reads, writes) => {
      for (const bind of Rex.findAll(node, 'bind')) {
        if (bind.attrs.buffer) reads.add(bind.attrs.buffer);
        if (bind.attrs.texture) reads.add(bind.attrs.texture);
        if (bind.attrs.storage) {
          const sNames = Array.isArray(bind.attrs.storage) ? bind.attrs.storage : [bind.attrs.storage];
          for (const s of sNames) { reads.add(s); writes.add(s); }
        }
      }
    };
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const reads = new Set(), writes = new Set();
      for (const draw of Rex.findAll(p, 'draw')) {
        extractBinds(draw, reads, writes);
        if (draw.attrs.bind) reads.add(draw.attrs.bind);
      }
      const passWrites = Rex.findAll(p, 'write');
      for (const w of passWrites) writes.add(w.attrs.buffer || w.name);
      if (p.attrs.target) writes.add(p.attrs.target);
      if (p.attrs['depth-target']) writes.add(p.attrs['depth-target']);
      timeline.push({ name: p.name || `pass_${i}`, index: i, reads, writes });
    }
    // Include dispatch (compute) stages in timeline
    for (let i = 0; i < dispatches.length; i++) {
      const d = dispatches[i];
      const reads = new Set(), writes = new Set();
      extractBinds(d, reads, writes);
      timeline.push({ name: d.name || d.attrs.pipeline || `dispatch_${i}`, index: passes.length + i, reads, writes });
    }
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i-1], curr = timeline[i];
      const hazards = [];
      for (const r of curr.reads) {
        if (prev.writes.has(r)) hazards.push({ resource: r, type: 'RAW' });
      }
      for (const w of curr.writes) {
        if (prev.writes.has(w)) hazards.push({ resource: w, type: 'WAW' });
        if (prev.reads.has(w)) hazards.push({ resource: w, type: 'WAR' });
      }
      if (hazards.length > 0) {
        const barrier = {
          afterPass: prev.name, beforePass: curr.name,
          before: prev.writes.size > 0 ? 'STAGE_RASTER_COLOR_OUT' : 'STAGE_COMPUTE',
          after: 'STAGE_FRAGMENT_SHADER',
          hazards: hazards.map(h => h.type).join('|'),
          details: hazards,
        };
        this._barrierSchedule.push(barrier);
        this.log(`barrier: ${barrier.afterPass} \u2192 ${barrier.beforePass} [${barrier.hazards}]`,'ok');
      }
    }
    if (this._barrierSchedule.length === 0 && passes.length > 1) {
      this.log('barrier: no hazards detected between passes','ok');
    }
  }

  _compileAliasingPlan(tree) {
    this._aliasingPlan = [];
    const resources = Rex.findAll(tree, 'resource');
    const transients = resources.filter(r => r.attrs.transient === true);
    if (transients.length < 2) return;
    const passes = Rex.findAll(tree, 'pass');
    const lifetimes = [];
    for (const res of transients) {
      let first = Infinity, last = -1;
      for (let i = 0; i < passes.length; i++) {
        const allBinds = Rex.findAll(passes[i], 'bind');
        for (const b of allBinds) {
          if (b.attrs.buffer === res.name || b.attrs.resource === res.name) {
            first = Math.min(first, i); last = Math.max(last, i);
          }
        }
      }
      if (last >= 0) {
        const format = res.attrs.format || 'rgba8unorm';
        const size = this._estimateResourceSize(res);
        lifetimes.push({ name: res.name, first, last, size, format });
      }
    }
    const allocations = [];
    lifetimes.sort((a,b) => a.first - b.first);
    for (const res of lifetimes) {
      let assigned = false;
      for (const alloc of allocations) {
        if (alloc.lastEnd < res.first && alloc.size >= res.size) {
          alloc.occupants.push(res.name); alloc.lastEnd = res.last; assigned = true;
          this.log(`alias: "${res.name}" shares allocation with "${alloc.occupants[0]}"`,'ok');
          this._aliasingPlan.push({ resource: res.name, sharedWith: alloc.occupants[0], size: alloc.size });
          break;
        }
      }
      if (!assigned) allocations.push({ size: res.size, lastEnd: res.last, occupants: [res.name] });
    }
  }

  _estimateResourceSize(res) {
    const formatSizes = { 'rgba8unorm':4, 'rgba16float':8, 'rg11b10float':4, 'depth32float':4, 'rgb10a2unorm':4, 'r32float':4 };
    const bpp = formatSizes[res.attrs.format] || 4;
    const w = res.attrs.width || 1920, h = res.attrs.height || 1080;
    return w * h * bpp;
  }

  // ════════════════════════════════════════════════════════════════
  // BARRIER ENFORCEMENT — optic-derived barriers (Spec §3)
  // ════════════════════════════════════════════════════════════════

  _annotateOpticAccesses() {
    this._opticAccessMap.clear();
    const addAccess = (key, passIndex, access, stage) => {
      if (!this._opticAccessMap.has(key)) this._opticAccessMap.set(key, []);
      this._opticAccessMap.get(key).push({ passIndex, access, stage });
    };
    for (let ci = 0; ci < this._commandList.length; ci++) {
      const cmd = this._commandList[ci];
      if (cmd.type === 'pass') {
        // Render target writes
        if (cmd.target) addAccess(cmd.target, ci, 'write', 'FRAGMENT');
        if (cmd.targets) for (const t of cmd.targets) addAccess(t, ci, 'write', 'FRAGMENT');
        if (cmd.depthTarget) addAccess(cmd.depthTarget, ci, 'write', 'FRAGMENT');
        // Draw bind groups — reads
        for (const draw of cmd.draws) {
          for (const b of draw.binds) {
            if (b.buffer) addAccess(b.buffer, ci, 'read', 'VERTEX');
            if (b.texture) addAccess(b.texture, ci, 'read', 'FRAGMENT');
            if (b.storage) {
              const names = Array.isArray(b.storage) ? b.storage : [b.storage];
              for (const s of names) { addAccess(s, ci, 'read', 'FRAGMENT'); addAccess(s, ci, 'write', 'FRAGMENT'); }
            }
          }
        }
      } else if (cmd.type === 'dispatch') {
        for (const b of (cmd.binds || [])) {
          if (b.buffer) addAccess(b.buffer, ci, 'read', 'COMPUTE');
          if (b.storage) {
            const names = Array.isArray(b.storage) ? b.storage : [b.storage];
            for (const s of names) { addAccess(s, ci, 'read', 'COMPUTE'); addAccess(s, ci, 'write', 'COMPUTE'); }
          }
        }
      }
    }
  }

  _deriveBarriersFromOptics() {
    const opticBarriers = [];
    for (const [resource, accesses] of this._opticAccessMap) {
      if (accesses.length < 2) continue;
      // Sort by passIndex
      accesses.sort((a, b) => a.passIndex - b.passIndex);
      for (let i = 0; i < accesses.length - 1; i++) {
        const a = accesses[i], b = accesses[i + 1];
        if (a.passIndex === b.passIndex) continue;
        let hazardType = null;
        if (a.access === 'write' && b.access === 'read') hazardType = 'RAW';
        else if (a.access === 'write' && b.access === 'write') hazardType = 'WAW';
        else if (a.access === 'read' && b.access === 'write') hazardType = 'WAR';
        if (hazardType) {
          // Check if this barrier already exists in the schedule
          const exists = this._barrierSchedule.some(bs =>
            bs.afterPass === String(a.passIndex) && bs.beforePass === String(b.passIndex)
          );
          if (!exists) {
            opticBarriers.push({
              afterPass: String(a.passIndex), beforePass: String(b.passIndex),
              hazardType, opticPaths: [resource],
              srcStage: a.stage, dstStage: b.stage, enforced: false,
            });
          }
        }
      }
    }
    // Merge optic-derived barriers into schedule
    for (const ob of opticBarriers) {
      this._barrierSchedule.push({
        afterPass: ob.afterPass, beforePass: ob.beforePass,
        before: `STAGE_${ob.srcStage}`, after: `STAGE_${ob.dstStage}`,
        hazards: ob.hazardType,
        details: ob.opticPaths.map(p => ({ resource: p, type: ob.hazardType })),
        enforced: false,
      });
    }
    if (opticBarriers.length > 0) {
      this.log(`barriers: ${opticBarriers.length} derived from optic accesses`, 'ok');
    }
  }

  _enforceBarriers() {
    this._barrierViolations = 0;
    if (this._barrierSchedule.length === 0) return;
    // WebGPU barriers are implicit at pass boundaries.
    // Validate ordering: afterPass index < beforePass index in command list.
    for (const barrier of this._barrierSchedule) {
      const after = Number(barrier.afterPass);
      const before = Number(barrier.beforePass);
      if (!isNaN(after) && !isNaN(before)) {
        if (after >= before) {
          this._barrierViolations++;
          this.log(`barrier violation: pass ${after} must complete before pass ${before} [${barrier.hazards}]`, 'warn');
        } else {
          barrier.enforced = true;
        }
      }
    }
    if (this._barrierViolations > 0) {
      this.log(`barriers: ${this._barrierViolations} violations detected`, 'warn');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // OPTIC-DRIVEN READBACK — path-based typed readback (Spec §4)
  // ════════════════════════════════════════════════════════════════

  _resolveOpticPath(path) {
    if (!path || !path.startsWith('/')) return null;
    const parts = path.slice(1).split('/');
    if (parts.length === 0) return null;

    const bufferName = parts[0];
    // Check uniform heap first
    const hl = this._heapLayout.get(bufferName);
    if (hl && hl.structDef) {
      if (parts.length === 1) {
        // Entire buffer — return full struct
        return { buffer: bufferName, offset: hl.offset, size: hl.size, type: null, structLayout: hl.structDef.layout, isHeap: true };
      }
      // Navigate struct layout
      let currentLayout = hl.structDef.layout;
      let currentOffset = hl.offset;
      for (let i = 1; i < parts.length; i++) {
        const fieldName = parts[i];
        const field = currentLayout.find(f => f.name === fieldName);
        if (!field) return null;
        currentOffset += field.offset;
        // Check if this field is a nested struct
        const nestedStruct = this._structs.get(field.type);
        if (nestedStruct && i < parts.length - 1) {
          currentLayout = nestedStruct.layout;
        } else if (i === parts.length - 1) {
          // Leaf field or nested struct at end of path
          if (nestedStruct) {
            return { buffer: bufferName, offset: currentOffset, size: nestedStruct.size, type: null, structLayout: nestedStruct.layout, isHeap: true };
          }
          return { buffer: bufferName, offset: currentOffset, size: field.size, type: field.type, structLayout: null, isHeap: true };
        } else {
          return null; // non-struct intermediate in path
        }
      }
    }

    // Check storage buffers
    const sb = this._storageBuffers.get(bufferName);
    if (sb) {
      // Find the struct associated with this storage buffer from the tree
      // Storage buffers may have a struct via :struct attr — look up in _structs
      for (const [sName, sDef] of this._structs) {
        // Try to match: look for the field path in this struct
        if (parts.length >= 2) {
          let currentLayout = sDef.layout;
          let currentOffset = 0;
          let found = true;
          for (let i = 1; i < parts.length; i++) {
            const field = currentLayout.find(f => f.name === parts[i]);
            if (!field) { found = false; break; }
            currentOffset += field.offset;
            if (i < parts.length - 1) {
              const nested = this._structs.get(field.type);
              if (nested) currentLayout = nested.layout;
              else { found = false; break; }
            } else {
              if (found) return { buffer: bufferName, offset: currentOffset, size: field.size, type: field.type, structLayout: null, isHeap: false };
            }
          }
        }
      }
    }

    return null;
  }

  _deserializeStruct(dataView, offset, structLayout) {
    const result = {};
    for (const field of structLayout) {
      const off = offset + field.offset;
      const nested = this._structs.get(field.type);
      if (nested) {
        result[field.name] = this._deserializeStruct(dataView, off, nested.layout);
      } else if (field.type === 'f32') {
        result[field.name] = dataView.getFloat32(off, true);
      } else if (field.type === 'u32') {
        result[field.name] = dataView.getUint32(off, true);
      } else if (field.type === 'i32') {
        result[field.name] = dataView.getInt32(off, true);
      } else if (field.type === 'f32x2') {
        result[field.name] = [dataView.getFloat32(off, true), dataView.getFloat32(off + 4, true)];
      } else if (field.type === 'f32x3') {
        result[field.name] = [dataView.getFloat32(off, true), dataView.getFloat32(off + 4, true), dataView.getFloat32(off + 8, true)];
      } else if (field.type === 'f32x4') {
        result[field.name] = [dataView.getFloat32(off, true), dataView.getFloat32(off + 4, true), dataView.getFloat32(off + 8, true), dataView.getFloat32(off + 12, true)];
      } else {
        result[field.name] = 0;
      }
    }
    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // HEAP COMPACTION — liveness analysis + dead optic elimination (Spec §6)
  // ════════════════════════════════════════════════════════════════

  _compactHeap() {
    if (this._optics.length === 0) return;
    // Conservative liveness: scan shader sources for field name references
    const liveness = this._buildLivenessMap();
    const eliminated = this._eliminateDeadOptics(liveness);
    if (eliminated > 0) this.log(`compaction: eliminated ${eliminated} dead optics`, 'ok');
    // Alias non-overlapping optics (register allocation for heap slots)
    const aliased = this._aliasHeapSlots(liveness);
    if (aliased > 0) this.log(`compaction: aliased ${aliased} heap slots`, 'ok');
  }

  _buildLivenessMap() {
    const liveness = new Map(); // fieldPath → {firstRead, lastRead}
    // Scan shader sources for u.fieldName references
    const shaderRefs = new Map(); // shaderKey → Set<fieldName>
    for (const [key, code] of this._lastGoodShaders) {
      const refs = new Set();
      // Match u.fieldName patterns in WGSL
      const matches = code.matchAll(/\bu\.(\w+)/g);
      for (const m of matches) refs.add(m[1]);
      shaderRefs.set(key, refs);
    }
    // Map shader references to pass indices via command list
    if (this._commandList) {
      for (let ci = 0; ci < this._commandList.length; ci++) {
        const cmd = this._commandList[ci];
        const pipelineKeys = [];
        if (cmd.type === 'pass') {
          for (const draw of cmd.draws) if (draw.pipelineKey) pipelineKeys.push(draw.pipelineKey);
        } else if (cmd.type === 'dispatch') {
          if (cmd.pipelineKey) pipelineKeys.push(cmd.pipelineKey);
        }
        for (const pk of pipelineKeys) {
          const pe = this.pipelines.get(pk);
          if (!pe) continue;
          // Find which shader this pipeline uses
          for (const [sk, refs] of shaderRefs) {
            for (const fieldName of refs) {
              for (const op of this._optics) {
                if (op.fieldName === fieldName) {
                  const key = `${op.bufferName}/${op.fieldName}`;
                  const entry = liveness.get(key) || { firstRead: Infinity, lastRead: -1 };
                  entry.firstRead = Math.min(entry.firstRead, ci);
                  entry.lastRead = Math.max(entry.lastRead, ci);
                  liveness.set(key, entry);
                }
              }
            }
          }
        }
      }
    }
    return liveness;
  }

  _eliminateDeadOptics(liveness) {
    let eliminated = 0;
    this._optics = this._optics.filter(op => {
      // Form/builtin optics are always live (external writes)
      if (op.source === 'form' || op.source === 'builtin') return true;
      const key = `${op.bufferName}/${op.fieldName}`;
      if (!liveness.has(key) || liveness.get(key).lastRead < 0) {
        eliminated++;
        return false;
      }
      return true;
    });
    return eliminated;
  }

  _aliasHeapSlots(liveness) {
    // Group optics by buffer — only alias within same buffer
    let aliased = 0;
    const opticsByBuffer = new Map();
    for (const op of this._optics) {
      if (!opticsByBuffer.has(op.bufferName)) opticsByBuffer.set(op.bufferName, []);
      opticsByBuffer.get(op.bufferName).push(op);
    }
    for (const [bufName, ops] of opticsByBuffer) {
      if (ops.length < 2) continue;
      // Sort by firstRead
      const withLiveness = ops.map(op => {
        const key = `${op.bufferName}/${op.fieldName}`;
        const live = liveness.get(key) || { firstRead: 0, lastRead: Infinity };
        return { op, ...live };
      }).sort((a, b) => a.firstRead - b.firstRead);
      // Greedy interval scheduling
      const slots = []; // [{lastRead, offset, size, align}]
      for (const entry of withLiveness) {
        const size = this._typeSize(entry.op.type);
        const align = Math.max(4, size <= 4 ? 4 : size <= 8 ? 8 : 16);
        let found = false;
        for (const slot of slots) {
          if (slot.lastRead < entry.firstRead && slot.size === size && slot.align === align) {
            // Alias: reuse this slot's offset
            entry.op.heapOffset = slot.offset;
            slot.lastRead = entry.lastRead;
            found = true;
            aliased++;
            break;
          }
        }
        if (!found) {
          slots.push({ lastRead: entry.lastRead, offset: entry.op.heapOffset, size, align });
        }
      }
    }
    return aliased;
  }

  // ════════════════════════════════════════════════════════════════
  // INCREMENTAL RECOMPILATION — structural diffing (Spec §7)
  // ════════════════════════════════════════════════════════════════

  _diffShrub(prev, next, path = '') {
    const changes = [];
    if (!prev && !next) return changes;
    if (!prev) { changes.push({ path, type: next.type, changeKind: 'added' }); return changes; }
    if (!next) { changes.push({ path, type: prev.type, changeKind: 'removed' }); return changes; }
    if (prev.type !== next.type || prev.name !== next.name) {
      changes.push({ path, type: next.type || prev.type, changeKind: 'modified' });
      return changes;
    }
    // Compare attrs
    const prevAttrs = JSON.stringify(prev.attrs || {});
    const nextAttrs = JSON.stringify(next.attrs || {});
    const attrsChanged = prevAttrs !== nextAttrs;
    // Compare content
    const contentChanged = (prev.content || '') !== (next.content || '');
    if (attrsChanged || contentChanged) {
      changes.push({ path: path || `/${prev.type}:${prev.name || ''}`, type: prev.type, changeKind: contentChanged ? 'modified' : 'attrs-only' });
    }
    // Compare children
    const maxLen = Math.max((prev.children || []).length, (next.children || []).length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}/${(next.children?.[i] || prev.children?.[i])?.type || 'unknown'}[${i}]`;
      const sub = this._diffShrub(prev.children?.[i] || null, next.children?.[i] || null, childPath);
      changes.push(...sub);
    }
    return changes;
  }

  _mapChangesToPhases(changes) {
    const phases = new Set();
    for (const c of changes) {
      switch (c.type) {
        case 'struct': case 'field': phases.add(1); phases.add(2); phases.add(3); phases.add(4); phases.add(5); phases.add(9); phases.add(12); break;
        case 'shader': phases.add(2); phases.add(9); break;
        case 'buffer': phases.add(3); phases.add(4); phases.add(5); phases.add(6); break;
        case 'texture': phases.add(7); phases.add(8.5); break;
        case 'pipeline': phases.add(9); break;
        case 'pass': case 'dispatch': phases.add(12); phases.add(10); break;
        case 'filter':
          if (c.changeKind === 'attrs-only') phases.add(1.5); // may be hot-patchable
          else { phases.add(1.5); phases.add(2); phases.add(9); phases.add(12); }
          break;
        case 'source': case 'visualize':
          phases.add(1.5); phases.add(2); phases.add(7); phases.add(8.5); phases.add(9); phases.add(12);
          break;
        case 'heap': phases.add(1.1); phases.add(3); phases.add(4); phases.add(5); break;
        // Sugar node types — route to correct phase or skip GPU entirely
        case 'media': phases.add(7); break;           // texture phase only
        case 'tool': break;                            // behaviour-only, no GPU phase
        case 'agent': break;                           // behaviour-only
        case 'system': case 'task':
        case 'few-shot': case 'context': break;        // prompt changes don't affect GPU
        default: // Unknown type — full recompile
          for (let p = 0; p <= 15; p++) phases.add(p);
      }
    }
    return phases;
  }

  _detectOpticStability() {
    if (!this._prevHeapLayout) return false;
    if (this._prevHeapLayout.size !== this._heapLayout.size) return false;
    for (const [name, entry] of this._heapLayout) {
      const prev = this._prevHeapLayout.get(name);
      if (!prev) return false;
      if (prev.offset !== entry.offset || prev.size !== entry.size) return false;
    }
    return true;
  }

  _canIncrementalCompile(phases) {
    // Can't do incremental if early phases (structs, heap layout) are affected
    if (phases.has(1) || phases.has(3) || phases.has(5)) return false;
    return true;
  }

  _incrementalCompile(tree, phases) {
    this.log('── INCREMENTAL COMPILE ──', 'cmd');
    this._warnedTypes.clear();
    if (phases.has(0)) this._compileLibs(tree);
    if (phases.has(1)) this._compileStructs(tree);
    if (phases.has(1.1)) this._compileHeap(tree);
    if (phases.has(1.5)) { this._compileFilters(tree); this._compileFields(tree); }
    if (phases.has(2)) this._compileShaders(tree);
    // phases 3,4,5 require full recompile (caught by _canIncrementalCompile)
    if (phases.has(7)) this._compileTextures(tree);
    if (phases.has(8.5)) this._compileResourceScopes(tree);
    if (phases.has(9)) { for (const p of Rex.findAll(tree, 'pipeline')) this._buildPipeline(p.name, p); }
    if (phases.has(10)) this._compileBarrierSchedule(tree);
    if (phases.has(12)) {
      this._compileCommandList(tree);
      this._annotateOpticAccesses();
      this._deriveBarriersFromOptics();
    }
    if (phases.has(14)) this._compileReadbacks(tree);
    this.log(`incremental: ${phases.size} phases recompiled`, 'ok');
  }

  // ════════════════════════════════════════════════════════════════
  // UNIFIED HEAP NOTATION — @heap nodes (Spec §1)
  // ════════════════════════════════════════════════════════════════

  _typeAlign(t) {
    const a = { 'f32': 4, 'i32': 4, 'u32': 4, 'f32x2': 8, 'f32x3': 16, 'f32x4': 16, 'f32x4x4': 16 };
    return a[t] || 16; // default 16 for nested structs
  }

  _compileHeap(tree) {
    const heapNodes = Rex.findAll(tree, 'heap');
    if (!heapNodes.length) return;

    for (const heapNode of heapNodes) {
      const name = heapNode.name;
      if (!name) { this.log('heap: @heap node missing name', 'err'); continue; }
      const count = heapNode.attrs.count ? +heapNode.attrs.count : 0;

      // Build struct from children recursively
      const result = this._heapNodeToStruct(heapNode, name);

      // Register all generated structs
      for (const [sName, sDef] of result.nestedStructs) {
        this._structs.set(sName, sDef);
        this._wgslStructs.set(sName, sDef.wgsl);
        this.log(`heap struct ${sName}: ${sDef.size}B`, 'ok');
      }
      // Register the top-level struct
      this._structs.set(result.structName, { size: result.size, layout: result.layout });
      this._wgslStructs.set(result.structName, result.wgsl);
      this.log(`heap struct ${result.structName}: ${result.size}B [${result.layout.map(l => `${l.name}@${l.offset}`).join(', ')}]`, 'cmd');

      // Inject synthetic @buffer node for downstream compile phases
      const syntheticBuffer = {
        type: 'buffer', name, attrs: { struct: result.structName }, children: [], content: null, _d: 1,
      };

      if (count > 0) {
        // Storage buffer mode
        syntheticBuffer.attrs.usage = ['storage'];
        syntheticBuffer.attrs.size = result.size * count;
      }

      // Collect default values into a synthetic @data node
      const dataAttrs = {};
      this._collectHeapDefaults(heapNode, result.layout, dataAttrs, '');
      if (Object.keys(dataAttrs).length > 0) {
        syntheticBuffer.children.push({ type: 'data', name: null, attrs: dataAttrs, children: [], content: null, _d: 2 });
      }

      tree.children.push(syntheticBuffer);
      this.log(`heap: "${name}" → synthetic @buffer (${count > 0 ? `storage x${count}` : 'uniform'})`, 'ok');
    }
  }

  _heapNodeToStruct(node, prefix) {
    const structName = prefix.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('_');
    const layout = [];
    const nestedStructs = new Map();
    let size = 0;

    for (const child of (node.children || [])) {
      const fieldName = child.name;
      if (!fieldName) continue;

      const fieldType = child.attrs?.type;
      if (fieldType) {
        // Leaf field — typed
        const bs = this._typeSize(fieldType);
        const align = this._typeAlign(fieldType);
        size = Math.ceil(size / align) * align;
        layout.push({ name: fieldName, type: fieldType, offset: size, size: bs });
        size += bs;
      } else if (child.children && child.children.length > 0) {
        // Nested struct — recurse
        const childPrefix = `${prefix}_${fieldName}`;
        const nested = this._heapNodeToStruct(child, childPrefix);
        // Register nested structs
        for (const [k, v] of nested.nestedStructs) nestedStructs.set(k, v);
        nestedStructs.set(nested.structName, { size: nested.size, layout: nested.layout, wgsl: nested.wgsl });
        // Nested struct alignment: 16 bytes
        const align = 16;
        size = Math.ceil(size / align) * align;
        layout.push({ name: fieldName, type: nested.structName, offset: size, size: nested.size });
        size += nested.size;
      }
    }

    // Pad to 16-byte boundary
    size = Math.ceil(size / 16) * 16;

    // Generate WGSL
    const wgsl = `struct ${structName} {\n${layout.map(l => `  ${l.name}: ${this._structs.has(l.type) ? l.type : this._toWGSL(l.type)},`).join('\n')}\n}`;

    return { structName, size, layout, wgsl, nestedStructs };
  }

  _collectHeapDefaults(node, layout, dataAttrs, prefix) {
    for (const child of (node.children || [])) {
      if (!child.name) continue;
      const field = layout.find(f => f.name === child.name);
      if (!field) continue;

      if (child.attrs?.type) {
        // Leaf field — check for default value
        // Value can be in child.attrs (first non-type/name attr) or child content
        const keys = Object.keys(child.attrs).filter(k => k !== 'type');
        if (keys.length > 0) {
          // Use first non-type attr as default value
          dataAttrs[child.name] = child.attrs[keys[0]];
        }
        // Check for inline value — content of the node
        if (child.content) {
          try { dataAttrs[child.name] = JSON.parse(child.content); } catch { dataAttrs[child.name] = child.content; }
        }
      } else if (child.children && child.children.length > 0) {
        // Nested — recurse into nested struct's layout
        const nestedStruct = this._structs.get(field.type);
        if (nestedStruct) {
          this._collectHeapDefaults(child, nestedStruct.layout, dataAttrs, `${prefix}${child.name}_`);
        }
      }
    }
  }

  // Parse WGSL source to detect which @group indices have bindings actually
  // used by the given entry points. Unused bindings get optimized away by the
  // WGSL compiler, leaving empty bind group layouts that poison createBindGroup.
  _getActiveBindGroups(shaderKeys, entryPoints) {
    const activeGroups = new Set();
    for (let si = 0; si < shaderKeys.length; si++) {
      const code = this._lastGoodShaders.get(shaderKeys[si]);
      if (!code) continue;
      // Strip comments to avoid false positives from commented-out references
      const stripped = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // Find all @group(G) @binding(B) var<...> NAME declarations
      const bindingRe = /@group\((\d+)\)\s+@binding\(\d+\)\s+var(?:<[^>]+>)?\s+(\w+)/g;
      let m;
      const groupVars = new Map(); // group -> [varName, ...]
      while ((m = bindingRe.exec(stripped)) !== null) {
        const g = parseInt(m[1], 10);
        if (!groupVars.has(g)) groupVars.set(g, []);
        groupVars.get(g).push(m[2]);
      }
      // Check if any variable in each group is actually used in the source
      // (beyond its declaration line). A variable is "used" if its name appears
      // as an identifier in a non-declaration context (e.g., function body).
      for (const [g, vars] of groupVars) {
        for (const vName of vars) {
          const useRe = new RegExp(`\\b${vName}\\b`, 'g');
          const lines = stripped.split('\n');
          let refCount = 0;
          for (const line of lines) {
            // Skip declaration lines
            if (line.includes('@group(') && line.includes(vName)) continue;
            useRe.lastIndex = 0;
            if (useRe.test(line)) { refCount++; break; }
          }
          if (refCount > 0) { activeGroups.add(g); break; }
        }
      }
    }
    return activeGroups;
  }

  _buildPipeline(key, pNode) {
    // Resolve explicit layout from @resources scope
    const resName = pNode.attrs.resources;
    const resScope = resName ? this._resourceScopes?.get(resName) : null;
    const explicitLayout = resScope
      ? this.device.createPipelineLayout({ bindGroupLayouts: [resScope.layout] })
      : 'auto';

    const useAsync = pNode.attrs.async === true || pNode.attrs.async === 'true';
    const compName = pNode.attrs.compute;
    if (compName) {
      const mod = this.shaderModules.get(compName);
      if (!mod) { this.log(`pipeline "${key}": shader "${compName}" not found`,'err'); return; }
      const pipeOverrides = pNode.attrs._overrides || {};
      const computeDesc = { module: mod, entryPoint: pNode.attrs.entry || 'main' };
      if (Object.keys(pipeOverrides).length > 0) computeDesc.constants = pipeOverrides;
      try {
        const pipelineDesc = { layout: explicitLayout, compute: computeDesc };
        if (useAsync) {
          // Async pipeline creation — non-blocking, doesn't stall GPU
          this.device.createComputePipelineAsync(pipelineDesc).then(pipeline => {
            const entryPoint = pNode.attrs.entry || 'main';
            const activeGroups = resScope ? new Set([0]) : this._getActiveBindGroups([compName], [entryPoint]);
            this.pipelines.set(key, { pipeline, type: 'compute', resourceScope: resName || null, overrides: { ...pipeOverrides }, shaderKey: compName, _name: key, activeGroups });
            this.log(`pipeline "${key}": compute ✓ (async) [active groups: ${[...activeGroups].join(',')||'none'}]`,'ok');
          }).catch(e => this.log(`pipeline "${key}": async compute FAILED: ${e.message}`,'err'));
          return;
        }
        const pipeline = this.device.createComputePipeline(pipelineDesc);
        // Detect which bind groups have bindings actually used by entry points
        // (WGSL compiler optimizes away unused bindings, leaving empty layouts)
        const entryPoint = pNode.attrs.entry || 'main';
        const activeGroups = resScope ? new Set([0]) : this._getActiveBindGroups([compName], [entryPoint]);
        this.pipelines.set(key, { pipeline, type: 'compute', resourceScope: resName || null, overrides: { ...pipeOverrides }, shaderKey: compName, _name: key, activeGroups });
        this.log(`pipeline "${key}": compute ✓ [active groups: ${[...activeGroups].join(',')||'none'}]${resScope ? ` [resources: ${resName}]` : ''}`,'ok');
      } catch(e) {
        this.log(`pipeline "${key}": compute FAILED: ${e.message}`,'err');
      }
      return;
    }
    const vn = pNode.attrs.vertex, fn = pNode.attrs.fragment || vn;
    const vm = this.shaderModules.get(vn), fm = this.shaderModules.get(fn);
    if (!vm) { this.log(`pipeline "${key}": vertex "${vn}" not found`,'err'); return; }
    if (!fm) { this.log(`pipeline "${key}": fragment "${fn}" not found`,'err'); return; }
    const vEntry = pNode.attrs['vertex-entry'] || 'vs_main';
    const fEntry = pNode.attrs['fragment-entry'] || 'fs_main';
    // Resolve target format(s) — MRT or single
    let targets;
    const targetNames = pNode.attrs.targets;
    if (Array.isArray(targetNames)) {
      targets = targetNames.map(t => ({ format: this._resolveTargetFormat(t) }));
    } else {
      targets = [{ format: this._resolveFmt(pNode.attrs.format || 'canvas') }];
    }
    const format = targets[0].format;
    const sampleCount = +(pNode.attrs.msaa || pNode.attrs['sample-count'] || 1);
    const prim = {
      topology: pNode.attrs.topology || 'triangle-list',
      cullMode: pNode.attrs.cull || 'none',
      frontFace: pNode.attrs['front-face'] || 'ccw',
    };
    if (pNode.attrs['strip-index-format']) prim.stripIndexFormat = pNode.attrs['strip-index-format'];
    if (pNode.attrs['unclipped-depth'] && this._features.has('depth-clip-control')) prim.unclippedDepth = true;

    const desc = {
      layout: explicitLayout,
      vertex: { module:vm, entryPoint:vEntry, buffers: [] },
      fragment: { module:fm, entryPoint:fEntry, targets },
      primitive: prim,
    };

    // MSAA
    if (sampleCount > 1) desc.multisample = { count: sampleCount };

    // Vertex buffer layout from @vertex-layout children
    const layouts = Rex.findAll(pNode, 'vertex-layout');
    for (const vl of layouts) {
      const attrs = [];
      for (const a of Rex.findAll(vl, 'attribute')) {
        attrs.push({
          shaderLocation: a.attrs.location || 0,
          offset: a.attrs.offset || 0,
          format: a.attrs.format || 'float32x3',
        });
      }
      desc.vertex.buffers.push({
        arrayStride: vl.attrs.stride || 12,
        stepMode: vl.attrs.step || 'vertex',
        attributes: attrs,
      });
    }

    // Depth/stencil
    const hasStencilOps = pNode.attrs['stencil-front-compare'] || pNode.attrs['stencil-back-compare'];
    if (pNode.attrs.depth === true || pNode.attrs['depth-format'] || hasStencilOps) {
      let fmt = pNode.attrs['depth-format'] || 'depth24plus';
      if (hasStencilOps && !fmt.includes('stencil')) fmt = 'depth24plus-stencil8';
      desc.depthStencil = {
        format: fmt,
        depthWriteEnabled: pNode.attrs['depth-write'] !== false,
        depthCompare: pNode.attrs['depth-compare'] || 'less',
      };
      if (hasStencilOps) {
        const parseFace = (prefix) => ({
          compare: pNode.attrs[`${prefix}-compare`] || 'always',
          passOp: pNode.attrs[`${prefix}-pass-op`] || 'keep',
          failOp: pNode.attrs[`${prefix}-fail-op`] || 'keep',
          depthFailOp: pNode.attrs[`${prefix}-depth-fail-op`] || 'keep',
        });
        desc.depthStencil.stencilFront = parseFace('stencil-front');
        desc.depthStencil.stencilBack = pNode.attrs['stencil-back-compare']
          ? parseFace('stencil-back') : parseFace('stencil-front');
        if (pNode.attrs['stencil-read-mask'] !== undefined) desc.depthStencil.stencilReadMask = +pNode.attrs['stencil-read-mask'];
        if (pNode.attrs['stencil-write-mask'] !== undefined) desc.depthStencil.stencilWriteMask = +pNode.attrs['stencil-write-mask'];
      }
      if (pNode.attrs['depth-bias'] !== undefined) desc.depthStencil.depthBias = +pNode.attrs['depth-bias'];
      if (pNode.attrs['depth-bias-slope'] !== undefined) desc.depthStencil.depthBiasSlopeScale = +pNode.attrs['depth-bias-slope'];
      if (pNode.attrs['depth-bias-clamp'] !== undefined) desc.depthStencil.depthBiasClamp = +pNode.attrs['depth-bias-clamp'];
    }

    // Blending — apply to all targets
    const blendMode = pNode.attrs.blend;
    if (blendMode) {
      const BLEND_MODES = {
        'alpha': {color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}},
        'additive': {color:{srcFactor:'src-alpha',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}},
        'multiply': {color:{srcFactor:'dst-color',dstFactor:'zero',operation:'add'},alpha:{srcFactor:'dst-alpha',dstFactor:'zero',operation:'add'}},
        'screen': {color:{srcFactor:'one',dstFactor:'one-minus-src-color',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}},
        'premultiplied': {color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}},
        'min': {color:{srcFactor:'one',dstFactor:'one',operation:'min'},alpha:{srcFactor:'one',dstFactor:'one',operation:'min'}},
        'max': {color:{srcFactor:'one',dstFactor:'one',operation:'max'},alpha:{srcFactor:'one',dstFactor:'one',operation:'max'}},
        'subtract': {color:{srcFactor:'one',dstFactor:'one',operation:'subtract'},alpha:{srcFactor:'one',dstFactor:'one',operation:'subtract'}},
        'reverse-subtract': {color:{srcFactor:'one',dstFactor:'one',operation:'reverse-subtract'},alpha:{srcFactor:'one',dstFactor:'one',operation:'reverse-subtract'}},
      };
      let blend = BLEND_MODES[blendMode];
      if (blend) for (const t of desc.fragment.targets) t.blend = blend;
      else this.log(`pipeline "${key}": unknown blend mode "${blendMode}"`,'warn');
    }
    // Custom blend via individual attrs
    if (pNode.attrs['blend-src-color']) {
      const blend = {
        color: { srcFactor: pNode.attrs['blend-src-color']||'one', dstFactor: pNode.attrs['blend-dst-color']||'zero', operation: pNode.attrs['blend-op-color']||'add' },
        alpha: { srcFactor: pNode.attrs['blend-src-alpha']||'one', dstFactor: pNode.attrs['blend-dst-alpha']||'zero', operation: pNode.attrs['blend-op-alpha']||'add' },
      };
      for (const t of desc.fragment.targets) t.blend = blend;
    }

    // Color write mask
    const writeMaskAttr = pNode.attrs['write-mask'];
    if (writeMaskAttr !== undefined) {
      let mask = 0;
      if (Array.isArray(writeMaskAttr)) {
        for (const ch of writeMaskAttr) {
          if (ch === 'r' || ch === 'red') mask |= 0x1;    // GPUColorWrite.RED
          if (ch === 'g' || ch === 'green') mask |= 0x2;  // GPUColorWrite.GREEN
          if (ch === 'b' || ch === 'blue') mask |= 0x4;   // GPUColorWrite.BLUE
          if (ch === 'a' || ch === 'alpha') mask |= 0x8;   // GPUColorWrite.ALPHA
        }
      }
      for (const t of desc.fragment.targets) t.writeMask = mask;
    }

    try {
      if (useAsync) {
        // Async pipeline creation — non-blocking, doesn't stall GPU
        this.device.createRenderPipelineAsync(desc).then(newPipeline => {
          const activeGroups = resScope ? new Set([0]) : this._getActiveBindGroups([vn, fn], [desc.vertex.entryPoint, desc.fragment.entryPoint]);
          this.pipelines.set(key, {pipeline:newPipeline, type:'render', format, resourceScope: resName || null, sampleCount, _name: key, activeGroups});
          this.log(`pipeline "${key}": render ✓ (async) [active groups: ${[...activeGroups].join(',')||'none'}]`,'ok');
        }).catch(e => this.log(`pipeline "${key}": async render FAILED: ${e.message}`,'err'));
        return;
      }
      const newPipeline = this.device.createRenderPipeline(desc);
      // Detect which bind groups have bindings actually used by entry points
      const vEntry = desc.vertex.entryPoint;
      const fEntry = desc.fragment.entryPoint;
      const activeGroups = resScope ? new Set([0]) : this._getActiveBindGroups([vn, fn], [vEntry, fEntry]);
      this.pipelines.set(key, {pipeline:newPipeline, type:'render', format, resourceScope: resName || null, sampleCount, _name: key, activeGroups});
      this.log(`pipeline "${key}": render ✓ [active groups: ${[...activeGroups].join(',')||'none'}]${sampleCount > 1 ? ` [${sampleCount}x MSAA]` : ''}${resScope ? ` [resources: ${resName}]` : ''}`,'ok');
    } catch(e) {
      this.log(`pipeline "${key}": ${e.message} — keeping last-good`,'err');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // EXECUTE PHASE
  // ════════════════════════════════════════════════════════════════

  _execute() {
    if (!this.device || !this.context) return;
    const now = performance.now()/1000, time = now - this.startTime;
    const dt = this._prevExecTime !== undefined ? Math.min(now - this._prevExecTime, 0.1) : 0.016;
    this._prevExecTime = now;
    this._frameDT = dt;
    this._updateInputBuiltins();
    this._applyBuiltins(time);
    this._updateFieldSources();

    if (this._frameDirty && this._heapBuffer) {
      const alignedMin = this._dirtyMin & ~3;
      const alignedMax = Math.min((this._dirtyMax + 3) & ~3, this._heapSize);
      const size = alignedMax - alignedMin;
      if (size > 0 && alignedMin >= 0 && alignedMin + size <= this._heapSize) {
        try {
          this.device.queue.writeBuffer(this._heapBuffer, alignedMin, this._stagingBuffers[this._writeSlot], alignedMin, size);
        } catch(e) {
          console.error(`[RPE] writeBuffer failed: offset=${alignedMin} size=${size} heapSize=${this._heapSize}`, e);
        }
        const src = new Uint8Array(this._stagingBuffers[this._writeSlot], alignedMin, size);
        const dst = new Uint8Array(this._stagingBuffers[1 - this._writeSlot], alignedMin, size);
        dst.set(src);
        this._writeSlot = 1 - this._writeSlot;
        this._heapView = this._stagingViews[this._writeSlot];
      }
      this._frameDirty = false;
      this._dirtyMin = this._heapSize;
      this._dirtyMax = 0;
    }

    // Reset per-frame mouse delta after writing to heap
    this.inputState.mouseDX = 0;
    this.inputState.mouseDY = 0;
    this.inputState.mouseWheel = 0;

    // Re-import video textures every frame
    for (const [name, vt] of this._videoTextures) {
      const el = document.getElementById(vt.elementId);
      if (el && el.readyState >= 2) {
        try {
          this._externalTextures.set(name, this.device.importExternalTexture({ source: el }));
          // Invalidate bind groups referencing this video
          for (const [k] of this._bindGroups) { if (k.includes(name)) this._bindGroups.delete(k); }
        } catch(e) { /* video not ready */ }
      }
    }
    // Rebuild resource scopes that contain video textures
    if (this._videoTextures.size > 0) {
      for (const [scopeName, scope] of this._resourceScopes) {
        if (scope.hasVideo) this._rebuildVideoScope(scopeName);
      }
    }

    // Reset query indices for this frame
    for (const [, tq] of this._querySets) { tq.nextIndex = 0; }

    const enc = this.device.createCommandEncoder();
    // Derive compute dispatch — GPU-side @derive evaluation before render passes
    this._executeDeriveDispatch(enc);
    const tv = this.context.getCurrentTexture().createView();
    this._executeCommandList(enc, tv);

    // Query resolve (before readback copies)
    for (const [, tq] of this._querySets) {
      if (tq.nextIndex > 0) {
        enc.resolveQuerySet(tq.querySet, 0, tq.nextIndex, tq.resolveBuffer, 0);
        enc.copyBufferToBuffer(tq.resolveBuffer, 0, tq.readBuffer, 0, tq.nextIndex * 8);
      }
    }

    // Readback copies (before submit) — respect mode
    for (const rb of this._readbacks) {
      if (rb.pending) continue;
      if (rb.mode === 'one-shot' && rb.lastReadFrame >= 0) continue;
      if (rb.mode === 'every' && (this.frameCount - rb.lastReadFrame) < rb.every) continue;
      enc.copyBufferToBuffer(rb.srcBuffer, rb.srcOffset, rb.staging, 0, rb.size);
    }

    this.device.queue.submit([enc.finish()]);

    // Async readback — standard buffers (with typed deserialization)
    if (this.onReadback) {
      for (const rb of this._readbacks) {
        if (rb.pending) continue;
        if (rb.mode === 'one-shot' && rb.lastReadFrame >= 0) continue;
        if (rb.mode === 'every' && (this.frameCount - rb.lastReadFrame) < rb.every) continue;
        rb.pending = true;
        rb.staging.mapAsync(GPUMapMode.READ).then(() => {
          const raw = rb.staging.getMappedRange().slice(0);
          rb.staging.unmap();
          rb.pending = false;
          rb.lastReadFrame = this.frameCount;

          let data;
          if (rb.structLayout) {
            // Optic-driven: typed deserialization
            data = this._deserializeStruct(new DataView(raw), 0, rb.structLayout);
          } else if (rb.type) {
            // Single field optic readback
            const dv = new DataView(raw);
            if (rb.type === 'f32') data = dv.getFloat32(0, true);
            else if (rb.type === 'u32') data = dv.getUint32(0, true);
            else if (rb.type === 'i32') data = dv.getInt32(0, true);
            else data = new Float32Array(raw);
          } else {
            // Legacy: raw Float32Array
            data = new Float32Array(raw);
          }

          // on-change: compare against previous value
          if (rb.mode === 'on-change') {
            const prev = this._readbackPrevValues.get(rb.name);
            const curr = JSON.stringify(data);
            if (prev === curr) return;
            this._readbackPrevValues.set(rb.name, curr);
          }

          const meta = rb.structLayout || rb.type
            ? { typed: true, toSlot: rb.toSlot || null }
            : null;
          this.onReadback(rb.name, data, meta);
        }).catch(() => { rb.pending = false; });
      }
    }

    // Async readback — query results
    for (const [name, tq] of this._querySets) {
      if (tq.readPending || tq.nextIndex === 0) continue;
      tq.readPending = true;
      tq.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = new BigUint64Array(tq.readBuffer.getMappedRange().slice(0));
        tq.readBuffer.unmap();
        tq.readPending = false;
        if (tq.type === 'timestamp' && data.length >= 2 && this.onReadback) {
          const ms = Number(data[1] - data[0]) / 1_000_000;
          this.onReadback(`${name}-timing`, new Float32Array([ms]));
        } else if (tq.type === 'occlusion' && this.onReadback) {
          const counts = new Float32Array(data.length);
          for (let i = 0; i < data.length; i++) counts[i] = Number(data[i]);
          this.onReadback(`${name}-occlusion`, counts);
        }
      }).catch(() => { tq.readPending = false; });
    }
  }

  _executeCommandList(enc, tv) {
    if (!this._commandList) return;
    this._enforceBarriers();
    const cw = this.canvas.width, ch = this.canvas.height;

    for (const cmd of this._commandList) {
      if (cmd.type === 'pass') {
        const msaa = cmd.sampleCount || 1;

        // Resolve color attachment(s)
        const colorAttachments = [];
        const buildAttachment = (resolvedView, clearVal, isFirst) => {
          if (msaa > 1) {
            // MSAA: render to multi-sample texture, resolve to actual target
            const targetFmt = resolvedView._fmt || this.format;
            const tw = resolvedView._w || cw, th = resolvedView._h || ch;
            const msaaKey = `msaa_${tw}x${th}_${targetFmt}_${msaa}`;
            if (!this._msaaTextures.has(msaaKey)) {
              this._msaaTextures.set(msaaKey, this.device.createTexture({
                size: [tw, th], format: targetFmt, sampleCount: msaa,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
              }));
            }
            return {
              view: this._msaaTextures.get(msaaKey).createView(),
              resolveTarget: resolvedView,
              clearValue: clearVal, loadOp: cmd.loadOp, storeOp: 'discard',
            };
          }
          return { view: resolvedView, clearValue: clearVal, loadOp: cmd.loadOp, storeOp: cmd.storeOp };
        };

        if (cmd.targets && Array.isArray(cmd.targets)) {
          for (let i = 0; i < cmd.targets.length; i++) {
            const tex = this._textures.get(cmd.targets[i]);
            if (!tex) { this.log(`pass: MRT target "${cmd.targets[i]}" not found`,'err'); continue; }
            const view = this._textureViews.get(cmd.targets[i]) || tex.createView();
            view._w = tex.width; view._h = tex.height; view._fmt = tex.format;
            colorAttachments.push(buildAttachment(view, i === 0 ? cmd.clearValue : {r:0,g:0,b:0,a:0}, i === 0));
          }
        } else if (cmd.target && cmd.target !== 'canvas') {
          const tex = this._textures.get(cmd.target);
          const view = tex ? (this._textureViews.get(cmd.target) || tex.createView()) : tv;
          if (tex) { view._w = tex.width; view._h = tex.height; view._fmt = tex.format; }
          else { view._w = cw; view._h = ch; view._fmt = this.format; }
          colorAttachments.push(buildAttachment(view, cmd.clearValue, true));
          if (!tex) this.log(`pass: target "${cmd.target}" not found, using canvas`,'warn');
        } else {
          tv._w = cw; tv._h = ch; tv._fmt = this.format;
          colorAttachments.push(buildAttachment(tv, cmd.clearValue, true));
        }

        const passDesc = { colorAttachments };

        // Depth/stencil attachment
        if (cmd.depthTarget) {
          const depthTex = this._textures.get(cmd.depthTarget);
          if (depthTex) {
            const depthView = (this._textureViews && this._textureViews.get(cmd.depthTarget)) || depthTex.createView();
            if (msaa > 1) {
              // MSAA depth texture
              const depthFmt = depthTex.format || 'depth24plus';
              const dw = depthTex.width, dh = depthTex.height;
              const depthMsaaKey = `msaa_depth_${dw}x${dh}_${depthFmt}_${msaa}`;
              if (!this._msaaTextures.has(depthMsaaKey)) {
                this._msaaTextures.set(depthMsaaKey, this.device.createTexture({
                  size: [dw, dh], format: depthFmt, sampleCount: msaa,
                  usage: GPUTextureUsage.RENDER_ATTACHMENT,
                }));
              }
              passDesc.depthStencilAttachment = {
                view: this._msaaTextures.get(depthMsaaKey).createView(),
                depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'discard',
                stencilClearValue: cmd.stencilClearValue || 0,
                stencilLoadOp: cmd.stencilLoadOp || 'clear',
                stencilStoreOp: cmd.stencilStoreOp || 'discard',
              };
            } else {
              passDesc.depthStencilAttachment = {
                view: depthView,
                depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
                stencilClearValue: cmd.stencilClearValue || 0,
                stencilLoadOp: cmd.stencilLoadOp || 'clear',
                stencilStoreOp: cmd.stencilStoreOp || 'store',
              };
            }
          }
        }

        // Timestamp queries
        if (cmd.query && this._querySets.has(cmd.query)) {
          const tq = this._querySets.get(cmd.query);
          if (tq.nextIndex + 1 < tq.count) {
            passDesc.timestampWrites = {
              querySet: tq.querySet,
              beginningOfPassWriteIndex: tq.nextIndex++,
              endOfPassWriteIndex: tq.nextIndex++,
            };
          }
        }

        // Occlusion query set
        if (cmd.occlusionQuery && this._querySets.has(cmd.occlusionQuery)) {
          passDesc.occlusionQuerySet = this._querySets.get(cmd.occlusionQuery).querySet;
        }

        const pass = enc.beginRenderPass(passDesc);

        // Execute bundles (mutually exclusive with inline draws)
        if (cmd.executeBundles) {
          const bundles = cmd.executeBundles.map(n => this._renderBundles.get(n)).filter(Boolean);
          if (bundles.length > 0) pass.executeBundles(bundles);
          pass.end();
          continue;
        }

        // Stencil reference
        if (cmd.stencilRef) pass.setStencilReference(cmd.stencilRef);

        for (const draw of cmd.draws) {
          // pipelineKey may be an expression object {expr:'form/key'} for dynamic pipeline selection
          let resolvedKey = draw.pipelineKey;
          if (resolvedKey && typeof resolvedKey === 'object' && resolvedKey.expr) {
            const expr = resolvedKey.expr;
            if (expr.startsWith('form/')) resolvedKey = this.formState[expr.slice(5)] ?? resolvedKey;
            else resolvedKey = String(resolvedKey);
          }
          const pe = this.pipelines.get(resolvedKey);
          if (!pe) { this.log(`draw: pipeline "${resolvedKey}" not found`,'err'); continue; }
          pass.setPipeline(pe.pipeline);
          // Auto-set resource scope bind group at group 0 if pipeline uses one
          if (pe.resourceScope && this._resourceScopes?.has(pe.resourceScope)) {
            const scope = this._resourceScopes.get(pe.resourceScope);
            if (draw.dynamicOffsets) {
              pass.setBindGroup(0, scope.bindGroup, draw.dynamicOffsets);
            } else {
              pass.setBindGroup(0, scope.bindGroup);
            }
          }
          for (const b of draw.binds) this._setBindGroup(pass, pe, b);
          // Vertex buffer
          if (draw.vertexBuffer) {
            const vb = this._vertexBuffers.get(draw.vertexBuffer);
            if (vb) pass.setVertexBuffer(0, vb);
          }

          // Occlusion query per-draw
          const useOcclusion = draw.occlusionIndex >= 0 && cmd.occlusionQuery;

          if (useOcclusion) pass.beginOcclusionQuery(draw.occlusionIndex);

          // Resolve dynamic draw counts from form state
          const dverts = this._resolveDynamic(draw.vertices, 3);
          const dinst  = this._resolveDynamic(draw.instances, 1);
          const didx   = this._resolveDynamic(draw.indexCount, 0);

          // Indirect draw
          if (draw.indirect && draw.indirectBuffer) {
            const indBuf = this._storageBuffers.get(draw.indirectBuffer);
            if (!indBuf) { this.log(`draw: indirect buffer "${draw.indirectBuffer}" not found`,'err'); if (useOcclusion) pass.endOcclusionQuery(); continue; }
            if (draw.indexBuffer && didx > 0) {
              const ib = this._indexBuffers.get(draw.indexBuffer);
              if (ib) { pass.setIndexBuffer(ib, 'uint32'); pass.drawIndexedIndirect(indBuf, draw.indirectOffset); }
            } else {
              pass.drawIndirect(indBuf, draw.indirectOffset);
            }
          }
          // Index buffer (direct)
          else if (draw.indexBuffer && didx > 0) {
            const ib = this._indexBuffers.get(draw.indexBuffer);
            if (ib) {
              pass.setIndexBuffer(ib, 'uint32');
              pass.drawIndexed(didx, dinst, 0, 0, 0);
            } else {
              pass.draw(dverts, dinst, 0, 0);
            }
          } else {
            pass.draw(dverts, dinst, 0, 0);
          }

          if (useOcclusion) pass.endOcclusionQuery();
        }
        pass.end();
      } else if (cmd.type === 'dispatch') {
        // Resolve dynamic dispatch pipelineKey
        let dispKey = cmd.pipelineKey;
        if (dispKey && typeof dispKey === 'object' && dispKey.expr) {
          const expr = dispKey.expr;
          if (expr.startsWith('form/')) dispKey = this.formState[expr.slice(5)] ?? dispKey;
          else dispKey = String(dispKey);
        }
        const pe = this.pipelines.get(dispKey);
        if (!pe || pe.type !== 'compute') continue;
        const cpDesc = {};
        // Timestamp queries for compute
        if (cmd.query && this._querySets.has(cmd.query)) {
          const tq = this._querySets.get(cmd.query);
          if (tq.nextIndex + 1 < tq.count) {
            cpDesc.timestampWrites = {
              querySet: tq.querySet,
              beginningOfPassWriteIndex: tq.nextIndex++,
              endOfPassWriteIndex: tq.nextIndex++,
            };
          }
        }
        const cp = enc.beginComputePass(cpDesc);
        cp.setPipeline(pe.pipeline);
        // Auto-set resource scope bind group at group 0 if pipeline uses one
        if (pe.resourceScope && this._resourceScopes?.has(pe.resourceScope)) {
          cp.setBindGroup(0, this._resourceScopes.get(pe.resourceScope).bindGroup);
        }
        for (const b of cmd.binds) {
          this._setBindGroup(cp, pe, b);
        }
        // Indirect compute dispatch
        if (cmd.indirect && cmd.indirectBuffer) {
          const indBuf = this._storageBuffers.get(cmd.indirectBuffer);
          if (indBuf) cp.dispatchWorkgroupsIndirect(indBuf, cmd.indirectOffset);
          else this.log(`dispatch: indirect buffer "${cmd.indirectBuffer}" not found`,'err');
        } else {
          const g = this._resolveDynamic(cmd.grid, [1,1,1]);
          cp.dispatchWorkgroups(
            Math.max(1, this._resolveDynamic(g[0], 1)),
            Math.max(1, this._resolveDynamic(g[1], 1)),
            Math.max(1, this._resolveDynamic(g[2], 1))
          );
        }
        cp.end();
      } else {
        const h = this._commandHandlers.get(cmd.type);
        if (h && h.execute) h.execute(cmd, enc, this);
      }
    }
  }

  _setBindGroup(pass, pe, bindDef) {
    const group = bindDef.group || 0;

    // Skip bind groups for shader groups whose bindings were optimized away
    // by the WGSL compiler (no variable in that group is actually used)
    if (pe.activeGroups && !pe.activeGroups.has(group)) return;

    const entries = [];
    const pipeKey = pe._name || '';

    // Uniform buffer from heap
    if (bindDef.buffer) {
      const hl = this._heapLayout.get(bindDef.buffer);
      if (hl && this._heapBuffer) {
        entries.push({ binding: entries.length, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
      }
    }

    // Storage buffer(s) — supports single name or array of names
    if (bindDef.storage) {
      const storageNames = Array.isArray(bindDef.storage) ? bindDef.storage : [bindDef.storage];
      for (const sName of storageNames) {
        const sb = this._storageBuffers.get(sName);
        if (sb) {
          entries.push({ binding: entries.length, resource: { buffer: sb } });
        }
      }
    }

    // Texture + sampler
    if (bindDef.texture) {
      const tex = this._textures.get(bindDef.texture);
      const sampEntry = this._samplers.get(bindDef.sampler || bindDef.texture);
      if (sampEntry) entries.push({ binding: entries.length, resource: sampEntry.sampler });
      if (tex) entries.push({ binding: entries.length, resource: (this._textureViews && this._textureViews.get(bindDef.texture)) || tex.createView() });
    }

    if (entries.length === 0) {
      // Fall back to legacy heap-only bind
      if (bindDef.buffer) {
        const hl = this._heapLayout.get(bindDef.buffer);
        if (!hl || !this._heapBuffer) return;
        entries.push({ binding: 0, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
      } else {
        return; // nothing to bind
      }
    }

    // Cache key includes pipeline name to prevent cross-pipeline layout mismatch
    const bgKey = `bg_${pipeKey}_${group}_${bindDef.buffer||''}_${bindDef.storage||''}_${bindDef.texture||''}`;
    let bg = this._bindGroups.get(bgKey);
    if (!bg) {
      try {
        const layout = pe.pipeline.getBindGroupLayout(group);
        bg = this.device.createBindGroup({ layout, entries });
        this._bindGroups.set(bgKey, bg);
      } catch(e) {
        // Binding group not present in shader (optimized away) — skip silently
        this._bindGroups.set(bgKey, null); // cache the miss
        return;
      }
    }
    if (bg) pass.setBindGroup(group, bg);
  }

  _applyBuiltins(time) {
    const inp = this.inputState;
    // Reuse builtins dict across frames (only update values)
    const b = this._builtinsDict || (this._builtinsDict = {});
    let gpuCtx = null; // lazily created for Rex.evalExpr
    b['elapsed'] = time; b['time'] = time;
    b['frame'] = this.frameCount;
    b['frame-dt'] = this._frameDT || 0.016;
    b['canvas-w'] = this.canvas.width; b['canvas-h'] = this.canvas.height;
    b['mouse-x'] = inp.mouseX; b['mouse-y'] = inp.mouseY;
    b['mouse-dx'] = inp.mouseDX; b['mouse-dy'] = inp.mouseDY;
    b['mouse-buttons'] = inp.mouseButtons;
    b['mouse-wheel'] = inp.mouseWheel;
    b['move-x'] = inp.moveX; b['move-y'] = inp.moveY; b['move-z'] = inp.moveZ;
    b['pointer-locked'] = inp.pointerLocked ? 1 : 0;
    b['key-w'] = inp.keys.has('KeyW') ? 1 : 0;
    b['key-a'] = inp.keys.has('KeyA') ? 1 : 0;
    b['key-s'] = inp.keys.has('KeyS') ? 1 : 0;
    b['key-d'] = inp.keys.has('KeyD') ? 1 : 0;
    b['key-space'] = inp.keys.has('Space') ? 1 : 0;
    b['key-shift'] = (inp.keys.has('ShiftLeft') || inp.keys.has('ShiftRight')) ? 1 : 0;
    b['key-q'] = inp.keys.has('KeyQ') ? 1 : 0;
    b['key-e'] = inp.keys.has('KeyE') ? 1 : 0;

    for (const op of this._builtinOptics) {
      // Bounds check for all special-case writes
      if (op.heapOffset < 0 || op.heapOffset >= this._heapSize) continue;
      // Enum-dispatched special cases (no string comparison per frame)
      switch (op.special) {
        case 1: { // canvas-size
          if (op.heapOffset + 8 > this._heapSize) continue;
          const oldW = this._heapView.getFloat32(op.heapOffset, true);
          const oldH = this._heapView.getFloat32(op.heapOffset + 4, true);
          const newW = this.canvas.width, newH = this.canvas.height;
          if (oldW !== newW || oldH !== newH) {
            this._heapView.setFloat32(op.heapOffset, newW, true);
            this._heapView.setFloat32(op.heapOffset + 4, newH, true);
            this._markDirty(op.heapOffset, 8);
          }
          continue;
        }
        case 2: { // mouse-pos
          if (op.heapOffset + 8 > this._heapSize) continue;
          const omx = this._heapView.getFloat32(op.heapOffset, true);
          const omy = this._heapView.getFloat32(op.heapOffset + 4, true);
          if (omx !== inp.mouseX || omy !== inp.mouseY) {
            this._heapView.setFloat32(op.heapOffset, inp.mouseX, true);
            this._heapView.setFloat32(op.heapOffset + 4, inp.mouseY, true);
            this._markDirty(op.heapOffset, 8);
          }
          continue;
        }
        case 3: { // mouse-delta
          if (op.heapOffset + 8 > this._heapSize) continue;
          const odx = this._heapView.getFloat32(op.heapOffset, true);
          const ody = this._heapView.getFloat32(op.heapOffset + 4, true);
          if (odx !== inp.mouseDX || ody !== inp.mouseDY) {
            this._heapView.setFloat32(op.heapOffset, inp.mouseDX, true);
            this._heapView.setFloat32(op.heapOffset + 4, inp.mouseDY, true);
            this._markDirty(op.heapOffset, 8);
          }
          continue;
        }
        case 4: { // move-dir
          if (op.heapOffset + 12 > this._heapSize) continue;
          const omvx = this._heapView.getFloat32(op.heapOffset, true);
          const omvy = this._heapView.getFloat32(op.heapOffset + 4, true);
          const omvz = this._heapView.getFloat32(op.heapOffset + 8, true);
          if (omvx !== inp.moveX || omvy !== inp.moveY || omvz !== inp.moveZ) {
            this._heapView.setFloat32(op.heapOffset, inp.moveX, true);
            this._heapView.setFloat32(op.heapOffset + 4, inp.moveY, true);
            this._heapView.setFloat32(op.heapOffset + 8, inp.moveZ, true);
            this._markDirty(op.heapOffset, 12);
          }
          continue;
        }
      }

      // General case: evaluate pre-compiled expression AST (no string parsing)
      if (!gpuCtx) gpuCtx = this._makeGpuEvalContext(b);
      const val = op.compiled ? Rex.evalExpr(op.compiled, gpuCtx) : 0;
      if (val === undefined) continue;
      const prev = this._readFromHeap(op.heapOffset, op.type);
      if (!this._valEqual(prev, val)) {
        this._writeToHeap(op.heapOffset, op.type, val);
      }
    }
  }

  _valEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    return false;
  }

  _writeToHeap(offset, type, value) {
    if (!this._heapView) return;
    const v = this._heapView;
    const size = this._typeSize(type);
    // Bounds check — prevent writing past heap
    if (offset < 0 || offset + size > this._heapSize) return;
    if (type === 'f32') { v.setFloat32(offset, Number(value)||0, true); }
    else if (type === 'f32x2') { const a=Array.isArray(value)?value:[0,0]; v.setFloat32(offset,Number(a[0])||0,true); v.setFloat32(offset+4,Number(a[1])||0,true); }
    else if (type === 'f32x3') { const a=Array.isArray(value)?value:[0,0,0]; for(let i=0;i<3;i++)v.setFloat32(offset+i*4,Number(a[i])||0,true); }
    else if (type === 'f32x4') { const a=Array.isArray(value)?value:[0,0,0,0]; for(let i=0;i<4;i++)v.setFloat32(offset+i*4,Number(a[i])||0,true); }
    else if (type === 'u32') { v.setUint32(offset, Number(value)||0, true); }
    else if (type === 'i32') { v.setInt32(offset, Number(value)||0, true); }
    this._markDirty(offset, size);
  }

  _markDirty(offset, size) {
    // Clamp to heap bounds
    const end = Math.min(offset + size, this._heapSize);
    if (offset < 0) offset = 0;
    if (end <= offset) return;
    if (!this._frameDirty) {
      this._dirtyMin = offset;
      this._dirtyMax = end;
      this._frameDirty = true;
    } else {
      this._dirtyMin = Math.min(this._dirtyMin, offset);
      this._dirtyMax = Math.max(this._dirtyMax, end);
    }
  }

  _readFromHeap(offset, type) {
    if (!this._heapView) return 0;
    const v = this._heapView;
    if (type === 'f32') return v.getFloat32(offset, true);
    if (type === 'u32') return v.getUint32(offset, true);
    if (type === 'i32') return v.getInt32(offset, true);
    if (type === 'f32x2') return [v.getFloat32(offset, true), v.getFloat32(offset+4, true)];
    if (type === 'f32x3') return [v.getFloat32(offset, true), v.getFloat32(offset+4, true), v.getFloat32(offset+8, true)];
    if (type === 'f32x4') return [v.getFloat32(offset, true), v.getFloat32(offset+4, true), v.getFloat32(offset+8, true), v.getFloat32(offset+12, true)];
    return 0;
  }

  setFormField(name, value) {
    this.formState[name] = value;
    const targets = this._formOptics.get(name);
    if (targets) {
      for (const t of targets) this._writeToHeap(t.heapOffset, t.type, value);
    }
  }

  // Channel push: write a value to a specific buffer/field by name
  setChannelValue(bufferName, fieldName, value) {
    const hl = this._heapLayout.get(bufferName);
    if (!hl || !hl.structDef) return;
    const field = hl.structDef.layout.find(f => f.name === fieldName);
    if (!field) return;
    this._writeToHeap(hl.offset + field.offset, field.type, value);
  }

  _resolveDrawValue(val) {
    if (val===undefined||val===null) return val;
    if (typeof val==='number') return val;
    if (Array.isArray(val)) return val.map(v=>this._resolveDrawValue(v));
    return Number(val)||0;
  }

  // Runtime resolver — handles {expr:'form/key'} objects against live formState.
  // Used for draw counts, grid sizes, and other per-frame dynamic values.
  _resolveDynamic(val, fallback) {
    if (val===undefined||val===null) return fallback;
    if (typeof val==='number') return val;
    if (typeof val==='object' && val.expr) {
      const expr = val.expr;
      if (expr.startsWith('form/')) {
        const v = this.formState[expr.slice(5)];
        return v !== undefined ? Math.max(0, Math.floor(+v)) : fallback;
      }
      return fallback;
    }
    if (Array.isArray(val)) return val.map((v,i) => this._resolveDynamic(v, Array.isArray(fallback)?fallback[i]:fallback));
    return Number(val) || fallback;
  }

  _buildHeapInfo() {
    let info = `<div class="heap-section">UNIFORM HEAP: ${this._heapSize}B \u2014 1 GPU + 2 staging (double-buffered)</div>`;
    for (const [name, hl] of this._heapLayout) {
      info += `<div class="heap-section" style="margin-top:8px">@buffer ${name} [${hl.offset}..${hl.offset+hl.size}]</div>`;
      if (hl.structDef) {
        for (const f of hl.structDef.layout) {
          const absOff = hl.offset + f.offset;
          const op = this._optics.find(o => o.heapOffset === absOff);
          const src = op ? (op.source === 'form' ? `\u2190 form/${op.key}` : op.source === 'builtin' ? `\u2190 (${op.key})` : `= ${op.constVal}`) : '';
          info += `<div class="heap-row"><span class="heap-offset">${absOff}</span><span class="heap-name">${f.name}</span><span class="heap-type">${f.type}</span><span class="heap-val">${src}</span></div>`;
        }
      }
    }
    if (this._storageBuffers.size > 0) {
      info += `<div class="heap-section" style="margin-top:8px">STORAGE BUFFERS</div>`;
      for (const [name] of this._storageBuffers) {
        info += `<div class="heap-row"><span class="heap-name">${name}</span><span class="heap-type">storage</span></div>`;
      }
    }
    if (this._textures.size > 0) {
      info += `<div class="heap-section" style="margin-top:8px">TEXTURES</div>`;
      for (const [name] of this._textures) {
        info += `<div class="heap-row"><span class="heap-name">${name}</span><span class="heap-type">texture</span></div>`;
      }
    }
    if (this._barrierSchedule.length > 0) {
      info += `<div class="heap-section" style="margin-top:8px">BARRIER SCHEDULE</div>`;
      for (const b of this._barrierSchedule) {
        info += `<div class="barrier-entry">${b.afterPass} \u2192 ${b.beforePass}: ${b.before} \u25b8 ${b.after} [${b.hazards}]</div>`;
      }
    }
    if (this._aliasingPlan.length > 0) {
      info += `<div class="heap-section" style="margin-top:8px">RESOURCE ALIASING</div>`;
      for (const a of this._aliasingPlan) {
        info += `<div class="alias-entry">${a.resource} \u2194 ${a.sharedWith} (${(a.size/1024/1024).toFixed(1)}MB shared)</div>`;
      }
    }
    if (this._features.size > 0) {
      info += `<div class="heap-section" style="margin-top:8px">GPU FEATURES</div>`;
      for (const f of this._features) {
        info += `<div class="heap-row"><span class="heap-name">${f}</span></div>`;
      }
    }
    this._heapInfo = info;
  }

  _resolveFmt(f) { if(f==='canvas'||f==='canvas-format')return this.format; return f; }
  _resolveTargetFormat(nameOrFmt) {
    const tex = this._textures.get(nameOrFmt);
    if (tex) return tex.format;
    return this._resolveFmt(nameOrFmt);
  }
  _typeSize(t) { const s={'f32':4,'i32':4,'u32':4,'f32x2':8,'f32x3':12,'f32x4':16,'f32x4x4':64}; return s[t]||4; }
  _toWGSL(t) { const m={'f32':'f32','i32':'i32','u32':'u32','f32x2':'vec2f','f32x3':'vec3f','f32x4':'vec4f','f32x4x4':'mat4x4f'}; return m[t]||'f32'; }
}
