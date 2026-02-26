# RPE-04: Text, Vector & 2D — Slug Integration and UI Rendering

## Text Rendering: Slug-Style GPU Glyphs

### Why Slug (Not SDF, Not Bitmaps)

| Method | Magnification | Minification | Sharp Corners | Memory | GPU Cost |
|--------|--------------|--------------|---------------|--------|----------|
| Bitmap atlas | Blurry | Aliased | No | Low | Low |
| SDF (Green) | Smooth but rounded | Good | No | Medium | Low |
| MSDF | Good | Good | Yes | Medium | Medium |
| **Slug (Bézier)** | **Perfect** | **Perfect** | **Yes** | **Low** | **Medium** |

Slug renders directly from quadratic Bézier curve data. No precomputed textures. Resolution-independent at any scale, rotation, or perspective. This is non-negotiable for RPE because:

1. Text must work in 3D world space (signs, HUD in VR, floating labels)
2. Text must work in 2D UI at arbitrary DPI
3. Same rendering path for both → unified pipeline

### Rex Text Node Specification

```
@text hero-name
  :content "WARRIOR"
  :font /assets/fonts/inter.slug
  :size 24
  :color [1 1 1 1]
  :align center
  :pos [0 2.5 0]           ;; 3D world position
  :face-camera true         ;; billboard mode
  :kerning true
  :ligatures true

@text ui-score
  :content (format "Score: %d" /game/score)
  :font /assets/fonts/mono.slug
  :size 14
  :color [0.8 0.9 1.0 1.0]
  :screen-pos [0.95 0.05]  ;; normalized screen coords (top-right)
  :anchor top-right
```

### Glyph Pipeline

1. **Compile phase**: Load `.slug` font data → glyph curve storage buffer
2. **Layout phase**: String → glyph sequence with kerning, ligatures, positioning
3. **Vertex generation**: Per-glyph quad (bounding box of glyph outline)
4. **Fragment shader**: For each pixel in quad, evaluate Bézier winding number
   - Determines coverage analytically
   - Anti-aliased at all scales via exact coverage computation
   - No sampling artifacts, no distance field approximation

### WGSL Glyph Shader (Slug-style core)

```wgsl
// Simplified — real implementation handles band optimization + robustness
fn evaluateGlyphCoverage(uv: vec2f, curveOffset: u32, curveCount: u32) -> f32 {
    var winding: f32 = 0.0;
    for (var i = curveOffset; i < curveOffset + curveCount; i++) {
        let curve = glyph_curves[i];  // p0, p1, p2 (quadratic Bézier)
        let p0 = curve.p0 - uv;
        let p1 = curve.p1 - uv;
        let p2 = curve.p2 - uv;
        winding += computeBezierWinding(p0, p1, p2);
    }
    return clamp(winding, 0.0, 1.0);
}
```

Band optimization: subdivide glyph bounding box into horizontal bands, pre-compute which curves intersect each band. Fragment shader only evaluates relevant curves. Massive perf win for complex glyphs.

## Vector Graphics

### Bézier Path Rendering

Same technology as text, generalized to arbitrary paths:

```
@vector icon-settings
  :path "M12 15.5A3.5 3.5 0 0 1 8.5 12 ..."  ;; SVG path data
  :fill [0.7 0.7 0.8 1.0]
  :stroke [1 1 1 1]
  :stroke-width 1.5
  :pos [10 10]             ;; screen pixels
  :size [24 24]
```

Compile phase: parse SVG path → quadratic Bézier approximation → curve storage buffer. Same shader path as text glyphs. Icons, diagrams, charts — all resolution-independent, all GPU-rendered.

### SVG Subset Support

RPE supports the SVG path command subset needed for UI icons and simple graphics:
- `M/m` (moveto), `L/l` (lineto), `C/c` (cubic Bézier → converted to quadratics)
- `Q/q` (quadratic Bézier — native), `A/a` (arc → Bézier approximation)
- `Z` (close path)

Complex SVG features (filters, masks, gradients) handled by specialized shader variants compiled from tree annotations.

## 2D UI Rendering

### Layout Engine

Rex tree IS the layout specification. No external CSS, no framework:

```
@ui-root
  :layout flex
  :direction column
  :width (canvas-w)
  :height (canvas-h)
  
  @ui-panel header
    :layout flex
    :direction row
    :height 48
    :padding [8 16]
    :bg [0.08 0.08 0.12 0.95]
    
    @text :content "RPE" :size 14 :color [0.48 0.64 0.97]
    @ui-spacer :flex 1
    @text :content (format "%d fps" /engine/fps) :size 11 :color [0.6 0.8 0.4]
  
  @ui-panel viewport
    :flex 1
    :bg transparent
    ;; 3D scene renders here via @pass
  
  @ui-panel toolbar
    :layout flex
    :direction row
    :height 36
    :gap 4
    :padding [4 8]
    :bg [0.06 0.06 0.1 0.9]
    
    @ui-button :label "Play" :on-click /game/toggle-play
    @ui-button :label "Reset" :on-click /game/reset
```

### Layout Algorithm

Compile phase computes layout boxes (flexbox subset):

1. **Measure**: Bottom-up — leaf nodes report intrinsic size (text extent, image size, `:width`/`:height`)
2. **Layout**: Top-down — parent distributes space to children based on `:layout`, `:flex`, `:gap`, `:padding`
3. **Position**: Absolute screen positions stored in UI buffer
4. **Clip**: Compute clip rects for scrollable regions

Output: flat buffer of `(x, y, w, h, clip_rect, bg_color, border_radius, ...)` per UI element. Compiled as optics — attribute change (e.g., `:height 48` → `:height 64`) triggers relayout of affected subtree only.

### UI Draw Pipeline

```
@pass ui-render
  :load keep              ;; don't clear — overlay on 3D
  :depth-test false
  :blend alpha
  
  @draw ui-backgrounds    ;; rounded rects, panels
    :pipeline ui-rect
    :instances (ui-element-count)
  
  @draw ui-text           ;; all text glyphs
    :pipeline slug-text
    :instances (ui-glyph-count)
  
  @draw ui-icons          ;; vector icons
    :pipeline slug-vector
    :instances (ui-icon-count)
```

All UI elements render in a single pass with three draw calls (backgrounds, text, icons). Each draw is instanced — instance data comes from the compiled UI buffer.

### Interaction Model

UI elements declare interaction handlers as PCN channels:

```
@ui-button play-btn
  :label "Play"
  :on-click /game/toggle-play      ;; PCN channel target
  :on-hover /ui/play-btn/hovered   ;; state for visual feedback
  :style-hover                      ;; compiled visual variant
    :bg [0.2 0.3 0.5]
```

Hit testing: compute shader tests pointer position against UI element bounding boxes (sorted by z-order). Fires PCN channel on match. Visual state changes flow through the same optic micro-patch system.

## Mixed 2D/3D Compositing

### Render Order

```
Frame:
  1. 3D scene pass (g-buffer or forward)
  2. 3D lighting + post-process
  3. 3D world-space text (Slug, depth-tested)
  4. UI background pass (no depth test, alpha blend)
  5. UI text pass (Slug, screen-space)
  6. UI vector pass (icons, indicators)
```

World-space text (floating labels, damage numbers) renders WITH depth testing in the 3D pipeline. Screen-space UI renders AFTER, without depth. Same Slug shader, different pass configuration.

### Text-in-World Quality

For text placed in 3D world at oblique angles:
- Slug's analytic coverage handles anisotropic filtering naturally
- No mipmap artifacts (there are no mipmaps — it's curves)
- Antialiasing quality maintained at any angle
- Band optimization adapts to screen-space pixel density

This is where Slug's advantage over SDF is most visible — SDF methods blur at grazing angles while Slug remains sharp.

## Font Management

```
@font-registry
  @font inter
    :source /assets/fonts/Inter-Regular.slug
    :weight 400
  @font inter-bold
    :source /assets/fonts/Inter-Bold.slug
    :weight 700
  @font mono
    :source /assets/fonts/JetBrainsMono-Regular.slug
    :weight 400
    :features [liga calt]    ;; OpenType features to enable
```

Font data loaded into shared glyph curve buffer. Multiple fonts coexist — glyph shader receives curve buffer offset per glyph. Font switching is zero-cost (just different offset into same buffer).
