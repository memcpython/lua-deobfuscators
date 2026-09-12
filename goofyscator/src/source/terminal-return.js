// Falling off the end of a Lua function is exactly an empty return. Remove
// only a function's final semantic RETURN-with-no-values; returns inside
// branches/loops are not touched because they can terminate control flow
// before later statements in the enclosing function.
export function trimTerminalEmptyReturn(program){
  const p=structuredClone(program),xs=p.instructions??[];
  for(let i=xs.length-1;i>=0;i--){
    const x=xs[i];if(!x||x.op==='nop'||x.op==='source_label')continue;
    if(x.op==='return'&&!x.hasValues){xs[i]={pc:x.pc,sourcePc:x.sourcePc,sub:x.sub,op:'nop',optimizedAway:'source-terminal-empty-return'};}
    break;
  }
  return {program:p};
}
