// Conservative loop structuring for the source emitter.
//
// This pass does not change the optimizer IR.  It operates on an emitter-local
// clone, resolves targets through removed NOPs, and only replaces canonical
// VM loop shapes whose single-entry/single-backedge structure is proven.

function valueReads(v, r) { return v?.kind === 'reg' && v.index === r; }

function readsRegister(x, r) {
  if (!x) return false;
  if (valueReads(x.src,r)||valueReads(x.left,r)||valueReads(x.right,r)||valueReads(x.value,r)||valueReads(x.key,r)||valueReads(x.condition,r)) return true;
  switch (x.op) {
    case 'move_pair': return x.secondSrc===r;
    case 'gettable': return x.table===r || valueReads(x.key,r);
    case 'cell_new': return valueReads(x.src,r);
    case 'cell_results': return r>=x.sourceBase && r<x.sourceBase+x.count;
    case 'cell_get': return x.cell===r;
    case 'cell_set': return x.cell===r || valueReads(x.value,r);
    case 'table_literal': return (x.entries??[]).some(v=>valueReads(v,r));
    case 'settable': return x.table===r || valueReads(x.key,r) || valueReads(x.value,r);
    case 'setglobal': return x.src===r || valueReads(x.key,r);
    case 'self': return x.dst===r || valueReads(x.key,r);
    case 'setlist': return x.table===r || (r>=x.from && r<=x.to);
    case 'call': case 'tailcall': {
      if (x.base===r) return true;
      if (x.argCount>=0) return r>x.base && r<=x.base+x.argCount;
      return r>x.base;
    }
    case 'return':
      if (!x.hasValues) return false;
      if (x.open) return r>=x.base;
      return r>=x.base && r<x.base+x.count;
    case 'return_cell': return x.cell===r;
    case 'vararg': return false;
    case 'forprep': case 'forloop': return x.index===r||x.limit===r||x.step===r;
    case 'tforloop': return x.base===r||x.base+1===r||x.control===r;
    case 'identity_results': return r>=x.sourceBase && r<x.sourceBase+x.count;
    case 'closure': return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'logical_chain': return (x.values??[]).some(v=>astReads(v,r));
    default: return false;
  }
}
function astReads(a,r){
  if(!a)return false;if(a.kind==='reg')return a.index===r;if(a.kind==='index')return astReads(a.table,r)||astReads(a.key,r);if(a.kind==='unary')return astReads(a.value,r);if(a.kind==='binary')return astReads(a.left,r)||astReads(a.right,r);if(a.kind==='global')return astReads(a.key,r);return false;
}
function writesRegister(x, r) {
  if (!x) return false;
  if (x.dst===r || x.secondDst===r) return true;
  if (x.op==='self' && r===x.dst+1) return true;
  switch (x.op) {
    case 'clear_range': return r>=x.from&&r<=x.to;
    case 'call': case 'identity_results':
      return x.resultCount>0 && r>=x.base && r<x.base+x.resultCount;
    case 'cell_new': return r>=x.dst && r<x.dst+Math.max(1,x.resultCount??1);
    case 'cell_results': return r>=x.base && r<x.base+Math.max(0,x.resultCount);
    case 'cell_get': return r>=x.dst && r<x.dst+Math.max(1,x.resultCount??1);
    case 'table_literal': return x.dst===r;
    case 'constant_call': return x.resultCount>0 && r===x.base;
    case 'vararg': return x.count>0 && r>=x.base && r<x.base+x.count;
    case 'tforloop': return (r>=x.resultBase&&r<x.resultBase+x.resultCount)||r===x.control;
    case 'forloop': return r===x.index;
    default: return false;
  }
}
function readBeforeWrite(xs, start, r) {
  for (let i=start;i<xs.length;i++) {
    const x=xs[i]; if(readsRegister(x,r))return true; if(writesRegister(x,r))return false;
  }
  return false;
}
function lastDefinition(xs, before, reg) {
  let r=reg, end=before;
  for(let depth=0;depth<16;depth++){
    let found=-1;
    for(let i=end-1;i>=0;i--)if(writesRegister(xs[i],r)){found=i;break;}
    if(found<0)return null;const x=xs[found];
    if(x.op==='move'&&x.src?.kind==='reg'){r=x.src.index;end=found;continue;}
    return {instruction:x,index:found,register:r};
  }
  return null;
}
function lastLiteral(xs,before,reg){const d=lastDefinition(xs,before,reg);return d?.instruction.op==='move'&&d.instruction.src?.kind==='literal'?d.instruction.src.value:undefined;}
function isTargetingInto(xs, lo, hi, allowedIndexes=new Set()) {
  const pcs=new Set(xs.slice(lo,hi+1).map(x=>x.pc));
  for(let i=0;i<xs.length;i++){
    if(i>=lo&&i<=hi)continue;if(allowedIndexes.has(i))continue;
    const t=xs[i].target;if(t!=null&&pcs.has(t))return true;
  }
  return false;
}
function resolveLive(program) {
  const all=program.instructions??[], byPc=new Map(all.map((x,i)=>[x.pc,i])), end=`END_${program.id}`;
  const resolve=target=>{let i=byPc.get(target);if(i==null)return target;while(i<all.length&&all[i].op==='nop')i++;return i<all.length?all[i].pc:end;};
  return { end, instructions:all.filter(x=>x.op!=='nop').map(x=>x.target!=null?{...x,target:resolve(x.target)}:{...x}) };
}

function structureSequence(xs,end) {
  const out=[];
  for(let i=0;i<xs.length;i++){
    const x=xs[i];
    if(x.op==='forprep'){
      const bodyStart=xs[i+1]?.pc; let match=-1;
      for(let j=i+1;j<xs.length;j++){
        const y=xs[j];
        if(y.op==='forloop'&&y.index===x.index&&y.limit===x.limit&&y.step===x.step&&y.target===bodyStart){match=j;break;}
      }
      if(match>i){
        const exit=xs[match+1]?.pc??end, step=lastLiteral(xs,i,x.step);
        const body=xs.slice(i+1,match);
        const controlWritten=body.some(y=>writesRegister(y,x.index)||writesRegister(y,x.limit)||writesRegister(y,x.step));
        const foreignEntry=isTargetingInto(xs,i+1,match-1,new Set([match]));
        const badBackedge=body.some(y=>y.target===bodyStart);
        if(x.target===exit&&typeof step==='number'&&step!==0&&!controlWritten&&!foreignEntry&&!badBackedge){
          const continuePc=`CONT_${x.pc}`;
          const loopPc=xs[match].pc;
          const rewritten=body.map(y=>y.target===loopPc?{...y,target:continuePc}:y);
          rewritten.push({pc:continuePc,op:'source_label',sourceSynthetic:true});
          const nested=structureSequence(rewritten,end);
          const {target:_discardTarget,...head}=x;
          // The VM loop-control slot is one step beyond the last iteration on
          // exit. Preserve that bookkeeping only when the slot is genuinely
          // read before being overwritten after the loop. Most source loops do
          // not observe it, so emitting the synthetic `_ran`/post-increment
          // state would merely leak bytecode register semantics into source.
          const preserveIndex=readBeforeWrite(xs,match+1,x.index);
          out.push({...head,op:'numeric_for',body:nested.instructions,loopPc,exitPc:exit,continuePc,preserveIndex});i=match;continue;
        }
      }
    }
    if(x.op==='tforloop'){
      let back=-1;for(let j=i+1;j<xs.length;j++){if(xs[j].op==='jump'&&xs[j].target===x.pc){back=j;break;}}
      if(back>i){
        const exit=xs[back+1]?.pc??end,body=xs.slice(i+1,back);
        const foreignEntry=isTargetingInto(xs,i+1,back-1,new Set([back]));
        const resultRegs=Array.from({length:x.resultCount},(_,k)=>x.resultBase+k);
        const iteratorMutated=body.some(y=>writesRegister(y,x.base)||writesRegister(y,x.base+1)||writesRegister(y,x.control));
        const postSensitive=[x.control,...resultRegs].some(r=>readBeforeWrite(xs,back+1,r));
        const origin=lastDefinition(xs,i,x.base)?.instruction;
        const callableOrigin=origin&&['closure','call','getglobal','gettable','getupval'].includes(origin.op);
        const badBackedge=body.some(y=>y.target===x.pc);
        if(x.target===exit&&!foreignEntry&&!iteratorMutated&&!postSensitive&&callableOrigin&&!badBackedge){
          const nested=structureSequence(body,end);
          const {target:_discardTarget,...head}=x;
          out.push({...head,op:'generic_for',body:nested.instructions,backPc:xs[back].pc,exitPc:exit});i=back;continue;
        }
      }
    }
    out.push(x);
  }
  return {instructions:out,end};
}

export function structureLoops(program) {
  const {instructions,end}=resolveLive(program);
  const structured=structureSequence(instructions,end);
  return {program:{...program,instructions:structured.instructions},end,changed:structured.instructions.some(x=>x.op==='numeric_for'||x.op==='generic_for')};
}
