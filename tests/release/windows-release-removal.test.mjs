import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/ReleaseRemoval.cs with its read-only dependencies (InstalledRecord, OperationLease,
// PayloadArchive, InstallationActivity, SetupPath) via the in-box csc.exe into a SEPARATE owned op-script harness that holds
// one lease across steps. Roots come from the ACTUAL engine with a labelled SCRIPTED verifier; each release's Arcane.exe
// is a tiny OWNED console peer (only started for the Busy case, with private ready/exit and actual exit awaited).
// No real Arcane, providers, Studio, user folders, registry, Start Menu, global process queries or termination. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PEER = tag => String.raw`using System; internal static class Peer { private static int Main() { Console.WriteLine("ready ${tag}"); Console.Out.Flush(); Console.In.ReadLine(); return 0; } }`;
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  static int Main(string[] a) {
    string root = a[0]; InstalledRecordSnapshot snapshot = null; OperationLease lease = null, other = null;
    for (int i = 1; i < a.Length; i++) {
      string op = a[i]; Dictionary<string, object> v = new Dictionary<string, object>(); v["op"] = op;
      switch (op) {
        case "snapshot": snapshot = InstalledRecord.Read(root); v["active"] = snapshot.ActiveReleaseId; break;
        case "acquire": { LeaseResult r = OperationLease.Acquire(snapshot); lease = r.Lease; v["state"] = r.State.ToString(); break; }
        case "acquire-other": { LeaseResult r = OperationLease.Acquire(InstalledRecord.Read(a[++i])); other = r.Lease; v["state"] = r.State.ToString(); break; }
        case "release": v["state"] = lease.Release().State.ToString(); break;
        case "barrier": ReleaseRemoval.Barrier = delegate(string stage) { Dictionary<string, object> b = new Dictionary<string, object>(); b["op"] = "wait"; b["stage"] = stage; Out(b); Console.In.ReadLine(); }; continue;
        case "throw-at": { string interrupted = a[++i]; ReleaseRemoval.Barrier = delegate(string stage) { if (stage == interrupted) throw new System.IO.IOException("Owned fixture interruption."); }; continue; }
        case "wait": Out(v); Console.In.ReadLine(); continue;
        case "remove": case "remove-no-lease": case "remove-other-lease": {
          string id = a[++i]; ReleaseRemovalResult r = ReleaseRemoval.Remove(snapshot, id, op == "remove" ? lease : op == "remove-other-lease" ? other : null);
          v["state"] = r.State.ToString(); v["code"] = r.Code; v["executable"] = r.Executable.ToString(); v["listed"] = r.FilesListed; v["deleted"] = r.FilesDeleted;
          v["absent"] = r.FilesAbsent; v["kept"] = r.FilesKept; v["dirsDeleted"] = r.DirectoriesDeleted; v["dirsKept"] = r.DirectoriesKept;
          v["manifestDeleted"] = r.ManifestDeleted; v["releaseDeleted"] = r.ReleaseDirectoryDeleted; break; }
      }
      Out(v);
    }
    if (lease != null && lease.Live) lease.Release(); if (other != null && other.Live) other.Release();
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-release-removal-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-release-removal-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['ReleaseRemoval.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs', 'InstallationActivity.cs', 'SetupPath.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const compile = (out, files, extra = []) => { const r = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + out, ...extra, ...files], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'csc failed: ' + r.stdout + r.stderr); return out; };
  const harness = compile(join(build, 'harness.exe'), [...sources, 'Harness.cs'].map(f => join(build, f)), ['/main:Harness', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll']);
  const peers = {};
  for (const tag of ['A', 'B']) { fs.writeFileSync(join(build, 'Peer' + tag + '.cs'), PEER(tag)); peers[tag] = fs.readFileSync(compile(join(build, 'peer' + tag + '.exe'), [join(build, 'Peer' + tag + '.cs')])); }
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine copies, records and selects releases.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(sha(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = (tag, extra = []) => {
    const dir = owned('bundle'); const files = [];
    for (const [path, bytes] of [['Arcane.exe', peers[tag]], ['resources/node/node.exe', Buffer.from('fixture node ' + tag)], ['resources/data/notes.txt', Buffer.from('data ' + tag)], ['LICENSE.txt', Buffer.from('license ' + tag)], ...extra]) {
      fs.mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true }); fs.writeFileSync(join(dir, path), bytes); files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
    }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  /** Two recorded releases (A retained, B active), a manual root file and an owned profile folder outside the root. */
  const installed = async (extra = []) => {
    const target = join(owned('install'), 'Arcane');
    await engine.install({ bundle: bundle('A', extra), installRoot: target }); await engine.install({ bundle: bundle('B'), installRoot: target });
    fs.writeFileSync(join(target, 'manual-note.txt'), 'user note');
    const profile = owned('profile'); fs.writeFileSync(join(profile, 'project.txt'), 'user work');
    const record = JSON.parse(fs.readFileSync(join(target, 'installation.json'), 'utf8'));
    return { target, profile, record, active: record.activeReleaseId, retained: record.releases.find(r => r.id !== record.activeReleaseId).id };
  };
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '', chain = Promise.resolve(), actionError;
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); rows.push(row); if (row.op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(() => action(row)).catch(error => { actionError ??= error; }).then(() => child.stdin.write('go\n')); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => chain.then(() => { child.stdin.destroy(); if (actionError) reject(actionError); else if (err || code !== 0) reject(new Error('harness ' + code + ' ' + err)); else resolve(rows.filter(r => r.op !== 'wait')); }));
  });
  const removal = (rows) => rows.find(r => r.op.startsWith('remove'));
  shared = { root, owned, engine, bundle, installed, run, removal, peers };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const tree = dir => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isSymbolicLink()) out[relative(dir, p)] = 'link'; else if (e.isDirectory()) walk(p); else out[relative(dir, p)] = sha(fs.readFileSync(p)); } }; if (exists(dir)) walk(dir); return out; };
const pick = (r, keys) => keys.map(k => r[k]);
const KEYS = ['state', 'code', 'executable', 'listed', 'deleted', 'absent', 'kept', 'dirsDeleted', 'dirsKept', 'manifestDeleted', 'releaseDeleted'];

test('a recorded release is removed completely while the other release, record, root files and profile stay untouched', windows, async () => {
  const s = setup(), f = await s.installed(), record = fs.readFileSync(join(f.target, 'installation.json'));
  const other = tree(join(f.target, 'releases', f.active)), profile = tree(f.profile);
  let rows = await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained, 'wait'], [() => assert.equal(exists(join(f.target, 'installation.lock')), true, 'the lease is still held after removal')]);
  assert.deepEqual(pick(s.removal(rows), KEYS), ['Removed', null, 'Deleted', 4, 4, 0, 0, 3, 0, true, true]);
  assert.equal(exists(join(f.target, 'releases', f.retained)), false);
  assert.deepEqual(tree(join(f.target, 'releases', f.active)), other); assert.deepEqual(tree(f.profile), profile);
  assert.deepEqual(fs.readFileSync(join(f.target, 'installation.json')), record, 'installation.json is never edited');
  assert.equal(fs.readFileSync(join(f.target, 'manual-note.txt'), 'utf8'), 'user note');
  rows = await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]);
  assert.deepEqual(pick(s.removal(rows), ['state', 'code', 'deleted']), ['Absent', null, 0], 'an already removed release is reported Absent, nothing adopted');
});

test('a changed, linked or redirected launch target stops removal before any other file is touched', windows, async () => {
  const s = setup();
  for (const [code, mutate] of [['EXECUTABLE_CHANGED', p => { const b = fs.readFileSync(p); b[b.length >> 1] ^= 0xff; fs.writeFileSync(p, b); }],
    ['EXECUTABLE_CHANGED', p => fs.linkSync(p, join(s.owned('outside'), 'linked.exe'))],
    ['REDIRECT', p => { fs.unlinkSync(p); fs.symlinkSync(s.owned('away'), p, 'junction'); }]]) {
    const f = await s.installed(), dir = join(f.target, 'releases', f.retained); mutate(join(dir, 'Arcane.exe')); const before = tree(dir);
    const r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
    assert.deepEqual(pick(r, ['state', 'code', 'executable', 'deleted', 'manifestDeleted']), ['Retained', code, 'Kept', 0, false], code);
    assert.deepEqual(tree(dir), before, 'no other release file was deleted');
  }
});

test('known activity on the release executable retains everything until the owned peer has actually exited', windows, async () => {
  const s = setup(), f = await s.installed(), dir = join(f.target, 'releases', f.retained), before = tree(dir);
  const peer = spawn(join(dir, 'Arcane.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { let out = ''; peer.on('error', reject); peer.stdout.on('data', d => { out += d; if (out.includes('ready')) resolve(); }); });
  let r;
  try { r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained])); }
  finally { await new Promise(resolve => { peer.once('exit', resolve); peer.stdin.end('exit\n'); }); }
  assert.deepEqual(pick(r, ['state', 'code', 'executable', 'deleted']), ['Retained', 'BUSY', 'NotReached', 0]); assert.deepEqual(tree(dir), before);
  r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(r, ['state', 'executable']), ['Removed', 'Deleted'], 'after the actual exit');
});

test('changed listed files and unknown content keep the manifest and their directories; counters stay partial', windows, async () => {
  const s = setup();
  let f = await s.installed(), dir = join(f.target, 'releases', f.retained);
  fs.writeFileSync(join(dir, 'resources', 'data', 'manual.txt'), 'unknown user content');
  let r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(r, KEYS), ['Partial', null, 'Deleted', 4, 4, 0, 0, 1, 2, false, false]);
  assert.deepEqual(Object.keys(tree(dir)).sort(), ['resources\\data\\manual.txt', 'windows-manifest.json'], 'unknown content and the manifest are retained');
  f = await s.installed(); dir = join(f.target, 'releases', f.retained);
  fs.writeFileSync(join(dir, 'LICENSE.txt'), 'edited by hand');
  r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(r, ['state', 'executable', 'deleted', 'kept', 'manifestDeleted', 'releaseDeleted']), ['Partial', 'Deleted', 3, 1, false, false]);
  assert.equal(fs.readFileSync(join(dir, 'LICENSE.txt'), 'utf8'), 'edited by hand');
});

test('missing, foreign or released leases, unknown releases, malicious inventories and record changes are refused or fenced', windows, async () => {
  const s = setup();
  let f = await s.installed(); const second = await s.installed(); const before = tree(join(f.target, 'releases'));
  let rows = await s.run(f.target, ['snapshot', 'acquire', 'remove-no-lease', f.retained, 'acquire-other', second.target, 'remove-other-lease', f.retained, 'remove', 'a'.repeat(64) + '-' + f.record.installationId, 'release', 'remove', f.retained]);
  assert.deepEqual(rows.filter(r => r.op.startsWith('remove')).map(r => [r.op, r.state, r.code]), [
    ['remove-no-lease', 'Refused', 'LEASE'], ['remove-other-lease', 'Refused', 'LEASE'], ['remove', 'Refused', 'RECORD'], ['remove', 'Refused', 'LEASE']]);
  assert.deepEqual(tree(join(f.target, 'releases')), before, 'nothing was deleted');
  // A junctioned releases parent is never followed, not even to report Absent; the moved real tree stays intact.
  f = await s.installed(); const moved = join(s.owned('moved'), 'releases'), releasesDir = join(f.target, 'releases');
  fs.renameSync(releasesDir, moved); fs.symlinkSync(moved, releasesDir, 'junction'); const movedBefore = tree(moved);
  rows = await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]);
  assert.deepEqual(pick(s.removal(rows), ['state', 'code', 'deleted']), ['Retained', 'REDIRECT', 0]); assert.deepEqual(tree(moved), movedBefore);
  // A record replaced (same bytes, new identity) after the launch target is removed fences every later mutation.
  f = await s.installed(); const dir = join(f.target, 'releases', f.retained);
  rows = await s.run(f.target, ['snapshot', 'acquire', 'barrier', 'remove', f.retained], [() => {}, () => {
    const p = join(f.target, 'installation.json'), bytes = fs.readFileSync(p); fs.renameSync(p, p + '.old'); fs.writeFileSync(p, bytes); }]);
  assert.deepEqual(pick(s.removal(rows), ['state', 'code', 'executable', 'deleted', 'kept']), ['Partial', 'LEASE', 'Deleted', 1, 0]);
  assert.deepEqual(Object.keys(tree(dir)).sort(), ['LICENSE.txt', 'resources\\data\\notes.txt', 'resources\\node\\node.exe', 'windows-manifest.json']);
  // Malicious but hash-consistent inventories are refused before anything is touched.
  for (const mutate of [m => m.files.push({ path: 'resources', bytes: 0, sha256: sha('') }), m => m.files.push({ path: 'Resources/extra.txt', bytes: 0, sha256: sha('') }),
    m => { m.files.find(file => file.path === 'Arcane.exe').path = 'arcane.exe'; }]) {
    f = await s.installed(); const recordPath = join(f.target, 'installation.json'), record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const entry = record.releases.find(r => r.id === f.retained), oldDir = join(f.target, 'releases', entry.id);
    const manifest = JSON.parse(fs.readFileSync(join(oldDir, 'windows-manifest.json'), 'utf8')); mutate(manifest); manifest.fileCount = manifest.files.length;
    const bytes = Buffer.from(JSON.stringify(manifest)), id = sha(bytes) + '-' + entry.id.slice(65);
    fs.writeFileSync(join(oldDir, 'windows-manifest.json'), bytes); fs.renameSync(oldDir, join(f.target, 'releases', id));
    Object.assign(entry, { id, manifestSha256: sha(bytes), files: manifest.fileCount }); fs.writeFileSync(recordPath, JSON.stringify(record) + '\n');
    const kept = tree(join(f.target, 'releases', id));
    const r = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', id]));
    assert.deepEqual(pick(r, ['state', 'code', 'deleted']), ['Refused', 'MANIFEST', 0]); assert.deepEqual(tree(join(f.target, 'releases', id)), kept);
  }
});

test('the releases namespace remains pinned during removal', windows, async t => {
  const s = setup(), f = await s.installed(), releases = join(f.target, 'releases'), moved = join(s.owned('moved-parent'), 'releases');
  for (const path of [releases, moved]) {
    const child = relative(s.root, path); assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
  }
  let blocked = false;
  const rows = await s.run(f.target, ['snapshot', 'acquire', 'barrier', 'remove', f.retained], [() => {
    try { fs.renameSync(releases, moved); }
    catch (error) { assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(error.code), error.message); blocked = true; }
    if (!blocked) fs.cpSync(moved, releases, { recursive: true, errorOnExist: true, force: false });
  }]);
  t.diagnostic('Observed releases-parent rename ' + (blocked ? 'blocked' : 'accepted'));
  assert.equal(blocked, true, 'a recorded release must remain in its pinned namespace');
  assert.equal(s.removal(rows).state, 'Removed');
});

test('absent listed files remain absent and later exceptions preserve completed deletion counters', windows, async () => {
  const s = setup();
  let f = await s.installed(), directory = join(f.target, 'releases', f.retained);
  fs.unlinkSync(join(directory, 'Arcane.exe')); fs.unlinkSync(join(directory, 'LICENSE.txt'));
  let result = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(result, ['state', 'executable', 'deleted', 'absent', 'manifestDeleted']), ['Removed', 'Absent', 2, 2, true]);
  for (const [stage, deleted] of [['before-files', 1], ['before-directories', 4]]) {
    f = await s.installed(); directory = join(f.target, 'releases', f.retained);
    const rows = await s.run(f.target, ['snapshot', 'acquire', 'throw-at', stage, 'remove', f.retained, 'wait'], [() => {
      assert.equal(exists(join(f.target, 'installation.lock')), true, 'partial removal leaves the caller lease held');
    }]);
    result = s.removal(rows);
    assert.deepEqual(pick(result, ['state', 'code', 'deleted', 'dirsDeleted', 'manifestDeleted', 'releaseDeleted']), ['Unknown', 'IO', deleted, 0, false, false]);
    assert.equal(exists(join(directory, 'windows-manifest.json')), true);
    assert.equal(exists(join(f.target, 'releases', f.active, 'Arcane.exe')), true);
  }
});

test('unknown content at the release root retains its manifest for a later explicit cleanup', windows, async () => {
  const s = setup(), f = await s.installed(), directory = join(f.target, 'releases', f.retained);
  const manual = join(directory, 'manual-note.txt'), manifest = join(directory, 'windows-manifest.json');
  const before = fs.readFileSync(manifest); fs.writeFileSync(manual, 'user release note');
  const partial = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(partial, ['state', 'deleted', 'manifestDeleted', 'releaseDeleted']), ['Partial', 4, false, false]);
  assert.deepEqual(fs.readFileSync(manifest), before); assert.equal(fs.readFileSync(manual, 'utf8'), 'user release note');
  // The fixture explicitly removes its own note; the component never removes or adopts that file.
  fs.unlinkSync(manual);
  const completed = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(completed, ['state', 'deleted', 'absent', 'manifestDeleted', 'releaseDeleted']), ['Removed', 0, 4, true, true]);
});

test('a directory appearing after admission is kept even when its new file matches listed bytes', windows, async () => {
  const s = setup(), f = await s.installed(), directory = join(f.target, 'releases', f.retained);
  const parent = join(directory, 'resources/data'), file = join(parent, 'notes.txt'), bytes = fs.readFileSync(file);
  fs.unlinkSync(file); fs.rmdirSync(parent);
  const rows = await s.run(f.target, ['snapshot', 'acquire', 'barrier', 'remove', f.retained], [() => {}, () => {
    fs.mkdirSync(parent); fs.writeFileSync(file, bytes);
  }]);
  const result = s.removal(rows);
  assert.deepEqual(pick(result, ['state', 'deleted', 'kept', 'manifestDeleted']), ['Partial', 3, 1, false]);
  assert.deepEqual(fs.readFileSync(file), bytes, 'the new directory was never part of the pinned namespace');
});

test('the engine-installed release removes long internal file and directory paths without changing root admission', windows, async () => {
  const s = setup(), segment = 'component-'.repeat(13);
  const extra = [['resources/data/' + segment + '.txt', Buffer.from('long leaf')], ['resources/data/' + segment + '/entry.txt', Buffer.from('long directory')]];
  const f = await s.installed(extra), directory = join(f.target, 'releases', f.retained);
  for (const [path] of extra) { assert.ok(join(directory, path).length > 259); assert.equal(fs.existsSync(join(directory, path)), true); }
  const other = tree(join(f.target, 'releases', f.active));
  const result = s.removal(await s.run(f.target, ['snapshot', 'acquire', 'remove', f.retained]));
  assert.deepEqual(pick(result, ['state', 'code', 'listed', 'deleted', 'manifestDeleted', 'releaseDeleted']), ['Removed', null, 6, 6, true, true]);
  assert.deepEqual(tree(join(f.target, 'releases', f.active)), other);
});
