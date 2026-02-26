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
  }

  registerCompileType(typeName, handler) { this._compileHandlers.set(typeName, handler); }
  registerCommandType(typeName, handler) { this._commandHandlers.set(typeName, handler); }
  registerResourceType(typeName, handler) { this._resourceHandlers.set(typeName, handler); }
  registerInputKey(code) { this._inputKeys.add(code); }
  registerKeyBinding(code, axis, value) { this._inputKeys.add(code); this._keyBindings.set(code, {axis, value}); }

  async init() {
    if (!navigator.gpu) { this.log('WebGPU not available','err'); return false; }
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) { this.log('No GPU adapter','err'); return false; }

    // Feature probing — request all useful features the adapter supports
    const DESIRED = [
      'timestamp-query','shader-f16','float32-filterable',
      'indirect-first-instance','bgra8unorm-storage',
      'rg11b10ufloat-renderable','depth-clip-control',
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
      maxComputeWorkgroupsPerDimension: dl.maxComputeWorkgroupsPerDimension,
      maxStorageBuffersPerShaderStage: dl.maxStorageBuffersPerShaderStage,
      maxUniformBufferBindingSize: dl.maxUniformBufferBindingSize,
    };

    if (available.length > 0) this.log('GPU features: '+available.join(', '),'ok');
    this.log(`GPU limits: ${(dl.maxBufferSize/1048576)|0}MB buf, ${dl.maxTextureDimension2D}px tex, ${dl.maxStorageBuffersPerShaderStage} storage/stage`, 'ok');
    this.log('WebGPU initialized \u00b7 format: '+this.format, 'ok');
    this._setupInput();
    return true;
  }

  hasFeature(name) { return this._features.has(name); }
  getLimit(name) { return this._limits?.[name] ?? 0; }

  // ════════════════════════════════════════════════════════════════
  // INPUT SYSTEM — WASD, mouse, pointer lock
  // ════════════════════════════════════════════════════════════════

  _setupInput() {
    const c = this.canvas;

    // Keyboard — preventDefault for keys the input system handles
    this._inputKeys = new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE',
      'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight']);
    this._keyBindings = new Map(); // code → {axis, value} for custom movement mappings
    c.addEventListener('keydown', e => {
      this.inputState.keys.add(e.code);
      if (this._inputKeys.has(e.code)) e.preventDefault();
    });
    c.addEventListener('keyup', e => {
      this.inputState.keys.delete(e.code);
    });

    // Mouse move (works with or without pointer lock)
    c.addEventListener('mousemove', e => {
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
    if (structureChanged) this._compile(tree);
    this._execute();
    this.frameCount++;
  }

  invalidate() {
    this._bindGroups.clear();
    this._structureChanged = true;
    this._frameDirty = true;
    this._dirtyMin = 0;
    this._dirtyMax = this._heapSize||256;
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
  }

  // ════════════════════════════════════════════════════════════════
  // COMPILE PHASE
  // ════════════════════════════════════════════════════════════════

  _compile(tree) {
    this.log('\u2500\u2500 COMPILE PHASE \u2500\u2500','cmd');
    this._warnedTypes.clear();

    // 0. Shared libs — compile @lib nodes into importable WGSL
    this._compileLibs(tree);

    // 1. Structs
    this._compileStructs(tree);

    // 2. Shaders (resolve #import for structs AND libs)
    this._compileShaders(tree);

    // 3. Heap layout
    this._compileHeapLayout(tree);

    // 4. Optics
    this._compileOptics(tree);

    // 5. Allocate heap
    this._allocateHeap(tree);

    // 6. Storage buffers
    this._compileStorageBuffers(tree);

    // 7. Textures
    this._compileTextures(tree);

    // 8. Vertex/Index buffers
    this._compileVertexBuffers(tree);

    // 8.5. Resource scopes (@resources → shared bind group layouts)
    this._compileResourceScopes(tree);

    // 9. Pipelines (with vertex layout support + resource scopes)
    for (const p of Rex.findAll(tree,'pipeline')) this._buildPipeline(p.name, p);

    // 10. Barrier schedule
    this._compileBarrierSchedule(tree);

    // 11. Resource aliasing
    this._compileAliasingPlan(tree);

    // 12. Command list
    this._compileCommandList(tree);

    // 13. Write defaults
    this._writeDefaults();

    // 14. Readback descriptors
    this._compileReadbacks(tree);

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
    for (const node of Rex.findAll(tree, 'readback')) {
      const from = node.attrs.from;    // buffer name
      const offset = +(node.attrs.offset || 0);
      const count = +(node.attrs.count || 1);   // number of f32s to read
      const size = count * 4;
      const srcBuf = this._storageBuffers.get(from);
      if (!srcBuf) { this.log(`readback "${node.name||'?'}": buffer "${from}" not found`, 'err'); continue; }
      const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this._readbacks.push({ name: node.name || from, srcBuffer: srcBuf, srcOffset: offset, size, staging, pending: false });
      this.log(`readback: "${node.name||from}" ${count} floats from "${from}"+${offset}`, 'ok');
    }
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

  _compileShaders(tree) {
    this._shaderEntries = new Map();
    for (const s of Rex.findAll(tree,'shader')) {
      const key = s.name || s.type;
      let code = s.content?.trim();
      if (!code) { this.log(`shader "${key}" has no content`,'warn'); continue; }
      // Resolve #import — structs, libs, or shared shaders
      code = code.replace(/^[ \t]*#import\s+(\S+).*$/gm, (_, name) => {
        if (this._wgslStructs.has(name)) return this._wgslStructs.get(name);
        if (this._wgslLibs.has(name)) return this._wgslLibs.get(name);
        this.log(`shader "${key}": #import ${name} not found`,'warn');
        return `// #import ${name} \u2014 NOT FOUND`;
      });
      try {
        const mod = this.device.createShaderModule({code});
        this.shaderModules.set(key, mod);
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
      resolve(op, key) {
        if (op === 'ident') return builtins[key] !== undefined ? builtins[key] : Number(key) || 0;
        if (op === 'slot') {
          // /form/key → form state lookup
          if (key.startsWith('form/')) return formState[key.slice(5)] ?? 0;
          return builtins[key] !== undefined ? builtins[key] : 0;
        }
        if (op === 'dep') return builtins[key] !== undefined ? builtins[key] : 0;
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
      const usage = b.attrs.usage;
      if (!usage || !Array.isArray(usage) || !usage.includes('storage')) continue;
      const size = b.attrs.size || 1024;
      let gpuUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      if (usage.includes('indirect')) gpuUsage |= GPUBufferUsage.INDIRECT;
      const gpuBuf = this.device.createBuffer({ size, usage: gpuUsage });
      this._storageBuffers.set(b.name, gpuBuf);
      this.log(`storage buffer: "${b.name}" ${size}B${usage.includes('indirect')?' [indirect]':''}`,'ok');
    }
  }

  // ── Textures ──
  _compileTextures(tree) {
    for (const [,t] of this._textures) t.destroy();
    this._textures.clear();
    this._textureViews = new Map(); // Phase 3A: cached texture views
    this._samplers.clear();
    const generation = ++this._loadGeneration;

    for (const tex of Rex.findAll(tree, 'texture')) {
      const name = tex.name;
      const fmt = tex.attrs.format || 'rgba8unorm';
      const isDepth = fmt.startsWith('depth');
      const hasSrc = !!tex.attrs.src && !isDepth;
      const w = tex.attrs.width || (hasSrc ? 4 : 256);
      const h = tex.attrs.height || (hasSrc ? 4 : 256);
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
                    (tex.attrs.render ? GPUTextureUsage.RENDER_ATTACHMENT : 0) |
                    (tex.attrs.storage ? GPUTextureUsage.STORAGE_BINDING : 0);

      const gpuTex = this.device.createTexture({
        size: [w, h], format: fmt, usage,
      });
      this._textures.set(name, gpuTex);
      this._textureViews.set(name, gpuTex.createView()); // Cache view at compile time

      // Create matching sampler
      const filterMode = tex.attrs.filter || 'linear';
      const addressMode = tex.attrs.wrap || 'repeat';
      const sampler = this.device.createSampler({
        magFilter: filterMode, minFilter: filterMode,
        addressModeU: addressMode, addressModeV: addressMode,
      });
      this._samplers.set(name, sampler);

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

      this.log(`texture: "${name}" ${w}x${h} ${fmt}${hasSrc?' [loading]':''}`,'ok');
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
      const newTex = this.device.createTexture({
        size: [w, h], format: fmt,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               (attrs.render ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap }, { texture: newTex }, [w, h]
      );
      bitmap.close();
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
  _compileResourceScopes(tree) {
    this._resourceScopes = new Map();
    for (const res of Rex.findAll(tree, 'resources')) {
      const name = res.name;
      if (!name) continue;
      const entries = [];
      const layoutEntries = [];
      let binding = 0;

      for (const child of res.children) {
        if (child.type === 'buffer') {
          const usage = child.attrs.usage;
          const isStorage = usage && Array.isArray(usage) && usage.includes('storage');
          const bufName = child.name;

          if (isStorage) {
            const sb = this._storageBuffers.get(bufName);
            if (sb) {
              layoutEntries.push({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
              entries.push({ binding, resource: { buffer: sb } });
              binding++;
            }
          } else {
            const hl = this._heapLayout.get(bufName);
            if (hl && this._heapBuffer) {
              layoutEntries.push({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: hl.size } });
              entries.push({ binding, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } });
              binding++;
            }
          }
        } else if (child.type === 'texture') {
          const texName = child.name;
          const tex = this._textures.get(texName);
          const samp = this._samplers.get(texName);
          const isStorageTex = child.attrs.storage === true || child.attrs.usage === 'storage';
          if (isStorageTex) {
            // Writable storage texture (texture_storage_2d)
            if (tex) {
              const storageFmt = child.attrs.format || 'rgba8unorm';
              layoutEntries.push({ binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: storageFmt } });
              entries.push({ binding, resource: (this._textureViews && this._textureViews.get(texName)) || tex.createView() });
              binding++;
            }
          } else {
            // Sampled texture + sampler
            if (samp) {
              layoutEntries.push({ binding, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: {} });
              entries.push({ binding, resource: samp });
              binding++;
            }
            if (tex) {
              layoutEntries.push({ binding, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: {} });
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
        this._resourceScopes.set(name, { layout, bindGroup, entries: layoutEntries.length });
        this.log(`resources: "${name}" ${layoutEntries.length} bindings`, 'ok');
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
        };
        for (const child of node.children) {
          if (child.type === 'draw') {
            const draw = {
              pipelineKey: child.attrs.pipeline,
              vertices: this._resolveDrawValue(child.attrs.vertices)||3,
              instances: this._resolveDrawValue(child.attrs.instances)||1,
              binds: [],
              vertexBuffer: child.attrs['vertex-buffer'] || null,
              indexBuffer: child.attrs['index-buffer'] || null,
              indexCount: this._resolveDrawValue(child.attrs['index-count']) || 0,
              indirect: child.attrs.indirect === true,
              indirectBuffer: child.attrs['indirect-buffer'] || null,
              indirectOffset: this._resolveDrawValue(child.attrs['indirect-offset']) || 0,
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
        this._commandList.push(passCmd);
        return;
      }
      case 'dispatch': {
        const grid = node.attrs.grid || [1,1,1];
        const dispCmd = {
          type: 'dispatch',
          pipelineKey: node.attrs.pipeline,
          grid: [this._resolveDrawValue(grid[0])||1, this._resolveDrawValue(grid[1])||1, this._resolveDrawValue(grid[2])||1],
          binds: [],
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

  _buildPipeline(key, pNode) {
    // Resolve explicit layout from @resources scope
    const resName = pNode.attrs.resources;
    const resScope = resName ? this._resourceScopes?.get(resName) : null;
    const explicitLayout = resScope
      ? this.device.createPipelineLayout({ bindGroupLayouts: [resScope.layout] })
      : 'auto';

    const compName = pNode.attrs.compute;
    if (compName) {
      const mod = this.shaderModules.get(compName);
      if (!mod) { this.log(`pipeline "${key}": shader "${compName}" not found`,'err'); return; }
      const pipeline = this.device.createComputePipeline({ layout: explicitLayout, compute:{module:mod, entryPoint:pNode.attrs.entry||'main'} });
      this.pipelines.set(key, {pipeline, type:'compute', resourceScope: resName || null});
      this.log(`pipeline "${key}": compute \u2713${resScope ? ` [resources: ${resName}]` : ''}`,'ok');
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
    const desc = {
      layout: explicitLayout,
      vertex: { module:vm, entryPoint:vEntry, buffers: [] },
      fragment: { module:fm, entryPoint:fEntry, targets },
      primitive: { topology: (pNode.attrs.topology||'triangle-list'), cullMode: pNode.attrs.cull || 'none' },
    };

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

    // Depth stencil
    if (pNode.attrs.depth === true || pNode.attrs['depth-format']) {
      desc.depthStencil = {
        format: pNode.attrs['depth-format'] || 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: pNode.attrs['depth-compare'] || 'less',
      };
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
      };
      const blend = BLEND_MODES[blendMode];
      if (blend) for (const t of desc.fragment.targets) t.blend = blend;
      else this.log(`pipeline "${key}": unknown blend mode "${blendMode}"`,'warn');
    }

    try {
      const newPipeline = this.device.createRenderPipeline(desc);
      this.pipelines.set(key, {pipeline:newPipeline, type:'render', format, resourceScope: resName || null});
      this.log(`pipeline "${key}": render \u2713${resScope ? ` [resources: ${resName}]` : ''}`,'ok');
    } catch(e) {
      this.log(`pipeline "${key}": ${e.message} \u2014 keeping last-good`,'err');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // EXECUTE PHASE
  // ════════════════════════════════════════════════════════════════

  _execute() {
    if (!this.device || !this.context) return;
    const now = performance.now()/1000, time = now - this.startTime;
    this._updateInputBuiltins();
    this._applyBuiltins(time);

    if (this._frameDirty && this._heapBuffer) {
      const alignedMin = this._dirtyMin & ~3;
      const alignedMax = (this._dirtyMax + 3) & ~3;
      const size = Math.min(alignedMax - alignedMin, this._heapSize - alignedMin);
      if (size > 0) {
        this.device.queue.writeBuffer(this._heapBuffer, alignedMin, this._stagingBuffers[this._writeSlot], alignedMin, size);
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

    const enc = this.device.createCommandEncoder();
    const tv = this.context.getCurrentTexture().createView();
    this._executeCommandList(enc, tv);

    // Readback copies (before submit)
    for (const rb of this._readbacks) {
      if (!rb.pending) enc.copyBufferToBuffer(rb.srcBuffer, rb.srcOffset, rb.staging, 0, rb.size);
    }

    this.device.queue.submit([enc.finish()]);

    // Async readback
    if (this.onReadback) {
      for (const rb of this._readbacks) {
        if (rb.pending) continue;
        rb.pending = true;
        rb.staging.mapAsync(GPUMapMode.READ).then(() => {
          const data = new Float32Array(rb.staging.getMappedRange().slice(0));
          rb.staging.unmap();
          rb.pending = false;
          this.onReadback(rb.name, data);
        }).catch(() => { rb.pending = false; });
      }
    }
  }

  _executeCommandList(enc, tv) {
    if (!this._commandList) return;
    for (const cmd of this._commandList) {
      if (cmd.type === 'pass') {
        // Resolve color attachment(s)
        const colorAttachments = [];
        if (cmd.targets && Array.isArray(cmd.targets)) {
          for (let i = 0; i < cmd.targets.length; i++) {
            const tex = this._textures.get(cmd.targets[i]);
            if (!tex) { this.log(`pass: MRT target "${cmd.targets[i]}" not found`,'err'); continue; }
            colorAttachments.push({
              view: this._textureViews.get(cmd.targets[i]) || tex.createView(),
              clearValue: i === 0 ? cmd.clearValue : {r:0,g:0,b:0,a:0},
              loadOp: cmd.loadOp, storeOp: cmd.storeOp,
            });
          }
        } else if (cmd.target && cmd.target !== 'canvas') {
          const tex = this._textures.get(cmd.target);
          colorAttachments.push({
            view: tex ? (this._textureViews.get(cmd.target) || tex.createView()) : tv,
            clearValue: cmd.clearValue, loadOp: cmd.loadOp, storeOp: cmd.storeOp,
          });
          if (!tex) this.log(`pass: target "${cmd.target}" not found, using canvas`,'warn');
        } else {
          colorAttachments.push({
            view: tv, clearValue: cmd.clearValue,
            loadOp: cmd.loadOp, storeOp: cmd.storeOp,
          });
        }

        const passDesc = { colorAttachments };

        // Depth attachment
        if (cmd.depthTarget) {
          const depthTex = this._textures.get(cmd.depthTarget);
          if (depthTex) {
            passDesc.depthStencilAttachment = {
              view: (this._textureViews && this._textureViews.get(cmd.depthTarget)) || depthTex.createView(),
              depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
            };
          }
        }

        const pass = enc.beginRenderPass(passDesc);
        for (const draw of cmd.draws) {
          const pe = this.pipelines.get(draw.pipelineKey);
          if (!pe) continue;
          pass.setPipeline(pe.pipeline);
          // Auto-set resource scope bind group at group 0 if pipeline uses one
          if (pe.resourceScope && this._resourceScopes?.has(pe.resourceScope)) {
            pass.setBindGroup(0, this._resourceScopes.get(pe.resourceScope).bindGroup);
          }
          for (const b of draw.binds) this._setBindGroup(pass, pe, b);
          // Vertex buffer
          if (draw.vertexBuffer) {
            const vb = this._vertexBuffers.get(draw.vertexBuffer);
            if (vb) pass.setVertexBuffer(0, vb);
          }
          // Indirect draw
          if (draw.indirect && draw.indirectBuffer) {
            const indBuf = this._storageBuffers.get(draw.indirectBuffer);
            if (!indBuf) { this.log(`draw: indirect buffer "${draw.indirectBuffer}" not found`,'err'); continue; }
            if (draw.indexBuffer && draw.indexCount > 0) {
              const ib = this._indexBuffers.get(draw.indexBuffer);
              if (ib) { pass.setIndexBuffer(ib, 'uint32'); pass.drawIndexedIndirect(indBuf, draw.indirectOffset); }
            } else {
              pass.drawIndirect(indBuf, draw.indirectOffset);
            }
            continue;
          }
          // Index buffer (direct)
          if (draw.indexBuffer && draw.indexCount > 0) {
            const ib = this._indexBuffers.get(draw.indexBuffer);
            if (ib) {
              pass.setIndexBuffer(ib, 'uint32');
              pass.drawIndexed(draw.indexCount, draw.instances, 0, 0, 0);
              continue;
            }
          }
          pass.draw(draw.vertices, draw.instances, 0, 0);
        }
        pass.end();
      } else if (cmd.type === 'dispatch') {
        const pe = this.pipelines.get(cmd.pipelineKey);
        if (!pe || pe.type !== 'compute') continue;
        const cp = enc.beginComputePass();
        cp.setPipeline(pe.pipeline);
        // Auto-set resource scope bind group at group 0 if pipeline uses one
        if (pe.resourceScope && this._resourceScopes?.has(pe.resourceScope)) {
          cp.setBindGroup(0, this._resourceScopes.get(pe.resourceScope).bindGroup);
        }
        for (const b of cmd.binds) {
          this._setBindGroup(cp, pe, b);
        }
        cp.dispatchWorkgroups(cmd.grid[0], cmd.grid[1], cmd.grid[2]);
        cp.end();
      } else {
        const h = this._commandHandlers.get(cmd.type);
        if (h && h.execute) h.execute(cmd, enc, this);
      }
    }
  }

  _setBindGroup(pass, pe, bindDef) {
    const group = bindDef.group || 0;
    const entries = [];

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
      const samp = this._samplers.get(bindDef.sampler || bindDef.texture);
      if (samp) entries.push({ binding: entries.length, resource: samp });
      if (tex) entries.push({ binding: entries.length, resource: (this._textureViews && this._textureViews.get(bindDef.texture)) || tex.createView() });
    }

    if (entries.length === 0) {
      // Fall back to legacy heap-only bind
      if (bindDef.buffer) {
        const hl = this._heapLayout.get(bindDef.buffer);
        if (!hl || !this._heapBuffer) return;
        const bgKey = `${group}_${bindDef.buffer}`;
        let bg = this._bindGroups.get(bgKey);
        if (!bg) {
          try {
            bg = this.device.createBindGroup({
              layout: pe.pipeline.getBindGroupLayout(group),
              entries: [{ binding: 0, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } }]
            });
            this._bindGroups.set(bgKey, bg);
          } catch(e) { return; }
        }
        pass.setBindGroup(group, bg);
      }
      return;
    }

    // Build bind group from entries (use pre-computed key or deterministic string key)
    const bgKey = bindDef._bgKey || (bindDef._bgKey = `bg_${group}_${bindDef.buffer||''}_${bindDef.storage||''}_${bindDef.texture||''}`);
    let bg = this._bindGroups.get(bgKey);
    if (!bg) {
      try {
        bg = this.device.createBindGroup({
          layout: pe.pipeline.getBindGroupLayout(group),
          entries,
        });
        this._bindGroups.set(bgKey, bg);
      } catch(e) {
        this.log(`bind group ${group}: ${e.message}`, 'err');
        return;
      }
    }
    pass.setBindGroup(group, bg);
  }

  _applyBuiltins(time) {
    const inp = this.inputState;
    // Reuse builtins dict across frames (only update values)
    const b = this._builtinsDict || (this._builtinsDict = {});
    let gpuCtx = null; // lazily created for Rex.evalExpr
    b['elapsed'] = time; b['time'] = time;
    b['frame'] = this.frameCount;
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
      // Enum-dispatched special cases (no string comparison per frame)
      switch (op.special) {
        case 1: { // canvas-size
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
        case 2: // mouse-pos
          this._heapView.setFloat32(op.heapOffset, inp.mouseX, true);
          this._heapView.setFloat32(op.heapOffset + 4, inp.mouseY, true);
          this._markDirty(op.heapOffset, 8);
          continue;
        case 3: // mouse-delta
          this._heapView.setFloat32(op.heapOffset, inp.mouseDX, true);
          this._heapView.setFloat32(op.heapOffset + 4, inp.mouseDY, true);
          this._markDirty(op.heapOffset, 8);
          continue;
        case 4: // move-dir
          this._heapView.setFloat32(op.heapOffset, inp.moveX, true);
          this._heapView.setFloat32(op.heapOffset + 4, inp.moveY, true);
          this._heapView.setFloat32(op.heapOffset + 8, inp.moveZ, true);
          this._markDirty(op.heapOffset, 12);
          continue;
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
    if (type === 'f32') { v.setFloat32(offset, Number(value)||0, true); }
    else if (type === 'f32x2') { const a=Array.isArray(value)?value:[0,0]; v.setFloat32(offset,Number(a[0])||0,true); v.setFloat32(offset+4,Number(a[1])||0,true); }
    else if (type === 'f32x3') { const a=Array.isArray(value)?value:[0,0,0]; for(let i=0;i<3;i++)v.setFloat32(offset+i*4,Number(a[i])||0,true); }
    else if (type === 'f32x4') { const a=Array.isArray(value)?value:[0,0,0,0]; for(let i=0;i<4;i++)v.setFloat32(offset+i*4,Number(a[i])||0,true); }
    else if (type === 'u32') { v.setUint32(offset, Number(value)||0, true); }
    else if (type === 'i32') { v.setInt32(offset, Number(value)||0, true); }
    this._markDirty(offset, size);
  }

  _markDirty(offset, size) {
    if (!this._frameDirty) {
      this._dirtyMin = offset;
      this._dirtyMax = offset + size;
      this._frameDirty = true;
    } else {
      this._dirtyMin = Math.min(this._dirtyMin, offset);
      this._dirtyMax = Math.max(this._dirtyMax, offset + size);
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
