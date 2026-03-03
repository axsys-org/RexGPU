// ═══════════════════════════════════════════════════════════════════
// REX PARSER — Clean port of PLAN/neorex/rex.c (2000 lines, C)
// 5-stage pipeline: lex → nestjoin → bsplit → quipjoin → parse
// Printer: frex (bottom-up annotation) → prex (top-down rendering)
// ═══════════════════════════════════════════════════════════════════

// ── Rune precedence (loosest → tightest) ─────────────────────────
// 22 unique chars. Semicolon is NOT a rune.
const RUNE_ORDER = [',',':','#','$','`','~','@','?','\\','|','^','&','=','!','<','>','+','-','*','/','%','.'];
const RUNE_SET = new Set(RUNE_ORDER);
const isRune = c => RUNE_SET.has(c);
const isWord = c => /[A-Za-z0-9_]/.test(c);

// Base-24 rune packing for O(1) precedence comparison (matches C packrune)
// The C string is ",:#$`~@?\\|^&=!<>+-*/%!." — 23 chars with ! at positions 13 and 20
const RUNE_PREC_STR = ",:#$`~@?\\|^&=!<>+-*/%!.";
function runePrec(c) {
  const i = RUNE_PREC_STR.indexOf(c);
  return i >= 0 ? i : 23;
}
function packRune(s) {
  let result = 0n, place = 1n;
  for (let i = 0; i < 13; i++) {
    const code = i < s.length ? BigInt(runePrec(s[i])) : 23n;
    result += place * code;
    place *= 24n;
  }
  return result;
}
function cmpRunes(a, b) {
  const pa = packRune(a), pb = packRune(b);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

// ── Brackets ─────────────────────────────────────────────────────
const BK = {Paren:'P',Brack:'B',Curly:'C',Clear:'X'};
const BK_OPEN = {P:'(',B:'[',C:'{',X:null};
const BK_CLOSE = {P:')',B:']',C:'}',X:null};
const BK_FROM = {'(':'P','[':'B','{':'C'};
const BK_MATCH = {'(':')', '[':']', '{':'}'};

// ── Token types ──────────────────────────────────────────────────
const T = {
  BAD: 0, EOL: 1, EOB: 2, EOF: 3, SEMI: 4, WYTE: 5,
  BEGIN: 6, END: 7, RUNE: 8, WORD: 9, TRAD: 10, QUIP: 11,
  UGLY: 12, SLUG: 13
};

function tok(ty, buf, sz, col) { return { ty, buf, sz, col }; }

// ── AST constructors ─────────────────────────────────────────────
const N = (tag,d) => ({_:tag,...d});
const Word = v => N('Wd',{v}), Quip = v => N('Qp',{v}), Trad = v => N('Td',{v});
const Slug = v => N('Sl',{v}), Ugly = v => N('Ug',{v}), Bad = v => N('Bd',{v});
const Heir = (h,t) => N('Hr',{h,t}), TightPre = (r,c) => N('Tp',{r,c});
const TightInf = (r,ch) => N('Ti',{r,ch}), Block = ch => N('Bk',{ch});
const NestPre = (b,r,ch) => N('Np',{b,r,ch}), NestInf = (b,r,ch) => N('Ni',{b,r,ch});

// ═══════════════════════════════════════════════════════════════════
// STAGE 1: LEXER — character-by-character DFA
// Produces Token[] with { ty, buf, sz, col } for each token.
// ═══════════════════════════════════════════════════════════════════

function lex(src) {
  const tokens = [];
  const n = src.length;
  let i = 0, col = 0;

  function emit(ty, buf, sz, tcol) {
    tokens.push(tok(ty, buf, sz, tcol));
  }

  while (i <= n) {
    // EOF sentinel
    if (i === n) {
      emit(T.EOF, '', 0, col);
      break;
    }

    const ch = src[i];
    const tcol = col; // column where this token starts

    // ── Newline ──
    if (ch === '\n') {
      // C: eol_tok hardcodes .col=0
      emit(T.EOL, '\n', 1, 0);
      i++; col = 0;
      continue;
    }

    // ── Whitespace ──
    if (ch === ' ') {
      const start = i;
      while (i < n && src[i] === ' ') { i++; col++; }
      emit(T.WYTE, src.substring(start, i), i - start, tcol);
      continue;
    }

    // ── Tab → BAD (C: falls through to default → emit0(BAD)) ──
    if (ch === '\t') { emit(T.BAD, '\t', 1, col); i++; col++; continue; }

    // ── Semicolon comment ──
    if (ch === ';') {
      const start = i;
      while (i < n && src[i] !== '\n') { i++; col++; }
      emit(T.SEMI, src.substring(start, i), i - start, tcol);
      continue;
    }

    // ── Tick: quip, slug, or ugly ──
    if (ch === "'") {
      // Count consecutive ticks
      let tickCount = 0;
      let j = i;
      while (j < n && src[j] === "'") { tickCount++; j++; }

      // ── Ugly string: 2+ ticks ──
      // C: UGLY_START counts additional ticks. If next char is NOT newline, poison
      // but STILL enter UGLY_MODE. Then UGLY_MODE processes char-by-char until
      // matching usz consecutive ticks (closing at any column, poisoning if wrong).
      if (tickCount >= 2) {
        const startCol = tcol;
        const usz = tickCount;
        const tokStart = i;
        let poison = false;

        // C UGLY_START: if (c != '\n') { poison=1; } mode=UGLY_MODE;
        if (j < n && src[j] === '\n') {
          i = j + 1; col = 0; // skip past ticks + newline
        } else if (j < n) {
          poison = true; // non-newline after opening ticks
          i = j; col = tcol + tickCount; // continue from char after ticks
        } else {
          // EOF after ticks
          const fullBuf = src.substring(tokStart, j);
          emit(T.BAD, fullBuf, fullBuf.length, startCol);
          i = j;
          continue;
        }

        let urem = usz; // tick countdown

        // UGLY_MODE: process char by char matching C exactly
        while (i < n) {
          const c = src[i];
          // C: if (col<tcol && c!=' ' && c!='\n') { poison=1; }
          if (col < startCol && c !== ' ' && c !== '\n') poison = true;
          // C: if (c != '\'') { urem=usz; return; }
          if (c !== "'") {
            urem = usz;
            if (c === '\n') { i++; col = 0; } else { i++; col++; }
            continue;
          }
          // c is a tick
          // C: if (--urem) { return; }
          urem--;
          if (urem > 0) { i++; col++; continue; }
          // urem reached 0 — we matched usz ticks
          // C: if (col+1 != tcol+usz) { poison=1; }
          if (col + 1 !== startCol + usz) poison = true;
          i++; col++;
          break;
        }

        // C: unterminated ugly at EOF → BAD (still in non-BASE_MODE when EOF hits)
        if (urem !== 0) poison = true;
        const fullBuf = src.substring(tokStart, i);
        emit(poison ? T.BAD : T.UGLY, fullBuf, fullBuf.length, startCol);
        continue;
      }

      // ── Slug: tick + space or tick + newline ──
      // C TICK_MODE: case ' ': case '\n': mode=SLUG_TEXT;
      if (tickCount === 1 && j < n && (src[j] === ' ' || src[j] === '\n')) {
        const startCol = tcol;
        const tokStart = i;
        i = j; col = startCol + 1; // past the tick
        if (src[i] === ' ') { i++; col++; } // skip space if present

        // Read rest of line
        while (i < n && src[i] !== '\n') { i++; col++; }

        // Check for continuation lines (next line starting with ' at same col)
        while (i < n && src[i] === '\n') {
          const nlPos = i;
          i++; col = 0;
          // Skip spaces
          while (i < n && src[i] === ' ') { i++; col++; }
          // Check for continuation: tick at same column
          if (i < n && src[i] === "'" && col === startCol) {
            // Check next char: space or newline = continuation slug
            if (i + 1 < n && (src[i + 1] === ' ' || src[i + 1] === '\n')) {
              i++; col++; // skip tick
              if (i < n && src[i] === ' ') { i++; col++; } // skip space
              // Read rest of line
              while (i < n && src[i] !== '\n') { i++; col++; }
              continue;
            }
          }
          // Not a continuation — put back the newline
          i = nlPos;
          break;
        }

        const fullBuf = src.substring(tokStart, i);
        emit(T.SLUG, fullBuf, fullBuf.length, startCol);
        continue;
      }

      // ── Quip: tick + non-whitespace/non-tick ──
      // C TICK_MODE: emit1(QUIP) for any default char — emits just the bare tick
      // as QUIP, then the following char starts a new token. quipjoin merges them.
      if (tickCount === 1 && j < n && src[j] !== ' ' && src[j] !== '\n' && src[j] !== "'") {
        emit(T.QUIP, "'", 1, tcol);
        i++; col++; // skip just the tick, next char re-enters main loop
        continue;
      }

      // ── Bare tick (tick + space/newline/tick) ──
      if (tickCount === 1) {
        // Tick followed by space/newline → slug (handled above) or bare tick
        emit(T.QUIP, "'", 1, tcol);
        i++; col++;
        continue;
      }

    }

    // ── Trad string ──
    if (ch === '"') {
      const tokStart = i;
      const startCol = tcol;
      i++; col++; // skip opening quote
      let poison = false;
      let closed = false;

      while (i < n) {
        if (src[i] === '"') {
          if (i + 1 < n && src[i + 1] === '"') {
            // Doubled quote escape
            i += 2; col += 2;
          } else {
            // Closing quote
            i++; col++;
            closed = true;
            break;
          }
        } else if (src[i] === '\n') {
          i++; col = 0;
        } else {
          if (src[i] !== ' ' && col <= startCol) poison = true;
          i++; col++;
        }
      }

      // C: unterminated string at EOF → BAD
      if (!closed) poison = true;
      const fullBuf = src.substring(tokStart, i);
      emit(poison ? T.BAD : T.TRAD, fullBuf, fullBuf.length, startCol);
      continue;
    }

    // ── Brackets ──
    if (ch === '(' || ch === '[' || ch === '{') {
      emit(T.BEGIN, ch, 1, col);
      i++; col++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      emit(T.END, ch, 1, col);
      i++; col++;
      continue;
    }

    // ── Word ──
    if (isWord(ch)) {
      const start = i;
      while (i < n && isWord(src[i])) { i++; col++; }
      emit(T.WORD, src.substring(start, i), i - start, tcol);
      continue;
    }

    // ── Rune ──
    if (isRune(ch)) {
      const start = i;
      while (i < n && isRune(src[i])) { i++; col++; }
      emit(T.RUNE, src.substring(start, i), i - start, tcol);
      continue;
    }

    // Unknown character → BAD (C: default case in BASE_MODE → emit0(BAD))
    emit(T.BAD, ch, 1, col);
    i++; col++;
  }

  return tokens;
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2: NESTJOIN — bracket matching
// Mismatched END tokens become BAD (critical for quipjoin).
// ═══════════════════════════════════════════════════════════════════

function nestjoin(tokens) {
  const stack = [];
  for (const t of tokens) {
    if (t.ty === T.BEGIN) {
      stack.push(BK_MATCH[t.buf[0]]);
    } else if (t.ty === T.END) {
      if (stack.length > 0 && stack[stack.length - 1] === t.buf[0]) {
        stack.pop();
      } else {
        t.ty = T.BAD; // mismatched close bracket → BAD
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 3: BSPLIT — block splitter
// Injects EOB sentinels at block boundaries.
// ═══════════════════════════════════════════════════════════════════

const BS = { OUTSIDE: 0, LEADING_RUNE: 1, SINGLE_LN: 2, BLK: 3 };

function isLeafy(ty) {
  return ty === T.BEGIN || ty === T.WORD || ty === T.QUIP ||
         ty === T.TRAD || ty === T.UGLY || ty === T.SLUG;
}

function bsplit(tokens) {
  // Faithful port of C bsplit
  const out = [];
  let mode = BS.OUTSIDE;
  let nest = 0;
  let eol = 0;
  let stashedRune = null; // for LEADING_RUNE mode

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Track bracket nesting (before eol reset)
    if (t.ty === T.BEGIN) nest++;
    if (t.ty === T.END) nest--;

    // eol counter: consecutive EOLs, reset on any non-EOL
    eol = (t.ty === T.EOL) ? eol + 1 : 0;

    let end = false;

    switch (mode) {
    case BS.OUTSIDE:
      if (t.ty === T.RUNE) {
        mode = BS.LEADING_RUNE;
        stashedRune = t;
        continue; // defer — emit when we see the next token
      }
      mode = isLeafy(t.ty) ? BS.SINGLE_LN : BS.OUTSIDE;
      break;

    case BS.SINGLE_LN:
      if (nest === 0 && eol === 1) end = true;
      break;

    case BS.LEADING_RUNE:
      // Emit the stashed rune first
      out.push(stashedRune);
      stashedRune = null;
      mode = isLeafy(t.ty) ? BS.SINGLE_LN : BS.BLK;
      break;

    case BS.BLK:
      if (nest === 0 && eol === 2) end = true;
      break;
    }

    out.push(t);
    if (end) { out.push(tok(T.EOB, '', 0, 0)); mode = BS.OUTSIDE; }
  }

  // Flush: if still in a block, emit final EOB
  if (mode !== BS.OUTSIDE) {
    if (stashedRune) out.push(stashedRune);
    out.push(tok(T.EOB, '', 0, 0));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 4: QUIPJOIN — coalesce multi-token quip sequences
// A QUIP token followed by balanced brackets is merged into a
// single QUIP. BAD tokens (from nestjoin) are consumed as content.
// ═══════════════════════════════════════════════════════════════════

function quipjoin(tokens) {
  // Faithful port of C quipjoin.
  // C uses c=0 as "not in quip" since columns are 1-based.
  // JS columns are 0-based, so we use a separate inQuip flag.
  const out = [];
  let buf = '';      // accumulated raw bytes (starts with ')
  let n = 0;         // bracket nesting depth
  let qcol = 0;     // quip start column
  let inQuip = false;
  let poison = false;
  let hasRune = false;
  let stashedRune = null; // {buf, col, sz}

  function finalize() {
    // If stashed rune and buf is just the tick (sz=1), append rune to quip
    if (hasRune && buf.length === 1) {
      buf += stashedRune.buf;
      hasRune = false;
      stashedRune = null;
    }
    out.push(tok(poison ? T.BAD : T.QUIP, buf, buf.length, qcol));
    if (hasRune) { out.push(stashedRune); hasRune = false; stashedRune = null; }
    buf = ''; n = 0; qcol = 0; inQuip = false; poison = false;
  }

  function consume(t) {
    if (t.ty !== T.EOL && t.ty !== T.WYTE && t.col < qcol) poison = true;
    if (t.ty === T.BEGIN) n++;
    if (t.ty === T.END) n--;
    // Flush stashed rune into buf first
    if (hasRune) { buf += stashedRune.buf; hasRune = false; stashedRune = null; }
    buf += t.buf;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Not in quip — check for QUIP token to begin
    if (!inQuip) {
      if (t.ty === T.QUIP) {
        // begin
        n = 0; poison = false; buf = '';
        qcol = t.col;
        inQuip = true;
        consume(t);
        continue;
      }
      out.push(t);
      continue;
    }

    // EOF always finalizes
    if (t.ty === T.EOF) { finalize(); out.push(t); continue; }

    // If nested (n > 0), always consume
    if (n > 0) { consume(t); continue; }

    // At depth 0: check terminal
    switch (t.ty) {
    case T.END: case T.WYTE: case T.SEMI:
    case T.EOL: case T.QUIP: case T.UGLY: case T.SLUG:
      finalize();
      // Re-process this token (it might start a new quip)
      i--;
      continue;
    case T.RUNE:
      // Stash rune — wait for next token to decide
      stashedRune = t;
      hasRune = true;
      continue;
    default:
      // WORD, TRAD, BAD, BEGIN — consume
      consume(t);
      continue;
    }
  }

  // Flush any pending quip
  if (inQuip) finalize();
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 5: PARSER — dual-stack machine
// Converts token stream to Rex trees.
// ═══════════════════════════════════════════════════════════════════

const CLEM_RUNE = 0, CLEM_REX = 1;
const CTX_NEST = 0, CTX_CLUMP = 1, CTX_LAYOUT = 2;

function leafRex(t) {
  // Convert a token to a leaf Rex node with string content stripping
  switch (t.ty) {
  case T.WORD:
    return Word(t.buf);

  case T.BAD:
    return Bad(t.buf); // C: copy — raw token content preserved

  case T.TRAD: {
    // Strip outer quotes, unescape "" → ", strip continuation indent.
    // C: dent=tok.col (1-based). JS cols 0-based → dent=t.col+1.
    const raw = t.buf;
    const dent = t.col + 1;
    let content = '';
    const sz = raw.length - 2; // exclude outer quotes
    let i = 0;
    while (i < sz) {
      const c = raw[i + 1]; // +1 to skip opening "
      if (c === '"') { content += '"'; i += 2; } // "" → "
      else if (c === '\n') {
        content += '\n'; i++;
        for (let k = 0; k < dent && i < sz && raw[i + 1] === ' '; k++) i++;
      } else { content += c; i++; }
    }
    return Trad(content);
  }

  case T.QUIP: {
    // Strip leading tick, de-indent continuation lines.
    // C: dent=tok.col-1 (1-based col). JS: dent = (t.col+1)-1 = t.col.
    const raw = t.buf;
    const dent = t.col;
    let content = '';
    const sz = raw.length - 1; // exclude leading '
    let i = 0;
    while (i < sz) {
      const c = raw[i + 1]; // +1 to skip leading '
      if (c === '\n') {
        content += '\n'; i++;
        for (let k = 0; k < dent && i < sz && raw[i + 1] === ' '; k++) i++;
      } else { content += c; i++; }
    }
    return Quip(content);
  }

  case T.SLUG: {
    // C: sz-=2, p+=2, prefix=tok.col+1 (1-based). In JS: prefix=t.col+2.
    const raw = t.buf;
    const prefix = t.col + 2;
    const sz = raw.length - 2;
    if (sz <= 0) return Slug(['']); // empty slug (tick+newline with no content)
    let content = '';
    for (let i = 0; i < sz; i++) {
      const c = raw[i + 2];
      content += c;
      if (c === '\n') i += prefix; // skip indent + tick + space
    }
    return Slug(content.split('\n'));
  }

  case T.UGLY: {
    // C: dent=tok.col-1 (1-based→0-based). JS: dent=t.col.
    // dsz=delimiter width. p+=(dsz+1), sz-=(dsz*2+2+dent).
    // for(i=dent,o=0;i<sz;i++,o++) copy with \n indent strip.
    const raw = t.buf;
    const dent = t.col;
    let dsz = 0;
    while (dsz < raw.length && raw[dsz] === "'") dsz++;
    const p = dsz + 1; // skip delimiter ticks + newline
    const sz = raw.length - (dsz * 2 + 2 + dent);
    let content = '';
    for (let i = dent; i < sz; i++) {
      const c = raw[p + i];
      content += c;
      if (c === '\n')
        for (let j = 0; j < dent && (i+1) < sz && raw[p + i + 1] === ' '; j++) i++;
    }
    return Ugly(content);
  }

  default:
    return Word('?');
  }
}

function parse(tokens) {
  // Dual-stack parser machine
  // elm_stk: [{ty: CLEM_RUNE|CLEM_REX, val: string|Rex}]
  // ctx_stk: [{ty: CTX_NEST|CTX_CLUMP|CTX_LAYOUT, pos, sz, nest/hasHeir}]
  const elm_stk = [];
  const ctx_stk = [];
  let elm_sz = 0; // total elements on elm_stk
  const results = [];

  // Initialize with root nest context
  ctx_stk.push({ ty: CTX_NEST, pos: 0, sz: 0, nest: '(' });

  function topCtx() { return ctx_stk[ctx_stk.length - 1]; }

  function pushElem(elem) {
    elm_stk.push(elem);
    elm_sz++;
    topCtx().sz++;
  }

  // Close all CTX_LAYOUT contexts with pos > col
  function layout(col) {
    while (ctx_stk.length > 0 && topCtx().ty === CTX_LAYOUT && topCtx().pos > col) {
      finalizeLayout();
    }
  }

  function openClump(col) {
    layout(col);
    if (topCtx().ty === CTX_CLUMP) return;
    ctx_stk.push({ ty: CTX_CLUMP, pos: col, sz: 0 });
  }

  function closeClump() {
    if (topCtx().ty !== CTX_CLUMP) return;
    finalizeClump();
  }

  function openNest(col, bracket) {
    openClump(col);
    ctx_stk.push({ ty: CTX_NEST, pos: col, sz: 0, nest: bracket });
  }

  // C: close_ctx_if_nest — close one nest if top is nest
  function closeNestIfNest() {
    if (ctx_stk.length > 0 && topCtx().ty === CTX_NEST) finalizeNest();
  }

  // C: close_ctx — dispatch to appropriate finalizer
  function closeCtx() {
    const top = topCtx();
    if (top.ty === CTX_NEST) finalizeNest();
    else if (top.ty === CTX_CLUMP) finalizeClump();
    else if (top.ty === CTX_LAYOUT) finalizeLayout();
  }

  function addRexToClump(col, rex) {
    openClump(col);
    // If top element is already a Rex, merge as heir
    const ctx = topCtx();
    if (ctx.sz > 0 && elm_stk[elm_stk.length - 1].ty === CLEM_REX) {
      elm_stk[elm_stk.length - 1].val = Heir(elm_stk[elm_stk.length - 1].val, rex);
      return;
    }
    pushElem({ ty: CLEM_REX, val: rex });
  }

  function pushClumpedRune(col, txt) {
    openClump(col);
    pushElem({ ty: CLEM_RUNE, val: txt });
  }

  function pushFreeRune(col, txt) {
    closeClump();
    const rpos = (col - 1) + txt.length; // col is now 1-based, matching C
    layout(rpos);

    const top = topCtx();
    // Decide whether to open a new layout context
    const shouldLayout =
      top.ty === CTX_LAYOUT ||
      (top.ty === CTX_NEST && top.sz === 0) ||
      (top.ty === CTX_NEST && top.sz > 0 && elm_stk[elm_stk.length - 1].ty === CLEM_RUNE);

    if (shouldLayout) {
      ctx_stk.push({ ty: CTX_LAYOUT, pos: rpos, sz: 0, hasHeir: false });
    }

    pushElem({ ty: CLEM_RUNE, val: txt });
  }

  function finalizeClump() {
    const ctx = ctx_stk.pop();
    const sz = ctx.sz;
    const es = elm_stk.splice(elm_stk.length - sz, sz);
    elm_sz -= sz;
    const rex = clumpRex(es);
    pushElem({ ty: CLEM_REX, val: rex });
  }

  function finalizeNest() {
    const ctx = ctx_stk.pop();
    const sz = ctx.sz;
    const es = elm_stk.splice(elm_stk.length - sz, sz);
    elm_sz -= sz;
    const rex = nestRex(ctx.nest, es, sz);
    // Add result to parent context
    if (ctx_stk.length > 0) {
      addRexToClump(ctx.pos, rex);
    } else {
      // Root level — push result
      results.push(rex);
    }
  }

  function finalizeLayout() {
    // Faithful port of C finalize_layout (lines 1374–1406)
    const ctx = ctx_stk.pop();
    const sz = ctx.sz;
    const es = elm_stk.splice(elm_stk.length - sz, sz);
    elm_sz -= sz;
    const rune = es[0].val; // es[0] is always CLEM_RUNE
    let rex;
    if (ctx.hasHeir) {
      const nSons = sz - 2;
      const sons = [];
      for (let i = 0; i < nSons; i++) sons.push(es[i + 1].val);
      rex = Heir(NestPre(BK.Clear, rune, sons), es[sz - 1].val);
    } else {
      const nSons = sz - 1;
      const sons = [];
      for (let i = 0; i < nSons; i++) sons.push(es[i + 1].val);
      rex = NestPre(BK.Clear, rune, sons);
    }
    pushElem({ ty: CLEM_REX, val: rex });
    if (ctx_stk.length > 0 && topCtx().ty === CTX_LAYOUT) {
      topCtx().hasHeir = (ctx.pos === topCtx().pos);
    }
  }

  function finalizeContext() {
    // C: finalize_context — ctx_stk_sz must be 1 at this point
    // (the while(ctx_stk_sz>1) close_ctx() in EOF/EOB already unwound)
    // C: if (elm_stk_sz) { print_rex + "\n"; } printf("\n");
    // Non-empty blocks → rex node, empty blocks → null (just blank line)
    const sz = ctx_stk[0].sz;
    if (sz > 0) {
      const es = elm_stk.splice(0, sz);
      elm_sz = 0;
      const rex = nestRex('(', es, sz);
      results.push(rex);
    } else {
      results.push(null); // empty block → produces just "\n" in C
    }
    // Reset for next block
    ctx_stk[0].sz = 0;
    elm_sz = 0;
    elm_stk.length = 0;
  }

  // ── Process tokens ──
  let pendingRune = null; // stashed rune waiting for next token

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Handle pending rune: decide clumped vs free based on current token
    // Convert 0-based JS columns to 1-based (matching C) for layout/pos system
    if (pendingRune) {
      const pr = pendingRune;
      pendingRune = null;
      const c1 = pr.col + 1; // 0→1-based
      if (t.ty === T.BEGIN || t.ty === T.WORD || t.ty === T.TRAD ||
          t.ty === T.QUIP || t.ty === T.UGLY || t.ty === T.SLUG) {
        pushClumpedRune(c1, pr.buf);
      } else {
        pushFreeRune(c1, pr.buf);
      }
      // Fall through to process current token
    }

    switch (t.ty) {
    case T.END:
      // C: layout(0); close_ctx_if_clump(); layout(0); close_ctx_if_nest();
      layout(0);
      closeClump();
      layout(0);
      closeNestIfNest();
      break;

    case T.BEGIN:
      openNest(t.col + 1, t.buf[0]);
      break;

    case T.SEMI:
    case T.EOL:
    case T.WYTE:
      closeClump();
      break;

    case T.EOF:
    case T.EOB:
      // C: while (ctx_stk_sz>1) close_ctx(); finalize_context();
      while (ctx_stk.length > 1) closeCtx();
      finalizeContext();
      break;

    case T.RUNE:
      pendingRune = t;
      break;

    case T.BAD:
    case T.WORD:
    case T.TRAD:
    case T.QUIP:
    case T.UGLY:
    case T.SLUG:
      layout(t.col + 1);
      addRexToClump(t.col + 1, leafRex(t));
      break;
    }
  }

  // Handle any remaining pending rune — shouldn't happen if EOF is in token stream
  if (pendingRune) {
    pushFreeRune(pendingRune.col + 1, pendingRune.buf);
    pendingRune = null;
    while (ctx_stk.length > 1) closeCtx();
    finalizeContext();
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// REX CONSTRUCTION — clump_rex, infix_rex, nest_rex, color
// ═══════════════════════════════════════════════════════════════════

// Faithful port of C clump_rex (lines 1251–1261)
function clumpRex(es) {
  if (es.length < 1) throw new Error("impossible: empty clump");
  if (es.length === 1) return es[0].val;
  if (es[0].ty === CLEM_RUNE) {
    const son = infixRex('Ti', es.slice(1));
    return TightPre(es[0].val, son);
  }
  return infixRex('Ti', es);
}

// Faithful port of C infix_rex (lines 1172–1201)
function infixRex(rty, es) {
  const runes = [];
  for (const e of es) {
    if (e.ty === CLEM_RUNE) runes.push(e.val);
  }
  // Sort by precedence and deduplicate
  runes.sort(cmpRunes);
  const uniq = runes.length ? [runes[0]] : [];
  for (let i = 1; i < runes.length; i++) {
    if (runes[i] !== runes[i-1]) uniq.push(runes[i]);
  }
  return infixRecur(rty, uniq.length, uniq, es, 0, es.length);
}

// Faithful port of C infix_recur (lines 1133–1170)
function infixRecur(rty, nRune, runes, buf, off, sz) {
  if (sz === 1) return buf[off].val;
  if (nRune === 0) {
    // C: CLEAR_PREFIX("`", all elements)
    const sons = [];
    for (let i = 0; i < sz; i++) sons.push(buf[off + i].val);
    return NestPre(BK.Clear, '`', sons);
  }
  const kids = [];
  while (sz > 0) {
    let ix = 0;
    while (ix < sz) {
      const c = buf[off + ix];
      if (c.ty === CLEM_RUNE && c.val === runes[0]) break;
      ix++;
    }
    kids.push(infixRecur(rty, nRune - 1, runes.slice(1), buf, off, ix));
    off += ix + 1;
    sz -= ix + 1;
  }
  // C: if (nKid==1 && sz) return kids[0];
  // sz is non-zero (negative) when the rune wasn't found — skip this rune level.
  // sz is 0 when rune was found (e.g. trailing rune) — keep the infix node.
  if (kids.length === 1 && sz !== 0) return kids[0];
  if (rty === 'Ti') return TightInf(runes[0], kids);
  return NestInf(BK.Clear, runes[0], kids);
}

// Faithful port of C nest_rex_inner (lines 1235–1243)
function nestRexInner(es, sz) {
  if (!sz || es.length === 0) return NestPre(BK.Clear, '`', []);
  if (es[0].ty === CLEM_RUNE) throw new Error("nest cannot begin with a rune");
  if (es.length === 1) return es[0].val;
  return infixRex('Ni', es);
}

function nestRex(nestTy, es, sz) {
  const inner = nestRexInner(es, sz);
  return colorRex(nestTy, inner);
}

function colorRex(nestTy, rex) {
  // C: color() mutates p->t in-place for CLEAR nodes, wraps for non-CLEAR
  if (!rex) return rex;
  const isClear = (rex._ === 'Np' || rex._ === 'Ni') && rex.b === BK.Clear;

  if (isClear) {
    // Mutate bracket type in-place (matches C: p->t = prefix_color(nestTy))
    switch (nestTy) {
    case '(': rex.b = BK.Paren; return rex;
    case '[': rex.b = BK.Brack; return rex;
    case '{': rex.b = BK.Curly; return rex;
    }
  }

  // Non-CLEAR nodes:
  switch (nestTy) {
  case '(': return rex;                        // C: pass through unchanged
  case '[': return NestPre(BK.Brack, '`', [rex]); // C: rex1(BRACK_PREFIX, "`", p)
  case '{': return NestPre(BK.Curly, '`', [rex]); // C: rex1(CURLY_PREFIX, "`", p)
  }
  return rex;
}

// ═══════════════════════════════════════════════════════════════════
// INCREMENTAL LEXING — line-level token cache
// Re-lex only changed lines; fallback on multi-line token boundaries.
// ═══════════════════════════════════════════════════════════════════

let _lexCache = null; // { lines: string[], lineTokens: Token[][] }

function lexIncremental(src) {
  if (!_lexCache) {
    // Cold start — full lex, build line cache
    const tokens = lex(src);
    _lexCache = { lines: src.split('\n'), lineTokens: _splitTokensByLine(tokens) };
    return tokens;
  }

  const newLines = src.split('\n');
  const oldLines = _lexCache.lines;

  // Find first differing line (prefix match)
  let firstChanged = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (firstChanged < minLen && oldLines[firstChanged] === newLines[firstChanged]) firstChanged++;

  // Find last differing line (suffix match)
  let oldEnd = oldLines.length - 1, newEnd = newLines.length - 1;
  while (oldEnd > firstChanged && newEnd > firstChanged && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--; newEnd--;
  }

  // No change
  if (firstChanged >= minLen && oldLines.length === newLines.length) {
    return _rebuildTokens(_lexCache.lineTokens);
  }

  // Check if changed region touches multi-line constructs (ugly strings, trad strings)
  let needsFullLex = false;
  for (let i = firstChanged; i <= newEnd; i++) {
    const line = newLines[i];
    if (line.includes("''") || line.includes('""')) { needsFullLex = true; break; }
    // Check for unclosed trad string (quote without matching close on same line)
    let quoteCount = 0;
    for (let j = 0; j < line.length; j++) if (line[j] === '"') quoteCount++;
    if (quoteCount % 2 !== 0) { needsFullLex = true; break; }
  }
  // Also check old changed lines for multi-line tokens we might be breaking
  if (!needsFullLex) {
    for (let i = firstChanged; i <= oldEnd; i++) {
      const line = oldLines[i];
      if (line.includes("''") || line.includes('""')) { needsFullLex = true; break; }
      let quoteCount = 0;
      for (let j = 0; j < line.length; j++) if (line[j] === '"') quoteCount++;
      if (quoteCount % 2 !== 0) { needsFullLex = true; break; }
    }
  }

  if (needsFullLex) {
    const tokens = lex(src);
    _lexCache = { lines: newLines, lineTokens: _splitTokensByLine(tokens) };
    return tokens;
  }

  // Re-lex only the changed lines
  // Append \n so the last changed line gets an EOL token (unless it's the absolute last line)
  let changedSrc = newLines.slice(firstChanged, newEnd + 1).join('\n');
  const isLastLine = newEnd >= newLines.length - 1;
  if (!isLastLine) changedSrc += '\n';
  const changedTokens = lex(changedSrc);
  // Remove the trailing EOF from the changed-region lex
  if (changedTokens.length > 0 && changedTokens[changedTokens.length - 1].ty === T.EOF) {
    changedTokens.pop();
  }
  const newLineTokens = _splitTokensByLine(changedTokens);
  // If we appended \n, the split produces an extra empty trailing line group — remove it
  if (!isLastLine && newLineTokens.length > 0 && newLineTokens[newLineTokens.length - 1].length === 0) {
    newLineTokens.pop();
  }

  // Splice into cache: replace old lines [firstChanged..oldEnd] with new
  const oldLineTokens = _lexCache.lineTokens;
  oldLineTokens.splice(firstChanged, oldEnd - firstChanged + 1, ...newLineTokens);
  _lexCache.lines = newLines;

  return _rebuildTokens(oldLineTokens);
}

function _splitTokensByLine(tokens) {
  const lines = [[]];
  for (const t of tokens) {
    if (t.ty === T.EOF) break;
    lines[lines.length - 1].push(t);
    if (t.ty === T.EOL) lines.push([]);
  }
  return lines;
}

function _rebuildTokens(lineTokens) {
  const tokens = [];
  for (const line of lineTokens) {
    for (const t of line) tokens.push(t);
  }
  tokens.push(tok(T.EOF, '', 0, 0));
  return tokens;
}

// Reset incremental cache (e.g., on tab switch)
function _resetLexCache() { _lexCache = null; }

// ═══════════════════════════════════════════════════════════════════
// PIPELINE — full 5-stage Rex parsing
// ═══════════════════════════════════════════════════════════════════

function pipeline(src) {
  const tokens = lexIncremental(src);
  nestjoin(tokens);
  const blocks = bsplit(tokens);
  const joined = quipjoin(blocks);
  return parse(joined);
}

// Cold parse — bypasses incremental cache.
// Used by internal re-parses (expression snippets, template expansion)
// so they don't corrupt the editor's line-level cache.
function pipelineCold(src) {
  const tokens = lex(src);
  nestjoin(tokens);
  const blocks = bsplit(tokens);
  const joined = quipjoin(blocks);
  return parse(joined);
}

function rexParse(src) {
  const nodes = pipeline(src);
  return { nodes, errors: [] };
}

// Internal re-parse for expression snippets — never touches _lexCache
function rexParseCold(src) {
  const nodes = pipelineCold(src);
  return { nodes, errors: [] };
}

// ═══════════════════════════════════════════════════════════════════
// PRINTER — frex (bottom-up annotation) + prex (top-down rendering)
//
// Faithful port of rex.c frex()/prex()/pwrapped().
// Wide threshold = 40. Top-level items indented 4 spaces.
// ═══════════════════════════════════════════════════════════════════

// Heir unwrapping table: hd_type × tl_type → direction char
// Types: 0=Wd, 1=Td, 2=Qp, 3=Ug, 4=Sl, 5=compound
const HEIR_UNWRAP = [
//  w    t    q    u    s    _
  '|', '&', '&', '&', '&', '<',  // w-
  '&', '|', '&', '&', '&', '<',  // t-
  '>', '>', '&', '&', '&', '-',  // q-
  '&', '&', '|', '|', '|', '<',  // u-
  '>', '>', '>', '>', '-', '<',  // s-
  '-', '-', '-', '-', '-', '-',  // _-
];

function heirTypeIdx(n) {
  if (!n) return 5;
  switch (n._) {
  case 'Wd': return 0;
  case 'Td': return 1;
  case 'Qp': return 2;
  case 'Ug': return 3;
  case 'Sl': return 4;
  default:   return 5;
  }
}

function heirUnwrapDir(hd, tl) {
  // C temporarily forces unwrap=true on top head to walk heir chain
  const cache = hd._unwrap;
  hd._unwrap = true;
  let h = hd;
  while (h._unwrap && h._ === 'Hr') h = h.t;
  hd._unwrap = cache;
  const hi = Math.min(heirTypeIdx(h), 5);
  const ti = Math.min(heirTypeIdx(tl), 5);
  return HEIR_UNWRAP[hi * 6 + ti];
}

function trailingNode(x) {
  while (x._unwrap && (x._ === 'Ti' || x._ === 'Hr')) {
    x = x._ === 'Ti' ? x.ch[x.ch.length-1] : x.t;
  }
  return x;
}

function leadingNode(x) {
  while (x._unwrap && (x._ === 'Ti' || x._ === 'Hr')) {
    x = x._ === 'Ti' ? x.ch[0] : x.h;
  }
  return x;
}

function trailingIsRune(x) {
  const t = trailingNode(x);
  return t._unwrap && t._ === 'Qp' && t.v.length > 0 && isRune(t.v[t.v.length-1]);
}

function trailingIsSlug(x) { return trailingNode(x)._ === 'Sl'; }
function trailingIsQuip(x) { return trailingNode(x)._ === 'Qp'; }
function leadingIsTick(x) {
  const l = leadingNode(x);
  return l._unwrap && (l._ === 'Qp' || l._ === 'Sl' || l._ === 'Ug');
}

function uglyDelimWidth(s) {
  let width = 1, count = 0;
  for (const c of s) {
    if (c === "'") { count++; continue; }
    if (count) { width = Math.max(count, width); count = 0; }
  }
  return Math.max(count, width) + 1;
}
function uglyd(s){let m=1;for(const l of s.split('\n')){let c=0;for(const ch of l){if(ch==="'")c++;else break}if(c>m)m=c}return"'".repeat(Math.max(m+1,2))}

// frexNode — bottom-up annotation: sets _wide and _unwrap
function frexNode(n) {
  if (!n || n._frexDone) return;
  n._frexDone = true;
  const _ = n._;

  // Recursively annotate children first
  if (_ === 'Hr') { frexNode(n.h); frexNode(n.t); }
  else if (_ === 'Tp') { frexNode(n.c); }
  else if (_ === 'Ti' || _ === 'Np' || _ === 'Ni') { (n.ch||[]).forEach(frexNode); }
  else if (_ === 'Bk') { (n.ch||[]).forEach(frexNode); }

  switch (_) {
  case 'Np':
  case 'Ni': {
    // C: w = 3 + r->ts (always counts brackets, even CLEAR)
    let w = 3 + (n.r ? n.r.length : 0);
    const ch = n.ch || [];
    for (const s of ch) {
      s._unwrap = true;
      if (s._ === 'Sl') s._unwrap = false;
      const sw = s._wide || 0;
      w += 1 + sw;
      if (!sw) w += 40;
    }
    n._wide = (w > 40) ? 0 : w;
    break;
  }

  case 'Ti': {
    const ch = n.ch || [];
    // C: if (ss < 2) { r->t = PAREN_PREFIX; frex(r); }
    // Mutate to Np(Paren) and re-run frex
    if (ch.length < 2) {
      n._ = 'Np';
      n.b = BK.Paren;
      n._frexDone = false;
      frexNode(n);
      return;
    }
    const or_packed = packRune(n.r);
    let w = 0;
    let next = null;
    for (let i = ch.length - 1; i >= 0; i--) {
      const s = ch[i];
      w += s._wide ? s._wide : 40;
      if (next) w += n.r.length;
      let u = true;
      if (!s._wide) u = false;
      if (s._ === 'Ti' && packRune(s.r) <= or_packed) u = false;
      if (s._ === 'Tp') u = false;
      if (next && trailingIsRune(s)) u = false;
      if (next && trailingIsSlug(s)) u = false;
      if (next && trailingIsQuip(s) && !leadingIsTick(next)) u = false;
      s._unwrap = u;
      if (!u) w += 2;
      next = s;
    }
    n._wide = (w > 40) ? 0 : w;
    break;
  }

  case 'Tp': {
    const wd = n.c._wide || 0;
    n._wide = wd ? wd + n.r.length : 0;
    n.c._unwrap = (n.c._ !== 'Tp');
    break;
  }

  case 'Wd': n._wide = n.v.length; break;
  case 'Td': n._wide = n.v.length; break; // C: r->fmt.wide = r->ts (no escape accounting)
  case 'Qp': n._wide = 0; break; // C: no REX_QUIP case in frex → stays 0
  case 'Sl': n._wide = 0; break;
  case 'Ug': n._wide = 0; break;
  case 'Bd': n._wide = 0; break; // Bad nodes always force multiline
  case 'Bk': n._wide = 0; break;

  case 'Hr': {
    const hd = n.h, tl = n.t;
    const dir = heirUnwrapDir(hd, tl);
    if (dir === '<') hd._unwrap = true;
    else if (dir === '>') tl._unwrap = true;
    else if (dir === '&') { hd._unwrap = true; tl._unwrap = true; }
    else if (dir === '|') { hd._unwrap = true; }
    const hw = hd._wide || 0, tw = tl._wide || 0;
    let wd = 0;
    if (hw && tw) {
      wd = hw + tw;
      if (!hd._unwrap) wd += 2;
      if (!tl._unwrap) wd += 2;
    }
    n._wide = (wd > 40) ? 0 : wd;
    break;
  }
  }
}

function clearFrex(n) {
  if (!n || typeof n !== 'object') return;
  delete n._frexDone; delete n._wide; delete n._unwrap;
  if (n.h) clearFrex(n.h);
  if (n.t) clearFrex(n.t);
  if (n.c) clearFrex(n.c);
  if (n.ch) n.ch.forEach(clearFrex);
}

// pr() — canonical neorex printer
function pr(nd, mw, initialDepth) {
  const unlimited = (mw != null && mw >= 10000);
  if (unlimited) return prWide(nd);

  clearFrex(nd);
  frexNode(nd);
  let out = '';
  let wCol = 0, wDepth = initialDepth || 0;

  function align() { while (wCol < wDepth) { out += ' '; wCol++; } }
  function wchar(c) { align(); out += c; wCol++; }
  function wstr(s) { align(); out += s; wCol += s.length; }
  function wgap() { wchar(' '); }
  function wline() { align(); out += '\n'; wCol = 0; }

  function pwrapped(n) {
    // C: only CLEAR/PAREN PREFIX/INFIX pass through directly to prex
    // BRACK/CURLY go through the default path (may get wrapped)
    if ((n._ === 'Np' || n._ === 'Ni') && (n.b === BK.Clear || n.b === BK.Paren)) {
      prex(n); return;
    }
    if (n._unwrap) { prex(n); return; }
    if (n._wide) {
      wchar('('); prex(n); wchar(')');
    } else {
      wchar('('); wgap(); prex(n); wline(); wchar(')');
    }
  }

  function prex(n) {
    if (!n) return;
    const _ = n._;

    if (_ === 'Hr') {
      const d0 = wDepth;
      wDepth = Math.max(d0, wCol);
      pwrapped(n.h);
      wDepth++;
      pwrapped(n.t);
      wDepth = d0;
      return;
    }

    if (_ === 'Tp') {
      wstr(n.r);
      pwrapped(n.c);
      return;
    }

    if (_ === 'Ti') {
      for (let i = 0; i < n.ch.length; i++) {
        pwrapped(n.ch[i]);
        if (i + 1 < n.ch.length) wstr(n.r);
      }
      return;
    }

    if (_ === 'Np' || _ === 'Ni') {
      prNest(n);
      return;
    }

    if (_ === 'Wd') { wstr(n.v); return; }

    if (_ === 'Bd') {
      // C: REX_BAD → wstr("BAD:") then goto rexstr (trad-style quoting)
      const d0 = wDepth;
      wstr('BAD:');
      wchar('"');
      wDepth = wCol;
      for (const c of n.v) {
        if (c === '"') wstr('""');
        else if (c === '\n') wline();
        else wchar(c);
      }
      wchar('"');
      wDepth = d0;
      return;
    }

    if (_ === 'Qp') {
      const d0 = wDepth;
      wDepth = Math.max(wDepth, wCol);
      if (!n.v.length) { wstr("(')"); } else {
        wchar("'");
        for (let i = 0; i < n.v.length; i++) {
          if (n.v[i] === '\n') wline();
          else wchar(n.v[i]);
        }
      }
      wDepth = d0;
      return;
    }

    if (_ === 'Sl') {
      // C slug printer uses goto-based control flow:
      //   line: if (!remain) { wchar('\''); wline(); return; }
      //         wchar('\''); if (txt[i]!='\n') wchar(' ');
      //         while (remain) { if (txt[i]=='\n') { wline(); i++; remain--; goto line; }
      //                          wchar(txt[i]); i++; remain--; }
      // Falls off end when inner loop exhausts remain without hitting \n.
      const d0 = wDepth;
      wDepth = Math.max(d0, wCol);
      const flat = typeof n.v === 'string' ? n.v : n.v.join('\n');
      let remain = flat.length;
      let idx = 0;
      slugLine: while (true) {
        if (!remain) { wchar("'"); wline(); wDepth = d0; return; }
        wchar("'");
        if (flat[idx] !== '\n') wchar(' ');
        while (remain) {
          if (flat[idx] === '\n') { wline(); idx++; remain--; continue slugLine; }
          wchar(flat[idx]); idx++; remain--;
        }
        // Inner loop exhausted remain without \n — just return
        wDepth = d0; return;
      }
    }

    if (_ === 'Td') {
      const d0 = wDepth;
      wchar('"');
      wDepth = wCol;
      for (const c of n.v) {
        if (c === '"') wstr('""');
        else if (c === '\n') wline();
        else wchar(c);
      }
      wchar('"');
      wDepth = d0;
      return;
    }

    if (_ === 'Ug') {
      const d0 = wDepth;
      wDepth = Math.max(wDepth, wCol);
      const dw = uglyDelimWidth(n.v);
      const delim = "'".repeat(dw);
      wstr(delim); wline();
      for (const c of n.v) {
        if (c === '\n') wline();
        else wchar(c);
      }
      wline(); wstr(delim);
      wDepth = d0;
      return;
    }

    if (_ === 'Bk') {
      for (let i = 0; i < n.ch.length; i++) {
        if (i > 0) wline();
        prex(n.ch[i]);
      }
      return;
    }
  }

  function prNest(n) {
    // C: CLEAR and PAREN both use "()", BRACK uses "[]", CURLY uses "{}"
    // All nest types print with brackets — there is no "hasBrackets=false" in C
    const az = n.b === BK.Brack ? '[]' : n.b === BK.Curly ? '{}' : '()';

    if (n._ === 'Np') {
      let rune = n.r;
      // Backtick suppression — exact C logic:
      // BRACK/CURLY: if (streq(rune, "`")) rune=NULL — always suppress
      // PAREN/CLEAR: if (ss != 1 && streq(rune, "`")) rune=NULL — suppress unless exactly 1 son
      if (n.b === BK.Brack || n.b === BK.Curly) {
        if (rune === '`') rune = null;
      } else {
        if (rune === '`' && n.ch.length !== 1) rune = null;
      }
      if (n._wide) prNestPrefixWide(az, rune, n.ch, true);
      else prNestPrefixTall(az, rune, n.ch, true);
    } else {
      const rune = n.r;
      // C: if (sons == 0) return prefix_wrapped(w, az, rune, sons, ss);
      if (n.ch.length === 0) {
        if (n._wide) prNestPrefixWide(az, rune, n.ch, true);
        else prNestPrefixTall(az, rune, n.ch, true);
      } else if (n._wide) prNestInfixWide(az, rune, n.ch, true);
      else prNestInfixTall(az, rune, n.ch, true);
    }
  }

  function prNestPrefixWide(az, rune, ch, hasBk) {
    // C: prefix_wrapped builds Clem[] = [RUNE, REX, REX, ...] then pwrap_wide
    // pwrap_wide: prints (elem gap elem gap ... elem) — gap only between elements
    if (hasBk) wchar(az[0]);
    if (rune) { wstr(rune); if (ch.length) wgap(); }
    for (let i = 0; i < ch.length; i++) {
      if (i) wgap();
      pwrapped(ch[i]);
    }
    if (hasBk) wchar(az[1]);
  }

  function prNestPrefixTall(az, rune, ch, hasBk) {
    const d0 = wDepth;
    const d1 = wDepth = Math.max(wDepth, wCol);
    if (hasBk) wchar(az[0]);
    if (rune) {
      wstr(rune);
      if (ch.length) wgap();
      wDepth = d1 + rune.length + 2;
    } else {
      wDepth = d1 + 2;
    }
    for (let i = 0; i < ch.length; i++) {
      if (i > 0) wline();
      pwrapped(ch[i]);
    }
    if (hasBk) {
      wDepth = d1; wline(); wchar(az[1]);
    }
    wDepth = d0;
  }

  function prNestInfixWide(az, rune, ch, hasBk) {
    // C interleaving: for each son i:
    //   push REX(son[i])
    //   if (i==0 || i+1<sons) push RUNE(rune)
    // Then pwrap_wide prints: (elem gap elem gap ... elem)
    // Result: rune after first element, between all middle, none after last
    // 1 son: (son rune) → "(3 ,)"
    // 2 sons: (son rune son) → "(a , b)"
    if (hasBk) wchar(az[0]);
    for (let i = 0; i < ch.length; i++) {
      if (i) wgap();
      pwrapped(ch[i]);
      if (i === 0 || i + 1 < ch.length) { wgap(); wstr(rune); }
    }
    if (hasBk) wchar(az[1]);
  }

  function prNestInfixTall(az, rune, ch, hasBk) {
    const d0 = wDepth;
    const d1 = wDepth = Math.max(wDepth, wCol);
    const rsz = rune.length;
    let drune = d1, delem = d1 + rsz + 1;
    if (rsz > 1 && wDepth > rsz + 1) { drune -= rsz - 1; delem -= rsz - 1; }
    if (hasBk) wchar(az[0]);
    for (let i = 0; i < ch.length; i++) {
      if (i) { wDepth = drune; wline(); wstr(rune); }
      wDepth = delem; pwrapped(ch[i]);
    }
    if (ch.length === 1) {
      wDepth = drune; wline(); wstr(rune);
    }
    if (hasBk) {
      wline(); wDepth = d1; wchar(az[1]);
    }
    wDepth = d0;
  }

  prex(nd);
  return out;
}

// prWide — always-inline printer for expression contexts
function prWide(n) {
  if (!n) return '';
  const _ = n._;
  if (_ === 'Wd') return n.v;
  if (_ === 'Bd') { let s='BAD:"'; for (const c of n.v) s += c==='"'?'""':c; return s+'"'; }
  if (_ === 'Qp') return n.v.length ? "'" + n.v : "(')";
  if (_ === 'Td') { let s='"'; for (const c of n.v) s += c==='"'?'""':c; return s+'"'; }
  if (_ === 'Sl') { const ls = typeof n.v==='string'?n.v.split('\n'):n.v; return ls.map(l=>"' "+l).join('\n'); }
  if (_ === 'Ug') { const d=uglyd(n.v); return d+'\n'+n.v+'\n'+d; }
  if (_ === 'Hr') return prWide(n.h)+prWide(n.t);
  if (_ === 'Tp') return n.r+prWide(n.c);
  if (_ === 'Ti') return n.ch.map(prWide).join(n.r);
  if (_ === 'Np') {
    const o=BK_OPEN[n.b]||'', cl=BK_CLOSE[n.b]||'';
    const r=(n.r&&n.r!=='`')?n.r+' ':'';
    return o+r+n.ch.map(prWide).join(' ')+cl;
  }
  if (_ === 'Ni') {
    const o=BK_OPEN[n.b]||'', cl=BK_CLOSE[n.b]||'';
    return o+n.ch.map(prWide).join(' '+n.r+' ')+cl;
  }
  if (_ === 'Bk') return n.ch.map(prWide).join('\n');
  return '';
}

// prNodes — print array of top-level Rex nodes in canonical format
function prNodes(nodes) {
  // C: each block: if elements → print_rex + "\n", then always "\n"
  // null entries represent empty blocks (just "\n")
  let out = '';
  for (const nd of nodes) {
    if (nd === null) {
      out += '\n'; // empty block
    } else {
      out += pr(nd, null, 4) + '\n\n';
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SHRUB VIEW — Profunctor projection from canonical Rex to Shrub
// ═══════════════════════════════════════════════════════════════════

function toShrub(n, d) {
  if (!n || !n._) return [];
  const s = {type:'', name:null, attrs:{}, children:[], content:null, _d:d||0};
  _decompose(n, s, d||0);
  if (!s.type) { s.type = 'expr'; s.name = pr(n, 10000); }
  return [s];
}

// quipjoin wraps top-level expressions as Np(Paren,'`'). Accept both that and Np(Clear,'').
function _isOpenNest(n) {
  return (n.b === BK.Clear && n.r === '') || (n.b === BK.Paren && n.r === '`');
}

function _decompose(n, s, d) {
  switch (n._) {
    case 'Tp':
      if (n.r === '@') { _extractAt(n.c, s, d); }
      else if (n.r === ':') { _extractKV(n.c, s); }
      else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    case 'Ni':
      if (n.r === ':' && n.b === BK.Clear) { _decomposeColon(n, s, d); }
      else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    case 'Np':
      if (n.ch.length > 0 && n.ch[0]._ === 'Tp' && n.ch[0].r === '@' && _isOpenNest(n)) {
        _extractAt(n.ch[0].c, s, d);
        _absorbList(n.ch, 1, s, d);
      } else if (n.ch.length > 0 && n.ch[0]._ === 'Tp' && n.ch[0].r === ':' && _isOpenNest(n)) {
        // :key value wrapped by quipjoin — mark as kv-expr for tree builder
        s.type = 'expr'; s.name = pr(n, 10000); s._kvNode = n;
      } else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    default:
      s.type = 'expr'; s.name = pr(n, 10000);
  }
}

function _decomposeColon(n, s, d) {
  const first = n.ch[0];
  if (first && first._ === 'Tp' && first.r === '@') {
    _extractAt(first.c, s, d);
    _absorbList(n.ch, 1, s, d);
  } else if (first && first._ === 'Np' && _isOpenNest(first) && first.ch.length > 0 && first.ch[0]._ === 'Tp' && first.ch[0].r === '@') {
    _extractAt(first.ch[0].c, s, d);
    _absorbList(first.ch, 1, s, d);
    _absorbList(n.ch, 1, s, d);
  } else {
    s.type = 'expr'; s.name = pr(n, 10000);
  }
}

function _extractAt(c, s, d) {
  if (c._ === 'Wd') { s.type = c.v; }
  else if (c._ === 'Np' && _isOpenNest(c)) {
    if (c.ch.length > 0 && c.ch[0]._ === 'Wd') s.type = c.ch[0].v;
    _absorbList(c.ch, 1, s, d);
  } else if (c._ === 'Ni' && c.r === ':') {
    const f = c.ch[0];
    if (f && f._ === 'Wd') { s.type = f.v; }
    else if (f && f._ === 'Np' && _isOpenNest(f)) {
      if (f.ch.length > 0 && f.ch[0]._ === 'Wd') s.type = f.ch[0].v;
      _absorbList(f.ch, 1, s, d);
    }
    _absorbList(c.ch, 1, s, d);
  } else if (c._ === 'Hr') { s.type = _str(c.h); _absorb(c.t, s, d); }
  else { s.type = _str(c); }
}

function _absorbList(items, start, s, d) {
  for (let i = start; i < items.length; i++) {
    const n = items[i];
    if (n._ === 'Tp' && n.r === ':') {
      const key = _str(n.c);
      if (i + 1 < items.length) {
        const next = items[i + 1];
        if (next._ !== 'Bk' && !(next._ === 'Tp' && (next.r === ':' || next.r === '@'))) {
          s.attrs[key] = _val(next);
          i++;
          continue;
        }
      }
      s.attrs[key] = true;
      continue;
    }
    _absorb(n, s, d);
  }
}

function _absorb(n, s, d) {
  if (!n || !n._) return;
  if (n._ === 'Tp' && n.r === ':') { _extractKV(n.c, s); return; }
  if (n._ === 'Bk') { for (const c of n.ch) s.children.push(...toShrub(c, d+1)); return; }
  if (n._ === 'Ug') { s.content = (s.content||'') + n.v; return; }
  if (n._ === 'Bd') {
    // Poisoned ugly strings from content capture — extract content between '' markers
    const m = n.v.match(/^''+\n([\s\S]*)\n''+$/);
    if (m) { s.content = (s.content||'') + m[1]; return; }
  }
  if (n._ === 'Sl') { s.content = (s.content||'') + n.v.join('\n'); return; }
  if (!s.name && (n._ === 'Wd' || n._ === 'Td' || n._ === 'Qp')) { s.name = n._ === 'Wd' ? n.v : n.v; return; }
  if (!s.name && n._ === 'Ti') { s.name = _str(n); return; }
  if (!s.name && n._ === 'Hr') { s.name = _str(n); return; }
  if (n._ === 'Ni' && n.r === ':') { _absorbList(n.ch, 0, s, d); return; }
  if (n._ === 'Np' && _isOpenNest(n) && n.ch.length > 0) {
    if (n.ch[0]._ === 'Tp' && n.ch[0].r === '@') {
      const child = {type:'',name:null,attrs:{},children:[],content:null,_d:d+1};
      _extractAt(n.ch[0].c, child, d+1);
      _absorbList(n.ch, 1, child, d+1);
      s.children.push(child); return;
    }
  }
  s.children.push(...toShrub(n, d+1));
}

function _extractKV(c, s) {
  if (c._ === 'Wd') { s.attrs[c.v] = true; return; }
  if (c._ === 'Np' && _isOpenNest(c) && c.ch.length >= 1) {
    const key = _str(c.ch[0]);
    s.attrs[key] = c.ch.length >= 2 ? _val(c.ch[1]) : true;
    return;
  }
  s.attrs[_str(c)] = true;
}

function _val(n) {
  if (!n) return undefined;
  if (n._ === 'Wd') { const v=n.v; return v==='true'?true:v==='false'?false:/^-?\d+(\.\d+)?$/.test(v)?+v:v; }
  if (n._ === 'Td') return n.v;
  if (n._ === 'Qp') return n.v;
  if (n._ === 'Sl') return n.v.join('\n');
  if (n._ === 'Ug') return n.v;
  if (n._ === 'Np' && n.b === BK.Brack && (n.r === '' || n.r === '`')) return n.ch.map(_val);
  if (n._ === 'Np' && n.b === BK.Paren) { const inner = pr(n,10000); return {expr:inner.slice(1,-1), rex:n}; }
  if (n._ === 'Tp' && n.r === '-' && n.c._ === 'Wd' && /^\d+(\.\d+)?$/.test(n.c.v)) return -Number(n.c.v);
  if (n._ === 'Ti' && (n.r === '/' || n.r === '.')) { const s2 = pr(n, 10000); return /^-?\d+(\.\d+)?$/.test(s2) ? +s2 : s2; }
  const s = pr(n, 10000);
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  return s;
}

function _str(n) { return !n?'':n._==='Wd'?n.v:n._==='Td'?n.v:n._==='Qp'?n.v:pr(n,10000); }

// ═══════════════════════════════════════════════════════════════════
// INVERSE: Shrub → canonical Rex AST (the backward optic)
// ═══════════════════════════════════════════════════════════════════

function fromShrub(s) {
  if (!s || !s.type) return Word('?');
  if (s.type === 'root') return Block(s.children.map(fromShrub));
  if (s.type === 'expr') return s.name ? Word(s.name) : Word('?');
  const parts = [];
  if (s.name) parts.push(Word(s.name));
  for (const [k, v] of Object.entries(s.attrs)) {
    if (k === '_expr' || k === '_d') continue;
    parts.push(_valToRex(k, v));
  }
  let head;
  const typeWord = Word(s.type);
  if (parts.length > 0) {
    head = TightPre('@', NestPre(BK.Clear, '', [typeWord, ...parts]));
  } else {
    head = TightPre('@', typeWord);
  }
  const blockItems = [];
  for (const child of s.children) blockItems.push(fromShrub(child));
  if (s.content) blockItems.push(Ugly(s.content));
  if (blockItems.length > 0) {
    return NestInf(BK.Clear, ':', [head, Block(blockItems)]);
  }
  return head;
}

function _valToRex(key, val) {
  const keyNode = Word(key);
  const valNode = _valueToRex(val);
  if (valNode === null) return TightPre(':', keyNode);
  return TightPre(':', NestPre(BK.Clear, '', [keyNode, valNode]));
}

function _valueToRex(v) {
  if (v === true) return null;
  if (v === false) return Word('false');
  if (typeof v === 'number') return Word(String(v));
  if (typeof v === 'string') {
    if (/^[\w][\w.-]*$/.test(v)) return Word(v);
    return Trad(v);
  }
  if (Array.isArray(v)) {
    return NestPre(BK.Brack, '', v.map(x => _valueToRex(x) || Word('true')));
  }
  if (v && typeof v === 'object' && v.expr) {
    if (v.rex) return v.rex;
    const {nodes} = rexParseCold(v.expr);
    return nodes.length > 0 ? NestPre(BK.Paren, '', [nodes[0]]) : Word('?');
  }
  return Word(String(v));
}

function printShrub(s, maxWidth) {
  if (s.type === 'root') {
    return s.children.map(c => pr(fromShrub(c), maxWidth)).join('\n');
  }
  return pr(fromShrub(s), maxWidth);
}

// ═══════════════════════════════════════════════════════════════════
// COMPILED EXPRESSION AST
// ═══════════════════════════════════════════════════════════════════

function compileExpr(exprObj) {
  if (exprObj === null || exprObj === undefined) return null;
  if (typeof exprObj === 'number') return { op: 'lit', value: exprObj };
  if (typeof exprObj === 'boolean') return { op: 'lit', value: exprObj };
  if (typeof exprObj === 'string') {
    if (exprObj.startsWith('/')) return { op: 'slot', path: exprObj.slice(1) };
    if (exprObj.startsWith('%')) return { op: 'dep', label: exprObj.slice(1) };
    if (exprObj.startsWith('$')) return { op: 'binding', name: exprObj.slice(1) };
    if (exprObj === 'true') return { op: 'lit', value: true };
    if (exprObj === 'false') return { op: 'lit', value: false };
    if (/^-?\d+(\.\d+)?$/.test(exprObj)) return { op: 'lit', value: +exprObj };
    return { op: 'ident', name: exprObj };
  }
  if (exprObj && typeof exprObj === 'object' && exprObj.expr !== undefined) {
    if (exprObj.rex) return _compileCanonical(exprObj.rex);
    const { nodes } = rexParseCold(exprObj.expr);
    return nodes.length > 0 ? _compileCanonical(NestPre(BK.Paren, '', [nodes[0]])) : null;
  }
  return null;
}

function _compileCanonical(n) {
  if (!n || !n._) return null;
  switch (n._) {
    case 'Wd': {
      const v = n.v;
      if (v === 'true') return { op: 'lit', value: true };
      if (v === 'false') return { op: 'lit', value: false };
      if (/^-?\d+(\.\d+)?$/.test(v)) return { op: 'lit', value: +v };
      if (v.startsWith('/')) return { op: 'slot', path: v.slice(1) };
      if (v.startsWith('%')) return { op: 'dep', label: v.slice(1) };
      if (v.startsWith('$')) return { op: 'binding', name: v.slice(1) };
      return { op: 'ident', name: v };
    }
    case 'Td': return { op: 'lit', value: n.v };
    case 'Qp': return { op: 'lit', value: n.v };
    case 'Tp': {
      if (n.r === '/' || n.r === '%' || n.r === '$') {
        const inner = pr(n, 10000);
        if (n.r === '/') return { op: 'slot', path: inner.slice(1) };
        if (n.r === '%') return { op: 'dep', label: inner.slice(1) };
        return { op: 'binding', name: inner.slice(1) };
      }
      if (n.r === '-' && n.c._ === 'Wd' && /^\d+(\.\d+)?$/.test(n.c.v)) {
        return { op: 'lit', value: -Number(n.c.v) };
      }
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Ti': return { op: 'ident', name: pr(n, 10000) };
    case 'Hr': return { op: 'ident', name: pr(n, 10000) };
    case 'Np': {
      if (n.b === BK.Paren) {
        if (n.ch.length === 0) return null;
        const flatChildren = _flattenNestChildren(n);
        if (flatChildren.length === 0) return null;
        const fnNode = _compileCanonical(flatChildren[0]);
        if (!fnNode) return null;
        const fnName = fnNode.op === 'ident' ? fnNode.name : fnNode.op === 'lit' ? String(fnNode.value) : null;
        if (fnName === 'fold' && flatChildren.length >= 4) {
          return {
            op: 'fold',
            collection: _compileCanonical(flatChildren[1]),
            initial: _compileCanonical(flatChildren[2]),
            body: _compileCanonical(flatChildren[3]),
          };
        }
        const args = flatChildren.slice(1).map(_compileCanonical);
        return { op: 'call', fn: fnName || pr(flatChildren[0], 10000), args };
      }
      if (n.b === BK.Brack) return { op: 'lit', value: n.ch.map(_val) };
      if (n.b === BK.Clear && n.r === '') {
        const flat = _flattenNestChildren(n);
        if (flat.length === 1) return _compileCanonical(flat[0]);
        if (flat.length === 0) return null;
        const fnNode = _compileCanonical(flat[0]);
        const fnName = fnNode && fnNode.op === 'ident' ? fnNode.name : null;
        if (fnName) {
          return { op: 'call', fn: fnName, args: flat.slice(1).map(_compileCanonical) };
        }
        return _compileCanonical(flat[0]);
      }
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Ni': return { op: 'ident', name: pr(n, 10000) };
    default: return null;
  }
}

function _flattenNestChildren(n) {
  const result = [];
  for (const ch of n.ch) {
    if (ch._ === 'Hr') _flattenHeir(ch, result);
    else if (ch._ === 'Np' && ch.b === BK.Clear && ch.r === '') {
      for (const c of ch.ch) {
        if (c._ === 'Hr') _flattenHeir(c, result);
        else result.push(c);
      }
    } else result.push(ch);
  }
  return result;
}

function _flattenHeir(n, out) {
  if (n._ === 'Hr') { _flattenHeir(n.h, out); _flattenHeir(n.t, out); }
  else out.push(n);
}

function collectSlotRefs(compiled, refs) {
  if (!compiled) return;
  if (compiled.op === 'slot') { refs.add(compiled.path); return; }
  if (compiled.op === 'call') { for (const a of compiled.args) collectSlotRefs(a, refs); return; }
  if (compiled.op === 'fold') { collectSlotRefs(compiled.collection, refs); collectSlotRefs(compiled.initial, refs); collectSlotRefs(compiled.body, refs); }
}

function collectDepRefs(compiled, refs) {
  if (!compiled) return;
  if (compiled.op === 'dep' && compiled.label !== 'now' && compiled.label !== 'src') { refs.add(compiled.label); return; }
  if (compiled.op === 'call') { for (const a of compiled.args) collectDepRefs(a, refs); return; }
  if (compiled.op === 'fold') { collectDepRefs(compiled.collection, refs); collectDepRefs(compiled.initial, refs); collectDepRefs(compiled.body, refs); }
}

// ═══════════════════════════════════════════════════════════════════
// SHARED EXPRESSION EVALUATOR
// ═══════════════════════════════════════════════════════════════════

function evalExpr(node, ctx) {
  if (!node) return undefined;
  switch (node.op) {
    case 'lit': return node.value;
    case 'slot': return ctx.resolve('slot', node.path);
    case 'dep': return ctx.resolve('dep', node.label);
    case 'binding': return ctx.resolve('binding', node.name);
    case 'ident': {
      const r = ctx.resolve('ident', node.name);
      if (r !== undefined) return r;
      return node.name;
    }
    case 'call': {
      const fn = node.fn;
      const args = node.args.map(a => evalExpr(a, ctx));
      return _applyStdlib(fn, args, ctx);
    }
    case 'fold': {
      const collPath = evalExpr(node.collection, ctx);
      const initial = evalExpr(node.initial, ctx);
      const items = ctx.resolve('collection', collPath);
      if (!items) return initial;
      let acc = initial;
      for (const [key, item] of items) {
        const foldCtx = _foldContext(ctx, acc, key, item);
        acc = evalExpr(node.body, foldCtx);
      }
      return acc;
    }
  }
  return undefined;
}

function _applyStdlib(fn, args, ctx) {
  switch (fn) {
    case 'add': return args.length > 2 ? args.reduce((a, b) => (+a || 0) + (+b || 0)) : (+args[0] || 0) + (+args[1] || 0);
    case 'sub': return (+args[0] || 0) - (+args[1] || 0);
    case 'mul': return args.length > 2 ? args.reduce((a, b) => (+a || 0) * (+b || 0)) : (+args[0] || 0) * (+args[1] || 0);
    case 'div': { const b = +args[1]; return b ? (+args[0] || 0) / b : 0; }
    case 'mod': { const b = +args[1]; return b ? (+args[0] || 0) % b : 0; }
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
    case 'abs': return Math.abs(+args[0] || 0);
    case 'sign': return Math.sign(+args[0] || 0);
    case 'min': return Math.min(+args[0], +args[1]);
    case 'max': return Math.max(+args[0], +args[1]);
    case 'floor': return Math.floor(+args[0] || 0);
    case 'ceil': return Math.ceil(+args[0] || 0);
    case 'round': return Math.round(+args[0] || 0);
    case 'sqrt': return Math.sqrt(+args[0] || 0);
    case 'pow': return Math.pow(+args[0] || 0, +args[1] || 0);
    case 'log': return Math.log(+args[0] || 0);
    case 'log2': return Math.log2(+args[0] || 0);
    case 'exp': return Math.exp(+args[0] || 0);
    case 'fract': { const v = +args[0] || 0; return v - Math.floor(v); }
    case 'step': return (+args[1] || 0) >= (+args[0] || 0) ? 1 : 0;
    case 'smoothstep': { const e0=+args[0]||0, e1=+args[1]||1, x=+args[2]||0; const t=Math.max(0,Math.min(1,(x-e0)/(e1-e0||1))); return t*t*(3-2*t); }
    case 'clamp': return Math.min(Math.max(+args[0] || 0, +args[1] || 0), +args[2] || 1);
    case 'lerp': case 'mix': { const t = +args[2] || 0; return (+args[0] || 0) * (1 - t) + (+args[1] || 0) * t; }
    case 'pi': return Math.PI;
    case 'tau': return Math.PI * 2;
    case 'band': return (+args[0] || 0) & (+args[1] || 0);
    case 'bor': return (+args[0] || 0) | (+args[1] || 0);
    case 'bxor': return (+args[0] || 0) ^ (+args[1] || 0);
    case 'bnot': return ~(+args[0] || 0);
    case 'shl': return (+args[0] || 0) << (+args[1] || 0);
    case 'shr': return (+args[0] || 0) >> (+args[1] || 0);
    case 'vec2': return [+args[0] || 0, +args[1] || 0];
    case 'vec3': return [+args[0] || 0, +args[1] || 0, +args[2] || 0];
    case 'vec4': return [+args[0] || 0, +args[1] || 0, +args[2] || 0, +args[3] || 0];
    case 'normalize': {
      const v = args[0];
      if (Array.isArray(v)) { const l = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return l ? v.map(x => x / l) : v; }
      return 1;
    }
    case 'concat': return args.map(a => String(a ?? '')).join('');
    case 'fmt': {
      let template = String(args[0] || '');
      for (let i = 1; i < args.length; i++) template = template.replace('{}', String(args[i] ?? ''));
      return template;
    }
    case 'length': return typeof args[0] === 'string' ? args[0].length : Array.isArray(args[0]) ? args[0].length : 0;
    case 'substr': return String(args[0] ?? '').slice(+args[1] || 0, args[2] !== undefined ? +args[2] : undefined);
    case 'upper': return String(args[0] ?? '').toUpperCase();
    case 'lower': return String(args[0] ?? '').toLowerCase();
    case 'trim': return String(args[0] ?? '').trim();
    case 'replace': return String(args[0] ?? '').replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
    case 'split': return String(args[0] ?? '').split(String(args[1] ?? ','));
    case 'join': return Array.isArray(args[0]) ? args[0].join(String(args[1] ?? ',')) : String(args[0] ?? '');
    case 'index': return Array.isArray(args[0]) ? args[0][+args[1] || 0] : typeof args[0] === 'string' ? args[0][+args[1] || 0] : undefined;
    case 'to-num': { const n = +args[0]; return Number.isFinite(n) ? n : +args[1] || 0; }
    case 'to-str': return String(args[0] ?? '');
    case 'has': return args[0] !== undefined && args[0] !== null;
    case 'or-else': return (args[0] !== undefined && args[0] !== null) ? args[0] : args[1];
    case 'if': return args[0] ? args[1] : args[2];
    case 'fold': return args[1] ?? 0;
    default: {
      const r = ctx.resolve('call', fn, args);
      if (r !== undefined) return r;
      return undefined;
    }
  }
}

function _foldContext(parent, acc, key, item) {
  return {
    resolve(op, k, args) {
      if (op === 'binding') {
        if (k === 'acc') return acc;
        if (k === 'key') return key;
        if (k === 'item') return item;
        if (k.startsWith('item.')) {
          const field = k.slice(5);
          if (item instanceof Map) return item.get(field);
          if (item && typeof item === 'object') return item[field];
          return undefined;
        }
      }
      return parent.resolve(op, k, args);
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESSION → WGSL TRANSPILER
// ═══════════════════════════════════════════════════════════════════

// Maps Rex stdlib fn → WGSL expression template
// '%0','%1','%2' = arg placeholders
const _wgslOps = {
  add: '(%0 + %1)', sub: '(%0 - %1)', mul: '(%0 * %1)',
  div: '(%0 / %1)', mod: '(%0 % %1)',
  eq: 'f32(%0 == %1)', neq: 'f32(%0 != %1)',
  gt: 'f32(%0 > %1)', lt: 'f32(%0 < %1)',
  gte: 'f32(%0 >= %1)', lte: 'f32(%0 <= %1)',
  and: 'f32(%0 != 0.0 && %1 != 0.0)', or: 'f32(%0 != 0.0 || %1 != 0.0)',
  not: 'f32(%0 == 0.0)',
  sin: 'sin(%0)', cos: 'cos(%0)', tan: 'tan(%0)',
  asin: 'asin(%0)', acos: 'acos(%0)', atan: 'atan(%0)',
  atan2: 'atan2(%0, %1)',
  abs: 'abs(%0)', sign: 'sign(%0)',
  min: 'min(%0, %1)', max: 'max(%0, %1)',
  floor: 'floor(%0)', ceil: 'ceil(%0)', round: 'round(%0)',
  sqrt: 'sqrt(%0)', pow: 'pow(%0, %1)',
  log: 'log(%0)', log2: 'log2(%0)', exp: 'exp(%0)',
  fract: 'fract(%0)',
  step: 'step(%0, %1)',
  smoothstep: 'smoothstep(%0, %1, %2)',
  clamp: 'clamp(%0, %1, %2)',
  lerp: 'mix(%0, %1, %2)', mix: 'mix(%0, %1, %2)',
  pi: '3.14159265358979',
  tau: '6.28318530717959',
  'if': 'select(%2, %1, %0 != 0.0)',
  'to-num': '%0',
};

function compileExprToWGSL(node, resolve) {
  if (!node) return { wgsl: '0.0', viable: false };
  switch (node.op) {
    case 'lit': {
      if (typeof node.value === 'boolean') return { wgsl: node.value ? '1.0' : '0.0', viable: true };
      if (typeof node.value === 'number') {
        const s = String(node.value);
        return { wgsl: s.includes('.') ? s : s + '.0', viable: true };
      }
      return { wgsl: '0.0', viable: false }; // string/array literals not viable
    }
    case 'slot': {
      const r = resolve ? resolve('slot', node.path) : null;
      if (r) return { wgsl: r, viable: true };
      return { wgsl: '0.0', viable: false };
    }
    case 'ident': {
      const r = resolve ? resolve('ident', node.name) : null;
      if (r) return { wgsl: r, viable: true };
      return { wgsl: '0.0', viable: false };
    }
    case 'dep': {
      const r = resolve ? resolve('dep', node.label) : null;
      if (r) return { wgsl: r, viable: true };
      return { wgsl: '0.0', viable: false };
    }
    case 'call': {
      const tmpl = _wgslOps[node.fn];
      if (!tmpl) return { wgsl: '0.0', viable: false };
      // Zero-arg constants (pi, tau)
      if (!node.args || node.args.length === 0) return { wgsl: tmpl, viable: true };
      const args = node.args.map(a => compileExprToWGSL(a, resolve));
      if (args.some(a => !a.viable)) return { wgsl: '0.0', viable: false };
      let out = tmpl;
      for (let i = 0; i < args.length; i++) out = out.split('%' + i).join(args[i].wgsl);
      return { wgsl: out, viable: true };
    }
    default: return { wgsl: '0.0', viable: false };
  }
}

// ── Extensible content-type set ──
const _contentTypes = new Set(['shader','wgsl','code','kernel','lib','text-editor','filter']);

export const Rex = {
  // ── Canonical Rex ──
  parseCanonical: rexParse,
  pipeline,
  print: pr, printMany: (ns,mw) => ns.map(n=>pr(n,mw)).join('\n'),
  printNodes: prNodes,
  Word, Quip, Trad, Slug, Ugly, Heir, TightPre, TightInf, NestPre, NestInf, Block, BK,
  // ── Compiled expressions ──
  compileExpr, evalExpr, compileExprToWGSL, collectSlotRefs, collectDepRefs,
  // ── Content-type registration ──
  registerContentType(t) { _contentTypes.add(t); },
  unregisterContentType(t) { _contentTypes.delete(t); },
  resetLexCache: _resetLexCache,
  // ── Shrub ↔ Rex roundtrip ──
  fromShrub, printShrub,

  // ── Unified parse: canonical → Shrub view ──
  parse(src) {
    const CT = _contentTypes;
    const lines = src.split('\n'), out = [];
    const lineIndents = [];
    const capturedContent = []; // [{type, name, content}] in source order
    let cap = false, ci = 0, cl = [], capType = '', capName = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], s = raw.trimEnd(), t = s.trimStart(), ind = s.length > 0 ? s.search(/\S/) : 0;
      if (cap) {
        if (s.length > 0 && ind <= ci) {
          capturedContent.push({type: capType, name: capName, content: cl.join('\n')});
          cl=[]; cap=false;
        } else { cl.push(s.length===0 ? '' : raw.slice(Math.min(ind, ci+2))); continue; }
      }
      if (t.startsWith('@')) {
        const m = t.match(/^@(\S+)\s*(\S*)/);
        if (m && CT.has(m[1])) {
          out.push(raw); lineIndents.push(ind);
          cap=true; ci=ind; cl=[]; capType=m[1]; capName=m[2]||''; continue;
        }
      }
      out.push(raw); lineIndents.push(ind);
    }
    if (cap && cl.length) { capturedContent.push({type: capType, name: capName, content: cl.join('\n')}); }

    const stripped = out.map(l => {
      const ci = l.indexOf(';;');
      return ci >= 0 ? l.slice(0, ci) : l;
    });
    const preprocessed = stripped.join('\n');
    const {nodes, errors: parseErrors} = rexParse(preprocessed);
    if (parseErrors.length > 0) {
      console.warn('Rex parse errors:', parseErrors);
    }

    const flatShrubs = [];
    for (const n of nodes) flatShrubs.push(...toShrub(n, 0));

    const nonBlankIndents = lineIndents.filter((_, i) => stripped[i].trim().length > 0);

    for (let i = 0; i < flatShrubs.length; i++) {
      flatShrubs[i]._indent = i < nonBlankIndents.length ? nonBlankIndents[i] : 0;
    }

    const root = {type:'root',name:null,attrs:{},children:[],content:null,_d:-1,_indent:-1};
    const stack = [root];

    for (const shrub of flatShrubs) {
      while (stack.length > 1 && stack[stack.length - 1]._indent >= shrub._indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];

      if (parent !== root && shrub.type === 'expr') {
        const name = shrub.name || '';
        // If _decompose tagged this as a kv-expr with preserved canonical node, absorb it
        // The original (expr) parens are consumed by quipjoin, so we wrap compound values as {expr:...}
        if (shrub._kvNode) {
          const ch = shrub._kvNode.ch;
          for (let ki = 0; ki < ch.length; ki++) {
            const n = ch[ki];
            if (n._ === 'Tp' && n.r === ':') {
              const key = _str(n.c);
              if (ki + 1 < ch.length) {
                const next = ch[ki + 1];
                // Since (expr) parens are consumed by quipjoin, wrap compound values as expr objects
                const valStr = pr(next, 10000);
                parent.attrs[key] = {expr: valStr, rex: next};
                ki++;
              } else {
                parent.attrs[key] = true;
              }
            }
          }
          continue;
        }
        if (name.startsWith(':')) {
          const {nodes: kvNodes} = rexParseCold(name);
          if (kvNodes.length > 0) {
            for (const kvn of kvNodes) {
              if (!kvn) continue;
              if (kvn._ === 'Ni' && kvn.r === ':') {
                _absorbList(kvn.ch, 0, parent, parent._d || 0);
              } else if (kvn._ === 'Np' && _isOpenNest(kvn)) {
                _absorbList(kvn.ch, 0, parent, parent._d || 0);
              } else {
                _absorb(kvn, parent, parent._d || 0);
              }
            }
          }
          continue;
        }
        if (name.startsWith("''") || name.startsWith("' ")) {
          const uglyMatch = name.match(/^''+\n([\s\S]*)\n\s*''+$/);
          if (uglyMatch) {
            let content = uglyMatch[1];
            content = content.replace(/\n\s*''$/, '');
            parent.content = (parent.content || '') + content;
            continue;
          }
          const slugMatch = name.match(/^' (.*)/);
          if (slugMatch) {
            parent.content = (parent.content || '') + slugMatch[1];
            continue;
          }
        }
        if (name.startsWith('"') && name.endsWith('"') && !parent.name) {
          parent.name = name.slice(1, -1);
          continue;
        }
        if (!parent.name && !name.includes(' ') && !name.startsWith('(') && !name.startsWith('/') && !name.startsWith('%') && !name.startsWith('$') && !name.startsWith(':')) {
          parent.name = name;
          continue;
        }
      }

      shrub._d = stack.length - 1;
      parent.children.push(shrub);
      stack.push(shrub);
    }

    const cleanIndent = n => { delete n._indent; for (const c of n.children) cleanIndent(c); };
    cleanIndent(root);

    // Inject captured content into matching content-type nodes
    if (capturedContent.length > 0) {
      const ctNodes = [];
      const collectCT = n => { if (CT.has(n.type)) ctNodes.push(n); for (const c of n.children) collectCT(c); };
      collectCT(root);
      // Match by type+name in source order
      const used = new Set();
      for (const cap of capturedContent) {
        for (let j = 0; j < ctNodes.length; j++) {
          if (used.has(j)) continue;
          if (ctNodes[j].type === cap.type && (ctNodes[j].name === cap.name || (!ctNodes[j].name && !cap.name))) {
            ctNodes[j].content = (ctNodes[j].content || '') + cap.content;
            used.add(j);
            break;
          }
        }
      }
    }

    return root;
  },

  findAll(n,t) { const r=[]; if(n.type===t)r.push(n); for(const c of n.children)r.push(...Rex.findAll(c,t)); return r; },
  find(n,t) { if(n.type===t)return n; for(const c of n.children){const f=Rex.find(c,t);if(f)return f;} return null; },

  // ── Template expansion ──
  expandTemplates(root) {
    const ts = new Map();
    root.children = root.children.filter(ch => { if(ch.type==='template'){ts.set(ch.name,ch);return false} return true; });
    if(!ts.size) return root;
    function ca(a){const o={};for(const[k,v]of Object.entries(a)){if(Array.isArray(v))o[k]=v.map(x=>(x&&typeof x==='object')?{...x}:x);else if(v&&typeof v==='object')o[k]={...v};else o[k]=v}return o}
    function cl(n){return{type:n.type,name:n.name,attrs:ca(n.attrs),children:n.children.map(c=>cl(c)),content:n.content,_d:n._d}}
    const pmKeys=(pm)=>Object.keys(pm).sort((a,b)=>b.length-a.length);
    const RUNTIME_BINDINGS=new Set(['$acc','$item','$key']);
    function sub(s,px,pm){if(typeof s!=='string')return s;for(const k of pmKeys(pm))s=s.replaceAll('$'+k,String(pm[k]));
      return s.replace(/\$(\w[\w.-]*)/g,(m,id)=>RUNTIME_BINDINGS.has(m)||m.startsWith('$item.')?m:px+'_'+id)}
    function coerce(v){if(typeof v==='string'){if(v==='true')return true;if(v==='false')return false;if(/^-?\d+(\.\d+)?$/.test(v))return+v;}return v;}
    function sv(v,px,pm){if(typeof v==='string')return coerce(sub(v,px,pm));if(Array.isArray(v))return v.map(x=>sv(x,px,pm));if(v&&typeof v==='object'&&v.expr){const ne=sub(v.expr,px,pm);const{nodes}=rexParseCold(ne);return{expr:ne,rex:nodes[0]||null}}return v}
    function rw(n,px,pm){if(n.name)n.name=sub(n.name,px,pm);for(const[k,v]of Object.entries(n.attrs))n.attrs[k]=sv(v,px,pm);if(n.content)n.content=sub(n.content,px,pm);for(const c of n.children)rw(c,px,pm)}
    function ex(n,d){if(d>16)return;const out=[];for(const ch of n.children){if(ch.type==='use'){
      const t=ts.get(ch.name);if(!t){out.push(ch);continue}const px=ch.attrs.as||ch.name;const pm={};
      for(const p of t.children.filter(c=>c.type==='param'))pm[p.name]=p.attrs.default!==undefined?p.attrs.default:null;
      for(const[k,v]of Object.entries(ch.attrs))if(k!=='as'&&k in pm)pm[k]=v;
      const bd=t.children.filter(c=>c.type!=='param').map(c=>cl(c));for(const n of bd)rw(n,px,pm);for(const n of bd)ex(n,d+1);out.push(...bd);
    }else{ex(ch,d+1);out.push(ch)}}n.children=out}
    ex(root,0);return root;
  }
};
