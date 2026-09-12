import { LiftContext } from './context.js';
import { OPCODES } from '../opcodes/index.js';
import { buildCfg } from '../ir/cfg.js';

export function liftProgram(program, discovery) {
  const ctx = new LiftContext(discovery);
  const instructions = program.instructions.map(ins => {
    const lift = OPCODES[ins.semantic];
    if (!lift) throw new Error(`No opcode lifter for ${ins.semantic} at pc ${ins.pc}`);
    return lift(ins, ctx);
  });
  const out = { id: program.id, paramCount: program.paramCount ?? 0, instructionCount: program.instructionCount, instructions };
  out.cfg = buildCfg(out);
  return out;
}
export function liftBundle(probe, discovery) {
  return { version: probe.version, root: probe.root, programs: probe.programs.map(p => liftProgram(p, discovery)) };
}
