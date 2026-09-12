// Conservative source-preparation DCE for pure MOVE staging.
//
// Record/table recovery can replace a SETTABLE read with an AST value that no
// longer references the temporary register which fed it.  At that point a
// compiler/VM staging move may be immediately overwritten and should not become
// a fake lexical local in reconstructed Lua.  This pass only removes a MOVE
// when straight-line data flow proves its destination is overwritten before
// any read. It never crosses an unresolved control-flow boundary.

function valueReads(v, r) {
  if (!v || typeof v !== 'object') return false;
  if (v.kind === 'reg') return v.index === r;
  for (const k of ['table','key','value','left','right','fn','cell']) if (valueReads(v[k], r)) return true;
  for (const k of ['entries','args','values']) for (const e of v[k] ?? []) if (valueReads(e, r)) return true;
  return false;
}

function reads(x, r) {
  if (!x) return false;
  for (const k of ['src','left','right','value','key','condition','fn']) if (valueReads(x[k], r)) return true;
  for (const k of ['entries','values','args']) for (const v of x[k] ?? []) if (valueReads(v, r)) return true;
  if ((x.upvalues ?? []).some(b => b.kind === 0 && b.index === r)) return true;
  switch (x.op) {
    case 'move_pair': return x.secondSrc === r;
    case 'gettable': return x.table === r;
    case 'settable': return x.table === r || (typeof x.src === 'number' && x.src === r);
    case 'setglobal': return x.src === r;
    case 'self': return x.dst === r;
    case 'setlist': return x.table === r || (r >= x.from && r <= x.to);
    case 'call': case 'tailcall':
      return x.base === r || (x.argCount >= 0 && r > x.base && r <= x.base + x.argCount);
    case 'return': return x.hasValues && (x.open ? r >= x.base : r >= x.base && r < x.base + x.count);
    case 'identity_results': case 'cell_results':
      return r >= x.sourceBase && r < x.sourceBase + (x.count ?? 0);
    case 'cell_get': case 'cell_set': case 'return_cell': return x.cell === r;
    case 'forprep': case 'forloop': return x.index === r || x.limit === r || x.step === r;
    case 'tforloop': return x.base === r || x.base + 1 === r || x.control === r;
    default: return false;
  }
}

function writes(x, r) {
  if (!x) return false;
  if (x.dst === r || x.secondDst === r) return true;
  if (x.op === 'self' && x.dst + 1 === r) return true;
  switch (x.op) {
    case 'clear_range': return r >= x.from && r <= x.to;
    case 'call': case 'identity_results': case 'cell_results': case 'constant_call':
      return x.resultCount > 0 && r >= x.base && r < x.base + x.resultCount;
    case 'cell_new': case 'cell_get':
      return r >= x.dst && r < x.dst + Math.max(1, x.resultCount ?? 1);
    case 'vararg': return x.count > 0 && r >= x.base && r < x.base + x.count;
    case 'forloop': return x.index === r;
    case 'tforloop': return r === x.control || (r >= x.resultBase && r < x.resultBase + x.resultCount);
    default: return false;
  }
}

function barrier(x) {
  return ['jump','branch_false','forprep','forloop','tforloop','return','tailcall'].includes(x?.op);
}

function process(input) {
  const xs = (input ?? []).map(x => {
    const y = { ...x };
    for (const k of ['setup','body','thenBody','elseBody']) if (y[k]) y[k] = process(y[k]);
    if (y.branches) y.branches = y.branches.map(b => ({ ...b, body: process(b.body ?? []) }));
    return y;
  });

  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x?.op !== 'move' || !Number.isInteger(x.dst) || !['reg','literal'].includes(x.src?.kind)) continue;
    // A lifetime annotation explicitly represents source semantics; never DCE
    // it here even if the current local slice happens to look dead.
    if ((x.sourceRedeclare ?? []).includes(x.dst)) continue;
    const r = x.dst;
    let dead = true;
    for (let j = i + 1; j < xs.length; j++) {
      const y = xs[j];
      if (!y || y.op === 'nop') continue;
      if (reads(y, r)) { dead = false; break; }
      if (writes(y, r)) break; // overwritten before any read => dead
      if (barrier(y)) { dead = false; break; }
    }
    if (dead) xs[i] = { pc:x.pc, sourcePc:x.sourcePc, sub:x.sub, op:'nop', optimizedAway:'source-dead-move' };
  }
  return xs;
}

export function pruneDeadSourceMoves(program) {
  const p = structuredClone(program);
  p.instructions = process(p.instructions ?? []);
  return { program:p };
}
