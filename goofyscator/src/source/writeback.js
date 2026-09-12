// Collapse an adjacent temporary writeback of the form
//
//   tmp = <single-result expression using dst>
//   dst = tmp
//
// into a direct write to dst, then rewrite reads of the old temporary during
// that temporary's remaining register lifetime.  The pass is intentionally
// narrow: it currently handles unary/binary producers and only straight-line
// value reads before the temporary is overwritten.  It never crosses a
// structured region, call frame, closure capture, or a write to dst.

function vr(v,from,to){
  if(!v||typeof v!=='object')return v;
  if(v.kind==='reg')return v.index===from?{...v,index:to}:v;
  const y={...v};
  for(const k of ['table','key','value','left','right','fn','cell'])if(y[k])y[k]=vr(y[k],from,to);
  for(const k of ['entries','args','values'])if(y[k])y[k]=y[k].map(e=>vr(e,from,to));
  return y;
}
function valueReads(v,r){if(!v||typeof v!=='object')return 0;if(v.kind==='reg')return v.index===r?1:0;let n=0;for(const k of ['table','key','value','left','right','fn','cell'])n+=valueReads(v[k],r);for(const k of ['entries','args','values'])for(const e of v[k]??[])n+=valueReads(e,r);return n;}
function simpleReads(x,r){let n=0;for(const k of ['src','left','right','value','key','condition'])n+=valueReads(x[k],r);for(const k of ['entries','values'])for(const v of x[k]??[])n+=valueReads(v,r);if(x.op==='gettable'||x.op==='settable')n+=x.table===r?1:0;if(x.op==='move_pair')n+=x.secondSrc===r?1:0;return n;}
function writes(x,r){if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;switch(x.op){case 'clear_range':return r>=x.from&&r<=x.to;case 'call':case 'source_call':case 'identity_results':case 'cell_results':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;case 'constant_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;case 'vararg':return x.count>0&&r>=x.base&&r<x.base+x.count;default:return false;}}
function unsupportedRead(x,r){
  if(!x)return false;
  if(['if','while_true','repeat_until','numeric_for','generic_for','closure','call','source_call','tailcall','setlist','cell_results','identity_results','vararg','vararg_setlist'].includes(x.op)){
    // Value-field-only reads on an IF condition are easy, but lifetime through
    // branches is not; keep the proof straight-line.
    return simpleReads(x,r)>0 || x.op==='closure';
  }
  if(x.op==='return'&&x.hasValues&&x.count!==1&&r>=x.base&&r<x.base+x.count)return true;
  if(x.op==='return'&&x.hasValues&&x.count===1&&x.base===r)return false;
  return false;
}
function rewriteSimple(x,from,to){
  const y={...x};for(const k of ['src','left','right','value','key','condition'])if(y[k])y[k]=vr(y[k],from,to);for(const k of ['entries','values'])if(y[k])y[k]=y[k].map(v=>vr(v,from,to));
  if((y.op==='gettable'||y.op==='settable')&&y.table===from)y.table=to;
  if(y.op==='move_pair'&&y.secondSrc===from)y.secondSrc=to;
  if(y.op==='return'&&y.hasValues&&y.count===1&&y.base===from)y.base=to;
  return y;
}
function process(input){
  let xs=(input??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);return y;});
  for(let i=0;i+1<xs.length;i++){
    const p=xs[i],m=xs[i+1];
    if(!['binary','unary'].includes(p.op)||m.op!=='move'||m.secondDst!=null||m.src?.kind!=='reg'||m.src.index!==p.dst||m.dst===p.dst)continue;
    const tmp=p.dst,dst=m.dst;
    if(simpleReads(p,tmp)>0)continue; // would change the producer's input value
    let stop=-1,ok=true,reads=0;
    for(let k=i+2;k<xs.length;k++){
      const x=xs[k];
      if(writes(x,dst)){ok=false;break;}
      if(unsupportedRead(x,tmp)){ok=false;break;}
      const n=simpleReads(x,tmp);reads+=n;
      if(writes(x,tmp)){stop=k;break;}
      if(['if','while_true','repeat_until','numeric_for','generic_for'].includes(x.op)){ok=false;break;}
    }
    if(!ok||reads===0)continue;
    const end=stop>=0?stop:xs.length-1;
    xs[i]={...p,dst,optimizedFrom:`${p.optimizedFrom?p.optimizedFrom+'+':''}source-writeback`};
    xs.splice(i+1,1); // remove the pure forwarding move
    const adjustedEnd=end-1;
    for(let k=i+1;k<=adjustedEnd&&k<xs.length;k++)xs[k]=rewriteSimple(xs[k],tmp,dst);
  }
  return xs;
}
export function collapseWritebackTemps(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
