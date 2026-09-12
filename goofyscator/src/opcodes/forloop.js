export default (i,c) => { const limit=i.op2?.value??0; const step=c.signed(i.extra,0,limit+1).value; return c.base(i,'forloop',{index:i.dest,limit,step,target:i.op1?.value??0}); };
