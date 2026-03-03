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
import { expandAgentSugar, registerDelegate, assemblePrompt, callLLM, buildToolSchema } from './rex-agent.js';
import { RexMediaSugar } from './rex-media.js';

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

  // ── Example loader ──
  const exampleSelect = document.getElementById('example-select');
  if (exampleSelect && window.__REX_EXAMPLES__) {
    for (const ex of window.__REX_EXAMPLES__) {
      const opt = document.createElement('option');
      opt.value = ex.name;
      opt.textContent = ex.name;
      exampleSelect.appendChild(opt);
    }
    exampleSelect.addEventListener('change', () => {
      const name = exampleSelect.value;
      if (!name) return;
      const ex = window.__REX_EXAMPLES__.find(e => e.name === name);
      if (!ex) return;
      const tab = tabMgr.createTab(name);
      editor.value = ex.src;
      lastSrc = '';
      Rex.resetLexCache();
      gpu.invalidate();
      form.state = {};
      parseSource();
      exampleSelect.value = '';
    });
  }

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

  // ═══════════════════════════════════════════════════════════════════
  // FLOATING PANEL SYSTEM
  // ═══════════════════════════════════════════════════════════════════
  const panelDock = document.getElementById('panel-dock');
  let topZ = 10;

  const panelDefaults = {
    editor: { left:12, top:48, width:380, height:null, heightCalc:'calc(100vh - 160px)' },
    form:   { right:12, top:48, width:280, height:null, heightCalc:'calc(50vh - 40px)' },
    log:    { left:12, bottom:80, width:360, height:200 },
    heap:   { right:12, bottom:80, width:280, height:200 },
  };

  const panels = new Map();

  function initPanel(el) {
    const name = el.dataset.panel;
    const bar = el.querySelector('.fp-bar');
    const minBtn = el.querySelector('.fp-min');
    const closeBtn = el.querySelector('.fp-close');
    const defaults = panelDefaults[name];

    // Try restore from localStorage
    const saved = localStorage.getItem(`fp_${name}`);
    if (saved) {
      try {
        const s = JSON.parse(saved);
        el.style.left = s.left + 'px';
        el.style.top = s.top + 'px';
        el.style.width = s.width + 'px';
        el.style.height = s.height + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      } catch { /* use CSS defaults */ }
    }

    const state = { el, name, minimized: false, hidden: false };
    panels.set(name, state);

    // Click to raise
    el.addEventListener('mousedown', () => {
      topZ++;
      el.style.zIndex = topZ;
      panels.forEach(p => p.el.classList.remove('focused'));
      el.classList.add('focused');
    });

    // ── Drag (title bar) ──
    let dragStartX, dragStartY, dragElLeft, dragElTop;
    bar.addEventListener('mousedown', e => {
      if (e.target.closest('.fp-btn')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragElLeft = rect.left;
      dragElTop = rect.top;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';

      const move = e2 => {
        const dx = e2.clientX - dragStartX;
        const dy = e2.clientY - dragStartY;
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, dragElLeft + dx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 30, dragElTop + dy)) + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePanel(name);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Double-click title bar to maximize/restore
    let preMaxRect = null;
    bar.addEventListener('dblclick', e => {
      if (e.target.closest('.fp-btn')) return;
      if (preMaxRect) {
        el.style.left = preMaxRect.left + 'px';
        el.style.top = preMaxRect.top + 'px';
        el.style.width = preMaxRect.width + 'px';
        el.style.height = preMaxRect.height + 'px';
        preMaxRect = null;
      } else {
        const r = el.getBoundingClientRect();
        preMaxRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        el.style.left = '8px'; el.style.top = '40px';
        el.style.width = 'calc(100vw - 16px)';
        el.style.height = 'calc(100vh - 48px)';
      }
      el.style.right = 'auto'; el.style.bottom = 'auto';
      savePanel(name);
    });

    // ── Resize (edge drag) ──
    const EDGE = 6;
    el.addEventListener('mousemove', e => {
      if (e.buttons) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const w = r.width, h = r.height;
      const onL = x < EDGE, onR = x > w - EDGE, onT = y < EDGE, onB = y > h - EDGE;
      if (onT && onL) el.style.cursor = 'nw-resize';
      else if (onT && onR) el.style.cursor = 'ne-resize';
      else if (onB && onL) el.style.cursor = 'sw-resize';
      else if (onB && onR) el.style.cursor = 'se-resize';
      else if (onL) el.style.cursor = 'w-resize';
      else if (onR) el.style.cursor = 'e-resize';
      else if (onT) el.style.cursor = 'n-resize';
      else if (onB) el.style.cursor = 's-resize';
      else el.style.cursor = '';
    });

    el.addEventListener('mousedown', e => {
      if (e.target.closest('.fp-bar') || e.target.closest('.fp-btn')) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const w = r.width, h = r.height;
      const onL = x < EDGE, onR = x > w - EDGE, onT = y < EDGE, onB = y > h - EDGE;
      if (!onL && !onR && !onT && !onB) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.width = r.width + 'px'; el.style.height = r.height + 'px';

      const move = e2 => {
        const dx = e2.clientX - startX, dy = e2.clientY - startY;
        if (onR) el.style.width = Math.max(200, startRect.width + dx) + 'px';
        if (onB) el.style.height = Math.max(120, startRect.height + dy) + 'px';
        if (onL) { el.style.left = (startRect.left + dx) + 'px'; el.style.width = Math.max(200, startRect.width - dx) + 'px'; }
        if (onT) { el.style.top = (startRect.top + dy) + 'px'; el.style.height = Math.max(120, startRect.height - dy) + 'px'; }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePanel(name);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // ── Minimize ──
    minBtn.addEventListener('click', e => {
      e.stopPropagation();
      el.classList.add('minimizing');
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('minimizing');
        state.minimized = true;
        addDockPill(name);
      }, 180);
    });

    // ── Close (same as minimize for now) ──
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      el.classList.add('minimizing');
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('minimizing');
        state.hidden = true;
        addDockPill(name);
      }, 180);
    });
  }

  function savePanel(name) {
    const state = panels.get(name);
    if (!state) return;
    const r = state.el.getBoundingClientRect();
    localStorage.setItem(`fp_${name}`, JSON.stringify({
      left: r.left, top: r.top, width: r.width, height: r.height
    }));
  }

  function addDockPill(name) {
    // Remove existing pill for this panel
    const existing = panelDock.querySelector(`[data-dock="${name}"]`);
    if (existing) existing.remove();

    const pill = document.createElement('div');
    pill.className = 'dock-pill';
    pill.dataset.dock = name;
    const icons = { editor:'&#9998;', form:'&#9881;', log:'&#9656;', heap:'&#9638;' };
    const labels = { editor:'Source', form:'Properties', log:'Log', heap:'Heap' };
    pill.innerHTML = `<span class="dock-icon">${icons[name]||''}</span>${labels[name]||name}`;
    pill.addEventListener('click', () => restorePanel(name));
    panelDock.appendChild(pill);
  }

  function restorePanel(name) {
    const state = panels.get(name);
    if (!state) return;
    state.el.classList.remove('hidden');
    state.el.classList.add('restoring');
    state.minimized = false;
    state.hidden = false;
    topZ++;
    state.el.style.zIndex = topZ;
    setTimeout(() => state.el.classList.remove('restoring'), 220);
    const pill = panelDock.querySelector(`[data-dock="${name}"]`);
    if (pill) pill.remove();
  }

  // Initialize all floating panels
  document.querySelectorAll('.fp').forEach(initPanel);

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND BAR (expandable bottom-center)
  // ═══════════════════════════════════════════════════════════════════
  const cmdbar = document.getElementById('cmdbar');
  let cmdExpanded = false;

  function expandCmdbar() {
    if (cmdExpanded) return;
    cmdExpanded = true;
    cmdbar.classList.add('expanded');
    messages.scrollTop = messages.scrollHeight;
  }

  function collapseCmdbar() {
    if (!cmdExpanded) return;
    cmdExpanded = false;
    cmdbar.classList.remove('expanded');
  }

  prompt.addEventListener('focus', expandCmdbar);
  prompt.addEventListener('click', expandCmdbar);
  cmdbar.addEventListener('mousedown', e => {
    // Don't collapse when interacting with the cmdbar
    e.stopPropagation();
  });
  document.addEventListener('mousedown', e => {
    if (cmdExpanded && !cmdbar.contains(e.target)) {
      collapseCmdbar();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && cmdExpanded) collapseCmdbar();
  });

  // ═══════════════════════════════════════════════════════════════════
  // CANVAS RESIZE (full viewport)
  // ═══════════════════════════════════════════════════════════════════
  let gpu, surface;
  const overlay = document.getElementById('gpu-overlay');
  function setOverlay(msg) { if(overlay) overlay.textContent = msg||''; }

  function resizeCanvas(){
    const dpr=Math.min(devicePixelRatio||1,2);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width=Math.floor(w*dpr);
    canvas.height=Math.floor(h*dpr);
    canvas.style.width=w+'px';
    canvas.style.height=h+'px';
    if(gpu){
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
  gpu = new RexGPU(canvas, log);
  setOverlay('Initializing WebGPU\u2026');
  const gpuOk = await gpu.init();
  if (gpuOk) {
    gpuSt.textContent = 'WebGPU ready'; gpuSt.className = 'ok';
    setOverlay('');
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
  let audioInitialized = false;
  async function ensureAudio() {
    if (audioInitialized) return;
    audioInitialized = true;
    const ok = await audio.init();
    if (ok) log('audio: ready', 'ok');
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
    behaviour.pushFormValue(name,val);
    if(bridge) bridge.logFormChange(name, val, prev);
    if(pcn) pcn.bridgeFormEvent(name, val);
  };
  window._currentForm = form;

  // ── Behaviour transducer ──
  const behaviour = new RexBehaviour(log);
  behaviour.onSlotChange = (shrub, slot, val) => {
    if (typeof val === 'number' || typeof val === 'boolean') {
      const numVal = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      gpu.setFormField(slot, numVal);
      form.state[slot] = numVal;
    }
  };
  behaviour.onTalkFired = (record) => { if(pcn) pcn.pushBehaviourEvent(record); };
  behaviour.onSurpriseSignal = (shrub, slot, value, range) => { if(pcn) pcn.pushSurpriseSignal(shrub, slot, value, range); };
  behaviour.getShrubLM = (shrubName) => pcn ? pcn.getShrubLM(shrubName) : null;
  behaviour.getGoalState = (shrub, slot, target, slots) => pcn ? pcn.findGoalState(shrub, slot, target, slots) : null;
  behaviour.onChannelPush = (buffer, field, value) => {
    gpu.setChannelValue(buffer, field, value);
    audio.setParam(buffer, field, value);
  };
  gpu.onReadback = (name, values, meta) => {
    if (!behaviour) return;
    if (meta && meta.typed && typeof values === 'object' && !ArrayBuffer.isView(values)) {
      behaviour.pushFormValue(name, values);
      for (const [k, v] of Object.entries(values)) {
        behaviour.pushFormValue(`${name}/${k}`, v);
      }
      if (meta.toSlot) behaviour.pushFormValue(meta.toSlot, values);
    } else {
      behaviour.pushFormValue(name, values.length === 1 ? values[0] : Array.from(values));
    }
  };
  behaviour.formState = form.state;
  if(surface) {
    surface.formState = form.state; surface.behaviour = behaviour;
    surface.onHitChange = (eid) => { log(`hit: element ${eid}`); };
    surface.onElementClick = (eid, x, y) => {
      log(`click: element ${eid} at (${x|0},${y|0})`);
      if(behaviour) behaviour.fireTalk('_surface','click',{element:eid,x,y});
    };
  }
  form.behaviour = behaviour;
  window._currentBehaviour = behaviour;
  window._pcn = pcn;

  // ── PLAN Bridge (Phase A: localStorage) ──
  const bridge = new PLANBridge(log);
  window._bridge = bridge;

  // ── Agent sugar (v1 compat: register delegate mutation type) ──
  registerDelegate(behaviour);

  // ── Media sugar (fiber-based resource lifecycle) ──
  const mediaSugar = new RexMediaSugar(gpuOk ? gpu.device : null, audio._ctx, log);
  mediaSugar._behaviour = behaviour;  // for audio shrub slot writes
  if (gpuOk) gpu._media = mediaSugar;
  window._agent = { assemblePrompt, callLLM, buildToolSchema };
  window._media = mediaSugar;

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
  let interactAttrs=null;
  let surfaceDirty=false;
  function parseSource(){
    const src=editor.value; if(src===lastSrc&&currentTree)return; lastSrc=src;
    try{
      currentTree=Rex.parse(src);
      currentTree=Rex.expandTemplates(currentTree);
      // Sugar expansion (SugarFiber-Spec §2 steps 3-4)
      mediaSugar.expand(currentTree);                              // @media → @texture/@samples/@shrub
      const agentCompiled = expandAgentSugar(currentTree, log);    // @tool → @talk, @agent → @shrub
      const nc=(function count(n){let c=1;for(const ch of n.children)c+=count(ch);return c;})(currentTree);
      ncEl.textContent=`\u2713 ${nc}`;
      interactAttrs=Rex.find(currentTree,'interact')?.attrs||null;
      form.transduce(currentTree);
      behaviour.transduce(currentTree, true);
      if (gpu.device) {
        gpu._compileDeriveCompute(behaviour.getGpuDerives());
      }
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
      setOverlay('');
    }catch(e){ ncEl.textContent=`\u2717 ${e.message}`; log(`parse: ${e.message}`,'err'); }
  }

  // ── Source amendment: ShrubLM-synthesized rules ──
  const _userAmendedTalks = new Set();
  const _lastSynthesizedGuards = new Map();

  function _escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function _amendSource(rule) {
    const key = `${rule.shrub}/${rule.talk}`;
    if (_userAmendedTalks.has(key)) {
      log(`source-amend: skipping "${key}" — user-amended`, 'warn');
      return;
    }

    const src = editor.value;
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

    const guardPat = /\n([ \t]+)@guard\s+(.+?)(?:\s*;.*)?$/m;
    const guardMatch = afterTalk.match(guardPat);

    const nextBlockPat = /\n(?=\S)/;
    const nextBlock = afterTalk.search(nextBlockPat);
    const inBlock = guardMatch && (nextBlock === -1 || guardMatch.index < nextBlock);

    if (inBlock && guardMatch) {
      const guardLineStart = talkEnd + guardMatch.index;
      const fullGuardLine = guardMatch[0];
      const indent = guardMatch[1] || '  ';
      const existingExpr = guardMatch[2].trim();
      const merged = `(and ${existingExpr} ${rule.guard})`;
      newSrc = src.slice(0, guardLineStart) +
               `\n${indent}@guard ${merged}${comment}` +
               src.slice(guardLineStart + fullGuardLine.length);
    } else {
      const nextChildPat = /\n([ \t]+)@/;
      const childMatch = afterTalk.match(nextChildPat);
      if (childMatch && (nextBlock === -1 || childMatch.index < nextBlock)) {
        const insertPos = talkEnd + childMatch.index;
        newSrc = src.slice(0, insertPos) + `\n  @guard ${rule.guard}${comment}` + src.slice(insertPos);
      } else {
        newSrc = src.slice(0, talkEnd) + `\n  @guard ${rule.guard}${comment}` + src.slice(talkEnd);
      }
    }

    editor.value = newSrc;
    lastSrc = '';
    parseSource();
    _lastSynthesizedGuards.set(key, rule.guard);
    log(`source-amend: injected guard for "${key}": ${rule.guard}`, 'ok');
  }

  if (pcn) {
    pcn.onCrystallize = (rule) => {
      try { _amendSource(rule); }
      catch (e) { log(`source-amend: ${e.message}`, 'err'); }
    };
  }

  editor.addEventListener('input',()=>{
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
    // Don't start drag if clicking on a floating panel
    if (e.target !== canvas) return;
    dragging=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId);
    if(surface){const r=canvas.getBoundingClientRect();const dpr=Math.min(devicePixelRatio||1,2);surface.registerClick((e.clientX-r.left)*dpr,(e.clientY-r.top)*dpr);}
  });
  canvas.addEventListener('pointerup',()=>dragging=false);
  canvas.addEventListener('pointermove',e=>{
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

  // ── Pointer-lock menu bridge ──
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
    expandCmdbar();
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
        // Media per-frame update (importExternalTexture lifetime = current JS task)
        if (mediaSugar) {
          try { mediaSugar.tick(gpu); } catch(em) { log(`media: ${em.message}`, 'err'); }
        }
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
        if(pcn){
          try{
            const pcnEnc=gpu.device.createCommandEncoder({label:'pcn'});
            pcn.transduce(pcnEnc);
            gpu.device.queue.submit([pcnEnc.finish()]);
          }catch(e4){/* silent */}
        }
        if(surfaceDirty&&surface&&currentTree){
          try{ surface.compile(currentTree, canvas.width, canvas.height); }catch(e5){log(`surface recompile: ${e5.message}`,'err');}
          surfaceDirty=false;
        }
        if(audioInitialized){
          try {
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
        if(surface&&surface.active){
          try{
            const has3D=gpu._commandList&&gpu._commandList.length>0;
            surface.setCompositeMode(has3D?'overlay':'solo');
            surface.execute();
          }catch(e3){log(`surface: ${e3.message}`,'err');}
        }
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
    const tab = tabMgr.getActive();
    if (tab) {
      lastSrc = ''; Rex.resetLexCache();
      parseSource();
    }
    currentRafId = requestAnimationFrame(frame);
    tabMgr.setRafId(currentRafId);
  };

  // Start render loop
  currentRafId = requestAnimationFrame(frame);
  tabMgr.setRafId(currentRafId);

  // ── Window resize ──
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ── Default demo ──
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
    var p = v.uv * vec2f(asp, 1.0) / u.zoom;
    let t = u.time * u.speed;
    let angle = atan2(p.y, p.x) + u.twist + sin(t*0.07)*0.3;
    let r = length(p);
    p = vec2f(cos(angle), sin(angle)) * r;
    let m = (u.mouse - 0.5) * 2.0 * vec2f(asp, 1.0);
    let orbit = vec2f(sin(t*0.17)*0.6 + sin(t*0.11)*0.2, cos(t*0.13)*0.6 + cos(t*0.07)*0.2);
    let seed = (orbit + m * 0.25) * u.seed;
    let jv = julia(p, seed);
    let j = jv.x;
    let noise = fbm(p * 0.6 + vec2f(t*0.04));
    let trap = abs(length(p) - 0.5);
    let h1 = fract(j * 2.1 + u.hue + t*0.03);
    let h2 = fract(j * 5.3 + u.hue*1.3 + t*0.05);
    let h3 = fract(noise * 3.0 + u.hue*0.7);
    let c1 = hsv(h1, 0.9, pow(clamp(j,0.0,1.0), 0.55)*1.3);
    let c2 = hsv(h2, 0.7, pow(clamp(j,0.0,1.0), 0.8));
    let c3 = hsv(h3, 0.5, 0.4);
    var col = c1*0.6 + c2*0.3 + c3*0.1;
    let edgeGlow = exp(-j * 4.0) * 2.0;
    col += hsv(fract(u.hue + 0.5), 1.0, edgeGlow) * 0.4;
    let vign = 1.0 - smoothstep(0.6, 1.5, length(v.uv));
    return vec4f(col * vign, 1.0);
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

@pipeline frac :vertex fractal :fragment fractal :format canvas :topology triangle-list

@pass main :clear [0.01 0.01 0.02 1]
  @draw :pipeline frac :vertices 6
    @bind 0 :buffer params

@form controls :title "Hypnosis Engine"
  @field speed :type range  :label "Speed"  :min 0.05 :max 4    :step 0.01  :default 0.8
  @field zoom  :type range  :label "Zoom"   :min 0.3  :max 8    :step 0.01  :default 1.0
  @field twist :type range  :label "Twist"  :min -3.14 :max 3.14 :step 0.01 :default 0.0
  @field hue   :type range  :label "Hue"    :min 0    :max 1    :step 0.005 :default 0.0
  @field seed  :type range  :label "Seed"   :min 0.1  :max 2.5  :step 0.01  :default 1.0

@interact :scroll zoom :scroll-scale 0.02`;
    parseSource();
  }

  log('RexGPU ready','ok');
  flushLog();
} catch(fatal) { console.error('RexGPU init failed:', fatal); document.getElementById('gpu-overlay').textContent = 'Init error: ' + fatal.message; }
})();
