export default (i,c) => c.base(i,'vararg',{base:i.dest,count:i.op1?.value??0});
