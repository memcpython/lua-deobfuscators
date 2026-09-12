const { parse }=require('./ast');
const { profile }=require('./profile');
const { Report }=require('./report');
const { format }=require('../utils/formatter');

const vmDevirtualize=require('../passes/vm-devirtualize');
const literalFold=require('../passes/literal-fold');
const stringDecoder=require('../passes/string-decoder');
const proxyObject=require('../passes/proxy-object-inline');
const simpleFunction=require('../passes/simple-function-inline');
const constantPropagation=require('../passes/constant-propagation');
const propertyNormalize=require('../passes/property-normalize');
const controlFlow=require('../passes/control-flow');
const sequenceSplit=require('../passes/sequence-split');
const deadBranch=require('../passes/dead-branch');
const antiTamper=require('../passes/anti-tamper');
const antiDebug=require('../passes/anti-debug');
const unusedScaffold=require('../passes/unused-scaffold');
const renameObfuscated=require('../passes/rename-obfuscated');
const literalNormalize=require('../passes/literal-normalize');
const returnTempInline=require('../passes/return-temp-inline');
const declarationSplit=require('../passes/declaration-split');
const redundantParens=require('../passes/redundant-parens');
const unusedBindings=require('../passes/unused-bindings');
const objectAssembly=require('../passes/object-assembly');

const FIXPOINT=[
 vmDevirtualize,
 literalFold,
 stringDecoder,
 proxyObject,
 simpleFunction,
 constantPropagation,
 propertyNormalize,
 controlFlow,
 sequenceSplit,
 deadBranch,
 antiTamper,
 antiDebug,
 unusedScaffold
];

class Deobfuscator{
 constructor(options={}){this.options={maxIterations:options.maxIterations??10,rename:options.rename!==false,format:options.format!==false,inlineNamedFunctions:!!options.inlineNamedFunctions,allowObservationalSynthesis:options.allowObservationalSynthesis===true,silent:!!options.silent};}
 execute(input){
   let source=String(input); const report=new Report(); const ctx={options:this.options,scaffoldNames:new Set(),report};
   let ast;
   try{ast=parse(source);}catch(error){report.warn(`Parse failed: ${error.message}`);return{code:source,report:{...report,parseError:error.message,totalChanges:0}};}
   report.profile.before=profile(ast,source);
   for(let iteration=0;iteration<this.options.maxIterations;iteration++){
     let changed=0;
     for(const pass of FIXPOINT){
       try{ast=parse(source);const r=pass.run(source,ast,ctx)||{code:source,changes:0};if(typeof r.code==='string')source=r.code;const n=r.changes||0;changed+=n;report.addPass(`${iteration+1}:${pass.name}`,n,r.details||{});}
       catch(error){report.warn(`${pass.name}: ${error.message}`);report.addPass(`${iteration+1}:${pass.name}`,0,{error:error.message});}
     }
     if(changed===0)break;
   }
   // Structural polish runs before renaming so bindings deleted here never consume
   // an L_N slot. The final readable identifiers are therefore dense and stable.
   const finalPasses=[returnTempInline,declarationSplit,objectAssembly,redundantParens,unusedBindings];
   for(let polish=0;polish<6;polish++){
     let polishChanges=0;
     for(const pass of finalPasses){
       try{ast=parse(source);const r=pass.run(source,ast,ctx)||{code:source,changes:0};if(typeof r.code==='string')source=r.code;const n=r.changes||0;polishChanges+=n;report.addPass(`polish${polish+1}:${pass.name}`,n,r.details||{});}
       catch(error){report.warn(`${pass.name}: ${error.message}`);}
     }
     if(polishChanges===0)break;
   }
   if(this.options.rename){
     try{ast=parse(source);const r=renameObfuscated.run(source,ast,ctx);source=r.code;report.addPass(renameObfuscated.name,r.changes,r.details||{});}catch(error){report.warn(`rename: ${error.message}`);}
   }
   try{ast=parse(source);const r=literalNormalize.run(source,ast,ctx);source=r.code;report.addPass(literalNormalize.name,r.changes,r.details||{});}catch(error){report.warn(`literal-normalize: ${error.message}`);}
   if(this.options.format){
     const formatted=format(source,{indentSize:2}); if(formatted!==source){source=formatted;report.addPass('beautify',1);}
   }
   try{ast=parse(source);report.profile.after=profile(ast,source);}catch(error){report.warn(`Final parse failed: ${error.message}`);}
   const plain={passes:report.passes,warnings:report.warnings,profile:report.profile,totalChanges:report.totalChanges};
   return{code:source,report:plain};
 }
}
module.exports={Deobfuscator};
