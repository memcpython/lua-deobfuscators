import { operandValue, reg, literal } from '../ir/value.js';
import { readUleb, readZigZag, selector } from '../decode/extra.js';

export class LiftContext {
  constructor(discovery) { this.discovery = discovery; }
  value(op) { return operandValue(op); }
  reg(i) { return reg(i); }
  literal(v) { return literal(v); }
  uleb(extra, offset = 0, fallback = 0) { const r = readUleb(extra, offset); return r.value == null ? {value:fallback,next:r.next} : r; }
  signed(extra, offset = 0, fallback = 0) { const r = readZigZag(extra, offset); return r.value == null ? {value:fallback,next:r.next} : r; }
  select(ins, which) {
    const cfg = this.discovery.select?.[which];
    if (!cfg) throw new Error(`Missing ${which} selector metadata`);
    const id = selector(ins.extra, cfg.mask);
    if (id == null) return this.value(ins.op1);
    return this.value((id % 2) ? ins.op2 : ins.op1);
  }
  binaryOperator(ins) {
    const cfg = this.discovery.binary;
    const id = selector(ins.extra, cfg.mask);
    return id == null ? null : cfg.ops[id] ?? null;
  }
  base(ins, op, fields = {}) { return { pc: ins.pc, sourcePc: ins.sourcePc, sub: ins.sub, op, ...fields, vm: { semantic: ins.semantic, handlerId: ins.handlerId } }; }
}
