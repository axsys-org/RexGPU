# Rex Agent Notation — Specification v1

**Version 1.0 — February 2026**

> *"Agents are shrubs. Tools are talks. Memory is kids. Learning is automatic."*
> *No new runtime. No new node types. Just notation.*
> *— RPE Agent Thesis*

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Agent Schema](#2-agent-schema)
3. [Prompt Blocks](#3-prompt-blocks)
4. [Tool Definitions](#4-tool-definitions)
5. [Memory System](#5-memory-system)
6. [Multi-Agent Delegation](#6-multi-agent-delegation)
7. [Observation & Learning](#7-observation--learning)
8. [Template Composition](#8-template-composition)
9. [Integration Points](#9-integration-points)
10. [Grammar Extensions](#10-grammar-extensions)
11. [Compilation Model](#11-compilation-model)
12. [Examples](#12-examples)
13. [Comparison: Rex vs JSON+MD](#13-comparison-rex-vs-jsonmd)

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

**Agents are shrubs.** The Rex behaviour system already provides:

| Agent Concept | Rex Primitive | Mechanism |
|---|---|---|
| Agent state | `@shrub` schema | Typed slots with :min/:max |
| Pure helpers | `@def` | Stateless functions |
| Computed values | `@derive` | Topologically ordered, dirty-tracked |
| Actions | `@talk` | Guarded, atomic mutations |
| Reactions | `@dep` | Cross-agent subscriptions |
| External bridges | `@channel` | Slot ↔ API bindings |
| Prompt text | Content blocks | `''...''` with $param substitution |
| Reuse | `@template/@use` | Parameterized expansion |
| Learning | ShrubLM | Per-agent reference frame modules |
| Self-healing | Surprise → recovery | Goal-state generation, source amendment |

No new runtime mechanisms required. An agent is a `@shrub` whose `@talk` actions include LLM calls, tool invocations, and delegation to other agents — all through existing channels and the extension protocol.

### 1.3 Principles

1. **Agents are shrubs** — no new runtime, no new node types beyond `@tool`/`@delegate` syntactic sugar
2. **Notation is configuration** — one `.rex` file replaces JSON + MD + YAML + Python glue
3. **Composition via `@template`** — reusable agent archetypes with `$param` substitution
4. **Learning is automatic** — ShrubLM tracks tool effectiveness, prompt quality, delegation success
5. **Self-healing agents** — surprise detection → goal-state → corrective action
6. **Compile/execute split** — agent definition compiles once; execution is a tight event loop
7. **Zero new abstractions** — every agent concept maps to an existing Rex primitive

---

## 2. Agent Schema

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

### 2.2 Why This Works

- **ShrubLM attaches automatically.** Every `@shrub` gets a learning module. The agent's slots define its reference frame. Tool call patterns become displacement vectors. The LM learns which configurations lead to successful outcomes.
- **:min/:max enables surprise detection.** When `tool-budget` hits 0 or `tokens-used` exceeds `context-window * 0.9`, the LM fires `onSurpriseSignal`. Recovery actions (compress context, ask user, switch model) trigger automatically.
- **`tools/[ta]` is a live registry.** Tool usage statistics are shrub state — visible to `@derive`, tracked by ShrubLM, persistable via PLAN pins. No separate analytics pipeline.
- **`messages/[ud]` is conversation history.** Fold over it to count tokens, search for patterns, or compress old messages. Same data model as any kids collection.

### 2.3 Agent vs. Shrub — No Difference

There is no `@agent` node type. The compiler sees `@shrub agent/coder` and compiles it identically to `@shrub cart` or `@shrub dashboard`. Agent behaviour emerges from:

1. The slots declared (temperature, model, tool-budget)
2. The tools defined (read-file, write-file, search)
3. The talks compiled (use-tool, delegate, compress-context)
4. The channels bridged (LLM API, filesystem, test runner)

The notation describes intent. The transducers compile it to executable form. The ShrubLM learns from runtime behaviour.

---

## 3. Prompt Blocks

### 3.1 Content Types

Four prompt content types, registered via `Rex.registerContentType()`:

| Type | Purpose | Scope |
|---|---|---|
| `@system` | System prompt (identity, rules, constraints) | One per agent |
| `@task` | Task prompt template (dynamic per invocation) | One per agent |
| `@few-shot` | Example input/output pairs | One per agent |
| `@context` | Dynamic context injection sources | One per agent |

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

  @example
    @input
      ''
      Fix the type error on line 42 of utils.ts
      ''
    @output
      ''
      [read-file src/utils.ts]

      The issue is on line 42: `items.map(i => i.name)` where
      `items` might be undefined. Adding optional chaining:

      [edit-file src/utils.ts ...]

      Fixed. The type narrows correctly now.
      ''
```

Few-shot examples teach the agent tool usage patterns. ShrubLM also learns from these — the examples seed initial prototypes for tool sequences.

### 3.5 @context — Dynamic Injection

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

Each `@source` declares:
- **:refresh** — when to re-fetch (`on-change`, `on-start`, `after-tool`, `every-turn`, `manual`)
- **:budget** — max tokens allocated to this source
- **:window** — for collections, how many items to include
- **:strategy** — selection strategy (`recency`, `relevance`, `priority`)
- **:tool** — if `:refresh after-tool`, which tool triggers refresh

### 3.6 Prompt Assembly

The agent transducer assembles the final prompt in this order:

```
┌─────────────────────────────┐
│ @system                     │ ← Identity, rules, style
│  (slot values substituted)  │
├─────────────────────────────┤
│ @context sources            │ ← Dynamic context (git, files, tests)
│  (budget-bounded)           │
├─────────────────────────────┤
│ @few-shot examples          │ ← Demonstration pairs
│  (trimmed to fit budget)    │
├─────────────────────────────┤
│ @task                       │ ← Current task description
│  (runtime params injected)  │
└─────────────────────────────┘
```

Token budget allocation is a `@derive`:

```rex
@derive :shrub agent/coder :slot prompt-budget
  (sub /context-window /tokens-used)

@derive :shrub agent/coder :slot context-budget
  (sub /prompt-budget (add /system-tokens /task-tokens /few-shot-tokens 500))
```

If `context-budget` goes negative, context sources are trimmed in reverse priority order (lowest-budget sources dropped first).

---

## 4. Tool Definitions

### 4.1 @tool — Syntactic Sugar

`@tool` is not a new primitive. It's syntactic sugar that expands to existing constructs at compile time (same pattern as `@filter` → synthetic nodes):

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

### 4.2 @tool Expansion

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

### 4.3 Tool Guards

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

### 4.4 Tool Cost Accounting

`:cost N` deducts N from `tool-budget` per invocation. This enables:

- **Expensive operations** (shell exec, API calls) cost more than cheap ones (file read)
- **Budget exhaustion** triggers surprise → recovery → ask user for more budget
- **ShrubLM tracks** cost patterns — learns which tools are worth the budget

### 4.5 Tool Failure Tracking

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

---

## 5. Memory System

### 5.1 Three Tiers

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

### 5.2 Schema

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

### 5.3 Context Window Management

```rex
@derive :shrub agent/coder :slot tokens-used
  (fold %kids/messages 0 (add $acc $item.tokens))

@derive :shrub agent/coder :slot context-pressure
  (div /tokens-used /context-window)

@derive :shrub agent/coder :slot should-compress
  (gt /context-pressure 0.8)
```

### 5.4 Auto-Compression

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

### 5.5 Memory Retrieval

```rex
@def relevant-facts :args [query category]
  (fold %kids/facts []
    (if (and
          (or (eq $item.category %category) (eq %category "all"))
          (gt (similarity $item.content %query) 0.7))
      (append $acc $item)
      $acc))
```

### 5.6 PLAN Persistence

```rex
@channel :shrub agent/coder
  @pin facts :mode on-change       ;; Persist session facts
  @pin patterns :mode on-change    ;; Persist learned patterns
  @pin tools :mode on-change       ;; Persist tool usage stats
```

PLAN pins provide orthogonal persistence. When the agent restarts, its medium-term facts and long-term patterns survive. Tool usage statistics carry over, so ShrubLM continues learning from where it left off.

---

## 6. Multi-Agent Delegation

### 6.1 Agents as Dep Sources

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

### 6.2 @delegate — Cross-Agent Invocation

`@delegate` is a new mutation type, registered via `registerMutationType('delegate', handler)`. It compiles within the existing mutation framework.

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

### 6.3 @delegate Semantics

```
@delegate TARGET
  :talk ACTION           ← talk name on target agent
  :input KEY VALUE       ← inputs to pass (repeatable)
  :on-complete TALK      ← talk to fire in THIS shrub on success
  :on-fail TALK          ← talk to fire in THIS shrub on failure
  :timeout NUMBER        ← max milliseconds (optional)
```

**Compilation:** `@delegate` expands to:

1. `fireTalk(targetShrub, action, inputs)` — invoke the target agent's talk
2. Install a `@dep` reaction watching the target's `/status` slot
3. When target's status becomes `"complete"` → fire `:on-complete` talk in this shrub
4. When target's status becomes `"error"` → fire `:on-fail` talk in this shrub
5. Increment `/delegation-depth` on the target (prevents infinite recursion)

### 6.4 Delegation Chains

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

### 6.5 Multi-Agent Consensus via Lateral Voting

ShrubLM lateral voting operates across `@dep` edges between agents:

```rex
@derive :shrub agent/supervisor :slot code-ready
  (and
    (gt %coder/__lm_confidence_code-task 0.8)
    (gt %reviewer/__lm_confidence_review 0.7)
    (gt %tester/__lm_confidence_test-pass 0.7))
```

After enough successful delegation chains, the supervisor's ShrubLM crystallizes the pattern "code → review → test" as canonical. Flash inference: if all three sub-agents report high confidence, the supervisor can fast-path approval without re-evaluating.

### 6.6 Parallel Delegation

```rex
@talk :shrub agent/supervisor :name parallel-review
  @input code :type string
  @set /strategy "parallel"

  ;; Fire all three in parallel
  @delegate %reviewer
    :talk review-security
    :input code %code

  @delegate %reviewer
    :talk review-performance
    :input code %code

  @delegate %reviewer
    :talk review-style
    :input code %code

  ;; All three update %reviewer's slots independently
  ;; Supervisor's @derive aggregates results

@derive :shrub agent/supervisor :slot all-reviews-pass
  (and
    %reviewer/security-ok
    %reviewer/performance-ok
    %reviewer/style-ok)
```

---

## 7. Observation & Learning

### 7.1 ShrubLM on Agents

ShrubLM operates on agents identically to any shrub. No special agent-aware code. The learning module sees:

- **Slot-space dimensions**: temperature, tool-budget, tokens-used, turn-count, tool-reliability
- **Displacement vectors**: each talk invocation (use-tool, delegate, compress-context) produces measurable slot changes
- **:min/:max ranges**: enable normalized comparison and surprise detection

### 7.2 What Gets Learned

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

### 7.3 Surprise Detection

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

### 7.4 Self-Modifying Agent Configs

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

### 7.5 ShrubLM Feedback Slots

```rex
;; Auto-written by ShrubLM, readable by @derive
@slot __lm_confidence_code-task :type number :default 0
@slot __lm_ready_code-task :type number :default 0
@slot __lm_confidence_use-read-file :type number :default 0
@slot __lm_confidence_use-edit-file :type number :default 0
@slot __lm_bypass_compress-context :type number :default 0
```

These slots enable the model-free fast path. After sufficient observations, routine operations bypass guard computation entirely — same mechanism as Thousand Brains' efficient habits.

---

## 8. Template Composition

### 8.1 Base Agent Template

```rex
@template base-agent
  @param role :default "assistant"
  @param model :default "claude-opus-4-6"
  @param temperature :default 0.7
  @param max-tokens :default 4096
  @param tool-budget :default 50
  @param context-window :default 200000

  @shrub agent/$name
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

### 8.2 Coding Agent Template

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

### 8.3 Instantiation

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

### 8.4 Template Nesting

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

## 9. Integration Points

### 9.1 @channel — API Bridges

```rex
@channel :shrub agent/coder
  @bind temperature model max-tokens :to llm-api :mode on-change
  @bind status current-task :to dashboard :mode every-frame
  @bind tool-budget tokens-used :to metrics :mode on-change
```

Channel bridges connect agent slots to external systems. When `temperature` changes (via a talk or derive), the LLM API channel picks up the new value on the next call. Same mechanism as GPU heap channels.

### 9.2 @readback — API → Agent State

```rex
@readback :shrub agent/coder
  @source llm-api :field response → /last-response
  @source llm-api :field usage → /tokens-used
  @source llm-api :field finish-reason → /last-finish-reason
```

API responses write back into agent slots via readback bridges. This enables @derive expressions to react to API output — token usage tracking, error detection, rate limit handling.

### 9.3 Compile/Execute Split

**Compile phase** (on `.rex` file parse):
1. Parse `@shrub agent/*` → extract schema, compile slots
2. Expand `@tool` sugar → inject @def + @talk + tool kid entries
3. Register `@delegate` mutation type
4. Assemble prompt templates (resolve $params against slot defaults)
5. Build ShrubLM reference frame from slot declarations
6. Register @dep edges for multi-agent wiring
7. Compile @derive/@talk/@dep blocks as standard behaviour kooks

**Execute phase** (on task arrival):
1. `fireTalk(agent, 'start-task', {description})` → sets `/current-task`, `/status`
2. Assemble prompt: @system + @context + @few-shot + @task
3. Call LLM API via @channel bridge
4. Parse response → extract tool calls
5. For each tool call: `fireTalk(agent, 'use-TOOL', {inputs})`
6. Tool execution → result → append to `/messages`
7. If more tool calls needed → loop to step 2
8. Flush @derive (tokens-used, context-pressure, tool-reliability)
9. Fire @dep reactions (notify supervisor of completion)
10. ShrubLM observes all talk invocations → update prototypes

### 9.4 PCN Integration

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

## 10. Grammar Extensions

### 10.1 New Node Types

Only two new syntactic sugars (both expand to existing constructs):

```
tool  ::= '@tool' NAME ':shrub' SHRUB NEWLINE INDENT
            input* output* guard? cost?
            content-block?
          DEDENT

delegate ::= '@delegate' DEP-REF NEWLINE INDENT
               ':talk' ACTION
               (':input' KEY EXPR)*
               (':on-complete' TALK)?
               (':on-fail' TALK)?
               (':timeout' NUMBER)?
             DEDENT
```

### 10.2 New Content Types

Four content types registered at startup:

```javascript
Rex.registerContentType('system');
Rex.registerContentType('task');
Rex.registerContentType('few-shot');
Rex.registerContentType('context');
```

These enable inline content blocks (`''...''`) on `@system`, `@task`, `@few-shot`, and `@context` nodes — same preprocessing path as `@shader` and `@filter`.

### 10.3 @tool Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| `:shrub` | string | required | Agent this tool belongs to |
| `:cost` | number | 1 | Budget units per invocation |
| `@input` | child node | — | Typed input parameter |
| `@output` | child node | — | Typed output field |
| `@guard` | expr | true | Pre-invocation condition |
| Content block | string | — | Tool description for LLM |

### 10.4 @delegate Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| Target | dep ref | required | `%dep-label` reference |
| `:talk` | string | required | Talk name on target agent |
| `:input` | key expr | — | Input parameters (repeatable) |
| `:on-complete` | string | — | Talk in this shrub on success |
| `:on-fail` | string | — | Talk in this shrub on failure |
| `:timeout` | number | 30000 | Max milliseconds |

### 10.5 @context Attributes

| Attribute | Type | Default | Purpose |
|---|---|---|---|
| `@source` | child node | — | Context source definition |
| `:refresh` | string | "on-start" | When to re-fetch |
| `:budget` | number | 1000 | Max tokens for this source |
| `:window` | number | — | Item count limit (for collections) |
| `:strategy` | string | "recency" | Selection strategy |
| `:tool` | string | — | Tool that triggers refresh (with `after-tool`) |

---

## 11. Compilation Model

### 11.1 Agent Transducer

A new `rex-agent.js` transducer, following the exact same pattern as `rex-gpu.js`, `rex-surface.js`, `rex-behaviour.js`, and `rex-form.js`:

```javascript
export class RexAgent {
  constructor(log) {
    this._agents = new Map();       // shrubName → compiled agent
    this._tools = new Map();        // shrubName → Map<toolName, toolDef>
    this._prompts = new Map();      // shrubName → {system, task, fewShot, context}
    this._warnedTypes = new Set();
  }

  transduce(tree, structureChanged) {
    if (structureChanged) {
      this._compile(tree);
    }
    this._execute();
  }

  _compile(tree) {
    // Phase 1: Expand @tool sugar → synthetic @def + @talk + kid entries
    this._compileTools(tree);

    // Phase 2: Extract prompt blocks (@system, @task, @few-shot, @context)
    this._compilePrompts(tree);

    // Phase 3: Register @delegate mutation type
    this._registerDelegate();
  }

  _compileTools(tree) {
    // Same pattern as _compileFilters in rex-gpu.js:
    // Scan tree for @tool nodes → expand to synthetic standard nodes → push to tree.children
  }

  _compilePrompts(tree) {
    // Extract @system, @task, @few-shot, @context blocks
    // Store in _prompts map keyed by agent shrub name
  }

  assemblePrompt(agentName, taskParams) {
    // Resolve $params, enforce token budgets, return final prompt string
  }

  // Extension protocol
  registerToolType(name, handler) { /* ... */ }
}
```

### 11.2 Transducer Wiring (main.js)

```javascript
// In main.js orchestrator:
agent = new RexAgent(log);

// Wire bridges:
agent.onToolCall = (agentName, toolName, inputs) => {
  behaviour.fireTalk(agentName, `use-${toolName}`, inputs);
};

agent.onDelegation = (fromAgent, toAgent, talk, inputs) => {
  behaviour.fireTalk(toAgent, talk, inputs);
};

behaviour.onTalkFired = (record) => {
  pcn.pushBehaviourEvent(record);     // ShrubLM observation
  agent.onTalkCompleted(record);      // Agent event tracking
};

// Compile order:
// parser → form → behaviour → agent → GPU → surface → audio → PCN
```

### 11.3 Namespace Layout

Each agent compiles to the standard kook namespace:

```
/agent/coder/spec              ← @shrub (schema)
/agent/coder/def/tool-schema-* ← @def (tool schemas)
/agent/coder/talk/use-*        ← @talk (tool invocations)
/agent/coder/talk/start-task   ← @talk (task entry point)
/agent/coder/talk/delegate-*   ← @talk (delegation)
/agent/coder/derive/tokens-used ← @derive (computed values)
/agent/coder/dep/reviewer      ← @dep (cross-agent subscription)
```

Each kook is independently compilable, replaceable, and hot-swappable — same LLM Edit Protocol as any behaviour block.

---

## 12. Examples

### 12.1 Minimal Agent

```rex
@shrub agent/helper
  @slot role :type string :default "helpful assistant"
  @slot model :type string :default "claude-haiku-4-5"
  @slot temperature :type number :default 0.5
  @slot max-tokens :type number :default 2048

@system agent/helper
  ''
  You are a $role. Answer concisely. No markdown.
  ''
```

Five lines. One file. Complete agent definition.

### 12.2 Coding Agent (Full)

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

@context agent/coder
  @source git-status :refresh on-change :budget 500
  @source open-files :refresh on-change :budget 1000
  @source test-results :refresh after-tool :tool run-tests :budget 2000
```

### 12.3 Multi-Agent Team

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

;; ─── Consensus check ───
@derive :shrub agent/lead :slot ready-to-merge
  (and
    (gt %implementer/__lm_confidence_code-task 0.8)
    (gt %reviewer/__lm_confidence_review 0.7))
```

### 12.4 Self-Healing Agent

```rex
@use base-agent :as resilient :role "Resilient task executor" :tool-budget 50

@slot success-rate :type number :default 1.0 :min 0.5 :max 1.0
@slot error-streak :type number :default 0 :min 0 :max 5

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

;; ShrubLM will learn:
;; - switch-model resolves surprise when error-streak > 2
;; - increase-budget resolves surprise when tool-budget is low
;; - ask-user is the last resort
;; These patterns crystallize into guards automatically
```

---

## 13. Comparison: Rex vs JSON+MD

| Aspect | JSON+MD (OpenClaw, LangChain, CrewAI) | Rex Agent Notation |
|---|---|---|
| **Config location** | 5-8 files (agent.json, system.md, tools.json, config.yaml, orchestrator.py) | 1 `.rex` file |
| **Composition** | Copy-paste | `@template/@use` with `$param` |
| **Reactivity** | None (static config) | `@derive/@dep` (live reactive graph) |
| **Type checking** | Runtime validation | Compile-time schema (`:type`, `:min`, `:max`) |
| **Tool guards** | if/else in Python | `@guard` expressions (learnable) |
| **Tool accounting** | Manual logging | `:cost` + `/tool-budget` slot + ShrubLM tracking |
| **Memory** | Vector DB + embedding pipeline | `@kids` collections + `@derive` queries |
| **Persistence** | Custom DB integration | PLAN pins (orthogonal persistence) |
| **Learning** | None | ShrubLM (automatic per-agent) |
| **Self-healing** | Manual retry with backoff | Surprise → goal-state → corrective talk |
| **Multi-agent** | Orchestrator library (CrewAI, AutoGen) | `@dep` + `@delegate` + lateral voting |
| **Version control** | JSON merge conflicts | Tree diff (indentation-based) |
| **Hot reload** | Restart process | Hot-swap one kook |
| **Prompt management** | Jinja/string templates | Content blocks + `@derive` token budget |
| **Agent identity** | Scattered across files | `@shrub` schema (one place) |
| **Cross-agent consensus** | Custom voting logic | ShrubLM lateral voting (automatic) |

### 13.1 What Rex Eliminates

1. **No orchestrator library.** The behaviour transducer IS the orchestrator. `@dep` reactions ARE the event bus. `@derive` IS the consensus mechanism.

2. **No embedding pipeline.** Memory retrieval is a `@def` with `(fold %kids/facts ...)`. If you need semantic search, register a `similarity` stdlib function. No external vector DB.

3. **No retry logic.** ShrubLM's `_attemptRecovery()` finds corrective talks automatically. The agent learns which recovery action works for which failure mode.

4. **No agent framework dependency.** The `.rex` file IS the agent. Parse it, compile it, run it. No pip install, no npm install, no Docker image.

5. **No prompt engineering guesswork.** ShrubLM tracks which system prompt + context combination leads to successful outcomes. Crystallized patterns become facts in long-term memory.

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

## Appendix B: Agent Lifecycle

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌──────────┐
│  IDLE    │────→│  PLANNING │────→│ EXECUTING│────→│ COMPLETE │
│          │     │           │     │          │     │          │
│ Waiting  │     │ Assemble  │     │ Tool     │     │ Report   │
│ for task │     │ prompt    │     │ loop     │     │ results  │
└──────────┘     └───────────┘     └──────────┘     └──────────┘
      ↑                                  │                │
      │                                  ↓                │
      │                           ┌──────────┐            │
      │                           │  ERROR   │            │
      │                           │          │            │
      │                           │ Recovery │            │
      │                           │ or       │            │
      └───────────────────────────│ ask-user │            │
      └───────────────────────────└──────────┘────────────┘
```

State transitions are `@talk` invocations. The ShrubLM observes every transition. After enough observations, routine paths (IDLE → PLANNING → EXECUTING → COMPLETE) bypass guard computation.

## Appendix C: Security Model

Agent security follows from shrub isolation:

1. **No cross-shrub mutation.** An agent cannot directly modify another agent's state. Communication is via `@dep` (read-only subscription) + `@delegate` (explicit invocation).

2. **Guard enforcement.** Every tool call passes through a `@guard` expression. Guards are compile-time policy — they cannot be bypassed by the LLM.

3. **Budget enforcement.** `:cost` deductions from `tool-budget` are atomic mutations in `@talk`. The LLM cannot call tools without budget.

4. **Delegation depth limit.** `delegation-depth` slot with `:max 5` prevents infinite delegation recursion. The guard `(lte /delegation-depth 3)` is checked before every delegation.

5. **ShrubLM as safety net.** Surprise detection fires when agent behaviour deviates from learned patterns. An agent that suddenly makes 50 tool calls when the prototype is 5 triggers `onSurpriseSignal` → recovery.

6. **Source amendment audit trail.** Every guard synthesized by ShrubLM is visible in the `.rex` source file. Human operators can review, approve, or override learned constraints.
