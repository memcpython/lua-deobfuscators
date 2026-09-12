const { walk } = require('../core/ast');
const { applyEdits } = require('../core/edits');
const { analyzeBindings } = require('../core/bindings');

const OBF = /^_0x[0-9a-f]+$/i;

function run(source, ast, ctx = {}) {
  if (ctx.options?.rename === false) return { code: source, changes: 0 };

  const analysis = analyzeBindings(ast);
  const blocked = new Set();

  // Renaming a shorthand value would also rename the property key (`{x}`), which
  // changes observable object shape. Leave that binding alone instead of guessing.
  walk(ast, { enter({ node }) {
    if (node.type !== 'Property' || !node.shorthand || node.value?.type !== 'Identifier') return;
    const b = analysis.bindingForIdentifier.get(node.value);
    if (b) blocked.add(b);
  }});

  let counter = 0;
  const renamed = new Map();
  for (const binding of analysis.bindings) {
    if (!OBF.test(binding.name) || blocked.has(binding)) continue;
    renamed.set(binding, `L_${++counter}`);
  }

  const edits = [];
  for (const [binding, next] of renamed) {
    for (const id of binding.ids) edits.push({ start: id.start, end: id.end, text: next });
    for (const ref of binding.refs) edits.push({ start: ref.start, end: ref.end, text: next });
  }
  const result = applyEdits(source, edits);
  return {
    code: result.code,
    changes: result.applied,
    details: {
      renamed: [...renamed].map(([b, name]) => ({ from: b.name, to: name, references: b.refs.length }))
    }
  };
}

module.exports = { name: 'rename-obfuscated', run };
