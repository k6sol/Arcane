import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession, parseNativeTokenUsage } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';

const THREAD = 'usage:thread', HUMAN = { initiatedBy: 'human' } as const;
const counts = (input = 100, output = 20) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 5 });
const rawUsage = (input = 100) => ({ total: counts(input), last: counts(50, 10), modelContextWindow: 200000 });
const notification = (tokenUsage: unknown = rawUsage(), threadId = THREAD, turnId = 'usage:turn:1') => ({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage } });

// Synthetic spawned-Node peer only. No installed CLI/provider/account/Studio is contacted.
function protocolPeer(): void {
  const { createInterface } = require('node:readline') as typeof import('node:readline');
  const { existsSync, readFileSync, appendFileSync } = require('node:fs') as typeof import('node:fs');
  const [gate, audit] = process.argv.slice(1);
  const send = (v: object) => process.stdout.write(JSON.stringify(v) + '\n');
  let lastGate = '', turn = 0;
  setInterval(() => {
    if (!existsSync(gate!)) return;
    const text = readFileSync(gate!, 'utf8');
    if (!text || text === lastGate) return;
    let value: { notifications: object[]; marker: number };
    try { value = JSON.parse(text) as typeof value; } catch { return; }
    lastGate = text;
    for (const n of value.notifications) send(n);
    // This exact bounded turn delta is a deterministic processing barrier.
    send({ method: 'item/agentMessage/delta', params: { threadId: 'usage:thread', turnId: `usage:turn:${turn}`, itemId: 'usage:barrier', delta: `barrier:${value.marker}` } });
  }, 5);
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params = {} } = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
    appendFileSync(audit!, JSON.stringify({ method }) + '\n');
    if (method === 'initialize') send({ id, result: {} });
    else if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
    else if (method === 'model/list') send({ id, result: { data: [{ id: 'usage-model', model: 'usage-model', displayName: 'Usage fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } });
    else if (method === 'thread/start' || method === 'thread/resume') send({ id, result: { thread: { id: 'usage:thread', sessionId: null, turns: [] }, model: params.model, modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, cwd: params.cwd } });
    else if (method === 'turn/start') {
      turn++;
      const value = { id: `usage:turn:${turn}`, status: 'inProgress', items: [], error: null };
      send({ method: 'turn/started', params: { threadId: 'usage:thread', turn: value } }); send({ id, result: { turn: value } });
    } else if (method === 'turn/interrupt') {
      send({ id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'usage:thread', turn: { id: `usage:turn:${turn}`, status: 'interrupted', durationMs: 321 } } });
    }
  });
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() >= deadline) assert.fail('Synthetic usage peer did not reach its barrier.'); await delay(5); }
}
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'arcane-token-usage-')), gate = join(dir, 'gate.json'), audit = join(dir, 'audit.jsonl');
  const session = new CodexSession({ command: process.execPath, args: ['-e', `(${protocolPeer.toString()})()`, gate, audit], cwd: process.cwd(), env: nativeEnvironment() }, limits({ requestTimeoutMs: 5000 }), 'spawned-node-fixture');
  t.after(async () => {
    await session.close();
    const child = relative(tmpdir(), dir); assert.ok(child.startsWith('arcane-token-usage-') && !child.includes(sep) && !child.includes('..'));
    await rm(dir, { recursive: true, force: true });
  });
  await session.initialize(); session.selectModel({ ...HUMAN, model: 'usage-model', effort: 'low' }); await session.startThread(HUMAN);
  let marker = 0;
  const emit = async (notifications: object[], expectedStatus?: string) => {
    marker++; await writeFile(gate, JSON.stringify({ marker, notifications }));
    await until(() => expectedStatus ? session.snapshot().thread?.turnStatus === expectedStatus : session.snapshot().events.some(e => e.type === 'delta' && e.text === `barrier:${marker}`));
  };
  const start = () => session.startTurn({ ...HUMAN, threadId: THREAD, text: 'Synthetic usage test only' });
  return { session, emit, start, audit };
}

test('local-schema usage whitelist supports cache-write omission without inventing it', () => {
  const u = rawUsage(), parsed = parseNativeTokenUsage(u)!;
  assert.equal(parsed.total.totalTokens, 120); assert.equal(parsed.last.totalTokens, 60); assert.equal(parsed.total.cacheWriteInputTokens, 0);
  delete (u.total as { cacheWriteInputTokens?: number }).cacheWriteInputTokens;
  delete (u.last as { cacheWriteInputTokens?: number }).cacheWriteInputTokens;
  const old = parseNativeTokenUsage(u)!; assert.ok(old); assert.equal(Object.hasOwn(old.total, 'cacheWriteInputTokens'), false);
});

test('parser preserves all eight existing native evaluation counters without treating last as the turn total', () => {
  // Whitelisted numbers from outputs/slot-{1..8}.json in the existing authorized
  // skill-evaluation-eight-turns-20261013 evidence. No receipt/auth text or IDs are copied.
  const rows = [
    [13384, 302, 0, 226, 6712, 277], [14457, 412, 7040, 339, 7249, 386],
    [13379, 374, 6528, 220, 6710, 348], [14793, 385, 7168, 260, 7417, 359],
    [14452, 311, 7040, 236, 7244, 290], [13380, 414, 0, 348, 6708, 393],
    [14788, 460, 7168, 341, 7412, 439], [13379, 326, 6528, 205, 6710, 300],
  ];
  for (const row of rows) {
    const [input, output, cached, reasoning, lastInput, lastOutput] = row as [number, number, number, number, number, number];
    const total = { ...counts(input, output), cachedInputTokens: cached, reasoningOutputTokens: reasoning };
    const last = { ...counts(lastInput, lastOutput), cachedInputTokens: cached, reasoningOutputTokens: reasoning };
    const parsed = parseNativeTokenUsage({ total, last, modelContextWindow: 475000 });
    assert.ok(parsed); assert.deepEqual(parsed.total, total); assert.deepEqual(parsed.last, last);
    assert.equal(parsed.modelContextWindow, 475000); assert.ok(parsed.total.totalTokens > parsed.last.totalTokens);
  }
});

test('bounded optional parser rejects malformed known counts and never invokes getters', () => {
  for (const bad of [-1, 0.1, Number.MAX_SAFE_INTEGER, Infinity, NaN, '100', null]) {
    const u = rawUsage(); (u.total as unknown as Record<string, unknown>).inputTokens = bad; assert.equal(parseNativeTokenUsage(u), null);
  }
  for (const bad of [undefined, [], {}, { total: counts(), last: counts(), modelContextWindow: -1 }]) assert.equal(parseNativeTokenUsage(bad), null);
  let invoked = false;
  const accessor = Object.defineProperty({}, 'total', { get() { invoked = true; throw Error(); } });
  assert.equal(parseNativeTokenUsage(accessor), null); assert.equal(invoked, false);
});

test('SDK publishes supported native method only, strips secrets, bounds malformed telemetry and deduplicates exact frames', { timeout: 15000 }, async t => {
  const { session, start, emit, audit } = await fixture(t);
  assert.equal(Object.hasOwn(session.snapshot(), 'usage'), false);
  await start();
  await emit([{ method: 'turn/tokenUsage/updated', params: { threadId: THREAD, turnId: 'usage:turn:1', tokenUsage: rawUsage() } }, notification(rawUsage(), 'other-thread'), notification(rawUsage(), THREAD, 'other-turn'), notification({ malformed: true })]);
  assert.equal(Object.hasOwn(session.snapshot(), 'usage'), false); assert.equal(session.snapshot().connected, true);
  const wire = { ...rawUsage(), accessToken: 'SYNTHETIC_SECRET', apiKey: 'SYNTHETIC_SECRET', model: 'SYNTHETIC_SECRET', cost: 1234 };
  await emit([notification(wire), notification(wire)]);
  const s = session.snapshot(), events = s.events.filter(e => e.type === 'usage');
  assert.equal(events.length, 1); assert.equal(s.usage?.seq, events[0]!.seq); assert.equal(s.usage?.total.totalTokens, 120);
  assert.equal(s.usage?.threadId, THREAD); assert.equal(s.usage?.turnId, 'usage:turn:1');
  assert.doesNotMatch(JSON.stringify(s), /SYNTHETIC_SECRET|accessToken|apiKey|cost/);
  s.usage!.total.totalTokens = 999; assert.equal(session.snapshot().usage!.total.totalTokens, 120);
  const requests = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string });
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests.some(r => /tokenUsage|rateLimits|login/.test(r.method)), false);
});

test('SDK cumulative regressions mark continuity uncertain and do not disconnect or make a new turn', { timeout: 15000 }, async t => {
  const { session, start, emit } = await fixture(t); await start();
  await emit([notification(rawUsage(300))]);
  await emit([notification(rawUsage(100))]);
  assert.equal(session.snapshot().usage?.continuity, 'uncertain'); assert.equal(session.snapshot().connected, true);
  await emit([notification(rawUsage(400))]); assert.equal(session.snapshot().usage?.continuity, 'uncertain');
});

test('SDK ignores delayed previous-turn usage and retains only exact current-turn attribution', { timeout: 15000 }, async t => {
  const { session, start, emit } = await fixture(t); await start();
  await emit([notification()]);
  await session.interruptTurn({ ...HUMAN, threadId: THREAD, turnId: 'usage:turn:1' });
  await until(() => session.snapshot().thread?.turnStatus === 'interrupted');
  assert.equal(session.snapshot().thread?.durationMs, 321);
  assert.equal(session.snapshot().events.some(e => e.type === 'turn' && e.durationMs === 321), true);
  await start(); assert.equal(session.snapshot().thread?.durationMs, undefined);
  await emit([notification(rawUsage(200), THREAD, 'usage:turn:1'), notification(rawUsage(200), THREAD, 'usage:turn:2')]);
  const reports = session.snapshot().events.filter(e => e.type === 'usage');
  assert.equal(reports.length, 2); assert.equal(session.snapshot().usage?.turnId, 'usage:turn:2'); assert.equal(session.snapshot().usage?.total.totalTokens, 220);
});

test('SDK optional malformed duration leaves lifecycle and usage usable', { timeout: 15000 }, async t => {
  const { session, start, emit } = await fixture(t); await start();
  await emit([notification(rawUsage()), { method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'usage:turn:1', status: 'completed', durationMs: -1 } } }], 'completed');
  assert.equal(session.snapshot().thread?.durationMs, undefined);
  assert.equal(session.snapshot().connected, true);
  assert.equal(session.snapshot().usage?.total.totalTokens, 120);
});
