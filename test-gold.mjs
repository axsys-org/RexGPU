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
