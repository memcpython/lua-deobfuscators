export default (i,c) => c.base(i,'closure',{dst:i.dest,prototype:i.prototype??null,upvalues:i.upvalues??[],error:i.prototypeError??null});
