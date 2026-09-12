import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_PROBE_TIMEOUT_MS, LUA_RUNTIME_CANDIDATES } from '../config.js';

const luaString = s => JSON.stringify(s).replace(/\u2028|\u2029/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const luaArray = xs => `{${xs.map(x=>typeof x==='number'?x:luaString(x)).join(',')}}`;
const luaMapNum = obj => `{${Object.entries(obj).map(([k,v])=>`[${Number(k)}]=${luaString(v.semantic??String(v))}`).join(',')}}`;
const luaMapNumProp = obj => `{${Object.entries(obj).map(([k,v])=>`[${Number(k)}]=${luaString(v.property??'')}`).join(',')}}`;
function luaMapStrStr(m){return `{${[...m.entries()].map(([k,v])=>`[${luaString(k)}]=${luaString(v)}`).join(',')}}`; }
let cachedRuntime = null;

export function findLuaRuntime(preferred = null) {
  const envRuntime = process.env.LUA || null;
  const cacheKey = `${preferred ?? ''}\0${envRuntime ?? ''}`;
  if (cachedRuntime?.key === cacheKey) return cachedRuntime.command;

  const candidates = [...new Set([preferred, envRuntime, ...LUA_RUNTIME_CANDIDATES].filter(Boolean))];
  for (const command of candidates) {
    const result = spawnSync(command, ['-v'], { encoding: 'utf8', timeout: 3000 });
    if (!result.error && result.status === 0) {
      cachedRuntime = { key: cacheKey, command };
      return command;
    }
    if (preferred && command === preferred) {
      const detail = result.error?.message ?? `exit status ${result.status}`;
      throw new Error(`Configured Lua runtime is unavailable: ${preferred} (${detail})`);
    }
  }
  throw new Error(`No Lua runtime found (tried ${candidates.join(', ')})`);
}

export function makeProbe({ objectPath, discovery }) {
  const b=discovery.bootstrap,r=discovery.resolver,run=discovery.runner,d=discovery.dest,layout=discovery.instructionLayout??{},cl=discovery.closureLayout??{};
  const semanticMap=luaMapNum(discovery.dispatch); const propertyMap=luaMapNumProp(discovery.dispatch);
  const allIds=discovery.handlerMap.dispatchIds;
  const wrapperIds=discovery.wrapperIds, inlineIds=discovery.inlineIds;
  const constKinds=r.constKinds;
  const propSemantic=luaMapStrStr(discovery.handlerClassifications);
  return `
local object_path=${luaString(objectPath)}
local C={
 entry=${luaString(discovery.entryMethod)}, lB=${luaString(b.key)}, state=${luaString(b.stateField)}, env=${luaString(b.envField)}, loader=${luaString(b.loaderField)},
 empties=${luaArray(b.emptyFields)}, builder=${luaString(discovery.builderKey)}, H=${luaString(b.handlerField)}, bit=${luaString(b.bitField)},
 seed=${luaString(b.payloadSeedField)}, anti=${luaString(b.antiField)}, sec=${luaString(b.secondaryField)}, ge=${luaString(b.geKey)}, map=${luaString(b.mapField)}, alphabet=${luaString(b.alphabet)},
 runner=${luaString(run.key)}, executor=${luaString(b.executorKey)}, hash=${luaString(b.hashField||'')}, antiMagic=${b.antiSeedMagic||0}, paramProtoKey=${b.paramProtoKey}, primaryExec=${luaString(b.primaryExecKey)}, primaryCb=${b.primaryCallbackId}, vmsCb=${b.vmsCallbackId??0}, vms=${luaString(b.vmsField||'')},
 resolver=${luaString(r.key)}, valueKey=${r.valueKey}, kindKey=${r.kindKey}, defaultKind=${r.defaultKind}, regKind=${r.regKind}, immKind=${r.immKind}, constKinds=${luaArray(constKinds)}, regKey=${r.registerStateKey}, constKey=${r.constantsStateKey}, protoConstKey=${discovery.prototypeLayout.constantPoolKey}, protoBuilder=${luaString(cl.builderKey)}, protoProcessedKey=${cl.processedKey}, protoRaw1=${cl.rawKeys[0]}, protoRaw2=${cl.rawKeys[1]}, protoRaw3=${cl.rawKeys[2]}, pcContext=${luaString(r.pcContextField||'')},
 destKey=${d.key}, destBias=${d.bias}, destMul=${d.multiplier}, destMod=${d.modulus}, extraKey=${layout.extraKey}, operandsKey=${layout.operandsKey}, primaryOperandKey=${layout.primaryOperandKey}, secondaryOperandKey=${layout.secondaryOperandKey}, inlineListKey=${layout.inlineListKey??0}, inlineDecoder=${luaString(discovery.inlineDecoderKey||'')}, props=${propSemantic},
 pcKey=${run.pcKey}, baseA=${run.baseA}, baseB=${run.baseB}, baseLeft=${run.baseLeft}, baseRight=${run.baseRight}, ids=${luaArray(allIds)}, wrappers=${luaArray(wrapperIds)}, inlines=${luaArray(inlineIds)}, semantic=${semanticMap}, property=${propertyMap}
}
local function setof(a)local t={} for _,v in ipairs(a)do t[v]=true end return t end
local WRAP,INLINE,CONST=setof(C.wrappers),setof(C.inlines),setof(C.constKinds)
local function hex(s)local out={} for i=1,#s do out[i]=string.format('%02x',string.byte(s,i)) end return table.concat(out) end
local function json_escape(s)
 local o={'"'}
 for i=1,#s do local c=string.byte(s,i); if c==34 then o[#o+1]='\\\\"' elseif c==92 then o[#o+1]='\\\\\\\\' elseif c==8 then o[#o+1]='\\\\b' elseif c==9 then o[#o+1]='\\\\t' elseif c==10 then o[#o+1]='\\\\n' elseif c==12 then o[#o+1]='\\\\f' elseif c==13 then o[#o+1]='\\\\r' elseif c<32 or c>126 then o[#o+1]=string.format('\\\\u%04x',c) else o[#o+1]=string.char(c) end end
 o[#o+1]='"';return table.concat(o)
end
local function j(v,seen)
 local t=type(v); if t=='nil' then return 'null' elseif t=='boolean' or t=='number' then return tostring(v) elseif t=='string' then return json_escape(v) end
 if t~='table' then return 'null' end; seen=seen or {}; if seen[v] then return 'null' end; seen[v]=true
 local isarr,max,n=true,0,0; for k,_ in pairs(v) do if type(k)~='number' or k<1 or k%1~=0 then isarr=false;break end;max=math.max(max,k);n=n+1 end
 local out={}; if isarr and max==n then for i=1,max do out[#out+1]=j(v[i],seen) end seen[v]=nil;return '['..table.concat(out,',')..']' end
 for k,val in pairs(v) do if type(k)=='number' or type(k)=='string' then out[#out+1]=json_escape(tostring(k))..':'..j(val,seen) end end; seen[v]=nil;return '{'..table.concat(out,',')..'}'
end
local function clone(v,seen) if type(v)~='table' then return v end;seen=seen or{};if seen[v]then return seen[v]end;local o={};seen[v]=o;for k,x in pairs(v)do if type(x)~='function'then o[clone(k,seen)]=clone(x,seen)end end;return o end
local function clone_state(v,seen) if type(v)~='table' then return v end;seen=seen or{};if seen[v]then return seen[v]end;local o={};seen[v]=o;for k,x in pairs(v)do o[clone_state(k,seen)]=clone_state(x,seen)end;return o end
local function bxor(a,b) if bit32 and bit32.bxor then return bit32.bxor(a,b) end local r,p=0,1;a=a%4294967296;b=b%4294967296;for _=1,32 do local aa,bb=a%2,b%2;if aa~=bb then r=r+p end;a=(a-aa)/2;b=(b-bb)/2;p=p*2 end;return r end
local obj=assert(loadfile(object_path))();local RESOLVE_OBJ=obj;local FRESH_PRIMARY=nil;local FRESH_BANK=nil
local CAP=nil;local PRIMARY=nil;local PRIMARY_SEEDED=false;local SAVED_HANDLERS={}
local function hids(ins)
 local fn=nil;for _,v in pairs(ins)do if type(v)=='function'then fn=v;break end end;if not fn then return {} end
 local out={};local H=obj[C.H];if not H then return out end;for _,id in ipairs(C.ids)do if H[id]==fn then out[#out+1]=id end end;return out
end
local function hid(ins)local a=hids(ins);return a[1] end
local function pcbase(state) if C.baseLeft==0 or C.baseRight==0 then return 0 end;return (state[C.baseLeft] or 0)-(state[C.baseRight] or 0) end
local function setpc(state,pc) if C.pcKey~=0 then state[C.pcKey]=pcbase(state)+pc+1 end end
local function with_capture_handlers(keep,collector,fn,disableAnti)
 local H=obj[C.H];local saved={};for _,id in ipairs(C.ids)do saved[id]=H[id];if not keep[id] then local cid=id;H[id]=function(a,b,x)return collector(cid,a,b,x)end end end
 local anti=C.anti~='' and obj[C.anti] or nil;if disableAnti and C.anti~='' then obj[C.anti]=nil end
 local ok,a=pcall(fn)
 if disableAnti and C.anti~='' then obj[C.anti]=anti end;for _,id in ipairs(C.ids)do H[id]=saved[id] end
 return ok,a
end
local function base_id(ins,state,pc)
 local cached=hid(ins);if cached then return cached end
 local fake=clone_state(state);local one=clone(ins);setpc(fake,pc);local got=nil
 with_capture_handlers({},function(cid)if got==nil then got=cid end end,function()return (obj[C.runner])(obj,fake,{[pc]=one})end,true)
 return got
end
local function refine_id(ins,state,pc,id)
 if not id or C.anti=='' then return id end
 local anti=obj[C.anti];local H=obj[C.H];if type(anti)~='function'or type(H)~='table'then return id end
 local original=H[id];if type(original)~='function'then return id end
 local c=clone(ins);local ok,eff=pcall(anti,c,pc,id,original)
 if not ok or type(eff)~='function'or eff==original then return id end
 -- The anti-transform can return a short-lived forwarding closure. It stores
 -- the original target in instruction metadata. Replace that stored function
 -- with a collector before invoking the forwarding closure, and patch H as
 -- collectors too. This executes only the VM remapping logic, never an opcode.
 local captured=nil
 for _,v in pairs(c)do
   if type(v)=='table' then
     for k,x in pairs(v)do
       if type(x)=='function' then local fallback=id;v[k]=function()if captured==nil then captured=fallback end;return nil end end
     end
   end
 end
 local fake=clone_state(state);setpc(fake,pc)
 with_capture_handlers({},function(cid)if captured==nil then captured=cid end end,function()return eff(obj,fake,c)end,false)
 return captured or id
end
local function resolve_id(ins,state,pc)
 local tagged=rawget(ins,'__probe_id');if tagged~=nil then return tagged end
 local id=base_id(ins,state,pc);return refine_id(ins,state,pc,id)
end
local function expand(ins,state,pc,depth)
 depth=depth or 0;if depth>64 or type(ins)~='table'then return {{ins=ins,id=type(ins)=='table' and resolve_id(ins,state,pc) or nil,logical_pc=pc}} end
 local id=resolve_id(ins,state,pc); if rawget(ins,'__probe_id')~=nil then ins.__probe_id=nil end
 if not id then return {{ins=clone(ins),id=nil,semantic='nop',logical_pc=pc,decoy='undispatched'}} end
 if id and WRAP[id] then
   local got=nil;local keep={}
   local c=clone(ins);local payload=rawget(c,C.extraKey);if type(payload)~='string' or payload=='' then return {{ins=c,id=nil,semantic='nop',logical_pc=pc,decoy='empty_wrapper'}} end;setpc(state,pc)
   local ok,err=with_capture_handlers(keep,function(cid,_,_,x)got=clone(x);got.__probe_id=cid end,function()local hf=SAVED_HANDLERS[C.property[id]] or obj[C.H][id];return hf(obj,state,c)end)
   if got then return expand(got,state,pc,depth+1) end
   local ee=nil;if not ok then ee=tostring(err)end;return {{ins=c,id=id,logical_pc=pc,expand_error=ee}}
 end
 if id and INLINE[id] then
   local c=clone(ins);local packed=C.inlineListKey~=0 and rawget(c,C.inlineListKey) or nil
   if type(packed)~='table' or #packed==0 then return {{ins=c,id=nil,semantic='nop',logical_pc=pc,decoy='empty_inline'}} end
   local out={}
   -- Decode each superinstruction child in isolation. Running the whole inline
   -- handler with collector opcodes can perturb its internal PC walk whenever a
   -- child is a branch. A one-child envelope asks the VM only for that child's
   -- private dispatch transform and cannot execute neighboring instructions.
   for ii=1,#packed do
     local child=packed[ii]
     if type(child)~='table' then
       out[#out+1]={ins={},id=nil,semantic='invalid_inline',logical_pc=pc+ii-1,expand_error='malformed inline child'}
     else
       local parent=clone(c);parent[C.inlineListKey]={clone(child)};local got=nil;local gerr=nil;setpc(state,pc+ii-1)
       local ok,err=with_capture_handlers({},function(cid,_,_,x)if got==nil then got=clone(x);got.__probe_id=cid end end,function()local hf=SAVED_HANDLERS[C.property[id]] or obj[C.H][id];return hf(obj,state,parent)end,true)
       if got then
         local ex=expand(got,state,pc+ii-1,depth+1);for _,z in ipairs(ex)do out[#out+1]=z end
       elseif not ok then
         out[#out+1]={ins=clone(child),id=id,semantic='invalid_inline',logical_pc=pc+ii-1,expand_error=tostring(err)}
       else
         out[#out+1]={ins=clone(child),id=nil,semantic='nop',logical_pc=pc+ii-1,decoy='undispatched_inline_child'}
       end
     end
   end
   return out
 end
 return {{ins=clone(ins),id=id,logical_pc=pc}}
end
local function is_operand_desc(v)
 return type(v)=='table' and (rawget(v,C.kindKey)~=nil or rawget(v,C.valueKey)~=nil)
end
local function canonical_ops(v)
 if type(v)~='table' then return nil end
 local a,b=rawget(v,C.primaryOperandKey),rawget(v,C.secondaryOperandKey)
 if is_operand_desc(a) or is_operand_desc(b) then return {[1]=a,[2]=b} end
 return nil
end
local function find_ops(ins)
 -- Operand locations are polymorphic in V10. Discovery derives all three keys
 -- from the target build's move/binary handler bodies before the probe runs.
 local direct=canonical_ops(rawget(ins,C.operandsKey));if direct then return direct end
 return nil
end

local function sval(v)
 local t=type(v);if t=='nil'then return {type='nil'}elseif t=='number'or t=='boolean'then return {type=t,value=v}elseif t=='string'then return {type='string',hex=hex(v)}else return {type=t}end
end
local function operand(desc,state,pc,resolvePool)
 if type(desc)~='table'then return {kind='none',value=0}end
 local kind=rawget(desc,C.kindKey);if kind==nil then kind=C.defaultKind end;local value=rawget(desc,C.valueKey) or 0;local name='unknown';if kind==C.regKind then name='reg'elseif kind==C.immKind then name='imm'elseif CONST[kind]then name='const'elseif kind==C.defaultKind then name='none'end
 local out={kind=name,kindCode=kind,value=value};if name=='const' then local ro=RESOLVE_OBJ or obj;local rs=state;if resolvePool then rs={[C.constKey]=resolvePool} end;if C.pcContext~=''then ro[C.pcContext]=pc end;local ok,v=pcall(ro[C.resolver],ro,rs,desc);out.resolved=ok and sval(v) or {type='error',value=tostring(v)} end;return out
end
local function poolof(state)local out={} local p=state[C.constKey];if type(p)=='table'then for k,v in pairs(p)do if type(k)=='number'then out[tostring(k)]=sval(v)end end end;return out end
local function destof(ins)local rawDest=rawget(ins,C.destKey) or C.destBias;return ((rawDest-C.destBias)*C.destMul)%C.destMod end
local function normalized(x,state,sourcePc,sub,resolvePool)
 local ins=x.ins or {};local pc=x.logical_pc or sourcePc;local ops=find_ops(ins);local dest=destof(ins)
 local extra=rawget(ins,C.extraKey);local o={pc=pc,sourcePc=sourcePc,sub=sub or 0,handlerId=x.id,semantic=x.semantic or ((x.id and C.semantic[x.id])or'unknown'),dest=dest,op1=operand(ops and ops[1],state,pc,resolvePool),op2=operand(ops and ops[2],state,pc,resolvePool),extra=sval(extra)};if x.decoy then o.decoy=x.decoy end
 if x.expand_error then o.expandError=x.expand_error end;return o
end
local PROGRAMS,CHILD_BY_KEY={},{}
local normalize_program,capture_child
local function closure_bindings(meta)
 if type(meta)~='table'then return {} end
 local best={};for _,v in pairs(meta)do
  if type(v)=='table'then local cur,good={},0
   for k,b in pairs(v)do if type(k)=='number'and type(b)=='table'and type(b[1])=='number'and type(b[2])=='number'then good=good+1;cur[#cur+1]={slot=k,kind=b[1],index=b[2]}end end
   if good>#best then best=cur end
  end
 end
 table.sort(best,function(a,b)return a.slot<b.slot end);return best
end
local function pool_for_key(protoKey)
 if type(FRESH_BANK)~='table'or protoKey==nil then return nil end
 local proto=FRESH_BANK[protoKey];if type(proto)~='table'then return nil end
 if C.protoProcessedKey~=0 and rawget(proto,C.protoProcessedKey)==nil and C.protoBuilder~='' then
  local ro=RESOLVE_OBJ or obj;local builder=ro[C.protoBuilder]
  if type(builder)=='function' then
   local ok,p=pcall(builder,ro,rawget(proto,C.protoRaw1),rawget(proto,C.protoRaw2),rawget(proto,C.protoRaw3))
   if ok and type(p)=='table' then proto=p;FRESH_BANK[protoKey]=p end
  end
 end
 if C.protoConstKey~=0 then return rawget(proto,C.protoConstKey) end
 return nil
end
local function closure_proto_key(meta)
 if type(meta)~='table'or type(FRESH_BANK)~='table'then return nil end
 for _,v in pairs(meta)do if type(v)=='number'and FRESH_BANK[v]~=nil then return v end end
 return nil
end
local function proto_param_count(state,ins)
 if C.paramProtoKey==0 then return 0 end
 for _,v in pairs(state)do if type(v)=='table'then for _,x in pairs(v)do if x==ins then return rawget(v,C.paramProtoKey) or 0 end end end end
 return 0
end
capture_child=function(x,parentState,pc,depth)
 if depth>=10 then return nil,'prototype recursion limit' end
 local ins=x.ins or {};local extra=rawget(ins,C.extraKey);local key=(type(extra)=='string' and hex(extra) or tostring(extra))..':'..tostring(x.id or 0)
 if CHILD_BY_KEY[key] then return CHILD_BY_KEY[key] end
 local prop=x.id and C.property[x.id] or nil;local hf=prop and SAVED_HANDLERS[prop] or nil
 if type(hf)~='function' then return nil,'closure handler unavailable' end
 local ps=clone_state(parentState);setpc(ps,pc);local ci=clone(ins);local childCap=nil;local origR=obj[C.runner]
 -- The closure handler captures the runner in a local upvalue while constructing
 -- the Lua closure. Install the capture runner before invoking the handler so the
 -- child can never execute protected bytecode, even after the object field is restored.
 obj[C.runner]=function(ss,state,childIns)childCap={state=state,ins=childIns};return nil end
 local okh,eh=pcall(hf,obj,ps,ci)
 local meta=rawget(ci,C.extraKey);local bindings=closure_bindings(meta);local protoKey=closure_proto_key(meta);local resolvePool=pool_for_key(protoKey);local regs=ps[C.regKey];local fn=type(regs)=='table' and regs[destof(ci)] or nil
 local okc,ec=false,'closure unavailable';if okh and type(fn)=='function' then okc,ec=pcall(fn) end
 obj[C.runner]=origR
 if not okh then return nil,'closure construction failed: '..tostring(eh) end
 if type(fn)~='function' then return nil,'closure handler did not produce a function' end
 if not childCap then return nil,'child prototype capture failed: '..tostring(ec) end
 local childId=#PROGRAMS+1;local info={id=childId,upvalues=bindings};CHILD_BY_KEY[key]=info;PROGRAMS[childId]={id=childId,pending=true}
 local pr=normalize_program(childCap.state,childCap.ins,depth+1,resolvePool);pr.id=childId;pr.prototypeKey=protoKey;pr.paramCount=proto_param_count(childCap.state,childCap.ins);PROGRAMS[childId]=pr
 return info
end
normalize_program=function(state,ins,depth,resolvePool)
 local count=rawget(ins,0)or #ins;local pr={instructionCount=count,instructions={},depth=depth or 0,constants=poolof(state)};local pc=1
 while pc<=count do
  local raw=ins[pc];local ex=expand(raw,state,pc,0);local last=pc
  for si,x in ipairs(ex)do
   local lp=x.logical_pc or pc;if lp>last then last=lp end;local row=normalized(x,state,pc,si-1,resolvePool)
   if row.semantic=='closure' then local info,cerr=capture_child(x,state,row.pc,depth or 0);if info then row.prototype=info.id;row.upvalues=info.upvalues else row.prototypeError=cerr end end
   pr.instructions[#pr.instructions+1]=row
  end
  pc=math.max(pc+1,last+1)
 end
 return pr
end
local originalLB=obj[C.lB]
obj[C.lB]=function(self,payload,env)
 env=env or _G;local st=self[C.state];if type(st)=='table'then st[1]=2;st[2]=env end;self[C.env]=env
 for _,k in ipairs(C.empties)do self[k]={}end
 local mp={};for i=1,#C.alphabet do mp[string.byte(C.alphabet,i)]=i-1 end;self[C.map]=mp
 -- Lua 5.4 removed the global bit32 library. Recreate the bootstrap bit backend
 -- when the target object has not built it yet.
 local PB=bit32 or self[C.bit]
 if not PB then
  local function band(a,b)local r,p=0,1;a=a%4294967296;b=b%4294967296;for _=1,32 do local aa,bb=a%2,b%2;if aa==1 and bb==1 then r=r+p end;a=(a-aa)/2;b=(b-bb)/2;p=p*2 end;return r end
  local function bor(a,b)local r,p=0,1;a=a%4294967296;b=b%4294967296;for _=1,32 do local aa,bb=a%2,b%2;if aa==1 or bb==1 then r=r+p end;a=(a-aa)/2;b=(b-bb)/2;p=p*2 end;return r end
  local function bnot(a)return 4294967295-(a%4294967296) end
  local function lshift(a,n)if n>=32 then return 0 end;return (a%4294967296)*(2^n)%4294967296 end
  local function rshift(a,n)if n>=32 then return 0 end;return math.floor((a%4294967296)/(2^n)) end
  PB={bxor=bxor,band=band,bor=bor,bnot=bnot,lshift=lshift,rshift=rshift}
 end
 self[C.bit]=PB
 for prop,_ in pairs(C.props)do SAVED_HANDLERS[prop]=self[prop] end;self[C.H]=self[C.H] or self[C.builder](self);self[C.builder]=nil;self[C.seed]=payload
 if C.hash~=''and type(st)=='table'then self[C.hash]=st[3]end
 local af=C.anti~=''and self[C.anti]or nil;if af then local sec=self[C.sec];local seed=((type(sec)=='string'and #sec or 0)*33+(type(payload)=='string'and #payload or 0)*17+(type(st)=='table'and(st[3]or 0)or 0)+(type(st)=='table'and(st[4]or 0)or 0)+C.antiMagic)%0x7fffffff;pcall(af,true,seed)end
 if self[C.sec] ~= nil and not self[C.loader] then local okd,v=pcall(self[C.ge],self,self[C.sec],0);if not okd or type(v)~='table'then error('probe secondary decode failed: '..tostring(v),0)end;self[C.loader]=v end
 local decoded=self[C.loader];if type(decoded)~='table'then error('probe prototype missing',0)end
 local argv={n=6,[1]=self,[2]=payload,[3]=env,[4]=false,[5]=self[C.bit],[6]={}}
 local origR=self[C.runner];self[C.runner]=function(ss,state,ins)CAP={state=state,ins=ins,decoded=decoded};return nil end
 local ok2,err2=pcall(self[C.executor],self,decoded,argv);self[C.runner]=origR;if not ok2 then error('probe state build failed: '..tostring(err2),0)end
 -- Run the *validator* VM only far enough to reach its primary-payload callback.
 -- This is required because V10 seeds its lazy constant decoder in that phase.
 -- The primary callback is replaced with a capture routine, so protected user
 -- bytecode itself is never dispatched during extraction.
 local callbacks=setmetatable({},{__index=function()return function()return nil end end})
 if C.vmsCb~=0 and C.vms~='' then callbacks[C.vmsCb]=function()local v=self[C.vms];self[C.vms]=nil;return v end end
 callbacks[C.primaryCb]=function(...)
   PRIMARY_SEEDED=true
   local okp,pdecoded=pcall(self[C.ge],self,payload,0)
   if not okp or type(pdecoded)~='table' then error('primary decode failed: '..tostring(pdecoded),0) end
   local saved=self[C.runner];self[C.runner]=function(ss,state,ins)PRIMARY={state=state,ins=ins,decoded=pdecoded};return nil end
   local ok3,err3=pcall(self[C.executor],self,pdecoded,nil);self[C.runner]=saved
   if not ok3 then PRIMARY={error=tostring(err3),decoded=pdecoded} end
   error('__GOOFY_PRIMARY_CAPTURED__',0)
 end
 local seeded={n=6,[1]=self,[2]=payload,[3]=env,[4]=false,[5]=self[C.bit],[6]=callbacks}
 pcall(self[C.executor],self,decoded,seeded)
 -- Fallback for structurally compatible builds whose validator exits before the
 -- primary callback. This path is less useful because lazy constants may remain
 -- unavailable, but still yields the complete prototype graph for diagnostics.
 if not PRIMARY then
   local okp,pdecoded=pcall(self[C.ge],self,payload,0)
   if okp and type(pdecoded)=='table' then
     self[C.runner]=function(ss,state,ins)PRIMARY={state=state,ins=ins,decoded=pdecoded};return nil end
     local ok3,err3=pcall(self[C.executor],self,pdecoded,nil);self[C.runner]=origR
     if not ok3 then PRIMARY={error=tostring(err3),decoded=pdecoded} end
   end
 end
 if type(st)=='table'then st[1]=3 end;return nil
end
local ok,err=pcall(obj[C.entry],obj,_G)
if not CAP then io.stderr:write('PROBE_ERROR:'..tostring(err)..'\\n');os.exit(12)end
-- Re-enter through a pristine copy of the original bootstrap and intercept its
-- own primary bridge. This keeps the validator's exact final seed transition,
-- while the primary VM runner is replaced before its first protected opcode.
do
 local fresh=assert(loadfile(object_path))();local freshPrimary=nil;local freshSnapshot=nil;local freshState=nil;local bridge=fresh[C.primaryExec]
 if type(bridge)=='function' then
  fresh[C.primaryExec]=function(self,payload,env,tfl)
   freshSnapshot={};for k,v in pairs(self)do freshSnapshot[k]=v end;freshState=clone_state(self[C.state])
   local okd,pdecoded=pcall(self[C.ge],self,payload,0);if not okd or type(pdecoded)~='table'then error('__GOOFY_PRIMARY_DECODE_FAILED__',0)end
   local old=self[C.runner];self[C.runner]=function(ss,state,ins)freshPrimary={state=state,ins=ins,decoded=pdecoded};return nil end
   local okx,erx=pcall(self[C.executor],self,pdecoded,tfl);self[C.runner]=old
   if not okx then freshPrimary={error=tostring(erx),decoded=pdecoded} end
   error('__GOOFY_PRIMARY_CAPTURED__',0)
  end
  pcall(fresh[C.entry],fresh,_G)
  if freshSnapshot then for k,v in pairs(freshSnapshot)do fresh[k]=v end;if freshState then fresh[C.state]=freshState end end
  if freshPrimary and freshPrimary.state then RESOLVE_OBJ=fresh;FRESH_PRIMARY=freshPrimary;FRESH_BANK=(freshPrimary.decoded and freshPrimary.decoded[2]) or {};PRIMARY_SEEDED=true;if not PRIMARY then PRIMARY=freshPrimary end end
 end
end
local root=PRIMARY and PRIMARY.state and PRIMARY or CAP
local rootPool=FRESH_PRIMARY and FRESH_PRIMARY.state and FRESH_PRIMARY.state[C.constKey] or nil
local main=normalize_program(root.state,root.ins,0,rootPool);main.id=0;main.paramCount=main.paramCount or ((root.decoded and C.paramProtoKey~=0 and (root.decoded[C.paramProtoKey] or 0)) or 0)
local ordered={main};for i=1,#PROGRAMS do if PROGRAMS[i] and not PROGRAMS[i].pending then ordered[#ordered+1]=PROGRAMS[i] end end
local out={version='V10',primarySeeded=PRIMARY_SEEDED,freshPrimary=(FRESH_PRIMARY~=nil),root=(PRIMARY and PRIMARY.state) and 'primary' or 'secondary',instructionCount=main.instructionCount,instructions=main.instructions,programs=ordered,entryOk=ok}
if PRIMARY and PRIMARY.error then out.primaryError=PRIMARY.error end
print(j(out))
`;
}
export function runProbe({ wrapperSource, discovery, tempRoot = null, luaCommand = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  const root = fs.mkdtempSync(path.join(tempRoot ?? os.tmpdir(), 'goofy-deobf-'));
  const objectPath = path.join(root, 'object.lua');
  const probePath = path.join(root, 'probe.lua');
  try {
    fs.writeFileSync(objectPath, `return (${wrapperSource.tableSource})`, 'latin1');
    fs.writeFileSync(probePath, makeProbe({ objectPath, discovery }), 'utf8');

    const command = findLuaRuntime(luaCommand);
    const result = spawnSync(command, [probePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    });

    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') throw new Error(`Lua probe timed out after ${timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS} ms`);
      throw new Error(`Lua probe failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(`Lua probe failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
    }

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error('Lua probe produced no output');
    const payload = lines.at(-1);
    try {
      return JSON.parse(payload);
    } catch (error) {
      const preview = payload.length > 500 ? `${payload.slice(0, 500)}…` : payload;
      throw new Error(`Lua probe returned invalid JSON: ${preview}`, { cause: error });
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
