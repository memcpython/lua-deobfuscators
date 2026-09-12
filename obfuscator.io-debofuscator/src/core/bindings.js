const { isReferenceIdentifier } = require('./ast');

class Scope {
  constructor(type, parent = null) {
    this.type = type;
    this.parent = parent;
    this.bindings = new Map();
  }
}

function isNode(value) {
  return !!value && typeof value === 'object' && typeof value.type === 'string';
}

function childNodes(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'raw') continue;
    if (isNode(value)) out.push([key, null, value]);
    else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (isNode(value[i])) out.push([key, i, value[i]]);
    }
  }
  return out;
}

function nearestVarScope(scope) {
  let cur = scope;
  while (cur && cur.type !== 'function' && cur.type !== 'program') cur = cur.parent;
  return cur || scope;
}

function analyzeBindings(ast) {
  const root = new Scope('program', null);
  const scopeForNode = new WeakMap();
  const bindingForIdentifier = new WeakMap();
  const bindings = [];

  function declare(scope, id, kind, declaration = null) {
    if (!id || id.type !== 'Identifier') return null;
    let binding = scope.bindings.get(id.name);
    if (!binding) {
      binding = { name: id.name, kind, scope, ids: [], refs: [], declarations: [], first: id.start };
      scope.bindings.set(id.name, binding);
      bindings.push(binding);
    }
    binding.ids.push(id);
    binding.declarations.push(declaration);
    binding.first = Math.min(binding.first, id.start);
    bindingForIdentifier.set(id, binding);
    return binding;
  }

  function declarePattern(scope, pattern, kind, declaration = null) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') return void declare(scope, pattern, kind, declaration);
    if (pattern.type === 'RestElement') return declarePattern(scope, pattern.argument, kind, declaration);
    if (pattern.type === 'AssignmentPattern') return declarePattern(scope, pattern.left, kind, declaration);
    if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el) declarePattern(scope, el, kind, declaration);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const p of pattern.properties) {
        if (p.type === 'RestElement') declarePattern(scope, p.argument, kind, declaration);
        else declarePattern(scope, p.value, kind, declaration);
      }
    }
  }

  function build(node, scope, parent = null, key = null, index = null, functionBody = false) {
    if (!node) return;
    scopeForNode.set(node, scope);

    if (node.type === 'Program') {
      for (const st of node.body) build(st, root, node, 'body');
      return;
    }

    if (node.type === 'FunctionDeclaration') {
      if (node.id) declare(scope, node.id, 'function', node);
      const fnScope = new Scope('function', scope);
      scopeForNode.set(node, fnScope);
      for (const p of node.params) {
        declarePattern(fnScope, p, 'param', node);
        // Defaults in patterns can reference surrounding/earlier params. Generic walk
        // below is intentionally skipped for declaration identifiers and picked up in
        // the reference pass.
      }
      if (node.body?.type === 'BlockStatement') {
        scopeForNode.set(node.body, fnScope);
        for (const st of node.body.body) build(st, fnScope, node.body, 'body');
      } else if (node.body) build(node.body, fnScope, node, 'body');
      return;
    }

    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const fnScope = new Scope('function', scope);
      scopeForNode.set(node, fnScope);
      if (node.type === 'FunctionExpression' && node.id) declare(fnScope, node.id, 'function-name', node);
      for (const p of node.params) declarePattern(fnScope, p, 'param', node);
      if (node.body?.type === 'BlockStatement') {
        scopeForNode.set(node.body, fnScope);
        for (const st of node.body.body) build(st, fnScope, node.body, 'body');
      } else if (node.body) build(node.body, fnScope, node, 'body');
      return;
    }

    if (node.type === 'BlockStatement' && !functionBody) {
      const blockScope = new Scope('block', scope);
      scopeForNode.set(node, blockScope);
      for (const st of node.body) build(st, blockScope, node, 'body');
      return;
    }

    if (node.type === 'CatchClause') {
      const catchScope = new Scope('block', scope);
      scopeForNode.set(node, catchScope);
      if (node.param) declarePattern(catchScope, node.param, 'catch', node);
      if (node.body?.type === 'BlockStatement') {
        scopeForNode.set(node.body, catchScope);
        for (const st of node.body.body) build(st, catchScope, node.body, 'body');
      }
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const targetScope = node.kind === 'var' ? nearestVarScope(scope) : scope;
      for (const d of node.declarations) {
        declarePattern(targetScope, d.id, node.kind, d);
        if (d.init) build(d.init, scope, d, 'init');
      }
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id) declare(scope, node.id, 'class', node);
    if (node.type === 'ImportDeclaration') {
      for (const sp of node.specifiers || []) if (sp.local) declare(scope, sp.local, 'import', sp);
    }

    for (const [childKey, childIndex, child] of childNodes(node)) {
      // Declaration identifiers are already handled above and should not be walked as refs.
      if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && childKey === 'id') continue;
      if (node.type === 'ImportDeclaration' && childKey === 'specifiers') continue;
      build(child, scope, node, childKey, childIndex);
    }
  }

  build(ast, root);

  function resolve(scope, name) {
    for (let cur = scope; cur; cur = cur.parent) {
      const b = cur.bindings.get(name);
      if (b) return b;
    }
    return null;
  }

  function refs(node, scope, parent = null, key = null, index = null) {
    if (!node) return;
    const effective = scopeForNode.get(node) || scope;

    if (node.type === 'Identifier') {
      const declared = bindingForIdentifier.get(node);
      if (declared) return;
      if (isReferenceIdentifier(node, parent, key)) {
        const binding = resolve(effective, node.name);
        if (binding) {
          binding.refs.push(node);
          bindingForIdentifier.set(node, binding);
        }
      }
      return;
    }

    // Every relevant child already has its effective lexical scope recorded by build().
    for (const [childKey, childIndex, child] of childNodes(node)) refs(child, effective, node, childKey, childIndex);
  }

  refs(ast, root);
  bindings.sort((a, b) => a.first - b.first);
  return { root, bindings, bindingForIdentifier, scopeForNode };
}

module.exports = { Scope, analyzeBindings };
