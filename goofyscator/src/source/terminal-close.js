// Drop CLOSE instructions that occur only at function exit.
//
// Lua closes every still-open upvalue automatically when a function returns.
// Once the source emitter has reconstructed lexical closures, a trailing VM
// CLOSE therefore carries no additional source-level behavior.  We only remove
// CLOSEs from the terminal suffix of the *function body*; CLOSEs inside control
// flow or before subsequent semantic instructions remain intact and keep the
// program on the compatibility path.
export function dropTerminalCloses(program) {
  const p = structuredClone(program);
  const xs = p.instructions ?? [];
  let i = xs.length - 1;
  while (i >= 0 && xs[i]?.op === 'nop') i--;
  let changed = 0;
  while (i >= 0 && xs[i]?.op === 'close') {
    const x = xs[i];
    xs[i] = { pc: x.pc, sourcePc: x.sourcePc, sub: x.sub, op: 'nop', optimizedAway: 'source-terminal-close' };
    changed++;
    i--;
    while (i >= 0 && xs[i]?.op === 'nop') i--;
  }
  return { program: p, changed };
}
