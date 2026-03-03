// ═══════════════════════════════════════════════════════════════════
// REX AGENT SUGAR
// Compile-time tree expansion: @agent → @shrub, @tool → @talk
// Prompt assembly, tool schemas, LLM streaming, delegate mutations
// Follows the @filter sugar pattern (rex-gpu.js:885)
// ═══════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';

// ── Module-scope content type registration ─────────────────────────
// Must run before any Rex.parse() call. Enables '' content blocks
// on @system, @task, @few-shot, @context nodes — same preprocessing
// path as @shader and @filter (rex-parser.js:2091 _contentTypes).
Rex.registerContentType('system');
Rex.registerContentType('task');
Rex.registerContentType('few-shot');
Rex.registerContentType('context');

// ── §1 expandAgentSugar ────────────────────────────────────────────
// Tree mutation at compile time. Called after Rex.expandTemplates(),
// before form/behaviour/gpu transducers see the tree.
// Returns extracted prompts + tool schemas for downstream consumption.

export function expandAgentSugar(tree, log) {
  const _log = log || (() => {});
  const prompts = new Map();       // "agentName/type" → content string
  const toolSchemas = new Map();   // "toolName" → JSON Schema object
  const agents = new Map();        // "agentName" → { slots, tools, deps }

  let agentCount = 0;
  let toolCount = 0;

  // ── Step 1: @agent → @shrub rewrite (in-place) ──────────────────
  const agentNodes = Rex.findAll(tree, 'agent');
  for (const node of agentNodes) {
    if (!node.name) { _log('agent: @agent node missing name', 'warn'); continue; }
    const agentName = node.name;
    node.type = 'shrub';
    node.name = 'agent/' + agentName;

    // Record agent config
    agents.set(agentName, {
      shrubName: node.name,
      tools: [],
      deps: node.children.filter(c => c.type === 'dep').map(c => c.name),
    });
    agentCount++;
  }

  // ── Step 2: @tool → synthetic @talk ──────────────────────────────
  const toolNodes = Rex.findAll(tree, 'tool');
  for (const toolNode of toolNodes) {
    const expanded = _expandTool(toolNode, tree);
    if (expanded) {
      // Build JSON Schema for Anthropic API
      const schema = buildToolSchema(toolNode);
      toolSchemas.set(toolNode.name, schema);

      // Link tool to its agent
      const agentName = (toolNode.attrs.shrub || '').replace(/^agent\//, '');
      const agent = agents.get(agentName);
      if (agent) agent.tools.push(toolNode.name);
      toolCount++;
    }
  }

  // ── Step 3: Extract prompt content ───────────────────────────────
  // The parser's content-type preprocessor has already captured
  // .content on these nodes via Rex.registerContentType() above.
  for (const type of ['system', 'task', 'few-shot', 'context']) {
    for (const node of Rex.findAll(tree, type)) {
      const agentRef = node.name || node.attrs.shrub || '';
      const key = `${agentRef}/${type}`;
      if (node.content) {
        prompts.set(key, node.content);
      }
      // Also collect from children with content (e.g. @example blocks)
      if (type === 'few-shot') {
        const examples = [];
        for (const child of node.children) {
          if (child.type === 'example') {
            const inp = child.children.find(c => c.type === 'input');
            const out = child.children.find(c => c.type === 'output');
            examples.push({
              input: inp?.content || inp?.name || '',
              output: out?.content || out?.name || '',
            });
          }
        }
        if (examples.length) {
          let fewShotText = '';
          for (const ex of examples) {
            fewShotText += `<example>\n<input>\n${ex.input}\n</input>\n<output>\n${ex.output}\n</output>\n</example>\n\n`;
          }
          const existing = prompts.get(key) || '';
          prompts.set(key, existing + fewShotText);
        }
      }
    }
  }

  // ── Step 4: Extract @context/@source children for context DAG ────
  for (const ctxNode of Rex.findAll(tree, 'context')) {
    const agentRef = ctxNode.name || ctxNode.attrs.shrub || '';
    const sources = [];
    for (const child of ctxNode.children) {
      if (child.type === 'source') {
        sources.push({
          name: child.name,
          refresh: child.attrs.refresh || 'on-start',
          budget: +(child.attrs.budget || 1000),
          window: child.attrs.window ? +child.attrs.window : null,
          strategy: child.attrs.strategy || 'recency',
          tool: child.attrs.tool || null,
          description: child.content || '',
        });
      }
    }
    if (sources.length) {
      agents.forEach((a, name) => {
        if (agentRef.includes(name)) a.contextSources = sources;
      });
    }
  }

  if (agentCount || toolCount) {
    _log(`agent: ${agentCount} agents, ${toolCount} tools expanded`, 'ok');
  }

  return { prompts, toolSchemas, agents };
}

// ── §2 _expandTool ─────────────────────────────────────────────────
// Pushes a synthetic @talk node for each @tool. The behaviour
// transducer's _compileTalk (rex-behaviour.js:221) consumes it
// identically to a hand-written @talk.

function _expandTool(toolNode, tree) {
  const toolName = toolNode.name;
  const shrubName = toolNode.attrs.shrub;
  const cost = +(toolNode.attrs.cost || 1);
  if (!toolName || !shrubName) return null;

  const talkName = `use-${toolName}`;

  // Extract children by type
  const inputs = toolNode.children.filter(c => c.type === 'input');
  const outputs = toolNode.children.filter(c => c.type === 'output');
  const guardNode = toolNode.children.find(c => c.type === 'guard');

  // Build the synthetic @talk children
  const talkChildren = [];

  // Guard (if present — carried from @tool)
  if (guardNode) {
    talkChildren.push(guardNode);
  }

  // Input declarations (carried from @tool)
  // behaviour._compileTalk handles type:'input' at line 232-239
  for (const inp of inputs) {
    talkChildren.push(inp);
  }

  // Cost deduction mutation: @set /tool-budget = (sub /tool-budget COST)
  talkChildren.push({
    type: 'set',
    name: '/tool-budget',
    attrs: {
      _expr: {
        op: 'call', fn: 'sub', args: [
          { op: 'slot', path: '/tool-budget' },
          { op: 'lit', value: cost },
        ],
      },
    },
    children: [], content: null, _d: 2,
  });

  // Turn count increment: @set /turn-count = (add /turn-count 1)
  talkChildren.push({
    type: 'set',
    name: '/turn-count',
    attrs: {
      _expr: {
        op: 'call', fn: 'add', args: [
          { op: 'slot', path: '/turn-count' },
          { op: 'lit', value: 1 },
        ],
      },
    },
    children: [], content: null, _d: 2,
  });

  // Build the synthetic @talk node
  // _d:1 marker follows the filter expansion convention (rex-gpu.js:1030)
  const syntheticTalk = {
    type: 'talk',
    name: null,
    attrs: { shrub: shrubName, name: talkName },
    children: talkChildren,
    content: null,
    _d: 1,
  };

  tree.children.push(syntheticTalk);

  // Store backward optic info from @output :to declarations
  const backwardOptics = [];
  for (const out of outputs) {
    if (out.attrs.to) {
      backwardOptics.push({
        field: out.name,
        type: out.attrs.type || 'string',
        toSlot: out.attrs.to,
      });
    }
  }

  return { talkName, toolName, inputs, outputs, cost, backwardOptics };
}

// ── §3 buildToolSchema ─────────────────────────────────────────────
// Generates JSON Schema for the Anthropic API tools[] array.
// Always additionalProperties:false, all fields required,
// strict:true (opt-out via :strict false).

export function buildToolSchema(toolNode) {
  const name = toolNode.name;
  const description = (toolNode.content || '').trim();
  const strict = toolNode.attrs.strict !== 'false' && toolNode.attrs.strict !== false;
  const inputs = toolNode.children.filter(c => c.type === 'input');

  const properties = {};
  const required = [];

  for (const inp of inputs) {
    const fieldName = inp.name;
    if (!fieldName) continue;
    const rexType = inp.attrs.type || 'string';
    const prop = _rexTypeToJsonSchema(rexType, inp.attrs);
    if (inp.attrs.description) prop.description = inp.attrs.description;
    if (inp.content) prop.description = inp.content.trim();
    properties[fieldName] = prop;
    required.push(fieldName);
  }

  const schema = {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };

  if (!strict) schema.strict = false;
  return schema;
}

function _rexTypeToJsonSchema(rexType, attrs) {
  const schema = {};
  switch (rexType) {
    case 'string':  schema.type = 'string'; break;
    case 'number':  schema.type = 'number'; break;
    case 'boolean': schema.type = 'boolean'; break;
    case 'array':
      schema.type = 'array';
      if (attrs.items) schema.items = _rexTypeToJsonSchema(attrs.items, {});
      if (attrs['min-items'] !== undefined) schema.minItems = +attrs['min-items'];
      if (attrs['max-items'] !== undefined) schema.maxItems = +attrs['max-items'];
      break;
    case 'object':  schema.type = 'object'; break;
    default:        schema.type = 'string';
  }
  if (attrs.enum) {
    schema.enum = Array.isArray(attrs.enum) ? attrs.enum
      : typeof attrs.enum === 'string' ? attrs.enum.split(/\s+/) : [attrs.enum];
  }
  if (attrs.min !== undefined) schema.minimum = +attrs.min;
  if (attrs.max !== undefined) schema.maximum = +attrs.max;
  if (attrs.format) schema.format = attrs.format;
  if (attrs.nullable) {
    const base = { ...schema };
    return { anyOf: [base, { type: 'null' }] };
  }
  return schema;
}

// ── §4 assemblePrompt ──────────────────────────────────────────────
// $param substitution with longest-first key sort.
// Assembly order: system → context → few-shot → task.

export function assemblePrompt(agentName, prompts, slotValues, taskParams) {
  // Merge slot values and task params for $param substitution
  const vars = new Map();
  if (slotValues) {
    if (slotValues instanceof Map) {
      for (const [k, v] of slotValues) vars.set(k, v);
    } else {
      for (const [k, v] of Object.entries(slotValues)) vars.set(k, v);
    }
  }
  if (taskParams) {
    for (const [k, v] of Object.entries(taskParams)) vars.set(k, v);
  }

  // Sort keys longest-first for replacement (prevent partial matches)
  const sortedKeys = [...vars.keys()].sort((a, b) => b.length - a.length);

  function substitute(text) {
    if (!text) return '';
    let result = text;
    for (const key of sortedKeys) {
      result = result.replaceAll('$' + key, String(vars.get(key) ?? ''));
    }
    return result;
  }

  // Assembly order: system → context → few-shot → task
  const systemContent = substitute(prompts.get(`${agentName}/system`) || '');
  const contextContent = substitute(prompts.get(`${agentName}/context`) || '');
  const fewShotContent = substitute(prompts.get(`${agentName}/few-shot`) || '');
  const taskContent = substitute(prompts.get(`${agentName}/task`) || '');

  const system = [systemContent, contextContent, fewShotContent]
    .filter(Boolean).join('\n\n');
  const task = taskContent;

  return { system, task };
}

// ── §5 callLLM ─────────────────────────────────────────────────────
// SSE streaming to Anthropic API. Extends claude-api.js pattern.
// Parses tool_use content blocks from streaming response.
// Accepts config.signal (AbortController) for fiber cancellation.

export async function callLLM(config, onToken) {
  const key = config.apiKey
    || (typeof document !== 'undefined' && document.getElementById('api-key')?.value?.trim())
    || '';

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (key) {
    headers['x-api-key'] = key;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const body = {
    model: config.model || 'claude-opus-4-6',
    max_tokens: config.maxTokens || 4096,
    stream: true,
  };
  if (config.system) body.system = config.system;
  if (config.messages) {
    body.messages = config.messages;
  } else if (config.task) {
    body.messages = [{ role: 'user', content: config.task }];
  }
  if (config.tools?.length) body.tools = config.tools;
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (config.topP !== undefined) body.top_p = config.topP;
  if (config.responseSchema) {
    body.output_config = {
      format: { type: 'json_schema', schema: config.responseSchema },
    };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: config.signal,
  });

  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      msg += ': ' + (j.error?.message || JSON.stringify(j));
    } catch {}
    throw new Error(msg);
  }

  // SSE streaming — parse text_delta and tool_use blocks
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';
  const toolCalls = [];
  let currentToolUse = null;
  let currentToolInput = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const ev = JSON.parse(data);
        switch (ev.type) {
          case 'content_block_start':
            if (ev.content_block?.type === 'tool_use') {
              currentToolUse = {
                id: ev.content_block.id,
                name: ev.content_block.name,
                input: {},
              };
              currentToolInput = '';
            }
            break;

          case 'content_block_delta':
            if (ev.delta?.type === 'text_delta') {
              full += ev.delta.text;
              if (onToken) onToken(full);
            } else if (ev.delta?.type === 'input_json_delta') {
              currentToolInput += ev.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (currentToolUse) {
              try { currentToolUse.input = JSON.parse(currentToolInput); }
              catch { currentToolUse.input = {}; }
              toolCalls.push(currentToolUse);
              currentToolUse = null;
              currentToolInput = '';
            }
            break;

          case 'message_delta':
            if (ev.usage) usage = ev.usage;
            break;
        }
      } catch {}
    }
  }

  return { text: full, toolCalls, usage };
}

// ── §6 registerDelegate ────────────────────────────────────────────
// v1 compatibility: register 'delegate' as a mutation type so
// @delegate children inside @talk are handled at runtime via the
// mutation handler dispatch at rex-behaviour.js:1134-1136.

export function registerDelegate(behaviour) {
  behaviour.registerMutationType('delegate', (node, ctx, beh) => {
    const target = node.attrs.target
      || (node.name && node.name.startsWith('%')
        ? _resolveDepRef(node.name, ctx, beh)
        : node.name);
    const talk = node.attrs.talk;
    const onComplete = node.attrs['on-complete'];
    const onFail = node.attrs['on-fail'];
    const timeout = +(node.attrs.timeout || 30000);

    if (!target || !talk) {
      console.warn('rex-agent: @delegate missing target or :talk');
      return;
    }

    // Build inputs from :input attrs
    const inputs = {};
    for (const child of node.children) {
      if (child.type === 'input' || child.type === 'slot') {
        const name = child.name;
        const val = child.attrs._expr
          ? beh._evalExpr(child.attrs._expr, ctx)
          : child.attrs.default || child.name;
        inputs[name] = val;
      }
    }
    // Also check direct attrs for :input key value pairs
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k === 'target' || k === 'talk' || k === 'on-complete'
          || k === 'on-fail' || k === 'timeout' || k === 'parallel') continue;
      if (k === 'input') {
        // :input key value — parse as key/value pair
        const parts = String(v).split(/\s+/);
        if (parts.length >= 2) {
          const inputKey = parts[0];
          const inputVal = parts.slice(1).join(' ');
          inputs[inputKey] = inputVal.startsWith('/')
            ? beh.getSlotValue(ctx.shrub, inputVal.slice(1))
            : inputVal;
        }
      }
    }

    // Fire the target agent's talk
    const targetShrub = target.startsWith('agent/') ? target : `agent/${target}`;
    const success = beh.fireTalk(targetShrub, talk, inputs);

    // v1 compat: synchronous completion callbacks
    // (v2 uses fiber spawn for async delegation)
    if (success && onComplete) {
      setTimeout(() => beh.fireTalk(ctx.shrub, onComplete, {}), 0);
    } else if (!success && onFail) {
      setTimeout(() => beh.fireTalk(ctx.shrub, onFail, { error: 'delegation-failed' }), 0);
    }
  });
}

function _resolveDepRef(ref, ctx, beh) {
  // %depLabel → resolve to actual shrub name via dep path
  const label = ref.slice(1);
  const shrub = beh._shrubs.get(ctx.shrub);
  if (!shrub) return null;
  const dep = shrub.deps?.find(d => d.label === label);
  return dep?.path || null;
}
