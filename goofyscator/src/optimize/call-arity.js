import { buildCfg } from '../ir/cfg.js';

// Infer result arity for recovered prototypes whose every explicit return has
// the same fixed cardinality, then use closure-flow analysis to replace CALL
// resultCount=-1 at statically known recovered functions.  This is deliberately
// about arity only: it never evaluates the function or guesses its result.
function fixedReturnArities(bundle){
  const out=new Map();
  for(const p of bundle.programs){
    let arity=null,seen=false,bad=false;
    for(const x of p.instructions){
      if(x.op==='tailcall'){bad=true;break;}
      if(x.op!=='return')continue;
      if(x.open){bad=true;break;}
      const n=x.hasValues?Math.max(0,x.count??0):0;
      if(!seen){arity=n;seen=true;}else if(arity!==n){bad=true;break;}
    }
    if(seen&&!bad)out.set(p.id,arity);
  }
  return out;
}
function copy(s){return new Map(s);}
function merge(a,b){if(!a)return copy(b);const o=new Map();for(const [k,v]of a)if(b.get(k)===v)o.set(k,v);return o;}
function equal(a,b){if(a.size!==b.size)return false;for(const [k,v]of a)if(b.get(k)!==v)return false;return true;}
function killRange(s,a,b){for(let r=a;r<=b;r++)s.delete(r);}
function transfer(x,s,arities,stats){
  const put=(r,v)=>Number.isInteger(v)?s.set(r,v):s.delete(r);
  switch(x.op){
    case 'closure': put(x.dst,x.prototype); break;
    case 'move': put(x.dst,x.src?.kind==='reg'?s.get(x.src.index):null); break;
    case 'move_pair': put(x.dst,x.src?.kind==='reg'?s.get(x.src.index):null);put(x.secondDst,s.get(x.secondSrc));break;
    case 'clear_range':killRange(s,x.from,x.to);break;
    case 'call': {
      const proto=s.get(x.base),known=arities.get(proto);
      if(x.resultCount<0&&known!=null){x.resultCount=known;x.optimizedKnownCalleeArity=proto;stats.calls++;}
      if(x.resultCount>0)killRange(s,x.base,x.base+x.resultCount-1);
      // A zero-result CALL does not overwrite the function register in the VM.
      break;
    }
    case 'constant_call': if(x.resultCount!==0)killRange(s,x.base,x.base+Math.max(1,x.resultCount)-1);break;
    case 'identity_results':if(x.resultCount>0)killRange(s,x.base,x.base+x.resultCount-1);break;
    case 'vararg':if(x.count<0)s.clear();else killRange(s,x.base,x.base+x.count-1);break;
    case 'tforloop':killRange(s,x.resultBase,x.resultBase+x.resultCount-1);s.delete(x.control);break;
    case 'forprep':case 'forloop':s.delete(x.index);break;
    case 'self':s.delete(x.dst);s.delete(x.dst+1);break;
    default: if(Number.isInteger(x.dst))s.delete(x.dst);if(Number.isInteger(x.secondDst))s.delete(x.secondDst);break;
  }
}
export function inferKnownCallArities(bundle){
  const arities=fixedReturnArities(bundle),stats={prototypes:arities.size,calls:0};
  for(const p of bundle.programs){
    const byPc=new Map(p.instructions.map(x=>[x.pc,x])),cfg=p.cfg??buildCfg(p),succ=new Map(cfg.nodes.map(n=>[n.pc,n.successors]));
    if(cfg.entry==null)continue;const incoming=new Map([[cfg.entry,new Map()]]),queue=[cfg.entry],queued=new Set(queue);
    while(queue.length){const pc=queue.shift();queued.delete(pc);const x=byPc.get(pc);if(!x)continue;const state=copy(incoming.get(pc));transfer(x,state,arities,stats);
      for(const n of succ.get(pc)??[]){if(!byPc.has(n))continue;const old=incoming.get(n),m=merge(old,state);if(!old||!equal(old,m)){incoming.set(n,m);if(!queued.has(n)){queued.add(n);queue.push(n);}}}
    }
  }
  return stats;
}
