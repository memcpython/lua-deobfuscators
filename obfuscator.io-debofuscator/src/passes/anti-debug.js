const { walk, sourceOf } = require('../core/ast');
const { applyEdits, selectOutermost } = require('../core/edits');

function suspicious(node,source){
 const s=sourceOf(node,source);
 return /debugger/.test(s) && (/(constructor\s*\(|Function\s*\()/.test(s) || /setInterval|setTimeout/.test(s));
}
function run(source,ast){
 const edits=[];
 walk(ast,{enter({node,parent}){
   if(node.type==='DebuggerStatement') edits.push({start:node.start,end:node.end,text:''});
   if(node.type==='ExpressionStatement' && suspicious(node,source) && node.end-node.start<2500) edits.push({start:node.start,end:node.end,text:''});
 }});
 const r=applyEdits(source,selectOutermost(edits)); return {code:r.code,changes:r.applied};
}
module.exports={name:'anti-debug',run};
