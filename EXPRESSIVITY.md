# Expressivity Gaps — Execution Plan

## Tier 1: Blocks Real Programs

### 1. Input Key Extensibility
**Status: DONE**
- `_inputKeys` mutable Set on GPU instance (was hardcoded `INPUT_KEYS`)
- `registerInputKey(code)` — register any key code for preventDefault
- `registerKeyBinding(code, axis, value)` — map key to movement axis
- Custom bindings applied in `_updateInputBuiltins()`

### 2. Stdlib Expansion
**Status: DONE**
- Trig: `tan`, `atan`, `atan2`, `asin`, `acos`
- Logarithmic: `log`, `log2`, `exp`
- Bitwise: `band`, `bor`, `bxor`, `bnot`, `shl`, `shr`
- String: `substr`, `upper`, `lower`, `trim`, `replace`, `split`, `join`, `index`
- Math: `sign`, `fract`, `step`, `smoothstep`
- Constants: `pi()`, `tau()`
- Type coercion: `to-num`, `to-str`
- `mix` as alias for `lerp`
- `concat` now variadic (N args)

### 3. @def Callable From All Expressions
**Status: DONE**
- `behaviour.callDef(name, args)` — public method for external callers
- `behaviour.hasDef(name)` — check existence
- Surface eval context: `resolve('call', name, args)` → `behaviour.callDef()`
- Form eval context: same pattern
- Wired in main.js: `surface.behaviour = behaviour`, `form.behaviour = behaviour`

### 4. Font Configurability
**Status: DONE**
- `surface._sdfFont` property (default: `'48px monospace'`)
- `surface.setFont(fontSpec)` — change font, invalidates atlas + glyph cache
- All `SDF_FONT` references replaced with `this._sdfFont` in instance methods

### 5. Hit Test Wiring
**Status: DONE**
- `_hitReadbackBuffer` — staging buffer for async GPU readback
- After `queue.submit()`: `copyBufferToBuffer` → `mapAsync` → read element ID
- `surface.onHitChange(elementId)` — fires on hover change
- `surface.onElementClick(elementId, x, y)` — fires on click
- `surface.registerClick(x, y)` — called from main.js on pointerdown
- Click → `behaviour.fireTalk('_surface', 'click', {element, x, y})`
- `behaviour.fireTalk(shrub, action, params)` — external @talk trigger with param context

### 6. GPU → Behaviour Readback
**Status: DONE**
- `@readback` node type: `:from bufferName :offset 0 :count 4`
- Compiles staging buffers alongside source storage buffers
- After `queue.submit()`: `copyBufferToBuffer` → `mapAsync` → read Float32Array
- `gpu.onReadback(name, values)` callback → `behaviour.pushFormValue(name, val)`
- Non-blocking: skips readback if previous one still pending

### 7. Blend Mode Expansion
**Status: DONE**
- `BLEND_MODES` lookup table replaces hardcoded if/else
- `alpha`, `additive`, `multiply`, `screen`, `premultiplied`
- Unknown blend modes log warning

### 8. Channel Modes
**Status: DONE**
- `on-change` (default), `every-frame` (existing)
- `once` — fire on first change only
- `throttle` — respect `:delay` ms between pushes
- `debounce` — wait `:delay` ms after last change before pushing

## Tier 2: Remaining

### 9. Conic Gradients
**Status: TODO**
- Add FILL_CONIC constant
- Implement angle-based interpolation in fine rasterizer WGSL

### 10. SVG Arc Command
**Status: TODO**
- Parse A/a command in @path
- Convert arc params to cubic bezier segments

### 11. Template Conditionals + Loops
**Status: TODO**
- @if param in template expansion
- @repeat N with index variable

### 12. Animation/Tween System
**Status: TODO**
- @tween node: target slot, duration, easing
- Built-in easings: linear, ease-in, ease-out, ease-in-out, cubic-bezier
- Drive via frame delta time
