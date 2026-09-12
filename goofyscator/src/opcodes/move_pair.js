export default (i,c) => { const source=c.signed(i.extra,0,0).value; return c.base(i,'move_pair',{dst:i.dest,src:c.value(i.op1),secondDst:i.op2?.value??0,secondSrc:source}); };
