import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {createHmac,createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createAssetService} from '../../apps/daemon/src/asset-service.js';
import {createStudioImportHost} from '../../apps/daemon/src/studio-import-host.js';
import {createStudioImportStagingController} from '../../apps/daemon/src/studio-import-staging-controller.js';
import {createStudioImportPreparationStore} from '../../apps/daemon/src/studio-import-preparation-store.js';
import {AssetReviewStore} from '../../apps/daemon/src/asset-review-store.js';
import {assetReviewCanonical,type AssetReviewReceiptAuthority} from '../../apps/daemon/src/asset-review.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import {READ_METHODS,WRITE_METHODS,ASSET_STAGE_METHODS,type StudioCommand,type StudioImportContextObservation,type Json,type InstanceRef} from '../../packages/protocol/src/studio.js';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';

// Actual service/host/SQLite queue and signed human-decision store. Only GLB
// geometry and authenticated plugin acknowledgements are synthetic. No Studio,
// Blender, provider, native application or private profile is accessed.
export const REVIEW_JOB='11111111-1111-4111-8111-111111111111',REVIEW_PLUGIN='a'.repeat(64);
export const reviewRefused=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
/** Narrow synthetic original-provenance setup for legacy placement/keep tests.
 * It records actual production stage and reconstruction associations. The named
 * trusted model-only port is fixture configuration; real human authentication,
 * source witnesses and native actors are covered by reviewBoundaryFixture. */
export function recordReviewedOriginalRun(store:StudioStore,sessionId:string,transferDigest:string,parentRef:string,observation:unknown):void {
  store.poll(sessionId,observation);const proof=store.session(sessionId).proof;assert.ok(proof);
  const modelReview={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:'9'.repeat(64),revision:1};
  store.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,modelReview);});
  const expected={digest:transferDigest,payloadDigest:'d'.repeat(64),manifestDigest:'e'.repeat(64)};
  const target={sessionId,placeId:proof.placeId,universeId:proof.universeId,root:'Workspace' as const,parentRef,creator:{kind:'user' as const,id:'1'}};
  const continuity={clientLifetimeId:proof.clientLifetimeId,pluginArtifactHash:proof.pluginArtifactHash,playEpoch:proof.playEpoch};
  const bodies=[{kind:'begin'},{kind:'object',object:{sourceObjectId:'fixture-original-mesh',meshExportSha256:'f'.repeat(64)},primitives:[{vertexCount:4,triangleCount:4}]},{kind:'seal'}];
  const args=bodies.map((body,ordinal)=>({expected,target,continuity,packet:JSON.stringify({formatVersion:1,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,ordinal,...body})}));
  let bytes=0;const intent:StageRunIntent={projectId:'a'.repeat(64),jobId:randomUUID(),conversation:{provider:'codex',threadId:'synthetic-original-fixture',sessionId:null},modelReview,transferDigest,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,preparedDigest:'1'.repeat(64),target,continuity,
    plan:args.map((a,ordinal)=>{const packetByteLength=Buffer.byteLength(a.packet);bytes+=packetByteLength;return {ordinal,argsSha256:createHash('sha256').update(JSON.stringify(a)).digest('hex'),packetByteLength,envelopeByteLength:Buffer.byteLength(JSON.stringify(a)),expectedReceipt:{transferDigest,packetCount:ordinal+1,byteLength:bytes,state:ordinal===2?'sealed':'receiving',engineVerification:'pending'}};})};
  const run=store.beginStageRun(intent,()=>{});assert.ok(run.created);
  for(const [ordinal,a]of args.entries()){const c=store.enqueueStagePacket(run.handle,ordinal,a,()=>{});assert.equal(store.poll(sessionId,observation)[0]?.id,c.id);store.result({sessionId,commandId:c.id,state:'succeeded',result:intent.plan[ordinal]!.expectedReceipt});}
  store.closeStageRun(run.handle);const c=store.enqueueStageReconstruction(intent.projectId,intent.jobId,run.runId,()=>{});assert.equal(store.poll(sessionId,observation)[0]?.id,c.id);
  store.result({sessionId,commandId:c.id,state:'succeeded',result:{runId:run.runId,transferDigest,state:'reconstructed',objects:c.args.objects,imported:false,engineVerification:'pending'}});
}
export async function reviewBoundaryFixture(t:TestContext,options:{serviceGate?:boolean;queueGate?:boolean}={}){
  const boundary=await realpath(tmpdir()),root=await mkdtemp(join(boundary,'arcane-review-boundary-')),projectPath=await realpath(root);
  const source=join(root,'outputs','test-kit-'+REVIEW_JOB);await mkdir(source,{recursive:true});await saveStudioFixture(source,REVIEW_JOB);
  const work=new ConversationWorkStore({directory:join(root,'work'),projectPath}),conversation={provider:'codex' as const,threadId:'review-boundary-native',sessionId:null};
  work.bind({conversation,kind:'asset-job',id:REVIEW_JOB});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'review-connection',threadId:conversation.threadId};
  incarnation.seal({...binding,...conversation});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'review-stage'});
  let actor=registry.capture(incarnation.credential(),'mutate'),operation='review-stage',sequence=0;
  const privateDirectory=join(root,'private');await mkdir(privateDirectory,{mode:0o700});
  const sign=(value:unknown)=>createHmac('sha256','owned-boundary-fixture-key').update(assetReviewCanonical(value)).digest('hex');
  const authority:AssetReviewReceiptAuthority={directory:privateDirectory,sign,verify:(value,signature)=>signature===sign(value),withSnapshot:evaluate=>evaluate(),close(){}};
  const human=Symbol('fixture human permit'),reviews=new AssetReviewStore({projectPath,authority,authorizeHuman:(_command,proof)=>proof===human});
  const studio=new StudioStore({directory:join(root,'studio')});
  const grant=studio.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=studio.pair({code:grant.code,protocolVersion:1,capabilities:[...READ_METHODS,...WRITE_METHODS,...ASSET_STAGE_METHODS],identity:{clientSessionId:'review-plugin',pluginVersion:'0.1.9',name:'Synthetic reviewed target',placeId:12,universeId:34}});
  let playEpoch=0;
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'review-plugin',pluginArtifactHash:REVIEW_PLUGIN,markerName:'ArcaneTestProof_review',placeId:12,universeId:34,placeName:'Synthetic reviewed target',mode:'Edit' as const,playEpoch,continuitySupported:true,connected:true});
  studio.poll(pair.sessionId,proof());
  const parent:InstanceRef={instanceId:'review-workspace',sessionId:pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'};
  const context:StudioImportContextObservation={sessionId:pair.sessionId,root:'Workspace',parentRef:parent,placeId:12,universeId:34,mode:'Edit',modeProvenance:'StudioTestService.EditModeActive',creator:{status:'available',kind:'group',id:56,provenance:'game.CreatorType/CreatorId'},studioUser:{status:'not_applicable',id:null,provenance:'StudioService:GetUserId'}};
  const ledger=await createStudioImportPreparationStore({projectPath,directory:join(root,'preparations'),workAssociations:work,studio});
  const host=createStudioImportHost({projectPath,workAssociations:work,studio,pluginArtifactHash:REVIEW_PLUGIN,persistPreparation:(...args)=>ledger.save(...args)});
  const service=await createAssetService({cwd:root,projectPath,outputRoot:join(root,'outputs'),studioImport:host.hooks,...(options.serviceGate===false?{}:{modelReview:reviews})});
  const release=options.queueGate===false?()=>{}:studio.bindAssetModelReview(intent=>{
    if(!intent.modelReview)throw Object.assign(Error('Missing model review'),{code:'ASSET_REVIEW_REQUIRED'});
    service.assertReviewedImport(intent.jobId,{projectId:intent.projectId,conversation:intent.conversation},intent.modelReview);
  });
  const controller=createStudioImportStagingController({projectPath,workAssociations:work,studio,assets:service,host:host.hooks,pluginArtifactHash:REVIEW_PLUGIN});
  const scope={projectId:work.projectId,conversation},failures:unknown[]=[],delivered:StudioCommand[]=[];
  let held:string|null=null,externalModels=false;
  const releasePolicy=studio.bindModelSourcePolicy(()=>externalModels);
  const received=new Map<string,{count:number;bytes:number}>();
  function acknowledge(command:StudioCommand){
    if(command.method==='scene.import_context'){studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:context});return;}
    if(command.method==='asset.stage_packet'){
      const digest=(command.args.expected as {digest:string}).digest,packet=JSON.parse(command.args.packet as string),prior=received.get(digest)??{count:0,bytes:0};
      assert.equal(packet.ordinal,prior.count);prior.count++;prior.bytes+=Buffer.byteLength(command.args.packet as string);received.set(digest,prior);
      studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{transferDigest:digest,packetCount:prior.count,byteLength:prior.bytes,state:packet.kind==='seal'?'sealed':'receiving',engineVerification:'pending'}});return;
    }
    if(command.method==='asset.reconstruct'){
      studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{runId:command.args.runId,transferDigest:(command.args.expected as {digest:string}).digest,state:'reconstructed',objects:command.args.objects,imported:false,engineVerification:'pending'}});return;
    }
    if(command.method==='scene.place_asset'){
      const ref={...parent,instanceId:'reviewed-model',pathSegments:['Reviewed original'],className:'Model'};
      studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{ref,removedScripts:{count:0,classes:{},names:[]},mutation:{kind:'scene.place_asset',ref,before:null,after:{descendants:8,removedScripts:0,keptScripts:0,scale:1}}}});return;
    }
    assert.equal(command.method,'scene.build');
    const items=command.args.items as Json[],ref={...parent,instanceId:'reviewed-clones-'+command.id,pathSegments:['Reviewed forest'],className:'Model'},count=1+items.length*9,classes={Model:1+items.length};
    studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{ref,refs:{},created:{count,classes},mutation:{kind:'scene.build',ref,before:null,after:{count,classes}}}});
  }
  const pump=setInterval(()=>{
    try{
      const next=studio.commands(pair.sessionId).find(c=>c.state==='queued');if(next&&held===next.method)return;
      for(const command of studio.poll(pair.sessionId,proof())){delivered.push(command);acknowledge(command);}
    }catch(error){failures.push(error);}
  },20);
  t.after(async()=>{clearInterval(pump);controller.close();release();releasePolicy();host.close();await service.close();await ledger.close();reviews.close();registry.close();work.close();studio.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-review-boundary-')&&!isAbsolute(part)&&!part.includes('..'));await rm(root,{recursive:true,force:true});assert.deepEqual(failures,[]);});
  async function approve(){const subject=await service.modelReviewSubject(REVIEW_JOB,scope),pending=reviews.prepare(subject);return reviews.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},subject,human);}
  async function until(predicate:()=>boolean,label:string){const end=Date.now()+15_000;while(!predicate()){if(Date.now()>end)throw Error('Timed out: '+label);assert.deepEqual(failures,[]);await new Promise(r=>setTimeout(r,10));}}
  return {root,source,scope,studio,pair,parent,service,controller,reviews,registry,incarnation,proof,delivered,approve,until,acknowledge,work,authority,
    get actor(){return actor;},
    newActor(){incarnation.ended(operation);operation='review-operation-'+(++sequence);incarnation.dispatched({...binding,operationId:operation});actor=registry.capture(incarnation.credential(),'mutate');return actor;},
    retireActor(){incarnation.ended(operation);},
    hold(method:string){held=method;},resume(){held=null;},externalModels(value:boolean){externalModels=value;},
    async reject(){const subject=await service.modelReviewSubject(REVIEW_JOB,scope),review=reviews.status(subject);assert.ok(review);return reviews.decide({reviewId:review.reviewId,decision:'rejected',idempotencyKey:randomUUID()},subject,human);},
    async changeSource(name:'collision.glb'|'asset.glb'|'manifest.json'='collision.glb'){const path=join(source,name),bytes=await readFile(path);if(name==='manifest.json'){const m=JSON.parse(bytes.toString());m.limitations.push('Changed before dispatch');await writeFile(path,JSON.stringify(m));}else{bytes[bytes.length-1]=bytes[bytes.length-1]!^1;await writeFile(path,bytes);}},
    queued(method:string){return studio.commands(pair.sessionId).find(c=>c.method===method&&c.state==='queued');},
    async stage(){return controller.stage(REVIEW_JOB,actor);},
    async reconstruct(){return controller.reconstruct(REVIEW_JOB,actor);},
    place(watch:string,requestId='review-place-'+randomUUID()){return studio.enqueue({sessionId:pair.sessionId,requestId,method:'scene.place_asset',args:{watch,parent,name:'Reviewed original',position:[0,0,0],yaw:0,ground:true,anchor:true,allowScripts:false}});},
    clone(ref:InstanceRef,count=1){return studio.enqueue({sessionId:pair.sessionId,requestId:'review-clone-'+randomUUID(),method:'scene.build',args:{parent,container:{className:'Model',name:'Reviewed forest'},prototypes:[],templates:[ref],items:Array.from({length:count},(_,index)=>({kind:'clone',template:1,name:'Tree '+index,parent:0,at:[index*4,0,0],yaw:0,scale:1}))} as unknown as Json});},
    changePlayEpoch(){playEpoch++;studio.poll(pair.sessionId,proof());},
  };
}
