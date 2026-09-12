const { literalToCode } = require('../core/ast');
const { memberAccess } = require('../core/render');

function v(code, extra = {}) { return { code, ...extra }; }
function pop(stack) {
  if (!stack.length) throw new Error('VM stack underflow');
  return stack.pop();
}
function cleanSource(s) { return s.replace(/\s+/g, ''); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function classifyRaw(item) {
  const s = cleanSource(item.source);
  const op = item.operandName ? escapeRe(item.operandName) : null;

  if ((s.includes('Must\\x20call\\x20super') || s.includes('Must call super')) && /return[^;]+,0x1/.test(s)) {
    return { type: 'RETURN' };
  }

  if ((s.includes('Cannot\\x20read\\x20properties') || s.includes('Cannot read properties')) && op) {
    const all = [...s.matchAll(new RegExp('([A-Za-z_$][\\w$]*)\\[' + op + '\\]', 'g'))].map(m => m[1]);
    const keyContainer = all.find(x => !/^sS$/.test(x)) || all[0] || null;
    return { type: 'GET_PROP', container: keyContainer };
  }

  if ((s.includes('is\\x20not\\x20a\\x20function') || s.includes('is not a function')) && s.includes('typeof') && s.includes("!=='function'")) {
    return { type: 'CALL' };
  }

  // Encoded binary super-op. The operand is XORed into a selector that chooses
  // the actual JavaScript binary operator at runtime.
  if (op && />>>0x0/.test(s) && (s.match(/[<>!=+*\/%&|^]{1,3}/g) || []).length > 12) {
    const km = s.match(new RegExp('\\(' + op + '\\^(0x[0-9a-fA-F]+|\\d+)\\)>>>'));
    return { type: 'BINARY', xorKey: km ? Number(km[1]) : 0 };
  }

  // Three-way rotation used to arrange receiver, function and arguments.
  if (/\[[A-Za-z_$][\w$]*-0x3\]/.test(s) && /\[[A-Za-z_$][\w$]*-0x2\]/.test(s) && /\[[A-Za-z_$][\w$]*-0x1\]/.test(s)) {
    return { type: 'ROT3' };
  }

  // Duplicate top of stack: tmp=stack[sp-1]; stack[sp++]=tmp
  if (/=([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)-(?:0x1|1)\]/.test(s) && /\[[A-Za-z_$][\w$]*\+\+\]=/.test(s)) {
    return { type: 'DUP' };
  }

  // Direct stack binary operations. These are used as regular opcodes and as
  // macro-op building blocks when the encoded binary super-op is disabled.
  {
    const m = s.match(/^case(?:0x[0-9a-f]+|\d+):\{let([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\[--([A-Za-z_$][\w$]*)\],([A-Za-z_$][\w$]*)=\2\[--\3\];\2\[\3\+\+\]=\4(>>>|>>|<<|===|!==|==|!=|<=|>=|<|>|\*\*|\+|-|\*|\/|%|&|\||\^|instanceof|in)\1,/);
    if (m) return { type: 'BINARY_DIRECT', operator: m[5] };
  }

  // Unary operations update the existing stack top in place.
  {
    const m = s.match(/([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)-(?:0x1|1)\]=(!|~|\+|-)\1\[\2-(?:0x1|1)\]/);
    if (m) return { type: 'UNARY_DIRECT', operator: m[3] };
    if (/=typeof[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*-(?:0x1|1)\]/.test(s)) return { type: 'UNARY_DIRECT', operator: 'typeof' };
  }

  // Operand-indexed local/argument/constant transfers must be recognized before
  // generic stack-pop patterns. STORE_TO contains stack[--sp] too.
  if (op) {
    let m = s.match(new RegExp('([A-Za-z_$][\\w$]*)\\[([A-Za-z_$][\\w$]*)\\+\\+\\]=([A-Za-z_$][\\w$]*)\\[' + op + '\\]'));
    if (m) return { type: 'PUSH_FROM', stack: m[1], sp: m[2], container: m[3] };

    m = s.match(new RegExp('([A-Za-z_$][\\w$]*)\\[' + op + '\\]=([A-Za-z_$][\\w$]*)\\[--([A-Za-z_$][\\w$]*)\\]'));
    if (m) return { type: 'STORE_TO', container: m[1], stack: m[2], sp: m[3] };
  }

  // Conditional and unconditional VM jumps. Capture relationships structurally;
  // the concrete variable names are deliberately irrelevant.
  if (/^case(?:0x[0-9a-f]+|\d+):\{?([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\[\1\];(?:break|continue);?\}?$/.test(s)) {
    return { type: 'JUMP' };
  }
  if (/![A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\]\?[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]:[A-Za-z_$][\w$]*\+\+/.test(s)) {
    return { type: 'JUMP_IF_FALSE' };
  }
  if (/[A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\]\?[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]:[A-Za-z_$][\w$]*\+\+/.test(s)) {
    return { type: 'JUMP_IF_TRUE' };
  }
  if (/!==null&&[A-Za-z_$][\w$]*!==undefined\?[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]:[A-Za-z_$][\w$]*\+\+/.test(s)) {
    return { type: 'JUMP_IF_NOT_NULLISH' };
  }
  // Short-circuit variants keep the top value on the jumping branch and pop it
  // only when evaluation continues to the RHS (logical && / || lowering).
  if (/![A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*-(?:0x1|1)\]\?[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]:\([A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\],[A-Za-z_$][\w$]*\+\+\)/.test(s)) {
    return { type: 'JUMP_IF_FALSE_KEEP' };
  }
  if (/[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*-(?:0x1|1)\]\?[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]:\([A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\],[A-Za-z_$][\w$]*\+\+\)/.test(s)) {
    return { type: 'JUMP_IF_TRUE_KEEP' };
  }

  // A true POP only discards stack[--sp] as an expression. Do not match stores.
  if (/^case(?:0x[0-9a-f]+|\d+):\{?[A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\],[A-Za-z_$][\w$]*\+\+;(?:break|continue);?\}?$/.test(s) && !s.includes('throw')) return { type: 'POP' };
  if (/throw[A-Za-z_$][\w$]*\[--[A-Za-z_$][\w$]*\]/.test(s)) return { type: 'THROW' };
  if (/\[[A-Za-z_$][\w$]*\+\+\]=\[\]/.test(s)) return { type: 'PUSH_ARRAY' };
  if (/\[[A-Za-z_$][\w$]*\+\+\]=\{\}/.test(s)) return { type: 'PUSH_OBJECT' };

  // Swap the top two values.
  if (/\[[A-Za-z_$][\w$]*-(?:0x1|1)\]=[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*-(?:0x2|2)\]/.test(s) && /\[[A-Za-z_$][\w$]*-(?:0x2|2)\]=[A-Za-z_$][\w$]*/.test(s)) return { type: 'SWAP' };

  // Constant-key property assignment: pop(value), pop(object), object[key]=value.
  if ((s.includes('Cannot\\x20set\\x20properties') || s.includes('Cannot set properties')) && op) {
    const all = [...s.matchAll(new RegExp('([A-Za-z_$][\\w$]*)\\[' + op + '\\]', 'g'))].map(m => m[1]);
    return { type: 'SET_PROP', container: all[0] || null };
  }

  if (/\['push'\]\([A-Za-z_$][\w$]*\)/.test(s) && /\[--[A-Za-z_$][\w$]*\]/.test(s)) return { type: 'ARRAY_PUSH' };

  if (/debugger;/.test(s) || /^case(?:0x[0-9a-f]+|\d+):\{?[A-Za-z_$][\w$]*\+\+;(?:break|continue);?\}?$/.test(s)) return { type: 'NOP' };

  if (/\[[A-Za-z_$][\w$]*\+\+\]=(?:void0x0|undefined)/.test(s)) return { type: 'PUSH_UNDEFINED' };
  if (/\[[A-Za-z_$][\w$]*\+\+\]=null/.test(s)) return { type: 'PUSH_NULL' };
  if (/\[[A-Za-z_$][\w$]*\+\+\]=!!\[\]/.test(s)) return { type: 'PUSH_TRUE' };
  if (/\[[A-Za-z_$][\w$]*\+\+\]=!\[\]/.test(s)) return { type: 'PUSH_FALSE' };

  return null;
}

function itemArgumentContainer(item, container) {
  if (!item || !container) return false;
  // The sync executor receives the original arguments collection as its second
  // parameter. Nested dispatcher closures capture that parameter unchanged.
  return Array.isArray(item.outerParams) && item.outerParams.length >= 2 && item.outerParams[1] === container;
}

function classifyCatalog(catalog) {
  const raw = new Map();
  for (const [opcode, item] of catalog) raw.set(opcode, classifyRaw(item));

  const constants = new Set();
  const stored = new Set();
  for (const sem of raw.values()) {
    if (sem?.type === 'GET_PROP' && sem.container) constants.add(sem.container);
    if (sem?.type === 'STORE_TO' && sem.container) stored.add(sem.container);
  }

  const classified = new Map();
  for (const [opcode, sem0] of raw) {
    if (!sem0) continue;
    const sem = { ...sem0 };
    if (sem.type === 'PUSH_FROM') {
      if (constants.has(sem.container)) sem.type = 'PUSH_CONST';
      else if (itemArgumentContainer(catalog.get(opcode), sem.container)) sem.type = 'PUSH_ARG';
      else if (stored.has(sem.container)) sem.type = 'LOAD_LOCAL';
      else sem.type = 'PUSH_ARG';
    } else if (sem.type === 'STORE_TO') {
      if (stored.has(sem.container)) sem.type = 'STORE_LOCAL';
    }
    classified.set(opcode, sem);
  }
  return classified;
}

const BINARY_SELECTOR = new Map([
  [0, '>>>'], [1, '<<'], [2, '+'], [3, '>>'], [4, '!='], [5, '<='],
  [6, '|'], [7, '>'], [8, '>='], [9, '*'], [10, '!=='], [11, '==='],
  [12, '-'], [13, '/'], [14, '&'], [15, '=='], [16, '**'], [17, '^'],
  [18, '<'], [19, '%'], [20, '|'], [21, '&'], [22, '^']
]);

function binaryOperator(operand, sem) {
  const selector = (Number(operand) ^ Number(sem.xorKey || 0)) >>> 0;
  return BINARY_SELECTOR.get(selector) || null;
}

function instructionPairs(bytecode, catalog) {
  if (!Array.isArray(bytecode) || bytecode.length < 2) return null;
  const score = orientation => {
    let hit = 0, count = 0;
    for (let i = 0; i + 1 < bytecode.length; i += 2) {
      const opcode = bytecode[i + orientation]; count++;
      if (catalog.has(opcode)) hit++;
    }
    return count ? hit / count : 0;
  };
  const oddOpcode = score(1), evenOpcode = score(0);
  const opcodeOffset = oddOpcode >= evenOpcode ? 1 : 0;
  if (Math.max(oddOpcode, evenOpcode) < 0.55) return null;
  const pairs = [];
  for (let i = 0; i + 1 < bytecode.length; i += 2) {
    pairs.push({ pc: i / 2, operand: bytecode[i + (opcodeOffset ? 0 : 1)], opcode: bytecode[i + opcodeOffset] });
  }
  return { pairs, confidence: Math.max(oddOpcode, evenOpcode), opcodeOffset };
}

function sameCode(a, b) { return a && b && a.code === b.code; }

function callValue(stack) {
  const argcVal = pop(stack);
  const argc = Number(argcVal.literal);
  if (!Number.isInteger(argc) || argc < 0 || argc > 64) throw new Error(`unsupported VM dynamic call arity: ${argcVal.code}`);
  const fn = pop(stack);
  const thisArg = pop(stack);
  const args = [];
  for (let i = 0; i < argc; i++) args.unshift(pop(stack));

  if (fn.kind === 'member' && sameCode(fn.object, thisArg)) {
    return v(`${memberAccess(thisArg.code, fn.key)}(${args.map(x => x.code).join(', ')})`);
  }
  if (thisArg.code === 'undefined' || thisArg.code === 'globalThis') {
    return v(`${fn.code}(${args.map(x => x.code).join(', ')})`);
  }
  return v(`${fn.code}.call(${thisArg.code}${args.length ? ', ' + args.map(x => x.code).join(', ') : ''})`);
}

function cloneValue(x) {
  if (!x || typeof x !== 'object') return x;
  const out = { ...x };
  if (x.object) out.object = cloneValue(x.object);
  if (Array.isArray(x.elements)) out.elements = x.elements.map(cloneValue);
  if (x.properties instanceof Map) out.properties = new Map([...x.properties].map(([k, val]) => [k, cloneValue(val)]));
  return out;
}
function cloneState(state) {
  return {
    stack: state.stack.map(cloneValue),
    locals: new Map([...state.locals].map(([k, val]) => [k, cloneValue(val)]))
  };
}

function applyDataInstruction(ins, sem, state, constants, params) {
  const stack = state.stack, locals = state.locals;
  switch (sem.type) {
    case 'PUSH_ARG': {
      const idx = Number(ins.operand);
      if (!Number.isInteger(idx) || idx < 0 || idx >= params.length) throw new Error(`argument index ${ins.operand} out of range`);
      stack.push(v(params[idx]));
      return null;
    }
    case 'PUSH_CONST': {
      const idx = Number(ins.operand);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constants.length) throw new Error(`constant index ${ins.operand} out of range`);
      const code = literalToCode(constants[idx]);
      if (code == null) throw new Error(`unsupported constant at index ${idx}`);
      stack.push(v(code, { literal: constants[idx] }));
      return null;
    }
    case 'LOAD_LOCAL': {
      if (!locals.has(ins.operand)) throw new Error(`read of unknown VM local ${ins.operand}`);
      stack.push(cloneValue(locals.get(ins.operand)));
      return null;
    }
    case 'STORE_LOCAL': locals.set(ins.operand, cloneValue(pop(stack))); return null;
    case 'DUP': {
      if (!stack.length) throw new Error('duplicate on empty stack');
      stack.push(cloneValue(stack.at(-1)));
      return null;
    }
    case 'ROT3': {
      if (stack.length < 3) throw new Error('rotate3 stack underflow');
      const a = stack[stack.length - 3], b = stack[stack.length - 2], c = stack[stack.length - 1];
      stack[stack.length - 3] = b; stack[stack.length - 2] = c; stack[stack.length - 1] = a;
      return null;
    }
    case 'GET_PROP': {
      const obj = pop(stack), idx = Number(ins.operand);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constants.length) throw new Error(`property constant ${ins.operand} missing`);
      const key = constants[idx];
      stack.push(v(memberAccess(obj.code, key), { kind: 'member', object: obj, key: String(key) }));
      return null;
    }
    case 'CALL': stack.push(callValue(stack)); return null;
    case 'BINARY': {
      const rhs = pop(stack), lhs = pop(stack), op = binaryOperator(ins.operand, sem);
      if (!op) throw new Error(`unknown binary selector ${ins.operand}`);
      stack.push(v(`(${lhs.code} ${op} ${rhs.code})`));
      return null;
    }
    case 'BINARY_DIRECT': {
      const rhs = pop(stack), lhs = pop(stack);
      stack.push(v(`(${lhs.code} ${sem.operator} ${rhs.code})`));
      return null;
    }
    case 'UNARY_DIRECT': {
      const x = pop(stack);
      stack.push(v(sem.operator === 'typeof' ? `(typeof ${x.code})` : `(${sem.operator}${x.code})`));
      return null;
    }
    case 'POP': pop(stack); return null;
    case 'THROW': {
      const x = pop(stack);
      return { terminal: 'throw', expression: x.code };
    }
    case 'PUSH_ARRAY': stack.push(v('[]', { kind: 'array', elements: [] })); return null;
    case 'PUSH_OBJECT': stack.push(v('{}', { kind: 'object', properties: new Map() })); return null;
    case 'SWAP': {
      if (stack.length < 2) throw new Error('swap stack underflow');
      const a = stack[stack.length - 1]; stack[stack.length - 1] = stack[stack.length - 2]; stack[stack.length - 2] = a;
      return null;
    }
    case 'SET_PROP': {
      const assigned = pop(stack), obj = pop(stack), idx = Number(ins.operand);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constants.length) throw new Error(`property constant ${ins.operand} missing`);
      const key = constants[idx];
      stack.push(v(`(${memberAccess(obj.code, key)} = ${assigned.code})`));
      return null;
    }
    case 'ARRAY_PUSH': {
      const item = pop(stack), arr = stack.at(-1);
      if (arr?.kind === 'array' && Array.isArray(arr.elements)) {
        arr.elements.push(item);
        arr.code = `[${arr.elements.map(x => x.code).join(', ')}]`;
      } else throw new Error('array-push target is not a statically built array');
      return null;
    }
    case 'NOP': return null;
    case 'PUSH_UNDEFINED': stack.push(v('undefined', { literal: undefined })); return null;
    case 'PUSH_NULL': stack.push(v('null', { literal: null })); return null;
    case 'PUSH_TRUE': stack.push(v('true', { literal: true })); return null;
    case 'PUSH_FALSE': stack.push(v('false', { literal: false })); return null;
    case 'RETURN': return { terminal: 'return', expression: pop(stack).code };
    default: throw new Error(`unsupported semantic ${sem.type}`);
  }
}

function stateKey(pc, state) {
  const stack = state.stack.map(x => x.code).join('|');
  const locals = [...state.locals].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, x]) => `${k}:${x.code}`).join('|');
  return `${pc}::${stack}::${locals}`;
}

function liftPath({ pairs, semantics, constants, params, jumpTable, trace }, pc, initialState, active = new Set(), depth = 0) {
  if (depth > 64) return { ok: false, reason: 'VM CFG nesting limit exceeded' };
  const state = cloneState(initialState);
  let steps = 0;

  while (pc >= 0 && pc < pairs.length) {
    if (++steps > 4096) return { ok: false, reason: 'VM CFG step limit exceeded' };
    const key = stateKey(pc, state);
    if (active.has(key)) return { ok: false, reason: `VM loop/cycle reached at pc ${pc}; loop lifting not yet safe` };
    const nextActive = new Set(active); nextActive.add(key);

    const ins = pairs[pc], sem = semantics.get(ins.opcode);
    if (!sem) return { ok: false, reason: `unknown opcode ${ins.opcode} at VM pc ${pc}` };
    trace.push({ ...ins, semantic: sem.type, depth });

    const target = () => {
      if (!Array.isArray(jumpTable)) throw new Error(`${sem.type} requires decoded VM jump table`);
      const t = Number(jumpTable[pc]);
      if (!Number.isInteger(t) || t < 0 || t >= pairs.length) throw new Error(`invalid VM jump target ${jumpTable[pc]} at pc ${pc}`);
      return t;
    };

    try {
      if (sem.type === 'JUMP') {
        pc = target();
        active = nextActive;
        continue;
      }

      if (['JUMP_IF_TRUE', 'JUMP_IF_FALSE', 'JUMP_IF_NOT_NULLISH', 'JUMP_IF_TRUE_KEEP', 'JUMP_IF_FALSE_KEEP'].includes(sem.type)) {
        let cond, trueState, falseState, truePc, falsePc;
        const t = target();

        if (sem.type === 'JUMP_IF_TRUE_KEEP' || sem.type === 'JUMP_IF_FALSE_KEEP') {
          if (!state.stack.length) throw new Error(`${sem.type} on empty stack`);
          cond = cloneValue(state.stack.at(-1));
          trueState = cloneState(state); falseState = cloneState(state);
          if (sem.type === 'JUMP_IF_TRUE_KEEP') {
            truePc = t;
            falseState.stack.pop(); falsePc = pc + 1;
          } else {
            trueState.stack.pop(); truePc = pc + 1;
            falsePc = t;
          }
        } else {
          const raw = pop(state.stack);
          cond = sem.type === 'JUMP_IF_NOT_NULLISH' ? v(`(${raw.code} != null)`) : raw;
          trueState = cloneState(state); falseState = cloneState(state);
          if (sem.type === 'JUMP_IF_TRUE' || sem.type === 'JUMP_IF_NOT_NULLISH') {
            truePc = t; falsePc = pc + 1;
          } else {
            truePc = pc + 1; falsePc = t;
          }
        }

        const tr = liftPath({ pairs, semantics, constants, params, jumpTable, trace }, truePc, trueState, nextActive, depth + 1);
        const fr = liftPath({ pairs, semantics, constants, params, jumpTable, trace }, falsePc, falseState, nextActive, depth + 1);
        if (!tr.ok) return tr;
        if (!fr.ok) return fr;
        if (tr.terminal !== 'return' || fr.terminal !== 'return') {
          return { ok: false, reason: `branch at pc ${pc} does not converge to return expressions` };
        }
        if (tr.expression === fr.expression) return tr;
        return { ok: true, terminal: 'return', expression: `(${cond.code} ? ${tr.expression} : ${fr.expression})`, controlFlow: true };
      }

      const terminal = applyDataInstruction(ins, sem, state, constants, params);
      if (terminal) {
        if (terminal.terminal === 'throw') return { ok: false, reason: `VM throw reached: ${terminal.expression}` };
        return { ok: true, ...terminal };
      }
      pc++;
      active = nextActive;
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }
  return { ok: false, reason: 'VM program left instruction range without return' };
}

function liftProgram(program, params, catalog) {
  if (!program?.bytecode?.values) return { ok: false, reason: 'decoded VM bytecode not found' };
  const constants = program.constants?.values || [];
  const semantics = classifyCatalog(catalog);
  const layout = instructionPairs(program.bytecode.values, semantics);
  if (!layout) return { ok: false, reason: 'VM instruction layout could not be identified' };

  const usedOpcodes = new Set(layout.pairs.map(x => x.opcode));
  const classifiedUsed = [...usedOpcodes].filter(x => semantics.has(x)).length;
  const semanticCoverage = usedOpcodes.size ? classifiedUsed / usedOpcodes.size : 0;
  const trace = [];
  const jumpTable = program.jumpTable?.values || null;
  const result = liftPath({ pairs: layout.pairs, semantics, constants, params, jumpTable, trace }, 0, { stack: [], locals: new Map() });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      trace,
      instructionConfidence: layout.confidence,
      semanticCoverage,
      usedOpcodes: usedOpcodes.size,
      classifiedUsedOpcodes: classifiedUsed
    };
  }

  return {
    ok: true,
    expression: result.expression,
    code: `return ${result.expression};`,
    trace,
    instructionConfidence: layout.confidence,
    semanticCoverage,
    usedOpcodes: usedOpcodes.size,
    classifiedUsedOpcodes: classifiedUsed,
    controlFlowRecovered: !!result.controlFlow || trace.some(x => /^JUMP/.test(x.semantic)),
    constants,
    bytecodeLength: program.bytecode.values.length,
    metadataLayout: program.metadataLayout || null
  };
}

module.exports = { classifyCatalog, instructionPairs, liftProgram, binaryOperator };
