import test, { describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createStudioTestService, type NativeTestConnection, type StudioTestService,
  type StudioTestView } from '../../apps/daemon/src/studio-test-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { digest, readTestLedger, reviewedTestTools } from '../../packages/studio-test-controller/src/index.js';
import { fixtureTempDirectory, makeFixtureDirectory } from './windows-fixture-paths.js';
import { playtestJob } from '../../apps/mcp/src/playtest-schemas.js';

// End-to-end SERVICE fixtures: real SDK Client/Server, authenticated StudioStore
// heartbeats, SQLite and the fsynced ledger. No native executable, HTTP human
// authentication, CLI, provider or fabricated engine completion is exercised.
const ACTOR = 'agent-fixture-a', OTHER = 'agent-fixture-b', HUMAN = 'human';
const ARTIFACT = 'a'.repeat(64), STUDIO = 'studio-service-fixture';
const NAME = 'Stored unpublished service fixture';
const MARKER = 'ArcaneTestProof_service_fixture';
type Witness = Awaited<ReturnType<NativeTestConnection['witness']>>;
type Observation = {
  sessionId: string; clientLifetimeId: string; pluginArtifactHash: string; markerName: string;
  placeId: number; universeId: number; placeName: string; mode: 'Edit' | 'Play';
  playEpoch: number; continuitySupported: boolean; connected: boolean;
};
type Call = { name: string; args: Record<string, unknown> };
type Hooks = {
  connect?: () => Promise<void>;
  witness?: (value: Witness, signal: AbortSignal) => Promise<Witness>;
  afterEffect?: (call: Call, signal: AbortSignal) => Promise<CallToolResult>;
};
const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const approval = (job: StudioTestView) => ({ id: job.id, displayDigest: job.displayDigest });
function report(job: StudioTestView): StudioTestView {
  // Validate actual production service snapshots, not just hand-authored wire
  // fixtures. Parsing must preserve honest controller cleanup/evidence fields.
  assert.deepEqual(playtestJob.parse(job), job);
  return job;
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'service fixture did not reach the expected state');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, options: {
  allowedRoots?: ('Workspace' | 'ServerStorage')[]; allowWrites?: boolean;
  placeId?: number; universeId?: number; publish?: boolean;
  storeTimeOffset?: number; proof?: Partial<Observation>;
} = {}) {
  const root = makeFixtureDirectory('arcane-studio-test-service-');
  const directory = join(root, 'service'), storeDirectory = join(root, 'store');
  let storeTimeOffset = options.storeTimeOffset ?? 0;
  const store = new StudioStore({ directory: storeDirectory, now: () => Date.now() + storeTimeOffset });
  const services: StudioTestService[] = [], connections: NativeTestConnection[] = [];
  t.after(async () => {
    try {
      for (const service of services) await service.lifecycle.close();
      for (const connection of connections) await connection.close();
    } finally {
      store.close();
      const path = relative(fixtureTempDirectory(), root);
      assert.ok(!isAbsolute(path) && !path.startsWith('..') && path.startsWith('arcane-studio-test-service-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Explicit writable scope is independent of the later human test consent.
  const withWriteGrant = store.createGrant({
    allowedRoots: options.allowedRoots ?? ['Workspace', 'ServerStorage'],
    allowWrites: options.allowWrites ?? true,
  });
  const pair = store.pair({ code: withWriteGrant.code, protocolVersion: 1,
    identity: { clientSessionId: 'plugin-service-fixture-lifetime', placeId: options.placeId ?? 0,
      universeId: options.universeId ?? 0, name: NAME, pluginVersion: 'fixture-only' },
    capabilities: ['scene.children'] });
  const state = { mode: 'Edit' as 'Edit' | 'Play', epoch: 20, consoleText: '',
    inventory: [{ id: STUDIO, name: NAME }], connects: 0, closes: 0, lists: 0 };
  const hooks: Hooks = {}, calls: Call[] = [];
  const witnesses: { studioId: string; markerName: string; mode: 'Edit' | 'Play'; signal: AbortSignal }[] = [];
  const transitions: { mode: 'Edit' | 'Play'; epoch: number; intent: string }[] = [];
  const observation = (changes: Partial<Observation> = {}): Observation => {
    const s = store.session(pair.sessionId);
    return { sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT,
      markerName: MARKER, placeId: s.placeId, universeId: s.universeId, placeName: s.name,
      mode: state.mode, playEpoch: state.epoch, continuitySupported: true, connected: true, ...changes };
  };
  const poll = (proof: unknown) => {
    store.authenticate(pair.sessionId, pair.token);
    return store.poll(pair.sessionId, proof);
  };
  const publish = (changes: Partial<Observation> = {}) => poll(observation(changes));
  if (options.publish !== false) publish(options.proof);
  const records = () => readTestLedger(join(directory, 'ledger'), directory);
  const connect = async (): Promise<NativeTestConnection> => {
    state.connects++;
    await hooks.connect?.();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fixture-studio-test-service-client', version: 'fixture-only' }, { capabilities: {} });
    const server = new Server({ name: 'fixture-not-RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => {
      state.lists++;
      return { tools: structuredClone([...reviewedTestTools]) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const call = { name: request.params.name, args: request.params.arguments ?? {} };
      calls.push(structuredClone(call));
      if (call.name === 'list_roblox_studios') {
        assert.deepEqual(call.args, {});
        return text(JSON.stringify({ studios: state.inventory }));
      }
      assert.equal(call.args.studio_id, STUDIO);
      if (call.name === 'get_studio_state') {
        assert.deepEqual(call.args, { studio_id: STUDIO });
        // The production decoder accepts this single successful text envelope
        // and these exact three lines; JSON state would not exercise the service.
        return text(state.mode === 'Edit'
          ? '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit'
          : '- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
      }
      if (call.name === 'get_console_output') {
        assert.deepEqual(call.args, { studio_id: STUDIO });
        return text(state.mode === 'Edit' ? '' : state.consoleText);
      }
      assert.equal(call.name, 'start_stop_play', 'only reviewed test tools may be called');
      assert.equal(typeof call.args.is_start, 'boolean');
      assert.deepEqual(Object.keys(call.args).sort(), ['is_start', 'studio_id']);
      const journal = await records();
      const intent = call.args.is_start ? 'start_intent' : 'stop_intent';
      assert.equal(journal.at(-1)?.event.kind, intent, 'effect must follow a genuine durable intent');
      assert.equal(journal.filter(record => record.event.kind === 'consume').length, 1);
      assert.ok(journal.every(record => record.event.evidence === 'fixture'));
      state.mode = call.args.is_start ? 'Play' : 'Edit';
      state.epoch++;
      assert.deepEqual(publish(), []);
      const proof = store.session(pair.sessionId).proof;
      assert.equal(proof?.mode, state.mode);
      assert.equal(proof?.playEpoch, state.epoch);
      transitions.push({ mode: state.mode, epoch: state.epoch, intent });
      // Publish the authenticated, epoch-latched heartbeat BEFORE the SDK ACK.
      return hooks.afterEffect ? hooks.afterEffect(call, extra.signal) : text('fixture acknowledgement');
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let closed = false;
    const connection: NativeTestConnection = {
      client, evidence: 'fixture',
      async witness(studioId, markerName, mode, signal) {
        witnesses.push({ studioId, markerName, mode, signal });
        assert.equal(studioId, STUDIO);
        assert.equal(markerName, MARKER);
        assert.equal(mode, state.mode);
        assert.equal(signal.aborted, false);
        // Independent trusted fixture witness; neither tool text nor request
        // JSON supplies its exact paired identity or stored place name.
        const s = store.session(pair.sessionId);
        const value: Witness = { placeId: s.placeId, universeId: s.universeId, placeName: s.name,
          sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT };
        return hooks.witness ? hooks.witness(value, signal) : value;
      },
      async close() {
        if (closed) return;
        closed = true; state.closes++;
        await client.close(); await server.close();
      },
    };
    connections.push(connection);
    return connection;
  };
  const openService = async () => {
    const service = await createStudioTestService({ directory, store, pluginArtifactHash: ARTIFACT, connect });
    services.push(service);
    return service;
  };
  const service = await openService();
  const request = { sessionId: pair.sessionId, nativeStudioId: STUDIO, durationMs: 5_000,
    observationIntervalMs: 1_000, failOnRuntimeError: true };
  const prepare = async (actor = ACTOR) => report(await service.requests.prepare(request, actor));
  const status = (job: StudioTestView, actor = ACTOR) => report(service.requests.status(job.id, actor));
  const effects = () => calls.filter(call => call.name === 'start_stop_play');
  const scene = (requestId: string) => store.enqueue({ sessionId: pair.sessionId, requestId,
    method: 'scene.children', args: { root: 'Workspace' } });
  return { root, directory, storeDirectory, store, pair, state, hooks, calls, witnesses, transitions,
    connections, observation, poll, publish, records, service, openService, request, prepare, status,
    effects, scene, moveStoreTime: (ms: number) => { storeTimeOffset += ms; } };
}

// Serial cases retain their own 30-second budgets. Their cumulative fixture and
// fsync cost must not cancel later cases under a shared parent test deadline.
// The sole Date.now override is restored before teardown or another fixture.
describe('createStudioTestService: SDK/store/ledger fixture integration', { concurrency: false }, () => {
  function serviceCase(name: string, body: (sub: TestContext) => Promise<void>): void {
    test(name, { timeout: 30_000 }, body);
  }
  serviceCase('prepare needs approval without effects; model port cannot approve and trusted guard must pass', async sub => {
    const f = await fixture(sub);
    const job = await f.prepare();
    assert.equal(job.state, 'needs_approval');
    assert.equal(job.actor, ACTOR);
    assert.equal(job.targetName, NAME);
    assert.equal(job.evidence, 'fixture');
    assert.equal(job.nativeAcceptance, false);
    assert.equal(job.review.evidence, 'fixture');
    assert.equal(job.review.nativeAcceptance, false);
    assert.equal(job.review.runId, null);
    assert.equal(job.review.cleanup, 'not_started');
    assert.equal(job.displayDigest, digest(job.display));
    assert.deepEqual(Object.keys(f.service.requests).sort(), ['cancel', 'capture', 'list', 'prepare', 'status']);
    assert.equal('approve' in f.service.requests, false);
    assert.deepEqual(f.effects(), []);
    assert.deepEqual(await f.records(), []);
    assert.deepEqual(f.store.commands(), []);
    assert.ok(f.witnesses.length >= 2);
    assert.ok(f.state.lists > 0);
    const denied = new Error('fixture trusted HumanPort guard refused model audience');
    let checks = 0;
    await assert.rejects(f.service.humanControl.approve(approval(job), () => { checks++; throw denied; }), error => error === denied);
    assert.equal(checks, 1);
    assert.deepEqual(await f.records(), []);
    assert.deepEqual(f.effects(), []);
    // Pairing writes and preparation do not reserve the scene queue.
    const queued = f.scene('pending-scene-fixture');
    assert.equal(queued.state, 'queued');
    const cancelled = report(await f.service.requests.cancel(job.id, ACTOR));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(f.state.closes, 1);
    assert.equal(f.store.command(queued.id).state, 'queued');
    await assert.rejects(f.service.humanControl.approve(approval(job), () => {}), { code: 'HUMAN_AUTH_REQUIRED' });
    assert.deepEqual(f.effects(), []);
  });

  serviceCase('exact scoped approval runs a real five-second bound, observes, stops and releases scene queue', async sub => {
    const f = await fixture(sub);
    const proof = f.store.session(f.pair.sessionId).proof!;
    assert.equal(Object.keys(f.observation()).length, 11);
    assert.equal(Date.parse(proof.expiresAt) - Date.parse(proof.observedAt), 6_000);
    const job = await f.prepare();
    assert.deepEqual(job.display.proposal.binding, { nativeStudioId: STUDIO, pairedSessionId: f.pair.sessionId,
      clientLifetimeId: proof.clientLifetimeId, pluginArtifactHash: ARTIFACT,
      scopeRevision: digest({ sessionId: f.pair.sessionId, clientLifetimeId: proof.clientLifetimeId,
        placeId: 0, universeId: 0, name: NAME, roots: ['Workspace', 'ServerStorage'], writes: true, revoked: null }), placeId: 0 });
    assert.deepEqual(job.display.actions, ['start', 'observe-state-and-console', 'stop-owned-play']);
    assert.equal(job.display.proposal.durationMs, 5_000);
    assert.equal(job.display.guarantee, 'observed-non-atomic');
    let checks = 0;
    const started = await f.service.humanControl.approve(approval(job), () => { checks++; });
    assert.equal(checks, 2);
    assert.equal(started.state, 'running');
    assert.equal(started.review.scopeDigest, job.displayDigest);
    assert.throws(() => f.scene('running-scene-fixture'), { code: 'BUSY' });
    f.store.releaseTest(f.pair.sessionId, 'foreign-fixture-owner');
    assert.throws(() => f.scene('foreign-release-fixture'), { code: 'BUSY' });
    await until(() => f.status(job).review.phase === 'waiting');
    assert.deepEqual(f.effects().map(call => call.args.is_start), [true]);
    await assert.rejects(f.prepare(OTHER), { code: 'BUSY' });
    await assert.rejects(f.service.humanControl.approve(approval(job), () => {}), { code: 'HUMAN_AUTH_REQUIRED' });
    // Only real timers drive completion. Status reads do not advance time.
    await until(() => f.status(job).review.phase === 'done' && f.state.closes === 1);
    const complete = f.status(job);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.review.outcome, 'succeeded');
    assert.equal(complete.review.code, 'OK');
    assert.equal(complete.review.cleanup, 'complete');
    assert.equal(complete.review.requiresHumanReview, false);
    assert.equal(complete.review.canStartAnotherOperation, true);
    assert.equal(complete.review.watchdog.armed, false);
    // At the deadline the observation delay can win the timer race and leave
    // the loop normally. Both paths must respect the same bound and cleanup.
    assert.equal(complete.review.watchdog.reason, complete.review.watchdog.fired ? 'DURATION_EXPIRED' : null);
    assert.equal(complete.review.deadline! - complete.review.startedAt!, 5_000);
    assert.ok(complete.review.observations >= 1 && complete.review.observations <= 5);
    assert.deepEqual(complete.review.logs, []); // Empty successful text is accepted by the current parser.
    assert.equal(complete.evidence, 'fixture');
    assert.equal(complete.nativeAcceptance, false);
    assert.deepEqual(f.transitions, [{ mode: 'Play', epoch: 21, intent: 'start_intent' },
      { mode: 'Edit', epoch: 22, intent: 'stop_intent' }]);
    assert.deepEqual(f.effects().map(call => call.args), [
      { studio_id: STUDIO, is_start: true }, { studio_id: STUDIO, is_start: false }]);
    assert.equal(f.store.session(f.pair.sessionId).proof?.playEpoch, 22);
    const journal = await f.records(), kinds = journal.map(record => record.event.kind);
    assert.deepEqual(kinds.slice(0, 5), ['consent', 'consume', 'admit', 'start_intent', 'start_result']);
    assert.deepEqual(kinds.slice(-4), ['terminal', 'stop_intent', 'stop_result', 'cleanup']);
    const watchdog = journal.filter(record => record.event.kind === 'watchdog');
    assert.equal(watchdog.length, complete.review.watchdog.fired ? 1 : 0);
    if (watchdog.length) assert.equal(watchdog[0]!.event.code, 'DURATION_EXPIRED');
    assert.equal(kinds.filter(kind => kind === 'observe').length, complete.review.observations);
    const terminal = journal.filter(record => record.event.kind === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.event.outcome, 'succeeded');
    assert.equal(terminal[0]!.event.id, complete.review.runId);
    assert.ok(terminal[0]!.event.at >= complete.review.deadline!);
    assert.ok(journal.every(record => record.event.evidence === 'fixture' && record.event.scopeDigest === job.displayDigest));
    assert.equal(journal.at(-1)?.event.cleanup, 'complete');
    const lateCancel = report(await f.service.requests.cancel(job.id, ACTOR));
    assert.equal(lateCancel.state, 'complete', 'late cancel preserves an already completed report');
    assert.deepEqual(lateCancel.review, complete.review);
    assert.deepEqual(await f.records(), journal, 'late cancellation does not rewrite the recorded outcome');
    assert.equal(readFileSync(join(f.storeDirectory, 'studio.sqlite')).subarray(0, 16).toString(), 'SQLite format 3\0');
    const queued = f.scene('released-scene-fixture');
    assert.equal(queued.state, 'queued');
    const sqlite = new DatabaseSync(join(f.storeDirectory, 'studio.sqlite'), { readOnly: true, allowExtension: false });
    try {
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events WHERE kind='command_queued' AND entity_id=?").get(queued.id)?.n, 1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM commands WHERE state='succeeded'").get()?.n, 0);
    } finally { sqlite.close(); }
    await f.service.lifecycle.close();
    assert.equal(existsSync(join(f.directory, 'ledger', 'writer.lock')), false);
  });

  serviceCase('digest and job tampering cannot mint consent; status/display copies cannot change the stored scope', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    const original = structuredClone(job.display);
    const changed = structuredClone(job.display);
    const tampered = { ...changed, proposal: { ...changed.proposal, durationMs: 60_000 } };
    const returnedCopy = f.status(job);
    Object.assign(returnedCopy.display.proposal.binding, { nativeStudioId: 'foreign-fixture-studio' });
    for (const input of [
      { ...approval(job), displayDigest: digest(tampered) },
      { ...approval(job), id: 'foreign-fixture-job' },
    ]) await assert.rejects(f.service.humanControl.approve(input, () => {}), { code: 'HUMAN_AUTH_REQUIRED' });
    await assert.rejects(f.service.humanControl.approve({ ...approval(job), actor: HUMAN }, () => {}));
    assert.deepEqual(f.status(job).display, original);
    assert.equal(f.status(job).displayDigest, digest(original));
    assert.deepEqual(await f.records(), []);
    assert.deepEqual(f.effects(), []);
    await f.service.requests.cancel(job.id, ACTOR);
  });

  serviceCase('authority is checked again after durable consent and cancellation wins before reservation', async sub => {
    for (const action of ['throw', 'cancel'] as const) await sub.test(action, async inner => {
      const f = await fixture(inner), job = await f.prepare();
      const denied = new Error('fixture HumanPort authority changed during consent');
      let checks = 0, cancellation: Promise<StudioTestView> | undefined;
      const pending = f.service.humanControl.approve(approval(job), () => {
        if (++checks === 2) {
          if (action === 'throw') throw denied;
          cancellation = f.service.requests.cancel(job.id, ACTOR);
        }
      });
      if (action === 'throw') await assert.rejects(pending, error => error === denied);
      else await assert.rejects(pending, { code: 'HUMAN_AUTH_REQUIRED' });
      if (cancellation) assert.equal((await cancellation).state, 'cancelled');
      assert.equal(checks, 2);
      assert.deepEqual((await f.records()).map(record => record.event.kind), ['consent']);
      assert.deepEqual(f.effects(), []);
      assert.equal(f.scene('guard-released-scene').state, 'queued');
      await f.service.requests.cancel(job.id, ACTOR);
    });
  });

  serviceCase('foreign actors cannot see or cancel jobs; only the stable human actor sees every owner', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    assert.deepEqual(f.service.requests.list(OTHER), []);
    assert.deepEqual(f.service.requests.list('fixture-human'), []);
    assert.deepEqual(f.service.requests.list(ACTOR).map(value => value.id), [job.id]);
    assert.deepEqual(f.service.requests.list(HUMAN).map(value => value.id), [job.id]);
    assert.equal(f.status(job, HUMAN).actor, ACTOR);
    for (const actor of [OTHER, 'fixture-human']) {
      assert.throws(() => f.status(job, actor), { code: 'HUMAN_AUTH_REQUIRED' });
      await assert.rejects(f.service.requests.cancel(job.id, actor), { code: 'HUMAN_AUTH_REQUIRED' });
    }
    assert.equal(f.status(job).state, 'needs_approval');
    assert.equal(f.state.closes, 0);
    assert.equal((await f.service.requests.cancel(job.id, HUMAN)).state, 'cancelled');
    assert.deepEqual(f.effects(), []);
    const humanJob = await f.prepare(HUMAN);
    assert.equal(humanJob.actor, HUMAN);
    assert.deepEqual(f.service.requests.list(ACTOR).map(value => value.id), [job.id]);
    assert.equal(f.service.requests.list(HUMAN).length, 2);
    await f.service.requests.cancel(humanJob.id, HUMAN);
  });

  serviceCase('concurrent preparation holds the service lock, pending jobs block admission, cancellation releases it', async sub => {
    const f = await fixture(sub), blocked = gate();
    f.hooks.connect = () => blocked.pending;
    const first = f.prepare();
    try {
      await until(() => f.state.connects === 1);
      await assert.rejects(f.prepare(OTHER), { code: 'BUSY' });
      await assert.rejects(f.openService(), { code: 'FENCED' });
      assert.deepEqual(f.effects(), []);
    } finally { blocked.release(); }
    const job = await first;
    await assert.rejects(f.prepare(OTHER), { code: 'BUSY' });
    assert.equal(f.state.connects, 1);
    await f.service.requests.cancel(job.id, ACTOR);
    delete f.hooks.connect;
    const next = await f.prepare(OTHER);
    assert.notEqual(next.id, job.id);
    assert.equal(next.actor, OTHER);
    assert.equal(f.state.connects, 2);
    await f.service.requests.cancel(next.id, OTHER);
    assert.equal(f.state.closes, 2);
  });

  serviceCase('missing, stale, disconnected, unsupported or mismatched host proofs refuse preparation before connecting', async sub => {
    const cases = [
      { name: 'missing', options: { publish: false } },
      { name: 'expired server receipt', options: { storeTimeOffset: -6_001 } },
      { name: 'disconnected', options: { proof: { connected: false } } },
      { name: 'continuity unavailable', options: { proof: { continuitySupported: false } } },
      { name: 'artifact mismatch', options: { proof: { pluginArtifactHash: 'b'.repeat(64) } } },
    ];
    for (const entry of cases) await sub.test(entry.name, async inner => {
      const f = await fixture(inner, entry.options);
      await assert.rejects(f.prepare(), { code: 'STALE_PROOF' });
      assert.equal(f.state.connects, 0);
      assert.deepEqual(f.service.requests.list(HUMAN), []);
      assert.deepEqual(f.effects(), []);
      assert.deepEqual(await f.records(), []);
    });
  });

  serviceCase('strict authenticated eleven-field poll cannot admit cross identities or client-supplied receipt timestamps', async sub => {
    const f = await fixture(sub, { publish: false });
    for (const changes of [
      { sessionId: 'foreign-fixture-session' }, { clientLifetimeId: 'foreign-fixture-lifetime' },
      { placeId: 1 }, { universeId: 1 }, { placeName: 'foreign fixture place' },
      { observedAt: new Date().toISOString() }, { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      assert.throws(() => f.poll({ ...f.observation(), ...changes }), { code: 'IDENTITY' });
      assert.equal(f.store.session(f.pair.sessionId).proof, undefined);
    }
    await assert.rejects(f.prepare(), { code: 'STALE_PROOF' });
    assert.equal(f.state.connects, 0);
    assert.deepEqual(f.effects(), []);
  });

  serviceCase('published place/universe and absent writable ServerStorage root cannot supply playtest authority', async sub => {
    for (const identity of [{ placeId: 1 }, { universeId: 1 }, { allowWrites: false, publish: false }]) {
      await sub.test(JSON.stringify(identity), async inner => {
        const f = await fixture(inner, identity);
        await assert.rejects(f.prepare(), { code: 'PLACE_DENIED' });
        assert.equal(f.state.connects, 0);
        assert.deepEqual(f.effects(), []);
      });
    }
    await sub.test('missing ServerStorage root', async inner => {
      const f = await fixture(inner, { allowedRoots: ['Workspace'], publish: false });
      assert.throws(() => f.publish(), { code: 'SCOPE' });
      await assert.rejects(f.prepare(), { code: 'STALE_PROOF' });
      assert.equal(f.state.connects, 0);
      assert.deepEqual(f.effects(), []);
    });
  });

  serviceCase('independent witness must bind the exact lifetime, session, artifact and unpublished place', async sub => {
    const mismatches: Partial<Witness>[] = [{ placeId: 1 }, { universeId: 1 },
      { sessionId: 'foreign-fixture-session' }, { clientLifetimeId: 'foreign-fixture-lifetime' },
      { pluginArtifactHash: 'b'.repeat(64) }];
    for (const mismatch of mismatches) await sub.test(Object.keys(mismatch)[0]!, async inner => {
      const f = await fixture(inner);
      f.hooks.witness = async value => ({ ...value, ...mismatch });
      await assert.rejects(f.prepare(), { code: 'BINDING_CHANGED' });
      assert.equal(f.state.connects, 1);
      assert.equal(f.state.closes, 1);
      assert.equal(f.witnesses.length, 1);
      assert.deepEqual(f.service.requests.list(HUMAN), []);
      assert.deepEqual(f.effects(), []);
      assert.deepEqual(await f.records(), []);
    });
  });

  serviceCase('native inventory ambiguity cannot silently choose a same-named Studio', async sub => {
    const f = await fixture(sub);
    f.state.inventory.push({ id: 'other-service-fixture', name: NAME });
    const { nativeStudioId: _ignored, ...automatic } = f.request;
    await assert.rejects(f.service.requests.prepare(automatic, ACTOR), { code: 'BINDING_CHANGED' });
    assert.equal(f.state.closes, 1);
    const job = await f.prepare();
    assert.equal(job.display.proposal.binding.nativeStudioId, STUDIO);
    await f.service.requests.cancel(job.id, ACTOR);
    assert.deepEqual(f.effects(), []);
  });

  serviceCase('service duration/interval bounds and request-provided authority are rejected without connection', async sub => {
    const f = await fixture(sub);
    for (const changes of [{ durationMs: 4_999 }, { durationMs: 60_001 },
      { observationIntervalMs: 249 }, { observationIntervalMs: 2_001 },
      { witness: f.observation() }, { approved: true }, { actor: HUMAN }]) {
      await assert.rejects(f.service.requests.prepare({ ...f.request, ...changes }, ACTOR));
    }
    await assert.rejects(f.prepare('invalid actor'), { code: 'HUMAN_AUTH_REQUIRED' });
    assert.equal(f.state.connects, 0);
    assert.deepEqual(f.effects(), []);
    assert.deepEqual(await f.records(), []);
  });

  serviceCase('consent expires after sixty seconds with Date.now isolated to this one context', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    const future = job.display.consentExpiresAt + 1;
    const mockedNow = sub.mock.method(Date, 'now', () => future);
    try {
      // Keep the separate six-second plugin receipt fresh so the test reaches
      // the human consent deadline instead of failing the earlier proof gate.
      assert.deepEqual(f.publish(), []);
      assert.equal(Date.parse(f.store.session(f.pair.sessionId).proof!.observedAt), future);
      await assert.rejects(f.service.humanControl.approve(approval(job), () => {}), { code: 'CONSENT_EXPIRED' });
      assert.deepEqual(await f.records(), []);
      assert.deepEqual(f.effects(), []);
      assert.equal(f.status(job).state, 'needs_approval');
    } finally { mockedNow.mock.restore(); }
    assert.equal((await f.service.requests.cancel(job.id, ACTOR)).state, 'cancelled');
    assert.equal(f.scene('expired-scene-fixture').state, 'queued');
  });

  serviceCase('closePending closes the actual SDK client, removes writer lock and permits ledger reopening', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    assert.equal(existsSync(join(f.directory, 'ledger', 'writer.lock')), true);
    await f.service.lifecycle.close();
    assert.equal(f.state.closes, 1);
    await assert.rejects(f.connections[0]!.client.listTools({}), /Not connected/);
    assert.equal(existsSync(join(f.directory, 'ledger', 'writer.lock')), false);
    await assert.rejects(f.prepare(), { code: 'BUSY' });
    await assert.rejects(f.service.humanControl.approve(approval(job), () => {}), { code: 'HUMAN_AUTH_REQUIRED' });
    const reopened = await f.openService();
    const next = await reopened.requests.prepare(f.request, OTHER);
    assert.equal(next.state, 'needs_approval');
    assert.equal(next.actor, OTHER);
    await reopened.requests.cancel(next.id, OTHER);
    await reopened.lifecycle.close();
    assert.equal(f.state.closes, 2);
    assert.equal(existsSync(join(f.directory, 'ledger', 'writer.lock')), false);
    assert.deepEqual(await f.records(), []);
    assert.deepEqual(f.effects(), []);
    assert.equal(f.scene('closed-pending-scene').state, 'queued');
  });

  serviceCase('cancelling known owned play stops and releases the fence without a fake success', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    await f.service.humanControl.approve(approval(job), () => {});
    await until(() => f.status(job).review.phase === 'waiting');
    assert.throws(() => f.scene('cancel-running-scene'), { code: 'BUSY' });
    const cancelled = report(await f.service.requests.cancel(job.id, ACTOR));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.review.code, 'CANCELLED');
    assert.equal(cancelled.review.outcome, 'cancelled');
    assert.equal(cancelled.review.cleanup, 'complete');
    assert.equal(cancelled.review.canStartAnotherOperation, true);
    assert.deepEqual(f.effects().map(call => call.args.is_start), [true, false]);
    assert.equal(f.scene('cancel-released-scene').state, 'queued');
    const terminal = (await f.records()).filter(record => record.event.kind === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.event.outcome, 'cancelled');
    assert.equal(terminal[0]!.event.code, 'CANCELLED');
  });

  serviceCase('recognized fixture console diagnostic fails the run and still verifies owned cleanup', async sub => {
    const f = await fixture(sub), job = await f.prepare();
    // Synthetic parser diagnostic, not a claim that a Roblox engine ran code.
    f.state.consoleText = "ServerScriptService.Fixture:7: attempt to index nil with 'Value'\nStack Begin\nScript 'ServerScriptService.Fixture', Line 7\nStack End";
    await f.service.humanControl.approve(approval(job), () => {});
    await until(() => f.status(job).review.phase === 'done' && f.state.closes === 1);
    const review = f.status(job).review;
    assert.equal(review.outcome, 'failed');
    assert.equal(review.code, 'RUNTIME_ERROR');
    assert.equal(review.cleanup, 'complete');
    assert.equal(review.evidence, 'fixture');
    assert.equal(review.nativeAcceptance, false);
    assert.equal(review.observations, 1);
    assert.equal(review.logs.length, 1);
    assert.equal(review.logs[0]?.level, 'error');
    assert.deepEqual(f.effects().map(call => call.args.is_start), [true, false]);
    const events = (await f.records()).map(record => record.event);
    assert.equal(events.find(event => event.kind === 'observe')?.logs?.[0]?.level, 'error');
    assert.equal(events.find(event => event.kind === 'terminal')?.outcome, 'failed');
    assert.ok(events.every(event => event.evidence === 'fixture'));
    assert.equal(f.scene('diagnostic-released-scene').state, 'queued');
  });

  serviceCase('abort during a dispatched native request with unknown effect preserves scene and durable fences', async sub => {
    const f = await fixture(sub), job = await f.prepare(), held = gate();
    let nativeSignal: AbortSignal | undefined;
    f.hooks.afterEffect = async (call, signal) => {
      assert.equal(call.args.is_start, true);
      nativeSignal = signal;
      await held.pending;
      return { ...text('fixture ACK cannot establish the dispatched start outcome'), isError: true };
    };
    await f.service.humanControl.approve(approval(job), () => {});
    await until(() => nativeSignal !== undefined);
    assert.equal(f.store.session(f.pair.sessionId).proof?.mode, 'Play');
    const cancelling = f.service.requests.cancel(job.id, ACTOR);
    try {
      await until(() => f.status(job).review.phase === 'stopping');
      assert.equal(nativeSignal!.aborted, false, 'caller abort cannot certify physical mutation cancellation');
      assert.throws(() => f.scene('unknown-pending-scene'), { code: 'BUSY' });
    } finally { held.release(); }
    const cancelled = report(await cancelling);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.review.outcome, 'cancelled');
    assert.equal(cancelled.review.code, 'CANCELLED');
    assert.equal(cancelled.review.cleanup, 'unknown');
    assert.equal(cancelled.review.requiresHumanReview, true);
    assert.equal(cancelled.review.canStartAnotherOperation, false);
    assert.equal(cancelled.review.nativeAcceptance, false);
    assert.deepEqual(f.effects().map(call => call.args.is_start), [true]);
    assert.equal(f.state.closes, 1);
    const journal = await f.records();
    assert.equal(journal.filter(record => record.event.kind === 'terminal').length, 1);
    assert.equal(journal.find(record => record.event.kind === 'terminal')?.event.outcome, 'cancelled');
    assert.equal(journal.some(record => record.event.kind === 'start_result' || record.event.kind === 'stop_result'), false);
    assert.equal(journal.at(-1)?.event.kind, 'cleanup');
    assert.equal(journal.at(-1)?.event.cleanup, 'unknown');
    assert.ok(journal.every(record => record.event.evidence === 'fixture'));
    assert.throws(() => f.scene('unknown-fenced-scene'), { code: 'BUSY' });
    await assert.rejects(f.prepare(), { code: 'BUSY' });
    await f.service.lifecycle.close();
    await flush();
    assert.equal(existsSync(join(f.directory, 'ledger', 'writer.lock')), true);
    await assert.rejects(f.openService(), { code: 'FENCED' });
    assert.throws(() => f.scene('unknown-after-close'), { code: 'BUSY' });
  });
});
