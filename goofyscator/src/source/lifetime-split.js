// Split reused VM registers into distinct source-level value lifetimes.
//
// Lua bytecode is register based, so an instruction such as CALL may read the
// function from R6 and place its single return value back into R6.  In source
// that very often represents two different lexical values:
//
//   local factory = function(...) ... end
//   local object  = factory(...)
//
// Keeping both generations in one recovered symbol produces decompiler-shaped
// assignments such as `factory = factory(...)`.  Once call-frame recovery has
// separated the callee expression from the result base (`source_call`), we can
// safely give the new generation a fresh IR register and rename its downstream
// reads until the original register is overwritten again.
//
// This pass is intentionally conservative.  It only splits a linear lifetime:
// if the new value crosses a structured control-flow node before the old
// register is redefined, we leave it unchanged.  That avoids inventing phi
// variables or changing closure-capture semantics.  More general SSA/source
// symbol reconstruction can extend this later.

import { maxRegisterIndex } from '../ir/registers.js';

const STRUCTURED=new Set(['if','while_true','repeat_until','numeric_for','generic_for']);

function valueReadsReg(v,r){
  if(!v||typeof v!=='object')return false;
  if(v.kind==='reg')return v.index===r;
  for(const k of ['table','key','value','left','right','fn','cell'])if(valueReadsReg(v[k],r))return true;
  for(const k of ['entries','args','values'])for(const e of v[k]??[])if(valueReadsReg(e,r))return true;
  return false;
}

function rewriteValue(v,from,to){
  if(!v||typeof v!=='object')return v;
  if(v.kind==='reg')return v.index===from?{...v,index:to}:v;
  const y={...v};
  for(const k of ['table','key','value','left','right','fn','cell'])if(y[k])y[k]=rewriteValue(y[k],from,to);
  for(const k of ['entries','args','values'])if(y[k])y[k]=y[k].map(e=>rewriteValue(e,from,to));
  return y;
}

function writesRegister(x,r){
  if(!x)return false;
  if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){
    case 'clear_range': return r>=x.from&&r<=x.to;
    case 'call':
    case 'source_call':
    case 'identity_results':
    case 'cell_results':
    case 'constant_call': return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new':
    case 'cell_get': return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg': return x.count>0&&r>=x.base&&r<x.base+x.count;
    case 'numeric_for': return x.index===r;
    case 'generic_for': return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}

function readsRegister(x,r){
  if(!x)return false;
  for(const k of ['src','left','right','value','key','condition'])if(valueReadsReg(x[k],r))return true;
  for(const k of ['entries','values'])for(const v of x[k]??[])if(valueReadsReg(v,r))return true;
  switch(x.op){
    case 'move_pair': return x.secondSrc===r;
    case 'gettable': return x.table===r;
    case 'settable': return x.table===r || (typeof x.src==='number'&&x.src===r);
    case 'setglobal': return x.src===r;
    case 'self': return x.dst===r;
    case 'setlist': return x.table===r||(r>=x.from&&r<=x.to);
    case 'call':
    case 'tailcall': return x.base===r||(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount);
    case 'source_call':
    case 'source_tailcall': return valueReadsReg(x.fn,r)||(x.args??[]).some(a=>valueReadsReg(a,r));
    case 'return': return x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count;
    case 'return_cell': return x.cell===r;
    case 'cell_new': return valueReadsReg(x.src,r);
    case 'cell_results': return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'cell_get': return x.cell===r;
    case 'cell_set': return x.cell===r||valueReadsReg(x.value,r);
    case 'identity_results': return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'closure': return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'table_closure_record': return (x.fields??[]).some(f=>(f.upvalues??[]).some(b=>b.kind===0&&b.index===r));
    case 'numeric_for': return x.index===r||x.limit===r||x.step===r;
    case 'generic_for': return x.base===r||x.base+1===r||x.control===r;
    default:return false;
  }
}

// Rewrite only READ positions.  Destinations stay on the original register so
// a later write still terminates the generation being renamed.
function rewriteReads(x,from,to){
  const y={...x};
  for(const k of ['src','left','right','value','key','condition'])if(y[k]&&typeof y[k]==='object')y[k]=rewriteValue(y[k],from,to);
  for(const k of ['entries','values'])if(y[k])y[k]=y[k].map(v=>rewriteValue(v,from,to));
  switch(y.op){
    case 'gettable': if(y.table===from)y.table=to; break;
    case 'settable': if(y.table===from)y.table=to; if(typeof y.src==='number'&&y.src===from)y.src=to; break;
    case 'setglobal': if(y.src===from)y.src=to; break;
    case 'self':
      // SELF's dst is both an input table register and an output base in the
      // low-level IR.  Do not lifetime-split through this ambiguous shape.
      break;
    case 'setlist':
      if(y.table===from)y.table=to;
      // Range operands cannot be renamed independently without first lowering
      // the range to source values, so callers reject such crossings.
      break;
    case 'source_call':
    case 'source_tailcall':
      y.fn=rewriteValue(y.fn,from,to);y.args=(y.args??[]).map(a=>rewriteValue(a,from,to));break;
    case 'return_cell': if(y.cell===from)y.cell=to; break;
    case 'cell_new': y.src=rewriteValue(y.src,from,to); break;
    case 'cell_get': if(y.cell===from)y.cell=to; break;
    case 'cell_set': if(y.cell===from)y.cell=to; y.value=rewriteValue(y.value,from,to); break;
    case 'closure': y.upvalues=(y.upvalues??[]).map(b=>b.kind===0&&b.index===from?{...b,index:to}:b); break;
    case 'table_closure_record': y.fields=(y.fields??[]).map(f=>({...f,upvalues:(f.upvalues??[]).map(b=>b.kind===0&&b.index===from?{...b,index:to}:b)}));break;
  }
  return y;
}

function unsupportedRangeRead(x,r){
  if(x.op==='call'||x.op==='tailcall')return readsRegister(x,r); // base/argument ranges require renumbering ABI
  if(x.op==='return')return readsRegister(x,r);
  if(x.op==='setlist')return readsRegister(x,r);
  if(x.op==='identity_results'||x.op==='cell_results')return readsRegister(x,r);
  if(x.op==='numeric_for'||x.op==='generic_for'||x.op==='self')return readsRegister(x,r);
  return false;
}

function processList(input,nextRef){
  let xs=(input??[]).map(x=>{
    const y={...x};
    for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=processList(y[k],nextRef);
    return y;
  });

  for(let i=0;i<xs.length;i++){
    const x=xs[i];
    // source_call is the key normalized shape: unlike raw CALL, its callee is
    // an AST value and its `base` denotes result destination only.
    if(x.op!=='source_call'||x.resultCount!==1||!Number.isInteger(x.base))continue;
    const r=x.base;
    if(!valueReadsReg(x.fn,r)&&!(x.args??[]).some(a=>valueReadsReg(a,r)))continue;

    // Find the end of this newly produced generation.  Refuse to cross
    // structured control flow or unresolved range-based register operations.
    let end=xs.length,hasUse=false,safe=true;
    for(let j=i+1;j<xs.length;j++){
      const y=xs[j];
      if(STRUCTURED.has(y.op)){safe=false;break;}
      if(unsupportedRangeRead(y,r)){safe=false;break;}
      if(readsRegister(y,r))hasUse=true;
      if(writesRegister(y,r)){end=j;break;}
    }
    if(!safe||!hasUse)continue;

    const fresh=nextRef.value++;
    xs[i]={...x,base:fresh,sourceLifetimeSplitFrom:r};
    for(let j=i+1;j<end;j++)if(readsRegister(xs[j],r))xs[j]=rewriteReads(xs[j],r,fresh);
    // If the terminating instruction reads the old generation before writing
    // it, that read still belongs to the split generation.
    if(end<xs.length&&readsRegister(xs[end],r))xs[end]=rewriteReads(xs[end],r,fresh);
  }
  return xs;
}

export function splitSourceLifetimes(program){
  const p=structuredClone(program),nextRef={value:maxRegisterIndex(p)+1};
  p.instructions=processList(p.instructions??[],nextRef);
  return {program:p,splits:nextRef.value-(maxRegisterIndex(program)+1)};
}
