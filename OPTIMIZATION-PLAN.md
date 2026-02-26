# RexGPU Transducer Optimization Plan

## Phase 1: Compiled Expression AST (behaviour + GPU)

### 1A. Add `compileExpr()` to rex-parser.js
Walk the canonical AST (`rex` field) at parse time and produce a compiled expression tree:
```js
{op:'call', fn:'add', args:[{op:'slot', path:'x'}, {op:'lit', value:1}]}
{op:'slot', path:'count'}
{op:'dep', label:'other/val'}
{op:'binding', name:'acc'}
{op:'lit', value: 42}
```
Node types: `call`, `slot`, `dep`, `binding`, `lit`, `ident`
Export as `Rex.compileExpr(exprObj)` — takes `{expr, rex}`, returns compiled tree.

### 1B. Refactor rex-behaviour.js expression evaluator
- Replace `_tokenize()` + `_evalTokens()` with `_evalCompiled(compiledAST, ctx)`
- Direct AST walk: switch on `node.op` → `call` dispatches to `_applyFn`, `slot` reads slot, etc.
- `fold` special case: body stored as compiled AST, re-evaluated per iteration with new ctx bindings
- Replace `_extractSlotRefs()` / `_extractDepRefs()` with AST walkers (collect all `slot`/`dep` nodes)
- Compile expressions once in `transduce()`, store compiled form on derives/talks/defs

### 1C. Refactor rex-gpu.js builtin expression evaluator
- Replace `_parseExprTokens()` + `_evalBuiltin()` with `_evalCompiledBuiltin(compiledAST, builtins)`
- Pre-compile expressions in `_compileOptics()`, store compiled AST in each builtin optic
- Special-case detection at compile time: tag `canvas-size`, `mouse-pos`, `mouse-delta`, `move-dir` optics with enum flags instead of string equality checks
- Cache the `builtins` dict — only recreate fields that changed

## Phase 2: Surface Transducer Optimizations

### 2A. Cache text-editor lines array
- Add `lines` field to `_editors` Map entries
- Set `ed.lines = ed.content.split('\n')` once on content mutation (handleEditorKey, initial set)
- Read `ed.lines` in `_collectTextEditor()`, `handleEditorClick()`, `handleEditorKey()`
- Invalidate (re-split) only when `ed.content` changes

### 2B. Pre-compile SVG paths to segments
- In `_collectPath()`, cache parsed segments keyed by path `d` string
- `_pathBBox()` reuses cached segments instead of re-parsing
- Cache stored as `this._svgPathCache = new Map()` — cleared on `compile()`

### 2C. Memoize `_measureElement()`
- Add `this._measureCache = new Map()` keyed by node reference
- Check cache before recursive measurement
- Clear cache at start of each `compile()` call

### 2D. Separable SDF distance transform
- Replace brute-force O(w×h×spread²) with 1D distance transform (Meijster et al.)
- Two passes: horizontal then vertical — O(w×h×spread)
- Same API: `_generateSDF(binary, w, h, spread) → Float32Array`

## Phase 3: GPU Execute-Loop Optimizations

### 3A. Cache texture views at compile time
- In `_compileTextures()`, create and store `.view` on each texture entry
- In `_executeCommandList()`, use cached views instead of `tex.createView()`

### 3B. Pre-compute bind group cache keys
- In `_compileCommandList()`, compute deterministic cache keys for each draw/dispatch bind spec
- Store key on the command object: `cmd.bgKey = \`bg_${group}_${buffer}_${storage}_${texture}\``
- In `_setBindGroup()`, use pre-computed key instead of `JSON.stringify()`

### 3C. Defer surface recompile on editor keystroke
- In main.js, replace immediate `surface.compile()` after editor key/click with dirty flag
- Check dirty flag in frame loop, recompile before surface execute

## Phase 4: Behaviour Transducer Optimizations

### 4A. Fix Kahn's sort O(N²) → O(N)
- Replace `order.includes(i)` with `Set` for O(1) membership check
- Pre-build reverse dependency adjacency list once, iterate edges in O(E) per Kahn step

### 4B. Cache cross-shrub dep resolution
- In `_orderDerives()`, resolve `%dep` labels to `(shrubName, slotName)` tuples and store on derive
- In execute, read cached resolution instead of re-resolving via `_readEnv()`

### 4C. Batch PCN episodes in main.js
- Accumulate episodes in array, flush once per frame in render loop
- Prevents ring buffer churn on rapid form/derive changes

## Phase 5: Form Transducer Optimizations

### 5A. Cache @interact node at parse time
- In `parseSource()`, cache `Rex.find(tree, 'interact')?.attrs` as `interactAttrs`
- Use cached value in pointermove/wheel handlers instead of O(n) tree scan per event
