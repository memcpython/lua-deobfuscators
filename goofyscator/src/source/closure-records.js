// Recover fresh table constructors whose fields are closures.
//
// Lua bytecode necessarily splits
//
//   { __call = function(...) ... end }
//
// into NEWTABLE, CLOSURE and SETTABLE operations.  Goofyfuscator builds also
// commonly insert a MOVE alias of the fresh table before each field write.
// Those aliases are allocation/call-frame staging, not source semantics.  This
// pass folds the sequence only while the table is still provably fresh and no
// closure captures either the constructor register or its transient alias.

const NOP = x => !x || x.op === 'nop';

function nextSemantic(xs, i) {
  for (let k = i + 1; k < xs.length; k++) if (!NOP(xs[k])) return k;
  return -1;
}

function emptySetList(x, table) {
  return x?.op === 'setlist' && x.table === table && !x.open && x.from > x.to;
}

function process(input) {
  const xs = (input ?? []).map(x => {
    const y = { ...x };
    for (const k of ['setup', 'body', 'thenBody', 'elseBody']) if (y[k]) y[k] = process(y[k]);
    return y;
  });

  for (let i = 0; i < xs.length; i++) {
    const nt = xs[i];
    if (nt?.op !== 'newtable') continue;

    const fields = [], consumed = [];
    let cursor = i;
    while (true) {
      let ci = nextSemantic(xs, cursor);
      if (ci < 0) break;

      // Some builds emit an empty SETLIST immediately after NEWTABLE.  It is
      // semantically empty and does not make the fresh table observable.
      if (emptySetList(xs[ci], nt.dst)) {
        consumed.push(ci);
        cursor = ci;
        continue;
      }

      // Accept the compiler/VM staging shape `alias = table; closure; alias[k]
      // = closure` as well as the direct `closure; table[k] = closure` form.
      let alias = nt.dst, aliasIndex = -1;
      const maybeAlias = xs[ci];
      if (maybeAlias?.op === 'move' && maybeAlias.secondDst == null &&
          maybeAlias.src?.kind === 'reg' && maybeAlias.src.index === nt.dst &&
          maybeAlias.dst !== nt.dst) {
        alias = maybeAlias.dst;
        aliasIndex = ci;
        ci = nextSemantic(xs, ci);
        if (ci < 0) break;
      }

      const closure = xs[ci];
      if (closure.op !== 'closure' || closure.prototype == null) break;
      // Inlining the constructor removes both the named table local and any
      // transient alias. A closure that captures either must keep split form.
      if ((closure.upvalues ?? []).some(b => b.kind === 0 && (b.index === nt.dst || b.index === alias))) break;

      const si = nextSemantic(xs, ci);
      if (si < 0) break;
      const set = xs[si];
      if (set.op !== 'settable' || set.table !== alias ||
          set.value?.kind !== 'reg' || set.value.index !== closure.dst ||
          set.key?.kind !== 'literal') break;

      fields.push({
        key: structuredClone(set.key),
        prototype: closure.prototype,
        upvalues: structuredClone(closure.upvalues ?? []),
        error: closure.error ?? null,
      });
      if (aliasIndex >= 0) consumed.push(aliasIndex);
      consumed.push(ci, si);
      cursor = si;
    }

    if (!fields.length) continue;

    // Empty SETLIST instructions can also trail the constructor sequence.
    let tail = nextSemantic(xs, cursor);
    while (tail >= 0 && emptySetList(xs[tail], nt.dst)) {
      consumed.push(tail);
      cursor = tail;
      tail = nextSemantic(xs, cursor);
    }

    xs[i] = {
      pc: nt.pc,
      sourcePc: nt.sourcePc,
      sub: nt.sub,
      op: 'table_closure_record',
      dst: nt.dst,
      fields,
      optimizedFrom: 'newtable-closure-fields',
    };
    for (const k of consumed) {
      const old = xs[k];
      xs[k] = { pc: old.pc, sourcePc: old.sourcePc, sub: old.sub, op: 'nop', optimizedAway: 'source-closure-record' };
    }
  }
  return xs;
}

export function recoverClosureRecordLiterals(program) {
  const p = structuredClone(program);
  p.instructions = process(p.instructions ?? []);
  return { program: p };
}
