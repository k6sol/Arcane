import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import type { InstanceRef, Json, StudioCommand, StudioContinuityProof, StudioRoot, StudioSession } from '../../packages/protocol/src/studio.js';
import { createScriptSync, parseScriptFile, safeSegment, scriptFilePath, SCRIPT_SYNC_LIMITS, sourceHash, type ScriptSyncStatus, type ScriptSyncStudio } from '../../apps/daemon/src/script-sync.js';
import { scriptSyncRoutes } from '../../apps/daemon/src/script-sync-routes.js';
import { readScriptSyncView, scriptSyncSummary } from '../../apps/desktop/src/script-sync.js';

interface Node { id: string; name: string; className: string; root: StudioRoot; parent: Node | null; children: Node[]; source: string; disabled: boolean }

/** In-memory paired Studio double: the plugin's scene.children / script.read / script.update / scene.create contracts only. */
class FakeStudio implements ScriptSyncStudio {
  readonly rootNodes = new Map<StudioRoot, Node>();
  readonly log: { method: string; args: Record<string, Json> }[] = [];
  readonly external: StudioCommand[] = [];
  private readonly results = new Map<string, StudioCommand>();
  private next = 0;
  session: StudioSession & { live: boolean };
  constructor(roots: StudioRoot[] = ['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer'], allowWrites = true) {
    this.session = { id: 'session-1', protocolVersion: 1, clientSessionId: 'client-1', placeId: 42, universeId: 7, name: 'Fixture Place', pluginVersion: '1.0.0',
      allowedRoots: roots, allowWrites, capabilities: ['scene.children', 'script.read', 'script.update', 'scene.create'], connectedAt: '', lastSeenAt: '', revokedAt: null,
      proof: { mode: 'Edit' } as StudioContinuityProof, live: true };
    for (const root of ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'] as StudioRoot[])
      this.rootNodes.set(root, { id: 'root-' + root, name: root, className: root, root, parent: null, children: [], source: '', disabled: false });
  }
  add(parent: Node, name: string, className: string, source = ''): Node {
    const node: Node = { id: 'n' + (++this.next), name, className, root: parent.root, parent, children: [], source, disabled: className !== 'ModuleScript' };
    parent.children.push(node); return node;
  }
  root(name: StudioRoot): Node { return this.rootNodes.get(name)!; }
  find(root: StudioRoot, ...path: string[]): Node | undefined {
    let node: Node | undefined = this.root(root);
    for (const name of path) node = node?.children.find(child => child.name === name);
    return node;
  }
  ref(node: Node): InstanceRef {
    const path: string[] = []; for (let cursor: Node | null = node; cursor?.parent; cursor = cursor.parent) path.unshift(cursor.name);
    return { instanceId: node.id, sessionId: this.session.id, root: node.root, pathSegments: path, className: node.className };
  }
  private resolve(value: unknown): Node {
    const ref = value as InstanceRef;
    const search = (node: Node): Node | null => node.id === ref.instanceId ? node : node.children.map(search).find(Boolean) ?? null;
    const found = search(this.root(ref.root));
    if (!found || ref.sessionId !== this.session.id || !this.session.allowedRoots.includes(ref.root)) throw new Error('REF: unknown reference');
    return found;
  }
  sessions() { return [this.session]; }
  async enqueueVerified(input: unknown): Promise<StudioCommand> {
    const a = input as { sessionId: string; requestId: string; method: string; args: Record<string, Json> };
    if (['script.update', 'scene.create'].includes(a.method) && !this.session.allowWrites) throw new ArcaneError('READ_ONLY', 'This Studio pairing is read-only.');
    this.log.push({ method: a.method, args: a.args });
    const command = { protocolVersion: 1, id: 'c' + (++this.next), requestId: a.requestId, sessionId: a.sessionId, clientSessionId: 'client-1', method: a.method, args: a.args,
      allowedRoots: this.session.allowedRoots, allowWrites: this.session.allowWrites, leaseEpoch: 1, expiresAt: '', state: 'succeeded', createdAt: '', finishedAt: new Date().toISOString(),
      result: null, error: null } as unknown as StudioCommand;
    try { command.result = this.run(a.method, a.args) as Json; }
    catch (error) { command.state = 'failed'; command.error = (error as Error).message; }
    this.results.set(command.id, command); return command;
  }
  private run(method: string, args: Record<string, Json>): unknown {
    if (method === 'scene.children') {
      if (!this.session.allowedRoots.includes(args.root as StudioRoot)) throw new Error('GRANT: outside the grant');
      const parent = args.ref ? this.resolve(args.ref) : this.root(args.root as StudioRoot), limit = Number(args.limit ?? 100);
      return { parentRef: this.ref(parent), items: parent.children.slice(0, limit).map(child => ({ ref: this.ref(child), name: child.name, className: child.className, childCount: child.children.length })), truncated: parent.children.length > limit };
    }
    if (method === 'script.read') { const node = this.resolve(args.ref); return { ref: this.ref(node), source: node.source }; }
    if (method === 'script.update') {
      const node = this.resolve(args.ref);
      if (node.source !== args.expectedSource) throw new Error('CONFLICT: Editor source differs from the expected baseline.');
      const before = node.source; node.source = args.source as string;
      return { ref: this.ref(node), mutation: { kind: 'script.update', ref: this.ref(node), before: { source: before }, after: { source: node.source } } };
    }
    if (method === 'scene.create') {
      const parent = this.resolve(args.parent), node = this.add(parent, args.name as string, args.className as string);
      node.disabled = node.className !== 'ModuleScript'; // The plugin always creates scripts disabled.
      return { ref: this.ref(node), mutation: { kind: 'scene.create', ref: this.ref(node), before: null, after: { properties: {} } } };
    }
    throw new Error('METHOD');
  }
  command(id: string): StudioCommand { const command = this.results.get(id) ?? this.external.find(c => c.id === id); if (!command) throw new Error('unknown'); return command; }
  commands(): StudioCommand[] { return [...this.external, ...this.results.values()].reverse(); }
  /** A script.update made elsewhere in Arcane (chat or tools): applied in Studio with an ordinary receipt. */
  externalUpdate(node: Node, source: string): void {
    const before = node.source; node.source = source;
    this.external.push({ protocolVersion: 1, id: 'x' + (++this.next), requestId: 'chat-request-' + this.next, sessionId: this.session.id, clientSessionId: 'client-1', method: 'script.update',
      args: {}, allowedRoots: this.session.allowedRoots, allowWrites: true, leaseEpoch: 1, expiresAt: '', state: 'succeeded', createdAt: '', finishedAt: new Date(Date.now() + 5).toISOString(),
      result: { ref: this.ref(node), mutation: { kind: 'script.update', ref: this.ref(node), before: { source: before }, after: { source } } } as unknown as Json, error: null } as StudioCommand);
  }
  writes(): number { return this.log.filter(entry => entry.method === 'script.update' || entry.method === 'scene.create').length; }
}

async function folders(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'arcane-sync-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'game'), state = join(base, 'state');
  await mkdir(project); return { base, project, state };
}
function start(t: test.TestContext, studio: FakeStudio, dirs: { project: string; state: string }, extra: Partial<Parameters<typeof createScriptSync>[0]> = {}) {
  const sync = createScriptSync({ projectPath: dirs.project, stateDirectory: dirs.state, studio, pollMs: 3_600_000, receiptMs: 3_600_000, commandWaitMs: 1, watchFiles: false, ...extra });
  t.after(() => sync.close()); return sync;
}
function fixture(studio: FakeStudio) {
  const sss = studio.root('ServerScriptService'), rs = studio.root('ReplicatedStorage');
  const main = studio.add(sss, 'Main', 'Script', 'print("server")\n');
  const shared = studio.add(rs, 'Shared', 'Folder');
  const util = studio.add(shared, 'Util', 'ModuleScript', 'return {}\n');
  const player = studio.add(studio.root('StarterPlayer'), 'StarterPlayerScripts', 'StarterPlayerScripts');
  const client = studio.add(player, 'Input', 'LocalScript', '-- client\n');
  return { main, shared, util, client };
}
const read = (project: string, file: string) => readFile(join(project, ...file.split('/')), 'utf8');
const put = (project: string, file: string, text: string) => writeFile(join(project, ...file.split('/')), text);
const settle = async (sync: { status(): Promise<ScriptSyncStatus> }, until: (s: ScriptSyncStatus) => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const s = await sync.status(); if (until(s)) return s; if (Date.now() > end) assert.fail('timed out: ' + JSON.stringify(s)); await new Promise(r => setTimeout(r, 20)); }
};

test('paths: scripts map to src/<Root>/<Path>.<kind>.luau and back; unsafe names and other roots never map', () => {
  assert.equal(scriptFilePath('ServerScriptService', ['Main'], 'Script'), 'src/ServerScriptService/Main.server.luau');
  assert.equal(scriptFilePath('ReplicatedStorage', ['Shared', 'Util'], 'ModuleScript'), 'src/ReplicatedStorage/Shared/Util.module.luau');
  assert.equal(scriptFilePath('StarterPlayer', ['StarterPlayerScripts', 'Input'], 'LocalScript'), 'src/StarterPlayer/StarterPlayerScripts/Input.client.luau');
  assert.deepEqual(parseScriptFile('src/ReplicatedStorage/Shared/Util.module.luau'), { root: 'ReplicatedStorage', pathSegments: ['Shared', 'Util'], className: 'ModuleScript' });
  assert.deepEqual(parseScriptFile('src/ServerScriptService/a.b.server.luau'), { root: 'ServerScriptService', pathSegments: ['a.b'], className: 'Script' });
  for (const bad of ['CON', 'a:b', 'trailing.', 'x/y', '..', '', 'lpt1.txt', 'a\u0001']) assert.equal(safeSegment(bad), false, bad);
  assert.equal(scriptFilePath('ServerScriptService', ['CON'], 'Script'), null);
  assert.equal(scriptFilePath('Lighting', ['X'], 'Script'), null, 'Lighting is not a sync root');
  assert.equal(scriptFilePath('ServerScriptService', ['Part'], 'Part'), null);
  for (const bad of ['src/Lighting/X.server.luau', 'other/ServerScriptService/X.server.luau', 'src/ServerScriptService/X.lua', 'src/ServerScriptService/../X.server.luau', 'src/ServerScriptService/CON.server.luau'])
    assert.equal(parseScriptFile(bad), null, bad);
});

test('export: off by default; once on, granted scripts are mirrored with an index of refs and hashes, bounded by size', async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main, util, client } = fixture(studio);
  studio.add(studio.root('ServerStorage'), 'Hidden', 'Script', 'secret'); // Not granted: never read or exported.
  studio.add(studio.root('ServerScriptService'), 'Huge', 'Script', 'x'.repeat(SCRIPT_SYNC_LIMITS.sourceBytes + 1));
  const sync = start(t, studio, dirs);
  const off = await sync.status();
  assert.equal(off.enabled, false); assert.equal(off.state, 'off'); assert.equal(studio.log.length, 0, 'nothing runs while off');
  await sync.setEnabled(true);
  const status = await sync.syncNow();
  assert.equal(status.state, 'ready', status.message); assert.equal(status.counts.tracked, 3); assert.equal(status.counts.exported, 3);
  assert.equal(await read(dirs.project, 'src/ServerScriptService/Main.server.luau'), main.source);
  assert.equal(await read(dirs.project, 'src/ReplicatedStorage/Shared/Util.module.luau'), util.source);
  assert.equal(await read(dirs.project, 'src/StarterPlayer/StarterPlayerScripts/Input.client.luau'), client.source);
  assert.deepEqual(await readdir(join(dirs.project, 'src')), ['ReplicatedStorage', 'ServerScriptService', 'StarterPlayer']);
  assert.ok(status.skipped.some(item => item.file === 'src/ServerScriptService/Huge.server.luau' && /100 KiB/.test(item.reason)));
  assert.ok(!studio.log.some(entry => JSON.stringify(entry.args).includes('ServerStorage')), 'ungranted roots are never queried');
  assert.equal(studio.writes(), 0, 'export never writes to Studio');
  const index = JSON.parse(await read(dirs.project, '.arcane/sync.json')) as { placeId: number; files: Record<string, { ref: InstanceRef; hash: string }> };
  assert.equal(index.placeId, 42);
  assert.deepEqual(index.files['src/ServerScriptService/Main.server.luau'], { ref: studio.ref(main), hash: sourceHash(main.source) });
  assert.deepEqual(JSON.parse(await readFile(join(dirs.state, 'script-sync.json'), 'utf8')), { version: 1, enabled: true }, 'the switch lives in Arcane state, not the project');
  // A second instance (Arcane restart) resumes from the saved switch.
  const again = start(t, studio, dirs);
  assert.equal((await again.status()).enabled, true);
  await settle(again, s => s.state === 'ready');
  again.close();
});

test('import: file edits apply through script.update with the exact Studio baseline; new files create disabled scripts', async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main } = fixture(studio);
  const sync = start(t, studio, dirs);
  await sync.setEnabled(true); await sync.syncNow();
  await put(dirs.project, 'src/ServerScriptService/Main.server.luau', '\ufeffprint("edited")\r\n');
  await put(dirs.project, 'src/ServerScriptService/Spawner.server.luau', 'print("new")\n');
  await mkdir(join(dirs.project, 'src/ReplicatedStorage/Missing'));
  await put(dirs.project, 'src/ReplicatedStorage/Missing/Orphan.module.luau', 'return 1\n');
  const status = await sync.syncNow();
  assert.equal(main.source, 'print("edited")\n', 'BOM and CRLF are normalised');
  assert.equal(main.disabled, true, 'never enabled');
  const update = studio.log.find(entry => entry.method === 'script.update')!;
  assert.equal(update.args.expectedSource, 'print("server")\n');
  const spawner = studio.find('ServerScriptService', 'Spawner')!;
  assert.equal(spawner.className, 'Script'); assert.equal(spawner.source, 'print("new")\n'); assert.equal(spawner.disabled, true);
  assert.ok(!studio.log.some(entry => entry.method === 'script.set_enabled'));
  assert.ok(status.skipped.some(item => item.file === 'src/ReplicatedStorage/Missing/Orphan.module.luau' && /parent folder/.test(item.reason)));
  assert.equal(status.counts.imported, 2); assert.equal(status.counts.created, 1);
  const writes = studio.writes();
  assert.equal((await sync.syncNow()).state, 'ready'); assert.equal(studio.writes(), writes, 'an unchanged folder causes no further writes');
});

test('conflicts: both sides changed are listed and nothing is overwritten until the person picks Keep Studio or Keep file', async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main, util } = fixture(studio);
  const sync = start(t, studio, dirs);
  await sync.setEnabled(true); await sync.syncNow();
  main.source = 'print("studio")\n'; util.source = 'return { studio = true }\n';
  await put(dirs.project, 'src/ServerScriptService/Main.server.luau', 'print("file")\n');
  await put(dirs.project, 'src/ReplicatedStorage/Shared/Util.module.luau', 'return { file = true }\n');
  const status = await sync.syncNow();
  assert.deepEqual(status.conflicts.map(item => item.file).sort(), ['src/ReplicatedStorage/Shared/Util.module.luau', 'src/ServerScriptService/Main.server.luau']);
  assert.equal(main.source, 'print("studio")\n'); assert.equal(await read(dirs.project, 'src/ServerScriptService/Main.server.luau'), 'print("file")\n');
  await sync.resolve('src/ServerScriptService/Main.server.luau', 'file');
  assert.equal(main.source, 'print("file")\n');
  await sync.resolve('src/ReplicatedStorage/Shared/Util.module.luau', 'studio');
  assert.equal(await read(dirs.project, 'src/ReplicatedStorage/Shared/Util.module.luau'), 'return { studio = true }\n');
  const after = await sync.syncNow();
  assert.equal(after.conflicts.length, 0); assert.equal(after.state, 'ready');
  await assert.rejects(sync.resolve('src/ServerScriptService/Main.server.luau', 'file'), { code: 'SYNC_STALE' });
  await assert.rejects(sync.resolve('../outside.server.luau', 'file'), { code: 'SYNC_INPUT' });
});

test('deletions are never propagated; each is listed for a decision', async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main, util, shared } = fixture(studio);
  const sync = start(t, studio, dirs);
  await sync.setEnabled(true); await sync.syncNow();
  await rm(join(dirs.project, 'src/ServerScriptService/Main.server.luau'));
  shared.children.splice(shared.children.indexOf(util), 1);
  const status = await sync.syncNow();
  assert.deepEqual(status.deletions, [{ file: 'src/ReplicatedStorage/Shared/Util.module.luau', side: 'studio' }, { file: 'src/ServerScriptService/Main.server.luau', side: 'file' }]);
  assert.ok(studio.find('ServerScriptService', 'Main'), 'the Studio script stays'); assert.equal(main.source, 'print("server")\n');
  assert.equal(await read(dirs.project, 'src/ReplicatedStorage/Shared/Util.module.luau'), 'return {}\n', 'the file stays');
  await assert.rejects(sync.deletion('src/ServerScriptService/Main.server.luau', 'delete-file'), { code: 'SYNC_INPUT' });
  await sync.deletion('src/ServerScriptService/Main.server.luau', 'restore');
  assert.equal(await read(dirs.project, 'src/ServerScriptService/Main.server.luau'), 'print("server")\n');
  await sync.deletion('src/ReplicatedStorage/Shared/Util.module.luau', 'delete-file');
  await assert.rejects(readFile(join(dirs.project, 'src/ReplicatedStorage/Shared/Util.module.luau')), { code: 'ENOENT' });
  assert.equal((await sync.syncNow()).deletions.length, 0);
  // Stop syncing keeps the Studio script and remembers the choice.
  await rm(join(dirs.project, 'src/ServerScriptService/Main.server.luau'));
  await sync.syncNow(); await sync.deletion('src/ServerScriptService/Main.server.luau', 'ignore');
  const ignored = await sync.syncNow();
  assert.equal(ignored.deletions.length, 0);
  await assert.rejects(readFile(join(dirs.project, 'src/ServerScriptService/Main.server.luau')), { code: 'ENOENT' });
  assert.deepEqual((JSON.parse(await read(dirs.project, '.arcane/sync.json')) as { ignored: string[] }).ignored, ['src/ServerScriptService/Main.server.luau']);
});

test('safety: read-only pairings and Play mode never receive file changes; linked folders are refused', async t => {
  const dirs = await folders(t), studio = new FakeStudio(undefined, false);
  const { main } = fixture(studio);
  const sync = start(t, studio, dirs);
  await sync.setEnabled(true); await sync.syncNow();
  await put(dirs.project, 'src/ServerScriptService/Main.server.luau', 'print("edited")\n');
  await put(dirs.project, 'src/ServerScriptService/New.server.luau', 'print("new")\n');
  let status = await sync.syncNow();
  assert.equal(studio.writes(), 0); assert.equal(main.source, 'print("server")\n'); assert.equal(status.writable, false);
  assert.ok(status.skipped.some(item => item.file.endsWith('Main.server.luau') && /read-only/.test(item.reason)));
  studio.session.allowWrites = true; studio.session.proof = { mode: 'Play' } as StudioContinuityProof;
  status = await sync.syncNow();
  assert.equal(studio.writes(), 0); assert.ok(status.skipped.some(item => /Edit mode/.test(item.reason)));
  studio.session.proof = { mode: 'Edit' } as StudioContinuityProof;
  await sync.syncNow(); assert.equal(main.source, 'print("edited")\n');

  // A linked src folder (symlink or junction) is never followed or written through.
  const linked = await folders(t), outside = join(linked.base, 'outside');
  await mkdir(outside);
  try { await symlink(outside, join(linked.project, 'src'), 'junction'); } catch { t.diagnostic('links unavailable'); return; }
  const other = new FakeStudio(); fixture(other);
  const guarded = start(t, other, linked);
  await guarded.setEnabled(true);
  const refused = await guarded.syncNow();
  assert.equal(refused.state, 'error'); assert.match(refused.message, /link|junction/);
  assert.deepEqual(await readdir(outside), [], 'nothing was written outside the project');
});

test('Studio to file: Arcane receipts update files promptly, and a different place is refused', async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main } = fixture(studio);
  const sync = start(t, studio, dirs, { receiptMs: 20 });
  await sync.setEnabled(true); await sync.syncNow();
  await new Promise(resolve => setTimeout(resolve, 60)); // First receipt tick sets the watermark.
  studio.externalUpdate(main, 'print("from chat")\n');
  const end = Date.now() + 5000;
  while (await read(dirs.project, 'src/ServerScriptService/Main.server.luau') !== 'print("from chat")\n') {
    if (Date.now() > end) assert.fail('receipt was not applied'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(studio.writes(), 0);
  studio.session.placeId = 99;
  const refused = await sync.syncNow();
  assert.equal(refused.state, 'error'); assert.match(refused.message, /different Studio place/);
});

test('folder watch: saving a file in an editor applies it without a manual sync', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, async t => {
  const dirs = await folders(t), studio = new FakeStudio();
  const { main } = fixture(studio);
  const sync = start(t, studio, dirs, { watchFiles: true, debounceMs: 30 });
  await sync.setEnabled(true); await sync.syncNow();
  await new Promise(resolve => setTimeout(resolve, 100));
  await put(dirs.project, 'src/ServerScriptService/Main.server.luau', 'print("saved in editor")\n');
  const end = Date.now() + 8000;
  while (main.source !== 'print("saved in editor")\n') { if (Date.now() > end) assert.fail('watch did not apply the file'); await new Promise(resolve => setTimeout(resolve, 25)); }
  await settle(sync, s => s.state === 'ready');
});

test('routes: human desktop bearer only, same-origin changes, exact JSON input; replies satisfy the renderer reader', async t => {
  const dirs = await folders(t), studio = new FakeStudio(); fixture(studio);
  const routes = scriptSyncRoutes({ sync: start(t, studio, dirs) });
  const token = 'h'.repeat(64), agent = 'a'.repeat(64);
  let origin = '';
  const server = createServer(async (request, response) => {
    if (await routes.handle(request, response, new URL(request.url ?? '/', origin), token, origin)) return;
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown, bearer = token, from: string | null = origin) => {
    const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + bearer, ...(from ? { Origin: from } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  assert.equal((await call('GET', '/v1/script-sync', undefined, agent)).status, 401);
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: true }, agent)).status, 401);
  const first = await call('GET', '/v1/script-sync', undefined, token, null);
  assert.equal(first.status, 200); assert.equal(readScriptSyncView(first.body)?.enabled, false);
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: true }, token, null)).status, 403);
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: true }, token, 'http://evil.test')).status, 403);
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: true, path: '..' })).status, 400);
  assert.equal((await call('POST', '/v1/script-sync', { enabled: true })).status, 405);
  assert.equal((await call('POST', '/v1/script-sync/run', {})).body.error, 'SYNC_OFF');
  assert.equal((await call('PUT', '/v1/script-sync', { enabled: true })).status, 200);
  const ran = await call('POST', '/v1/script-sync/run', {});
  assert.equal(ran.status, 200); const view = readScriptSyncView(ran.body);
  assert.ok(view); assert.equal(view.counts.tracked, 3); assert.equal(view.state, 'ready');
  assert.equal((await call('POST', '/v1/script-sync/resolve', { file: 'src/ServerScriptService/Main.server.luau', keep: 'both' })).status, 400);
  assert.equal((await call('POST', '/v1/script-sync/resolve', { file: 'src/ServerScriptService/Main.server.luau', keep: 'file' })).status, 409);
  assert.equal((await call('POST', '/v1/script-sync/deletion', { file: 'C:/Windows/x.server.luau', action: 'delete-file' })).status, 400);
});

test('renderer helpers: strict reply reader and status line', () => {
  const view = { enabled: true, state: 'ready', message: 'Scripts are in sync.', folder: 'src', lastSyncAt: new Date(1_000_000).toISOString(), place: 'Fixture Place', writable: true,
    counts: { tracked: 12, exported: 3, imported: 1, created: 1, conflicts: 0, deletions: 0, skipped: 0 }, conflicts: [], deletions: [], skipped: [] };
  const parsed = readScriptSyncView(view);
  assert.ok(parsed);
  assert.equal(scriptSyncSummary(parsed, 1_000_000 + 125_000), 'Last sync 2 min ago · 12 scripts · 3 to files · 2 to Studio · Fixture Place');
  assert.equal(scriptSyncSummary({ ...parsed, enabled: false }, 0), 'Off. Scripts stay in Studio only.');
  for (const bad of [null, { ...view, state: 'busy' }, { ...view, counts: { ...view.counts, tracked: -1 } }, { ...view, deletions: [{ file: 'x', side: 'both' }] }, { ...view, conflicts: 'x' }])
    assert.equal(readScriptSyncView(bad), null);
});

test('markup and styles: Settings card, studio boot hook and a motion-free owned CSS block before the reset', async () => {
  const html = await readFile('apps/desktop/public/studio.html', 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const card = html.slice(html.indexOf('<section id="script-sync-settings"'), html.indexOf('<section id="settings-plans"'));
  assert.ok(card.length > 0 && html.indexOf('<section id="script-sync-settings"') > html.indexOf('<section id="settings-memory"'));
  assert.match(card, /<input id="script-sync-enabled" type="checkbox" role="switch"[^>]*disabled>/);
  assert.match(card, /Sync scripts with project folder/);
  for (const id of ['script-sync-status', 'script-sync-summary', 'script-sync-run', 'script-sync-conflicts', 'script-sync-deletions', 'script-sync-skipped']) assert.match(card, new RegExp('id="' + id + '"'));
  assert.doesNotMatch(card, /\bstyle=|<script|\bon[a-z]+=/i);
  assert.ok((await readFile('apps/desktop/src/studio.ts', 'utf8')).includes("void import('./script-sync.js').then(module=>{const sync=module.startScriptSync(document,{token:()=>token});"));
  const start = css.indexOf('/* ---- Script sync'), end = css.indexOf('/* ---- End script sync ---- */'), reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');
  assert.ok(start > 0 && end > start && reset > end, 'owned block sits before the final reduced-motion reset');
  assert.doesNotMatch(css.slice(start, end), /transition|animation|#[0-9a-f]{3,8}\b/i);
  const source = await readFile('apps/desktop/src/script-sync.ts', 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|localStorage|sessionStorage|\bimport\s*\(/);
});
