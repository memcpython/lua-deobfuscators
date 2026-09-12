function addValue(out, value) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'reg' && Number.isInteger(value.index) && value.index >= 0) out.add(value.index);
  for (const k of ['table','key','value','left','right','fn','cell']) addValue(out,value[k]);
  for (const k of ['entries','args','values']) for (const v of value[k] ?? []) addValue(out,v);
}

/** Collect every statically referenced VM register in a lifted prototype. */
export function referencedRegisters(program) {
  const out = new Set();
  const add = value => { if (Number.isInteger(value) && value >= 0) out.add(value); };

  for (const x of program.instructions ?? []) {
    add(x.dst); add(x.secondDst); add(x.secondSrc); add(x.table); add(x.srcRegister);
    if (x.op === 'self' && Number.isInteger(x.dst)) add(x.dst + 1);
    add(x.base); add(x.from); add(x.to); add(x.index); add(x.limit); add(x.step);
    add(x.control); add(x.resultBase); add(x.register);
    add(x.cell); add(x.sourceBase); for (const r of x.targets ?? []) add(r);
    addValue(out, x.src); addValue(out, x.left); addValue(out, x.right);
    addValue(out, x.value); addValue(out, x.key); addValue(out, x.condition);
    for (const v of x.entries ?? []) addValue(out, v);
    for (const v of x.values ?? []) addValue(out, v);
    for (const v of x.args ?? []) addValue(out, v);
    addValue(out, x.fn);

    if (Number.isInteger(x.base)) {
      if (Number.isInteger(x.argCount) && x.argCount > 0) add(x.base + x.argCount);
      if (Number.isInteger(x.resultCount) && x.resultCount > 0) add(x.base + x.resultCount - 1);
      if (Number.isInteger(x.openPrefix) && x.openPrefix > 0) add(x.base + x.openPrefix);
    }
    if (Number.isInteger(x.resultBase) && Number.isInteger(x.resultCount) && x.resultCount > 0) {
      add(x.resultBase + x.resultCount - 1);
    }
    if (x.op === 'cell_results' && Number.isInteger(x.sourceBase) && Number.isInteger(x.count) && x.count > 0) add(x.sourceBase + x.count - 1);
    if (x.op === 'cell_results' && Number.isInteger(x.base) && Number.isInteger(x.resultCount) && x.resultCount > 0) add(x.base + x.resultCount - 1);
    if ((x.op === 'cell_new' || x.op === 'cell_get') && Number.isInteger(x.dst) && Number.isInteger(x.resultCount) && x.resultCount > 0) add(x.dst + x.resultCount - 1);
    for (const binding of x.upvalues ?? []) if (binding.kind === 0) add(binding.index);
  }
  return out;
}

export function maxRegisterIndex(program) {
  let max = -1;
  for (const r of referencedRegisters(program)) if (r > max) max = r;
  return max;
}
