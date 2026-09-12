const NIL = null;

class LuaTable {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.has(key) ? this.map.get(key) : NIL; }
  set(key, value) { if (value == null) this.map.delete(key); else this.map.set(key, value); }
  length() {
    let n = 0;
    while (this.map.has(n + 1) && this.map.get(n + 1) != null) n++;
    return n;
  }
}

const truthy = value => value !== false && value != null;
const results = (...values) => values;
const callable = fn => ({ kind: 'native', call: fn });

function getTable(table, key) {
  if (table instanceof LuaTable) return table.get(key);
  if (table?.kind === 'library') return table.values.get(key) ?? NIL;
  throw new Error(`IR evaluator: attempted table access on ${typeof table}`);
}

function setTable(table, key, value) {
  if (!(table instanceof LuaTable)) throw new Error('IR evaluator: attempted table write on non-table');
  table.set(key, value);
}

function luaNumber(value) {
  if (typeof value !== 'number') throw new Error(`IR evaluator: number expected, got ${typeof value}`);
  return value;
}

function luaString(value) {
  if (typeof value !== 'string') throw new Error(`IR evaluator: string expected, got ${typeof value}`);
  return value;
}

function luaLength(value) {
  if (typeof value === 'string') return value.length;
  if (value instanceof LuaTable) return value.length();
  throw new Error('IR evaluator: length on unsupported value');
}

function luaMod(a, b) { return a - Math.floor(a / b) * b; }
function binary(operator, a, b) {
  switch (operator) {
    case '+': return luaNumber(a) + luaNumber(b);
    case '-': return luaNumber(a) - luaNumber(b);
    case '*': return luaNumber(a) * luaNumber(b);
    case '/': return luaNumber(a) / luaNumber(b);
    case '//': return Math.floor(luaNumber(a) / luaNumber(b));
    case '%': return luaMod(luaNumber(a), luaNumber(b));
    case '^': return luaNumber(a) ** luaNumber(b);
    case '..': return String(a) + String(b);
    case '==': return a === b;
    case '~=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case 'and': return truthy(a) ? b : a;
    case 'or': return truthy(a) ? a : b;
    default: throw new Error(`IR evaluator: unsupported binary operator ${operator}`);
  }
}
function unary(operator, value) {
  if (operator === 'not') return !truthy(value);
  if (operator === '-') return -luaNumber(value);
  if (operator === '#') return luaLength(value);
  throw new Error(`IR evaluator: unsupported unary operator ${operator}`);
}

function library(values) { return { kind: 'library', values: new Map(Object.entries(values)) }; }
function toUint32(value) { return Number(BigInt.asUintN(32, BigInt(Math.trunc(value)))); }

export function createPureLuaEnvironment() {
  const string = library({
    byte: callable(args => {
      const s = luaString(args[0]);
      let first = args[1] == null ? 1 : Math.trunc(luaNumber(args[1]));
      let last = args[2] == null ? first : Math.trunc(luaNumber(args[2]));
      if (first < 0) first = s.length + first + 1;
      if (last < 0) last = s.length + last + 1;
      first = Math.max(1, first); last = Math.min(s.length, last);
      const out = []; for (let i = first; i <= last; i++) out.push(s.charCodeAt(i - 1) & 0xff);
      return out;
    }),
    char: callable(args => results(String.fromCharCode(...args.map(x => toUint32(luaNumber(x)) & 0xff)))),
  });
  const table = library({
    concat: callable(args => {
      const t = args[0]; if (!(t instanceof LuaTable)) throw new Error('table.concat expects table');
      const sep = args[1] == null ? '' : String(args[1]);
      const first = args[2] == null ? 1 : Math.trunc(luaNumber(args[2]));
      const last = args[3] == null ? t.length() : Math.trunc(luaNumber(args[3]));
      const out = []; for (let i = first; i <= last; i++) out.push(String(t.get(i) ?? ''));
      return results(out.join(sep));
    }),
  });
  const math = library({ floor: callable(args => results(Math.floor(luaNumber(args[0])))) });
  const bit32 = library({
    bxor: callable(args => {
      let value = 0;
      for (const x of args) value = (value ^ toUint32(luaNumber(x))) >>> 0;
      return results(value);
    }),
  });
  return new Map([['string', string], ['table', table], ['math', math], ['bit32', bit32]]);
}

function readValue(value, registers) {
  if (!value) return NIL;
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'reg') return registers.get(value.index) ?? NIL;
  throw new Error(`IR evaluator: unresolved value kind ${value.kind}`);
}

function invoke(fn, args, context) {
  if (fn?.kind === 'native') return fn.call(args);
  if (fn?.kind === 'closure') return executeFrame(context, fn.programId, args, fn.upvalues);
  throw new Error('IR evaluator: attempted call of non-callable value');
}

function executeFrame(context, programId, args, upvalues = new Map()) {
  const program = context.byId.get(programId);
  if (!program) throw new Error(`IR evaluator: missing prototype ${programId}`);
  const instructions = program.instructions;
  const indexByPc = new Map(instructions.map((x, i) => [x.pc, i]));
  const registers = new Map(), openBoxes = new Map();
  const varargs = args.slice(program.paramCount);
  let top = -1;
  const setr = (index, value) => {
    registers.set(index, value ?? NIL);
    const box = openBoxes.get(index); if (box) box.value = value ?? NIL;
    if (index > top) top = index;
  };
  const box = index => {
    let b = openBoxes.get(index);
    if (!b) { b = { value: registers.get(index) ?? NIL }; openBoxes.set(index, b); }
    return b;
  };
  for (let i = 0; i < program.paramCount; i++) setr(i, args[i] ?? NIL);

  let ip = 0, steps = 0;
  const next = () => { ip++; };
  const jump = pc => {
    const target = indexByPc.get(pc);
    if (target == null) throw new Error(`IR evaluator: invalid jump target ${pc} in P${programId}`);
    ip = target;
  };

  while (ip < instructions.length) {
    if (++steps > context.maxSteps) throw new Error(`IR evaluator: step limit exceeded in P${programId}`);
    const x = instructions[ip];
    switch (x.op) {
      case 'nop': case 'vm_internal': next(); break;
      case 'move': setr(x.dst, readValue(x.src, registers)); next(); break;
      case 'move_pair': setr(x.dst, readValue(x.src, registers)); setr(x.secondDst, registers.get(x.secondSrc) ?? NIL); next(); break;
      case 'clear_range': for (let r = x.from; r <= x.to; r++) setr(r, NIL); next(); break;
      case 'getglobal': {
        const key = readValue(x.key, registers); if (typeof key !== 'string' || !context.globals.has(key)) throw new Error(`IR evaluator: global ${String(key)} not allowed`);
        setr(x.dst, context.globals.get(key)); next(); break;
      }
      case 'gettable': setr(x.dst, getTable(registers.get(x.table), readValue(x.key, registers))); next(); break;
      case 'settable': setTable(registers.get(x.table), readValue(x.key, registers), readValue(x.value, registers)); next(); break;
      case 'newtable': setr(x.dst, new LuaTable()); next(); break;
      case 'setlist': {
        const table = registers.get(x.table); if (!(table instanceof LuaTable)) throw new Error('IR evaluator: SETLIST target is not table');
        const last = x.open ? top : x.to; let key = 1;
        for (let r = x.from; r <= last; r++) table.set(key++, registers.get(r) ?? NIL);
        next(); break;
      }
      case 'getupval': setr(x.dst, upvalues.get(x.slot)?.value ?? NIL); next(); break;
      case 'closure': {
        const captured = new Map();
        for (const binding of x.upvalues ?? []) {
          const source = binding.kind === 0 ? box(binding.index) : upvalues.get(binding.index);
          if (!source) throw new Error(`IR evaluator: missing upvalue ${binding.index}`);
          captured.set(binding.slot, source);
        }
        setr(x.dst, { kind: 'closure', programId: x.prototype, upvalues: captured }); next(); break;
      }
      case 'close': {
        const b = openBoxes.get(x.register); if (b) { b.value = registers.get(x.register) ?? NIL; openBoxes.delete(x.register); }
        next(); break;
      }
      case 'unary': setr(x.dst, unary(x.operator, readValue(x.value, registers))); next(); break;
      case 'binary': setr(x.dst, binary(x.operator, readValue(x.left, registers), readValue(x.right, registers))); next(); break;
      case 'jump': jump(x.target); break;
      case 'branch_false': if (!truthy(readValue(x.condition, registers))) jump(x.target); else next(); break;
      case 'forprep': {
        const initial = luaNumber(registers.get(x.index)), limit = luaNumber(registers.get(x.limit)), step = luaNumber(registers.get(x.step));
        const done = (step > 0 && initial > limit) || (step < 0 && initial < limit);
        if (done) jump(x.target); else next(); break;
      }
      case 'forloop': {
        const value = luaNumber(registers.get(x.index)) + luaNumber(registers.get(x.step)); setr(x.index, value);
        const limit = luaNumber(registers.get(x.limit)), step = luaNumber(registers.get(x.step));
        const live = (step > 0 && value <= limit) || (step < 0 && value >= limit);
        if (live) jump(x.target); else next(); break;
      }
      case 'vararg': {
        const count = x.count < 0 ? varargs.length : x.count;
        for (let i = 0; i < count; i++) setr(x.base + i, varargs[i] ?? NIL);
        top = x.base + count - 1; next(); break;
      }
      case 'call': {
        const callArgs = [];
        if (x.argCount < 0) {
          const prefix = Math.max(0, x.openPrefix);
          for (let i = 1; i <= prefix; i++) callArgs.push(registers.get(x.base + i) ?? NIL);
          for (let r = x.base + prefix + 1; r <= top; r++) callArgs.push(registers.get(r) ?? NIL);
        } else {
          for (let i = 1; i <= x.argCount; i++) callArgs.push(registers.get(x.base + i) ?? NIL);
        }
        const out = invoke(registers.get(x.base), callArgs, context);
        if (x.resultCount < 0) {
          for (let i = 0; i < out.length; i++) setr(x.base + i, out[i] ?? NIL);
          top = x.base + out.length - 1;
        } else if (x.resultCount > 0) {
          for (let i = 0; i < x.resultCount; i++) setr(x.base + i, out[i] ?? NIL);
          top = x.base + x.resultCount - 1;
        } else top = x.base - 1;
        next(); break;
      }
      case 'tailcall': {
        const callArgs = [];
        if (x.argCount < 0) {
          const prefix = Math.max(0, x.openPrefix);
          for (let i = 1; i <= prefix; i++) callArgs.push(registers.get(x.base + i) ?? NIL);
          for (let r = x.base + prefix + 1; r <= top; r++) callArgs.push(registers.get(r) ?? NIL);
        } else for (let i = 1; i <= x.argCount; i++) callArgs.push(registers.get(x.base + i) ?? NIL);
        return invoke(registers.get(x.base), callArgs, context);
      }
      case 'return': {
        if (!x.hasValues) return [];
        const count = x.open ? Math.max(0, top - x.base + 1) : x.count;
        const out = []; for (let i = 0; i < count; i++) out.push(registers.get(x.base + i) ?? NIL);
        return out;
      }
      default: throw new Error(`IR evaluator: unsupported opcode ${x.op} in P${programId}`);
    }
  }
  return [];
}

/**
 * Evaluate a recovered prototype without invoking the host Lua runtime.  The
 * caller supplies an explicit allow-list environment, making this suitable for
 * pure helper/decoder partial evaluation but deliberately unsuitable for user
 * payload execution.
 */
export function evaluateIrProgram(bundle, programId, args, { globals = createPureLuaEnvironment(), maxSteps = 250000 } = {}) {
  const context = { byId: new Map(bundle.programs.map(p => [p.id, p])), globals, maxSteps };
  return executeFrame(context, programId, args, new Map());
}
