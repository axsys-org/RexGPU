// ═══════════════════════════════════════════════════════════════════
// REX MEDIA SUGAR
// Compile-time tree expansion: @media → synthetic @texture/@shrub/@samples
// Fiber-based resource lifecycle — assets survive recompile
// Follows the @filter sugar pattern (rex-gpu.js:885)
// ═══════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';
import { RexFiberHost, RexFiber, rexUseResource } from './rex-fiber.js';

export class RexMediaSugar {

  constructor(device, audioCtx, log) {
    this._device = device;          // GPUDevice | null
    this._audioCtx = audioCtx;      // AudioContext | null (until user interaction)
    this._log = log || (() => {});
    this._gpu = null;               // Set on first tick()

    // Fiber host: persistent across recompiles
    this._fiberHost = new RexFiberHost({ heapSize: 65536 });
    this._rootFn = null;            // Root fiber function (set on first expand)
    this._rootMounted = false;

    // Resource state
    this._loadedResources = new Map();  // name → {value, type, version, src}
    this._pendingLoads = new Map();     // name → {promise, controller, src, type}
    this._liveVideos = new Map();       // name → {element, src}

    // Extension registry — same pattern as all transducers
    this._handlers = new Map();         // type → {detect, expand, load}
    this._warnedTypes = new Set();
  }

  // ── expand(tree) ─────────────────────────────────────────────────
  // Tree mutation at compile time. Called in parseSource() after
  // Rex.expandTemplates() and before transducers see the tree.
  // Pattern mirrors _compileFilters (rex-gpu.js:885).

  expand(tree) {
    const mediaNodes = Rex.findAll(tree, 'media');
    if (!mediaNodes.length) return;

    this._warnedTypes.clear();
    let count = 0;

    for (const node of mediaNodes) {
      const name = node.name;
      if (!name) { this._log('media: @media missing name', 'warn'); continue; }

      const src = node.attrs.src || '';
      const type = node.attrs.type || this._detectType(src);

      switch (type) {
        case 'image':   this._expandImage(node, tree); break;
        case 'video':   this._expandVideo(node, tree); break;
        case 'audio':   this._expandAudio(node, tree); break;
        case 'sample-bank': this._expandSampleBank(node, tree); break;
        default: {
          const handler = this._handlers.get(type);
          if (handler && handler.expand) {
            handler.expand(node, tree);
          } else if (!this._warnedTypes.has(type)) {
            this._warnedTypes.add(type);
            this._log(`media: unknown type "${type}" for "${name}"`, 'warn');
            continue;
          }
        }
      }

      // Mount or reuse async resource loader
      this._ensureResourceLoad(name, src, type, node.attrs);
      count++;
    }

    if (count) this._log(`media: ${count} nodes expanded`, 'ok');
  }

  // ── _expandImage ─────────────────────────────────────────────────
  // Push synthetic @texture node. GPU transducer's _compileTextures
  // (rex-gpu.js:1552) picks it up identically to hand-written.

  _expandImage(node, tree) {
    const name = node.name;
    const w = +(node.attrs.width || 4);     // placeholder; replaced after load
    const h = +(node.attrs.height || 4);
    const fmt = node.attrs.format || 'rgba8unorm';
    const filter = node.attrs.filter || 'linear';
    const wrap = node.attrs.wrap || 'clamp-to-edge';

    // Avoid duplicates on recompile
    if (Rex.findAll(tree, 'texture').find(t => t.name === name)) return;

    // Synthetic @texture — same shape as filter expansion (rex-gpu.js:1030)
    tree.children.push({
      type: 'texture',
      name,
      attrs: {
        width: w, height: h, format: fmt,
        filter, wrap,
        src: node.attrs.src || '',
      },
      children: [],
      content: null,
      _d: 1,
    });
  }

  // ── _expandVideo ─────────────────────────────────────────────────
  // Create HTMLVideoElement + synthetic @texture :type video.

  _expandVideo(node, tree) {
    const name = node.name;
    const src = node.attrs.src || '';
    const loop = node.attrs.loop !== 'false' && node.attrs.loop !== false;

    // Create or reuse video element
    let entry = this._liveVideos.get(name);
    if (!entry || entry.src !== src) {
      // Cleanup old element
      if (entry?.element) {
        entry.element.pause();
        entry.element.remove();
      }
      const el = document.createElement('video');
      el.id = `_media_video_${name}`;
      el.src = src;
      el.crossOrigin = 'anonymous';
      el.loop = loop;
      el.muted = true;
      el.playsInline = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      el.play().catch(() => {}); // May fail until user interaction
      this._liveVideos.set(name, { element: el, src });
      entry = this._liveVideos.get(name);
    }

    // Avoid duplicate synthetic texture
    if (Rex.findAll(tree, 'texture').find(t => t.name === name)) return;

    // Synthetic @texture :type video
    tree.children.push({
      type: 'texture',
      name,
      attrs: { type: 'video', 'video-element': entry.element.id },
      children: [],
      content: null,
      _d: 1,
    });
  }

  // ── _expandAudio ─────────────────────────────────────────────────
  // Synthetic @shrub media/NAME with state/duration/bpm slots.
  // behaviour._compileShrub (rex-behaviour.js:155) picks it up.

  _expandAudio(node, tree) {
    const name = node.name;
    const shrubName = `media/${name}`;

    // Avoid duplicate
    if (Rex.findAll(tree, 'shrub').find(s => s.name === shrubName)) return;

    tree.children.push({
      type: 'shrub',
      name: shrubName,
      attrs: {},
      children: [
        { type: 'slot', name: 'state', attrs: { type: 'string', default: 'loading' }, children: [], content: null, _d: 2 },
        { type: 'slot', name: 'duration', attrs: { type: 'number', default: 0 }, children: [], content: null, _d: 2 },
        { type: 'slot', name: 'bpm', attrs: { type: 'number', default: 0 }, children: [], content: null, _d: 2 },
        { type: 'slot', name: 'src', attrs: { type: 'string', default: node.attrs.src || '' }, children: [], content: null, _d: 2 },
      ],
      content: null,
      _d: 1,
    });
  }

  // ── _expandSampleBank ────────────────────────────────────────────
  // Synthetic @samples node for audio._compileSampleMap (rex-audio.js:805).

  _expandSampleBank(node, tree) {
    const name = node.name;
    const src = node.attrs.src || node.attrs.map || '';

    // Avoid duplicate
    if (Rex.findAll(tree, 'samples').find(s => s.name === name)) return;

    tree.children.push({
      type: 'samples',
      name,
      attrs: { map: src },
      children: node.children || [],
      content: null,
      _d: 1,
    });
  }

  // ── _ensureResourceLoad ──────────────────────────────────────────
  // Check if a resource is already loading/loaded with the same src.
  // If src changed, abort old load and start new one.
  // SugarFiber-Spec §8 invariant: same src → no re-fetch.

  _ensureResourceLoad(name, src, type, attrs) {
    // Already loaded with same src → skip
    const existing = this._loadedResources.get(name);
    if (existing && existing.src === src) return;

    // Already loading with same src → skip
    const pending = this._pendingLoads.get(name);
    if (pending && pending.src === src) return;

    // Abort old load if src changed
    if (pending) {
      pending.controller.abort();
      this._pendingLoads.delete(name);
    }

    // Start new async load
    const controller = new AbortController();
    const promise = this._asyncLoad(name, src, type, attrs, controller.signal)
      .then(value => {
        this._pendingLoads.delete(name);
        const version = (this._loadedResources.get(name)?.version || 0) + 1;
        this._loadedResources.set(name, { value, type, version, src });

        // Swap placeholder texture with real data
        if (type === 'image' && value) {
          this._replaceTexture(name, value);
        }

        // Push audio metadata to shrub slots
        if (type === 'audio' && value && this._behaviour) {
          this._behaviour.pushFormValue(`media/${name}/state`, 'ready');
          if (value.duration) {
            this._behaviour.pushFormValue(`media/${name}/duration`, value.duration);
          }
        }

        this._log(`media: loaded "${name}" (${type})`, 'ok');
      })
      .catch(e => {
        this._pendingLoads.delete(name);
        if (e.name !== 'AbortError') {
          this._log(`media: load failed "${name}": ${e.message}`, 'err');
        }
      });

    this._pendingLoads.set(name, { promise, controller, src, type });
  }

  // ── _asyncLoad ───────────────────────────────────────────────────
  // Async loaders per media type.

  async _asyncLoad(name, src, type, attrs, signal) {
    switch (type) {
      case 'image': {
        const resp = await fetch(src, { signal });
        const blob = await resp.blob();
        const opts = {};
        if (attrs.width) opts.resizeWidth = +attrs.width;
        if (attrs.height) opts.resizeHeight = +attrs.height;
        return await createImageBitmap(blob, opts);
      }

      case 'audio': {
        if (!this._audioCtx) {
          this._log(`media: audio "${name}" deferred — no AudioContext yet`, 'warn');
          return null;
        }
        const resp = await fetch(src, { signal });
        const buf = await resp.arrayBuffer();
        return await this._audioCtx.decodeAudioData(buf);
      }

      case 'sample-bank': {
        const resp = await fetch(src, { signal });
        const manifest = await resp.json();
        if (!this._audioCtx) {
          this._log(`media: sample-bank "${name}" deferred — no AudioContext yet`, 'warn');
          return null;
        }
        const base = manifest._base || '';
        const buffers = [];
        for (const [sName, paths] of Object.entries(manifest)) {
          if (sName.startsWith('_')) continue;
          const urls = Array.isArray(paths) ? paths.map(p => base + p) : [base + paths];
          for (const url of urls) {
            const r = await fetch(url, { signal });
            const ab = await r.arrayBuffer();
            buffers.push(await this._audioCtx.decodeAudioData(ab));
          }
        }
        return buffers;
      }

      default: {
        // Extension handler
        const handler = this._handlers.get(type);
        if (handler && handler.load) {
          return await handler.load(src, attrs, signal);
        }
        return null;
      }
    }
  }

  // ── _replaceTexture ──────────────────────────────────────────────
  // Swap placeholder GPU texture with real loaded bitmap.
  // Pattern: gpu._textures.set + gpu._bindGroups.clear (rex-gpu.js:1712)

  _replaceTexture(name, bitmap) {
    if (!this._device || !this._gpu) return;
    const gpu = this._gpu;

    // Destroy old placeholder
    const oldTex = gpu._textures.get(name);
    if (oldTex) {
      try { oldTex.destroy(); } catch {}
    }

    // Create real texture from loaded bitmap
    const newTex = this._device.createTexture({
      label: `media_${name}`,
      size: { width: bitmap.width, height: bitmap.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_DST
           | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this._device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: newTex },
      { width: bitmap.width, height: bitmap.height },
    );

    // Replace in GPU transducer's texture map
    gpu._textures.set(name, newTex);
    if (gpu._textureViews) {
      gpu._textureViews.set(name, newTex.createView());
    }

    // Invalidate bind groups that reference this texture
    gpu._bindGroups.clear();
    gpu._frameDirty = true;
  }

  // ── tick(gpu) ────────────────────────────────────────────────────
  // Per-frame update. Called before gpu.transduce() because
  // importExternalTexture lifetime = current JS task.

  tick(gpu) {
    this._gpu = gpu;

    // Flush fiber host — drain pending fiber renders
    this._fiberHost.flush();

    // Per-frame video texture import
    for (const [name, entry] of this._liveVideos) {
      const el = entry.element;
      if (!el || el.readyState < 2 || !this._device) continue;

      try {
        const extTex = this._device.importExternalTexture({ source: el });
        // Store external texture for GPU transducer
        if (!gpu._externalTextures) gpu._externalTextures = new Map();
        gpu._externalTextures.set(name, extTex);

        // Invalidate affected bind groups
        if (gpu._bindGroups) {
          for (const [k] of gpu._bindGroups) {
            if (typeof k === 'string' && k.includes(name)) {
              gpu._bindGroups.delete(k);
            }
          }
        }
      } catch {
        // Video not ready yet — silently skip
      }
    }
  }

  // ── Accessors ────────────────────────────────────────────────────

  get(name) {
    return this._loadedResources.get(name) || null;
  }

  getTexture(name) {
    return this._gpu?._textures?.get(name) || null;
  }

  getAudioBuffer(name) {
    const r = this._loadedResources.get(name);
    return (r && r.type === 'audio') ? r.value : null;
  }

  getSampleBank(name) {
    const r = this._loadedResources.get(name);
    return (r && r.type === 'sample-bank') ? r.value : null;
  }

  isLive(name) {
    return this._loadedResources.has(name);
  }

  isDirty(name, knownVersion) {
    const r = this._loadedResources.get(name);
    return r ? r.version > (knownVersion || 0) : false;
  }

  // ── _detectType ──────────────────────────────────────────────────

  _detectType(src) {
    if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(src)) return 'image';
    if (/\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(src)) return 'video';
    if (/\.(mp3|wav|ogg|flac|aac|m4a|opus)$/i.test(src)) return 'audio';
    if (/\.json$/i.test(src)) return 'sample-bank';
    // Check extension handlers
    for (const [type, handler] of this._handlers) {
      if (handler.detect && handler.detect(src)) return type;
    }
    return 'image'; // default
  }

  // ── Extension ────────────────────────────────────────────────────

  registerAssetType(type, handler) {
    // handler: { detect(src)→bool, expand(node, tree)→void, load(src, attrs, signal)→Promise }
    this._handlers.set(type, handler);
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  destroy() {
    // Abort all pending loads
    for (const [, pending] of this._pendingLoads) {
      pending.controller.abort();
    }
    this._pendingLoads.clear();

    // Cleanup video elements
    for (const [, entry] of this._liveVideos) {
      if (entry.element) {
        entry.element.pause();
        entry.element.remove();
      }
    }
    this._liveVideos.clear();

    // Unmount fiber host
    this._fiberHost.unmount();
    this._loadedResources.clear();
  }
}
