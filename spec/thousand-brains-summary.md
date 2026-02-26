# The Thousand Brains Project: Summary

**Authors:** Viviane Clay, Niels Leadholm, Jeff Hawkins (Numenta, Dec 2024)
**Code:** https://github.com/thousandbrainsproject/tbp.monty

## Core Thesis

An alternative AI paradigm derived from neocortical operating principles. Instead of scaling deep learning on static datasets, build sensorimotor agents that learn structured world models through active interaction — the way brains actually work.

## Key Insight: Mountcastle's Principle

The neocortex reuses a single computational unit — the **cortical column** — thousands of times. All intelligence (vision, touch, hearing, language, abstract thought) emerges from the same algorithm applied repeatedly.

## Architecture: Three Components

### 1. Sensor Modules (SM)
- Receive raw input from a **small sensory patch** (like a retinal patch or fingertip)
- Convert to the **Cortical Messaging Protocol (CMP)**: a feature at a pose (3D location + orientation)
- Modality-specific processing happens here; output is modality-agnostic

### 2. Learning Modules (LM)
- The core repeating unit, modeled on cortical columns
- Each LM is a **semi-independent sensorimotor system** that can:
  - Learn complete object models on its own
  - Recognize objects at novel poses
  - Generate motor outputs (goal states)
- Models are structured via **reference frames** — objects are collections of features at locations, like CAD models
- Current implementation: explicit 3D graphs in Cartesian space (future: grid cells)

**Internal structure:**
- **Buffer** (short-term memory): current episode observations
- **Graph Memory** (long-term memory): stored object models as graphs with nodes (pose + features) and edges (displacements)
- **Goal-State Generator**: produces motor outputs for action policies

**Evidence-based inference:**
1. Initialize hypotheses: all known objects x all locations x possible rotations
2. Each observation updates evidence per hypothesis using displacement + feature matching
3. Morphology (shape/location) can add/subtract evidence; features only add
4. Terminal: single hypothesis wins, no match (new object), or timeout

### 3. Motor System
- Translates CMP-compliant goal states into actuator commands
- Reverse role of sensor modules

## Cortical Messaging Protocol (CMP)

The universal interface between all components. Every message contains:
- **Location** (relative to body or common reference frame)
- **Morphological features**: 3x3 orthonormal vectors (point normal, curvature directions)
- **Non-morphological features**: color, texture, curvature magnitude (optional)
- **Confidence** [0, 1]
- **Sender ID** and **sender type**

Key design choice: **relative locations of features matter more than the features themselves.** (Fruits arranged as a face are recognized as a face.)

## Multi-LM Interactions

### Voting (Lateral)
- LMs share hypotheses (object ID + pose) with connected LMs
- Enables "flash inference" — recognize objects without movement by using multiple sensor patches
- Works across modalities (votes are modality-agnostic)
- Pose-aware: accounts for relative sensor displacement, not just bag-of-features

### Hierarchy (Vertical)
- Lower LM recognizes a part (e.g., tire) → outputs object ID as feature to higher LM
- Higher LM models compositions (e.g., car = tire + body + windshield at relative poses)
- Enables compositional object representation and reuse

### Heterarchy
- Skip connections, top-down biasing, every LM has direct motor output
- Not a strict hierarchy — more like the actual neocortex

## Action Policies

### Model-Free
- **Curvature-informed**: follow principal curvature directions on object surfaces (e.g., trace the rim of a cup)
- Random walk with momentum
- Reflexive stay-on-object behavior

### Model-Based
- **Hypothesis-testing**: overlay top-2 hypothesized object graphs, find maximally distinguishing point, jump sensor there
- **Goal-state decomposition**: high-level LM decomposes goals into sub-goals for lower LMs
- Uses internal models for planning — like mentally rotating objects

## Core Principles

| Principle | Description |
|-----------|-------------|
| Sensorimotor | Learns from temporal sequences of sense + move, not static datasets |
| Modular | Same algorithm for all modalities; easily scalable |
| Reference Frames | All models are spatially structured; inductive bias for 3D world |
| Rapid Learning | Hebbian-like; learn from few samples; continual; no training phase |
| Voting | Multiple experts reach faster, more robust consensus |
| Model-Based + Free | Structured models for novel situations; efficient habits for routine |

## What This Is NOT

- Not deep learning — no gradient descent, no massive static training
- No "full image" anywhere — each LM sees only a small patch
- Not separate sensory→motor pipeline — every LM is sensorimotor
- Not a bag of features — spatial structure is primary

## Current Implementation (Monty)

- Environment: Habitat 3D simulator
- Objects: YCB dataset (77 objects)
- Sensors: RGBD camera patches (zoomed 10x for small receptive fields)
- Agents: distant (eye-like, ball-and-socket) and surface (finger-like, follows object surface)
- Learning: unsupervised, from scratch, updated after every episode
- Evaluation: object recognition + pose estimation

## Capabilities Targeted

- Pose-invariant object recognition
- Few-shot learning
- Continual learning without catastrophic forgetting
- Compositional object understanding
- Cross-modal transfer (learn via vision, recognize via touch)
- Model-based planning and manipulation
- Hypothesis-driven active sensing
- Scale invariance, occlusion handling, deformation tolerance

## Relevance to PCN / Rex

The Thousand Brains architecture shares deep structural parallels with predictive coding networks:
- **Reference frames ↔ spatial optics**: both ground representation in structured coordinate systems
- **CMP ↔ shrub messaging**: universal protocol for heterogeneous modules
- **Evidence accumulation ↔ prediction error**: iterative belief updating
- **Voting ↔ lateral inhibition**: consensus across parallel hypotheses
- **Sensorimotor loop ↔ active inference**: action and perception inseparable
- **Compositional hierarchy ↔ shrub composition**: parts assemble into wholes via reference frames
