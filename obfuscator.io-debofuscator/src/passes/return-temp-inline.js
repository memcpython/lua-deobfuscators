const { walk, sourceOf, isReferenceIdentifier } = require('../core/ast');
const { applyEdits } = require('../core/edits');

function referencesName(node, name) {
  let found = false;
  walk(node, { enter({ node: n, parent, key }) {
    if (n.type === 'Identifier' && n.name === name && isReferenceIdentifier(n, parent, key)) found = true;
  }});
  return found;
}

function run(source, ast) {
  const edits = [];
  walk(ast, { enter({ node }) {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    if (node.body?.type !== 'BlockStatement') return;
    const body = node.body.body;
    for (let i = 0; i + 1 < body.length; i++) {
      const decl = body[i], ret = body[i + 1];
      if (decl.type !== 'VariableDeclaration' || decl.declarations.length !== 1 || ret.type !== 'ReturnStatement') continue;
      const d = decl.declarations[0];
      if (d.id?.type !== 'Identifier' || !d.init || ret.argument?.type !== 'Identifier' || ret.argument.name !== d.id.name) continue;
      if (referencesName(d.init, d.id.name)) continue;
      edits.push({ start: decl.start, end: ret.end, text: `return ${sourceOf(d.init, source)};` });
      i++;
    }
  }});
  const r = applyEdits(source, edits);
  return { code: r.code, changes: r.applied };
}

module.exports = { name: 'return-temp-inline', run };
