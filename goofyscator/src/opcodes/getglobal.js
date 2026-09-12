export default (i,c) => c.base(i,'getglobal',{dst:i.dest,key:c.value(i.op1)});
