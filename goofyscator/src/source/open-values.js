// Convert emitter-local open VARARG/TOP idioms into native Lua multiple-value
// constructs.  Only adjacent producer/consumer shapes are rewritten; anything
// with an intervening use remains untouched and therefore falls back safely.
export function lowerSourceOpenValues(program){
  const p=structuredClone(program), live=p.instructions.map((x,i)=>({x,i})).filter(e=>e.x.op!=='nop');
  let changed=0;
  for(let k=0;k<live.length;k++){
    const a=live[k],b=live[k+1];if(!b)continue;const y=p.instructions[b.i];

    // CALL A with an open result immediately feeding the open tail of CALL B
    // is Lua's native multiple-result expression-list lowering:
    //
    //   f(g())
    //
    // A normal source call in the final argument position already preserves
    // the exact Lua expansion rule, so expose one symbolic result register to
    // the call-frame slicer and mark it as an open-result proxy.  The direct
    // emitter is not allowed to emit that proxy unless the slicer actually
    // consumes it, which keeps this transformation fail-closed.
    if((a.x.op==='call'&&a.x.resultCount<0||a.x.sourceOpenResult)&&(y.op==='call'||y.op==='tailcall')&&y.argCount<0){
      const prefix=Math.max(0,y.openPrefix??0),expected=y.base+1+prefix;
      // Source-line metadata belongs to the VM instruction that produced each
      // half of the chain and may legitimately differ (notably when an
      // inlined/wrapper helper supplies the final argument). Adjacency plus the
      // exact register/TOP layout is the semantic proof; line equality is not.
      const producerBase=Number.isInteger(a.x.base)?a.x.base:a.x.dst;
      if(producerBase===expected){
        const producer=p.instructions[a.i];
        if(producer.op==='call')producer.resultCount=1;
        producer.sourceOpenResult=true;
        y.argCount=prefix+1;y.openPrefix=-1;y.sourceOpenArgCall=true;
        changed++;continue;
      }
    }

    if(a.x.op!=='vararg'||a.x.count>=0)continue;
    if((y.op==='call'||y.op==='tailcall')&&y.argCount<0){
      const prefix=Math.max(0,y.openPrefix??0),expected=y.base+1+prefix;
      if(a.x.base===expected){
        p.instructions[a.i]={pc:a.x.pc,sourcePc:a.x.sourcePc,sub:a.x.sub,op:'nop',optimizedAway:'source-vararg-args'};
        y.argCount=prefix;y.openPrefix=-1;y.sourceVarargArgs=true;changed++;continue;
      }
    }
    if(y.op==='setlist'&&y.open&&y.from===a.x.base){
      p.instructions[a.i]={pc:a.x.pc,sourcePc:a.x.sourcePc,sub:a.x.sub,op:'nop',optimizedAway:'source-vararg-setlist'};
      p.instructions[b.i]={...y,op:'vararg_setlist',open:false,sourceVararg:true};changed++;continue;
    }
    if(y.op==='return'&&y.open&&a.x.base>=y.base){
      const fixed=a.x.base-y.base;
      p.instructions[a.i]={pc:a.x.pc,sourcePc:a.x.sourcePc,sub:a.x.sub,op:'nop',optimizedAway:'source-vararg-return'};
      p.instructions[b.i]={...y,open:false,count:fixed,sourceVarargReturn:true,hasValues:true};changed++;
    }
  }
  return {program:p,changed};
}
