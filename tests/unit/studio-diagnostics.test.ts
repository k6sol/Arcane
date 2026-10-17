import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioStore, STUDIO_DIAGNOSTICS_CAPABILITY, STUDIO_DIAGNOSTIC_LIMITS } from '../../packages/storage/src/studio-store.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';
import { READ_METHODS, type PairResult } from '../../packages/protocol/src/studio.js';
import { readStudioDiagnostics, studioFixPrompt } from '../../apps/desktop/src/studio-diagnostics.js';

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
