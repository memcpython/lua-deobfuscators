// Recover Lua's lexical-recursion pattern from register bytecode:
//
//   self = nil
//   tmp  = closure(captures self)
//   self = tmp                 -- sometimes one half of MOVE_PAIR
//
// The nil write exists only to create the open local cell before CLOSURE.
// Source Lua represents the same cell naturally by assigning the closure
// directly to `self`.  The transform is intentionally local: CLOSURE and the
// forwarding assignment must be adjacent semantic instructions, the closure
// must actually capture `self`, and MOVE_PAIR's second source must not depend
// on the old nil value.

const isNop=x=>!x||x.op==='nop';
const isNilMove=(x,r)=>x?.op==='move'&&x.dst===r&&x.src?.kind==='literal'&&x.src.value==null;

function previousSemantic(xs,i){for(let k=i-1;k>=0;k--)if(!isNop(xs[k]))return k;return -1;}
function nextSemantic(xs,i){for(let k=i+1;k<xs.length;k++)if(!isNop(xs[k]))return k;return -1;}

function process(input){
  const xs=(input??[]).map(x=>{const y={...x};for(const k of ['setup','body','thenBody','elseBody'])if(y[k])y[k]=process(y[k]);return y;});
  for(let i=0;i<xs.length;i++){
    const c=xs[i];if(c?.op!=='closure'||c.prototype==null)continue;

    // Lua can encode `local function f(...) ... f(...) ... end` directly as
    //
    //   f = nil            -- opens the lexical cell
    //   f = CLOSURE(...)   -- the child captures that same cell
    //
    // There is no forwarding MOVE in this form: the destination register is
    // already the self-captured local.  Keeping the nil seed in source would
    // leak VM/closure construction as `local f=nil; f=function...`.  When the
    // immediately preceding semantic instruction is exactly that nil seed and
    // the closure captures its own destination, mark it as a native recursive
    // local declaration and erase only the seed.
    const directSelf=(c.upvalues??[]).some(b=>b.kind===0&&b.index===c.dst);
    if(directSelf){
      const p=previousSemantic(xs,i);
      if(p>=0&&isNilMove(xs[p],c.dst)){
        const oldNil=xs[p];
        xs[p]={pc:oldNil.pc,sourcePc:oldNil.sourcePc,sub:oldNil.sub,op:'nop',optimizedAway:'source-recursive-closure-nil-seed'};
        xs[i]={...c,optimizedFrom:`${c.optimizedFrom?c.optimizedFrom+'+':''}source-recursive-closure-direct`};
        continue;
      }
    }

    const j=nextSemantic(xs,i);if(j<0)continue;const f=xs[j];
    let self=null,replacement=null;
    if(f.op==='move'&&f.src?.kind==='reg'&&f.src.index===c.dst&&f.dst!==c.dst){
      self=f.dst;replacement={pc:f.pc,sourcePc:f.sourcePc,sub:f.sub,op:'nop',optimizedAway:'source-recursive-closure-forward'};
    }else if(f.op==='move_pair'&&f.src?.kind==='reg'&&f.src.index===c.dst&&f.dst!==c.dst){
      self=f.dst;
      // Both RHS values of MOVE_PAIR are read before either destination is
      // written. If the second RHS is the old self/nil slot, retargeting the
      // closure would change that snapshot; keep the original form instead.
      if(f.secondSrc===self||f.secondDst===self)continue;
      replacement={pc:f.pc,sourcePc:f.sourcePc,sub:f.sub,op:'move',dst:f.secondDst,src:{kind:'reg',index:f.secondSrc},optimizedFrom:'source-recursive-closure-move-pair'};
    }else continue;
    if(!Number.isInteger(self))continue;
    if(!(c.upvalues??[]).some(b=>b.kind===0&&b.index===self))continue;
    const p=previousSemantic(xs,i);if(p<0||!isNilMove(xs[p],self))continue;
    // No semantic instruction can exist between the nil seed and CLOSURE by
    // construction of previousSemantic; likewise forwarding is the next one.
    const oldNil=xs[p];xs[p]={pc:oldNil.pc,sourcePc:oldNil.sourcePc,sub:oldNil.sub,op:'nop',optimizedAway:'source-recursive-closure-nil-seed'};
    xs[i]={...c,dst:self,optimizedFrom:`${c.optimizedFrom?c.optimizedFrom+'+':''}source-recursive-closure`};
    xs[j]=replacement;
  }
  return xs;
}

export function recoverRecursiveClosures(program){const p=structuredClone(program);p.instructions=process(p.instructions??[]);return {program:p};}
