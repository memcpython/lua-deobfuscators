const REQUIRED_CORE = ['string','byte','char','table','concat','math','floor'];
const ALLOWED_GLOBALS = new Set(['string','table','math','bit32']);

function literalValues(program) {
  const strings = new Set(), numbers = new Set();
  const visit = value => {
    if (value?.kind !== 'literal') return;
    if (typeof value.value === 'string') strings.add(value.value);
    else if (typeof value.value === 'number') numbers.add(value.value);
  };
  for (const ins of program.instructions) for (const key of ['src','key','value','left','right','condition']) visit(ins[key]);
  return { strings, numbers };
}

/**
 * Identify Goofyfuscator's pure three-argument string decoder by behaviorally
 * relevant structure.  V10 polymorphic builds observed in the corpus range from
 * ~97 to ~143 lifted instructions and may inline/split arithmetic differently,
 * so numeric magic constants are intentionally not part of the identity.
 */
export function isV10StringDecoder(program) {
  if (program.paramCount !== 3 || program.instructions.length < 80 || program.instructions.length > 170) return false;
  const { strings, numbers } = literalValues(program);
  if (!REQUIRED_CORE.every(name => strings.has(name))) return false;
  if (!numbers.has(256) || !numbers.has(65536)) return false;

  const globals = new Set();
  let loops = 0, calls = 0, tableWrites = 0;
  for (const ins of program.instructions) {
    if (ins.op === 'getglobal' && ins.key?.kind === 'literal' && typeof ins.key.value === 'string') globals.add(ins.key.value);
    if (ins.op === 'forprep' || ins.op === 'forloop') loops++;
    if (ins.op === 'call' || ins.op === 'tailcall') calls++;
    if (ins.op === 'settable' || ins.op === 'setlist') tableWrites++;
  }
  for (const name of globals) if (!ALLOWED_GLOBALS.has(name)) return false;
  return loops >= 2 && calls >= 6 && tableWrites >= 2;
}
