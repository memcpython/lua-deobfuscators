// Inline a narrow but useful class of compiler-generated local helpers.
//
// Goofyfuscator preserves ordinary nested helper closures as separate VM
// prototypes. After lexical closure recovery, small helpers that only mutate a
// captured table can still obscure the original source shape, e.g.
//
//   local add = function(i,j) t[i] = t[i] + t[j] end
//   ...
//   add(2,3)
//
// This pass summarizes those helpers from IR semantics (not names/PCs), follows
// closure/upvalue bindings by resource identity, and replaces proven calls with
// a source-level table mutation. Helpers that escape, return values, call other
// functions, branch, or do anything outside the recognized mutation are left
// untouched.

const V=i=>({kind:'reg',index:i});
const keyOfBinding=b=>b?.kind===0?`r:${b.index}`:b?.kind===1?`u:${b.index}`:null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

function value(v,state){
  if(v?.kind==='literal')return {kind:'literal',value:v.value};
  if(v?.kind==='reg')return state.get(v.index)??{kind:'reg',index:v.index};
  return null;
}
function isParam(e,i){return e?.kind==='param'&&e.index===i;}
function isUp(e,slot){return e?.kind==='upvalue'&&e.slot===slot;}
function isIndex(e,slot,key){return e?.kind==='index'&&isUp(e.table,slot)&&same(e.key,key);}

function summarize(program){
  if(!program||program.paramCount!==2)return null;
  const state=new Map([[0,{kind:'param',index:0}],[1,{kind:'param',index:1}]]),sets=[];
  for(const x of program.instructions??[]){
    if(x.op==='nop')continue;
    if(x.op==='move'){const e=value(x.src,state);if(!e)return null;state.set(x.dst,e);continue;}
    if(x.op==='getupval'){state.set(x.dst,{kind:'upvalue',slot:x.slot});continue;}
    if(x.op==='gettable'){
      const t=state.get(x.table),k=value(x.key,state);if(!t||!k)return null;
      state.set(x.dst,{kind:'index',table:t,key:k});continue;
    }
    if(x.op==='binary'){
      const l=value(x.left,state),r=value(x.right,state);if(!l||!r)return null;
      state.set(x.dst,{kind:'binary',operator:x.operator,left:l,right:r});continue;
    }
    if(x.op==='settable'){
      const t=state.get(x.table),k=value(x.key,state),v=value(x.value,state);if(!t||!k||!v)return null;
      sets.push({table:t,key:k,value:v});continue;
    }
    if(x.op==='return'&&!x.hasValues)continue;
    return null;
  }
  if(!sets.length||sets.length>2)return null;
  const slots=new Set();
  const walk=e=>{if(!e)return;if(e.kind==='upvalue')slots.add(e.slot);else if(e.kind==='index'){walk(e.table);walk(e.key);}else if(e.kind==='binary'){walk(e.left);walk(e.right);}};
  for(const s of sets){walk(s.table);walk(s.key);walk(s.value);}if(slots.size!==1)return null;
  const [slot]=slots,p0={kind:'param',index:0},p1={kind:'param',index:1};
  if(sets.length===1){
    const s=sets[0];if(!isUp(s.table,slot)||!isParam(s.key,0)||s.value?.kind!=='binary')return null;
    const b=s.value;if(!isIndex(b.left,slot,p0))return null;
    if(isIndex(b.right,slot,p1))return {kind:'table_binary_table',slot,operator:b.operator,paramCount:2};
    if(isParam(b.right,1))return {kind:'table_binary_value',slot,operator:b.operator,paramCount:2};
    return null;
  }
  const [a,b]=sets;
  if(!isUp(a.table,slot)||!isUp(b.table,slot)||!isParam(a.key,0)||!isParam(b.key,1))return null;
  if(!isIndex(a.value,slot,p1)||!isIndex(b.value,slot,p0))return null;
  return {kind:'table_swap',slot,paramCount:2};
}

function closureOrigins(program){
  let state=new Map();const at=new Map();
  for(const x of program.instructions??[]){
    at.set(x,state=new Map(state));
    if(x.op==='closure'&&x.prototype!=null){
      const captures=new Map();for(const b of x.upvalues??[]){const k=keyOfBinding(b);if(k)captures.set(b.slot,k);}
      state.set(x.dst,{prototype:x.prototype,captures});
    }else if(x.op==='move'){
      if(x.src?.kind==='reg'&&state.has(x.src.index))state.set(x.dst,state.get(x.src.index));else state.delete(x.dst);
    }else{
      const defs=[];if(Number.isInteger(x.dst))defs.push(x.dst);if(Number.isInteger(x.secondDst))defs.push(x.secondDst);
      if(['call','constant_call','identity_results','cell_results','vararg'].includes(x.op)&&Number.isInteger(x.base)&&x.resultCount>0)for(let i=0;i<x.resultCount;i++)defs.push(x.base+i);
      for(const r of defs)state.delete(r);
    }
  }
  return at;
}

function nearestFunctionSlot(program,callIndex,base){
  let r=base,seen=new Set(),defs=[];
  for(let i=callIndex-1;i>=0;i--){
    const x=program.instructions[i];if(x.op==='nop')continue;
    if(x.dst!==r&&x.secondDst!==r)continue;
    if(seen.has(r))return null;seen.add(r);
    if(x.op==='getupval'&&x.dst===r)return {slot:x.slot,defs:[i,...defs]};
    if(x.op==='move'&&x.dst===r&&x.src?.kind==='reg'){defs.unshift(i);r=x.src.index;continue;}
    return null;
  }
  return null;
}

export function inlineCapturedTableHelpers(bundle){
  const out=structuredClone(bundle),byId=new Map(out.programs.map(p=>[p.id,p]));
  const summaries=new Map();for(const p of out.programs){const s=summarize(p);if(s)summaries.set(p.id,s);}
  let calls=0;
  for(const parent of out.programs){
    const originsAt=closureOrigins(parent);
    for(const create of parent.instructions??[]){
      if(create.op!=='closure'||create.prototype==null)continue;
      const child=byId.get(create.prototype);if(!child)continue;
      const parentState=originsAt.get(create)??new Map();
      const childResources=new Map(),helperSlots=new Map();
      for(const b of create.upvalues??[]){
        const resource=keyOfBinding(b);if(!resource)continue;childResources.set(b.slot,resource);
        if(b.kind===0){const origin=parentState.get(b.index),summary=origin&&summaries.get(origin.prototype);if(summary)helperSlots.set(b.slot,{origin,summary});}
      }
      if(!helperSlots.size)continue;
      for(let i=0;i<child.instructions.length;i++){
        const call=child.instructions[i];if(call.op!=='call'||call.resultCount!==0||call.argCount!==2)continue;
        const fnOrigin=nearestFunctionSlot(child,i,call.base),helperSlot=fnOrigin?.slot,helper=helperSlots.get(helperSlot);if(!helper)continue;
        const resource=helper.origin.captures.get(helper.summary.slot);if(!resource)continue;
        let tableSlot=null;for(const [slot,r] of childResources)if(r===resource){tableSlot=slot;break;}if(tableSlot==null)continue;
        for(const di of fnOrigin.defs??[]){const d=child.instructions[di];child.instructions[di]={pc:d.pc,sourcePc:d.sourcePc,sub:d.sub,op:'nop',optimizedAway:'inlined-helper-function-load'};}
        child.instructions[i]={pc:call.pc,sourcePc:call.sourcePc,sub:call.sub,op:'source_table_mutation',mutation:helper.summary.kind,operator:helper.summary.operator??null,slot:tableSlot,args:[V(call.base+1),V(call.base+2)],optimizedFrom:'captured-table-helper'};
        calls++;
      }
    }
  }
  return {bundle:out,calls};
}
