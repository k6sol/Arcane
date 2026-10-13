import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { CODEX_LIMITS, CodexClientError, type NativeAssetHooks, type Snapshot } from '../../packages/codex-client/src/types.js';

const HUMAN = { initiatedBy: 'human' } as const;
const OPTIONS = { timeout: 12_000 };
interface Wire { event: string; method?: string; params?: Record<string, unknown>; read?: number; authMode?: string | null }
interface Reply { plan?: string; signedOut?: boolean; notifications?: (string | null)[]; incomplete?: boolean; missingAccount?: boolean }

// The real transport spawns only Node. This peer consumes owned fixture gates
// and synthetic JSONL; it never invokes a provider, reads auth/config or infers.
function protocolPeer(): void {
  const { createInterface } = require('node:readline') as typeof import('node:readline');
  const { appendFileSync, existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const [directory, encoded] = process.argv.slice(1);
  const before = JSON.parse(encoded!) as (string | null)[];
  const audit = join(directory!, 'wire.jsonl');
  let reads = 0, notificationNumber = 1;
  const record = (value: object) => appendFileSync(audit, JSON.stringify(value) + '\n');
  const send = (...messages: object[]) => process.stdout.write(messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  const notification = (authMode: string | null) => {
    record({ event: 'notification', authMode });
    return { method: 'account/updated', params: { authMode } };
  };
  const gated = (name: string, reply: (value: Reply) => void) => {
    const file = join(directory!, name);
    const timer = setInterval(() => {
      if (existsSync(file + '.ready')) { clearInterval(timer); reply(JSON.parse(readFileSync(file, 'utf8')) as Reply); }
    }, 5);
  };
  setInterval(() => {
    const file = join(directory!, 'notify-' + notificationNumber + '.json');
    if (existsSync(file + '.ready')) {
      notificationNumber++;
      send(notification(JSON.parse(readFileSync(file, 'utf8')) as string | null));
    }
  }, 5);
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    record({ event: 'request', method, params });
    if (method === 'initialized') return;
    if (method === 'initialize') { send(...before.map(notification), { id, result: {} }); return; }
    if (method === 'account/read') {
      const read = ++reads;
      gated('account-' + read + '.json', value => {
        record({ event: 'account-response', read });
        const result = {
          ...(value.missingAccount ? {} : { account: value.signedOut ? null : { type: 'chatgpt', planType: value.plan ?? 'plus' } }),
          ...(value.incomplete ? {} : { requiresOpenaiAuth: true }),
        };
        // One write fixes notification-before-response ordering without sleeps.
        send(...(value.notifications ?? []).map(notification), { id, result });
      });
      return;
    }
    if (method === 'model/list') {
      gated('models.json', () => {
        record({ event: 'model-response' });
        send({ id, result: { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } });
      });
      return;
    }
    throw new Error('Unexpected bootstrap fixture request: ' + method);
  });
}
const PEER = '(' + protocolPeer.toString() + ')();';
const calls = (wire: Wire[], method: string) => wire.filter(row => row.event === 'request' && row.method === method);
const code = (expected: string) => (error: unknown) => error instanceof CodexClientError && error.code === expected;
const observe = <T>(promise: Promise<T>) => promise.then(
  value => ({ ok: true, value }) as const,
  error => ({ ok: false, error: error as unknown }) as const,
);

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { if (Date.now() >= deadline) assert.fail('Bootstrap fixture gate timed out.'); await delay(5); }
}
async function fixture(t: test.TestContext, before: (string | null)[] = [], retireThrows = false) {
  const boundary = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(boundary, 'arcane-bootstrap-auth-')));
  const lifecycle = { issued: 0, dispatched: 0, ended: 0, retired: 0,
    state: 'UNBOUND' as 'UNBOUND' | 'RETIRED', retirementSnapshots: [] as Snapshot[] };
  let session!: CodexSession;
  const hooks: NativeAssetHooks = Object.freeze({
    finalCredential() { lifecycle.issued++; return 'c6'.repeat(32); },
    dispatched() { lifecycle.dispatched++; },
    ended() { lifecycle.ended++; },
    retired() {
      lifecycle.retired++; lifecycle.state = 'RETIRED';
      lifecycle.retirementSnapshots.push(session.snapshot());
      if (retireThrows) throw new Error('Synthetic retirement callback failure.');
    },
  });
  // Emulate the trusted final-launch host's freshly issued UNBOUND key. Neither
  // the public installed-CLI factory nor a real authority registry is invoked.
  assert.equal(hooks.finalCredential().length, 64);
  session = new CodexSession({ command: process.execPath,
    args: ['-e', PEER, directory, JSON.stringify(before)], cwd: directory, env: nativeEnvironment(),
  }, CODEX_LIMITS, 'spawned-node-fixture', 'arcane-only', hooks);
  t.after(async () => {
    await session.close();
    const actual = await realpath(directory), child = relative(boundary, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-bootstrap-auth-') && !child.includes(sep) && !child.includes('..'));
    assert.ok(!(await lstat(directory)).isSymbolicLink());
    await rm(actual, { recursive: true, force: true });
  });
  const receipts = async (): Promise<Wire[]> => {
    try { return (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const gate = async (name: string, value: unknown) => {
    const file = join(directory, name);
    await writeFile(file, JSON.stringify(value));
    await writeFile(file + '.ready', 'ready'); // Publish only after JSON is complete.
  };
  let notificationNumber = 0;
  return { session, lifecycle, receipts,
    waitRead: (read: number) => until(async () => {
      assert.equal(session.snapshot().connected, true, 'Transport must remain live before the next metadata read.');
      return calls(await receipts(), 'account/read').length === read;
    }),
    account: (read: number, reply: Reply = {}) => gate('account-' + read + '.json', reply),
    models: () => gate('models.json', {}),
    notify: async (authMode: string | null) => {
      const count = session.snapshot().events.filter(event => event.type === 'account-changed').length;
      await gate('notify-' + (++notificationNumber) + '.json', authMode);
      await until(() => session.snapshot().events.filter(event => event.type === 'account-changed').length === count + 1);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertMetadataOnly(f: Fixture, reads: number): Promise<void> {
  const wire = await f.receipts();
  assert.equal(calls(wire, 'initialize').length, 1);
  assert.equal(calls(wire, 'initialized').length, 1);
  assert.equal(calls(wire, 'model/list').length, 1);
  assert.equal(calls(wire, 'account/read').length, reads);
  for (const row of calls(wire, 'account/read')) assert.deepEqual(row.params, { refreshToken: false });
  assert.ok(wire.filter(row => row.event === 'request').every(row =>
    ['initialize', 'initialized', 'account/read', 'model/list'].includes(row.method!)), 'Only read-only bootstrap RPCs may cross stdio.');
  assert.equal(f.lifecycle.issued, 1);
  assert.equal(f.lifecycle.dispatched, 0);
  assert.equal(f.lifecycle.ended, 0);
  assert.equal(f.session.snapshot().thread, null);
  assert.deepEqual(f.session.snapshot().operations, []);
  assert.deepEqual(f.session.snapshot().approvals, []);
}
async function assertFresh(f: Fixture, plan: string | null, reads: number, signedOut = false): Promise<void> {
  const snapshot = f.session.snapshot();
  assert.equal(snapshot.connected, true); assert.equal(snapshot.ready, true);
  assert.equal(snapshot.failureCode, null); assert.equal(snapshot.provenance, 'spawned-node-fixture');
  assert.deepEqual(snapshot.account, { auth: signedOut ? 'signed-out' : 'subscription', plan, requiresOpenaiAuth: true });
  assert.equal(snapshot.selection, null); assert.equal(snapshot.mcpIsolation, 'arcane-only-pending');
  assert.deepEqual(snapshot.models.map(model => [model.model, model.entitlement]), [['fixture-model', 'unverified']]);
  assert.equal(f.lifecycle.state, 'UNBOUND'); assert.equal(f.lifecycle.retired, 0);
  await assertMetadataOnly(f, reads);
}

for (const [name, before] of [
  ['quiet startup', []], ['ChatGPT announcement before initialize ACK', ['chatgpt']],
  ['duplicate ChatGPT announcements before the first read', ['chatgpt', 'chatgpt']],
] as const) {
  test(name + ' preserves the fresh UNBOUND key and complete metadata', OPTIONS, async t => {
    const f = await fixture(t, [...before]), initializing = observe(f.session.initialize());
    await f.waitRead(1); await f.account(1, { plan: 'pro' }); await f.models();
    assert.equal((await initializing).ok, true);
    assert.equal(f.session.snapshot().events.filter(event => event.type === 'account-changed').length, before.length);
    await assertFresh(f, 'pro', 1);
  });
}

for (const modelFirst of [false, true]) {
  test('ChatGPT announcement during initial read reconciles fresh metadata, models ' + (modelFirst ? 'first' : 'last'), OPTIONS, async t => {
    const f = await fixture(t), initializing = observe(f.session.initialize());
    await f.waitRead(1);
    if (modelFirst) { await f.models(); await until(() => f.session.snapshot().models.length === 1); }
    await f.notify('chatgpt');
    assert.equal(f.session.snapshot().ready, false); assert.equal(f.session.snapshot().account, null);
    assert.equal(f.lifecycle.retired, 0);
    await f.account(1, { plan: 'plus' });
    if (!modelFirst) await f.models();
    await f.waitRead(2);
    assert.equal(f.session.snapshot().ready, false);
    await f.account(2, { plan: 'pro' });
    assert.equal((await initializing).ok, true);
    await assertFresh(f, 'pro', 2);
  });
}

test('announcement after initial account settles and before model response requires an account reread', OPTIONS, async t => {
  const f = await fixture(t), initializing = observe(f.session.initialize());
  await f.waitRead(1); await f.account(1, { plan: 'plus' });
  await until(() => f.session.snapshot().account?.plan === 'plus');
  assert.equal(f.session.snapshot().models.length, 0);
  await f.notify('chatgpt');
  assert.equal(f.session.snapshot().account, null); assert.equal(f.lifecycle.retired, 0);
  await f.models(); await f.waitRead(2);
  assert.equal(f.session.snapshot().ready, false);
  await f.account(2, { plan: 'pro' });
  assert.equal((await initializing).ok, true);
  await assertFresh(f, 'pro', 2);
  const wire = await f.receipts();
  const firstResponse = wire.findIndex(row => row.event === 'account-response' && row.read === 1);
  const notification = wire.findIndex(row => row.event === 'notification');
  const modelResponse = wire.findIndex(row => row.event === 'model-response');
  assert.ok(firstResponse < notification && notification < modelResponse);
});

test('the second additional account read may stabilize; the catalogue is never retried', OPTIONS, async t => {
  const f = await fixture(t), initializing = observe(f.session.initialize());
  await f.waitRead(1); await f.account(1, { notifications: ['chatgpt'], plan: 'plus' }); await f.models();
  await f.waitRead(2); await f.account(2, { notifications: ['chatgpt'], plan: 'pro' });
  await f.waitRead(3);
  assert.equal(f.session.snapshot().ready, false); assert.equal(f.lifecycle.retired, 0);
  await f.account(3, { plan: 'business' });
  assert.equal((await initializing).ok, true);
  await assertFresh(f, 'business', 3);
});

for (const retireThrows of [false, true]) {
  test('continued bootstrap churn fails closed after exactly two extra reads' + (retireThrows ? ' even if retirement throws' : ''), OPTIONS, async t => {
    const f = await fixture(t, [], retireThrows), initializing = observe(f.session.initialize());
    await f.waitRead(1); await f.account(1, { notifications: ['chatgpt'] }); await f.models();
    await f.waitRead(2); await f.account(2, { notifications: ['chatgpt'] });
    await f.waitRead(3); await f.account(3, { notifications: ['chatgpt'] });
    const outcome = await initializing;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(code('ACCOUNT_CHANGED')(outcome.error));
    const snapshot = f.session.snapshot();
    assert.equal(snapshot.connected, false); assert.equal(snapshot.ready, false);
    assert.equal(snapshot.failureCode, 'ACCOUNT_CHANGED');
    assert.equal(f.lifecycle.state, 'RETIRED'); assert.equal(f.lifecycle.retired, 1);
    assert.equal(f.lifecycle.retirementSnapshots[0]?.connected, false, 'Transport stop retires hooks synchronously.');
    await assertMetadataOnly(f, 3);
    await assert.rejects(() => f.session.readAccount(), code('DISCONNECTED'));
    await f.session.close(); await f.session.close();
    assert.equal(f.lifecycle.retired, 1);
    await assertMetadataOnly(f, 3);
  });
}

for (const missing of ['incomplete', 'missingAccount'] as const) for (const read of [1, 2]) {
  test('an account response missing ' + missing + ' on read ' + read + ' cannot count as stable bootstrap metadata', OPTIONS, async t => {
    const f = await fixture(t), initializing = observe(f.session.initialize());
    await f.waitRead(1); await f.models();
    if (read === 2) { await f.account(1, { notifications: ['chatgpt'] }); await f.waitRead(2); }
    await f.account(read, { [missing]: true });
    const outcome = await initializing;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(code('PROTOCOL')(outcome.error));
    assert.equal(f.session.snapshot().connected, false); assert.equal(f.session.snapshot().ready, false);
    assert.equal(f.session.snapshot().failureCode, 'PROTOCOL'); assert.equal(f.lifecycle.retired, 1);
    await assertMetadataOnly(f, read);
  });
}

for (const authMode of ['chatgpt', 'apikey', null]) {
  test('post-ready account/updated ' + String(authMode) + ' retires before pending future metadata settles', OPTIONS, async t => {
    const f = await fixture(t), initializing = observe(f.session.initialize());
    await f.waitRead(1); await f.account(1); await f.models();
    assert.equal((await initializing).ok, true); await assertFresh(f, 'plus', 1);
    let settled = false;
    const reading = observe(f.session.readAccount().finally(() => { settled = true; }));
    await f.waitRead(2); await f.notify(authMode);
    assert.equal(settled, false); assert.equal(f.lifecycle.retired, 1);
    assert.equal(f.lifecycle.state, 'RETIRED'); assert.equal(f.session.snapshot().ready, false);
    assert.equal(f.session.snapshot().account, null);
    assert.equal(f.lifecycle.retirementSnapshots[0]?.account?.plan, 'plus');
    assert.equal(f.session.snapshot().connected, true);
    await f.account(2, { plan: 'pro' });
    assert.equal((await reading).ok, true);
    assert.equal(f.session.snapshot().account?.plan, 'pro'); assert.equal(f.session.snapshot().ready, false);
    assert.throws(() => f.session.selectModel({ ...HUMAN, model: 'fixture-model', effort: 'low' }), code('DISCONNECTED'));
    await assert.rejects(() => f.session.startThread(HUMAN), code('DISCONNECTED'));
    await assert.rejects(() => f.session.readAccount(), code('DISCONNECTED'));
    await f.session.close(); await f.session.close();
    assert.equal(f.lifecycle.retired, 1);
    await assertMetadataOnly(f, 2);
  });
}

for (const announced of [false, true]) {
  test('signed-out startup ' + (announced ? 'with a bootstrap announcement' : 'without announcements') + ' connects metadata without thread or model authority', OPTIONS, async t => {
    const f = await fixture(t, announced ? ['chatgpt'] : []), initializing = observe(f.session.initialize());
    await f.waitRead(1); await f.account(1, { signedOut: true }); await f.models();
    assert.equal((await initializing).ok, true); await assertFresh(f, null, 1, true);
    // Catalogue selection alone conveys no subscription entitlement or grant.
    f.session.selectModel({ ...HUMAN, model: 'fixture-model', effort: 'low' });
    await assert.rejects(() => f.session.startThread(HUMAN), code('SUBSCRIPTION_REQUIRED'));
    await assert.rejects(() => f.session.resumeThread({ ...HUMAN, threadId: 'fixture-thread' }), code('SUBSCRIPTION_REQUIRED'));
    assert.throws(() => f.session.grantThreadWrites({ ...HUMAN, threadId: 'fixture-thread' }), code('SUBSCRIPTION_REQUIRED'));
    assert.equal(f.lifecycle.retired, 0);
    await assertMetadataOnly(f, 1);
  });
}
