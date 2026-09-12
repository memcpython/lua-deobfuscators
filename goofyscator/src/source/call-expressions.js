// Recover effectful call trees that Lua lowered into temporary result registers.
//
// A binary expression such as
//
//   return recurse(n - 1) + recurse(n - 2)
//
// becomes two CALL instructions followed by ADD.  Unlike ordinary pure-temp
// folding, calls cannot be freely delayed past one another.  We therefore fold
// only the strongest source-proven shape:
//   * both operands are single-result source_call values,
//   * both calls carry the same original Lua source line,
//   * the left call was executed before the right call,
//   * no other semantic instruction occurs between the calls and the binary,
//   * each temporary result is consumed only by that binary expression.
//
// This preserves the observed call order in the emitted expression and avoids
// turning unrelated calls into a synthetic source expression merely because a
// register happened to be reused.

function walkValue(v,fn){
  if(!v||typeof v!=='object')return;fn(v);
  for(const k of ['table','key','value','left','right','fn','cell'])walkValue(v[k],fn);
  for(const k of ['entries','args','values'])for(const e of v[k]??[])walkValue(e,fn);
}
function readsValue(v,r){let n=0;walkValue(v,x=>{if(x.kind==='reg'&&x.index===r)n++;});return n;}
function reads(x,r){
  if(!x)return 0;let n=0;
  for(const k of ['src','left','right','value','key','condition','fn','cell'])n+=readsValue(x[k],r);
  for(const k of ['entries','values','args'])for(const v of x[k]??[])n+=readsValue(v,r);
  switch(x.op){
    case 'move_pair':n+=x.secondSrc===r?1:0;break;
    case 'gettable':n+=x.table===r?1:0;break;
    case 'settable':n+=x.table===r?1:0;break;
    case 'source_call':case 'source_tailcall':n+=readsValue(x.fn,r);for(const a of x.args??[])n+=readsValue(a,r);break;
    case 'return':if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++;break;
    case 'closure':for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++;break;
  }
  return n;
}
function writes(x,r){
  if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  if(x.op==='source_local')return x.dst===r;
  if(x.op==='source_local_multi')return (x.targets??[]).includes(r);
  if(['source_call','call','identity_results','cell_results','constant_call'].includes(x.op))return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
  return false;
}
function previousDef(xs,before,r){for(let i=before-1;i>=0;i--)if(writes(xs[i],r))return i;return -1;}
function readAfterBeforeWrite(xs,start,r){for(let i=start;i<xs.length;i++){if(reads(xs[i],r))return true;if(writes(xs[i],r))return false;}return false;}
const nopOf=(x,why)=>({pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:why});

function process(input,stats){
  const xs=(input??[]).map(x=>{
    const y={...x};
    for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k],stats);
    if(y.branches)y.branches=y.branches.map(b=>({...b,body:process(b.body??[],stats)}));
    return y;
  });
  for(let i=0;i<xs.length;i++){
    const b=xs[i];
    if(b?.op!=='binary'||b.left?.kind!=='reg'||b.right?.kind!=='reg')continue;
    const lr=b.left.index,rr=b.right.index,li=previousDef(xs,i,lr),ri=previousDef(xs,i,rr);
    if(li<0||ri<0||li>=ri)continue;
    const l=xs[li],r=xs[ri];
    if(l.op!=='source_call'||r.op!=='source_call'||l.resultCount!==1||r.resultCount!==1||l.base!==lr||r.base!==rr)continue;
    if(!Number.isFinite(l.sourceLine)||l.sourceLine!==r.sourceLine)continue;
    let clean=true;
    for(let j=li;j<i;j++)if(j!==li&&j!==ri&&xs[j]?.op!=='nop'){clean=false;break;}
    if(!clean)continue;
    if(reads(b,lr)!==1||reads(b,rr)!==1)continue;
    if(readAfterBeforeWrite(xs,i+1,rr))continue;
    // The left result may be overwritten by the binary itself (the common Lua
    // register shape); if it is not, it must not remain observable afterwards.
    if(!writes(b,lr)&&readAfterBeforeWrite(xs,i+1,lr))continue;
    const callAst=x=>({kind:'call',fn:structuredClone(x.fn),args:structuredClone(x.args??[]),sourceLine:x.sourceLine});
    xs[i]={...b,left:callAst(l),right:callAst(r),sourceRecovered:'same-line-call-expression'};
    xs[li]=nopOf(l,'source-call-expression');xs[ri]=nopOf(r,'source-call-expression');
    stats.collapsed++;
  }
  return xs;
}

export function recoverSameLineCallExpressions(program){
  const p=structuredClone(program),stats={collapsed:0};
  p.instructions=process(p.instructions??[],stats);
  return {program:p,...stats};
}
