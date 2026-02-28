#!/usr/bin/env node
// Gold test runner: parse each .rex, print output, compare to gold
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';

const parserSrc = readFileSync('/Users/sicrul/Projects/rexgpu/src/rex-parser.js', 'utf8');
const tmpFile = join(tmpdir(), 'rex-parser-test.mjs');
writeFileSync(tmpFile, parserSrc);
const { Rex } = await import(pathToFileURL(tmpFile).href + '?t=' + Date.now());

const EX_DIR = '/Volumes/C/Downloads/Research/PLAN/neorex/ex/';
const GOLD_DIR = '/Volumes/C/Downloads/Research/PLAN/neorex/gold/';

const tests = [
  'simple', 'trad', 'expo', 'bloc', 'node', 'quip',
  'slug', 'ifix', 'itrail', 'nest', 'qfmt', 'strip', 'twrap'
];

let pass = 0, fail = 0;
const failures = [];

for (const name of tests) {
  const input = readFileSync(EX_DIR + name + '.rex', 'utf8');
  const gold = readFileSync(GOLD_DIR + name + '.rex', 'utf8');

  let output;
  try {
    const { nodes } = Rex.parseCanonical(input);
    // Use prNodes which handles null entries (empty blocks) correctly
    output = Rex.printNodes(nodes);
  } catch (e) {
    output = `ERROR: ${e.message}\n${e.stack}\n`;
  }

  if (output === gold) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}`);
    fail++;
    failures.push({ name, output, gold });
  }
}

console.log(`\n${pass}/${pass+fail} passed`);

// Show first 5 failures in detail
for (const f of failures.slice(0, 5)) {
  console.log(`\n=== ${f.name} ===`);
  const outLines = f.output.split('\n');
  const goldLines = f.gold.split('\n');
  const maxLines = Math.max(outLines.length, goldLines.length);
  for (let i = 0; i < maxLines && i < 40; i++) {
    const o = outLines[i] ?? '<missing>';
    const g = goldLines[i] ?? '<missing>';
    if (o !== g) {
      console.log(`  line ${i+1}:`);
      console.log(`    got:  ${JSON.stringify(o)}`);
      console.log(`    want: ${JSON.stringify(g)}`);
    }
  }
}

// ── compileExprToWGSL transpiler tests ──────────────────────────
console.log('\n── compileExprToWGSL tests ──');
let tPass = 0, tFail = 0;
function tok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); tPass++; }
  else { console.log(`  FAIL  ${label}`); tFail++; }
}

// Literal number
{
  const r = Rex.compileExprToWGSL({ op: 'lit', value: 3.14 });
  tok(r.viable && r.wgsl === '3.14', 'lit: number');
}

// Literal integer gets .0 suffix
{
  const r = Rex.compileExprToWGSL({ op: 'lit', value: 42 });
  tok(r.viable && r.wgsl === '42.0', 'lit: integer → f32');
}

// Literal boolean
{
  const r = Rex.compileExprToWGSL({ op: 'lit', value: true });
  tok(r.viable && r.wgsl === '1.0', 'lit: true → 1.0');
}

// Literal string → not viable
{
  const r = Rex.compileExprToWGSL({ op: 'lit', value: 'hello' });
  tok(!r.viable, 'lit: string → not viable');
}

// Binary add
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'add',
    args: [{ op: 'lit', value: 1 }, { op: 'lit', value: 2 }]
  });
  tok(r.viable && r.wgsl === '(1.0 + 2.0)', 'call: add');
}

// sin(x)
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'sin',
    args: [{ op: 'lit', value: 0.5 }]
  });
  tok(r.viable && r.wgsl === 'sin(0.5)', 'call: sin');
}

// smoothstep
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'smoothstep',
    args: [{ op: 'lit', value: 0 }, { op: 'lit', value: 1 }, { op: 'lit', value: 0.5 }]
  });
  tok(r.viable && r.wgsl === 'smoothstep(0.0, 1.0, 0.5)', 'call: smoothstep');
}

// lerp → mix
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'lerp',
    args: [{ op: 'lit', value: 0 }, { op: 'lit', value: 10 }, { op: 'lit', value: 0.5 }]
  });
  tok(r.viable && r.wgsl === 'mix(0.0, 10.0, 0.5)', 'call: lerp → mix');
}

// if → select
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'if',
    args: [{ op: 'lit', value: 1 }, { op: 'lit', value: 10 }, { op: 'lit', value: 20 }]
  });
  tok(r.viable && r.wgsl === 'select(20.0, 10.0, 1.0 != 0.0)', 'call: if → select');
}

// Nested: clamp(sin(x), 0, 1)
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'clamp',
    args: [
      { op: 'call', fn: 'sin', args: [{ op: 'lit', value: 3.14 }] },
      { op: 'lit', value: 0 },
      { op: 'lit', value: 1 }
    ]
  });
  tok(r.viable && r.wgsl === 'clamp(sin(3.14), 0.0, 1.0)', 'call: nested clamp(sin())');
}

// Unknown function → not viable
{
  const r = Rex.compileExprToWGSL({
    op: 'call', fn: 'str-concat',
    args: [{ op: 'lit', value: 'a' }, { op: 'lit', value: 'b' }]
  });
  tok(!r.viable, 'call: unknown fn → not viable');
}

// Slot with resolver
{
  const r = Rex.compileExprToWGSL(
    { op: 'slot', path: 'health' },
    (kind, name) => kind === 'slot' ? `params.${name}` : null
  );
  tok(r.viable && r.wgsl === 'params.health', 'slot: resolved via callback');
}

// Slot without resolver → not viable
{
  const r = Rex.compileExprToWGSL({ op: 'slot', path: 'health' });
  tok(!r.viable, 'slot: no resolver → not viable');
}

// pi constant
{
  const r = Rex.compileExprToWGSL({ op: 'call', fn: 'pi', args: [] });
  tok(r.viable && r.wgsl === '3.14159265358979', 'call: pi constant');
}

// Null node
{
  const r = Rex.compileExprToWGSL(null);
  tok(!r.viable, 'null → not viable');
}

console.log(`\n${tPass}/${tPass + tFail} transpiler tests passed`);

// ── GPU Compiler Spec v1.1 unit tests ─────────────────────────
console.log('\n── GPU Compiler Spec v1.1 tests ──');
const gpuSrc = readFileSync('/Users/sicrul/Projects/rexgpu/src/rex-gpu.js', 'utf8');
const gpuTmpFile = join(tmpdir(), 'rex-gpu-test.mjs');
writeFileSync(gpuTmpFile, gpuSrc);
const { RexGPU } = await import(pathToFileURL(gpuTmpFile).href + '?t=' + Date.now());
let gPass = 0, gFail = 0;
function gok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); gPass++; }
  else { console.log(`  FAIL  ${label}`); gFail++; }
}

// Helper: create a minimal RexGPU instance (no device needed)
function makeGPU() { return new RexGPU(null, () => {}); }

// ── Feature 7: _typeAlign ──
{
  const gpu = makeGPU();
  gok(gpu._typeAlign('f32') === 4, 'typeAlign: f32 = 4');
  gok(gpu._typeAlign('i32') === 4, 'typeAlign: i32 = 4');
  gok(gpu._typeAlign('u32') === 4, 'typeAlign: u32 = 4');
  gok(gpu._typeAlign('f32x2') === 8, 'typeAlign: f32x2 = 8');
  gok(gpu._typeAlign('f32x3') === 16, 'typeAlign: f32x3 = 16 (vec3 = 16)');
  gok(gpu._typeAlign('f32x4') === 16, 'typeAlign: f32x4 = 16');
  gok(gpu._typeAlign('f32x4x4') === 16, 'typeAlign: f32x4x4 = 16');
  gok(gpu._typeAlign('CustomStruct') === 16, 'typeAlign: unknown → 16 (struct default)');
}

// ── Feature 2: _deserializeStruct ──
{
  const gpu = makeGPU();
  const buf = new ArrayBuffer(32);
  const dv = new DataView(buf);
  dv.setFloat32(0, 3.14, true);
  dv.setUint32(4, 42, true);
  dv.setInt32(8, -7, true);
  const layout = [
    { name: 'val', type: 'f32', offset: 0, size: 4 },
    { name: 'count', type: 'u32', offset: 4, size: 4 },
    { name: 'signed', type: 'i32', offset: 8, size: 4 },
  ];
  const obj = gpu._deserializeStruct(dv, 0, layout);
  gok(Math.abs(obj.val - 3.14) < 0.001, 'deserialize: f32 field');
  gok(obj.count === 42, 'deserialize: u32 field');
  gok(obj.signed === -7, 'deserialize: i32 field');
}

// ── Feature 2: _deserializeStruct with vec types ──
{
  const gpu = makeGPU();
  const buf = new ArrayBuffer(32);
  const dv = new DataView(buf);
  dv.setFloat32(0, 1.0, true);
  dv.setFloat32(4, 2.0, true);
  dv.setFloat32(8, 3.0, true);
  const layout = [
    { name: 'pos', type: 'f32x3', offset: 0, size: 12 },
  ];
  const obj = gpu._deserializeStruct(dv, 0, layout);
  gok(Array.isArray(obj.pos) && obj.pos.length === 3, 'deserialize: f32x3 → array[3]');
  gok(obj.pos[0] === 1.0 && obj.pos[1] === 2.0 && obj.pos[2] === 3.0, 'deserialize: f32x3 values');
}

// ── Feature 2: _resolveOpticPath ──
{
  const gpu = makeGPU();
  gpu._heapLayout.set('world', {
    offset: 0, size: 32,
    structDef: {
      layout: [
        { name: 'pos', type: 'f32x3', offset: 0, size: 12 },
        { name: 'scale', type: 'f32', offset: 16, size: 4 },
      ],
    },
  });
  const r1 = gpu._resolveOpticPath('/world/pos');
  gok(r1 !== null && r1.type === 'f32x3' && r1.offset === 0 && r1.size === 12, 'resolvePath: /world/pos → f32x3 @0');
  const r2 = gpu._resolveOpticPath('/world/scale');
  gok(r2 !== null && r2.type === 'f32' && r2.offset === 16, 'resolvePath: /world/scale → f32 @16');
  const r3 = gpu._resolveOpticPath('/world');
  gok(r3 !== null && r3.structLayout !== null && r3.structLayout.length === 2, 'resolvePath: /world → full struct');
  const r4 = gpu._resolveOpticPath('/nonexist/foo');
  gok(r4 === null, 'resolvePath: invalid buffer → null');
  const r5 = gpu._resolveOpticPath('/world/nonexist');
  gok(r5 === null, 'resolvePath: invalid field → null');
}

// ── Feature 3: _classifyFilterParam ──
{
  const gpu = makeGPU();
  // sepia has params: { intensity: 1.0 }
  gok(gpu._classifyFilterParam('sepia', 'intensity', 1.0, { intensity: 1.0 }) === 'const',
    'classifyParam: literal matching default → const');
  gok(gpu._classifyFilterParam('sepia', 'intensity', 0.5, { intensity: 0.5 }) === 'override',
    'classifyParam: literal differing → override');
  gok(gpu._classifyFilterParam('sepia', 'intensity', null, { intensity: { expr: 'elapsed' } }) === 'uniform',
    'classifyParam: expression → uniform');
  gok(gpu._classifyFilterParam('grayscale', 'custom', 1.0, { custom: 1.0 }) === 'override',
    'classifyParam: unknown builtin param → override');
}

// ── Feature 4: _buildFusionBatches ──
{
  const gpu = makeGPU();
  const tree = { type: 'root', children: [
    { type: 'texture', name: 'canvas', attrs: { width: 512, height: 512 }, children: [] },
  ] };
  const filters = [
    { name: 'grayscale', attrs: { src: 'canvas' }, children: [] },
    { name: 'sepia', attrs: { src: 'canvas' }, children: [] },
    { name: 'invert', attrs: { src: 'canvas' }, children: [] },
  ];
  const batches = gpu._buildFusionBatches(filters, tree);
  gok(batches.length === 1, 'fusion: 3 pixel-local filters → 1 batch');
  gok(batches[0].filters.length === 3, 'fusion: batch contains all 3 filters');
  gok(batches[0].fusible === true, 'fusion: batch is fusible');
}

// ── Feature 4: fusion broken by needsNeighbors ──
{
  const gpu = makeGPU();
  const tree = { type: 'root', children: [
    { type: 'texture', name: 'canvas', attrs: { width: 512, height: 512 }, children: [] },
  ] };
  const filters = [
    { name: 'grayscale', attrs: { src: 'canvas' }, children: [] },
    { name: 'blur', attrs: { src: 'canvas' }, children: [] },  // blur needsNeighbors
    { name: 'invert', attrs: { src: 'canvas' }, children: [] },
  ];
  const batches = gpu._buildFusionBatches(filters, tree);
  gok(batches.length >= 2, 'fusion: blur breaks batch (needsNeighbors)');
}

// ── Feature 4: fusion broken by :out ──
{
  const gpu = makeGPU();
  const tree = { type: 'root', children: [
    { type: 'texture', name: 'canvas', attrs: { width: 512, height: 512 }, children: [] },
  ] };
  const filters = [
    { name: 'grayscale', attrs: { src: 'canvas', out: 'intermediate' }, children: [] },
    { name: 'invert', attrs: { src: 'canvas' }, children: [] },
  ];
  const batches = gpu._buildFusionBatches(filters, tree);
  gok(batches.length === 2, 'fusion: :out breaks batch');
}

// ── Feature 6: _diffShrub ──
{
  const gpu = makeGPU();
  // No change
  const a = { type: 'rect', name: 'box', attrs: { width: 100 }, children: [], content: null };
  const b = { type: 'rect', name: 'box', attrs: { width: 100 }, children: [], content: null };
  gok(gpu._diffShrub(a, b).length === 0, 'diffShrub: identical → no changes');

  // Attrs change
  const c = { type: 'rect', name: 'box', attrs: { width: 200 }, children: [], content: null };
  const d1 = gpu._diffShrub(a, c);
  gok(d1.length === 1 && d1[0].changeKind === 'attrs-only', 'diffShrub: attrs-only change');

  // Content change
  const e = { type: 'shader', name: 'vs', attrs: {}, children: [], content: 'old' };
  const f = { type: 'shader', name: 'vs', attrs: {}, children: [], content: 'new' };
  const d2 = gpu._diffShrub(e, f);
  gok(d2.length === 1 && d2[0].changeKind === 'modified', 'diffShrub: content change → modified');

  // Added child
  const g = { type: 'root', name: 'r', attrs: {}, children: [], content: null };
  const h = { type: 'root', name: 'r', attrs: {}, children: [
    { type: 'shader', name: 'x', attrs: {}, children: [], content: null }
  ], content: null };
  const d3 = gpu._diffShrub(g, h);
  gok(d3.length === 1 && d3[0].changeKind === 'added', 'diffShrub: added child');

  // Type change
  const i = { type: 'rect', name: 'a', attrs: {}, children: [], content: null };
  const j = { type: 'circle', name: 'a', attrs: {}, children: [], content: null };
  const d4 = gpu._diffShrub(i, j);
  gok(d4.length === 1 && d4[0].changeKind === 'modified', 'diffShrub: type change → modified');

  // Null handling
  gok(gpu._diffShrub(null, a).length === 1, 'diffShrub: null prev → added');
  gok(gpu._diffShrub(a, null).length === 1, 'diffShrub: null next → removed');
  gok(gpu._diffShrub(null, null).length === 0, 'diffShrub: both null → no changes');
}

// ── Feature 6: _mapChangesToPhases ──
{
  const gpu = makeGPU();
  const p1 = gpu._mapChangesToPhases([{ type: 'struct', changeKind: 'modified' }]);
  gok(p1.has(1) && p1.has(2) && p1.has(9) && p1.has(12), 'phases: struct change → phases 1,2,3,4,5,9,12');

  const p2 = gpu._mapChangesToPhases([{ type: 'shader', changeKind: 'modified' }]);
  gok(p2.has(2) && p2.has(9) && !p2.has(1) && !p2.has(12), 'phases: shader change → phases 2,9 only');

  const p3 = gpu._mapChangesToPhases([{ type: 'pipeline', changeKind: 'attrs-only' }]);
  gok(p3.has(9) && p3.size === 1, 'phases: pipeline attrs → phase 9 only');

  const p4 = gpu._mapChangesToPhases([{ type: 'filter', changeKind: 'attrs-only' }]);
  gok(p4.has(1.5) && p4.size === 1, 'phases: filter attrs-only → phase 1.5 (hot patchable)');

  const p5 = gpu._mapChangesToPhases([{ type: 'heap', changeKind: 'modified' }]);
  gok(p5.has(1.1) && p5.has(3) && p5.has(4) && p5.has(5), 'phases: heap change → phases 1.1,3,4,5');
}

// ── Feature 6: _canIncrementalCompile ──
{
  const gpu = makeGPU();
  gok(gpu._canIncrementalCompile(new Set([2, 9])) === true, 'canIncremental: shader+pipeline → true');
  gok(gpu._canIncrementalCompile(new Set([1, 2])) === false, 'canIncremental: struct change → false');
  gok(gpu._canIncrementalCompile(new Set([3])) === false, 'canIncremental: heap layout → false');
  gok(gpu._canIncrementalCompile(new Set([5])) === false, 'canIncremental: allocate heap → false');
}

// ── Feature 6: _detectOpticStability ──
{
  const gpu = makeGPU();
  gok(gpu._detectOpticStability() === false, 'opticStability: no prev → false');
  gpu._heapLayout.set('a', { offset: 0, size: 16 });
  gpu._prevHeapLayout = new Map([['a', { offset: 0, size: 16 }]]);
  gok(gpu._detectOpticStability() === true, 'opticStability: same layout → true');
  gpu._heapLayout.set('a', { offset: 0, size: 32 });
  gok(gpu._detectOpticStability() === false, 'opticStability: size change → false');
}

// ── Feature 7: _heapNodeToStruct ──
{
  const gpu = makeGPU();
  const node = { name: 'world', attrs: {}, children: [
    { name: 'x', attrs: { type: 'f32' }, children: [] },
    { name: 'y', attrs: { type: 'f32' }, children: [] },
    { name: 'z', attrs: { type: 'f32' }, children: [] },
  ] };
  const r = gpu._heapNodeToStruct(node, 'world');
  gok(r.structName === 'World', 'heapNodeToStruct: name capitalized');
  gok(r.layout.length === 3, 'heapNodeToStruct: 3 fields');
  gok(r.layout[0].name === 'x' && r.layout[0].offset === 0, 'heapNodeToStruct: x @0');
  gok(r.layout[1].name === 'y' && r.layout[1].offset === 4, 'heapNodeToStruct: y @4');
  gok(r.layout[2].name === 'z' && r.layout[2].offset === 8, 'heapNodeToStruct: z @8');
  gok(r.size === 16, 'heapNodeToStruct: padded to 16 bytes');
  gok(r.wgsl.includes('struct World'), 'heapNodeToStruct: WGSL has struct name');
}

// ── Feature 7: _heapNodeToStruct with nested struct ──
{
  const gpu = makeGPU();
  const node = { name: 'player', attrs: {}, children: [
    { name: 'health', attrs: { type: 'f32' }, children: [] },
    { name: 'pos', attrs: {}, children: [
      { name: 'x', attrs: { type: 'f32' }, children: [] },
      { name: 'y', attrs: { type: 'f32' }, children: [] },
    ] },
  ] };
  const r = gpu._heapNodeToStruct(node, 'player');
  gok(r.structName === 'Player', 'heapNested: top struct name');
  gok(r.layout.length === 2, 'heapNested: 2 top-level fields (health + pos)');
  gok(r.nestedStructs.has('Player_pos'), 'heapNested: nested struct registered');
  const nested = r.nestedStructs.get('Player_pos');
  gok(nested.layout.length === 2, 'heapNested: nested has 2 fields');
  // health @0 (4B), then pos needs 16-byte align → @16
  gok(r.layout[1].name === 'pos' && r.layout[1].offset === 16, 'heapNested: pos nested struct @16 (aligned)');
}

// ── Feature 7: _typeAlign correctness for vec3 ──
{
  const gpu = makeGPU();
  // vec3 in WGSL: size=12, alignment=16
  const node = { name: 'data', attrs: {}, children: [
    { name: 'normal', attrs: { type: 'f32x3' }, children: [] },
    { name: 'flag', attrs: { type: 'f32' }, children: [] },
  ] };
  const r = gpu._heapNodeToStruct(node, 'data');
  gok(r.layout[0].offset === 0 && r.layout[0].size === 12, 'vec3 layout: normal @0 size=12');
  // f32 after vec3(12B): needs 4-byte align, offset 12 already aligned to 4
  gok(r.layout[1].offset === 16, 'vec3 layout: flag @16 (after vec3 align)');
}

// ── Feature 1: _enforceBarriers validation ──
{
  const gpu = makeGPU();
  gpu._barrierSchedule = [
    { afterIndex: 0, beforeIndex: 1, reason: 'RAW on uniforms/pos', opticPaths: ['uniforms/pos'] },
  ];
  gpu._commandList = [
    { type: 'dispatch', pipelineKey: 'a' },
    { type: 'dispatch', pipelineKey: 'b' },
  ];
  gpu._enforceBarriers();
  gok(gpu._barrierViolations === 0, 'enforceBarriers: valid order → 0 violations');
}

// ── Feature 5: _eliminateDeadOptics ──
{
  const gpu = makeGPU();
  gpu._optics = [
    { bufferName: 'uniforms', fieldName: 'pos', source: 'data' },
    { bufferName: 'uniforms', fieldName: 'unused', source: 'data' },
    { bufferName: 'uniforms', fieldName: 'time', source: 'builtin' },
    { bufferName: 'uniforms', fieldName: 'slider', source: 'form' },
  ];
  const liveness = new Map([
    ['uniforms/pos', { firstRead: 0, lastRead: 2 }],
    // uniforms/unused NOT in liveness → dead
    ['uniforms/time', { firstRead: 0, lastRead: 5 }],
    ['uniforms/slider', { firstRead: 1, lastRead: 3 }],
  ]);
  const eliminated = gpu._eliminateDeadOptics(liveness);
  gok(eliminated === 1, 'eliminateDeadOptics: 1 dead optic removed');
  gok(gpu._optics.length === 3, 'eliminateDeadOptics: 3 optics remain');
  gok(gpu._optics.every(o => o.fieldName !== 'unused'), 'eliminateDeadOptics: "unused" removed');
  // form and builtin always survive even without liveness
  gok(gpu._optics.some(o => o.source === 'builtin'), 'eliminateDeadOptics: builtin preserved');
  gok(gpu._optics.some(o => o.source === 'form'), 'eliminateDeadOptics: form preserved');
}

console.log(`\n${gPass}/${gPass + gFail} GPU spec tests passed`);
if (tFail > 0 || gFail > 0) process.exit(1);
