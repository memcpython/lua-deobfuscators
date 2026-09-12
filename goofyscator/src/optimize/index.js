import { foldV10DecoderCalls } from './decoder-fold.js';
import { eliminateDeadRegisterDefs, pruneUnusedClosureBindings, removeUnreachablePrograms } from './dce.js';
import { propagateConstants } from './constants.js';
import { stripV10Protection } from './protection-strip.js';
import { collapseIdentityForwarders } from './forwarder-collapse.js';
import { collapseValueWrappers } from './wrapper-collapse.js';
import { collapseEnvironmentProxy, finalizeEnvironmentProxy } from './environment-collapse.js';
import { stripBootstrapProbe } from './bootstrap-strip.js';
import { normalizeOpenValues } from './open-values.js';
import { canonicalizeRecoveredValues } from './recovered-values.js';
import { coalesceMoveChains } from './move-chains.js';
import { inferKnownCallArities } from './call-arity.js';
import { collapseShortCircuitAnd } from '../source/short-circuit.js';

export function optimizeBundle(bundle) {
  const folded=foldV10DecoderCalls(bundle);
  const protection=stripV10Protection(bundle);
  const environment=collapseEnvironmentProxy(bundle,protection);
  const forwarders=collapseIdentityForwarders(bundle);
  const wrappers=collapseValueWrappers(bundle);
  const bootstrap=stripBootstrapProbe(bundle);
  const openValues=normalizeOpenValues(bundle);
  const callArities=inferKnownCallArities(bundle);
  const openValuesAfterArity=normalizeOpenValues(bundle);
  const recoveredValues=canonicalizeRecoveredValues(bundle);
  const moveChains=coalesceMoveChains(bundle);
  // Recover source short-circuit value ladders before constant propagation.
  // Once a TEST/JMP ladder is proven to be a Lua `and`/`or` value expression,
  // preserve it as a first-class logical_chain so later constant folding cannot
  // erase source syntax merely because the final value is statically known.
  let sourceLogicalChains=0;
  for(let i=0;i<bundle.programs.length;i++){
    const r=collapseShortCircuitAnd(bundle.programs[i]);
    bundle.programs[i]=r.program;
    sourceLogicalChains+=r.collapsed;
  }
  let dead=0,bindings=0,constantChanges=0,unreachableInstructions=0;
  // Removing now-unused decoder plumbing exposes more dead setup/register copies.
  for(let pass=0;pass<4;pass++){
    bindings+=pruneUnusedClosureBindings(bundle);
    let n=0;for(const p of bundle.programs){const cp=propagateConstants(p);constantChanges+=cp.changed;unreachableInstructions+=cp.unreachable;n+=eliminateDeadRegisterDefs(p);}dead+=n;if(!n&&pass>0)break;
  }
  // Dead bootstrap/helper paths can obscure an otherwise fixed recovered
  // function arity. Re-run the proof after the first CFG/DCE convergence, then
  // immediately consume any newly fixed TOP/open-call convention.
  const callAritiesFinal=inferKnownCallArities(bundle);
  const openValuesFinal=normalizeOpenValues(bundle);
  if(callAritiesFinal.calls||openValuesFinal.normalizedCalls||openValuesFinal.normalizedReturns||openValuesFinal.normalizedIdentity){
    for(let pass=0;pass<2;pass++){
      bindings+=pruneUnusedClosureBindings(bundle);let n=0;
      for(const p of bundle.programs){const cp=propagateConstants(p);constantChanges+=cp.changed;unreachableInstructions+=cp.unreachable;n+=eliminateDeadRegisterDefs(p);}dead+=n;if(!n&&pass>0)break;
    }
  }
  const environmentFinal=finalizeEnvironmentProxy(bundle,environment);
  environment.finalizedRemoved=environmentFinal.removed;
  environment.finalPreservedPcs=environmentFinal.preservedPcs;
  environment.finalLiveAfter=environmentFinal.liveAfter;
  if(environmentFinal.removed){
    for(let pass=0;pass<3;pass++){
      bindings+=pruneUnusedClosureBindings(bundle);let n=0;
      for(const p of bundle.programs){const cp=propagateConstants(p);constantChanges+=cp.changed;unreachableInstructions+=cp.unreachable;n+=eliminateDeadRegisterDefs(p);}dead+=n;if(!n&&pass>0)break;
    }
  }
  // Earlier cleanup can expose new closure forwarding chains (for example a
  // closure written to a temporary, copied once, then the temporary reused).
  // Run the same proof again after CFG/DCE convergence instead of leaking that
  // register-allocation artifact into source output.
  const moveChainsFinal=coalesceMoveChains(bundle);
  if(moveChainsFinal.changed){
    bindings+=pruneUnusedClosureBindings(bundle);
    for(const p of bundle.programs)dead+=eliminateDeadRegisterDefs(p);
  }
  const programsRemoved=removeUnreachablePrograms(bundle);
  return {bundle,stats:{decoderPrototype:folded.decoderId,decodedStrings:folded.folded,protection,environment,forwarders,wrappers,bootstrap,openValues,callArities,openValuesAfterArity,recoveredValues,moveChains,sourceLogicalChains,moveChainsFinal,callAritiesFinal,openValuesFinal,constantFolds:constantChanges,unreachableInstructions,deadInstructions:dead,unusedBindings:bindings,unreachablePrograms:programsRemoved}};
}
