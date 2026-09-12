const { walk, sourceOf } = require('../core/ast');
const { applyEdits } = require('../core/edits');

function run(source, ast) {
  const edits = [];
  walk(ast, { enter({ node, parent, key }) {
    if (node.type !== 'VariableDeclaration' || node.declarations.length < 2) return;
    if (parent && (
      (parent.type === 'ForStatement' && key === 'init') ||
      ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left')
    )) return;
    const parts = node.declarations.map(d => `${node.kind} ${sourceOf(d, source)};`);
    edits.push({ start: node.start, end: node.end, text: parts.join('\n') });
  }});
  const r = applyEdits(source, edits);
  return { code: r.code, changes: r.applied };
}

module.exports = { name: 'declaration-split', run };
