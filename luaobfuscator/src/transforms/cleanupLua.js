import { mapOutsideLuaStrings } from "../core/luaStrings.js";

function cleanupChunk(chunk) {
  return chunk
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, ";\n")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s*([{}[\]()+\-*/%<>])\s*/g, "$1")
    .replace(/\bthen\s+/g, "then\n")
    .replace(/\bdo\s+/g, "do\n")
    .replace(/\belse\s+/g, "else\n")
    .replace(/\belseif\s+/g, "elseif ")
    .replace(/\bend\s*;?/g, "end\n")
    .replace(/\bfunction\s*\(/g, "function(")
    .replace(/\bif\s+/g, "if ")
    .replace(/\bfor\s+/g, "for ")
    .replace(/\bwhile\s+/g, "while ")
    .replace(/\brepeat\s+/g, "repeat\n")
    .replace(/\buntil\s+/g, "until ");
}

function lightIndent(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let depth = 0;
  const out = [];

  for (const line of lines) {
    if (/^(end|else\b|elseif\b|until\b)/.test(line)) depth = Math.max(0, depth - 1);
    out.push(`${"  ".repeat(depth)}${line}`);
    if (/\b(then|do)\s*$/.test(line) || /\bfunction\b/.test(line) || /^else\b/.test(line) || /^elseif\b/.test(line) || /^repeat\b/.test(line)) {
      depth += 1;
    }
  }

  return `${out.join("\n")}\n`;
}

export function cleanupLua(source) {
  const split = mapOutsideLuaStrings(source, cleanupChunk)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return lightIndent(split);
}
