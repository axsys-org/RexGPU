// ═══════════════════════════════════════════════════════════════════
// FORM TRANSDUCER
// ═══════════════════════════════════════════════════════════════════

import { Rex } from './rex-parser.js';

export function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

export class RexForm {
  constructor(el){this.el=el;this.state={};this.onFieldChange=null;this._cache=new Map();this._pendingInits=[];this.externalState=null;this.behaviour=null;this._nodeHandlers=new Map();this._fieldHandlers=new Map();this._warnedTypes=new Set();}

  registerNodeType(typeName,handler){this._nodeHandlers.set(typeName,handler);}
  registerFieldType(fieldType,handler){this._fieldHandlers.set(fieldType,handler);}

  // Resolve an attribute value that may be an expression object {expr, rex}
  _attrVal(node,key,fallback){
    const v=node.attrs[key];
    if(v===undefined||v===null) return fallback;
    if(typeof v==='object'&&v.expr!==undefined){
      if(v._compiled===undefined) v._compiled=Rex.compileExpr(v)??false;
      if(!this._evalCtx) this._evalCtx=this._makeFormEvalContext();
      const r=Rex.evalExpr(v._compiled,this._evalCtx);
      return r!==undefined?r:fallback;
    }
    return v;
  }

  _makeFormEvalContext(){
    const self=this;
    return {
      resolve(op,key,args){
        if(op==='ident'){
          // Form fields and external state
          if(self.state[key]!==undefined) return self.state[key];
          if(self.externalState&&self.externalState[key]!==undefined) return self.externalState[key];
          const n=+key;
          if(Number.isFinite(n)) return n;
          return undefined;
        }
        if(op==='slot'){
          if(self.state[key]!==undefined) return self.state[key];
          if(self.externalState&&self.externalState[key]!==undefined) return self.externalState[key];
          return 0;
        }
        if(op==='call'&&self.behaviour&&self.behaviour.hasDef(key)){
          return self.behaviour.callDef(key,args);
        }
        return undefined;
      }
    };
  }

  transduce(tree){
    this._cache.clear();
    this._pendingInits=[];
    this._evalCtx=null; // reset each transduce
    this._warnedTypes.clear();
    const form=Rex.find(tree,'form');
    if(!form){this.el.innerHTML='';return;}
    this.el.innerHTML='';

    // Collect field names defined in this tree to detect stale state and duplicates
    const definedFields=new Set();

    const root=document.createElement('div');
    const formTitle=this._attrVal(form,'title',undefined);
    const formDesc=this._attrVal(form,'description',undefined);
    if(formTitle){const h=document.createElement('div');h.className='rex-form-title';h.textContent=formTitle;root.appendChild(h);}
    if(formDesc){const d=document.createElement('div');d.className='rex-form-desc';d.textContent=formDesc;root.appendChild(d);}
    for(const c of form.children){const r=this._node(c,definedFields);if(r)root.appendChild(r);}
    this.el.appendChild(root);

    // Purge stale state from fields no longer in tree
    for(const key of Object.keys(this.state)){
      if(!definedFields.has(key)) delete this.state[key];
    }

    // Fire deferred onFieldChange after DOM is in the document
    if(this.onFieldChange){
      for(const [n,v] of this._pendingInits) this.onFieldChange(n,v);
    }
    this._pendingInits=[];
  }

  _node(n,definedFields){
    switch(n.type){
      case 'section':{const d=document.createElement('div');d.className='rex-section';const st=this._attrVal(n,'title',n.name);if(st){const h=document.createElement('div');h.className='rex-section-title';h.textContent=st;d.appendChild(h);}for(const c of n.children){const r=this._node(c,definedFields);if(r)d.appendChild(r);}return d;}
      case 'field':return this._field(n,definedFields);
      default:{const h=this._nodeHandlers.get(n.type);if(h)return h.render(n,definedFields,this);return null;}
    }
  }

  _field(n,definedFields){
    const name=n.name;
    if(!name){console.warn('rex-form: @field with no name — skipped');return null;}

    const type=this._attrVal(n,'type','range'),label=this._attrVal(n,'label',name),def=this._attrVal(n,'default',undefined);

    // Duplicate detection
    if(definedFields.has(name)) console.warn(`rex-form: duplicate field name "${name}"`);
    definedFields.add(name);

    // Allow new defaults on re-transduce: if def changed, update state
    if(def!==undefined&&this.state[name]===undefined){
      this.state[name]=this._coerceDefault(type,def);
      this._pendingInits.push([name,this.state[name]]);
    }

    const w=document.createElement('div');w.className='rex-field';
    const lbl=document.createElement('label');lbl.textContent=label;w.appendChild(lbl);

    if(type==='range'){
      const rr=document.createElement('div');rr.className='rr';
      const inp=document.createElement('input');inp.type='range';
      const min=this._num(this._attrVal(n,'min',0),0),max=this._num(this._attrVal(n,'max',1),1),step=this._num(this._attrVal(n,'step',0.01),0.01);
      inp.min=min;inp.max=max;inp.step=Math.max(step,Number.MIN_VALUE); // step must be >0
      inp.value=this.state[name]??(def??min);
      if(this.state[name]===undefined){this.state[name]=+inp.value;this._pendingInits.push([name,+inp.value]);}
      this._cache.set(name,{el:inp,type:'range'});
      const disp=document.createElement('span');disp.className='rv';disp.textContent=(+inp.value).toFixed(2);
      inp.addEventListener('input',()=>{disp.textContent=(+inp.value).toFixed(2);this._emit(name,+inp.value);});
      rr.appendChild(inp);rr.appendChild(disp);w.appendChild(rr);
    } else if(type==='select') {
      const sel=document.createElement('select');
      const opts=this._attrVal(n,'options',[]);
      if(Array.isArray(opts)){
        const frag=document.createDocumentFragment();
        for(const o of opts){
          if(o==null) continue; // skip null/undefined entries
          const opt=document.createElement('option');
          opt.value=typeof o==='object'?o.value:o;
          opt.textContent=typeof o==='object'?o.label:o;
          frag.appendChild(opt);
        }
        sel.appendChild(frag);
      }
      sel.value=this.state[name]??(def??'');
      // Sync: if browser chose a different value (e.g. empty default with options), use what the DOM has
      const resolved=sel.value;
      if(this.state[name]===undefined){this.state[name]=resolved;this._pendingInits.push([name,resolved]);}
      this._cache.set(name,{el:sel,type:'select'});
      sel.addEventListener('change',()=>this._emit(name,sel.value));
      w.appendChild(sel);
    } else if(type==='color') {
      const inp=document.createElement('input');inp.type='color';
      // Validate hex format: browser only accepts #rrggbb
      let colorVal=this.state[name]??(def??'#ffffff');
      if(typeof colorVal!=='string'||!/^#[0-9a-fA-F]{6}$/.test(colorVal)) colorVal='#ffffff';
      inp.value=colorVal;
      if(this.state[name]===undefined){this.state[name]=inp.value;this._pendingInits.push([name,inp.value]);}
      this._cache.set(name,{el:inp,type:'color'});
      inp.addEventListener('input',()=>this._emit(name,inp.value));
      w.appendChild(inp);
    } else if(type==='checkbox') {
      const inp=document.createElement('input');inp.type='checkbox';
      inp.checked=this._toBool(this.state[name]??(def??false));
      if(this.state[name]===undefined){this.state[name]=inp.checked?1:0;this._pendingInits.push([name,inp.checked?1:0]);}
      this._cache.set(name,{el:inp,type:'checkbox'});
      inp.addEventListener('change',()=>this._emit(name,inp.checked?1:0));
      w.appendChild(inp);
    } else if(type==='text'||type==='text-input') {
      const inp=document.createElement('input');inp.type='text';
      inp.placeholder=this._attrVal(n,'placeholder','');
      inp.value=this.state[name]??(def??'');
      if(this.state[name]===undefined){this.state[name]=inp.value;this._pendingInits.push([name,inp.value]);}
      this._cache.set(name,{el:inp,type:'text'});
      inp.addEventListener('input',()=>this._emit(name,inp.value));
      w.appendChild(inp);
    } else if(type==='button') {
      const btn=document.createElement('button');btn.textContent=this._attrVal(n,'label',n.name||'Button');
      btn.className='rex-btn';
      const action=this._attrVal(n,'action',n.name);
      btn.addEventListener('click',()=>this._emit(name,action));
      w.appendChild(btn);
    } else if(type==='toggle') {
      const wrap=document.createElement('label');wrap.className='rex-toggle';
      const inp=document.createElement('input');inp.type='checkbox';
      inp.checked=this._toBool(this.state[name]??(def??false));
      if(this.state[name]===undefined){this.state[name]=inp.checked?1:0;this._pendingInits.push([name,inp.checked?1:0]);}
      this._cache.set(name,{el:inp,type:'toggle'});
      const slider=document.createElement('span');slider.className='rex-toggle-slider';
      inp.addEventListener('change',()=>this._emit(name,inp.checked?1:0));
      wrap.appendChild(inp);wrap.appendChild(slider);w.appendChild(wrap);
    } else if(type==='slider-2d') {
      const pad=document.createElement('div');pad.className='rex-slider2d';
      const padSize=Math.max(this._num(this._attrVal(n,'size',120),120),8); // minimum 8px to avoid div-by-zero
      pad.style.cssText=`width:${padSize}px;height:${padSize}px;position:relative;background:#222;border-radius:4px;cursor:crosshair`;
      const dot=document.createElement('div');dot.className='rex-slider2d-dot';
      dot.style.cssText='position:absolute;width:8px;height:8px;border-radius:50%;background:#fff;pointer-events:none;transform:translate(-50%,-50%)';
      pad.appendChild(dot);
      const minX=this._num(this._attrVal(n,'min-x',0),0),maxX=this._num(this._attrVal(n,'max-x',1),1);
      const minY=this._num(this._attrVal(n,'min-y',0),0),maxY=this._num(this._attrVal(n,'max-y',1),1);
      const xName=this._attrVal(n,'field-x',name+'-x'),yName=this._attrVal(n,'field-y',name+'-y');
      definedFields.add(xName);definedFields.add(yName);
      const update=(ex,ey)=>{
        const r=pad.getBoundingClientRect();
        if(r.width<1||r.height<1) return; // guard against zero-size
        const nx=Math.max(0,Math.min(1,(ex-r.left)/r.width));
        const ny=Math.max(0,Math.min(1,(ey-r.top)/r.height));
        dot.style.left=(nx*100)+'%';dot.style.top=(ny*100)+'%';
        this._emit(xName,minX+nx*(maxX-minX));this._emit(yName,minY+ny*(maxY-minY));
      };
      let drag=false;
      pad.addEventListener('pointerdown',e=>{drag=true;pad.setPointerCapture(e.pointerId);update(e.clientX,e.clientY);});
      pad.addEventListener('pointermove',e=>{if(drag)update(e.clientX,e.clientY);});
      pad.addEventListener('pointerup',()=>{drag=false;});
      if(this.state[xName]===undefined){this.state[xName]=this._num(def,(minX+maxX)/2);this._pendingInits.push([xName,this.state[xName]]);}
      if(this.state[yName]===undefined){this.state[yName]=this._num(def,(minY+maxY)/2);this._pendingInits.push([yName,this.state[yName]]);}
      w.appendChild(pad);
    } else if(type==='file') {
      const inp=document.createElement('input');inp.type='file';
      inp.accept=this._attrVal(n,'accept','');
      this._cache.set(name,{el:inp,type:'file'});
      inp.addEventListener('change',()=>{if(inp.files&&inp.files.length>0)this._emit(name,inp.files[0]);});
      w.appendChild(inp);
    } else if(type==='date') {
      const inp=document.createElement('input');inp.type='date';
      let dateVal=this.state[name]??(def??'');
      // Validate ISO date format (YYYY-MM-DD)
      if(typeof dateVal==='string'&&dateVal&&!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) dateVal='';
      inp.value=dateVal;
      if(this.state[name]===undefined&&inp.value){this.state[name]=inp.value;this._pendingInits.push([name,inp.value]);}
      this._cache.set(name,{el:inp,type:'date'});
      inp.addEventListener('change',()=>this._emit(name,inp.value));
      w.appendChild(inp);
    } else if(type==='number') {
      const inp=document.createElement('input');inp.type='number';
      inp.min=this._attrVal(n,'min','');inp.max=this._attrVal(n,'max','');inp.step=this._attrVal(n,'step','any');
      inp.value=this.state[name]??(def??0);
      if(this.state[name]===undefined){this.state[name]=+inp.value;this._pendingInits.push([name,+inp.value]);}
      this._cache.set(name,{el:inp,type:'number'});
      inp.addEventListener('input',()=>this._emit(name,+inp.value));
      w.appendChild(inp);
    } else {
      const fh=this._fieldHandlers.get(type);
      if(fh){const el=fh.render(n,name,this);if(el){this._cache.set(name,{el,type});w.appendChild(el);}}
      else if(!this._warnedTypes.has(type)){this._warnedTypes.add(type);console.warn(`rex-form: unknown field type "${type}" for "${name}"`);}
    }
    const hint=this._attrVal(n,'hint',undefined);
    if(hint){const h=document.createElement('div');h.className='hint';h.textContent=hint;w.appendChild(h);}
    return w;
  }

  _emit(name,val){this.state[name]=val;if(this.onFieldChange)this.onFieldChange(name,val);}

  setExternal(name,val){
    this.state[name]=val;
    const cached=this._cache.get(name);
    if(cached){
      const {el,type}=cached;
      switch(type){
        case 'range': {
          const clamped=Math.max(+el.min,Math.min(+el.max,+val||0));
          el.value=clamped;
          this.state[name]=clamped;
          const d=el.parentElement?.querySelector('.rv');
          if(d)d.textContent=clamped.toFixed(2);
          break;
        }
        case 'checkbox':
        case 'toggle':
          el.checked=this._toBool(val);
          this.state[name]=el.checked?1:0;
          break;
        case 'select':
        case 'text':
        case 'date':
        case 'color':
          el.value=val;
          break;
        case 'number':
          el.value=val;
          this.state[name]=+el.value;
          break;
        case 'file':
          // file inputs cannot be set programmatically for security
          break;
        default: {
          const fh=this._fieldHandlers.get(type);
          if(fh&&fh.setExternal)fh.setExternal(el,val,this);
          break;
        }
      }
    }
    if(this.onFieldChange)this.onFieldChange(name,this.state[name]);
  }

  // Coerce a default value to the appropriate type for a given field type
  _coerceDefault(type,val){
    if(val===undefined||val===null) return val;
    switch(type){
      case 'range':case 'number':case 'slider-2d': return this._num(val,0);
      case 'checkbox':case 'toggle': return this._toBool(val)?1:0;
      default: return val;
    }
  }

  // Safe boolean coercion: "false", 0, false → false; "true", 1, true → true
  _toBool(v){
    if(typeof v==='string') return v!==''&&v!=='false'&&v!=='0';
    return !!v;
  }

  // Safe number coercion with fallback
  _num(v,fallback){
    if(v===undefined||v===null) return fallback;
    const n=+v;
    return Number.isFinite(n)?n:fallback;
  }
}
