import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { StudioStore, STUDIO_PAIRING_OFFER_MS, studioPairingProof } from '../../packages/storage/src/studio-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { READ_METHODS, WRITE_METHODS, ROOTS } from '../../packages/protocol/src/studio.js';

const listen = async (server: Server, port = 0) => { await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)); return (server.address() as { port: number }).port; };
const NONCE = '0123456789abcdef0123456789abcdef';

async function fixture(t: test.TestContext, options: { discoveryPort?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-pairing-http-'));
  let clock = Date.now();
  const store = new StudioStore({ directory, now: () => clock });
  const human = 'launcher-human-pairing-fixture', agent = 'launcher-agent-pairing-fixture';
  const route = studioRoutes(store, directory, undefined, directory, agent, null, undefined, { discoveryPort: options.discoveryPort ?? 0 });
  let origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), human, origin).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  t.after(async () => {
    route.closePairing();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    const path = relative(tmpdir(), directory);
    assert.ok(path !== '' && !isAbsolute(path) && !path.startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  const port = await listen(server);
  origin = 'http://127.0.0.1:' + port;
  const post = (path: string, input: unknown, bearer?: string, headers: Record<string, string> = {}) => fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...headers }, body: JSON.stringify(input) });
  const get = (path: string, bearer?: string) => fetch(origin + path, { headers: bearer ? { Authorization: 'Bearer ' + bearer } : {} });
  const discover = (discoveryPort: number, body: unknown = { protocolVersion: 1 }, headers: Record<string, string> = {}, method = 'POST') =>
    fetch('http://127.0.0.1:' + discoveryPort + '/v1/pairing/discover', { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const identity = { clientSessionId: 'pairing-http-window', placeId: 4242, universeId: 77, name: 'Obby Place', pluginVersion: 'test' };
  const claimBody = (ticket: string, code: string, nonce = NONCE) => ({ protocolVersion: 1, ticket, clientNonce: nonce, proof: studioPairingProof(code, 'plugin', ticket, nonce),
    identity, capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const challenge = (ticket: string, nonce = NONCE) => post('/v1/plugin/pairing/challenge', { protocolVersion: 1, ticket, clientNonce: nonce });
  const offer = async () => {
    const response = await post('/v1/studio/pairing-offer', { allowedRoots: [...ROOTS], allowWrites: true }, human, { Origin: origin });
    assert.equal(response.status, 200);
    return await response.json() as { offer: { offerId: string; code: string; state: string; claim: unknown; request: unknown }; discovery: { state: string; port: number | null } };
  };
  const decide = (offerId: string, approve: boolean, bearer = human) => post('/v1/studio/pairing-offer/decide', { offerId, approve }, bearer);
  return { directory, store, route, origin, port, human, agent, post, get, discover, identity, claimBody, challenge, offer, decide, advance: (ms: number) => { clock += ms; } };
}

test('the plugin proof matches an independent HMAC-SHA256 and roles never collide', () => {
  const ticket = 'arcane_pair_v1_45871_' + 'c'.repeat(48);
  assert.equal(studioPairingProof('123456', 'arcane', ticket, NONCE), createHmac('sha256', '123456').update('arcane-pair-v2|arcane|' + ticket + '|' + NONCE).digest('hex'));
  assert.notEqual(studioPairingProof('123456', 'arcane', ticket, NONCE), studioPairingProof('123456', 'plugin', ticket, NONCE));
  assert.notEqual(studioPairingProof('123456', 'arcane', ticket, NONCE), studioPairingProof('123457', 'arcane', ticket, NONCE));
});

test('a human click mints a fresh, ticket-free offer view with a 6-digit code; agents and anonymous callers cannot', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/v1/studio/pairing-offer', { allowedRoots: [...ROOTS], allowWrites: true })).status, 401);
  assert.equal((await f.post('/v1/studio/pairing-offer', { allowedRoots: [...ROOTS], allowWrites: true }, f.agent)).status, 403);
  assert.equal((await f.get('/v1/studio/pairing-offer', f.agent)).status, 403);
  assert.equal((await f.post('/v1/studio/pairing-offer', { allowedRoots: [...ROOTS], allowWrites: true }, f.human, { Origin: 'https://foreign.example' })).status, 403);
  for (const bad of [{}, { allowedRoots: [...ROOTS] }, { allowedRoots: [...ROOTS], allowWrites: true, extra: 1 }, { allowedRoots: ['Nope'], allowWrites: true }])
    assert.equal((await f.post('/v1/studio/pairing-offer', bad, f.human)).status, 400);
  const created = await f.offer();
  assert.match(created.offer.code, /^[0-9]{6}$/);
  assert.equal(created.offer.state, 'pending');
  assert.equal(created.offer.request, null);
  assert.equal(created.discovery.state, 'listening');
  const read = await (await f.get('/v1/studio/pairing-offer', f.human)).json() as { offer: { code: string } };
  assert.equal(read.offer.code, created.offer.code);
  for (const text of [JSON.stringify(created), JSON.stringify(read), JSON.stringify(f.store.events())]) assert.doesNotMatch(text, /arcane_pair_v1_|arcane_local_v1_/, 'Neither the ticket nor a key reaches the renderer or the event log.');
});

test('loopback discovery answers only a bounded credential-free JSON POST and never reveals the code', async t => {
  const f = await fixture(t);
  const created = await f.offer(), dport = created.discovery.port!;
  const response = await f.discover(dport);
  assert.equal(response.status, 200);
  const text = await response.text(), answer = JSON.parse(text) as { protocolVersion: number; port: number; ticket: string; expiresAt: string };
  assert.deepEqual(Object.keys(answer).sort(), ['expiresAt', 'port', 'protocolVersion', 'ticket']);
  assert.ok(!text.includes(created.offer.code), 'A process that reads discovery never learns the code.');
  assert.equal(answer.port, f.port);
  assert.match(answer.ticket, new RegExp('^arcane_pair_v1_' + f.port + '_[a-f0-9]{48}$'));
  assert.equal((await f.discover(dport, { protocolVersion: 1 }, { Origin: 'https://evil.example' })).status, 404);
  assert.equal((await f.discover(dport, undefined, {}, 'GET')).status, 404);
  assert.equal((await f.discover(dport, { protocolVersion: 1 }, { 'Content-Type': 'text/plain' })).status, 404);
  assert.equal((await f.discover(dport, { protocolVersion: 2 })).status, 400);
  assert.equal((await f.discover(dport, { protocolVersion: 1, extra: true })).status, 400);
  assert.deepEqual(await (await f.post('/v1/studio/pairing-offer/cancel', {}, f.human)).json(), { cancelled: true });
  await assert.rejects(f.discover(dport), 'The discovery listener stops when no offer is pending.');
  assert.equal((await f.challenge(answer.ticket)).status, 400);
  assert.equal((await f.post('/v1/studio/pairing-offer/cancel', { extra: 1 }, f.human)).status, 400);
});

test('two-sided pairing: Arcane proves the code, the plugin proves it, and the key is issued only after Approve in Arcane', async t => {
  const f = await fixture(t);
  const created = await f.offer(), dport = created.discovery.port!, code = created.offer.code;
  const { ticket } = await (await f.discover(dport)).json() as { ticket: string };
  const challenged = await f.challenge(ticket);
  assert.equal(challenged.status, 200);
  assert.deepEqual(await challenged.json(), { protocolVersion: 1, proof: studioPairingProof(code, 'arcane', ticket, NONCE) }, 'Arcane answers with proof of the code it shows.');
  await assert.rejects(f.discover(dport), 'A challenged offer closes discovery for everyone else.');
  const first = await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code));
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(await first.json() as object).sort(), ['expiresAt', 'state']);
  assert.equal(f.store.keys().length, 0, 'No key exists before the user approves.');
  const waiting = await (await f.get('/v1/studio/pairing-offer', f.human)).json() as { offer: { offerId: string; state: string; request: { placeName: string; placeId: number; approved: boolean } } };
  assert.equal(waiting.offer.state, 'awaiting-approval');
  assert.deepEqual({ name: waiting.offer.request.placeName, id: waiting.offer.request.placeId, approved: waiting.offer.request.approved }, { name: 'Obby Place', id: 4242, approved: false });
  assert.deepEqual(await (await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code))).json(), { state: 'awaiting-approval', expiresAt: (await (await f.get('/v1/studio/pairing-offer', f.human)).json() as { offer: { expiresAt: string } }).offer.expiresAt });
  // Only the launcher's human session can approve; agents and anonymous callers cannot.
  assert.equal((await f.decide(waiting.offer.offerId, true, f.agent)).status, 403);
  assert.equal((await f.decide(waiting.offer.offerId, true, '')).status, 401);
  assert.equal((await f.post('/v1/studio/pairing-offer/decide', { offerId: waiting.offer.offerId, approve: 'yes' }, f.human)).status, 400);
  assert.equal((await f.decide('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', true)).status, 400, 'A decision names the exact offer.');
  const approved = await f.decide(waiting.offer.offerId, true);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as { offer: { request: { approved: boolean } } }).offer.request.approved, true);
  const claimed = await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code));
  assert.equal(claimed.status, 200);
  const result = await claimed.json() as { apiKey: string; sessionId: string; allowedRoots: string[]; allowWrites: boolean };
  assert.match(result.apiKey, new RegExp('^arcane_local_v1_' + f.port + '_[a-f0-9]{64}$'));
  assert.equal(result.allowWrites, true);
  assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code))).status, 400, 'A used ticket is never replayed.');
  const view = await (await f.get('/v1/studio/pairing-offer', f.human)).json() as { offer: { state: string; claim: { placeName: string; placeId: number; keyId: string; sessionId: string } } };
  assert.equal(view.offer.state, 'claimed');
  assert.equal(view.offer.claim.sessionId, result.sessionId);
  assert.doesNotMatch(JSON.stringify(view), /arcane_local_v1_|arcane_pair_v1_/);
  const status = await f.post('/v1/plugin/status', { protocolVersion: 1, apiKey: result.apiKey, identity: f.identity, sessionId: result.sessionId });
  assert.deepEqual(await status.json(), { protocolVersion: 1, identity: f.identity, state: 'active', sessionId: result.sessionId });
  assert.equal((await f.post('/v1/studio/keys/revoke', { keyId: view.offer.claim.keyId }, f.human)).status, 200);
  assert.equal((await f.post('/v1/plugin/connect', { protocolVersion: 1, apiKey: result.apiKey, identity: f.identity, capabilities: [...READ_METHODS] })).status, 401);
});

test('without the code nothing works: wrong proofs, a second challenger, a changed identity or Deny all burn the offer', async t => {
  const f = await fixture(t);
  const burned = async (setup: (ticket: string, code: string) => Promise<void>) => {
    const created = await f.offer();
    const { ticket } = await (await f.discover(created.discovery.port!)).json() as { ticket: string };
    await setup(ticket, created.offer.code);
    assert.ok(['failed', 'cancelled'].includes(f.store.pairingOffer()!.state), 'the offer is no longer usable');
    assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, created.offer.code))).status, 400);
    assert.ok(f.store.keys().every(key => key.revokedAt !== null), 'no usable key exists');
  };
  // A claim without a challenge, or with a proof for another code (one guess only).
  await burned(async (ticket, code) => { assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code))).status, 400); });
  await burned(async (ticket, code) => {
    assert.equal((await f.challenge(ticket)).status, 200);
    assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code === '000000' ? '000001' : '000000'))).status, 400);
  });
  // Another process racing the plugin: the second challenge burns the offer for both.
  await burned(async ticket => {
    assert.equal((await f.challenge(ticket)).status, 200);
    assert.equal((await f.challenge(ticket, 'f'.repeat(32))).status, 400);
  });
  // The plugin waits for approval, then a different place repeats the claim.
  await burned(async (ticket, code) => {
    assert.equal((await f.challenge(ticket)).status, 200);
    assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code))).status, 200);
    const body = { ...f.claimBody(ticket, code), identity: { ...f.identity, placeId: 9999 } };
    assert.equal((await f.post('/v1/plugin/pairing/claim', body)).status, 400);
  });
  // Deny in Arcane.
  await burned(async (ticket, code) => {
    assert.equal((await f.challenge(ticket)).status, 200);
    assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(ticket, code))).status, 200);
    const offerId = f.store.pairingOffer()!.offerId;
    assert.equal((await f.decide(offerId, false)).status, 200);
    assert.equal(f.store.pairingOffer()!.state, 'cancelled');
    assert.equal((await f.decide(offerId, true)).status, 400, 'a denied offer cannot be approved later');
  });
  // Bad challenge shapes never reach the proof.
  const created = await f.offer();
  const { ticket } = await (await f.discover(created.discovery.port!)).json() as { ticket: string };
  for (const bad of [{ protocolVersion: 1, ticket, clientNonce: 'short' }, { protocolVersion: 2, ticket, clientNonce: NONCE }, { protocolVersion: 1, ticket, clientNonce: NONCE, extra: 1 }])
    assert.equal((await f.post('/v1/plugin/pairing/challenge', bad)).status, 400);
});

test('expiry and newer offers fence old tickets; an approval never outlives its offer', async t => {
  const f = await fixture(t);
  const created = await f.offer();
  const { ticket } = await (await f.discover(created.discovery.port!)).json() as { ticket: string };
  const newer = await f.offer();
  assert.notEqual(newer.offer.offerId, created.offer.offerId);
  assert.equal((await f.challenge(ticket)).status, 400);
  const { ticket: fresh } = await (await f.discover(newer.discovery.port!)).json() as { ticket: string };
  assert.equal((await f.challenge(fresh)).status, 200);
  assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(fresh, newer.offer.code))).status, 200);
  assert.equal((await f.decide(newer.offer.offerId, true)).status, 200);
  f.advance(STUDIO_PAIRING_OFFER_MS);
  assert.equal(f.store.pairingOffer()!.state, 'expired');
  assert.equal((await f.post('/v1/plugin/pairing/claim', f.claimBody(fresh, newer.offer.code))).status, 400);
  assert.equal(f.store.keys().length, 0);
});

test('the offer is bound to this daemon project and port; challenges and claims are rate limited', async t => {
  const f = await fixture(t);
  const project = workflowProjectIdentity(f.directory).projectId;
  const view = f.store.createPairingOffer({ allowedRoots: ['Workspace'], allowWrites: false }, f.port, project);
  assert.equal(view.allowWrites, false);
  assert.equal(f.store.pairingDiscovery(f.port + 1), null, 'Discovery for another daemon port is empty.');
  const ticket = f.store.pairingDiscovery(f.port)!.ticket;
  assert.throws(() => f.store.challengePairingOffer({ protocolVersion: 1, ticket, clientNonce: NONCE }, f.port, 'f'.repeat(64)), /pairing offer/);
  assert.equal(f.store.pairingOffer()!.state, 'pending', 'A challenge for another project never consumes the offer.');
  assert.throws(() => f.store.createPairingOffer({ allowedRoots: ['Workspace'], allowWrites: false }, 0, project), /port/);
  const statuses: number[] = [];
  for (let index = 0; index < 32; index++) statuses.push((await f.challenge('nope')).status);
  assert.ok(statuses.includes(429), 'Challenges share the plugin pairing rate limit.');
});

test('an occupied discovery port reports unavailable so Arcane falls back to the API key', async t => {
  const blocker = createServer((_request, response) => { response.writeHead(418); response.end(); });
  const blocked = await listen(blocker);
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const f = await fixture(t, { discoveryPort: blocked });
  const created = await f.offer();
  assert.equal(created.offer.state, 'pending');
  assert.deepEqual(created.discovery, { state: 'unavailable', port: null });
});
