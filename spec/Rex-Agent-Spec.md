# Rex Agent Notation — Specification v2

**Version 2.0 — March 2026**

> *"Agents are shrubs + fibers. The tree specifies the agent. The fiber executes it. The optics connect them."*
> *No new runtime. Just notation over the RPE stack.*
> *— RPE Agent Thesis v2*

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Agent = Shrub + Root Fiber](#2-agent--shrub--root-fiber)
3. [Prompt Assembly as @derive](#3-prompt-assembly-as-derive)
4. [Tool Definitions as Profunctor Optics](#4-tool-definitions-as-profunctor-optics)
5. [Context Sources as Media-Style DAG](#5-context-sources-as-media-style-dag)
6. [Memory & Heap](#6-memory--heap)
7. [Multi-Agent Delegation as Fiber Spawn](#7-multi-agent-delegation-as-fiber-spawn)
8. [Observation & Learning](#8-observation--learning)
9. [Template Composition](#9-template-composition)
10. [Execution Model: CommandRing](#10-execution-model-commandring)
11. [Dynamic Constrained Decoding](#11-dynamic-constrained-decoding)
12. [Compilation Model](#12-compilation-model)
13. [Grammar Extensions](#13-grammar-extensions)
14. [Examples](#14-examples)
15. [Comparison: Rex vs JSON+MD](#15-comparison-rex-vs-jsonmd)

**Appendices**
- [A: Stdlib Extensions](#appendix-a-standard-library-extensions)
- [B: Lifecycle as Fiber States](#appendix-b-lifecycle-as-fiber-states)
- [C: Security Model](#appendix-c-security-model)
- [D: Migration Guide (v1 → v2)](#appendix-d-migration-guide-v1--v2)

---

## 1. Design Principles

### 1.1 The Problem

Agent frameworks scatter configuration across files:

```
agent/
  config.json          ← model, temperature, limits
  system-prompt.md     ← personality, rules
  tools.json           ← tool schemas
  tools/
    read_file.py       ← tool implementations
    search.py
  memory/
    config.yaml        ← vector DB settings
  prompts/
    task.md            ← task template
    few-shot.json      ← examples
  orchestrator.py      ← glue code
```

No composition model. No reactivity. No type checking. No learning. Static templates with string interpolation. Copy-paste between agents. No formal relationship between tool definitions and tool invocation policy.

### 1.2 The Thesis

**Agents are shrubs + fibers.** The tree specifies the agent. The fiber executes it. The optics connect them.

| Agent Concept | Rex Primitive | Fiber Primitive | Mechanism |
|---|---|---|---|
| Agent state | `@shrub` schema | — | Typed slots with :min/:max |
| Pure helpers | `@def` | — | Stateless functions |
| Computed values | `@derive` | — | Topologically ordered, dirty-tracked |
| Actions | `@talk` | — | Guarded, atomic mutations |
| Reactions | `@dep` | — | Cross-agent subscriptions |
| External bridges | `@channel` | `rexUseResource` | Slot ↔ API bindings, managed lifecycle |
| Prompt text | Content blocks | — | `''...''` with $param substitution |
| Prompt assembly | `@derive` | — | Reactive, dirty-tracked, budget-aware |
| Reuse | `@template/@use` | — | Parameterized expansion |
| Learning | ShrubLM | — | Per-agent reference frame modules |
| Self-healing | Surprise → recovery | — | Goal-state generation, source amendment |
| Execution loop | — | Root fiber | Turn loop, resource lifecycle, cancellation |
| Tool channels | `@readback`-style | Profunctor optic | Forward (slots→params), backward (output→slots) |
| Delegation | `@delegate` | `rexKeyed` | Fiber spawn, natural cancellation |
| Parallel dispatch | — | `rexGather` | Join point for parallel tool/delegation calls |
| Hot agent state | `@heap` | `FiberHeapAllocator` | Compiled offsets, zero-copy access |
| Event profiling | — | `CommandRing` | io_uring-style submit/complete per turn |
| Context sources | `@source` | `rexUseResource` | Media-style DAG, versioned, worker-offloadable |

Every agent concept maps to an existing RPE primitive. No new runtime mechanisms. The fiber layer adds execution semantics — lifecycle, cancellation, resource management — without new tree node types.

### 1.3 Principles

1. **Agents are shrubs** — `@shrub` without fiber = passive reactive entity. No new node types beyond sugar.
2. **Fibers provide execution** — `@shrub` with root fiber = active agent. The fiber manages the turn loop, API lifecycle, and cancellation.
3. **Notation is configuration** — one `.rex` file replaces JSON + MD + YAML + Python glue.
4. **Composition via `@template`** — reusable agent archetypes with `$param` substitution.
5. **Learning is automatic** — ShrubLM tracks tool effectiveness, prompt quality, delegation success.
6. **Self-healing agents** — surprise detection → goal-state → corrective action.
7. **Profunctor optics everywhere** — tool call/response is a bidirectional channel, same algebra as GPU readback.
8. **CommandRing profiling** — every LLM call and tool execution tracked in a unified ring buffer.
9. **Compile/execute split** — agent definition compiles once; execution is a fiber render loop.
10. **Zero new abstractions** — every agent concept maps to an existing Rex + fiber primitive.

---

## 2. Agent = Shrub + Root Fiber

### 2.1 An Agent Is a @shrub

Agent-specific semantics come from slot **names** and **:min/:max** ranges, not new types. The `agent/` namespace prefix is a convention, not a compiler requirement.

```rex
@shrub agent/coder
  ;; ─── Identity ───
  @slot role :type string :default "Senior software engineer"
  @slot model :type string :default "claude-opus-4-6"
  @slot personality :type string :default "concise"

  ;; ─── LLM Parameters ───
  @slot temperature :type number :default 0.7 :min 0 :max 2
  @slot max-tokens :type number :default 4096 :min 1 :max 200000
  @slot context-window :type number :default 200000
  @slot top-p :type number :default 1.0 :min 0 :max 1

  ;; ─── Budget & Limits ───
  @slot tool-budget :type number :default 50 :min 0
  @slot tokens-used :type number :default 0 :min 0
  @slot retry-limit :type number :default 3 :min 0
  @slot delegation-depth :type number :default 0 :min 0 :max 5
  @slot max-turns :type number :default 200 :min 1

  ;; ─── Runtime Status ───
  @slot status :type string :default "idle"
  @slot current-task :type string
  @slot last-error :type string
  @slot turn-count :type number :default 0

  ;; ─── Conversation Memory ───
  @kids messages/[ud]
    @slot role :type string
    @slot content :type string
    @slot timestamp :type number
    @slot tokens :type number

  ;; ─── Tool Registry ───
  @kids tools/[ta]
    @slot name :type string
    @slot description :type string
    @slot enabled :type boolean :default true
    @slot calls :type number :default 0
    @slot failures :type number :default 0
    @slot avg-latency :type number :default 0

  ;; ─── Cross-Agent Dependencies ───
  @dep reviewer :path /agent/reviewer
  @dep knowledge :path /agent/knowledge-base
```

### 2.2 `@agent` Sugar

`@agent` is syntactic sugar that expands to `@shrub` + fiber mount in `RexFiberHost`. The notation is equivalent — `@agent` saves boilerplate for the common case:

```rex
@agent coder
  @slot role :type string :default "Senior software engineer"
  @slot model :type string :default "claude-opus-4-6"
  ;; ... same body as @shrub agent/coder
```

Expands to:

```rex
@shrub agent/coder
  @slot role :type string :default "Senior software engineer"
  @slot model :type string :default "claude-opus-4-6"
  ;; ... all slots/kids/deps
```

Plus a fiber mount instruction consumed by `rex-agent.js`:

```js
// During expandAgentSugar():
fiberHost.mount(agentFiber, ['coder', compiledConfig]);
```

**Key distinction:**
- `@shrub agent/coder` without `@agent` = passive reactive entity. Slots react, derives compute, but no turn loop executes.
- `@agent coder` (or explicit fiber mount) = active agent. The fiber provides the execution loop, resource lifecycle, and cancellation semantics.

### 2.3 Root Fiber Semantics

Each agent's root fiber manages:

```js
function agentFiber(agentName, config) {
  // 1. Resource lifecycle — API client survives recompile
  const apiClient = rexUseResource((dispose) => {
    const client = createAnthropicClient(config.apiKey);
    dispose(() => client.close());
    return client;
  }, [config.apiKey]);

  // 2. Turn state — fiber-local, reset per render
  const [turnId, setTurnId] = rexUseState(0);
  const [status, setStatus] = rexUseState('idle');

  // 3. Cancellation — fiber unmount propagates to in-flight calls
  //    If the user switches tasks or the agent is removed from the tree,
  //    the fiber unmount triggers dispose() on the API client,
  //    which aborts any in-flight SSE stream.

  // 4. CommandRing integration — profiling per turn
  ring.submitFrame(turnId);
  // ... LLM call, tool calls ...
  ring.endFrame(turnId);

  rexYeet({ status, turnId });
}
```

`rexUseResource` (rex-fiber.js:142) caches the API client across recompiles. When the user edits `.rex` source, the fiber re-renders but deps haven't changed → factory NOT re-invoked → existing client reused. Same invariant as media resource fibers (SugarFiber-Spec §8).

### 2.4 Why This Works

- **ShrubLM attaches automatically.** Every `@shrub` gets a learning module. The agent's slots define its reference frame. Tool call patterns become displacement vectors. The LM learns which configurations lead to successful outcomes.
- **:min/:max enables surprise detection.** When `tool-budget` hits 0 or `tokens-used` exceeds `context-window * 0.9`, the LM fires `onSurpriseSignal`. Recovery actions (compress context, ask user, switch model) trigger automatically.
- **`tools/[ta]` is a live registry.** Tool usage statistics are shrub state — visible to `@derive`, tracked by ShrubLM, persistable via PLAN pins. No separate analytics pipeline.
- **`messages/[ud]` is conversation history.** Fold over it to count tokens, search for patterns, or compress old messages. Same data model as any kids collection.
- **Fiber adds execution without new notation.** The tree describes the agent's *what*. The fiber provides the *how* — turn loop, resource lifecycle, cancellation. Both are declarative; neither reaches for imperative escape hatches.

---

## 3. Prompt Assembly as @derive

### 3.1 Content Types

Four prompt content types, registered via `Rex.registerContentType()`:

| Type | Purpose | Scope |
|---|---|---|
| `@system` | System prompt (identity, rules, constraints) | One per agent |
| `@task` | Task prompt template (dynamic per invocation) | One per agent |
| `@few-shot` | Example input/output pairs | One per agent |
| `@context` | Dynamic context injection sources | One per agent (expanded in §5) |

All use the existing content block syntax (`''...''`) with `$param` substitution from the agent's slots.

### 3.2 @system — Identity & Rules

```rex
@system agent/coder
  ''
  You are a $role specializing in $languages.

  ## Capabilities
  You have $tool-budget tool calls remaining this session.
  Your context window is $context-window tokens.

  ## Rules
  - Read a file before editing it
  - Run tests after making changes
  - Never commit unless explicitly asked
  - Never write to .env, credentials, or key files
  - Prefer editing existing files over creating new ones

  ## Style
  - Be $personality
  - Show file paths as relative from project root
  - Only add comments where logic isn't self-evident
  ''
```

The `$param` references resolve against the agent's own slots at prompt assembly time. If `/role` is "Senior Rust engineer", the system prompt reads "You are a Senior Rust engineer".

### 3.3 @task — Per-Invocation Template

```rex
@task agent/coder
  ''
  ## Task
  $task-description

  ## Working Directory
  $cwd

  ## Recent Context
  $recent-context

  ## Constraints
  - Tool budget remaining: $tool-budget
  - Tokens remaining: $remaining-tokens
  ''
```

`$task-description` is injected at invocation time (not from a slot — it's a runtime parameter passed to the agent's entry talk).

### 3.4 @few-shot — Examples

```rex
@few-shot agent/coder
  @example
    @input
      ''
      Add a dark mode toggle to the settings page
      ''
    @output
      ''
      Let me explore the settings page structure first.

      [read-file src/pages/Settings.tsx]

      I see the settings layout. I'll add a toggle component
      that persists the preference to localStorage.

      [edit-file src/pages/Settings.tsx ...]
      [read-file src/hooks/useTheme.ts]
      [write-file src/hooks/useTheme.ts ...]
      [run-tests npm test -- --grep theme]

      Done. The dark mode toggle is in Settings with
      persistence via useTheme hook. Tests pass.
      ''
```

Few-shot examples teach the agent tool usage patterns. ShrubLM also learns from these — the examples seed initial prototypes for tool sequences.

### 3.5 Prompt Assembly as @derive

In v1, `assemblePrompt()` was a standalone function — imperative, opaque, unobservable by ShrubLM. In v2, prompt assembly is a `@derive` expression: reactive, dirty-tracked, and part of the shrub's reference frame.

```rex
@derive :shrub agent/coder :slot prompt-budget
  (sub /context-window /tokens-used)

@derive :shrub agent/coder :slot system-tokens
  (token-count (assemble-system /role /languages /tool-budget /context-window /personality))

@derive :shrub agent/coder :slot context-budget
  (sub /prompt-budget (add /system-tokens /task-tokens /few-shot-tokens 500))

@derive :shrub agent/coder :slot assembled-prompt
  (assemble /system /context /few-shot /task /context-budget)
```

**Why this matters:**

1. **Reactive.** When any input slot changes (role, tool-budget, context sources), the prompt recompiles automatically via the derive topological sort. No manual `assemblePrompt()` call needed.

2. **Observable by ShrubLM.** Prompt-budget, context-budget, and system-tokens are all slots in the agent's reference frame. ShrubLM sees how prompt size correlates with task success. It can learn "longer system prompts correlate with worse performance for simple tasks" and crystallize a guard.

3. **Dirty-tracked.** The derive system's dirty flags mean prompt assembly only runs when inputs actually change. If the user edits a @tool definition but no prompt content, prompt derives remain clean — zero recomputation.

4. **GPU-classifiable.** Token counting derives can be classified as GPU compute by `_compileDeriveCompute` (rex-gpu.js), offloading budget arithmetic to a compute shader when context windows are large.

### 3.6 Token Budget Trimming

```rex
@derive :shrub agent/coder :slot trimmed-context
  (if (lt /context-budget 0)
    (trim-sources /context /context-budget :strategy priority)
    /context)
```

If `context-budget` goes negative, context sources are trimmed in reverse priority order (lowest-budget sources dropped first). The trimming is itself a derive — it reacts to budget changes automatically.

The `assemblePrompt()` function still exists for backward compatibility. It wraps derive evaluation:

```js
function assemblePrompt(agentName, taskParams) {
  behaviour.pushFormValue(`agent/${agentName}`, 'task-description', taskParams.description);
  behaviour._flushDerives();
  return behaviour.getSlotValue(`agent/${agentName}`, 'assembled-prompt');
}
```

---

## 4. Tool Definitions as Profunctor Optics

### 4.1 @tool — Syntactic Sugar

`@tool` is not a new primitive. It's syntactic sugar that expands to existing constructs at compile time (same pattern as `@filter` → synthetic nodes at rex-gpu.js:885):

```rex
@tool read-file :shrub agent/coder
  @input path :type string
  @input offset :type number :default 0
  @input limit :type number :default 2000
  @output content :type string
  @output line-count :type number
  @guard (and
    (gt /tool-budget 0)
    (neq /status "blocked"))
  @cost 1
  ''
  Read a file from the local filesystem.
  Returns file content with line numbers.
  ''
```

### 4.2 The Profunctor Optic Model

A tool call is a bidirectional channel between the agent's slot-space and the external world. This is the same algebra as GPU `@readback` (rex-gpu.js:612):

```
Forward (agent → tool):
  Agent slots → @guard → @input schema → tool params → execution
  Optic: Lens(agent.slots) ▹ Prism(guard) ▹ Iso(schema) → params

Backward (tool → agent):
  Result → @output fields → slot writes → derive flush
  Optic: Result ▸ Iso(schema) ▸ Lens(agent.slots)
```

**Side-by-side with GPU readback:**

| | GPU Readback | Tool Response |
|---|---|---|
| Forward | `@bind` slot values → uniform buffer | Agent slots → `@input` JSON params |
| Backward | Storage buffer → `@readback :path` → slot write | Tool result → `@output :to /slot` → slot write |
| Transport | `mapAsync` + `getMappedRange` | API response + JSON parse |
| Algebra | Profunctor optic (compiled byte offset) | Profunctor optic (compiled slot path) |
| Dirty tracking | Heap dirty range | Derive dirty flag |

The tool's `@output` fields declare the backward optic:

```rex
@tool read-file :shrub agent/coder
  @input path :type string
  @output content :type string :to /last-output
  @output line-count :type number :to /last-line-count
  @output error :type string :to /last-error
  @guard (gt /tool-budget 0)
  @cost 1
  ''Read a file from the local filesystem.''
```

`:to /slot` compiles to a slot write on tool completion — the backward half of the profunctor optic. If `:to` is omitted, the output is returned to the LLM but not written to a slot.

### 4.3 @tool Expansion

Each `@tool` compiles to three standard constructs:

**1. Tool schema (@def)**
```rex
@def tool-schema-read-file :args []
  ;; Pure function returning the tool's API schema
  ;; Used by prompt assembler to generate function-calling format
```

**2. Tool invocation (@talk)**
```rex
@talk :shrub agent/coder :name use-read-file
  @input path :type string
  @input offset :type number
  @input limit :type number
  @guard (and (gt /tool-budget 0) (neq /status "blocked"))
  @set /tool-budget (sub /tool-budget 1)
  @set /turn-count (add /turn-count 1)
  @update /tools/%read-file
    @slot calls (add $item.calls 1)
```

**3. Tool kid entry (initial state)**
```rex
;; Injected into @shrub schema's tools/[ta] collection:
@create /tools/%read-file
  @slot name "read-file"
  @slot description "Read a file from the local filesystem."
  @slot enabled true
  @slot calls 0
  @slot failures 0
```

### 4.4 Tool Guards

Guards on tools serve dual purposes:

1. **Compile-time policy**: The guard expression is evaluated before each tool call. Budget enforcement, safety rails, and capability gates are all `@guard` expressions.

2. **ShrubLM learning substrate**: The LM tracks guard pass/fail rates per tool. After crystallization, it can synthesize refined guards from observed patterns (e.g., "edit-file always follows read-file" → synthesized guard `(gte /tools/read-file/calls 1)`).

```rex
@tool write-file :shrub agent/coder
  @input path :type string
  @input content :type string
  @guard (and
    (gt /tool-budget 0)
    (not (ends-with %path ".env"))
    (not (ends-with %path ".key"))
    (not (starts-with %path "/etc/")))
  @cost 1
  ''Write content to a file.''

@tool run-dangerous :shrub agent/coder
  @input command :type string
  @guard (and
    (gt /tool-budget 0)
    (eq /status "confirmed")
    (lte /turn-count 100))
  @cost 5
  ''Execute a shell command. Requires explicit user confirmation.''
```

### 4.5 Tool Cost Accounting

`:cost N` deducts N from `tool-budget` per invocation. This enables:

- **Expensive operations** (shell exec, API calls) cost more than cheap ones (file read)
- **Budget exhaustion** triggers surprise → recovery → ask user for more budget
- **ShrubLM tracks** cost patterns — learns which tools are worth the budget

### 4.6 Tool Failure Tracking

```rex
@talk :shrub agent/coder :name tool-failed
  @input tool-name :type string
  @input error :type string
  @update /tools/%tool-name
    @slot failures (add $item.failures 1)
  @set /last-error %error

@derive :shrub agent/coder :slot tool-reliability
  ;; Map of tool name → success rate
  (fold %kids/tools 1.0
    (if (gt $item.calls 0)
      (min $acc (div (sub $item.calls $item.failures) $item.calls))
      $acc))
```

When `tool-reliability` drops below 0.5 (schema `:min`), surprise fires. ShrubLM finds a corrective talk — maybe `switch-tool`, `retry-with-different-params`, or `ask-user`.

### 4.7 Tool Fiber Mount

Each tool invocation is tracked as a keyed fiber via `rexKeyed` (rex-fiber.js:212):

```js
// Inside agentFiber render:
for (const toolCall of pendingToolCalls) {
  rexKeyed(toolFiber, toolCall.id, toolCall.name, toolCall.inputs);
}
```

This gives each tool call:
- **Individual cancellation** — unmounting the tool fiber aborts the in-flight execution
- **Profiling** — `ring.submit('tool', {name, inputs})` on start, `ring.complete(sqeId, result)` on finish
- **Keyed reconciliation** — duplicate tool calls with the same ID are deduplicated

---

## 5. Context Sources as Media-Style DAG

### 5.1 Context Sources ARE Media

The RexMedia-Spec (§2) defines media as "signals over a domain." Agent context sources are exactly this — signals over the agent's execution domain:

| Media | Agent Context |
|---|---|
| Image pixels over UV domain | Git status over repository domain |
| Audio samples over time domain | Open files over editor domain |
| Video frames over spatiotemporal domain | Test results over execution domain |

Both are external signals that:
- Arrive asynchronously
- Have version/dirty tracking
- Need budget-bounded consumption
- Benefit from worker offloading for heavy processing

### 5.2 @context as DAG

```rex
@context agent/coder
  @source git-status
    :refresh on-change
    :budget 500
    ''Current git status and recent commits''

  @source open-files
    :refresh on-change
    :budget 1000
    ''Files currently open in the editor''

  @source test-results
    :refresh after-tool
    :tool run-tests
    :budget 2000
    ''Most recent test output''

  @source conversation
    :window 10
    :strategy recency
    :budget 8000
    ''Recent conversation messages''

  @source project-memory
    :refresh on-start
    :budget 3000
    ''Project conventions, architecture notes, learned patterns''
```

### 5.3 @source as DAG Amendment

Each `@source` child is a DAG amendment, analogous to `@track` in `@media` (RexMedia-Spec §2.2):

```
@context agent/coder                    ← root context node (like @media)
  @source git-status                    ← DAG leaf (like @track)
    :refresh on-change                  ← lifecycle policy
    :budget 500                         ← resource budget
```

**Namespace addressing:** Each source lives at a tree path:

```
/agent/coder/context/git-status         ← addressable via dep path
/agent/coder/context/open-files
/agent/coder/context/test-results
```

This enables cross-agent context sharing via standard `@dep`:

```rex
@shrub agent/reviewer
  @dep coder-context :path /agent/coder/context/git-status
```

### 5.4 Fiber-Managed Context Lifecycle

Each context source gets a dedicated fiber via `rexUseResource` (rex-fiber.js:142), identical to media asset loading:

```
expandAgentSugar() called on recompile
  └─ for each @source:
       └─ rexKeyed(contextSourceFiber, sourceName, sourceConfig)
            └─ rexUseResource((dispose) => {
                 fetchContextData(sourceName, sourceConfig)
                   .then(data => {
                     contextMap.set(sourceName, { value: data, version: ++ver })
                   })
                 dispose(() => abortPendingFetch())
               }, [sourceConfig.refresh, sourceConfig.tool])
```

**Version/dirty tracking:** Each source has a monotonic version counter. The prompt-assembly derive checks versions to avoid re-tokenizing unchanged context. Same dirty-flag optimization as GPU heap dirty range tracking.

**Worker offloading:** Heavy context sources (large codebases, long test output) can be offloaded to the `DeriveWorkerPool` (rex-fiber.js) for tokenization and truncation, keeping the main thread responsive.

### 5.5 Source Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| `:refresh` | string | "on-start" | When to re-fetch (`on-change`, `on-start`, `after-tool`, `every-turn`, `manual`) |
| `:budget` | number | 1000 | Max tokens allocated to this source |
| `:window` | number | — | Item count limit (for collections) |
| `:strategy` | string | "recency" | Selection strategy (`recency`, `relevance`, `priority`) |
| `:tool` | string | — | Tool that triggers refresh (with `after-tool`) |

---

## 6. Memory & Heap

### 6.1 Three Tiers

Memory is data in the shrub. No vector DB. No external store. Just kids collections with typed slots.

```
┌─────────────────────────────────────────────────┐
│ SHORT-TERM: messages/[ud]                       │
│  Current conversation. Auto-managed per turn.   │
│  Compressed when context fills.                 │
├─────────────────────────────────────────────────┤
│ MEDIUM-TERM: facts/[ta]                         │
│  Session knowledge. Persists across tasks.      │
│  Compressed messages, discovered patterns.      │
├─────────────────────────────────────────────────┤
│ LONG-TERM: patterns/[ta]                        │
│  Crystallized by ShrubLM. Persists via PLAN.    │
│  Tool selection rules, workflow patterns.        │
└─────────────────────────────────────────────────┘
```

### 6.2 Three-Tier Data Model: Heap + Kids + Pins

The v2 agent data model maps memory to three RPE storage tiers, paralleling the GPU Compiler Spec §1 (`@heap`):

| Tier | RPE Mechanism | Access Pattern | Persistence |
|---|---|---|---|
| **Heap** | `FiberHeapAllocator` (rex-fiber.js:688) | Compiled byte offsets, zero-copy | Per-session (fiber lifetime) |
| **Kids** | `@kids` collections | Tree path traversal | Per-session (shrub lifetime) |
| **Pins** | PLAN `@pin` | Orthogonal persistence | Across sessions (PLAN VM) |

**Heap for hot agent state:** Frequently-accessed agent parameters (temperature, tool-budget, tokens-used, turn-count) are allocated on the fiber's heap at compiled offsets via `FiberHeapAllocator`:

```rex
@heap agent/coder
  @field temperature :type f32 :offset 0
  @field tool-budget :type u32 :offset 4
  @field tokens-used :type u32 :offset 8
  @field turn-count  :type u32 :offset 12
```

This mirrors `@heap` in the GPU Compiler Spec — same notation, same compiled-offset access, different backing store (fiber heap vs GPU buffer). The `@heap` fields are synced with `@shrub` slots on every derive flush: `setFloat32(offset, slotValue)`.

### 6.3 Schema

```rex
@shrub agent/coder
  ;; Short-term
  @kids messages/[ud]
    @slot role :type string         ;; "user", "assistant", "tool"
    @slot content :type string
    @slot timestamp :type number
    @slot tokens :type number

  ;; Medium-term
  @kids facts/[ta]
    @slot category :type string     ;; "compressed", "convention", "architecture", "preference"
    @slot content :type string
    @slot confidence :type number :default 1.0
    @slot source :type string       ;; "user", "auto-compress", "tool-output", "crystallization"
    @slot created :type number

  ;; Long-term
  @kids patterns/[ta]
    @slot description :type string  ;; Human-readable description
    @slot guard-expr :type string   ;; Synthesized Rex guard expression
    @slot success-rate :type number
    @slot observations :type number
    @slot crystallized :type boolean :default false
```

### 6.4 Context Window Management

```rex
@derive :shrub agent/coder :slot tokens-used
  (fold %kids/messages 0 (add $acc $item.tokens))

@derive :shrub agent/coder :slot context-pressure
  (div /tokens-used /context-window)

@derive :shrub agent/coder :slot should-compress
  (gt /context-pressure 0.8)
```

### 6.5 Auto-Compression

```rex
@talk :shrub agent/coder :name compress-context
  @guard /should-compress
  ;; Remove messages older than 5 minutes
  @each %kids/messages
    @where (lt $item.timestamp (sub %now 300000))
    @remove $item
  ;; Save compressed summary as a fact
  @create /facts/[auto]
    @slot category "compressed"
    @slot content (summarize /removed-messages)
    @slot source "auto-compress"
    @slot confidence 0.8
    @slot created %now
```

### 6.6 Memory Retrieval

```rex
@def relevant-facts :args [query category]
  (fold %kids/facts []
    (if (and
          (or (eq $item.category %category) (eq %category "all"))
          (gt (similarity $item.content %query) 0.7))
      (append $acc $item)
      $acc))
```

### 6.7 PLAN Persistence

```rex
@channel :shrub agent/coder
  @pin facts :mode on-change       ;; Persist session facts
  @pin patterns :mode on-change    ;; Persist learned patterns
  @pin tools :mode on-change       ;; Persist tool usage stats
```

PLAN pins provide orthogonal persistence. When the agent restarts, its medium-term facts and long-term patterns survive. Tool usage statistics carry over, so ShrubLM continues learning from where it left off.

---

## 7. Multi-Agent Delegation as Fiber Spawn

### 7.1 Agents as Dep Sources

Agents subscribe to each other via `@dep`, exactly like any shrub:

```rex
@shrub agent/supervisor
  @slot task :type string
  @slot strategy :type string :default "sequential"
  @slot phase :type string :default "planning"

  @dep coder :path /agent/coder
  @dep reviewer :path /agent/reviewer
  @dep tester :path /agent/tester
```

### 7.2 @delegate as Fiber Spawn

In v1, `@delegate` was a `registerMutationType('delegate', handler)` hack — an imperative escape hatch inside the declarative mutation system. In v2, `@delegate` expands to `rexKeyed(delegateFiber, ...)` (rex-fiber.js:212):

```rex
@talk :shrub agent/supervisor :name implement-feature
  @input description :type string
  @guard (and
    (lte /delegation-depth 3)
    (eq /status "idle"))

  @set /status "delegating"
  @set /phase "coding"

  @delegate %coder
    :talk code-task
    :input description %description
    :on-complete review-code
    :on-fail handle-coding-failure
```

**Expansion (v2):**

```js
// @delegate expands to:
rexKeyed(delegateFiber, 'coder-code-task', {
  target: 'agent/coder',
  talk: 'code-task',
  inputs: { description },
  onComplete: 'review-code',
  onFail: 'handle-coding-failure'
});
```

**What fiber spawn provides over mutation type:**

| | v1 (registerMutationType) | v2 (rexKeyed) |
|---|---|---|
| Cancellation | Manual `clearTimeout` | Fiber unmount propagates to in-flight calls |
| Lifecycle | Ad-hoc callback chain | Fiber hooks (`rexUseResource`, `rexUseState`) |
| Profiling | Separate timing code | CommandRing tracks submit → complete |
| Parallel | Manual `Promise.all` | `rexGather` with join semantics |
| Deduplication | Manual key tracking | Keyed reconciliation (same key = same fiber) |

### 7.3 @delegate Semantics

```
@delegate TARGET
  :talk ACTION           ← talk name on target agent
  :input KEY VALUE       ← inputs to pass (repeatable)
  :on-complete TALK      ← talk to fire in THIS shrub on success
  :on-fail TALK          ← talk to fire in THIS shrub on failure
  :timeout NUMBER        ← max milliseconds (optional, default 30000)
```

The delegate fiber:
1. `behaviour.fireTalk(targetShrub, action, inputs)` — invoke the target agent's talk
2. Watch target `/status` slot for completion (via derive, not ad-hoc polling)
3. When target status = `"complete"` → fire `:on-complete` talk in parent shrub
4. When target status = `"error"` → fire `:on-fail` talk in parent shrub
5. Increment `/delegation-depth` on the target (prevents infinite recursion)
6. On timeout → unmount fiber → fire `:on-fail` with `{error: "timeout"}`

### 7.4 `@use agent/target` — Inline Delegation

Within a `@talk`, `@use` provides a concise alternative to `@delegate`:

```rex
@talk :shrub agent/supervisor :name quick-review
  @input code :type string
  @use agent/reviewer
    :talk review
    :input code %code
  ;; Continues after reviewer completes
  @set /status "reviewed"
```

`@use agent/target` expands to `@delegate` + implicit `@on-complete` that continues the parent talk. Syntactic sugar for the common case of sequential delegation.

### 7.5 Delegation Chains

```rex
;; Supervisor delegates coding, then chains to review
@talk :shrub agent/supervisor :name implement-feature
  @input description :type string
  @delegate %coder
    :talk code-task
    :input description %description
    :on-complete review-code

@talk :shrub agent/supervisor :name review-code
  @delegate %reviewer
    :talk review
    :input code %coder/last-output
    :on-complete run-tests

@talk :shrub agent/supervisor :name run-tests
  @delegate %tester
    :talk test-suite
    :input target %coder/modified-files
    :on-complete finalize
    :on-fail request-fix

@talk :shrub agent/supervisor :name request-fix
  @delegate %coder
    :talk fix-issues
    :input errors %tester/last-output
    :on-complete review-code
```

### 7.6 Parallel Delegation via rexGather

```rex
@talk :shrub agent/supervisor :name parallel-review
  @input code :type string
  @set /strategy "parallel"

  ;; Fire all three in parallel — rexGather join semantics
  @delegate %reviewer
    :talk review-security
    :input code %code
    :parallel true

  @delegate %reviewer
    :talk review-performance
    :input code %code
    :parallel true

  @delegate %reviewer
    :talk review-style
    :input code %code
    :parallel true

  ;; All three update %reviewer's slots independently
  ;; Supervisor's @derive aggregates results
```

When multiple `@delegate` nodes carry `:parallel true`, they expand to `rexGather` (rex-fiber.js:200):

```js
rexGather([
  () => rexKeyed(delegateFiber, 'review-security', ...),
  () => rexKeyed(delegateFiber, 'review-performance', ...),
  () => rexKeyed(delegateFiber, 'review-style', ...),
], (results) => {
  // All three complete → continue parent talk
});
```

### 7.7 Multi-Agent Consensus via Lateral Voting

ShrubLM lateral voting operates across `@dep` edges between agents:

```rex
@derive :shrub agent/supervisor :slot code-ready
  (and
    (gt %coder/__lm_confidence_code-task 0.8)
    (gt %reviewer/__lm_confidence_review 0.7)
    (gt %tester/__lm_confidence_test-pass 0.7))
```

After enough successful delegation chains, the supervisor's ShrubLM crystallizes the pattern "code → review → test" as canonical. Flash inference: if all three sub-agents report high confidence, the supervisor can fast-path approval without re-evaluating.

### 7.8 Write Ordering via ChannelContention

When multiple agents write to shared slots (e.g., a shared `/project/status`), `ChannelContention` (rex-fiber.js) ensures deterministic ordering. Each agent's fiber has a contention key; writes are serialized through the contention ring — same mechanism that prevents GPU dispatch races.

---

## 8. Observation & Learning

### 8.1 ShrubLM on Agents

ShrubLM operates on agents identically to any shrub. No special agent-aware code. The learning module sees:

- **Slot-space dimensions**: temperature, tool-budget, tokens-used, turn-count, tool-reliability
- **Displacement vectors**: each talk invocation (use-tool, delegate, compress-context) produces measurable slot changes
- **:min/:max ranges**: enable normalized comparison and surprise detection

### 8.2 What Gets Learned

**Tool selection patterns:**
```
After 20+ successful sequences of:
  read-file → edit-file → run-tests

ShrubLM crystallizes prototype:
  talk: "use-edit-file"
  displacement: [tool-budget: -1, turn-count: +1, tools/edit-file/calls: +1]
  preState: [tools/read-file/calls >= 1]

Synthesized guard:
  @guard (and (gt /tool-budget 0) (gte /tools/read-file/calls 1))
```

**Delegation effectiveness:**
```
After 15+ successful supervisor → coder → reviewer chains:

ShrubLM crystallizes:
  talk: "review-code"
  preState: [%coder/status == "complete"]

Guard bypass:
  __lm_ready_review-code = 1 when coder consistently succeeds
```

**Error recovery patterns:**
```
After 5+ instances where run-tests fails → fix-issues → run-tests succeeds:

ShrubLM crystallizes:
  talk: "request-fix"
  displacement: [%tester/failures: +1]
  preState: [%tester/status == "error"]
```

### 8.3 Surprise Detection

```rex
@slot success-rate :type number :min 0.5 :max 1.0

;; When success-rate drops below 0.5:
;;   onSurpriseSignal fires
;;   → _attemptRecovery searches for corrective talk
;;   → Possible actions:
;;       switch-model (try a different LLM)
;;       increase-temperature (try more creative responses)
;;       reduce-tool-budget (constrain the agent)
;;       ask-user (human in the loop)
;;       compress-context (free up token space)
```

### 8.4 Self-Modifying Agent Configs

When ShrubLM crystallizes a pattern, `_amendSource()` can inject a synthesized `@guard` into the agent's `.rex` source file:

```rex
;; Before crystallization:
@talk :shrub agent/coder :name edit-file
  @input path :type string
  @input changes :type string
  @set /status "editing"

;; After ShrubLM crystallizes (auto-amended):
@talk :shrub agent/coder :name edit-file
  @input path :type string
  @input changes :type string
  @guard (and (gte /tools/read-file/calls 1) (lte /turn-count 150))
  @set /status "editing"
```

The agent learns its own best practices from runtime data. The source file becomes a living document that encodes learned constraints.

### 8.5 ShrubLM Feedback Slots

```rex
;; Auto-written by ShrubLM, readable by @derive
@slot __lm_confidence_code-task :type number :default 0
@slot __lm_ready_code-task :type number :default 0
@slot __lm_confidence_use-read-file :type number :default 0
@slot __lm_confidence_use-edit-file :type number :default 0
@slot __lm_bypass_compress-context :type number :default 0
```

These slots enable the model-free fast path. After sufficient observations, routine operations bypass guard computation entirely — same mechanism as Thousand Brains' efficient habits.

### 8.6 Few-Shot = Static + Crystallized

v2 introduces the `:source` attribute on `@few-shot`, enabling the learning loop to close:

```rex
@few-shot agent/coder :source [static crystallized] :budget 4000
  @example
    @input ''Add a dark mode toggle''
    @output ''[read-file ...] [edit-file ...] [run-tests ...]''
```

| Source | Origin | Lifecycle |
|---|---|---|
| `static` | Hand-written `@example` blocks in `.rex` source | Permanent, always included |
| `crystallized` | ShrubLM-generated from observed patterns | Auto-injected when confidence > threshold |

**How crystallization works:**

1. ShrubLM tracks successful tool sequences (§8.2)
2. After 20+ consistent observations, the sequence crystallizes into a prototype
3. The prototype is formatted as an `@example` (input = pre-state, output = action sequence)
4. Crystallized examples are auto-injected into the `@few-shot` block at prompt assembly time
5. Token budget (`:budget 4000`) caps the total — static examples trimmed before crystallized ones if needed

This closes the learning loop: runtime observations → ShrubLM prototypes → few-shot examples → improved LLM performance → better observations.

---

## 9. Template Composition

### 9.1 Base Agent Template

```rex
@template base-agent
  @param role :default "assistant"
  @param model :default "claude-opus-4-6"
  @param temperature :default 0.7
  @param max-tokens :default 4096
  @param tool-budget :default 50
  @param context-window :default 200000

  @agent $name
    @slot role :type string :default "$role"
    @slot model :type string :default "$model"
    @slot temperature :type number :default $temperature :min 0 :max 2
    @slot max-tokens :type number :default $max-tokens :min 1 :max 200000
    @slot context-window :type number :default $context-window
    @slot tool-budget :type number :default $tool-budget :min 0
    @slot tokens-used :type number :default 0 :min 0
    @slot status :type string :default "idle"
    @slot turn-count :type number :default 0
    @slot delegation-depth :type number :default 0 :min 0 :max 5
    @slot success-rate :type number :default 1.0 :min 0.5 :max 1.0

    @kids messages/[ud]
      @slot role :type string
      @slot content :type string
      @slot tokens :type number
      @slot timestamp :type number

    @kids tools/[ta]
      @slot name :type string
      @slot description :type string
      @slot enabled :type boolean :default true
      @slot calls :type number :default 0
      @slot failures :type number :default 0

    @kids facts/[ta]
      @slot category :type string
      @slot content :type string
      @slot confidence :type number :default 1.0
      @slot source :type string
      @slot created :type number

  @derive :shrub agent/$name :slot tokens-used
    (fold %kids/messages 0 (add $acc $item.tokens))
```

Note: `@agent $name` inside the template expands to `@shrub agent/$name` + fiber mount. The `@agent` sugar works transparently inside templates.

### 9.2 Coding Agent Template

```rex
@template coding-agent
  @param languages :default "javascript,typescript"
  @param test-command :default "npm test"

  @use base-agent :as $name :role "Senior software engineer" :tool-budget 100

  @system agent/$name
    ''
    You are a $role specializing in $languages.
    You have $tool-budget tool calls remaining.

    Rules:
    - Read files before editing them
    - Run tests after changes
    - Never commit unless asked
    - Prefer editing existing files over creating new ones
    ''

  @tool read-file :shrub agent/$name
    @input path :type string
    @input offset :type number :default 0
    @input limit :type number :default 2000
    @output content :type string
    @guard (gt /tool-budget 0)
    @cost 1
    ''Read a file from the filesystem. Returns content with line numbers.''

  @tool edit-file :shrub agent/$name
    @input path :type string
    @input old-string :type string
    @input new-string :type string
    @guard (gt /tool-budget 0)
    @cost 1
    ''Replace old-string with new-string in the file.''

  @tool write-file :shrub agent/$name
    @input path :type string
    @input content :type string
    @guard (and
      (gt /tool-budget 0)
      (not (ends-with %path ".env"))
      (not (ends-with %path ".key")))
    @cost 1
    ''Create or overwrite a file.''

  @tool search-code :shrub agent/$name
    @input pattern :type string
    @input glob :type string :default "**/*"
    @output matches :type string
    @guard (gt /tool-budget 0)
    @cost 1
    ''Search file contents with regex pattern.''

  @tool run-tests :shrub agent/$name
    @input command :type string :default "$test-command"
    @guard (gt /tool-budget 0)
    @cost 2
    ''Run the test suite.''

  @tool run-command :shrub agent/$name
    @input command :type string
    @guard (and (gt /tool-budget 0) (eq /status "confirmed"))
    @cost 3
    ''Execute a shell command. Requires user confirmation.''
```

### 9.3 Instantiation

```rex
;; Instantiate a JavaScript coding agent
@use coding-agent :as js-coder :languages "javascript,typescript" :tool-budget 200

;; Instantiate a Rust coding agent with different test command
@use coding-agent :as rust-coder :languages "rust" :test-command "cargo test" :tool-budget 150

;; Instantiate a review agent from base template
@use base-agent :as reviewer :role "Code reviewer" :temperature 0.3 :tool-budget 20

;; Instantiate a supervisor from base template
@use base-agent :as supervisor :role "Engineering lead" :temperature 0.5 :tool-budget 10
```

### 9.4 Template Nesting

Templates compose via `@use` inside templates. The `coding-agent` template uses `base-agent` internally. A `full-stack-team` template could use multiple `coding-agent` instances:

```rex
@template full-stack-team
  @param project-name :default "app"

  @use coding-agent :as frontend :languages "typescript,react" :tool-budget 150
  @use coding-agent :as backend :languages "go,sql" :tool-budget 150
  @use base-agent :as reviewer :role "Senior code reviewer" :temperature 0.2
  @use base-agent :as pm :role "Project manager" :tool-budget 5

  @shrub agent/team-$project-name
    @dep frontend :path /agent/frontend
    @dep backend :path /agent/backend
    @dep reviewer :path /agent/reviewer
    @dep pm :path /agent/pm
```

Expansion depth limit is 16 (existing parser constraint). Each instantiation gets its own ShrubLM — `frontend` and `backend` learn independently even though they share the same template.

---

## 10. Execution Model: CommandRing

### 10.1 Motivation

Every RPE subsystem uses `CommandRing` (rex-fiber.js:933) for profiling — GPU dispatches, surface renders, media loads. Agent turns are no different: each turn is a frame in the ring buffer.

### 10.2 Turn as Frame

```
ring.submitFrame(turnId)
  ├─ ring.submit('llm-call', { model, tokens_in, system_hash })
  │    ├─ SSE streaming...
  │    └─ ring.complete(sqeId, { tokens_out, finish_reason, latency_ms })
  ├─ ring.submit('tool-call', { name: 'read-file', inputs: {path} })
  │    ├─ tool execution...
  │    └─ ring.complete(sqeId, { success, output_tokens, latency_ms })
  ├─ ring.submit('tool-call', { name: 'edit-file', inputs: {path, old, new} })
  │    ├─ tool execution...
  │    └─ ring.complete(sqeId, { success, output_tokens, latency_ms })
  └─ ring.submit('derive-flush', { count: 5 })
       └─ ring.complete(sqeId, { dirty_slots: 3, latency_ms: 0.2 })
ring.endFrame(turnId)
```

### 10.3 Unified Profiling

The ring captures every event type in one place:

| Event Type | Metadata (submit) | Metadata (complete) |
|---|---|---|
| `llm-call` | model, tokens_in, system_hash | tokens_out, finish_reason, latency_ms |
| `tool-call` | name, inputs | success, output_tokens, latency_ms |
| `delegate` | target, talk, inputs | success, latency_ms |
| `derive-flush` | count | dirty_slots, latency_ms |
| `context-refresh` | source_name | tokens, version, latency_ms |

### 10.4 Profiling Derives

Ring data feeds back into the agent's slot-space via `@derive`:

```rex
@derive :shrub agent/coder :slot avg-turn-latency
  (ring-stat /turn-latency :type mean :window 10)

@derive :shrub agent/coder :slot llm-cost-per-turn
  (ring-stat /llm-tokens-out :type mean :window 10)

@derive :shrub agent/coder :slot tool-error-rate
  (ring-stat /tool-failures :type ratio :window 20)
```

These derives are visible to ShrubLM — it learns latency patterns, cost correlations, and error rate trends. Budget derives (§3.5) use ring data to predict remaining capacity.

### 10.5 Timeout Enforcement

`CommandRing.submit()` returns an SQE ID. If the completion doesn't arrive within the configured timeout, the ring auto-transitions the entry to `'timeout'` status and fires the agent's recovery path:

```js
const sqeId = ring.submit('tool-call', { name, inputs });
// ... if timeout expires:
// ring entry status → 'timeout'
// → behaviour.fireTalk(agent, 'tool-failed', { tool: name, error: 'timeout' })
```

### 10.6 Frame Aggregation

After each frame completes, the ring aggregates per-turn statistics:

```js
const frame = ring.getFrame(turnId);
// frame = {
//   turnId, startTime, endTime,
//   llmCalls: 1, toolCalls: 3, delegations: 0,
//   totalTokensIn: 2400, totalTokensOut: 800,
//   totalLatency: 4200,
//   errors: 0
// }
```

This feeds the budget-tracking derives in §3.5 — `tokens-used` increments from frame aggregation, not manual counting.

---

## 11. Dynamic Constrained Decoding

### 11.1 Static Constraints (v1)

Rex emits `strict: true` on all tool schemas sent to the LLM API, enabling grammar-level constrained decoding. The model's token sampler is physically restricted to valid JSON matching the `@input` schema. No retry needed.

```rex
@tool search-code :shrub agent/coder
  @input pattern :type string
  @input glob :type string :default "**/*"
  @input max-results :type number :default 50
  @output matches :type string
  @guard (gt /tool-budget 0)
  @cost 1
  ''Search file contents with regex pattern.''
```

Emits:
```json
{
  "name": "search-code",
  "description": "Search file contents with regex pattern.",
  "strict": true,
  "input_schema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string" },
      "glob": { "type": "string" },
      "max-results": { "type": "number" }
    },
    "required": ["pattern", "glob", "max-results"],
    "additionalProperties": false
  }
}
```

### 11.2 Dynamic Constraints (v2)

v2 adds expression-driven constraints. The same Rex expression AST that compiles to WGSL (via `compileExprToWGSL`) now also compiles to JSON Schema (via `compileExprToJsonSchema`):

```rex
@tool edit-file :shrub agent/coder
  @input path :type string :enum (map %kids/open-files (get $item "path"))
  @input line :type number :min 1 :max (get (file-info %path) "line-count")
  @output result :type string
  @guard (gt /tool-budget 0)
  @cost 1
  ''Edit a file. Path constrained to currently open files.''
```

**Expression → JSON Schema compilation:**

| Rex Expression | JSON Schema Output |
|---|---|
| `:enum (map %kids/open-files ...)` | `"enum": ["src/main.js", "src/utils.ts", ...]` (evaluated at prompt-assembly time) |
| `:max (get ... "line-count")` | `"maximum": 245` (evaluated at prompt-assembly time) |
| `:min 1` | `"minimum": 1` (static) |

### 11.3 `compileExprToJsonSchema`

```js
function compileExprToJsonSchema(node, ctx) {
  // Same expression AST as compileExprToWGSL (rex-parser.js)
  // Different backend target: JSON Schema instead of WGSL
  //
  // Evaluated at prompt-assembly time (not compile-time) because
  // dynamic values (%kids/open-files) change between turns
  //
  // Returns a JSON Schema fragment that can be merged into the tool schema
}
```

Three compile backends from the same expression AST:

| Backend | Function | Target | When |
|---|---|---|---|
| CPU eval | `evalExpr(node, ctx)` | JavaScript value | Runtime |
| GPU shader | `compileExprToWGSL(node, ctx)` | WGSL string | Compile-time |
| JSON Schema | `compileExprToJsonSchema(node, ctx)` | JSON Schema fragment | Prompt-assembly time |

### 11.4 Response Schema Constraint

`@response` declares a JSON Schema for the agent's non-tool-call responses — the LLM's text output is constrained to match:

```rex
@response agent/coder
  @field action :type string :enum ["code", "ask", "done", "delegate"]
  @field reasoning :type string
  @field files-changed :type array :items string
  @field confidence :type number
```

Emits:
```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "action": { "type": "string", "enum": ["code", "ask", "done", "delegate"] },
          "reasoning": { "type": "string" },
          "files-changed": { "type": "array", "items": { "type": "string" } },
          "confidence": { "type": "number" }
        },
        "required": ["action", "reasoning", "files-changed", "confidence"],
        "additionalProperties": false
      }
    }
  }
}
```

### 11.5 Three Constraint Layers

| Layer | Mechanism | What It Constrains |
|---|---|---|
| `@guard` | Rex compile-time expression | **Whether** the tool can be called (budget, safety, prerequisites) |
| `strict: true` | LLM constrained decoding | **What** the tool receives (valid JSON, correct types, required fields) |
| `@response` | LLM output schema | **What** the agent returns (structured action + reasoning) |
| Dynamic exprs | `compileExprToJsonSchema` | **Which values** are valid (runtime-evaluated enums, bounds) |

Guards prevent unauthorized calls. Constrained decoding prevents malformed calls. Response schemas prevent unstructured output. Dynamic expressions prevent out-of-bounds values. Four layers, zero overlap.

### 11.6 Type Mapping

Rex types compile to JSON Schema types:

| Rex `:type` | JSON Schema | Notes |
|---|---|---|
| `string` | `"string"` | |
| `number` | `"number"` | |
| `boolean` | `"boolean"` | |
| `array` | `"array"` | `:items TYPE` sets `items` |
| `object` | `"object"` | Nested `@field` children set `properties` |

Additional constraints:

| Rex Attribute | JSON Schema |
|---|---|
| `:enum [a b c]` | `"enum": ["a", "b", "c"]` |
| `:enum (expr)` | `"enum": [evaluated values]` (dynamic) |
| `:format date` | `"format": "date"` |
| `:min N` / `:min (expr)` | `"minimum": N` (static or dynamic) |
| `:max N` / `:max (expr)` | `"maximum": N` (static or dynamic) |
| `:min-items N` | `"minItems": N` |
| `:max-items N` | `"maxItems": N` |
| `:nullable` | `"anyOf": [TYPE, {"type": "null"}]` |

### 11.7 `:strict false` Opt-Out

Individual tools can opt out when the schema is too dynamic for grammar constraint:

```rex
@tool generate-config :shrub agent/coder :strict false
  @input spec :type string
  @output config :type string
  @cost 2
  ''Generate a configuration file from a natural language spec.''
```

Default is `:strict true` — you only annotate the exception.

---

## 12. Compilation Model

### 12.1 Agent as Transducer-of-Transducers

The agent compilation model follows the sugar expansion pattern established by `@filter` (rex-gpu.js:885): tree mutation at compile time, no new runtime transducer class.

**Compile phase** (on `.rex` file parse):

```
1. Rex.parse(src)                           — fresh tree from source text
2. Rex.expandTemplates(tree)                — @use/@template expansion
3. expandAgentSugar(tree, log)              — @agent → @shrub, @tool → @def/@talk/kid
4. form.transduce(tree)                     — sees all synthetic nodes
5. behaviour.transduce(tree, true)          — compiles synthetic @talk/@def/@shrub
6. gpu._compileDeriveCompute(...)           — classify agent derives for GPU
7. fiberHost.mount(agentFiber, config)      — mount root fibers for active agents
```

Step 3 is the key: `expandAgentSugar` mutates the tree, pushing synthetic nodes that downstream transducers compile identically to hand-written nodes. No new transducer class needed.

### 12.2 Execute Phase: Fiber Render Loop

```
Each turn:
  1. Fiber host renders agent root fiber
  2. Root fiber assembles prompt (via derive evaluation)
  3. Root fiber submits LLM call to CommandRing
  4. SSE streaming → token callback → accumulate response
  5. Parse tool calls from response
  6. For each tool call:
     a. rexKeyed(toolFiber, callId, toolName, inputs)
     b. Tool fiber executes → ring.complete
  7. Flush derives (tokens-used, context-pressure, tool-reliability)
  8. Fire @dep reactions (notify subscribers)
  9. ShrubLM observes all talk invocations
  10. If more tool calls needed → next render cycle
  11. ring.endFrame(turnId)
```

### 12.3 Agent Optics: Bidirectional Tool Channels

Each tool compiles to a profunctor optic pair:

```
Forward optic (agent → tool):
  /agent/coder/slot/* → guard evaluation → @input schema → JSON params
  Compiled: slot offsets → guard AST → schema → serialization

Backward optic (tool → agent):
  JSON result → @output schema → /agent/coder/slot/* writes
  Compiled: deserialization → schema → slot offsets
```

This parallels GPU optics exactly:

```
GPU forward:  /scene/camera/fov → heap offset → uniform buffer → shader
GPU backward: storage buffer → mapAsync → heap offset → /scene/camera/hit-id

Agent forward:  /agent/coder/tool-budget → guard → JSON → API call
Agent backward: API result → JSON → /agent/coder/last-output
```

### 12.4 Agent Barriers: Tool Dependency Ordering

Tools may have implicit dependencies (read-file before edit-file). The agent barrier system parallels GPU barriers (GPU Compiler Spec §3):

```
@tool read-file   → writes /last-output
@tool edit-file   → reads /last-output (implicit barrier)
```

The compile phase detects these slot read/write dependencies and orders tool calls accordingly. Explicit barriers are also supported via `@after`:

```rex
@tool edit-file :shrub agent/coder :after read-file
  ;; Cannot execute until read-file completes
```

### 12.5 Incremental Compilation

Agent sugar nodes are stable across recompiles. The incremental diff system (`_mapChangesToPhases` at rex-gpu.js:2805) handles sugar-originated nodes:

```js
case 'agent': phases.add(3); break;     // re-expand agent sugar
case 'tool': phases.add(3); break;      // re-expand tool sugar
case 'system': case 'task':
case 'few-shot': case 'context': break; // prompt changes don't affect GPU
```

**Hot-patching:** When only prompt content changes (system text, few-shot examples), the compile phase skips tool recompilation entirely. The derive-based prompt assembly picks up the new content on next evaluation. Same pattern as `_tryHotPatchFilters` in rex-gpu.js.

### 12.6 Namespace Layout

Each agent compiles to the standard kook namespace:

```
/agent/coder/spec              ← @shrub (schema)
/agent/coder/def/tool-schema-* ← @def (tool schemas)
/agent/coder/talk/use-*        ← @talk (tool invocations)
/agent/coder/talk/start-task   ← @talk (task entry point)
/agent/coder/talk/delegate-*   ← @talk (delegation)
/agent/coder/derive/tokens-used ← @derive (computed values)
/agent/coder/dep/reviewer      ← @dep (cross-agent subscription)
/agent/coder/context/*         ← @source (context sources)
/agent/coder/heap/*            ← @heap (hot state)
```

Each kook is independently compilable, replaceable, and hot-swappable — same LLM Edit Protocol as any behaviour block.

### 12.7 PCN Integration

```
┌─────────────────────────────────────────────────┐
│ Per-Agent ShrubLM (JS-side)                     │
│  - Tool call displacement vectors               │
│  - Delegation outcome tracking                   │
│  - Guard crystallization                         │
│  - Goal-state generation for self-healing        │
├─────────────────────────────────────────────────┤
│ Cross-Agent Lateral Voting (via @dep edges)      │
│  - Coder LM votes to Reviewer LM                │
│  - Reviewer LM votes to Supervisor LM            │
│  - Flash inference: consensus without iteration  │
├─────────────────────────────────────────────────┤
│ Global PCN (GPU-side, if present)               │
│  - Cross-agent co-activation patterns            │
│  - Associative memory across entire namespace    │
│  - Coalition energy → learning rate modulation   │
└─────────────────────────────────────────────────┘
```

---

## 13. Grammar Extensions

### 13.1 New Node Types

Sugar nodes (all expand to existing constructs):

```
agent ::= '@agent' NAME NEWLINE INDENT
            slot* kids* dep*
          DEDENT

tool  ::= '@tool' NAME ':shrub' SHRUB (':strict' BOOL)? NEWLINE INDENT
            input* output* guard? cost?
            content-block?
          DEDENT

delegate ::= '@delegate' DEP-REF NEWLINE INDENT
               ':talk' ACTION
               (':input' KEY EXPR)*
               (':on-complete' TALK)?
               (':on-fail' TALK)?
               (':timeout' NUMBER)?
               (':parallel' BOOL)?
             DEDENT

response ::= '@response' SHRUB NEWLINE INDENT
               field+
             DEDENT

field ::= '@field' NAME ':type' TYPE
            (':enum' (LIST | EXPR))?
            (':format' FORMAT)?
            (':items' TYPE)?
            (':min' (NUMBER | EXPR))?
            (':max' (NUMBER | EXPR))?
            (':min-items' NUMBER)?
            (':max-items' NUMBER)?
            (':nullable')?
```

### 13.2 New Content Types

Four content types registered at startup:

```javascript
Rex.registerContentType('system');
Rex.registerContentType('task');
Rex.registerContentType('few-shot');
Rex.registerContentType('context');
```

These enable inline content blocks (`''...''`) on `@system`, `@task`, `@few-shot`, and `@context` nodes — same preprocessing path as `@shader` and `@filter`.

### 13.3 `@agent` Sugar

```
@agent NAME  →  @shrub agent/NAME + fiber mount instruction
```

The `@agent` node is rewritten to `@shrub agent/NAME` during `expandAgentSugar()`. A fiber mount instruction is recorded for the agent root fiber.

### 13.4 `@heap` for Agent State

```rex
@heap agent/coder
  @field temperature :type f32 :offset 0
  @field tool-budget :type u32 :offset 4
```

Same notation as GPU Compiler Spec §1. Compiled offsets into `FiberHeapAllocator`. Synced with shrub slots on derive flush.

### 13.5 `@use agent/target` within @talk

```rex
@talk :shrub agent/supervisor :name quick-review
  @use agent/reviewer
    :talk review
    :input code %code
```

Expands to `@delegate` with implicit continuation. See §7.4.

### 13.6 `:source` on @few-shot

```rex
@few-shot agent/coder :source [static crystallized] :budget 4000
```

Controls which example sources are included. See §8.6.

### 13.7 Dynamic Expression Attrs on @input

```rex
@input path :type string :enum (map %kids/open-files (get $item "path"))
@input line :type number :max (get (file-info %path) "line-count")
```

Expression values evaluated at prompt-assembly time. See §11.2.

### 13.8 @tool Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| `:shrub` | string | required | Agent this tool belongs to |
| `@cost` | number | 1 | Budget units per invocation |
| `:strict` | boolean | true | Enable constrained decoding on input schema |
| `:after` | string | — | Tool dependency (barrier) |
| `@input` | child node | — | Typed input parameter |
| `@output` | child node | — | Typed output field (`:to /slot` for backward optic) |
| `@guard` | expr | true | Pre-invocation condition |
| Content block | string | — | Tool description for LLM |

### 13.9 @response Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| Target | shrub ref | required | Agent this response schema belongs to |
| `@field` | child node | — | Typed response field |
| `:enum` | list or expr | — | Constrain to values (static or dynamic) |
| `:format` | string | — | JSON Schema format (`date`, `email`, `uuid`, etc.) |
| `:items` | type | — | Element type for array fields |
| `:min` | number or expr | — | Minimum value (static or dynamic) |
| `:max` | number or expr | — | Maximum value (static or dynamic) |
| `:min-items` | number | — | Minimum array length |
| `:max-items` | number | — | Maximum array length |
| `:nullable` | flag | — | Allow null values (`anyOf` wrapping) |

### 13.10 @delegate Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| Target | dep ref | required | `%dep-label` reference |
| `:talk` | string | required | Talk name on target agent |
| `:input` | key expr | — | Input parameters (repeatable) |
| `:on-complete` | string | — | Talk in this shrub on success |
| `:on-fail` | string | — | Talk in this shrub on failure |
| `:timeout` | number | 30000 | Max milliseconds |
| `:parallel` | boolean | false | Use `rexGather` for parallel dispatch |

### 13.11 @context/@source Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| `@source` | child node | — | Context source definition |
| `:refresh` | string | "on-start" | When to re-fetch |
| `:budget` | number | 1000 | Max tokens for this source |
| `:window` | number | — | Item count limit (for collections) |
| `:strategy` | string | "recency" | Selection strategy |
| `:tool` | string | — | Tool that triggers refresh (with `after-tool`) |

---

## 14. Examples

### 14.1 Minimal Agent

```rex
@agent helper
  @slot role :type string :default "helpful assistant"
  @slot model :type string :default "claude-haiku-4-5"
  @slot temperature :type number :default 0.5
  @slot max-tokens :type number :default 2048

@system agent/helper
  ''
  You are a $role. Answer concisely. No markdown.
  ''
```

Five lines of notation. One file. Complete agent with fiber execution, ShrubLM learning, and surprise detection — all from the `@agent` sugar expansion.

### 14.2 Coding Agent with Fiber

```rex
@use coding-agent :as coder :languages "typescript,react" :tool-budget 100

@system agent/coder
  ''
  You are a $role specializing in $languages.
  You have $tool-budget tool calls remaining.

  Rules:
  - Read before editing
  - Run tests after changes
  - Prefer Edit over Write for existing files
  - Never commit unless asked
  ''

@task agent/coder
  ''
  $task-description

  Project: $project-name
  Working directory: $cwd
  ''

@few-shot agent/coder :source [static crystallized] :budget 4000
  @example
    @input ''Add a dark mode toggle''
    @output
      ''
      [read-file src/pages/Settings.tsx]
      I see the settings layout. I'll add a toggle.
      [edit-file src/pages/Settings.tsx ...]
      [run-tests npm test -- --grep theme]
      Done. Tests pass.
      ''

@context agent/coder
  @source git-status :refresh on-change :budget 500
  @source open-files :refresh on-change :budget 1000
  @source test-results :refresh after-tool :tool run-tests :budget 2000
```

The `@use coding-agent` template expansion provides the shrub schema, tool definitions, and derive expressions. The fiber root mounts automatically from the `@agent` inside the template. Crystallized few-shot examples from ShrubLM augment the static examples at prompt-assembly time.

### 14.3 Multi-Agent Team with Gather

```rex
;; ─── Agents ───
@use coding-agent :as implementer :languages "go,sql" :tool-budget 150
@use base-agent :as reviewer :role "Security-focused code reviewer" :temperature 0.2 :tool-budget 20
@use base-agent :as lead :role "Engineering lead" :temperature 0.5 :tool-budget 10

;; ─── Lead's system prompt ───
@system agent/lead
  ''
  You are an engineering lead. You decompose tasks, delegate to
  implementer and reviewer, and make final approval decisions.
  You do NOT write code directly.
  ''

;; ─── Lead's delegation workflow ───
@talk :shrub agent/lead :name handle-task
  @input description :type string
  @set /status "planning"
  @set /current-task %description
  @delegate %implementer
    :talk code-task
    :input description %description
    :on-complete request-review

@talk :shrub agent/lead :name request-review
  @set /phase "reviewing"
  @delegate %reviewer
    :talk review
    :input code %implementer/last-output
    :on-complete finalize
    :on-fail request-revision

@talk :shrub agent/lead :name request-revision
  @delegate %implementer
    :talk fix-issues
    :input feedback %reviewer/last-output
    :on-complete request-review

@talk :shrub agent/lead :name finalize
  @set /status "complete"
  @set /phase "done"

;; ─── Parallel security + performance review ───
@talk :shrub agent/lead :name thorough-review
  @input code :type string
  @delegate %reviewer
    :talk review-security
    :input code %code
    :parallel true
  @delegate %reviewer
    :talk review-performance
    :input code %code
    :parallel true
  ;; rexGather joins both → continues when all complete

;; ─── Consensus check ───
@derive :shrub agent/lead :slot ready-to-merge
  (and
    (gt %implementer/__lm_confidence_code-task 0.8)
    (gt %reviewer/__lm_confidence_review 0.7))
```

Delegation chains use fiber spawn (§7.2). Parallel reviews use `rexGather` (§7.6). Consensus uses ShrubLM lateral voting across dep edges. The CommandRing profiles every delegation as a submit/complete pair.

### 14.4 Self-Healing Agent with Crystallized Few-Shot

```rex
@use base-agent :as resilient :role "Resilient task executor" :tool-budget 50

@shrub agent/resilient
  @slot success-rate :type number :default 1.0 :min 0.5 :max 1.0
  @slot error-streak :type number :default 0 :min 0 :max 5

@few-shot agent/resilient :source [static crystallized] :budget 2000
  @example
    @input ''Process a batch of files''
    @output ''[read-file ...] [run-command ...] Done.''

;; Recovery talks — ShrubLM learns which one to invoke on surprise
@talk :shrub agent/resilient :name switch-model
  @guard (gt /error-streak 2)
  @set /model (if (eq /model "claude-opus-4-6") "claude-sonnet-4-6" "claude-opus-4-6")
  @set /error-streak 0

@talk :shrub agent/resilient :name increase-budget
  @guard (lt /tool-budget 10)
  @set /tool-budget (add /tool-budget 25)

@talk :shrub agent/resilient :name ask-user
  @guard (gt /error-streak 4)
  @set /status "needs-help"
  @set /error-streak 0

;; After 20+ observations, ShrubLM crystallizes:
;;   - switch-model resolves surprise when error-streak > 2
;;   - increase-budget resolves surprise when tool-budget < 10
;;   - ask-user is last resort
;; These crystallized patterns become few-shot examples (§8.6),
;; teaching the LLM the agent's own recovery strategies.
```

---

## 15. Comparison: Rex vs JSON+MD

| Aspect | JSON+MD (OpenClaw, LangChain, CrewAI) | Rex v1 (Shrub) | Rex v2 (Shrub+Fiber) |
|---|---|---|---|
| **Config location** | 5-8 files | 1 `.rex` file | 1 `.rex` file |
| **Composition** | Copy-paste | `@template/@use` | `@template/@use` + `@agent` sugar |
| **Reactivity** | None | `@derive/@dep` | `@derive/@dep` + fiber render |
| **Type checking** | Runtime validation | Compile-time schema | Compile-time + dynamic exprs |
| **Tool guards** | if/else in Python | `@guard` expressions | `@guard` + profunctor optics |
| **Tool accounting** | Manual logging | `:cost` + ShrubLM | `:cost` + CommandRing + ShrubLM |
| **Memory** | Vector DB + embedding | `@kids` collections | `@kids` + `@heap` + `@pin` |
| **Persistence** | Custom DB | PLAN pins | PLAN pins |
| **Learning** | None | ShrubLM | ShrubLM + crystallized few-shot |
| **Self-healing** | Manual retry | Surprise → recovery | Surprise → fiber → recovery |
| **Multi-agent** | Orchestrator library | `@dep` + `@delegate` | `rexKeyed` + `rexGather` + voting |
| **Execution model** | Ad-hoc event loop | Standalone function | Fiber render loop + CommandRing |
| **Context management** | Manual injection | `@context` sources | Media-style DAG + worker offload |
| **Constrained decoding** | External library | `strict: true` | `strict: true` + dynamic exprs |
| **Profiling** | Separate system | None | CommandRing (unified) |
| **Cancellation** | Manual | Manual | Fiber unmount (automatic) |
| **Hot reload** | Restart process | Hot-swap kook | Hot-swap kook + fiber cache |

### 15.1 What Rex Eliminates

1. **No orchestrator library.** The behaviour transducer IS the orchestrator. `@dep` reactions ARE the event bus. `@derive` IS the consensus mechanism. The fiber IS the execution loop.

2. **No embedding pipeline.** Memory retrieval is a `@def` with `(fold %kids/facts ...)`. If you need semantic search, register a `similarity` stdlib function. No external vector DB.

3. **No retry logic.** ShrubLM's `_attemptRecovery()` finds corrective talks automatically. The agent learns which recovery action works for which failure mode.

4. **No agent framework dependency.** The `.rex` file IS the agent. Parse it, compile it, run it. No pip install, no npm install, no Docker image.

5. **No prompt engineering guesswork.** ShrubLM tracks which system prompt + context combination leads to successful outcomes. Crystallized patterns become few-shot examples that teach future turns.

6. **No manual profiling.** CommandRing captures every event — LLM calls, tool executions, delegations, derive flushes — in one ring buffer. Latency, cost, and error data feed back as derives.

---

## Appendix A: Standard Library Extensions

New stdlib functions for agent contexts:

| Function | Signature | Purpose |
|---|---|---|
| `token-count` | `(string) → number` | Estimate token count for a string |
| `similarity` | `(string, string) → number` | Cosine similarity (for memory retrieval) |
| `summarize` | `(string) → string` | LLM-based summarization (uses agent's own model) |
| `ends-with` | `(string, string) → boolean` | String suffix check |
| `starts-with` | `(string, string) → boolean` | String prefix check |
| `json-parse` | `(string) → value` | Parse JSON string to value |
| `json-stringify` | `(value) → string` | Serialize value to JSON |
| `timestamp` | `() → number` | Current Unix timestamp (ms) |
| `elapsed-since` | `(number) → number` | Milliseconds since given timestamp |
| `assemble` | `(system, context, few-shot, task, budget) → string` | Prompt assembly with budget trimming |
| `assemble-system` | `(...params) → string` | System prompt assembly with $param substitution |
| `trim-sources` | `(sources, budget, :strategy) → sources` | Budget-aware context trimming |
| `ring-stat` | `(metric, :type, :window) → number` | CommandRing statistic query |
| `file-info` | `(path) → {line-count, size, ...}` | File metadata for dynamic constraints |

## Appendix B: Lifecycle as Fiber States

Agent lifecycle is a fiber state machine. State transitions are talk invocations tracked by the root fiber:

```
┌──────────┐     mount()     ┌──────────┐   start-task   ┌──────────┐
│  IDLE    │────────────────→│ MOUNTED  │───────────────→│ PLANNING │
│          │                 │          │                 │          │
│ No fiber │                 │ Fiber    │                 │ Assemble │
│          │                 │ mounted, │                 │ prompt,  │
│          │                 │ waiting  │                 │ evaluate │
└──────────┘                 └──────────┘                 │ derives  │
      ↑                           ↑                      └────┬─────┘
      │                           │                           │
      │                    unmount │                    submit │ llm-call
      │                           │                           ↓
┌─────┴────┐   complete     ┌─────┴────┐    response   ┌──────────┐
│ DISPOSED │←───────────────│ COMPLETE │←──────────────│EXECUTING │
│          │                │          │                │          │
│ Fiber    │                │ Report   │                │ Tool     │
│ unmounted│                │ results, │          ┌────→│ loop,    │
│          │                │ fire deps│          │     │ ring     │
└──────────┘                └──────────┘          │     │ profiling│
                                  ↑               │     └────┬─────┘
                                  │               │          │
                            recover│          retry│    error │
                                  │               │          ↓
                            ┌─────┴────┐         ┌┴─────────┐
                            │RECOVERING│←────────│TOOL_CALL │
                            │          │  fail   │          │
                            │ Goal-    │         │ Keyed    │
                            │ state,   │         │ fiber,   │
                            │ corrective│        │ profunctor│
                            │ talk     │         │ optic    │
                            └──────────┘         └──────────┘
```

Each state is a value of the `/status` slot. Transitions are `@talk` invocations. The ShrubLM observes every transition. After enough observations, routine paths bypass guard computation (model-free fast path).

The fiber state machine is orthogonal to the shrub state — `status` is a slot, the fiber is execution infrastructure. When the fiber unmounts (DISPOSED), all in-flight tool fibers and delegate fibers are automatically cancelled.

## Appendix C: Security Model

Agent security follows from shrub isolation + fiber isolation:

1. **No cross-shrub mutation.** An agent cannot directly modify another agent's state. Communication is via `@dep` (read-only subscription) + `@delegate` (explicit invocation via fiber spawn).

2. **Guard enforcement.** Every tool call passes through a `@guard` expression. Guards are compile-time policy — they cannot be bypassed by the LLM.

3. **Budget enforcement.** `:cost` deductions from `tool-budget` are atomic mutations in `@talk`. The LLM cannot call tools without budget.

4. **Delegation depth limit.** `delegation-depth` slot with `:max 5` prevents infinite delegation recursion. The guard `(lte /delegation-depth 3)` is checked before every delegation.

5. **ShrubLM as safety net.** Surprise detection fires when agent behaviour deviates from learned patterns. An agent that suddenly makes 50 tool calls when the prototype is 5 triggers `onSurpriseSignal` → recovery.

6. **Source amendment audit trail.** Every guard synthesized by ShrubLM is visible in the `.rex` source file. Human operators can review, approve, or override learned constraints.

7. **Fiber isolation.** Each agent's root fiber runs in its own execution context. Fiber unmount cancels all in-flight operations — no dangling API calls, no orphaned tool executions.

8. **ChannelContention for write ordering.** When multiple agents write to shared state, `ChannelContention` serializes writes deterministically. No race conditions, no lost updates.

9. **CommandRing audit.** Every event (LLM call, tool execution, delegation) is logged in the ring buffer with timestamps and metadata. The ring provides a complete audit trail for security review.

## Appendix D: Migration Guide (v1 → v2)

All v1 notation is preserved. v2 is a strict superset.

### Notation Compatibility

| v1 Syntax | v2 Status | Notes |
|---|---|---|
| `@shrub agent/name` | Works | Passive reactive entity (no fiber) |
| `@tool` | Works | Expansion adds tool fiber mount internally |
| `@delegate` | Works | Expands to fiber spawn instead of mutation type |
| `@system`, `@task`, `@few-shot`, `@context` | Works | Unchanged |
| `@response` | Works | Unchanged |
| `@slot`, `@kids`, `@dep`, `@derive`, `@talk` | Works | Unchanged |
| `@channel`, `@pin` | Works | Unchanged |

### API Compatibility

| v1 API | v2 Status | Notes |
|---|---|---|
| `assemblePrompt(name, prompts, slots, params)` | Works | Wraps derive evaluation internally |
| `callLLM(config, onToken)` | Works | Wraps fiber render internally |
| `registerMutationType('delegate')` | Works | Fiber path is an optimization over mutation type |
| `expandAgentSugar(tree, log)` | Works | Returns same `{prompts, toolSchemas}` shape |
| `buildToolSchema(toolNode)` | Works | Unchanged |

### New Features (opt-in)

| Feature | How to Use | What It Adds |
|---|---|---|
| `@agent` sugar | Replace `@shrub agent/name` with `@agent name` | Automatic fiber mount |
| `@heap` | Add `@heap agent/name` block | Compiled-offset hot state |
| `:to /slot` on @output | Add to @output declarations | Backward optic (auto slot write) |
| `:source [static crystallized]` on @few-shot | Add attribute | ShrubLM-generated examples |
| `:parallel true` on @delegate | Add attribute | `rexGather` parallel dispatch |
| `@use agent/target` in @talk | Use instead of @delegate | Inline sequential delegation |
| Dynamic `:enum`/`:min`/`:max` | Use expressions in attrs | Runtime-evaluated constraints |
| `:after` on @tool | Add attribute | Explicit tool barrier |

### Upgrading

1. **Zero changes required.** All v1 `.rex` files parse and compile identically.
2. **Opt into fibers** by changing `@shrub agent/name` to `@agent name`. This mounts a root fiber.
3. **Opt into heap** by adding `@heap agent/name` blocks for frequently-accessed slots.
4. **Opt into crystallized few-shot** by adding `:source [static crystallized]` to `@few-shot`.
5. **Opt into profiling** automatically — CommandRing captures all events once the fiber is mounted.

No breaking changes. No migration scripts. No flag days.