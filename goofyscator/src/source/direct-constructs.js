function writes(x,r){
  if(!x)return false;
  if(x.dst===r||x.secondDst===r)return true;
  if(x.op==='self'&&x.dst+1===r)return true;
  if(['call','source_call','identity_results','cell_results','constant_call'].includes(x.op))return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
  if(['cell_new','cell_get'].includes(x.op))return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
  if(x.op==='clear_range')return r>=x.from&&r<=x.to;
  return false;
}

function origin(xs,before,reg){
  let r=reg,end=before;
  for(let depth=0;depth<32;depth++){
    let di=-1;
    for(let i=end-1;i>=0;i--)if(writes(xs[i],r)){di=i;break;}
    if(di<0)return `arg:${r}`;
    const x=xs[di];
    if(x.op==='move'&&x.dst===r&&x.src?.kind==='reg'){r=x.src.index;end=di;continue;}
    if(x.op==='move_pair'){
      if(x.dst===r&&x.src?.kind==='reg'){r=x.src.index;end=di;continue;}
      if(x.secondDst===r){r=x.secondSrc;end=di;continue;}
    }
    return `def:${di}:${r}`;
  }
  return null;
}

function process(input,stats){
  let xs=(input??[]).map(x=>{
    const y={...x};
    for(const k of ['setup','body','thenBody','elseBody'])if(Array.isArray(y[k]))y[k]=process(y[k],stats);
    if(y.branches)y.branches=y.branches.map(b=>({...b,body:process(b.body??[],stats)}));
    return y;
  });

  for(let i=0;i+1<xs.length;i++){
    const call=xs[i],loop=xs[i+1];
    if(call?.op!=='source_call'||loop?.op!=='generic_for')continue;
    if(call.resultCount!==3||call.base!==loop.base||loop.control!==call.base+2)continue;
    loop.iterator={kind:'call',fn:structuredClone(call.fn),args:structuredClone(call.args??[]),sourceLine:call.sourceLine};
    xs[i]={pc:call.pc,sourcePc:call.sourcePc,sub:call.sub,op:'nop',optimizedAway:'source-generic-for-iterator'};
    stats.genericForCalls++;
  }

  for(let i=0;i+2<xs.length;i++){
    const get=xs[i],recv=xs[i+1],call=xs[i+2];
    if(get?.op!=='gettable'||recv?.op!=='move'||call?.op!=='call')continue;
    if(call.base!==get.dst||recv.dst!==get.dst+1||call.argCount<1||call.resultCount<0)continue;
    if(get.table!==get.dst||recv.src?.kind!=='reg')continue;
    if(get.key?.kind!=='literal'||typeof get.key.value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(get.key.value))continue;
    if(origin(xs,i,get.table)!==origin(xs,i,recv.src.index))continue;
    const args=[];for(let a=2;a<=call.argCount;a++)args.push({kind:'reg',index:call.base+a});
    xs[i]={pc:get.pc,sourcePc:get.sourcePc,sub:get.sub,op:'nop',optimizedAway:'source-method-call'};
    xs[i+1]={pc:recv.pc,sourcePc:recv.sourcePc,sub:recv.sub,op:'nop',optimizedAway:'source-method-call'};
    xs[i+2]={...call,op:'source_method_call',receiver:{kind:'reg',index:recv.src.index},key:structuredClone(get.key),args,optimizedFrom:'gettable-self-call'};
    stats.methodCalls++;
  }
  return xs.filter(x=>x.op!=='nop'||!['source-generic-for-iterator','source-method-call'].includes(x.optimizedAway));
}

export function recoverDirectSourceConstructs(program){
  const p=structuredClone(program),stats={genericForCalls:0,methodCalls:0};
  p.instructions=process(p.instructions??[],stats);
  return {program:p,...stats};
}
