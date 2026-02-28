# RexMedia — Universal Media Transducer Spec

**Status:** Draft v2, Feb 2026
**Authors:** ShrineOS / RPE team

---

## 1. The Problem

Every media type entering Rex today has its own asset-loading path:

| Location | What it loads | How |
|---|---|---|
| `rex-gpu.js` | textures, video frames | `_textures`, `_videoTextures` |
| `rex-audio.js` | samples, sample banks | `_sampleCache`, `_sampleMap` |
| `rex-surface.js` | fonts, SVG | ad-hoc |
| (future) mesh | GLTF, BVH | nowhere |
| (future) volumetric | splats, NeRF | nowhere |

This whack-a-mole is not a tooling problem — it's a **missing abstraction**. The research confirms: no unified media addressing system exists anywhere. Every codec family solved the same decomposition problem independently (wavelet trees for audio/image, BVH for geometry, ISOBMFF boxes for video, bezier contours for fonts). They never converged.

**The core abstraction that's missing:** a formal model of "media as a signal over a domain, factored by a codec DAG, with declared addressable paths."

---

## 2. Theoretical Foundation

### 2.1 Every media artifact is a signal over a domain

| Media type | Domain | Value type |
|---|---|---|
| Audio | time (1D, rational) | PCM sample (f32) |
| Video | time × (x,y) (3D) | RGB pixel |
| Image | (x,y) (2D) | RGBA pixel |
| 3D mesh | triangle index × vertex attrib | f32 (position, normal, uv) |
| Gaussian splat | gaussian index | (position, covariance, SH coefficients) |
| NeRF / INR | (x,y,z,θ,φ) continuous | radiance (RGB + density) |
| Variable font | glyph id × design axes | bezier control point |
| Shader param space | axis name | f32 |

**Signal:** `domain → value`
**Codec:** a DAG transforming `raw signal ↔ compressed representation`
**Address:** a path through the codec DAG identifying a segment of the domain

### 2.2 The DAG Amendment insight (Michel & Boubekeur, SIGGRAPH 2021)

A parametric shape is a DAG whose nodes are programs. Direct manipulation (inverse control) requires differentiating through the DAG back to hyperparameters — without knowing the internals of any node. The key operation is **amending the DAG**: declaring named, addressable paths through it.

This is exactly what Rex `@track` declarations do:

```rex
@media song :src "track.mp3" :transcode [stems]
  @track drums   ←  amendment: declares /audio/song/stems/drums as an addressable path
  @track bass
```

The `@track` node does not describe how stem separation works. It declares that this path through the decode DAG is named and should be made accessible. The transcode pass fills it. The downstream transducer reads it. **The codec internals are never exposed.**

This generalizes: every `@media` node is a codec DAG declaration. Every `@track` / `@node` / `@bone` / `@frame` child is a DAG amendment — a named window into the codec's output domain.

### 2.3 Codec composition as functor (the gap, and why it matters)

The research found no formal "codec algebra" in the literature. Transcoding is always ad-hoc: decode to raw (PCM, YUV, XYZ), re-encode. There is no framework for saying "a WAV decoder and a JPEG decoder are both instances of `Codec<Signal<Domain, Value>>`."

This is a real gap. It means:
- No type-safe cross-media queries
- No automatic codec chain generation
- No provable composition properties

The midterm solution (a trained universal transcoding model — VideoPoet, UniDiffuser, UniAudio lineage) addresses *generation*, not *addressing*. A "transcoding model" trained on all modalities could serve as the universal `decode` node in the DAG, but you still need the addressing layer on top.

The right long-term framing:

```
Codec   = Functor: RawCategory → CompressedCategory
Transcode = natural transformation: Codec_A → Codec_B
Address   = profunctor optic compiled to byte/index offset
Amendment = Rex @track declaration binding a name to an optic
```

Rex already implements this for GPU heap (compiled byte offsets). `RexMedia` extends it to every media domain.

### 2.4 Content addressing vs. structural addressing

IPFS/IPLD gives content addressing: `CID = hash(content)`. This addresses *immutable blobs*.

What we need is **structural addressing**: `path = "stems/drums"` inside a mutable, live, or decoded artifact. The two compose: `CID:/audio/song/stems/drums` = the drum stem of the content-addressed song. PLAN Pins are the persistence layer for this — a Pin IS a CID. The namespace is Pin-addressable.

---

## 3. The Media Namespace

The namespace is a `Map<path, NamespaceEntry>` where paths are `/`-separated structural addresses:

```
/audio/song/raw            → AudioBuffer          (decoded source)
/audio/song/stems/drums    → AudioBuffer          (Demucs output)
/audio/song/stems/bass     → AudioBuffer
/audio/song/bpm            → number               (Essentia.js)
/audio/song/beats          → Float32Array         (onset timestamps, seconds)
/audio/song/key            → string               ("Cm", "F#maj")
/audio/song/fft            → Uint8Array           (live, 1024 bins, updated per frame)
/audio/song/waveform       → Float32Array         (downsampled envelope, ~1000pts)

/audio/dirt/bd             → AudioBuffer[]        (sample bank, indexed by :N)
/audio/dirt/sd             → AudioBuffer[]

/video/film/frame          → GPUExternalTexture   (live, updated per frame)
/video/film/audio          → AudioBuffer
/video/film/flow           → GPUTexture           (optical flow, if :transcode [optical-flow])

/image/logo                → GPUTexture
/image/logo/mip/0          → GPUTexture

/mesh/character/vertices   → GPUBuffer
/mesh/character/indices    → GPUBuffer
/mesh/character/joints     → GPUBuffer            (skinning matrices, storage)
/mesh/character/clips/walk → AnimationClip
/mesh/character/clips/run  → AnimationClip

/splat/scene/gaussians     → GPUBuffer            (position+covariance+SH, storage)
/splat/scene/count         → number

/font/body/atlas           → GPUTexture           (SDF atlas)
/font/body/metrics         → Map<glyphId, GlyphMetrics>

/nerf/scene/weights        → GPUBuffer            (INGP hash grid)
/nerf/scene/mlp            → Float32Array         (MLP weights, for WASM inference)
```

### Entry structure

```js
{
  value:   any,                     // the resource
  type:    string,                  // 'audio-buffer' | 'gpu-texture' | 'gpu-buffer' |
                                    //   'f32array' | 'u8array' | 'scalar' | 'string' |
                                    //   'animation-clip' | 'sample-bank' | ...
  live:    boolean,                 // updates every frame (video frame, FFT)
  version: number,                  // monotonic — consumers dirty-check this
  src:     string,                  // origin URL — used for cache-keying on recompile
}
```

### Path semantics (Rex optic correspondence)

| Path form | Rex optic | Meaning |
|---|---|---|
| `/audio/song/bpm` | lens | scalar, deterministic |
| `/audio/dirt/bd` | lens→array | sample bank (array value) |
| `/audio/dirt/bd:2` | prism | index into bank array |
| `/mesh/scene/clips/walk` | prism | named variant |
| `/video/film/frame` | live lens | updates per frame |
| `/audio/song/stems/*` | traversal | all stem tracks |

---

## 4. Node Vocabulary

### `@media` — codec DAG declaration

```rex
@media song :type audio :src "track.mp3"
  :transcode [stems fft bpm-detect beat-track]
  @track drums
  @track bass
  @track vocals
  @track other
```

```rex
@media film :type video :src "clip.mp4" :loop true
  :transcode [frames audio optical-flow]
```

```rex
@media dirt :type sample-bank :src dirt
```

```rex
@media character :type gltf :src "hero.glb"
  :transcode [mesh skeleton animation]
  @node body
    @bone hip
    @bone spine
    @clip walk
    @clip run
```

```rex
@media scene :type splat :src "scene.splat"
```

```rex
@media logo :type image :src "logo.png" :mips true
```

**Attrs:**

| Attr | Meaning |
|---|---|
| `:type` | Asset kind — routes to handler. Omit to auto-detect from extension. |
| `:src` | URL, file path, or shorthand (`dirt` = Dirt-Samples map) |
| `:transcode` | Ordered list of pass names to run after decode |
| `:lazy` | `true` = don't load until first reference (default: eager) |
| `:loop` | (video/audio) loop playback |
| `:fps` | (video) target decode rate for texture updates |
| `:mips` | (image) generate mip chain |
| `:format` | (image) GPUTextureFormat hint |
| `:worker` | `true` = run decode+transcode in a Web Worker (default for heavy passes like stems) |

### `@track` / `@node` / `@bone` / `@clip` — DAG amendments

Children of `@media` that declare named addressable paths through the codec output.

```rex
@media song :src "track.mp3" :transcode [stems]
  @track drums    ;; → /audio/song/stems/drums
  @track bass     ;; → /audio/song/stems/bass
```

```rex
@media hero :type gltf :src "hero.glb" :transcode [skeleton animation]
  @bone hip       ;; → /mesh/hero/joints/hip  (matrix in joint buffer, by name)
  @clip walk      ;; → /mesh/hero/clips/walk  (AnimationClip)
```

If no amendment children are declared, all transcode outputs are auto-named using pass conventions.

### `@bind :media path` — GPU pass binding (extends existing `@bind`)

```rex
@pass main
  @draw :pipeline vis :vertices 6
    @bind 0 :buffer params
    @bind 1 :media /audio/song/fft
    @bind 2 :media /image/logo
    @bind 3 :media /video/film/frame
```

### Namespace refs in `@buffer :data`

```rex
@buffer params :struct Params :usage [uniform]
  @data
    :time  (elapsed)
    :bpm   /audio/song/bpm       ;; ← namespace path, resolved per-frame
    :drums /audio/song/stems/drums/rms  ;; ← computed live scalar
```

---

## 5. Transcode Pass Registry

Passes are named transforms: `(base_resource, amendments, namespace, device, audioCtx) → Promise<void>`

### Built-in audio passes

| Pass | Input | Output paths |
|---|---|---|
| `raw` | fetch response | `/*/raw` → AudioBuffer |
| `stems` | AudioBuffer | `/*/stems/{drums,bass,vocals,other}` — Demucs ONNX |
| `bpm-detect` | AudioBuffer | `/*/bpm`, `/*/tempo-confidence` — Essentia.js |
| `beat-track` | AudioBuffer | `/*/beats` → Float32Array (onset times, seconds) |
| `key-detect` | AudioBuffer | `/*/key` → string ("Cm", "F#maj") |
| `waveform` | AudioBuffer | `/*/waveform` → Float32Array (~1000pts RMS envelope) |
| `fft` | AudioBuffer → AnalyserNode | `/*/fft` → Uint8Array (live, 1024 bins) |
| `chroma` | AudioBuffer | `/*/chroma` → Float32Array[12] (live) |
| `gpu-pcm` | AudioBuffer | `/*/pcm` → GPUBuffer (r32float, samples×channels) |

### Built-in video passes

| Pass | Input | Output paths |
|---|---|---|
| `frames` | HTMLVideoElement | `/*/frame` → GPUExternalTexture (live) |
| `audio` | HTMLVideoElement | `/*/audio` → AudioBuffer |
| `optical-flow` | frame sequence | `/*/flow` → GPU texture (motion vectors, rg16float) |

### Built-in mesh passes

| Pass | Input | Output paths |
|---|---|---|
| `mesh` | GLTF | `/*/vertices`, `/*/indices` → GPU buffers |
| `skeleton` | GLTF | `/*/joints` → GPU storage buffer, `/*/skeleton` → JointTree |
| `animation` | GLTF | `/*/clips/{name}` → AnimationClip[] |
| `bvh` | BVH file | `/*/joints`, `/*/frames` → same schema as GLTF skeleton |
| `morph` | GLTF | `/*/morphs/{name}` → Float32Array per morph target |

### Built-in image passes

| Pass | Input | Output paths |
|---|---|---|
| `decode` | fetch response | `/*/raw` → GPUTexture (rgba8unorm) |
| `mips` | GPUTexture | `/*/mip/{0,1,2,...}` → GPUTexture per level |
| `sdf` | ImageBitmap (font atlas) | `/*/atlas` → GPUTexture, `/*/metrics` → Map |
| `normal-map` | ImageBitmap | `/*/normal` → GPUTexture |
| `cubemap` | 6× ImageBitmap | `/*/cube` → GPUTexture (cube) |

### Built-in volumetric/neural passes

| Pass | Input | Output paths |
|---|---|---|
| `splat-decode` | .splat / .ply binary | `/*/gaussians` → GPUBuffer, `/*/count` → number |
| `nerf-infer` | INGP weights | `/*/weights` → GPUBuffer (hash grid + MLP) |

---

## 6. Implementation Shape

### Class

```js
class RexMedia {
  constructor(device, audioCtx, log)
  // device: GPUDevice | null, audioCtx: AudioContext | null

  // ── Transducer protocol ──────────────────────────────────────────
  transduce(tree, structureChanged)
  compile(tree)   // walks @media nodes, starts eager loads
  execute()       // ticks live resources (video frames, FFT), checks load states

  // ── Namespace reads (for downstream transducers) ─────────────────
  get(path)              // → NamespaceEntry | null
  getValue(path)         // → value | null  (unwrapped)
  getTexture(path)       // → GPUTexture | null
  getGPUBuffer(path)     // → GPUBuffer | null
  getAudioBuffer(path)   // → AudioBuffer | null
  getSampleBank(path)    // → AudioBuffer[] | null
  getScalar(path)        // → number | null
  isLive(path)           // → boolean
  isDirty(path, knownVersion) // → boolean (version check)

  // ── Extension protocol ───────────────────────────────────────────
  registerAssetType(type, handler)
  // handler: { detect(src)→bool, compile(node)→spec, load(spec)→Promise<base> }
  registerTranscodePass(name, handler)
  // handler: (base, amendments, ns, device, audioCtx)→Promise<void>

  // ── Callbacks ────────────────────────────────────────────────────
  onLoad  = null  // (path, entry)
  onBeat  = null  // (path, time)  — from beat-track pass
  onError = null  // (path, error)
}
```

### Compiled asset structure

```js
_assets: Map<name, {
  type:       string,
  src:        string,
  transcode:  string[],
  amendments: Map<childNodeName, path>,  // declared @track/@bone/@clip children
  lazy:       boolean,
  state:      'pending' | 'loading' | 'ready' | 'failed',
  base:       any,        // raw decoded resource (AudioBuffer, ImageBitmap, GLTF, ...)
  worker:     Worker | null,
}>
```

### Namespace invalidation on recompile

On each `compile(tree)`:
1. Build new `_assets` from tree
2. For each existing asset: if same `:src` → preserve namespace entries, reuse base
3. For removed assets: release GPU resources (`texture.destroy()`, `buffer.destroy()`), delete namespace entries
4. For new assets: start load

This is the same dirty-tracking principle as GPU heap layout invalidation.

---

## 7. Integration with Downstream Transducers

### RexGPU

`@bind :media path` resolves at execute time:

```js
// compile: record media binding
case ':media':
  this._mediaBindings.set(slot, attrVal); // path string
  break;

// execute: resolve from namespace
for (const [slot, path] of this._mediaBindings) {
  const entry = media.get(path);
  if (!entry) continue;
  if (entry.type === 'gpu-texture')     bindGroupEntries[slot] = { binding: slot, resource: entry.value.createView() };
  if (entry.type === 'gpu-external')    bindGroupEntries[slot] = { binding: slot, resource: entry.value };
  if (entry.type === 'gpu-buffer')      bindGroupEntries[slot] = { binding: slot, resource: { buffer: entry.value } };
}
```

`/video/*/frame` → `GPUExternalTexture` from `importExternalTexture()`, called synchronously in `RexMedia.execute()` before `RexGPU.execute()` in the frame loop.

### RexAudio

Sample resolution migrates to namespace:

```js
// _loadSample(name) — check media namespace first
const bank = media?.getSampleBank(`/audio/${this._sampleBankPrefix}/${bankName}`);
if (bank) return bank[bankIndex % bank.length];
```

Beat events from `beat-track` pass route to behaviour:

```js
media.onBeat = (path, time) => behaviour.fireTalk('_audio', 'on-beat', { path, time });
```

### RexSurface

SDF font atlas:

```js
const atlas = media?.get('/font/body/atlas');
const metrics = media?.get('/font/body/metrics');
if (atlas && metrics) { surface._sdfAtlas = atlas.value; surface._sdfMetrics = metrics.value; }
```

### main.js frame loop order (critical)

```
1. media.transduce(tree, sc)         ← importExternalTexture must happen here
2. gpu.transduce(tree, sc)           ← consumes /video/*/frame GPUExternalTexture
3. audio.transduce(tree, false)      ← consumes /audio/*/fft Uint8Array
4. surface.execute()                 ← consumes /font/*/atlas GPUTexture
```

---

## 8. Examples

### Audio-reactive shader

```rex
@media song :type audio :src "track.mp3"
  :transcode [stems fft bpm-detect beat-track]
  @track drums
  @track bass

@struct Params
  @field res   :type f32x2
  @field time  :type f32
  @field bpm   :type f32

@buffer params :struct Params :usage [uniform]
  @data
    :res  (canvas-size)
    :time (elapsed)
    :bpm  /audio/song/bpm

@shader vis
  @group(0) @binding(0) var<uniform> u: Params;
  @group(0) @binding(1) var fft: texture_1d<f32>;
  @group(0) @binding(2) var samp: sampler;
  @fragment fn fs(v: VSOut) -> @location(0) vec4f {
    let bin = textureSample(fft, samp, v.uv.x).r;
    return vec4f(bin, bin * 0.5, 1.0 - bin, 1.0);
  }

@pipeline vis :vertex vis :fragment vis :format canvas :topology triangle-list
@pass main :clear [0 0 0 1]
  @draw :pipeline vis :vertices 6
    @bind 0 :buffer params
    @bind 1 :media /audio/song/fft
    @bind 2 :sampler linear
```

### Video frame as GPU texture

```rex
@media film :type video :src "clip.mp4" :loop true
  :transcode [frames]

@shader vid
  @group(0) @binding(0) var frame: texture_external;
  @group(0) @binding(1) var samp: sampler;
  @fragment fn fs(v: VSOut) -> @location(0) vec4f {
    return textureSampleBaseClampToEdge(frame, samp, v.uv * 0.5 + 0.5);
  }

@pass main
  @draw :pipeline vid :vertices 6
    @bind 0 :media /video/film/frame
    @bind 1 :sampler linear
```

### Gaussian splat rendering

```rex
@media scene :type splat :src "scene.splat"

@shader splat-vert
  @group(0) @binding(0) var<storage,read> gaussians: array<Gaussian>;
  @vertex fn vs(@builtin(instance_index) ii: u32, ...) -> VSOut {
    let g = gaussians[ii];
    ...
  }

@pass main
  @draw :pipeline splat :vertices 4 :instances /splat/scene/count
    @bind 0 :media /splat/scene/gaussians
```

### Stem-driven pattern routing

```rex
@media song :type audio :src "track.mp3" :transcode [stems beat-track]
  @track drums
  @track bass

@pattern kick :bank /audio/dirt :seq "bd:0 bd:2 . bd:0"
  :gate /audio/song/beats         ;; gate pattern to detected beats

@shrub mixer
  @slot drum-vol :default 0.8
  @slot bass-vol :default 0.6
  @channel drum-vol → /audio/song/stems/drums/gain
  @channel bass-vol → /audio/song/stems/bass/gain
```

---

## 9. Heavy Passes: Worker Architecture

Demucs (stems) and Essentia (BPM) are too slow for the main thread. Both run in a `Worker`:

```
main thread                     worker
───────────                     ──────
postMessage({type:'stems',
  pcm: Float32Array,            → receive PCM
  sampleRate: 44100})           → run Demucs ONNX (WebGPU EP / WASM fallback)
                                → postMessage({type:'stems-done', tracks:{drums,bass,...}})
receive tracks
→ decodeAudioData (main thread, needs AudioContext)
→ write to namespace
→ log 'stems ready'
```

The `AudioContext.decodeAudioData` step must run on the main thread because `AudioContext` is not transferable. Everything else — fetch, decode raw ArrayBuffer, ONNX inference — runs in the Worker.

Model caching: OPFS (`navigator.storage.getDirectory()`) for large models (Demucs 80MB). Cache API for smaller WASM modules (Essentia 5MB). First load slow; subsequent loads from OPFS in ~100ms.

---

## 10. The Trained Transcoding Model (midterm vision)

The current architecture uses explicit per-type handlers (Demucs for stems, Essentia for BPM, GLTF parser for mesh). This works but requires maintaining every codec handler.

The midterm replacement is a universal transcoding model trained on all media modalities — in the lineage of VideoPoet, UniDiffuser, UniAudio, but specifically optimized for *structural decomposition* rather than generation:

```
TranscodeModel(source: ArrayBuffer, sourceType: string, targetPaths: string[])
  → Map<path, ArrayBuffer>  (each decoded/transcoded segment)
```

This model would learn: "given a WAV file and the request for `/stems/drums`, return the drum stem AudioBuffer." It would handle cross-modal queries: "given a video and the request for `/audio`, return the audio track." At the extreme: "given a photo and the request for `/mesh`, return a reconstructed 3D mesh."

The addressing layer (namespace paths, DAG amendments) remains identical. The model just replaces the explicit per-type decode+transcode handlers. The Rex notation does not change.

This is why the spec describes transcoding as functor composition even though no formal codec algebra exists yet — the notation has to be stable across the transition from explicit handlers to learned models.

---

## 11. Migration Plan

### Phase A — Skeleton (no breaking changes)

1. Create `src/rex-media.js` — `RexMedia` class, namespace map, `transduce`/`compile`/`execute`
2. `@media :type sample-bank` — migrate `RexAudio._sampleMap` / `_sampleCache` here
3. `@media :type image` — migrate `RexGPU._textures` loading here
4. Wire `main.js`: `media = new RexMedia(gpu.device, audio._ctx, log)`, call before GPU/audio
5. Pass `media` to `RexGPU` and `RexAudio` for namespace reads

### Phase B — Live resources

6. `@media :type video` → `importExternalTexture` per frame
7. `@media :type audio :transcode [fft]` → live FFT (migrate from `RexAudio.onFftData`)
8. Beat events: `media.onBeat` → `behaviour.fireTalk`

### Phase C — Transcode passes

9. Essentia.js WASM — BPM + beat tracking + key detection
10. Demucs ONNX — stem splitting, Worker architecture, OPFS caching
11. GLTF loader — mesh + skeleton + animation
12. Gaussian splat decoder — .splat / .ply binary format

### Phase D — Full namespace wiring

13. Rex optic paths in `@buffer :data` resolve via namespace (replaces form-state-only lookup)
14. `@bind :media path` in GPU passes
15. `@pattern :bank path` in audio patterns
16. Remove duplicate asset stores from individual transducers

### Phase E — Codec algebra (long-term)

17. Formalize `Codec<Domain, Value>` typeclass in Rex type system (post Rex-WASM-Parser)
18. `registerTranscodePass` becomes composable: passes chain as functor composition
19. Trained transcoding model as universal decode node

---

## 12. Open Questions

1. **OPFS vs Cache API for model storage** — OPFS is faster for large random-access files (Demucs 80MB). Cache API is simpler. Use OPFS for models, Cache API for WASM modules.

2. **`importExternalTexture` lifetime** — a `GPUExternalTexture` expires after the current JS task. `RexMedia.execute()` must call `importExternalTexture` synchronously and the resulting texture must be consumed by `RexGPU.execute()` in the same microtask queue flush. Current frame loop order satisfies this.

3. **AudioBuffer → GPUBuffer (`:transcode [gpu-pcm]`)** — upload raw PCM as `r32float` 2D texture (samples × channels) for GPU-side DSP. Enables convolution reverb, pitch shifting, granular synthesis entirely on GPU. High value, low implementation cost once namespace exists.

4. **Namespace invalidation granularity** — same-src = preserve. Removed `@media` = release. But what about `:transcode` list changes? Changing `[stems]` to `[stems fft]` should add the FFT entry without re-fetching the source. Track per-pass state independently from per-asset state.

5. **Cross-tab / cross-session namespace** — SharedArrayBuffer (requires COOP/COEP headers) for live sharing across tabs. OPFS for persistence across sessions. Both connect to PLAN Pins as the orthogonal persistence layer — a Pin IS a CID is a namespace entry is a content-addressed segment of a media DAG.

6. **Splat / NeRF live capture** — if the source is a WebRTC stream or a live camera feed, the decode DAG becomes a continuous pipeline rather than a one-shot load. The `live: true` flag in the namespace entry and `version` counter already accommodate this; the handler just needs to write on every frame instead of once.
