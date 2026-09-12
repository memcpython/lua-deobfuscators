const vm=require('vm');
function execute(code){const logs=[];const sandbox={console:{log:(...a)=>logs.push(a.join(' ')),warn(){},error(){}},prompt:()=>''};vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});vm.runInContext(code,sandbox,{timeout:1000});return logs.join('\n')+(logs.length?'\n':'');}
module.exports={execute};
