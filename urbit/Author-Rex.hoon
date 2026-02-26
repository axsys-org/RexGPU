::  Author-Rex.hoon
::  Rex-native author agent — forge-rex + seam-rex + PCN/behaviour integration.
::
::  OVERVIEW
::  ════════
::  This file provides the three cores that replace their XML counterparts:
::
::    seam-rex    ← seam        (parse SSE stream for Rex blocks instead of XML)
::    forge-rex   ← forge       (compile rex-shrub → Hoon AST instead of manx)
::    pcn-wire    ← (new)       (PCN/ShrubLM feedback: synthesized guards → Rex REPLACE edits)
::
::  The outer agent shell (take/hear/handle-input/handle-kook/handle-response
::  handle-chunk/forge-cards/orc/read-kid/put-kid) is UNCHANGED from Author.rtf.
::  Only these three cores swap in.
::
::  HOW THE PIPELINE CHANGES
::  ════════════════════════
::  XML path:
::    SSE stream → parse-sse → buf tape → extract-elements → de-xml → (list manx)
::    → forge.run(list manx) → forge-cards → kook vase at /shrub/NAME/kook/ID
::    → LLM sees: /shrub/NAME/xml/SUB (stored manx rendered back to XML)
::
::  Rex path:
::    SSE stream → parse-sse → buf tape → scan-rex-top-blocks → (list cord)
::    (each cord = one complete top-level Rex block)
::    → JS: Rex.parse(cord) → Rex.toShrub() → JSON → sent as SSE lines:
::         data: {"rex_shrub": <shrub-json>, "rex_src": "<raw-block-cord>"}
::    → Hoon: parse-rex-chunks extracts [(list [cord json]) tape]
::            each pair = (rex_src cord, rex_shrub json)
::    → decode-rex.decode-shrub(json, src) → rex-shrub noun (src stored in .src)
::    → forge-rex.run-rex(list rex-shrub) → forge-cards-rex → kook vase
::    → LLM sees: /shrub/NAME/rex/SUB (stored src.nod cord, raw Rex source)
::
::  PCN/ShrubLM feedback loop:
::    behaviour.onTalkFired → pcn.bridgeBehaviourEvent → ShrubLM.observe
::    → crystallization → synthesizeGuard → Rex guard string
::    → pcn.onCrystallize fires → _amendSource(rule) in main.js
::    → injects @guard into editor source and re-parses
::    → when LLM is asked to edit, it receives /shrub/NAME/rex/SUB as Rex
::    → it emits a REPLACE block with updated @guard — same edit protocol
::
::  WHAT @channel AND PCN BLOCKS DO NOT NEED from forge-rex
::  ════════════════════════════════════════════════════════
::  @channel blocks are compiled entirely in JS (rex-behaviour._compileChannels).
::  They are not kooks — they are JS-side push registrations (behaviour → GPU heap).
::  The forge-rex core ignores them (same as the XML forge ignored them).
::
::  @shrub schema blocks are also JS-side only (_compileShrub in rex-behaviour).
::  The forge-rex core compiles behavioural kooks only: @talk @dep @derive @def.
::
::  PCN @shrub registration (pcn.registerShrubAgent, pcn.registerShrubSchema)
::  is wired in main.js after behaviour.transduce() — no Hoon involvement.
::
::  The only PCN/Hoon interaction is the synthesized guard feedback:
::  ShrubLM.synthesizeGuard() emits a Rex expression cord.
::  _amendSource() in main.js patches the editor source.
::  The patched source is re-parsed and re-compiled.
::  No extra Hoon arms needed — the existing forge-rex-talk handles @guard children.
::
::  TYPE DEFINITIONS
::  ═════════════════
::  rex-node: compiled expression AST from JS Rex.compileExpr()
::    {op:'lit', value:*}
::    {op:'slot', path:cord}        -- /path → own saga
::    {op:'dep', label:cord}        -- %label → dep lookup
::    {op:'binding', name:cord}     -- $item $key $acc $ARG
::    {op:'ident', name:cord}       -- bare name/fn ref
::    {op:'call', fn:cord, args:[]} -- (fn arg...)
::    {op:'fold', collection, initial, body}
::
::  rex-shrub: Shrub node from JS Rex.toShrub()
::    {type:cord, name:(unit cord), attrs:(map cord *),
::     children:(list rex-shrub), content:(unit cord), src=cord}
::  src is the raw Rex block cord. Populated for top-level blocks from rex_src
::  in the JS bridge envelope. Children have src=''. Stored at /shrub/NAME/rex/SUB.
::
::  forge-result: output of run-rex
::    [%kook shrub=cord spec=spec:n sub=cord hon=hoon src=cord]
::    [%def name=cord hon=hoon]
::    [%dep shrub=cord name=cord path=cord]

|%

::  ════════════════════════════════════════════════════════════════════════
::  seam-rex — streaming Rex block extractor + SSE rex_shrub JSON parser
::  ════════════════════════════════════════════════════════════════════════

++  seam-rex
  |%

  ::  Top-level @block type names we care about
  ++  known-types
    ^-  (set cord)
    (silt `(list cord)`~['shrub' 'talk' 'derive' 'dep' 'def' 'channel'])

  ::  parse-sse: extract text content from SSE data lines (unchanged from seam)
  ++  parse-sse
    |=  raw=cord
    ^-  cord
    %-  crip
    %-  zing
    %+  murn  (to-wain:format raw)
    |=  line=cord
    ^-  (unit tape)
    =/  t=tape  (trip line)
    ?.  =("data: " (scag 6 t))  ~
    =/  json-str=cord  (crip (slag 6 t))
    ?:  =('[DONE]' json-str)  ~
    =/  jon=(unit json)  (de:json:html json-str)
    ?~  jon  ~
    =/  chk=chunk:ai  (chunk:dejs:ai u.jon)
    ?:  =(content.chk '')  ~
    `(trip content.chk)

  ::  split-lines: tape → (list tape)
  ++  split-lines
    |=  buf=tape
    ^-  (list tape)
    =|  acc=(list tape)
    =|  cur=tape
    |-  ^-  (list tape)
    ?~  buf  (flop ?~(cur acc [(flop cur) acc]))
    ?:  =('\0a' i.buf)
      $(buf t.buf, acc [(flop cur) acc], cur ~)
    $(buf t.buf, cur [i.buf cur])

  ::  top-level-type: if line starts a top-level @block, return (unit cord) of type
  ++  top-level-type
    |=  line=tape
    ^-  (unit cord)
    ?.  ?&  (gte (lent line) 2)  =('@' i.line)  ==
      ~
    =/  rest=tape  t.line
    =/  end=@ud
      |-  ^-  @ud
      ?:  =(end (lent rest))  end
      =/  ch  (snag end rest)
      ?:  ?|  =(ch ' ')  =(ch '\0a')  =(ch '\09')  ==
        end
      $(end +(end))
    =/  word=cord  (crip (scag end rest))
    ?.  (~(has in known-types) word)  ~
    `word

  ::  scan-rex-top-blocks: buf → [(list cord) tape]
  ::
  ::  Scans the tape buffer for complete top-level @blocks.
  ::  A block is "complete" when a new top-level @keyword appears after it,
  ::  or when the stream ends with a blank line after content.
  ::  Returns completed block cords and the leftover incomplete block as remainder.
  ::
  ::  This is the Hoon-side block extractor. In the full pipeline, completed
  ::  blocks are sent to the JS bridge for Rex.parse() + toShrub(), and the
  ::  resulting rex_shrub JSON objects come back as SSE lines parsed by
  ::  parse-rex-chunks below.
  ++  scan-rex-top-blocks
    |=  buf=tape
    ^-  [(list cord) tape]
    =/  lines=(list tape)  (split-lines buf)
    =|  blocks=(list cord)
    =|  cur=(list tape)
    =|  in-block=?
    |-  ^-  [(list cord) tape]
    ?~  lines
      :-  (flop blocks)
      ?~  cur  ~
      (trip (crip (zing (turn (flop cur) |=(l=tape (snoc l '\0a'))))))
    =/  line=tape  i.lines
    ?~  typ=(top-level-type line)
      ::  continuation line
      ?:  in-block
        $(lines t.lines, cur [line cur])
      $(lines t.lines)
    ::  new top-level @block
    ?:  in-block
      ::  seal off previous block
      =/  block-cord=cord
        (crip (zing (turn (flop cur) |=(l=tape (snoc l '\0a')))))
      $(lines t.lines, blocks [block-cord blocks], cur [line ~], in-block &)
    $(lines t.lines, cur [line ~], in-block &)

  ::  parse-rex-chunks: extract rex_shrub JSON objects from SSE stream.
  ::
  ::  The JS bridge emits special SSE lines alongside LLM text:
  ::    data: {"rex_shrub": <shrub-json>}
  ::  when it receives a completed top-level block cord and parses it.
  ::  This arm collects those JSON objects for decode-rex.
  ::
  ::  Returns: [(list json) tape]  (completed rex_shrubs, remainder tape)
  ++  parse-rex-chunks
    ::  Returns (list [rex_src=cord shrub-json=json]) pairs.
    ::  The JS bridge emits: data: {"rex_shrub": <shrub>, "rex_src": "<cord>"}
    ::  rex_src is the raw Rex block cord for storage at /shrub/NAME/rex/SUB.
    |=  buf=tape
    ^-  [(list [cord json]) tape]
    =|  acc=(list [cord json])
    =|  rem=tape
    =/  lines=(list tape)  (split-lines buf)
    |-  ^-  [(list [cord json]) tape]
    ?~  lines
      [(flop acc) rem]
    =/  line=tape  i.lines
    ?.  =("data: " (scag 6 line))
      $(lines t.lines)
    =/  json-str=cord  (crip (slag 6 line))
    ?:  =('[DONE]' json-str)
      $(lines t.lines)
    =/  jon=(unit json)  (de:json:html json-str)
    ?~  jon
      $(lines t.lines)
    ?.  ?=([%o *] u.jon)
      $(lines t.lines)
    ?~  shrub-val=(~(get by p.u.jon) 'rex_shrub')
      $(lines t.lines)
    =/  src-cord=cord
      ?~  src-val=(~(get by p.u.jon) 'rex_src')  ''
      ?.  ?=([%s *] u.src-val)  ''
      p.u.src-val
    $(lines t.lines, acc [[src-cord u.shrub-val] acc])

  --  :: seam-rex

::  ════════════════════════════════════════════════════════════════════════
::  decode-rex — JSON → rex-shrub / rex-node nouns
::  Decodes the JSON produced by the JS bridge from Rex.toShrub() output
::  ════════════════════════════════════════════════════════════════════════

++  decode-rex
  |%

  +$  rex-node
    $%  [%lit value=*]
        [%slot path=cord]
        [%dep label=cord]
        [%binding name=cord]
        [%ident name=cord]
        [%call fn=cord args=(list rex-node)]
        [%fold collection=rex-node initial=rex-node body=rex-node]
    ==

  +$  rex-shrub
    $:  type=cord
        name=(unit cord)
        attrs=(map cord *)
        children=(list rex-shrub)
        content=(unit cord)
        src=cord
    ==

  ++  decode-node
    |=  j=json
    ^-  rex-node
    ?.  ?=([%o *] j)  [%ident '']
    =/  op  (so (need (~(get by p.j) 'op')))
    ?+  op  [%ident op]
        %lit
      =/  v  (~(got by p.j) 'value')
      ?+  v  [%lit (so v)]
        [%b *]  [%lit p.v]
        [%n *]  [%lit (rash p.v dem)]
      ==
        %slot
      [%slot (so (~(got by p.j) 'path'))]
        %dep
      [%dep (so (~(got by p.j) 'label'))]
        %binding
      [%binding (so (~(got by p.j) 'name'))]
        %ident
      [%ident (so (~(got by p.j) 'name'))]
        %call
      =/  fn   (so (~(got by p.j) 'fn'))
      =/  args-j  (~(got by p.j) 'args')
      =/  args=(list rex-node)
        ?.  ?=([%a *] args-j)  ~
        (turn p.args-j decode-node)
      [%call fn args]
        %fold
      [%fold
        (decode-node (~(got by p.j) 'collection'))
        (decode-node (~(got by p.j) 'initial'))
        (decode-node (~(got by p.j) 'body'))
      ]
    ==
  where
    so  =|  j=json  |.(so:dejs:format j)

  ::  decode-shrub: JSON → rex-shrub
  ::  src is the raw Rex source cord for the top-level block.
  ::  Children are decoded recursively with src='' (sub-nodes, not top-level).
  ++  decode-shrub
    |=  [j=json src=cord]
    ^-  rex-shrub
    ?.  ?=([%o *] j)  ['' ~ ~ ~ ~ '']
    =/  typ=cord
      ?~  v=(~(get by p.j) 'type')  ''
      (so:dejs:format u.v)
    =/  nam=(unit cord)
      ?~  v=(~(get by p.j) 'name')  ~
      ?.  ?=([%s *] u.v)  ~
      ?:  =('' p.u.v)  ~
      `p.u.v
    =/  attrs=(map cord *)
      ?~  v=(~(get by p.j) 'attrs')  ~
      ?.  ?=([%o *] u.v)  ~
      %-  ~(gas by *(map cord *))
      %+  turn  ~(tap by p.u.v)
      |=  [k=cord jv=json]
      ^-  [cord *]
      :-  k
      ?+  jv  (so:dejs:format jv)
        [%b *]  p.jv
        [%n *]  (rash p.jv dem)
        [%~ ~]  ''
      ==
    =/  kids=(list rex-shrub)
      ?~  v=(~(get by p.j) 'children')  ~
      ?.  ?=([%a *] u.v)  ~
      (turn p.u.v |=(c=json (decode-shrub c '')))
    =/  ctn=(unit cord)
      ?~  v=(~(get by p.j) 'content')  ~
      ?.  ?=([%s *] u.v)  ~
      ?:  =('' p.u.v)  ~
      `p.u.v
    [typ nam attrs kids ctn src]

  ++  get-attr
    |=  [s=rex-shrub k=cord]
    ^-  (unit cord)
    ?~  v=(~(get by attrs.s) k)  ~
    ?@  v  `;;(cord v)
    ~

  ++  get-attr-cord
    |=  [s=rex-shrub k=cord fb=cord]
    ^-  cord
    (fall (get-attr s k) fb)

  ++  kids-of
    |=  [s=rex-shrub t=cord]
    ^-  (list rex-shrub)
    (skim children.s |=(c=rex-shrub =(type.c t)))

  ++  find-kid
    |=  [s=rex-shrub t=cord]
    ^-  (unit rex-shrub)
    ?~  found=(skim children.s |=(c=rex-shrub =(type.c t)))  ~
    `i.found

  --  :: decode-rex

::  ════════════════════════════════════════════════════════════════════════
::  forge-rex — rex-shrub → Hoon AST
::
::  Produces identical Hoon AST to the original XML forge.
::  The structural helpers (wrap-gate, wrap-form, append-card, etc.) are
::  verbatim copies — they know nothing about whether input came from XML or Rex.
::  Only the expression builders and the forge-* entry arms change.
::  ════════════════════════════════════════════════════════════════════════

++  forge-rex
  |%

  +$  rex-node   rex-node:decode-rex
  +$  rex-shrub  rex-shrub:decode-rex

  +$  forge-result
    $%  [%kook shrub=cord spec=spec:n sub=cord hon=hoon src=cord]
        [%def name=cord hon=hoon]
        [%dep shrub=cord name=cord path=cord]
    ==

  ::  ── Unchanged structural helpers ────────────────────────────────────

  ++  exit
    ^-  hoon
    [%clhp [%rock %n ~] [%wing ~[%q %saga]]]

  ++  return
    ^-  hoon
    [%clhp [%limb %cards] [%wing ~[%q %saga]]]

  ++  wrap-gate
    |=  [arm=term body=hoon]
    ^-  hoon
    =/  sample=spec
      ?+  arm  !!
        %talk  [%bcts %add [%like ~[%tale %t] ~]]
        %hear  [%bcts %rely [%like ~[%rely %n] ~]]
        %take  [%bcts %gift [%like ~[%gift %n] ~]]
        %dead  [%bcts %slot [%like ~[%slot %t] ~]]
      ==
    [%brts sample [%tsfs %cards [%clsg ~] body]]

  ++  form-arms
    ^-  (map term tome)
    %-  malt
    :~  [%goof [~ (my ~[[%goof [%wing ~[%goof %def %n]]]])]]
        [%init [~ (my ~[[%init [%wing ~[%init %def %n]]]])]]
        [%dead [~ (my ~[[%dead [%wing ~[%dead %def %n]]]])]]
        [%talk [~ (my ~[[%talk [%wing ~[%talk %def %n]]]])]]
        [%take [~ (my ~[[%take [%wing ~[%take %def %n]]]])]]
        [%hear [~ (my ~[[%hear [%wing ~[%hear %def %n]]]])]]
    ==

  ++  wrap-form
    |=  [lst=(list [=term =hoon])]
    ^-  hoon
    :+  %kthp  [%like ~[%form %n] ~]
    :+  %brcb
      [%bccl ~[[%like ~[%bowl %n] ~] [%like ~[%saga %t] ~]]]
    :-  ~
    %-  ~(gas by form-arms)
    %+  turn  lst
    |=  [=term =hoon]
    [term [~ (my ~[[term hoon]])]]

  ++  wrap-vase
    |=  [mar=term inner=hoon]
    ^-  hoon
    [%clhp [%rock %tas mar] inner]

  ++  path-lit
    |=  segs=(list cord)
    ^-  hoon
    [%clsg (turn segs |=(c=cord [%rock %tas c]))]

  ++  pith-lit  path-lit

  ++  put-saga
    |=  [path=hoon val=hoon]
    ^-  hoon
    [%cnsg ~[%put] [%limb %by] [%wing ~[%q %saga]] ~[[%clhp path val]]]

  ++  append-card
    |=  [pax=hoon typ=term tal=hoon inner=hoon]
    ^-  hoon
    =/  card  [%clhp pax [%clhp [%rock %tas typ] tal]]
    :+  %tsdt  ~[%cards]
    [%cnls [%wing ~[%snoc]] [%wing ~[%cards]] card] inner

  ++  get-type
    |=  typ=cord
    ^-  spec
    ?:  =(typ 'date')     [%base %da]
    ?:  =(typ 'number')   [%base %ud]
    ?:  =(typ 'boolean')  [%base %f]
    ?:  =(typ 'string')   [%base %t]
    !!

  ++  build-literal-from-cord
    |=  lit=cord
    ^-  hoon
    ?:  =(lit 'true')   [%zpgr [%rock %f 0]]
    ?:  =(lit 'false')  [%zpgr [%rock %f 1]]
    =/  num  (rush lit dem)
    ?^  num  [%zpgr [%sand %ud u.num]]
    [%zpgr [%sand %t lit]]

  ++  build-slop-chain
    |=  args=(list hoon)
    ^-  hoon
    ?~  args      [%zpgr [%rock %n ~]]
    ?~  t.args    i.args
    [%cnhp [%limb %slop] [%clhp i.args $(args t.args)]]

  ::  ── build-path: cord → hoon (identical to XML forge) ───────────────
  ::  Paths are still cords in Rex — the parser emits them as TightInf trees
  ::  but toShrub() serialises them back to cord strings in attrs/name.
  ::  So this arm is a verbatim copy.

  ++  build-path
    |=  ref=cord
    ^-  hoon
    ?:  =(ref '$item')
      [%wing ~[%key]]
    =?  ref  =('/' (cut 3 [0 1] ref))  (rsh [3 1] ref)
    =/  raw=(list tape)
      %+  rash  ref
      %+  more  fas
      (plus ;~(pose hep low nud sel ser))
    =/  segs=(list cord)  (turn raw crip)
    ?~  segs  (pith-lit ~)
    ?:  =('[auto]' (rear segs))
      =/  pax  (path-lit (snip segs))
      [%cnhp [%limb %next-path] [%clhp pax [%wing ~[%kids %bowl]]]]
    ?.  (lien segs |=(s=cord =('%' (cut 3 [0 1] s))))
      (pith-lit segs)
    [%clsg (turn segs |=(s=cord ?:(=('%' (cut 3 [0 1] s)) [%wing ~[(rsh [3 1] s)]] [%rock %tas s])))]

  ::  ── build-reference: cord → hoon (verbatim copy from XML forge) ────
  ::  Still driven by cord paths — toShrub() serialises all path attrs as cords.

  ++  build-reference
    |=  ref=cord
    ^-  hoon
    =/  segs  (rash ref (more fas sym))
    ?~  segs  (pith-lit ~)
    =/  first  (cut 3 [0 1] ref)
    =/  rest   (rsh [3 1] ref)
    ?:  =(i.segs %kids)
      :^  %cnsg  ~[%tap]  [%limb %aon]
      :~  :+  %tsgl  [%limb %kid]
          :+  %cnhp  [%cnsg ~[%dip] [%limb %of] ~[[%wing ~[%kids %bowl]]]]
          (path-lit t.segs)
      ==
    ?:  =(i.segs %now)  [%zpgr [%wing ~[%now %bowl]]]
    ?:  =(first '/')
      :+  %tsgl  [%limb %q]
      [%cnsg ~[%got] [%limb %by] ~[[%wing ~[%q %saga]] (path-lit segs)]]
    ?:  =(first '@')
      [%wing ~[rest]]
    ?:  =(first '$')
      =/  name  i.segs
      ?:  =(name '$key')   [%zpgr [%wing ~[%key]]]
      ?:  =(name '$acc')   [%wing ~[%acc]]
      ?~  dot=(find "." (trip rest))
        ?:  =(name '$item')
          ?~  t.segs
            [%wing ~[%item]]
          :^  %cnsg  ~[%tap]  [%limb %aon]
          :~  :+  %tsgl  [%limb %kid]
              :+  %cnhp  [%cnsg ~[%dip] [%limb %of] ~[[%limb %item]]]
              (path-lit t.segs)
          ==
        [%wing ~[name]]
      =/  field  (rsh [3 +(u.dot)] rest)
      :+  %tsgl  [%limb %q]
      [%cnsg ~[%got] [%limb %by] ~[[%cnhp [%limb %need] [%wing ~[%fil %item]]] (path-lit ~[field])]]
    ?:  =(first '%')
      =/  dot  (find "." (trip rest))
      =/  fas  (find "/" (trip rest))
      =/  label=cord
        ?^  dot  (end [3 u.dot] rest)
        ?^  fas  (end [3 u.fas] rest)
        rest
      ?~  dot
        =/  segs  (rash rest (more fas sym))
        :^  %cnsg  ~[%tap]  [%limb %aon]
        :~  :+  %tsgl  [%limb %kid]
            :+  %cnhp
              :^  %cnsg  ~[%dip]  [%limb %of]
              :~  :-  %tsgl  [%limb %q]
                  :^  %cnsg  ~[%got]  [%limb %by]
                  :~  [%wing ~[%deps %bowl]]
                      [%rock %tas label]
                  ==
              ==
            (path-lit t.segs)
        ==
      =/  field  (rsh [3 +(u.dot)] rest)
      :+  %tsgl  [%limb %q]
      :^  %cnsg  ~[%got]  [%limb %by]
      :~  :+  %tsgl  [%limb %q]
          :+  %cnhp  [%limb %need]
          :+  %tsgl  [%limb %fil]
          :+  %tsgl  [%limb %q]
          :^  %cnsg  ~[%got]  [%limb %by]
          :~  [%wing ~[%deps %bowl]]
              [%rock %tas label]
          ==
        (path-lit ~[field])
      ==
    [%wing ~[i.segs]]

  ::  ── NEW: build-rex-expr — rex-node → hoon ──────────────────────────
  ::
  ::  THE KEY CHANGE from the XML forge.
  ::  XML build-expr walked (list manx) dispatching on tag names ('ref','fn','fold'...).
  ::  This arm walks rex-node dispatching on the op field (%slot, %call, %fold...).
  ::  The Hoon AST output is identical — same Hoon, different input.
  ::
  ::  Efficiency gain: expressions arrive pre-compiled from JS Rex.compileExpr().
  ::  No secondary string-parsing, no XML attribute extraction per expression.
  ::  A (fold %kids/tasks 0 (add $acc 1)) is already:
  ::    [%fold collection=[%dep 'kids/tasks'] initial=[%lit 0]
  ::           body=[%call 'add' ~[[%binding 'acc'] [%lit 1]]]]
  ::  We just walk the noun.

  ++  build-rex-expr
    |=  n=rex-node
    ^-  hoon
    ?-  -.n
        %lit
      =/  v  value.n
      ?:  ?=(? v)
        ?:  v  [%zpgr [%rock %f 0]]
             [%zpgr [%rock %f 1]]
      ?:  ?=(@ud v)  [%zpgr [%sand %ud v]]
      [%zpgr [%sand %t ;;(cord v)]]

        %slot
      (build-reference (cat 3 '/' path.n))

        %dep
      (build-reference (cat 3 '%' label.n))

        %binding
      (build-reference (cat 3 '$' name.n))

        %ident
      ::  could be a bare wing or a 0-arg def call — treat as reference
      (build-reference name.n)

        %call
      ::  (if test then else) is the one special form — no read-gate dispatch
      ?:  =(fn.n 'if')
        ?.  =(3 (lent args.n))  [%zpzp ~]
        [%wtcl [%zpgl [%base %f] $(n (snag 0 args.n))]
               $(n (snag 1 args.n))
               $(n (snag 2 args.n))]
      ::  general: (slam (read-gate fn kids.bowl) (slop arg1 arg2 ...))
      :+  %cnls  [%limb %slam]
      :+  %cncl
        [%limb %read-gate]
        :~  [%rock %tas fn.n]
            [%wing ~[%kids %bowl]]
        ==
      (build-slop-chain (turn args.n |=(a=rex-node $(n a))))

        %fold
      ::  =/ acc INITIAL
      ::  =/ items (build-reference collection)
      ::  |-
      ::  ?~ items  acc
      ::  =/ key  -.i.items
      ::  =/ item  +.i.items
      ::  =. acc BODY
      ::  $(items t.items)
      :^  %tsfs  %acc  $(n initial.n)
      :^  %tsfs  %items
        ::  collection ref: dep or binding or slot
        ?-  -.collection.n
          %dep      (build-reference (cat 3 '%' label.collection.n))
          %binding  (build-reference (cat 3 '$' name.collection.n))
          %slot     (build-reference (cat 3 '/' path.collection.n))
          %ident    (build-reference name.collection.n)
          *         $(n collection.n)
        ==
      :-  %brhp
      :^  %wtsg  ~[%items]  [%wing ~[%acc]]
      :^  %tsfs  %key   [%wing ~[%& %i %items]]
      :^  %tsfs  %item  [%wing ~[%| %i %items]]
      :^  %tsdt  ~[%acc]  $(n body.n)
      [%cnts ~[%$] ~[[~[%items] [%wing ~[%t %items]]]]]
    ==

  ::  ── Decode a rex-shrub child as an expression node ─────────────────
  ::
  ::  When the JS bridge sends @slot children whose value is a Rex expression,
  ::  it encodes the compiled expression as a nested rex-shrub with
  ::  type='_expr' and attrs containing the rex-node JSON.
  ::  Alternatively, simple literal values are stored as string attrs.

  ++  shrub-as-expr
    |=  s=rex-shrub
    ^-  rex-node
    ::  explicit compiled expr node stored by JS bridge
    ?^  expr=(~(get by attrs.s) '_node')
      ;;(rex-node u.expr)
    ::  type is an op tag — structured expr node
    ?:  =(type.s 'call')
      [%call (get-attr-cord:decode-rex s 'fn' '') (turn children.s shrub-as-expr)]
    ?:  =(type.s 'fold')
      ?:  (lth (lent children.s) 3)  [%ident '']
      [%fold (shrub-as-expr (snag 0 children.s))
             (shrub-as-expr (snag 1 children.s))
             (shrub-as-expr (snag 2 children.s))]
    ::  content cord = a literal or path inline
    ?^  con=content.s
      (cord-as-node u.con)
    ::  name cord = a literal or path
    ?^  nm=name.s
      (cord-as-node u.nm)
    ::  fallback
    [%ident type.s]

  ++  cord-as-node
    |=  c=cord
    ^-  rex-node
    ?:  =(c 'true')   [%lit 0]
    ?:  =(c 'false')  [%lit 1]
    ?:  =('/' (cut 3 [0 1] c))  [%slot (rsh [3 1] c)]
    ?:  =('%' (cut 3 [0 1] c))  [%dep (rsh [3 1] c)]
    ?:  =('$' (cut 3 [0 1] c))  [%binding (rsh [3 1] c)]
    =/  num  (rush c dem)
    ?^  num  [%lit u.num]
    [%ident c]

  ::  ── build-rex-tale: @slot children → tale hoon ─────────────────────
  ::  Parallels build-tale from XML forge.
  ::  Each @slot child: name=cord, expression encoded as child or attr.

  ++  build-rex-tale
    |=  slots=(list rex-shrub)
    ^-  hoon
    =/  pairs=(list hoon)
      %+  murn  slots
      |=  s=rex-shrub
      ^-  (unit hoon)
      ?~  name.s  ~
      =/  val-hoon=hoon
        ?~  children.s
          ::  no children — value is in content or a literal attr
          ?~  content.s
            [%zpzp ~]
          (build-literal-from-cord u.content.s)
        ::  first child is the expression
        (build-rex-expr (shrub-as-expr i.children.s))
      `[%clhp (path-lit ~[u.name.s]) (wrap-vase %noun val-hoon)]
    [%cnhp [%cnsg ~[%gas] [%limb %by] ~[[%rock %n ~]]] [%clsg pairs]]

  ::  ── build-rex-inputs: @input children → hoon ───────────────────────

  ++  build-rex-inputs
    |=  [inputs=(list rex-shrub) inner=hoon]
    ^-  hoon
    |-
    ?~  inputs  inner
    =/  s  i.inputs
    =/  fname  (fall name.s '')
    =/  ftype  (get-attr-cord:decode-rex s 'type' 'string')
    =/  spec
      [%bccl ~[[%bcts fname (get-type ftype)]]]
    [%tsls [%zpgl spec [%wing ~[%q %pal]]] $(inputs t.inputs)]

  ::  ── build-rex-guard: optional @guard child → guard hoon wrapper ────

  ++  build-rex-guard
    |=  [guard=(unit rex-shrub) inner=hoon]
    ^-  hoon
    ?~  guard  inner
    =/  guard-expr=rex-node
      ?~  children.u.guard
        ?~  content.u.guard  [%ident 'true']
        (cord-as-node u.content.u.guard)
      (shrub-as-expr i.children.u.guard)
    [%wtdt [%zpgl [%base %f] (build-rex-expr guard-expr)] exit inner]

  ::  ── build-rex-mutations: (list rex-shrub) → hoon ───────────────────
  ::  Parallels build-mutations — same Hoon out, rex-shrub in.

  ++  build-rex-mutations
    |=  [nods=(list rex-shrub) inner=hoon]
    ^-  hoon
    |-
    ?~  nods  inner
    =/  s  i.nods
    ?:  =(type.s 'set')     (build-rex-set s $(nods t.nods))
    ?:  =(type.s 'create')  (build-rex-card s %make $(nods t.nods))
    ?:  =(type.s 'update')  (build-rex-card s %poke $(nods t.nods))
    ?:  =(type.s 'remove')  (build-rex-remove s $(nods t.nods))
    ?:  =(type.s 'each')    (build-rex-each s $(nods t.nods))
    ?:  =(type.s 'when')    (build-rex-when s $(nods t.nods))
    $(nods t.nods)

  ++  build-rex-set
    |=  [s=rex-shrub inner=hoon]
    ^-  hoon
    =/  raw  (fall name.s '')
    ?:  =(raw '')  inner
    =?  raw  =('/' (cut 3 [0 1] raw))  (rsh [3 1] raw)
    =/  segs  (rash raw (more fas sym))
    =/  val-hoon=hoon
      ?~  children.s
        ?~  content.s  [%zpzp ~]
        (build-literal-from-cord u.content.s)
      (build-rex-expr (shrub-as-expr i.children.s))
    :^  %tsdt  ~[%q %saga]
      (put-saga (path-lit segs) (wrap-vase %noun val-hoon))
    inner

  ++  build-rex-card
    |=  [s=rex-shrub typ=term inner=hoon]
    ^-  hoon
    =/  raw  (fall name.s '')
    ?:  =(raw '')  inner
    =/  path  (build-path raw)
    =/  slots  (kids-of:decode-rex s 'slot')
    =/  tal  (build-rex-tale slots)
    (append-card path typ tal inner)

  ++  build-rex-remove
    |=  [s=rex-shrub inner=hoon]
    ^-  hoon
    =/  raw  (fall name.s '')
    ?:  =(raw '')  inner
    (append-card (build-path raw) %cull [%rock %n ~] inner)

  ++  build-rex-each
    |=  [s=rex-shrub inner=hoon]
    ^-  hoon
    =/  coll-cord  (fall name.s '')
    =/  where-node=(unit rex-shrub)
      (find-kid:decode-rex s 'where')
    =/  muts=(list rex-shrub)
      (skip children.s |=(c=rex-shrub =(type.c 'where')))
    =/  next  [%cnts ~[%$] ~[[~[%items] [%wing ~[%t %items]]]]]
    =/  body  (build-rex-mutations muts next)
    =.  body
      ?~  where-node  body
      =/  wexpr=rex-node
        ?~  children.u.where-node
          ?~  content.u.where-node  [%ident 'true']
          (cord-as-node u.content.u.where-node)
        (shrub-as-expr i.children.u.where-node)
      :^  %wtdt  [%zpgl [%base %f] (build-rex-expr wexpr)]  next  body
    :^  %tsfs  %items  (build-reference coll-cord)
    :-  %brhp
    :^  %wtsg  ~[%items]  inner
    :^  %tsfs  %key   [%wing ~[%& %i %items]]
    :^  %tsfs  %item  [%wing ~[%| %i %items]]
    body

  ++  build-rex-when
    |=  [s=rex-shrub inner=hoon]
    ^-  hoon
    =/  test-expr=rex-node
      ?~  children.s
        ?~  content.s  [%ident 'true']
        (cord-as-node u.content.s)
      (shrub-as-expr i.children.s)
    =/  muts=(list rex-shrub)
      ?~  children.s  ~  t.children.s
    ?~  muts  inner
    [%wtcl [%zpgl [%base %f] (build-rex-expr test-expr)]
      (build-rex-mutations muts inner)
      inner]

  ::  ── forge-rex-def ────────────────────────────────────────────────────
  ::
  ::  @def NAME :args [a b c]
  ::    EXPR
  ::
  ::  Parallels forge-def from XML forge.
  ::  args stored as (list cord) in attrs; body in first child.

  ++  forge-rex-def
    |=  nod=rex-shrub
    ^-  forge-result
    =/  defname  (fall name.nod '')
    =/  args=(list cord)
      ?~  raw=(~(get by attrs.nod) 'args')  ~
      ?^  raw
        ::  already a list
        ;;((list cord) raw)
      ::  cord: space-separated
      (rash ;;(cord raw) (more ace sym))
    =/  body-hoon=hoon
      ?~  children.nod  [%zpzp ~]
      (build-rex-expr (shrub-as-expr i.children.nod))
    =/  gate-hoon=hoon
      [%brts [%bccl (turn args |=(a=cord [%bcts a [%base %noun]]))] body-hoon]
    [%def defname gate-hoon]

  ::  ── forge-rex-derive ──────────────────────────────────────────────────
  ::
  ::  @derive :shrub NAME :slot SLOT
  ::    EXPR
  ::
  ::  Parallels forge-derive from XML forge.

  ++  forge-rex-derive
    |=  nod=rex-shrub
    ^-  hoon
    =/  slot  (get-attr-cord:decode-rex nod 'slot' '')
    ?:  =(slot '')  exit
    =/  expr-hoon=hoon
      ?~  children.nod  [%zpzp ~]
      (build-rex-expr (shrub-as-expr i.children.nod))
    =/  body=hoon
      :^  %tsdt  ~[%q %saga]
        (put-saga (path-lit ~[slot]) (wrap-vase %noun expr-hoon))
      return
    %-  wrap-form
    :~  [%hear (wrap-gate %hear body)]
        [%take (wrap-gate %take body)]
    ==

  ::  ── forge-rex-talk ────────────────────────────────────────────────────
  ::
  ::  @talk :shrub NAME :name ACTION
  ::    @input FIELD :type TYPE
  ::    @guard EXPR
  ::    MUTATIONS...
  ::
  ::  Parallels forge-talk from XML forge.
  ::
  ::  PCN note: @guard children may have been injected by ShrubLM._amendSource().
  ::  They arrive here already parsed — no special treatment needed.
  ::  The synthesized guard expression is a valid Rex expr cord like
  ::  "(gte /health 50)" which toShrub() encodes as a child rex-shrub.

  ++  forge-rex-talk
    |=  nod=rex-shrub
    ^-  hoon
    =/  inputs  (kids-of:decode-rex nod 'input')
    =/  guard   (find-kid:decode-rex nod 'guard')
    =/  muts=(list rex-shrub)
      %+  skip  children.nod
      |=  c=rex-shrub
      ?|  =(type.c 'input')  =(type.c 'guard')  ==
    =/  body  (build-rex-mutations muts return)
    =.  body  (build-rex-guard guard body)
    =.  body  (build-rex-inputs inputs body)
    (wrap-form ~[[%talk (wrap-gate %talk body)]])

  ::  ── forge-rex-dep ──────────────────────────────────────────────────────
  ::
  ::  @dep :shrub NAME :name LABEL
  ::    @dead
  ::      MUTATIONS...
  ::    MUTATIONS...
  ::
  ::  Parallels forge-dep from XML forge.

  ++  forge-rex-dep
    |=  nod=rex-shrub
    ^-  hoon
    =/  dead-node=(unit rex-shrub)
      (find-kid:decode-rex nod 'dead')
    =/  muts=(list rex-shrub)
      (skip children.nod |=(c=rex-shrub =(type.c 'dead')))
    =/  body  (build-rex-mutations muts return)
    =/  dead-body=hoon
      ?~  dead-node  return
      (build-rex-mutations children.u.dead-node return)
    (wrap-form ~[[%hear (wrap-gate %hear body)] [%dead (wrap-gate %dead dead-body)]])

  ::  ── forge-rex-spec: build spec:n from a rex-shrub ─────────────────────
  ::  Parallels forge-spec from XML forge.

  ++  forge-rex-spec
    |=  nod=rex-shrub
    ^-  spec:n
    =/  deps=(map term (bill:n fief:n))
      ?:  =(type.nod 'dep')
        =/  lbl=term  (fall name.nod %dep)
        (my ~[[lbl [~ [deed=[~ &] care=%y soma=*soma:n]]]])
      *(map term (bill:n fief:n))
    =/  pokes=(set (bill:n stud:t))
      ?:  =(type.nod 'talk')
        =/  action=term  (fall name.nod %talk)
        (sy ~[[~ action]])
      *(set (bill:n stud:t))
    :*  state=[~ [%any ~]]
        poke=[~ pokes]
        kids=~
        deps=[~ deps]
    ==

  ::  ── run-rex: (list rex-shrub) → (list forge-result) ──────────────────
  ::
  ::  Main entry. Replaces forge.run which took (list manx).
  ::  Each rex-shrub came from the JS bridge (Rex.toShrub() JSON decoded).
  ::  @channel and @shrub blocks are ignored here — JS-side only.

  ++  run-rex
    |=  nods=(list rex-shrub)
    ^-  (list forge-result)
    %-  zing
    %+  murn  nods
    |=  nod=rex-shrub
    ^-  (unit (list forge-result))
    =/  typ  type.nod
    ::  @def — pure function, no shrub attr
    ?:  =(typ 'def')
      `~[(forge-rex-def nod)]
    ::  @channel and @shrub — handled entirely in JS, skip
    ?:  ?|  =(typ 'channel')  =(typ 'shrub')  ==
      ~
    ::  behavioural blocks
    =/  hon=(unit hoon)
      ?:  =(typ 'dep')     `(forge-rex-dep nod)
      ?:  =(typ 'talk')    `(forge-rex-talk nod)
      ?:  =(typ 'derive')  `(forge-rex-derive nod)
      ~
    ?~  hon  ~
    ::  shrub attr — in Rex: :shrub attr OR positional name
    =/  shrub-cord=cord
      ?^  v=(~(get by attrs.nod) 'shrub')
        ;;(cord u.v)
      (fall name.nod typ)
    =/  sub=cord
      ?:  =(typ 'talk')    (get-attr-cord:decode-rex nod 'name' typ)
      ?:  =(typ 'dep')     (get-attr-cord:decode-rex nod 'name' typ)
      ?:  =(typ 'derive')  (get-attr-cord:decode-rex nod 'slot' typ)
      typ
    =/  =spec:n  (forge-rex-spec nod)
    ::  src.nod: raw Rex block cord stored at /shrub/NAME/rex/SUB so LLM can read it back
    =/  results=(list forge-result)
      ~[[%kook shrub-cord spec sub u.hon src.nod]]
    =?  results  =(typ 'dep')
      =/  pax  (get-attr-cord:decode-rex nod 'path' '')
      (snoc results [%dep shrub-cord sub pax])
    `results

  --  :: forge-rex

::  ════════════════════════════════════════════════════════════════════════
::  pcn-wire — PCN/ShrubLM feedback loop integration notes
::
::  This section documents how the PCN self-healing loop integrates with
::  the Rex author agent. No new Hoon arms are required — the feedback
::  loop runs entirely on the JS side. This section describes:
::
::  1. What the behaviour transducer emits on talk invocation
::  2. How ShrubLM learns from it
::  3. How synthesized guards reach the author agent
::  4. How the LLM receives state and emits Rex REPLACE edits
::  5. What changes in forge-rex to handle synthesized @guard blocks
::  ════════════════════════════════════════════════════════════════════════
::
::  ── 1. Talk invocation → PCN episode ──────────────────────────────────
::
::  rex-behaviour.invoke() fires onTalkFired:
::    { shrub, talk, guard_result, mutations_fired,
::      slot_deltas: Map<slotName, delta>, surprise, timestamp }
::
::  main.js bridges this to pcn.bridgeBehaviourEvent():
::    episode = { source: 'talk', shrubName, path, talk, mode, slotDeltas, timestamp }
::    pcn.pushEpisode(episode)
::
::  ── 2. ShrubLM.observe(talkName, preSlots, postSlots) ────────────────
::
::  On each episode, ShrubLM:
::    - normalises displacement (postSlots - preSlots) into [0,1] space
::    - Welford update on prototype.mean / prototype.m2
::    - Welford update on prototype.preState.mean / .m2
::      (preState = N-dim slot position at talk invocation — used by backward pass)
::    - check Mahalanobis distance for surprise (> 3σ → onSurpriseSignal)
::    - check local crystallization threshold:
::        count ≥ 20, variance < 0.25, time ≥ 3×naturalPeriod
::    - if LM has NO known CMP ports → crystallize immediately
::    - if LM HAS CMP ports → enter pendingCrystallizations, await lateral vote
::      (30s timeout: crystallize solo if no lateral confirmation arrives)
::    - on crystallization with rejectCount > 0 → synthesizeGuard()
::
::  ── 2b. Dep transitive closure ────────────────────────────────────────
::
::  rex-behaviour._buildDepClosure() runs at compile time (step 8 in _compile).
::  Walks all schema @dep declarations + their @set mutation write sets.
::  Computes transitive closure: if A watches B, and B writes slot S, and
::  C watches A/S, then C is added as a downstream reaction of B automatically.
::  Stored as _depTriggers: "sourceShrub/slot" → [{shrub, label}].
::  rex-behaviour.invoke() calls _fireDepReactions() after mutations, which
::  walks _depTriggers and fires reactions transitively (depth-limited to 8).
::
::  Hoon impact: NONE. forge-rex-dep still emits [%dep shrub name path] as
::  before. The transitive closure is a JS-side compile-time optimisation.
::
::  ── 2c. CMP port weights and discovery ────────────────────────────────
::
::  ShrubLM.portWeights: Map<neighborShrub, 0..1>
::    - Known dep edges seeded at 0.5 when setDepGraph() is called
::    - Co-firing discovery (two shrubs fire within 50ms): new port at 0.1
::    - Confirming vote: weight += 0.1 (Hebbian strengthening)
::    - Contradicting vote: weight -= 0.2 (anti-Hebbian weakening)
::    - Ports below 0.05 are pruned
::  Votes are now weighted: vote.confidence × portWeight before delivery.
::  _emitVotes() routes to both dep-graph neighbors AND co-firing ports.
::
::  ── 3. synthesizeGuard() → Rex expression cord ───────────────────────
::
::  ShrubLM.synthesizeGuard(talkName) emits a Rex expression string:
::    "(gte /health 50)"
::    "(and (gte /health 50) (lte /mana 100))"
::    "(gte /quantity 5)"
::
::  This is valid Rex — the same syntax the LLM emits and forge-rex compiles.
::
::  ── 4. _amendSource(rule) → editor source patch ──────────────────────
::
::  main.js._amendSource({ shrub, talk, guard }) patches the editor:
::    - finds the @talk :shrub SHRUB :name TALK line in source
::    - if @guard exists: merges with (and existing synthesized)
::    - if no @guard: inserts @guard EXPR on the next indented line
::    - re-parses → re-compiles → forge-rex picks up the new @guard child
::
::  This is purely JS-side. No Hoon involvement. The synthesized guard
::  arrives at forge-rex-talk as a parsed @guard child, indistinguishable
::  from a user-written guard. forge-rex-talk calls build-rex-guard on it.
::
::  ── 5. LLM receives Rex state, emits REPLACE with updated guard ───────
::
::  When the LLM is prompted to edit, it sees:
::    /shrub/NAME/rex/SUB — the Rex source cord for the kook
::    (not /shrub/NAME/xml/SUB — that was the XML path)
::
::  Example Rex state the LLM receives for a crystallized @talk:
::    @talk :shrub store :name sell
::      @input sku :type string
::      @input amount :type number
::      @guard (and (gte /products/%sku/quantity %amount) (gte /products/%sku/quantity 5)) ; [learned by ShrubLM]
::      @update /products/%sku
::        @slot quantity (sub /products/%sku/quantity %amount)
::
::  The LLM emits a REPLACE edit to refine or extend the guard:
::    ;; REPLACE @talk :shrub store :name sell
::    @talk :shrub store :name sell
::      @input sku :type string
::      @input amount :type number
::      @guard (and (gte /products/%sku/quantity %amount) (gt /products/%sku/quantity 0))
::      @update /products/%sku
::        @slot quantity (sub /products/%sku/quantity %amount)
::
::  handle-chunk-rex processes this REPLACE and calls forge-rex.run-rex
::  on the updated node. The kook at /store/talk/sell is hot-swapped.
::
::  ── Summary: what is new vs XML ──────────────────────────────────────
::
::  XML path:   LLM reads XML back, edits XML, XML forge recompiles
::  Rex path:   LLM reads Rex back, edits Rex, forge-rex recompiles
::
::  The guard injection (ShrubLM → _amendSource) works identically in both.
::  The only difference is the notation the LLM reads and writes.
::  Rex is ~10x denser for expressions — the guard above is one line instead of:
::    <guard>
::      <fn name="and">
::        <fn name="gte"><ref name="/products/%sku/quantity"/><ref name="%amount"/></fn>
::        <fn name="gt"><ref name="/products/%sku/quantity"/><literal value="0"/></fn>
::      </fn>
::    </guard>

--  :: top-level core
