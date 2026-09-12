const fs=require('fs');const path=require('path');const assert=require('assert');const {deobfuscate}=require('../src');const {execute}=require('./helpers');
const input=fs.readFileSync(path.join(__dirname,'fixtures','synthetic-obfuscated.js'),'utf8');const expected=fs.readFileSync(path.join(__dirname,'fixtures','synthetic-expected.txt'),'utf8');
const before=execute(input);assert.strictEqual(before,expected,'fixture itself must be valid');
const result=deobfuscate(input,{rename:true,maxIterations:10});fs.mkdirSync(path.join(__dirname,'output'),{recursive:true});fs.writeFileSync(path.join(__dirname,'output','synthetic.deobfuscated.js'),result.code);
assert.ok(!result.report.parseError,'deobfuscated fixture should parse');assert.strictEqual(execute(result.code),expected,'deobfuscation must preserve behavior');assert.ok(result.report.totalChanges>5,'expected multiple simplifications');assert.ok(!/_0xdec\s*\(/.test(result.code),'decoder calls should be gone');assert.ok(result.code.includes('Hello '),'decoded string should be visible');
console.log(`regression PASS (${result.report.totalChanges} transformations)`);
