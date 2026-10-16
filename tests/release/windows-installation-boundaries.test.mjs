import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation, WindowsInstallationError } from '../../scripts/windows-installation.mjs';

// Boundary cases for the ACTUAL installation engine on a real owned temporary filesystem. The inventory verifier
// below is SCRIPTED (fixture hashes plus unlisted-file rejection, mirroring the production rule); it is not PE,
// dependency, provenance or application acceptance. No user folders, registry, shortcuts or native processes.
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const boundary = await fs.realpath(tmpdir()), root = await fs.realpath(await fs.mkdtemp(join(boundary, 'arcane-install-boundary-')));
  t.after(async () => { const p = relative(boundary, root); assert.ok(p.startsWith('arcane-install-boundary-') && !isAbsolute(p) && !p.includes(sep)); await fs.rm(root, { recursive: true, force: true }); });
  const target = join(root, 'Arcane');
  const makeBundle = async (name, entries = [['Arcane.exe', 'fixture ' + name], ['resources/node/node.exe', 'fixture node']]) => {
    const directory = join(root, name); await fs.mkdir(directory);
    const files = [];
    for (const [path, text] of entries) {
      const full = join(directory, ...path.split('/')); await fs.mkdir(join(full, '..'), { recursive: true });
      const bytes = Buffer.from(text); if (text !== null) await fs.writeFile(full, bytes); files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files };
    await fs.writeFile(join(directory, 'windows-manifest.json'), JSON.stringify(manifest)); return directory;
  };
  /** SCRIPTED verifier: listed hashes plus no unlisted files (case-insensitive), like the production rule. */
  const verify = async directory => {
    const bytes = await fs.readFile(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes), listed = new Set(manifest.files.map(f => f.path.toLowerCase()));
    for (const f of manifest.files) if (hash(await fs.readFile(join(directory, ...f.path.split('/')))) !== f.sha256) throw new Error('fixture hash ' + f.path);
    for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (path !== 'windows-manifest.json' && !listed.has(path.toLowerCase())) throw new Error('fixture unlisted ' + path);
    }
    return { manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  };
  const tree = async directory => { try { return (await fs.readdir(directory, { recursive: true })).map(p => p.split(sep).join('/')).sort(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  return { root, target, makeBundle, verify, tree, engine: createWindowsInstallation({ verifyBundle: verify }),
    record: () => fs.readFile(join(target, 'installation.json'), 'utf8').catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)) };
}
const code = name => error => error instanceof WindowsInstallationError && error.code === name;
/** Engine whose verifier runs `after(directory)` once the STAGED copy has been verified (the post-verification window). */
const afterStagedVerification = (f, bundle, after) => createWindowsInstallation({ verifyBundle: async directory => {
  const proof = await f.verify(directory); if (directory !== bundle && !directory.endsWith(sep + 'releases')) await after(directory); return proof; } });

test('invalid installation records refuse before any mutation and leave the record, lock and releases untouched', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('b'); await f.engine.install({ bundle, installRoot: f.target });
  const valid = JSON.parse(await f.record()), id = valid.activeReleaseId;
  for (const [what, value] of [['extra key', { ...valid, extra: 1 }], ['dangling active', { ...valid, activeReleaseId: id.slice(0, 65) + '00000000-0000-4000-8000-000000000000' }],
    ['duplicate release', { ...valid, releases: [...valid.releases, valid.releases[0]] }], ['bad version', { ...valid, releases: [{ ...valid.releases[0], version: '1.0' }] }],
    ['id/manifest mismatch', { ...valid, releases: [{ ...valid.releases[0], manifestSha256: 'f'.repeat(64) }] }], ['array record', []], ['non-JSON', null]]) {
    const text = value === null ? '{' : JSON.stringify(value) + '\n'; await fs.writeFile(join(f.target, 'installation.json'), text);
    const before = await f.tree(f.target);
    await assert.rejects(f.engine.install({ bundle: await f.makeBundle('again-' + what.replace(/\W/g, '')), installRoot: f.target }), e => e instanceof WindowsInstallationError, what);
    assert.deepEqual(await f.tree(f.target), before, what + ': no release, stage or lock left'); assert.equal(await f.record(), text, what + ': record untouched');
    await assert.rejects(f.engine.status(f.target), e => e instanceof WindowsInstallationError, what + ': status refuses too');
  }
});

test('an altered existing release is never re-selected; the record stays on its previous value', async t => {
  const f = await fixture(t), first = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  const secondBundle = await f.makeBundle('second'), second = await f.engine.install({ bundle: secondBundle, installRoot: f.target });
  await fs.writeFile(join(first.releaseDirectory, 'Arcane.exe'), 'tampered'); const before = await f.record();
  await assert.rejects(f.engine.install({ bundle: join(f.root, 'first'), installRoot: f.target }), e => e instanceof WindowsInstallationError, 'tampered retained release refused');
  assert.equal(await f.record(), before); assert.equal(JSON.parse(before).activeReleaseId, second.activeReleaseId);
  await assert.rejects(fs.stat(join(f.target, 'installation.lock')), { code: 'ENOENT' });
});

test('a failed staged copy retains its stage and the previous pointer; a later install uses a fresh stage and never adopts the orphan', async t => {
  const f = await fixture(t), first = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target }), before = await f.record();
  const bundle = await f.makeBundle('second');
  const failing = createWindowsInstallation({ verifyBundle: async directory => { if (directory !== bundle) throw new Error('scripted staged verification failure'); return f.verify(directory); } });
  let staged;
  await assert.rejects(failing.install({ bundle, installRoot: f.target }), error => { staged = error.stagingDirectory; return error instanceof WindowsInstallationError && error.published === false; });
  assert.ok(staged && (await fs.stat(staged)).isDirectory(), 'failed stage retained'); assert.equal(await f.record(), before, 'pointer unchanged');
  const next = await f.engine.install({ bundle, installRoot: f.target });
  assert.notEqual(next.releaseDirectory, staged, 'fresh stage'); assert.equal(next.previousReleaseId, first.activeReleaseId);
  assert.ok((await fs.stat(staged)).isDirectory(), 'orphan stage still retained, not adopted or deleted');
  assert.ok(!JSON.parse(await f.record()).releases.some(r => staged.endsWith(r.id)), 'orphan never recorded');
});

test('nested replacement after copied verification (directory or same-bytes file) is CHANGED; nothing is published', async t => {
  for (const [what, mutate] of [
    ['nested directory replaced', async stage => { await fs.rename(join(stage, 'resources', 'node'), join(stage, 'resources', 'node-moved')); await fs.mkdir(join(stage, 'resources', 'node'));
      await fs.copyFile(join(stage, 'resources', 'node-moved', 'node.exe'), join(stage, 'resources', 'node', 'node.exe')); await fs.rm(join(stage, 'resources', 'node-moved'), { recursive: true }); }],
    ['file replaced with identical bytes', async stage => { const p = join(stage, 'Arcane.exe'), bytes = await fs.readFile(p); await fs.unlink(p); await fs.writeFile(p, bytes); }]]) {
    const f = await fixture(t), first = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target }), before = await f.record(), bundle = await f.makeBundle('second');
    await assert.rejects(afterStagedVerification(f, bundle, mutate).install({ bundle, installRoot: f.target }), error => error instanceof WindowsInstallationError && error.code === 'CHANGED' && error.published === false, what);
    assert.equal(await f.record(), before, what + ': pointer unchanged'); assert.equal(JSON.parse(before).activeReleaseId, first.activeReleaseId);
  }
});

test('an unlisted file added after copied verification prevents publication', async t => {
  const f = await fixture(t); await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target }); const before = await f.record(), bundle = await f.makeBundle('second');
  const engine = afterStagedVerification(f, bundle, stage => fs.writeFile(join(stage, 'resources', 'node', 'unverified.dll'), 'planted after verification'));
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), code('CHANGED'), 'an unlisted post-verification file must refuse publication');
  assert.equal(await f.record(), before);
});

test('unlisted entries added to a retained release after verification prevent reactivation', async t => {
  const f = await fixture(t), firstBundle = await f.makeBundle('first'), first = await f.engine.install({ bundle: firstBundle, installRoot: f.target });
  const second = await f.engine.install({ bundle: await f.makeBundle('second'), installRoot: f.target }), before = await f.record();
  const engine = afterStagedVerification(f, firstBundle, directory => fs.mkdir(join(directory, 'unexpected-directory')));
  await assert.rejects(engine.install({ bundle: firstBundle, installRoot: f.target }), code('CHANGED'));
  assert.equal(await f.record(), before); assert.equal(JSON.parse(before).activeReleaseId, second.activeReleaseId);
  assert.notEqual(first.activeReleaseId, second.activeReleaseId);
});
