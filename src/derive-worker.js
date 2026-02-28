// ================================================================
// DERIVE WORKER — Evaluates pure expressions on SharedArrayBuffer heap
// Standalone file — no imports from concatenated bundle
// ================================================================

let heapView = null;

function evalExpr(node) {
  if (!node) return undefined;
  switch (node.op) {
    case 'lit': return node.value;
    case 'slot': return heapView ? heapView.getFloat32(node.offset, true) : 0;
    case 'call': return _applyStdlib(node.fn, node.args.map(evalExpr));
    default: return undefined;
  }
}

function _applyStdlib(fn, args) {
  switch (fn) {
    case 'add': return args.length > 2 ? args.reduce((a, b) => (+a||0) + (+b||0)) : (+args[0]||0) + (+args[1]||0);
    case 'sub': return (+args[0]||0) - (+args[1]||0);
    case 'mul': return args.length > 2 ? args.reduce((a, b) => (+a||0) * (+b||0)) : (+args[0]||0) * (+args[1]||0);
    case 'div': { const b = +args[1]; return b ? (+args[0]||0) / b : 0; }
    case 'mod': { const b = +args[1]; return b ? (+args[0]||0) % b : 0; }
    case 'eq': return args[0] === args[1] || String(args[0]) === String(args[1]);
    case 'neq': return args[0] !== args[1] && String(args[0]) !== String(args[1]);
    case 'gt': return +args[0] > +args[1];
    case 'lt': return +args[0] < +args[1];
    case 'gte': return +args[0] >= +args[1];
    case 'lte': return +args[0] <= +args[1];
    case 'and': return !!args[0] && !!args[1];
    case 'or': return !!args[0] || !!args[1];
    case 'not': return !args[0];
    case 'sin': return Math.sin(+args[0]);
    case 'cos': return Math.cos(+args[0]);
    case 'tan': return Math.tan(+args[0]);
    case 'asin': return Math.asin(+args[0]);
    case 'acos': return Math.acos(+args[0]);
    case 'atan': return Math.atan(+args[0]);
    case 'atan2': return Math.atan2(+args[0], +args[1]);
    case 'abs': return Math.abs(+args[0]||0);
    case 'sign': return Math.sign(+args[0]||0);
    case 'min': return Math.min(+args[0], +args[1]);
    case 'max': return Math.max(+args[0], +args[1]);
    case 'floor': return Math.floor(+args[0]||0);
    case 'ceil': return Math.ceil(+args[0]||0);
    case 'round': return Math.round(+args[0]||0);
    case 'sqrt': return Math.sqrt(+args[0]||0);
    case 'pow': return Math.pow(+args[0]||0, +args[1]||0);
    case 'log': return Math.log(+args[0]||0);
    case 'log2': return Math.log2(+args[0]||0);
    case 'exp': return Math.exp(+args[0]||0);
    case 'fract': { const v = +args[0]||0; return v - Math.floor(v); }
    case 'step': return (+args[1]||0) >= (+args[0]||0) ? 1 : 0;
    case 'smoothstep': { const e0=+args[0]||0, e1=+args[1]||1, x=+args[2]||0; const t=Math.max(0,Math.min(1,(x-e0)/(e1-e0||1))); return t*t*(3-2*t); }
    case 'clamp': return Math.min(Math.max(+args[0]||0, +args[1]||0), +args[2]||1);
    case 'lerp': case 'mix': { const t = +args[2]||0; return (+args[0]||0) * (1-t) + (+args[1]||0) * t; }
    case 'pi': return Math.PI;
    case 'tau': return Math.PI * 2;
    case 'band': return (+args[0]||0) & (+args[1]||0);
    case 'bor': return (+args[0]||0) | (+args[1]||0);
    case 'bxor': return (+args[0]||0) ^ (+args[1]||0);
    case 'bnot': return ~(+args[0]||0);
    case 'shl': return (+args[0]||0) << (+args[1]||0);
    case 'shr': return (+args[0]||0) >> (+args[1]||0);
    case 'if': return args[0] ? args[1] : args[2];
    case 'to-num': { const n = +args[0]; return Number.isFinite(n) ? n : +args[1]||0; }
    case 'has': return args[0] !== undefined && args[0] !== null;
    case 'or-else': return (args[0] !== undefined && args[0] !== null) ? args[0] : args[1];
    default: return undefined;
  }
}

function _resolveOffsets(node, offsets) {
  if (!node) return node;
  if (node.op === 'slot') {
    const off = offsets[node.path];
    return off !== undefined ? { op: 'slot', offset: off, path: node.path } : node;
  }
  if (node.op === 'call') {
    return { op: 'call', fn: node.fn, args: node.args.map(a => _resolveOffsets(a, offsets)) };
  }
  return node;
}

self.onmessage = (e) => {
  const { type } = e.data;
  if (type === 'init') {
    heapView = new DataView(e.data.heapBuffer);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (type === 'eval') {
    const { taskId, expr, inputOffsets, outputOffset } = e.data;
    try {
      const resolved = _resolveOffsets(expr, inputOffsets || {});
      const result = evalExpr(resolved);
      if (outputOffset !== undefined && result !== undefined) {
        heapView.setFloat32(outputOffset, Number(result) || 0, true);
      }
      self.postMessage({ taskId, value: result });
    } catch (err) {
      self.postMessage({ taskId, error: err.message });
    }
  }
};
