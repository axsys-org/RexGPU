# RPE-03: GPU Pipeline — Aaltonen-Aligned Architecture

## Design Philosophy

Following Aaltonen's "No Graphics API" thesis: the GPU is a processor with memory and compute units. Everything between your data and the hardware is overhead. RPE minimizes that overhead by compiling tree structure directly to GPU memory layouts.

### Aaltonen's Core Principles Applied

1. **Everything is GPU memory + pointers** — Rex paths compile to `(buffer_id, byte_offset, byte_length)` tuples. No descriptor sets, no binding tables, no root signatures at the optic level.

2. **Unified descriptor heap** — All textures, all buffers accessible via 32-bit heap indices. A `@material` node carries `:albedo-tex 47` where 47 is a heap index. No "buffer zoo."

3. **Bindless by default** — Shaders access resources via indices loaded from the scene buffer. No per-draw binding changes. One bind group per frame, everything indexed.

4. **Single shader language** — WGSL in the tree, cross-compiled via SPIRV-Cross for non-WebGPU backends. Shaders are tree nodes, not external files.

5. **Minimal API surface** — The tree notation IS the API. Users don't call `createBuffer()` — they write `@buffer name :struct Type :usage [storage]` and the compile phase handles everything.

## Memory Architecture

### Buffer Strategy

```
┌─ Scene Buffer (SSBO) ─────────────────────┐
│ Instance 0: [transform|material_id|flags]  │
│ Instance 1: [transform|material_id|flags]  │
│ ...                                        │
│ Instance N: [transform|material_id|flags]  │
└────────────────────────────────────────────┘

┌─ Material Buffer (SSBO) ──────────────────┐
│ Mat 0: [albedo_idx|normal_idx|PBR_params]  │
│ Mat 1: [albedo_idx|normal_idx|PBR_params]  │
│ ...                                        │
└────────────────────────────────────────────┘

┌─ Geometry Buffer (SSBO) ──────────────────┐
│ Meshlet 0: [vertex_data|index_data|bounds] │
│ Meshlet 1: [vertex_data|index_data|bounds] │
│ ...                                        │
└────────────────────────────────────────────┘

┌─ Indirect Args Buffer ────────────────────┐
│ Draw 0: [index_count|instance_count|...]   │
│ Draw 1: [index_count|instance_count|...]   │
│ ...                                        │
└────────────────────────────────────────────┘
```

All four buffers are SSBOs (storage buffers). Shaders access them via binding index. Instance shaders read `scene_buffer[instance_id]` to get transform + material, then `material_buffer[material_id]` to get texture indices.

### SOA/AOS Selection from Tree

```
@buffer instances
  :struct InstanceData
  :layout soa          ;; positions contiguous, then rotations, then materials
  :count 65536

@buffer instances
  :struct InstanceData
  :layout aos          ;; per-instance: [pos, rot, mat] interleaved
  :count 65536
```

SOA optimal for compute culling (reads only positions). AOS optimal for vertex shading (reads all per-instance data). The optic compiler handles the layout difference — tree paths map to correct offsets regardless.

### CPU-Mapped Staging

Following Aaltonen's CUDA-style malloc: staging buffer is CPU-mapped. Attribute micro-patches write directly to staging at the pre-compiled offset. One `writeBuffer` per frame uploads the dirty region.

```
Frame N:
  1. Dirty optics identify changed byte ranges in staging buffer
  2. Coalesce adjacent dirty ranges
  3. Single writeBuffer for coalesced range
  4. GPU reads from device-local buffer (copy happens on GPU timeline)
```

## Compile Phase Detail

### Stage 1: Tree Walk → Optic Map
```
/scene/hero/transform  →  { buffer: SCENE, offset: 0,    size: 64, format: mat4x4 }
/scene/hero/material   →  { buffer: SCENE, offset: 64,   size: 4,  format: u32 }
/scene/hero/flags      →  { buffer: SCENE, offset: 68,   size: 4,  format: u32 }
/scene/npc_0/transform →  { buffer: SCENE, offset: 128,  size: 64, format: mat4x4 }
```

Each optic is a pre-computed accessor. At runtime, changing `/scene/hero/transform` writes 64 bytes at offset 0. No path resolution needed.

### Stage 2: Shader Compilation
Tree-embedded shaders compile to WGSL modules:

```
@shader pbr-lit
  ;; WGSL content block
  struct InstanceData {
    transform: mat4x4f,
    material_id: u32,
    flags: u32,
  }
  @group(0) @binding(0) var<storage, read> instances: array<InstanceData>;
  @group(0) @binding(1) var<storage, read> materials: array<MaterialData>;
  // ... vertex + fragment entry points
```

Compile phase: `device.createShaderModule({ code: node.content })`.
PSO permutations generated from `@pipeline` annotations.

### Stage 3: Render Graph Extraction

```
@pass g-buffer
  :target [albedo normal depth]
  :clear [0 0 0 1]
  @draw :pipeline pbr-deferred ...

@pass lighting
  :read [albedo normal depth]
  :target [hdr-color]
  @dispatch :pipeline deferred-lighting ...

@pass tonemap
  :read [hdr-color]
  :target canvas
  @draw :pipeline fullscreen-tonemap ...
```

Compile phase extracts:
- Pass dependency graph from `:read` / `:target` declarations
- Topological sort for execution order
- Barrier points (read-after-write between passes)
- Transient resource lifetimes (allocate on first use, alias after last)
- Frostbite-style resource aliasing: non-overlapping lifetimes share physical memory

### Stage 4: Meshlet Generation

For mesh shader pipeline:
```
@mesh hero-body
  :source /assets/hero.glb
  :meshlet-size 64          ;; max vertices per meshlet
  :meshlet-prims 124        ;; max primitives per meshlet
  @lod 0 :distance 0
  @lod 1 :distance 20 :reduction 0.5
  @lod 2 :distance 50 :reduction 0.25
```

Offline/compile-time: subdivide mesh into meshlets, compute per-meshlet bounding spheres and normal cones for backface culling. Store in geometry buffer.

## Execute Phase Detail

### Per-Frame Pipeline

```
1. UPDATE DYNAMICS
   - Evaluate tree expressions (time, input, PCN outputs)
   - Micro-patch staging buffer via compiled optics
   - Upload staging → device buffer

2. CULL (Compute)
   - Input: scene buffer (positions), camera frustum
   - Output: visibility bitfield, indirect draw args
   - One dispatch, reads SOA position array
   - Per-instance: frustum test → set bit
   - Per-meshlet (optional): backface cone test, occlusion

3. COMPACT (Compute)
   - Prefix sum on visibility bits
   - Scatter visible instance indices into compacted buffer
   - Write indirect draw args (instance count per material bucket)

4. RENDER
   - For each material bucket:
     - One MDI (MultiDrawIndirect) call
     - Vertex shader: load instance data via instance_id
     - Fragment shader: load material via material_id from instance
   - OR visibility buffer path:
     - Single draw of all geometry → uint32 primitive IDs
     - Compute pass: shade visible pixels using material lookups

5. POST-PROCESS
   - Tonemap, bloom, FXAA/TAA
   - UI overlay (2D pass, see RPE-04)
   - Text rendering (Slug pass, see RPE-04)
```

### Visibility Buffer Path (for complex scenes)

When material count is high (hundreds of materials with different shaders), the traditional forward/deferred split becomes expensive. Visibility buffer approach:

1. **V-Buffer Pass**: Rasterize all geometry writing only `(instance_id << 16 | primitive_id)` as uint32 per pixel. Minimal bandwidth. No material evaluation.

2. **Shade Pass**: Compute shader reads v-buffer. For each pixel:
   - Reconstruct triangle from geometry buffer using primitive_id
   - Compute barycentrics analytically (no stored barycentrics needed)
   - Load material from material buffer
   - Evaluate full PBR shading
   
Benefits: zero overdraw waste (shade only visible pixels), arbitrary material count, analytically correct LOD derivatives.

Matches Wicked Engine 2024 approach and Alan Wake 2's GPU-driven mesh shader pipeline.

## Unified Shader Model

### One Shader Language, All Targets

```
@shader-lang wgsl                          ;; primary
@shader-cross spirv → [msl, hlsl, glsl]   ;; cross-compile for backends
```

Tree-embedded WGSL is canonical. For Vulkan/Metal/D3D12 backends, compile phase runs SPIRV-Cross to produce target language. Shader source lives in the tree — no external files.

### Uber-Shader with Specialization

Rather than combinatorial PSO explosion, use specialization constants:

```
@shader pbr-uber
  override HAS_NORMAL_MAP: bool = false;
  override HAS_EMISSIVE: bool = false;
  override ALPHA_MODE: u32 = 0;  // 0=opaque, 1=mask, 2=blend
  
  @fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
    var albedo = textureSample(textures[mat.albedo_idx], sampler, in.uv);
    if (ALPHA_MODE == 1u && albedo.a < mat.alpha_cutoff) { discard; }
    var N = in.normal;
    if (HAS_NORMAL_MAP) { N = perturbNormal(in, mat.normal_idx); }
    // ... PBR lighting
  }
```

Compile phase creates PSO variants based on material combinations found in the tree. Only used combinations get compiled.

## WebGPU-Specific Constraints

### Current Limits to Design Around
- No mesh shaders (yet) → vertex pulling via storage buffers
- No 64-bit atomics → no SW rasterizer tricks
- Limited indirect dispatch → separate dispatch per pass
- No work graphs → explicit compute → render → compute sequencing
- `maxStorageBufferBindingSize` varies (128MB–2GB) → chunk large scenes

### Future Path
When WebGPU gains mesh shaders:
- Switch from vertex pulling to native mesh shader pipeline
- Amplification shader for meshlet culling
- Single dispatch per mesh pass

When D3D12 Work Graphs become available:
- Entire render graph as single GPU-side work graph dispatch
- RPE's `@pass` topology maps directly to work graph node topology
- CPU submits only camera + one `DispatchGraph`

## Budget System

Per-frame GPU time budget:

```
@budget
  :target-ms 16.6          ;; 60fps
  :cull-max-ms 1.0
  :geometry-max-ms 6.0
  :shading-max-ms 6.0
  :post-max-ms 2.0
  :ui-max-ms 1.0
  :headroom-ms 0.6
```

Compile phase assigns budget to each pass. Execute phase monitors (via GPU timestamps) and triggers LOD/quality adjustments when budgets are exceeded. This feeds into the overflow manager (RPE-05).
