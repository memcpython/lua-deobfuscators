const { invoke } = require('./runtime-inspector');

const THROW = Symbol('throw');

function cloneArg(x) {
  if (Array.isArray(x)) return x.map(cloneArg);
  if (x && typeof x === 'object') return { ...x };
  return x;
}

function stable(value) {
  if (value === THROW) return 'throw';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
  }
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try { return `json:${JSON.stringify(value)}`; } catch (_) { return `type:${typeof value}`; }
}

function equal(a, b) {
  return stable(a) === stable(b);
}

function probeRows(arity) {
  if (arity === 0) return [[]];
  const banks = [
    ['hello', 'world', 'test'],
    ['a', 'bc', 'XYZ'],
    ['', 'x', ''],
    ['Mixed Case', '123', 'end'],
    [0, 1, 2],
    [2, 3, 5],
    [-1, 4, -3],
    [10, -2, 7],
    [true, false, true],
    [[1, 2, 3], [4, 5], []],
    [['a', 'b'], ['x'], ['p', 'q', 'r']]
  ];
  return banks.map(row => Array.from({ length: arity }, (_, i) => cloneArg(row[i % row.length])));
}

function holdoutRows(arity) {
  if (arity === 0) return [[]];
  const banks = [
    ['alpha', 'Beta', '!'],
    ['racecar', 'xy', 'z'],
    [6, 7, 8],
    [-5, 2, 11],
    [[9, 8], [1, 1, 2], ['q']]
  ];
  return banks.map(row => Array.from({ length: arity }, (_, i) => cloneArg(row[i % row.length])));
}

function observeOriginal(box, name, rows) {
  const out = [];
  for (const args of rows) {
    const beforeLogs = box.logs.length;
    try {
      const value = invoke(box, name, args.map(cloneArg), 350);
      if (value && typeof value.then === 'function') return { async: true, values: [] };
      // Do not synthesize a pure expression for a function whose body visibly causes IO.
      if (box.logs.length !== beforeLogs) return { sideEffects: true, values: [] };
      out.push(value);
    } catch (_) { out.push(THROW); }
  }
  return { values: out };
}

function compile(params, code) {
  try { return Function(...params, `"use strict"; return (${code});`); }
  catch (_) { return null; }
}

function observeCandidate(fn, rows) {
  const out = [];
  for (const args of rows) {
    try { out.push(fn(...args.map(cloneArg))); } catch (_) { out.push(THROW); }
  }
  return out;
}

function vectorKey(values) { return values.map(stable).join('\u001f'); }
function matchesTarget(values, target) {
  if (values.length !== target.length) return false;
  for (let i = 0; i < values.length; i++) if (!equal(values[i], target[i])) return false;
  return true;
}

function candidate(params, code, rows, cost) {
  const fn = compile(params, code);
  if (!fn) return null;
  const values = observeCandidate(fn, rows);
  return { code, fn, values, key: vectorKey(values), cost };
}

function addCandidate(store, c, max = 6000) {
  if (!c || store.size >= max) return false;
  const old = store.get(c.key);
  if (!old || c.cost < old.cost || (c.cost === old.cost && c.code.length < old.code.length)) {
    store.set(c.key, c);
    return true;
  }
  return false;
}

function unaryForms(c) {
  const x = c.code;
  return [
    `!(${x})`, `~(${x})`, `+(${x})`, `-(${x})`,
    `String(${x})`, `Number(${x})`, `Boolean(${x})`,
    `Math.abs(${x})`, `Math.floor(${x})`, `Math.ceil(${x})`, `Math.round(${x})`, `Math.trunc(${x})`,
    `(${x}).length`,
    `(${x}).toUpperCase()`, `(${x}).toLowerCase()`, `(${x}).trim()`,
    `(${x}).charAt(0)`, `(${x}).charAt(1)`, `(${x}).charCodeAt(0)`,
    `(${x}).slice(1)`, `(${x}).slice(0, -1)`, `(${x}).substring(1)`,
    `(${x}).split("").reverse().join("")`
  ];
}

const BINARY = ['+', '-', '*', '/', '%', '**', '===', '!==', '<', '<=', '>', '>=', '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>'];

function synthesize(box, name, params, options = {}) {
  const rows = probeRows(params.length);
  const observed = observeOriginal(box, name, rows);
  if (observed.async) return { ok: false, reason: 'async VM wrapper requires async lifting' };
  if (observed.sideEffects) return { ok: false, reason: 'VM wrapper has observable side effects' };
  const target = observed.values;
  const successCount = target.filter(x => x !== THROW).length;
  if (successCount < Math.min(3, rows.length)) return { ok: false, reason: 'insufficient successful VM probes for synthesis' };

  const store = new Map();
  const seeds = [];
  for (const p of params) seeds.push(p);
  seeds.push('undefined', 'null', 'true', 'false', '0', '1', '-1', '2', '""', '" "');
  for (const code of seeds) {
    const c = candidate(params, code, rows, 1); addCandidate(store, c);
    if (c && matchesTarget(c.values, target)) return verify(box, name, params, c, options);
  }

  let frontier = [...store.values()];
  for (let round = 0; round < 3; round++) {
    const next = [];
    const unaryBase = frontier.slice(0, 500);
    for (const base of unaryBase) {
      for (const code of unaryForms(base)) {
        const c = candidate(params, code, rows, base.cost + 1);
        if (addCandidate(store, c)) next.push(c);
        if (c && matchesTarget(c.values, target)) return verify(box, name, params, c, options);
      }
    }

    // Use a bounded observational superoptimizer: combine the shortest/most diverse
    // representatives rather than exploding all textual expressions.
    const pool = [...store.values()].sort((a, b) => a.cost - b.cost || a.code.length - b.code.length).slice(0, round === 0 ? 140 : 220);
    const leftPool = round === 0 ? pool.slice(0, 100) : frontier.slice(0, 220);
    for (const a of leftPool) {
      for (const b of pool) {
        if (a.cost + b.cost > 8) continue;
        for (const op of BINARY) {
          const code = `((${a.code}) ${op} (${b.code}))`;
          const c = candidate(params, code, rows, a.cost + b.cost + 1);
          if (addCandidate(store, c)) next.push(c);
          if (c && matchesTarget(c.values, target)) return verify(box, name, params, c, options);
        }
      }
    }
    frontier = next.sort((a, b) => a.cost - b.cost || a.code.length - b.code.length).slice(0, 600);
    if (!frontier.length) break;
  }

  // Target-driven conditional synthesis. This recovers many VM functions with
  // branches without needing to guess the VM jump encoding: find a boolean predicate
  // whose true/false partitions can each be explained by an existing expression.
  const all = [...store.values()].sort((a, b) => a.cost - b.cost || a.code.length - b.code.length).slice(0, 3500);
  const bools = all.filter(c => c.values.some(v => v === true) && c.values.some(v => v === false));
  for (const cond of bools.slice(0, 500)) {
    const ti = [], fi = [];
    for (let i = 0; i < cond.values.length; i++) {
      if (cond.values[i] === true) ti.push(i);
      else if (cond.values[i] === false) fi.push(i);
    }
    if (!ti.length || !fi.length) continue;
    let yes = null, no = null;
    for (const c of all) {
      if (!yes && ti.every(i => equal(c.values[i], target[i]))) yes = c;
      if (!no && fi.every(i => equal(c.values[i], target[i]))) no = c;
      if (yes && no) break;
    }
    if (!yes || !no) continue;
    const c = candidate(params, `((${cond.code}) ? (${yes.code}) : (${no.code}))`, rows, cond.cost + yes.cost + no.cost + 1);
    if (c && matchesTarget(c.values, target)) return verify(box, name, params, c, options);
  }

  return { ok: false, reason: `expression synthesis exhausted ${store.size} observational states` };
}

function verify(box, name, params, c, options = {}) {
  const rows = holdoutRows(params.length);
  const target = observeOriginal(box, name, rows);
  if (target.async || target.sideEffects) return { ok: false, reason: 'holdout probe became non-pure' };
  const actual = observeCandidate(c.fn, rows);
  if (!matchesTarget(actual, target.values)) return { ok: false, reason: 'synthesized candidate failed holdout probes' };
  return {
    ok: true,
    expression: c.code,
    code: `return ${c.code};`,
    strategy: 'observational-synthesis',
    trainingProbes: probeRows(params.length).length,
    verifiedProbes: rows.length,
    cost: c.cost
  };
}

module.exports = { synthesize, probeRows, holdoutRows, stable };
