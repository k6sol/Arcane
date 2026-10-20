import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, realpath, rm, readFile, writeFile, readdir, lstat, open, link } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import type { AssetConversationProvider, AssetConversation } from '../../packages/protocol/src/asset-conversation.js';
import type { StudioImportContextObservation } from '../../packages/protocol/src/studio.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { adaptCompletedStudioImport, assertStudioImportJobScope } from '../../apps/daemon/src/asset-import-adapter.js';
import { createNativeAssetRegistry, type NativeAssetActor } from '../../apps/daemon/src/native-asset-authority.js';
import { createStudioImportPreparationStore, STUDIO_IMPORT_PREPARATION_LIMITS, type StudioImportPreparationStore } from '../../apps/daemon/src/studio-import-preparation-store.js';
import { parseNativeStudioImportResponse } from '../../packages/asset-pipeline/src/studio-import-wire.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import { createStudioImportManifestAuthority, type PreparedStudioImport, type StudioImportSelection } from '../../packages/asset-pipeline/src/studio-import-manifest.js';

// Real filesystem, SQLite Studio receipts, CWS, registry and production prepared
// codec. All pairings, observations and exported bytes are synthetic and local;
// no Studio/SDK/provider/Blender process or credential file is accessed.
const JOB = '11111111-1111-4111-8111-111111111111', NEXT = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64), THREAD = { provider: 'codex' as const, threadId: 'preparation-fixture-thread', sessionId: null };
const guard = () => {};
const refused = (code: string) => (error: unknown) => error instanceof ArcaneError && error.code === code;
const code = (suffix: string) => refused('STUDIO_IMPORT_PREPARATION_' + suffix);
function gate() { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; }

async function fixture(t: test.TestContext, local = false, provider: AssetConversationProvider = 'codex') {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-preparation-store-')), projectPath = await realpath(root);
  let now = Date.now(), epoch = 0;
  const cws = new ConversationWorkStore({ directory: join(root, 'bindings'), projectPath });
  const conversation:AssetConversation=provider==='codex'?THREAD:{provider,threadId:'app:55555555-5555-4555-8555-555555555555',sessionId:null};
  cws.bind({ kind: 'asset-job', id: JOB, conversation }); cws.bind({ kind: 'asset-job', id: NEXT, conversation });
  const registry = createNativeAssetRegistry({ projectPath }), incarnation = registry.issue(), binding = { connectionId: 'fixture-connection', threadId: conversation.threadId };
  if(provider==='codex')incarnation.seal({ ...binding, ...THREAD });
  else if(provider==='claude-code')incarnation.bindAppConversation({kind:'app-conversation',connectionId:binding.connectionId,provider,conversationId:conversation.threadId.slice(4),transport:{kind:'claude-code-process',incarnationId:'fixture-process',nativeSessionId:null}});
  else incarnation.bindAppConversation({kind:'app-conversation',connectionId:binding.connectionId,provider,conversationId:conversation.threadId.slice(4),transport:{kind:'arcane-gateway-loop',incarnationId:'fixture-loop'}});
  incarnation.grant(binding); incarnation.dispatched({ ...binding, operationId: 'fixture-intent' });
  const actor = registry.capture(incarnation.credential(), 'mutate');
  const studio = new StudioStore({ directory: join(root, 'studio-state'), now: () => now });
  const grant = studio.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = studio.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'fixture-plugin-lifetime',
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, name: 'Synthetic preparation receipts', pluginVersion: 'fixture' }, capabilities: ['scene.import_context', 'selection.read'] });
  const observation: StudioImportContextObservation = { sessionId: pair.sessionId, root: 'Workspace',
    parentRef: { instanceId: 'fixture-workspace', sessionId: pair.sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace' },
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
    creator: local ? { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' }
      : { status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId' },
    studioUser: local ? { status: 'available', id: 78, provenance: 'StudioService:GetUserId' }
      : { status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId' } };
  function heartbeat(mode: 'Edit' | 'Play' = 'Edit', playEpoch = epoch) {
    return { sessionId: pair.sessionId, clientLifetimeId: 'fixture-plugin-lifetime', pluginArtifactHash: HASH,
      markerName: 'ArcaneTestProof_fixture', placeId: observation.placeId, universeId: observation.universeId,
      placeName: 'Synthetic preparation receipts', mode, playEpoch, continuitySupported: true, connected: true };
  }
  function receipt(value: StudioImportContextObservation = observation) {
    const queued = studio.enqueue({ sessionId: pair.sessionId, requestId: 'fixture-context-' + randomUUID(), method: 'scene.import_context', args: {} });
    assert.equal(studio.poll(pair.sessionId, heartbeat())[0]!.id, queued.id);
    studio.result({ sessionId: pair.sessionId, commandId: queued.id, state: 'succeeded', result: value }); return queued.id;
  }
  const witness = { initialContextReceiptId: receipt(), confirmedContextReceiptId: receipt(), pluginArtifactHash: HASH,
    clientLifetimeId: 'fixture-plugin-lifetime', playEpoch: 0 };
  const outputRoot = join(root, 'outputs'); await mkdir(outputRoot);
  const sources = new Map<string, { manifest: Awaited<ReturnType<typeof saveStudioFixture>>; exports: Map<'asset.glb' | 'collision.glb', Buffer> }>();
  async function sourceFor(job: string) {
    const existing = sources.get(job); if (existing) return existing;
    assert.ok(job === JOB || job === NEXT);
    const directory = join(outputRoot, 'test-kit-' + job); await mkdir(directory);
    const manifest = await saveStudioFixture(directory, job), exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
    for (const name of ['asset.glb', 'collision.glb'] as const) exports.set(name, await readFile(join(directory, name)));
    const source = { manifest, exports }; sources.set(job, source); return source;
  }
  let studsPerMeter = 1 / 0.28, parentRef = 'fixture-workspace';
  const selection = (): StudioImportSelection => ({ target: { sessionId: pair.sessionId, placeId: observation.placeId, universeId: observation.universeId,
      root: 'Workspace', parentRef, creator: local ? { kind: 'user', id: '78' } : { kind: 'group', id: '56' } },
      placement: { mode: 'bottom-centre' }, studsPerMeter });
  // Exercise the production adapter/authority on the unchanged real GLB bytes,
  // without repeating AssetService's full artifact inventory in every fence setup.
  // The dedicated equivalence case below retains that actual service integration.
  async function directPrepared(jobId: string): Promise<PreparedStudioImport> {
    const scope = assertStudioImportJobScope(projectPath, cws, actor, jobId), source = await sourceFor(jobId);
    const generated = adaptCompletedStudioImport(source.manifest, source.exports, scope.projectId, selection(), null);
    const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async requested => {
      assert.equal(requested, jobId); assertStudioImportJobScope(projectPath, cws, actor, jobId); return generated;
    } });
    try {
      const admission = await authority.admit(jobId); assertStudioImportJobScope(projectPath, cws, actor, jobId);
      return authority.prepare(admission);
    } finally { authority.close(); }
  }
  let assets: Awaited<ReturnType<typeof createAssetService>> | undefined;
  async function servicePrepared(jobId: string): Promise<PreparedStudioImport> {
    // The real service equivalence case still sees the complete two-job disk
    // inventory at startup. Other fences need only their requested export.
    if (!assets) for (const job of [JOB, NEXT]) await sourceFor(job);
    assets ??= await createAssetService({ cwd: projectPath, projectPath, outputRoot,
      studioImport: { workAssociations: cws, selectTarget: selection } });
    return assets.prepareStudioImport(jobId, actor);
  }
  const prepared = await directPrepared(JOB);
  const directory = join(root, 'preparations'), options = { projectPath, directory, workAssociations: cws, studio, now: () => now };
  let store: StudioImportPreparationStore | undefined; const releases: (() => void)[] = [];
  t.after(async () => {
    releases.forEach(release => release()); t.mock.restoreAll(); syncBuiltinESMExports();
    await store?.close().catch(error => { if (!code('LOCKED')(error) && !code('PATH')(error)) throw error; });
    await assets?.close(); cws.close(); registry.close(); studio.close();
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-preparation-store-') && !isAbsolute(part) && !part.startsWith('..' + sep));
    assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true, force: true });
  });
  return { root, options, actor, prepared, witness, cws, registry, incarnation, studio, pair, observation, receipt,
    nextWitness() { epoch++; studio.poll(pair.sessionId, heartbeat()); return {...witness,initialContextReceiptId:receipt(),confirmedContextReceiptId:receipt(),playEpoch:epoch}; },
    directPrepared, servicePrepared, assetServiceCreated: () => assets !== undefined,
    async nextPrepared() { return directPrepared(NEXT); },
    async create(limits?: Parameters<typeof createStudioImportPreparationStore>[0]['limits']) { store = await createStudioImportPreparationStore({ ...options, ...(limits ? { limits } : {}) }); return store; },
    advance(ms: number) { now += ms; }, play() { studio.poll(pair.sessionId, heartbeat('Play', 1)); },
    async changedPrepared() { studsPerMeter = 4; return directPrepared(JOB); },
    async changedTarget() { parentRef = 'fixture-other-workspace'; return directPrepared(JOB); },
    holdRead() {
      t.signal.throwIfAborted();
      const entered = gate(), resume = gate(), original = fs.opendir; let held = false; releases.push(resume.release);
      t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
        const result = await original(...args); if (!held && String(args[0]) === directory) { held = true; entered.release(); await resume.promise; } return result;
      }); syncBuiltinESMExports(); return { entered: entered.promise, release: resume.release };
    },
    transition(which: 'regrant' | 'new-intent' | 'retire' | 'registry-close' | 'cws-close') {
      if (which === 'registry-close') { registry.close(); return; } if (which === 'cws-close') { cws.close(); return; }
      if (which === 'retire') { incarnation.retire(); return; }
      if (which === 'regrant') { incarnation.revokeGrant(); incarnation.grant(binding); } else incarnation.ended('fixture-intent');
      incarnation.dispatched({ ...binding, operationId: 'fixture-next-intent' });
    },
  };
}

test('direct production fixture preparation equals real AssetService for both jobs, scale and target changes', async t => {
  const f = await fixture(t); assert.equal(f.assetServiceCreated(), false);
  async function equivalent(jobId: string) {
    const direct = await f.directPrepared(jobId), service = await f.servicePrepared(jobId);
    assert.deepEqual(service, direct);
    assert.equal(service.digest, direct.digest); assert.equal(service.manifest.digest, direct.manifest.digest);
    assert.equal(service.delta.nextDigest, direct.delta.nextDigest); assert.equal(service.manifest.revisionId, jobId);
    return direct;
  }
  assert.deepEqual(await equivalent(JOB), f.prepared); await equivalent(NEXT);
  assert.equal(f.assetServiceCreated(), true);
  const scaled = await f.changedPrepared(); assert.notEqual(scaled.digest, f.prepared.digest);
  assert.equal(scaled.manifest.conversion.studsPerMeter, 4);
  assert.deepEqual(await equivalent(JOB), scaled); await equivalent(NEXT);
  const targeted = await f.changedTarget(); assert.notEqual(targeted.digest, scaled.digest);
  assert.equal(targeted.manifest.target.parentRef, 'fixture-other-workspace');
  assert.deepEqual(await equivalent(JOB), targeted); await equivalent(NEXT);
});

test('explicit preparation attempts preserve originals and share the hard record cap',async t=>{
  const f=await fixture(t),store=await f.create({records:2});
  await store.save(f.actor,JOB,f.prepared,f.witness,guard);
  const original=await readFile(join(f.options.directory,JOB+'.json'));
  const attempt='33333333-3333-4333-8333-333333333333';
  await store.saveAttempt(f.actor,JOB,attempt,f.prepared,f.witness,guard);
  const record=await store.get(f.actor,JOB,guard,attempt);assert.equal(record?.schemaVersion,4);assert.equal(record?.preparationAttempt?.previousId,JOB);
  assert.deepEqual(await readFile(join(f.options.directory,JOB+'.json')),original);
  await assert.rejects(store.get(f.actor,NEXT,guard,attempt),code('SCOPE'));
  const next=f.nextWitness();
  await assert.rejects(store.saveAttempt(f.actor,JOB,'44444444-4444-4444-8444-444444444444',f.prepared,next,guard),code('LIMIT'));
  assert.deepEqual((await readdir(f.options.directory)).filter(n=>n.endsWith('.json')&&n!=='preparation-owner.json').sort(),[JOB+'.json',attempt+'.json'].sort());
  assert.deepEqual(await readFile(join(f.options.directory,JOB+'.json')),original);
});

test('preparation store consumes actual prepared codec and two real synthetic StudioStore receipts; immutable metadata survives reopen', async t => {
  const f = await fixture(t), store = await f.create(); assert.equal(await store.get(f.actor, JOB, guard), null);
  await store.save(f.actor, JOB, f.prepared, f.witness, guard); const path = join(f.options.directory, JOB + '.json'), before = await readFile(path);
  const record = await store.get(f.actor, JOB, guard); assert.ok(record);
  assert.equal(record.engineVerification, 'pending'); assert.equal(record.prepared.manifest.engineVerification, 'pending');
  assert.equal(record.contextReads.creatorProvenance, 'game.CreatorType/CreatorId'); assert.deepEqual(record.witness, f.witness);
  assert.deepEqual(parseNativeStudioImportResponse({ prepared: record.prepared }, JOB).prepared, f.prepared);
  assert.equal(Object.isFrozen(record), true); assert.equal(Object.isFrozen(record.prepared.delta.objects[0]), true);
  assert.throws(() => Object.assign(record.prepared.manifest.target, { placeId: 999 }));
  await store.save(f.actor, JOB, structuredClone(f.prepared), { ...f.witness }, guard); assert.deepEqual(await readFile(path), before);
  const text = before.toString(); for (const excluded of [f.options.projectPath, f.incarnation.credential(), f.pair.token, 'native-asset-actor', 'executable', 'projectPath', 'baseline']) assert.equal(text.includes(excluded), false, excluded);
  await store.close(); assert.equal((await readdir(f.options.directory)).includes('preparation-owner.json'), false);
  const reopened = await f.create(); assert.deepEqual(await reopened.get(f.actor, JOB, guard), record);
  const readonly = f.registry.capture(f.incarnation.credential(), 'read'); assert.deepEqual(await reopened.get(readonly, JOB, guard), record);
  await assert.rejects(reopened.save(readonly, JOB, f.prepared, f.witness, guard), refused('NATIVE_ASSET_AUTHORITY'));
});

for(const provider of ['claude-code','arcane'] as const)test(provider+' preparation writes preserve the durable app anchor in new immutable versions',async t=>{
  const f=await fixture(t,false,provider),store=await f.create();
  await store.save(f.actor,JOB,f.prepared,f.witness,guard);
  const root=await store.get(f.actor,JOB,guard);assert.equal(root?.schemaVersion,3);
  assert.deepEqual(root?.conversation,{provider,threadId:'app:55555555-5555-4555-8555-555555555555',sessionId:null});
  const path=join(f.options.directory,JOB+'.json'),before=await readFile(path);
  const attempt='33333333-3333-4333-8333-333333333333';await store.saveAttempt(f.actor,JOB,attempt,f.prepared,f.witness,guard);
  assert.equal((await store.get(f.actor,JOB,guard,attempt))?.schemaVersion,4);
  await store.close();const reopened=await f.create();
  assert.deepEqual((await reopened.get(f.actor,JOB,guard,attempt))?.conversation,root?.conversation);
  assert.deepEqual(await readFile(path),before);
});
function canonicalRecord(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalRecord).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalRecord((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
test('legacy v1 and v2 preparation files reopen byte-for-byte while subsequent attempts use v4',async t=>{
  const f=await fixture(t),store=await f.create(),attempt='33333333-3333-4333-8333-333333333333';
  await store.save(f.actor,JOB,f.prepared,f.witness,guard);await store.saveAttempt(f.actor,JOB,attempt,f.prepared,f.witness,guard);await store.close();
  const before=new Map<string,Buffer>();
  for(const [id,schemaVersion]of [[JOB,1],[attempt,2]] as const){
    const path=join(f.options.directory,id+'.json');
    const {recordSha256:_old,...content}=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
    content.schemaVersion=schemaVersion;
    const record={...content,recordSha256:createHash('sha256').update(canonicalRecord(content)).digest('hex')};
    await writeFile(path,JSON.stringify(record));before.set(path,await readFile(path));
  }
  const reopened=await f.create();assert.equal((await reopened.get(f.actor,JOB,guard))?.schemaVersion,1);
  assert.equal((await reopened.get(f.actor,JOB,guard,attempt))?.schemaVersion,2);
  const next='44444444-4444-4444-8444-444444444444';await reopened.saveAttempt(f.actor,JOB,next,f.prepared,f.nextWitness(),guard);
  assert.equal((await reopened.get(f.actor,JOB,guard,next))?.schemaVersion,4);
  for(const [path,bytes]of before)assert.deepEqual(await readFile(path),bytes);
});
test('legacy preparation versions cannot claim an app provider even with a matching recomputed record hash',async t=>{
  const f=await fixture(t,false,'arcane'),store=await f.create();await store.save(f.actor,JOB,f.prepared,f.witness,guard);await store.close();
  const path=join(f.options.directory,JOB+'.json'),{recordSha256:_old,...content}=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
  content.schemaVersion=1;await writeFile(path,JSON.stringify({...content,recordSha256:createHash('sha256').update(canonicalRecord(content)).digest('hex')}));
  await assert.rejects(f.create(),code('CORRUPT'));
});
test('preparation store records local-user provenance only from two actual triple-zero context receipts', async t => {
  const f = await fixture(t, true), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  assert.equal((await store.get(f.actor, JOB, guard))!.contextReads.creatorProvenance, 'StudioService:GetUserId');
});

test('receipt witness rejects invented IDs, wrong session/hash/lifetime/epoch, same receipt and changed observed roots/creators', async t => {
  const f = await fixture(t), store = await f.create();
  const changed = f.receipt({ ...f.observation, parentRef: { ...f.observation.parentRef, instanceId: 'other-root' } });
  for (const witness of [{ ...f.witness, initialContextReceiptId: randomUUID() }, { ...f.witness, confirmedContextReceiptId: randomUUID() },
    { ...f.witness, confirmedContextReceiptId: f.witness.initialContextReceiptId }, { ...f.witness, pluginArtifactHash: 'b'.repeat(64) },
    { ...f.witness, clientLifetimeId: 'foreign-lifetime' }, { ...f.witness, playEpoch: 1 }, { ...f.witness, confirmedContextReceiptId: changed }])
    await assert.rejects(store.save(f.actor, JOB, f.prepared, witness, guard));
  assert.deepEqual(await readdir(f.options.directory), ['preparation-owner.json']);
  const wrongMethod = f.studio.enqueue({ sessionId: f.pair.sessionId, requestId: 'wrong-method', method: 'selection.read', args: {} });
  assert.equal(f.studio.poll(f.pair.sessionId)[0]!.id, wrongMethod.id);
  f.studio.result({ sessionId: f.pair.sessionId, commandId: wrongMethod.id, state: 'succeeded', result: {} });
  await assert.rejects(store.save(f.actor, JOB, f.prepared, { ...f.witness, confirmedContextReceiptId: wrongMethod.id }, guard), refused('SCOPE'));
});

test('receipt witness refuses expired continuity and Play epoch; it never promotes engine verification', async t => {
  const f = await fixture(t), store = await f.create(); f.advance(6001);
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, guard), code('WITNESS'));
  assert.deepEqual(await readdir(f.options.directory), ['preparation-owner.json']);
});
test('receipt witness refuses an actual Play heartbeat', async t => {
  const f = await fixture(t), store = await f.create(); f.play();
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, guard), code('WITNESS'));
});

for (const operation of ['save', 'get'] as const) for (const transition of ['regrant', 'new-intent', 'retire', 'registry-close', 'cws-close'] as const)
  test('preparation ' + operation + ' fences the same actor and binding across awaited filesystem ' + transition, { timeout: 30000 }, async t => {
    const started = performance.now(), phases = [{phase:'fixture',elapsedMs:0}]; let completed = false, operationSignal:AbortSignal|undefined;
    const phase = (name:string) => phases.push({phase:name,elapsedMs:Math.round(performance.now()-started)});
    t.after(()=>{if(!completed)t.diagnostic('Preparation fence phases: '+JSON.stringify({operation,transition,setupTimeoutMs:30000,timeoutMs:8000,aborted:operationSignal?.aborted??t.signal.aborted,phases}));});
    const f = await fixture(t); phase('open-store'); const store = await f.create(); phase('store-ready');
    if (operation === 'get') { await store.save(f.actor, JOB, f.prepared, f.witness, guard); phase('initial-save-ready'); }
    // Native fixture setup has a separate budget; the awaited authority fence
    // keeps its original eight-second deadline and every refusal assertion.
    await t.test('refuses the changed authority', {timeout:8000}, async fence => {
      operationSignal=fence.signal;
      const hold = f.holdRead(), pending = operation === 'save' ? store.save(f.actor, JOB, f.prepared, f.witness, guard) : store.get(f.actor, JOB, guard);
      phase('await-held-filesystem');
      const denied = assert.rejects(pending, transition === 'cws-close' ? refused('CONVERSATION_WORK_CLOSED') : refused('NATIVE_ASSET_AUTHORITY'));
      await hold.entered; phase('filesystem-held'); f.transition(transition); hold.release(); phase('authority-changed'); await denied; phase('refusal-observed');
      assert.equal((await readdir(f.options.directory)).includes(JOB + '.json'), operation === 'get');
      completed = true;
    });
  });

test('trusted target/service/deadline guard fences awaits and asynchronous or boolean guards never authorize storage', async t => {
  const f = await fixture(t), store = await f.create(), hold = f.holdRead(); let expired = false;
  const pending = store.save(f.actor, JOB, f.prepared, f.witness, () => { if (expired) throw new ArcaneError('STUDIO_IMPORT_TIMEOUT', 'Synthetic deadline'); });
  const denied = assert.rejects(pending, refused('STUDIO_IMPORT_TIMEOUT')); await hold.entered; expired = true; hold.release(); await denied;
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, () => false), code('GUARD'));
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, async () => {}), code('GUARD'));
  assert.equal((await readdir(f.options.directory)).includes(JOB + '.json'), false);
});

test('forged, foreign-conversation and unbound actors cannot read or write metadata', async t => {
  const f = await fixture(t), store = await f.create(), forged = { kind: 'native-asset-actor' } as NativeAssetActor;
  await assert.rejects(store.get(forged, JOB, guard), refused('NATIVE_ASSET_AUTHORITY'));
  const foreign = f.registry.issue(); foreign.seal({ connectionId: 'foreign', provider: 'codex', threadId: 'foreign-thread', sessionId: null });
  foreign.grant({ connectionId: 'foreign', threadId: 'foreign-thread' }); foreign.dispatched({ connectionId: 'foreign', threadId: 'foreign-thread', operationId: 'foreign-intent' });
  await assert.rejects(store.save(f.registry.capture(foreign.credential(), 'mutate'), JOB, f.prepared, f.witness, guard), refused('NOT_FOUND'));
  await assert.rejects(store.get(f.actor, randomUUID(), guard), refused('NOT_FOUND'));
  for (const id of [JOB + '\n', '../job', 'job']) await assert.rejects(store.get(f.actor, id, guard), code('INPUT'));
});

test('strict codec and witness data reject extra fields/getters before files or receipt authority are changed', async t => {
  const f = await fixture(t), store = await f.create(); let reads = 0;
  const witness = Object.defineProperty({ ...f.witness }, 'clientLifetimeId', { enumerable: true, get() { reads++; return 'injected'; } });
  await assert.rejects(store.save(f.actor, JOB, f.prepared, witness, guard), code('INPUT'));
  for (const value of [{ ...f.prepared, credential: 'injected' }, { ...f.prepared, status: 'accepted' },
    { ...f.prepared, manifest: { ...f.prepared.manifest, engineVerification: 'accepted' } }, { ...f.prepared, digest: 'f'.repeat(64) }])
    await assert.rejects(store.save(f.actor, JOB, value as PreparedStudioImport, f.witness, guard), refused('STUDIO_IMPORT_RESPONSE'));
  const extraWitness = { ...f.witness, target: 'forged' };
  await assert.rejects(store.save(f.actor, JOB, f.prepared, extraWitness, guard), code('INPUT'));
  assert.equal(reads, 0); assert.deepEqual(await readdir(f.options.directory), ['preparation-owner.json']);
});

test('two fresh real StudioStore receipt pairs for identical prepared data succeed without rewriting the first pending record', async t => {
  const f = await fixture(t), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const path = join(f.options.directory, JOB + '.json'), before = await readFile(path), pin = await lstat(path, { bigint: true });
  f.advance(1); const fresh = { ...f.witness, initialContextReceiptId: f.receipt(), confirmedContextReceiptId: f.receipt() };
  await store.save(f.actor, JOB, structuredClone(f.prepared), fresh, guard);
  assert.deepEqual(await readFile(path), before); const after = await lstat(path, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.mtimeNs, after.ctimeNs], [pin.dev, pin.ino, pin.mtimeNs, pin.ctimeNs]);
  const retained = await store.get(f.actor, JOB, guard); assert.deepEqual(retained!.witness, f.witness); assert.equal(retained!.engineVerification, 'pending');
  await assert.rejects(store.save(f.actor, JOB, f.prepared, { ...fresh, confirmedContextReceiptId: randomUUID() }, guard));
  f.advance(6001); await assert.rejects(store.save(f.actor, JOB, f.prepared, fresh, guard), code('WITNESS'));
  assert.deepEqual(await readFile(path), before);
});

test('incoming changed production prepared data or target conflicts even with independently valid fresh StudioStore witnesses', async t => {
  const f = await fixture(t), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const path = join(f.options.directory, JOB + '.json'), before = await readFile(path);
  const changed = await f.changedPrepared(), fresh = { ...f.witness, initialContextReceiptId: f.receipt(), confirmedContextReceiptId: f.receipt() };
  await assert.rejects(store.save(f.actor, JOB, changed, fresh, guard), code('CONFLICT'));
  const target = await f.changedTarget(), context = { ...f.observation, parentRef: { ...f.observation.parentRef, instanceId: 'fixture-other-workspace' } };
  const targetWitness = { ...f.witness, initialContextReceiptId: f.receipt(context), confirmedContextReceiptId: f.receipt(context) };
  await assert.rejects(store.save(f.actor, JOB, target, targetWitness, guard), code('CONFLICT'));
  assert.deepEqual(await readFile(path), before);
});

test('record, byte and file budgets fail without repair, deletion or additional records', async t => {
  const f = await fixture(t), store = await f.create({ records: 1 }); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  await assert.rejects(store.save(f.actor, NEXT, await f.nextPrepared(), f.witness, guard), code('LIMIT')); await store.close();
  await assert.rejects(f.create({ recordBytes: 10 }), code('LIMIT'));
  assert.deepEqual(await readdir(f.options.directory), [JOB + '.json']);
});

for (const limits of [{ recordBytes: 1024 }, { totalBytes: 1024 }])
  test('preparation byte budget rejects oversized metadata before creating a record ' + JSON.stringify(limits), async t => {
    const f = await fixture(t), store = await f.create(limits);
    await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, guard), code('LIMIT'));
    assert.deepEqual(await readdir(f.options.directory), ['preparation-owner.json']);
  });

test('record corruption and abandoned files remain unchanged and prevent reopening', async t => {
  const f = await fixture(t), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard); await store.close();
  const path = join(f.options.directory, JOB + '.json'); await writeFile(path, '{corrupt'); const before = await readFile(path);
  await assert.rejects(f.create(), code('CORRUPT')); assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(f.options.directory), [JOB + '.json']);
});

test('single writer and foreign lock replacement are preserved, including on close', async t => {
  const f = await fixture(t), store = await f.create(); await assert.rejects(createStudioImportPreparationStore(f.options), code('LOCKED'));
  const path = join(f.options.directory, 'preparation-owner.json'); await writeFile(path, '{"foreign":"lock"}'); const before = await readFile(path);
  await assert.rejects(store.get(f.actor, JOB, guard), code('LOCKED')); await assert.rejects(store.close(), code('LOCKED')); assert.deepEqual(await readFile(path), before);
  await assert.rejects(f.create(), code('LOCKED')); assert.deepEqual(await readFile(path), before);
});

test('hard-linked records are refused without changing the link or metadata', async t => {
  const f = await fixture(t), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const path = join(f.options.directory, JOB + '.json'), outside = join(f.root, 'retained-record.json'); await link(path, outside);
  const before = await readFile(path); await assert.rejects(store.get(f.actor, JOB, guard), code('CORRUPT')); await store.close();
  assert.equal((await lstat(path)).nlink, 2); assert.deepEqual(await readFile(outside), before);
});

test('physical directory replacement fences reads and preserves both original metadata and foreign replacement files', async t => {
  const f = await fixture(t), store = await f.create(); await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const original = await readFile(join(f.options.directory, JOB + '.json')), retained = join(f.root, 'retained-preparations');
  await fs.rename(f.options.directory, retained); await mkdir(f.options.directory);
  const foreign = join(f.options.directory, 'preparation-owner.json'); await writeFile(foreign, 'preserve replacement lock');
  await assert.rejects(store.get(f.actor, JOB, guard), code('PATH')); await assert.rejects(store.close(), code('PATH'));
  assert.deepEqual(await readFile(join(retained, JOB + '.json')), original);
  assert.equal((await readFile(foreign)).toString(), 'preserve replacement lock');
});

test('ambiguous partial writes retain bytes and writer lock; no automatic replay or silent repair', async t => {
  const f = await fixture(t), store = await f.create(), original = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === join(f.options.directory, JOB + '.json') && args[1] === 'wx') {
      handle.writeFile = async () => { await handle.write(Buffer.from('{partial')); throw Object.assign(new Error('Synthetic interrupted metadata write'), { code: 'EIO' }); };
    } return handle;
  }); syncBuiltinESMExports();
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, guard), code('WRITE_UNKNOWN'));
  await assert.rejects(store.save(f.actor, JOB, f.prepared, f.witness, guard), code('WRITE_UNKNOWN')); await store.close();
  assert.equal((await readFile(join(f.options.directory, JOB + '.json'))).toString(), '{partial');
  assert.ok((await readdir(f.options.directory)).includes('preparation-owner.json'));
});

test('directory/project configuration and unknown foreign files are refused without retargeting', async t => {
  const f = await fixture(t); await assert.rejects(createStudioImportPreparationStore({ ...f.options, directory: join(f.root, '.codex', 'preparations') }), code('PATH'));
  await assert.rejects(createStudioImportPreparationStore({ ...f.options, projectPath: join(f.root, 'other-project') }), code('SCOPE'));
  await mkdir(f.options.directory); const path = join(f.options.directory, 'foreign.bin'); await writeFile(path, 'preserve foreign bytes');
  await assert.rejects(f.create(), code('CORRUPT')); assert.equal((await readFile(path)).toString(), 'preserve foreign bytes');
  const handle = await open(path, 'r'); await handle.close();
  assert.ok(STUDIO_IMPORT_PREPARATION_LIMITS.recordBytes > 1024 * 1024);
});
