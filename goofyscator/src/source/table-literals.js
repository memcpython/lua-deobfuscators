// Recover list-style table constructors from NEWTABLE + one SETLIST write.
//
// The transform is deliberately narrow: the fresh table must not be observed
// between allocation and initialization, and it must have exactly one list
// write before its first ordinary use. This lets the source emitter move the
// allocation to the initialization point and emit `{...}` without changing any
// table identity visible to the program.

function valueRegs(v,out){if(v?.kind==='reg')out.push(v.index);else if(v?.kind==='table')for(const e of v.entries??[])valueRegs(e,out);}
function reads(x){
  const out=[];for(const v of [x.src,x.left,x.right,x.value,x.key,x.condition])valueRegs(v,out);
  switch(x.op){
    case 'gettable':out.push(x.table);break;
    case 'settable':out.push(x.table);break;
    case 'setglobal':out.push(x.src);break;
    case 'self':out.push(x.dst);break;
    case 'setlist':out.push(x.table);for(let r=x.from;r<=x.to;r++)out.push(r);break;
    case 'table_literal':for(const e of x.entries??[])valueRegs(e,out);break;
    case 'call':case 'tailcall':if(Number.isInteger(x.base)){out.push(x.base);if(x.argCount>=0)for(let r=x.base+1;r<=x.base+x.argCount;r++)out.push(r);}break;
    case 'return':if(x.hasValues&&!x.open)for(let r=x.base;r<x.base+x.count;r++)out.push(r);break;
    case 'closure':for(const b of x.upvalues??[])if(b.kind===0)out.push(b.index);break;
    case 'cell_new':valueRegs(x.src,out);break;
    case 'cell_results':for(let r=x.sourceBase;r<x.sourceBase+x.count;r++)out.push(r);break;
    case 'cell_get':case 'cell_set':out.push(x.cell);break;
    case 'return_cell':out.push(x.cell);break;
  }return out.filter(Number.isInteger);
}
function writes(x){
  const out=[];if(Number.isInteger(x.dst))out.push(x.dst);if(Number.isInteger(x.secondDst))out.push(x.secondDst);if(x.op==='self'&&Number.isInteger(x.dst))out.push(x.dst+1);
  switch(x.op){
    case 'clear_range':for(let r=x.from;r<=x.to;r++)out.push(r);break;
    case 'call':case 'identity_results':case 'cell_results':if(x.resultCount>0)for(let r=x.base;r<x.base+x.resultCount;r++)out.push(r);break;
    case 'constant_call':if(x.resultCount>0)for(let r=x.base;r<x.base+x.resultCount;r++)out.push(r);break;
    case 'vararg':if(x.count>0)for(let r=x.base;r<x.base+x.count;r++)out.push(r);break;
  }return out.filter(Number.isInteger);
}
function lastDef(xs,before,r){for(let i=before-1;i>=0;i--)if(writes(xs[i]).includes(r))return i;return -1;}

export function recoverTableLiterals(program){
  const p=structuredClone(program),xs=p.instructions??[];let changed=0;
  for(let i=0;i<xs.length;i++){
    const nt=xs[i];if(nt.op!=='newtable')continue;const table=nt.dst;let init=-1,bad=false;
    for(let j=i+1;j<xs.length;j++){
      const x=xs[j];if(x.op==='nop')continue;
      const rr=reads(x),ww=writes(x);
      if(x.op==='setlist'&&x.table===table&&!x.open){init=j;break;}
      if(rr.includes(table)||ww.includes(table)){bad=true;break;}
    }
    if(bad||init<0)continue;
    const sl=xs[init],entries=[];let safe=true;
    for(let r=sl.from;r<=sl.to;r++){
      const d=lastDef(xs,init,r),def=d>=0?xs[d]:null;
      if(def?.op==='move'&&def.src?.kind==='literal'){
        // Only erase the staging move if this SETLIST is its sole use before a
        // redefinition. Otherwise retain the register reference.
        let uses=0,redef=false;for(let k=d+1;k<=init;k++){if(reads(xs[k]).includes(r))uses++;if(k<init&&writes(xs[k]).includes(r)){redef=true;break;}}
        if(!redef&&uses===1){entries.push(structuredClone(def.src));xs[d]={pc:def.pc,sourcePc:def.sourcePc,sub:def.sub,op:'nop',optimizedAway:'source-table-literal-value'};continue;}
      }
      entries.push({kind:'reg',index:r});
    }
    if(!safe)continue;
    xs[i]={pc:nt.pc,sourcePc:nt.sourcePc,sub:nt.sub,op:'nop',optimizedAway:'source-table-literal-allocation'};
    xs[init]={pc:sl.pc,sourcePc:sl.sourcePc,sub:sl.sub,op:'table_literal',dst:table,entries,optimizedFrom:'newtable-setlist'};changed++;
  }
  // Fold fresh child literals into a sole parent literal use.  Because the
  // child has no other use, its identity is not observable before insertion;
  // nesting preserves constructor evaluation order while removing staging
  // registers emitted solely for the bytecode SETLIST ABI.
  let nested=true;
  while(nested){
    nested=false;
    for(let i=0;i<xs.length;i++){
      const child=xs[i];if(child.op!=='table_literal')continue;const r=child.dst;let user=-1,slot=-1,uses=0;
      for(let j=i+1;j<xs.length;j++){
        if(writes(xs[j]).includes(r))break;
        const rr=reads(xs[j]);for(const q of rr)if(q===r)uses++;
        if(xs[j].op==='table_literal'){for(let k=0;k<(xs[j].entries??[]).length;k++){const e=xs[j].entries[k];if(e?.kind==='reg'&&e.index===r){user=j;slot=k;}}}
      }
      if(uses!==1||user<0)continue;
      xs[user].entries[slot]={kind:'table',entries:structuredClone(child.entries??[])};
      xs[i]={pc:child.pc,sourcePc:child.sourcePc,sub:child.sub,op:'nop',optimizedAway:'source-nested-table-literal'};
      changed++;nested=true;break;
    }
  }
  return {program:p,changed};
}
