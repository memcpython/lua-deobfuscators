import { buildCfg } from '../ir/cfg.js';
import { maxRegisterIndex } from '../ir/registers.js';
import { markSourceBindings, dependsOnSourceBinding } from './source-provenance.js';

const UNKNOWN=Symbol('unknown');
const fact=(value,origin=null)=>({value,origin:Number.isInteger(origin)?origin:null});
const known=v=>v!==UNKNOWN;
const sameValue=(a,b)=>a===b||(typeof a==='number'&&typeof b==='number'&&Object.is(a,b));
const sameFact=(a,b)=>known(a)&&known(b)&&sameValue(a.value,b.value)&&a.origin===b.origin;
const truthy=v=>v!==false&&v!==null;

function literalFact(v){
  if(v?.kind!=='literal')return UNKNOWN;
  return fact(v.value,Number.isInteger(v.sourceReg)?v.sourceReg:null);
}
function valueFact(v,regs){
  if(v?.kind==='literal')return literalFact(v);
  if(v?.kind==='reg')return regs.has(v.index)?regs.get(v.index):UNKNOWN;
  return UNKNOWN;
}
const irValue=(v,regs)=>{const f=valueFact(v,regs);return known(f)?f.value:UNKNOWN;};

function merge(a,b){
  if(!a)return new Map(b);
  const o=new Map();
  for(const k of new Set([...a.keys(),...b.keys()])){
    const av=a.has(k)?a.get(k):UNKNOWN,bv=b.has(k)?b.get(k):UNKNOWN;
    if(!known(av)||!known(bv)||!sameValue(av.value,bv.value))continue;
    // The constant itself is still valid if both paths agree on the value.  An
    // origin is source-recoverable only when both paths agree on that too.
    o.set(k,fact(av.value,av.origin===bv.origin?av.origin:null));
  }
  return o;
}
function eq(a,b){if(a.size!==b.size)return false;for(const [k,v]of a){if(!b.has(k)||!sameFact(v,b.get(k)))return false;}return true;}
function luaMod(a,b){return a-Math.floor(a/b)*b;}
const numeric=(a,b)=>typeof a==='number'&&typeof b==='number';
const comparable=(a,b)=>(typeof a==='number'&&typeof b==='number')||(typeof a==='string'&&typeof b==='string');
function binary(op,a,b){
  if(a===UNKNOWN||b===UNKNOWN)return UNKNOWN;
  try{
    switch(op){
      case '+':return numeric(a,b)?a+b:UNKNOWN;
      case '-':return numeric(a,b)?a-b:UNKNOWN;
      case '*':return numeric(a,b)?a*b:UNKNOWN;
      case '/':return numeric(a,b)?a/b:UNKNOWN;
      case '//':return numeric(a,b)&&b!==0?Math.floor(a/b):UNKNOWN;
      case '%':return numeric(a,b)&&b!==0?luaMod(a,b):UNKNOWN;
      case '^':return numeric(a,b)?a**b:UNKNOWN;
      case '==':return a===b;
      case '~=':return a!==b;
      case '>':return comparable(a,b)?a>b:UNKNOWN;
      case '>=':return comparable(a,b)?a>=b:UNKNOWN;
      case '<':return comparable(a,b)?a<b:UNKNOWN;
      case '<=':return comparable(a,b)?a<=b:UNKNOWN;
      case 'and':return truthy(a)?b:a;
      case 'or':return truthy(a)?a:b;
      default:return UNKNOWN;
    }
  }catch{return UNKNOWN;}
}
function unary(op,a){
  if(a===UNKNOWN)return UNKNOWN;
  try{
    if(op==='not')return !truthy(a);
    if(op==='-'&&typeof a==='number')return -a;
    if(op==='#'&&typeof a==='string')return a.length;
  }catch{}
  return UNKNOWN;
}

function rewriteKnownOperands(x,regs,sourceBindings){
  const rw=v=>{
    if(v?.kind!=='reg'||!regs.has(v.index))return v;
    const f=regs.get(v.index);
    if(Number.isInteger(f?.origin)&&sourceBindings.has(f.origin))return v;
    return {kind:'literal',value:f.value,sourceReg:Number.isInteger(f.origin)?f.origin:v.index,constantPropagated:true};
  };
  for(const k of ['src','left','right','value','key','condition']) if(x[k]) x[k]=rw(x[k]);
}

function transfer(x,regs,rewrite,maxRegister,sourceBindings){
  const setFact=(r,f)=>known(f)?regs.set(r,f):regs.delete(r),kill=r=>regs.delete(r);
  const setValue=(r,v,origin=r)=>v===UNKNOWN?kill(r):regs.set(r,fact(v,origin));
  switch(x.op){
    case 'move':{
      const f=valueFact(x.src,regs);
      // A direct literal load starts a value lifetime at its destination; a
      // register copy preserves the existing semantic origin through VM moves.
      if(known(f))setFact(x.dst,fact(f.value,x.sourceBinding?x.dst:(x.src?.kind==='literal'?(Number.isInteger(x.src.sourceReg)?x.src.sourceReg:x.dst):f.origin)));else kill(x.dst);
      break;
    }
    case 'clear_range':for(let r=x.from;r<=x.to;r++)setValue(r,null,r);break;
    case 'binary':{
      const sourceDependent=dependsOnSourceBinding(x.left,regs,sourceBindings)||dependsOnSourceBinding(x.right,regs,sourceBindings);
      if(sourceDependent){kill(x.dst);break;}
      // Literal comparison opcodes are still genuine source operators in the
      // V10 stream (the all-opcode fixture deliberately contains 1==1 etc.).
      // Keep those nodes instead of replacing them with a boolean MOVE.
      if(x.vm&&['==','~=','<','<=','>','>='].includes(x.operator)&&x.left?.kind==='literal'&&x.right?.kind==='literal'){kill(x.dst);break;}
      const v=binary(x.operator,irValue(x.left,regs),irValue(x.right,regs));setValue(x.dst,v,x.dst);
      if(rewrite&&v!==UNKNOWN)Object.assign(x,{op:'move',src:{kind:'literal',value:v,sourceReg:x.dst,constantPropagated:true},optimizedFrom:'binary'});break;
    }
    case 'unary':{
      if(dependsOnSourceBinding(x.value,regs,sourceBindings)){kill(x.dst);break;}
      const v=unary(x.operator,irValue(x.value,regs));setValue(x.dst,v,x.dst);
      if(rewrite&&v!==UNKNOWN)Object.assign(x,{op:'move',src:{kind:'literal',value:v,sourceReg:x.dst,constantPropagated:true},optimizedFrom:'unary'});break;
    }
    case 'logical_chain':
      // Preserve explicit source-level short-circuit syntax.  Even when every
      // operand is statically known, do not carry a constant fact through this
      // node: downstream folds would otherwise collapse `(a and b) == b` or
      // `(a or b) == b` into a literal and destroy source structure.
      kill(x.dst);break;
    case 'move_pair':{
      const a=valueFact(x.src,regs),b=regs.has(x.secondSrc)?regs.get(x.secondSrc):UNKNOWN;setFact(x.dst,a);setFact(x.secondDst,b);break;
    }
    case 'identity_results':{
      const vals=[];for(let i=0;i<x.count;i++)vals.push(regs.has(x.sourceBase+i)?regs.get(x.sourceBase+i):UNKNOWN);
      const n=x.resultCount<0?x.count:Math.max(0,x.resultCount);
      for(let i=0;i<n;i++){
        if(i>=x.count){setValue(x.base+i,null,x.base+i);continue;}
        const f=vals[i];
        // A proven wrapper identity boundary is a semantic source-value
        // boundary.  Reset origin to the stable result register so subsequent
        // VM shuffles do not erase which lexical value this was.
        if(known(f))setFact(x.base+i,fact(f.value,x.base+i));else kill(x.base+i);
      }
      break;
    }
    case 'constant_call':if(x.resultCount!==0){const f=valueFact(x.value,regs);setFact(x.base,known(f)?fact(f.value,x.base):UNKNOWN);}if(x.resultCount>1)for(let r=x.base+1;r<x.base+x.resultCount;r++)setValue(r,null,r);break;
    case 'branch_false':{if(dependsOnSourceBinding(x.condition,regs,sourceBindings))break;const v=irValue(x.condition,regs);if(rewrite&&v!==UNKNOWN){if(truthy(v))Object.assign(x,{op:'nop',optimizedFrom:'branch_false'});else Object.assign(x,{op:'jump',optimizedFrom:'branch_false'});}break;}
    case 'getglobal':case 'getupval':case 'gettable':case 'self':case 'closure':case 'newtable':kill(x.dst);if(x.op==='self')kill(x.dst+1);break;
    case 'cell_new':for(let r=x.dst;r<x.dst+Math.max(1,x.resultCount??1);r++)kill(r);break;
    case 'cell_results':for(let r=x.base;r<x.base+Math.max(0,x.resultCount);r++)kill(r);break;
    case 'cell_get':for(let r=x.dst;r<x.dst+Math.max(1,x.resultCount??1);r++)kill(r);break;
    case 'call':if(x.resultCount<0){for(let r=x.base;r<=maxRegister;r++)kill(r)}else for(let r=x.base;r<x.base+x.resultCount;r++)kill(r);break;
    case 'vararg':if(x.count<0){for(let r=x.base;r<=maxRegister;r++)kill(r)}else for(let r=x.base;r<x.base+x.count;r++)kill(r);break;
    case 'forprep':case 'forloop':kill(x.index);break;
    case 'tforloop':for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)kill(r);kill(x.control);break;
  }
}

export function propagateConstants(program){
  const maxRegister=maxRegisterIndex(program);
  const {registers:sourceBindings}=markSourceBindings(program);
  let totalChanged=0,totalUnreachable=0;
  for(let pass=0;pass<4;pass++){
    program.cfg=buildCfg(program);
    const byPc=new Map(program.instructions.map((x,i)=>[x.pc,{x,i}]));
    const incoming=new Map();
    const entry=program.instructions[0]?.pc;
    if(entry==null)break;
    incoming.set(entry,new Map());
    const q=[entry],queued=new Set([entry]);

    while(q.length){
      const pc=q.shift();queued.delete(pc);
      const item=byPc.get(pc);if(!item)continue;
      const regs=new Map(incoming.get(pc));
      transfer(item.x,regs,false,maxRegister,sourceBindings);
      for(const spc of program.cfg.nodes[item.i]?.successors??[]){
        if(!byPc.has(spc))continue;
        const old=incoming.get(spc),m=old?merge(old,regs):new Map(regs);
        if(!old||!eq(old,m)){incoming.set(spc,m);if(!queued.has(spc)){q.push(spc);queued.add(spc)}}
      }
    }

    let changed=0;
    for(const [pc,item] of byPc){
      const state=incoming.get(pc);if(!state)continue;
      const before=item.x.op;
      rewriteKnownOperands(item.x,state,sourceBindings);
      transfer(item.x,new Map(state),true,maxRegister,sourceBindings);
      if(item.x.op!==before)changed++;
    }

    program.cfg=buildCfg(program);
    const reachable=new Set(),stack=[program.cfg.entry];
    const nodeByPc=new Map(program.cfg.nodes.map(n=>[n.pc,n]));
    while(stack.length){const pc=stack.pop();if(pc==null||reachable.has(pc))continue;reachable.add(pc);for(const next of nodeByPc.get(pc)?.successors??[])stack.push(next)}
    for(let i=0;i<program.instructions.length;i++){
      const x=program.instructions[i];
      if(!reachable.has(x.pc)&&x.op!=='nop'){
        program.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'unreachable'};
        totalUnreachable++;changed++;
      }
    }
    totalChanged+=changed;
    if(!changed)break;
  }
  program.cfg=buildCfg(program);
  return {changed:totalChanged,unreachable:totalUnreachable};
}
