const { walk, sourceOf, propertyName } = require('../core/ast');
const { renderWithIdentifierSubstitutions } = require('../core/render');
const { applyEdits, selectOutermost } = require('../core/edits');

function keyOf(member){
 if(member.type!=='MemberExpression')return null;
 if(!member.computed&&member.property.type==='Identifier')return member.property.name;
 if(member.computed&&member.property.type==='Literal')return String(member.property.value);
 return null;
}
function simpleReturn(fn){
 if(fn.type==='ArrowFunctionExpression'&&fn.body.type!=='BlockStatement')return fn.body;
 if(fn.body?.type!=='BlockStatement'||fn.body.body.length!==1)return null;
 const s=fn.body.body[0];return s.type==='ReturnStatement'&&s.argument?s.argument:null;
}
function run(source,ast){
 const objects=new Map(), dup=new Set();
 walk(ast,{enter({node}){
   if(node.type!=='VariableDeclarator'||node.id.type!=='Identifier'||node.init?.type!=='ObjectExpression')return;
   const entries=new Map(); let useful=0;
   for(const p of node.init.properties){
     if(p.type!=='Property'||p.kind!=='init'||p.computed)continue;
     const k=propertyName(p.key); if(k==null)continue;
     if(p.value.type==='FunctionExpression'||p.value.type==='ArrowFunctionExpression'){
       const ret=simpleReturn(p.value); if(ret){entries.set(k,{kind:'function',fn:p.value,ret});useful++;}
     } else if(['Literal','Identifier','BinaryExpression','UnaryExpression'].includes(p.value.type)) {entries.set(k,{kind:'value',node:p.value});useful++;}
   }
   if(!useful)return; const name=node.id.name; if(objects.has(name))dup.add(name); else objects.set(name,{decl:node,entries});
 }});
 for(const n of dup)objects.delete(n);
 const edits=[];
 walk(ast,{enter({node,parent}){
   if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.object.type==='Identifier'){
     const obj=objects.get(node.callee.object.name); if(!obj)return; const key=keyOf(node.callee); const entry=obj.entries.get(key); if(!entry||entry.kind!=='function')return;
     const params=entry.fn.params; if(params.some(p=>p.type!=='Identifier')||node.arguments.length<params.length)return;
     const subs=new Map(); for(let i=0;i<params.length;i++)subs.set(params[i].name,sourceOf(node.arguments[i],source));
     const text=renderWithIdentifierSubstitutions(entry.ret,source,subs); edits.push({start:node.start,end:node.end,text:`(${text})`}); return;
   }
   if(node.type==='MemberExpression'&&node.object.type==='Identifier'){
     if(parent?.type==='CallExpression'&&parent.callee===node)return;
     const obj=objects.get(node.object.name); if(!obj)return; const key=keyOf(node); const entry=obj.entries.get(key); if(!entry||entry.kind!=='value')return;
     edits.push({start:node.start,end:node.end,text:`(${sourceOf(entry.node,source)})`});
   }
 }});
 const r=applyEdits(source,selectOutermost(edits));return{code:r.code,changes:r.applied};
}
module.exports={name:'proxy-object-inline',run};
