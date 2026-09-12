function decodedResolved(r) {
  if (!r || typeof r !== 'object') return { kind: 'literal', value: null };
  switch (r.type) {
    case 'nil': return { kind: 'literal', value: null };
    case 'number': case 'boolean': return { kind: 'literal', value: r.value };
    case 'string': return { kind: 'literal', value: Buffer.from(r.hex ?? '', 'hex').toString('latin1'), bytesHex: r.hex ?? '' };
    default: return { kind: 'unknown', sourceType: r.type, value: r.value ?? null };
  }
}
export function operandValue(op) {
  if (!op || op.kind === 'none') return { kind: 'literal', value: null };
  if (op.kind === 'reg') return { kind: 'reg', index: op.value };
  if (op.kind === 'imm') return { kind: 'literal', value: op.value };
  if (op.kind === 'const') return { ...decodedResolved(op.resolved), constantIndex: op.value, constantKind: op.kindCode };
  return { kind: 'unknown', raw: op };
}
export const reg = index => ({ kind: 'reg', index });
export const literal = value => ({ kind: 'literal', value });
