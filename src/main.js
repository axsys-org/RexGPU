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

(async()=>{
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
  let gpu;
  const overlay = document.getElementById('gpu-overlay');
  function setOverlay(msg) { if(overlay) overlay.textContent = msg||''; }

  function resizeCanvas(){
    const rect=canvas.parentElement.getBoundingClientRect();
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.floor(rect.width*dpr);
    canvas.height=Math.floor(rect.height*dpr);
    canvas.style.width=rect.width+'px';
    canvas.style.height=(rect.height-30)+'px';
    if(gpu)gpu.invalidate();
    if(surface)surface.invalidate();
  }

  // ── Logs ──
  let logs=[];
  function log(msg,cls=''){logs.push({msg,cls});if(logs.length>300)logs=logs.slice(-200);}
  function flushLog(){logView.innerHTML=logs.map(e=>`<div class="le ${e.cls}">${esc(e.msg)}</div>`).join('');logView.scrollTop=logView.scrollHeight;}

  // ── GPU init ──
  resizeCanvas();
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
  let surface = null;
  if (gpuOk) {
    surface = new RexSurface(gpu.device, gpu.context, gpu.format, log);
  }

  // ── PCN transducer ──
  let pcn = null;
  if (gpuOk) {
    pcn = new RexPCN(gpu.device, log);
    await pcn.init();
  }

  // ── Form transducer ──
  const form = new RexForm(formMount);
  form.onFieldChange = (name,val)=>{
    const prev = form.state[name];
    gpu.setFormField(name,val);
    // Bridge: form → behaviour (recompute derives that reference form values)
    behaviour.pushFormValue(name,val);
    // Bridge: form change → PLAN event log
    if(bridge) bridge.logFormChange(name, val, prev);
    // Bridge: form interaction → PCN episode (batched per frame)
    if(pcn){
      pendingEpisodes.push({
        source:'user-action', shrub:'form', path:name,
        mode:'dif', timestamp:performance.now(),
      });
    }
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
    // Bridge: behaviour slot changes → PCN episodes (batched per frame)
    if (pcn) {
      pendingEpisodes.push({
        source: 'dep',
        shrub: shrub,
        path: slot,
        mode: 'dif',
        timestamp: performance.now(),
      });
    }
  };
  // ── Channel bridge: behaviour → GPU heap ──
  behaviour.onChannelPush = (buffer, field, value) => {
    gpu.setChannelValue(buffer, field, value);
  };
  // ── Readback bridge: GPU → behaviour ──
  gpu.onReadback = (name, values) => {
    // Push readback values as behaviour slot updates: @readback name maps to shrub "_gpu" slot "name"
    // Values array is accessible; first value pushed as scalar
    if(behaviour) behaviour.pushFormValue(name, values.length === 1 ? values[0] : Array.from(values));
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
  let pendingEpisodes=[];  // Phase 4C: batched PCN episodes
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
      if(surface) surface.compile(currentTree, canvas.width, canvas.height);
      gpu._structureChanged=true;
      bridge.snapshotForm(form.state);
      bridge.pinTree(src);
      setOverlay('Compiling\u2026');
    }catch(e){ ncEl.textContent=`\u2717 ${e.message}`; log(`parse: ${e.message}`,'err'); }
  }
  editor.addEventListener('input',()=>{clearTimeout(parseTimer);parseTimer=setTimeout(parseSource,180);});

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
        surfaceDirty=true; // Defer recompile to frame loop
      }
    }
  });
  document.addEventListener('keydown',e=>{
    if(surface && surface.focusedEditor){
      if(e.target===editor||e.target===prompt) return;
      if(surface.handleEditorKey(e.key, e.shiftKey, e.ctrlKey, e.metaKey)){
        e.preventDefault();
        surfaceDirty=true; // Defer recompile to frame loop
      }
    }
  });
  canvas.addEventListener('wheel',e2=>{
    if(surface && surface.focusedEditor){
      if(surface.handleEditorScroll(e2.deltaY)){
        e2.preventDefault();
        surfaceDirty=true; // Defer recompile to frame loop
        return;
      }
    }
  },{passive:false});

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
      editor.value=rexSrc; lastSrc=''; gpu.invalidate(); form.state={}; parseSource();
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
        // Surface transducer: composite 2D over 3D (or solo)
        if(surface&&surface.active){
          try{
            const has3D=gpu._commandList&&gpu._commandList.length>0;
            surface.setCompositeMode(has3D?'overlay':'solo');
            surface.execute();
          }catch(e3){log(`surface: ${e3.message}`,'err');}
        }
        // Flush batched PCN episodes once per frame (Phase 4C)
        if(pcn&&pendingEpisodes.length>0){
          for(const ep of pendingEpisodes) pcn.pushEpisode(ep);
          pendingEpisodes=[];
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
      lastSrc = ''; // Force re-parse
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

  log('RexGPU ready \u00b7 type a prompt to generate Rex notation','ok');
  flushLog();
})();
