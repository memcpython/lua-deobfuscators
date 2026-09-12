import { buildCfg } from '../ir/cfg.js';

function sameReg(v,r){return v?.kind==='reg'&&v.index===r;}
function astValue(v,current,r){if(sameReg(v,r)&&current)return current;return v?.kind==='reg'?{kind:'reg',index:v.index}:{kind:'literal',value:v?.value??null};}
function stepExpr(x,current,r){
  if(x.op==='move'&&x.dst===r)return astValue(x.src,current,r);
  if(x.op==='identity_results'&&x.base===r&&x.sourceBase===r&&x.count>=1)return current??{kind:'reg',index:r};
  if(x.op==='getglobal'&&x.dst===r)return {kind:'global',key:astValue(x.key,current,r)};
  if(x.op==='gettable'&&x.dst===r&&x.table===r)return {kind:'index',table:current??{kind:'reg',index:r},key:astValue(x.key,current,r)};
  if(x.op==='cell_get'&&x.dst===r&&x.cell===r)return {kind:'cell_read',cell:current??{kind:'reg',index:r}};
  if(x.op==='unary'&&x.dst===r&&sameReg(x.value,r))return {kind:'unary',operator:x.operator,value:current??{kind:'reg',index:r}};
  if(x.op==='binary'&&x.dst===r){
    if(sameReg(x.left,r))return {kind:'binary',operator:x.operator,left:current??{kind:'reg',index:r},right:astValue(x.right,current,r)};
    if(sameReg(x.right,r))return {kind:'binary',operator:x.operator,left:astValue(x.left,current,r),right:current??{kind:'reg',index:r}};
  }
  return null;
}
function extractChain(xs,r,seed=null){let e=seed;for(const x of xs){const n=stepExpr(x,e,r);if(!n)return null;e=n;}return e;}
function usesCondition(x,r){
  const vals=[x.src,x.left,x.right,x.value,x.key,x.condition];if(vals.some(v=>sameReg(v,r)))return true;
  if(['call','tailcall'].includes(x.op)&&Number.isInteger(x.base)){if(x.base===r)return true;const n=x.argCount<0?64:x.argCount;for(let i=1;i<=n;i++)if(x.base+i===r)return true;}
  if(x.op==='return'&&x.hasValues){const n=x.open?64:x.count;for(let i=0;i<n;i++)if(x.base+i===r)return true;}
  if(['gettable','settable','setlist'].includes(x.op)&&x.table===r)return true;
  return false;
}
function replaceNop(p,i,why){const x=p.instructions[i];p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:why};}

function collapseOrInPlace(p){
  const idxByPc=new Map(p.instructions.map((x,i)=>[x.pc,i]));
  const incoming=new Map();for(let i=0;i<p.instructions.length;i++){const t=p.instructions[i].target;if(t!=null){if(!incoming.has(t))incoming.set(t,[]);incoming.get(t).push(i);}}
  let collapsed=0;
  for(let bi=0;bi<p.instructions.length;bi++){
    const br=p.instructions[bi];if(br.op!=='branch_false'||br.condition?.kind!=='reg')continue;const r=br.condition.index;
    const evalI=idxByPc.get(br.target);if(evalI==null||evalI<=bi+1)continue;
    const middle=p.instructions.slice(bi+1,evalI).filter(x=>x.op!=='nop');if(middle.length!==1||middle[0].op!=='jump')continue;
    const joinI=idxByPc.get(middle[0].target);if(joinI==null||joinI<=evalI)continue;
    const finalX=p.instructions[joinI];
    // A TESTSET value is source-visible even when its local result is never
    // used again.  Requiring the join instruction to consume the register made
    // DCE erase exactly those dead-but-real source expressions and left their
    // branch/jump ladder in emitted Lua.  The proven two-arm region itself is
    // sufficient: retaining the logical assignment preserves all conditional
    // evaluation effects and is semantics-equivalent whether or not the result
    // survives past the join.
    const bRaw=p.instructions.slice(evalI,joinI).filter(x=>x.op!=='nop');if(!bRaw.length||bRaw.some(x=>x.op==='jump'||x.op==='branch_false'))continue;
    const bIncoming=incoming.get(bRaw[0].pc)??[];if(bIncoming.length!==1||bIncoming[0]!==bi)continue;
    if(bRaw.slice(1).some(x=>(incoming.get(x.pc)?.length??0)>0))continue;
    const eb=extractChain(bRaw,r);if(!eb)continue;
    let start=bi;while(start>0){const prev=p.instructions[start-1];if(prev.op==='nop'){start--;continue;}if((incoming.get(prev.pc)?.length??0)>0)break;if(!stepExpr(prev,{kind:'reg',index:r},r))break;start--;}
    const aRaw=p.instructions.slice(start,bi).filter(x=>x.op!=='nop');const ea=extractChain(aRaw,r);if(!ea)continue;
    // The only entry into the A computation is fallthrough. The synthetic jump
    // in the true arm must go exactly to the consumer after B.
    if(middle[0].target!==finalX.pc)continue;
    for(let i=start;i<joinI;i++)if(p.instructions[i].op!=='nop')replaceNop(p,i,'short-circuit-or');
    const anchor=br;p.instructions[bi]={pc:anchor.pc,sourcePc:anchor.sourcePc,sub:anchor.sub,op:'logical_chain',dst:r,operator:'or',values:[ea,eb],optimizedFrom:'branch-ladder'};
    collapsed++;bi=joinI-1;
  }
  return collapsed;
}

/** Collapse the VM's TEST/JMP ladder used for Lua short-circuit `and` values.
 * This intentionally recognizes only the same-register form. */
export function collapseShortCircuitAnd(program){
  const p=structuredClone(program); p.cfg=buildCfg(p);
  const idxByPc=new Map(p.instructions.map((x,i)=>[x.pc,i]));
  const targetCount=new Map();for(const x of p.instructions)if(x.target!=null)targetCount.set(x.target,(targetCount.get(x.target)||0)+1);
  let collapsed=0;
  for(let bi=0;bi<p.instructions.length;bi++){
    const first=p.instructions[bi];if(first.op!=='branch_false'||first.condition?.kind!=='reg')continue;const r=first.condition.index;
    const branches=[bi];let cur=first;
    while(true){const ti=idxByPc.get(cur.target);if(ti==null)break;const t=p.instructions[ti];if(t.op==='branch_false'&&t.condition?.kind==='reg'&&t.condition.index===r){if((targetCount.get(t.pc)||0)>1)break;branches.push(ti);cur=t;continue;}break;}
    if(branches.length<1)continue;const last=branches.at(-1),finalPc=p.instructions[last].target,finalI=idxByPc.get(finalPc);if(finalI==null||finalI<=last)continue;
    // The final target must consume the condition before overwriting it.
    const finalX=p.instructions[finalI];if(!usesCondition(finalX,r))continue;
    // Find the maximal same-register expression chain immediately before first branch.
    let start=bi;while(start>0){const prev=p.instructions[start-1];if(prev.op==='nop'){start--;continue;}if((targetCount.get(prev.pc)||0)>0)break;if(!stepExpr(prev,{kind:'reg',index:r},r))break;start--;}
    const firstSeg=p.instructions.slice(start,bi).filter(x=>x.op!=='nop');const exprs=[];const e0=extractChain(firstSeg,r);if(!e0)continue;exprs.push(e0);
    let ok=true;
    for(let k=0;k<branches.length;k++){
      const from=branches[k]+1,to=k+1<branches.length?branches[k+1]:finalI;
      const seg=p.instructions.slice(from,to).filter(x=>x.op!=='nop');if(!seg.length){ok=false;break;}
      // No branch/jump target may enter a computation segment from outside.
      if(seg.some(x=>(targetCount.get(x.pc)||0)>0)){ok=false;break;}
      const e=extractChain(seg,r);if(!e){ok=false;break;}exprs.push(e);
    }
    if(!ok)continue;
    // Remove expression builders and all ladder branches, leaving one value op.
    for(let i=start;i<finalI;i++)if(p.instructions[i].op!=='nop')replaceNop(p,i,'short-circuit-and');
    const anchor=p.instructions[bi];p.instructions[bi]={pc:anchor.pc,sourcePc:anchor.sourcePc,sub:anchor.sub,op:'logical_chain',dst:r,operator:'and',values:exprs,optimizedFrom:'branch-ladder'};
    collapsed++;bi=finalI-1;
  }
  collapsed+=collapseOrInPlace(p);
  p.cfg=buildCfg(p);return {program:p,collapsed};
}
