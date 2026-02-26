# Rex WASM Parser Specification v1

**Compile the canonical Rust Rex parser to WebAssembly for use in the browser rexgpu projection engine — achieving full notation alignment across all platforms.**

---

## Why

The rexgpu JS parser (`src/rex-parser.js`) is a simplified subset of canonical Rex. It handles `@type name :key value` with expressions and content blocks, but it misses: the 11 node types, rune precedence (23 operators from `;` to `.`), tight/nest/block parsing levels, Slug/Ugly text nodes, Heir adjacency, and the pretty-printer. This means `.rex` files don't parse identically across the Rust and JS implementations.

The Rust parser at `github.com/axsys-org/Rex` IS the spec. Compiling it to WASM gives rexgpu the canonical parser for free.

---

## Architecture

```
Rex source (string)
    ↓
[WASM] Rex Rust parser (compiled via wasm-pack)
    ↓
Rex AST (11 node types, JSON-serialized across WASM boundary)
    ↓
[JS] Shrub adapter (maps Rex AST → transducer-friendly shape)
    ↓
Transducers (GPU, Form, Behaviour, etc.)
```

The JS parser stays as a fallback for environments where WASM doesn't load.

---

## Part 1: Rust Modifications

### Dependencies to Add

```toml
# Cargo.toml additions
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"

[lib]
crate-type = ["cdylib", "rlib"]  # cdylib for WASM, rlib for native
```

### Serde Derives

Add to `ast.rs`:

```rust
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Rex {
    Word(String),
    Quip(String),
    Trad(String),
    Slug(Vec<String>),
    Ugly(String),
    Heir(Box<Rex>, Box<Rex>),
    TightPre(String, Box<Rex>),
    TightInf(String, Vec<Rex>),
    NestPre(Bracket, String, Vec<Rex>),
    NestInf(Bracket, String, Vec<Rex>),
    Block(Vec<Rex>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Bracket {
    Paren,
    Brack,
    Curly,
    Clear,
}
```

Add to `error.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseErrorInfo {
    pub start: usize,
    pub end: usize,
    pub message: String,
}
```

### WASM Bindings

New file: `src/wasm.rs`

```rust
use wasm_bindgen::prelude::*;
use crate::{parse, print, print_width, print_many};

#[wasm_bindgen]
pub fn rex_parse(src: &str) -> String {
    let (nodes, errors) = parse(src);
    let result = serde_json::json!({
        "nodes": nodes,
        "errors": errors.iter().map(|e| match e {
            RexError::LexError(span, msg) => serde_json::json!({
                "type": "lex", "start": span.start, "end": span.end, "message": msg
            }),
            RexError::ParseError(span, msg) => serde_json::json!({
                "type": "parse", "start": span.start, "end": span.end, "message": msg
            }),
        }).collect::<Vec<_>>()
    });
    serde_json::to_string(&result).unwrap()
}

#[wasm_bindgen]
pub fn rex_print(ast_json: &str) -> String {
    let node: Rex = serde_json::from_str(ast_json).unwrap_or(Rex::Word("error".into()));
    print(&node)
}

#[wasm_bindgen]
pub fn rex_print_width(ast_json: &str, max_width: usize) -> String {
    let node: Rex = serde_json::from_str(ast_json).unwrap_or(Rex::Word("error".into()));
    print_width(&node, max_width)
}

#[wasm_bindgen]
pub fn rex_print_many(ast_json: &str) -> String {
    let nodes: Vec<Rex> = serde_json::from_str(ast_json).unwrap_or_default();
    print_many(&nodes)
}
```

### Ariadne Gating

Ariadne is a CLI error reporting library — it won't compile to WASM. Gate it:

```toml
[features]
default = ["cli-errors"]
cli-errors = ["ariadne"]

[dependencies]
ariadne = { version = "0.6", optional = true }
```

In `error.rs`, gate the reporting functions:

```rust
#[cfg(feature = "cli-errors")]
pub fn report_lex_errors(...) { ... }

#[cfg(feature = "cli-errors")]
pub fn report_parse_errors(...) { ... }
```

WASM builds exclude `cli-errors`. Error info is serialized as JSON instead.

### Build

```bash
wasm-pack build --target web --no-default-features
# Produces: pkg/rex_bg.wasm + pkg/rex.js (ES module bindings)
```

Expected output size: ~80-120KB WASM (~30-50KB gzipped). The parser is string-processing only — no heavy dependencies.

---

## Part 2: JS Integration

### Loading the WASM Module

```javascript
// rex-wasm.js — WASM parser loader
let wasmParser = null;

export async function initRexWASM() {
    try {
        const wasm = await import('./pkg/rex.js');
        await wasm.default();  // Initialize WASM module
        wasmParser = wasm;
        return true;
    } catch (e) {
        console.warn('Rex WASM parser not available, falling back to JS parser');
        return false;
    }
}

export function parseRex(src) {
    if (wasmParser) {
        const resultJson = wasmParser.rex_parse(src);
        return JSON.parse(resultJson);
    }
    // Fallback to JS parser
    return { nodes: jsFallbackParse(src), errors: [] };
}

export function printRex(node) {
    if (wasmParser) {
        return wasmParser.rex_print(JSON.stringify(node));
    }
    return jsFallbackPrint(node);
}
```

### The Shrub Adapter

Transducers expect `{type, name, attrs, children, content}`. The Rex AST gives 11 node types. The adapter maps between them:

```javascript
// shrub-adapter.js — Rex AST → Shrub interface
export function rexToShrubs(rexNodes) {
    return rexNodes.map(rexToShrub).filter(Boolean);
}

function rexToShrub(node) {
    // Block with @ prefix = Shrub node
    // NestPre(Clear, "", [...]) at top level = implicit application
    // TightPre("@", Word("type")) = @type node declaration

    switch (node.type || Object.keys(node)[0]) {
        case 'TightPre': {
            const [rune, child] = [node.TightPre[0], node.TightPre[1]];
            if (rune === '@') {
                return parseShrubDeclaration(child);
            }
            return { type: 'expr', rune, child: rexToShrub(child) };
        }
        case 'NestPre': {
            const [bracket, rune, children] = [
                node.NestPre[0], node.NestPre[1], node.NestPre[2]
            ];
            if (rune === '' && bracket === 'Paren') {
                // Expression: (fn arg1 arg2)
                return { type: 'expr', value: node };
            }
            if (rune === '@') {
                // @type in prefix position
                return parseShrubFromNestPre(children);
            }
            return { type: 'expr', value: node };
        }
        case 'Block': {
            // Indented children — process each
            return { type: 'block', children: node.Block.map(rexToShrub).filter(Boolean) };
        }
        case 'Word':
            return { type: 'literal', value: node.Word };
        case 'Trad':
            return { type: 'string', value: node.Trad };
        case 'Slug':
            return { type: 'text', lines: node.Slug };
        case 'Ugly':
            return { type: 'content', text: node.Ugly };
        // ... other node types
    }
}

function parseShrubDeclaration(child) {
    // @type name :key value structure
    // The child after @ is either:
    //   Word("type") — just the type name
    //   NestPre/NestInf containing type, name, attrs
    //   Heir(Word("type"), Block([...])) — type with indented children

    if (child.Word) {
        return { type: child.Word, name: null, attrs: {}, children: [], content: null };
    }
    if (child.Heir) {
        const [head, tail] = [child.Heir[0], child.Heir[1]];
        // head = type (possibly with name)
        // tail = block of children or inline content
        const shrub = parseShrubHead(head);
        shrub.children = parseChildren(tail);
        return shrub;
    }
    // NestInf with : rune = attributes
    // TightInf with . rune = path
    return parseComplex(child);
}
```

The adapter is ~100-150 lines. It handles the mapping from Rex's 11 structural node types to the flat `{type, name, attrs, children}` interface that GPU/Form/Behaviour transducers expect.

### Alternatively: Native Rex AST in Transducers

Instead of adapting, update transducers to consume Rex AST directly. The GPU transducer would pattern-match:

```javascript
// In rex-gpu.js _compileCommands:
case 'TightPre': {
    const [rune, child] = node;
    if (rune === '@') {
        const typeName = extractTypeName(child);
        switch (typeName) {
            case 'pass': return this._compilePass(child);
            case 'draw': return this._compileDraw(child);
            // ...
        }
    }
}
```

This is more work but eliminates the adapter layer permanently. The transducers work with Rex as it is.

**Recommendation:** Start with the adapter (Phase 1). Migrate transducers to native Rex AST later (Phase 2). The adapter lets you ship WASM parsing immediately without rewriting transducers.

---

## Part 3: Build Integration

### In rexgpu's build.js

```javascript
// build.js additions
const wasmPkg = './rex-wasm/pkg';

// Copy WASM files into dist alongside rexgpu.html
// OR inline the WASM as base64 in the HTML bundle (for single-file deployment)
function inlineWasm(htmlContent) {
    const wasmBytes = fs.readFileSync(`${wasmPkg}/rex_bg.wasm`);
    const wasmB64 = wasmBytes.toString('base64');
    const wasmLoader = `
        const wasmB64 = "${wasmB64}";
        const wasmBytes = Uint8Array.from(atob(wasmB64), c => c.charCodeAt(0));
        const wasmModule = await WebAssembly.compile(wasmBytes);
    `;
    return htmlContent.replace('/* WASM_LOADER */', wasmLoader);
}
```

For single-file deployment (current rexgpu model), inline the WASM as base64. ~30-50KB gzipped overhead.

### Repo Structure

```
rexgpu/
  src/
    rex-gpu.js
    rex-parser.js        ← JS fallback (kept)
    rex-wasm.js          ← WASM loader + adapter
    shrub-adapter.js     ← Rex AST → Shrub mapping
    main.js
  rex-wasm/              ← Git submodule of axsys-org/Rex
    src/
      lib.rs
      ast.rs
      wasm.rs            ← New: WASM bindings
    Cargo.toml           ← Modified: add serde, wasm-bindgen
    pkg/                 ← wasm-pack output
  build.js
  dist/
    rexgpu.html
```

---

## Part 4: Testing

### Roundtrip Tests

Parse Rex source in WASM, convert to Shrubs via adapter, verify against JS parser output:

```javascript
function testRoundtrip(src) {
    const wasmResult = parseRex(src);           // WASM path
    const jsResult = Rex.parse(src);            // JS fallback
    const wasmShrubs = rexToShrubs(wasmResult.nodes);
    // Compare shrub trees
    assert.deepEqual(wasmShrubs, jsResult);
}
```

### Notation Tests

Every example in the RPE spec, Behaviour spec, and PLAN Bridge spec should parse identically through both paths:

```javascript
const RPE_EXAMPLES = [
    '@struct SceneUniforms\n  @field time :type f32',
    '@pass main :clear [0 0 0 1]\n  @draw :pipeline p :vertices 3',
    '@texture albedo :src shrine://textures/stone :filter linear',
    '@draw :pipeline mesh :indirect true :indirect-buffer args',
];

const BEHAVIOUR_EXAMPLES = [
    '@shrub todo\n  @slot title :type string :default "My Todos"',
    '@derive :shrub todo :slot count\n  (fold %kids/tasks 0 (add $acc 1))',
    '@talk :shrub store :name sell\n  @input sku :type string',
];
```

### Error Reporting

WASM parser errors should display in the rexgpu log panel with source location:

```javascript
if (result.errors.length > 0) {
    for (const err of result.errors) {
        log(`Rex ${err.type} error at ${err.start}-${err.end}: ${err.message}`, 'err');
    }
}
```

---

## Part 5: Phases

### Phase 1: WASM Parser + Adapter (~1 week)
- Add serde derives to Rust parser
- Add wasm-bindgen bindings
- Gate ariadne behind feature flag
- Build with wasm-pack
- Write shrub adapter in JS
- Integrate into rexgpu build
- JS fallback for non-WASM environments

### Phase 2: Native Rex AST in Transducers (~2 weeks)
- Update GPU transducer to pattern-match Rex AST directly
- Update Form transducer
- Update Behaviour transducer (when built)
- Remove adapter layer
- Full rune precedence in expressions

### Phase 3: Native Target (ShrineOS)
- Same Rust parser, compiled natively (no WASM)
- Direct FFI from Swift/C++ host (enzyme-mac scaffolding)
- Same AST, same transducer interface

---

## Design Principles

```
THE RUST PARSER IS THE SPEC.      No reimplementation. Compile it.
WASM IS THE BRIDGE.               Rust → WASM for browser. Rust native for ShrineOS.
THE ADAPTER IS TEMPORARY.          Phase 1 maps AST → Shrubs. Phase 2 uses AST directly.
JS IS THE FALLBACK.                Keep rex-parser.js for environments without WASM.
SINGLE-FILE DEPLOYMENT.            Inline WASM as base64 in rexgpu.html.
SAME PARSE, EVERYWHERE.            .rex files parse identically in Rust, WASM, and JS.
```
