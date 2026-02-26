# Rex-WASM Parser Specification

Compiling the canonical Rex parser to WebAssembly for use outside JavaScript: native apps, PLAN runtime, ShrineOS kernel, embedded systems, language servers.

## 1. Architecture Overview

The JS parser (`rex-parser.js`) has four stages. The WASM module mirrors them exactly:

```
Source bytes (UTF-8)
  → Lexer        → Token stream
  → Parser       → Canonical Rex AST (11 node types)
  → Shrub View   → Shrub projection (forward optic)
  → Printer      → Rex source (pretty-printed)
```

Plus the inverse:

```
Shrub
  → fromShrub    → Canonical Rex AST
  → Printer      → Rex source (backward optic / roundtrip)
```

The WASM module exports all five operations. The AST is serialized as a flat byte buffer using the encoding described in Part 3.

## 2. Source: Rust Implementation

The canonical Rust Rex implementation lives at `github.com/axsys-org/Rex`. The WASM module is compiled from this Rust crate with `wasm-pack` or `wasm-bindgen`.

The JS implementation in `rex-parser.js` is a faithful port. The WASM spec exists to define the **binary interface** between the Rust implementation and any host (JS, PLAN, native).

## 3. AST Binary Encoding

### 3.1 Node Tags

Each node is prefixed with a 1-byte tag:

| Tag | Name       | JS `._` | Payload |
|-----|------------|---------|---------|
| 0   | Word       | `Wd`    | len:u16, utf8[len] |
| 1   | Quip       | `Qp`    | len:u16, utf8[len] |
| 2   | Trad       | `Td`    | len:u16, utf8[len] |
| 3   | Slug       | `Sl`    | n_lines:u16, (len:u16, utf8[len]) × n_lines |
| 4   | Ugly       | `Ug`    | len:u32, utf8[len] |
| 5   | Heir       | `Hr`    | head:Node, tail:Node |
| 6   | TightPre   | `Tp`    | rune_len:u8, utf8[rune_len], child:Node |
| 7   | TightInf   | `Ti`    | rune_len:u8, utf8[rune_len], n_children:u16, Node × n_children |
| 8   | Block      | `Bk`    | n_children:u16, Node × n_children |
| 9   | NestPre    | `Np`    | bracket:u8, rune_len:u8, utf8[rune_len], n_children:u16, Node × n_children |
| 10  | NestInf    | `Ni`    | bracket:u8, rune_len:u8, utf8[rune_len], n_children:u16, Node × n_children |

### 3.2 Bracket Encoding

| Value | Bracket | JS `BK` |
|-------|---------|---------|
| 0     | Paren   | `P`     |
| 1     | Brack   | `B`     |
| 2     | Curly   | `C`     |
| 3     | Clear   | `X`     |

### 3.3 Token Stream Encoding (for incremental parsing)

Tokens are encoded for the lexer→parser boundary:

| Tag | Token | Payload |
|-----|-------|---------|
| 0   | End (E) | — |
| 1   | Whitespace (W) | count:u16 |
| 2   | Comment (C) | len:u16, utf8[len] |
| 3   | Ugly (U) | len:u32, utf8[len] |
| 4   | Slug (S) | len:u16, utf8[len] |
| 5   | Quip (Q) | len:u16, utf8[len] |
| 6   | Trad (T) | len:u16, utf8[len] |
| 7   | Open (O) | char:u8 |
| 8   | Close (K) | char:u8 |
| 9   | Word (w) | len:u16, utf8[len] |
| 10  | Rune (r) | len:u8, utf8[len] |

## 4. WASM Exports

### 4.1 Core Functions

```rust
/// Lex source into token buffer. Returns token count.
#[wasm_bindgen]
pub fn rex_lex(src: &[u8], tok_buf: &mut [u8]) -> u32;

/// Parse token buffer into AST buffer. Returns byte length of AST.
#[wasm_bindgen]
pub fn rex_parse(tok_buf: &[u8], n_tokens: u32, ast_buf: &mut [u8]) -> u32;

/// Full parse: source → AST buffer. Returns byte length.
#[wasm_bindgen]
pub fn rex_parse_src(src: &[u8], ast_buf: &mut [u8]) -> u32;

/// Print AST back to Rex source. Returns byte length.
#[wasm_bindgen]
pub fn rex_print(ast_buf: &[u8], out_buf: &mut [u8], max_width: u32) -> u32;
```

### 4.2 Shrub Projection

```rust
/// Project canonical AST → Shrub. Returns Shrub buffer byte length.
/// Shrub encoding: see Part 5.
#[wasm_bindgen]
pub fn rex_to_shrub(ast_buf: &[u8], shrub_buf: &mut [u8]) -> u32;

/// Inverse: Shrub → canonical AST. Returns AST buffer byte length.
#[wasm_bindgen]
pub fn rex_from_shrub(shrub_buf: &[u8], ast_buf: &mut [u8]) -> u32;

/// Full roundtrip: Shrub → Rex source string.
#[wasm_bindgen]
pub fn rex_print_shrub(shrub_buf: &[u8], out_buf: &mut [u8], max_width: u32) -> u32;
```

### 4.3 Template Expansion

```rust
/// Expand @template/@use in a Shrub tree. Modifies shrub_buf in-place.
/// Returns new byte length.
#[wasm_bindgen]
pub fn rex_expand_templates(shrub_buf: &mut [u8], shrub_len: u32) -> u32;
```

### 4.4 Utility

```rust
/// Allocate a buffer in WASM linear memory. Returns pointer.
#[wasm_bindgen]
pub fn rex_alloc(size: u32) -> *mut u8;

/// Free a buffer.
#[wasm_bindgen]
pub fn rex_free(ptr: *mut u8, size: u32);

/// Get error string from last operation. Returns byte length.
#[wasm_bindgen]
pub fn rex_last_error(out_buf: &mut [u8]) -> u32;
```

## 5. Shrub Binary Encoding

The Shrub projection produces a flat buffer encoding the `{type, name, attrs, children, content}` tree:

### 5.1 Shrub Node

```
ShrubNode:
  type_len:u16, utf8[type_len]       // "rect", "shader", etc.
  name_len:u16, utf8[name_len]       // 0 = no name
  n_attrs:u16                        // attribute count
  (AttrEntry × n_attrs)
  n_children:u16
  (ShrubNode × n_children)           // recursive
  content_len:u32, utf8[content_len] // 0 = no content
```

### 5.2 AttrEntry

```
AttrEntry:
  key_len:u16, utf8[key_len]
  val_type:u8
  val_payload (depends on val_type)
```

Value types:

| val_type | Meaning | Payload |
|----------|---------|---------|
| 0 | true (bare :key) | — |
| 1 | false | — |
| 2 | number (f64) | f64 |
| 3 | string | len:u16, utf8[len] |
| 4 | array | n:u16, (val_type + payload) × n |
| 5 | expression | len:u16, utf8[len] (the expr string) |

## 6. Rune Precedence Table

Compiled into the WASM module as a static lookup table. Identical to the JS `RUNE_ORDER`:

```
; , : # $ ` ~ @ ? \ | ^ & = ! < > + - * / % .
```

Loosest (`;`) to tightest (`.`). Rune comparison uses lexicographic ordering of precedence indices, matching the JS `cmpRunes` function exactly.

## 7. Lexer Specification

### 7.1 Character Classes

- **Word**: `[a-zA-Z0-9_]` (matches JS `/[\w]/`)
- **Rune**: any character in `RUNE_ORDER`
- **Whitespace**: space (U+0020). Tab is consumed and ignored. Newline is a token.
- **Quote**: `'` introduces Quip, Slug, Ugly, or Comment depending on context

### 7.2 Token Precedence (lexer disambiguation)

Scanned in this order (matching JS `lex()` exactly):

1. Newline → `E` token
2. Spaces → `W` token with count
3. Tab → skip
4. `'` followed by `)` `]` `}` → Comment `C` (rest of line)
5. `''` at line start → Ugly `U` (multiline, terminated by matching `''` count)
6. `'` followed by space → Slug `S` (rest of line, can chain across indented continuations)
7. `'` followed by non-delimiter → Quip `Q` (balanced brackets, stops at space/newline)
8. `"` → Trad `T` (double-quoted string, `""` for literal quote)
9. `(` `[` `{` → Open `O`
10. `)` `]` `}` → Close `K`
11. Word character → Word `w` (greedy)
12. Rune character → Rune `r` (greedy)
13. Anything else → skip

### 7.3 Ugly String Delimiters

Ugly strings use `''` (2+ single quotes) as delimiters. The closing delimiter must match the opening count. Content between delimiters is verbatim (no escape processing). The delimiter count is the minimum number of consecutive `'` in the content plus one, or at least 2.

## 8. Parser Specification

### 8.1 Grammar (informal)

```
top      → expr*
expr     → spaced block?
block    → INDENT (expr NEWLINE)* DEDENT
spaced   → clump*
clump    → citem+                   → tight grouping
citem    → word | quip | trad | slug | ugly | rune | '(' spaced ')'
```

### 8.2 Tight Grouping

When a clump has multiple items, they are grouped by **rune precedence** (lowest-precedence rune splits first):

1. **No runes**: `heir(items)` — left-to-right Heir chain
2. **Rune at position 0**: `TightPre(rune, collapse(rest))`
3. **Rune at end**: return items with trailing rune
4. **Rune in middle**: split on lowest-precedence rune → `TightInf(rune, groups)`

### 8.3 Nest Grouping

After tight grouping, spaced elements are grouped into Nest forms:

- First element is a rune → `NestPre(bracket, rune, children)`
- Contains runes → `NestInf(bracket, lowest_rune, groups)` via `ginf`
- No runes → `NestPre(bracket, '', children)`
- Single element with Clear bracket → unwrap

## 9. Shrub Projection Specification

### 9.1 Forward: Rex → Shrub (`toShrub`)

Dispatches on canonical node type:

- `TightPre('@', child)` → extract type from child, absorb rest as attrs/children
- `NestInf(':', Clear, [first, ...rest])` → if first is `@type`, decompose as `:key value` pairs
- `NestPre('', Clear, [@type, ...rest])` → extract type, absorb list
- Otherwise → `{type:'expr', name: printed}`

### 9.2 `_absorbList` — Key-Value Pairing

Walks a list of canonical nodes. For each `:key` (TightPre with `:`), looks ahead for a value node. The value is the next node if it's not another `:key`, `@type`, or Block. This is the critical innovation over the old parser — it handles spaced `:key value` correctly.

### 9.3 `_absorb` — Single Node Absorption

- `:key` → attribute
- Block → recurse children as Shrub nodes
- Ugly → content string
- Slug → content string (lines joined with `\n`)
- Word (if no name set) → name
- `@type` nested in NestPre → child Shrub node
- Otherwise → child expression

### 9.4 Backward: Shrub → Rex (`fromShrub`)

Reconstructs canonical Rex from Shrub focus:

- `@type` → `TightPre('@', Word(type))`
- Name → `Word(name)` in children list
- Attrs → `TightPre(':', NestPre(Clear, '', [Word(key), value_node]))` per entry
- Children → `Block([fromShrub(child), ...])`
- Content → `Ugly(content)` in block

### 9.5 Value Encoding

| Shrub value | Rex node |
|-------------|----------|
| `true` | bare `:key` (no value) |
| `false` | `Word("false")` |
| number | `Word(String(n))` |
| string (word-safe) | `Word(s)` |
| string (with spaces) | `Trad(s)` |
| array | `NestPre(Brack, '', [values...])` |
| expression `{expr}` | `NestPre(Paren, '', [parsed_expr])` |

## 10. Content-Type Preprocessing

Before parsing, the JS parser preprocesses certain `@type` blocks to auto-wrap bare content in `''` delimiters. The WASM module does the same.

Content types: `shader`, `wgsl`, `code`, `kernel`, `lib`, `text-editor`

Algorithm: when an `@content-type` line is followed by indented lines that don't start with `@`, `:`, `''`, or `' `, the content is automatically wrapped in `''` ugly string delimiters. This allows shader code to be written without explicit delimiters.

## 11. Memory Model

The WASM module uses its own linear memory. Buffers are allocated with `rex_alloc` and freed with `rex_free`. The host passes pointers and lengths.

For the JS bridge (`wasm-bindgen`), typed array views are used:
- Input: `Uint8Array` (source bytes)
- Output: `Uint8Array` (AST/Shrub/source bytes)

For the PLAN bridge, the WASM module operates on Pins (content-addressed blobs). The PLAN runtime maps Pin data into WASM linear memory before calling parse functions.

## 12. Incremental Parsing (Future)

The lexer→parser split enables incremental parsing: when source text changes, only re-lex the changed region, then re-parse from the affected token range. The WASM module exposes:

```rust
/// Incremental lex: re-lex a byte range, splice into existing token stream.
#[wasm_bindgen]
pub fn rex_lex_incremental(
  src: &[u8],
  edit_start: u32, edit_end: u32, new_len: u32,
  tok_buf: &mut [u8], tok_count: u32
) -> u32;
```

This is critical for the self-hosting editor: keystroke → incremental lex → re-parse → update Shrub → recompile surface. Sub-millisecond round-trip.

## 13. Error Recovery

The parser never panics. Malformed input produces `Word('?')` nodes and pushes error strings to an internal buffer readable via `rex_last_error`. This matches the JS parser's `errs` array.

Error types:
- Unterminated ugly string
- Mismatched brackets
- Unexpected close bracket
- Unterminated bracket

## 14. Compilation Targets

| Target | Toolchain | Output |
|--------|-----------|--------|
| Browser | `wasm-pack --target web` | `.wasm` + JS glue |
| Node.js | `wasm-pack --target nodejs` | `.wasm` + CJS glue |
| PLAN | `cargo build --target wasm32-wasi` | `.wasm` (WASI) |
| Native | `cargo build` | Static library |
| Embedded | `cargo build --target thumbv7em-none-eabihf` | No-std static lib |

The Rust crate uses `#![no_std]` with `alloc` for the core parser. The `std` feature adds file I/O and the WASI target. The `wasm-bindgen` feature adds the JS bridge.

## 15. Size Budget

Target: < 50KB gzipped for the WASM module (lex + parse + print + Shrub projection + roundtrip). The Rex grammar is small (23 runes, 3 bracket types, 11 node types) so the code is compact. No regex engine needed — all lexing is hand-rolled character scanning.
