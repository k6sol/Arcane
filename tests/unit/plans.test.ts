import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCANE_PLANS, CHECKOUT_NOT_CONNECTED, resolveCheckout, serviceBase, validatePlansConfig, type PlansConfig } from '../../packages/protocol/src/plans.js';
import { ActionsLedger, LEDGER_FILE } from '../../apps/daemon/src/actions-ledger.js';
import { createArcaneGateway, createEncryptedTokenVault, gatewayBase, gatewayStatus, GatewayUnavailable, type ArcaneCredentialVault } from '../../apps/daemon/src/arcane-gateway.js';
import { plansRoutes } from '../../apps/daemon/src/plans-routes.js';
import { actionsAllowance, allowanceDetail, allowanceSentence, checkoutUrlAllowed, chipLabel, formatPrice, FREE_PLAN_ACTIONS_PER_MONTH, readDesktopAccount, readDesktopAccountReply, readPlansState, usedOfLimit } from '../../apps/desktop/src/plans.js';

const temp = () => mkdtemp(join(tmpdir(), 'arcane-plans-test-'));
const configured = (patch: Partial<PlansConfig> = {}): PlansConfig => ({ ...structuredClone(ARCANE_PLANS),
  billing: { serviceUrl: 'https://billing.arcane.test', allowedOrigins: ['https://billing.arcane.test'] },
  gateway: { url: 'https://gateway.arcane.test/api', allowedOrigins: ['https://gateway.arcane.test'] }, ...patch });
const memoryVault = (token: string | null): ArcaneCredentialVault => { let value = token; return { read: async () => value, write: async next => { value = next; }, clear: async () => { value = null; } }; };

test('the shipped plans config is valid, marked placeholder, and has no billing or gateway service', () => {
  assert.equal(validatePlansConfig(ARCANE_PLANS), ARCANE_PLANS);
  assert.equal(ARCANE_PLANS.placeholderPrices, true);
  assert.equal(ARCANE_PLANS.billing.serviceUrl, ''); assert.equal(ARCANE_PLANS.gateway.url, '');
  assert.deepEqual(ARCANE_PLANS.plans.map(plan => plan.id), ['starter', 'pro', 'studio']);
  assert.ok(ARCANE_PLANS.packs.length >= 1 && ARCANE_PLANS.credits.offers.length >= 1);
  const source = readFileSync(resolve('packages/protocol/src/plans.ts'), 'utf8');
  assert.match(source, /PLACEHOLDER/); assert.doesNotMatch(source, /sk-[A-Za-z0-9]{8}|api\.openai\.com|api\.anthropic\.com/);
});

test('checkout seam: not connected by default, https allowlisted origin only, never built from request text', () => {
  assert.deepEqual(resolveCheckout(ARCANE_PLANS, 'plan', 'pro', true), { state: 'not-connected', message: CHECKOUT_NOT_CONNECTED });
  assert.equal(resolveCheckout(configured(), 'plan', 'pro', false).state, 'not-connected', 'Unverified services never open checkout.');
  const ready = resolveCheckout(configured(), 'pack', 'pack-100', true);
  assert.equal(ready.state, 'ready'); assert.equal(ready.state === 'ready' && ready.url, 'https://billing.arcane.test/checkout?kind=pack&offer=pack-100');
  assert.equal(resolveCheckout(configured(), 'plan', '../evil', true).state, 'unknown-offer');
  assert.equal(resolveCheckout(configured(), 'credits', 'pro', true).state, 'unknown-offer');
  for (const serviceUrl of ['http://billing.arcane.test', 'https://user:pw@billing.arcane.test', 'https://other.test', 'https://127.0.0.1', 'https://billing.arcane.test:8443'])
    assert.equal(serviceBase({ serviceUrl, allowedOrigins: ['https://billing.arcane.test'] }), null, serviceUrl);
  assert.throws(() => validatePlansConfig(configured({ billing: { serviceUrl: 'https://billing.arcane.test', allowedOrigins: [] } })), /allowlisted/);
  assert.throws(() => validatePlansConfig({ ...structuredClone(ARCANE_PLANS), packs: [{ id: 'pack-100', name: 'x', priceCents: -1, actions: 1, blurb: 'x' }] }), /pack/);
});

test('actions ledger: one entry per id, per-month/day/conversation totals, hash chain and tamper detection', async () => {
  const directory = await temp(), ledger = new ActionsLedger(directory), now = new Date('2026-10-17T12:00:00Z');
  assert.equal(ledger.summary(now).integrity, 'empty'); assert.equal(existsSync(join(directory, LEDGER_FILE)), false, 'Reading never creates files.');
  assert.equal(ledger.record({ kind: 'build-turn', source: 'codex', id: 'turn-1', conversation: 'thread-a', at: new Date('2026-10-17T09:00:00Z') }), true);
  assert.equal(ledger.record({ kind: 'build-turn', source: 'codex', id: 'turn-1', conversation: 'thread-a' }), false, 'Replays are not counted twice.');
  assert.equal(ledger.record({ kind: 'build-turn', source: 'claude', id: 'turn-1', conversation: 'chat-b', at: new Date('2026-10-16T09:00:00Z') }), true, 'Sources are separate namespaces.');
  assert.equal(ledger.record({ kind: 'studio-change', source: 'studio', id: 'cmd-1', at: new Date('2026-09-30T09:00:00Z') }), true);
  assert.equal(ledger.record({ kind: 'build-turn', source: 'codex', id: 'bad id with spaces' }), false);
  const summary = ledger.summary(now);
  assert.deepEqual(summary.month, { key: '2026-10', used: 2 }); assert.deepEqual(summary.today, { key: '2026-10-17', used: 1 });
  assert.deepEqual(summary.byKind, { 'build-turn': 2, 'studio-change': 0 }); assert.equal(summary.enforced, false);
  assert.deepEqual(summary.conversations, [{ conversation: 'chat-b', used: 1 }, { conversation: 'thread-a', used: 1 }]);
  assert.equal(summary.days.length, 14); assert.equal(summary.integrity, 'verified');
  const text = await readFile(join(directory, LEDGER_FILE), 'utf8');
  assert.doesNotMatch(text, /turn-1|cmd-1/, 'External ids are stored only as hashes.');
  const reopened = new ActionsLedger(directory);
  assert.equal(reopened.summary(now).integrity, 'verified'); assert.equal(reopened.record({ kind: 'build-turn', source: 'codex', id: 'turn-1' }), false, 'Dedup survives restarts.');
  await writeFile(join(directory, LEDGER_FILE), text.replace('"studio-change"', '"build-turn"'));
  assert.equal(new ActionsLedger(directory).summary(now).integrity, 'mismatch');
});

test('actions ledger stays bounded and keeps month totals through compaction', async () => {
  const directory = await temp(), ledger = new ActionsLedger(directory, { maxEntries: 10 }), now = new Date('2026-10-17T12:00:00Z');
  for (let index = 0; index < 37; index++) assert.equal(ledger.record({ kind: 'build-turn', source: 'codex', id: 'turn-' + index, at: new Date(now.getTime() - index * 60000) }), true);
  const lines = (await readFile(join(directory, LEDGER_FILE), 'utf8')).trim().split('\n');
  assert.ok(lines.length <= 11, 'File is bounded: ' + lines.length);
  assert.equal(JSON.parse(lines[0]!).type, 'checkpoint');
  assert.equal(ledger.summary(now).month.used, 37);
  const reopened = new ActionsLedger(directory, { maxEntries: 10 });
  assert.equal(reopened.summary(now).month.used, 37); assert.equal(reopened.summary(now).integrity, 'verified');
  assert.equal(reopened.record({ kind: 'build-turn', source: 'codex', id: 'turn-3' }), false, 'Folded ids still dedup.');
});

test('Arcane gateway provider is disabled and makes no calls until configured and signed in', async () => {
  let calls = 0;
  const fake = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  assert.deepEqual(gatewayStatus(ARCANE_PLANS, true), { provider: 'arcane', state: 'disabled', showInModelPicker: false, message: 'Arcane Credits are not connected yet.' });
  const off = createArcaneGateway({ config: ARCANE_PLANS, vault: memoryVault('a'.repeat(32)), fetch: fake });
  await assert.rejects(off.balance(), GatewayUnavailable); await assert.rejects(off.models(), GatewayUnavailable);
  const signedOut = createArcaneGateway({ config: configured(), vault: memoryVault(null), fetch: fake });
  assert.equal((await signedOut.status()).state, 'signed-out'); await assert.rejects(signedOut.usage(), /Sign in/);
  assert.equal(calls, 0, 'No network call while disabled or signed out.');
});

test('Arcane gateway reads balance, usage and a streamed chat from the documented API with the vault token', async () => {
  const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
  const fake = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input); seen.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url.endsWith('/v1/balance')) return Response.json({ credits: 1200, actionsRemaining: 40, plan: 'Pro', renewsAt: '2026-11-01T00:00:00Z' });
    if (url.endsWith('/v1/usage')) return Response.json({ period: '2026-10', creditsUsed: 300, actionsUsed: 12 });
    if (url.endsWith('/v1/chat/stream')) return new Response('data: {"type":"delta","text":"Hel"}\n\ndata: {"type":"delta","text":"lo"}\n\ndata: {"type":"done","creditsUsed":3}\n\n');
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const token = 'tok_' + 'b'.repeat(28), gateway = createArcaneGateway({ config: configured(), vault: memoryVault(token), fetch: fake });
  assert.equal((await gateway.status()).showInModelPicker, true);
  assert.deepEqual(await gateway.balance(), { credits: 1200, actionsRemaining: 40, plan: 'Pro', renewsAt: '2026-11-01T00:00:00Z' });
  assert.deepEqual(await gateway.usage(), { period: '2026-10', creditsUsed: 300, actionsUsed: 12 });
  const chunks = []; for await (const chunk of gateway.streamChat({ model: 'arcane-default', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'done', creditsUsed: 3 }]);
  assert.ok(seen.every(call => call.url.startsWith('https://gateway.arcane.test/api/') && call.auth === 'Bearer ' + token && call.redirect === 'error'));
  await assert.rejects(gateway.models(), GatewayUnavailable);
});

test('Arcane gateway: a local URL enables it only on an allowlisted origin; turnId and rate limits pass through', async () => {
  const allowlisted = configured({ gateway: { url: '', allowedOrigins: ['https://gateway.arcane.test'] } });
  assert.equal(gatewayBase(ARCANE_PLANS, 'https://gateway.arcane.test'), null, 'Shipped config allowlists nothing.');
  assert.equal(gatewayBase(allowlisted, 'https://evil.test'), null);
  assert.equal(gatewayBase(allowlisted, 'https://gateway.arcane.test/'), 'https://gateway.arcane.test');
  assert.equal(gatewayStatus(allowlisted, true).state, 'disabled');
  assert.equal(gatewayStatus(allowlisted, true, 'https://gateway.arcane.test').state, 'ready');
  let body: Record<string, unknown> = {}, status = 200;
  const fake = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return status === 200 ? new Response('data: {"type":"done","creditsUsed":1}\n\n') : new Response('{}', { status });
  }) as typeof fetch;
  const gateway = createArcaneGateway({ config: allowlisted, vault: memoryVault('arc_' + 'd'.repeat(43)), fetch: fake, localUrl: 'https://gateway.arcane.test' });
  for await (const chunk of gateway.streamChat({ model: 'arcane-default', messages: [{ role: 'user', content: 'hi' }], turnId: 'turn-7' })) void chunk;
  assert.equal(body.turnId, 'turn-7');
  await assert.rejects(async () => { for await (const chunk of gateway.streamChat({ model: 'm', messages: [{ role: 'user', content: 'x' }], turnId: 'bad id' })) void chunk; }, /cannot be sent/);
  status = 429;
  await assert.rejects(async () => { for await (const chunk of gateway.streamChat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) void chunk; }, /Too many/);
  status = 402;
  await assert.rejects(gateway.balance(), /out of Arcane Credits/);
});

test('desktop account replies are read strictly', () => {
  assert.equal(readDesktopAccount({ version: 1, state: 'ready', message: 'x', account: 'signed-in' }), 'signed-in');
  for (const value of [null, {}, { version: 2, account: 'signed-in' }, { version: 1, account: 'admin' }]) assert.equal(readDesktopAccount(value), 'unavailable');
  assert.equal(readDesktopAccountReply({ version: 1, state: 'opened', message: 'x' }), 'opened');
  assert.equal(readDesktopAccountReply({ version: 1, state: 'token', message: 'x' }), 'unavailable');
});

test('encrypted token vault never writes the token in plain text and refuses without OS encryption', async () => {
  const directory = await temp(), file = join(directory, 'vault', 'arcane-account.bin'), token = 'tok_' + 'c'.repeat(28);
  const encrypt = (plain: string) => Buffer.from(Buffer.from(plain).map(byte => byte ^ 0x5a)), decrypt = (cipher: Buffer) => Buffer.from(cipher.map(byte => byte ^ 0x5a)).toString();
  const vault = createEncryptedTokenVault({ file, encrypt, decrypt, available: () => true });
  await vault.write(token); assert.equal(await vault.read(), token); assert.doesNotMatch(await readFile(file, 'latin1'), /tok_/);
  await vault.clear(); assert.equal(await vault.read(), null);
  await assert.rejects(createEncryptedTokenVault({ file, encrypt, decrypt, available: () => false }).write(token), /unavailable/);
});

async function routeServer(t: test.TestContext, extra: Partial<Parameters<typeof plansRoutes>[0]> = {}) {
  const directory = await temp(), ledger = new ActionsLedger(join(directory, 'arcane-actions')), token = 'a'.repeat(64);
  const routes = plansRoutes({ ledger, ...extra });
  let origin = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (!await routes.handle(request, response, url, token, origin)) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const call = (path: string, init: { method?: string; bearer?: string; origin?: string | null; body?: unknown } = {}) => fetch(origin + path, {
    method: init.method ?? 'GET', headers: { Authorization: 'Bearer ' + (init.bearer ?? token), ...(init.origin === null ? {} : { Origin: init.origin ?? origin }), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { call, ledger, token, origin, directory };
}

test('plans routes: human bearer only, checkout is not connected, and Claude turns record once', async t => {
  const { call } = await routeServer(t);
  assert.equal((await call('/v1/plans/state', { bearer: 'b'.repeat(64) })).status, 401, 'Agent or unknown tokens cannot read usage.');
  assert.equal((await call('/v1/plans/state', { origin: 'http://evil.test' })).status, 403);
  const stateResponse = await call('/v1/plans/state', { origin: null }); assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as Record<string, any>;
  assert.equal(state.billing.state, 'not-configured'); assert.deepEqual(state.billing.origins, []); assert.equal(state.gateway.state, 'disabled');
  assert.equal(JSON.stringify(state).includes('serviceUrl'), false, 'Service URLs are reduced to a state.');
  assert.ok(readPlansState(state), 'The renderer accepts the daemon reply.');
  assert.equal((await call('/v1/plans/checkout', { method: 'POST', origin: null, body: { kind: 'plan', id: 'pro' } })).status, 403, 'Writes require the panel origin.');
  const checkout = await (await call('/v1/plans/checkout', { method: 'POST', body: { kind: 'plan', id: 'pro' } })).json() as Record<string, unknown>;
  assert.deepEqual(checkout, { state: 'not-connected', message: CHECKOUT_NOT_CONNECTED });
  assert.equal((await call('/v1/plans/checkout', { method: 'POST', body: { kind: 'plan', id: 'pro', url: 'https://evil.test' } })).status, 400);
  const first = await (await call('/v1/actions/record', { method: 'POST', body: { source: 'claude', turnId: 'turn-9', conversationId: 'conv-1' } })).json() as Record<string, any>;
  assert.equal(first.recorded, true); assert.equal(first.usage.month.used, 1);
  const again = await (await call('/v1/actions/record', { method: 'POST', body: { source: 'claude', turnId: 'turn-9', conversationId: 'conv-1' } })).json() as Record<string, any>;
  assert.equal(again.recorded, false);
  assert.equal((await call('/v1/actions/record', { method: 'POST', body: { source: 'codex', turnId: 'turn-10', conversationId: null } })).status, 400, 'Only Claude turns are reported by the desktop.');
});

test('plans routes observe finished Codex turns and applied Studio changes daemon-side', async t => {
  let thread: Record<string, unknown> = { threadId: 'thread-1', turnId: 'turn-1', turnStatus: 'inProgress' };
  const events = [
    { kind: 'command_succeeded', entityId: 'cmd-1', occurredAt: new Date().toISOString(), detail: { method: 'scene.update', sessionId: 'session-1' } },
    { kind: 'command_succeeded', entityId: 'cmd-2', occurredAt: new Date().toISOString(), detail: { method: 'scene.restore', sessionId: 'session-1' } },
    { kind: 'command_succeeded', entityId: 'cmd-3', occurredAt: new Date().toISOString(), detail: { method: 'scene.read', sessionId: 'session-1' } },
    { kind: 'command_failed', entityId: 'cmd-4', occurredAt: new Date().toISOString(), detail: { method: 'script.update', sessionId: 'session-1' } },
  ];
  const { call } = await routeServer(t, { codexState: () => ({ snapshot: { thread } }), studioEvents: () => events });
  let state = await (await call('/v1/plans/state')).json() as Record<string, any>;
  assert.deepEqual(state.usage.byKind, { 'build-turn': 0, 'studio-change': 1 }, 'Only applied, non-undo Studio writes count.');
  thread = { ...thread, turnStatus: 'completed' };
  state = await (await call('/v1/plans/state')).json() as Record<string, any>;
  state = await (await call('/v1/plans/state')).json() as Record<string, any>;
  assert.deepEqual(state.usage.byKind, { 'build-turn': 1, 'studio-change': 1 });
  assert.deepEqual(state.usage.conversations.map((row: { conversation: string }) => row.conversation).sort(), ['session-1', 'thread-1']);
});

test('plans routes verify a configured billing service before checkout can open', async t => {
  let healthy = false;
  const fake = (async (input: URL | RequestInfo) => String(input) === 'https://billing.arcane.test/v1/health' && healthy ? Response.json({ service: 'arcane-billing', version: 1 }) : new Response('down', { status: 503 })) as typeof fetch;
  const unhealthy = await routeServer(t, { config: configured(), fetch: fake });
  const down = await (await unhealthy.call('/v1/plans/checkout', { method: 'POST', body: { kind: 'credits', id: 'credits-10' } })).json() as Record<string, unknown>;
  assert.equal(down.state, 'not-connected');
  healthy = true;
  const up = await routeServer(t, { config: configured(), fetch: fake });
  const state = await (await up.call('/v1/plans/state')).json() as Record<string, any>;
  assert.equal(state.billing.state, 'ready'); assert.deepEqual(state.billing.origins, ['https://billing.arcane.test']);
  const ready = await (await up.call('/v1/plans/checkout', { method: 'POST', body: { kind: 'credits', id: 'credits-10' } })).json() as Record<string, unknown>;
  assert.equal(ready.state, 'ready'); assert.equal(checkoutUrlAllowed(ready.url, state.billing.origins), true);
});

test('renderer helpers format placeholder prices and refuse unsafe checkout URLs', () => {
  assert.equal(formatPrice(900, 'USD'), '$9'); assert.equal(formatPrice(1250, 'USD'), '$12.50');
  assert.equal(checkoutUrlAllowed('https://billing.arcane.test/checkout?offer=pro', ['https://billing.arcane.test']), true);
  for (const url of ['http://billing.arcane.test/checkout', 'https://evil.test/checkout', 'javascript:alert(1)', 'https://u:p@billing.arcane.test/', 42])
    assert.equal(checkoutUrlAllowed(url, ['https://billing.arcane.test']), false, String(url));
  assert.equal(readPlansState({ catalog: {} }), null);
});

test('actions read as used / plan limit: the free plan 500 unless the feed names a limit, with near and over states and the reset day', () => {
  const reply = (month: Record<string, unknown>) => readPlansState({
    catalog: { placeholderPrices: true, currency: 'USD', action: { singular: 'action', plural: 'actions', definition: 'One build turn.' }, plans: [], packs: [], credits: { blurb: 'Credits.', offers: [] } },
    billing: { state: 'not-configured', origins: [] }, gateway: { state: 'disabled', message: 'Off.', showInModelPicker: false },
    usage: { month, today: { key: '2026-10-21', used: 0 }, days: [], conversations: [], byKind: { 'build-turn': 0, 'studio-change': 0 }, integrity: 'empty' } })!;
  assert.equal(FREE_PLAN_ACTIONS_PER_MONTH, 500);
  const normal = actionsAllowance(reply({ key: '2026-10', used: 312 }));
  assert.deepEqual([normal.limit, normal.left, normal.over, normal.level, normal.source, normal.resetsAt], [500, 188, 0, 'ok', 'free-plan', '2026-11-01T00:00:00.000Z']);
  assert.equal(usedOfLimit(normal), '312 / 500'); assert.equal(allowanceDetail(normal), '188 left · resets 1 Nov');
  const over = actionsAllowance(reply({ key: '2026-10', used: 750 }));
  assert.deepEqual([usedOfLimit(over), over.level, allowanceDetail(over)], ['750 / 500', 'over', '250 over · resets 1 Nov']);
  assert.equal(actionsAllowance(reply({ key: '2026-10', used: 468 })).level, 'near');
  assert.equal(actionsAllowance(reply({ key: '2026-12', used: 0 })).resetsAt, '2027-01-01T00:00:00.000Z', 'December resets on 1 January');
  const fed = actionsAllowance(reply({ key: '2026-10', used: 900, limit: 1200, resetsAt: '2026-11-15T00:00:00.000Z' }));
  assert.deepEqual([usedOfLimit(fed), fed.source, allowanceDetail(fed)], ['900 / 1,200', 'feed', '300 left · resets 15 Nov']);
  for (const limit of [0, -5, 1.5, '500']) assert.equal(actionsAllowance(reply({ key: '2026-10', used: 1, limit })).limit, 500, 'A malformed feed limit is ignored, never guessed: ' + String(limit));
  const chip = chipLabel(reply({ key: '2026-10', used: 750 }));
  assert.deepEqual([chip.value, chip.unit, chip.level], ['750', '/ 500', 'over']);
  assert.match(chip.aria, /^750 of 500 Arcane actions used this month, 250 over the limit, resets 1 Nov\. Open Plans and credits\.$/);
  assert.match(allowanceSentence(normal), /^312 of 500 Arcane actions used this month, 188 left, resets 1 Nov$/);
});

test('real Edge: Plans & credits page and balance chip render, and buying says checkout is not connected', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const js = await readFile(join(build, 'apps/desktop/src/plans.js'), 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const directory = await temp(), ledger = new ActionsLedger(directory), token = 'd'.repeat(64), now = Date.now();
  for (let index = 0; index < 64; index++) ledger.record({ kind: index % 4 ? 'build-turn' : 'studio-change', source: index % 4 ? 'codex' : 'studio', id: 'seed-' + index, conversation: 'thread-' + (index % 3), at: new Date(now - (index % 9) * 86400000 * (index % 2)) });
  const routes = plansRoutes({ ledger });
  let origin = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (await routes.handle(request, response, url, token, origin)) return;
    const value = url.pathname === '/fixture' ? html : url.pathname === '/plans.js' ? js : url.pathname === '/studio.css' ? css : '';
    response.writeHead(value ? 200 : 404, { 'Content-Type': url.pathname === '/fixture' ? 'text/html' : url.pathname === '/studio.css' ? 'text/css' : 'text/javascript' }); response.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/fixture');
  await page.evaluate(async (token: string) => { const path: string = '/plans.js'; const m = await import(path); (window as any).plans = m.startPlans(document, { token: () => token, desktop: null }); }, token);
  await page.waitForFunction(() => !(document.getElementById('arcane-balance-chip') as HTMLElement).hidden);
  assert.equal(await page.locator('#arcane-balance-chip-value').textContent(), String(ledger.summary().month.used));
  assert.match(await page.locator('#arcane-balance-chip').getAttribute('aria-label') ?? '', /used this month/);
  await page.evaluate(() => {
    document.getElementById('provider-login-gate')?.setAttribute('hidden', ''); document.getElementById('workspace-stage')?.classList.remove('provider-required');
    const drawer = document.getElementById('settings-drawer') as HTMLDialogElement; drawer.showModal();
    for (const pane of document.querySelectorAll<HTMLElement>('[data-settings-section]')) pane.hidden = pane.id !== 'settings-plans';
    for (const nav of document.querySelectorAll<HTMLElement>('[data-settings-section-target]')) nav.toggleAttribute('aria-current', nav.getAttribute('data-settings-section-target') === 'settings-plans');
    document.querySelector('[data-settings-section-target=settings-plans]')?.setAttribute('aria-current', 'page');
  });
  await page.waitForFunction(() => document.querySelectorAll('#plans-list .plans-offer').length === 3);
  assert.equal(await page.locator('#plans-packs .plans-offer').count(), 3); assert.equal(await page.locator('#plans-credits .plans-offer').count(), 3);
  assert.equal(await page.locator('#plans-placeholder').isVisible(), true);
  assert.equal(await page.locator('#plans-usage-days li').count(), 14);
  const style = await page.locator('.plans-buy-primary').evaluate((el: HTMLElement) => { const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor }; });
  assert.equal(style.color, 'rgb(255, 255, 255)'); assert.equal(style.background, 'rgb(212, 21, 43)', 'White on Arcane action red (5.3:1).');
  if (shots) await page.locator('#settings-drawer').screenshot({ path: join(shots, 'plans-usage-dark.png') });
  await page.locator('#plans-list .plans-buy-primary').click();
  await page.waitForFunction(() => !(document.getElementById('plans-notice') as HTMLElement).hidden);
  assert.match(await page.locator('#plans-notice').textContent() ?? '', /Checkout isn.t connected yet.*Nothing was charged/);
  if (shots) {
    await page.locator('#settings-drawer').screenshot({ path: join(shots, 'plans-checkout-not-connected-dark.png') });
    await page.locator('#plans-credits').scrollIntoViewIfNeeded(); await page.locator('#settings-drawer').screenshot({ path: join(shots, 'plans-credits-dark.png') });
    await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).close());
    await page.locator('#workspace-topbar').screenshot({ path: join(shots, 'plans-balance-chip-dark.png') });
  }
  assert.deepEqual(errors, []);
});

test('markup and styles: Settings section, top-bar chip, studio boot hook and a motion-free owned CSS block before the reset', async () => {
  const html = await readFile('apps/desktop/public/studio.html', 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  assert.doesNotMatch(html, /src="\/plans\.js"/, 'Loaded by studio.js, so fixtures that replace studio.js stay quiet.');
  assert.ok((await readFile('apps/desktop/src/studio.ts', 'utf8')).includes("void import('./plans.js').then(module=>{const plans=module.startPlans(document,{token:()=>token,"));
  const topbar = html.slice(html.indexOf('<header id="workspace-topbar"'), html.indexOf('</header>'));
  assert.match(topbar, /<button id="arcane-balance-chip" type="button"[^>]*aria-label="[^"]+"[^>]*hidden>/);
  assert.match(html, /data-settings-section-target="settings-plans" aria-controls="settings-plans" >Plans &amp; credits<\/button>/);
  assert.match(html, /<section id="settings-plans" class="settings-page plans-page" data-settings-section[^>]*hidden>/);
  for (const id of ['plans-usage-month', 'plans-list', 'plans-packs', 'plans-credits', 'plans-notice', 'plans-gateway-state']) assert.match(html, new RegExp('id="' + id + '"'));
  const start = css.indexOf('/* ---- Plans & credits'), end = css.indexOf('/* ---- End Plans & credits ---- */'), reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');
  assert.ok(start > 0 && end > start && reset > end, 'Owned block sits before the final reduced-motion reset.');
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(block, /transition|animation/); assert.match(block, /forced-colors:active/); assert.match(block, /var\(--text\)/); assert.match(block, /var\(--accent\)/);
  for (const size of block.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)) assert.ok(Number(size[1]) >= 12, 'Readable text: ' + size[0]);
});
