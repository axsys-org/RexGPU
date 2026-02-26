// ═══════════════════════════════════════════════════════════════════
// REX PARSER — Canonical port from Rust (github.com/axsys-org/Rex)
// Unified: one parse, one AST, Shrub view as profunctor projection
// ═══════════════════════════════════════════════════════════════════

// ── Rune precedence (loosest → tightest) ─────────────────────────
const RUNE_ORDER = [';',',',':','#','$','`','~','@','?','\\','|','^','&','=','!','<','>','+','-','*','/','%','.'];
const RUNE_SET = new Set(RUNE_ORDER);
const isRune = c => RUNE_SET.has(c);
const isWord = c => /[\w]/.test(c);
function cmpRunes(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const va = i < a.length ? RUNE_ORDER.indexOf(a[i]) : -1;
    const vb = i < b.length ? RUNE_ORDER.indexOf(b[i]) : -1;
    if (va < vb) return -1; if (va > vb) return 1;
  }
  return 0;
}

// ── Brackets ─────────────────────────────────────────────────────
const BK = {Paren:'P',Brack:'B',Curly:'C',Clear:'X'};
const BK_OPEN = {P:'(',B:'[',C:'{',X:null};
const BK_CLOSE = {P:')',B:']',C:'}',X:null};
const BK_FROM = {'(':'P','[':'B','{':'C'};

// ── Lexer ────────────────────────────────────────────────────────
function lex(src) {
  const toks = [], errs = []; let i = 0;
  const n = src.length, c = o => src[i+(o||0)] || '', eat = () => src[i++];
  while (i < n) {
    const ch = c();
    if (ch === '\n') { toks.push({t:'E'}); i++; continue; }
    if (ch === ' ') { let k=0; while(c()===' '){i++;k++} toks.push({t:'W',v:k}); continue; }
    if (ch === '\t') { i++; continue; }
    if (ch === "'" && (c(1)===')' || c(1)===']' || c(1)==='}')) {
      i+=2; let s=''; while(i<n && c()!=='\n') s+=eat(); toks.push({t:'C',v:s.trim()}); continue;
    }
    if (ch === "'" && c(1)==="'") {
      let tc=0,si=i; while(c()==="'"){i++;tc++}
      if (c()==='\n') { i++; const cl="'".repeat(tc); let ct='',found=false;
        while(i<n) { if((ct.endsWith('\n')||ct==='') && src.substring(i,i+tc)==cl) {
          i+=tc; if(ct.endsWith('\n'))ct=ct.slice(0,-1); found=true; break; } ct+=eat(); }
        if(!found) errs.push('unterminated ugly'); toks.push({t:'U',v:ct}); continue;
      } i=si;
    }
    if (ch === "'" && c(1)===' ') { i+=2; let s=''; while(i<n&&c()!=='\n')s+=eat(); toks.push({t:'S',v:s}); continue; }
    if (ch === "'" && i+1<n && !' \n\')])}'.includes(c(1))) {
      i++; let s='',d={p:0,b:0,c:0};
      while(i<n) { const q=c();
        if(q==='('){d.p++;s+=eat()} else if(q==='['){d.b++;s+=eat()} else if(q==='{'){d.c++;s+=eat()}
        else if(q===')'&&d.p>0){d.p--;s+=eat()} else if(q===']'&&d.b>0){d.b--;s+=eat()}
        else if(q==='}'&&d.c>0){d.c--;s+=eat()} else if(' \n\t)]}'.includes(q))break; else s+=eat();
      } toks.push({t:'Q',v:s}); continue;
    }
    if (ch === '"') { i++; let s=''; while(i<n){if(c()==='"'){if(c(1)==='"'){s+='"';i+=2}else{i++;break}}else s+=eat()} toks.push({t:'T',v:s}); continue; }
    if ('([{'.includes(ch)) { toks.push({t:'O',v:ch}); i++; continue; }
    if (')]}'.includes(ch)) { toks.push({t:'K',v:ch}); i++; continue; }
    if (isWord(ch)) { let s=''; while(i<n&&isWord(c()))s+=eat(); toks.push({t:'w',v:s}); continue; }
    if (isRune(ch)) { let s=''; while(i<n&&isRune(c()))s+=eat(); toks.push({t:'r',v:s}); continue; }
    i++;
  }
  return {toks,errs};
}

// ── AST constructors ─────────────────────────────────────────────
const N = (tag,d) => ({_:tag,...d});
const Word = v => N('Wd',{v}), Quip = v => N('Qp',{v}), Trad = v => N('Td',{v});
const Slug = v => N('Sl',{v}), Ugly = v => N('Ug',{v});
const Heir = (h,t) => N('Hr',{h,t}), TightPre = (r,c) => N('Tp',{r,c});
const TightInf = (r,ch) => N('Ti',{r,ch}), Block = ch => N('Bk',{ch});
const NestPre = (b,r,ch) => N('Np',{b,r,ch}), NestInf = (b,r,ch) => N('Ni',{b,r,ch});

// ── Parser ───────────────────────────────────────────────────────
function parse(toks) {
  let p=0; const errs=[], pk=()=>{let j=p;while(j<toks.length&&toks[j].t==='C')j++;return j<toks.length?toks[j]:null};
  const end=()=>!pk(), adv=()=>{while(p<toks.length){const t=toks[p++];if(t.t!=='C')return t}return toks[toks.length-1]};
  const skipE=()=>{while(p<toks.length&&(toks[p].t==='E'||toks[p].t==='C'))p++};
  const skipW=()=>{while(p<toks.length&&'EWC'.includes(toks[p].t))p++};
  const isBlk=()=>p<toks.length&&toks[p].t==='W';

  function top(){const r=[];skipW();while(!end()){const n=expr();if(n)r.push(n);skipW()}return r}
  function expr(){
    const el=spaced(false); if(!el.length)return null;
    if(el[el.length-1].r!==undefined){const s=p;skipE();if(isBlk()){const bc=blk();if(bc.length){el.push({n:Block(bc)});return grp(BK.Clear,el)}}p=s}
    return grp(BK.Clear,el);
  }
  function blk(){const ch=[];const k=pk();if(!k||k.t!=='W')return ch;const bi=k.v;
    while(!end()){const k=pk();if(k&&k.t==='W'&&k.v>=bi)adv();else if(k&&k.t==='E'){adv();continue}else break;
    const n=expr();if(n)ch.push(n);if(pk()?.t==='E')adv()}return ch}
  function spaced(nest){const el=[];while(true){while(p<toks.length&&toks[p].t==='C')p++;if(end())break;
    const k=pk();if(k.t==='E')break;if(k.t==='K'&&nest)break;if(k.t==='K'){errs.push('unexpected ]');adv();continue}
    if(k.t==='W'){adv();continue}el.push(...clump())}return el}
  function clump(){const it=[];while(!end()){const k=pk();if(!k||'EWKC'.includes(k.t))break;it.push(citem())}
    return it.length?tight(it):[]}
  function citem(){const k=pk();
    if(k.t==='w')return{a:Word(adv().v)};if(k.t==='Q')return{a:Quip(adv().v)};
    if(k.t==='T')return{a:Trad(adv().v)};if(k.t==='U')return{a:Ugly(adv().v)};
    if(k.t==='S'){const ln=[];while(pk()?.t==='S'){ln.push(adv().v);if(pk()?.t==='E')adv();
      if(pk()?.t==='W'){const s=p;adv();if(pk()?.t!=='S'){p=s;break}}}return{a:Slug(ln)}}
    if(k.t==='r')return{r:adv().v};
    if(k.t==='O'){const t=adv(),b=BK_FROM[t.v];return{a:nest(b)}}
    adv();return{a:Word('?')}}
  function nest(b){const el=spaced(true);const k=pk();
    if(k&&k.t==='K'){if(k.v!==BK_CLOSE[b])errs.push('mismatch');adv()}else errs.push('unterminated');
    return grp(b,el)}
  return{nodes:top(),errs}}

// ── Tight forms ──────────────────────────────────────────────────
function tight(it){
  if(it.length===1)return it[0].a!==undefined?[{n:it[0].a}]:[{r:it[0].r}];
  if(!it.some(x=>x.r!==undefined))return[{n:heir(it.map(x=>x.a))}];
  let li=-1,lr=null;for(let j=0;j<it.length;j++)if(it[j].r!==undefined&&(lr===null||cmpRunes(it[j].r,lr)<0)){li=j;lr=it[j].r}
  if(li===0)return[{n:TightPre(lr,collapse(tight(it.slice(1))))}];
  if(li===it.length-1){const r=tight(it.slice(0,li));r.push({r:lr});return r}
  const gs=[];let c=[];for(const x of it){if(x.r!==undefined&&x.r===lr){gs.push(c);c=[]}else c.push(x)}gs.push(c);
  return[{n:TightInf(lr,gs.map(g=>collapse(tight(g))))}]}
function heir(a){let r=a[0];for(let j=1;j<a.length;j++)r=Heir(r,a[j]);return r}
function collapse(el){const ns=el.filter(e=>e.n!==undefined).map(e=>e.n);return ns.length===1?ns[0]:ns.length===0?Word('?'):heir(ns)}

// ── Nest grouping ────────────────────────────────────────────────
function grp(b,el){
  if(!el.length)return NestPre(b,'',[]); if(el.length===1){if(el[0].n!==undefined)return b===BK.Clear?el[0].n:NestPre(b,'',[el[0].n]);return NestPre(b,el[0].r,[])}
  if(el[0].r!==undefined){const r=el[0].r,rest=el.slice(1);return rest.some(e=>e.r!==undefined)?NestPre(b,r,[ginf(BK.Clear,rest)]):NestPre(b,r,rest.filter(e=>e.n!==undefined).map(e=>e.n))}
  return el.some(e=>e.r!==undefined)?ginf(b,el):NestPre(b,'',el.filter(e=>e.n!==undefined).map(e=>e.n))}
function ginf(b,el){
  const rs=[];for(let j=0;j<el.length;j++)if(el[j].r!==undefined)rs.push({i:j,r:el[j].r});
  if(!rs.length){const ch=el.filter(e=>e.n!==undefined).map(e=>e.n);return ch.length===1&&b===BK.Clear?ch[0]:NestPre(b,'',ch)}
  let lo=rs[0];for(let j=1;j<rs.length;j++)if(cmpRunes(rs[j].r,lo.r)<0)lo=rs[j];
  const gs=[];let c=[];for(const e of el){if(e.r!==undefined&&e.r===lo.r){gs.push(c);c=[]}else c.push(e)}gs.push(c);
  return NestInf(b,lo.r,gs.map(g=>g.some(e=>e.r!==undefined)?ginf(BK.Clear,g):(()=>{const ns=g.filter(e=>e.n!==undefined).map(e=>e.n);return ns.length===1?ns[0]:ns.length===0?Word('?'):NestPre(BK.Clear,'',ns)})()))}

// ── Printer ──────────────────────────────────────────────────────
const DW=60;
function tall(n){if(!n||!n._)return false;const _=n._;return _==='Sl'||_==='Ug'||_==='Bk'||(_==='Hr'&&(tall(n.h)||tall(n.t)))||(_==='Tp'&&tall(n.c))||('TiNpNi'.includes(_)&&(n.ch||[]).some(tall))}
function ww(n){if(tall(n))return null;const _=n._;
  if(_==='Wd')return n.v.length;if(_==='Qp')return n.v.length?1+n.v.length:3;
  if(_==='Td'){if(n.v.includes('\n'))return null;let l=2;for(const c of n.v)l+=c==='"'?2:1;return l}
  if(_==='Hr'){const a=ww(n.h),b=ww(n.t);return a!==null&&b!==null?a+b:null}
  if(_==='Tp'){const c=ww(n.c);return c!==null?n.r.length+c:null}
  if(_==='Ti'){let t=0;for(const c of n.ch){const w=ww(c);if(w===null)return null;t+=w}return t+n.r.length*(n.ch.length-1)}
  if(_==='Np'){const bks=n.b===BK.Clear?0:2,rw=n.r.length?n.r.length+1:0;let t=0;for(const c of n.ch){const w=ww(c);if(w===null)return null;t+=w}return bks+rw+t+Math.max(0,n.ch.length-1)}
  if(_==='Ni'){const bks=n.b===BK.Clear?0:2;let t=0;for(const c of n.ch){const w=ww(c);if(w===null)return null;t+=w}return bks+t+(n.ch.length>1?(n.ch.length-1)*(n.r.length+2):0)}
  return null}

function pr(nd,mw){mw=mw||DW;let b='';
  function ren(n,i){const w=ww(n);(!tall(n)&&w!==null&&w+i<=mw)?rw(n):rt(n,i)}
  function rw(n){const _=n._;
    if(_==='Wd'){b+=n.v}else if(_==='Qp'){b+=n.v.length?"'"+n.v:"(')"}
    else if(_==='Td'){b+='"';for(const c of n.v)b+=c==='"'?'""':c;b+='"'}
    else if(_==='Sl'){n.v.forEach((l,i)=>{if(i)b+='\n';b+="' "+l})}
    else if(_==='Ug'){const d=uglyd(n.v);b+=d+'\n'+n.v+'\n'+d}
    else if(_==='Hr'){rw(n.h);rw(n.t)}else if(_==='Tp'){b+=n.r;rw(n.c)}
    else if(_==='Ti'){n.ch.forEach((c,i)=>{if(i)b+=n.r;rw(c)})}
    else if(_==='Np'){const o=BK_OPEN[n.b];if(o)b+=o;if(n.r.length){b+=n.r;if(n.ch.length)b+=' '}n.ch.forEach((c,i)=>{if(i)b+=' ';rw(c)});const cl=BK_CLOSE[n.b];if(cl)b+=cl}
    else if(_==='Ni'){const o=BK_OPEN[n.b];if(o)b+=o;n.ch.forEach((c,i)=>{if(i)b+=' '+n.r+' ';rw(c)});const cl=BK_CLOSE[n.b];if(cl)b+=cl}
    else if(_==='Bk'){n.ch.forEach((c,i)=>{if(i)b+='\n';b+='  ';rw(c)})}}
  function rt(n,i){const ii=i+2,_=n._;
    if('WdQpTd'.includes(_)){rw(n)}
    else if(_==='Sl'){n.v.forEach((l,j)=>{if(j){b+='\n';pad(i)}b+="' "+l})}
    else if(_==='Ug'){const d=uglyd(n.v);b+=d+'\n';n.v.split('\n').forEach((l,j)=>{if(j)b+='\n';pad(i);b+=l});b+='\n';pad(i);b+=d}
    else if(_==='Hr'){ren(n.h,i);ren(n.t,i)}else if(_==='Tp'){b+=n.r;ren(n.c,i+n.r.length)}
    else if(_==='Ti'){n.ch.forEach((c,j)=>{if(j)b+=n.r;rw(c)})}
    else if(_==='Np'){const o=BK_OPEN[n.b];if(o)b+=o;if(n.r.length)b+=n.r;if(!n.ch.length){const cl=BK_CLOSE[n.b];if(cl)b+=cl;return}
      n.ch.forEach((c,j)=>{if(j>0||n.r.length||o){b+='\n';pad(ii)}ren(c,ii)});const cl=BK_CLOSE[n.b];if(cl){b+='\n';pad(i);b+=cl}}
    else if(_==='Ni'){const o=BK_OPEN[n.b];if(o)b+=o;if(!n.ch.length){const cl=BK_CLOSE[n.b];if(cl)b+=cl;return}
      if(o){b+='\n';pad(ii)}ren(n.ch[0],ii);for(let j=1;j<n.ch.length;j++){b+='\n';pad(ii);b+=n.r+' ';ren(n.ch[j],ii+n.r.length+1)}
      const cl=BK_CLOSE[n.b];if(cl){b+='\n';pad(i);b+=cl}}
    else if(_==='Bk'){n.ch.forEach((c,j)=>{if(j)b+='\n';pad(ii);ren(c,ii)})}}
  function pad(n){for(let j=0;j<n;j++)b+=' '}
  ren(nd,0);return b}
function uglyd(s){let m=1;for(const l of s.split('\n')){let c=0;for(const ch of l){if(ch==="'")c++;else break}if(c>m)m=c}return"'".repeat(Math.max(m+1,2))}

// ── Canonical API ────────────────────────────────────────────────
function rexParse(src){const{toks,errs:le}=lex(src);const{nodes,errs:pe}=parse(toks);return{nodes,errors:[...le,...pe]}}

// ═══════════════════════════════════════════════════════════════════
// SHRUB VIEW — Profunctor projection from canonical Rex to Shrub
//
// The Shrub shape {type, name, attrs, children, content} is the
// FOCUS of a lens on the canonical AST. The residual (rune types,
// bracket types, tight/nest/block structure) is quantified away.
//
// One function: toShrub(rexNode) → shrub
// Handles ALL canonical node types through a uniform decomposition.
// ═══════════════════════════════════════════════════════════════════

function toShrub(n, d) {
  if (!n || !n._) return [];
  const s = {type:'', name:null, attrs:{}, children:[], content:null, _d:d||0};

  // Decompose: find the @type, attributes, children, content
  _decompose(n, s, d||0);

  // If no type was extracted, treat as expression
  if (!s.type) { s.type = 'expr'; s.name = pr(n, 10000); }
  return [s];
}

function _decompose(n, s, d) {
  switch (n._) {
    case 'Tp': // TightPre: rune + child
      if (n.r === '@') { _extractAt(n.c, s, d); } // @type
      else if (n.r === ':') { _extractKV(n.c, s); } // :key value
      else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    case 'Ni': // NestInf: children separated by rune
      if (n.r === ':' && n.b === BK.Clear) { _decomposeColon(n, s, d); }
      else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    case 'Np': // NestPre: rune + children in bracket
      if (n.r === '' && n.b === BK.Clear && n.ch.length > 0 && n.ch[0]._ === 'Tp' && n.ch[0].r === '@') {
        _extractAt(n.ch[0].c, s, d);
        _absorbList(n.ch, 1, s, d);
      } else { s.type = 'expr'; s.name = pr(n, 10000); }
      break;
    default:
      s.type = 'expr'; s.name = pr(n, 10000);
  }
}

function _decomposeColon(n, s, d) {
  // NestInf with ":" — @type name :key value :key2 value2 (with block)
  const first = n.ch[0];
  if (first && first._ === 'Tp' && first.r === '@') {
    _extractAt(first.c, s, d);
    _absorbList(n.ch, 1, s, d);
  } else if (first && first._ === 'Np' && first.b === BK.Clear && first.r === '' && first.ch.length > 0 && first.ch[0]._ === 'Tp' && first.ch[0].r === '@') {
    _extractAt(first.ch[0].c, s, d);
    _absorbList(first.ch, 1, s, d);
    _absorbList(n.ch, 1, s, d);
  } else {
    s.type = 'expr'; s.name = pr(n, 10000);
  }
}

function _extractAt(c, s, d) {
  // c is what follows @: Word, NestPre(app), NestInf(:), Heir
  if (c._ === 'Wd') { s.type = c.v; }
  else if (c._ === 'Np' && c.b === BK.Clear && c.r === '') {
    if (c.ch.length > 0 && c.ch[0]._ === 'Wd') s.type = c.ch[0].v;
    _absorbList(c.ch, 1, s, d);
  } else if (c._ === 'Ni' && c.r === ':') {
    const f = c.ch[0];
    if (f && f._ === 'Wd') { s.type = f.v; }
    else if (f && f._ === 'Np' && f.r === '' && f.b === BK.Clear) {
      if (f.ch.length > 0 && f.ch[0]._ === 'Wd') s.type = f.ch[0].v;
      _absorbList(f.ch, 1, s, d);
    }
    _absorbList(c.ch, 1, s, d);
  } else if (c._ === 'Hr') { s.type = _str(c.h); _absorb(c.t, s, d); }
  else { s.type = _str(c); }
}

// Process a list of canonical nodes, pairing :key with following value
function _absorbList(items, start, s, d) {
  for (let i = start; i < items.length; i++) {
    const n = items[i];
    if (n._ === 'Tp' && n.r === ':') {
      // :key — look ahead for value
      const key = _str(n.c);
      if (i + 1 < items.length) {
        const next = items[i + 1];
        // Next item is a value (not another :key, not a @type, not a block)
        if (next._ !== 'Bk' && !(next._ === 'Tp' && (next.r === ':' || next.r === '@'))) {
          s.attrs[key] = _val(next);
          i++; // skip the value
          continue;
        }
      }
      s.attrs[key] = true; // bare :key
      continue;
    }
    _absorb(n, s, d);
  }
}

function _absorb(n, s, d) {
  // Absorb a single Rex node into a Shrub: as attr, name, child, or content
  if (!n || !n._) return;
  if (n._ === 'Tp' && n.r === ':') { _extractKV(n.c, s); return; }
  if (n._ === 'Bk') { for (const c of n.ch) s.children.push(...toShrub(c, d+1)); return; }
  if (n._ === 'Ug') { s.content = (s.content||'') + n.v; return; }
  if (n._ === 'Sl') { s.content = (s.content||'') + n.v.join('\n'); return; }
  if (!s.name && (n._ === 'Wd' || n._ === 'Td' || n._ === 'Qp')) { s.name = n._ === 'Wd' ? n.v : n.v; return; }
  if (!s.name && n._ === 'Ti') { s.name = _str(n); return; }
  if (!s.name && n._ === 'Hr') { s.name = _str(n); return; }
  if (n._ === 'Ni' && n.r === ':') { _absorbList(n.ch, 0, s, d); return; }
  if (n._ === 'Np' && n.b === BK.Clear && n.r === '' && n.ch.length > 0) {
    // Inline expression as value — check if first child is @ for nested shrub
    if (n.ch[0]._ === 'Tp' && n.ch[0].r === '@') {
      const child = {type:'',name:null,attrs:{},children:[],content:null,_d:d+1};
      _extractAt(n.ch[0].c, child, d+1);
      _absorbList(n.ch, 1, child, d+1);
      s.children.push(child); return;
    }
  }
  // Fall through: push as child
  s.children.push(...toShrub(n, d+1));
}

function _extractKV(c, s) {
  // :key or :key value (when value is tight with key, e.g. :type=f32)
  if (c._ === 'Wd') { s.attrs[c.v] = true; return; }
  if (c._ === 'Np' && c.r === '' && c.b === BK.Clear && c.ch.length >= 1) {
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
  if (n._ === 'Np' && n.b === BK.Brack && n.r === '') return n.ch.map(_val);
  if (n._ === 'Np' && n.b === BK.Paren) { const inner = pr(n,10000); return {expr:inner.slice(1,-1), rex:n}; }
  // Negative number: TightPre("-", Word("123")) → -123
  if (n._ === 'Tp' && n.r === '-' && n.c._ === 'Wd' && /^\d+(\.\d+)?$/.test(n.c.v)) return -Number(n.c.v);
  // Tight infix with / or . — use printed form to preserve original notation
  // This handles: assets/stone.png, /store/products, a.b.c
  if (n._ === 'Ti' && (n.r === '/' || n.r === '.')) return pr(n, 10000);
  const s = pr(n, 10000);
  // Try numeric conversion on the printed form as fallback
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  return s;
}

function _str(n) { return !n?'':n._==='Wd'?n.v:n._==='Td'?n.v:n._==='Qp'?n.v:pr(n,10000); }

// ═══════════════════════════════════════════════════════════════════
// INVERSE: Shrub → canonical Rex AST (the backward optic)
//
// Reconstructs canonical Rex from the Shrub focus. The residual
// (rune types, bracket choices) is synthesized from convention:
//   type → @type, attrs → :key value, children → block, content → ''
//
// roundtrip: parse(printShrub(shrub)) ≅ shrub
// ═══════════════════════════════════════════════════════════════════

function fromShrub(s) {
  if (!s || !s.type) return Word('?');
  if (s.type === 'root') return Block(s.children.map(fromShrub));
  if (s.type === 'expr') return s.name ? Word(s.name) : Word('?');

  // Build the line: @type name :key value :key2 value2
  const parts = [];

  // Name (if present)
  if (s.name) parts.push(Word(s.name));

  // Attributes as :key value pairs
  for (const [k, v] of Object.entries(s.attrs)) {
    if (k === '_expr' || k === '_d') continue;
    parts.push(_valToRex(k, v));
  }

  // The @type + name + attrs as a single expression
  let head;
  const typeWord = Word(s.type);
  if (parts.length > 0) {
    head = TightPre('@', NestPre(BK.Clear, '', [typeWord, ...parts]));
  } else {
    head = TightPre('@', typeWord);
  }

  // Children and/or content → block
  const blockItems = [];
  for (const child of s.children) {
    blockItems.push(fromShrub(child));
  }
  if (s.content) {
    blockItems.push(Ugly(s.content));
  }

  if (blockItems.length > 0) {
    // head: \n  children → NestInf(Clear, ":", [head, Block(children)])
    return NestInf(BK.Clear, ':', [head, Block(blockItems)]);
  }

  return head;
}

function _valToRex(key, val) {
  // :key value → TightPre(":", NestPre(Clear, "", [Word(key), valNode]))
  const keyNode = Word(key);
  const valNode = _valueToRex(val);
  if (valNode === null) {
    // :key with no value (boolean true)
    return TightPre(':', keyNode);
  }
  return TightPre(':', NestPre(BK.Clear, '', [keyNode, valNode]));
}

function _valueToRex(v) {
  if (v === true) return null; // bare :key
  if (v === false) return Word('false');
  if (typeof v === 'number') return Word(String(v));
  if (typeof v === 'string') {
    // Use Trad for strings with spaces or special chars, Word otherwise
    if (/^[\w][\w.-]*$/.test(v)) return Word(v);
    return Trad(v);
  }
  if (Array.isArray(v)) {
    return NestPre(BK.Brack, '', v.map(x => _valueToRex(x) || Word('true')));
  }
  if (v && typeof v === 'object' && v.expr) {
    // Expression: wrap in parens
    if (v.rex) return v.rex; // canonical AST already available
    const {nodes} = rexParse(v.expr);
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
// EXPORTED Rex OBJECT — Single API for all consumers
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// COMPILED EXPRESSION AST
//
// Walk the canonical Rex AST (the `rex` field on expression objects)
// to produce a flat compiled expression tree. Eliminates per-frame
// string tokenization — expressions are parsed once at compile time.
//
// Node types: call, slot, dep, binding, lit, ident
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
    // Expression object from parser: {expr: "...", rex: canonicalASTNode}
    if (exprObj.rex) return _compileCanonical(exprObj.rex);
    // Fallback: parse the string form
    const { nodes } = rexParse(exprObj.expr);
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
      // Fallback: print and treat as ident
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Ti': {
      // Infix: a/b, a.b — print as string ident
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Hr': {
      // Heir: head tail — treat head as fn, tail as single arg if simple
      // Or print as ident
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Np': {
      if (n.b === BK.Paren) {
        // Parenthesized expression: (fn arg1 arg2 ...)
        if (n.ch.length === 0) return null;
        // The children are space-separated elements inside parens
        // First child is the function name, rest are args
        const flatChildren = _flattenNestChildren(n);
        if (flatChildren.length === 0) return null;
        const fnNode = _compileCanonical(flatChildren[0]);
        if (!fnNode) return null;
        const fnName = fnNode.op === 'ident' ? fnNode.name : fnNode.op === 'lit' ? String(fnNode.value) : null;
        if (fnName === 'fold' && flatChildren.length >= 4) {
          // fold special case: (fold collection initial body)
          // body is NOT eagerly compiled — it's stored as compiled AST for re-evaluation
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
      if (n.b === BK.Brack) {
        // Array literal
        return { op: 'lit', value: n.ch.map(_val) };
      }
      if (n.b === BK.Clear && n.r === '') {
        // Clear group — flatten and compile
        const flat = _flattenNestChildren(n);
        if (flat.length === 1) return _compileCanonical(flat[0]);
        if (flat.length === 0) return null;
        // Multiple items in clear group: first is fn, rest are args
        const fnNode = _compileCanonical(flat[0]);
        const fnName = fnNode && fnNode.op === 'ident' ? fnNode.name : null;
        if (fnName) {
          return { op: 'call', fn: fnName, args: flat.slice(1).map(_compileCanonical) };
        }
        return _compileCanonical(flat[0]);
      }
      return { op: 'ident', name: pr(n, 10000) };
    }
    case 'Ni': {
      // NestInf — not typical in expressions, fallback
      return { op: 'ident', name: pr(n, 10000) };
    }
    default:
      return null;
  }
}

function _flattenNestChildren(n) {
  // Flatten Heir chains and NestPre(Clear) wrappers into flat list
  const result = [];
  for (const ch of n.ch) {
    if (ch._ === 'Hr') {
      _flattenHeir(ch, result);
    } else if (ch._ === 'Np' && ch.b === BK.Clear && ch.r === '') {
      for (const c of ch.ch) {
        if (c._ === 'Hr') _flattenHeir(c, result);
        else result.push(c);
      }
    } else {
      result.push(ch);
    }
  }
  return result;
}

function _flattenHeir(n, out) {
  if (n._ === 'Hr') {
    _flattenHeir(n.h, out);
    _flattenHeir(n.t, out);
  } else {
    out.push(n);
  }
}

// Extract all slot refs (/path) from a compiled expression
function collectSlotRefs(compiled, refs) {
  if (!compiled) return;
  if (compiled.op === 'slot') { refs.add(compiled.path); return; }
  if (compiled.op === 'call') { for (const a of compiled.args) collectSlotRefs(a, refs); return; }
  if (compiled.op === 'fold') { collectSlotRefs(compiled.collection, refs); collectSlotRefs(compiled.initial, refs); collectSlotRefs(compiled.body, refs); }
}

// Extract all dep refs (%label) from a compiled expression
function collectDepRefs(compiled, refs) {
  if (!compiled) return;
  if (compiled.op === 'dep' && compiled.label !== 'now' && compiled.label !== 'src') { refs.add(compiled.label); return; }
  if (compiled.op === 'call') { for (const a of compiled.args) collectDepRefs(a, refs); return; }
  if (compiled.op === 'fold') { collectDepRefs(compiled.collection, refs); collectDepRefs(compiled.initial, refs); collectDepRefs(compiled.body, refs); }
}

// ═══════════════════════════════════════════════════════════════════
// SHARED EXPRESSION EVALUATOR
//
// Evaluates compiled expression AST nodes against a context object.
// All transducers use this single evaluator — no parallel impls.
//
// Context shape:
//   { resolve(op, key) → value }
//
//   resolve is called for: 'slot' (key=path), 'dep' (key=label),
//   'binding' (key=name), 'ident' (key=name), 'form' (key=formKey)
//
//   For 'call', the evaluator handles the standard library internally.
//   Unknown functions are dispatched via resolve('call', name, args).
// ═══════════════════════════════════════════════════════════════════

function evalExpr(node, ctx) {
  if (!node) return undefined;
  switch (node.op) {
    case 'lit': return node.value;
    case 'slot': return ctx.resolve('slot', node.path);
    case 'dep': return ctx.resolve('dep', node.label);
    case 'binding': return ctx.resolve('binding', node.name);
    case 'ident': {
      // Try resolve first — context may know this identifier
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
    // Arithmetic
    case 'add': return args.length > 2 ? args.reduce((a, b) => (+a || 0) + (+b || 0)) : (+args[0] || 0) + (+args[1] || 0);
    case 'sub': return (+args[0] || 0) - (+args[1] || 0);
    case 'mul': return args.length > 2 ? args.reduce((a, b) => (+a || 0) * (+b || 0)) : (+args[0] || 0) * (+args[1] || 0);
    case 'div': { const b = +args[1]; return b ? (+args[0] || 0) / b : 0; }
    case 'mod': { const b = +args[1]; return b ? (+args[0] || 0) % b : 0; }
    // Comparison
    case 'eq': return args[0] === args[1] || String(args[0]) === String(args[1]);
    case 'neq': return args[0] !== args[1] && String(args[0]) !== String(args[1]);
    case 'gt': return +args[0] > +args[1];
    case 'lt': return +args[0] < +args[1];
    case 'gte': return +args[0] >= +args[1];
    case 'lte': return +args[0] <= +args[1];
    // Logic
    case 'and': return !!args[0] && !!args[1];
    case 'or': return !!args[0] || !!args[1];
    case 'not': return !args[0];
    // Math
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
    // Constants
    case 'pi': return Math.PI;
    case 'tau': return Math.PI * 2;
    // Bitwise
    case 'band': return (+args[0] || 0) & (+args[1] || 0);
    case 'bor': return (+args[0] || 0) | (+args[1] || 0);
    case 'bxor': return (+args[0] || 0) ^ (+args[1] || 0);
    case 'bnot': return ~(+args[0] || 0);
    case 'shl': return (+args[0] || 0) << (+args[1] || 0);
    case 'shr': return (+args[0] || 0) >> (+args[1] || 0);
    // Vector construction
    case 'vec2': return [+args[0] || 0, +args[1] || 0];
    case 'vec3': return [+args[0] || 0, +args[1] || 0, +args[2] || 0];
    case 'vec4': return [+args[0] || 0, +args[1] || 0, +args[2] || 0, +args[3] || 0];
    case 'normalize': {
      const v = args[0];
      if (Array.isArray(v)) { const l = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return l ? v.map(x => x / l) : v; }
      return 1;
    }
    // String
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
    // Null / control flow
    case 'has': return args[0] !== undefined && args[0] !== null;
    case 'or-else': return (args[0] !== undefined && args[0] !== null) ? args[0] : args[1];
    case 'if': return args[0] ? args[1] : args[2];
    // fold reached via non-AST path — should not happen with compiled AST
    case 'fold': return args[1] ?? 0;
    default: {
      // Dispatch to context for user-defined fns (@def) or builtin refs
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

// ── Extensible content-type set (controls which @types capture indented content as raw text) ──
const _contentTypes = new Set(['shader','wgsl','code','kernel','lib','text-editor']);

export const Rex = {
  // ── Canonical Rex ──
  parseCanonical: rexParse,
  print: pr, printMany: (ns,mw) => ns.map(n=>pr(n,mw)).join('\n'),
  Word, Quip, Trad, Slug, Ugly, Heir, TightPre, TightInf, NestPre, NestInf, Block, BK,
  // ── Compiled expressions ──
  compileExpr, evalExpr, collectSlotRefs, collectDepRefs,
  // ── Content-type registration ──
  registerContentType(t) { _contentTypes.add(t); },
  unregisterContentType(t) { _contentTypes.delete(t); },
  // ── Shrub ↔ Rex roundtrip ──
  fromShrub, printShrub,

  // ── Unified parse: canonical → Shrub view ──
  parse(src) {
    // Preprocess: wrap bare content under registered content-type @nodes in '' delimiters
    const CT = _contentTypes;
    const lines = src.split('\n'), out = [];
    // Track indentation of each source line for post-parse nesting
    const lineIndents = [];
    let cap = false, ci = 0, cl = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], s = raw.trimEnd(), t = s.trimStart(), ind = s.length > 0 ? s.search(/\S/) : 0;
      if (cap) {
        if (s.length > 0 && ind <= ci) {
          const pad = ci + 2; out.push(' '.repeat(pad)+"''"); lineIndents.push(pad);
          for (const l of cl) { out.push(' '.repeat(pad)+l); lineIndents.push(pad); }
          out.push(' '.repeat(pad)+"''"); lineIndents.push(pad); cl=[]; cap=false;
        } else { cl.push(s.length===0 ? '' : raw.slice(Math.min(ind, ci+2))); continue; }
      }
      if (t.startsWith('@')) {
        const m = t.match(/^@(\S+)/);
        if (m && CT.has(m[1])) {
          out.push(raw); lineIndents.push(ind);
          // Always capture indented content under content-type nodes
          // WGSL has @vertex, @group etc. that look like Rex @ nodes but aren't
          cap=true; ci=ind; cl=[]; continue;
        }
      }
      out.push(raw); lineIndents.push(ind);
    }
    if (cap && cl.length) { const pad=ci+2; out.push(' '.repeat(pad)+"''"); lineIndents.push(pad); for(const l of cl){out.push(' '.repeat(pad)+l);lineIndents.push(pad);} out.push(' '.repeat(pad)+"''"); lineIndents.push(pad); }

    // Strip ;; line comments before canonical parse (canonical Rex uses ') '] '} for comments)
    const preprocessed = out.map(l => {
      const ci = l.indexOf(';;');
      return ci >= 0 ? l.slice(0, ci) : l;
    }).join('\n');
    const {nodes, errors: parseErrors} = rexParse(preprocessed);
    // Surface parse errors (don't swallow them)
    if (parseErrors.length > 0) {
      console.warn('Rex parse errors:', parseErrors);
    }

    // Convert canonical nodes to flat Shrub nodes
    const flatShrubs = [];
    for (const n of nodes) flatShrubs.push(...toShrub(n, 0));

    // Compute indentation for each Shrub node by scanning preprocessed source
    // Each canonical node corresponds to a non-blank line in the source
    const ppLines = preprocessed.split('\n');
    const nonBlankIndents = [];
    for (let i = 0; i < ppLines.length; i++) {
      const s = ppLines[i].trimEnd();
      if (s.length > 0) nonBlankIndents.push(s.search(/\S/));
    }

    // Assign indentation to each flat Shrub — map by order
    // The canonical parser produces one node per non-blank source "expression"
    // which may span multiple lines. Indentation = first line of that expression.
    for (let i = 0; i < flatShrubs.length; i++) {
      flatShrubs[i]._indent = i < nonBlankIndents.length ? nonBlankIndents[i] : 0;
    }

    // Build tree from flat list using indentation stack
    const root = {type:'root',name:null,attrs:{},children:[],content:null,_d:-1,_indent:-1};
    const stack = [root];

    for (const shrub of flatShrubs) {
      // Pop stack until we find a parent with lower indentation
      while (stack.length > 1 && stack[stack.length - 1]._indent >= shrub._indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];

      // Decide: absorb as attr/name/content on parent, or push as child
      if (parent !== root && shrub.type === 'expr') {
        // Bare :key value or content that should be absorbed into parent
        const name = shrub.name || '';
        if (name.startsWith(':')) {
          // Indented :key value line → re-parse as Rex and absorb into parent
          const {nodes: kvNodes} = rexParse(name);
          if (kvNodes.length > 0) {
            // Use _absorbList to properly decompose :key value pairs
            // The parsed node might be NestInf(":") or NestPre(Clear) wrapping :key value
            for (const kvn of kvNodes) {
              if (kvn._ === 'Ni' && kvn.r === ':') {
                _absorbList(kvn.ch, 0, parent, parent._d || 0);
              } else if (kvn._ === 'Np' && kvn.b === BK.Clear && kvn.r === '') {
                _absorbList(kvn.ch, 0, parent, parent._d || 0);
              } else {
                _absorb(kvn, parent, parent._d || 0);
              }
            }
          }
          continue; // absorbed, don't push as child
        }
        // Ugly string content → absorb as content on parent
        if (name.startsWith("''") || name.startsWith("' ")) {
          // Extract content between outer '' delimiters (greedy to handle nested '')
          const uglyMatch = name.match(/^''+\n([\s\S]*)\n\s*''+$/);
          if (uglyMatch) {
            // Clean up: the content may have trailing '' from preprocessor wrapping
            let content = uglyMatch[1];
            // Remove trailing '' line if it was from the preprocessor
            content = content.replace(/\n\s*''$/, '');
            parent.content = (parent.content || '') + content;
            continue;
          }
          // Single-line slug
          const slugMatch = name.match(/^' (.*)/);
          if (slugMatch) {
            parent.content = (parent.content || '') + slugMatch[1];
            continue;
          }
        }
        // Trad string → absorb as name on parent
        if (name.startsWith('"') && name.endsWith('"') && !parent.name) {
          parent.name = name.slice(1, -1);
          continue;
        }
        // Word or hyphenated word → absorb as name on parent if parent has no name
        if (!parent.name && !name.includes(' ') && !name.startsWith('(') && !name.startsWith('/') && !name.startsWith('%') && !name.startsWith('$') && !name.startsWith(':')) {
          parent.name = name;
          continue;
        }
      }

      shrub._d = stack.length - 1;
      parent.children.push(shrub);
      stack.push(shrub);
    }

    // Clean up _indent from all nodes
    const cleanIndent = n => { delete n._indent; for (const c of n.children) cleanIndent(c); };
    cleanIndent(root);

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
    // Sort param keys longest-first to avoid $x matching before $x-offset
    const pmKeys=(pm)=>Object.keys(pm).sort((a,b)=>b.length-a.length);
    const RUNTIME_BINDINGS=new Set(['$acc','$item','$key']);
    function sub(s,px,pm){if(typeof s!=='string')return s;for(const k of pmKeys(pm))s=s.replaceAll('$'+k,String(pm[k]));
      // Replace remaining $ with prefix, but preserve runtime bindings ($acc, $item, $key, $item.field)
      return s.replace(/\$(\w[\w.-]*)/g,(m,id)=>RUNTIME_BINDINGS.has(m)||m.startsWith('$item.')?m:px+'_'+id)}
    function coerce(v){if(typeof v==='string'){if(v==='true')return true;if(v==='false')return false;if(/^-?\d+(\.\d+)?$/.test(v))return+v;}return v;}
    function sv(v,px,pm){if(typeof v==='string')return coerce(sub(v,px,pm));if(Array.isArray(v))return v.map(x=>sv(x,px,pm));if(v&&typeof v==='object'&&v.expr){const ne=sub(v.expr,px,pm);const{nodes}=rexParse(ne);return{expr:ne,rex:nodes[0]||null}}return v}
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
