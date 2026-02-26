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
  'plan-bridge',
  'tab-manager',
  'claude-api',
  'main',
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
  html = html.replace('/* __JS__ */', js);

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, 'rexgpu.html');
  fs.writeFileSync(outPath, html);
  console.log(`Built ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
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
