import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Broker only: the REAL released preparation helper on owned temp files, a SCRIPTED test-only daemon (in-memory
// fetch, labelled below) and a scripted trusted launch port. No Electron, no subprocess, no CLI, provider or Studio.
const require = createRequire(import.meta.url);
const { createNativeHandoffHost, NativeHandoffHostError } = require('../../apps/desktop/electron/native-handoff-host.cjs');
const unhandled = []; process.on('unhandledRejection', error => { unhandled.push(error); });
const iso = ms => new Date(ms).toISOString();

/** TEST-ONLY scripted daemon implementing the 4 human handoff endpoints in memory; per-endpoint faults are injectable. */
function scriptedDaemon(origin, controlToken) {
  const projectId = 'a'.repeat(64), handoffs = new Map(), calls = [], faults = {};
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init) => {
    const path = url.startsWith(origin) ? url.slice(origin.length) : url, body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ origin: url.slice(0, origin.length), path, method: init.method, auth: init.headers.Authorization, headerOrigin: init.headers.Origin, redirect: init.redirect, body });
    const fault = faults[path]; if (fault) { const out = await fault({ init, body }); if (out !== undefined) return out; }
    if (init.headers.Authorization !== 'Bearer ' + controlToken || init.headers.Origin !== origin) return json(401, { error: 'AUTH', message: 'x' });
    if (path === '/v1/native-handoffs' && init.method === 'GET') return json(200, { projectId, handoffs: [...handoffs.values()].map(h => ({ ...h })) });
    if (path === '/v1/native-handoffs/begin') {
      const now = Date.now(), h = { handoffId: randomUUID(), state: 'pending', projectId, createdAt: iso(now), expiresAt: iso(now + 1800000), sealedAt: null, endedAt: null };
      handoffs.set(h.handoffId, h); return json(200, { handoff: { ...h }, credential: randomBytes(32).toString('base64url') });
    }
    const h = handoffs.get(body?.handoffId); if (!h) return json(404, { error: 'UNKNOWN', message: 'x' });
    if (path === '/v1/native-handoffs/seal') { if (h.state !== 'pending') return json(409, { error: 'STATE', message: 'x' }); h.state = 'sealed'; h.sealedAt = iso(Date.now()); return json(200, { handoff: { ...h } }); }
    if (path === '/v1/native-handoffs/revoke') { if (h.state === 'pending' || h.state === 'sealed') { h.state = 'revoked'; h.endedAt = iso(Date.now()); } return json(200, { handoff: { ...h } }); }
    return json(404, { error: 'NOT_FOUND', message: 'x' });
  };
  return { fetch, calls, faults, handoffs, projectId, paths: () => calls.map(c => c.method + ' ' + c.path) };
}

async function fixture(t, overrides = {}) {
  const base = await fsp.realpath(tmpdir()), root = await fsp.realpath(await fsp.mkdtemp(join(base, 'arcane-handoff-desktop-')));
  const project = join(root, 'project'), runtimeDirectory = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [project, runtimeDirectory, bin]) await fsp.mkdir(dir);
  const nodePath = join(bin, 'node.exe'), mcpEntry = join(bin, 'main.js'); await fsp.writeFile(nodePath, 'not executed'); await fsp.writeFile(mcpEntry, 'not executed');
  t.after(async () => { const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-desktop-') && !isAbsolute(part) && !part.includes(sep)); await fsp.rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:45871', controlToken = randomBytes(32).toString('hex'), daemon = scriptedDaemon(origin, controlToken);
  const state = { session: { projectPath: project, runtimeDirectory, nodePath, mcpEntry, origin, controlToken, epoch: {} },
    choices: { cliVersion: '2.1.177', aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } };
  const events = [], launches = [];
  const ports = {
    getSession: () => state.session, getChoices: () => state.choices, fetch: daemon.fetch,
    confirm: async (profile, session) => { events.push('confirm'); return overrides.confirm ? overrides.confirm(profile, session) : true; },
    launchTerminal: async request => { events.push('launch'); launches.push(request); return overrides.launch ? overrides.launch(request) : 'opened'; },
    ...(overrides.ports ?? {}),
  };
  const host = createNativeHandoffHost(ports);
  return { host, daemon, state, events, launches, project, runtimeDirectory, origin, controlToken, entries: () => fsp.readdir(runtimeDirectory) };
}
const leakFree = (value, ...secrets) => { for (const text of [JSON.stringify(value) ?? '', inspect(value, { depth: 8 })]) for (const secret of secrets) assert.ok(!text.includes(secret), 'leaked'); };
const pick = { model: 'opus', effort: 'high' };

test('exact confirm -> list -> begin -> prepare -> terminal -> seal order; the credential exists only in the launch env', async t => {
  const f = await fixture(t), out = await f.host.launch(pick);
  assert.equal(out.state, 'opened'); assert.match(out.message, /has not verified that Claude Code or its Arcane tools connected/);
  assert.deepEqual(f.daemon.paths(), ['GET /v1/native-handoffs', 'POST /v1/native-handoffs/begin', 'POST /v1/native-handoffs/seal']);
  assert.deepEqual(f.events, ['confirm', 'launch']);
  for (const call of f.daemon.calls) assert.deepEqual([call.origin, call.auth, call.headerOrigin, call.redirect], [f.origin, 'Bearer ' + f.controlToken, f.origin, 'error']);
  assert.deepEqual(Object.keys(f.daemon.calls[1].body).sort(), ['projectId', 'requestId']); assert.equal(f.daemon.calls[1].body.projectId, f.daemon.projectId);
  const [request] = f.launches, credential = request.env.ARCANE_LOCAL_TOKEN;
  assert.deepEqual(Object.keys(request.env).sort(), ['ARCANE_DAEMON_URL', 'ARCANE_LOCAL_TOKEN']); assert.equal(request.env.ARCANE_DAEMON_URL, f.origin); assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(request.argv.filter(v => !v.endsWith('arcane.mcp.json')), ['--mcp-config', '--strict-mcp-config', '--model', 'opus', '--effort', 'high', '--permission-mode', 'default']);
  assert.ok(!request.argv.join(' ').includes(credential)); assert.equal(request.projectPath, f.project); assert.equal(request.epoch, f.state.session.epoch);
  const config = await fsp.readFile(request.argv[1], 'utf8'); assert.ok(!config.includes(credential) && config.includes('${ARCANE_LOCAL_TOKEN}'));
  assert.equal([...f.daemon.handoffs.values()][0].state, 'sealed');
  leakFree(out, credential, f.controlToken, f.project, request.argv[1]); assert.equal(out.handoffId, [...f.daemon.handoffs.keys()][0]);
});

test('explicit selection against the verified CLI snapshot; no default, metadata drift or missing session refuses before confirmation', async t => {
  for (const [input, reason, mutate] of [[{ model: 'haiku', effort: 'high' }, 'selection'], [{ model: 'opus', effort: 'ultra' }, 'selection'], [{ model: 'opus' }, 'input'],
    [{ ...pick, extra: 1 }, 'input'], [pick, 'metadata_unavailable', s => { s.choices = null; }], [pick, 'session_unavailable', s => { s.session = null; }],
    [pick, 'metadata_unavailable', s => { s.choices = { ...s.choices, aliases: [] }; }], [pick, 'session_unavailable', s => { s.session = { ...s.session, origin: 'http://localhost:45871' }; }]]) {
    const f = await fixture(t); mutate?.(f.state);
    const out = await f.host.launch(input); assert.deepEqual([out.state, out.reason], ['refused', reason], JSON.stringify(input));
    assert.deepEqual([f.events, f.daemon.calls.length], [[], 0], 'no confirmation, request or launch');
  }
  for (const drift of [s => { s.choices = { ...s.choices, cliVersion: '2.1.178' }; }, s => { s.choices = { ...s.choices, aliases: ['fable', 'sonnet'] }; }]) {
    const f = await fixture(t, { confirm: () => { drift(f.state); return true; } });
    assert.deepEqual([(await f.host.launch(pick)).reason], ['context_changed']); assert.equal(f.daemon.calls.length, 0, 'metadata drift during confirmation: no begin');
  }
});

test('cancelled or failed confirmation has no begin; a busy duplicate has no confirmation, mint or launch', async t => {
  for (const confirm of [() => false, () => { throw new Error('dialog'); }, () => 'yes']) {
    const f = await fixture(t, { confirm }), out = await f.host.launch(pick);
    assert.deepEqual([out.state, out.reason], ['cancelled', 'not_confirmed']); assert.equal(f.daemon.calls.length, 0);
  }
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { confirm: () => held.then(() => true) }), first = f.host.launch(pick);
  await delay(5); const busy = await f.host.launch(pick); assert.deepEqual([busy.state, busy.reason], ['refused', 'busy']);
  release(); assert.equal((await first).state, 'opened'); assert.deepEqual(f.events, ['confirm', 'launch'], 'exactly one confirmation and launch');
  assert.equal(f.daemon.paths().filter(p => p.endsWith('/begin')).length, 1);
});

test('lost, malformed, oversize or redirected begin replies are unknown and never re-requested; a known refusal mints nothing', async t => {
  const cases = [['lost', () => { throw new Error('socket'); }, 'unknown'], ['malformed', () => new Response('{"handoff":{}}', { status: 200 }), 'unknown'],
    ['oversize', () => new Response('{"x":"' + 'a'.repeat(140000) + '"}', { status: 200 }), 'unknown'], ['not JSON', () => new Response('<html>', { status: 200 }), 'unknown'],
    ['invalid UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }), 'unknown'], ['server error', () => new Response('{"error":"X"}', { status: 500 }), 'unknown'],
    ['redirected', () => { const r = new Response('{}', { status: 200 }); Object.defineProperty(r, 'redirected', { value: true }); return r; }, 'unknown'],
    ['spent', () => new Response('{"error":"HANDOFF_SPENT","message":"x"}', { status: 409 }), 'refused']];
  for (const [what, fault, state] of cases) {
    const f = await fixture(t); f.daemon.faults['/v1/native-handoffs/begin'] = fault;
    const out = await f.host.launch(pick); assert.equal(out.state, state, what);
    assert.equal(f.daemon.paths().filter(p => p.endsWith('/begin')).length, 1, what + ': no retry or remint'); assert.deepEqual(f.launches, [], what + ': no launch');
    assert.ok(!f.daemon.paths().some(p => p.endsWith('/seal')), what + ': no seal'); assert.deepEqual(await f.entries(), [], what + ': no config');
  }
});

test('failed or unknown terminal launch and lost/refused/malformed seal revoke the original handoff and clean only owned config', async t => {
  for (const [what, options, state, reason] of [['failed launch', { launch: () => 'failed' }, 'refused', 'launch_failed'], ['unknown launch', { launch: () => 'maybe' }, 'unknown', 'launch_unconfirmed'],
    ['launch throws', { launch: () => { throw new Error('x'); } }, 'unknown', 'launch_unconfirmed']]) {
    const f = await fixture(t, options), out = await f.host.launch(pick);
    assert.deepEqual([out.state, out.reason, out.revocation, out.cleanup], [state, reason, 'revoked', 'removed'], what);
    assert.deepEqual(f.daemon.paths().slice(-1), ['POST /v1/native-handoffs/revoke']); assert.ok(!f.daemon.paths().some(p => p.endsWith('/seal')), what + ': never sealed');
    assert.deepEqual(await f.entries(), [], what);
  }
  for (const [what, fault, state] of [['seal lost', () => { throw new Error('socket'); }, 'unknown'], ['seal refused', () => new Response('{"error":"STATE","message":"x"}', { status: 409 }), 'refused'],
    ['seal malformed', () => new Response('{"handoff":{"state":"sealed"}}', { status: 200 }), 'unknown']]) {
    const f = await fixture(t); f.daemon.faults['/v1/native-handoffs/seal'] = fault;
    const out = await f.host.launch(pick); assert.equal(out.state, state, what); assert.equal(out.revocation, 'revoked', what + ': revoke attempted');
    assert.equal([...f.daemon.handoffs.values()][0].state, 'revoked'); assert.equal(f.daemon.paths().filter(p => p.endsWith('/seal')).length, 1, what + ': no reseal');
  }
});

test('a context or epoch change after each await stops later steps and revokes only on the ORIGINAL captured session', async t => {
  const swap = f => { f.state.session = { ...f.state.session, epoch: {}, controlToken: randomBytes(32).toString('hex') }; };
  for (const [stage, expect] of [['confirm', ['cancelled', 0]], ['list', ['cancelled', 0]], ['begin', ['refused', 1]], ['prepare', ['refused', 1]], ['launch', ['unknown', 1]], ['seal', ['unknown', 1]]]) {
    let f;
    f = await fixture(t, {
      confirm: () => { if (stage === 'confirm') swap(f); return true; },
      launch: () => { if (stage === 'launch') swap(f); return 'opened'; },
      ports: stage === 'prepare' ? { preparer: { prepare: async o => { swap(f); o.assertCurrent(); assert.fail('stale preparation must throw'); }, cleanup: async () => ({ state: 'removed' }) } } : {} });
    const original = f.controlToken;
    if (stage === 'list') f.daemon.faults['/v1/native-handoffs'] = () => { swap(f); };
    if (stage === 'begin') f.daemon.faults['/v1/native-handoffs/begin'] = () => { swap(f); };
    if (stage === 'seal') f.daemon.faults['/v1/native-handoffs/seal'] = () => { swap(f); };
    const out = await f.host.launch(pick); assert.equal(out.state, expect[0], stage);
    const revokes = f.daemon.calls.filter(c => c.path.endsWith('/revoke')); assert.equal(revokes.length, expect[1], stage + ' revocations');
    for (const call of revokes) assert.equal(call.auth, 'Bearer ' + original, stage + ': revocation uses the original captured session');
    if (['confirm', 'list', 'begin', 'prepare'].includes(stage)) assert.deepEqual(f.launches, [], stage + ': no late launch');
    if (stage === 'launch') assert.ok(!f.daemon.paths().some(p => p.endsWith('/seal')), 'no late seal');
  }
});

test('cancelPending aborts a held read with no late launch; list and revoke use the current human scope and clean only owned configs', async t => {
  const f = await fixture(t);
  f.daemon.faults['/v1/native-handoffs/begin'] = ({ init }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const pending = f.host.launch(pick); await delay(10); f.host.cancelPending();
  assert.equal((await pending).state, 'unknown'); assert.deepEqual(f.launches, []);
  delete f.daemon.faults['/v1/native-handoffs/begin'];
  const opened = await f.host.launch(pick); assert.equal(opened.state, 'opened');
  const listed = await f.host.list(); assert.equal(listed.state, 'listed'); assert.equal(listed.handoffs.find(h => h.handoffId === opened.handoffId).owned, true);
  leakFree(listed, f.launches[0].env.ARCANE_LOCAL_TOKEN, f.controlToken);
  const configPath = f.launches[0].argv[1]; await fsp.appendFile(configPath, ' ');
  const changed = await f.host.revoke(opened.handoffId); assert.deepEqual([changed.state, changed.cleanup], ['revoked', 'retained']); assert.ok((await fsp.stat(configPath)).isFile(), 'changed config retained');
  const again = await f.host.launch(pick), clean = await f.host.revoke(again.handoffId); assert.deepEqual([clean.state, clean.cleanup], ['revoked', 'removed']);
  assert.equal((await f.host.revoke(randomUUID())).state, 'refused', 'an unknown handoff is a known daemon refusal');
  assert.deepEqual([(await f.host.revoke('nope')).state, (await f.host.revoke('nope')).reason], ['refused', 'input']);
});

test('dispose fences, revokes known original handoffs once and cleans owned configs; no later launch; malformed list is unknown', async t => {
  const f = await fixture(t), opened = await f.host.launch(pick); assert.equal(opened.state, 'opened');
  const summary = await f.host.dispose(); assert.deepEqual(summary, { revoked: 1, unknown: 0, retained: 0 });
  assert.equal(f.daemon.handoffs.get(opened.handoffId).state, 'revoked'); assert.deepEqual(await f.entries(), []);
  assert.deepEqual([(await f.host.launch(pick)).reason, (await f.host.list()).reason], ['disposed', 'disposed']); assert.equal(f.events.filter(e => e === 'launch').length, 1);
  const g = await fixture(t); g.daemon.faults['/v1/native-handoffs'] = () => new Response('{"projectId":"x","handoffs":[]}', { status: 200 });
  assert.deepEqual([(await g.host.list()).state, (await g.host.launch(pick)).reason], ['unknown', 'daemon_unavailable']); assert.equal(g.daemon.paths().filter(p => p.endsWith('/begin')).length, 0);
});

test('an owned loopback HTTP stub sees the human bearer and exact Origin, and a redirect is refused without following', async t => {
  const controlToken = randomBytes(32).toString('hex'), seen = [];
  const server = createServer((request, response) => { seen.push({ url: request.url, auth: request.headers.authorization, origin: request.headers.origin, cookie: request.headers.cookie });
    if (request.url === '/v1/native-handoffs') { response.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); response.end(); } else { response.writeHead(404); response.end('{}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port, f = await fixture(t, { ports: { fetch: globalThis.fetch } });
  f.state.session = { ...f.state.session, origin, controlToken };
  const out = await f.host.list(); assert.deepEqual([out.state, out.reason], ['unknown', 'daemon_unavailable']);
  assert.deepEqual(seen, [{ url: '/v1/native-handoffs', auth: 'Bearer ' + controlToken, origin, cookie: undefined }], 'one request, no redirect followed');
});

test('constructor ports are plain trusted data; proxies, accessors and missing ports are refused without traps', async () => {
  let traps = 0, getters = 0; const ok = { getSession: () => null, getChoices: () => null, confirm: async () => false, launchTerminal: async () => 'failed' };
  for (const ports of [null, new Proxy(ok, { ownKeys() { traps++; return []; } }), Object.defineProperty({ ...ok }, 'confirm', { get() { getters++; return ok.confirm; }, enumerable: true }),
    { ...ok, extra: 1 }, { ...ok, confirm: 1 }, (({ confirm, ...rest }) => rest)(ok), { ...ok, launchTerminal: new Proxy(() => {}, {}) }, { ...ok, preparer: { prepare() {} } }])
    assert.throws(() => createNativeHandoffHost(ports), error => error instanceof NativeHandoffHostError && error.code === 'INPUT');
  assert.equal(traps, 0); assert.equal(getters, 0);
  assert.equal(typeof createNativeHandoffHost(ok).launch, 'function');
  await delay(20); assert.deepEqual(unhandled, []);
});
