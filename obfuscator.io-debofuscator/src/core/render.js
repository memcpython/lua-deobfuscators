const { walk, isReferenceIdentifier, sourceOf } = require('./ast');
const { applyEdits } = require('./edits');

function renderWithIdentifierSubstitutions(node, source, substitutions) {
  const base = sourceOf(node, source);
  const edits=[];
  walk(node, { enter({node:n,parent,key}) {
    if(n.type==='Identifier' && substitutions.has(n.name) && isReferenceIdentifier(n,parent,key)) {
      edits.push({start:n.start-node.start,end:n.end-node.start,text:`(${substitutions.get(n.name)})`});
    }
  }});
  return applyEdits(base,edits).code;
}

function memberAccess(objectCode, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))) return `${objectCode}.${key}`;
  return `${objectCode}[${JSON.stringify(String(key))}]`;
}

module.exports = { renderWithIdentifierSubstitutions, memberAccess };
