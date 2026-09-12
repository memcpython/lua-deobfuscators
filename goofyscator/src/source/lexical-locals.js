// Recover lexical locals that Goofyfuscator's value-wrapper lowering and the
// VM constant-propagation pass would otherwise erase.
//
// Two strong source signals survive the V10 pipeline:
//   1. wrapper argument/result identity groups (`identity_results`) map a set of
//      produced values onto stable registers at one semantic boundary;
//   2. wrapper-unbox moves (`optimizedFrom: identity-results`) assign a computed
//      value to a register that may be reused by later source statements.
//
// Constant propagation keeps `sourceReg` provenance on literals.  When one of
// the stable identity-result registers is genuinely reused, this pass rewrites
// those propagated literals back to register reads and emits explicit
// `source_local[_multi]` nodes.  We therefore preserve source value lifetimes
// without disabling the aggressive VM/protection simplifier globally.
//
// This is deliberately proof-based.  We do not infer original variable names,
// and we do not materialize one-use wrapper temporaries.

function walkValue(v, fn) {
  if (!v || typeof v !== 'object') return;
  fn(v);
  for (const k of ['table','key','value','left','right','fn','cell']) walkValue(v[k], fn);
  for (const k of ['entries','args','values']) for (const e of v[k] ?? []) walkValue(e, fn);
}

function mapValue(v, fn) {
  if (!v || typeof v !== 'object') return v;
  const replaced=fn(v); if (replaced !== v) return replaced;
  const y={...v};
  for (const k of ['table','key','value','left','right','fn','cell']) if (y[k]) y[k]=mapValue(y[k],fn);
  for (const k of ['entries','args','values']) if (y[k]) y[k]=y[k].map(e=>mapValue(e,fn));
  return y;
}

function valueReadCount(v,r) {
  let n=0; walkValue(v,x=>{if(x.kind==='reg'&&x.index===r)n++;else if(x.kind==='literal'&&x.sourceReg===r)n++;}); return n;
}

function instructionReadCount(x,r) {
  if (!x) return 0; let n=0;
  for (const k of ['src','left','right','value','key','condition','fn','cell']) n+=valueReadCount(x[k],r);
  for (const k of ['entries','values','args']) for (const v of x[k] ?? []) n+=valueReadCount(v,r);
  switch (x.op) {
    case 'move_pair': n+=x.secondSrc===r?1:0; break;
    case 'gettable': n+=x.table===r?1:0; break;
    case 'settable': n+=(x.table===r?1:0)+(typeof x.src==='number'&&x.src===r?1:0); break;
    case 'setglobal': n+=x.src===r?1:0; break;
    case 'setlist': n+=(x.table===r?1:0)+(r>=x.from&&r<=x.to?1:0); break;
    case 'call': case 'tailcall': n+=(x.base===r?1:0)+(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount?1:0); break;
    case 'source_call': case 'source_tailcall': n+=valueReadCount(x.fn,r);for(const a of x.args??[])n+=valueReadCount(a,r);break;
    case 'return': if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++; break;
    case 'return_cell': n+=x.cell===r?1:0; break;
    case 'cell_get': n+=x.cell===r?1:0; break;
    case 'cell_set': n+=x.cell===r?1:0; break;
    case 'closure': for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++; break;
    case 'table_closure_record': for(const f of x.fields??[])for(const b of f.upvalues??[])if(b.kind===0&&b.index===r)n++; break;
    case 'numeric_for': n+=(x.index===r?1:0)+(x.limit===r?1:0)+(x.step===r?1:0); break;
    case 'generic_for': n+=(x.base===r?1:0)+(x.base+1===r?1:0)+(x.control===r?1:0); break;
  }
  if(x.op==='if_chain')for(const b of x.branches??[])n+=valueReadCount(b.condition,r);
  return n;
}

function writesRegister(x,r) {
  if (!x) return false;
  if (x.dst===r || x.secondDst===r) return true;
  if (x.op==='self' && r===x.dst+1) return true;
  switch(x.op){
    case 'clear_range': return r>=x.from&&r<=x.to;
    case 'call':case 'source_call':case 'identity_results':case 'cell_results':case 'constant_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new':case 'cell_get':return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg':return x.count>0&&r>=x.base&&r<x.base+x.count;
    case 'numeric_for':return x.index===r;
    case 'generic_for':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    case 'source_local':return x.dst===r;
    case 'source_local_multi':return (x.targets??[]).includes(r);
    default:return false;
  }
}

function deepReadCount(x,r){
  let n=instructionReadCount(x,r);
  for(const k of ['setup','body','thenBody','elseBody'])for(const y of x?.[k]??[])n+=deepReadCount(y,r);
  for(const b of x?.branches??[])for(const y of b.body??[])n+=deepReadCount(y,r);
  return n;
}

function readsUntilWrite(xs,start,r){
  let n=0;
  for(let i=start;i<xs.length;i++){
    const x=xs[i];n+=deepReadCount(x,r);if(writesRegister(x,r))break;
  }
  return n;
}

function findPreviousDefinition(xs,before,r){
  for(let i=before-1;i>=0;i--){
    const x=xs[i];if(!writesRegister(x,r))continue;return {i,x};
  }
  return null;
}

function onlyReadByIdentityBetween(xs,defIndex,identityIndex,r){
  for(let i=defIndex+1;i<identityIndex;i++)if(deepReadCount(xs[i],r))return false;
  return true;
}

function rewriteInstructionProvenance(x,locals){
  const y={...x};
  const rw=v=>mapValue(v,node=>node.kind==='literal'&&locals.has(node.sourceReg)?{kind:'reg',index:node.sourceReg,sourceRecovered:'lexical-local-ref'}:node);
  for(const k of ['src','left','right','value','key','condition','fn','cell'])if(y[k])y[k]=rw(y[k]);
  for(const k of ['entries','values','args'])if(y[k])y[k]=y[k].map(rw);
  for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=y[k].map(z=>rewriteInstructionProvenance(z,locals));
  if(y.branches)y.branches=y.branches.map(b=>({...b,condition:rw(b.condition),body:(b.body??[]).map(z=>rewriteInstructionProvenance(z,locals))}));
  return y;
}

function processList(input,stats){
  let xs=(input??[]).map(x=>{
    const y={...x};
    for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=processList(y[k],stats);
    if(y.branches)y.branches=y.branches.map(b=>({...b,body:processList(b.body??[],stats)}));
    return y;
  });

  const locals=new Set();
  // Multi-value wrapper boundaries are the strongest declaration signal.  A
  // target must be reused at least twice after the boundary; this excludes the
  // ordinary one-use argument shuffles Goofyfuscator emits around calls.
  for(let i=0;i<xs.length;i++){
    const x=xs[i];
    if(x.op!=='identity_results'||x.optimizedFrom!=='goofy-wrapper'||x.resultCount!==x.count||x.count<=0)continue;
    const targets=Array.from({length:x.count},(_,k)=>x.base+k),values=[],defs=[];
    let reusable=0,safe=true;
    for(let k=0;k<x.count;k++){
      const src=x.sourceBase+k,target=targets[k],def=findPreviousDefinition(xs,i,src);
      if(!def||def.x.op!=='move'||!def.x.src||!onlyReadByIdentityBetween(xs,def.i,i,src)){safe=false;break;}
      // Literal / already-source values are safe to bind without moving effects.
      const v=def.x.src;if(v.kind!=='literal'&&v.kind!=='reg'&&v.kind!=='table'){safe=false;break;}
      values.push(structuredClone(v));defs.push(def);
      if(readsUntilWrite(xs,i+1,target)>=2)reusable++;
    }
    if(!safe||reusable===0)continue;
    // Preserve the whole declaration group when at least one member proves the
    // group is source-visible.  This recovers `local a,b,c=...` rather than
    // arbitrarily keeping only the most frequently used member.
    for(const r of targets)locals.add(r);
    xs[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'source_local_multi',targets,values,sourceRecovered:'lexical-local-group'};
    for(const d of defs)xs[d.i]={pc:d.x.pc,sourcePc:d.x.sourcePc,sub:d.x.sub,op:'nop',optimizedAway:'source-local-input'};
    stats.groups++;stats.locals+=targets.length;
  }

  // Wrapper-unbox assignments that are reused by multiple later statements are
  // source locals too.  This captures values such as `local s = expression`
  // while leaving one-use call-frame copies inline.
  for(let i=0;i<xs.length;i++){
    const x=xs[i];
    if(x.op!=='move'||x.optimizedFrom!=='identity-results'||!x.src)continue;
    if(readsUntilWrite(xs,i+1,x.dst)<2)continue;
    xs[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'source_local',dst:x.dst,value:structuredClone(x.src),sourceRecovered:'lexical-local-reuse'};
    locals.add(x.dst);stats.locals++;
  }

  if(locals.size)xs=xs.map(x=>rewriteInstructionProvenance(x,locals));
  return xs;
}

export function recoverLexicalLocals(program){
  const p=structuredClone(program),stats={groups:0,locals:0};
  p.instructions=processList(p.instructions??[],stats);
  return {program:p,...stats};
}
