# GPU Compiler Optimizations — Specification

**Version 1.1 — February 2026**

> *"The GPU is memory + pointers + stage masks."*
> *We go further: the tree describes the memory. The compiler erases the distance.*
> *— RPE Compiler Thesis*

---

## Table of Contents

1. [Tree-Structured Memory (TSM)](#1-tree-structured-memory-tsm)
2. [Shader Fusion](#2-shader-fusion)
3. [Barrier Enforcement](#3-barrier-enforcement)
4. [Optic-Driven Readback](#4-optic-driven-readback)
5. [Hot Shader Patching](#5-hot-shader-patching)
6. [Heap Compaction via Liveness Analysis](#6-heap-compaction-via-liveness-analysis)
7. [Incremental Recompilation](#7-incremental-recompilation)
8. [Implementation Priority](#8-implementation-priority)

---

## 1. Tree-Structured Memory (TSM)

### 1.1 Thesis

Aaltonen says the GPU is memory + pointers. We observe: the Rex tree already specifies memory layout. Every `@struct` declares a typed region. Every `@field` declares an offset. Every `@buffer` declares a heap allocation. The current system compiles tree → struct → heap layout → byte offsets in three separate passes.

TSM eliminates the intermediate representations. **The tree topology directly specifies memory layout.** Indentation is containment. The compiler infers structs, applies alignment, and allocates heap regions in a single pass — collapsing `@struct` + `@buffer` + `@field` into one `@heap` subtree. The tree *describes* the memory; the compiler *produces* it.

### 1.2 Current State

Today, memory layout requires explicit scaffolding:

```rex
@struct Particle
  @field pos :type f32x3
  @field vel :type f32x3
  @field life :type f32

@buffer particles :struct Particle
  @data
    :pos [0 0 0]
    :vel [0 1 0]
    :life 1.0
```

Three declarations to say one thing: "there is a particle with position, velocity, and lifetime." The struct and buffer are boilerplate. The optic compiler resolves `/particles/pos` → byte offset 0, `/particles/vel` → byte offset 16, `/particles/life` → byte offset 28.

### 1.3 TSM Design

With tree-structured memory, the same program is:

```rex
@heap particles
  pos :type f32x3  [0 0 0]
  vel :type f32x3  [0 1 0]
  life :type f32   1.0
```

One node. Children are fields. Indentation is containment. The compiler walks children, applies WGSL alignment rules per type, emits the struct, allocates the heap region, and compiles optics — all in a single pass. The tree specifies the struct; the compiler handles alignment and padding.

#### 1.3.1 Nested Structures via Indentation

```rex
@heap world
  player
    pos :type f32x3   [0 0 0]
    health :type f32   100.0
    inventory
      slot0 :type u32  0
      slot1 :type u32  0
      slot2 :type u32  0
  camera
    yaw :type f32      0.0
    pitch :type f32    0.0
    fov :type f32      90.0
  time :type f32       0.0
```

This produces the **WGSL struct**:

```wgsl
struct World_Player_Inventory {
  slot0: u32,
  slot1: u32,
  slot2: u32,
}

struct World_Player {
  pos: vec3f,
  health: f32,
  inventory: World_Player_Inventory,
}

struct World_Camera {
  yaw: f32,
  pitch: f32,
  fov: f32,
}

struct World {
  player: World_Player,
  camera: World_Camera,
  time: f32,
}
```

And the **optic table**:

| Path | Type | Heap Offset | WGSL Access |
|------|------|-------------|-------------|
| `/world/player/pos` | f32x3 | 0 | `u.player.pos` |
| `/world/player/health` | f32 | 12 | `u.player.health` |
| `/world/player/inventory/slot0` | u32 | 16 | `u.player.inventory.slot0` |
| `/world/player/inventory/slot1` | u32 | 20 | `u.player.inventory.slot1` |
| `/world/player/inventory/slot2` | u32 | 24 | `u.player.inventory.slot2` |
| `/world/camera/yaw` | f32 | 32 | `u.camera.yaw` |
| `/world/camera/pitch` | f32 | 36 | `u.camera.pitch` |
| `/world/camera/fov` | f32 | 40 | `u.camera.fov` |
| `/world/time` | f32 | 48 | `u.time` |

Optic paths are tree paths. Tree paths compile to memory addresses. The notation specifies the pointer; the compiler resolves alignment.

#### 1.3.2 Alignment Rules

Tree depth does NOT override WGSL alignment. The compiler applies standard rules:

- `f32` / `i32` / `u32` → 4-byte alignment
- `f32x2` → 8-byte alignment
- `f32x3` / `f32x4` → 16-byte alignment
- Nested struct → 16-byte alignment (WGSL requirement)
- Outer struct → padded to 16-byte boundary

Indentation determines **containment** (which struct owns which field). Type determines **alignment** (where the field sits in memory). These are orthogonal — the tree encodes topology, the type system encodes geometry.

#### 1.3.3 Array Fields

```rex
@heap particles :count 1000
  pos :type f32x3   [0 0 0]
  vel :type f32x3   [0 1 0]
  life :type f32    1.0
```

`:count N` promotes the heap node to a storage buffer with N instances of the struct, stride-aligned. Optic `/particles[i]/pos` compiles to `base + i * stride + fieldOffset`. The runtime accessor becomes `_storageView.setFloat32(base + i * stride + 0, value)`.

This bridges the gap between uniform heaps (small, per-frame data) and storage buffers (large, instanced data) — the notation is identical, only `:count` differs.

#### 1.3.4 Inline Values and Implicit Channels

In the TSM model, the value after the type specifies either a default or a per-frame source:

```rex
@heap inputs
  time :type f32  (elapsed)
  dt :type f32    (frame-dt)
  res :type f32x2 (canvas-size)
  mouse :type f32x2 (mouse-pos)
```

**Literal values** (numbers, vectors) are defaults — written once at init.

**Expressions in parentheses** are implicit channels — they desugar to `@channel` bindings that evaluate per-frame and write to the heap. `time :type f32 (elapsed)` is equivalent to:

```rex
@field time :type f32
@channel time :src (elapsed) :mode every-frame
```

This distinction matters: a parenthesized expression is not a "default value" — it is a reactive binding that generates per-frame heap writes. The syntax is sugar, but the semantics are channel semantics.

This replaces the current `@buffer` + `@data` + `@struct` three-node pattern with a single subtree.

#### 1.3.5 Backward Compatibility

`@struct` / `@buffer` / `@field` continue to work. `@heap` is syntactic sugar that collapses three node types into one subtree — `_compileHeap(tree)` runs alongside `_compileStructs` and produces the same `_heapLayout`, `_structs`, `_wgslStructs`, and `_optics` data structures. Existing shaders using `#import StructName` see no difference. The compiler does the same work either way; `@heap` is a user-facing simplification, not an architectural change.

#### 1.3.6 Template Integration

`@heap` nodes are first-class template targets:

```rex
@template particle-system
  @param count 1000
  @param drag  0.98
  @heap $name :count $count
    pos :type f32x3   [0 0 0]
    vel :type f32x3   [0 0 0]
    life :type f32    1.0
    drag :type f32    $drag

@use particle-system :as sparks :count 5000 :drag 0.95
@use particle-system :as rain :count 10000 :drag 0.99
```

Each `@use` expands to a separate heap allocation with its own optics, struct definition, and storage buffer. This is how a voxel engine or physics system becomes a template — the `@heap` subtree defines the entire memory layout, and the template parameterizes it.

---

## 2. Shader Fusion

### 2.1 Problem

A filter chain like:

```rex
@filter grayscale :src photo
@filter brightness :src photo :amount 1.3
@filter contrast :src photo :amount 1.5
```

Currently expands to **3 compute dispatches**, each with its own shader, pipeline, resources, and intermediate texture. But grayscale → brightness → contrast are all pixel-local — they only read `color`, transform it, and write it back. They don't need neighbor access.

### 2.2 Fusion Rule

Two adjacent filters can be **fused** if:

1. Both have `needsNeighbors: false` (no `textureLoad` of adjacent pixels)
2. They operate on the same source chain (`:src` of filter B = `:out` of filter A, or same implicit chain)
3. Neither has an explicit `:out` that other non-filter nodes reference

### 2.3 Fused Shader Generation

The three filters above fuse into a single compute shader:

```wgsl
@group(0) @binding(0) var filter_samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2f(textureDimensions(src));
  let px = gid.xy;
  if (px.x >= u32(dims.x) || px.y >= u32(dims.y)) { return; }
  let uv = (vec2f(px) + 0.5) / dims;
  var color = textureSampleLevel(src, filter_samp, uv, 0.0);

  // ── grayscale ──
  let lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  color = vec4f(vec3f(lum), color.a);

  // ── brightness ──
  color = vec4f(color.rgb * 1.300000, color.a);

  // ── contrast ──
  color = vec4f((color.rgb - 0.5) * 1.500000 + 0.5, color.a);

  textureStore(dst, px, color);
}
```

**One dispatch. One texture read. One texture write. Zero intermediates.**

### 2.4 Fusion Breaks

Fusion breaks at:

- A `needsNeighbors: true` filter (blur, sharpen, edge-detect, bloom) — requires a committed intermediate texture for neighbor reads
- An explicit `:out` that is referenced by non-filter nodes (the intermediate must exist for other consumers)
- A change in texture dimensions or format

The compiler groups consecutive fusible filters into **fusion batches**, generates one shader per batch, and inserts fusion-break dispatches between batches.

### 2.5 Parameter Handling in Fused Shaders

Each filter's parameters get a unique prefix to avoid WGSL name collisions:

```wgsl
// grayscale: no params
// brightness:
const PARAM_brightness_amount: f32 = 1.300000;
// contrast:
const PARAM_contrast_amount: f32 = 1.500000;
```

The pixel body references `PARAM_brightness_amount` instead of `PARAM_amount`. The `_compileFilters` method rewrites parameter names when fusing.

### 2.6 Precedent

The derive-compute system (`_compileDeriveCompute`) already fuses multiple `@derive` expressions into a single compute shader with topological ordering. Filter fusion follows the same pattern: concatenate independent pixel bodies, share the dispatch.

---

## 3. Barrier Enforcement

### 3.1 Current State

The barrier schedule is **compiled but not enforced**. `_compileBarrierSchedule` builds a hazard timeline with RAW/WAW/WAR analysis between adjacent passes, but the execute loop does not insert actual GPU synchronization.

This works today because WebGPU's command encoder enforces sequential ordering within a single submission. But it fails the moment we need:

- Async compute (separate compute queue running concurrently with render)
- Multi-queue submission (e.g., copy queue + compute queue + graphics queue)
- Correct behavior when the browser's WebGPU implementation relaxes ordering guarantees

### 3.2 Enforcement Design

#### 3.2.1 Barrier Insertion in Command List

During `_compileCommandList`, after each pass/dispatch command, check `_barrierSchedule` for matching hazards. If found, insert a barrier command:

```javascript
{ type: 'barrier', before: 'STAGE_COMPUTE', after: 'STAGE_FRAGMENT_SHADER', resources: ['price_buf'] }
```

#### 3.2.2 Execute-Time Barrier

WebGPU does not have explicit barriers (unlike Vulkan). Instead, barriers are implicit via:

1. **Pass boundaries**: Ending a compute pass and beginning a render pass implies a full barrier on storage buffers used by both
2. **Buffer usage validation**: The browser validates that buffers aren't concurrently accessed in incompatible modes

For WebGPU, "barrier enforcement" means:

- **Ensuring correct pass ordering**: dispatches that write must complete before passes that read
- **Splitting command encoders**: if async compute is desired, submit compute commands in a separate encoder, await completion via GPU fence
- **Logging hazards**: emit warnings when the barrier schedule detects a potential race

#### 3.2.3 Optic-Derived Barrier Schedule

The current barrier schedule is built by a separate hazard analysis pass that walks the command list looking for resource conflicts. This duplicates information the optic table already has.

**Key insight:** every entry in the optic table knows its target resource (buffer/texture). During command list compilation, each pass/dispatch already records which resources it binds and in what mode (read/write). By annotating each optic with `{access: 'read'|'write', passIndex: number}`, the barrier schedule becomes a **derived property** of the optic table:

```javascript
// During command list compilation, annotate optics with access info
for (const optic of this._optics.values()) {
  optic.accesses = [];  // [{passIndex, access: 'read'|'write', stage}]
}

// Barrier derivation: walk optic accesses, find conflicts
for (const optic of this._optics.values()) {
  for (let i = 0; i < optic.accesses.length; i++) {
    for (let j = i + 1; j < optic.accesses.length; j++) {
      const a = optic.accesses[i], b = optic.accesses[j];
      if (a.access === 'write' || b.access === 'write') {
        // RAW, WAW, or WAR hazard — barrier required between passes
        barriers.push({ afterPass: a.passIndex, beforePass: b.passIndex, ... });
      }
    }
  }
}
```

This eliminates the separate `_compileBarrierSchedule` pass. Barriers are inferred from optic access patterns — the optic framework covers not just data access but execution ordering.

#### 3.2.4 Hazard-Aware Command Reordering

The compiler could reorder dispatches and passes for optimal GPU utilization:

1. Build a **dependency DAG** from the optic-derived barrier schedule
2. Topologically sort the DAG
3. Identify independent subgraphs that can run concurrently
4. Emit them in parallel-safe order (or on separate queues when multi-queue support arrives)

This is the GPU equivalent of instruction scheduling. Optic access annotations define the data dependencies; the compiler schedules for maximum parallelism.

### 3.3 Data Structures

Extend the optic entry with access tracking:

```javascript
// Optic entry (extended)
{
  path: string,
  offset: number,
  size: number,
  type: string,
  resource: string,             // NEW: buffer/texture name
  accesses: [                   // NEW: per-pass access log
    { passIndex: number, access: 'read' | 'write', stage: string }
  ],
}

// Derived barrier entry
{
  afterPass: string,
  beforePass: string,
  hazardType: 'RAW' | 'WAW' | 'WAR',
  opticPaths: string[],         // optic paths involved (not raw resource names)
  srcStage: 'COMPUTE' | 'FRAGMENT' | 'VERTEX' | 'COPY',
  dstStage: 'COMPUTE' | 'FRAGMENT' | 'VERTEX' | 'COPY',
  enforced: boolean,            // was this barrier enforced at execute time?
}
```

Add `_barrierViolations` counter for diagnostics — incremented when a potential race is detected at runtime (e.g., readback of a buffer that was written in the same encoder without an intervening pass boundary).

### 3.4 Limitations

Optic-derived barriers cover **data-flow dependencies** — the common case. They do NOT cover:

- **Dynamic execution dependencies**: indirect dispatch, conditional rendering, GPU-driven pipelines where the GPU decides what to execute next. These are control flow, not data flow, and require imperative specification.
- **External resource dependencies**: resources managed outside the optic system (e.g., externally-created textures, imported buffers).

For these cases, explicit barrier annotations remain necessary as an escape hatch.

---

## 4. Optic-Driven Readback

### 4.1 Current State

`@readback` works with raw byte ranges:

```rex
@readback cam-pos :from cam_buf :offset 0 :count 3
```

The user must know the byte offset and field count. This bypasses the optic system — the same system that provides typed, named, composable accessors for writes is ignored for reads.

### 4.2 Optic-Driven Design

Readback through optics — the backward direction of the profunctor:

```rex
@readback player-state :path /world/player
```

The compiler resolves `/world/player` to:
- Source buffer: `world` (or the heap buffer containing it)
- Byte offset: `_heapLayout.get('world').offset + structDef.layout.find(f => f.name === 'player').offset`
- Size: `sizeof(World_Player)` (recursively computed from struct layout)
- Type info: full struct layout for deserialization

The readback callback delivers a **typed object**, not a raw `Float32Array`:

```javascript
gpu.onReadback = (name, data) => {
  // data = { pos: [1.2, 3.4, 5.6], health: 87.5, inventory: { slot0: 3, slot1: 0, slot2: 1 } }
};
```

### 4.3 Path Resolution

The optic path `/world/player/pos` resolves through the same optic table used for writes:

| Component | Resolved To |
|-----------|-------------|
| `world` | Buffer name → heap base offset |
| `player` | Struct field → field offset within World |
| `pos` | Struct field → field offset within World_Player |
| **Total** | `heapBase + playerOffset + posOffset` |

For storage buffers with `:count`, the path includes an index: `/particles[42]/pos`.

### 4.4 Readback Modes

```rex
@readback cam :path /world/camera                ;; one-shot: read once on next frame
@readback cam :path /world/camera :every 5       ;; periodic: read every 5 frames
@readback cam :path /world/camera :on-change true ;; delta: read only when value changes (requires previous value comparison)
```

`:every N` reduces readback pressure by skipping frames. `:on-change` compares the staging buffer to previous values and only fires the callback when data differs.

### 4.5 Integration with Behaviour System

Optic readback feeds directly into behaviour slots:

```rex
@readback gpu-health :path /world/player/health :to /player-shrub/gpu-health
```

This creates a closed loop: behaviour → channel → GPU heap → compute shader → readback → behaviour. The profunctor optic is the formal model for this bidirectional path — `set` (channel/write) and `get` (readback) are the two directions of the lens.

---

## 5. Hot Shader Patching

### 5.1 Problem

Changing a filter parameter (`:radius 5` → `:radius 8`) currently triggers full recompilation: re-parse, re-generate all synthetic nodes, recreate all shader modules, rebuild all pipelines. The shader source changes from `const PARAM_radius: f32 = 5.0;` to `const PARAM_radius: f32 = 8.0;` — a single constant, yet the entire pipeline is rebuilt.

### 5.2 WGSL Pipeline Overrides

WebGPU supports **pipeline-overridable constants**:

```wgsl
override PARAM_radius: f32 = 5.0;
override PARAM_intensity: f32 = 1.0;
```

These are declared in the shader with `override` instead of `const`. At pipeline creation time, they can be overridden:

```javascript
device.createComputePipeline({
  compute: { module, entryPoint: 'main',
    constants: { PARAM_radius: 8.0, PARAM_intensity: 1.2 }
  }
});
```

Changing a constant requires recreating the **pipeline** but NOT the **shader module**. Pipeline creation is significantly cheaper than shader compilation.

### 5.3 Design

#### 5.3.1 Filter Parameters as Overrides

In `_compileFilters`, emit `override` instead of `const` for filter parameters:

```wgsl
override PARAM_radius: f32 = 5.0;  // was: const PARAM_radius: f32 = 5.0;
```

Store the parameter-to-override mapping in the pipeline entry:

```javascript
this.pipelines.set(key, {
  pipeline,
  type: 'compute',
  resourceScope: resName,
  overrides: { PARAM_radius: 5.0, PARAM_intensity: 1.0 },  // NEW
});
```

#### 5.3.2 Hot Patch Flow

When a filter parameter changes (e.g., via form slider `:radius (form/blur-radius)`):

1. Detect that only override values changed (no structural tree change)
2. Skip shader module recompilation — the WGSL source is identical
3. Recreate only the affected pipeline(s) with new `constants` values
4. Update the `pipelines` Map entry

This is O(1) pipeline creations instead of O(N) shader compilations.

#### 5.3.3 Uniform Buffer Alternative

For parameters that change every frame (animated values), overrides are still too expensive — pipeline recreation per frame is not viable. Use a **uniform buffer** instead:

```wgsl
struct FilterParams { radius: f32, intensity: f32 }
@group(0) @binding(3) var<uniform> params: FilterParams;
```

Write to the uniform buffer per frame via the heap system. This is the same path as all other per-frame data — zero-cost via dirty range tracking.

#### 5.3.4 Parameter Classification

The compiler classifies each filter parameter:

| Classification | Mechanism | Cost | When |
|---------------|-----------|------|------|
| **Compile-time constant** | `const PARAM_x: f32 = val;` | Zero runtime cost | Value known at parse time, never changes |
| **Pipeline override** | `override PARAM_x: f32 = val;` | Pipeline recreation | Value changes infrequently (user edits Rex) |
| **Per-frame uniform** | `params.x` in uniform buffer | Heap write per frame | Value is a Rex expression (e.g., `(form/slider)`) |

The compiler inspects each parameter value:
- Literal number → compile-time constant
- Expression → per-frame uniform
- Form reference that rarely changes → pipeline override (with fallback to uniform)

---

## 6. Heap Compaction via Liveness Analysis

### 6.1 Problem

The heap allocates space for every `@buffer` at 256-byte alignment. If buffer A is only read by pass 1 and buffer B only by pass 3, they could share the same heap region — their live ranges don't overlap.

The aliasing plan (`_compileAliasingPlan`) already does this for textures. Extend it to the uniform heap.

### 6.2 Liveness Analysis

For each optic (heap field), determine its **live range**: which passes read it.

```javascript
liveness = Map<fieldPath, { firstRead: passIndex, lastRead: passIndex }>
```

Walk the command list. For each pass/dispatch, examine its bind groups. For each bound buffer, mark all fields as live in that pass index.

### 6.3 Compaction Algorithm

1. Sort optics by `firstRead`
2. For each optic, try to alias it with a previously-allocated optic whose `lastRead < firstRead` and whose type is compatible (same size/alignment)
3. If aliased, share the heap offset. Otherwise, allocate new space.

This is register allocation for GPU memory. The "registers" are heap slots. The "variables" are optics. The "live ranges" are pass indices.

### 6.4 Dead Optic Elimination

An optic that is **written but never read by any shader** is dead. The heap field it occupies wastes space. Dead optic elimination removes these fields from the heap layout entirely.

Detection: after building the liveness map, any optic with no reads is dead. Remove it from `_optics`, reclaim its heap space.

### 6.5 Constraints

- Aliased optics must have the same alignment (4, 8, or 16 bytes)
- Aliased optics must not be simultaneously live (no overlapping read ranges)
- Channel-driven optics are always live (behaviour can push at any time)
- Form-driven optics are always live (user can change at any time)

---

## 7. Incremental Recompilation

### 7.1 Current State

Every tree change triggers full recompilation (20 phases). If you change one `@filter` parameter, the entire heap is reallocated, all shaders are recompiled, all pipelines are rebuilt.

### 7.2 Structural Diffing

Compare the new Shrub tree against the previous one:

```javascript
function diffShrub(prev, next) {
  const changes = [];
  // Compare type, name, attrs, content, children (recursively)
  // Return list of changed subtrees with their paths
  return changes;
}
```

### 7.3 Selective Recompilation

Map each changed subtree to the compile phases it affects:

| Changed Node Type | Recompile Phases |
|-------------------|-----------------|
| `@struct` / `@field` | structs → shaders → heap → optics → allocate → all downstream |
| `@shader` content | shaders → pipelines |
| `@shader` attrs | shaders → pipelines |
| `@buffer` `:struct` | heap → optics → allocate |
| `@buffer` `@data` values | optics (re-evaluate defaults only) |
| `@texture` attrs | textures → resources |
| `@pipeline` attrs | pipelines only |
| `@pass` / `@dispatch` | command list → barriers |
| `@filter` params | filter expansion → shaders → pipelines (or: hot patch via overrides) |
| `@filter` added/removed | filter expansion → all downstream |
| `@heap` field values | optics (re-evaluate defaults only) |

### 7.4 Optic Stability

The key optimization: if the **heap layout doesn't change** (same structs, same buffers, same field order), then optic offsets are stable. The heap buffer, staging buffers, and bind groups can be reused. Only the changed shader modules and their pipelines need rebuilding.

Detect layout stability by comparing the new `_heapLayout` Map against the previous one. If all offsets match, skip heap reallocation.

---

## 8. Implementation Priority

### Phase 1: Foundation (Immediate Value)

1. **Barrier enforcement** — emit pass-boundary validation, log hazard violations
2. **Optic-driven readback** — path-based readback with typed deserialization
3. **Hot shader patching** — `override` constants for filter parameters

### Phase 2: Optimization (Performance)

4. **Shader fusion** — fuse consecutive `needsNeighbors: false` filters
5. **Heap compaction** — liveness analysis + dead optic elimination
6. **Incremental recompilation** — structural diffing + selective recompile

### Phase 3: Deep Architecture (Notation Simplification)

7. **Tree-Structured Memory** — `@heap` nodes with nested struct inference
8. **Array fields with `:count`** — unified uniform/storage notation
9. **Template integration** — `@heap` as template target for engines/systems

### Dependency Graph

```
Barrier Enforcement ──────────────────────────── standalone
Optic-Driven Readback ───────────────────────── standalone
Hot Shader Patching ──────────────────────────── standalone
Shader Fusion ────────────────────────────────── requires filter system (done)
Heap Compaction ──────────── requires barrier schedule (for liveness)
Incremental Recompilation ── requires optic stability detection
Tree-Structured Memory ───── requires nested struct support
```

---

## Appendix A: Beyond Aaltonen

Sebastian Aaltonen's "No Graphics API" thesis identifies the GPU as memory + pointers + stage masks. RPE extends this in six dimensions:

1. **Compiled optics** — tree paths compiled to typed byte offsets, resolving at compile time what Aaltonen's pointers resolve at runtime. The optic theory (profunctor composition) motivates the design; the runtime artifact is a flat offset table — which is exactly what GPUs want.
2. **Optic-derived barriers** — synchronization requirements inferred from optic access annotations, not manual specification. Optic read/write metadata determines the barrier schedule, extending the optic framework from data access to execution ordering. (Dynamic control flow remains imperative — see §3.4.)
3. **Transducer erasure** — no API calls between notation and hardware
4. **Bidirectional dataflow** — GPU is one node in a reactive graph. Write path: behaviour → channel → heap (optic `set`). Read path: GPU → readback → behaviour (optic `get`). The profunctor model earns its name here — both directions resolve through the same optic table (§4).
5. **Self-modifying programs** — runtime observation → source amendment → recompilation
6. **Tree-described memory** — `@heap` notation directly specifies memory layout. The compiler infers structs, applies WGSL alignment, and allocates heap regions. One fewer intermediate representation, not zero — alignment padding and struct generation are irreducible compilation steps.

The culmination: the tree specifies intent, the compiler erases the distance to hardware. The remaining compilation steps (alignment, struct generation, barrier derivation) are mechanical — determined entirely by the tree and WGSL rules, with no user-facing abstraction layer.

---

## Appendix B: WGSL Alignment Reference

| Type | Size | Alignment | WGSL |
|------|------|-----------|------|
| `f32` | 4 | 4 | `f32` |
| `i32` | 4 | 4 | `i32` |
| `u32` | 4 | 4 | `u32` |
| `f32x2` | 8 | 8 | `vec2f` |
| `f32x3` | 12 | 16 | `vec3f` |
| `f32x4` | 16 | 16 | `vec4f` |
| `f32x4x4` | 64 | 16 | `mat4x4f` |
| Nested struct | varies | 16 | `StructName` |
| Array element | stride-aligned | roundup(elementSize, elementAlign) | `array<T, N>` |
| Outer struct | roundup(size, 16) | 16 | — |
