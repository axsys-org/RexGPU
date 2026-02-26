# RPE-05: Overflow & Resilience — Graceful Degradation

## The Problem

Current prototypes have hard limits (`maxPrims = 128`, `maxLights = 8`). Exceeding them silently truncates. AAA scenes require millions of triangles, thousands of instances, hundreds of materials. The system must handle:

1. **Buffer overflow**: more instances than allocated buffer space
2. **Memory pressure**: GPU VRAM exhaustion
3. **Shader complexity**: per-pixel cost exceeds frame budget
4. **Draw call budget**: too many material buckets
5. **Bandwidth limits**: staging buffer upload exceeds bus capacity
6. **Compilation failure**: malformed shaders, invalid pipelines

## Design Principle: Never Crash, Always Degrade

Inspired by Levin's pattern homeostasis — the system maintains the *best available approximation* of the target morphology at all times. It never shows black screens, broken geometry, or undefined state.

## Overflow Tiers

### Tier 0: Normal Operation
All instances rendered at full quality. Frame budget met.

### Tier 1: LOD Pressure
Frame budget exceeded. Response:
- Increase LOD bias globally (coarser meshes)
- Reduce shadow cascade distance
- Lower post-process quality (half-res bloom, skip SSR)
- Monitoring: GPU timestamp queries per pass

### Tier 2: Instance Pressure
Instance count exceeds buffer capacity. Response:
- Distance-based culling (stricter than frustum)
- Merge distant instances into impostor billboards
- Reduce instance buffer, recompile affected optics
- Compile phase: mark overflow instances with `@overflow-policy`

```
@scene
  @platonic tree
    :overflow-policy billboard-at 50   ;; billboard beyond 50m
    :overflow-priority 2               ;; cull before priority 1
    @mesh :source /assets/tree.glb
    @billboard :source /assets/tree-billboard.png
```

### Tier 3: Memory Pressure
GPU VRAM approaching limit. Response:
- Evict lowest-priority textures (replace with 1x1 average color)
- Drop highest LOD meshlets (keep lowest LOD only)
- Reduce render target resolution (dynamic resolution scaling)
- Compact buffers: remove gaps from culled instances

### Tier 4: Emergency
System cannot maintain coherent rendering. Response:
- Skybox + ground plane only
- Single-material flat shading on visible geometry
- Disable post-processing entirely
- Large "DEGRADED" watermark (debug builds)
- Log full diagnostic state for analysis

## Buffer Management Strategy

### Dynamic Resize

Instead of fixed `maxPrims`, buffers grow and shrink:

```
Initial allocation: scene_buffer = 64KB (1024 instances × 64 bytes)
Tree adds instances beyond 1024:
  1. Allocate new buffer: 128KB (2048 instances)
  2. Copy existing data
  3. Recompile optics for new base offset
  4. Swap bind group
  5. Destroy old buffer (deferred to next fence)
```

Growth factor: 2× (amortized O(1) per instance add). Shrink trigger: usage drops below 25% of capacity.

### Ring Buffer for Staging

Per-frame uploads use a ring buffer to avoid fence stalls:

```
┌─────────────────────────────────┐
│ Frame N   │ Frame N+1 │ Free    │
│ (in flight)│ (writing) │         │
└─────────────────────────────────┘
             ↑ write pointer
```

Ring buffer sized for 3 frames of max dirty data. If dirty data exceeds ring capacity, coalesce and drop low-priority updates.

### Transient Resource Pool

Render targets that exist only for one pass share physical memory:

```
Pass 1: writes albedo_rt    ← uses physical page A
Pass 2: writes normal_rt    ← uses physical page B  
Pass 3: reads albedo_rt, normal_rt, writes hdr_rt ← uses physical page C
Pass 4: reads hdr_rt, writes tonemap_rt ← albedo_rt dead, reuse page A
```

Compile phase computes interference graph (which resources are live simultaneously), performs graph coloring to minimize physical allocations. Frostbite-style frame graph resource management.

## Error Recovery

### Shader Compilation Failure

```
compile_result = device.createShaderModule({ code: wgsl });
if (compile_result.error) {
  log_error(node_path, compile_result.error);
  use_fallback_shader(node_path);   // solid color, wireframe, or last-good
  mark_node_errored(node_path);     // visual indicator in editor
}
```

Fallback shader: flat magenta (classic "missing material" indicator for 3D), red outline for UI elements. Never invisible, always diagnosable.

### Pipeline Creation Failure

If a PSO fails to create (incompatible formats, missing entry points), the pass that uses it is skipped. Other passes continue rendering. Error visible in tree inspector and log.

### Buffer Upload Failure

If `writeBuffer` fails (device lost, OOM), the engine:
1. Retries with reduced data (skip low-priority micro-patches)
2. If still failing, freeze last-good frame and attempt device recovery
3. If device lost, reinitialize WebGPU context and recompile from tree

### Tree Parse Error

If live-editing introduces parse errors:
- Last successfully parsed tree remains active
- Error indicator in editor (line number, message)
- No visual disruption

## Monitoring & Diagnostics

### Per-Frame Metrics (available as tree-readable attributes)

```
/engine/metrics/frame-time-ms         ;; total CPU+GPU
/engine/metrics/cpu-time-ms           ;; CPU-side only
/engine/metrics/gpu-time-ms           ;; GPU timestamp delta
/engine/metrics/cull-pass-ms          ;; compute cull time
/engine/metrics/draw-pass-ms          ;; rasterization time
/engine/metrics/post-pass-ms          ;; post-processing time
/engine/metrics/ui-pass-ms            ;; UI rendering time
/engine/metrics/staging-bytes         ;; bytes uploaded this frame
/engine/metrics/instance-count        ;; total instances in scene
/engine/metrics/visible-count         ;; after culling
/engine/metrics/draw-call-count       ;; MDI batches submitted
/engine/metrics/buffer-utilization    ;; % of allocated buffer used
/engine/metrics/overflow-tier         ;; current degradation tier (0-4)
/engine/metrics/vram-used-mb          ;; estimated GPU memory usage
```

These are PCN-readable — UI elements can bind to them for live monitoring overlays. The engine eats its own dogfood.

### Diagnostic Overlays

```
@ui-overlay debug-stats
  :visible /engine/debug-mode
  @text :content (format "%.1f ms" /engine/metrics/frame-time-ms)
  @text :content (format "%d/%d visible" /engine/metrics/visible-count /engine/metrics/instance-count)
  @text :content (format "Tier %d" /engine/metrics/overflow-tier)
```

## Adaptive Quality

### Resolution Scaling

```
@quality-policy
  :target-fps 60
  :min-resolution-scale 0.5
  :max-resolution-scale 1.0
  :adaptation-speed 0.1         ;; lerp factor per frame

;; If frame time > 16.6ms, reduce render resolution
;; If frame time < 14ms, increase render resolution
;; Never below 50% native, never above 100%
```

### Material Complexity Scaling

When shading pass exceeds budget:
1. Disable parallax mapping
2. Reduce texture sample count (skip detail textures)
3. Simplify lighting model (skip subsurface scattering)
4. Fall back to unlit for distant objects

Each simplification is a specialization constant in the uber-shader. Switching is a PSO swap, not a recompile.
