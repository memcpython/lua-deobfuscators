import { buildCfg } from '../ir/cfg.js';

function literalStrings(program) {
  const out = new Set();
  for (const ins of program?.instructions ?? []) {
    for (const v of Object.values(ins)) {
      if (v?.kind === 'literal' && typeof v.value === 'string') out.add(v.value);
    }
  }
  return out;
}

function containsAll(set, values) {
  return values.every(v => set.has(v));
}

function findPrototypeByFingerprint(programs, required, excludeId = null) {
  const matches = [];
  for (const p of programs) {
    if (p.id === excludeId) continue;
    const strings = literalStrings(p);
    if (containsAll(strings, required)) matches.push(p.id);
  }
  return matches;
}

function nextMeaningful(instructions, start) {
  for (let i = start; i < instructions.length; i++) {
    if (instructions[i].op !== 'nop' && instructions[i].op !== 'vm_internal') return i;
  }
  return -1;
}

function findClosureCall(root, prototypeId) {
  for (let i = 0; i < root.instructions.length; i++) {
    const c = root.instructions[i];
    if (c.op !== 'closure' || c.prototype !== prototypeId) continue;
    const j = nextMeaningful(root.instructions, i + 1);
    if (j < 0) continue;
    const call = root.instructions[j];
    if (call.op === 'call' && call.base === c.dst) return { closureIndex: i, callIndex: j };
  }
  return null;
}

function findGuardTail(root, guardPrototypeId) {
  const ins = root.instructions;
  for (let i = ins.length - 1; i >= 0; i--) {
    const c = ins[i];
    if (c.op !== 'closure' || c.prototype !== guardPrototypeId) continue;

    // The final anti-tamper probe is passed to pcall and returns (ok, result).
    let callIndex = -1;
    for (let j = i + 1; j < Math.min(ins.length, i + 8); j++) {
      const x = ins[j];
      if (x.op === 'call' && x.resultCount === 2 && x.argCount >= 1) {
        callIndex = j;
        break;
      }
    }
    if (callIndex < 0) continue;

    // Both failure paths converge after a final zero-result crash call.  Do not
    // depend on the randomized register that holds the crash routine.
    let lastCrash = -1;
    let branches = 0;
    for (let j = callIndex + 1; j < Math.min(ins.length, callIndex + 14); j++) {
      const x = ins[j];
      if (x.op === 'branch_false') branches++;
      if (x.op === 'call' && x.argCount === 0 && x.resultCount === 0) lastCrash = j;
    }
    if (branches >= 1 && lastCrash >= 0) return { closureIndex: i, callIndex, crashIndex: lastCrash };
  }
  return null;
}

function nopRange(program, fromIndex, throughIndex, reason) {
  let count = 0;
  for (let i = fromIndex; i <= throughIndex; i++) {
    const x = program.instructions[i];
    if (!x || x.op === 'nop') continue;
    program.instructions[i] = {
      pc: x.pc,
      sourcePc: x.sourcePc,
      sub: x.sub,
      op: 'nop',
      optimizedAway: reason,
    };
    count++;
  }
  program.cfg = buildCfg(program);
  return count;
}

/**
 * Remove the V10 anti-tamper envelope that Goofyfuscator prepends to the real
 * program.  Detection is semantic: the initializer helper and the final Roblox
 * material/parent probe are found through their child-prototype behavior, never
 * through PCs, register numbers, randomized object keys or handler IDs.
 *
 * We intentionally preserve the environment-proxy/helper initializer.  The
 * protected payload may still reference those helpers until later simplification
 * passes prove that the wrappers can be eliminated.
 */
export function stripV10Protection(bundle) {
  const root = bundle.programs.find(p => p.id === (bundle.root ?? 0)) ?? bundle.programs.find(p => p.id === 0);
  if (!root) return { stripped: false, instructions: 0, reason: 'missing-root' };

  const helperIds = findPrototypeByFingerprint(bundle.programs, ['rawget', 'setmetatable', 'string', 'table'], root.id);
  const guardIds = findPrototypeByFingerprint(bundle.programs, ['Material', 'Plastic', 'Parent'], root.id);
  if (helperIds.length !== 1 || guardIds.length !== 1) {
    return {
      stripped: false,
      instructions: 0,
      reason: 'fingerprint-ambiguous',
      helperMatches: helperIds,
      guardMatches: guardIds,
    };
  }

  const helper = findClosureCall(root, helperIds[0]);
  const guard = findGuardTail(root, guardIds[0]);
  if (!helper || !guard || helper.callIndex >= guard.crashIndex) {
    return {
      stripped: false,
      instructions: 0,
      reason: 'envelope-shape-mismatch',
      helperPrototype: helperIds[0],
      guardPrototype: guardIds[0],
    };
  }

  const firstRemoved = helper.callIndex + 1;
  const removed = nopRange(root, firstRemoved, guard.crashIndex, 'goofy-v10-protection');
  return {
    stripped: true,
    instructions: removed,
    helperPrototype: helperIds[0],
    guardPrototype: guardIds[0],
    fromPc: root.instructions[firstRemoved]?.pc ?? null,
    throughPc: root.instructions[guard.crashIndex]?.pc ?? null,
    userEntryPc: root.instructions[guard.crashIndex + 1]?.pc ?? null,
  };
}
