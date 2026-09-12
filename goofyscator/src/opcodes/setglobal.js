export default (i,c) => c.base(i,'setglobal',{src:i.dest,key:c.value(i.op1)});
