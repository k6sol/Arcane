import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { StudioStore, type ArcaneKeyIssue } from '../../packages/storage/src/studio-store.js';
import { READ_METHODS, WRITE_METHODS, ROOTS, type PairResult } from '../../packages/protocol/src/studio.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-key-rotate-http-'));
  const store = new StudioStore({ directory });
  const human = 'launcher-human-rotate-fixture';
  const agent = 'launcher-agent-rotate-fixture';
  const route = studioRoutes(store, directory, undefined, directory, agent);
  let origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), human, origin).then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    const path = relative(tmpdir(), directory);
    assert.ok(path !== '' && !isAbsolute(path) && !path.startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  const post = (path: string, input: unknown, bearer?: string, requestOrigin?: string) => fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) },
    body: JSON.stringify(input),
  });
  const connect = { protocolVersion: 1, identity: { clientSessionId: 'rotate-http-window', placeId: 0, universeId: 0, name: 'HTTP fixture', pluginVersion: 'test' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] };
  return { directory, store, origin, port: address.port, human, agent, post, connect };
}

test('rotation is launcher-human-only, strict empty JSON, and leaves existing keys and sessions intact on rejected requests', async t => {
  const f = await fixture(t);
  const old = f.store.issueKey({ allowedRoots: ['Workspace'], allowWrites: false }, f.port);
  const pair = f.store.connectWithKey({ ...f.connect, apiKey: old.apiKey }, f.port);
  const before = { keys: f.store.keys(), sessions: f.store.sessions(), events: f.store.events() };
  for (const bearer of [undefined, 'wrong-bearer', old.apiKey, pair.token]) assert.equal((await f.post('/v1/studio/keys/rotate', {}, bearer)).status, 401);
  assert.equal((await f.post('/v1/studio/keys/rotate', {}, f.agent)).status, 403);
  assert.equal((await f.post('/v1/studio/keys/rotate', { ignored: true }, f.agent)).status, 403);
  assert.equal((await f.post('/v1/studio/keys/rotate', {}, f.human, 'https://foreign.example')).status, 403);
  for (const input of [null, [], false, '', { allowWrites: false }, { allowedRoots: [...ROOTS] }, { keyId: old.keyId }, { apiKey: old.apiKey }, { unknown: true }, JSON.parse('{"__proto__":{}}')]) {
    const response = await f.post('/v1/studio/keys/rotate', input, f.human, f.origin);
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: string };
    assert.equal(payload.error, 'INPUT');
    assert.equal(JSON.stringify(payload).includes(old.apiKey), false);
  }
  for (const raw of ['', '{']) assert.equal((await fetch(f.origin + '/v1/studio/keys/rotate', { method: 'POST', headers: { Authorization: 'Bearer ' + f.human, 'Content-Type': 'application/json' }, body: raw })).status, 400);
  assert.equal((await fetch(f.origin + '/v1/studio/keys/rotate', { method: 'POST', headers: { Authorization: 'Bearer ' + f.human, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
  assert.equal((await fetch(f.origin + '/v1/studio/keys/rotate', { headers: { Authorization: 'Bearer ' + f.human } })).status, 404);
  assert.equal((await fetch(f.origin + '/v1/studio/keys/rotate', { method: 'PUT', headers: { Authorization: 'Bearer ' + f.human } })).status, 405);
  assert.deepEqual({ keys: f.store.keys(), sessions: f.store.sessions(), events: f.store.events() }, before);
  assert.equal(f.store.authenticate(pair.sessionId, pair.token).revokedAt, null);
});

test('successful rotate returns the exact issuance payload, invalidates all old exchanges and sessions, and preserves bearer audiences', async t => {
  const f = await fixture(t);
  const prior: ArcaneKeyIssue[] = [];
  const pairs: PairResult[] = [];
  for (let i = 0; i < 3; i++) {
    const issued = await f.post('/v1/studio/keys', { allowedRoots: ['Workspace'], allowWrites: false }, f.human);
    assert.equal(issued.status, 200);
    const key = await issued.json() as ArcaneKeyIssue;
    prior.push(key);
    const connected = await f.post('/v1/plugin/connect', { ...f.connect, identity: { ...f.connect.identity, clientSessionId: 'old-http-' + i }, apiKey: key.apiKey });
    assert.equal(connected.status, 200);
    pairs.push(await connected.json() as PairResult);
  }
  const response = await f.post('/v1/studio/keys/rotate', {}, f.human, f.origin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const replacement = await response.json() as ArcaneKeyIssue;
  assert.deepEqual(Object.keys(replacement).sort(), ['keyId', 'allowedRoots', 'allowWrites', 'issuedAt', 'revokedAt', 'lastUsedAt', 'apiKey'].sort());
  assert.deepEqual(replacement.allowedRoots, [...ROOTS]);
  assert.equal(replacement.allowWrites, true);
  assert.equal(replacement.revokedAt, null);
  assert.equal(replacement.lastUsedAt, null);
  assert.match(replacement.keyId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(replacement.issuedAt)));
  assert.match(replacement.apiKey, new RegExp('^arcane_local_v1_' + f.port + '_[a-f0-9]{64}$'));
  assert.deepEqual(f.store.keys().filter(key => !key.revokedAt).map(key => key.keyId), [replacement.keyId]);
  for (const [i, key] of prior.entries()) {
    assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: key.apiKey })).status, 401);
    assert.equal((await f.post('/v1/plugin/poll', { sessionId: pairs[i]!.sessionId }, pairs[i]!.token)).status, 409);
  }
  const connected = await f.post('/v1/plugin/connect', { ...f.connect, apiKey: replacement.apiKey });
  assert.equal(connected.status, 200);
  const pair = await connected.json() as PairResult;
  assert.deepEqual(pair.allowedRoots, [...ROOTS]);
  assert.equal(pair.allowWrites, true);
  for (const bearer of [replacement.apiKey, pair.token, f.agent]) {
    for (const path of ['/v1/studio/keys', '/v1/studio/keys/rotate', '/v1/studio/keys/revoke', '/v1/studio/pairing', '/v1/studio/revoke', '/v1/product/mcp-token', '/v1/work/review']) {
      const denied = await f.post(path, {}, bearer, f.origin);
      assert.equal(denied.status, bearer === f.agent ? 403 : 401);
      const text = await denied.text();
      for (const secret of [replacement.apiKey, pair.token, f.human, f.agent]) assert.equal(text.includes(secret), false);
    }
    const listing = await fetch(f.origin + '/v1/studio/keys', { headers: { Authorization: 'Bearer ' + bearer } });
    assert.equal(listing.status, bearer === f.agent ? 403 : 401);
  }
  for (const path of ['/v1/studio/keys', '/v1/studio/sessions', '/v1/product/events', '/v1/product/state']) {
    const listing = await fetch(f.origin + path, { headers: { Authorization: 'Bearer ' + f.human } });
    assert.equal(listing.status, 200);
    const text = await listing.text();
    for (const secret of [replacement.apiKey, ...prior.map(key => key.apiKey), pair.token, f.human, f.agent]) assert.equal(text.includes(secret), false);
  }
  const repeated = await f.post('/v1/studio/keys/rotate', {}, f.human);
  assert.equal(repeated.status, 200);
  const next = await repeated.json() as ArcaneKeyIssue;
  assert.notEqual(next.apiKey, replacement.apiKey);
  assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: replacement.apiKey })).status, 401);
  assert.equal((await f.post('/v1/plugin/poll', { sessionId: pair.sessionId }, pair.token)).status, 409);
  assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: next.apiKey })).status, 200);
  // The legacy revoke endpoint remains available to backend callers.
  assert.equal((await f.post('/v1/studio/keys/revoke', { keyId: next.keyId }, f.human)).status, 200);
  assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: next.apiKey })).status, 401);
});

test('failed rotation returns a sanitized 500 once and leaves old keys, sessions and queued work usable', async t => {
  const f = await fixture(t);
  const old = f.store.issueKey({ allowedRoots: ['Workspace'], allowWrites: true }, f.port);
  const pair = f.store.connectWithKey({ ...f.connect, apiKey: old.apiKey }, f.port);
  const command = f.store.enqueue({ sessionId: pair.sessionId, requestId: 'http-failure-pending', method: 'selection.read', args: {} });
  const before = { keys: f.store.keys(), sessions: f.store.sessions(), commands: f.store.commands(), events: f.store.events() };
  const db = new DatabaseSync(join(f.directory, 'studio.sqlite'));
  let attempts = 0;
  const rotate = f.store.rotateKey.bind(f.store);
  t.mock.method(f.store, 'rotateKey', (input: unknown, port: number) => { attempts++; return rotate(input, port); });
  try {
    db.exec("CREATE TRIGGER fail_rotation BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT,'private persistence detail'); END");
    const response = await f.post('/v1/studio/keys/rotate', {}, f.human, f.origin);
    assert.equal(response.status, 500);
    assert.equal(attempts, 1, 'The route must not retry a failed rotation.');
    const payload = await response.json() as { error: string; message: string };
    assert.equal(payload.error, 'INTERNAL');
    assert.equal(JSON.stringify(payload).includes('private persistence detail'), false);
    for (const secret of [old.apiKey, pair.token, f.human, f.agent]) assert.equal(JSON.stringify(payload).includes(secret), false);
    assert.deepEqual({ keys: f.store.keys(), sessions: f.store.sessions(), commands: f.store.commands(), events: f.store.events() }, before);
    assert.equal(f.store.authenticate(pair.sessionId, pair.token).revokedAt, null);
    db.exec('DROP TRIGGER fail_rotation');
    const polled = await f.post('/v1/plugin/poll', { sessionId: pair.sessionId }, pair.token);
    assert.equal(polled.status, 200);
    assert.equal((await polled.json() as { commands: { id: string }[] }).commands[0]!.id, command.id);
    assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: old.apiKey })).status, 200);
    const rotated = await f.post('/v1/studio/keys/rotate', {}, f.human);
    assert.equal(rotated.status, 200);
    assert.equal(f.store.keys().filter(key => !key.revokedAt).length, 1);
  } finally { db.close(); }
});

test('simultaneous rotations serialize into one active key and only the last committed key exchanges', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.post('/v1/studio/keys/rotate', {}, f.human)));
  const keys = await Promise.all(responses.map(async response => {
    assert.equal(response.status, 200);
    return await response.json() as ArcaneKeyIssue;
  }));
  const active = f.store.keys().filter(key => !key.revokedAt);
  assert.equal(active.length, 1);
  for (const key of keys) assert.equal((await f.post('/v1/plugin/connect', { ...f.connect, apiKey: key.apiKey })).status, key.keyId === active[0]!.keyId ? 200 : 401);
});
