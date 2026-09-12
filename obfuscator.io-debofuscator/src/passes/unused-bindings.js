const { analyzeBindings } = require('../core/bindings');
const { walk } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');
const { evaluate } = require('../core/evaluate');

function pure(node) {
  if (!node) return true;
  if (['Literal', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return true;
  if (node.type === 'Identifier') return ['undefined', 'NaN', 'Infinity'].includes(node.name);
  if (node.type === 'ArrayExpression') return node.elements.every(el => !el || pure(el));
  if (node.type === 'ObjectExpression') {
    return node.properties.every(p => p.type === 'Property' && p.kind === 'init' && !p.computed && !p.method && pure(p.value));
  }
  if (node.type === 'UnaryExpression') return pure(node.argument);
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return pure(node.left) && pure(node.right);
  if (node.type === 'ConditionalExpression') return pure(node.test) && pure(node.consequent) && pure(node.alternate);
  if (node.type === 'TemplateLiteral') return node.expressions.every(pure);
  if (['CallExpression', 'MemberExpression'].includes(node.type)) return evaluate(node).confident;
  return false;
}

function run(source, ast) {
  const analysis = analyzeBindings(ast);
  const edits = [];
  const declParent = new WeakMap();
  walk(ast, { enter({ node, parent }) {
    if (node.type === 'VariableDeclarator' && parent?.type === 'VariableDeclaration') declParent.set(node, parent);
  }});

  // Only remove entire declarations here. Splitting mixed declarations safely is a
  // separate transformation; this pass is deliberately conservative and is used as
  // final polish after all inlining/dead-branch passes have settled.
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration' || !st.declarations.length) continue;
    let removable = true;
    for (const d of st.declarations) {
      if (d.id.type !== 'Identifier' || !pure(d.init)) { removable = false; break; }
      const binding = analysis.bindingForIdentifier.get(d.id);
      if (!binding || binding.refs.length !== 0) { removable = false; break; }
    }
    if (removable) edits.push({ start: st.start, end: st.end, text: '' });
  }

  // Also remove unused pure declarations inside blocks/functions, but never function
  // declarations or imports: those can be framework/public entry points even without
  // lexical references in this file.
  const seenDecl = new Set();
  for (const binding of analysis.bindings) {
    if (binding.refs.length !== 0) continue;
    for (const decl of binding.declarations) {
      if (!decl || decl.type !== 'VariableDeclarator' || seenDecl.has(decl)) continue;
      const parent = declParent.get(decl);
      if (!parent || parent.declarations.length !== 1 || !pure(decl.init)) continue;
      seenDecl.add(decl);
      edits.push({ start: parent.start, end: parent.end, text: '' });
    }
  }

  const result = applyEdits(source, selectOutermost(edits));
  return { code: result.code, changes: result.applied };
}

module.exports = { name: 'unused-bindings', run, pure };
