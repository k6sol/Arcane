import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  createAssetConversationHost, type AssetConversationHostOptions,
} from '../../apps/daemon/src/asset-conversation-host.js';
import { CUSTOM_REQUEST_BYTES } from '../../packages/asset-pipeline/src/recipe.js';
import type { AssetRequest } from '../../packages/asset-pipeline/src/types.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import {
  CONVERSATION_WORK_LIMITS, ConversationWorkStore, type NativeConversation,
} from '../../packages/storage/src/conversation-work-store.js';

const native: NativeConversation = { provider: 'codex', threadId: 'Asset:Thread.Exact', sessionId: 'Asset:Session.Exact' };
const input = { template: 'hero-prop', name: 'fixture-crate' };
const hostCode = (code: string) => (error: unknown) => error instanceof ArcaneError && error.code === 'ASSET_CONVERSATION_' + code;
const storageCode = (code: string) => (error: unknown) => error instanceof ArcaneError && error.code === 'CONVERSATION_WORK_' + code;

// Actual association SQLite with synthetic host observations/start callbacks only.
// No asset service, CLI, Studio, native history or provider turn is opened.
function fixture(t: test.TestContext) {
  const boundary = realpathSync(tmpdir()), root = mkdtempSync(join(boundary, 'arcane-asset-conversation-'));
  const project = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(project);
  const projectPath = realpathSync(project), stores = new Set<ConversationWorkStore>();
  function open(path = projectPath, state = directory) {
    const store = new ConversationWorkStore({ projectPath: path, directory: state });
    stores.add(store); return store;
  }
  let store = open(), context: unknown = { ...native }, starts = 0, observations = 0;
  const requests: AssetRequest[] = [];
  let starter: AssetConversationHostOptions['start'] = () => 'job-' + starts;
  function options(): AssetConversationHostOptions {
    return {
      projectPath, workAssociations: store,
      conversation: () => { observations++; return context as NativeConversation | null; },
      start: request => { starts++; requests.push(request); return starter(request); },
    };
  }
  let host = createAssetConversationHost(options());
  t.after(() => {
    for (const store of stores) store.close();
    const target = realpathSync(root), part = relative(boundary, target);
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.ok(!lstatSync(root).isSymbolicLink());
    rmSync(target, { recursive: true, force: true });
  });
  return {
    root, projectPath, open, options, requests,
    get host() { return host; }, get store() { return store; },
    get starts() { return starts; }, get observations() { return observations; },
    context(value: unknown) { context = value; },
    starter(callback: AssetConversationHostOptions['start']) { starter = callback; },
    restart() { store.close(); store = open(); host = createAssetConversationHost(options()); },
  };
}

test('human creation persists exact asset namespace/project and survives restart without adopting legacy jobs', async t => {
  const f = fixture(t), result = await f.host.startHuman(input);
  assert.deepEqual(result, {
    projectId: f.store.projectId, projectPath: f.projectPath, jobId: 'job-1',
    association: 'bound', conversation: native, retry: false,
  });
  assert.deepEqual(f.requests, [normalizeRequest(input)]);
  const binding = { projectId: f.store.projectId, conversation: native, kind: 'asset-job', id: 'job-1' };
  assert.deepEqual(f.store.binding('asset-job', 'job-1'), binding);
  assert.equal(f.store.binding('workflow', 'job-1'), null);
  assert.equal(f.host.bindingHuman('legacy-job'), null);
  f.restart();
  assert.deepEqual(f.host.bindingHuman('job-1'), binding);
  assert.deepEqual(f.host.listHuman(), {
    projectId: f.store.projectId, projectPath: f.projectPath, conversation: native,
    items: [binding], nextCursor: null,
  });
  assert.equal(f.store.binding('asset-job', 'legacy-job'), null);
});

test('pending human start pins one detached live snapshot despite mutations, chat switches and null context', async t => {
  const f = fixture(t), live = { ...native };
  f.context(live);
  let complete!: (id: string) => void;
  f.starter(() => new Promise<string>(resolve => { complete = resolve; }));
  const pending = f.host.startHuman(input);
  assert.equal(f.starts, 1); assert.equal(f.observations, 1);
  live.provider = 'claude-code'; live.threadId = 'Changed-thread'; live.sessionId = null;
  f.context(null);
  complete('pending-job');
  const result = await pending;
  assert.equal(result.jobId, 'pending-job'); assert.equal(result.association, 'bound');
  assert.deepEqual(result.conversation, native);
  assert.equal(f.observations, 1);
  assert.deepEqual(f.store.binding('asset-job', 'pending-job')?.conversation, native);
  assert.throws(() => f.host.listHuman(), hostCode('REQUIRED'));
  f.context({ ...native, sessionId: 'Other-session' });
  assert.deepEqual(f.host.listHuman().items, []);
  assert.equal(f.host.bindingHuman('pending-job'), null);
});

test('two concurrent callbacks retain their own pre-start conversation even when finishing in reverse order', async t => {
  const f = fixture(t), other = { ...native, sessionId: 'Other-session' };
  const completions: ((id: string) => void)[] = [];
  f.starter(() => new Promise<string>(resolve => { completions.push(resolve); }));
  const first = f.host.startHuman(input);
  f.context(other);
  const second = f.host.startHuman(input);
  completions[1]!('second'); await second;
  completions[0]!('first'); await first;
  assert.equal(f.starts, 2); assert.equal(f.observations, 2);
  assert.deepEqual(f.store.binding('asset-job', 'first')?.conversation, native);
  assert.deepEqual(f.store.binding('asset-job', 'second')?.conversation, other);
});

test('association failure before persistence preserves created ID and never reads, retries or rebinds after start', async t => {
  const f = fixture(t); let binds = 0, reads = 0;
  const list = f.store.list.bind(f.store);
  f.store.list = (...args) => { reads++; return list(...args); };
  f.store.binding = () => { assert.fail('No post-failure association probe is allowed'); };
  f.store.bind = () => { binds++; throw new Error('private persistence path or credential'); };
  const result = await f.host.startHuman(input);
  assert.equal(result.jobId, 'job-1'); assert.equal(result.association, 'unknown');
  assert.deepEqual(result.conversation, native); assert.equal(result.retry, false);
  assert.equal(f.starts, 1); assert.equal(binds, 1); assert.equal(reads, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('post-commit association failure stays unknown while read-only restart observes the original binding', async t => {
  const f = fixture(t), bind = f.store.bind.bind(f.store); let binds = 0;
  f.store.bind = value => { binds++; bind(value); throw new Error('unknown commit outcome'); };
  const result = await f.host.startHuman(input);
  assert.equal(result.jobId, 'job-1'); assert.equal(result.association, 'unknown');
  assert.equal(result.retry, false); assert.equal(binds, 1); assert.equal(f.starts, 1);
  f.restart();
  f.store.bind = () => { assert.fail('Observation must never bind'); };
  assert.deepEqual(f.host.bindingHuman(result.jobId)?.conversation, native);
  assert.deepEqual(f.host.listHuman().items.map(item => item.id), [result.jobId]);
  assert.equal(f.starts, 1);
});

test('closure after job creation reports unknown instead of losing the job or reopening storage', async t => {
  const f = fixture(t);
  f.starter(() => { f.store.close(); return 'created-before-close'; });
  const result = await f.host.startHuman(input);
  assert.equal(result.jobId, 'created-before-close'); assert.equal(result.association, 'unknown');
  assert.equal(result.retry, false); assert.equal(f.starts, 1);
  f.restart();
  assert.equal(f.store.binding('asset-job', result.jobId), null);
});

test('existing foreign ownership cannot be rebound; the created ID is returned as unknown without foreign metadata', async t => {
  const f = fixture(t), foreign = { ...native, threadId: 'Foreign-thread' };
  f.store.bind({ conversation: foreign, kind: 'asset-job', id: 'job-1' });
  const result = await f.host.startHuman(input);
  assert.equal(result.jobId, 'job-1'); assert.equal(result.association, 'unknown');
  assert.ok(!JSON.stringify(result).includes('Foreign-thread'));
  assert.deepEqual(f.store.binding('asset-job', 'job-1')?.conversation, foreign);
  assert.equal(f.host.bindingHuman('job-1'), null);
  assert.deepEqual(f.host.listHuman().items, []);
});

test('agent start never consults live chat/storage and is explicitly unscoped even with a current human chat', async t => {
  const f = fixture(t);
  f.store.bind = () => { assert.fail('Agent cannot bind'); };
  f.store.list = () => { assert.fail('Agent cannot infer chat from associations'); };
  f.store.binding = () => { assert.fail('Agent cannot infer chat from work'); };
  for (const value of [native, null, { threadId: 'invalid-native-data' }]) {
    f.context(value);
    const result = await f.host.startAgent(input);
    assert.equal(result.association, 'unscoped'); assert.equal(result.conversation, null);
    assert.equal(result.jobId, 'job-' + f.starts); assert.equal(result.retry, false);
  }
  assert.equal(f.observations, 0);
});

test('agent and legacy jobs stay absent after human reads and restart; workflow IDs do not count as assets', async t => {
  const f = fixture(t), result = await f.host.startAgent(input);
  f.store.bind({ conversation: native, kind: 'workflow', id: result.jobId });
  f.restart();
  f.store.bind = () => { assert.fail('No read can attribute existing work'); };
  assert.deepEqual(f.host.listHuman().items, []);
  assert.equal(f.host.bindingHuman(result.jobId), null);
  assert.equal(f.host.bindingHuman('legacy-job'), null);
});

test('provider, thread, session, null session and case isolate listings and exact-ID reads', async t => {
  const f = fixture(t), result = await f.host.startHuman(input);
  const variants: NativeConversation[] = [
    { ...native, provider: 'claude-code' }, { ...native, threadId: 'Another-thread' },
    { ...native, sessionId: 'Another-session' }, { ...native, sessionId: null },
    { ...native, threadId: native.threadId.toLowerCase() },
    { ...native, sessionId: native.sessionId!.toLowerCase() },
  ];
  for (const [i, conversation] of variants.entries()) {
    f.store.bind({ conversation, kind: 'asset-job', id: 'foreign-' + i });
    f.context(conversation);
    assert.deepEqual(f.host.listHuman().items.map(item => item.id), ['foreign-' + i]);
    assert.equal(f.host.bindingHuman(result.jobId), null);
  }
  f.context(native);
  assert.deepEqual(f.host.listHuman().items.map(item => item.id), [result.jobId]);
  assert.equal(f.host.bindingHuman('foreign-0'), null);
});

test('list captures once and keeps stored identities if live context changes during storage access', async t => {
  const f = fixture(t); await f.host.startHuman(input);
  const list = f.store.list.bind(f.store), before = f.observations;
  f.store.list = (...args) => {
    f.context({ ...native, threadId: 'Later-thread' });
    return list(...args);
  };
  const result = f.host.listHuman();
  assert.equal(f.observations, before + 1);
  assert.deepEqual(result.conversation, native);
  assert.deepEqual(result.items[0]?.conversation, native);
  assert.ok(!JSON.stringify(result).includes('Later-thread'));
  assert.deepEqual(f.host.listHuman().items, []);
});

test('bounded pages use exact storage cursors; foreign chat/project/namespace cursors are rejected', t => {
  const f = fixture(t), second = { ...native, sessionId: 'Other-session' };
  for (const id of ['one', 'two', 'three']) {
    f.store.bind({ conversation: native, kind: 'asset-job', id });
    f.store.bind({ conversation: second, kind: 'asset-job', id: 'foreign-' + id });
    f.store.bind({ conversation: native, kind: 'workflow', id });
  }
  const page = f.host.listHuman({ limit: 1 });
  assert.deepEqual(page.items.map(item => item.id), ['one']); assert.ok(page.nextCursor);
  assert.deepEqual(f.host.listHuman({ after: page.nextCursor, limit: 1 }).items.map(item => item.id), ['two']);
  assert.equal(f.host.listHuman({ after: f.host.listHuman({ limit: 2 }).nextCursor! }).nextCursor, null);
  f.context(second);
  assert.throws(() => f.host.listHuman({ after: page.nextCursor }), storageCode('INPUT'));
  f.context(native);
  const workflowCursor = f.store.list(native, 'workflow', { limit: 1 }).nextCursor!;
  assert.throws(() => f.host.listHuman({ after: workflowCursor }), storageCode('INPUT'));
  const otherProject = join(f.root, 'other-project'); mkdirSync(otherProject);
  const otherStore = f.open(realpathSync(otherProject), join(f.root, 'other-state'));
  for (const id of ['one', 'two']) otherStore.bind({ conversation: native, kind: 'asset-job', id });
  const otherHost = createAssetConversationHost({ ...f.options(), projectPath: otherStore.projectPath, workAssociations: otherStore });
  assert.throws(() => otherHost.listHuman({ after: page.nextCursor }), storageCode('INPUT'));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < CONVERSATION_WORK_LIMITS.pageBytes);
});

test('project attestation requires the exact canonical path, and caller mutation cannot replace captured authority', async t => {
  const f = fixture(t);
  for (const projectPath of [join(f.root, 'foreign'), f.projectPath + sep, f.projectPath + sep + '..', 'relative']) {
    assert.throws(() => createAssetConversationHost({ ...f.options(), projectPath }), hostCode('PROJECT'));
  }
  if (process.platform === 'win32') {
    assert.throws(() => createAssetConversationHost({ ...f.options(), projectPath: f.projectPath.toUpperCase() }), hostCode('PROJECT'));
  }
  const options = f.options(), host = createAssetConversationHost(options);
  options.projectPath = 'relative';
  options.conversation = () => ({ ...native, threadId: 'Replacement-thread' });
  options.start = () => { assert.fail('Captured callback must not be substituted'); };
  const result = await host.startHuman(input);
  assert.deepEqual(result.conversation, native); assert.equal(result.projectPath, f.projectPath);
  assert.equal(result.jobId, 'job-1');
});

test('missing or malformed host conversation fails before any start, using storage identity/credential bounds', async t => {
  const f = fixture(t);
  f.context(null);
  await assert.rejects(() => f.host.startHuman(input), hostCode('REQUIRED'));
  assert.throws(() => f.host.listHuman(), hostCode('REQUIRED'));
  assert.throws(() => f.host.bindingHuman('job'), hostCode('REQUIRED'));
  for (const value of [undefined, {}, { ...native, prompt: 'private-fixture' },
    { provider: 'codex', threadId: 'thread' }]) {
    f.context(value);
    await assert.rejects(() => f.host.startHuman(input), hostCode('INPUT'));
  }
  for (const value of [{ ...native, sessionId: undefined }, { ...native, provider: 'claude' }, { ...native, threadId: 'x'.repeat(257) },
    { ...native, sessionId: 'x'.repeat(257) }, { ...native, threadId: '../thread' },
    { ...native, threadId: 'thread\n' }, { ...native, sessionId: ' token ' },
    ...['sk-proj-' + 'a'.repeat(24), 'a'.repeat(64), 'token:private-fixture',
      'eyJabcde.abcde.abcde'].map(threadId => ({ ...native, threadId }))]) {
    f.context(value);
    await assert.rejects(() => f.host.startHuman(input), storageCode('INPUT'));
    assert.throws(() => f.host.listHuman(), storageCode('INPUT'));
  }
  assert.equal(f.starts, 0);
});

test('native descriptors/proxies are refused without evaluation, including inherited and hidden authority', async t => {
  const f = fixture(t); let reads = 0;
  const getter = () => { reads++; throw new Error('private getter'); };
  const values: unknown[] = [
    { ...native, get threadId() { return getter(); } },
    new Proxy(native, { getPrototypeOf() { return getter(); }, ownKeys() { return getter(); } }),
    Object.create(native), { ...native, [Symbol('authority')]: 'hidden' },
    Object.defineProperty({ ...native }, 'sessionId', { value: 'hidden', enumerable: false }),
  ];
  for (const value of values) {
    f.context(value);
    await assert.rejects(() => f.host.startHuman(input), hostCode('INPUT'));
    assert.throws(() => f.host.listHuman(), hostCode('INPUT'));
  }
  assert.equal(reads, 0); assert.equal(f.starts, 0);
});

test('client conversation/project/authority fields and oversized or invalid requests never reach start', async t => {
  const f = fixture(t);
  const cyclic: Record<string, unknown> = { ...input }; cyclic.cycle = cyclic;
  const nested: Record<string, unknown> = {}; let cursor = nested;
  for (let i = 0; i < 14; i++) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
  const values: unknown[] = [null, [], {}, { ...input, conversation: native },
    { ...input, projectPath: f.projectPath }, { ...input, provider: 'codex', threadId: native.threadId },
    { ...input, authority: 'human' }, { ...input, workAssociations: {} },
    { ...input, token: 'private-fixture' }, { ...input, name: 'x'.repeat(CUSTOM_REQUEST_BYTES + 1) },
    { ...input, recipe: nested }, { ...input, recipe: { parts: Array(100001).fill(null) } },
    { ...input, sizeMeters: [1, Infinity, 1] }, { ...input, color: [-1, 0, 0] },
    { ...input, template: 'unsupported' }, cyclic];
  for (const value of values) {
    await assert.rejects(() => f.host.startHuman(value), hostCode('INPUT'));
    await assert.rejects(() => f.host.startAgent(value), hostCode('INPUT'));
  }
  assert.equal(f.starts, 0); assert.equal(f.observations, 0);
});

test('request snapshots reject nested accessors/proxies/toJSON/sparse arrays without running them', async t => {
  const f = fixture(t); let reads = 0;
  const getter = () => { reads++; throw new Error('private accessor'); };
  const sparse = [1, 1, 1]; delete sparse[1];
  const values: unknown[] = [
    { ...input, get name() { return getter(); } },
    { ...input, recipe: { get parts() { return getter(); } } },
    { ...input, color: new Proxy([1, 1, 1], { ownKeys() { return getter(); } }) },
    new Proxy(input, { getPrototypeOf() { return getter(); } }),
    { ...input, toJSON: getter }, { ...input, sizeMeters: sparse },
    Object.assign(Object.create({ conversation: native }) as object, input),
    Object.defineProperty({ ...input }, 'name', { value: 'hidden', enumerable: false }),
  ];
  for (const value of values) await assert.rejects(() => f.host.startHuman(value), hostCode('INPUT'));
  assert.equal(reads, 0); assert.equal(f.starts, 0);
});

test('start receives a normalized detached request; caller and returned metadata cannot change stored bindings', async t => {
  const f = fixture(t), request = { ...input, sizeMeters: [1, 2, 3], color: [0.1, 0.2, 0.3] };
  f.starter(received => { request.sizeMeters[0] = 9; assert.deepEqual(received.sizeMeters, [1, 2, 3]); return 'detached'; });
  const result = await f.host.startHuman(request);
  result.conversation!.threadId = 'Changed';
  const listing = f.host.listHuman();
  listing.conversation.threadId = 'Changed'; listing.items[0]!.conversation.sessionId = null;
  const binding = f.host.bindingHuman('detached')!; binding.conversation.provider = 'claude-code';
  assert.deepEqual(f.store.binding('asset-job', 'detached')?.conversation, native);
});

test('null session and maximum storage ID lengths are accepted unchanged', async t => {
  const f = fixture(t), longest = { ...native, threadId: 'T'.repeat(256), sessionId: 'S'.repeat(256) };
  f.context(longest); f.starter(() => 'J'.repeat(CONVERSATION_WORK_LIMITS.workId));
  const result = await f.host.startHuman(input);
  assert.equal(result.association, 'bound'); assert.deepEqual(result.conversation, longest);
  f.context({ ...native, sessionId: null }); f.starter(() => 'null-session');
  assert.equal((await f.host.startHuman(input)).association, 'bound');
  assert.deepEqual(f.host.listHuman().items.map(item => item.id), ['null-session']);
});

test('invalid job IDs and callback rejection never bind or automatically call start again', async t => {
  const f = fixture(t); let binds = 0;
  f.store.bind = () => { binds++; assert.fail('Invalid result must never bind'); };
  for (const id of ['', 'x'.repeat(65), '../job', 'job:one', 'job\n', 'é']) {
    f.starter(() => id);
    await assert.rejects(() => f.host.startHuman(input), hostCode('JOB_ID'));
    await assert.rejects(() => f.host.startAgent(input), hostCode('JOB_ID'));
    assert.throws(() => f.host.bindingHuman(id), hostCode('JOB_ID'));
  }
  const error = new Error('host callback unknown start outcome');
  f.starter(async () => { throw error; });
  const before = f.starts;
  await assert.rejects(() => f.host.startHuman(input), value => value === error);
  assert.equal(f.starts, before + 1); assert.equal(binds, 0);
});

test('control-bearing callback and native IDs cannot create attribution or appear as a bound start result', async t => {
  const f = fixture(t); let binds = 0;
  f.store.bind = () => { binds++; assert.fail('No invalid ID may be bound'); };
  const controls = [...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => 127 + i), 0x2028, 0x2029].map(value => String.fromCharCode(value));
  for (const control of controls) {
    for (const id of [control + 'job', 'jo' + control + 'b', 'job' + control]) {
      assert.throws(() => f.host.bindingHuman(id), hostCode('JOB_ID'));
    }
    f.starter(() => 'job' + control);
    await assert.rejects(() => f.host.startHuman(input), hostCode('JOB_ID'));
    await assert.rejects(() => f.host.startAgent(input), hostCode('JOB_ID'));
    for (const field of ['threadId', 'sessionId'] as const) {
      f.context({ ...native, [field]: 'Native' + control });
      const starts = f.starts;
      await assert.rejects(() => f.host.startHuman(input), storageCode('INPUT'));
      assert.equal(f.starts, starts);
    }
    f.context(native);
  }
  f.starter(() => 'job\r\n');
  await assert.rejects(() => f.host.startHuman(input), hostCode('JOB_ID'));
  assert.equal(binds, 0); assert.deepEqual(f.store.list(native).items, []);
});

test('storage unavailability before creation fails closed and read failures never backfill or recreate', async t => {
  const f = fixture(t); f.store.close();
  await assert.rejects(() => f.host.startHuman(input), storageCode('CLOSED'));
  assert.throws(() => f.host.listHuman(), storageCode('CLOSED'));
  assert.throws(() => f.host.bindingHuman('legacy'), storageCode('CLOSED'));
  assert.equal(f.starts, 0);
});

test('pagination accepts only bounded plain fields and rejects client conversation authority', t => {
  const f = fixture(t); let reads = 0;
  for (const value of [null, [], { conversation: native }, { projectPath: f.projectPath },
    { limit: 1, after: 'x'.repeat(1024), token: 'private' },
    { get limit() { reads++; return 1; } }, new Proxy({}, { ownKeys() { reads++; return []; } })]) {
    assert.throws(() => f.host.listHuman(value), hostCode('INPUT'));
  }
  for (const value of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: undefined },
    { limit: Infinity }, { limit: '1' }, { after: '' }, { after: undefined }, { after: 'x'.repeat(1024) }]) {
    assert.throws(() => f.host.listHuman(value), storageCode('INPUT'));
  }
  assert.equal(reads, 0);
});

test('bounded custom assembly requests use the same pure normalization as the asset service', async t => {
  const f = fixture(t);
  const request = {
    template: 'custom-assembly', name: 'fixture-assembly',
    recipe: {
      schemaVersion: 1,
      materials: [{ id: 'body', color: [0.2, 0.3, 0.4], roughness: 0.7, metallic: 0 }],
      parts: [
        { name: 'body', role: 'render', material: 'body',
          geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, 0.5] },
        { name: 'collider', role: 'collision', geometry: { kind: 'box' },
          dimensions: [1, 1, 1], position: [0, 0, 0.5] },
      ],
      collisionTriangleBudget: 256,
    },
  };
  const expected = normalizeRequest(request);
  assert.equal((await f.host.startHuman(request)).association, 'bound');
  assert.deepEqual(f.requests[0], expected);
  assert.notEqual(f.requests[0]?.recipe, request.recipe);
});

test('a full metadata page with maximum native IDs remains within the storage response bound', t => {
  const f = fixture(t), conversation = { ...native, threadId: 'T'.repeat(256), sessionId: 'S'.repeat(256) };
  f.context(conversation);
  for (let i = 0; i < CONVERSATION_WORK_LIMITS.pageItems; i++) {
    f.store.bind({ conversation, kind: 'asset-job', id: String(i).padStart(CONVERSATION_WORK_LIMITS.workId, '_') });
  }
  const page = f.host.listHuman({ limit: CONVERSATION_WORK_LIMITS.pageItems });
  assert.equal(page.items.length, CONVERSATION_WORK_LIMITS.pageItems); assert.equal(page.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CONVERSATION_WORK_LIMITS.pageBytes);
});
