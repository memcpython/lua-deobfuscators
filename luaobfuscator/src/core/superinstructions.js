import luaparse from "luaparse";
import { foldNumericNoise } from "../transforms/foldNumericNoise.js";

function identifierName(node) {
  return node?.type === "Identifier" ? node.name : null;
}

function indexBaseName(node) {
  return node?.type === "IndexExpression" ? identifierName(node.base) : null;
}

function numericIndex(node) {
  if (node?.type !== "IndexExpression" || node.index?.type !== "NumericLiteral") return null;
  return node.index.value;
}

function isTrueLiteral(node) {
  return node?.type === "BooleanLiteral" && node.value === true;
}

function findVmRuntime(ast) {
  let runtime = null;

  function visit(node) {
    if (!node || typeof node !== "object" || runtime) return;

    if (
      node.type === "FunctionDeclaration" &&
      node.parameters.length === 3
    ) {
      const returned = node.body.find((statement) => statement.type === "ReturnStatement");
      const inner = returned?.arguments?.[0];
      if (inner?.type === "FunctionDeclaration") {
        const loop = inner.body.find((statement) => statement.type === "WhileStatement");
        const [loadInstruction, loadOpcode, dispatch, advance] = loop?.body ?? [];

        if (
          loadInstruction?.type === "AssignmentStatement" &&
          loadOpcode?.type === "AssignmentStatement" &&
          dispatch?.type === "IfStatement" &&
          advance?.type === "AssignmentStatement"
        ) {
          const instructionName = identifierName(loadInstruction.variables[0]);
          const instructionArrayName = indexBaseName(loadInstruction.init[0]);
          const pcName = identifierName(loadInstruction.init[0]?.index);
          const opcodeName = identifierName(loadOpcode.variables[0]);
          const opcodeSourceName = indexBaseName(loadOpcode.init[0]);

          if (
            instructionName &&
            instructionArrayName &&
            pcName &&
            opcodeName &&
            opcodeSourceName === instructionName &&
            numericIndex(loadOpcode.init[0]) === 1
          ) {
            runtime = {
              outer: node,
              inner,
              loop,
              dispatch,
              instructionName,
              instructionArrayName,
              pcName,
              opcodeName,
              upvaluesName: identifierName(node.parameters[1]),
              environmentName: identifierName(node.parameters[2]),
              closureFactoryName: identifierName(node.identifier)
            };
            enrichRuntimeNames(runtime);
            return;
          }
        }
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        visit(value);
      }
    }
  }

  visit(ast);
  return runtime;
}

function countIndexBases(node, counts = new Map()) {
  if (!node || typeof node !== "object") return counts;
  if (node.type === "IndexExpression") {
    const name = identifierName(node.base);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) countIndexBases(child, counts);
    } else {
      countIndexBases(value, counts);
    }
  }
  return counts;
}

function enrichRuntimeNames(runtime) {
  const outerParameter = identifierName(runtime.outer.parameters[0]);
  const protoFields = new Map();

  for (const statement of runtime.outer.body) {
    if (
      statement.type !== "LocalStatement" ||
      statement.variables.length !== 1 ||
      statement.init.length !== 1
    ) {
      continue;
    }
    const value = statement.init[0];
    if (value?.type !== "IndexExpression" || identifierName(value.base) !== outerParameter) continue;
    const field = numericIndex(value);
    const name = identifierName(statement.variables[0]);
    if (field !== null && name) protoFields.set(field, name);
  }

  for (const statement of runtime.inner.body) {
    if (
      statement.type !== "LocalStatement" ||
      statement.variables.length !== 1 ||
      statement.init.length !== 1
    ) {
      continue;
    }

    const name = identifierName(statement.variables[0]);
    const value = statement.init[0];
    const source = identifierName(value);
    if (!name) continue;
    if (source === protoFields.get(2)) runtime.childProtosName = name;
    if (source === protoFields.get(3)) runtime.parameterCountName = name;
    if (
      value?.type === "UnaryExpression" &&
      value.operator === "-" &&
      value.argument?.type === "NumericLiteral" &&
      value.argument.value === 1
    ) {
      runtime.topName = name;
    }
  }

  const excluded = new Set([
    runtime.instructionName,
    runtime.instructionArrayName,
    runtime.pcName,
    runtime.opcodeName,
    runtime.upvaluesName,
    runtime.environmentName,
    runtime.childProtosName,
    runtime.parameterCountName
  ]);
  const counts = countIndexBases(runtime.dispatch);
  runtime.registersName = [...counts]
    .filter(([name]) => !excluded.has(name))
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function evaluateConstant(node, environment) {
  if (!node) throw new Error("Missing constant expression");

  switch (node.type) {
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "Identifier":
      if (environment.has(node.name)) return environment.get(node.name);
      throw new Error(`Unknown constant identifier ${node.name}`);
    case "UnaryExpression": {
      const value = evaluateConstant(node.argument, environment);
      if (node.operator === "not") return !value;
      if (node.operator === "-") return -value;
      if (node.operator === "+") return +value;
      throw new Error(`Unsupported constant unary operator ${node.operator}`);
    }
    case "BinaryExpression":
    case "LogicalExpression": {
      if (node.operator === "and") {
        return evaluateConstant(node.left, environment) && evaluateConstant(node.right, environment);
      }
      if (node.operator === "or") {
        return evaluateConstant(node.left, environment) || evaluateConstant(node.right, environment);
      }

      const left = evaluateConstant(node.left, environment);
      const right = evaluateConstant(node.right, environment);
      switch (node.operator) {
        case "==": return left === right;
        case "~=": return left !== right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "^": return left ** right;
        default:
          throw new Error(`Unsupported constant binary operator ${node.operator}`);
      }
    }
    default:
      throw new Error(`Unsupported constant node ${node.type}`);
  }
}

function selectIfBody(statement, environment, options = {}) {
  for (const clause of statement.clauses) {
    if (!clause.condition) return clause.body;
    try {
      if (evaluateConstant(clause.condition, environment)) return clause.body;
    } catch (error) {
      if (!options.partial) throw error;
      const index = statement.clauses.indexOf(clause);
      return [{
        ...statement,
        clauses: statement.clauses.slice(index),
        range: null,
        synthetic: true
      }];
    }
  }
  return [];
}

function resolveOpcodeHandler(dispatch, opcodeName, opcode) {
  const environment = new Map([[opcodeName, opcode]]);
  let body = selectIfBody(dispatch, environment);

  while (body.length === 1 && body[0].type === "IfStatement") {
    const next = selectIfBody(body[0], environment, { partial: true });
    if (next.length === 1 && next[0] === body[0]) break;
    body = next;
    if (body[0]?.synthetic) break;
  }

  return body;
}

function assignConstant(statement, environment) {
  if (
    statement.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1
  ) {
    return false;
  }

  const name = identifierName(statement.variables[0]);
  if (!name || !environment.has(name)) return false;

  try {
    environment.set(name, evaluateConstant(statement.init[0], environment));
    return true;
  } catch {
    environment.delete(name);
    return false;
  }
}

function executeFlattenedBlock(body, environment, out, options = {}) {
  for (const statement of body) {
    if (statement.type === "LocalStatement") {
      let runtimeInitialization = false;
      for (let index = 0; index < statement.variables.length; index += 1) {
        const name = identifierName(statement.variables[index]);
        if (!name) continue;
        const init = statement.init[index];
        try {
          environment.set(name, init ? evaluateConstant(init, environment) : null);
        } catch {
          environment.delete(name);
          runtimeInitialization = true;
        }
      }
      if (runtimeInitialization) out.push(statement);
      continue;
    }

    if (assignConstant(statement, environment)) continue;

    if (statement.type === "BreakStatement") return "break";

    if (statement.type === "IfStatement") {
      try {
        const selected = selectIfBody(statement, environment);
        const signal = executeFlattenedBlock(selected, environment, out, options);
        if (signal) return signal;
        continue;
      } catch {
        out.push(statement);
        continue;
      }
    }

    if (statement.type === "WhileStatement" && isTrueLiteral(statement.condition)) {
      let iterations = 0;
      while (iterations < (options.maxIterations ?? 10_000)) {
        iterations += 1;
        const signal = executeFlattenedBlock(statement.body, environment, out, options);
        if (signal === "break") break;
      }
      if (iterations >= (options.maxIterations ?? 10_000)) {
        throw new Error("Superinstruction state machine did not terminate");
      }
      continue;
    }

    out.push(statement);
  }

  return null;
}

function flattenHandler(body) {
  const environment = new Map();
  const out = [];
  executeFlattenedBlock(body, environment, out);
  return out;
}

function isPcIncrement(statement, pcName) {
  if (
    statement.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    identifierName(statement.variables[0]) !== pcName
  ) {
    return false;
  }

  const expression = statement.init[0];
  if (expression?.type !== "BinaryExpression" || expression.operator !== "+") return false;
  return (
    identifierName(expression.left) === pcName &&
    expression.right?.type === "NumericLiteral" &&
    expression.right.value === 1
  ) || (
    identifierName(expression.right) === pcName &&
    expression.left?.type === "NumericLiteral" &&
    expression.left.value === 1
  );
}

function isInstructionReload(statement, runtime) {
  if (
    statement.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    identifierName(statement.variables[0]) !== runtime.instructionName
  ) {
    return false;
  }

  const expression = statement.init[0];
  return expression?.type === "IndexExpression" &&
    identifierName(expression.base) === runtime.instructionArrayName &&
    identifierName(expression.index) === runtime.pcName;
}

function splitConsumedInstructions(statements, runtime) {
  const segments = [[]];

  for (const statement of statements) {
    if (isPcIncrement(statement, runtime.pcName)) {
      segments.push([]);
      continue;
    }
    if (isInstructionReload(statement, runtime)) continue;
    segments.at(-1).push(statement);
  }

  while (segments.length > 1 && segments.at(-1).length === 0) segments.pop();
  return segments;
}

function normalizeInterpreterSource(source, payloadStart) {
  let code = `${source.slice(0, payloadStart)}return nil`;
  for (let pass = 0; pass < 8; pass += 1) {
    code = foldNumericNoise(code).code;
  }
  return code;
}

export function analyzeSuperinstructionVm(source, payloadStart, maxOpcode) {
  const code = normalizeInterpreterSource(source, payloadStart);
  const ast = luaparse.parse(code, {
    luaVersion: "5.3",
    ranges: true
  });
  const runtime = findVmRuntime(ast);
  if (!runtime) return null;

  const handlers = new Map();
  for (let opcode = 0; opcode <= maxOpcode; opcode += 1) {
    const body = resolveOpcodeHandler(runtime.dispatch, runtime.opcodeName, opcode);
    const statements = flattenHandler(body);
    handlers.set(opcode, {
      opcode,
      statements,
      segments: splitConsumedInstructions(statements, runtime)
    });
  }

  return {
    code,
    runtime,
    handlers
  };
}

export function formatHandlerSegment(analysis, segment) {
  return segment
    .map((statement) => statement.range
      ? analysis.code.slice(statement.range[0], statement.range[1])
      : "<synthetic>")
    .join(";")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactSegment(analysis, segment) {
  return formatHandlerSegment(analysis, segment).replace(/\s+/g, "");
}

function instructionField(node, runtime) {
  if (
    node?.type !== "IndexExpression" ||
    identifierName(node.base) !== runtime.instructionName ||
    node.index?.type !== "NumericLiteral"
  ) {
    return null;
  }
  return node.index.value;
}

function registerInstructionField(node, runtime) {
  if (
    node?.type !== "IndexExpression" ||
    identifierName(node.base) !== runtime.registersName
  ) {
    return null;
  }
  return instructionField(node.index, runtime);
}

function simplifyRuntimeCondition(node, aliases = new Map()) {
  if (!node) return node;
  if (node.type === "Identifier" && aliases.has(node.name)) {
    return simplifyRuntimeCondition(aliases.get(node.name), aliases);
  }

  if (node.type === "UnaryExpression") {
    const argument = simplifyRuntimeCondition(node.argument, aliases);
    try {
      return {
        type: "BooleanLiteral",
        value: evaluateConstant({ ...node, argument }, new Map())
      };
    } catch {
      return { ...node, argument };
    }
  }

  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    const left = simplifyRuntimeCondition(node.left, aliases);
    const right = simplifyRuntimeCondition(node.right, aliases);
    const expression = { ...node, left, right };
    try {
      return {
        type: "BooleanLiteral",
        value: evaluateConstant(expression, new Map())
      };
    } catch {
      if (node.operator === "and") {
        if (left.type === "BooleanLiteral") return left.value ? right : left;
        if (right.type === "BooleanLiteral") return right.value ? left : right;
      }
      if (node.operator === "or") {
        if (left.type === "BooleanLiteral") return left.value ? left : right;
        if (right.type === "BooleanLiteral") return right.value ? right : left;
      }
      return expression;
    }
  }

  return node;
}

function isPcAdvance(statement, runtime) {
  return isPcIncrement(statement, runtime.pcName);
}

function isPcJump(statement, runtime) {
  if (
    statement?.type !== "AssignmentStatement" ||
    statement.variables.length !== 1 ||
    identifierName(statement.variables[0]) !== runtime.pcName
  ) {
    return false;
  }
  return instructionField(statement.init[0], runtime) === 3;
}

function branchAction(body, runtime) {
  let advances = false;
  let jumps = false;
  let assignsRegister = false;

  function visit(statements) {
    for (const statement of statements) {
      if (isPcAdvance(statement, runtime)) advances = true;
      else if (isPcJump(statement, runtime)) jumps = true;
      else if (
        statement.type === "AssignmentStatement" &&
        registerInstructionField(statement.variables[0], runtime) === 2
      ) {
        assignsRegister = true;
      } else if (statement.type === "WhileStatement" || statement.type === "DoStatement") {
        visit(statement.body);
      }
    }
  }

  visit(body);
  if (advances && !jumps) return { type: "advance", assignsRegister };
  if (jumps && !advances) return { type: "jump", assignsRegister };
  return null;
}

function branchOperand(node, runtime) {
  const registerField = registerInstructionField(node, runtime);
  if (registerField !== null) return { type: "register", field: registerField };
  const immediateField = instructionField(node, runtime);
  if (immediateField !== null) return { type: "immediate", field: immediateField };
  return null;
}

function classifyBranchSegment(segment, runtime) {
  const aliases = new Map();
  let statement = null;

  for (const candidate of segment) {
    if (
      candidate.type === "LocalStatement" &&
      candidate.variables.length === 1 &&
      candidate.init.length === 1
    ) {
      const name = identifierName(candidate.variables[0]);
      if (name) aliases.set(name, candidate.init[0]);
    } else if (candidate.type === "IfStatement") {
      statement = candidate;
    }
  }

  if (!statement || statement.clauses.length < 2) return null;
  const first = statement.clauses[0];
  const second = statement.clauses[1];
  const onTrue = branchAction(first.body, runtime);
  const onFalse = branchAction(second.body, runtime);
  if (!onTrue || !onFalse || onTrue.type === onFalse.type) return null;

  const condition = simplifyRuntimeCondition(first.condition, aliases);
  let descriptor;

  if (condition.type === "UnaryExpression" && condition.operator === "not") {
    const operand = branchOperand(condition.argument, runtime);
    if (operand?.type === "register") {
      descriptor = { operator: "falsy", left: operand };
    }
  } else {
    const direct = branchOperand(condition, runtime);
    if (direct?.type === "register") {
      descriptor = { operator: "truthy", left: direct };
    } else if (condition.type === "BinaryExpression") {
      const left = branchOperand(condition.left, runtime);
      const right = branchOperand(condition.right, runtime);
      if (left && right && ["==", "~=", "<", "<=", ">", ">="].includes(condition.operator)) {
        descriptor = { operator: condition.operator, left, right };
      }
    }
  }

  if (!descriptor) return null;
  return {
    kind: "branch",
    branch: {
      ...descriptor,
      trueAction: onTrue.type,
      falseAction: onFalse.type,
      assignsOnTrue: onTrue.assignsRegister,
      assignsOnFalse: onFalse.assignsRegister
    }
  };
}

function classifySegment(analysis, segment) {
  const runtime = analysis.runtime;
  const branch = classifyBranchSegment(segment, runtime);
  if (branch) return branch;

  const text = compactSegment(analysis, segment);
  const r = escapeRegExp(runtime.registersName);
  const i = escapeRegExp(runtime.instructionName);
  const pc = escapeRegExp(runtime.pcName);
  const env = escapeRegExp(runtime.environmentName);
  const upvalues = escapeRegExp(runtime.upvaluesName);
  const children = escapeRegExp(runtime.childProtosName);
  const factory = escapeRegExp(runtime.closureFactoryName);
  const top = escapeRegExp(runtime.topName);
  const temp = "([A-Za-z_][A-Za-z0-9_]*)";
  const a = `${i}\\[2\\]`;
  const b = `${i}\\[3\\]`;
  const c = `${i}\\[4\\]`;
  const ra = `${r}\\[${a}\\]`;
  const rb = `${r}\\[${b}\\]`;
  const rc = `${r}\\[${c}\\]`;

  const exact = [
    [new RegExp(`^${ra}=${b}$`), "loadk"],
    [new RegExp(`^${ra}=${env}\\[${b}\\]$`), "getglobal"],
    [new RegExp(`^${ra}=${upvalues}\\[${b}\\]$`), "getupvalue"],
    [new RegExp(`^${upvalues}\\[${b}\\]=${ra}$`), "setupvalue"],
    [new RegExp(`^${env}\\[${b}\\]=${ra}$`), "setglobal"],
    [new RegExp(`^${ra}=${rb}$`), "move"],
    [new RegExp(`^${ra}=${b}~=0$`), "loadbool"],
    [new RegExp(`^${ra}=\\{\\}$`), "newtable"],
    [new RegExp(`^${ra}=${rb}\\[${c}\\]$`), "gettable_k"],
    [new RegExp(`^${ra}=${rb}\\[${rc}\\]$`), "gettable_r"],
    [new RegExp(`^${ra}\\[${b}\\]=${rc}$`), "settable_kc"],
    [new RegExp(`^${ra}\\[${b}\\]=${c}$`), "settable_k_const"],
    [new RegExp(`^${ra}\\[${rb}\\]=${rc}$`), "settable_r"],
    [new RegExp(`^${ra}\\[${rb}\\]=${c}$`), "settable_rk"],
    [new RegExp(`^${ra}=#${rb}$`), "len"],
    [new RegExp(`^${ra}=not${rb}$`), "not"],
    [new RegExp(`^${ra}=-${rb}$`), "unm"],
    [new RegExp(`^${ra}=${rb}\\+${rc}$`), "add"],
    [new RegExp(`^${ra}=${rb}-${rc}$`), "sub"],
    [new RegExp(`^${ra}=${rb}\\*${rc}$`), "mul"],
    [new RegExp(`^${ra}=${rb}\\/${rc}$`), "div"],
    [new RegExp(`^${ra}=${rb}%${rc}$`), "mod"],
    [new RegExp(`^${ra}=${rb}\\+${c}$`), "add_k"],
    [new RegExp(`^${ra}=${rb}-${c}$`), "sub_k"],
    [new RegExp(`^${ra}=${rb}\\*${c}$`), "mul_k"],
    [new RegExp(`^${ra}=${rb}\\/${c}$`), "div_k"],
    [new RegExp(`^${ra}=${rb}%${c}$`), "mod_k"],
    [new RegExp(`^${ra}=${b}\\+${rc}$`), "add_kr"],
    [new RegExp(`^${ra}=${b}\\/${rc}$`), "div_kr"],
    [new RegExp(`^${ra}\\(\\)$`), "call0_noret"],
    [new RegExp(`^doreturn;end$`), "return_nil"],
    [new RegExp(`^doreturn${ra};end$`), "return_one"],
    [new RegExp(`^doreturn${ra}\\(\\);end$`), "return_call0"],
    [new RegExp(`^${pc}=${b}$`), "jmp"]
  ];

  for (const [pattern, kind] of exact) {
    if (pattern.test(text)) return { kind };
  }

  if (new RegExp(`(?:^|;)${ra}=${env}\\[${b}\\]$`).test(text)) return { kind: "getglobal" };
  if (new RegExp(`(?:^|;)${ra}=${upvalues}\\[${b}\\]$`).test(text)) return { kind: "getupvalue" };
  if (new RegExp(`(?:^|;)${ra}=${rb}\\[${c}\\]$`).test(text)) return { kind: "gettable_k" };
  if (new RegExp(`(?:^|;)${ra}=${rb}\\[${rc}\\]$`).test(text)) return { kind: "gettable_r" };

  let match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]=${r}\\[\\1\\]\\(\\)$`).exec(text);
  if (match) return { kind: "call0_assign1" };
  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]=${r}\\[\\1\\]\\(${r}\\[\\1\\+1\\]\\)$`).exec(text);
  if (match) return { kind: "call1_assign1" };
  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]\\(${r}\\[\\1\\+1\\]\\)$`).exec(text);
  if (match) return { kind: "call1_noret" };

  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]=${r}\\[\\1\\]\\([A-Za-z_][A-Za-z0-9_]*\\(${r},\\1\\+1,${b}\\)\\)$`).exec(text);
  if (match) return { kind: "call_b_assign1" };
  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]\\([A-Za-z_][A-Za-z0-9_]*\\(${r},\\1\\+1,${b}\\)\\)$`).exec(text);
  if (match) return { kind: "call_b_noret" };
  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]=${r}\\[\\1\\]\\([A-Za-z_][A-Za-z0-9_]*\\(${r},\\1\\+1,${top}\\)\\)$`).exec(text);
  if (match) return { kind: "call_var_assign1" };
  match = new RegExp(`^(?:local)?${temp}=${a};${r}\\[\\1\\]\\([A-Za-z_][A-Za-z0-9_]*\\(${r},\\1\\+1,${top}\\)\\)$`).exec(text);
  if (match) return { kind: "call_var_noret" };

  match = new RegExp(`^(?:local)?${temp}=${a};(?:local)?([A-Za-z_][A-Za-z0-9_]*)=${rb};${r}\\[\\1\\+1\\]=\\2;${r}\\[\\1\\]=\\2\\[${c}\\]$`).exec(text);
  if (match) return { kind: "self_k" };
  match = new RegExp(`^(?:local)?${temp}=${a};(?:local)?([A-Za-z_][A-Za-z0-9_]*)=${rb};${r}\\[\\1\\+1\\]=\\2;${r}\\[\\1\\]=\\2\\[${rc}\\]$`).exec(text);
  if (match) return { kind: "self_r" };
  if (
    new RegExp(`${temp}=${a};${temp}=${rb};${r}\\[\\1\\+1\\]=\\2;${r}\\[\\1\\]=\\2\\[${c}\\]$`).test(text)
  ) {
    return { kind: "self_k" };
  }

  if (new RegExp(`${factory}\\(${children}\\[${b}\\]`).test(text)) return { kind: "closure" };
  if (
    text.includes(`${factory}(`) &&
    text.includes(`${pc}=${pc}+1`) &&
    text.includes(`${runtime.instructionArrayName}[${pc}]`)
  ) {
    return { kind: "closure" };
  }

  if (text.includes(`for`) && new RegExp(`${r}\\[[A-Za-z_][A-Za-z0-9_]*\\]=nil`).test(text)) {
    return { kind: "loadnil" };
  }

  if (
    text.includes("..") &&
    new RegExp(`${ra}=[A-Za-z_][A-Za-z0-9_]*$`).test(text)
  ) {
    return { kind: "concat" };
  }

  if (text.includes(`${runtime.openUpvaluesName ?? ""}`) && text.includes(`>=${a}`)) {
    return { kind: "close" };
  }

  if (text.includes(`doreturn`) && text.includes(`${top}`)) return { kind: "return_varargs" };
  if (
    new RegExp(`doreturn${r}\\[[A-Za-z_][A-Za-z0-9_]*\\]\\([A-Za-z_][A-Za-z0-9_]*\\(${r},[A-Za-z_][A-Za-z0-9_]*\\+1,${b}\\)\\);end`).test(text)
  ) {
    return { kind: "return_call_b" };
  }
  if (text.includes(`doreturn`) && text.includes(`${b}`) && text.includes(`${r}`)) return { kind: "return_range" };

  if (
    text.includes(`{${r}[`) &&
    text.includes(`${runtime.pcName}=${runtime.instructionName}[3]`) &&
    text.includes(`${runtime.pcName}=${runtime.pcName}+1`) &&
    text.includes("for")
  ) {
    return { kind: "tforloop" };
  }

  if (text.includes(`${top}=`) && text.includes(`${r}`) && text.includes("for")) {
    if (text.includes(`${b}`)) return { kind: "call_b_multiret" };
    return { kind: "call1_multiret" };
  }

  if (text.includes(`{${r}[`) && text.includes(`for`) && text.includes(`${c}`)) {
    if (text.includes(`${top}`)) return { kind: "call_var_results" };
    if (text.includes(`${b}`)) return { kind: "call_b_results" };
    return { kind: "call1_results" };
  }

  if (
    text.includes(`{${r}[`) &&
    text.includes("for") &&
    text.includes(`${i}[4]`)
  ) {
    if (text.includes(`${top}`)) return { kind: "call_var_results" };
    if (text.includes(`${b}`)) return { kind: "call_b_results" };
    return { kind: "call1_results" };
  }

  if (
    new RegExp(`(?:local)?${temp}=${a};(?:local)?${temp}=${r}\\[\\1\\];for[A-Za-z_][A-Za-z0-9_]*=\\1\\+1,${top}do`).test(text)
  ) {
    return { kind: "append_varargs" };
  }

  if (
    text.includes("for") &&
    new RegExp(`${temp}=${a}`).test(text) &&
    new RegExp(`${temp}=${r}\\[[A-Za-z_][A-Za-z0-9_]*\\]`).test(text) &&
    new RegExp(`${temp}=${b}`).test(text) &&
    text.includes(`${r}[`)
  ) {
    return { kind: "setlist" };
  }

  if (
    text.includes(`for`) &&
    text.includes(`${r}[`) &&
    text.includes(`${a}`) &&
    text.includes(`${b}`)
  ) {
    return { kind: "setlist" };
  }

  if (
    text.includes(`#`) &&
    text.includes(`>=`) &&
    text.includes(`${r}`) &&
    text.includes(`[1]=`)
  ) {
    return { kind: "close" };
  }

  if (
    text.includes(`${r}[`) &&
    text.includes("+2]") &&
    text.includes("+1]") &&
    text.includes("+3]") &&
    text.includes(`${runtime.pcName}=${runtime.instructionName}[3]`)
  ) {
    return { kind: text.includes(`]+`) ? "forloop" : "forprep" };
  }

  if (
    new RegExp(`^(?:local)?${temp}=${rc};ifnot\\1then`).test(text) &&
    text.includes(`${runtime.pcName}=${runtime.pcName}+1`) &&
    text.includes(`${runtime.registersName}[${runtime.instructionName}[2]]=`) &&
    text.includes(`${runtime.pcName}=${runtime.instructionName}[3]`)
  ) {
    return { kind: "testset_truthy" };
  }

  if (
    new RegExp(`^(?:local)?${temp}=${rc};if\\1then`).test(text) &&
    text.includes(`${runtime.pcName}=${runtime.pcName}+1`) &&
    text.includes(`${runtime.registersName}[${runtime.instructionName}[2]]=`) &&
    text.includes(`${runtime.pcName}=${runtime.instructionName}[3]`)
  ) {
    return { kind: "testset_falsy" };
  }

  if (
    text.includes(`for`) &&
    text.includes(`${runtime.instructionName}[3]do`) &&
    text.includes(`${runtime.registersName}[`) &&
    text.includes(`+1`) &&
    text.includes("(")
  ) {
    return { kind: "setlist_range" };
  }

  if (new RegExp(`^${ra}=${b}\\/${c}$`).test(text)) return { kind: "div_kk" };

  return {
    kind: "unknown",
    handler: text
  };
}

export function classifySuperinstructionHandlers(analysis) {
  for (const handler of analysis.handlers.values()) {
    handler.microOps = handler.segments.map((segment) => classifySegment(analysis, segment));
  }
  return analysis;
}

function cloneExpandedProto(proto, analysis) {
  const instructions = [];
  let index = 0;

  while (index < proto.instructions.length) {
    const instruction = proto.instructions[index];
    if (instruction.skipped) {
      instructions.push({ ...instruction, kind: "skipped" });
      index += 1;
      continue;
    }

    const handler = analysis.handlers.get(instruction.op);
    if (!handler?.microOps) {
      instructions.push({ ...instruction, kind: "unknown", superOpcode: instruction.op });
      index += 1;
      continue;
    }

    for (let offset = 0; offset < handler.microOps.length && index + offset < proto.instructions.length; offset += 1) {
      const consumed = proto.instructions[index + offset];
      const microOp = handler.microOps[offset];
      const captures = microOp.kind === "closure" && typeof consumed.c === "number"
        ? proto.instructions.slice(index + offset + 1, index + offset + 1 + consumed.c).map((marker) => ({
          source: marker.op === 19 ? "register" : "upvalue",
          index: marker.b
        }))
        : undefined;
      instructions.push({
        ...consumed,
        ...microOp,
        pc: consumed.pc,
        superPc: instruction.pc,
        superOpcode: instruction.op,
        superOffset: offset,
        ...(captures ? { captures } : {})
      });
    }

    const firstKind = handler.microOps[0]?.kind;
    const consumed = firstKind === "closure" && typeof instruction.c === "number"
      ? Math.max(handler.microOps.length, instruction.c + 1)
      : handler.microOps.length;
    index += Math.max(1, consumed);
  }

  return {
    ...proto,
    instructions,
    protos: proto.protos.map((child) => cloneExpandedProto(child, analysis))
  };
}

export function expandSuperinstructionProto(proto, analysis) {
  classifySuperinstructionHandlers(analysis);
  return cloneExpandedProto(proto, analysis);
}
