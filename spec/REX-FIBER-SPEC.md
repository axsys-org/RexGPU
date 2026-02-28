# Rex Fiber Runtime Specification

**Status**: Design Specification
**Date**: 2026-02-27
**Source**: use.gpu fiber system analysis (1505-line fiber.ts, hooks.ts, builtin.ts, queue.ts, tree.ts, util.ts), Mutschler & Philippsen 2014 (adaptive speculative processing), Pedersen & Chalmers 2025 (verified shared channels), Aaltonen 2025 (No Graphics API)
**Purpose**: Define a fiber-based incremental computation runtime for Rex transducers that replaces the current full-recompile model with granular dirty-subtree re-rendering

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Design Principles](#2-design-principles)
3. [Fiber Data Structure](#3-fiber-data-structure)
4. [Hook System](#4-hook-system)
5. [Combinators: Yeet, Gather, Provide, Capture](#5-combinators)
6. [Reconciliation Algorithm](#6-reconciliation-algorithm)
7. [Priority Queue & Scheduling](#7-priority-queue--scheduling)
8. [Stack Slicing](#8-stack-slicing)
9. [Transducer Integration](#9-transducer-integration)
10. [Heap Ownership & Dirty Ranges](#10-heap-ownership--dirty-ranges)
11. [Speculative Execution & α-Adaptation](#11-speculative-execution--α-adaptation)
12. [SharedArrayBuffer & Worker Pool](#12-sharedarraybuffer--worker-pool)
13. [Channel Contention & Claim/Queue](#13-channel-contention--claimqueue)
14. [Snapshot/Replay Recovery](#14-snapshotreplay-recovery)
15. [Migration Path](#15-migration-path)
16. [Invariants & Edge Cases](#16-invariants--edge-cases)
17. [Performance Model](#17-performance-model)

---

## 1. Problem Statement

### 1.1 Current Architecture

Rex operates on a compile/execute split:

```
Rex Source → Parse (Shrub tree)
  → Compile (flat command list + optic table + heap layout + barrier schedule)
  → Execute (tight loop: write bytes → upload dirty range → iterate commands)
```

The compile phase is monolithic. Any structural change — adding a node, removing a shader, editing a panel layout — triggers a **full recompile** of the entire tree. The execute phase is a flat loop that writes heap bytes, uploads the dirty range, and iterates the command list every frame.

### 1.2 What This Costs

1. **Cold recompile on every edit**: Editing a single `@text` node recompiles all GPU pipelines, all surface layouts, all behaviour dependencies. For a Bloomberg Terminal-scale UI (thousands of nodes), this is prohibitive.

2. **No resource lifecycle**: GPU resources (buffers, textures, pipelines) are created at compile time and held forever. There is no way to create a resource when a subtree appears and destroy it when the subtree disappears.

3. **No aggregation pattern**: There is no way for children to emit values that parents collect. Layout requires this (children report intrinsic sizes, parent allocates space). Batching requires this (children emit draw calls, parent sorts and submits). Rex currently does single-pass collection.

4. **No memoization**: Unchanged subtrees are recompiled identically. There is no mechanism to skip computation when inputs haven't changed.

### 1.3 What a Fiber Runtime Provides

A fiber wraps a unit of computation (compiling one node) with:
- **Hook state** that persists across re-renders (memoization, resources, cached values)
- **Dirty tracking** so only changed subtrees re-execute
- **Child reconciliation** so structural changes (add/remove/reorder children) are handled correctly
- **Upstream aggregation** (yeet/gather) so children can emit values to parents
- **Context propagation** so parents can provide data to deep descendants without threading it through every intermediate node

---

## 2. Design Principles

### 2.1 From use.gpu

1. **Fibers are the unit of incremental computation.** Each fiber wraps a function + hook state + children. When inputs change, only that fiber re-executes.

2. **Hooks encode lifecycle.** State, memoization, resource creation/cleanup, context reading — all expressed as hooks called in fixed order during fiber execution.

3. **Combinators compose.** `gather` collects child values. `yeet` emits upstream. `provide`/`capture` propagate context. These are the algebra of dataflow.

4. **Priority queue in tree order.** Dirty fibers render in depth-first tree order. Parents before children. This ensures context flows correctly.

5. **Reconciliation preserves identity.** Keyed children survive reordering. Unkeyed children match by position. New children mount; missing children unmount.

### 2.2 From Aaltonen

6. **The heap is sacred.** Rex's zero-copy heap (one ArrayBuffer, one GPUBuffer, compiled byte offsets, dirty range upload) is more efficient than use.gpu's per-resource allocation. Fibers must not break this. Each fiber owns a **slice** of the heap, not a separate buffer.

7. **Compile-time resolution.** Rex resolves tree paths to byte offsets at compile time (compiled optics). The fiber system must preserve this — fiber compilation produces optic entries, not runtime indirection.

8. **Stage-mask barriers, not resource transitions.** The barrier schedule is computed from the full command list. Fiber-level incremental recompilation must produce a command list that the existing barrier analysis can consume.

### 2.3 From Mutschler & Philippsen

9. **Speculative execution with bounded cost.** Fibers whose inputs haven't settled (e.g., GPU readback still pending, async data loading) can execute speculatively. An α parameter controls speculation aggressiveness: α=1 waits for settled inputs, α=0 executes immediately.

10. **Snapshot before speculation, replay on miss.** Before speculative fiber execution, snapshot the fiber's heap slice. If the speculation was wrong (input arrives that differs from predicted), restore snapshot and re-execute.

11. **TCP-style α adaptation.** Track CPU busy factor. Below target utilization → halve α (more speculation). Above target → reset α to 1.0 then slowly approach previous best.

### 2.4 From Pedersen & Chalmers

12. **Claim/queue on shared heap offsets.** When multiple fibers (or channels) target the same heap offset, use a cooperative claim/queue mechanism. The claimer writes; others queue and execute next frame. No busy-waiting.

13. **Scheduler resources bound correctness.** N execution slots ≥ N concurrent fiber chains for full behavioral equivalence. Fewer slots = still correct (trace refinement), but reduced interleaving.

---

## 3. Fiber Data Structure

### 3.1 RexFiber

```javascript
class RexFiber {
  constructor(id, fn, args, parent, host) {
    // ── Identity ──
    this.id = id;                    // Unique monotonic ID
    this.fn = fn;                    // Compilation function: (fiber, node, ctx) → element
    this.args = args;                // Arguments (typically: node, transducer context)
    this.bound = null;               // Bound function instance (created on first render)

    // ── Tree Position ──
    this.parent = parent;            // Parent fiber (null for root)
    this.depth = parent ? parent.depth + 1 : 0;
    this.path = parent ? [...parent.path, id] : [id];  // Immutable absolute path
    this.key = null;                 // Optional reconciliation key

    // ── Children ──
    this.mount = null;               // Single child fiber
    this.mounts = null;              // Map<key, RexFiber> for multiple children
    this.next = null;                // Continuation fiber (for gather reductions)
    this.order = null;               // Child key ordering (for reconciliation)

    // ── Hook State ──
    this.state = null;               // Array of hook slots [type, value, deps, type, value, deps, ...]
    this.pointer = 0;                // Current position in state array (reset each render)

    // ── Versioning ──
    this.version = 0;                // Incremented when inputs change
    this.memo = -1;                  // Last rendered version (-1 = never rendered)
    this.runs = 0;                   // Total render count (diagnostics)

    // ── Yeet State ──
    this.yeeted = null;              // { emit, gather, root, value, reduced, parent }
    this.fork = false;               // Has parallel mount + next paths

    // ── Transducer Binding ──
    this.transducer = null;          // Which transducer owns this fiber
    this.nodeType = null;            // Rex node type (@rect, @panel, @shader, etc.)

    // ── Heap Ownership ──
    this.heapSlice = null;           // { offset, length } — byte range this fiber owns
    this.commands = null;            // Compiled command list segment from this fiber
    this.optics = null;              // Compiled optic entries from this fiber

    // ── Speculation ──
    this.snapshot = null;            // Heap slice snapshot for rollback
    this.speculative = false;        // Currently executing speculatively
    this.settled = true;             // All inputs are settled (no pending async)

    // ── Context ──
    this.context = parent ? parent.context : { values: new Map(), roots: new Map() };
  }
}
```

### 3.2 Size Budget

A fiber is approximately 280-320 bytes on V8 (object header + 28 fields). For a 10,000-node Rex tree, the fiber tree costs ~3MB. This is acceptable — it's smaller than a single 4K texture.

### 3.3 Path Immutability

Once created, a fiber's `path` never changes. It is the fiber's identity in the priority queue. If a child is rekeyed (structural change), the old fiber is disposed and a new fiber is created at the new position. This avoids the complexity of path mutation propagation.

---

## 4. Hook System

### 4.1 Hook State Layout

Each hook occupies 3 slots in the `fiber.state` array:

```
Index:  [0]     [1]       [2]         [3]     [4]       [5]        ...
         type    value     deps/aux     type    value     deps/aux
         ←── hook 0 ──→               ←── hook 1 ──→
```

`STATE_SLOTS = 3`. The pointer advances by 3 after each hook call.

### 4.2 Hook Types

```javascript
const Hook = {
  STATE:    0,   // Mutable state with setter
  MEMO:     1,   // Dependency-tracked memoization
  ONE:      2,   // Single-dependency memo (fast path)
  CALLBACK: 3,   // Stable function reference
  RESOURCE: 4,   // GPU resource with cleanup
  CONTEXT:  5,   // Read from ancestor provider
  CAPTURE:  6,   // Emit value to ancestor capture
  VERSION:  7,   // Change counter
};
```

### 4.3 Hook Implementations

**rexUseState(initialValue)**

```javascript
function rexUseState(initialValue) {
  const fiber = getCurrentFiber();
  const idx = pushState(fiber, Hook.STATE);
  const state = fiber.state;

  if (state[idx] === undefined) {
    // First render: initialize
    state[idx] = Hook.STATE;
    state[idx + 1] = initialValue;
    state[idx + 2] = (nextValue) => {
      const prev = state[idx + 1];
      if (prev === nextValue) return;  // Identity check — no spurious updates
      state[idx + 1] = nextValue;
      // If called during render: mark for re-render in current batch
      // If called async: schedule for next batch
      if (fiber === getCurrentFiber()) {
        fiber.host.visit(fiber);
      } else {
        fiber.host.schedule(fiber);
      }
    };
  }

  return [state[idx + 1], state[idx + 2]];
}
```

**rexUseMemo(fn, deps)**

```javascript
function rexUseMemo(fn, deps) {
  const fiber = getCurrentFiber();
  const idx = pushState(fiber, Hook.MEMO);
  const state = fiber.state;

  if (state[idx] === undefined || !isSameDeps(state[idx + 2], deps)) {
    state[idx] = Hook.MEMO;
    state[idx + 1] = fn();
    state[idx + 2] = deps;
  }

  return state[idx + 1];
}
```

`isSameDeps`: shallow array comparison — same length, each element `===`.

**rexUseOne(fn, dep)** — optimized single-dep memo:

```javascript
function rexUseOne(fn, dep) {
  const fiber = getCurrentFiber();
  const idx = pushState(fiber, Hook.ONE);
  const state = fiber.state;

  if (state[idx] === undefined || state[idx + 2] !== dep) {
    state[idx] = Hook.ONE;
    state[idx + 1] = fn();
    state[idx + 2] = dep;
  }

  return state[idx + 1];
}
```

**rexUseResource(factory, deps)** — GPU resource with lifecycle cleanup:

```javascript
function rexUseResource(factory, deps) {
  const fiber = getCurrentFiber();
  const idx = pushState(fiber, Hook.RESOURCE);
  const state = fiber.state;

  if (state[idx] === undefined || !isSameDeps(state[idx + 2], deps)) {
    // Cleanup previous resource
    if (state[idx + 1]?.cleanup) {
      state[idx + 1].cleanup();
    }

    let cleanup = null;
    const dispose = (fn) => { cleanup = fn; };
    const value = factory(dispose);

    state[idx] = Hook.RESOURCE;
    state[idx + 1] = { value, cleanup };
    state[idx + 2] = deps;

    // Track for fiber disposal
    fiber.host.track(fiber, () => { if (cleanup) cleanup(); });
  }

  return state[idx + 1].value;
}
```

**rexUseContext(contextKey)**

```javascript
function rexUseContext(contextKey) {
  const fiber = getCurrentFiber();
  const idx = pushState(fiber, Hook.CONTEXT);
  const state = fiber.state;

  const ref = fiber.context.values.get(contextKey);
  if (!ref) return undefined;

  // Register dependency so we re-render when context changes
  if (state[idx] === undefined) {
    const root = fiber.context.roots.get(contextKey);
    if (root) fiber.host.depend(fiber, root);
    state[idx] = Hook.CONTEXT;
    state[idx + 1] = true;  // tracked flag
    state[idx + 2] = contextKey;
  }

  return ref.current;
}
```

### 4.4 Hook Order Invariant

Hooks must be called in the **same order** on every render of a fiber. This is enforced by `pushState`:

```javascript
function pushState(fiber, expectedType) {
  if (!fiber.state) fiber.state = [];
  const idx = fiber.pointer;
  fiber.pointer += STATE_SLOTS;

  // On re-render: verify hook type matches
  if (fiber.state[idx] !== undefined && fiber.state[idx] !== expectedType) {
    throw new Error(`Hook order violation at fiber ${fiber.id}: expected ${expectedType}, got ${fiber.state[idx]}`);
  }

  return idx;
}
```

Conditional hooks are NOT allowed. `if (x) rexUseState()` will throw on re-render when x changes.

### 4.5 State Cleanup (discardState)

When a fiber re-renders and uses fewer hooks than before, the trailing hooks must be cleaned up:

```javascript
function discardState(fiber) {
  if (!fiber.state) return;
  const state = fiber.state;
  // Clean up hooks from pointer to end
  for (let i = fiber.pointer; i < state.length; i += STATE_SLOTS) {
    const type = state[i];
    if (type === Hook.RESOURCE && state[i + 1]?.cleanup) {
      state[i + 1].cleanup();
    }
    // Context: unregister dependency
    if (type === Hook.CONTEXT && state[i + 1]) {
      fiber.host.undepend(fiber, state[i + 2]);
    }
  }
  state.length = fiber.pointer;
}
```

---

## 5. Combinators

### 5.1 Yeet — Emit Value Upstream

A fiber emits a value to its nearest ancestor `gather`:

```javascript
function rexYeet(value) {
  return { type: YEET, value };
}
```

When `updateFiber` encounters a YEET result:
1. Compare value to previous: `value !== fiber.yeeted.value`
2. If changed: call `fiber.yeeted.emit(fiber, value)` to cache the value
3. Bust the yeet cache upward: walk `yeeted.parent` chain, clearing `reduced` at each level
4. Visit the yeet root (continuation fiber) to trigger re-reduction

### 5.2 Gather — Collect Child Values

A parent renders children and collects their yeeted values:

```javascript
function rexGather(calls, then, fallback) {
  return { type: GATHER, calls, then, fallback };
}
```

When `updateFiber` encounters GATHER:
1. Create a continuation fiber (`fiber.next`) that will receive the gathered array
2. Set up yeet state: `{ emit, gather: gatherFiberValues, root: fiber.next }`
3. Mount all `calls` as keyed children — each child inherits the yeet context
4. When all children have yeeted, `gatherFiberValues` walks the mount subtree depth-first, collecting `yeeted.reduced` from each child into an array
5. Pass the array to `then(values)` which renders in the continuation fiber

**Gather traversal**:
```javascript
function gatherFiberValues(fiber) {
  const values = [];

  // Walk single mount
  if (fiber.mount) {
    collectYeetValues(fiber.mount, values);
  }

  // Walk keyed mounts in order
  if (fiber.mounts && fiber.order) {
    for (const key of fiber.order) {
      const child = fiber.mounts.get(key);
      if (child) collectYeetValues(child, values);
    }
  }

  return values;
}

function collectYeetValues(fiber, out) {
  if (fiber.yeeted?.reduced !== undefined) {
    out.push(fiber.yeeted.reduced);
    return;
  }
  // Recurse into children (transparent pass-through)
  if (fiber.mount) collectYeetValues(fiber.mount, out);
  if (fiber.mounts) {
    for (const [, child] of fiber.mounts) {
      collectYeetValues(child, out);
    }
  }
}
```

### 5.3 Provide / Consume — Context Propagation

```javascript
// Parent provides a value
function rexProvide(contextKey, value, calls) {
  return { type: PROVIDE, contextKey, value, calls };
}
```

When `updateFiber` encounters PROVIDE:
1. Create new context: `{ values: new Map(fiber.context.values), roots: new Map(fiber.context.roots) }`
2. Set `context.values.set(contextKey, { current: value })`
3. Set `context.roots.set(contextKey, fiber)`
4. Mount children with this new context

When a descendant calls `rexUseContext(contextKey)`:
1. Look up `fiber.context.values.get(contextKey).current`
2. Register dependency via `host.depend(fiber, root)` — when the provider re-renders with a new value, all dependent fibers are scheduled

### 5.4 Why These Matter for Rex

**Layout** requires gather:
```
@panel layout row
  @rect :width 100         → yeet({ sizing: [100, 100, 100, 100] })
  @text "Hello"             → yeet({ sizing: [45, 16, 200, 16] })
  @rect :width 50           → yeet({ sizing: [50, 50, 50, 50] })
```
The `@panel` fiber gathers child sizings, runs flex layout, then provides clip rects back via context.

**Batching** requires gather:
```
@pass color-pass
  @draw mesh-a              → yeet(drawCommand_a)
  @draw mesh-b              → yeet(drawCommand_b)
```
The `@pass` fiber gathers draw commands, sorts by depth, and emits the sorted command list.

**Clip rects** require provide:
```
@panel :overflow clip
  @rect ...                 → reads ClipContext to clip itself
  @panel                    → reads ClipContext, intersects with own bounds, provides narrower clip
    @text ...               → reads narrowed ClipContext
```

---

## 6. Reconciliation Algorithm

### 6.1 Element Types

A fiber's render function returns one of:

```javascript
// Single child
{ type: USE, fn, args, key }

// Multiple children
[{ type: USE, fn, args, key }, ...]

// Yeet value upstream
{ type: YEET, value }

// Gather children then reduce
{ type: GATHER, calls, then, fallback }

// Provide context to children
{ type: PROVIDE, contextKey, value, calls }

// null = unmount all children
null
```

### 6.2 updateFiber Dispatch

```javascript
function updateFiber(fiber, element) {
  if (element === null || element === undefined) {
    // Unmount all children
    disposeFiberMounts(fiber);
    return;
  }

  if (element.type === YEET) {
    return handleYeet(fiber, element.value);
  }

  if (element.type === GATHER) {
    return handleGather(fiber, element);
  }

  if (element.type === PROVIDE) {
    return handleProvide(fiber, element);
  }

  if (Array.isArray(element)) {
    return reconcileFiberCalls(fiber, element);
  }

  // Single child
  return mountFiberCall(fiber, element);
}
```

### 6.3 Keyed Reconciliation

When a fiber returns an array of children, reconciliation matches old children to new children by key:

```javascript
function reconcileFiberCalls(fiber, calls) {
  if (!fiber.mounts) fiber.mounts = new Map();
  if (!fiber.order) fiber.order = [];

  const newKeys = [];
  const seen = new Set();

  for (let j = 0; j < calls.length; j++) {
    const call = calls[j];
    if (call === null) continue;
    const key = call.key ?? j;
    if (seen.has(key)) throw new Error(`Duplicate key: ${key}`);
    seen.add(key);
    newKeys.push(key);
  }

  // Unmount children whose keys are no longer present
  for (const [key, child] of fiber.mounts) {
    if (!seen.has(key)) {
      disposeFiber(child);
      fiber.mounts.delete(key);
    }
  }

  // Check if order changed (triggers priority queue reorder)
  const rekeyed = !arraysEqual(fiber.order, newKeys);

  // Mount or update each child
  for (let j = 0; j < calls.length; j++) {
    const call = calls[j];
    if (call === null) continue;
    const key = call.key ?? j;
    const existing = fiber.mounts.get(key);

    if (existing) {
      // Update: same key exists
      if (existing.fn === call.fn) {
        // Same function: update args, schedule if changed
        if (!argsEqual(existing.args, call.args)) {
          existing.args = call.args;
          existing.version++;
          fiber.host.visit(existing);
        }
      } else {
        // Function changed: dispose and remount
        disposeFiber(existing);
        const child = makeFiber(fiber.host.nextId(), call.fn, call.args, fiber, fiber.host);
        child.key = key;
        fiber.mounts.set(key, child);
        flushMount(child);
      }
    } else {
      // New child: mount
      const child = makeFiber(fiber.host.nextId(), call.fn, call.args, fiber, fiber.host);
      child.key = key;
      fiber.mounts.set(key, child);
      flushMount(child);
    }
  }

  fiber.order = newKeys;

  if (rekeyed) {
    fiber.host.reorder(fiber);    // Fix priority queue ordering
    bustFiberYeet(fiber, true);   // Invalidate cached reductions
  }
}
```

### 6.4 Flush Mount — Stack Slicing Integration

```javascript
function flushMount(fiber) {
  if (fiber.host.slice(fiber.depth)) {
    // Too deep — defer to queue (prevents stack overflow)
    fiber.host.visit(fiber);
  } else {
    // Inline render (tight loop for shallow subtrees)
    const element = renderFiber(fiber);
    updateFiber(fiber, element);
  }
}
```

---

## 7. Priority Queue & Scheduling

### 7.1 Data Structure

Sorted linked list with Set-based deduplication. Fibers are ordered by their tree position (depth-first traversal order).

```javascript
class FiberQueue {
  constructor() {
    this.head = null;
    this.tail = null;
    this.hint = null;     // Insertion hint for locality
    this.set = new Set(); // O(1) dedup
  }

  insert(fiber) {
    if (this.set.has(fiber)) return;
    this.set.add(fiber);

    const node = { fiber, next: null };

    if (!this.head) {
      this.head = this.tail = node;
      return;
    }

    // Fast path: append (common for depth-first scheduling)
    if (compareFibers(this.tail.fiber, fiber) <= 0) {
      this.tail.next = node;
      this.tail = node;
      return;
    }

    // Fast path: prepend
    if (compareFibers(fiber, this.head.fiber) < 0) {
      node.next = this.head;
      this.head = node;
      return;
    }

    // General: insert at sorted position using hint
    let cursor = (this.hint && compareFibers(this.hint.fiber, fiber) <= 0)
      ? this.hint : this.head;

    while (cursor.next && compareFibers(cursor.next.fiber, fiber) < 0) {
      cursor = cursor.next;
    }

    node.next = cursor.next;
    cursor.next = node;
    if (!node.next) this.tail = node;
    this.hint = cursor;  // Cache for next insertion
  }

  pop() {
    if (!this.head) return null;
    const fiber = this.head.fiber;
    this.head = this.head.next;
    if (!this.head) { this.tail = null; this.hint = null; }
    this.set.delete(fiber);
    return fiber;
  }

  peek() { return this.head?.fiber ?? null; }
}
```

### 7.2 Fiber Comparison

Fibers are compared by their immutable `path` arrays (depth-first tree order):

```javascript
function compareFibers(a, b) {
  const pa = a.path, pb = b.path;
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return pa.length - pb.length;  // Shallower fiber first
}
```

This ensures parents render before children, and siblings render in document order.

### 7.3 Action Scheduler

External events (form changes, async callbacks, setState) are batched into micro-task flushes:

```javascript
class ActionScheduler {
  constructor(onFlush) {
    this.queue = [];
    this.pending = false;
    this.onFlush = onFlush;
  }

  schedule(fiber, task) {
    this.queue.push({ fiber, task });
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    this.pending = false;
    const batch = this.queue;
    this.queue = [];

    const fibers = [];
    for (const { fiber, task } of batch) {
      if (!task || task() !== false) {
        fibers.push(fiber);
      }
    }

    // Deduplicate
    this.onFlush([...new Set(fibers)]);
  }
}
```

### 7.4 Render Loop Integration

The fiber host integrates with Rex's existing `requestAnimationFrame` loop:

```javascript
class RexFiberHost {
  constructor() {
    this._nextId = 1;
    this._queue = new FiberQueue();
    this._scheduler = new ActionScheduler((fibers) => {
      for (const f of fibers) this._queue.insert(f);
    });
    this._slicer = new StackSlicer(20);  // max depth before deferring
    this._deps = new DependencyTracker();
    this._resources = new Map();  // fiber.id → [cleanup functions]

    // Speculation state (§11)
    this._alpha = 1.0;
    this._busyFactor = 0;
    this._targetBusy = [0.8, 0.9];
  }

  nextId()           { return this._nextId++; }
  visit(fiber)       { this._queue.insert(fiber); }
  schedule(fiber, t) { this._scheduler.schedule(fiber, t); }
  peek()             { return this._queue.peek(); }
  pop()              { return this._queue.pop(); }
  depth(d)           { this._slicer.depth(d); }
  slice(d)           { return this._slicer.slice(d); }

  depend(fiber, root)   { this._deps.depend(fiber, root); }
  undepend(fiber, root) { this._deps.undepend(fiber, root); }

  track(fiber, cleanup) {
    if (!this._resources.has(fiber.id)) this._resources.set(fiber.id, []);
    this._resources.get(fiber.id).push(cleanup);
  }

  dispose(fiber) {
    const cleanups = this._resources.get(fiber.id);
    if (cleanups) {
      for (const fn of cleanups) fn();
      this._resources.delete(fiber.id);
    }
  }

  reorder(fiber) {
    this._queue.reorder(fiber);
  }

  // Called each frame from main.js render loop
  flush() {
    const t0 = performance.now();

    while (this._queue.peek()) {
      const fiber = this._queue.pop();
      this._slicer.depth(fiber.depth);
      const element = renderFiber(fiber);
      updateFiber(fiber, element);
    }

    const elapsed = performance.now() - t0;
    this._updateBusyFactor(elapsed);
  }
}
```

---

## 8. Stack Slicing

### 8.1 Problem

Deep Rex trees (panels nested 50+ levels) cause stack overflow in the tight render→update→flushMount recursion.

### 8.2 Solution

A stack slicer tracks the depth delta from the dispatch root. When it exceeds a threshold, deferred children are queued instead of rendered inline.

```javascript
class StackSlicer {
  constructor(maxDepth) {
    this.maxDepth = maxDepth;
    this.dispatchDepth = 0;
    this.sliced = false;
  }

  // Called when dispatch starts processing a new fiber from the queue
  depth(d) {
    this.dispatchDepth = d;
    this.sliced = false;
  }

  // Called before inline rendering a child
  slice(d) {
    if (this.sliced) return true;              // Sticky: once sliced, all descendants defer
    this.sliced = (d - this.dispatchDepth) > this.maxDepth;
    return this.sliced;
  }
}
```

**Behavior**: Shallow subtrees (depth delta ≤ 20) render synchronously in a tight loop. Deep subtrees queue children for the next `pop()` from the priority queue. The queue maintains correct tree-order, so parent-before-child is preserved even across slice boundaries.

---

## 9. Transducer Integration

### 9.1 Transducer as Fiber Factory

Each Rex transducer becomes a fiber factory. When the root fiber encounters a node, it delegates to the transducer that claims that node type:

```javascript
// Root compilation function
function compileRexNode(fiber, node) {
  const type = node.rune + node.word;  // e.g., "@panel", "@shader", "@shrub"

  // Route to claiming transducer
  const transducer = fiber.host.getTransducer(type);
  if (!transducer) {
    fiber.host.warn(`Unknown node type: ${type}`);
    return null;
  }

  return transducer.compileFiber(fiber, node);
}
```

### 9.2 Surface Transducer (Example)

```javascript
class RexSurface {
  compileFiber(fiber, node) {
    const type = node.rune + node.word;

    switch (type) {
      case '@panel': return this._compilePanelFiber(fiber, node);
      case '@rect':  return this._compileRectFiber(fiber, node);
      case '@text':  return this._compileTextFiber(fiber, node);
      case '@path':  return this._compilePathFiber(fiber, node);
      case '@shadow':return this._compileShadowFiber(fiber, node);
      default: {
        const handler = this._elementHandlers.get(type);
        if (handler) return handler.compile(fiber, node);
        return null;
      }
    }
  }

  _compilePanelFiber(fiber, node) {
    // Parse panel attributes (memoized)
    const attrs = rexUseMemo(() => parsePanelAttrs(node.attrs), [node.attrs]);

    // Gather child sizes via yeet
    return rexGather(
      node.children.map((child, i) => ({
        type: USE,
        fn: compileRexNode,
        args: [child],
        key: child.attrs?.key ?? i,
      })),
      (childSizings) => {
        // Phase 2: run flex layout
        const layout = rexUseMemo(
          () => fitFlex(childSizings, attrs),
          [childSizings, attrs]
        );

        // Provide clip rect context to children
        return rexProvide(ClipContext, layout.clipRect, () => {
          // Emit own sizing upstream
          rexYeet({ sizing: layout.sizing, commands: layout.commands });
        });
      }
    );
  }

  _compileRectFiber(fiber, node) {
    const attrs = rexUseMemo(() => parseRectAttrs(node.attrs), [node.attrs]);
    const clipRect = rexUseContext(ClipContext);

    // Allocate heap slice for this rect's data
    const heapSlice = rexUseMemo(() => {
      return fiber.host.allocHeap(RECT_STRUCT_SIZE);
    }, []);

    // Write rect data to heap
    rexUseMemo(() => {
      writeRectToHeap(fiber.host.heapView, heapSlice.offset, attrs, clipRect);
      fiber.host.markDirty(heapSlice.offset, heapSlice.offset + RECT_STRUCT_SIZE);
    }, [attrs, clipRect]);

    // Emit sizing upstream
    rexYeet({
      sizing: [attrs.width, attrs.height, attrs.width, attrs.height],
      commands: [{ type: 'draw-rect', heapOffset: heapSlice.offset }],
    });
  }
}
```

### 9.3 GPU Transducer (Example)

```javascript
class RexGPU {
  compileFiber(fiber, node) {
    const type = node.rune + node.word;

    switch (type) {
      case '@struct':   return this._compileStructFiber(fiber, node);
      case '@buffer':   return this._compileBufferFiber(fiber, node);
      case '@shader':   return this._compileShaderFiber(fiber, node);
      case '@pipeline': return this._compilePipelineFiber(fiber, node);
      case '@pass':     return this._compilePassFiber(fiber, node);
      case '@dispatch': return this._compileDispatchFiber(fiber, node);
      case '@draw':     return this._compileDrawFiber(fiber, node);
      // ...
    }
  }

  _compileShaderFiber(fiber, node) {
    // GPU resource with lifecycle cleanup
    const module = rexUseResource((dispose) => {
      const code = extractWGSL(node);
      const mod = fiber.host.device.createShaderModule({ code, label: node.word });
      dispose(() => mod.destroy?.());
      return mod;
    }, [node.content]);  // Only recreate if shader source changes

    // Emit module upstream for pipeline creation
    rexYeet({ type: 'shader-module', name: node.word, module });
  }

  _compilePassFiber(fiber, node) {
    // Gather all draw/dispatch commands from children
    return rexGather(
      node.children.map((child, i) => ({
        type: USE, fn: compileRexNode, args: [child], key: i,
      })),
      (commands) => {
        // Sort draw commands (opaque front-to-back, transparent back-to-front)
        const sorted = rexUseMemo(() => sortCommands(commands.flat()), [commands]);

        // Emit pass with sorted command list
        rexYeet({
          type: 'render-pass',
          commands: sorted,
          colorAttachments: parseAttachments(node.attrs),
        });
      }
    );
  }
}
```

### 9.4 Behaviour Transducer (Example)

The behaviour transducer is special — it doesn't produce GPU commands directly. Instead, it manages reactive state that feeds into other transducers via channels.

```javascript
class RexBehaviour {
  compileFiber(fiber, node) {
    const type = node.rune + node.word;

    switch (type) {
      case '@shrub':  return this._compileShrubFiber(fiber, node);
      case '@derive': return this._compileDeriveFiber(fiber, node);
      case '@talk':   return this._compileTalkFiber(fiber, node);
      case '@dep':    return this._compileDepFiber(fiber, node);
      case '@channel':return this._compileChannelFiber(fiber, node);
    }
  }

  _compileShrubFiber(fiber, node) {
    // Shrub schema persists across re-renders
    const [slots, setSlot] = rexUseState(() => compileSchema(node));

    // Provide shrub context to children (derives, talks, deps, channels)
    return rexProvide(ShrubContext, { slots, setSlot, name: node.word },
      node.children.map((child, i) => ({
        type: USE, fn: compileBehaviourNode, args: [child], key: i,
      }))
    );
  }

  _compileChannelFiber(fiber, node) {
    const shrub = rexUseContext(ShrubContext);
    const attrs = rexUseMemo(() => parseChannelAttrs(node.attrs), [node.attrs]);

    // Channel bridge: behaviour slot → GPU heap offset
    // On slot change, write to heap
    rexUseMemo(() => {
      const value = shrub.slots[attrs.from];
      if (value !== undefined) {
        fiber.host.heapView.setFloat32(attrs.heapOffset, value, true);
        fiber.host.markDirty(attrs.heapOffset, attrs.heapOffset + 4);
      }
    }, [shrub.slots[attrs.from]]);
  }
}
```

---

## 10. Heap Ownership & Dirty Ranges

### 10.1 The Problem

Rex's zero-copy heap is its greatest advantage over use.gpu. The fiber system must not break it. Each fiber that writes heap data must own a contiguous slice, and dirty tracking must remain a single min/max range per frame.

### 10.2 Heap Allocator

```javascript
class FiberHeapAllocator {
  constructor(heapView, heapSize) {
    this.heapView = heapView;      // DataView over SharedArrayBuffer
    this.heapSize = heapSize;
    this.freeList = [{ offset: 0, length: heapSize }];
    this.dirtyMin = heapSize;
    this.dirtyMax = 0;
  }

  alloc(size, alignment = 16) {
    // Round size up to alignment
    size = (size + alignment - 1) & ~(alignment - 1);

    // First-fit from free list
    for (let i = 0; i < this.freeList.length; i++) {
      const block = this.freeList[i];
      const alignedOffset = (block.offset + alignment - 1) & ~(alignment - 1);
      const waste = alignedOffset - block.offset;

      if (block.length - waste >= size) {
        // Split block
        const slice = { offset: alignedOffset, length: size };
        if (waste > 0) {
          // Keep waste as a free block
          block.length = waste;
          if (block.length + size < block.length + waste + size) {
            // Remaining after allocation
            const remaining = block.length - waste - size;
            if (remaining > 0) {
              this.freeList.splice(i + 1, 0, { offset: alignedOffset + size, length: remaining });
            }
          }
        } else {
          const remaining = block.length - size;
          if (remaining > 0) {
            block.offset = alignedOffset + size;
            block.length = remaining;
          } else {
            this.freeList.splice(i, 1);
          }
        }
        return slice;
      }
    }

    throw new Error(`Heap exhausted: cannot allocate ${size} bytes`);
  }

  free(slice) {
    // Insert into free list (sorted by offset), merge adjacent blocks
    let i = 0;
    while (i < this.freeList.length && this.freeList[i].offset < slice.offset) i++;
    this.freeList.splice(i, 0, slice);

    // Merge with next
    if (i + 1 < this.freeList.length) {
      const curr = this.freeList[i], next = this.freeList[i + 1];
      if (curr.offset + curr.length === next.offset) {
        curr.length += next.length;
        this.freeList.splice(i + 1, 1);
      }
    }
    // Merge with prev
    if (i > 0) {
      const prev = this.freeList[i - 1], curr = this.freeList[i];
      if (prev.offset + prev.length === curr.offset) {
        prev.length += curr.length;
        this.freeList.splice(i, 1);
      }
    }
  }

  markDirty(min, max) {
    if (min < this.dirtyMin) this.dirtyMin = min;
    if (max > this.dirtyMax) this.dirtyMax = max;
  }

  resetDirty() {
    this.dirtyMin = this.heapSize;
    this.dirtyMax = 0;
  }

  isDirty() {
    return this.dirtyMin < this.dirtyMax;
  }
}
```

### 10.3 Fiber-Heap Lifecycle

1. **Mount**: Fiber allocates heap slice via `host.allocHeap(size)` inside `rexUseResource`.
2. **Update**: Fiber writes to its slice via `host.heapView.setFloat32(offset, value)`, marks dirty.
3. **Unmount**: `rexUseResource` cleanup calls `host.freeHeap(slice)`, returning bytes to the free list.
4. **Frame end**: `host.uploadDirtyRange()` uploads `[dirtyMin, dirtyMax]` to the GPU buffer. Then `resetDirty()`.

### 10.4 Heap Defragmentation

Over time, mount/unmount cycles fragment the heap. When fragmentation exceeds a threshold (e.g., 50% of free space is non-contiguous), the host performs a compaction:

1. Allocate new heap of same size
2. Walk all live fibers, copy their heap slices to new contiguous positions
3. Update all optic entries with new offsets
4. Swap heap buffers
5. Mark entire heap dirty for upload

This is expensive but rare. The free-list merge in `free()` prevents most fragmentation.

---

## 11. Speculative Execution & α-Adaptation

### 11.1 Motivation (Mutschler & Philippsen)

Some fibers depend on unsettled inputs:
- GPU readback (async `mapAsync`, arrives 1-3 frames late)
- Network data (WebSocket, fetch)
- Audio analysis (FFT data from AudioWorklet)

Waiting for all inputs to settle before rendering adds latency. Speculative execution reduces this by rendering with predicted inputs and rolling back on miss.

### 11.2 The α Parameter

```
α ∈ [0, 1]

α = 1.0: Pure buffering. Wait for all inputs to settle before rendering.
α = 0.0: Full speculation. Render immediately with best available data.
```

A fiber with unsettled inputs is rendered when:
```
inputTimestamp + α × K ≤ currentTime
```
Where K is the expected input latency (e.g., 3 frames for GPU readback).

### 11.3 Adaptation Algorithm

```javascript
// Inside RexFiberHost
_updateBusyFactor(frameElapsed) {
  const budget = 1000 / 60;  // 16.67ms at 60fps
  const bc = frameElapsed / budget;

  // Exponential moving average
  this._busyFactor = 0.9 * this._busyFactor + 0.1 * bc;

  const [lo, hi] = this._targetBusy;

  if (this._busyFactor < lo) {
    // Under-utilized: speculate more aggressively
    this._alpha = Math.max(0, this._alpha * 0.5);
  } else if (this._busyFactor > hi) {
    // Over-utilized: back off to pure buffering
    this._prevBestAlpha = this._alpha;
    this._alpha = 1.0;
  } else if (this._alpha === 1.0 && this._prevBestAlpha !== undefined) {
    // In target zone but at full buffering: slowly approach previous best
    this._alpha = Math.max(this._prevBestAlpha,
      this._alpha - 0.05);
  }
}
```

### 11.4 Per-Fiber Speculation

Not all fibers need speculation. Only fibers whose inputs include async sources are candidates:

```javascript
function shouldSpeculate(fiber, host) {
  if (fiber.settled) return false;              // All inputs settled — no speculation needed
  if (host._alpha >= 1.0) return false;         // Pure buffering mode
  return fiber.lastInputTime + host._alpha * fiber.expectedLatency <= performance.now();
}
```

### 11.5 Speculation Cost Model

From Mutschler's results: snapshot overhead < 0.5μs, CPU overhead < 2% in failure-free operation. For Rex, snapshotting a fiber's heap slice (typically 64-256 bytes) costs:
- `Uint8Array.set()` to copy bytes: ~50ns for 256 bytes
- One allocation for the snapshot buffer: amortized via pool

Total speculation overhead per fiber: < 1μs. For 100 speculative fibers per frame: < 100μs. Well within the 16.67ms frame budget.

---

## 12. SharedArrayBuffer & Worker Pool

### 12.1 SharedArrayBuffer Heap

Replace the heap's `ArrayBuffer` with `SharedArrayBuffer` to enable worker access:

```javascript
// In RexFiberHost constructor
const heapBuffer = new SharedArrayBuffer(heapSize);
const heapView = new DataView(heapBuffer);
```

All existing `DataView` reads/writes work identically. No code changes to the optic system.

**Requirement**: The dev server must send COOP/COEP headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### 12.2 Worker Pool for Derive Evaluation

Pure-function `@derive` chains can be evaluated on worker threads:

```javascript
// Main thread
class DeriveWorkerPool {
  constructor(heapBuffer, workerCount = navigator.hardwareConcurrency - 1) {
    this.workers = [];
    this.pending = new Map();  // taskId → { resolve, reject }
    this.nextTask = 0;

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker('derive-worker.js');
      w.postMessage({ type: 'init', heapBuffer });  // Share the buffer
      w.onmessage = (e) => this._onResult(e.data);
      this.workers.push(w);
    }
  }

  evaluate(deriveSpec) {
    const taskId = this.nextTask++;
    const workerIdx = taskId % this.workers.length;

    return new Promise((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
      this.workers[workerIdx].postMessage({
        type: 'eval',
        taskId,
        expr: deriveSpec.compiledExpr,
        inputOffsets: deriveSpec.inputOffsets,
        outputOffset: deriveSpec.outputOffset,
      });
    });
  }

  _onResult({ taskId, value, error }) {
    const p = this.pending.get(taskId);
    if (!p) return;
    this.pending.delete(taskId);
    if (error) p.reject(new Error(error));
    else p.resolve(value);
  }
}
```

```javascript
// derive-worker.js
let heapView = null;

self.onmessage = (e) => {
  const { type } = e.data;

  if (type === 'init') {
    heapView = new DataView(e.data.heapBuffer);
    return;
  }

  if (type === 'eval') {
    const { taskId, expr, inputOffsets, outputOffset } = e.data;
    try {
      // Read inputs from shared heap
      const inputs = {};
      for (const [name, offset] of Object.entries(inputOffsets)) {
        inputs[name] = heapView.getFloat32(offset, true);
      }

      // Evaluate pure expression
      const result = evalCompiledExpr(expr, inputs);

      // Write result to shared heap
      heapView.setFloat32(outputOffset, result, true);

      self.postMessage({ taskId, value: result });
    } catch (err) {
      self.postMessage({ taskId, error: err.message });
    }
  }
};
```

### 12.3 Atomics for Contested Offsets

When multiple workers may write the same heap offset (multiple channels targeting the same field), use `Atomics` for claim/queue semantics:

```javascript
// Claim-based write (Pedersen pattern over SharedArrayBuffer)
function claimHeapWrite(heapBuffer, lockOffset, dataOffset, value) {
  const lock = new Int32Array(heapBuffer, lockOffset, 1);

  // Try to claim (CAS: 0 → 1)
  if (Atomics.compareExchange(lock, 0, 0, 1) === 0) {
    // Claimed — write and release
    const view = new DataView(heapBuffer);
    view.setFloat32(dataOffset, value, true);
    Atomics.store(lock, 0, 0);  // Release
    Atomics.notify(lock, 0);    // Wake waiters
    return true;
  }

  // Contended — queue for next frame
  return false;
}
```

### 12.4 Scheduler Resources (Pedersen's Finding)

From Pedersen & Chalmers: N schedulers ≥ N processes for full failures refinement. For the worker pool:

- `navigator.hardwareConcurrency - 1` workers (leave one for main thread + GPU)
- If more derive chains than workers: some chains serialize (trace refinement — still correct, but reduced interleaving)
- The system never deadlocks or livelocks (cooperative scheduling, no circular waits)

---

## 13. Channel Contention & Claim/Queue

### 13.1 Problem

Multiple `@channel` bridges may target the same GPU heap offset in the same frame. Currently, the last write wins silently.

### 13.2 Claim/Queue Mechanism (Pedersen Pattern)

```javascript
class ChannelContention {
  constructor() {
    this._claims = new Map();  // heapOffset → { owner: fiberId, queue: [fiberId, ...] }
  }

  tryClaim(heapOffset, fiberId) {
    if (!this._claims.has(heapOffset)) {
      this._claims.set(heapOffset, { owner: fiberId, queue: [] });
      return true;
    }

    const claim = this._claims.get(heapOffset);
    if (claim.owner === fiberId) return true;  // Already own it

    // Contended: queue for next frame
    if (!claim.queue.includes(fiberId)) {
      claim.queue.push(fiberId);
    }
    return false;
  }

  release(heapOffset, fiberId) {
    const claim = this._claims.get(heapOffset);
    if (!claim || claim.owner !== fiberId) return;

    if (claim.queue.length > 0) {
      // Hand off to next waiter
      claim.owner = claim.queue.shift();
      // Schedule the next owner's fiber for re-render
      return claim.owner;
    }

    this._claims.delete(heapOffset);
    return null;
  }

  // Called at frame end: release all claims
  frameEnd() {
    for (const [offset, claim] of this._claims) {
      if (claim.queue.length > 0) {
        claim.owner = claim.queue.shift();
        // Schedule queued fibers
      }
    }
  }
}
```

### 13.3 Integration with @channel

```javascript
_compileChannelFiber(fiber, node) {
  const shrub = rexUseContext(ShrubContext);
  const attrs = rexUseMemo(() => parseChannelAttrs(node.attrs), [node.attrs]);

  rexUseMemo(() => {
    const value = shrub.slots[attrs.from];
    if (value === undefined) return;

    // Try to claim the heap offset
    if (fiber.host.contention.tryClaim(attrs.heapOffset, fiber.id)) {
      fiber.host.heapView.setFloat32(attrs.heapOffset, value, true);
      fiber.host.markDirty(attrs.heapOffset, attrs.heapOffset + 4);
      fiber.host.contention.release(attrs.heapOffset, fiber.id);
    }
    // If claim fails: queued for next frame automatically
  }, [shrub.slots[attrs.from]]);
}
```

---

## 14. Snapshot/Replay Recovery

### 14.1 Integration with ShrubLM

Rex already has surprise detection + recovery via ShrubLM. The fiber snapshot mechanism formalizes this:

```javascript
function speculativeRender(fiber, host) {
  // Take snapshot of heap slice
  if (fiber.heapSlice) {
    const src = new Uint8Array(host.heapBuffer, fiber.heapSlice.offset, fiber.heapSlice.length);
    if (!fiber.snapshot) fiber.snapshot = new Uint8Array(fiber.heapSlice.length);
    fiber.snapshot.set(src);
  }

  // Mark as speculative
  fiber.speculative = true;

  // Render with current (possibly stale) inputs
  const element = renderFiber(fiber);
  updateFiber(fiber, element);
}

function rollbackFiber(fiber, host) {
  if (!fiber.snapshot || !fiber.heapSlice) return;

  // Restore heap slice from snapshot
  const dst = new Uint8Array(host.heapBuffer, fiber.heapSlice.offset, fiber.heapSlice.length);
  dst.set(fiber.snapshot);
  host.markDirty(fiber.heapSlice.offset, fiber.heapSlice.offset + fiber.heapSlice.length);

  fiber.speculative = false;
  fiber.snapshot = null;

  // Re-render with correct inputs
  host.visit(fiber);
}
```

### 14.2 When to Rollback

```javascript
// Called when an async input arrives
function onAsyncInput(fiber, actualValue) {
  if (!fiber.speculative) {
    // Not speculating — normal update
    fiber.args = [...fiber.args.slice(0, -1), actualValue];
    fiber.version++;
    fiber.host.visit(fiber);
    return;
  }

  // Check if speculation was correct
  if (fiber.yeeted?.value === actualValue) {
    // Correct speculation — just mark as settled
    fiber.speculative = false;
    fiber.settled = true;
    fiber.snapshot = null;
    return;
  }

  // Wrong speculation — rollback and re-render
  rollbackFiber(fiber, fiber.host);
}
```

---

## 15. Migration Path

### 15.1 Phase 1: Fiber Core (No Transducer Changes)

1. Implement `RexFiber`, `FiberQueue`, `RexFiberHost`, `StackSlicer`
2. Implement hooks: `rexUseState`, `rexUseMemo`, `rexUseOne`, `rexUseResource`, `rexUseContext`
3. Implement `renderFiber`, `updateFiber`, `reconcileFiberCalls`, `flushMount`
4. Implement `rexYeet`, `rexGather`, `rexProvide`
5. Write test suite: hook ordering, memoization, reconciliation, yeet/gather

**Deliverable**: A standalone fiber runtime that can be tested without any transducer integration.

### 15.2 Phase 2: Surface Transducer Migration

The surface transducer is the best first candidate because:
- Layout requires gather (children report sizes, parent allocates)
- Clip rects require provide/context (parent clips descendants)
- Incremental text rendering benefits from memoization (SDF atlas doesn't change when layout changes)

1. Wrap each surface element type in a fiber compilation function
2. `@panel` uses gather to collect child sizings + provide for clip rects
3. `@rect`, `@text`, `@path`, `@shadow` use yeet to report sizing
4. `rexUseResource` manages SDF atlas allocation
5. `rexUseMemo` skips unchanged layout computations

**Deliverable**: Surface rendering works through fibers. Editing a `@text` node only recompiles that text fiber + its parent panel's layout, not the entire surface.

### 15.3 Phase 3: GPU Transducer Migration

1. `@struct` fibers allocate heap slices via `rexUseResource`
2. `@shader` fibers create `GPUShaderModule` via `rexUseResource` (destroy on unmount)
3. `@pipeline` fibers create `GPURenderPipeline` via `rexUseResource`
4. `@pass` fibers gather draw/dispatch commands from children
5. `@draw`/`@dispatch` fibers yeet commands to parent pass
6. Barrier schedule recomputed from gathered command list

**Deliverable**: GPU resources have proper lifecycle. Adding/removing a `@draw` node doesn't recompile unrelated pipelines.

### 15.4 Phase 4: Behaviour Transducer Migration

1. `@shrub` fibers provide schema context
2. `@derive` fibers read shrub context + compute derived values
3. `@channel` fibers read shrub context + write to heap (with contention)
4. `@talk` fibers register action handlers via `rexUseCallback`
5. `@dep` fibers register cross-shrub reactions

**Deliverable**: Behaviour system runs through fibers. Adding a new `@derive` doesn't recompile the shrub schema.

### 15.5 Phase 5: SharedArrayBuffer + Workers

1. Swap `ArrayBuffer` → `SharedArrayBuffer`
2. Add COOP/COEP headers to dev server
3. Implement `DeriveWorkerPool` for pure-function derive chains
4. Implement `Atomics`-based claim for contested heap offsets

**Deliverable**: Derive evaluation off main thread. Main thread freed for DOM + GPU submission.

### 15.6 Phase 6: Speculation + α-Adaptation

1. Implement snapshot/rollback for fibers with async inputs
2. Implement α-adaptation based on frame busy factor
3. Wire GPU readback results through speculative fiber path
4. Wire network/WebSocket data through speculative fiber path

**Deliverable**: Latency reduction for async data sources without CPU overload.

---

## 16. Invariants & Edge Cases

### 16.1 Invariants

1. **Hook order stability**: Hooks must be called in the same order on every render. Conditional hooks throw.
2. **Path immutability**: A fiber's path is set at creation and never changes.
3. **Depth monotonicity**: `child.depth === parent.depth + 1` always.
4. **One mount rule**: A fiber has EITHER `mount` (single child) OR `mounts` (keyed children), never both.
5. **Parent-before-child**: The priority queue guarantees parents render before children.
6. **Heap slice exclusivity**: No two live fibers may own overlapping heap slices.
7. **Dirty range monotonicity**: `dirtyMin` only decreases, `dirtyMax` only increases within a frame.
8. **Yeet requires gather**: A fiber that returns `YEET` must have an ancestor that returned `GATHER`. Otherwise, the value has nowhere to go.
9. **State cleanup completeness**: `discardState` must clean up all hooks beyond the pointer (prevent resource leaks).
10. **Settler monotonicity**: Once `fiber.settled = true`, it stays true until the next async input is registered.

### 16.2 Edge Cases

**1. Fiber render returns same result**: If `version === memo`, skip update entirely. Hook state is preserved.

**2. Child appears and disappears in same frame**: The scheduler batches microtask actions. If a setState adds a child, then another setState removes it before flush, the net effect is no change. The queue deduplication prevents double rendering.

**3. Circular context dependencies**: If fiber A provides context X, fiber B reads X and provides Y, fiber A reads Y — this is a cycle. The system does not detect cycles. It renders A (stale Y), then B (fresh X, updates Y), then A again (fresh Y). This converges in 2 passes for static values, but may loop for values that always change. Rex should detect and warn on context cycles.

**4. Yeet value is undefined vs absent**: `undefined` is a valid yeet value. `null` means the fiber has not yeeted. Use `yeeted.value !== undefined` not truthiness.

**5. Gather with zero children**: Returns `[]` (empty array). The `then` callback receives an empty array. This is valid and must not crash.

**6. Hot-reload of fiber function**: If the user edits a Rex file and the compiled function for a node type changes, existing fibers with the old function must be disposed and recreated. The reconciliation detects this via `existing.fn !== call.fn`.

**7. Heap exhaustion**: If `allocHeap` throws, the fiber's `rexUseResource` factory fails. The fiber should catch this and yeet a degraded result (e.g., skip rendering this element). The host should log a warning and consider defragmentation.

**8. Worker crash**: If a derive worker dies (OOM, infinite loop), the `DeriveWorkerPool` should detect the lost `onmessage` callback, reject pending promises, and spawn a replacement worker. Main thread falls back to synchronous evaluation for affected derives.

---

## 17. Performance Model

### 17.1 Costs

| Operation | Cost | When |
|-----------|------|------|
| Fiber creation | ~280 bytes + object header | Node mount |
| Hook push | 1 array write + 1 comparison | Each hook call per render |
| Memo check | Shallow array comparison (n deps) | Each `rexUseMemo` call |
| Queue insert | O(1) amortized (hint locality) | Each dirty fiber |
| Queue pop | O(1) | Each render dispatch |
| Heap alloc | O(n) free list scan | Node mount |
| Heap free | O(n) free list insert + merge | Node unmount |
| Dirty range upload | 1 `writeBuffer` call | Frame end |
| Snapshot | `Uint8Array.set` (n bytes) | Speculative render |
| Rollback | `Uint8Array.set` (n bytes) | Mis-speculation |

### 17.2 Comparison: Full Recompile vs Fiber

For a 1000-node Rex tree where 1 node changes:

| Metric | Full Recompile | Fiber |
|--------|---------------|-------|
| Nodes compiled | 1000 | 1 (+ parent layout) |
| GPU resources recreated | All | 0 |
| Heap layout recomputed | Yes | No |
| Barrier schedule recomputed | Yes | Only if command list changed |
| Optics recomputed | All | 1 entry |
| Time (estimated) | 5-20ms | 0.1-0.5ms |

### 17.3 Memory Overhead

| Component | Per-fiber | 10K fibers |
|-----------|-----------|------------|
| Fiber object | ~300 bytes | 3 MB |
| Hook state (avg 3 hooks) | 9 × 8 bytes = 72 bytes | 720 KB |
| Path array (avg depth 8) | 64 bytes | 640 KB |
| Queue node (when dirty) | 16 bytes | 160 KB |
| **Total** | ~452 bytes | **~4.5 MB** |

This is negligible compared to GPU resources (textures alone are typically 50-500 MB).

### 17.4 Scaling Limits

- **Fiber count**: Tested to 100K fibers in use.gpu without issues. V8 handles millions of small objects.
- **Queue depth**: Worst case (all fibers dirty) is O(n log n) for sorting. With hint-based insertion, typical case is O(n).
- **Worker pool**: `navigator.hardwareConcurrency` workers (typically 4-16). Derive chains beyond worker count serialize.
- **Speculation**: α-adaptation keeps CPU utilization in [0.8, 0.9]. Beyond this, speculation backs off automatically.

---

## Appendix A: use.gpu Reference

All analysis derived from `/Volumes/C/Downloads/Research/use.gpu-master/packages/live/src/`:

| File | Lines | Rex Equivalent |
|------|-------|---------------|
| `fiber.ts` | 1505 | `RexFiber` + reconciliation + yeet/gather |
| `hooks.ts` | 753 | `rexUseState`, `rexUseMemo`, `rexUseResource`, `rexUseContext` |
| `builtin.ts` | 346 | `rexYeet`, `rexGather`, `rexProvide` |
| `types.ts` | 250 | Type definitions → inlined in implementation |
| `tree.ts` | 196 | `RexFiberHost` + render loop |
| `queue.ts` | 162 | `FiberQueue` |
| `util.ts` | 226 | `ActionScheduler`, `StackSlicer`, `DependencyTracker`, `compareFibers` |

## Appendix B: Research Paper Integration

| Paper | Key Concept | Rex Fiber Integration |
|-------|-------------|----------------------|
| Mutschler & Philippsen 2014 | α-controlled speculation, snapshot/replay, TCP-style adaptation | §11: Speculative execution for async inputs (GPU readback, network). α adapts to frame budget. |
| Pedersen & Chalmers 2025 | Claim/queue shared channels, N schedulers ≥ N processes | §13: Channel contention on heap offsets. §12.4: Worker pool sizing. |
| Aaltonen 2025 | Single heap, compiled offsets, stage-mask barriers | §10: Heap ownership preserves Aaltonen's memory model. Fibers don't break the zero-copy heap. |

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **Fiber** | Unit of incremental computation. Wraps function + hook state + children. |
| **Hook** | Lifecycle function called in fixed order during fiber render. Encodes state, memoization, resources, context. |
| **Yeet** | Emit a value upstream to nearest ancestor `gather`. |
| **Gather** | Collect yeeted values from all children into an array. |
| **Provide** | Make a context value available to all descendants. |
| **Reconciliation** | Match old children to new children by key, mounting new and unmounting missing. |
| **Stack Slicing** | Defer deep children to the priority queue instead of rendering inline, preventing stack overflow. |
| **Heap Slice** | Contiguous byte range in the GPU heap owned by a single fiber. |
| **Speculation** | Render a fiber before all inputs are settled, with snapshot for rollback. |
| **α-Adaptation** | TCP-congestion-control-inspired tuning of speculation aggressiveness based on CPU utilization. |
| **Claim/Queue** | Cooperative mutual exclusion for shared heap offsets. Claimer writes; others queue for next frame. |
| **Optic** | Compiled byte offset for zero-cost field access into the GPU heap. |
| **Settled** | A fiber whose all async inputs have arrived. |
| **Busy Factor** | `frameTime / frameBudget` — ratio of actual to target frame time. |

---

*This spec is a living document. Implementation should proceed through the phases in §15, with each phase tested independently before moving to the next.*
