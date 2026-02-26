# RPE Gap Analysis & Strengths Assessment

*February 2026. Comparative analysis of current RPE implementation against GPU research findings, AAA engine techniques, and the specification.*

---

## What RPE Gets Right

These aren't incremental wins. These are fundamental architectural decisions that most engines get wrong and cannot fix later.

### 1. The Compile/Execute Split

**What RPE does:** Tree is parsed and compiled ONCE (on change). The compile phase produces a flat command list, optic table, barrier schedule, and heap layout. The execute phase is a tight loop: write bytes → upload dirty range → iterate command list. Zero tree traversal at runtime.

**Why this is correct:** Every engine eventually arrives at "pre-record command buffers" (Babylon.js calls it "snapshot rendering", Bevy has a render graph extraction phase, Three.js is adding it). RPE starts here. The compile phase IS the engine. The execute phase is just a dumb command player.

**What the research confirms:** Blow/JAI's `#run` is this same pattern — arbitrary computation at compile time, flat execution at runtime. Aaltonen's "flat command submission" is the output format RPE already produces. Most engines add this optimization later; RPE is built on it.

### 2. The Zero-Copy Heap

**What RPE does:** One `ArrayBuffer`. One `GPUBuffer`. All data lives at pre-compiled byte offsets. `setFloat32(offset, value)`. Dirty range tracking. One `writeBuffer` call per frame uploading only the changed slice.

**Why this is correct:** This eliminates the #1 performance killer in web GPU engines: per-frame buffer creation and bind group churn. Three.js creates new uniform buffers every frame. Babylon.js (without snapshot mode) creates per-draw bind groups. RPE creates one buffer at compile time and writes bytes into it.

**What the research confirms:** Aaltonen's "GPU is just memory + pointers." RPE's heap IS the GPU's view of the world. Offsets ARE pointers. Blow's "no hidden allocations" — RPE has zero allocations at runtime. The DataView writes are not allocations, they're typed memory stores into pre-existing buffers.

### 3. Compiled Optics

**What RPE does:** Tree paths like `(form/cam_dist)` compile to `{heapOffset: 256, type: f32}`. At runtime: `heapView.setFloat32(256, value)`. No accessor functions, no buffer objects, no binding API.

**Why this is correct:** This is the profunctor optic pattern instantiated concretely. The composition (form → section → field → byte offset) happens at compile time. The abstract framework guarantees correctness. The runtime cost is exactly one typed memory write.

**What the research confirms:** The categorical formulation from Clarke et al. (2020) shows that the residual (the rest of the heap around the focused field) is existentially quantified — the optic doesn't know or care what else is in the heap. This is exactly how RPE's offsets work. The same offset works bidirectionally (forward for rendering, inverse for `@interact`).

### 4. Transducer Architecture

**What RPE does:** Transducers are pluggable compilers that claim node types from the tree. The GPU transducer claims `@pass`, `@draw`, `@pipeline`, `@struct`, `@buffer`. The form transducer claims `@form`, `@field`, `@section`. New capabilities = new transducers, not engine rewrites.

**Why this is correct:** Every new rendering technique (deferred, visibility buffer, GI probes, text, vector graphics) is a new transducer reading new node types. The core engine (compile/execute, heap, optics) never changes. This is genuinely extensible, not "extensible via config flags."

**What the research confirms:** Bevy's render graph is rebuilt per frame. Three.js traverses the scene graph per frame. RPE's transducers compile the tree once and produce a static command list. Adding a text transducer or a physics transducer doesn't slow down the GPU transducer.

### 5. Barrier Schedule as Stage Masks

**What RPE does:** Part 8. Barriers are `{before: stage, after: stage, hazards: flags}`. No resource lists. Producer/consumer stages plus hazard type.

**Why this is correct:** This is exactly Aaltonen's model. WebGPU handles barriers automatically between passes, so RPE's barrier schedule serves as validation and documentation rather than emitting explicit barrier commands. For a future Vulkan/Metal backend, it would emit real barriers.

### 6. `@struct` → WGSL + Layout + Optics

**What RPE does:** One `@struct` definition generates: the CPU-side byte layout, the WGSL struct declaration (with correct alignment), and the optic offsets. Single source of truth.

**Why this is correct:** Aaltonen: "struct layouts should be shared between CPU and GPU." RPE takes this further — the struct definition also generates the data access paths (optics). Change the struct, everything recompiles correctly.

### 7. Double-Buffered Staging with Dirty Range

**What RPE does:** Two staging ArrayBuffers. Write to slot A while GPU reads slot B. After upload, copy dirty range to the other slot, swap. Atomic because JS is single-threaded.

**Why this is correct:** This is a classic ring buffer pattern from game engines. The dirty range optimization means only changed bytes are uploaded — not the whole heap every frame. In a large scene with few per-frame changes (a slider moving, a timer ticking), this uploads maybe 32 bytes instead of 64KB.

### 8. Shader/Pipeline Fallback

**What RPE does:** Bad shader? Keep last-good module. Bad pipeline? Keep last-good pipeline. Rendering never stops.

**Why this is correct:** Blow's "no exceptions, no crashes." The RPE spec's "FALLBACK, NEVER CRASH" principle. This is essential for live editing — you're typing shader code and every intermediate state is a syntax error. The engine must keep rendering with the last working version.

### 9. Expression Evaluator in Optics

**What RPE does:** Optic values can be expressions: `(sin (mul (elapsed) 2.0))`. Evaluated per-frame in the builtin pass, result written to heap.

**Why this is correct:** This bridges declarative (tree notation) and imperative (per-frame computation) without a runtime interpreter. The expression evaluator is a mini-compiler — it could eventually compile to WGSL compute for GPU-side evaluation.

### 10. Template System

**What RPE does:** `@template` + `@use` with parameter substitution. `$paramName` replacement, deep cloning, recursive expansion up to 16 levels.

**Why this is correct:** This is compile-time metaprogramming à la JAI's `#run`/`#insert`. Templates generate tree structure at parse time, not runtime. The expanded tree compiles through the normal pipeline.

---

## Gaps — What's Missing

### RESOLVED (February 2026)

#### ~~Gap 1: Render-to-Texture / MRT~~ — SOLVED
**Implementation:** `_executeCommandList` resolves pass targets from `cmd.target` (single texture) or `cmd.targets` (MRT array). Falls back to swapchain. `_buildPipeline` resolves fragment target formats from texture names via `_resolveTargetFormat()`. Depth attachments via `cmd.depthTarget`. Blending applies to all MRT targets.
**Rex notation:** `@pass scene :target offscreen :depth-target depth-buf :clear [0 0 0 1]`

#### ~~Gap 2: Asset/Texture Loading~~ — SOLVED
**Implementation:** `@texture :src url` triggers async load via `fetch → createImageBitmap → copyExternalImageToTexture`. Magenta placeholder shown immediately, replaced when loaded. Generation counter cancels stale loads on recompile. `_resolveAssetSource()` is the Shrine path hook — currently passes URLs through, will resolve `shrine://` URIs when Shrine integration is ready.
**Rex notation:** `@texture albedo :src assets/stone.png :filter linear :wrap repeat`

#### ~~Gap 3: Indirect Draw~~ — SOLVED
**Implementation:** `@draw :indirect true :indirect-buffer name :indirect-offset 0` triggers `pass.drawIndirect()` or `pass.drawIndexedIndirect()`. Storage buffers with `:usage [storage indirect]` get `GPUBufferUsage.INDIRECT` flag. Compute-to-render pipeline: `@dispatch` fills indirect args → `@draw :indirect true` consumes them.
**Rex notation:** `@draw :pipeline mesh-pipe :indirect true :indirect-buffer draw-args`

#### ~~Gap 4: Feature Detection~~ — SOLVED
**Implementation:** `init()` probes adapter for 7 features (`timestamp-query`, `shader-f16`, `float32-filterable`, `indirect-first-instance`, `bgra8unorm-storage`, `rg11b10ufloat-renderable`, `depth-clip-control`), requests available ones, stores in `_features` Set, logs them. `hasFeature(name)` public query. Features displayed in heap info sidebar.

### REMAINING CRITICAL

#### Gap 1: Text Rendering Transducer
**Status:** Not implemented. No `@text` node handler.
**Impact:** Cannot render ANY text on the GPU canvas. All text is currently DOM-based (form labels). This is now the single highest-priority gap — render-to-texture and indirect draw are in place, so the text transducer has all the infrastructure it needs.
**Research says:** MSDF is ~200-400 lines JS + ~50 lines WGSL. HarfBuzz WASM for shaping. The infrastructure (storage buffers, instanced draw, compute dispatch) already exists in RPE.

### IMPORTANT (Needed for Full Vision)

#### Gap 5: Channel / Reactive Dataflow System
**Status:** `@channel` nodes specified but not implemented.
**Impact:** No declarative data flow between tree nodes. All data flow is through optics (set/get) and the expression evaluator.
**Research says:** Channels are optic compositions: `dimap (view source) (set dest) transform`. Modes: continuous (push every frame), on-change (event-driven), on-event (pull). This is FRP built on the optic system.
**Effort:** Medium. Needs: channel compilation (source/dest optic resolution), per-frame channel evaluation pass, change detection.

#### Gap 6: Explicit Pipeline Layouts
**Status:** Uses `layout: 'auto'` for all pipelines.
**Impact:** Cannot share bind groups across pipelines. Each pipeline creates its own bind group layout. Prevents efficient bind group reuse.
**Research says:** For a self-hosting engine, you want explicit `GPUPipelineLayout` and `GPUBindGroupLayout` so the same bind group (e.g., global scene uniforms) works across all pipelines.
**Effort:** Medium. Requires bind group layout compilation phase. The `@struct` system could generate bind group layouts.

#### ~~Gap 7: Feature Detection at Init~~ — SOLVED (see above)

#### Gap 8: Form Widget Coverage
**Status:** 4 of 10+ widget types (range, select, checkbox, color).
**Impact:** Cannot build complex forms (text input, number input, toggle, radio, tags, textarea).
**Effort:** Low per widget. The form transducer pattern is established.

### ARCHITECTURAL (Future-Facing)

#### Gap 9: GPU Hit Testing
**Status:** Hit testing is DOM-based (`@interact` uses canvas mouse events + form field mapping).
**Impact:** Cannot do pixel-perfect hit testing on GPU-rendered UI elements. Cannot self-host the editor.
**Research says:** Compute shader: point-in-rect test, atomic max on packed (z_order << 16 | id). Zero readback for hover (render shader reads hovered_id from storage buffer). Readback only on click.
**Effort:** Medium. Needs: UI element storage buffer, hit test compute shader, result buffer shared with render pass.

#### Gap 10: Vector Graphics / Path Rendering
**Status:** Not implemented.
**Impact:** Cannot render arbitrary vector shapes, curves, SVG-like graphics.
**Research says:** Vello's fully-compute pipeline is the gold standard. Rive's WebGPU renderer is production-ready. Both use compute shaders for path tessellation and rasterization.
**Effort:** High. This is a significant subsystem. Could initially integrate Rive's WASM runtime or implement a simplified compute-shader path renderer.

#### Gap 11: Overflow / Resilience Tiers
**Status:** No frame budget monitoring, no LOD, no quality degradation.
**Impact:** Renders at full quality or fails. No graceful degradation.
**Research says:** The spec defines 5 tiers (normal → wireframe fallback). Frame timing → tier selection → LOD bias + cull aggressiveness + resolution scaling.
**Effort:** Medium. Needs: frame time measurement (timestamp queries), tier state machine, LOD bias uniform in shaders.

#### Gap 12: PLAN Bridge
**Status:** Not integrated.
**Impact:** No persistence, no undo history, no event log.
**Research says:** PLAN's pin system would provide: persistent tree state, undo/redo via pin history, event sourcing for collaborative editing.
**Effort:** Depends on PLAN runtime maturity.

#### Gap 13: Compute-to-Render Dataflow
**Status:** Compute dispatches and render passes can share storage buffers, but bind group wiring is manual.
**Impact:** Cannot easily build: GPU culling → indirect draw, physics → render, particle update → particle render.
**Research says:** The barrier schedule already handles hazard detection. The missing piece is automatic bind group wiring to share storage buffers across passes.
**Effort:** Medium. Compile phase needs to trace storage buffer usage across `@dispatch` → `@pass` boundaries and generate shared bind groups.

---

## Priority Ordering (Updated)

### Phase 1 — Self-Hosting Foundation ~~(4 items)~~ → 1 remaining
- ~~Render-to-texture / MRT~~ DONE
- ~~Indirect draw~~ DONE
- ~~Feature detection~~ DONE
- ~~Asset loading~~ DONE
1. **Text rendering transducer** — THE critical next step. All infrastructure is now in place.

### Phase 2 — Real Content (enables real applications)
2. **Form widget coverage** (complete the form transducer)
3. **Explicit pipeline layouts** (bind group sharing)
4. **Channels** (reactive dataflow)
5. **Compute-to-render dataflow** (GPU culling pipelines, now possible with indirect draw)

### Phase 3 — AAA Capabilities (enables game engines)
6. **GPU hit testing** (self-hosting UI)
7. **Vector graphics** (Vello/Rive-style path rendering)
8. **Overflow tiers** (quality degradation, now possible with feature detection + timestamp queries)

### Phase 4 — OS Integration
9. **PLAN bridge** (persistence, undo, collaboration)
10. **PCN integration** (neural inference alongside rendering)
11. **ShrineOS scaffolding** (native backend, CUDA/Metal/Vulkan targets)

---

## Comparison to Existing Engines

| | RPE | Bevy | Babylon.js | Three.js | Unreal |
|---|---|---|---|---|---|
| **Per-frame CPU work** | Near-zero (command list iteration) | Moderate (ECS extraction) | Moderate (scene traversal) | Heavy (scene traversal) | Moderate (GPU-driven) |
| **Compile/execute split** | First-class | Render graph | Snapshot mode (opt-in) | No | Yes (GPU-driven) |
| **Memory model** | One flat heap | ECS archetype storage | Per-draw buffers | Per-draw buffers | GPU-driven virtual memory |
| **Data access** | Compiled optics (byte offsets) | Component queries | Property access | Property access | UObject reflection |
| **Extensibility** | Transducers (pluggable compilers) | Plugins + systems | Plugins | Plugins | Modules |
| **Notation** | Tree notation (Rex) | Rust code | JS code | JS code | Blueprint + C++ |
| **Self-hosting** | Designed for (not yet) | Bevy editor (WIP) | Inspector UI | No | UE editor (C++) |
| **Backend abstraction** | Tree → any GPU | wgpu (Vulkan/Metal/DX12/WebGPU) | WebGL + WebGPU | WebGL + WebGPU | Custom (RHI) |

**RPE's unique position:** It's the only engine where the input format (tree notation) is the same as the scene description, the memory layout, AND the command specification. Everything else has a gap between "how you describe what you want" and "what the GPU executes." RPE compiles away that gap.

---

## Conclusion

The core architecture is sound and exceeds the theoretical rigor of any existing engine I can identify. The compile/execute split, zero-copy heap, compiled optics, and transducer model are not just "good ideas" — they are the correct abstractions, backed by category theory (profunctor optics), hardware reality (Aaltonen), and language design (Blow/JAI).

The gaps are all in the transducer layer — which is exactly where they should be. The core never needs to change. Text, vector graphics, physics, GI, VR — these are all new transducers that read new node types from the same tree, compile to the same command list format, and write to the same heap. The architecture was designed for this extensibility and it works.

The most impactful next step is the text rendering transducer. Once you can render text on the GPU canvas, the path to self-hosting (Rex rendering Rex) opens up. Everything after that is additive.

---

## Addendum: PLAN, Rex, and CUDA Integration Gaps

### PLAN Integration

PLAN provides orthogonal persistence, undo/redo, and event sourcing — all missing from RPE today. The bridge:
- **Pin the tree**: Each tree mutation becomes a PLAN app. Pin history = undo stack.
- **Content addressing**: Same tree state = same hash. Enables deduplication, caching, collaborative merging.
- **Lazy GPU dispatch**: PLAN's lazy evaluation maps to deferred GPU computation (compute when forced).

Gap: No PLAN runtime integration exists. The PLAN runtime is native x86-64 assembly (no libc). Bridging to browser RPE requires either: (a) compile PLAN to WASM, or (b) run PLAN server-side with IPC. For native ShrineOS, PLAN runs in-process.

### Rex Notation Alignment

The rexgpu JS parser (`src/rex-parser.js`) is a simplified subset of the canonical Rex specification (Rust implementation at github.com/axsys-org/Rex). Key differences:
- JS parser uses `@type name` node syntax; canonical Rex has 11 node types with rune-based operator precedence
- JS parser has `:key value` attributes; canonical Rex encodes attributes as infix pairs via runes
- JS parser has content blocks for shaders; canonical Rex uses Slug/Ugly nodes for multi-line text

Gap: The JS parser works for the projection engine but diverges from canonical Rex. Full alignment would mean the same .rex files parse identically in both the Rust and JS implementations.

### CUDA Backend

The transducer architecture is already backend-agnostic. A CUDA transducer would:
- Compile `@dispatch` → CUDA kernels via NVRTC (runtime compilation, like WGSL)
- Use CUDA Graphs for command list replay (~5μs overhead vs ~50μs for individual launches)
- Share heap with Vulkan via external memory interop (zero-copy)
- Access tensor cores for PCN matrix operations
- Use 64-bit atomics for software rasterization

Gap: No native backend exists yet. This is Phase 4 (ShrineOS integration). The architecture supports it; the transducer just needs to be written.

### PCN on GPU

PCN's core operations (cue kernel, propagation, Hebbian update) are simple enough to run as WebGPU compute shaders today. Total cost: ~0.2ms per event. On CUDA with tensor cores: ~0.05ms.

Gap: PCN compute shaders are not implemented. The `@dispatch` infrastructure exists. The kernels need to be written in WGSL and wired into the tree.
