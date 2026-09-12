export default (i,c) => c.base(i,'unary',{dst:i.dest,operator:'not',value:c.reg(i.dest)});
