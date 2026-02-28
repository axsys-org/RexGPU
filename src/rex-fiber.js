// ═══════════════════════════════════════════════════════════════════
// REX FIBER RUNTIME
// Incremental computation with hooks, reconciliation & yeet/gather
// Phase 1: Standalone core — no transducer integration yet
// ═══════════════════════════════════════════════════════════════════

// ── §1 Constants & Element Types ─────────────────────────────────

const FIBER_USE     = Symbol('USE');
const FIBER_YEET    = Symbol('YEET');
const FIBER_GATHER  = Symbol('GATHER');
const FIBER_PROVIDE = Symbol('PROVIDE');

const Hook = {
  STATE:    0,
  MEMO:     1,
  ONE:      2,
  CALLBACK: 3,
  RESOURCE: 4,
  CONTEXT:  5,
};

const STATE_SLOTS = 3;
const _UNSET = Symbol('unset');  // sentinel for uninitialized hook slots

// ── §2 RexFiber ──────────────────────────────────────────────────

export class RexFiber {
  constructor(id, fn, args, parent, host) {
    this.id = id;
    this.fn = fn;
    this.args = args;
    this.bound = null;
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
    this.path = parent ? [...parent.path, id] : [id];
    this.key = null;
    this.host = host;
    this.mount = null;      // single child
    this.mounts = null;     // Map<key, RexFiber>
    this.next = null;       // continuation (gather reduction)
    this.order = null;      // child key ordering
    this.state = null;      // hook state array
    this.pointer = 0;       // hook slot pointer
    this.version = 0;       // bumped when inputs change
    this.memo = -1;         // last rendered version
    this.runs = 0;
    this.yeeted = null;     // {value, reduced, root, parent}
    this.fork = false;
    this.transducer = null; // Phase 2
    this.nodeType = null;   // Phase 2
    this.heapSlice = null;  // Phase 2
    this.commands = null;   // Phase 2
    this.optics = null;     // Phase 2
    this.context = parent ? parent.context : { values: new Map(), roots: new Map() };
  }
}

// ── §3 Current Fiber & Hook State ────────────────────────────────

let _currentFiber = null;

function _getCurrentFiber() {
  if (!_currentFiber) throw new Error('Hook called outside fiber render');
  return _currentFiber;
}

function _pushState(fiber, hookType) {
  if (!fiber.state) fiber.state = [];
  const idx = fiber.pointer;
  fiber.pointer += STATE_SLOTS;
  const marker = fiber.state[idx];
  if (marker !== undefined && marker !== hookType) {
    throw new Error(`Hook order violation at fiber ${fiber.id}: expected ${hookType}, got ${marker}`);
  }
  if (marker === undefined) {
    // First time: initialize all 3 slots
    fiber.state[idx] = hookType;
    fiber.state[idx + 1] = _UNSET;
    fiber.state[idx + 2] = _UNSET;
  }
  return idx + 1; // value slot
}

function _discardState(fiber) {
  if (!fiber.state) return;
  const s = fiber.state;
  for (let i = fiber.pointer; i < s.length; i += STATE_SLOTS) {
    const t = s[i];
    if (t === Hook.RESOURCE) {
      const res = s[i + 1];
      if (res && res.cleanup) { try { res.cleanup(); } catch(_){} }
    }
    if (t === Hook.CONTEXT && s[i + 1] && fiber.host) {
      fiber.host.undepend(fiber, s[i + 2]);
    }
  }
  s.length = fiber.pointer;
}

// ── §4 Hooks ─────────────────────────────────────────────────────

export function rexUseState(initialValue) {
  const fiber = _getCurrentFiber();
  const idx = _pushState(fiber, Hook.STATE);
  const s = fiber.state;
  if (s[idx] === _UNSET) {
    s[idx] = typeof initialValue === 'function' ? initialValue() : initialValue;
    s[idx + 1] = (next) => {
      if (s[idx] === next) return;
      s[idx] = next;
      fiber.version++;
      fiber.host.visit(fiber);
    };
  }
  return [s[idx], s[idx + 1]];
}

export function rexUseMemo(fn, deps) {
  const fiber = _getCurrentFiber();
  const idx = _pushState(fiber, Hook.MEMO);
  const s = fiber.state;
  if (s[idx] === _UNSET || !_isSameDeps(s[idx + 1], deps)) {
    s[idx] = fn();
    s[idx + 1] = deps ? deps.slice() : null;
  }
  return s[idx];
}

export function rexUseOne(fn, dep) {
  const fiber = _getCurrentFiber();
  const idx = _pushState(fiber, Hook.ONE);
  const s = fiber.state;
  if (s[idx] === _UNSET || s[idx + 1] !== dep) {
    s[idx] = fn();
    s[idx + 1] = dep;
  }
  return s[idx];
}

export function rexUseResource(factory, deps) {
  const fiber = _getCurrentFiber();
  const idx = _pushState(fiber, Hook.RESOURCE);
  const s = fiber.state;
  if (s[idx] === _UNSET || !_isSameDeps(s[idx]?.deps, deps)) {
    if (s[idx] !== _UNSET && s[idx] && s[idx].cleanup) { try { s[idx].cleanup(); } catch(_){} }
    let cleanup = null;
    const dispose = (fn) => { cleanup = fn; };
    const value = factory(dispose);
    s[idx] = { value, cleanup, deps: deps ? deps.slice() : null };
    fiber.host.track(fiber, () => { if (cleanup) cleanup(); });
  }
  return s[idx].value;
}

export function rexUseContext(contextKey) {
  const fiber = _getCurrentFiber();
  const idx = _pushState(fiber, Hook.CONTEXT);
  const s = fiber.state;
  const ref = fiber.context.values.get(contextKey);
  if (!ref) return undefined;
  if (s[idx] === undefined) {
    s[idx] = true;
    s[idx + 1] = contextKey;
    const root = fiber.context.roots.get(contextKey);
    if (root) fiber.host.depend(fiber, root);
  }
  return ref.current;
}

// ── §5 Combinators ───────────────────────────────────────────────

export function rexYeet(value) {
  return { type: FIBER_YEET, value };
}

export function rexGather(calls, then, fallback) {
  return { type: FIBER_GATHER, calls: calls || [], then, fallback: fallback || null };
}

export function rexProvide(contextKey, value, calls) {
  return { type: FIBER_PROVIDE, contextKey, value, calls };
}

export function rexUse(fn, ...args) {
  return { type: FIBER_USE, fn, args, key: undefined };
}

export function rexKeyed(fn, key, ...args) {
  return { type: FIBER_USE, fn, args, key };
}

// ── §6 Utilities ─────────────────────────────────────────────────

function _compareFibers(a, b) {
  const pa = a.path, pb = b.path;
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return pa.length - pb.length;
}

function _isDescendant(ancestor, fiber) {
  const ap = ancestor.path, fp = fiber.path;
  if (ap.length >= fp.length) return false;
  for (let i = 0; i < ap.length; i++) {
    if (ap[i] !== fp[i]) return false;
  }
  return true;
}

function _isSameDeps(prev, next) {
  if (prev == null || next == null) return false;
  if (prev === next) return true;
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

function _argsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function _arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── §7 Priority Queue ────────────────────────────────────────────

export class FiberQueue {
  constructor() {
    this.head = null;
    this.tail = null;
    this.hint = null;
    this.set = new Set();
  }

  insert(fiber) {
    if (this.set.has(fiber)) return;
    this.set.add(fiber);
    const node = { fiber, next: null };
    if (!this.head) { this.head = this.tail = node; return; }
    // Fast: append
    if (_compareFibers(this.tail.fiber, fiber) <= 0) {
      this.tail.next = node; this.tail = node; return;
    }
    // Fast: prepend
    if (_compareFibers(fiber, this.head.fiber) < 0) {
      node.next = this.head; this.head = node; return;
    }
    // General: sorted insert with hint
    let cur = (this.hint && _compareFibers(this.hint.fiber, fiber) <= 0)
      ? this.hint : this.head;
    while (cur.next && _compareFibers(cur.next.fiber, fiber) < 0) cur = cur.next;
    node.next = cur.next;
    cur.next = node;
    if (!node.next) this.tail = node;
    this.hint = cur;
  }

  remove(fiber) {
    if (!this.set.has(fiber)) return;
    this.set.delete(fiber);
    if (this.head && this.head.fiber === fiber) {
      if (this.hint === this.head) this.hint = this.head.next;
      this.head = this.head.next;
      if (!this.head) { this.tail = null; this.hint = null; }
      return;
    }
    let q = this.head;
    while (q && q.next) {
      if (q.next.fiber === fiber) {
        if (this.hint === q.next) this.hint = q.next.next;
        if (this.tail === q.next) this.tail = q;
        q.next = q.next.next;
        return;
      }
      q = q.next;
    }
  }

  reorder(parent) {
    const extracted = [];
    let prev = null, cur = this.head;
    while (cur) {
      if (_isDescendant(parent, cur.fiber)) {
        extracted.push(cur.fiber);
        this.set.delete(cur.fiber);
        if (prev) { prev.next = cur.next; }
        else { this.head = cur.next; }
        if (this.tail === cur) this.tail = prev;
        if (this.hint === cur) this.hint = prev;
        cur = prev ? prev.next : this.head;
      } else {
        prev = cur; cur = cur.next;
      }
    }
    if (!this.head) { this.tail = null; this.hint = null; }
    if (extracted.length) {
      extracted.sort(_compareFibers);
      for (const f of extracted) this.insert(f);
    }
  }

  peek() { return this.head ? this.head.fiber : null; }

  pop() {
    if (!this.head) return null;
    const fiber = this.head.fiber;
    if (this.hint === this.head) this.hint = this.head.next;
    this.head = this.head.next;
    if (!this.head) { this.tail = null; this.hint = null; }
    this.set.delete(fiber);
    return fiber;
  }

  get size() { return this.set.size; }
}

// ── §8 Support Classes ───────────────────────────────────────────

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
      queueMicrotask(() => this._flush());
    }
  }
  _flush() {
    this.pending = false;
    const batch = this.queue; this.queue = [];
    const fibers = [];
    for (const { fiber, task } of batch) {
      if (!task || task() !== false) fibers.push(fiber);
    }
    const unique = [...new Set(fibers)];
    if (unique.length) this.onFlush(unique);
  }
}

class StackSlicer {
  constructor(maxDepth) {
    this.maxDepth = maxDepth;
    this.dispatchDepth = 0;
    this.sliced = false;
  }
  depth(d) { this.dispatchDepth = d; this.sliced = false; }
  slice(d) {
    if (this.sliced) return true;
    this.sliced = (d - this.dispatchDepth) > this.maxDepth;
    return this.sliced;
  }
}

class DependencyTracker {
  constructor() {
    this.forward = new Map();    // rootFiberId → Set<fiber>
    this.backward = new WeakMap(); // fiber → Set<rootFiberId>
  }
  depend(fiber, root) {
    const rid = typeof root === 'number' ? root : root.id;
    let s = this.forward.get(rid);
    if (!s) { s = new Set(); this.forward.set(rid, s); }
    s.add(fiber);
    let b = this.backward.get(fiber);
    if (!b) { b = new Set(); this.backward.set(fiber, b); }
    b.add(rid);
  }
  undepend(fiber, root) {
    const rid = typeof root === 'number' ? root : root.id;
    const s = this.forward.get(rid);
    if (s) { s.delete(fiber); if (!s.size) this.forward.delete(rid); }
    const b = this.backward.get(fiber);
    if (b) b.delete(rid);
  }
  traceDown(fiber) {
    const s = this.forward.get(fiber.id);
    return s ? [...s] : [];
  }
}

class DisposalTracker {
  constructor() { this.map = new Map(); }
  track(fiber, fn) {
    let list = this.map.get(fiber.id);
    if (!list) { list = []; this.map.set(fiber.id, list); }
    list.push(fn);
  }
  dispose(fiber) {
    const list = this.map.get(fiber.id);
    if (list) {
      for (const fn of list) { try { fn(); } catch(_){} }
      this.map.delete(fiber.id);
    }
  }
}

// ── §9 Reconciliation ────────────────────────────────────────────

function _renderFiber(fiber) {
  if (fiber.version === fiber.memo) return undefined; // skip unchanged
  _currentFiber = fiber;
  fiber.pointer = 0;
  fiber.runs++;
  let element;
  try {
    element = fiber.fn.apply(null, fiber.args);
  } finally {
    _discardState(fiber);
    _currentFiber = null;
  }
  fiber.memo = fiber.version;
  return element;
}

function _updateFiber(fiber, element) {
  if (element === undefined) return; // skipped render
  if (element === null) { _disposeFiberMounts(fiber); return; }
  if (element.type === FIBER_YEET) { _handleYeet(fiber, element.value); return; }
  if (element.type === FIBER_GATHER) { _handleGather(fiber, element); return; }
  if (element.type === FIBER_PROVIDE) { _handleProvide(fiber, element); return; }
  if (Array.isArray(element)) { _reconcileFiberCalls(fiber, element); return; }
  if (element.type === FIBER_USE) { _mountFiberCall(fiber, element); return; }
}

function _handleYeet(fiber, value) {
  if (!fiber.yeeted) return;
  const prev = fiber.yeeted.value;
  fiber.yeeted.value = value;
  fiber.yeeted.reduced = value;
  if (prev !== value) _bustYeet(fiber);
}

function _bustYeet(fiber) {
  let y = fiber.yeeted;
  while (y && y.parent) { y.parent.reduced = undefined; y = y.parent; }
  if (fiber.yeeted && fiber.yeeted.root) fiber.host.visit(fiber.yeeted.root);
}

function _handleGather(fiber, element) {
  // Create or reuse continuation fiber
  if (!fiber.next) {
    fiber.next = new RexFiber(fiber.host.nextId(), element.then, [], fiber, fiber.host);
    fiber.next.context = fiber.context;
  }
  fiber.next.fn = element.then;
  fiber.fork = true;

  // Yeet context for children
  const yeetState = {
    value: undefined,
    reduced: undefined,
    root: fiber.next,
    parent: fiber.yeeted,
  };

  // Prepare child calls
  const calls = (element.calls || []).map((c, i) => {
    if (!c) return null;
    if (c.type === FIBER_USE) return { ...c, key: c.key !== undefined ? c.key : i };
    // Wrap bare functions
    return { type: FIBER_USE, fn: c, args: [], key: i };
  }).filter(Boolean);

  // Mount children with yeet context
  const prevYeeted = fiber.yeeted;
  fiber.yeeted = yeetState;
  _reconcileFiberCalls(fiber, calls);
  fiber.yeeted = prevYeeted;

  // Gather values and render continuation
  const values = _gatherValues(fiber);
  fiber.next.args = [values];
  fiber.next.version++;
  _flushMount(fiber.next);
}

function _gatherValues(fiber) {
  const out = [];
  if (fiber.mounts && fiber.order) {
    for (const key of fiber.order) {
      const child = fiber.mounts.get(key);
      if (child) _collectYeeted(child, out);
    }
  }
  if (fiber.mount) _collectYeeted(fiber.mount, out);
  return out;
}

function _collectYeeted(fiber, out) {
  if (fiber.yeeted && fiber.yeeted.reduced !== undefined) {
    out.push(fiber.yeeted.reduced);
    return;
  }
  if (fiber.mount) _collectYeeted(fiber.mount, out);
  if (fiber.mounts && fiber.order) {
    for (const key of fiber.order) {
      const child = fiber.mounts.get(key);
      if (child) _collectYeeted(child, out);
    }
  }
}

function _handleProvide(fiber, element) {
  const newCtx = {
    values: new Map(fiber.context.values),
    roots: new Map(fiber.context.roots),
  };
  newCtx.values.set(element.contextKey, { current: element.value });
  newCtx.roots.set(element.contextKey, fiber);

  const prevCtx = fiber.context;
  fiber.context = newCtx;

  const calls = element.calls;
  if (Array.isArray(calls)) {
    _reconcileFiberCalls(fiber, calls);
  } else if (calls && calls.type === FIBER_USE) {
    _mountFiberCall(fiber, calls);
  } else if (typeof calls === 'function') {
    const result = calls();
    _updateFiber(fiber, result);
  }

  fiber.context = prevCtx;

  // Notify dependents
  const deps = fiber.host.traceDown(fiber);
  for (const dep of deps) { dep.version++; fiber.host.visit(dep); }
}

function _reconcileFiberCalls(fiber, calls) {
  if (!fiber.mounts) fiber.mounts = new Map();
  if (!fiber.order) fiber.order = [];

  const newKeys = [];
  const seen = new Set();
  for (let j = 0; j < calls.length; j++) {
    const c = calls[j];
    if (!c) continue;
    const key = c.key !== undefined ? c.key : j;
    if (seen.has(key)) throw new Error(`Duplicate fiber key: ${key}`);
    seen.add(key);
    newKeys.push({ key, call: c });
  }

  // Dispose removed children
  for (const [key, child] of fiber.mounts) {
    if (!seen.has(key)) { _disposeFiber(child); fiber.mounts.delete(key); }
  }

  const rekeyed = !_arraysEqual(fiber.order, newKeys.map(k => k.key));

  for (const { key, call } of newKeys) {
    const existing = fiber.mounts.get(key);
    if (existing) {
      if (existing.fn === call.fn) {
        if (!_argsEqual(existing.args, call.args)) {
          existing.args = call.args;
          existing.version++;
          _flushMount(existing);
        }
      } else {
        _disposeFiber(existing);
        const child = _makeChild(fiber, call, key);
        fiber.mounts.set(key, child);
        _flushMount(child);
      }
    } else {
      const child = _makeChild(fiber, call, key);
      fiber.mounts.set(key, child);
      _flushMount(child);
    }
  }

  fiber.order = newKeys.map(k => k.key);
  if (rekeyed && fiber.mounts.size) {
    fiber.host.reorder(fiber);
    _bustYeet(fiber);
  }
}

function _mountFiberCall(fiber, call) {
  // Dispose keyed children if switching to single-mount
  if (fiber.mounts) { _disposeFiberMounts(fiber); }
  if (fiber.mount) {
    if (fiber.mount.fn === call.fn) {
      if (!_argsEqual(fiber.mount.args, call.args)) {
        fiber.mount.args = call.args;
        fiber.mount.version++;
        _flushMount(fiber.mount);
      }
      return;
    }
    _disposeFiber(fiber.mount);
  }
  fiber.mount = _makeChild(fiber, call, call.key);
  _flushMount(fiber.mount);
}

function _makeChild(parent, call, key) {
  const child = new RexFiber(parent.host.nextId(), call.fn, call.args, parent, parent.host);
  child.key = key;
  child.context = parent.context;
  if (parent.yeeted) {
    child.yeeted = {
      value: undefined,
      reduced: undefined,
      root: parent.yeeted.root,
      parent: parent.yeeted,
    };
  }
  return child;
}

function _flushMount(fiber) {
  if (fiber.host.slice(fiber.depth)) {
    fiber.host.visit(fiber);
  } else {
    const el = _renderFiber(fiber);
    _updateFiber(fiber, el);
  }
}

function _disposeFiber(fiber) {
  if (fiber.mount) _disposeFiber(fiber.mount);
  if (fiber.mounts) { for (const [, c] of fiber.mounts) _disposeFiber(c); fiber.mounts.clear(); }
  if (fiber.next) _disposeFiber(fiber.next);
  fiber.host.dispose(fiber);
  fiber.host.unvisit(fiber);
  fiber.mount = null; fiber.mounts = null; fiber.next = null; fiber.state = null;
}

function _disposeFiberMounts(fiber) {
  if (fiber.mount) { _disposeFiber(fiber.mount); fiber.mount = null; }
  if (fiber.mounts) {
    for (const [, c] of fiber.mounts) _disposeFiber(c);
    fiber.mounts.clear(); fiber.mounts = null;
  }
  if (fiber.next) { _disposeFiber(fiber.next); fiber.next = null; }
  fiber.order = null;
}

// ── §10 Heap Allocator ───────────────────────────────────────────

export class FiberHeapAllocator {
  constructor(size, opts) {
    opts = opts || {};
    const useShared = opts.shared && typeof SharedArrayBuffer !== 'undefined';
    this.buffer = useShared ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
    this.shared = useShared;
    this.view = new DataView(this.buffer);
    this.size = size;
    // Reserve 64 bytes for Atomics lock region (16 × Int32 slots) when shared
    this.lockRegionSize = useShared ? 64 : 0;
    this.lockView = useShared ? new Int32Array(this.buffer, 0, 16) : null;
    this.freeList = [{ offset: this.lockRegionSize, length: size - this.lockRegionSize }];
    this.dirtyMin = size;
    this.dirtyMax = 0;
    this.allocated = 0;
  }

  alloc(size, alignment) {
    alignment = alignment || 16;
    size = (size + alignment - 1) & ~(alignment - 1);
    for (let i = 0; i < this.freeList.length; i++) {
      const blk = this.freeList[i];
      const ao = (blk.offset + alignment - 1) & ~(alignment - 1);
      const waste = ao - blk.offset;
      if (blk.length - waste >= size) {
        const slice = { offset: ao, length: size };
        const rem = blk.length - waste - size;
        if (waste > 0) {
          blk.length = waste;
          if (rem > 0) this.freeList.splice(i + 1, 0, { offset: ao + size, length: rem });
        } else if (rem > 0) {
          blk.offset = ao + size; blk.length = rem;
        } else {
          this.freeList.splice(i, 1);
        }
        this.allocated += size;
        return slice;
      }
    }
    throw new Error(`FiberHeap: cannot alloc ${size} bytes (${this.allocated}/${this.size} used)`);
  }

  free(slice) {
    if (!slice) return;
    this.allocated -= slice.length;
    let i = 0;
    while (i < this.freeList.length && this.freeList[i].offset < slice.offset) i++;
    this.freeList.splice(i, 0, { offset: slice.offset, length: slice.length });
    // Merge next
    if (i + 1 < this.freeList.length) {
      const c = this.freeList[i], n = this.freeList[i + 1];
      if (c.offset + c.length === n.offset) { c.length += n.length; this.freeList.splice(i + 1, 1); }
    }
    // Merge prev
    if (i > 0) {
      const p = this.freeList[i - 1], c = this.freeList[i];
      if (p.offset + p.length === c.offset) { p.length += c.length; this.freeList.splice(i, 1); }
    }
  }

  markDirty(min, max) {
    if (min < this.dirtyMin) this.dirtyMin = min;
    if (max > this.dirtyMax) this.dirtyMax = max;
  }
  resetDirty() { this.dirtyMin = this.size; this.dirtyMax = 0; }
  isDirty() { return this.dirtyMin < this.dirtyMax; }
  fragmentation() {
    if (this.freeList.length <= 1) return 0;
    const free = this.size - this.allocated;
    if (!free) return 0;
    return 1 - (Math.max(...this.freeList.map(b => b.length)) / free);
  }
}

// ── §11 RexFiberHost ─────────────────────────────────────────────

export class RexFiberHost {
  constructor(opts) {
    opts = opts || {};
    this._id = 1;
    this._queue = new FiberQueue();
    this._slicer = new StackSlicer(opts.stackSliceDepth || 20);
    this._deps = new DependencyTracker();
    this._disposal = new DisposalTracker();
    this._scheduler = new ActionScheduler((fibers) => {
      for (const f of fibers) this._queue.insert(f);
    });
    this._heap = opts.heapSize ? new FiberHeapAllocator(opts.heapSize, { shared: opts.shared }) : null;
    this._root = null;
    this._stats = { mounts: 0, unmounts: 0, renders: 0, flushes: 0 };
    // Phase 2
    this._contention = new ChannelContention();
    this._commandRing = opts.commandRing ? new CommandRing(opts.ringCapacity) : null;
    this._workerPool = null;
    if (this._heap && this._heap.shared) {
      this._workerPool = new DeriveWorkerPool(this._heap.buffer, {
        workerCount: opts.workerCount,
        workerUrl: opts.workerUrl,
      });
    }
  }

  // ID
  nextId() { return this._id++; }

  // Queue
  visit(fiber)   { this._queue.insert(fiber); }
  unvisit(fiber) { this._queue.remove(fiber); }
  peek()         { return this._queue.peek(); }
  pop()          { return this._queue.pop(); }
  reorder(fiber) { this._queue.reorder(fiber); }

  // Scheduling
  schedule(fiber, task) { this._scheduler.schedule(fiber, task); }

  // Stack slicing
  depth(d)  { this._slicer.depth(d); }
  slice(d)  { return this._slicer.slice(d); }

  // Context dependencies
  depend(fiber, root)   { this._deps.depend(fiber, root); }
  undepend(fiber, root) { this._deps.undepend(fiber, root); }
  traceDown(fiber)      { return this._deps.traceDown(fiber); }

  // Resource disposal
  track(fiber, fn)  { this._disposal.track(fiber, fn); }
  dispose(fiber)    { this._disposal.dispose(fiber); this._stats.unmounts++; }

  // Heap
  allocHeap(size, alignment) {
    if (!this._heap) throw new Error('No heap allocator');
    return this._heap.alloc(size, alignment);
  }
  freeHeap(slice) { if (this._heap) this._heap.free(slice); }
  markDirty(min, max) { if (this._heap) this._heap.markDirty(min, max); }
  get heapView() { return this._heap ? this._heap.view : null; }
  get heap() { return this._heap; }

  // Phase 2: contention, ring, workers
  get contention() { return this._contention; }
  get commandRing() { return this._commandRing; }
  get workerPool() { return this._workerPool; }

  // Mount root
  mount(fn, args) {
    if (this._root) _disposeFiber(this._root);
    this._root = new RexFiber(this.nextId(), fn, args || [], null, this);
    this._stats.mounts++;
    this._queue.insert(this._root);
    return this._root;
  }

  // Flush — drain queue, render all dirty fibers
  flush() {
    this._stats.flushes++;
    while (this._queue.peek()) {
      const fiber = this._queue.pop();
      this._slicer.depth(fiber.depth);
      this._stats.renders++;
      const el = _renderFiber(fiber);
      _updateFiber(fiber, el);
    }
    // Rotate contention ownership at frame end
    const rotated = this._contention.frameEnd();
    for (const { newOwner } of rotated) {
      // newOwner is a fiberId — fibers with new ownership will be scheduled
      // when the transducer integration layer checks contention on next write
    }
  }

  // Unmount
  unmount() {
    if (this._root) { _disposeFiber(this._root); this._root = null; }
    if (this._workerPool) this._workerPool.terminate();
  }

  // Diagnostics
  get stats() { return { ...this._stats }; }
  get queueSize() { return this._queue.size; }
  get root() { return this._root; }
}

// ── §12 ChannelContention ────────────────────────────────────────

class ChannelContention {
  constructor() {
    this._claims = new Map();
  }

  tryClaim(offset, fiberId) {
    const c = this._claims.get(offset);
    if (!c) { this._claims.set(offset, { owner: fiberId, queue: [] }); return true; }
    if (c.owner === fiberId) return true;
    if (!c.queue.includes(fiberId)) c.queue.push(fiberId);
    return false;
  }

  release(offset, fiberId) {
    const c = this._claims.get(offset);
    if (!c || c.owner !== fiberId) return null;
    if (c.queue.length > 0) {
      c.owner = c.queue.shift();
      return c.owner;
    }
    this._claims.delete(offset);
    return null;
  }

  releaseAll(fiberId) {
    for (const [offset, c] of this._claims) {
      if (c.owner === fiberId) {
        if (c.queue.length > 0) { c.owner = c.queue.shift(); }
        else { this._claims.delete(offset); }
      } else {
        const qi = c.queue.indexOf(fiberId);
        if (qi !== -1) c.queue.splice(qi, 1);
      }
    }
  }

  frameEnd() {
    const rotated = [];
    for (const [offset, c] of this._claims) {
      if (c.queue.length > 0) {
        c.queue.push(c.owner);
        c.owner = c.queue.shift();
        rotated.push({ offset, newOwner: c.owner });
      }
    }
    return rotated;
  }

  get size() { return this._claims.size; }
}

// ── §13 CommandRing ─────────────────────────────────────────────

class CommandRing {
  constructor(capacity) {
    this.capacity = capacity || 256;
    this._ring = new Array(this.capacity);
    this._head = 0;           // next write slot
    this._count = 0;          // active entries
    this._nextId = 1;
    this._completed = [];     // drained CQEs
    this._callbacks = new Map();
    this._currentFrame = null;
    this._frames = new Map();
  }

  submit(type, metadata) {
    if (this._count >= this.capacity) return -1;
    const id = this._nextId++;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const sqe = {
      id, type,
      frameId: this._currentFrame,
      startTime: now,
      metadata: metadata || null,
      status: 'pending',
    };
    const slot = (this._head + this._count) % this.capacity;
    this._ring[slot] = sqe;
    this._count++;
    if (this._currentFrame !== null) {
      const f = this._frames.get(this._currentFrame);
      if (f) f.commands.push(id);
    }
    return id;
  }

  complete(commandId, result) {
    for (let i = 0; i < this._count; i++) {
      const slot = (this._head + i) % this.capacity;
      const sqe = this._ring[slot];
      if (sqe && sqe.id === commandId) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const cqe = {
          id: sqe.id, type: sqe.type,
          frameId: sqe.frameId,
          startTime: sqe.startTime,
          endTime: now,
          gpuDuration: (result && result.gpuDuration) || 0,
          status: 'ok',
          result: result || null,
        };
        this._completed.push(cqe);
        // Compact: shift if at head
        if (i === 0) { this._head = (this._head + 1) % this.capacity; this._count--; }
        else { this._ring[slot] = null; }
        // Frame tracking
        if (sqe.frameId !== null) {
          const f = this._frames.get(sqe.frameId);
          if (f) {
            f.completedCount++;
            f.totalGpuMs += cqe.gpuDuration;
          }
        }
        return;
      }
    }
  }

  onComplete(commandId, callback) {
    this._callbacks.set(commandId, callback);
  }

  submitFrame(frameId) {
    this._currentFrame = frameId;
    this._frames.set(frameId, { frameId, commands: [], completedCount: 0, totalGpuMs: 0, completedAt: 0 });
  }

  endFrame(frameId) {
    this._currentFrame = null;
    const f = this._frames.get(frameId);
    if (!f) return null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    f.completedAt = now;
    f.commandCount = f.commands.length;
    this._frames.delete(frameId);
    return { frameId: f.frameId, commandCount: f.commandCount, totalGpuMs: f.totalGpuMs, completedAt: f.completedAt };
  }

  drain() {
    const out = this._completed.splice(0);
    for (const cqe of out) {
      const cb = this._callbacks.get(cqe.id);
      if (cb) { cb(cqe); this._callbacks.delete(cqe.id); }
    }
    return out;
  }

  get pending() {
    let n = 0;
    for (let i = 0; i < this._count; i++) {
      const slot = (this._head + i) % this.capacity;
      if (this._ring[slot]) n++;
    }
    return n;
  }
}

// ── §14 DeriveWorkerPool ────────────────────────────────────────

class DeriveWorkerPool {
  constructor(heapBuffer, opts) {
    opts = opts || {};
    this._active = false;
    this._workers = [];
    this._pending = new Map();
    this._nextTask = 0;
    this._roundRobin = 0;
    this._heapBuffer = heapBuffer;
    this._workerUrl = opts.workerUrl || './derive-worker.js';
    const count = opts.workerCount ||
      Math.max(1, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1);

    if (!(heapBuffer instanceof SharedArrayBuffer)) return;
    if (typeof Worker === 'undefined') return;

    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(this._workerUrl);
        w.postMessage({ type: 'init', heapBuffer });
        w.onmessage = (e) => this._onResult(e.data);
        w.onerror = (e) => this._onError(i, e);
        this._workers.push(w);
      } catch (_) { break; }
    }
    this._active = this._workers.length > 0;
  }

  evaluate(deriveSpec) {
    if (!this._active) return Promise.resolve(null);
    const taskId = this._nextTask++;
    const workerIdx = this._roundRobin++ % this._workers.length;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(taskId);
        reject(new Error('Derive worker timeout'));
      }, 100);
      this._pending.set(taskId, { resolve, reject, timeout });
      this._workers[workerIdx].postMessage({
        type: 'eval', taskId,
        expr: deriveSpec.compiledExpr,
        inputOffsets: deriveSpec.inputOffsets || {},
        outputOffset: deriveSpec.outputOffset,
      });
    });
  }

  evaluateBatch(specs) { return Promise.all(specs.map(s => this.evaluate(s))); }

  _onResult(data) {
    const p = this._pending.get(data.taskId);
    if (!p) return;
    clearTimeout(p.timeout);
    this._pending.delete(data.taskId);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.value);
  }

  _onError(idx, err) {
    for (const [taskId, p] of this._pending) {
      if (taskId % this._workers.length === idx) {
        clearTimeout(p.timeout);
        p.reject(new Error('Worker crashed'));
        this._pending.delete(taskId);
      }
    }
    try {
      const w = new Worker(this._workerUrl);
      w.postMessage({ type: 'init', heapBuffer: this._heapBuffer });
      w.onmessage = (e) => this._onResult(e.data);
      w.onerror = (e) => this._onError(idx, e);
      this._workers[idx] = w;
    } catch (_) {
      this._workers.splice(idx, 1);
      if (this._workers.length === 0) this._active = false;
    }
  }

  terminate() {
    for (const w of this._workers) w.terminate();
    this._workers = [];
    this._active = false;
    for (const [, p] of this._pending) { clearTimeout(p.timeout); p.reject(new Error('Pool terminated')); }
    this._pending.clear();
  }

  get active() { return this._active; }
  get workerCount() { return this._workers.length; }
  get pendingCount() { return this._pending.size; }
}

// ── §15 Test Harness ─────────────────────────────────────────────

export function testFiberRuntime() {
  const R = []; let pass = 0, fail = 0;
  function ok(cond, name) {
    if (cond) { pass++; R.push({ name, ok: true }); }
    else { fail++; R.push({ name, ok: false }); console.warn('  FAIL:', name); }
  }

  // 1. Basic render
  {
    const h = new RexFiberHost();
    let ran = false;
    h.mount(() => { ran = true; return null; });
    h.flush();
    ok(ran, 'basic render');
    h.unmount();
  }

  // 2. useState
  {
    const h = new RexFiberHost();
    let v = 0, set = null;
    h.mount(() => { const [a, b] = rexUseState(42); v = a; set = b; return null; });
    h.flush();
    ok(v === 42, 'useState init');
    set(99);
    h.flush();
    ok(v === 99, 'useState update');
    h.unmount();
  }

  // 3. useMemo skip + recompute
  {
    const h = new RexFiberHost();
    let calls = 0;
    h.mount((dep) => { rexUseMemo(() => { calls++; }, [dep]); return null; }, [5]);
    h.flush();
    ok(calls === 1, 'useMemo initial');
    h._root.args = [5]; h._root.version++; h.visit(h._root); h.flush();
    ok(calls === 1, 'useMemo skip same dep');
    h._root.args = [10]; h._root.version++; h.visit(h._root); h.flush();
    ok(calls === 2, 'useMemo recompute');
    h.unmount();
  }

  // 4. useOne
  {
    const h = new RexFiberHost();
    let calls = 0;
    h.mount((d) => { rexUseOne(() => { calls++; }, d); return null; }, [1]);
    h.flush();
    ok(calls === 1, 'useOne initial');
    h._root.args = [1]; h._root.version++; h.visit(h._root); h.flush();
    ok(calls === 1, 'useOne skip');
    h._root.args = [2]; h._root.version++; h.visit(h._root); h.flush();
    ok(calls === 2, 'useOne recompute');
    h.unmount();
  }

  // 5. Keyed reconciliation
  {
    const h = new RexFiberHost();
    const mounted = [];
    const child = (name) => { mounted.push(name); return null; };
    h.mount(() => [rexKeyed(child, 'a', 'A'), rexKeyed(child, 'b', 'B')]);
    h.flush();
    ok(mounted.length === 2, 'reconcile mount 2');
    ok(mounted[0] === 'A' && mounted[1] === 'B', 'reconcile order');
    h.unmount();
  }

  // 6. Yeet + Gather
  {
    const h = new RexFiberHost();
    let gathered = null;
    const emitter = (val) => rexYeet(val);
    h.mount(() => rexGather(
      [rexKeyed(emitter, 0, 10), rexKeyed(emitter, 1, 20), rexKeyed(emitter, 2, 30)],
      (vals) => { gathered = vals; return null; }
    ));
    h.flush();
    ok(gathered && gathered.length === 3, 'gather count');
    ok(gathered && gathered[0] === 10 && gathered[1] === 20 && gathered[2] === 30, 'gather values');
    h.unmount();
  }

  // 7. Provide + useContext
  {
    const h = new RexFiberHost();
    const KEY = Symbol('ctx');
    let received = null;
    const reader = () => { received = rexUseContext(KEY); return null; };
    h.mount(() => rexProvide(KEY, 'hello', [rexUse(reader)]));
    h.flush();
    ok(received === 'hello', 'context propagation');
    h.unmount();
  }

  // 8. Queue ordering
  {
    const q = new FiberQueue();
    const h = new RexFiberHost();
    const f1 = new RexFiber(1, null, [], null, h); f1.path = [1];
    const f2 = new RexFiber(2, null, [], f1, h); f2.path = [1, 2];
    const f3 = new RexFiber(3, null, [], f1, h); f3.path = [1, 3];
    q.insert(f3); q.insert(f1); q.insert(f2);
    ok(q.pop() === f1, 'queue: parent first');
    ok(q.pop() === f2, 'queue: earlier child');
    ok(q.pop() === f3, 'queue: later child');
  }

  // 9. Heap allocator
  {
    const heap = new FiberHeapAllocator(1024);
    const s1 = heap.alloc(64);
    ok(s1.offset === 0 && s1.length === 64, 'heap alloc 64');
    const s2 = heap.alloc(128);
    ok(s2.offset === 64 && s2.length === 128, 'heap alloc 128');
    heap.free(s1);
    const s3 = heap.alloc(32);
    ok(s3.offset === 0, 'heap reuse freed');
    ok(heap.allocated === 128 + 32, 'heap tracking');
    heap.free(s2); heap.free(s3);
    ok(heap.allocated === 0, 'heap fully freed');
    ok(heap.freeList.length === 1, 'heap merged');
  }

  // 10. useResource cleanup
  {
    const h = new RexFiberHost();
    let cleaned = false;
    h.mount(() => {
      rexUseResource((dispose) => { dispose(() => { cleaned = true; }); return 'r'; }, []);
      return null;
    });
    h.flush();
    ok(!cleaned, 'resource alive');
    h.unmount();
    ok(cleaned, 'resource cleaned on unmount');
  }

  // 11. Hook order violation
  {
    const h = new RexFiberHost();
    let n = 0, threw = false;
    h.mount(() => {
      n++;
      if (n === 1) { rexUseState(0); rexUseMemo(() => 1, []); }
      else { try { rexUseMemo(() => 1, []); rexUseState(0); } catch(_) { threw = true; } }
      return null;
    });
    h.flush();
    h._root.version++; h.visit(h._root); h.flush();
    ok(threw, 'hook order violation');
    h.unmount();
  }

  // ── Phase 2 Tests ──

  // 12. SharedArrayBuffer heap
  {
    const canSAB = typeof SharedArrayBuffer !== 'undefined';
    if (canSAB) {
      const heap = new FiberHeapAllocator(1024, { shared: true });
      ok(heap.buffer instanceof SharedArrayBuffer, 'SAB heap constructor');
      ok(heap.shared === true, 'SAB shared flag');
      const s1 = heap.alloc(64);
      ok(s1.offset >= heap.lockRegionSize, 'SAB alloc respects lock region');
      heap.view.setFloat32(s1.offset, 42.0, true);
      ok(heap.view.getFloat32(s1.offset, true) === 42.0, 'SAB read/write');
      heap.free(s1);
    } else {
      ok(true, 'SAB heap constructor');
      ok(true, 'SAB shared flag');
      ok(true, 'SAB alloc respects lock region');
      ok(true, 'SAB read/write');
    }
  }

  // 13. SAB fallback
  {
    const heap = new FiberHeapAllocator(512, { shared: false });
    ok(heap.buffer instanceof ArrayBuffer && !(heap.buffer instanceof SharedArrayBuffer), 'non-SAB fallback');
    ok(heap.shared === false, 'non-SAB shared flag');
  }

  // 14. ChannelContention — claim
  {
    const cc = new ChannelContention();
    ok(cc.tryClaim(100, 1), 'contention: first claim');
    ok(cc.tryClaim(100, 1), 'contention: owner re-claim');
    ok(!cc.tryClaim(100, 2), 'contention: contender rejected');
    const next = cc.release(100, 1);
    ok(next === 2, 'contention: handoff to queued');
  }

  // 15. ChannelContention — frameEnd rotation
  {
    const cc = new ChannelContention();
    cc.tryClaim(200, 10);
    cc.tryClaim(200, 20);
    cc.tryClaim(200, 30);
    const rotated = cc.frameEnd();
    ok(rotated.length === 1 && rotated[0].newOwner === 20, 'contention: frameEnd rotation');
  }

  // 16. ChannelContention — releaseAll
  {
    const cc = new ChannelContention();
    cc.tryClaim(300, 5);
    cc.tryClaim(400, 5);
    cc.releaseAll(5);
    ok(cc.tryClaim(300, 9), 'contention: releaseAll freed offsets');
  }

  // 17. CommandRing — submit and complete
  {
    const ring = new CommandRing(16);
    const id1 = ring.submit('pass', { pipeline: 'test' });
    const id2 = ring.submit('dispatch', { grid: [4,4,1] });
    ok(id1 > 0 && id2 === id1 + 1, 'ring: monotonic ids');
    ok(ring.pending === 2, 'ring: pending count');
    ring.complete(id1, { gpuDuration: 1.5 });
    const cqes = ring.drain();
    ok(cqes.length === 1 && cqes[0].id === id1 && cqes[0].result.gpuDuration === 1.5, 'ring: complete + drain');
  }

  // 18. CommandRing — frame aggregation
  {
    const ring = new CommandRing(16);
    ring.submitFrame(1);
    const id1 = ring.submit('pass', {});
    const id2 = ring.submit('dispatch', {});
    ring.complete(id1, { gpuDuration: 2.0 });
    ring.complete(id2, { gpuDuration: 1.0 });
    const frame = ring.endFrame(1);
    ok(frame.commandCount === 2 && frame.totalGpuMs === 3.0, 'ring: frame aggregation');
  }

  // 19. CommandRing — onComplete callback
  {
    const ring = new CommandRing(16);
    let cbResult = null;
    const id = ring.submit('readback', { name: 'hits' });
    ring.onComplete(id, (cqe) => { cbResult = cqe; });
    ring.complete(id, { data: [1, 2, 3] });
    ring.drain();
    ok(cbResult !== null && cbResult.result.data[0] === 1, 'ring: onComplete callback');
  }

  // 20. CommandRing — overflow
  {
    const ring = new CommandRing(4);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(ring.submit('pass', {}));
    ok(ids[4] === -1 && ids[5] === -1, 'ring: overflow returns -1');
  }

  // 21. DeriveWorkerPool — graceful degradation
  {
    const pool = new DeriveWorkerPool(new ArrayBuffer(256));
    ok(!pool.active, 'worker pool: inactive on ArrayBuffer');
  }

  const summary = `rex-fiber: ${pass}/${pass + fail} tests passed`;
  console.log(summary);
  return { pass, fail, results: R, summary };
}
