// Collapse contiguous closure move chains at source level.
//
// A closure allocation is observable at its original instruction point, so we
// keep the CLOSURE instruction in place and only retarget the destination
// register through immediately following pure moves.  Every intermediate
// register must be dead after its forwarding move.  With no intervening
// instructions, this changes neither closure creation time nor any observable
// read/capture of the destination locals.

function readValue(v,r){if(!v)return 0;if(v.kind==='reg')return v.index===r?1:0;if(v.kind==='table')return (v.entries??[]).reduce((n,e)=>n+readValue(e,r),0);return 0;}
function readCount(x,r){
  if(!x)return 0;let n=0;for(const k of ['src','left','right','value','key','condition'])n+=readValue(x[k],r);
  switch(x.op){
    case 'move_pair':n+=x.secondSrc===r?1:0;break;
    case 'gettable':n+=x.table===r?1:0;break;case 'settable':n+=x.table===r?1:0;break;
    case 'call':case 'tailcall':n+=x.base===r?1:0;if(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount)n++;break;
    case 'return':if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++;break;
    case 'closure':for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++;break;
  }return n;
}
function writes(x,r){if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;switch(x.op){case 'call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;case 'identity_results':case 'cell_results':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;default:return false;}}
function deadAfter(xs,start,r){for(let i=start;i<xs.length;i++){if(readCount(xs[i],r)>0)return false;if(writes(xs[i],r))return true;}return true;}
function process(input){
  const xs=(input??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);return y;});
  const out=[];
  for(let i=0;i<xs.length;i++){
    const x=xs[i];if(x.op!=='closure'){out.push(x);continue;}
    let current=x.dst,j=i+1,final=current,consumed=0;
    while(j<xs.length){const m=xs[j];if(m.op!=='move'||m.secondDst!=null||m.src?.kind!=='reg'||m.src.index!==current||m.dst===current)break;if(!deadAfter(xs,j+1,current))break;final=m.dst;current=m.dst;consumed++;j++;}
    if(!consumed){out.push(x);continue;}
    out.push({...x,dst:final,optimizedFrom:`${x.optimizedFrom?x.optimizedFrom+'+':''}source-closure-move-chain`});
    i+=consumed;
  }
  return out;
}
export function collapseClosureMoveChains(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
