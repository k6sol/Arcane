import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/PostInstall.cs with its read-only dependencies via the in-box csc.exe into a SEPARATE owned
// console harness. InstallOutcome construction and the small bundle verifier are SCRIPTED boundary inputs; the actual Node
// engine creates each installation record, and the actual OwnedFiles, SetupOwnership and OperationLease place, record and fence.
// OwnedFiles.Barrier is used only in this harness to hold at a publication point. Nothing is executed. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const HARNESS = String.raw`using System; using System.IO; using System.Reflection; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static object F(OwnedFileResult r) { return r == null ? null : (object)new object[] { r.State.ToString(), r.Code, r.RetainedBackup != null }; }
  static object S(OwnershipSave s) { return s == null ? null : (object)new object[] { s.State.ToString(), s.Code }; }
  static int Main(string[] a) {
    if (a[0] == "resource") {
      try { byte[] b = a[1] == "launcher" ? PostInstall.LauncherResource(Assembly.GetExecutingAssembly(), long.Parse(a[2]), a[3]) : PostInstall.UninstallerResource(Assembly.GetExecutingAssembly(), long.Parse(a[2]), a[3]); Out(new { ok = true, bytes = b.Length }); }
      catch (IOException) { Out(new { ok = false }); } return 0; }
    // complete <root> <launcherFile> <launcherSha> <uninstallerFile> <uninstallerSha> <id> <active> <state> [holdAtPublication]
    string root = a[1]; InstallState state = (InstallState)Enum.Parse(typeof(InstallState), a[8]);
    bool? published = state == InstallState.Installed ? (bool?)true : state == InstallState.AlreadyActive ? (bool?)false : null;
    InstallOutcome result = new InstallOutcome(state, published, null, a[6], a[7], true, false, false, false, 0, 0);
    if (a.Length > 9 && a[9] != "0") { int hold = int.Parse(a[9]), seen = 0; OwnedFiles.Barrier = delegate(string stage) { if (stage == "before-publish" && ++seen == hold) { Out(new { op = "wait" }); Console.In.ReadLine(); } }; }
    byte[] launcher = File.ReadAllBytes(a[2]), uninstaller = File.ReadAllBytes(a[4]);
    long launcherBytes = a[3] == "short" ? launcher.Length - 1 : launcher.Length;
    SetupCompletionOutcome done = PostInstall.CompleteRootFiles(root, result, launcher, launcherBytes, a[3] == "short" ? null : a[3], uninstaller, uninstaller.Length, a[5]);
    OwnedFiles.Barrier = null;
    if (a.Length > 10) {
      if (a.Length > 11) { Out(new { op = "wait" }); Console.In.ReadLine(); }
      ShortcutSetupOutcome sc = PostInstall.CompleteShortcut(done, a[10]);
      Out(new { op = "shortcut", ready = sc.Ready, code = sc.Code, placement = F(sc.Placement), journal = S(sc.Journal),
        lease = sc.LeaseCleanup.HasValue ? sc.LeaseCleanup.Value.ToString() : null, retainedLock = sc.RetainedLock });
    }
    Out(new { op = "done", ready = done.Ready, code = done.Code, installationId = done.InstallationId,
      launcher = done.Launcher == null ? null : F(done.Launcher.Placement), launcherJournal = done.Launcher == null ? null : S(done.Launcher.Journal), launcherReady = done.Launcher != null && done.Launcher.Ready,
      uninstaller = F(done.Uninstaller), journal = S(done.Journal),
      lease = done.LeaseCleanup.HasValue ? done.LeaseCleanup.Value.ToString() : null, leaseCode = done.LeaseCleanupCode, retainedLock = done.RetainedLock });
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-setup-root-files-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-setup-root-files-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['PostInstall.cs', 'ShellLink.cs', 'Registration.cs', 'RegistrationPlan.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'Launcher.cs', 'InstallProcess.cs', 'KitVerifier.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const file = (name, text) => { const p = join(build, name); fs.writeFileSync(p, text); return { path: p, bytes: Buffer.from(text), sha: sha(text) }; };
  const L1 = file('launcher-1.bin', 'approved launcher fixture one'), U1 = file('uninstaller-1.bin', 'approved uninstaller fixture one');
  const L2 = file('launcher-2.bin', 'approved launcher fixture two'), U2 = file('uninstaller-2.bin', 'approved uninstaller fixture two');
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness,
    '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll',
    '/resource:' + L1.path + ',Arcane.Launcher', '/resource:' + U1.path + ',Arcane.Uninstaller', ...[...sources, 'Harness.cs'].map(name => join(build, name))],
  { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = label => { const p = join(root, label + '-' + ++count); fs.mkdirSync(p); return p; };
  const bundle = join(owned('bundle'), 'source'); fs.mkdirSync(join(bundle, 'resources/node'), { recursive: true }); const files = [];
  for (const [p, text] of [['Arcane.exe', 'unexecuted app fixture'], ['resources/node/node.exe', 'unexecuted node fixture']]) { fs.writeFileSync(join(bundle, p), text); files.push({ path: p, bytes: Buffer.byteLength(text), sha256: sha(text) }); }
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0), files }));
  const engine = createWindowsInstallation({ verifyBundle: async d => { const b = fs.readFileSync(join(d, 'windows-manifest.json')), m = JSON.parse(b); return { manifestSha256: sha(b), files: m.fileCount, bytes: m.totalBytes }; } });
  const installed = async () => { const target = join(owned('install'), 'Arcane'); const result = await engine.install({ bundle, installRoot: target }); return { target, result }; };
  /** Runs completion; `action` (if any) runs at the requested publication hold. */
  const complete = (f, { launcher = L1, uninstaller = U1, state = 'Installed', id = f.result.installationId, active = f.result.activeReleaseId, launcherSha = launcher.sha, uninstallerSha = uninstaller.sha, hold, action, programs, beforeShortcut = false } = {}) =>
    new Promise((resolve, reject) => {
      const argv = ['complete', f.target, launcher.path, launcherSha, uninstaller.path, uninstallerSha, id, active, state, ...(programs ? [String(hold ?? 0), programs, ...(beforeShortcut ? ["wait-shortcut"] : [])] : hold ? [String(hold)] : [])];
      const child = spawn(harness, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); const rows = []; let out = '', err = '', chain = Promise.resolve(), actionError;
      child.stdout.on('data', d => { out += d; const lines = out.split(/\r?\n/); out = lines.pop(); for (const line of lines) { const row = JSON.parse(line); rows.push(row);
        if (row.op === 'wait') chain = chain.then(() => action && action()).catch(e => { actionError ??= e; }).then(() => child.stdin.write('go\n')); } });
      child.stderr.on('data', d => { err += d; });
      child.once('error', reject);
      child.once('close', code => chain.then(() => { child.stdin.destroy(); if (actionError) reject(actionError); else if (code !== 0 || err) reject(new Error('harness ' + code + ' ' + err)); else resolve({ ...rows.find(r => r.op === 'done'), shortcut: rows.find(r => r.op === 'shortcut') }); }));
    });
  const resource = (kind, bytes, pin) => { const r = spawnSync(harness, ['resource', kind, String(bytes), pin], { windowsHide: true, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim()); };
  shared = { L1, U1, L2, U2, installed, complete, resource, engine, bundle, owned }; return shared;
}
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const journalOf = target => JSON.parse(fs.readFileSync(join(target, 'setup-ownership.json'), 'utf8'));
const tree = dir => { const out = {}; for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile()) out[e.name] = sha(fs.readFileSync(join(dir, e.name))); return out; };
const OK = { ready: true, code: null, lease: 'Released', leaseCode: null, retainedLock: null };
const outcome = r => ({ ready: r.ready, code: r.code, lease: r.lease, leaseCode: r.leaseCode, retainedLock: r.retainedLock });

test('both fixed root files are placed and recorded under one released lease, then a repeat is unchanged and new bytes replace owned files', windows, async () => {
  const s = setup(), f = await s.installed();
  let r = await s.complete(f);
  assert.deepEqual(outcome(r), OK);
  assert.deepEqual([r.launcher, r.launcherJournal, r.launcherReady, r.uninstaller, r.journal], [['Placed', null, false], ['Saved', null], true, ['Placed', null, false], ['Saved', null]]);
  assert.equal(fs.readFileSync(join(f.target, 'Arcane.exe'), 'utf8'), 'approved launcher fixture one');
  assert.equal(fs.readFileSync(join(f.target, 'Uninstall Arcane.exe'), 'utf8'), 'approved uninstaller fixture one');
  const j = journalOf(f.target);
  assert.deepEqual([j.launcher.sha256, j.uninstaller.sha256], [s.L1.sha, s.U1.sha]); assert.equal(exists(join(f.target, 'installation.lock')), false);
  const again = await s.engine.install({ bundle: s.bundle, installRoot: f.target }); assert.equal(again.activeReleaseId, f.result.activeReleaseId);
  r = await s.complete(f, { state: 'AlreadyActive' });
  assert.deepEqual(outcome(r), OK);
  assert.deepEqual([r.launcher[0], r.launcherJournal[0], r.uninstaller[0], r.journal[0]], ['Unchanged', 'Unchanged', 'Unchanged', 'Unchanged'], 'an exact repeat changes nothing');
  r = await s.complete(f, { launcher: s.L2, uninstaller: s.U2 });
  assert.deepEqual(outcome(r), OK);
  assert.deepEqual([r.launcher[0], r.uninstaller[0], r.journal[0]], ['Replaced', 'Replaced', 'Saved']);
  assert.deepEqual([journalOf(f.target).launcher.sha256, journalOf(f.target).uninstaller.sha256], [s.L2.sha, s.U2.sha]);
  assert.deepEqual(Object.keys(tree(f.target)).sort(), ['Arcane.exe', 'Uninstall Arcane.exe', 'installation.json', 'setup-ownership.json'], 'no candidates or backups remain');
});

test('an already recorded uninstaller is preserved when only the launcher changes', windows, async () => {
  const s = setup(), f = await s.installed();
  await s.complete(f); const before = journalOf(f.target).uninstaller;
  const r = await s.complete(f, { launcher: s.L2 });
  assert.deepEqual(outcome(r), OK); assert.deepEqual([r.launcher[0], r.uninstaller[0]], ['Replaced', 'Unchanged']);
  assert.deepEqual(journalOf(f.target).uninstaller, before, 'the uninstaller descriptor is preserved exactly');
});

test('both approved sources and the confirmed engine outcome are checked before anything is placed', windows, async () => {
  const s = setup();
  for (const [name, options, code] of [
    ['wrong uninstaller pin', { uninstallerSha: '0'.repeat(64) }, 'SOURCE'], ['wrong launcher pin', { launcherSha: '0'.repeat(64) }, 'SOURCE'],
    ['launcher size mismatch', { launcherSha: 'short' }, 'SOURCE'], ['failed installation', { state: 'Failed' }, 'INSTALLATION'],
    ['unconfirmed installation', { state: 'Unconfirmed' }, 'INSTALLATION'], ['other installation id', { id: '00000000-0000-4000-8000-000000000000' }, 'RECORD_CHANGED'],
    ['other active release', { active: '0'.repeat(64) + '-00000000-0000-4000-8000-000000000000' }, 'RECORD_CHANGED']]) {
    const f = await s.installed(), before = tree(f.target);
    const r = await s.complete(f, options);
    assert.deepEqual([r.ready, r.code, r.launcher, r.uninstaller, r.journal, r.lease], [false, code, null, null, null, null], name);
    assert.deepEqual(tree(f.target), before, name + ': nothing placed, no lease taken');
  }
});

test('manual root files, a manual journal and a foreign lock are kept; known results and lease cleanup are reported', windows, async () => {
  const s = setup();
  let f = await s.installed(); fs.writeFileSync(join(f.target, 'Arcane.exe'), 'manual launcher');
  let r = await s.complete(f);
  assert.deepEqual([r.ready, r.code, r.launcher, r.uninstaller, r.lease], [false, 'LAUNCHER', ['Kept', 'UNRECORDED', false], null, 'Released']);
  assert.deepEqual([fs.readFileSync(join(f.target, 'Arcane.exe'), 'utf8'), exists(join(f.target, 'Uninstall Arcane.exe')), exists(join(f.target, 'setup-ownership.json'))], ['manual launcher', false, false]);
  f = await s.installed(); fs.writeFileSync(join(f.target, 'Uninstall Arcane.exe'), 'manual uninstaller');
  r = await s.complete(f);
  assert.deepEqual([r.ready, r.code, r.launcher[0], r.launcherJournal[0], r.uninstaller, r.journal[0], r.lease], [false, 'UNINSTALLER', 'Placed', 'Saved', ['Kept', 'UNRECORDED', false], 'Saved', 'Released'],
    'the launcher stays recorded when the second placement fails');
  assert.equal(fs.readFileSync(join(f.target, 'Uninstall Arcane.exe'), 'utf8'), 'manual uninstaller');
  assert.deepEqual([journalOf(f.target).launcher.sha256, journalOf(f.target).uninstaller], [s.L1.sha, null]);
  f = await s.installed(); fs.writeFileSync(join(f.target, 'setup-ownership.json'), 'manual journal');
  r = await s.complete(f);
  assert.deepEqual([r.ready, r.code, r.launcher, r.lease], [false, 'JOURNAL_MALFORMED', null, 'Released']);
  assert.equal(fs.readFileSync(join(f.target, 'setup-ownership.json'), 'utf8'), 'manual journal'); assert.equal(exists(join(f.target, 'Arcane.exe')), false);
  f = await s.installed(); fs.writeFileSync(join(f.target, 'installation.lock'), 'other operation');
  r = await s.complete(f);
  assert.deepEqual([r.ready, r.code, r.launcher, r.lease, r.retainedLock], [false, 'LOCKED', null, null, null], 'a foreign lock is never taken over');
  assert.equal(fs.readFileSync(join(f.target, 'installation.lock'), 'utf8'), 'other operation'); assert.equal(exists(join(f.target, 'Arcane.exe')), false);
});

test('a journal or record change between the two placements keeps the known launcher result and grants no readiness', windows, async () => {
  const s = setup();
  // Hold 3 = the uninstaller candidate's publication (after the launcher was placed and recorded and the fence passed).
  let f = await s.installed();
  let r = await s.complete(f, { hold: 3, action: () => { const p = join(f.target, 'setup-ownership.json'), b = fs.readFileSync(p); fs.unlinkSync(p); fs.writeFileSync(p, b); } });
  assert.deepEqual([r.ready, r.code, r.launcher[0], r.launcherJournal[0], r.uninstaller[0], r.journal[0], r.lease], [false, 'UNINSTALLER_JOURNAL', 'Placed', 'Saved', 'Placed', 'Kept', 'Released']);
  assert.deepEqual([journalOf(f.target).launcher.sha256, journalOf(f.target).uninstaller], [s.L1.sha, null], 'the replaced journal is kept, never overwritten');
  f = await s.installed();
  r = await s.complete(f, { hold: 3, action: () => { const p = join(f.target, 'installation.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"releases"', '"releases" ')); } });
  assert.deepEqual([r.ready, r.code, r.launcher[0], r.launcherJournal[0], r.uninstaller[0], r.journal, r.lease], [false, 'UNINSTALLER_JOURNAL', 'Placed', 'Saved', 'Placed', ['Refused', 'RECORD_CHANGED'], 'Released']);
  assert.deepEqual([journalOf(f.target).launcher.sha256, journalOf(f.target).uninstaller], [s.L1.sha, null]);
  // Hold 2 = the launcher journal's publication: a record change there leaves the launcher save unconfirmed.
  f = await s.installed();
  r = await s.complete(f, { hold: 2, action: () => { const p = join(f.target, 'installation.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"releases"', '"releases" ')); } });
  assert.deepEqual([r.ready, r.code, r.launcher[0], r.launcherJournal, r.uninstaller, r.lease], [false, 'LAUNCHER_JOURNAL', 'Placed', ['Unknown', 'RECORD_CHANGED'], null, 'Released']);
  assert.equal(exists(join(f.target, 'Uninstall Arcane.exe')), false, 'nothing after an unconfirmed launcher record');
});

test('the embedded launcher and uninstaller are returned only for their exact size and pin', windows, () => {
  const s = setup();
  for (const [kind, f] of [['launcher', s.L1], ['uninstaller', s.U1]]) {
    assert.deepEqual(s.resource(kind, f.bytes.length, f.sha), { ok: true, bytes: f.bytes.length }, kind);
    assert.deepEqual(s.resource(kind, f.bytes.length + 1, f.sha), { ok: false }, kind + ' size');
    assert.deepEqual(s.resource(kind, f.bytes.length, '0'.repeat(64)), { ok: false }, kind + ' pin');
  }
  assert.deepEqual(s.resource('uninstaller', s.L1.bytes.length, s.L1.sha), { ok: false }, 'the fixed names are not interchangeable');
});


test('shortcut completion journals an actual link in the authorized owned Programs root and repeats without replacing it', windows, async () => {
  const s = setup(), f = await s.installed(), programs = s.owned('programs');
  let r = await s.complete(f, { programs });
  assert.deepEqual(r.shortcut, { op: 'shortcut', ready: true, code: null, placement: ['Placed', null, false], journal: ['Saved', null], lease: 'Released', retainedLock: null });
  const before = fs.readFileSync(join(programs, 'Arcane.lnk')), j = journalOf(f.target);
  assert.equal(j.schemaVersion, 2); assert.equal(j.shortcut.root, programs);
  assert.equal(j.shortcut.sha256, sha(before)); assert.equal(j.shortcut.name, 'Arcane.lnk');
  r = await s.complete(f, { programs, state: 'AlreadyActive' });
  assert.deepEqual(r.shortcut, { op: 'shortcut', ready: true, code: null, placement: ['Unchanged', null, false], journal: ['Unchanged', null], lease: 'Released', retainedLock: null });
  assert.deepEqual(fs.readFileSync(join(programs, 'Arcane.lnk')), before);
  assert.deepEqual(journalOf(f.target).shortcut, j.shortcut);
  assert.equal(exists(join(f.target, 'installation.lock')), false);
});

test('shortcut completion preserves manual and edited links and refuses a changed authorized destination', windows, async () => {
  const s = setup();
  let f = await s.installed(), programs = s.owned('programs');
  fs.writeFileSync(join(programs, 'Arcane.lnk'), 'manual link');
  let r = await s.complete(f, { programs });
  assert.deepEqual([r.shortcut.ready, r.shortcut.code, r.shortcut.placement, r.shortcut.lease], [false, 'PLACEMENT', ['Kept', 'UNRECORDED', false], 'Released']);
  assert.equal(fs.readFileSync(join(programs, 'Arcane.lnk'), 'utf8'), 'manual link'); assert.equal(journalOf(f.target).shortcut, null);
  f = await s.installed(); programs = s.owned('programs');
  await s.complete(f, { programs }); const owned = journalOf(f.target).shortcut;
  fs.appendFileSync(join(programs, 'Arcane.lnk'), 'edited'); const edited = fs.readFileSync(join(programs, 'Arcane.lnk'));
  r = await s.complete(f, { programs });
  assert.equal(r.shortcut.ready, false); assert.deepEqual(fs.readFileSync(join(programs, 'Arcane.lnk')), edited); assert.deepEqual(journalOf(f.target).shortcut, owned);
  const elsewhere = s.owned('other-programs'); r = await s.complete(f, { programs: elsewhere });
  assert.deepEqual([r.shortcut.ready, r.shortcut.code, r.shortcut.placement, r.shortcut.lease], [false, 'DESTINATION_CHANGED', null, 'Released']);
  assert.deepEqual(fs.readdirSync(elsewhere), []); assert.deepEqual(journalOf(f.target).shortcut, owned);
});

test('shortcut completion verifies root file bytes again and refuses a changed engine selection before placing a link', windows, async () => {
  const s = setup();
  for (const changed of ['launcher', 'record']) {
    const f = await s.installed(), programs = s.owned('programs');
    const r = await s.complete(f, { programs, beforeShortcut: true, action: () => {
      if (changed === 'launcher') fs.appendFileSync(join(f.target, 'Arcane.exe'), 'edited');
      else { const p = join(f.target, 'installation.json'), j = JSON.parse(fs.readFileSync(p, 'utf8')); j.updatedAt = '2026-10-16T00:00:00.000Z'; fs.writeFileSync(p, JSON.stringify(j) + '\n'); }
    } });
    assert.equal(r.shortcut.ready, false, changed); assert.equal(r.shortcut.placement, null, changed);
    assert.deepEqual(fs.readdirSync(programs), []); assert.equal(exists(join(f.target, 'installation.lock')), false);
  }
});


test('setup recreates an absent owned link and preserves shortcut ownership when the root tools update', windows, async () => {
  const s = setup(), f = await s.installed(), programs = s.owned('programs');
  await s.complete(f, { programs }); const initial = journalOf(f.target).shortcut;
  fs.unlinkSync(join(programs, 'Arcane.lnk'));
  let r = await s.complete(f, { programs });
  assert.equal(r.shortcut.ready, true); assert.equal(r.shortcut.placement[0], 'Placed');
  const repaired = journalOf(f.target).shortcut; assert.notEqual(repaired.index, initial.index);
  const bytes = fs.readFileSync(join(programs, 'Arcane.lnk'));
  r = await s.complete(f, { launcher: s.L2, uninstaller: s.U2, programs });
  assert.equal(r.shortcut.ready, true); assert.equal(r.shortcut.placement[0], 'Unchanged');
  assert.deepEqual(journalOf(f.target).shortcut, repaired); assert.deepEqual(fs.readFileSync(join(programs, 'Arcane.lnk')), bytes);
});
