import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createStudioImportHost } from '../../apps/daemon/src/studio-import-host.js';
import { createStudioImportStagingController } from '../../apps/daemon/src/studio-import-staging-controller.js';
import { createStudioImportPreparationStore } from '../../apps/daemon/src/studio-import-preparation-store.js';
import { createAssetService, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { createNativeAssetRegistry, nativeAssetActorScope } from '../../apps/daemon/src/native-asset-authority.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { READ_METHODS, WRITE_METHODS, ASSET_STAGE_METHODS, ROOTS, type StudioImportContextObservation, type StudioCommand } from '../../packages/protocol/src/studio.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import {createServer} from 'node:http';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {nativeAssetRoutes} from '../../apps/daemon/src/native-asset-routes.js';
import {assetReviewDigest,type AssetReviewSubject,type AssetReviewReference} from '../../apps/daemon/src/asset-review.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';

// Production host, stores, queue receipts, completed-byte service and pending
// ledger. The paired plugin and GLBs are synthetic; no real Studio, SDK, worker,
// provider, credentials, import or upload is involved.
const JOB = '11111111-1111-4111-8111-111111111111', HASH = 'a'.repeat(64);
const SECOND_JOB = '22222222-2222-4222-8222-222222222222';
const conversation = { provider: 'codex' as const, threadId: 'fixture.import-host', sessionId: null };
// Explicit trusted fixture model port. Human decision authentication is tested
// with the real signed store in asset-review-boundaries.test.ts.
const fixtureReference=(subject:AssetReviewSubject):AssetReviewReference=>({reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:assetReviewDigest(subject),revision:1});
const fixtureModelReview={assertApproved:fixtureReference,assertReference(subject:AssetReviewSubject,reference:AssetReviewReference){assert.deepEqual(reference,fixtureReference(subject));}};
const refused = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
async function fixture(t: test.TestContext, local = false, hostNow: () => number = Date.now, jobIds: readonly string[] = [JOB]) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-import-host-'));
  const projectPath = await realpath(root);
  let studio = new StudioStore({ directory: join(root, 'studio') });
  let work = new ConversationWorkStore({ directory: join(root, 'work'), projectPath });
  for (const id of jobIds) work.bind({ conversation, kind: 'asset-job', id });
  let registry = createNativeAssetRegistry({ projectPath }), incarnation = registry.issue();
  const binding = { connectionId: 'fixture-connection', threadId: conversation.threadId };
  incarnation.seal({ ...binding, ...conversation }); incarnation.grant(binding);
  incarnation.dispatched({ ...binding, operationId: 'fixture-intent' });
  let actor = registry.capture(incarnation.credential(), 'mutate');
  const pair = (client: string, capabilities = [...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS]) => {
    const grant = studio.createGrant({ allowedRoots: [...ROOTS], allowWrites: true });
    return studio.pair({ code: grant.code, protocolVersion: 1, capabilities,
      identity: { clientSessionId: client, pluginVersion: '0.1.7', name: 'Synthetic import target', placeId: local ? 0 : 12, universeId: local ? 0 : 34 } });
  };
  let paired = pair('fixture-plugin'), epoch = 0, operation = 0;
  const proof = (hash = HASH, mode: 'Edit' | 'Play' = 'Edit', playEpoch = epoch) => {
    const session = studio.session(paired.sessionId);
    return { sessionId: session.id, clientLifetimeId: session.clientSessionId, pluginArtifactHash: hash,
      markerName: 'ArcaneTestProof_fixture', placeId: session.placeId, universeId: session.universeId,
      placeName: session.name, mode, playEpoch, continuitySupported: true, connected: true };
  };
  studio.poll(paired.sessionId, proof());
  const context = (): StudioImportContextObservation => ({ sessionId: paired.sessionId, root: 'Workspace',
    parentRef: { instanceId: 'fixture-workspace', sessionId: paired.sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace' },
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
    creator: local ? { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' }
      : { status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId' },
    studioUser: local ? { status: 'available', id: 1234, provenance: 'StudioService:GetUserId' }
      : { status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId' } });
  let ledger = await createStudioImportPreparationStore({ projectPath, directory: join(root, 'preparations'), workAssociations: work, studio });
  let saved = 0, response = context, held = false, reads = 0;
  const makeHost = () => createStudioImportHost({ projectPath, workAssociations: work, studio, pluginArtifactHash: HASH, now: hostNow,
    persistPreparation: async (...args) => { await ledger.save(...args); saved++; } });
  let host = makeHost();
  const sourcesCreated = new Set<string>();
  let service: AssetService | undefined;
  let releaseReview:(()=>void)|undefined;
  let staging: ReturnType<typeof createStudioImportStagingController> | undefined;
  const received = new Map<string, {count: number; bytes: number}>();
  let stageHook: ((command: StudioCommand) => boolean) | null = null;
  let reconstructionHook: ((command:StudioCommand)=>boolean)|null=null;
  const failures: unknown[] = [];
  const pump = setInterval(() => {
    try {
      if (held) return;
      for (const command of studio.poll(paired.sessionId, proof())) {
        if(command.method==='asset.reconstruct'){
          if(reconstructionHook&&!reconstructionHook(command))continue;
          const args=command.args;
          studio.result({sessionId:paired.sessionId,commandId:command.id,state:'succeeded',result:{runId:args.runId,
            transferDigest:(args.expected as {digest:string}).digest,state:'reconstructed',objects:args.objects,imported:false,engineVerification:'pending'}});
          continue;
        }
        if (command.method === 'asset.stage_packet') {
          if (stageHook && !stageHook(command)) continue;
          const expected = command.args.expected as {digest: string}, packet = JSON.parse(command.args.packet as string);
          const prior = received.get(expected.digest) ?? {count: 0, bytes: 0};
          assert.equal(packet.ordinal, prior.count); prior.count++; prior.bytes += Buffer.byteLength(command.args.packet as string);
          received.set(expected.digest, prior);
          studio.result({sessionId: paired.sessionId, commandId: command.id, state: 'succeeded', result: {
            transferDigest: expected.digest, packetCount: prior.count, byteLength: prior.bytes,
            state: packet.kind === 'seal' ? 'sealed' : 'receiving', engineVerification: 'pending',
          }});
          continue;
        }
        reads++; assert.equal(command.method, 'scene.import_context'); assert.deepEqual(command.args, {});
        studio.result({ sessionId: paired.sessionId, commandId: command.id, state: 'succeeded', result: response() });
      }
    } catch (error) { failures.push(error); }
  }, 100);
  t.after(async () => {
    clearInterval(pump); staging?.close(); releaseReview?.(); host.close(); await service?.close(); await ledger.close(); registry.close(); work.close(); studio.close();
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-import-host-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  const scope = nativeAssetActorScope(actor), guard = () => {};
  async function setupService() {
    if (service) return service;
    const outputRoot = join(root, 'outputs');
    for (const id of jobIds) if (!sourcesCreated.has(id)) {
      const directory = join(outputRoot, 'test-kit-' + id);
      await mkdir(directory, {recursive: true}); await saveStudioFixture(directory, id); sourcesCreated.add(id);
    }
    service = await createAssetService({cwd: root, projectPath, outputRoot, studioImport: host.hooks,modelReview:fixtureModelReview});
    releaseReview=studio.bindAssetModelReview(intent=>{assert.ok(intent.modelReview);service!.assertReviewedImport(intent.jobId,{projectId:intent.projectId,conversation:intent.conversation},intent.modelReview);});
    return service;
  }
  const controller=async()=>{
    const assets=await setupService();
    staging ??= createStudioImportStagingController({projectPath,workAssociations:work,studio,assets,host:host.hooks,pluginArtifactHash:HASH});
    return staging;
  };
  const newActor = () => {
    incarnation.ended(operation === 0 ? 'fixture-intent' : 'fixture-attempt-' + operation);
    incarnation.dispatched({...binding, operationId: 'fixture-attempt-' + (++operation)});
    return registry.capture(incarnation.credential(), 'mutate');
  };
  return { root, get studio() {return studio;}, get work() {return work;}, get actor() {return actor;}, get incarnation() {return incarnation;},
    get registry() {return registry;}, get host() {return host;}, get ledger() {return ledger;}, scope, guard, pair, proof, get paired() {return paired;}, newActor,
    loseBuffers() { epoch++; received.clear(); studio.poll(paired.sessionId, proof()); },
    // Transport.exchange() creates a new Operations/buffer set but keeps the
    // same Transport/TestProof lifetime and play epoch during genuine re-pair.
    rePair(freshOperation = true) { studio.revoke(paired.sessionId, 'synthetic plugin re-pair'); paired = pair('fixture-plugin'); received.clear(); studio.poll(paired.sessionId, proof()); return freshOperation ? newActor() : registry.capture(incarnation.credential(), 'mutate'); },
    async restartBackend() {
      held = true; staging?.close(); staging = undefined; releaseReview?.();releaseReview=undefined;host.close(); await service?.close(); service = undefined;
      await ledger.close(); registry.close(); work.close(); studio.close();
      studio = new StudioStore({directory: join(root, 'studio')});
      work = new ConversationWorkStore({directory: join(root, 'work'), projectPath});
      registry = createNativeAssetRegistry({projectPath}); incarnation = registry.issue();
      incarnation.seal({...binding, ...conversation}); incarnation.grant(binding); incarnation.dispatched({...binding, operationId:'fixture-intent'});
      actor = registry.capture(incarnation.credential(), 'mutate'); operation = 0;
      paired = pair('fixture-plugin'); studio.poll(paired.sessionId, proof());
      ledger = await createStudioImportPreparationStore({projectPath, directory:join(root,'preparations'),workAssociations:work,studio});
      host = makeHost(); received.clear(); held = false; return actor;
    },
    context, hold: () => { held = true; }, respond: (fn: typeof context) => { response = fn; },
    onStage: (hook: (command: StudioCommand) => boolean) => {stageHook = hook;},
    onReconstruction:(hook:(command:StudioCommand)=>boolean)=>{reconstructionHook=hook;},
    resetController() { staging?.close(); staging = undefined; },
    async stage(stageActor = actor, id = JOB) {
      return (await controller()).stage(id, stageActor);
    },
    async reconstruct(reconstructActor=actor,id=JOB){return (await controller()).reconstruct(id,reconstructActor);},
    async reconstructionStatus(readActor=registry.capture(incarnation.credential(),'read'),id=JOB){return (await controller()).reconstructionStatus(id,readActor);},
    async nativeClient(){
      const assets=await setupService(),ownedController=await controller();
      const conversations=createAssetConversationHost({projectPath,workAssociations:work,conversation:()=>{throw Error('Native provider calls are forbidden.');},start:()=>{throw Error('Generation is forbidden.');}});
      const route=nativeAssetRoutes(assets,conversations,registry,ownedController);let origin='';
      const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),origin).then(handled=>{if(!handled){response.writeHead(404);response.end('{}');}}).catch(error=>{failures.push(error);response.destroy();});});
      await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
      const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
      t.after(async()=>{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));});
      return new DaemonClient({url:origin,token:incarnation.credential(),assetAudience:'native-session'});
    },
    async status(readActor=registry.capture(incarnation.credential(),'read'),id=JOB){return (await controller()).status(id,readActor);},
    counts: () => ({ saved, reads }), async prepare() {
      return (await setupService()).prepareStudioImport(JOB, actor);
    } };
}

test('production host observes two queue receipts and durably saves a strictly pending preparation', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.manifest.engineVerification, 'pending');
  assert.deepEqual(prepared.manifest.target.creator, { kind: 'group', id: '56' });
  assert.deepEqual(f.counts(), { saved: 1, reads: 2 });
  const record = await f.ledger.get(f.actor, JOB, f.guard); assert.ok(record);
  assert.equal(record.prepared.digest, prepared.digest); assert.equal(record.engineVerification, 'pending');
  assert.notEqual(record.witness.initialContextReceiptId, record.witness.confirmedContextReceiptId);
  assert.equal(f.studio.commands().every(c => c.method === 'scene.import_context' && c.state === 'succeeded'), true);
  const retry = await f.prepare();
  assert.equal(retry.digest, prepared.digest);
  assert.deepEqual(f.counts(), { saved: 2, reads: 4 });
  assert.deepEqual(await f.ledger.get(f.actor, JOB, f.guard), record, 'Fresh read receipts do not rewrite immutable pending metadata.');
});

test('native controller stages owned bytes through durable bounded queue receipts but never claims an import', async t => {
  const f = await fixture(t), staged = await f.stage();
  assert.equal(staged.status, 'staged'); assert.equal(staged.state, 'sealed');
  assert.equal(staged.imported, false); assert.equal(staged.engineVerification, 'pending');
  assert.equal(staged.packetCount, staged.commandIds.length); assert.ok(staged.byteLength > 0);
  for (const id of staged.commandIds) {
    const command = f.studio.command(id);
    assert.equal(command.method, 'asset.stage_packet'); assert.equal(command.state, 'succeeded');
    assert.ok(Buffer.byteLength(JSON.stringify(command.args)) <= 256 * 1024);
    assert.throws(() => f.studio.enqueue({sessionId: command.sessionId, requestId: command.requestId, method: command.method, args: command.args}), {code: 'ASSET_STAGE_AUTHORITY'});
    await assert.rejects(f.studio.enqueueVerified({sessionId:command.sessionId,requestId:command.requestId,method:command.method,args:command.args},null),{code:'ASSET_STAGE_AUTHORITY'});
    assert.throws(() => f.studio.restore({commandId: id, requestId: 'fixture_restore_stage'}), {code: 'RESTORE'});
  }
  assert.deepEqual(f.counts(), {saved: 1, reads: 3});
  const record = await f.ledger.get(f.actor, JOB, f.guard); assert.equal(record?.engineVerification, 'pending');
  const before=f.counts(),status=await f.status();assert.equal(status.stage?.phase,'cpu-staged');
  assert.deepEqual(status.stage?.commands.map(c=>c.commandId),staged.commandIds);assert.equal(status.stage?.receipt?.engineVerification,'pending');
  assert.equal(status.stage?.imported,false);assert.equal(status.stage?.retry,false);
  await assert.rejects(f.stage(),refused('STUDIO_STAGE_EXISTS'));assert.deepEqual(f.counts(),before);
});

test('production controller reconstructs the original sealed run once with exact bounded source metadata',async t=>{
  const f=await fixture(t),staged=await f.stage(),original=f.studio.readStageRun(f.scope.projectId,JOB)!;
  const result=await f.reconstruct();assert.equal(result.runId,staged.runId);assert.equal(result.state,'reconstructed');
  assert.equal(result.transferDigest,staged.transferDigest);assert.equal(result.imported,false);assert.equal(result.engineVerification,'pending');
  assert.equal(result.objects.length,8);assert.ok(result.objects.every(o=>o.vertexCount===4&&o.triangleCount===4));
  const command=f.studio.command(result.commandId);assert.equal(command.method,'asset.reconstruct');
  assert.throws(()=>f.studio.enqueue({sessionId:command.sessionId,requestId:command.requestId,method:command.method,args:command.args}),{code:'ASSET_STAGE_AUTHORITY'});
  await assert.rejects(f.studio.enqueueVerified({sessionId:command.sessionId,requestId:command.requestId,method:command.method,args:command.args},null),{code:'ASSET_STAGE_AUTHORITY'});
  assert.throws(()=>f.studio.restore({commandId:command.id,requestId:'fixture_restore_reconstruction'}),{code:'RESTORE'});
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId,JOB),original,'engine allocation evidence cannot rewrite CPU history');
  f.resetController();await assert.rejects(f.reconstruct(f.newActor()),refused('STUDIO_RECONSTRUCT_EXISTS'));
  assert.equal(f.studio.commands().filter(c=>c.method==='asset.reconstruct').length,1);
  const status=await f.reconstructionStatus();assert.equal(status.reconstruction?.state,'succeeded');
  assert.equal(status.reconstruction?.receiptScope,'historical-reconstruction');assert.equal(status.reconstruction?.currentResources,'unobserved');
  assert.equal(status.reconstruction?.retry,false);assert.equal(status.reconstruction?.imported,false);
});

test('native HTTP and production client reach the real staging/reconstruction controller and private Store admission',async t=>{
  const f=await fixture(t),client=await f.nativeClient(),staged=await client.assetsStageStudioImport(JOB);
  assert.ok('staged'in staged);assert.equal(staged.staged.imported,false);
  const result=await client.assetsReconstructStudioImport(JOB);assert.ok('reconstructed'in result);
  assert.equal(result.projectId,f.scope.projectId);assert.equal(result.reconstructed.runId,staged.staged.runId);
  assert.equal(result.reconstructed.objects.length,8);assert.equal(result.reconstructed.imported,false);assert.equal(result.reconstructed.engineVerification,'pending');
  f.incarnation.revokeGrant();const status=await client.assetsStudioReconstructionStatus(JOB);
  assert.equal(status.reconstruction?.commandId,result.reconstructed.commandId);assert.equal(status.reconstruction?.currentResources,'unobserved');
  assert.equal(f.studio.commands().filter(c=>c.method==='asset.reconstruct').length,1);
});

test('reconstruction refuses absent sealed evidence and changed original Edit continuity before allocating',async t=>{
  const f=await fixture(t);await assert.rejects(f.reconstruct(),refused('STUDIO_RECONSTRUCT_STATE'));
  const staged=await f.stage(),before=f.studio.commands().length;f.loseBuffers();
  await assert.rejects(f.reconstruct(f.newActor()),refused('STUDIO_STAGE_CONTINUITY'));
  assert.equal(f.studio.commands().length,before);assert.equal(f.studio.readStageReconstruction(f.scope.projectId,JOB,staged.runId),null);
});

test('fresh creator observation must still equal the original target before reconstruction admission',async t=>{
  const f=await fixture(t),staged=await f.stage();f.respond(()=>({...f.context(),creator:{status:'available',kind:'group',id:57,provenance:'game.CreatorType/CreatorId'}}));
  await assert.rejects(f.reconstruct(),refused('STUDIO_RECONSTRUCT_TARGET'));
  assert.equal(f.studio.readStageReconstruction(f.scope.projectId,JOB,staged.runId),null);
  assert.equal(f.studio.commands().filter(c=>c.method==='asset.reconstruct').length,0);
});

test('actor retirement after dispatch retains unknown reconstruction and never admits a replacement command',async t=>{
  const f=await fixture(t),staged=await f.stage();
  f.onReconstruction(()=>{f.incarnation.revokeGrant();return false;});
  await assert.rejects(f.reconstruct(),refused('NATIVE_ASSET_AUTHORITY'));
  const record=f.studio.readStageReconstruction(f.scope.projectId,JOB,staged.runId)!;
  assert.equal(record.command.state,'needs_reconciliation');assert.equal(record.receipt,null);
  f.incarnation.grant({connectionId:'fixture-connection',threadId:conversation.threadId});
  f.resetController();await assert.rejects(f.reconstruct(f.newActor()),refused('STUDIO_RECONSTRUCT_EXISTS'));
  assert.equal(f.studio.commands().filter(c=>c.method==='asset.reconstruct').length,1);
});

test('known successful reconstruction fact survives late native retirement without claiming current resources',async t=>{
  const f=await fixture(t),staged=await f.stage();
  f.onReconstruction(command=>{
    const a=command.args;f.studio.result({sessionId:command.sessionId,commandId:command.id,state:'succeeded',result:{runId:a.runId,
      transferDigest:(a.expected as {digest:string}).digest,state:'reconstructed',objects:a.objects,imported:false,engineVerification:'pending'}});
    f.incarnation.revokeGrant();return false;
  });
  await assert.rejects(f.reconstruct(),refused('NATIVE_ASSET_AUTHORITY'));
  assert.equal(f.studio.readStageReconstruction(f.scope.projectId,JOB,staged.runId)?.command.state,'succeeded');
  const status=await f.reconstructionStatus();assert.equal(status.reconstruction?.receipt?.runId,staged.runId);
  assert.equal(status.reconstruction?.currentResources,'unobserved');assert.equal(status.reconstruction?.imported,false);
});

test('backend restart retains detached reconstruction facts but cannot allocate again from old pairing',async t=>{
  const f=await fixture(t),staged=await f.stage(),result=await f.reconstruct();await f.restartBackend();
  const status=await f.reconstructionStatus();assert.equal(status.reconstruction?.commandId,result.commandId);
  assert.equal(status.reconstruction?.receipt?.runId,staged.runId);assert.equal(status.reconstruction?.currentResources,'unobserved');
  await assert.rejects(f.reconstruct(),refused('STUDIO_RECONSTRUCT_EXISTS'));
});

test('fresh native operation and advanced epoch append a CPU run and witnessed preparation without replay', async t => {
  const f = await fixture(t), first = await f.stage();
  const original = f.studio.readStageRun(f.scope.projectId, JOB)!;
  assert.equal(first.runId, original.runId);
  const preparationId = original.intent.preparationAttemptId!;
  const oldBytes = await readFile(join(f.root, 'preparations', preparationId + '.json'));
  f.loseBuffers();
  f.resetController();
  // Even a new capture cannot upgrade the same actual dispatched operation.
  await assert.rejects(f.stage(f.registry.capture(f.incarnation.credential(), 'mutate')), refused('NATIVE_ASSET_AUTHORITY'));
  const fresh = f.newActor(), second = await f.stage(fresh), latest = f.studio.readStageRun(f.scope.projectId, JOB)!;
  assert.notEqual(second.runId, first.runId); assert.equal(latest.attempt, 2); assert.equal(latest.previousRunId, first.runId);
  assert.equal(latest.intent.continuity.playEpoch, 1);
  assert.ok(second.commandIds.every(id => !first.commandIds.includes(id)));
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId, JOB, first.runId), original);
  assert.deepEqual(await readFile(join(f.root, 'preparations', preparationId + '.json')), oldBytes);
  const prepared = await f.ledger.get(fresh, JOB, f.guard, latest.intent.preparationAttemptId);
  assert.equal(prepared?.schemaVersion, 2); assert.equal(prepared?.preparationAttempt?.previousId, preparationId);
  assert.equal(prepared?.witness.playEpoch, 1);
  assert.equal((await f.status()).stage?.receiptScope, 'historical-cpu');
  assert.equal((await f.status()).stage?.currentBuffers, 'unobserved');
  await assert.rejects(f.stage(f.newActor()), refused('STUDIO_STAGE_EXISTS'));
});

test('one actual native operation stages two owned jobs sequentially but cannot repeat either across captures and controllers', async t => {
  const f = await fixture(t, false, Date.now, [JOB, SECOND_JOB]);
  const first = await f.stage(), original = f.studio.readStageRun(f.scope.projectId, JOB)!;
  const secondCapture = f.registry.capture(f.incarnation.credential(), 'mutate');
  const second = await f.stage(secondCapture, SECOND_JOB);
  assert.notEqual(first.runId, second.runId);
  assert.ok(second.commandIds.every(id => !first.commandIds.includes(id)));
  assert.equal(f.studio.readStageRun(f.scope.projectId, SECOND_JOB)?.attempt, 1);
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId, JOB), original);
  assert.deepEqual(f.counts(), {saved: 2, reads: 6});
  // A fresh plugin epoch does not refresh this SAME dispatched native turn.
  f.loseBuffers(); f.resetController();
  const before = f.counts();
  for (const id of [JOB, SECOND_JOB]) {
    await assert.rejects(f.stage(f.registry.capture(f.incarnation.credential(), 'mutate'), id), refused('NATIVE_ASSET_AUTHORITY'));
  }
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId, JOB), original);
  assert.equal(f.studio.readStageRun(f.scope.projectId, SECOND_JOB)?.runId, second.runId);
});

test('known context preflight failure can be repaired for the same job in the same actual native operation before any stage journal', async t => {
  const f = await fixture(t);
  f.respond(() => ({...f.context(), creator: {status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId'}}));
  await assert.rejects(f.stage(), refused('STUDIO_IMPORT_CREATOR'));
  assert.equal(f.studio.readStageRun(f.scope.projectId, JOB), null);
  assert.equal(f.studio.commands().some(command => command.method === 'asset.stage_packet'), false);
  assert.ok(f.studio.commands().every(command => command.method === 'scene.import_context' && command.state === 'succeeded'));
  assert.equal(await f.ledger.get(f.actor, JOB, f.guard), null);
  assert.deepEqual(f.counts(), {saved: 0, reads: 1});
  // Also repair a known final target mismatch AFTER a witnessed preparation
  // was saved, but still before ANY durable CPU run or stage command.
  f.respond(() => {
    const context = f.context();
    if (f.counts().reads >= 4) context.creator = {status: 'available', kind: 'group', id: 57, provenance: 'game.CreatorType/CreatorId'};
    return context;
  });
  await assert.rejects(f.stage(), refused('STUDIO_STAGE_TARGET'));
  assert.equal(f.studio.readStageRun(f.scope.projectId, JOB), null);
  assert.equal(f.studio.commands().some(command => command.method === 'asset.stage_packet'), false);
  const historical = await f.ledger.get(f.actor, JOB, f.guard);
  const file = join(f.root, 'preparations', historical!.preparationAttempt!.id + '.json'), bytes = await readFile(file);
  f.respond(f.context); f.resetController();
  const staged = await f.stage(f.registry.capture(f.incarnation.credential(), 'mutate'));
  assert.equal(staged.imported, false); assert.equal(staged.state, 'sealed');
  assert.equal(f.studio.readStageRun(f.scope.projectId, JOB)?.attempt, 1);
  const latest = await f.ledger.get(f.actor, JOB, f.guard);
  assert.equal(latest?.preparationAttempt?.previousId, historical?.preparationAttempt?.id);
  assert.equal(latest?.witness.playEpoch, historical?.witness.playEpoch);
  assert.deepEqual(await readFile(file), bytes);
});

test('Transport-equivalent re-pair retains lifetime and epoch with a fresh paired session and immutable history', async t => {
  const f = await fixture(t), first = await f.stage(), original = f.studio.readStageRun(f.scope.projectId, JOB)!;
  const oldId = original.intent.preparationAttemptId!, bytes = await readFile(join(f.root, 'preparations', oldId + '.json'));
  const fresh = f.rePair();
  await assert.rejects(f.stage(f.actor), refused('NATIVE_ASSET_AUTHORITY'));
  const second = await f.stage(fresh), next = f.studio.readStageRun(f.scope.projectId, JOB)!;
  assert.notEqual(second.runId, first.runId); assert.notEqual(next.intent.target.sessionId, original.intent.target.sessionId);
  assert.equal(next.intent.continuity.clientLifetimeId, original.intent.continuity.clientLifetimeId);
  assert.equal(next.intent.continuity.playEpoch, original.intent.continuity.playEpoch);
  assert.notEqual(next.intent.manifestDigest, original.intent.manifestDigest);
  assert.deepEqual(await readFile(join(f.root, 'preparations', oldId + '.json')), bytes);
  const previous = await f.ledger.get(fresh, JOB, f.guard, oldId), current = await f.ledger.get(fresh, JOB, f.guard, next.intent.preparationAttemptId);
  assert.equal(previous?.prepared.manifest.target.sessionId, original.intent.target.sessionId);
  assert.equal(current?.prepared.manifest.target.sessionId, next.intent.target.sessionId);
  assert.deepEqual(current?.prepared.manifest.files, previous?.prepared.manifest.files);
  assert.ok(first.commandIds.every(id => f.studio.command(id).state === 'succeeded'));
});

test('unknown same-continuity stage cannot repeat and re-pair never touches an unknown upload journal',async t=>{
  const f=await fixture(t);
  f.onStage(()=>{f.incarnation.ended('fixture-intent');return false;});
  await assert.rejects(f.stage(),refused('NATIVE_ASSET_AUTHORITY'));
  const unknown=f.studio.readStageRun(f.scope.projectId,JOB)!;
  assert.equal(unknown.phase,'needs_reconciliation');assert.equal(unknown.receipt,null);
  const before=f.counts();await assert.rejects(f.stage(f.newActor()),refused('STUDIO_STAGE_EXISTS'));assert.deepEqual(f.counts(),before);
  const uploadId='44444444-4444-4444-8444-444444444444';
  const ticket=f.studio.beginAssetUpload(uploadId,{projectId:f.scope.projectId,jobId:JOB,sourceId:'render-export',sourceSha256:'c'.repeat(64),assetType:'Mesh',
    sessionId:f.paired.sessionId,clientLifetimeId:'fixture-plugin',pluginArtifactHash:HASH,playEpoch:0,placeId:12,universeId:34,
    creator:{kind:'group',id:56},uploaderId:1234,rightsGrantId:'fixture-rights-correlation',name:'Fixture mesh',description:'Synthetic journal facts only'},()=>{});
  assert.ok(ticket.ticket);f.studio.finishAssetUpload(ticket.ticket,{state:'needs_reconciliation',assetId:null});
  const journal=f.studio.assetUpload(uploadId);
  f.loseBuffers();f.onStage(()=>true);await assert.rejects(f.stage(f.newActor()),refused('RECONCILIATION'));
  const result=await f.stage(f.rePair());
  assert.notEqual(result.runId,unknown.runId);assert.equal(result.imported,false);
  assert.deepEqual(f.studio.assetUpload(uploadId),journal);
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId,JOB,unknown.runId),unknown);
});

test('delivered unknown CPU attempt never refunds its same-job native claim across controller replacement and re-pair',async t=>{
  const f=await fixture(t);f.onStage(()=>{f.resetController();return false;});
  await assert.rejects(f.stage(),refused('STUDIO_STAGE_SCOPE'));
  const unknown=f.studio.readStageRun(f.scope.projectId,JOB)!;assert.equal(unknown.phase,'needs_reconciliation');
  assert.equal(unknown.commands[0]?.command.state,'needs_reconciliation');
  const before=f.counts(),sameOperation=f.rePair(false);
  await assert.rejects(f.stage(sameOperation),refused('NATIVE_ASSET_AUTHORITY'));
  assert.deepEqual(f.counts(),before);
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId,JOB,unknown.runId),unknown);
});

test('actual backend restart reopens immutable preparations and requires a fresh actor and pairing',async t=>{
  const f=await fixture(t),first=await f.stage(),oldActor=f.actor,run=f.studio.readStageRun(f.scope.projectId,JOB)!;
  const file=join(f.root,'preparations',run.intent.preparationAttemptId!+'.json'),before=await readFile(file);
  const source=join(f.root,'outputs','test-kit-'+JOB,'asset.glb'),sourceBefore=await readFile(source);
  const fresh=await f.restartBackend();
  await assert.rejects(f.stage(oldActor),refused('NATIVE_ASSET_AUTHORITY'));
  const second=await f.stage(fresh),next=f.studio.readStageRun(f.scope.projectId,JOB)!;
  assert.notEqual(second.runId,first.runId);assert.equal(next.previousRunId,first.runId);
  assert.notEqual(next.intent.target.sessionId,run.intent.target.sessionId);
  assert.equal(next.intent.continuity.clientLifetimeId,run.intent.continuity.clientLifetimeId);
  assert.equal(next.intent.continuity.playEpoch,run.intent.continuity.playEpoch);
  assert.deepEqual(await readFile(file),before);assert.deepEqual(await readFile(source),sourceBefore);
  assert.deepEqual(f.studio.readStageRun(f.scope.projectId,JOB,first.runId),run);
  const prepared=await f.ledger.get(fresh,JOB,f.guard,next.intent.preparationAttemptId);
  assert.equal(prepared?.preparationAttempt?.previousId,run.intent.preparationAttemptId);
  assert.equal((await f.status()).stage?.currentBuffers,'unobserved');
});

test('retired same native capture stops a delivered packet and retains its unknown outcome without replay', async t => {
  const f = await fixture(t); let attempted: StudioCommand | null = null;
  f.onStage(command => {attempted = command; f.incarnation.revokeGrant(); return false;});
  await assert.rejects(f.stage(), refused('NATIVE_ASSET_AUTHORITY'));
  assert.ok(attempted);
  assert.equal(f.studio.command((attempted as StudioCommand).id).state, 'needs_reconciliation');
  assert.equal(f.studio.poll(f.paired.sessionId, f.proof()).length, 0);
  const status=await f.status();assert.equal(status.stage?.phase,'needs_reconciliation');
  assert.equal(status.stage?.commands[0]?.commandId,(attempted as StudioCommand).id);assert.equal(status.stage?.receipt,null);
});

test('stage status needs exact current read actor/job binding and performs no target reads',async t=>{
  const f=await fixture(t),before=f.counts();assert.equal((await f.status()).stage,null);assert.deepEqual(f.counts(),before);
  await assert.rejects(f.status({kind:'native-asset-actor'}),refused('NATIVE_ASSET_AUTHORITY'));
  await assert.rejects(f.status(undefined,'22222222-2222-4222-8222-222222222222'),refused('NOT_FOUND'));
  const foreign=f.registry.issue();foreign.seal({connectionId:'foreign-connection',provider:'codex',threadId:'foreign-thread',sessionId:null});
  await assert.rejects(f.status(f.registry.capture(foreign.credential(),'read')),refused('NOT_FOUND'));
  const old=f.registry.capture(f.incarnation.credential(),'read');f.incarnation.revokeGrant();
  await assert.rejects(f.status(old),refused('NATIVE_ASSET_AUTHORITY'));assert.equal((await f.status()).stage,null);
  assert.deepEqual(f.counts(),before);
});

test('creator change after preparation is refused before any binary staging command', async t => {
  const f = await fixture(t);
  f.respond(() => {
    const context = f.context();
    if (f.counts().reads >= 3) context.creator = {status: 'available', kind: 'group', id: 57, provenance: 'game.CreatorType/CreatorId'};
    return context;
  });
  await assert.rejects(f.stage(), refused('STUDIO_STAGE_TARGET'));
  assert.equal(f.studio.commands().some(command => command.method === 'asset.stage_packet'), false);
});

test('unpublished target uses only the actually observed Studio user', async t => {
  const f = await fixture(t, true), prepared = await f.prepare();
  assert.deepEqual(prepared.manifest.target.creator, { kind: 'user', id: '1234' });
  assert.deepEqual(f.counts(), { saved: 1, reads: 2 });
});

test('a second live pairing is ambiguous even when its plugin lacks the new capability', async t => {
  const f = await fixture(t); f.pair('older-plugin', ['scene.children']);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_AMBIGUOUS'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('all authoritative pairings are considered beyond the display page', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 102; i++) { const p = f.pair('revoked-' + i, ['scene.children']); f.studio.revoke(p.sessionId, 'fixture'); }
  // These synchronous fixture writes can outlast the normal freshness window
  // on Windows. Deliver the synthetic plugin's heartbeat after setup; rowid
  // ordering must still leave this live pairing beyond the display page.
  f.studio.poll(f.paired.sessionId, f.proof());
  assert.equal(f.studio.sessions().some(s => s.id === f.paired.sessionId), false);
  assert.equal(f.studio.activeSessions().length, 1);
  const selected = await f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard);
  assert.equal(selected.target.sessionId, f.paired.sessionId); f.host.hooks.releaseTarget?.(f.scope, JOB);
});

test('the same authoritative pairing is still refused once its production freshness window expires', async t => {
  const f = await fixture(t, false, () => Date.now() + 31_000);
  assert.equal(f.studio.activeSessions().length, 1);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_TARGET'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('changed creator between the initial and confirmation reads is refused without a saved record', async t => {
  const f = await fixture(t); f.respond(() => {
    const context = f.context();
    if (f.counts().reads >= 2) context.creator = { status: 'available', kind: 'group', id: 57, provenance: 'game.CreatorType/CreatorId' };
    return context;
  });
  await assert.rejects(f.prepare(), refused('STUDIO_IMPORT_CONTINUITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 2 }); assert.equal(await f.ledger.get(f.actor, JOB, f.guard), null);
});

test('Play mode is refused before any context command or pending record', async t => {
  const f = await fixture(t); f.hold(); f.studio.poll(f.paired.sessionId, f.proof(HASH, 'Play', 1));
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_CONTINUITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('unbound jobs and stale native captures cannot select a target', async t => {
  const f = await fixture(t);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, '22222222-2222-4222-8222-222222222222', f.actor, f.guard), refused('NOT_FOUND'));
  f.incarnation.revokeGrant();
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('NATIVE_ASSET_AUTHORITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('host shutdown fences a pending context read without manufacturing a receipt', async t => {
  const f = await fixture(t); f.hold();
  const pending = f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard);
  await new Promise(resolve => setTimeout(resolve, 5)); f.host.close();
  await assert.rejects(Promise.resolve(pending), refused('STUDIO_IMPORT_SCOPE')); assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});
