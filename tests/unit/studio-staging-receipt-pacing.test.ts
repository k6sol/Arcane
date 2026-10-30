import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {STUDIO_ASSET_TRANSFER_LIMITS as LIMITS,type StudioAssetStageArgs,type StudioCommand,type Json} from '../../packages/protocol/src/studio.js';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {createNativeAssetRegistry,assertNativeAssetActor,assertNativeAssetStageOperationAvailable} from '../../apps/daemon/src/native-asset-authority.js';
import {createStudioImportStagingController,STUDIO_STAGING_LIMITS} from '../../apps/daemon/src/studio-import-staging-controller.js';
import {createStudioImportManifestAuthority,type HostGeneratedStudioImport} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,STUDIO_IMPORT_TRANSFER_LIMITS} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {parseNativeStudioStagingResponse} from '../../packages/asset-pipeline/src/studio-staging-wire.js';
import {pngCrc} from '../../packages/asset-pipeline/src/validation.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';
import type {StudioImportHostOptions} from '../../apps/daemon/src/asset-import-adapter.js';

// Actual branded PNG/GLB decoding, controller, native authority, policy and SQLite.
// Source/model-review/host-hook ports and authenticated plugin ACKs are fixtures;
// this does not claim actual human UI or public AssetService source-host acceptance.
const JOB='11111111-1111-4111-8111-111111111111',PLUGIN='a'.repeat(64),hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Doc=Record<string,any>;
function png(size:number,role:number):Buffer{
  const chunk=(kind:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(kind,4);data.copy(out,8);out.writeUInt32BE(pngCrc(out.subarray(4,data.length+8)),data.length+8);return out;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  const pixels=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const at=y*(size*4+1)+1+x*4;pixels[at]=role===1?128:role===2?255:40+(x%2)*20;pixels[at+1]=role===1?128:role===2?192:120;pixels[at+2]=role===1?255:role===2?0:20;pixels[at+3]=255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function generated(projectId:string,target:HostGeneratedStudioImport['target'],large:boolean):HostGeneratedStudioImport{
  const doc:Doc={asset:{version:'2.0',generator:'Khronos glTF Blender I/O v4.5.48'},buffers:[{byteLength:0}],bufferViews:[],accessors:[],meshes:[],nodes:[],scenes:[{nodes:[0,1,2]}],scene:0};let bin=Buffer.alloc(0);
  const view=(bytes:Buffer)=>{const at=Math.ceil(bin.length/4)*4,index=doc.bufferViews.length;bin=Buffer.concat([bin,Buffer.alloc(at-bin.length),bytes]);doc.bufferViews.push({buffer:0,byteOffset:at,byteLength:bytes.length});return index;};
  const accessor=(values:number[],type:string,componentType=5126)=>{const bytes=Buffer.alloc(values.length*(componentType===5126?4:1));values.forEach((n,i)=>componentType===5126?bytes.writeFloatLE(n,i*4):bytes.writeUInt8(n,i));const index=doc.accessors.length,a:Doc={bufferView:view(bytes),componentType,type,count:values.length/(type==='VEC3'?3:type==='VEC2'?2:1)};if(type==='VEC3'){a.min=[0,1,2].map(c=>Math.min(...values.filter((_,i)=>i%3===c)));a.max=[0,1,2].map(c=>Math.max(...values.filter((_,i)=>i%3===c)));}doc.accessors.push(a);return index;};
  const position=accessor([0,0,0,1,0,0,0,1,0,0,0,1],'VEC3'),normal=accessor([0,0,1,0,0,1,0,0,1,0,0,1],'VEC3'),uv=accessor([0,0,1,0,1,1,0,1],'VEC2'),indices=accessor([0,2,1,0,1,3,0,3,2,1,2,3],'SCALAR',5121);
  doc.images=[];for(const size of (large?[1024,512]:[16,8]))for(let role=0;role<3;role++)doc.images.push({mimeType:'image/png',bufferView:view(png(size,role))});
  doc.samplers=[{wrapS:10497,wrapT:10497,magFilter:9729,minFilter:9987}];doc.textures=doc.images.map((_:unknown,source:number)=>({source,sampler:0}));
  doc.materials=[0,3].map(i=>({pbrMetallicRoughness:{baseColorTexture:{index:i},metallicRoughnessTexture:{index:i+2}},normalTexture:{index:i+1}}));
  const ids=[hash('large-one'),hash('large-two'),hash('large-collision')].map(s=>'arcane_'+s),objects:HostGeneratedStudioImport['models'][number]['objects']=[];
  for(let i=0;i<3;i++){const role=i===2?'collision':'render',collisionFor=i===2?ids.slice(0,2).sort():[];doc.meshes.push({primitives:[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv},indices,...(i<2?{material:i}:{})}]});
    doc.nodes.push({mesh:i,extras:{arcane_identity_scheme:'arcane-semantic-v1',arcane_source_object_id:ids[i],arcane_role:role,arcane_source_key:'part'+i,arcane_pivot:[0,0,0],arcane_collision_for:JSON.stringify(collisionFor)}});objects.push({sourceObjectId:ids[i]!,nodeIndex:i,role,pivot:[0,0,0],collisionFor});}
  doc.buffers[0].byteLength=bin.length;const text=Buffer.from(JSON.stringify(doc)),size=Math.ceil(text.length/4)*4,n=Math.ceil(bin.length/4)*4,bytes=Buffer.alloc(28+size+n);
  bytes.writeUInt32LE(0x46546c67);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(size,12);bytes.writeUInt32LE(0x4e4f534a,16);bytes.fill(32,20,20+size);text.copy(bytes,20);bytes.writeUInt32LE(n,20+size);bytes.writeUInt32LE(0x004e4942,24+size);bin.copy(bytes,28+size);
  return {schemaVersion:1,projectId,assetId:'arcane_'+hash('large-budget'),revisionId:JOB,sourceSha256:hash(bytes),producer:{blenderVersion:'4.5.3 LTS',exporterVersion:'Khronos glTF Blender IO v4.5.48'},target,placement:{mode:'bottom-centre'},studsPerMeter:1/.28,files:[{fileId:'export',contentType:'model/gltf-binary',sha256:hash(bytes),bytes}],models:[{fileId:'export',resources:[],objects}],anchors:[],baseline:null};
}

import {setImmediate as immediate} from 'node:timers/promises';
async function pacedFixture(t:test.TestContext,large=false,storeNow?:()=>number){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'arcane-receipt-paced-')),projectPath=await realpath(root),work=new ConversationWorkStore({directory:join(root,'work'),projectPath});
  const conversation={provider:'codex' as const,threadId:'receipt-paced',sessionId:null};work.bind({conversation,kind:'asset-job',id:JOB});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'receipt-paced',threadId:conversation.threadId};incarnation.seal({...binding,...conversation});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'paced-stage'});let actor=registry.capture(incarnation.credential(),'mutate');
  const store=new StudioStore({directory:join(root,'studio'),...(storeNow?{now:storeNow}:{})}),grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet','asset.reconstruct','scene.import_context'],identity:{clientSessionId:'paced-plugin',pluginVersion:'0.1.9',name:'Paced fixture',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'paced-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_paced',placeId:12,universeId:34,placeName:'Paced fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});store.poll(pair.sessionId,proof());
  const target={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace' as const,parentRef:'paced-parent',creator:{kind:'group' as const,id:'56'}},g=generated(work.projectId,target,large),authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>g}),prepared=authority.prepare(await authority.admit(JOB));authority.close();
  const payload=decodeStudioImportPayload(prepared,new Map(g.files.map(f=>[f.fileId,f.bytes]))),transfer=createStudioImportTransfer(prepared,payload),reference={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:hash('paced-reviewed-source'),revision:1};
  let approved=true,sourceCurrent=true,clockOffset=0,clockValue:number|undefined,count=0,bytes=0,checks=0,operation='paced-stage';
  const check=()=>{checks++;assertNativeAssetActor(actor,'mutate');if(!approved||!sourceCurrent)throw Object.assign(Error('Reviewed source unavailable'),{code:'ASSET_REVIEW_REQUIRED'});};
  const review={reference,assertCurrent:check},assets={async prepareStudioImportPayload(){check();return {prepared,payload,transfer,review};},async reviewImport(){check();return review;}} as unknown as Pick<AssetService,'prepareStudioImportPayload'|'reviewImport'>;
  const host:StudioImportHostOptions={workAssociations:work,beginPreparationAttempt(_scope,_job,_actor,guard){guard();return Object.freeze({kind:'studio-import-preparation-attempt',id:randomUUID()});},selectTarget(_scope,_job,_actor,guard){guard();return {target,placement:{mode:'bottom-centre'},studsPerMeter:1/.28};},validateTarget(){assert.deepEqual(prepared.manifest.target,target);},releaseTarget(){}};
  const release=store.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,reference);check();}),controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN,now:()=>clockValue??Date.now()+clockOffset});
  t.after(async()=>{controller.close();release();store.close();registry.close();work.close();const part=relative(base,root);assert.ok(part.startsWith('arcane-receipt-paced-')&&!isAbsolute(part)&&!part.includes('..'));await rm(root,{recursive:true,force:true});});
  const poll=()=>store.poll(pair.sessionId,proof());
  function ack(c:StudioCommand,wrong=false){
    let result:unknown;
    if(c.method==='asset.stage_packet'){
      const packet=JSON.parse(c.args.packet as string);assert.equal(packet.ordinal,count);count++;bytes+=Buffer.byteLength(c.args.packet as string);
      result={transferDigest:transfer.digest,packetCount:count,byteLength:wrong?bytes+1:bytes,state:packet.kind==='seal'?'sealed':'receiving',engineVerification:'pending'};
    }else if(c.method==='scene.import_context')result={sessionId:pair.sessionId,root:'Workspace',parentRef:{instanceId:'paced-parent',sessionId:pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'},placeId:12,universeId:34,mode:'Edit',modeProvenance:'StudioTestService.EditModeActive',creator:{status:'available',kind:'group',id:56,provenance:'game.CreatorType/CreatorId'},studioUser:{status:'not_applicable',id:null,provenance:'StudioService:GetUserId'}};
    else{assert.equal(c.method,'asset.reconstruct');result={runId:c.args.runId,transferDigest:transfer.digest,state:'reconstructed',objects:c.args.objects,imported:false,engineVerification:'pending'};}
    // Same synchronous result(); send({accepted:true}) order as studio-routes.
    store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:result as Json});
  }
  async function firstQueued(){for(let i=0;i<256;i++){if(store.commands(pair.sessionId).some(c=>c.state==='queued'))return;await immediate();}throw Error('No first queued command');}
  return {store,projectId:work.projectId,controller,transfer,payload,poll,ack,firstQueued,get actor(){return actor;},get counts(){return {count,bytes,checks};},reject(){approved=false;},changeSource(){sourceCurrent=false;},retire(){incarnation.ended(operation);},expire(){clockOffset=120001;},clock(value:number){clockValue=value;},newActor(){incarnation.ended(operation);operation='paced-reconstruct';incarnation.dispatched({...binding,operationId:operation});actor=registry.capture(incarnation.credential(),'mutate');}};
}

test('committed ACK queues the next packet before the next plugin I/O poll, with fallback timer held',async t=>{
  const f=await pacedFixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  try{
    await f.firstQueued();
    for(let ordinal=0;ordinal<f.transfer.packets.length;ordinal++){
      const commands=f.poll();assert.equal(commands.length,1,'intermediate empty poll would take real plugin 2s idle branch');
      assert.equal(JSON.parse(commands[0]!.args.packet as string).ordinal,ordinal);f.ack(commands[0]!);
      // Subsequent I/O turn after the result route's synchronous ACK send.
      await immediate();
    }
    const result=await outcome;assert.ok('value'in result);assert.equal(result.value.packetCount,f.transfer.packets.length);
  }finally{f.controller.close();t.mock.timers.tick(25);await outcome;}
});

for(const mutation of ['reject','source','actor','wrong-ack'] as const)test('receipt wake cannot bypass '+mutation+' fence or enqueue another packet',async t=>{
  const f=await pacedFixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  await f.firstQueued();const first=f.poll()[0]!;f.ack(first,mutation==='wrong-ack');
  if(mutation==='reject')f.reject();if(mutation==='source')f.changeSource();if(mutation==='actor')f.retire();
  const result=await outcome;assert.ok('error'in result);assert.equal(f.store.commands().filter(c=>c.method==='asset.stage_packet').length,1);
  assert.deepEqual(f.poll(),[]);await assert.rejects(f.controller.stage(JOB,f.actor));
});

test('receipt wait fallback preserves total deadline and closes without replay',async t=>{
  const f=await pacedFixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  await f.firstQueued();f.expire();t.mock.timers.tick(25);const result=await outcome;
  assert.ok('error'in result);assert.equal((result.error as {code:string}).code,'STUDIO_STAGE_TIMEOUT');
  assert.equal(f.store.commands().filter(c=>c.method==='asset.stage_packet').length,1);assert.deepEqual(f.poll(),[]);
});

test('fractional now and12.5ms remaining use the original bounded timeout semantics',async t=>{
  const f=await pacedFixture(t),start=Date.now()+.25;f.clock(start);t.mock.timers.enable({apis:['setTimeout']});
  const command=f.store.command.bind(f.store),wait=f.store.waitForCommandResult.bind(f.store);let remaining:number|undefined;
  t.mock.method(f.store,'command',(id:string)=>{const c=command(id);if(c.method==='asset.stage_packet'&&c.state==='queued')f.clock(start+9987.5);return c;});
  t.mock.method(f.store,'waitForCommandResult',(id:string,ms:number)=>{remaining=ms;return wait(id,ms);});
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  await f.firstQueued();
  for(let turn=0;turn<256&&remaining===undefined;turn++)await immediate();
  assert.equal(remaining,12.5);assert.equal(f.store.commands().filter(c=>c.method==='asset.stage_packet').length,1);
  f.controller.close();t.mock.timers.tick(13);assert.ok('error'in await outcome);
});

test('a queued original packet gives a genuine paired poll an I/O turn before its expired receipt proof is checked',async t=>{
  // Both clocks are controlled; the proof is minted only by actual poll(), not
  // by a mocked session read. This is an event-loop boundary, not engine proof.
  let clock=Date.UTC(2026,9,30);
  const f=await pacedFixture(t,false,()=>clock);f.clock(clock);
  const originalProof=f.store.sessions()[0]!.proof!;
  const enqueue=f.store.enqueueStagePacket.bind(f.store);let advanced=false;
  t.mock.method(f.store,'enqueueStagePacket',(...args:Parameters<StudioStore['enqueueStagePacket']>)=>{
    const command=enqueue(...args);
    if(!advanced){advanced=true;clock+=6001;f.clock(clock);}
    return command;
  });
  // A pending plugin turn must find the original packet already queued. Before
  // the queue-first barrier, the expired receipt guard cancels it first.
  const pendingPoll=immediate().then(()=>f.poll());
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  let commands=await pendingPoll;
  assert.equal(Date.parse(originalProof.expiresAt),clock-1);
  assert.equal(Date.parse(f.store.sessions()[0]!.proof!.observedAt),clock);
  for(let ordinal=0;ordinal<f.transfer.packets.length;ordinal++){
    assert.equal(commands.length,1,'the pending poll must not take the 2s empty-queue branch');
    assert.equal(JSON.parse(commands[0]!.args.packet as string).ordinal,ordinal);
    f.ack(commands[0]!);await immediate();
    if(ordinal+1<f.transfer.packets.length)commands=f.poll();
  }
  const result=await outcome;assert.ok('value'in result);
  assert.equal(result.value.packetCount,f.transfer.packets.length);
  assert.equal(result.value.byteLength,f.transfer.byteLength);assert.equal(result.value.imported,false);
});

test('an expired proof without a genuine poll still cancels the queued original packet without replay',async t=>{
  let clock=Date.UTC(2026,9,30);
  const f=await pacedFixture(t,false,()=>clock);f.clock(clock);
  const before=f.store.sessions()[0]!.proof!,enqueue=f.store.enqueueStagePacket.bind(f.store);
  t.mock.method(f.store,'enqueueStagePacket',(...args:Parameters<StudioStore['enqueueStagePacket']>)=>{
    const command=enqueue(...args);clock+=6001;f.clock(clock);return command;
  });
  const result=await f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error}));
  assert.ok('error'in result);assert.equal((result.error as {code:string}).code,'STUDIO_STAGE_CONTINUITY');
  assert.equal(f.store.sessions()[0]!.proof!.observedAt,before.observedAt);
  const commands=f.store.commands();assert.equal(commands.length,1);assert.equal(commands[0]!.state,'cancelled');
  assert.equal(f.store.readStageRun(f.projectId,JOB)!.receipt,null);
  assert.throws(()=>assertNativeAssetStageOperationAvailable(f.actor,JOB));
  await assert.rejects(f.controller.stage(JOB,f.actor));assert.equal(f.store.commands().length,1);
});

test('actor retirement in the queue-first I/O turn is rechecked before delivery or another enqueue',async t=>{
  const f=await pacedFixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const retirement=immediate().then(()=>f.retire());let settled=false;
  const outcome=f.controller.stage(JOB,f.actor).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  try{
    await retirement;
    for(let turn=0;turn<256&&!settled;turn++)await immediate();
    assert.equal(settled,true,'the authority check must run without the held fallback timer');
    const result=await outcome;assert.ok('error'in result);
    assert.equal((result.error as {code:string}).code,'NATIVE_ASSET_AUTHORITY');
    const commands=f.store.commands();assert.equal(commands.length,1);assert.equal(commands[0]!.state,'cancelled');
    assert.deepEqual(f.poll(),[]);await assert.rejects(f.controller.stage(JOB,f.actor));
    assert.equal(f.store.commands().length,1);
  }finally{f.controller.close();t.mock.timers.tick(25);await outcome;}
});

test('full 20MiB PBR chain uses immediate ACK polls and real 2s idle pacing within unchanged120s deadline',{timeout:120000},async t=>{
  const f=await pacedFixture(t,true),started=Date.now();
  assert.equal(f.payload.textures!.reduce((n,x)=>n+x.bytes.byteLength,0),20*1024*1024);
  const stage=f.controller.stage(JOB,f.actor);await f.firstQueued();let intermediateIdlePolls=0;
  for(let ordinal=0;ordinal<f.transfer.packets.length;){
    const commands=f.poll();
    if(!commands.length){intermediateIdlePolls++;await new Promise<void>(resolve=>setTimeout(resolve,2000));continue;}
    assert.equal(commands.length,1);f.ack(commands[0]!);ordinal++;await immediate();
  }
  const staged=await stage,stageMs=Date.now()-started;assert.equal(intermediateIdlePolls,0);assert.equal(staged.byteLength,f.transfer.byteLength);assert.equal(staged.imported,false);
  f.newActor();const reconstructionStarted=Date.now(),reconstruct=f.controller.reconstruct(JOB,f.actor);await f.firstQueued();
  for(let command=0;command<2;command++){const next=f.poll();assert.equal(next.length,1);f.ack(next[0]!);await immediate();}
  const reconstructed=await reconstruct;assert.equal(reconstructed.imported,false);assert.equal(reconstructed.objects.length,3);
  const reconstructMs=Date.now()-reconstructionStarted,elapsedMs=Date.now()-started;assert.ok(elapsedMs<STUDIO_STAGING_LIMITS.totalDeadlineMs);
  t.diagnostic(JSON.stringify({rawRgbaBytes:20*1024*1024,packets:staged.packetCount,rawTransferBytes:staged.byteLength,stageMs,reconstructMs,elapsedMs,defaultMcpWaitMs:30000,stageExceedsDefaultMcpWait:stageMs>30000,intermediateIdlePolls,reviewChecks:f.counts.checks,fixture:'real controller/store/policy, trusted source/review/host/paired ACK doubles; no engine or human UI'}));
});
