# Sugar+Fiber Architecture Specification v1

**Compile-time tree expansion + fiber-based resource lifecycle for @media and @agent in the Rex Projection Engine.**

---

## Core Thesis

@media and @tool are NOT new transducers. They follow the same pattern as @filter (rex-gpu.js:879–1150): **compile-time sugar that expands to synthetic standard nodes**. The shrub IS the universal abstraction. The fiber runtime provides resource lifecycle that survives recompile.

```
@filter bloom :src scene        →  synthetic @texture + @shader + @pipeline + @dispatch
@media bg :type image :src url  →  synthetic @texture + resource fiber
@tool search :shrub agent       →  synthetic @def + @talk + mutations
```

Zero new runtime mechanisms. Zero parallel namespaces. Zero parallel dirty-tracking.

---

## §1 — Architectural Invariants

1. **Single tree.** All transducers read the same `Rex.parse()` output. Sugar modules mutate this tree before transducers compile. Synthetic nodes are indistinguishable from hand-written nodes.

2. **Single heap.** GPU buffers, textures, and optics live in one compiled heap. Media resources resolve to the same `_textures` / `_samplers` / `_buffers` Maps that hand-written @texture nodes use.

3. **Single optic system.** `@bind 0 :texture mediaImg` works because `mediaImg` IS a @texture. No `:media` bind variant needed for Phase A.

4. **Fiber lifecycle.** `rexUseResource(factory, [deps])` caches resources across recompiles. The fiber host persists in main.js scope. Only `expand()` re-runs on recompile — fiber state is untouched.

5. **ShrubLM uniformity.** Tool calls are @talk invocations → slot displacements → prototypes → crystallization. Media state changes are shrub slot writes → same pipeline. No special-casing.

---

## §2 — Compile Order

```
1. Rex.parse(src)                       — fresh tree from source text
2. Rex.expandTemplates(tree)            — @use/@template expansion
3. mediaSugar.expand(tree)              — @media → synthetic @texture/@samples/@shrub
4. expandAgentSugar(tree, log)          — @tool → synthetic @def/@talk, extract prompt content
5. form.transduce(tree)                 — sees all synthetic nodes
6. behaviour.transduce(tree, true)      — compiles synthetic @talk/@def/@shrub
7. gpu._compileDeriveCompute(...)       — unchanged
8. pcn / surface / audio                — see synthetic @texture/@samples
```

Sugar at steps 3–4 MUST run before all transducers. Synthetic nodes appear in both prev and next trees for the incremental diff (rex-gpu.js:2428) — stable nodes produce zero diff, so resources survive keystroke edits.

### Frame Loop

```
mediaSugar.tick(gpu)           — flush fiber host, importExternalTexture for video
gpu.transduce(tree, sc)        — consumes textures within same RAF macrotask
pcn.transduce(enc)             — unchanged
surface.compile / execute      — unchanged
audio.transduce(tree, false)   — unchanged
```

`mediaSugar.tick()` runs before `gpu.transduce()` because `importExternalTexture` lifetime = current JS task.

---

## §3 — rex-media.js: Media Sugar + Fiber Hybrid

### §3.1 — Node Vocabulary

```rex
@media name :type TYPE :src URL
  @track child-name              ;; named sub-resource (stems, clips, bones)
```

`:type` values: `image`, `video`, `audio`, `sample-bank`. Auto-detected from extension if omitted.

Additional attrs: `:width N`, `:height N`, `:format rgba8unorm`, `:filter linear|nearest`, `:wrap repeat|clamp-to-edge`, `:mips true`, `:loop true`, `:lazy true`.

### §3.2 — Expansion Rules

| @media :type | Expands to | Existing handler |
|---|---|---|
| `image` | `@texture name :src URL :width W :height H ...` | `gpu._compileTextures` (rex-gpu.js:1337) |
| `video` | `@texture name :type video :video-element ID` | `gpu._videoTextures` (rex-gpu.js:1364) |
| `audio` | `@shrub media/name` with slots: state, bpm, duration | `behaviour._compile` (rex-behaviour.js:100) |
| `sample-bank` | `@samples name :src URL` with @sample children | `audio._compileSampleMap` (rex-audio.js:805) |

Synthetic node shape (mirrors filter expansion at rex-gpu.js:1128):
```js
{type:'texture', name:mediaName, attrs:{src, width, height, format, ...}, children:[], content:null, _d:1}
```

### §3.3 — Class Shape

```js
class RexMediaSugar {
  constructor(device, audioCtx, log)

  // Tree mutation — runs at compile step 3
  expand(tree)

  // Per-frame — runs before gpu.transduce
  tick(gpu)

  // Namespace reads (for downstream consumers)
  get(name)                     // → {value, type, version, src} | null
  getTexture(name)              // → GPUTexture | null
  getAudioBuffer(name)          // → AudioBuffer | null
  getSampleBank(name)           // → AudioBuffer[] | null
  isLive(name)                  // → boolean
  isDirty(name, knownVersion)   // → boolean

  // Extension
  registerAssetType(type, handler)
  // handler: { detect(src)→bool, expand(node, tree)→void, load(src, attrs)→Promise }
}
```

Internal state:
```js
this._device          // GPUDevice (may be null if no WebGPU)
this._audioCtx        // AudioContext (may be null until user interaction)
this._log             // logging function
this._fiberHost       // RexFiberHost — persistent across recompiles
this._resourceFibers  // Map<name, RexFiber> — one fiber per @media asset
this._loadedResources // Map<name, {value, type, version, src}>
this._liveVideos      // Map<name, {element: HTMLVideoElement, externalTex}>
this._handlers        // Map<type, handler> — extension registry
this._warnedTypes     // Set — warn-once per unknown type
```

### §3.4 — Fiber Resource Lifecycle

Each `@media` asset gets a dedicated fiber via `_mountResourceFiber(name, src, type, attrs)`:

```
expand() called on recompile
  ├─ push synthetic @texture to tree (GPU transducer creates placeholder)
  └─ _mountResourceFiber(name, src, type, attrs)
       ├─ if fiber exists with same src → skip (deps unchanged, cached)
       ├─ if fiber exists with different src → unmount old, mount new
       └─ mount new fiber:
            └─ rexUseResource((dispose) => {
                 _asyncLoad(src, type, attrs)
                   .then(loaded => {
                     _loadedResources.set(name, entry)
                     _replaceTexture(name, loaded)  // swap placeholder → real
                   })
                 dispose(() => resource.destroy())
               }, [src])    // deps = [src]
```

**Recompile behavior**: `rexUseResource` checks deps. Same `[src]` → return cached result → no network re-fetch. The `_replaceTexture` callback fires immediately with cached bitmap → placeholder replaced in <1 frame.

### §3.5 — Async Loaders

**Image**: `fetch(src) → resp.blob() → createImageBitmap(blob, opts) → return bitmap`
Then `_replaceTexture`: `device.createTexture → copyExternalImageToTexture → gpu._textures.set(name, tex) → gpu._bindGroups.clear()`

**Video**: Create HTMLVideoElement, set src, `el.play()`, store in `_liveVideos`. Per-frame in `tick()`: `device.importExternalTexture({source: el})`.

**Audio**: `fetch(src) → resp.arrayBuffer() → audioCtx.decodeAudioData(buf) → store AudioBuffer`. Write BPM/duration to shrub slots via `behaviour.pushFormValue()`.

**Sample Bank**: Fetch JSON manifest → `Promise.all(urls.map(url => fetch+decode))` → store `AudioBuffer[]`.

### §3.6 — Extension Protocol

```js
mediaSugar.registerAssetType('gltf', {
  detect(src) { return /\.(gltf|glb)$/i.test(src); },
  expand(node, tree) {
    // push synthetic @vertex-buffer + @index-buffer + @struct nodes
  },
  load(src, attrs) {
    // return Promise<parsed mesh data>
  }
});
```

---

## §4 — rex-agent.js: Agent Sugar

### §4.1 — Content Type Registration

Module-scope (runs at load time, before any Rex.parse call):
```js
Rex.registerContentType('system');
Rex.registerContentType('task');
Rex.registerContentType('few-shot');
Rex.registerContentType('context');
```

These enable `''...''` content block capture on those node types, identical to how `@shader` captures WGSL code. The parser's preprocessor (rex-parser.js:2098) checks `_contentTypes` during parse.

### §4.2 — @tool Expansion

```rex
@tool read-file :shrub agent/coder :cost 1
  @input path :type string :description "File path to read"
  @input max-lines :type number :min 1 :max 10000
  @output content :type string :to /last-output
  @guard (gt /tool-budget 0)
  ''
  Read the contents of a file at the given path.
  ''
```

Expands to:

```rex
;; Synthetic @talk — behaviour compiles as invocable action
@talk :shrub agent/coder :name use-read-file
  @guard (gt /tool-budget 0)
  @set /tool-budget = (sub /tool-budget 1)
  @set /turn-count = (add /turn-count 1)
```

Synthetic node pushed to `tree.children`:
```js
{type:'talk', name:null, attrs:{shrub:'agent/coder', name:'use-read-file'}, children:[
  guardNode,                          // carried from @tool
  {type:'set', attrs:{path:'/tool-budget', _expr:{op:'call',fn:'sub',args:[
    {op:'slot',path:'/tool-budget'}, {op:'lit',value:1}
  ]}}},
  {type:'set', attrs:{path:'/turn-count', _expr:{op:'call',fn:'add',args:[
    {op:'slot',path:'/turn-count'}, {op:'lit',value:1}
  ]}}},
], _d:1}
```

The `_expr` attribute uses pre-compiled expression AST format recognized by `behaviour._extractExpr` (rex-behaviour.js:1332).

**Tool fiber mount (v2):** Each tool invocation is also tracked as a keyed fiber via `rexKeyed` (rex-fiber.js:212). During agent execution, tool calls expand to:

```js
// Inside agentFiber render:
rexKeyed(toolFiber, toolCall.id, toolCall.name, toolCall.inputs);
```

This provides individual cancellation, profiling via `CommandRing.submit/complete` (rex-fiber.js:933), and keyed reconciliation for deduplication.

**Backward optic (v2):** The `@output :to /slot` attribute compiles to a slot write on tool completion — the backward half of the profunctor optic (Rex-Agent-Spec §4.2). If `:to` is omitted, the output is returned to the LLM but not written to a slot.

### §4.3 — @delegate as Fiber Spawn

In v1, delegation was registered via `behaviour.registerMutationType('delegate', handler)` (rex-behaviour.js:48). In v2, `@delegate` expands to `rexKeyed(delegateFiber, ...)` (rex-fiber.js:212):

```rex
@talk :shrub agent/manager :name assign-review
  @delegate
    :target agent/reviewer
    :talk review-code
    :input code /last-output
    :on-complete handle-review-done
    :on-fail handle-review-error
    :timeout 30000
```

**v2 expansion:**
```js
rexKeyed(delegateFiber, 'reviewer-review-code', {
  target: 'agent/reviewer',
  talk: 'review-code',
  inputs: { code: getSlotValue('last-output') },
  onComplete: 'handle-review-done',
  onFail: 'handle-review-error',
  timeout: 30000
});
```

The delegate fiber:
1. `behaviour.fireTalk(target, talk, inputs)` — invoke target agent's talk
2. Watch target `/status` slot for completion (via derive, not ad-hoc polling)
3. On complete → fire `:on-complete` talk in parent shrub
4. On error → fire `:on-fail` talk in parent shrub
5. On timeout → unmount fiber → fire `:on-fail` with `{error: "timeout"}`
6. On parent fiber unmount → natural cancellation of in-flight delegation

**Parallel delegation:** When multiple `@delegate` nodes carry `:parallel true`, they expand to `rexGather` (rex-fiber.js:200) for join semantics.

**Backward compatibility:** `registerMutationType('delegate')` still works — the fiber path is an optimization over the mutation type.

### §4.4 — Tool Schema Builder

`buildToolSchema(toolNode)` → JSON Schema for Anthropic API `tools[]`:

| Rex `:type` | JSON Schema | Additional attrs |
|---|---|---|
| `string` | `"string"` | `:enum` (static list or expression), `:format` |
| `number` | `"number"` | `:min` → minimum, `:max` → maximum (static or expression) |
| `boolean` | `"boolean"` | |
| `array` | `"array"` | `:items TYPE`, `:min-items`, `:max-items` |
| `object` | `"object"` | nested `@field` children |

Always: `additionalProperties: false`, all fields in `required`, `strict: true` (opt-out via `:strict false`).

**Dynamic constraints (v2):** Expression values on `:enum`, `:min`, `:max` are evaluated at prompt-assembly time via `compileExprToJsonSchema(node, ctx)` — same expression AST, different backend target (JSON Schema instead of WGSL). See Rex-Agent-Spec §11.

### §4.5 — Prompt Assembly

`assemblePrompt(agentName, prompts, slotValues, taskParams)`:

1. **$param substitution**: sort keys longest-first, `replaceAll('$key', String(value))`
2. **Assembly order**: system → context → few-shot → task
3. Returns `{system: string, task: string}`

**v2 derive integration:** Prompt assembly is now a `@derive` expression (Rex-Agent-Spec §3.5). The `assemblePrompt()` function wraps derive evaluation for backward compatibility:

```js
function assemblePrompt(agentName, taskParams) {
  behaviour.pushFormValue(`agent/${agentName}`, 'task-description', taskParams.description);
  behaviour._flushDerives();
  return behaviour.getSlotValue(`agent/${agentName}`, 'assembled-prompt');
}
```

Prompts are extracted from nodes during `expandAgentSugar()` — their `.content` field was captured by the parser's content-type preprocessor. Crystallized few-shot examples from ShrubLM are auto-injected when `:source [static crystallized]` is declared.

### §4.6 — callLLM

Extends the SSE streaming pattern from claude-api.js:217–256:

```js
async function callLLM(config, onToken) {
  // config: {system, task, tools, messages, responseSchema, model, maxTokens, apiKey}
  const body = {
    model: config.model || 'claude-sonnet-4-5-20241022',
    max_tokens: config.maxTokens || 4096,
    stream: true,
    system: config.system,
    messages: config.messages || [{role:'user', content: config.task}],
  };
  if (config.tools?.length) body.tools = config.tools;
  if (config.responseSchema) {
    body.output_config = {format: {type:'json_schema', schema: config.responseSchema}};
  }
  // SSE streaming, tool_use block parsing, return {text, toolCalls}
}
```

**v2 CommandRing integration:** Each `callLLM` invocation is tracked via the agent's CommandRing (rex-fiber.js:933):

```js
const sqeId = ring.submit('llm-call', { model, tokens_in, system_hash });
// ... SSE streaming ...
ring.complete(sqeId, { tokens_out, finish_reason, latency_ms });
```

Tool use blocks in the response are parsed and returned for the caller to dispatch via `behaviour.fireTalk()`. Each tool call is subsequently tracked as its own ring entry.

### §4.7 — Exported API

```js
// Module-scope: Rex.registerContentType calls (4 types)

// Functions:
expandAgentSugar(tree, log)    → {prompts: Map, toolSchemas: Map}
registerDelegate(behaviour)     → void  // v1 compat; v2 uses fiber spawn
buildToolSchema(toolNode)       → JSON Schema object
assemblePrompt(name, prompts, slots, params) → {system, task}  // wraps derive eval in v2
callLLM(config, onToken)        → Promise<{text, toolCalls}>

// v2 additions:
compileExprToJsonSchema(node, ctx)  → JSON Schema fragment
```

---

## §5 — Build Integration

### SRC_FILES order (build.js)

```js
const SRC_FILES = [
  'rex-parser',       // 1. parser + content type registry
  'rex-gpu',          // 2. GPU transducer
  'rex-surface',      // 3. surface transducer
  'rex-form',         // 4. form transducer
  'rex-behaviour',    // 5. behaviour transducer + registerMutationType
  'rex-agent',        // 6. NEW — module scope: registerContentType('system'|'task'|...)
  'rex-pcn',          // 7. PCN + ShrubLM
  'rex-audio',        // 8. audio transducer
  'rex-fiber',        // 9. fiber runtime (RexFiberHost, rexUseResource, etc.)
  'rex-media',        // 10. NEW — class uses RexFiberHost (defined at step 9)
  'plan-bridge',      // 11. PLAN bridge
  'tab-manager',      // 12. tab manager
  'claude-api',       // 13. existing Claude API (preserved, callLLM is superset)
  'main',             // 14. orchestrator — instantiates + wires everything
];
```

Ordering rationale:
- rex-agent at 6: module-scope `Rex.registerContentType()` runs before `Rex.parse()` in main
- rex-media at 10: class definition references `RexFiberHost` class from rex-fiber at 9
- Constructor calls happen from main.js (14), so all classes are defined by then

---

## §6 — main.js Wiring

### Instantiation (after behaviour, ~line 420)

```js
// Agent sugar — register delegate mutation type (v1 compat)
registerDelegate(behaviour);

// Agent fiber host — persistent across recompiles (v2)
const agentFiberHost = new RexFiberHost(65536);  // 64KB heap for agent fibers

// Media sugar — fiber-based resource lifecycle
const mediaSugar = new RexMediaSugar(gpuOk ? gpu.device : null, audio._ctx, log);
if (gpuOk) gpu._media = mediaSugar;  // media replaces textures via gpu._textures

window._agent = { assemblePrompt, callLLM, buildToolSchema, agentFiberHost };
window._media = mediaSugar;
```

### parseSource (line ~462)

After `Rex.expandTemplates`, before `form.transduce`:
```js
currentTree = Rex.expandTemplates(currentTree);
mediaSugar.expand(currentTree);                    // @media → @texture/@samples/@shrub
const agentCompiled = expandAgentSugar(currentTree, log);  // @tool → @def/@talk, @agent → @shrub

// v2: Mount root fibers for each @agent node
for (const [agentName, config] of agentCompiled.agents) {
  agentFiberHost.mount(agentFiber, [agentName, config]);
}

form.transduce(currentTree);                       // existing — sees synthetic nodes
behaviour.transduce(currentTree, true);            // existing — compiles synthetic @talk/@def
```

### Frame loop (line ~692)

Before `gpu.transduce`:
```js
if (mediaSugar) {
  try { mediaSugar.tick(gpu); } catch(em) { log(`media: ${em.message}`, 'err'); }
}

// v2: Flush agent fibers (resource lifecycle, pending tool completions)
if (agentFiberHost) {
  try { agentFiberHost.flush(); } catch(ea) { log(`agent: ${ea.message}`, 'err'); }
}
```

---

## §7 — rex-gpu.js Changes

### Incremental diff awareness (line 2456, `_mapChangesToPhases`)

Add cases so sugar-originated nodes don't trigger full recompile:
```js
case 'media': phases.add(7); break;           // media changes affect textures
case 'tool': break;                            // tool changes affect behaviour only
case 'system': case 'task':
case 'few-shot': case 'context': break;        // prompt changes don't affect GPU
```

### Texture replacement access

Media sugar calls `gpu._textures.set(name, newTex)` + `gpu._bindGroups.clear()` + `gpu._frameDirty = true` to swap placeholder textures after async load. This follows the existing pattern where surface accesses `gpu._textures` directly.

---

## §8 — Fiber Recompile Invariant

**Theorem**: Media resources loaded via `rexUseResource(factory, [src])` are never re-fetched when the user edits unrelated source code.

**Proof**:
1. `Rex.parse(src)` produces a fresh tree (no synthetic nodes)
2. `mediaSugar.expand(tree)` pushes identical synthetic @texture nodes (same name, same src)
3. `gpu._compileTextures()` may destroy old GPU texture and create placeholder
4. BUT: `mediaSugar.expand()` also calls `_mountResourceFiber(name, src, ...)`
5. Fiber already exists with same `_mediaSrc === src` → skip (no new fiber mounted)
6. Fiber's `rexUseResource` already has cached result for `[src]` deps → factory NOT re-invoked
7. On next `mediaSugar.tick()`, `_fiberHost.flush()` runs → fiber re-renders → `rexUseResource` returns cache
8. Cached bitmap used to immediately replace placeholder via `_replaceTexture()`
9. Net: one frame of placeholder, zero network requests. ∎

**Corollary**: Changing `:src` on a @media node correctly invalidates the cache — `rexUseResource` sees different deps, re-runs factory, fetches new resource.

---

## §9 — What This Enables

1. **Single address space.** Media paths ARE tree paths. `@bind 0 :texture bgImage` works because `bgImage` IS a @texture.

2. **ShrubLM learns everything.** Tool calls are @talk → displacements in slot-space. Media state is shrub slots. Cross-domain patterns emerge: "when audio BPM changes, user adjusts shader speed."

3. **Incremental compilation works.** Sugar-expanded nodes are stable across recompiles. Texture phase skipped when only shaders change.

4. **DeriveWorkerPool ready.** Heavy transcode passes (Phase B) dispatch to existing workers over SharedArrayBuffer.

5. **CommandRing ready.** Async loads tracked via io_uring-style completion queue.

6. **~650 lines total.** Two sugar modules instead of two full transducer classes (~2000+ lines).

---

## §10 — Phase Roadmap

### Phase A (this implementation)
- rex-agent.js: content type registration, @tool tree expansion, @delegate mutation, assemblePrompt, callLLM
- rex-media.js: @media expansion (image/video/audio/sample-bank), fiber resource lifecycle
- main.js: wire sugar expansion before transducers, tick in frame loop
- build.js: add both files to SRC_FILES
- rex-gpu.js: incremental diff awareness for sugar node types

### Phase B
- Heavy transcode: FFT, stems, BPM-detect via DeriveWorkerPool
- Audio transcode state in media shrubs → channels → GPU
- Multi-turn agent conversation (message history in shrub kids)
- Context budget management with token counting
- Tool kid collection bookkeeping (tools/[ta])

### Phase C
- GLTF loader → expand to @vertex-buffer + @index-buffer + @struct
- Splat/NeRF → expand to @buffer :usage [storage] + custom compute
- Agent template composition (@use base-agent → coding-agent)
- SDF font atlas via media namespace

---

## §11 — Relation to Existing Specs

| Spec | Relation |
|---|---|
| Rex-Agent-Spec.md | This implements §4 (@tool expansion), §6 (@delegate), §3 (prompt blocks), §11 (compilation model) as sugar rather than a transducer class |
| RexMedia-Spec.md | This implements §4–6 (asset types, namespace, class shape) as sugar+fiber. The namespace IS the tree + `_loadedResources` Map. Transcode passes deferred to Phase B. |
| ShrubLM-Spec.md | Unchanged. Agent tool calls and media state flow through existing shrub/talk/slot/dep mechanisms. ShrubLM observes them identically to any other behaviour. |
| PCNSpecAligned.md | Unchanged. Agent behaviour events reach PCN via existing `onTalkFired` bridge. |

---

## §12 — Open Questions

1. **Audio latency.** `audioCtx.decodeAudioData` is async and may be null until user interaction. Media sugar must handle this gracefully (retry when AudioContext becomes available).

2. **Prompt content with `''` at column 0.** The parser's ugly-string lexer requires closing `''` at column 0. If agent prompt text contains `''` on its own line, it terminates the content block early. Solution: document the constraint, or use an alternate delimiter for agent prompts.

3. **Fiber host heap size.** 64KB default for media fiber host. Sufficient for resource tracking metadata, but may need tuning for large asset counts.

4. **GPU texture replacement race.** Between `_compileTextures` destroying the old texture and the fiber replacing it, there's a 1-frame window where the placeholder is visible. For Phase B: consider a texture cache in `_compileTextures` that checks `mediaSugar._loadedResources` before creating a placeholder.

5. **Video element management.** HTMLVideoElements created by media sugar need explicit lifecycle management (pause, remove from DOM on unmount). The fiber cleanup function handles this, but edge cases around autoplay policy need testing.
