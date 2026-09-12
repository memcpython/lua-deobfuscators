const has = (s, ...xs) => xs.every(x => s.includes(x));
const count = (s, token) => s.split(token).length - 1;

// Small register-write handlers are deliberately very similar after identifier
// and numeric normalization.  Recover their semantics from the actual value
// expression instead of their size/shape.  This is a source invariant across
// V10's per-build field/name randomization.
function directRegisterWrite(s) {
  const m=/do\s+local\s+(\w+)\s*,\s*(\w+)\s*=([\s\S]*?);\s*(\w+)\[(\w+)\]\s*=\s*(\w+)\s*;/.exec(s);
  if(!m)return null;
  const [,a,b,rhs,table,key,value]=m;
  // Tiny handlers have two top-level RHS expressions.  Their expressions do
  // not contain top-level commas; nested calls/tables may, so split manually.
  let depth=0,quote=null,comma=-1;
  for(let i=0;i<rhs.length;i++){const c=rhs[i];if(quote){if(c==='\\')i++;else if(c===quote)quote=null;continue;}if(c==='\"'||c==="'"){quote=c;continue;}if(c==='('||c==='['||c==='{')depth++;else if(c===')'||c===']'||c==='}')depth--;else if(c===','&&depth===0){comma=i;break;}}
  if(comma<0)return null;
  const ea=rhs.slice(0,comma).trim(),eb=rhs.slice(comma+1).trim();
  if(key===a&&value===b)return {table,dest:ea,value:eb};
  if(key===b&&value===a)return {table,dest:eb,value:ea};
  return null;
}
function classifyDirectWrite(s){
  const w=directRegisterWrite(s);if(!w)return null;const v=w.value.trim();
  if(v==='{}')return 'newtable';
  if(v==='true')return 'loadtrue';
  if(v==='false')return 'loadfalse';
  if(v==='nil')return 'loadnil';
  if(/^not\b/.test(v))return 'not';
  if(/^#/.test(v))return 'len';
  if(/^-[\s(]*\w+\[/.test(v))return 'unm';
  // Register/register arithmetic.  Do not infer operand ordering here; the
  // lifter decodes operands from the instruction descriptor.
  if(/\]\s*\+\s*\(/.test(v))return 'add_rr';
  if(/\]\s*-\s*\(/.test(v))return 'sub_rr';
  if(/\]\s*\*\s*\(/.test(v))return 'mul_rr';
  if(/\]\s*\/\s*\(/.test(v))return 'div_rr';
  // LOADIMM's value is the decoded inline immediate descriptor.
  if(/\[[^\]]+\]\s*or\s*0\)?$/.test(v)&&!/[+*\/]/.test(v))return 'loadimm';
  return null;
}
export function classifyHandler(s) {
  const compact=s.replace(/\s+/g,' ');
  if (/^\(?function\([^)]*\)\s*end\)?$/.test(s.replace(/\s+/g,''))) return 'nop';
  if (has(s,'attempt to call a nil value','select("#"')) return s.length < 1800 ? 'tailcall' : 'call';
  const direct=classifyDirectWrite(s); if(direct) return direct;
  if (has(s,'__idiv','getmetatable','rawget') && count(s,'elseif') > 8) return 'binary';
  if (has(s,"invalid 'for' initial value","invalid 'for' limit","invalid 'for' step")) return 'forprep';
  if (has(s,'attempt to iterate over a ','__iter')) return 'tforloop';
  if (has(s,"attempt to call missing method '",'+ 1')) return 'self';
  if (has(s,'stack overflow') && has(s,'while true do')) return 'runner';
  if (has(s,'string.byte','string.char','table.concat') && /type\([^)]*\)\s*~=\s*"string"\s*or/.test(s) && /for\s+\w+\s*=\s*1\s*,\s*#/.test(s) && s.length > 1150 && s.length < 1550) return 'dispatch_wrapper';
  if (has(s,'string.byte','table.concat','bxor') && /\[4\]/.test(s) && count(s,'[6]') + count(s,'[7]') >= 2 && s.length > 900 && s.length < 1900) return 'dispatch_wrapper';
  // Per-file polymorphism renames the VMS/bit fields, but the seed-constant
  // family keeps the same four-byte mixer shape.
  if (has(s,'string.byte','bxor') && count(s,'% 0x10000') >= 4 && s.length > 500 && s.length < 850 && !has(s,'table.concat')) return 'vmseed_const';
  // Inline superinstruction executor: decode a child list, walk it with a
  // local PC and redispatch through the handler table. Numeric slots vary.
  if (has(s,'while') && /local\s+\w+\s*=#\w+/.test(s) && /type\([^)]*\)\s*~=\s*"number"/.test(s) && s.length > 500 && s.length < 900 && !has(s,'string.byte')) return 'inline';
  if (has(s,'limitedstack') && /%\s*2\s*==\s*1/.test(s)) return 'getglobal_select';
  if (has(s,'limitedstack') && s.length < 2000) return 'getglobal';
  if (has(s,'[4]=false') && has(s,'[3]=nil') && /if\s+\w+\s+then[\s\S]*\[1\]=[\s\S]*=nil;end/.test(s) && s.length < 350) return 'close';
  if (has(s,'for ') && has(s,'nil') && s.length < 350) return 'loadnil_range';
  if (s.length > 430 && s.length < 700 && /if type\(\w+\) ~= "number"/.test(s) && /if \w+ == 0 then/.test(s) && /local \w+=\{\};for \w+=1,\w+ do/.test(s)) return 'return';
  if (has(s,'n or #') && has(s,'[0x') && s.length < 550) return 'vararg';
  if (s.length < 560 && /local\s+\w+\s*=\s*0\s*;\s*for\s+\w+\s*=/.test(s) && /\w+\s*=\s*\w+\s*\+\s*1\s*;\s*\w+\[\w+\]\s*=\s*\w+\(/.test(s)) return 'setlist';
  if ((has(s,'return nil;end;return') || /^\(function\([^)]*\)local\s+\w+\s*,\s*\w+\s*=\s*\w+\.\w+\s*,\s*\w+\.\w+;\s*\w+\([^;]+,\s*\w+\([^;]+\)\);end\)$/.test(s.replace(/\s+/g,' '))) && s.length < 300) return 'getupval';
  if (has(s,'if not ') && has(s,' then do local ') && s.length < 350) return 'jump_if_false';
  if (has(s,'[0x') && has(s,'=') && s.length < 240 && !has(s,'if ')) return 'jump';
  if (has(s,'+ owa') && has(s,'owa > 0') && has(s,'owa < 0')) return 'forloop';
  if (s.length > 1700 && has(s,'select("#"') && count(s,'function') >= 4) return 'closure';
  if (has(s,'[0x70DA]') || (has(s,'== nil then') && s.length < 450 && /\[[^\]]+\]\s*=/.test(s))) {
    if (s.length < 450) return 'setglobal';
  }
  if (s.length > 1800 && count(s,'elseif') >= 6 && /\]\s*\[\w+\]\s*=\s*\w+;end/.test(s)) return 'settable';
  if (s.length > 900 && s.length < 1700 && count(s,'elseif') >= 3 && /\w+\s*=\s*\w+\[\w+\];do local \w+,\w+=\w+\[\w+\]/.test(compact)) return 'gettable';
  if (s.length > 1800 && count(s,'elseif') >= 6 && /\w+\[\w+\]\s*=\s*\w+;end/.test(s)) return 'settable';
  if (has(s,'string.sub') && has(s,'string.char') && has(s,'table.concat') && s.length > 900 && s.length < 1500) return 'vmseed_stream';
  if (s.length < 450 && /%\s*2\s*==\s*1/.test(s)) return 'move_select';
  if (s.length > 300 && s.length < 430 && /if type\(\w+\) ~= "number"/.test(s) && count(s,'or 0') >= 2 && count(s,';end;') >= 1) return 'move_pair';
  if (s.length > 1050 && s.length < 1500 && count(s,'elseif') >= 4 && !/local \w+=\w+\[\w+\];do local/.test(compact) && !has(s,'getmetatable')) return 'move';
  if (s.length > 1000 && count(s,'elseif') >= 3 && /local \w+=\w+\[\w+\];do local/.test(compact)) return 'gettable';
  if (s.length > 1800 && count(s,'elseif') >= 6) return 'settable';
  if (s.length < 700 && has(s,'=nil;else') && /\[[^\]]+\]\s*=/.test(s)) return 'setglobal';
  if (s.length < 700 && /return \w+\(\w+,\w+,/.test(s)) return 'getupval';
  return 'unknown';
}
