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
      'float32-blendable','dual-source-blending',
      'subgroups','clip-distances',
      'depth32float-stencil8',
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
    c.addEventListener('click', () => {
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

    // 2. Shaders (resolve #import for structs AND libs, auto-inject WGSL enables)
    this._compileShaders(tree);

    // 3. Heap layout
    this._compileHeapLayout(tree);

    // 4. Optics
    this._compileOptics(tree);

    // 5. Allocate heap
    this._allocateHeap(tree);

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

  _compileShaders(tree) {
    this._shaderEntries = new Map();
    for (const s of Rex.findAll(tree,'shader')) {
      const key = s.name || s.type;
      let code = s.content?.trim();
      if (!code) { this.log(`shader "${key}" has no content`,'warn'); continue; }
      // Resolve #import — structs, libs, or shared shaders
      // Only the first struct import emits var<uniform> u (binding 0).
      // Subsequent struct imports just emit the struct body (for use in storage bindings etc).
      let uniformEmitted = false;
      // Also skip if the shader manually declares 'var<uniform> u' already
      const hasManualU = /var\s*<\s*uniform\s*>\s*u\s*:/.test(code);
      code = code.replace(/^[ \t]*#import\s+(\S+).*$/gm, (_, name) => {
        if (this._wgslStructs.has(name)) {
          const structWgsl = this._wgslStructs.get(name);
          if (!uniformEmitted && !hasManualU) {
            uniformEmitted = true;
            return `${structWgsl}\n@group(0) @binding(0) var<uniform> u: ${name};`;
          }
          return structWgsl; // struct body only — binding declared manually in shader
        }
        if (this._wgslLibs.has(name)) return this._wgslLibs.get(name);
        this.log(`shader "${key}": #import ${name} not found`,'warn');
        return `// #import ${name} \u2014 NOT FOUND`;
      });
      // Auto-inject WGSL feature enables
      const enables = [];
      if (this._features.has('shader-f16') && /\bf16\b/.test(code)) enables.push('enable f16;');
      if (this._features.has('subgroups') && /subgroup/.test(code)) enables.push('enable subgroups;');
      if (this._features.has('clip-distances') && /clip_distances/.test(code)) enables.push('enable clip_distances;');
      if (this._features.has('dual-source-blending') && /blend_src/.test(code)) enables.push('enable dual_source_blending;');
      if (enables.length > 0) code = enables.join('\n') + '\n' + code;
      try {
        const mod = this.device.createShaderModule({code});
        // Catch async WGSL compile errors (deferred by the browser)
        if (mod.getCompilationInfo) {
          mod.getCompilationInfo().then(info => {
            for (const msg of info.messages) {
              if (msg.type === 'error') this.log(`shader "${key}" line ${msg.lineNum}: ${msg.message}`, 'err');
              else if (msg.type === 'warning') this.log(`shader "${key}" line ${msg.lineNum}: ${msg.message}`, 'warn');
            }
          });
        }
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
        const initBuf = new Float32Array(size / 4);
        const keys = Object.keys(dataNode.attrs);
        for (let ki = 0; ki < keys.length; ki++) {
          const v = Rex.evalExpr(Rex.compileExpr(dataNode.attrs[keys[ki]]), {});
          if (typeof v === 'number') initBuf[ki] = v;
        }
        this.device.queue.writeBuffer(gpuBuf, 0, initBuf);
      }
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
  _compileResourceScopes(tree) {
    this._resourceScopes = new Map();
    for (const res of Rex.findAll(tree, 'resources')) {
      const name = res.name;
      if (!name) continue;
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
              layoutEntries.push({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'storage', hasDynamicOffset: dynamic } });
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
      const newPipeline = this.device.createRenderPipeline(desc);
      this.pipelines.set(key, {pipeline:newPipeline, type:'render', format, resourceScope: resName || null, sampleCount});
      this.log(`pipeline "${key}": render \u2713${sampleCount > 1 ? ` [${sampleCount}x MSAA]` : ''}${resScope ? ` [resources: ${resName}]` : ''}`,'ok');
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
    const dt = this._prevExecTime !== undefined ? Math.min(now - this._prevExecTime, 0.1) : 0.016;
    this._prevExecTime = now;
    this._frameDT = dt;
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
    const tv = this.context.getCurrentTexture().createView();
    this._executeCommandList(enc, tv);

    // Query resolve (before readback copies)
    for (const [, tq] of this._querySets) {
      if (tq.nextIndex > 0) {
        enc.resolveQuerySet(tq.querySet, 0, tq.nextIndex, tq.resolveBuffer, 0);
        enc.copyBufferToBuffer(tq.resolveBuffer, 0, tq.readBuffer, 0, tq.nextIndex * 8);
      }
    }

    // Readback copies (before submit)
    for (const rb of this._readbacks) {
      if (!rb.pending) enc.copyBufferToBuffer(rb.srcBuffer, rb.srcOffset, rb.staging, 0, rb.size);
    }

    this.device.queue.submit([enc.finish()]);

    // Async readback — standard buffers
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
      const sampEntry = this._samplers.get(bindDef.sampler || bindDef.texture);
      if (sampEntry) entries.push({ binding: entries.length, resource: sampEntry.sampler });
      if (tex) entries.push({ binding: entries.length, resource: (this._textureViews && this._textureViews.get(bindDef.texture)) || tex.createView() });
    }

    if (entries.length === 0) {
      // Fall back to legacy heap-only bind
      if (bindDef.buffer) {
        const hl = this._heapLayout.get(bindDef.buffer);
        if (!hl || !this._heapBuffer) { this.log(`bind: buffer "${bindDef.buffer}" not in heap`,'err'); return; }
        const bgKey = `${group}_${bindDef.buffer}`;
        let bg = this._bindGroups.get(bgKey);
        if (!bg) {
          try {
            bg = this.device.createBindGroup({
              layout: pe.pipeline.getBindGroupLayout(group),
              entries: [{ binding: 0, resource: { buffer: this._heapBuffer, offset: hl.offset, size: hl.size } }]
            });
            this._bindGroups.set(bgKey, bg);
          } catch(e) { this.log(`bind group ${group}: ${e.message}`,'err'); return; }
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
