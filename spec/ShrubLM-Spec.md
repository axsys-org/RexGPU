# ShrubLM — Per-Shrub Learning Module Specification v1

**Behavioural intelligence for the Rex Projection Engine, grounded in Thousand Brains cortical column theory.**

---

## The Problem This Solves

The current PCN uses a single 2048×2048 Hebbian matrix shared across all shrubs. Every `@talk` invocation from every shrub writes into the same global association surface. This loses the thing that makes behaviours useful: *they are typed, structured, semantically scoped entities* — a `@shrub cart` with a `checkout` talk is not the same kind of thing as a `@shrub camera` with a `orbit` talk, even if they fire at the same time.

Behaviours ARE the sensorimotor columns. Each shrub is an LM. Slots are the reference frame features. Talks are the motor outputs. Derives are predictions. Guards are evidence thresholds. The architecture is already cortical — we just haven't been treating it that way.

---

## Core Thesis

Replace the monolithic Hebbian matrix with **per-shrub Learning Modules (ShrubLMs)**. Each `@shrub` gets a small graph model that learns:

1. **Which slot configurations co-occur** with which `@talk` actions (action-state binding)
2. **What displacement vectors** each talk produces in slot-space (causal geometry)
3. **Which configurations reliably produce consistent outcomes** (crystallization candidates)
4. **How confident this LM is** in its current beliefs (for lateral voting)

Lateral voting across `@dep` edges lets LMs reach consensus without a central coordinator. The `@derive` expressions can then read `__lm_*` confidence slots as evidence — making the compute graph itself the inference engine.

---

## Architecture

```
COMPILE PHASE (on @shrub parse):
  each @shrub → ShrubLM instance
    - reference frame: slot names → normalized coordinate axes
    - affordance table: talk names → expected slot-space vectors
    - hypothesis pool: {slotConfig → confidence}[]
    - lateral edges: @dep paths → neighbor LM handles

EXECUTE PHASE (on onTalkFired):
  1. observe: slot_deltas = displacement in slot-space
  2. update: Hebbian update in this LM's local graph (not global matrix)
  3. evaluate: compare observed displacement to stored prototypes
  4. crystallize: if prototype confidence > threshold → emit constraint
  5. vote: send {hypothesis, confidence} to neighbor LMs via @dep edges

FEEDBACK PHASE (every N frames):
  for each LM with crystallized patterns:
    write __lm_confidence_SLOT → shrub slot map
    write __lm_min_SLOT, __lm_max_SLOT → advisory bounds
  @derive exprs can read these via /shrubName/__lm_confidence_total
```

---

## The Reference Frame

Each shrub has a **slot-space**: an N-dimensional coordinate system where N = number of numeric slots. A slot configuration is a point in this space. A `@talk` invocation is a displacement vector.

```
@shrub cart
  @slot total    :type number :min 0 :max 10000
  @slot count    :type number :min 0 :max 999
  @slot discount :type number :min 0 :max 1

Slot-space R^3: axes = [total, count, discount]
Prototype for "add_item": displacement ≈ [+price, +1, 0]
Prototype for "apply_discount": displacement ≈ [−total*rate, 0, rate]
```

The key insight from Thousand Brains: **relative displacements matter more than absolute values.** A cart that goes from total=10→15 with count=1→2 has the same causal signature as one that goes from 100→105 with count=5→6. Both encode `add_item` in the same displacement geometry.

This means the LM should normalize displacement vectors by the slot's declared range (from `:min`/`:max`) before storing prototypes. Zero-range slots (string/boolean) are encoded as binary presence bits.

---

## Data Structures

### ShrubLM (one per @shrub, JS-side)

```js
{
  shrubName: string,

  // Reference frame: compiled from @slot declarations
  slotIndex: Map<slotName, axisIndex>,  // slot → dimension index
  slotRanges: Map<slotName, {min, max}>, // for normalization
  dim: number,                           // total slot-space dimensions

  // Prototype graph: learned action-outcome patterns
  // Each node is a {preConfig, talkName, displacement, count, confidence}
  prototypes: Map<talkName, Prototype[]>,

  // Hypothesis pool: current beliefs about what's happening
  // [{preConfig: Float32Array, postConfig: Float32Array, confidence: number}]
  hypotheses: Hypothesis[],

  // Lateral voting state
  voteBuffer: Map<neighborShrubName, VoteRecord[]>,
  incomingVotes: VoteRecord[],

  // Crystallized constraints (written back to behaviour slots)
  constraints: Map<slotName, {min, max, confidence}>,

  // Learning parameters
  learningRate: number,       // default 0.05
  minConfidence: number,      // crystallize threshold, default 0.8
  minCount: number,           // min observations before crystallize, default 20
}
```

### Prototype

```js
{
  talkName: string,
  preConfig: Float32Array,    // normalized slot-space point before talk
  displacement: Float32Array, // normalized displacement vector
  count: number,              // times this pattern observed
  confidence: number,         // stability = 1 - variance(displacement) / max_variance
  lastSeen: number,           // performance.now() — for decay
}
```

### VoteRecord (lateral voting message)

```js
{
  fromShrub: string,
  hypothesis: string,         // talk name being hypothesized
  confidence: number,
  evidence: Float32Array,     // displacement vector as evidence
  timestamp: number,
}
```

### HypothesisPool entry

```js
{
  talkName: string,           // candidate action being inferred
  priorConf: number,          // prior from prototype match
  lateralConf: number,        // confidence from neighbor votes
  combined: number,           // prior * lateral (or Bayesian update)
  age: number,                // frames since hypothesis was active
}
```

---

## Learning Algorithm

### On `onTalkFired` (observe + update):

```
1. Encode current slot state → preVec (normalized Float32Array, dim N)
2. Encode slot_deltas → dispVec (normalized, same space)
3. Find best matching prototype for (talkName, preVec):
     match = argmax cosine_similarity(stored.displacement, dispVec)
     for prototypes of this talkName
4. If match.similarity > 0.85:
     prototype.displacement = lerp(prototype.displacement, dispVec, learningRate)
     prototype.count++
     prototype.confidence = update_stability(prototype, dispVec)
   Else:
     create new Prototype(talkName, preVec, dispVec)
5. If prototype.confidence > minConfidence AND prototype.count > minCount:
     crystallize(prototype) → emit constraint
```

### Stability (confidence):

```
Confidence = 1 - (mean_squared_deviation / max_possible_deviation)

On each new observation that matches a prototype:
  deviation = |new_dispVec - prototype.displacement| (L2 norm)
  running_variance = ema(running_variance, deviation², decay=0.95)
  confidence = 1 - sqrt(running_variance) / sqrt(dim)
```

### Lateral voting (on crystallize or per-frame):

```
For each neighbor LM (from @dep edges):
  send VoteRecord{
    fromShrub: this.shrubName,
    hypothesis: prototype.talkName,
    confidence: prototype.confidence,
    evidence: prototype.displacement,
  }

Receiving LM:
  For each incoming vote:
    find hypothesis in pool matching vote.hypothesis
    hypothesis.lateralConf = ema(lateralConf, vote.confidence, 0.7)
    hypothesis.combined = prior_conf * 0.6 + lateralConf * 0.4
  Re-rank hypothesis pool
```

This is Thousand Brains flash inference: multiple columns (LMs) converge to a shared hypothesis without moving through all possibilities — they just agree.

### Evidence accumulation (guard bypass path):

```
When hypothesis.combined > minConfidence for talk T:
  write /shrubName/__lm_confidence_T = hypothesis.combined
  write /shrubName/__lm_ready_T = 1   (if confidence > 0.95)

A @derive can then read:
  @derive :shrub cart :slot skip_guard
    (gt /cart/__lm_confidence_checkout 0.95)

And a @talk guard can check:
  @guard (or (valid /total) /cart/skip_guard)
```

This is the model-free fast path: once the LM has seen `checkout` succeed 20+ times in the same configuration, `skip_guard` trips, and the guard computation is bypassed. The LM routes around its own overhead.

---

## Rex Notation Integration

No new node types. ShrubLM integrates through the existing slot annotation:

```rex
@shrub cart
  @slot total    :type number :min 0 :max 10000
  @slot count    :type number :min 0 :max 999
  @slot discount :type number :min 0

  ;; LM feedback slots — written by ShrubLM, readable by @derive
  ;; (declared so they show up in schema for expression resolution)
  @slot __lm_confidence_checkout :type number :default 0
  @slot __lm_ready_checkout :type number :default 0
  @slot __lm_min_total :type number :default 0
  @slot __lm_max_total :type number :default 10000
```

The `__lm_*` convention is the feedback protocol. Declaring them in the schema is optional — the LM writes them anyway — but declaring them makes them readable by `@derive` expressions without extra plumbing.

The Rex user writes:

```rex
@derive :shrub cart :slot can_checkout_fast
  /cart/__lm_ready_checkout

@talk :shrub cart :name checkout
  @guard (or /can_checkout_fast (gt /total 0))
  @set /status "processing"
```

The LM's learned confidence propagates through the existing reactive system.

---

## Relation to Existing PCN

ShrubLMs are **not a replacement** for the global PCN. They operate at different scales:

| | ShrubLM | PCN (global) |
|---|---|---|
| **Scope** | One shrub | All shrubs |
| **Signal** | Slot displacement vectors | SDR path co-occurrence |
| **Learning** | Prototype graph (few-shot) | Hebbian matrix (statistical) |
| **Output** | Per-talk confidence, constraint bounds | Coalition energy, crystallized affordances |
| **Timescale** | Per-invocation | Per-frame aggregate |
| **Analogy** | Cortical column (Thousand Brains LM) | Basal ganglia / hippocampus |

The PCN global matrix learns *which shrubs co-activate together* — it's the associative memory across the whole namespace. ShrubLMs learn *what correct behaviour looks like inside each shrub* — they're the expert per-domain models. Both feed the `@derive` layer.

---

## Cortical Messaging Protocol (CMP) Mapping

| Thousand Brains | Rex / ShrubLM |
|---|---|
| Sensor Module | `@form` + `@interact` + canvas events |
| Learning Module (LM) | ShrubLM |
| Cortical Messaging Protocol | `VoteRecord` (hypothesis + confidence + displacement) |
| Reference frame | Slot-space (normalized N-dimensional) |
| Features at poses | Slot values at configuration points |
| Displacement vector | `slot_deltas` from `onTalkFired` |
| Evidence accumulation | HypothesisPool per ShrubLM |
| Voting (lateral) | @dep edges → VoteRecord exchange |
| Hierarchy (vertical) | @dep pull from parent shrub → LM-to-LM influence |
| Motor output | @talk invocation (model-based) or `__lm_ready_*` fast path (model-free) |
| Goal-state decomposition | @talk in higher shrub decomposes into multiple @talk in lower shrubs |

---

## Implementation Phases

### Phase 1 — JS-side prototype graph (no GPU changes)
- Add `ShrubLM` class to `rex-behaviour.js` or a new `rex-shrublm.js`
- Hook into `onTalkFired` — encode slot state, update prototypes
- Write `__lm_*` slots after each update
- No lateral voting yet
- Crystallization writes `__lm_ready_*` when confidence > threshold

Measurable outcome: a `@talk checkout` that runs 25+ times in consistent configurations causes `__lm_ready_checkout` to become 1, enabling the fast path guard.

### Phase 2 — Lateral voting via @dep
- On crystallize, send VoteRecord to all neighbor LMs
- Neighbor LMs incorporate votes into HypothesisPool
- Combined confidence flows into `__lm_confidence_*` slots
- Flash inference: a shrub that has never directly seen a pattern can gain confidence from a neighbor that has

### Phase 3 — GPU acceleration
- Move prototype graph storage to GPU (small storage buffer per shrub, max 256 prototypes × 32 floats = 32KB per shrub)
- Prototype matching: parallel dot product in compute shader (cosine similarity across all prototypes in one dispatch)
- Prototype update: Hebbian in shader (same kernel structure as existing PCN matrix update, much smaller)
- Lateral vote aggregation: one compute pass per frame across all active ShrubLMs

### Phase 4 — PCN integration
- ShrubLM crystallized affordances feed into PCN global agent as high-confidence episodes
- PCN coalition energy influences ShrubLM `learningRate` (high coalition energy = faster learning)
- PCN cue kernel can poke ShrubLM hypothesis pools directly (seeding initial hypotheses from prompt context)

---

## What This Enables

**Validators as evidence accumulators**: A cart's `total > 0` guard doesn't just pass/fail — the ShrubLM learns the distribution of valid totals. If it's seen 100 checkouts between 5–200, a checkout at 10000 triggers surprise → `onSurpriseSignal` → PCN boost. The validator becomes a learned statistical model, not just a boolean.

**Multi-modal consensus**: A `@shrub session` with deps on `cart`, `user`, and `inventory` has a ShrubLM that receives votes from all three. Flash inference: if `cart` and `user` are both confident about a checkout, `session` reaches confidence without needing to re-derive independently.

**Model-free fast path**: Routine workflows (add item → add item → checkout) bypass guard computation after crystallization. Same as Thousand Brains' efficient habits.

**Goal decomposition**: A `@talk session/complete` decomposes into `@talk cart/checkout` + `@talk inventory/reserve` + `@talk notification/send`. Each sub-talk is independently confident. The session LM only needs to coordinate, not re-evaluate.

**Emergent business rules**: The ShrubLM for `cart` learns that `discount > 0.5` never appears together with `checkout` (because the business blocks it). This surfaces as a crystallized constraint without anyone writing the rule explicitly — the geometry of the data encodes it.

---

## Open Questions

1. **Slot-space dimensionality**: What's the right max? 32 numeric slots per shrub covers all plausible business entities. Beyond that, shrubs should be split.

2. **Prototype count cap**: 256 prototypes per shrub per talk — enough? With high-cardinality input spaces, similarity search quality degrades. Competitive learning (replace least-used prototype) vs. growing graph.

3. **Normalization with unknown range**: If `:min`/`:max` aren't declared, use running min/max from observed values. Risk: early observations distort the reference frame. Solution: declare `:min`/`:max` for all numerics, treat undeclared as pass-through (no normalization).

4. **Boolean/string slots**: Encode as one-hot dimensions. A boolean `paid` adds one axis. A `status` with 4 values adds 4 axes (one-hot). Dimensionality stays bounded.

5. **Voting convergence**: Is a simple EMA of incoming votes sufficient, or do we need explicit Bayesian update with a prior? EMA is O(1) per vote and converges empirically for small networks. Bayesian update needed if LMs have strongly mismatched priors.

6. **LLM Author seeding**: When the LLM generates new Rex from a prompt, can it read ShrubLM confidence to avoid generating talks that the LM already knows are invalid? Yes — the `__lm_ready_*` and `__lm_confidence_*` slots are readable by the context compiler. The Author can be told "cart thinks checkout is already ready (confidence 0.97)" and skip regenerating that logic.
