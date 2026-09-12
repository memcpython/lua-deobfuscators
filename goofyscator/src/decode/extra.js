export function extraBytes(extra) {
  if (!extra || extra.type !== 'string' || typeof extra.hex !== 'string') return Buffer.alloc(0);
  return Buffer.from(extra.hex, 'hex');
}

export function readUleb(extra, offset = 0) {
  const bytes = Buffer.isBuffer(extra) ? extra : extraBytes(extra);
  let value = 0, shift = 0, i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    value += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 49) throw new Error('ULEB value exceeds exact JavaScript integer range');
  }
  return { value: null, next: i };
}

export function readZigZag(extra, offset = 0) {
  const r = readUleb(extra, offset);
  if (r.value == null) return r;
  const n = r.value;
  return { value: (n % 2 === 0) ? n / 2 : -((n + 1) / 2), next: r.next };
}

export function selector(extra, mask) {
  const r = readUleb(extra, 0);
  if (r.value == null) return null;
  return ((r.value >>> 0) ^ (mask >>> 0)) >>> 0;
}
