export default (i,c) => c.base(i,'binary',{dst:i.dest,operator:'*',left:c.reg(i.op1?.value??0),right:c.literal(i.op2?.value??0),specialized:true});
