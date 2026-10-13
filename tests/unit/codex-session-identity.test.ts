import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { CodexClientError, type NativeAssetHooks, type NativeAssetIntent, type Snapshot } from '../../packages/codex-client/src/types.js';
import { createCodexService } from '../../apps/daemon/src/codex-service.js';
import { createNativeAssetRegistry, assertNativeAssetActor } from '../../apps/daemon/src/native-asset-authority.js';

const HUMAN = { initiatedBy: 'human' } as const;
const THREAD = 'fixture.thread:identity', SESSION = 'fixture.session:ack', OTHER = 'fixture.session:other';
const PAIR = { model: 'fixture-model', effort: 'low' };
const OPTIONS = { timeout: 12000 };
interface Notification { threadId?: string; sessionId?: string | null }
interface Scenario {
  ackSession?: string | null;
  omitAck?: boolean;
  before?: Notification[];
  holdInventory?: number;
  holdSecondPage?: boolean;
  activeTurn?: boolean;
}
interface Wire { event: string; method?: string; notification?: Notification }

// Only process.execPath executes this peer. It emits synthetic JSONL, reads
// fixture gates and writes fixture receipts; it has no provider/config/auth path.
function protocolPeer(): void {
  const { createInterface } = require('node:readline') as typeof import('node:readline');
  const { appendFileSync, existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const [encoded, audit, notifyFile, releaseFile] = process.argv.slice(1);
  const scenario = JSON.parse(encoded!) as Scenario;
  const threadId = 'fixture.thread:identity';
  let checks = 0, notified = false;
  const record = (value: object) => appendFileSync(audit!, JSON.stringify(value) + '\n');
  const send = (...messages: object[]) => process.stdout.write(messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  const notification = (value: Notification) => {
    record({ event: 'notification', notification: value });
    return { method: 'thread/started', params: { thread: {
      id: value.threadId ?? threadId,
      ...(Object.hasOwn(value, 'sessionId') ? { sessionId: value.sessionId } : {}),
    } } };
  };
  setInterval(() => {
    if (!notified && existsSync(notifyFile!)) {
      notified = true;
      send(notification(JSON.parse(readFileSync(notifyFile!, 'utf8')) as Notification));
    }
  }, 5);
  const held = (reply: () => void) => {
    const timer = setInterval(() => { if (existsSync(releaseFile!)) { clearInterval(timer); reply(); } }, 5);
  };
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    const { id, method, params = {} } = message;
    record({ event: 'request', method });
    if (method === 'initialized' || method === undefined) return;
    if (method === 'initialize') { send({ id, result: {} }); return; }
    if (method === 'account/read') {
      send({ id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } }); return;
    }
    if (method === 'model/list') {
      send({ id, result: { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } }); return;
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      // Send notifications and the ACK in a single write to cover queued ACKs too.
      send(...(scenario.before ?? []).map(notification), { id, result: {
        thread: { id: threadId, ...(scenario.omitAck ? {} : { sessionId: scenario.ackSession }),
          status: { type: 'idle' }, turns: [] },
        model: params.model, modelProvider: 'openai', cwd: process.cwd(),
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
      } }); return;
    }
    if (method === 'mcpServerStatus/list') {
      if (!params.cursor) checks++;
      const second = params.cursor === 'second';
      const reply = () => send({ id, result: {
        data: [{ name: second ? 'inherited' : 'arcane', runtimeStatus: second ? 'disabled' : 'connected',
          tools: {}, toolsError: null, pluginId: null }],
        nextCursor: scenario.holdSecondPage && !second ? 'second' : null,
      } });
      if (checks === scenario.holdInventory || scenario.holdSecondPage && second) held(reply); else reply();
      return;
    }
    if (method === 'turn/start') {
      const turn = { id: 'fixture.turn:identity', status: scenario.activeTurn ? 'inProgress' : 'completed' };
      if (scenario.activeTurn) {
        send({ method: 'turn/started', params: { threadId, turn } },
          { id: 'fixture-approval', method: 'item/commandExecution/requestApproval',
            params: { threadId, turnId: turn.id, itemId: 'fixture-item', command: 'Synthetic fixture',
              cwd: process.cwd() } }, { id, result: { turn } });
      } else send({ id, result: { turn } });
      return;
    }
    throw new Error('Unexpected fixture request.');
  });
}
const PEER = '(' + protocolPeer.toString() + ')();';
const calls = (wire: Wire[], method: string) => wire.filter(row => row.event === 'request' && row.method === method);
const code = (expected: string, dispatched?: boolean) => (error: unknown) =>
  error instanceof CodexClientError && error.code === expected && (dispatched === undefined || error.dispatched === dispatched);

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { if (Date.now() >= deadline) assert.fail('Synthetic identity fixture timed out.'); await delay(5); }
}
async function fixture(t: test.TestContext, scenario: Scenario = {}, options: {
  policy?: 'native-config' | 'arcane-only'; hooks?: boolean; forward?: NativeAssetHooks;
} = {}) {
  const boundary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(boundary, 'arcane-session-identity-')));
  const audit = join(directory, 'wire.jsonl'), notifyFile = join(directory, 'notify.json'), releaseFile = join(directory, 'release');
  const policy = options.policy ?? 'arcane-only';
  const lifecycle = { dispatched: 0, ended: 0, retired: 0 };
  const hooks: NativeAssetHooks = Object.freeze({
    finalCredential() { return options.forward?.finalCredential() ?? 'a'.repeat(64); },
    dispatched(intent: NativeAssetIntent) { lifecycle.dispatched++; options.forward?.dispatched(intent); },
    ended(intent: NativeAssetIntent) { lifecycle.ended++; options.forward?.ended(intent); },
    retired() { lifecycle.retired++; options.forward?.retired(); },
  });
  const session = new CodexSession({
    command: process.execPath, args: ['-e', PEER, JSON.stringify({ ackSession: SESSION, ...scenario }), audit, notifyFile, releaseFile],
    cwd: directory, env: nativeEnvironment(),
  }, limits({ requestTimeoutMs: 6000, approvalTimeoutMs: 2000 }), 'spawned-node-fixture', policy, options.hooks === false ? undefined : hooks);
  t.after(async () => {
    await session.close();
    const actual = await realpath(directory), child = relative(boundary, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-session-identity-') && !child.includes(sep) && !child.includes('..'));
    assert.ok(!(await lstat(directory)).isSymbolicLink());
    await rm(actual, { recursive: true, force: true });
  });
  const receipts = async (): Promise<Wire[]> => {
    try { return (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  await session.initialize(); session.selectModel({ ...HUMAN, ...PAIR });
  return { session, directory, lifecycle, receipts,
    notify: (value: Notification) => writeFile(notifyFile, JSON.stringify(value)),
    release: () => writeFile(releaseFile, ''),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const open = (f: Fixture, method: 'start' | 'resume') => method === 'start'
  ? f.session.startThread(HUMAN) : f.session.resumeThread({ ...HUMAN, threadId: THREAD });
function assertCanonical(snapshot: Snapshot, sessionId: string | null): void {
  assert.ok(snapshot.thread); assert.equal(snapshot.thread.threadId, THREAD); assert.equal(snapshot.thread.sessionId, sessionId);
}
async function assertFenced(f: Fixture, sessionId: string | null): Promise<void> {
  const snapshot = f.session.snapshot(); assertCanonical(snapshot, sessionId);
  assert.equal(snapshot.connected, false); assert.equal(snapshot.ready, false);
  assert.equal(snapshot.thread?.configured, false); assert.equal(snapshot.thread!.writeGranted, false);
  assert.equal(snapshot.failureCode, 'PROTOCOL'); assert.deepEqual(snapshot.approvals, []);
  assert.equal(f.lifecycle.retired, 1); assert.equal(f.lifecycle.dispatched, 0);
  assert.equal(calls(await f.receipts(), 'turn/start').length, 0);
  await assert.rejects(() => f.session.startTurn({ ...HUMAN, threadId: THREAD, text: 'Must remain unsent.' }), code('DISCONNECTED'));
  await f.session.close(); assert.equal(f.lifecycle.retired, 1);
}

for (const method of ['start', 'resume'] as const) {
  for (const ackSession of [SESSION, null]) test(method + ': matching and omitted notifications preserve canonical ACK ' + ackSession, OPTIONS, async t => {
    const f = await fixture(t, { ackSession, before: [{}, { sessionId: ackSession }, { sessionId: ackSession }], holdInventory: 1 });
    const pending = open(f, method);
    await until(async () => calls(await f.receipts(), 'mcpServerStatus/list').length === 1);
    assertCanonical(f.session.snapshot(), ackSession);
    const detached = f.session.snapshot(); detached.thread!.sessionId = OTHER;
    await f.notify({}); await until(async () => (await f.receipts()).filter(row => row.event === 'notification').length === 4);
    await f.release(); const thread = await pending;
    assert.equal(thread.sessionId, ackSession); assert.equal(thread.configured, true);
    assertCanonical(f.session.snapshot(), ackSession); assert.equal(f.lifecycle.retired, 0);
    assert.equal(calls(await f.receipts(), method === 'start' ? 'thread/start' : 'thread/resume').length, 1);
  });
  for (const [ackSession, notificationSession] of [[SESSION, OTHER], [null, OTHER], [SESSION, null]] as const) {
    test(method + ': conflicting pre-ACK notification refuses setup and retains decoded ACK ' + ackSession + '/' + notificationSession, OPTIONS, async t => {
      const f = await fixture(t, { ackSession, before: [{ sessionId: notificationSession }] });
      await assert.rejects(open(f, method), code('PROTOCOL', true));
      assert.equal(f.session.snapshot().operations[0]?.state, 'unknown');
      assert.equal(calls(await f.receipts(), 'mcpServerStatus/list').length, 0);
      await assertFenced(f, ackSession);
    });
    test(method + ': conflicting notification across inventory await cannot replace ACK ' + ackSession + '/' + notificationSession, OPTIONS, async t => {
      const f = await fixture(t, { ackSession, holdInventory: 1 }), pending = open(f, method);
      const rejected = assert.rejects(pending, code('PROTOCOL', true));
      await until(async () => calls(await f.receipts(), 'mcpServerStatus/list').length === 1);
      assertCanonical(f.session.snapshot(), ackSession);
      await f.notify({ sessionId: notificationSession }); await rejected;
      assert.equal(f.session.snapshot().operations[0]?.state, 'unknown');
      await assertFenced(f, ackSession);
    });
  }
}
for (const ackSession of [SESSION, null]) {
  test('configured same-thread conflict retires authority without replacing ACK ' + ackSession, OPTIONS, async t => {
    const f = await fixture(t, { ackSession }); await open(f, 'start');
    await f.notify({ sessionId: OTHER }); await until(() => f.lifecycle.retired === 1);
    assert.equal(f.session.snapshot().operations[0]?.state, 'acknowledged');
    await assertFenced(f, ackSession);
  });
  test('same-thread conflict during turn preflight fences an unsent turn ' + ackSession, OPTIONS, async t => {
    const f = await fixture(t, { ackSession, holdInventory: 2 }); await open(f, 'start');
    f.session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
    const pending = f.session.startTurn({ ...HUMAN, threadId: THREAD, text: 'Synthetic preflight.' });
    const rejected = assert.rejects(pending, code('PROTOCOL', false));
    await until(async () => calls(await f.receipts(), 'mcpServerStatus/list').length === 2);
    await f.notify({ sessionId: OTHER }); await rejected;
    assert.equal(f.session.snapshot().operations.length, 1);
    await assertFenced(f, ackSession);
  });
}
test('conflict on a later inventory page cannot configure the ACK tuple', OPTIONS, async t => {
  const f = await fixture(t, { holdSecondPage: true }), pending = open(f, 'start');
  const rejected = assert.rejects(pending, code('PROTOCOL', true));
  await until(async () => calls(await f.receipts(), 'mcpServerStatus/list').length === 2);
  await f.notify({ sessionId: OTHER }); await rejected; await assertFenced(f, SESSION);
});
test('conflicting provisional notifications close before ACK adoption and preserve original evidence', OPTIONS, async t => {
  const f = await fixture(t, { before: [{ sessionId: SESSION }, { sessionId: OTHER }] });
  await assert.rejects(open(f, 'start'), code('PROTOCOL', true)); await assertFenced(f, SESSION);
});
test('missing ACK session stays canonical null with omitted and explicit-null notifications', OPTIONS, async t => {
  const f = await fixture(t, { omitAck: true, before: [{}] }); await open(f, 'start');
  await f.notify({ sessionId: null }); await until(async () => (await f.receipts()).some(row => row.event === 'notification' && row.notification?.sessionId === null));
  await f.session.readAccount();
  assertCanonical(f.session.snapshot(), null); assert.equal(f.session.snapshot().ready, true); assert.equal(f.lifecycle.retired, 0);
});
test('active-turn session conflict ends intent, clears approval/grant and preserves canonical scope', OPTIONS, async t => {
  const f = await fixture(t, { activeTurn: true }); await open(f, 'start');
  f.session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  await f.session.startTurn({ ...HUMAN, threadId: THREAD, text: 'Synthetic active turn.' });
  await until(() => f.session.snapshot().approvals.length === 1);
  const before = f.session.snapshot(); assert.equal(before.approvals[0]?.canAccept, true);
  await f.notify({ sessionId: OTHER }); await until(() => f.lifecycle.retired === 1);
  const after = f.session.snapshot(); assertCanonical(after, SESSION);
  assert.equal(after.connected, false); assert.equal(after.thread?.configured, false);
  assert.equal(after.thread!.writeGranted, false); assert.deepEqual(after.approvals, []);
  assert.equal(after.thread!.turnId, before.thread?.turnId);
  assert.equal(f.lifecycle.dispatched, 1); assert.equal(f.lifecycle.ended, 1); assert.equal(f.lifecycle.retired, 1);
  await f.session.close(); assert.equal(f.lifecycle.ended, 1); assert.equal(f.lifecycle.retired, 1);
});
test('native-config without hooks preserves the successful contract and fences same-thread conflicts', OPTIONS, async t => {
  const f = await fixture(t, { before: [{ sessionId: SESSION }] }, { policy: 'native-config', hooks: false });
  await open(f, 'resume'); assertCanonical(f.session.snapshot(), SESSION);
  await f.session.startTurn({ ...HUMAN, threadId: THREAD, text: 'Synthetic legacy turn.' });
  assert.equal(f.session.snapshot().thread?.turnStatus, 'completed');
  assert.equal(calls(await f.receipts(), 'mcpServerStatus/list').length, 0);
  await f.notify({ sessionId: OTHER }); await until(() => !f.session.snapshot().connected);
  assertCanonical(f.session.snapshot(), SESSION); assert.equal(f.session.snapshot().thread?.writeGranted, false);
  assert.equal(f.lifecycle.retired, 0);
});

async function durableFixture(t: test.TestContext, scenario: Scenario) {
  let hostHooks: NativeAssetHooks | undefined, token = '';
  const forward: NativeAssetHooks = Object.freeze({
    finalCredential: () => hostHooks!.finalCredential(),
    dispatched: (value: NativeAssetIntent) => hostHooks!.dispatched(value), ended: (value: NativeAssetIntent) => hostHooks!.ended(value),
    retired: () => hostHooks?.retired(),
  });
  const f = await fixture(t, scenario, { forward });
  const registry = createNativeAssetRegistry({ projectPath: f.directory });
  const journal = join(f.directory, 'journal');
  const service = createCodexService({ directory: journal, projectPath: f.directory, assetRegistry: registry,
    connect: async hooks => { hostHooks = hooks; token = hooks!.finalCredential(); return f.session; } });
  const action = (action: 'connect' | 'thread-start') => service.action({
    requestId: randomUUID(), connectionId: action === 'connect' ? null : f.session.snapshot().connectionId, action,
  });
  await action('connect');
  return { ...f, registry, service, action, journal, token,
    async close() { await service.close(); registry.close(); } };
}
for (const ackSession of [SESSION, null]) {
  test('failed inventory identity preserves previous durable binding and never seals ' + ackSession, OPTIONS, async t => {
    const f = await durableFixture(t, { ackSession, holdInventory: 1 });
    try {
      const previous = { threadId: 'fixture.thread:recorded', sessionId: 'fixture.session:recorded' };
      const db = new DatabaseSync(join(f.journal, 'codex-actions.sqlite'));
      try { db.prepare('INSERT INTO native_history(id,project_path,thread_id,session_id,payload) VALUES(1,?,?,?,NULL)')
        .run(f.directory, previous.threadId, previous.sessionId); } finally { db.close(); }
      const pending = f.action('thread-start');
      await until(async () => calls(await f.receipts(), 'mcpServerStatus/list').length === 1);
      await f.notify({ sessionId: OTHER }); const outcome = await pending;
      assert.equal(outcome.record.state, 'unknown'); assert.equal(outcome.record.errorCode, 'PROTOCOL');
      assert.equal(outcome.state.nativeHistory?.threadId, previous.threadId);
      assert.equal(outcome.state.nativeHistory?.sessionId, previous.sessionId);
      assert.equal(outcome.state.nativeAssets?.sealed, false); assert.equal(f.registry.recognizes(f.token), false);
      await assertFenced(f, ackSession);
    } finally { await f.close(); }
  });
  test('post-seal conflict retires old actors without rewriting durable ACK scope ' + ackSession, OPTIONS, async t => {
    const f = await durableFixture(t, { ackSession });
    try {
      const opened = await f.action('thread-start');
      assert.equal(opened.record.state, 'acknowledged'); assert.equal(opened.state.nativeAssets?.sealed, true);
      const recorded = opened.state.nativeHistory; assert.equal(recorded?.sessionId, ackSession);
      const actor = f.registry.capture(f.token, 'read');
      await f.notify({ sessionId: OTHER }); await until(() => f.lifecycle.retired === 1);
      assert.deepEqual(f.service.state().nativeHistory, recorded);
      assert.equal(f.service.state().nativeAssets?.sealed, false); assert.equal(f.registry.recognizes(f.token), false);
      assert.throws(() => assertNativeAssetActor(actor, 'read'), { code: 'NATIVE_ASSET_AUTHORITY' });
      assert.throws(() => f.registry.capture(f.token, 'read'), { code: 'NATIVE_ASSET_AUTHORITY' });
      await assertFenced(f, ackSession);
    } finally { await f.close(); }
  });
}
