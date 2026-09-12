export default (i,c) => c.base(i,'move',{dst:i.dest,src:c.literal(i.op1?.value ?? 0)});
