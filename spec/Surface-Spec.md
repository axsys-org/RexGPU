# Rex Surface Specification v1

**A unified GPU compute pipeline for 2D rendering — text, vector graphics, layout, hit testing, composited shader effects, and UI — that falls out of one primitive: everything is a path, projected through the same Shrub tree, compiled to the same command list.**

---

## The Insight

Don't build 5 subsystems. Build 1 primitive.

- Text glyphs are paths (Bezier outlines from font files)
- UI panels are paths (rounded rectangles)
- Icons are paths (SVG outlines)
- Shadows are paths (blurred, offset copies)
- Hit testing is path membership (is the mouse point inside a path?)
- Layout positions paths (computes transform for each element)
- Effects composite paths (blur, glow, mask — post-process on tiled output)

One compute pipeline: **encode paths → flatten to line segments → tile → rasterize with analytic AA → composite.** This is the Vello architecture, adapted to RPE's transducer model.

The surface transducer claims `@text`, `@rect`, `@path`, `@panel`, `@icon` nodes. It compiles them all to the same scene encoding (paths + brushes + transforms). The compute pipeline renders them in one pass to a storage texture. The final render pass composites the 2D surface over the 3D scene (or uses it as the sole output for UI-only applications).

---

## Part 1: Architecture

```
Rex Tree
  ├── @text "Hello" :size 16 :color [1 1 1 1] :font shrine://fonts/inter
  ├── @rect :x 10 :y 10 :w 200 :h 40 :radius 8 :fill [0.2 0.2 0.3 1]
  ├── @path "M 10 10 L 50 50 Q 80 20 100 50 Z" :fill [1 0 0 1]
  ├── @panel :layout row :padding 8
  │   ├── @text "Button"
  │   └── @icon :src shrine://icons/arrow
  └── @shadow :blur 4 :offset [2 2] :color [0 0 0 0.3]
      └── @rect :x 10 :y 10 :w 200 :h 40 :radius 8

            ↓ Surface Transducer (compile phase)

Scene Encoding:
  paths[]      — line segments (flattened from curves)
  path_info[]  — per-path: seg range, color, transform
  transforms[] — affine 2D transforms
  config       — tile dimensions, path count, etc.

            ↓ GPU Compute Pipeline (execute phase)

  @dispatch flatten   — curves → line segments, compute bboxes
  @dispatch coarse    — assign paths to tiles, build per-tile command lists
  @dispatch fine      — per-pixel analytic AA rasterization → storage texture

            ↓ Render Pass (composite)

  @pass composite     — blit storage texture to canvas (or overlay on 3D scene)
```

### Why Compute, Not Render Passes

Traditional 2D renderers use the hardware rasterizer (triangulated meshes for each shape, MSAA for AA). This approach:
- Requires CPU-side tessellation per shape change
- Burns triangle setup cost on simple shapes (a rectangle is 2 triangles but 6 vertices of setup)
- Needs MSAA (4-8x memory and fill rate) for quality
- Doesn't compose — each shape is a separate draw call

The compute approach (Vello architecture):
- Flattening, tiling, rasterization all in compute shaders
- Analytic anti-aliasing — mathematically exact coverage per pixel, no MSAA
- Sort by screen location, not draw order — all paths touching a tile processed together
- One pipeline for everything — text, shapes, icons, UI

---

## Part 2: Scene Encoding

The surface transducer compiles the tree into a flat scene encoding. This is the same pattern as RPE's command list — compile once, execute per frame.

### Path Encoding

Every visual element becomes paths:

| Node Type | Path Conversion |
|---|---|
| `@text` | Glyph outlines from font (Bezier curves) via HarfBuzz shaping + font parser |
| `@rect` | 4 line segments (or rounded rect: 4 arcs + 4 lines) |
| `@path` | SVG path data parsed to MoveTo/LineTo/QuadTo/CubicTo |
| `@icon` | SVG paths from asset |
| `@panel` | Background rect (after layout computes position/size) |
| `@shadow` | Copy of child paths, offset + blur radius expansion |

### Data Structures

```
@struct SurfaceConfig
  @field width :type u32
  @field height :type u32
  @field width_in_tiles :type u32
  @field height_in_tiles :type u32
  @field n_paths :type u32
  @field n_segments :type u32

@struct PathInfo
  @field seg_start :type u32
  @field seg_count :type u32
  @field color :type u32          ;; RGBA8 packed
  @field flags :type u32          ;; fill rule, element ID for hit testing

@struct LineSeg
  @field p0 :type f32x2
  @field p1 :type f32x2
  @field path_ix :type u32
  @field _pad :type u32
```

### Text Encoding

The surface transducer handles text by:
1. Loading the font (via `shrine://` path → PLAN pin → font bytes)
2. Shaping text with HarfBuzz WASM → positioned glyph IDs
3. For each glyph, extracting Bezier outlines from the font's `glyf`/`CFF` table
4. Flattening curves to line segments (Wang's formula for subdivision count)
5. Adding segments to the scene encoding with the glyph's transform (position + size)

Glyph outlines are cached by `(font_hash, glyph_id)`. Same glyph at different positions reuses the cached segments with different transforms.

### Hit Testing Encoding

Each `PathInfo` carries an `element_id` in its flags field. After the fine rasterizer runs, a separate compute pass checks: is the mouse point inside any path? The path with the highest z-order whose winding number at the mouse position is nonzero → that's the hovered element.

```
@dispatch hit-test
  :pipeline hit-test-compute
  :grid [1 1 1]
  @bind 0 :buffer surface-config :storage path-info :buffer mouse-pos
  @bind 1 :storage hit-result
```

The hit result stays in a storage buffer. The render pass reads it for hover highlighting. CPU reads back only on click. Zero readback for hover visual feedback.

---

## Part 3: The Compute Pipeline

Three compute dispatches, matching the Vello architecture but simplified for RPE's model.

### Dispatch 1: Flatten

```
@dispatch surface-flatten
  :pipeline flatten-compute
  :grid [(n_segments / 256) 1 1]
  @bind 0 :buffer surface-config :storage segments :storage path-info
  @bind 1 :storage path-tiles :storage tile-data :storage tile-segs
  @bind 2 :storage bump-alloc
```

For each line segment:
- Determine which tiles it crosses
- Write tile-local segment data to `tile-segs` (bump-allocated)
- Update backdrop values for tiles to the right of vertical crossings
- Update path bounding boxes via atomics

### Dispatch 2: Coarse

```
@dispatch surface-coarse
  :pipeline coarse-compute
  :grid [(width_in_tiles) (height_in_tiles) 1]
  @bind 0 :buffer surface-config :storage path-info :storage path-tiles
  @bind 1 :storage tile-data :storage ptcl
```

For each tile:
- Check which paths have segments or nonzero backdrop in this tile
- Build per-tile command list (CMD_FILL for partial coverage, CMD_SOLID for full coverage)

### Dispatch 3: Fine

```
@dispatch surface-fine
  :pipeline fine-compute
  :grid [(width_in_tiles) (height_in_tiles) 1]
  @bind 0 :buffer surface-config :storage path-info :storage segments
  @bind 1 :storage tile-data :storage ptcl :storage tile-segs
  @bind 2 :texture surface-output
```

Workgroup size: 16×16 (one thread per pixel in a tile). For each pixel:
- Read tile command list
- For CMD_FILL: compute analytic area coverage from all segments in this tile for this path
- Composite coverage × brush color over running pixel value
- For CMD_SOLID: composite at full coverage (fast path)
- Write to storage texture

---

## Part 4: Layout Engine

Layout positions elements before path encoding. The layout transducer runs on CPU at compile time (or on tree structure change).

### Node Types

```
@panel :layout row :gap 8 :padding 12
  @text "Name:" :size 14
  @rect :w 120 :h 28 :radius 4 :fill [0.15 0.15 0.2 1]
    @text "Enter name" :size 14 :color [0.5 0.5 0.5 1]

@panel :layout column :gap 4
  @panel :layout row :justify space-between
    @text "Score" :size 12
    @text "1,234" :size 12 :color [0 1 0.5 1]
```

### Layout Algorithm

Simplified flexbox:
1. Walk `@panel` tree bottom-up: measure each element's intrinsic size (text: shaped glyph bounds, rect: explicit w×h, panel: sum of children + gap + padding)
2. Walk top-down: assign positions based on layout direction (row/column), alignment, justify
3. Write absolute positions to a layout buffer (or directly into transforms for each path)

Layout runs once per structure change, not per frame. The result is a set of transforms applied to path groups. Dynamic content (scrolling, animation) updates transforms in the heap at compiled offsets — the layout structure is static, only position values change.

### Layout as Optic

The layout output is a transform per element. This transform is stored in the heap at a compiled offset. The surface transducer reads it when encoding paths. An animation (`@channel` from spring physics to element transform) changes the heap value → the surface transducer reads the new transform → the paths render at the new position. No relayout needed.

---

## Part 5: Composited Shader Effects

Effects are post-processing on the tiled output. They operate on the surface texture after the fine rasterizer.

### Blur (for shadows and frosted glass)

Dual Kawase blur — progressively lower resolution:

```
@texture surface-half :width (canvas-w / 2) :height (canvas-h / 2) :format rgba8unorm :render true
@texture surface-quarter :width (canvas-w / 4) :height (canvas-h / 4) :format rgba8unorm :render true

@pass blur-down-1 :target surface-half
  @draw :pipeline kawase-down :vertices 3
    @bind 0 :texture surface-output

@pass blur-down-2 :target surface-quarter
  @draw :pipeline kawase-down :vertices 3
    @bind 0 :texture surface-half

@pass blur-up-1 :target surface-half
  @draw :pipeline kawase-up :vertices 3
    @bind 0 :texture surface-quarter

@pass blur-up-2 :target surface-output
  @draw :pipeline kawase-up :vertices 3
    @bind 0 :texture surface-half
```

This is expressible TODAY with render-to-texture. The surface spec just makes it a reusable pattern.

### Analytical Shadows

For rectangular UI elements, skip blur entirely. Use the analytical erf-based shadow:

```wgsl
fn rounded_rect_shadow(p: vec2f, rect_center: vec2f, rect_half: vec2f,
                        radius: f32, blur: f32, offset: vec2f) -> f32 {
    let d = abs(p - rect_center - offset) - rect_half + vec2f(radius);
    let dist = length(max(d, vec2f(0.0))) - radius;
    return 1.0 - smoothstep(-blur, blur, dist);
}
```

One fragment shader evaluation. No multi-pass blur. This is how the surface transducer renders `@shadow` for rectangular elements.

---

## Part 6: Compute-to-Render Dataflow Automation

The surface pipeline is 3 compute dispatches + 1 render pass, all sharing storage buffers. This is the pattern that needs automated dataflow wiring.

### The Problem

Currently each `@bind` explicitly names every buffer. For a pipeline with 6 storage buffers shared across 4 dispatches, that's 24 bind declarations. Verbose and error-prone.

### The Solution: Resource Scoping

Introduce `@resources` as a shared scope:

```
@resources surface-resources
  @buffer surface-config :struct SurfaceConfig
  @buffer segments :usage [storage] :size 2000000
  @buffer path-info :usage [storage] :size 100000
  @buffer path-tiles :usage [storage] :size 500000
  @buffer tile-data :usage [storage] :size 1000000
  @buffer ptcl :usage [storage] :size 2000000
  @buffer tile-segs :usage [storage] :size 4000000
  @buffer bump-alloc :usage [storage] :size 32
  @texture surface-output :width (canvas-w) :height (canvas-h) :format rgba8unorm :render true

@dispatch surface-flatten
  :pipeline flatten-compute
  :grid [(n_segments / 256) 1 1]
  :resources surface-resources

@dispatch surface-coarse
  :pipeline coarse-compute
  :grid [(width_in_tiles) (height_in_tiles) 1]
  :resources surface-resources

@dispatch surface-fine
  :pipeline fine-compute
  :grid [(width_in_tiles) (height_in_tiles) 1]
  :resources surface-resources
```

The `:resources` attribute tells the compiler: "this dispatch/pass uses buffers from this resource scope." The compiler resolves which buffers each shader actually reads/writes (from shader reflection or explicit annotation) and generates the bind groups automatically.

### Implementation

In the compile phase:
1. Walk `@resources` nodes, create all buffers/textures
2. For each `@dispatch`/`@pass` with `:resources`, inspect the shader to determine which bindings are needed (or use explicit `@bind` annotations within the `@resources` scope)
3. Generate bind groups that match the shader's expected layout
4. The barrier schedule infers hazards from the resource scope — if dispatch A and dispatch B both reference `surface-resources`, and A writes to a buffer that B reads, the barrier is automatic

This closes Gap 13 (compute-to-render dataflow) and Gap 6 (explicit pipeline layouts) simultaneously. The `@resources` scope IS the explicit bind group layout — all dispatches/passes that reference it share the same layout.

---

## Part 7: Explicit Pipeline Layouts via @resources

The `@resources` node solves explicit pipeline layouts as a side effect:

```
@resources scene-globals
  @buffer scene-uniforms :struct SceneUniforms
  @buffer light-data :usage [storage] :size 100000

@pipeline mesh-pipe
  :vertex mesh-vert :fragment mesh-frag
  :resources scene-globals    ;; bind group 0 from this scope
  :depth true

@pipeline shadow-pipe
  :vertex shadow-vert :fragment shadow-frag
  :resources scene-globals    ;; SAME bind group 0 layout
  :depth true

@pipeline particle-pipe
  :vertex particle-vert :fragment particle-frag
  :resources scene-globals    ;; SAME bind group 0 layout
  :blend additive
```

All three pipelines share bind group 0 because they reference the same `@resources` scope. The compiler generates ONE `GPUBindGroupLayout` for `scene-globals` and uses it in all three pipeline layouts. Bind group 0 is created once and set once per frame — not recreated per draw call.

### Compile Implementation

```javascript
// In _compile(), new step between struct compilation and pipeline creation:
_compileResourceScopes(tree) {
    this._resourceScopes = new Map();
    for (const res of Rex.findAll(tree, 'resources')) {
        const scope = { name: res.name, buffers: new Map(), textures: new Map() };
        // Create buffers/textures from children
        for (const child of res.children) {
            if (child.type === 'buffer') { /* create/register */ }
            if (child.type === 'texture') { /* create/register */ }
        }
        // Generate GPUBindGroupLayout from scope contents
        scope.layout = this._createLayoutFromScope(scope);
        scope.bindGroup = this._createBindGroupFromScope(scope);
        this._resourceScopes.set(res.name, scope);
    }
}

// In _buildPipeline(), when pipeline has :resources attribute:
if (pNode.attrs.resources) {
    const scope = this._resourceScopes.get(pNode.attrs.resources);
    desc.layout = this.device.createPipelineLayout({
        bindGroupLayouts: [scope.layout, /* additional groups */]
    });
}
```

---

## Part 8: Swift ABI Lesson — Resilience by Default

Swift's ABI design (Aria Beingessner, "How Swift Achieved Dynamic Linking Where Rust Couldn't") provides a key insight for the Shrub data model:

**Hide layout details behind accessors by default. Freeze only when you commit.**

In RPE terms:
- A `@slot` is resilient by default — accessed through an optic (getter/setter). The layout can change between versions.
- When RPE compiles a `@slot` to a heap byte offset, that's the "frozen" optimization — the optic resolves to a direct memory write.
- The optic IS the accessor. The heap offset IS the frozen ABI.
- Cross-module boundaries (Shrine namespace) use resilient access (optic path resolution). Within a compiled scene, everything is frozen (byte offsets).

This means:
- Templates can add/remove `@slot`s without breaking consumers that access through paths
- `@resources` scopes are frozen within a scene (compiled to explicit layouts) but resilient across module boundaries
- The behaviour transducer's `@derive` and `@talk` access slots through optics — resilient by default, frozen by the compile phase

The surface spec inherits this: the layout engine resolves positions through optics. The surface transducer reads transforms at compiled offsets. Animation channels write new transform values without relaying. The optic boundary is the resilience boundary.

---

## Part 9: Integration

### With RPE

The surface pipeline is a series of `@dispatch` + `@pass` nodes compiled by the existing GPU transducer. No new transducer needed for the GPU side — the surface transducer's job is converting `@text`/`@rect`/`@path`/`@panel` into scene encoding data. The GPU transducer handles the compute dispatches and render passes.

### With Behaviour

`@panel` nodes can have `@talk` entry points (click handlers, hover handlers). The hit test result feeds back through `@interact` → form state → behaviour `@talk`. Interactive GPU-rendered UI without DOM.

### With PCN

Every UI interaction (click, hover, drag on a surface element) becomes a PCN episode. The connectome learns UI interaction patterns. Affordances can target surface elements — "move this panel here" executes as a transform optic write.

### With PLAN

Surface assets (fonts, icons) resolve through `shrine://` → PLAN pins. Font glyph caches are pinnable for persistence. Layout state is part of the tree pin — undo restores layout.

---

## Part 10: Phases

### Phase 1: Minimal Surface (~1 week)
- Scene encoding for `@rect` (filled rectangles, no curves)
- 3 compute shaders (flatten, coarse, fine) — line segments only
- Solid color fills, analytic AA
- Hit testing compute pass
- `@resources` scoping for dataflow automation

### Phase 2: Text (~1 week)
- HarfBuzz WASM integration for text shaping
- Font glyph outline extraction (parse TrueType `glyf` table for quadratic Beziers)
- Curve flattening (Wang's formula) in flatten shader
- Glyph caching by `(font_hash, glyph_id)`
- `@text` node compilation

### Phase 3: Layout + Panels (~1 week)
- Simplified flexbox layout engine (row/column/gap/padding)
- `@panel` compilation to background rect + layout children
- Transform composition for nested panels
- Scroll state as heap optic

### Phase 4: Effects + Polish
- Dual Kawase blur for shadows/glass
- Analytical shadows for rectangular elements
- Gradient fills (linear, radial)
- Stroke rendering (CPU-side expansion initially)
- SVG path parsing for `@path` and `@icon`
- `@shadow` node compilation

### Phase 5: Self-Hosting
- Render the Rex editor as a surface
- Text input via `@text-editor` node (cursor state in heap, keyboard input → behaviour `@talk`)
- Panel system for editor panes
- The DOM bootstrap dissolves

---

## Design Principles

```
EVERYTHING IS A PATH.              Text, rects, icons, panels — all Bezier outlines.
ONE PIPELINE.                      Flatten → tile → rasterize. No special cases.
SORT BY LOCATION.                  Process all paths per tile, not all tiles per path.
ANALYTIC AA.                       Exact coverage per pixel. No MSAA. No supersampling.
LAYOUT IS COMPILE-TIME.            Positions computed once. Animation changes transforms, not layout.
HIT TESTING IS PATH MEMBERSHIP.    Same paths, same winding rule, different query.
RESOURCES SCOPE DATAFLOW.          @resources = shared bind group layout + automatic barrier inference.
OPTICS ARE RESILIENT ACCESSORS.    Freeze to offsets within a scene. Resilient across boundaries.
THE SURFACE IS A TRANSDUCER.       @text → paths. @rect → paths. @panel → layout + paths.
THE GPU TRANSDUCER RENDERS PATHS.  Same @dispatch/@pass infrastructure. Nothing new.
```

---

## References

- **Vello** (Raph Levien / Google Fonts / Linebender). Fully-compute 2D GPU renderer. Sort-middle architecture, analytic AA, tiled rasterization. The architectural model for the surface pipeline.
- **Swift ABI** (Aria Beingessner). Resilience by default, freeze when you commit. Applied to Shrub slot access through optics.
- **Blender GPU Compositor.** Per-node dispatch, texture pool for intermediates. The `@resources` scoping pattern generalizes this.
- **RPE Specification v2.** Parts 5, 11, 12, 20. The surface pipeline is expressed entirely as RPE @dispatch/@pass nodes.
- **Behaviour Specification v1.** Parts 4-5. @talk on surface elements enables interactive UI.
- **Profunctor Optics.** Clarke et al. 2020. Layout output as transform optic. Hit testing as inverse optic. Animation channels as composed optics.
