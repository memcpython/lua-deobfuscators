const { walk, isReferenceIdentifier } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');
const { evaluate } = require('../core/evaluate');

function nearestFunctionName(path){
 for(let i=path.ancestors.length-1;i>=0;i--){const n=path.ancestors[i];if(n.type==='FunctionDeclaration')return n.id?.name||null;if(['FunctionExpression','ArrowFunctionExpression'].includes(n.type))return null;} return null;
}
function oneShotFactory(node){
 if(node?.type!=='CallExpression'||node.arguments.length!==0||!['FunctionExpression','ArrowFunctionExpression'].includes(node.callee.type))return false;
 const body=node.callee.body;
 if(body.type!=='BlockStatement'||body.body.length<1||body.body.length>3)return false;
 const ret=body.body.find(st=>st.type==='ReturnStatement');
 if(!ret||!ret.argument||!['FunctionExpression','ArrowFunctionExpression'].includes(ret.argument.type))return false;
 return body.body.every(st=>{
   if(st===ret)return true;
   if(st.type!=='VariableDeclaration')return false;
   return st.declarations.every(d=>d.id.type==='Identifier'&&d.init?.type==='Literal'&&['boolean','number','string'].includes(typeof d.init.value));
 });
}
function pure(node){
 if(!node)return true;
 if(['Literal','Identifier','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return true;
 if(node.type==='ArrayExpression')return node.elements.every(e=>!e||pure(e));
 if(node.type==='ObjectExpression')return node.properties.every(p=>p.type==='Property'&&!p.computed&&pure(p.value));
 if(node.type==='UnaryExpression')return pure(node.argument);
 if(node.type==='BinaryExpression'||node.type==='LogicalExpression')return pure(node.left)&&pure(node.right);
 if(oneShotFactory(node))return true;
 // core/evaluate only executes a strict allow-list of side-effect-free primitive
 // operations/methods, so a confident expression is safe to discard when unused.
 if(['CallExpression','MemberExpression','ConditionalExpression'].includes(node.type)&&evaluate(node).confident)return true;
 return false;
}
function emptyIife(st){
 if(st.type!=='ExpressionStatement'||st.expression.type!=='CallExpression')return false;
 const fn=st.expression.callee;
 return ['FunctionExpression','ArrowFunctionExpression'].includes(fn?.type)&&fn.body?.type==='BlockStatement'&&fn.body.body.length===0;
}
function isRotationStatement(node,source,scaffold){
 if(node.type!=='ExpressionStatement'||node.expression.type!=='CallExpression'||!['FunctionExpression','ArrowFunctionExpression'].includes(node.expression.callee.type))return false;
 const call=node.expression;
 const first=call.arguments[0];
 if(!first||first.type!=='Identifier'||!scaffold.has(first.name))return false;
 const s=source.slice(node.start,node.end);
 const push=/(?:\.push|\[['"]push['"]\])\s*\(/.test(s);
 const shift=/(?:\.shift|\[['"]shift['"]\])\s*\(/.test(s);
 return push&&shift;
}
function run(source,ast,ctx={}){
 const scaffold=ctx.scaffoldNames||new Set(); const refs=new Map();
 walk(ast,{enter(path){const {node,parent,key}=path;if(node.type==='Identifier'&&isReferenceIdentifier(node,parent,key)){
   if(!refs.has(node.name))refs.set(node.name,[]); refs.get(node.name).push(path);
 }}});
 const edits=[];
 // Remove rotation calls first; they exist only to permute decoder arrays.
 for(const st of ast.body){if(isRotationStatement(st,source,scaffold)||emptyIife(st))edits.push({start:st.start,end:st.end,text:''});}
 walk(ast,{enter(path){const {node}=path;
   if(emptyIife(node))edits.push({start:node.start,end:node.end,text:''});
   if(node.type==='FunctionDeclaration'&&node.id){
     const name=node.id.name; const uses=refs.get(name)||[];
     if(scaffold.has(name)){
       const external=uses.some(p=>{const fn=nearestFunctionName(p);return fn!==name&&!scaffold.has(fn);});
       if(!external)edits.push({start:node.start,end:node.end,text:''});
     } else if(/^_0x[0-9a-f]+$/i.test(name)&&uses.length===0){edits.push({start:node.start,end:node.end,text:''});}
   }
   if(node.type==='VariableDeclaration'){
     if(node.declarations.length===0)return;
     const allUnused=node.declarations.every(d=>d.id.type==='Identifier'&&(refs.get(d.id.name)||[]).length===0&&pure(d.init));
     if(allUnused)edits.push({start:node.start,end:node.end,text:''});
   }
 }});
 const r=applyEdits(source,selectOutermost(edits));return{code:r.code,changes:r.applied};
}
module.exports={name:'unused-scaffold',run};
