function nop(x, why){return {pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:why};}

/** Turn decryption/interposition artifacts that have already been proven into
 * ordinary IR values.  After decoder-fold a constant_call is not a call: the
 * recovered literal is its exact result. */
export function canonicalizeRecoveredValues(bundle){
  let constants=0,identities=0;
  for(const p of bundle.programs) for(let i=0;i<p.instructions.length;i++){
    const x=p.instructions[i];
    if(x.op==='constant_call'&&x.resultCount===1){
      p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.base,src:x.value,optimizedFrom:'recovered-constant'};constants++;continue;
    }
    if(x.op==='identity_results'&&x.resultCount===x.count){
      if(x.count===0){p.instructions[i]=nop(x,'identity-results');identities++;continue;}
      if(x.count===1){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move',dst:x.base,src:{kind:'reg',index:x.sourceBase},optimizedFrom:'identity-results'};identities++;continue;}
      if(x.count===2){p.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'move_pair',dst:x.base,src:{kind:'reg',index:x.sourceBase},secondDst:x.base+1,secondSrc:x.sourceBase+1,optimizedFrom:'identity-results'};identities++;continue;}
    }
  }
  return {constants,identities};
}
