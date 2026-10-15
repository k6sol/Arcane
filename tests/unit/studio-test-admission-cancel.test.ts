import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fixture } from '../../packages/studio-test-controller/tests/harness.js';
import { TestLedger, readTestLedger, reviewedTestTools } from '../../packages/studio-test-controller/src/index.js';
import { createStudioTestService, type NativeTestConnection } from '../../apps/daemon/src/studio-test-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { fixtureTempDirectory, makeFixtureDirectory } from './windows-fixture-paths.js';

// Real controller, fsynced ledger, SDK and service paths with synthetic native
// peers only. No native executable, game runtime or provider is launched.
function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const kind of ['consume', 'admit'] as const) test('owned stop during durable ' + kind + ' suppresses start and joins one cleanup', { timeout: 15_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const approved = await f.approve(), entered = gate(), held = gate();
  const append = f.ledger.append.bind(f.ledger);
  f.ledger.append = async event => {
    await append(event);
    if (event.kind === kind) { entered.release(); await held.pending; }
  };
  const starting = f.control.requests.start({ proposalId: approved.proposalId, consentId: approved.consentId });
  try {
    await entered.pending;
    const admitted = f.control.requests.status(), runId = admitted.runId!;
    assert.equal(admitted.phase, 'admitting'); assert.ok(runId);
    const durable = await readTestLedger(join(f.root, 'host-ledger'), f.root);
    assert.equal(durable.at(-1)!.event.kind, kind, 'the held admission write really reached disk');
    await assert.rejects(f.control.requests.stop({ runId: 'foreign-owned-run' }), { code: 'INVALID_REQUEST' });
    assert.deepEqual(f.control.requests.status(), admitted, 'a wrong run cannot request cancellation');
    let settled = 0;
    const first = f.control.requests.stop({ runId }).then(value => { settled++; return value; });
    const second = f.control.requests.stop({ runId }).then(value => { settled++; return value; });
    const shutdown = f.control.lifecycle.shutdown().then(() => { settled++; });
    assert.deepEqual(f.control.requests.status().watchdog, { armed: false, fired: true, reason: 'CANCELLED' });
    await tick(); assert.equal(settled, 0, 'stop/shutdown wait for the owned durable admission');
    held.release();
    const initial = await starting;
    const [a, b] = await Promise.all([first, second, shutdown]);
    assert.equal(initial.runId, runId); assert.deepEqual(a, b);
    assert.equal(a.phase, 'done'); assert.equal(a.outcome, 'cancelled'); assert.equal(a.code, 'CANCELLED');
    assert.equal(a.cleanup, 'complete'); assert.equal(a.requiresHumanReview, false);
    assert.equal(f.effects().length, 0, 'neither play start nor blind stop reached the native peer');
    const records = await readTestLedger(join(f.root, 'host-ledger'), f.root);
    for (const name of ['consume', 'admit', 'terminal', 'stop_intent', 'stop_result', 'cleanup']) {
      assert.equal(records.filter(record => record.event.kind === name).length, 1, name + ' occurs once');
    }
    assert.equal(records.find(record => record.event.kind === 'terminal')!.event.outcome, 'cancelled');
    assert.equal(records.at(-1)!.event.cleanup, 'complete'); assert.equal(f.ledger.unresolved(), false);
  } finally { held.release(); await starting.catch(() => {}); }
});

test('admitting stop preserves a real ledger consent rejection instead of rewriting it as cancellation', { timeout: 15_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const approved = await f.approve(), entered = gate(), held = gate();
  const consume = f.ledger.consume.bind(f.ledger);
  f.ledger.consume = async (...args) => { entered.release(); await held.pending; return consume(...args); };
  const starting = f.control.requests.start({ proposalId: approved.proposalId, consentId: 'foreign-consent' });
  const rejected = assert.rejects(starting, { code: 'HUMAN_AUTH_REQUIRED' });
  try {
    await entered.pending;
    const runId = f.control.requests.status().runId!;
    const stopping = f.control.requests.stop({ runId });
    assert.equal(f.control.requests.status().watchdog.reason, 'CANCELLED');
    held.release(); await rejected;
    const review = await stopping;
    assert.equal(review.phase, 'done'); assert.equal(review.outcome, 'rejected');
    assert.equal(review.code, 'HUMAN_AUTH_REQUIRED'); assert.equal(review.cleanup, 'complete');
    assert.equal(f.effects().length, 0); assert.equal(f.ledger.unresolved(), false);
    const records = await readTestLedger(join(f.root, 'host-ledger'), f.root);
    assert.deepEqual(records.map(record => record.event.kind), ['consent']);
  } finally { held.release(); await rejected; }
});

test('production service cancel joins admitting run cleanup, releases the reservation and never starts play', { timeout: 15_000 }, async t => {
  const root = makeFixtureDirectory('arcane-studio-admission-'), directory = join(root, 'playtests');
  const store = new StudioStore({ directory: join(root, 'store') });
  const ARTIFACT = 'a'.repeat(64), STUDIO = 'admission-fixture-studio', NAME = 'Admission cancellation fixture', ACTOR = 'fixture-agent';
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1,
    identity: { clientSessionId: 'admission-fixture-lifetime', placeId: 0, universeId: 0, name: NAME, pluginVersion: 'fixture-only' },
    capabilities: ['scene.children'] });
  store.authenticate(pair.sessionId, pair.token);
  store.poll(pair.sessionId, { sessionId: pair.sessionId, clientLifetimeId: 'admission-fixture-lifetime',
    pluginArtifactHash: ARTIFACT, markerName: 'ArcaneTestProof_admission_fixture', placeId: 0, universeId: 0,
    placeName: NAME, mode: 'Edit', playEpoch: 20, continuitySupported: true, connected: true });
  const client = new Client({ name: 'fixture-admission-client', version: 'fixture-only' });
  const server = new Server({ name: 'fixture-not-RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const effects: unknown[] = [];
  const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone([...reviewedTestTools]) }));
  server.setRequestHandler(CallToolRequestSchema, request => {
    const { name, arguments: args } = request.params;
    if (name === 'list_roblox_studios') return text(JSON.stringify({ studios: [{ id: STUDIO, name: NAME }] }));
    assert.equal(args?.studio_id, STUDIO);
    if (name === 'get_studio_state') return text('- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit');
    if (name === 'get_console_output') return text('');
    assert.equal(name, 'start_stop_play'); effects.push(structuredClone(args));
    throw new Error('A cancelled admitting run must not dispatch a native mutation.');
  });
  await server.connect(serverTransport); await client.connect(clientTransport);
  let closes = 0;
  const connection: NativeTestConnection = { client, evidence: 'fixture',
    async witness(studioId, markerName, mode, signal) {
      assert.equal(studioId, STUDIO); assert.equal(markerName, 'ArcaneTestProof_admission_fixture');
      assert.equal(mode, 'Edit'); assert.equal(signal.aborted, false);
      return { placeId: 0, universeId: 0, placeName: NAME, sessionId: pair.sessionId,
        clientLifetimeId: 'admission-fixture-lifetime', pluginArtifactHash: ARTIFACT };
    },
    async close() { if (closes) return; closes++; await client.close(); await server.close(); },
  };
  const service = await createStudioTestService({ directory, store, pluginArtifactHash: ARTIFACT, connect: async () => connection });
  t.after(async () => {
    try { await service.lifecycle.close(); await connection.close(); }
    finally {
      store.close(); const path = relative(fixtureTempDirectory(), root);
      assert.ok(!isAbsolute(path) && !path.startsWith('..') && path.startsWith('arcane-studio-admission-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
  const job = await service.requests.prepare({ sessionId: pair.sessionId, nativeStudioId: STUDIO, durationMs: 5_000,
    observationIntervalMs: 1_000, failOnRuntimeError: true }, ACTOR);
  const entered = gate(), held = gate(), consume = TestLedger.prototype.consume;
  t.mock.method(TestLedger.prototype, 'consume', async function(this: TestLedger, ...args: Parameters<TestLedger['consume']>) {
    await consume.apply(this, args); entered.release(); await held.pending;
  });
  const approving = service.humanControl.approve({ id: job.id, displayDigest: job.displayDigest }, () => {});
  try {
    await entered.pending;
    assert.equal(service.requests.status(job.id, ACTOR).review.phase, 'admitting');
    assert.throws(() => store.enqueue({ sessionId: pair.sessionId, requestId: 'while-admitting',
      method: 'scene.children', args: { root: 'Workspace' } }), { code: 'BUSY' });
    await assert.rejects(service.requests.cancel(job.id, 'foreign-agent'), { code: 'HUMAN_AUTH_REQUIRED' });
    let settled = false;
    const first = service.requests.cancel(job.id, ACTOR).then(value => { settled = true; return value; });
    const second = service.requests.cancel(job.id, ACTOR);
    await tick(); assert.equal(settled, false);
    assert.equal(service.requests.status(job.id, ACTOR).review.watchdog.reason, 'CANCELLED');
    held.release(); await approving;
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b); assert.equal(a.state, 'cancelled'); assert.equal(a.review.outcome, 'cancelled');
    assert.equal(a.review.code, 'CANCELLED'); assert.equal(a.review.cleanup, 'complete');
    assert.equal(a.review.canStartAnotherOperation, true); assert.equal(a.nativeAcceptance, false);
    assert.deepEqual(effects, []); assert.equal(closes, 1);
    const records = await readTestLedger(join(directory, 'ledger'), directory);
    assert.equal(records.filter(record => record.event.kind === 'terminal').length, 1);
    assert.equal(records.filter(record => record.event.kind === 'cleanup').length, 1);
    assert.equal(records.at(-1)!.event.cleanup, 'complete');
    assert.equal(store.enqueue({ sessionId: pair.sessionId, requestId: 'after-cancel',
      method: 'scene.children', args: { root: 'Workspace' } }).state, 'queued');
  } finally { held.release(); await approving.catch(() => {}); }
});
