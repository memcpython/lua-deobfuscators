const acorn = require('acorn');
const { parse } = require('../core/ast');

function externalBeautify(source, options = {}) {
  try {
    const pkg = require('js-beautify');
    const beautify = pkg.js || pkg.js_beautify || pkg;
    if (typeof beautify !== 'function') return null;
    const out = beautify(source, {
      indent_size: options.indentSize || 2,
      indent_char: ' ',
      preserve_newlines: true,
      max_preserve_newlines: 2,
      space_in_paren: false,
      space_in_empty_paren: false,
      jslint_happy: false,
      brace_style: 'collapse',
      keep_array_indentation: false,
      break_chained_methods: false,
      end_with_newline: true,
      wrap_line_length: 120,
      e4x: true
    });
    try { parse(out); return out.endsWith('\n') ? out : out + '\n'; } catch (_) { return null; }
  } catch (_) { return null; }
}

const WORD = /^[A-Za-z0-9_$]/;
const END_WORD = /[A-Za-z0-9_$]$/;
const BINARY = new Set([
  '=', '==', '===', '!=', '!==', '+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=',
  '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '%=',
  '**=', '&&=', '||=', '??=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '=>', 'in',
  'instanceof', '?'
]);
const KEYWORD_SPACE = new Set([
  'const', 'let', 'var', 'return', 'throw', 'new', 'typeof', 'void', 'delete', 'function',
  'class', 'extends', 'else', 'case', 'default', 'import', 'export', 'from', 'yield', 'await'
]);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function tokenize(source) {
  const comments = [];
  const options = {
    ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
    onComment(block, text, start, end) { comments.push({ comment: true, block, text, start, end }); }
  };
  let tokens;
  try { tokens = [...acorn.tokenizer(source, options)]; }
  catch (_) {
    comments.length = 0;
    try { tokens = [...acorn.tokenizer(source, { ...options, sourceType: 'module' })]; }
    catch (_) { return null; }
  }
  return [...tokens.map(t => ({ ...t, comment: false })), ...comments].sort((a, b) => a.start - b.start || a.end - b.end);
}

function fallbackFormat(source, options = {}) {
  let shebang = '';
  if (source.startsWith('#!')) {
    const n = source.indexOf('\n');
    shebang = source.slice(0, n < 0 ? source.length : n) + '\n';
    source = n < 0 ? '' : source.slice(n + 1);
  }
  const items = tokenize(source);
  if (!items) return shebang + source;

  const indentUnit = ' '.repeat(options.indentSize || 2);
  let out = '', indent = 0, lineStart = true, parenDepth = 0, bracketDepth = 0;
  const forDepths = [];
  let prevRaw = '', pendingFor = false;

  const write = text => {
    if (!text) return;
    if (lineStart) { out += indentUnit.repeat(Math.max(0, indent)); lineStart = false; }
    out += text;
  };
  const trimSpace = () => { out = out.replace(/[ \t]+$/g, ''); };
  const space = () => { if (!lineStart && !/[ \n\t]$/.test(out)) out += ' '; };
  const newline = (force = false) => {
    trimSpace();
    if (force || !out.endsWith('\n')) out += '\n';
    lineStart = true;
  };

  function rawOf(item) {
    if (item.comment) return item.block ? `/*${item.text}*/` : `//${item.text}`;
    return source.slice(item.start, item.end);
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw = rawOf(item);
    const next = items[i + 1];
    const nextRaw = next ? rawOf(next) : '';

    if (item.comment) {
      if (!lineStart) space();
      write(raw);
      newline();
      prevRaw = raw;
      continue;
    }

    if (raw === '{') {
      if (!lineStart && !/[\s({[,:]$/.test(out)) space();
      write('{');
      indent++;
      newline();
      prevRaw = raw;
      continue;
    }
    if (raw === '}') {
      if (!lineStart) newline();
      indent = Math.max(0, indent - 1);
      write('}');
      if (['else', 'catch', 'finally'].includes(nextRaw)) space();
      else if (nextRaw && ![';', ',', ')', ']', '(', '.', '?.', ':'].includes(nextRaw)) newline();
      prevRaw = raw;
      continue;
    }

    if (raw === '(') {
      if (CONTROL.has(prevRaw)) space();
      write('(');
      parenDepth++;
      if (pendingFor) { forDepths.push(parenDepth); pendingFor = false; }
      prevRaw = raw;
      continue;
    }
    if (raw === ')') {
      trimSpace(); write(')');
      if (forDepths.at(-1) === parenDepth) forDepths.pop();
      parenDepth = Math.max(0, parenDepth - 1);
      prevRaw = raw;
      continue;
    }
    if (raw === '[') { write('['); bracketDepth++; prevRaw = raw; continue; }
    if (raw === ']') { trimSpace(); write(']'); bracketDepth = Math.max(0, bracketDepth - 1); prevRaw = raw; continue; }

    if (raw === ';') {
      trimSpace(); write(';');
      if (forDepths.length) space(); else newline();
      prevRaw = raw;
      continue;
    }
    if (raw === ',') { trimSpace(); write(','); space(); prevRaw = raw; continue; }
    if (raw === '.' || raw === '?.') { trimSpace(); write(raw); prevRaw = raw; continue; }
    if (raw === ':') { trimSpace(); write(':'); space(); prevRaw = raw; continue; }

    if (raw === '++' || raw === '--' || raw === '!' || raw === '~') {
      if ((raw === '++' || raw === '--') && END_WORD.test(out.slice(-1))) write(raw);
      else write(raw);
      prevRaw = raw;
      continue;
    }

    if (BINARY.has(raw)) { space(); write(raw); space(); prevRaw = raw; continue; }

    const last = out.slice(-1);
    if (!lineStart && END_WORD.test(last) && WORD.test(raw)) space();
    write(raw);
    if (raw === 'for') pendingFor = true;
    if (KEYWORD_SPACE.has(raw)) space();
    prevRaw = raw;
  }

  if (!lineStart) newline();
  const candidate = shebang + out.trimEnd() + '\n';
  try { parse(candidate); return candidate; } catch (_) { return shebang + source; }
}

function format(source, options = {}) {
  const external = externalBeautify(source, options);
  if (external) return external;
  return fallbackFormat(source, options);
}

module.exports = { format, fallbackFormat };
