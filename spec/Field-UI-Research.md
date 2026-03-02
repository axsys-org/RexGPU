# Scalar Field UI: Research & Architecture

## The Paradigm Shift

Traditional UI: discrete widget tree → layout algorithm → rasterization → pixel buffer.

Field UI: continuous scalar function → per-pixel evaluation → isosurface extraction → pixel buffer.

No DOM. No widget tree. No layout passes. The entire interface is a mathematical function `φ(x,y)` evaluated on the GPU. Elements are field perturbations, not rectangles. Layout is field equilibrium, not constraint solving. Interaction is field sampling, not hit-testing. Animation doesn't exist — the field is always settling toward equilibrium, so motion is continuous and free.

This connects to two active HCI research strands:
- **Organic / shape-changing interfaces** — input and output merge because the user directly "deforms" the surface
- **Non-rigid and deformable interaction** — expands the design space to include continuity, morphological transitions, and emergent affordances

---

## Three Pillars

### 1. Field Evaluation (Rendering)

The rendering backbone is **sphere tracing / ray marching** — a per-pixel technique that evaluates a composed SDF (Signed Distance Function) to find surface intersections.

**Core algorithm:**
```
for each pixel:
    ray = camera_origin + pixel_direction * t
    for step in 0..MAX_STEPS:
        d = φ(ray.position)          // evaluate field at current position
        if d < ε: HIT → shade pixel
        ray.position += ray.direction * d   // safe step: d guarantees no penetration
```

This is how Shadertoy renders everything — no geometry, no triangles, just math. The key insight: the SDF value IS the step size, so the algorithm naturally takes large steps in empty space and tiny steps near surfaces.

**Performance characteristics:**
| Technique | FPS @ 1080p | Key Advantage |
|-----------|-------------|---------------|
| Basic sphere tracing | 60+ | Per-pixel parallelism, no geometry |
| Cone marching | ~20% faster | Ray bundle coherence |
| Adaptive stepping | ~30% fewer iterations | Large steps in open space |
| BVH culling | ~40-50% early rejection | Skip empty regions entirely |

The morphing glass text in the Dynamic Scalar Field UI demo is likely SDF glyphs with smooth-min blending and a refraction shader evaluating the field gradient for surface normals.

### 2. Field Composition (Layout)

The critical operation is **smooth minimum** — the field-space equivalent of "union" but with controlled blending at boundaries.

**Standard CSG (sharp):**
```
union(a, b)        = min(a, b)         // hard edge where fields meet
intersection(a, b) = max(a, b)
difference(a, b)   = max(a, -b)
```

**Smooth CSG (Inigo Quilez):**
```
smin(a, b, k) = min(a, b) - k * max(0, k - |a - b|)²
```

The `k` parameter controls blend radius. This is how metaballs merge smoothly — and how UI elements would "flow into each other" at proximity. Larger k = broader blending region = more organic merging.

**Layout as field equilibrium:**
1. Each element is a field source with position, strength, and falloff
2. All sources compose via smooth-min into a total field
3. The equilibrium configuration IS the layout
4. No flexbox, no grid, no constraint solver — just physics

**Algebraic properties:**
- Commutative: `smin(a,b) = smin(b,a)` ✓
- Approximate associativity: `smin(smin(a,b),c) ≈ smin(a,smin(b,c))` (close enough for UI)
- Identity: `smin(a, ∞) = a` ✓
- Smooth min is C¹ continuous (no gradient discontinuities at boundaries)

### 3. Field Dynamics (Interaction)

Three approaches to making the field respond to user input, all GPU-native:

#### A. Force-Directed (D3.js Model)
- **Coulomb repulsion**: all elements repel with inverse-square force (prevents overlap)
- **Spring attraction**: connected elements attract with linear spring force (maintains structure)
- **Integration**: velocity Verlet (unconditionally stable)
- **Acceleration**: Barnes-Hut quadtree O(n log n) instead of O(n²)

This is the most proven approach — D3.js has been doing it at scale for years. The leap is moving the force computation to GPU compute shaders.

#### B. Stable Fluids (Jos Stam, SIGGRAPH 1999)
```
per frame:
    1. Add forces (mouse drag = velocity injection)
    2. Advect velocities (follow particle paths backward)
    3. Diffuse (viscous dissipation)
    4. Project (Poisson solve → enforce incompressibility)
    5. Advect density/dye (visualization)
```

All steps parallelizable. Poisson solve uses Jacobi iteration (~20 iterations/frame). User drag = velocity impulse at click point. UI elements = boundary conditions (walls that redirect flow). Elements float along streamlines = field-guided layout. 60 FPS interactive, well-studied, unconditionally stable.

#### C. Reaction-Diffusion (Gray-Scott System)
```
∂A/∂t = dA∇²A - AB² + f(1-A)
∂B/∂t = dB∇²B + AB² - (f+k)B
```

Two-chemical system that produces Turing patterns (self-organized stripes, spots, spirals). GPU achieves 100x speedup over CPU for 2000x2000 grids. The morphing text could be reaction-diffusion patterns constrained to glyph shapes — the pattern evolves within the letterform boundary, creating organic internal structure.

---

## Key Algorithms (Implementation Detail)

### Metaballs = Field Source Pattern

Metaballs are the simplest scalar field: sum of radial contributions from point sources.

```wgsl
fn evaluate_field(pos: vec2f, sources: array<FieldSource>) -> f32 {
    var total = 0.0;
    for (var i = 0u; i < num_sources; i++) {
        let d = distance(pos, sources[i].position);
        let falloff = sources[i].strength / (d * d + 0.001);
        total += falloff;
    }
    return total;
}
```

Isosurface at threshold → soft merging when sources are close. This is exactly the "elements as field perturbations" pattern. The dot grid in the Dynamic Scalar Field UI screenshot is a discretized visualization of this — each dot samples the field at its grid position, and its appearance (size/displacement/color) encodes the local field value.

### Level-Set Methods (Moving Boundaries)

Track UI element boundaries as zero-crossings of an implicit field `φ(x,y,t) = 0`:
- Hamilton-Jacobi PDE: `∂φ/∂t + v·∇φ = 0` (velocity field drives boundary motion)
- **Handles topology change naturally** — elements merge when fields overlap, split when fields separate
- No re-meshing, no edge cases for overlapping rectangles
- Used in computational physics for 40+ years — mature, robust

### Position-Based Dynamics (Constraint Satisfaction)

PBD (Müller et al.) is better than force-based for UI because:
- **Directly manipulate positions** via constraint projection (no force → acceleration → velocity → position chain)
- **Unconditionally stable** (no timestep sensitivity)
- **Faster convergence** than force-based (fewer iterations to reach equilibrium)
- Used in game engines (Unreal, Unity) for cloth, fluids, rigid bodies

```
per frame:
    1. Predict: p_new = p + v * dt
    2. For each constraint: project p_new to satisfy constraint
    3. Update: v = (p_new - p) / dt
```

### Poisson Equation (Smooth Interpolation)

For smooth layout field that satisfies sparse constraints:
```
Given: boundary conditions (element positions, sizes)
Solve: Δu = 0 (Laplace equation) in interior
Result: u = smoothest possible field consistent with constraints
```

GPU-friendly via Jacobi iteration. Guarantees smooth layout even with contradictory soft constraints. This is how you'd implement "soft flexbox" — define desired positions as boundary conditions, solve Laplace, elements settle at smooth equilibrium.

### Jump Flooding (Fast SDF from Geometry)

If you have existing geometry (paths, text) and need to convert to SDF:
- Seed pixels at geometry boundaries
- Log₂(N) passes: each pixel checks neighbors at distance N/2, N/4, N/8, ...
- ~200ms per texture layer in compute shader
- Useful for bootstrapping field from existing Rex surface elements

---

## The Vello Pipeline Question

Rex's current surface pipeline (flatten → coarse → fine → composite) is a **scene graph rasterizer**. A field renderer is fundamentally different — it's a **per-pixel function evaluator**. The distinction:

| | Scene Graph Rasterizer | Field Evaluator |
|---|---|---|
| **Input** | Geometry (paths, segments) | Function φ(x,y) |
| **Per-pixel work** | Test which geometry covers this pixel | Evaluate φ at this pixel |
| **Spatial acceleration** | Tile binning, segment sorting | None needed (function is global) |
| **Composition** | Porter-Duff alpha blending | Smooth min/max on field values |
| **Animation** | Resubmit geometry each frame | Field evolves continuously |
| **Complexity** | O(geometry × pixels in tile) | O(field_sources × pixels) |

The field evaluator is simpler — a single compute dispatch where each thread evaluates the composed field function at its pixel position. No flatten, no coarse binning, no segment sorting. The entire pipeline collapses to:

```wgsl
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pixel = vec2f(f32(gid.x), f32(gid.y));
    let field_value = evaluate_composed_field(pixel);
    let color = shade_field(field_value, pixel);
    textureStore(output, vec2i(gid.xy), color);
}
```

This doesn't replace the Vello pipeline — it **bypasses it entirely** for field-rendered content. Both can coexist: traditional surface elements use the path pipeline, field elements use the field evaluator, results composite together.

---

## Connection to Rex Architecture

Rex is closer to this paradigm than any other system:

| Rex Has | Field Equivalent |
|---------|-----------------|
| Zero-copy heap (one ArrayBuffer) | Field storage (continuous scalar grid) |
| Compiled optics → byte offsets | Field sampling at compiled locations |
| Channel bridges (behaviour → GPU) | Field perturbation propagation |
| Derive compute (GPU-side @derive) | Field evolution step |
| ShrubLM surprise detection | Field discontinuity detection |
| @filter system (template expansion) | Field visualization shaders |
| Transducer model (pluggable compilers) | @field transducer slots in naturally |

The gap is **one new transducer**. Not a rewrite — an addition. The @field transducer:
1. Compiles `@source` nodes into field contribution functions (WGSL)
2. Composes them via smooth-min into a total field evaluation shader
3. Evaluates per-pixel in a compute dispatch
4. Writes to storage texture (same as @filter output)
5. Reads back field values at interactive regions via existing readback system
6. Pushes field-derived values through existing channel bridges to behaviour

All of Rex's infrastructure — shrubs, derives, channels, optics, readback, PCN — works unchanged. The field is just another data source that flows through the same reactive graph.

---

## Proposed @field Notation

```rex
@field layout-field
  :resolution 512 512
  :composition smooth-min
  :blend-k 0.3
  :evolution stable-fluids    ;; or: force-directed, gray-scott, none
  :viscosity 0.1
  :dt 0.016

  @source panel-a
    :pos (100 100)
    :strength 1.0
    :falloff inverse-square
    :radius 50

  @source panel-b
    :pos (300 200)
    :strength 1.0
    :falloff gaussian
    :sigma 30

  @source cursor
    :pos (mouse-x mouse-y)
    :strength (pointer-pressure)
    :falloff exponential
    :radius 20

  @visualize
    :mode isosurface           ;; or: gradient, heatmap, contour, refraction
    :threshold 0.5
    :color-inside #1a1b26
    :color-outside #00000000
```

This compiles to:
1. A WGSL compute shader with all source contributions
2. A storage texture for the field grid
3. An evolution compute pass (if :evolution specified)
4. A visualization shader (isosurface/gradient/etc.)
5. Readback descriptors for interactive regions

The template expansion pattern is identical to @filter — the @field node expands to synthetic @texture + @shader + @pipeline + @dispatch nodes. Same machinery, different semantics.

---

## Accessibility Strategy

If UI is a continuous field, discrete access (screen readers, keyboard navigation) requires field → discrete mapping:

### Flow-Line Navigation
1. Compute field gradient: `∇φ = (∂φ/∂x, ∂φ/∂y)`
2. Trace streamlines following `-∇φ` (path of steepest descent toward field minima)
3. Discretize streamlines into navigation waypoints
4. Tab order follows streamline traversal
5. Gradient strength = "focus intensity" (high gradient = dense interaction region)

### Semantic Layer
Alongside the visual field `φ(x,y)`, maintain a semantic field `S(x,y) ∈ {button, label, input, ...}`:
- Local minima of the interaction field = interactive elements
- Each minimum gets an ARIA role based on the semantic field value at that point
- Screen readers traverse minima in Hilbert curve order (preserves spatial locality)

### Haptic Extension
- Gradient magnitude → haptic pressure feedback
- Gradient direction → directional guidance
- Field curvature → texture information

---

## Performance Budget

| Component | Target | Technique |
|-----------|--------|-----------|
| Field evaluation (100 sources) | < 2ms | Compute shader, parallel per-pixel |
| Stable fluids step | < 4ms | Jacobi iteration (20 steps), compute |
| SDF composition (smooth-min) | < 1ms | Single pass, no branching |
| Isosurface extraction | < 1ms | Threshold in field evaluation shader |
| Gradient computation | < 0.5ms | Central differences on field texture |
| Field readback (hot regions) | < 1ms | Async mapAsync on staging buffer |
| **Total field frame** | **< 8ms** | **120 FPS budget = 8.3ms** |

For comparison, Rex's current Vello pipeline (flatten + coarse + fine + composite + text) takes 3-6ms for typical UI scenes. The field evaluator would be in the same ballpark but with fundamentally different capabilities.

---

## What the Dot Grid Is

The dot-grid screenshot from the Dynamic Scalar Field UI demo is literally a **discretized field visualization**. Implementation:

```wgsl
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let grid_pos = vec2f(f32(gid.x) * grid_spacing, f32(gid.y) * grid_spacing);
    let field_val = evaluate_field(grid_pos);
    let displacement = field_gradient(grid_pos) * field_val * response_strength;

    // Each dot: position shifted by field gradient, size scaled by field value
    let dot_pos = grid_pos + displacement;
    let dot_radius = base_radius * (1.0 + field_val * scale_factor);

    // Write dot instance data to vertex buffer
    dots[gid.x + gid.y * grid_width] = DotInstance(dot_pos, dot_radius, field_val);
}
```

When the user drags the green block, it moves a field source. All dots near it respond because the field changes at their sample points. The response is instantaneous and continuous — no animation system, no tweening, just field re-evaluation.

---

## What the Morphing Text Is

The glass-like morphing characters are likely:

1. **Glyph SDFs** — each character defined as a signed distance field (standard technique, Rex already does this)
2. **Smooth-min composition** — characters blend into each other at proximity
3. **Refraction shader** — field gradient used as surface normal for refraction/reflection (glass effect)
4. **Internal pattern** — possibly reaction-diffusion (Gray-Scott) constrained within glyph boundaries, or noise-driven displacement

The "morphing into shape" effect when typing: start with a field perturbation at the key position, evolve via diffusion toward the glyph SDF shape. The glyph is the equilibrium state — the field settles into the letterform.

```
On keypress:
  1. Create field disturbance at cursor position (gaussian blob)
  2. Set target field = glyph SDF for that character
  3. Evolve: ∂φ/∂t = α(φ_target - φ) + β∇²φ  (diffuse toward target)
  4. Field settles into glyph shape over ~200ms
  5. Glass shader evaluates ∇φ for refraction during evolution
```

The visual result: the character appears to crystallize out of a fluid perturbation. No keyframe animation — just field dynamics.

---

## Implementation Roadmap

### Phase 1: Field Evaluator (Proof of Concept)
- Single compute shader: evaluate N point sources with inverse-square falloff
- Smooth-min composition
- Output to storage texture
- Visualize as isosurface (threshold coloring)
- Wire mouse position as a field source via existing input system
- **Estimated: 1 day**

### Phase 2: Field Transducer Integration
- `@field` node type compiled by new transducer
- `@source` children → WGSL field contributions
- Template expansion (same pattern as @filter)
- Channel bridges: shrub slots → field source parameters
- Readback: field values at specified sample points → behaviour system
- **Estimated: 2 days**

### Phase 3: Field Dynamics
- Stable fluids evolution compute pass (optional per @field)
- Force-directed layout mode (Coulomb + springs)
- User interaction as field perturbation
- Continuous layout: elements query field for position/size
- **Estimated: 3 days**

### Phase 4: Field Rendering
- Refraction/glass shader (field gradient → normals)
- SDF text integration (glyph SDFs composed into field)
- Morphing text effect (diffusion toward glyph target)
- Dot-grid visualization mode
- **Estimated: 2 days**

### Phase 5: Accessibility + Polish
- Flow-line computation from field gradient
- Semantic field layer
- Hilbert curve tab order
- Screen reader integration
- **Estimated: 2 days**

**Total: ~10 days from concept to full field UI system.**

---

## The No-UI-Tree Thesis

### What "No UI Tree" Actually Means

Every UI framework in existence is a tree:

```
React:    Component → Component → Component → DOM
Flutter:  Widget → Widget → Widget → RenderObject
SwiftUI:  View → View → View → UIView
CSS:      Box → Box → Box → Pixel
```

Layout is a tree walk. Hit testing is a tree walk. Focus is a tree walk. Accessibility is a tree walk. Animation is tree diffing. The tree is the universal abstraction — and the universal bottleneck.

The field paradigm eliminates the tree for layout and rendering. Elements are not nested boxes. They are field perturbations — point sources with position, strength, and falloff. Layout is not constraint solving. It is field equilibrium — the smooth-min composition of all sources, evaluated per-pixel on the GPU. There is no layout pass because there is no tree to walk.

### Two Levels of Tree Elimination

**Level 1: No rendering/layout tree (achievable)**

The `@field` system replaces the widget tree for layout and rendering:

```
BEFORE (tree):  Panel → Row → [Button, Text, Button] → measure → layout → rasterize
AFTER (field):  φ(x,y) = smin(source_a, source_b, source_c, k) → per-pixel evaluate → done
```

No tree walk. No constraint solver. No layout pass. No measure pass. Elements merge, split, and flow continuously. The field IS the layout. Animation does not exist — the field is always settling toward equilibrium, so motion is continuous and free.

The Vello path rasterizer (`rex-surface.js:2449`) still exists for crisp text and icons, but it composites *on top* of the field output. The field provides the spatial structure; the surface provides the visual detail.

**Level 2: No DOM at all (the hard problem)**

The platform requires a DOM for affordances the GPU cannot provide:

| Affordance | Why DOM Required | Field Alternative |
|---|---|---|
| Text selection | Selection API owns the clipboard | Invisible `<span>` with `color: transparent` |
| Screen readers | ARIA requires real DOM nodes | Accessibility shadow (minimal semantic DOM) |
| IME composition | EditContext or `<textarea>` required | EditContext fiber resource |
| Tab navigation | focusable elements required | `<gpu-anchor>` with computed tabindex |
| Popovers/tooltips | Top layer API | CSS anchor positioning on anchor divs |
| Copy/paste | Clipboard API reads from DOM | Native — invisible text IS the clipboard source |

This is why the Field-DOM spec has `@anchor` — the ghost ship bridge. The field renders everything visually, but invisible DOM elements provide platform affordances. It is the Flutter model: GPU renders, DOM serves accessibility and input.

The developer never writes a UI tree. They write field sources. The minimal DOM tree is *synthesized* from field topology.

### What the Field Gradient Replaces

The tree was always an approximation of a continuous function. Every tree operation has a field equivalent that is continuous, composable, and GPU-parallel:

| Tree Operation | Field Equivalent | Advantage |
|---|---|---|
| Layout (measure + place) | Field equilibrium (smooth-min composition) | No passes — equilibrium is the layout |
| Hit testing (tree walk + bounds check) | Field sampling at cursor position | Continuous — gives proximity, not just in/out |
| Tab order (DOM order / tabindex) | Steepest descent on field gradient | Spatial, not syntactic — follows visual flow |
| Focus (activeElement) | Local field minimum | Natural — strongest field = most interactive |
| Animation (state diff + interpolation) | Field evolution (advect/diffuse/react) | Free — field always settling toward equilibrium |
| Proximity/hover | Field value at cursor | Continuous — 0.3 = approaching, 0.9 = on it |
| Responsive breakpoints | Source strength functions | Continuous — no snap, smooth transition |
| Z-ordering (tree depth / z-index) | Field strength dominance | Natural — strongest source wins |
| Nesting (parent → child) | Nested fields (`@field` inside `@field`) | Scoped — child field bounded by parent source |
| Component composition | Field source composition (smooth-min algebra) | Algebraic — commutative, associative, continuous |

The tree encodes discrete containment. The field encodes continuous influence. Every UI is influence — buttons attract clicks, panels contain content, gaps repel elements. The field makes the influence explicit.

### Why Rex Can Do This and Others Cannot

Rex has four properties that make tree elimination possible:

**1. Compile-time sugar expansion.** `@field` expands to `@texture` + `@shader` + `@pipeline` + `@dispatch`. Same pattern as `@filter` (`rex-gpu.js:885`). No new runtime. The field evaluator is just a compute shader — it runs in the same GPU command list as everything else.

**2. Profunctor optics.** The DOM↔GPU bridge is a bidirectional optic. Forward: shrub slot → derive → channel → heap → WGSL uniform → field source position → anchor CSS transform. Backward: DOM Selection → slot write → derive dirty → channel push → GPU re-evaluate. The same algebra handles GPU readback, agent tool channels, form widgets, and field sources. No special-casing.

**3. Fiber lifecycle.** DOM anchors persist across recompile via `rexUseResource` (`rex-fiber.js:142`). The user edits source code → tree re-parses → field re-expands → fiber reconciles by key → existing anchor DOM elements survive. Focus preserved. IME composition unbroken. Screen reader state intact.

**4. Shrub as universal proxy.** The shrub holds all truth — field source parameters, anchor visibility, selection state, hover proximity, evolution step count. The field and DOM are views over the shrub. When the user drags a panel, the shrub slot updates, the channel pushes to GPU heap, the field re-evaluates, the anchor repositions. One source of truth, three projections (GPU field, surface rasterizer, DOM anchor).

No other framework has all four. React has component trees but no GPU pipeline. Flutter has GPU rendering but Dart widget trees. Unity has compute shaders but no reactive data flow. Shadertoy has field evaluation but no DOM integration. Rex unifies them in a single `.rex` file.

### Implications

**For application developers:** Write field sources, not widget trees. Describe *where things are* and *how strongly they attract*, not *how they nest*. Layout is physics. Animation is evolution. Interaction is sampling.

**For the framework:** The rendering pipeline becomes: evaluate field → visualize → composite with surface → sync anchors. No measure pass. No layout pass. No tree diff. The compile step generates shaders; the execute step runs them. The fiber host manages DOM resources. Everything else is existing infrastructure.

**For the platform:** The DOM becomes a semantic shadow — 20-50 anchor elements providing ARIA roles, focus targets, and clipboard access. Not 500 nested divs encoding visual structure. The browser's layout engine handles 20 absolutely-positioned elements with `contain: layout style` — zero reflow, zero style recalc.

**For accessibility:** Field gradient provides richer navigation than tree order. Steepest-descent paths converge on interactive elements. Gradient magnitude encodes "interaction density." Hilbert curve linearization preserves spatial locality. The continuous field contains more navigational information than a discrete tree — screen readers get *better* navigation, not worse.

**For performance:** One compute dispatch evaluates the field for all elements simultaneously. O(sources × pixels) on the GPU, fully parallel. Compare to O(nodes) sequential tree walk in React/Flutter. The field evaluator doesn't care about element count — it cares about pixel count, which is fixed by resolution. 100 elements and 1000 elements cost the same.

### The Remaining Question

Can the developer experience match the abstraction? Writing `@source sidebar :pos (10 10) :strength 1.0 :falloff gaussian :sigma 120` is more alien than `<div class="sidebar">`. The field paradigm requires spatial thinking — positions, strengths, falloff functions — instead of hierarchical thinking — parents, children, siblings.

The answer is tooling: visual field editors where you place sources by dragging, adjust strength by scrolling, see the field isosurface in real-time. The `.rex` source is the serialization format, not the authoring interface. The field is visual — it should be authored visually.

But even without visual tooling, the notation is learnable. Three parameters per source (position, strength, falloff) versus dozens of CSS properties per element. And the results are fundamentally different — organic, continuous, responsive without breakpoints, animated without keyframes.

---

## Poisson Layout (Soft Flexbox)

The research doc's Poisson equation section (§152-161) describes an approach not yet in the Field-DOM spec but worth developing: **layout as Laplace solve**.

### The Idea

Given sparse constraints (element positions, sizes, margins), solve the Laplace equation `Δu = 0` in the interior to find the smoothest possible field consistent with those constraints. This is "soft flexbox" — desired positions are boundary conditions, the field finds the smoothest equilibrium.

```
Given:  "sidebar at x=0, width=300" and "content at x=300, fills rest"
Solve:  Δu = 0 with these boundary conditions
Result: Smooth transition region between sidebar and content
```

### Why It Matters

Traditional flexbox is rigid — grow factors and min/max constraints produce sharp transitions. Poisson layout produces C² continuous fields — infinitely smooth. The transition between "sidebar visible" and "sidebar hidden" is not a breakpoint snap but a smooth evolution of the Poisson solution as boundary conditions change.

### GPU Implementation

Jacobi iteration on a 2D grid — the same infrastructure as stable fluids pressure solve:

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

20-40 iterations per frame. Converges fast for UI-scale grids (256×256 to 512×512). Could be added as `:evolution poisson` or `:composition poisson` in the spec.

---

## Jump Flooding for Field Bootstrap

When transitioning from Rex's existing surface elements (@rect, @panel, @text) to field layout, you need to convert rasterized geometry into an SDF. Jump Flooding Algorithm (JFA) does this in O(log₂N) compute passes:

### Algorithm

```
1. Seed: for each pixel on a geometry boundary, store its own position
2. For step_size in [N/2, N/4, N/8, ..., 1]:
   For each pixel:
     Check 8 neighbors at distance step_size
     Keep the nearest seed position
3. Distance field = distance to nearest seed
```

### WGSL Implementation

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

### Use Case

Bootstrap a field from existing Rex surface elements. Render @panel/@rect to a seed texture, run JFA, get an SDF. Use the SDF as a field source with `:type sdf-texture`. This bridges the gap between Rex's current rectangle-based layout and the field paradigm — you can migrate incrementally.

---

## Haptic Field Extensions

The field gradient contains information that maps directly to haptic feedback on devices that support it (game controllers, Apple Taptic Engine, Android haptic actuators):

| Field Property | Haptic Mapping | User Experience |
|---|---|---|
| Gradient magnitude | Vibration intensity | "Feel" the boundary of a UI element |
| Gradient direction | Directional pulse | Guided toward interactive elements |
| Field curvature (Laplacian) | Texture/roughness | Distinguish flat regions from curved transitions |
| Field value at cursor | Continuous pressure | Proportional to "how interactive" the region is |
| Rate of field change (∂φ/∂t) | Transient buzz | Feedback when crossing evolving boundaries |

### API Integration

```javascript
// In anchor fiber, when field gradient data is available via readback:
if (navigator.vibrate) {
  const gradMag = behaviour.getSlotValue('_field_layout', '_grad_magnitude');
  if (gradMag > 0.3) {
    navigator.vibrate(Math.min(gradMag * 20, 50));  // 0-50ms pulse
  }
}

// GamepadHapticActuator (Chrome 68+):
if (gamepad.hapticActuators?.length) {
  gamepad.hapticActuators[0].pulse(gradMag, 16);  // one-frame pulse
}
```

This is speculative — no UI framework does field-driven haptics today. But the data is there (field gradient is computed anyway for rendering and accessibility), and the APIs exist. A field-based UI is the first system where haptic feedback is *mathematically natural* rather than hand-authored.

---

**Total: ~10 days from concept to full field UI system.**

---

## Key References

### Core Techniques
- Inigo Quilez — SDF operations & smooth min: https://iquilezles.org/articles/distfunctions/
- Inigo Quilez — Smooth minimum: https://iquilezles.org/articles/smin/
- Hart — Sphere Tracing: https://graphics.stanford.edu/courses/cs348b-20-spring-content/uploads/hart.pdf
- Jos Stam — Stable Fluids (SIGGRAPH 1999)
- Felzenszwalb & Huttenlocher — Distance Transforms
- Müller et al. — Position-Based Dynamics

### GPU Implementations
- Jamie Wong — Metaballs and WebGL: https://jamie-wong.com/2016/07/06/metaballs-and-webgl/
- Jamie Wong — Ray Marching and SDFs: https://jamie-wong.com/2016/07/15/ray-marching-signed-distance-functions/
- NVIDIA GPU Gems 3, Ch. 7 — Point-Based Metaball Visualization
- kishimisu — WebGPU Fluid Simulation: https://github.com/kishimisu/WebGPU-Fluid-Simulation

### Layout & Interaction
- D3.js Force-Directed Layout: https://github.com/d3/d3-force
- Cassowary Constraint Solver (reformulable as field potentials)
- Level-Set Methods (Sethian): https://math.berkeley.edu/~sethian/
- Reaction-Diffusion Playground: https://jasonwebb.github.io/reaction-diffusion-playground/

### Shape-Changing Interfaces (CHI/UIST)
- Morphees (CHI 2013) — self-actuated flexible devices
- MorpheesPlug (CHI 2021) — shape-changing surface toolkit
- Shape n' Swarm (UIST 2025) — generative swarm UI

### Mathematical Foundations
- Profunctor Optics (Clarke et al. 2020) — composable bidirectional data access
- Poisson Equation — smooth interpolation of sparse constraints
- Hamilton-Jacobi PDE — level-set boundary evolution
- Fourier Feature Networks — coordinate-based neural representations

### Jump Flooding & Distance Transforms
- Rong & Tan — Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform (2006)
- Danielsson — Euclidean Distance Mapping (1980)
- Felzenszwalb & Huttenlocher — Distance Transforms of Sampled Functions (2012)

### Haptic Interaction
- Web Vibration API — https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API
- GamepadHapticActuator — https://developer.mozilla.org/en-US/docs/Web/API/GamepadHapticActuator
- Bau et al. — TeslaTouch: Electrovibration for Touch Surfaces (UIST 2010)
- Schneider et al. — Haptic Experience Design (CHI 2017)

### Rendering Reference
- Vello (Linebender) — GPU compute 2D rendering: https://github.com/linebender/vello
- use.gpu (Steven Wittens) — WebGPU component layer: https://usegpu.live/
- Zed GPUI — GPU-accelerated UI framework: https://www.gpui.rs/
