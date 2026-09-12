import { WATERMARK } from '../config.js';
import { emitLua, luaNumber, luaString } from './lua.js';
import { maxRegisterIndex } from '../ir/registers.js';
import { collapseShortCircuitAnd } from '../source/short-circuit.js';
import { canCompactProgram, emitCompactProgram } from './compact-lua.js';
import { structureLoops } from '../source/loops.js';
import { lowerSourceOpenValues } from '../source/open-values.js';
import { structureConditionals } from '../source/conditionals.js';
import { structureWhiles } from '../source/whiles.js';
import { cleanupSourceCfg } from '../source/cleanup.js';
import { recoverTableLiterals } from '../source/table-literals.js';
import { collapseStructuredLogical } from '../source/structured-logical.js';
import { collapseConditionalValues } from '../source/conditional-values.js';
import { pruneUnusedUpvalueBindings } from '../source/upvalues.js';
import { recoverRecordLiterals } from '../source/record-literals.js';
import { recoverClosureRecordLiterals } from '../source/closure-records.js';
import { collapseCallFrames } from '../source/call-frames.js';
import { recoverVarargTables } from '../source/vararg-tables.js';
import { collapseClosureMoveChains } from '../source/closure-moves.js';
import { recoverRecursiveClosures } from '../source/recursive-closures.js';
import { trimTerminalEmptyReturn } from '../source/terminal-return.js';
import { collapseWritebackTemps } from '../source/writeback.js';
import { inlineCapturedTableHelpers } from '../source/helper-inline.js';
import { hoistRepeatedLiterals } from '../source/literal-hoist.js';
import { splitSourceLifetimes } from '../source/lifetime-split.js';
import { recoverTerminalGuards } from '../source/terminal-guards.js';
import { recoverLexicalLocals } from '../source/lexical-locals.js';
import { recoverSourceLocalExpressions } from '../source/local-expressions.js';
import { recoverSameLineCallExpressions } from '../source/call-expressions.js';
import { dropTerminalCloses } from '../source/terminal-close.js';
import { recoverClosedLifetimes } from '../source/close-lifetimes.js';
import { eliminateJoinGotos } from '../source/join-gotos.js';
import { recoverDirectSourceConstructs } from '../source/direct-constructs.js';
import { pruneDeadSourceMoves } from '../source/dead-moves.js';
import { SOURCE_EMITTER_IR_OPCODE_SET } from '../ir/opcode-contract.js';

const KEYWORDS=new Set(['and','break','do','else','elseif','end','false','for','function','goto','if','in','local','nil','not','or','repeat','return','then','true','until','while']);
const ident=s=>typeof s==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)&&!KEYWORDS.has(s);
// Apply a transformation only to Lua code, never to quoted string contents or
// line comments.  The final synthetic-local compactor used to regex the whole
// emitted line, so user data such as "(v0)" was mistaken for an identifier and
// could create phantom locals or rewrite string contents.
function mapLuaCodeSegments(text,transform){
  let out='',start=0,i=0;
  const flush=end=>{if(end>start)out+=transform(text.slice(start,end));};
  while(i<text.length){
    const ch=text[i];
    if(ch==='"'||ch==="'"){
      flush(i);const quote=ch;let j=i+1;
      while(j<text.length){
        if(text[j]==='\\'){j=Math.min(text.length,j+2);continue;}
        if(text[j]===quote){j++;break;}
        j++;
      }
      out+=text.slice(i,j);i=j;start=i;continue;
    }
    if(ch==='-'&&text[i+1]==='-'){
      flush(i);out+=text.slice(i);return out;
    }
    i++;
  }
  flush(text.length);return out;
}
function lit(v){
  if(v==null)return 'nil'; if(typeof v==='string')return luaString(v); if(typeof v==='number')return luaNumber(v); if(typeof v==='boolean')return v?'true':'false'; return 'nil';
}
function isVarargPack(p){
  const xs=p.instructions.filter(x=>x.op!=='nop'); if(!xs.length)return false;
  const nt=xs.find(x=>x.op==='newtable'); if(!nt)return false; const t=nt.dst;
  const gg=xs.find(x=>x.op==='getglobal'&&x.key?.kind==='literal'&&x.key.value==='select'); if(!gg)return false;
  const call=xs.find(x=>x.op==='call'&&x.base===gg.dst&&x.resultCount===1); if(!call||call.argCount>=0)return false;
  const hash=xs.find(x=>x.op==='move'&&x.dst===gg.dst+1&&x.src?.kind==='literal'&&x.src.value==='#');if(!hash)return false;
  const before=xs.find(x=>x.op==='vararg'&&x.count<0&&x.base===gg.dst+2);if(!before)return false;
  const field=xs.find(x=>x.op==='settable'&&x.table===t&&x.key?.kind==='literal'&&x.key.value==='n'&&x.value?.kind==='reg'&&x.value.index===gg.dst);if(!field)return false;
  const sl=xs.find(x=>x.op==='setlist'&&x.table===t&&x.open);if(!sl)return false;
  const va=xs.find(x=>x.op==='vararg'&&x.count<0&&x.base===sl.from);if(!va)return false;
  const ret=xs.find(x=>x.op==='return'&&x.hasValues&&!x.open&&x.count===1&&x.base===t);return !!ret;
}
export function prepareDirect(input,{callFrames=true}={}){
  const records=recoverRecordLiterals(input).program;
  // Folding record fields can make the VM's value-staging MOVE dead. Remove
  // only straight-line moves proven overwritten before any read, otherwise a
  // compiler temporary becomes a spurious source local.
  const recordMoves=pruneDeadSourceMoves(records).program;
  const closureRecords=recoverClosureRecordLiterals(recordMoves).program;
  const tables=recoverTableLiterals(closureRecords).program;
  const short=collapseShortCircuitAnd(tables).program;
  const open=lowerSourceOpenValues(short).program;
  const varargTables=recoverVarargTables(open).program;
  const closureMoves=collapseClosureMoveChains(varargTables).program;
  const recursiveClosures=recoverRecursiveClosures(closureMoves).program;
  const writebacks=collapseWritebackTemps(recursiveClosures).program;
  const loops=structureLoops(writebacks);
  const cond=structureConditionals(loops.program).program;
  const whiles=structureWhiles(cond).program;
  const cleaned=cleanupSourceCfg(whiles).program;
  const joinGotos=eliminateJoinGotos(cleaned).program;
  const logical=collapseStructuredLogical(joinGotos).program;
  const framed=callFrames?collapseCallFrames(logical).program:logical;
  const lifetimes=splitSourceLifetimes(framed).program;
  const conditionalValues=collapseConditionalValues(lifetimes).program;
  // Conditional-value recovery can expose new fixed-arity call frames (most
  // notably recursive tail calls whose argument expression previously crossed
  // a lowered branch). Run the same proven local slicer to a fixed point at
  // source level rather than leaving those argument registers staged.
  const reframed=callFrames?collapseCallFrames(conditionalValues).program:conditionalValues;
  const callExpressions=recoverSameLineCallExpressions(reframed).program;
  const relifetimes=splitSourceLifetimes(callExpressions).program;
  // Rebuild source lexical bindings before literal CSE/pretty recovery.  The VM
  // optimizer keeps constant-provenance tags specifically so this stage can
  // undo over-aggressive propagation where a value was a genuine reused local.
  const lexicalLocals=recoverLexicalLocals(relifetimes).program;
  const localExpressions=recoverSourceLocalExpressions(lexicalLocals).program;
  const hoisted=hoistRepeatedLiterals(localExpressions).program;
  const terminalGuards=recoverTerminalGuards(hoisted).program;
  const trimmed=trimTerminalEmptyReturn(terminalGuards).program;
  const closedLifetimes=recoverClosedLifetimes(trimmed).program;
  const terminalClosed=dropTerminalCloses(closedLifetimes).program;
  const directConstructs=recoverDirectSourceConstructs(terminalClosed).program;
  return {...loops,program:directConstructs};
}
function walkInstructions(xs,fn){for(const x of xs){fn(x);if(x.setup)walkInstructions(x.setup,fn);if(x.body)walkInstructions(x.body,fn);if(x.thenBody)walkInstructions(x.thenBody,fn);if(x.elseBody)walkInstructions(x.elseBody,fn);if(x.branches)for(const b of x.branches)walkInstructions(b.body??[],fn);}}
function usesOwnVarargs(program){let yes=false;walkInstructions(program.instructions??[],x=>{if(x.op==='vararg'||x.op==='vararg_setlist'||x.op==='table_vararg'||x.sourceVarargArgs||x.sourceVarargReturn)yes=true;});return yes;}
function functionParams(program,names){const va=usesOwnVarargs(program);return `${names.join(',')}${va?(names.length?',':'')+'...':''}`;}
function sourceValueReadCount(v,r){
  if(!v)return 0;if(v.kind==='reg')return v.index===r?1:0;if(v.kind==='table')return (v.entries??[]).reduce((n,e)=>n+sourceValueReadCount(e,r),0);
  if(v.kind==='index')return sourceValueReadCount(v.table,r)+sourceValueReadCount(v.key,r);if(v.kind==='unary')return sourceValueReadCount(v.value,r);
  if(v.kind==='binary')return sourceValueReadCount(v.left,r)+sourceValueReadCount(v.right,r);if(v.kind==='global')return sourceValueReadCount(v.key,r);
  if(v.kind==='call')return sourceValueReadCount(v.fn,r)+(v.args??[]).reduce((n,a)=>n+sourceValueReadCount(a,r),0);
  if(v.kind==='logical')return (v.values??[]).reduce((n,a)=>n+sourceValueReadCount(a,r),0);
  if(v.kind==='cell_read')return sourceValueReadCount(v.cell,r);
  return 0;
}
function sourceImmediateReadCount(x,r){
  if(!x)return 0;let n=0;for(const v of [x.src,x.left,x.right,x.value,x.key,x.condition])n+=sourceValueReadCount(v,r);for(const v of x.entries??[])n+=sourceValueReadCount(v,r);for(const v of x.values??[])n+=sourceValueReadCount(v,r);
  switch(x.op){
    case 'move_pair':n+=x.secondSrc===r?1:0;break;case 'gettable':n+=x.table===r?1:0;break;case 'settable':n+=x.table===r?1:0;break;case 'setglobal':n+=x.src===r?1:0;break;case 'self':n+=x.dst===r?1:0;break;
    case 'setlist':n+=x.table===r?1:0;n+=r>=x.from&&r<=x.to?1:0;break;
    case 'call':case 'tailcall':if(x.base===r)n++;if(x.argCount>=0&&r>x.base&&r<=x.base+x.argCount)n++;break;
    case 'source_call':case 'source_tailcall':n+=sourceValueReadCount(x.fn,r);for(const a of x.args??[])n+=sourceValueReadCount(a,r);break;
    case 'source_table_mutation':for(const a of x.args??[])n+=sourceValueReadCount(a,r);break;
    case 'return':if(x.hasValues&&!x.open&&r>=x.base&&r<x.base+x.count)n++;break;case 'return_cell':n+=x.cell===r?1:0;break;
    case 'cell_new':n+=sourceValueReadCount(x.src,r);break;case 'cell_results':n+=r>=x.sourceBase&&r<x.sourceBase+x.count?1:0;break;case 'cell_get':n+=x.cell===r?1:0;break;case 'cell_set':n+=x.cell===r?1:0;break;
    case 'identity_results':n+=r>=x.sourceBase&&r<x.sourceBase+x.count?1:0;break;case 'closure':for(const b of x.upvalues??[])if(b.kind===0&&b.index===r)n++;break;
    case 'table_closure_record':for(const f of x.fields??[])for(const b of f.upvalues??[])if(b.kind===0&&b.index===r)n++;break;
    case 'numeric_for':n+=(x.index===r?1:0)+(x.limit===r?1:0)+(x.step===r?1:0);break;case 'generic_for':n+=x.iterator?sourceValueReadCount(x.iterator,r):(x.base===r?1:0)+(x.base+1===r?1:0)+(x.control===r?1:0);break;
    case 'source_method_call':n+=sourceValueReadCount(x.receiver,r)+sourceValueReadCount(x.key,r);for(const a of x.args??[])n+=sourceValueReadCount(a,r);break;
  }
  if(x.op==='if_chain')for(const b of x.branches??[])n+=sourceValueReadCount(b.condition,r);
  return n;
}
function sourceDeepReadCount(x,r){let n=sourceImmediateReadCount(x,r);for(const k of ['setup','body','thenBody','elseBody'])for(const y of x?.[k]??[])n+=sourceDeepReadCount(y,r);for(const b of x?.branches??[])for(const y of b.body??[])n+=sourceDeepReadCount(y,r);return n;}
function sourceDeepWrites(xs,r){for(const x of xs??[]){if(sourceWritesRegister(x,r))return true;for(const k of ['setup','body','thenBody','elseBody'])if(sourceDeepWrites(x?.[k],r))return true;for(const b of x?.branches??[])if(sourceDeepWrites(b.body,r))return true;}return false;}
function sourceWritesRegister(x,r){
  if(!x)return false;if(x.dst===r||x.secondDst===r)return true;if(x.op==='self'&&r===x.dst+1)return true;
  switch(x.op){case 'clear_range':return r>=x.from&&r<=x.to;case 'call':case 'source_call':case 'identity_results':case 'cell_results':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'cell_new':case 'cell_get':return r>=x.dst&&r<x.dst+Math.max(1,x.resultCount??1);case 'constant_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;
    case 'vararg':return x.count>0&&r>=x.base&&r<x.base+x.count;case 'numeric_for':return x.index===r;case 'generic_for':return r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);case 'source_method_call':return x.resultCount>0&&r>=x.base&&r<x.base+x.resultCount;case 'source_local':return x.dst===r;case 'source_local_multi':return (x.targets??[]).includes(r);default:return false;}
}
function sourceFlowForIncoming(x,r){
  if(!x)return {read:false,kill:false};if(sourceImmediateReadCount(x,r)>0)return {read:true,kill:false};if(sourceWritesRegister(x,r))return {read:false,kill:true};
  if(x.op==='if'){
    const t=sourceSequenceFlow(x.thenBody??[],0,r),hasElse=(x.elseBody?.length??0)>0,e=hasElse?sourceSequenceFlow(x.elseBody,0,r):{read:false,kill:false};
    return {read:t.read||e.read,kill:hasElse&&t.kill&&e.kill};
  }
  if(x.op==='if_chain'){
    const flows=(x.branches??[]).map(b=>sourceSequenceFlow(b.body??[],0,r));flows.push(sourceSequenceFlow(x.elseBody??[],0,r));
    return {read:flows.some(f=>f.read),kill:flows.length>0&&flows.every(f=>f.kill)};
  }
  if(x.op==='while_true'){
    const setup=sourceSequenceFlow(x.setup??[],0,r);if(setup.read)return {read:true,kill:false};const body=sourceSequenceFlow(x.body??[],0,r);return {read:body.read,kill:false};
  }
  if(x.op==='repeat_until'){
    const body=sourceSequenceFlow(x.body??[],0,r);return {read:body.read||sourceValueReadCount(x.condition,r)>0,kill:false};
  }
  if(x.op==='numeric_for'||x.op==='generic_for'){
    const body=sourceSequenceFlow(x.body??[],0,r);return {read:body.read,kill:false};
  }
  return {read:false,kill:false};
}
function sourceSequenceFlow(xs,start,r){for(let i=start;i<xs.length;i++){const f=sourceFlowForIncoming(xs[i],r);if(f.read)return {read:true,kill:false};if(f.kill)return {read:false,kill:true};}return {read:false,kill:false};}
function sourceReadBeforeWrite(xs,start,r){return sourceSequenceFlow(xs,start,r).read;}
// Count static reads until the next possible write.  This is intentionally
// conservative across structured regions: over-counting only keeps a source
// local alive, while under-counting would duplicate a value that the original
// bytecode deliberately kept in a register/local.
function sourceReadCountUntilWrite(xs,start,r){
  let reads=0;
  for(let i=start;i<xs.length;i++){
    const x=xs[i];
    reads+=sourceDeepReadCount(x,r);
    if(sourceWritesRegister(x,r)||sourceDeepWrites([x],r))break;
  }
  return reads;
}
function canDirect(p){
  const {program}=prepareDirect(p);let ok=true;
  walkInstructions(program.instructions,x=>{if(!ok)return;
    if(!SOURCE_EMITTER_IR_OPCODE_SET.has(x.op))ok=false;
    else if(x.op==='call'&&(x.argCount<0||x.resultCount<0||x.sourceOpenResult))ok=false;
    else if(x.op==='tailcall'&&x.argCount<0)ok=false;
    else if(x.op==='return'&&x.open)ok=false;
    else if(x.op==='vararg'&&x.count<0)ok=false;
    else if(x.op==='setlist'&&x.open)ok=false;
    else if(['forprep','forloop','tforloop','close'].includes(x.op))ok=false;
  });return ok;
}




function emitNestedBundle(bundle,watermark,{scalarCells=true}={}){
  const byId=new Map(bundle.programs.map(p=>[p.id,p])),lines=[watermark,''];
  let needsGref=false,nextScope=1,nextCell=0,nextPlainTable=0,nextLoop=0,nextGeneric=0,nextVarargLoop=0;
  const scalarError=(message,x)=>{const e=new Error(`${message}${x?.pc!=null?` at pc ${x.pc}`:''}`);e.code='CELL_SCALAR_UNSAFE';throw e;};
  const mergeCellStates=(target,states)=>{
    const keys=new Set();for(const s of states)for(const k of s.keys())keys.add(k);
    target.clear();
    for(const k of keys){const first=states[0]?.get(k);if(first!=null&&states.every(s=>s.get(k)===first))target.set(k,first);}
  };
  const identifiersInUpvalues=upvalues=>{const out=new Set();for(const u of upvalues.values()){const text=u?.cell??u?.expr;if(typeof text!=='string')continue;for(const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g))out.add(m[0]);}return out;};
  const roleParams=(child,scopeId,childUps,role=null)=>{
    const reserved=identifiersInUpvalues(childUps),names=[];
    let neutral=0;const claim=preferred=>{if(preferred&&!reserved.has(preferred)&&!names.includes(preferred)){names.push(preferred);return;}let c;do c=`p${neutral++}`;while(reserved.has(c)||names.includes(c));names.push(c);};
    for(let i=0;i<child.paramCount;i++){if(role==='metamethod-call'&&i===0)claim('self');else if(role==='iterator'&&i===0)claim('state');else if(role==='iterator'&&i===1)claim('control');else claim(null);}
    return names;
  };
  const renderProgram=(input,{upvalues=new Map(),level=0,scopeId=0,header='function(...)',asChunk=false,paramNames=null}={})=>{
    const prepared=prepareDirect(input),p=prepared.program,pad='  '.repeat(level);
    let localLoopSerial=0,localGenericSerial=0,localVarargSerial=0;
    // A Lua parameter already *is* the mutable local occupying that VM
    // register.  Reusing the parameter register later does not require a
    // synthetic vN copy: assignments can target the parameter local itself.
    // Mapping every formal register directly also keeps closure captures of a
    // parameter lexical, instead of manufacturing an extra alias cell.
    const stableParams=new Set(Array.from({length:p.paramCount},(_,r)=>r));
    const paramName=r=>paramNames?.[r]??(scopeId===0?`p${r}`:`p${scopeId}_${r}`);
    const max=maxRegisterIndex(p);
    // Physical VM register numbers have no lexical meaning.  Allocate source
    // local ids by first semantic appearance inside this scope instead of
    // leaking sparse/random register indices such as v13/v41 into recovered
    // Lua.  Scope prefixes stay unique so a nested local can never shadow a
    // captured outer symbol accidentally.
    const sourceOrder=[],seenSourceRegs=new Set();
    const noteSourceReg=r=>{if(Number.isInteger(r)&&r>=0&&!stableParams.has(r)&&!seenSourceRegs.has(r)){seenSourceRegs.add(r);sourceOrder.push(r);}};
    walkInstructions(p.instructions??[],ins=>{for(let r=0;r<=max;r++)if(sourceWritesRegister(ins,r)||sourceImmediateReadCount(ins,r)>0)noteSourceReg(r);});
    const denseByReg=new Map(sourceOrder.map((r,i)=>[r,i])),regByDense=new Map(sourceOrder.map((r,i)=>[i,r])),preferredNames=new Map();
    const rawRead=r=>{
      if(stableParams.has(r))return paramName(r);
      if(preferredNames.has(r))return preferredNames.get(r);
      if(!denseByReg.has(r)){const id=denseByReg.size;denseByReg.set(r,id);regByDense.set(id,r);}
      const id=denseByReg.get(r);return scopeId===0?`v${id}`:`v${scopeId}_${id}`;
    };
    // Recover lexical declarations when a VM register's first occurrence in
    // this function is an ordinary top-level write. Registers touched inside a
    // structured child region, read before their first write, or self-captured
    // by a closure stay predeclared so Lua scope/recursion semantics are exact.
    const localizable=new Set(),touched=new Set();
    const structuredOps=new Set(['if','if_chain','numeric_for','generic_for','while_true','repeat_until']);
    for(const ins of p.instructions??[]){
      if(structuredOps.has(ins.op)){
        for(let r=0;r<=max;r++)if(sourceDeepReadCount(ins,r)||sourceDeepWrites([ins],r))touched.add(r);
        continue;
      }
      for(let r=0;r<=max;r++){
        if(touched.has(r)||stableParams.has(r))continue;
        const rd=sourceImmediateReadCount(ins,r),wr=sourceWritesRegister(ins,r);
        if(rd){touched.add(r);continue;}
        if(wr){touched.add(r);localizable.add(r);}
      }
    }
    // Assign names only for roles guaranteed by Lua control-flow semantics.
    // Unknown source variables intentionally stay vN; we never infer names from
    // corpus fixtures or string constants.
    const claimPreferred=(r,name)=>{if(localizable.has(r)&&!stableParams.has(r)&&![...preferredNames.values()].includes(name))preferredNames.set(r,name);};
    const top=p.instructions??[];
    // Lexical roles exposed directly by recovered source constructs.
    for(let i=0;i<top.length;i++){
      const ins=top[i];
      if(ins.op==='closure'&&String(ins.optimizedFrom??'').includes('source-recursive-closure')&&![...preferredNames.values()].includes('recurse'))preferredNames.set(ins.dst,'recurse');
      if(ins.op==='table_vararg'){
        let r=ins.dst;
        for(let j=i+1;j<top.length;j++){
          const y=top[j];
          if(y.op==='move'&&y.src?.kind==='reg'&&y.src.index===r){r=y.dst;continue;}
          if(sourceImmediateReadCount(y,r)||sourceWritesRegister(y,r))break;
        }
        claimPreferred(r,'args');
      }
    }
    for(let i=0;i<top.length;i++){
      const loop=top[i];if(loop.op!=='generic_for')continue;
      claimPreferred(loop.base+1,'state');
      // Follow pure MOVE aliases backwards from the iterator register to the
      // recovered closure that created it.
      let want=loop.base;
      for(let j=i-1;j>=0;j--){const y=top[j];if(!sourceWritesRegister(y,want))continue;if(y.op==='move'&&y.src?.kind==='reg'){want=y.src.index;continue;}if(y.op==='closure'&&y.dst===want)claimPreferred(want,'iterator');break;}
      // A loop-carried register that is both read and written by the body and
      // observed after the loop is an accumulator role, regardless of what it
      // represents in the original application.
      let accN=0;
      for(const r of localizable){
        if(r===loop.base||r===loop.base+1||r===loop.control||(r>=loop.resultBase&&r<loop.resultBase+loop.resultCount))continue;
        if(sourceDeepReadCount({op:'holder',body:loop.body??[]},r)&&sourceDeepWrites(loop.body??[],r)&&sourceReadBeforeWrite(top,i+1,r))claimPreferred(r,accN++===0?'acc':`acc${accN}`);
      }
    }
    const inlineDeclared=new Set();
    const rawWrite=(r,e)=>{const name=rawRead(r);if(localizable.has(r)&&!inlineDeclared.has(r)){inlineDeclared.add(r);return `local ${name}=${e}`;}return `${name}=${e}`;};
    const rawReg=(r,state,x,why='raw register use')=>{if(scalarCells&&state.has(r))scalarError(`${why} observes wrapper identity in r${r}`,x);return rawRead(r);};
    const plainRegs=new Map();
    const freshPlainTable=()=>({id:++nextPlainTable,plain:true});
    const escapePlain=r=>{const t=plainRegs.get(r);if(t)t.plain=false;};
    const val=(v,state,x)=>v?.kind==='reg'?rawReg(v.index,state,x,'value expression'):v?.kind==='literal'?lit(v.value):v?.kind==='table'?`{${(v.entries??[]).map(e=>val(e,state,x)).join(', ')}}`:'nil';
    const globalGet=(v,state,x)=>{if(v?.kind==='literal'&&ident(v.value))return v.value;needsGref=true;return `_GREF[${val(v,state,x)}]`;};
    const globalSet=(v,e,state,x)=>{if(v?.kind==='literal'&&ident(v.value))return `${v.value}=${e}`;needsGref=true;return `_GREF[${val(v,state,x)}]=${e}`;};
    const bin=(x,state)=>x.operator==='//'?`math.floor(${val(x.left,state,x)} / ${val(x.right,state,x)})`:`(${val(x.left,state,x)} ${x.operator} ${val(x.right,state,x)})`;
    const args=(base,n,state,x)=>Array.from({length:n},(_,i)=>rawReg(base+i+1,state,x,'call argument')).join(', ');
    const regs=(base,n,state,x)=>Array.from({length:n},(_,i)=>rawReg(base+i,state,x,'result/return value')).join(', ');
    const dsts=(base,n,state)=>{for(let i=0;i<n;i++)state.delete(base+i);return Array.from({length:n},(_,i)=>rawRead(base+i)).join(', ');};
    const assign=(r,e,state)=>{state.delete(r);return rawWrite(r,e);};
    const astValue=(a,state,x)=>{
      if(!a)return 'nil';if(a.kind==='reg')return rawReg(a.index,state,x,'logical expression');if(a.kind==='literal')return lit(a.value);
      if(a.kind==='global')return a.key?.kind==='literal'&&ident(a.key.value)?a.key.value:`_GREF[${astValue(a.key,state,x)}]`;
      if(a.kind==='index')return `${astValue(a.table,state,x)}[${astValue(a.key,state,x)}]`;
      if(a.kind==='unary')return a.operator==='not'?`not (${astValue(a.value,state,x)})`:`${a.operator}(${astValue(a.value,state,x)})`;
      if(a.kind==='binary')return `(${astValue(a.left,state,x)} ${a.operator} ${astValue(a.right,state,x)})`;
      if(a.kind==='table')return `{${(a.entries??[]).map(e=>astValue(e,state,x)).join(', ')}}`;
      if(a.kind==='call')return `${astValue(a.fn,state,x)}(${(a.args??[]).map(e=>astValue(e,state,x)).join(', ')})`;
      if(a.kind==='logical')return (a.values??[]).map(e=>astValue(e,state,x)).join(` ${a.operator} `);
      if(a.kind==='cell_read'){
        const rr=a.cell?.kind==='reg'?a.cell.index:null;if(rr!=null&&state.has(rr))return state.get(rr);
        if(a.cell?.kind==='upvalue_ref'){const u=upvalues.get(a.cell.slot);if(scalarCells&&u?.cell)return u.cell;return `${u?.expr??u?.cell??'nil'}.value`;}
        return `${astValue(a.cell,state,x)}.value`;
      }
      if(a.kind==='upvalue_ref'){const u=upvalues.get(a.slot);return u?.cell??u?.expr??'nil';}
      return 'nil';
    };
    if(!asChunk)lines.push(`${pad}${header}`);
    if(isVarargPack(input)){lines.push(`${pad}${asChunk?'':'  '}return { n = select("#", ...), ... }`);if(!asChunk)lines.push(`${pad}end`);return;}
    const bodyPad=asChunk?pad:`${pad}  `;
    // Reserve the declaration line and fill it after rendering this lexical
    // scope.  Source recovery removes most VM temporaries; declaring the old
    // max-register range would preserve bytecode noise even when no emitted
    // statement refers to those registers anymore.  The scope-specific name
    // pattern deliberately includes nested child bodies so captures remain
    // declared in their lexical owner.
    const declarationIndex=lines.length;lines.push(null);
    for(let r=0;r<p.paramCount;r++)if(!stableParams.has(r))lines.push(`${bodyPad}${rawWrite(r,paramName(r))}`);

    const all=[];walkInstructions(p.instructions,x=>all.push(x));
    const present=new Set(all.map(x=>x.pc).filter(x=>x!=null)),neededLabels=new Set(),missing=new Set();let useEnd=false;
    for(const x of all)if(x.target!=null){if(x.target===prepared.end)useEnd=true;else if(present.has(x.target))neededLabels.add(x.target);else missing.add(x.target);}

    const emitSeq=(xs,lev,state,liveOut=()=>false,initialAliases=null)=>{
      const ip='  '.repeat(lev),aliases=new Map();
      const cloneSet=s=>new Set(s??[]),makeExpr=(code,regDeps=[],cellDeps=[],tableDeps=[])=>({code,regDeps:new Set(regDeps),cellDeps:new Set(cellDeps),tableDeps:new Set(tableDeps)});
      if(initialAliases)for(const [r,a] of initialAliases)aliases.set(r,{...a,regDeps:cloneSet(a.regDeps),cellDeps:cloneSet(a.cellDeps),tableDeps:cloneSet(a.tableDeps)});
      const exprReg=r=>{if(scalarCells&&state.has(r))scalarError(`wrapper identity used as ordinary value in r${r}`);const a=aliases.get(r);return a?{code:a.code,regDeps:cloneSet(a.regDeps),cellDeps:cloneSet(a.cellDeps),tableDeps:cloneSet(a.tableDeps)}:makeExpr(rawRead(r),[r]);};
      const exprValue=(v,x)=>v?.kind==='reg'?exprReg(v.index):v?.kind==='literal'?makeExpr(lit(v.value)):v?.kind==='table'?makeExpr(`{${(v.entries??[]).map(e=>exprValue(e,x).code).join(', ')}}`):v?.kind?makeExpr(astLocal(v,x)):makeExpr('nil');
      const materialize=r=>{const a=aliases.get(r);if(!a)return;lines.push(`${ip}${rawWrite(r,a.code)}`);aliases.delete(r);};
      const materializeRegDependents=r=>{let changed=true;while(changed){changed=false;for(const [dst,a] of [...aliases])if(a.regDeps.has(r)){materialize(dst);changed=true;}}};
      const materializeCellDependents=c=>{for(const [dst,a] of [...aliases])if(a.cellDeps.has(c))materialize(dst);};
      const materializeTableDependents=(token,except=new Set())=>{for(const [dst,a] of [...aliases])if(a.tableDeps?.has(token)&&!except.has(dst))materialize(dst);};
      const materializeAllTableDependents=()=>{for(const [dst,a] of [...aliases])if(a.tableDeps?.size)materialize(dst);};
      const materializeAll=()=>{for(const r of [...aliases.keys()])materialize(r);};
      const pruneDeadAliases=start=>{for(const r of [...aliases.keys()])if(!sourceReadBeforeWrite(xs,start,r))aliases.delete(r);};
      // A freshly-created source value can stay symbolic when its VM register
      // has exactly one straight-line read before the register is overwritten.
      // This is deliberately stricter than ordinary liveness: crossing a
      // structured region would move allocation/evaluation across control flow.
      const singleStraightLineReadBeforeWrite=(start,r)=>{
        let reads=0;
        for(let i=start;i<xs.length;i++){
          const y=xs[i];
          if(['if','numeric_for','generic_for','while_true','repeat_until'].includes(y?.op)){
            if(sourceDeepReadCount(y,r)||sourceDeepWrites([y],r))return false;
            continue;
          }
          reads+=sourceImmediateReadCount(y,r);if(reads>1)return false;
          if(sourceWritesRegister(y,r))break;
        }
        return reads===1;
      };
      // Preserve the time/order of effectful Lua operations, but allow a
      // global value to remain symbolic across construction of fresh local
      // tables/closures.  No user code can run in this window: SETTABLE is
      // admitted only for a table allocated inside the same window.
      const canDeferGlobalLookup=(start,r)=>{
        const fresh=new Set();
        for(let i=start;i<xs.length;i++){
          const y=xs[i];if(!y||y.op==='nop')continue;
          const reads=sourceImmediateReadCount(y,r);
          if(reads)return reads===1;
          if(sourceWritesRegister(y,r))return false;
          if(['if','numeric_for','generic_for','while_true','repeat_until','call','source_call','tailcall','getglobal','setglobal','gettable','self','unary','binary','logical_chain'].includes(y.op))return false;
          if(['newtable','table_literal','table_record','table_closure_record','table_vararg'].includes(y.op)){fresh.add(y.dst);continue;}
          if(y.op==='move'){
            if(y.src?.kind==='reg'&&fresh.has(y.src.index))fresh.add(y.dst);else fresh.delete(y.dst);
            continue;
          }
          if(y.op==='closure')continue;
          if(y.op==='settable'){if(!fresh.has(y.table))return false;continue;}
          if(y.op==='setlist'){if(!fresh.has(y.table))return false;continue;}
          if(y.op==='clear_range'||y.op==='identity_results'||y.op==='constant_call')continue;
          return false;
        }
        return false;
      };
      const canDeferClosureRecord=(start,r,captures)=>{
        for(let i=start;i<xs.length;i++){
          const y=xs[i];if(!y||y.op==='nop')continue;
          if(['if','numeric_for','generic_for','while_true','repeat_until'].includes(y.op))return false;
          for(const c of captures)if(sourceWritesRegister(y,c))return false;
          const reads=sourceImmediateReadCount(y,r);if(reads)return reads===1;
          if(sourceWritesRegister(y,r))return false;
          // Only source-pure staging can sit between constructor creation and
          // its sole use.  This keeps closure creation on the same observable
          // side of calls/global lookups/metamethod-capable operations.
          if(['move','clear_range','newtable','table_literal','table_record','table_closure_record','closure','setlist'].includes(y.op))continue;
          return false;
        }
        return false;
      };
      const killRaw=r=>{materializeRegDependents(r);aliases.delete(r);state.delete(r);plainRegs.delete(r);};
      const setAlias=(r,e)=>{materializeRegDependents(r);aliases.delete(r);state.delete(r);aliases.set(r,e);};
      const setRaw=(r,e)=>{killRaw(r);return rawWrite(r,e);};
      const valueCode=(v,x)=>exprValue(v,x).code;
      const recordCode=x=>`{${(x.fields??[]).map(f=>f.key?.kind==='literal'&&ident(f.key.value)?`${f.key.value}=${valueCode(f.value,x)}`:`[${lit(f.key?.value)}]=${valueCode(f.value,x)}`).join(', ')}}`;
      const globalGetLocal=(v,x)=>{if(v?.kind==='literal'&&ident(v.value))return v.value;needsGref=true;return `_GREF[${valueCode(v,x)}]`;};
      const globalSetLocal=(v,e,x)=>{if(v?.kind==='literal'&&ident(v.value))return `${v.value}=${e}`;needsGref=true;return `_GREF[${valueCode(v,x)}]=${e}`;};
      const astLocal=(a,x)=>{
        if(!a)return 'nil';if(a.kind==='reg')return exprReg(a.index).code;if(a.kind==='literal')return lit(a.value);
        if(a.kind==='global')return a.key?.kind==='literal'&&ident(a.key.value)?a.key.value:`_GREF[${astLocal(a.key,x)}]`;
        if(a.kind==='index'){const b=astLocal(a.table,x);return a.key?.kind==='literal'&&ident(a.key.value)?`${b}.${a.key.value}`:`${b}[${astLocal(a.key,x)}]`;}
        if(a.kind==='unary')return a.operator==='not'?`not (${astLocal(a.value,x)})`:`${a.operator}(${astLocal(a.value,x)})`;
        if(a.kind==='binary'){const opnd=v=>v?.kind==='logical'?`(${astLocal(v,x)})`:astLocal(v,x);return `(${opnd(a.left)} ${a.operator} ${opnd(a.right)})`;}
        if(a.kind==='table')return `{${(a.entries??[]).map(e=>astLocal(e,x)).join(', ')}}`;
        if(a.kind==='call')return sourceCallCode(a.fn,a.args??[],x);
        if(a.kind==='logical')return (a.values??[]).map(e=>astLocal(e,x)).join(` ${a.operator} `);
        if(a.kind==='cell_read'){
          const rr=a.cell?.kind==='reg'?a.cell.index:null;if(rr!=null&&state.has(rr))return state.get(rr);
          if(a.cell?.kind==='upvalue_ref'){const u=upvalues.get(a.cell.slot);if(scalarCells&&u?.cell)return u.cell;return `${u?.expr??u?.cell??'nil'}.value`;}
          return `${astLocal(a.cell,x)}.value`;
        }
        if(a.kind==='upvalue_ref'){const u=upvalues.get(a.slot);return u?.cell??u?.expr??'nil';}
        return 'nil';
      };
      const sameAst=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const postfixAst=(a,x)=>{const code=astLocal(a,x);return ['literal','binary','unary','logical','call','table'].includes(a?.kind)?`(${code})`:code;};
      const sourceCallCode=(fn,args,x)=>{
        if(fn?.kind==='index'&&fn.key?.kind==='literal'&&ident(fn.key.value)&&args.length&&sameAst(fn.table,args[0])){
          return `${postfixAst(fn.table,x)}:${fn.key.value}(${args.slice(1).map(a=>astLocal(a,x)).join(', ')})`;
        }
        return `${astLocal(fn,x)}(${args.map(a=>astLocal(a,x)).join(', ')})`;
      };
      const binaryCode=x=>x.operator==='//'?`math.floor(${valueCode(x.left,x)} / ${valueCode(x.right,x)})`:`(${valueCode(x.left,x)} ${x.operator} ${valueCode(x.right,x)})`;
      const argsCode=(base,n,x)=>Array.from({length:n},(_,i)=>exprReg(base+i+1).code).join(', ');
      const resultsCode=(base,n,x)=>Array.from({length:n},(_,i)=>exprReg(base+i).code).join(', ');
      const resultAssignment=(rs,code)=>{
        for(const r of rs)killRaw(r);
        const canLocal=rs.length>0&&rs.every(r=>localizable.has(r)&&!inlineDeclared.has(r));
        if(canLocal)for(const r of rs)inlineDeclared.add(r);
        return `${canLocal?'local ':''}${rs.map(rawRead).join(', ')}=${code}`;
      };
      const crossesSourceLine=(xi,line)=>{
        if(!Number.isFinite(line))return false;
        for(let j=xi+1;j<xs.length;j++){
          const y=xs[j];
          if(!y||y.op==='nop'||y.op==='move'||y.op==='move_pair'||y.op==='identity_results'||y.op==='constant_call')continue;
          // Stop at the first semantic consumer/statement.  An instruction with
          // no line metadata (for example SETTABLE receiving a call result) is
          // part of the current expression lowering, so looking *past* it to a
          // later RETURN/statement would manufacture a temporary that never
          // existed in source.  Distinct explicit call lines still form a hard
          // lexical boundary.
          return Number.isFinite(y.sourceLine)&&y.sourceLine!==line;
        }
        return false;
      };
      const forwardOneStep=(dst,code,xi)=>{
        const next=xs[xi+1];if(!next||sourceImmediateReadCount(next,dst)!==1)return false;
        const supported=new Set(['binary','unary','gettable','settable','cell_set','call','tailcall','return','if','logical_chain','numeric_for']);if(!supported.has(next.op))return false;
        const overwritten=sourceWritesRegister(next,dst);if(!overwritten&&next.op!=='return'&&next.op!=='tailcall'&&sourceReadBeforeWrite(xs,xi+2,dst))return false;
        const e=makeExpr(code);e.expireAt=xi+1;setAlias(dst,e);return true;
      };
      const immediateMoveTarget=(dst,xi)=>{
        const next=xs[xi+1];
        if(next?.op!=='move'||next.secondDst!=null||next.src?.kind!=='reg'||next.src.index!==dst)return null;
        if(sourceImmediateReadCount(next,dst)!==1||sourceReadBeforeWrite(xs,xi+2,dst)||state.has(next.dst))return null;
        return next.dst;
      };
      const forwardUnaryToLoop=(dst,code,xi,valueExpr)=>{
        const deps=new Set(valueExpr?.regDeps??[]);
        for(let j=xi+1;j<xs.length;j++){
          const y=xs[j],reads=sourceImmediateReadCount(y,dst);
          if(reads){
            if(reads!==1||y.op!=='numeric_for')return false;
            const e=makeExpr(code,deps);e.expireAt=j;setAlias(dst,e);return true;
          }
          if(sourceWritesRegister(y,dst))return false;
          for(const r of deps)if(sourceWritesRegister(y,r))return false;
          if(y.op!=='move'&&y.op!=='move_pair')return false;
        }
        return false;
      };
      for(let xi=0;xi<xs.length;xi++){
        const x=xs[xi];
        if(neededLabels.has(x.pc))lines.push(`${ip}::L_${x.pc}::`);
        if(x.op==='nop')continue;
        if(x.op==='numeric_for'){
          pruneDeadAliases(xi);plainRegs.clear();
          // Literal/copy aliases that exist only to feed the numeric-for
          // preheader can be consumed directly in the native loop header.
          // If a control register is observed after the loop, materialize it
          // first so its snapshot semantics remain exact.
          const headerValue=(r,why,{mustPreserve=false}={})=>{
            const a=aliases.get(r),postLive=sourceReadBeforeWrite(xs,xi+1,r);
            if(a&&!mustPreserve&&!postLive){const code=a.code;aliases.delete(r);return code;}
            if(a)materialize(r);return rawReg(r,state,x,why);
          };
          const startCode=headerValue(x.index,'numeric for index',{mustPreserve:x.preserveIndex});
          const limitCode=headerValue(x.limit,'numeric for limit');
          const stepCode=headerValue(x.step,'numeric for step',{mustPreserve:x.preserveIndex});
          materializeAll();const loopId=localLoopSerial++,ran=`_ran${loopId}`,iv=['i','j','k'][loopId]??`i${loopId}`,before=new Map(state),bodyState=new Map(state);bodyState.delete(x.index);
          if(x.preserveIndex){
            { const loopHeader=stepCode==='1'?`${startCode},${limitCode}`:`${startCode},${limitCode},${stepCode}`; lines.push(`${ip}do`,`${ip}  local ${ran}=false`,`${ip}  for ${iv}=${loopHeader} do`,`${ip}    ${ran}=true`,`${ip}    ${assign(x.index,iv,bodyState)}`);
            emitSeq(x.body,lev+2,bodyState,()=>true);lines.push(`${ip}  end`,`${ip}  if ${ran} then ${rawWrite(x.index,`${rawRead(x.index)}+${rawRead(x.step)}`)} end`,`${ip}end`); }
          }else{
            let capturesIndex=false;walkInstructions(x.body,y=>{if(y.op==='closure'&&(y.upvalues??[]).some(b=>b.kind===0&&b.index===x.index))capturesIndex=true;});
            const loopHeader=stepCode==='1'?`${startCode},${limitCode}`:`${startCode},${limitCode},${stepCode}`;
            lines.push(`${ip}for ${iv}=${loopHeader} do`);
            if(capturesIndex){lines.push(`${ip}  ${assign(x.index,iv,bodyState)}`);emitSeq(x.body,lev+1,bodyState,()=>true);}
            else{
              const seed=new Map([[x.index,makeExpr(iv)]]);
              // Do not materialize compiler temporaries merely because an
              // iteration ends. Keep only values that flow into the next
              // iteration (read before their first body write) or escape to
              // code after the loop. This avoids fake locals such as `v=i`
              // created from SETTABLE/index staging registers.
              const keepLoopValue=r=>r!==x.index&&(sourceReadBeforeWrite(x.body,0,r)||sourceReadBeforeWrite(xs,xi+1,r));
              emitSeq(x.body,lev+1,bodyState,keepLoopValue,seed);
            }
            lines.push(`${ip}end`);
          }
          mergeCellStates(state,[before,bodyState]);state.delete(x.index);continue;
        }
        if(x.op==='generic_for'){
          pruneDeadAliases(xi);plainRegs.clear();
          const headerValue=r=>{const a=aliases.get(r);if(a&&!sourceReadBeforeWrite(xs,xi+1,r)){const c=a.code;aliases.delete(r);return c;}if(a)materialize(r);return rawReg(r,state,x,'generic for header');};
          if(x.iterator){
            // A generic-for iterator expression may reference a table/local
            // that is reused by later loops. Do not inline a deferred alias
            // into the first header when that source binding remains live.
            for(const r of [...aliases.keys()])if(sourceValueReadCount(x.iterator,r)&&sourceReadBeforeWrite(xs,xi+1,r))materialize(r);
          }
          const iteratorExpr=x.iterator?astLocal(x.iterator,x):null;
          const iteratorCode=iteratorExpr??headerValue(x.base),stateCode=iteratorExpr?null:headerValue(x.base+1),controlCode=iteratorExpr?null:headerValue(x.control);
          materializeAll();const genericId=localGenericSerial++,vars=Array.from({length:x.resultCount},(_,i)=>i===0?'control':i===1?'value':`value${i}`),before=new Map(state),bodyState=new Map(state),seed=new Map();
          let captured=false;walkInstructions(x.body,y=>{if(y.op==='closure')for(const b of y.upvalues??[])if(b.kind===0&&(b.index===x.control||(b.index>=x.resultBase&&b.index<x.resultBase+x.resultCount)))captured=true;});
          lines.push(`${ip}for ${vars.join(',')} in ${iteratorExpr?iteratorCode:`${iteratorCode},${stateCode},${controlCode}`} do`);
          if(captured){for(let i=0;i<x.resultCount;i++){bodyState.delete(x.resultBase+i);lines.push(`${ip}  ${rawWrite(x.resultBase+i,vars[i])}`);}if(vars.length){bodyState.delete(x.control);lines.push(`${ip}  ${rawWrite(x.control,vars[0])}`);}emitSeq(x.body,lev+1,bodyState,()=>true);}
          else{
            for(let i=0;i<x.resultCount;i++){bodyState.delete(x.resultBase+i);seed.set(x.resultBase+i,makeExpr(vars[i]));}
            if(vars.length){bodyState.delete(x.control);seed.set(x.control,makeExpr(vars[0]));}
            // The structurer has proved these control/result registers do not
            // escape the generic-for.  Treat the lexical loop variables as
            // body-only aliases so emitSeq does not materialize pointless VM
            // register snapshots at the end of every iteration.
            const loopOnly=r=>r===x.control||(r>=x.resultBase&&r<x.resultBase+x.resultCount);
            emitSeq(x.body,lev+1,bodyState,r=>!loopOnly(r),seed);
          }
          lines.push(`${ip}end`);mergeCellStates(state,[before,bodyState]);state.delete(x.control);for(let i=0;i<x.resultCount;i++)state.delete(x.resultBase+i);continue;
        }
        if(x.op==='while_true'){
          pruneDeadAliases(xi);plainRegs.clear();materializeAll();const before=new Map(state),loopState=new Map(state);
          if(!(x.setup?.length)){
            lines.push(`${ip}while ${astLocal(x.condition,x)} do`);emitSeq(x.body,lev+1,loopState,()=>true);lines.push(`${ip}end`);
          }else{
            lines.push(`${ip}while true do`);emitSeq(x.setup,lev+1,loopState,()=>true);lines.push(`${ip}  if not ${astLocal(x.condition,x)} then break end`);emitSeq(x.body,lev+1,loopState,()=>true);lines.push(`${ip}end`);
          }
          mergeCellStates(state,[before,loopState]);continue;
        }
        if(x.op==='repeat_until'){
          pruneDeadAliases(xi);plainRegs.clear();materializeAll();const before=new Map(state),loopState=new Map(state);
          lines.push(`${ip}repeat`);
          emitSeq(x.body??[],lev+1,loopState,()=>true);
          lines.push(`${ip}until ${astLocal(x.condition,x)}`);
          mergeCellStates(state,[before,loopState]);continue;
        }
        if(x.op==='if_chain'){
          plainRegs.clear();pruneDeadAliases(xi);materializeAll();
          const before=new Map(state),branchStates=[],branchLive=r=>sourceReadBeforeWrite(xs,xi+1,r);
          for(let bi=0;bi<(x.branches??[]).length;bi++){
            const branch=x.branches[bi],branchState=new Map(state),keyword=bi===0?'if':'elseif';
            lines.push(`${ip}${keyword} ${valueCode(branch.condition,branch)} then`);
            emitSeq(branch.body??[],lev+1,branchState,branchLive);branchStates.push(branchState);
          }
          const elseState=new Map(state);lines.push(`${ip}else`);emitSeq(x.elseBody??[],lev+1,elseState,branchLive);branchStates.push(elseState);lines.push(`${ip}end`);
          mergeCellStates(state,branchStates.length?branchStates:[before]);continue;
        }
        if(x.op==='if'){
          plainRegs.clear();
          const condition=valueCode(x.condition,x);if(x.condition?.kind==='reg'&&aliases.get(x.condition.index)?.expireAt===xi)aliases.delete(x.condition.index);pruneDeadAliases(xi);
          // Keep only effect-free aliases that are completely invisible to the
          // branch and whose dependencies cannot be assigned on either path.
          // This preserves a source-level copy across structured control flow
          // without moving indexing/arithmetic/calls across the branch.
          const branchBodies=[x.thenBody??[],x.elseBody??[]],carry=new Set();
          for(const [r,a] of aliases){
            if(a.cellDeps?.size||a.tableDeps?.size||sourceValueReadCount(x.condition,r)>0)continue;
            if(branchBodies.some(b=>b.some(y=>sourceDeepReadCount(y,r))||sourceDeepWrites(b,r)))continue;
            let depWrite=false;for(const d of a.regDeps??[])if(branchBodies.some(b=>sourceDeepWrites(b,d))){depWrite=true;break;}
            if(!depWrite)carry.add(r);
          }
          for(const r of [...aliases.keys()])if(!carry.has(r))materialize(r);
          const before=new Map(state),thenState=new Map(state),elseState=new Map(state),branchLive=r=>sourceReadBeforeWrite(xs,xi+1,r);
          if(!(x.thenBody?.length)&&x.elseBody?.length){lines.push(`${ip}if not ${condition} then`);emitSeq(x.elseBody,lev+1,elseState,branchLive);lines.push(`${ip}end`);mergeCellStates(state,[before,elseState]);continue;}
          lines.push(`${ip}if ${condition} then`);emitSeq(x.thenBody,lev+1,thenState,branchLive);if(x.elseBody?.length){lines.push(`${ip}else`);emitSeq(x.elseBody,lev+1,elseState,branchLive);}lines.push(`${ip}end`);mergeCellStates(state,[thenState,x.elseBody?.length?elseState:before]);continue;
        }
        if(x.op==='vararg_setlist'){pruneDeadAliases(xi);materializeAll();rawReg(x.table,state,x,'vararg table');const vi=localVarargSerial++===0?'i':`i${localVarargSerial}`;lines.push(`${ip}for ${vi}=1,select("#",...) do ${rawRead(x.table)}[${vi}]=select(${vi},...) end`);continue;}
        if(x.op==='closure'){
          // Drop symbolic values whose lifetime ends at this closure write
          // before capture/materialization logic inspects their dependencies.
          // Otherwise an alias already consumed by a preceding table/call can
          // be spuriously materialized just because the physical VM register
          // is about to be reused for the new closure.
          pruneDeadAliases(xi);
          const next=xs[xi+1];
          const inlineSet=next?.op==='settable'&&next.value?.kind==='reg'&&next.value.index===x.dst&&sourceImmediateReadCount(next,x.dst)===1&&!sourceReadBeforeWrite(xs,xi+2,x.dst);
          const inlineMove=next?.op==='move'&&next.src?.kind==='reg'&&next.src.index===x.dst&&sourceImmediateReadCount(next,x.dst)===1&&!sourceReadBeforeWrite(xs,xi+2,x.dst);
          const inlineReturn=next?.op==='return'&&next.hasValues&&!next.open&&next.count===1&&next.base===x.dst&&sourceImmediateReadCount(next,x.dst)===1;
          if(!inlineSet&&!inlineMove&&!inlineReturn&&!sourceReadBeforeWrite(xs,xi+1,x.dst))continue;
          for(const b of x.upvalues??[])if(b.kind===0&&!state.has(b.index)){materializeRegDependents(b.index);materialize(b.index);}
          materializeRegDependents(x.dst);aliases.delete(x.dst);state.delete(x.dst);
          if(inlineMove){materializeRegDependents(next.dst);aliases.delete(next.dst);state.delete(next.dst);}
          if(x.prototype==null){
            const rhs=`function() error(${luaString(x.error??'missing prototype')},0) end`;
            if(inlineSet){const tb=exprReg(next.table).code,key=next.key?.kind==='literal'&&ident(next.key.value)?`.${next.key.value}`:`[${valueCode(next.key,next)}]`;lines.push(`${ip}${tb}${key}=${rhs}`);xi++;}
            else if(inlineMove){lines.push(`${ip}${rawWrite(next.dst,rhs)}`);xi++;}
            else if(inlineReturn){lines.push(`${ip}return ${rhs}`);xi++;}
            else lines.push(`${ip}${rawWrite(x.dst,rhs)}`);continue;
          }
          const child=byId.get(x.prototype);if(!child)throw new Error(`Missing recovered prototype ${x.prototype}`);
          const redeclareClosure=(x.sourceRedeclare??[]).includes(x.dst);
          const childUps=new Map();for(const b of x.upvalues??[]){if(b.kind===0){const cell=scalarCells?state.get(b.index):null,plain=plainRegs.get(b.index);childUps.set(b.slot,cell?{cell}:{expr:rawRead(b.index),...(plain?.plain?{plainTable:plain}:{})});}else childUps.set(b.slot,upvalues.get(b.index)??{expr:'nil'});}
          const childScope=nextScope++;
          let childRole=null;
          if(inlineSet&&next?.key?.kind==='literal'&&next.key.value==='__call')childRole='metamethod-call';
          if(!childRole){
            const closureAliases=new Set([x.dst]);
            for(let j=xi+1;j<xs.length&&closureAliases.size;j++){
              const y=xs[j];if(y?.op==='generic_for'&&closureAliases.has(y.base)){childRole='iterator';break;}
              if(y?.op==='move'&&y.src?.kind==='reg'&&closureAliases.has(y.src.index)){closureAliases.add(y.dst);continue;}
              for(const r of [...closureAliases])if(sourceWritesRegister(y,r))closureAliases.delete(r);
            }
          }
          const ps=roleParams(child,childScope,childUps,childRole);
          let target,localClosureName=null,directFunctionTarget=null;
          if(inlineSet){
            const tb=exprReg(next.table).code,key=next.key?.kind==='literal'&&ident(next.key.value)?`.${next.key.value}`:`[${valueCode(next.key,next)}]`;
            target=`${tb}${key}`;
            if(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(target))directFunctionTarget=target;
          }
          else if(inlineMove)target=rawRead(next.dst);
          else if(inlineReturn)target='return ';
          else {
            const name=rawRead(x.dst),recursive=String(x.optimizedFrom??'').includes('source-recursive-closure');
            if(redeclareClosure){inlineDeclared.add(x.dst);target=name;}
            else if((localizable.has(x.dst)&&!inlineDeclared.has(x.dst))||recursive){inlineDeclared.add(x.dst);localClosureName=name;target=name;}else target=name;
          }
          const fp=functionParams(child,ps),sig=inlineReturn?`return function(${fp})`:redeclareClosure?`local ${target}=function(${fp})`:localClosureName?`local function ${localClosureName}(${fp})`:directFunctionTarget?`function ${directFunctionTarget}(${fp})`:`${target}=function(${fp})`;
          renderProgram(child,{upvalues:childUps,level:lev,scopeId:childScope,header:sig,paramNames:ps});if(inlineSet||inlineMove||inlineReturn)xi++;continue;
        }
        let q=[];
        switch(x.op){
          case 'source_local':{
            const e=exprValue(x.value,x);materializeRegDependents(x.dst);aliases.delete(x.dst);state.delete(x.dst);plainRegs.delete(x.dst);
            inlineDeclared.add(x.dst);q.push(`local ${rawRead(x.dst)}=${e.code}`);break;
          }
          case 'source_local_multi':{
            const targets=x.targets??[],values=x.values??[];
            for(const r of targets){materializeRegDependents(r);aliases.delete(r);state.delete(r);plainRegs.delete(r);inlineDeclared.add(r);}
            q.push(`local ${targets.map(rawRead).join(',')}=${values.map(v=>exprValue(v,x).code).join(',')}`);break;
          }
          case 'move':{
            const pt=x.src?.kind==='reg'?plainRegs.get(x.src.index):null;
            if(x.sourceDeadLocal){
              const e=exprValue(x.src,x);
              materializeRegDependents(x.dst);aliases.delete(x.dst);state.delete(x.dst);plainRegs.delete(x.dst);
              // Emit this declaration unconditionally. The same physical VM
              // register may back separate source locals in sibling loop
              // bodies, so a function-wide "already declared" check would
              // incorrectly erase later lexical declarations.
              q.push(`local ${rawRead(x.dst)}=${e.code}`);
              break;
            }
            const redeclare=(x.sourceRedeclare??[]).includes(x.dst);
            if(redeclare){const e=exprValue(x.src,x);materializeRegDependents(x.dst);aliases.delete(x.dst);state.delete(x.dst);plainRegs.delete(x.dst);inlineDeclared.add(x.dst);q.push(`local ${rawRead(x.dst)}=${e.code}`);if(pt?.plain)plainRegs.set(x.dst,pt);break;}
            if(scalarCells&&x.src?.kind==='reg'&&state.has(x.src.index)){materializeRegDependents(x.dst);aliases.delete(x.dst);plainRegs.delete(x.dst);state.set(x.dst,state.get(x.src.index));break;}
            const e=exprValue(x.src,x);
            // A literal used repeatedly is source data, not call-frame staging.
            // Keep one local binding instead of cloning the literal into each
            // downstream expression.  This is especially important for long
            // strings and tables where duplication makes decompiled source
            // look unlike the lexical program even though semantics match.
            if(x.src?.kind==='literal'&&typeof x.src.value==='string'&&x.src.value.length>=8&&sourceReadCountUntilWrite(xs,xi+1,x.dst)>1){q.push(setRaw(x.dst,e.code));}
            else setAlias(x.dst,e);
            if(pt?.plain)plainRegs.set(x.dst,pt);else plainRegs.delete(x.dst);break;
          }
          case 'clear_range':for(let r=x.from;r<=x.to;r++)q.push(setRaw(r,'nil'));break;
          case 'getglobal':{
            const code=globalGetLocal(x.key,x);
            if(forwardOneStep(x.dst,code,xi))break;
            if(canDeferGlobalLookup(xi+1,x.dst)){setAlias(x.dst,makeExpr(code));break;}
            q.push(setRaw(x.dst,code));break;
          }
          case 'setglobal':materializeAllTableDependents();escapePlain(x.src);q.push(globalSetLocal(x.key,exprReg(x.src).code,x));break;
          case 'getupval':{
            const u=upvalues.get(x.slot);if(scalarCells&&u?.cell){materializeRegDependents(x.dst);aliases.delete(x.dst);plainRegs.delete(x.dst);state.set(x.dst,u.cell);break;}
            setAlias(x.dst,makeExpr(u?.expr??(typeof u==='string'?u:'nil')));if(u?.plainTable?.plain)plainRegs.set(x.dst,u.plainTable);else plainRegs.delete(x.dst);break;
          }
          case 'newtable':{
            const token=freshPlainTable(),next=xs[xi+1],code='{}';plainRegs.set(x.dst,token);if((next?.op==='cell_results'||next?.op==='move')&&sourceImmediateReadCount(next,x.dst)===1&&!sourceReadBeforeWrite(xs,xi+2,x.dst)){const e=makeExpr(code);e.expireAt=xi+1;setAlias(x.dst,e);plainRegs.set(x.dst,token);}else{q.push(setRaw(x.dst,code));plainRegs.set(x.dst,token);}break;
          }
          case 'table_literal':{
            const token=freshPlainTable(),code=`{${(x.entries??[]).map(v=>valueCode(v,x)).join(', ')}}`,next=xs[xi+1];plainRegs.set(x.dst,token);if((next?.op==='cell_results'||next?.op==='move')&&sourceImmediateReadCount(next,x.dst)===1&&!sourceReadBeforeWrite(xs,xi+2,x.dst)){const e=makeExpr(code);e.expireAt=xi+1;setAlias(x.dst,e);plainRegs.set(x.dst,token);}else{q.push(setRaw(x.dst,code));plainRegs.set(x.dst,token);}break;
          }
          case 'table_vararg':{const token=freshPlainTable(),code='{...}',next=xs[xi+1];plainRegs.set(x.dst,token);if((next?.op==='cell_results'||next?.op==='move')&&sourceImmediateReadCount(next,x.dst)===1&&!sourceReadBeforeWrite(xs,xi+2,x.dst)){const e=makeExpr(code);e.expireAt=xi+1;setAlias(x.dst,e);plainRegs.set(x.dst,token);}else{q.push(setRaw(x.dst,code));plainRegs.set(x.dst,token);}break;}
          case 'table_closure_record':{
            const token=freshPlainTable();
            // Constructor fields are rendered as genuine nested Lua function
            // expressions.  Render into a temporary slice of the shared sink
            // so child lexical captures use exactly the same machinery as a
            // normal CLOSURE instruction.
            const rendered=[];
            for(const f of x.fields??[]){
              const child=byId.get(f.prototype);if(!child)throw new Error(`Missing recovered prototype ${f.prototype}`);
              for(const b of f.upvalues??[])if(b.kind===0&&!state.has(b.index)){materializeRegDependents(b.index);materialize(b.index);}
              const childUps=new Map();for(const b of f.upvalues??[]){if(b.kind===0){const cell=scalarCells?state.get(b.index):null,plain=plainRegs.get(b.index);childUps.set(b.slot,cell?{cell}:{expr:rawRead(b.index),...(plain?.plain?{plainTable:plain}:{})});}else childUps.set(b.slot,upvalues.get(b.index)??{expr:'nil'});}
              const childScope=nextScope++,role=f.key?.kind==='literal'&&f.key.value==='__call'?'metamethod-call':null,ps=roleParams(child,childScope,childUps,role),fp=functionParams(child,ps);
              const start=lines.length;renderProgram(child,{upvalues:childUps,level:0,scopeId:childScope,header:`function(${fp})`,paramNames:ps});
              const fnLines=lines.splice(start).filter(v=>v!=null);const fn=fnLines.join('\n').replace(/\n/g,`\n${ip}`);
              const key=f.key?.kind==='literal'&&ident(f.key.value)?`${f.key.value}=`:`[${lit(f.key?.value)}]=`;
              rendered.push(`${key}${fn}`);
            }
            const code=rendered.length>1
              ? `{\n${rendered.map(field=>field.split('\n').map(line=>`${ip}  ${line.startsWith(ip)?line.slice(ip.length):line}`).join('\n')).join(',\n')}\n${ip}}`
              : `{${rendered.join(', ')}}`,captures=new Set();for(const f of x.fields??[])for(const b of f.upvalues??[])if(b.kind===0)captures.add(b.index);
            if(canDeferClosureRecord(xi+1,x.dst,captures))setAlias(x.dst,makeExpr(code));else q.push(setRaw(x.dst,code));
            plainRegs.set(x.dst,token);break;
          }
          case 'table_record':{
            const token=freshPlainTable(),parts=[],regDeps=new Set(),cellDeps=new Set(),tableDeps=new Set();
            for(const f of x.fields??[]){
              const e=exprValue(f.value,x);for(const d of e.regDeps)regDeps.add(d);for(const d of e.cellDeps)cellDeps.add(d);for(const d of e.tableDeps)tableDeps.add(d);
              const key=f.key?.kind==='literal'&&ident(f.key.value)?`${f.key.value}=`:`[${lit(f.key?.value)}]=`;parts.push(`${key}${e.code}`);
            }
            const e=makeExpr(`{${parts.join(', ')}}`,regDeps,cellDeps,tableDeps);plainRegs.set(x.dst,token);
            if(singleStraightLineReadBeforeWrite(xi+1,x.dst))setAlias(x.dst,e);else q.push(setRaw(x.dst,e.code));
            plainRegs.set(x.dst,token);break;
          }
          case 'cell_new':{
            if(!scalarCells){q.push(setRaw(x.dst,`{value=${valueCode(x.src,x)}}`));for(let r=x.dst+1;r<x.dst+Math.max(1,x.resultCount??1);r++)q.push(setRaw(r,'nil'));break;}
            const name=`c${nextCell++}`,value=valueCode(x.src,x);materializeRegDependents(x.dst);aliases.delete(x.dst);q.push(`local ${name}=${value}`);state.set(x.dst,name);for(let r=x.dst+1;r<x.dst+Math.max(1,x.resultCount??1);r++)q.push(setRaw(r,'nil'));break;
          }
          case 'cell_results':{
            const n=Math.max(0,x.resultCount??x.count),sourceCount=Math.min(x.count,x.sourceCount??x.count),sources=[];for(let i=0;i<Math.min(n,sourceCount);i++)sources.push(state.has(x.sourceBase+i)?{cell:state.get(x.sourceBase+i)}:{expr:exprReg(x.sourceBase+i)});
            for(let i=0;i<n;i++){
              if(i>=x.count){setAlias(x.base+i,makeExpr('nil'));continue;}const src=i<sourceCount?sources[i]:{expr:makeExpr('nil')};
              if(x.mask?.[i]==='1'){
                if(!scalarCells){q.push(setRaw(x.base+i,`{value=${src.cell??src.expr.code}}`));continue;}if(src.cell)scalarError('nested wrapper cell construction is not scalar-safe',x);
                const name=`c${nextCell++}`;materializeRegDependents(x.base+i);aliases.delete(x.base+i);q.push(`local ${name}=${src.expr.code}`);state.set(x.base+i,name);
              }else if(scalarCells&&src.cell){materializeRegDependents(x.base+i);aliases.delete(x.base+i);state.set(x.base+i,src.cell);}else setAlias(x.base+i,src.expr);
            }break;
          }
          case 'cell_get':{
            if(!scalarCells){q.push(setRaw(x.dst,`${rawRead(x.cell)}.value`));for(let r=x.dst+1;r<x.dst+Math.max(1,x.resultCount??1);r++)q.push(setRaw(r,'nil'));break;}
            const cell=state.get(x.cell);if(!cell)scalarError(`cannot resolve wrapper cell in r${x.cell}`,x);setAlias(x.dst,makeExpr(cell,[],[cell]));for(let r=x.dst+1;r<x.dst+Math.max(1,x.resultCount??1);r++)setAlias(r,makeExpr('nil'));break;
          }
          case 'cell_set':{
            if(!scalarCells){q.push(`${rawRead(x.cell)}.value=${valueCode(x.value,x)}`);break;}const cell=state.get(x.cell);if(!cell)scalarError(`cannot resolve wrapper cell in r${x.cell}`,x);const rhs=valueCode(x.value,x);materializeCellDependents(cell);q.push(`${cell}=${rhs}`);break;
          }
          case 'gettable':{
            if(aliases.has(x.table)&&plainRegs.get(x.table)?.plain)materialize(x.table);
            const te=exprReg(x.table),ke=exprValue(x.key,x),token=plainRegs.get(x.table),tb=te.code,code=x.key?.kind==='literal'&&ident(x.key.value)?`${tb}.${x.key.value}`:`${tb}[${ke.code}]`,mt=immediateMoveTarget(x.dst,xi);
            if(token?.plain){const deps=new Set([...te.regDeps,...ke.regDeps]),cells=new Set([...te.cellDeps,...ke.cellDeps]);setAlias(x.dst,makeExpr(code,deps,cells,[token]));if(mt!=null){const a=aliases.get(x.dst);aliases.delete(x.dst);setAlias(mt,a);plainRegs.delete(x.dst);xi++;}break;}
            materializeAllTableDependents();if(mt!=null){q.push(setRaw(mt,code));aliases.delete(x.dst);state.delete(x.dst);xi++;}else if(!forwardOneStep(x.dst,code,xi))q.push(setRaw(x.dst,code));break;
          }
          case 'settable':{
            pruneDeadAliases(xi);
            if(aliases.has(x.table)&&plainRegs.get(x.table)?.plain)materialize(x.table);
            const token=plainRegs.get(x.table);if(token?.plain){const used=new Set();if(x.value?.kind==='reg')used.add(x.value.index);if(x.key?.kind==='reg')used.add(x.key.index);materializeTableDependents(token,used);}else materializeAllTableDependents();
            if(x.key?.kind==='reg'&&plainRegs.get(x.key.index))escapePlain(x.key.index);if(x.value?.kind==='reg'&&plainRegs.get(x.value.index))escapePlain(x.value.index);
            const tb=exprReg(x.table).code,key=x.key?.kind==='literal'&&ident(x.key.value)?`.${x.key.value}`:`[${valueCode(x.key,x)}]`;q.push(`${tb}${key}=${valueCode(x.value,x)}`);
            if(token?.plain)for(const [r,a] of [...aliases])if(a.tableDeps?.has(token))aliases.delete(r);break;
          }
          case 'self':{if(aliases.has(x.dst)&&plainRegs.get(x.dst)?.plain)materialize(x.dst);const o=`_o${x.pc}`,obj=exprReg(x.dst).code;q.push(`local ${o}=${obj}`);q.push(setRaw(x.dst+1,o));q.push(setRaw(x.dst,x.key?.kind==='literal'&&ident(x.key.value)?`${o}.${x.key.value}`:`${o}[${valueCode(x.key,x)}]`));break;}
          case 'setlist':{if(aliases.has(x.table)&&plainRegs.get(x.table)?.plain)materialize(x.table);const table=exprReg(x.table).code;let k=1;for(let r=x.from;r<=x.to;r++,k++)q.push(`${table}[${k}]=${exprReg(r).code}`);break;}
          case 'unary':{const ve=x.value?.kind==='reg'?exprReg(x.value.index):exprValue(x.value,x),code=x.operator==='not'?`not ${ve.code}`:`${x.operator}${ve.code}`,mt=immediateMoveTarget(x.dst,xi);if(mt!=null){q.push(setRaw(mt,code));aliases.delete(x.dst);state.delete(x.dst);xi++;}else if(!forwardOneStep(x.dst,code,xi)&&!forwardUnaryToLoop(x.dst,code,xi,ve))q.push(setRaw(x.dst,code));break;}
          case 'binary':{const code=binaryCode(x),mt=immediateMoveTarget(x.dst,xi);if(mt!=null){q.push(setRaw(mt,code));aliases.delete(x.dst);state.delete(x.dst);xi++;}else if(!forwardOneStep(x.dst,code,xi))q.push(setRaw(x.dst,code));break;}
          case 'move_pair':{
            // Read both sources before changing either destination.  Some V10
            // fused MOVE pairs overlap their source/destination registers, so
            // treating them as two sequential assignments is not generally
            // correct.  CLOSE lifetime recovery may additionally mark either
            // destination as a fresh lexical generation for this block.
            const redeclare1=(x.sourceRedeclare??[]).includes(x.dst),redeclare2=(x.sourceRedeclare??[]).includes(x.secondDst);
            const cell1=scalarCells&&x.src?.kind==='reg'?state.get(x.src.index):null,cell2=scalarCells?state.get(x.secondSrc):null;
            const p1=x.src?.kind==='reg'?plainRegs.get(x.src.index):null,p2=plainRegs.get(x.secondSrc);
            // Wrapper objects are VM implementation cells. A MOVE/MOVE_PAIR of
            // one of those objects aliases the same source lexical variable; it
            // must not force the emitter to materialize or expose the wrapper
            // identity. Snapshot both cell aliases before touching either
            // destination so overlapping fused moves remain simultaneous.
            if((cell1||cell2)&&!redeclare1&&!redeclare2){
              const e1=cell1?null:exprValue(x.src,x),e2=cell2?null:exprReg(x.secondSrc);
              for(const r of [x.dst,x.secondDst]){materializeRegDependents(r);aliases.delete(r);state.delete(r);plainRegs.delete(r);}
              if(cell1)state.set(x.dst,cell1);else setAlias(x.dst,e1);
              if(cell2)state.set(x.secondDst,cell2);else setAlias(x.secondDst,e2);
              if(!cell1&&p1?.plain)plainRegs.set(x.dst,p1);if(!cell2&&p2?.plain)plainRegs.set(x.secondDst,p2);
              break;
            }
            const e1=exprValue(x.src,x),e2=exprReg(x.secondSrc);
            if(redeclare1||redeclare2){
              for(const r of [x.dst,x.secondDst]){materializeRegDependents(r);aliases.delete(r);state.delete(r);plainRegs.delete(r);}
              if(redeclare1)inlineDeclared.add(x.dst);if(redeclare2)inlineDeclared.add(x.secondDst);
              if(redeclare1&&redeclare2)q.push(`local ${rawRead(x.dst)},${rawRead(x.secondDst)}=${e1.code},${e2.code}`);
              else if(redeclare1&&!redeclare2&&!e2.regDeps.has(x.dst)){
                // Common CLOSE-in-loop shape: the first destination is a fresh
                // captured lexical local, while the second is only a VM alias
                // (often the table being populated). Because RHS2 does not
                // depend on the old first destination, declaring RHS1 first is
                // equivalent to MOVE_PAIR's snapshot semantics; keep RHS2 as a
                // lazy alias so compiler staging does not leak into source.
                q.push(`local ${rawRead(x.dst)}=${e1.code}`);
                setAlias(x.secondDst,e2);
              }else {
                const fresh=redeclare1?x.dst:x.secondDst,other=redeclare1?x.secondDst:x.dst;
                // Keep the non-fresh destination's existing lexical binding,
                // while preserving MOVE_PAIR's simultaneous source snapshot.
                q.push(`local ${rawRead(fresh)}`);
                q.push(`${rawRead(x.dst)},${rawRead(x.secondDst)}=${e1.code},${e2.code}`);
                inlineDeclared.add(fresh);
                // The other register is assigned now (not a deferred alias),
                // so its old plain-table provenance no longer applies below.
                plainRegs.delete(other);
              }
              if(p1?.plain)plainRegs.set(x.dst,p1);if(p2?.plain)plainRegs.set(x.secondDst,p2);
              break;
            }
            setAlias(x.dst,e1);setAlias(x.secondDst,e2);if(p1?.plain)plainRegs.set(x.dst,p1);else plainRegs.delete(x.dst);if(p2?.plain)plainRegs.set(x.secondDst,p2);else plainRegs.delete(x.secondDst);break;
          }
          case 'jump':materializeAll();q.push(`goto L_${x.target}`);break;
          case 'branch_false':{const c=valueCode(x.condition,x);materializeAll();q.push(`if not ${c} then goto L_${x.target} end`);break;}
          case 'logical_chain':q.push(setRaw(x.dst,x.values.map(e=>astLocal(e,x)).join(` ${x.operator} `)));break;
          case 'source_table_mutation':{
            const u=upvalues.get(x.slot),table=u?.cell??u?.expr??'nil',a0=valueCode(x.args?.[0],x),a1=valueCode(x.args?.[1],x);
            materializeAllTableDependents();
            if(x.mutation==='table_binary_table')q.push(`${table}[${a0}]=${table}[${a0}] ${x.operator} ${table}[${a1}]`);
            else if(x.mutation==='table_binary_value')q.push(`${table}[${a0}]=${table}[${a0}] ${x.operator} ${a1}`);
            else if(x.mutation==='table_swap')q.push(`${table}[${a0}],${table}[${a1}]=${table}[${a1}],${table}[${a0}]`);
            else throw new Error(`Unknown source table mutation ${x.mutation}`);
            break;
          }
          case 'source_method_call':{
            materializeAllTableDependents();
            if(x.receiver?.kind==='reg'&&aliases.has(x.receiver.index)&&plainRegs.get(x.receiver.index)?.plain)materialize(x.receiver.index);
            const receiver=exprValue(x.receiver,x).code,key=x.key?.value,args=(x.args??[]).map(a=>exprValue(a,x).code).join(', '),receiverCode=/^[A-Za-z_][A-Za-z0-9_]*$/.test(receiver)?receiver:`(${receiver})`,code=`${receiverCode}:${key}(${args})`,n=x.resultCount;
            if(n===0)q.push(code);else{const rs=Array.from({length:n},(_,i)=>x.base+i);q.push(resultAssignment(rs,code));}
            break;
          }
          case 'source_call':{
            materializeAllTableDependents();if(x.fn?.kind==='reg'&&aliases.has(x.fn.index)&&plainRegs.get(x.fn.index)?.plain)materialize(x.fn.index);
            for(const a of x.args??[])if(a?.kind==='reg')escapePlain(a.index);if(x.fn?.kind==='reg')escapePlain(x.fn.index);
            const code=sourceCallCode(x.fn,x.args??[],x),next=xs[xi+1],n=x.resultCount;
            const fuseIdentity=n>0&&next?.op==='identity_results'&&next.sourceBase===x.base&&next.count===n&&next.resultCount===n&&Array.from({length:n},(_,i)=>!sourceReadBeforeWrite(xs,xi+2,x.base+i)).every(Boolean);
            const fuseSourceLocal=n===1&&next?.op==='source_local'&&next.value?.kind==='reg'&&next.value.index===x.base&&!sourceReadBeforeWrite(xs,xi+2,x.base);
            if(fuseIdentity){const rs=Array.from({length:n},(_,i)=>next.base+i);q.push(resultAssignment(rs,code));for(let i=0;i<n;i++){aliases.delete(x.base+i);state.delete(x.base+i);}xi++;}
            else if(fuseSourceLocal){
              const target=next.dst;for(const r of new Set([x.base,target]))killRaw(r);inlineDeclared.add(target);q.push(`local ${rawRead(target)}=${code}`);xi++;
            }
            else if(n===0)q.push(code);else if(crossesSourceLine(xi,x.sourceLine)){const rs=Array.from({length:n},(_,i)=>x.base+i);q.push(resultAssignment(rs,code));}
            else if(n===1&&forwardOneStep(x.base,code,xi)){}else{const rs=Array.from({length:n},(_,i)=>x.base+i);q.push(resultAssignment(rs,code));}break;}
          case 'source_tailcall':{
            materializeAllTableDependents();if(x.fn?.kind==='reg'&&aliases.has(x.fn.index)&&plainRegs.get(x.fn.index)?.plain)materialize(x.fn.index);
            for(const a of x.args??[])if(a?.kind==='reg')escapePlain(a.index);if(x.fn?.kind==='reg')escapePlain(x.fn.index);
            q.push(`return ${sourceCallCode(x.fn,x.args??[],x)}`);aliases.clear();break;
          }
          case 'call':{
            materializeAllTableDependents();if(aliases.has(x.base)&&plainRegs.get(x.base)?.plain)materialize(x.base);for(let r=x.base;r<=x.base+Math.max(0,x.argCount);r++)escapePlain(r);
            const fn=exprReg(x.base).code;let a=argsCode(x.base,x.argCount,x);if(x.sourceVarargArgs)a=a?`${a}, ...`:'...';const code=`${fn}(${a})`;
            const next=xs[xi+1],n=x.resultCount;
            const fuseIdentity=n>0&&next?.op==='identity_results'&&next.sourceBase===x.base&&next.count===n&&next.resultCount===n&&Array.from({length:n},(_,i)=>!sourceReadBeforeWrite(xs,xi+2,x.base+i)).every(Boolean);
            const mt=n===1?immediateMoveTarget(x.base,xi):null;
            if(fuseIdentity){const rs=Array.from({length:n},(_,i)=>next.base+i);q.push(resultAssignment(rs,code));for(let i=0;i<n;i++){aliases.delete(x.base+i);state.delete(x.base+i);}xi++;}
            else if(x.resultCount===0)q.push(code);
            else if(crossesSourceLine(xi,x.sourceLine)){const rs=Array.from({length:x.resultCount},(_,i)=>x.base+i);q.push(resultAssignment(rs,code));}
            else if(mt!=null){q.push(setRaw(mt,code));aliases.delete(x.base);state.delete(x.base);xi++;}
            else if(x.resultCount===1&&forwardOneStep(x.base,code,xi)){}else{const rs=Array.from({length:x.resultCount},(_,i)=>x.base+i);q.push(resultAssignment(rs,code));}break;
          }
          case 'identity_results':{
            const n=x.resultCount<0?x.count:x.resultCount,srcs=[];for(let i=0;i<Math.min(n,x.count);i++)srcs.push(state.has(x.sourceBase+i)?{cell:state.get(x.sourceBase+i)}:{expr:exprReg(x.sourceBase+i)});
            for(let i=0;i<n;i++){const src=srcs[i],pt=i<x.count?plainRegs.get(x.sourceBase+i):null;if(src?.cell){materializeRegDependents(x.base+i);aliases.delete(x.base+i);plainRegs.delete(x.base+i);state.set(x.base+i,src.cell);}else{setAlias(x.base+i,src?.expr??makeExpr('nil'));if(pt?.plain)plainRegs.set(x.base+i,pt);else plainRegs.delete(x.base+i);}}break;
          }
          case 'constant_call':if(x.resultCount>0){setAlias(x.base,exprValue(x.value,x));for(let i=1;i<x.resultCount;i++)setAlias(x.base+i,makeExpr('nil'));}break;
          case 'tailcall':{materializeAllTableDependents();if(aliases.has(x.base)&&plainRegs.get(x.base)?.plain)materialize(x.base);for(let r=x.base;r<=x.base+Math.max(0,x.argCount);r++)escapePlain(r);const fn=exprReg(x.base).code;let a=argsCode(x.base,x.argCount,x);if(x.sourceVarargArgs)a=a?`${a}, ...`:'...';q.push(`return ${fn}(${a})`);aliases.clear();break;}
          case 'return':{if(!x.hasValues)q.push('return');else{let r=Array.from({length:x.count},(_,i)=>exprReg(x.base+i).code).join(', ');if(x.sourceVarargReturn)r=r?`${r}, ...`:'...';q.push(`return ${r}`);}aliases.clear();break;}
          case 'return_literal':q.push(`return ${valueCode(x.value,x)}`);aliases.clear();break;
          case 'return_cell':{
            if(!scalarCells){q.push(`return ${rawRead(x.cell)}.value`);break;}const cell=state.get(x.cell);if(!cell)scalarError(`cannot resolve returned wrapper cell r${x.cell}`,x);q.push(`return ${cell}`);aliases.clear();break;
          }
          case 'vararg':if(x.count>0){const names=[];for(let r=x.base;r<x.base+x.count;r++){killRaw(r);names.push(rawRead(r));}q.push(`${names.join(', ')}=...`);}break;
          case 'source_label':materializeAll();break;
          case 'vm_internal':break;
          default:throw new Error(`Nested emitter does not support ${x.op}`);
        }
        if(q.length){const terminal=['return','tailcall','source_tailcall','return_cell','return_literal'].includes(x.op);const isLast=xi===xs.length-1;lines.push(terminal&&!isLast?`${ip}do ${q.join('; ')} end`:`${ip}${q.join('; ')}`);}
        for(const [r,a] of [...aliases])if(a.expireAt===xi)aliases.delete(r);
      }
      for(const r of [...aliases.keys()]){if(liveOut(r))materialize(r);else aliases.delete(r);}return state;
    };
    emitSeq(p.instructions,level+(asChunk?0:1),new Map(),()=>false);
    for(const t of [...missing].sort((a,b)=>String(a).localeCompare(String(b))))lines.push(`${bodyPad}::L_${t}::`,`${bodyPad}return`);
    if(useEnd)lines.push(`${bodyPad}::L_${prepared.end}::`,`${bodyPad}return`);
    const escapedScope=String(scopeId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const localPattern=scopeId===0?/\bv(\d+)\b/g:new RegExp(`\\bv${escapedScope}_(\\d+)\\b`,'g');
    const used=new Set();
    for(let i=declarationIndex+1;i<lines.length;i++){
      const text=lines[i];if(typeof text!=='string')continue;
      mapLuaCodeSegments(text,segment=>{localPattern.lastIndex=0;let m;while((m=localPattern.exec(segment)))used.add(Number(m[1]));return segment;});
    }
    // A few IR-only values may disappear during emission (cell wrappers,
    // aliases, folded call frames). Compact the surviving synthetic ids once
    // more so source never contains holes such as v0,v5 merely because four
    // hidden VM temporaries existed between them.
    const usedIds=[...used].sort((a,b)=>a-b),compactId=new Map(usedIds.map((id,i)=>[id,i]));
    const localNameById=id=>scopeId===0?`v${id}`:`v${scopeId}_${id}`;
    for(let i=declarationIndex+1;i<lines.length;i++){
      const text=lines[i];if(typeof text!=='string')continue;
      lines[i]=mapLuaCodeSegments(text,segment=>{localPattern.lastIndex=0;return segment.replace(localPattern,(_,id)=>localNameById(compactId.get(Number(id))));});
    }
    const declared=usedIds.map(id=>regByDense.get(id)).filter(r=>r!=null&&!stableParams.has(r)&&!inlineDeclared.has(r)).map(r=>localNameById(compactId.get(denseByReg.get(r))));
    lines[declarationIndex]=declared.length?`${bodyPad}local ${declared.join(',')}`:null;
    if(!asChunk)lines.push(`${pad}end`);
  };
  const root=byId.get(0);if(!root)throw new Error('Missing root prototype');
  try{
    if(root.paramCount===0)renderProgram(root,{level:0,scopeId:0,asChunk:true});
    else {const params=Array.from({length:root.paramCount},(_,i)=>`p${i}`);renderProgram(root,{level:0,scopeId:0,header:`local function main(${functionParams(root,params)})`,paramNames:params});lines.push('','return main(...)');}
  }catch(error){if(scalarCells&&error?.code==='CELL_SCALAR_UNSAFE')return emitNestedBundle(bundle,watermark,{scalarCells:false});throw error;}
  lines.push('');if(needsGref)lines.splice(2,0,'local _GREF=_ENV or _G','');return lines.filter(x=>x!==null).join('\n');
}

export function emitSourceLua(bundle,{watermark=WATERMARK}={}){
  bundle=inlineCapturedTableHelpers(bundle).bundle;
  bundle=pruneUnusedUpvalueBindings(bundle).bundle;
  const modes=new Map();let legacy=false;
  for(const p of bundle.programs){const m=isVarargPack(p)?'pack':canCompactProgram(p)?'compact':canDirect(p)?'direct':'legacy';modes.set(p.id,m);if(m==='legacy')legacy=true;}
  const byId=new Map(bundle.programs.map(p=>[p.id,p]));
  const compactPrepared=new Map();
  const compactView=p=>{if(!compactPrepared.has(p.id))compactPrepared.set(p.id,prepareDirect(p,{callFrames:false}).program);return compactPrepared.get(p.id);};
  const compactMemo=new Map();
  const compactTree=id=>{
    if(compactMemo.has(id))return compactMemo.get(id);const p=byId.get(id);if(!p)return false;
    if(isVarargPack(p)){compactMemo.set(id,true);return true;}
    if(!canCompactProgram(compactView(p))){compactMemo.set(id,false);return false;}
    compactMemo.set(id,true); // lexical prototype graphs are acyclic; guard anyway.
    for(const x of p.instructions??[])if(x.op==='closure'){
      if((x.upvalues?.length??0)!==0||!compactTree(x.prototype)){compactMemo.set(id,false);return false;}
    }
    return true;
  };
  const sourceFidelityNeeded=id=>{
    const p=byId.get(id);if(!p)return false;
    const direct=prepareDirect(p).program;
    let needed=false;walkInstructions(direct.instructions??[],x=>{if(x.sourceRecovered==='repeated-literal')needed=true;});
    return needed;
  };
  if(!legacy&&compactTree(0)&&!sourceFidelityNeeded(0)){
    const root=byId.get(0),params=Array.from({length:root.paramCount},(_,i)=>`a${i}`),packIds=new Set(bundle.programs.filter(isVarargPack).map(p=>p.id));
    const renderClosure=id=>{const p=byId.get(id);if(isVarargPack(p))return `function(...) return { n = select("#", ...), ... } end`;const ps=Array.from({length:p.paramCount},(_,i)=>`a${i}`);return emitCompactProgram(compactView(p),{header:`function(${functionParams(p,ps)})`,renderClosure,inlinePackIds:packIds}).code;};
    const asChunk=root.paramCount===0;
    const rendered=emitCompactProgram(compactView(root),{header:`local function main(${functionParams(root,params)})`,renderClosure,inlinePackIds:packIds,asChunk});
    const lines=[watermark,''];if(rendered.needsGref)lines.push('local _GREF=_ENV or _G','');lines.push(rendered.code);if(!asChunk)lines.push('','return main(...)');lines.push('');return lines.join('\n');
  }
  // Never mix source-level lexical captures with the compatibility VM ABI.
  // When every recovered prototype is source-emittable, reconstruct the actual
  // nested closure tree and eliminate the synthetic P_n/upvalue-call ABI.
  if(!legacy)return emitNestedBundle(bundle,watermark);
  return emitLua(bundle,{watermark});

}
