// Reconstruct a source-local initializer from the pure VM expression chain that
// immediately computes it.  This is version-aware: if a physical register is
// assigned twice, resolving the second definition's `left = same_register`
// recursively looks for the *previous* definition, producing one nested AST
// rather than `t = ...; t = t op ...` source noise.
//
// Only move/unary/binary expression nodes are sliced, and every semantic
// instruction between the first dependency and the source-local assignment
// must belong to the slice.  Calls/table accesses/control flow therefore remain
// hard boundaries; we never reorder effectful operations merely for prettiness.

function walkValue(v,fn){if(!v||typeof v!=='object')return;fn(v);for(const k of ['table','key','value','left','right','fn','cell'])walkValue(v[k],fn);for(const k of ['entries','args','values'])for(const e of v[k]??[])walkValue(e,fn);}
function readsValue(v,r){let n=0;walkValue(v,x=>{if(x.kind==='reg'&&x.index===r)n++;});return n;}
function instructionReads(x,r){
  if(!x)return 0;let n=0;for(const k of ['src','left','right','value','key','condition','fn','cell'])n+=readsValue(x[k],r);for(const k of ['entries','values','args'])for(const v of x[k]??[])n+=readsValue(v,r);
  switch(x.op){case 'gettable':n+=x.table===r?1:0;break;case 'settable':n+=x.table===r?1:0;break;case 'source_call':case 'source_tailcall':n+=readsValue(x.fn,r);for(const a of x.args??[])n+=readsValue(a,r);break;case 'return':if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++;break;case 'closure':for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++;break;}return n;
}
function writes(x,r){if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;if(x.op==='source_local')return x.dst===r;if(x.op==='source_local_multi')return (x.targets??[]).includes(r);if(x.op==='identity_results')return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;return false;}
function previousDef(xs,before,r){for(let i=before-1;i>=0;i--)if(writes(xs[i],r))return i;return -1;}

function sourceLocalBarrier(x,r){return x?.op==='source_local'&&x.dst===r || x?.op==='source_local_multi'&&(x.targets??[]).includes(r);}

function resolveValue(xs,v,before,used,stack){
  if(!v||typeof v!=='object')return null;
  if(v.kind==='literal')return structuredClone(v);
  if(v.kind!=='reg')return null;
  const r=v.index,key=`${r}@${before}`;if(stack.has(key))return null;stack.add(key);
  const di=previousDef(xs,before,r);if(di<0){stack.delete(key);return structuredClone(v);}
  const d=xs[di];
  if(sourceLocalBarrier(d,r)){stack.delete(key);return {kind:'reg',index:r};}
  let out=null;
  if(d.op==='move')out=resolveValue(xs,d.src,di,used,stack);
  else if(d.op==='unary'){
    const a=resolveValue(xs,d.value,di,used,stack);if(a)out={kind:'unary',operator:d.operator,value:a};
  }else if(d.op==='binary'){
    const a=resolveValue(xs,d.left,di,used,stack),b=resolveValue(xs,d.right,di,used,stack);if(a&&b)out={kind:'binary',operator:d.operator,left:a,right:b};
  }
  if(out)used.add(di);stack.delete(key);return out;
}

function hasOutsideSemantic(xs,used,lo,hi){
  for(let i=lo;i<hi;i++){const x=xs[i];if(x.op==='nop'||used.has(i))continue;return true;}return false;
}
function readAfterBeforeWrite(xs,start,r){for(let i=start;i<xs.length;i++){if(instructionReads(xs[i],r))return true;if(writes(xs[i],r))return false;}return false;}

function processList(input,stats){
  const xs=(input??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=processList(y[k],stats);if(y.branches)y.branches=y.branches.map(b=>({...b,body:processList(b.body??[],stats)}));return y;});
  for(let i=0;i<xs.length;i++){
    const x=xs[i];if(x.op!=='source_local'||x.value?.kind!=='reg')continue;
    const used=new Set(),expr=resolveValue(xs,x.value,i,used,new Set());if(!expr||!used.size)continue;
    const lo=Math.min(...used);
    if(hasOutsideSemantic(xs,used,lo,i))continue;
    const temps=new Set();for(const di of used){const d=xs[di];if(Number.isInteger(d.dst))temps.add(d.dst);}
    let escapes=false;for(const r of temps)if(r!==x.dst&&readAfterBeforeWrite(xs,i+1,r)){escapes=true;break;}if(escapes)continue;
    xs[i]={...x,value:expr,sourceRecovered:'lexical-local-expression'};
    for(const di of used){const d=xs[di];xs[di]={pc:d.pc,sourcePc:d.sourcePc,sub:d.sub,op:'nop',optimizedAway:'source-local-expression'};}
    stats.collapsed++;stats.instructions+=used.size;
  }
  return xs;
}

export function recoverSourceLocalExpressions(program){
  const p=structuredClone(program),stats={collapsed:0,instructions:0};p.instructions=processList(p.instructions??[],stats);return {program:p,...stats};
}
