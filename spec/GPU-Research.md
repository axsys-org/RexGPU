# GPU & Graphics Research — Rex Projection Engine

*Compiled February 2026. Research scope: WebGPU text rendering, AAA game engine techniques, UI animation/motion, WebGPU compute architecture, self-hosting patterns, intellectual lineage (Aaltonen, profunctor optics, Blow/JAI), CUDA, PLAN runtime, and Rex notation.*

---

## Table of Contents

1. [GPU Text Rendering](#1-gpu-text-rendering)
2. [AAA Game Engine Techniques](#2-aaa-game-engine-techniques)
3. [UI Animation & Motion](#3-ui-animation--motion)
4. [WebGPU Platform & Self-Hosting](#4-webgpu-platform--self-hosting)
5. [Intellectual Lineage](#5-intellectual-lineage)
6. [Gap Analysis vs Current RPE](#6-gap-analysis)
7. [What RPE Gets Right](#7-what-rpe-gets-right)

---

## 1. GPU Text Rendering

### Three Approaches

#### 1a. MSDF (Multi-Channel Signed Distance Field)

The pragmatic first step. Viktor Chlumsky's technique (2016) uses 3 RGB channels encoding signed distances to different edge subsets. The median of three channels reconstructs sharp corners that single-channel SDF loses.

**Pipeline:**
1. Offline: `msdf-atlas-gen` produces atlas PNG + JSON metadata from TTF/OTF
2. Load: atlas as `rgba8unorm` GPUTexture, metadata as glyph lookup table
3. Shape: HarfBuzz WASM (`harfbuzzjs`, ~1.5MB) converts codepoints → positioned glyph IDs
4. Layout: CPU computes line breaks, paragraph layout, BiDi
5. Batch: Build storage buffer of glyph instances (position, size, atlas UVs)
6. Render: Single instanced draw, 6 vertices per quad, N instances

**MSDF fragment shader (complete WGSL):**
```wgsl
fn median3(a: f32, b: f32, c: f32) -> f32 {
    return max(min(a, b), min(max(a, b), c));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let msd = textureSample(atlas, samp, uv).rgb;
    let sd = median3(msd.r, msd.g, msd.b);
    let screen_px_distance = screen_px_range * (sd - 0.5);
    let alpha = clamp(screen_px_distance + 0.5, 0.0, 1.0);
    return vec4f(text_color.rgb * alpha, alpha);
}
```

**Performance:** 100K+ glyphs/frame on integrated GPUs. Resolution-independent up to ~64x atlas glyph size. ~200-400 lines JS + ~50 lines WGSL total.

#### 1b. Slug-Style Analytic Bezier Rendering

Eric Lengyel's technique. No atlas. Bezier curves stored in storage buffers. Fragment shader computes winding number per-pixel by solving quadratic/cubic roots.

**How it works:**
1. Extract glyph outlines as quadratic Bezier curves from font
2. Store curve data in GPU storage buffer
3. For each glyph instance, emit a bounding box quad
4. Fragment shader: for each curve, test if horizontal ray from pixel intersects curve, accumulate winding number
5. Anti-alias via `fwidth()` — adapts to screen resolution automatically

**Band optimization:** Curves sorted into horizontal bands. Fragment shader only tests curves in bands overlapping current pixel's y-coordinate. Reduces per-pixel cost from O(N) to O(sqrt(N)).

**Performance:** 30-80K glyphs/frame. Mathematically perfect at ANY scale. No atlas to manage. ~1KB per glyph in curve data.

#### 1c. Rasterized Bitmap Atlas

What Zed editor and glyphon (Rust/wgpu) use. CPU rasterizes glyphs at specific sizes, uploads to atlas texture, GPU composites as textured quads.

**Tradeoffs:** Simplest, best quality at target size, 200K+ glyphs/frame, but blurry when scaled. Must store per-size.

### Font Shaping

Shaping CANNOT be done on GPU. It's inherently sequential (OpenType substitution rules, BiDi reordering, contextual alternates). Use HarfBuzz compiled to WASM. Runs once per text change, not per frame.

**Layout pipeline (all CPU):**
1. Itemize: split into runs by script/language/font/direction
2. BiDi: Unicode Bidirectional Algorithm
3. Shape: HarfBuzz per run → positioned glyph IDs
4. Line break: Unicode line break algorithm
5. Final positioning: absolute coordinates

**Output to GPU:** `{glyphId, x, y, fontSize, color}` per glyph → storage buffer → instanced draw.

### Atlas Management

- **Shelf packing:** glyphs packed left-to-right in rows. Simple, fast, good for glyphs.
- **LRU eviction:** when atlas full, overwrite least-recently-used glyph cell.
- **Atlas array:** WebGPU `texture_2d_array` — when one page fills, add a layer.
- **Dynamic growth:** `copyTextureToTexture` to larger atlas, update uniform atlas dimensions.

### Recommendation for RPE

MSDF first (minimal implementation, good quality), Slug later for infinite-zoom scenarios. The text transducer would claim `@text` nodes and:
1. Shape text (HarfBuzz, cached per content change)
2. Pack glyphs into atlas (shelf packing, lazy population)
3. Build instance buffer (positioned quads)
4. Add instanced draw to command list

---

## 2. AAA Game Engine Techniques

### Rendering Pipelines

**Forward+ (Clustered Forward)** — recommended for RPE:
- Compute pass: divide screen into tiles × depth slices, assign lights to clusters
- Render pass: each fragment evaluates only its cluster's lights
- Handles transparency natively, no G-buffer memory cost
- Maps to RPE's `@dispatch` → `@pass` flow

**Deferred Rendering:**
- G-buffer pass: render normals, albedo, roughness/metallic to MRT (requires MRT support)
- Lighting pass: fullscreen quad reads G-buffer, evaluates all lights
- Requires MRT in RPE (specified but not implemented)

**Visibility Buffer (Nanite-style):**
- Thin visibility buffer: {triangleID, instanceID} per pixel
- Compute pass: fetch vertex data, interpolate attributes, evaluate materials
- Decouples geometry complexity from material complexity

### GPU-Driven Rendering

The core pattern for AAA:
1. **Compute: cull** — frustum + Hi-Z occlusion + LOD selection + backface cone
2. **Compute: compact** — stream compaction via prefix sum (Blelloch scan)
3. **Compute: generate** — write indirect draw arguments to buffer
4. **Render: execute** — `drawIndirect(buffer, offset)`, GPU decides what renders

**Meshlet architecture:**
- Meshes pre-split into 64-128 triangle clusters (meshoptimizer)
- LOD DAG: groups of meshlets simplified via QEM edge collapse
- GPU selects LOD per-meshlet based on screen-space error metric

**Software rasterization** for sub-pixel triangles:
- Compute shader rasterizes tiny triangles directly (avoids hardware overhead)
- Uses `atomicMin` on depth buffer for z-test
- Limited by no 64-bit atomics in WebGPU (workaround: two-pass or packed 32-bit)

**WebGPU support:**
| Feature | Status |
|---|---|
| `drawIndirect` / `drawIndexedIndirect` | Core spec, universal |
| `dispatchWorkgroupsIndirect` | Core spec, universal |
| Multi-draw indirect | Chrome experimental only |
| Mesh shaders | Not in WebGPU |
| 64-bit atomics | Not in WGSL |

### Global Illumination

| Technique | Quality | Cost | WebGPU Feasibility |
|---|---|---|---|
| Screen-space GI | Low-Med | Fast | Full |
| Voxel GI (cone tracing) | Med-High | Medium | Full (3D textures) |
| Radiance cascades | High | Fast-Med | Full |
| DDGI probes | High | Medium | Full |
| Path tracing | Reference | Very high | Software only (compute) |

**Radiance cascades** (Alexander Sannikov): cascading probe grids at exponentially increasing spacing. Distant light = fewer directional samples. Merge cascades coarse→fine. Excellent quality for the cost.

### Physics on GPU

**XPBD** (Extended Position-Based Dynamics): predict positions → solve constraints → finalize velocities. All compute shaders. Graph coloring or Jacobi iteration for parallel constraint solving.

**SPH Fluid:** spatial hashing for neighbor queries, poly6/spiky kernels, density → pressure → force. All compute.

**GPU Particles:** alive/dead lists with atomics, compute update + emit, instanced draw for rendering.

### Animation

- **GPU skinning:** compute shader applies joint matrices to vertices
- **Blend shapes:** compute shader applies weighted morph deltas
- **Crowd rendering:** animation textures (joint matrices baked into float texture), sampled in vertex shader

---

## 3. UI Animation & Motion

### GPU Vector Graphics

**Vello** (Google Fonts, successor to piet-gpu):
- Fully compute-shader pipeline for 2D path rendering
- Stages: flatten → tile → coarse raster → fine raster
- No stencil buffers, no MSAA dependency
- Maps perfectly to WebGPU compute model
- Would power `@path`, `@shape` nodes

**Rive's WebGPU renderer:**
- Production GPU vector graphics with compute-shader tessellation
- Anti-aliased vector rendering at 120fps
- Open source, targets WebGPU directly

### SDF UI Primitives

All basic UI chrome rendered via SDF fragment shader functions — no textures or meshes needed:

```wgsl
fn sdf_rounded_rect(p: vec2f, center: vec2f, half_size: vec2f, radius: f32) -> f32 {
    let d = abs(p - center) - half_size + vec2f(radius);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - radius;
}
```

A `@panel` = quad + SDF rounded rect. A `@button` = `@panel` + `@text` + `@interact`. All GPU-rendered, composable.

### Shadows and Blur

**Analytical box shadows:** erf-based rounded rect formula. Single fragment shader evaluation vs 3+ full-screen passes for Gaussian blur. Dramatically cheaper for rectangular UI.

**Dual Kawase blur:** achieves very large blur radii at fraction of Gaussian cost by working at progressively lower resolutions. The practical choice for frosted glass effects.

### visionOS Aesthetic

Approximable in 2D WebGPU:
- Kawase-blurred background + white tint
- Blue noise grain + subtle specular gradient
- Analytical rounded-rect shadows
- Spring-physics hover animations

### Spring Physics for Animation

**Closed-form damped harmonic oscillator:** Instead of iterative integration, evaluate the analytical solution. Thousands of spring-animated properties in one compute dispatch.

For underdamped case:
```
x(t) = e^(-ζωt) × (A·cos(ωd·t) + B·sin(ωd·t))
where ωd = ω√(1-ζ²)
```

This is evaluable per-element in a compute shader — no step-by-step simulation needed.

### Lottie / Animation Data Model

GPU-native Lottie player: keyframe interpolation, shape morphing, gradient evaluation all parallelize naturally. Main challenge is hierarchical transform propagation and arc-length for trim paths — compute shader problems, not fundamental limitations.

---

## 4. WebGPU Platform & Self-Hosting

### Current WebGPU State (2025-2026)

**Shipped cross-browser (Chrome, Firefox, Safari):**
- Core WebGPU + WGSL
- `timestamp-query`
- `float32-filterable` (Chrome 121+)
- `shader-f16` (Chrome 121+, Safari)
- `indirect-first-instance`
- `rg11b10ufloat-renderable`
- `clip-distances` (Chrome 128+)
- `dual-source-blending` (Chrome 128+)
- Subgroups (Chrome 128+, Safari via Metal SIMD)

**NOT available cross-browser:**
- Multi-draw indirect (Chrome experimental only)
- Bindless textures (not in spec)
- Mesh shaders (not in spec)
- 64-bit atomics (not in WGSL)
- Ray tracing (Chrome experimental only)

**Key limits:**
- `maxBindGroups: 4` — critical for bind group strategy
- `maxStorageBufferBindingSize: 128MB-2GB` (device dependent)
- `maxTextureDimension2D: 8192-16384`
- `maxTextureArrayLayers: 256`

### Compute Shader Patterns

**Prefix sum (Blelloch scan):** Foundation for stream compaction, radix sort, GPU-driven indirect dispatch. Workgroup-level scan with up-sweep/down-sweep, multi-level for large arrays.

**Radix sort:** 4-bit digit per pass. Count → prefix sum → scatter. GPU sorting for depth/transparency.

**Stream compaction:** Mark → prefix sum → scatter. Filter elements by predicate.

**Indirect dispatch:** Compute writes draw args to `STORAGE|INDIRECT` buffer, `drawIndirect` reads them.

### Self-Hosting UI Architecture

How to render Rex in Rex:

1. **Storage buffer UI:** Pack `UIElement` structs into storage buffer. Single instanced draw call renders all elements. Compile phase packs layout. Dynamic state via optic system.

2. **GPU hit testing:** Compute shader (point-in-rect test, atomic max on packed z_order|id). Zero readback for hover visual feedback — render shader reads hovered_id from same storage buffer. CPU reads back only on actual click.

3. **SDF UI chrome:** Fragment shader for rounded rects, shadows, borders. No textures needed for basic UI elements (Zed editor pattern).

4. **Glyph atlas for text:** Shelf-packing, dynamic growth via `copyTextureToTexture`.

5. **Dirty rectangles:** Only re-render changed screen regions.

### WebGPU + WebXR

- `XRGPUBinding` interface connects WebXR sessions to WebGPU textures
- Chrome experimental, Safari/visionOS in development
- Multi-view rendering: texture array with one layer per eye
- Foveated rendering via `XRView.recommendedViewportScale`

---

## 5. Intellectual Lineage

### 5a. Sebastian Aaltonen — "No Graphics API"

**Core thesis:** The GPU is just memory and pointers. Vulkan/DX12/Metal are intermediate bureaucracies that don't correspond to hardware.

**What the GPU actually wants:**
1. A pool of VRAM
2. Pointers (descriptors = 32-64 byte address records)
3. Command buffers (also just memory)
4. Stage masks for synchronization

**Barriers are stage masks, not resource lists.** Aaltonen argues you only need `{srcStageMask, dstStageMask, hazardFlags}`. No per-resource state tracking. RPE's Part 8 implements exactly this.

**Key patterns:**
- Indirect rendering: GPU generates its own draw arguments
- Visibility buffer: thin {triangleID, instanceID} per pixel
- Meshlet + multi-draw indirect
- Persistent resources: allocate once, never per-frame

**RPE extends Aaltonen:** He removes the graphics API from the engine programmer's mental model. RPE removes it from the *user's* mental model entirely. The tree IS the frame. The transducer IS the compiler.

| Aaltonen Principle | RPE Implementation |
|---|---|
| GPU is memory + pointers | One GPUBuffer heap, offsets are pointers |
| Barriers are stage masks | `{before, after, hazards}`, no resource lists |
| Shared struct layouts | `@struct` → heap layout + WGSL + optics |
| Flat command submission | Compiled command list, flat array |
| No per-frame resource churn | Pool entries persist across frames |

### 5b. Profunctor Optics — The Data Access Model

**What are optics?** A family of composable, bidirectional data accessors. Lens (product field), prism (sum case), traversal (collection), iso (invertible transform).

**Profunctor encoding:**
```
type Optic c s t a b = forall p. c p => p a b -> p s t
```

Constraint `c` determines optic kind. Composition is plain function composition — constraints accumulate automatically.

**Categorical formulation** (Clarke et al. 2020, arXiv:2001.07488):
```
Optic((A,B),(S,T)) := ∫^M C(S, M⊗A) ⊗ D(M⊗B, T)
```

The residual M (context around focus) is existentially quantified via the coend. Optics compose modularly — each only knows its own focus.

**RPE's compiled optics are a concrete instantiation:**
- Profunctor = `DataView.setFloat32` / `getFloat32`
- Focus = typed value at byte offset
- Residual = rest of heap (quantified away)
- Composition at compile time collapses to single offset
- Abstract framework guarantees correctness; concrete gives `setFloat32(offset, value)`

**Bidirectionality:** Same offset works forward (tree → heap → GPU → pixels) and backward (input → `@interact` → heap → tree). Channels are `dimap (view source) (set dest) transform`.

**Key papers:**
1. Pickering, Gibbons, Wu. "Profunctor Optics: Modular Data Accessors." 2017 (arXiv:1703.10857)
2. Clarke et al. "Profunctor Optics, a Categorical Update." 2020 (arXiv:2001.07488)
3. Boisseau, Gibbons. "What You Needa Know about Yoneda." 2018

### 5c. Jonathan Blow / JAI — The Execution Model

**Core principles:**
1. **Compile-time execution** (`#run`/`#insert`): arbitrary code at compile time, full language access
2. **No OOP**: no classes, no inheritance, no virtual dispatch
3. **SOA by default**: `[..] SOA(Entity)` toggles layout at compile time
4. **No hidden allocations**: every allocation explicit, allocators as first-class values
5. **Context system**: implicit parameter carrying allocator, logger, thread-local state
6. **No exceptions**: errors as values, visible control flow

**Mike Acton's DOD (Data-Oriented Design):**
- Software transforms data, not models the world
- Where there is one, there are many — design for batch
- Hardware is the platform — cache lines, memory bandwidth are the constraints
- Know your data — profile, don't guess

**RPE embodies all of this:**
- Compile phase IS `#run` — arbitrary computation producing offsets, commands, barriers
- No OOP — transducers are pattern matches on strings, no hierarchy
- Heap is flat — SOA-friendly, contiguous
- Zero per-frame allocation — `setFloat32(offset, value)`, no `new`
- Tree acts as context — carries all state transducers need
- Fallback, never crash — errors trigger recovery, not stack unwinding

### 5d. Convergence

| Influence | Abstraction Eliminated | Replaced By |
|---|---|---|
| Aaltonen | Graphics API | Memory + pointers + stage masks |
| Profunctor optics | Object accessors | Composable, compilable paths → offsets |
| Blow/JAI | Language runtime | Compile-time execution, flat data |

RPE is the convergence:
- **Aaltonen defines the target** — what GPU commands should look like
- **Profunctor optics define the path** — how tree paths compile to memory access
- **Blow/JAI defines the method** — compile everything upfront, execute with zero overhead

The word "projection" is categorical: a morphism from a product to a component. RPE takes the product of all scene state (the tree) and projects it to the screen. The compile phase determines the projection. The execute phase applies it.

---

---

## 6. CUDA — The Native Performance Ceiling

### CUDA vs WebGPU Compute

| Capability | CUDA | WebGPU |
|---|---|---|
| Max threads/block | 1024 | 256 |
| Shared memory | 48-228KB, bank-conflict control | 16KB, no bank control |
| Warp shuffles | `__shfl_sync`, full suite | Subgroups (partial, variable size) |
| Float atomics | Native `atomicAdd` on float | CAS loop only (3-10x slower) |
| 64-bit atomics | Yes | No |
| Dynamic parallelism | Kernels launch child kernels | Not possible |
| Tensor cores | `wmma`, `mma` PTX | Not available |
| Cooperative groups | Arbitrary sync granularity | Workgroup barrier only |
| Unified memory | Page-faulting CPU/GPU | Explicit writeBuffer |
| Kernel graphs | `cudaGraph_t` capture/replay | Not available |
| Occupancy control | `__launch_bounds__`, queries | Opaque |

### Key Insight: RPE's Heap is Superior to Unified Memory

RPE's explicit dirty-range tracking with async copy is more efficient than CUDA unified memory's page-fault-driven migration. Unified memory migrates 4KB pages minimum. RPE tracks 4-byte dirty ranges. For the typical case (slider moves, timer ticks), RPE uploads 4-32 bytes while unified memory would migrate 4KB.

### Native ShrineOS Architecture

```
Rex Tree
  ├── CUDA Transducer (compute: culling, physics, PCN, ML)
  │     Compiles @dispatch to CUDA kernels via NVRTC
  │     CUDA Graphs for compiled command list replay (~5μs vs ~50μs)
  │     Tensor cores for PCN matrix ops
  │     48KB+ shared memory for physics neighbor caches
  │
  └── Vulkan Transducer (rasterization: hardware pipeline)
        Compiles @pass/@draw to Vulkan commands
        Shared heap via external memory interop (zero-copy)
        Synchronization via timeline semaphores

Shared: The Heap (one allocation, visible to both)
  @struct → byte layout → same offsets for CUDA and Vulkan
```

CUDA for compute, Vulkan for rasterization, shared heap for zero-copy. Same tree, same optics, same barrier schedule. The transducer emits different commands per backend.

### Backend Matrix

| Target | Compute | Rasterization | Memory |
|---|---|---|---|
| Browser (current) | WebGPU compute (WGSL) | WebGPU render passes | Heap + writeBuffer |
| Native NVIDIA | CUDA kernels (PTX) | Vulkan render passes | Shared external memory |
| Native Apple | Metal compute (MSL) | Metal render passes | MTLSharedEvent |
| Native AMD | HIP / Vulkan compute | Vulkan render passes | Shared external memory |

### CUDA-Specific Rex Extensions

Attributes consumed only by CUDA transducer, ignored by WebGPU:
```
@dispatch physics_step
  :shader xpbd_solver
  :shared_memory 49152        ;; 48KB (CUDA only)
  :launch_bounds [256 4]      ;; occupancy hints (CUDA only)
  :stream physics              ;; named CUDA stream (CUDA only)
```

Native CUDA content blocks for performance-critical kernels:
```
@dispatch pcn_cue
  :target cuda
  <<<cuda
    extern "C" __global__ void pcn_cue(...) { ... }
  >>>
```

### PCN on CUDA

PCN cost per event: ~0.2ms total (fits alongside 16ms render frames)
- Memory matrix (2048×2048 float, ~16MB): fits in L2 cache
- SGEMV prediction: cuBLAS, ~0.01ms
- Hebbian update: cuBLAS SGER, ~0.1ms
- Cue kernel: trivially parallel, ~0.01ms
- Propagation: 2-3 iterations, ~0.05ms

For WebGPU target: PCN kernels port directly to WGSL compute (2-5x slower but still sub-ms).

---

## 7. PLAN Runtime

*Source: github.com/xocore-tech/PLAN*

### What is PLAN?

**P**ins, **L**aws, **A**pps, **N**ats — a functional programming virtual ISA designed to be frozen and standardized. Every PLAN value is one of four types:

1. **Pin** `(o:<i>)`: Content-addressed wrapper. Creates DAG links. Enables orthogonal persistence to disk. Defers evaluation (lazy).
2. **Law** `(o:{n a b})`: Lambda/function. Arity `n`, argument `a`, body `b`. First-class, embeddable in data.
3. **App** `(o:(f x))`: Function application. Unevaluated = thunk. Partially applied = closure.
4. **Nat** `(o:@)`: Arbitrary-size natural number.

### Execution Model

Supercombinator-based graph reduction (lazy lambda calculus). In-place graph updates as expressions evaluate. Pin wrapping defers computation.

### Orthogonal Persistence via Pins

Pins are the persistence boundary:
- Only pinned values persist to disk
- References between pinned values use content hashes
- Modified branches re-pin; unchanged subtrees keep original pins
- Enables efficient incremental snapshots (Hitchhiker trees)

### Bridge to RPE

PLAN provides what RPE currently lacks:
- **Persistence**: Pin the tree. Undo = restore previous pin.
- **Event sourcing**: Each tree mutation is a PLAN app. History is a chain of pins.
- **Content addressing**: Same tree state = same hash. Deduplication for free.
- **Lazy evaluation**: GPU computations as deferred pinned expressions, forced when results needed.

### Architecture Stack

```
Sire / Runa (user languages)
    ↓
Wisp (macro-assembler bootstrap)
    ↓
Rex (syntax/notation layer)
    ↓
PLAN Virtual ISA (frozen spec)
    ↓
XPLAN (effects: actor model, GPU execution, I/O)
    ↓
Native runtime (x86-64 assembly, no libc)
```

---

## 8. Rex Notation

*Source: github.com/axsys-org/Rex*

### 11 Node Types

**Leaves (5):**
- **Word** — identifiers/numbers: `hello`, `42`
- **Quip** — tick-prefixed literals: `'content`
- **Trad** — double-quoted strings: `"hello"`
- **Slug** — multi-line text (each line prefixed `'`)
- **Ugly** — block strings delimited by multiple ticks

**Structure (6):**
- **Heir** — direct adjacency: `a(b)`, `f[x]`
- **TightPre** — tight prefix: `-x`, `:foo`
- **TightInf** — tight infix: `a.b.c`, `x:xs`
- **NestPre** — nest prefix in brackets: `(+ 3 4)`
- **NestInf** — nest infix in brackets: `(3 + 4)`
- **Block** — indentation-scoped: rune at EOL triggers block

### Rune Precedence (loosest → tightest)

```
; , : # $ ` ~ @ ? \ | ^ & = ! < > + - * / % .
```

Looser runes bind outward. `a+b*c` groups as `a+(b*c)`.

### Brackets

- `()` Paren — conventionally transparent for single elements
- `[]` Brack — square brackets
- `{}` Curly — curly braces
- Clear — implicit grouping (not emitted in source)

### The rexgpu Parser

The JS parser in `src/rex-parser.js` is a simplified Rex implementation tailored for the projection engine. It produces Shrubs (the rexgpu tree node model) with `{type, name, attrs, children, content}`. The Rust implementation at github.com/axsys-org/Rex is the canonical, full-featured parser with all 11 node types, rune precedence, and pretty-printer.

---

## 9. Gap Analysis

See [RPE-GapAnalysis.md](RPE-GapAnalysis.md) for the full comparative analysis of what's implemented vs what the research shows is needed.

---

## 10. What RPE Gets Right

See [RPE-GapAnalysis.md](RPE-GapAnalysis.md) section on architectural strengths.
