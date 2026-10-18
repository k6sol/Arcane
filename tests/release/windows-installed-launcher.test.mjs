import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/InstalledRecord.cs + installer/Launcher.cs (+ PayloadArchive.cs for its NativeFile helpers)
// with the in-box .NET Framework csc.exe into (1) the production launcher executable and (2) a SEPARATE refusal harness
// (/main:Harness, so refusals never show a dialog). Installed roots are produced by the ACTUAL engine with a labelled
// SCRIPTED small-inventory verifier; each release's Arcane.exe is a tiny OWNED x64 console peer that writes a marker and
// exits. Actual Arcane is never launched. No user Programs/profile/registry/shortcuts, providers or Studio. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PEER = tag => String.raw`using System; using System.IO;
internal static class Peer {
  private static string J(string v) { return v == null ? "null" : "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  private static int Main(string[] args) {
    // Owned harmless fixture peer: records how it was started, then exits.
    string marker = Environment.GetEnvironmentVariable("ARCANE_FIXTURE_MARKER");
    File.WriteAllText(marker + ".tmp", "{\"tag\":\"${tag}\",\"args\":" + args.Length + ",\"commandLine\":" + J(Environment.CommandLine) + ",\"cwd\":" + J(Environment.CurrentDirectory) +
      ",\"probe\":" + J(Environment.GetEnvironmentVariable("ARCANE_FIXTURE_PROBE")) +
      ",\"nodeMode\":" + J(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")) +
      ",\"nodeOptions\":" + J(Environment.GetEnvironmentVariable("NODE_OPTIONS")) +
      ",\"nodePath\":" + J(Environment.GetEnvironmentVariable("NODE_PATH")) + "}");
    File.Move(marker + ".tmp", marker); return 0;
  } }`;
const HARNESS = String.raw`using System; using System.Text; using System.Runtime.InteropServices; using Arcane.Installer;
internal static class Harness {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetShortPathNameW(string path, StringBuilder buffer, uint length);
  private static string J(string v) { return v == null ? "null" : "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r") + "\""; }
  private static string B(bool v) { return v ? "true" : "false"; }
  private static string O(LaunchOutcome o) { return "{\"started\":" + B(o.Started) + ",\"code\":" + J(o.Code) + ",\"record\":" + B(o.RecordVerified) + ",\"manifest\":" + B(o.ManifestVerified) +
    ",\"executable\":" + B(o.ExecutableVerified) + ",\"fullBundle\":" + B(LaunchOutcome.FullBundleVerified) + ",\"installationId\":" + J(o.InstallationId) + ",\"releaseId\":" + J(o.ReleaseId) +
    ",\"version\":" + J(o.Version) + ",\"pid\":" + (o.ProcessId.HasValue ? o.ProcessId.Value.ToString() : "null") + "}"; }
  private static int Main(string[] a) {
    if (a[0] == "admit") { string[] rest = new string[a.Length - 1]; Array.Copy(a, 1, rest, 0, rest.Length); Console.WriteLine(B(LauncherEntry.Admit(rest))); return 0; }
    if (a[0] == "short") { StringBuilder s = new StringBuilder(1024); GetShortPathNameW(a[1], s, 1024); Console.WriteLine(J(s.ToString())); return 0; }
    if (a[0] == "launch") { Console.WriteLine(O(InstalledLauncher.Launch(a[1]))); return 0; }
    // prepare-wait: verify and pin, let the test change the root, then start (recheck boundary).
    PreparedLaunch prepared;
    try { prepared = InstalledLauncher.Prepare(InstalledRecord.Read(a[1])); }
    catch (InstalledRecordException e) { Console.WriteLine("{\"prepared\":false,\"code\":" + J(e.Code) + "}"); return 0; }
    Console.WriteLine("{\"prepared\":true}"); Console.Out.Flush(); Console.In.ReadLine();
    Console.WriteLine(O(InstalledLauncher.Start(prepared))); return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-launcher-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-launcher-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'PayloadArchive.cs']) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  const sources = ['InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'PayloadArchive.cs'].map(name => join(build, name));
  const refs = ['/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll'];
  const compile = (out, files, extra) => {
    const r = spawnSync(csc, ['/nologo', '/platform:x64', '/optimize+', '/out:' + out, ...extra, ...files], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'csc failed: ' + r.stdout + r.stderr); return out;
  };
  const launcher = compile(join(build, 'launcher.exe'), sources, ['/target:winexe', '/main:Arcane.Installer.LauncherEntry', ...refs]);
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = compile(join(build, 'harness.exe'), [...sources, join(build, 'Harness.cs')], ['/target:exe', '/main:Harness', ...refs]);
  const peers = {};
  for (const tag of ['A', 'B']) { fs.writeFileSync(join(build, 'Peer' + tag + '.cs'), PEER(tag)); peers[tag] = fs.readFileSync(compile(join(build, 'peer' + tag + '.exe'), [join(build, 'Peer' + tag + '.cs')], ['/target:exe'])); }
  fs.writeFileSync(join(build, 'PeerX86.cs'), PEER('X86'));
  const x86 = spawnSync(csc, ['/nologo', '/platform:x86', '/target:exe', '/out:' + join(build, 'peerX86.exe'), join(build, 'PeerX86.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(x86.status, 0); peers.X86 = fs.readFileSync(join(build, 'peerX86.exe'));
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the engine itself performs the actual transaction and record publication.
  const verify = async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(hash(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  };
  const engine = createWindowsInstallation({ verifyBundle: verify });
  const bundle = (exe, version = '0.1.0') => {
    const dir = owned('bundle'); fs.mkdirSync(join(dir, 'resources', 'node'), { recursive: true });
    const files = [];
    for (const [path, bytes] of [['Arcane.exe', exe], ['resources/node/node.exe', Buffer.from('fixture node')]]) { fs.writeFileSync(join(dir, path), bytes); files.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version, platform: 'win32', arch: 'x64',
      fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  /** A fresh installed root: releases installed in order (the last is active) and the production launcher placed at Arcane.exe. */
  const installed = async (...exes) => {
    const target = join(owned('install'), 'Arcane'); const results = [];
    for (const exe of exes) results.push(await engine.install({ bundle: typeof exe === 'string' ? exe : bundle(exe), installRoot: target }));
    fs.copyFileSync(launcher, join(target, 'Arcane.exe'));
    return { target, results, release: id => join(target, 'releases', id) };
  };
  /** Harness call; a started owned peer always gets its own marker path and is awaited to its terminal marker. */
  const call = args => {
    const marker = join(owned('marker'), 'started.json');
    const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { SystemRoot: process.env.SystemRoot, ARCANE_FIXTURE_MARKER: marker } });
    assert.equal(r.stderr, ''); const value = JSON.parse(r.stdout.trim());
    if (value && value.started === true) value.peer = waitFor(marker); else if (value && value.started === false) assert.equal(exists(marker), false, 'no start on refusal');
    return value;
  };
  shared = { root, build, launcher, harness, peers, owned, bundle, installed, engine, call };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const waitFor = path => { const end = Date.now() + 15000; while (!exists(path)) { assert.ok(Date.now() < end, 'owned peer marker not written'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } return JSON.parse(fs.readFileSync(path, 'utf8')); };
const snapshot = target => { const out = {}; const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else out[relative(target, p)] = hash(fs.readFileSync(p)); } }; walk(target); return out; };
/** Rewrites the active release's manifest consistently (new hash, id and record), so only the inventory rule is under test. */
function rewriteActive(target, mutate) {
  const recordPath = join(target, 'installation.json'), record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const entry = record.releases.find(r => r.id === record.activeReleaseId), dir = join(target, 'releases', entry.id);
  const manifest = JSON.parse(fs.readFileSync(join(dir, 'windows-manifest.json'), 'utf8')); mutate(manifest, dir);
  const bytes = Buffer.from(JSON.stringify(manifest)), sha = hash(bytes), id = sha + '-' + entry.id.slice(65);
  fs.writeFileSync(join(dir, 'windows-manifest.json'), bytes); fs.renameSync(dir, join(target, 'releases', id));
  Object.assign(entry, { id, manifestSha256: sha, files: manifest.fileCount, bytes: manifest.totalBytes }); record.activeReleaseId = id;
  fs.writeFileSync(recordPath, JSON.stringify(record) + '\n');
}

test('the production launcher follows active releases with no arguments and clean desktop startup', windows, async () => {
  const s = setup(), f = await s.installed(s.peers.A, s.peers.B), before = snapshot(f.target);
  const run = async expectTag => {
    const marker = join(s.owned('marker'), 'started.json');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(join(f.target, 'Arcane.exe'), [], { windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot, ARCANE_FIXTURE_MARKER: marker, ARCANE_FIXTURE_PROBE: 'kept', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--trace-warnings', NODE_PATH: 'fixture-only-path' } });
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(code, 0);
    const started = waitFor(marker), record = JSON.parse(fs.readFileSync(join(f.target, 'installation.json'), 'utf8'));
    assert.equal(started.tag, expectTag); assert.equal(started.args, 0); assert.equal(started.probe, 'kept', 'ordinary desktop environment is retained');
    assert.equal(started.nodeMode, null); assert.equal(started.nodeOptions, null); assert.equal(started.nodePath, null);
    assert.equal(started.cwd.toLowerCase(), f.release(record.activeReleaseId).toLowerCase());
    assert.equal(started.commandLine.trim(), '"' + join(f.release(record.activeReleaseId), 'Arcane.exe') + '"');
  };
  await run('B');
  assert.deepEqual(snapshot(f.target), before, 'launching never changes the installation');
  // Re-selecting the retained release through the engine changes what the stable launcher starts; nothing else does.
  await s.engine.install({ bundle: s.bundle(s.peers.A), installRoot: f.target });
  await run('A');
  const outcome = s.call(['launch', f.target]);
  assert.deepEqual([outcome.started, outcome.code, outcome.record, outcome.manifest, outcome.executable, outcome.fullBundle], [true, null, true, true, true, false]);
  assert.ok(Number.isInteger(outcome.pid));
});

test('lock, malformed records and unsafe roots are refused before any start', windows, async () => {
  const s = setup();
  const refused = (target, code) => { const o = s.call(['launch', target]); assert.equal(o.started, false); assert.equal(o.code, code, target); assert.equal(o.pid, null); return o; };
  const f = await s.installed(s.peers.A), recordPath = join(f.target, 'installation.json'), original = fs.readFileSync(recordPath, 'utf8'), record = JSON.parse(original);
  fs.writeFileSync(join(f.target, 'installation.lock'), 'fixture'); assert.equal(refused(f.target, 'LOCKED').record, false); fs.unlinkSync(join(f.target, 'installation.lock'));
  for (const text of [JSON.stringify(record, null, 2) + '\n', JSON.stringify(record), JSON.stringify({ ...record, extra: 1 }) + '\n', JSON.stringify({ ...record, activeReleaseId: 'a'.repeat(64) + '-' + record.installationId }) + '\n',
    JSON.stringify({ ...record, activeReleaseId: null }) + '\n', JSON.stringify({ ...record, installationId: record.installationId.toUpperCase() }) + '\n', JSON.stringify({ ...record, schemaVersion: 2 }) + '\n',
    JSON.stringify({ ...record, releases: [...record.releases, record.releases[0]] }) + '\n', original.replace('"releases":', '"releases":') + ' ', 'x'.repeat(70000), '{']) {
    fs.writeFileSync(recordPath, text); refused(f.target, 'RECORD');
  }
  fs.writeFileSync(recordPath, original);
  const link = join(s.owned('link'), 'record.json'); fs.linkSync(recordPath, link); refused(f.target, 'RECORD'); fs.unlinkSync(link);
  assert.equal(s.call(['launch', f.target]).started, true, 'restored record launches');
  refused('relative\\Arcane', 'PATH'); refused(f.target + '\\', 'PATH'); refused(f.target.replaceAll('\\', '/'), 'PATH');
  const junction = join(s.owned('junction'), 'Arcane'); fs.symlinkSync(f.target, junction, 'junction'); refused(junction, 'REDIRECT');
  const alias = JSON.parse(spawnSync(s.harness, ['short', f.target], { windowsHide: true, encoding: 'utf8' }).stdout.trim());
  if (alias && alias.toLowerCase() !== f.target.toLowerCase()) refused(alias, 'PATH');
});

test('tampered, missing, hardlinked, non-x64 or redirected executables and manifests are refused with no fallback', windows, async () => {
  const s = setup();
  const refused = (target, code) => { const o = s.call(['launch', target]); assert.deepEqual([o.started, o.code, o.fullBundle, o.pid], [false, code, false, null], target + ' ' + code); return o; };
  // Active B is damaged while A stays retained and intact: the launcher refuses instead of starting A.
  let f = await s.installed(s.peers.A, s.peers.B); const active = () => JSON.parse(fs.readFileSync(join(f.target, 'installation.json'), 'utf8')).activeReleaseId;
  let exe = join(f.release(active()), 'Arcane.exe'); const bytes = fs.readFileSync(exe); bytes[bytes.length >> 1] ^= 0xff; fs.writeFileSync(exe, bytes);
  const o = refused(f.target, 'EXECUTABLE'); assert.deepEqual([o.record, o.manifest, o.executable], [true, true, false]);
  f = await s.installed(s.peers.A); exe = join(f.release(active()), 'Arcane.exe'); fs.unlinkSync(exe); refused(f.target, 'EXECUTABLE');
  f = await s.installed(s.peers.A); exe = join(f.release(active()), 'Arcane.exe'); const link = join(s.owned('link'), 'Arcane.exe'); fs.linkSync(exe, link); refused(f.target, 'EXECUTABLE');
  f = await s.installed(s.peers.X86); refused(f.target, 'EXECUTABLE');
  f = await s.installed(s.peers.A); rewriteActive(f.target, (m, dir) => { const text = Buffer.from('not a portable executable'); fs.writeFileSync(join(dir, 'Arcane.exe'), text);
    const e = m.files.find(x => x.path === 'Arcane.exe'); m.totalBytes += text.length - e.bytes; Object.assign(e, { bytes: text.length, sha256: hash(text) }); }); refused(f.target, 'EXECUTABLE');
  f = await s.installed(s.peers.A); const manifest = join(f.release(active()), 'windows-manifest.json'); fs.appendFileSync(manifest, ' '); refused(f.target, 'MANIFEST');
  for (const mutate of [m => m.files.push({ path: '../evil.txt', bytes: 0, sha256: hash('') }), m => m.files.push({ path: 'arcane.EXE', bytes: 0, sha256: hash('') }),
    m => { m.files = m.files.filter(x => x.path !== 'resources/node/node.exe'); }, m => { m.totalBytes += 1; }, m => { m.files[0].extra = true; }, m => { m.arch = 'arm64'; },
    m => m.files.push({ path: 'CON.txt', bytes: 0, sha256: hash('') }), m => m.files.push({ path: 'a\\b.txt', bytes: 0, sha256: hash('') })]) {
    f = await s.installed(s.peers.A);
    rewriteActive(f.target, manifest => { mutate(manifest); if (manifest.fileCount !== manifest.files.length) manifest.fileCount = manifest.files.length; });
    refused(f.target, 'MANIFEST');
  }
  f = await s.installed(s.peers.A); const dir = f.release(active()), moved = join(s.owned('moved'), 'release'); fs.renameSync(dir, moved); fs.symlinkSync(moved, dir, 'junction'); refused(f.target, 'REDIRECT');
  f = await s.installed(s.peers.A); const releases = join(f.target, 'releases'), away = join(s.owned('moved'), 'releases'); fs.renameSync(releases, away); fs.symlinkSync(away, releases, 'junction'); refused(f.target, 'REDIRECT');
});

test('prepared launches pin the executable and recheck root, lock and record immediately before start', windows, async () => {
  const s = setup();
  const prepared = (f, change) => new Promise((resolve, reject) => {
    const marker = join(s.owned('marker'), 'started.json');
    const child = spawn(s.harness, ['prepare-wait', f.target], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, ARCANE_FIXTURE_MARKER: marker } });
    let out = '', err = '', done = false;
    child.stdout.on('data', d => { out += d; if (!done && out.includes('\n')) { done = true; try { change(); } catch (error) { reject(error); } child.stdin.end('go\n'); } });
    child.stderr.on('data', d => { err += d; });
    child.on('close', () => { try { assert.equal(err, ''); const [ready, outcome] = out.trim().split(/\r?\n/).map(l => JSON.parse(l)); assert.equal(ready.prepared, true); resolve({ outcome, marker }); } catch (e) { reject(e); } });
  });
  let f = await s.installed(s.peers.A); const record = JSON.parse(fs.readFileSync(join(f.target, 'installation.json'), 'utf8'));
  const exe = join(f.release(record.activeReleaseId), 'Arcane.exe'); let writeRefused = null;
  let r = await prepared(f, () => { try { fs.writeFileSync(exe, 'replace'); writeRefused = false; } catch (error) { writeRefused = error.code; } });
  assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(writeRefused), 'the executable is deny-write while the launch is pending: ' + writeRefused);
  assert.equal(r.outcome.started, true); assert.equal(waitFor(r.marker).tag, 'A');
  f = await s.installed(s.peers.A);
  r = await prepared(f, () => fs.writeFileSync(join(f.target, 'installation.lock'), 'fixture'));
  assert.deepEqual([r.outcome.started, r.outcome.code], [false, 'CHANGED']); assert.equal(exists(r.marker), false);
  f = await s.installed(s.peers.A);
  r = await prepared(f, () => { const p = join(f.target, 'installation.json'), bytes = fs.readFileSync(p); fs.renameSync(p, p + '.old'); fs.writeFileSync(p, bytes); });
  assert.deepEqual([r.outcome.started, r.outcome.code], [false, 'CHANGED'], 'a replaced record (same bytes, new identity) is not current');
  for (const [args, admitted] of [[[], 'true'], [['--root', 'C:\\x'], 'false'], [[''], 'false']]) {
    assert.equal(spawnSync(s.harness, ['admit', ...args], { windowsHide: true, encoding: 'utf8' }).stdout.trim(), admitted);
  }
});

test('record and manifest text fields reject a trailing LF that an end-of-line anchor would admit', windows, async () => {
  const s = setup();
  const outcomes = [], expected = [];
  const refused = (target, code, label) => { const o = s.call(['launch', target]); outcomes.push([label, o.started, o.code]); expected.push([label, false, code]); };
  const recordPath = target => join(target, 'installation.json');
  const edit = (target, change) => { const record = JSON.parse(fs.readFileSync(recordPath(target), 'utf8')); change(record); fs.writeFileSync(recordPath(target), JSON.stringify(record) + '\n'); };
  // Each record stays canonical (JSON escapes the LF), so only the field boundary can refuse it.
  let f = await s.installed(s.peers.A);
  edit(f.target, record => { record.installationId += '\n'; });
  refused(f.target, 'RECORD', 'installationId + LF');
  f = await s.installed(s.peers.A);
  rewriteActive(f.target, manifest => { manifest.version += '\n'; });
  edit(f.target, record => { record.releases.find(r => r.id === record.activeReleaseId).version += '\n'; });
  refused(f.target, 'RECORD', 'record and manifest version + LF');
  f = await s.installed(s.peers.A);
  rewriteActive(f.target, manifest => { manifest.files.find(x => x.path === 'resources/node/node.exe').sha256 += '\n'; });
  refused(f.target, 'MANIFEST', 'listed file sha256 + LF');
  assert.deepEqual(outcomes, expected);
});
