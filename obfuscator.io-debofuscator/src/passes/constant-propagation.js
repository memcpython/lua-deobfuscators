const { walk, sourceOf, isReferenceIdentifier } = require('../core/ast');
const { evaluate } = require('../core/evaluate');
const { literalToCode } = require('../core/ast');
const { applyEdits } = require('../core/edits');

function run(source,ast){
  const decls=new Map(), duplicates=new Set(), mutated=new Set();
  walk(ast,{enter({node}){
    if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init){
      const name=node.id.name; if(decls.has(name)) duplicates.add(name); else decls.set(name,node);
    }
    if(node.type==='AssignmentExpression'&&node.left.type==='Identifier') mutated.add(node.left.name);
    if(node.type==='UpdateExpression'&&node.argument.type==='Identifier') mutated.add(node.argument.name);
  }});
  const repl=new Map();
  for(const [name,d] of decls){
    if(duplicates.has(name)||mutated.has(name))continue;
    if(d.init.type==='Identifier') repl.set(name,d.init.name);
    else {const v=evaluate(d.init); if(v.confident){const code=literalToCode(v.value); if(code!=null) repl.set(name,code);}}
  }
  const edits=[]; const used=new Map();
  walk(ast,{enter({node,parent,key}){
    if(node.type!=='Identifier'||!repl.has(node.name)||!isReferenceIdentifier(node,parent,key))return;
    // Don't replace the initializer side of the declaration itself in a way that creates nonsense.
    if(parent?.type==='VariableDeclarator'&&key==='init') return;
    edits.push({start:node.start,end:node.end,text:repl.get(node.name)}); used.set(node.name,(used.get(node.name)||0)+1);
  }});
  for(const [name,d] of decls){
    if(!used.get(name)||!repl.has(name))continue;
    const vd = findVariableDeclaration(ast,d);
    if(vd && vd.declarations.length===1) edits.push({start:vd.start,end:vd.end,text:''});
  }
  const r=applyEdits(source,edits); return {code:r.code,changes:r.applied};
}
function findVariableDeclaration(ast,decl){
 let found=null; walk(ast,{enter({node}){if(node.type==='VariableDeclaration'&&node.declarations.includes(decl)) found=node;}}); return found;
}
module.exports={name:'constant-propagation',run};
