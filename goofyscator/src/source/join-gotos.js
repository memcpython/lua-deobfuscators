// Remove structured forward gotos that only skip the remainder of the current
// branch and land at the enclosing IF's join point.
//
// After CFG structuring a bytecode shape such as
//
//   if C then A; goto JOIN else B end
//   TAIL
// JOIN:
//
// can survive as a nested source IF plus a synthetic goto.  At source level it
// is exactly:
//
//   if C then A else B; TAIL end
//
// when JOIN is the natural fall-through of the enclosing structured region.
// This pass carries that join target down into branch bodies and redistributes
// the skipped tail. It only rewrites a branch whose *terminal* instruction is
// an unconditional jump to that proven join target; all other gotos are left
// untouched.

function entryPc(x){
  if(!x)return null;
  if(Number.isInteger(x.pc))return x.pc;
  for(const k of ['setup','thenBody','elseBody','body'])for(const y of x[k]??[]){const p=entryPc(y);if(p!=null)return p;}
  for(const b of x.branches??[])for(const y of b.body??[]){const p=entryPc(y);if(p!=null)return p;}
  return null;
}
function firstPc(xs,start=0){for(let i=start;i<(xs?.length??0);i++){const p=entryPc(xs[i]);if(p!=null)return p;}return null;}
function terminalJumpTo(xs,target){
  if(target==null||!xs?.length)return false;
  let i=xs.length-1;while(i>=0&&xs[i]?.op==='nop')i--;
  return i>=0&&xs[i]?.op==='jump'&&xs[i].target===target;
}
function stripTerminalJump(xs,target){
  const out=[...(xs??[])];let i=out.length-1;while(i>=0&&out[i]?.op==='nop')i--;
  if(i>=0&&out[i]?.op==='jump'&&out[i].target===target)out.splice(i,1);
  return out;
}
function processList(input,exitTarget=null){
  const xs=(input??[]).map(x=>structuredClone(x));
  let changed=0;

  // First recurse with the natural post-statement target for each structured
  // statement. For an IF, every branch that reaches the end of its body falls
  // through to the first instruction after that IF (or to this list's exit).
  for(let i=0;i<xs.length;i++){
    const x=xs[i],after=firstPc(xs,i+1)??exitTarget;
    if(x.op==='if'){
      const a=processList(x.thenBody??[],after),b=processList(x.elseBody??[],after);
      x.thenBody=a.instructions;x.elseBody=b.instructions;changed+=a.changed+b.changed;
    }else if(x.op==='if_chain'){
      for(const br of x.branches??[]){const r=processList(br.body??[],after);br.body=r.instructions;changed+=r.changed;}
      const r=processList(x.elseBody??[],after);x.elseBody=r.instructions;changed+=r.changed;
    }else{
      // Loop bodies do not share ordinary IF fall-through semantics: a body
      // end may mean continue/back-edge. Recurse without inventing an exit.
      for(const k of ['setup','body'])if(x[k]){const r=processList(x[k],null);x[k]=r.instructions;changed+=r.changed;}
    }
  }

  // Now eliminate a nested IF whose terminal branch jumps to this list's
  // proven exit. The remaining siblings are exactly the tail skipped by that
  // jump and can be moved into the opposite branch.
  if(exitTarget!=null){
    for(let i=0;i<xs.length;i++){
      const x=xs[i];if(x.op!=='if')continue;
      const thenExit=terminalJumpTo(x.thenBody,exitTarget),elseExit=terminalJumpTo(x.elseBody,exitTarget);
      if(!thenExit&&!elseExit)continue;
      const tail=xs.slice(i+1);
      if(thenExit)x.thenBody=stripTerminalJump(x.thenBody,exitTarget);
      if(elseExit)x.elseBody=stripTerminalJump(x.elseBody,exitTarget);
      if(thenExit&&!elseExit)x.elseBody=[...(x.elseBody??[]),...tail];
      else if(elseExit&&!thenExit)x.thenBody=[...(x.thenBody??[]),...tail];
      // If both branches exit, tail was unreachable in either case.
      xs.splice(i+1);
      changed++;
      break;
    }
  }
  return {instructions:xs,changed};
}

export function eliminateJoinGotos(program){
  const p=structuredClone(program);
  const r=processList(p.instructions??[],null);p.instructions=r.instructions;
  return {program:p,changed:r.changed};
}
