// Recover lexical lifetime boundaries represented by VM CLOSE.
//
// A register VM may reuse the same physical slot after closing an upvalue. In
// source Lua that is not an assignment to the old captured local: it is a new
// lexical binding which shadows the closed generation. When the first semantic
// use after CLOSE is a source-emittable single-register definition, annotate
// that definition so the emitter writes `local v = ...` again. Closures made
// before the boundary keep the old binding; closures made after it capture the
// new one.
//
// Anything more complicated is deliberately left as CLOSE and therefore stays
// on the semantics-preserving compatibility path. This pass never guesses.

function valueReads(v,r){
  if(!v||typeof v!=='object')return false;
  if(v.kind==='reg')return v.index===r;
  for(const k of ['table','key','value','left','right','fn','cell'])if(valueReads(v[k],r))return true;
  for(const k of ['entries','args','values'])for(const e of v[k]??[])if(valueReads(e,r))return true;
  return false;
}
function reads(x,r){
  if(!x)return false;
  for(const k of ['src','left','right','value','key','condition'])if(valueReads(x[k],r))return true;
  for(const k of ['entries','values','args'])for(const v of x[k]??[])if(valueReads(v,r))return true;
  switch(x.op){
    case 'move_pair':return x.secondSrc===r;
    case 'gettable':return x.table===r;
    case 'settable':return x.table===r||(typeof x.src==='number'&&x.src===r);
    case 'setglobal':return x.src===r;
    case 'self':return x.dst===r;
    case 'setlist':return x.table===r||(r>=x.from&&r<=x.to);
    case 'call':case 'tailcall':return x.base===r||(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount);
    case 'source_call':case 'source_tailcall':return valueReads(x.fn,r)||(x.args??[]).some(a=>valueReads(a,r));
    case 'return':return x.hasValues&&(x.open?r>=x.base:r>=x.base&&r<x.base+x.count);
    case 'return_cell':return x.cell===r;
    case 'cell_new':return valueReads(x.src,r);
    case 'cell_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'cell_get':return x.cell===r;
    case 'cell_set':return x.cell===r||valueReads(x.value,r);
    case 'identity_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'closure':return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'table_closure_record':return (x.fields??[]).some(f=>(f.upvalues??[]).some(b=>b.kind===0&&b.index===r));
    case 'forprep':case 'forloop':return x.index===r||x.limit===r||x.step===r;
    case 'tforloop':return x.base===r||x.base+1===r||x.control===r;
    case 'numeric_for':return x.index===r||x.limit===r||x.step===r;
    case 'generic_for':return x.base===r||x.base+1===r||x.control===r;
    default:return false;
  }
}
function writes(x,r){
  if(!x)return false;
  if(x.dst===r||x.secondDst===r)return true;
  if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){
    case 'clear_range':return r>=x.from&&r<=x.to;
    case 'call':case 'source_call':case 'identity_results':case 'cell_results':case 'constant_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new':case 'cell_get':return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg':return x.count>0&&r>=x.base&&r<x.base+x.count;
    case 'forloop':case 'numeric_for':return x.index===r;
    case 'tforloop':case 'generic_for':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}
function deepTouches(x,r){
  if(reads(x,r)||writes(x,r))return true;
  for(const k of ['setup','body','thenBody','elseBody'])for(const y of x[k]??[])if(deepTouches(y,r))return true;
  for(const b of x.branches??[])for(const y of b.body??[])if(deepTouches(y,r))return true;
  return false;
}
function redeclarableWriter(x,r){
  // These shapes can be rendered as one lexical declaration without changing
  // evaluation order. More shapes can be added once their declaration form is
  // proven; unsupported ones retain CLOSE and never silently weaken semantics.
  return (x.op==='move'&&x.dst===r)||(x.op==='move_pair'&&(x.dst===r||x.secondDst===r))||(x.op==='closure'&&x.dst===r)||(x.op==='source_local'&&x.dst===r);
}
function annotate(x,r){
  const s=new Set(x.sourceRedeclare??[]);s.add(r);return {...x,sourceRedeclare:[...s].sort((a,b)=>a-b)};
}
function captureReads(x,r){
  if(!x)return false;
  if(x.op==='closure'&&(x.upvalues??[]).some(b=>b.kind===0&&b.index===r))return true;
  if(x.op==='table_closure_record'&&(x.fields??[]).some(f=>(f.upvalues??[]).some(b=>b.kind===0&&b.index===r)))return true;
  for(const k of ['setup','body','thenBody','elseBody'])for(const y of x[k]??[])if(captureReads(y,r))return true;
  for(const b of x.branches??[])for(const y of b.body??[])if(captureReads(y,r))return true;
  return false;
}

// CLOSE at the end of a structured loop body means "finish this iteration's
// captured register generation".  A source-level `local` declared inside the
// loop body gives us exactly that lifetime: each iteration creates a fresh
// lexical binding and closures retain the previous iteration's value.
//
// Recover this only when the body proves the generation starts with a clean,
// redeclarable write before any read of the register, and the CLOSE happens
// after all uses.  This is the common Goofy V10 closure-in-loop lowering and
// avoids throwing an otherwise fully structured function back to legacy IR.
function recoverLoopBodyClose(input){
  const xs=input??[];let changed=0;
  for(let ci=0;ci<xs.length;ci++){
    const close=xs[ci];if(close?.op!=='close'||!Number.isInteger(close.register))continue;
    const r=close.register;
    // CLOSE must be the last semantic touch of this generation in the body.
    let touchedAfter=false;
    for(let j=ci+1;j<xs.length;j++)if(xs[j]?.op!=='nop'&&deepTouches(xs[j],r)){touchedAfter=true;break;}
    if(touchedAfter)continue;
    let writer=-1,unsafe=false,captured=false;
    for(let j=0;j<ci;j++){
      const y=xs[j];if(!y||y.op==='nop')continue;
      if(writer<0){
        if(reads(y,r)){unsafe=true;break;}
        if(writes(y,r)){
          if(!redeclarableWriter(y,r)){unsafe=true;break;}
          writer=j;
        }
      }else{
        if(captureReads(y,r))captured=true;
        // A second write before CLOSE would mutate the same open generation;
        // redeclaring only the first write would not model that safely.
        if(writes(y,r)){unsafe=true;break;}
      }
    }
    if(unsafe||writer<0||!captured)continue;
    xs[writer]=annotate(xs[writer],r);
    xs[ci]={pc:close.pc,sourcePc:close.sourcePc,sub:close.sub,op:'nop',optimizedAway:'source-loop-close-lifetime'};
    changed++;
  }
  return changed;
}
function processList(input){
  const xs=(input??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=processList(y[k]);if(y.branches)y.branches=y.branches.map(b=>({...b,body:processList(b.body??[])}));return y;});
  let changed=0;
  // Structured loop bodies are separate lexical executions.  Recover their
  // terminal CLOSE boundaries before the ordinary "next writer" analysis,
  // which cannot see the next iteration by construction.
  changed+=recoverLoopBodyClose(xs);
  for(let i=0;i<xs.length;i++){
    const x=xs[i];if(x.op!=='close'||!Number.isInteger(x.register))continue;const r=x.register;
    let j=i+1,unsafe=false;
    for(;j<xs.length;j++){
      const y=xs[j];if(y.op==='nop')continue;
      if(y.op==='close')continue;
      if(['if','if_chain','while_true','repeat_until','numeric_for','generic_for'].includes(y.op)){
        if(deepTouches(y,r))unsafe=true;
        if(unsafe)break;
        continue;
      }
      const rd=reads(y,r),wr=writes(y,r);
      if(!rd&&!wr)continue;
      if(wr&&redeclarableWriter(y,r)){
        xs[j]=annotate(y,r);
        xs[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'source-close-lifetime'};
        changed++;
      }
      break;
    }
  }
  Object.defineProperty(xs,'_closeLifetimeChanges',{value:changed,enumerable:false,configurable:true});
  return xs;
}
export function recoverClosedLifetimes(program){
  const p=structuredClone(program);p.instructions=processList(p.instructions??[]);
  let changed=0;const walk=xs=>{changed+=xs?._closeLifetimeChanges??0;for(const x of xs??[]){for(const k of ['setup','body','thenBody','elseBody'])walk(x[k]);for(const b of x.branches??[])walk(b.body);}};walk(p.instructions);
  return {program:p,changed};
}
