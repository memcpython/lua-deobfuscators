// Fold structured value-selection guards back into Lua short-circuit values.
//
// A common compiler lowering for
//
//   a and b or fallback()
//
// is
//
//   r = a and b
//   if not r then r = fallback() end
//
// Once CFG recovery has proven the IF region, the latter is source noise.  We
// only fold when the branch writes the condition register exclusively through
// a pure expression chain.  Calls are allowed as expression nodes because Lua
// `or` preserves their conditional execution.

const R = index => ({ kind: 'reg', index });
const L = value => ({ kind: 'literal', value });
const clone = v => v == null ? v : structuredClone(v);

function value(v, state) {
  if (v?.kind === 'literal') return L(v.value);
  if (v?.kind === 'reg') return clone(state.get(v.index) ?? R(v.index));
  if (v?.kind) return ast(v, state);
  return L(null);
}

function ast(a, state) {
  if (!a) return L(null);
  if (a.kind === 'literal') return L(a.value);
  if (a.kind === 'reg') return clone(state.get(a.index) ?? R(a.index));
  if (a.kind === 'global') return { kind: 'global', key: ast(a.key, state) };
  if (a.kind === 'index') return { kind: 'index', table: ast(a.table, state), key: ast(a.key, state) };
  if (a.kind === 'unary') return { kind: 'unary', operator: a.operator, value: ast(a.value, state) };
  if (a.kind === 'binary') return { kind: 'binary', operator: a.operator, left: ast(a.left, state), right: ast(a.right, state) };
  if (a.kind === 'logical') return { kind: 'logical', operator: a.operator, values: (a.values ?? []).map(v => ast(v, state)) };
  if (a.kind === 'table') return { kind: 'table', entries: (a.entries ?? []).map(v => ast(v, state)) };
  if (a.kind === 'call') return { kind: 'call', fn: ast(a.fn, state), args: (a.args ?? []).map(v => ast(v, state)) };
  if (a.kind === 'upvalue_ref') return clone(a);
  if (a.kind === 'cell_read') return { kind: 'cell_read', cell: ast(a.cell, state) };
  return L(null);
}

function summarizeBranch(body, target) {
  const state = new Map([[target, R(target)]]);
  for (const x of body ?? []) {
    if (!x || x.op === 'nop' || x.op === 'source_label') continue;
    switch (x.op) {
      case 'move':
        if (x.dst !== target) return null;
        state.set(target, value(x.src, state));
        break;
      case 'unary':
        if (x.dst !== target) return null;
        state.set(target, { kind: 'unary', operator: x.operator, value: value(x.value, state) });
        break;
      case 'binary':
        if (x.dst !== target) return null;
        state.set(target, { kind: 'binary', operator: x.operator, left: value(x.left, state), right: value(x.right, state) });
        break;
      case 'logical_chain':
        if (x.dst !== target) return null;
        state.set(target, { kind: 'logical', operator: x.operator, values: (x.values ?? []).map(v => ast(v, state)) });
        break;
      case 'source_call':
        if (x.resultCount !== 1 || x.base !== target) return null;
        state.set(target, { kind: 'call', fn: ast(x.fn, state), args: (x.args ?? []).map(v => ast(v, state)) });
        break;
      case 'constant_call':
        if (x.resultCount !== 1 || x.base !== target) return null;
        state.set(target, value(x.value, state));
        break;
      default:
        return null;
    }
  }
  const out = state.get(target);
  return out && !(out.kind === 'reg' && out.index === target) ? out : null;
}

function process(input) {
  const xs = (input ?? []).map(x => {
    const y = { ...x };
    for (const k of ['setup', 'body', 'thenBody', 'elseBody']) if (y[k]) y[k] = process(y[k]);
    return y;
  });
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const seed = xs[i], guard = xs[i + 1];
    if (seed?.op === 'logical_chain' && guard?.op === 'if' && guard.condition?.kind === 'reg' && guard.condition.index === seed.dst) {
      const r = seed.dst;
      // `if r then <nothing> else r=fallback end` => `r or fallback`.
      if (!(guard.thenBody?.length) && guard.elseBody?.length) {
        const fallback = summarizeBranch(guard.elseBody, r);
        if (fallback) {
          const left = { kind: 'logical', operator: seed.operator, values: clone(seed.values ?? []) };
          out.push({ pc: seed.pc, sourcePc: seed.sourcePc, sub: seed.sub, op: 'logical_chain', dst: r, operator: 'or', values: [left, fallback], optimizedFrom: 'structured-conditional-value' });
          i++;
          continue;
        }
      }
      // `if r then r=next else <nothing> end` => `r and next`.
      if (guard.thenBody?.length && !(guard.elseBody?.length)) {
        const next = summarizeBranch(guard.thenBody, r);
        if (next) {
          const left = { kind: 'logical', operator: seed.operator, values: clone(seed.values ?? []) };
          out.push({ pc: seed.pc, sourcePc: seed.sourcePc, sub: seed.sub, op: 'logical_chain', dst: r, operator: 'and', values: [left, next], optimizedFrom: 'structured-conditional-value' });
          i++;
          continue;
        }
      }
    }
    out.push(seed);
  }
  return out;
}

export function collapseConditionalValues(program) {
  const p = structuredClone(program);
  p.instructions = process(p.instructions ?? []);
  return { program: p };
}
