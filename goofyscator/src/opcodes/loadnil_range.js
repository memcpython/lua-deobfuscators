export default (i,c) => c.base(i,'clear_range',{from:Math.min(i.dest,i.op1?.value??0),to:Math.max(i.dest,i.op1?.value??0)});
