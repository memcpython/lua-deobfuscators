const simpleEscapes = new Map([
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ["\\", 92],
  ['"', 34],
  ["'", 39]
]);

export function readLuaQuotedString(source, startIndex) {
  const quote = source[startIndex];
  if (quote !== '"' && quote !== "'") return null;

  const bytes = [];
  let i = startIndex + 1;

  while (i < source.length) {
    const char = source[i];

    if (char === quote) {
      return {
        bytes,
        end: i + 1,
        raw: source.slice(startIndex, i + 1)
      };
    }

    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      i += 1;
      continue;
    }

    i += 1;
    if (i >= source.length) break;

    const escaped = source[i];
    if (/[0-9]/.test(escaped)) {
      let digits = escaped;
      i += 1;
      while (i < source.length && digits.length < 3 && /[0-9]/.test(source[i])) {
        digits += source[i];
        i += 1;
      }
      bytes.push(Number.parseInt(digits, 10) & 0xff);
      continue;
    }

    if (escaped === "x" && /[0-9a-fA-F]/.test(source[i + 1] ?? "") && /[0-9a-fA-F]/.test(source[i + 2] ?? "")) {
      bytes.push(Number.parseInt(source.slice(i + 1, i + 3), 16) & 0xff);
      i += 3;
      continue;
    }

    if (escaped === "z") {
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      continue;
    }

    bytes.push(simpleEscapes.get(escaped) ?? (escaped.charCodeAt(0) & 0xff));
    i += 1;
  }

  throw new Error(`Unterminated Lua string at byte ${startIndex}`);
}

export function luaQuote(bytes) {
  if (bytes.some((byte) => byte >= 128)) {
    const buffer = Buffer.from(bytes);
    const text = buffer.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buffer)) {
      return quoteUtf8Text(text);
    }
  }

  let out = '"';
  for (const byte of bytes) {
    if (byte === 34) out += '\\"';
    else if (byte === 92) out += "\\\\";
    else if (byte === 10) out += "\\n";
    else if (byte === 13) out += "\\r";
    else if (byte === 9) out += "\\t";
    else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
    else out += `\\${byte.toString().padStart(3, "0")}`;
  }
  out += '"';
  return out;
}

function quoteUtf8Text(text) {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code >= 32 && code !== 127) out += char;
    else {
      for (const byte of Buffer.from(char, "utf8")) out += `\\${byte.toString().padStart(3, "0")}`;
    }
  }
  out += '"';
  return out;
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

export function mapOutsideLuaStrings(source, mapper) {
  let out = "";
  let chunkStart = 0;
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === '"' || char === "'") {
      out += mapper(source.slice(chunkStart, i));
      let parsed;
      try {
        parsed = readLuaQuotedString(source, i);
      } catch {
        out += source.slice(i);
        return out;
      }
      out += parsed.raw;
      i = parsed.end;
      chunkStart = i;
      continue;
    }

    if (source.startsWith("--[[", i)) {
      out += mapper(source.slice(chunkStart, i));
      const end = source.indexOf("]]", i + 4);
      const commentEnd = end === -1 ? source.length : end + 2;
      out += source.slice(i, commentEnd);
      i = commentEnd;
      chunkStart = i;
      continue;
    }

    if (source.startsWith("--", i)) {
      out += mapper(source.slice(chunkStart, i));
      const commentEnd = findLineCommentEnd(source, i + 2);
      out += source.slice(i, commentEnd);
      i = commentEnd;
      chunkStart = i;
      continue;
    }

    i += 1;
  }

  out += mapper(source.slice(chunkStart));
  return out;
}
