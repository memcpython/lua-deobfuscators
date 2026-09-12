function parseNumber(x) { x=x.trim(); return /^0x/i.test(x) ? parseInt(x,16) : Number(x); }
export function parseHandlerMap(builderSource) {
  const map = new Map(); const propertyKeys = new Set();
  // Direct assignments: local X=n.foo; u[KEY]=X; n.foo=nil
  const direct = /local\s+(\w+)\s*=\s*\w+\.([A-Za-z_]\w*)\s*;\s*\w+\[(0x[0-9A-Fa-f]+|\d+)\]\s*=\s*\1\s*;\s*\w+\.\2\s*=\s*nil/g;
  let m;
  while ((m = direct.exec(builderSource))) { const id=parseNumber(m[3]); map.set(id,m[2]); propertyKeys.add(m[2]); }
  // Polymorphic builds flip the pair orientation used by the builder helper.
  // Detect which element of each {a,b,a,b,...} pair is the actual dispatch ID
  // from the helper loop itself instead of assuming a fixed parity.
  let dispatchOffset=1;
  const helper=/for\s+(\w+)\s*=\s*1\s*,\s*#(\w+)\s*,\s*2\s+do\s+local\s+\w+\s*=\s*\2\[\1\s*\+\s*([01])\]/.exec(builderSource);
  if(helper)dispatchOffset=Number(helper[3]);
  const via = /local\s+(\w+)\s*=\s*\w+\.([A-Za-z_]\w*)\s*;\s*\w+\(\1\s*,\s*\{([^}]*)\}/g;
  while ((m = via.exec(builderSource))) {
    const prop=m[2]; propertyKeys.add(prop);
    const nums=m[3].split(',').map(s=>s.trim()).filter(Boolean).map(parseNumber);
    for(let i=dispatchOffset;i<nums.length;i+=2) if(Number.isFinite(nums[i])) map.set(nums[i],prop);
  }
  // Some minifiers separate declarations/assignments differently; recover all n.foo=nil props for diagnostics.
  for (const x of builderSource.matchAll(/\b\w+\.([A-Za-z_]\w*)\s*=\s*nil\s*;/g)) propertyKeys.add(x[1]);
  return { map, properties:[...propertyKeys], dispatchIds:[...map.keys()], dispatchOffset };
}
