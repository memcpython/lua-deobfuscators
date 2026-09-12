const { walk, sourceOf } = require('../core/ast');
const { evaluate } = require('../core/evaluate');
const { applyEdits } = require('../core/edits');

function collectConstants(ast){
 const m=new Map();
 walk(ast,{enter({node}){
   if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init){const r=evaluate(node.init);if(r.confident)m.set(node.id.name,{value:r.value,node});}
   if(node.type==='AssignmentExpression'&&node.left.type==='Identifier'){const r=evaluate(node.right);if(r.confident&&!m.has(node.left.name))m.set(node.left.name,{value:r.value,node});}
 }});return m;
}
function getSwitch(loop){
 if(loop.body.type!=='BlockStatement')return null;
 return loop.body.body.find(n=>n.type==='SwitchStatement')||null;
}
function discriminantInfo(sw){
 const d=sw.discriminant;
 if(d.type!=='MemberExpression'||d.object.type!=='Identifier')return null;
 let counter=null;
 if(d.property.type==='UpdateExpression'&&d.property.argument.type==='Identifier')counter=d.property.argument.name;
 else if(d.property.type==='Identifier')counter=d.property.name;
 else if(d.property.type==='SequenceExpression'){
   const u=d.property.expressions.find(e=>e.type==='UpdateExpression'&&e.argument.type==='Identifier'); if(u)counter=u.argument.name;
 }
 if(!counter)return null; return{states:d.object.name,counter};
}
function loopTruthy(loop){ if(loop.type==='ForStatement')return !loop.test; const r=evaluate(loop.test); return r.confident&&!!r.value; }
function run(source,ast,ctx={}){
 const constants=collectConstants(ast); const edits=[]; const recovered=[];
 walk(ast,{enter({node}){
   if(!['WhileStatement','ForStatement'].includes(node.type)||!loopTruthy(node))return;
   const sw=getSwitch(node); if(!sw)return; const info=discriminantInfo(sw); if(!info)return;
   const states=constants.get(info.states)?.value, initial=constants.get(info.counter)?.value;
   if(!Array.isArray(states)||!Number.isInteger(Number(initial)))return;
   const cases=new Map();
   for(const c of sw.cases){ if(!c.test)continue; const k=evaluate(c.test); if(!k.confident)continue; cases.set(String(k.value),c.consequent); }
   if(cases.size<2)return;
   const out=[]; let i=Number(initial), guard=0, used=0;
   while(i<states.length&&guard++<states.length+100){
     const cons=cases.get(String(states[i++])); if(!cons)break; used++;
     for(const st of cons){
       if(st.type==='ContinueStatement')continue;
       if(st.type==='BreakStatement')continue;
       out.push(sourceOf(st,source));
     }
     const last=cons[cons.length-1]; if(last&&['ReturnStatement','ThrowStatement'].includes(last.type))break;
   }
   if(used<2)return;
   edits.push({start:node.start,end:node.end,text:out.join('\n')}); recovered.push({states:info.states,counter:info.counter,blocks:used});
   if(!ctx.scaffoldNames)ctx.scaffoldNames=new Set(); ctx.scaffoldNames.add(info.states);ctx.scaffoldNames.add(info.counter);
 }});
 const r=applyEdits(source,edits);return{code:r.code,changes:r.applied,details:{recovered}};
}
module.exports={name:'control-flow',run};
