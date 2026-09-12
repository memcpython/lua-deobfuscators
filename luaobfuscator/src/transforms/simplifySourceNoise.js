import { readLuaQuotedString, mapOutsideLuaStrings } from "../core/luaStrings.js";

function skipSpace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function findLineCommentEnd(source, startIndex) {
  const lf = source.indexOf("\n", startIndex);
  const cr = source.indexOf("\r", startIndex);
  let end;
  if (lf === -1) end = cr === -1 ? source.length : cr;
  else if (cr === -1) end = lf;
  else end = Math.min(lf, cr);
  if (end >= source.length) return source.length;
  return source[end] === "\r" && source[end + 1] === "\n" ? end + 2 : end + 1;
}

function replaceStringLengthLiterals(source) {
  let out = "";
  let replaced = 0;
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === '"' || char === "'") {
      try {
        const parsed = readLuaQuotedString(source, i);
        out += parsed.raw;
        i = parsed.end;
      } catch {
        out += source.slice(i);
        break;
      }
      continue;
    }

    if (source.startsWith("--[[", i)) {
      const end = source.indexOf("]]", i + 4);
      const commentEnd = end === -1 ? source.length : end + 2;
      out += source.slice(i, commentEnd);
      i = commentEnd;
      continue;
    }

    if (source.startsWith("--", i)) {
      const commentEnd = findLineCommentEnd(source, i + 2);
      out += source.slice(i, commentEnd);
      i = commentEnd;
      continue;
    }

    if (char === "#") {
      const stringStart = skipSpace(source, i + 1);
      const quote = source[stringStart];
      if (quote === '"' || quote === "'") {
        try {
          const parsed = readLuaQuotedString(source, stringStart);
          out += String(parsed.bytes.length);
          i = parsed.end;
          replaced += 1;
          continue;
        } catch {
          // Fall through and preserve the original byte.
        }
      }
    }

    out += char;
    i += 1;
  }

  return { code: out, replaced };
}

function replaceWithCount(source, pattern, replacement) {
  let count = 0;
  const code = source.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  return { code, count };
}

function simplifyThunkChunk(chunk) {
  let simplified = 0;
  let code = chunk;

  const empty = replaceWithCount(
    code,
    /\(\s*function\s*\(\s*\)\s*return\s*;?\s*end\s*\)\s*\(\s*\)/g,
    "nil"
  );
  code = empty.code;
  simplified += empty.count;

  const tableReturn = replaceWithCount(
    code,
    /\(\s*function\s*\(\s*\)\s*return\s+(\{[^;\n]*?\})\s*;?\s*end\s*\)\s*\(\s*\)/g,
    (_full, expression) => `(${expression.trim()})`
  );
  code = tableReturn.code;
  simplified += tableReturn.count;

  const simpleReturn = replaceWithCount(
    code,
    /\(\s*function\s*\(\s*\)\s*return\s+([^;{}\n]*?)\s*;?\s*end\s*\)\s*\(\s*\)/g,
    (_full, expression) => `(${expression.trim()})`
  );
  code = simpleReturn.code;
  simplified += simpleReturn.count;

  return { code, simplified };
}

function simplifyBooleanChunk(chunk) {
  let simplified = 0;
  let code = chunk.replace(/\b(-?\d+(?:\.\d+)?)\s*(==|~=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\b/g, (full, left, operator, right) => {
    const a = Number(left);
    const b = Number(right);
    let value;
    if (operator === "==") value = a === b;
    else if (operator === "~=") value = a !== b;
    else if (operator === "<=") value = a <= b;
    else if (operator === ">=") value = a >= b;
    else if (operator === "<") value = a < b;
    else if (operator === ">") value = a > b;
    else return full;

    simplified += 1;
    return value ? "true" : "false";
  });

  const replacements = [
    [/\(\s*true\s*\)\s*and\s*/g, ""],
    [/\s*and\s*\(\s*true\s*\)/g, ""],
    [/\(\s*false\s*\)\s*or\s*/g, ""],
    [/\s*or\s*\(\s*false\s*\)/g, ""],
    [/\bnot\s*\(\s*false\s*\)/g, "true"],
    [/\bnot\s*\(\s*true\s*\)/g, "false"]
  ];

  for (const [pattern, replacement] of replacements) {
    const result = replaceWithCount(code, pattern, replacement);
    code = result.code;
    simplified += result.count;
  }

  return { code, simplified };
}

function mapWithCount(source, mapper) {
  let total = 0;
  const code = mapOutsideLuaStrings(source, (chunk) => {
    const result = mapper(chunk);
    total += result.simplified;
    return result.code;
  });
  return { code, total };
}

export function simplifySourceNoise(source) {
  let simplified = 0;

  const lengths = replaceStringLengthLiterals(source);
  let code = lengths.code;
  simplified += lengths.replaced;

  const thunks = mapWithCount(code, simplifyThunkChunk);
  code = thunks.code;
  simplified += thunks.total;

  const booleans = mapWithCount(code, simplifyBooleanChunk);
  code = booleans.code;
  simplified += booleans.total;

  return { code, simplified };
}
