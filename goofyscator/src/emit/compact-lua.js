import { luaNumber, luaString } from './lua.js';
import { collapseShortCircuitAnd } from '../source/short-circuit.js';

const KW=new Set(['and','break','do','else','elseif','end','false','for','function','goto','if','in','local','nil','not','or','repeat','return','then','true','until','while']);
const ident=s=>typeof s==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)&&!KW.has(s);
const L=v=>({kind:'literal',value:v}), V=n=>({kind:'var',name:`v${n}`});
function literal(v){if(v==null)return 'nil';if(typeof v==='string')return luaString(v);if(typeof v==='number')return luaNumber(v);if(typeof v==='boolean')return v?'true':'false';return 'nil';}
function eq(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function postfix(e,ctx){const s=render(e,ctx);return ['literal','binary','unary','closure','logical','table','pack_table'].includes(e?.kind)?`(${s})`:s;}
function render(e,ctx){
  if(!e)return 'nil';switch(e.kind){
    case 'literal':return literal(e.value);case 'var':case 'cell':return e.name;
    case 'table':return `{${(e.entries??[]).map(v=>render(v,ctx)).join(', ')}}`;
    case 'pack_table':{const es=(e.entries??[]).map(v=>render(v,ctx));return `{ n = ${es.length}${es.length?', '+es.join(', '):''} }`;}
    case 'call':return `${render(e.fn,ctx)}(${(e.args??[]).map(v=>render(v,ctx)).join(', ')})`;
    case 'logical':return (e.values??[]).map(v=>render(v,ctx)).join(` ${e.operator} `);
    case 'global':if(e.key.kind==='literal'&&ident(e.key.value))return e.key.value;ctx.needsGref=true;return `_GREF[${render(e.key,ctx)}]`;
    case 'upvalue':{const n=ctx.upvalueParams?.get(e.slot);return n?`${n}[1]`:'nil';}
    case 'index':{const o=postfix(e.table,ctx);if(e.key.kind==='literal'&&ident(e.key.value))return `${o}.${e.key.value}`;return `${o}[${render(e.key,ctx)}]`;}
    case 'binary':{const opnd=v=>v?.kind==='logical'?`(${render(v,ctx)})`:render(v,ctx);return `(${opnd(e.left)} ${e.operator} ${opnd(e.right)})`;}
    case 'unary':return e.operator==='not'?`not (${render(e.value,ctx)})`:`${e.operator}(${render(e.value,ctx)})`;
    case 'logical':return e.values.map(v=>render(v,ctx)).join(` ${e.operator} `);
    case 'closure':if(ctx.inlinePackIds.has(e.prototype))return `function(...) return { n = select("#", ...), ... } end`;if(ctx.renderClosure){const r=ctx.renderClosure(e.prototype,e.bindings??[]);if(r)return r;}return `function(...) return P_${e.prototype}(...) end`;
  }return 'nil';
}
function fromValue(v,state,varFor=V){if(v?.kind==='literal')return L(v.value);if(v?.kind==='reg')return state.get(v.index)??varFor(v.index);if(v?.kind==='table')return {kind:'table',entries:(v.entries??[]).map(e=>fromValue(e,state,varFor))};return L(null);}
function callCode(fn,args,ctx){
  if(fn?.kind==='index'&&fn.key?.kind==='literal'&&ident(fn.key.value)&&args.length&&eq(fn.table,args[0])){
    return `${postfix(fn.table,ctx)}:${fn.key.value}(${args.slice(1).map(a=>render(a,ctx)).join(', ')})`;
  }
  const f=fn?.kind==='closure'?`(${render(fn,ctx)})`:render(fn,ctx);return `${f}(${args.map(a=>render(a,ctx)).join(', ')})`;
}
function valueReadsReg(v,r){
  if(!v||typeof v!=='object')return false;
  if(v.kind==='reg'&&v.index===r)return true;
  for(const k of ['table','key','value','left','right','fn','cell','src','condition'])if(valueReadsReg(v[k],r))return true;
  for(const k of ['entries','args','values'])for(const e of v[k]??[])if(valueReadsReg(e,r))return true;
  return false;
}
function instructionReadsReg(x,r){
  if(!x)return false;
  for(const k of ['src','left','right','value','key','condition','fn'])if(valueReadsReg(x[k],r))return true;
  for(const k of ['entries','args','values'])for(const e of x[k]??[])if(valueReadsReg(e,r))return true;
  switch(x.op){
    case 'gettable':return x.table===r;
    case 'cell_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'cell_get':case 'return_cell':return x.cell===r;
    case 'cell_set':return x.cell===r;
    case 'move_pair':return x.secondSrc===r;
    case 'identity_results':return r>=x.sourceBase&&r<x.sourceBase+x.count;
    case 'closure':return (x.upvalues??[]).some(b=>b.kind===0&&b.index===r);
    case 'call':case 'tailcall':return x.base===r||(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount);
    case 'return':return x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count;
    default:return false;
  }
}
export function canCompactProgram(input){const {program:p}=collapseShortCircuitAnd(input);for(const x of p.instructions){if(x.op==='nop')continue;
  if(['jump','branch_false','forprep','forloop','tforloop','setglobal','settable','setlist','newtable','clear_range','vararg','self','close','vm_internal','if','numeric_for','generic_for','while_true','repeat_until','vararg_setlist','source_label','if_chain','table_record','table_vararg'].includes(x.op))return false;
  if(x.op==='call'&&(x.argCount<0||x.resultCount<0))return false;if(x.op==='tailcall'&&x.argCount<0)return false;if(x.op==='return'&&x.open)return false;
  if(x.op==='closure'&&(x.upvalues?.length??0)!==0)return false;
}return true;}
export function emitCompactProgram(input,{inlinePackIds=new Set(),upvalueParams=new Map(),header=null,renderClosure=null,asChunk=false}={}){
  const {program:p}=collapseShortCircuitAnd(input),ctx={inlinePackIds,upvalueParams,renderClosure,needsGref:false};const state=new Map(),declared=new Set(),lines=[];
  let nextCell=0,nextVar=0;const varNames=new Map(),varName=r=>{if(!varNames.has(r))varNames.set(r,`v${nextVar++}`);return varNames.get(r);},VR=r=>({kind:'var',name:varName(r)});
  const FV=v=>fromValue(v,state,VR),AF=a=>astFrom(a,state,VR);
  const params=Array.from({length:p.paramCount},(_,i)=>`a${i}`),ups=[...upvalueParams.values()];if(!asChunk)lines.push(header??`P_${p.id}=function(${[...ups,...params].join(',')}${ups.length||params.length?',':''}...)`);for(let i=0;i<p.paramCount;i++)state.set(i,{kind:'var',name:`a${i}`});
  const declareResults=(base,n,code)=>{const names=Array.from({length:n},(_,i)=>varName(base+i));const allNew=names.every(nm=>!declared.has(nm));if(allNew){lines.push(`  local ${names.join(', ')} = ${code}`);for(const nm of names)declared.add(nm);}else{for(const nm of names)if(!declared.has(nm)){lines.push(`  local ${nm}`);declared.add(nm)}lines.push(`  ${names.join(', ')} = ${code}`);}for(let i=0;i<n;i++)state.set(base+i,VR(base+i));};
  const instructions=p.instructions??[];
  for(let xi=0;xi<instructions.length;xi++){const x=instructions[xi];if(x.op==='nop')continue;switch(x.op){
    case 'source_local':{
      const name=varName(x.dst),value=AF(x.value);
      if(!declared.has(name)){lines.push(`  local ${name} = ${render(value,ctx)}`);declared.add(name);}else lines.push(`  ${name} = ${render(value,ctx)}`);
      state.set(x.dst,VR(x.dst));break;
    }
    case 'source_local_multi':{
      const targets=x.targets??[],vals=(x.values??[]).map(v=>AF(v)),names=targets.map(varName);
      for(const nm of names)if(declared.has(nm))return null;
      lines.push(`  local ${names.join(', ')} = ${vals.map(v=>render(v,ctx)).join(', ')}`);
      for(let i=0;i<targets.length;i++){declared.add(names[i]);state.set(targets[i],VR(targets[i]));}
      break;
    }
    case 'move':state.set(x.dst,FV(x.src));break;
    case 'getglobal':state.set(x.dst,{kind:'global',key:FV(x.key)});break;
    case 'getupval':state.set(x.dst,{kind:'upvalue',slot:x.slot});break;
    case 'cell_new':{
      const name=`c${nextCell++}`,value=FV(x.src);lines.push(`  local ${name} = ${render(value,ctx)}`);const cell={kind:'cell',name};state.set(x.dst,cell);for(let i=1;i<Math.max(1,x.resultCount??1);i++)state.set(x.dst+i,L(null));break;
    }
    case 'cell_results':{
      const n=Math.max(0,x.resultCount??x.count),sourceCount=Math.min(x.count,x.sourceCount??x.count);for(let i=0;i<n;i++){
        if(i>=x.count){state.set(x.base+i,L(null));continue;}
        const value=i<sourceCount?(state.get(x.sourceBase+i)??VR(x.sourceBase+i)):L(null);
        if(x.mask?.[i]==='1'){const name=`c${nextCell++}`;lines.push(`  local ${name} = ${render(value,ctx)}`);state.set(x.base+i,{kind:'cell',name});}else state.set(x.base+i,value);
      }break;
    }
    case 'cell_get':{const cell=state.get(x.cell);if(cell?.kind!=='cell')return null;state.set(x.dst,{kind:'var',name:cell.name});for(let i=1;i<Math.max(1,x.resultCount??1);i++)state.set(x.dst+i,L(null));break;}
    case 'cell_set':{const cell=state.get(x.cell);if(cell?.kind!=='cell')return null;lines.push(`  ${cell.name} = ${render(FV(x.value),ctx)}`);break;}
    case 'gettable':state.set(x.dst,{kind:'index',table:state.get(x.table)??V(x.table),key:FV(x.key)});break;
    case 'table_literal':state.set(x.dst,{kind:'table',entries:(x.entries??[]).map(v=>FV(v))});break;
    case 'unary':state.set(x.dst,{kind:'unary',operator:x.operator,value:FV(x.value)});break;
    case 'binary':state.set(x.dst,{kind:'binary',operator:x.operator,left:FV(x.left),right:FV(x.right)});break;
    case 'logical_chain':state.set(x.dst,{kind:'logical',operator:x.operator,values:x.values.map(a=>AF(a))});break;
    case 'source_call':{const fn=AF(x.fn),args=(x.args??[]).map(a=>AF(a)),code=callCode(fn,args,ctx);if(x.resultCount===0)lines.push(`  ${code}`);else declareResults(x.base,x.resultCount,code);break;}
    case 'move_pair':{const a=FV(x.src),b=state.get(x.secondSrc)??VR(x.secondSrc);state.set(x.dst,a);state.set(x.secondDst,b);break;}
    case 'identity_results':{const vals=[];for(let i=0;i<x.count;i++)vals.push(state.get(x.sourceBase+i)??VR(x.sourceBase+i));const n=x.resultCount<0?x.count:x.resultCount;for(let i=0;i<n;i++)state.set(x.base+i,vals[i]??L(null));break;}
    case 'constant_call':state.set(x.base,FV(x.value));break;
    case 'closure':{
      const closure={kind:'closure',prototype:x.prototype,bindings:x.upvalues??[]};
      const name=varName(x.dst),code=render(closure,ctx);
      if(!declared.has(name)&&code.startsWith('function(')){
        const [head,...body]=code.split('\n');
        lines.push(`  local function ${name}${head.slice('function'.length)}`);
        for(const line of body)lines.push(`  ${line}`);
        declared.add(name);
      }else if(!declared.has(name)){
        lines.push(`  local ${name} = ${code}`);declared.add(name);
      }else lines.push(`  ${name} = ${code}`);
      state.set(x.dst,VR(x.dst));break;
    }
    case 'call':{
      const fn=state.get(x.base)??VR(x.base),args=[];for(let i=1;i<=x.argCount;i++)args.push(state.get(x.base+i)??VR(x.base+i));
      if(fn?.kind==='closure'&&ctx.inlinePackIds.has(fn.prototype)&&x.resultCount===1){declareResults(x.base,1,render({kind:'pack_table',entries:args},ctx));break;}
      // Lua compilers stage nested call results in registers.  If a fixed one-
      // result call is consumed exactly once by the immediately following call
      // on the same source line, keep it as an AST call expression.  This is
      // source reconstruction, not constant evaluation: the call itself stays.
      if(x.resultCount===1&&Number.isFinite(x.sourceLine)){
        let ni=xi+1;while(ni<instructions.length&&instructions[ni].op==='nop')ni++;
        const next=instructions[ni],r=x.base;
        const nextConsumesAsArg=next&&(next.op==='call'||next.op==='tailcall')&&next.argCount>=0&&next.sourceLine===x.sourceLine&&r>next.base&&r<=next.base+next.argCount;
        const readLater=nextConsumesAsArg&&instructions.slice(ni+1).some(y=>instructionReadsReg(y,r));
        if(nextConsumesAsArg&&!readLater){state.set(r,{kind:'call',fn,args});break;}
      }
      const code=callCode(fn,args,ctx);if(x.resultCount===0)lines.push(`  ${code}`);else declareResults(x.base,x.resultCount,code);break;
    }
    case 'tailcall':{const fn=state.get(x.base)??VR(x.base),args=[];for(let i=1;i<=x.argCount;i++)args.push(state.get(x.base+i)??VR(x.base+i));lines.push(`  return ${callCode(fn,args,ctx)}`);break;}
    case 'return':if(!x.hasValues)lines.push('  return');else{const vals=[];for(let i=0;i<x.count;i++)vals.push(render(state.get(x.base+i)??VR(x.base+i),ctx));lines.push(`  return ${vals.join(', ')}`);}break;
    case 'return_literal':lines.push(`  return ${render(FV(x.value),ctx)}`);break;
    case 'return_cell':{const cell=state.get(x.cell);if(cell?.kind!=='cell')return null;lines.push(`  return ${cell.name}`);break;}
    default:return null;
  }}if(!asChunk)lines.push('end');const out=asChunk?lines.map(s=>s.startsWith('  ')?s.slice(2):s):lines;return {code:out.join('\n'),needsGref:ctx.needsGref};
}
function astFrom(a,state,varFor=V){
  if(!a)return L(null);if(a.kind==='reg')return state.get(a.index)??varFor(a.index);if(a.kind==='literal')return L(a.value);
  if(a.kind==='global')return {kind:'global',key:astFrom(a.key,state,varFor)};if(a.kind==='index')return {kind:'index',table:astFrom(a.table,state,varFor),key:astFrom(a.key,state,varFor)};
  if(a.kind==='unary')return {kind:'unary',operator:a.operator,value:astFrom(a.value,state,varFor)};if(a.kind==='binary')return {kind:'binary',operator:a.operator,left:astFrom(a.left,state,varFor),right:astFrom(a.right,state,varFor)};
  if(a.kind==='logical')return {kind:'logical',operator:a.operator,values:(a.values??[]).map(v=>astFrom(v,state,varFor))};
  if(a.kind==='table')return {kind:'table',entries:(a.entries??[]).map(v=>astFrom(v,state,varFor))};
  if(a.kind==='call')return {kind:'call',fn:astFrom(a.fn,state,varFor),args:(a.args??[]).map(v=>astFrom(v,state,varFor))};
  if(a.kind==='cell_read')return astFrom(a.cell,state,varFor);
  if(a.kind==='upvalue_ref')return {kind:'upvalue',slot:a.slot};
  return L(null);
}
