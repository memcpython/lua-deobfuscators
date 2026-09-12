const vm = require('vm');
const { walk, sourceOf } = require('../core/ast');

function makeSandbox(promptValue = '') {
  const logs = [];
  const sandbox = {
    prompt(message) { logs.push({ type: 'prompt', args: [message] }); return promptValue; },
    alert(...args) { logs.push({ type: 'alert', args }); },
    console: {
      log(...args) { logs.push({ type: 'log', args }); },
      warn(...args) { logs.push({ type: 'warn', args }); },
      error(...args) { logs.push({ type: 'error', args }); },
      info(...args) { logs.push({ type: 'info', args }); },
      debug(...args) { logs.push({ type: 'debug', args }); },
      trace(...args) { logs.push({ type: 'trace', args }); }
    },
    setInterval() { return 0; }, clearInterval() {},
    setTimeout() { return 0; }, clearTimeout() {}
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  const context = vm.createContext(sandbox, {
    name: 'obfuscator-io-vm-probe',
    codeGeneration: { strings: false, wasm: false }
  });
  return { sandbox, context, logs };
}

function executeBundle(source, promptValue = '', timeout = 4000) {
  const box = makeSandbox(promptValue);
  vm.runInContext(source, box.context, { timeout });
  return box;
}

function invoke(box, functionName, args, timeout = 500) {
  box.sandbox.__deobfProbeArgs = args;
  try {
    return vm.runInContext(`${functionName}(...__deobfProbeArgs)`, box.context, { timeout });
  } finally {
    delete box.sandbox.__deobfProbeArgs;
  }
}

function topLevelRunnerDeclarator(ast, runnerName) {
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) if (d.id?.type === 'Identifier' && d.id.name === runnerName) return d;
  }
  return null;
}

function findRunnerIife(ast, runnerName) {
  const d = topLevelRunnerDeclarator(ast, runnerName);
  if (!d?.init || d.init.type !== 'CallExpression') return null;
  let fn = d.init.callee;
  if (fn?.type === 'SequenceExpression') fn = fn.expressions.at(-1);
  if (!fn || !['FunctionExpression', 'ArrowFunctionExpression'].includes(fn.type)) return null;
  return fn;
}

function findDecoderInjection(ast, runnerName) {
  const iife = findRunnerIife(ast, runnerName);
  if (!iife?.body || iife.body.type !== 'BlockStatement') return null;

  let returnNode = null;
  walk(iife.body, { enter({ node, ancestors }) {
    if (returnNode || node.type !== 'ReturnStatement') return;
    const nested = ancestors.slice(ancestors.indexOf(iife.body) + 1).some(a => /Function/.test(a.type));
    if (nested) return;
    if (node.argument?.type === 'SequenceExpression') {
      const last = node.argument.expressions.at(-1);
      if (last?.type === 'Identifier') returnNode = node;
    } else if (node.argument?.type === 'Identifier' || node.argument?.type === 'AssignmentExpression') {
      returnNode = node;
    }
  }});
  if (!returnNode) return null;

  let runnerLocal = null;
  if (returnNode.argument.type === 'Identifier') runnerLocal = returnNode.argument.name;
  else if (returnNode.argument.type === 'SequenceExpression') {
    const last = returnNode.argument.expressions.at(-1);
    if (last?.type === 'Identifier') runnerLocal = last.name;
  } else if (returnNode.argument.type === 'AssignmentExpression') {
    // obfuscator.io currently returns an assignment expression whose RHS ultimately
    // evaluates to the executor variable. Recover it from the declaration below.
  }

  const candidates = [];
  walk(iife.body, { enter({ node }) {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
    if (!node.init || !['FunctionExpression', 'ArrowFunctionExpression'].includes(node.init.type)) return;
    const fn = node.init;
    const params = fn.params.filter(p => p.type === 'Identifier').map(p => p.name);
    if (params.length < 3) return;
    const calls = [];
    walk(fn.body, { enter({ node: n }) {
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.arguments.length === 1 && n.arguments[0]?.type === 'Identifier') {
        calls.push({ callee: n.callee.name, arg: n.arguments[0].name });
      }
    }});
    for (const c of calls) {
      const idx = params.indexOf(c.arg);
      if (idx >= 0) candidates.push({ runnerLocal: node.id.name, decoderName: c.callee, programParamIndex: idx });
    }
  }});

  // Prefer the local that is actually returned when that can be determined, then
  // prefer a decoder consuming the third executor argument (the current Pro layout).
  candidates.sort((a, b) => {
    const ar = runnerLocal && a.runnerLocal === runnerLocal ? 0 : 1;
    const br = runnerLocal && b.runnerLocal === runnerLocal ? 0 : 1;
    if (ar !== br) return ar - br;
    return Math.abs(a.programParamIndex - 2) - Math.abs(b.programParamIndex - 2);
  });
  const best = candidates[0];
  if (!best) return null;

  return {
    ...best,
    insertAt: returnNode.start,
    injection: `${best.runnerLocal}.__deobfuscatorDecode=${best.decoderName};`
  };
}

function instrumentDecoder(source, ast, runnerName) {
  const info = findDecoderInjection(ast, runnerName);
  if (!info) return null;
  return { ...info, source: source.slice(0, info.insertAt) + info.injection + source.slice(info.insertAt) };
}

function cloneRuntimeValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return Array.from(value, cloneRuntimeValue);
  if (Array.isArray(value)) return Array.from(value, cloneRuntimeValue);
  return null;
}

function wrapperProgramIds(ast, runnerName, wrappers) {
  const names = new Set(wrappers.map(w => w.id.name));
  const ids = new Map();
  walk(ast, { enter({ node }) {
    if (node.type !== 'CallExpression' || node.arguments.length < 2) return;
    const c = node.callee;
    if (c?.type !== 'MemberExpression' || c.object?.type !== 'Identifier' || c.object.name !== runnerName) return;
    const first = node.arguments[0], second = node.arguments[1];
    if (first?.type === 'Identifier' && names.has(first.name) && second?.type === 'Literal' && Number.isInteger(second.value)) ids.set(first.name, second.value);
  }});
  // Fallback: executor call inside each wrapper; current runtime passes program id as arg 3.
  for (const w of wrappers) {
    if (ids.has(w.id.name)) continue;
    walk(w.body, { enter({ node }) {
      if (ids.has(w.id.name) || node.type !== 'CallExpression') return;
      if (node.callee?.type !== 'Identifier' || node.callee.name !== runnerName) return;
      const a = node.arguments[2];
      if (a?.type === 'Literal' && Number.isInteger(a.value)) ids.set(w.id.name, a.value);
    }});
  }
  return ids;
}

function decodePrograms(source, ast, runnerName, wrappers) {
  const instrumented = instrumentDecoder(source, ast, runnerName);
  if (!instrumented) return { error: 'VM decoder helper could not be located structurally' };
  let box;
  try { box = executeBundle(instrumented.source, ''); }
  catch (error) { return { error: `instrumented VM runtime failed: ${error.message}` }; }

  const ids = wrapperProgramIds(ast, runnerName, wrappers);
  const programs = new Map();
  for (const wrapper of wrappers) {
    const id = ids.get(wrapper.id.name);
    if (!Number.isInteger(id)) continue;
    box.sandbox.__deobfProgramId = id;
    let meta;
    try { meta = vm.runInContext(`${runnerName}.__deobfuscatorDecode(__deobfProgramId)`, box.context, { timeout: 1000 }); }
    catch (_) { continue; }
    finally { delete box.sandbox.__deobfProgramId; }
    if (!Array.isArray(meta)) continue;
    const values = Array.from(meta, cloneRuntimeValue);
    const typedCandidates = [];
    const arrayCandidates = [];
    for (let i = 0; i < meta.length; i++) {
      const raw = meta[i];
      if (ArrayBuffer.isView(raw)) typedCandidates.push({ index: i, values: Array.from(raw) });
      else if (Array.isArray(raw)) arrayCandidates.push({ index: i, values: Array.from(raw, cloneRuntimeValue) });
    }
    typedCandidates.sort((a, b) => b.values.length - a.values.length);
    arrayCandidates.sort((a, b) => b.values.length - a.values.length);
    const bytecode = typedCandidates[0] || null;
    // Constant pools are normal arrays. Prefer the one containing strings because
    // property names/method names are common and give the strongest signal.
    arrayCandidates.sort((a, b) => {
      const as = a.values.filter(x => typeof x === 'string').length;
      const bs = b.values.filter(x => typeof x === 'string').length;
      return bs - as || b.values.length - a.values.length;
    });
    const constants = arrayCandidates[0] || null;

    // Current Pro runtimes permute metadata slots from two small seeds. Once the
    // bytecode and constant-pool slots are known, the seed pair can be recovered
    // algebraically because their slot multipliers differ by exactly one. This
    // exposes the control-flow jump/handler tables without relying on variable
    // names inside the interpreter. If a future layout does not satisfy the
    // relation, these fields simply remain null and recovery falls back safely.
    let metadataLayout = null, jumpTable = null, handlerTable = null;
    if (bytecode && constants) {
      const mod32 = n => ((n % 32) + 32) % 32;
      const seed0 = mod32(bytecode.index - constants.index);
      const seed1 = mod32(bytecode.index - 23 * seed0);
      const checkBytecode = mod32(23 * seed0 + seed1);
      const checkConstants = mod32(22 * seed0 + seed1);
      if (checkBytecode === bytecode.index && checkConstants === constants.index) {
        const jumpIndex = mod32(20 * seed0 + seed1);
        const handlerIndex = mod32(seed1);
        const cloneSection = index => {
          const raw = meta[index];
          if (ArrayBuffer.isView(raw)) return { index, values: Array.from(raw) };
          if (Array.isArray(raw)) return { index, values: Array.from(raw, cloneRuntimeValue) };
          return null;
        };
        jumpTable = cloneSection(jumpIndex);
        handlerTable = cloneSection(handlerIndex);
        metadataLayout = { seed0, seed1, bytecodeIndex: bytecode.index, constantsIndex: constants.index, jumpIndex, handlerIndex };
      }
    }
    programs.set(wrapper.id.name, { id, metadata: values, bytecode, constants, jumpTable, handlerTable, metadataLayout });
  }
  return { programs, decoder: instrumented };
}

function switchCaseCatalog(ast, source) {
  const map = new Map();
  walk(ast, { enter({ node, ancestors }) {
    if (node.type !== 'SwitchCase' || node.test?.type !== 'Literal' || !Number.isInteger(node.test.value)) return;
    const functions = [...ancestors].reverse().filter(a => ['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(a.type));
    const fn = functions[0];
    const outerFn = functions[1] || null;
    const sw = [...ancestors].reverse().find(a => a.type === 'SwitchStatement');
    if (!fn || !sw) return;
    const params = fn.params.filter(p => p.type === 'Identifier').map(p => p.name);
    const outerParams = outerFn ? outerFn.params.filter(p => p.type === 'Identifier').map(p => p.name) : [];
    const operandName = params[1] || null;
    const item = {
      opcode: node.test.value,
      node,
      source: sourceOf(node, source),
      functionSource: sourceOf(fn, source),
      operandName,
      outerParams,
      switchDiscriminant: sourceOf(sw.discriminant, source)
    };
    const old = map.get(item.opcode);
    if (!old || item.source.length < old.source.length) map.set(item.opcode, item);
  }});
  return map;
}

module.exports = {
  makeSandbox,
  executeBundle,
  invoke,
  instrumentDecoder,
  decodePrograms,
  switchCaseCatalog,
  wrapperProgramIds
};
