const { Deobfuscator }=require('./core/deobfuscator');
function deobfuscate(source,options={}){return new Deobfuscator(options).execute(source);}
module.exports={deobfuscate,Deobfuscator};
