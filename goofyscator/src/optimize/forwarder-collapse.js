function live(program) {
  return (program?.instructions ?? []).filter(x => x.op !== 'nop' && x.op !== 'vm_internal');
}

function literalAssignedBefore(instructions, index, register) {
  for (let i = index - 1; i >= 0; i--) {
    const x = instructions[i];
    if (x.dst !== register) continue;
    return x.op === 'move' && x.src?.kind === 'literal' ? x.src.value : undefined;
  }
  return undefined;
}

function recognizeForwarderChild(program) {
  if (!program || program.paramCount !== 0) return null;
  const ins = live(program);
  const up = ins.find(x => x.op === 'getupval');
  if (!up) return null;
  const read = ins.find(x => x.op === 'gettable' && x.dst === up.dst && x.table === up.dst && x.key?.kind === 'literal' && typeof x.key.value === 'number');
  const vararg = ins.find(x => x.op === 'vararg' && x.count < 0);
  const tail = ins.find(x => x.op === 'tailcall' && x.base === up.dst && x.argCount < 0);
  if (!read || !vararg || !tail) return null;
  // The child must be nothing more than load-captured-function, load varargs,
  // and tailcall. Extra executable behavior would make the factory non-identity.
  const allowed = new Set(['getupval','gettable','vararg','tailcall','close','return']);
  if (ins.some(x => !allowed.has(x.op))) return null;
  return { upvalueSlot: up.slot, storageKey: read.key.value };
}

function recognizeForwarderFactory(program, byId) {
  if (!program || program.paramCount !== 1) return null;
  const ins = live(program);
  const table = ins.find(x => x.op === 'newtable');
  if (!table) return null;
  const storeIndex = ins.findIndex(x => x.op === 'settable' && x.table === table.dst && x.value?.kind === 'reg' && x.value.index === 0);
  const closure = ins.find(x => x.op === 'closure' && x.prototype != null);
  const ret = ins.find(x => x.op === 'return' && x.hasValues && x.count === 1 && closure && x.base === closure.dst);
  if (storeIndex < 0 || !closure || !ret) return null;

  const child = recognizeForwarderChild(byId.get(closure.prototype));
  if (!child) return null;
  const store = ins[storeIndex];
  const storageKey = store.key?.kind === 'literal'
    ? store.key.value
    : store.key?.kind === 'reg'
      ? literalAssignedBefore(ins, storeIndex, store.key.index)
      : undefined;
  if (storageKey !== child.storageKey) return null;
  const binding = (closure.upvalues ?? []).find(x => x.kind === 0 && x.index === table.dst && x.slot === child.upvalueSlot);
  if (!binding) return null;

  const allowed = new Set(['newtable','move','settable','setlist','closure','return','close']);
  if (ins.some(x => !allowed.has(x.op))) return null;
  return { childPrototype: closure.prototype, storageKey };
}

function writtenRegisters(x) {
  const out = new Set();
  if (Number.isInteger(x.dst)) out.add(x.dst);
  if (Number.isInteger(x.secondDst)) out.add(x.secondDst);
  if (x.op === 'call' && x.resultCount !== 0) {
    if (x.resultCount > 0) for (let r=x.base;r<x.base+x.resultCount;r++) out.add(r);
    else out.add(x.base);
  }
  if (x.op === 'vararg') out.add(x.base);
  return out;
}

/** Collapse Goofyfuscator's identity vararg-forwarder factories. */
export function collapseIdentityForwarders(bundle) {
  const byId = new Map(bundle.programs.map(p => [p.id,p]));
  const factories = new Map();
  for (const program of bundle.programs) {
    const info = recognizeForwarderFactory(program, byId);
    if (info) factories.set(program.id, info);
  }
  if (!factories.size) return { factories: 0, calls: 0 };

  let calls = 0;
  for (const program of bundle.programs) {
    const ins = program.instructions;
    for (let i=0;i<ins.length;i++) {
      const create = ins[i];
      if (create.op !== 'closure' || !factories.has(create.prototype)) continue;
      const factoryRegister = create.dst;
      for (let j=i+1;j<ins.length;j++) {
        const x = ins[j];
        if (x.op === 'nop' || x.op === 'vm_internal') continue;
        if (x.op === 'call' && x.base === factoryRegister && x.argCount === 1 && x.resultCount === 1) {
          ins[j] = {
            pc: x.pc, sourcePc: x.sourcePc, sub: x.sub,
            op: 'move', dst: factoryRegister, src: { kind: 'reg', index: factoryRegister + 1 },
            optimizedFrom: 'identity-forwarder',
          };
          calls++;
          break;
        }
        if (writtenRegisters(x).has(factoryRegister)) break;
      }
    }
  }
  return { factories: factories.size, calls, prototypeIds: [...factories.keys()] };
}
