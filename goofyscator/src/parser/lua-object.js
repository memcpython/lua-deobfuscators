import fs from 'node:fs';

function skipQuoted(s, i) {
  const q = s[i++];
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i++] === q) return i;
  }
  return i;
}
function longOpen(s, i) {
  if (s[i] !== '[') return null;
  let j = i + 1;
  while (s[j] === '=') j++;
  return s[j] === '[' ? { eq: j - i - 1, len: j - i + 1 } : null;
}
function skipLong(s, i) {
  const o = longOpen(s, i); if (!o) return i + 1;
  const close = ']' + '='.repeat(o.eq) + ']';
  const j = s.indexOf(close, i + o.len);
  return j < 0 ? s.length : j + close.length;
}
function skipComment(s, i) {
  if (!s.startsWith('--', i)) return i;
  const o = longOpen(s, i + 2);
  if (o) return skipLong(s, i + 2);
  const n = s.indexOf('\n', i + 2); return n < 0 ? s.length : n + 1;
}
export function findMatching(s, start, open = '{', close = '}') {
  let d = 0;
  for (let i = start; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipQuoted(s, i); continue; }
    if (c === '[' && longOpen(s, i)) { i = skipLong(s, i); continue; }
    if (s.startsWith('--', i)) { i = skipComment(s, i); continue; }
    if (c === open) d++;
    else if (c === close && --d === 0) return i;
    i++;
  }
  return -1;
}
export function splitTop(s, separator = ',') {
  const out = []; let start = 0; const stack = [];
  const pairs = { '(': ')', '{': '}', '[': ']' };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipQuoted(s, i); continue; }
    if (c === '[' && longOpen(s, i)) { i = skipLong(s, i); continue; }
    if (s.startsWith('--', i)) { i = skipComment(s, i); continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (stack.length && c === stack.at(-1)) stack.pop();
    else if (c === separator && stack.length === 0) { out.push(s.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(s.slice(start)); return out;
}
function topEquals(part) {
  const stack = []; const pairs = { '(': ')', '{': '}', '[': ']' };
  for (let i = 0; i < part.length;) {
    const c = part[i];
    if (c === '"' || c === "'") { i = skipQuoted(part, i); continue; }
    if (c === '[' && longOpen(part, i)) { i = skipLong(part, i); continue; }
    if (c === '[' || c === '(' || c === '{') stack.push(pairs[c]);
    else if (stack.length && c === stack.at(-1)) stack.pop();
    else if (c === '=' && stack.length === 0) return i;
    i++;
  }
  return -1;
}
function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
    if (/^\d+$/.test(e)) return String.fromCharCode(Number(e));
    if (/^x/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', a:'\x07', '\\':'\\', '"':'"', "'":"'" })[e] ?? e;
  });
}
export function foldKey(raw) {
  const t = raw.trim();
  const exact = t.match(/^\[\s*(["'])([\s\S]*)\1\s*\]$/);
  if (exact && !exact[2].includes('..')) return luaUnescape(exact[2]);
  if (!t.startsWith('[')) return t;
  const pieces = []; const re = /(["'])((?:\\.|(?!\1)[\s\S])*)\1/g; let m;
  while ((m = re.exec(t))) pieces.push(luaUnescape(m[2]));
  const skeleton = t.replace(re, 'S').replace(/\s+/g, '');
  if (/^\[S(?:\.\.S)*\]$/.test(skeleton)) return pieces.join('');
  return t;
}
export function parseWrapper(source) {
  const m = /return\s*\(\s*\{/.exec(source);
  if (!m) throw new Error('Not a Goofyscator table wrapper');
  const open = source.indexOf('{', m.index); const close = findMatching(source, open);
  if (close < 0) throw new Error('Unbalanced wrapper table');
  const body = source.slice(open + 1, close); const entries = [];
  for (const rawPart of splitTop(body)) {
    const part = rawPart.trim(); if (!part) continue;
    const eq = topEquals(part); if (eq < 0) continue;
    const rawKey = part.slice(0, eq).trim(); const value = part.slice(eq + 1).trim();
    entries.push({ key: foldKey(rawKey), rawKey, value, isFunction: /^\(?\s*function\b/.test(value) });
  }
  const suffix = source.slice(close + 1);
  const em = /\)\s*:\s*([A-Za-z_]\w*)\s*\(/.exec(suffix);
  return { source, open, close, tableSource: source.slice(open, close + 1), entries, entryMethod: em?.[1] ?? null };
}
export function readWrapper(file) { return parseWrapper(fs.readFileSync(file, 'latin1')); }
