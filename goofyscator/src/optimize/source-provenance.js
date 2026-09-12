import { maxRegisterIndex } from '../ir/registers.js';

// Identify source-visible values before constant propagation destroys their
// register lifetime. Goofyfuscator's value wrappers lower a source local into
// an `identity-results` move. When that stable result is reused, it is a real
// source binding rather than one-use VM staging.
//
// This deliberately mirrors the later lexical-local recovery proof: only a
// wrapper-unbox result with at least two reads before its next write is pinned.
// The optimizer may still propagate its *value* for analysis, but it must not
// substitute those reads with literals or fold expressions that depend on it.

function walkValue(v, visit) {
  if (!v || typeof v !== 'object') return;
  visit(v);
  for (const k of ['table','key','value','left','right','fn','cell']) walkValue(v[k], visit);
  for (const k of ['entries','args','values']) for (const x of v[k] ?? []) walkValue(x, visit);
}

function valueReadCount(v, r) {
  let n=0;
  walkValue(v, x=>{ if (x.kind==='reg' && x.index===r) n++; });
  return n;
}

function instructionReadCount(x, r, maxRegister) {
  if (!x) return 0;
  let n=0;
  for (const k of ['src','left','right','value','key','condition','fn','cell']) n+=valueReadCount(x[k],r);
  for (const k of ['entries','args','values']) for (const v of x[k] ?? []) n+=valueReadCount(v,r);
  switch (x.op) {
    case 'gettable': n+=x.table===r?1:0; break;
    case 'settable': n+=x.table===r?1:0; break;
    case 'setglobal': n+=x.src===r?1:0; break;
    case 'self': n+=x.dst===r?1:0; break;
    case 'setlist': n+=(x.table===r?1:0)+(r>=x.from&&r<=(x.open?maxRegister:x.to)?1:0); break;
    case 'call': case 'tailcall': {
      const end=x.argCount<0?maxRegister:x.base+Math.max(0,x.argCount);
      if (r>=x.base && r<=end) n++;
      break;
    }
    case 'identity_results': n+=r>=x.sourceBase&&r<x.sourceBase+x.count?1:0; break;
    case 'return': if(x.hasValues){const end=x.open?maxRegister:x.base+Math.max(0,x.count)-1;if(r>=x.base&&r<=end)n++;} break;
    case 'closure': for(const b of x.upvalues??[]) if(b.kind===0&&b.index===r)n++; break;
    case 'forprep': case 'forloop': n+=(x.index===r?1:0)+(x.limit===r?1:0)+(x.step===r?1:0); break;
    case 'tforloop': n+=(x.base===r?1:0)+(x.base+1===r?1:0)+(x.control===r?1:0); break;
  }
  return n;
}

function writesRegister(x,r,maxRegister){
  if(!x)return false;
  if(x.dst===r||x.secondDst===r)return true;
  if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){
    case 'clear_range':return r>=x.from&&r<=x.to;
    case 'call':case 'identity_results':case 'cell_results':case 'constant_call':
      if(x.resultCount<0)return r>=x.base&&r<=maxRegister;
      return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new':case 'cell_get':return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);
    case 'vararg':return x.count<0?(r>=x.base&&r<=maxRegister):(x.count>0&&r>=x.base&&r<x.base+x.count);
    case 'forprep':case 'forloop':return x.index===r;
    case 'tforloop':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
    default:return false;
  }
}


export function markSourceBindings(program){
  const xs=program.instructions??[],max=Math.max(0,maxRegisterIndex(program)),registers=new Set();let marked=0;
  for(let i=0;i<xs.length;i++){
    const x=xs[i];
    const identity=x.op==='move'&&x.optimizedFrom==='identity-results'&&x.src;
    const repeatedLiteral=x.op==='move'&&x.src?.kind==='literal';
    if(!identity&&!repeatedLiteral)continue;
    let reads=0;
    for(let j=i+1;j<xs.length;j++){
      const y=xs[j];reads+=instructionReadCount(y,x.dst,max);
      if(writesRegister(y,x.dst,max))break;
    }
    if(reads<2)continue;
    x.sourceBinding=true;
    registers.add(x.dst);
    marked++;
  }
  // Keep annotations discovered by an earlier optimizer iteration even when a
  // later cleanup changed the local read count around them.
  for(const x of xs)if(x?.sourceBinding&&Number.isInteger(x.dst))registers.add(x.dst);
  return {registers,marked};
}

export function dependsOnSourceBinding(value, regs, sourceBindings){
  if(!value||value.kind!=='reg'||!regs.has(value.index))return false;
  const f=regs.get(value.index);
  return Number.isInteger(f?.origin)&&sourceBindings.has(f.origin);
}
