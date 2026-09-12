const acorn = require('acorn');

function parse(source) {
  const common = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true
  };
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return acorn.parse(source, { ...common, sourceType });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function isNode(value) {
  return !!value && typeof value === 'object' && typeof value.type === 'string' && Number.isInteger(value.start) && Number.isInteger(value.end);
}

function walk(root, visitor) {
  const stack = [{ node: root, parent: null, key: null, index: null, ancestors: [] }];
  while (stack.length) {
    const path = stack.pop();
    if (!path || !isNode(path.node)) continue;
    if (visitor.enter && visitor.enter(path) === false) continue;
    const { node } = path;
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'raw') continue;
      if (isNode(value)) {
        children.push({ node: value, parent: node, key, index: null, ancestors: path.ancestors.concat(node) });
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (isNode(value[i])) children.push({ node: value[i], parent: node, key, index: i, ancestors: path.ancestors.concat(node) });
        }
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    if (visitor.leave) visitor.leave(path);
  }
}

function collect(root, predicate) {
  const out = [];
  walk(root, { enter(path) { if (predicate(path.node, path)) out.push(path); } });
  return out;
}

function sourceOf(node, source) {
  return source.slice(node.start, node.end);
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function isLiteralNode(node) {
  return node && node.type === 'Literal' && !(node.regex);
}

function literalToCode(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return null;
}

function isReferenceIdentifier(node, parent, key) {
  if (!node || node.type !== 'Identifier') return false;
  if (!parent) return true;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') && (key === 'id' || key === 'params')) return false;
  if (parent.type === 'VariableDeclarator' && key === 'id') return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'Property' || parent.type === 'MethodDefinition') && key === 'property' && !parent.computed) return false;
  if (parent.type === 'Property' && key === 'key' && !parent.computed) return false;
  if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label') return false;
  if (parent.type === 'CatchClause' && key === 'param') return false;
  if (parent.type === 'ClassDeclaration' && key === 'id') return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return false;
  return true;
}

function countIdentifierReferences(ast) {
  const counts = new Map();
  walk(ast, { enter({ node, parent, key }) {
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, key)) {
      counts.set(node.name, (counts.get(node.name) || 0) + 1);
    }
  }});
  return counts;
}

module.exports = {
  parse,
  walk,
  collect,
  sourceOf,
  propertyName,
  isLiteralNode,
  literalToCode,
  isReferenceIdentifier,
  countIdentifierReferences
};
