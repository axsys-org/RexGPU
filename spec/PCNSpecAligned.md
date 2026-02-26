# Predictive Coding Namespace — Specification v4

**A reactive namespace with a continuously-learning predictive coding engine that grows a living connectome of behavioral patterns, recalled through pattern completion and surfaced as executable affordances — feeding a stateless LLM Author only when novel structure is needed.**

---

## The System in One Sentence

Events flow through a reactive namespace, a CUDA engine learns patterns from those events and grows a connectome of belief agents, and when the user wants something a cue fires through the connectome's own wiring to recall the right patterns as executable actions — no query, no search, the topology IS the intelligence.

---

## The Two Loops

### A) Continuous Learning Loop (slow "development")

```
USER EVENTS from real namespace
  → PCN 6-layer CUDA kernel (transitions, co-activation, sequences, regimes, etc.)
  → crystallization triggers
  → materialize / update / prune belief agents + connectome edges
  → (local LLM) name/describe agent once at birth
  → embed(agent_text) → store agent embedding
  → agent participates in connectome immediately
```

The PCN controls what exists and how it's wired. The connectome is grounded in actual behavior.

### B) Prompt / Right-Click Loop (fast "thought")

```
PROMPT or RIGHT-CLICK
  → (optional) local LLM: embed(prompt + chat history + locality)
  → CUDA cue kernel: similarity(prompt_embedding, agent_embeddings)
  → initial energies poked into agent shrubs
  → namespace reactive propagation (deps, gates, excitation/inhibition)
  → coalition settles naturally as energy dissipates
  → read affordances + human text from active agents
  → if direct affordances: execute immediately (poke talks, no LLM)
  → if generative needed: seed LLM Author with coalition context
```

The LLM does not "figure it out." It provides geometry (embedding) at the start and executes chosen affordances at the end. The connectome does the thinking.

---

## The Stack

```
USER NAMESPACE (the world)
  ↕ actions / surfaces / events
BELIEF OVERLAY (invisible connectome, same NS primitives)
  ↕ reactive deps / energy propagation
CUDA ENGINES
  ├── PCN kernel: learns from events, grows/prunes connectome
  └── Cue kernel: fires embeddings against all agents in parallel
CONTEXT COMPILER
  ↑ reads human text + affordances from active coalition
LLM AUTHOR (stateless, replaceable)
  ↑ ~80-120 token context from coalition
  ↓ generates namespace structure (shrub XML)
SHRINE (Rex parser → Shrub tree, path resolution, expressions)
  ↑ Shrub data model (slots, kids, deps, talks, derives)
PLAN SUBSTRATE (nouns, Laws, pins, event log)
```

Shrine parses Rex into a tree of Shrubs — the universal node type with slots (typed state), kids (recursive children), deps (reactive subscriptions), talks (named mutation entry points), and derives (computed values). PLAN provides the evaluation substrate — event log entries are pins, Laws (closures with name, arity, and body) define computation over Shrub state. Shrine owns the Shrub → PLAN encoding; PCN operates on Shrubs through Shrine's interface, never on raw PLAN nouns. See Part 24 for full PLAN alignment notes.

Both the RPE (rendering) and PCN (prediction) compile Shrine paths over the same Shrub tree. RPE compiles to buffer optics (path → byte offset). PCN compiles to SDR bit vectors (path → sparse distributed representation). Same Shrubs, same path resolution, two projections.

---

## Part 1: The Namespace

A reactive namespace where shrubs are pure behavior and state. No fixed UI — projections are congrescent (table, chart, kanban, feed, anything). The namespace IS the workspace. Every action, click, edit, highlight, projection choice, navigation = event. Everything is observable.

Shrubs have:
- **Slots**: typed fields (state)
- **Kids**: dynamic collections (data)
- **Deps**: reactive subscriptions (wiring)
- **Talks**: named entry points for mutation (actions)
- **Derives**: computed values (formulas)

When a dep fires, dependents react. This reactive propagation is the foundation that everything else builds on.

---

## Part 2: Episodes

Every namespace event is an immutable record.

```
episode:
  id:         @ud
  timestamp:  @da
  source:     ?(%user-action %prompt %prompt-outcome %author-edit
               %dep %code-change %affordance-exec %render-input)
  shrub:      cord
  mode:       ?(%add %dif %del)
  path:       pith
  talk:       (unit cord)
  inputs:     (unit (map cord noun))
```

Prompt events included: what was asked, what was generated, what was edited/accepted/rejected. Affordance executions are events too — the PCN sees which affordances get used and which get ignored. `%render-input` covers RPE `@interact` events (drag, scroll, pointer → form state → heap write) when the RPE event bridge is built (see Part 17: Future).

Append-only. O(1) per event. Streamed to GPU ring buffer.

---

## Part 3: Natural Timescale

Every shrub discovers its own heartbeat.

```
median_interval       = median of consecutive episode gaps
observation_multiplier = 100   (the ONLY free parameter)
natural_period        = median_interval × 100
half_life             = clamp(natural_period, min=~h1, max=~d365)
consolidation_window  = half_life × 3
```

Smoothed adaptation every natural_period: α=0.15, clamp ±25% change.

---

## Part 4: CUDA Engine

Two kernels sharing GPU memory. PCN does learning. Cue kernel does recall ignition.

### SDR Encoding

Path distance encodes directly into bit overlap:

```
SDR(path) = ⊕ [ hash(segment, depth) for segment in path ]

/dashboard/metrics/users   → bits {47, 203, 891, 1044, ...}
/dashboard/metrics/revenue → bits {47, 203, 602, 1033, ...}
                                   ─────────
                                   shared prefix = shared bits

similarity(A, B) = |A ∩ B| / |A ∪ B|
```

2048 bits, ~50 active per SDR. Similar paths have overlapping bits. Path distance IS bit distance.

### Module-Scoped SDR Bits

Path-only SDR encoding breaks reusability. Two instances of `sortable-table` mounted at `/trading/watchlist` and `/portfolio/holdings` hash to different bit vectors — the matrix learns local patterns that don't transfer between instances. The fix: decompose the SDR into three independently hashed components.

```
SDR(event) = module_bits ∪ path_bits ∪ action_bits

module_bits = hash(module_identity) → ~15 fixed bits
path_bits   = hash(mount_path)      → ~20 location bits
action_bits = hash(action_type)     → ~15 operation bits

sortable-table/sort @ /trading/watchlist:
  {module: 47,182,391,744,1023} ∪ {path: 88,205,613} ∪ {action: 156,890}

sortable-table/sort @ /portfolio/holdings:
  {module: 47,182,391,744,1023} ∪ {path: 331,507,819} ∪ {action: 156,890}

Overlap: module + action bits shared → matrix learns transferable patterns
Difference: path bits diverge → matrix preserves local context
```

Events from the same module at different mount points share module-identity bits. Events with the same action type share action bits. Events at the same location share path bits. The matrix learns through all three channels simultaneously.

This decomposition has a precise categorical analog. In profunctor optics (Clarke, Elkins, Gibbons, Loregian, Milewski, Pillmore, Román 2024), an optic decomposes a data structure into **focus** (what you're operating on) and **residual** (the context around it), with the residual existentially quantified away via a coend:

```
Optic((A,B),(S,T)) := ∫^M C(S, M⊗A) ⊗ D(M⊗B, T)
```

The coend quotients over the residual M — optics compose regardless of which specific context they were applied in. The focus and the Tambara constraint (which structural shapes are preserved) carry across compositions; the residual does not.

The SDR decomposition maps directly:

```
module_bits = Tambara constraint  (what structural shape is preserved)
action_bits = focus               (what operation is being performed)
path_bits   = residual            (where in the structure — quantified away for transfer)
```

When the matrix learns `M[sdr_a, sdr_b]`, the shared module+action bits create implicit identification between events at different mount points — the same "quantifying away" that the coend performs. The matrix's Hebbian update on shared bits IS the coend: it learns the invariant pattern (module behavior) while the variant part (mount location) washes out through averaging across instances.

For events without a module (raw namespace events), the SDR falls back to path-only encoding. Module bits are zero; all 50 active bits come from path+action hashing. This preserves backward compatibility — the module decomposition is additive.

For agents spawned by modules, the module-identity hash is derived from the module's content-addressed pin hash (see Part 24: PLAN Runtime Alignment). Same module source → same module bits, regardless of who installed it or when.

### Memory Matrix

```c
float M[2048][2048];  // ~16MB, fits in L2 cache

predict:   y = M · x
error:     e = |y - observed|
update:    M += α × outer(x, observed) × (1 + β × e)
```

Surprise-modulated Hebbian learning. Large error → larger update. All via cuBLAS SGEMM, ~0.1ms per event.

### Six Layers as Matrix Projections

```
L1  frequency       diag(M)
L2  transitions     M[sdr_t-1, sdr_t]
L3  co-activation   M ∧ M.T
L4  sequences       M^n
L5  regime          context_sdr ⊗ M
L6  cross-shrub     sdr_A · M · sdr_B
```

One matrix. Six read patterns. No separate cell pools.

### Cue Kernel

Fires prompt embeddings against all agent embeddings in parallel. This is the ignition step.

```c
__global__ void cue_kernel(
    float*   cue_embedding,       // from LLM, 384 floats
    float*   agent_embeddings,    // n_agents × 384 floats
    float*   initial_energies,    // output per agent
    int      n_agents,
    int      embed_dim
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n_agents) return;

    float sim = 0.0f;
    for (int d = 0; d < embed_dim; d++) {
        sim += cue_embedding[d] * agent_embeddings[i * embed_dim + d];
    }

    initial_energies[i] = fmaxf(0.0f, sim);
}
```

10,000 agents × 384 dimensions. <0.01ms. Pure dot products.

### Propagation Kernel

After the cue kernel ignites initial agents, the propagation kernel spreads energy through the connection graph. CUDA reads the topology from the registry (which agents connect to which, with what gates/weights/signs) and does ALL the activation math. Agent shrubs are never touched.

```c
__global__ void propagation_kernel(
    float*      energies,         // current energy per agent (CUDA-side)
    Connection* connections,      // from registry: {from, to, gate, weight, sign}
    uint32_t    n_connections,
    float*      energy_deltas     // output: changes to apply
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n_connections) return;

    Connection c = connections[i];
    float source_energy = energies[c.from];

    if (source_energy <= c.gate) return;  // gated out

    float transmitted = (source_energy - c.gate) * c.weight * c.sign;
    atomicAdd(&energy_deltas[c.to], transmitted);
}
```

2-3 iterations, <0.05ms total. Then top-K sparsification: sort by energy, keep top 8-32, zero the rest. Coalition is a small list of CUDA indices returned to hoon.

The smartness is in the embeddings (produced by LLMs) and the topology (built by the PCN). The kernels are simple parallel operations. The connection graph is the intelligence.

### Crystallization

Patterns crystallize when PREDICTABLE, not when FREQUENT.

```
crystallized when:
  M[pattern_sdr, pattern_sdr] > 0.8
  AND activation_count > 20  (tracked in hoon)
  AND min_age > natural_period × 2
```

Strong patterns have high self-correlation. Weak patterns decay via natural interference. No explicit decay sweeps.

### Signals

```
CRYSTALLIZE:  strength crossed threshold upward → spawn belief agent
SUGGEST:      strength stable for consolidation_window → propose to user
REFLECT:      strength dropped → weaken/modify agent
AUTOMATE:     strength stable AND hoon confirms history → promote affordance
```

### Replay

Matrix is volatile. Rebuilt from event log on restart.

```
M = zeros(2048, 2048)
for event in event_log:
  pcn_update(M, event.sdr_in, event.sdr_obs, α)
```

Deterministic. Reproducible. ~10 minutes for 1M events.

---

## Part 5: The Connectome (Belief Overlay Namespace)

### Core Principle: Topology IS Intelligence

The connectome is an invisible namespace overlay composed of belief agents. Agents are shrubs — same primitives as the user namespace (slots, kids, deps). But their state is activation and affordances, not user data. The user never sees them. The system reads them at interaction time.

Intelligence is not in weights or parameters. It is in the WIRING — which agents connect to which, through what gates, with what strengths. The pattern of connections determines what the system recalls, suggests, and does.

```
SAME AGENTS + DIFFERENT CONNECTOME = DIFFERENT USER EXPERIENCE
```

### Why a Connectome, Not a Matrix Query

The matrix M[2048][2048] is the fast learning layer. It discovers patterns from raw events. But it can't find relationships BETWEEN patterns. It can see that pattern A exists and pattern B exists. It can't see that A causes B, or that A and B together form a larger behavior.

That requires patterns to talk to each other. Which requires them to be discrete agents with explicit connections. The connectome is where statistical confidence becomes structural topology.

```
MATRIX:    discovers patterns         (hippocampus — fast, statistical)
CONNECTOME: embodies relationships    (cortex — slow, structural)
```

The matrix drops out of the read path at runtime. It is write-only (learning). All recall happens through the connectome via namespace reactive propagation.

### Agent Structure

Belief agents are dumb shrubs. They hold data. They have deps. They do NOTHING.

No energy computation. No gating logic. No propagation behavior. The agent shrub is a node in a graph. The graph's shape — which deps exist, what weights they carry — IS the intelligence. CUDA does all activation math. The namespace dep cascade tells CUDA what's connected to what. The shrub just sits there being a node.

```
/~belief/agents/earnings-week-mode

  :: CUDA BINDING
  /cuda-slot:     247          :: pointer into CUDA agent arrays
                                :: embeddings, energy, gates, weights — all CUDA-side
                                :: this is the ONLY bridge between NS and GPU

  :: IDENTITY (human/LLM readable — read after activation to build context)
  /name:          "earnings week mode"
  /description:   "intensive monitoring: increase news refresh,
                   review all positions, check greeks twice daily,
                   tighten stop losses"
  /context:       "activates quarterly during earnings season,
                   typically 2 weeks, user runs this 8am weekdays"
  /avoid:         "don't auto-sort watchlist, don't collapse columns"

  :: AFFORDANCES (executable actions — read after activation to build menu)
  /affordances: [
    {type: %compose, label: "Start earnings prep", steps: [
      {type: %navigate, target: /research/news}
      {type: %project,  target: /research/news, projection: %feed}
      {type: %talk,     shrub: "news-feed", talk: "filter-source",
                        inputs: {source: "watchlist"}}
      {type: %talk,     shrub: "news-feed", talk: "set-refresh",
                        inputs: {interval: "~m5"}}
      {type: %navigate, target: /trading/options}
      {type: %project,  target: /trading/options, projection: %chain}
      {type: %talk,     shrub: "greeks", talk: "set-view",
                        inputs: {mode: "table"}}
    ]}
  ]

  :: LIFECYCLE (PCN writes these, nothing reads them at activation time)
  /confidence:     0.84
  /energy-pool:    45.0        :: long-term vitality (PCN managed)
  /state:          %alive      :: alive | dormant | retired
  /born:           ~2025.2.1
  /last-confirmed: ~2025.3.14

  :: WIRING (deps — this IS the connectome topology)
  :: these deps exist so the NS knows the graph structure
  :: CUDA reads the graph structure via the registry
  :: the dep relationships + their CUDA-side weights/gates = intelligence
  deps: [
    :: agent → user shrub (locality pathway)
    /trading/watchlist
    /trading/options

    :: agent → agent (connectome edge)
    /~belief/agents/morning-trade-prep
    /~belief/agents/position-sizing

    :: agent → parent agent (composition edge)
    /~belief/agents/full-trading-workflow
  ]
```

The agent shrub is a DATA NODE. It carries:
- A pointer to its CUDA twin (where embeddings, energy, weights, gates live)
- Human-readable text (read after activation to build LLM context)
- Affordances (read after activation to build menu)
- Lifecycle state (PCN reads/writes for housekeeping)
- Deps (the graph edges — the topology that IS the intelligence)

What lives where:

```
AGENT SHRUB (namespace):          CUDA (agent arrays):
  /cuda-slot → index ──────────►  agent_embeddings[index]  (384 floats)
  /name, /description              agent_energy[index]      (current activation)
  /context, /avoid                 agent_gates[index][32]   (per-connection gates)
  /affordances                     agent_weights[index][32] (per-connection weights)
  /confidence, /energy-pool        agent_signs[index][32]   (excite/inhibit per conn)
  /state, /born, /last-confirmed   agent_confidence[index]
  deps: [list of paths]            agent_state[index]

NS holds: identity, affordances, lifecycle, topology (deps)
CUDA holds: embeddings, activation energy, connection dynamics (gates/weights/signs)

the shrub doesn't know its own energy
the shrub doesn't know its own gates
the shrub doesn't compute anything
CUDA knows all of that, indexed by cuda-slot
```

Why this split: CUDA needs embeddings + energy + gates for parallel operations (cue kernel, propagation kernel). The shrub needs identity + affordances for post-activation readout. They share topology via the registry. Neither duplicates the other's data.

### How Activation Actually Works

The agent shrub doesn't participate in activation at all. Here's what happens:

```
STEP 1: CUE (CUDA)
  cue kernel fires: dot(prompt_embedding, agent_embeddings[i]) for all i
  result: initial energy per agent in CUDA memory
  the agent shrubs are NOT TOUCHED

STEP 2: PROPAGATION (CUDA)
  CUDA reads the connection topology from the registry
  (which agents connect to which, with what gates/weights/signs)
  propagates energy through connections:
    for each connection:
      if source_energy > gate: target_energy += (source - gate) × weight × sign
  repeats 2-3 times until settled
  ALL in CUDA memory. Agent shrubs STILL NOT TOUCHED.

STEP 3: READ COALITION (hoon)
  CUDA returns: list of (cuda-slot, energy) where energy > threshold
  hoon maps cuda-slot → agent shrub path via registry
  hoon reads /name, /description, /avoid, /affordances from those shrubs
  FIRST TIME the agent shrubs are touched — just to READ their text/affordances

STEP 4: BUILD MENU or CONTEXT
  affordances → right-click menu items
  text → LLM Author context (if needed)
```

The agent shrubs are READ-ONLY during activation. CUDA does ALL the math. The shrubs just carry the payload that gets delivered after CUDA decides what's active.

This is like a filing cabinet. CUDA decides which drawers to open. The files inside the drawers (identity, affordances) are just sitting there waiting to be read. The files don't decide whether they get read. The topology + CUDA decides.

### Three Kinds of Edges

```
AGENT → USER SHRUB:     "I care about this part of the workspace" (locality)
AGENT → AGENT:          "I'm related to this other pattern" (association)
AGENT → HIGHER AGENT:   "I'm a component of this larger behavior" (composition)
```

All are namespace deps. Same primitive. Same reactive propagation.

### Edge Types

PCN creates three kinds of connections:

```
EXCITATORY (positive weight):
  consistent co-activation or sequence adjacency
  "these patterns reinforce each other"

INHIBITORY (negative weight):
  mutually exclusive outcomes, user rejects one when other is active
  "these patterns compete"

PARENT (composition):
  repeated co-firing clusters → abstract "mode" agent
  "these patterns form a larger behavior together"
```

Rule: excitatory from co-activation and sequences. Inhibitory from negative evidence and contradictions. Parent formation from sustained co-firing clusters.

### Connectome Layers

```
FIRST ORDER (crystallized from PCN):
  individual patterns: "user checks news before trading"
  deps on user shrubs (locality)
  deps on keyword/regime nodes (semantic/temporal cues)

SECOND ORDER (emerged from agent co-activation):
  pattern compositions: "morning trade prep = news + options + greeks"
  deps on first-order agents

THIRD ORDER (rare, abstract):
  behavioral modes: "earnings week mode"
  deps on second-order agents
  represents regime shifts, not individual actions

HIGHER ORDERS:
  theoretically unbounded
  in practice 3-4 layers before patterns get too abstract
  natural decay kills anything that doesn't get reinforced
```

### Growth and Pruning

The PCN is the gardener. The connectome is the garden.

```
ADD (crystallization):
  PCN detects reliable pattern (low error sustained)
  → spawn agent shrub in overlay namespace
  → LLM namer generates description + tags (once, ~10 tokens)
  → embed description → store as /embedding
  → connect to source user shrubs via deps
  → connect to related agents via deps
  → agent participates in recall immediately

MODIFY (strengthen):
  PCN sees pattern confirmed (prediction correct, user accepts)
  → energy-pool += 5
  → confidence increases
  → gates between co-active agents lower (easier to fire together)
  → connection weights strengthen

MODIFY (weaken):
  PCN sees pattern contradicted (prediction wrong, user rejects)
  → confidence -= 20 (asymmetric: wrong beliefs die fast)
  → energy-pool drops
  → gates raise (harder to fire)
  → connection weights weaken

REMOVE (pruning):
  energy-pool depleted over time without confirmation
  → alive → dormant (energy-pool < 10)
  → dormant → retired (energy-pool < 0)
  → retired → pruned (deps dissolved, shrub removed)
  → as if it never existed
  → if pattern returns, PCN rediscovers it fresh
```

### Housekeeping: The Immune System

Runs every `natural_period` per shrub. The gardener pulls weeds.

```
ENERGY DECAY (every natural_period):
  for each alive agent:
    if not confirmed this period: energy-pool -= 0.5
    this is the heartbeat. unconfirmed agents slowly die.

CONFIRMATION AUDIT:
  for each alive agent:
    if not confirmed in 3 natural_periods → force DORMANT
    lukewarm agents don't get to linger indefinitely

SILENT HUB DETECTION:
  for each alive agent with connection_count > 10:
    participation_rate = times_in_coalition / total_cue_events_this_period
    confirmation_rate  = confirmations / times_in_coalition

    if participation_rate > 0.4 AND confirmation_rate < 0.1:
      → SUSPECT: appears in many coalitions, rarely useful
      → raise all gates × 2.0, lower all weights × 0.5
      → if still suspect after 2 natural_periods → force DORMANT

    if connection_count > 20 AND confirmation_rate < 0.2:
      → OVERCONNECTED: too many deps for its usefulness
      → prune weakest 50% of connections (lowest weight × gate product)
      → continue monitoring

CONNECTION CAP ENFORCEMENT:
  for each agent:
    if connection_count > 32:
      → prune weakest connections down to 32
      → this prevents hub accumulation before it becomes a problem

ORPHAN CLEANUP:
  registry audit: any CUDA slot without matching shrub → free slot
  any shrub without valid CUDA slot → rebuild or remove
```

The critical insight: **the old spec's cells were independent — a bad cell only hurt its own locality.** The connectome's agents are *wired together* — a bad agent can distort coalitions it didn't originate from via propagation. The silent hub check catches agents that are structurally important (high connectivity, frequent participation) but functionally useless (low confirmation). These are the connectome equivalent of a slow memory leak.

The three-step defense:
1. **Energy decay** catches agents nobody confirms (slow death)
2. **Confirmation audit** catches agents that linger on minimal reinforcement (forced dormancy)
3. **Silent hub detection** catches agents that survive by riding other agents' coalitions (active intervention)

### Hebbian Wiring at the Agent Level

The matrix does Hebbian learning on raw events. The connectome does Hebbian learning on agents. Two levels of the same principle.

```
agents that fire together wire together:

  PCN notices agents A and B consistently co-activate
  → create excitatory dep between them (or strengthen existing)
  → lower gate on the connection

agents that compete wire apart:

  PCN notices agent A active when user rejects agent B's affordance
  → create inhibitory dep between them
  → or if they were excitatory, flip to inhibitory

sustained co-firing clusters form parents:

  agents A, B, C consistently activate together
  → PCN spawns higher-order agent D
  → D has deps on A, B, C
  → D represents the composite behavior
```

### CUDA ↔ Namespace Synchronization

The connectome lives in two places. The agent shrub in hoon namespace holds identity, affordances, lifecycle state, and a pointer to CUDA. The CUDA agent arrays hold embeddings, activation energy, and connection dynamics (gates, weights, signs). The `/cuda-slot` on the shrub and the registry bridge between them.

#### The Two-Sided Agent

```
HOON SIDE (namespace shrub):              CUDA SIDE (agent arrays):
  /~belief/agents/earnings-week-mode        index 247 into:
  /cuda-slot: 247  ──────────────────────►  agent_embeddings[247]   384 floats
                                            agent_energy[247]       current activation
                                            agent_gates[247][32]    per-connection gates
                                            agent_weights[247][32]  per-connection weights
                                            agent_signs[247][32]    per-connection signs
                                            agent_confidence[247]   from PCN
                                            agent_state[247]        alive/dormant/retired
  /name: "earnings week mode"               (not in CUDA)
  /description: "intensive..."              (not in CUDA)
  /context: "activates quarterly..."        (not in CUDA)
  /avoid: "don't auto-sort..."             (not in CUDA)
  /affordances: [...]                       (not in CUDA)
  /confidence: 0.84                         (mirrored in CUDA, PCN writes both)
  /energy-pool: 45.0                        (mirrored in CUDA, PCN writes both)
  /state: %alive                            (mirrored in CUDA, PCN writes both)
  deps: [...]                               (topology in registry, fed to CUDA)
```

CUDA owns: embeddings, activation energy, connection dynamics (gates, weights, signs). These are the hot data for parallel kernels. Hoon never reads or writes them directly.

Hoon owns: identity, affordances, lifecycle metadata. These are the cold data read after CUDA decides what's active. CUDA never reads them.

Shared via registry: topology (who connects to who). The registry provides connection lists that CUDA's propagation kernel reads. PCN writes lifecycle state to both sides when it confirms/contradicts/prunes.

#### The Registry

The bridge between both sides is a single registry maintained by hoon:

```hoon
+$  agent-registry
  $:
    :: bidirectional mapping
    by-id=(map @ud agent-entry)          :: cuda-slot → agent info
    by-path=(map pith @ud)               :: namespace path → cuda-slot
    next-slot=@ud                        :: next available CUDA index
    free-slots=(set @ud)                 :: recycled slots from dead agents
  ==

+$  agent-entry
  $:
    cuda-slot=@ud                        :: index into CUDA arrays
    ns-path=pith                         :: /~belief/agents/[name]
    agent-type=?(%first-order %second-order %third-order)
    parent=(unit @ud)                    :: cuda-slot of parent agent, if any
    children=(set @ud)                   :: cuda-slots of child agents
    user-shrub-deps=(set pith)           :: which user shrubs this agent watches
    agent-deps=(set @ud)                 :: cuda-slots of agent deps (connectome edges)
  ==
```

This registry is the SINGLE SOURCE OF TRUTH for the graph topology. It knows:
- every agent's CUDA slot and namespace path
- every agent → user shrub relationship
- every agent → agent relationship
- every agent → parent agent relationship
- every parent → children relationship

#### The Three Edge Types in the Registry

```
EDGE TYPE 1: agent → user shrub (locality)
  stored in: agent-entry.user-shrub-deps
  NS side:   dep from /~belief/agents/X to /trading/watchlist
  CUDA side: not stored (CUDA doesn't need topology for dot products)
  created:   at crystallization, from the shrubs that generated the pattern
  used by:   locality-only cues (right-click, no embedding needed)

EDGE TYPE 2: agent → agent (connectome)
  stored in: agent-entry.agent-deps
  NS side:   dep from /~belief/agents/X to /~belief/agents/Y
             with gate, weight, sign on X's slots for this dep
  CUDA side: mirrored in connection arrays (bridge maintains copy for propagation kernel)
  created:   by PCN Hebbian wiring (co-activation, sequence adjacency)
  used by:   energy propagation during settling (CUDA reads connection arrays, not namespace)

EDGE TYPE 3: agent → parent agent (composition)
  stored in: agent-entry.parent + parent-entry.children
  NS side:   dep from /~belief/agents/child to /~belief/agents/parent
  CUDA side: not stored
  created:   by PCN when sustained co-firing cluster detected
  used by:   cascade on death, affordance composition
```

#### Synchronization Protocol

Every mutation to the connectome goes through a single codepath that updates both sides atomically:

```
SPAWN AGENT:
  1. allocate cuda-slot (next-slot++ or pop from free-slots)
  2. create agent shrub at /~belief/agents/[name]
     set /cuda-slot to allocated index
  3. CUDA: write embedding to agent_embeddings[slot * 384]
     write metadata to agent_metadata[slot]
  4. register in agent-registry (by-id, by-path, edges)
  5. create NS deps (to user shrubs and other agents)
  ORDER: registry first, then NS deps — deps might fire immediately

MODIFY AGENT (confirm/contradict):
  1. update hoon slots: /confidence, /energy-pool, /gate, /weight
  2. CUDA: sync metadata fields via bridge
     agent_metadata[slot].confidence = new value
     agent_metadata[slot].gate = new value
  3. update registry edge weights if gates changed
  ORDER: hoon first (source of truth), CUDA follows

ADD EDGE (new dep):
  1. add dep in namespace (agent shrub subscribes to target)
  2. update registry: add to agent-deps or user-shrub-deps
  3. set gate/weight/sign on the agent's per-dep slots
  ORDER: registry and NS together, both must succeed

REMOVE EDGE (dep dissolved):
  1. remove dep in namespace
  2. update registry: remove from agent-deps or user-shrub-deps
  ORDER: registry and NS together

RE-EMBED AGENT (description changed):
  1. update /description, /context in hoon
  2. call LLM embedder on new text
  3. CUDA: overwrite agent_embeddings[slot * 384 .. (slot+1) * 384]
  ORDER: hoon text first, then embed, then CUDA write

KILL AGENT:
  1. set /state to %retired in hoon
  2. CUDA: zero out embedding, mark slot as dead
  3. fire dead signals to all dependents (namespace <dead> handlers)
  4. dependents react (cascade — see Death and Restructuring below)
  5. remove all NS deps (incoming and outgoing)
  6. remove agent shrub from namespace
  7. return cuda-slot to free-slots in registry
  8. remove from registry (by-id, by-path, all edge sets)
  ORDER: dead signals BEFORE cleanup — dependents need to react first
```

#### What Lives Where (Summary)

```
                         HOON (NS shrub)    CUDA (arrays)         REGISTRY
cuda-slot                ✓ (pointer)        ✓ (index)             ✓ (mapping)
embedding                ✗                  ✓ (384 floats)        ✗
energy (activation)      ✗                  ✓ (CUDA owns)         ✗
gates (per-connection)   ✗                  ✓ (CUDA owns)         ✗
weights (per-connection) ✗                  ✓ (CUDA owns)         ✗
signs (per-connection)   ✗                  ✓ (CUDA owns)         ✗
confidence               ✓ (slot)           ✓ (PCN writes both)   ✗
energy-pool (vitality)   ✓ (slot)           ✓ (PCN writes both)   ✗
state (alive/dead)       ✓ (slot)           ✓ (PCN writes both)   ✓
name, description        ✓ (slots)          ✗                     ✗
context, avoid           ✓ (slots)          ✗                     ✗
affordances              ✓ (slot)           ✗                     ✗
user-shrub deps          ✓ (NS deps)        ✗                     ✓ (set of paths)
agent-agent deps         ✓ (NS deps)        ✓ (connection list)   ✓ (set of slots)
parent/children          ✓ (NS deps)        ✗                     ✓ (unit/set)
```

Hoon owns: identity, affordances (cold data, read after activation).
CUDA owns: embeddings, activation energy, gates, weights, signs (hot data, used during activation).
Registry owns: topology (who connects to who, fed to CUDA propagation kernel).
PCN writes lifecycle state (confidence, energy-pool, state) to both sides.

The agent shrub is a dumb data node. It holds the payload (text, affordances) that gets read after CUDA decides it's active. The deps define the graph topology that the registry feeds to CUDA. Structure + propagation + energy gating = cognition. The shrub is just structure. CUDA does the rest.

### Bridge: Ring Buffers and IPC

Two shared-memory ring buffers. Opposite directions. No blocking either side.

```
URBIT ──events──► [INBOUND RING BUFFER] ──► GPU
URBIT ◄──signals── [OUTBOUND RING BUFFER] ◄── GPU
```

#### Inbound: Events to GPU

Every namespace event becomes a 32-byte wire format record:

```
EVENT WIRE FORMAT (32 bytes):
  shrub_hash:    @ud    4 bytes    hash of source shrub path
  entity_type:   @ud    2 bytes    what kind of thing
  path_hash:     @ud    4 bytes    hash of path within shrub
  mode:          @ud    1 byte     %add / %dif / %del
  timestamp:     @da    8 bytes    when
  source:        @ud    1 byte     %user-action / %author-edit / %prompt / etc.
  padding:              12 bytes   alignment + future use
```

Hoon serializes each episode into this format and writes to the ring buffer head. GPU reads from the tail at its own pace. Fixed size buffer (64K entries = 2MB). If GPU falls behind, oldest events drop — acceptable because the event log retains everything for replay. The ring buffer is for real-time flow, not persistence.

No syscalls. No IPC overhead. Just shared memory writes. Hoon writes, GPU reads. They never wait for each other.

#### The Rust Runtime Bridge

Hoon is pure — it stores state, computes functions, and emits effects. It never touches shared memory, ring buffers, or GPU directly. The Rust runtime catches hoon effects and handles all actual IO.

```
HOON:    emits effect ("new episode", "spawn agent", "kill agent")
RUST:    catches effect → serializes → writes to GPU ring buffer / calls CUDA
CUDA:    processes → writes signal to outbound ring buffer
RUST:    reads signal → injects into hoon as event
HOON:    receives event ("crystallize signal") → updates state → emits effects
```

This is the standard urbit architecture: hoon is a pure function from `(state, event) → (state, effects)`. The runtime (Rust, not hoon) is responsible for actually performing IO. PCN follows the same pattern — hoon manages agent Shrubs, the registry, and lifecycle state. Rust manages CUDA memory, ring buffer serialization, and embedding API calls. The boundary is effects outbound, events inbound. Hoon never imports a CUDA library. Rust never interprets namespace semantics.

#### Outbound: Signals to Hoon

GPU writes signals when it detects something noteworthy:

```
SIGNAL WIRE FORMAT (32 bytes):
  signal_type:   @ud    2 bytes    CRYSTALLIZE | SUGGEST | REFLECT | AUTOMATE
  cell_id:       @ud    4 bytes    which cell/layer triggered this
  shrub_hash:    @ud    4 bytes    which shrub it's about
  confidence:    @rs    4 bytes    how sure
  layer:         @ud    1 byte     which prediction layer
  metadata:             17 bytes   signal-type-specific data
```

Hoon reads the outbound buffer on its own tick and routes each signal:

```
CRYSTALLIZE → spawn agent shrub, call LLM namer, register, embed
SUGGEST     → queue suggestion entry for user
REFLECT     → queue diagnostic (pattern broke)
AUTOMATE    → queue promotion proposal

signals NEVER directly modify the namespace
they create queue entries for the gardener or the user
```

#### Topology Feed

The propagation kernel needs the connection graph in CUDA-readable form. The bridge maintains a CUDA-side mirror of the registry's topology:

```
CONNECTION ARRAYS (CUDA, mirrored from registry):
  connection_source[max_connections]   — source agent slot
  connection_target[max_connections]   — target agent slot
  connection_gate[max_connections]     — gate threshold
  connection_weight[max_connections]   — strength
  connection_sign[max_connections]     — +1 excitatory / -1 inhibitory
  num_connections                      — current count
```

Updated by the bridge whenever the registry changes (add/remove edge, modify gate/weight). The propagation kernel reads these arrays directly — no round-trip to hoon during settling.

#### Embedding Sync

When an agent is spawned or re-embedded:

```
1. LLM generates/updates description text (hoon-side)
2. Embedder model produces 384-float vector
3. Bridge writes to agent_embeddings[slot * 384 .. (slot+1) * 384]
4. Cue kernel sees it immediately on next firing
```

Batch re-embedding on model upgrade: walk all agent shrubs, re-embed descriptions, bulk write to CUDA. ~seconds for 10K agents.

### Death and Restructuring

When an agent dies, it doesn't just disappear. It tears a hole in the connectome that forces restructuring. Other agents have deps on the dying agent. Those deps break. That breakage IS restructuring.

#### Death Cascade

```
morning-trade-prep DIES (energy-pool < 0)
  │
  │ STEP 1: dead signals fire through namespace
  │
  ├── earnings-week-mode receives <dead> signal
  │     → lost a component agent
  │     → /energy-pool -= 10 (structural damage)
  │     → affordances that included morning-trade-prep's steps: DEGRADED
  │       mark affected steps as stale, lower affordance priority
  │     → if morning-trade-prep was primary component
  │       AND earnings-week-mode has no other strong components
  │       → earnings-week-mode may die too (cascade upward)
  │     │
  │     └── agents depending on earnings-week-mode
  │           → receive THEIR dead signals if it dies
  │           → cascade continues
  │
  ├── news-check receives <dead> signal
  │     → dep on morning-trade-prep dissolved
  │     → still alive (has other deps sustaining it)
  │     → activation pattern changes (different cue pathways now)
  │     → registry updated: remove edge
  │
  └── greeks-check receives <dead> signal
        → dep dissolved
        → still alive
        → will reconnect to whatever replaces morning-trade-prep
        → registry updated: remove edge

  STEP 2: cleanup
    → morning-trade-prep's NS deps removed
    → shrub removed from namespace
    → CUDA: embedding zeroed, slot marked dead
    → cuda-slot returned to free-slots
    → registry: entry removed, all edge references cleaned

  STEP 3: the wound heals
    → PCN is still watching the event stream
    → user's behavior didn't stop, they're doing something NEW
    → new pattern emerges from events
    → PCN crystallizes → new agent spawns
    → new agent connects to surviving agents (news-check, greeks-check)
    → registry gains new entry, new edges
    → connectome HEALS around the new reality
```

#### Affordance Degradation on Death

When an agent dies and was part of a `%compose` affordance on a parent agent:

```
PARENT AFFORDANCE BEFORE DEATH:
  {type: %compose, label: "Start earnings prep", steps: [
    {type: %navigate, target: /research/news}         ← valid (own pattern)
    {type: %talk, shrub: "news-feed", talk: "filter"} ← valid (own pattern)
    {type: %navigate, target: /trading/options}        ← FROM DEAD CHILD
    {type: %talk, shrub: "options", talk: "open"}      ← FROM DEAD CHILD
    {type: %project, target: /trading/greeks, %table}  ← FROM DEAD CHILD
  ]}

AFTER CHILD DEATH:
  steps 3-5 sourced from dead agent
  the USER SHRUBS they reference still exist (options, greeks)
  the PATTERN that connected them is dead

  resolution:
    mark steps as %unconfirmed
    affordance still shows in menu but at LOWER priority
    if user executes it and it works → PCN re-confirms → steps un-stale
    if user never executes it → affordance priority decays → eventually removed
    if user does something different → PCN learns new pattern → replaces steps
```

#### The Lifecycle (Complete)

```
BIRTH:      PCN crystallizes → agent spawns → CUDA slot allocated
            → registry entry created → NS deps connected
            → embedding stored → affordances extracted from event log

LIFE:       cues activate → energy propagates through deps
            → coalitions form → affordances execute
            → PCN confirms/contradicts → energy-pool adjusts

GROWTH:     confirmed repeatedly → energy-pool up → gates lower
            → new deps form (Hebbian) → registry gains edges
            → richer connectivity → easier to recall
            → sustained co-firing → parent agent spawns above

INJURY:     contradicted → confidence drops → gates raise
            → connections weaken → harder to activate
            → affordances may become less relevant

DEATH:      energy-pool depleted → %dormant → %retired
            → dead signals cascade through deps
            → dependents restructure (lose dep, affordances degrade)
            → CUDA slot freed → registry cleaned → shrub removed

HEALING:    surviving agents lose a pathway but stay alive
            → PCN watches user's new behavior
            → new pattern crystallizes → new agent fills the gap
            → reconnects to survivors → connectome heals

REBIRTH:    if old behavior returns → PCN rediscovers it
            → fresh agent, new CUDA slot, no baggage from old version
            → old connections not restored — rebuilt from new evidence
```

---

## Part 6: Energy Model and Pattern Completion

### Core Principle: No Query, No Search

The connectome doesn't answer questions. It doesn't search. A cue enters, signal propagates through the wiring the PCN built, the network settles into the nearest stored pattern, and that pattern IS the response. The topology is the algorithm. The wiring is the knowledge. The settling is the recall.

This is pattern completion — the same mechanism the brain uses for memory recall.

### Three Forces on Energy

```
FORCE 1: EXCITATION (external cue)
  CUDA cue kernel: dot(prompt_embedding, agent_embedding) for all agents
  initial energy injected into CUDA agent_energy array

FORCE 2: PROPAGATION (through topology)
  CUDA propagation kernel reads connection graph from registry
  for each connection: if source_energy > gate → push to target
  excitatory (positive weight) → target energy goes up
  inhibitory (negative weight) → target energy goes down
  ALL in CUDA memory. Agent shrubs not involved.

FORCE 3: DECAY (time)
  CUDA decays all energies toward zero continuously
  nothing is sustained without reinforcement
```

### Settling Dynamics: Explicit Attractor with Normalization

The critical design choice: how does the connectome settle into a coalition?

Three options exist. This system uses **(C) Explicit attractor dynamics with normalization** — fixed number of propagation steps with energy budget conservation after each step.

```
WHY NOT (A) SINGLE-PASS + TOP-K:
  fast, predictable
  but the topology barely matters — propagation doesn't have time to shape anything
  you built a connectome and then only read it one hop deep
  WASTES THE GRAPH

WHY NOT (B) MULTI-STEP UNTIL CONVERGENCE:
  lets the topology fully express itself
  but convergence is not guaranteed
  oscillation risk, unbounded latency, debugging nightmare
  UNSTABLE

WHY (C) EXPLICIT ATTRACTOR + NORMALIZATION:
  fixed steps (3-5), normalization constrains total energy
  inhibition + normalization = competition
  coalition SHARPENS each step rather than growing unboundedly
  bounded latency, guaranteed termination
  topology gets multiple hops to express itself but can't run away
  DISCIPLINED EMERGENCE
```

### How It Works

```
STEP 0: CUE INJECTION (CUDA, <0.01ms)

  RIGHT-CLICK (locality):
    registry lookup: which agents have deps on selected shrubs?
    inject energy directly into those CUDA agent indices
    NO embedding, NO dot products, NO LLM
    
  PROMPT (semantic):
    cue extractor LLM → embedding [384 floats]
    cue kernel: dot(embedding, all agent_embeddings)
    initial energies from similarity scores

  PROMPT AT REGION (mixed):
    cue kernel fires (semantic similarity)
    PLUS registry locality injection (agents connected to selected shrubs)
    both energy sources combine

  result: initial energies in CUDA agent_energy[]
  agent shrubs NOT TOUCHED


STEP 1: PROPAGATE (CUDA)

  for each connection where source_energy > gate:
    target_energy += (source_energy - gate) × weight × sign
  
  excitatory connections boost allies
  inhibitory connections suppress competitors


STEP 1.5: NORMALIZE (CUDA)

  total_energy = sum(all positive energies)
  each agent: energy = energy / total_energy × ENERGY_BUDGET
  
  total energy is CONSERVED — agents compete for fixed budget
  strong agents keep their share, weak agents get diluted
  nothing explodes, nothing accumulates unboundedly


STEP 2: PROPAGATE (CUDA)

  now normalized energies propagate
  agents boosted in step 1 push harder through connections
  agents suppressed push less
  inhibition sharpens the gap further


STEP 2.5: NORMALIZE (CUDA)

  budget redistributed again
  coalition getting sharper — winners pulling away from losers


STEP 3: PROPAGATE + NORMALIZE (CUDA, final round)

  third pass locks in the attractor
  energy distribution is now stable
  the coalition IS the topology's natural attractor for this cue


STEP 4: SPARSIFY (CUDA, <0.01ms)

  sort agents by energy
  keep top K (8-32)
  zero everything else
  coalition is a small set of CUDA indices


STEP 5: RETURN TO HOON

  CUDA sends: [(cuda-slot, energy), ...] for active agents
  hoon maps cuda-slot → namespace path via registry
  hoon reads /name, /description, /avoid, /affordances from agent shrubs
  THIS IS THE FIRST AND ONLY TIME agent shrubs are touched
  just reading their text slots, no computation


STEP 6: BUILD MENU or CONTEXT

  affordances from active agents → right-click menu
  text from active agents → LLM Author context (if needed)


AFTER: CUDA decays all energies back toward zero
  ready for next cue
```

Total CUDA time for steps 0-4: **<0.1ms.** Three propagation passes. Three normalizations. One sparsification. Fixed cost. Bounded. Deterministic. Debuggable.

### The CUDA Settling Kernel

```c
#define NUM_STEPS 3
#define ENERGY_BUDGET 10.0f
#define TOP_K 16

void settle_coalition(
    float* energies, Connection* conns, uint32_t n_conns,
    float* deltas, uint32_t n_agents
) {
    for (int step = 0; step < NUM_STEPS; step++) {
        // propagate through gated connections
        memset(deltas, 0, n_agents * sizeof(float));
        propagation_kernel<<<...>>>(energies, conns, n_conns, deltas);
        apply_deltas<<<...>>>(energies, deltas, n_agents);

        // normalize: conserve total energy budget
        float total = thrust::reduce(energies, energies + n_agents);
        if (total > 0.0f) {
            float scale = ENERGY_BUDGET / total;
            scale_kernel<<<...>>>(energies, scale, n_agents);
        }
    }

    // final sparsify: top-K winners, everything else zeroed
    top_k_sparsify<<<...>>>(energies, n_agents, TOP_K);
}
```

### Why Normalization Is the Key

Without normalization, energy is unbounded. Strong cues create strong activations which propagate to create stronger activations. That's option B — unbounded convergence.

With normalization, agents compete for a **fixed energy budget.** Each propagation step redistributes the budget based on the topology. After 3 steps, the budget has settled into the topology's natural attractors.

```
WITHOUT NORMALIZATION:
  step 0: agent A = 3.2, agent B = 1.4
  step 1: agent A = 5.8, agent B = 3.1   (both grew)
  step 2: agent A = 9.2, agent B = 5.4   (unbounded)

WITH NORMALIZATION (budget = 10.0):
  step 0: agent A = 3.2, agent B = 1.4  → normalize → A = 6.9, B = 3.1
  step 1: propagate → A = 8.1, B = 2.3  → normalize → A = 7.8, B = 2.2
  step 2: propagate → A = 8.4, B = 1.8  → normalize → A = 8.2, B = 1.8
  
  A won. B faded. The topology decided. In 3 steps.
```

Normalization makes it a **competitive process.** Agents don't accumulate energy — they compete for a fixed pool. The topology determines who wins. More connections to active agents = more energy after normalization = win. Fewer connections or inhibitory connections = less energy = lose.

### The Attractor Property

After 3 normalized propagation steps, the coalition IS an attractor of the connection graph. It's the stable state that the topology "wants" to be in given the initial cue. Different cues land in different attractors. That's pattern completion.

```
CUE: "earnings prep"
  → attractor: {earnings-week-mode, morning-trade-prep, news-check, greeks-check}

CUE: "crypto stuff"
  → attractor: {crypto-scan, market-watch, exchange-monitor}

CUE: right-click /trading/watchlist
  → attractor: {watchlist-patterns, options-after-watchlist, sort-preference}
```

Each attractor is a stable coalition determined by the topology. The normalization guarantees stability. The fixed step count guarantees termination.

### Gating

Gates live in CUDA, not in agent shrubs. Per-connection values that the PCN learns.

```
LOW GATE (0.3-0.5):
  strong reliable connection, fires easily from weak cues
  "these things almost always go together"
  PCN saw consistent co-activation → lowered the gate

HIGH GATE (1.5-2.5):
  tentative connection, only fires on very strong activation
  "these things sometimes go together"
  PCN saw occasional co-activation → gate stays high
```

Consequence: strong cues penetrate deep into the connectome (exceed high gates). Weak cues stay shallow (only pass low gates). Recall depth is automatically proportional to cue strength.

```
GATE LEARNING (PCN's job, modifies CUDA-side values):
  agents co-active + user accepted:  gate -= 0.1 (easier next time)
  agents co-active + user rejected:  gate += 0.3 (harder next time)
  asymmetric: rejection raises gate 3x more than confirmation lowers it
```

### Why This Solves the Known Risks

```
CRYSTALLIZATION INSTABILITY:
  normalization means badly crystallized agents can't dominate
  even a bad agent gets outcompeted by well-connected agents
  normalization is self-correcting

SEMANTIC DRIFT:
  normalization prevents any agent from accumulating
  disproportionate influence — budget is fixed
  agents must EARN their share each settling

GRAPH EXPLOSION:
  too many agents = each gets less budget share
  normalization automatically dilutes weak agents
  they become invisible in coalitions
  then PCN prunes them (energy-pool depletion)
  normalization creates natural selection pressure

ACTIVATION SOUP:
  inhibition + normalization + top-K = guaranteed sharp coalition
  three independent mechanisms preventing soup
  any one of them alone would help; together they guarantee it

DEBUGGING:
  fixed 3 steps, fixed budget, deterministic
  log energy distribution after each step
  watch the coalition sharpen
  see which connections carried most energy
  see which inhibitory edges killed which agents
  INTERPRETABLE
```

---

## Part 7: Embeddings — The Nuance Bridge

### Why Embeddings, Not Keywords

The brain processes language through distributed representation, not keyword extraction. "Earnings prep," "quarterly results preparation," and "the usual before numbers come out" all mean the same thing. Keywords would produce different token sets. Embeddings produce nearly identical vectors because the LLM understands they mean the same concept.

### Two Representations Per Agent

Every agent carries both:

```
MACHINE REPRESENTATION (for recall):
  /embedding: [384 floats]
  captures semantic meaning as a vector
  used by CUDA cue kernel for similarity matching

HUMAN REPRESENTATION (for LLM context):
  /name, /description, /context, /avoid
  natural language text
  used by context compiler when assembling Author input
```

Embeddings do the recall. Text does the reasoning. Each representation does exactly what it's good at.

### The Cue Extraction Pipeline

```
USER PROMPT + CHAT HISTORY + LOCALITY
  │
  ▼
CUE EXTRACTOR LLM (small, fast, local, ~300-500ms)
  input: prompt + chat history + locality context
  output: embedding [384 floats]
  captures: intent, urgency, temporal context, pronoun resolution,
            emotional tone, referents — ALL nuance compressed into one vector
  │
  ▼
CUDA CUE KERNEL (<0.01ms)
  dot product: cue embedding × all agent embeddings in parallel
  returns: initial energies per agent
  │
  ▼
CUDA returns: list of (cuda-slot, energy) for active agents
    hoon maps cuda-slot → namespace path via registry
    hoon reads /name, /description, /avoid, /affordances from agent shrubs
  │
  ▼
NAMESPACE PROPAGATION (deps, gates, settling)
  │
  ▼
COALITION → read human text → format context OR execute affordances
```

### Right-Clicks (No Prompt)

No embedding needed. Pure locality. Hoon pokes locality energy directly into agent shrubs that have deps on the selected region. Propagation and settling happen through namespace reactivity. <1ms total, no LLM.

### Embedding Lifecycle

```
AGENT BORN:
  LLM namer generates description text
  SAME text gets embedded → stored as /embedding
  both representations created simultaneously, aligned by construction

AGENT CONFIRMED:
  description might get enriched ("also used for mid-quarter check-ins")
  re-embed → update /embedding
  both representations stay aligned

AGENT DIES:
  both representations deleted together
```

---

## Part 8: Affordances — Agents With Hands

### Core Principle

Agents aren't just memories. They carry WHAT TO DO. When a coalition settles, the top agents' affordances become the right-click menu. Most affordances are direct — one click, no LLM, instant.

### Affordance Schema

```hoon
+$  affordance
  $%
    [%talk shrub=cord talk=cord inputs=(map cord noun)]
    [%project target=pith projection=cord]
    [%navigate target=pith focus=?]
    [%bind source=pith sink=pith]
    [%unbind source=pith sink=pith]
    [%pin target=pith]
    [%unpin target=pith]
    [%compose label=cord steps=(list affordance)]
    [%prompt target=pith text=cord context=(list @ud)]
  ==
```

8 primitives plus compose. This is the OS instruction set.

### Affordance Types

```
%talk:      poke a shrub's talk with inputs (mutate state)
%project:   change how a shrub is rendered (switch view)
%navigate:  move viewport to a region (go somewhere)
%bind:      create a dep between shrubs (wire together)
%unbind:    remove a dep (unwire)
%pin:       mark as persistently visible
%unpin:     remove persistent visibility
%compose:   sequence of the above (full workflow replay)
%prompt:    invoke the Author (generative, when structure doesn't exist)
```

### Where Affordances Come From

PCN watches the event stream. ALL user actions produce events — not just talk pokes, but navigations, projection changes, dep bindings. When the PCN crystallizes a pattern, the affordances are EXTRACTED from the event log, not generated:

```
PCN EVENT LOG FOR THIS PATTERN:
  t=1  navigate /research/news
  t=2  project /research/news %feed
  t=3  talk news-feed/filter-source {source: "watchlist"}
  t=4  talk news-feed/set-refresh {interval: "~m5"}
  t=5  navigate /trading/options
  t=6  project /trading/options %chain
  t=7  bind /watchlist/selected → /options/ticker
  t=8  project /trading/greeks %table

CRYSTALLIZES INTO %compose AFFORDANCE:
  all 8 steps preserved in order
  each step typed correctly
  variable inputs detected and marked
```

The affordances ARE the user's own recorded actions. "Do that again."

### Variable vs Fixed Inputs

```
FIXED (same every time the pattern fires):
  {type: %talk, shrub: "news-feed", talk: "filter-source",
   inputs: {source: "watchlist"}}

VARIABLE (depends on current context):
  {type: %talk, shrub: "options", talk: "open-chain",
   inputs: {ticker: "%selected"}}

  %selected → resolved at click time from current namespace state
  %current  → current selection
  %dep      → value from a dependency
```

PCN detects this: if the input value is the same every time, it's fixed. If it varies, mark as variable and resolve at execution time.

### Execution

```hoon
:: hoon executes an affordance — simple dispatch
?-  -.affordance
  %talk       (poke /[shrub]/talk/[talk] with inputs)
  %project    (set projection at target)
  %navigate   (focus viewport on target)
  %bind       (create dep from source to sink)
  %unbind     (remove dep)
  %pin        (mark persistent)
  %unpin      (unmark)
  %compose    (execute each step in order)
  %prompt     (invoke Author with target + text + context)
==
```

Each is a simple namespace operation. No special runtime. The namespace already supports all of these.

### When the LLM IS Needed

```
DIRECT AFFORDANCE (no LLM):
  the talk exists, the shrub exists
  just poke it
  INSTANT

GENERATIVE AFFORDANCE (needs Author):
  the pattern implies structure that doesn't exist yet
  affordance type: %prompt
  Author generates the shrub XML
  user accepts
  NOW the structure exists
  NOW future affordances can poke its talks directly

  generative affordances convert themselves into direct affordances
  over time, fewer and fewer need the Author
```

---

## Part 9: The Right-Click Menu

The primary interaction surface. When the user right-clicks a selection:

```
1. Locality deps fire on selected shrubs
2. Agents with deps on those shrubs receive energy
3. Namespace propagation: energy cascades through connectome
4. Coalition settles (top-K sparsification if needed)
5. Read /affordances from top active agents
6. Render as menu items

┌─────────────────────────────────┐
│ ▶ Start earnings prep           │  → %compose, 7 steps, instant
│ ▶ Review positions              │  → %compose, 3 steps, instant
│ ▶ Quick news filter             │  → %talk, 1 poke, instant
│ ▶ Switch to dense table         │  → %project, instant
│                                 │
│ ▶ ________________              │  → prompt box (invokes Author)
└─────────────────────────────────┘
```

Everything above the prompt box: pre-recorded namespace operations. No LLM. No delay. The prompt box is the escape hatch for novel requests.

Hard cap: 5 affordance items per menu. Ranked by agent activation energy.

---

## Part 10: Three Interaction Surfaces

All three use the same connectome, same recall mechanism, same affordance schema. Differ in how much the user specifies vs the system infers.

### 1. Prompts (explicit, any scope)

```
GLOBAL:  "Build me an options tracker"
         → cue kernel fires → coalition → Author generates from scratch

LOCAL:   right-click column, type "add days to expiry"
         → locality + semantic cue → coalition → Author targets modification

BROAD:   "connect all trading widgets to portfolio"
         → semantic cue → cross-shrub agents activate → Author generates bindings
```

All prompts receive coalition context. The cue extractor LLM embeds the prompt. The cue kernel fires against all agents. The connectome settles. The coalition's human-readable text becomes the Author's context. ~80-120 tokens, not 400.

### 2. Shortcuts (contextual, one-click)

Direct affordances from active agents, ranked by activation energy. Cached by current locality — update when user navigates or selection changes.

Hard cap: 5 visible shortcuts per context.

```
DIRECT:     structure exists, just poke it. Instant.
GENERATIVE: structure missing, Author creates it. ~2s.
```

### 3. Suggestions (passive queue, evidence-based)

GPU crystallization signals create queue entries. Surface when contextually relevant. User clicks → Author generates if needed → user reviews → accept/reject → event → PCN learns.

Max 2 per week per shrub. Expire after 14 days. Three rejections suppress.

### The Ratio Over Time

```
MONTH 1:  60% prompts, 30% shortcuts, 10% suggestions
MONTH 6:   5% prompts, 80% shortcuts, 15% suggestions
YEAR 1:    2% prompts, 85% shortcuts, 13% suggestions
```

---

## Part 11: Context Compiler

The context compiler reads the settled coalition and assembles input for the LLM Author. It is ONLY invoked when the Author is needed (generative affordances or explicit prompts). Most interactions bypass it entirely via direct affordances.

### Assembly

```
STEP 1: READ COALITION
  walk active agents (energy above threshold)
  sort by activation energy descending

STEP 2: GATHER HUMAN TEXT
  for each active agent:
    read /name, /description, /context, /avoid
    these are pre-written by LLM namer at crystallization time

STEP 3: GATHER NEGATIVE EVIDENCE
  always included from any active agent with /avoid slots
  and from dedicated negative-evidence agents

STEP 4: PROMPT HISTORY (hoon)
  hash(prompt keywords) → scan prompt records
  find past prompts with matching keywords
  extract: related shrubs, edit patterns, outcomes

STEP 5: FORMAT (~80-120 tokens)
  PATTERNS:     active agent descriptions (what the connectome recalled)
  AVOID:        negative evidence (what the user hates)
  PAST PROMPTS: similar prompts and outcomes (what worked/failed before)
  LOCATION:     current locality (where to put the output)
  EXISTING:     what namespace structure already exists here
```

No embeddings in the output. No matrix query. No GPU call. Just reading text slots from active agent shrubs and formatting them. The connectome already did all the intelligence work.

---

## Part 12: The Author (LLM)

### Two LLMs in the System

```
CUE EXTRACTOR (small, fast, local):
  purpose: turn messy human language into embedding
  model: haiku-class or local embedding model
  latency: ~300-500ms
  tokens: ~20 in, 384 floats out
  when: every prompt (not right-clicks)
  cost: near zero

AUTHOR (full, powerful, careful):
  purpose: generate namespace structure (shrub XML)
  model: sonnet/opus class
  latency: ~2s
  tokens: ~80-120 in, ~200-500 out
  when: only for generative affordances and novel prompts
  cost: ~$0.005 per call
```

### Author Receives

```
SYSTEM: You are the Author. Generate shrub XML.

CONTEXT (from coalition, ~80-120 tokens):
  [active agent descriptions — what the connectome recalled]
  [negative evidence — what to avoid]
  [past prompt outcomes — what worked before]
  [namespace state — what exists]

CHAT HISTORY (short-term, variable):
  USER: "make me my usual earnings board"
  ASSISTANT: [generated board]
  USER: "actually make the right panel options greeks"
```

Short-term (chat) resolves "the right panel" and "it."
Long-term (coalition) resolves "usual" and "like last time."

### The Author Gets Smarter (Without Changing)

```
MONTH 1:  generic output, heavy editing
MONTH 6:  80% correct, minor tweaks
YEAR 2:   two-word prompts, complete correct personalized output
```

Not because the LLM improved. Because the connectome accumulated patterns and the coalition delivers exactly the right context. Same LLM, better input.

### Budget Governance

```
Max 3 LLM Author calls per day per shrub.
3 consecutive rejections → freeze for 1 natural_period.
Proposals pending > 14 days → auto-expire.
```

---

## Part 13: Belief Graph (Three-Tier Memory)

### Tier 1: Matrix (large, statistical, volatile)

```
M[2048][2048] ~16MB GPU
Reconstructable from event log replay.
Write-only at runtime (learning from events).
Not queried for recall — connectome handles that.
The hippocampus — fast, fragile, specific.
```

### Tier 2: Connectome (structural, persistent, living)

```
~10,000 belief agent shrubs, ~1MB embeddings in CUDA
Grown by PCN crystallization, pruned by energy depletion.
Deps connect agents to user shrubs and to each other.
Recall through pattern completion (energy propagation via deps).
The cortex — slow, structural, the wiring IS the knowledge.
```

### Tier 3: Hoon State (small, semantic, curated)

```hoon
+$  belief-graph
  $:
    identity=(map cord belief-node)      :: long half-life, always included
    motifs=(map cord belief-node)        :: medium half-life, locality-tagged
    preferences=(map cord belief-node)   :: from accept/reject outcomes
    negatives=(map cord belief-node)     :: rejections, things to avoid
    goals=(map cord belief-node)         :: short half-life, current focus
    prompts=(map @ud prompt-record)      :: maps prompts to outcomes
  ==

+$  belief-node
  $:  tag=cord
      value=cord
      locality=locality-tag
      confidence=@rs
      last-updated=@da
      half-life=@dr
  ==

+$  locality-tag
  $:  shrubs=(set cord)
      path-prefixes=(set pith)
      projections=(set cord)
  ==
```

The neocortex — slow, stable, generalized. Survives restart. Named, meaningful, human-readable. Identity anchors ("user prefers dense tables") live here with very long half-lives.

### How They Relate

```
EVENT LOG (permanent, truth):
  raw events, never modified, append-only
  ↓ replay through CUDA kernel
MATRIX (volatile, fast learning):
  statistical model, 16MB, write-only at runtime
  ↓ crystallization
CONNECTOME (persistent, structural):
  belief agents with deps, ~10,000 nodes
  recall through pattern completion
  ↓ abstraction over time
HOON STATE (persistent, semantic):
  identity, preferences, negatives
  ~1200 named curated nodes
```

---

## Part 14: User Authority

```
On accept:   forge compiles. Episode logged. PCN tracks confirmation.
             agent energy-pool += 5. Gates lower on active connections.
On reject:   energy-pool -= 10. Gate raises. Threshold raised.
             Rejection becomes event. PCN learns.
On undo:     forge reverts. Energy-pool -= 20.
             Three undos suppress agent for 1 natural_period.
```

The user IS the governor. No computational verification pipeline. Acceptance and rejection feed back as events. The system learns from its own proposals.

---

## Part 15: Guardrails

### Cold-Start

Before 200 episodes per shrub: statistics only. No crystallization, no agent spawning, no LLM calls, no automation.

### Thresholds

```
FREQUENCY → INVARIANT:   diag(M)[sdr] > 0.8, ≥ 20 episodes
TRANSITION → BINDING:    M[sdr_a, sdr_b] > 0.6, ≥ 20 observations
CO-ACTIVATION → PRESET:  (M ∧ M.T)[sdr] > 0.5, ≥ 15 episodes
SEQUENCE → WORKFLOW:     M^n[start, end] > 0.7, ≥ 8 completions
```

### Rate Limits

Max 2 consolidations (agent spawns) per week per shrub. Max 3 structural edits per natural_period. Freeze on exceed.

---

## Part 16: Storage

```
GPU MEMORY (~32MB total, volatile, reconstructable):
  Matrix M[2048][2048]          ~16MB
  Agent embeddings (10K × 384)   ~15MB
  Agent metadata (10K × 32B)      ~0.3MB
  Misc buffers                    ~1MB

HOON STATE (persistent):
  Tier 3 belief nodes (~1200)    ~50KB
  Agent registry                 ~100KB  (topology truth, reconstructable from NS)
  Agent shrubs (overlay NS)      varies  (~10K agents × ~2KB = ~20MB namespace state)
  Per-agent: name, description, context, avoid, affordances,
             energy dynamics (gate, weight, sign),
             lifecycle (confidence, energy-pool, state),
             cuda-slot pointer

EVENT LOG (persistent, immutable, append-only):
  every episode ever
  source of truth for matrix rebuild + agent re-crystallization
```

Reconstruction on restart:
1. Replay event log → rebuild matrix M (deterministic, ~10min for 1M events)
2. Agent shrubs persist in namespace → no rebuild needed
3. Re-embed all agent descriptions → rebuild CUDA embedding array
4. Rebuild registry from namespace deps (walk /~belief/agents/*)
5. Agent CUDA slot assignments may change on restart — registry remaps

---

## Part 17: Future — When the Data Says To

**Per-shrub matrices** (when cross-shrub noise is measured):
- Split to per-shrub M_s[512][512] (~1MB each)
- Independent learning rates per domain

**CMP typed messages** (when cross-shrub needs structure):
- Explicit ports between correlated shrubs
- Lateral voting for crystallization confirmation

**RPE event bridge** (when integration is built):
RPE's compiled optics and PCN's SDR encoding both compile from Shrine paths over the same Shrub tree (see RPE Specification v2, Part 16: Shared Path Compilation). The bridge connects them:
- Optic writes (form field changes, builtin updates, `@interact` events) → PCN episodes automatically
- Context compiler includes render state (active pass, heap values at compiled offsets)
- `@action` invocations on Shrubs produce structured episodes with typed inputs

Each is ~1,000 lines and 2 weeks. Build when evidence demands it.

---

## Part 18: PCN Modules — Reusable Cortical Columns

### The Thousand Brains Principle

The neocortex is made of ~150,000 cortical columns, all running the same algorithm. Each column maintains its own complete model of whatever it observes, anchored to its own **reference frame**. Recognition happens when columns vote — consensus across columns = confident recognition. A column that has learned "coffee cup handle" recognizes it regardless of orientation because the knowledge is stored relative to the cup's frame, not in absolute coordinates.

PCN modules follow the same architecture. A module is a portable, self-contained cortical column: agent templates + affordance schemas + wiring rules + a reference frame that declares the structural shape it attaches to. The module doesn't know which Shrub it will mount onto. The reference frame binds it at mount time.

### Module Structure

```
@module sortable-table
  ;; REFERENCE FRAME — structural expectations, not hard-coded paths
  @frame
    @expects parent   :has-kids true
    @expects child    :has-slot type
    @expects child    :has-slot value
    @expects selected :type bool

  ;; AGENT TEMPLATES — spawn into connectome when module mounts
  @agent sort-by-column
    :description "user sorts table by clicking column headers"
    @affordance
      :type %talk
      :talk "sort"
      :inputs {column: "%selected", direction: "%toggle"}

  @agent filter-after-sort
    :description "user filters visible rows after sorting"
    @affordance
      :type %talk
      :talk "filter"
      :inputs {predicate: "%current"}

  @agent column-width-preference
    :description "user resizes columns to preferred widths"
    ;; no affordance — this is a passive memory agent
    ;; learns which columns the user widens/narrows

  ;; WIRING RULES — initial connection topology
  @wire sort-by-column → filter-after-sort
    :type excitatory
    :gate 0.4
    :reason "sorting often followed by filtering"

  @wire sort-by-column → column-width-preference
    :type excitatory
    :gate 0.8
    :reason "weak — sometimes co-occur"
```

### Reference Frames

The reference frame is the key abstraction. It declares the structural shape the module expects, not the concrete paths it will bind to.

```
FRAME EXPECTS:                     BOUND TO AT MOUNT TIME:

parent :has-kids true        →     /trading/watchlist
child :has-slot type         →     /trading/watchlist/AAPL (has :type equity)
child :has-slot value        →     /trading/watchlist/AAPL (has :value 185.30)
selected :type bool          →     /trading/watchlist/AAPL/selected

SAME MODULE, DIFFERENT BINDING:

parent :has-kids true        →     /portfolio/holdings
child :has-slot type         →     /portfolio/holdings/AAPL (has :type position)
child :has-slot value        →     /portfolio/holdings/AAPL (has :value 50)
selected :type bool          →     /portfolio/holdings/AAPL/selected
```

Same module, same agents, same affordances, same wiring. Different binding. The reference frame is what makes modules portable — features are stored at locations relative to the frame, not at absolute namespace paths.

### Frame Binding Protocol

```
MOUNT MODULE:
  1. walk target Shrub tree
  2. match frame expectations against actual structure
     (has-kids, has-slot, type constraints)
  3. if all expectations satisfied:
     a. instantiate agent templates as real agent Shrubs
        in /~belief/agents/[module-name]/[agent-name]
     b. bind agent deps to concrete paths via frame mapping
     c. register agents in registry, allocate CUDA slots
     d. embed agent descriptions → CUDA
     e. apply wiring rules → create inter-agent deps
  4. if expectations not fully satisfied:
     a. partial mount — instantiate agents for matched expectations
     b. unmatched agents remain dormant until structure appears
     c. log which expectations failed (diagnostic)

UNMOUNT MODULE:
  1. walk module's agents
  2. for each: standard agent death (Part 5: Death and Restructuring)
  3. module metadata removed from registry
```

### Voting Is Just Coalition Settling

When the user right-clicks a table cell, multiple modules may be mounted on overlapping Shrubs:

```
MODULE: sortable-table          mounted on /trading/watchlist
MODULE: trading-workflow        mounted on /trading/*
MODULE: personal-learned        user's own crystallized agents

USER RIGHT-CLICKS /trading/watchlist/AAPL
  → locality deps fire
  → agents from ALL modules receive energy
  → propagation through gated connections
  → normalization forces competition
  → coalition settles
  → winning agents may come from ANY module
```

No special consensus protocol. Modules don't need to know about each other. Their agents participate in the same coalition settling that the connectome already does. The energy budget and normalization handle competition. The topology votes.

This is the Thousand Brains voting mechanism: each column (module) has its own model, and the system converges on the interpretation supported by the most evidence (highest energy after propagation).

### Compositionality

Complex behaviors compose from modules, each with its own reference frame:

```
dashboard = layout-module + table-module + chart-module + filter-module

Each module:
  - has its own agents, affordances, wiring
  - binds to its own region of the Shrub tree
  - operates independently within its frame

Cross-module connections:
  - emerge via Hebbian wiring when agents from different modules co-fire
  - PCN notices table-sort agent and chart-update agent consistently co-activate
  - creates excitatory dep between them
  - next time: sorting the table activates chart update automatically
  - the modules have learned to work together through use
```

Module composition is emergent, not declared. The PCN's Hebbian wiring discovers cross-module patterns the same way it discovers cross-agent patterns. Declare the parts. Let the topology discover the relationships.

The SDR encoding makes this work across instances. Module-scoped SDR bits (see Part 1: Module-Scoped SDR Bits) ensure that agents from the same module at different mount points share bit vectors in the memory matrix — the matrix learns "sorting behavior" as a transferable pattern, not "sorting at /trading/watchlist" as a local one. The profunctor optics parallel (module identity = Tambara constraint, action type = focus, mount path = residual) is detailed in Part 1.

### Three Sharing Tiers

```
TIER 1: BLANK MODULE (structure only)
  agent templates + affordance schemas + wiring rules + frame
  no pre-learned state
  PCN learns everything from scratch after mounting
  like a newborn cortical column with architecture but no experience

TIER 2: PRE-TRAINED MODULE (structure + statistical priors)
  everything in Tier 1
  + matrix fragment: M_module[512][512] from aggregate usage
  + initial gate/weight values on wiring rules
  + initial energy-pool values on agents
  on mount: merge matrix fragment into host matrix, seed agent state
  PCN adapts priors to local usage patterns
  like a column with developmental priors

TIER 3: TRANSFERRED MODULE (full agent state)
  everything in Tier 2
  + complete agent descriptions, contexts, avoid lists
  + complete affordance libraries including %compose sequences
  + learned connection strengths from source namespace
  on mount: agents arrive fully formed, participate immediately
  local usage refines gates, weights, connections
  like transplanting trained cortical tissue
```

### Module Lifecycle

```
INSTALL:
  module arrives as a portable bundle (Tier 1/2/3)
  frame matching against target Shrub tree
  agents instantiated, registered, embedded
  wiring rules applied

ADAPT:
  local PCN treats module agents like any other agents
  usage confirms/contradicts → gates adjust, weights shift
  new connections form to non-module agents (Hebbian)
  module agents become personalized through use
  original module template unchanged — adaptation is local

DIVERGE:
  over time, a mounted module's agents may have been
  so heavily adapted that they bear little resemblance
  to the original template — this is correct behavior
  the module provided scaffold; the PCN built the house

REMOVE:
  standard agent death for all module agents
  death cascades handled normally
  host connectome restructures around the gap
```

### What Gets Shared, What Stays Local

```
SHARED (in the module bundle):
  agent templates (name, description, affordance schema)
  frame declarations (structural expectations)
  wiring rules (initial connection topology)
  optional matrix fragment (statistical priors)
  optional pre-learned gate/weight values

LOCAL (never leaves the namespace):
  concrete path bindings
  actual CUDA embeddings (re-embedded locally)
  adapted gate/weight values
  Hebbian connections to non-module agents
  user-specific affordance refinements
  energy-pool history, confirmation state
```

The module is a seed. The namespace is the soil. What grows depends on both.

### Module Discovery

Modules are Shrubs. They can live in a shared namespace, be referenced by path, and be mounted via a `@talk`:

```
:: install a module from a shared library
(poke /~belief/modules/install {
  source: /~library/modules/sortable-table
  target: /trading/watchlist
  tier: %pretrained
})
```

The PCN's own event stream records module installs, so the system learns which modules users mount and where — enabling future module recommendations as affordances themselves.

---

## Part 19: Implementation

### Lines of Code

```
CUDA (~2,800 lines):
  matrix ops + SDR encoding        ~1,500
  cue kernel (dot products)          ~200
  propagation kernel + settling      ~300
  layer projections + signals        ~500
  replay                             ~300

HOON (~3,400 lines):
  episode store + timescale          ~400
  belief graph tier 3                ~300
  agent registry + sync protocol     ~400
  connectome agent lifecycle         ~500
  death cascade + restructuring      ~200
  affordance execution               ~300
  context compiler                   ~200
  prompt history                     ~200
  forge bridge                       ~300
  module system (frame binding,      ~600
    mount/unmount, tier import,
    matrix fragment merge)

GPU ↔ HOON BRIDGE (~800 lines, Rust):
  shared memory IPC                  ~300
  cue kernel dispatch                ~150
  propagation kernel + topology feed ~200
  agent embedding sync               ~150

LLM INTEGRATION (~500 lines):
  cue extractor dispatch             ~150
  Author prompt assembly             ~200
  budget governance                  ~150

TOTAL: ~7,500 lines
```

### Build Timeline

```
WEEKS 1-2: Foundation
  CUDA kernel + SDR encoding + matrix ops
  hoon episode store + bridge
  basic event flow working

WEEKS 3-4: Connectome
  agent shrub structure in overlay NS
  CUDA propagation kernel + connection graph
  crystallization spawning agents
  cue kernel (embedding similarity)

WEEKS 5-6: Recall + Affordances
  embedding pipeline (cue extractor integration)
  affordance schema + execution
  right-click menu from coalition
  context compiler + Author integration

WEEKS 7-8: Polish
  gating dynamics tuning
  Hebbian wiring between agents
  inhibitory connections
  threshold tuning on real data
  edge cases + lifecycle management

First useful output (shortcuts from affordances): ~week 5
Full system with recall + generation: ~week 6
```

### Build Sequence

```
V1 (weeks 1-3): Prove the Loop
  matrix learning + episodes + basic crystallization
  first agent shrubs appear in overlay NS
  accept/reject feedback

V2 (weeks 3-5): Recall
  cue kernel + embedding pipeline
  energy propagation through deps
  coalition settling
  right-click menu shows affordances

V3 (weeks 5-7): Full Cognitive Stack
  affordance extraction from event log
  compose sequences
  Author integration with coalition context
  three interaction surfaces working

V4 (weeks 7-8): Dynamics
  Hebbian wiring between agents
  inhibitory connections
  gate learning from acceptance/rejection
  top-K sparsification
  lifecycle: dormant → retired → pruned

V5 (future): Context Shaping
  identity anchors in tier 3
  full personalized context
  SUCCESS: same prompt, different users, measurably different correct output

V6 (future): PCN Modules
  reference frame declarations + frame binding
  module mount/unmount protocol
  tier 1/2/3 import (blank, pre-trained, transferred)
  matrix fragment merge for tier 2+
  module discovery via shared namespace

V7 (future): IO Adaptation
  external IO events → same pipeline
  extraction templates crystallize as agents
```

---

## Part 20: The Protocol

This is not a product. It is a protocol.

```
PERMANENT (the protocol):
  episode schema
  affordance schema
  agent structure
  namespace primitives (shrubs, slots, kids, deps, talks)
  connectome topology conventions

REPLACEABLE (the components):
  which LLM generates structure
  which LLM extracts cues
  which GPU runs the matrix
  which hardware runs the namespace
  which UI renders projections
  embedding model and dimensionality
```

The protocol never modifies itself. The connectome improves continuously.

```
YEAR 1:    ~500 agents, ~5,000 connections
YEAR 3:    ~2,000 agents, ~30,000 connections
YEAR 5:    ~5,000 agents, ~100,000 connections
YEAR 10:   the connectome IS the user's digital identity
```

Each year the connectome gets richer. Each year the coalitions get more precise. Each year the affordances get more specific. Each year the prompts get shorter. Each year the namespace feels more like the user.

```
ANTHROPIC SELLS:  intelligence (depreciating asset, next model replaces it)
THIS BUILDS:      accumulated understanding (appreciating asset, compounds forever)
```

The intelligence is not in the LLM. The intelligence is in the connectome. The topology is the moat.

---

## Part 21: Biological Alignment

This architecture converges on the brain's design not by analogy but by mechanism. Same problem, same constraints, same solution.

### Complementary Learning Systems

```
BRAIN:                              OUR SYSTEM:

Sensory processing (instant)        Namespace message passing (instant)
  signals propagate, no memory        deps fire, events stream

Hippocampus (fast learning)         Matrix M + PCN kernel (fast learning)
  learns from single experiences      learns from single events
  statistical, specific               statistical, specific
  fragile (damage = amnesia)          volatile (restart = rebuild from log)

Cortex (slow learning)              Connectome (slow learning)
  consolidated memories               crystallized agents
  structural, generalized             structural, generalized
  persistent (survives sleep)         persistent (survives restart)
  the wiring IS the knowledge         the topology IS the intelligence

Neocortical abstractions            Hoon tier 3 (curated knowledge)
  stable concepts, identity           identity anchors, preferences
  very long-term                      very long half-life
```

### The Connectome Parallel

```
BRAIN CONNECTOME:                   OUR CONNECTOME:

neurons                             belief agents
axons/dendrites                     deps
synaptic strength                   connection weights
firing threshold                    gates
synaptic plasticity (Hebbian)       PCN crystallize/confirm/contradict
long-term potentiation              energy-pool +5 on confirmation
long-term depression                energy-pool -20 on contradiction
synaptic pruning                    dormant → retired → removed
synaptogenesis                      new agent + new deps
```

### Pattern Completion (Not Attention)

```
ATTENTION:                          PATTERN COMPLETION:

stateless                           stateful
computed fresh per query             evolves continuously
query determines everything          history determines everything
O(n) per query                       O(1) to read current state
blends items into weighted average   activates discrete patterns
"what's relevant to THIS query"      "what's resonating RIGHT NOW"
```

Our system doesn't do attention. It does cue-dependent recall with spreading activation through a learned topology — the same mechanism the brain uses.

### Materialization

In biology, learning changes the hardware. A brain that has learned piano is a physically different brain. Different tissue. Different connections.

Our namespace has this property. A namespace used for six months is a structurally different namespace. New agents. New connections. New affordances. The workspace itself has grown and reorganized based on use.

```
events → pattern detected → new agent born → new connections → new events
                                                                    ↓
                                               new patterns → new agents
```

The connectome is living tissue that grows, adapts, and dies. The PCN is the growth factor. The user's behavior is the stimulus. The namespace is the organism.

---

## Part 22: Known Failure Modes

### Critical Engineering Risks

```
A) EMBEDDING DRIFT
   risk: embedding model changes → similarity landscape shifts
         → initial ignition patterns change → different coalitions from same cue
         → system feels "different" overnight
   mitigation:
     version embeddings per agent (store model version with embedding)
     re-embed ALL agents on model upgrade (batch job, not real-time)
     validate: compare coalition outputs before/after re-embed on test cues

B) SPARSE USAGE DOMAINS
   risk: some shrubs never reach crystallization threshold
         → no agents spawn for rarely-used areas
         → system is blind to infrequent but important patterns
   mitigation:
     per-shrub adaptive thresholds (lower bar for low-activity shrubs)
     natural_period already scales with usage frequency
     cold-start mode prevents premature crystallization, not permanent blindness

C) OVERCONNECTED AGENTS
   risk: popular agents accumulate too many deps
         → dominate every coalition regardless of cue
         → become "hub" nodes that distort recall
   mitigation:
     hard cap connections per agent (32 max)
     prune weakest edges when cap reached (lowest weight × gate product)
     normalization budget already dilutes overly connected agents
     but prevention is better than correction

D) CONNECTOME STAGNATION
   risk: agents survive too long on weak reinforcement
         → graph fills with lukewarm patterns that aren't wrong enough to die
            but aren't useful enough to surface
         → bloat slows propagation, dilutes coalitions
   mitigation:
     natural energy-pool leakage (continuous drain without confirmation)
     confirmation audit: not confirmed in 3 natural_periods → forced dormant
     silent hub detection: high participation + low confirmation → gates raised, connections pruned
     connection cap: hard 32 per agent, enforced every housekeeping cycle
     (see Part 9: Housekeeping: The Immune System)
```

### Operational Failure Modes

```
Overfitting to bursts:          sustained check + min_age requirement
Rare-event overweighting:       warm-up guard, distinct event minimums
Correlation ≠ causation:        triple filter + author approval + user authority
High churn:                     stability monitor, max 3 edits per period
User indecision:                threshold doubling, three undos suppress
Sparse data:                    cold-start mode, proportional waiting
Adversarial injection:          smoothed adaptation, sustained check
LLM confabulation:              validation, budget governance, rejection backoff
Hypothesis explosion:           independent agents, no combinatorics
Catastrophic forgetting:        independent agents, no shared weights
Activation soup:                normalization + inhibition + top-K sparsification
Wrong initial firings:          cue extractor quality + topology correction via propagation
CUDA-NS desync:                 single codepath for all mutations, registry is topology truth
Cascade collapse:               max cascade depth + energy-pool floor on structural damage
Orphaned CUDA slots:            registry cleanup on agent death, periodic audit
Stale affordance steps:         mark %unconfirmed on component death, decay priority
Registry corruption:            rebuild from NS deps + CUDA metadata (both persistent)
```

---

## Part 23: Design Principles

```
TOPOLOGY IS INTELLIGENCE.
  The wiring between agents IS the knowledge.
  No weights matrix. No parameter optimization. The graph is the model.
  Structure + propagation + energy gating = cognition.

AGENT SHRUBS ARE DUMB.
  They hold data. They have deps. They do nothing.
  CUDA does all activation math. Shrubs carry the payload.
  The filing cabinet doesn't decide which drawer to open.

THE PROTOCOL IS FIXED. THE CONNECTOME GROWS.
  No self-modification. Experience compounds through structural growth.

SPEED SEPARATION IS SAFETY.
  Observe ms. Predict s. Crystallize days. Automate months.

USER IS FINAL AUTHORITY.
  Accept, reject, undo. The system converges on what you want.

NO QUERY. PATTERN COMPLETION.
  The network recalls itself. Cue in, signal propagates, coalition settles.

AFFORDANCES, NOT SUGGESTIONS.
  Agents carry executable actions, not descriptive text.
  Most interactions need no LLM.

TWO REPRESENTATIONS. TWO JOBS.
  Embeddings for machines (recall). Text for LLMs (reasoning).

THREE FORCES. ONE NUMBER.
  Excitation, propagation, decay. Energy is the only runtime state.

GATES CONTROL DEPTH.
  Strong cues reach deep. Weak cues stay shallow. Automatic.

HOON IS THE SPINE.
  Routes signals, fires deps, executes affordances. No math. No intelligence.

CUDA IS THE BRAIN.
  Matrix learning. Cue similarity. Parallel at scale.

THE LLM IS THE HANDS.
  Executes what the connectome decides. Stateless. Replaceable.

THE CONNECTOME IS THE IDENTITY.
  Same LLM + different connectome = different experience.
  The topology is the moat. It compounds forever.

ONE REGISTRY. ONE TRUTH.
  The agent registry is the single source of topology truth.
  CUDA holds embeddings. Hoon holds identity. Registry maps both.
  Every mutation goes through one codepath. No backdoors.

DEATH IS GROWTH.
  Dying agents tear holes. Holes create space. Space fills with new patterns.
  The connectome heals around the user's evolving behavior.
  Restructuring is not failure — it is adaptation.
```

---

## Part 24: PLAN Runtime Alignment

PCN is a consumer of PLAN, not a reimplementation. This section makes the layering explicit and names the integration surfaces that remain underspecified.

### PLAN Value Model

PLAN defines four value types: Pin (content-addressed immutable blob), Law (closure with name, arity, body), App (unevaluated application), Nat (natural number). Five primops reduce PLAN trees. Everything else — Rex syntax, Wisp bootstrapping, Sire/Runa languages — layers on top. The ISA is frozen. Everything in ShrineOS — including agent Shrubs, the connectome topology, and the namespace itself — is a PLAN value.

| Component | PCN Usage |
|---|---|
| Pins (content-addressed blobs) | Episode storage, event log entries, module bundles |
| Laws (PLAN closures) | Affordance execution, talk handlers, transducers |
| Event log | Episode persistence, undo history (IS the pin history of the heap) |
| Orthogonal persistence | Agent Shrubs and connectome survive restart without explicit serialization |

### Shrine Is the Boundary

PCN never touches PLAN values directly. Shrine is the intermediary:

```
PLAN values (Pin, Law, App, Nat)
  ↑ Shrine encodes/decodes
Shrubs (slots, kids, deps, talks, derives)
  ↑ PCN reads/writes via Shrine's path resolution + reactive primitives
PCN agents, connectome, CUDA engines
```

How a Shrub's slots encode as PLAN nouns, how a talk is a Law that accepts typed inputs, how deps compile to reactive subscriptions over PLAN's event log — all Shrine's responsibility. PCN treats Shrubs as opaque typed containers accessed through Shrine's API. This is intentional: Shrine owns encoding, PCN owns prediction.

The same boundary applies to Rex. PCN Module definitions (Part 18) are Rex trees — regular data structures that can be stored, sent, and transformed. Rex-as-data (macros, quoting, programmatic transformation) is a Shrine/Rex capability that modules inherit for free. PCN doesn't reimplement Rex parsing or transformation.

### Orthogonal Persistence

PLAN's defining property: Pins persist data structures transparently to disk with no serialization step. If the namespace is a PLAN heap:

- **Agent Shrubs persist for free.** No explicit save, no checkpoint, no serialize/deserialize cycle. An agent's slots, deps, gates, energy-pool history — all PLAN values, all pinned, all surviving restart.
- **The event log IS the heap's pin history.** Episodes are pins. Crystallization thresholds are pins. The memory matrix M is a pin (or a pin-per-row for incremental persistence). There is no separate persistence layer to build — PLAN provides it.
- **Module bundles are pins.** A Tier 3 transferred module (Part 18) — agent templates, matrix fragment, learned gate values — is a PLAN value. Content-addressed, immutable, transferable between namespaces. Sharing a module is sharing a pin hash.
- **CUDA state is the exception.** GPU memory is volatile. The embeddings array, energy buffers, and cue similarity scratch space do not live in PLAN's heap. On restart, CUDA state must be reconstructed from pinned agent Shrubs — re-embed all agent descriptions, rebuild the registry's CUDA slot mapping, reallocate energy buffers. This is the one persistence boundary PCN must handle explicitly.

Current spec treats persistence as bolted-on (event log, explicit writes). In the actual PLAN runtime, persistence is intrinsic. PCN's implementation should exploit this — the primary persistence work is CUDA reconstruction, not data serialization.

### Code-Is-Data for Agents and Modules

PLAN Laws are values: storable, sendable, disassemblable. This has consequences PCN should acknowledge:

- **Affordance actions are Laws.** A `%compose` affordance that chains three talks is not a string template — it's a PLAN closure. It can be inspected, composed with other closures, and its execution is deterministic under PLAN's operational model.
- **Transducers are Laws** (in the full Shrine implementation, not the JavaScript demo). A transducer that gives `@agent` nodes meaning is a PLAN value that Shrine dispatches — portable, serializable, inspectable. New agent types require new transducers (Laws), not new code.
- **Module definitions are data.** A PCN Module (Part 18) — frame declarations, agent templates, wiring rules — is a Rex tree, which is a PLAN value. Module sharing, discovery, and mounting all reduce to PLAN value operations that Shrine mediates. PCN never manipulates Rex trees directly; it asks Shrine to parse, bind, and instantiate.

### CUDA ↔ PLAN Bridge

The riskiest integration surface. PLAN's heap is persistent, deterministic, and garbage-collected. GPU memory is volatile, parallel, and manually managed. The bridge between them:

```
PLAN heap (pinned Shrubs)
  ↕ Shrine reactive layer (deps fire on mutation)
Hoon agent registry (single source of topology truth)
  ↕ shared memory ring buffers
CUDA engines (embeddings, energy, matrix, cue similarity)
```

Shrine owns the PLAN side. The registry maps agent IDs to both namespace paths (Shrine) and CUDA slot indices (GPU). All mutations flow through the registry — agent birth writes a Shrub (Shrine pins it) AND allocates a CUDA slot. Agent death removes both. This is the fundamental architectural tension: the connectome's topology lives in PLAN (persistent, content-addressed, durable), while its activation dynamics live in CUDA (volatile, index-addressed, ephemeral).

PLAN's zero-dependency principle (runtime in assembly, no external toolchain) does not extend to CUDA. The PCN accepts this trade-off: CUDA is a coprocessor, not part of the trusted computing base. If CUDA state is lost, it reconstructs from pinned Shrubs. If CUDA is unavailable, the PCN degrades — no cue similarity, no energy propagation, no matrix learning — but the agent Shrubs and their affordances remain in the namespace, accessible through explicit navigation. PCN's prediction degradation and RPE's visual degradation (see RPE Specification v2, Part 17: Overflow and Resilience) are independent — RPE can fall back to wireframe while PCN still predicts, and vice versa.

This bridge specification is currently the thinnest part of the system. Implementation should prioritize: ring buffer protocol, reconstruction-from-pins startup sequence, and graceful degradation when CUDA is absent.

---

## Summary

```
Events → PCN CUDA learns → matrix updates → crystallization
  → belief agents spawn in invisible overlay namespace
  → agents wire together through deps (Hebbian)
  → connectome grows: the topology IS the intelligence

User acts → cue fires (embedding or locality)
  → CUDA scores all agents in parallel
  → initial energies poked into agent shrubs
  → namespace reactive propagation (deps, gates, excitation/inhibition)
  → coalition settles naturally
  → affordances read from active agents → menu or direct execution
  → if novel: coalition context → LLM Author → generates structure
  → user accepts/rejects → event → PCN learns → loop

Three surfaces:
  Right-click menu  (affordances from coalition, mostly instant)
  Shortcuts         (contextual, ranked, one-click)
  Suggestions       (ambient, rare, evidence-based)

One connectome. One stateless Author. One namespace. One PLAN substrate.
~7,500 lines. 8 weeks. Ship it.
The namespace learns. The user decides. The topology is intelligence.
```
