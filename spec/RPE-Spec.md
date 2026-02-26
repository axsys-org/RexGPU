# Rex Projection Engine — Specification v2

**A tree-to-GPU compiler that projects Rex notation into visual surfaces through compiled optics, a zero-copy heap, and open transduction.**

---

## Architecture

```
COMPILE PHASE (on structure change only):
  tree parsed → struct layouts computed → heap allocated
  → optics compiled (path → byte offset) → command list flattened
  → barrier schedule inferred → aliasing plan computed
  → WGSL generated from @struct → shaders compiled → pipelines created

EXECUTE PHASE (per frame, zero tree traversal):
  builtins write to heap at compiled offsets
  → form/interaction writes to heap at compiled offsets
  → dirty range tracked (byte min/max)
  → double-buffer swap: snapshot staging → GPU
  → iterate compiled command list (flat array, no tree walk)
  → follow static barrier schedule
  → submit
```

The compile phase produces three artifacts. The execute phase consumes only those artifacts:

| Artifact | Contents | Used By |
|---|---|---|
| Optic Table | `path → {heapOffset, type}` | Value writes (form, builtins, interactions) |
| Command List | Flat array of `{type, pipeline, bindGroup, vertices, ...}` | GPU command encoding |
| Barrier Schedule | Array of `{afterPass, before, after, hazards}` | Synchronization |

---

## Part 1: Rex Notation and the Shrub Data Model

Rex is an indentation-scoped tree notation. Shrine provides the parser, path resolution, attribute system, and expression evaluation. RPE does not reimplement any of these.

### Shrubs

The Rex parser produces a tree of **Shrubs**. A Shrub is the universal node type in Shrine. Every Shrub has three concerns:

| Concern | Description | Rex Syntax |
|---|---|---|
| **Fields** | Named, typed, persistent state belonging to the Shrub | `@field name :type f32 :default 0` |
| **Kids** | Ordered list of child Shrubs (recursive) | Nested `@type` nodes |
| **Actions** | Named operations with typed input signatures | `@action name` with `@input` children |

```
@shrub widget
  ;; fields — persistent typed state
  @field title :type text :default "untitled"
  @field count :type u32 :default 0
  @field visible :type bool :default true

  ;; kids — child shrubs (same structure, recursive)
  @shrub child-a
    @field label :type text
    @field value :type f32

  ;; actions — callable operations with typed inputs
  @action increment
    @input amount :type u32 :default 1
    @input clamp_max :type u32

  @action rename
    @input new_title :type text :required true
```

Fields are persistent state on the Shrub. Action inputs are transient — they are the arguments to a call. Kids give composition. This structure is uniform: `@struct`, `@pass`, `@form`, `@pipeline` are all Shrub type names. The parser treats them identically. Transducers pattern-match on type names to give Shrubs domain-specific meaning.

### Syntax

```
@node-type optional-name :attr1 value :attr2 [array values]
  @child-type :inherited-scope true
    :deep-attr value
  ;; comments
```

Shrubs have a type, optional name, fields, kids, actions, and optional content blocks (for shader code). Attributes support numbers, booleans, strings, arrays (`[1 2 3]`), and expressions (`(form/cam_dist)`).

### Path Resolution

Every Shrub is addressable by path. `(form/cam_dist)` resolves through the tree to find the `cam_dist` field under the `form` Shrub. The compile phase resolves these paths to byte offsets. The execute phase never walks the tree.

### Node Types

The Rex parser does not assign semantics to Shrub type names. It produces a tree of Shrubs — `@pass`, `@shader`, `@texture` are all opaque strings to the parser. Transducers (Part 11) give type names meaning. The following types are defined by RPE's current transducers:

| Node | Purpose | Compile Output |
|---|---|---|
| `@struct` | Memory layout definition | Byte layout + WGSL type |
| `@shader` | WGSL source (with `#import`) | Compiled shader module |
| `@buffer` | Named uniform/storage region | Heap region assignment |
| `@pipeline` | Shader + raster state | GPU pipeline object |
| `@pass` | Render pass description | Command list entries |
| `@draw` | Draw call within a pass | Command list entry |
| `@bind` | Buffer → shader binding | Bind group + heap offset |
| `@dispatch` | Compute dispatch | Command list entry |
| `@form` | UI specification | Form transducer input |
| `@field` | Struct member (under `@struct`) or form field (under `@form`) | Byte offset + WGSL field, or optic from field → heap |
| `@interact` | Inverse projection (canvas → form) | Input event handlers |
| `@resource` | Transient GPU resource | Aliasing plan entry |
| `@asset` | Binary resource reference | GPU texture handle or buffer region |
| `@channel` | Reactive dataflow edge | Compiled optic pair + transform |
| `@action` | Shrub operation with typed inputs | Transducer-specific (PLAN law, RPC, DOM handler, compute dispatch) |
| `@input` | Typed parameter of an `@action` | Action input signature |

---

## Part 2: Zero-Copy Heap

All uniform and buffer data resides in a single GPU buffer backed by a single CPU staging ArrayBuffer. Every path in the tree compiles to a byte offset within this heap. A value change at runtime is a single `DataView.setFloat32(offset, value)`.

### Heap Layout

```
heapBuffer       : ONE GPUBuffer (all uniforms, all buffers)
heapArrayBuffer  : ONE ArrayBuffer (CPU staging)
heapView         : DataView over staging
heapLayout       : bufferName → {offset, size, structDef}

Each @buffer occupies a 256-byte-aligned region (WebGPU minUniformBufferOffsetAlignment).
Total heap size = sum of aligned regions.
```

### Compile Phase

```
For each @buffer node:
  1. Look up @struct definition → byte size, field layout
  2. Align to 256 bytes within heap
  3. Record: heapLayout[bufferName] = {offset, size, structDef}

Allocate:
  heapBuffer = device.createBuffer({size: heapSize, usage: UNIFORM | COPY_DST})
  heapArrayBuffer = new ArrayBuffer(heapSize)
  heapView = new DataView(heapArrayBuffer)
```

### Optic Resolution

Every expression in the tree compiles to a concrete write target:

```
optic = {
  heapOffset: bufferRegionOffset + fieldByteOffset,
  type: f32 | f32x2 | f32x3 | f32x4 | u32 | i32,
  source: form | builtin | const,
  key: field name or builtin name,
  constVal: (for constants, written once at compile time)
}
```

| Category | Lookup | Example |
|---|---|---|
| Form optics | `formOptics: Map<fieldName, [{heapOffset, type}]>` | `(form/cam_dist)` → offset 256 |
| Builtin optics | `builtinOptics: [{heapOffset, type, expr}]` | `(elapsed)` → offset 0 |
| Constant optics | Written once at compile time | `:speed 1.5` → offset 4 |

### Execute Phase

```
setFormField(name, value):
  for each target in formOptics.get(name):
    heapView.setFloat32(target.heapOffset, value, littleEndian)
    markDirty(target.heapOffset, 4)

applyBuiltins():
  for each op in builtinOptics:
    val = evalBuiltin(op.expr)
    heapView.setFloat32(op.heapOffset, val, littleEndian)
    markDirty(op.heapOffset, 4)
```

---

## Part 3: Dirty Range Tracking

A boolean dirty flag uploads the entire heap when only a few bytes changed. Byte-range tracking uploads only the changed slice.

```
dirtyMin = Infinity
dirtyMax = -Infinity

markDirty(offset, size):
  dirtyMin = min(dirtyMin, offset)
  dirtyMax = max(dirtyMax, offset + size)

Frame submit:
  if dirtyMin < dirtyMax:
    device.queue.writeBuffer(heapBuffer, dirtyMin, heapArrayBuffer, dirtyMin, dirtyMax - dirtyMin)
  dirtyMin = Infinity
  dirtyMax = -Infinity
```

Typical frame: time field changes → 4 bytes uploaded instead of the full heap.

---

## Part 4: Double-Buffered Staging

Without double buffering, a pointer event firing between `applyBuiltins()` and `writeBuffer()` produces an inconsistent snapshot (some fields updated, others stale).

```
stagingBuffers: [ArrayBuffer, ArrayBuffer]
stagingViews:   [DataView, DataView]
writeSlot:      0 | 1
heapView:       alias to current write slot's DataView
```

Per-frame protocol:
1. All writes target the current slot via `heapView`.
2. `writeBuffer` snapshots the current slot to GPU. This is atomic: JavaScript is single-threaded, `writeBuffer` is synchronous on the CPU side. No input event can fire mid-call.
3. Copy dirty region from current slot to the other slot (`Uint8Array.set`, typically 4–20 bytes).
4. Flip `writeSlot`. Reassign `heapView`.

---

## Part 5: Compiled Command List

The compile phase walks the tree once and produces a flat command array. The execute phase iterates this array with zero tree traversal.

```
compileCommandList(tree):
  commands = []
  for each @pass node:
    commands.push({type: pass, clear, load, store, target, targets, depthTarget})
    for each @draw child:
      pass.draws.push({pipeline, vertices, instances, binds,
                        indirect, indirectBuffer, indirectOffset})
  for each @dispatch node:
    commands.push({type: dispatch, pipeline, bindGroups, grid})
  return commands

executeCommandList(commands, encoder, swapchainView):
  for cmd in commands:
    if cmd.type === 'pass':
      resolve color attachments:
        cmd.targets (array) → MRT: multiple texture views
        cmd.target (string) → single texture view
        default             → swapchain view
      resolve depth attachment:
        cmd.depthTarget     → depth texture view
      for each draw:
        if draw.indirect:
          pass.drawIndirect(indirectBuffer, offset)
        else:
          pass.draw(vertices, instances)
    if cmd.type === 'dispatch':
      computePass.dispatch(grid)
```

### Render-to-Texture

Passes can target textures instead of the swapchain. The texture must be declared with `:render true` to receive `RENDER_ATTACHMENT` usage.

```
@texture offscreen :width 512 :height 512 :format rgba16float :render true
@texture depth-buf :width 512 :height 512 :format depth24plus :render true

@pass scene :target offscreen :depth-target depth-buf :clear [0 0 0 1]
  @draw :pipeline scene-pipe :vertices 3

@pass composite :clear [0 0 0 1]
  @draw :pipeline blit-pipe :vertices 3
    @bind 0 :texture offscreen
```

### Multi-Render-Target (MRT)

Pipelines targeting multiple attachments declare `:targets [name1 name2]`. The fragment shader must output matching `@location` indices.

```
@pipeline gbuffer-pipe :vertex scene :fragment gbuffer :targets [albedo-tex normal-tex]
```

### Indirect Draw

Draw calls can consume GPU-generated arguments. The indirect buffer must have `:usage [storage indirect]`.

```
@buffer draw-args :usage [storage indirect] :size 16

@dispatch cull :pipeline cull-compute :grid [256 1 1]
  @bind 0 :storage draw-args

@pass render :clear [0 0 0 1]
  @draw :pipeline mesh-pipe :indirect true :indirect-buffer draw-args :indirect-offset 0
```

`drawIndirect` expects `{vertexCount, instanceCount, firstVertex, firstInstance}` at 16 bytes. `drawIndexedIndirect` expects `{indexCount, instanceCount, firstIndex, baseVertex, firstInstance}` at 20 bytes.

---

## Part 6: WGSL Generation

The `@struct` node defines the memory layout. The compile phase generates WGSL from it. Shaders reference generated structs via `#import`.

```
@struct SceneUniforms
  @field time       :type f32
  @field cam_dist   :type f32
  @field cam_angle  :type f32
  @field cam_height :type f32
  @field resolution :type f32x2
  @field light_pos  :type f32x3

@shader scene_shader
  #import SceneUniforms
  @group(0) @binding(0) var<uniform> u: SceneUniforms;
```

Compile steps:
1. Parse `@struct` → compute byte layout with WGSL alignment rules.
2. Generate WGSL struct declaration.
3. When compiling shaders, replace `#import StructName` with generated WGSL.
4. The same struct layout drives heap offset computation.

One definition drives three consumers: heap layout, WGSL type, optic offsets.

---

## Part 7: Shader and Pipeline Fallback

On shader compilation error, the previous shader module is retained. Rendering continues with the last-good shader.

On pipeline creation error, the previous pipeline is retained. The new pipeline is not stored.

This enables live editing. Malformed edits produce error logs, not rendering failure.

---

## Part 8: Barrier Scheduling

The tree's `@pass` and `@bind` nodes form a static render graph. The compile phase infers barriers from this graph.

### Access Timeline

Walk `@pass` nodes with `@bind` children. For each binding, record `{pass_index, resource_name, access_type, usage}`.

### Hazard Detection

For each resource, identify transitions between consecutive passes:

| Transition | Hazard | Action |
|---|---|---|
| write → read | RAW | Barrier required |
| write → write | WAW | Barrier required |
| read → write | WAR | Barrier required |
| read → read | None | Skip |

### Barrier Emission

Barriers use producer/consumer stage masks with optional hazard flags. No resource lists.

```
compileBarrierSchedule(passes):
  barriers = []
  for each consecutive pass pair (A, B):
    for each resource used in both:
      if hazard detected:
        barriers.push({
          afterPass: A.index,
          before: stageOf(A.usage),
          after: stageOf(B.usage),
          hazards: specialFlags
        })
  merge compatible barriers between same pass pairs
  return barriers
```

Hazard flags: `HAZARD_DESCRIPTORS`, `HAZARD_DRAW_ARGUMENTS`, `HAZARD_DEPTH_STENCIL`.

The barrier schedule is computed once at compile time and reused across frames until tree structure changes.

---

## Part 9: Resource Aliasing

Resources marked `:transient` live only within a frame. Resources with non-overlapping lifetimes share the same GPU memory allocation.

```
@resource depth-buf
  :format depth32float
  :size (viewport)
  :transient

@resource hdr-out
  :format rgba16float
  :size (viewport)
  :transient
```

### Lifetime Analysis

The barrier schedule (Part 8) yields `{first_use_pass, last_use_pass}` for each transient resource. Two resources are **compatible** for aliasing when:

1. **Disjoint lifetimes.** `A.last_use_pass < B.first_use_pass` (or vice versa).
2. **Format compatibility.** Same format group (e.g. all `rgba8unorm` textures, all `depth32float` buffers). Incompatible formats require separate pools.
3. **Size class match.** Resource fits within the allocation's size class without excessive waste.

### Size-Class Pools

Rather than per-resource allocations, the allocator maintains pools bucketed by size class and format group.

```
Size classes (textures):
  viewport-relative: 1x, 1/2x, 1/4x, 1/8x (most common for render targets)
  fixed: powers of 2 from 256×256 to 4096×4096

Size classes (buffers):
  small: ≤4KB, medium: ≤64KB, large: ≤1MB, oversize: individual allocation

Format groups:
  color8:    rgba8unorm, bgra8unorm
  color16:   rgba16float
  color32:   rgba32float
  depth:     depth32float, depth24plus-stencil8
```

Each pool entry is a reusable GPU resource (texture or buffer) that outlives any single frame. The aliasing plan assigns transient resources to pool entries, not raw memory.

### Allocation Algorithm

```
compileAliasingPlan(resources, barrierSchedule):
  pools = Map<(sizeClass, formatGroup), [PoolEntry]>

  Sort resources by first_use_pass (ties broken by size descending)

  For each resource R:
    key = (sizeClassOf(R), formatGroupOf(R))
    candidates = pools[key].filter(entry =>
      entry.lastOccupant.last_use_pass < R.first_use_pass)

    if candidates.length > 0:
      entry = candidates[0]             // reuse existing
      entry.lastOccupant = R
      assign R → entry
    else:
      entry = new PoolEntry(key)
      pools[key].push(entry)
      entry.lastOccupant = R
      assign R → entry

  return aliasingPlan: Map<resourceName, PoolEntry>
```

### Pool Lifecycle

Pool entries are **not** created or destroyed per frame. They persist across frames and are only reallocated on tree structure change (e.g. viewport resize triggers new size class). The compile phase produces the aliasing plan; the execute phase indexes into it.

### Memory Budget

Total transient memory = sum of pool entries across all pools. The overflow system (Part 17) monitors this against a configurable budget. Under memory pressure, the allocator can reduce render target resolution (promoting resources to a smaller size class) before falling back to Tier 3.

---

## Part 10: Inverse Projection

The `@interact` node declares how screen-space input maps to tree parameters.

```
@interact
  :drag-x cam_angle
  :drag-x-scale -0.01
  :drag-y cam_height
  :drag-y-scale 0.02
  :drag-y-min 0.5
  :drag-y-max 5
  :scroll cam_dist
  :scroll-scale 0.005
  :scroll-min 2
  :scroll-max 10
```

At runtime, pointer events are dispatched through these mappings generically. Canvas drag → form state → GPU heap, through the same path system used in the forward direction. The compile phase resolves both forward and inverse optics to byte offsets.

---

## Part 11: Transducers

A transducer reads a tree of Shrubs and produces output for a specific domain. The Rex parser produces the tree; transducers interpret it. A Shrub type name like `@pass` or `@physics` has no built-in meaning — it is inert data until a transducer claims it. New domains (audio, physics, networking) require only new transducers, not parser changes.

A transducer is any object with a `transduce(tree, structureChanged)` method.

```
class RexGPU   { transduce(tree, structureChanged) { ... } }
class RexForm  { transduce(tree, structureChanged) { ... } }
```

### Contract

| Method | When Called | Responsibility |
|---|---|---|
| `init()` | Once, at startup | Acquire hardware resources |
| `transduce(tree, structureChanged)` | Per frame | Read tree, produce output. `structureChanged` triggers recompile. |
| `invalidate()` | On structure change | Mark compiled state as stale |

### Composition

Transducers compose by operating on different node types in the same tree. A `@physics` transducer and an `@audio` transducer can be written independently and run against the same tree without coordination. Each transducer ignores node types it does not handle.

```
tree = Rex.parse(source)
gpu.transduce(tree)
form.transduce(tree)
physics.transduce(tree)
audio.transduce(tree)
```

The compile/execute separation is internal to each transducer. The outer loop is unaware of it.

---

## Part 12: Texture and Asset Pipeline

### Texture Sources

Textures support three source types:

```
@texture checker :width 256 :height 256 :fill checkerboard   ;; procedural
@texture albedo :src assets/stone.png :filter linear          ;; URL/file
@texture data :src data:image/png;base64,...                   ;; data URI
;; Future: @texture t :src shrine://textures/stone             ;; Shrine path
```

### Async Loading with Placeholders

When `:src` is present, the texture is created with a magenta placeholder and loading begins asynchronously. On completion, the texture is replaced and bind groups are invalidated. A generation counter cancels stale loads when the tree recompiles during loading.

### Source Resolution

`_resolveAssetSource(src)` is the single hook point for source resolution:
- URLs and data URIs pass through directly
- Relative paths resolve relative to the page
- `shrine://` paths will resolve to fetch-able URLs when Shrine integration is ready

### Asset Nodes (Future)

Binary data (meshes, audio) will be referenced via `@asset` nodes. Shrine handles path resolution. The blob is a PLAN pin (content-addressed, immutable).

```
@asset mesh_data
  :path /meshes/hero.glb
  :format vertices
```

### Texture and Sampler Bindings

The `@bind` node declares the resource type:

```
@bind 0
  :buffer uniforms

@bind 1
  :texture brick_texture
  :sampler linear
```

The compile phase reads binding type from the `@bind` node and creates the appropriate bind group entry (buffer, texture, or sampler).

---

## Part 13: Expression System

Expressions are evaluated per-frame in the execute phase. They resolve to numeric values written to compiled heap offsets.

### Builtins

| Expression | Value |
|---|---|
| `(elapsed)` / `(time)` | Seconds since start |
| `(frame)` | Frame count |
| `(canvas-w)` / `(canvas-h)` | Canvas pixel dimensions |
| `(canvas-size)` | `[width, height]` |

### Form Bridge

`(form/field_name)` resolves to live form state. When the named field changes, the value writes directly to the heap at the compiled offset.

### Combinators

```
(sin (elapsed))
(mul (form/speed) (elapsed))
(add 1.0 (mul 0.5 (sin (elapsed))))
```

---

## Part 14: Form Transducer

`@form` Shrubs describe interactive UI. The form transducer projects them to HTML. Fields become widgets. Actions become buttons.

```
@form
  :title "Scene Controls"
  :description "Adjust camera and lighting"

  @section camera
    @field cam_dist
      :type range
      :label "Camera Distance"
      :min 2  :max 10  :step 0.1  :default 5
```

### Field Types

| Type | Element | Attributes |
|---|---|---|
| `text` | `<input type="text">` | `:placeholder` |
| `number` | `<input type="number">` | `:min`, `:max`, `:step` |
| `range` | `<input type="range">` | `:min`, `:max`, `:step`, `:default` |
| `select` | `<select>` | `:options [a b c]` |
| `toggle` | Custom switch | `:default true/false` |
| `radio` | Radio group | `:options [a b c]` |
| `checkbox` | Checkbox group | `:options [a b c]` |
| `tags` | Tag selector | `:options [a b c]` |
| `textarea` | `<textarea>` | `:placeholder`, `:rows` |
| `color` | `<input type="color">` | `:default` |

### Layout Nodes

| Node | Purpose |
|---|---|
| `@section` | Titled group |
| `@row` | Horizontal layout |
| `@divider` | Horizontal rule |
| `@actions` | Button row |

### External State

`setExternal(key, val)` updates form state and syncs the corresponding DOM element. The form transducer caches element references in a `Map<fieldName, HTMLElement>` for O(1) lookup.

---

## Part 15: Dataflow Channels

The channel layer is the reactive dataflow system. It enables attribute propagation between nodes via compiled channels.

### Channels

```
@channel camera-follow
  :from /input/mouse/position
  :to /scene/camera/target
  :transform (lerp 0.1)
  :mode continuous
```

Compile phase: channel → compiled dataflow edge (source optic → transform → destination optic). Execute phase: evaluate source, apply transform, write to destination heap offset.

### Channel Modes

| Mode | Evaluation | Use Case |
|---|---|---|
| `continuous` | Every frame | Animation, physics, camera |
| `on-change` | When source changes | UI state propagation |
| `on-event` | On named event | User actions |

---

## Part 16: Integration with Shrine and PLAN

### Shrine

| Component | RPE Usage |
|---|---|
| Rex parser | Produces tree of Shrubs |
| Path resolution | Optic compilation targets |
| Attribute system | Shrub field values |
| Template definitions (`@template`) | Template/instancing |
| Expression evaluation | Per-frame dynamic values |

### PLAN

| Component | RPE Usage |
|---|---|
| Pins (content-addressed blobs) | Asset storage (textures, meshes) |
| Laws (PLAN closures) | Computation over tree state |
| Event log | Persistent state, undo history |

### Shared Path Compilation

Both RPE and the Predictive Coding Network compile Shrine paths over the same Shrub tree. RPE compiles to buffer optics (path → byte offset). The Predictive Coding Network compiles to SDR bit vectors (path → sparse distributed representation). Same Shrubs, same path resolution, two projections.

---

## Part 17: Overflow and Resilience

The system maintains the best available approximation at all times. It never presents undefined state.

| Tier | Condition | Response |
|---|---|---|
| 0 | Normal | Full quality |
| 1 | Frame budget exceeded | Increase LOD bias, reduce shadow distance |
| 2 | Instance pressure | Frustum cull, distance cull |
| 3 | Memory pressure | Transient resource aliasing, texture streaming |
| 4 | Catastrophic | Wireframe fallback, error overlay |

Shader and pipeline errors are handled by fallback (Part 7). Buffer overflow triggers heap extension or LOD fallback cascade.

---

## Part 18: Capability Targets

### AAA 3D (60fps @ 1080p, mid-range GPU)

- 100K+ visible meshlets per frame
- GPU-driven culling + LOD + multi-draw indirect
- PBR materials with bindless textures
- Shadow cascades, screen-space reflections, volumetrics
- Visibility buffer deferred shading

### 2D UI (120fps, pixel-perfect)

- Slug-style GPU text rendering (Bézier curves, resolution-independent)
- Flexbox/grid layout from tree structure
- Animated transitions via dataflow channels
- Vector graphics
- Mixed 2D/3D (UI overlaid on world, text in 3D space)

### Shared Infrastructure

Single compile phase handles both. Same heap, same optic system. UI nodes and 3D nodes coexist in one tree.

---

## Part 19: Implementation Status

### Implemented

- Rex parser with content blocks, expressions, inline attributes, template expansion
- GPU transducer: struct → WGSL, shader compilation, pipeline creation, buffer management, render passes, compute dispatches
- Zero-copy heap with compiled optics
- Dirty range tracking (byte-level)
- Double-buffered staging
- Compiled command list (zero tree traversal at execute time)
- Barrier schedule compilation from pass DAG
- Resource aliasing plan (interval coloring)
- Form transducer: widget set (range, select, checkbox, color), live state, external sync
- `@interact` declarative inverse projection
- `#import` WGSL struct and lib generation
- Shader/pipeline fallback on error
- Structure-change gating (hash on edit, not per frame)
- Cached form element references
- Bidirectional form ↔ GPU ↔ canvas data flow
- **Render-to-texture / MRT.** Passes target textures via `:target` or `:targets [array]`. Depth attachment via `:depth-target`. Pipeline fragment targets resolve from texture formats.
- **Asset/texture loading.** `@texture :src url` with async fetch, placeholder, generation-based cancellation, and Shrine path hook (`_resolveAssetSource`).
- **Indirect draw.** `@draw :indirect true :indirect-buffer name :indirect-offset N`. Storage buffers with `:usage [storage indirect]` get `INDIRECT` flag. Supports both `drawIndirect` and `drawIndexedIndirect`.
- **GPU feature detection.** `init()` probes adapter for available features, requests them, exposes via `hasFeature(name)`.

### Pending — Transducers Not Yet Written

The following node types exist in trees today but have no transducer to interpret them. Rex parses them; nothing acts on them yet.

- **Text rendering transducer.** Slug-style GPU Bézier glyph rendering or MSDF atlas rendering for `@text` nodes. Highest priority remaining gap.
- **Vertex layout transducer.** Infer vertex buffer layouts from `@struct` definitions.
- **Compute dataflow transducer.** Automatic bind group wiring for compute-to-render data flow across `@dispatch` → `@pass` boundaries.
- **Channel transducer.** Dataflow channel compilation for `@channel` nodes.
- **PLAN bridge transducer.** Event log persistence and undo history via PLAN pins.
- **GPU hit testing.** Compute shader point-in-rect with atomic z-order for self-hosting UI.
- **Vector graphics transducer.** Vello/Rive-style compute-shader path rendering for `@path` and `@shape` nodes.
- **Universal transcoding transducer.** Audio stem separation, video layer decomposition, format conversion as bidirectional optic chains with categorical composition guarantees per Clarke et al.

---

## Part 20: Multi-Backend Architecture and CUDA

### The Projection is Backend-Agnostic

The tree compiles to the same optics, the same byte offsets, the same barrier schedule regardless of backend. The transducer determines what GPU commands to emit. Adding a backend means writing a new transducer, not changing the architecture.

### Backend Matrix

| Target | Compute | Rasterization | Memory |
|---|---|---|---|
| Browser (current) | WebGPU compute (WGSL) | WebGPU render passes | Heap + writeBuffer |
| Native NVIDIA | CUDA kernels (PTX) | Vulkan render passes | Shared external memory |
| Native Apple | Metal compute (MSL) | Metal render passes | MTLSharedEvent |
| Native AMD | HIP / Vulkan compute | Vulkan render passes | Shared external memory |

### CUDA Transducer (ShrineOS / NVIDIA)

On NVIDIA hardware, the CUDA transducer replaces WebGPU compute. Vulkan handles rasterization. The heap is one allocation visible to both via `cudaImportExternalMemory`:

```
Rex Tree
  ├── CUDA Transducer (compute: culling, physics, PCN, ML)
  │     Compiles @dispatch → CUDA kernels via NVRTC
  │     CUDA Graphs for command list replay (~5μs vs ~50μs)
  │     Tensor cores for PCN matrix ops
  │     48KB+ shared memory, 64-bit atomics, cooperative groups
  │
  └── Vulkan Transducer (rasterization)
        Compiles @pass/@draw → Vulkan commands
        Shared heap via external memory interop (zero-copy)
        Synchronization via timeline semaphores
```

### CUDA-Specific Rex Extensions

Attributes consumed only by CUDA transducer, ignored by WebGPU:

```
@dispatch physics_step
  :shader xpbd_solver
  :shared_memory 49152        ;; 48KB (CUDA only)
  :launch_bounds [256 4]      ;; occupancy hints (CUDA only)
  :stream physics              ;; named CUDA stream (CUDA only)
```

### Key CUDA Advantages Over WebGPU

| Capability | CUDA | WebGPU |
|---|---|---|
| Float atomics | Native | CAS loop (3-10x slower) |
| 64-bit atomics | Yes | No |
| Shared memory | 48-228KB | 16KB |
| Warp shuffles | Full suite | Partial (subgroups) |
| Tensor cores | Yes | No |
| Dynamic parallelism | Yes | No |
| Kernel graphs | `cudaGraph_t` | No |

### RPE's Heap vs CUDA Unified Memory

RPE's explicit dirty-range tracking (4-byte granularity, async copy) is superior to CUDA unified memory (4KB page granularity, page-fault migration) for the projection engine use case. The typical per-frame upload is 4-32 bytes.

---

## Design Principles

```
THE TREE IS THE FRAME.              Shrubs are the specification and the runtime state.
THE TREE IS THE API.                Transducers read Shrubs. No plugin system required.
COMPILE RESOLVES, EXECUTE WRITES.   Paths → byte offsets at compile time. setFloat32 at runtime.
ONE HEAP.                           All uniforms in one GPUBuffer. One writeBuffer per frame.
ZERO TREE TRAVERSAL AT RUNTIME.     Compiled command list, compiled optics, compiled barriers.
DIRTY RANGE, NOT DIRTY FLAG.        Track byte min/max. Upload only what changed.
DOUBLE BUFFER FOR ATOMICITY.        No tearing between builtins and input events.
BARRIERS ARE STAGE MASKS.           No resource lists. Producer/consumer stages + hazard flags.
FALLBACK, NEVER CRASH.              Bad shader keeps last-good. Bad pipeline keeps running.
THE NOTATION IS THE MEMORY LAYOUT.  @struct defines bytes, WGSL, and optic targets.
```

---

## References and Influences

**Profunctor optics.** Clarke, Elkins, Gibbons, Loregian, Milewski, Pillmore, Román. "Profunctor Optics, a Categorical Update." arXiv:2001.07488, 2020. Formalizes bidirectional data accessors as profunctors in enriched categories, with compositionality by construction. RPE's compile-time optics (path → byte offset, bidirectional via `@interact`) are an informal instance of this framework. The categorical composition law is directly applicable to a future universal transcoding pipeline (see Part 19, Pending).

**Rex.** Rex is the indentation-scoped tree notation that serves as RPE's input format. Developed as part of AxSys's ShrineOS, Rex parses source into a tree of Shrubs — the universal node type with fields (typed state), kids (recursive children), and actions (typed operation signatures). Shrine provides parser, path resolution, attribute system, and expression evaluation. RPE compiles Shrub trees to GPU state without reimplementing any of these primitives.

**PLAN.** PLAN is the evaluation substrate underlying ShrineOS. Pins (content-addressed immutable blobs) store assets. Laws (closures with name, arity, and body) define computation over tree state. The event log provides persistent state and undo history. RPE interfaces with PLAN through Shrine's path resolution and asset system.

**No Graphics API.** Sebastian Aaltonen, 2024. Proposes that modern GPU hardware no longer requires the abstraction layers imposed by DX12/Vulkan: everything reduces to GPU memory + pointers, stage-mask barriers without resource lists, and struct layouts shared between CPU and GPU. RPE's unified heap, compiled optics, and barrier scheduling follow this thesis. RPE extends it by eliminating the graphics API concept entirely — the tree targets a projection surface, not an API.

**JAI.** Jonathan Blow's programming language for games (closed beta). RPE's compile phase is JAI's `#run` — arbitrary computation at compile time, flat execution at runtime. RPE's zero-copy heap is JAI's "no hidden allocations" taken to its conclusion: zero allocations at runtime. RPE's transducers avoid OOP inheritance in the same spirit as JAI's "no hidden virtual dispatch."

**CUDA.** NVIDIA's parallel computing platform. RPE's CUDA backend (Part 20) targets CUDA for compute and Vulkan for rasterization, with shared heap via external memory interop. CUDA Graphs map directly to RPE's compiled command list. PCN matrix operations fit in CUDA's L2 cache (~0.2ms per event).

**Morphogenetic computation.** Michael Levin's work on bioelectric pattern formation and multiscale competency architectures was an early design influence on RPE's compile/execute separation, overflow resilience model, and tree-as-specification-and-state pattern.
