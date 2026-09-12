// Recover source-level short-circuit chains after CFG structuring.
//
// A bytecode compiler commonly lowers `a and b and c` into a sequence of
// `if condition then condition = nextExpression end` guards.  This pass only
// folds a guard body when the entire body is a single expression computation
// for the guarded register and every potentially observable expression node is
// consumed exactly once by that result.  No source names or corpus fixtures are
// consulted.

const R=index=>({kind:'reg',index});
const L=value=>({kind:'literal',value});
let nextSid=1;
const node=(kind,fields={})=>({kind,...fields,sid:nextSid++});

function cloneAst(a){return a==null?a:structuredClone(a);}
function fromValue(v,state){
  if(v?.kind==='literal')return L(v.value);
  if(v?.kind==='reg')return cloneAst(state.get(v.index)??R(v.index));
  if(v?.kind==='table')return node('table',{entries:(v.entries??[]).map(e=>fromValue(e,state))});
  return L(null);
}
function summarize(body,target){
  const state=new Map(),observables=new Set();
  const save=(r,e,observable=false)=>{state.set(r,e);if(observable&&e?.sid)observables.add(e.sid);};
  for(const x of body??[]){
    if(x.op==='nop'||x.op==='source_label')continue;
    switch(x.op){
      case 'move':save(x.dst,fromValue(x.src,state));break;
      case 'getglobal':save(x.dst,node('global',{key:fromValue(x.key,state)}),true);break;
      case 'getupval':save(x.dst,node('upvalue_ref',{slot:x.slot}),true);break;
      case 'gettable':save(x.dst,node('index',{table:cloneAst(state.get(x.table)??R(x.table)),key:fromValue(x.key,state)}),true);break;
      case 'cell_get':save(x.dst,node('cell_read',{cell:cloneAst(state.get(x.cell)??R(x.cell))}),false);for(let i=1;i<Math.max(1,x.resultCount??1);i++)save(x.dst+i,L(null));break;
      case 'unary':save(x.dst,node('unary',{operator:x.operator,value:fromValue(x.value,state)}),true);break;
      case 'binary':save(x.dst,node('binary',{operator:x.operator,left:fromValue(x.left,state),right:fromValue(x.right,state)}),true);break;
      case 'logical_chain':save(x.dst,node('logical',{operator:x.operator,values:(x.values??[]).map(v=>astFrom(v,state))}),true);break;
      case 'constant_call':if(x.resultCount>0)save(x.base,fromValue(x.value,state));break;
      case 'call':{
        if(x.argCount<0||x.resultCount!==1||x.sourceVarargArgs)return null;
        const fn=cloneAst(state.get(x.base)??R(x.base)),args=[];for(let i=1;i<=x.argCount;i++)args.push(cloneAst(state.get(x.base+i)??R(x.base+i)));
        save(x.base,node('call',{fn,args}),true);break;
      }
      default:return null;
    }
  }
  const expr=state.get(target);if(!expr)return null;
  const counts=new Map();
  const walk=a=>{if(!a)return;if(a.sid)counts.set(a.sid,(counts.get(a.sid)??0)+1);switch(a.kind){case 'table':for(const e of a.entries??[])walk(e);break;case 'global':walk(a.key);break;case 'index':walk(a.table);walk(a.key);break;case 'cell_read':walk(a.cell);break;case 'unary':walk(a.value);break;case 'binary':walk(a.left);walk(a.right);break;case 'logical':for(const e of a.values??[])walk(e);break;case 'call':walk(a.fn);for(const e of a.args??[])walk(e);break;}};
  walk(expr);
  for(const sid of observables)if(counts.get(sid)!==1)return null;
  return expr;
}
function astFrom(a,state){
  if(!a)return L(null);if(a.kind==='reg')return cloneAst(state.get(a.index)??R(a.index));if(a.kind==='literal')return L(a.value);
  if(a.kind==='table')return node('table',{entries:(a.entries??[]).map(e=>astFrom(e,state))});
  if(a.kind==='global')return node('global',{key:astFrom(a.key,state)});if(a.kind==='index')return node('index',{table:astFrom(a.table,state),key:astFrom(a.key,state)});
  if(a.kind==='unary')return node('unary',{operator:a.operator,value:astFrom(a.value,state)});if(a.kind==='binary')return node('binary',{operator:a.operator,left:astFrom(a.left,state),right:astFrom(a.right,state)});
  if(a.kind==='logical')return node('logical',{operator:a.operator,values:(a.values??[]).map(v=>astFrom(v,state))});return L(null);
}
function process(xs){
  xs=(xs??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);return y;});
  const out=[];
  for(let i=0;i<xs.length;i++){
    const first=xs[i];if(first.op!=='if'||first.elseBody?.length||first.condition?.kind!=='reg'){out.push(first);continue;}
    const r=first.condition.index,values=[R(r)];let j=i;
    while(j<xs.length){const g=xs[j];if(g.op!=='if'||g.elseBody?.length||g.condition?.kind!=='reg'||g.condition.index!==r)break;const e=summarize(g.thenBody,r);if(!e)break;values.push(e);j++;}
    if(values.length===1){out.push(first);continue;}
    out.push({pc:first.pc,sourcePc:first.sourcePc,sub:first.sub,op:'logical_chain',dst:r,operator:'and',values,optimizedFrom:'structured-short-circuit'});i=j-1;
  }
  return out;
}
export function collapseStructuredLogical(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
