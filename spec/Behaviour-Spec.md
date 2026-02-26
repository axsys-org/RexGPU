# Rex Behaviour Specification v1

**A reactive dataflow compiler for Shrub state, mutation, and derived computation — expressed in Rex notation, compiled to kooks, projected through the same tree as rendering and prediction.**

---

## The System in One Sentence

Behaviours are Rex blocks that compile to kooks — self-contained reactive compilation units that define how Shrubs hold state, react to changes, compute derived values, and accept mutations — all through the same tree notation, path resolution, and optic framework that RPE uses for rendering and PCN uses for prediction.

---

## Why Rex, Not XML

The previous behaviour system used XML. Rex is strictly better because:

1. **Expressions inline naturally.** `(add $acc (mul $item.price $item.quantity))` vs 6 nested XML elements.
2. **Indentation encodes structure.** No close tags. Nesting is visible.
3. **Path expressions are first-class.** `/tasks/%id/done` is parsed into an AST by the Rex parser. In XML, it's a string re-parsed by the compiler.
4. **Same notation as RPE.** Behaviour and rendering are two transducers reading the same tree. One tree can contain both.
5. **Profunctor optic composition is visible.** Paths ARE composed optics: `/tasks/%id/done` = lens into `tasks` → prism on key `%id` → lens into `done`.

---

## Architecture

```
COMPILE PHASE (on structure change):
  @shrub blocks → schema (slots, kids, deps)
  @def blocks → pure gates at /NAME/def/DEFNAME
  @dep blocks → reaction kooks at /NAME/dep/LABEL
  @derive blocks → recompute kooks at /NAME/derive/SLOT
  @talk blocks → action kooks at /NAME/talk/ACTION

EXECUTE PHASE (on event):
  poke with action → /NAME/talk/ACTION
  dep changed → /NAME/dep/LABEL (if exists), then all derives
  kid changed → all derives
  dep died → /NAME/dep/LABEL (dead handler)

Each block compiles to ONE kook.
Each kook is independently compilable, replaceable, readable, portable.
```

---

## Part 1: Schema

The `@shrub` block defines the complete interface for an entity. One `@shrub` per entity.

```
@shrub NAME
  @slot NAME :type TYPE
  @slot NAME :type TYPE :default VALUE
  @kids PATH/[AURA]
    @slot NAME :type TYPE
  @dep LABEL :path PITH
```

### Slots

Typed fields. Persistent state on the Shrub.

```
@slot title :type string :default "untitled"
@slot count :type number
@slot visible :type boolean :default true
@slot created :type date
```

Types: `string`, `number`, `boolean`, `date`

### Kids

Dynamic collections keyed by aura. Like a database table with rows.

```
@kids tasks/[ud]
  @slot title :type string
  @slot done :type boolean
  @slot due :type date
```

Auras: `[ud]`=number, `[p]`=ship, `[ta]`=text, `[da]`=date, `[t]`=text

Kids are dumb data rows — no behaviour of their own. If an entity needs behaviour, make it a separate shrub. Kids can nest for graph structures:

```
@shrub org
  @slot name :type string
  @kids departments/[ta]
    @slot name :type string
  @kids departments/[ta]/teams/[ta]
    @slot name :type string
  @kids departments/[ta]/teams/[ta]/members/[p]
    @slot name :type string
```

### Deps (Schema Level)

Declares a subscription to external data. Available as `%LABEL` in all kooks.

```
@dep products :path /store/products
@dep employees :path /employees/people
```

First segment of path is shrub name. Rest is internal path. Care (value vs revision-only) is inferred by the compiler: if `%LABEL` is read anywhere → care=x (need value). If never read → care=y (event trigger only).

### Schema as Contract

The `@shrub` block IS the portable contract. Any kook that targets a matching schema can attach. The schema defines: what slots exist (state shape), what kids exist (data shape), what deps are available (external data).

---

## Part 2: Behaviour Blocks

Five block types, all top-level, all independently compilable:

| Block | Purpose | Compiles To |
|---|---|---|
| `@shrub` | Schema: slots, kids, deps | `/NAME/spec` (tale structure) |
| `@def` | Pure function | `/NAME/def/DEFNAME` (gate vase) |
| `@dep` | Reaction: side effects on dep change | `/NAME/dep/LABEL` (reaction kook) |
| `@derive` | Computed: always-recomputed slot value | `/NAME/derive/SLOT` (recompute kook) |
| `@talk` | Action: named mutation entry point | `/NAME/talk/ACTION` (action kook) |

Order: `@shrub` first, then `@def`, then `@dep`, then `@derive`, then `@talk`. Defs first so they're available to everything that follows.

---

## Part 3: Derive

```
@derive :shrub NAME :slot SLOT
  EXPR
```

Defines a formula for a single slot. Not assignment — definition. The slot's value IS the result of the expression. Recomputes after every arm (talk, dep reaction, dead) completes.

Each `@derive` targets exactly one slot. One derive per slot. Must not form cycles.

**Rules:** Can read: `/slots`, `%kids`, `%dep`, `%now`. Cannot read: `%src`, `%inputs`. Cannot mutate.

```
@derive :shrub todo :slot count
  (fold %kids/tasks 0 (add $acc 1))

@derive :shrub todo :slot remaining
  (fold %kids/tasks 0
    (if (eq $item.done false) (add $acc 1) $acc))

@derive :shrub dashboard :slot total-value
  (fold %products 0 (add $acc (mul $item.price $item.quantity)))
```

---

## Part 4: Talk

```
@talk :shrub NAME :name ACTION
  @input FIELD :type TYPE
  @guard EXPR
  MUTATIONS...
```

Named entry point for state mutation. Fires when poked by user or system.

- `@input`: typed inputs, available as `%FIELD` in expressions. At most one `@input` per talk.
- `@guard`: optional boolean expression. If false, entire talk rejected. At most one per talk.
- All mutations execute atomically.

**Rules:** Can read: `/slots`, `%kids`, `%dep`, `%now`, `%src`, `%inputs`. Can mutate.

```
@talk :shrub todo :name add-task
  @input title :type string
  @input due :type date
  @create /tasks/[auto]
    @slot title (ref %title)
    @slot due (ref %due)
    @slot done false

@talk :shrub todo :name complete
  @input id :type number
  @update /tasks/%id
    @slot done true

@talk :shrub store :name sell
  @input sku :type string
  @input amount :type number
  @guard (gte /products/%sku/quantity %amount)
  @update /products/%sku
    @slot quantity (sub /products/%sku/quantity %amount)
```

---

## Part 5: Dep Reaction

```
@dep :shrub NAME :name LABEL
  @dead
    MUTATIONS...
  MUTATIONS...
```

Side effects when a schema-level dep changes. The dep name must match a `@dep` declared in `@shrub`.

- Body mutations fire when dep data changes.
- `@dead` mutations fire when the dependency shrub dies.
- If no `@dep` block exists, changes only trigger derive recomputation.

**Rules:** Can read: `/slots`, `%kids`, `%dep`, `%now`, `%src`. Cannot read: `%inputs`. Can mutate.

```
@dep :shrub dashboard :name products
  @dead
    @set /status "disconnected"
  @each %products
    @where (lt $item.quantity 10)
    @create /alerts/[auto]
      @slot product $item.name
      @slot quantity $item.quantity
      @slot timestamp %now
```

---

## Part 6: Def

```
@def NAME :args [a b c]
  EXPR
```

Pure function. Top-level only. Can ONLY read `$args`. No `/slots`, no `%bindings`. This constraint is what makes it pure.

Compiles to a gate vase stored at a namespace pith. Any kook can call it by name via `(fn-name args...)`.

```
@def is-active :args [p]
  (eq $p.active true)

@def tax-amount :args [price rate]
  (mul $price $rate)
```

---

## Part 7: Mutations

Mutations are the only way to change state. Allowed inside `@talk`, `@dep` body, `@dead`, `@each`, and `@when`.

### Set

```
@set /PATH EXPR
```

Mutates a top-level slot declared in `@shrub`. Cannot target kid slots (use `@update`). Cannot target `@derive` slots.

### Create

```
@create /PATH/[auto]
  @slot NAME EXPR
```

Creates a new kid. `[auto]` = next available key. `%input` = use an action input as key.

### Update

```
@update /PATH/%id
  @slot NAME EXPR
```

Partial update to kid slots. Only listed slots change. Works with known path or `$item` inside `@each`.

### Remove

```
@remove /PATH/%id
@remove $item
```

Delete a kid by path. Works with known path or `$item` inside `@each`.

### Each

```
@each COLLECTION
  @where EXPR
  MUTATIONS...
```

Iterate a kids collection with side effects. `$item` = current element. `$key` = current key. `@where` = optional filter.

Collections only appear as `@each` and `@fold` targets. They are never passed as arguments.

### When

```
@when EXPR
  MUTATIONS...
```

Conditional side effects. Expression must return boolean. Can nest.

---

## Part 8: Paths

Three prefixes:

```
/  = this shrub's state
   /title              own slot
   /tasks/3/done       kid's slot
   /path/%input        interpolated

%  = runtime environment
   %kids/PATH          kids collection (only in each/fold)
   %src                ship that sent action (talk/dep only)
   %now                current time
   %FIELD              action input (talk only)
   %LABEL              dependency data (from schema @dep)
   %LABEL/PATH         dep collection (only in each/fold)

$  = local binding
   $item               current element in fold/each
   $item.field         read slot from current element
   $key                current key in each
   $acc                accumulator in fold
   $ARG                argument in @def
```

Path interpolation: `/products/%sku/quantity` resolves `%sku` from action input, uses as key.

### Paths as Composed Optics

Each path prefix maps to an optic type from the profunctor framework (Clarke et al. 2020):

| Path | Optic | Focus |
|---|---|---|
| `/title` | Lens | Slot in this shrub |
| `/tasks/3/done` | Composed lens | Slot in specific kid |
| `/tasks/%id` | Affine (lens + prism) | Kid that may not exist |
| `%products` | Prism | External dep (may be absent) |
| `$item.price` | Lens within traversal | Current element's field |
| `$acc` | Lens | Accumulator state |

A `@derive` is a **view** (read-only). A `@set` is a **set** (write through a lens). A `@fold` is a fold over a **traversal** — the `Wander` constraint. A `@dep` reaction is triggered by a **prism** focus changing.

The path `/tasks/%id/done` decomposes categorically:

```
lens(tasks) ∘ prism(%id) ∘ lens(done) : Optic (Strong, Choice) Shrub Bool
```

The coend over the residual (the rest of the shrub around the focused `done` field) is quantified away — the mutation doesn't know or care what other kids or slots exist. Same categorical structure as RPE's compiled optics (path → byte offset) and PCN's SDR decomposition (path → bit vector).

---

## Part 9: Expressions

Every expression produces a value. No side effects. All values are vases (typed values).

### Ref

```
(ref /path)
;; or just the path inline where unambiguous:
/title
$item.name
%amount
```

### Function Call

```
(fn-name arg1 arg2 ...)
(add $acc 1)
(mul $item.price $item.quantity)
(is-active $item)
```

### If

```
(if TEST THEN ELSE)
(if (eq $item.done false) (add $acc 1) $acc)
```

Pure value expression. All three branches required. For conditional side effects, use `@when`.

### Fold

```
(fold COLLECTION INITIAL EXPR)
(fold %kids/tasks 0 (add $acc 1))
(fold %kids/products 0 (add $acc (mul $item.price $item.quantity)))
```

Reduce collection to single value. `$item` = current element. `$acc` = running accumulator.

### Literal

```
42
"hello"
true
false
```

Compiler infers type: `true`/`false` → boolean, digits → number, otherwise → string.

---

## Part 10: Standard Library

All functions take and return vases. No collection functions — use `@fold` and `@each`.

```
;; Arithmetic
add sub mul div

;; Comparison
eq neq gt lt gte lte

;; Logic
and or not

;; String
concat
fmt                ;; "{} has {} items" with positional args

;; Null
has                ;; (has /tasks/5) → boolean
or-else            ;; (or-else /tasks/5/title "untitled") → value
```

---

## Part 11: Multi-Shrub Systems

Most apps are multiple shrubs that communicate.

- Each shrub owns its own state. No shrub mutates another directly.
- Shrubs READ from others via `@dep` (declared in schema).
- Shrubs REACT to changes via `@dep` blocks (behavioural reaction).
- Same owner, same lifecycle, tightly related → one shrub.
- Different owner, different concerns → separate shrubs with deps.

**Splitting rule:** If one kids collection needs to reactively cause changes in another kids collection, they belong in separate shrubs connected by a `@dep`. A single shrub's `@derive` is pure computation only — no side effects. This constraint keeps shrubs small and reactive relationships visible.

---

## Part 12: Context Table

```
             /slots  %kids  %dep  %now  %src  %input  $item  $key  mutations
@derive       yes    yes    yes   yes   NO    NO      -      -     NO
@dep body     yes    yes    yes   yes   yes   NO      -      -     yes
@dead         yes    yes    yes   yes   yes   NO      -      -     yes
@talk         yes    yes    yes   yes   yes   yes     -      -     yes
@each         yes    yes    yes   yes   yes   yes     yes    yes   yes
@when        (inherits enclosing context)
@def          NO     NO     NO    NO    NO    NO    $args    NO    NO
@fold        (inherits enclosing read context, plus $item/$acc)
```

`%kids` and `%dep` collections appear ONLY as `@each`/`@fold` targets. Never as function arguments.

---

## Part 13: Compile Errors

Rejected at compile time:
- `@set` targeting a `@derive` slot
- `@set` targeting a kid slot (use `@update`)
- `%src` or `%inputs` in `@derive`
- `/` or `%` in `@def`
- Any mutation in `@derive`
- `@guard` outside `@talk`
- `@input` outside `@talk`
- `@where` outside `@each`
- Mutations inside `(if ...)` or `(fold ...)`
- `@def` inside any expression (top-level only)
- Duplicate `@shrub` names
- Duplicate `@talk` names within same shrub
- `@dep` block name not declared in `@shrub` schema
- `@derive` targeting undeclared slot
- `@derive` targeting same slot twice
- Derive dependency cycles
- Path interpolation (`%input`) outside `@talk`
- Behavioural block before `@shrub` block

Runtime (silently handled):
- `(ref ...)` to nonexistent path → null
- Division by zero → null
- `@remove` nonexistent kid → no-op
- `@guard` non-boolean → treated as false

---

## Part 14: Integration with RPE and PCN

### Same Tree, Three Projections

A single Rex tree can contain behaviour, rendering, and prediction:

```
@shrub todo-app
  @slot title :type string :default "My Todos"
  @slot count :type number
  @kids tasks/[ud]
    @slot title :type string
    @slot done :type boolean

  ;; BEHAVIOUR — compiled by behaviour transducer → kooks
  @derive :slot count
    (fold %kids/tasks 0 (add $acc 1))
  @talk add-task
    @input title :type string
    @create /tasks/[auto]
      @slot title (ref %title)
      @slot done false

  ;; RENDERING — compiled by GPU transducer → command list
  @struct TaskUniforms
    @field count :type f32
    @field time :type f32
  @buffer task-buf :struct TaskUniforms
    @data count (form/count) time (elapsed)
  @pass main :clear [0.1 0.1 0.1 1]
    @draw :pipeline task-pipe :vertices 3
      @bind 0 :buffer task-buf
```

Three transducers, one tree:
- **Behaviour transducer** claims `@shrub`, `@derive`, `@talk`, `@dep`, `@def` → compiles to kooks
- **GPU transducer** claims `@struct`, `@buffer`, `@pass`, `@draw`, `@pipeline` → compiles to command list
- **PCN transducer** claims episodes from namespace events → compiles to SDR updates

### Shared Path Resolution

All three projections use the same path resolution over the same Shrub tree:
- **Behaviour:** `/todo-app/count` → kook dispatch pith
- **RPE:** `/todo-app/count` → heap byte offset (via compiled optic)
- **PCN:** `/todo-app/count` → SDR bit vector (via path hash)

### Channel Bridge

```
@channel task-count-display
  :from /todo-app/count        ;; behaviour derive output
  :to /task-buf/count           ;; GPU heap offset
  :mode on-change
```

The channel is a composed optic: source lens (behaviour state) → destination lens (heap offset). The notation makes the optic composition explicit.

### RPE Event Bridge → PCN Episodes

Every `@talk` invocation, `@dep` reaction, and `@derive` recomputation is a namespace event. The PCN event bridge converts these to episodes:

```
episode:
  source: %talk
  shrub: "todo-app"
  talk: "add-task"
  inputs: {title: "Buy groceries"}
  → SDR encoding → memory matrix update
```

The PCN learns behavioural patterns from the same tree that the behaviour transducer mutates and RPE renders.

---

## Part 15: LLM Edit Protocol

Every block has a unique address formed by its attributes. To modify a behaviour document:

### Add

```
;; ADD
@talk :shrub store :name bulk-restock
  @input amount :type number
  @each %kids/products
    @update $item
      @slot quantity (add $item.quantity %amount)
```

### Replace

```
;; REPLACE @derive :shrub store :slot total-value
@derive :shrub store :slot total-value
  (fold %kids/products 0 (add $acc (mul $item.price $item.quantity)))
```

### Delete

```
;; DELETE @dep :shrub payroll :name people
```

One edit = one kook = one compilation. The LLM does not need the full document.

---

## Part 16: Examples

### Todo App

```
@shrub todo
  @slot title :type string :default "My Todos"
  @slot count :type number
  @slot remaining :type number
  @kids tasks/[ud]
    @slot title :type string
    @slot due :type date
    @slot done :type boolean

@derive :shrub todo :slot count
  (fold %kids/tasks 0 (add $acc 1))

@derive :shrub todo :slot remaining
  (fold %kids/tasks 0
    (if (eq $item.done false) (add $acc 1) $acc))

@talk :shrub todo :name add-task
  @input title :type string
  @input due :type date
  @create /tasks/[auto]
    @slot title (ref %title)
    @slot due (ref %due)
    @slot done false

@talk :shrub todo :name complete
  @input id :type number
  @update /tasks/%id
    @slot done true

@talk :shrub todo :name remove-task
  @input id :type number
  @remove /tasks/%id

@talk :shrub todo :name complete-all
  @each %kids/tasks
    @update $item
      @slot done true

@talk :shrub todo :name clear-done
  @each %kids/tasks
    @where (eq $item.done true)
    @remove $item
```

### Store + Dashboard (Multi-Shrub)

```
@shrub store
  @slot name :type string :default "Main Store"
  @kids products/[ta]
    @slot name :type string
    @slot price :type number
    @slot quantity :type number

@shrub dashboard
  @slot total-products :type number
  @slot total-value :type number
  @kids alerts/[ud]
    @slot product :type string
    @slot quantity :type number
    @slot timestamp :type date
  @dep products :path /store/products

@dep :shrub dashboard :name products
  @each %products
    @where (lt $item.quantity 10)
    @create /alerts/[auto]
      @slot product $item.name
      @slot quantity $item.quantity
      @slot timestamp %now

@derive :shrub dashboard :slot total-products
  (fold %products 0 (add $acc 1))

@derive :shrub dashboard :slot total-value
  (fold %products 0 (add $acc (mul $item.quantity $item.price)))

@talk :shrub store :name add-product
  @input sku :type string
  @input name :type string
  @input price :type number
  @input quantity :type number
  @create /products/%sku
    @slot name (ref %name)
    @slot price (ref %price)
    @slot quantity (ref %quantity)

@talk :shrub store :name sell
  @input sku :type string
  @input amount :type number
  @guard (gte /products/%sku/quantity %amount)
  @update /products/%sku
    @slot quantity (sub /products/%sku/quantity %amount)

@talk :shrub store :name restock
  @input sku :type string
  @input amount :type number
  @update /products/%sku
    @slot quantity (add /products/%sku/quantity %amount)

@talk :shrub dashboard :name clear-alerts
  @each %kids/alerts
    @remove $item
```

### Employee + Payroll (Multi-Shrub with Dead Handler)

```
@shrub employees
  @slot headcount :type number
  @kids people/[ta]
    @slot name :type string
    @slot email :type string
    @slot dept :type string
    @slot role :type string
    @slot rate :type number
    @slot active :type boolean

@shrub payroll
  @slot last-run :type date
  @slot status :type string :default "ok"
  @kids records/[ud]
    @slot employee :type string
    @slot amount :type number
    @slot period :type date
    @slot status :type string
  @dep people :path /employees/people

@def is-active :args [p]
  (eq $p.active true)

@derive :shrub employees :slot headcount
  (fold %kids/people 0
    (if (is-active $item) (add $acc 1) $acc))

@dep :shrub payroll :name people
  @dead
    @set /status "disconnected"
  @each %people
    @where (is-active $item)
    @create /records/[auto]
      @slot employee $key
      @slot amount 0
      @slot period %now
      @slot status "active"

@talk :shrub employees :name hire
  @input id :type string
  @input name :type string
  @input email :type string
  @input dept :type string
  @input role :type string
  @input rate :type number
  @create /people/%id
    @slot name (ref %name)
    @slot email (ref %email)
    @slot dept (ref %dept)
    @slot role (ref %role)
    @slot rate (ref %rate)
    @slot active true

@talk :shrub employees :name terminate
  @input id :type string
  @update /people/%id
    @slot active false

@talk :shrub payroll :name run-payroll
  @each %kids/records
    @where (eq $item.status "active")
    @update $item
      @slot period %now
  @set /last-run %now
```

---

## Part 17: Design Principles

```
SCHEMA IS CONTRACT.          @shrub defines the interface. Kooks are implementation.
ONE BLOCK, ONE KOOK.         Independently compilable, replaceable, readable, portable.
DERIVE IS PURE.              No side effects. Just computation.
TALK IS ATOMIC.              All mutations in one talk execute together.
DEPS ARE EXPLICIT.           Every external subscription visible in schema.
PATHS ARE OPTICS.            / is lens, % is prism, $ is traversal binding.
REX IS THE NOTATION.         Same syntax for behaviour, rendering, prediction.
THE TREE IS THE APP.         Behaviour + rendering + prediction coexist in one tree.
COMPILE RESOLVES.            Paths → piths at compile time. Dispatch at runtime.
SPLITTING IS VISIBLE.        If kids need to cause changes in other kids → separate shrubs.
```

---

## References

**Profunctor optics.** Clarke et al. "Profunctor Optics, a Categorical Update." arXiv:2001.07488, 2020. The path decomposition (`/slots` as lenses, `%deps` as prisms, `@fold` as Wander traversal) maps directly to the optic hierarchy. The coend over the residual explains why mutations don't need to know about unrelated state.

**RPE Specification v2.** Rex Projection Engine. Same tree, same path resolution, different projection (paths → byte offsets for GPU heap). The `@channel` system bridges behaviour state to render state.

**PCN Specification v4.** Predictive Coding Namespace. Same tree, same path resolution, different projection (paths → SDR bit vectors for memory matrix). Episodes from behaviour events feed the learning loop.

**PLAN.** Kooks compile to PLAN Laws. Event log entries are Pins. Orthogonal persistence means behaviour state survives restart without explicit serialization.
