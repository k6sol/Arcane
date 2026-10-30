import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import type {StudioStore} from '../../../packages/storage/src/studio-store.js';
import {digest} from '../../../packages/studio-test-controller/src/contracts.js';
import type {StudioTestTaskSettled} from '../../../packages/protocol/src/chat-task-playtest.js';

const ownedTransitions=new WeakMap<()=>void,(report:StudioTestTaskSettled)=>void>();

/** A private original-Send witness, never a session preference or JSON grant.
 * Ordinary fresh proof timestamps may advance, but the exact paired Edit
 * incarnation, selected roots, write grant and loaded plugin must remain. */
export function captureModelSourceBinding(store:StudioStore,sessionId:string):()=>void {
  const fail=():never=>{throw new ArcaneError('TOOLBOX_MODELS_DISABLED','Explicit model-source consent is unavailable for this original task.');};
  const read=()=>{
    const s=store.session(sessionId),p=s.proof;
    if(!p)return fail();
    if(s.revokedAt||s.placeId!==0||s.universeId!==0||!s.allowWrites||!p.connected||p.mode!=='Edit'||Date.parse(p.expiresAt)<=Date.now())return fail();
    // Match the existing production test-service scope, independently of its
    // short-lived proof timestamps and its explicitly owned Play transitions.
    const scope=digest({sessionId:s.id,clientLifetimeId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,name:s.name,roots:s.allowedRoots,writes:s.allowWrites,revoked:s.revokedAt});
    return {scope,client:s.clientSessionId,proof:p,binding:digest({scope,lifetime:p.clientLifetimeId,marker:p.markerName,artifact:p.pluginArtifactHash})};
  };
  const original=read(),expires=Date.now()+30*60_000,usedRuns=new Set<string>();let epoch=original.proof.playEpoch;
  const assertCurrent=()=>{const current=read();if(Date.now()>=expires||current.binding!==original.binding||current.proof.playEpoch!==epoch)fail();};
  ownedTransitions.set(assertCurrent,report=>{
    // Only the original private task owner calls this after the coordinator's
    // exact-job settled evidence and fresh source revalidation. A report alone
    // is not a capability: the original registry handle and guard are required.
    const review=report.review,b=review.binding,scenario=report.scenario;
    if(review.phase!=='done'||review.outcome!=='failed'||String(review.code)!=='ASSERTION_FAILED'||review.cleanup!=='complete'||review.requiresHumanReview||!review.canStartAnotherOperation||
      !review.runId||usedRuns.has(review.runId)||usedRuns.size>=128||!b||b.pairedSessionId!==sessionId||b.clientLifetimeId!==original.client||b.pluginArtifactHash!==original.proof.pluginArtifactHash||b.scopeRevision!==original.scope||b.placeId!==0||
      !scenario||scenario.outcome!=='failed'||scenario.requiredEvidence!=='complete'||scenario.inputRelease!=='complete'||!['not_required','complete'].includes(scenario.restoration)||scenario.subjects!=='current')return fail();
    const current=read();
    // NativeTestAdapter proves one owned start (+1) and its exact owned Stop
    // (+1). Extra/unowned transitions never refresh the original allowance.
    if(Date.now()>=expires||current.binding!==original.binding||!Number.isSafeInteger(epoch+2)||current.proof.playEpoch!==epoch+2)return fail();
    usedRuns.add(review.runId);epoch=current.proof.playEpoch;assertCurrent();
  });
  return assertCurrent;
}

/** Private original-owner continuation only. Labelled host fixtures whose
 * guards have no real Play proof remain unchanged; they cannot mint epochs. */
export function advanceModelSourceBinding(assertCurrent:()=>void,report:StudioTestTaskSettled):void {
  const advance=ownedTransitions.get(assertCurrent);
  if(advance)advance(report);else assertCurrent();
}
