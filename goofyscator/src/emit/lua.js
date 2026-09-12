import { WATERMARK } from '../config.js';

export function luaNumber(n) {
  if (Number.isNaN(n)) return '(0/0)';
  if (n === Infinity) return '(1/0)';
  if (n === -Infinity) return '(-1/0)';
  if (Object.is(n, -0)) return '-0.0';
  return Number.isInteger(n) ? String(n) : Number(n).toString();
}
export function luaString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i) & 0xff;
    if (b === 34) out += '\\"';
    else if (b === 92) out += '\\\\';
    else if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    else out += `\\${String(b).padStart(3, '0')}`;
  }
  return out + '"';
}
function value(v) {
  if (!v) return 'nil';
  if (v.kind === 'reg') return `R[${v.index}]`;
  if (v.kind === 'literal') {
    if (v.value == null) return 'nil';
    if (typeof v.value === 'string') return luaString(v.value);
    if (typeof v.value === 'number') return luaNumber(v.value);
    if (typeof v.value === 'boolean') return v.value ? 'true' : 'false';
  }
  if (v.kind === 'global') return `_gget(${value(v.key)})`;
  if (v.kind === 'index') return `${postfixValue(v.table)}[${value(v.key)}]`;
  if (v.kind === 'unary') {
    const a = value(v.value);
    return v.operator === 'not' ? `(not ${a})` : `(${v.operator}${a})`;
  }
  if (v.kind === 'binary') {
    const a = value(v.left), b = value(v.right);
    if (v.operator === '//') return `_idiv(${a},${b})`;
    return `(${a} ${v.operator} ${b})`;
  }
  if (v.kind === 'logical') {
    const values = v.values ?? [];
    if (!values.length) return 'nil';
    return `(${values.map(value).join(` ${v.operator} `)})`;
  }
  if (v.kind === 'table') return `{${(v.entries ?? []).map(value).join(',')}}`;
  if (v.kind === 'call') return `${postfixValue(v.fn)}(${(v.args ?? []).map(value).join(',')})`;
  return 'nil --[[ unresolved value ]]';
}
function postfixValue(v) {
  const rendered = value(v);
  return ['literal','binary','unary','logical','table','call'].includes(v?.kind) ? `(${rendered})` : rendered;
}
function exprBinary(x) {
  const a=value(x.left), b=value(x.right);
  if (x.operator === '//') return `_idiv(${a},${b})`;
  return `(${a} ${x.operator} ${b})`;
}
function emitInstruction(x) {
  const L = [];
  switch (x.op) {
    case 'nop': return L;
    case 'move': L.push(`setr(${x.dst},${value(x.src)})`); break;
    case 'clear_range': L.push(`for _i=${x.from},${x.to} do setr(_i,nil) end`); break;
    case 'getglobal': L.push(`setr(${x.dst},_gget(${value(x.key)}))`); break;
    case 'setglobal': L.push(`_GREF[${value(x.key)}]=R[${x.src}]`); break;
    case 'getupval': L.push(`setr(${x.dst},up(${x.slot}))`); break;
    case 'newtable': L.push(`setr(${x.dst},{})`); break;
    case 'gettable': L.push(`setr(${x.dst},R[${x.table}][${value(x.key)}])`); break;
    case 'settable': L.push(`R[${x.table}][${value(x.key)}]=${value(x.value)}`); break;
    case 'self': L.push(`_self(R,setr,${x.dst},${value(x.key)})`); break;
    case 'setlist': L.push(`_setlist(R,${x.table},${x.from},${x.to},${x.open?'true':'false'},TOP)`); break;
    case 'unary': L.push(`setr(${x.dst},${x.operator==='not'?`not ${value(x.value)}`:`${x.operator}${value(x.value)}`})`); break;
    case 'binary': L.push(`setr(${x.dst},${exprBinary(x)})`); break;
    case 'logical_chain': {
      const values = x.values ?? [];
      L.push(`setr(${x.dst},${values.length ? `(${values.map(value).join(` ${x.operator} `)})` : 'nil'})`);
      break;
    }
    case 'move_pair': {
      // VM MOVE_PAIR is simultaneous: either destination may overlap either
      // source. Snapshot both values before calling setr(), otherwise the
      // compatibility path can silently corrupt swaps/fused move chains.
      L.push(`local _mv1=${value(x.src)},_mv2=R[${x.secondSrc}]`,
        `setr(${x.dst},_mv1)`, `setr(${x.secondDst},_mv2)`);
      break;
    }
    case 'jump': L.push(`goto L_${x.target}`); break;
    case 'branch_false': L.push(`if not ${value(x.condition)} then goto L_${x.target} end`); break;
    case 'forprep': L.push(`_forprep(R,setr,${x.index},${x.limit},${x.step})`, `if _for_done(R,${x.index},${x.limit},${x.step}) then goto L_${x.target} end`); break;
    case 'forloop': L.push(`setr(${x.index},R[${x.index}]+R[${x.step}])`, `if _for_live(R,${x.index},${x.limit},${x.step}) then goto L_${x.target} end`); break;
    case 'tforloop': L.push(`if _tfor(R,setr,${x.base},${x.resultCount},${x.control},${x.resultBase}) then goto L_${x.target} end`); break;
    case 'call': L.push(`TOP=_call(R,setr,${x.base},${x.argCount},${x.resultCount},${x.openPrefix},TOP)`); break;
    case 'identity_results': {
      const n=x.resultCount<0?x.count:Math.max(0,x.resultCount);
      const temps=[];for(let i=0;i<x.count;i++)temps.push(`R[${x.sourceBase+i}]`);
      if(x.count) L.push(`local _v={${temps.join(',')}}`);
      for(let i=0;i<n;i++)L.push(`setr(${x.base+i},${i<x.count?`_v[${i+1}]`:'nil'})`);
      L.push(`TOP=${x.resultCount<0?x.base+x.count-1:x.resultCount>0?x.base+x.resultCount-1:x.base-1}`);
      break;
    }
    case 'constant_call': {
      if (x.resultCount === 0) L.push(`TOP=${x.base-1}`);
      else {
        L.push(`setr(${x.base},${value(x.value)})`);
        if (x.resultCount > 1) for (let i=1;i<x.resultCount;i++) L.push(`setr(${x.base+i},nil)`);
        L.push(`TOP=${x.resultCount > 0 ? x.base+x.resultCount-1 : x.base}`);
      }
      break;
    }
    case 'cell_new': {
      L.push(`setr(${x.dst},{value=${value(x.src)}})`);
      for(let i=1;i<Math.max(1,x.resultCount??1);i++)L.push(`setr(${x.dst+i},nil)`);
      break;
    }
    case 'cell_results': {
      const n=Math.max(0,x.resultCount??x.count??0),count=Math.max(0,x.count??0),mask=String(x.mask??'');
      // Snapshot inputs first: result and source ranges may overlap.
      if(count>0)L.push(`local _cv={${Array.from({length:count},(_,i)=>`R[${x.sourceBase+i}]`).join(',')}}`);
      for(let i=0;i<n;i++){const src=i<count?`_cv[${i+1}]`:'nil';L.push(`setr(${x.base+i},${mask[i]==='1'?`{value=${src}}`:src})`);}
      L.push(`TOP=${n>0?x.base+n-1:x.base-1}`);
      break;
    }
    case 'cell_get': {
      L.push(`setr(${x.dst},R[${x.cell}].value)`);
      for(let i=1;i<Math.max(1,x.resultCount??1);i++)L.push(`setr(${x.dst+i},nil)`);
      break;
    }
    case 'cell_set': L.push(`R[${x.cell}].value=${value(x.value)}`); break;
    case 'tailcall': L.push(`return _tail(R,${x.base},${x.argCount},${x.openPrefix},TOP)`); break;
    case 'return':
      if (!x.hasValues) L.push('return');
      else L.push(`return _ret(R,${x.base},${x.open?'(TOP-'+x.base+'+1)':x.count})`);
      break;
    case 'return_literal': L.push(`return ${value(x.value)}`); break;
    case 'return_cell': L.push(`return R[${x.cell}].value`); break;
    case 'vararg': L.push(`TOP=_vararg(VAR,setr,${x.base},${x.count})`); break;
    case 'closure': {
      if (x.prototype == null) { L.push(`setr(${x.dst},function() error(${luaString(x.error ?? 'missing prototype')},0) end)`); break; }
      const body=['do local U={}'];
      for (const b of x.upvalues ?? []) body.push(`U[${b.slot}]=${b.kind===0?`box(${b.index})`:`UP[${b.index}] or {nil}`}`);
      body.push(`setr(${x.dst},function(...) return P_${x.prototype}(U,...) end) end`); L.push(body.join(';'));
      break;
    }
    case 'close': L.push(`closebox(${x.register})`); break;
    case 'vm_internal': L.push(`-- internal ${x.family} opcode elided after bootstrap capture`); break;
    default: throw new Error(`Emitter does not support IR opcode ${x.op}`);
  }
  return L;
}

export function emitProgramLegacy(p) {
  const lines=[];
  lines.push(`P_${p.id}=function(UP,...)`);
  lines.push('  UP=UP or {};local R,OPEN={},{};local ARGS=_pack(...);local TOP=-1;local VAR={n=math.max(0,ARGS.n-'+p.paramCount+')}');
  lines.push('  local function setr(i,v) R[i]=v;local b=OPEN[i];if b then b[1]=v end end');
  lines.push('  local function up(k)local b=UP[k];return b and b[1] or nil end');
  lines.push('  local function box(i)local b=OPEN[i];if not b then b={R[i],i,R,true};OPEN[i]=b end;return b end');
  lines.push('  local function closebox(i)local b=OPEN[i];if b then b[1]=R[i];b[3]=nil;b[4]=false;OPEN[i]=nil end end');
  for (let n=0;n<p.paramCount;n++) lines.push(`  setr(${n},ARGS[${n+1}]);TOP=${n}`);
  if (p.paramCount >= 0) lines.push(`  for _i=${p.paramCount+1},ARGS.n do VAR[_i-${p.paramCount}]=ARGS[_i] end`);

  // Dead instructions retain their VM PC in IR so CFG/debug data is stable. For
  // source emission, collapse a target that lands on a nop to the next live PC.
  // This preserves fall-through semantics without emitting hundreds of empty
  // labels (which can hit Lua parser recursion limits on large protected files).
  const all=p.instructions, byPc=new Map(all.map((x,i)=>[x.pc,i]));
  const live=all.filter(x=>x.op!=='nop'); const endLabel=`END_${p.id}`;
  const resolveTarget=target=>{
    let i=byPc.get(target);if(i==null)return target;
    while(i<all.length&&all[i].op==='nop')i++;
    return i<all.length?all[i].pc:endLabel;
  };
  const emitted=live.map(x=>x.target!=null?{...x,target:resolveTarget(x.target)}:x);
  const present=new Set(emitted.map(x=>x.pc));let usesEnd=false;const missing=new Set();
  for(const x of emitted){if(x.target!=null){if(x.target===endLabel)usesEnd=true;else if(!present.has(x.target))missing.add(x.target);}}
  for(const x of emitted){
    lines.push(`  ::L_${x.pc}::`);
    const body=emitInstruction(x);
    if(body.length) lines.push('  do '+body.join(';')+' end');
  }
  for(const t of [...missing].sort((a,b)=>Number(a)-Number(b))){lines.push(`  ::L_${t}::`,'  return');}
  if(usesEnd)lines.push(`  ::L_${endLabel}::`,'  return');
  lines.push('end');
  return lines.join('\n');
}

export const LEGACY_RUNTIME = `local _GREF=_ENV or _G
local _unpack=(table and table.unpack) or unpack
local function _pack(...) local n=select('#',...);local t={n=n};for i=1,n do t[i]=select(i,...) end;return t end
local function _gget(k) local v=_GREF[k];if v~=nil then return v end;if k=='limitedstack' then return true end;return nil end
local function _idiv(a,b) local mt=getmetatable(a);local f=type(mt)=='table' and rawget(mt,'__idiv') or nil;if not f then mt=getmetatable(b);f=type(mt)=='table' and rawget(mt,'__idiv') or nil end;if f then return f(a,b) end;return math.floor(a/b) end
local function _args(R,d,fixed,prefix,top) local a,n={},0;if fixed<0 then if prefix<0 then prefix=0 end;for i=1,prefix do n=n+1;a[n]=R[d+i] end;for r=d+prefix+1,top do n=n+1;a[n]=R[r] end else for i=1,fixed do n=n+1;a[n]=R[d+i] end end;a.n=n;return a end
local function _call(R,setr,d,argc,rcount,prefix,top) local a=_args(R,d,argc,prefix,top);local out=_pack(R[d](_unpack(a,1,a.n)));if rcount<0 then for i=1,out.n do setr(d+i-1,out[i]) end;return d+out.n-1 elseif rcount>0 then for i=1,rcount do setr(d+i-1,out[i]) end;return d+rcount-1 else return d-1 end end
local function _tail(R,d,argc,prefix,top) local a=_args(R,d,argc,prefix,top);return R[d](_unpack(a,1,a.n)) end
local function _ret(R,d,n) if n<=0 then return end;local a={};for i=1,n do a[i]=R[d+i-1] end;return _unpack(a,1,n) end
local function _vararg(V,setr,d,n) local count=n<0 and V.n or n;for i=1,count do setr(d+i-1,V[i]) end;return d+count-1 end
local function _setlist(R,d,first,last,open,top) if open then last=top end;local t=R[d];local k=0;for r=first,last do k=k+1;t[k]=R[r] end end
local function _self(R,setr,d,key) local o=R[d];setr(d+1,o);local f=o[key];if f==nil then f=function() error("attempt to call missing method '"..tostring(key).."' of "..type(o),0) end end;setr(d,f) end
local function _forprep(R,setr,i,limit,step) local a,b,c=R[i],R[limit],R[step];if type(a)~='number' then a=assert(tonumber(a),"invalid 'for' initial value");setr(i,a) end;if type(b)~='number' then b=assert(tonumber(b),"invalid 'for' limit");setr(limit,b) end;if type(c)~='number' then c=assert(tonumber(c),"invalid 'for' step");setr(step,c) end end
local function _for_done(R,i,limit,step) local s=R[step];return (s>0 and R[i]>R[limit]) or (s<0 and R[i]<R[limit]) end
local function _for_live(R,i,limit,step) local s=R[step];return (s>0 and R[i]<=R[limit]) or (s<0 and R[i]>=R[limit]) end
local function _tfor(R,setr,d,n,control,resultBase) local iter,state,ctrl=R[d],R[d+1],R[control];local out;if state==nil and ctrl==nil and type(iter)~='function' then local mt=getmetatable(iter);local f=type(mt)=='table' and rawget(mt,'__iter') or nil;if f then local a,b,c=f(iter);setr(d,a);setr(d+1,b);setr(control,c);out=_pack(a(b,c)) elseif type(iter)=='table' then setr(d,next);setr(d+1,iter);out=_pack(next(iter,nil)) else error('attempt to iterate over a '..type(iter)..' value') end else out=_pack(iter(state,ctrl)) end;for i=1,n do setr(resultBase+i-1,out[i]) end;if out[1]==nil then return true end;setr(control,out[1]);return false end`;

export function emitLua(bundle, { watermark = WATERMARK } = {}) {
  const lines=[watermark,'',LEGACY_RUNTIME,''];
  lines.push('local '+bundle.programs.map(p=>`P_${p.id}`).join(','));
  for(const p of [...bundle.programs].sort((a,b)=>b.id-a.id)) lines.push('',emitProgramLegacy(p));
  lines.push('','return P_0({},...)','');
  return lines.join('\n');
}
