# USE.GPU Architecture Spec & Rex Transducer Adoption Analysis

**Status**: Speculative Design Document
**Date**: 2026-02-27
**Source**: Full analysis of use.gpu-master (24 packages, ~150k LOC TypeScript)
**Purpose**: Map use.gpu patterns onto Rex transducer architecture for maximum ceiling

---

## Table of Contents

1. [use.gpu Architecture Inventory](#1-usegpu-architecture-inventory)
2. [Aaltonen's "No Graphics API" Thesis](#2-aaltonens-no-graphics-api-thesis)
3. [Rex Transducer Architecture (Current)](#3-rex-transducer-architecture-current)
4. [Adoption Analysis: Where use.gpu + Aaltonen Patterns Lift Rex](#4-adoption-analysis)
5. [Speculative Design: Rex Fiber Runtime](#5-speculative-design-rex-fiber-runtime)
6. [Speculative Design: Shader Module Linking](#6-speculative-design-shader-module-linking)
7. [Speculative Design: Two-Phase Layout Engine](#7-speculative-design-two-phase-layout-engine)
8. [Speculative Design: ESDT Text System](#8-speculative-design-esdt-text-system)
9. [Speculative Design: Trait Composition](#9-speculative-design-trait-composition)
10. [Cold-Start Templating Architecture](#10-cold-start-templating-architecture)
11. [Transducer Extensibility Architecture](#11-transducer-extensibility-architecture)
12. [Rex Notations as Engines](#12-rex-notations-as-engines)
13. [Feature Exhaustability Matrix](#13-feature-exhaustability-matrix)
14. [Implementation Roadmap](#14-implementation-roadmap)

---

## 1. use.gpu Architecture Inventory

### 1.1 Package Map (24 packages)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                           │
│  app (demo)  ·  react (React bridge)  ·  present (slides/transitions)│
├─────────────────────────────────────────────────────────────────────┤
│                         DOMAIN PACKAGES                              │
│  scene (3D graph)  ·  plot (data viz)  ·  map (tiles/Mercator)      │
│  voxel (MagicaVoxel)  ·  gltf (PBR/animation)                       │
├─────────────────────────────────────────────────────────────────────┤
│                         RENDERING LAYER                              │
│  workbench (passes/draws/materials)  ·  inspect/inspect-gpu (debug) │
├─────────────────────────────────────────────────────────────────────┤
│                         2D/UI LAYER                                  │
│  layout (flex/block/inline/absolute)  ·  glyph (ESDT SDF text)      │
├─────────────────────────────────────────────────────────────────────┤
│                         SHADER LAYER                                 │
│  shader (linking/binding/operators)  ·  wgsl (parser/AST/codegen)   │
│  parse (trait parsers)                                               │
├─────────────────────────────────────────────────────────────────────┤
│                         REACTIVE RUNTIME                             │
│  live (fiber/hooks/combinators/scheduling)  ·  state (stores)       │
│  traits (type-safe composition)                                      │
├─────────────────────────────────────────────────────────────────────┤
│                         GPU ABSTRACTION                              │
│  webgpu (device/canvas/context)  ·  core (buffers/textures/formats) │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Core: Reactive Fiber System (`live`)

The beating heart. React-like fiber tree with hooks, but purpose-built for GPU workloads.

**Fiber Lifecycle**: `makeFiber()` → `bind()` → `enterFiber(fiber, base)` → execute → `exitFiber()` → `discardState()`

**Hook System** (STATE_SLOTS = 3 per hook in `fiber.state[]`):
| Hook | Signature | Purpose |
|------|-----------|---------|
| `useState` | `(init) → [T, Setter<T>]` | Mutable state with scheduling |
| `useMemo` | `(fn, deps) → T` | Dependency-tracked memoization |
| `useOne` | `(fn, dep) → T` | Single-dep memo (optimized path) |
| `useCallback` | `(fn, deps) → T` | Stable function reference |
| `useVersion` | `(value) → number` | Change counter |
| `useResource` | `(fn, deps) → R` | Lifecycle-managed resource with cleanup |
| `useContext` | `(ctx) → C` | Hierarchical context consumption |
| `useCapture` | `(ctx, value) → void` | Context registration (inverse of useContext) |
| `useHooks` | `(fn, deps) → T` | Nested hook scope |

**Combinators** (the real power):
| Combinator | Signature | What It Does |
|------------|-----------|--------------|
| `use(f, ...args)` | → `DeferredCall<F>` | Declare child fiber |
| `keyed(f, key, ...args)` | → `DeferredCall<F>` | Keyed child (stable reconciliation) |
| `gather(calls, then)` | → `DeferredCall` | Collect all `yeet()` values from children into array |
| `multiGather(calls, then)` | → `DeferredCall` | Collect `yeet()` values by key into `Record<string, T[]>` |
| `yeet(value)` | → `DeferredCall` | Emit value upstream to nearest gather |
| `fence(calls, then)` | → `DeferredCall` | Gate: pass through existing gather function |
| `provide(ctx, value, calls)` | → `DeferredCall` | Scope context for children |
| `capture(ctx, calls, then)` | → `DeferredCall` | Collect captured context values from children |
| `reconcileTo(r, calls)` | → `DeferredCall` | Render into separate reconciled tree |
| `quoteTo(r, calls)` | → `DeferredCall` | Deferred rendering into reconciler |
| `unquote(calls)` | → `DeferredCall` | Escape quoted context |
| `morph(calls, key)` | → `DeferredCall` | Type-change without child disposal |
| `fragment(calls)` | → `LiveElement` | Inline children as siblings |
| `mapReduce(calls, map, reduce, then)` | → `DeferredCall` | Map/reduce over child yeet values |

**Scheduling**: Action queue → `request(flush)` batches via microtask → priority queue in depth-first tree order → `renderFibers()` loop pops fibers until empty. Stack slicing prevents overflow on deep trees (async dispatch when depth exceeded).

**Key Insight**: The fiber system is a **general-purpose incremental computation engine**. It is not tied to rendering. Any Rex transducer could be expressed as a fiber tree.

### 1.3 Traits: Type-Safe Component Composition (`traits`)

```typescript
// Definition: parser functions per key
const myTrait = trait({
  x: (v: number) => v * 2,
  y: (v?: string) => v ?? 'default',
});

// Composition: flat merge
const combined = combine(traitA, traitB, traitC);

// Usage: parse once, stable reference
const parsed = useTrait(props, combined);
```

**Key Property**: Traits are bidirectional parsers. Input type → output type with validation and defaults. The composition model is profunctor-adjacent: `combine()` = tensor product of parsers.

### 1.4 Shader: Module Linking System (`shader` + `wgsl`)

**Pipeline**: WGSL source → Lezer grammar → AST → symbol table → linker

**Annotations**:
- `@export fn foo()` — visible to other modules
- `@link fn bar()` — slot that must be filled by another module
- `@optional fn baz()` — link slot with fallback
- `@infer fn qux()` — type inferred from linked module
- `@global var x` — no namespace prefixing

**Linking Algorithm** (`loadBundlesInOrder` → namespace → resolve → shake → emit):
1. Topological sort of module dependency graph
2. Namespace isolation: `_00_`, `_01_` prefixes per non-main module
3. Import resolution: map local names to namespaced targets
4. External link resolution: fill `@link` slots from provided implementations
5. Tree shaking: dependency graph → remove unreachable symbols
6. Virtual module rendering: generated accessor code for bindings
7. AST-based rewriting: preserve formatting, rename via Lezer tree

**Virtual Modules**: Runtime-generated WGSL code (binding accessors, type casts, struct definitions). Each has a `render(namespace, rename, bindingBase, volatileBase)` function that emits WGSL on demand.

**Operators** (composable shader transforms):
- `castTo`: Type conversion with optional swizzle
- `chainTo`: Function composition (f ∘ g)
- `diffBy`: Numerical differentiation
- `explode`: Struct member extraction
- `instanceWith`: Instance data binding
- `structType`: Struct definition generation

**Binding Resolution** (`resolveBindings()`):
```
@group(0) PASS       — view matrices, lights, shadows
@group(1) VIRTUAL    — storage buffers, textures (geometry-owned)
@group(2) VOLATILE   — time, input, per-frame computed values
@group(3) CUSTOM     — user-defined
```

### 1.5 Layout: Two-Phase Constraint Engine (`layout`)

**Model**: `minMax()` → `fit()` — measure intrinsic sizes, then allocate actual space.

**LayoutElement contract**:
```typescript
{
  sizing: [minX, minY, maxX, maxY],  // intrinsic bounds
  margin: [ml, mt, mr, mb],
  ratioX?, ratioY?,   // flex ratio for width/height
  grow?, shrink?,      // flex factors
  absolute?, under?,   // out-of-flow positioning
  stretch?, inline?,   // fill remaining / baseline alignment
  flex?,               // cross-axis alignment (Anchor)
  fit: (FitInto) => LayoutFit,     // phase 2 resolver
  prefit: (FitInto) => LayoutFit,  // cached variant
}
```

**FitInto** = `[availW | null, availH | null, maxW, maxH]` — null means unconstrained.

**Display Types**:
| Type | Algorithm | Key Feature |
|------|-----------|-------------|
| Flex | `fitFlex()` | CSS Flexbox: grow/shrink/wrap/align/justify. Cursor-based line breaking. |
| Block | `fitBlock()` | Vertical flow with collapsing margins. Stretch mode. |
| Inline | `fitInline()` | Text line breaking + baseline alignment. Two cursor modes: greedy and Knuth-Plass optimal paragraph. |
| Absolute | — | Positioned outside flow, uses container bounds. |

**Flex Algorithm Detail**:
1. Separate absolute vs flow children
2. Create flex cursor with available main-axis space
3. Push phase: compute flex basis per child (ratio × space, or intrinsic via prefit)
4. Gather phase per row: apply grow/shrink distribution, cross-axis alignment via anchor
5. Cross-axis row distribution: justify, between, evenly, start/center/end
6. Absolute children: fit into total container bounds, render under/over flow

**Inline Text Breaking**:
- `makeInlineCursor()`: greedy left-to-right line breaking
- `makeInlineBalancedCursor()`: Knuth-Plass dynamic programming (minimum slack²)
- Spans carry `[advance, trim, hard_break]` triplets
- Baseline alignment modes: `base`, `base-center`, `center`, `start`, `end`

### 1.6 Glyph: ESDT Text Rendering (`glyph`)

**ESDT = Extended Squared Distance Transform** — subpixel-precision SDF, not traditional SDF/MSDF.

**Pipeline**:
```
Font metrics (ab_glyph / Rust WASM)
  → Canvas rasterization (or native rasterization)
  → Alpha channel extraction
  → paintSubpixelOffsets() — 3×3 neighborhood gradient → displacement vectors (xo, yo, xi, yi)
  → esdt1d() × 2 passes (Felzenszwalb & Huttenlocher) — outer + inner distance transforms
  → Resolve: distance = sqrt(xo² + yo²) - sqrt(xi² + yi²)
  → Map to alpha via radius + cutoff: α = 255 - 255 * (d/radius + cutoff)
```

**Key Innovation**: Instead of just storing distances, ESDT stores **displacement vectors** (xo, yo for outer edge, xi, yi for inner edge). This enables subpixel accuracy — the distance is computed from the exact edge position within each pixel, not just from pixel centers.

**Rendering**: Atlas packed → instanced quads with UV mapping → fragment shader samples SDF → `smoothstep()` for antialiasing.

### 1.7 WebGPU Abstraction (`webgpu` + `core`)

**Resource Management**: All GPU resources are fiber-owned. `useMemo()` creates on first render; cleanup via `useResource()` disposal tracking. No manual pools — fiber lifecycle IS the pool.

**Buffer Types**: Vertex, Uniform, Storage, Indirect, Readback — each with appropriate usage flags.

**Texture Types**: Dynamic (all usage), Target (render attachment), Storage (compute), Readback (map read).

**Double Buffering**: `useDouble()` hook → ping-pong swap pattern for render targets and history buffers.

### 1.8 Workbench: Rendering Infrastructure

**Pass Architecture** (ForwardRenderer):
```
Pre-commands → Compute → ShadowPass → NormalPass → MotionPass → SSAOPass
  → ColorPass (opaque → transparent → debug) → OITPass → OutlinePass → PickingPass
  → Readback
```

**DrawCall Pattern**: Components `yeet()` draw commands → PassReconciler gathers them → sorted by depth (opaque front-to-back, transparent back-to-front) → frustum culled → batch executed.

**Reconciler Types** (each forms a separate reduction phase):
- EventReconciler: DOM event gathering
- QueueReconciler: GPU command batching
- PassReconciler: Render call aggregation
- LayerReconciler: 2D layer composition

### 1.9 Domain Packages

**Scene** (`scene`): Hierarchical transforms via MatrixContext. Node composes position/scale/quaternion → mat4. Instances use schema-driven GPU buffers. Batch deferred rendering via PassReconciler.

**Plot** (`plot`): Scale generators (linear/log) → DataContext → shape components (point/line/face/label) → view transforms (cartesian/polar/spherical/stereographic). Trait-based attribute parsing.

**Map** (`map`): QuadTree LOD with async tile loading → MVT parsing in worker → aggregate into GPU buffers → WebMercator projection shader. Strategy pattern for visibility culling.

**Voxel** (`voxel`): MagicaVoxel .vox → mipmapped 3D textures → ray-casting fragment shader with MIP-based octree traversal + optional SDF acceleration at coarse level. PBR material system.

**glTF** (`gltf`): Full PBR pipeline with morph targets, skeletal animation, transmission/volume extensions.

**Present** (`present`): Slide deck with transitions. Stage gathers layers → off-screen render to rgba16float → apply transition mask shader → composite.

### 1.10 WGSL Shader Library (300+ files)

26 categories: pbr, sdf, transform, noise, color, tone-mapping, ssao, oit, shadow, light, blur, edge-detect, motion, deformation, particle, geometry, mesh, instance, uv, atlas, text, quad, debug, util, random, sampler.

---

## 2. Aaltonen's "No Graphics API" Thesis

**Source**: [sebastianaaltonen.com/blog/no-graphics-api](https://www.sebastianaaltonen.com/blog/no-graphics-api) (Dec 2025)
**Author**: Sebastian Aaltonen — 30 years graphics programming, optimized Unreal Engine 4, led Unity DOTS graphics team, currently building HypeHype renderer (WebGPU/Metal/Vulkan), Vulkan Advisory Panel member.

### 2.1 Core Argument

Modern GPUs have converged. Coherent caches, bindless resources, 64-bit pointers, generic SIMD execution — every major architecture (AMD RDNA, Nvidia Ampere+, Apple M-series, Qualcomm Adreno) now supports these. The complexity of Vulkan/DX12/Metal exists because of hardware from 2012-2013 that no longer ships. Strip 10 years of compatibility baggage and you get a drastically simpler interface with equal or better performance.

The PSO (Pipeline State Object) permutation explosion is the most visible symptom: "Vendors (Valve, Nvidia, etc) have massive cloud servers storing terabytes of PSOs for each different architecture/driver combination. User's local PSO cache size can exceed 100GB."

### 2.2 The Entire API (Fits on One Screen)

**Memory** — CUDA-style simplicity:
```c
uint32* gpuMalloc(size_t size);
uint32* gpuMalloc(size_t size, size_t alignment, MemoryType type);
void    gpuFree(void* ptr);
void*   gpuHostToDevicePointer(void* hostPtr);  // called once per allocation
```

Three memory types:
| Type | Use Case | Properties |
|------|----------|------------|
| `MEMORY_CPU_MAPPED` | Default. Uniforms, small data. | ReBAR/UMA, CPU write + GPU read. Write-combined. |
| `MEMORY_GPU` | Textures, large buffers. | DCC compression, Morton swizzle. Copy-only from CPU. |
| `MEMORY_READBACK` | Screenshots, virtual texturing. | CPU-cached, slower GPU writes, fast CPU reads. |

**Root Arguments** — The revolutionary simplification. Instead of descriptor sets, root signatures, bind groups — every shader receives a **single 64-bit pointer to a user-defined struct**:

```c
struct alignas(16) ComputeData {
    float16x4 color;
    uint16x2 offset;
    const uint8* lut;          // 64-bit GPU pointer to lookup table
    const uint32* input;       // 64-bit GPU pointer to input buffer
    uint32* output;            // 64-bit GPU pointer to output buffer
};

// CPU side: write struct into CPU-mapped GPU memory
auto data = bumpAllocator.allocate<ComputeData>();
data.cpu->color = {1.0f, 0.0f, 0.0f, 1.0f};
data.cpu->lut = luts.gpu + 64;    // pointer arithmetic works
data.cpu->input = input.gpu;
data.cpu->output = output.gpu;

// Dispatch: just pass the GPU pointer
gpuDispatch(commandBuffer, data.gpu, uvec3(128, 1, 1));

// GPU side: shader receives pointer, dereferences struct
[groupsize = (64, 1, 1)]
void main(uint32x3 threadId : SV_ThreadID, const ComputeData* data) {
    uint32 value = data->input[threadId.x];
    data->output[threadId.x] = value;
}
```

No binding tables. No descriptor updates. No root signatures. The struct IS the interface.

**Texture Descriptor Heap** — Global array of 256-bit hardware descriptor blobs, indexed by 32-bit integers:

```c
// CPU: allocate heap, create texture, write descriptor
GpuTextureDescriptor* textureHeap = gpuMalloc<GpuTextureDescriptor>(65536);
GpuTexture texture = gpuCreateTexture(desc, gpuMalloc(sizeAlign.size, sizeAlign.align, MEMORY_GPU));
textureHeap[0] = gpuTextureViewDescriptor(texture, { .format = FORMAT_RGBA8_UNORM });
gpuSetActiveTextureHeapPtr(commandBuffer, gpuHostToDevicePointer(textureHeap));

// GPU: index into global heap
const Texture textureHeap[];
Texture albedo = textureHeap[data->textureBase + 0];    // 32-bit index
Texture normal = textureHeap[data->textureBase + 1];    // 4 bytes per reference
float4 color = sample(albedo, sampler, uv);
```

Key insight: "A 32-bit heap index is just 4 bytes, we can send it per lane...it is not feasible to fetch and send a full 256-bit descriptor per lane."

**Pipeline Creation** — Trivial:
```c
GpuPipeline pipeline = gpuCreateComputePipeline(shaderIR);
GpuPipeline pipeline = gpuCreateComputePipeline(shaderIR, &constants);  // with specialization
GpuPipeline pipeline = gpuCreateGraphicsPipeline(vsIR, psIR);
```

No descriptor layouts, no root signature definitions, no bind groups, no pipeline layout objects.

**Specialization Constants** — Replace PSO permutation explosion:
```c
struct Constants {
    int32 qualityLevel;
    uint8* blueNoiseLUT;    // can embed GPU pointers
};
Constants consts { .qualityLevel = 2, .blueNoiseLUT = lut.gpu };
GpuPipeline pipeline = gpuCreateComputePipeline(shaderIR, &consts);

// GPU: constants are compile-time known → dead code elimination
void main(uint32x3 tid : SV_ThreadID, const Data* data, const Constants constants) {
    if (constants.qualityLevel == 3) { /* compiler eliminates this branch */ }
}
```

Advantage over Vulkan's specialization constants: "Specialization constants can't modify the descriptor set layouts...Our proposed design doesn't have the same problem. One can simply branch by a constant."

**Barriers** — Stage masks only:
```c
gpuBarrier(cb, STAGE_COMPUTE, STAGE_COMPUTE);
gpuBarrier(cb, STAGE_COMPUTE, STAGE_COMPUTE, HAZARD_DESCRIPTORS);
gpuBarrier(cb, STAGE_RASTER_COLOR_OUT | STAGE_RASTER_DEPTH_OUT, STAGE_PIXEL_SHADER);
```

No resource lists. No layout transitions. No access type tracking. Modern coherent L2$ makes resource transitions obsolete. Only three special caches need explicit invalidation:
- `HAZARD_DESCRIPTORS`: texture descriptor cache
- `HAZARD_DRAW_ARGS`: draw argument prefetcher
- `HAZARD_DEPTH`: depth/HiZ cache

**Complete Function List**:
| Category | Functions |
|----------|-----------|
| Memory | `gpuMalloc`, `gpuFree`, `gpuHostToDevicePointer` |
| Pipelines | `gpuCreateComputePipeline`, `gpuCreateGraphicsPipeline`, `gpuFreePipeline` |
| Queue | `gpuCreateQueue`, `gpuStartCommandRecording`, `gpuSubmit` |
| Sync | `gpuCreateSemaphore`, `gpuWaitSemaphore`, `gpuDestroySemaphore` |
| Commands | `gpuMemCpy`, `gpuBarrier`, `gpuSignalAfter`, `gpuWaitBefore` |
| Draw/Dispatch | `gpuSetPipeline`, `gpuDispatch`, `gpuDispatchIndirect`, `gpuDraw`, `gpuDrawIndexed` |
| Render Pass | `gpuBeginRenderPass`, `gpuEndRenderPass` |
| Textures | `gpuCreateTexture`, `gpuTextureSizeAlign`, `gpuTextureViewDescriptor`, `gpuCopyToTexture`, `gpuSetActiveTextureHeapPtr` |

That's it. ~25 functions vs hundreds in Vulkan/DX12.

### 2.3 Historical Context: How APIs Became Complex

Aaltonen traces 30 years of hardware constraints shaping API design:

| Era | Hardware | API Consequence |
|-----|----------|-----------------|
| **3dFX Voodoo (1998)** | 3 separate chips (rasterizer + 2 texture samplers), no geometry pipeline, no programmable shaders | OpenGL/DX designed around separate texture memory, fixed function |
| **GeForce 256** | First integrated GPU with geometry engine | DX7 added uniform constants, render-to-texture |
| **DX8-9 (SM 1.0-3.0)** | Fixed vertex formats, no pixel-shader texture sampling until SM3 | UVs calculated at vertex stage, interpolated; HLSL/GLSL born from instruction limits |
| **DX11 (2009)** | First compute shaders, generic read-write buffers | "Whole zoo" of buffer types: typed SRV/UAV, byte address, structured, append/consume, constant, vertex, index |
| **DX12/Vulkan/Metal (2015)** | Ahead-of-time state bundling; GPU hardware DIDN'T widely support bindless | Complex binding models (descriptor sets, root signatures, argument buffers) to abstract hardware differences |
| **Now (2025)** | All major GPUs: coherent L2$, bindless, 64-bit pointers, generic SIMD | All that complexity is compatibility baggage for hardware that no longer exists |

### 2.4 Hardware Convergence

**AMD GCN → RDNA**: GCN (2012) had non-coherent ROPs, no coherent last-level cache, texture samplers couldn't read DCC-compressed data, required full L2$ flush-to-VRAM on barriers. RDNA (2019): coherent L2$ covering all memory operations, ROPs and command processor are L2$ clients, DCC (de)compressor between L2$ and texture L0$, barriers only flush tiny L0$/K$ caches. **No VRAM traffic for barriers.**

**Mobile (TBDR)**: Tile-based deferred renderers (Mali, Adreno) bin triangles to small tiles. "Mesh shaders are too coarse grained...There's no clear convergence path. We still need to support the vertex shader path." This is the one area where Aaltonen's simplification hits limits — Rex's WebGPU target is already vertex-shader-only, so this constraint is pre-satisfied.

### 2.5 What This Means for Shader Languages

The proposed design requires C/C++-style shaders with:
- Native 64-bit pointer support (CUDA has this; HLSL/GLSL do not)
- Pointer arithmetic and struct dereferencing
- Wide load/unpack patterns (128-bit loads for 4×f32)
- 8/16-bit types with register packing
- `NonUniformResourceIndex()` for per-lane descriptor indexing
- Native texture/sampler types with operator overloading

**WGSL gap**: WebGPU's WGSL has none of these. No 64-bit pointers, no pointer arithmetic, no struct load/store. WGSL is the most constrained shader language in active use. However, WGSL does have storage buffers with byte-offset access (`array<u32>` with manual offset arithmetic), which is exactly what Rex's compiled optics exploit.

### 2.6 Aaltonen vs use.gpu: Complementary Not Competing

| Concern | Aaltonen | use.gpu | Rex Synthesis |
|---------|----------|---------|---------------|
| **Memory model** | `gpuMalloc` → direct CPU-mapped GPU pointers | Per-resource `useMemo()` allocation | Rex heap: one ArrayBuffer, compiled offsets, dirty range upload |
| **Resource binding** | Single root struct pointer, 32-bit heap indices | Fiber-owned bind groups, volatile bindings | Rex optics: tree paths → `(buffer, byte_offset, size)` at compile time |
| **Shader composition** | Specialization constants + dead code elimination | AST-based module linking with @export/@link | Rex should adopt BOTH: module linking for composition, spec constants for variants |
| **Barriers** | Stage masks only, no resource lists | Implicit via fiber scheduling | Rex barrier schedule: compile-time topological sort of pass dependencies |
| **Pipeline creation** | Shader IR + optional constants struct | Async pipeline with memoization | Rex: tree-declared pipelines with uber-shader + spec constant variants |
| **Incremental update** | Not addressed (static engine model) | Fiber-based dirty subtree re-rendering | Rex fiber runtime (proposed Phase 1) |
| **Layout/Text** | Not addressed (GPU-only concerns) | Full flex/block/inline + ESDT text | Rex adopts use.gpu patterns wholesale |

**Key insight**: Aaltonen addresses the **GPU interface** (how to talk to hardware efficiently). use.gpu addresses the **computation model** (how to organize rendering work incrementally). Rex needs both — Aaltonen's memory model IS the Rex heap, and use.gpu's fiber model IS the Rex incremental compiler.

### 2.7 Rex's Aaltonen Alignment (Already Present)

Rex was built on Aaltonen's principles from day one, as documented in [RPE-03-gpu-pipeline.md](RPE-03-gpu-pipeline.md):

1. **"Everything is GPU memory + pointers"** — Rex paths compile to `(buffer_id, byte_offset, byte_length)` tuples. No descriptor sets, no binding tables at the optic level. This IS Aaltonen's root struct model, realized over WebGPU's constraint surface.

2. **"Unified descriptor heap"** — Rex's `@struct` declarations compile to a single heap buffer. All uniform data lives in one ArrayBuffer with compiled byte offsets. Materials carry texture indices, not texture objects.

3. **"Bindless by default"** — Rex shaders access resources via indices loaded from the scene buffer. The heap IS the bindless resource table.

4. **"Single shader language"** — WGSL embedded in tree notation. Shaders are tree nodes, not external files.

5. **"Minimal API surface"** — The tree notation IS the API. Users write `@buffer name :struct Type :usage [storage]`; the compiler creates the GPU resource.

6. **"CUDA-style malloc"** — Rex's staging buffer is CPU-mapped. Attribute micro-patches write directly at pre-compiled offsets. One `writeBuffer` per frame uploads the dirty region.

### 2.8 The WebGPU Gap

WebGPU cannot fully express Aaltonen's vision because:
- No 64-bit GPU pointers in WGSL
- No global texture descriptor heap (bind groups required)
- `maxStorageBufferBindingSize` limits (128MB–2GB)
- No mesh shaders (vertex pulling via storage buffers)
- No 64-bit atomics
- No work graphs

Rex compensates by compiling the Aaltonen model *on top of* WebGPU:
- Compiled optics replace 64-bit pointers with pre-computed byte offsets
- A single bind group per frame approximates a global heap
- Barrier schedule replaces manual barrier calls with compile-time analysis
- Uber-shaders with `override` constants replace runtime PSO switching

When WebGPU eventually gains pointer-like features (bindless extensions are in discussion), Rex's compiled optic model will map directly to Aaltonen's root struct — the abstraction gap closes to zero.

---

## 3. Rex Transducer Architecture (Current)

### 3.1 Compile/Execute Split

Rex operates on a fundamentally different model from use.gpu:

```
Rex Source → Parse (Shrub tree) → Compile (flat command list + optic table + heap layout)
  → Execute (tight loop: write bytes → upload dirty range → iterate commands)
```

There is no fiber tree, no reactive re-rendering, no hooks. The compile phase produces a **static command list**. The execute phase is a **flat loop**.

### 3.2 Current Transducers

| Transducer | File | Responsibility |
|------------|------|----------------|
| GPU | `rex-gpu.js` | WebGPU resources, shaders, pipelines, draw/dispatch commands |
| Surface | `rex-surface.js` | 2D compute renderer: @rect, @text, @panel, @path, @shadow |
| Behaviour | `rex-behaviour.js` | Reactive state: @shrub/@def/@derive/@talk/@dep/@channel |
| Form | `rex-form.js` | HTML widget generation from @form subtrees |

### 3.3 Strengths of Current Architecture

1. **Zero-copy heap**: One ArrayBuffer, one GPUBuffer, compiled byte offsets, dirty range tracking. This is *more efficient than use.gpu* for uniform data — use.gpu creates many small buffers per DrawCall. **This IS Aaltonen's `gpuMalloc` + root struct model**, realized over WebGPU. The heap is the closest thing to a global bindless resource table that WebGPU allows.

2. **Compiled optics**: Tree paths → byte offsets at compile time. Runtime: `setFloat32(offset, value)`. No indirection. This is *conceptually superior to both use.gpu's binding system AND Aaltonen's 64-bit pointers* — Rex resolves at compile time what Aaltonen resolves at runtime. Zero-cost by construction.

3. **Single-pass compilation**: No dependency resolution overhead. The tree IS the execution order. For simple cases, this is optimal.

4. **Behaviour transducer**: The @shrub/@derive/@talk system has no equivalent in use.gpu or Aaltonen's model (which doesn't address application state at all). It's a genuine advantage — declarative reactive state with causal tracking, self-healing, and ShrubLM integration.

5. **Barrier schedule**: Rex's compile-time pass dependency analysis mirrors Aaltonen's stage-mask-only barrier model. The tree declares `@pass` nodes with `:read`/`:target` annotations; the compiler extracts the dependency graph and inserts barriers automatically. No manual resource tracking.

### 3.4 Weaknesses (Where use.gpu + Aaltonen Patterns Would Help)

1. **No incremental update**: Any structural change recompiles everything. use.gpu's fiber system only re-renders dirty subtrees.

2. **No shader composition**: Rex uses string templates with `$param` substitution. use.gpu has AST-based module linking with tree shaking. Rex can't compose shaders from fragments.

3. **No layout constraint propagation**: Rex's `_collectPanel` does single-pass sizing. use.gpu's two-phase minMax→fit with flex cursors handles complex nested layouts correctly.

4. **No text reflow**: Rex rasterizes glyphs to a fixed atlas. No line breaking, no paragraph optimization, no baseline alignment, no font metrics integration.

5. **No trait composition**: Rex parses attrs ad-hoc per transducer. use.gpu's trait system provides composable, type-safe attribute parsing with defaults and validation.

6. **No gather/yeet**: Rex can't collect values from children and process them at a parent level. This pattern is essential for batching, reconciliation, and aggregation.

7. **No resource lifecycle management**: Rex creates all resources at compile time and holds them forever. use.gpu's fiber-owned resources are created/destroyed with component lifecycle.

---

## 4. Adoption Analysis: Where use.gpu + Aaltonen Patterns Lift Rex

### 4.1 Pattern Compatibility Matrix

| use.gpu Pattern | Rex Adoptable? | Effort | Ceiling Gain |
|-----------------|---------------|--------|--------------|
| Fiber runtime | **Yes, critical** | High | 10× — enables incremental updates, streaming compilation |
| Hook system | **Yes** | Medium | 5× — memoization, resource lifecycle, state management |
| gather/yeet | **Yes, critical** | Medium | 10× — batching, reconciliation, aggregation |
| Shader linking | **Yes** | High | 8× — composable shaders, virtual modules, tree shaking |
| Two-phase layout | **Partially done** | Medium | 3× — already enhanced, needs cursor system |
| ESDT text | **Yes** | High | 7× — subpixel SDF, line breaking, paragraph optimization |
| Trait system | **Yes** | Low | 3× — composable attr parsing, already conceptually present |
| Reconcilers | **Yes** | Medium | 5× — command batching, event gathering, layer composition |
| Context propagation | **Yes** | Low | 3× — hierarchical data flow |
| Stack slicing | **Yes** | Low | 2× — deep tree safety |
| Virtual modules | **Yes** | Medium | 4× — dynamic code generation for bindings |
| Specialization constants (Aaltonen) | **Yes, already supported** | Low | 5× — eliminates PSO permutation explosion, WGSL `override` works today |
| Stage-mask barriers (Aaltonen) | **Already present** | Done | — Rex compile-time barrier schedule IS this pattern |
| Root struct model (Aaltonen) | **Already present** | Done | — Rex heap + compiled optics IS this pattern over WebGPU |
| Bump allocator (Aaltonen) | **Yes** | Low | 2× — per-frame scratch allocation for transient data |

### 4.2 What NOT to Adopt

1. **React dependency**: use.gpu's `@use-gpu/react` bridge is unnecessary. Rex's own fiber runtime should be the host.

2. **TypeScript type system**: use.gpu relies heavily on TypeScript's type inference for trait composition. Rex's dynamic nature makes this unnecessary — runtime validation is simpler.

3. **Per-DrawCall buffer allocation**: use.gpu creates uniform buffers per draw call. Rex's heap model is better — one buffer, compiled offsets, dirty range upload.

4. **Lezer parser for WGSL**: Rex should use its own WGSL content-type preprocessing. The full Lezer grammar is overkill when Rex already has a parser that handles WGSL blocks.

### 4.3 The Core Thesis

**use.gpu is a component library. Aaltonen's thesis is a hardware interface philosophy. Rex should adopt use.gpu's *architectural patterns* without its component tree, and validate its GPU interface against Aaltonen's principles.**

The key patterns from use.gpu:
- **Fiber-based incremental computation** for transducer execution
- **gather/yeet** for multi-pass aggregation
- **Shader module linking** for composable WGSL
- **Two-phase layout** for correct flex/block/inline
- **ESDT** for production text rendering
- **Traits** for composable attribute parsing
- **Reconcilers** for batched command recording

The key patterns from Aaltonen:
- **Root struct pointer** — Rex's heap + optics already implement this
- **32-bit texture heap indices** — Rex's `@struct` texture references already use indices
- **Stage-mask-only barriers** — Rex's compile-time barrier schedule already implements this
- **Specialization constants** — Rex should adopt for uber-shader variant elimination
- **Bump allocator** — Rex should adopt for per-frame transient allocations

The key differences (Rex advantages):
- Rex uses tree notation, not JSX (human-authored, not code-generated)
- Rex compiles to flat commands, not a reactive component tree (Aaltonen-aligned: minimal abstraction)
- Rex has a zero-copy heap, not per-resource buffers (Aaltonen-aligned: one buffer, direct offsets)
- Rex has a behaviour transducer (neither use.gpu nor Aaltonen address application state)
- Rex has compiled optics that resolve at compile time what Aaltonen resolves at runtime (zero-cost by construction)

The synthesis: **Rex fibers compile tree notation into command lists via use.gpu's incremental patterns. The command lists target Aaltonen's memory model (one heap, compiled offsets, stage-mask barriers) expressed over WebGPU. When WebGPU gains bindless extensions, Rex's optic model maps directly to Aaltonen's root struct — the abstraction gap closes to zero.**

---

## 5. Speculative Design: Rex Fiber Runtime

### 5.1 The Rex Fiber

A Rex fiber wraps a transducer's compilation of a subtree. When the subtree changes, only that fiber re-executes.

```javascript
class RexFiber {
  constructor(transducer, node, parent) {
    this.transducer = transducer;  // which transducer owns this fiber
    this.node = node;              // Shrub node this fiber compiles
    this.parent = parent;
    this.children = new Map();     // key → RexFiber
    this.state = [];               // hook state array (use.gpu pattern)
    this.pointer = 0;              // hook slot pointer
    this.version = 0;              // memoization version
    this.memo = -1;                // last rendered version
    this.depth = parent ? parent.depth + 1 : 0;
    this.yeeted = null;            // value emitted upstream
    this.commands = [];            // compiled GPU commands from this fiber
    this.heapSlice = null;         // byte range in heap this fiber owns
  }
}
```

### 5.2 Fiber Hooks for Rex

```javascript
// State that persists across re-compilations
const [value, setValue] = rexUseState(initialValue);

// Memoize expensive computation
const result = rexUseMemo(() => expensiveComputation(), [dep1, dep2]);

// GPU resource with cleanup
const buffer = rexUseResource((dispose) => {
  const buf = device.createBuffer({...});
  dispose(() => buf.destroy());
  return buf;
}, [size, usage]);

// Read from parent context (e.g., current clip rect, transform matrix)
const clipRect = rexUseContext(ClipContext);

// Emit value to parent (e.g., intrinsic size for layout)
rexYeet({ width: 100, height: 50, commands: [...] });
```

### 5.3 Transducer as Fiber Factory

Each transducer becomes a fiber factory. When it encounters a node type it handles, it creates a fiber:

```javascript
class RexSurface {
  compileFiber(fiber, node) {
    const type = node.rune + node.word;
    switch (type) {
      case '@panel': return this._compilePanel(fiber, node);
      case '@rect':  return this._compileRect(fiber, node);
      case '@text':  return this._compileText(fiber, node);
      // Extension handlers
      default: {
        const handler = this._elementHandlers.get(type);
        if (handler) return handler.compile(fiber, node);
      }
    }
  }

  _compilePanel(fiber, node) {
    // Phase 1: gather child sizes via yeet
    const childSizes = rexGather(node.children, (child) => {
      return this.compileFiber(child.fiber, child.node);
    });

    // Phase 2: run layout algorithm
    const layout = rexUseMemo(() => {
      return this._layoutFlex(childSizes, node.attrs);
    }, [childSizes, node.attrs]);

    // Phase 3: emit own size + commands
    rexYeet({
      sizing: layout.sizing,
      commands: layout.commands,
    });
  }
}
```

### 5.4 Incremental Re-compilation

When a Rex source changes:
1. Parse diff: identify which Shrub nodes changed
2. Mark dirty fibers: only fibers whose nodes changed
3. Re-render fibers in depth-first tree order (priority queue)
4. Each fiber re-executes, but `rexUseMemo()` skips unchanged computations
5. `rexYeet()` propagates changed sizes/commands upstream
6. Parent fibers re-layout only if child sizes changed
7. Final: new command list = merge of unchanged + recompiled commands

### 5.5 Scheduling

```javascript
class RexFiberHost {
  constructor() {
    this.queue = new PriorityQueue(compareFiberDepth);
    this.pendingActions = [];
  }

  // Mark fiber dirty (from source edit, form change, channel push)
  visit(fiber) { this.queue.insert(fiber); }

  // Batch execution on next frame
  flush() {
    while (this.queue.peek()) {
      const fiber = this.queue.pop();
      this._renderFiber(fiber);
    }
  }
}
```

---

## 6. Speculative Design: Shader Module Linking

### 6.1 Rex Shader Modules

Currently Rex uses `$param` string substitution for shader composition. This limits composability. Adopting use.gpu's linking pattern:

```rex
@shader vertex-transform
  @export fn getPosition
    var pos = input.position
    pos = (model-matrix) * pos
    pos = (view-matrix) * pos
    return pos

@shader pbr-fragment
  @link fn getPosition(i: i32) -> vec4f
  @link fn getNormal(i: i32) -> vec3f
  @export fn main
    var pos = getPosition(vertex-index)
    var norm = getNormal(vertex-index)
    ;; PBR lighting...
```

### 6.2 Rex Linker

```javascript
class RexShaderLinker {
  constructor() {
    this._modules = new Map();  // name → ParsedModule
    this._cache = new LRU(100); // linked WGSL cache
  }

  // Parse a @shader block into a module
  parseModule(name, wgslCode) {
    const symbols = this._extractSymbols(wgslCode);
    // symbols.exports: @export decorated functions
    // symbols.links: @link decorated functions (slots)
    // symbols.globals: @global decorated variables
    this._modules.set(name, { code: wgslCode, symbols });
  }

  // Link modules together, filling @link slots
  link(mainModule, links) {
    const key = this._cacheKey(mainModule, links);
    if (this._cache.has(key)) return this._cache.get(key);

    const sorted = this._topologicalSort(mainModule, links);
    let wgsl = '';
    const renames = new Map();

    for (const [i, mod] of sorted.entries()) {
      const ns = i === 0 ? '' : `_${String(i).padStart(2,'0')}_`;
      // Rename non-global symbols with namespace prefix
      wgsl += this._rewrite(mod.code, mod.symbols, ns, renames);
    }

    this._cache.set(key, wgsl);
    return wgsl;
  }
}
```

### 6.3 Virtual Binding Modules

Generate accessor code for Rex heap bindings:

```javascript
// At compile time: Rex knows struct layouts → byte offsets
// Generate WGSL accessor module that reads from the heap buffer
generateHeapAccessor(structName, fields) {
  // → fn get_[structName]_[fieldName]() -> [type] { return heapBuffer[offset]; }
  // These are virtual modules linked into user shaders
}
```

This bridges Rex's compiled optics with use.gpu's shader linking — the heap becomes a virtual module that shaders link against.

### 6.4 Specialization Constants (Aaltonen Model)

Aaltonen's specialization constant design solves the PSO permutation explosion. Instead of pre-compiling every shader variant, pass a constants struct at pipeline creation and let the compiler eliminate dead branches:

```rex
@shader pbr-uber
  override HAS_NORMAL_MAP: bool = false;
  override HAS_EMISSIVE: bool = false;
  override ALPHA_MODE: u32 = 0;  ;; 0=opaque 1=mask 2=blend
  override SHADOW_QUALITY: u32 = 1;

  @fragment fn fs_main(in: VSOut) -> @location(0) vec4f
    var albedo = textureSample(textures[mat.albedo_idx], sampler, in.uv)
    if ALPHA_MODE == 1u && albedo.a < mat.alpha_cutoff
      discard
    var N = in.normal
    if HAS_NORMAL_MAP
      N = perturbNormal(in, mat.normal_idx)
    ;; compiler eliminates dead branches at pipeline creation
```

**Rex integration**: The `@pipeline` node already supports specialization overrides. The linker should:
1. Scan the tree for all materials/pipelines that reference an uber-shader
2. Collect the unique combinations of override values actually used
3. Create one pipeline per unique combination (not per material)
4. Map materials → pipeline variants at compile time

This combines with use.gpu's module linking: the uber-shader can `@link` in material-specific functions, and specialization constants select between code paths within those linked modules. The two systems are orthogonal and composable.

**WebGPU support**: WGSL already has `override` declarations. `device.createComputePipeline({ constants: { HAS_NORMAL_MAP: 1 } })` triggers dead code elimination. Rex can use this TODAY — no future API changes needed.

---

## 7. Speculative Design: Two-Phase Layout Engine

### 7.1 Current State

Rex's `_collectPanel` was enhanced with flex-grow/shrink/wrap/align-self/z-index/breakpoints/percentages/margin. But it's still single-pass — it doesn't separate measurement from allocation.

### 7.2 Proposed: Cursor-Based Layout

Adopt use.gpu's cursor pattern for flex line breaking:

```javascript
class FlexCursor {
  constructor(mainSpace, align, wrap) {
    this.mainSpace = mainSpace;
    this.align = align;
    this.wrap = wrap;
    this.items = [];       // current line items
    this.lines = [];       // completed lines
    this.mainUsed = 0;
  }

  push(basis, margin, gap, grow, shrink) {
    const mainNeeded = basis + margin[0] + margin[2] + (this.items.length ? gap : 0);
    if (this.wrap && this.mainUsed + mainNeeded > this.mainSpace && this.items.length > 0) {
      this._flushLine();
    }
    this.items.push({ basis, margin, grow, shrink });
    this.mainUsed += mainNeeded;
  }

  gather(callback) {
    this._flushLine();
    for (const line of this.lines) {
      const slack = this.mainSpace - line.mainUsed;
      if (slack > 0) this._distributeGrow(line, slack);
      if (slack < 0) this._distributeShrink(line, -slack);
      callback(line.items, line.mainUsed, slack);
    }
  }
}
```

### 7.3 Proposed: Inline Text Layout

Adopt use.gpu's inline cursor for text line breaking:

```javascript
class InlineCursor {
  constructor(maxWidth, align, snap) {
    this.maxWidth = maxWidth;
    this.spans = [];
    this.lines = [];
    this.currentWidth = 0;
  }

  pushSpan(advance, trim, hardBreak) {
    if (this.currentWidth + advance - trim > this.maxWidth && this.spans.length > 0) {
      this._flushLine();
    }
    this.spans.push({ advance, trim, hardBreak });
    this.currentWidth += advance;
    if (hardBreak) this._flushLine();
  }

  // Knuth-Plass balanced variant for optimal paragraph breaks
  // (minimize sum of squared slack across all lines)
  pushSpanBalanced(advance, trim, hardBreak) { ... }
}
```

### 7.4 Two-Phase Integration

```javascript
// Phase 1: measure intrinsic sizes (bottom-up)
_measureElement(node, parentWidth, parentHeight) {
  const type = node.type;
  if (type === 'panel') {
    const childSizes = node.children.map(c => this._measureElement(c, ...));
    return this._getFlexMinMax(childSizes, node.attrs);
  }
  if (type === 'text') {
    const spans = this._measureTextSpans(node.text, node.attrs);
    return this._getInlineMinMax(spans, node.attrs);
  }
  // ... rect, path, etc.
}

// Phase 2: allocate space (top-down)
_fitElement(node, fitInto) {
  if (type === 'panel') {
    return this._fitFlex(node, fitInto); // uses FlexCursor
  }
  if (type === 'text') {
    return this._fitInline(node, fitInto); // uses InlineCursor
  }
}
```

---

## 8. Speculative Design: ESDT Text System

### 8.1 Current State

Rex uses Canvas 2D rasterization → simple distance transform → atlas. No subpixel accuracy, no font metrics, no line breaking.

### 8.2 Proposed: ESDT Pipeline

```
@text "Hello, World"
  :font-size 16
  :font-family "Inter"
  :line-height 1.5
  :align left
  :color "#ffffff"
```

Compilation pipeline:
1. **Font loading**: Load font file (WOFF2/TTF) → parse metrics (ascent, descent, xHeight, emUnit)
2. **Glyph rasterization**: Canvas 2D at SDF_GLYPH_SIZE (48px default) → extract alpha channel
3. **ESDT transform**: `paintSubpixelOffsets()` → `esdt1d()` × 2 → resolve distances → alpha map
4. **Atlas packing**: Pack glyphs into atlas texture with UV coordinates
5. **Span measurement**: For each character, compute advance width + kerning
6. **Line breaking**: Feed spans into InlineCursor → get line positions
7. **Glyph placement**: Per glyph: quad position = baseline + glyph bounds × scale → UV from atlas
8. **GPU rendering**: Instanced quads → fragment shader samples SDF atlas → smoothstep for AA

### 8.3 ESDT Core Algorithm (from use.gpu)

```javascript
function glyphToESDT(alpha, w, h, pad, radius, cutoff) {
  const wp = w + 2*pad, hp = h + 2*pad;
  const stage = new Float32Array(wp * hp * 4); // xo, yo, xi, yi per pixel

  // Paint alpha into stage + compute subpixel offsets
  paintSubpixelOffsets(stage, alpha, w, h, pad);

  // 1D distance transform in X then Y (outer edge)
  esdt(outer, xo, yo, wp, hp);
  // 1D distance transform in X then Y (inner edge)
  esdt(inner, xi, yi, wp, hp);

  // Resolve to alpha
  const result = new Uint8Array(wp * hp);
  for (let i = 0; i < wp * hp; i++) {
    const dOuter = Math.sqrt(xo[i]**2 + yo[i]**2) - 0.5;
    const dInner = Math.sqrt(xi[i]**2 + yi[i]**2) - 0.5;
    const d = dOuter >= dInner ? dOuter : -dInner;
    result[i] = Math.max(0, Math.min(255, 255 - 255 * (d/radius + cutoff)));
  }
  return result;
}
```

The key insight from use.gpu: storing displacement vectors (not just scalar distances) enables subpixel accuracy at the edge contour.

---

## 9. Speculative Design: Trait Composition

### 9.1 Rex Traits

Rex already parses attributes ad-hoc. Formalizing this into a trait system:

```javascript
// Define trait: parser functions per attribute key
const panelTrait = rexTrait({
  layout:    (v) => v || 'column',
  gap:       (v) => typeof v === 'number' ? v : 0,
  padding:   (v) => typeof v === 'number' ? [v,v,v,v] : parsePadding(v),
  align:     (v) => v || 'start',
  justify:   (v) => v || 'start',
  'flex-grow':   (v) => typeof v === 'number' ? v : 0,
  'flex-shrink': (v) => typeof v === 'number' ? v : 1,
  'flex-wrap':   (v) => v === true || v === 'wrap',
  'overflow':    (v) => v || 'visible',
  'z-index':     (v) => typeof v === 'number' ? v : 0,
});

const styleTrait = rexTrait({
  fill:      (v) => parseColor(v),
  stroke:    (v) => parseColor(v),
  'stroke-width': (v) => typeof v === 'number' ? v : 1,
  opacity:   (v) => typeof v === 'number' ? v : 1,
  'border-radius': (v) => typeof v === 'number' ? v : 0,
});

// Composition: combine orthogonal traits
const rectTrait = rexCombine(panelTrait, styleTrait);

// Usage: parse node attributes once
const parsed = rexParseTrait(node.attrs, rectTrait);
// → { layout:'column', gap:8, fill:[1,0,0,1], ... }
```

### 9.2 Trait + Breakpoint Integration

Traits can incorporate breakpoint-aware parsing:

```javascript
const responsiveTrait = rexTrait({
  layout: (v, ctx) => {
    if (typeof v === 'string') return v;
    // Array of [minWidth, value] breakpoints
    if (Array.isArray(v)) return resolveBreakpoint(v, ctx.containerWidth);
    return 'column';
  },
});
```

---

## 10. Cold-Start Templating Architecture

### 10.1 The Problem

Rex compiles from source on every page load. For complex UIs (like a Bloomberg Terminal), this means:
1. Parse thousands of lines of Rex notation
2. Compile hundreds of GPU resources
3. Run layout on deep element trees
4. Rasterize SDF glyphs

### 10.2 Template Compilation (Ahead-of-Time)

Adopt a two-tier compilation model:

```
AUTHORING TIME                      RUNTIME
─────────────                       ────────
Rex Source                          Template Cache
  → Parse (Shrub tree)                → Deserialize pre-compiled fibers
  → Compile Fibers                    → Patch dynamic bindings
  → Serialize to Template Cache       → Upload to GPU
  → Ship as .rexc binary              → Execute commands
```

### 10.3 Template Format

```javascript
// .rexc binary format
{
  version: 1,
  // Pre-compiled heap layout (struct offsets, total size)
  heapLayout: { structs: [...], totalBytes: 16384 },
  // Pre-compiled command list
  commands: [
    { type: 'create-buffer', id: 0, size: 16384, usage: 'uniform|copy-dst' },
    { type: 'create-pipeline', id: 0, vertex: '...', fragment: '...', layout: [...] },
    // ...
  ],
  // Pre-compiled optic table
  optics: [
    { path: 'camera/fov', offset: 128, type: 'f32' },
    // ...
  ],
  // Pre-linked WGSL (no runtime linking needed)
  shaders: {
    'vertex-main': '... linked WGSL ...',
    'fragment-main': '... linked WGSL ...',
  },
  // Pre-computed layout tree (positions, sizes)
  layout: {
    elements: [
      { x: 0, y: 0, w: 1920, h: 1080, type: 'panel' },
      // ...
    ],
  },
  // Pre-rasterized SDF atlas (PNG or raw bytes)
  atlas: { width: 512, height: 512, data: Uint8Array },
  // Dynamic slots that need runtime binding
  dynamicSlots: [
    { name: 'camera/fov', offset: 128, type: 'f32', source: 'form' },
    { name: 'time', offset: 0, type: 'f32', source: 'builtin' },
  ],
}
```

### 10.4 Incremental Template Invalidation

When Rex source changes, only invalidate affected template sections:
- Shader change → re-link only that shader module + its dependents
- Layout change → re-run layout from changed subtree upward
- Struct change → re-compute heap layout + all optics
- Form change → no template change (dynamic slot)

### 10.5 Template Sharing

Templates can be shared across instances:
- Same `.rexc` file → same GPU resources, different heap data
- Enables instancing of entire Rex trees (e.g., 100 identical UI panels with different data)

---

## 11. Transducer Extensibility Architecture

### 11.1 Current Extension Model

Rex already has per-transducer handler Maps:
- GPU: `registerCompileType`, `registerCommandType`, `registerResourceType`
- Surface: `registerElementType(name, {collect, measure})`
- Behaviour: `registerSchemaType`, `registerMutationType`
- Form: `registerNodeType`, `registerFieldType`

### 11.2 Proposed: Transducer Protocol

Formalize the transducer interface so new transducers can be added without modifying core:

```javascript
// Transducer interface
class RexTransducer {
  // Declare which node types this transducer claims
  claims() { return ['@rect', '@text', '@panel', '@path', '@shadow']; }

  // Compile a claimed node into fiber commands
  compileFiber(fiber, node) { /* ... */ }

  // Execute compiled commands on GPU
  execute(commands, device, heap) { /* ... */ }

  // Register extension type handler
  register(typeName, handler) { /* ... */ }

  // Declare which contexts this transducer provides/consumes
  contexts() {
    return {
      provides: [ClipContext, TransformContext],
      consumes: [DeviceContext, HeapContext],
    };
  }
}
```

### 11.3 Transducer Composition

Transducers can compose — a parent transducer delegates to child transducers:

```javascript
// Audio transducer: claims @audio, @oscillator, @filter, @mixer
class RexAudio extends RexTransducer {
  claims() { return ['@audio', '@oscillator', '@filter', '@mixer', '@reverb']; }

  compileFiber(fiber, node) {
    if (node.type === '@oscillator') {
      const freq = rexUseMemo(() => this._parseFrequency(node), [node.attrs]);
      rexYeet({ type: 'oscillator', frequency: freq });
    }
    if (node.type === '@mixer') {
      const sources = rexGather(node.children, (child) => {
        return this.compileFiber(child.fiber, child);
      });
      rexYeet({ type: 'mixer', sources });
    }
  }
}

// Physics transducer: claims @body, @joint, @force, @collider
class RexPhysics extends RexTransducer {
  claims() { return ['@body', '@joint', '@force', '@collider']; }
  // ...
}
```

### 11.4 Transducer Discovery

Rex source can declare which transducers it needs:

```rex
@require audio physics network
@require surface:advanced  ;; load enhanced surface with ESDT text

@surface
  @panel layout row
    @audio
      @oscillator :freq 440 :type sine
      @filter :type lowpass :cutoff 1000
```

The `@require` directive loads transducer modules. This is how **Rex notations become engines**: the notation declares its runtime requirements, and the transducer system assembles the execution engine.

---

## 12. Rex Notations as Engines

### 12.1 The Vision

> "Rex notations themselves could be engines, that's the beauty of this system"

A Rex file is not just a UI description. It is a **program specification** that declares:
1. What computational resources it needs (GPU, audio, physics, network)
2. What data structures it operates on (structs, buffers, textures)
3. What reactive relationships exist between data (behaviours)
4. What visual output it produces (surface, form)
5. What shaders it runs (GPU compute/render)

The Rex file IS the engine definition. Different Rex files compile to different engines.

### 12.2 Engine Archetypes

```
┌─────────────────────────────────────────────────────────────┐
│ Bloomberg Terminal                                            │
│ @require surface:advanced behaviour form network             │
│ Engine: 2D layout + reactive state + live data feeds         │
├─────────────────────────────────────────────────────────────┤
│ 3D Game                                                      │
│ @require gpu:full surface physics audio input                │
│ Engine: WebGPU render pipeline + physics sim + spatial audio │
├─────────────────────────────────────────────────────────────┤
│ Data Visualization                                           │
│ @require surface plot data-source                            │
│ Engine: 2D layout + scale/axis/shape layers + data streaming │
├─────────────────────────────────────────────────────────────┤
│ Music Production                                             │
│ @require audio surface behaviour                             │
│ Engine: Web Audio graph + reactive controls + 2D UI          │
├─────────────────────────────────────────────────────────────┤
│ Map Application                                              │
│ @require surface map tile-source                             │
│ Engine: QuadTree LOD + Mercator projection + vector tiles    │
├─────────────────────────────────────────────────────────────┤
│ Document Editor                                              │
│ @require surface:text-heavy behaviour form                   │
│ Engine: ESDT text + inline layout + rich text editing        │
├─────────────────────────────────────────────────────────────┤
│ Voxel World                                                  │
│ @require gpu:compute surface:hud voxel input                 │
│ Engine: 3D texture ray marching + compute meshing + HUD      │
├─────────────────────────────────────────────────────────────┤
│ Slide Deck                                                   │
│ @require surface present                                     │
│ Engine: Off-screen render + transition shaders + navigation  │
├─────────────────────────────────────────────────────────────┤
│ Neural Network Visualization                                 │
│ @require gpu:compute surface plot behaviour                  │
│ Engine: Compute shader inference + activation viz + controls │
└─────────────────────────────────────────────────────────────┘
```

### 12.3 Engine Compilation

When a Rex file is loaded:
1. Parse `@require` directives → list of transducers needed
2. Load transducer modules (lazy, cacheable)
3. Each transducer registers its claimed types
4. Parse the rest of the Rex tree
5. Route each node to the transducer that claims it
6. Compile fibers in dependency order
7. Result: a custom engine tailored to this specific Rex file

### 12.4 Engine Composition (Multi-Rex)

Rex files can compose:

```rex
;; dashboard.rex
@require surface behaviour form

@import "widgets/chart.rex" as chart
@import "widgets/table.rex" as table
@import "widgets/map.rex" as map

@surface
  @panel layout row
    @use chart :data stock-prices
    @use table :data order-book
    @use map :center [40.7 -74.0] :zoom 12
```

Each `@import` loads a sub-engine. The parent Rex file composes them. The fiber system handles cross-engine communication via contexts and channels.

### 12.5 Hot-Swappable Engines

Because fibers are incrementally updatable, transducers can be hot-swapped:
1. User edits `chart.rex`
2. Only the chart fiber subtree recompiles
3. The rest of the dashboard continues executing
4. No full reload needed

This enables live-coding of entire engines, not just shader parameters.

---

## 13. Feature Exhaustability Matrix

### 13.1 What use.gpu Covers (and Rex Can Reach)

| Feature Domain | use.gpu Coverage | Rex Current | Rex + use.gpu Patterns |
|---------------|-----------------|-------------|----------------------|
| **2D Layout** | Flex, Block, Inline, Absolute | Flex (basic) | Full parity + responsive |
| **Text Rendering** | ESDT SDF, paragraph optimization | Basic SDF | ESDT + Knuth-Plass |
| **3D Scene Graph** | Transforms, meshes, instances, batching | Via @shader/@pipeline | Full scene graph transducer |
| **PBR Materials** | Full metallic-roughness, IBL, transmission | Manual shaders | Material transducer |
| **Data Visualization** | Scales, axes, shapes, views, projections | None | Plot transducer |
| **Maps** | QuadTree, MVT, WebMercator | None | Map transducer |
| **Voxels** | MIP ray tracing, .vox loading | None | Voxel transducer |
| **Presentations** | Slides, transitions, off-screen render | None | Present transducer |
| **Shader Composition** | AST linking, tree shaking, virtual modules | $param substitution | Module linking |
| **Input/Interaction** | Mouse, keyboard, gamepad, pointer lock | WASD + mouse + hit test | Extended input transducer |
| **Compute** | Dispatch, pre/post commands, readback | Full | Already strong |
| **Animation** | Frame timing, interpolation | Channel modes | Tween/animation transducer |
| **GPU Readback** | Async mapAsync with fence sync | Basic readback | Enhanced with promises |
| **MSAA** | Multi-sample + resolve | Not implemented | Adoptable |
| **Order-Independent Transparency** | Weighted blended OIT | Not implemented | OIT pass transducer |
| **Post-Processing** | SSAO, outline, bloom, tone mapping | Not implemented | Post-process transducer |
| **Debugging** | Fiber inspector, GPU inspector | Console logging | Inspector transducer |
| **Reactive State** | Hooks (useState, useMemo) | @shrub/@derive/@talk | Already stronger |
| **Self-Healing** | None | ShrubLM + PCN | Unique advantage |
| **Causal Tracking** | None | @talk records | Unique advantage |
| **Declarative Audio** | None | None | Audio transducer |
| **Physics** | None | None | Physics transducer |
| **Network/Streaming** | None | None | Network transducer |

### 13.2 Beyond use.gpu (Rex-Only Features)

These are things Rex can do that use.gpu cannot:

1. **Tree notation authoring**: Rex files are human-readable/writable. use.gpu requires TypeScript/JSX.
2. **Compiled optics**: Zero-cost data access via byte offsets. use.gpu uses per-draw uniform buffers.
3. **Behaviour transducer**: Declarative reactive state with causal tracking. use.gpu has hooks but no built-in state machine.
4. **ShrubLM**: Per-shrub learning modules. No equivalent anywhere.
5. **Self-healing**: Automatic recovery from anomalous states. Unique to Rex.
6. **PLAN bridge**: Orthogonal persistence via Pins. use.gpu has no persistence model.
7. **PCN integration**: Predictive coding network for cognitive architecture. Unique.
8. **Template-to-engine compilation**: Rex files declare their own execution environment.

### 13.3 The Ceiling

With use.gpu patterns adopted, Rex's ceiling becomes:

**Any application that can be described as a tree of declarations — from terminal UIs to AAA games to neural network visualizers to music production tools — can be authored in Rex notation and compiled to a custom GPU-accelerated engine.**

The tree notation is the universal interface. The transducer system is the universal compiler. The fiber runtime is the universal scheduler. The GPU is the universal accelerator.

---

## 14. Implementation Roadmap

### Phase 1: Fiber Runtime (Foundation)
1. Implement `RexFiber` class with hook state storage
2. Implement core hooks: `rexUseState`, `rexUseMemo`, `rexUseResource`
3. Implement priority queue scheduler
4. Implement `rexYeet` / `rexGather` combinators
5. Migrate surface transducer to fiber-based compilation
6. Benchmark: incremental re-compilation vs full recompile

### Phase 2: Layout Engine (use.gpu patterns)
1. Implement FlexCursor (line-breaking with grow/shrink)
2. Implement InlineCursor (text line-breaking, greedy + balanced)
3. Separate measure phase (minMax) from fit phase
4. Implement Block layout with collapsing margins
5. Implement Absolute positioning as layout escape hatch
6. Benchmark: complex nested layouts

### Phase 3: ESDT Text (production text)
1. Port `paintSubpixelOffsets()` from use.gpu
2. Port `esdt1d()` (Felzenszwalb & Huttenlocher 1D transform)
3. Implement glyph atlas with UV packing
4. Implement font metrics loading (ascent, descent, xHeight)
5. Wire inline layout cursor → glyph placement
6. Benchmark: text-heavy UIs (Bloomberg Terminal)

### Phase 4: Shader Module Linking
1. Implement WGSL symbol extraction (@export, @link, @optional, @infer)
2. Implement topological sort + namespace isolation
3. Implement tree shaking (dependency graph → dead code removal)
4. Implement virtual module generation for heap accessors
5. Migrate existing shaders to module system
6. Benchmark: complex multi-module shader compositions

### Phase 5: Domain Transducers
1. Scene transducer (3D transforms, meshes, instances)
2. Plot transducer (scales, axes, shapes, views)
3. Material transducer (PBR, IBL, transmission)
4. Post-process transducer (SSAO, bloom, tone mapping, OIT)
5. Map transducer (QuadTree, MVT, Mercator)
6. Present transducer (slides, transitions)

### Phase 6: Cold-Start Templates
1. Define `.rexc` binary format
2. Implement template serialization (heap layout + commands + shaders + atlas)
3. Implement template deserialization (fast path, skip parse+compile)
4. Implement incremental invalidation (only recompile changed sections)
5. Benchmark: cold start time with templates vs raw compilation

### Phase 7: Engine Composition
1. Implement `@require` directive for transducer loading
2. Implement `@import` for sub-engine composition
3. Implement cross-engine context/channel bridging
4. Implement hot-swap of engine subtrees
5. Build example: multi-Rex dashboard composing chart + table + map engines

---

## Appendix A: use.gpu Source Reference

All paths relative to `/Volumes/C/Downloads/Research/use.gpu-master/packages/`

### Core/Runtime
| File | Lines | Content |
|------|-------|---------|
| `live/src/fiber.ts` | 1505 | Fiber lifecycle, reconciliation, mounting |
| `live/src/hooks.ts` | 753 | Hook implementations (all 9 types) |
| `live/src/builtin.ts` | 346 | Combinators (gather, yeet, fence, quote, etc.) |
| `live/src/types.ts` | 250 | Type definitions (LiveFiber, DeferredCall, HostInterface) |
| `live/src/tree.ts` | 196 | Host creation, render entry points |
| `live/src/queue.ts` | 162 | Priority queue (depth-first tree order) |
| `live/src/util.ts` | 226 | Scheduler, dependency tracker, stack slicer |
| `traits/src/useTrait.ts` | 115 | Trait definition, combination, parsing |

### Shader/WGSL
| File | Lines | Content |
|------|-------|---------|
| `shader/src/util/link.ts` | 521 | Main linker engine |
| `shader/src/util/bind.ts` | 293 | Dynamic binding resolution |
| `shader/src/util/bundle.ts` | 311 | Bundle utilities |
| `shader/src/wgsl/ast.ts` | 624 | AST parsing + tree shaking |
| `shader/src/wgsl/gen.ts` | 450+ | Binding accessor code generation |

### Layout/Text
| File | Lines | Content |
|------|-------|---------|
| `layout/src/lib/flex.ts` | 252 | Flex layout algorithm |
| `layout/src/lib/block.ts` | 269 | Block layout algorithm |
| `layout/src/lib/inline.ts` | 254 | Inline text layout |
| `layout/src/lib/cursor.ts` | 549 | Flex + inline cursors (line breaking) |
| `glyph/src/sdf-esdt.ts` | 670 | ESDT algorithm (subpixel SDF) |
| `layout/src/shape/glyphs.ts` | 172 | Glyph atlas rendering |

### Rendering
| File | Lines | Content |
|------|-------|---------|
| `workbench/src/queue/draw-call.ts` | ~400 | Draw command generation |
| `workbench/src/render/forward-renderer.ts` | ~300 | Forward rendering pipeline |
| `workbench/src/render/render-target.ts` | ~250 | Off-screen rendering, history buffers |
| `workbench/src/pass/color-pass.ts` | ~200 | Main render pass execution |
| `workbench/src/pass/compute-pass.ts` | ~150 | Compute pass execution |

### Domain
| File | Lines | Content |
|------|-------|---------|
| `scene/src/node.ts` | ~100 | Scene graph transform node |
| `scene/src/instances.ts` | ~200 | GPU instancing |
| `plot/src/source/scale.ts` | ~200 | Scale generation (linear/log) |
| `map/src/mvtiles.ts` | ~500 | Vector tile orchestration |
| `map/src/quadtree.ts` | ~300 | LOD tree + async loading |
| `voxel/src/vox-layer.ts` | ~300 | Ray tracing shader |

---

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| **Fiber** | Unit of incremental computation. Wraps a function + hook state + child fibers. |
| **Yeet** | Emit a value upstream to the nearest gather combinator. |
| **Gather** | Collect all yeeted values from children into an array. |
| **Fence** | Gate that passes through an existing gather function. |
| **Quote** | Deferred rendering into a separate reconciled tree. |
| **Reconciler** | Manages a separate render tree (e.g., GPU commands, DOM events). |
| **Trait** | Composable parser function that transforms input props → parsed output. |
| **ESDT** | Extended Squared Distance Transform — subpixel SDF via displacement vectors. |
| **Virtual Module** | Runtime-generated WGSL code (e.g., heap accessors, type casts). |
| **FitInto** | Constraint tuple `[availW, availH, maxW, maxH]` for layout phase 2. |
| **Optic** | Compiled byte offset for zero-cost field access into the GPU heap. |
| **Transducer** | Pluggable compiler that claims node types and produces GPU commands. |
| **ShrubLM** | Per-shrub reference frame learning module (Thousand Brains architecture). |

---

## Appendix C: Key Intellectual Lineages

| Source | Contribution to This Design |
|--------|---------------------------|
| Sebastian Aaltonen | "No Graphics API" (Dec 2025) — GPU = memory + pointers + stage masks. Single root struct pointer replaces all descriptor binding. 32-bit texture heap indices replace descriptor sets. Stage-mask-only barriers replace resource lists. Specialization constants replace PSO permutation explosion. Rex's compiled optics + zero-copy heap are the direct realization of this thesis over WebGPU. [sebastianaaltonen.com/blog/no-graphics-api](https://www.sebastianaaltonen.com/blog/no-graphics-api) |
| use.gpu (Steven Wittens) | Fiber-based GPU programming, ESDT text, shader module linking, two-phase layout, trait composition, gather/yeet combinators, reconciler pattern. 24-package reference architecture for reactive GPU rendering. |
| React (Meta) | Fiber scheduling, hooks, reconciliation. use.gpu adapts React's fiber model for GPU workloads; Rex adopts the pattern without the React dependency. |
| CSS Flexbox (W3C) | Constraint-based layout with grow/shrink/wrap. use.gpu's FlexCursor implements the full algorithm; Rex's `_collectPanel` already has partial parity. |
| Knuth-Plass (1981) | Optimal paragraph line breaking (minimum squared slack). use.gpu's `makeInlineBalancedCursor` implements this via dynamic programming. |
| Felzenszwalb-Huttenlocher | 1D distance transform (O(n) per scanline). Core of use.gpu's ESDT algorithm for subpixel SDF text. |
| Profunctor Optics (Clarke 2020) | Composable bidirectional data access compiled to offsets. Rex's tree paths → byte offsets = compiled profunctor lenses. |
| Thousand Brains (Hawkins) | Per-unit reference frame learning for ShrubLM. Slot-space as N-dimensional reference frame, talks as displacement vectors. |
| PLAN (xocore-tech) | Orthogonal persistence via Pins/Laws/Apps/Nats. Target runtime for Rex's persistence layer. |
| corsix.org | "Thoughts on No Graphics API" — technical analysis identifying necessary additions (multi-device, multi-process, memory pinning, instruction cache fences) and concerns (write-combining on non-x86, deadlock avoidance). [corsix.org/content/thoughts-on-no-graphics-api](https://www.corsix.org/content/thoughts-on-no-graphics-api) |

---

*This spec is a living document. As implementation proceeds, each section should be updated with concrete API decisions, benchmarks, and lessons learned.*
