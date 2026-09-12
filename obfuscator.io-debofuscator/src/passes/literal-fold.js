const { walk, literalToCode } = require('../core/ast');
const { evaluate } = require('../core/evaluate');
const { applyEdits, selectOutermost } = require('../core/edits');

const TYPES = new Set(['UnaryExpression','BinaryExpression','LogicalExpression','ConditionalExpression','MemberExpression','CallExpression']);

function run(source, ast) {
  const edits=[];
  walk(ast,{ enter({node}) {
    if(!TYPES.has(node.type)) return;
    const r=evaluate(node);
    if(!r.confident) return;
    const code=literalToCode(r.value);
    if(code == null) return;
    if(source.slice(node.start,node.end)===code) return;
    edits.push({start:node.start,end:node.end,text:code});
  }});
  const result=applyEdits(source,selectOutermost(edits));
  return { code:result.code, changes:result.applied };
}
module.exports={name:'literal-fold',run};
