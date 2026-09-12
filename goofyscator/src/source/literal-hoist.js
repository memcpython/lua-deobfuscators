// Recover reusable immutable source values after aggressive IR constant
// propagation.  The optimizer is allowed to replace a local string register
// with the same literal at every use; that is excellent for VM cleanup but can
// erase an obvious lexical binding from the recovered source.
//
// This pass performs source-level CSE for repeated string *values*.  Property
// names, global names and table keys are intentionally excluded: hoisting those
// would turn natural `obj.field` / `global` syntax into dynamic indexing and
// make the decompiler less faithful.

import { maxRegisterIndex } from '../ir/registers.js';

function walkValue(v, visit, keyContext=false) {
  if (!v || typeof v !== 'object') return;
  if (v.kind === 'literal') { if (!keyContext) visit(v); return; }
  if (v.kind === 'global') { walkValue(v.key, visit, true); return; }
  if (v.kind === 'index') {
    walkValue(v.table, visit, false);
    walkValue(v.key, visit, true);
    return;
  }
  if (v.kind === 'unary') { walkValue(v.value, visit, false); return; }
  if (v.kind === 'binary') {
    walkValue(v.left, visit, false); walkValue(v.right, visit, false); return;
  }
  if (v.kind === 'logical') {
    for (const x of v.values ?? []) walkValue(x, visit, false); return;
  }
  if (v.kind === 'call') {
    walkValue(v.fn, visit, false);
    for (const x of v.args ?? []) walkValue(x, visit, false);
    return;
  }
  if (v.kind === 'table') {
    for (const x of v.entries ?? []) walkValue(x, visit, false);
    return;
  }
  if (v.kind === 'cell_read') walkValue(v.cell, visit, false);
}

function visitInstructionValues(x, visit) {
  if (!x) return;
  for (const k of ['src','left','right','value','condition']) walkValue(x[k], visit, false);
  // `key` is a key by definition for low-level table/global operations.
  for (const v of x.entries ?? []) walkValue(v, visit, false);
  for (const v of x.values ?? []) walkValue(v, visit, false);
  if (x.op === 'source_call' || x.op === 'source_tailcall') {
    walkValue(x.fn, visit, false);
    for (const a of x.args ?? []) walkValue(a, visit, false);
  }
  if (x.op === 'source_table_mutation') for (const a of x.args ?? []) walkValue(a, visit, false);
  if (x.op === 'table_record') for (const f of x.fields ?? []) walkValue(f.value, visit, false);
  for (const k of ['setup','body','thenBody','elseBody']) for (const y of x[k] ?? []) visitInstructionValues(y, visit);
}

function rewriteValue(v, replacements, keyContext=false) {
  if (!v || typeof v !== 'object') return v;
  if (v.kind === 'literal') {
    if (!keyContext && typeof v.value === 'string' && replacements.has(v.value)) return {kind:'reg',index:replacements.get(v.value)};
    return v;
  }
  if (v.kind === 'global') return {...v,key:rewriteValue(v.key,replacements,true)};
  if (v.kind === 'index') return {...v,table:rewriteValue(v.table,replacements,false),key:rewriteValue(v.key,replacements,true)};
  if (v.kind === 'unary') return {...v,value:rewriteValue(v.value,replacements,false)};
  if (v.kind === 'binary') return {...v,left:rewriteValue(v.left,replacements,false),right:rewriteValue(v.right,replacements,false)};
  if (v.kind === 'logical') return {...v,values:(v.values??[]).map(x=>rewriteValue(x,replacements,false))};
  if (v.kind === 'call') return {...v,fn:rewriteValue(v.fn,replacements,false),args:(v.args??[]).map(x=>rewriteValue(x,replacements,false))};
  if (v.kind === 'table') return {...v,entries:(v.entries??[]).map(x=>rewriteValue(x,replacements,false))};
  if (v.kind === 'cell_read') return {...v,cell:rewriteValue(v.cell,replacements,false)};
  return v;
}

function rewriteInstruction(x,replacements) {
  const y={...x};
  for (const k of ['src','left','right','value','condition']) if (y[k]) y[k]=rewriteValue(y[k],replacements,false);
  if (y.entries) y.entries=y.entries.map(v=>rewriteValue(v,replacements,false));
  if (y.values) y.values=y.values.map(v=>rewriteValue(v,replacements,false));
  if (y.op==='source_call' || y.op==='source_tailcall') {
    y.fn=rewriteValue(y.fn,replacements,false);
    y.args=(y.args??[]).map(v=>rewriteValue(v,replacements,false));
  }
  if (y.op==='source_table_mutation') y.args=(y.args??[]).map(v=>rewriteValue(v,replacements,false));
  if (y.op==='table_record') y.fields=(y.fields??[]).map(f=>({...f,value:rewriteValue(f.value,replacements,false)}));
  for (const k of ['setup','body','thenBody','elseBody']) if (y[k]) y[k]=y[k].map(z=>rewriteInstruction(z,replacements));
  return y;
}

export function hoistRepeatedLiterals(program,{minStringLength=8,minUses=2}={}) {
  const p=structuredClone(program),counts=new Map();
  for (const x of p.instructions ?? []) visitInstructionValues(x,v=>{
    if (typeof v.value !== 'string' || v.value.length < minStringLength) return;
    counts.set(v.value,(counts.get(v.value)??0)+1);
  });
  const candidates=[...counts].filter(([,n])=>n>=minUses).sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length||a[0].localeCompare(b[0]));
  if (!candidates.length) return {program:p,hoisted:0};
  let next=maxRegisterIndex(p)+1;const replacements=new Map();
  for (const [value] of candidates) replacements.set(value,next++);
  p.instructions=(p.instructions??[]).map(x=>rewriteInstruction(x,replacements));
  const prefix=[];
  for (const [value,r] of replacements) prefix.push({pc:null,sourcePc:null,sub:0,op:'move',dst:r,src:{kind:'literal',value},sourceRecovered:'repeated-literal'});
  p.instructions=[...prefix,...p.instructions];
  return {program:p,hoisted:replacements.size};
}
