// ═══════════════════════════
// MAIN
// ═══════════════════════════

import { Rex } from './rex-parser.js';
import { RexGPU } from './rex-gpu.js';
import { RexSurface } from './rex-surface.js';
import { RexForm, esc } from './rex-form.js';
import { RexBehaviour } from './rex-behaviour.js';
import { RexPCN } from './rex-pcn.js';
import { PLANBridge } from './plan-bridge.js';
import { TabManager } from './tab-manager.js';
import { callClaude } from './claude-api.js';
import { RexAudio } from './rex-audio.js';

(async()=>{ try {
  const canvas  = document.getElementById('gpu-canvas');
  const editor  = document.getElementById('rex-src');
  const logView = document.getElementById('log-view');
  const heapView= document.getElementById('heap-view');
  const formMount=document.getElementById('form-mount');
  const messages= document.getElementById('messages');
  const prompt  = document.getElementById('prompt');
  const sendBtn = document.getElementById('send');
  const gpuSt   = document.getElementById('gpu-status');
  const ncEl    = document.getElementById('node-count');
  const keyInput= document.getElementById('api-key');
  const keyDot  = document.getElementById('key-dot');
  const keyShow = document.getElementById('key-show');

  // ── Tab manager ──
  const tabMgr = new TabManager();
  tabMgr.createTab('Session 1');

  // ── Key field ──
  function updateKey(){
    const v=keyInput.value.trim(), ok=v.startsWith('sk-ant-')&&v.length>20;
    keyInput.classList.toggle('valid',ok);
    keyDot.className=v.length===0?'':ok?'ok':'err';
  }
  keyInput.addEventListener('input',updateKey);
  keyInput.addEventListener('paste',()=>setTimeout(updateKey,0));
  keyShow.addEventListener('click',()=>{
    const show=keyInput.type==='password';
    keyInput.type=show?'text':'password';
    keyShow.textContent=show?'hide':'show';
  });

  // ── Canvas resize ──
  let gpu, surface;
  const overlay = document.getElementById('gpu-overlay');
  function setOverlay(msg) { if(overlay) overlay.textContent = msg||''; }

  function resizeCanvas(){
    const rect=canvas.parentElement.getBoundingClientRect();
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.floor(rect.width*dpr);
    canvas.height=Math.floor(rect.height*dpr);
    canvas.style.width=rect.width+'px';
    canvas.style.height=(rect.height-30)+'px';
    if(gpu){
      // Canvas resize invalidates the WebGPU context — must reconfigure before next frame
      if(gpu.context&&gpu.device) gpu.context.configure({device:gpu.device,format:gpu.format,alphaMode:'premultiplied'});
      gpu.invalidate();
    }
    if(surface)surface.invalidate();
  }

  // ── Logs ──
  let logs=[];
  function log(msg,cls=''){logs.push({msg,cls});if(logs.length>300)logs=logs.slice(-200);}
  function flushLog(){logView.innerHTML=logs.map(e=>`<div class="le ${e.cls}">${esc(e.msg)}</div>`).join('');logView.scrollTop=logView.scrollHeight;}

  // ── GPU init ──
  // Note: resizeCanvas() must run after applyBreakpoint() sets up the grid,
  // so defer the first resize — the GPU context is configured after init below.
  gpu = new RexGPU(canvas, log);
  setOverlay('Initializing WebGPU\u2026');
  const gpuOk = await gpu.init();
  if (gpuOk) {
    gpuSt.textContent = 'WebGPU ready'; gpuSt.className = 'ok';
    setOverlay('Type a prompt to generate something \u2192');
  } else {
    gpuSt.textContent = 'WebGPU unavailable'; gpuSt.className = 'err';
    setOverlay('WebGPU not available in this environment.\nTry Chrome 113+ or Edge 113+.');
  }

  // ── Surface transducer ──
  if (gpuOk) {
    surface = new RexSurface(gpu.device, gpu.context, gpu.format, log);
  }

  // ── PCN transducer ──
  let pcn = null;
  if (gpuOk) {
    try {
      pcn = new RexPCN(gpu.device, log);
      await pcn.init();
    } catch(e) { log(`pcn init failed: ${e.message}`, 'err'); pcn = null; }
  }

  // ── Audio transducer ──
  const audio = new RexAudio(log);
  window._audio = audio;
  // AudioContext requires user gesture — init on first interaction
  let audioInitialized = false;
  async function ensureAudio() {
    if (audioInitialized) return;
    audioInitialized = true;
    const ok = await audio.init();
    if (ok) log('audio: ready', 'ok');
    // Bridge: FFT data → GPU texture (1D, frequencyBinCount wide)
    audio.onFftData = (fft, wave) => {
      if (!gpu.device || !gpu._fftTexture) return;
      gpu.device.queue.writeTexture(
        { texture: gpu._fftTexture },
        fft,
        { bytesPerRow: fft.byteLength },
        { width: fft.length, height: 1 }
      );
    };
  }
  document.addEventListener('pointerdown', ensureAudio, { once: true });
  document.addEventListener('keydown', ensureAudio, { once: true });

  // ── Form transducer ──
  const form = new RexForm(formMount);
  form.onFieldChange = (name,val)=>{
    const prev = form.state[name];
    gpu.setFormField(name,val);
    // Bridge: form → behaviour (recompute derives that reference form values)
    behaviour.pushFormValue(name,val);
    // Bridge: form change → PLAN event log
    if(bridge) bridge.logFormChange(name, val, prev);
    // Bridge: form field → PCN directly (no batch needed)
    if(pcn) pcn.bridgeFormEvent(name, val);
  };
  window._currentForm = form;

  // ── Behaviour transducer ──
  const behaviour = new RexBehaviour(log);
  behaviour.onSlotChange = (shrub, slot, val) => {
    // Bridge: behaviour slot changes → form state → GPU heap
    if (typeof val === 'number' || typeof val === 'boolean') {
      const numVal = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      gpu.setFormField(slot, numVal);
      form.state[slot] = numVal;
    }
  };
  // Bridge: rich causal talk record → PCN
  behaviour.onTalkFired = (record) => { if(pcn) pcn.pushBehaviourEvent(record); };
  // Bridge: out-of-range derive → PCN surprise signal
  behaviour.onSurpriseSignal = (shrub, slot, value, range) => { if(pcn) pcn.pushSurpriseSignal(shrub, slot, value, range); };
  // Bridge: ShrubLM access for model-free guard bypass
  behaviour.getShrubLM = (shrubName) => pcn ? pcn.getShrubLM(shrubName) : null;
  // Bridge: goal-state generator for self-healing recovery
  behaviour.getGoalState = (shrub, slot, target, slots) => pcn ? pcn.findGoalState(shrub, slot, target, slots) : null;
  // ── Channel bridge: behaviour → GPU heap + audio params ──
  behaviour.onChannelPush = (buffer, field, value) => {
    gpu.setChannelValue(buffer, field, value);
    // Also route to audio transducer (pattern name = buffer, param = field)
    audio.setParam(buffer, field, value);
  };
  // ── Readback bridge: GPU → behaviour ──
  gpu.onReadback = (name, values, meta) => {
    if (!behaviour) return;
    // Optic-driven readback: typed object → push individual fields as slots
    if (meta && meta.typed && typeof values === 'object' && !ArrayBuffer.isView(values)) {
      // Push the whole object
      behaviour.pushFormValue(name, values);
      // Also push individual fields: "name/field" → value
      for (const [k, v] of Object.entries(values)) {
        behaviour.pushFormValue(`${name}/${k}`, v);
      }
      // Route to specific slot if :to was specified
      if (meta.toSlot) behaviour.pushFormValue(meta.toSlot, values);
    } else {
      // Legacy: raw Float32Array readback
      behaviour.pushFormValue(name, values.length === 1 ? values[0] : Array.from(values));
    }
  };
  // Wire form state into behaviour and surface for expression evaluation
  behaviour.formState = form.state;
  if(surface) {
    surface.formState = form.state; surface.behaviour = behaviour;
    surface.onHitChange = (eid) => { log(`hit: element ${eid}`); };
    surface.onElementClick = (eid, x, y) => {
      log(`click: element ${eid} at (${x|0},${y|0})`);
      // Push to behaviour as a talk trigger
      if(behaviour) behaviour.fireTalk('_surface','click',{element:eid,x,y});
    };
  }
  form.behaviour = behaviour;
  window._currentBehaviour = behaviour;
  window._pcn = pcn;

  // ── PLAN Bridge (Phase A: localStorage) ──
  const bridge = new PLANBridge(log);
  window._bridge = bridge;

  // ── Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) ──
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const entry = bridge.undoTree();
      if (entry) {
        editor.value = entry.source;
        lastSrc = '';
        const restored = bridge.restoreForm(entry);
        for (const [k, v] of Object.entries(restored)) {
          form.state[k] = v;
          gpu.setFormField(k, v);
        }
        parseSource();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      const entry = bridge.redoTree();
      if (entry) {
        editor.value = entry.source;
        lastSrc = '';
        parseSource();
      }
    }
  });

  // ── Parse + compile ──
  let currentTree=null, lastSrc='', parseTimer=null;
  let interactAttrs=null;  // Phase 5A: cached @interact node
  let surfaceDirty=false;  // Phase 3C: deferred surface recompile
  function parseSource(){
    const src=editor.value; if(src===lastSrc&&currentTree)return; lastSrc=src;
    try{
      currentTree=Rex.parse(src);
      currentTree=Rex.expandTemplates(currentTree);
      const nc=(function count(n){let c=1;for(const ch of n.children)c+=count(ch);return c;})(currentTree);
      ncEl.textContent=`\u2713 ${nc}`;
      // Cache @interact attrs at parse time (Phase 5A)
      interactAttrs=Rex.find(currentTree,'interact')?.attrs||null;
      form.transduce(currentTree);
      behaviour.transduce(currentTree, true);
      // GPU derive compute: compile GPU-eligible @derive expressions to compute shader
      if (gpu.device) {
        gpu._compileDeriveCompute(behaviour.getGpuDerives());
      }
      // PCN: register each @shrub as agent + ShrubLM, wire connectome + dep graph
      if(pcn){
        const depEdges = behaviour.getCrossShrubDeps();
        for(const sn of behaviour.getShrubNames()){
          pcn.registerShrubAgent(sn, behaviour.getTalkNames(sn));
          const schema = behaviour.getShrubSchema(sn);
          if(schema) pcn.registerShrubSchema(sn, schema);
        }
        pcn.wireConnectomeFromDeps(depEdges);
        pcn.setDepGraph(depEdges);
      }
      if(surface) surface.compile(currentTree, canvas.width, canvas.height);
      try { audio.transduce(currentTree, true); } catch(ea){ log(`audio compile: ${ea.message}`,'err'); }
      gpu._structureChanged=true;
      bridge.snapshotForm(form.state);
      bridge.pinTree(src);
      setOverlay('Compiling\u2026');
    }catch(e){ ncEl.textContent=`\u2717 ${e.message}`; log(`parse: ${e.message}`,'err'); }
  }
  // ── Source amendment: ShrubLM-synthesized rules ──
  const _userAmendedTalks = new Set();         // "shrub/talk" keys user has manually edited
  const _lastSynthesizedGuards = new Map();    // "shrub/talk" → guard string

  function _escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function _amendSource(rule) {
    const key = `${rule.shrub}/${rule.talk}`;
    if (_userAmendedTalks.has(key)) {
      log(`source-amend: skipping "${key}" — user-amended`, 'warn');
      return;
    }

    const src = editor.value;
    // Match @talk with :shrub and :name attrs (either order)
    const esc = (s) => _escRegex(s);
    const pat = new RegExp(
      `(@talk\\s+(?:${esc(rule.talk)}\\s+)?(?::shrub\\s+${esc(rule.shrub)}\\s+:name\\s+${esc(rule.talk)}|:name\\s+${esc(rule.talk)}\\s+:shrub\\s+${esc(rule.shrub)}|:shrub\\s+${esc(rule.shrub)}\\s+${esc(rule.talk)}))`,
      'm'
    );
    const talkMatch = src.match(pat);
    if (!talkMatch) {
      log(`source-amend: @talk "${key}" not found in source`, 'warn');
      return;
    }

    const talkEnd = talkMatch.index + talkMatch[0].length;
    const afterTalk = src.slice(talkEnd);
    const comment = ' ; [learned by ShrubLM]';
    let newSrc;

    // Check for existing @guard on next indented line
    const guardPat = /\n([ \t]+)@guard\s+(.+?)(?:\s*;.*)?$/m;
    const guardMatch = afterTalk.match(guardPat);

    // Only look for guard within the talk's block (before next @talk or unindented line)
    const nextBlockPat = /\n(?=\S)/;
    const nextBlock = afterTalk.search(nextBlockPat);
    const inBlock = guardMatch && (nextBlock === -1 || guardMatch.index < nextBlock);

    if (inBlock && guardMatch) {
      // Guard exists — merge with AND
      const guardLineStart = talkEnd + guardMatch.index;
      const fullGuardLine = guardMatch[0];
      const indent = guardMatch[1] || '  ';
      const existingExpr = guardMatch[2].trim();
      const merged = `(and ${existingExpr} ${rule.guard})`;
      newSrc = src.slice(0, guardLineStart) +
               `\n${indent}@guard ${merged}${comment}` +
               src.slice(guardLineStart + fullGuardLine.length);
    } else {
      // No guard — insert after @talk line
      const nextChildPat = /\n([ \t]+)@/;
      const childMatch = afterTalk.match(nextChildPat);
      if (childMatch && (nextBlock === -1 || childMatch.index < nextBlock)) {
        const insertPos = talkEnd + childMatch.index;
        newSrc = src.slice(0, insertPos) + `\n  @guard ${rule.guard}${comment}` + src.slice(insertPos);
      } else {
        // No children at all — append guard after talk line
        newSrc = src.slice(0, talkEnd) + `\n  @guard ${rule.guard}${comment}` + src.slice(talkEnd);
      }
    }

    editor.value = newSrc;
    lastSrc = '';
    parseSource();
    _lastSynthesizedGuards.set(key, rule.guard);
    log(`source-amend: injected guard for "${key}": ${rule.guard}`, 'ok');
  }

  // Wire crystallization → source amendment
  if (pcn) {
    pcn.onCrystallize = (rule) => {
      try { _amendSource(rule); }
      catch (e) { log(`source-amend: ${e.message}`, 'err'); }
    };
  }

  editor.addEventListener('input',()=>{
    // Check for user override of synthesized guards
    for (const [key, guard] of _lastSynthesizedGuards) {
      if (!editor.value.includes(guard)) {
        _userAmendedTalks.add(key);
        _lastSynthesizedGuards.delete(key);
      }
    }
    clearTimeout(parseTimer);parseTimer=setTimeout(parseSource,180);
  });

  // ── Canvas drag → @interact ──
  let dragging=false,lastX=0,lastY=0;
  canvas.addEventListener('pointerdown',e=>{
    dragging=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId);
    if(surface){const r=canvas.getBoundingClientRect();const dpr=Math.min(devicePixelRatio||1,2);surface.registerClick((e.clientX-r.left)*dpr,(e.clientY-r.top)*dpr);}
  });
  canvas.addEventListener('pointerup',()=>dragging=false);
  canvas.addEventListener('pointermove',e=>{
    // Feed mouse position to surface transducer (in pixel coords)
    if(surface){
      const r=canvas.getBoundingClientRect();
      const dpr=Math.min(devicePixelRatio||1,2);
      surface.setMousePos((e.clientX-r.left)*dpr,(e.clientY-r.top)*dpr);
    }
    if(!dragging||!currentTree)return;
    const dx=e.clientX-lastX,dy=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;
    const ia=interactAttrs; if(!ia)return;
    if(ia['drag-x']){const s=+ia['drag-x-scale']||-0.01,mn=ia['drag-x-min']!==undefined?+ia['drag-x-min']:-Infinity,mx=ia['drag-x-max']!==undefined?+ia['drag-x-max']:Infinity;form.setExternal(ia['drag-x'],Math.max(mn,Math.min(mx,(form.state[ia['drag-x']]||0)+dx*s)));}
    if(ia['drag-y']){const s=+ia['drag-y-scale']||0.02,mn=ia['drag-y-min']!==undefined?+ia['drag-y-min']:-Infinity,mx=ia['drag-y-max']!==undefined?+ia['drag-y-max']:Infinity;form.setExternal(ia['drag-y'],Math.max(mn,Math.min(mx,(form.state[ia['drag-y']]||0)+dy*s)));}
  });
  canvas.addEventListener('wheel',e=>{
    if(document.pointerLockElement === canvas) return;
    if(!currentTree)return;
    const ia=interactAttrs; if(!ia||!ia['scroll'])return;
    e.preventDefault();
    const s=+ia['scroll-scale']||0.005,mn=ia['scroll-min']!==undefined?+ia['scroll-min']:-Infinity,mx=ia['scroll-max']!==undefined?+ia['scroll-max']:Infinity;
    form.setExternal(ia['scroll'],Math.max(mn,Math.min(mx,(form.state[ia['scroll']]||0)+e.deltaY*s)));
  },{passive:false});

  // ── Surface text-editor input ──
  canvas.addEventListener('pointerdown',e=>{
    if(surface){
      const r=canvas.getBoundingClientRect();
      const dpr=Math.min(devicePixelRatio||1,2);
      if(surface.handleEditorClick((e.clientX-r.left)*dpr,(e.clientY-r.top)*dpr)){
        surfaceDirty=true; surface._editorDirty=true;
      }
    }
  });
  document.addEventListener('keydown',e=>{
    if(surface && surface.focusedEditor){
      if(e.target===editor||e.target===prompt) return;
      if(surface.handleEditorKey(e.key, e.shiftKey, e.ctrlKey, e.metaKey)){
        e.preventDefault();
        surfaceDirty=true; surface._editorDirty=true;
      }
    }
  });
  canvas.addEventListener('wheel',e2=>{
    if(surface && surface.focusedEditor){
      if(surface.handleEditorScroll(e2.deltaY)){
        e2.preventDefault();
        surfaceDirty=true; surface._editorDirty=true;
        return;
      }
    }
  },{passive:false});

  // ── Pointer-lock menu bridge: when lock releases, set menuopen=1 if field exists ──
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (!locked && form && 'menuopen' in form.state) {
      form.setExternal('menuopen', 1);
      gpu.setFormField('menuopen', 1);
    }
    if (locked && form && 'menuopen' in form.state) {
      form.setExternal('menuopen', 0);
      gpu.setFormField('menuopen', 0);
    }
  });

  // ── Generate ──
  function addMsg(text,cls){const d=document.createElement('div');d.className=`msg msg-${cls}`;d.textContent=text;messages.appendChild(d);messages.scrollTop=messages.scrollHeight;return d;}

  async function generate(p){
    if(!p.trim())return;
    sendBtn.disabled=true;
    addMsg(p,'user');
    const thinking=addMsg('generating','thinking');
    try{
      let lines=0;
      const full=await callClaude(p,txt=>{
        lines=txt.split('\n').length;
        thinking.textContent=`generating\u2026 ${lines} lines`;
      });
      let rexSrc=full.replace(/```[a-z]*\n?/gi,'').replace(/```/g,'').trim();
      thinking.textContent=`\u2713 ${rexSrc.split('\n').length} lines`;
      thinking.className='msg msg-claude';
      const pre=document.createElement('pre');
      pre.style.cssText='font-size:9px;color:var(--dim);margin-top:4px;max-height:60px;overflow:auto;white-space:pre;';
      pre.textContent=rexSrc.slice(0,300)+(rexSrc.length>300?'\n\u2026':'');
      thinking.appendChild(pre);
      editor.value=rexSrc; lastSrc=''; Rex.resetLexCache(); gpu.invalidate(); form.state={}; parseSource();
      flushLog();
      if(currentTree){
        const nc=(function count(n){let c=1;for(const ch of n.children)c+=count(ch);return c;})(currentTree);
        addMsg(`compiled: ${nc} nodes \u00b7 ${gpu._optics?.length||0} optics \u00b7 ${gpu._heapSize||0}B heap`,'sys');
      }
      // Auto-rename tab to prompt
      const tab = tabMgr.getActive();
      if (tab && p.length < 30) tabMgr.renameTab(tab.id, p);
    }catch(e){
      thinking.textContent=`\u2717 ${e.message}`; thinking.className='msg msg-err';
      log(`Claude: ${e.message}`,'err'); flushLog();
    }
    sendBtn.disabled=false;
  }

  sendBtn.addEventListener('click',()=>{generate(prompt.value);prompt.value='';});
  prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){generate(prompt.value);prompt.value='';}});
  document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{generate(c.dataset.p);}));

  // ── Render loop with tab suspension ──
  let tick=0;
  let currentRafId = null;

  function frame(){
    if(currentTree&&gpuOk){
      try{
        const sc=gpu._structureChanged; gpu._structureChanged=false;
        try {
          gpu.transduce(currentTree,sc);
          if(sc){
            flushLog();if(gpu._heapInfo)heapView.innerHTML=gpu._heapInfo;
            const cd=`canvas: ${canvas.width}x${canvas.height} pipelines:${gpu.pipelines.size} cmds:${gpu._commandList.length}`;
            log(cd,'ok'); setOverlay(''); flushLog();
          }
        } catch(e2) {
          setOverlay('Compile error:\n'+e2.message);
          log('compile: '+e2.message,'err'); flushLog();
        }
        // PCN transducer: learn from behaviour events
        if(pcn){
          try{
            const pcnEnc=gpu.device.createCommandEncoder({label:'pcn'});
            pcn.transduce(pcnEnc);
            gpu.device.queue.submit([pcnEnc.finish()]);
          }catch(e4){/* silent — PCN errors don't block rendering */}
        }
        // Deferred surface recompile (Phase 3C: avoids blocking main thread on keystroke)
        if(surfaceDirty&&surface&&currentTree){
          try{ surface.compile(currentTree, canvas.width, canvas.height); }catch(e5){log(`surface recompile: ${e5.message}`,'err');}
          surfaceDirty=false;
        }
        // Audio transducer: tick scheduler + update FFT texture
        if(audioInitialized){
          try {
            // Ensure FFT texture exists on GPU (created once, 1D 1024-wide R8Unorm)
            if(gpu.device && !gpu._fftTexture){
              gpu._fftTexture = gpu.device.createTexture({
                label: 'fft',
                size: { width: 1024, height: 1 },
                format: 'r8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
              gpu._fftSampler = gpu.device.createSampler({ magFilter:'linear', minFilter:'linear' });
              log('audio: FFT texture created (1024×1 r8unorm)', 'ok');
            }
            audio.transduce(currentTree, false);
          } catch(ea){ log(`audio: ${ea.message}`,'err'); }
        }
        // Surface transducer: composite 2D over 3D (or solo)
        if(surface&&surface.active){
          try{
            const has3D=gpu._commandList&&gpu._commandList.length>0;
            surface.setCompositeMode(has3D?'overlay':'solo');
            surface.execute();
          }catch(e3){log(`surface: ${e3.message}`,'err');}
        }
        // PCN feedback: apply crystallized constraints to behaviour as advisory slot hints (~5s)
        if(pcn && tick%300===0){
          try{
            const constraints=pcn.getFeedbackConstraints();
            for(const c of constraints){
              if(c.confidence>0.9){
                const shrub=behaviour._shrubs.get(c.shrub);
                if(shrub){
                  shrub.slots.set(`__pcn_min_${c.slot}`,c.suggestedMin);
                  shrub.slots.set(`__pcn_max_${c.slot}`,c.suggestedMax);
                }
              }
            }
          }catch(e6){/* feedback errors non-fatal */}
        }
      }catch(e){log(`frame: ${e.message}`,'err');}
    }
    tick++; if(tick%60===0)flushLog();
    currentRafId = requestAnimationFrame(frame);
    tabMgr.setRafId(currentRafId);
  }

  window._restartRenderLoop = function() {
    if (currentRafId) cancelAnimationFrame(currentRafId);
    // Restore state from active tab
    const tab = tabMgr.getActive();
    if (tab) {
      lastSrc = ''; Rex.resetLexCache(); // Force re-parse
      parseSource();
    }
    currentRafId = requestAnimationFrame(frame);
    tabMgr.setRafId(currentRafId);
  };

  // Start initial render loop
  currentRafId = requestAnimationFrame(frame);
  tabMgr.setRafId(currentRafId);

  // ── Drag resize handles ──
  function dragHandle(el, onMove) {
    el.addEventListener('mousedown',e=>{
      e.preventDefault(); el.classList.add('active');
      const move=e2=>{onMove(e2);};
      const up=()=>{el.classList.remove('active');window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);};
      window.addEventListener('mousemove',move); window.addEventListener('mouseup',up);
    });
  }

  const shell=document.getElementById('shell');

  let colW=[320,null];

  function applyColLayout(){
    const formC=document.getElementById('form-sidebar').classList.contains('collapsed');
    const edC  =document.getElementById('editor-pane').classList.contains('collapsed');
    const canC =document.getElementById('canvas-pane').classList.contains('collapsed');
    const c0=formC?'26px':(colW[0]+'px');
    const c1=edC  ?'26px':(colW[1]!==null?colW[1]+'px':'1fr');
    const c2=canC ?'26px':'1fr';
    shell.style.gridTemplateColumns=`${c0} 4px ${c1} 4px ${c2}`;
    setTimeout(resizeCanvas,0);
  }

  let colDrag0StartX, colDrag0StartW;
  dragHandle(document.getElementById('dh-col-1'),e=>{
    if(colDrag0StartX===undefined){colDrag0StartX=e.clientX;colDrag0StartW=colW[0];}
    colW[0]=Math.max(60,colDrag0StartW+(e.clientX-colDrag0StartX));
    applyColLayout();
  });
  document.getElementById('dh-col-1').addEventListener('mousedown',e=>{colDrag0StartX=e.clientX;colDrag0StartW=colW[0];});

  let colDrag1StartX, colDrag1StartW;
  dragHandle(document.getElementById('dh-col-2'),e=>{
    if(colDrag1StartX===undefined){colDrag1StartX=e.clientX;colDrag1StartW=colW[1];}
    colW[1]=Math.max(60,(colDrag1StartW||300)+(e.clientX-colDrag1StartX));
    applyColLayout();
  });
  document.getElementById('dh-col-2').addEventListener('mousedown',e=>{
    colDrag1StartX=e.clientX;
    const edRect=document.getElementById('editor-pane').getBoundingClientRect();
    colDrag1StartW=edRect.width; colW[1]=edRect.width;
  });

  // Row sizes
  let rowH=180;
  {
    let startY=0, startH=0;
    const handle=document.getElementById('dh-row-bot');
    handle.addEventListener('mousedown',e=>{
      e.preventDefault();
      startY=e.clientY;
      startH=document.getElementById('bottom').getBoundingClientRect().height;
      handle.classList.add('active');
      const move=e2=>{
        const dy=e2.clientY-startY;
        rowH=Math.max(26,Math.min(shell.getBoundingClientRect().height-100,startH-dy));
        shell.style.gridTemplateRows=`40px 28px 4px 1fr 4px ${rowH}px`;
        resizeCanvas();
      };
      const up=()=>{handle.classList.remove('active');window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);};
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',up);
    });
  }

  // ── Collapse panes ──
  function collapseToggle(paneId, isBot){
    const pane=document.getElementById(paneId);
    pane.classList.toggle('collapsed');
    if(!isBot) applyColLayout();
  }
  document.getElementById('form-title').addEventListener('click',()=>collapseToggle('form-sidebar',false));
  document.getElementById('editor-title').addEventListener('click',()=>collapseToggle('editor-pane',false));
  document.getElementById('canvas-title').addEventListener('click',()=>{collapseToggle('canvas-pane',false);setTimeout(resizeCanvas,0);});
  document.getElementById('chat-title').addEventListener('click',()=>document.getElementById('chat-pane').classList.toggle('collapsed'));
  document.getElementById('log-title').addEventListener('click',()=>document.getElementById('log-pane').classList.toggle('collapsed'));
  document.getElementById('heap-title').addEventListener('click',()=>document.getElementById('heap-pane').classList.toggle('collapsed'));

  // ── Breakpoints ──
  function applyBreakpoint(){
    const w=window.innerWidth;
    const bp=w>=960?'wide':w>=600?'medium':'narrow';
    const edPane=document.getElementById('editor-pane');
    const canPane=document.getElementById('canvas-pane');
    if(bp==='wide'){
      edPane.classList.remove('collapsed');
      canPane.classList.remove('collapsed');
      colW[0]=320; rowH=180;
    } else if(bp==='medium'){
      edPane.classList.add('collapsed');
      canPane.classList.remove('collapsed');
      colW[0]=260; rowH=150;
    } else {
      edPane.classList.add('collapsed');
      canPane.classList.add('collapsed');
      colW[0]=0; rowH=120;
    }
    shell.style.gridTemplateRows=`40px 28px 4px 1fr 4px ${rowH}px`;
    applyColLayout();
  }
  window.addEventListener('resize',()=>{applyBreakpoint();resizeCanvas();});
  applyBreakpoint();
  resizeCanvas();

  // ── Default demo: load a starter Rex program so the page isn't blank ──
  if (!editor.value.trim()) {
    editor.value = `@struct Params
  @field res   :type f32x2
  @field time  :type f32
  @field mouse :type f32x2
  @field seed  :type f32
  @field zoom  :type f32
  @field twist :type f32
  @field hue   :type f32
  @field speed :type f32

@shader fractal
  #import Params
  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @group(0) @binding(0) var<uniform> u: Params;
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut; o.pos = vec4f(p[vi],0,1); o.uv = p[vi]; return o;
  }
  fn hash(p: vec2f) -> f32 {
    var q = fract(p * vec2f(127.1, 311.7)); q += dot(q, q + 19.19); return fract(q.x * q.y);
  }
  fn fbm(p: vec2f) -> f32 {
    var v = 0.0; var a = 0.5; var q = p;
    for (var i=0; i<6; i=i+1) {
      v += a * (sin(q.x*7.3+u.time*0.3)*sin(q.y*5.1+u.time*0.2) + hash(q)*0.15);
      q = q * 2.1 + vec2f(1.7, 0.9); a *= 0.48;
    }
    return v;
  }
  fn julia(c: vec2f, seed: vec2f) -> vec2f {
    var z = c; var ji = 0;
    for (var i = 0; i < 96; i = i + 1) {
      z = vec2f(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + seed;
      ji = i;
      if (dot(z,z) > 256.0) { break; }
    }
    // Smooth iteration count via continuous escape (Hubbard-Douady potential)
    let fi = f32(ji) - log2(log2(dot(z,z))) + 4.0;
    return vec2f(fi / 96.0, dot(z,z));
  }
  fn hsv(h: f32, s: f32, v: f32) -> vec3f {
    let k = vec4f(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    let p = abs(fract(vec3f(h)+k.xyz)*6.0 - k.www);
    return v * mix(k.xxx, clamp(p-k.xxx, vec3f(0.0), vec3f(1.0)), s);
  }
  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    // zoom: divide so higher value = zoom in
    var p = v.uv * vec2f(asp, 1.0) / u.zoom;
    let t = u.time * u.speed;
    // Twist the coordinate space
    let angle = atan2(p.y, p.x) + u.twist + sin(t*0.07)*0.3;
    let r = length(p);
    p = vec2f(cos(angle), sin(angle)) * r;
    // Julia seed orbits + mouse steering
    let m = (u.mouse - 0.5) * 2.0 * vec2f(asp, 1.0);
    let orbit = vec2f(sin(t*0.17)*0.6 + sin(t*0.11)*0.2, cos(t*0.13)*0.6 + cos(t*0.07)*0.2);
    let seed = (orbit + m * 0.25) * u.seed;
    let jv = julia(p, seed);
    let j = jv.x;
    let noise = fbm(p * 0.6 + vec2f(t*0.04));
    // Orbit trap: distance to unit circle
    let trap = abs(length(p) - 0.5);
    let blended = mix(j, noise*0.5+0.5, 0.25) + trap*0.08;
    // Triple-layer hue interference
    let h1 = fract(j * 2.1 + u.hue + t*0.03);
    let h2 = fract(j * 5.3 + u.hue*1.3 + t*0.05);
    let h3 = fract(noise * 3.0 + u.hue*0.7);
    let c1 = hsv(h1, 0.9, pow(clamp(j,0.0,1.0), 0.55)*1.3);
    let c2 = hsv(h2, 0.7, pow(clamp(j,0.0,1.0), 0.8));
    let c3 = hsv(h3, 0.5, 0.4);
    var col = c1*0.6 + c2*0.3 + c3*0.1;
    // Glow halo on escaped boundary
    let edgeGlow = exp(-j * 4.0) * 2.0;
    col += hsv(fract(u.hue + 0.5), 1.0, edgeGlow) * 0.4;
    // Vignette
    let vign = 1.0 - smoothstep(0.6, 1.5, length(v.uv));
    return vec4f(col * vign, 1.0);
  }

@shader mandelbrot
  #import Params
  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @group(0) @binding(0) var<uniform> u: Params;
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut; o.pos = vec4f(p[vi],0,1); o.uv = p[vi]; return o;
  }
  fn hsv(h: f32, s: f32, v: f32) -> vec3f {
    let k = vec4f(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    let p = abs(fract(vec3f(h)+k.xyz)*6.0-k.www);
    return v * mix(k.xxx, clamp(p-k.xxx, vec3f(0.0), vec3f(1.0)), s);
  }
  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let t = u.time * u.speed * 0.15;
    // Animated zoom into a deep Mandelbrot point
    let center = vec2f(-0.7435669, 0.1314023);
    let zf = pow(u.zoom * 0.5, 2.5) * exp(t * 0.08 * u.seed);
    var c = v.uv * vec2f(asp, 1.0) / zf + center;
    // Mouse shifts the center
    c += (u.mouse - 0.5) * 0.002 / zf;
    // Twist
    let ang = u.twist;
    c = vec2f(c.x*cos(ang)-c.y*sin(ang), c.x*sin(ang)+c.y*cos(ang));
    var z = vec2f(0.0);
    var escaped = false;
    var iesc = 128;
    for (var i = 0; i < 128; i = i + 1) {
      z = vec2f(z.x*z.x-z.y*z.y, 2.0*z.x*z.y) + c;
      if (dot(z,z) > 256.0) { escaped = true; iesc = i; break; }
    }
    if (!escaped) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    let fi = f32(iesc) - log2(log2(dot(z,z))) + 4.0;
    let fn0 = fi / 128.0;
    // Bands of colour cycling with time
    let h1 = fract(fn0*3.0 + u.hue + t*0.4);
    let h2 = fract(fn0*7.0 + u.hue*1.7 + t*0.2);
    let bright = pow(fn0, 0.45);
    let col = hsv(h1, 0.95, bright)*0.7 + hsv(h2, 0.6, bright*0.5)*0.3;
    let edgeGlow = exp(-fn0*6.0)*1.5;
    return vec4f(col + hsv(fract(u.hue+0.33), 1.0, edgeGlow)*0.5, 1.0);
  }

@shader tunnel
  #import Params
  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @group(0) @binding(0) var<uniform> u: Params;
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut; o.pos = vec4f(p[vi],0,1); o.uv = p[vi]; return o;
  }
  fn hsv(h: f32, s: f32, v: f32) -> vec3f {
    let k = vec4f(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    let p = abs(fract(vec3f(h)+k.xyz)*6.0-k.www);
    return v * mix(k.xxx, clamp(p-k.xxx, vec3f(0.0), vec3f(1.0)), s);
  }
  fn hexDist(p: vec2f) -> f32 {
    let q = abs(p);
    return max(q.x*0.866025 + q.y*0.5, q.y) - 1.0;
  }
  fn hexGrid(uv: vec2f, scale: f32) -> vec3f {
    let s = vec2f(1.732051, 1.0) * scale;
    var gid = round(uv / s);
    var best = 9999.0; var bestId = vec2f(0.0);
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      for (var dy = -1; dy <= 1; dy = dy + 1) {
        let id = gid + vec2f(f32(dx), f32(dy));
        let ctr = id * s;
        let d = hexDist((uv - ctr) / scale);
        if (d < best) { best = d; bestId = id; }
      }
    }
    return vec3f(best, bestId);
  }
  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let p = v.uv * vec2f(asp, 1.0);
    let t = u.time * u.speed;
    // Twist the angle with time and control
    let baseAng = atan2(p.y, p.x);
    let ang = baseAng / 3.14159 + u.twist + t * 0.04;
    let rad = length(p);
    // Perspective warp: depth = 1/r, zoom controls how fast we fly in
    let depth = (1.0 / (rad + 0.02)) * u.zoom * 0.5;
    let texV = depth - t * 0.8;
    // Hex grid in tunnel coordinates
    let hv = hexGrid(vec2f(ang * 6.0, texV), 0.5);
    let hexD = hv.x; let hexId = hv.yz;
    // Edge glow on each hex cell
    let edge = 1.0 - smoothstep(-0.04, 0.04, hexD);
    let fill = smoothstep(0.0, 0.3, hexD) * 0.15;
    // Unique colour per cell: hash the cell id
    let cellH = fract(sin(dot(hexId, vec2f(127.1, 311.7))) * 43758.5);
    let hue = fract(cellH + u.hue + t * 0.06 + depth * 0.02);
    let m = u.mouse - 0.5;
    let hueShift = fract(hue + m.x * 0.3 + ang * 0.1);
    // Depth fog: bright at centre, dark at edge
    let fog = pow(1.0 - clamp(rad*0.55, 0.0, 1.0), 2.0);
    let edgeCol = hsv(hueShift, 1.0, 1.0) * edge * fog * 2.5;
    let fillCol = hsv(fract(hueShift+0.5), 0.6, fill) * fog;
    // Central glow
    let glow = exp(-rad * 3.0) * 0.8;
    let glowCol = hsv(fract(u.hue + t*0.05), 0.8, glow);
    return vec4f(edgeCol + fillCol + glowCol, 1.0);
  }

@shader warp
  #import Params
  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @group(0) @binding(0) var<uniform> u: Params;
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut; o.pos = vec4f(p[vi],0,1); o.uv = p[vi]; return o;
  }
  fn hsv(h: f32, s: f32, v: f32) -> vec3f {
    let k = vec4f(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    let p = abs(fract(vec3f(h)+k.xyz)*6.0-k.www);
    return v * mix(k.xxx, clamp(p-k.xxx, vec3f(0.0), vec3f(1.0)), s);
  }
  fn sdTorus(p: vec3f, t: vec2f) -> f32 {
    let q = vec2f(length(p.xz)-t.x, p.y);
    return length(q)-t.y;
  }
  fn sdSphere(p: vec3f, r: f32) -> f32 { return length(p)-r; }
  fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = clamp(0.5+0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
  }
  fn scene(p: vec3f, t: f32) -> f32 {
    // Rotating nested tori + pulsing sphere
    let ang1 = t * 0.7 + p.y * 0.3;
    let ang2 = t * 0.4;
    let r1 = vec3f(p.x*cos(ang1)-p.z*sin(ang1), p.y, p.x*sin(ang1)+p.z*cos(ang1));
    let r2 = vec3f(p.x*cos(ang2)-p.y*sin(ang2), p.x*sin(ang2)+p.y*cos(ang2), p.z);
    let d1 = sdTorus(r1, vec2f(0.9, 0.25));
    let d2 = sdTorus(r2, vec2f(0.55, 0.12));
    let d3 = sdSphere(p, 0.3 + sin(t*1.3)*0.08);
    return smin(smin(d1, d2, 0.15), d3, 0.2);
  }
  fn getNormal(p: vec3f, t: f32) -> vec3f {
    let e = vec2f(0.001, 0.0);
    return normalize(vec3f(
      scene(p+e.xyy,t)-scene(p-e.xyy,t),
      scene(p+e.yxy,t)-scene(p-e.yxy,t),
      scene(p+e.yyx,t)-scene(p-e.yyx,t)
    ));
  }
  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let t = u.time * u.speed * 0.5;
    // Camera orbits the scene
    let m = (u.mouse - 0.5) * 3.14159;
    let camDist = 2.8 / u.zoom;
    let camAng = t * 0.25 + u.twist + m.x;
    let camY = sin(t * 0.15 + m.y) * 1.2;
    let ro = vec3f(cos(camAng)*camDist, camY, sin(camAng)*camDist);
    let lookat = vec3f(0.0);
    let fwd = normalize(lookat - ro);
    let right = normalize(cross(vec3f(0,1,0), fwd));
    let up = cross(fwd, right);
    let rd = normalize(v.uv.x*vec2f(asp,1.0).x*right + v.uv.y*up + fwd*1.5);
    // Raymarch
    var d = 0.0; var hit = false; var steps = 0;
    for (var i = 0; i < 96; i = i + 1) {
      let rp = ro + rd * d;
      let sd = scene(rp, t) * u.seed;
      if (sd < 0.001) { hit = true; steps = i; break; }
      if (d > 12.0) { steps = i; break; }
      d = d + sd;
      steps = i;
    }
    if (!hit) {
      // Background: starfield + nebula
      let nebula = fract(sin(dot(rd.xy, vec2f(127.1,311.7)))*43758.5);
      let stars = step(0.997, nebula) * 2.0;
      let bgH = fract(rd.x*0.3 + rd.y*0.2 + u.hue + t*0.02);
      let bg = hsv(bgH, 0.7, 0.04) + vec3f(stars*0.6);
      return vec4f(bg, 1.0);
    }
    let hp = ro + rd * d;
    let n = getNormal(hp, t);
    // Lighting: two coloured lights + rim
    let l1 = normalize(vec3f(cos(t*0.5), 0.8, sin(t*0.5)));
    let l2 = normalize(vec3f(-cos(t*0.3+1.0), -0.5, -sin(t*0.3+1.0)));
    let diff1 = max(dot(n, l1), 0.0);
    let diff2 = max(dot(n, l2), 0.0);
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let ao = 1.0 - f32(steps)/96.0;
    let h1 = fract(u.hue + 0.0);
    let h2 = fract(u.hue + 0.33);
    let h3 = fract(u.hue + 0.66);
    var col = hsv(h1, 0.9, diff1*1.2) + hsv(h2, 0.8, diff2*0.8);
    col += hsv(h3, 1.0, rim*1.5);
    col *= ao * 0.8 + 0.2;
    // Specular
    let refl = reflect(rd, n);
    let spec = pow(max(dot(refl, l1), 0.0), 32.0);
    col += vec3f(spec * 0.6);
    return vec4f(col, 1.0);
  }

@buffer params :struct Params :usage [uniform]
  @data
    :res     (canvas-size)
    :time    (elapsed)
    :mouse   (mouse-pos)
    :seed    (form/seed)
    :zoom    (form/zoom)
    :twist   (form/twist)
    :hue     (form/hue)
    :speed   (form/speed)

@pipeline frac :vertex fractal    :fragment fractal    :format canvas :topology triangle-list
@pipeline mand :vertex mandelbrot :fragment mandelbrot :format canvas :topology triangle-list
@pipeline tun  :vertex tunnel     :fragment tunnel     :format canvas :topology triangle-list
@pipeline warp :vertex warp       :fragment warp       :format canvas :topology triangle-list

@pass main :clear [0.01 0.01 0.02 1]
  @draw :pipeline (form/mode) :vertices 6
    @bind 0 :buffer params

@form controls :title "Hypnosis Engine"
  @field mode  :type select :label "Mode"  :options [frac mand tun warp] :default frac
  @field speed :type range  :label "Speed"  :min 0.05 :max 4    :step 0.01  :default 0.8
  @field zoom  :type range  :label "Zoom"   :min 0.3  :max 8    :step 0.01  :default 1.0
  @field twist :type range  :label "Twist"  :min -3.14 :max 3.14 :step 0.01 :default 0.0
  @field hue   :type range  :label "Hue"    :min 0    :max 1    :step 0.005 :default 0.0
  @field seed  :type range  :label "Seed"   :min 0.1  :max 2.5  :step 0.01  :default 1.0

@interact :scroll zoom :scroll-scale 0.02`;
    parseSource();
  }

  log('RexGPU ready \u00b7 type a prompt to generate Rex notation','ok');
  flushLog();
} catch(fatal) { console.error('RexGPU init failed:', fatal); document.getElementById('gpu-overlay').textContent = 'Init error: ' + fatal.message; }
})();
