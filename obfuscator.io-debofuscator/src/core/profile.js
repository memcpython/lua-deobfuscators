const { walk }=require('./ast');
function profile(ast,source){
 const p={nodes:0,functions:0,hexIdentifiers:0,computedProperties:0,whileLoops:0,switches:0,debuggers:0,stringLiterals:0,bytes:Buffer.byteLength(source)};
 walk(ast,{enter({node}){p.nodes++;if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))p.functions++;if(node.type==='Identifier'&&/^_0x[0-9a-f]+$/i.test(node.name))p.hexIdentifiers++;if(node.type==='MemberExpression'&&node.computed)p.computedProperties++;if(node.type==='WhileStatement')p.whileLoops++;if(node.type==='SwitchStatement')p.switches++;if(node.type==='DebuggerStatement')p.debuggers++;if(node.type==='Literal'&&typeof node.value==='string')p.stringLiterals++;}});return p;
}
module.exports={profile};
