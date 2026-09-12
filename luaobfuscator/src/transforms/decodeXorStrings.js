import { luaQuote, readLuaQuotedString } from "../core/luaStrings.js";

function findDecoderDefinitions(source) {
  const definitions = [];
  const functionPattern = /local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)/g;
  let match;

  while ((match = functionPattern.exec(source)) !== null) {
    const start = match.index;
    const bodyStart = functionPattern.lastIndex;
    const end = findBalancedFunctionEnd(source, bodyStart);
    if (end === -1) continue;

    const text = source.slice(start, end);
    const body = source.slice(bodyStart, end);

    if (
      /\bfor\b/.test(body) &&
      /#\s*[A-Za-z_]/.test(body) &&
      /%\s*(?:256|\()/.test(body) &&
      /\breturn\b/.test(body)
    ) {
      definitions.push({
        name: match[1],
        start,
        end,
        text
      });
    }
  }

  return definitions;
}

function findBalancedFunctionEnd(source, bodyStart) {
  let depth = 1;
  let i = bodyStart;

  while (i < source.length) {
    const char = source[i];

    if (char === '"' || char === "'") {
      try {
        i = readLuaQuotedString(source, i).end;
      } catch {
        return -1;
      }
      continue;
    }

    if (source.startsWith("--[[", i)) {
      const end = source.indexOf("]]", i + 4);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    if (source.startsWith("--", i)) {
      i = findLineCommentEnd(source, i + 2);
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      const word = source.slice(i, end);
      if (word === "function" || word === "do" || word === "then" || word === "repeat") {
        depth += 1;
      } else if (word === "end" || word === "until") {
        depth -= 1;
        if (depth === 0) return end;
      }
      i = end;
      continue;
    }

    i += 1;
  }

  return -1;
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

function decodeXor(dataBytes, keyBytes) {
  if (keyBytes.length === 0) return dataBytes;

  const out = [];
  for (let i = 1; i <= dataBytes.length; i += 1) {
    const dataByte = dataBytes[i - 1];
    const keyByte = keyBytes[i % keyBytes.length];
    out.push((dataByte ^ keyByte) & 0xff);
  }
  return out;
}

function skipSpace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function parseDecoderCall(source, index, decoderNames) {
  for (const name of decoderNames) {
    if (!source.startsWith(name, index)) continue;
    const before = source[index - 1] ?? "";
    const afterName = source[index + name.length] ?? "";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(afterName)) continue;

    let i = skipSpace(source, index + name.length);
    if (source[i] !== "(") continue;
    i = skipSpace(source, i + 1);

    const first = readLuaQuotedString(source, i);
    if (!first) continue;
    i = skipSpace(source, first.end);
    if (source[i] !== ",") continue;
    i = skipSpace(source, i + 1);

    const second = readLuaQuotedString(source, i);
    if (!second) continue;
    i = skipSpace(source, second.end);
    if (source[i] !== ")") continue;

    return {
      end: i + 1,
      replacement: luaQuote(decodeXor(first.bytes, second.bytes))
    };
  }

  return null;
}

function replaceDecoderCalls(source, decoderNames) {
  let out = "";
  let decodedStrings = 0;
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === '"' || char === "'") {
      let parsed;
      try {
        parsed = readLuaQuotedString(source, i);
      } catch {
        out += source.slice(i);
        break;
      }
      out += parsed.raw;
      i = parsed.end;
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

    const call = parseDecoderCall(source, i, decoderNames);
    if (call) {
      out += call.replacement;
      decodedStrings += 1;
      i = call.end;
      continue;
    }

    out += char;
    i += 1;
  }

  return { code: out, decodedStrings };
}

function removeDecoderPrelude(source, definitions) {
  if (definitions.length === 0) return { code: source, removed: false };

  let code = source;
  let removed = false;

  for (const definition of [...definitions].sort((a, b) => b.start - a.start)) {
    const stillUsed = new RegExp(`\\b${definition.name}\\s*\\(`).test(code.slice(0, definition.start) + code.slice(definition.end));
    if (stillUsed) continue;

    let start = definition.start;
    const prefix = code.slice(Math.max(0, start - 260), start);
    const aliasMatch = /local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*string\.char\s*;[\s\S]*$/m.exec(prefix);
    if (aliasMatch) start = Math.max(0, start - 260) + aliasMatch.index;

    code = code.slice(0, start) + code.slice(definition.end).replace(/^\s*;?\s*/, "");
    removed = true;
  }

  return { code, removed };
}

export function decodeXorStrings(source, options = {}) {
  const definitions = findDecoderDefinitions(source);
  const decoderNames = [...new Set(definitions.map((definition) => definition.name))];

  if (decoderNames.length === 0) {
    return {
      code: source,
      decoders: [],
      decodedStrings: 0,
      removedDecoder: false
    };
  }

  const replaced = replaceDecoderCalls(source, decoderNames);
  const cleaned = options.removeDecoder === false
    ? { code: replaced.code, removed: false }
    : removeDecoderPrelude(replaced.code, definitions);

  return {
    code: cleaned.code,
    decoders: decoderNames,
    decodedStrings: replaced.decodedStrings,
    removedDecoder: cleaned.removed
  };
}
