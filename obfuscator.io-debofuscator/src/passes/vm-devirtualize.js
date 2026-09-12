const { parse, walk, sourceOf, propertyName } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');
const { executeBundle, invoke, decodePrograms, switchCaseCatalog } = require('../vm/runtime-inspector');
const { liftProgram } = require('../vm/bytecode-lifter');
const { synthesize, probeRows, holdoutRows } = require('../vm/synthesizer');

function unwrapIifeCallee(init) {
  if (!init || init.type !== 'CallExpression') return null;
  let callee = init.callee;
  if (callee?.type === 'SequenceExpression') callee = callee.expressions.at(-1);
  return callee && ['FunctionExpression', 'ArrowFunctionExpression'].includes(callee.type) ? callee : null;
}

function detectRunnerBinding(ast) {
  const candidates = [];
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.id?.type !== 'Identifier' || !unwrapIifeCallee(d.init)) continue;
      let switchCases = 0, switches = 0, loops = 0;
      walk(d.init, { enter({ node }) {
        if (node.type === 'SwitchStatement') switches++;
        else if (node.type === 'SwitchCase') switchCases++;
        else if (['WhileStatement', 'ForStatement', 'DoWhileStatement'].includes(node.type)) loops++;
      }});
      // The Pro executor is a large IIFE containing a dense dispatcher. This is
      // intentionally structural: prefixes such as vmg_* are not required.
      if (switchCases >= 20 && switches >= 1) {
        candidates.push({ name: d.id.name, switchCases, switches, loops, span: d.init.end - d.init.start });
      }
    }
  }
  candidates.sort((a, b) => b.switchCases - a.switchCases || b.span - a.span);
  return candidates[0] || null;
}

function sameMember(a, b) {
  if (a?.type !== 'MemberExpression' || b?.type !== 'MemberExpression') return false;
  const ao = a.object?.type === 'Identifier' ? a.object.name : null;
  const bo = b.object?.type === 'Identifier' ? b.object.name : null;
  return ao && ao === bo && propertyName(a) === propertyName(b);
}

function detectStateBinding(ast, runnerName) {
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.id?.type !== 'Identifier' || d.id.name === runnerName) continue;
      const init = d.init;
      if (init?.type !== 'LogicalExpression' || init.operator !== '||') continue;
      const left = init.left;
      let right = init.right;
      if (right?.type === 'SequenceExpression') right = right.expressions.at(-1);
      if (right?.type === 'AssignmentExpression' && sameMember(left, right.left) && right.right?.type === 'ObjectExpression') {
        return d.id.name;
      }
    }
  }

  // Fallback for variants that initialize the state object differently: choose
  // the top-level binding repeatedly used as the Object.defineProperty target.
  const score = new Map();
  walk(ast, { enter({ node }) {
    if (node.type !== 'CallExpression' || node.arguments.length < 2) return;
    const callee = node.callee;
    const prop = callee?.type === 'MemberExpression' ? propertyName(callee) : null;
    if (prop !== 'defineProperty') return;
    const target = node.arguments[0];
    if (target?.type === 'Identifier') score.set(target.name, (score.get(target.name) || 0) + 1);
  }});
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function vmWrappers(ast, runnerName) {
  const out = [];
  for (const st of ast.body) {
    if (st.type !== 'FunctionDeclaration' || !st.id || st.params.some(p => p.type !== 'Identifier')) continue;
    let callsRunner = false;
    walk(st.body, { enter({ node }) {
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === runnerName) callsRunner = true;
    }});
    if (callsRunner) out.push(st);
  }
  return out;
}

function argCode(arg) {
  if (arg && typeof arg === 'object' && arg.__symbolicExpression) return arg.__symbolicExpression;
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (typeof arg === 'number' && Number.isFinite(arg)) return String(arg);
  if (typeof arg === 'boolean') return String(arg);
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  return null;
}

function symbolicValue(expression, registry) {
  const target = {
    __symbolicExpression: expression,
    charAt(...args) { return symbolicValue(`${expression}.charAt(${args.map(argCode).join(', ')})`, registry); },
    charCodeAt(...args) { return symbolicValue(`${expression}.charCodeAt(${args.map(argCode).join(', ')})`, registry); },
    slice(...args) { return symbolicValue(`${expression}.slice(${args.map(argCode).join(', ')})`, registry); },
    substring(...args) { return symbolicValue(`${expression}.substring(${args.map(argCode).join(', ')})`, registry); },
    substr(...args) { return symbolicValue(`${expression}.substr(${args.map(argCode).join(', ')})`, registry); },
    toUpperCase() { return symbolicValue(`${expression}.toUpperCase()`, registry); },
    toLowerCase() { return symbolicValue(`${expression}.toLowerCase()`, registry); },
    trim() { return symbolicValue(`${expression}.trim()`, registry); },
    concat(...args) { return symbolicValue(`${expression}.concat(${args.map(argCode).join(', ')})`, registry); },
    toString() { return symbolicValue(`${expression}.toString()`, registry); },
    valueOf() { return this; },
    [Symbol.toPrimitive]() {
      const id = registry.length;
      registry.push(expression);
      return `__JSDOBF_SYM_${id}__`;
    }
  };
  return target;
}

function expressionFromSymbolicResult(value, registry) {
  if (value && typeof value === 'object' && value.__symbolicExpression) return value.__symbolicExpression;
  if (typeof value !== 'string') return null;
  const re = /__JSDOBF_SYM_(\d+)__/g;
  const parts = [];
  let last = 0, match;
  while ((match = re.exec(value))) {
    if (match.index > last) parts.push(JSON.stringify(value.slice(last, match.index)));
    const expr = registry[Number(match[1])];
    if (!expr) return null;
    parts.push(expr);
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  if (last < value.length) parts.push(JSON.stringify(value.slice(last)));
  return parts.length === 1 ? parts[0] : parts.join(' + ');
}

function compileCandidate(paramNames, expression) {
  try { return Function(...paramNames, `"use strict"; return (${expression});`); }
  catch (_) { return null; }
}

function valueSignature(v) {
  if (typeof v === 'number' && Number.isNaN(v)) return 'number:NaN';
  if (typeof v === 'number' && Object.is(v, -0)) return 'number:-0';
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') { try { return `json:${JSON.stringify(v)}`; } catch (_) {} }
  return `${typeof v}:${String(v)}`;
}

function verifyExpression(runtimeBox, name, params, expression) {
  const candidate = compileCandidate(params, expression);
  if (!candidate) return { ok: false, verifiedProbes: 0 };
  const rows = probeRows(params.length).concat(holdoutRows(params.length));
  let checked = 0;
  for (const args of rows) {
    let expected, actual, eErr = null, aErr = null;
    try { expected = invoke(runtimeBox, name, args, 500); } catch (e) { eErr = e?.name || 'Error'; }
    try { actual = candidate(...args); } catch (e) { aErr = e?.name || 'Error'; }
    if (eErr || aErr) {
      if (eErr !== aErr) return { ok: false, verifiedProbes: checked };
    } else if (valueSignature(expected) !== valueSignature(actual)) {
      return { ok: false, verifiedProbes: checked };
    }
    checked++;
  }
  return { ok: true, verifiedProbes: checked };
}

function recoverWrapperSymbolic(fnNode, runtimeBox) {
  const name = fnNode.id.name;
  const fn = runtimeBox.sandbox[name];
  if (typeof fn !== 'function') return null;
  const params = fnNode.params.map(p => p.name);
  const registry = [];
  const symbolicArgs = params.map(p => symbolicValue(p, registry));
  let symbolicResult;
  try { symbolicResult = fn(...symbolicArgs); } catch (_) { return null; }
  const expression = expressionFromSymbolicResult(symbolicResult, registry);
  if (!expression) return null;
  const verified = verifyExpression(runtimeBox, name, params, expression);
  if (!verified.ok) return null;
  return {
    name, params, expression,
    strategy: 'symbolic-boundary',
    verifiedProbes: verified.verifiedProbes,
    code: `function ${name}(${params.join(', ')}) {\n  return ${expression};\n}`
  };
}

function canonicalizeRecoveredParams(params, expression) {
  const replacements = new Map();
  params.forEach((name, i) => {
    if (/^_0x[0-9a-f]+$/i.test(name) || /^[A-Za-z_$]$/.test(name) || /^v\d+$/.test(name)) {
      replacements.set(name, `L_${i + 1}`);
    }
  });
  if (!replacements.size) return { params, expression };

  const wrapped = `(${expression})`;
  let ast;
  try { ast = parse(wrapped); } catch (_) { return { params, expression }; }
  const edits = [];
  walk(ast, { enter({ node, parent, key }) {
    if (node.type !== 'Identifier' || !replacements.has(node.name)) return;
    // Do not rename non-computed property keys such as obj.J or {J: value}.
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if (parent?.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return;
    edits.push({ start: node.start, end: node.end, text: replacements.get(node.name) });
  }});
  const rewritten = applyEdits(wrapped, edits).code;
  return {
    params: params.map(name => replacements.get(name) || name),
    expression: rewritten.slice(1, -1)
  };
}

function finalizedRecovery(result) {
  if (!result || result.failed) return result;
  const normalized = canonicalizeRecoveredParams(result.params, result.expression);
  return {
    ...result,
    params: normalized.params,
    expression: normalized.expression,
    code: `function ${result.name}(${normalized.params.join(', ')}) {\n  return ${normalized.expression};\n}`
  };
}

function recoverWrapperBytecode(fnNode, program, catalog, runtimeBox) {
  if (!program) return null;
  const name = fnNode.id.name;
  const params = fnNode.params.map(p => p.name);
  const lifted = liftProgram(program, params, catalog);
  if (!lifted.ok) return { failed: true, reason: lifted.reason, trace: lifted.trace || [] };
  const verified = verifyExpression(runtimeBox, name, params, lifted.expression);
  if (!verified.ok) return { failed: true, reason: 'lifted VM bytecode failed semantic verification', trace: lifted.trace || [] };
  return {
    name,
    params,
    expression: lifted.expression,
    strategy: 'bytecode-stack-lift',
    verifiedProbes: verified.verifiedProbes,
    bytecodeLength: lifted.bytecodeLength,
    instructionCount: lifted.trace.length,
    instructionConfidence: lifted.instructionConfidence,
    semanticCoverage: lifted.semanticCoverage,
    usedOpcodes: lifted.usedOpcodes,
    classifiedUsedOpcodes: lifted.classifiedUsedOpcodes,
    controlFlowRecovered: lifted.controlFlowRecovered,
    metadataLayout: lifted.metadataLayout,
    trace: lifted.trace,
    code: `function ${name}(${params.join(', ')}) {\n  return ${lifted.expression};\n}`
  };
}

function recoverWrapperSynthesis(fnNode, runtimeBox) {
  const name = fnNode.id.name;
  const params = fnNode.params.map(p => p.name);
  const r = synthesize(runtimeBox, name, params);
  if (!r.ok) return { failed: true, reason: r.reason };
  return {
    name,
    params,
    expression: r.expression,
    strategy: r.strategy,
    verifiedProbes: r.verifiedProbes,
    trainingProbes: r.trainingProbes,
    code: `function ${name}(${params.join(', ')}) {\n  return ${r.expression};\n}`
  };
}

function memberRootName(node) {
  let cur = node;
  while (cur?.type === 'MemberExpression') cur = cur.object;
  return cur?.type === 'Identifier' ? cur.name : null;
}

function memberProperty(node) {
  if (node?.type !== 'MemberExpression') return null;
  return node.computed ? propertyName(node.property) : node.property?.name || null;
}

function localNames(ast, stateName, runnerName) {
  const out = new Set();
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.id?.type !== 'Identifier') continue;
      if (d.id.name === stateName || d.id.name === runnerName || d.id.name === 'vmI') continue;
      out.add(d.id.name);
    }
  }
  return out;
}

function isVmPlumbingStatement(st, source, stateName, runnerName) {
  const text = sourceOf(st, source);
  if (st.type === 'VariableDeclaration') {
    return st.declarations.some(d => d.id?.type === 'Identifier' && (d.id.name === runnerName || d.id.name === stateName || d.id.name === 'vmI'));
  }
  if (st.type === 'TryStatement') return text.includes('defineProperty') && text.includes(stateName);
  if (st.type !== 'ExpressionStatement') return false;

  const e = st.expression;
  if (text.includes(runnerName)) return true;
  if (e.type === 'AssignmentExpression') {
    const root = memberRootName(e.left);
    return root === stateName || root === 'globalThis';
  }
  if (e.type === 'UnaryExpression' && e.operator === 'delete') return memberRootName(e.argument) === stateName || memberRootName(e.argument) === runnerName;
  if (e.type === 'SequenceExpression') {
    return e.expressions.every(x => {
      if (x.type === 'AssignmentExpression') {
        const root = memberRootName(x.left); return root === stateName || root === 'globalThis';
      }
      if (x.type === 'UnaryExpression' && x.operator === 'delete') {
        const root = memberRootName(x.argument); return root === stateName || root === runnerName;
      }
      return false;
    });
  }
  return false;
}

function rewriteStateReads(statementSource, st, stateName, locals) {
  const edits = [];
  walk(st, { enter({ node }) {
    if (node.type === 'ConditionalExpression') {
      const alt = node.alternate;
      if (alt?.type === 'MemberExpression' && memberRootName(alt) === stateName) {
        const prop = memberProperty(alt);
        if (prop && locals.has(prop)) {
          edits.push({ start: node.start - st.start, end: node.end - st.start, text: prop });
          return false;
        }
      }
    }
    if (node.type === 'MemberExpression' && memberRootName(node) === stateName) {
      const prop = memberProperty(node);
      if (prop && locals.has(prop)) edits.push({ start: node.start - st.start, end: node.end - st.start, text: prop });
    }
  }});
  return applyEdits(statementSource, selectOutermost(edits)).code;
}

function rebuildProgram(source, ast, stateName, runnerName, recovered) {
  const recoveredMap = new Map(recovered.map(r => [r.name, r]));
  const locals = localNames(ast, stateName, runnerName);
  for (const name of recoveredMap.keys()) locals.add(name);
  const chunks = [];
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && recoveredMap.has(st.id?.name)) {
      chunks.push(recoveredMap.get(st.id.name).code);
      continue;
    }
    if (isVmPlumbingStatement(st, source, stateName, runnerName)) continue;
    let text = sourceOf(st, source);
    text = rewriteStateReads(text, st, stateName, locals);
    chunks.push(text);
  }
  return chunks.join('\n');
}

function run(source, ast, ctx = {}) {
  const runnerInfo = detectRunnerBinding(ast);
  const runnerName = runnerInfo?.name || null;
  const stateName = runnerName ? detectStateBinding(ast, runnerName) : null;
  if (!stateName || !runnerName) return { code: source, changes: 0 };
  ctx.vmDetected = true;
  const wrappers = vmWrappers(ast, runnerName);
  if (!wrappers.length) {
    ctx.vmUnrecovered = true;
    return { code: source, changes: 0, details: { detected: true, recovered: [] } };
  }

  let box;
  try { box = executeBundle(source, ''); }
  catch (error) {
    ctx.vmUnrecovered = true;
    if (ctx.report) ctx.report.warn(`vm-devirtualize sandbox: ${error.message}`);
    return { code: source, changes: 0, details: { detected: true, recovered: [], error: error.message } };
  }

  const decoded = decodePrograms(source, ast, runnerName, wrappers);
  const catalog = switchCaseCatalog(ast, source);
  const recovered = [];
  const failures = [];

  for (const fn of wrappers) {
    let r = null;
    const program = decoded.programs?.get(fn.id.name);
    const lifted = recoverWrapperBytecode(fn, program, catalog, box);
    if (lifted && !lifted.failed) r = lifted;
    else if (lifted?.failed) failures.push({ name: fn.id.name, strategy: 'bytecode-stack-lift', reason: lifted.reason });

    if (!r) r = recoverWrapperSymbolic(fn, box);

    if (!r && ctx.options?.allowObservationalSynthesis === true) {
      const synthesized = recoverWrapperSynthesis(fn, box);
      if (synthesized && !synthesized.failed) r = synthesized;
      else if (synthesized?.failed) failures.push({ name: fn.id.name, strategy: 'observational-synthesis', reason: synthesized.reason });
    }
    if (r) recovered.push(finalizedRecovery(r));
  }

  if (recovered.length !== wrappers.length) {
    ctx.vmUnrecovered = true;
    if (ctx.report) ctx.report.warn(`vm-devirtualize recovered ${recovered.length}/${wrappers.length} VM wrapper(s); preserving VM runtime`);
    return {
      code: source,
      changes: 0,
      details: {
        detected: true,
        wrappers: wrappers.map(f => f.id.name),
        recovered: recovered.map(r => ({ name: r.name, strategy: r.strategy })),
        failures,
        decoderError: decoded.error || null
      }
    };
  }

  const code = rebuildProgram(source, ast, stateName, runnerName, recovered);
  ctx.vmUnrecovered = false;
  return {
    code,
    changes: 1 + recovered.length,
    details: {
      detected: true,
      state: stateName,
      runner: runnerName,
      runnerSwitchCases: runnerInfo?.switchCases,
      structuralDetection: true,
      decoderRecovered: !decoded.error,
      recovered: recovered.map(r => ({
        name: r.name,
        expression: r.expression,
        strategy: r.strategy,
        verifiedProbes: r.verifiedProbes,
        trainingProbes: r.trainingProbes,
        bytecodeLength: r.bytecodeLength,
        instructionCount: r.instructionCount,
        instructionConfidence: r.instructionConfidence,
        semanticCoverage: r.semanticCoverage,
        usedOpcodes: r.usedOpcodes,
        classifiedUsedOpcodes: r.classifiedUsedOpcodes,
        controlFlowRecovered: r.controlFlowRecovered,
        metadataLayout: r.metadataLayout
      })),
      failures
    }
  };
}

module.exports = { name: 'vm-devirtualize', run };
