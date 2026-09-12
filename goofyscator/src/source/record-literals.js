// Recover fresh record constructors from NEWTABLE followed by literal-key
// field writes.  Values may come through pure MOVE staging, but only when the
// value can be proven to be the same value already available at the table
// allocation point (or a literal).  This preserves the original evaluation
// point instead of moving calls/indexing/arithmetic into a constructor.

function lastWrite(xs, from, to, r) {
  for (let k=to;k>=from;k--) {
    const x=xs[k];
    if (x?.op==='move' && x.dst===r) return k;
    if (x?.dst===r || x?.secondDst===r) return k;
    if (x?.op==='clear_range' && r>=x.from && r<=x.to) return k;
    if ((x?.op==='call'||x?.op==='identity_results'||x?.op==='constant_call'||x?.op==='cell_results') && x.resultCount>0 && r>=x.base && r<x.base+x.resultCount) return k;
    if (x?.op==='vararg' && x.count>0 && r>=x.base && r<x.base+x.count) return k;
  }
  return -1;
}

// Resolve a register's value at `at` back through move-only definitions to a
// literal or to a register whose value has not changed since allocation.
function resolveValue(xs, alloc, at, value, seen=new Set()) {
  if (value?.kind==='literal') return structuredClone(value);
  if (value?.kind!=='reg') return null;
  const r=value.index;
  if (seen.has(r)) return null;
  seen.add(r);
  const d=lastWrite(xs,alloc+1,at-1,r);
  if (d<0) return {kind:'reg',index:r};
  const def=xs[d];
  if (def.op!=='move') return null;
  return resolveValue(xs,alloc,d,def.src,seen);
}

function process(xs) {
  xs = (xs ?? []).map(x => {
    const y={...x};
    for (const k of ['setup','body','thenBody','elseBody']) if (y[k]) y[k]=process(y[k]);
    return y;
  });

  for (let i=0;i<xs.length;i++) {
    const nt=xs[i]; if (nt.op!=='newtable') continue;
    const fields=[],consumed=[]; let j=i+1,bad=false;
    for (;j<xs.length;j++) {
      const x=xs[j];
      if (x.op==='nop') continue;
      if (x.op==='move' && x.dst!==nt.dst && (x.src?.kind==='reg'||x.src?.kind==='literal')) continue;
      if (x.op==='setlist' && x.table===nt.dst && !x.open && x.from>x.to) { consumed.push(j); continue; }
      if (x.op==='settable' && x.table===nt.dst && x.key?.kind==='literal') {
        const value=resolveValue(xs,i,j,x.value);
        if (!value || (value.kind==='reg'&&value.index===nt.dst)) { bad=true; break; }
        fields.push({key:structuredClone(x.key),value}); consumed.push(j); continue;
      }
      break;
    }
    if (bad || !fields.length) continue;
    xs[i]={pc:nt.pc,sourcePc:nt.sourcePc,sub:nt.sub,op:'table_record',dst:nt.dst,fields,optimizedFrom:'newtable-record-fields'};
    for (const k of consumed) { const old=xs[k]; xs[k]={pc:old.pc,sourcePc:old.sourcePc,sub:old.sub,op:'nop',optimizedAway:'source-record-literal'}; }
  }
  return xs;
}

export function recoverRecordLiterals(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
