# RPE-06: PCN Behaviors — Platonic Computation Networks

## What PCN Is

PCN (Platonic Computation Networks) is the reactive dataflow layer that makes Rex trees *alive*. Without PCN, a Rex tree is a static specification. With PCN, attributes flow between nodes, state machines drive transitions, animations interpolate values, and user input propagates through the system.

PCN is to RPE what bioelectric signaling is to morphogenesis (see RPE-02): the dynamic layer that runs on top of the structural layer, enabling adaptive, responsive behavior without changing the structural specification.

## Core Primitives

### Channels

A channel is a directed data connection between tree paths:

```
@channel camera-follow
  :from /input/mouse/position
  :to /scene/camera/target
  :transform (lerp 0.1)        ;; smooth follow
  :mode continuous              ;; runs every frame
```

Compile phase: channel → compiled dataflow edge. Execute phase: evaluate source, apply transform, write to destination via pre-compiled optic. Zero tree traversal.

### Channel Modes

| Mode | Behavior | Use Case |
|---|---|---|
| `continuous` | Evaluate every frame | Animation, physics, camera follow |
| `on-change` | Evaluate when source changes | UI state propagation |
| `on-trigger` | Evaluate once when triggered | Button click, event response |
| `poll` | Evaluate every N frames | LOD updates, low-priority sync |

### Channel Transforms

Built-in transforms that run inline during channel evaluation:

```
:transform (lerp 0.1)              ;; exponential smoothing
:transform (clamp 0 100)           ;; range clamping
:transform (map [0 1] [0 255])     ;; linear remapping
:transform (deadzone 0.1)          ;; ignore small values
:transform (debounce 0.5)          ;; suppress rapid changes
:transform (quantize 0.25)         ;; snap to grid
:transform (format "HP: %d")       ;; value → string
:transform (threshold 0.5 on off)  ;; binary threshold
```

Transforms compose: `:transform [(deadzone 0.1) (lerp 0.05) (clamp -1 1)]`

## Behaviors

A behavior is a reusable computation block that can be attached to any node:

```
@behavior hover-highlight
  :input hovered :type bool :default false
  :output color :type vec3
  :output scale :type f32
  @state
    :color-base [0.3 0.3 0.4]
    :color-hover [0.5 0.6 0.8]
    :scale-base 1.0
    :scale-hover 1.05
  @rule
    :when hovered
    :set color (lerp color-base color-hover 0.2)
    :set scale (lerp scale-base scale-hover 0.15)
  @rule
    :when (not hovered)
    :set color (lerp color-base color-base 0.1)
    :set scale (lerp scale-base scale-base 0.1)
```

Attach to any node:
```
@ui-button
  :label "Settings"
  :behavior hover-highlight
  :behavior click-feedback
```

## State Machines

For complex interactive logic:

```
@state-machine player-state
  :initial idle
  
  @state idle
    @on input-move → running
    @on input-jump → jumping
    @on input-attack → attacking
    @enter
      :set /scene/player/animation idle-anim
      :set /scene/player/speed 0
  
  @state running
    @on (not input-move) → idle
    @on input-jump → jumping
    @on input-attack → attack-running
    @enter
      :set /scene/player/animation run-anim
    @tick
      :set /scene/player/speed (lerp /scene/player/speed 5.0 0.1)
      :set /scene/player/pos (add /scene/player/pos (mul /input/direction /scene/player/speed))
  
  @state jumping
    @on grounded → idle
    @enter
      :set /scene/player/animation jump-anim
      :set /scene/player/velocity-y 8.0
    @tick
      :set /scene/player/velocity-y (sub /scene/player/velocity-y 9.81)
```

Compile phase: state machine → flat transition table + action list. Execute phase: check conditions against current state, fire transitions, execute actions via optic micro-patches. The tree describes the FSM; the compiled form runs without tree access.

## Animation System

### Keyframe Tracks

```
@animation door-open
  :duration 1.5
  :easing ease-in-out
  @track rotation
    :target /scene/door/rotation
    :component y
    @key 0.0 :value 0
    @key 0.8 :value 1.4
    @key 1.5 :value 1.57
  @track emissive
    :target /scene/door-light/color
    @key 0.0 :value [0.1 0.1 0.1]
    @key 1.0 :value [0.5 0.8 1.0]
    @key 1.5 :value [0.3 0.5 0.7]
```

Compile phase: keyframe data → curve coefficients in animation buffer. Execute phase: evaluate time → interpolate → write via optic. Multiple animations can target the same node (blending by priority).

### Procedural Animation

For physics-driven or expression-driven motion:

```
@procedural wind-sway
  :target /scene/*/tree-trunk/rotation
  :expression (mul (sin (add (elapsed) (hash /target/path))) 0.05)
  :axis [0 0 1]
  :mode additive          ;; adds to existing rotation
```

Wildcard paths (`/scene/*/tree-trunk`) expand at compile time to per-instance channels. Each instance gets a unique phase offset via `(hash /target/path)` — structural variation from tree identity.

## Dependency Graph

PCN channels form a directed acyclic graph (enforced at compile time):

```
/input/mouse → /ui/cursor/position → /ui/tooltip/visibility
                                    → /scene/camera/yaw
                                    → /scene/selection/highlight

/engine/time → /animation/door-open/progress → /scene/door/rotation
                                              → /scene/door-light/color

/game/score → /ui/score-display/text
            → /ui/score-bar/width
```

Compile phase:
1. Topological sort of all channels
2. Cycle detection (cycles are errors — logged, offending channel disabled)
3. Execution order: sources before destinations
4. Batch channels that can evaluate in parallel

Execute phase: walk compiled evaluation order, apply transforms, micro-patch destinations. One pass, no iteration.

## PCN-Driven UI Patterns

### Form Validation (mirrors rex-form.html)

```
@ui-field email
  :type email
  :required true
  :validate (regex "^[^@]+@[^@]+\\.[^@]+$")
  
@channel email-validate
  :from /ui/email/value
  :to /ui/email/valid
  :transform (regex-test "^[^@]+@[^@]+\\.[^@]+$")

@channel email-error
  :from /ui/email/valid
  :to /ui/email/error-text
  :transform (threshold true "" "Invalid email address")
```

Form validation is not special — it's PCN channels with transform functions. The same system handles game logic, animation, and UI.

### Reactive Data Binding

```
@channel bind-inventory
  :from /game/player/inventory
  :to /ui/inventory-panel/items
  :mode on-change
  :transform (map-each (fn [item] { :icon item.icon :count item.count }))
```

When game state changes, UI updates automatically. No manual DOM manipulation, no event listeners. The tree structure + PCN channels ARE the reactive binding.

## Performance Considerations

### Channel Budget

Each channel evaluation costs:
- Source read: 1 optic lookup (pre-compiled offset)
- Transform: 1-5 arithmetic ops (inline, no allocation)
- Destination write: 1 optic write (pre-compiled offset)

At 10,000 channels × ~10 ops each = 100K ops per frame. Trivial for CPU. For extremely channel-heavy scenes, batch evaluate via compute shader.

### Dirty Propagation

`on-change` channels only evaluate if source actually changed. Dirty tracking is per-optic (1 bit per compiled accessor). Most frames, most channels are dormant. Only changing state propagates.

### Compilation Cost

PCN compilation (topological sort, cycle check, execution order) runs ONCE on tree structure change. Per-frame cost is pure evaluation along the pre-compiled order.

## Connection to Levin's Gap Junction Model

| Gap Junction Property | PCN Channel Property |
|---|---|
| Regulatable conductance | `:mode`, `:transform`, `:filter` |
| Bidirectional (but typically asymmetric) | Explicit direction, but pairs create bidirectional flow |
| Voltage-gated opening/closing | `:when` conditions on channels |
| Carries ions (generic cargo) | Carries any Rex value (number, array, string, struct) |
| Forms tissue-level circuits | Forms application-level dataflow graphs |
| Topology IS the computation | Channel graph IS the behavior specification |
| Long-range via gap junction cascades | Path wildcards propagate across tree regions |

The PCN system IS the bioelectric layer of the Rex organism. The tree structure IS the anatomy. PCN channels ARE the gap junctions. Behaviors ARE the tissue-level circuits. State machines ARE the developmental programs.
