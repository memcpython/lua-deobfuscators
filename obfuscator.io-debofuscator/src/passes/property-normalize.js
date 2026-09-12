const { walk } = require('../core/ast');
const { applyEdits } = require('../core/edits');

function run(source, ast){
 const edits=[];
 walk(ast,{enter({node}){
   if(node.type!=='MemberExpression'||!node.computed||node.optional) return;
   if(node.property.type!=='Literal'||typeof node.property.value!=='string') return;
   const key=node.property.value;
   if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return;
   // Acorn does not include transparent parentheses in node.object ranges, so edit only
   // the [property] suffix instead of reconstructing the object expression.
   const open=source.lastIndexOf('[',node.property.start);
   if(open<node.start||open>=node.property.start||source.slice(node.property.end,node.end).indexOf(']')<0)return;
   edits.push({start:open,end:node.end,text:`.${key}`});
 }});
 const r=applyEdits(source,edits); return {code:r.code,changes:r.applied};
}
module.exports={name:'property-normalize',run};
