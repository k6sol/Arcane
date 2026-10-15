import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { playtestJob } from '../../apps/mcp/src/playtest-schemas.js';
import { digest } from '../../packages/studio-test-controller/src/contracts.js';
import type { StudioTestView } from '../../apps/daemon/src/studio-test-service.js';
import {scenarioPlanSchema,SCENARIO_ACTIONS} from '../../packages/studio-test-controller/src/scenario.js';

// Synthetic daemon reports exercise the actual SDK and HTTP response boundary.
// The companion service tests validate real controller/store/ledger reports.
// Neither suite launches a native executable or establishes native acceptance.
const TOKEN = 'fixture-playtest-agent-bearer';
const JOB = 'playtest-fixture-job', SESSION = 'paired-fixture-session', STUDIO = 'native-fixture-studio';
type Mutable<T,Depth extends 1[]=[]>=Depth['length'] extends 10?T:{-readonly[Key in keyof T]:Mutable<T[Key],[...Depth,1]>};
type Job = Mutable<StudioTestView>;

function pending(): Job {
  const display: Job['display'] = {
    proposal: { binding: { nativeStudioId: STUDIO, pairedSessionId: SESSION, clientLifetimeId: 'fixture-plugin-lifetime',
      pluginArtifactHash: 'a'.repeat(64), scopeRevision: 'b'.repeat(64), placeId: 0 },
    durationMs: 15_000, observationIntervalMs: 1_000, failOnRuntimeError: true },
    cleanupGraceMs: 15_000, requestTimeoutMs: 15_000, proofMaxAgeMs: 6_000,
    consentExpiresAt: 100_000, guarantee: 'observed-non-atomic',
    actions: ['start', 'observe-state-and-console', 'stop-owned-play'],
    raceDisclosure: 'Observed checks cannot atomically fence the native call.',
  };
  return { id: JOB, targetName: 'Synthetic unpublished target', actor: 'fixture-agent', state: 'needs_approval',
    display, displayDigest: digest(display), evidence: 'fixture', nativeAcceptance: false,
    review: { runId: null, evidence: 'fixture', nativeAcceptance: false, binding: null, scopeDigest: null,
      phase: 'idle', outcome: null, code: 'OK', cleanup: 'not_started', startedAt: null, deadline: null, cleanupDeadline: null,
      watchdog: { armed: false, fired: false, reason: null }, observations: 0, logs: [], logsTruncated: false,
      requiresHumanReview: false, canStartAnotherOperation: false } };
}
function running(): Job {
  const job = pending(); job.state = 'running';
  Object.assign(job.review, { runId: 'fixture-owned-run', binding: structuredClone(job.display.proposal.binding),
    scopeDigest: job.displayDigest, phase: 'waiting', startedAt: 10_000, deadline: 25_000, cleanupDeadline: 40_000,
    observations: 1, watchdog: { armed: true, fired: false, reason: null },
    logs: [{ idDigest: 'c'.repeat(64), digest: 'd'.repeat(64), level: 'info', bytes: 20 }] });
  return job;
}
function finished(cleanup: 'complete' | 'unknown' = 'complete'): Job {
  const job = running(); job.state = 'complete';
  Object.assign(job.review, { phase: 'done', outcome: 'succeeded', cleanup,
    watchdog: { armed: false, fired: true, reason: 'DURATION_EXPIRED' },
    requiresHumanReview: cleanup === 'unknown', canStartAnotherOperation: cleanup === 'complete' });
  return job;
}
function gameplay():Job {
  const job=finished(),plan=scenarioPlanSchema.parse({version:1,runtimeBudgetMs:1000,
    targets:[{id:'panel',root:'LocalPlayer.PlayerGui',segments:['HUD','Result'],className:'TextLabel'}],
    steps:[{id:'walk',kind:'hold-key',key:'W',holdMs:100},{id:'distance',kind:'assert-displacement',minimumStuds:1},
      {id:'visible',kind:'assert-gui',targetId:'panel',property:'Visible',equals:true,withinMs:100},
      {id:'text',kind:'assert-text',targetId:'panel',equals:'Complete',withinMs:100}],capture:{required:false}});
  job.display.proposal.scenario=plan;job.display.proposal.subjectDigest='f'.repeat(64);job.display.actions=[...SCENARIO_ACTIONS];
  job.displayDigest=digest(job.display);job.review.scopeDigest=job.displayDigest;
  job.review.scenario={scenarioDigest:digest(plan),subjectDigest:'f'.repeat(64),state:'passed',inputRelease:'observed_released',temporary:'not_started',capture:null,consoleCoverage:'ambiguous',
    steps:[{id:'walk',kind:'hold-key',outcome:'passed',expected:'W:100',observed:'observed-released'},
      {id:'distance',kind:'assert-displacement',outcome:'passed',expected:1,observed:2},
      {id:'visible',kind:'assert-gui',outcome:'passed',expected:true,observed:true,baseline:false},
      {id:'text',kind:'assert-text',outcome:'passed',expected:'Complete',observed:'Complete',baseline:'Waiting'}]};
  return job;
}
function layoutGameplay(failed=false):Job{
  const job=gameplay(),plan=scenarioPlanSchema.parse({version:1,runtimeBudgetMs:300,targets:job.display.proposal.scenario!.targets,
    steps:[{id:'layout',kind:'assert-gui-layout',targetId:'panel',minimumWidth:120,minimumHeight:40,withinMs:100}],capture:{required:false}});
  job.display.proposal.scenario=plan;job.displayDigest=digest(job.display);job.review.scopeDigest=job.displayDigest;
  Object.assign(job.review.scenario!,{scenarioDigest:digest(plan),inputRelease:'not_started',state:failed?'failed':'passed',steps:[
    {id:'layout',kind:'assert-gui-layout',outcome:failed?'failed':'passed',expected:'core-safe:120x40',observed:!failed,layout:{
      coordinateSpace:'CoreUISafeInsets',target:{left:24,top:24,right:failed?84:224,bottom:74},safeArea:{left:0,top:0,right:800,bottom:600},
      clips:[{left:0,top:0,right:400,bottom:300}],visibleChain:true,viewport:{width:800,height:644,units:'RobloxUIOffset'}}}]});
  if(failed){job.review.outcome='failed';job.review.code='ASSERTION_FAILED';}return job;
}
function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
}
function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
async function fixture(t: TestContext) {
  const state: { payload: unknown; status: number; lostAck: boolean; beforeReply: (() => Promise<void>) | undefined } =
    { payload: { job: pending() }, status: 200, lostAck: false, beforeReply: undefined };
  const requests: { method: string; path: string; body: unknown; auth: string | undefined; origin: string | undefined }[] = [];
  const http = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : null;
    requests.push({ method: request.method!, path: request.url!, body, auth: request.headers.authorization, origin: request.headers.origin });
    if (request.headers.authorization !== 'Bearer ' + TOKEN) return send(response, 401, { error: 'AUTH', message: 'Fixture bearer required.' });
    await state.beforeReply?.();
    if (state.lostAck) return request.socket.destroy();
    send(response, state.status, state.payload);
  })().catch(() => { if (!response.destroyed) send(response, 500, { error: 'FIXTURE', message: 'Fixture failed.' }); }); });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const daemon = new DaemonClient({ url: 'http://127.0.0.1:' + address.port, token: TOKEN });
  const server = createMcpServer({ client: daemon, projectRoot: process.cwd() });
  const client = new Client({ name: 'playtest-evidence-fixture', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { state, requests, client, daemon };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  assert.ok(result.structuredContent);
  return { result, data: result.structuredContent };
}

test('playtest SDK: exact endpoints/defaults preserve complete reports without approving or starting play', async t => {
  const f = await fixture(t), job = pending();
  assert.deepEqual((await call(f.client, 'playtest_request', { sessionId: SESSION })).data, { job });
  assert.deepEqual(f.requests[0], { method: 'POST', path: '/v1/playtests/prepare',
    body: { sessionId: SESSION, durationMs: 15_000, observationIntervalMs: 1_000, failOnRuntimeError: true },
    auth: 'Bearer ' + TOKEN, origin: undefined });
  assert.deepEqual((await call(f.client, 'playtest_status', { jobId: JOB })).data, { job });
  f.state.payload = { jobs: [job] };
  assert.deepEqual((await call(f.client, 'playtest_status')).data, { jobs: [job] });
  const cancelled = pending(); cancelled.state = 'cancelled'; f.state.payload = { job: cancelled };
  assert.deepEqual((await call(f.client, 'playtest_cancel', { jobId: JOB })).data, { job: cancelled });
  assert.deepEqual(f.requests.map(request => [request.method, request.path]), [
    ['POST', '/v1/playtests/prepare'], ['GET', '/v1/playtests?id=' + JOB], ['GET', '/v1/playtests'], ['POST', '/v1/playtests/cancel'],
  ]);
  assert.deepEqual(f.requests[3]!.body, { id: JOB });
});

test('playtest SDK: explicit settings and optional native target must match the prepared snapshot', async t => {
  const f = await fixture(t), job = pending();
  Object.assign(job.display.proposal, { durationMs: 5_000, observationIntervalMs: 250, failOnRuntimeError: false });
  job.displayDigest = digest(job.display); f.state.payload = { job };
  const input = { sessionId: SESSION, nativeStudioId: STUDIO, durationMs: 5_000, observationIntervalMs: 250, failOnRuntimeError: false };
  assert.deepEqual((await call(f.client, 'playtest_request', input)).data, { job });
  assert.deepEqual(f.requests[0]!.body, input);
  for (const changed of [
    { ...input, sessionId: 'other-session' }, { ...input, nativeStudioId: 'other-studio' },
    { ...input, durationMs: 6_000 }, { ...input, observationIntervalMs: 500 }, { ...input, failOnRuntimeError: true },
  ]) {
    const result = await call(f.client, 'playtest_request', changed);
    assert.equal(result.data.state, 'unknown'); assert.equal(result.data.ambiguous, true);
    assert.equal(result.data.terminal, false); assert.equal(result.data.job, undefined);
  }
  assert.equal(f.requests.length, 6, 'each preparation was submitted exactly once');
});

test('playtest HTTP: held acknowledgements bind the original submitted copy despite caller mutation', async t => {
  const f = await fixture(t);
  for (const wrongResponse of [false, true]) {
    const received = gate(), held = gate();
    f.state.beforeReply = async () => { received.release(); await held.pending; };
    const input = { sessionId: SESSION, nativeStudioId: STUDIO, durationMs: 15_000,
      observationIntervalMs: 1_000, failOnRuntimeError: true };
    const original = structuredClone(input), operation = f.daemon.playtestRequest(input);
    try {
      await received.pending;
      Object.assign(input, { sessionId: 'changed-session', nativeStudioId: 'changed-studio',
        durationMs: 5_000, observationIntervalMs: 250, failOnRuntimeError: false });
      const job = pending();
      if (wrongResponse) {
        Object.assign(job.display.proposal.binding, { pairedSessionId: input.sessionId, nativeStudioId: input.nativeStudioId });
        Object.assign(job.display.proposal, { durationMs: input.durationMs, observationIntervalMs: input.observationIntervalMs,
          failOnRuntimeError: input.failOnRuntimeError });
        job.displayDigest = digest(job.display);
      }
      f.state.payload = { job };
      held.release();
      const actual = await operation;
      assert.deepEqual(f.requests.at(-1)!.body, original);
      if (wrongResponse) {
        assert.ok('ambiguous' in actual); assert.equal(actual.ambiguous, true); assert.equal(actual.state, 'unknown');
      } else assert.deepEqual(actual, { job });
    } finally { held.release(); }
  }
  assert.equal(f.requests.length, 2, 'neither held acknowledgement is replayed');
});

test('playtest HTTP: the private request copy rejects malformed scope and caller authority before submission', async t => {
  const f = await fixture(t);
  for (const patch of [{ approved: true }, { binding: pending().display.proposal.binding }, { code: 'return true' },
    { nativeStudioId: STUDIO + '\n' }, { durationMs: 4_999 }, { failOnRuntimeError: 'yes' }]) {
    await assert.rejects(f.daemon.playtestRequest({ sessionId: SESSION, ...patch } as Parameters<DaemonClient['playtestRequest']>[0]), { code: 'INPUT' });
  }
  assert.equal(f.requests.length, 0);
});

test('playtest SDK: actual lifecycle shapes retain pending cancel, cleanup uncertainty and late cancel', async t => {
  const f = await fixture(t);
  const pendingCancel = pending(); pendingCancel.state = 'cancelled';
  const admitting = running(); admitting.state = 'needs_approval'; admitting.review.phase = 'admitting';
  admitting.review.observations = 0; admitting.review.logs = []; admitting.review.watchdog.armed = false;
  const stopping = finished('unknown'); stopping.state = 'running'; stopping.review.phase = 'stopping';
  stopping.review.requiresHumanReview = false;
  const cancelled = finished('unknown'); cancelled.state = 'cancelled';
  Object.assign(cancelled.review, { outcome: 'cancelled', code: 'CANCELLED', watchdog: { armed: false, fired: true, reason: 'CANCELLED' } });
  const rejected = finished(); Object.assign(rejected.review, { outcome: 'rejected', code: 'HUMAN_AUTH_REQUIRED', canStartAnotherOperation: false });
  const timedOut = finished(); Object.assign(timedOut.review, { outcome: 'timed_out', code: 'TIMEOUT' });
  const durationExpired = structuredClone(timedOut); durationExpired.review.code = 'DURATION_EXPIRED';
  const failed = finished(); Object.assign(failed.review, { outcome: 'failed', code: 'RUNTIME_ERROR' });
  const toleratedError = finished(); toleratedError.display.proposal.failOnRuntimeError = false;
  toleratedError.review.logs[0]!.level = 'error'; toleratedError.displayDigest = digest(toleratedError.display);
  toleratedError.review.scopeDigest = toleratedError.displayDigest;
  const reports = [pending(), pendingCancel, admitting, running(), stopping, finished(), finished('unknown'), cancelled, rejected, timedOut, durationExpired, failed, toleratedError];
  for (const job of reports) {
    f.state.payload = { job };
    const actual = await call(f.client, 'playtest_status', { jobId: JOB });
    assert.notEqual(actual.result.isError, true); assert.deepEqual(actual.data, { job });
  }
  // A native evidence label is not native acceptance, even in a complete report.
  const labelled = finished(); labelled.evidence = labelled.review.evidence = 'native';
  f.state.payload = { job: labelled };
  assert.deepEqual((await call(f.client, 'playtest_status', { jobId: JOB })).data, { job: labelled });
  assert.equal(labelled.nativeAcceptance, false); assert.equal(labelled.review.nativeAcceptance, false);
  // The service keeps an already complete outcome when cancellation arrives late.
  f.state.payload = { job: finished() };
  assert.deepEqual((await call(f.client, 'playtest_cancel', { jobId: JOB })).data, f.state.payload);
});

const invalidReports: [string, (job: Job) => void][] = [
  ['native acceptance', job => { Object.assign(job, { nativeAcceptance: true }); }],
  ['review native acceptance', job => { Object.assign(job.review, { nativeAcceptance: true }); }],
  ['evidence mismatch', job => { job.review.evidence = 'native'; }],
  ['invented outcome', job => { Object.assign(job.review, { outcome: 'passed' }); }],
  ['invented phase', job => { Object.assign(job.review, { phase: 'verified' }); }],
  ['invented code', job => { Object.assign(job.review, { code: 'GAME_PASSED' }); }],
  ['invented cleanup', job => { Object.assign(job.review, { cleanup: 'verified' }); }],
  ['runtime error cannot succeed', job => { job.review.code = 'RUNTIME_ERROR'; }],
  ['fresh error cannot satisfy strict success policy', job => { job.review.logs[0]!.level = 'error'; }],
  ['unknown effect cannot succeed', job => { job.review.code = 'EFFECT_UNKNOWN'; }],
  ['cancelled requires cancel code', job => { job.review.outcome = 'cancelled'; }],
  ['timeout requires timeout code', job => { job.review.outcome = 'timed_out'; }],
  ['runtime error is not timeout', job => { job.review.outcome = 'timed_out'; job.review.code = 'RUNTIME_ERROR'; }],
  ['job id newline', job => { job.id += '\n'; }],
  ['actor newline', job => { job.actor += '\n'; }],
  ['run id newline', job => { job.review.runId += '\n'; }],
  ['native id newline', job => { job.display.proposal.binding.nativeStudioId += '\n'; job.displayDigest = digest(job.display); }],
  ['session id newline', job => { job.display.proposal.binding.pairedSessionId += '\n'; job.displayDigest = digest(job.display); }],
  ['lifetime newline', job => { job.review.binding!.clientLifetimeId += '\n'; }],
  ['artifact hash newline', job => { job.display.proposal.binding.pluginArtifactHash += '\n'; job.displayDigest = digest(job.display); }],
  ['binding scope newline', job => { job.review.binding!.scopeRevision += '\n'; }],
  ['display digest newline', job => { job.displayDigest += '\n'; }],
  ['review digest newline', job => { job.review.scopeDigest += '\n'; }],
  ['log id digest newline', job => { job.review.logs[0]!.idDigest += '\n'; }],
  ['log digest newline', job => { job.review.logs[0]!.digest += '\n'; }],
  ['extra job claim', job => { Object.assign(job, { gamePassed: true }); }],
  ['extra review claim', job => { Object.assign(job.review, { gamePassed: true }); }],
  ['missing review field', job => { Reflect.deleteProperty(job.review, 'requiresHumanReview'); }],
  ['wrong digest', job => { job.displayDigest = 'e'.repeat(64); }],
  ['wrong scope digest', job => { job.review.scopeDigest = 'e'.repeat(64); }],
  ['wrong run binding', job => { job.review.binding!.clientLifetimeId = 'other-lifetime'; }],
  ['missing binding field', job => { Reflect.deleteProperty(job.display.proposal.binding, 'pluginArtifactHash'); job.displayDigest = digest(job.display); }],
  ['published place', job => { Object.assign(job.display.proposal.binding, { placeId: 1 }); job.displayDigest = digest(job.display); }],
  ['invented action', job => { Object.assign(job.display, { actions: ['start', 'publish', 'stop-owned-play'] }); job.displayDigest = digest(job.display); }],
  ['extra display authority', job => { Object.assign(job.display, { approved: true }); job.displayDigest = digest(job.display); }],
  ['wrong deadline', job => { job.review.deadline!++; }],
  ['unsafe timestamp', job => { job.review.startedAt = Number.MAX_SAFE_INTEGER + 1; }],
  ['partial run identity', job => { job.review.runId = null; }],
  ['nonterminal outcome', job => { job.review.phase = 'waiting'; job.review.cleanup = 'not_started'; }],
  ['terminal pending cleanup', job => { job.review.cleanup = 'not_started'; }],
  ['unknown cleanup unfenced', job => { job.review.cleanup = 'unknown'; }],
  ['unknown cleanup permits work', job => { job.review.cleanup = 'unknown'; job.review.requiresHumanReview = true; }],
  ['human review permits work', job => { job.review.requiresHumanReview = true; }],
  ['armed terminal watchdog', job => { job.review.watchdog = { armed: true, fired: false, reason: null }; }],
  ['missing watchdog reason', job => { job.review.watchdog.reason = null; }],
  ['observation budget', job => { job.review.observations = 16; }],
  ['too many logs', job => { job.review.logs = Array.from({ length: 65 }, () => structuredClone(job.review.logs[0]!)); }],
  ['raw console claim', job => { Object.assign(job.review.logs[0]!, { message: 'Game passed!' }); }],
  ['malformed log digest', job => { job.review.logs[0]!.digest = 'anything'; }],
  ['unbounded console bytes', job => { job.review.logs[0]!.bytes = 8193; }],
];
test('playtest SDK: malformed or contradictory reports never become tool evidence', async t => {
  const f = await fixture(t);
  for (const [name, mutate] of invalidReports) await t.test(name, async () => {
    const job = finished(); mutate(job); f.state.payload = { job };
    const actual = await call(f.client, 'playtest_status', { jobId: JOB });
    assert.equal(actual.result.isError, true);
    assert.deepEqual(Object.keys(actual.data), ['error']);
    assert.equal((actual.data.error as { code: string }).code, 'PROTOCOL');
  });
  assert.equal(f.requests.length, invalidReports.length, 'reads never enqueue or retry an operation');
});

test('playtest SDK: status requires the requested wrapper/identity and a unique bounded list', async t => {
  const f = await fixture(t), other = pending(); other.id = 'other-job';
  const cases: { payload: unknown; args: Record<string, unknown> }[] = [
    { payload: { job: other }, args: { jobId: JOB } }, { payload: { jobs: [pending()] }, args: { jobId: JOB } },
    { payload: { job: pending() }, args: {} }, { payload: { jobs: [pending(), pending()] }, args: {} },
    { payload: { jobs: Array.from({ length: 65 }, (_, i) => ({ ...pending(), id: 'job-' + i })) }, args: {} },
    { payload: { job: pending(), jobs: [] }, args: { jobId: JOB } }, { payload: { jobs: [], accepted: true }, args: {} },
  ];
  for (const { payload, args } of cases) {
    f.state.payload = payload;
    const actual = await call(f.client, 'playtest_status', args);
    assert.equal(actual.result.isError, true); assert.equal((actual.data.error as { code: string }).code, 'PROTOCOL');
  }
  f.state.payload = { jobs: [] };
  assert.deepEqual((await call(f.client, 'playtest_status')).data, { jobs: [] });
  assert.equal(f.requests.length, cases.length + 1);
});

test('playtest SDK: invalid and lost preparation/cancel acknowledgements remain ambiguous without replay', async t => {
  const f = await fixture(t);
  for (const name of ['playtest_request', 'playtest_cancel'] as const) {
    const args = name === 'playtest_request' ? { sessionId: SESSION } : { jobId: JOB };
    for (const kind of ['invalid', 'wrong-job', 'lost-ack', 'server-error'] as const) {
      const before = f.requests.length;
      const job = pending();
      if (kind === 'invalid') Object.assign(job.review, { nativeAcceptance: true });
      if (kind === 'wrong-job') { job.id = 'other-job'; job.display.proposal.binding.pairedSessionId = 'other-session'; job.displayDigest = digest(job.display); }
      f.state.payload = kind === 'server-error' ? { error: 'UNAVAILABLE', message: 'Fixture transport unavailable.' } : { job };
      f.state.status = kind === 'server-error' ? 503 : 200; f.state.lostAck = kind === 'lost-ack';
      const actual = await call(f.client, name, args);
      assert.equal(actual.data.state, 'unknown'); assert.equal(actual.data.terminal, false); assert.equal(actual.data.ambiguous, true);
      assert.equal(actual.data.job, undefined); assert.match(String(actual.data.nextStep), /playtest_status/);
      assert.equal(f.requests.length, before + 1, name + '/' + kind + ' submits once');
    }
  }
  f.state.lostAck = false; f.state.status = 200; f.state.payload = { job: finished() };
  const prematurelyComplete = await call(f.client, 'playtest_request', { sessionId: SESSION });
  assert.equal(prematurelyComplete.data.state, 'unknown'); assert.equal(prematurelyComplete.data.ambiguous, true);
  assert.equal(prematurelyComplete.data.job, undefined, 'preparation cannot acknowledge a completed run');
  f.state.lostAck = false; f.state.status = 403; f.state.payload = { error: 'HUMAN_AUTH_REQUIRED', message: 'Fixture refused.' };
  const refused = await call(f.client, 'playtest_cancel', { jobId: JOB });
  assert.equal(refused.result.isError, true); assert.equal((refused.data.error as { code: string }).code, 'HUMAN_AUTH_REQUIRED');
});

test('playtest decoder: service bounds and pending identity remain closed without hiding unknown cleanup', () => {
  for (const mutate of [
    (job: Job) => { job.display.proposal.durationMs = 4_999; },
    (job: Job) => { job.display.proposal.durationMs = 60_001; },
    (job: Job) => { job.display.proposal.observationIntervalMs = 249; },
    (job: Job) => { job.display.proposal.observationIntervalMs = 2_001; },
    (job: Job) => { job.display.proposal.durationMs = 60_000; job.display.proposal.observationIntervalMs = 250; },
    (job: Job) => { job.review.runId = 'forged-run'; },
    (job: Job) => { job.review.observations = 1; },
  ]) {
    const job = pending(); mutate(job); job.displayDigest = digest(job.display);
    assert.equal(playtestJob.safeParse(job).success, false);
  }
  assert.equal(playtestJob.safeParse(finished('unknown')).success, true);
});

test('playtest SDK: sealed gameplay expectations and observed transitions survive HTTP decoding',async t=>{
  const f=await fixture(t),valid=gameplay();f.state.payload={job:valid};
  assert.deepEqual((await call(f.client,'playtest_status',{jobId:JOB})).data,{job:valid});
  const mutations:[string,(job:Job)=>void][]=[
    ['wrong key expectation',job=>{job.review.scenario!.steps[0]!.expected='D:100';}],
    ['unobserved release',job=>{job.review.scenario!.steps[0]!.observed='pressed';}],
    ['short displacement',job=>{job.review.scenario!.steps[1]!.observed=0.5;}],
    ['false visible observation',job=>{job.review.scenario!.steps[2]!.observed=false;}],
    ['nonboolean visible baseline',job=>{job.review.scenario!.steps[2]!.baseline='arbitrary';}],
    ['already satisfied transition',job=>{job.review.scenario!.steps[2]!.baseline=true;}],
    ['missing transition baseline',job=>{Reflect.deleteProperty(job.review.scenario!.steps[2]!,'baseline');}],
    ['wrong text observation',job=>{job.review.scenario!.steps[3]!.observed='Waiting';}],
    ['nonstring text baseline',job=>{job.review.scenario!.steps[3]!.baseline=false;}],
    ['unrelated baseline',job=>{job.review.scenario!.steps[0]!.baseline=false;}],
    ['missing input release',job=>{job.review.scenario!.inputRelease='not_started';}],
    ['incomplete passing rows',job=>{job.review.scenario!.steps.pop();}],
  ];
  for(const[name,mutate]of mutations)await t.test(name,async()=>{
    const job=gameplay();mutate(job);f.state.payload={job};const result=await call(f.client,'playtest_status',{jobId:JOB});
    assert.equal(result.result.isError,true);assert.equal((result.data.error as{code:string}).code,'PROTOCOL');assert.equal(result.data.job,undefined);
  });
  const failed=gameplay();failed.review.outcome='failed';failed.review.code='ASSERTION_FAILED';failed.review.scenario!.state='failed';
  failed.review.scenario!.steps[1]!.outcome='failed';failed.review.scenario!.steps[1]!.observed=0.5;
  failed.review.scenario!.steps.splice(2);f.state.payload={job:failed};
  assert.deepEqual((await call(f.client,'playtest_status',{jobId:JOB})).data,{job:failed},'a truthful failed prefix remains reportable');
  assert.equal(f.requests.length,mutations.length+2,'malformed observations are read once without execution or replay');
});

test('playtest SDK: layout pass and failure measurements remain closed and recomputed over HTTP',async t=>{
  const f=await fixture(t);
  for(const failed of [false,true]){const job=layoutGameplay(failed);f.state.payload={job};assert.deepEqual((await call(f.client,'playtest_status',{jobId:JOB})).data,{job});}
  const mutations:[string,(job:Job)=>void][]=[
    ['undersized pass',job=>{job.review.scenario!.steps[0]!.layout!.target.right=100;}],
    ['hidden chain pass',job=>{job.review.scenario!.steps[0]!.layout!.visibleChain=false;}],
    ['clipped pass',job=>{job.review.scenario!.steps[0]!.layout!.clips[0]!.right=100;}],
    ['offset safe origin',job=>{job.review.scenario!.steps[0]!.layout!.safeArea.top=1;}],
    ['negative extent',job=>{job.review.scenario!.steps[0]!.layout!.target.right=0;}],
    ['oversized geometry',job=>{job.review.scenario!.steps[0]!.layout!.target.right=16385;}],
    ['too many clips',job=>{job.review.scenario!.steps[0]!.layout!.clips=Array.from({length:9},()=>({left:0,top:0,right:400,bottom:300}));}],
    ['unknown coordinate space',job=>{Object.assign(job.review.scenario!.steps[0]!.layout!,{coordinateSpace:'screen'});}],
    ['wrong viewport units',job=>{Object.assign(job.review.scenario!.steps[0]!.layout!.viewport,{units:'pixels'});}],
    ['extra measurement authority',job=>{Object.assign(job.review.scenario!.steps[0]!.layout!,{code:'unapproved()'});}],
    ['wrong expectation',job=>{job.review.scenario!.steps[0]!.expected='core-safe:1x1';}],
    ['unrelated baseline',job=>{job.review.scenario!.steps[0]!.baseline=false;}],
  ];
  for(const[name,mutate]of mutations)await t.test(name,async()=>{const job=layoutGameplay();mutate(job);f.state.payload={job};const result=await call(f.client,'playtest_status',{jobId:JOB});
    assert.equal(result.result.isError,true);assert.equal((result.data.error as{code:string}).code,'PROTOCOL');assert.equal(result.data.job,undefined);});
  for(const observed of [false,null,'not-observed']){
    const job=layoutGameplay(true),row=job.review.scenario!.steps[0]!;row.observed=observed;delete row.layout;f.state.payload={job};
    const result=await call(f.client,'playtest_status',{jobId:JOB});assert.equal(result.result.isError,true,'unmeasured failure cannot authorize repair');
  }
  const partial=layoutGameplay(true);partial.review.code='BINDING_CHANGED';partial.review.scenario!.steps[0]!.observed=null;delete partial.review.scenario!.steps[0]!.layout;
  f.state.payload={job:partial};assert.deepEqual((await call(f.client,'playtest_status',{jobId:JOB})).data,{job:partial},'an unmeasured binding failure remains reportable');
  assert.ok(f.requests.every(request=>request.method==='GET'),'invalid evidence is never replayed or executed');
});
