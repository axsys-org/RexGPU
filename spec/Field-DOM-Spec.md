# Scalar Field UI + DOM Anchoring — Implementation Specification v2

**Version 2.0 — March 2026**

> *"The shrub is the proxy. The field is the ghost. The anchor is the bridge."*
> *— Proxy Ghost Ship pattern, applied to UI*

---

## Table of Contents

1. [Design Thesis](#1-design-thesis)
2. [Field Transducer as Sugar Expansion](#2-field-transducer-as-sugar-expansion)
3. [Field Evaluation Compute Shader](#3-field-evaluation-compute-shader)
4. [Field Composition Algebra](#4-field-composition-algebra)
5. [Field Dynamics (Evolution)](#5-field-dynamics-evolution)
6. [Field Visualization Modes](#6-field-visualization-modes)
7. [Surface Pipeline Integration](#7-surface-pipeline-integration)
8. [DOM Anchor Layer](#8-dom-anchor-layer)
9. [Text Selection + Clipboard](#9-text-selection--clipboard)
10. [EditContext Integration](#10-editcontext-integration)
11. [Accessibility Shadow DOM](#11-accessibility-shadow-dom)
12. [CSS Anchor Positioning](#12-css-anchor-positioning)
13. [Responsive Layout via Field Boundary Conditions](#13-responsive-layout-via-field-boundary-conditions)
14. [Interaction as Field Sampling](#14-interaction-as-field-sampling)
15. [Profunctor Optics for DOM↔GPU Bridge](#15-profunctor-optics-for-domgpu-bridge)
16. [Fiber Lifecycle for DOM Resources](#16-fiber-lifecycle-for-dom-resources)
17. [CommandRing Profiling](#17-commandring-profiling)
18. [Compilation Model](#18-compilation-model)
19. [Grammar Extensions](#19-grammar-extensions)
20. [Performance Budget](#20-performance-budget)
21. [Examples](#21-examples)

**Appendices**
- [A: WGSL Templates](#appendix-a-wgsl-templates)
- [B: Browser API Support Matrix](#appendix-b-browser-api-support-matrix)
- [C: Houdini Scalar Field Alignment](#appendix-c-houdini-scalar-field-alignment)
- [D: Migration Guide (v1 → v2)](#appendix-d-migration-guide-v1--v2)

---

## 1. Design Thesis

### 1.1 The Proxy Ghost Ship

Game engines separate physics from rendering. The **proxy mesh** handles collision, buoyancy, and simulation — invisible, simplified, authoritative. The **visual mesh** follows it — detailed, beautiful, inert. The proxy drives the ghost.

Rex already does this. The **shrub** is the proxy — state, interaction targets, accessibility roles, reactive derives, guarded talks. The **GPU output** is the ghost — pixels, shaders, field evaluations, visual effects. **Channel bridges** are the transform copy — every frame, shrub slot values flow to GPU heap, field evaluator reads them, pixels appear.

The scalar field paradigm makes the ghost liquid instead of rectangular. DOM anchoring makes the proxy visible to the browser platform. Neither changes the architecture — both are projections over the same shrub tree.

### 1.2 Three Layers, One Tree

```
┌─────────────────────────────────────────────────────────────┐
│                    REX TREE (.rex source)                     │
│                                                               │
│  @field layout      @shrub state     @panel nav     @form    │
│    @source a          @slot x          @text "Home"   @range │
│    @source b          @derive y        @text "About"         │
│    @visualize         @talk click      @rect bg              │
│    @anchor links      @channel ...                           │
└──────────┬──────────────┬──────────────┬──────────────┬──────┘
           │              │              │              │
     ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
     │  FIELD     │ │ BEHAVIOUR │ │  SURFACE   │ │   FORM    │
     │  (sugar    │ │TRANSDUCER │ │ TRANSDUCER │ │TRANSDUCER │
     │  in GPU)   │ │           │ │            │ │           │
     │            │ │           │ │            │ │           │
     │ → synthetic│ │ Shrubs    │ │ Paths/SDF  │ │ Real DOM  │
     │   @texture │ │ derives   │ │ flatten→   │ │ <input>   │
     │   @shader  │ │ talks     │ │ fine→      │ │ <select>  │
     │   @pipeline│ │ channels  │ │ composite  │ │ <button>  │
     │   @dispatch│ │           │ │            │ │           │
     │ + DOM      │ │           │ │            │ │           │
     │   anchors  │ │           │ │            │ │           │
     └─────┬──────┘ └─────┬─────┘ └─────┬──────┘ └─────┬─────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
     ┌──────────────────────────────────────────────────────┐
     │              COMPOSITE OUTPUT                        │
     │                                                      │
     │  GPU: field texture + surface texture + 3D scene     │
     │  DOM: anchor divs + a11y shadow + EditContext        │
     │  CSS: anchor positioning for popovers/tooltips       │
     └──────────────────────────────────────────────────────┘
```

### 1.3 Invariants

1. **Sugar, not transducer.** `@field` expands to synthetic `@texture` + `@shader` + `@pipeline` + `@dispatch` nodes inside the GPU transducer's compile phase. Same pattern as `@filter` (`rex-gpu.js:885` `_compileFilters`). No new transducer class.

2. **Shrub is the proxy.** Field sources ARE shrub slots. DOM anchors ARE shrub projections. The shrub holds the truth; the field and DOM are views.

3. **Profunctor optics everywhere.** DOM anchor position sync is a forward optic (shrub slot → CSS transform). Selection readback is a backward optic (DOM Selection → shrub slot). Same algebra as GPU readback (`rex-gpu.js:612` `_compileReadbacks`) and agent tool channels (Rex-Agent-Spec §4).

4. **Fiber lifecycle for DOM resources.** `<gpu-anchor>` elements, EditContext instances, and ARIA shadow nodes persist across recompile via `rexUseResource` (`rex-fiber.js:142`). Same lifecycle as agent API clients and media textures.

5. **Field is data, visualization is separate.** Following Houdini's Scalar Field DOP model: `@field` stores the grid, `@visualize` renders it. One field, many views.

6. **No new runtime.** Every concept maps to existing Rex primitives — `@channel` (`rex-behaviour.js:387`), `@derive` (`rex-behaviour.js:686`), `@guard`, `@talk`, compiled optics (`rex-gpu.js:1432`), dirty tracking, sugar expansion.

7. **Surface pipeline integration.** Field output textures composite with the existing Vello-style surface pipeline (`rex-surface.js:2449` execute). Field is an additional texture source, not a replacement for the surface rasterizer.

### 1.4 What Changed from v1

| Area | v1 | v2 |
|---|---|---|
| Compile position | Separate step between agent sugar and filter sugar | Inside GPU transducer at phase 1.5, alongside `_compileFilters` |
| Surface integration | Unspecified | Explicit composite step — field texture blended with surface output |
| Source references | None verified | All pinned to actual source line numbers |
| Behaviour shrub | Implicit | Explicit `@shrub _field_NAME` with slots for dynamic params |
| Hit testing | Separate field hit test shader | Merged with existing hit pipeline (`rex-surface.js:264`) |
| Profiling | None | CommandRing integration (`rex-fiber.js:933`) |
| Media alignment | None | Field textures participate in RexMedia unified media abstraction |
| Registration | `Rex.registerContentType('field')` | `gpu.registerCompileType('field', ...)` — fields are GPU constructs, not content types |
| Fiber lifecycle | Hand-waved | Exact `rexUseResource`/`rexKeyed` signatures with dep arrays |
| Incremental recompile | Mentioned | Exact phase triggers for `_mapChangesToPhases` (`rex-gpu.js:2805`) |

---

## 2. Field Transducer as Sugar Expansion

### 2.1 @field Node

```rex
@field layout-field
  :resolution 512 512
  :composition smooth-min
  :blend-k 0.3
  :evolution none               ;; or: stable-fluids, force-directed, gray-scott
  :border constant              ;; constant | repeat | streak (Houdini alignment)
  :border-value 0.0

  @source panel-a
    :pos (100 200)
    :strength 1.0
    :falloff inverse-square
    :radius 80

  @source cursor
    :pos (mouse-x mouse-y)
    :strength (pointer-pressure)
    :falloff gaussian
    :sigma 30

  @visualize
    :mode isosurface
    :threshold 0.5
    :color-inside #1a1b26ff
    :color-outside #00000000
```

### 2.2 Expansion Rules

`_compileFields(tree)` runs inside the GPU transducer compile at phase 1.5, same slot as `_compileFilters(tree)` (`rex-gpu.js:885`). Each `@field` node expands to:

| @field Child | Expands To | Purpose |
|---|---|---|
| (root) | `@struct _field_NAME_source` | Per-source param struct (pos, strength, radius, falloff) |
| (root) | `@struct _field_NAME_config` | Field config struct (resolution, blend_k, border, source_count) |
| (root) | `@texture _field_NAME_grid` | Storage texture for field values (r32float) |
| (root) | `@texture _field_NAME_out` | RGBA output texture per `@visualize` |
| `@source` children | Buffer entries via heap layout | Source params packed contiguously |
| (root) | `@shader _field_NAME_eval` | Compute shader: evaluate composed field |
| `@visualize` | `@shader _field_NAME_viz` | Compute shader: field grid → RGBA pixels |
| (root) | `@resources _field_NAME_eval_res` | Bind group for eval (config + sources + grid) |
| (root) | `@resources _field_NAME_viz_res` | Bind group for viz (config + grid + output) |
| (root) | `@pipeline _field_NAME_eval_pipe` | Compute pipeline for eval shader |
| (root) | `@pipeline _field_NAME_viz_pipe` | Compute pipeline for viz shader |
| (root) | `@dispatch _field_NAME_eval` | Dispatch eval shader |
| (root) | `@dispatch _field_NAME_viz` | Dispatch viz shader |
| `@source :pos (expr)` | `@channel` entries via behaviour | Dynamic source params: shrub slot → GPU heap |
| (root) | `@shrub _field_NAME` | Synthetic shrub holding field state (source positions, strengths) |
| `:evolution` | Additional textures + dispatches | Velocity field, pressure field, diffusion passes |

### 2.3 Synthetic Shrub

Every `@field` emits a synthetic `@shrub _field_NAME` with:

```rex
;; Synthetic — emitted by _compileFields:
@shrub _field_layout
  ;; Per-source slots (one per @source child):
  @slot source_0_pos_x :type number :default 100
  @slot source_0_pos_y :type number :default 200
  @slot source_0_strength :type number :default 1.0
  @slot source_0_radius :type number :default 80
  @slot source_1_pos_x :type number       ;; cursor — dynamic, no default
  @slot source_1_pos_y :type number
  @slot source_1_strength :type number

  ;; Field-level state:
  @slot source_count :type number :default 2
  @slot evolution_step :type number :default 0
```

Dynamic source parameters (expressions in `:pos`, `:strength`, `:radius`) become derives on this shrub:

```rex
;; Synthetic derives for expression-valued source params:
@derive :shrub _field_layout :slot source_1_pos_x
  (mouse-x)

@derive :shrub _field_layout :slot source_1_pos_y
  (mouse-y)

@derive :shrub _field_layout :slot source_1_strength
  (pointer-pressure)
```

Channel bridges push these slots to the GPU heap:

```rex
;; Synthetic channels:
@channel :from _field_layout/source_1_pos_x :to _field_layout_heap/source_1_pos_x :mode every-frame
@channel :from _field_layout/source_1_pos_y :to _field_layout_heap/source_1_pos_y :mode every-frame
@channel :from _field_layout/source_1_strength :to _field_layout_heap/source_1_strength :mode every-frame
```

This reuses the existing channel bridge infrastructure (`rex-behaviour.js:387` `_compileChannels`, `rex-behaviour.js:828` `_pushChannels`). No new data path.

### 2.4 Source Parameters

Each `@source` compiles to a struct in the GPU heap, following the same pattern as `_compileStructs` (`rex-gpu.js:760`):

```wgsl
struct FieldSource {
  pos: vec2f,
  strength: f32,
  radius: f32,         // or sigma for gaussian
  falloff_type: u32,   // 0=inverse-square, 1=gaussian, 2=exponential, 3=linear
  _pad: u32,
}
```

Sources are packed contiguously in a storage buffer (`rex-gpu.js:1518` `_compileStorageBuffers`). The eval shader receives `source_count: u32` as a uniform and iterates.

### 2.5 Synthetic Node Format

All synthetic nodes follow the established pattern from `_compileFilters` (`rex-gpu.js:1028-1047`):

```javascript
tree.children.push({
  type: 'texture',
  name: '_field_layout_grid',
  attrs: {
    width: 512, height: 512,
    format: 'r32float',
    storage: true,
  },
  children: [],
  content: null,
  _d: 1,  // synthetic depth marker (1 = top-level, 2 = nested)
});
```

The `_d: 1` marker identifies synthetic nodes. Downstream compile phases (`_compileTextures` at `rex-gpu.js:1545`, `_compileShaders` at `rex-gpu.js:1352`, etc.) process them identically to hand-written nodes.

---

## 3. Field Evaluation Compute Shader

### 3.1 Generated WGSL

The eval shader is generated per `@field` node based on its `@source` children and `:composition` mode. For the example in §2.1:

```wgsl
struct FieldConfig {
  resolution: vec2u,
  source_count: u32,
  blend_k: f32,
  border_type: u32,     // 0=constant, 1=repeat, 2=streak
  border_value: f32,
  _pad: vec2u,
}

struct FieldSource {
  pos: vec2f,
  strength: f32,
  radius: f32,
  falloff_type: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> config: FieldConfig;
@group(0) @binding(1) var<storage, read> sources: array<FieldSource>;
@group(0) @binding(2) var output: texture_storage_2d<r32float, write>;

fn eval_source(pixel: vec2f, src: FieldSource) -> f32 {
  let d = distance(pixel, src.pos);
  switch src.falloff_type {
    case 0u: {  // inverse-square
      return src.strength / (d * d + 0.001);
    }
    case 1u: {  // gaussian
      return src.strength * exp(-(d * d) / (2.0 * src.radius * src.radius));
    }
    case 2u: {  // exponential
      return src.strength * exp(-d / max(src.radius, 0.001));
    }
    case 3u: {  // linear
      return src.strength * max(0.0, 1.0 - d / max(src.radius, 0.001));
    }
    default: {
      return 0.0;
    }
  }
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0);
  return min(a, b) - h * h / (4.0 * k);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= config.resolution.x || gid.y >= config.resolution.y) { return; }
  let pixel = vec2f(f32(gid.x), f32(gid.y));

  var field_val = 0.0;
  for (var i = 0u; i < config.source_count; i++) {
    let contribution = eval_source(pixel, sources[i]);
    // Composition: smooth-min (field sources merge smoothly)
    field_val = smin(field_val - 1.0, -contribution, config.blend_k) * -1.0;
    // Note: smin on negated values gives smooth union of positive contributions
  }

  textureStore(output, vec2i(gid.xy), vec4f(field_val, 0.0, 0.0, 0.0));
}
```

### 3.2 Composition Modes

| `:composition` | WGSL Operation | Behavior |
|---|---|---|
| `smooth-min` | `smin(a, b, k)` | Sources merge smoothly at proximity (metaball-like) |
| `additive` | `a + b` | Sources stack linearly (heat map) |
| `max` | `max(a, b)` | Hard union (CSG) |
| `min` | `min(a, b)` | Hard intersection |
| `blend` | `mix(a, b, 0.5)` | Equal blend (averaging) |
| `poisson` | Laplace solve `Δu = 0` | Smooth interpolation with sparse boundary conditions (see §4.4) |

Default is `smooth-min` — the core operation for field-based layout. The `:blend-k` parameter controls the merge radius.

### 3.3 Border Handling

Following Houdini's Scalar Field DOP border model:

| `:border` | Behavior |
|---|---|
| `constant` | Returns `:border-value` outside grid (default 0.0) |
| `repeat` | Wraps field values (tiling) |
| `streak` | Returns nearest edge value (clamp-to-edge) |

---

## 4. Field Composition Algebra

### 4.1 SDF Primitives

Field sources define positive contributions. For layout, you also need negative space (gaps, margins, exclusion zones). The composition algebra supports CSG operations on field values:

```rex
@field ui-layout
  :composition smooth-min
  :blend-k 0.2

  ;; Positive: panels that attract content
  @source sidebar
    :pos (0 0)
    :strength 1.0
    :falloff gaussian
    :sigma 100

  ;; Negative: exclusion zone between panels
  @source gap
    :pos (250 0)
    :strength -0.5
    :falloff linear
    :radius 20
```

Negative strength creates repulsion. The smooth-min composition handles the interaction — positive sources attract, negative sources repel, the equilibrium IS the layout.

### 4.2 Algebraic Properties

| Property | Status | Implication |
|---|---|---|
| Commutative | `smin(a,b) = smin(b,a)` | Source order doesn't matter |
| Associative | Approximate | `smin(smin(a,b),c) ≈ smin(a,smin(b,c))` — close enough for UI |
| Identity | `smin(a, ∞) = a` | Absent sources don't affect field |
| Continuity | C¹ continuous | No gradient discontinuities at boundaries |

### 4.3 Gradient Computation

The field gradient `∇φ` is computed via central differences on the field texture:

```wgsl
fn field_gradient(coord: vec2i) -> vec2f {
  let dx = textureLoad(field_grid, coord + vec2i(1, 0), 0).r
         - textureLoad(field_grid, coord - vec2i(1, 0), 0).r;
  let dy = textureLoad(field_grid, coord + vec2i(0, 1), 0).r
         - textureLoad(field_grid, coord - vec2i(0, 1), 0).r;
  return vec2f(dx, dy) * 0.5;
}
```

The gradient serves three purposes:
1. **Rendering**: surface normals for refraction/Fresnel effects
2. **Interaction**: flow direction for focus navigation
3. **Accessibility**: steepest-descent paths → tab order

### 4.4 Poisson Composition (Soft Flexbox)

When `:composition poisson` is set, sources act as boundary conditions for a Laplace solve `Δu = 0` instead of contributing via smooth-min. The result is the smoothest possible field consistent with the given constraints — "soft flexbox."

```rex
@field soft-layout
  :composition poisson
  :poisson-iterations 30

  @source sidebar
    :pos (0 0)
    :strength 1.0        ;; boundary value at this position
    :radius 300           ;; boundary extent

  @source content
    :pos (300 0)
    :strength 0.5
    :radius 500
```

The Poisson composition produces C² continuous fields (infinitely smooth). The transition between "sidebar visible" and "sidebar hidden" is not a breakpoint snap but a smooth evolution of the Laplace solution as boundary values change. Implementation uses Jacobi iteration — the same infrastructure as stable fluids pressure solve:

```wgsl
@compute @workgroup_size(16, 16)
fn jacobi_step(@builtin(global_invocation_id) gid: vec3u) {
  if (is_boundary(gid.xy)) { return; }  // fixed constraints
  let sum = textureLoad(field, gid.xy + vec2i(1,0), 0).r
          + textureLoad(field, gid.xy - vec2i(1,0), 0).r
          + textureLoad(field, gid.xy + vec2i(0,1), 0).r
          + textureLoad(field, gid.xy - vec2i(0,1), 0).r;
  textureStore(field, vec2i(gid.xy), vec4f(sum * 0.25, 0, 0, 0));
}
```

20-40 iterations per frame. Converges fast for UI-scale grids (256×256 to 512×512). The eval shader runs the Jacobi loop inline instead of the source iteration + smooth-min composition used by other modes.

### 4.5 Jump Flooding (Field Bootstrap from Geometry)

When transitioning from Rex's existing surface elements (`@rect`, `@panel`, `@text` at `rex-surface.js:694-784`) to field layout, you need to convert rasterized geometry into an SDF. The Jump Flooding Algorithm (JFA) does this in O(log₂N) compute passes:

```rex
@source existing-ui
  :type sdf-bootstrap           ;; special: JFA from surface elements
  :surface-elements [sidebar, header, content]
```

When `:type sdf-bootstrap` is specified, the sugar expansion emits:

1. **Seed pass**: Render referenced surface elements to a seed texture (1 = boundary, 0 = empty)
2. **JFA passes**: log₂(resolution) compute dispatches, each checking 8 neighbors at halving step size
3. **SDF texture**: Distance to nearest boundary, usable as a field source

```wgsl
@compute @workgroup_size(16, 16)
fn jfa_step(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2f(gid.xy);
  var best_seed = textureLoad(seed_tex, vec2i(gid.xy), 0).xy;
  var best_dist = distance(pos, best_seed);

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let neighbor = vec2i(gid.xy) + vec2i(dx, dy) * step_size;
      let seed = textureLoad(seed_tex, neighbor, 0).xy;
      let d = distance(pos, seed);
      if (d < best_dist) {
        best_dist = d;
        best_seed = seed;
      }
    }
  }

  textureStore(seed_tex, vec2i(gid.xy), vec4f(best_seed, 0, 0));
  textureStore(sdf_tex, vec2i(gid.xy), vec4f(best_dist, 0, 0, 0));
}
```

This enables incremental migration — existing `@panel`-based layouts can be bootstrapped into field sources without rewriting. The JFA runs once at compile time (or on first frame), then the SDF texture is used as a static field source.

---

## 5. Field Dynamics (Evolution)

### 5.1 Evolution Modes

Optional per-frame evolution step. When `:evolution` is set, additional compute passes run before the visualization pass.

| Mode | Algorithm | Dispatches | Use Case |
|---|---|---|---|
| `none` | Static evaluation only | 0 extra | Pure layout, no animation |
| `stable-fluids` | Stam 1999 (advect → diffuse → project) | 3-4 extra | Fluid motion, drag interaction |
| `force-directed` | Coulomb + springs + Verlet | 1 extra | D3-style equilibrium layout |
| `position-based` | PBD constraint projection | 1 extra | Direct layout, unconditionally stable |
| `gray-scott` | Reaction-diffusion | 1 extra | Turing patterns, organic texture |
| `diffuse-to-target` | Target attraction + diffusion | 1 extra | Morphing text, settle-to-shape |

### 5.2 Stable Fluids

When `:evolution stable-fluids` is set, the sugar expansion emits additional textures and dispatches:

```
@texture _field_NAME_velocity   (rg32float, resolution×resolution)
@texture _field_NAME_pressure   (r32float, resolution×resolution)
@texture _field_NAME_divergence (r32float, resolution×resolution)

@dispatch _field_NAME_advect    — advect velocity field backward
@dispatch _field_NAME_diffuse   — viscous diffusion (Jacobi iteration, N steps)
@dispatch _field_NAME_project   — pressure solve (Jacobi iteration, 20 steps)
@dispatch _field_NAME_apply     — subtract pressure gradient from velocity
```

Additional attributes:

```rex
@field fluid-layout
  :evolution stable-fluids
  :viscosity 0.1
  :dt 0.016                    ;; timestep (1/60)
  :diffuse-iterations 10
  :pressure-iterations 20
```

Mouse drag injects velocity at the cursor position via channel bridge, using the existing input system (`rex-gpu.js:3714` `setChannelValue`):

```rex
;; Synthetic — emitted by _compileFields for stable-fluids:
@channel :from _input/mouse-dx :to _field_fluid_velocity/inject_vx :mode every-frame
@channel :from _input/mouse-dy :to _field_fluid_velocity/inject_vy :mode every-frame
```

### 5.3 Force-Directed

When `:evolution force-directed`, sources are treated as particles with:
- **Coulomb repulsion**: `F = k / r²` between all source pairs
- **Spring attraction**: `F = -k * (r - rest_length)` between connected sources
- **Velocity Verlet integration**: unconditionally stable

```rex
@field spring-layout
  :evolution force-directed
  :repulsion 1000.0
  :damping 0.95
  :rest-length 100.0

  @source a :pos (100 100) :strength 1.0 :connect [b c]
  @source b :pos (300 100) :strength 1.0 :connect [a]
  @source c :pos (200 300) :strength 1.0 :connect [a]
```

The `:connect` attribute declares spring edges. The force-directed pass updates source positions in a storage buffer, which feeds back to the eval shader. Source positions are read back to the behaviour shrub via `@readback` (`rex-gpu.js:612`), keeping the synthetic shrub (`@shrub _field_spring`) in sync.

### 5.4 Position-Based Dynamics

When `:evolution position-based`, sources use Position-Based Dynamics (Müller et al.) instead of force integration. PBD directly manipulates positions via constraint projection — no force → acceleration → velocity → position chain. Unconditionally stable regardless of timestep.

```rex
@field pbd-layout
  :evolution position-based
  :iterations 4                ;; constraint solve iterations per frame
  :damping 0.98

  @source a :pos (100 200) :strength 1.0 :constraint [min-dist b 80]
  @source b :pos (300 200) :strength 1.0 :constraint [min-dist a 80, max-dist a 300]
  @source c :pos (200 100) :strength 1.0 :constraint [fixed-y 100]
```

The `:constraint` attribute declares per-source constraints:

| Constraint | Behavior |
|---|---|
| `min-dist TARGET DIST` | Maintain minimum distance from target source |
| `max-dist TARGET DIST` | Maintain maximum distance from target source |
| `fixed-x VALUE` | Lock X coordinate |
| `fixed-y VALUE` | Lock Y coordinate |
| `bounds X Y W H` | Keep source within rectangle |

PBD loop per frame:

```
1. Predict: p_new = p + v * dt
2. For each iteration:
   For each constraint: project p_new to satisfy
3. Update: v = (p_new - p_old) / dt * damping
4. Write updated positions to source buffer
```

PBD is better than force-based for UI layout because it converges faster (fewer iterations to equilibrium), directly satisfies hard constraints (minimum distance = no overlap), and is unconditionally stable (no exploding springs). The trade-off: PBD doesn't conserve energy, so it can't simulate true physics — but UI layout doesn't need energy conservation.

### 5.5 Morphing Text (Diffusion Toward Target)

The "morphing glass text" effect is diffusion toward a target SDF:

```rex
@field text-morph
  :evolution diffuse-to-target
  :diffuse-rate 0.15
  :target-attraction 0.8

  @source glyph-target
    :type sdf-text              ;; special: glyph SDFs from the atlas
    :text "Hello"
    :font-size 48
    :pos (100 200)
```

Evolution equation: `∂φ/∂t = α(φ_target - φ) + β∇²φ`

On keypress: create gaussian blob at cursor, set target = glyph SDF. Field settles into letterform over ~200ms. Glass shader evaluates `∇φ` for Fresnel refraction during evolution. No keyframe animation — just field dynamics.

The SDF text source type reuses the existing glyph atlas from the surface transducer's SDF pipeline (`rex-surface.js:1536` `_buildGlyphAtlas`, `rex-surface.js:1645` `_generateESDT`). The sugar expansion reads the atlas texture via `@resources` binding.

---

## 6. Field Visualization Modes

### 6.1 @visualize Node

```rex
@visualize
  :mode isosurface
  :threshold 0.5
  :color-inside #1a1b26ff
  :color-outside #00000000
  :feather 2.0                  ;; anti-aliasing width in pixels
```

### 6.2 Visualization Modes

Each mode generates a different fragment in the viz compute shader:

**Isosurface** — threshold coloring with anti-aliased edge:
```wgsl
let d = textureLoad(field_grid, gid.xy, 0).r;
let edge = smoothstep(threshold - feather, threshold + feather, d);
let color = mix(color_outside, color_inside, edge);
```

**Heatmap** — false color ramp (Houdini infra-red style):
```wgsl
let d = textureLoad(field_grid, gid.xy, 0).r;
let t = clamp((d - range_min) / (range_max - range_min), 0.0, 1.0);
let color = heatmap_ramp(t);  // blue → green → yellow → red
```

**Gradient** — visualize ∇φ as color direction:
```wgsl
let grad = field_gradient(vec2i(gid.xy));
let angle = atan2(grad.y, grad.x);
let mag = length(grad);
let color = vec4f(cos(angle)*0.5+0.5, sin(angle)*0.5+0.5, mag, 1.0);
```

**Contour** — iso-lines at regular intervals:
```wgsl
let d = textureLoad(field_grid, gid.xy, 0).r;
let contour = fract(d * contour_density);
let line = smoothstep(0.02, 0.0, abs(contour - 0.5));
let color = mix(bg_color, line_color, line);
```

**Refraction / Glass** — Fresnel on field gradient:
```wgsl
let grad = field_gradient(vec2i(gid.xy));
let normal = normalize(grad);
let view_dot = abs(dot(normal, vec2f(0.0, 1.0)));
let fresnel = pow(1.0 - view_dot, 3.0);
let refract_uv = vec2f(gid.xy) + normal * refract_strength;
let bg = textureSample(background_tex, bg_sampler, refract_uv / resolution);
let color = mix(bg, glow_color, fresnel);
```

**Dot Grid** — discretized field visualization:
```wgsl
let grid_pos = vec2f(f32(gid.x), f32(gid.y));
let cell = floor(grid_pos / grid_spacing);
let center = (cell + 0.5) * grid_spacing;
let field_val = textureLoad(field_grid, vec2i(center), 0).r;
let grad = field_gradient(vec2i(center));
let displaced = center + grad * field_val * response;
let dist_to_dot = distance(grid_pos, displaced);
let dot_radius = base_radius * (1.0 + field_val * scale);
let alpha = smoothstep(dot_radius, dot_radius - 1.0, dist_to_dot);
```

### 6.3 Multiple Visualizations

One field, many views (Houdini principle):

```rex
@field physics-sim
  :resolution 256 256
  :evolution stable-fluids
  @source ...

  @visualize :name density-view
    :mode heatmap
    :range 0.0 2.0

  @visualize :name flow-view
    :mode gradient

  @visualize :name boundary-view
    :mode contour
    :density 5.0
```

Each `@visualize` emits a separate viz dispatch + output texture. All read the same field grid. The user selects which view to composite via the surface integration layer (§7).

---

## 7. Surface Pipeline Integration

### 7.1 The Compositing Problem

The Rex rendering pipeline has three texture producers:
1. **Surface transducer** → `surface_out` (rgba8unorm, Vello-style rasterizer at `rex-surface.js:2449`)
2. **GPU transducer** → 3D render passes, compute effects
3. **Field system** → `_field_NAME_out` (rgba8unorm, per-visualization)

These must composite into a single canvas output. v1 left this unspecified. v2 defines the integration.

### 7.2 Field as Additional Texture Source

Field output textures are standard GPU textures. They participate in the existing composite pass (`rex-surface.js:294-310`):

```wgsl
// Extended composite shader — surface + field layers:
@group(0) @binding(0) var surface_tex: texture_2d<f32>;
@group(0) @binding(1) var field_tex: texture_2d<f32>;    // NEW: field viz output
@group(0) @binding(2) var samp: sampler;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let surface = textureSample(surface_tex, samp, uv);
  let field = textureSample(field_tex, samp, uv);

  // Premultiplied alpha composite: field UNDER surface
  // (Surface UI elements render on top of field backgrounds)
  let result = surface + field * (1.0 - surface.a);
  return result;
}
```

### 7.3 Composite Order

```
┌─────────────────────────────────────────────────┐
│ TOP LAYER (closest to viewer)                    │
│                                                  │
│  DOM: <gpu-anchor> overlays, popovers           │
│  ─────────────────────────────────────           │
│  Surface: text (SDF quads, rex-surface.js:2481) │
│  ─────────────────────────────────────           │
│  Surface: 2D paths (Vello fine pass)            │
│  ─────────────────────────────────────           │
│  Field: visualization output textures           │
│  ─────────────────────────────────────           │
│  GPU: 3D scene / compute effects                │
│                                                  │
│ BOTTOM LAYER (furthest from viewer)             │
└─────────────────────────────────────────────────┘
```

The surface composite pass (`rex-surface.js:2505-2507`) is extended to accept field textures as additional bind group entries. Multiple field visualizations are composited in declaration order.

### 7.4 Field Texture Registration

Field output textures register themselves in the same `_textures` Map (`rex-gpu.js:1545`) that all GPU textures use:

```javascript
// During _compileFields:
tree.children.push({
  type: 'texture',
  name: `_field_${fieldName}_out_${vizName}`,
  attrs: {
    width: resX, height: resY,
    format: 'rgba8unorm',
    storage: true,
    // Tag for surface compositor:
    _fieldViz: true,
    _fieldOrder: vizIndex,
  },
  children: [], content: null, _d: 1,
});
```

The surface transducer's `compile()` method (`rex-surface.js:515`) collects tagged field viz textures and binds them for the composite pass.

### 7.5 Filter Chaining

Field output textures can feed into the existing `@filter` system (`rex-gpu.js:885`). A blur applied to a field visualization:

```rex
@field layout
  @visualize :name raw :out field-raw
    :mode isosurface

@filter blur :src field-raw :amount 4.0
```

The `:out` attribute on `@visualize` names the output texture. The `:src` attribute on `@filter` references it — same chaining pattern as filter-to-filter (`:out` → `:src`).

---

## 8. DOM Anchor Layer

### 8.1 The Proxy Ghost Ship Applied

```
PROXY (shrub)          GHOST (GPU)           BRIDGE (DOM anchor)
─────────────          ──────────            ──────────────────
@shrub nav-state       @field layout         @anchor nav-links
  @slot pos-x            @source nav           <gpu-anchor>
  @slot pos-y            @visualize              <span>Home</span>
  @slot visible                                  <span>About</span>
  @slot selected                                 <a href="...">
                                               </gpu-anchor>
```

The shrub holds truth. The field renders it. The anchor bridges it to the browser.

### 8.2 @anchor Node

```rex
@field layout-field
  :resolution 512 512
  @source nav-panel
    :pos (50 50)
    :strength 1.0

  @anchor nav-links
    :source nav-panel             ;; tracks this field source
    :offset (10 60)               ;; offset from source position
    :size (180 340)               ;; DOM element size
    :role navigation              ;; ARIA landmark role
    :guard (gt /nav-panel/strength 0.1)  ;; only when source is visible

    @text "Home" :selectable true :role link :action go-home
    @text "About" :selectable true :role link :action go-about
    @link "https://docs.example.com" :label "Docs"
```

### 8.3 @anchor Expansion

`@anchor` is sugar. During `_compileFields`, each `@anchor` emits:

**1. DOM element** (fiber-managed via `rexUseResource` at `rex-fiber.js:142`):
```javascript
// Anchor fiber — runs inside field fiber host
function anchorFiber(fieldName, sourceName, anchorConfig) {
  const el = rexUseResource((dispose) => {
    const anchor = document.createElement('gpu-anchor');
    anchor.setAttribute('data-field', fieldName);
    anchor.setAttribute('data-source', sourceName);
    anchor.style.cssText = 'position:absolute;pointer-events:none;';
    anchorContainer.appendChild(anchor);
    dispose(() => anchor.remove());
    return anchor;
  }, [fieldName, sourceName]);

  // ... children, a11y, position sync
}
```

**2. Keyed child reconciliation** (via `rexKeyed` at `rex-fiber.js:212`):
```javascript
// Each anchor is a keyed child fiber of the field fiber:
for (const anchor of anchors) {
  rexKeyed(anchorFiber, `anchor-${anchor.name}`,
           fieldName, anchor.source, anchor.config);
}
```

This ensures anchor DOM elements survive recompile when only their position changes — `rexKeyed` matches by key and reuses the existing fiber (and its DOM resource).

**3. Accessibility shadow** (inside the anchor):
```html
<gpu-anchor data-field="layout-field" data-source="nav-panel"
            style="position:absolute; left:60px; top:110px; width:180px; height:340px;">
  <nav role="navigation" aria-label="Main navigation">
    <span role="link" tabindex="0" aria-label="Home"
          style="user-select:text; color:transparent;">Home</span>
    <span role="link" tabindex="0" aria-label="About"
          style="user-select:text; color:transparent;">About</span>
    <a href="https://docs.example.com" tabindex="0"
       style="color:transparent;">Docs</a>
  </nav>
</gpu-anchor>
```

**4. Position sync derives** (on the synthetic field shrub):
```rex
;; Synthetic — emitted by _compileFields:
@derive :shrub _field_layout :slot anchor_nav_x
  (add /nav-panel/pos-x 10)    ;; source pos + offset

@derive :shrub _field_layout :slot anchor_nav_y
  (add /nav-panel/pos-y 60)
```

Per frame, the anchor fiber reads these derived positions and sets:
```javascript
anchor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
```

Using `translate3d` ensures GPU-composited transform — no layout reflow.

**5. Guard-controlled visibility**:
```javascript
// Per frame, evaluate guard expression via Rex.evalExpr (same as behaviour guards):
const visible = Rex.evalExpr(anchor.guard, evalCtx);
anchor.style.display = visible ? '' : 'none';
// Also toggle ARIA: aria-hidden on the accessibility shadow
anchor.setAttribute('aria-hidden', visible ? 'false' : 'true');
```

### 8.4 @anchor Children

| Child Type | DOM Output | GPU Output |
|---|---|---|
| `@text :selectable true` | `<span>` with `user-select:text; color:transparent` | SDF text quad (visible, `rex-surface.js:728`) |
| `@text :selectable false` | `<span aria-label="...">` (no text content) | SDF text quad |
| `@link` | `<a href="..." tabindex="0">` | SDF text quad with underline |
| `@input` | Real `<input>` or `<textarea>` via form transducer (`rex-form.js:99`) | Cursor rect in field |
| `@button` | `<button aria-label="...">` | Isosurface region |

The dual output — invisible DOM for platform + visible GPU for rendering — is the Flutter pattern, applied per-anchor instead of per-widget.

### 8.5 `<gpu-anchor>` Web Component

```javascript
class GpuAnchor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: absolute;
          pointer-events: none;
          contain: layout style;
        }
        ::slotted(*) { pointer-events: auto; }
        ::slotted([data-selectable]) { user-select: text; color: transparent; }
      </style>
      <slot></slot>
    `;
  }

  updateBounds(x, y, w, h) {
    this.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.style.width = `${w}px`;
    this.style.height = `${h}px`;
  }
}
customElements.define('gpu-anchor', GpuAnchor);
```

Shadow DOM provides style encapsulation — GPU overlay CSS can't be broken by user styles. `contain: layout style` prevents anchor changes from triggering parent reflows.

---

## 9. Text Selection + Clipboard

### 9.1 The Trick

The browser owns the Selection API and the clipboard. You don't fight this — you exploit it.

Every `@text :selectable true` inside an `@anchor` emits an invisible `<span>` with the same text content. The span is `color: transparent` but `user-select: text`. When the user selects, the browser's native Selection API works on the invisible text. The visual highlight is rendered GPU-side.

### 9.2 Selection Flow

```
User drags across GPU-rendered "Hello World" text
  ↓
Browser Selection API selects text in invisible <span> inside <gpu-anchor>
  ↓
selectionchange event fires
  ↓
Rex reads window.getSelection().getRangeAt(0)
  ↓
Maps DOM range → glyph indices (spans have data-glyph-start/end)
  ↓
Pushes to behaviour: behaviour._setSlot(shrub, '_sel_start', 0);
                     behaviour._setSlot(shrub, '_sel_end', 11)
  ↓
Channel bridge → GPU heap → highlight rect source activates in field
  ↓
Field evaluator renders highlight behind selected glyphs
  ↓
User presses Cmd+C → browser clipboard gets text from invisible <span> (native, zero code)
```

### 9.3 Selection Rendering

The selection highlight is a field source with position/size derived from the selection range:

```rex
;; Synthetic — emitted when @text :selectable true exists inside @anchor:
@source _sel_highlight
  :pos (sel-x sel-y)
  :strength (if (gt /sel-end /sel-start) 0.8 0.0)   ;; visible only when selection active
  :falloff linear
  :radius-x (sel-width)
  :radius-y (line-height)
  :color #3390ff44
```

### 9.4 CSS Custom Highlight API

For more precise selection rendering, use the CSS Custom Highlight API (Chrome 105+, Firefox 132+):

```javascript
const range = new Range();
range.setStart(spanNode, startOffset);
range.setEnd(spanNode, endOffset);
const highlight = new Highlight(range);
CSS.highlights.set('field-selection', highlight);
```

```css
::highlight(field-selection) {
  background-color: transparent;  /* Don't show DOM highlight */
}
```

The DOM highlight is suppressed — the GPU renders the visual highlight as a field source. But the Selection API range is real, so copy/paste works natively.

---

## 10. EditContext Integration

### 10.1 Relationship to Existing Text Editor

The surface transducer already has a GPU-native text editor (`rex-surface.js:1245` `_collectTextEditor`). This handles:
- Multiline editing with cursor tracking
- Line numbers gutter (`rex-surface.js:1314`)
- Scroll-y management (`rex-surface.js:1319`)
- Keyboard input (`rex-surface.js:2600` `handleEditorKey`)
- Click-to-cursor (`rex-surface.js:2544` `handleEditorClick`)

EditContext extends this by providing browser-native IME support and proper input method handling. The GPU text editor remains the visual renderer; EditContext replaces the hidden textarea approach for text input.

### 10.2 EditContext as Fiber Resource

```javascript
// In anchor fiber, when @text-editor exists inside @anchor:
function editorAnchorFiber(editorId, editorConfig) {
  const editCtx = rexUseResource((dispose) => {
    const ctx = new EditContext({ text: initialContent });
    canvas.editContext = ctx;

    ctx.addEventListener('textupdate', (e) => {
      behaviour._setSlot(editorShrub, 'content',
        ctx.text.substring(0, e.updateRangeStart) + e.text +
        ctx.text.substring(e.updateRangeEnd));
      behaviour._setSlot(editorShrub, 'cursor', e.selectionStart);
    });

    ctx.addEventListener('characterboundsupdate', (e) => {
      // Get glyph bounds from surface transducer's metrics cache
      const bounds = surface.getGlyphBounds(editorId, e.rangeStart, e.rangeEnd);
      ctx.updateCharacterBounds(e.rangeStart, bounds);
    });

    dispose(() => { canvas.editContext = null; });
    return ctx;
  }, [editorId]);

  // Sync content changes back to GPU text editor
  rexUseResource((dispose) => {
    const unsub = behaviour.onSlotChange(editorShrub, 'content', (val) => {
      surface._editors.get(editorId).content = val;
      surface._editorDirty = true;
    });
    dispose(unsub);
  }, [editorId]);
}
```

### 10.3 Fallback: Hidden Textarea

For Firefox and Safari (no EditContext support — see Appendix B):

```javascript
const textarea = rexUseResource((dispose) => {
  const el = document.createElement('textarea');
  el.style.cssText = 'position:absolute;width:0;height:0;opacity:0;overflow:hidden;';
  el.setAttribute('aria-label', editorLabel);
  anchorContainer.appendChild(el);

  el.addEventListener('input', () => {
    behaviour._setSlot(editorShrub, 'content', el.value);
  });

  dispose(() => el.remove());
  return el;
}, [editorId]);
```

### 10.4 IME Composition

EditContext's critical advantage: you can update the GPU-rendered text during active IME composition without canceling the composition. The hidden textarea approach freezes visual updates during composition.

For CJK input, `updateCharacterBounds` tells the OS where each character is rendered (from the surface transducer's glyph layout data at `rex-surface.js:1516` `_getGlyphMetrics`), so the IME candidate window appears in the correct position relative to the GPU-rendered text.

---

## 11. Accessibility Shadow DOM

### 11.1 Compile-Time Generation

During `_compileFields`, the sugar expansion generates an accessibility overlay container:

```html
<div id="rex-a11y" aria-hidden="false"
     style="position:absolute;inset:0;pointer-events:none;opacity:0;z-index:1;">
  <!-- Generated from @anchor nodes via fiber lifecycle -->
</div>
```

Each `@anchor` with a `:role` attribute contributes semantic elements:

| @anchor `:role` | Generated HTML | ARIA |
|---|---|---|
| `navigation` | `<nav>` | `role="navigation"` |
| `button` | `<button>` | `role="button"`, click → `behaviour.fireTalk()` (`rex-behaviour.js:70`) |
| `textbox` | `<input>` or EditContext | `role="textbox"` |
| `region` | `<section>` | `role="region"`, `aria-label` |
| `heading` | `<hN>` | `role="heading"`, `aria-level` |
| `list` | `<ul>` | `role="list"` |

### 11.2 Position Sync

Accessibility elements are positioned to match field source locations. Per-frame update inside the anchor fiber:

```javascript
// Inside anchorFiber, after rexUseResource for DOM element:
const x = behaviour.getSlotValue('_field_layout', 'anchor_nav_x');
const y = behaviour.getSlotValue('_field_layout', 'anchor_nav_y');
el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
```

### 11.3 Tab Order from Field Gradient

The field gradient provides a natural navigation order. Steepest-descent paths from any point converge on field minima (interactive elements). Tab order follows these flow lines:

```javascript
function computeTabOrder(anchors, fieldGrid) {
  // Sample field value at each anchor's position
  const scored = anchors.map(a => ({
    anchor: a,
    fieldValue: sampleField(fieldGrid, a.x, a.y),
    gradMagnitude: sampleGradient(fieldGrid, a.x, a.y),
  }));

  // Sort by field value descending (strongest field = first tab stop)
  // Break ties by spatial locality (Hilbert curve index)
  scored.sort((a, b) => {
    const diff = b.fieldValue - a.fieldValue;
    if (Math.abs(diff) > 0.01) return diff;
    return hilbertIndex(a.anchor.x, a.anchor.y) - hilbertIndex(b.anchor.x, b.anchor.y);
  });

  scored.forEach((s, i) => {
    s.anchor.a11yElement.tabIndex = i + 1;
  });
}
```

Or simpler: use source order in the `.rex` file as tab order, let the user override with `:tabindex`.

### 11.4 ariaNotify for Dynamic Content

When field state changes cause visible updates (element appears, value changes), use `ariaNotify()`:

```javascript
if (typeof document.ariaNotify === 'function') {
  document.ariaNotify(`Panel ${name} ${visible ? 'appeared' : 'disappeared'}`, {
    priority: 'none',
    interrupt: 'none',
  });
} else {
  // Fallback: aria-live region
  a11yLive.textContent = `Panel ${name} ${visible ? 'appeared' : 'disappeared'}`;
}
```

### 11.5 Haptic Field Extensions

The field gradient contains information that maps directly to haptic feedback on devices that support it (game controllers, Apple Taptic Engine, Android haptic actuators):

| Field Property | Haptic Mapping | User Experience |
|---|---|---|
| Gradient magnitude `‖∇φ‖` | Vibration intensity | "Feel" the boundary of a UI element |
| Gradient direction `∇φ/‖∇φ‖` | Directional pulse | Guided toward interactive elements |
| Field curvature (Laplacian `∇²φ`) | Texture/roughness | Distinguish flat regions from curved transitions |
| Field value `φ(cursor)` | Continuous pressure | Proportional to "how interactive" the region is |
| Rate of change `∂φ/∂t` | Transient buzz | Feedback when crossing evolving boundaries |

Implementation in the anchor fiber:

```javascript
// Haptic feedback driven by field gradient readback:
function hapticFeedback(gradMagnitude) {
  // Vibration API (mobile):
  if (navigator.vibrate && gradMagnitude > 0.3) {
    navigator.vibrate(Math.min(gradMagnitude * 20, 50));  // 0-50ms pulse
  }

  // Gamepad haptic (controllers):
  const gamepads = navigator.getGamepads();
  for (const gp of gamepads) {
    if (gp?.hapticActuators?.length) {
      gp.hapticActuators[0].pulse(gradMagnitude, 16);  // one-frame pulse
    }
  }
}
```

The data is free — field gradient is computed anyway for rendering (refraction normals) and accessibility (tab order). Haptic feedback is a third projection of the same gradient. A field-based UI is the first system where haptic feedback is *mathematically natural* rather than hand-authored per-element.

---

## 12. CSS Anchor Positioning

### 12.1 Tethering Popovers to Field Sources

For tooltips, context menus, and dropdowns that need to float near GPU-rendered content:

```rex
@field layout
  @source submit-btn
    :pos (300 400)
    :strength 1.0
    :role button

  @anchor submit-anchor
    :source submit-btn
    :css-anchor --submit-btn       ;; CSS anchor name
```

This emits:

```html
<gpu-anchor style="anchor-name: --submit-btn; ..."></gpu-anchor>
```

A tooltip or popover tethered to it:

```css
.submit-tooltip {
  position: fixed;
  position-anchor: --submit-btn;
  top: anchor(--submit-btn bottom);
  left: anchor(--submit-btn center);
  position-try-fallbacks: flip-block;
}
```

The browser handles viewport clamping, overflow, and z-ordering. Rex just keeps the anchor div positioned correctly via the fiber-managed `translate3d` updates.

### 12.2 Popover API Integration

```rex
@anchor submit-anchor
  :source submit-btn
  :css-anchor --submit-btn
  :popover confirmation-dialog     ;; tether a popover to this anchor
```

Emits:

```html
<gpu-anchor style="anchor-name: --submit-btn; ..."></gpu-anchor>
<div popover id="confirmation-dialog"
     style="position-anchor: --submit-btn; top: anchor(bottom); left: anchor(left);">
  <p>Are you sure?</p>
  <button>Confirm</button>
  <button>Cancel</button>
</div>
```

The popover is a real DOM element in the top layer. Buttons inside it fire standard click events → `behaviour.fireTalk()` (`rex-behaviour.js:70`).

### 12.3 Browser Support

CSS Anchor Positioning: Chrome/Edge 125+. Fallback for Firefox/Safari: JavaScript-based positioning using `getBoundingClientRect()` on the anchor element, applied per-frame. The anchor fiber encapsulates this:

```javascript
function positionTethered(anchor, tethered) {
  if (CSS.supports('anchor-name', '--test')) return; // native support
  // JS fallback:
  const rect = anchor.getBoundingClientRect();
  tethered.style.position = 'fixed';
  tethered.style.top = `${rect.bottom}px`;
  tethered.style.left = `${rect.left + rect.width / 2}px`;
}
```

---

## 13. Responsive Layout via Field Boundary Conditions

### 13.1 Field Breakpoints

Traditional CSS media queries snap at breakpoints. Field layout transitions continuously — but you can still have discrete layout changes by modifying field source parameters:

```rex
@derive :shrub layout-state :slot sidebar-strength
  (if (gt (canvas-width) 768) 1.0 0.0)

@derive :shrub layout-state :slot content-x
  (if (gt (canvas-width) 768) 250 0)

@field layout
  @source sidebar
    :pos (0 0)
    :strength /sidebar-strength
    :falloff gaussian
    :sigma 100

  @source content
    :pos (/content-x 0)
    :strength 1.0
```

When `canvas-width` crosses 768, `sidebar-strength` goes to 0. The sidebar's field contribution vanishes. The content source shifts left. Because the field evaluator runs per-frame and the channel bridge pushes updated values per-frame, the transition is immediate.

`canvas-width` is resolved via the existing expression eval context's ident handler (`rex-surface.js:633` `_makeSurfaceEvalContext`), which already supports `canvas-width`, `canvas-height`, and `width`/`height` idents.

### 13.2 Continuous Responsive

For truly fluid layout, use expressions with continuous functions:

```rex
@derive :shrub layout-state :slot sidebar-width
  (clamp (sub (canvas-width) 500) 0 300)     ;; 0px at 500px viewport, 300px at 800px+

@field layout
  @source sidebar
    :pos (0 0)
    :strength (smoothstep 0 300 /sidebar-width)
    :radius /sidebar-width
```

The sidebar smoothly grows from 0 to 300px as the viewport expands from 500 to 800px. No breakpoints. The expression stdlib already has `smoothstep`, `clamp`, `mix`, `step` — full list in `rex-parser.js` expression stdlib.

### 13.3 Container Queries via Field Scope

CSS container queries check parent size. Field sources naturally scope to their parent field. A nested `@field` evaluates within the bounds of its parent source:

```rex
@field page-layout
  @source sidebar :pos (0 0) :strength 1.0 :radius 300

  @field sidebar-layout                        ;; nested field
    :resolution 256 128
    :bounds-source sidebar                     ;; scoped to sidebar source bounds
    @source nav :pos (10 10) :strength 1.0
    @source tools :pos (10 200) :strength 1.0
```

When the sidebar shrinks (responsive), the nested field's resolution stays the same but its world-space bounds contract — sources pack tighter, exactly like a container query.

Nested fields expand to separate eval/viz dispatches. The parent's source position is passed as a uniform offset to the nested field's eval shader.

---

## 14. Interaction as Field Sampling

### 14.1 Hit Testing — Merged with Surface Pipeline

Current hit test: GPU readback of element IDs at mouse position → `onHitChange` (`rex-surface.js:2510`). The surface hit test pipeline (`rex-surface.js:264-292`) uses a winding-number algorithm over path segments.

Field hit testing evaluates the field at the pointer to determine which source dominates. Rather than a separate hit test shader, the field hit test is **merged into the existing surface hit test dispatch**:

```wgsl
// Extended hit-test compute shader:
// After testing surface paths, also sample field sources:
fn field_hit_test(mouse: vec2f) -> u32 {
  var best_source = 0xFFFFFFFFu;
  var best_contribution = 0.0;
  for (var i = 0u; i < config.source_count; i++) {
    let c = eval_source(mouse, sources[i]);
    if (c > best_contribution) {
      best_contribution = c;
      best_source = i;
    }
  }
  return best_source;
}
```

**Priority rule**: Surface element hits (path winding > 0) take priority over field hits. Field hit only fires when no surface element is under the cursor. This matches the visual composite order (§7.3) — surface elements render on top of field backgrounds.

The hit result flows through the existing readback path:
```
GPU hit test → _hitResultBuffer → mapAsync → onHitChange → behaviour.fireTalk
```
Pattern: `rex-surface.js:2510-2534`.

### 14.2 Proximity Detection

Unlike rectangle hit-testing, field sampling gives continuous proximity. The field value at the cursor tells you HOW CLOSE you are to an interactive region, not just whether you're inside one:

```rex
@derive :shrub ui-state :slot hover-strength
  (readback /field/layout/_hit_value)         ;; field value at cursor position

@derive :shrub ui-state :slot hover-source
  (readback /field/layout/_hit_source)        ;; which source dominates at cursor

;; Trigger visual feedback when cursor approaches (not just enters) an element:
@dep hover-feedback :path /ui-state/hover-strength
  @guard (gt /hover-strength 0.3)             ;; within influence radius
  @set /hovered-source /hover-source
```

### 14.3 Drag as Field Perturbation

Dragging moves a field source. All other sources respond because the field re-evaluates:

```rex
@source draggable-panel
  :pos (/panel-x /panel-y)                   ;; driven by shrub slots
  :strength 1.0
  :falloff gaussian

@talk :shrub ui-state :name drag-panel
  @input dx :type number
  @input dy :type number
  @inc /panel-x %dx
  @inc /panel-y %dy
```

The `@inc` mutation adds the delta. The channel bridge (`rex-behaviour.js:828` `_pushChannels`) pushes the new position to GPU heap. Next frame, the field evaluator reads the updated position. All other sources' visual output adjusts because the field composition changes. No animation system.

---

## 15. Profunctor Optics for DOM↔GPU Bridge

### 15.1 The Bidirectional Channel

DOM anchoring is a profunctor optic — same algebra as GPU readback (`rex-gpu.js:612`) and agent tool channels (Rex-Agent-Spec §4):

```
Forward optic (shrub → DOM):
  /field/layout/source-a/pos → derive → compiled byte offset → anchor.style.transform
  Optic: Lens(shrub.slots) ▹ Lens(derive) ▹ Iso(px→css) → DOM property

Backward optic (DOM → shrub):
  window.getSelection().range → glyph index mapping → _setSlot(shrub, 'sel-start', N)
  Optic: Result ▸ Iso(range→index) ▸ Lens(shrub.slots)
```

### 15.2 Parallel with Other Optic Channels

| Channel Type | Forward | Backward | Transport |
|---|---|---|---|
| **GPU heap** | shrub slot → heap byte offset (`rex-gpu.js:1432`) | storage buffer → `mapAsync` → slot (`rex-gpu.js:612`) | `DataView.setFloat32` |
| **Agent tool** | shrub slot → JSON param (Rex-Agent-Spec §4) | API result → slot write | HTTP/SSE |
| **DOM anchor** | shrub slot → CSS transform | Selection/input event → slot write | DOM property |
| **Field source** | shrub slot → channel → heap → WGSL uniform | field readback → slot | compute shader |
| **Form widget** | slot → `setExternal` (`rex-form.js:252`) | input event → `onFieldChange` (`main.js:397`) | DOM input value |

All five share:
- Compiled offsets (heap offset / slot path / anchor ID / form field name)
- Dirty tracking (dirty range / derive flag / DOM mutation observer / form state diff)
- Forward/backward separation (write path / read path)

### 15.3 Channel Declaration

```rex
;; Forward: shrub → DOM
@channel :from layout-state/panel-x :to _anchor/nav/x :mode every-frame

;; Backward: DOM → shrub
@channel :from _anchor/nav/selection :to layout-state/sel-range :mode on-change
```

The `_anchor/` namespace is synthetic — the sugar expansion generates the forward channels automatically from `@anchor :source` declarations, and the backward channels from `@text :selectable true` children.

---

## 16. Fiber Lifecycle for DOM Resources

### 16.1 Resources That Must Survive Recompile

| Resource | Fiber Hook | Dep Array | Why |
|---|---|---|---|
| `<gpu-anchor>` element | `rexUseResource` (`rex-fiber.js:142`) | `[fieldName, sourceName]` | Remove/recreate loses focus, kills selection |
| EditContext instance | `rexUseResource` | `[editorId]` | Recreate kills active IME composition |
| ARIA shadow elements | `rexUseResource` | `[anchorId, role]` | Recreate confuses screen readers |
| CSS anchor registrations | `rexUseResource` | `[anchorName]` | Recreate breaks tethered popovers |
| Selection event listeners | `rexUseResource` | `[textId]` | Recreate drops active selection |
| Popover element | `rexUseResource` | `[popoverId]` | Recreate closes open popover |

### 16.2 Lifecycle Pattern

```javascript
// All DOM resources follow rexUseResource pattern (rex-fiber.js:142):
const resource = rexUseResource((dispose) => {
  const el = createDOMResource(config);
  container.appendChild(el);
  attachEventListeners(el, callbacks);
  dispose(() => {
    removeEventListeners(el, callbacks);
    el.remove();
  });
  return el;
}, [/* deps that trigger recreate */]);
```

When the user edits .rex source:
1. `Rex.parse()` re-parses tree (`main.js:483`)
2. Sugar expansion re-runs `_compileFields()` — inside GPU transducer compile
3. Fiber host `flush()` runs — `rexKeyed` reconciles anchor fibers by key
4. For each anchor fiber, `rexUseResource` checks if deps changed:
   - **Unchanged**: reuse existing DOM element (zero DOM mutation)
   - **Changed** (source renamed, anchor removed): dispose old → create new
5. Position update on next frame via channel bridge (not during compile)

### 16.3 Fiber Host Integration

The field fiber host is a `RexFiberHost` instance (`rex-fiber.js:764`) created in `main.js` scope, alongside the existing frame loop:

```javascript
// In main.js, after behaviour instantiation:
const fieldFiberHost = new RexFiberHost({
  heap: null,  // DOM anchors don't need FiberHeapAllocator
  commandRing: new CommandRing(256),  // profiling
});

// Mount field root fiber:
fieldFiberHost.mount(fieldRootFiber, []);

// In frame loop (main.js:713), after gpu.transduce:
try {
  fieldFiberHost.flush();
} catch (e) {
  log(`field-dom: ${e.message}`, 'err');
}
```

### 16.4 Focus Preservation

When recompile happens while a text input inside an anchor has focus:

```javascript
// Inside anchorFiber, using rexUseState (rex-fiber.js:104):
const [hadFocus, setHadFocus] = rexUseState(false);

// Before potential recreate:
if (document.activeElement === existingInput) setHadFocus(true);

// After recreate:
if (hadFocus && newInput) {
  newInput.focus();
  if (savedSelectionRange) {
    newInput.setSelectionRange(savedSelectionRange.start, savedSelectionRange.end);
  }
  setHadFocus(false);
}
```

The fiber's `rexUseState` hook preserves focus state across recompiles — same pattern as agent fiber preserving turn state.

---

## 17. CommandRing Profiling

### 17.1 Field Operations as Ring Commands

The `CommandRing` (`rex-fiber.js:933`) provides io_uring-style submit/complete profiling. Field operations integrate with it:

| Operation | Ring Type | Metadata |
|---|---|---|
| Field eval dispatch | `'field-eval'` | `{field, sourceCount, resolution}` |
| Field viz dispatch | `'field-viz'` | `{field, vizMode, resolution}` |
| Evolution step | `'field-evolve'` | `{field, evolutionMode, iterations}` |
| DOM anchor sync | `'anchor-sync'` | `{field, anchorCount}` |
| Hit test readback | `'field-hit'` | `{field, sourceHit}` |
| Selection event | `'anchor-select'` | `{anchor, rangeStart, rangeEnd}` |

### 17.2 Usage Pattern

```javascript
// In _compileFields-generated execute code:
const sqeId = commandRing.submit('field-eval', {
  field: fieldName,
  sourceCount: sources.length,
  resolution: [resX, resY],
});

// ... GPU dispatch ...

// On frame completion:
commandRing.complete(sqeId, {
  dispatchTime: performance.now() - startTime,
});
```

### 17.3 Diagnostics

```javascript
// Accessible via window._field:
window._field = {
  commandRing,
  getStats() {
    return {
      fieldsCompiled: fieldCount,
      anchorsActive: anchorCount,
      avgEvalMs: commandRing.avgDuration('field-eval'),
      avgVizMs: commandRing.avgDuration('field-viz'),
    };
  },
};
```

---

## 18. Compilation Model

### 18.1 Compile Order

```
1.   Rex.parse(src)                           — fresh tree
2.   Rex.expandTemplates(tree)                — @use/@template
3.   mediaSugar.expand(tree)                  — @media → synthetic textures (SugarFiber-Spec §2)
4.   expandAgentSugar(tree, log)              — @agent → @shrub (Rex-Agent-Spec §12)
5.   form.transduce(tree)                     — form widgets
6.   behaviour.transduce(tree, true)          — shrubs, derives, talks, channels
7.   gpu.compile(tree):
     7.0   _compileLibs                       — @lib WGSL modules
     7.1   _compileStructs                    — @struct heap layout (rex-gpu.js:760)
     7.1.1 _compileHeap                       — @heap → synthetic structs (rex-gpu.js:2875)
     7.1.5 _compileFields(tree)               — @field → synthetics  ← THIS SPEC
     7.1.5 _compileFilters(tree)              — @filter → synthetics (rex-gpu.js:885)
     7.2   _compileShaders                    — @shader → GPUShaderModule (rex-gpu.js:1352)
     7.3   _compileHeapLayout                 — byte offset assignment (rex-gpu.js:1417)
     7.4   _compileOptics                     — path → offset table (rex-gpu.js:1432)
     7.5   _allocateHeap                      — GPUBuffer creation (rex-gpu.js:1501)
     7.6   _compileStorageBuffers             — @buffer :usage [storage] (rex-gpu.js:1518)
     7.7   _compileTextures                   — @texture → GPUTexture (rex-gpu.js:1545)
     7.8   _compileVertexBuffers              — @vertex-buffer (rex-gpu.js:1784)
     7.8.5 _compileResourceScopes             — @resources → bind groups (rex-gpu.js:1966)
     7.9   _buildPipeline                     — @pipeline (rex-gpu.js:2991)
     7.10  _compileBarrierSchedule            — RAW/WAW/WAR hazards (rex-gpu.js:2343)
     7.11  _compileAliasingPlan               — transient resource aliasing (rex-gpu.js:2411)
     7.12  _compileCommandList                — @pass/@dispatch → commands (rex-gpu.js:2080)
     7.13  _writeDefaults                     — const optic values (rex-gpu.js:2065)
     7.14  _compileReadbacks                  — @readback → staging (rex-gpu.js:612)
8.   gpu._compileDeriveCompute(...)           — classify derives for GPU (rex-behaviour.js:504)
9.   pcn / surface / audio                    — see all synthetic nodes
```

Steps 7.1.5 (`_compileFields`) runs alongside `_compileFilters` at phase 1.5. Both use the same tree mutation pattern — push synthetic nodes to `tree.children`. All downstream phases (7.2–7.14) process synthetic field nodes identically to hand-written nodes.

### 18.2 _compileFields Implementation Outline

```javascript
_compileFields(tree) {
  const fields = Rex.findAll(tree, 'field');
  if (!fields.length) return;

  for (const field of fields) {
    const name = field.name || `field_${fieldIdx++}`;
    const res = this._parseFieldConfig(field);
    const sources = Rex.findAll(field, 'source');
    const vizNodes = Rex.findAll(field, 'visualize');
    const anchors = Rex.findAll(field, 'anchor');

    // 1. Emit source struct definition
    this._emitFieldSourceStruct(tree, name, sources);

    // 2. Emit storage textures (grid r32float + viz rgba8unorm per @visualize)
    this._emitFieldTextures(tree, name, res, vizNodes);

    // 3. Emit source storage buffer (packed FieldSource array)
    this._emitFieldSourceBuffer(tree, name, sources);

    // 4. Emit synthetic shrub with slots for dynamic params
    this._emitFieldShrub(tree, name, sources);

    // 5. Generate eval compute shader from sources + composition mode
    this._emitFieldEvalShader(tree, name, sources, res);

    // 6. If evolution specified, emit evolution passes
    if (res.evolution !== 'none') {
      this._emitEvolutionPasses(tree, name, res);
    }

    // 7. For each @visualize, emit viz shader + pipeline + dispatch
    for (const viz of vizNodes) {
      this._emitFieldVizShader(tree, name, viz, res);
    }

    // 8. Emit channel bridges for dynamic source params
    this._emitFieldChannels(tree, name, sources);

    // 9. Record anchor configs for fiber host (DOM emission deferred to runtime)
    for (const anchor of anchors) {
      this._recordAnchorConfig(name, anchor, sources);
    }
  }

  this.log(`fields: ${fields.length} expanded`, 'ok');
}
```

### 18.3 Incremental Compilation

Field nodes trigger phase 1.5 re-expansion in `_mapChangesToPhases` (`rex-gpu.js:2805`):

```javascript
case 'field': phases.add(1.5); break;    // re-expand field sugar
case 'source': phases.add(1.5); break;   // re-expand if source changed
case 'visualize': phases.add(1.5); break; // re-expand if viz changed
case 'anchor': phases.add(1.5); break;   // re-expand anchor config (DOM via fiber)
```

**Hot-patching**: when only source parameters change (position, strength) but not the field structure, the compile phase skips shader recompilation. Channel bridges push new values to the GPU heap directly — same pattern as `_tryHotPatchFilters` in the filter system.

### 18.4 Registration

```javascript
// In RexGPU constructor:
this.registerCompileType('field', {
  compile: (nodes, tree) => this._compileFields(tree)
});
this.registerCompileType('anchor', { compile: () => {} }); // handled by _compileFields
this.registerCompileType('visualize', { compile: () => {} }); // handled by _compileFields
this.registerCompileType('source', { compile: () => {} }); // handled by _compileFields
```

No `Rex.registerContentType('field')` — fields do NOT have content blocks (`''...''`). They use child nodes and attributes. Content type registration is for nodes that contain inline text (like `@shader`, `@system`, `@task`).

---

## 19. Grammar Extensions

### 19.1 New Node Types

All expand to existing constructs — zero new runtime:

```
field     ::= '@field' NAME? NEWLINE INDENT
                (':resolution' NUMBER NUMBER)?
                (':composition' COMP_MODE)?
                (':blend-k' NUMBER)?
                (':evolution' EVOL_MODE)?
                (':border' BORDER_TYPE)?
                (':border-value' NUMBER)?
                source* visualize* anchor*
              DEDENT

source    ::= '@source' NAME NEWLINE INDENT
                ':pos' EXPR
                ':strength' EXPR
                ':falloff' FALLOFF_TYPE
                (':radius' EXPR)?
                (':sigma' EXPR)?
                (':connect' '[' NAME* ']')?
                (':type' SOURCE_TYPE)?
                (':role' ROLE)?
              DEDENT

visualize ::= '@visualize' NAME? NEWLINE INDENT
                ':mode' VIZ_MODE
                (':threshold' NUMBER)?
                (':color-inside' COLOR)?
                (':color-outside' COLOR)?
                (':feather' NUMBER)?
                (':range' NUMBER NUMBER)?
                (':density' NUMBER)?
                (':out' NAME)?
              DEDENT

anchor    ::= '@anchor' NAME NEWLINE INDENT
                ':source' NAME
                (':offset' EXPR)?
                (':size' EXPR)?
                (':role' ROLE)?
                (':guard' EXPR)?
                (':css-anchor' CSS_IDENT)?
                (':popover' ELEMENT_ID)?
                (':tabindex' NUMBER)?
                (text | link | input | button)*
              DEDENT
```

### 19.2 Composition Modes

```
COMP_MODE ::= 'smooth-min' | 'additive' | 'max' | 'min' | 'blend' | 'poisson'
```

### 19.3 Evolution Modes

```
EVOL_MODE ::= 'none' | 'stable-fluids' | 'force-directed' | 'position-based' | 'gray-scott' | 'diffuse-to-target'
```

### 19.4 Falloff Types

```
FALLOFF_TYPE ::= 'inverse-square' | 'gaussian' | 'exponential' | 'linear'
```

### 19.5 Visualization Modes

```
VIZ_MODE ::= 'isosurface' | 'heatmap' | 'gradient' | 'contour' | 'refraction' | 'dot-grid'
```

### 19.6 Border Types (Houdini-aligned)

```
BORDER_TYPE ::= 'constant' | 'repeat' | 'streak'
```

### 19.7 ARIA Roles

```
ROLE ::= 'button' | 'link' | 'textbox' | 'navigation' | 'region'
       | 'heading' | 'list' | 'listitem' | 'slider' | 'checkbox'
```

### 19.8 Source Types

```
SOURCE_TYPE ::= 'point' | 'sdf-text' | 'sdf-bootstrap'
```

Default is `point`. The `sdf-text` type uses the surface transducer's glyph atlas (`rex-surface.js:1536`) as the source field. The `sdf-bootstrap` type converts existing surface elements to an SDF via Jump Flooding Algorithm (§4.5).

### 19.9 Attribute Table

| Attribute | Appears On | Type | Default | Notes |
|---|---|---|---|---|
| `:resolution` | `@field` | NUMBER NUMBER | 256 256 | Grid dimensions |
| `:composition` | `@field` | COMP_MODE | smooth-min | Source merge strategy |
| `:blend-k` | `@field` | NUMBER | 0.3 | Smooth-min merge radius |
| `:evolution` | `@field` | EVOL_MODE | none | Per-frame dynamics |
| `:border` | `@field` | BORDER_TYPE | constant | Edge handling |
| `:border-value` | `@field` | NUMBER | 0.0 | Constant border value |
| `:bounds-source` | `@field` (nested) | NAME | — | Parent source for scoping |
| `:pos` | `@source` | EXPR | — | Required. Source center (2D) |
| `:strength` | `@source` | EXPR | 1.0 | Source amplitude |
| `:falloff` | `@source` | FALLOFF_TYPE | gaussian | Attenuation function |
| `:radius` | `@source` | EXPR | 50 | Falloff radius |
| `:sigma` | `@source` | EXPR | 30 | Gaussian sigma (alias for radius) |
| `:connect` | `@source` | NAME[] | — | Spring edges (force-directed) |
| `:constraint` | `@source` | CONSTRAINT[] | — | PBD constraints (position-based) |
| `:type` | `@source` | SOURCE_TYPE | point | Source field type |
| `:surface-elements` | `@source` | NAME[] | — | Surface elements for sdf-bootstrap |
| `:mode` | `@visualize` | VIZ_MODE | isosurface | Rendering strategy |
| `:threshold` | `@visualize` | NUMBER | 0.5 | Isosurface level |
| `:color-inside` | `@visualize` | COLOR | #ffffffff | Fill color above threshold |
| `:color-outside` | `@visualize` | COLOR | #00000000 | Fill color below threshold |
| `:feather` | `@visualize` | NUMBER | 2.0 | Anti-aliasing width (pixels) |
| `:range` | `@visualize` | NUMBER NUMBER | 0.0 1.0 | Heatmap value range |
| `:density` | `@visualize` | NUMBER | 5.0 | Contour line density |
| `:refract-strength` | `@visualize` | NUMBER | 5.0 | Refraction displacement |
| `:glow-color` | `@visualize` | COLOR | #88ccffaa | Glass glow tint |
| `:out` | `@visualize` | NAME | — | Named output for filter chaining |
| `:source` | `@anchor` | NAME | — | Required. Tracks this field source |
| `:offset` | `@anchor` | EXPR | (0 0) | Offset from source position |
| `:size` | `@anchor` | EXPR | (100 100) | DOM element dimensions |
| `:role` | `@anchor`, `@source` | ROLE | — | ARIA landmark role |
| `:guard` | `@anchor` | EXPR | — | Visibility guard expression |
| `:css-anchor` | `@anchor` | CSS_IDENT | — | CSS anchor name (e.g., --btn) |
| `:popover` | `@anchor` | ELEMENT_ID | — | Popover to tether |
| `:tabindex` | `@anchor` | NUMBER | — | Override computed tab order |
| `:selectable` | `@text` (in anchor) | BOOLEAN | false | Enable native text selection |
| `:action` | `@text`, `@button` | NAME | — | Talk to fire on click |
| `:edit-context` | `@text-editor` | BOOLEAN | true | Use EditContext API |
| `:ime` | `@text-editor` | BOOLEAN | true | Enable IME composition |
| `:viscosity` | `@field` | NUMBER | 0.1 | Stable fluids viscosity |
| `:dt` | `@field` | NUMBER | 0.016 | Evolution timestep |
| `:diffuse-iterations` | `@field` | NUMBER | 10 | Diffusion Jacobi steps |
| `:pressure-iterations` | `@field` | NUMBER | 20 | Pressure Jacobi steps |
| `:repulsion` | `@field` | NUMBER | 1000.0 | Force-directed repulsion |
| `:damping` | `@field` | NUMBER | 0.95 | Force-directed damping |
| `:rest-length` | `@field` | NUMBER | 100.0 | Spring rest length |
| `:diffuse-rate` | `@field` | NUMBER | 0.15 | Diffuse-to-target rate |
| `:target-attraction` | `@field` | NUMBER | 0.8 | Target attraction strength |
| `:poisson-iterations` | `@field` | NUMBER | 30 | Poisson composition Jacobi steps |
| `:iterations` | `@field` | NUMBER | 4 | PBD constraint solve iterations |

---

## 20. Performance Budget

### 20.1 Per-Frame Targets

| Component | Target | Technique |
|---|---|---|
| Field evaluation (100 sources) | < 2ms | Compute @workgroup_size(16,16), parallel per-pixel |
| Stable fluids step | < 4ms | Jacobi iteration (20 steps), compute |
| SDF composition (smooth-min) | < 1ms | Single pass, branchless |
| Visualization pass | < 1ms | Single compute dispatch per viz mode |
| Gradient computation | < 0.5ms | Central differences on field texture |
| Surface pipeline (flatten→fine) | < 4ms | Existing Vello rasterizer (`rex-surface.js:2449`) |
| Surface + field composite | < 0.5ms | Single render pass, 2 texture samples |
| Field readback (hit test + samples) | < 1ms | Async `mapAsync` on staging buffer |
| DOM anchor position sync | < 0.5ms | `translate3d` (GPU-composited, no reflow) |
| Accessibility tree update | < 0.2ms | Only on anchor visibility change |
| Fiber host flush | < 0.5ms | Incremental — only dirty fibers |
| **Total field + surface + DOM frame** | **< 12ms** | **83 FPS budget = 12ms** |

### 20.2 Memory Budget

| Resource | Size | Notes |
|---|---|---|
| Field grid (512×512, r32float) | 1 MB | One per @field |
| Velocity field (512×512, rg32float) | 2 MB | Only with stable-fluids |
| Pressure field (512×512, r32float) | 1 MB | Only with stable-fluids |
| Viz output (512×512, rgba8unorm) | 1 MB | One per @visualize |
| Surface output (canvas-sized, rgba8unorm) | ~8 MB | Existing, not new |
| Source buffer (100 sources × 24B) | 2.4 KB | Negligible |
| DOM anchors (20 elements) | ~4 KB DOM | Negligible |
| Fiber state (20 anchor fibers) | ~2 KB | rexUseState/rexUseResource slots |

Total with stable-fluids: ~5 MB GPU memory (field-only). Without evolution: ~2 MB. Well within budget.

### 20.3 DOM Overhead

DOM anchor sync must not trigger layout reflow. Rules:

1. **Only write `transform`** — GPU-composited, no reflow
2. **Batch DOM reads before writes** — avoid forced sync layout
3. **Use `contain: layout style`** on `<gpu-anchor>` — isolate from parent
4. **Use `requestAnimationFrame` for sync** — not per-event (integrated in frame loop at `main.js:713`)
5. **Limit anchor count** — 20-50 per field, not thousands (interactive elements only, not every pixel)

---

## 21. Examples

### 21.1 Minimal Field

```rex
@field hello
  :resolution 256 256

  @source blob
    :pos (128 128)
    :strength 1.0
    :falloff gaussian
    :sigma 50

  @visualize
    :mode isosurface
    :threshold 0.3
    :color-inside #4488ffff
```

One source, one visualization. ~50 lines of generated WGSL. Single compute dispatch. Synthetic shrub: `@shrub _field_hello` with `source_0_pos_x`, `source_0_pos_y`, `source_0_strength` slots (all static defaults, no channels needed).

### 21.2 Interactive Field with Mouse

```rex
@field interactive
  :resolution 512 512
  :composition smooth-min
  :blend-k 0.2

  @source a :pos (150 250) :strength 1.0 :falloff gaussian :sigma 60
  @source b :pos (350 250) :strength 1.0 :falloff gaussian :sigma 60
  @source cursor :pos (mouse-x mouse-y) :strength 0.5 :falloff gaussian :sigma 40

  @visualize
    :mode isosurface
    :threshold 0.4
    :color-inside #1a1b26ff
    :feather 3.0
```

Three sources, cursor-tracking. Sources merge smoothly when cursor approaches them. Synthetic derives: `source_2_pos_x = (mouse-x)`, `source_2_pos_y = (mouse-y)`. Channel bridges push cursor position every frame.

### 21.3 Responsive Layout with Anchors

```rex
@shrub app-state
  @slot sidebar-visible :type boolean :default true

@derive :shrub app-state :slot sidebar-visible
  (gt (canvas-width) 768)

@derive :shrub app-state :slot sidebar-strength
  (if /sidebar-visible 1.0 0.0)

@derive :shrub app-state :slot content-x
  (if /sidebar-visible 260 20)

@field app-layout
  :resolution 512 512
  :composition smooth-min
  :blend-k 0.15

  @source sidebar
    :pos (10 10)
    :strength /sidebar-strength
    :falloff gaussian
    :sigma 120

  @source content
    :pos (/content-x 10)
    :strength 1.0
    :falloff gaussian
    :sigma 200

  @visualize
    :mode isosurface
    :threshold 0.3
    :color-inside #1e1e2eff

  @anchor sidebar-nav
    :source sidebar
    :offset (15 20)
    :size (220 400)
    :role navigation
    :guard /sidebar-visible

    @text "Dashboard" :selectable true :role link :action go-dash
    @text "Settings" :selectable true :role link :action go-settings
    @text "Help" :selectable true :role link :action go-help

  @anchor main-content
    :source content
    :offset (20 20)
    :size (600 500)
    :role region

    @text "Welcome" :selectable true :role heading
```

Responsive: sidebar disappears below 768px. Anchor guard hides the nav DOM element. Content source shifts left. Text is selectable. Screen readers see `<nav>` and `<section>` with proper roles. CommandRing tracks field eval and anchor sync timings.

### 21.4 Fluid Layout with Drag

```rex
@shrub panel-state
  @slot panel-x :type number :default 200
  @slot panel-y :type number :default 200

@talk :shrub panel-state :name drag
  @input dx :type number
  @input dy :type number
  @inc /panel-x %dx
  @inc /panel-y %dy

@field fluid-layout
  :resolution 512 512
  :evolution stable-fluids
  :viscosity 0.1
  :composition smooth-min

  @source fixed-a :pos (50 50) :strength 1.0 :falloff gaussian :sigma 80
  @source fixed-b :pos (400 400) :strength 1.0 :falloff gaussian :sigma 80
  @source draggable :pos (/panel-x /panel-y) :strength 1.5 :falloff gaussian :sigma 60

  @visualize :mode isosurface :threshold 0.3 :color-inside #2a2a3aff
  @visualize :name flow :mode gradient
```

Drag the panel → stable fluids velocity injection → field re-evaluates → fixed sources visually respond → all smooth, no animation system. Two visualizations: isosurface for layout + gradient for flow debug.

### 21.5 Morphing Glass Text

```rex
@field text-surface
  :resolution 512 256
  :evolution diffuse-to-target
  :diffuse-rate 0.15
  :target-attraction 0.8

  @source text-target
    :type sdf-text
    :text /editor-content
    :font-size 48
    :pos (50 100)

  @visualize
    :mode refraction
    :refract-strength 8.0
    :glow-color #88ccffaa
    :feather 2.0

  @anchor text-edit
    :source text-target
    :offset (0 0)
    :size (400 100)
    :role textbox

    @text-editor
      :content /editor-content
      :edit-context true          ;; use EditContext API
      :ime true                   ;; enable IME support
```

Type a character → gaussian blob at cursor → diffuse toward glyph SDF → field settles into letterform over ~200ms → glass shader evaluates ∇φ for refraction during evolution. EditContext handles input. Text is accessible. The SDF glyph atlas from `rex-surface.js:1536` provides the target field.

### 21.6 Filter-Chained Field

```rex
@field glow-layout
  :resolution 512 512
  :composition smooth-min

  @source a :pos (200 200) :strength 1.0 :falloff gaussian :sigma 80
  @source b :pos (350 300) :strength 0.8 :falloff gaussian :sigma 60

  @visualize :name raw :out field-raw
    :mode isosurface
    :threshold 0.3
    :color-inside #4488ffff

;; Chain field output through existing filter system:
@filter bloom :src field-raw :threshold 0.4 :intensity 1.5
@filter chromatic-aberration :src field-raw :offset 3.0
```

Field output feeds into the 19 built-in filters (`rex-gpu.js:145`). Zero new infrastructure — the `:out` name resolves to a texture in `_textures` Map, which `_compileFilters` reads via `:src`.

---

## Appendix A: WGSL Templates

### A.1 Smooth Min Variants

```wgsl
// Polynomial smooth min (default)
fn smin_poly(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0);
  return min(a, b) - h * h / (4.0 * k);
}

// Exponential smooth min (smoother tails)
fn smin_exp(a: f32, b: f32, k: f32) -> f32 {
  let res = exp(-k * a) + exp(-k * b);
  return -log(res) / k;
}

// Power smooth min (adjustable sharpness)
fn smin_pow(a: f32, b: f32, k: f32) -> f32 {
  let a_k = pow(a, k);
  let b_k = pow(b, k);
  return pow((a_k * b_k) / (a_k + b_k), 1.0 / k);
}
```

### A.2 Heatmap Color Ramp

```wgsl
fn heatmap_ramp(t: f32) -> vec4f {
  // Infra-red style: black → blue → cyan → green → yellow → red → white
  let r = smoothstep(0.4, 0.7, t) + smoothstep(0.85, 1.0, t) * 0.5;
  let g = smoothstep(0.2, 0.5, t) - smoothstep(0.7, 0.9, t) * 0.5 + smoothstep(0.9, 1.0, t) * 0.5;
  let b = smoothstep(0.0, 0.3, t) - smoothstep(0.5, 0.7, t);
  return vec4f(r, g, b, 1.0);
}
```

### A.3 Hilbert Curve Index (for tab order)

```javascript
function hilbertIndex(x, y, order = 8) {
  let d = 0;
  for (let s = order >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // Rotate quadrant
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return d;
}
```

### A.4 Force-Directed Integration

```wgsl
// Velocity Verlet integration for force-directed evolution:
@compute @workgroup_size(64)
fn force_step(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= config.source_count) { return; }
  let idx = gid.x;
  var force = vec2f(0.0);

  // Coulomb repulsion between all pairs
  for (var j = 0u; j < config.source_count; j++) {
    if (j == idx) { continue; }
    let diff = sources[idx].pos - sources[j].pos;
    let dist = max(length(diff), 1.0);
    force += normalize(diff) * config.repulsion / (dist * dist);
  }

  // Spring attraction to connected sources
  for (var e = 0u; e < edges[idx].count; e++) {
    let other = edges[idx].targets[e];
    let diff = sources[other].pos - sources[idx].pos;
    let dist = length(diff);
    force += normalize(diff) * (dist - config.rest_length);
  }

  // Velocity Verlet
  let vel = velocities[idx] * config.damping + force * config.dt;
  velocities[idx] = vel;
  sources[idx].pos += vel * config.dt;
}
```

---

## Appendix B: Browser API Support Matrix

| API | Chrome | Edge | Firefox | Safari | Fallback |
|---|---|---|---|---|---|
| WebGPU | 113+ | 113+ | Nightly (139+) | 18.2+ | — (required) |
| EditContext | 133+ | 133+ | No | No | Hidden textarea |
| CSS Anchor Positioning | 125+ | 125+ | No | No | JS-based positioning |
| ariaNotify() | Origin trial | 136+ | No | No | aria-live region |
| Popover API | 114+ | 114+ | 125+ | 17+ | JS-based popover |
| CSS Custom Highlight | 105+ | 105+ | 132+ | 17.2+ | DOM-based highlight |
| Shadow DOM (declarative) | 111+ | 111+ | 123+ | 16.4+ | Imperative shadow DOM |
| `<gpu-anchor>` (custom element) | All modern | All modern | All modern | All modern | — |
| View Transitions API | 111+ | 111+ | No | 18+ | CSS transitions |

---

## Appendix C: Houdini Scalar Field Alignment

The field model follows Houdini's Scalar Field DOP architecture:

| Houdini Scalar Field DOP | Rex @field | Notes |
|---|---|---|
| Size (bounding box dimensions) | `:resolution W H` | 2D grid dimensions |
| Center (world-space position) | Source `:pos` | Each source has its own center |
| Division Method | `:resolution` (implicit) | Pixel-level division |
| Voxel Sampling (center/face/edge/corner) | Center-sampled (default) | Sufficient for 2D UI |
| Border Behavior (constant/repeat/streak) | `:border constant\|repeat\|streak` | Same three modes |
| Initial Value | `:border-value 0.0` | Default field value |
| Tolerance (compression) | — | Future: sparse field storage |
| Use 16-bit Float | — | Future: `:precision half` attribute |
| Slice Divisions (distributed) | Workgroup tiling (16×16) | GPU parallelism handles this |
| Scalar Field Visualization DOP | `@visualize` node | Separate from data |
| Visualization modes (smoke/iso/plane) | `:mode isosurface\|heatmap\|gradient\|contour\|refraction\|dot-grid` | Extended for UI |
| Coloring (infra-red/white-red/grayscale/blackbody) | Heatmap ramp function | Configurable |
| Guide Range (min/max) | `:range MIN MAX` | Same concept |

The Houdini principle — **field is data, visualization is separate** — is the core architectural decision. `@field` stores values. `@visualize` renders them. One field, many visualizations. This separation enables: same field driving layout + debug heatmap + accessibility gradient simultaneously.

---

## Appendix D: Migration Guide (v1 → v2)

### D.1 Breaking Changes

| v1 | v2 | Action Required |
|---|---|---|
| Compile step between agent sugar and filters | Inside GPU transducer at phase 1.5 | Move `_compileFields` call into `gpu.compile()` |
| `Rex.registerContentType('field')` | `gpu.registerCompileType('field', ...)` | Change registration call |
| Implicit field shrub | Explicit `@shrub _field_NAME` | None — synthetic, auto-generated |
| Separate field hit test shader | Merged with surface hit test | Update hit test WGSL |
| No composite specification | Explicit field-under-surface composite | Update surface composite shader |

### D.2 New Features

| Feature | Section | Description |
|---|---|---|
| Synthetic shrub | §2.3 | Every @field emits `@shrub _field_NAME` with source slots |
| Surface integration | §7 | Field textures composite under surface output |
| Filter chaining | §7.5 | `@visualize :out name` → `@filter :src name` |
| CommandRing profiling | §17 | Per-operation timing via io_uring-style ring |
| Fiber lifecycle detail | §16 | Exact `rexUseResource`/`rexKeyed` signatures |
| Incremental recompile phases | §18.3 | Phase 1.5 triggers for field nodes |
| `source` node type registration | §18.4 | `registerCompileType('source', ...)` |
| Attribute reference table | §19.9 | Complete attribute list with types/defaults |
| Poisson composition | §4.4 | Laplace solve for "soft flexbox" layout |
| Jump Flooding bootstrap | §4.5 | Convert existing surface elements to SDF field sources |
| Position-Based Dynamics | §5.4 | PBD constraint projection — unconditionally stable layout |
| Haptic field extensions | §11.5 | Field gradient → vibration/haptic feedback |

### D.3 Source Cross-References

All source file references in this spec, verified against the codebase:

| Reference | File:Line | Description |
|---|---|---|
| `_compileFilters` | `rex-gpu.js:885` | Sugar expansion pattern for fields |
| `_compileStructs` | `rex-gpu.js:760` | Struct compilation for FieldSource |
| `_compileStorageBuffers` | `rex-gpu.js:1518` | Source buffer compilation |
| `_compileTextures` | `rex-gpu.js:1545` | Field grid + viz texture creation |
| `_compileShaders` | `rex-gpu.js:1352` | Generated field eval/viz shaders |
| `_compileResourceScopes` | `rex-gpu.js:1966` | Bind group for field resources |
| `_buildPipeline` | `rex-gpu.js:2991` | Compute pipelines for eval/viz |
| `_compileCommandList` | `rex-gpu.js:2080` | Dispatch commands |
| `_compileReadbacks` | `rex-gpu.js:612` | Field readback for hit test / force-directed |
| `_compileHeapLayout` | `rex-gpu.js:1417` | Byte offset assignment |
| `_compileOptics` | `rex-gpu.js:1432` | Path → offset table |
| `_compileHeap` | `rex-gpu.js:2875` | Synthetic structs from @heap |
| `_mapChangesToPhases` | `rex-gpu.js:2805` | Incremental recompile triggers |
| `_compileChannels` | `rex-behaviour.js:387` | Channel bridge compilation |
| `_pushChannels` | `rex-behaviour.js:828` | Channel execution (per-frame push) |
| `_classifyDerives` | `rex-behaviour.js:504` | GPU vs CPU derive split |
| `_flushDerives` | `rex-behaviour.js:686` | Derive execution + surprise detection |
| `fireTalk` | `rex-behaviour.js:70` | Talk invocation for anchor clicks |
| `compile()` | `rex-surface.js:515` | Surface compile entry |
| `execute()` | `rex-surface.js:2449` | Surface execute (Vello pipeline) |
| Hit test WGSL | `rex-surface.js:264` | Winding-number hit test |
| Hit readback | `rex-surface.js:2510` | Async mapAsync readback |
| `_collectText` | `rex-surface.js:728` | SDF text quad collection |
| `_collectTextEditor` | `rex-surface.js:1245` | GPU text editor |
| `_buildGlyphAtlas` | `rex-surface.js:1536` | SDF glyph atlas creation |
| `_generateESDT` | `rex-surface.js:1645` | Extended subpixel distance transform |
| `_getGlyphMetrics` | `rex-surface.js:1516` | Character metrics cache |
| `_makeSurfaceEvalContext` | `rex-surface.js:633` | Expression ident resolution |
| Composite pass | `rex-surface.js:294` | Fullscreen composite shader |
| `registerElementType` | `rex-surface.js:499` | Extension protocol |
| `rexUseResource` | `rex-fiber.js:142` | DOM resource lifecycle |
| `rexUseState` | `rex-fiber.js:104` | Fiber-local state |
| `rexKeyed` | `rex-fiber.js:212` | Keyed child reconciliation |
| `RexFiberHost` | `rex-fiber.js:764` | Fiber host class |
| `CommandRing` | `rex-fiber.js:933` | Profiling ring buffer |
| `FiberHeapAllocator` | `rex-fiber.js:688` | (Not used — DOM anchors don't need heap) |
| Form `onFieldChange` | `main.js:397` | Form → GPU write path |
| `onReadback` | `main.js:423` | GPU → behaviour readback |
| Frame loop | `main.js:713` | Frame loop integration point |
| `parseSource` | `main.js:483` | Compile pipeline entry |
| `registerNodeType` | `rex-form.js:12` | Custom form node types |
| `registerFieldType` | `rex-form.js:13` | Custom form field types |
| `setExternal` | `rex-form.js:252` | External state → DOM sync |
