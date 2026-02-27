# The Neo-Neocortex: Holonarchic Computation at the Global Namespace Level

**A White Paper on Infinite-Resolution Heterarchical Intelligence in the Rex/ShrineOS Architecture**

*February 2026*

---

## Abstract

Biological neocortex achieves general intelligence through a single repeating computational unit — the cortical column — replicated thousands of times with learned lateral and hierarchical connections. But its topology is constrained: six layers are genetically fixed, lateral wiring is limited by axonal distance, and the meta-organization (which columns exist, how they group) changes only through slow developmental plasticity. Current AI orchestration approaches (hierarchical agent trees, tool-using LLMs, multi-agent frameworks) reproduce these limitations digitally — fixed roles, rigid communication hierarchies, and topologies that must be designed rather than discovered.

This paper presents the **neo-neocortex**: a computational architecture where the column structure itself is runtime-composable, the communication topology is heterarchical and self-organizing, and the meta-organization is subject to the same learning dynamics as the individual columns. The architecture is grounded in the Rex Projection Engine and ShrineOS, where a global namespace provides universal addressability, GPU shared memory makes all-to-all communication within spatial tiles effectively free, and Mahalanobis-envelope statistical learning gives each column autonomous competence without central coordination. The result is an intelligence substrate with infinite resolution (no fixed granularity — columns at every scale) and multiple simultaneous topologies (hierarchy, heterarchy, and lateral voting coexist and are context-dependent).

---

## 1. The Problem with Fixed Topologies

### 1.1 Biological Neocortex: Powerful but Rigid

Vernon Mountcastle's foundational observation — that the neocortex reuses a single columnar algorithm everywhere — is the basis of both the Thousand Brains theory (Hawkins et al., 2024) and the Rex architecture. Each cortical column is a semi-independent sensorimotor learning module: it has its own reference frame, learns complete models of its domain, accumulates evidence through observation, and reaches consensus with neighbors through lateral voting.

But the biological implementation has structural constraints:

| Constraint | Biological Limit | Computational Cost |
|---|---|---|
| **Layer count** | Fixed at 6 layers per column | Cannot add new processing stages at runtime |
| **Lateral range** | Limited by axonal distance (~3mm typical) | Nearby columns communicate easily; distant ones require relay |
| **Column identity** | Determined by developmental genetics | Cannot create new column types at runtime |
| **Grouping** | Macrocolumns, areas, lobes — fixed by anatomy | Meta-organization changes only through slow plasticity |
| **Connection density** | ~10,000 synapses per neuron | Hard physical limit on connectivity |

These constraints don't matter for biological organisms operating in relatively stable ecological niches across evolutionary timescales. They matter enormously for a computational system that must adapt to novel domains in seconds.

### 1.2 AI Orchestration: The Karpathy Problem

Current multi-agent AI architectures reproduce these limitations in software. Andrej Karpathy's vision of orchestrator "Claws" — long-running agents managing parallel Claude Code instances with tools, memory, and instructions — represents the state of the art: a hierarchical coordinator dispatching to specialized workers.

This is better than a monolithic model. But the topology is still designed, not discovered:

- The orchestrator is a **fixed root** — if it fails, everything fails
- Worker specializations are **pre-assigned** — they don't emerge from data
- Communication is **hierarchical** — workers report up, never laterally
- The meta-structure (how many workers, what roles, how they group) is **static**

The question jpt4 poses — "What kind of non-hierarchy? Total n/2 point-to-point?" — cuts to the heart of the problem. If you want heterarchical communication between n agents, the naive approach requires n(n-1)/2 connections. For 10 agents that's 45 links; for 1,000 agents it's ~500,000 links. This is why most systems fall back to hierarchy — it's the only topology that scales without quadratic blowup.

### 1.3 The Thesis: Spatial Co-Presence Eliminates the Scaling Problem

The neo-neocortex resolves this by moving from **message-passing** to **spatial co-presence**. When agents share a memory space (GPU shared memory, ShrineOS namespace regions), "communication" is not a discrete message sent from A to B — it is A writing its state and B reading it. The connections are implicit in the shared space. The cost is O(n), not O(n^2), because the space is a parallel read/write substrate.

This is not a theoretical trick. It is exactly what the Rex architecture already implements: the GPU Hebbian matrix M[2048][2048] is a shared space where every SDR can influence every other SDR through a single matrix multiply. That multiply is O(1) wall-clock time on the GPU — 2048^2 connections happening in one dispatch. The "connections" aren't wires; they're matrix entries.

The contribution of this paper is to show that this principle — **spatial co-presence as communication** — can be recursively applied at every scale, producing a holonarchic system where the topology itself is a learnable, living structure.

---

## 2. Architecture: The Three Pillars

The neo-neocortex rests on three architectural innovations, all already present in the Rex/ShrineOS stack:

### 2.1 Pillar I: Autonomous Columns via Mahalanobis Envelopes

Each `@shrub` in the Rex notation gets a **ShrubLM** (per-Shrub Learning Module) — a cortical column that learns its domain independently. The key mechanism is the **Mahalanobis distance envelope**, computed via Welford's online algorithm for running mean and variance.

#### How It Works

When a `@talk` (named mutation) fires on a shrub, the ShrubLM observes:

1. **Pre-state**: the normalized slot-space position before the talk
2. **Displacement**: the normalized delta vector caused by the talk
3. **Timestamp**: for natural timescale discovery

These observations update a prototype per talk via Welford's online update:

```
proto.count++
delta1 = observation[i] - proto.mean[i]
proto.mean[i] += delta1 / proto.count
delta2 = observation[i] - proto.mean[i]
proto.m2[i] += delta1 * delta2

variance[i] = proto.m2[i] / (proto.count - 1)
```

The Mahalanobis distance from a new observation to the prototype is:

```
d = sqrt( sum_i (observation[i] - mean[i])^2 / variance[i] )
```

This distance captures the full covariance structure of the prototype — it knows not just the range of each dimension independently, but how the dimensions co-vary. A Mahalanobis distance > 3σ signals **surprise**: the observation is statistically inconsistent with learned behavior.

#### Why Mahalanobis, Not Regression

A regression model would try to learn `displacement = f(preState)` — a predictive function from the current position to the expected change. This requires many observations, overfits with sparse data, and assumes a functional relationship that may not exist.

The Mahalanobis envelope answers a different, more useful question: **"Does this pre-state look like the pre-states where this talk has worked before?"** This is a membership test on a learned distribution, not a prediction. It requires ~20 observations to stabilize (Welford converges rapidly), handles arbitrary covariance structures, and degrades gracefully (with few observations, the variance terms are large, making the envelope permissive rather than wrong).

The covariance matrix does the heavy lifting that regression would do, but **defensively** (is this situation normal?) rather than **predictively** (what will happen?). For goal search and guard synthesis, this is the right question.

#### Column Autonomy

Each ShrubLM operates without central coordination:

- **Observation**: records slot deltas from talk invocations
- **Crystallization**: when a prototype has ≥20 observations, spans ≥3 natural periods, and has low variance on all dimensions, it crystallizes — the column is confident in this pattern
- **Surprise detection**: Mahalanobis > 3σ fires a surprise signal
- **Guard synthesis**: crystallized prototypes with rejection history generate Rex guard expressions from pre-state mean ± 2σ bounds
- **Goal search**: backward inference finds which talk's displacement best recovers a target slot value, scored by landing distance + pre-state plausibility via Mahalanobis

No column needs to know what any other column is doing. Each one is a complete sensorimotor learning system for its domain.

### 2.2 Pillar II: Heterarchical Topology via Learned Lateral Connections

Columns don't operate in isolation. They communicate through three mechanisms that collectively implement heterarchical topology:

#### Mechanism 1: Declared Dependencies (`@dep` edges)

Rex shrubs declare dependencies on other shrubs:

```
@shrub session
  @dep cart :path /cart
  @dep user :path /user
```

These compile to connectome edges — directed cross-shrub links. This is the "designed" part of the topology: the developer specifies which shrubs are structurally related.

#### Mechanism 2: Co-Firing Discovery

When two ShrubLMs fire within a 50ms window, the system detects co-firing and tentatively creates a lateral port between them:

```
if (timestamp_A - timestamp_B < 50ms) {
  lm_A.addPort(shrubName_B)  // initial weight 0.1 — must earn its weight
  lm_B.addPort(shrubName_A)
}
```

This is **activity-dependent wiring** — the same mechanism by which biological cortical columns form lateral connections through correlated firing. No developer declares the relationship; the data reveals it.

#### Mechanism 3: Lateral Voting with Learned Port Weights

Connected ShrubLMs exchange votes: `{sender, hypothesis, confidence, displacement, evidence}`. The receiving LM integrates votes using learned port weights:

- Confirming votes (cosine similarity > 0.5): increase evidence, strengthen port weight (+0.1)
- Contradicting votes (cosine similarity < -0.3): decrease evidence, weaken port weight (-0.2)
- Port weight below 0.05: **prune** — the connection is severed

The asymmetric update (contradictions weaken faster than confirmations strengthen) implements a form of immune response: bad connections die quickly.

#### Crystallization Requires Lateral Confirmation

A prototype that passes local crystallization thresholds enters a **pending** state. If the ShrubLM has known lateral ports, it waits for at least one confirming vote before fully crystallizing. If no lateral ports exist (isolated shrub), it crystallizes immediately. If no confirmation arrives within 30 seconds, it crystallizes solo.

This is Thousand Brains flash inference: multiple columns converge to a shared hypothesis without exhaustive search. They just agree.

#### The Resulting Topology

The combination of declared deps, co-firing discovery, and vote-weighted pruning produces a **small-world network**:

- **Local clusters**: shrubs that co-fire frequently form dense lateral connections
- **Sparse long-range links**: declared deps provide structured cross-domain paths
- **Dynamic pruning**: uninformative connections are cut, preventing hub accumulation
- **Connection count scales as O(n)**, not O(n^2)

This is neither hierarchy nor full mesh. It is a **learned sparse heterarchy** — the topology that Karpathy's orchestrator tries to hard-code, but that the Rex system discovers from data.

### 2.3 Pillar III: Spatial Co-Presence via GPU Shared Memory and the Global Namespace

The learned heterarchy from Pillar II handles **which** connections exist. Pillar III handles **how** those connections are physically realized, and why full mesh within local groups is computationally free.

#### GPU Architecture: Tiled Parallelism

GPU compute is organized into **workgroups** (typically 64-256 threads) that share fast local memory (~48KB). Communication within a workgroup is effectively free — shared memory reads/writes are ~100x faster than global memory. Communication between workgroups requires global memory, which is slower.

The Rex memory matrix M[2048][2048] exploits this: the matrix multiply is dispatched across workgroups, each handling a tile of the matrix. Within each tile, all-to-all interaction happens through shared memory. The 2048^2 "connections" complete in a single dispatch (~0.1ms).

#### ShrineOS Namespace: Universal Addressability

ShrineOS provides a global namespace where every entity — shrub, slot, talk, belief agent — is addressable by path. The namespace is a shared memory space: writing to `/cart/total` makes the value available to anything that can read `/cart/total`. There is no message routing, no RPC, no serialization. Communication is co-presence in the namespace.

This is the answer to "could it not scale terribly if orchestrated at the space level in ShrineOS?" — **yes, it scales**. When columns share a namespace region, their n/2 connections aren't discrete messages; they're concurrent reads from shared state. The OS manages coherence. The columns just write their state and read their neighbors'.

#### Placement-Aware Scheduling

The key optimization is **co-locating columns that communicate densely**:

1. **Intra-group**: columns that co-fire frequently are placed in the same GPU workgroup → full mesh via shared memory, essentially free
2. **Inter-group**: sparse learned connections between workgroups are routed through the global Hebbian matrix

The co-firing discovery mechanism from Pillar II provides the signal for placement decisions: columns that discover lateral ports to each other should be co-located. This turns the architecture inside out — instead of "discover connections, then prune for performance," it becomes "discover connections, co-locate for free mesh, then prune for signal quality."

The connection count within each tile (k columns, k(k-1)/2 links for k~16 = 120 links) is trivial because it's all shared memory. The connection count between tiles is sparse (learned, pruned). Total cost: O(groups × k^2) local + O(sparse_edges) global ≈ O(n) overall.

---

## 3. The Holonarchy: Columns All the Way Down (and Up)

### 3.1 What Is a Holon?

Arthur Koestler's **holon** is an entity that is simultaneously a **whole** (autonomous, self-contained) and a **part** (component of a larger system). A holonarchy is a hierarchy of holons — each level is complete in itself and also a building block for the next level.

In the neo-neocortex, every computational unit is a holon:

| Scale | Whole (autonomous) | Part (component) |
|---|---|---|
| **Slot** | Has type, range, default value | Axis in a ShrubLM's reference frame |
| **ShrubLM** | Full sensorimotor column: prototypes, envelopes, goal search | Participant in lateral voting, dep graph |
| **Workgroup** | Dense local mesh, shared memory, fast consensus | Node in global Hebbian matrix |
| **Belief Agent** | Affordances, confidence, lifecycle | Edge in the connectome, component of higher-order agents |
| **Connectome Cluster** | Second/third-order behavioral mode | Input to ShrineOS scheduling |
| **ShrineOS Space** | Complete namespace with reactive propagation | Tile in a distributed deployment |

At every level, the same dynamics apply:

- **Welford learning** on observations → running mean/variance
- **Mahalanobis surprise** → deviation detection
- **Lateral voting** → consensus without central coordination
- **Crystallization** → confident patterns commit and become structural
- **Pruning** → uninformative connections die

This is what makes it a **neo**-neocortex: biological cortex has exactly one scale of column (minicolumn, ~80-100 neurons). The neo-neocortex has columns at every scale, each implementing the same algorithm, each simultaneously autonomous and embedded.

### 3.2 Heterarchy Within the Holonarchy

A strict hierarchy means each node has exactly one parent. Biological neocortex is not strictly hierarchical — cortical areas have reciprocal connections, skip connections, and many-to-many projections. The Thousand Brains project explicitly models heterarchy: LMs have lateral connections to peers, hierarchical connections to parents and children, and skip connections that bypass levels.

The Rex architecture goes further. The same ShrubLM can participate in multiple groupings simultaneously:

```
@shrub cart
  @dep user :path /user          ;; hierarchical: cart depends on user
  @dep inventory :path /inventory  ;; lateral: cart and inventory co-activate

;; Meanwhile, discovered via co-firing:
;; cart ↔ session (lateral, learned)
;; cart ↔ notification (lateral, learned)
;; cart → analytics (hierarchical, learned from sustained co-firing)
```

The communication role of `cart` is context-dependent:

- When the user adds an item: `cart` is a **peer** of `inventory` (lateral voting)
- When the session completes: `cart` is a **child** of `session` (hierarchical goal decomposition)
- When analytics crystallizes a pattern: `cart` is a **sensor** feeding an abstract column (bottom-up observation)

No role is permanently assigned. The same column shifts between hierarchical, lateral, and sensory roles depending on which connections are active in the current context. This is **heterarchy** — not the absence of hierarchy, but the simultaneous presence of multiple hierarchies, with the active one determined by the situation.

### 3.3 Infinite Resolution

Biological cortex has a fixed resolution: the minicolumn (~0.5mm diameter, ~80-100 neurons). You cannot zoom in below the column level or zoom out above the cortical area level without leaving the columnar paradigm.

The neo-neocortex has no fixed resolution because the column structure is defined by the data, not the hardware:

- A shrub with 3 numeric slots is a 3-dimensional column
- A shrub with 30 slots is a 30-dimensional column
- A belief agent aggregating 5 shrubs is a meta-column whose dimensions are the confidence values of its children
- A ShrineOS space containing 100 belief agents is a hyper-column whose dimensions are the activation energies of all agents

At every scale, you can ask:
- What is the Mahalanobis distance of this observation from the prototype? (surprise)
- Which connections confirm vs. contradict the current hypothesis? (voting)
- Has this pattern crystallized? (confidence)
- What goal state would correct the current deviation? (backward inference)

The resolution is infinite because the slot-space dimensionality is not fixed. A new slot added to a shrub extends the reference frame by one axis. A new shrub added to the namespace creates a new column. A new belief agent extends the connectome. The same Welford/Mahalanobis/voting/crystallization algorithm operates at each level with no modification.

---

## 4. The Global Namespace as Cognitive Substrate

### 4.1 Why a Namespace, Not a Network

Traditional multi-agent systems are **networks**: discrete nodes connected by discrete channels. Communication requires explicit routing — A must know B's address, open a channel, serialize a message, send it, and wait for acknowledgment.

The ShrineOS namespace is not a network. It is a **space**: a structured, addressable, reactive memory region where entities exist by virtue of being written. Communication is **co-presence** — if two values exist at related paths, they are already in communication through the reactive dependency system.

```
/cart/total = 150        ;; exists in the namespace
/session/active = true   ;; exists in the namespace

;; These don't need a "channel" between them.
;; A @dep or @derive that reads both paths creates the connection implicitly.
;; The namespace IS the connection.
```

This distinction matters because:

1. **Discovery is free**: any entity can read any path. No connection setup.
2. **Topology is structural**: dependencies are expressed in the tree, not in routing tables.
3. **Communication is synchronous with state**: reading a path always gets the current value, not a stale message.
4. **The reactive system propagates changes automatically**: when `/cart/total` changes, everything that depends on it recomputes.

### 4.2 The Namespace as Shared Cortical Sheet

In biological cortex, the cortical sheet is a 2D surface where physical proximity determines connectivity. Nearby columns communicate through dense lateral connections in layers 2/3. Distant columns communicate through sparse long-range fibers.

The namespace serves the same function, but in **path space** rather than physical space. Path proximity determines connection density:

```
/dashboard/metrics/users
/dashboard/metrics/revenue
;; Close in path space → shared SDR prefix bits → dense implicit connections

/dashboard/metrics/users
/settings/notifications/email
;; Distant in path space → few shared SDR bits → sparse connections only if learned
```

The SDR (Sparse Distributed Representation) encoding makes this concrete: each path hashes to ~50 active bits out of 2048. Paths sharing a prefix share bits. The Hebbian matrix M learns correlations between bits. Shared bits create implicit connections — the **path topology IS the connection topology**.

### 4.3 Multiple Topologies Simultaneously

The neo-neocortex supports multiple simultaneous topologies because the namespace supports multiple simultaneous access patterns:

| Topology | Mechanism | Scale |
|---|---|---|
| **Hierarchical** | `@dep` edges, parent-child shrub nesting | Structural, designed |
| **Lateral** | CMP votes between ShrubLMs, co-firing discovery | Behavioral, learned |
| **Associative** | Hebbian matrix M[2048][2048], SDR bit overlap | Statistical, global |
| **Compositional** | Belief agent → child agent edges in connectome | Emergent, multi-order |
| **Temporal** | Episode ring buffer, sequence learning (L4) | Episodic, time-indexed |

All five topologies operate on the same namespace, reading and writing the same paths, but implementing different patterns of connectivity. A single talk invocation on a shrub simultaneously:

1. Fires through the hierarchical dep graph (structural reactions)
2. Emits a vote to lateral neighbors (behavioral consensus)
3. Updates the Hebbian matrix (statistical association)
4. Records an episode (temporal sequence)
5. May trigger or strengthen a belief agent edge (compositional emergence)

This is **polycomputing** in Michael Levin's sense: the same event is simultaneously processed through multiple computational substrates, each implementing a different topology, all grounded in the same namespace.

---

## 5. Profunctor Optics as the Compositional Algebra

### 5.1 Why Optics Matter for the Neo-Neocortex

The Clarke et al. (2024) profunctor optics framework provides the mathematical foundation for how columns at different scales compose their access to shared state. The key result (Theorem 4.14) proves that **mixed optics — where decomposition and recomposition live in different categories — compose via ordinary function composition**.

In the neo-neocortex, "different categories" means different shrub types with different reference frames. When a `@shrub cart` (category: e-commerce, dimensions: total/count/discount) communicates with a `@shrub analytics` (category: metrics, dimensions: conversion_rate/avg_order_value), the communication is a **mixed optic**: the cart decomposes in its own category (slot-space), and analytics recomposes in its own.

The CMP (Cortical Messaging Protocol) messages between ShrubLMs are typed by optic family:

| Optic Type | Communication Pattern | Example |
|---|---|---|
| **Lens** | Bidirectional state sync | Cart syncs `total` to session |
| **Prism** | Conditional pattern match (may fail) | Regime detector checks if "earnings mode" applies |
| **Traversal** | Iterate over collection | Analytics aggregates across all carts |
| **Grate** | Construct from continuation | Dashboard builds view from multiple data sources |
| **Mixed** | Cross-category composition | Cart data meaningful in analytics frame |

The profunctor representation guarantees that these compositions are well-typed and zero-cost: at compile time, the entire chain collapses to a byte offset in the heap.

### 5.2 Optics and the Holonarchy

The holonarchic structure of the neo-neocortex is precisely a **hierarchy of optic compositions**:

```
Slot access:     Lens (read/write a field)
Shrub access:    Lens composed with Lens (path resolution)
Cross-shrub:     Mixed optic (different reference frames)
Belief agent:    Traversal (fold over children) composed with Mixed (cross-category)
Connectome:      Kaleidoscope (pointwise fold over agents) composed with Traversal
```

At each level, the composition is guaranteed correct by the profunctor representation theorem. The existentially quantified residual M in `∫^M C(S, M▷A) ⊗ D(M◁B, T)` is the **context** that gets quantified away during composition — you can't observe it directly, but its shape ensures the types match.

This is the categorical formalization of the Mahalanobis envelope's role: the covariance matrix IS the residual — it captures the structural context of the prototype without exposing individual observations. When two columns compose, their covariance structures compose through the optic algebra, producing a higher-order envelope that captures cross-column structure.

### 5.3 SDR Decomposition as Optic Decomposition

The Rex SDR encoding decomposes each event into three independently hashed components:

```
SDR(event) = module_bits ∪ path_bits ∪ action_bits
```

This maps directly to the optic decomposition:

| SDR Component | Optic Role | Category-Theoretic Identity |
|---|---|---|
| `module_bits` | Tambara constraint | What structural shape is preserved |
| `action_bits` | Focus | What operation is being performed |
| `path_bits` | Residual | Where in the structure — quantified away |

When the Hebbian matrix learns `M[sdr_a, sdr_b]`, the shared module+action bits create implicit identification between events at different mount points. The averaging over instances with different path bits IS the coend — it learns the invariant pattern while the variant part washes out. The matrix's Hebbian update on shared bits performs the universal property of the coend computationally.

---

## 6. The Learning Lifecycle: From Observation to Structure

### 6.1 Phase 1: Observation (Sensation)

Every namespace event is recorded as an episode:

```
{ source, shrub, path, talk, mode, timestamp }
```

Episodes flow to three destinations simultaneously:
1. The global Hebbian matrix (SDR encoding → matrix update)
2. The local ShrubLM (slot deltas → Welford prototype update)
3. The episode ring buffer (temporal sequence storage)

No interpretation happens at this stage. The system simply records what happened, when, and where.

### 6.2 Phase 2: Prototype Formation (Perception)

As observations accumulate, ShrubLM prototypes form via Welford's algorithm. Each prototype captures the statistical signature of a talk: what the displacement looks like, what the pre-state looks like, how variable each dimension is.

Crystallization occurs when:
1. **Count ≥ 20**: enough observations for stable statistics
2. **Temporal span ≥ 3 natural periods**: not just a burst, but sustained behavior
3. **Low variance on all dimensions**: the pattern is consistent
4. **Lateral confirmation** (if lateral ports exist): at least one neighbor agrees

This is perception in the Thousand Brains sense: the column has formed a confident model of its sensorimotor domain.

### 6.3 Phase 3: Guard Synthesis (Belief Formation)

When a crystallized prototype has been **rejected** at least once (a guard check failed), the ShrubLM synthesizes a guard expression from the pre-state statistics:

```
For each slot dimension with non-trivial variance and displacement:
  lower = preState.mean - 2σ
  upper = preState.mean + 2σ
  Emit: (and (gte /slotName lower) (lte /slotName upper))
```

This is **belief formation**: the column has observed enough successes and failures to articulate a rule. The rule is not programmed — it emerges from the covariance structure of the data, expressed as a Rex guard that the behaviour transducer can evaluate.

### 6.4 Phase 4: Goal-State Recovery (Agency)

When a `@derive` value exits its schema range, the behaviour transducer invokes backward inference through the ShrubLM:

```
For each talk prototype:
  Score = distance(currentPos + displacement, target)
        + 0.1 * Mahalanobis(currentPos, preState)
Return the talk with the best score
```

The Mahalanobis pre-state plausibility term is crucial: it penalizes talks whose typical pre-state is far from the current situation, even if their displacement would reach the target. This prevents the system from attempting actions that have never been observed in the current context.

This is **agency**: the column doesn't just observe and model — it acts to correct deviations, using its learned prototypes as a causal model.

### 6.5 Phase 5: Connectome Formation (Social Cognition)

As belief agents crystallize and accumulate, they wire together through Hebbian dynamics at the agent level:

- **Co-activation** → excitatory edge (these patterns reinforce each other)
- **Mutual exclusion** → inhibitory edge (these patterns compete)
- **Sustained co-firing cluster** → parent agent spawns (emergent higher-order pattern)

The connectome grows through three orders:
1. **First order**: individual patterns ("user checks news before trading")
2. **Second order**: pattern compositions ("morning trade prep = news + options + greeks")
3. **Third order**: behavioral modes ("earnings week mode")

Higher orders form from sustained co-firing of lower-order agents. Each order is itself a column — it has its own confidence, its own envelope, its own lifecycle. And it is a holon: complete in itself, and a component of the next level.

### 6.6 Phase 6: Topology Self-Organization (Meta-Cognition)

The complete lifecycle produces a self-organizing topology:

1. Observations accumulate → prototypes form → columns crystallize
2. Columns vote laterally → co-firing discovery → new connections
3. Connections strengthen or weaken → pruning of uninformative links
4. Sustained clusters → higher-order columns → new scale level
5. ShrineOS observes co-location patterns → spatial tiling optimization
6. Repeat at every scale

The topology is not designed. It is **grown** — like a garden tended by the PCN's immune system (energy decay, confirmation audit, silent hub detection, connection cap enforcement). Bad agents die. Bad connections are pruned. Good patterns survive and reproduce at higher scales.

---

## 7. The Immune System: Preventing Pathological Topology

### 7.1 Why Topology Needs an Immune System

In a self-organizing connectome, pathological topology is inevitable without active maintenance:

- **Hub accumulation**: an agent becomes highly connected because it's loosely relevant to many patterns, even though it's strongly relevant to none
- **Runaway cascades**: excitatory feedback loops between agents create persistent high-activation states
- **Zombie agents**: agents that survive through minimal confirmation, consuming connection slots without contributing

### 7.2 Defense Mechanisms

The Rex PCN implements a three-layer defense:

**Layer 1: Energy Decay** (catches neglected agents)
```
Every natural_period:
  For each alive agent not confirmed this period:
    energy_pool -= 0.5
```
Unconfirmed agents slowly starve. This is the default housekeeping — the baseline metabolic cost of existence.

**Layer 2: Confirmation Audit** (catches lingering agents)
```
For each alive agent not confirmed in 3 natural_periods:
  Force DORMANT
```
Agents that survive on minimal energy without genuine usefulness are forcibly retired.

**Layer 3: Silent Hub Detection** (catches structurally toxic agents)
```
For each agent with connection_count > 10:
  If participation_rate > 0.4 AND confirmation_rate < 0.1:
    SUSPECT → raise gates × 2, lower weights × 0.5
  If still suspect after 2 natural_periods:
    Force DORMANT
```

Silent hubs are the connectome equivalent of a memory leak: structurally important (high connectivity, frequent participation) but functionally useless (low confirmation). They distort coalitions they didn't originate by riding other agents' activation energy through the propagation kernel.

**Connection Cap**: hard limit of 32 connections per agent. Weakest connections pruned when exceeded.

### 7.3 Death and Healing

When an agent dies, it tears a hole in the connectome. Dependent agents receive dead signals and restructure:

- Children lose a component → energy pool decreases, affordances degrade
- Peers lose a lateral connection → registry updated, activation patterns change
- Parents lose a child → may themselves die if no other strong components remain

After death, the PCN continues watching the event stream. If the user's behavior persists, a new pattern crystallizes, a new agent spawns, and the connectome **heals around the new reality**. This is morphogenetic regeneration in Levin's sense: the topology recovers correct function from arbitrary damage.

---

## 8. Comparison with Existing Approaches

### 8.1 vs. Hierarchical Orchestration (Karpathy's Claws)

| Property | Hierarchical Orchestration | Neo-Neocortex |
|---|---|---|
| **Topology** | Designed, fixed tree | Learned, dynamic heterarchy |
| **Failure mode** | Root failure kills everything | Local failure, graceful degradation |
| **Adaptation** | Requires redesign | Topology self-organizes from data |
| **Scale** | O(depth) latency | O(1) within spatial tiles |
| **Communication** | Message passing | Spatial co-presence |
| **Meta-structure** | Static roles | Emergent, multi-order |

### 8.2 vs. Mixture of Experts (MoE)

| Property | MoE | Neo-Neocortex |
|---|---|---|
| **Expert selection** | Gating network (trained) | Mahalanobis envelope (online) |
| **Expert interaction** | None (selected independently) | Lateral voting, heterarchical |
| **Expert creation** | Fixed at training time | Runtime crystallization |
| **Expert death** | N/A | Energy decay + immune system |
| **Reference frames** | Shared embedding space | Per-column slot-space |

### 8.3 vs. Thousand Brains (Monty)

| Property | Monty (TBP) | Neo-Neocortex (Rex) |
|---|---|---|
| **Column count** | Fixed at design time | Dynamic (shrubs created/destroyed) |
| **Reference frame** | 3D Cartesian (grid cells) | N-dimensional slot-space |
| **Topology** | Fixed lateral + hierarchical | Learned heterarchy + spatial tiling |
| **Domain** | 3D object recognition | Arbitrary namespace behavior |
| **GPU acceleration** | CPU-based (Python) | Native WebGPU compute |
| **Self-modification** | No | Guard synthesis, source amendment |

### 8.4 vs. Global Workspace Theory (GWT)

| Property | GWT | Neo-Neocortex |
|---|---|---|
| **Bottleneck** | Single global workspace (broadcast) | Multiple simultaneous topologies |
| **Consciousness model** | Competition for workspace access | No single bottleneck; coalitions form in parallel |
| **Communication** | Winner-take-all broadcast | Graded voting with learned port weights |
| **Scope** | Cognitive architecture theory | Implemented system with GPU kernels |

---

## 9. Implementation Status

The neo-neocortex is not a theoretical proposal. It is substantially implemented in the Rex Projection Engine:

| Component | Status | Implementation |
|---|---|---|
| ShrubLM with Mahalanobis envelopes | **Implemented** | `rex-pcn.js` — `ShrubLM` class, 500+ lines |
| Welford online learning | **Implemented** | `ShrubLM.observe()` — prototype update |
| Lateral voting via CMP | **Implemented** | `ShrubLM.receiveVote()`, `processVotes()`, `buildVote()` |
| Co-firing port discovery | **Implemented** | `RexPCN._recentFirings`, 50ms window |
| Port weight learning + pruning | **Implemented** | Weight update in `processVotes()`, prune < 0.05 |
| Guard synthesis from pre-state | **Implemented** | `ShrubLM.synthesizeGuard()` |
| Goal-state backward inference | **Implemented** | `ShrubLM.findGoalTalk()` with Mahalanobis scoring |
| Self-healing recovery | **Implemented** | `RexBehaviour._attemptRecovery()` |
| Model-free guard bypass | **Implemented** | `RexBehaviour.invoke()` — `isPrototypical()` check |
| GPU Hebbian matrix (2048^2) | **Implemented** | `RexPCN.init()` — WebGPU compute shaders |
| SDR encoding with module decomposition | **Implemented** | `RexPCN.encodeSdr()` |
| Episode ring buffer | **Implemented** | `RexPCN.pushEpisode()` |
| Natural timescale discovery | **Implemented** | `RexPCN._updateNaturalPeriod()` |
| Cue kernel + propagation | **Implemented** | `RexPCN.cue()` — WebGPU dispatch |
| Connectome belief agents | **Designed** | PCN Spec v4, agent lifecycle |
| ShrineOS spatial tiling | **Designed** | Placement-aware scheduling |
| Per-shrub local matrices | **Designed** | PCN-03 overlay spec |
| Optic-typed CMP messages | **Designed** | PCN-03 overlay spec |

---

## 10. Conclusion: The Space Is the Intelligence

The neo-neocortex inverts the usual relationship between computation and communication. In conventional architectures, computation happens inside nodes and communication happens between them. In the neo-neocortex, the **space itself is the computation** — co-presence in a shared namespace IS the communication, spatial tiling IS the optimization, and the topology of connections IS the intelligence.

This is not a metaphor. The Hebbian matrix's weighted connections are literally the learned structure that determines behavior. The connectome's topology — which agents connect to which, through what gates, with what weights — IS the system's knowledge. Change the topology, and you change what the system knows and does.

The three contributions of this architecture are:

1. **Holonarchic recursion**: the same algorithm (Welford → Mahalanobis → voting → crystallization → pruning) operates at every scale, from individual slots to global connectome clusters, with no modification.

2. **Spatial co-presence as communication**: by grounding all computation in a shared namespace with GPU-accelerated access, the n^2 connection problem dissolves. Full mesh is free within spatial tiles; learned sparse connections handle inter-tile routing.

3. **Topology as first-class learnable object**: the meta-organization — which columns exist, how they group, what scale they operate at — is subject to the same surprise/confirmation/pruning dynamics as the individual prototypes within columns. The system doesn't just learn patterns; it learns the structure that learns patterns.

The neocortex was evolution's answer to general intelligence: one algorithm, replicated many times, connected by learned topology. The neo-neocortex is the same insight, freed from the constraints of biological development — infinite resolution, multiple topologies, and a global namespace that turns spatial co-presence into cognitive structure.

---

## References

- Clarke, B., Elkins, D., Gibbons, J., Loregian, F., Milewski, B., Pillmore, E., & Román, M. (2024). Profunctor optics: A categorical update. *Compositionality*, 6(1).
- Clay, V., Leadholm, N., & Hawkins, J. (2024). The Thousand Brains Project: A new paradigm for sensorimotor intelligence. *Numenta Technical Report*.
- Hawkins, J. (2021). *A Thousand Brains: A New Theory of Intelligence*. Basic Books.
- Koestler, A. (1967). *The Ghost in the Machine*. Hutchinson.
- Levin, M. (2023). Technological Approach to Mind Everywhere: An experimentally-grounded framework for understanding diverse bodies and minds. *Frontiers in Systems Neuroscience*, 16.
- Mountcastle, V. (1978). An organizing principle for cerebral function: The unit module and the distributed system. *The Mindful Brain*, MIT Press.
- Welford, B. P. (1962). Note on a method for calculating corrected sums of squares and products. *Technometrics*, 4(3), 419-420.

---

*This paper describes the architecture as implemented in the Rex Projection Engine (RexGPU) and as designed for the ShrineOS runtime. The code is available in the accompanying repository.*
