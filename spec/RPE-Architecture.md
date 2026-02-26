# Rex Projection Engine — Architecture Specification

**Version 1.0 — February 2026**

> *"No Graphics API" — the GPU is memory, pointers, and stage masks.*
> *— Sebastian Aaltonen*

> *The platform is the notation, not the runtime.*

---

## Table of Contents

1. [Design Thesis](#1-design-thesis)
2. [The Rex Notation](#2-the-rex-notation)
3. [Compile / Execute Split](#3-compile--execute-split)
4. [Zero-Copy Heap](#4-zero-copy-heap)
5. [Compiled Profunctor Optics](#5-compiled-profunctor-optics)
6. [The Transducer Model](#6-the-transducer-model)
7. [Extension Protocol](#7-extension-protocol)
8. [GPU Transducer](#8-gpu-transducer)
9. [Behaviour Transducer](#9-behaviour-transducer)
10. [Surface Transducer](#10-surface-transducer)
11. [Form Transducer](#11-form-transducer)
12. [Predictive Coding Network (PCN)](#12-predictive-coding-network-pcn)
13. [ShrubLM — Per-Shrub Learning Modules](#13-shrublm--per-shrub-learning-modules)
14. [Self-Healing & Self-Modifying Behaviour](#14-self-healing--self-modifying-behaviour)
15. [Cross-System Wiring](#15-cross-system-wiring)
16. [Expression Language](#16-expression-language)
17. [Extensibility Ceiling](#17-extensibility-ceiling)
18. [Intellectual Lineage](#18-intellectual-lineage)

---

## 1. Design Thesis

Rex Projection Engine (RPE) eliminates the graphics API abstraction. Instead of wrapping WebGPU behind an object model (scenes, materials, meshes), RPE treats the GPU as what it is: **a memory-mapped coprocessor with typed regions, compiled pointers, and stage masks**.

A Rex program is a tree. The tree is parsed once into a canonical AST, projected into a Shrub (flat node view), then compiled by a set of independent **transducers** — each claiming the node types it understands. Compilation produces:

- A **flat command list** (GPU passes, dispatches, draws)
- An **optic table** (tree paths → byte offsets)
- A **barrier schedule** (read/write dependency → explicit sync)
- A **heap layout** (one ArrayBuffer, one GPUBuffer, compiled offsets)

Execution is a tight loop: **write bytes → upload dirty range → iterate commands**. No allocations. No hash lookups. No virtual dispatch. The cost floor is the cost of `DataView.setFloat32(offset, value)` — a single typed memory write.

### Core Invariants

1. **Parse once, execute forever.** Tree structure changes trigger recompile. Value changes are byte writes.
2. **Paths are optics.** Every `/path` in the notation compiles to a byte offset at compile time. Runtime path resolution does not exist.
3. **Transducers are independent.** GPU, Behaviour, Surface, Form, and PCN transducers share no state except the Shrub tree and the heap. They compose through callbacks, not inheritance.
4. **Extension is the default.** Every transducer exposes `register*` methods. Unknown node types dispatch to user handlers before warning. The built-in switch/case is a performance fast-path, not a closed set.
5. **Learning is structural.** The PCN/ShrubLM layer observes behaviour events and crystallizes patterns into prototype graphs. These prototypes can bypass guards, synthesize new rules, and amend the source notation — closing the loop from execution back to specification.

---

## 2. The Rex Notation

Rex is a tree notation with 11 node types, rune-based operator precedence, and indentation-scoped blocks. The parser (`rex-parser.js`, ~940 lines) implements the full canonical specification.

### Parse Pipeline

```
Source text
  → Lexer (lines, indentation, rune classification)
  → Content-type preprocessing (shader/wgsl/code/kernel/lib blocks → raw strings)
  → Canonical AST (nested nodes with types, attributes, children)
  → Shrub projection (flat node view with parent pointers)
  → Template expansion (@template/@use with $param substitution)
```

### Node Anatomy

Every Rex node has:

| Field | Description |
|-------|-------------|
| `type` | Rune-determined: `@name` → type "name" |
| `name` | Optional identifier after the type rune |
| `attrs` | Key-value pairs via `:key value` syntax |
| `children` | Indentation-scoped child nodes |
| `content` | Raw text for content-type nodes (shaders, code blocks) |

### Path Syntax — Optics in Notation

Rex paths are composed optics. The rune determines the optic type:

| Rune | Optic | Semantics |
|------|-------|-----------|
| `/` | Lens | Read/write access to a named slot |
| `%` | Prism | Cross-shrub dependency reference (partial, may fail) |
| `$` | Traversal | Collection binding ($acc, $item, $key, $item.field) |

A path like `/player/inventory/%weapon/damage` composes:
- Lens into `player` shrub
- Lens into `inventory` slot
- Prism into `weapon` dep (resolves to another shrub)
- Lens into `damage` slot on the resolved target

At compile time, this entire chain collapses to a byte offset in the heap.

### Expression Syntax

Rex expressions use S-expression form: `(op arg1 arg2 ...)`. Nested expressions compose naturally:

```
(smoothstep 0.0 1.0 (div /player/health /player/maxHealth))
```

Expressions compile to a tree of `{type, op, args}` nodes via `Rex.compileExpr()`. The compiled tree evaluates in O(depth) with no allocation — each node resolves against a context that maps slot/dep/ident references to values or byte offsets.

### Content-Type System

Certain node types contain raw text rather than Rex syntax. The parser recognizes registered content types and captures their indented children as verbatim strings:

```
@shader vertexMain
  @vertex
  fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    // This is WGSL, not Rex — captured verbatim as .content
  }
```

**Built-in content types:** `shader`, `wgsl`, `code`, `kernel`, `lib`, `text-editor`

**User registration:**
```javascript
Rex.registerContentType('glsl')     // Add custom content type
Rex.unregisterContentType('lib')    // Remove one
```

The preprocessing pass wraps content-type blocks in delimiters before canonical parse, telling the lexer to pass through without interpretation.

### Template System

Templates enable reusable tree fragments with parameter substitution:

```
@template Card
  @param title "Untitled"
  @param color "#ffffff"
  @rect
    :fill $color
    :width 200
    :height 100
    @text
      :content $title

@use Card :title "Player Stats" :color "#3366ff"
@use Card :title "Inventory" :color "#ff6633"
```

Expansion clones the template body, substitutes `$param` references, and preserves runtime bindings (`$acc`, `$item`, `$key`). Templates compose — a template can `@use` other templates.

---

## 3. Compile / Execute Split

This is the central architectural decision. Every other design choice follows from it.

### Compile Phase

Triggered when tree structure changes (node added/removed/reordered). Runs once, produces immutable artifacts.

**GPU compile stages (in order):**

| Stage | Method | Output |
|-------|--------|--------|
| 1 | `_compileLibs` | WGSL import libraries extracted from `@lib` nodes |
| 2 | `_configureCanvas` | Canvas settings (alpha-mode, tone-mapping, color-space) |
| 3 | `_compileStructs` | `@struct` + `@field` → aligned memory layout with padding |
| 4 | `_compileShaders` | WGSL modules with `#import` resolution, feature auto-enable |
| 5 | `_compileHeapLayout` | `@buffer` nodes → 256-byte-aligned offsets in unified heap |
| 6 | `_compileOptics` | Tree paths → byte offsets; form/builtin/const classification |
| 7 | `_allocateHeap` | One GPU uniform buffer + two staging ArrayBuffers |
| 8 | `_compileStorageBuffers` | `@buffer :usage [storage]` → read-write GPU buffers |
| 9 | `_compileTextures` | Formats, mipmaps, views, samplers, video textures |
| 10 | `_compileVertexBuffers` | Vertex/index data uploads |
| 11 | `_compileResourceScopes` | `@resources` → shared bind group layouts |
| 12 | `_buildPipeline` | Render/compute pipelines (MSAA, stencil, blend, depth) |
| 13 | `_compileRenderBundles` | Pre-recorded `@bundle` draw sequences |
| 14 | `_compileBarrierSchedule` | Read/write analysis → explicit GPU sync barriers |
| 15 | `_compileAliasingPlan` | Resource aliasing opportunities |
| 16 | `_compileCommandList` | `@pass`/`@dispatch` → flat command array |
| 17 | `_writeDefaults` | Initialize heap with default values |
| 18 | `_compileReadbacks` | GPU→CPU async copy pipelines |
| 19 | `_compileQueries` | Timestamp/occlusion query sets |
| 20 | Extension hooks | All `registerCompileType` handlers |

**Behaviour compile:**
- Extract `@shrub` schemas (slots, kids, deps)
- Order `@derive` nodes by dependency (Kahn's topological sort)
- Compile `@talk` guards, mutations, and channel bridges
- Wire cross-shrub `@dep` references

**Surface compile:**
- Collect 2D elements (`@rect`, `@text`, `@panel`, `@shadow`, `@path`)
- Build layout tree (flexbox measure/arrange)
- Generate GPU compute dispatch parameters
- Upload SDF glyph atlas

### Execute Phase

Runs every frame. Zero allocation.

```
1. Update input builtins (WASD → moveX/Y/Z, mouse, wheel)
2. Apply builtins to heap (canvas-size, mouse-pos, time, frame-count)
3. Compute dirty range (min/max byte offsets modified this frame)
4. Upload dirty range → GPU (aligned writeBuffer, only modified bytes)
5. Flip double-buffer (swap staging ArrayBuffer for next frame)
6. Re-import video textures (if any)
7. Execute command list:
   - Render passes (targets, clear, depth/stencil, MSAA resolve)
   - Draw commands (pipeline, bind groups, vertex/index, direct/indirect)
   - Compute dispatches (workgroups, timestamp queries)
   - Bundle execution (pre-recorded sequences)
8. Queue readback copies (GPU→CPU async)
9. Resolve query results
```

The cost of a frame with no value changes is one `writeBuffer` call with 0 bytes + the command list iteration. The cost of a value change is `DataView.setFloat32(offset, value)` + the dirty range upload.

---

## 4. Zero-Copy Heap

One ArrayBuffer. One GPUBuffer. Compiled byte offsets. No JS objects per frame.

### Memory Architecture

```
┌─────────────────────────────────────────────┐
│              Unified Heap (CPU)              │
│  ┌─────────┬─────────┬─────────┬─────────┐  │
│  │Buffer A │Buffer B │Buffer C │  ...    │  │
│  │ 256-byte│ 256-byte│ 256-byte│         │  │
│  │ aligned │ aligned │ aligned │         │  │
│  └─────────┴─────────┴─────────┴─────────┘  │
│  ↑                                           │
│  Written via DataView.setFloat32(offset, v)  │
└──────────────────┬──────────────────────────┘
                   │ writeBuffer(dirtyMin, dirtyMax)
                   ▼
┌─────────────────────────────────────────────┐
│             GPU Uniform Buffer              │
│  Same layout, same offsets, same alignment  │
│  Bound at buffer offset per @buffer node    │
└─────────────────────────────────────────────┘
```

### Double-Buffered Staging

Two staging ArrayBuffers prevent write-during-upload hazards:

```
Frame N:   Write to staging[0], upload staging[0] to GPU
Frame N+1: Write to staging[1], upload staging[1] to GPU
Frame N+2: Write to staging[0] (recycled), ...
```

Swap is a pointer reassignment: `_writeSlot = 1 - _writeSlot; _heapView = _stagingViews[_writeSlot]`. Zero copy, zero allocation.

### Dirty Range Tracking

Only modified bytes are uploaded:

```javascript
_markDirty(offset, size) {
  _dirtyMin = Math.min(_dirtyMin, offset & ~3);       // Align down to 4 bytes
  _dirtyMax = Math.max(_dirtyMax, (offset + size + 3) & ~3);  // Align up
}

// At upload time:
if (_dirtyMax > _dirtyMin) {
  device.queue.writeBuffer(gpuHeap, _dirtyMin, staging, _dirtyMin, _dirtyMax - _dirtyMin);
}
```

A frame that modifies one float uploads 4 bytes. A frame that modifies nothing uploads 0 bytes. The heap can be megabytes — the upload cost is proportional to what changed.

### Storage Buffers

Separate from the uniform heap. `@buffer :usage [storage]` creates dedicated GPUBuffers for read-write compute access. These can serve as indirect draw argument buffers, enabling GPU-driven rendering where compute shaders write draw parameters.

---

## 5. Compiled Profunctor Optics

The optic system is the bridge between the tree notation (human-readable paths) and the heap (machine-accessible bytes). Compilation eliminates the path — at runtime, only the offset exists.

### Optic Categories

| Category | Source | Runtime Cost | Example |
|----------|--------|-------------|---------|
| **Form** | `(form/sliderX)` | Map lookup on change | Slider → heap float |
| **Builtin** | `canvas-size`, `mouse-pos` | Per-frame eval | Screen dimensions → heap vec2 |
| **Const** | `:default 100` | One-time write | Literal → heap float |
| **Channel** | `@channel :from /slot :to /buffer/field` | On-change callback | Behaviour slot → heap field |

### Compile-Time Resolution

```
Source:  @field brightness :default (form/exposure)

Compile:
  1. Resolve @field within @struct → field offset = 16 (after alignment)
  2. Resolve @buffer using @struct → buffer offset = 256 (256-byte aligned)
  3. Total heap offset = 256 + 16 = 272
  4. Source = 'form', key = 'exposure'

Output: { heapOffset: 272, type: 'f32', source: 'form', key: 'exposure' }

Runtime:
  form.onFieldChange('exposure', 0.75)
  → _formOptics['exposure'] → [{heapOffset: 272, type: 'f32'}]
  → _heapView.setFloat32(272, 0.75, true)
  → _markDirty(272, 4)
```

The path `/uniforms/brightness` does not exist at runtime. Only offset 272 exists.

### Bidirectional Optics (Profunctor Composition)

The `/`, `%`, `$` runes aren't just syntax — they are optic types that compose:

- **Lens** (`/slot`): Focus on exactly one element. Always succeeds. Bidirectional (get/set).
- **Prism** (`%dep`): Focus on one element that may not exist. Cross-shrub references go through prisms because the target shrub may not be present.
- **Traversal** (`$item`): Focus on zero-or-more elements. Used in `@each` / `(fold ...)` to iterate collections.

Composition follows the profunctor optic algebra (Clarke et al., 2020): lens ∘ prism = prism, lens ∘ traversal = traversal, prism ∘ traversal = traversal. The composed type determines how failure propagates.

At compile time, the algebra collapses to a byte offset (for lenses) or a resolution function (for prisms/traversals). No runtime interpretation of the path string.

---

## 6. The Transducer Model

A transducer is an independent compiler/executor pair that claims a set of node types from the Shrub tree. Transducers share no state except the tree and the heap. They compose through callbacks.

### Architecture

```
                    Rex Source
                       │
                    Rex.parse()
                       │
                   Shrub Tree
                       │
          ┌────────────┼────────────┬────────────┬────────────┐
          │            │            │            │            │
     GPU Trans.   Behaviour    Surface      Form         PCN
     @struct      @shrub       @rect        @form        Learns
     @shader      @def         @text        @field       from
     @buffer      @derive      @panel       @section     behaviour
     @pipeline    @talk        @shadow                   events
     @pass        @dep         @path
     @dispatch    @channel     @text-editor
     @draw
     @texture
          │            │            │            │            │
          ▼            ▼            ▼            ▼            ▼
     GPU heap     Slot state   Compute      HTML DOM    Prototype
     + commands   + reactions  pipeline     widgets     graphs
```

### Dispatch Protocol

Each transducer implements `transduce(tree, structureChanged)`:

1. **If `structureChanged`**: Run compile phase. Walk the Shrub tree, claim known node types via switch/case. For unknown types, check the handler Map. If no handler, warn once and recurse into children.

2. **Always**: Run execute phase. Update per-frame state (inputs, time, dirty values), push to GPU/DOM/callbacks.

### Independence Property

Transducers communicate only through well-defined interfaces:

| Interface | Direction | Mechanism |
|-----------|-----------|-----------|
| Behaviour → GPU | `@channel` | `onChannelPush(buffer, field, value)` callback |
| GPU → Behaviour | `@readback` | `onReadback(name, Float32Array)` callback |
| Surface → Behaviour | Hit test | `onElementClick(id, x, y)` → `fireTalk(shrub, action)` |
| Behaviour → PCN | Talk events | `onTalkFired(record)` → `pushBehaviourEvent(record)` |
| PCN → Behaviour | Confidence | `__lm_ready_*` / `__lm_confidence_*` shadow slots |
| PCN → Source | Crystallization | `onCrystallize(rule)` → `_amendSource(rule)` |

No transducer reads another transducer's internal state. This is what makes arbitrary new transducers possible — they only need to implement the callback contract.

---

## 7. Extension Protocol

Every transducer follows the same extension pattern: a handler Map that falls through from the built-in switch/case.

### Pattern

```javascript
class RexTransducer {
  constructor() {
    this._nodeHandlers = new Map();    // type → handler
    this._warnedTypes = new Set();     // warn-once per unknown type
  }

  registerFoo(typeName, handler) {
    this._nodeHandlers.set(typeName, handler);
  }

  _processNode(node) {
    switch (node.type) {
      case 'rect': return this._handleRect(node);    // Fast path
      case 'text': return this._handleText(node);    // Fast path
      // ... all built-in types
      default: {
        const h = this._nodeHandlers.get(node.type);
        if (h) return h(node, this);                 // Extension path
        if (!this._warnedTypes.has(node.type)) {
          this._warnedTypes.add(node.type);
          console.warn(`Unknown type: @${node.type}`);
        }
        // Recurse into children — graceful degradation
        for (const child of node.children) this._processNode(child);
      }
    }
  }
}
```

### Per-Transducer Extension Points

#### Parser

| Method | Signature | Purpose |
|--------|-----------|---------|
| `Rex.registerContentType` | `(typeName: string)` | Treat indented children as raw text |
| `Rex.unregisterContentType` | `(typeName: string)` | Restore normal parsing for type |

#### GPU Transducer

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerCompileType` | `(type, handler)` | Custom nodes in compile phase |
| `registerCommandType` | `(type, {compile, execute})` | Custom GPU commands with both phases |
| `registerResourceType` | `(type, handler)` | Custom resource allocation (textures, buffers) |
| `registerInputKey` | `(keyCode)` | Add keyboard codes to input system |
| `registerKeyBinding` | `(code, axis, value)` | Map key to movement axis |

#### Behaviour Transducer

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerSchemaType` | `(type, handler)` | Custom slot types in `@shrub` schema |
| `registerMutationType` | `(type, handler)` | Custom mutation operations in `@talk` |

#### Surface Transducer

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerElementType` | `(type, {collect, measure})` | Custom 2D element with layout + render |
| `setFont` | `(fontSpec)` | Configure SDF glyph rasterization |

#### Form Transducer

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerNodeType` | `(type, handler)` | Custom form container nodes |
| `registerFieldType` | `(type, {render, setExternal})` | Custom form input widgets |

#### PCN

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerShrubAgent` | `(shrub, talks)` | Create ShrubLM for a shrub |
| `registerShrubSchema` | `(shrub, schema)` | Provide slot ranges for normalization |

### Zero-Cost When Unused

Built-in types hit the switch/case directly — no Map lookup, no handler call. The extension path only activates for types not in the switch. This means registering 100 custom types has zero impact on the performance of built-in types.

The `_warnedTypes` Set ensures that unknown types without handlers produce exactly one console warning per compile cycle, not one per frame.

---

## 8. GPU Transducer

**File:** `rex-gpu.js` (~2000 lines)
**Class:** `RexGPU`

### Node Types

| Node | Attributes | Purpose |
|------|-----------|---------|
| `@canvas` | `:alpha-mode`, `:tone-mapping`, `:color-space` | Canvas configuration |
| `@struct` | `:name` | Memory layout definition |
| `@field` | `:type`, `:default`, `:offset` | Struct field (f32, u32, vec2f, vec3f, vec4f, mat4x4f) |
| `@shader` | `:name`, `:stage` | WGSL module with `#import` resolution |
| `@lib` | `:name` | Reusable WGSL library (importable) |
| `@buffer` | `:name`, `:struct`, `:usage` | Uniform or storage buffer |
| `@texture` | `:name`, `:format`, `:size`, `:mip-levels`, `:samples` | GPU texture (2D, cube, array, video) |
| `@sampler` | `:name`, `:filter`, `:address` | Texture sampler |
| `@vertex-buffer` | `:name`, `:data` | Vertex/index data |
| `@resources` | `:name` | Shared bind group layout scope |
| `@pipeline` | `:name`, `:vertex`, `:fragment`, `:compute`, `:blend`, `:depth`, `:stencil`, `:msaa` | Render or compute pipeline |
| `@pass` | `:target`, `:clear`, `:depth`, `:stencil` | Render pass |
| `@dispatch` | `:pipeline`, `:workgroups` | Compute dispatch |
| `@draw` | `:pipeline`, `:vertices`, `:instances`, `:indirect` | Draw command |
| `@bundle` | `:name` | Pre-recorded render bundle |
| `@readback` | `:from`, `:offset`, `:count` | GPU→CPU async copy |
| `@query` | `:type`, `:count` | Timestamp/occlusion queries |

### Barrier Scheduler

The compile phase analyzes read/write sets of every command:

```
For each @draw / @dispatch:
  Extract all @bind children → {reads: Set<resource>, writes: Set<resource>}

For each pair (commandA writes resource R, commandB reads resource R):
  if (commandA.index < commandB.index):
    Insert barrier between them

Barrier types:
  storage → uniform   (compute writes → vertex reads)
  compute → render     (compute dispatch → render pass)
  render → compute     (render target → compute read)
```

Barriers are explicit — no implicit synchronization, no driver guessing. This matches the Vulkan/D3D12 model and is the foundation for correct multi-pass rendering.

### Blend Modes

Pipelines support: `alpha` (default), `additive`, `multiply`, `screen`, `premultiplied`, plus dual-source blending for advanced compositing.

### Input System

Built-in keyboard/mouse handling with extensible key registration:

```javascript
// Built-in: WASD, Space, Shift, Arrows, Q/E
// Extension:
gpu.registerInputKey('KeyR');           // Prevent default on R key
gpu.registerKeyBinding('KeyR', 'moveY', 1.0);  // R = move up

// Per-frame builtins written to heap:
// canvas-size: [width, height]
// mouse-pos:   [x, y] normalized 0..1
// mouse-delta: [dx, dy] movement since last frame
// move-dir:    [x, y, z] aggregated WASD
// time:        seconds since start
// frame-count: integer frame counter
```

Pointer lock mode (FPS controls) activates on double-click, providing raw mouse delta.

---

## 9. Behaviour Transducer

**File:** `rex-behaviour.js` (~1000 lines)
**Class:** `RexBehaviour`

The behaviour system implements reactive dataflow: shrubs hold state, derives compute values, talks mutate state, channels bridge to GPU.

### Node Types

#### @shrub — Reactive State Container

```
@shrub Player
  @slot health :type number :default 100 :min 0 :max 100
  @slot armor :type number :default 0
  @slot name :type string :default "Hero"
  @kids inventory
    @slot name :type string
    @slot count :type number :default 1
  @dep weapon :path /armory/equipped
```

Slots are typed, have defaults, and optionally declare `:min`/`:max` for surprise detection. Kids declare collection schemas. Deps reference other shrubs.

#### @def — Pure Functions

```
@def clampHealth :args hp maxHp
  (min (max 0 /hp) /maxHp)
```

Callable from any expression context: derives, guards, mutations, form fields. Pure — no side effects, no slot writes.

#### @derive — Computed Values

```
@derive :shrub Player :slot effectiveDefense
  (add /armor (mul (%weapon/defense) 0.5))
```

Ordered by dependency via Kahn's topological sort. When a slot changes, all downstream derives recompute in order. Cross-shrub deps (`%weapon/defense`) resolve through prism optics.

**Surprise detection:** If a derive's computed value falls outside the slot's `:min`/`:max` range, the system fires `onSurpriseSignal(shrub, slot, value, {min, max})`. This is the entry point for self-healing.

#### @talk — Actions

```
@talk :shrub Player :name takeDamage
  @input amount :type number
  @guard (gt /health 0)
  @set /health (sub /health /amount)
  @set /lastHit (now)
```

Talks are the only way to mutate slots. They execute atomically:

1. Evaluate guard expression → reject if false
2. Snapshot all pre-mutation slot values
3. Execute mutations in order (`@set`, `@create`, `@update`, `@remove`, `@each`, `@when`)
4. Recompute derives
5. Push channels
6. Emit causal record via `onTalkFired`

**Causal record:**
```javascript
{
  shrub: 'Player',
  talk: 'takeDamage',
  guard_result: true,
  mutations_fired: [{path: '/health', old_val: 100, new_val: 75}],
  slot_deltas: Map{'health' => -25},
  surprise: 0.0,   // Set by PCN after observation
  timestamp: 1709000000
}
```

This record is the fundamental unit of learning — the PCN observes it to build prototype graphs.

#### @channel — Behaviour → GPU Bridge

```
@channel healthBar
  :from /player/health
  :to /uniforms/playerHp
  :mode on-change
```

Five modes:

| Mode | Behaviour |
|------|-----------|
| `on-change` | Push when slot value changes (default) |
| `every-frame` | Push every frame regardless of changes |
| `throttle` | At most once per `:delay` milliseconds |
| `debounce` | After `:delay` ms of no changes |
| `once` | Push once, then never again |

#### @readback — GPU → Behaviour Bridge

```
@readback hitResult :from hitBuffer :offset 0 :count 4
```

Async GPU→CPU via `mapAsync`. Results arrive one frame later via `onReadback(name, Float32Array)`.

#### Mutation Types

| Mutation | Syntax | Semantics |
|----------|--------|-----------|
| `@set` | `@set /path expr` | Set slot to expression value |
| `@create` | `@create /collection/[auto] :slot val` | Create child, auto-increment key |
| `@update` | `@update /collection/%id :slot val` | Update existing child |
| `@remove` | `@remove /collection/%id` | Delete child |
| `@each` | `@each collection` with `@where` + mutations | Iterate with filter |
| `@when` | `@when expr` with mutations | Conditional mutations |
| Custom | Via `registerMutationType` | User-defined |

---

## 10. Surface Transducer

**File:** `rex-surface.js` (~2100 lines)
**Class:** `RexSurface`

Compute-first 2D rendering. No rasterizer. Everything runs as GPU compute shaders.

### Pipeline (Vello-style)

```
1. Flatten    — Convert shapes to line segments
2. Coarse     — Tile-based culling (which tiles does each shape touch?)
3. Fine       — Per-pixel coverage + fill evaluation (color, gradient, texture)
4. Composite  — Alpha blend tiles onto canvas
```

### Node Types

| Node | Attributes | Purpose |
|------|-----------|---------|
| `@rect` | `:x`, `:y`, `:width`, `:height`, `:fill`, `:stroke`, `:radius` | Rectangle (rounded, gradient) |
| `@text` | `:content`, `:x`, `:y`, `:size`, `:color`, `:align` | SDF text rendering |
| `@panel` | `:direction`, `:gap`, `:padding`, `:justify`, `:align` | Flexbox layout container |
| `@shadow` | `:x`, `:y`, `:width`, `:height`, `:blur`, `:color`, `:radius` | Analytical shadow |
| `@path` | `:d` (SVG syntax) | Vector path (M/L/H/V/Q/C/Z) |
| `@text-editor` | `:content`, `:width`, `:height` | Multiline editor with cursor, selection, scroll |

### SDF Text Rendering

```
1. Rasterize glyphs → Canvas 2D (once per glyph, cached in atlas)
2. Distance transform → SDF texture (Euclidean distance to edge)
3. Atlas packing → GPU texture (all glyphs in one texture)
4. Instanced quads → Compute shader reads atlas, evaluates SDF per pixel
```

SDF text scales to any size without re-rasterization. Subpixel positioning and anti-aliasing are implicit in the distance field.

### Gradient System

Both linear and radial gradients, resolved per-pixel in the fine rasterizer:

```
@rect
  :fill (linear-gradient 0 0 200 0 "#ff0000" "#0000ff")
  :width 200 :height 100
```

`resolve_fill()` in the fine shader interpolates stops, handles radial falloff, and returns the final color.

### Layout System

`@panel` implements CSS flexbox semantics:

- **Direction:** `row` | `column`
- **Gap:** Space between children
- **Padding:** Inner margin (top, right, bottom, left)
- **Justify:** `start` | `center` | `end` | `space-between`
- **Align:** `start` | `center` | `end` | `stretch`
- **Overflow:** Clip rect intersection for scrollable regions

Layout runs on CPU during compile, producing absolute positions for GPU compute.

### Hit Testing

GPU-accelerated point-in-shape testing:

```
Canvas click → registerClick(x, y)
  → Compute dispatch: for each element, test point inclusion
  → Readback result buffer (async mapAsync)
  → onHitChange(elementId), onElementClick(elementId, x, y)
  → Route to behaviour: fireTalk(shrub, action)
```

---

## 11. Form Transducer

**File:** `rex-form.js` (~310 lines)
**Class:** `RexForm`

Generates HTML DOM widgets from `@form` / `@field` nodes. Bridges user input to behaviour slots and GPU heap.

### Field Types

| Type | HTML Element | Features |
|------|-------------|----------|
| `range` | `<input type="range">` | min, max, step |
| `select` | `<select>` | Option list |
| `checkbox` / `toggle` | `<input type="checkbox">` | Boolean |
| `text` / `text-input` | `<input type="text">` | String |
| `button` | `<button>` | Fires action name via onFieldChange |
| `slider-2d` | Custom canvas | 2D point picker (x, y) |
| `file` | `<input type="file">` | File upload |
| `date` | `<input type="date">` | ISO date |
| `number` | `<input type="number">` | Numeric with step |
| `color` | `<input type="color">` | Hex color picker |

### Expression Support in Forms

Field attributes can be Rex expressions evaluated against form state:

```
@field threshold :type range :min 0 :max (callDef maxThreshold)
```

The form creates a `_makeFormEvalContext()` that resolves identifiers against `state` and `externalState`, and delegates function calls to `behaviour.callDef()`.

### Bidirectional Sync

```
User drags slider → form.onFieldChange('exposure', 0.75)
  → behaviour.slots.set('exposure', 0.75)  // if slot exists
  → gpu.setFormField('exposure', 0.75)     // if optic exists
  → heap.setFloat32(272, 0.75)             // byte write

External update → form.setExternal('exposure', 0.5)
  → DOM element.value = 0.5               // visual update
  → form.state['exposure'] = 0.5          // internal state
  → onFieldChange fires                   // propagate
```

---

## 12. Predictive Coding Network (PCN)

**File:** `rex-pcn.js` (~1950 lines)
**Class:** `RexPCN`

The PCN is the neural/semantic layer. It observes behaviour events and builds a model of the application's dynamics.

### Core Architecture

```
Behaviour events (onTalkFired records)
  → Episode buffer (circular, immutable)
  → Hebbian co-occurrence matrix (which talks fire together?)
  → ShrubLM prototype graphs (per-shrub displacement learning)
  → Natural timescale discovery (period detection per shrub)
  → Lateral voting (cross-shrub evidence propagation)
  → Connectome (graph of shrub dependencies)
```

### Episode Buffer

Every `onTalkFired` record is stored in a circular buffer:

```javascript
{
  shrub: string,
  talk: string,
  slotDeltas: Map<string, number>,
  surprise: number,
  timestamp: number
}
```

Episodes are immutable once recorded. The buffer wraps at capacity — old episodes are overwritten, not deleted. This is the raw experience from which all learning derives.

### Hebbian Matrix

Co-occurrence learning: if talk A and talk B fire within a time window, strengthen their connection. The matrix is a Map of Maps:

```
hebbian[shrubA:talkA][shrubB:talkB] += learningRate
```

Decay is applied per cycle. Connections below threshold are pruned. This provides the connectome — which behaviours are correlated across the application.

### Natural Timescale Discovery

Per-shrub period detection using autocorrelation on event timestamps:

```javascript
_shrubPeriods: Map<shrubName, periodMs>
```

A shrub with a 16ms period (60Hz game loop) behaves differently from a shrub with a 604800000ms period (weekly checkout). The natural period calibrates:
- Crystallization timing (3 periods minimum)
- Surprise sensitivity (events within 1 period are normal)
- Vote propagation speed

### Connectome

The full graph of shrub-to-shrub dependencies, derived from:
1. `@dep` declarations in behaviour (explicit)
2. Hebbian co-occurrence matrix (learned)
3. Cross-shrub slot references (structural)

```javascript
getCrossShrubDeps() → [
  {from: 'Cart', to: 'Inventory', label: 'items', path: '/inventory/stock'},
  {from: 'Player', to: 'Weapon', label: 'equipped', path: '/armory/sword'}
]
```

---

## 13. ShrubLM — Per-Shrub Learning Modules

**Class:** `ShrubLM` (in `rex-pcn.js`)

Grounded in the Thousand Brains theory (Clay, Leadholm, Hawkins 2024). Each shrub gets its own Learning Module that treats slot-space as a reference frame.

### Reference Frame

A shrub with N numeric slots defines an N-dimensional coordinate space. Each slot is an axis. Values are normalized to [0,1] using schema-declared `:min`/`:max` or observed range. The slot-space IS the reference frame — actions are movements in this space.

### Prototype Graph

For each talk that fires on a shrub, the ShrubLM maintains a displacement prototype:

```javascript
prototype = {
  mean: Float64Array(N),        // Running mean of normalized displacement
  m2: Float64Array(N),          // Welford M2 for online variance
  preState: {
    mean: Float64Array(N),      // Running mean of pre-state position
    m2: Float64Array(N),        // Welford M2 of pre-state position
  },
  count: number,                // Total observations
  rejectCount: number,          // Guard rejections recorded
  crystallized: boolean,        // Pattern is stable
  firstSeen: number,            // Timestamp of first observation
  lastSeen: number,             // Timestamp of most recent observation
}
```

**Displacement** = how slots change when a talk fires.
**Pre-state** = what slots are before the talk fires (absolute position).

Both are tracked via Welford's online algorithm — single-pass, numerically stable running mean and variance.

### Observation

On every `onTalkFired` event:

1. Normalize slot deltas to [0,1] using schema ranges
2. Update displacement prototype (Welford mean + M2)
3. Update pre-state prototype (absolute position before mutation)
4. Compute Mahalanobis distance: `√(Σ((delta[i] - mean[i])² / variance[i]))`
5. If distance > 3σ: surprise (this talk did something unusual)
6. Check crystallization criteria

### Crystallization

A prototype crystallizes when the system has high confidence that the pattern is stable:

```
crystallized = (
  count >= 20                                          AND
  (timestamp - firstSeen) >= 3 * naturalPeriod         AND
  all dimensions have variance < 0.25 (normalized)
)
```

The time-span requirement prevents premature crystallization. A 60Hz talk needs the same temporal coverage as a weekly talk — 3 full natural periods.

### Mahalanobis Surprise

```javascript
_mahalanobis(displacement, prototype) {
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const variance = prototype.m2[i] / prototype.count;
    if (variance < 1e-10) continue;  // Constant axis — skip
    const diff = displacement[i] - prototype.mean[i];
    sum += (diff * diff) / variance;
  }
  return Math.sqrt(sum);
}
```

This is the N-dimensional generalization of "how many standard deviations from normal?" One threshold works across all dimensionalities because Mahalanobis distance accounts for per-axis variance.

### Lateral Voting

When a shrub's ShrubLM observes an event, it broadcasts a vote to all connected shrubs (via the `@dep` connectome):

```javascript
vote = {
  source: 'Cart',
  displacement: Float64Array(normalized deltas),
  confidence: 0.85,
  timestamp: 1709000000
}
```

Receiving shrubs evaluate the vote via cosine similarity against their own prototypes:

- **Confirming** (cosine > 0, weight 1.0): Strengthens the receiving LM's confidence
- **Contradicting** (cosine < 0, weight 0.3): Weakly reduces confidence

The asymmetry (confirm > contradict) prevents single outliers from collapsing a well-established model. This is the inter-column voting mechanism from Thousand Brains.

### Model-Free Guard Bypass

When a ShrubLM is `ready` (all prototypes crystallized) and a talk's prototype has `rejectCount === 0` (never been rejected by its guard), the behaviour system can skip guard evaluation entirely:

```javascript
if (lm.ready && lm.isPrototypical(talkName, slotDeltas)) {
  // Bypass guard — model says this action is safe
  bypassed = true;
}
```

`isPrototypical()` checks that all slot deltas are within 2σ of the prototype mean. This is model-free — no symbolic guard evaluation, just statistical containment.

---

## 14. Self-Healing & Self-Modifying Behaviour

Four features that close the loop from learning back to specification.

### Goal-State Generator

When surprise fires (a derive exits schema range), the system can search for a corrective action:

```javascript
ShrubLM.findGoalTalk(slotName, targetValue, currentSlots) {
  // For each prototype:
  //   1. Skip if rejected or under-observed
  //   2. Check if displacement direction matches desired direction
  //   3. Pick closest match by |desiredDelta - mean[axis]|
  return { talk: 'reducePurchase', expectedDelta: -15.5 };
}
```

This is goal-directed planning using the prototype graph as a forward model. The ShrubLM knows which talk moves which slot in which direction — it reverses the question: "what action would fix this?"

### Recovery Policy

Behaviour-level recovery with cooldown:

```javascript
_attemptRecovery(shrubName, slotName, value, schemaRange) {
  // 1. Check cooldown (5s between recovery bursts)
  // 2. Check attempt limit (max 3 per burst)
  // 3. Compute target: clamp value to schema boundary
  // 4. Query goal-state generator for corrective talk
  // 5. Invoke the suggested talk
  // 6. Check if slot is now in range → reset attempts (success)
}
```

Wired in `_recomputeDerives()` — immediately after surprise detection, before the next derive in topological order. Recovery is non-fatal — errors in recovery code are caught and logged.

### Rule Synthesis

When a prototype crystallizes AND has `rejectCount > 0` (the guard rejected it at least once), the system can generate a new guard expression from the pre-state statistics:

```javascript
ShrubLM.synthesizeGuard(talkName) {
  // 1. Get pre-state mean ± 2σ per dimension
  // 2. Denormalize bounds to raw slot units
  // 3. For each dimension the talk touches:
  //    - If lower bound > schema min: emit (gte /slotName lower)
  //    - If upper bound < schema max: emit (lte /slotName upper)
  // 4. Wrap in (and ...) if multiple clauses
  return '(and (gte /total 10.5000) (lte /total 95.2000))';
}
```

The synthesized guard is validated via `Rex.compileExpr()` — if the generated expression doesn't parse as valid Rex, it's rejected. This ensures only well-formed notation enters the source.

### Source Amendment

On crystallization, the synthesized guard is injected into the editor source:

```javascript
_amendSource(rule) {
  // 1. Check user override protection — never clobber user edits
  // 2. Find @talk line in editor via regex
  // 3. If existing @guard: merge with (and existing synthesized)
  // 4. If no guard: insert @guard line after @talk
  // 5. Append '; [learned by ShrubLM]' comment
  // 6. Trigger reparse
}
```

**User override protection:** If the user edits a synthesized guard (removing or modifying the `[learned by ShrubLM]` text), the system adds that talk to `_userAmendedTalks` and never amends it again. Human intent always wins.

### The Closed Loop

```
Rex Source
  → Compile (guards, schemas, derives)
  → Execute (talks fire, slots mutate)
  → Learn (ShrubLM observes displacements)
  → Crystallize (prototypes stabilize)
  → Synthesize (guards from pre-state statistics)
  → Amend Source (inject @guard into Rex)
  → Rex Source (with learned constraints)
  → Compile (now with synthesized guards)
  → ...
```

The system writes its own rules. The rules are readable Rex notation. The user can see, edit, or delete them. The notation is the interface — for humans and for the learning system.

---

## 15. Cross-System Wiring

The orchestrator (`main.js`) wires all transducers together. Every connection is a callback — no shared state.

### Complete Wiring Map

```
behaviour.onTalkFired = (record) => {
  pcn.pushBehaviourEvent(record);        // PCN learns from talks
};

behaviour.onSurpriseSignal = (shrub, slot, val, range) => {
  pcn.pushSurpriseSignal(shrub, slot, val, range);  // PCN records anomaly
};

behaviour.getShrubLM = (shrubName) => {
  return pcn ? pcn.getShrubLM(shrubName) : null;    // Guard bypass queries LM
};

behaviour.getGoalState = (shrub, slot, target, slots) => {
  return pcn ? pcn.findGoalState(shrub, slot, target, slots) : null;  // Recovery
};

pcn.onSurpriseSignal = (shrub, slot, val, range) => {
  // Additional PCN-side surprise handling
};

pcn.onCrystallize = (rule) => {
  _amendSource(rule);                    // Inject learned guard into source
};

behaviour.onChannelPush = (buffer, field, value) => {
  gpu.setChannelValue(buffer, field, value);  // Behaviour → GPU heap
};

gpu.onReadback = (name, data) => {
  behaviour.handleReadback(name, data);  // GPU → Behaviour
};

surface.onElementClick = (id, x, y) => {
  behaviour.fireTalk(shrub, action, {x, y});  // Surface hit → talk invocation
};

form.onFieldChange = (name, value) => {
  gpu.setFormField(name, value);         // Form → GPU heap
  behaviour.setSlotExternal(name, value); // Form → Behaviour
};
```

### Recompile Coordination

When the source changes:

```javascript
parseSource() {
  const tree = Rex.parse(source);
  const structureChanged = /* diff against previous tree */;

  gpu.transduce(tree, structureChanged);
  behaviour.transduce(tree, structureChanged);
  surface.transduce(tree, structureChanged);
  form.transduce(tree, structureChanged);

  if (structureChanged && pcn) {
    // Register schemas and dep graphs for new/changed shrubs
    for (const shrub of behaviour.getShrubs()) {
      pcn.registerShrubSchema(shrub.name, behaviour.getShrubSchema(shrub.name));
    }
    pcn.setDepGraph(behaviour.getCrossShrubDeps());
  }
}
```

---

## 16. Expression Language

Rex expressions compile once and evaluate in O(depth) with no allocation.

### Full Standard Library

#### Arithmetic
`add(a, b)` `sub(a, b)` `mul(a, b)` `div(a, b)` `mod(a, b)`

#### Comparison
`eq(a, b)` `neq(a, b)` `gt(a, b)` `lt(a, b)` `gte(a, b)` `lte(a, b)`

#### Logic
`and(a, b)` `or(a, b)` `not(a)`

#### Trigonometry
`sin(x)` `cos(x)` `tan(x)` `asin(x)` `acos(x)` `atan(x)` `atan2(y, x)`

#### Math
`abs(x)` `sign(x)` `min(a, b)` `max(a, b)` `floor(x)` `ceil(x)` `round(x)` `sqrt(x)` `pow(base, exp)` `log(x)` `log2(x)` `exp(x)`

#### Interpolation & Shaping
`clamp(x, lo, hi)` `lerp(a, b, t)` / `mix(a, b, t)` `smoothstep(lo, hi, x)` `step(edge, x)` `fract(x)`

#### Constants
`pi` (3.14159...) `tau` (6.28318...)

#### Bitwise
`band(a, b)` `bor(a, b)` `bxor(a, b)` `bnot(a)` `shl(a, n)` `shr(a, n)`

#### Vector
`vec2(x, y)` `vec3(x, y, z)` `vec4(x, y, z, w)` `length(v)` `normalize(v)`

#### String
`concat(a, b)` `fmt(template, ...)` `length(s)` `substr(s, start, len)` `upper(s)` `lower(s)` `trim(s)` `replace(s, from, to)` `split(s, delim)` `join(arr, delim)` `index(s, sub)`

#### Control
`if(cond, then, else)` `has(x)` (not null/undefined) `or-else(x, fallback)` (coalesce)

#### Conversion
`to-num(s)` `to-str(n)`

#### Collection
`fold(collection, initial, body)` — Tree traversal with `$acc`, `$item`, `$key`

#### Custom Dispatch
Unknown function names delegate to `ctx.resolve('call', name, args)` — this routes to `@def` functions in the behaviour system, enabling user-defined stdlib extensions.

---

## 17. Extensibility Ceiling

This is the section about what Rex can become. The extension protocol isn't a feature — it's the architecture.

### The Transducer Contract

A transducer is any object that implements:

```javascript
{
  transduce(tree, structureChanged) {
    if (structureChanged) this._compile(tree);
    this._execute();
  }
}
```

That's it. The compile phase walks the Shrub tree and claims node types. The execute phase runs per frame. Everything else is optional.

### What a Custom Transducer Gets for Free

By implementing the transducer contract, a custom transducer automatically inherits:

| Feature | How |
|---------|-----|
| **Reactive slots** | Claim `@shrub` children → slots update automatically via behaviour |
| **GPU heap access** | Register channels → `onChannelPush` writes to heap |
| **ShrubLM learning** | Any shrub with slot deltas gets prototype graphs, surprise detection, guard bypass |
| **Self-healing** | If slots have `:min`/`:max`, recovery policy activates automatically |
| **Rule synthesis** | Crystallized prototypes with rejections → synthesized guards |
| **Source amendment** | Learned rules appear in the Rex source for user review |
| **Form binding** | `(form/fieldName)` optics work for any heap field |
| **Expression evaluation** | Full stdlib available in any attribute |
| **Template reuse** | `@template` / `@use` works across transducer boundaries |
| **Hit testing** | Surface transducer provides click events routable to any talk |

A custom transducer doesn't need to implement any of this. It gets it by participating in the notation.

### Example: Physics Transducer

```javascript
class RexPhysics {
  constructor() {
    this._bodies = new Map();
    this._world = new RapierWorld();  // WASM physics engine
  }

  transduce(tree, structureChanged) {
    if (structureChanged) {
      this._bodies.clear();
      for (const node of tree.children) {
        if (node.type === 'rigidbody') this._compileBody(node);
        if (node.type === 'collider') this._compileCollider(node);
        if (node.type === 'joint') this._compileJoint(node);
      }
    }
    this._world.step();
    this._writeResults();  // Push positions back to behaviour slots
  }
}
```

Rex source:
```
@shrub Ball
  @slot x :type number :default 0 :min -100 :max 100
  @slot y :type number :default 50 :min 0 :max 100
  @slot vx :type number :default 5
  @slot vy :type number :default 0

@rigidbody :shrub Ball :mass 1.0
  @collider :shape sphere :radius 0.5
  @channel :from /ball/x :to /uniforms/ballX :mode every-frame
  @channel :from /ball/y :to /uniforms/ballY :mode every-frame

@talk :shrub Ball :name applyForce
  @input fx :type number
  @input fy :type number
  @set /vx (add /vx /fx)
  @set /vy (add /vy /fy)
```

What the physics transducer gets for free:
- ShrubLM learns the displacement pattern of `applyForce` (how vx/vy change)
- If Ball exits `:min`/`:max` range, recovery fires `findGoalTalk` to find a corrective force
- After 20+ observations spanning 3 natural periods, the prototype crystallizes
- If the guard ever rejected a force, a learned guard like `(lte /vx 50)` appears in the source
- Channels push x/y to GPU heap every frame — the rendering pipeline sees it immediately

### Example: Audio Transducer

```javascript
class RexAudio {
  constructor(audioContext) {
    this._ctx = audioContext;
    this._emitters = new Map();
  }

  transduce(tree, structureChanged) {
    if (structureChanged) {
      for (const node of tree.children) {
        if (node.type === 'emitter') this._compileEmitter(node);
        if (node.type === 'listener') this._compileListener(node);
        if (node.type === 'mix') this._compileMix(node);
      }
    }
    this._updatePositions();  // Read from behaviour slots
  }
}
```

```
@shrub Ambience
  @slot volume :type number :default 0.5 :min 0 :max 1
  @slot reverb :type number :default 0.3

@emitter :shrub Ambience :source "forest.ogg"
  @channel :from /ambience/volume :to audio/masterGain :mode on-change

@talk :shrub Ambience :name fadeIn
  @set /volume (smoothstep 0 1 (div /time 3.0))
```

The learning system discovers: "fadeIn always increases volume by 0.5 over 3 seconds." If someone fires fadeIn when volume is already 0.9, and volume exits `:max 1`, recovery searches for a talk that reduces volume.

### Example: Network Transducer

```javascript
class RexNetwork {
  transduce(tree, structureChanged) {
    if (structureChanged) {
      for (const node of tree.children) {
        if (node.type === 'sync') this._compileSync(node);
        if (node.type === 'rpc') this._compileRPC(node);
      }
    }
    this._processIncoming();
    this._sendOutgoing();
  }
}
```

```
@shrub GameState
  @slot playerX :type number :default 0
  @slot playerY :type number :default 0

@sync :shrub GameState :mode authoritative :tick-rate 20
  @slot playerX
  @slot playerY

@rpc :shrub GameState :name movePlayer
  @input dx :type number
  @input dy :type number
```

The ShrubLM learns the displacement pattern of `movePlayer` across the network. If client prediction diverges from server state (surprise signal), recovery snaps back to the authoritative position.

### Example: AI Transducer

```javascript
class RexAI {
  transduce(tree, structureChanged) {
    if (structureChanged) {
      for (const node of tree.children) {
        if (node.type === 'agent') this._compileAgent(node);
        if (node.type === 'behavior-tree') this._compileBT(node);
      }
    }
    this._tickAgents();
  }
}
```

```
@shrub Guard
  @slot state :type string :default "patrol"
  @slot alertLevel :type number :default 0 :min 0 :max 100
  @slot targetX :type number :default 0
  @slot targetY :type number :default 0

@agent :shrub Guard
  @behavior-tree
    @selector
      @sequence :name investigate
        @guard (gt /alertLevel 50)
        @set /state "investigating"
      @sequence :name patrol
        @set /state "patrolling"

@talk :shrub Guard :name spotPlayer
  @guard (lt /alertLevel 80)
  @set /alertLevel (add /alertLevel 25)
  @set /state "alert"
```

ShrubLM learns: "spotPlayer increases alertLevel by 25 and sets state to alert." After crystallization with guard rejections, it synthesizes: `(and (lt /alertLevel 80) (gte /alertLevel 0))` — the learned precondition. If alertLevel exceeds `:max 100` somehow, recovery fires `findGoalTalk` looking for a talk that decreases alertLevel.

### The Extensibility Ceiling

There is no ceiling. The contract is:

1. **Parse:** Rex gives you a tree. Claim the node types you understand.
2. **Compile:** Transform tree nodes into whatever internal representation you need.
3. **Execute:** Run your logic per frame. Read slots, write slots.
4. **Learn:** Any slot mutation goes through `onTalkFired`. The PCN observes it. Prototypes form. Guards crystallize. Rules appear in the source.

The notation is infinitely extensible because it's just a tree with typed nodes and key-value attributes. The learning system is universally applicable because it operates on slot displacements, not domain semantics. The heap is universally accessible because it's just bytes at compiled offsets.

**What this means in practice:**

- A game studio writes physics, audio, networking, and AI transducers. They share the same shrubs, the same slots, the same learning system. Physics slot changes are visible to AI (via deps). Audio adapts to game state (via channels). Network sync is slot-level. The ShrubLM learns cross-system patterns that no single transducer could see alone.

- A web framework writes layout, routing, data-fetching, and animation transducers. They share the same reactive model. Route changes are talks. Data fetches update slots. Animations are derives. The learning system discovers: "after route-change to /checkout, fetchCart always fires within 200ms" — and preemptively fires it.

- An embedded system writes sensor, actuator, and safety transducers. Sensor readings flow through slots. Safety bounds are `:min`/`:max` on schema. When a reading exits bounds, recovery searches for an actuator talk to correct it. The synthesized guard becomes part of the safety specification.

The common thread: **the notation captures intent, the transducers implement mechanism, and the learning system closes the gap between them.** Every new transducer makes the learning system more powerful because it has more slot dimensions to observe. Every crystallized prototype makes every transducer more efficient because it can bypass guards. The system gets smarter as it gets bigger.

This is not a plugin architecture. It's a **compositional intelligence architecture** where the notation is the shared language, the heap is the shared memory, and the ShrubLM is the shared brain.

---

## 18. Intellectual Lineage

Rex Projection Engine draws from several distinct traditions:

### Sebastian Aaltonen — "No Graphics API"

The GPU is memory, pointers, and stage masks. There is no scene graph, no material system, no mesh abstraction between you and the hardware. RPE takes this literally: one ArrayBuffer, one GPUBuffer, compiled byte offsets. The "graphics API" is the Rex notation — everything between notation and GPU is compiled away.

### Profunctor Optics (Clarke et al., 2020)

Composable bidirectional data accessors. In RPE, tree paths (`/a/b/c`) are composed optics that collapse to byte offsets at compile time. The lens/prism/traversal hierarchy determines how failure propagates through cross-shrub references. This is not a metaphor — the path `%weapon/damage` is a prism composed with a lens, and the composition follows the profunctor algebra.

### Jonathan Blow / JAI

Compile-time execution, flat data, no hidden allocations. RPE's compile/execute split is a direct descendant. The insight: if you know the structure at compile time, runtime is just byte writes. JAI does this for game code in a systems language. RPE does it for a tree notation on the GPU.

### Thousand Brains Theory (Hawkins, Lewis, et al.)

The neocortex is built from repeating cortical columns, each with its own reference frame and model of the world. Columns vote laterally to reach consensus. RPE's ShrubLM is a direct implementation: each shrub is a cortical column, slot-space is the reference frame, prototypes are learned models, `@dep` edges carry lateral votes. Crystallization is the computational analog of stable object recognition.

### Welford's Online Algorithm (1962)

Single-pass running mean and variance. Numerically stable. O(1) per observation. Used in ShrubLM for both displacement prototypes and pre-state position tracking. The same algorithm that stabilized early scientific computing now stabilizes learned behaviour patterns.

### Vello (Linebender Project)

Compute-first 2D rendering. Flatten → coarse → fine pipeline on the GPU. RPE's surface transducer implements this architecture for `@rect`, `@text`, `@panel`, `@shadow`, `@path` rendering. Everything is a compute dispatch, not a rasterizer call.

### Event Sourcing / PLAN Runtime

Every mutation is an immutable event. State is the fold of events. The `onTalkFired` causal record is an event-sourced mutation log. The PLAN bridge (future) will persist these as content-addressed Pins for orthogonal persistence and undo/redo.

---

## Appendix A: File Map

| File | Lines | Class | Role |
|------|-------|-------|------|
| `src/rex-parser.js` | ~940 | `Rex` (object) | Canonical parser, Shrub projection, template expansion, expression compiler |
| `src/rex-gpu.js` | ~2000 | `RexGPU` | GPU transducer: compile, execute, heap, barriers, input |
| `src/rex-behaviour.js` | ~1000 | `RexBehaviour` | Behaviour transducer: shrubs, derives, talks, channels, recovery |
| `src/rex-surface.js` | ~2100 | `RexSurface` | Surface transducer: compute 2D rendering, SDF text, layout, hit test |
| `src/rex-form.js` | ~310 | `RexForm` | Form transducer: HTML widgets, bidirectional sync |
| `src/rex-pcn.js` | ~1950 | `RexPCN`, `ShrubLM` | PCN: episodes, Hebbian, ShrubLMs, voting, rule synthesis |
| `src/main.js` | ~640 | — | Orchestrator: canvas, render loop, wiring, source amendment |

**Total: ~9000 lines. No dependencies except `esbuild` (build) and `@webgpu/types` (typechecking).**

## Appendix B: Extension Point Reference

| Transducer | Method | Signature | Handler Shape |
|------------|--------|-----------|---------------|
| Parser | `Rex.registerContentType` | `(type: string)` | — |
| Parser | `Rex.unregisterContentType` | `(type: string)` | — |
| GPU | `registerCompileType` | `(type, handler)` | `(node, gpu) → void` |
| GPU | `registerCommandType` | `(type, {compile, execute})` | `compile(node, gpu)`, `execute(cmd, gpu)` |
| GPU | `registerResourceType` | `(type, handler)` | `(node, gpu) → void` |
| GPU | `registerInputKey` | `(keyCode: string)` | — |
| GPU | `registerKeyBinding` | `(code, axis, value)` | — |
| Behaviour | `registerSchemaType` | `(type, handler)` | `(node, behaviour) → void` |
| Behaviour | `registerMutationType` | `(type, handler)` | `(node, shrub, ctx) → void` |
| Surface | `registerElementType` | `(type, {collect, measure})` | `collect(node, x, y, clip, surface)`, `measure(node) → {w, h}` |
| Surface | `setFont` | `(fontSpec: string)` | — |
| Form | `registerNodeType` | `(type, handler)` | `(node, form) → HTMLElement` |
| Form | `registerFieldType` | `(type, {render, setExternal})` | `render(node, state, emit)`, `setExternal(el, val)` |
| PCN | `registerShrubAgent` | `(shrub, talks)` | — |
| PCN | `registerShrubSchema` | `(shrub, schema)` | — |

## Appendix C: Callback Wiring Reference

| Source | Target | Callback | Data |
|--------|--------|----------|------|
| Behaviour | PCN | `onTalkFired` | Causal record |
| Behaviour | PCN | `onSurpriseSignal` | shrub, slot, value, range |
| Behaviour | GPU | `onChannelPush` | buffer, field, value |
| GPU | Behaviour | `onReadback` | name, Float32Array |
| Surface | Behaviour | `onElementClick` | elementId, x, y |
| Form | GPU | `onFieldChange` | name, value |
| Form | Behaviour | `onFieldChange` | name, value |
| PCN | Source | `onCrystallize` | {shrub, talk, guard} |
| Behaviour | PCN | `getShrubLM` | shrubName → ShrubLM |
| Behaviour | PCN | `getGoalState` | shrub, slot, target, slots → goal |
