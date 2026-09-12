const vm = require('vm');
const { walk, sourceOf, literalToCode } = require('../core/ast');
const { evaluate } = require('../core/evaluate');
const { applyEdits, selectOutermost } = require('../core/edits');

function functionName(fn){ return fn.id?.name || null; }
function getSimpleReturn(fn){
  if(!fn.body||fn.body.type!=='BlockStatement'||fn.body.body.length!==1)return null;
  const s=fn.body.body[0]; return s.type==='ReturnStatement'&&s.argument?s.argument:null;
}
function collectStringArrayFunctions(ast, source){
  const out=new Map();
  walk(ast,{enter({node}){
    if(node.type!=='FunctionDeclaration'||!node.id)return;
    let best=null;
    walk(node.body,{enter({node:n}){
      if(n.type!=='ArrayExpression'||n.elements.length<4)return;
      const vals=[]; for(const e of n.elements){if(!e||e.type!=='Literal'||typeof e.value!=='string')return; vals.push(e.value);} if(!best||vals.length>best.length)best=vals;
    }});
    if(best) out.set(node.id.name,{node,strings:best});
  }});
  return out;
}
function collectTopLevelFunctions(ast){
  return ast.body.filter(n=>n.type==='FunctionDeclaration'&&n.id);
}
function referencesName(node,name){let yes=false;walk(node,{enter({node:n}){if(n.type==='Identifier'&&n.name===name)yes=true;}});return yes;}
function primaryDecoderNames(ast,source,arrayFns){
  const names=new Set();
  walk(ast,{enter({node}){
    if(node.type!=='FunctionDeclaration'||!node.id||arrayFns.has(node.id.name))return;
    const src=sourceOf(node,source);
    for(const arrName of arrayFns.keys()){
      if(!referencesName(node.body,arrName))continue;
      // javascript-obfuscator decoders index into the string array and optionally perform base64/RC4.
      if(/charCodeAt|decodeURIComponent|fromCharCode|\[[^\]]+\]/.test(src)) {names.add(node.id.name);break;}
    }
  }});
  return names;
}
function literalArgs(args){
  const vals=[];
  for(const arg of args){ if(arg.type==='SpreadElement')return null; const r=evaluate(arg); if(!r.confident)return null; vals.push(r.value); }
  return vals;
}
function primitiveCode(value){
  if(['string','number','boolean','undefined'].includes(typeof value)||value===null) return literalToCode(value);
  return null;
}
function rotationIifes(ast,source,arrayNames){
  const out=[]; const seen=new Set();
  const pushRe=/(?:\.push|\[['"]push['"]\])\s*\(/;
  const shiftRe=/(?:\.shift|\[['"]shift['"]\])\s*\(/;
  for(const st of ast.body){
    if(st.type!=='ExpressionStatement') continue;
    walk(st.expression,{enter({node}){
      if(node.type!=='CallExpression'||!['FunctionExpression','ArrowFunctionExpression'].includes(node.callee.type))return;
      const arg0=node.arguments[0]; if(!arg0||arg0.type!=='Identifier'||!arrayNames.has(arg0.name))return;
      const s=sourceOf(node,source);
      if(!pushRe.test(s)||!shiftRe.test(s)||!/parseInt\s*\(/.test(s))return;
      const key=`${node.start}:${node.end}`; if(!seen.has(key)){seen.add(key);out.push(node);}
      return false;
    }});
  }
  return out;
}
function makeContext(){
  const sandbox={
    console:{log(){},warn(){},error(){},info(){},debug(){}},
    prompt(){return '';}, alert(){},
    setInterval(){return 0;}, clearInterval(){}, setTimeout(){return 0;}, clearTimeout(){}
  };
  return vm.createContext(sandbox,{name:'decoder-sandbox',codeGeneration:{strings:false,wasm:false}});
}
function safeRun(code,ctx,timeout=300){ try{return {ok:true,value:vm.runInContext(code,ctx,{timeout})};}catch(error){return{ok:false,error};} }

function run(source,ast,ctx={}){
  const arrays=collectStringArrayFunctions(ast,source);
  if(arrays.size===0) return {code:source,changes:0};
  const decoders=primaryDecoderNames(ast,source,arrays);
  if(decoders.size===0) return {code:source,changes:0};
  const sandbox=makeContext();

  // Function declarations are side-effect free to define and preserve hoisting semantics.
  for(const fn of collectTopLevelFunctions(ast)) safeRun(sourceOf(fn,source),sandbox,100);

  // Execute only the structural array-rotation IIFE, never the program body.
  let rotations=0;
  for(const st of rotationIifes(ast,source,new Set(arrays.keys()))){ const r=safeRun(`(${sourceOf(st,source)})`,sandbox,1200); if(r.ok)rotations++; }

  // Discover one-line decoder wrappers anywhere, including wrappers nested in business functions.
  const wrappers=new Set();
  let progress=true;
  while(progress){
    progress=false;
    walk(ast,{enter({node}){
      if(node.type!=='FunctionDeclaration'||!node.id||decoders.has(node.id.name)||wrappers.has(node.id.name))return;
      const ret=getSimpleReturn(node); if(!ret||ret.type!=='CallExpression'||ret.callee.type!=='Identifier')return;
      if(!decoders.has(ret.callee.name)&&!wrappers.has(ret.callee.name))return;
      if(node.params.some(p=>p.type!=='Identifier'))return;
      const r=safeRun(sourceOf(node,source),sandbox,100); if(r.ok){wrappers.add(node.id.name);progress=true;}
    }});
  }
  const callable=new Set([...decoders,...wrappers]);
  const edits=[]; const replacedBy=new Map();
  walk(ast,{enter({node}){
    if(node.type!=='CallExpression'||node.callee.type!=='Identifier'||!callable.has(node.callee.name))return;
    const args=literalArgs(node.arguments); if(!args)return;
    let fn; try{fn=sandbox[node.callee.name];}catch(_){return;} if(typeof fn!=='function')return;
    try{
      const value=fn(...args); const code=primitiveCode(value); if(code==null)return;
      edits.push({start:node.start,end:node.end,text:code}); replacedBy.set(node.callee.name,(replacedBy.get(node.callee.name)||0)+1);
    }catch(_){}
  }});
  const result=applyEdits(source,selectOutermost(edits));
  if(!ctx.scaffoldNames)ctx.scaffoldNames=new Set();
  for(const n of arrays.keys())ctx.scaffoldNames.add(n);
  for(const n of callable)ctx.scaffoldNames.add(n);
  return {code:result.code,changes:result.applied,details:{arrays:[...arrays.keys()],decoders:[...decoders],wrappers:[...wrappers],rotations,replaced:Object.fromEntries(replacedBy)}};
}
module.exports={name:'string-decoder',run};
