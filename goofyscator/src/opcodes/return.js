export default (i,c) => c.base(i,'return',{base:i.dest,count:i.op1?.value??0,open:(i.op2?.value??0)!==0,hasValues:c.uleb(i.extra,0,0).value!==0});
