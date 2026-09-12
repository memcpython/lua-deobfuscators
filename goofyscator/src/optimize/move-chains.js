// Coalesce dead register-to-register forwarding chains around value-producing
// definitions. This is register-allocation cleanup, not expression guessing:
// the producer stays at the exact same program point, only its destination slot
// changes to the final forwarding slot after proving that slot is unobserved in
// between.

function valueUses(v,r){return v?.kind==='reg'&&v.index===r;}
function usesReg(x,r,max=Infinity){
  if(valueUses(x.src,r)||valueUses(x.left,r)||valueUses(x.right,r)||valueUses(x.value,r)||valueUses(x.key,r)||valueUses(x.condition,r))return true;
  switch(x.op){
    case 'gettable':return x.table===r;
    case 'settable':return x.table===r;
    case 'setglobal':return x.src===r;
    case 'self':return x.dst===r;
    case 'setlist':return x.table===r||(r>=x.from&&r<=x.to);
    case 'call':case 'tailcall':return r>=x.base&&(x.argCount<0||r<=x.base+x.argCount);
    case 'return':return x.hasValues&&r>=x.base&&(x.open||r<x.base+x.count);
    case 'forprep':case 'forloop':return r===x.index||r===x.limit||r===x.step;
    case 'tforloop':return r===x.base||r===x.base+1||r===x.control;
    case 'identity_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'closure':return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'cell_new':return valueUses(x.src,r);
    case 'cell_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'cell_get':case 'cell_set':return x.cell===r;
    case 'return_cell':return x.cell===r;
    case 'table_literal':return (x.entries??[]).some(v=>valueUses(v,r));
    default:return false;
  }
}
function writesReg(x,r){
  if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){
    case 'clear_range':return r>=x.from&&r<=x.to;
    case 'call':case 'identity_results':case 'cell_results':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'constant_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'vararg':return x.count>0&&r>=x.base&&r<x.base+x.count;
    case 'forprep':case 'forloop':return r===x.index;
    case 'tforloop':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}
function controlBarrier(x){return ['jump','branch_false','forprep','forloop','tforloop','return','tailcall','return_literal','return_cell'].includes(x.op);}

function nextOnlyMoveUse(xs,from,r){
  let moveIndex=-1;
  for(let i=from+1;i<xs.length;i++){
    const x=xs[i];if(x.op==='nop')continue;
    if(controlBarrier(x))return null;
    if(usesReg(x,r)){
      if(moveIndex>=0)return null;
      if(x.op!=='move'||x.src?.kind!=='reg'||x.src.index!==r)return null;
      moveIndex=i;
    }
    if(writesReg(x,r))break;
  }
  return moveIndex>=0?moveIndex:null;
}
function slotUnobserved(xs,from,to,r){for(let i=from+1;i<to;i++){const x=xs[i];if(x.op==='nop')continue;if(usesReg(x,r)||writesReg(x,r))return false;}return true;}

export function coalesceMoveChains(bundle){
  let changed=0;
  for(const p of bundle.programs){const xs=p.instructions??[];
    for(let i=0;i<xs.length;i++){
      const producer=xs[i];if(!['closure'].includes(producer.op)||!Number.isInteger(producer.dst))continue;
      let current=producer.dst,cursor=i,final=current;const chain=[];
      for(let depth=0;depth<16;depth++){
        const mi=nextOnlyMoveUse(xs,cursor,current);if(mi==null)break;const m=xs[mi],dst=m.dst;
        if(!slotUnobserved(xs,i,mi,dst))break;
        chain.push(mi);final=dst;current=dst;cursor=mi;
      }
      if(!chain.length||final===producer.dst)continue;
      xs[i]={...producer,dst:final,optimizedFrom:`${producer.optimizedFrom??producer.op}-move-chain`};
      for(const mi of chain){const m=xs[mi];xs[mi]={pc:m.pc,sourcePc:m.sourcePc,sub:m.sub,op:'nop',optimizedAway:'move-chain'};}
      changed+=chain.length;
    }
  }
  return {changed};
}
