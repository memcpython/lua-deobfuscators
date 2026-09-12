const { walk, sourceOf, isReferenceIdentifier } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');

function signatures(text) {
  const s = text.replace(/\s+/g, ' ');
  return {
    selfDefRegex: s.includes('(((.+)+)+)+$'),
    functionRegex: s.includes('function *\\( *\\)') || s.includes('function *\\\\( *\\\\)'),
    incrementRegex: s.includes('\\+\\+ *(?:') || s.includes('\\\\+\\\\+ *(?:'),
    returnThis: s.includes('return this') && (s.includes('constructor') || s.includes('Function(')),
    consoleTrap: s.includes('console') && s.includes('__proto__') && s.includes('toString') && (s.includes('trace') || s.includes('exception')),
    stringInspection: s.includes('toString') && s.includes('search') && (s.includes('constructor') || s.includes('RegExp')),
    infiniteDebug: s.includes('while (true) {}') || s.includes('while(true){}'),
    timer: s.includes('setInterval') || s.includes('setTimeout'),
    counter: s.includes('counter')
  };
}

function strongSignature(text) {
  const s = signatures(text);
  return s.selfDefRegex || s.consoleTrap || s.infiniteDebug ||
    (s.functionRegex && s.incrementRegex) ||
    (s.stringInspection && (s.returnThis || s.selfDefRegex));
}

function isDirectIifeStatement(st) {
  if (st.type !== 'ExpressionStatement') return false;
  const e = st.expression;
  return e?.type === 'CallExpression' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(e.callee?.type);
}

function declaredNames(st) {
  const out = new Set();
  if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) if (d.id?.type === 'Identifier') out.add(d.id.name);
  } else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) out.add(st.id.name);
  return out;
}

function referenceNames(st) {
  const out = new Set();
  walk(st, { enter({ node, parent, key }) {
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, key)) out.add(node.name);
  }});
  return out;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function directDebugHelper(st, source) {
  if (st.type !== 'FunctionDeclaration' || !st.id || st.end - st.start > 4500) return false;
  const sig = signatures(sourceOf(st, source));
  if (!(sig.infiniteDebug && sig.counter)) return false;
  // The generated debug-protection helper is essentially a nested constructor loop
  // plus a try/catch dispatcher. Require the distinctive constructor loop itself.
  return sourceOf(st, source).includes('.constructor') || sourceOf(st, source).includes('constructor(');
}

function dedicatedTimerIife(st, source) {
  if (!isDirectIifeStatement(st) || st.end - st.start > 7000) return false;
  const sig = signatures(sourceOf(st, source));
  return sig.timer && sig.returnThis;
}

function processBlock(block, source, edits, ctx) {
  const body = block.type === 'Program' ? block.body : block.body;
  if (!Array.isArray(body) || !body.length) return;
  const info = body.map(st => ({
    st,
    decl: declaredNames(st),
    refs: referenceNames(st),
    seed: false,
    tainted: false
  }));

  for (const item of info) {
    const { st } = item;
    if (directDebugHelper(st, source)) {
      item.seed = item.tainted = true;
      if (st.id) ctx.scaffoldNames.add(st.id.name);
      continue;
    }
    if (dedicatedTimerIife(st, source)) {
      item.seed = item.tainted = true;
      continue;
    }
    if (st.type === 'VariableDeclaration' && strongSignature(sourceOf(st, source))) {
      // A dictionary/object declarator can contain real methods alongside injected
      // guards (e.g. calculator.add). Do not delete a mixed object container as a
      // unit; its function bodies are processed independently.
      const mixedObject = st.declarations.some(d => d.init?.type === 'ObjectExpression');
      if (!mixedObject) item.seed = item.tainted = true;
      continue;
    }
    // A direct outer IIFE can contain both the obfuscator scaffold and the actual
    // program. Never classify the whole thing from descendant strings; its own
    // BlockStatement is handled independently below.
    if (st.type === 'ExpressionStatement' && !isDirectIifeStatement(st) && strongSignature(sourceOf(st, source))) {
      item.seed = item.tainted = true;
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const taintedDecl = new Set();
    for (const x of info) if (x.tainted) for (const n of x.decl) taintedDecl.add(n);

    for (const item of info) {
      if (item.tainted) continue;
      // Providers used exclusively by an anti-tamper statement are part of the
      // scaffold (one-shot wrapper factories are the common case).
      const providesTainted = item.decl.size && info.some(t => t.tainted && intersects(item.decl, t.refs));
      // Side-effect-only consumers of tainted scaffold variables are also scaffold.
      const consumesTainted = item.st.type === 'ExpressionStatement' && !isDirectIifeStatement(item.st) && intersects(item.refs, taintedDecl);
      if (providesTainted || consumesTainted) {
        item.tainted = true;
        changed = true;
      }
    }
  }

  // Do not remove a declaration if an untainted statement still consumes it.
  // This is the semantic guard that prevents mixed business/scaffold declarations
  // from turning into missing-variable errors.
  for (const item of info) {
    if (!item.tainted || item.decl.size === 0) continue;
    const externallyUsed = info.some(other => !other.tainted && intersects(item.decl, other.refs));
    if (externallyUsed && !directDebugHelper(item.st, source)) item.tainted = false;
  }

  // Re-evaluate expression consumers after protected declarations are restored.
  const survivingDecl = new Set();
  for (const item of info) if (item.tainted) for (const n of item.decl) survivingDecl.add(n);
  for (const item of info) {
    if (!item.tainted) continue;
    if (item.st.type === 'ExpressionStatement' && !item.seed && !intersects(item.refs, survivingDecl)) item.tainted = false;
  }

  for (const item of info) if (item.tainted) edits.push({ start: item.st.start, end: item.st.end, text: '' });
}

function run(source, ast, ctx = {}) {
  if (!ctx.scaffoldNames) ctx.scaffoldNames = new Set();
  const edits = [];
  // Process every lexical statement list independently. This lets us remove an
  // injected prefix inside a real function/IIFE without deleting that function/IIFE.
  walk(ast, { enter({ node }) {
    if (node.type === 'Program' || node.type === 'BlockStatement') processBlock(node, source, edits, ctx);
  }});
  const selected = selectOutermost(edits);
  const r = applyEdits(source, selected);
  return { code: r.code, changes: r.applied };
}

module.exports = { name: 'anti-tamper', run };
