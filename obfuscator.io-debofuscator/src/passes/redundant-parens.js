const acorn = require('acorn');
const { walk } = require('../core/ast');
const { applyEdits } = require('../core/edits');

const SAFE = new Set(['Identifier', 'Literal', 'ThisExpression', 'Super', 'MemberExpression', 'CallExpression', 'ChainExpression', 'AwaitExpression', 'YieldExpression']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function tokens(source) {
  for (const sourceType of ['script', 'module']) {
    try { return [...acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true })]; }
    catch (_) {}
  }
  return null;
}

function raw(source, t) { return source.slice(t.start, t.end); }

function parenPairs(ts, source) {
  const stack = [], match = new Map();
  for (let i = 0; i < ts.length; i++) {
    const r = raw(source, ts[i]);
    if (r === '(') stack.push(i);
    else if (r === ')' && stack.length) {
      const j = stack.pop(); match.set(j, i); match.set(i, j);
    }
  }
  return match;
}

function tokenEndingAtOrBefore(ts, pos) {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m].end <= pos) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

function tokenStartingAtOrAfter(ts, pos) {
  let lo = 0, hi = ts.length - 1, ans = ts.length;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m].start >= pos) { ans = m; hi = m - 1; } else lo = m + 1;
  }
  return ans;
}

function isCallOrControlDelimiter(ts, source, openIndex, closeIndex) {
  const beforeToken = openIndex > 0 ? ts[openIndex - 1] : null;
  const before = beforeToken ? raw(source, beforeToken) : '';
  const after = closeIndex + 1 < ts.length ? raw(source, ts[closeIndex + 1]) : '';
  if (CONTROL.has(before) || before === 'function' || before === 'new' || before === 'import') return true;
  if (after === '=>') return true;
  // If the token immediately before '(' can be a callee/tag, these parentheses are
  // call syntax rather than grouping syntax.
  if (before && ((beforeToken?.type?.label === 'name' && !['await', 'yield', 'return', 'throw', 'typeof', 'void', 'delete'].includes(before)) || /^[0-9'"`]/.test(before) || [')', ']', '}', '++', '--'].includes(before))) return true;
  return false;
}

function runOnce(source, ast) {
  const ts = tokens(source); if (!ts) return { code: source, changes: 0 };
  const pairs = parenPairs(ts, source);
  const edits = [];
  walk(ast, { enter({ node, parent, key }) {
    const safeContext = (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && parent && (
      (parent.type === 'ReturnStatement' && key === 'argument') ||
      (parent.type === 'VariableDeclarator' && key === 'init') ||
      (parent.type === 'AssignmentExpression' && key === 'right') ||
      (parent.type === 'ArrayExpression') ||
      (parent.type === 'CallExpression' && key === 'arguments')
    );
    if (!SAFE.has(node.type) && !safeContext) return;
    if (node.type === 'CallExpression' && ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.callee?.type)) return;
    const li = tokenEndingAtOrBefore(ts, node.start);
    const ri = tokenStartingAtOrAfter(ts, node.end);
    if (li < 0 || ri >= ts.length) return;
    if (raw(source, ts[li]) !== '(' || raw(source, ts[ri]) !== ')') return;
    if (pairs.get(li) !== ri) return;
    if (isCallOrControlDelimiter(ts, source, li, ri)) return;
    edits.push({ start: ts[li].start, end: ts[li].end, text: '' });
    edits.push({ start: ts[ri].start, end: ts[ri].end, text: '' });
  }});
  const r = applyEdits(source, edits);
  return { code: r.code, changes: r.applied / 2 };
}

function run(source, ast) {
  // One layer per invocation. The deobfuscator calls this in a short final fixpoint,
  // which avoids overlapping parenthesis edits while still removing deep nesting.
  return runOnce(source, ast);
}

module.exports = { name: 'redundant-parens', run };
