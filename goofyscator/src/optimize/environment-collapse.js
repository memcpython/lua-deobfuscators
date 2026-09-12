import { buildCfg } from '../ir/cfg.js';
import { maxRegisterIndex } from '../ir/registers.js';

const ENV = Symbol('goofy-env-proxy');
const literal = value => value?.kind === 'literal' ? value.value : undefined;

function stringsBefore(program, pcLimit) {
  const out = new Set();
  for (const x of program.instructions ?? []) {
    if (x.pc >= pcLimit) continue;
    for (const value of Object.values(x)) {
      const v = literal(value);
      if (typeof v === 'string') out.add(v);
    }
  }
  return out;
}

function literalStrings(program) {
  const out = new Set();
  for (const x of program.instructions ?? []) for (const value of Object.values(x)) {
    const v = literal(value); if (typeof v === 'string') out.add(v);
  }
  return out;
}

function previousDefinition(instructions, register, beforeIndex) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const x = instructions[i];
    if (x.op === 'move_pair' && (x.dst === register || x.secondDst === register)) return x;
    if (x.dst === register) return x;
    if (x.op === 'call' || x.op === 'constant_call') {
      if (x.resultCount < 0 && register >= x.base) return x;
      if (x.resultCount > 0 && register >= x.base && register < x.base + x.resultCount) return x;
    }
    if (x.op === 'vararg') {
      if (x.count < 0 && register >= x.base) return x;
      if (x.count > 0 && register >= x.base && register < x.base + x.count) return x;
    }
    if (x.op === 'clear_range' && register >= x.from && register <= x.to) return x;
  }
  return null;
}

function findProxy(bundle, protection) {
  if (!protection?.stripped || protection.fromPc == null) return null;
  const rootId = bundle.root ?? 0;
  const root = bundle.programs.find(p => p.id === rootId) ?? bundle.programs.find(p => p.id === 0);
  if (!root) return null;
  const boundary = protection.fromPc;
  const prefixStrings = stringsBefore(root, boundary);
  if (!['_ENV', 'getfenv', '_G', 'setmetatable', 'GUF_OBFUSCATED'].every(x => prefixStrings.has(x))) return null;

  const envReaders = bundle.programs.filter(p => p.id !== root.id && literalStrings(p).has('limitedstack'));
  if (envReaders.length !== 1) return null;

  const ins = root.instructions;
  let candidate = null;
  for (let i = 0; i < ins.length; i++) {
    const x = ins[i];
    if (x.pc >= boundary || x.op !== 'call' || x.argCount !== 2 || x.resultCount !== 1) continue;
    const def = previousDefinition(ins, x.base, i);
    if (def?.op === 'getglobal' && literal(def.key) === 'setmetatable') candidate = { index:i, call:x };
  }
  if (!candidate) return null;

  const flagIndex = ins.findIndex(x => x.pc < candidate.call.pc && x.op === 'setglobal' && literal(x.key) === 'GUF_OBFUSCATED');
  if (flagIndex < 0) return null;
  return { root, proxyRegister:candidate.call.base, flagIndex, throughIndex:candidate.index, throughPc:candidate.call.pc, envReaderPrototype:envReaders[0].id };
}

function copyState(state) { return new Set(state); }
function stateEqual(a,b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }
function intersect(a,b) { if (!a) return new Set(b); const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out; }

function killResults(state, x, max) {
  if (x.resultCount < 0) { for (let r=x.base;r<=max;r++) state.delete(r); }
  else if (x.resultCount > 0) { for (let r=x.base;r<x.base+x.resultCount;r++) state.delete(r); }
}

function transfer(program, x, state, upvalues) {
  const max=maxRegisterIndex(program), has=r=>state.has(r), set=(r,on)=>on?state.add(r):state.delete(r);
  switch (x.op) {
    case 'move': set(x.dst, x.src?.kind === 'reg' && has(x.src.index)); break;
    case 'move_pair': set(x.dst, x.src?.kind === 'reg' && has(x.src.index)); set(x.secondDst, has(x.secondSrc)); break;
    case 'getupval': set(x.dst, upvalues.has(x.slot)); break;
    case 'clear_range': for(let r=x.from;r<=x.to;r++) state.delete(r); break;
    case 'call': case 'constant_call': killResults(state,x,max); break;
    case 'vararg': if(x.count<0){for(let r=x.base;r<=max;r++)state.delete(r);}else for(let r=x.base;r<x.base+x.count;r++)state.delete(r); break;
    case 'getglobal': case 'gettable': case 'newtable': case 'binary': case 'unary': case 'closure': state.delete(x.dst); break;
    case 'self': { const was=has(x.dst); state.delete(x.dst); set(x.dst+1,was); break; }
    case 'forprep': case 'forloop': state.delete(x.index); break;
    case 'tforloop': for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)state.delete(r); state.delete(x.control); break;
  }
}

function solve(program, upvalues, seedPc=null, seedRegisters=new Set()) {
  const cfg=program.cfg??buildCfg(program), byPc=new Map(program.instructions.map(x=>[x.pc,x]));
  const succ=new Map(cfg.nodes.map(n=>[n.pc,n.successors]));
  const entry=seedPc ?? program.instructions[0]?.pc;
  const incoming=new Map(); if(entry==null||!byPc.has(entry))return incoming;
  incoming.set(entry,new Set(seedRegisters)); const queue=[entry], queued=new Set(queue);
  while(queue.length){
    const pc=queue.shift();queued.delete(pc);const x=byPc.get(pc);if(!x)continue;
    const state=copyState(incoming.get(pc));transfer(program,x,state,upvalues);
    for(const next of succ.get(pc)??[]){if(!byPc.has(next))continue;const old=incoming.get(next),merged=intersect(old,state);if(!old||!stateEqual(old,merged)){incoming.set(next,merged);if(!queued.has(next)){queue.push(next);queued.add(next);}}}
  }
  return incoming;
}

function nextPc(program,index){return program.instructions[index+1]?.pc ?? null;}

function discoverContexts(bundle, proxy) {
  const contexts=new Map([[proxy.root.id,new Set()]]);
  const roots=new Map([[proxy.root.id,{seedPc:nextPc(proxy.root,proxy.throughIndex),seedRegisters:new Set([proxy.proxyRegister])}]]);
  for(let round=0;round<32;round++){
    let changed=false; const sites=new Map();
    for(const p of bundle.programs){
      if(!contexts.has(p.id))continue;
      const rootSeed=roots.get(p.id), upvalues=contexts.get(p.id);
      const incoming=solve(p,upvalues,rootSeed?.seedPc??null,rootSeed?.seedRegisters??new Set());
      for(const x of p.instructions){
        if(x.op!=='closure'||x.prototype==null)continue; const state=incoming.get(x.pc); if(!state)continue;
        const captured=new Set();
        for(const b of x.upvalues??[]){
          const isEnv=b.kind===0?state.has(b.index):upvalues.has(b.index);
          if(isEnv)captured.add(b.slot);
        }
        if(!sites.has(x.prototype))sites.set(x.prototype,captured);else sites.set(x.prototype,intersect(sites.get(x.prototype),captured));
      }
    }
    for(const [id,ctx] of sites){
      const old=contexts.get(id);
      if(!old||!stateEqual(old,ctx)){contexts.set(id,ctx);changed=true;}
    }
    if(!changed)break;
  }
  return {contexts,roots};
}

function valueIsEnv(value,state){return value?.kind==='reg'&&state.has(value.index);}

function safety(bundle, proxy, discovered) {
  const failures=[];
  for(const p of bundle.programs){
    if(!discovered.contexts.has(p.id))continue;
    const seed=discovered.roots.get(p.id), upvalues=discovered.contexts.get(p.id);
    const incoming=solve(p,upvalues,seed?.seedPc??null,seed?.seedRegisters??new Set());
    const max=maxRegisterIndex(p);
    for(const x of p.instructions){
      const state=incoming.get(x.pc); if(!state)continue;
      const bad=reason=>failures.push({program:p.id,pc:x.pc,op:x.op,reason});
      switch(x.op){
        case 'gettable': if(state.has(x.table)){if(valueIsEnv(x.key,state))bad('environment proxy used as its own key');} else if(valueIsEnv(x.key,state))bad('environment proxy used as table key'); break;
        case 'settable': if(state.has(x.table)){if(valueIsEnv(x.key,state)||valueIsEnv(x.value,state))bad('environment proxy escapes through global write');} else if(valueIsEnv(x.key,state)||valueIsEnv(x.value,state))bad('environment proxy escapes through table write'); break;
        case 'getglobal': if(valueIsEnv(x.key,state))bad('environment proxy used as global key'); break;
        case 'setglobal': if(valueIsEnv(x.key,state)||state.has(x.src))bad('environment proxy escapes through global assignment'); break;
        case 'self': if(state.has(x.dst)||valueIsEnv(x.key,state))bad('method dispatch observes environment proxy'); break;
        case 'binary': if(valueIsEnv(x.left,state)||valueIsEnv(x.right,state))bad('binary operation observes environment proxy'); break;
        case 'unary': if(valueIsEnv(x.value,state))bad('unary operation observes environment proxy'); break;
        case 'branch_false': if(valueIsEnv(x.condition,state))bad('branch observes environment proxy'); break;
        case 'call': case 'tailcall': {
          if(state.has(x.base)){bad('environment proxy called as a function');break;}
          const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);for(let r=x.base+1;r<=end;r++)if(state.has(r)){bad('environment proxy escapes as call argument');break;}break;
        }
        case 'setlist': {const end=x.open?max:x.to;if(state.has(x.table)){bad('setlist observes environment proxy');break;}for(let r=x.from;r<=end;r++)if(state.has(r)){bad('environment proxy escapes through setlist');break;}break;}
        case 'forprep': case 'forloop': if(state.has(x.index)||state.has(x.limit)||state.has(x.step))bad('numeric loop observes environment proxy'); break;
        case 'tforloop': if(state.has(x.base)||state.has(x.base+1)||state.has(x.control))bad('generic loop observes environment proxy'); break;
        case 'return': if(x.hasValues){const end=x.open?max:x.base+Math.max(0,x.count)-1;for(let r=x.base;r<=end;r++)if(state.has(r)){bad('environment proxy escapes through return');break;}} break;
        case 'closure': {
          const child=discovered.contexts.get(x.prototype)??new Set();
          for(const b of x.upvalues??[]){const env=b.kind===0?state.has(b.index):upvalues.has(b.index);if(env&&!child.has(b.slot)){bad('environment capture lost at merged closure site');break;}}
          break;
        }
      }
    }
  }
  return failures;
}

function addValueUse(use,value){if(value?.kind==='reg')use.add(value.index);}
function usesDefs(x,max){
  const use=new Set(),def=new Set();
  switch(x.op){
    case 'move':addValueUse(use,x.src);def.add(x.dst);break;
    case 'move_pair':addValueUse(use,x.src);use.add(x.secondSrc);def.add(x.dst);def.add(x.secondDst);break;
    case 'binary':addValueUse(use,x.left);addValueUse(use,x.right);def.add(x.dst);break;
    case 'unary':addValueUse(use,x.value);def.add(x.dst);break;
    case 'getglobal':addValueUse(use,x.key);def.add(x.dst);break;
    case 'setglobal':addValueUse(use,x.key);use.add(x.src);break;
    case 'getupval':def.add(x.dst);break;
    case 'newtable':def.add(x.dst);break;
    case 'cell_new':addValueUse(use,x.src);for(let r=x.dst;r<x.dst+Math.max(1,x.resultCount??1);r++)def.add(r);break;
    case 'cell_results':for(let i=0;i<x.count;i++)use.add(x.sourceBase+i);for(let i=0;i<Math.max(0,x.resultCount);i++)def.add(x.base+i);break;
    case 'cell_get':use.add(x.cell);for(let i=0;i<Math.max(1,x.resultCount??1);i++)def.add(x.dst+i);break;
    case 'cell_set':use.add(x.cell);addValueUse(use,x.value);break;
    case 'gettable':use.add(x.table);addValueUse(use,x.key);def.add(x.dst);break;
    case 'settable':use.add(x.table);addValueUse(use,x.key);addValueUse(use,x.value);break;
    case 'self':use.add(x.dst);addValueUse(use,x.key);def.add(x.dst);def.add(x.dst+1);break;
    case 'setlist':use.add(x.table);for(let r=x.from;r<=(x.open?max:x.to);r++)use.add(r);break;
    case 'clear_range':for(let r=x.from;r<=x.to;r++)def.add(r);break;
    case 'branch_false':addValueUse(use,x.condition);break;
    case 'forprep':case 'forloop':use.add(x.index);use.add(x.limit);use.add(x.step);def.add(x.index);break;
    case 'tforloop':use.add(x.base);use.add(x.base+1);use.add(x.control);for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)def.add(r);def.add(x.control);break;
    case 'call':{const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);for(let r=x.base;r<=end;r++)use.add(r);if(x.resultCount<0)for(let r=x.base;r<=max;r++)def.add(r);else for(let r=x.base;r<x.base+Math.max(0,x.resultCount);r++)def.add(r);break;}
    case 'constant_call':if(x.resultCount<0)for(let r=x.base;r<=max;r++)def.add(r);else for(let r=x.base;r<x.base+Math.max(0,x.resultCount);r++)def.add(r);break;
    case 'tailcall':{const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);for(let r=x.base;r<=end;r++)use.add(r);break;}
    case 'return':if(x.hasValues){const end=x.open?max:x.base+Math.max(0,x.count)-1;for(let r=x.base;r<=end;r++)use.add(r);}break;
    case 'return_cell':use.add(x.cell);break;
    case 'vararg':if(x.count<0)for(let r=x.base;r<=max;r++)def.add(r);else for(let r=x.base;r<x.base+x.count;r++)def.add(r);break;
    case 'closure':for(const b of x.upvalues??[])if(b.kind===0)use.add(b.index);def.add(x.dst);break;
    case 'close':use.add(x.register);break;
    case 'identity_results':for(let i=0;i<x.count;i++)use.add(x.sourceBase+i);if(x.resultCount<0)for(let i=0;i<x.count;i++)def.add(x.base+i);else for(let i=0;i<x.resultCount;i++)def.add(x.base+i);break;
  }
  return {use,def};
}

function liveInSets(program){
  const cfg=program.cfg??buildCfg(program),max=maxRegisterIndex(program),indexByPc=new Map(program.instructions.map((x,i)=>[x.pc,i]));
  const meta=program.instructions.map(x=>usesDefs(x,max)),inside=program.instructions.map(()=>new Set()),out=program.instructions.map(()=>new Set());
  let changed=true;
  while(changed){changed=false;for(let i=program.instructions.length-1;i>=0;i--){
    const next=new Set();for(const pc of cfg.nodes[i]?.successors??[]){const j=indexByPc.get(pc);if(j!=null)for(const r of inside[j])next.add(r);}
    const inn=new Set(meta[i].use);for(const r of next)if(!meta[i].def.has(r))inn.add(r);
    if(!stateEqual(next,out[i])){out[i]=next;changed=true;}if(!stateEqual(inn,inside[i])){inside[i]=inn;changed=true;}
  }}
  return {inside,out,meta};
}

function stripBootstrapSlice(root, fromIndex, throughIndex) {
  root.cfg=buildCfg(root);
  const {inside,meta}=liveInSets(root),after=throughIndex+1<inside.length?new Set(inside[throughIndex+1]):new Set();
  const required=new Set(after),keep=new Set();
  for(let i=throughIndex;i>=fromIndex;i--){
    const m=meta[i];let needed=false;for(const r of m.def)if(required.has(r)){needed=true;break;}
    if(!needed)continue;keep.add(i);for(const r of m.def)required.delete(r);for(const r of m.use)required.add(r);
  }
  let removed=0;
  for(let i=fromIndex;i<=throughIndex;i++){
    if(keep.has(i))continue;const x=root.instructions[i];if(!x||x.op==='nop')continue;
    root.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'goofy-environment-bootstrap'};removed++;
  }
  root.cfg=buildCfg(root);return {removed,kept:[...keep].map(i=>root.instructions[i]?.pc).filter(v=>v!=null),liveAfter:[...after].sort((a,b)=>a-b)};
}

/**
 * Replace Goofyfuscator's injected _ENV/getfenv metatable proxy with ordinary
 * IR global accesses.  The proxy identity is propagated through moves and
 * closure captures; if the physical proxy object is observable anywhere, the
 * entire pass is skipped.
 */
export function collapseEnvironmentProxy(bundle, protection) {
  const proxy=findProxy(bundle,protection);
  if(!proxy)return {collapsed:false,reason:'proxy-not-found',rewritten:0,prefixRemoved:0};
  const discovered=discoverContexts(bundle,proxy);
  const unsafe=safety(bundle,proxy,discovered);
  if(unsafe.length)return {collapsed:false,reason:'proxy-object-observed',unsafe:unsafe.slice(0,8),rewritten:0,prefixRemoved:0,proxyRegister:proxy.proxyRegister};

  let rewritten=0;
  for(const p of bundle.programs){
    if(!discovered.contexts.has(p.id))continue;
    const seed=discovered.roots.get(p.id),upvalues=discovered.contexts.get(p.id);
    const incoming=solve(p,upvalues,seed?.seedPc??null,seed?.seedRegisters??new Set());
    for(let i=0;i<p.instructions.length;i++){
      const x=p.instructions[i],state=incoming.get(x.pc);if(!state)continue;
      if(x.op==='gettable'&&state.has(x.table)){
        p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'getglobal',dst:x.dst,key:x.key,optimizedFrom:'goofy-environment-proxy'};rewritten++;
      }else if(x.op==='settable'&&state.has(x.table)){
        p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'setglobal',src:x.value?.kind==='reg'?x.value.index:null,key:x.key,optimizedFrom:'goofy-environment-proxy'};
        if(p.instructions[i].src==null)return {collapsed:false,reason:'non-register-environment-write',rewritten:0,prefixRemoved:0,proxyRegister:proxy.proxyRegister};
        rewritten++;
      }
    }
    p.cfg=buildCfg(p);
  }
  // Keep the decoder/bootstrap prefix before GUF_OBFUSCATED: some payloads
  // retain the recovered string decoder as a genuine runtime helper.  Only the
  // injected flag + environment-proxy construction are removed.
  const slice=stripBootstrapSlice(proxy.root,proxy.flagIndex,proxy.throughIndex);
  return {collapsed:true,rewritten,prefixRemoved:slice.removed,preservedPcs:slice.kept,liveAfter:slice.liveAfter,proxyRegister:proxy.proxyRegister,flagPc:proxy.root.instructions[proxy.flagIndex]?.pc??null,throughPc:proxy.throughPc,envReaderPrototype:proxy.envReaderPrototype};
}


/** Run after ordinary liveness/DCE has removed dead proxy aliases. */
export function finalizeEnvironmentProxy(bundle, state) {
  if(!state?.collapsed||state.flagPc==null||state.throughPc==null)return {removed:0,preservedPcs:[],liveAfter:[]};
  const root=bundle.programs.find(p=>p.id===(bundle.root??0))??bundle.programs.find(p=>p.id===0);if(!root)return {removed:0,preservedPcs:[],liveAfter:[]};
  const fromIndex=root.instructions.findIndex(x=>x.pc===state.flagPc),throughIndex=root.instructions.findIndex(x=>x.pc===state.throughPc);
  if(fromIndex<0||throughIndex<fromIndex)return {removed:0,preservedPcs:[],liveAfter:[]};
  const slice=stripBootstrapSlice(root,fromIndex,throughIndex);
  return {removed:slice.removed,preservedPcs:slice.kept,liveAfter:slice.liveAfter};
}
