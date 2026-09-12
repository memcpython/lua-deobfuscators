export default (i,c) => c.base(i,'gettable',{dst:i.dest,table:i.dest,key:c.value(i.op1)});
