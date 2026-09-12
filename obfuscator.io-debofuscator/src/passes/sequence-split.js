const { walk, sourceOf } = require('../core/ast');
const { applyEdits } = require('../core/edits');
function run(source,ast){
 const edits=[];
 walk(ast,{enter({node,parent,key}){
   if(node.type!=='ExpressionStatement'||node.expression.type!=='SequenceExpression')return;
   const parts=node.expression.expressions.map(e=>'('+sourceOf(e,source)+');').join('\n');
   const singleStatementSlot = parent && ((parent.type==='IfStatement'&&(key==='consequent'||key==='alternate')) || (['WhileStatement','DoWhileStatement','ForStatement','ForInStatement','ForOfStatement','WithStatement','LabeledStatement'].includes(parent.type)&&key==='body'));
   edits.push({start:node.start,end:node.end,text:singleStatementSlot?`{\n${parts}\n}`:parts});
 }});
 const r=applyEdits(source,edits);return{code:r.code,changes:r.applied};
}
module.exports={name:'sequence-split',run};
