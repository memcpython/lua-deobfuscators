// Recover a fresh table populated exclusively by an open vararg SETLIST as
// the native Lua constructor `{...}`.  This is the source construct Lua lowers
// to the same register/open-list sequence; no corpus-specific names are used.

function process(xs){
  xs=(xs??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);return y;});
  for(let i=0;i<xs.length;i++){
    const nt=xs[i];if(nt.op!=='newtable')continue;
    let j=i+1;while(j<xs.length&&xs[j].op==='nop')j++;
    const sl=xs[j];if(sl?.op!=='vararg_setlist'||sl.table!==nt.dst)continue;
    xs[i]={pc:nt.pc,sourcePc:nt.sourcePc,sub:nt.sub,op:'table_vararg',dst:nt.dst,optimizedFrom:'vararg-setlist-constructor'};
    xs.splice(j,1);
  }
  return xs;
}
export function recoverVarargTables(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
