export default (i,c) => { const marker=c.uleb(i.extra,0,0).value; return c.base(i,'setlist',{table:i.dest,from:i.op1?.value??0,to:i.op2?.value??0,open:marker!==0}); };
