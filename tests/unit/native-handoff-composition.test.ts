import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createNativeHandoffRoutes } from '../../apps/daemon/src/native-handoff-routes.js';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';

// Composition evidence: the ACTUAL createNativeHandoffRoutes (+ registry) and real StudioRoutes/WorkStore behind an
// OWNED loopback HTTP server, the ACTUAL desktop broker createNativeHandoffHost with the REAL preparation helper on
// owned temp paths, and real fetch. Only the trusted desktop ports are SCRIPTED (choices, confirmation, terminal
// acknowledgement). No process, terminal, native CLI, provider or Studio is invoked; `opened` is never a connection claim.
const require = createRequire(join(process.cwd(), 'package.json'));
type Outcome = { state: string; reason: string | null; message: string; handoffId?: string; expiresAt?: string; revocation?: string; cleanup?: string };
type Host = { launch(input: unknown): Promise<Outcome>; list(): Promise<any>; revoke(id: unknown): Promise<Outcome>; cancelPending(): void; dispose(): Promise<any> };
const { createNativeHandoffHost } = require(join(process.cwd(), 'apps/desktop/electron/native-handoff-host.cjs')) as { createNativeHandoffHost(ports: Record<string, unknown>): Host };
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });

async function fixture(t: TestContext, ports: { confirm?: (s: any) => unknown; launch?: (r: any) => unknown; fetch?: typeof fetch } = {}) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-composition-')));
  const project = join(root, 'project'), runtimeDirectory = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [project, runtimeDirectory, bin]) await mkdir(dir);
  const nodePath = join(bin, 'node.exe'), mcpEntry = join(bin, 'main.js'); await writeFile(nodePath, 'not executed'); await writeFile(mcpEntry, 'not executed');
  const human = randomBytes(32).toString('hex'), core = randomBytes(32).toString('hex');
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const routes = createNativeHandoffRoutes({ projectPath: project });
  let origin = '';
  const bridge = studioRoutes(studio, root, work, project, (request: IncomingMessage) => routes.agentToken(request, origin) || core, null,
    () => { throw new Error('no original native task'); });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    void (async () => {
      if (await routes.handle(request, response, url, human, origin)) return;
      if (await bridge(request, response, url, human, origin)) return;
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"NOT_FOUND"}');
    })().catch(() => { if (!response.headersSent) { response.writeHead(500); response.end('{}'); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const state: { session: Record<string, unknown> | null } = { session: { projectPath: project, runtimeDirectory, nodePath, mcpEntry, origin, controlToken: human, epoch: {} } };
  const credentials: string[] = [], configs: string[] = [];
  // SCRIPTED trusted ports (root composes the real provider-setup ports separately).
  const host = createNativeHandoffHost({
    getSession: () => state.session,
    getChoices: () => ({ cliVersion: '2.1.177', aliases: ['opus', 'sonnet'], efforts: ['high', 'max'] }),
    confirm: async () => (ports.confirm ? ports.confirm(state) : true),
    launchTerminal: async (request: { argv: string[]; env: Record<string, string> }) => {
      credentials.push(request.env.ARCANE_LOCAL_TOKEN!); configs.push(request.argv[1]!);
      return ports.launch ? ports.launch(state) : 'opened';
    },
    ...(ports.fetch ? { fetch: ports.fetch } : {}),
  });
  t.after(async () => {
    for (const close of [() => host.dispose(), () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }), () => routes.close(), () => work.close(), () => studio.close()])
      try { await close(); } catch { /* owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-composition-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const call = async (token: string, path: string, body?: unknown, withOrigin = body !== undefined) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + token, ...(withOrigin ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed: Record<string, any> = {}; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, body: parsed, text };
  };
  const serverHandoffs = async () => (await call(human, '/v1/native-handoffs')).body.handoffs as { handoffId: string; state: string }[];
  return { host, routes, studio, work, state, credentials, configs, human, core, origin, runtimeDirectory, call, serverHandoffs };
}
const pick = { model: 'opus', effort: 'high' };

test('actual begin -> real prepare -> scripted open -> actual seal; the scoped bearer works allowed routes only', async t => {
  const f = await fixture(t), out = await f.host.launch(pick);
  assert.equal(out.state, 'opened'); assert.match(out.message, /has not verified that Claude Code or its Arcane tools connected/);
  assert.equal(f.credentials.length, 1); const credential = f.credentials[0]!;
  assert.deepEqual((await f.serverHandoffs()).map(h => [h.handoffId, h.state]), [[out.handoffId, 'sealed']]);
  const config = await readFile(f.configs[0]!, 'utf8'); assert.ok(config.includes('${ARCANE_LOCAL_TOKEN}') && !config.includes(credential), 'token-free owned config');
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 200, 'sealed scoped bearer on an allowed route');
  const created = await f.call(credential, '/v1/work/create', { title: 'Composition', objective: 'x', tasks: [{ key: 'k', title: 'k', instructions: 'i', acceptance: 'a', scope: ['src/k'], dependencies: [] }] }, false);
  assert.equal(created.status, 200, created.text);
  for (const [path, body] of [['/v1/work/review', { taskId: created.body.run.tasks[0].id, approved: true, note: 'self' }], ['/v1/product/mcp-token', {}], ['/v1/studio/keys', undefined],
    ['/v1/native-handoffs', undefined], ['/v1/native-handoffs/begin', { requestId: '00000000-0000-4000-8000-000000000000', projectId: f.routes.projectId }]] as const) {
    const reply = await f.call(credential, path, body, false); assert.ok(reply.status === 401 || reply.status === 403, path + ' -> ' + reply.status); assert.ok(!reply.text.includes(credential));
  }
  const listed = await f.host.list(); assert.equal(listed.state, 'listed'); assert.deepEqual(listed.handoffs.map((h: any) => [h.state, h.owned]), [['sealed', true]]);
  for (const value of [out, listed]) { const text = JSON.stringify(value); assert.ok(!text.includes(credential) && !text.includes(f.human) && !text.includes(f.configs[0]!)); }
  assert.equal(f.studio.commands().length, 0, 'no Studio command');
});

test('explicit human revoke through the broker retires the bearer and removes the owned config', async t => {
  const f = await fixture(t), out = await f.host.launch(pick), credential = f.credentials[0]!;
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 200);
  const revoked = await f.host.revoke(out.handoffId);
  assert.deepEqual([revoked.state, revoked.cleanup], ['revoked', 'removed']);
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 401, 'revoked bearer refused');
  assert.deepEqual(await readdir(f.runtimeDirectory), [], 'owned config and directory removed');
  assert.deepEqual((await f.serverHandoffs()).map(h => h.state), ['revoked']);
});

test('a context change before begin mints nothing; after begin it revokes on the ORIGINAL session and never seals', async t => {
  const swap = (state: { session: Record<string, unknown> | null }) => { state.session = { ...state.session!, epoch: {} }; };
  const early = await fixture(t, { confirm: state => { swap(state); return true; } });
  assert.deepEqual([(await early.host.launch(pick)).reason], ['context_changed']); assert.deepEqual(await early.serverHandoffs(), [], 'nothing minted');
  const late = await fixture(t, { launch: state => { swap(state); return 'opened'; } }), out = await late.host.launch(pick);
  assert.deepEqual([out.state, out.reason, out.revocation, out.cleanup], ['unknown', 'context_changed_after_launch', 'revoked', 'removed']);
  assert.deepEqual((await late.serverHandoffs()).map(h => h.state), ['revoked'], 'revoked on the daemon via the original captured session');
  assert.equal((await late.call(late.credentials[0]!, '/v1/work/runs')).status, 401, 'the never-sealed bearer has no authority');
  assert.deepEqual(await readdir(late.runtimeDirectory), []);
  const cancelled = await fixture(t, { confirm: () => true, launch: () => 'opened' });
  cancelled.host.cancelPending(); assert.equal((await cancelled.host.launch(pick)).state, 'opened', 'cancelPending fences only in-flight work, not later explicit launches');
});

test('a lost seal acknowledgement is unknown: one begin, no remint, original handoff revoked over real HTTP', async t => {
  let seals = 0;
  const lossy: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/v1/native-handoffs/seal')) { seals++; await response.text(); throw new Error('acknowledgement lost after the daemon applied it'); }
    return response;
  };
  const f = await fixture(t, { fetch: lossy }), out = await f.host.launch(pick);
  assert.deepEqual([out.state, out.reason, out.revocation], ['unknown', 'seal_unconfirmed', 'revoked']);
  assert.equal(seals, 1, 'no reseal');
  const server = await f.serverHandoffs(); assert.equal(server.length, 1, 'exactly one begin, no remint'); assert.equal(server[0]!.state, 'revoked');
  assert.equal((await f.call(f.credentials[0]!, '/v1/work/runs')).status, 401);
});

test('route shutdown refuses later native authority; the broker reports unknown instead of claiming revocation', async t => {
  const f = await fixture(t), out = await f.host.launch(pick), credential = f.credentials[0]!;
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 200);
  f.routes.close();
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 401, 'closed routes recognise no handoff bearer');
  assert.deepEqual([(await f.host.list()).state, (await f.host.launch(pick)).reason, (await f.host.revoke(out.handoffId)).state], ['unknown', 'daemon_unavailable', 'unknown']);
  assert.deepEqual(await f.host.dispose(), { revoked: 0, unknown: 1, retained: 0 }, 'dispose cannot acknowledge a revoke from closed routes but still cleans the owned config');
  assert.deepEqual(await readdir(f.runtimeDirectory), []);
  assert.deepEqual(unhandled, []);
});
