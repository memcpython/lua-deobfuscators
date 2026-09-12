const { walk, sourceOf } = require('../core/ast');
const { truthiness, evaluate } = require('../core/evaluate');
const { applyEdits, selectOutermost } = require('../core/edits');

function blockBody(node,source){
 if(!node) return '';
 if(node.type==='BlockStatement') return source.slice(node.start+1,node.end-1);
 return sourceOf(node,source);
}
function run(source,ast){
 const edits=[];
 walk(ast,{enter({node}){
   if(node.type==='IfStatement'){
     const t=truthiness(node.test); if(!t.confident)return;
     edits.push({start:node.start,end:node.end,text:t.value?blockBody(node.consequent,source):blockBody(node.alternate,source)});
   } else if(node.type==='ConditionalExpression'){
     const t=truthiness(node.test); if(!t.confident)return;
     edits.push({start:node.start,end:node.end,text:`(${sourceOf(t.value?node.consequent:node.alternate,source)})`});
   } else if(node.type==='WhileStatement'){
     const t=truthiness(node.test); if(t.confident&&!t.value) edits.push({start:node.start,end:node.end,text:''});
   } else if(node.type==='LogicalExpression'){
     const l=evaluate(node.left); if(!l.confident)return;
     if(node.operator==='&&') edits.push({start:node.start,end:node.end,text:l.value?`(${sourceOf(node.right,source)})`:JSON.stringify(l.value)});
     if(node.operator==='||') edits.push({start:node.start,end:node.end,text:l.value?JSON.stringify(l.value):`(${sourceOf(node.right,source)})`});
   }
 }});
 const r=applyEdits(source,selectOutermost(edits)); return {code:r.code,changes:r.applied};
}
module.exports={name:'dead-branch',run};
