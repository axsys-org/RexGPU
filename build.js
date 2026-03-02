#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

// Source files in dependency order — .ts preferred, .js fallback
const SRC_FILES = [
  'rex-parser',
  'rex-gpu',
  'rex-surface',
  'rex-form',
  'rex-behaviour',
  'rex-pcn',
  'rex-audio',
  'rex-fiber',
  'plan-bridge',
  'tab-manager',
  'claude-api',
  'main',
];

// Standalone worklet files — copied verbatim to dist/ (loaded via addModule)
const WORKLET_FILES = [
  'synth-processor',
  'derive-worker',
];

function resolveFile(name) {
  const ts = path.join(SRC, name + '.ts');
  const js = path.join(SRC, name + '.js');
  if (fs.existsSync(ts)) return { path: ts, loader: 'ts' };
  if (fs.existsSync(js)) return { path: js, loader: 'js' };
  throw new Error(`Source file not found: ${name}.ts or ${name}.js`);
}

function build() {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  html = html.replace('/* __CSS__ */', css);

  // Embed examples from examples/ directory
  const EXAMPLES_DIR = path.join(__dirname, 'examples');
  const exampleEntries = [];
  if (fs.existsSync(EXAMPLES_DIR)) {
    for (const f of fs.readdirSync(EXAMPLES_DIR).sort()) {
      if (f.endsWith('.rex')) {
        const name = f.replace('.rex', '');
        const src = fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8');
        exampleEntries.push({ name, src });
      }
    }
  }
  const examplesJson = JSON.stringify(exampleEntries);
  html = html.replace('/* __EXAMPLES__ */', () => `window.__REX_EXAMPLES__ = ${examplesJson};`);

  const jsChunks = [];
  for (const name of SRC_FILES) {
    const file = resolveFile(name);
    let code = fs.readFileSync(file.path, 'utf8');

    // Strip TypeScript syntax via esbuild transform
    if (file.loader === 'ts') {
      const result = transformSync(code, { loader: 'ts', target: 'es2022' });
      code = result.code;
    }

    // Strip import/export for concatenation
    code = code.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/^export\s+(const|let|var|function|async\s+function|class)\s/gm, '$1 ');
    code = code.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
    code = code.replace(/^export\s+default\s+/gm, '');
    jsChunks.push(`// ── ${name} ──\n${code}`);
  }
  const js = jsChunks.join('\n\n');
  // Use replacer fn to avoid $' / $& / $` special replacement patterns in js string content
  html = html.replace('/* __JS__ */', () => js);

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, 'rexgpu.html');
  fs.writeFileSync(outPath, html);
  console.log(`Built ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);

  // Copy worklet files verbatim (AudioWorklet modules must be separate files)
  for (const name of WORKLET_FILES) {
    const src = path.join(SRC, name + '.js');
    const dst = path.join(DIST, name + '.js');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`Copied ${name}.js → dist/`);
    }
  }
}

if (process.argv.includes('--watch')) {
  build();
  console.log('Watching src/ for changes...');
  let debounce = null;
  fs.watch(SRC, { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { build(); } catch (e) { console.error('Build error:', e.message); }
    }, 100);
  });
} else {
  build();
}
