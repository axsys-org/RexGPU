const { Rex } = require('./src/rex-parser.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  OK  ${name}`); }
  catch(e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

console.log('Parser integration tests:\n');

test('@struct with fields', () => {
  const t = Rex.parse('@struct Foo\n  @field x :type f32\n  @field y :type f32');
  const s = Rex.find(t, 'struct');
  eq(s.name, 'Foo');
  eq(s.children.length, 2);
  eq(s.children[0].name, 'x');
  eq(s.children[0].attrs.type, 'f32');
});

test('@pass with :target and :clear', () => {
  const t = Rex.parse('@pass main :target offscreen :clear [0 0 0 1]');
  const p = Rex.find(t, 'pass');
  eq(p.name, 'main');
  eq(p.attrs.target, 'offscreen');
  eq(Array.isArray(p.attrs.clear), true, 'clear should be array');
  eq(p.attrs.clear.length, 4);
});

test('@draw with :indirect', () => {
  const t = Rex.parse('@draw :pipeline mesh :indirect true :indirect-buffer args :indirect-offset 0');
  const d = Rex.find(t, 'draw');
  eq(d.attrs.pipeline, 'mesh');
  eq(d.attrs.indirect, true);
  eq(d.attrs['indirect-buffer'], 'args');
  eq(d.attrs['indirect-offset'], 0);
});

test('@shader with content block', () => {
  const t = Rex.parse('@shader test\n  @vertex fn vs_main() {}\n  @fragment fn fs_main() {}');
  const s = Rex.find(t, 'shader');
  eq(s.name, 'test');
  eq(typeof s.content, 'string', 'should have content');
  eq(s.content.includes('vs_main'), true, 'content should include shader code');
});

test('nested @form > @section > @field', () => {
  const t = Rex.parse('@form\n  @section cam\n    @field dist :type range :min 0 :max 10');
  const form = Rex.find(t, 'form');
  eq(form.children.length >= 1, true, 'form should have section child');
  const section = Rex.find(t, 'section');
  eq(section.name, 'cam');
  const field = Rex.find(t, 'field');
  eq(field.name, 'dist');
  eq(field.attrs.type, 'range');
  eq(field.attrs.min, 0);
  eq(field.attrs.max, 10);
});

test('@buffer with array :usage', () => {
  const t = Rex.parse('@buffer args :usage [storage indirect] :size 256');
  const b = Rex.find(t, 'buffer');
  eq(b.name, 'args');
  eq(Array.isArray(b.attrs.usage), true, 'usage should be array');
  eq(b.attrs.usage.includes('storage'), true);
  eq(b.attrs.usage.includes('indirect'), true);
  eq(b.attrs.size, 256);
});

test('expression with rune precedence', () => {
  const t = Rex.parse('@field x :default (add 1 (mul 2 3))');
  const f = Rex.find(t, 'field');
  eq(f.name, 'x');
  const def = f.attrs.default;
  eq(typeof def, 'object', 'default should be expr object');
  eq(typeof def.expr, 'string', 'should have expr string');
  eq(def.expr.includes('add'), true);
});

test('@derive with :shrub and :slot attrs', () => {
  const t = Rex.parse('@derive :shrub todo :slot count');
  const d = Rex.find(t, 'derive');
  eq(d.attrs.shrub, 'todo');
  eq(d.attrs.slot, 'count');
});

test('@talk with @input children', () => {
  const t = Rex.parse('@talk :shrub store :name sell\n  @input sku :type string\n  @input amount :type number');
  const talk = Rex.find(t, 'talk');
  eq(talk.attrs.shrub, 'store');
  eq(talk.attrs.name, 'sell');
  const inputs = Rex.findAll(t, 'input');
  eq(inputs.length, 2);
});

test('@texture with :src and :filter', () => {
  const t = Rex.parse('@texture albedo :src assets/stone.png :filter linear :wrap repeat');
  const tex = Rex.find(t, 'texture');
  eq(tex.name, 'albedo');
  eq(tex.attrs.src, 'assets/stone.png');
  eq(tex.attrs.filter, 'linear');
});

test('@resources with children', () => {
  const t = Rex.parse('@resources scene\n  @buffer uniforms :struct SceneUniforms\n  @buffer particles :usage [storage] :size 1000000');
  const res = Rex.find(t, 'resources');
  eq(res.name, 'scene');
  eq(res.children.length, 2);
});

test('@channel with :from and :to paths', () => {
  const t = Rex.parse('@channel bridge :from /counter/count :to /buf/count :mode on-change');
  const ch = Rex.find(t, 'channel');
  eq(ch.name, 'bridge');
  eq(ch.attrs.mode, 'on-change');
});

test('printShrub roundtrip', () => {
  const src = '@struct S\n  @field x :type f32';
  const tree = Rex.parse(src);
  const printed = Rex.printShrub(tree);
  // Re-parse the printed output
  const reparsed = Rex.parse(printed);
  const s1 = Rex.find(tree, 'struct');
  const s2 = Rex.find(reparsed, 'struct');
  eq(s1.name, s2.name, 'struct name should roundtrip');
});

test('template expansion', () => {
  const src = '@template box\n  @param size :default 100\n  @rect :w $size :h $size\n\n@use box :size 200';
  const tree = Rex.parse(src);
  const expanded = Rex.expandTemplates(tree);
  const rect = Rex.find(expanded, 'rect');
  eq(rect !== null, true, 'should have rect after expansion');
  eq(rect.attrs.w, 200);
});

test('negative number in attrs', () => {
  const t = Rex.parse('@field x :min -10 :max 10');
  const f = Rex.find(t, 'field');
  eq(f.attrs.min, -10);
  eq(f.attrs.max, 10);
});

test('boolean attrs', () => {
  const t = Rex.parse('@pipeline p :depth true :blend alpha');
  const p = Rex.find(t, 'pipeline');
  eq(p.attrs.depth, true);
  eq(p.attrs.blend, 'alpha');
});

test('multiple top-level nodes', () => {
  const t = Rex.parse('@struct A\n  @field x :type f32\n\n@struct B\n  @field y :type u32');
  const structs = Rex.findAll(t, 'struct');
  eq(structs.length, 2);
  eq(structs[0].name, 'A');
  eq(structs[1].name, 'B');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
