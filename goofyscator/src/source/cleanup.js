// Final emitter-local CFG cleanup. Remove jumps to the immediate lexical
// successor after earlier structuring passes have collapsed their regions.
function clean(xs){
  xs=xs.map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=clean(y[k]);return y;});
  let changed=true;while(changed){changed=false;const out=[];for(let i=0;i<xs.length;i++){const x=xs[i],next=xs[i+1];if(x.op==='jump'&&next&&x.target===next.pc){changed=true;continue;}out.push(x);}xs=out;}
  const targets=new Set();const collect=ys=>{for(const x of ys){if(x.target!=null)targets.add(x.target);for(const k of ['setup','body','thenBody','elseBody'])if(x[k])collect(x[k]);}};collect(xs);
  return xs.filter(x=>x.op!=='source_label'||targets.has(x.pc));
}
export function cleanupSourceCfg(program){const p=structuredClone(program);p.instructions=clean(p.instructions??[]);return {program:p};}
