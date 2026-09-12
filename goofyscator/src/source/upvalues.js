// Source-level closure binding cleanup.
//
// Goofyfuscator emits full capture descriptors even when a recovered child
// prototype never reads some of those upvalue slots. Treating every descriptor
// as a semantic register use keeps dead bootstrap/decoder values alive and
// leaks closure-ABI noise into source. Compute the slots that are actually
// observed by each prototype, including transitive forwarding into nested
// closures, then erase unused bindings on a source-only clone.

function walk(xs, fn) {
  for (const x of xs ?? []) {
    fn(x);
    for (const k of ['setup', 'body', 'thenBody', 'elseBody']) if (x[k]) walk(x[k], fn);
  }
}

export function pruneUnusedUpvalueBindings(bundle) {
  const out = structuredClone(bundle);
  const byId = new Map(out.programs.map(p => [p.id, p]));
  const used = new Map(out.programs.map(p => [p.id, new Set()]));

  // Direct reads in a prototype.
  for (const p of out.programs) {
    walk(p.instructions, x => {
      if (x.op === 'getupval' && Number.isFinite(x.slot)) used.get(p.id).add(x.slot);
      if (x.op === 'source_table_mutation' && Number.isFinite(x.slot)) used.get(p.id).add(x.slot);
      // Some later source transforms can represent an upvalue directly in an
      // expression tree. Keep this visitor narrow but recursive enough for
      // those source-only nodes.
      const scanAst = a => {
        if (!a || typeof a !== 'object') return;
        if (a.kind === 'upvalue_ref' && Number.isFinite(a.slot)) used.get(p.id).add(a.slot);
        for (const k of ['table', 'key', 'value', 'left', 'right', 'fn', 'cell']) scanAst(a[k]);
        for (const k of ['entries', 'args', 'values']) for (const v of a[k] ?? []) scanAst(v);
      };
      for (const k of ['src', 'left', 'right', 'value', 'key', 'condition']) scanAst(x[k]);
      for (const k of ['entries', 'values']) for (const v of x[k] ?? []) scanAst(v);
    });
  }

  // If child slot S is live and its binding comes from a parent upvalue, the
  // corresponding parent slot is live too. Iterate to a fixed point because
  // forwarding can cross several lexical levels.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of out.programs) {
      walk(p.instructions, x => {
        if (x.op !== 'closure' || x.prototype == null) return;
        const childUsed = used.get(x.prototype);
        if (!childUsed) return;
        for (const b of x.upvalues ?? []) {
          if (!childUsed.has(b.slot) || b.kind !== 1 || !Number.isFinite(b.index)) continue;
          const parentUsed = used.get(p.id);
          if (!parentUsed.has(b.index)) { parentUsed.add(b.index); changed = true; }
        }
      });
    }
  }

  let removed = 0;
  for (const p of out.programs) {
    walk(p.instructions, x => {
      if (x.op !== 'closure' || x.prototype == null) return;
      const childUsed = used.get(x.prototype) ?? new Set();
      const before = x.upvalues ?? [];
      x.upvalues = before.filter(b => childUsed.has(b.slot));
      removed += before.length - x.upvalues.length;
    });
  }

  return { bundle: out, removed, usedSlots: used };
}
