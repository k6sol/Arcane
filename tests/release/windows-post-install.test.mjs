import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

const windows = { skip: process.platform !== 'win32' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
// Actual native components, separate owned harness. InstallOutcome construction and the small verifier are
// SCRIPTED boundary inputs; the real Node engine creates each installation record. Only the explicit Open case
// launches an owned harmless peer, with a private event and acknowledgement of that exact process's terminal exit.
const HARNESS = String.raw`using System; using System.IO; using System.Reflection; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static int Main(string[] a) {
    if (a[0] == "resource") { try { byte[] b = PostInstall.LauncherResource(Assembly.GetExecutingAssembly(), long.Parse(a[1]), a[2]); Out(new { ok = true, bytes = b.Length }); }
      catch (IOException) { Out(new { ok = false }); } return 0; }
    string root = a[1]; InstallState state = (InstallState)Enum.Parse(typeof(InstallState), a[6]);
    if (a[0] == "seed-uninstaller") {
      InstalledRecordSnapshot record = InstalledRecord.Read(root); OwnershipRead read = SetupOwnership.Read(record);
      byte[] uninstaller = new byte[] { 1, 2, 3 };
      using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create()) {
        string pin = BitConverter.ToString(hash.ComputeHash(uninstaller)).Replace("-", "").ToLowerInvariant();
        OwnedFileResult placed = OwnedFiles.Place(root, SetupOwnership.UninstallerName, uninstaller, pin, null);
        OwnershipSave saved = SetupOwnership.Save(read.Snapshot, null, placed.Descriptor);
        Out(new { state = saved.State.ToString() }); return 0;
      }
    }
    bool? published = state == InstallState.Installed ? (bool?)true : state == InstallState.AlreadyActive ? (bool?)false : null;
    InstallOutcome result = new InstallOutcome(state, published, null, a[4], a[5], true, false, false, false, 0, 0);
    if (a[0] == "race") { int writes = 0; OwnedFiles.Barrier = delegate(string stage) { if (stage == "before-publish" && ++writes == 2) File.WriteAllText(Path.Combine(root, "setup-ownership.json"), "manual journal"); }; }
    byte[] source = File.ReadAllBytes(a[2]);
    LauncherSetupOutcome completed = PostInstall.CompleteLauncher(root, result, source, source.Length, a[3]);
    Out(new { ready = completed.Ready, code = completed.Code, placement = completed.Placement == null ? null : completed.Placement.State.ToString(),
      journal = completed.Journal == null ? null : completed.Journal.State.ToString(), installationId = completed.InstallationId });
    if (a[0] == "open-wait") { Console.In.ReadLine(); LaunchOutcome opened = PostInstall.Open(completed); Out(new { started = opened.Started, code = opened.Code }); }
    if (a[0] == "open-peer") {
      string eventName = "Local\\ArcanePostInstall-" + Guid.NewGuid().ToString("N");
      using (System.Threading.EventWaitHandle gate = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.ManualReset, eventName)) {
        Environment.SetEnvironmentVariable("ARCANE_POST_INSTALL_EVENT", eventName);
        LaunchOutcome opened = PostInstall.Open(completed);
        if (!opened.Started || !opened.ProcessId.HasValue) { Out(new { started = false, code = opened.Code }); return 2; }
        using (System.Diagnostics.Process peer = System.Diagnostics.Process.GetProcessById(opened.ProcessId.Value)) {
          IntPtr ownedHandle = peer.Handle; // Bind the live owned process before releasing its private event.
          gate.Set(); bool exited = peer.WaitForExit(60000);
          Out(new { started = true, exited = exited, exitCode = exited ? (int?)peer.ExitCode : null });
          return exited && peer.ExitCode == 0 ? 0 : 3;
        }
      }
    }
    return 0;
  }
}`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-post-install-')));
  process.on('exit', () => {
    const child = relative(boundary, root);
    if (child.startsWith('arcane-post-install-') && !isAbsolute(child) && !child.includes(sep)) fs.rmSync(root, { recursive: true, force: true });
  });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['PostInstall.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'Launcher.cs', 'InstallProcess.cs', 'KitVerifier.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const launcher = Buffer.from('approved launcher fixture'), launcherFile = join(build, 'launcher.bin'); fs.writeFileSync(launcherFile, launcher);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness,
    '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll',
    '/resource:' + launcherFile + ',Arcane.Launcher', ...[...sources, 'Harness.cs'].map(name => join(build, name))],
  { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const peerSource = join(build, 'Peer.cs'), peer = join(build, 'peer.exe');
  fs.writeFileSync(peerSource, String.raw`using System; using System.Threading; internal static class Peer {
    private static int Main(string[] a) { using (EventWaitHandle gate = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("ARCANE_POST_INSTALL_EVENT"))) {
      return gate.WaitOne(60000) && a.Length == 0 ? 0 : 4; } } }`);
  const compiledPeer = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + peer, peerSource], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiledPeer.status, 0, compiledPeer.stdout + compiledPeer.stderr);
  let count = 0;
  const owned = label => { const path = join(root, label + '-' + ++count); fs.mkdirSync(path); return path; };
  const bundle = join(owned('bundle'), 'source'); fs.mkdirSync(join(bundle, 'resources/node'), { recursive: true });
  const files = [];
  for (const [path, text] of [['Arcane.exe', 'unexecuted app fixture'], ['resources/node/node.exe', 'unexecuted node fixture']]) {
    fs.writeFileSync(join(bundle, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64',
    fileCount: files.length, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), files }));
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(sha(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const installed = async () => {
    const target = join(owned('install'), 'Arcane'); const result = await engine.install({ bundle, installRoot: target });
    return { target, result };
  };
  const args = (fixture, mode = 'complete', changes = {}) => [mode, fixture.target, launcherFile, sha(launcher), fixture.result.installationId, fixture.result.activeReleaseId, 'Installed'].map((v, i) => changes[i] ?? v);
  const run = argv => {
    const child = spawnSync(harness, argv, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.equal(child.stderr, ''); return JSON.parse(child.stdout.trim());
  };
  const wait = async (argv, action) => {
    const child = spawn(harness, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', acted = false, actionError; const rows = [];
    child.stdout.on('data', bytes => {
      stdout += bytes; const lines = stdout.split(/\r?\n/); stdout = lines.pop();
      for (const line of lines) {
        rows.push(JSON.parse(line));
        if (!acted) { acted = true; try { action(); } catch (error) { actionError = error; } child.stdin.end('\n'); }
      }
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (actionError) throw actionError;
    assert.equal(code, 0, stderr); assert.equal(stderr, ''); assert.equal(stdout, ''); return rows;
  };
  shared = { root, launcher, launcherFile, harness, installed, args, run, wait, engine, bundle, peer }; return shared;
}

test('confirmed setup places and journals its approved launcher, including an already-active repeat', windows, async () => {
  const s = setup(), f = await s.installed();
  assert.deepEqual(s.run(s.args(f)), { ready: true, code: null, placement: 'Placed', journal: 'Saved', installationId: f.result.installationId });
  assert.deepEqual(fs.readFileSync(join(f.target, 'Arcane.exe')), s.launcher);
  const journal = JSON.parse(fs.readFileSync(join(f.target, 'setup-ownership.json'), 'utf8'));
  assert.equal(journal.installationId, f.result.installationId); assert.equal(journal.launcher.sha256, sha(s.launcher));
  const inode = fs.statSync(join(f.target, 'Arcane.exe'), { bigint: true }).ino;
  const repeated = s.run(s.args(f, 'complete', { 6: 'AlreadyActive' }));
  assert.deepEqual([repeated.ready, repeated.placement, repeated.journal], [true, 'Unchanged', 'Unchanged']);
  assert.equal(fs.statSync(join(f.target, 'Arcane.exe'), { bigint: true }).ino, inode);
});

test('failed outcomes, wrong pins and changed selections grant no placement', windows, async () => {
  const s = setup();
  for (const changes of [{ 6: 'Failed' }, { 6: 'Cancelled' }, { 6: 'Unconfirmed' }, { 3: '0'.repeat(64) }, { 4: '00000000-0000-0000-0000-000000000000' }, { 5: 'other' }]) {
    const f = await s.installed(), result = s.run(s.args(f, 'complete', changes));
    assert.equal(result.ready, false); assert.equal(result.placement, null);
    assert.equal(fs.existsSync(join(f.target, 'Arcane.exe')), false); assert.equal(fs.existsSync(join(f.target, 'setup-ownership.json')), false);
  }
});

test('manual launcher and journal files remain unchanged; interrupted recording grants no readiness or adoption', windows, async () => {
  const s = setup();
  for (const name of ['Arcane.exe', 'setup-ownership.json']) {
    const f = await s.installed(), path = join(f.target, name); fs.writeFileSync(path, 'manual bytes');
    assert.equal(s.run(s.args(f)).ready, false); assert.equal(fs.readFileSync(path, 'utf8'), 'manual bytes');
    if (name === 'setup-ownership.json') assert.equal(fs.existsSync(join(f.target, 'Arcane.exe')), false);
  }
  const f = await s.installed(), interrupted = s.run(s.args(f, 'race'));
  assert.deepEqual([interrupted.ready, interrupted.code, interrupted.placement, interrupted.journal], [false, 'JOURNAL', 'Placed', 'Kept']);
  assert.equal(fs.readFileSync(join(f.target, 'setup-ownership.json'), 'utf8'), 'manual journal');
  assert.equal(s.run(s.args(f)).ready, false, 'a partial previous placement is never adopted');
});

test('Open refuses a changed installation identity or an active operation after completion', windows, async () => {
  const s = setup();
  for (const change of ['identity', 'lock']) {
    const f = await s.installed();
    const rows = await s.wait(s.args(f, 'open-wait'), () => {
      if (change === 'lock') fs.writeFileSync(join(f.target, 'installation.lock'), 'another operation');
      else { const file = join(f.target, 'installation.json'), record = JSON.parse(fs.readFileSync(file, 'utf8')); record.installationId = '00000000-0000-0000-0000-000000000000'; fs.writeFileSync(file, JSON.stringify(record) + '\n'); }
    });
    assert.equal(rows[0].ready, true); assert.equal(rows[1].started, false); assert.equal(rows[1].code, change === 'lock' ? 'LOCKED' : 'CHANGED');
  }
});

test('the embedded launcher is returned only for its exact size and pin', windows, () => {
  const s = setup();
  assert.deepEqual(s.run(['resource', String(s.launcher.length), sha(s.launcher)]), { ok: true, bytes: s.launcher.length });
  for (const [size, hash] of [[s.launcher.length + 1, sha(s.launcher)], [s.launcher.length, '0'.repeat(64)], [0, sha(s.launcher)], [64 * 1024 * 1024 + 1, sha(s.launcher)]])
    assert.deepEqual(s.run(['resource', String(size), hash]), { ok: false });
});

test('launcher replacement preserves the recorded uninstaller descriptor', windows, async () => {
  const s = setup(), f = await s.installed();
  assert.deepEqual(s.run(s.args(f, 'seed-uninstaller')), { state: 'Saved' });
  const journalPath = join(f.target, 'setup-ownership.json');
  const previous = JSON.parse(fs.readFileSync(journalPath, 'utf8')).uninstaller;
  assert.equal(s.run(s.args(f)).ready, true);
  const replacement = join(s.root, 'replacement.bin'), bytes = Buffer.from('updated approved launcher fixture'); fs.writeFileSync(replacement, bytes);
  const updated = s.run(s.args(f, 'complete', { 2: replacement, 3: sha(bytes) }));
  assert.deepEqual([updated.ready, updated.placement, updated.journal], [true, 'Replaced', 'Saved']);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.deepEqual(journal.uninstaller, previous); assert.equal(journal.launcher.sha256, sha(bytes));
  assert.deepEqual(fs.readFileSync(join(f.target, 'Uninstall Arcane.exe')), Buffer.from([1, 2, 3]));
});

test('completion preserves busy, redirected-root and malformed-journal refusal reasons', windows, async () => {
  const s = setup();
  const f = await s.installed(); fs.writeFileSync(join(f.target, 'installation.lock'), 'another operation');
  assert.equal(s.run(s.args(f)).code, 'LOCKED');
  const redirected = await s.installed(), alias = join(s.root, 'redirected-root'); fs.symlinkSync(redirected.target, alias, 'junction');
  assert.equal(s.run(s.args(redirected, 'complete', { 1: alias })).code, 'REDIRECT');
  const malformed = await s.installed(); fs.writeFileSync(join(malformed.target, 'setup-ownership.json'), 'manual bytes');
  assert.equal(s.run(s.args(malformed)).code, 'JOURNAL_MALFORMED');
});

test('the separate Open action verifies and starts an owned peer and acknowledges its terminal exit', windows, async () => {
  const s = setup(), f = await s.installed();
  const executable = fs.readFileSync(s.peer); fs.writeFileSync(join(s.bundle, 'Arcane.exe'), executable);
  const manifestPath = join(s.bundle, 'windows-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.files.find(file => file.path === 'Arcane.exe'); entry.bytes = executable.length; entry.sha256 = sha(executable);
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = await s.engine.install({ bundle: s.bundle, installRoot: f.target });
  const child = spawnSync(s.harness, s.args({ target: f.target, result }, 'open-peer'), { windowsHide: true, encoding: 'utf8', timeout: 90000 });
  assert.equal(child.status, 0, child.stdout + child.stderr); assert.equal(child.stderr, '');
  const rows = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows[0].ready, true); assert.deepEqual(rows[1], { started: true, exited: true, exitCode: 0 });
});
