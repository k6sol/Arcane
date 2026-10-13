import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  createAssetConversationHost, type AssetConversationHostOptions,
} from '../../apps/daemon/src/asset-conversation-host.js';
import { nativeAssetConversationJobPage } from '../../apps/daemon/src/asset-conversation-page.js';
import { HISTORY_PAGE_BYTES, type AssetJobRecord, type AssetStartAdmission } from '../../apps/daemon/src/asset-service.js';
import {
  createNativeAssetRegistry, nativeAssetActorScope, type NativeAssetActor,
} from '../../apps/daemon/src/native-asset-authority.js';
import type { AssetRequest } from '../../packages/asset-pipeline/src/types.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { ConversationWorkStore, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';

const NATIVE: NativeConversation = { provider: 'codex', threadId: 'Native:Thread.Exact', sessionId: null };
const INPUT = { template: 'hero-prop', name: 'fixture-crate' };
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
type Starter = NonNullable<AssetConversationHostOptions['startNative']>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// Actual volatile registry and SQLite, with explicit synthetic host ACKs and
// allocation callbacks. No service creation, native history, provider or worker.
function fixture(t: test.TestContext) {
  const boundary = realpathSync(tmpdir()), root = mkdtempSync(join(boundary, 'arcane-native-asset-host-'));
  mkdirSync(join(root, 'project'));
  const projectPath = realpathSync(join(root, 'project')), directory = join(root, 'state');
  const stores = new Set<ConversationWorkStore>();
  function open() {
    const store = new ConversationWorkStore({ projectPath, directory }); stores.add(store); return store;
  }
  let store = open();
  const registry = createNativeAssetRegistry({ projectPath });
  let serial = 0, nativeStarts = 0, genericStarts = 0, observations = 0, allocations = 0;
  let human: NativeConversation | null = { ...NATIVE, threadId: 'Human:Unrelated' };
  const requests: AssetRequest[] = [];
  let starter: Starter = async (_request, admission) => {
    admission.beforeCreate(); const id = 'native-job-' + ++allocations;
    admission.created(id); return id;
  };
  function options(): AssetConversationHostOptions {
    return { projectPath, workAssociations: store,
      conversation: () => { observations++; return human; },
      start: () => 'generic-job-' + ++genericStarts,
      startNative: (request, admission) => { nativeStarts++; requests.push(request); return starter(request, admission); },
    };
  }
  let host = createAssetConversationHost(options());
  function issue(conversation = NATIVE, mutate = true) {
    assert.equal(conversation.provider, 'codex');
    const handle = registry.issue(), connectionId = 'fixture-connection-' + ++serial;
    const operationId = 'fixture-operation-' + serial;
    const binding = { connectionId, threadId: conversation.threadId };
    handle.seal({ ...binding, provider: 'codex', sessionId: conversation.sessionId });
    if (mutate) { handle.grant(binding); handle.dispatched({ ...binding, operationId }); }
    return { handle, binding, operationId, actor: registry.capture(handle.credential(), mutate ? 'mutate' : 'read'),
      read: () => registry.capture(handle.credential(), 'read'),
      mutate: () => registry.capture(handle.credential(), 'mutate') };
  }
  t.after(() => {
    registry.close(); for (const store of stores) store.close();
    const target = realpathSync(root), part = relative(boundary, target);
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.ok(!lstatSync(root).isSymbolicLink()); rmSync(target, { recursive: true, force: true });
  });
  return { root, projectPath, directory, registry, issue, options, requests,
    get host() { return host; }, get store() { return store; },
    get nativeStarts() { return nativeStarts; }, get genericStarts() { return genericStarts; },
    get observations() { return observations; }, get allocations() { return allocations; },
    starter(callback: Starter) { starter = callback; }, human(value: NativeConversation | null) { human = value; },
    restart() { store.close(); store = open(); host = createAssetConversationHost(options()); },
  };
}

function unknown(result: Awaited<ReturnType<ReturnType<typeof createAssetConversationHost>['startNative']>>, id: string | null) {
  assert.equal(result.jobId, id); assert.equal(result.creation, 'unknown');
  assert.equal(result.association, 'unknown'); assert.equal(result.retry, false);
  assert.deepEqual(result.conversation, NATIVE);
}
function job(jobId: string, padding = ''): AssetJobRecord {
  return { schemaVersion: 1, jobId, directory: 'synthetic/output/' + jobId, manifestPath: null,
    request: normalizeRequest(INPUT), state: 'failed', stage: 'Retained café 🌿' + padding,
    startedAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:01.000Z', events: [],
    manifestAvailable: false, error: { code: 'FIXTURE', message: 'Complete retained failure evidence.' } };
}

test('native creation persists the registry tuple and project, independent of human context, through SQLite reopen', async t => {
  const f = fixture(t), capture = f.issue(), result = await f.host.startNative(capture.actor, INPUT);
  assert.deepEqual(result, { projectId: f.store.projectId, projectPath: f.projectPath,
    jobId: 'native-job-1', conversation: NATIVE, association: 'bound', creation: 'created', retry: false });
  assert.deepEqual(f.requests, [normalizeRequest(INPUT)]);
  assert.equal(f.observations, 0); assert.equal(f.genericStarts, 0); assert.equal(f.nativeStarts, 1);
  assert.equal(f.store.binding('workflow', result.jobId!), null);
  result.conversation.threadId = 'Changed'; f.restart();
  assert.deepEqual(f.host.bindingNative(capture.actor, result.jobId)?.conversation, NATIVE);
  assert.deepEqual(f.host.listNative(capture.actor).items.map(item => item.id), [result.jobId]);
  assert.equal(f.observations, 0);
});

test('null/session/thread/provider/namespace/project boundaries and cursors remain exact', t => {
  const f = fixture(t), own = f.issue(), session = f.issue({ ...NATIVE, sessionId: 'Session:Other' });
  const thread = f.issue({ ...NATIVE, threadId: NATIVE.threadId.toLowerCase() });
  const foreignProvider: NativeConversation = { ...NATIVE, provider: 'claude-code' };
  const tuples = [NATIVE, { ...NATIVE, sessionId: 'Session:Other' },
    { ...NATIVE, threadId: NATIVE.threadId.toLowerCase() }, foreignProvider];
  tuples.forEach((conversation, index) => f.store.bind({ conversation, kind: 'asset-job', id: 'scope-' + index }));
  f.store.bind({ conversation: NATIVE, kind: 'workflow', id: 'workflow-only' });
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'own-next' });
  const first = f.host.listNative(own.actor, { limit: 1 });
  assert.deepEqual(first.items.map(item => item.id), ['scope-0']); assert.ok(first.nextCursor);
  assert.deepEqual(f.host.listNative(own.actor, { limit: 1, after: first.nextCursor }).items.map(item => item.id), ['own-next']);
  assert.deepEqual(f.host.listNative(session.actor).items.map(item => item.id), ['scope-1']);
  assert.deepEqual(f.host.listNative(thread.actor).items.map(item => item.id), ['scope-2']);
  for (const id of ['scope-1', 'scope-2', 'scope-3', 'workflow-only', 'legacy-global']) {
    assert.equal(f.host.bindingNative(own.actor, id), null);
  }
  assert.throws(() => f.host.listNative(session.actor, { after: first.nextCursor }), code('CONVERSATION_WORK_INPUT'));
  assert.throws(() => f.host.listNative(thread.actor, { after: first.nextCursor }), code('CONVERSATION_WORK_INPUT'));
  mkdirSync(join(f.root, 'other-project'));
  const registry = createNativeAssetRegistry({ projectPath: realpathSync(join(f.root, 'other-project')) });
  t.after(() => registry.close());
  const handle = registry.issue(); handle.seal({ connectionId: 'other', ...NATIVE, provider: 'codex' });
  const actor = registry.capture(handle.credential(), 'read');
  assert.throws(() => f.host.listNative(actor), code('ASSET_CONVERSATION_PROJECT'));
  assert.throws(() => f.host.bindingNative(actor, 'scope-0'), code('ASSET_CONVERSATION_PROJECT'));
  assert.equal(f.observations, 0);
});

test('cross-project mutation cannot start the borrowed project service', async t => {
  const f = fixture(t); mkdirSync(join(f.root, 'other-project'));
  const registry = createNativeAssetRegistry({ projectPath: realpathSync(join(f.root, 'other-project')) });
  t.after(() => registry.close()); const handle = registry.issue();
  handle.seal({ connectionId: 'other', ...NATIVE, provider: 'codex' });
  handle.grant({ connectionId: 'other', threadId: NATIVE.threadId });
  handle.dispatched({ connectionId: 'other', threadId: NATIVE.threadId, operationId: 'other-operation' });
  await assert.rejects(() => f.host.startNative(registry.capture(handle.credential(), 'mutate'), INPUT), code('ASSET_CONVERSATION_PROJECT'));
  assert.equal(f.nativeStarts, 0);
});

test('forged actors, cloned actors, proxies and JSON capabilities fail without evaluating attacker accessors', async t => {
  const f = fixture(t), actor = f.issue().actor; let reads = 0;
  const forged: unknown[] = [null, {}, { ...actor }, JSON.parse(JSON.stringify(actor)),
    { kind: 'native-asset-actor', projectPath: f.projectPath, conversation: NATIVE },
    Object.create(actor), { get kind() { reads++; return actor.kind; } },
    new Proxy(actor, { get() { reads++; assert.fail('Do not evaluate forged actor'); } })];
  for (const value of forged) {
    await assert.rejects(() => f.host.startNative(value as NativeAssetActor, INPUT), code('NATIVE_ASSET_AUTHORITY'));
    assert.throws(() => f.host.listNative(value as NativeAssetActor), code('NATIVE_ASSET_AUTHORITY'));
    assert.throws(() => f.host.bindingNative(value as NativeAssetActor, 'job'), code('NATIVE_ASSET_AUTHORITY'));
  }
  assert.equal(reads, 0); assert.equal(f.nativeStarts, 0); assert.equal(f.observations, 0);
});

test('read captures cannot mutate and frozen registry metadata cannot be replaced by actor fields', async t => {
  const f = fixture(t), capture = f.issue(NATIVE, false), scope = nativeAssetActorScope(capture.actor);
  assert.ok(Object.isFrozen(scope)); assert.ok(Object.isFrozen(scope.conversation));
  assert.throws(() => Object.assign(capture.actor, { conversation: NATIVE }), TypeError);
  assert.throws(() => Object.assign(scope.conversation, { threadId: 'Changed' }), TypeError);
  assert.deepEqual(f.host.listNative(capture.actor).conversation, NATIVE);
  await assert.rejects(() => f.host.startNative(capture.actor, INPUT), code('NATIVE_ASSET_AUTHORITY'));
  assert.equal(f.nativeStarts, 0);
});

test('client authority fields, accessors and invalid pagination fail before callbacks', async t => {
  const f = fixture(t), actor = f.issue().actor; let reads = 0;
  for (const value of [{ ...INPUT, conversation: NATIVE }, { ...INPUT, actor },
    { ...INPUT, projectPath: f.projectPath }, { ...INPUT, admission: {} },
    { ...INPUT, get name() { reads++; return 'fixture'; } },
    new Proxy(INPUT, { ownKeys() { reads++; return []; } }), { template: 'unknown', name: 'fixture' }]) {
    await assert.rejects(() => f.host.startNative(actor, value), code('ASSET_CONVERSATION_INPUT'));
  }
  for (const value of [{ conversation: NATIVE }, { projectId: f.store.projectId },
    { get limit() { reads++; return 1; } }, new Proxy({}, {})]) {
    assert.throws(() => f.host.listNative(actor, value), code('ASSET_CONVERSATION_INPUT'));
  }
  for (const value of [{ limit: 0 }, { limit: 101 }, { after: 'invalid' }]) {
    assert.throws(() => f.host.listNative(actor, value), code('CONVERSATION_WORK_INPUT'));
  }
  assert.throws(() => f.host.bindingNative(actor, 'job\n'), code('ASSET_CONVERSATION_JOB_ID'));
  assert.equal(reads, 0); assert.equal(f.nativeStarts, 0); assert.equal(f.observations, 0);
});

test('closed storage rejects native creation and reads before service dispatch', async t => {
  const f = fixture(t), actor = f.issue().actor; f.store.close();
  await assert.rejects(() => f.host.startNative(actor, INPUT), code('CONVERSATION_WORK_CLOSED'));
  assert.throws(() => f.host.listNative(actor), code('CONVERSATION_WORK_CLOSED'));
  assert.throws(() => f.host.bindingNative(actor, 'job'), code('CONVERSATION_WORK_CLOSED'));
  assert.equal(f.nativeStarts, 0);
});

for (const change of ['revoke', 'regrant', 'ended', 'new-window', 'retire', 'close'] as const) {
  test('creation-time admission refuses queued capture after ' + change, async t => {
    const f = fixture(t), capture = f.issue(); let release!: () => void, creations = 0;
    f.starter(async (_request, admission) => {
      await new Promise<void>(resolve => { release = resolve; });
      admission.beforeCreate(); creations++; admission.created('must-not-create'); return 'must-not-create';
    });
    const pending = f.host.startNative(capture.actor, INPUT);
    assert.equal(f.nativeStarts, 1);
    if (change === 'revoke') capture.handle.revokeGrant();
    if (change === 'regrant') { capture.handle.revokeGrant(); capture.handle.grant(capture.binding);
      capture.handle.dispatched({ ...capture.binding, operationId: 'replacement-intent' }); }
    if (change === 'ended' || change === 'new-window') capture.handle.ended(capture.operationId);
    if (change === 'new-window') capture.handle.dispatched({ ...capture.binding, operationId: 'replacement-intent' });
    if (change === 'retire') capture.handle.retire();
    if (change === 'close') f.registry.close();
    release(); await assert.rejects(() => pending, code('NATIVE_ASSET_AUTHORITY'));
    assert.equal(creations, 0); assert.equal(f.store.binding('asset-job', 'must-not-create'), null);
    assert.equal(f.observations, 0);
  });
}

test('creation-time storage admission is rechecked after an awaited service preflight', async t => {
  const f = fixture(t), capture = f.issue(); let release!: () => void, creations = 0;
  f.starter(async (_request, admission) => {
    await new Promise<void>(resolve => { release = resolve; });
    admission.beforeCreate(); creations++; return 'must-not-create';
  });
  const pending = f.host.startNative(capture.actor, INPUT); f.store.close(); release();
  await assert.rejects(() => pending, code('CONVERSATION_WORK_CLOSED')); assert.equal(creations, 0);
});

test('request and registry scope are captured before await despite human/request/context changes', async t => {
  const f = fixture(t), capture = f.issue(), input = { ...INPUT, sizeMeters: [1, 2, 3] };
  let release!: () => void;
  f.starter(async (request, admission) => {
    await new Promise<void>(resolve => { release = resolve; });
    assert.deepEqual(request.sizeMeters, [1, 2, 3]); admission.beforeCreate();
    admission.created('captured'); return 'captured';
  });
  const pending = f.host.startNative(capture.actor, input); input.sizeMeters[0] = 9;
  f.human({ ...NATIVE, threadId: 'Later:Human', sessionId: 'Later:Session' }); f.issue({ ...NATIVE, threadId: 'Later:Native' });
  release(); const result = await pending;
  assert.equal(result.association, 'bound'); assert.deepEqual(result.conversation, NATIVE);
  assert.deepEqual(f.store.binding('asset-job', 'captured')?.conversation, NATIVE); assert.equal(f.observations, 0);
});

for (const change of ['revoke', 'ended', 'retire', 'context'] as const) {
  test('a witnessed allocation binds the original capture once after ' + change, async t => {
    const f = fixture(t), capture = f.issue(), bind = f.store.bind.bind(f.store); let binds = 0;
    f.store.bind = value => { binds++; return bind(value); };
    f.starter(async (_request, admission) => {
      admission.beforeCreate();
      // Simulate allocation then a host lifecycle change before its synchronous witness.
      if (change === 'revoke') capture.handle.revokeGrant();
      if (change === 'ended') capture.handle.ended(capture.operationId);
      if (change === 'retire') capture.handle.retire();
      if (change === 'context') f.human(null);
      admission.created('captured-created'); await Promise.resolve(); return 'captured-created';
    });
    const result = await f.host.startNative(capture.actor, INPUT);
    assert.equal(result.association, 'bound'); assert.equal(result.creation, 'created'); assert.equal(binds, 1);
    assert.deepEqual(f.store.binding('asset-job', 'captured-created')?.conversation, NATIVE); assert.equal(f.observations, 0);
  });
}

test('lost start persistence ACK preserves a witnessed ID and binding without reporting safe retry', async t => {
  const f = fixture(t), actor = f.issue().actor; let binds = 0;
  const bind = f.store.bind.bind(f.store); f.store.bind = value => { binds++; return bind(value); };
  f.starter(async (_request, admission) => {
    admission.beforeCreate(); admission.created('witnessed'); throw new Error('private service persistence ACK lost');
  });
  const result = await f.host.startNative(actor, INPUT); unknown(result, 'witnessed');
  assert.equal(binds, 1); assert.equal(f.nativeStarts, 1); assert.ok(!JSON.stringify(result).includes('private'));
  f.restart(); assert.deepEqual(f.host.bindingNative(actor, 'witnessed')?.conversation, NATIVE);
});

for (const committed of [false, true]) {
  test('association ' + (committed ? 'commit ACK loss' : 'write failure') + ' stays unknown without probing or replay', async t => {
    const f = fixture(t), actor = f.issue().actor, bind = f.store.bind.bind(f.store); let binds = 0;
    f.store.binding = () => { assert.fail('No ambiguity probe'); };
    f.store.bind = value => { binds++; if (committed) bind(value); throw new Error('private SQLite ACK loss'); };
    const result = await f.host.startNative(actor, INPUT); unknown(result, 'native-job-1');
    assert.equal(binds, 1); assert.equal(f.nativeStarts, 1); assert.ok(!JSON.stringify(result).includes('private'));
    f.restart(); f.store.bind = () => { assert.fail('Reads cannot backfill or retry binding'); };
    assert.equal(f.host.bindingNative(actor, 'native-job-1') !== null, committed);
    assert.equal(f.host.listNative(actor).items.length, committed ? 1 : 0); assert.equal(f.nativeStarts, 1);
  });
}

test('missing creation witness, callback rejection and invalid IDs remain conservative with no adoption', async t => {
  const f = fixture(t), actor = f.issue().actor; let binds = 0;
  f.store.bind = () => { binds++; assert.fail('Unwitnessed IDs cannot bind'); };
  for (const starter of [
    async () => 'legacy-global',
    async (_request: AssetRequest, admission: AssetStartAdmission) => { admission.beforeCreate(); return 'lost-witness'; },
    async () => { throw new Error('lost ACK before witness delivery'); },
    async (_request: AssetRequest, admission: AssetStartAdmission) => { admission.beforeCreate(); throw new Error('possible creation'); },
    async (_request: AssetRequest, admission: AssetStartAdmission) => { admission.beforeCreate(); admission.created('bad\n'); return 'bad\n'; },
  ]) {
    f.starter(starter); const result = await f.host.startNative(actor, INPUT);
    assert.equal(result.creation, 'unknown'); assert.equal(result.association, 'unknown'); assert.equal(result.retry, false);
  }
  assert.equal(binds, 0); assert.equal(f.host.bindingNative(actor, 'legacy-global'), null);
  assert.deepEqual(f.host.listNative(actor).items, []); assert.equal(f.nativeStarts, 5);
});

test('duplicate/late creation callbacks and returned ID mismatch never bind a second identity or replay', async t => {
  const f = fixture(t), actor = f.issue().actor; let late!: AssetStartAdmission, binds = 0;
  const bind = f.store.bind.bind(f.store); f.store.bind = value => { binds++; return bind(value); };
  f.starter(async (_request, admission) => {
    late = admission; admission.beforeCreate(); admission.created('original'); admission.created('foreign'); return 'foreign';
  });
  unknown(await f.host.startNative(actor, INPUT), 'original');
  assert.throws(() => late.created('late'), code('ASSET_CONVERSATION_ADMISSION'));
  assert.throws(() => late.beforeCreate(), code('ASSET_CONVERSATION_ADMISSION'));
  assert.equal(binds, 1); assert.equal(f.store.binding('asset-job', 'foreign'), null);
  assert.equal(f.store.binding('asset-job', 'late'), null);
  f.starter(async (_request, admission) => { admission.beforeCreate(); admission.created('second'); return 'unwitnessed'; });
  unknown(await f.host.startNative(actor, INPUT), 'second'); assert.equal(binds, 2);
  assert.equal(f.store.binding('asset-job', 'unwitnessed'), null); assert.equal(f.nativeStarts, 2);
});

test('out-of-order witness never binds and duplicate beforeCreate cannot admit a second allocation', async t => {
  const f = fixture(t), actor = f.issue().actor; let binds = 0;
  f.store.bind = () => { binds++; assert.fail('No invalid admission may bind'); };
  f.starter(async (_request, admission) => { admission.created('out-of-order'); return 'out-of-order'; });
  unknown(await f.host.startNative(actor, INPUT), 'out-of-order');
  f.starter(async (_request, admission) => { admission.beforeCreate(); admission.beforeCreate(); return 'never-created'; });
  unknown(await f.host.startNative(actor, INPUT), null); assert.equal(binds, 0);
});

test('foreign binding conflict never changes ownership or exposes foreign metadata', async t => {
  const f = fixture(t), actor = f.issue().actor, foreign = { ...NATIVE, sessionId: 'Foreign:Session' };
  f.store.bind({ conversation: foreign, kind: 'asset-job', id: 'native-job-1' });
  const result = await f.host.startNative(actor, INPUT); unknown(result, 'native-job-1');
  assert.ok(!JSON.stringify(result).includes('Foreign:Session'));
  assert.deepEqual(f.store.binding('asset-job', 'native-job-1')?.conversation, foreign);
  assert.equal(f.host.bindingNative(actor, 'native-job-1'), null);
});

test('concurrent synthetic starts bind their own captured sessions when witnesses arrive in reverse order', async t => {
  const f = fixture(t), first = f.issue(), second = f.issue({ ...NATIVE, sessionId: 'Second:Session' });
  const finishes: (() => void)[] = [];
  f.starter(async (_request, admission) => {
    const index = finishes.length;
    await new Promise<void>(resolve => { finishes.push(resolve); }); admission.beforeCreate();
    const id = 'concurrent-' + index; admission.created(id); return id;
  });
  const a = f.host.startNative(first.actor, INPUT), b = f.host.startNative(second.actor, INPUT);
  finishes[1]!(); await b; finishes[0]!(); await a;
  assert.deepEqual(f.host.listNative(first.actor).items.map(item => item.id), ['concurrent-0']);
  assert.deepEqual(f.host.listNative(second.actor).items.map(item => item.id), ['concurrent-1']);
  assert.equal(f.observations, 0);
});

test('native option is optional; original human and generic paths preserve their response contracts', async t => {
  const f = fixture(t), actor = f.issue().actor;
  const { startNative: _native, ...options } = f.options(); const host = createAssetConversationHost(options);
  await assert.rejects(() => host.startNative(actor, INPUT), code('ASSET_CONVERSATION_NATIVE_UNAVAILABLE'));
  assert.deepEqual(host.listNative(actor).items, []);
  const generic = await host.startAgent(INPUT);
  assert.deepEqual(generic, { projectId: f.store.projectId, projectPath: f.projectPath, jobId: 'generic-job-1',
    association: 'unscoped', conversation: null, retry: false });
  assert.equal(f.observations, 0); f.human(NATIVE);
  const human = await host.startHuman(INPUT);
  assert.deepEqual(human, { projectId: f.store.projectId, projectPath: f.projectPath, jobId: 'generic-job-2',
    association: 'bound', conversation: NATIVE, retry: false });
  assert.deepEqual(host.bindingHuman('generic-job-2')?.conversation, NATIVE);
  assert.equal(f.nativeStarts, 0); assert.equal(f.genericStarts, 2);
  assert.throws(() => createAssetConversationHost({ ...options, startNative: undefined } as unknown as AssetConversationHostOptions), code('ASSET_CONVERSATION_INPUT'));
});

test('native page hydrates complete captured records, counts orphans and ignores old global/provider jobs', t => {
  const f = fixture(t), actor = f.issue().actor, own = job('own'), global = job('global');
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'orphan' });
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'own' });
  f.store.bind({ conversation: { ...NATIVE, provider: 'claude-code' }, kind: 'asset-job', id: 'global' });
  let reads = 0;
  const service = { projectPath: f.projectPath, jobs: () => { reads++; f.human(null); return [global, own]; } };
  f.host.listHuman = () => { assert.fail('Native page must not call the human path'); };
  f.host.bindingHuman = () => { assert.fail('Native page must not infer human binding'); };
  const first = nativeAssetConversationJobPage(service, f.host, actor, { limit: 1, after: null });
  assert.deepEqual(first.jobs, []); assert.ok(first.nextCursor);
  const second = nativeAssetConversationJobPage(service, f.host, actor, { limit: 1, after: first.nextCursor });
  assert.deepEqual(second.jobs, [own]); assert.equal(second.jobs[0], own);
  assert.deepEqual(second.conversation, NATIVE); assert.equal(second.nextCursor, null);
  assert.equal(second.byteLimit, HISTORY_PAGE_BYTES); assert.equal(reads, 2); assert.equal(f.observations, 0);
});

test('native page verifies its exact SQLite prefix cursor within the UTF-8 byte cap', t => {
  const f = fixture(t), actor = f.issue().actor;
  const first = job('first', '🌿é\n"\\'.repeat(25000)), second = job('second', 'x'.repeat(300000));
  for (const id of ['first', 'orphan', 'second', 'later']) f.store.bind({ conversation: NATIVE, kind: 'asset-job', id });
  const calls: unknown[] = [], list = f.host.listNative.bind(f.host);
  f.host.listNative = (capture, query) => { calls.push(query); return list(capture, query); };
  const service = { projectPath: f.projectPath, jobs: () => [second, first] };
  const result = nativeAssetConversationJobPage(service, f.host, actor, { limit: 3, after: null });
  assert.deepEqual(result.jobs, [first]); assert.ok(bytes(result) <= HISTORY_PAGE_BYTES);
  assert.deepEqual(calls, [{ limit: 3 }, { limit: 2 }]);
  assert.equal(result.nextCursor, list(actor, { limit: 2 }).nextCursor);
  const next = nativeAssetConversationJobPage(service, f.host, actor, { limit: 3, after: result.nextCursor });
  assert.deepEqual(next.jobs, [second]); assert.equal(next.nextCursor, null);
});

test('native page rejects oversized records, wrong service project and revoked prefix observation', t => {
  const f = fixture(t), capture = f.issue();
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'huge' });
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'second' });
  const huge = job('huge', 'x'.repeat(HISTORY_PAGE_BYTES));
  const service = { projectPath: f.projectPath, jobs: () => [huge] };
  assert.throws(() => nativeAssetConversationJobPage(service, f.host, capture.actor, { limit: 2, after: null }), code('HISTORY_LIMIT'));
  let reads = 0;
  assert.throws(() => nativeAssetConversationJobPage({ projectPath: f.projectPath + '-foreign', jobs: () => { reads++; return []; } },
    f.host, capture.actor, { limit: 2, after: null }), code('ASSET_CONVERSATION_STALE'));
  assert.equal(reads, 0);
  const prefixService = { projectPath: f.projectPath, jobs: () => {
    capture.handle.revokeGrant(); return [job('huge', 'x'.repeat(300000)), job('second', 'x'.repeat(300000))];
  } };
  assert.throws(() => nativeAssetConversationJobPage(prefixService, f.host, capture.actor, { limit: 2, after: null }), code('ASSET_CONVERSATION_STALE'));
  assert.equal(f.observations, 0);
});

test('source wiring has no native-to-human adapter or untrusted authority option', () => {
  const root = process.cwd();
  const host = readFileSync(join(root, 'apps/daemon/src/asset-conversation-host.ts'), 'utf8');
  const page = readFileSync(join(root, 'apps/daemon/src/asset-conversation-page.ts'), 'utf8');
  assert.match(host, /nativeAssetActorScope\(actor\)/);
  assert.match(host, /assertNativeAssetActor\(actor, 'mutate'\)/);
  const nativePage = page.slice(page.indexOf('export function nativeAssetConversationJobPage'), page.indexOf('function capturedJobPage'));
  assert.match(nativePage, /host\.listNative\(actor, pagination\)/); assert.doesNotMatch(nativePage, /listHuman|bindingHuman/);
  assert.doesNotMatch(host, /nativeAuthority\??:|actorScope\??:/);
});
