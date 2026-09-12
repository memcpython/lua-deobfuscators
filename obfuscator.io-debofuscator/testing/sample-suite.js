const fs=require('fs');const path=require('path');const {deobfuscate}=require('../src');const {parse}=require('../src/core/ast');
const samplesDir=path.join(__dirname,'..','samples'),outDir=path.join(__dirname,'output','samples');fs.mkdirSync(outDir,{recursive:true});
let valid=0,invalid=0,changed=0;const rows=[];
for(const file of fs.readdirSync(samplesDir).filter(f=>f.endsWith('.js')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))){
 const input=fs.readFileSync(path.join(samplesDir,file),'utf8');let inputValid=true;try{parse(input);}catch(_){inputValid=false;}
 const result=deobfuscate(input,{rename:true,maxIterations:8});const stem=file.replace(/\.js$/,'');fs.writeFileSync(path.join(outDir,`${stem}.deobfuscated.js`),result.code);
 let outputValid=true;try{parse(result.code);}catch(_){outputValid=false;}
 if(inputValid){valid++;if(!outputValid)throw new Error(`${file}: valid input became invalid`);}else invalid++;
 if(result.report.totalChanges>0)changed++;
 rows.push({file,inputValid,outputValid,changes:result.report.totalChanges,before:Buffer.byteLength(input),after:Buffer.byteLength(result.code),warnings:result.report.warnings.length});
}
console.table(rows);console.log(`samples: ${valid} valid, ${invalid} invalid, ${changed} transformed`);if(changed===0)process.exitCode=1;
