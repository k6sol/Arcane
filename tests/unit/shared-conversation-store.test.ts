import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';

// Actual SQLite stores and owned loopback LAB listeners. No Studio store, SDK,
// provider, Blender worker, inference, credentials or user application is used.
const native = { provider: 'codex' as const, threadId: 'fixture.shared-chat', sessionId: null };
const noProbe = async (): Promise<never> => { throw new Error('Provider probes forbidden in ownership fixtures'); };
async function fixture(t: test.TestContext) {
  const boundary = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(boundary, 'arcane-shared-chat-')));
  const project = join(root, 'project'); mkdirSync(project);
  const stateDirectory = join(root, 'lab');
  const closers: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of closers.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    const part = relative(boundary, root);
    assert.ok(part.startsWith('arcane-shared-chat-') && !isAbsolute(part) && !part.includes(sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const work = new WorkStore({ directory: join(root, 'work'), projectPath: project }); closers.push(() => work.close());
  const shared = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath: project });
  closers.push(() => shared.close());
  shared.bind({ conversation: native, kind: 'asset-job', id: 'owned-original-job' });
  const options = { cwd: resolve('.'), projectPath: shared.projectPath, stateDirectory, workStore: work,
    conversationWorkStore: shared, probe: noProbe, codexConnect: refuseNativeCodex };
  return { root, project, stateDirectory, work, shared, options, own: (close: () => void | Promise<void>) => closers.push(close) };
}

test('LAB uses the same owned conversation store and does not close its borrower on shutdown', async t => {
  const f = await fixture(t), lab = await createConnectionLab(f.options); f.own(() => lab.close());
  // A second writer in this exact directory would have failed before binding.
  assert.equal(f.shared.list(native, 'asset-job').items[0]?.id, 'owned-original-job');
  await lab.close();
  f.shared.bind({ conversation: native, kind: 'asset-job', id: 'owned-after-shutdown' });
  const restarted = await createConnectionLab(f.options); f.own(() => restarted.close());
  assert.equal(f.shared.list(native, 'asset-job').items.length, 2);
  await restarted.close();
  assert.equal(f.shared.list(native, 'asset-job').items.length, 2);
});

test('borrowed stores require work coordination and the exact canonical project before startup', async t => {
  const f = await fixture(t);
  const { workStore: _workStore, ...withoutWork } = f.options;
  await assert.rejects(createConnectionLab(withoutWork), { code: 'CONVERSATION_WORK_SCOPE' });
  const other = join(f.root, 'other-project'); mkdirSync(other);
  await assert.rejects(createConnectionLab({ ...f.options, projectPath: other }), { code: 'CONVERSATION_WORK_SCOPE' });
  assert.equal(existsSync(join(f.stateDirectory, 'workflows')), false);
  assert.equal(f.shared.list(native, 'asset-job').items.length, 1);
});

test('asset project mismatch during initialization preserves the shared store and original bindings', async t => {
  const f = await fixture(t), other = join(f.root, 'foreign-project'); mkdirSync(other);
  const service = await createAssetService({ cwd: f.root, projectPath: other, outputRoot: join(f.root, 'foreign-assets') });
  f.own(() => service.close());
  await assert.rejects(createConnectionLab({ ...f.options, assetService: service }), { code: 'ASSET_CONVERSATION_PROJECT' });
  f.shared.bind({ conversation: native, kind: 'asset-job', id: 'owned-after-refusal' });
  assert.equal(f.shared.list(native, 'asset-job').items.length, 2);
});

test('listener failure releases LAB-owned resources without closing the shared store', async t => {
  const f = await fixture(t), occupied = createServer();
  await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  f.own(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(createConnectionLab({ ...f.options, port: address.port }), { code: 'EADDRINUSE' });
  f.shared.bind({ conversation: native, kind: 'asset-job', id: 'owned-after-listener-failure' });
  assert.equal(f.shared.list(native, 'asset-job').items.length, 2);
});

test('standalone LAB still owns and closes the conversation store it creates', async t => {
  const f = await fixture(t), stateDirectory = join(f.root, 'standalone-lab');
  const { conversationWorkStore: _shared, ...options } = f.options;
  const lab = await createConnectionLab({ ...options, stateDirectory }); f.own(() => lab.close());
  await lab.close();
  const reopened = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath: f.project });
  f.own(() => reopened.close()); reopened.bind({ conversation: native, kind: 'asset-job', id: 'owned-reopened' });
  assert.equal(reopened.list(native, 'asset-job').items.length, 1);
});

test('production creates the shared store before assets and gives LAB the same instance', async () => {
  const source = await readFile(resolve('apps/daemon/src/product-main.ts'), 'utf8');
  const createStore = source.indexOf('associations = new ConversationWorkStore(');
  assert.ok(createStore >= 0 && createStore < source.indexOf('assets=await createAssetService('));
  assert.match(source, /conversationWorkStore: associations/);
  assert.match(source, /projectPath:associations\.projectPath/);
  const shutdown = source.slice(source.indexOf('async function shutdown()'));
  assert.ok(shutdown.indexOf('assets.close()') < shutdown.indexOf('associations.close()'));
});
