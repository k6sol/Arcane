import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep, basename } from 'node:path';
import { createWindowsInstallation, WindowsInstallationError } from '../../scripts/windows-installation.mjs';

// Actual filesystem and transaction engine. The small inventory verifier below is SCRIPTED:
// it checks fixture hashes, not Electron/Node PE headers, package provenance or dependencies.
// Separate package acceptance uses the production verifyWindowsBundle on the actual distribution.
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const boundary = await fs.realpath(tmpdir()), root = await fs.realpath(await fs.mkdtemp(join(boundary, 'arcane-install-test-')));
  t.after(async () => { const p = relative(boundary, root); assert.ok(p.startsWith('arcane-install-test-') && !isAbsolute(p) && !p.includes(sep)); await fs.rm(root, { recursive: true, force: true }); });
  const target = join(root, 'Arcane'), profile = join(root, 'profile'); await fs.mkdir(profile); await fs.writeFile(join(profile, 'project.txt'), 'user work');
  const makeBundle = async name => {
    const directory = join(root, name); await fs.mkdir(directory); await fs.mkdir(join(directory, 'resources/node'), { recursive: true });
    const files = [];
    for (const [path, text] of [['Arcane.exe', 'fixture ' + name], ['resources/node/node.exe', 'fixture node']]) {
      const bytes = Buffer.from(text); await fs.writeFile(join(directory, path), bytes); files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files };
    await fs.writeFile(join(directory, 'windows-manifest.json'), JSON.stringify(manifest)); return directory;
  };
  const verify = async directory => {
    const bytes = await fs.readFile(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(hash(await fs.readFile(join(directory, f.path))), f.sha256, 'fixture verifier hash ' + f.path);
    return { manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  };
  return { root, target, profile, makeBundle, verify, engine: createWindowsInstallation({ verifyBundle: verify }),
    record: () => fs.readFile(join(target, 'installation.json'), 'utf8'),
    profileText: () => fs.readFile(join(profile, 'project.txt'), 'utf8') };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('Windows installation reserves a launchable runtime path before any verification or target mutation', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), target = join(f.root, 'x'.repeat(150));
  let verifications = 0;
  const engine = createWindowsInstallation({ verifyBundle: async directory => { verifications++; return f.verify(directory); } });
  await assert.rejects(engine.install({ bundle, installRoot: target }), error => error.code === 'PATH_LENGTH' && error.published === false);
  assert.equal(verifications, 0);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.equal(await f.profileText(), 'user work');
});

test('first install publishes only a complete release; re-install is idempotent and profile data stays separate', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), result = await f.engine.install({ bundle, installRoot: f.target });
  assert.equal(result.state, 'installed'); assert.equal(result.previousReleaseId, null); assert.equal(result.launched, false); assert.equal(result.registration, false);
  assert.equal(await fs.readFile(join(result.releaseDirectory, 'Arcane.exe'), 'utf8'), 'fixture first');
  const status = await f.engine.status(f.target); assert.equal(status.activeReleaseId, result.activeReleaseId); assert.equal(status.integrityVerified, false);
  const record = await f.record(), repeated = await f.engine.install({ bundle, installRoot: f.target });
  assert.equal(repeated.state, 'already-active'); assert.equal(await f.record(), record);
  assert.equal((await fs.readdir(join(f.target, 'releases'))).length, 1); assert.equal(await f.profileText(), 'user work');
  await assert.rejects(fs.stat(join(f.target, 'installation.lock')), { code: 'ENOENT' });
});

test('an update retains the previous release until copied verification completes, then switches one record', async t => {
  const f = await fixture(t), first = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  await fs.writeFile(join(f.target, 'personal-note.txt'), 'keep'); const oldRecord = await f.record(), bundle = await f.makeBundle('second');
  const entered = deferred(), gate = deferred();
  const engine = createWindowsInstallation({ verifyBundle: async directory => { const proof = await f.verify(directory); if (directory !== bundle) { entered.resolve(); await gate.promise; } return proof; } });
  const pending = engine.install({ bundle, installRoot: f.target }); await entered.promise;
  assert.equal(await f.record(), oldRecord); assert.equal((await f.engine.status(f.target)).activeReleaseId, first.activeReleaseId);
  gate.resolve(); const next = await pending;
  assert.equal(next.previousReleaseId, first.activeReleaseId); assert.notEqual(next.activeReleaseId, first.activeReleaseId);
  assert.equal(await fs.readFile(join(first.releaseDirectory, 'Arcane.exe'), 'utf8'), 'fixture first');
  assert.equal(await fs.readFile(join(f.target, 'personal-note.txt'), 'utf8'), 'keep'); assert.equal(await f.profileText(), 'user work');
  assert.equal((await engine.status(f.target)).releases.length, 2);
});

test('failed copied verification leaves selection and prior files unchanged and retains the failed candidate', async t => {
  const f = await fixture(t); await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  const old = await f.record(), bundle = await f.makeBundle('second'), cause = new Error('scripted copied validation failure');
  const engine = createWindowsInstallation({ verifyBundle: async directory => { if (directory !== bundle) throw cause; return f.verify(directory); } });
  let failed;
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => { failed = error; return error instanceof WindowsInstallationError && error.cause === cause && error.published === false; });
  assert.equal(await f.record(), old); assert.ok(failed.stagingDirectory); assert.equal((await fs.readdir(failed.stagingDirectory)).length, 3);
  const next = await f.engine.install({ bundle, installRoot: f.target }); assert.equal(next.state, 'installed');
  assert.equal((await fs.readdir(join(f.target, 'releases'))).length, 3, 'the first failed candidate is retained, never replayed or deleted');
});

test('a concurrent installer refuses the held exclusive lock without replacing its bytes', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), entered = deferred(), gate = deferred();
  const engine = createWindowsInstallation({ verifyBundle: async directory => { const proof = await f.verify(directory); if (directory !== bundle) { entered.resolve(); await gate.promise; } return proof; } });
  const pending = engine.install({ bundle, installRoot: f.target }); await entered.promise;
  const lock = await fs.readFile(join(f.target, 'installation.lock'), 'utf8'), record = await f.record();
  await assert.rejects(f.engine.install({ bundle, installRoot: f.target }), error => error.code === 'LOCKED');
  assert.equal(await fs.readFile(join(f.target, 'installation.lock'), 'utf8'), lock); assert.equal(await f.record(), record);
  gate.resolve(); await pending;
});

test('a changed installation record is retained instead of being overwritten by the completed candidate', async t => {
  const f = await fixture(t); await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  const bundle = await f.makeBundle('second'), foreign = 'changed by another writer';
  const engine = createWindowsInstallation({ verifyBundle: async directory => { const proof = await f.verify(directory); if (directory !== bundle) await fs.writeFile(join(f.target, 'installation.json'), foreign); return proof; } });
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'CHANGED' && error.published === false);
  assert.equal(await f.record(), foreign);
});

test('a replaced lock is never removed, and cleanup retains the primary transaction error', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const proof = await f.verify(directory);
    if (directory !== bundle) { await fs.rename(join(f.target, 'installation.lock'), join(f.target, 'retained-original.lock')); await fs.writeFile(join(f.target, 'installation.lock'), 'foreign lock'); }
    return proof;
  } });
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'CHANGED' && error.cleanup?.state === 'retained');
  assert.equal(await fs.readFile(join(f.target, 'installation.lock'), 'utf8'), 'foreign lock');
  assert.equal(JSON.parse(await f.record()).activeReleaseId, null);
});

test('in-place lock edits are fenced and retained with the original transaction failure', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const proof = await f.verify(directory);
    if (directory !== bundle) await fs.writeFile(join(f.target, 'installation.lock'), 'foreign in-place contents');
    return proof;
  } });
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'CHANGED' && error.cleanup?.state === 'retained');
  assert.equal(await fs.readFile(join(f.target, 'installation.lock'), 'utf8'), 'foreign in-place contents');
  assert.equal(JSON.parse(await f.record()).activeReleaseId, null);
});

test('unowned populated directories, source overlap and invalid source bundles have no target mutation', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  await fs.mkdir(f.target); await fs.writeFile(join(f.target, 'notes.txt'), 'user data');
  await assert.rejects(f.engine.install({ bundle, installRoot: f.target }), error => error.code === 'UNOWNED');
  assert.deepEqual(await fs.readdir(f.target), ['notes.txt']);
  await assert.rejects(f.engine.install({ bundle, installRoot: join(bundle, 'inside') }), error => error.code === 'OVERLAP');
  const invalid = createWindowsInstallation({ verifyBundle: async () => { throw new Error('invalid source'); } });
  const absent = join(f.root, 'new-install'); await assert.rejects(invalid.install({ bundle, installRoot: absent }), /invalid source/);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});

test('redirected destination ancestors and hardlinked source files are refused without publishing', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), outside = join(f.root, 'outside'), link = join(f.root, 'redirect');
  await fs.mkdir(outside); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.engine.install({ bundle, installRoot: join(link, 'Arcane') }), error => error.code === 'REDIRECT');
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.link(join(bundle, 'Arcane.exe'), join(f.root, 'original-hardlink'));
  await assert.rejects(f.engine.install({ bundle, installRoot: f.target }), error => error.code === 'PATH');
  assert.equal(JSON.parse(await f.record()).activeReleaseId, null);
});

test('unsafe manifest paths and case collisions are refused before an installation root is claimed', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), original = JSON.parse(await fs.readFile(join(bundle, 'windows-manifest.json'), 'utf8'));
  for (const path of ['../escape', '/absolute', 'stream:ads', 'CON', 'trailing.', 'back\\slash', 'windows-manifest.json']) {
    const manifest = structuredClone(original); manifest.files[0].path = path;
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(join(bundle, 'windows-manifest.json'), bytes);
    const engine = createWindowsInstallation({ verifyBundle: async () => ({ manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes }) });
    await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'MANIFEST', path);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  }
  const collision = structuredClone(original); collision.files.push({ ...collision.files[0], path: 'arcane.EXE' }); collision.fileCount++; collision.totalBytes += collision.files[0].bytes;
  const bytes = Buffer.from(JSON.stringify(collision)); await fs.writeFile(join(bundle, 'windows-manifest.json'), bytes);
  const engine = createWindowsInstallation({ verifyBundle: async () => ({ manifestSha256: hash(bytes), files: collision.fileCount, bytes: collision.totalBytes }) });
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'MANIFEST');
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('changes to copied files after verification are fenced before publication', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const engine = createWindowsInstallation({ verifyBundle: async directory => { const proof = await f.verify(directory); if (directory !== bundle) await fs.writeFile(join(directory, 'Arcane.exe'), 'replaced after verification'); return proof; } });
  await assert.rejects(engine.install({ bundle, installRoot: f.target }), error => error.code === 'CHANGED');
  assert.equal(JSON.parse(await f.record()).activeReleaseId, null);
});

test('cancellation before admission creates nothing; cancellation during copy keeps the previous release', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), early = new AbortController(); early.abort();
  await assert.rejects(f.engine.install({ bundle, installRoot: f.target, signal: early.signal }), error => error.code === 'CANCELLED');
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const first = await f.engine.install({ bundle, installRoot: f.target }), before = await f.record(), nextBundle = await f.makeBundle('second');
  const controller = new AbortController(), events = [];
  await assert.rejects(f.engine.install({ bundle: nextBundle, installRoot: f.target, signal: controller.signal, onProgress: event => {
    events.push(event); if (event.phase === 'copying' && event.filesCopied === 1) controller.abort();
  } }), error => error.code === 'CANCELLED' && error.published === false);
  assert.equal(await f.record(), before); assert.equal((await f.engine.status(f.target)).activeReleaseId, first.activeReleaseId);
  assert.ok(events.every(Object.isFrozen)); assert.equal(events.filter(e => e.filesCopied > 1).length, 0);
  await assert.rejects(fs.stat(join(f.target, 'installation.lock')), { code: 'ENOENT' });
});

test('a cancellation at the publishing boundary refuses before pointer replacement; completed publication stays installed', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), first = await f.engine.install({ bundle, installRoot: f.target }), nextBundle = await f.makeBundle('second');
  const before = await f.record(), controller = new AbortController();
  await assert.rejects(f.engine.install({ bundle: nextBundle, installRoot: f.target, signal: controller.signal,
    onProgress: event => { if (event.phase === 'publishing') controller.abort(); } }), error => error.code === 'CANCELLED' && error.published === false);
  assert.equal(await f.record(), before);
  const after = new AbortController(), installed = await f.engine.install({ bundle: nextBundle, installRoot: f.target, signal: after.signal,
    onProgress: event => { if (event.phase === 'installed') after.abort(); } });
  assert.equal(installed.state, 'installed'); assert.equal(installed.previousReleaseId, first.activeReleaseId);
  assert.equal((await f.engine.status(f.target)).activeReleaseId, installed.activeReleaseId);
});

// Same-setup recovery: a recorded release whose ENTIRE directory is genuinely absent (for example after a partial uninstall
// removed it) is repaired from the fully verified bundle into a NEW exclusive id that replaces only that record entry.
const releasePath = (f, id) => join(f.target, 'releases', id);
const absentAt = async path => { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }); };
test('a same-source install repairs an entirely absent active release into a new id, preserving the installation id', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), first = await f.engine.install({ bundle, installRoot: f.target });
  const before = JSON.parse(await f.record()); await fs.rm(releasePath(f, first.activeReleaseId), { recursive: true });
  const repaired = await f.engine.install({ bundle, installRoot: f.target });
  assert.equal(repaired.state, 'installed'); assert.equal(repaired.repairedReleaseId, first.activeReleaseId); assert.equal(repaired.previousReleaseId, first.activeReleaseId);
  assert.notEqual(repaired.activeReleaseId, first.activeReleaseId); assert.ok(repaired.activeReleaseId.startsWith(first.manifestSha256 + '-'));
  const after = JSON.parse(await f.record());
  assert.equal(after.installationId, before.installationId); assert.equal(after.activeReleaseId, repaired.activeReleaseId); assert.equal(after.releases.length, 1);
  const [entry] = after.releases, [old] = before.releases;
  assert.deepEqual([entry.version, entry.manifestSha256, entry.files, entry.bytes], [old.version, old.manifestSha256, old.files, old.bytes]);
  assert.equal(hash(await fs.readFile(join(repaired.releaseDirectory, 'Arcane.exe'))), hash('fixture first'), 'actual copied bytes');
  await absentAt(releasePath(f, first.activeReleaseId)); assert.equal(await f.profileText(), 'user work');
  await assert.rejects(fs.stat(join(f.target, 'installation.lock')), { code: 'ENOENT' });
  const again = await f.engine.install({ bundle, installRoot: f.target });
  assert.deepEqual([again.state, again.repairedReleaseId], ['already-active', null], 'the repaired release is now ordinary');
});

test('a retained absent release is replaced in its own slot; unrelated entries and files stay byte-identical', async t => {
  const f = await fixture(t), a = await f.makeBundle('first'), b = await f.makeBundle('second');
  const first = await f.engine.install({ bundle: a, installRoot: f.target }), second = await f.engine.install({ bundle: b, installRoot: f.target });
  const before = JSON.parse(await f.record()), secondFile = await fs.readFile(join(second.releaseDirectory, 'Arcane.exe'));
  await fs.rm(releasePath(f, first.activeReleaseId), { recursive: true });
  const repaired = await f.engine.install({ bundle: a, installRoot: f.target });
  assert.deepEqual([repaired.state, repaired.repairedReleaseId, repaired.previousReleaseId], ['installed', first.activeReleaseId, second.activeReleaseId]);
  const after = JSON.parse(await f.record());
  assert.equal(after.installationId, before.installationId); assert.equal(after.activeReleaseId, repaired.activeReleaseId);
  assert.deepEqual(after.releases.map(r => r.id), [repaired.activeReleaseId, second.activeReleaseId], 'only the absent slot was replaced, in place');
  assert.deepEqual(after.releases[1], before.releases[1]); assert.deepEqual(await fs.readFile(join(second.releaseDirectory, 'Arcane.exe')), secondFile);
});

test('replacing one absent slot works with 32 recorded releases and does not raise the retention limit', async t => {
  const f = await fixture(t), bundles = [], results = [];
  for (let i = 0; i < 32; i++) { bundles.push(await f.makeBundle('r' + i)); results.push(await f.engine.install({ bundle: bundles[i], installRoot: f.target })); }
  await fs.rm(releasePath(f, results[5].activeReleaseId), { recursive: true });
  const repaired = await f.engine.install({ bundle: bundles[5], installRoot: f.target }), after = JSON.parse(await f.record());
  assert.equal(repaired.repairedReleaseId, results[5].activeReleaseId); assert.equal(after.releases.length, 32); assert.equal(after.releases[5].id, repaired.activeReleaseId);
  await assert.rejects(f.engine.install({ bundle: await f.makeBundle('r32'), installRoot: f.target }), error => error.code === 'RETENTION');
});

test('present, partial, changed, file and redirected release targets keep their existing refusals and stay untouched', async t => {
  const cases = [
    ['partial', async dir => fs.rm(join(dir, 'resources'), { recursive: true }), 'IO'],
    ['changed', async dir => fs.writeFile(join(dir, 'Arcane.exe'), 'changed bytes'), 'IO'],
    ['file', async dir => { await fs.rm(dir, { recursive: true }); await fs.writeFile(dir, 'not a release'); }, 'PATH'],
    ...(process.platform === 'win32' ? [['redirect', async (dir, f) => { await fs.rm(dir, { recursive: true }); const away = join(f.root, 'away'); await fs.mkdir(away); await fs.symlink(away, dir, 'junction'); }, 'REDIRECT']] : []),
  ];
  for (const [name, mutate, code] of cases) {
    const f = await fixture(t), bundle = await f.makeBundle('first'), first = await f.engine.install({ bundle, installRoot: f.target });
    await mutate(releasePath(f, first.activeReleaseId), f); const record = await f.record(), entries = (await fs.readdir(join(f.target, 'releases'))).sort();
    await assert.rejects(f.engine.install({ bundle, installRoot: f.target }), error => error.code === code && error.published === false, name);
    assert.equal(await f.record(), record, name); assert.deepEqual((await fs.readdir(join(f.target, 'releases'))).sort(), entries, name + ': no candidate created');
  }
});

test('an absent release path that appears before publication is refused and kept; candidate failure keeps the original record', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), first = await f.engine.install({ bundle, installRoot: f.target }), old = releasePath(f, first.activeReleaseId);
  await fs.rm(old, { recursive: true }); const record = await f.record();
  let appeared = false;
  await assert.rejects(f.engine.install({ bundle, installRoot: f.target, onProgress: event => { if (event.phase === 'publishing' && !appeared) { appeared = true; fsSync.mkdirSync(old); fsSync.writeFileSync(join(old, 'manual.txt'), 'manual'); } } }),
    error => error.code === 'RELEASE_CHANGED' && error.published === false && typeof error.stagingDirectory === 'string');
  assert.equal(await f.record(), record); assert.deepEqual(await fs.readdir(old), ['manual.txt'], 'the appeared path is never cleaned or adopted');
  const f2 = await fixture(t), first2 = await f2.engine.install({ bundle: await f2.makeBundle('first'), installRoot: f2.target });
  await fs.rm(releasePath(f2, first2.activeReleaseId), { recursive: true }); const record2 = await f2.record();
  const failing = createWindowsInstallation({ verifyBundle: async directory => { if (directory.includes(join(f2.target, 'releases'))) throw new Error('fixture candidate verification refused'); return f2.verify(directory); } });
  await assert.rejects(failing.install({ bundle: join(f2.root, 'first'), installRoot: f2.target }), error => error.published === false);
  assert.equal(await f2.record(), record2); await absentAt(releasePath(f2, first2.activeReleaseId));
  await fs.rm(join(f2.target, 'releases'), { recursive: true });
  await assert.rejects(f2.engine.install({ bundle: join(f2.root, 'first'), installRoot: f2.target }), error => error.code === 'RELEASE_MISSING', 'a missing releases container stays out of scope');
});

test('repair rechecks the releases parent after the final child absence observation', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const first = await f.engine.install({ bundle, installRoot: f.target });
  const releases = join(f.target, 'releases'), old = releasePath(f, first.activeReleaseId), movedParent = join(f.target, 'releases-moved');
  await fs.rm(old, { recursive: true }); const record = await f.record();
  const originalLstat = fsPromises.lstat;
  let armed = false, moved = false, failure;
  // A test-owned wrapper exposes the exact namespace change inside the final awaited observation.
  // No engine seam or timing race; the builtin binding is restored before any other test runs.
  fsPromises.lstat = async function (path, ...options) {
    if (armed && !moved && String(path) === old) { fsSync.renameSync(releases, movedParent); moved = true; }
    return originalLstat.call(this, path, ...options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.engine.install({ bundle, installRoot: f.target, onProgress: event => { if (event.phase === 'publishing') armed = true; } }), error => {
      failure = error;
      return error.code === 'IO' && error.published === false && typeof error.stagingDirectory === 'string';
    });
  } finally { fsPromises.lstat = originalLstat; syncBuiltinESMExports(); }
  assert.equal(moved, true); assert.equal(await f.record(), record, 'no pointer is published into the vanished parent');
  await absentAt(releases);
  await f.verify(join(movedParent, basename(failure.stagingDirectory))); // The verified candidate is retained, not adopted or deleted.
  assert.equal(await f.profileText(), 'user work');
});
