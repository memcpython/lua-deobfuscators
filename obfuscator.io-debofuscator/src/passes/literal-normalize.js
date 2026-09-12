const { walk, literalToCode } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');

function run(source, ast) {
  const edits = [];
  walk(ast, { enter({ node }) {
    if (node.type !== 'Literal' || node.regex) return;
    const code = literalToCode(node.value);
    if (code == null) return;
    const raw = source.slice(node.start, node.end);
    if (raw === code) return;
    // Keep directive prologues semantically identical; changing quote style is fine,
    // but never rewrite a literal if it contains a legacy octal escape in strict code.
    if (/\\[0-7]{1,3}/.test(raw) && typeof node.value === 'string') return;
    edits.push({ start: node.start, end: node.end, text: code });
  }});
  const r = applyEdits(source, selectOutermost(edits));
  return { code: r.code, changes: r.applied };
}

module.exports = { name: 'literal-normalize', run };
