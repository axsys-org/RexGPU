# PCN-03: Overlaid Namespace with Typed Message Passing

## What the Three Sources Demand

### Source 1: Clarke et al. — Profunctor Optics (Compositionality 2024)

The paper's core result (Theorem 4.14) proves that **all optic families compose via ordinary function composition in profunctor form**, and critically that **mixed optics** allow decomposition and recomposition to live in *different categories*. This has direct consequences for PCN:

**Current PCN problem**: The six layers are presented as "different read patterns on one matrix." But they aren't the same *kind* of access:
- L1 (frequency) is a **getter** — read-only, degenerates to `C(S, A)`
- L2 (transitions) is a **lens** — reads previous state, updates with current
- L3 (co-activation) is a **grate** — builds structure from `[S,A] • B → T` (continuation-style)
- L4 (sequences) is a **traversal** — iterates over power series `Σ Aⁿ ⊗ Xₙ`
- L5 (regime) is a **prism** — conditional match that may fail (context doesn't apply)
- L6 (cross-shrub) is a **mixed optic** — decomposition in shrub A's category, recomposition in shrub B's category

**What must change**: The six layers should be formalized as six optic families. Messages between PCN nodes should carry their optic type. This means the matrix isn't homogeneous — different operations have different algebraic structure, and the CMP should respect that.

### Source 2: TBP Architecture (Clay, Leadholm, Hawkins 2024)

The Thousand Brains Project introduces three components:
1. **Sensor Modules** — extract features at a location in a reference frame
2. **Learning Modules** — semi-independent units that each model complete objects via spatially structured reference frames
3. **Cortical Messaging Protocol (CMP)** — unified protocol for lateral (heterarchical) AND hierarchical communication

Key architectural principles that conflict with current PCN:

| TBP Principle | Current PCN | Conflict |
|---|---|---|
| Each LM is semi-independent with own reference frame | One shared matrix M[2048][2048] | Shrubs don't have independent learning |
| LMs learn complete objects, not fragments | Matrix encodes global correlations | No per-shrub object models |
| CMP enables heterarchy (lateral) + hierarchy | L6 cross-shrub is ad-hoc bilinear form | No structured message protocol |
| Hebbian-like associative learning per LM | Global matrix outer product update | Learning is global, not local |
| Reference frames ground all representations | SDR bit overlap is the only metric | No spatial grounding of predictions |
| Motor system receives movement outputs | No motor/action model | PCN is passive observer |

**The critical gap**: TBP says each cortical column (= shrub) should be a **Learning Module** that independently builds models of its domain. The current PCN pools everything into one matrix, which means:
- A shrub can't learn independently of other shrubs
- A shrub can't have its own reference frame
- Cross-shrub communication is implicit (matrix correlation) rather than explicit (message passing)

### Source 3: Monty's CMP Specifics

The CMP defines what messages look like between Learning Modules:
- **Observations**: feature + location in a reference frame
- **Votes**: hypotheses about what's being observed (object ID + pose)
- **Goal states**: desired outcomes passed between levels
- Messages flow both **laterally** (between LMs at same level) and **vertically** (between hierarchy levels)

This is fundamentally different from `sdr_A · M · sdr_B`. It's *structured* message passing with typed content.

---

## The Overlaid Namespace Design

### Core Change: Two Layers, Not One Matrix

```
LAYER 1: LOCAL LEARNING (per-shrub)
  Each shrub gets its own local matrix M_s[512][512] (~1MB)
  Local SDR encoding within the shrub's reference frame
  Local prediction, local error, local crystallization
  This IS the Learning Module

LAYER 2: OVERLAID CMP NAMESPACE (inter-shrub)
  Typed messages between shrub LMs
  Structured by optic family (lens, prism, traversal, etc.)
  Both lateral (same level) and hierarchical (parent-child)
  This IS the Cortical Messaging Protocol
```

### Why "Overlaid"

The CMP namespace is **overlaid** on the existing Rex tree namespace. The Rex path `/dashboard/metrics/users` exists in the tree namespace. The CMP message `Vote(shrub_A → shrub_B, hypothesis, confidence)` exists in the overlaid namespace. Same tree, two address spaces — one structural, one communicative.

```
REX TREE NAMESPACE (structural, persistent):
  /dashboard
    /metrics
      /users    ← shrub, has local LM
      /revenue  ← shrub, has local LM
    /settings   ← shrub, has local LM

CMP OVERLAY (communicative, ephemeral):
  /users → /revenue : Vote(co-activation, 0.8)
  /metrics → /dashboard : Observation(feature_summary, ref_frame)
  /settings → /metrics : GoalState(time_range_filter)
```

### Message Types (Optic-Typed)

Each CMP message carries its optic family as metadata. This determines how the receiving LM processes it:

```
@cmp-message
  :from /source/shrub
  :to /target/shrub
  :optic lens           ;; or prism, traversal, grate, kaleidoscope, mixed
  :content ...          ;; payload depends on optic type

LENS messages (L2 transitions):
  View: "what is the current state at source?"
  Update: "here's what changed, integrate it"
  Algebra: S → A × (B → T) — get old, put new

PRISM messages (L5 regime):
  Match: "does this context apply to you?"
  Build: "if so, here's the pattern"
  Algebra: S → T + A — may fail to match

TRAVERSAL messages (L4 sequences):
  Extract: "give me your elements in order"
  Update: "here are new elements, reconstruct"
  Algebra: S → Σ Aⁿ ⊗ [Bⁿ, T] — iterate + rebuild

KALEIDOSCOPE messages (L6 cross-shrub reduction):
  Fold: "aggregate across your instances"
  Algebra: Π_n [Aⁿ → B] → [Sⁿ → T] — pointwise fold

MIXED messages (cross-category):
  Decompose in source category, recompose in target category
  This is what makes /revenue data meaningful to /users display
  Algebra: ∫^M C(S, M▷A) ⊗ D(M◁B, T) — existential residual
```

### Per-Shrub Learning Module

Each shrub's LM replaces the "slice of the global matrix" with an independent learning unit:

```
@shrub portfolio-tracker
  @learning-module
    :matrix-dim 512              ;; local matrix M_s[512][512]
    :sdr-dim 512                 ;; local SDR space
    :sdr-active 25               ;; ~5% sparsity
    :reference-frame spatial      ;; how this LM grounds its coordinates
    
    @local-layers                 ;; SAME six layers, but LOCAL
      :L1-frequency diag(M_s)
      :L2-transitions M_s[sdr_prev, sdr_curr]
      :L3-co-activation M_s ∧ M_s.T
      :L4-sequences M_s^n
      :L5-regime context ⊗ M_s
      ;; L6 is now REPLACED by CMP messages
    
    @cmp-ports                    ;; explicit connections to other LMs
      @lateral /dashboard/metrics/revenue :weight 0.8
      @lateral /dashboard/metrics/costs :weight 0.3
      @hierarchical-up /dashboard/metrics
      @hierarchical-down /portfolio-tracker/options
```

**Key difference**: L6 (cross-shrub) is no longer a matrix read pattern. It's replaced by CMP message passing through explicit ports. This means:

1. Cross-shrub relationships are **discovered** (new port when co-activation exceeds threshold) rather than implicit in a shared matrix
2. Cross-shrub communication is **typed** (lens, prism, traversal) rather than undifferentiated bilinear form
3. Cross-shrub bandwidth is **controllable** (port weights, message rate limits)

### Reference Frames

TBP's biggest contribution: all representations are grounded in reference frames. For PCN, this means SDR encoding must incorporate spatial structure:

```
CURRENT SDR:
  SDR(path) = ⊕ [hash(segment, depth) for segment in path]
  Encodes: path topology only

NEW SDR:
  SDR(path, ref_frame) = ⊕ [hash(segment, depth) for segment in path]
                        ⊕ ref_frame.encode(location)
  Encodes: path topology + position in reference frame
```

The reference frame lets the LM know not just *what* it's seeing but *where* it's seeing it. For UI namespaces, "where" means:
- Position in layout (which panel, which row)
- Temporal position (time of day, day of week)
- Workflow position (step N of sequence)
- Focus position (which entity is selected)

This is what TBP calls "displacement" — and it's exactly what the PCN spec already calls "context as displacement, not retrieval." The reference frame makes this formal.

### CMP Voting Protocol

TBP's lateral voting is the mechanism by which multiple LMs reach consensus. In PCN terms:

```
OLD (implicit):
  cross_shrub_correlation = sdr_A · M · sdr_B
  Global matrix encodes all cross-shrub relationships

NEW (explicit CMP voting):
  1. Shrub A makes local prediction from M_A
  2. Shrub A sends Vote(prediction, confidence) to lateral ports
  3. Shrub B receives Vote, integrates with own local prediction
  4. If vote agrees: boost confidence (Hebbian: +5)
  5. If vote disagrees: reduce confidence (anti-Hebbian: -20)
  6. Converge after K rounds (typically 2-3)
```

This is still fast — CMP messages are local to the namespace, not network calls. But it replaces the single-matrix bilinear form with structured communication.

### Hierarchical Composition (from TBP)

TBP Learning Modules connect hierarchically: a higher-level LM treats the outputs of lower-level LMs as its sensor input. This maps to PCN's shrub nesting:

```
/dashboard                          ← high-level LM
  /dashboard/metrics                ← mid-level LM (composes children)
    /dashboard/metrics/users        ← leaf LM (direct sensation)
    /dashboard/metrics/revenue      ← leaf LM (direct sensation)
  /dashboard/settings               ← mid-level LM
```

High-level LMs learn **compositional** models — they model the *relationships between* their children, not raw data. This is already implicit in the PCN's path-based SDR encoding (shared prefix = shared bits), but the CMP makes it explicit:

- `/dashboard/metrics/users` sends `Observation(feature, location_in_metrics_frame)` UP to `/dashboard/metrics`
- `/dashboard/metrics` builds a model of how users and revenue co-vary
- `/dashboard/metrics` sends `GoalState(show_correlation_view)` DOWN to children

---

## What Specifically Changes in the PCN Spec

### 1. Matrix Architecture

**Before**: One `M[2048][2048]` (~16MB), all shrubs share it.

**After**: Per-shrub `M_s[512][512]` (~1MB each), plus CMP message buffers.

For a namespace with ~50 active shrubs: 50 × 1MB = 50MB local + ~2MB CMP buffers = ~52MB total. Comparable footprint, but locally coherent.

**Replay** becomes per-shrub: each LM rebuilds from events tagged to that shrub. Faster (parallel), more robust (one corrupt shrub doesn't poison others).

### 2. The Six Layers

**Before**: Six read patterns on shared matrix.

**After**: Five LOCAL patterns on per-shrub matrix + CMP for the sixth:

```
L1  frequency         diag(M_s)                    LOCAL
L2  transitions       M_s[sdr_prev, sdr_curr]      LOCAL  
L3  co-activation     M_s ∧ M_s.T                  LOCAL
L4  sequences         M_s^n                         LOCAL
L5  regime            context ⊗ M_s                 LOCAL
L6  cross-shrub       CMP typed messages            OVERLAY
```

### 3. Learning Rule

**Before**: `M += α × outer(sdr_in, sdr_obs) × (1 + β × error)` globally.

**After**: Same Hebbian rule, but applied LOCAL to each shrub's matrix. Cross-shrub learning happens through CMP port weight adjustment:

```
When CMP vote from shrub B improves shrub A's prediction:
  port_weight(A→B) += 0.1
When CMP vote from shrub B contradicts shrub A:
  port_weight(A→B) -= 0.2
When port_weight < 0.05:
  prune port (shrubs are no longer correlated)
```

Port discovery: when L5 (regime) detects temporal co-activation between two shrubs above threshold for N events, a new CMP port is tentatively created.

### 4. Context Compiler

**Before**: `M · locality_sdr → top_k activations` (one global query).

**After**: Two-phase query:

```
PHASE 1: LOCAL (per-shrub, ~0.01ms each, parallel)
  For target shrub and its CMP-connected neighbors:
    local_activations = M_s · locality_sdr
    
PHASE 2: CMP CONSENSUS (overlay, ~0.1ms, sequential)
  Broadcast local predictions to lateral ports
  Receive votes from neighbors
  Integrate: weighted sum of (local + lateral votes)
  Top-K from integrated activations → context
```

### 5. Crystallization

**Before**: `strength(pattern) = M[pattern_sdr, pattern_sdr]` in global matrix.

**After**: Local crystallization + CMP confirmation:

```
Local crystallization (same threshold):
  M_s[pattern_sdr, pattern_sdr] > 0.8 AND event_count > 20

CMP confirmation (new):
  Pattern is also recognized by ≥2 laterally connected shrubs
  via Vote messages with confidence > 0.5
  
Only CMP-confirmed crystallizations promote to hoon state.
```

This implements TBP's "lateral voting" for consensus — a pattern isn't truly canonical until multiple LMs agree.

### 6. Optic Types on Messages

**Before**: All inter-shrub interaction is undifferentiated `sdr_A · M · sdr_B`.

**After**: Messages typed by optic family from Clarke et al.:

```hoon
+$  cmp-message
  $:  from=pith               :: source shrub path
      to=pith                  :: target shrub path
      optic=optic-type         :: lens, prism, traversal, ...
      content=cmp-content      :: typed payload
      confidence=@rs           :: sender's confidence
      timestamp=@da
  ==

+$  optic-type
  $?  %lens        :: bidirectional state sync
      %prism       :: conditional pattern match
      %traversal   :: iterate over collection
      %kaleidoscope :: fold/reduce
      %mixed       :: cross-category (different shrub types)
      %getter      :: read-only broadcast
  ==

+$  cmp-content
  $%  [%vote hypothesis=cord confidence=@rs]
      [%observation feature=cord location=sdr]
      [%goal-state desired=cord priority=@rs]
      [%prediction predicted-sdr=sdr actual-sdr=sdr error=@rs]
  ==
```

**Why optic types matter**: A `%prism` message (regime context) that fails to match is NOT an error — it's expected behavior (the prism's match function returned `Left`). A `%lens` message (state sync) that fails IS an error. The receiving LM handles them differently because it knows the optic type.

### 7. Motor System (New)

TBP's architecture includes motor outputs — the system doesn't just observe, it acts. For PCN, this means:

```
CURRENT: sensation → prediction → error → crystallization
NEW:     sensation → prediction → error → ACTION → sensation (loop)

Actions:
  - Navigate to shrub (change focus/locality)
  - Propose shortcut (motor output to UI)
  - Rearrange namespace (motor output to forge)
  - Request more data (motor output to IO)
```

The motor system is driven by **goal states** passed through CMP from higher-level LMs. This closes the sensorimotor loop that the PCN spec already identifies as necessary but doesn't formalize.

---

## Migration Path

### Phase 1: Split the Matrix
- Replace single `M[2048][2048]` with per-shrub `M_s[512][512]`
- Event log replay becomes per-shrub (parallelizable)
- No CMP yet — cross-shrub falls back to global correlation matrix as before

### Phase 2: Add CMP Ports
- Discover lateral connections from existing L6 correlations
- Replace implicit L6 with explicit CMP `Vote` messages
- Port weights learned from vote accuracy

### Phase 3: Type the Messages
- Classify existing cross-shrub interactions by optic family
- Add optic type metadata to CMP messages
- Receiving LMs dispatch on optic type

### Phase 4: Hierarchical Composition
- Parent shrubs receive `Observation` messages from children
- Parent shrubs build compositional models (models of relationships)
- Goal states flow downward through CMP

### Phase 5: Motor System
- LMs emit `Action` messages through CMP
- Motor system receives actions, executes them
- Action outcomes become new events (closing the loop)

---

## Impact on Implementation Estimates

```
CURRENT SPEC:  ~5,000 lines, 6-8 weeks

WITH OVERLAY:
  CUDA kernels:     ~2,500 lines  (per-shrub matrices, smaller but more of them)
  CMP protocol:     ~1,500 lines  (message types, routing, vote integration)
  Hoon agent:       ~2,000 lines  (same, plus CMP port management)
  GPU↔Hoon bridge:  ~500 lines    (same)
  LLM integration:  ~500 lines    (same, context compiler uses CMP consensus)
  
  TOTAL:            ~7,000 lines  (~40% increase)
  TIMELINE:         8-10 weeks    (~30% increase)
```

The increase is manageable because the per-shrub matrices are simpler (smaller, independent) and the CMP protocol is well-defined. Most of the new complexity is in port discovery and vote integration, which are straightforward Hebbian operations.

## Key Theoretical Insight

The profunctor optics paper proves that **mixed optics compose correctly across categories** (Theorem 4.14). This validates the CMP design: when shrub A (in its category, with its reference frame) sends a typed message to shrub B (in a different category, with a different reference frame), the composition is well-typed. The existentially quantified residual M in `∫^M C(S, M▷A) ⊗ D(M◁B, T)` IS the CMP message content — you can't observe the residual directly, but you can use its shape to reconstruct in the target category.

The Thousand Brains model validates the *architecture*: semi-independent LMs with structured message passing outperform monolithic shared representations. TBP's Monty system demonstrates this empirically — it learns objects from a few touches/looks, while deep learning systems require thousands of examples.

The PCN's "context is displacement, not retrieval" is already aligned with TBP's reference frame model. The overlay formalizes what the spec already intuits: context IS position in reference-frame space, sensed through the CMP, not retrieved from a global store.
