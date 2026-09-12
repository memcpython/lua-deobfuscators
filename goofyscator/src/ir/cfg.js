const TERMINAL = new Set(['return', 'tailcall', 'return_literal', 'return_cell']);
export function buildCfg(program) {
  const ins = program.instructions;
  const pcs = new Set(ins.map(x => x.pc));
  const next = new Map();
  for (let i = 0; i < ins.length - 1; i++) next.set(ins[i].pc, ins[i + 1].pc);
  const nodes = ins.map(x => {
    let successors = [];
    if (x.op === 'jump') successors = [x.target];
    else if (['branch_false','forprep','forloop','tforloop'].includes(x.op)) successors = [next.get(x.pc), x.target].filter(v => v != null);
    else if (!TERMINAL.has(x.op)) successors = [next.get(x.pc)].filter(v => v != null);
    return { pc: x.pc, op: x.op, successors: [...new Set(successors)].filter(p => pcs.has(p)) };
  });
  return { entry: ins[0]?.pc ?? null, nodes };
}
