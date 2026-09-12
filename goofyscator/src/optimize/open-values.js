/** Canonicalize VM TOP/open-result idioms when the producer has a statically
 * known arity.  This removes a large amount of residual VM calling convention
 * without guessing about user functions. */
export function normalizeOpenValues(bundle) {
  let normalizedCalls=0, normalizedConstants=0, identityRemoved=0, normalizedSetlists=0, normalizedIdentity=0, normalizedReturns=0;
  for(const p of bundle.programs){
    const live=p.instructions.map((x,i)=>({x,i})).filter(e=>e.x.op!=='nop');

    // A folded decoder call is no longer a call at all: it is a single literal.
    for(const e of live) if(e.x.op==='constant_call'&&e.x.resultCount<0){
      e.x.resultCount=1; e.x.optimizedOpenResult=true; normalizedConstants++;
    }

    // An identity-results node is produced by a proven transparent wrapper.
    // Its source count is exact, even if the VM caller requested an open result.
    // Canonicalizing it here turns the wrapper's artificial TOP mutation into a
    // fixed Lua tuple without assuming anything about user functions.
    for(const e of live) if(e.x.op==='identity_results'&&e.x.resultCount<0&&Number.isInteger(e.x.count)&&e.x.count>=0){
      e.x.resultCount=e.x.count; e.x.optimizedOpenIdentity=true; normalizedIdentity++;
    }

    // If an open result is immediately projected to a fixed number of values,
    // make the producer fixed. This is exactly the information the projection
    // encodes and therefore preserves Lua multiple-return semantics.
    for(let k=0;k<live.length-1;k++){
      const a=live[k],b=live[k+1];
      if(a.x.op==='call'&&a.x.resultCount<0&&b.x.op==='identity_results'&&b.x.sourceBase===a.x.base&&b.x.resultCount>=0){
        a.x.resultCount=Math.max(b.x.count,b.x.resultCount);
        a.x.optimizedOpenResult=true; normalizedCalls++;
        if(b.x.base===a.x.base&&b.x.resultCount===b.x.count){
          p.instructions[b.i]={pc:b.x.pc,sourcePc:b.x.sourcePc,sub:b.x.sub,op:'nop',optimizedAway:'identity-open-projection'};identityRemoved++;
        }
      }
    }

    // Track a statically known TOP. Selected moves/globals and fixed-result
    // producers define it; a fixed call can then replace an argc=-1 consumer.
    let top=null;
    for(const e of live){const x=p.instructions[e.i];if(x.op==='nop')continue;
      if((x.op==='move'||x.op==='getglobal')&&x.selected) top=x.dst;
      else if(x.op==='constant_call'&&x.resultCount>0) top=x.base+x.resultCount-1;
      else if(x.op==='cell_get'&&Math.max(1,x.resultCount??1)>0) top=x.dst+Math.max(1,x.resultCount??1)-1;
      else if((x.op==='cell_new'||x.op==='cell_results')&&x.resultCount>0) top=x.base+x.resultCount-1;
      else if(x.op==='call'||x.op==='tailcall'){
        if(x.argCount<0&&top!=null){
          // argc is the number of registers after the function register. TOP
          // can legally equal the function base, which is the zero-argument
          // open-call form. Preserve any explicit fixed prefix even when TOP
          // lies below it; the VM's _args convention always includes prefix.
          const prefix=Math.max(0,x.openPrefix??0);
          x.argCount=Math.max(prefix,top-x.base,0); x.openPrefix=-1; x.optimizedOpenArgs=true; normalizedCalls++;
        }
        if(x.op==='tailcall') top=null;
        else if(x.resultCount>0)top=x.base+x.resultCount-1;
        else if(x.resultCount===0)top=x.base-1;
        else top=null;
      } else if(x.op==='identity_results'){
        if(x.resultCount>0)top=x.base+x.resultCount-1; else if(x.resultCount===0)top=x.base-1; else top=null;
      } else if(x.op==='setlist'&&x.open&&top!=null&&top>=x.from){
        x.open=false;x.to=top;x.optimizedOpenList=true;normalizedSetlists++;
      } else if(x.op==='return'&&x.open&&top!=null&&top>=x.base){
        x.open=false;x.count=top-x.base+1;x.optimizedOpenReturn=true;normalizedReturns++;
      } else if(x.op==='vararg') top=x.count>=0?x.base+x.count-1:null;
    }
  }
  return {normalizedCalls,normalizedConstants,identityRemoved,normalizedSetlists,normalizedIdentity,normalizedReturns};
}
