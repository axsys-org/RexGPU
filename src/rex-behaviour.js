// ═══════════════════════════════════════════════════════════════════
// BEHAVIOUR TRANSDUCER
// Reactive state, derived values, mutations, and actions for Shrubs
// ═══════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';

export class RexBehaviour {
  constructor(log) {
    this.log = log || (() => {});
    this._shrubs = new Map();    // name → {schema, slots, kids, deps}
    this._defs = new Map();      // name → {args, body}
    this._derives = [];          // [{shrub, slot, expr}] in dependency order
    this._talks = new Map();     // "shrub/name" → {inputs, guard, mutations}
    this._depReactions = new Map(); // "shrub/label" → {dead, mutations}
    this._depTriggers = new Map();  // "sourceShrub/slot" → [{shrub, label}] (transitive closure)
    this._channels = [];         // [{from:{shrub,slot}, to:{buffer,field}, mode, lastValue}]
    this._compiled = false;

    // ── Per-derive dirty tracking ──
    this._derivedSlots = null;     // Map<"shrub/slot", deriveIndex> — persisted from _orderDerives
    this._deriveRevDeps = null;    // Array<Array<number>> — reverse adjacency
    this._deriveDirty = null;      // Uint8Array(N) — 1=dirty 0=clean
    this._deriveFormDeps = null;   // Map<formFieldName, Set<deriveIndex>>
    this.onSlotChange = null;    // callback(shrubName, slotName, value)
    this.onChannelPush = null;   // callback(buffer, field, value) → GPU heap write
    this.onTalkFired = null;     // callback(record) — rich causal record per talk invocation
    this.onSurpriseSignal = null;// callback(shrub, slot, value, schemaRange) — out-of-range derives
    this.formState = null;       // external form state for expression resolution
    this.getShrubLM = null;      // callback(shrubName) → ShrubLM|null — set by main.js for model-free path
    this.getGoalState = null;    // callback(shrub, slot, target, slots) → {talk, expectedDelta}|null

    // ── Self-healing state ──
    this._recoveryState = new Map();  // shrubName → {attempts, cooldownUntil}

    // ── Tween system ──
    this._tweens = [];            // compiled tween definitions [{shrub, slot, duration, easing, delay, loop, yoyo}]
    this._activeTweens = [];      // running tweens [{tween, startTime, from, to, done}]
    this._tweenDirty = false;     // true when any tween is actively interpolating

    // ── Extension hooks ──
    this._schemaHandlers = new Map();
    this._mutationHandlers = new Map();
    this._mutTypeCache = null;
    this._warnedTypes = new Set();
  }

  registerSchemaType(typeName, handler) {
    this._schemaHandlers.set(typeName, handler);
    this._mutTypeCache = null; // invalidate
  }

  registerMutationType(typeName, handler) {
    this._mutationHandlers.set(typeName, handler);
    this._mutTypeCache = null; // invalidate
  }

  // Call a @def function by name with args — usable by other transducers
  callDef(name, args) {
    const def = this._defs.get(name);
    if (!def) return undefined;
    const ctx = { shrub: null, defArgs: {} };
    for (let i = 0; i < def.args.length; i++) ctx.defArgs[def.args[i]] = args[i];
    if (def.compiled) return Rex.evalExpr(def.compiled, this._makeBehaviourContext(ctx));
    return this._evalExpr(def.body, ctx);
  }

  // Check if a @def exists
  hasDef(name) { return this._defs.has(name); }

  // Get GPU-eligible derives (compiled WGSL expressions) — consumed by GPU transducer
  getGpuDerives() { return this._gpuDerives || []; }

  // Fire a @talk action externally (e.g. from surface click) — delegates to invoke
  fireTalk(shrubName, actionName, params) {
    this.invoke(shrubName, actionName, params || {});
  }

  transduce(tree, structureChanged) {
    if (structureChanged || !this._compiled) {
      this._compile(tree);
      this._markAllDerivesDirty();
    }
    this._flushDerives();
  }

  // Push a form field value into the behaviour system and mark affected derives dirty
  pushFormValue(name, val) {
    if (!this._compiled) return;
    if (this._deriveFormDeps) {
      const deps = this._deriveFormDeps.get(name);
      if (deps) {
        for (const idx of deps) this._markDeriveDirtyByIndex(idx);
      }
    } else {
      this._markAllDerivesDirty();
    }
    this._flushDerives();
  }

  // ════════════════════════════════════════════════════════════════
  // COMPILE PHASE
  // ════════════════════════════════════════════════════════════════

  _compile(tree) {
    this._shrubs.clear();
    this._defs.clear();
    this._derives = [];
    this._talks.clear();
    this._depReactions.clear();
    this._depTriggers.clear();
    this._channels = [];
    this._warnedTypes.clear();

    // 1. Compile @shrub schemas
    for (const s of Rex.findAll(tree, 'shrub')) {
      this._compileShrub(s);
    }

    // 2. Compile @def pure functions
    for (const d of Rex.findAll(tree, 'def')) {
      this._compileDef(d);
    }

    // 3. Compile @derive blocks
    for (const d of Rex.findAll(tree, 'derive')) {
      this._compileDerive(d);
    }

    // 4. Compile @talk blocks
    for (const t of Rex.findAll(tree, 'talk')) {
      this._compileTalk(t);
    }

    // 5. Compile @dep reaction blocks (behavioural, not schema-level)
    for (const d of Rex.findAll(tree, 'dep')) {
      // Schema-level deps are inside @shrub (already handled)
      // Behavioural deps have :shrub and :name attrs
      if (d.attrs.shrub && d.attrs.name) {
        this._compileDepReaction(d);
      }
    }

    // 6. Compile @tween definitions
    this._tweens = [];
    for (const t of Rex.findAll(tree, 'tween')) {
      this._compileTween(t);
    }

    // 7. Compile @channel bridges (behaviour → GPU heap)
    this._compileChannels(tree);

    // 7. Order derives by dependency
    this._orderDerives();

    // 8. Classify derives: GPU-eligible vs CPU-only
    this._classifyDerives();

    // 9. Build transitive dep closure (promonad composition)
    this._buildDepClosure();

    this._compiled = true;
    this.log(`behaviour: ${this._shrubs.size} shrubs, ${this._defs.size} defs, ${this._derives.length} derives, ${this._talks.size} talks, ${this._channels.length} channels, ${this._depTriggers.size} dep triggers`, 'ok');
  }

  _compileShrub(node) {
    const name = node.name;
    if (!name) return;

    const schema = { slots: new Map(), kids: new Map(), deps: new Map() };
    const slots = new Map();  // runtime slot values

    for (const child of node.children) {
      switch (child.type) {
        case 'slot': {
          const slotName = child.name;
          const type = child.attrs.type || 'string';
          const def = child.attrs.default;
          const min = child.attrs.min !== undefined ? +child.attrs.min : undefined;
          const max = child.attrs.max !== undefined ? +child.attrs.max : undefined;
          schema.slots.set(slotName, { type, default: def, min, max });
          if (def !== undefined) slots.set(slotName, this._coerce(def, type));
          break;
        }
        case 'kids': {
          const path = child.name;
          const kidSlots = new Map();
          for (const s of child.children.filter(c => c.type === 'slot')) {
            kidSlots.set(s.name, { type: s.attrs.type || 'string' });
          }
          schema.kids.set(path, { slots: kidSlots });
          break;
        }
        case 'dep': {
          // Schema-level dep declaration
          schema.deps.set(child.name, { path: child.attrs.path });
          break;
        }
        default: {
          const h = this._schemaHandlers.get(child.type);
          if (h) h(child, schema, slots, this);
          break;
        }
      }
    }

    this._shrubs.set(name, {
      schema,
      slots,
      kids: new Map(),     // path → Map<key, Map<slotName, value>>
      nextAutoKey: new Map(), // path → next auto-increment key
    });
  }

  _compileDef(node) {
    const name = node.name;
    const args = node.attrs.args || [];
    const body = this._extractExpr(node);
    const compiled = Rex.compileExpr(body);
    this._defs.set(name, { args: Array.isArray(args) ? args : [args], body, compiled });
  }

  _compileDerive(node) {
    const shrubName = node.attrs.shrub;
    const slotName = node.attrs.slot;
    if (!shrubName || !slotName) return;
    const expr = this._extractExpr(node);
    const compiled = Rex.compileExpr(expr);
    this._derives.push({ shrub: shrubName, slot: slotName, expr, compiled });
  }

  _compileTalk(node) {
    const shrubName = node.attrs.shrub;
    const actionName = node.attrs.name || node.name;
    if (!shrubName || !actionName) return;

    const inputs = [];
    let guard = null;
    const mutations = [];

    for (const child of node.children) {
      switch (child.type) {
        case 'input':
          // @input field :type type
          for (const [key, val] of Object.entries(child.attrs)) {
            if (key !== 'type') inputs.push({ name: child.name || key, type: val });
          }
          if (child.name && !inputs.find(i => i.name === child.name)) {
            inputs.push({ name: child.name, type: child.attrs.type || 'string' });
          }
          break;
        case 'guard':
          guard = this._extractExpr(child);
          break;
        default:
          mutations.push(child);
      }
    }

    this._talks.set(`${shrubName}/${actionName}`, { shrub: shrubName, inputs, guard, mutations });
  }

  _compileTween(node) {
    const shrubName = node.attrs.shrub;
    const slotName = node.attrs.slot || node.name;
    if (!shrubName || !slotName) return;
    const duration = +(node.attrs.duration || node.attrs.dur || 300); // ms
    const delay = +(node.attrs.delay || 0);
    const easingName = node.attrs.easing || node.attrs.ease || 'ease-out';
    const loop = node.attrs.loop === 'true' || node.attrs.loop === true;
    const yoyo = node.attrs.yoyo === 'true' || node.attrs.yoyo === true;
    const to = node.attrs.to !== undefined ? +node.attrs.to : undefined;
    this._tweens.push({ shrub: shrubName, slot: slotName, duration, delay, easing: easingName, loop, yoyo, to });
  }

  // ── Easing functions ──
  static _easings = {
    'linear':      t => t,
    'ease-in':     t => t * t,
    'ease-out':    t => t * (2 - t),
    'ease-in-out': t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    'ease-in-cubic':  t => t * t * t,
    'ease-out-cubic': t => 1 - Math.pow(1 - t, 3),
    'ease-in-out-cubic': t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    'ease-in-quart':  t => t * t * t * t,
    'ease-out-quart': t => 1 - Math.pow(1 - t, 4),
    'ease-in-out-quart': t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
    'ease-in-expo':   t => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
    'ease-out-expo':  t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    'ease-in-back':   t => 2.70158 * t * t * t - 1.70158 * t * t,
    'ease-out-back':  t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    'ease-out-bounce': t => {
      if (t < 1 / 2.75) return 7.5625 * t * t;
      if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
      if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
      return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
    },
    'ease-out-elastic': t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
    'spring': t => 1 - Math.cos(t * Math.PI * 4.5) * Math.exp(-t * 6),
  };

  // Start a tween programmatically: tween(shrub, slot, to, opts)
  tween(shrubName, slotName, toValue, opts = {}) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;
    const fromValue = +(shrub.slots.get(slotName) || 0);
    const duration = opts.duration || 300;
    const delay = opts.delay || 0;
    const easing = opts.easing || 'ease-out';
    const loop = opts.loop || false;
    const yoyo = opts.yoyo || false;
    // Remove any existing tween on the same slot
    this._activeTweens = this._activeTweens.filter(a => !(a.shrub === shrubName && a.slot === slotName));
    this._activeTweens.push({
      shrub: shrubName, slot: slotName, from: fromValue, to: toValue,
      duration, delay, easing, loop, yoyo,
      startTime: performance.now(), direction: 1, done: false,
    });
    this._tweenDirty = true;
  }

  // Tick all active tweens — call from render loop with current time
  tickTweens(now) {
    if (this._activeTweens.length === 0) return false;
    let anyActive = false;
    for (const tw of this._activeTweens) {
      if (tw.done) continue;
      const elapsed = now - tw.startTime - tw.delay;
      if (elapsed < 0) { anyActive = true; continue; } // still in delay
      let t = Math.min(1, elapsed / tw.duration);
      // Yoyo: reverse direction on each loop
      if (tw.yoyo && tw.direction === -1) t = 1 - t;
      // Apply easing
      const easeFn = RexBehaviour._easings[tw.easing] || RexBehaviour._easings['ease-out'];
      const eased = easeFn(t);
      // Interpolate
      const value = tw.from + (tw.to - tw.from) * eased;
      // Write to slot
      const shrub = this._shrubs.get(tw.shrub);
      if (shrub) {
        shrub.slots.set(tw.slot, value);
        this._markDeriveDirty(tw.shrub, tw.slot);
        if (this.onSlotChange) this.onSlotChange(tw.shrub, tw.slot, value);
      }
      if (t >= 1) {
        if (tw.loop) {
          tw.startTime = now;
          if (tw.yoyo) tw.direction *= -1;
          anyActive = true;
        } else {
          tw.done = true;
        }
      } else {
        anyActive = true;
      }
    }
    // Clean up done tweens
    this._activeTweens = this._activeTweens.filter(a => !a.done);
    if (anyActive) {
      this._flushDerives();
      this._tweenDirty = true;
    } else {
      this._tweenDirty = false;
    }
    return anyActive;
  }

  // Start all compiled @tween definitions (called after slot changes via talk)
  startTweens(shrubName, slotName, toValue) {
    for (const tw of this._tweens) {
      if (tw.shrub === shrubName && tw.slot === slotName) {
        this.tween(shrubName, slotName, toValue !== undefined ? toValue : (tw.to !== undefined ? tw.to : 0), tw);
      }
    }
  }

  // Check if any tweens are running
  hasTweens() { return this._activeTweens.length > 0; }

  _compileDepReaction(node) {
    const shrubName = node.attrs.shrub;
    const label = node.attrs.name;
    if (!shrubName || !label) return;

    let dead = null;
    const mutations = [];

    for (const child of node.children) {
      if (child.type === 'dead') {
        dead = child.children;
      } else {
        mutations.push(child);
      }
    }

    this._depReactions.set(`${shrubName}/${label}`, { shrub: shrubName, dead, mutations });
  }

  // ── Transitive dep closure (promonad composition) ──
  // Builds _depTriggers: "sourceShrub/slot" → [{shrub, label}]
  // Direct edges come from schema-level @dep declarations on each shrub.
  // Transitive edges: if A watches B via label L, and a dep reaction on A mutates
  // slot S, any shrub C watching A/S also gets added — computed via BFS.
  _buildDepClosure() {
    // Step 1: build direct trigger map from schema @dep declarations
    // A schema dep says: shrubName has label L pointing to sourcePath /other/slot
    // → when other/slot changes, fire reaction shrubName/L
    const direct = new Map(); // "sourceShrub/slot" → [{shrub, label}]
    for (const [shrubName, shrub] of this._shrubs) {
      for (const [label, depDef] of shrub.schema.deps) {
        // Only care if there's a compiled reaction for this dep
        if (!this._depReactions.has(`${shrubName}/${label}`)) continue;
        const parts = depDef.path.split('/').filter(Boolean);
        if (parts.length < 2) continue;
        const sourceKey = `${parts[0]}/${parts.slice(1).join('/')}`;
        if (!direct.has(sourceKey)) direct.set(sourceKey, []);
        direct.get(sourceKey).push({ shrub: shrubName, label });
      }
    }

    // Step 2: BFS transitive closure
    // For each dep reaction, figure out which slots it can mutate, then
    // propagate those slots into the trigger map.
    // We do a fixed-point iteration: new triggers → new mutation slots → new triggers.
    const closure = new Map(direct); // start from direct edges

    // Helper: get all slot paths a reaction's mutations write to
    const mutationSlots = (reactionKey) => {
      const reaction = this._depReactions.get(reactionKey);
      if (!reaction) return [];
      const slots = [];
      for (const mut of reaction.mutations) {
        if ((mut.type === 'set') && mut.name) {
          const slotName = mut.name.startsWith('/') ? mut.name.slice(1) : mut.name;
          slots.push(`${reaction.shrub}/${slotName}`);
        }
      }
      return slots;
    };

    // BFS: process queue of newly-discovered trigger edges
    const queue = [...closure.values()].flat();
    const visited = new Set();
    while (queue.length > 0) {
      const { shrub, label } = queue.shift();
      const reactionKey = `${shrub}/${label}`;
      if (visited.has(reactionKey)) continue;
      visited.add(reactionKey);

      // For each slot this reaction writes, add transitive watchers
      for (const writtenSlot of mutationSlots(reactionKey)) {
        const downstream = direct.get(writtenSlot) || [];
        for (const edge of downstream) {
          const edgeKey = `${writtenSlot}→${edge.shrub}/${edge.label}`;
          if (visited.has(edgeKey)) continue;
          visited.add(edgeKey);
          if (!closure.has(writtenSlot)) closure.set(writtenSlot, []);
          // Only add if not already present
          const existing = closure.get(writtenSlot);
          if (!existing.some(e => e.shrub === edge.shrub && e.label === edge.label)) {
            existing.push(edge);
            queue.push(edge);
          }
        }
      }
    }

    this._depTriggers = closure;
    if (closure.size > 0) {
      const total = [...closure.values()].reduce((n, v) => n + v.length, 0);
      this.log(`behaviour: dep closure: ${direct.size} direct keys, ${total} total edges`, 'ok');
    }
  }

  // Fire dep reactions triggered by slot changes after a talk invocation.
  // changedSlots: Map of slotName → newValue (already written to shrub.slots)
  // Guards re-entrant firing with a depth counter.
  _fireDepReactions(shrubName, changedSlots, depth = 0) {
    if (depth > 8) {
      this.log(`behaviour: dep reaction depth limit reached from "${shrubName}"`, 'warn');
      return;
    }
    for (const [slotName] of changedSlots) {
      const key = `${shrubName}/${slotName}`;
      const reactions = this._depTriggers.get(key);
      if (!reactions) continue;
      for (const { shrub: targetShrub, label } of reactions) {
        const reaction = this._depReactions.get(`${targetShrub}/${label}`);
        if (!reaction) continue;
        const targetShrubData = this._shrubs.get(targetShrub);
        if (!targetShrubData) continue;
        const ctx = {
          shrub: targetShrub, slots: targetShrubData.slots, kids: targetShrubData.kids,
          deps: targetShrubData.schema.deps, inputs: {}, src: null, now: Date.now(),
        };
        const preSnapshot = new Map(targetShrubData.slots);
        for (const mut of reaction.mutations) {
          this._executeMutation(mut, ctx);
        }
        // Collect what changed, mark dirty, and recurse (no flush — invoke handles it)
        const downstream = new Map();
        for (const [s, v] of targetShrubData.slots) {
          if (v !== preSnapshot.get(s)) {
            downstream.set(s, v);
            this._markDeriveDirty(targetShrub, s);
          }
        }
        if (downstream.size > 0) {
          this._fireDepReactions(targetShrub, downstream, depth + 1);
        }
      }
    }
  }

  // ── @channel: compiled bridge from behaviour slot → GPU heap field ──
  // Syntax: @channel name :from /shrub/slot :to /buffer/field :mode on-change|every-frame
  _compileChannels(tree) {
    for (const ch of Rex.findAll(tree, 'channel')) {
      const from = ch.attrs.from;
      const to = ch.attrs.to;
      const mode = ch.attrs.mode || 'on-change';
      if (!from || !to) continue;

      // Parse :from path — /shrubName/slotName
      const fromParts = (typeof from === 'string' ? from : '').split('/').filter(Boolean);
      if (fromParts.length < 2) { this.log(`channel "${ch.name||'?'}": :from needs /shrub/slot`, 'err'); continue; }

      // Parse :to path — /bufferName/fieldName
      const toParts = (typeof to === 'string' ? to : '').split('/').filter(Boolean);
      if (toParts.length < 2) { this.log(`channel "${ch.name||'?'}": :to needs /buffer/field`, 'err'); continue; }

      const delay = +(ch.attrs.delay || 0);
      this._channels.push({
        name: ch.name || `${fromParts.join('/')}->${toParts.join('/')}`,
        from: { shrub: fromParts[0], slot: fromParts[1] },
        to: { buffer: toParts[0], field: toParts[1] },
        mode,
        delay,
        lastValue: undefined,
        lastPushTime: 0,
        debounceTimer: null,
        fired: false,
      });
    }
  }

  _orderDerives() {
    // Topological sort: derives that read slots produced by other derives must come after them.
    // Uses compiled AST for ref extraction + precomputed reverse dep graph for O(V+E) Kahn's.
    if (this._derives.length <= 1) return;
    const N = this._derives.length;

    // Build map: "shrub/slot" → derive index
    const derivedSlots = new Map();
    for (let i = 0; i < N; i++) {
      const d = this._derives[i];
      derivedSlots.set(`${d.shrub}/${d.slot}`, i);
    }

    // Extract dependencies per derive using compiled AST (no string tokenization)
    const inDeg = new Int32Array(N);
    const revDeps = new Array(N); // reverse adjacency: revDeps[dependency] = [dependents...]
    for (let i = 0; i < N; i++) revDeps[i] = [];

    for (let i = 0; i < N; i++) {
      const d = this._derives[i];
      const refs = this._extractSlotRefs(d.expr, d.compiled);
      const depIndices = new Set();
      for (const ref of refs) {
        const key = `${d.shrub}/${ref}`;
        if (derivedSlots.has(key)) depIndices.add(derivedSlots.get(key));
      }
      // Cross-shrub via %dep refs
      const depRefs = this._extractDepRefs(d.expr, d.compiled);
      const shrub = this._shrubs.get(d.shrub);
      if (shrub) {
        for (const depLabel of depRefs) {
          const depDef = shrub.schema.deps.get(depLabel);
          if (depDef) {
            const depParts = depDef.path.split('/').filter(Boolean);
            if (depParts.length >= 2) {
              const crossKey = `${depParts[0]}/${depParts.slice(1).join('/')}`;
              if (derivedSlots.has(crossKey)) depIndices.add(derivedSlots.get(crossKey));
            }
          }
        }
      }
      inDeg[i] = depIndices.size;
      for (const dep of depIndices) revDeps[dep].push(i);
    }

    // Kahn's with precomputed reverse adjacency: O(V+E)
    const queue = [];
    for (let i = 0; i < N; i++) { if (inDeg[i] === 0) queue.push(i); }
    const order = [];
    while (queue.length > 0) {
      const n = queue.shift();
      order.push(n);
      for (const dependent of revDeps[n]) {
        if (--inDeg[dependent] === 0) queue.push(dependent);
      }
    }
    // Cycle: append remaining in original order
    if (order.length < N) {
      const inOrder = new Set(order);
      for (let i = 0; i < N; i++) { if (!inOrder.has(i)) order.push(i); }
    }
    this._derives = order.map(i => this._derives[i]);

    // ── Persist dependency graph for dirty tracking ──
    // Remap indices from pre-sort to post-sort order
    const oldToNew = new Int32Array(N);
    for (let i = 0; i < order.length; i++) oldToNew[order[i]] = i;

    this._derivedSlots = new Map();
    for (const [key, oldIdx] of derivedSlots) {
      this._derivedSlots.set(key, oldToNew[oldIdx]);
    }

    this._deriveRevDeps = new Array(N);
    for (let i = 0; i < N; i++) this._deriveRevDeps[i] = [];
    for (let oldI = 0; oldI < N; oldI++) {
      const newI = oldToNew[oldI];
      for (const oldDep of revDeps[oldI]) {
        this._deriveRevDeps[newI].push(oldToNew[oldDep]);
      }
    }

    this._deriveDirty = new Uint8Array(N);
  }

  // ── GPU derive classification ──
  // Splits this._derives into _gpuDerives (WGSL-transpilable, pure math, all slots
  // resolve to heap fields or prior GPU derives) and _cpuDerives (everything else).
  // GPU derives run as a single compute dispatch; CPU derives eval via JS as before.
  _classifyDerives() {
    this._gpuDerives = [];
    this._cpuDerives = [];
    if (this._derives.length === 0) return;

    // Build set of channel targets: "shrub/slot" → "buffer/field"
    // These tell us which slots map to GPU heap fields
    const channelTargets = new Map();
    for (const ch of this._channels) {
      channelTargets.set(`${ch.from.shrub}/${ch.from.slot}`, `${ch.to.buffer}/${ch.to.field}`);
    }

    // Track which derives are GPU-eligible (by "shrub/slot" key)
    const gpuDeriveKeys = new Set();

    // First pass: check transpilability + slot resolution
    for (const d of this._derives) {
      const deriveKey = `${d.shrub}/${d.slot}`;

      // Skip derives with onSlotChange or surprise callbacks that need CPU-side values
      // (We can't detect this perfectly at compile time, so we check if the slot has
      // min/max range constraints — those trigger surprise detection which needs CPU)
      const shrub = this._shrubs.get(d.shrub);
      let needsCpu = false;
      if (shrub) {
        const slotSchema = shrub.schema.slots.get(d.slot);
        if (slotSchema && (slotSchema.min !== undefined || slotSchema.max !== undefined)) {
          needsCpu = true; // surprise detection needs CPU eval
        }
      }

      if (needsCpu || !d.compiled) {
        this._cpuDerives.push(d);
        continue;
      }

      // Build resolver: maps slot/ident/dep refs to WGSL accessor strings
      const resolver = (kind, name) => {
        if (kind === 'slot') {
          // Check if this slot is produced by a prior GPU derive
          const refKey = `${d.shrub}/${name}`;
          if (gpuDeriveKeys.has(refKey)) {
            // Sanitize name for WGSL struct field
            return `derives.${name.replace(/-/g, '_')}`;
          }
          // Check if this slot maps to a heap field via @channel
          const target = channelTargets.get(refKey);
          if (target) {
            const field = target.split('/').pop();
            return `params.${field.replace(/-/g, '_')}`;
          }
          // Check if it's a direct heap field name (common pattern)
          return `params.${name.replace(/-/g, '_')}`;
        }
        if (kind === 'ident') {
          // Idents that are slot references
          const refKey = `${d.shrub}/${name}`;
          if (gpuDeriveKeys.has(refKey)) return `derives.${name.replace(/-/g, '_')}`;
          return `params.${name.replace(/-/g, '_')}`;
        }
        if (kind === 'dep') {
          // Cross-shrub dep: resolve via schema
          if (!shrub) return null;
          const depDef = shrub.schema.deps.get(name);
          if (!depDef) return null;
          const parts = depDef.path.split('/').filter(Boolean);
          if (parts.length < 2) return null;
          const crossKey = `${parts[0]}/${parts.slice(1).join('/')}`;
          if (gpuDeriveKeys.has(crossKey)) return `derives.${parts.slice(1).join('_').replace(/-/g, '_')}`;
          return `params.${parts.slice(1).join('_').replace(/-/g, '_')}`;
        }
        return null;
      };

      const result = Rex.compileExprToWGSL(d.compiled, resolver);
      if (result.viable) {
        d._wgsl = result.wgsl;
        d._wgslField = d.slot.replace(/-/g, '_');
        this._gpuDerives.push(d);
        gpuDeriveKeys.add(deriveKey);
      } else {
        this._cpuDerives.push(d);
      }
    }

    // Channel elimination: mark channels whose source is a GPU derive as eliminated
    // These channels would copy derive results from JS to GPU heap — unnecessary when
    // the derive result is already in GPU storage buffer.
    let eliminated = 0;
    for (const ch of this._channels) {
      const chKey = `${ch.from.shrub}/${ch.from.slot}`;
      ch._gpuEliminated = gpuDeriveKeys.has(chKey);
      if (ch._gpuEliminated) eliminated++;
    }

    if (this._gpuDerives.length > 0) {
      this.log(`behaviour: derives classified: ${this._gpuDerives.length} GPU, ${this._cpuDerives.length} CPU, ${eliminated} channels eliminated`, 'ok');
    }

    // Build form dependency map: formFieldName → Set<cpuDeriveIndex>
    this._deriveFormDeps = new Map();
    const cpuDrvs = this._cpuDerives;
    for (let i = 0; i < cpuDrvs.length; i++) {
      const d = cpuDrvs[i];
      if (!d.compiled) continue;
      const refs = new Set();
      Rex.collectSlotRefs(d.compiled, refs);
      for (const ref of refs) {
        if (ref.startsWith('form/')) {
          const fieldName = ref.slice(5);
          if (!this._deriveFormDeps.has(fieldName)) this._deriveFormDeps.set(fieldName, new Set());
          this._deriveFormDeps.get(fieldName).add(i);
        }
      }
    }
  }

  _extractSlotRefs(expr, compiled) {
    const refs = new Set();
    if (compiled) {
      Rex.collectSlotRefs(compiled, refs);
    } else if (typeof expr === 'string' && expr.startsWith('/')) {
      refs.add(expr.slice(1));
    }
    return refs;
  }

  _extractDepRefs(expr, compiled) {
    const refs = new Set();
    if (compiled) {
      Rex.collectDepRefs(compiled, refs);
    } else if (typeof expr === 'string' && expr.startsWith('%')) {
      refs.add(expr.slice(1));
    }
    return refs;
  }

  // ════════════════════════════════════════════════════════════════
  // EXECUTE PHASE — Expression Evaluation
  // ════════════════════════════════════════════════════════════════

  // ── Per-derive dirty tracking ──

  _markDeriveDirty(shrubName, slotName) {
    if (!this._derivedSlots || !this._deriveDirty) return;
    const key = `${shrubName}/${slotName}`;
    const idx = this._derivedSlots.get(key);
    if (idx === undefined) return;
    if (this._deriveDirty[idx]) return;  // already dirty
    this._deriveDirty[idx] = 1;
    // Propagate: mark all transitive dependents via revDeps
    const stack = this._deriveRevDeps[idx].slice();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!this._deriveDirty[cur]) {
        this._deriveDirty[cur] = 1;
        for (const dep of this._deriveRevDeps[cur]) stack.push(dep);
      }
    }
  }

  _markDeriveDirtyByIndex(idx) {
    if (!this._deriveDirty || this._deriveDirty[idx]) return;
    this._deriveDirty[idx] = 1;
    const stack = this._deriveRevDeps[idx].slice();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!this._deriveDirty[cur]) {
        this._deriveDirty[cur] = 1;
        for (const dep of this._deriveRevDeps[cur]) stack.push(dep);
      }
    }
  }

  _markAllDerivesDirty() {
    if (this._deriveDirty) this._deriveDirty.fill(1);
  }

  // Batched derive flush: eval only dirty CPU derives in topological order, then push channels.
  // Replaces the old pattern of calling _recomputeDerives() + _pushChannels() at every mutation point.
  _flushDerives() {
    // Write ShrubLM confidence/ready shadow slots before derive pass
    if (this.getShrubLM) {
      for (const [shrubName, shrub] of this._shrubs) {
        const lm = this.getShrubLM(shrubName);
        if (!lm) continue;
        shrub.slots.set(`__lm_ready_${shrubName}`, lm.ready ? 1 : 0);
        shrub.slots.set(`__lm_confidence_${shrubName}`, lm.confidence);
      }
    }

    const derivesToEval = this._cpuDerives || this._derives;
    const hasDirty = this._deriveDirty;
    for (let i = 0; i < derivesToEval.length; i++) {
      if (hasDirty && !hasDirty[i]) continue;  // skip clean derives
      if (hasDirty) hasDirty[i] = 0;

      const d = derivesToEval[i];
      const shrub = this._shrubs.get(d.shrub);
      if (!shrub) continue;
      const ctx = { shrub: d.shrub, slots: shrub.slots, kids: shrub.kids, deps: shrub.schema.deps };
      const val = this._evalExpr(d.expr, ctx);
      if (val !== undefined) {
        const prev = shrub.slots.get(d.slot);
        shrub.slots.set(d.slot, val);
        if (val !== prev) {
          // Value changed — mark downstream derives dirty (they have higher indices)
          this._markDeriveDirty(d.shrub, d.slot);
          if (this.onSlotChange) this.onSlotChange(d.shrub, d.slot, val);
          // Surprise detection
          if (this.onSurpriseSignal && typeof val === 'number') {
            const slotSchema = shrub.schema.slots.get(d.slot);
            if (slotSchema) {
              const { min, max } = slotSchema;
              if ((min !== undefined && val < min) || (max !== undefined && val > max)) {
                this.onSurpriseSignal(d.shrub, d.slot, val, { min, max });
                try { this._attemptRecovery(d.shrub, d.slot, val, { min, max }); }
                catch (e) { this.log(`behaviour: recovery error: ${e.message}`, 'err'); }
              }
            }
          }
        }
      }
    }

    this._pushChannels();
  }

  // Legacy: kept for backward compat — delegates to _flushDerives with all-dirty
  _recomputeDerives() {
    // Write ShrubLM confidence/ready shadow slots before derive pass
    if (this.getShrubLM) {
      for (const [shrubName, shrub] of this._shrubs) {
        const lm = this.getShrubLM(shrubName);
        if (!lm) continue;
        shrub.slots.set(`__lm_ready_${shrubName}`, lm.ready ? 1 : 0);
        shrub.slots.set(`__lm_confidence_${shrubName}`, lm.confidence);
      }
    }

    // Only iterate CPU derives — GPU derives run as compute dispatch
    const derivesToEval = this._cpuDerives || this._derives;
    for (const d of derivesToEval) {
      const shrub = this._shrubs.get(d.shrub);
      if (!shrub) continue;
      const ctx = { shrub: d.shrub, slots: shrub.slots, kids: shrub.kids, deps: shrub.schema.deps };
      const val = this._evalExpr(d.expr, ctx);
      if (val !== undefined) {
        const prev = shrub.slots.get(d.slot);
        shrub.slots.set(d.slot, val);
        if (val !== prev) {
          if (this.onSlotChange) this.onSlotChange(d.shrub, d.slot, val);
          // Surprise: emit if value outside schema-declared range
          if (this.onSurpriseSignal && typeof val === 'number') {
            const slotSchema = shrub.schema.slots.get(d.slot);
            if (slotSchema) {
              const { min, max } = slotSchema;
              if ((min !== undefined && val < min) || (max !== undefined && val > max)) {
                this.onSurpriseSignal(d.shrub, d.slot, val, { min, max });
                // Self-healing: attempt recovery via goal-state generator
                try { this._attemptRecovery(d.shrub, d.slot, val, { min, max }); }
                catch (e) { this.log(`behaviour: recovery error: ${e.message}`, 'err'); }
              }
            }
          }
        }
      }
    }
  }

  // Self-healing: attempt to invoke a corrective talk when a derive exits schema range.
  // The goal-state generator (PCN) finds which talk's displacement can push the slot back.
  // Cooldown prevents infinite surprise→recovery→surprise loops.
  _attemptRecovery(shrubName, slotName, value, schemaRange) {
    if (!this.getGoalState) return;

    const now = performance.now();
    let state = this._recoveryState.get(shrubName);
    if (!state) {
      state = { attempts: 0, cooldownUntil: 0 };
      this._recoveryState.set(shrubName, state);
    }

    // Cooldown: prevent loops
    if (now < state.cooldownUntil) return;
    if (state.attempts >= 3) {
      state.cooldownUntil = now + 5000; // 5s cooldown
      state.attempts = 0;
      this.log(`behaviour: recovery cooldown for "${shrubName}" (5s)`, 'warn');
      return;
    }

    // Target: clamp back to nearest schema boundary
    const target = (schemaRange.min !== undefined && value < schemaRange.min) ? schemaRange.min
                 : (schemaRange.max !== undefined && value > schemaRange.max) ? schemaRange.max
                 : value;

    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;

    const goal = this.getGoalState(shrubName, slotName, target, shrub.slots);
    if (!goal) return;

    state.attempts++;
    this.log(`behaviour: recovery ${state.attempts}/3 for "${shrubName}/${slotName}" via "${goal.talk}"`, 'ok');

    const success = this.invoke(shrubName, goal.talk, {});
    if (success) {
      const newVal = shrub.slots.get(slotName);
      if (typeof newVal === 'number') {
        const inRange = (schemaRange.min === undefined || newVal >= schemaRange.min) &&
                        (schemaRange.max === undefined || newVal <= schemaRange.max);
        if (inRange) {
          state.attempts = 0;
          this.log(`behaviour: recovery succeeded for "${shrubName}/${slotName}" → ${newVal}`, 'ok');
        }
      }
    }
  }

  // ── Channel push: behaviour slots → GPU heap ──
  _pushChannels() {
    if (this._channels.length === 0 || !this.onChannelPush) return;
    const now = performance.now();
    for (const ch of this._channels) {
      // Skip GPU-eliminated channels — derive result already in GPU storage buffer
      if (ch._gpuEliminated) continue;
      const shrub = this._shrubs.get(ch.from.shrub);
      if (!shrub) continue;
      const val = shrub.slots.get(ch.from.slot);
      if (val === undefined) continue;

      const changed = val !== ch.lastValue;
      let shouldPush = false;

      switch (ch.mode) {
        case 'every-frame': shouldPush = true; break;
        case 'once': if (!ch.fired && changed) { shouldPush = true; ch.fired = true; } break;
        case 'throttle': if (changed && now - ch.lastPushTime >= ch.delay) shouldPush = true; break;
        case 'debounce':
          if (changed) {
            if (ch.debounceTimer) clearTimeout(ch.debounceTimer);
            ch.debounceTimer = setTimeout(() => {
              ch.debounceTimer = null;
              const v = shrub.slots.get(ch.from.slot);
              if (v === undefined) return;
              ch.lastValue = v;
              ch.lastPushTime = performance.now();
              const nv = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : Number(v) || 0;
              this.onChannelPush(ch.to.buffer, ch.to.field, nv);
            }, ch.delay || 100);
          }
          break;
        default: if (changed) shouldPush = true; break; // on-change
      }

      if (shouldPush) {
        ch.lastValue = val;
        ch.lastPushTime = now;
        const numVal = typeof val === 'boolean' ? (val ? 1 : 0) : typeof val === 'number' ? val : Number(val) || 0;
        this.onChannelPush(ch.to.buffer, ch.to.field, numVal);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // TALK INVOCATION — Named mutation entry point
  // ════════════════════════════════════════════════════════════════

  invoke(shrubName, actionName, inputs = {}) {
    const key = `${shrubName}/${actionName}`;
    const talk = this._talks.get(key);
    if (!talk) { this.log(`behaviour: talk "${key}" not found`, 'err'); return false; }

    const shrub = this._shrubs.get(shrubName);
    if (!shrub) { this.log(`behaviour: shrub "${shrubName}" not found`, 'err'); return false; }

    const ctx = {
      shrub: shrubName, slots: shrub.slots, kids: shrub.kids,
      deps: shrub.schema.deps, inputs, src: null, now: Date.now(),
    };

    const t0 = performance.now();

    // Guard check — model-free bypass when ShrubLM says this is prototypical
    if (talk.guard) {
      let bypassed = false;
      if (this.getShrubLM) {
        const lm = this.getShrubLM(shrubName);
        if (lm && lm.ready) {
          // Build prospective deltas from inputs for prototype check
          const prospective = new Map();
          for (const [k, v] of Object.entries(inputs)) {
            if (typeof v === 'number') prospective.set(k, v);
          }
          if (lm.isPrototypical(actionName, prospective)) {
            bypassed = true;
            // Write bypass signal slot for surface/form rendering
            shrub.slots.set(`__lm_bypass_${actionName}`, 1);
          }
        }
      }
      if (!bypassed) {
        const guardResult = this._evalExpr(talk.guard, ctx);
        // Guards must return boolean/number — strings (e.g. from malformed expressions) fail
        if (!guardResult || typeof guardResult === 'string') {
          this.log(`behaviour: guard rejected for "${key}"`, 'warn');
          shrub.slots.set(`__lm_bypass_${actionName}`, 0);
          if (this.onTalkFired) {
            this.onTalkFired({ shrub: shrubName, talk: actionName, guard_result: false,
              mutations_fired: [], slot_deltas: new Map(), surprise: 0, timestamp: t0 });
          }
          return false;
        }
      }
    }

    // Snapshot pre-mutation slots
    const preSnapshot = new Map(shrub.slots);

    // Execute mutations atomically
    for (const mut of talk.mutations) {
      this._executeMutation(mut, ctx);
    }

    // Mark derives dirty for changed slots (instead of full recompute)
    const directChanges = new Map();
    for (const [s, v] of shrub.slots) {
      if (v !== preSnapshot.get(s)) {
        directChanges.set(s, v);
        this._markDeriveDirty(shrubName, s);
      }
    }

    // Fire transitive dep reactions (marks more derives dirty)
    if (directChanges.size > 0) this._fireDepReactions(shrubName, directChanges);

    // Single batched flush after all mutations + dep reactions complete
    this._flushDerives();

    // Build causal record and emit
    if (this.onTalkFired) {
      const mutations_fired = [];
      const slot_deltas = new Map();
      for (const [slotName, newVal] of shrub.slots) {
        const oldVal = preSnapshot.get(slotName);
        if (newVal !== oldVal) {
          mutations_fired.push({ path: slotName, old_val: oldVal, new_val: newVal });
          if (typeof newVal === 'number') {
            slot_deltas.set(slotName, newVal - (typeof oldVal === 'number' ? oldVal : 0));
          }
        }
      }
      this.onTalkFired({ shrub: shrubName, talk: actionName, guard_result: true,
        mutations_fired, slot_deltas, surprise: 0, timestamp: t0 });
    }

    return true;
  }

  // ════════════════════════════════════════════════════════════════
  // MUTATION EXECUTION
  // ════════════════════════════════════════════════════════════════

  _executeMutation(node, ctx) {
    switch (node.type) {
      case 'set': {
        // @set /path EXPR
        const path = node.name;
        const val = this._evalExpr(this._extractExpr(node), ctx);
        this._setSlot(ctx.shrub, path, val);
        break;
      }
      case 'create': {
        // @create /path/[auto] with @slot children
        const path = node.name;
        const slotValues = new Map();
        for (const child of node.children.filter(c => c.type === 'slot')) {
          slotValues.set(child.name, this._evalExpr(this._extractExpr(child), ctx));
        }
        this._createKid(ctx.shrub, path, slotValues, ctx);
        break;
      }
      case 'update': {
        // @update /path/%id with @slot children
        const path = node.name;
        const slotValues = new Map();
        for (const child of node.children.filter(c => c.type === 'slot')) {
          slotValues.set(child.name, this._evalExpr(this._extractExpr(child), ctx));
        }
        this._updateKid(ctx.shrub, path, slotValues, ctx);
        break;
      }
      case 'remove': {
        // @remove /path/%id
        const path = node.name;
        this._removeKid(ctx.shrub, path, ctx);
        break;
      }
      case 'each': {
        // @each COLLECTION with optional @where and mutations
        const collection = node.name;
        const whereNode = node.children.find(c => c.type === 'where');
        const mutations = node.children.filter(c => c.type !== 'where');
        const items = this._resolveCollection(ctx.shrub, collection, ctx);
        if (!items) break;
        for (const [key, item] of items) {
          const eachCtx = { ...ctx, item, key };
          if (whereNode) {
            const cond = this._evalExpr(this._extractExpr(whereNode), eachCtx);
            if (!cond) continue;
          }
          for (const mut of mutations) {
            this._executeMutation(mut, eachCtx);
          }
        }
        break;
      }
      case 'when': {
        // @when EXPR with mutations
        const test = this._extractExpr(node.children.find(c => c.type === 'test') || node);
        const cond = this._evalExpr(test, ctx);
        if (cond) {
          for (const child of node.children.filter(c => c.type !== 'test')) {
            this._executeMutation(child, ctx);
          }
        }
        break;
      }

      // ── Declarative mutation operators (use.gpu-inspired) ──

      case 'merge': {
        // @merge /path — shallow merge child @slot values into existing slot
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (!shrub) break;
        const current = shrub.slots.get(slotName);
        if (current && typeof current === 'object' && !(current instanceof Map)) {
          // Object merge
          const merged = { ...current };
          for (const child of node.children.filter(c => c.type === 'slot')) {
            const val = this._evalExpr(this._extractExpr(child), ctx);
            const key = child.name;
            if (val !== undefined && typeof val === 'object' && typeof merged[key] === 'object' && merged[key] !== null) {
              merged[key] = { ...merged[key], ...val }; // recursive one level
            } else {
              merged[key] = val;
            }
          }
          this._setSlot(ctx.shrub, path, merged);
        } else if (current instanceof Map) {
          // Map merge
          for (const child of node.children.filter(c => c.type === 'slot')) {
            current.set(child.name, this._evalExpr(this._extractExpr(child), ctx));
          }
          this._setSlot(ctx.shrub, path, current);
        } else {
          // No existing value — create object from children
          const obj = {};
          for (const child of node.children.filter(c => c.type === 'slot')) {
            obj[child.name] = this._evalExpr(this._extractExpr(child), ctx);
          }
          this._setSlot(ctx.shrub, path, obj);
        }
        break;
      }
      case 'delete': {
        // @delete /path — remove slot entirely
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (shrub) {
          shrub.slots.delete(slotName);
          if (this.onSlotChange) this.onSlotChange(ctx.shrub, slotName, undefined);
        }
        break;
      }
      case 'apply': {
        // @apply /path EXPR — transform slot in-place; $current = current value
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (!shrub) break;
        const currentVal = shrub.slots.get(slotName);
        const applyCtx = { ...ctx, currentSlotValue: currentVal };
        const val = this._evalExpr(this._extractExpr(node), applyCtx);
        this._setSlot(ctx.shrub, path, val);
        break;
      }
      case 'inc': {
        // @inc /path EXPR — add EXPR to current numeric slot
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (!shrub) break;
        const currentVal = Number(shrub.slots.get(slotName)) || 0;
        const delta = this._evalExpr(this._extractExpr(node), ctx);
        this._setSlot(ctx.shrub, path, currentVal + (Number(delta) || 0));
        break;
      }
      case 'toggle': {
        // @toggle /path — flip boolean slot
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (!shrub) break;
        const currentVal = shrub.slots.get(slotName);
        this._setSlot(ctx.shrub, path, !currentVal);
        break;
      }
      case 'push': {
        // @push /path EXPR — append value to array-typed slot
        const path = node.name;
        const slotName = path.startsWith('/') ? path.slice(1) : path;
        const shrub = this._shrubs.get(ctx.shrub);
        if (!shrub) break;
        let arr = shrub.slots.get(slotName);
        if (!Array.isArray(arr)) arr = [];
        const val = this._evalExpr(this._extractExpr(node), ctx);
        arr.push(val);
        this._setSlot(ctx.shrub, path, arr);
        break;
      }

      default: {
        const h = this._mutationHandlers.get(node.type);
        if (h) h(node, ctx, this);
        else if (!this._warnedTypes.has(node.type)) {
          this._warnedTypes.add(node.type);
          console.warn(`rex-behaviour: unhandled mutation type "${node.type}"`);
        }
        break;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // STATE OPERATIONS
  // ════════════════════════════════════════════════════════════════

  _setSlot(shrubName, path, value) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;
    // /slotName → set root slot
    const slotName = path.startsWith('/') ? path.slice(1) : path;
    shrub.slots.set(slotName, value);
    if (this.onSlotChange) this.onSlotChange(shrubName, slotName, value);
  }

  _createKid(shrubName, path, slotValues, ctx) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;
    // Parse path: /tasks/[auto] or /products/%sku
    const resolved = this._resolvePath(path, ctx);
    const parts = resolved.split('/').filter(Boolean);
    const collectionPath = parts.slice(0, -1).join('/');
    let key = parts[parts.length - 1];

    if (key === '[auto]') {
      const autoKey = shrub.nextAutoKey.get(collectionPath) || 1;
      key = String(autoKey);
      shrub.nextAutoKey.set(collectionPath, autoKey + 1);
    }

    if (!shrub.kids.has(collectionPath)) {
      shrub.kids.set(collectionPath, new Map());
    }
    shrub.kids.get(collectionPath).set(key, slotValues);
  }

  _updateKid(shrubName, path, slotValues, ctx) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;

    // Handle $item (from @each context)
    if (path === '$item' && ctx.item) {
      for (const [k, v] of slotValues) ctx.item.set(k, v);
      return;
    }

    const resolved = this._resolvePath(path, ctx);
    const parts = resolved.split('/').filter(Boolean);
    const collectionPath = parts.slice(0, -1).join('/');
    const key = parts[parts.length - 1];

    const collection = shrub.kids.get(collectionPath);
    if (!collection) return;
    const kid = collection.get(key);
    if (!kid) return;
    for (const [k, v] of slotValues) kid.set(k, v);
  }

  _removeKid(shrubName, path, ctx) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return;

    if (path === '$item' && ctx.item && ctx.key !== undefined) {
      // Find which collection $item belongs to and remove by key
      for (const [, coll] of shrub.kids) {
        if (coll.has(ctx.key)) { coll.delete(ctx.key); return; }
      }
      return;
    }

    const resolved = this._resolvePath(path, ctx);
    const parts = resolved.split('/').filter(Boolean);
    const collectionPath = parts.slice(0, -1).join('/');
    const key = parts[parts.length - 1];

    const collection = shrub.kids.get(collectionPath);
    if (collection) collection.delete(key);
  }

  _resolveCollection(shrubName, path, ctx) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return null;

    // %kids/PATH → kids collection
    if (path.startsWith('%kids/')) {
      const kidPath = path.slice(6); // remove %kids/
      return shrub.kids.get(kidPath);
    }
    // %LABEL → dep data (would come from another shrub)
    if (path.startsWith('%')) {
      const label = path.slice(1);
      const depDef = shrub.schema.deps.get(label);
      if (depDef) {
        // Resolve dep path to another shrub's kids
        return this._resolveDepCollection(depDef.path);
      }
    }
    return shrub.kids.get(path);
  }

  _resolveDepCollection(depPath) {
    // /shrubName/kidsPath or /shrubName/slotName (single value)
    const parts = depPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const shrubName = parts[0];
    const kidsPath = parts.slice(1).join('/');
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return null;
    // First try kids collection
    const kids = shrub.kids.get(kidsPath);
    if (kids) return kids;
    // Fallback: single slot value → wrap as a single-entry Map for fold compatibility
    if (parts.length === 2) {
      const slotVal = shrub.slots.get(parts[1]);
      if (slotVal !== undefined) {
        const singleMap = new Map();
        singleMap.set('0', slotVal instanceof Map ? slotVal : new Map([['value', slotVal]]));
        return singleMap;
      }
    }
    return null;
  }

  _resolvePath(path, ctx) {
    // Replace %input interpolations
    let resolved = path;
    if (ctx.inputs) {
      for (const [key, val] of Object.entries(ctx.inputs)) {
        resolved = resolved.replace(`%${key}`, String(val));
      }
    }
    return resolved;
  }

  // ════════════════════════════════════════════════════════════════
  // EXPRESSION EVALUATOR — delegates to shared Rex.evalExpr
  // ════════════════════════════════════════════════════════════════

  _evalExpr(expr, ctx) {
    if (expr === null || expr === undefined) return undefined;

    // Literal values
    if (typeof expr === 'number') return expr;
    if (typeof expr === 'boolean') return expr;
    if (typeof expr === 'string') {
      if (expr.startsWith('/')) return this._readSlot(ctx.shrub, expr.slice(1), ctx);
      if (expr.startsWith('%')) return this._readEnv(expr, ctx);
      if (expr.startsWith('$')) return this._readBinding(expr, ctx);
      return expr;
    }

    // Expression object from parser: {expr: "...", rex: ...}
    if (expr && typeof expr === 'object' && expr.expr !== undefined) {
      if (expr._compiled === undefined) expr._compiled = Rex.compileExpr(expr) ?? false;
      if (expr._compiled) {
        const evalCtx = this._makeBehaviourContext(ctx);
        return Rex.evalExpr(expr._compiled, evalCtx);
      }
      return undefined;
    }

    // Node with children (from tree)
    if (expr && expr.type) return this._evalNodeExpr(expr, ctx);

    return expr;
  }

  // Build a Rex.evalExpr context for behaviour expressions
  _makeBehaviourContext(ctx) {
    const self = this;
    return {
      resolve(op, key, args) {
        switch (op) {
          case 'slot': return self._readSlot(ctx.shrub, key, ctx);
          case 'dep': return self._readEnv('%' + key, ctx);
          case 'binding':
            // $current — special binding for @apply mutation context
            if (key === 'current' && ctx.currentSlotValue !== undefined) return ctx.currentSlotValue;
            return self._readBinding('$' + key, ctx);
          case 'ident': return undefined; // fall through to string in evalExpr
          case 'collection': return self._resolveCollection(ctx.shrub, key, ctx);
          case 'call': {
            // User-defined @def
            const def = self._defs.get(key);
            if (def) {
              const defCtx = { ...ctx, defArgs: {} };
              for (let i = 0; i < def.args.length; i++) defCtx.defArgs[def.args[i]] = args[i];
              if (def.compiled) return Rex.evalExpr(def.compiled, self._makeBehaviourContext(defCtx));
              return self._evalExpr(def.body, defCtx);
            }
            return undefined;
          }
        }
        return undefined;
      }
    };
  }

  // ════════════════════════════════════════════════════════════════
  // PATH READERS
  // ════════════════════════════════════════════════════════════════

  _readSlot(shrubName, path, ctx) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return undefined;

    let resolved = path;
    if (ctx && ctx.inputs) {
      for (const [k, v] of Object.entries(ctx.inputs)) {
        resolved = resolved.replace(`%${k}`, String(v));
      }
    }

    const parts = resolved.split('/').filter(Boolean);
    if (parts.length === 1) return shrub.slots.get(parts[0]);

    if (parts.length >= 3) {
      const collPath = parts.slice(0, -2).join('/');
      const key = parts[parts.length - 2];
      const slot = parts[parts.length - 1];
      const coll = shrub.kids.get(collPath);
      if (coll) {
        const kid = coll.get(key);
        if (kid) return kid.get(slot);
      }
    }

    return undefined;
  }

  _readEnv(path, ctx) {
    if (path === '%now') return ctx.now || Date.now();
    if (path === '%src') return ctx.src;
    const inputName = path.slice(1);
    if (ctx.inputs && inputName in ctx.inputs) return ctx.inputs[inputName];
    if (ctx.deps) {
      const depDef = ctx.deps.get(inputName);
      if (depDef) {
        if (!depDef._parts) depDef._parts = depDef.path.split('/').filter(Boolean);
        const parts = depDef._parts;
        if (parts.length >= 1) {
          if (!depDef._slotPath) depDef._slotPath = parts.slice(1).join('/');
          return this._readSlot(parts[0], depDef._slotPath, ctx);
        }
      }
    }
    // Fallback: check form state for %formFieldName references
    if (this.formState && this.formState[inputName] !== undefined) return this.formState[inputName];
    return undefined;
  }

  _readBinding(path, ctx) {
    if (path === '$acc') return ctx.acc;
    if (path === '$key') return ctx.key;
    if (path === '$item') return ctx.item;
    if (path.startsWith('$item.')) {
      const field = path.slice(6);
      if (ctx.item && ctx.item instanceof Map) return ctx.item.get(field);
      if (ctx.item && typeof ctx.item === 'object') return ctx.item[field];
    }
    if (ctx.defArgs) {
      const argName = path.slice(1);
      if (argName in ctx.defArgs) return ctx.defArgs[argName];
      if (argName.includes('.')) {
        const [base, field] = argName.split('.');
        const val = ctx.defArgs[base];
        if (val instanceof Map) return val.get(field);
        if (val && typeof val === 'object') return val[field];
      }
    }
    return undefined;
  }

  // ════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════

  _getMutTypes() {
    if (this._mutTypeCache) return this._mutTypeCache;
    this._mutTypeCache = new Set(['slot','input','guard','dead','test','where',
      'set','create','update','remove','each','when','merge','delete','apply','inc','toggle','push',
      'dep','shrub','kids','def','derive','talk']);
    for (const t of this._schemaHandlers.keys()) this._mutTypeCache.add(t);
    for (const t of this._mutationHandlers.keys()) this._mutTypeCache.add(t);
    return this._mutTypeCache;
  }

  _extractExpr(node) {
    if (!node) return undefined;
    if (node.attrs._expr) return node.attrs._expr;
    const exprChildren = node.children.filter(c => !this._getMutTypes().has(c.type));
    if (exprChildren.length > 0) {
      const child = exprChildren[0];
      if (child.attrs && child.attrs._expr) return child.attrs._expr;
      if (child.attrs && child.attrs.expr) return child.attrs;
      return child.name || child.attrs;
    }
    if (node.name && typeof node.name === 'object' && node.name.expr) return node.name;
    for (const [k, val] of Object.entries(node.attrs)) {
      if (k === '_expr') continue;
      if (val && typeof val === 'object' && val.expr) return val;
    }
    if (node.name && typeof node.name === 'string' && !node.name.startsWith(':')) return node.name;
    return undefined;
  }

  _evalNodeExpr(node, ctx) {
    // Handle tree node as expression
    if (node.type === 'slot') {
      return this._evalExpr(this._extractExpr(node), ctx);
    }
    return this._evalExpr(this._extractExpr(node), ctx);
  }

  _coerce(val, type) {
    switch (type) {
      case 'number': return Number(val) || 0;
      case 'boolean': return val === true || val === 'true';
      case 'string': return String(val ?? '');
      case 'date': return val; // Keep as-is for now
      default: return val;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════

  getSlot(shrubName, slotName) {
    const shrub = this._shrubs.get(shrubName);
    return shrub ? shrub.slots.get(slotName) : undefined;
  }

  getKids(shrubName, path) {
    const shrub = this._shrubs.get(shrubName);
    if (!shrub) return null;
    return shrub.kids.get(path);
  }

  getShrubNames() {
    return [...this._shrubs.keys()];
  }

  getTalkNames(shrubName) {
    const prefix = `${shrubName}/`;
    return [...this._talks.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
  }

  // Return schema slot definitions for a shrub (for ShrubLM reference frame init)
  getShrubSchema(shrubName) {
    const shrub = this._shrubs.get(shrubName);
    return shrub ? Object.fromEntries(shrub.schema.slots) : null;
  }

  // Return all cross-shrub dep edges for PCN connectome auto-wiring
  getCrossShrubDeps() {
    const edges = [];
    for (const [shrubName, shrub] of this._shrubs) {
      for (const [label, depDef] of shrub.schema.deps) {
        const parts = depDef.path.split('/').filter(Boolean);
        if (parts.length >= 1 && parts[0] !== shrubName) {
          edges.push({ from: shrubName, to: parts[0], label, path: depDef.path });
        }
      }
    }
    return edges;
  }
}
