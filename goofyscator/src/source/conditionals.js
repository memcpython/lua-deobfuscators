// Conservative single-entry IF/ELSE recovery for emitter-local IR.  Loop
// structuring runs first, so this pass recursively works inside loop bodies.
function incomingMap(xs){const m=new Map();for(let i=0;i<xs.length;i++){const t=xs[i].target;if(t==null)continue;if(!m.has(t))m.set(t,[]);m.get(t).push(i);}return m;}
function bodyHasForeignEntry(xs,lo,hi,allowed=new Set()){
  if(lo>hi)return false;const pcs=new Set(xs.slice(lo,hi+1).map(x=>x.pc));const inc=incomingMap(xs);
  for(const pc of pcs)for(const src of inc.get(pc)??[])if((src<lo||src>hi)&&!allowed.has(src))return true;
  return false;
}
function process(xs){
  // First structure nested loop bodies so IF recovery can be applied at every
  // lexical level independently.
  xs=xs.map(x=>x.body?{...x,body:process(x.body)}:x);
  const out=[];
  for(let i=0;i<xs.length;i++){
    const x=xs[i];if(x.op!=='branch_false'){out.push(x);continue;}
    const byPc=new Map(xs.map((y,j)=>[y.pc,j])),elseI=byPc.get(x.target);
    if(elseI==null||elseI<=i){out.push(x);continue;}
    // Do not consume a region with an external entry into the true arm.
    if(bodyHasForeignEntry(xs,i+1,elseI-1,new Set([i]))){out.push(x);continue;}
    let thenEnd=elseI-1;while(thenEnd>i&&xs[thenEnd].op==='source_label')thenEnd--;
    const tail=xs[thenEnd];
    if(tail?.op==='jump'){
      const joinI=byPc.get(tail.target);
      if(joinI!=null&&joinI>elseI){
        // Branch enters the else arm; the then-tail jump is the only additional
        // entry into the join, which itself is not consumed.
        if(bodyHasForeignEntry(xs,elseI,joinI-1,new Set([i]))){out.push(x);continue;}
        const thenBody=process(xs.slice(i+1,thenEnd));
        const elseBody=process(xs.slice(elseI,joinI).filter(y=>y.op!=='source_label'));
        const {target:_t,...head}=x;out.push({...head,op:'if',thenBody,elseBody});i=joinI-1;continue;
      }
    }
    // No explicit else: false jumps directly to the join.
    const thenBody=process(xs.slice(i+1,elseI).filter(y=>y.op!=='source_label'));
    const {target:_t,...head}=x;out.push({...head,op:'if',thenBody,elseBody:[]});i=elseI-1;
  }
  return out;
}
export function structureConditionals(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
