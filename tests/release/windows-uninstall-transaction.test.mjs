import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/UninstallTransaction.cs with its read-only dependencies via the in-box csc.exe into a SEPARATE
// owned STA op-script harness. Consent is created ONLY through the accepted owned scripted dialog seam (UninstallConsent.Observe:
// the harness's own hidden dialog, Uninstall activated by PerformClick; NOT physical input or human acceptance). Roots come from
// the ACTUAL engine with a labelled SCRIPTED verifier; root files and journals come from the ACTUAL OwnedFiles/SetupOwnership.
// Release and root executables are tiny OWNED console peers, started only for Busy cases with private ready/exit and actual exit
// awaited. ReleaseRemoval.Barrier is used only here for one deterministic interruption. No real Arcane, providers, Studio, user
// folders, registry, Start Menu, global process queries or termination. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PEER = tag => String.raw`using System; internal static class Peer { private static int Main() { Console.WriteLine("ready ${tag}"); Console.Out.Flush(); Console.In.ReadLine(); return 0; } }`;
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.Drawing; using System.IO; using System.Security.Cryptography; using System.Text; using System.Threading; using System.Windows.Forms; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  static string N(object o) { return o == null ? null : o.ToString(); }
  static object F(OwnedFileResult r) { return r == null ? null : (object)new object[] { r.State.ToString(), r.Code }; }
  static void Wait(string at) { Dictionary<string, object> w = new Dictionary<string, object>(); w["op"] = "wait"; w["at"] = at; Out(w); Console.In.ReadLine(); }
  [STAThread] static int Main(string[] a) {
    string root = a[0]; InstalledRecordSnapshot displayed = null; UninstallAuthorization authorization = null;
    CancellationTokenSource cts = new CancellationTokenSource(); string cancelAt = null, waitAt = null; List<string> seen = new List<string>();
    // SCRIPTED interaction on the harness's OWN consent dialog only: hidden, off the taskbar, Uninstall activated by PerformClick.
    UninstallConsent.Observe = delegate(Form form, string stage) {
      if (stage == "load") {
        form.Opacity = 0; form.Location = new Point(-32000, -32000);
        long ex = GetWindowLongPtr(form.Handle, -20).ToInt64();
        SetWindowLongPtr(form.Handle, -20, new IntPtr((ex & ~0x00040000L) | 0x00000080L));
        return; }
      Button uninstall = (Button)form.Controls.Find("uninstall", false)[0];
      form.BeginInvoke(new Action(delegate { uninstall.PerformClick(); }));
    };
    Action<UninstallProgress> progress = delegate(UninstallProgress u) {
      string key = u.Phase + ":" + u.Index; seen.Add(key + "/" + u.Count);
      if (key == cancelAt) cts.Cancel();
      if (key == waitAt) Wait(key);
    };
    for (int i = 1; i < a.Length; i++) {
      string op = a[i]; Dictionary<string, object> v = new Dictionary<string, object>(); v["op"] = op;
      switch (op) {
        case "journal": {
          // Real root files and journal placed through the ACTUAL components.
          InstalledRecordSnapshot r0 = InstalledRecord.Read(root); byte[] l = File.ReadAllBytes(a[++i]), u = File.ReadAllBytes(a[++i]);
          OwnedFileResult launcher = OwnedFiles.Place(root, SetupOwnership.LauncherName, l, Sha(l), null);
          OwnedFileResult uninstaller = OwnedFiles.Place(root, SetupOwnership.UninstallerName, u, Sha(u), null);
          OwnershipSave saved = SetupOwnership.Save(SetupOwnership.Read(r0).Snapshot, launcher.Descriptor, uninstaller.Descriptor);
          v["state"] = saved.State.ToString(); break; }
        case "shortcut": {
          string programs = a[++i]; InstalledRecordSnapshot original = InstalledRecord.Read(root); LeaseResult acquired = OperationLease.Acquire(original);
          using (OperationLease lease = acquired.Lease) {
            InstalledRecordSnapshot record = InstalledRecord.Read(root, lease); SetupOwnershipSnapshot journal = SetupOwnership.Read(record, lease).Snapshot;
            ShellLinkResult link = ArcaneShellLink.Create(root + "\\" + SetupOwnership.LauncherName, root);
            if (!link.Ok) throw new Exception("Link " + link.Code);
            OwnedFileResult placed = OwnedFiles.Place(programs, SetupOwnership.ShortcutName, link.Bytes, Sha(link.Bytes), null);
            OwnershipSave saved = SetupOwnership.SaveShortcut(journal, placed.Descriptor, lease);
            v["state"] = saved.State.ToString(); v["placement"] = F(placed); v["lease"] = lease.Release().State.ToString();
          }
          break; }
        case "consent": {
          displayed = InstalledRecord.Read(root); ConsentResult c = UninstallConsent.Ask(null, displayed); authorization = c.Authorization;
          v["state"] = c.State.ToString(); v["authorized"] = authorization != null; break; }
        case "wait": Wait("op"); continue;
        case "token-cancel": cts.Cancel(); continue;
        case "cancel-at": cancelAt = a[++i]; continue;
        case "wait-at": waitAt = a[++i]; continue;
        case "throw-at": { string stage = a[++i]; int nth = int.Parse(a[++i]), count = 0;
          ReleaseRemoval.Barrier = delegate(string s) { if (s == stage && ++count == nth) throw new IOException("Owned fixture interruption."); }; continue; }
        case "run": case "run-null": case "run-foreign": case "run-programs": {
          InstalledRecordSnapshot shown = op == "run-foreign" ? InstalledRecord.Read(a[++i]) : displayed;
          seen.Clear();
          UninstallResult r = op == "run-programs" ? UninstallTransaction.RunForPrograms(shown, authorization, cts.Token, progress, a[++i]) : UninstallTransaction.Run(shown, op == "run-null" ? null : authorization, cts.Token, progress);
          v["state"] = r.State.ToString(); v["code"] = r.Code; v["stoppedAt"] = r.StoppedAt.ToString(); v["mutated"] = r.Mutated; v["cancelRequested"] = r.CancelRequested;
          v["acquisition"] = N(r.Acquisition); v["acquisitionCode"] = r.AcquisitionCode; v["retainedLock"] = r.RetainedLock; v["consumed"] = r.Consumed; v["consentCode"] = r.ConsentCode;
          v["activity"] = N(r.Activity); v["activityCode"] = r.ActivityCode; v["activityPaths"] = r.ActivityPaths; v["activityUsers"] = r.ActivityUsers; v["journalPresent"] = r.JournalPresent;
          List<object> releases = new List<object>();
          foreach (ReleaseOutcome o in r.Releases) releases.Add(new object[] { o.State.ToString(), o.Code, o.Executable.ToString(), o.FilesListed, o.FilesDeleted, o.FilesKept, o.ManifestDeleted, o.ReleaseDirectoryDeleted });
          v["releases"] = releases; v["launcher"] = F(r.Launcher); v["uninstaller"] = F(r.Uninstaller); v["shortcut"] = F(r.Shortcut); v["journal"] = F(r.Journal);
          v["record"] = new object[] { r.Record.ToString(), r.RecordCode }; v["releasesDirectory"] = new object[] { r.ReleasesDirectory.ToString(), r.ReleasesDirectoryCode };
          v["rootDirectory"] = new object[] { r.RootDirectory.ToString(), r.RootDirectoryCode }; v["lease"] = new object[] { N(r.LeaseCleanup), r.LeaseCleanupCode };
          v["progress"] = new List<string>(seen); break; }
      }
      Out(v);
    }
    UninstallConsent.Observe = null; ReleaseRemoval.Barrier = null;
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-uninstall-transaction-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-uninstall-transaction-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['UninstallTransaction.cs', 'ShellLink.cs', 'UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'ReleaseRemoval.cs',
    'InstallationActivity.cs', 'SetupPath.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const compile = (out, files, extra = []) => { const r = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + out, ...extra, ...files], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'csc failed: ' + r.stdout + r.stderr); return out; };
  const harness = compile(join(build, 'harness.exe'), [...sources, 'Harness.cs'].map(f => join(build, f)),
    ['/main:Harness', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll']);
  const peers = {};
  for (const tag of ['A', 'B', 'L', 'U']) { fs.writeFileSync(join(build, 'Peer' + tag + '.cs'), PEER(tag)); peers[tag] = compile(join(build, 'peer' + tag + '.exe'), [join(build, 'Peer' + tag + '.cs')]); }
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine copies, records and selects releases.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(sha(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = (tag, variation = tag) => {
    const dir = owned('bundle'); const files = [];
    for (const [path, bytes] of [['Arcane.exe', fs.readFileSync(peers[tag])], ['resources/node/node.exe', Buffer.from('fixture node ' + variation)], ['resources/data/notes.txt', Buffer.from('data ' + variation)], ['LICENSE.txt', Buffer.from('license ' + variation)]]) {
      fs.mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true }); fs.writeFileSync(join(dir, path), bytes); files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
    }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  /** Two recorded releases (A retained, B active), a sibling folder next to the root and an owned profile folder outside it. */
  const installed = async ({ manual = true } = {}) => {
    const parent = owned('install'), target = join(parent, 'Arcane');
    await engine.install({ bundle: bundle('A'), installRoot: target }); await engine.install({ bundle: bundle('B'), installRoot: target });
    if (manual) fs.writeFileSync(join(target, 'manual-note.txt'), 'user note');
    fs.mkdirSync(join(parent, 'Sibling')); fs.writeFileSync(join(parent, 'Sibling', 'keep.txt'), 'sibling');
    const profile = owned('profile'); fs.writeFileSync(join(profile, 'project.txt'), 'user work');
    const record = JSON.parse(fs.readFileSync(join(target, 'installation.json'), 'utf8'));
    return { target, parent, profile, active: record.activeReleaseId, retained: record.releases.find(r => r.id !== record.activeReleaseId).id };
  };
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '', chain = Promise.resolve(), actionError, deadlineElapsed = false;
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); rows.push(row); if (row.op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(() => action(row)).catch(error => { actionError ??= error; }).then(() => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write('go\n'); }); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', error => { actionError ??= error; });
    // Expiry only ends the owned stdin handshake; it never claims the native process has exited.
    const deadline = setTimeout(() => { deadlineElapsed = true; child.stdin.end(); }, 90000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); chain.then(() => { child.stdin.destroy(); if (actionError) reject(actionError); else if (deadlineElapsed || err || code !== 0) reject(new Error('harness ' + code + ' ' + err + (deadlineElapsed ? ' observation deadline elapsed' : ''))); else resolve(rows.filter(r => r.op !== 'wait')); }); });
  });
  const journal = ['journal', peers.L, peers.U];
  /** Starts an owned peer executable and resolves once it reports ready; stop() ends its stdin and awaits its actual exit. */
  const startPeer = path => new Promise((resolve, reject) => {
    const peer = spawn(path, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); let out = '';
    peer.on('error', reject);
    peer.stdout.on('data', d => { out += d; if (out.includes('ready')) resolve({ stop: () => new Promise(done => { peer.once('exit', done); peer.stdin.end('exit\n'); }) }); });
  });
  shared = { owned, engine, bundle, installed, run, journal, startPeer, peers };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const tree = dir => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isSymbolicLink()) out[relative(dir, p)] = 'link'; else if (e.isDirectory()) { out[relative(dir, p) + sep] = 'dir'; walk(p); } else out[relative(dir, p)] = sha(fs.readFileSync(p)); } }; if (exists(dir)) walk(dir); return out; };
const result = rows => rows.find(r => r.op.startsWith('run'));
const pick = (r, keys) => keys.map(k => r[k]);
const REMOVED_RELEASE = ['Removed', null, 'Deleted', 4, 4, 0, true, true];

test('a replaced nonempty releases container is reported as changed and left untouched', windows, async () => {
  const s = setup(), f = await s.installed({ manual: false });
  const replacement = join(f.target, 'releases'), moved = join(f.parent, 'original-releases');
  const r = result(await s.run(f.target, ['consent', 'wait-at', 'ReleasesDirectory:0', 'run'], [() => {
    fs.renameSync(replacement, moved); fs.mkdirSync(replacement);
    fs.writeFileSync(join(replacement, 'manual.txt'), 'keep replacement');
  }]));
  assert.deepEqual(pick(r, ['state', 'code', 'record', 'lease']), ['Partial', 'CONTAINER', ['Deleted', null], ['Released', null]]);
  assert.deepEqual(r.releasesDirectory, ['Kept', 'CHANGED'], 'a replacement is not accepted as the observed container');
  assert.equal(fs.readFileSync(join(replacement, 'manual.txt'), 'utf8'), 'keep replacement');
  assert.deepEqual(fs.readdirSync(moved), [], 'the originally observed empty container stays');
});

test('activity preflight covers all 32 recorded releases in bounded batches', windows, async () => {
  const s = setup(), f = await s.installed({ manual: false });
  for (let i = 2; i < 32; i++) await s.engine.install({ bundle: s.bundle(i % 2 ? 'A' : 'B', 'release-' + i), installRoot: f.target });
  assert.equal(JSON.parse(fs.readFileSync(join(f.target, 'installation.json'), 'utf8')).releases.length, 32);
  const r = result(await s.run(f.target, [...s.journal, 'consent', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'activity', 'activityPaths']), ['Removed', null, 'Idle', 66]);
  assert.equal(r.releases.length, 32); assert.ok(r.releases.every(release => release[0] === 'Removed'));
  assert.deepEqual(r.lease, ['Released', null]); assert.equal(exists(f.target), false);
});

test('a redirected executable parent refuses before changing installation content', windows, async () => {
  const s = setup(), f = await s.installed();
  const resources = join(f.target, 'releases', f.active, 'resources'), moved = join(f.parent, 'original-resources');
  fs.renameSync(resources, moved); fs.symlinkSync(moved, resources, 'junction');
  const before = tree(f.target), outside = tree(moved);
  const r = result(await s.run(f.target, ['consent', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'activity', 'activityCode', 'releases']), ['Refused', 'ACTIVITY', false, 'Unknown', 'REDIRECT', []]);
  assert.deepEqual(r.lease, ['Released', null]); assert.deepEqual(tree(f.target), before); assert.deepEqual(tree(moved), outside);
});

test('consent-bound removal deletes exactly the recorded installation, journal and record last, and keeps manual, profile and sibling content', windows, async () => {
  const s = setup(), f = await s.installed(), sibling = tree(join(f.parent, 'Sibling')), profile = tree(f.profile);
  const rows = await s.run(f.target, [...s.journal, 'consent', 'run', 'run']);
  const [first, replay] = rows.filter(r => r.op === 'run');
  assert.deepEqual(rows.find(r => r.op === 'consent').state, 'Authorized');
  assert.deepEqual(pick(first, ['state', 'code', 'stoppedAt', 'mutated', 'acquisition', 'consumed', 'consentCode', 'activity', 'activityPaths', 'activityUsers', 'journalPresent']),
    ['Removed', null, 'Done', true, 'Acquired', true, null, 'Idle', 6, 0, true], 'six existing owned executables were inspected in bounded batches');
  assert.deepEqual(first.releases, [REMOVED_RELEASE, REMOVED_RELEASE]);
  assert.deepEqual([first.launcher, first.uninstaller, first.journal, first.record], [['Deleted', null], ['Deleted', null], ['Deleted', null], ['Deleted', null]]);
  assert.deepEqual([first.releasesDirectory, first.rootDirectory, first.lease], [['Deleted', null], ['Kept', 'NOT_EMPTY'], ['Released', null]]);
  assert.deepEqual(first.progress, ['Acquire:0/1', 'Consume:0/1', 'Activity:0/1', 'Releases:0/2', 'Releases:1/2', 'RootFiles:0/2', 'Journal:0/1', 'Record:0/1', 'ReleasesDirectory:0/1'], 'bounded phase progress');
  assert.deepEqual(tree(f.target), { 'manual-note.txt': sha('user note') }, 'only the unlisted manual file is kept; the root is not removed');
  assert.deepEqual(tree(join(f.parent, 'Sibling')), sibling); assert.deepEqual(tree(f.profile), profile);
  assert.deepEqual(pick(replay, ['state', 'mutated', 'consumed', 'consentCode', 'record']), ['Refused', false, true, 'CONSUMED', ['NotReached', null]], 'a replayed authorization never acts again');
  assert.equal(exists(join(f.target, 'installation.lock')), false);
});

test('an installation with nothing extra is removed completely, including its empty root; the parent and sibling stay', windows, async () => {
  const s = setup(), f = await s.installed({ manual: false });
  const r = result(await s.run(f.target, ['consent', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'journalPresent', 'activityPaths']), ['Removed', null, false, 4]);
  assert.deepEqual([r.launcher, r.uninstaller, r.journal], [null, null, null], 'no journal: no root files are claimed');
  assert.deepEqual([r.record, r.releasesDirectory, r.rootDirectory, r.lease], [['Deleted', null], ['Deleted', null], ['Deleted', null], ['Released', null]]);
  assert.equal(exists(f.target), false); assert.equal(fs.readFileSync(join(f.parent, 'Sibling', 'keep.txt'), 'utf8'), 'sibling');
});

test('missing, foreign, changed or blocked consent is refused without any deletion and burns the authorization', windows, async () => {
  const s = setup(), f = await s.installed(), other = await s.installed();
  let rows = await s.run(f.target, ['consent', 'run-null', 'run']), r;
  const [missing, after] = rows.filter(row => row.op.startsWith('run'));
  assert.deepEqual(pick(missing, ['state', 'code', 'mutated', 'acquisition', 'consumed']), ['Refused', 'CONSENT', false, null, false], 'no authorization: no lease is acquired');
  assert.deepEqual(pick(after, ['state', 'code']), ['Removed', null], 'the separate real authorization was untouched by the refused call');
  // Foreign: an authorization for one root presented with another displayed installation.
  const before = tree(other.target);
  const g = await s.installed(); const gBefore = tree(g.target);
  rows = await s.run(g.target, ['consent', 'run-foreign', other.target, 'run']);
  const [foreign, replay] = rows.filter(row => row.op.startsWith('run'));
  assert.deepEqual(pick(foreign, ['state', 'code', 'mutated', 'acquisition', 'consumed', 'consentCode']), ['Refused', 'CONSENT', false, null, true, 'LEASE']);
  assert.deepEqual(pick(replay, ['state', 'consentCode']), ['Refused', 'CONSUMED'], 'the mismatched presentation burned it');
  assert.deepEqual(tree(other.target), before); assert.deepEqual(tree(g.target), gBefore);
  // Changed: the record changed after the person approved it.
  const c = await s.installed();
  let changedBefore;
  rows = await s.run(c.target, ['consent', 'wait', 'run'], [async () => { await s.engine.install({ bundle: s.bundle('A'), installRoot: c.target }); changedBefore = tree(c.target); }]);
  r = result(rows);
  assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'acquisition', 'consumed', 'consentCode', 'releases']), ['Refused', 'RECORD_CHANGED', false, 'Refused', true, 'LEASE', []]);
  assert.deepEqual(tree(c.target), changedBefore); assert.equal(exists(join(c.target, 'installation.lock')), false);
  // Blocked: another operation's lock appeared; it is never taken over and is kept.
  const b = await s.installed(); let blockedBefore;
  rows = await s.run(b.target, ['consent', 'wait', 'run'], [() => { fs.writeFileSync(join(b.target, 'installation.lock'), 'other operation'); blockedBefore = tree(b.target); }]);
  r = result(rows);
  assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'acquisition', 'consumed', 'consentCode']), ['Refused', 'LOCKED', false, 'Refused', true, 'LEASE']);
  assert.deepEqual(tree(b.target), blockedBefore, 'the foreign lock and everything else stay');
  // Changed journal after approval: TryConsume refuses before anything is deleted.
  const j = await s.installed(); let journalBefore;
  rows = await s.run(j.target, [...s.journal, 'consent', 'wait', 'run'], [() => { const p = join(j.target, 'setup-ownership.json'), bytes = fs.readFileSync(p); fs.unlinkSync(p); fs.writeFileSync(p, bytes); journalBefore = tree(j.target); }]);
  r = result(rows);
  assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'acquisition', 'consumed', 'lease']), ['Refused', 'JOURNAL_CHANGED', false, 'Acquired', true, ['Released', null]]);
  assert.deepEqual(tree(j.target), journalBefore); assert.equal(exists(join(j.target, 'installation.lock')), false);
});

test('known activity on a recorded release or the journal-owned root uninstaller refuses before deleting anything', windows, async () => {
  const s = setup();
  for (const which of ['release', 'uninstaller']) {
    const f = await s.installed();
    await s.run(f.target, s.journal);
    const before = tree(f.target);
    const peer = await s.startPeer(which === 'release' ? join(f.target, 'releases', f.retained, 'Arcane.exe') : join(f.target, 'Uninstall Arcane.exe'));
    let r;
    try { r = result(await s.run(f.target, ['consent', 'run'])); }
    finally { await peer.stop(); }
    assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'activity', 'releases', 'record', 'lease']), ['Refused', 'BUSY', false, 'Busy', [], ['NotReached', null], ['Released', null]], which);
    assert.ok(r.activityUsers >= 1, which);
    assert.deepEqual(tree(f.target), before, which + ': nothing deleted');
    r = result(await s.run(f.target, ['consent', 'run']));
    assert.deepEqual(pick(r, ['state', 'code']), ['Removed', null], which + ': after the owned peer actually exited');
  }
});

test('a changed root file, a changed journal or a partial release stops later cleanup and keeps the journal and record', windows, async () => {
  const s = setup();
  // Changed journal-owned launcher: releases go, the launcher is kept, uninstaller/journal/record stay.
  let f = await s.installed();
  await s.run(f.target, s.journal); fs.writeFileSync(join(f.target, 'Arcane.exe'), 'manual launcher');
  let r = result(await s.run(f.target, ['consent', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'stoppedAt', 'mutated', 'launcher', 'uninstaller', 'journal', 'record', 'lease']),
    ['Partial', 'ROOT_FILE', 'RootFiles', true, ['Kept', 'CHANGED'], null, null, ['NotReached', null], ['Released', null]]);
  assert.deepEqual(r.releases, [REMOVED_RELEASE, REMOVED_RELEASE]);
  for (const name of ['Arcane.exe', 'Uninstall Arcane.exe', 'setup-ownership.json', 'installation.json']) assert.equal(exists(join(f.target, name)), true, name + ' kept');
  assert.equal(fs.readFileSync(join(f.target, 'Arcane.exe'), 'utf8'), 'manual launcher');
  // The journal replaced (same bytes, new identity) between phases: the next fence refuses; nothing after it happens.
  f = await s.installed(); await s.run(f.target, s.journal);
  r = result(await s.run(f.target, ['consent', 'wait-at', 'RootFiles:0', 'run'], [() => { const p = join(f.target, 'setup-ownership.json'), bytes = fs.readFileSync(p); fs.unlinkSync(p); fs.writeFileSync(p, bytes); }]));
  assert.deepEqual(pick(r, ['state', 'code', 'stoppedAt', 'launcher', 'journal', 'record']), ['Partial', 'JOURNAL_CHANGED', 'RootFiles', null, null, ['NotReached', null]]);
  for (const name of ['Arcane.exe', 'Uninstall Arcane.exe', 'setup-ownership.json', 'installation.json']) assert.equal(exists(join(f.target, name)), true, name + ' kept');
  // Unlisted content inside the active (last) release: that release is Partial and nothing later is touched.
  f = await s.installed(); await s.run(f.target, s.journal); fs.writeFileSync(join(f.target, 'releases', f.active, 'manual.txt'), 'manual');
  r = result(await s.run(f.target, ['consent', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'stoppedAt', 'launcher', 'record', 'lease']), ['Partial', 'RELEASE', 'Releases', null, ['NotReached', null], ['Released', null]]);
  assert.deepEqual(r.releases[0], REMOVED_RELEASE); assert.deepEqual(r.releases[1].slice(0, 2), ['Partial', 'CHANGED']);
  assert.equal(fs.readFileSync(join(f.target, 'releases', f.active, 'manual.txt'), 'utf8'), 'manual');
  for (const name of ['Arcane.exe', 'Uninstall Arcane.exe', 'setup-ownership.json', 'installation.json']) assert.equal(exists(join(f.target, name)), true, name + ' kept');
});

test('cancellation is cooperative between phases: Cancelled before content changes, Partial with known progress afterwards', windows, async () => {
  const s = setup();
  let f = await s.installed(); await s.run(f.target, s.journal); const before = tree(f.target);
  let r = result(await s.run(f.target, ['consent', 'token-cancel', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'mutated', 'cancelRequested', 'consumed', 'consentCode', 'releases', 'lease']), ['Cancelled', 'CANCELLED', false, true, true, null, [], ['Released', null]]);
  assert.deepEqual(tree(f.target), before, 'no content changed and the transient lock is gone');
  f = await s.installed(); await s.run(f.target, s.journal);
  r = result(await s.run(f.target, ['consent', 'cancel-at', 'Releases:0', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'stoppedAt', 'mutated', 'cancelRequested', 'record', 'lease']), ['Partial', 'CANCELLED', 'Releases', true, true, ['NotReached', null], ['Released', null]]);
  assert.deepEqual(r.releases, [REMOVED_RELEASE], 'the release in progress completed; the next never started');
  assert.equal(exists(join(f.target, 'releases', f.retained)), false); assert.equal(exists(join(f.target, 'releases', f.active, 'Arcane.exe')), true);
  for (const name of ['setup-ownership.json', 'installation.json']) assert.equal(exists(join(f.target, name)), true);
  assert.equal(exists(join(f.target, 'installation.lock')), false);
});

test('an interruption inside a release keeps its known counters, reports Unknown and stops all later cleanup', windows, async () => {
  const s = setup(), f = await s.installed(); await s.run(f.target, s.journal);
  const r = result(await s.run(f.target, ['consent', 'throw-at', 'before-files', '2', 'run']));
  assert.deepEqual(pick(r, ['state', 'code', 'stoppedAt', 'mutated', 'launcher', 'record', 'lease']), ['Unknown', 'RELEASE', 'Releases', true, null, ['NotReached', null], ['Released', null]]);
  assert.deepEqual(r.releases[0], REMOVED_RELEASE);
  assert.deepEqual(r.releases[1], ['Unknown', 'IO', 'Deleted', 4, 1, 0, false, false], 'the deleted executable stays counted');
  for (const name of ['Arcane.exe', 'Uninstall Arcane.exe', 'setup-ownership.json', 'installation.json']) assert.equal(exists(join(f.target, name)), true, name + ' kept');
  assert.equal(exists(join(f.target, 'installation.lock')), false);
});


test('consented removal binds the owned shortcut to the authorized Programs folder and removes it before releases', windows, async () => {
  const s = setup(), f = await s.installed({ manual: false }), programs = s.owned('programs');
  fs.writeFileSync(join(programs, 'Other.lnk'), 'keep sibling shortcut');
  const rows = await s.run(f.target, [...s.journal, 'shortcut', programs, 'consent', 'run-programs', programs]);
  assert.equal(rows.find(r => r.op === 'shortcut').state, 'Saved');
  const r = result(rows);
  assert.deepEqual([r.state, r.shortcut, r.lease], ['Removed', ['Deleted', null], ['Released', null]]);
  assert.ok(r.progress.indexOf('Shortcut:0/1') < r.progress.indexOf('Releases:0/2'));
  assert.equal(exists(f.target), false); assert.deepEqual(fs.readdirSync(programs), ['Other.lnk']);
  assert.equal(fs.readFileSync(join(programs, 'Other.lnk'), 'utf8'), 'keep sibling shortcut');
});

test('a manual edit or different Programs root keeps the shortcut and all application content', windows, async () => {
  const s = setup();
  for (const mode of ['edited', 'other-root', 'replaced-root']) {
    const f = await s.installed({ manual: false }), programs = s.owned('programs'), other = s.owned('other-programs');
    let before;
    const rows = await s.run(f.target, [...s.journal, 'shortcut', programs, 'wait', 'consent', 'run-programs', mode === 'other-root' ? other : programs], [() => {
      if (mode === 'edited') fs.appendFileSync(join(programs, 'Arcane.lnk'), 'manual edit');
      if (mode === 'replaced-root') { fs.renameSync(programs, join(other, 'original')); fs.mkdirSync(programs); fs.writeFileSync(join(programs, 'Arcane.lnk'), 'manual replacement'); }
      before = tree(f.target);
    }]);
    const r = result(rows);
    assert.deepEqual([r.state, r.code, r.mutated, r.releases, r.lease], ['Refused', mode === 'edited' ? 'SHORTCUT' : 'SHORTCUT_ROOT', false, [], ['Released', null]], mode);
    assert.deepEqual(tree(f.target), before, mode); assert.equal(exists(join(programs, 'Arcane.lnk')), true);
  }
});

test('an already absent owned shortcut permits the remaining consented removal', windows, async () => {
  const s = setup(), f = await s.installed({ manual: false }), programs = s.owned('programs');
  const rows = await s.run(f.target, [...s.journal, 'shortcut', programs, 'wait', 'consent', 'run-programs', programs], [() => fs.unlinkSync(join(programs, 'Arcane.lnk'))]);
  const r = result(rows); assert.deepEqual([r.state, r.shortcut, r.lease], ['Removed', ['Absent', null], ['Released', null]]);
  assert.equal(exists(f.target), false); assert.deepEqual(fs.readdirSync(programs), []);
});
