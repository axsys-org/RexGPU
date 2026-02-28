# Rex Parser/Printer — Clean Port Specification

Golden standard: `PLAN/neorex/rex.c` (2000 lines, C)
Validation: `PLAN/neorex/gold/*.rex` (13 test pairs)
Secondary ref: `PLAN/neorex/printer/src/Lib.hs` + `LowLib.hs` (Haskell)

This spec describes a faithful JavaScript port of the neorex canonical
Rex parser and printer. Every stage maps 1:1 to the C reference.

---

## 1. Data Model

### 1.1 Token Types

```
BAD   — malformed token (mismatched bracket, poisoned string)
EOL   — newline
EOB   — end-of-block sentinel (injected by bsplit)
EOF   — end of file
SEMI  — comment (; to end of line)
WYTE  — whitespace run (spaces only)
BEGIN — ( [ {
END   — ) ] }
RUNE  — operator sequence from rune charset
WORD  — alphanumeric/underscore identifier
TRAD  — "double-quoted" string
QUIP  — 'tick-prefixed expression
UGLY  — ''multi-line block string''
SLUG  — ' text line (continuation by column alignment)
```

Every token carries: `{ ty, buf, sz, col }` where `col` is the
0-based column of the first character.

### 1.2 Rex Node Types

```
REX_WORD         — word leaf: "foo", "x42"
REX_TRAD         — trad string leaf: content between ""
REX_QUIP         — quip leaf: content after '
REX_UGLY         — ugly string leaf: content between ''..''
REX_SLUG         — slug leaf: content lines after '
REX_HEIR         — juxtaposition: (head, tail)
CLEAR_PREFIX     — layout prefix: rune sons... (no brackets)
CLEAR_INFIX      — layout infix: a rune b rune c (no brackets)
PAREN_PREFIX     — (rune sons...)
PAREN_INFIX      — (a rune b rune c)
CURLY_PREFIX     — {rune sons...}
CURLY_INFIX      — {a rune b rune c}
BRACK_PREFIX     — [rune sons...]
BRACK_INFIX      — [a rune b rune c]
TIGHT_PREFIX     — +word (rune immediately before leaf, no space)
TIGHT_INFIX      — a+b+c (rune between leaves, no spaces)
REX_BAD          — malformed node
```

Rex node structure:
```
{ type, txt, txtSize, numSons, sons[], fmt: { wide, unwrap } }
```

- `txt`: rune text for PREFIX/INFIX nodes, content for leaves
- `sons[]`: child Rex nodes (0 for leaves, 1 for PREFIX, 2 for HEIR, N for INFIX)

---

## 2. Pipeline Architecture

```
source text
    │
    ▼
┌─────────┐
│  lex()  │  char-by-char DFA → Token stream
└────┬────┘
     ▼
┌──────────────┐
│  nestjoin()  │  bracket matching; mismatched END → BAD
└──────┬───────┘
       ▼
┌────────────┐
│  bsplit()  │  inject EOB sentinels at block boundaries
└─────┬──────┘
      ▼
┌──────────────┐
│  quipjoin()  │  coalesce multi-token quip runs
└──────┬───────┘
       ▼
┌───────────┐
│  parse()  │  dual-stack machine → Rex tree
└─────┬─────┘
      ▼
┌───────────┐
│  frex()   │  bottom-up: compute wide + unwrap
└─────┬─────┘
      ▼
┌───────────┐
│  prex()   │  top-down: column-tracked output
└───────────┘
```

Each stage is a **filter** that transforms the token stream before
passing it to the next stage. This is critical — our current parser
does everything in one pass, which is why it gets quips, blocks,
and layout wrong. The port MUST implement all 5 stages.

---

## 3. Lexer (lex)

### 3.1 Character Classes

```
isword(c)  = /[A-Za-z0-9_]/
isrune(c)  = c ∈ { , : # $ ` ~ @ ? \ | ^ & = ! < > + - * / % . }
             NOTE: 22 chars. Semicolon is NOT a rune.
```

### 3.2 Rune Precedence

```
Loosest                                      Tightest
  ,  :  #  $  `  ~  @  ?  \  |  ^  &  =  !  <  >  +  -  *  /  %  .
  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
```

Multi-char runes pack as base-24 numbers (each char → its index,
padded with 23). Comparison is numeric on the packed value.

### 3.3 Lexer States

```
BASE    — dispatch on first character
WYTE    — accumulate spaces (count them for WYTE token)
RUNE    — accumulate rune chars
WORD    — accumulate word chars
NOTE    — skip to EOL (comment, started by ;)
TRAD    — "string" content; "" = escaped quote; ends at unescaped "
TICK    — seen '; dispatch:
            ' ' or '\n'  → SLUG
            ''            → UGLY_START
            else          → QUIP (accumulate until space/newline/close)
UGLY_S  — count opening ' chars (≥2); next must be \n
UGLY    — body lines until closing delimiter (same width) at col
SLUG_T  — accumulate slug text to EOL
SLUG_L  — look for continuation: next line at same col starting with '
```

### 3.4 Key Lexer Rules

**TRAD strings**: `"content"` — `""` inside is an escaped quote.
Content between the outer quotes is stored verbatim (no unescaping).
Multi-line trads are valid; content must not dedent past opening col.

**QUIP**: `'content` — everything after `'` until whitespace/EOL or
closing bracket (when depth reaches 0). Brackets inside quips track
depth: `'(foo)` has depth 1→0, content is `(foo)`. Mismatched brackets
inside quips become BAD tokens via nestjoin.

**SLUG**: `' text` (tick space text) — continuation lines must start
at the same column with `'`. Empty line = `'` alone. Multi-line slug
is a single token.

**UGLY**: `''delimiter\n body \ndelimiter''` — delimiter is 2+ tick
chars. Body is stripped of leading whitespace up to the opening col.
Closing delimiter must be at exact col. Content that dedents = poison.

**Poison**: Any string token (TRAD/QUIP/UGLY/SLUG) whose content
dedents past its opening column becomes BAD.

---

## 4. Nestjoin

Purpose: match BEGIN/END brackets; turn mismatched END tokens into BAD.

Algorithm:
```
stack = []
for each token:
  if BEGIN: push bracket type
  if END:
    if stack not empty AND top matches: pop
    else: token.ty = BAD    ← CRITICAL for quipjoin
  pass token downstream
```

This is the stage our current parser is missing. Without it, `'(])`
can't parse correctly — the `]` would break the quip, but with
nestjoin it becomes BAD and quipjoin consumes it as quip content.

---

## 5. Block Splitter (bsplit)

Purpose: inject EOB tokens to separate top-level blocks.

State machine:
```
OUTSIDE      — not inside a block
LEADING_RUNE — saw a rune at start of block (rune-led layout)
SINGLE_LN    — inside a single-line block (one leaf)
BLK          — inside a multi-line block
```

Transitions:
- OUTSIDE → see content token → enter SINGLE_LN or LEADING_RUNE
- SINGLE_LN → see EOL → emit EOB, go OUTSIDE
- LEADING_RUNE → see 2nd EOL → emit EOB, go OUTSIDE
- BLK → see dedented content → emit EOB, go OUTSIDE
- Any state → BEGIN increments nest depth (disable splitting inside nests)
- Any state → END decrements nest depth

Key: blocks are separated by blank lines (double EOL) or significant
dedentation. Inside brackets, block splitting is suspended.

---

## 6. Quip Joiner (quipjoin)

Purpose: coalesce multi-token quip sequences into single QUIP tokens.

When a QUIP token is seen, enter quip-joining mode. Continue consuming
tokens until:
- Depth reaches 0 AND next token is not quip-adjacent
- An EOL at the origin column is seen

Consumed tokens append their text to the quip buffer. BAD tokens
are consumed as content (this is why nestjoin must run first —
mismatched brackets become BAD, which quipjoin treats as text).

Depth tracking:
- BEGIN: depth++
- END: depth-- (if depth > 0)
- BAD: no depth change (it's just content)

Poison check: if any consumed content has col < origin_col (for
non-whitespace), the entire quip becomes BAD.

---

## 7. Parser (parse)

### 7.1 Stack Model

Two stacks:
```
ctx_stk — context stack: { type, pos, data }
  CTX_NEST   — inside brackets; stores bracket char and element list
  CTX_CLUMP  — collecting tight adjacent tokens; stores element list
  CTX_LAYOUT — indentation block; stores rune, position, element list

elm_stk — element stack (within current context): { CLEM_RUNE | CLEM_REX }
  CLEM_RUNE  — a rune string (operator)
  CLEM_REX   — a Rex node
```

### 7.2 Core Operations

**layout(col)**: Close all CTX_LAYOUT contexts whose position > col.
When closing a layout context, finalize its elements into a Rex node
(CLEAR_PREFIX: rune + sons).

**open_clump(col)**: First call `layout(col)`. Then, if not already
inside a CTX_CLUMP, push one.

**close_clump()**: Pop CTX_CLUMP, build Rex via `clump_rex()`, add
result to parent context.

**open_nest(col, bracket_char)**: Call `open_clump(col)`, then push
CTX_NEST with the bracket char.

**close_nest(col, bracket_char)**: Close any open clumps. Pop
CTX_NEST (verify bracket match). Build Rex via `nest_rex()`. Add
result to parent context.

**add_rex_to_clump(col, rex)**: If last element in current clump is
also a Rex, merge them as REX_HEIR. Otherwise push new CLEM_REX.

**push_clumped_rune(col, rune_text)**: The rune is tight (next token
is adjacent). Push CLEM_RUNE to current clump.

**push_free_rune(col, rune_text)**: The rune is free (followed by
whitespace/EOL). Close any open clump. Create CTX_LAYOUT at position
`col - 1 + len(rune)`. The rune becomes the first element.

### 7.3 Rune Classification (Clumped vs Free)

After lexing a RUNE token, defer the decision until the NEXT token:

```
next token is BEGIN, WORD, TRAD, QUIP, UGLY, SLUG → clumped (tight)
next token is anything else                        → free (layout)
```

This is the "rune clamping" decision. It determines whether `:foo`
is a tight prefix or `: \n foo \n bar` is a layout block.

### 7.4 Clump Rex Construction

```
clump_rex(elements, count):
  if count == 1:
    return elements[0].rex
  if elements[0] is RUNE:
    son = infix_rex(TIGHT_INFIX, elements[1:], count-1)
    return TIGHT_PREFIX(rune, son)
  return infix_rex(TIGHT_INFIX, elements, count)
```

### 7.5 Infix Rex Construction

This is the recursive rune-precedence splitting algorithm:

```
infix_rex(type, elements, count):
  // Collect all RUNE elements
  runes = unique runes sorted by precedence (lowest first)

  if no runes:
    // All elements are Rex — merge as HEIR chain
    return heir_chain(elements)

  lowest_rune = runes[0]

  // Split elements at every occurrence of lowest_rune
  groups = split(elements, lowest_rune)

  // Recursively process each group (with remaining runes)
  children = groups.map(g => infix_recur(type, g, runes[1:]))

  // If only one group (rune not actually splitting) → pass through
  if children.length == 1:
    return children[0]

  return INFIX_NODE(type, lowest_rune, children)
```

### 7.6 Nest Rex Construction

Inside brackets after collecting all elements:

```
nest_rex(bracket, elements):
  inner = nest_rex_inner(elements)
  color(inner, bracket)  // CLEAR → PAREN/BRACK/CURLY

nest_rex_inner(elements):
  if empty:
    return CLEAR_PREFIX("`", [])   // empty nest = backtick
  if single element (Rex):
    return that Rex directly        // (x) = x (unwrapped)
  return infix_rex(CLEAR_INFIX, elements)

color(rex, bracket):
  // Recursively replace CLEAR_PREFIX → PAREN_PREFIX, etc.
  // Recursively replace CLEAR_INFIX → PAREN_INFIX, etc.
```

### 7.7 Layout Finalization

When a CTX_LAYOUT context is closed (by dedentation via `layout(col)`):

```
finalize_layout(ctx):
  rune = ctx.rune
  sons = ctx.elements (all CLEM_REX entries after the rune)
  heir = ctx.heir_node (if trailing heir was accumulated)

  node = CLEAR_PREFIX(rune, sons)

  if heir:
    return HEIR(node, heir)
  return node
```

---

## 8. Printer

### 8.1 Phase 1: frex() — Bottom-Up Annotation

Walk the tree bottom-up. For each node, compute:
- `wide`: character width if printed inline (0 = too wide, must go tall)
- `unwrap`: whether parens can be dropped in heir context

**Wide threshold = 40 characters.**

#### Leaf widths:
```
WORD:  len(text)
TRAD:  2 + Σ(c == '"' ? 2 : 1)  [0 if contains newline]
QUIP:  1 + len(text)  [3 if empty, for "(')"]
SLUG:  0 (always tall)
UGLY:  0 (always tall)
```

#### Compound widths:

**TIGHT_PREFIX**: `len(rune) + child.wide` (0 if child is tall)

**TIGHT_INFIX**: sum of children + runes, with unwrap penalties.
Child unwrap rules:
- Not wide → not unwrappable
- Is TIGHT_INFIX with ≤ precedence → not unwrappable
- Is TIGHT_PREFIX → not unwrappable
- Trailing rune char → not unwrappable
- Trailing slug → not unwrappable
- Trailing quip + next doesn't start with tick → not unwrappable

**PREFIX/INFIX NEST**: `brackets(2) + rune + Σ(1 + child.wide)`.
All children marked unwrappable inside nests (except SLUG in PREFIX).

**HEIR**: `hd.wide + tl.wide + paren_penalties`. Unwrap direction
from heir unwrap table.

### 8.2 Heir Unwrap Table

6×6 matrix indexed by (head_type, tail_type):

```
Types:  w=WORD  t=TRAD  q=QUIP  u=UGLY  s=SLUG  _=compound

        w    t    q    u    s    _
    w   |    &    &    &    &    <
    t   &    |    &    &    &    <
    q   >    >    &    &    &    -
    u   &    &    |    |    |    <
    s   >    >    >    >    -    <
    _   -    -    -    -    -    -
```

Directions:
- `|` = choice: unwrap head (either would work, pick head)
- `&` = both unwrap
- `>` = tail unwraps only
- `<` = head unwraps only
- `-` = neither unwraps

When computing for HEIR, walk through unwrappable HEIRs to find
the actual trailing node type of head and leading node type of tail.

### 8.3 Phase 2: prex() — Top-Down Column-Tracked Output

State: `wCol` (current output column), `wDepth` (current indent depth).

Core operations:
```
align()  — pad spaces until wCol reaches wDepth
wchar(c) — align, then output c, wCol++
wstr(s)  — align, then output s, wCol += len(s)
wgap()   — align, then output ' ', wCol++
wline()  — output '\n', wCol = 0
```

#### Node rendering:

**WORD**: `wstr(text)`

**TRAD**: `wchar('"')`, set wDepth = wCol, output content ('"'→'""',
'\n'→wline), `wchar('"')`, restore wDepth.

**QUIP**: If empty: `wstr("(')")`. Otherwise: save wDepth, set
wDepth = max(wDepth, wCol), `wchar("'")`, output content ('\n'→wline,
else wchar), restore wDepth.

**SLUG**: Save wDepth, set wDepth = max(wDepth, wCol). For each line:
`wchar("'")`, if non-empty `wchar(' ')`, output text chars. Lines
separated by wline(). Restore wDepth.

**UGLY**: Save wDepth, set wDepth = max(wDepth, wCol). Output
delimiter (auto-sized), wline, content ('\n'→wline, else wchar),
wline, delimiter. Restore wDepth.

**HEIR**: Save wDepth. Set wDepth = max(wDepth, wCol).
`pwrapped(head)`. wDepth++. `pwrapped(tail)`. Restore wDepth.

**TIGHT_PREFIX**: `wstr(rune)`, `pwrapped(child)`.

**TIGHT_INFIX**: For each child: `pwrapped(child)`, between children:
`wstr(rune)`.

**PREFIX NEST** (wide): If bracketed: `wchar(open)`. If rune:
`wstr(rune)`, `wgap()`. For each child: `pwrapped(child)` (space
between). If bracketed: `wchar(close)`.

**PREFIX NEST** (tall): Save wDepth. If bracketed: `wchar(open)`.
If rune: `wstr(rune)`, `wgap()`, set wDepth = saved + runeLen + 2.
Else: set wDepth = saved + 2. For each child (newline between):
`pwrapped(child)`. If bracketed: wline, `wchar(close)` at saved depth.
Restore wDepth.

**INFIX NEST** (wide): If bracketed: `wchar(open)`. For each child:
`pwrapped(child)`, between: `wgap()`, `wstr(rune)`, `wgap()`. If
bracketed: `wchar(close)`.

**INFIX NEST** (tall): Save wDepth. Calculate: `drune` = depth for
rune, `delem` = depth for elements. Multi-char runes shift left:
`drune = depth - (runeLen - 1)`, `delem = drune + runeLen + 1`.
If bracketed: `wchar(open)`. First child at delem. Subsequent children:
wline, rune at drune, element at delem. If single child (trailing
rune): wline, rune at drune. If bracketed: wline, close at saved depth.
Restore wDepth.

### 8.4 pwrapped()

Wraps nodes that are not unwrappable:

```
pwrapped(node):
  if node is NEST (Np or Ni): prex(node)    // nests self-wrap
  if node._unwrap:            prex(node)    // unwrappable
  if node._wide:
    wchar('('), prex(node), wchar(')')      // wide wrapped
  else:
    wchar('('), wgap(), prex(node), wline(), wchar(')')  // tall wrapped
```

### 8.5 Top-Level Output

```
prNodes(nodes):
  for each node:
    output pr(node, initialDepth=4)
    output "\n\n"
```

Each top-level block indented 4 spaces, separated by blank lines.

---

## 9. Ugly Delimiter Auto-Sizing

```
uglyDelimWidth(content):
  maxRun = 0, currentRun = 0
  for each char in content:
    if char == "'": currentRun++
    else: maxRun = max(maxRun, currentRun); currentRun = 0
  maxRun = max(maxRun, currentRun)
  return maxRun + 1   // at minimum 2
```

---

## 10. String Content Stripping

### 10.1 TRAD

Strip outer `"`. Unescape `""` → `"`. Strip `col` leading spaces
from continuation lines. Poison if any continuation dedents past col.

### 10.2 QUIP

Strip leading `'`. Strip `col-1` leading spaces from continuation
lines. Poison if content dedents past `col`.

### 10.3 SLUG

Strip leading `' ` (2 chars). Continuation lines strip `col+1`
leading spaces. Continuation requires next line at same column
starting with `'`.

### 10.4 UGLY

Strip delimiter lines. Count delimiter width (number of `'` chars).
Strip `col-1` leading spaces from body lines. Poison if body dedents
past `col`. Closing delimiter must be at exact `col`.

---

## 11. Divergences from Current rex-parser.js

### 11.1 Missing Pipeline Stages

**Our parser has NO nestjoin, bsplit, or quipjoin stages.** It does
everything in one pass. This is the root cause of most failures:

1. **No nestjoin** → `'(])` breaks because `]` terminates the quip
   incorrectly. Neorex marks mismatched `]` as BAD, quipjoin consumes
   it as quip content.

2. **No bsplit** → Block boundaries are detected by indentation only,
   missing double-blank-line separation and rune-led block detection.

3. **No quipjoin** → Multi-line quips `'(foo \n bar)` don't coalesce
   correctly. Our lexer tries to handle quips inline, but the C
   implementation lexes `'`, `(`, `foo`, `)` as separate tokens,
   then quipjoin assembles them into a single QUIP.

### 11.2 Layout Mode

Our parser has basic indentation handling but lacks the CTX_LAYOUT
context type. The C parser's layout mode is triggered by "free runes"
(runes followed by whitespace, not clumped to the next token). Our
parser doesn't distinguish clumped vs free runes.

### 11.3 Clump vs Tight

Our parser builds tight forms correctly for simple cases but doesn't
defer the rune classification until the next token. The C parser's
approach: see RUNE → wait → next token determines clumped or free.

### 11.4 Infix Precedence

Our `ginf()` sorts runes and splits correctly. But the C version's
`infix_recur()` is cleaner: it pre-sorts all runes, then recursively
partitions from lowest to highest. Our version re-scans at each level.

### 11.5 Printer

The printer was rewritten in the last session to match neorex's
frex/prex/pwrapped pattern. It's close but untested against the gold
files because the parser produces wrong ASTs for complex inputs.

---

## 12. Port Strategy

### Phase 1: Token Pipeline

Replace the single-pass lexer with the 5-stage pipeline:

```javascript
function pipeline(src) {
  const tokens = lex(src);       // char → Token[]
  nestjoin(tokens);              // mutate: END → BAD for mismatched
  const blocks = bsplit(tokens); // inject EOB sentinels
  quipjoin(blocks);              // coalesce quip runs
  return parse(blocks);          // stack machine → Rex[]
}
```

Each stage can be implemented as an in-place array transform (not
streaming — the C version uses callbacks but we can batch).

### Phase 2: Parser Machine

Replace `parse()` with the dual-stack machine:

```javascript
class Parser {
  ctx_stk = [];  // { type: NEST|CLUMP|LAYOUT, pos, ... }
  elm_stk = [];  // current context's elements

  layout(col) { ... }
  openClump(col) { ... }
  closeClump() { ... }
  openNest(col, bracket) { ... }
  closeNest(col, bracket) { ... }
  addRex(col, rex) { ... }
  pushClumpedRune(col, text) { ... }
  pushFreeRune(col, text) { ... }
}
```

### Phase 3: Rex Construction

Port `clump_rex()`, `infix_rex()`, `infix_recur()`, `nest_rex()`,
`color()`, `finalize_layout()` exactly.

### Phase 4: Printer Validation

Run all 13 gold test pairs through:
```
input → pipeline → prNodes → compare with gold output
```

### Phase 5: Shrub Bridge

Keep the existing `toShrub()` and `fromShrub()` functions. They sit
on top of the canonical Rex AST — their interface doesn't change,
only the quality of the AST they receive improves.

---

## 13. Test Suite

### 13.1 Gold Files (from neorex/gold/)

```
simple.rex  — quip, layout prefix, heir, slug
node.rex    — nested brackets, tight infix, layout infix
trad.rex    — multi-line trad, escaped quotes, heir
quip.rex    — multi-line quip, bracketed quip, mismatched brackets
slug.rex    — multi-line slug, continuation, empty lines
bloc.rex    — block splitting, layout mode, multiple blocks
expo.rex    — backtick sugar, single-element nests
ifix.rex    — rune precedence, trailing runes
itrail.rex  — trailing rune edge cases
nest.rex    — nested brackets, layout inside nests
qfmt.rex    — quip formatting edge cases
strip.rex   — ugly delimiter sizing, poison detection
twrap.rex   — heir unwrapping, paren insertion
```

### 13.2 Validation Script

```bash
for f in ex/*.rex; do
  base=$(basename "$f")
  actual=$(echo "$f" | node -e "
    const Rex = require('./src/rex-parser.js');
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    const { nodes } = Rex.pipeline(src);
    process.stdout.write(Rex.prNodes(nodes));
  " "$f")
  expected=$(cat "gold/$base")
  diff <(echo "$actual") <(echo "$expected")
done
```

---

## 14. Non-Goals

- WASM compilation (keep pure JS for now)
- Streaming/incremental parsing (batch is fine)
- Error recovery beyond BAD tokens
- Syntax highlighting (separate concern)
- Sire/Wisp integration (separate languages on top of Rex)

---

## Appendix A: Rune Char Set

```
, : # $ ` ~ @ ? \ | ^ & = ! < > + - * / % .
```

22 characters. Semicolon (`;`) is NOT a rune — it starts a comment.
Exclamation (`!`) appears at index 13 and also at index 20 in the C
source (`",:#$\`~@?\\|^&=!<>+-*/%!."`) — this is a 24-char string
with two `!` occurrences for base-24 packing. The actual rune set
has 22 unique characters.

## Appendix B: Empty Nest = Backtick

```
()  →  PAREN_PREFIX("`", [])
[]  →  BRACK_PREFIX("`", [])
{}  →  CURLY_PREFIX("`", [])
```

The backtick rune signals "empty nest" in the printed form.

## Appendix C: Single-Element Nest Unwrapping

```
(x)  →  x   (the parens are dropped, just return x)
```

Single-element nests with no rune are unwrapped by `nest_rex_inner`.
This does NOT apply to rune-led single elements: `(+ x)` stays as
PAREN_PREFIX("+", [x]).
