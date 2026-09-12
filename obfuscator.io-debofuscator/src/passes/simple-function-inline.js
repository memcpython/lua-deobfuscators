const { walk, sourceOf, isReferenceIdentifier } = require('../core/ast');
const { renderWithIdentifierSubstitutions } = require('../core/render');
const { applyEdits } = require('../core/edits');

function getSimpleReturn(fn){
  if(!fn.body||fn.body.type!=='BlockStatement'||fn.body.body.length!==1)return null;
  const s=fn.body.body[0]; return s.type==='ReturnStatement'&&s.argument?s.argument:null;
}
function hasForbidden(node){
 let bad=false; walk(node,{enter({node:n}){ if(['AssignmentExpression','UpdateExpression','AwaitExpression','YieldExpression','NewExpression','MetaProperty','ThisExpression','Super'].includes(n.type)) bad=true; if(n.type==='Identifier'&&n.name==='arguments') bad=true; }}); return bad;
}
function run(source,ast,ctx={}){
 const defs=new Map(), dup=new Set();
 walk(ast,{enter({node}){
   if(node.type==='FunctionDeclaration'&&node.id){if(!ctx.options?.inlineNamedFunctions&&!/^_0x[0-9a-f]+$/i.test(node.id.name))return;const ret=getSimpleReturn(node); if(!ret||hasForbidden(ret))return; if(defs.has(node.id.name))dup.add(node.id.name); else defs.set(node.id.name,{node,ret});}
   if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&(node.init?.type==='FunctionExpression'||node.init?.type==='ArrowFunctionExpression')){
     const fn=node.init; let ret=fn.body.type==='BlockStatement'?getSimpleReturn(fn):fn.body; if(!ret||hasForbidden(ret))return; if(defs.has(node.id.name))dup.add(node.id.name); else defs.set(node.id.name,{node,fn,ret});
   }
 }});
 for(const n of dup)defs.delete(n);
 const edits=[]; const usages=new Map();
 walk(ast,{enter({node,parent,key}){
   if(node.type!=='CallExpression'||node.callee.type!=='Identifier'||!defs.has(node.callee.name))return;
   const def=defs.get(node.callee.name); const fn=def.fn||def.node;
   const params=fn.params||[]; if(params.some(p=>p.type!=='Identifier')||node.arguments.length<params.length)return;
   const subs=new Map(); for(let i=0;i<params.length;i++) subs.set(params[i].name,sourceOf(node.arguments[i],source));
   let text=renderWithIdentifierSubstitutions(def.ret,source,subs);
   edits.push({start:node.start,end:node.end,text:`(${text})`}); usages.set(node.callee.name,(usages.get(node.callee.name)||0)+1);
 }});
 // Removal is deferred to unused-scaffold; deleting now can conflict with nested call edits.
 const r=applyEdits(source,edits); return {code:r.code,changes:r.applied,details:{inlined:[...usages.keys()]}};
}
module.exports={name:'simple-function-inline',run};
