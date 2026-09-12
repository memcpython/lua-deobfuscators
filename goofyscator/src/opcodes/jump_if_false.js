export default (i,c) => c.base(i,'branch_false',{condition:c.reg(i.dest),target:i.op1?.value??0});
