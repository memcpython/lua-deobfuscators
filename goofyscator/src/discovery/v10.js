import { parseHandlerMap } from './handler-map.js';
import { classifyHandler } from './classify-handlers.js';
import { mapHandlerFamilies } from './structural-map.js';
const numRe='(?:0x[0-9A-Fa-f]+|\\d+)';
const n=x=>/^0x/i.test(x)?parseInt(x,16):Number(x);
function fnEntries(w){return w.entries.filter(e=>e.isFunction);}
function findOne(entries,pred,label){const a=entries.filter(pred);if(!a.length)throw new Error(`V10 discovery: ${label} not found`);return a.sort((x,y)=>x.value.length-y.value.length)[0];}
function quotedStrings(src){const out=[];const re=/"((?:\\.|[^"\\])*)"/g;let m;while((m=re.exec(src))){try{const v=m[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\');out.push(v);}catch{}}return out;}
function discoverResolver(entries){
  const c=entries.filter(e=>e.isFunction && e.value.length>650&&e.value.length<1400&& (e.value.match(/elseif/g)||[]).length>=3 && (e.value.match(/return/g)||[]).length>=6);
  for(const e of c){
    const s=e.value;
    const head=new RegExp(`local\\s+(\\w+)\\s*,\\s*(\\w+)\\s*=\\s*(\\w+)\\[(${numRe})\\]\\s*or\\s*(${numRe})\\s*,\\s*\\3\\[(${numRe})\\]\\s*or\\s*(${numRe})`).exec(s);
    if(!head)continue;
    const [,v1,v2,opVar,k1S,d1S,k2S,d2S]=head;
    let kindVar=null,valueVar=null,regKind=null,registerStateKey=null,immKind=null;
    for(const [candidate,other] of [[v1,v2],[v2,v1]]){
      const branch=new RegExp(`if\\s+${candidate}\\s*==\\s*(${numRe})\\s*then\\s*return\\s+(\\w+)\\[(${numRe})\\]\\[${other}\\]\\s*;elseif\\s+${candidate}\\s*==\\s*(${numRe})\\s*then\\s*return\\s+${other}`).exec(s);
      if(branch){kindVar=candidate;valueVar=other;regKind=n(branch[1]);registerStateKey=n(branch[3]);immKind=n(branch[4]);break;}
    }
    if(!kindVar)continue;
    const firstIsKind=kindVar===v1;
    const valueKey=n(firstIsKind?k2S:k1S),kindKey=n(firstIsKind?k1S:k2S),defaultKind=n(firstIsKind?d1S:d2S);
    const kindCodes=[...s.matchAll(new RegExp(`${kindVar}\\s*==\\s*(${numRe})`,'g'))].map(m=>n(m[1]));
    const constKinds=kindCodes.filter(x=>x!==regKind&&x!==immKind);
    let constantsStateKey=null;
    for(const m of s.matchAll(new RegExp(`\\w+\\[(${numRe})\\]\\[${valueVar}\\]`,'g'))){const k=n(m[1]);if(k!==registerStateKey)constantsStateKey=k;}
    const selfVar=/^\(function\((\w+)/.exec(s)?.[1];
    let pcContextField=null, hashField=null, sentinelField=null;
    if(selfVar){
      const mods=[...s.matchAll(new RegExp(`${selfVar}\\.([A-Za-z_]\\w*)\\s+or\\s+0`,'g'))].map(m=>m[1]);
      const freq=new Map(); for(const x of mods)freq.set(x,(freq.get(x)||0)+1);
      pcContextField=[...freq.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]??null;
      hashField=[...freq.keys()].find(x=>x!==pcContextField)??null;
      const sm=new RegExp(`==\\s*${selfVar}\\.([A-Za-z_]\\w*)`).exec(s); sentinelField=sm?.[1]??null;
    }
    return { key:e.key, source:s, valueKey,kindKey,defaultKind,regKind,immKind,constKinds,registerStateKey,constantsStateKey,cacheKey:null,pcContextField,hashField,sentinelField };
  }
  throw new Error('V10 discovery: operand resolver not found');
}
function discoverDest(entries, handlerProps){
  for(const p of handlerProps){const s=entries.find(e=>e.key===p)?.value;if(!s)continue;
    const re=new RegExp(`\\[(${numRe})\\]\\s*or\\s*(${numRe})\\)\\s*-\\s*\\2\\)\\s*\\*\\s*(${numRe})\\)\\s*%\\s*(${numRe})`);
    const m=re.exec(s);if(m)return {key:n(m[1]),bias:n(m[2]),multiplier:n(m[3]),modulus:n(m[4])};
  }
  throw new Error('V10 discovery: destination register transform not found');
}
function discoverRunner(entries){
  const runner=findOne(entries,e=>e.isFunction&&e.value.includes('while true do')&&e.value.includes('xpcall')&&e.value.length<3500,'runner');
  const s=runner.value;
  let pcKey=null,baseA=null,baseB=null,baseLeft=null,baseRight=null;
  const wh=/while true do local\s+\w+\s*=\s*\w+\[(\w+)\]/.exec(s);
  if(wh){
    const varName=wh[1];
    for(const decl of s.matchAll(/local\s+([^=;]+)=([^;]+);/g)){
      const vars=decl[1].split(',').map(x=>x.trim()), vals=decl[2].split(',').map(x=>x.trim());
      const i=vars.indexOf(varName);
      if(i>=0 && vals[i] && new RegExp(`^${numRe}$`).test(vals[i])){ pcKey=n(vals[i]); break; }
    }
  }
  // The helper that initializes the VM frame returns the exact logical-PC
  // offset. Some polymorphic builds flip the subtraction order.
  const br=new RegExp(`local function\\s+\\w+\\(\\w+\\)local\\s+(\\w+)\\s*,\\s*(\\w+)\\s*=\\s*\\w+\\[(${numRe})\\]\\s*,\\s*\\w+\\[(${numRe})\\]\\s*;([\\s\\S]{0,900}?)return\\s+(\\w+)\\s*-\\s*(\\w+)\\s*;end;`);
  const bm=br.exec(s);
  if(bm){
    const [,a,b,ka,kb,,left,right]=bm;baseA=n(ka);baseB=n(kb);
    const keyOf=x=>x===a?baseA:x===b?baseB:null;baseLeft=keyOf(left);baseRight=keyOf(right);
  }
  if(pcKey==null)throw new Error('V10 discovery: runner PC state key not found');
  if(baseLeft==null||baseRight==null)throw new Error('V10 discovery: runner PC base transform not found');
  return {key:runner.key,source:s,pcKey,baseA,baseB,baseLeft,baseRight};
}
function discoverLB(entries,builderKey,runnerKey){
  const e=findOne(entries,x=>x.isFunction&&x.value.includes('limitedstack')&&x.value.length>4000,'bootstrap');const s=e.value;
  const pm=/^\(function\(([^)]*)\)/.exec(s);const [self,payload,env]=pm[1].split(',').map(x=>x.trim());
  const stateVar=new RegExp(`if type\\((\\w+)\\) ~= \"table\"`).exec(s)?.[1]??null;
  let stateField=null;
  if(stateVar){
    for(const dm of s.matchAll(/local\s+([^=;]+)=([^;]+);/g)){
      const vars=dm[1].split(',').map(x=>x.trim()), vals=dm[2].split(',').map(x=>x.trim()); const idx=vars.indexOf(stateVar);
      if(idx>=0){ const vm=new RegExp(`^${self}\\.([A-Za-z_]\\w*)$`).exec(vals[idx]); if(vm){stateField=vm[1];break;} }
    }
  }
  const envField=new RegExp(`${self}\\.([A-Za-z_]\\w*)=${env};`).exec(s)?.[1];
  const emptyFields=[...s.slice(0,1800).matchAll(new RegExp(`${self}\\.([A-Za-z_]\\w*)=\\{\\};`,'g'))].map(m=>m[1]);
  const hb=new RegExp(`${self}\\.([A-Za-z_]\\w*)=${self}\\.\\1 or \\(${self}\\.${builderKey}\\)\\(${self}\\);`).exec(s);const handlerField=hb?.[1];
  const pre=hb?s.slice(0,hb.index):s;const assigns=[...pre.matchAll(new RegExp(`${self}\\.([A-Za-z_]\\w*)=(\\w+);`,'g'))];const bitField=assigns.at(-1)?.[1];
  const post=hb?s.slice(hb.index+hb[0].length):s;
  const payloadSeedField=new RegExp(`${self}\\.([A-Za-z_]\\w*)=${payload};`).exec(post)?.[1];
  const antiField=new RegExp(`local\\s+\\w+=${self}\\.([A-Za-z_]\\w*);if \\w+ then local`).exec(post)?.[1];
  const sec=new RegExp(`if ${self}\\.([A-Za-z_]\\w*) ~= nil and not ${self}\\.([A-Za-z_]\\w*) then ${self}\\.\\2=\\(${self}\\.([A-Za-z_]\\w*)\\)\\(${self},${self}\\.\\1,0\\);end;`).exec(s);
  if(!sec)throw new Error('V10 discovery: secondary decoder chain not found');
  const [secondaryField,loaderField,geKey]=sec.slice(1);
  const alphabet=quotedStrings(s).find(x=>x.length===91); if(!alphabet)throw new Error('V10 discovery: Base91 alphabet missing');
  const b91=findOne(entries,x=>x.isFunction&&x.value.includes('0x2000')&&x.value.includes('91')&&x.value.length<1200,'Base91 decoder');
  const bSelf=/^\(function\((\w+)/.exec(b91.value)?.[1]; const fields=bSelf?[...b91.value.slice(0,450).matchAll(new RegExp(`${bSelf}\\.([A-Za-z_]\\w*)`,'g'))].map(m=>m[1]):[];
  const mapField=fields.find(f=>f!==envField&&new RegExp(`${self}\\.${f}=\\w+;`).test(s));
  let hashField=null; if(stateVar){const hm=new RegExp(`${stateVar}\\[1\\]=2;${self}\\.([A-Za-z_]\\w*)=\\w+;`).exec(s);hashField=hm?.[1]??null;}
  let antiSeedMagic=0; const am=new RegExp(`${antiField?antiField:'__none'}.*?true,\\([^;]*?\\+\\s*(${numRe})\\)\\s*%\\s*0x7FFFFFFF`).exec(s); if(am)antiSeedMagic=n(am[1]);
  // Executor: function that tail-calls discovered runner.
  const executor=findOne(entries,x=>x.isFunction&&x.value.length<1800&&x.value.includes('.'+runnerKey+')(')&&x.value.includes('return ('),'executor');
  const protoVar=/local\s+(\w+)\s*=\s*\w+\s+and\s+\w+\[1\]/.exec(executor.value)?.[1]??null;
  let paramProtoKey=null;
  if(protoVar){const pm=new RegExp(`${protoVar}\\[(${numRe})\\]\\s+or\\s+0`).exec(executor.value);if(pm)paramProtoKey=n(pm[1]);}
  // The validator receives a callback table. One callback enters the primary
  // payload; both its object-property name and numeric table slot are polymorphic.
  const primaryCallRe=new RegExp(`\\(${self}\\.([A-Za-z_]\\w*)\\)\\(${self},${payload},${env}\\)`);
  const primaryCall=primaryCallRe.exec(s);
  const primaryExecKey=primaryCall?.[1]??null,primaryAt=primaryCall?.index??-1;
  let primaryCallbackId=null;
  if(primaryAt>=0){const prefix=s.slice(0,primaryAt);const hits=[...prefix.matchAll(new RegExp(`\\[(${numRe})\\]=\\(function`,'g'))];if(hits.length)primaryCallbackId=n(hits.at(-1)[1]);}
  const vmsRe=new RegExp(`\\[(${numRe})\\]=\\(function\\(\\)local\\s+(\\w+)=${self}\\.([A-Za-z_]\\w*);${self}\\.\\3=nil;return\\s+\\2;end\\)`);
  const vm=vmsRe.exec(s);const vmsCallbackId=vm?n(vm[1]):null,vmsField=vm?.[3]??null;
  if(primaryExecKey==null||primaryCallbackId==null)throw new Error('V10 discovery: primary validator callback not found');
  return {key:e.key,source:s,self,payload,env,stateField,stateVar,envField,emptyFields,handlerField,bitField,payloadSeedField,antiField,secondaryField,loaderField,geKey,alphabet,mapField,hashField,antiSeedMagic,executorKey:executor.key,b91Key:b91.key,paramProtoKey,primaryExecKey,primaryCallbackId,vmsCallbackId,vmsField};
}

function discoverInlineDecoder(entries,classifications){
  const prop=[...classifications].find(([,sem])=>sem==='inline')?.[0];if(!prop)return null;
  const src=entries.find(e=>e.key===prop)?.value;if(!src)return null;
  const pm=/^\(function\(([^)]*)\)/.exec(src);if(!pm)return null;const [self,,ins]=pm[1].split(',').map(x=>x.trim());
  const lm=/local\s+([^=;]+)=([^;]+);/.exec(src);if(!lm)return null;
  const vars=lm[1].split(',').map(x=>x.trim()),rhs=lm[2].split(',').map(x=>x.trim());
  for(let i=0;i<vars.length;i++){
    if(!new RegExp(`\\b${vars[i]}\\(${self},${ins}\\)`).test(src))continue;
    const m=new RegExp(`^${self}\\.([A-Za-z_]\\w*)$`).exec(rhs[i]||'');if(m)return m[1];
  }
  return null;
}

function discoverOperandLayout(entries, classifications, resolver){
  const sourceFor=semantic=>{
    const prop=[...classifications.entries()].find(([,v])=>v===semantic)?.[0];
    return prop?entries.find(e=>e.key===prop)?.value??'':'';
  };
  const signature=src=>/^\(function\(([^)]*)\)/.exec(src)?.[1].split(',').map(x=>x.trim())??[];
  const firstDecl=src=>{const m=/local\s+([^=;]+)=([^;]+);/.exec(src);return m?{vars:m[1].split(',').map(x=>x.trim()),vals:m[2].split(',').map(x=>x.trim()),end:m.index+m[0].length}:null;};

  const move=sourceFor('move'), moveArgs=signature(move), ins=moveArgs[2], decl=firstDecl(move);
  if(!ins||!decl)throw new Error('V10 discovery: move instruction layout missing');
  let operandsKey=null,primaryOperandKey=null,bundleVar=null;
  for(let i=0;i<decl.vars.length;i++){
    const m=new RegExp(`^${ins}\\[(${numRe})\\]$`).exec(decl.vals[i]??'');
    if(!m)continue;
    const candidate=decl.vars[i], tail=move.slice(decl.end);
    const child=new RegExp(`local\\s+(\\w+)\\s*=\\s*${candidate}\\[(${numRe})\\]`).exec(tail);
    if(!child)continue;
    const inner=n(child[2]);
    // The direct child of the instruction-derived bundle is the descriptor.
    // Handler-local aliases are polymorphic, so requiring the descriptor fields
    // to be accessed through the first alias is unnecessarily brittle.
    operandsKey=n(m[1]);primaryOperandKey=inner;bundleVar=candidate;break;
  }
  if(operandsKey==null||primaryOperandKey==null)throw new Error('V10 discovery: operand bundle layout not found');

  const binary=sourceFor('binary'), bArgs=signature(binary), bins=bArgs[2], bDecl=firstDecl(binary);
  let secondaryOperandKey=null;
  if(bins&&bDecl){
    let bvar=null;
    for(let i=0;i<bDecl.vars.length;i++) if(new RegExp(`^${bins}\\[${operandsKey}\\]$`).test(bDecl.vals[i]??'')){bvar=bDecl.vars[i];break;}
    if(bvar){
      const tail=binary.slice(bDecl.end);
      const pair=new RegExp(`local\\s+[^=;]+\\s*=\\s*${bvar}\\[(${numRe})\\]\\s*,\\s*${bvar}\\[(${numRe})\\]`).exec(tail);
      if(pair){const ks=[n(pair[1]),n(pair[2])];secondaryOperandKey=ks.find(k=>k!==primaryOperandKey)??ks[1];}
    }
  }
  if(secondaryOperandKey==null)throw new Error('V10 discovery: secondary operand slot not found');
  return {operandsKey,primaryOperandKey,secondaryOperandKey};
}

function discoverInstructionLayout(entries, classifications, inlineDecoderKey, resolver){
  const wrappers=[...classifications.entries()].filter(([,v])=>v==='dispatch_wrapper').map(([p])=>entries.find(e=>e.key===p)?.value).filter(Boolean);
  let payloadKey=null,opcodeKey=null,cacheKey=null;
  for(const src of wrappers){
    const pm=/^\(function\(([^)]*)\)/.exec(src); if(!pm)continue;
    const args=pm[1].split(',').map(x=>x.trim()), ins=args[2]; if(!ins)continue;
    const q=new RegExp(`local\\s+\\w+(?:\\s*,\\s*\\w+)*\\s*=.*?${ins}\\[(${numRe})\\];if type\\(\\w+\\) ~= "string"`).exec(src);
    if(q)payloadKey=n(q[1]);
    const clear=[...src.matchAll(new RegExp(`${ins}\\[(${numRe})\\]\\s*=\\s*nil`,'g'))];
    if(clear.length)cacheKey=n(clear.at(-1)[1]);
    // Immediately before dispatch decoding wrappers read the encoded opcode from
    // the copied instruction. It is distinct from the handler-cache slot.
    const reads=[...src.matchAll(new RegExp(`local\\s+\\w+\\s*=\\s*${ins}\\[(${numRe})\\]\\s*;if \w+ == nil then return`,'g'))];
    if(reads.length)opcodeKey=n(reads.at(-1)[1]);
    if(payloadKey!=null&&opcodeKey!=null&&cacheKey!=null)break;
  }
  let inlineListKey=null;
  if(inlineDecoderKey){
    const e=entries.find(x=>x.key===inlineDecoderKey);
    if(e){const pm=/^\(function\(([^)]*)\)/.exec(e.value);const args=pm?.[1].split(',').map(x=>x.trim());const ins=args?.[1];if(ins){const m=new RegExp(`return\\s+${ins}\\[(${numRe})\\]\\s+or\\s+\\{\\}`).exec(e.value);if(m)inlineListKey=n(m[1]);}}
  }
  const operands=discoverOperandLayout(entries,classifications,resolver);
  return {payloadKey,extraKey:payloadKey,opcodeKey,cacheKey,inlineListKey,...operands};
}

function discoverExtraSelectorConfig(entries, classifications, semantic){
  const prop=[...classifications.entries()].find(([,v])=>v===semantic)?.[0];
  if(!prop)return null;
  const s=entries.find(e=>e.key===prop)?.value;if(!s)return null;
  const m=/local\s+(\w+)\s*=\s*\w+\[(?:0x[0-9A-Fa-f]+|\d+)\]\s*;if type\(\1\)\s*~=\s*"number"\s*then[\s\S]{0,260}?\1\s*=\s*\w+\.\w+\.bxor\([^,]+,(0x[0-9A-Fa-f]+|\d+)\)/.exec(s);
  return {property:prop,mask:m?n(m[2]):0};
}
function classifyBinaryBranch(body){
  if(/__idiv|math\.floor\s*\([^)]*\/[^)]*\)/.test(body))return '//';
  const assign=/\b\w+\s*=\s*[^;]+/.exec(body)?.[0]??body;
  for(const [needle,op] of [[' ~= ','~='],[' == ','=='],[' >= ','>='],[' <= ','<='],[' > ','>'],[' < ','<'],[' + ','+'],[' - ','-'],[' * ','*'],[' / ','/'],[' % ','%'],[' ^ ','^'],[' .. ','..'],[' and ','and'],[' or ','or']]) if(assign.includes(needle))return op;
  return null;
}
function discoverBinaryConfig(entries, classifications){
  const prop=[...classifications.entries()].find(([,v])=>v==='binary')?.[0];if(!prop)return null;
  const s=entries.find(e=>e.key===prop)?.value;if(!s)return null;
  const sel=/local\s+(\w+)\s*=\s*\w+\[(?:0x[0-9A-Fa-f]+|\d+)\]\s*;if type\(\1\)\s*~=\s*"number"\s*then[\s\S]{0,260}?\1\s*=\s*\w+\.\w+\.bxor\([^,]+,(0x[0-9A-Fa-f]+|\d+)\)/.exec(s);
  const selector=sel?.[1]??null, mask=sel?n(sel[2]):0, ops={};
  if(selector){
    const marker=new RegExp(`(?:if|elseif)\\s+${selector}\\s*==\\s*(${numRe})\\s*then`,'g');
    const hits=[];let m;while((m=marker.exec(s)))hits.push({id:n(m[1]),start:m.index,bodyStart:marker.lastIndex});
    for(let i=0;i<hits.length;i++){
      const body=s.slice(hits[i].bodyStart, i+1<hits.length?hits[i+1].start:s.indexOf(';end;',hits[i].bodyStart)>=0?s.indexOf(';end;',hits[i].bodyStart):s.length);
      const op=classifyBinaryBranch(body);if(op)ops[hits[i].id]=op;
    }
  }
  return {mask,ops,property:prop,selector};
}
function discoverClosureLayout(entries, classifications){
  const prop=[...classifications.entries()].find(([,v])=>v==='closure')?.[0];
  const src=entries.find(e=>e.key===prop)?.value??'';
  const pm=/^\(function\((\w+),(\w+),(\w+)\)/.exec(src);if(!pm)throw new Error('V10 discovery: closure handler signature missing');
  const self=pm[1];
  const first=/local\s+([^=;]+)=([^;]+);/.exec(src);if(!first)throw new Error('V10 discovery: closure handler locals missing');
  const vars=first[1].split(',').map(x=>x.trim()), vals=first[2].split(',').map(x=>x.trim());
  const mapVar=v=>{const i=vars.indexOf(v);if(i<0)return null;return new RegExp(`^${self}\\.([A-Za-z_]\\w*)(?:\\s+or\\s+\\{\\})?$`).exec(vals[i]??'')?.[1]??null;};
  const m=/if\s+(\w+)\[(0x[0-9A-Fa-f]+|\d+)\]\s*~=\s*nil\s*then\s*\w+=\1;else\s*\w+=(\w+)\([^,]+,\1\[(0x[0-9A-Fa-f]+|\d+)\],\1\[(0x[0-9A-Fa-f]+|\d+)\],\1\[(0x[0-9A-Fa-f]+|\d+)\]\);end;/.exec(src);
  if(!m)throw new Error('V10 discovery: closure prototype builder pattern missing');
  const builderKey=mapVar(m[3]);if(!builderKey)throw new Error('V10 discovery: closure prototype builder property missing');
  return {property:prop,builderKey,processedKey:n(m[2]),rawKeys:[n(m[4]),n(m[5]),n(m[6])]};
}

function discoverPrototypeLayout(entries, bootstrap, resolver){
  const s=entries.find(e=>e.key===bootstrap.executorKey)?.value??'';
  let constantPoolKey=null;
  const re=new RegExp(`\\[(${numRe})\\]\\s*=\\s*\\w+\\[(${numRe})\\]`,'g');
  let m;while((m=re.exec(s))){if(n(m[1])===resolver.constantsStateKey){constantPoolKey=n(m[2]);break;}}
  if(constantPoolKey==null)throw new Error('V10 discovery: prototype constant-pool field not found');
  return {constantPoolKey};
}

export function discoverV10(wrapper){
  const entries=fnEntries(wrapper);
  const builder=findOne(entries,e=>e.value.includes('__pairs')&&e.value.includes('__newindex')&&e.value.length>3000,'handler builder');
  const hm=parseHandlerMap(builder.value);
  const mapped=mapHandlerFamilies(entries,hm.properties,classifyHandler); const classifications=mapped.classifications;
  // The explicit recognizer is a validator/debug signal. Structural assignment is
  // authoritative because numeric slots and object property names are polymorphic.
  const recognizerMismatches=[];
  for(const prop of hm.properties){const e=entries.find(x=>x.key===prop);if(!e)continue;const explicit=classifyHandler(e.value);const structural=classifications.get(prop);if(explicit!=='unknown'&&explicit!==structural)recognizerMismatches.push({property:prop,explicit,structural});}
  const runner=discoverRunner(entries); const lb=discoverLB(entries,builder.key,runner.key); const resolver=discoverResolver(entries); const prototypeLayout=discoverPrototypeLayout(entries,lb,resolver); const closureLayout=discoverClosureLayout(entries,classifications); const dest=discoverDest(entries,hm.properties); const binary=discoverBinaryConfig(entries,classifications); const select={move:discoverExtraSelectorConfig(entries,classifications,'move_select'),global:discoverExtraSelectorConfig(entries,classifications,'getglobal_select')}; const inlineDecoderKey=discoverInlineDecoder(entries,classifications); const instructionLayout=discoverInstructionLayout(entries,classifications,inlineDecoderKey,resolver);
  const dispatch={};for(const [id,prop] of hm.map){dispatch[id]={property:prop,semantic:classifications.get(prop)||'unknown'};}
  return {version:'V10',entryMethod:wrapper.entryMethod,builderKey:builder.key,runner,bootstrap:lb,resolver,dest,binary,select,inlineDecoderKey,instructionLayout,prototypeLayout,closureLayout,handlerMap:hm,handlerClassifications:classifications,dispatch,wrapperIds:Object.entries(dispatch).filter(([,x])=>x.semantic==='dispatch_wrapper').map(([id])=>Number(id)),inlineIds:Object.entries(dispatch).filter(([,x])=>x.semantic==='inline').map(([id])=>Number(id)),unknownHandlers:[...classifications].filter(([,v])=>v==='unknown').map(([k])=>k),handlerConfidence:mapped.confidence,recognizerMismatches};
}
