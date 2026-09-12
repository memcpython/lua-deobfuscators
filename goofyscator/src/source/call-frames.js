// Recover bytecode call frames as source-level call expressions.
//
// Lua bytecode stages a callee and its arguments in consecutive registers.
// The VM lifter preserves that staging faithfully, but source emission should
// not keep it when the staging registers are provably temporary.  This pass
// performs a local backward slice ending at fixed-arity, no-result calls.  It
// only removes producer instructions when:
//   * every produced value has exactly one use in the slice,
//   * the produced register is dead after the call,
//   * no unrelated observable operation is crossed,
//   * leaf register dependencies are not mutated while their expression is
//     deferred, and
//   * the observable evaluation order of the reconstructed expression is the
//     same as the original instruction order.
//
// This is deliberately data-flow based.  It does not inspect corpus names or
// expected source text.

const R=index=>({kind:'reg',index});
const L=value=>({kind:'literal',value});

function children(x){return ['setup','body','thenBody','elseBody'].filter(k=>Array.isArray(x?.[k]));}
function valueReads(v,r){
  if(!v||typeof v!=='object')return 0;
  if(v.kind==='reg')return v.index===r?1:0;
  let n=0;
  for(const k of ['table','key','value','left','right','fn','cell'])n+=valueReads(v[k],r);
  for(const k of ['entries','args','values'])for(const e of v[k]??[])n+=valueReads(e,r);
  return n;
}
function readCount(x,r){
  if(!x)return 0;let n=0;
  for(const k of ['src','left','right','value','key','condition'])n+=valueReads(x[k],r);
  for(const k of ['entries','values'])for(const v of x[k]??[])n+=valueReads(v,r);
  switch(x.op){
    case 'move_pair': n+=x.secondSrc===r?1:0; break;
    case 'gettable': n+=x.table===r?1:0; break;
    case 'settable': n+=x.table===r?1:0; break;
    case 'setglobal': n+=x.src===r?1:0; break;
    case 'self': n+=x.dst===r?1:0; break;
    case 'setlist': n+=x.table===r?1:0; n+=(r>=x.from&&r<=x.to)?1:0; break;
    case 'call': case 'tailcall': n+=x.base===r?1:0; if(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount)n++; break;
    case 'source_call': case 'source_tailcall': n+=valueReads(x.fn,r); for(const a of x.args??[])n+=valueReads(a,r); break;
    case 'return': if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++; break;
    case 'return_cell': n+=x.cell===r?1:0; break;
    case 'cell_new': n+=valueReads(x.src,r); break;
    case 'cell_results': n+=(r>=x.sourceBase&&r<x.sourceBase+x.count)?1:0; break;
    case 'cell_get': n+=x.cell===r?1:0; break;
    case 'cell_set': n+=x.cell===r?1:0; break;
    case 'identity_results': n+=(r>=x.sourceBase&&r<x.sourceBase+x.count)?1:0; break;
    case 'closure': for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++; break;
    case 'numeric_for': n+=(x.index===r?1:0)+(x.limit===r?1:0)+(x.step===r?1:0); break;
    case 'generic_for': n+=(x.base===r?1:0)+(x.base+1===r?1:0)+(x.control===r?1:0); break;
  }
  return n;
}
function deepReadCount(x,r){let n=readCount(x,r);for(const k of children(x))for(const y of x[k])n+=deepReadCount(y,r);return n;}
function writes(x,r){
  if(!x)return false;
  if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){
    case 'clear_range': return r>=x.from&&r<=x.to;
    case 'call': case 'source_call': case 'identity_results': case 'cell_results': return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'constant_call': return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new': case 'cell_get': return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg': return x.count>0&&r>=x.base&&r<x.base+x.count;
    case 'numeric_for': return x.index===r;
    case 'generic_for': return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}
function deadAfter(xs,start,r){
  for(let i=start;i<xs.length;i++){
    const x=xs[i];
    if(deepReadCount(x,r)>0)return false;
    if(writes(x,r))return true;
  }
  return true;
}
function observable(x){
  return new Set(['getglobal','gettable','unary','binary','logical_chain','cell_get','call','source_call']).has(x.op);
}
function pureUncollected(x){
  return new Set(['nop','source_label','move','move_pair','getupval','constant_call']).has(x.op);
}
function astObs(a,out=[]){
  if(!a||typeof a!=='object')return out;
  switch(a.kind){
    case 'global': astObs(a.key,out); break;
    case 'index': astObs(a.table,out); astObs(a.key,out); break;
    case 'cell_read': astObs(a.cell,out); break;
    case 'unary': astObs(a.value,out); break;
    case 'binary': astObs(a.left,out); astObs(a.right,out); break;
    case 'logical': for(const v of a.values??[])astObs(v,out); break;
    case 'table': for(const v of a.entries??[])astObs(v,out); break;
    case 'call': astObs(a.fn,out); for(const v of a.args??[])astObs(v,out); break;
  }
  if(a._obs!=null)out.push(a._obs);
  return out;
}
function stripMeta(a){
  if(!a||typeof a!=='object')return a;
  const o={};for(const [k,v] of Object.entries(a)){if(k.startsWith('_'))continue;o[k]=Array.isArray(v)?v.map(stripMeta):stripMeta(v);}return o;
}

function processList(input){
  let xs=(input??[]).map(x=>{const y={...x};for(const k of children(y))y[k]=processList(y[k]);return y;});
  const targets=new Set(xs.filter(x=>x.target!=null).map(x=>x.target));
  for(let ci=0;ci<xs.length;ci++){
    const call=xs[ci],isTail=call.op==='tailcall';
    if((call.op!=='call'&&!isTail)||call.argCount<0||(!isTail&&call.resultCount<0)||call.sourceVarargArgs)continue;
    const collected=new Set(),building=new Set(),leafRegs=new Map(),memo=new Map(),defRegs=new Map();
    let min=ci,failed=false;

    const nearestDef=(r,before)=>{
      for(let i=before-1;i>=0;i--)if(writes(xs[i],r))return i;
      return -1;
    };
    const noteLeaf=(r,at)=>{const prev=leafRegs.get(r);leafRegs.set(r,prev==null?at:Math.min(prev,at));return R(r);};
    const fromValue=(v,before)=>{
      if(v?.kind==='literal')return L(v.value);
      if(v?.kind==='reg')return buildReg(v.index,before);
      if(v?.kind==='table')return {kind:'table',entries:(v.entries??[]).map(e=>fromValue(e,before))};
      if(v?.kind==='global')return {kind:'global',key:fromValue(v.key,before)};
      if(v?.kind==='index')return {kind:'index',table:fromValue(v.table,before),key:fromValue(v.key,before)};
      if(v?.kind==='unary')return {kind:'unary',operator:v.operator,value:fromValue(v.value,before)};
      if(v?.kind==='binary')return {kind:'binary',operator:v.operator,left:fromValue(v.left,before),right:fromValue(v.right,before)};
      if(v?.kind==='logical')return {kind:'logical',operator:v.operator,values:(v.values??[]).map(e=>fromValue(e,before))};
      if(v?.kind==='call')return {kind:'call',fn:fromValue(v.fn,before),args:(v.args??[]).map(e=>fromValue(e,before))};
      if(v?.kind==='cell_read')return {kind:'cell_read',cell:fromValue(v.cell,before)};
      if(v?.kind)return structuredClone(v);
      return L(null);
    };
    const buildReg=(r,before)=>{
      const key=`${r}@${before}`;if(memo.has(key))return structuredClone(memo.get(key));
      const di=nearestDef(r,before);if(di<0)return noteLeaf(r,before);
      if(building.has(di)){failed=true;return R(r);} // cyclic/reused register flow
      const x=xs[di];
      // Do not fuse call results across distinct source-line boundaries.  The
      // lifted VM retains line metadata for user calls; crossing that boundary
      // turns separate lexical statements (f=factory(...); g=f(...)) into an
      // artificial chained call.  Calls on the same line remain eligible, so
      // genuine nested expressions are still reconstructed.
      if((x.op==='call'||x.op==='source_call')&&Number.isFinite(x.sourceLine)&&Number.isFinite(call.sourceLine)&&x.sourceLine!==call.sourceLine)return noteLeaf(r,before);
      // Decide whether this register *lifetime* can disappear before walking
      // its dependencies. If not, keep the definition in place and use the
      // register as a stable leaf. This makes slicing compositional: a direct
      // assert can still be recovered when its argument value is intentionally
      // live after the call.
      let lifeEnd=ci+1;for(let j=di+1;j<=ci;j++)if(writes(xs[j],r)){lifeEnd=j;break;}
      let lifeUses=0;for(let j=di+1;j<lifeEnd;j++)lifeUses+=readCount(xs[j],r);if(lifeEnd<=ci)lifeUses+=readCount(xs[lifeEnd],r);
      if(lifeUses!==1||(lifeEnd===ci+1&&!deadAfter(xs,ci+1,r)))return noteLeaf(r,before);
      let a=null;building.add(di);
      switch(x.op){
        case 'move': a=fromValue(x.src,di); break;
        case 'move_pair':
          if(x.dst===r)a=fromValue(x.src,di);else if(x.secondDst===r)a=buildReg(x.secondSrc,di);break;
        case 'getglobal': a={kind:'global',key:fromValue(x.key,di),_obs:di}; break;
        case 'getupval': a={kind:'upvalue_ref',slot:x.slot}; break;
        case 'gettable': a={kind:'index',table:buildReg(x.table,di),key:fromValue(x.key,di),_obs:di}; break;
        case 'cell_get': a={kind:'cell_read',cell:buildReg(x.cell,di),_obs:di}; break;
        case 'unary': a={kind:'unary',operator:x.operator,value:fromValue(x.value,di),_obs:di}; break;
        case 'binary': a={kind:'binary',operator:x.operator,left:fromValue(x.left,di),right:fromValue(x.right,di),_obs:di}; break;
        case 'logical_chain': a={kind:'logical',operator:x.operator,values:(x.values??[]).map(v=>fromValue(v,di)),_obs:di}; break;
        case 'constant_call': if(x.resultCount>0&&r===x.base)a=fromValue(x.value,di); break;
        case 'call':
          if(x.resultCount===1&&r===x.base&&x.argCount>=0&&!x.sourceVarargArgs){
            const fn=buildReg(x.base,di),args=[];for(let ai=1;ai<=x.argCount;ai++)args.push(buildReg(x.base+ai,di));
            a={kind:'call',fn,args,...(x.sourceOpenResult?{sourceOpenResult:true}:{}),_obs:di};
          }
          break;
        case 'source_call':
          if(x.resultCount===1&&r===x.base)a={kind:'call',fn:structuredClone(x.fn),args:structuredClone(x.args??[]),_obs:di};
          break;
        default: break;
      }
      building.delete(di);
      if(!a)return noteLeaf(r,before);
      collected.add(di);if(!defRegs.has(di))defRegs.set(di,new Set());defRegs.get(di).add(r);min=Math.min(min,di);memo.set(key,a);return structuredClone(a);
    };

    const fn=buildReg(call.base,ci),args=[];for(let i=1;i<=call.argCount;i++)args.push(buildReg(call.base+i,ci));
    if(failed||!collected.size||[...collected].some(i=>targets.has(xs[i].pc)))continue;

    // Multi-destination instructions need not be all-or-nothing. If one half
    // of a fused MOVE_PAIR is only call-frame staging while the other half is a
    // genuine live source value, retain that live half as a normal MOVE. This
    // preserves the pair's snapshot semantics (the removed destination is no
    // longer written) while allowing the temporary half to disappear into the
    // reconstructed call expression.
    const residual=new Map();
    for(const di of collected){
      const x=xs[di],owned=defRegs.get(di)??new Set(),outs=[];
      if(Number.isFinite(x.dst))outs.push(x.dst);if(Number.isFinite(x.secondDst))outs.push(x.secondDst);
      for(const r of outs){
        if(owned.has(r))continue;
        let end=ci+1;for(let j=di+1;j<=ci;j++)if(writes(xs[j],r)){end=j;break;}
        let uses=0;for(let j=di+1;j<end;j++)uses+=readCount(xs[j],r);if(end<=ci)uses+=readCount(xs[end],r);
        const live=uses>0||!deadAfter(xs,ci+1,r);
        if(!live)continue;
        if(x.op==='move_pair'&&owned.size===1){
          if(r===x.dst)residual.set(di,{pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.dst,src:structuredClone(x.src),optimizedFrom:'move_pair-call-frame-residual'});
          else if(r===x.secondDst)residual.set(di,{pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.secondDst,src:R(x.secondSrc),optimizedFrom:'move_pair-call-frame-residual'});
          else {failed=true;break;}
          continue;
        }
        failed=true;break;
      }
      if(failed)break;
    }
    if(failed)continue;

    // No unrelated observable operation may be crossed when producer
    // evaluation is moved into the call expression.
    for(let i=min;i<ci&&!failed;i++)if(!collected.has(i)&&observable(xs[i])&&!pureUncollected(xs[i]))failed=true;
    if(failed)continue;

    // A raw dependency read by a deferred producer must keep the same value
    // until the call.  (Definitions that are themselves in the slice are not
    // raw leaves and therefore do not appear here.)
    for(const [r,start] of leafRegs){for(let i=start;i<ci;i++)if(writes(xs[i],r)){failed=true;break;}if(failed)break;}
    if(failed)continue;

    // Observable producer instructions must occur in the exact order Lua will
    // evaluate the reconstructed function expression and argument list.
    const original=[...collected].filter(i=>observable(xs[i])).sort((a,b)=>a-b);
    const rebuilt=[];astObs(fn,rebuilt);for(const a of args)astObs(a,rebuilt);
    if(original.length!==rebuilt.length||original.some((v,i)=>v!==rebuilt[i]))continue;

    for(const i of collected){const old=xs[i];xs[i]=residual.get(i)??{pc:old.pc,sourcePc:old.sourcePc,sub:old.sub,op:'nop',optimizedAway:'source-call-frame'};}
    xs[ci]={...call,op:isTail?'source_tailcall':'source_call',fn:stripMeta(fn),args:args.map(stripMeta),...(isTail?{resultCount:0}:{}),optimizedFrom:isTail?'tailcall-frame':'call-frame'};
  }
  return xs.filter(x=>!(x.op==='nop'&&x.optimizedAway==='source-call-frame'));
}

export function collapseCallFrames(program){const p=structuredClone(program);p.instructions=processList(p.instructions??[]);return {program:p};}
