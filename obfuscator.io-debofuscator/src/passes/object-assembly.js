const { walk, sourceOf, propertyName } = require('../core/ast');
const { applyEdits } = require('../core/edits');

function referencesName(node, name) {
  let found = false;
  walk(node, { enter({ node: n, parent, key }) {
    if (found || n.type !== 'Identifier' || n.name !== name) return;
    if (parent?.type === 'Property' && key === 'key' && !parent.computed) return;
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    found = true;
  }});
  return found;
}

function assignmentFor(statement, name) {
  if (statement?.type !== 'ExpressionStatement') return null;
  const e = statement.expression;
  if (e?.type !== 'AssignmentExpression' || e.operator !== '=' || e.left?.type !== 'MemberExpression') return null;
  if (e.left.object?.type !== 'Identifier' || e.left.object.name !== name || e.left.optional) return null;
  let key;
  if (!e.left.computed && e.left.property?.type === 'Identifier') key = e.left.property.name;
  else if (e.left.computed && e.left.property?.type === 'Literal' && ['string', 'number'].includes(typeof e.left.property.value)) key = e.left.property.value;
  else return null;
  if (String(key) === '__proto__') return null;
  if (referencesName(e.right, name)) return null;
  return { key, value: e.right };
}

function keyCode(key) {
  const s = String(key);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) return s;
  if (typeof key === 'number') return String(key);
  return JSON.stringify(s);
}

function statementLists(ast) {
  const lists = [ast.body];
  walk(ast, { enter({ node }) {
    if (node.type === 'BlockStatement') lists.push(node.body);
    if (node.type === 'SwitchCase') lists.push(node.consequent);
  }});
  return lists;
}

function run(source, ast) {
  const edits = [];
  for (const list of statementLists(ast)) {
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (st?.type !== 'VariableDeclaration' || st.declarations.length !== 1) continue;
      const d = st.declarations[0];
      if (d.id?.type !== 'Identifier' || d.init?.type !== 'ObjectExpression' || d.init.properties.length !== 0) continue;
      const props = [];
      let j = i + 1;
      for (; j < list.length; j++) {
        const a = assignmentFor(list[j], d.id.name);
        if (!a) break;
        props.push(a);
      }
      if (!props.length) continue;
      const body = props.map(p => `${keyCode(p.key)}: ${sourceOf(p.value, source)}`).join(', ');
      edits.push({ start: d.init.start, end: d.init.end, text: `{ ${body} }` });
      for (let k = i + 1; k < j; k++) edits.push({ start: list[k].start, end: list[k].end, text: '' });
      i = j - 1;
    }
  }
  const r = applyEdits(source, edits);
  return { code: r.code, changes: r.applied };
}

module.exports = { name: 'object-assembly', run };
