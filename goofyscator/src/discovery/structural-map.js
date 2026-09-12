import { REFERENCE_SLOTS } from './reference-v10.js';

const KEEP = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while type select pcall xpcall error getmetatable rawget rawset next pairs ipairs string table math floor concat byte char sub __idiv __iter __index __newindex __pairs STR'.split(' '));
const TOKEN_RE = /0x[0-9A-Fa-f]+|\d+(?:\.\d+)?|[A-Za-z_]\w*|~=|==|<=|>=|\/\/|\.\.|[+\-*\/%^#=<>()[\]{},.;:]/g;

export function structuralTokens(source) {
  const stripped=source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs,' STR ');
  return (stripped.match(TOKEN_RE)||[]).map(t => /^(?:0x[0-9A-Fa-f]+|\d)/.test(t) ? 'N' : /^[A-Za-z_]/.test(t) ? (KEEP.has(t)?t:'I') : t);
}
function grams(tokens,n){const m=new Map();for(let i=0;i+n<=tokens.length;i++){const k=tokens.slice(i,i+n).join('\x1f');m.set(k,(m.get(k)||0)+1);}return m;}
function multisetJaccard(a,b){let inter=0,uni=0;const keys=new Set([...a.keys(),...b.keys()]);for(const k of keys){const x=a.get(k)||0,y=b.get(k)||0;inter+=Math.min(x,y);uni+=Math.max(x,y);}return uni?inter/uni:1;}
function similarity(a,b){
  const g2a=grams(a,2),g2b=grams(b,2),g3a=grams(a,3),g3b=grams(b,3);
  const len=Math.min(a.length,b.length)/Math.max(a.length,b.length,1);
  return .28*multisetJaccard(g2a,g2b)+.57*multisetJaccard(g3a,g3b)+.15*len;
}
const REFS=REFERENCE_SLOTS.map((x,index)=>({...x,index,t:x.tokens.split(' ')}));
const REF_BY_SEMANTIC=new Map();
for(const r of REFS){if(!REF_BY_SEMANTIC.has(r.semantic))REF_BY_SEMANTIC.set(r.semantic,[]);REF_BY_SEMANTIC.get(r.semantic).push(r);}

// Hungarian algorithm (minimum assignment). It is only used after semantic
// invariants have removed the families whose normalized syntax is ambiguous.
function hungarian(cost){
  if(!cost.length)return [];
  const n=cost.length,m=cost[0].length,u=Array(n+1).fill(0),v=Array(m+1).fill(0),p=Array(m+1).fill(0),way=Array(m+1).fill(0);
  if(n>m)throw new Error(`assignment has ${n} rows but only ${m} columns`);
  for(let i=1;i<=n;i++){
    p[0]=i;let j0=0;const minv=Array(m+1).fill(Infinity),used=Array(m+1).fill(false);
    do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=m;j++)if(!used[j]){const cur=cost[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}for(let j=0;j<=m;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;}while(p[j0]!==0);
    do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!==0);
  }
  const ans=Array(n).fill(-1);for(let j=1;j<=m;j++)if(p[j])ans[p[j]-1]=j-1;return ans;
}

function bestMargin(row, refs, chosenSemantic){
  let same=-Infinity,other=-Infinity;
  for(let i=0;i<refs.length;i++){
    if(refs[i].semantic===chosenSemantic)same=Math.max(same,row[i]);
    else other=Math.max(other,row[i]);
  }
  return (Number.isFinite(same)?same:0)-(Number.isFinite(other)?other:0);
}

export function mapHandlerFamilies(entries, properties, explicitClassifier=null){
  const out=new Map(),confidence=new Map(), extensionProps=new Set();
  const entryByKey=new Map(entries.map(e=>[e.key,e]));

  // Extensions do not consume one of the fixed 48 V10 core slots.
  for(const prop of properties){
    const e=entryByKey.get(prop);if(!e)throw new Error(`handler ${prop} missing`);
    const sem=explicitClassifier?.(e.value);
    if(sem==='unm'){out.set(prop,'unm');confidence.set(prop,{score:1,margin:1,reference:-1,source:'semantic'});extensionProps.add(prop);}
  }
  const core=properties.filter(p=>!extensionProps.has(p));
  if(core.length!==REFS.length) throw new Error(`V10 structural mapper expected ${REFS.length} core families after extensions, got ${core.length} (${properties.length} total)`);

  const candidates=core.map(prop=>{const e=entryByKey.get(prop);return {prop,t:structuralTokens(e.value),explicit:explicitClassifier?.(e.value)??'unknown'};});
  const allScores=candidates.map(c=>REFS.map(r=>similarity(c.t,r.t)));
  const candidateIndex=new Map(candidates.map((c,i)=>[c.prop,i]));
  const usedRefs=new Set(),lockedProps=new Set();

  // V10 randomizes names, numeric keys, local declaration order, and handler
  // table order, but it does not change the semantic expression performed by a
  // handler.  When the source recognizer identifies a family and its observed
  // multiplicity does not exceed the VM inventory, treat that identity as a
  // hard constraint.  This prevents e.g. LEN/NOT/LOADTRUE/NEWTABLE swaps that
  // a global fuzzy assignment can otherwise make.
  const explicitGroups=new Map();
  for(const c of candidates){
    if(c.explicit==='unknown'||!REF_BY_SEMANTIC.has(c.explicit))continue;
    if(!explicitGroups.has(c.explicit))explicitGroups.set(c.explicit,[]);
    explicitGroups.get(c.explicit).push(c);
  }
  for(const [semantic,group] of explicitGroups){
    const refs=REF_BY_SEMANTIC.get(semantic);
    // An overfull recognizer group means the recognizer is not trustworthy for
    // this build.  Leave that whole family to structural assignment instead of
    // forcing an impossible semantic inventory.
    if(group.length>refs.length)continue;
    const available=refs.filter(r=>!usedRefs.has(r.index));
    if(group.length>available.length)continue;
    const localScores=group.map(c=>available.map(r=>allScores[candidateIndex.get(c.prop)][r.index]));
    const a=hungarian(localScores.map(row=>row.map(s=>1-s)));
    for(let i=0;i<group.length;i++){
      const c=group[i],r=available[a[i]],row=allScores[candidateIndex.get(c.prop)],score=row[r.index];
      out.set(c.prop,semantic);lockedProps.add(c.prop);usedRefs.add(r.index);
      confidence.set(c.prop,{score,margin:bestMargin(row,REFS,semantic),reference:r.index,source:'semantic'});
    }
  }

  const remainingCandidates=candidates.filter(c=>!lockedProps.has(c.prop));
  const remainingRefs=REFS.filter(r=>!usedRefs.has(r.index));
  if(remainingCandidates.length!==remainingRefs.length)throw new Error(`V10 constrained mapper imbalance: ${remainingCandidates.length} handlers / ${remainingRefs.length} slots`);
  if(remainingCandidates.length){
    const scores=remainingCandidates.map(c=>remainingRefs.map(r=>similarity(c.t,r.t)));
    const assignment=hungarian(scores.map(row=>row.map(s=>1-s)));
    for(let i=0;i<remainingCandidates.length;i++){
      const j=assignment[i],r=remainingRefs[j],semantic=r.semantic,chosen=scores[i][j];
      const sameBest=Math.max(...scores[i].filter((_,k)=>remainingRefs[k].semantic===semantic));
      const otherScores=scores[i].filter((_,k)=>remainingRefs[k].semantic!==semantic);
      const otherBest=otherScores.length?Math.max(...otherScores):0;
      out.set(remainingCandidates[i].prop,semantic);
      confidence.set(remainingCandidates[i].prop,{score:chosen,margin:sameBest-otherBest,reference:r.index,source:'structural'});
    }
  }
  return {classifications:out,confidence};
}
