import { buildCfg } from '../ir/cfg.js';
import { maxRegisterIndex } from '../ir/registers.js';

const addValueUse=(s,v)=>{
  if(!v||typeof v!=='object')return;
  if(v.kind==='reg'){s.add(v.index);return;}
  for(const k of ['table','key','value','left','right','fn','cell'])addValueUse(s,v[k]);
  for(const k of ['entries','args','values'])for(const a of v[k]??[])addValueUse(s,a);
};
function usesDefs(x,maxRegister){
  const use=new Set(),def=new Set();let pure=false;
  switch(x.op){
    case 'move':addValueUse(use,x.src);def.add(x.dst);pure=true;break;
    case 'binary':addValueUse(use,x.left);addValueUse(use,x.right);def.add(x.dst);pure=false;break;
    case 'unary':addValueUse(use,x.value);def.add(x.dst);pure=false;break;
    case 'logical_chain':for(const v of x.values??[])addValueUse(use,v);def.add(x.dst);pure=false;break;
    case 'move_pair':addValueUse(use,x.src);use.add(x.secondSrc);def.add(x.dst);def.add(x.secondDst);pure=true;break;
    case 'getupval':def.add(x.dst);pure=true;break;
    case 'newtable':def.add(x.dst);pure=true;break;
    case 'cell_new':addValueUse(use,x.src);for(let r=x.dst;r<x.dst+Math.max(1,x.resultCount??1);r++)def.add(r);pure=true;break;
    case 'cell_results':{for(let i=0;i<Math.min(x.count,x.sourceCount??x.count);i++)use.add(x.sourceBase+i);for(let i=0;i<Math.max(0,x.resultCount);i++)def.add(x.base+i);pure=true;break;}
    case 'cell_get':use.add(x.cell);for(let i=0;i<Math.max(1,x.resultCount??1);i++)def.add(x.dst+i);pure=true;break;
    case 'cell_set':use.add(x.cell);addValueUse(use,x.value);break;
    case 'closure':for(const b of x.upvalues??[])if(b.kind===0)use.add(b.index);def.add(x.dst);pure=true;break;
    case 'getglobal':addValueUse(use,x.key);def.add(x.dst);break;
    case 'setglobal':addValueUse(use,x.key);use.add(x.src);break;
    case 'gettable':use.add(x.table);addValueUse(use,x.key);def.add(x.dst);break;
    case 'settable':use.add(x.table);addValueUse(use,x.key);addValueUse(use,x.value);break;
    case 'self':use.add(x.dst);addValueUse(use,x.key);def.add(x.dst);def.add(x.dst+1);break;
    case 'setlist':use.add(x.table);for(let r=x.from;r<=(x.open?maxRegister:x.to);r++)use.add(r);break;
    case 'clear_range':for(let r=x.from;r<=x.to;r++)def.add(r);break;
    case 'branch_false':addValueUse(use,x.condition);break;
    case 'forprep':case 'forloop':use.add(x.index);use.add(x.limit);use.add(x.step);def.add(x.index);break;
    case 'tforloop':use.add(x.base);use.add(x.base+1);use.add(x.control);for(let r=x.resultBase;r<x.resultBase+x.resultCount;r++)def.add(r);def.add(x.control);break;
    case 'call':{const argEnd=x.argCount<0?maxRegister:x.base+Math.max(0,x.argCount);for(let r=x.base;r<=argEnd;r++)use.add(r);if(x.resultCount>0)for(let r=x.base;r<x.base+x.resultCount;r++)def.add(r);else if(x.resultCount<0)for(let r=x.base;r<=maxRegister;r++)def.add(r);break;}
    case 'identity_results':{for(let i=0;i<x.count;i++)use.add(x.sourceBase+i);if(x.resultCount<0){for(let i=0;i<x.count;i++)def.add(x.base+i)}else if(x.resultCount>0){for(let i=0;i<x.resultCount;i++)def.add(x.base+i)}break;}
    case 'constant_call':if(x.resultCount>1)for(let r=x.base;r<x.base+x.resultCount;r++)def.add(r);else if(x.resultCount!==0)def.add(x.base);break;
    case 'tailcall':{const argEnd=x.argCount<0?maxRegister:x.base+Math.max(0,x.argCount);for(let r=x.base;r<=argEnd;r++)use.add(r);break;}
    case 'return':if(x.hasValues){const end=x.open?maxRegister:x.base+Math.max(0,x.count)-1;for(let r=x.base;r<=end;r++)use.add(r);}break;
    case 'return_cell':use.add(x.cell);break;
    case 'vararg':if(x.count<0)for(let r=x.base;r<=maxRegister;r++)def.add(r);else for(let r=x.base;r<x.base+x.count;r++)def.add(r);break;
    case 'close':use.add(x.register);break;
  }
  return {use,def,pure};
}
function unionInto(a,b){let c=false;for(const x of b)if(!a.has(x)){a.add(x);c=true;}return c;}
function setEq(a,b){if(a.size!==b.size)return false;for(const x of a)if(!b.has(x))return false;return true;}
function computeUsedUpvalues(bundle){
  const used=new Map(bundle.programs.map(p=>[p.id,new Set()]));
  // Direct reads belong to the current lexical prototype.
  for(const p of bundle.programs)for(const x of p.instructions??[])if(x.op==='getupval'&&Number.isFinite(x.slot))used.get(p.id).add(x.slot);
  // A child can forward one of the parent's upvalues into a deeper closure.
  // Only propagate that parent slot when the corresponding child slot is
  // actually live. Iterate because forwarding chains can span many levels.
  let changed=true;
  while(changed){
    changed=false;
    for(const p of bundle.programs)for(const x of p.instructions??[]){
      if(x.op!=='closure'||x.prototype==null)continue;
      const childUsed=used.get(x.prototype);if(!childUsed)continue;
      for(const b of x.upvalues??[]){
        if(!childUsed.has(b.slot)||b.kind!==1||!Number.isFinite(b.index))continue;
        const parentUsed=used.get(p.id);if(!parentUsed.has(b.index)){parentUsed.add(b.index);changed=true;}
      }
    }
  }
  return used;
}

export function pruneUnusedClosureBindings(bundle){
  const used=computeUsedUpvalues(bundle);let removed=0;
  for(const p of bundle.programs)for(const x of p.instructions??[]){
    if(x.op!=='closure'||x.prototype==null)continue;
    const childUsed=used.get(x.prototype)??new Set(),before=x.upvalues?.length??0;
    x.upvalues=(x.upvalues??[]).filter(b=>childUsed.has(b.slot));
    removed+=before-x.upvalues.length;
  }
  return removed;
}

export function eliminateDeadRegisterDefs(program){
  for(let i=0;i<program.instructions.length;i++){const x=program.instructions[i];if(x.op==='move'&&x.src?.kind==='reg'&&x.src.index===x.dst)program.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'self-move'};}
  // A register becomes externally observable only once a closure actually captures
  // its cell.  Treating every captured register as escaped for the whole function
  // keeps unrelated bootstrap writes alive (a later capture of R0 used to pin every
  // earlier R0 definition).  Track the first capture point instead.  The closure
  // instruction itself already reads the reaching value, while writes at/after the
  // first capture remain conservatively observable by the child closure.
  const firstCapture=new Map();
  for(let i=0;i<program.instructions.length;i++) for(const b of program.instructions[i].upvalues??[]) if(b.kind===0&&!firstCapture.has(b.index)) firstCapture.set(b.index,i);
  const escapedAt=(r,i)=>firstCapture.has(r)&&i>=firstCapture.get(r);
  let removed=0;
  // CLOSE is meaningful only for a register that still has a live open-upvalue
  // binding after closure-capture pruning.
  for(let i=0;i<program.instructions.length;i++)if(program.instructions[i].op==='close'&&!escapedAt(program.instructions[i].register,i)){const x=program.instructions[i];program.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'close'};removed++;}
  program.cfg=buildCfg(program);const maxRegister=maxRegisterIndex(program);let meta=program.instructions.map(x=>usesDefs(x,maxRegister));const indexByPc=new Map(program.instructions.map((x,i)=>[x.pc,i]));
  const loopRanges=[];for(const n of program.cfg.nodes??[])for(const s of n.successors??[])if(Number.isFinite(s)&&Number.isFinite(n.pc)&&s<=n.pc)loopRanges.push([s,n.pc]);
  const insideLoop=pc=>loopRanges.some(([a,b])=>pc>=a&&pc<=b);
  const liveIn=program.instructions.map(()=>new Set()),liveOut=program.instructions.map(()=>new Set());let changed=true;
  while(changed){changed=false;for(let i=program.instructions.length-1;i>=0;i--){const out=new Set();const node=program.cfg.nodes[i];for(const pc of node?.successors??[]){const si=indexByPc.get(pc);if(si!=null)unionInto(out,liveIn[si]);}const inn=new Set(meta[i].use);for(const r of out)if(!meta[i].def.has(r))inn.add(r);if(!setEq(out,liveOut[i])){liveOut[i]=out;changed=true}if(!setEq(inn,liveIn[i])){liveIn[i]=inn;changed=true}}}
  for(let i=0;i<program.instructions.length;i++){
    const x=program.instructions[i],m=meta[i];
    if(x.op==='move_pair'){
      const firstLive=liveOut[i].has(x.dst)||escapedAt(x.dst,i), secondLive=liveOut[i].has(x.secondDst)||escapedAt(x.secondDst,i);
      if(firstLive&&!secondLive){program.instructions[i]={...x,op:'move',dst:x.dst,src:x.src,optimizedFrom:'move_pair'};removed++;continue;}
      if(!firstLive&&secondLive){program.instructions[i]={...x,op:'move',dst:x.secondDst,src:{kind:'reg',index:x.secondSrc},optimizedFrom:'move_pair'};removed++;continue;}
      if(!firstLive&&!secondLive){program.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'move_pair'};removed++;continue;}
    }
    if(!m.pure||m.def.size===0)continue;
    // A dead literal assignment inside a natural loop is commonly a genuine
    // source-local declaration (`local x`, `local x = 1`). Removing it before
    // loop structuring turns non-empty source bodies into empty loops.
    if(x.op==='move'&&x.src?.kind==='literal'&&x.src.value===null&&insideLoop(x.pc)){
      // Preserve the fact that this dead VM register definition represented a
      // real lexical declaration in the loop body.  The source emitter uses
      // this marker to emit a scoped `local` even though ordinary alias/DCE
      // machinery would otherwise erase it as an unused register temporary.
      x.sourceDeadLocal=true;
      continue;
    }
    let dead=true;for(const r of m.def)if(liveOut[i].has(r)||escapedAt(r,i)){dead=false;break}if(dead){program.instructions[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:x.op};removed++;}
  }
  program.cfg=buildCfg(program);return removed;
}

export function removeUnreachablePrograms(bundle){
  const byId=new Map(bundle.programs.map(p=>[p.id,p])),reachable=new Set([0]),work=[0];while(work.length){const id=work.pop(),p=byId.get(id);if(!p)continue;for(const x of p.instructions)if(x.op==='closure'&&x.prototype!=null&&!reachable.has(x.prototype)){reachable.add(x.prototype);work.push(x.prototype)}}
  const before=bundle.programs.length;bundle.programs=bundle.programs.filter(p=>reachable.has(p.id));return before-bundle.programs.length;
}
