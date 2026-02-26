# RPE-00: Rex Projection Engine — Architecture Overview

## Purpose

The Rex Projection Engine (RPE) is a tree-to-GPU compiler that projects Rex notation into visual surfaces — from AAA 3D scenes to 2D UI panels — through a single unified pipeline. This document is the master index and architectural spine.

## Core Thesis

**The tree IS the frame.** A Rex tree fully describes every GPU resource, every shader, every draw call, every UI widget, every text glyph. The RPE's job is *projection*: compiling tree structure into GPU state, then executing that state each frame with zero tree traversal.

## What We Already Have (Shrine)

Shrine is the existing substrate. RPE does NOT reinvent:

| Shrine Provides | RPE Uses It For |
|---|---|
| Rex parser (indentation-based tree notation) | All input parsing — scene, UI, shaders, config |
| Path resolution (`/scene/obj/transform`) | Optic compilation targets |
| Attribute system (`:key value`, inline attrs) | Per-node data, shader params, layout props |
| Platonic definitions (`@platonic`) | Template/instancing system |
| Expression evaluation (`(elapsed)`, `(canvas-size)`) | Per-frame dynamic values |
| PCN behavior composition | Reactive dataflow between tree regions |

RPE builds ON TOP of Shrine. See **RPE-01** for the full integration map.

## The Six Subsystems

```
┌─────────────────────────────────────────────────┐
│                  REX TREE (Shrine)               │
├──────────┬──────────┬──────────┬────────────────┤
│ Compile  │ Execute  │ Interact │ Overflow       │
│ Phase    │ Phase    │ Phase    │ Manager        │
├──────────┴──────────┴──────────┴────────────────┤
│              GPU Substrate Layer                  │
│   (WebGPU → Vulkan → Metal → D3D12 Work Graphs) │
└─────────────────────────────────────────────────┘
```

### 1. Compile Phase (structural changes only)
- Tree topology → profunctor optics (pre-composed path→buffer accessors)
- Shader compilation (WGSL generation, PSO creation)
- Buffer layout computation (SOA/AOS from annotations)
- Render graph extraction (pass dependencies, barrier inference)
- Subtree-independent: hash per `@platonic`, recompile only changed subtrees
- **See RPE-03** for GPU pipeline details

### 2. Execute Phase (per-frame)
- Apply pre-compiled optics to write changed attributes into staging buffers
- GPU-driven culling via compute (frustum, occlusion, LOD selection)
- Multi-draw indirect per material bucket
- Zero tree traversal — optics map directly to buffer byte ranges
- **See RPE-03** for GPU pipeline details

### 3. Interact Phase (input → tree mutation)
- DAG Amendment: screen-space drag → jacobian → tree parameter solve
- Co-parameters are paths, not pixel coords (resize-stable)
- Sparse jacobians from tree topology (most entries zero by structure)
- SmartGrab: locality in path space, not screen space
- **See RPE-02** for the Levin-inspired isomorphism model

### 4. Overflow Manager
- Graceful degradation when primitive count exceeds buffer capacity
- LOD fallback cascade: mesh → billboard → particle → cull
- Memory pressure: transient resource aliasing, lifetime analysis
- Shader complexity budget per frame (adaptive quality)
- **See RPE-05** for full overflow/resilience spec

### 5. Text & Vector Subsystem
- Slug-style GPU glyph rendering from Bézier curves
- Resolution-independent at any scale/perspective
- Unified with 3D pipeline (text in world space, UI overlays)
- **See RPE-04** for text/vector/2D details

### 6. PCN Behavior Layer
- Platonic Computation Networks: reactive dataflow between tree nodes
- Attribute changes propagate through compiled dependency graphs
- Enables animation, physics response, UI state machines
- **See RPE-06** for PCN behavior spec

## The Levin Isomorphism

Michael Levin's morphogenetic framework maps precisely to RPE:

| Levin (Biology) | RPE (Projection Engine) |
|---|---|
| Bioelectric pattern = morphogenetic code | Rex tree = render specification |
| Cells navigate anatomical morphospace | Nodes project through visual morphospace |
| Gap junctions = cell-cell communication | PCN channels = node-node dataflow |
| Bioelectric prepattern → gene expression | Compile phase → GPU buffer layout |
| Pattern homeostasis (regeneration) | Overflow recovery (graceful degradation) |
| Top-down control via voltage patterns | Tree-level control via attribute propagation |
| Multiscale competency architecture | Nested `@platonic` / `@scene` / `@pass` scoping |

The key insight: **the tree doesn't describe the rendering — it IS the morphogenetic code that the GPU "develops" into pixels.** Just as Levin's bioelectric patterns are both the agent AND the memory, the Rex tree is both the specification AND the runtime state.

See **RPE-02** for the full isomorphism analysis.

## The Aaltonen Alignment

Sebastian Aaltonen's "No Graphics API" thesis aligns with RPE:

| Aaltonen Principle | RPE Implementation |
|---|---|
| Everything is just GPU memory + pointers | Tree paths compile to buffer offsets |
| Unified descriptor heap (no buffer zoo) | Single scene buffer, single material buffer |
| Bindless resources via heap indices | `@material` nodes carry texture heap indices |
| Mesh shaders = raw memory in, meshlets out | `@meshlet` nodes define cluster geometry |
| Minimal API surface | Tree notation IS the API |
| Single shader language, cross-compiled | WGSL in tree, SPIRV-Cross for backends |

See **RPE-03** for full GPU pipeline design.

## Document Index

| Doc | Title | Contents |
|---|---|---|
| **RPE-00** | Architecture Overview | This document — master index |
| **RPE-01** | Shrine Integration | What Shrine provides, what RPE adds, interface contracts |
| **RPE-02** | Levin Isomorphisms | Morphogenetic computation model, multiscale competency, PCN theory |
| **RPE-03** | GPU Pipeline | Aaltonen-aligned GPU architecture, unified shaders, GPU-driven rendering |
| **RPE-04** | Text, Vector & 2D | Slug integration, UI rendering, resolution-independent surfaces |
| **RPE-05** | Overflow & Resilience | Buffer overflow, memory pressure, graceful degradation, error recovery |
| **RPE-06** | PCN Behaviors | Platonic Computation Networks, reactive dataflow, animation, state machines |

## Capability Targets

### AAA 3D (target: 60fps at 1080p on mid-range GPU)
- 100K+ unique meshlets visible per frame
- GPU-driven culling + LOD + MDI
- PBR materials with bindless textures
- Shadow cascades, screen-space reflections, volumetrics
- Visibility buffer deferred shading

### 2D UI (target: 120fps, pixel-perfect)
- Slug-style text at any scale
- Flexbox/grid layout from tree structure
- Animated transitions via PCN behaviors
- Crisp vector graphics (Bézier → GPU)
- Mixed 2D/3D (UI overlaid on world, text in 3D space)

### Shared Infrastructure
- Single compile phase handles both
- Same buffer management, same optic system
- UI nodes and 3D nodes coexist in one tree
- `@pass` ordering handles compositing
