# RPE-02: Levin Isomorphisms — Morphogenetic Computation Model

## The Core Isomorphism

Michael Levin's research demonstrates a deep structural symmetry between neural computation (brains navigating behavioral space) and developmental bioelectricity (cell collectives navigating anatomical morphospace). The RPE exploits an *additional* isomorphism: between morphogenesis and rendering engines.

```
NEUROSCIENCE          MORPHOGENESIS          REX PROJECTION ENGINE
─────────────         ─────────────          ─────────────────────
Neurons               Somatic cells          Tree nodes
Action potentials     Bioelectric signals    Attribute changes
Synaptic plasticity   Gap junction gating    PCN channel routing
Neural circuit        Tissue circuit         Compiled optic graph
Memory (engram)       Bioelectric prepattern Compiled buffer layout
Behavior              Anatomical outcome     Rendered frame
Learning              Regeneration           Hot reload / recompile
Sensory input         Morphogen gradient     User input / DAG amendment
Motor output          Cell migration         GPU draw commands
```

## Multiscale Competency Architecture

Levin's TAME (Technological Approach to Mind Everywhere) framework describes biological systems as nested hierarchies where each level solves problems with some competency in its own action space. RPE mirrors this:

### Level 0: Byte (Molecular)
- **Biology**: Ion channel states, molecular concentrations
- **RPE**: Individual buffer bytes, GPU register values
- **Competency**: Correct encoding, alignment, format compliance

### Level 1: Node (Cellular)
- **Biology**: Single cell membrane potential, gene expression state
- **RPE**: Single tree node with attributes, compiled to buffer region
- **Competency**: Self-consistent attribute state, valid parameter ranges

### Level 2: Platonic (Tissue)
- **Biology**: Cell collective forming organ-level bioelectric pattern
- **RPE**: `@platonic` template defining reusable structural unit
- **Competency**: Internal consistency (children compose correctly), valid mesh/material

### Level 3: Scene (Organism)
- **Biology**: Whole-organism morphogenetic program
- **RPE**: `@scene` root containing full render specification
- **Competency**: Correct render graph, valid pass ordering, resource lifetime management

### Level 4: Application (Swarm/Ecosystem)
- **Biology**: Multi-organism collective behavior
- **RPE**: Multiple scenes, hot-swappable trees, streaming level management
- **Competency**: Memory budget management, async loading, graceful degradation

Each level deforms the energy landscape for levels below. A `@scene`-level LOD decision changes which `@platonic` instances compile, which changes which nodes contribute to buffers, which changes byte layout. Top-down causation through tree structure.

## Pattern Homeostasis → Overflow Recovery

Levin's most striking finding: planaria regenerate correct anatomy from ANY initial fragment. The morphogenetic code implements *target maintenance* — the system knows what it should look like and actively works toward that goal.

RPE's overflow manager implements the same principle:

### Target Morphology = Intended Frame
The Rex tree describes the *intended* visual output. When resources are insufficient (too many primitives, not enough memory, shader too complex), the engine doesn't just truncate — it *degrades toward the target* using the same tree structure:

```
Full fidelity          → mesh with PBR materials, all LODs
Memory pressure L1     → reduce LOD globally, drop distant detail
Memory pressure L2     → billboard imposters for far objects
Memory pressure L3     → particle representations
Memory pressure L4     → bounding box wireframes
Emergency              → sky + ground plane only
```

The tree retains full specification at all times. The projection quality adapts. This IS pattern homeostasis: the "body" (GPU output) may lose detail, but the "bioelectric pattern" (Rex tree) maintains the complete morphogenetic code. When resources return, full fidelity regenerates without re-specification.

### Bioelectric Prepattern = Compiled Optics
Levin shows bioelectric patterns (voltage distributions across cell membranes) encode target anatomy *before* the anatomy exists. Similarly, compiled optics encode the full buffer layout *before* any frame renders. The optic map IS the prepattern — it specifies where every piece of data will go, even if the current frame can't render it all.

## Regulative Development → Hot Reload

Embryonic development is *regulative* — disturb early stages and the system self-corrects. RPE's compile phase is regulative:

- **Delete a subtree**: optics for that region invalidate, buffers compact, render continues
- **Add nodes**: new optics compile, buffers extend, seamless integration
- **Modify attributes**: micro-patch via pre-compiled optic, no recompile needed
- **Restructure tree**: full recompile of affected subtrees only (subtree hashing)

The system never needs a "restart" — every structural change is absorbed and adapted, exactly as regulative embryogenesis absorbs perturbation.

## Gap Junctions → PCN Channels

In Levin's framework, gap junctions are regulatable connections between cells that allow bioelectric signals to propagate. They implement a communication topology that is both structural AND functional — the same gap junction can carry different signals at different times.

PCN (Platonic Computation Network) channels are the RPE equivalent:

```
@channel transform-sync
  :from /scene/controller/output
  :to /scene/character/transform
  :mode continuous
  :latency 0

@channel lod-broadcast
  :from /scene/camera/frustum
  :to /scene/*/lod-selector
  :mode on-change
  :latency 1
```

Like gap junctions:
- Channels connect arbitrary tree nodes (not limited to parent-child)
- Channel conductance is regulatable (`:mode`, `:latency`, `:filter`)
- Multiple signals can traverse the same channel structure
- Channel topology itself is part of the tree (inspectable, modifiable)

## The Polycomputing Frame

Levin's "polycomputing" concept: the same physical substrate simultaneously computes multiple things. A cell membrane's voltage state is simultaneously:
- A signal to neighboring cells (communication)
- A readout of metabolic state (measurement)
- A trigger for gene expression (actuation)
- A component of the tissue-level pattern (collective computation)

A Rex tree node is simultaneously:
- A specification of visual output (render data)
- A participant in the optic composition (compile-time type)
- A carrier of behavioral state (PCN participant)
- A target for interactive manipulation (DAG amendment co-parameter)
- A unit of cache invalidation (subtree hash component)

This polycomputing property is what makes the tree substrate *efficient* — a single data structure serves all subsystems without redundant representation.

## Symposium Contributors & Adjacent Frameworks

### Chris Fields (Quantum Information, Levin collaborator)
- **Holographic screens**: boundaries between systems encode information about interiors
- **RPE parallel**: render pass boundaries encode information about scene structure; visibility buffer IS a holographic screen of the 3D scene

### Karl Friston (Free Energy Principle, active inference)
- **Active inference**: organisms minimize surprise by acting to confirm predictions
- **RPE parallel**: GPU-driven culling IS active inference — the engine predicts what's visible (from camera + scene bounds) and acts to confirm (only renders visible geometry)

### Giovanni Pezzulo (Levin collaborator, embodied cognition)
- **Body as prediction machine**: anatomy maintained by predictive processing
- **RPE parallel**: compiled optics are *predictions* about buffer layout; execute phase *confirms or updates* those predictions each frame

### Sara Walker (Assembly Theory, information architecture)
- **Assembly index**: minimum steps to construct an object from basic parts
- **RPE parallel**: compile phase computes *assembly paths* from tree primitives to GPU state; lower assembly index = more efficient compilation
