# AAA Game Capabilities Specification v1

**Closing the gap between the Rex Projection Engine and AAA game-level rendering, physics, and interaction — by recognizing that a game engine is not a separate system but a convergence of projections over the same Shrub tree.**

---

## The Breakthrough

There is no "game engine" to build. There is a tree, and there are projections.

A game entity is a Shrub. Its transform is a `@slot`. Its mesh is an `@asset` pin. Its behaviour is `@derive` + `@talk` + `@dep`. Its rendering is `@pass` + `@draw` at compiled optic offsets into the heap. Its AI is a PCN belief agent with affordances. Its persistence is a PLAN pin history. Its physics is a `@dispatch` writing to the same heap the render pass reads.

The "game engine" is what happens when ALL the transducers operate on the same tree simultaneously:

```
@shrub enemy
  ;; STATE — behaviour transducer
  @slot position :type f32x3 :default [0 0 0]
  @slot velocity :type f32x3 :default [0 0 0]
  @slot health :type number :default 100
  @slot mesh :type pin :default shrine://meshes/enemy
  @slot state :type string :default "patrol"

  ;; BEHAVIOUR — behaviour transducer compiles to kooks
  @derive :slot speed
    (length /velocity)
  @talk take-damage
    @input amount :type number
    @set /health (sub /health %amount)
  @talk set-position
    @input pos :type f32x3
    @set /position %pos

  ;; PHYSICS — GPU transducer compiles to compute dispatch
  @dispatch physics-step
    :pipeline physics-compute
    :grid [(entity-count / 256) 1 1]
    @bind 0 :storage entity-positions :storage entity-velocities

  ;; RENDERING — GPU transducer compiles to render pass
  @pass scene :target hdr-buffer :depth-target depth :clear [0 0 0 1]
    @draw :pipeline mesh-pipe :indirect true :indirect-buffer draw-args
      @bind 0 :buffer scene-uniforms
      @bind 1 :storage entity-transforms
      @bind 2 :texture shrine://textures/enemy-albedo

  ;; AI — PCN learns from player interactions with this entity
  ;; (automatic via PLAN bridge event → PCN episode)
```

One Shrub. Five projections (behaviour, physics, rendering, AI, persistence). No "game engine" — just transducers reading the same tree.

---

## Part 1: The Entity-Component-Shrub Mapping

Traditional game engines use ECS (Entity Component System). RPE doesn't need ECS because **the Shrub tree IS the entity hierarchy and the component data lives in the heap**.

| ECS Concept | Shrub Equivalent |
|---|---|
| Entity | `@shrub` with a unique path |
| Component | `@slot` on the Shrub (typed state at a heap offset) |
| System | Transducer (GPU, Behaviour, Physics) |
| Archetype | `@struct` (memory layout for a group of components) |
| Query | Path resolution (compiled to offset at build time) |
| World | The Shrine namespace (single tree of Shrubs) |

The key difference: ECS stores components in SoA (struct-of-arrays) tables for cache-friendly iteration. RPE's `@struct` already produces flat, aligned memory layouts. For N entities with the same `@struct`, the heap contains N contiguous regions of identical layout. A compute shader iterates them identically to how an ECS system iterates an archetype table.

```
@struct EntityTransform
  @field position :type f32x3
  @field rotation :type f32x4   ;; quaternion
  @field scale :type f32x3

@buffer entity-transforms :struct EntityTransform :count 10000
  ;; 10,000 entity transforms, contiguous in heap
  ;; Each at offset = base + index * sizeof(EntityTransform)
```

The compute shader reads/writes `entity-transforms` as a storage buffer. Same memory, same offsets, zero copy between physics (writes position) and rendering (reads position for vertex shader).

---

## Part 2: GPU-Driven Rendering Pipeline

Now that render-to-texture, indirect draw, and feature detection are implemented, the full GPU-driven pipeline is expressible in Rex:

### Scene Description

```
;; ═══ STRUCTS ═══
@struct SceneUniforms
  @field view_proj :type f32x4x4
  @field camera_pos :type f32x3
  @field time :type f32
  @field light_count :type u32
  @field resolution :type f32x2

@struct MeshletInfo
  @field center :type f32x3
  @field radius :type f32
  @field cone_axis :type f32x3
  @field cone_cutoff :type f32
  @field vertex_offset :type u32
  @field triangle_offset :type u32
  @field vertex_count :type u32
  @field triangle_count :type u32

;; ═══ BUFFERS ═══
@buffer scene :struct SceneUniforms
  @data view_proj (form/view_proj) camera_pos (form/camera_pos)
  @data time (elapsed) resolution (canvas-size) light_count 4

@buffer meshlet-data :usage [storage] :size 10000000
@buffer draw-args :usage [storage indirect] :size 16
@buffer visible-meshlets :usage [storage] :size 4000000

;; ═══ TEXTURES ═══
@texture hdr-buffer :width (canvas-w) :height (canvas-h) :format rgba16float :render true
@texture depth-buffer :width (canvas-w) :height (canvas-h) :format depth24plus :render true
@texture hiz-buffer :width 512 :height 512 :format r32float :render true

;; ═══ COMPUTE: CULL + LOD ═══
@dispatch cull-pass
  :pipeline cull-compute
  :grid [(meshlet-count / 256) 1 1]
  @bind 0 :buffer scene :storage meshlet-data
  @bind 1 :storage visible-meshlets :storage draw-args

;; ═══ RENDER: MAIN SCENE ═══
@pass scene :target hdr-buffer :depth-target depth-buffer :clear [0 0 0 1]
  @draw :pipeline mesh-pipe :indirect true :indirect-buffer draw-args
    @bind 0 :buffer scene
    @bind 1 :storage visible-meshlets :storage meshlet-data

;; ═══ COMPUTE: HI-Z GENERATION ═══
@dispatch hiz-gen
  :pipeline hiz-compute
  :grid [32 32 1]
  @bind 0 :texture depth-buffer :storage hiz-buffer

;; ═══ POST-PROCESSING ═══
@pass tonemap :clear [0 0 0 1]
  @draw :pipeline tonemap-pipe :vertices 3
    @bind 0 :texture hdr-buffer :buffer scene
```

This is a complete GPU-driven rendering pipeline: frustum/occlusion cull → indirect draw → Hi-Z generation → tone mapping. All in Rex notation. All compiled to a flat command list.

---

## Part 3: Physics as Compute Dispatch

Physics is not a separate engine. It's `@dispatch` nodes writing to the same storage buffers that render passes read.

### XPBD Cloth/Soft Body

```
@struct Particle
  @field position :type f32x4    ;; xyz + padding
  @field prev_pos :type f32x4
  @field velocity :type f32x4    ;; xyz + inv_mass in w

@struct Constraint
  @field indices :type u32x2     ;; particle A, particle B
  @field rest_length :type f32
  @field compliance :type f32

@buffer particles :usage [storage] :size 1000000
@buffer constraints :usage [storage] :size 2000000

;; Predict positions
@dispatch physics-predict
  :pipeline predict-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage particles

;; Solve constraints (multiple iterations)
@dispatch physics-solve
  :pipeline solve-compute
  :grid [(constraint-count / 256) 1 1]
  @bind 0 :storage particles :storage constraints

;; Finalize velocities
@dispatch physics-finalize
  :pipeline finalize-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage particles

;; Render particles (reads same storage buffer)
@pass render :clear [0.05 0.05 0.1 1]
  @draw :pipeline particle-pipe :vertices 6 :instances (particle-count)
    @bind 0 :buffer scene :storage particles
```

Physics → rendering: zero copies. The storage buffer IS the shared state. The barrier schedule infers the RAW hazard between dispatch and pass automatically.

### SPH Fluid

```
@buffer fluid-particles :usage [storage] :size 5000000
@buffer spatial-hash :usage [storage] :size 2000000
@buffer densities :usage [storage] :size 500000

@dispatch fluid-hash
  :pipeline hash-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage fluid-particles :storage spatial-hash

@dispatch fluid-density
  :pipeline density-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage fluid-particles :storage spatial-hash :storage densities

@dispatch fluid-forces
  :pipeline forces-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage fluid-particles :storage spatial-hash :storage densities

@dispatch fluid-integrate
  :pipeline integrate-compute
  :grid [(particle-count / 256) 1 1]
  @bind 0 :storage fluid-particles
```

Four compute passes, all operating on the same storage buffers. The render pass reads `fluid-particles` and draws spheres or marching-cubes surface.

---

## Part 4: Animation as Heap Writes

### GPU Skinning

```
@struct Joint
  @field bind_inverse :type f32x4x4
  @field world_transform :type f32x4x4

@buffer joints :usage [storage] :size 500000

@dispatch skin-compute
  :pipeline skinning-compute
  :grid [(vertex-count / 256) 1 1]
  @bind 0 :storage joints :storage input-vertices :storage output-vertices
```

Joint matrices updated per-frame (from behaviour transducer's animation state or from PLAN-pinned animation data). Skinning runs as compute, output vertices go straight to the render pass.

### Animation Textures for Crowds

```
@texture anim-texture :width 512 :height 1024 :format r32float
  :src shrine://animations/crowd-walk

@pass crowd :target hdr-buffer :depth-target depth-buffer :load load
  @draw :pipeline crowd-pipe :vertices 36 :instances 5000
    @bind 0 :buffer scene :storage crowd-instances
    @bind 1 :texture anim-texture
```

5,000 instances, each sampling a different frame from the animation texture via instance ID. One draw call.

---

## Part 5: Material System via @struct + Override Constants

Materials are `@struct` definitions with WGSL `override` constants for feature permutations:

```
@struct PBRMaterial
  @field albedo :type f32x4
  @field roughness :type f32
  @field metallic :type f32
  @field emissive :type f32x3

@pipeline pbr-pipe
  :vertex scene-vert
  :fragment pbr-frag
  :format rgba16float
  :depth true
  :blend alpha
  :override HAS_NORMAL_MAP true
  :override HAS_EMISSIVE false
  :override ALPHA_CUTOUT false
```

The `:override` attributes map to WGSL `override` declarations — pipeline-overridable constants set at pipeline creation time. The GPU compiler dead-code-eliminates unused branches. Same shader source, different compiled pipelines per material variant.

```wgsl
override HAS_NORMAL_MAP: bool = false;
override HAS_EMISSIVE: bool = false;

@fragment fn fs_main(...) -> @location(0) vec4f {
    var albedo = textureSample(albedo_tex, samp, uv);
    if (HAS_NORMAL_MAP) {
        // This entire branch is compiled out when false
        let tbn_normal = textureSample(normal_tex, samp, uv).xyz * 2.0 - 1.0;
        normal = normalize(tbn * tbn_normal);
    }
    // ...
}
```

---

## Part 6: The Profunctor Optic Game Loop

Here's where it gets interesting. Consider the game loop across ALL specs:

```
FRAME:
  1. Behaviour transducer evaluates @derive slots          (view optic: state → derived)
  2. @talk invocations mutate Shrub state                   (set optic: input → state)
  3. PLAN bridge pins mutations as events                   (persistence optic: state → pin)
  4. PCN processes episodes from events                     (SDR optic: event → bit vector)
  5. RPE reads Shrub state into heap at compiled offsets    (buffer optic: state → bytes)
  6. RPE compute dispatches: physics, culling, skinning     (GPU optic: bytes → bytes)
  7. RPE render passes: scene, post-process, UI             (projection optic: bytes → pixels)
  8. @interact maps screen input back to Shrub state        (inverse optic: pixels → state)
  → Loop
```

Every step is an optic. The forward direction projects state to output. The inverse direction projects input back to state. The composition of all optics IS the game loop. And profunctor optics guarantee this composition is correct — each optic only knows its own focus, the residuals chain automatically, the coend quantifies away the context.

This means **the game loop is a composed profunctor optic from Shrub tree to pixels and back.** Not metaphorically. Categorically. Each transducer contributes one or more optic components. The game loop is their composition.

### What This Gives You

**Automatic serialization.** If every game state change flows through optics that write to both the heap (for rendering) and the event log (for persistence), then save/load is free. Pin the tree. Restore the pin. The heap recompiles. The game state is exactly where it was.

**Automatic replay.** The event log IS the replay. Play back events at 2x speed = time-lapse of the game session. The PCN learns from replays too — it sees the same episodes.

**Automatic AI.** PCN belief agents observe player behaviour through episodes. "Player always opens inventory before boss fights" crystallizes as a belief agent with an affordance: "prepare for boss." The game didn't code this. The connectome learned it.

**Automatic undo.** Ctrl+Z in a game = restore previous pin. Physics, rendering, AI state all recompute from the restored tree.

**Hot reload.** Change a shader, a `@derive`, a `@talk`, a texture — only the affected kook/pipeline/optic recompiles. The rest of the game continues running. This is live game development, not just live shader editing.

---

## Part 7: What's Still Missing (Concrete Gaps)

### Gap A: Compute-to-Render Dataflow Automation

**Status:** Manual bind group wiring. Each `@bind` explicitly names storage buffers.
**Need:** Compiler traces storage buffer read/write across `@dispatch` → `@pass` boundaries and generates shared bind groups automatically.
**Implementation:** ~200 lines in compile phase. Walk command list, build resource usage graph, generate bind group layouts that span multiple passes.

### Gap B: Explicit Pipeline Layouts

**Status:** `layout: 'auto'` means bind groups can't be shared across pipelines.
**Need:** Compile-time bind group layout generation from `@struct` definitions.
**Implementation:** ~150 lines. New compile step between struct compilation and pipeline creation. `@bind-group-layout` node type, or infer from `@struct` usage patterns.

### Gap C: Instance Buffer Management

**Status:** Instance count is a static `:instances N` on `@draw`.
**Need:** Dynamic instance count from compute (already possible via indirect draw). But also: instance data management — allocating, growing, compacting instance arrays in storage buffers.
**Implementation:** A `@pool` node type for managed storage buffer allocation with grow/compact semantics. The behaviour transducer's `@kids` collections map to instance pools.

### Gap D: LOD and Streaming

**Status:** No LOD system. No texture streaming.
**Need:** Meshlet LOD DAG traversal in compute. Texture mip streaming via PLAN pin resolution.
**Implementation:** Meshlet LOD is application-level compute shaders (the infrastructure exists). Texture streaming is `_resolveAssetSource` + progressive loading (PLAN pins at different mip levels).

### Gap E: Shadow Maps

**Status:** Render-to-texture works, but no shadow mapping pipeline.
**Need:** `@pass` targeting a depth texture from the light's perspective, sampled in the main pass.
**Implementation:** Already expressible. Write the shaders, declare the passes:

```
@texture shadow-map :width 2048 :height 2048 :format depth24plus :render true

@pass shadow :depth-target shadow-map
  @draw :pipeline shadow-pipe :indirect true :indirect-buffer draw-args
    @bind 0 :buffer light-uniforms :storage visible-meshlets

@pass scene :target hdr-buffer :depth-target depth-buffer :clear [0 0 0 1]
  @draw :pipeline scene-pipe :indirect true :indirect-buffer draw-args
    @bind 0 :buffer scene-uniforms :storage visible-meshlets
    @bind 1 :texture shadow-map :buffer light-uniforms
```

This works TODAY with the current implementation. Shadow mapping is not a gap — it's an application of render-to-texture.

### Gap F: Forward+ Clustered Lighting

**Status:** No built-in light clustering.
**Need:** Compute pass that assigns lights to 3D clusters, render pass reads cluster data.
**Implementation:** Application-level compute + render shaders. The infrastructure (compute dispatch, storage buffers, indirect draw) already exists. ~300 lines of WGSL for the clustering compute shader.

---

## Part 8: The Meta-Realization

Looking across all the specs, the "AAA game gap" is not about missing engine features. It's about missing **content pipelines** and **application-level patterns**:

| What People Call "Engine Feature" | What It Actually Is |
|---|---|
| Shadow mapping | Two render passes + depth texture sampling |
| Deferred rendering | G-buffer MRT pass + lighting compute pass |
| GPU-driven rendering | Cull compute → indirect draw |
| Physics engine | Compute dispatches reading/writing storage buffers |
| Animation system | Compute dispatch + animation texture sampling |
| LOD system | Compute dispatch evaluating screen-space error |
| Material system | `@struct` + WGSL override constants |
| Scene graph | The Shrub tree |
| ECS | `@struct` as archetype + storage buffer as component table |
| AI system | PCN belief agents with affordances |
| Save/load | PLAN pin history |
| Replay system | Event log playback |
| Hot reload | Recompile only the changed kook/pipeline |

RPE already provides ALL the primitives. The "gap" is pattern libraries — reusable Rex templates for common game patterns:

```
;; Shadow mapping template
@template shadow-mapped-scene
  @param light-size :default 2048
  @param cascade-count :default 4
  @texture shadow-atlas :width $light-size :height $light-size :format depth24plus :render true
  @pass shadow :depth-target shadow-atlas
    @draw :pipeline shadow-pipe :indirect true :indirect-buffer draw-args
      @bind 0 :buffer light-uniforms :storage visible-meshlets
  ;; ... cascade computation, sampling in main pass

;; Forward+ template
@template forward-plus-lighting
  @param tile-size :default 16
  @param max-lights :default 256
  @buffer cluster-data :usage [storage] :size 4000000
  @dispatch light-assign :pipeline cluster-compute :grid [...]
    @bind 0 :buffer scene :storage lights :storage cluster-data
  ;; ... main pass reads cluster data

;; XPBD physics template
@template soft-body
  @param max-particles :default 10000
  @param iterations :default 4
  @buffer particles :usage [storage] :size (mul $max-particles 48)
  @buffer constraints :usage [storage] :size (mul $max-particles 64)
  @dispatch predict :pipeline predict-compute :grid [...]
  @dispatch solve :pipeline solve-compute :grid [...]   ;; run $iterations times
  @dispatch finalize :pipeline finalize-compute :grid [...]
```

These templates compose through `@use`:

```
@use shadow-mapped-scene :light-size 4096 :cascade-count 3
@use forward-plus-lighting :tile-size 16 :max-lights 512
@use soft-body :max-particles 50000 :iterations 8
```

The "game engine" is a library of Rex templates. The RPE compiles them to GPU commands. The behaviour transducer compiles game logic to kooks. The PCN learns from gameplay. PLAN persists everything.

---

## Part 9: PCN as Game AI

This is the orthogonal connection across specs that nobody else has.

PCN belief agents learn from player behaviour. In a game context:

- **Episode**: Player opens inventory, equips fire resistance potion, enters lava area
- **Pattern**: The PCN learns: before lava areas, player equips fire resistance
- **Crystallization**: Belief agent "lava-prep" spawns with affordance "equip fire resistance + buff"
- **Recall**: Next time player approaches lava, the connectome activates "lava-prep" via cue kernel
- **Affordance**: Right-click menu offers "Prepare for lava area" — one click executes the sequence

The game didn't code this NPC-like assistant behaviour. The connectome learned it from the player's own actions. The affordance executes through `@talk` mutations on game Shrubs. The RPE renders the result.

This is why the Behaviour spec, PCN spec, and RPE spec are three views of one system. The "game AI" is the PCN operating on the same Shrubs that the behaviour transducer mutates and the GPU transducer renders.

---

## Part 10: CUDA Backend for AAA Performance

For native ShrineOS, the CUDA transducer replaces WebGPU compute for:

| Operation | WebGPU | CUDA Advantage |
|---|---|---|
| Meshlet culling | 256 workgroup, no 64-bit atomics | 1024 threads, 64-bit atomics for visibility buffer |
| Physics XPBD | CAS loop for float atomics (3-10x slow) | Native float atomicAdd |
| SPH fluid | 16KB shared memory for neighbor cache | 48KB+ shared memory |
| Skinning | Standard compute | Tensor cores for matrix multiply |
| PCN cue kernel | Sub-ms already | 10x faster with CUDA SGEMM |
| Hi-Z generation | Standard compute | Cooperative groups for efficient mip chain |
| Software rasterization | Two-pass (no 64-bit atomics) | Single-pass with packed 64-bit atomic |

The Rex notation is identical. Same `@dispatch`, same `@pass`, same `@struct`. The CUDA transducer emits CUDA kernels instead of WGSL compute shaders. Backend-specific attributes (`:shared_memory`, `:launch_bounds`, `:stream`) are ignored by WebGPU and consumed by CUDA.

---

## Design Principles

```
THE TREE IS THE SCENE.             No separate scene graph. The Shrub tree IS the game world.
ENTITIES ARE SHRUBS.               Position, health, mesh — all @slots.
SYSTEMS ARE TRANSDUCERS.           Physics, rendering, AI — all projections of the same tree.
THE GAME LOOP IS A COMPOSED OPTIC. State → derives → mutations → pins → SDRs → bytes → pixels → input → state.
TEMPLATES ARE THE ENGINE.          Shadow mapping, physics, lighting — reusable Rex templates.
PHYSICS IS COMPUTE.                @dispatch reads/writes same storage buffers as @pass.
AI IS THE CONNECTOME.              PCN learns gameplay patterns. Affordances execute through @talk.
PERSISTENCE IS PINS.               Save = pin the tree. Load = restore the pin.
THE NOTATION IS THE ENGINE.        There is no engine binary. There is a tree and projections.
```

---

## References

- **RPE Specification v2** — Parts 5, 12, 18, 19, 20. Render-to-texture, indirect draw, CUDA backend.
- **Behaviour Specification v1** — Parts 3-7. @derive, @talk, @dep as game logic.
- **PCN Specification v4** — Parts 4-5, 8. CUDA engines, connectome, affordances as game AI.
- **PLAN Bridge Specification v1** — Parts 1-3. Event sourcing, undo, asset resolution as save/load.
- **GPU Research** — Sections 2 (AAA techniques), 3 (UI animation), 6 (CUDA).
- **Profunctor Optics** — Clarke et al. 2020. The game loop as composed optic.
