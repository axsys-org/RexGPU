# PLAN Bridge Specification v1

**Connecting the Rex Projection Engine to the PLAN substrate through Shrine's namespace — enabling persistence, undo, event sourcing, and content-addressed asset resolution for the rendering tree.**

---

## The Bridge in One Sentence

Every RPE tree mutation (form field change, `@interact` drag, `@talk` invocation, structure edit) becomes a PLAN event pinned to the event log, and every RPE asset reference (`shrine://`) resolves through PLAN's content-addressed pin system — giving the projection engine persistence, undo, collaboration, and deterministic replay for free.

---

## Why Shrine Is the Boundary

RPE does not talk to PLAN directly. Shrine owns the Shrub → PLAN encoding. RPE operates on Shrubs (the universal node type). Shrine maps Shrubs to PLAN values (Pins, Laws, Apps, Nats). The PLAN bridge is a Shrine-level integration, not an RPE-level one.

```
RPE (GPU transducer)
  ↕ reads/writes Shrubs via compiled optics
SHRINE (namespace + path resolution + reactive deps)
  ↕ encodes Shrubs as PLAN values
PLAN (Pins/Laws/Apps/Nats, event log, persistence)
```

RPE never sees a Pin, never evaluates a Law, never touches the event log. RPE writes `setFloat32(offset, value)` to the heap. Shrine observes the mutation, encodes it as a PLAN event, and pins it. RPE reads `@texture :src shrine://textures/stone`. Shrine resolves the Shrine path to a Pin, extracts the blob, and hands RPE a fetch-able URL.

This layering is critical. It means RPE's compile/execute loop is unchanged. The PLAN bridge is entirely in the Shrine layer, transparent to the GPU transducer.

---

## Part 1: Event Sourcing

### Every Mutation Is an Event

RPE produces three categories of mutations:

| Source | Mutation | Example |
|---|---|---|
| Form field change | `setFormField(name, value)` | Slider dragged → `cam_dist = 5.2` |
| `@interact` mapping | Canvas drag/scroll → form state | Mouse drag → `cam_angle += dx * -0.01` |
| Structure edit | Tree source changed, recompile | User edits Rex source in editor |

The PLAN bridge intercepts these at the Shrine level and produces events:

```
@event
  :id @ud
  :timestamp @da
  :source %form-field
  :shrub "scene-controls"
  :path /cam_dist
  :value 5.2
  :prev 4.8
```

### Event Encoding as PLAN

Each event is a PLAN value:

```
event = Pin(App(Law("event" 6 body)
  id timestamp source shrub path value))
```

- The event is wrapped in a **Pin** — content-addressed, immutable, persistable.
- The Pin hash is the event's identity. Same mutation → same hash → deduplication.
- Events are appended to the **event log** — a PLAN pin chain (linked list of pins).

### Event Log Structure

```
log = Pin(App(App(cons event) prev_log))

;; Or equivalently as a Hitchhiker tree for O(log n) random access:
log = HitchTree(events_by_timestamp)
```

The event log IS the persistence layer. No separate database. No serialization format. PLAN's orthogonal persistence means the log survives process restart, crash, power loss. The PLAN runtime handles durability.

### Append Cost

O(1) per event. Pin creation is O(size of value) — for a small event record, this is microseconds. The GPU render loop is unaffected — event pinning happens asynchronously after the mutation, not in the render path.

---

## Part 2: Undo / Redo

### Tree State as Pin History

Every structure-changing edit (Rex source modification) produces a new tree. The tree is pinned:

```
tree_v1 = Pin(parse("@pass main :clear [0 0 0 1] ..."))
tree_v2 = Pin(parse("@pass main :clear [0.1 0.1 0.1 1] ..."))
tree_v3 = Pin(parse("@pass main :clear [0 0 0.2 1] ..."))
```

Each tree pin is content-addressed. Undo = restore the previous tree pin. Redo = restore the next.

```
history = [tree_v1, tree_v2, tree_v3]
current = 2  ;; pointing at tree_v3

undo():
  current = 1
  rpe.transduce(unpin(history[1]), structureChanged=true)

redo():
  current = 2
  rpe.transduce(unpin(history[2]), structureChanged=true)
```

RPE's compile/execute model handles this naturally. `transduce(tree, true)` triggers a full recompile — new heap layout, new optics, new command list. The old GPU resources are destroyed. The new ones are created. Rendering continues with the restored state.

### Value-Level Undo

For form field changes (not structure changes), undo is simpler. The event log records previous values:

```
@event :source %form-field :path /cam_dist :value 5.2 :prev 4.8

undo_value():
  rpe.setFormField("cam_dist", 4.8)  ;; restore previous value
  ;; This writes to heap at compiled offset — no recompile needed
```

### Undo Granularity

Two levels:
- **Value undo**: Restore previous field value. O(1), no recompile. Reverses a single `setFormField`.
- **Structure undo**: Restore previous tree pin. Triggers full recompile. Reverses a source edit.

The event log distinguishes these by `source` type. The undo system walks the log backwards, skipping events from the same source until it finds the previous distinct state.

---

## Part 3: Asset Resolution via Shrine Paths

### The `shrine://` Protocol

RPE's `_resolveAssetSource(src)` currently passes URLs through and logs a warning for `shrine://`. The PLAN bridge implements the resolution:

```
shrine://textures/stone
  → Shrine path resolution: /textures/stone
  → Shrub lookup: find the Shrub at that path
  → Pin extraction: get the Pin containing the texture blob
  → Blob URL: create an object URL from the pin's bytes
  → Return to RPE: RPE fetches the object URL normally
```

### Pin-Based Assets

In the Shrine namespace, assets are Shrubs with a Pin slot:

```
@shrub stone-texture
  :path /textures/stone
  @slot data :type pin    ;; content-addressed blob
  @slot format :type string :default "rgba8unorm"
  @slot width :type number :default 512
  @slot height :type number :default 512
```

The `data` slot holds a PLAN Pin wrapping the raw image bytes. The Pin hash is the content address — same image bytes = same hash = cached forever.

### Resolution Flow

```
1. RPE compile phase encounters:
   @texture albedo :src shrine://textures/stone

2. _resolveAssetSource("shrine://textures/stone") calls Shrine bridge:
   shrine.resolve("/textures/stone")

3. Shrine walks the namespace tree to find the Shrub at /textures/stone

4. Shrine reads the Pin from the Shrub's data slot:
   pin = shrub.getSlot("data")  ;; PLAN Pin value

5. Shrine extracts bytes from Pin:
   bytes = unpin(pin)  ;; ArrayBuffer of image data

6. Bridge creates a blob URL:
   blob = new Blob([bytes], {type: "image/png"})
   url = URL.createObjectURL(blob)

7. Returns url to RPE. RPE fetches it normally via _loadTextureAsync().
```

### Caching

Pin hashes are permanent. Once a Shrine path resolves to a pin hash, the result is cached by hash. If the asset at `/textures/stone` changes (new pin), the hash changes, and RPE reloads. If it hasn't changed, the cached blob URL is reused.

```
assetCache = Map<PinHash, ObjectURL>

resolve(path):
  pin = shrine.getPin(path)
  if assetCache.has(pin.hash):
    return assetCache.get(pin.hash)
  url = createBlobURL(unpin(pin))
  assetCache.set(pin.hash, url)
  return url
```

### Asset Bundles

For scenes with many textures, a Shrine module can bundle them:

```
@shrub scene-assets
  :path /scenes/dungeon/assets
  @kids textures/[ta]
    @slot data :type pin
    @slot format :type string
  @kids meshes/[ta]
    @slot data :type pin
    @slot format :type string
```

RPE references them as:
```
@texture wall :src shrine://scenes/dungeon/assets/textures/wall
@texture floor :src shrine://scenes/dungeon/assets/textures/floor
```

The module is a Pin. Installing the module = pinning it in the namespace. Uninstalling = unpinning. Content-addressed deduplication means shared textures across modules are stored once.

---

## Part 4: RPE Event Bridge → PCN

### Completing the Loop

The PLAN bridge connects RPE to PCN through the event log. Every RPE mutation becomes a PCN episode:

```
RPE mutation (form field, @interact, structure edit)
  → PLAN event (pinned to event log)
  → PCN episode (SDR-encoded, fed to memory matrix)
```

This means the PCN learns from rendering interactions:
- Which sliders get dragged together
- What camera angles users prefer
- What interaction sequences precede what actions
- Which form fields change in response to which `@interact` events

### Episode Encoding

RPE events map to PCN episode fields:

```
RPE event:
  source: %form-field
  shrub: "scene-controls"
  path: /cam_dist
  value: 5.2

PCN episode:
  source: %render-input
  shrub: "scene-controls"
  path: /cam_dist
  mode: %dif
  → SDR: hash(/scene-controls/cam_dist) → 50 active bits in 2048
```

The `%render-input` source type (defined in PCN Spec Part 2) distinguishes RPE events from user actions, prompts, and code changes. The PCN can weight render-input events differently — they're high-frequency (60fps potential) but low-information (small value changes).

### Rate Limiting

RPE mutations happen at 60fps when a slider is being dragged. The PCN doesn't need 60 events per second for a single slider. The bridge rate-limits:

```
Rate limit strategy:
  - Batch value changes: accumulate over 100ms, emit one event with final value
  - Structure changes: emit immediately (infrequent, high information)
  - @interact events: sample at natural_period / 10 (PCN's per-shrub timescale)
```

This reduces 60 events/second → 10 events/second for continuous interactions, and 1 event per structure change.

---

## Part 5: Behaviour Integration

### Talks as Mutation Interface

The Behaviour Spec defines `@talk` as the named mutation entry point. The PLAN bridge routes talk invocations:

```
@talk :shrub store :name sell
  @input sku :type string
  @input amount :type number
  @guard (gte /products/%sku/quantity %amount)
  @update /products/%sku
    @slot quantity (sub /products/%sku/quantity %amount)
```

When invoked:
1. Talk is a PLAN Law compiled from the `@talk` block
2. Invocation is a PLAN App: `(sell "widget-a" 5)`
3. The App is evaluated by the PLAN runtime
4. Mutations (`@update`) modify Shrub state in the namespace
5. The mutation is pinned as an event in the log
6. If RPE is watching the affected path, the optic fires and updates the heap
7. The PCN sees the episode and updates the memory matrix

### Affordances → RPE State

PCN agents carry affordances that can target RPE state:

```
;; PCN agent affordance targeting RPE:
{type: %talk, shrub: "scene-controls", talk: "set-camera",
 inputs: {angle: 1.57, distance: 5.0, height: 2.0}}
```

This invokes `@talk set-camera` on the `scene-controls` Shrub, which writes to form fields, which write to the heap at compiled offsets, which the GPU reads next frame. The PCN's learned pattern (e.g., "user always sets this camera angle when reviewing this data") executes through the same path system as a manual slider drag.

---

## Part 6: Persistence Model

### What Persists

| Layer | Persistence Mechanism | Survives |
|---|---|---|
| Tree source (Rex text) | Pinned as PLAN value | Process restart, crash |
| Form state (field values) | Event log replay | Process restart |
| Heap state (GPU uniforms) | Recomputed from tree + form state | Nothing (volatile, rebuilt) |
| GPU resources (buffers, textures) | Recomputed from tree + assets | Nothing (volatile, rebuilt) |
| Event log | PLAN pin chain on disk | Everything |
| Asset blobs | PLAN pins (content-addressed) | Everything |

### Restart Sequence

```
1. PLAN runtime starts, loads pin database from disk
2. Shrine namespace rebuilds from persistent pins
3. Last tree pin is loaded: tree = unpin(last_tree_pin)
4. Event log is replayed to restore form state:
   for event in log.since(last_tree_pin.timestamp):
     if event.source == %form-field:
       formState[event.path] = event.value
5. RPE.init() → GPU resources created
6. RPE.transduce(tree, structureChanged=true) → full compile
7. Form state applied to heap via compiled optics
8. Rendering resumes from last known state
```

Total restart time: PLAN boot (~100ms) + event replay (~10ms for 1000 events) + RPE compile (~50ms) = ~200ms to full rendering.

### Collaborative Editing

Multiple clients can share the same PLAN event log via CMP (Content-addressed Message Protocol, defined in PCN Spec Part 18). Each client's mutations are pinned and shared. Conflict resolution:

- **Value conflicts**: Last-write-wins (events are ordered by timestamp)
- **Structure conflicts**: Pin-level merge (PLAN's content-addressing deduplicates identical subtrees)
- **Asset conflicts**: Impossible (pins are immutable, content-addressed)

---

## Part 7: Implementation Phases

### Phase A: Browser Bridge (No PLAN Runtime)

Before PLAN is available in the browser, implement the bridge pattern with localStorage:

```javascript
class PLANBridgeStub {
  constructor() {
    this.log = JSON.parse(localStorage.getItem('rpe-event-log') || '[]');
    this.treeHistory = JSON.parse(localStorage.getItem('rpe-tree-history') || '[]');
    this.assetCache = new Map();
  }

  logEvent(event) {
    this.log.push({...event, timestamp: Date.now()});
    localStorage.setItem('rpe-event-log', JSON.stringify(this.log));
  }

  pinTree(source) {
    const hash = simpleHash(source);
    this.treeHistory.push({hash, source, timestamp: Date.now()});
    localStorage.setItem('rpe-tree-history', JSON.stringify(this.treeHistory));
    return hash;
  }

  undo() {
    if (this.treeHistory.length < 2) return null;
    this.treeHistory.pop();
    localStorage.setItem('rpe-tree-history', JSON.stringify(this.treeHistory));
    return this.treeHistory[this.treeHistory.length - 1].source;
  }

  resolveAsset(shrinePath) {
    // Stub: shrine:// → not yet available
    return null;
  }
}
```

This gives undo/redo and event logging without PLAN. Replace with real PLAN when available.

### Phase B: PLAN via WASM or Server IPC

PLAN compiled to WASM (JPLAN) or running server-side with IPC:

```
Browser RPE ←→ WebSocket ←→ PLAN server (native x86-64)
  |                              |
  Shrine bridge resolves         PLAN runtime manages pins,
  shrine:// paths via IPC        event log, persistence
```

Or with JPLAN (PLAN → WASM):

```
Browser RPE ←→ Shrine WASM ←→ PLAN WASM
  |                |               |
  Same process     Same process    Same process
  (no IPC needed)
```

### Phase C: Native ShrineOS

PLAN runs in-process. Shrine is the native namespace. RPE targets Vulkan+CUDA. No browser, no IPC, no WASM. The bridge is direct function calls:

```
RPE transducer → Shrine API → PLAN runtime
  All in one process.
  Shared memory.
  Zero serialization.
```

---

## Part 8: Integration Points in RPE

### Where Events Are Emitted

| RPE Method | Event Source | Bridge Call |
|---|---|---|
| `setFormField(name, value)` | `%form-field` | `bridge.logEvent({source: 'form-field', path: name, value})` |
| `_applyBuiltins()` | — | No event (deterministic, reconstructible from time) |
| `@interact` handler in `main.js` | `%render-input` | `bridge.logEvent({source: 'render-input', path, value})` |
| Editor text change | `%structure-edit` | `bridge.pinTree(newSource)` |
| `@talk` invocation | `%talk` | `bridge.logEvent({source: 'talk', shrub, talk, inputs})` |

### Where Assets Are Resolved

| RPE Method | Bridge Call |
|---|---|
| `_resolveAssetSource(src)` when `src.startsWith('shrine://')` | `bridge.resolveAsset(src)` |

### Where Undo Is Triggered

| User Action | Bridge Call | RPE Effect |
|---|---|---|
| Ctrl+Z (value) | `bridge.undoValue()` | `setFormField(name, prevValue)` |
| Ctrl+Z (structure) | `bridge.undoTree()` | `transduce(prevTree, true)` |
| Ctrl+Y | `bridge.redo()` | Corresponding restore |

---

## Design Principles

```
SHRINE IS THE BOUNDARY.       RPE never sees PLAN values. Shrine mediates.
EVENTS ARE PINS.              Immutable, content-addressed, persistable.
THE LOG IS THE DATABASE.      No separate persistence layer. Replay = restore.
ASSETS ARE PINS.              Same hash = same blob. Cached forever.
UNDO IS PIN HISTORY.          Restore previous pin. Recompile. Done.
THE BRIDGE IS TRANSPARENT.    RPE's compile/execute loop is unchanged.
RATE LIMIT RENDER EVENTS.     60fps → 10eps for continuous interactions.
PHASE A IS LOCALSTORAGE.      Ship undo/persistence before PLAN is ready.
```

---

## References

**PLAN.** github.com/xocore-tech/PLAN. Pins/Laws/Apps/Nats. Orthogonal persistence. Content-addressed storage. Event log as pin chain.

**PCN Specification v4.** Part 2 (Episodes), Part 17 (RPE Event Bridge). Defines `%render-input` source type and rate limiting strategy.

**RPE Specification v2.** Part 12 (Texture/Asset Pipeline), Part 16 (Integration with Shrine and PLAN). Defines `_resolveAssetSource()` as the Shrine path hook.

**Behaviour Specification v1.** Part 14 (Integration). Defines `@talk` as the mutation interface that the PLAN bridge routes through the event log.
