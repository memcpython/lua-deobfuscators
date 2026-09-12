function literal(v, expected) { return v?.kind === 'literal' && v.value === expected; }
function nop(x, why) { return { pc:x.pc, sourcePc:x.sourcePc, sub:x.sub, op:'nop', optimizedAway:why }; }

/**
 * Remove Goofyfuscator's surviving prologue probe after the main V10 protection
 * interval has been stripped.  This is deliberately structural: it requires the
 * pcall/tonumber/zero-arg helper/pcall sequence and never keys off VM PCs.
 */
export function stripBootstrapProbe(bundle) {
  const root=bundle.programs.find(p=>p.id===0); if(!root)return {stripped:false};
  const live=root.instructions.map((x,i)=>({x,i})).filter(e=>e.x.op!=='nop');
  if(live.length<5)return {stripped:false};
  const [a,b,c,d,e]=live;
  const ok=a.x.op==='getglobal'&&literal(a.x.key,'pcall')&&
    b.x.op==='getglobal'&&literal(b.x.key,'tonumber')&&
    c.x.op==='closure'&&(c.x.upvalues?.length??0)===0&&c.x.prototype!=null&&
    d.x.op==='call'&&d.x.base===c.x.dst&&d.x.argCount===0&&d.x.resultCount<0&&
    e.x.op==='call'&&e.x.base===a.x.dst&&e.x.argCount<0&&e.x.resultCount===0;
  if(!ok)return {stripped:false};
  for(const item of [a,b,c,d,e])root.instructions[item.i]=nop(item.x,'goofy-bootstrap-probe');
  return {stripped:true,prototype:c.x.prototype,pcs:[a.x.pc,b.x.pc,c.x.pc,d.x.pc,e.x.pc]};
}
