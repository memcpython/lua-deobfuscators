import { mapOutsideLuaStrings } from "../core/luaStrings.js";

function evalNumericExpression(expression) {
  if (expression.length > 80) return null;
  if (!/[+\-*/%^]/.test(expression)) return null;
  if (!/^[\d\s+\-*/%^().]+$/.test(expression)) return null;
  try {
    const jsExpression = expression.replace(/\^/g, "**");
    const value = Function(`"use strict"; return (${jsExpression});`)();
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
    const rounded = Math.round(value * 1_000_000_000) / 1_000_000_000;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  } catch {
    return null;
  }
}

function foldChunk(chunk) {
  let folded = 0;
  let previous;
  let code = chunk;

  do {
    previous = code;
    code = code.replace(/\((-?\d+(?:\.\d+)?)\)/g, (full, value, offset, whole) => {
      const previousChar = whole[offset - 1] ?? "";
      const nextChar = whole[offset + full.length] ?? "";
      if (/[A-Za-z0-9_\].]/.test(previousChar) || /[A-Za-z_]/.test(nextChar)) return full;
      folded += 1;
      return value;
    });

    code = code.replace(/\(([\d\s+\-*/%^.]{3,80})\)/g, (full, expression, offset, whole) => {
      const value = evalNumericExpression(expression);
      if (value === null) return full;
      folded += 1;
      const previous = whole[offset - 1] ?? "";
      if (/[A-Za-z0-9_\])]/.test(previous)) return `(${value})`;
      return value;
    });
  } while (code !== previous);

  code = code.replace(/\b\d+(?:\.\d+)?\s*[+\-*/%^]\s*-?\d+(?:\.\d+)?\b/g, (full) => {
    const value = evalNumericExpression(full);
    if (value === null) return full;
    folded += 1;
    return value;
  });

  return { code, folded };
}

export function foldNumericNoise(source) {
  let folded = 0;
  const code = mapOutsideLuaStrings(source, (chunk) => {
    const result = foldChunk(chunk);
    folded += result.folded;
    return result.code;
  });

  return { code, folded };
}
