import { evaluateIrProgram } from '../eval/ir-interpreter.js';
import { maxRegisterIndex } from '../ir/registers.js';
import { isV10StringDecoder } from './v10-string-decoder.js';

const UNKNOWN = Symbol('unknown');
const DECODER = Symbol('v10-string-decoder');
const isKnown = value => value !== UNKNOWN;
const same = (a,b) => a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a,b));

function fromIr(value, registers) {
  if (!value) return UNKNOWN;
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'reg') return registers.get(value.index)?.value ?? UNKNOWN;
  return UNKNOWN;
}
function slot(value=UNKNOWN, origin=null) { return { value, origin }; }
function mergeSlot(a,b) {
  if (!a || !b || !same(a.value,b.value)) return slot();
  return slot(a.value, a.origin === b.origin ? a.origin : null);
}
function mergeStates(a,b) {
  if (!a) return new Map([...b].map(([k,v])=>[k,{...v}]));
  const out=new Map();
  for(const k of new Set([...a.keys(),...b.keys()])){
    const merged=mergeSlot(a.get(k),b.get(k));if(isKnown(merged.value))out.set(k,merged);
  }
  return out;
}
function stateEqual(a,b){if(a.size!==b.size)return false;for(const [k,v] of a){const w=b.get(k);if(!w||!same(v.value,w.value)||v.origin!==w.origin)return false;}return true;}
function mergeContext(a,b){if(!a)return new Map(b);const out=new Map();for(const k of new Set([...a.keys(),...b.keys()])){const av=a.has(k)?a.get(k):UNKNOWN,bv=b.has(k)?b.get(k):UNKNOWN;if(same(av,bv)&&isKnown(av))out.set(k,av);}return out;}
function contextEqual(a,b){if(a.size!==b.size)return false;for(const [k,v] of a)if(!b.has(k)||!same(v,b.get(k)))return false;return true;}

function foldBinary(op,a,b){
  if(!isKnown(a)||!isKnown(b))return UNKNOWN;
  try{
    switch(op){
      case '+': return a+b; case '-': return a-b; case '*': return a*b; case '/': return a/b;
      case '//': return Math.floor(a/b); case '%': return a-Math.floor(a/b)*b; case '^': return a**b; case '..': return String(a)+String(b);
      case '==': return a===b; case '~=': return a!==b; case '>': return a>b; case '>=': return a>=b; case '<': return a<b; case '<=': return a<=b;
      case 'and': return a!==false&&a!=null?b:a; case 'or': return a!==false&&a!=null?a:b;
      default:return UNKNOWN;
    }
  }catch{return UNKNOWN;}
}
function foldUnary(op,a){if(!isKnown(a))return UNKNOWN;try{if(op==='not')return !(a!==false&&a!=null);if(op==='-')return -a;if(op==='#'&&typeof a==='string')return a.length;}catch{}return UNKNOWN;}

function successorMap(program){
  const map=new Map(program.cfg?.nodes?.map(n=>[n.pc,n.successors])??[]);
  if(map.size)return map;
  for(let i=0;i<program.instructions.length;i++)map.set(program.instructions[i].pc,i+1<program.instructions.length?[program.instructions[i+1].pc]:[]);
  return map;
}

function transfer(x, registers, upvalues, decoderId, decode, maxRegister, instructionIndex) {
  const put=(r,v,o=instructionIndex)=>{if(isKnown(v))registers.set(r,slot(v,o));else registers.delete(r)};
  const kill=r=>registers.delete(r);
  switch(x.op){
    case 'move': put(x.dst,fromIr(x.src,registers));break;
    case 'clear_range': for(let r=x.from;r<=x.to;r++)kill(r);break;
    case 'getupval': put(x.dst,upvalues.get(x.slot)??UNKNOWN);break;
    case 'binary': put(x.dst,foldBinary(x.operator,fromIr(x.left,registers),fromIr(x.right,registers)));break;
    case 'unary': put(x.dst,foldUnary(x.operator,fromIr(x.value,registers)));break;
    case 'move_pair': put(x.dst,fromIr(x.src,registers));put(x.secondDst,registers.get(x.secondSrc)?.value??UNKNOWN);break;
    case 'closure': put(x.dst,x.prototype===decoderId?DECODER:UNKNOWN);break;
    case 'call': {
      const callee=registers.get(x.base)?.value??UNKNOWN;
      let folded=false;
      if(callee===DECODER&&x.argCount===3){
        const data=registers.get(x.base+1)?.value??UNKNOWN,key=registers.get(x.base+2)?.value??UNKNOWN,seed=registers.get(x.base+3)?.value??UNKNOWN;
        if(typeof data==='string'&&typeof key==='string'&&typeof seed==='number'){
          const decoded=decode(data,key,seed);
          if(decoded!==UNKNOWN){
            if(x.resultCount!==0)put(x.base,decoded,instructionIndex);else kill(x.base);
            if(x.resultCount>1)for(let r=x.base+1;r<x.base+x.resultCount;r++)put(r,null,instructionIndex);
            folded=true;
          }
        }
      }
      if(!folded){
        if(x.resultCount<0)for(let r=x.base;r<=maxRegister;r++)kill(r);
        else for(let r=x.base;r<x.base+x.resultCount;r++)kill(r);
      }
      break;
    }
    case 'getglobal': case 'gettable': case 'self': kill(x.dst);if(x.op==='self')kill(x.dst+1);break;
    case 'newtable': kill(x.dst);break;
    case 'vararg': if(x.count<0)for(let r=x.base;r<=maxRegister;r++)kill(r);else for(let r=x.base;r<x.base+x.count;r++)kill(r);break;
    case 'forprep': case 'forloop': kill(x.index);break;
    case 'tforloop': for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)kill(r);kill(x.control);break;
    default: break;
  }
}

function solveProgram(program, upvalues, decoderId, decode) {
  const byPc=new Map(program.instructions.map((x,i)=>[x.pc,{x,i}]));
  const successors=successorMap(program),incoming=new Map();
  const entry=program.instructions[0]?.pc;if(entry==null)return incoming;
  const maxRegister=maxRegisterIndex(program);
  incoming.set(entry,new Map());const work=[entry],queued=new Set([entry]);
  while(work.length){
    const pc=work.shift();queued.delete(pc);const item=byPc.get(pc);if(!item)continue;
    const registers=new Map([...incoming.get(pc)].map(([k,v])=>[k,{...v}]));
    transfer(item.x,registers,upvalues,decoderId,decode,maxRegister,item.i);
    for(const succ of successors.get(pc)??[]){
      if(!byPc.has(succ))continue;const old=incoming.get(succ),merged=old?mergeStates(old,registers):registers;
      if(!old||!stateEqual(old,merged)){incoming.set(succ,merged);if(!queued.has(succ)){work.push(succ);queued.add(succ)}}
    }
  }
  return incoming;
}

function analyzeProgram(program, upvalues, decoderId, decode, collectContext) {
  const incoming=solveProgram(program,upvalues,decoderId,decode),folds=new Map();
  for(let i=0;i<program.instructions.length;i++){
    const x=program.instructions[i],state=incoming.get(x.pc);if(!state)continue;
    const registers=new Map([...state].map(([k,v])=>[k,{...v}]));
    if(x.op==='closure'&&x.prototype!=null){
      const captured=new Map();
      for(const b of x.upvalues??[]){const v=b.kind===0?(registers.get(b.index)?.value??UNKNOWN):(upvalues.get(b.index)??UNKNOWN);if(isKnown(v))captured.set(b.slot,v);}
      collectContext(x.prototype,captured);
    }
    if((x.op==='call'||x.op==='tailcall')&&(registers.get(x.base)?.value??UNKNOWN)===DECODER&&x.argCount===3){
      const data=registers.get(x.base+1)?.value??UNKNOWN,key=registers.get(x.base+2)?.value??UNKNOWN,seed=registers.get(x.base+3)?.value??UNKNOWN;
      if(typeof data==='string'&&typeof key==='string'&&typeof seed==='number'){
        const decoded=decode(data,key,seed);
        if(decoded!==UNKNOWN)folds.set(i,{value:decoded,tail:x.op==='tailcall'});
      }
    }
  }
  return {folds};
}

export function foldV10DecoderCalls(bundle){
  const candidates=bundle.programs.filter(isV10StringDecoder);
  if(candidates.length!==1)return {bundle,decoderId:null,folded:0,candidates:candidates.map(p=>p.id)};
  const decoder=candidates[0],cache=new Map();
  const decode=(data,key,seed)=>{
    const cacheKey=`${seed}\0${key}\0${data}`;if(cache.has(cacheKey))return cache.get(cacheKey);
    try{
      const out=evaluateIrProgram(bundle,decoder.id,[data,key,seed]);
      const value=typeof out[0]==='string'?out[0]:UNKNOWN;cache.set(cacheKey,value);return value;
    }catch{cache.set(cacheKey,UNKNOWN);return UNKNOWN;}
  };

  const contexts=new Map([[0,new Map()]]);
  for(let round=0;round<12;round++){
    let changed=false;const pending=new Map();
    const collect=(id,ctx)=>pending.set(id,mergeContext(pending.get(id),ctx));
    for(const p of bundle.programs){const ctx=contexts.get(p.id);if(ctx)analyzeProgram(p,ctx,decoder.id,decode,collect);}
    for(const [id,ctx] of pending){const old=contexts.get(id),merged=mergeContext(old,ctx);if(!old||!contextEqual(old,merged)){contexts.set(id,merged);changed=true;}}
    if(!changed)break;
  }

  let folded=0;
  for(const p of bundle.programs){
    const ctx=contexts.get(p.id);if(!ctx)continue;
    const analysis=analyzeProgram(p,ctx,decoder.id,decode,()=>{});
    for(const [index,fold] of analysis.folds){const old=p.instructions[index];p.instructions[index]=fold.tail?{pc:old.pc,sourcePc:old.sourcePc,sub:old.sub,op:'return_literal',value:{kind:'literal',value:fold.value},optimizedFrom:'v10_decoder_tail'}:{...old,op:'constant_call',value:{kind:'literal',value:fold.value},optimizedFrom:'v10_decoder'};folded++;}
  }
  return {bundle,decoderId:decoder.id,folded,contexts};
}
