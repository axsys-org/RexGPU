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
    this.onSlotChange = null;    // callback(shrubName, slotName, value)
    this.onChannelPush = null;   // callback(buffer, field, value) → GPU heap write
    this.onTalkFired = null;     // callback(record) — rich causal record per talk invocation
    this.onSurpriseSignal = null;// callback(shrub, slot, value, schemaRange) — out-of-range derives
    this.formState = null;       // external form state for expression resolution
    this.getShrubLM = null;      // callback(shrubName) → ShrubLM|null — set by main.js for model-free path
    this.getGoalState = null;    // callback(shrub, slot, target, slots) → {talk, expectedDelta}|null

    // ── Self-healing state ──
    this._recoveryState = new Map();  // shrubName → {attempts, cooldownUntil}

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

  // Fire a @talk action externally (e.g. from surface click) — delegates to invoke
  fireTalk(shrubName, actionName, params) {
    this.invoke(shrubName, actionName, params || {});
  }

  transduce(tree, structureChanged) {
    if (structureChanged || !this._compiled) {
      this._compile(tree);
    }
    // Execute phase: recompute all derives, then push channels
    this._recomputeDerives();
    this._pushChannels();
  }

  // Push a form field value into the behaviour system and recompute derives/channels
  pushFormValue(name, val) {
    if (!this._compiled) return;
    // Recompute derives that may depend on form values (via %name refs)
    this._recomputeDerives();
    this._pushChannels();
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

    // 6. Compile @channel bridges (behaviour → GPU heap)
    this._compileChannels(tree);

    // 7. Order derives by dependency
    this._orderDerives();

    // 8. Build transitive dep closure (promonad composition)
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
        // Collect what changed and recurse
        const downstream = new Map();
        for (const [s, v] of targetShrubData.slots) {
          if (v !== preSnapshot.get(s)) downstream.set(s, v);
        }
        if (downstream.size > 0) {
          this._recomputeDerives();
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

    for (const d of this._derives) {
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
        if (!guardResult) {
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

    // Recompute derives after mutations
    this._recomputeDerives();

    // Fire transitive dep reactions triggered by slot changes
    const directChanges = new Map();
    for (const [s, v] of shrub.slots) {
      if (v !== preSnapshot.get(s)) directChanges.set(s, v);
    }
    if (directChanges.size > 0) this._fireDepReactions(shrubName, directChanges);

    this._pushChannels();

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
      if (!expr._compiled) expr._compiled = Rex.compileExpr(expr);
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
          case 'binding': return self._readBinding('$' + key, ctx);
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
      'set','create','update','remove','each','when','dep','shrub','kids','def','derive','talk']);
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
