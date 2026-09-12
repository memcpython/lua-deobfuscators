// Recover canonical back-edge WHILE and REPEAT regions after IF/loop
// structuring.  WHILE keeps condition setup explicit because it executes
// before every iteration.  REPEAT is different: its condition executes after
// the body, so we fold the trailing pure condition-building suffix into an AST
// and preserve the remaining body exactly once per iteration.

const R=index=>({kind:'reg',index});
const L=value=>({kind:'literal',value});

function walkTargets(xs,out=[]){for(const x of xs){if(x.target!=null)out.push({target:x.target,source:x.pc});for(const k of ['body','thenBody','elseBody','setup'])if(x[k])walkTargets(x[k],out);for(const b of x.branches??[])walkTargets(b.body??[],out);}return out;}
function astUses(a,r){if(!a||typeof a!=='object')return false;if(a.kind==='reg')return a.index===r;for(const k of ['table','key','value','left','right','fn','cell'])if(astUses(a[k],r))return true;for(const k of ['entries','args','values'])for(const v of a[k]??[])if(astUses(v,r))return true;return false;}
function astMap(a,from,replacement){
  if(!a||typeof a!=='object')return a;
  if(a.kind==='reg'&&a.index===from)return structuredClone(replacement);
  const y={...a};for(const k of ['table','key','value','left','right','fn','cell'])if(y[k])y[k]=astMap(y[k],from,replacement);for(const k of ['entries','args','values'])if(y[k])y[k]=y[k].map(v=>astMap(v,from,replacement));return y;
}
function valueAst(v){if(v?.kind==='literal')return L(v.value);if(v?.kind)return structuredClone(v);return L(null);}
function rhsAst(x){
  if(x.op==='move')return valueAst(x.src);
  if(x.op==='unary')return {kind:'unary',operator:x.operator,value:valueAst(x.value)};
  if(x.op==='binary')return {kind:'binary',operator:x.operator,left:valueAst(x.left),right:valueAst(x.right)};
  if(x.op==='logical_chain')return {kind:'logical',operator:x.operator,values:(x.values??[]).map(valueAst)};
  if(x.op==='constant_call'&&x.resultCount===1)return valueAst(x.value);
  return null;
}
function foldTrailingCondition(body,condition){
  let expr=structuredClone(condition),cut=body.length,changed=false;
  for(let i=body.length-1;i>=0;i--){
    const x=body[i];if(!Number.isInteger(x?.dst)||!astUses(expr,x.dst))break;
    // A multi-destination instruction cannot be erased merely to build the
    // condition; its other output may be source-visible.
    if(x.secondDst!=null)break;
    const rhs=rhsAst(x);if(!rhs)break;
    expr=astMap(expr,x.dst,rhs);cut=i;changed=true;
  }
  return {body:body.slice(0,cut),condition:changed?expr:condition,folded:changed};
}
function singleEntryRegion(xs,h,g,allowedSource){
  const regionPcs=new Set(xs.slice(h,g+1).map(x=>x.pc)),targets=walkTargets(xs);
  for(const t of targets){if(!regionPcs.has(t.target))continue;if(t.target===xs[h].pc&&t.source===allowedSource)continue;if(!regionPcs.has(t.source))return false;}
  return true;
}
function process(xs){
  xs=xs.map(x=>{const y={...x};for(const k of ['body','thenBody','elseBody','setup'])if(y[k])y[k]=process(y[k]);if(y.branches)y.branches=y.branches.map(b=>({...b,body:process(b.body??[])}));return y;});
  let changed=true;
  while(changed){
    changed=false;const byPc=new Map(xs.map((x,i)=>[x.pc,i]));
    // Pre-test loops: structured IF body ends in the unique backedge.
    for(let g=0;g<xs.length;g++){
      const guard=xs[g];if(guard.op!=='if'||guard.elseBody?.length||!guard.thenBody?.length)continue;
      const tail=guard.thenBody.at(-1);if(tail?.op!=='jump')continue;const h=byPc.get(tail.target);if(h==null||h>=g)continue;
      if(!singleEntryRegion(xs,h,g,tail.pc))continue;
      const rawSetup=xs.slice(h,g),body=guard.thenBody.slice(0,-1),head=xs[h],folded=foldTrailingCondition(rawSetup,guard.condition);
      const node={pc:head.pc,sourcePc:head.sourcePc,sub:head.sub,op:'while_true',condition:folded.condition,setup:folded.body,body,optimizedFrom:folded.folded?'backedge-if+condition':'backedge-if'};
      xs=[...xs.slice(0,h),node,...xs.slice(g+1)];changed=true;break;
    }
    if(changed)continue;
    // Post-test loops: BRANCH_FALSE jumps directly back to the repeat head.
    // Fold only a trailing pure condition-building suffix; the rest remains the
    // loop body and therefore retains its original ordering and side effects.
    for(let g=0;g<xs.length;g++){
      const guard=xs[g];if(guard.op!=='branch_false')continue;const h=byPc.get(guard.target);if(h==null||h>g)continue;
      if(!singleEntryRegion(xs,h,g,guard.pc))continue;
      const rawBody=xs.slice(h,g),folded=foldTrailingCondition(rawBody,guard.condition),head=xs[h]??guard;
      const node={pc:head.pc,sourcePc:head.sourcePc,sub:head.sub,op:'repeat_until',condition:folded.condition,body:folded.body,optimizedFrom:folded.folded?'backedge-repeat+condition':'backedge-repeat'};
      xs=[...xs.slice(0,h),node,...xs.slice(g+1)];changed=true;break;
    }
  }
  return xs;
}
export function structureWhiles(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
