import { buildCfg } from '../ir/cfg.js';

const HELPER = Symbol('wrapper-suite');
const CTOR = Symbol('wrapper-ctor');
const ARG = Symbol('wrapper-args');
const WRAPPED = Symbol('wrapped-value');
const UNBOX_METHOD = Symbol('wrapper-unbox-method');
const UNKNOWN = Symbol('unknown');

const live = program => (program?.instructions ?? []).filter(x => x.op !== 'nop' && x.op !== 'vm_internal');
const same = (a,b) => a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a,b));

function literalStrings(program) {
  const out = new Set();
  for (const x of program.instructions ?? []) for (const v of Object.values(x)) if (v?.kind === 'literal' && typeof v.value === 'string') out.add(v.value);
  return out;
}

function lastDefinition(instructions, register, before) {
  for (let i=before-1;i>=0;i--) {
    const x=instructions[i];
    if (x.op==='move_pair') {
      if (x.dst===register) return { index:i, source:x.src };
      if (x.secondDst===register) return { index:i, source:{kind:'reg',index:x.secondSrc} };
    }
    if (x.dst===register) return { index:i, instruction:x, source:x.op==='move'?x.src:null };
  }
  return null;
}

function closureSource(instructions, register, before, seen=new Set()) {
  const key=`${register}:${before}`;if(seen.has(key))return null;seen.add(key);
  const def=lastDefinition(instructions,register,before);if(!def)return null;
  if(def.instruction?.op==='closure')return def.instruction.prototype;
  if(def.source?.kind==='reg')return closureSource(instructions,def.source.index,def.index,seen);
  return null;
}

function discoverSuite(bundle) {
  const byId=new Map(bundle.programs.map(p=>[p.id,p]));
  const helpers=bundle.programs.filter(p=>{
    const strings=literalStrings(p);
    return ['rawget','setmetatable','string','table'].every(x=>strings.has(x));
  });
  if(helpers.length!==1)return null;
  const helper=helpers[0],hi=live(helper);
  const returnIndex=hi.findIndex(x=>x.op==='return'&&x.hasValues&&x.count===2);
  if(returnIndex<0)return null;
  const ret=hi[returnIndex];
  const ctorId=closureSource(hi,ret.base,returnIndex),argId=closureSource(hi,ret.base+1,returnIndex);
  const ctor=byId.get(ctorId),arg=byId.get(argId);
  if(!ctor||ctor.paramCount!==1||!arg||arg.paramCount!==2)return null;

  const ci=live(ctor),aliases=new Map(),closures=new Map(),literals=new Map();
  let wrapperRoot=null,valueKey=null,unwrapKey=null,invokeKey=null;
  const literal=v=>v?.kind==='literal'?v.value:v?.kind==='reg'?literals.get(v.index):undefined;
  for(const x of ci){
    if(x.op==='newtable'){
      aliases.set(x.dst,x.dst);if(wrapperRoot==null)wrapperRoot=x.dst;closures.delete(x.dst);literals.delete(x.dst);
    }else if(x.op==='move'){
      if(x.src?.kind==='reg'){
        aliases.has(x.src.index)?aliases.set(x.dst,aliases.get(x.src.index)):aliases.delete(x.dst);
        closures.has(x.src.index)?closures.set(x.dst,closures.get(x.src.index)):closures.delete(x.dst);
        literals.has(x.src.index)?literals.set(x.dst,literals.get(x.src.index)):literals.delete(x.dst);
      }else{
        aliases.delete(x.dst);closures.delete(x.dst);
        x.src?.kind==='literal'?literals.set(x.dst,x.src.value):literals.delete(x.dst);
      }
    }else if(x.op==='closure'){
      closures.set(x.dst,x.prototype);aliases.delete(x.dst);literals.delete(x.dst);
    }
    if(x.op==='settable'&&aliases.get(x.table)===wrapperRoot){
      const key=literal(x.key);
      if(x.value?.kind==='reg'&&x.value.index===0)valueKey=key;
      else if(x.value?.kind==='reg'&&closures.has(x.value.index)&&typeof key==='number'){
        const child=byId.get(closures.get(x.value.index));
        if(live(child).some(y=>y.op==='vararg'))invokeKey=key;else unwrapKey=key;
      }
    }
  }
  if(!Number.isFinite(valueKey)||!Number.isFinite(unwrapKey)||!Number.isFinite(invokeKey))return null;
  return { helperId:helper.id, ctorId, argId, valueKey, unwrapKey, invokeKey };
}

function copyState(state){return new Map(state);}
function mergeState(a,b){
  if(!a)return new Map(b);const out=new Map();
  for(const k of new Set([...a.keys(),...b.keys()]))if(a.has(k)&&b.has(k)&&same(a.get(k),b.get(k)))out.set(k,a.get(k));
  return out;
}
function stateEqual(a,b){if(a.size!==b.size)return false;for(const [k,v]of a)if(!b.has(k)||!same(v,b.get(k)))return false;return true;}
function mergeContext(a,b){return mergeState(a,b);}

function read(value,state){if(value?.kind==='literal')return value.value;if(value?.kind==='reg')return state.has(value.index)?state.get(value.index):UNKNOWN;return UNKNOWN;}
function transfer(x,state,upvalues,suite,maxRegister){
  const put=(r,v)=>v===UNKNOWN?state.delete(r):state.set(r,v),kill=r=>state.delete(r);
  switch(x.op){
    case 'move':put(x.dst,read(x.src,state));break;
    case 'move_pair':put(x.dst,read(x.src,state));put(x.secondDst,state.has(x.secondSrc)?state.get(x.secondSrc):UNKNOWN);break;
    case 'clear_range':for(let r=x.from;r<=x.to;r++)kill(r);break;
    case 'getupval':put(x.dst,upvalues.has(x.slot)?upvalues.get(x.slot):UNKNOWN);break;
    case 'closure':put(x.dst,x.prototype===suite.helperId?HELPER:UNKNOWN);break;
    case 'binary':{
      const a=read(x.left,state),b=read(x.right,state);let v=UNKNOWN;
      if(typeof a==='number'&&typeof b==='number'){
        if(x.operator==='+')v=a+b;else if(x.operator==='-')v=a-b;else if(x.operator==='*')v=a*b;
      }
      put(x.dst,v);break;
    }
    case 'unary':put(x.dst,UNKNOWN);break;
    case 'call':{
      const callee=state.has(x.base)?state.get(x.base):UNKNOWN;
      if(callee===HELPER&&x.argCount===0&&x.resultCount===2){put(x.base,CTOR);put(x.base+1,ARG);break;}
      if(callee===CTOR&&x.argCount===1){if(x.resultCount!==0)put(x.base,WRAPPED);break;}
      if(callee===ARG){
        const mask=state.get(x.base+1),count=state.get(x.base+2);
        if(typeof mask==='string'&&Number.isInteger(count)&&count>=0){
          const outCount=x.resultCount<0?count:Math.max(0,x.resultCount);
          for(let i=0;i<outCount;i++){
            if(i>=count)put(x.base+i,null);
            else if(mask.charCodeAt(i)===49)put(x.base+i,WRAPPED);
            else put(x.base+i,state.has(x.base+3+i)?state.get(x.base+3+i):UNKNOWN);
          }
          break;
        }
      }
      if(x.resultCount<0)for(let r=x.base;r<=maxRegister;r++)kill(r);else for(let r=x.base;r<x.base+x.resultCount;r++)kill(r);
      break;
    }
    case 'constant_call':if(x.resultCount!==0)put(x.base,x.value?.value??UNKNOWN);break;
    case 'gettable':{
      const table=state.has(x.table)?state.get(x.table):UNKNOWN,key=read(x.key,state);
      if(table===WRAPPED&&key===suite.unwrapKey)put(x.dst,UNBOX_METHOD);
      else if(table===WRAPPED&&key===suite.invokeKey)put(x.dst,UNKNOWN);
      else kill(x.dst);
      break;
    }
    case 'getglobal':case 'self':case 'newtable':kill(x.dst);if(x.op==='self')kill(x.dst+1);break;
    case 'vararg':if(x.count<0)for(let r=x.base;r<=maxRegister;r++)kill(r);else for(let r=x.base;r<x.base+x.count;r++)kill(r);break;
    case 'forprep':case 'forloop':kill(x.index);break;
    case 'tforloop':for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)kill(r);kill(x.control);break;
  }
}

function maxRegister(program){
  let max=0;for(const x of program.instructions){for(const k of ['dst','secondDst','secondSrc','table','base','from','to','index','limit','step','control','resultBase','register'])if(Number.isInteger(x[k]))max=Math.max(max,x[k]);for(const v of [x.src,x.key,x.value,x.left,x.right,x.condition])if(v?.kind==='reg')max=Math.max(max,v.index);}
  return max;
}

function solve(program,upvalues,suite){
  const byPc=new Map(program.instructions.map((x,i)=>[x.pc,{x,i}])),incoming=new Map();
  const entry=program.instructions[0]?.pc;if(entry==null)return incoming;
  const cfg=program.cfg??buildCfg(program),succ=new Map(cfg.nodes.map(n=>[n.pc,n.successors])),max=maxRegister(program);
  incoming.set(entry,new Map());const queue=[entry],queued=new Set([entry]);
  while(queue.length){const pc=queue.shift();queued.delete(pc);const item=byPc.get(pc);if(!item)continue;const state=copyState(incoming.get(pc));transfer(item.x,state,upvalues,suite,max);for(const next of succ.get(pc)??[]){if(!byPc.has(next))continue;const old=incoming.get(next),merged=mergeState(old,state);if(!old||!stateEqual(old,merged)){incoming.set(next,merged);if(!queued.has(next)){queue.push(next);queued.add(next)}}}}
  return incoming;
}

function discoverContexts(bundle,suite){
  const contexts=new Map([[0,new Map()]]);
  for(let round=0;round<16;round++){
    let changed=false;const pending=new Map();
    for(const p of bundle.programs){const context=contexts.get(p.id);if(!context)continue;const incoming=solve(p,context,suite);for(const x of p.instructions){if(x.op!=='closure'||x.prototype==null)continue;const state=incoming.get(x.pc);if(!state)continue;const captured=new Map();for(const b of x.upvalues??[]){const value=b.kind===0?(state.has(b.index)?state.get(b.index):UNKNOWN):(context.has(b.index)?context.get(b.index):UNKNOWN);if(value!==UNKNOWN)captured.set(b.slot,value);}if(captured.size)pending.set(x.prototype,mergeContext(pending.get(x.prototype),captured));}}
    for(const [id,ctx]of pending){const old=contexts.get(id),merged=mergeContext(old,ctx);if(!old||!stateEqual(old,merged)){contexts.set(id,merged);changed=true;}}
    if(!changed)break;
  }
  return contexts;
}

function constArgument(state,register){return state.has(register)?state.get(register):UNKNOWN;}

function markerOfValue(value,state){return value?.kind==='reg'?(state.has(value.index)?state.get(value.index):UNKNOWN):UNKNOWN;}
function markerOfRegister(register,state){return state.has(register)?state.get(register):UNKNOWN;}
function isWrappedMarker(value){return value===WRAPPED||value===UNBOX_METHOD;}

function wrapperUsesAreSafe(program,context,incoming,suite){
  const max=maxRegister(program);
  const unsafe=[];
  const bad=(x,reason)=>unsafe.push({pc:x.pc,op:x.op,reason});
  const regWrapped=(r,state)=>isWrappedMarker(markerOfRegister(r,state));
  const valWrapped=(v,state)=>isWrappedMarker(markerOfValue(v,state));
  for(const x of program.instructions){
    const state=incoming.get(x.pc);if(!state)continue;
    switch(x.op){
      case 'move':case 'move_pair':case 'clear_range':case 'getupval':case 'constant_call':case 'newtable':case 'vararg':case 'close':case 'nop':case 'vm_internal':
        break;
      case 'closure':{
        // Capturing a wrapped value is safe only when context discovery retained
        // that exact identity for the child slot; otherwise a merge erased the
        // proof and the child could use the physical wrapper object directly.
        const childContext=context.childContexts?.get?.(x.prototype);
        for(const b of x.upvalues??[]){
          const m=b.kind===0?markerOfRegister(b.index,state):markerOfRegister(b.index,context.upvalues??new Map());
          if(m===WRAPPED&&childContext&&childContext.get(b.slot)!==WRAPPED)bad(x,'wrapped closure capture lost at merge');
        }
        break;
      }
      case 'call':{
        const callee=markerOfRegister(x.base,state),first=constArgument(state,x.base+1);
        if(callee===HELPER||callee===CTOR||callee===ARG)break;
        if(callee===WRAPPED){
          const ok=x.argCount===0||(x.argCount===1&&first===suite.unwrapKey);
          if(!ok)bad(x,'unsupported direct wrapper call');
          break;
        }
        if(callee===UNBOX_METHOD){if(x.argCount!==0)bad(x,'unwrap method received arguments');break;}
        const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);
        for(let r=x.base+1;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapped value escapes as call argument');break;}
        break;
      }
      case 'tailcall':{
        const callee=markerOfRegister(x.base,state),first=constArgument(state,x.base+1);
        if(callee===WRAPPED){
          const ok=x.argCount===0||(x.argCount===1&&first===suite.unwrapKey);
          if(!ok)bad(x,'unsupported direct wrapper tailcall');
          break;
        }
        if(callee===UNBOX_METHOD){if(x.argCount!==0)bad(x,'unwrap method tailcall received arguments');break;}
        const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);
        for(let r=x.base+1;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapped value escapes as tailcall argument');break;}
        break;
      }
      case 'gettable':{
        const table=markerOfRegister(x.table,state),key=read(x.key,state);
        if(table===WRAPPED){
          if(key!==suite.unwrapKey&&key!==suite.invokeKey)bad(x,'unsupported wrapper table read');
        }else if(valWrapped(x.key,state))bad(x,'wrapped value used as table key');
        break;
      }
      case 'settable':
        if(regWrapped(x.table,state)||valWrapped(x.key,state)||valWrapped(x.value,state))bad(x,'wrapper mutation or escape through table write');
        break;
      case 'getglobal':if(valWrapped(x.key,state))bad(x,'wrapped global key');break;
      case 'setglobal':if(valWrapped(x.key,state)||valWrapped(x.src,state))bad(x,'wrapped global write');break;
      case 'self':if(regWrapped(x.dst,state)||valWrapped(x.key,state))bad(x,'wrapped method dispatch');break;
      case 'binary':if(valWrapped(x.left,state)||valWrapped(x.right,state))bad(x,'wrapped binary operand');break;
      case 'unary':if(valWrapped(x.value,state))bad(x,'wrapped unary operand');break;
      case 'branch_false':if(valWrapped(x.condition,state))bad(x,'wrapped branch condition');break;
      case 'setlist':{
        const end=x.open?max:x.to;for(let r=x.from;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapped value escapes through setlist');break;}break;
      }
      case 'forprep':case 'forloop':if(regWrapped(x.index,state)||regWrapped(x.limit,state)||regWrapped(x.step,state))bad(x,'wrapped numeric-loop operand');break;
      case 'tforloop':{
        if(regWrapped(x.base,state)||regWrapped(x.base+1,state)||regWrapped(x.control,state))bad(x,'wrapped generic-loop operand');
        break;
      }
      case 'return':if(x.hasValues){const end=x.open?max:x.base+Math.max(0,x.count)-1;for(let r=x.base;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapped value escapes through return');break;}}break;
    }
  }
  return unsafe;
}

/**
 * A second, less aggressive proof for wrappers whose hidden value is mutated.
 *
 * The raw-value collapse above is intentionally rejected as soon as the
 * physical wrapper is observable.  Some V10 builds, however, only observe one
 * thing about that object: the randomized hidden value slot.  Those programs
 * can still be normalized exactly by replacing the obfuscator object with a
 * canonical alias-preserving cell `{ value = ... }`.
 *
 * Anything that could observe the wrapper's metatable, randomized method
 * identities, object shape, or identity outside known closure captures vetoes
 * this path.  This is what makes mutation safe without turning the pass into a
 * guessy "unwrap everything" optimization.
 */

function valueReadsRegister(value,r){
  if(!value||typeof value!=='object')return false;
  if(value.kind==='reg')return value.index===r;
  for(const k of ['table','key','value','left','right','fn','cell'])if(valueReadsRegister(value[k],r))return true;
  for(const k of ['entries','args','values'])for(const v of value[k]??[])if(valueReadsRegister(v,r))return true;
  return false;
}

function instructionReadsRegister(x,r,maxRegister){
  if(!x)return false;
  for(const k of ['src','left','right','value','key','condition','fn','cell'])if(valueReadsRegister(x[k],r))return true;
  for(const k of ['entries','args','values'])for(const v of x[k]??[])if(valueReadsRegister(v,r))return true;
  switch(x.op){
    case 'gettable':case 'settable':return x.table===r;
    case 'setglobal':return x.src===r;
    case 'self':return x.dst===r;
    case 'setlist':return x.table===r||(r>=x.from&&r<=(x.open?maxRegister:x.to));
    case 'call':case 'tailcall':{const end=x.argCount<0?maxRegister:x.base+Math.max(0,x.argCount);return r>=x.base&&r<=end;}
    case 'identity_results':case 'cell_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'return':{if(!x.hasValues)return false;const end=x.open?maxRegister:x.base+Math.max(0,x.count)-1;return r>=x.base&&r<=end;}
    case 'return_cell':return x.cell===r;
    case 'closure':return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'forprep':case 'forloop':return x.index===r||x.limit===r||x.step===r;
    case 'tforloop':return x.base===r||x.base+1===r||x.control===r;
    default:return false;
  }
}

function instructionWritesRegister(x,r,maxRegister){
  if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&x.dst+1===r)return true;
  switch(x.op){
    case 'clear_range':return r>=x.from&&r<=x.to;
    case 'call':case 'identity_results':case 'cell_results':case 'constant_call':
      return x.resultCount<0?(r>=x.base&&r<=maxRegister):(x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount);
    case 'cell_new':case 'cell_get':return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg':return x.count<0?(r>=x.base&&r<=maxRegister):(x.count>0&&r>=x.base&&r<x.base+x.count);
    case 'forprep':case 'forloop':return x.index===r;
    case 'tforloop':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}

// The wrapper's randomized invoke field is a stable forwarding closure.  It is
// safe to replace a read of that field with the cell's current value only when
// the read is used solely as the callee of one call/tailcall before the cell can
// be mutated or control flow can split. This preserves call semantics without
// pretending closure identity is unobservable in the general case.
function invokeReadIsCallOnly(program,index,register,incoming,suite){
  const max=maxRegister(program);
  for(let j=index+1;j<program.instructions.length;j++){
    const y=program.instructions[j],state=incoming.get(y.pc);
    if(!state)continue;
    if(['jump','branch_false','forprep','forloop','tforloop','return','return_cell'].includes(y.op))return false;
    if(y.op==='settable'&&markerOfRegister(y.table,state)===WRAPPED&&read(y.key,state)===suite.valueKey)return false;
    if(instructionReadsRegister(y,register,max)){
      if((y.op==='call'||y.op==='tailcall')&&y.base===register)return true;
      return false;
    }
    if(instructionWritesRegister(y,register,max))return false;
  }
  return false;
}

function wrapperUsesAreCellSafe(program,context,incoming,suite){
  const max=maxRegister(program),unsafe=[];
  const bad=(x,reason)=>unsafe.push({pc:x.pc,op:x.op,reason});
  const regWrapped=(r,state)=>isWrappedMarker(markerOfRegister(r,state));
  const valWrapped=(v,state)=>isWrappedMarker(markerOfValue(v,state));
  for(const x of program.instructions){
    const state=incoming.get(x.pc);if(!state)continue;
    switch(x.op){
      case 'move':case 'move_pair':case 'clear_range':case 'getupval':case 'constant_call':case 'newtable':case 'vararg':case 'close':case 'nop':case 'vm_internal':
        break;
      case 'closure':
        // Capturing the cell is safe: the native emitter already preserves
        // register/upvalue aliasing by reference. Context discovery proves the
        // child still sees the value as a wrapper/cell.
        break;
      case 'call':{
        const callee=markerOfRegister(x.base,state),first=constArgument(state,x.base+1);
        if(callee===HELPER) { if(!(x.argCount===0&&x.resultCount===2))bad(x,'noncanonical wrapper helper call'); break; }
        if(callee===CTOR) { if(!(x.argCount===1&&(x.resultCount===1||x.resultCount<0)))bad(x,'noncanonical wrapper constructor call'); break; }
        if(callee===ARG){
          const mask=constArgument(state,x.base+1),count=constArgument(state,x.base+2);
          if(typeof mask!=='string'||!Number.isInteger(count)||count<0||mask.length<count)bad(x,'dynamic wrapper argument mask');
          break;
        }
        if(callee===WRAPPED){
          const ok=x.argCount===0||(x.argCount===1&&first===suite.unwrapKey);
          if(!ok)bad(x,'unsupported direct wrapper call');
          break;
        }
        if(callee===UNBOX_METHOD){if(x.argCount!==0)bad(x,'unwrap method received arguments');break;}
        const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);
        for(let r=x.base+1;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapper cell escapes as call argument');break;}
        break;
      }
      case 'tailcall':{
        const callee=markerOfRegister(x.base,state),first=constArgument(state,x.base+1);
        if(callee===WRAPPED){
          const ok=x.argCount===0||(x.argCount===1&&first===suite.unwrapKey);
          if(!ok)bad(x,'unsupported direct wrapper tailcall');
          break;
        }
        if(callee===UNBOX_METHOD){if(x.argCount!==0)bad(x,'unwrap method tailcall received arguments');break;}
        const end=x.argCount<0?max:x.base+Math.max(0,x.argCount);
        for(let r=x.base+1;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapper cell escapes as tailcall argument');break;}
        break;
      }
      case 'gettable':{
        const table=markerOfRegister(x.table,state),key=read(x.key,state);
        if(table===WRAPPED){
          // The invoke method is a stable closure in the original wrapper.  A
          // cell rewrite would need to preserve that closure identity across
          // mutation. None of the current mutation-bearing samples observes it,
          // so reject it here rather than approximating that behavior.
          if(key===suite.invokeKey){const index=program.instructions.indexOf(x);if(!invokeReadIsCallOnly(program,index,x.dst,incoming,suite))bad(x,'invoke-method identity observed on mutable wrapper');}
          else if(key!==suite.unwrapKey&&key!==suite.valueKey)bad(x,'unsupported wrapper table read');
        } else if(valWrapped(x.key,state))bad(x,'wrapper cell used as table key');
        break;
      }
      case 'settable':{
        const table=markerOfRegister(x.table,state),key=read(x.key,state);
        if(table===WRAPPED){
          if(key!==suite.valueKey)bad(x,'wrapper table mutation outside hidden value slot');
        } else if(valWrapped(x.key,state)||valWrapped(x.value,state))bad(x,'wrapper cell escapes through table write');
        break;
      }
      case 'getglobal':if(valWrapped(x.key,state))bad(x,'wrapper global key');break;
      case 'setglobal':if(valWrapped(x.key,state)||valWrapped(x.src,state))bad(x,'wrapper global write');break;
      case 'self':if(regWrapped(x.dst,state)||valWrapped(x.key,state))bad(x,'wrapper method dispatch');break;
      case 'binary':if(valWrapped(x.left,state)||valWrapped(x.right,state))bad(x,'wrapper binary operand');break;
      case 'unary':if(valWrapped(x.value,state))bad(x,'wrapper unary operand');break;
      case 'branch_false':if(valWrapped(x.condition,state))bad(x,'wrapper branch condition');break;
      case 'setlist':{
        const end=x.open?max:x.to;for(let r=x.from;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapper cell escapes through setlist');break;}break;
      }
      case 'forprep':case 'forloop':if(regWrapped(x.index,state)||regWrapped(x.limit,state)||regWrapped(x.step,state))bad(x,'wrapper numeric-loop operand');break;
      case 'tforloop':if(regWrapped(x.base,state)||regWrapped(x.base+1,state)||regWrapped(x.control,state))bad(x,'wrapper generic-loop operand');break;
      case 'return':if(x.hasValues){const end=x.open?max:x.base+Math.max(0,x.count)-1;for(let r=x.base;r<=end;r++)if(regWrapped(r,state)){bad(x,'wrapper cell escapes through return');break;}}break;
    }
  }
  return unsafe;
}

function identityInstruction(old,sourceBase,count){
  return {pc:old.pc,sourcePc:old.sourcePc,sub:old.sub,op:'identity_results',base:old.base,sourceBase,count,resultCount:old.resultCount,optimizedFrom:'goofy-wrapper'};
}

function cellInstruction(old,op,extra={}){
  return {pc:old.pc,sourcePc:old.sourcePc,sub:old.sub,op,...extra,optimizedFrom:'goofy-wrapper-cell'};
}

function collapseMutableWrappersToCells(bundle,suite,contexts){
  const analyses=new Map();
  for(const p of bundle.programs){
    const upvalues=contexts.get(p.id);if(!upvalues)continue;
    const incoming=solve(p,upvalues,suite);analyses.set(p.id,incoming);
    const unsafe=wrapperUsesAreCellSafe(p,{upvalues},incoming,suite);
    if(unsafe.length)return {collapsed:false,reason:'mutable-wrapper-not-cell-safe',unsafe:unsafe.slice(0,8),suite};
  }

  let constructors=0,argPacks=0,gets=0,sets=0,unboxes=0,tailUnboxes=0,invokeMethods=0,helperCalls=0;
  for(const p of bundle.programs){
    const incoming=analyses.get(p.id);if(!incoming)continue;
    for(let i=0;i<p.instructions.length;i++){
      const x=p.instructions[i],state=incoming.get(x.pc);if(!state)continue;
      if(x.op==='call'){
        const callee=markerOfRegister(x.base,state);
        if(callee===HELPER&&x.argCount===0&&x.resultCount===2){
          p.instructions[i]=cellInstruction(x,'nop',{optimizedAway:'goofy-wrapper-cell-suite'});helperCalls++;continue;
        }
        if(callee===CTOR&&x.argCount===1){
          p.instructions[i]=cellInstruction(x,'cell_new',{dst:x.base,src:{kind:'reg',index:x.base+1},resultCount:x.resultCount<0?1:x.resultCount});constructors++;continue;
        }
        if(callee===ARG){
          const mask=constArgument(state,x.base+1),count=constArgument(state,x.base+2);
          if(typeof mask==='string'&&Number.isInteger(count)&&count>=0){
            p.instructions[i]=cellInstruction(x,'cell_results',{base:x.base,sourceBase:x.base+3,sourceCount:x.argCount<0?count:Math.max(0,x.argCount-2),count,mask,resultCount:x.resultCount<0?count:x.resultCount});argPacks++;continue;
          }
        }
        const first=constArgument(state,x.base+1);
        if((callee===WRAPPED&&(x.argCount===0||(x.argCount===1&&first===suite.unwrapKey)))||(callee===UNBOX_METHOD&&x.argCount===0)){
          // Once the wrapper call becomes a scalar cell read, its randomized
          // unwrap-key argument is VM plumbing, not source data.  Remove the
          // adjacent literal load here (before short-circuit recovery) instead
          // of waiting for generic DCE: leaving it between TESTSET operands
          // prevents the source-level `a or b` / `a and b` ladder recognizer
          // from seeing one contiguous value expression.
          if(x.argCount===1){
            const keyLoad=p.instructions[i-1];
            if(keyLoad?.op==='move'&&keyLoad.dst===x.base+1&&keyLoad.src?.kind==='literal'&&keyLoad.src.value===suite.unwrapKey){
              p.instructions[i-1]=cellInstruction(keyLoad,'nop',{optimizedAway:'goofy-wrapper-cell-key'});
            }
          }
          if(x.resultCount===0)p.instructions[i]=cellInstruction(x,'nop',{optimizedAway:'goofy-wrapper-cell-unbox'});
          else p.instructions[i]=cellInstruction(x,'cell_get',{dst:x.base,cell:x.base,resultCount:x.resultCount<0?1:x.resultCount,...(x.resultCount<0?{sourceOpenResult:true}: {})});
          unboxes++;continue;
        }
      }
      if(x.op==='tailcall'){
        const callee=markerOfRegister(x.base,state),first=constArgument(state,x.base+1);
        if((callee===WRAPPED&&(x.argCount===0||(x.argCount===1&&first===suite.unwrapKey)))||(callee===UNBOX_METHOD&&x.argCount===0)){
          p.instructions[i]=cellInstruction(x,'return_cell',{cell:x.base});tailUnboxes++;continue;
        }
      }
      if(x.op==='gettable'){
        const table=markerOfRegister(x.table,state),key=read(x.key,state);
        if(table===WRAPPED&&key===suite.valueKey){p.instructions[i]=cellInstruction(x,'cell_get',{dst:x.dst,cell:x.table,resultCount:1});gets++;continue;}
        if(table===WRAPPED&&key===suite.invokeKey&&invokeReadIsCallOnly(p,i,x.dst,incoming,suite)){p.instructions[i]=cellInstruction(x,'cell_get',{dst:x.dst,cell:x.table,resultCount:1,invokeForward:true});invokeMethods++;continue;}
        if(table===WRAPPED&&key===suite.unwrapKey){
          // Preserve the receiver itself in the method register. A following
          // proven unwrap call is rewritten to cell_get above.
          p.instructions[i]=cellInstruction(x,'move',{dst:x.dst,src:{kind:'reg',index:x.table}});continue;
        }
      }
      if(x.op==='settable'){
        const table=markerOfRegister(x.table,state),key=read(x.key,state);
        if(table===WRAPPED&&key===suite.valueKey){p.instructions[i]=cellInstruction(x,'cell_set',{cell:x.table,value:x.value});sets++;continue;}
      }
    }
    p.cfg=buildCfg(p);
  }
  return {collapsed:true,mode:'cell',constructors,argPacks,gets,sets,unboxes,tailUnboxes,invokeMethods,helperCalls,suite};
}

/**
 * Collapse the V10 value-boxing layer.  The suite is discovered from its pure
 * helper prototypes and randomized method keys; helper identities are then
 * propagated through closure captures before any call is rewritten.
 */
export function collapseValueWrappers(bundle){
  const suite=discoverSuite(bundle);if(!suite)return {collapsed:false,reason:'suite-not-found',calls:0,unboxes:0,invokeMethods:0};
  const contexts=discoverContexts(bundle,suite);let calls=0,unboxes=0,tailUnboxes=0,invokeMethods=0,helperCalls=0,unhandled=0;

  // Prove that the physical wrapper object is never observed.  This is an
  // all-or-nothing pass: a single mutation/escape keeps the original wrapper
  // suite intact for the build rather than weakening alias semantics.
  for(const p of bundle.programs){
    const upvalues=contexts.get(p.id);if(!upvalues)continue;
    const incoming=solve(p,upvalues,suite);
    const unsafe=wrapperUsesAreSafe(p,{upvalues},incoming,suite);
    if(unsafe.length){
      // Hidden-value mutation is not safe for raw-value substitution, but can
      // still be deobfuscated exactly with an alias-preserving canonical cell.
      const cells=collapseMutableWrappersToCells(bundle,suite,contexts);
      if(cells.collapsed)return cells;
      return {collapsed:false,reason:'wrapper-object-observed',unsafe:unsafe.slice(0,8),cellUnsafe:cells.unsafe??[],calls:0,unboxes:0,tailUnboxes:0,invokeMethods:0,helperCalls:0,unhandled:unsafe.length,suite};
    }
  }

  for(const p of bundle.programs){
    const context=contexts.get(p.id);if(!context)continue;const incoming=solve(p,context,suite);
    for(let i=0;i<p.instructions.length;i++){
      const x=p.instructions[i],state=incoming.get(x.pc);if(!state)continue;
      if(x.op==='call'){
        const callee=state.has(x.base)?state.get(x.base):UNKNOWN;
        if(callee===HELPER&&x.argCount===0&&x.resultCount===2){helperCalls++;continue;}
        if(callee===CTOR&&x.argCount===1){p.instructions[i]=identityInstruction(x,x.base+1,1);calls++;continue;}
        if(callee===ARG){
          const count=constArgument(state,x.base+2);
          if(Number.isInteger(count)&&count>=0){p.instructions[i]=identityInstruction(x,x.base+3,count);calls++;continue;}
          unhandled++;continue;
        }
        const first=constArgument(state,x.base+1);
        const isDirectUnbox=callee===WRAPPED&&(x.argCount===0||(x.argCount===1&&first===suite.unwrapKey));
        const isMethodUnbox=callee===UNBOX_METHOD&&x.argCount===0;
        if((isDirectUnbox||isMethodUnbox)&&x.resultCount!==0){p.instructions[i]=identityInstruction(x,x.base,1);unboxes++;continue;}
      }
      if(x.op==='tailcall'){
        const callee=state.has(x.base)?state.get(x.base):UNKNOWN;
        const first=constArgument(state,x.base+1);
        if((callee===WRAPPED&&(x.argCount===0||(x.argCount===1&&first===suite.unwrapKey)))||(callee===UNBOX_METHOD&&x.argCount===0)){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'return',base:x.base,count:1,open:false,hasValues:true,optimizedFrom:'goofy-wrapper-unbox-tail'};tailUnboxes++;continue;}
      }
      if(x.op==='gettable'){
        const table=state.has(x.table)?state.get(x.table):UNKNOWN,key=read(x.key,state);
        if(table===WRAPPED&&key===suite.invokeKey){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.dst,src:{kind:'reg',index:x.table},optimizedFrom:'goofy-wrapper-invoke'};invokeMethods++;continue;}
        if(table===WRAPPED&&key===suite.unwrapKey){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.dst,src:{kind:'reg',index:x.table},optimizedFrom:'goofy-wrapper-unbox-method'};continue;}
      }
    }
  }

  // Re-solve after rewrites. If helper identities no longer participate in any
  // executable operation, the pure helper construction itself can be erased;
  // closure-binding/DCE passes will then remove the complete helper family.
  if(unhandled===0){
    for(const p of bundle.programs){const context=contexts.get(p.id);if(!context)continue;const incoming=solve(p,context,suite);for(let i=0;i<p.instructions.length;i++){const x=p.instructions[i],state=incoming.get(x.pc);if(!state||x.op!=='call')continue;const callee=state.has(x.base)?state.get(x.base):UNKNOWN;if(callee===HELPER&&x.argCount===0&&x.resultCount===2){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'goofy-wrapper-suite'};}}}
  }
  for(const p of bundle.programs)p.cfg=buildCfg(p);
  return {collapsed:unhandled===0,calls,unboxes,tailUnboxes,invokeMethods,helperCalls,unhandled,suite};
}
