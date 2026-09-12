export default (i,c) => c.base(i,'getupval',{dst:i.dest,slot:i.op1?.value??0});
