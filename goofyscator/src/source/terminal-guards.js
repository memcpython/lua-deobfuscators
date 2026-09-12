// Recover terminal guard ladders as a single source-level IF/ELSEIF/ELSE.
//
// Lua compilers commonly lower
//   if a then return x elseif b then return y else return z end
// into consecutive conditional guards because each taken arm terminates the
// current function.  At this late source-recovery stage all VM jumps have
// already been structured, so this pass only touches an exact, single-entry
// sequence of terminal guards.  It never guesses from names or constants.

const TERMINAL_OPS=new Set(['return','return_literal','return_cell','tailcall','source_tailcall']);

function terminalInstruction(x){
  if(!x)return false;
  if(TERMINAL_OPS.has(x.op))return true;
  if(x.op==='if_chain')return x.branches?.length>0&&x.branches.every(b=>sequenceTerminates(b.body))&&sequenceTerminates(x.elseBody);
  if(x.op==='if')return (x.thenBody?.length??0)>0&&(x.elseBody?.length??0)>0&&sequenceTerminates(x.thenBody)&&sequenceTerminates(x.elseBody);
  return false;
}
function sequenceTerminates(xs){
  const live=(xs??[]).filter(x=>x?.op!=='nop'&&x?.op!=='source_label');
  return live.length>0&&terminalInstruction(live.at(-1));
}

function usesReg(v,r){
  if(!v)return false;if(v.kind==='reg')return v.index===r;
  if(v.kind==='table')return (v.entries??[]).some(e=>usesReg(e,r));
  if(v.kind==='index')return usesReg(v.table,r)||usesReg(v.key,r);
  if(v.kind==='global')return usesReg(v.key,r);
  if(v.kind==='unary')return usesReg(v.value,r);
  if(v.kind==='binary')return usesReg(v.left,r)||usesReg(v.right,r);
  if(v.kind==='logical')return (v.values??[]).some(e=>usesReg(e,r));
  if(v.kind==='call')return usesReg(v.fn,r)||(v.args??[]).some(e=>usesReg(e,r));
  if(v.kind==='cell_read')return usesReg(v.cell,r);
  return false;
}
function readsReg(x,r){
  if(!x)return false;
  for(const v of [x.src,x.left,x.right,x.value,x.key,x.condition,x.fn])if(usesReg(v,r))return true;
  for(const v of x.args??[])if(usesReg(v,r))return true;
  if(x.op==='move_pair'&&x.secondSrc===r)return true;
  if(x.op==='gettable'&&x.table===r)return true;
  if(x.op==='settable'&&x.table===r)return true;
  if(x.op==='return'&&x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)return true;
  if(['call','tailcall'].includes(x.op)&&Number.isInteger(x.base)){if(x.base===r)return true;if(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount)return true;}
  for(const k of ['setup','body','thenBody','elseBody'])if((x[k]??[]).some(y=>readsReg(y,r)))return true;
  for(const b of x.branches??[])if((b.body??[]).some(y=>readsReg(y,r))||usesReg(b.condition,r))return true;
  return false;
}
function writesReg(x,r){
  if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  if(x.op==='clear_range')return r>=x.from&&r<=x.to;
  if(['call','source_call','identity_results','cell_results','constant_call'].includes(x.op)&&x.resultCount>0)return r>=x.base&&r<x.base+x.resultCount;
  if(x.op==='vararg'&&x.count>0)return r>=x.base&&r<x.base+x.count;
  return false;
}
function builderAst(x,r){
  if(x?.dst!==r)return null;
  if(x.op==='move')return structuredClone(x.src);
  if(x.op==='binary')return {kind:'binary',operator:x.operator,left:structuredClone(x.left),right:structuredClone(x.right)};
  if(x.op==='unary')return {kind:'unary',operator:x.operator,value:structuredClone(x.value)};
  if(x.op==='logical_chain')return {kind:'logical',operator:x.operator,values:structuredClone(x.values??[])};
  if(x.op==='getglobal')return {kind:'global',key:structuredClone(x.key)};
  if(x.op==='gettable')return {kind:'index',table:{kind:'reg',index:x.table},key:structuredClone(x.key)};
  return null;
}
function absorbConditionBuilders(xs){
  const out=[];
  for(let i=0;i<xs.length;i++){
    const build=xs[i],guard=xs[i+1];
    if(guard?.op==='if'&&guard.condition?.kind==='reg'){
      const r=guard.condition.index,expr=builderAst(build,r);
      if(expr&&!readsReg({op:'holder',thenBody:guard.thenBody,elseBody:guard.elseBody},r)){
        let safe=true;
        for(let j=i+2;j<xs.length;j++){
          const y=xs[j];if(writesReg(y,r))break;if(readsReg(y,r)){safe=false;break;}
        }
        if(safe){out.push({...guard,condition:expr,optimizedFrom:`${guard.optimizedFrom??'structured-if'}+condition-expression`});i++;continue;}
      }
    }
    out.push(build);
  }
  return out;
}

function recurse(x){
  const y={...x};
  for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);
  if(y.branches)y.branches=y.branches.map(b=>({...b,body:process(b.body)}));
  return y;
}
function process(input){
  let xs=absorbConditionBuilders((input??[]).map(recurse));
  for(let i=0;i<xs.length;i++){
    const branches=[];let j=i;
    while(j<xs.length){
      const g=xs[j];
      if(g?.op!=='if'||(g.elseBody?.length??0)!==0||!sequenceTerminates(g.thenBody))break;
      branches.push({condition:g.condition,body:g.thenBody,pc:g.pc,sourcePc:g.sourcePc,sourceLine:g.sourceLine});
      j++;
    }
    // Require a genuine elseif ladder (two or more guards) and a terminal
    // default suffix.  This avoids cosmetically converting ordinary early
    // returns into large artificial else blocks.
    if(branches.length<2||!sequenceTerminates(xs.slice(j)))continue;
    const elseBody=xs.slice(j);
    const head=xs[i];
    xs=[...xs.slice(0,i),{
      pc:head.pc,sourcePc:head.sourcePc,sub:head.sub,sourceLine:head.sourceLine,
      op:'if_chain',branches,elseBody,optimizedFrom:'terminal-guard-ladder'
    }];
    break; // the recovered chain consumes the terminal suffix by construction.
  }
  return xs;
}

export function recoverTerminalGuards(program){
  const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};
}
