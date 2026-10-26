/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioStore, STUDIO_DIAGNOSTICS_CAPABILITY, STUDIO_DIAGNOSTIC_LIMITS } from '../../packages/storage/src/studio-store.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';
import { READ_METHODS, type PairResult } from '../../packages/protocol/src/studio.js';
import {
  createStudioDiagnosticsReader, prefillComposer, readStudioDiagnostics, reduceStudioDiagnostics, startStudioDiagnostics, studioDiagnosticsPresentation,
  studioDiagnosticsSeverity, studioDiagnosticsTone, studioFixPrompt, STUDIO_DIAGNOSTICS_CLEAR_ROUTE, STUDIO_DIAGNOSTICS_INITIAL, STUDIO_DIAGNOSTICS_ROUTE, STUDIO_DIAGNOSTICS_TONES,
  WORKSPACE_PREFILL_EVENT, type StudioDiagnosticItem, type StudioDiagnosticItemView, type StudioDiagnosticsDock, type StudioDiagnosticsFault,
  type StudioDiagnosticsOptions, type StudioDiagnosticsReaderState, type StudioDiagnosticsReadFault, type StudioDiagnosticsReceipt, type StudioDiagnosticsSnapshot,
} from '../../apps/desktop/src/studio-diagnostics.js';

const identity = (window: string) => ({ clientSessionId: window, placeId: 0, universeId: 0, name: 'TEST FIXTURE (not Studio)', pluginVersion: 'fixture' });
const entry = (id: string, count = 1, extra: Record<string, unknown> = {}) => ({ id, kind: 'error', message: 'attempt to index nil with ' + id, source: 'ServerScriptService.Main', line: 7, count, ...extra });

async function storeFixture(t: TestContext, now: () => number = Date.now) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-studio-diagnostics-'));
  const store = new StudioStore({ directory, now });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const pair = (window: string, capabilities: string[] = [...READ_METHODS, STUDIO_DIAGNOSTICS_CAPABILITY]) => {
    const grant = store.createGrant({ allowedRoots: ['Workspace'], allowWrites: false });
    return store.pair({ code: grant.code, protocolVersion: 1, identity: identity(window), capabilities });
  };
  return { store, pair };
}

test('the diagnostics capability is accepted at pairing while unknown capabilities still fail closed', async t => {
  const { store, pair } = await storeFixture(t);
  const paired = pair('capability-window');
  assert.ok(store.session(paired.sessionId).capabilities.includes(STUDIO_DIAGNOSTICS_CAPABILITY));
  assert.throws(() => pair('unknown-window', ['studio.anything']), /Unsupported Studio method/);
});

test('store upserts absolute counts idempotently, keeps only advertised sessions and bounds entries and sessions', async t => {
  let now = Date.parse('2026-10-17T10:00:00.000Z');
  const { store, pair } = await storeFixture(t, () => now);
  const paired = pair('bounded-window');
  assert.equal(store.recordDiagnostics(paired.sessionId, [entry('d1')]), 1);
  now += 1000;
  // A resent report (lost acknowledgement) does not change the record.
  assert.equal(store.recordDiagnostics(paired.sessionId, [entry('d1')]), 1);
  let [group] = store.diagnostics();
  assert.equal(group!.sessionId, paired.sessionId); assert.equal(group!.live, true);
  assert.deepEqual(group!.entries.map(e => [e.id, e.count, e.firstAt, e.lastAt]), [['d1', 1, '2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.000Z']]);
  assert.equal(store.recordDiagnostics(paired.sessionId, [entry('d1', 4, { stack: 'Script ServerScriptService.Main, Line 7' })]), 1);
  [group] = store.diagnostics();
  assert.deepEqual(group!.entries.map(e => [e.count, e.firstAt, e.lastAt, e.stack]), [[4, '2026-10-17T10:00:00.000Z', '2026-10-17T10:00:01.000Z', 'Script ServerScriptService.Main, Line 7']]);
  // Oversized text is clipped to the fixed display bounds.
  store.recordDiagnostics(paired.sessionId, [entry('long', 1, { message: 'x'.repeat(5000), source: 'p'.repeat(900) })]);
  const long = store.diagnostics()[0]!.entries[0]!;
  assert.equal(long.message.length, STUDIO_DIAGNOSTIC_LIMITS.messageChars); assert.equal(long.source!.length, STUDIO_DIAGNOSTIC_LIMITS.sourceChars);
  // Distinct entries are bounded per session; the oldest are evicted first.
  for (let batch = 0; batch < 15; batch++) store.recordDiagnostics(paired.sessionId, Array.from({ length: 10 }, (_, i) => entry('b' + (batch * 10 + i))));
  const entries = store.diagnostics()[0]!.entries;
  assert.equal(entries.length, STUDIO_DIAGNOSTIC_LIMITS.entries);
  assert.equal(entries[0]!.id, 'b149'); assert.equal(entries.at(-1)!.id, 'b50');
  // Malformed reports are dropped whole and never partially applied.
  for (const bad of [
    Array.from({ length: 11 }, (_, i) => entry('over' + i)),
    [entry('ok1'), { ...entry('bad'), kind: 'info' }],
    [entry('ok2'), { ...entry('extra'), command: 'script.update' }],
    [entry('bad id!')], [entry('zero', 0)], [entry('line', 1, { line: 0 })], [{ ...entry('nomsg'), message: '' }],
    'not-an-array', [], [entry('big', 1, { stack: 's'.repeat(100 * 1024) })],
  ]) assert.equal(store.recordDiagnostics(paired.sessionId, bad), 0);
  assert.equal(store.diagnostics()[0]!.entries.some(e => ['ok1', 'ok2', 'over0'].includes(e.id)), false);
  // A session that never advertised the capability cannot store diagnostics.
  const legacy = pair('legacy-window', [...READ_METHODS]);
  assert.equal(store.recordDiagnostics(legacy.sessionId, [entry('legacy')]), 0);
  assert.equal(store.diagnostics().some(g => g.sessionId === legacy.sessionId), false);
  // Sessions are bounded too.
  const sessions: PairResult[] = [];
  for (let i = 0; i < STUDIO_DIAGNOSTIC_LIMITS.sessions + 1; i++) { const p = pair('many-' + i); sessions.push(p); store.recordDiagnostics(p.sessionId, [entry('m')]); }
  const listed = store.diagnostics();
  assert.equal(listed.length, STUDIO_DIAGNOSTIC_LIMITS.sessions);
  assert.equal(listed[0]!.sessionId, sessions.at(-1)!.sessionId);
  assert.equal(listed.some(g => g.sessionId === paired.sessionId), false, 'least recently reporting session is evicted');
  assert.equal(store.clearDiagnostics(sessions.at(-1)!.sessionId), 1);
  assert.equal(store.diagnostics().length, STUDIO_DIAGNOSTIC_LIMITS.sessions - 1);
  store.clearDiagnostics(); assert.deepEqual(store.diagnostics(), []);
});

test('loopback route: plugin reports ride on the poll; only the human session reads or clears them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-studio-diagnostics-http-'));
  const store = new StudioStore({ directory });
  const app = await createConnectionLab({ cwd: resolve('.'), stateDirectory: join(directory, 'preferences'), studioStore: store, probe: async () => [], codexConnect: refuseNativeCodex });
  t.after(async () => { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, token?: string, origin?: string) => fetch(app.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  const read = (token?: string, origin?: string) => fetch(app.origin + '/v1/studio/diagnostics', { headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}) } });
  const grant = await (await post('/v1/studio/pairing', { allowedRoots: ['Workspace'], allowWrites: false }, app.token)).json() as { code: string };
  const pair = await (await post('/v1/plugin/pair', { code: grant.code, protocolVersion: 1, identity: identity('http-window'), capabilities: [...READ_METHODS, STUDIO_DIAGNOSTICS_CAPABILITY] })).json() as PairResult;
  const polled = await post('/v1/plugin/poll', { sessionId: pair.sessionId, diagnostics: [entry('d1', 2)] }, pair.token);
  assert.equal(polled.status, 200); assert.deepEqual(await polled.json(), { commands: [] });
  // A malformed report never fails the poll that carried it, and is not stored.
  const malformed = await post('/v1/plugin/poll', { sessionId: pair.sessionId, diagnostics: [{ id: 'x', kind: 'error' }] }, pair.token);
  assert.equal(malformed.status, 200);
  // The diagnostics route is not reachable by the plugin bearer, an agent, a foreign origin or no bearer.
  assert.equal((await read()).status, 401);
  assert.equal((await read(pair.token)).status, 401);
  assert.equal((await read(app.agentToken)).status, 403);
  assert.equal((await read(app.token, 'https://attacker.example')).status, 403);
  assert.equal((await fetch(app.origin + '/v1/studio/diagnostics?sessionId=' + pair.sessionId, { headers: { Authorization: 'Bearer ' + app.token } })).status, 404);
  assert.equal((await post('/v1/studio/diagnostics/clear', {}, app.agentToken)).status, 403);
  assert.equal((await post('/v1/studio/diagnostics/clear', {}, pair.token)).status, 401);
  const human = await read(app.token);
  assert.equal(human.status, 200);
  const items = readStudioDiagnostics(await human.json());
  assert.deepEqual(items.map(i => [i.id, i.count, i.source, i.line, i.sessionId, i.live]), [['d1', 2, 'ServerScriptService.Main', 7, pair.sessionId, true]]);
  assert.equal(studioFixPrompt(items[0]!), 'Fix this Studio error: attempt to index nil with d1 in ServerScriptService.Main line 7. Read the live script first with script_read.');
  const cleared = await post('/v1/studio/diagnostics/clear', {}, app.token, app.origin);
  assert.equal(cleared.status, 200); assert.deepEqual(await cleared.json(), { cleared: 1 });
  assert.deepEqual(readStudioDiagnostics(await (await read(app.token)).json()), []);
});

test('the dock reader skips malformed items, orders newest first and writes a precise fix request', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s)).toISOString();
  const items = readStudioDiagnostics({ diagnostics: [
    { sessionId: 's1', placeName: 'Obby', live: true, entries: [
      { id: 'a', kind: 'warning', message: 'Infinite yield possible', source: null, line: null, stack: null, count: 1, firstAt: at(1), lastAt: at(1) },
      { id: 'b', kind: 'error', message: '  attempt\n to call nil  ', source: 'Workspace.Door.Script', line: 12, stack: null, count: 3, firstAt: at(0), lastAt: at(5) },
      { id: 'c', kind: 'info', message: 'skip', count: 1, firstAt: at(0), lastAt: at(0) },
      { id: 'd', kind: 'error', message: 'skip', count: 0, firstAt: at(0), lastAt: at(0) },
      '<img src=x>',
    ] },
    { placeName: 'missing session', entries: [] },
  ] });
  assert.deepEqual(items.map(i => [i.id, i.placeName]), [['b', 'Obby'], ['a', 'Obby']]);
  assert.equal(studioFixPrompt(items[0]!), 'Fix this Studio error: attempt to call nil in Workspace.Door.Script line 12. Read the live script first with script_read.');
  assert.equal(studioFixPrompt(items[1]!), 'Fix this Studio warning: Infinite yield possible. Read the live script first with script_read.');
  assert.throws(() => readStudioDiagnostics({ sessions: [] }), /unavailable/);
});

/* ---- Reader state: synthetic only (no daemon, Studio, browser, provider or real network). ---- */

const SESSION = 'a'.repeat(64), NEXT_SESSION = 'b'.repeat(64);
const READ_AT = Date.UTC(2026, 9, 20, 9, 0, 30);
const stampAt = (s: number) => new Date(Date.UTC(2026, 9, 20, 9, 0, s)).toISOString();
const hhmmss = (value: string) => value.slice(11, 19);
const diag = (id: string, kind: 'error' | 'warning', s = 1) =>
  ({ id, kind, message: kind + ' ' + id, source: 'ServerScriptService.Main', line: 3, stack: null, count: 1, firstAt: stampAt(s), lastAt: stampAt(s) });
const many = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => diag(prefix + i, 'warning', i % 50));
const group = (...entries: unknown[]) => ({ sessionId: 'session-1', placeName: 'Obby', live: true, entries });
const body = (...groups: unknown[]) => JSON.stringify({ diagnostics: groups });
const payload = (...entries: unknown[]) => body(group(...entries));
const parsed = (...entries: unknown[]) => readStudioDiagnostics(JSON.parse(payload(...entries)) as unknown);
/** The receipt of a complete parse of exactly these items. */
const complete = (items: readonly StudioDiagnosticItemView[]): StudioDiagnosticsReceipt => ({ entries: items.length, skipped: 0, malformed: 0, truncated: 0 });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

interface FakeCall {
  readonly path: string; readonly method: string; readonly authorization: string | null; readonly body: string | null;
  readonly init: RequestInit | undefined; readonly signal: AbortSignal | null;
  respond(status: number, text?: string): void;
  reject(): void;
}
/** Deferred transport: each request waits until the test answers it. With honourAbort=false it ignores abort, like a slow host. */
function fakeNetwork(honourAbort = true) {
  const calls: FakeCall[] = [];
  const transport: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };
    const body = init?.body;
    calls.push({
      path: String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('Authorization'),
      body: typeof body === 'string' ? body : null, init, signal: init?.signal ?? null,
      respond: (status, text = '') => finish(() => resolve({ ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response)),
      reject: () => finish(() => reject(new TypeError('Failed to fetch'))),
    });
    if (honourAbort) init?.signal?.addEventListener('abort', () => finish(() => reject(new Error('aborted'))), { once: true });
  });
  const last = (): FakeCall => { const call = calls.at(-1); assert.ok(call, 'a request was sent'); return call; };
  return { transport, calls, last };
}
function fakeClock() {
  const timers: { callback: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
  const live = () => timers.filter(timer => !timer.cancelled && !timer.fired);
  return {
    live,
    schedule: (callback: () => void, ms: number) => { const timer = { callback, ms, cancelled: false, fired: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    fire: () => { const timer = live()[0]; assert.ok(timer, 'a poll is scheduled'); timer.fired = true; timer.callback(); },
  };
}
function readerHarness(honourAbort = true) {
  const net = fakeNetwork(honourAbort), clock = fakeClock();
  const world = { token: SESSION, online: true, active: true };
  const reader = createStudioDiagnosticsReader({ token: () => world.token, transport: net.transport, schedule: clock.schedule, intervalMs: 4000,
    online: () => world.online, active: () => world.active, now: () => READ_AT });
  const seen: StudioDiagnosticsSnapshot[] = [];
  reader.subscribe(snapshot => { seen.push(snapshot); });
  const answer = async (status: number, text = '') => { net.last().respond(status, text); await flush(); };
  const readWith = async (status: number, text = '') => { const done = reader.read(); net.last().respond(status, text); await done; };
  return { reader, net, clock, world, seen, answer, readWith };
}
type ReaderHarness = ReturnType<typeof readerHarness>;

/** No severity, the neutral class, no clean status or label and no '0' count: nothing about this snapshot looks clear. */
function assertNotGreen(snapshot: StudioDiagnosticsSnapshot, name: string) {
  assert.equal(studioDiagnosticsSeverity(snapshot), null, name + ': no severity without an exact current proof');
  const view = studioDiagnosticsPresentation(snapshot, hhmmss);
  assert.deepEqual([view.tone, view.className, view.severity], ['neutral', 'studio-diagnostics--neutral', 'unknown'], name + ': neutral class, never clear');
  assert.notEqual(view.status, 'No Studio errors or warnings.', name);
  assert.doesNotMatch(view.ariaLabel, /no errors/i, name);
  assert.notEqual(view.count, '0', name + ': a 0 count only ever comes from a current clean read');
}
function assertNeverClear(snapshot: StudioDiagnosticsSnapshot, name: string) {
  assert.notEqual(snapshot.state, 'current', name);
  if (snapshot.state === 'partial') {
    const view = studioDiagnosticsPresentation(snapshot, hhmmss);
    assert.notEqual(studioDiagnosticsSeverity(snapshot), 'clear', name);
    assert.notEqual(view.tone, 'clear', name);
    assert.notEqual(view.severity, 'none', name);
    assert.notEqual(view.status, 'No Studio errors or warnings.', name);
    assert.doesNotMatch(view.ariaLabel, /no errors/i, name);
    assert.notEqual(view.count, '0', name);
  } else assertNotGreen(snapshot, name);
}

/** HTTP 200 receipts the tolerant item reader cleans up, but which can never prove a current read. `tolerant`: items it returns. */
const receipts: { name: string; fault: 'malformed' | 'incomplete'; body: string; tolerant: number }[] = [
  { name: 'every entry malformed', fault: 'malformed', body: body({ entries: [{ id: 'x', kind: 'error' }], sessionId: 's' }), tolerant: 0 },
  { name: 'every group malformed', fault: 'malformed', body: body({ placeName: 'Obby', entries: [] }, 'junk', { sessionId: 's', entries: 'none' }), tolerant: 0 },
  { name: 'valid and malformed entries mixed', fault: 'malformed', body: payload(diag('w1', 'warning'), { ...diag('e1', 'error'), count: 0 }), tolerant: 1 },
  { name: 'a present field with an invalid value', fault: 'malformed', body: payload({ ...diag('e1', 'error'), line: 'seven' }), tolerant: 1 },
  { name: 'more entries in one group than the dock shows', fault: 'incomplete', body: payload(...many(101)), tolerant: 100 },
  { name: 'more entries in all than the dock shows', fault: 'incomplete', body: body(group(...many(60, 'a')), { ...group(...many(60, 'b')), sessionId: 'session-2' }), tolerant: 100 },
  { name: 'more groups than the dock shows', fault: 'incomplete', body: body(...Array.from({ length: 17 }, (_, i) => ({ ...group(), sessionId: 'session-' + i }))), tolerant: 0 },
  { name: 'text longer than its display bound', fault: 'incomplete', body: payload({ ...diag('e1', 'error'), message: 'x'.repeat(2049) }), tolerant: 1 },
];

/** Every way a read can fail to be current. `epoch`: the failure changes the authorised-session observation, so output
 * from before it is dropped instead of kept stale. Three carry a clean answer that must be discarded. */
const failures: { name: string; fault: StudioDiagnosticsFault; httpStatus: number | null; epoch: boolean; run: (h: ReaderHarness) => Promise<void> }[] = [
  { name: 'HTTP 500', fault: 'http', httpStatus: 500, epoch: false, run: h => h.readWith(500) },
  { name: 'network error', fault: 'network', httpStatus: null, epoch: false, run: async h => { const done = h.reader.read(); h.net.last().reject(); await done; } },
  { name: 'not JSON', fault: 'malformed', httpStatus: null, epoch: false, run: h => h.readWith(200, '<html>') },
  { name: 'wrong shape', fault: 'malformed', httpStatus: null, epoch: false, run: h => h.readWith(200, '{"sessions":[]}') },
  { name: 'oversized', fault: 'malformed', httpStatus: null, epoch: false, run: h => h.readWith(200, JSON.stringify({ diagnostics: [], pad: 'x'.repeat(2 * 1024 * 1024) })) },
  ...receipts.filter(receipt => receipt.fault === 'malformed').map(receipt => ({ name: receipt.name + ' (HTTP 200)', fault: receipt.fault, httpStatus: null, epoch: false, run: (h: ReaderHarness) => h.readWith(200, receipt.body) })),
  { name: 'offline before the read', fault: 'offline', httpStatus: null, epoch: false, run: async h => {
    const sent = h.net.calls.length; h.world.online = false; await h.reader.read(); assert.equal(h.net.calls.length, sent, 'nothing is sent while offline'); } },
  { name: 'offline during the read (clean answer discarded)', fault: 'offline', httpStatus: null, epoch: false, run: async h => {
    const done = h.reader.read(); h.world.online = false; h.net.last().respond(200, payload()); await done; } },
  { name: 'no local session', fault: 'no-session', httpStatus: null, epoch: true, run: async h => {
    const sent = h.net.calls.length; h.world.token = ''; await h.reader.read(); assert.equal(h.net.calls.length, sent, 'nothing is sent without the session'); } },
  { name: 'session lost during the read (clean answer discarded)', fault: 'no-session', httpStatus: null, epoch: true, run: async h => {
    const done = h.reader.read(); h.world.token = ''; h.net.last().respond(200, payload()); await done; } },
  { name: 'session changed during the read (clean answer discarded)', fault: 'session-mismatch', httpStatus: null, epoch: true, run: async h => {
    const done = h.reader.read(); h.world.token = NEXT_SESSION; h.net.last().respond(200, payload()); await done; } },
];

test('reader state machine: every transition between neutral, current, stale and failed', () => {
  const at = new Date(READ_AT).toISOString(), found = parsed(diag('e1', 'error', 2), diag('w1', 'warning', 1)), none: StudioDiagnosticItemView[] = [];
  const reduce = reduceStudioDiagnostics;
  let generation = 0;
  const begin = (from: StudioDiagnosticsSnapshot, session = from.session || 1) => reduce(from, { type: 'begin', generation: ++generation, session });
  const settle = (from: StudioDiagnosticsSnapshot, items: readonly StudioDiagnosticItemView[], receipt = complete(items)) =>
    reduce(from, { type: 'settle', generation: from.generation, session: from.session, items, receipt, at });
  const answer = (from: StudioDiagnosticsSnapshot, fault: StudioDiagnosticsReadFault, httpStatus?: number) =>
    reduce(from, httpStatus === undefined ? { type: 'fault', generation: from.generation, session: from.session, fault }
      : { type: 'fault', generation: from.generation, session: from.session, fault, httpStatus });
  const read = (from: StudioDiagnosticsSnapshot, items: readonly StudioDiagnosticItemView[], receipt?: StudioDiagnosticsReceipt) => settle(begin(from), items, receipt);
  const fail = (from: StudioDiagnosticsSnapshot, fault: StudioDiagnosticsReadFault) => answer(begin(from), fault);
  const skip = (from: StudioDiagnosticsSnapshot, session = from.session || 1) => reduce(from, { type: 'skip', generation: ++generation, session });
  const supersede = (from: StudioDiagnosticsSnapshot, session = from.session || 1) => reduce(from, { type: 'supersede', generation: ++generation, session });
  const clear = (from: StudioDiagnosticsSnapshot) => {
    const superseded = supersede(from);
    return reduce(superseded, { type: 'cleared', generation: superseded.generation, session: superseded.session });
  };
  const check = (s: StudioDiagnosticsSnapshot, state: StudioDiagnosticsReaderState, reason: StudioDiagnosticsSnapshot['reason'], items: number, step: string) => {
    assert.equal(s.state, state, step); assert.equal(s.reason, reason, step); assert.equal(s.items.length, items, step);
    assert.ok(Object.isFrozen(s), step + ': snapshots are immutable');
    if (state === 'current' || state === 'partial') {
      assert.ok(s.proof, step);
      assert.deepEqual([s.pending, s.proof.generation, s.proof.session, s.proof.entries], [false, s.generation, s.session, s.items.length],
        step + ': proof of the exact generation, the session epoch and a complete receipt');
      assert.equal(s.proof.complete, state === 'current', step + ': proof records completeness');
      if (state === 'current') assert.notEqual(studioDiagnosticsSeverity(s), null, step);
      else assertNeverClear(s, step);
    } else assertNotGreen(s, step);
    if (state === 'neutral' || state === 'failed') assert.equal(s.proof, null, step);
    return s;
  };

  let s = check(STUDIO_DIAGNOSTICS_INITIAL, 'neutral', 'initial', 0, 'start');
  s = check(skip(s), 'neutral', 'initial', 0, 'neutral + skip -> neutral (nothing to mark stale)');
  s = check(begin(s), 'neutral', 'initial', 0, 'neutral + begin -> neutral while pending');
  assert.equal(s.pending, true);
  s = check(settle(s, found), 'current', null, 2, 'neutral + read -> current');
  assert.equal(studioDiagnosticsSeverity(s), 'errors');
  const proven = s;
  s = check(begin(s), 'stale', 'superseded', 2, 'current + begin -> stale while the newer read is pending (an older proof is never current)');
  assert.equal(s.pending, true); assert.equal(s.items, proven.items, 'the proven output is kept'); assert.equal(s.proof, proven.proof, 'with its proof');
  s = check(answer(s, 'http', 503), 'stale', 'http', 2, 'pending + HTTP failure -> stale');
  assert.equal(s.httpStatus, 503); assert.equal(s.items, proven.items); assert.equal(s.proof, proven.proof);
  s = check(fail(s, 'malformed'), 'stale', 'malformed', 2, 'stale + malformed -> stale with the latest reason');
  assert.equal(s.httpStatus, null);
  s = check(read(s, found, { ...complete(found), skipped: 1 }), 'stale', 'malformed', 2, 'stale + a receipt with skipped entries -> stale, malformed');
  s = check(read(s, found, { ...complete(found), truncated: 3 }), 'partial', 'incomplete', 2, 'stale + a valid truncated receipt -> partial with captured evidence');
  assert.notEqual(s.items, proven.items, 'fresh partial evidence replaces the older list');
  assert.deepEqual(s.items, found);
  s = check(skip(s), 'stale', 'skipped', 2, 'stale + skip -> stale');
  s = check(read(s, none), 'current', null, 0, 'stale + read -> current');
  assert.equal(studioDiagnosticsSeverity(s), 'clear');
  s = check(supersede(s), 'stale', 'superseded', 0, 'current (clean) + supersede (stop) -> stale, not clear');
  s = check(read(s, found), 'current', null, 2, 'stale + read -> current');
  s = check(fail(s, 'offline'), 'stale', 'offline', 2, 'current + offline -> stale');
  s = check(read(s, found), 'current', null, 2, 'stale + read -> current again');
  s = check(skip(s), 'stale', 'skipped', 2, 'current + skip -> stale');
  s = check(fail(read(s, found), 'network'), 'stale', 'network', 2, 'current + network failure -> stale');
  s = check(clear(s), 'neutral', 'cleared', 0, 'stale + human Clear -> neutral, not a clean read');
  s = check(fail(s, 'network'), 'failed', 'network', 0, 'neutral + failure -> failed');
  s = check(skip(s), 'failed', 'network', 0, 'failed + skip -> failed, unchanged');
  s = check(fail(s, 'no-session'), 'failed', 'no-session', 0, 'failed + failure -> failed with the latest reason');
  s = check(read(s, found, { ...complete(found), malformed: 1 }), 'failed', 'malformed', 0, 'failed + a receipt with a defaulted field -> failed, nothing shown');
  s = check(read(s, none, { ...complete(none), truncated: 1 }), 'partial', 'incomplete', 0, 'an empty but truncated receipt is never a clean read');
  s = check(read(s, none, { ...complete(none), entries: 1 }), 'stale', 'malformed', 0, 'a receipt that does not cover the items given is refused');
  s = check(read(s, found), 'current', null, 2, 'failed + read -> current');
  s = check(clear(s), 'neutral', 'cleared', 0, 'current + human Clear -> neutral');
  s = check(read(s, found), 'current', null, 2, 'cleared + read -> current');
  s = check(begin(s, s.session + 1), 'neutral', 'session-changed', 0, 'current + begin in a new session epoch -> neutral, old output dropped');
  assert.equal(s.pending, true);
  s = check(answer(s, 'session-mismatch'), 'failed', 'session-mismatch', 0, 'new epoch + mismatch -> failed');
  s = check(read(s, found), 'current', null, 2, 'failed + read -> current in the new epoch');
  s = check(skip(s, s.session + 1), 'neutral', 'session-changed', 0, 'current + skip in a new epoch -> neutral, old output dropped');
  s = check(read(s, found), 'current', null, 2, 'neutral + read -> current');
  s = check(supersede(s, s.session + 1), 'neutral', 'session-changed', 0, 'current + supersede in a new epoch -> neutral, old output dropped');
  s = check(clear(s), 'neutral', 'cleared', 0, 'neutral + Clear -> neutral, cleared');
  s = check(read(s, none), 'current', null, 0, 'neutral + clean read -> current clear');
  assert.equal(studioDiagnosticsSeverity(s), 'clear');
});

test('answers that do not match the exact pending generation and session are ignored; severity needs an exact proof', () => {
  const reduce = reduceStudioDiagnostics, items = parsed(diag('e1', 'error')), at = new Date(READ_AT).toISOString();
  const begun = reduce(STUDIO_DIAGNOSTICS_INITIAL, { type: 'begin', generation: 1, session: 1 });
  const settle = (from: StudioDiagnosticsSnapshot, generation: number, session: number) => reduce(from, { type: 'settle', generation, session, items, receipt: complete(items), at });
  assert.equal(settle(begun, 0, 1), begun, 'an older generation');
  assert.equal(settle(begun, 2, 1), begun, 'a generation that was never issued');
  assert.equal(settle(begun, 1, 2), begun, 'another session');
  const landed = settle(begun, 1, 1);
  assert.equal(landed.state, 'current');
  assert.equal(settle(landed, 1, 1), landed, 'a duplicate answer');
  assert.equal(reduce(landed, { type: 'fault', generation: 1, session: 1, fault: 'http', httpStatus: 500 }), landed, 'a late failure for a read that landed');
  assert.equal(reduce(landed, { type: 'begin', generation: 1, session: 1 }), landed, 'a generation is never reused');
  const pending = reduce(landed, { type: 'begin', generation: 2, session: 1 });
  assert.deepEqual([pending.state, pending.reason, pending.pending], ['stale', 'superseded', true], 'a newer read in flight ends the current state');
  assert.equal(studioDiagnosticsSeverity(pending), null);
  const superseded = reduce(pending, { type: 'supersede', generation: 3, session: 1 });
  assert.deepEqual([superseded.state, superseded.reason, superseded.pending], ['stale', 'superseded', false]);
  assert.equal(reduce(superseded, { type: 'settle', generation: 2, session: 1, items: [], receipt: complete([]), at }), superseded, 'a superseded clean answer cannot land');
  assert.equal(reduce(superseded, { type: 'cleared', generation: 2, session: 1 }), superseded, 'a clear for an older generation');
  assert.equal(reduce(superseded, { type: 'cleared', generation: 3, session: 2 }), superseded, 'a clear for another session');
  assert.equal(reduce(superseded, { type: 'skip', generation: 3, session: 1 }), superseded, 'a skip must be newer');
  assert.equal(studioDiagnosticsSeverity(superseded), null, 'superseded (stop or clear) is never green, even over an errors proof');
  // Severity itself refuses any proof that is not exact, whatever the state field says.
  const cleanRead = reduce(begun, { type: 'settle', generation: 1, session: 1, items: [], receipt: complete([]), at });
  assert.equal(studioDiagnosticsSeverity(cleanRead), 'clear');
  assert.equal(studioDiagnosticsSeverity(landed), 'errors');
  const forged: [string, StudioDiagnosticsSnapshot][] = [
    ['an older proof', { ...cleanRead, generation: cleanRead.generation + 1 }],
    ['a read in flight', { ...cleanRead, pending: true }],
    ['another session epoch', { ...cleanRead, session: cleanRead.session + 1 }],
    ['items the proof does not cover', { ...cleanRead, items }],
    ['no proof', { ...cleanRead, proof: null }],
    ['an incomplete proof marked current', { ...cleanRead, proof: { ...cleanRead.proof!, complete: false } }],
    ['an older proof over errors', { ...landed, generation: landed.generation + 1 }],
    ['errors with a read in flight', { ...landed, pending: true }],
  ];
  for (const [name, snapshot] of forged) assertNotGreen(snapshot, 'forged current: ' + name);
});

test('complete and partial exact proofs govern severity; stale and failed states render neutral with a label', () => {
  assert.deepEqual(STUDIO_DIAGNOSTICS_TONES, ['clear', 'warnings', 'errors', 'neutral']);
  const at = new Date(READ_AT).toISOString();
  const reduce = reduceStudioDiagnostics;
  const current = (items: readonly StudioDiagnosticItemView[]) =>
    reduce(reduce(STUDIO_DIAGNOSTICS_INITIAL, { type: 'begin', generation: 1, session: 1 }), { type: 'settle', generation: 1, session: 1, items, receipt: complete(items), at });
  const begin = (from: StudioDiagnosticsSnapshot) => reduce(from, { type: 'begin', generation: from.generation + 1, session: 1 });
  const after = (from: StudioDiagnosticsSnapshot, fault: StudioDiagnosticsReadFault, httpStatus?: number) => {
    const begun = begin(from);
    return reduce(begun, httpStatus === undefined ? { type: 'fault', generation: begun.generation, session: 1, fault }
      : { type: 'fault', generation: begun.generation, session: 1, fault, httpStatus });
  };
  const receiptOf = (from: StudioDiagnosticsSnapshot, items: readonly StudioDiagnosticItemView[], receipt: StudioDiagnosticsReceipt) => {
    const begun = begin(from);
    return reduce(begun, { type: 'settle', generation: begun.generation, session: 1, items, receipt, at });
  };
  for (const [snapshot, tone, severity, ariaLabel, status] of [
    [current(parsed()), 'clear', 'none', 'Studio output: no errors or warnings', 'No Studio errors or warnings.'],
    [current(parsed(diag('w1', 'warning'))), 'warnings', 'warning', 'Studio output: 1 warning', ''],
    [current(parsed(diag('e1', 'error', 2), diag('w1', 'warning'))), 'errors', 'error', 'Studio output: 1 error, 1 warning', ''],
  ] as const) {
    const view = studioDiagnosticsPresentation(snapshot, hhmmss);
    assert.deepEqual([view.tone, view.className, view.severity, view.ariaLabel, view.status, view.label], [tone, 'studio-diagnostics--' + tone, severity, ariaLabel, status, 'Studio']);
  }
  const faults: StudioDiagnosticsReadFault[] = ['http', 'network', 'malformed', 'incomplete', 'offline', 'no-session', 'session-mismatch'];
  const priors = [current(parsed()), current(parsed(diag('w1', 'warning'))), current(parsed(diag('e1', 'error', 2), diag('w1', 'warning')))];
  const begunOnly = reduce(STUDIO_DIAGNOSTICS_INITIAL, { type: 'begin', generation: 1, session: 1 });
  const cleared = reduce(reduce(priors[2]!, { type: 'supersede', generation: 2, session: 1 }), { type: 'cleared', generation: 2, session: 1 });
  const switched = reduce(priors[2]!, { type: 'begin', generation: 2, session: 2 });
  const others: StudioDiagnosticsSnapshot[] = [STUDIO_DIAGNOSTICS_INITIAL, begunOnly, cleared, switched,
    ...faults.map(fault => after(STUDIO_DIAGNOSTICS_INITIAL, fault, fault === 'http' ? 500 : undefined)),
    ...priors.flatMap(prior => [
      ...faults.map(fault => after(prior, fault, fault === 'http' ? 503 : undefined)),
      begin(prior),
      reduce(prior, { type: 'supersede', generation: 9, session: 1 }),
      reduce(prior, { type: 'skip', generation: 9, session: 1 }),
      receiptOf(prior, prior.items, { ...complete(prior.items), skipped: 1 }),
      receiptOf(prior, prior.items, { ...complete(prior.items), truncated: 1 }),
    ])];
  for (const snapshot of others) assertNeverClear(snapshot, snapshot.state + '/' + String(snapshot.reason) + (snapshot.pending ? '/pending' : ''));
  const text = (snapshot: StudioDiagnosticsSnapshot) => { const view = studioDiagnosticsPresentation(snapshot, hhmmss); return [view.label, view.count, view.ariaLabel, view.status]; };
  assert.deepEqual(text(STUDIO_DIAGNOSTICS_INITIAL), ['Studio', '–', 'Studio output: not read yet', 'Studio output has not been read yet.']);
  assert.deepEqual(text(cleared), ['Studio', '–', 'Studio output: cleared, not read since', 'Cleared.']);
  assert.deepEqual(text(switched), ['Studio', '–', 'Studio output: not read for this session yet', 'Studio output has not been read for this session yet.']);
  assert.deepEqual(text(after(STUDIO_DIAGNOSTICS_INITIAL, 'http', 500)),
    ['Studio (unread)', '–', 'Studio output could not be read (the read failed (HTTP 500)).', 'Studio output could not be read: the read failed (HTTP 500).']);
  assert.deepEqual(text(after(priors[2]!, 'http', 503)), ['Studio (stale)', '2',
    'Studio output is stale (the read failed (HTTP 503)). Last read at 09:00:30: 1 error, 1 warning.',
    'Stale: the read failed (HTTP 503). Showing the output read at 09:00:30.']);
  assert.deepEqual(text(after(priors[0]!, 'malformed')), ['Studio (stale)', '–',
    'Studio output is stale (the reply was unreadable). Last read at 09:00:30: nothing reported.',
    'Stale: the reply was unreadable. Showing the output read at 09:00:30.']);
  assert.deepEqual(text(reduce(priors[1]!, { type: 'skip', generation: 9, session: 1 })).slice(2), [
    'Studio output is stale (the read was skipped (no active Studio session)). Last read at 09:00:30: 1 warning.',
    'Stale: the read was skipped (no active Studio session). Showing the output read at 09:00:30.']);
  // A newer read in flight after a current one: the label and count hold still, the tone is neutral, nothing claims clean.
  assert.deepEqual(text(begin(priors[2]!)), ['Studio', '2', 'Studio output: checking. Last read at 09:00:30: 1 error, 1 warning.',
    'Checking Studio output. Showing the output read at 09:00:30.']);
  assert.deepEqual(text(begin(priors[0]!)), ['Studio', '–', 'Studio output: checking. Last read at 09:00:30: nothing reported.',
    'Checking Studio output. Showing the output read at 09:00:30.']);
  assert.deepEqual(text(reduce(priors[0]!, { type: 'supersede', generation: 9, session: 1 })), ['Studio (stale)', '–',
    'Studio output is stale (the read was interrupted). Last read at 09:00:30: nothing reported.',
    'Stale: the read was interrupted. Showing the output read at 09:00:30.']);
  // A retry after a fault reads exactly like the settled stale view, so a failing poll does not flicker.
  const failing = after(priors[2]!, 'http', 503);
  assert.deepEqual(text(begin(failing)), text(failing));
  assert.deepEqual(text(receiptOf(priors[1]!, priors[1]!.items, { ...complete(priors[1]!.items), truncated: 1 })), ['Studio (incomplete)', '1+',
    'Studio output is incomplete. At least 1 warning captured.',
    'Incomplete Studio output. At least 1 warning captured. More output or text was omitted. Read at 09:00:30.']);
  assert.deepEqual(text(receiptOf(STUDIO_DIAGNOSTICS_INITIAL, [], { ...complete([]), truncated: 1 })), ['Studio (incomplete)', '–',
    'Studio output is incomplete. No entries captured; the total is unknown.',
    'Incomplete Studio output. No entries captured; the total is unknown. More output or text was omitted. Read at 09:00:30.']);
});

test('one parse: the tolerant item reader is unchanged, and a read is current only when that parse skipped, defaulted and cut nothing', async () => {
  for (const receipt of receipts) {
    const tolerant = readStudioDiagnostics(JSON.parse(receipt.body) as unknown);
    assert.equal(tolerant.length, receipt.tolerant, receipt.name + ': the item reader still skips and bounds as before');
    const h = readerHarness();
    await h.readWith(200, receipt.body);
    const s = h.reader.snapshot();
    if (receipt.fault === 'malformed') {
      assert.deepEqual([s.state, s.reason, s.items.length, s.proof], ['failed', 'malformed', 0, null], receipt.name);
    } else {
      assert.deepEqual([s.state, s.reason, s.items], ['partial', 'incomplete', tolerant], receipt.name + ': retain the exact bounded captured output');
      assert.equal(s.proof?.complete, false, receipt.name);
    }
    assertNeverClear(s, receipt.name);
  }
  const bodyOf = (name: string) => { const receipt = receipts.find(r => r.name === name); assert.ok(receipt, name); return JSON.parse(receipt.body) as unknown; };
  // The tolerant reader keeps the valid warning, which alone would have looked like 'warnings' and hidden the dropped error.
  assert.deepEqual(readStudioDiagnostics(bodyOf('valid and malformed entries mixed')).map(item => [item.id, item.kind]), [['w1', 'warning']]);
  assert.equal(readStudioDiagnostics(bodyOf('a present field with an invalid value'))[0]?.line, null);
  assert.equal(readStudioDiagnostics(bodyOf('text longer than its display bound'))[0]?.message.length, 2048);
  // A complete receipt: the reader shows exactly what the item reader returns, with a proof over every entry.
  const full = payload(diag('e1', 'error', 2), diag('w1', 'warning', 1), { ...diag('w2', 'warning', 3), source: null, line: null });
  const h = readerHarness();
  await h.readWith(200, full);
  assert.deepEqual(h.reader.snapshot().items, readStudioDiagnostics(JSON.parse(full) as unknown));
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().proof?.entries, studioDiagnosticsSeverity(h.reader.snapshot())], ['current', 3, 'errors']);
  // Absent optional fields are valid; only a present, invalid value counts against the receipt.
  const sparse = body({ sessionId: 's', entries: [{ id: 'e1', kind: 'error', message: 'm', count: 1, firstAt: stampAt(1), lastAt: stampAt(1) }] });
  await h.readWith(200, sparse);
  const s = h.reader.snapshot();
  assert.deepEqual([s.state, s.items.map(item => [item.placeName, item.live, item.source, item.line, item.stack])], ['current', [['Studio', false, null, null, null]]]);
});

test('reader: a read is current only with proof of its exact generation, its session and a complete parsed answer', async () => {
  const h = readerHarness();
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['neutral', 'initial']);
  const pending = h.reader.read(), call = h.net.last();
  assert.deepEqual([call.path, call.method, call.authorization, call.body], [STUDIO_DIAGNOSTICS_ROUTE, 'GET', 'Bearer ' + SESSION, null]);
  assert.deepEqual([call.init?.cache, call.init?.redirect, call.init?.credentials, call.init?.referrerPolicy], ['no-store', 'error', 'omit', 'no-referrer']);
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().pending], ['neutral', true], 'still neutral until the answer lands');
  call.respond(200, payload(diag('e1', 'error', 2), diag('w1', 'warning', 1)));
  await pending;
  const s = h.reader.snapshot();
  assert.deepEqual([s.state, s.reason, s.pending, s.session], ['current', null, false, 1]);
  assert.deepEqual(s.proof, { generation: s.generation, session: 1, at: new Date(READ_AT).toISOString(), entries: 2, complete: true });
  assert.deepEqual(s.items.map(item => item.id), ['e1', 'w1']);
  assert.equal(studioDiagnosticsSeverity(s), 'errors');
  assert.equal(JSON.stringify(s).includes(SESSION), false, 'the snapshot never carries the bearer');
});

test('reader: a failed, malformed, offline or unauthorised first read is failed and never clear', async () => {
  for (const failure of failures) {
    const h = readerHarness();
    await failure.run(h);
    const s = h.reader.snapshot();
    assert.deepEqual([s.state, s.reason, s.httpStatus, s.items.length, s.proof], ['failed', failure.fault, failure.httpStatus, 0, null], failure.name);
    assertNeverClear(s, failure.name);
    assert.ok(h.seen.every(seen => seen.state !== 'current'), failure.name + ': no intermediate snapshot was current');
  }
});

test('reader: after a proven read a failure in the same session keeps that output, labelled stale; a session change drops it', async () => {
  const priors: ReturnType<typeof diag>[][] = [[], [diag('e1', 'error', 2), diag('w1', 'warning', 1)]];
  for (const prior of priors) {
    for (const failure of failures) {
      const h = readerHarness(), name = failure.name + ' after ' + prior.length + ' items';
      await h.readWith(200, payload(...prior));
      const proven = h.reader.snapshot();
      assert.equal(proven.state, 'current', name);
      await failure.run(h);
      const s = h.reader.snapshot();
      assertNeverClear(s, name);
      if (failure.epoch) {
        // Never one session's output as another's: nothing from before the change is kept, not even labelled stale.
        assert.deepEqual([s.state, s.reason, s.items.length, s.proof], ['failed', failure.fault, 0, null], name);
        assert.ok(s.session > proven.session, name + ': a new session epoch');
        continue;
      }
      assert.deepEqual([s.state, s.reason, s.httpStatus], ['stale', failure.fault, failure.httpStatus], name);
      assert.equal(s.items, proven.items, name + ': the same output is kept');
      assert.equal(s.proof, proven.proof, name + ': with its original proof');
      const view = studioDiagnosticsPresentation(s, hhmmss);
      assert.equal(view.label, 'Studio (stale)', name);
      assert.equal(view.count, prior.length ? String(prior.length) : '–', name);
      assert.match(view.status, /^Stale: .+\. Showing the output read at 09:00:30\.$/, name);
    }
  }
});

test('reader: a proof covers one exact generation; a newer read, stop, failure or skip is never green and a late answer never lands', async () => {
  { // An old successful empty read, then a held new read.
    const h = readerHarness();
    await h.readWith(200, payload());
    assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear', 'the old successful empty read');
    const held = h.reader.read(), call = h.net.last(), s = h.reader.snapshot();
    assert.deepEqual([s.state, s.reason, s.pending], ['stale', 'superseded', true]);
    assert.ok(s.proof && s.proof.generation < s.generation, 'the proof is for an older generation');
    assertNeverClear(s, 'a held new read after a clean one');
    assert.equal(studioDiagnosticsPresentation(s, hhmmss).status, 'Checking Studio output. Showing the output read at 09:00:30.');
    call.respond(200, payload()); await held;
    assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear', 'clear again only once the newer read lands');
  }
  { // stop() supersedes the proof, and so does the resumed read until it lands. A read from before stop() never lands.
    const h = readerHarness(false); // This transport ignores abort, so the late answer really arrives.
    await h.readWith(200, payload());
    const before = h.reader.read(), early = h.net.last();
    h.reader.stop();
    assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason, h.reader.snapshot().pending], ['stale', 'superseded', false]);
    assertNeverClear(h.reader.snapshot(), 'stopped after a clean read');
    assert.equal(h.reader.resume(), true);
    const resumed = h.reader.read(), again = h.net.last();
    assertNeverClear(h.reader.snapshot(), 'a held read after resume');
    early.respond(200, payload()); await before;
    assertNeverClear(h.reader.snapshot(), 'a late clean answer from before stop()');
    again.respond(200, payload(diag('e1', 'error'))); await resumed;
    assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'errors');
  }
  { // A failed read after a clean one.
    const h = readerHarness();
    await h.readWith(200, payload());
    await h.readWith(500);
    assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['stale', 'http']);
    assertNeverClear(h.reader.snapshot(), 'a failed read after a clean one');
  }
  { // A skipped poll after a clean one sends nothing.
    const h = readerHarness();
    await h.readWith(200, payload());
    h.world.active = false; h.reader.start(); await flush();
    assert.equal(h.net.calls.length, 1);
    assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['stale', 'skipped']);
    assertNeverClear(h.reader.snapshot(), 'a skipped poll after a clean one');
    h.reader.dispose();
  }
  { // A late success for an obsolete generation cannot turn a newer failure clear.
    const h = readerHarness();
    await h.readWith(200, payload());
    const older = h.reader.read(), a = h.net.last(), newer = h.reader.read(), b = h.net.last();
    b.respond(500); await newer;
    a.respond(200, payload()); await older;
    const s = h.reader.snapshot();
    assert.deepEqual([s.state, s.reason, s.httpStatus], ['stale', 'http', 500], 'the obsolete clean answer did not land');
    assertNeverClear(s, 'a late obsolete success');
  }
});

test('reader: a skipped poll sends nothing and marks prior output stale; with no prior output it stays neutral', async () => {
  const h = readerHarness();
  h.world.active = false;
  h.reader.start(); await flush();
  assert.equal(h.net.calls.length, 0, 'a skipped poll sends no request');
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['neutral', 'initial']);
  h.world.active = true; h.clock.fire();
  await h.answer(200, payload(diag('e1', 'error')));
  assert.equal(h.reader.snapshot().state, 'current');
  const proven = h.reader.snapshot();
  h.world.active = false; h.clock.fire(); await flush();
  assert.equal(h.net.calls.length, 1);
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['stale', 'skipped']);
  assert.equal(h.reader.snapshot().items, proven.items);
  assertNeverClear(h.reader.snapshot(), 'skipped');
  h.world.active = true; h.clock.fire();
  await h.answer(200, payload());
  assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear', 'only a new proven read is clear');
  h.reader.dispose();
});

test('reader: only the answer to the latest read lands, whatever order answers arrive in', async () => {
  const h = readerHarness();
  const first = h.reader.read(), a = h.net.last(), second = h.reader.read(), b = h.net.last();
  assert.notEqual(a, b);
  b.respond(200, payload(diag('new', 'warning'))); await second;
  a.respond(200, payload(diag('old1', 'error'), diag('old2', 'error'))); await first;
  assert.deepEqual(h.reader.snapshot().items.map(item => item.id), ['new'], 'an older answer arriving late is ignored');
  assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'warnings');
  const third = h.reader.read(), c = h.net.last(), fourth = h.reader.read(), d = h.net.last();
  c.respond(500); await third;
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason, h.reader.snapshot().pending], ['stale', 'superseded', true],
    'a superseded failure does not land; the newer read is still in flight');
  d.respond(200, payload()); await fourth;
  assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear');
  const fifth = h.reader.read(), e = h.net.last(), sixth = h.reader.read(), f = h.net.last();
  f.respond(200, payload(diag('e9', 'error'))); await sixth;
  e.respond(200, payload()); await fifth;
  assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'errors', 'a superseded clean answer cannot turn errors clear');
  assert.ok(h.seen.every((snapshot, index) => index === 0 || snapshot.generation >= h.seen[index - 1]!.generation), 'generations only move forward');
});

test('reader: reads require the current authorised session; every change of it is a new epoch that starts neutral', async () => {
  const h = readerHarness();
  h.world.token = 'not-a-session';
  await h.reader.read();
  assert.equal(h.net.calls.length, 0, 'no request without the authorised session');
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason, h.reader.snapshot().session], ['failed', 'no-session', 1]);
  h.world.token = SESSION;
  await h.readWith(200, payload(diag('e1', 'error')));
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().session], ['current', 2]);
  h.world.token = NEXT_SESSION;
  const pending = h.reader.read();
  const switched = h.reader.snapshot();
  assert.deepEqual([switched.state, switched.reason, switched.items.length, switched.session, switched.pending], ['neutral', 'session-changed', 0, 3, true]);
  assertNeverClear(switched, 'new session');
  assert.equal(h.net.last().authorization, 'Bearer ' + NEXT_SESSION);
  h.net.last().respond(200, payload(diag('w2', 'warning'))); await pending;
  const s = h.reader.snapshot();
  assert.deepEqual([s.state, s.session, s.proof?.session, s.items.map(item => item.id)], ['current', 3, 3, ['w2']]);
  const sent = h.net.calls.length;
  h.world.token = '';
  await h.reader.read();
  assert.equal(h.net.calls.length, sent);
  const lost = h.reader.snapshot();
  assert.deepEqual([lost.state, lost.reason, lost.items.length, lost.proof, lost.session], ['failed', 'no-session', 0, null, 4],
    'losing the session drops its output; it is not kept as stale');
});

test('reader: A -> no bearer -> A is three epochs; nothing is requested without the bearer and no held answer crosses an epoch', async () => {
  const h = readerHarness();
  await h.readWith(200, payload(diag('a1', 'error')));
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().session], ['current', 1]);
  // A read is held in epoch 1 when the bearer goes away.
  const heldA = h.reader.read(), callA = h.net.last();
  h.world.token = '';
  const sent = h.net.calls.length;
  await h.reader.read();
  let s = h.reader.snapshot();
  assert.deepEqual([s.state, s.reason, s.items.length, s.proof, s.session], ['failed', 'no-session', 0, null, 2], 'losing the bearer drops the old output');
  // No request of any kind while the bearer is missing: polls, skipped polls and Clear included.
  h.reader.start(); await flush();
  h.clock.fire(); await flush();
  h.world.active = false; h.clock.fire(); await flush();
  assert.equal(await h.reader.clear({ isTrusted: true }), false, 'Clear needs the bearer too');
  assert.equal(h.net.calls.length, sent, 'no request while the bearer is missing');
  assert.equal(h.reader.snapshot().session, 2, 'repeated observations of no bearer stay in one epoch');
  // The same bearer text comes back: a third epoch, which starts neutral and shows nothing from the first.
  h.world.token = SESSION;
  const heldB = h.reader.read(), callB = h.net.last();
  assert.equal(callB.authorization, 'Bearer ' + SESSION);
  s = h.reader.snapshot();
  assert.deepEqual([s.state, s.reason, s.items.length, s.session, s.pending], ['neutral', 'session-changed', 0, 3, true]);
  assertNeverClear(s, 'the same bearer back');
  // The epoch-1 answer arrives now, with the same bearer text in place again: it still never lands.
  callA.respond(200, payload(diag('a1', 'error'))); await heldA;
  assert.equal(h.reader.snapshot(), s, 'an answer held across A -> none -> A is ignored');
  callB.respond(200, payload()); await heldB;
  s = h.reader.snapshot();
  assert.deepEqual([s.state, s.session, s.proof?.session, s.items.length, studioDiagnosticsSeverity(s)], ['current', 3, 3, 0, 'clear']);
  assert.ok(h.seen.filter(seen => seen.session !== 1).every(seen => !seen.items.some(item => item.id === 'a1')), 'epoch 1 output is never shown in another epoch');
  assert.equal(JSON.stringify(h.seen).includes(SESSION), false, 'no snapshot carries the bearer');
  h.reader.dispose();
});

test('reader: a session lost during a read, or changed while polls are skipped, drops the shown output at once', async () => {
  const h = readerHarness();
  await h.readWith(200, payload(diag('e1', 'error')));
  const pending = h.reader.read();
  h.world.token = '';
  h.net.last().respond(200, payload(diag('e1', 'error'))); await pending;
  let s = h.reader.snapshot();
  assert.deepEqual([s.state, s.reason, s.items.length, s.proof], ['failed', 'no-session', 0, null], 'not stale with the old session output');
  h.world.token = SESSION;
  await h.readWith(200, payload(diag('e2', 'error')));
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().items.map(item => item.id)], ['current', ['e2']]);
  // Polls are skipped (no active Studio) when the bearer changes: the skip notices, and the old output goes.
  const sent = h.net.calls.length;
  h.world.active = false; h.world.token = NEXT_SESSION;
  h.reader.start(); await flush();
  s = h.reader.snapshot();
  assert.deepEqual([s.state, s.reason, s.items.length, s.proof], ['neutral', 'session-changed', 0, null]);
  assert.equal(h.net.calls.length, sent, 'a skipped poll sends nothing');
  assertNeverClear(s, 'changed while skipped');
  h.reader.dispose();
});

test('reader: stop, resume and dispose stop timers, detach listeners and never land a late answer', async () => {
  const h = readerHarness(false); // This transport ignores abort, like a slow host: late answers still must not land.
  h.reader.start();
  const first = h.net.last();
  h.reader.stop();
  assert.equal(first.signal?.aborted, true, 'stop aborts the read in flight');
  assert.equal(h.clock.live().length, 0, 'no poll is scheduled while stopped');
  first.respond(200, payload(diag('late', 'error'))); await flush();
  assert.equal(h.reader.snapshot().state, 'neutral', 'an answer from before stop() never lands');
  assert.equal(h.clock.live().length, 0, 'and does not reschedule the poll');
  await h.reader.read();
  assert.equal(h.net.calls.length, 1, 'no reads while stopped');
  assert.equal(h.reader.resume(), true);
  assert.equal(h.reader.resume(), false, 'resume is idempotent');
  assert.equal(h.net.calls.length, 2, 'resume polls at once');
  await h.answer(200, payload(diag('e1', 'error')));
  assert.equal(h.reader.snapshot().state, 'current');
  assert.equal(h.clock.live().length, 1);
  h.clock.fire();
  const third = h.net.last(), notified = h.seen.length;
  h.reader.dispose();
  const final = h.reader.snapshot();
  assertNeverClear(final, 'after dispose');
  assert.equal(third.signal?.aborted, true, 'dispose aborts the read in flight');
  assert.equal(h.clock.live().length, 0, 'dispose cancels the poll');
  third.respond(200, payload()); await flush();
  assert.equal(h.reader.snapshot(), final, 'a late answer after dispose never lands');
  assert.equal(h.seen.length, notified, 'listeners are detached');
  await h.reader.read(); h.reader.start();
  assert.equal(h.reader.resume(), false);
  assert.equal(await h.reader.clear({ isTrusted: true }), false);
  assert.equal(h.net.calls.length, 3, 'a disposed reader never sends again');
  assert.equal(h.clock.live().length, 0);
});

test('reader: Clear is human-initiated only, supersedes reads in flight and never fakes a clean read', async () => {
  const h = readerHarness();
  await h.readWith(200, payload(diag('e1', 'error', 2), diag('w1', 'warning', 1)));
  const proven = h.reader.snapshot();
  assert.equal(await h.reader.clear({ isTrusted: false }), false, 'a scripted trigger is refused');
  assert.equal(await h.reader.clear(null), false, 'no trigger is refused');
  assert.equal(h.net.calls.length, 1, 'nothing was sent');
  assert.equal(h.reader.snapshot(), proven);
  // A clear that fails keeps what was shown, but no longer claims it current: the daemon may have changed meanwhile.
  const failing = h.reader.clear({ isTrusted: true });
  assertNeverClear(h.reader.snapshot(), 'while clearing');
  h.net.last().respond(500);
  assert.equal(await failing, false);
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason], ['stale', 'superseded']);
  assert.equal(h.reader.snapshot().items, proven.items);
  // A read in flight when the person clears can never repaint the old output.
  const reading = h.reader.read(), inFlight = h.net.last();
  const clearing = h.reader.clear({ isTrusted: true }), post = h.net.last();
  assert.deepEqual([post.path, post.method, post.authorization, post.body], [STUDIO_DIAGNOSTICS_CLEAR_ROUTE, 'POST', 'Bearer ' + SESSION, '{}']);
  const during = h.net.calls.length;
  await h.reader.read();
  assert.equal(h.net.calls.length, during, 'no read starts while clearing');
  inFlight.respond(200, payload(diag('e1', 'error', 2), diag('w1', 'warning', 1))); await reading;
  post.respond(200, '{"cleared":1}');
  assert.equal(await clearing, true);
  const cleared = h.reader.snapshot();
  assert.deepEqual([cleared.state, cleared.reason, cleared.items.length, cleared.proof], ['neutral', 'cleared', 0, null]);
  assertNeverClear(cleared, 'after Clear');
  assert.equal(studioDiagnosticsPresentation(cleared).status, 'Cleared.');
  await h.readWith(200, payload());
  assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear', 'only the next proven read shows clean');
  // Another bearer cannot clear output it never read: the change is a new epoch, which drops the view and clears nothing.
  const posts = () => h.net.calls.filter(call => call.method === 'POST').length;
  h.world.token = NEXT_SESSION;
  assert.equal(await h.reader.clear({ isTrusted: true }), false);
  assert.equal(posts(), 2);
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().reason, h.reader.snapshot().items.length], ['neutral', 'session-changed', 0]);
  h.world.token = SESSION;
  h.reader.start();
  await h.answer(200, payload(diag('e2', 'error')));
  h.clock.fire();
  await h.answer(200, payload(diag('e2', 'error')));
  assert.equal(h.reader.snapshot().state, 'current');
  assert.equal(posts(), 2, 'only the two human clicks ever cleared');
  h.reader.dispose();
});

/** Minimal DOM double for the dock: elements, classes, attributes, listeners with AbortSignal, and a composer textarea. */
class FakeNode {
  id = ''; type = ''; className = ''; title = ''; value = ''; text = ''; hidden = false; disabled = false; focused = 0;
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(' ').filter(Boolean)), on = force ?? !names.has(name);
      if (on) names.add(name); else names.delete(name);
      this.className = Array.from(names).join(' ');
      return on;
    },
    contains: (name: string): boolean => this.className.split(' ').includes(name),
  };
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  append(...nodes: FakeNode[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]): void { this.text = ''; this.children = [...nodes]; }
  addEventListener(type: string, listener: (event: Event) => void, options?: { signal?: AbortSignal }): void {
    const signal = options?.signal;
    if (signal?.aborted) return;
    const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    set.add(listener); this.listeners.set(type, set);
    signal?.addEventListener('abort', () => { set.delete(listener); }, { once: true });
  }
  removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: Event): boolean { for (const listener of Array.from(this.listeners.get(event.type) ?? [])) listener(event); return true; }
  listenerCount(): number { let total = 0; for (const set of this.listeners.values()) total += set.size; return total; }
  click(isTrusted: boolean): void { this.dispatchEvent({ type: 'click', isTrusted } as unknown as Event); }
  focus(): void { this.focused++; }
  all(): FakeNode[] { return this.children.flatMap(child => [child, ...child.all()]); }
  /** Every rendered string on this node: text, title, class, value, id, dataset and attributes. */
  strings(): string[] { return [this.text, this.title, this.className, this.value, this.id, ...Object.values(this.dataset), ...this.attributes.values()]; }
}
class FakeComposer extends FakeNode {
  events: string[] = []; submits = 0; selection: number[] = [];
  readonly form = { requestSubmit: () => { this.submits++; }, submit: () => { this.submits++; } };
  override dispatchEvent(event: Event): boolean { this.events.push(event.type); return super.dispatchEvent(event); }
  setSelectionRange(start: number, end: number): void { this.selection = [start, end]; }
}
class FakeDocument extends EventTarget {
  readonly root = new FakeNode('MAIN');
  readonly composer = new FakeComposer('TEXTAREA');
  readonly defaultView = { CustomEvent, Event, HTMLTextAreaElement: FakeComposer, navigator: { onLine: true } };
  constructor() {
    super();
    const mount = new FakeNode('DIV'); mount.id = 'studio-diagnostics'; mount.hidden = true;
    this.composer.id = 'codex-composer';
    this.root.append(mount, this.composer);
  }
  get mount(): FakeNode { const node = this.getElementById('studio-diagnostics'); assert.ok(node); return node; }
  createElement(tag: string): FakeNode { return new FakeNode(tag.toUpperCase()); }
  createElementNS(_namespace: string, tag: string): FakeNode { return this.createElement(tag); }
  getElementById(id: string): FakeNode | null { return this.root.all().find(node => node.id === id) ?? null; }
  byClass(name: string): FakeNode[] { return this.root.all().filter(node => node.classList.contains(name)); }
  /** Every string anywhere in the rendered tree. */
  rendered(): string[] { return [this.root, ...this.root.all()].flatMap(node => node.strings()); }
  asDocument(): Document { return this as unknown as Document; }
}
/** The dock's parts and its class, attribute and label hooks in one tuple. */
function dockParts(doc: FakeDocument) {
  const mount = doc.mount, one = (name: string) => { const node = doc.byClass(name)[0]; assert.ok(node, name); return node; };
  const parts = { toggle: one('studio-diagnostics-badge'), clearButton: one('studio-diagnostics-clear'), panel: one('studio-diagnostics-panel'),
    status: one('studio-diagnostics-status'), count: one('studio-diagnostics-count'), label: one('studio-diagnostics-label') };
  const tones = () => STUDIO_DIAGNOSTICS_TONES.filter(tone => mount.classList.contains('studio-diagnostics--' + tone));
  return { ...parts, one, rows: () => doc.byClass('studio-diagnostic'),
    hooks: () => [tones(), mount.dataset.reader, mount.dataset.severity, mount.hidden, parts.count.textContent, parts.label.textContent] };
}

test('prefillComposer (Fix) appends to the draft, announces input and focuses, and never submits or overflows', () => {
  const doc = new FakeDocument();
  const request = studioFixPrompt({ kind: 'error', message: 'attempt to index nil', source: 'ServerScriptService.Main', line: 7 });
  assert.equal(prefillComposer(doc.asDocument(), request), true);
  assert.equal(doc.composer.value, request);
  doc.composer.value = 'Keep the door animation.  ';
  assert.equal(prefillComposer(doc.asDocument(), request), true);
  assert.equal(doc.composer.value, 'Keep the door animation.\n\n' + request);
  const draft = doc.composer.value;
  assert.equal(prefillComposer(doc.asDocument(), 'x'.repeat(131072)), false);
  assert.equal(doc.composer.value, draft, 'an oversized request leaves the draft untouched');
  assert.deepEqual(doc.composer.events, ['input', 'input']);
  assert.deepEqual(doc.composer.selection, [draft.length, draft.length]);
  assert.equal(doc.composer.submits, 0, 'prefill never submits');
});

test('dock (synthetic DOM): classes follow the reader state, Fix only prefills, Clear needs a person and dispose detaches everything', async () => {
  const doc = new FakeDocument(), net = fakeNetwork(), clock = fakeClock();
  let shown = 0;
  const dock = startStudioDiagnostics(doc.asDocument(), { token: () => SESSION, transport: net.transport, schedule: clock.schedule, intervalMs: 4000,
    now: () => READ_AT, formatTime: hhmmss, online: () => true, showConversation: () => { shown++; } });
  const { toggle, clearButton, panel, status, one, rows, hooks } = dockParts(doc);
  assert.equal(net.calls.length, 1, 'the first poll starts at once');
  assert.deepEqual(hooks(), [['neutral'], 'neutral', 'unknown', false, '–', 'Studio'], 'an active Studio session keeps the neutral pill visible before any answer');
  assert.equal(status.getAttribute('aria-busy'), 'true', 'the live region is busy while a read is in flight');
  net.last().respond(200, payload(diag('e1', 'error', 2), diag('w1', 'warning', 1))); await flush();
  assert.deepEqual(hooks(), [['errors'], 'current', 'error', false, '2', 'Studio']);
  assert.equal(status.getAttribute('aria-busy'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Studio output: 1 error, 1 warning');
  const listed = rows();
  assert.equal(listed.length, 2);
  // The next poll is in flight: rows and label hold still, but nothing is claimed until it lands.
  clock.fire();
  assert.deepEqual(hooks(), [['neutral'], 'stale', 'unknown', false, '2', 'Studio'], 'a read in flight is never current');
  assert.equal(status.textContent, 'Checking Studio output. Showing the output read at 09:00:30.');
  assert.equal(status.getAttribute('aria-busy'), 'true');
  assert.ok(rows().every((row, index) => row === listed[index]), 'rows are not rebuilt while checking');
  net.last().respond(500); await flush();
  assert.deepEqual(hooks(), [['neutral'], 'stale', 'unknown', false, '2', 'Studio (stale)'], 'a failed read keeps the rows, labelled stale');
  assert.equal(status.textContent, 'Stale: the read failed (HTTP 500). Showing the output read at 09:00:30.');
  assert.equal(status.getAttribute('aria-busy'), 'false');
  assert.equal(rows().length, 2);
  // Fix prefills the composer and does nothing else.
  toggle.click(false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the badge still opens from script (the shell closes it that way)');
  const sent = net.calls.length;
  one('studio-diagnostic-fix').click(true);
  assert.equal(doc.composer.value, studioFixPrompt(dock.items()[0]!));
  assert.deepEqual([doc.composer.events, doc.composer.submits, doc.composer.focused, shown], [['input'], 0, 1, 1]);
  assert.equal(net.calls.length, sent, 'Fix sends nothing');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  // Clear: a scripted click does nothing; a person's click clears without claiming a clean read.
  clearButton.click(false);
  assert.equal(net.calls.length, sent);
  assert.equal(rows().length, 2);
  clearButton.click(true);
  const post = net.last();
  assert.deepEqual([post.path, post.method], [STUDIO_DIAGNOSTICS_CLEAR_ROUTE, 'POST']);
  assert.equal(clearButton.disabled, true);
  assert.equal(status.textContent, 'Clearing Studio output.');
  post.respond(200, '{"cleared":1}'); await flush();
  assert.deepEqual(hooks(), [['neutral'], 'neutral', 'unknown', false, '–', 'Studio']);
  assert.equal(rows().length, 0);
  assert.equal(status.textContent, 'Cleared.');
  // Only a read proves clean.
  clock.fire(); net.last().respond(200, payload()); await flush();
  assert.deepEqual(hooks(), [['clear'], 'current', 'none', false, '', 'Studio'], 'a complete clean read shows the dot while Studio is active');
  assert.equal(status.textContent, 'No Studio errors or warnings.');
  assert.equal(doc.rendered().some(value => value.includes(SESSION)), false, 'the bearer is never rendered');
  // dispose: no timers, no listeners, no late effects.
  const before = net.calls.length;
  dock.dispose();
  assert.equal(clock.live().length, 0);
  assert.equal(toggle.listenerCount() + clearButton.listenerCount() + panel.listenerCount(), 0);
  doc.composer.value = '';
  doc.dispatchEvent(new CustomEvent(WORKSPACE_PREFILL_EVENT, { detail: { text: 'after dispose' } }));
  assert.equal(doc.composer.value, '', 'the prefill listener is gone');
  await dock.refresh(); dock.resume();
  assert.equal(net.calls.length, before);
});

test('dock (synthetic DOM): a held read, a lost session and an incomplete receipt are never green, and the bearer is never rendered', async () => {
  const doc = new FakeDocument(), net = fakeNetwork(), clock = fakeClock();
  let bearer = SESSION;
  const dock = startStudioDiagnostics(doc.asDocument(), { token: () => bearer, transport: net.transport, schedule: clock.schedule, intervalMs: 4000,
    now: () => READ_AT, formatTime: hhmmss, online: () => true, showWhenClear: true });
  const { clearButton, status, rows, hooks } = dockParts(doc);
  net.last().respond(200, payload()); await flush();
  assert.deepEqual(hooks(), [['clear'], 'current', 'none', false, '', 'Studio'], 'the clean pill uses the current terminal-and-dot presentation');
  // The next poll is held: the pill keeps its place in the topbar but is neutral, never green.
  clock.fire();
  assert.deepEqual(hooks(), [['neutral'], 'stale', 'unknown', false, '–', 'Studio']);
  assert.equal(status.textContent, 'Checking Studio output. Showing the output read at 09:00:30.');
  net.last().respond(200, payload(diag('e1', 'error'))); await flush();
  assert.deepEqual(hooks(), [['errors'], 'current', 'error', false, '1', 'Studio']);
  // The bearer goes away: the next poll sends nothing, and the rows go with the old epoch.
  bearer = '';
  const sent = net.calls.length;
  clock.fire(); await flush();
  assert.equal(net.calls.length, sent, 'no request without the bearer');
  assert.deepEqual(hooks(), [['neutral'], 'failed', 'unknown', false, '–', 'Studio (unread)']);
  assert.equal(rows().length, 0, 'output from the old session is not kept');
  // The same bearer back is a new epoch: neutral until its own read lands.
  bearer = SESSION;
  clock.fire();
  assert.deepEqual(hooks(), [['neutral'], 'neutral', 'unknown', false, '–', 'Studio']);
  // Valid incomplete output retains the observed warnings; it can never claim clear.
  net.last().respond(200, payload(...many(101))); await flush();
  assert.deepEqual(hooks(), [['warnings'], 'partial', 'warning', false, '100+', 'Studio (incomplete)']);
  assert.equal(rows().length, 100);
  assert.equal(status.textContent, 'Incomplete Studio output. At least 100 warnings captured. More output or text was omitted. Read at 09:00:30.');
  assert.equal(clearButton.disabled, false);
  clearButton.click(true);
  const post = net.last();
  assert.deepEqual([post.path, post.method, post.authorization], [STUDIO_DIAGNOSTICS_CLEAR_ROUTE, 'POST', 'Bearer ' + SESSION]);
  post.respond(200, '{"cleared":1}'); await flush();
  assert.deepEqual(hooks(), [['neutral'], 'neutral', 'unknown', false, '–', 'Studio']);
  assert.equal(doc.rendered().some(value => value.includes(SESSION)), false, 'the bearer is never rendered');
  dock.dispose();
});

test('API compatibility: the item reader and dock signatures are unchanged; reader state exports are additive', async () => {
  // Compile-time: the existing exports keep their exact signatures.
  const reader: (value: unknown) => StudioDiagnosticItemView[] = readStudioDiagnostics;
  const tone: (read: 'none' | 'current' | 'stale' | 'failed', items: readonly Pick<StudioDiagnosticItem, 'kind'>[]) => 'clear' | 'warnings' | 'errors' | 'neutral' = studioDiagnosticsTone;
  assert.deepEqual([tone('current', []), tone('stale', [{ kind: 'error' }])], ['clear', 'neutral']);
  const prompt: (item: Pick<StudioDiagnosticItem, 'kind' | 'message' | 'source' | 'line'>) => string = studioFixPrompt;
  const prefill: (doc: Document, value: string) => boolean = prefillComposer;
  const start: (doc: Document, options: StudioDiagnosticsOptions) => StudioDiagnosticsDock = startStudioDiagnostics;
  assert.deepEqual([reader.length, prompt.length, prefill.length, start.length], [1, 1, 2, 2]);
  assert.deepEqual([WORKSPACE_PREFILL_EVENT, STUDIO_DIAGNOSTICS_ROUTE, STUDIO_DIAGNOSTICS_CLEAR_ROUTE], ['workspace:prefill', '/v1/studio/diagnostics', '/v1/studio/diagnostics/clear']);
  // The options studio.ts passes today still type-check without any new field.
  const legacy: StudioDiagnosticsOptions = { token: () => SESSION, active: () => true, showConversation: () => {} };
  const dock = startStudioDiagnostics({ getElementById: () => null } as unknown as Document, legacy);
  // The dock shape studio.ts stores is still satisfied, and Clear is not a programmatic method.
  const legacyDock: { stop(): void; resume(): void; refresh(): Promise<void>; items(): readonly StudioDiagnosticItemView[] } = dock;
  assert.deepEqual(Object.keys(dock), ['stop', 'resume', 'refresh', 'items', 'state', 'dispose']);
  assert.equal('clear' in dock, false);
  await legacyDock.refresh(); legacyDock.stop(); legacyDock.resume();
  assert.deepEqual(legacyDock.items(), []);
  assert.equal(dock.state(), STUDIO_DIAGNOSTICS_INITIAL);
  dock.dispose();
  assert.throws(() => readStudioDiagnostics(null), /unavailable/);
  assert.deepEqual(readStudioDiagnostics({ diagnostics: [] }), []);
});

test('partial reads retain bounded errors, warnings and empty evidence with exact completeness proofs; malformed output stays refused', async () => {
  const cases = [
    { name: 'errors beyond the entry bound', raw: payload(...many(101, 'error').map(item => ({ ...item, kind: 'error' }))), length: 100, severity: 'errors', count: '100+' },
    { name: 'warnings beyond the entry bound', raw: payload(...many(101)), length: 100, severity: 'warnings', count: '100+' },
    { name: 'a clipped error message', raw: payload({ ...diag('clipped', 'error'), message: 'x'.repeat(2049) }), length: 1, severity: 'errors', count: '1+' },
    { name: 'unread groups beyond the group bound', raw: body(...Array.from({ length: 17 }, (_, i) => ({ ...group(), sessionId: 's' + i }))), length: 0, severity: null, count: '–' },
  ] as const;
  for (const sample of cases) {
    const h = readerHarness();
    await h.readWith(200, payload());
    assert.equal(studioDiagnosticsSeverity(h.reader.snapshot()), 'clear', sample.name + ': prior clean proof');
    await h.readWith(200, sample.raw);
    const partial = h.reader.snapshot(), expected = readStudioDiagnostics(JSON.parse(sample.raw) as unknown);
    assert.deepEqual([partial.state, partial.reason, partial.pending, partial.items.length], ['partial', 'incomplete', false, sample.length], sample.name);
    assert.deepEqual(partial.items, expected, sample.name + ': retain precisely the tolerant bounded output');
    assert.deepEqual(partial.proof, { generation: partial.generation, session: partial.session, at: new Date(READ_AT).toISOString(), entries: sample.length, complete: false });
    assert.equal(studioDiagnosticsSeverity(partial), sample.severity, sample.name + ': severity describes captured evidence only');
    const view = studioDiagnosticsPresentation(partial, hhmmss);
    assert.deepEqual([view.label, view.count], ['Studio (incomplete)', sample.count]);
    assert.match(view.status, /^Incomplete Studio output\./);
    assertNeverClear(partial, sample.name);
    // A later malformed receipt is not a new partial proof, even when it also exceeds a bound.
    // The malformed entry is inside the inspected part, not hidden beyond the bounded reader.
    await h.readWith(200, payload({ id: 'malformed' }, ...many(101)));
    const stale = h.reader.snapshot();
    assert.deepEqual([stale.state, stale.reason], ['stale', 'malformed']);
    assert.equal(stale.items, partial.items, 'malformed evidence cannot replace the prior captured list');
    assertNeverClear(stale, sample.name + ': malformed after partial');
    assert.match(studioDiagnosticsPresentation(stale, hhmmss).status, /incomplete captured output/);
    // A complete empty read, rather than truncation or malformed output, is the only way back to clear.
    await h.readWith(200, payload());
    assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().items.length, studioDiagnosticsSeverity(h.reader.snapshot())], ['current', 0, 'clear']);
    h.reader.dispose();
  }
});

test('partial answers require the exact pending generation and bearer epoch including A-none-A', async () => {
  const h = readerHarness(false);
  await h.readWith(200, payload(...many(101).map(item => ({ ...item, kind: 'error' }))));
  const partial = h.reader.snapshot();
  const oldRead = h.reader.read(), oldCall = h.net.last();
  const pending = h.reader.snapshot();
  assertNotGreen(pending, 'partial evidence loses current severity while a newer read is pending');
  assert.equal(studioDiagnosticsPresentation(pending, hhmmss).count, '100+');
  assert.match(studioDiagnosticsPresentation(pending, hhmmss).status, /incomplete captured output/);
  h.world.token = '';
  const sent = h.net.calls.length;
  await h.reader.read();
  assert.equal(h.net.calls.length, sent, 'loss sends no new request');
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().items.length, h.reader.snapshot().proof], ['failed', 0, null]);
  h.world.token = SESSION;
  const freshRead = h.reader.read(), freshCall = h.net.last(), freshEpoch = h.reader.snapshot().session;
  assert.ok(freshEpoch > partial.session, 'the same bearer text returns in a new epoch');
  oldCall.respond(200, payload(...many(101).map(item => ({ ...item, kind: 'error' }))));
  await oldRead;
  assert.deepEqual([h.reader.snapshot().state, h.reader.snapshot().items.length, h.reader.snapshot().session], ['neutral', 0, freshEpoch], 'the old partial error response cannot land');
  freshCall.respond(200, payload(...many(101, 'fresh')));
  await freshRead;
  const fresh = h.reader.snapshot();
  assert.deepEqual([fresh.state, fresh.session, studioDiagnosticsSeverity(fresh)], ['partial', freshEpoch, 'warnings']);
  assert.ok(fresh.items.every(item => item.id.startsWith('fresh')));
  for (const forged of [
    { ...fresh, generation: fresh.generation + 1 }, { ...fresh, session: fresh.session + 1 }, { ...fresh, pending: true },
    { ...fresh, proof: null }, { ...fresh, proof: { ...fresh.proof!, complete: true } },
  ]) assertNotGreen(forged, 'a partial state label alone cannot establish an exact proof');
  assert.equal(h.seen.some(snapshot => JSON.stringify(snapshot).includes(SESSION)), false, 'the bearer is never public state');
  h.reader.dispose();
});

test('dock retains partial error rows and prefill only, marks empty partial unknown and preserves active-session presentation', async () => {
  const doc = new FakeDocument(), net = fakeNetwork(), clock = fakeClock();
  let active = true;
  const dock = startStudioDiagnostics(doc.asDocument(), { token: () => SESSION, transport: net.transport, schedule: clock.schedule,
    now: () => READ_AT, formatTime: hhmmss, active: () => active, online: () => true });
  const { one, clearButton, status, rows, hooks } = dockParts(doc);
  net.last().respond(200, payload(...many(101).map(item => ({ ...item, kind: 'error' })))); await flush();
  assert.deepEqual(hooks(), [['errors'], 'partial', 'error', false, '100+', 'Studio (incomplete)']);
  assert.equal(rows().length, 100);
  assert.match(status.textContent, /^Incomplete Studio output\. At least 100 errors captured\./);
  const sent = net.calls.length;
  one('studio-diagnostic-fix').click(true);
  assert.equal(doc.composer.value, studioFixPrompt(dock.items()[0]!));
  assert.equal(doc.composer.submits, 0);
  clearButton.click(false);
  assert.equal(net.calls.length, sent, 'neither Fix nor scripted Clear dispatches a request');
  const empty = dock.refresh();
  net.last().respond(200, body(...Array.from({ length: 17 }, (_, i) => ({ ...group(), sessionId: 's' + i }))));
  await empty;
  assert.deepEqual(hooks(), [['neutral'], 'partial', 'unknown', false, '–', 'Studio (incomplete)']);
  assert.equal(rows().length, 0);
  assert.match(status.textContent, /total is unknown/);
  assert.equal(clearButton.disabled, false, 'a human can clear even when no entry fit in the partial list');
  // A fresh read while there is no active Studio cannot display a live all-clear pill.
  active = false;
  const noStudio = dock.refresh(); net.last().respond(200, payload()); await noStudio;
  assert.deepEqual(hooks(), [['neutral'], 'stale', 'unknown', true, '–', 'Studio (stale)']);
  assert.equal(doc.rendered().some(value => value.includes(SESSION)), false);
  dock.dispose();
});
