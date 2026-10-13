import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicAssetJson, AtomicJsonFailure } from '../../packages/asset-pipeline/src/atomic-json.js';
import { noLinks, within } from '../../packages/asset-pipeline/src/paths.js';

async function fixture(t: test.TestContext) {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(base, 'arcane-atomic-json-'));
  t.after(async () => { assert.ok(within(base, root)); await noLinks(root); await fs.rm(root, { recursive: true, force: true }); });
  const target = join(root, 'index.json'); await fs.writeFile(target, '{"old":true}\n', { flag: 'wx' });
  return { root, target };
}
function error(code: string) { return Object.assign(new Error('Private path C:/private/do-not-expose'), { code }); }
function mockRename(t: test.TestContext, work: (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => Promise<void>) {
  const original = fs.rename; fs.rename = work; syncBuiltinESMExports();
  t.after(() => { fs.rename = original; syncBuiltinESMExports(); });
  return original;
}
const expected = (phase: string, code: string) => (e: unknown) => e instanceof AtomicJsonFailure && e.phase === phase && e.code === code && !e.message.includes('C:') && !e.message.includes('Private');

test('atomic metadata writer commits exact durable bytes and leaves no temporary source', async t => {
  const { root, target } = await fixture(t), text = '{"new":true}\n';
  await atomicAssetJson(root, 'index.json', text);
  assert.equal(await fs.readFile(target, 'utf8'), text);
  assert.deepEqual(await fs.readdir(root), ['index.json']);
});
test('atomic metadata writer refuses hardlinked and linked destinations without modifying originals', async t => {
  const { root, target } = await fixture(t), other = join(root, 'other.json');
  await fs.link(target, other);
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{}\n'), expected('path-check', 'OUTPUT_PATH'));
  assert.equal(await fs.readFile(other, 'utf8'), '{"old":true}\n');
  await fs.unlink(target);
  const linkedDirectory = join(root, 'linked-directory'); await fs.mkdir(linkedDirectory);
  // Windows junctions exercise genuine link refusal without requiring symlink privilege.
  await fs.symlink(linkedDirectory, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{}\n'), expected('path-check', 'OUTPUT_PATH'));
  assert.equal(await fs.readFile(other, 'utf8'), '{"old":true}\n');
  await fs.rm(target);
});
test('non-sharing access denial never retries or deletes the old destination', async t => {
  const { root, target } = await fixture(t); let attempts = 0;
  mockRename(t, async () => { attempts++; throw error('EACCES'); });
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{"new":true}\n'), expected('replace', 'EACCES'));
  assert.equal(attempts, 1); assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}\n');
  const pending = (await fs.readdir(root)).filter(name => name.startsWith('state-'));
  assert.equal(pending.length, 1); assert.equal(await fs.readFile(join(root, pending[0]!), 'utf8'), '{"new":true}\n');
});
test('write failure exposes only safe phase and errno, not filesystem paths', async t => {
  const { root, target } = await fixture(t), original = fs.open;
  fs.open = ((...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).startsWith(root) && String(args[0]).includes('state-')) return Promise.reject(error('ENOSPC'));
    return original(...args);
  }) as typeof fs.open; syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{}\n'), expected('write', 'ENOSPC'));
  assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}\n');
});
test('Windows sharing denial retries only the unchanged uncommitted metadata, bounded to four attempts', async t => {
  const { root, target } = await fixture(t); let attempts = 0;
  const original = mockRename(t, async (from, to) => { attempts++; if (attempts < 3) throw error('EPERM'); return original(from, to); });
  if (process.platform === 'win32') {
    await atomicAssetJson(root, 'index.json', '{"new":true}\n'); assert.equal(attempts, 3);
    assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}\n');
  } else {
    await assert.rejects(() => atomicAssetJson(root, 'index.json', '{"new":true}\n'), expected('replace', 'EPERM')); assert.equal(attempts, 1);
  }
});
test('permanent sharing denial preserves the old target and complete uncommitted snapshot', async t => {
  const { root, target } = await fixture(t); let attempts = 0;
  mockRename(t, async () => { attempts++; throw error('EBUSY'); });
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{"new":true}\n'), expected('replace', 'EBUSY'));
  assert.equal(attempts, process.platform === 'win32' ? 4 : 1);
  assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}\n');
  assert.equal((await fs.readdir(root)).filter(n => n.startsWith('state-')).length, 1);
});
test('changed destination forbids retry even when a failed sharing call is returned', async t => {
  const { root, target } = await fixture(t); let attempts = 0;
  mockRename(t, async () => { attempts++; await fs.writeFile(target, '{"external":true}\n'); throw error('EPERM'); });
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{"new":true}\n'), expected('replace', process.platform === 'win32' ? 'OUTPUT_PATH' : 'EPERM'));
  assert.equal(attempts, 1); assert.equal(await fs.readFile(target, 'utf8'), '{"external":true}\n');
});
test('ambiguous successful rename followed by an error cannot be replayed', async t => {
  const { root, target } = await fixture(t); let attempts = 0;
  const original = mockRename(t, async (from, to) => { attempts++; await original(from, to); throw error('EPERM'); });
  await assert.rejects(() => atomicAssetJson(root, 'index.json', '{"new":true}\n'), expected('replace', process.platform === 'win32' ? 'ENOENT' : 'EPERM'));
  assert.equal(attempts, 1); assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}\n');
  assert.deepEqual(await fs.readdir(root), ['index.json']);
});
test('changed physical output ancestor forbids replacement of a substituted directory', async t => {
  const { root, target } = await fixture(t), output = join(root, 'output'), saved = join(root, 'saved');
  await fs.mkdir(output); await fs.writeFile(join(output, 'index.json'), '{"old":true}\n'); let attempts = 0;
  const genuine = (await import('node:fs')).default.renameSync;
  mockRename(t, async () => {
    attempts++; genuine(output, saved); await fs.mkdir(output); await fs.writeFile(join(output, 'index.json'), '{"external":true}\n'); throw error('EBUSY');
  });
  await assert.rejects(() => atomicAssetJson(output, 'index.json', '{"new":true}\n'), expected('replace', process.platform === 'win32' ? 'OUTPUT_PATH' : 'EBUSY'));
  assert.equal(attempts, 1); assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), '{"external":true}\n');
  assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}\n');
});

test('empty existing advisory destination remains identity-pinned and safely replaceable', async t => {
  const { root, target } = await fixture(t);
  await fs.writeFile(target, '');
  await atomicAssetJson(root, 'index.json', '{"recovered":true}\n');
  assert.equal(await fs.readFile(target, 'utf8'), '{"recovered":true}\n');
  assert.deepEqual(await fs.readdir(root), ['index.json']);
});
