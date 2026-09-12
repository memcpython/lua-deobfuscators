export default (i,c) => c.base(i,'settable',{table:i.dest,key:c.value(i.op1),value:c.value(i.op2)});
