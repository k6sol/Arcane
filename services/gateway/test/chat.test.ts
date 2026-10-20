import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditsFor, estimateInputTokens } from '../src/metering.ts';
import type { UpstreamStreamer } from '../src/providers.ts';
import { bearer, MODELS, postJson, signIn, startHarness, type Harness } from './helpers.ts';

const model = MODELS[0];
const setCredits = (h: Harness, credits: number, extra = '') => h.db.prepare('UPDATE accounts SET credits = ?' + extra).run(credits);
async function events(response: Response) {
  const text = await response.text();
  return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')));
}
const ask = (h: Harness, token: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  postJson(h.base + '/v1/chat/stream', { model: 'arcane-default', messages: [{ role: 'user', content: 'Build a lobby' }], ...body }, { ...bearer(token), ...headers });

test('metering math: integer credits, rounded up, with markup', () => {
  assert.equal(creditsFor({ inputPerMTok: 300, outputPerMTok: 1500 }, 1000, 200, 10000), 1); // 0.6 -> 1
  assert.equal(creditsFor({ inputPerMTok: 300, outputPerMTok: 1500 }, 1_000_000, 1_000_000, 10000), 1800);
  assert.equal(creditsFor({ inputPerMTok: 300, outputPerMTok: 1500 }, 1_000_000, 1_000_000, 12000), 2160);
  assert.equal(creditsFor({ inputPerMTok: 300, outputPerMTok: 1500 }, 0, 0, 12000), 0);
  assert.equal(creditsFor({ inputPerMTok: 1, outputPerMTok: 1 }, 1, 0, 10000), 1, 'any usage costs at least one credit');
  assert.equal(creditsFor({ inputPerMTok: 10_000_000, outputPerMTok: 10_000_000 }, 9_000_000_000, 9_000_000_000, 100000), 1_800_000_000_000, 'no float overflow');
  assert.throws(() => creditsFor({ inputPerMTok: 1, outputPerMTok: 1 }, -1, 0, 10000), RangeError);
  assert.equal(estimateInputTokens([{ content: 'abcd' }]), 16 + 2 + 8);
});

test('chat streams deltas, charges actual usage with markup and records usage', async () => {
  const h = await startHarness();
  try {
    const token = await signIn(h);
    setCredits(h, 500);
    const response = await ask(h, token);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = await events(response);
    assert.deepEqual(stream.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Hello from Arcane');
    const expected = creditsFor(model, 1000, 200, 12000);
    assert.deepEqual(stream.at(-1), { type: 'done', creditsUsed: expected, actionsUsed: 0 });
    const balance = await (await fetch(h.base + '/v1/balance', { headers: bearer(token) })).json() as any;
    assert.equal(balance.credits, 500 - expected);
    assert.deepEqual(await (await fetch(h.base + '/v1/usage', { headers: bearer(token) })).json(), { period: '2026-10', creditsUsed: expected, actionsUsed: 0 });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM holds').get() as any).n, 0, 'hold settled');
    const row = h.db.prepare("SELECT detail FROM audit WHERE event = 'chat.charged'").get() as any;
    assert.equal(JSON.parse(row.detail).credits, expected);
  } finally { await h.close(); }
});

test('insufficient balance is refused with 402 before any upstream call', async () => {
  let called = 0;
  const upstream: UpstreamStreamer = async function* () { called++; yield { type: 'delta', text: 'x' }; };
  const h = await startHarness({ upstream });
  try {
    const token = await signIn(h);
    setCredits(h, 1);
    const response = await ask(h, token);
    assert.equal(response.status, 402);
    const body = await response.json() as any;
    assert.equal(body.error, 'insufficient_balance'); assert.ok(body.required > 1);
    assert.equal(called, 0);
    assert.equal((await (await fetch(h.base + '/v1/balance', { headers: bearer(token) })).json() as any).credits, 1);
  } finally { await h.close(); }
});

test('a plan action covers one turn up to the allowance; extra usage comes from credits', async () => {
  const h = await startHarness();
  try {
    const token = await signIn(h);
    setCredits(h, 0, ', plan_id = \'pro\', plan_actions = 2');
    // Worst-case hold for 1000 output tokens: needs <= 50 allowance credits.
    const first = await events(await ask(h, token, { turnId: 'turn-1', maxTokens: 1000 }));
    assert.deepEqual(first.at(-1), { type: 'done', creditsUsed: 0, actionsUsed: 1 });
    const second = await events(await ask(h, token, { turnId: 'turn-1', maxTokens: 1000 }));
    assert.deepEqual(second.at(-1), { type: 'done', creditsUsed: 0, actionsUsed: 0 }, 'same turn, no new action');
    const balance = await (await fetch(h.base + '/v1/balance', { headers: bearer(token) })).json() as any;
    assert.equal(balance.actionsRemaining, 1);
    const left = (h.db.prepare("SELECT allowance_left FROM turns WHERE turn_id = 'turn-1'").get() as any).allowance_left;
    assert.equal(left, 50 - 2 * creditsFor(model, 1000, 200, 12000));
    assert.deepEqual(await (await fetch(h.base + '/v1/usage', { headers: bearer(token) })).json(), { period: '2026-10', creditsUsed: 0, actionsUsed: 1 });
  } finally { await h.close(); }
});

test('per-account concurrency cap, rate limit and idempotency keys', async () => {
  let releaseStream!: () => void;
  const gate = new Promise<void>(resolve => { releaseStream = resolve; });
  const upstream: UpstreamStreamer = async function* () { yield { type: 'delta', text: 'a' }; await gate; yield { type: 'usage', inputTokens: 10, outputTokens: 10 }; };
  const h = await startHarness({ upstream, env: { MAX_CONCURRENT_STREAMS: '1', RATE_LIMIT_PER_MINUTE: '4' } });
  try {
    const token = await signIn(h);
    setCredits(h, 10_000);
    const open = await ask(h, token);
    assert.equal(open.status, 200);
    const second = await ask(h, token);
    assert.equal(second.status, 429); assert.equal((await second.json() as any).error, 'too_many_streams');
    releaseStream(); await open.text();

    const keyed = await ask(h, token, {}, { 'Idempotency-Key': 'chat-request-0001' });
    assert.equal(keyed.status, 200); await keyed.text();
    const replay = await ask(h, token, {}, { 'Idempotency-Key': 'chat-request-0001' });
    assert.equal(replay.status, 409);
    const limited = await ask(h, token);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await limited.json() as any).error, 'rate_limited');
  } finally { await h.close(); }
});

test('upstream failure refunds the hold; bounded bodies; unknown models; CORS stays closed', async () => {
  const upstream: UpstreamStreamer = async function* () { throw new Error('boom'); };
  const h = await startHarness({ upstream, env: { MAX_CHAT_BODY_BYTES: '2048' } });
  try {
    const token = await signIn(h);
    setCredits(h, 300);
    const stream = await events(await ask(h, token));
    assert.equal(stream.at(-1).type, 'error');
    assert.equal((await (await fetch(h.base + '/v1/balance', { headers: bearer(token) })).json() as any).credits, 300);
    assert.equal((await ask(h, token, { messages: [{ role: 'user', content: 'x'.repeat(5000) }] })).status, 413);
    assert.equal((await ask(h, token, { model: 'unknown' })).status, 400);
    assert.equal((await ask(h, token, { messages: [{ role: 'tool', content: 'x' }] })).status, 400);
    const preflight = await fetch(h.base + '/v1/chat/stream', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const models = await (await fetch(h.base + '/v1/models', { headers: bearer(token) })).json();
    // Credits per million tokens with the 20 % markup applied, rounded up.
    assert.deepEqual(models, { models: [{ id: 'arcane-default', label: 'Arcane default', pricing: { inputPerMTok: 360, outputPerMTok: 1800 }, tools: true },
      { id: 'arcane-fast', label: 'Arcane fast', pricing: { inputPerMTok: 120, outputPerMTok: 480 }, tools: true }] });
    const health = await (await fetch(h.base + '/v1/health')).json() as any;
    assert.equal(health.service, 'arcane-billing'); assert.equal(health.version, 1);
  } finally { await h.close(); }
});

test('function calling: offered tools pass through, tool calls stream back and the loop turns are validated', async () => {
  const seen: { messages: unknown[]; tools: unknown }[] = [];
  const upstream: UpstreamStreamer = async function* (_c, _m, messages, _max, _signal, tools) {
    seen.push({ messages, tools });
    yield { type: 'usage', inputTokens: 100 };
    if (messages.at(-1)?.role === 'tool') { yield { type: 'delta', text: 'Placed it.' }; yield { type: 'usage', outputTokens: 5 }; yield { type: 'stop', reason: 'end' }; return; }
    yield { type: 'delta', text: 'Checking.' };
    yield { type: 'tool_call', id: 'call_1', name: 'scene_read', arguments: { path: 'Workspace' } };
    yield { type: 'usage', outputTokens: 20 }; yield { type: 'stop', reason: 'tool_use' };
  };
  const h = await startHarness({ upstream });
  try {
    const token = await signIn(h);
    setCredits(h, 10_000);
    const tools = [{ name: 'scene_read', description: 'Read the scene.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const first = await events(await ask(h, token, { tools }));
    assert.deepEqual(first.find(e => e.type === 'tool_call'), { type: 'tool_call', id: 'call_1', name: 'scene_read', arguments: { path: 'Workspace' } });
    assert.deepEqual(first.at(-1), { type: 'done', creditsUsed: creditsFor(model, 100, 20, 12000), actionsUsed: 0, stopReason: 'tool_use', inputTokens: 100, outputTokens: 20 });
    assert.deepEqual(seen[0].tools, tools);
    const turn = [{ role: 'user', content: 'Build a lobby' }, { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'call_1', name: 'scene_read', arguments: { path: 'Workspace' } }] },
      { role: 'tool', toolCallId: 'call_1', content: '{"children":[]}' }];
    const second = await events(await ask(h, token, { tools, messages: turn }));
    assert.equal(second.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Placed it.');
    assert.equal(second.at(-1).stopReason, 'end');
    assert.deepEqual(seen[1].messages, [turn[0], turn[1], { role: 'tool', content: '{"children":[]}', toolCallId: 'call_1' }]);
    // Tool turns need offered tools; malformed tools and calls are refused before any upstream call.
    const calls = seen.length;
    assert.equal((await ask(h, token, { messages: turn })).status, 400);
    assert.equal((await ask(h, token, { tools: [{ name: 'bad name', description: 'x', inputSchema: {} }] })).status, 400);
    assert.equal((await ask(h, token, { tools: [...tools, ...tools] })).status, 400, 'duplicate names');
    assert.equal((await ask(h, token, { tools: [{ name: 'big', description: 'x', inputSchema: { blob: 'x'.repeat(40000) } }] })).status, 400);
    assert.equal((await ask(h, token, { tools, messages: [{ role: 'tool', toolCallId: '../x', content: 'x' }] })).status, 400);
    assert.equal((await ask(h, token, { tools, messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'scene_read', arguments: [] }] }] })).status, 400);
    assert.equal(seen.length, calls);
  } finally { await h.close(); }
});

test('a tool the client did not offer ends the stream with an error', async () => {
  const upstream: UpstreamStreamer = async function* () { yield { type: 'tool_call', id: 'call_x', name: 'shell', arguments: {} }; };
  const h = await startHarness({ upstream });
  try {
    const token = await signIn(h);
    setCredits(h, 10_000);
    const stream = await events(await ask(h, token, { tools: [{ name: 'scene_read', description: 'Read.', inputSchema: { type: 'object' } }] }));
    assert.equal(stream.some(e => e.type === 'tool_call'), false);
    assert.equal(stream.at(-1).type, 'error');
  } finally { await h.close(); }
});
