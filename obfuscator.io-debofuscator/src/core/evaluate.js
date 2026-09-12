const { propertyName } = require('./ast');

const binary = {
  '+': (a,b) => a+b, '-': (a,b) => a-b, '*': (a,b) => a*b, '/': (a,b) => a/b, '%': (a,b) => a%b,
  '**': (a,b) => a**b, '<<': (a,b) => a<<b, '>>': (a,b) => a>>b, '>>>': (a,b) => a>>>b,
  '|': (a,b) => a|b, '&': (a,b) => a&b, '^': (a,b) => a^b,
  '==': (a,b) => a==b, '!=': (a,b) => a!=b, '===': (a,b) => a===b, '!==': (a,b) => a!==b,
  '<': (a,b) => a<b, '<=': (a,b) => a<=b, '>': (a,b) => a>b, '>=': (a,b) => a>=b
};
const unary = { '+': a=>+a, '-':a=>-a, '!':a=>!a, '~':a=>~a, 'void':()=>undefined, 'typeof':a=>typeof a };

function evaluate(node, env = Object.create(null)) {
  if (!node) return { confident: false };
  try {
    switch (node.type) {
      case 'Literal': return node.regex ? { confident: false } : { confident: true, value: node.value };
      case 'Identifier':
        if (node.name === 'undefined') return { confident: true, value: undefined };
        if (node.name === 'NaN') return { confident: true, value: NaN };
        if (node.name === 'Infinity') return { confident: true, value: Infinity };
        return Object.prototype.hasOwnProperty.call(env, node.name) ? { confident: true, value: env[node.name] } : { confident: false };
      case 'UnaryExpression': {
        const a = evaluate(node.argument, env); if (!a.confident || !unary[node.operator]) return { confident: false };
        return { confident: true, value: unary[node.operator](a.value) };
      }
      case 'BinaryExpression': {
        const a=evaluate(node.left,env), b=evaluate(node.right,env); if(!a.confident||!b.confident||!binary[node.operator]) return {confident:false};
        return { confident: true, value: binary[node.operator](a.value,b.value) };
      }
      case 'LogicalExpression': {
        const a=evaluate(node.left,env); if(!a.confident) return {confident:false};
        if(node.operator==='&&') return a.value ? evaluate(node.right,env) : a;
        if(node.operator==='||') return a.value ? a : evaluate(node.right,env);
        if(node.operator==='??') return a.value == null ? evaluate(node.right,env) : a;
        return {confident:false};
      }
      case 'ConditionalExpression': {
        const t=evaluate(node.test,env); if(!t.confident) return {confident:false}; return evaluate(t.value?node.consequent:node.alternate,env);
      }
      case 'ArrayExpression': {
        const arr=[]; for(const el of node.elements){ if(!el) {arr.push(undefined);continue;} const v=evaluate(el,env); if(!v.confident)return {confident:false}; arr.push(v.value);} return {confident:true,value:arr};
      }
      case 'ObjectExpression': {
        const o={}; for(const p of node.properties){ if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed)return {confident:false}; const k=propertyName(p.key); const v=evaluate(p.value,env); if(k==null||!v.confident)return {confident:false}; o[k]=v.value;} return {confident:true,value:o};
      }
      case 'MemberExpression': {
        const obj=evaluate(node.object,env); if(!obj.confident)return {confident:false}; let key;
        if(node.computed){const k=evaluate(node.property,env);if(!k.confident)return {confident:false};key=k.value;} else key=node.property.name;
        if(obj.value == null) return {confident:false};
        return {confident:true,value:obj.value[key]};
      }
      case 'CallExpression': {
        if(node.callee.type==='MemberExpression') {
          const obj=evaluate(node.callee.object,env); if(!obj.confident)return {confident:false};
          const key=node.callee.computed ? evaluate(node.callee.property,env) : {confident:true,value:node.callee.property.name};
          if(!key.confident)return {confident:false}; const args=[]; for(const a of node.arguments){const v=evaluate(a,env);if(!v.confident)return {confident:false};args.push(v.value);}
          const allow = new Set(['split','join','slice','substring','substr','charAt','charCodeAt','toString','toUpperCase','toLowerCase','trim','concat','indexOf','includes','reverse']);
          if(!allow.has(String(key.value))) return {confident:false};
          const fn=obj.value?.[key.value]; if(typeof fn!=='function')return {confident:false}; return {confident:true,value:fn.apply(obj.value,args)};
        }
        if(node.callee.type==='Identifier') {
          const args=[]; for(const a of node.arguments){const v=evaluate(a,env);if(!v.confident)return {confident:false};args.push(v.value);}
          if(node.callee.name==='parseInt') return {confident:true,value:parseInt(...args)};
          if(node.callee.name==='parseFloat') return {confident:true,value:parseFloat(...args)};
          if(node.callee.name==='Number') return {confident:true,value:Number(...args)};
          if(node.callee.name==='String') return {confident:true,value:String(...args)};
          if(node.callee.name==='Boolean') return {confident:true,value:Boolean(...args)};
        }
        return {confident:false};
      }
      default: return { confident: false };
    }
  } catch (_) { return { confident: false }; }
}

function truthiness(node, env) {
  const r=evaluate(node,env); return r.confident ? { confident:true, value:!!r.value } : {confident:false};
}

module.exports = { evaluate, truthiness };
