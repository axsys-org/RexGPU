# RPE-01: Shrine Integration Map

## What Shrine Already Provides

Shrine is the Rex runtime substrate. RPE inherits these capabilities without reimplementing:

### Parser & Tree Model
```
@node-type optional-name :attr1 value :attr2 [array values]
  @child-type :inherited-scope true
    :deep-attr value
```
- Indentation-scoped nesting
- `@type name` node declarations
- `:key value` attributes (numbers, arrays, booleans, strings, paths, expressions)
- `;;` line comments
- Content blocks for raw text (shader code, markdown, etc.)

### Path Resolution
- `/scene/object/transform` → tree walk to node
- Names and types both addressable
- `Rex.resolve(root, pathStr)` — existing implementation
- `Rex.findAll(node, type)` / `Rex.find(node, type)` — type-based search

### Expression System
- `(elapsed)` → current time
- `(canvas-size)` → [width, height]
- `(sin (elapsed))` → math on builtins
- `(mul arg1 arg2)` → arithmetic combinators
- Evaluated per-frame in execute phase

### Platonic Templates
```
@platonic column
  @cylinder :scale [0.15 1.5 0.15] :color [0.75 0.72 0.68]
  @box :pos [0 1.5 0] :scale [0.25 0.08 0.25] :color [0.78 0.75 0.7]

@scene
  @instance :ref column :pos [-3 0 0]
  @instance :ref column :pos [3 0 0]
```
- Define once, instance many — compile-time template expansion
- Instances inherit platonic children with position/rotation/scale overrides

### Struct Definitions
```
@struct Uniforms
  @field time :type f32
  @field resolution :type f32x2
```
- Type-aware layout computation (alignment, padding)
- Maps to GPU buffer layouts
- Supports: f32, i32, u32, f32x2/x3/x4, f32x4x4

### Buffer Management
```
@buffer uniforms
  :struct Uniforms
  :usage [uniform]
  @data
    :time (elapsed)
    :resolution (canvas-size)
```
- Declarative buffer creation from tree
- Usage flags map to GPU buffer usage
- Per-frame data writes from expression evaluation

### Pipeline Declaration
```
@pipeline render
  :vertex triangle
  :fragment triangle
  :format canvas
  :topology triangle-list
  :blend alpha
```
- Shader module references by name
- Raster state from attributes
- Compute pipeline support (`:compute shader-name`)

### Render Pass Encoding
```
@pass main
  :clear [0.02 0.02 0.06 1.0]
  @draw
    :pipeline render
    :vertices 3
    @bind 0
      :buffer uniforms
```
- Nesting IS scoping — children execute within pass
- `@draw` with pipeline, vertex count, instances
- `@bind` for bind group setup
- `@dispatch` for compute passes

## What RPE Adds On Top

### Optic Compiler (NEW)
Shrine has path resolution at runtime. RPE pre-compiles paths to buffer accessors:

```
Shrine:  Rex.resolve(root, "/scene/obj/transform") → node → read attr → write buffer
RPE:     compiledOptic("/scene/obj/transform") → { buffer: 3, offset: 128, size: 64 }
```

The optic compiler runs in compile phase. Execute phase never touches the tree.

### Scene Compiler (EXTENDS existing)
Current `rex-projection-engine.html` has a basic `compileScene()` that flattens primitives. RPE extends this to handle:
- Mesh geometry (not just SDF primitives)
- Material system with PBR parameters
- Texture references (bindless heap indices)
- Meshlet subdivision for mesh shader pipeline
- Instance buffer management with SOA/AOS choice

### Render Graph (NEW)
Shrine's `@pass` system is sequential. RPE adds:
- Dependency tracking between passes
- Automatic barrier insertion
- Transient resource aliasing (lifetime analysis)
- Topological sort for optimal execution order

### GPU-Driven Pipeline (NEW)
Current implementation is CPU-driven (JS builds draw calls). RPE moves to:
- Compute culling → indirect draw args
- MDI per material bucket
- Visibility buffer deferred shading (for complex scenes)
- Adaptive LOD via compute

### Overflow Management (NEW)
Current `maxPrims = 128` is a hard limit. RPE adds:
- Dynamic buffer resize with optic recompilation
- LOD cascade for budget management
- Memory pressure callbacks
- Graceful degradation rather than truncation

### Text/Vector Subsystem (NEW)
Not present in current prototypes. RPE adds:
- `@text` nodes with Slug-style GPU rendering
- `@vector` nodes for Bézier path rendering
- Layout engine for 2D UI from tree structure
- Mixed 2D/3D compositing

### PCN Behavior System (EXTENDS)
Shrine has expressions `(elapsed)`. RPE adds full reactive dataflow:
- `@behavior` nodes defining state machines
- `@channel` nodes for inter-node communication
- Dependency graph compilation for change propagation
- Animation curves, physics integration, input routing

## Interface Contract: Shrine ↔ RPE

### Shrine Guarantees to RPE
1. **Stable tree model**: `{ type, name, attrs, children, content }` per node
2. **Deterministic parse**: same source → same tree (modulo content nodes)
3. **Path uniqueness**: within a scope, name+type combinations are unique
4. **Expression purity**: expression evaluation has no side effects
5. **Platonic isolation**: platonic subtrees are self-contained

### RPE Guarantees to Shrine
1. **Non-destructive**: RPE never mutates the source tree (works on compiled shadow)
2. **Hot reload**: tree structure change → incremental recompile, not full rebuild
3. **Fallback**: if compile fails, last good compiled state persists
4. **Observable**: compile/execute metrics available as tree-readable attributes

## Migration Path from Prototypes

### From `rex-projection-engine.html`
- SDF primitives → keep as `@sdf` scene type for .kkrieger-style content
- `compileScene()` → becomes one backend of the scene compiler
- WGSL raymarcher → moves into `@shader sdf-march` as a tree-embedded shader
- Platonic/instance system → already matches Shrine pattern, direct port

### From `rex-gpu.html`
- RexGPU transducer → becomes the execute phase core
- `_rebuildResources()` → becomes compile phase
- `_encodeFrame()` → becomes execute phase
- Buffer/pipeline/shader caching → becomes optic cache
- Struct layout computation → keeps existing WGPU alignment logic

### From `rex-form.html`
- Form renderer → becomes the 2D UI projection backend
- `@form`, `@field`, `@section` → UI node types in the tree
- Validation system → becomes PCN behavior (`:validate` channels)
- CSS-in-tree styling → becomes the layout engine input
