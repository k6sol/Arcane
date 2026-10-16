import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';
import { nativeEnvironment } from '../../dist/packages/codex-client/src/transport.js';

// Actual native completion, journal and consented removal. Registry operations are confined to an exclusively created
// volatile HKCU\Software\ArcaneRegistrationLifecycleTest-<UUID> fixture and its fixed Arcane child. The real uninstall
// parent is never opened. Engine verification and approved root bytes are labelled small fixtures; no executable runs.
const windows = { skip: process.platform !== 'win32' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.IO; using System.Text; using System.Reflection; using System.Threading; using System.Windows.Forms;
using System.Drawing; using System.Web.Script.Serialization; using Microsoft.Win32.SafeHandles; using Arcane.Installer;
internal static class Harness {
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static string Marker(SafeRegistryHandle key, string name) { uint type; byte[] b = RegistryNative.Value(key, name, out type); return type == 1 ? RegistryNative.Text(b) : null; }
  static void Set(SafeRegistryHandle key, string name, string value) { byte[] b = Encoding.Unicode.GetBytes(value + "\0"); if (RegistryNative.RegSetValueExW(key, name, 0, 1, b, (uint)b.Length) != 0) throw new Exception("Fixture write failed."); }
  static void Need(bool value, string message) { if (!value) throw new Exception(message); }
  static void Interrupt(string wanted, int nth) { int seen = 0; RegistrationStore.Barrier = delegate(string stage) {
    if (stage == wanted && ++seen == nth) throw new IOException("Owned fixture interruption."); }; }
  static void Evidence(string step, string root, RegistrationSetupOutcome result, RegistrationTarget target, string installationId) {
    RegistrationResult r = result.Registration;
    OwnershipRead read = SetupOwnership.Read(InstalledRecord.Read(root));
    Out(new { step = step, ready = result.Ready, code = result.Code, recovered = result.Recovered,
      state = r == null ? null : r.State.ToString(), written = r == null ? 0 : r.ValuesWritten,
      prepared = r == null ? 0 : r.ValuesPrepared, committed = r == null ? (bool?)null : r.Committed,
      descriptor = r != null && r.Descriptor != null,
      pending = read.Snapshot != null && read.Snapshot.PendingRegistration != null,
      native = read.Snapshot == null ? null : RegistrationStore.Reconcile(read.Snapshot.Registration, read.Snapshot.PendingRegistration, installationId, target).State.ToString(),
      lease = result.LeaseCleanup.HasValue ? result.LeaseCleanup.Value.ToString() : null });
  }
  [STAThread] static int Main(string[] a) {
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    string root = a[0], mode = a[3], name = "ArcaneRegistrationLifecycleTest-" + Guid.NewGuid().ToString("N"), marker = Guid.NewGuid().ToString("D");
    // lost: a replacement fixture marker written ONLY by target-marker-loss; cleanup accepts it as this run's own marker.
    string owner = null, lost = null; SafeRegistryHandle software = null, parent = null, extra = null; int exit = 0; bool clean = true;
    try {
      using (SafeRegistryHandle user = new SafeRegistryHandle(new IntPtr(unchecked((int)0x80000001)), false))
        Need(RegistryNative.RegOpenKeyExW(user, "Software", RegistryNative.OpenLink, RegistryNative.CreateSubKey | RegistryNative.View, out software) == 0, "Fixture parent unavailable.");
      uint disposition;
      Need(RegistryNative.RegCreateKeyExW(software, name, 0, null, 1, RegistryNative.Access | RegistryNative.CreateSubKey, IntPtr.Zero, out parent, out disposition) == 0 && disposition == 1, "Fixture was not exclusively created.");
      Set(parent, RegistrationTarget.FixtureMarker, marker);
      Out(new { step = "fixture", path = "HKCU\\Software\\" + name, marker = marker });
      using (RegistrationTarget target = RegistrationTarget.OwnedFixture(parent, marker)) {
        byte[] l = Encoding.UTF8.GetBytes("unexecuted approved launcher fixture"), u = Encoding.UTF8.GetBytes("unexecuted approved uninstaller fixture");
        InstallOutcome installed = new InstallOutcome(InstallState.Installed, true, null, a[1], a[2], true, false, false, false, 0, 0);
        SetupCompletionOutcome files = PostInstall.CompleteRootFiles(root, installed, l, l.Length, InstalledRecord.Sha256Hex(l), u, u.Length, InstalledRecord.Sha256Hex(u));
        Need(files.Ready, "Root completion failed.");
        if (mode == "record-race") {
          bool changed = false; OwnedFiles.Barrier = delegate(string stage) { if (stage == "after-aside" && !changed) {
            changed = true; string p = Path.Combine(root, "installation.json"); File.WriteAllText(p, File.ReadAllText(p).Replace("\"releases\"", "\"releases\" "), new UTF8Encoding(false)); } };
        }
        if (mode == "journal-race") RegistryStoreBarrier(root);
        if (mode == "rollback-create") Interrupt("before-value", 3);
        if (mode == "commit-before-ack" || mode == "pending-remove" || mode == "pending-edited" || mode == "pending-new-plan") Interrupt("after-commit", 1);
        RegistrationSetupOutcome registered = PostInstall.CompleteRegistration(mode == "invalid" ? null : files, target);
        OwnedFiles.Barrier = null; RegistrationStore.Barrier = null;
        if (registered.Registration != null && registered.Registration.Descriptor != null) owner = registered.Registration.Descriptor.OwnerId;
        if (owner == null && registered.PendingJournal != null && registered.PendingJournal.Snapshot != null && registered.PendingJournal.Snapshot.PendingRegistration != null)
          owner = registered.PendingJournal.Snapshot.PendingRegistration.OwnerId;
        Out(new { step = "registered", ready = registered.Ready, code = registered.Code,
          state = registered.Registration == null ? null : registered.Registration.State.ToString(),
          journal = registered.Journal == null ? null : registered.Journal.State.ToString(),
          lease = registered.LeaseCleanup.HasValue ? registered.LeaseCleanup.Value.ToString() : null, retainedLock = registered.RetainedLock });
        if (mode != "invalid" && mode != "record-race" && mode != "journal-race") {
          if (mode == "rollback-create" || mode == "commit-before-ack" || mode == "pending-remove" || mode == "pending-edited" || mode == "pending-new-plan") {
            Need(!registered.Ready, "Interrupted completion unexpectedly ready.");
            Evidence("interrupted", root, registered, target, a[1]);
            if (mode == "pending-new-plan") {
              Out(new { step = "upgrade" });
              string command = Console.In.ReadLine(); Need(command == "go", "Owned engine upgrade did not complete.");
              InstalledRecordSnapshot upgraded = InstalledRecord.Read(root);
              Need(upgraded.InstallationId == a[1] && upgraded.ActiveReleaseId != a[2], "Upgrade record binding failed.");
              installed = new InstallOutcome(InstallState.Installed, true, null, upgraded.InstallationId, upgraded.ActiveReleaseId, true, false, false, false, 0, 0);
              files = PostInstall.CompleteRootFiles(root, installed, l, l.Length, InstalledRecord.Sha256Hex(l), u, u.Length, InstalledRecord.Sha256Hex(u));
              Need(files.Ready, "Upgraded root completion failed.");
            }
            if (mode == "rollback-create" || mode == "commit-before-ack" || mode == "pending-new-plan") {
              string pendingOwner = owner;
              registered = PostInstall.CompleteRegistration(files, target);
              Evidence("recovered", root, registered, target, a[1]);
              Need(registered.Ready && registered.Registration.Descriptor != null, "Pending registration recovery failed.");
              owner = registered.Registration.Descriptor.OwnerId;
              Out(new { step = "recoveredOwner", same = owner == pendingOwner });
              if (mode == "pending-new-plan") {
                SafeRegistryHandle upgradedKey;
                Need(RegistryNative.RegOpenKeyExW(parent, "Arcane", RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out upgradedKey) == 0, "Updated entry missing.");
                using (upgradedKey) Out(new { step = "upgradedRegistration", version = Marker(upgradedKey, "DisplayVersion") });
              }
            }
          }
          bool pendingRemoval = mode == "pending-remove" || mode == "pending-edited";
          if (!pendingRemoval) {
          Need(registered.Ready, "Registration completion failed.");
          RegistrationSetupOutcome again = PostInstall.CompleteRegistration(files, target);
          Out(new { step = "repeat", ready = again.Ready, state = again.Registration == null ? null : again.Registration.State.ToString(), journal = again.Journal == null ? null : again.Journal.State.ToString() });
          Need(again.Ready, "Repeat completion failed.");
          }
          SafeRegistryHandle key;
          Need(RegistryNative.RegOpenKeyExW(parent, "Arcane", RegistryNative.OpenLink, RegistryNative.Access | RegistryNative.CreateSubKey, out key) == 0, "Fixture registration missing.");
          using (key) {
            if (mode == "edited" || mode == "pending-edited") Set(key, "DisplayName", "Owned fixture manual edit");
            if (mode == "extra") Set(key, "FixtureExtra", "keep fixture value");
            if (mode == "subkey") {
              Need(RegistryNative.RegCreateKeyExW(key, "FixtureExtra", 0, null, 1, RegistryNative.Access, IntPtr.Zero, out extra, out disposition) == 0 && disposition == 1, "Extra fixture not exclusive.");
              Set(extra, RegistrationTarget.FixtureMarker, marker);
            }
          }
          InstalledRecordSnapshot record = InstalledRecord.Read(root);
          UninstallConsent.Observe = delegate(Form form, string stage) {
            if (stage == "load") {
              form.Opacity = 0; form.Location = new Point(-32000, -32000);
              long ex = GetWindowLongPtr(form.Handle, -20).ToInt64(); SetWindowLongPtr(form.Handle, -20, new IntPtr((ex & ~0x00040000L) | 0x00000080L)); return;
            }
            Button uninstall = (Button)form.Controls.Find("uninstall", false)[0];
            form.BeginInvoke(new Action(delegate { uninstall.PerformClick(); }));
          };
          ConsentResult consent = UninstallConsent.Ask(null, record);
          Out(new { step = "consent", state = consent.State.ToString(), code = consent.Code });
          Need(consent.State == ConsentState.Authorized, "Owned scripted consent refused.");
          if (mode == "remove-interrupted") Interrupt("before-delete-commit", 1);
          // Target binding loss: change ONLY the exclusive owned parent's fixture marker, after consent and before removal.
          if (mode == "target-marker-loss") { lost = Guid.NewGuid().ToString("D"); Set(parent, RegistrationTarget.FixtureMarker, lost); }
          UninstallResult removed = UninstallTransaction.RunForTargets(record, consent.Authorization, CancellationToken.None, null, null, target);
          RegistrationStore.Barrier = null;
          if (mode == "target-marker-loss") {
            string lostDetail;
            using (UninstallForm form = new UninstallForm(null, null)) {
              typeof(UninstallForm).GetMethod("Present", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(form, new object[] { removed, false });
              lostDetail = ((Label)typeof(UninstallForm).GetField("detail", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form)).Text;
            }
            Out(new { step = "targetLost", state = removed.State.ToString(), code = removed.Code,
              registration = removed.Registration == null ? null : removed.Registration.State.ToString(),
              registrationCode = removed.Registration == null ? null : removed.Registration.Code,
              journal = File.Exists(Path.Combine(root, "setup-ownership.json")), record = File.Exists(Path.Combine(root, "installation.json")),
              launcher = File.Exists(Path.Combine(root, SetupOwnership.LauncherName)), uninstaller = File.Exists(Path.Combine(root, SetupOwnership.UninstallerName)),
              lease = removed.LeaseCleanup.HasValue ? removed.LeaseCleanup.Value.ToString() : null, detail = lostDetail,
              nativeWhileLost = RegistrationStore.Verify(registered.Registration.Descriptor, a[1], target).State.ToString() });
            // Restore the exact original marker only AFTER observing the result; the recorded entry must be untouched.
            Set(parent, RegistrationTarget.FixtureMarker, marker); lost = null;
            Out(new { step = "targetRestored", native = RegistrationStore.Verify(registered.Registration.Descriptor, a[1], target).State.ToString() });
            record = InstalledRecord.Read(root);
            ConsentResult fresh = UninstallConsent.Ask(null, record);
            Need(fresh.State == ConsentState.Authorized, "Fresh retry consent refused.");
            removed = UninstallTransaction.RunForTargets(record, fresh.Authorization, CancellationToken.None, null, null, target);
          }
          if (mode == "remove-interrupted") {
            Out(new { step = "removeInterrupted", state = removed.State.ToString(), code = removed.Code,
              registration = removed.Registration == null ? null : removed.Registration.State.ToString(),
              registrationCode = removed.Registration == null ? null : removed.Registration.Code,
              journal = File.Exists(Path.Combine(root, "setup-ownership.json")), record = File.Exists(Path.Combine(root, "installation.json")),
              launcher = File.Exists(Path.Combine(root, SetupOwnership.LauncherName)), uninstaller = File.Exists(Path.Combine(root, SetupOwnership.UninstallerName)),
              native = RegistrationStore.Verify(registered.Registration.Descriptor, a[1], target).State.ToString(),
              lease = removed.LeaseCleanup.HasValue ? removed.LeaseCleanup.Value.ToString() : null });
            record = InstalledRecord.Read(root);
            ConsentResult fresh = UninstallConsent.Ask(null, record);
            Need(fresh.State == ConsentState.Authorized, "Fresh retry consent refused.");
            removed = UninstallTransaction.RunForTargets(record, fresh.Authorization, CancellationToken.None, null, null, target);
          }
          string detail;
          using (UninstallForm form = new UninstallForm(null, null)) {
            typeof(UninstallForm).GetMethod("Present", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(form, new object[] { removed, false });
            detail = ((Label)typeof(UninstallForm).GetField("detail", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form)).Text;
          }
          Out(new { step = "removed", state = removed.State.ToString(), code = removed.Code,
            registration = removed.Registration == null ? null : removed.Registration.State.ToString(), registrationCode = removed.Registration == null ? null : removed.Registration.Code,
            record = removed.Record.ToString(), rootAbsent = !Directory.Exists(root), detail = detail, lease = removed.LeaseCleanup.HasValue ? removed.LeaseCleanup.Value.ToString() : null });
          SafeRegistryHandle kept; int keptRc = RegistryNative.RegOpenKeyExW(parent, "Arcane", RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out kept);
          using (kept) Out(new { step = "kept", exists = keptRc == 0, display = keptRc == 0 ? Marker(kept, "DisplayName") : null, extra = keptRc == 0 ? Marker(kept, "FixtureExtra") : null });
        }
      }
    } catch (Exception e) { Console.Error.WriteLine(e.GetType().Name + ": " + e.Message); exit = 1; }
    finally {
      OwnedFiles.Barrier = null; RegistrationStore.Barrier = null; UninstallConsent.Observe = null;
      if (extra != null) { if (Marker(extra, RegistrationTarget.FixtureMarker) != marker || RegistryNative.RegDeleteKeyExW(extra, "", RegistryNative.View, 0) != 0) clean = false; extra.Dispose(); }
      if (parent != null && !parent.IsInvalid) {
        SafeRegistryHandle key; int rc = RegistryNative.RegOpenKeyExW(parent, "Arcane", RegistryNative.OpenLink, RegistryNative.Access, out key);
        if (rc == 0) { if (owner == null || Marker(key, RegistrationStore.OwnerMarker) != owner || RegistryNative.RegDeleteKeyExW(key, "", RegistryNative.View, 0) != 0) clean = false; key.Dispose(); }
        else { if (key != null) key.Dispose(); if (rc != RegistryNative.Missing) clean = false; }
        string parentMarker = Marker(parent, RegistrationTarget.FixtureMarker);
        if (clean && (parentMarker == marker || lost != null && parentMarker == lost)) clean = RegistryNative.RegDeleteKeyExW(parent, "", RegistryNative.View, 0) == 0;
        else clean = false;
        parent.Dispose();
      }
      if (software != null) software.Dispose();
      Out(new { step = "fixtureCleanup", complete = clean, retained = clean ? null : "HKCU\\Software\\" + name });
    }
    return exit != 0 || !clean ? 1 : 0;
  }
  static void RegistryStoreBarrier(string root) { RegistrationStore.Barrier = delegate(string stage) { if (stage == "after-commit") File.WriteAllText(Path.Combine(root, "setup-ownership.json"), "owned fixture journal edit", new UTF8Encoding(false)); }; }
}`;

let shared, passed = 0;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), owner = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-reg-lifecycle-')));
  process.on('exit', () => {
    const part = relative(boundary, owner);
    if (passed === 8 && !isAbsolute(part) && part.startsWith('arcane-reg-lifecycle-') && !part.includes(sep)) fs.rmSync(owner, { recursive: true, force: true });
    else console.error('Retained owned registration fixture artifacts: ' + owner);
  });
  const build = join(owner, 'build'); fs.mkdirSync(build);
  const names = fs.readdirSync(new URL('../../installer/', import.meta.url)).filter(n => n.endsWith('.cs'));
  for (const name of names) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  fs.writeFileSync(join(build, 'SetupPins.cs'), 'namespace Arcane.Installer { internal static class SetupPins { public const string PayloadSha256="' + '0'.repeat(64) + '"; public const string KitManifestSha256="' + '0'.repeat(64) + '"; public const int MaximumRelativePathChars=134; public const long LauncherBytes=1; public const string LauncherSha256="' + '0'.repeat(64) + '"; public const long UninstallerBytes=1; public const string UninstallerSha256="' + '0'.repeat(64) + '"; } }');
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), harness = join(build, 'harness.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', ...[...names, 'Harness.cs', 'SetupPins.cs'].map(n => join(build, n))], { encoding: 'utf8', windowsHide: true, env: nativeEnvironment() });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const bundle = join(owner, 'bundle'); fs.mkdirSync(join(bundle, 'resources/node'), { recursive: true });
  const files = [];
  for (const [path, text] of [['Arcane.exe', 'unexecuted fixture app'], ['resources/node/node.exe', 'unexecuted fixture node']]) {
    fs.writeFileSync(join(bundle, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: hash(text) });
  }
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
  const upgradedBundle = join(owner, 'bundle-0.2.0'); fs.cpSync(bundle, upgradedBundle, { recursive: true });
  const upgradedManifest = JSON.parse(fs.readFileSync(join(upgradedBundle, 'windows-manifest.json'), 'utf8'));
  upgradedManifest.version = '0.2.0'; fs.writeFileSync(join(upgradedBundle, 'windows-manifest.json'), JSON.stringify(upgradedManifest));
  const engine = createWindowsInstallation({ verifyBundle: async d => { const b = fs.readFileSync(join(d, 'windows-manifest.json')), m = JSON.parse(b); for (const f of m.files) assert.equal(hash(fs.readFileSync(join(d, f.path))), f.sha256); return { manifestSha256: hash(b), files: m.fileCount, bytes: m.totalBytes }; } });
  let id = 0;
  const run = async mode => {
    const parent = join(owner, 'case-' + ++id); fs.mkdirSync(parent); const root = join(parent, 'Arcane');
    const installed = await engine.install({ bundle, installRoot: root });
    return new Promise((resolve, reject) => {
      const child = spawn(harness, [root, installed.installationId, installed.activeReleaseId, mode], { windowsHide: true, env: nativeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', pending = '', actionError, action = Promise.resolve();
      child.stdout.on('data', d => {
        out += d; pending += d; assert.ok(out.length < 1024 * 1024, 'bounded native output');
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
          if (line && JSON.parse(line).step === 'upgrade') action = action.then(async () => {
            try { await engine.install({ bundle: upgradedBundle, installRoot: root }); child.stdin.write('go\n'); }
            catch (e) { actionError = e; child.stdin.write('abort\n'); }
          });
        }
      }); child.stderr.on('data', d => { err += d; });
      child.once('error', reject); child.once('close', async (code, signal) => {
        await action;
        fs.writeFileSync(join(parent, 'native-result.json'), JSON.stringify({ code, signal, out, err }) + '\n');
        try { assert.ifError(actionError); assert.equal(code, 0, out + err); assert.equal(signal, null); assert.equal(err, ''); const rows = out.trim().split(/\r?\n/).map(l => JSON.parse(l)); assert.equal(rows.at(-1).complete, true); resolve(rows); } catch (e) { reject(e); }
      });
    });
  };
  shared = { run }; return shared;
}
const row = (rows, step) => rows.find(r => r.step === step);

test('native registration completion journals and repeats unchanged, then fresh scripted consent removes the app entry and files', windows, async () => {
  const rows = await setup().run('normal');
  assert.deepEqual(row(rows, 'registered'), { step: 'registered', ready: true, code: null, state: 'Created', journal: 'Saved', lease: 'Released', retainedLock: null });
  assert.deepEqual(row(rows, 'repeat'), { step: 'repeat', ready: true, state: 'Unchanged', journal: 'Unchanged' });
  const removed = row(rows, 'removed'); assert.deepEqual([removed.state, removed.registration, removed.rootAbsent, removed.record, removed.lease], ['Removed', 'Deleted', true, 'Deleted', 'Released']);
  assert.equal(row(rows, 'kept').exists, false); passed++;
});

test('edited registration, extra values and subkeys are preserved while the recorded app is removed and the native UI explains retention', windows, async () => {
  for (const mode of ['edited', 'extra', 'subkey']) {
    const rows = await setup().run(mode), removed = row(rows, 'removed'), kept = row(rows, 'kept');
    assert.deepEqual([removed.state, removed.registration, removed.registrationCode, removed.rootAbsent, removed.lease], ['Removed', 'Kept', 'CHANGED', true, 'Released'], mode);
    assert.match(removed.detail, /Windows app entry was kept for review/); assert.equal(kept.exists, true);
    if (mode === 'edited') assert.equal(kept.display, 'Owned fixture manual edit');
    if (mode === 'extra') assert.equal(kept.extra, 'keep fixture value');
  }
  passed++;
});

test('registration completion refuses an invalid completion and preserves explicit partial evidence when record or journal changes', windows, async () => {
  let rows = await setup().run('invalid'); assert.deepEqual(row(rows, 'registered'), { step: 'registered', ready: false, code: 'INSTALLATION', state: null, journal: null, lease: null, retainedLock: null });
  rows = await setup().run('record-race'); const record = row(rows, 'registered');
  assert.deepEqual([record.ready, record.code, record.state, record.journal, record.lease], [false, 'REGISTRATION_INTENT', 'Absent', 'Unknown', 'Released']);
  rows = await setup().run('journal-race'); const journal = row(rows, 'registered');
  assert.deepEqual([journal.ready, journal.code, journal.state, journal.journal, journal.lease], [false, 'JOURNAL_CHANGED', 'Created', 'Saved', 'Released']);
  passed++;
});

test('durable pending registration recovers a rolled back create and a committed create before acknowledgement', windows, async () => {
  for (const mode of ['rollback-create', 'commit-before-ack']) {
    const rows = await setup().run(mode), first = row(rows, 'interrupted'), recovered = row(rows, 'recovered');
    assert.deepEqual([first.ready, first.code, first.pending, first.lease], [false, 'REGISTRATION', true, 'Released'], mode);
    assert.deepEqual([first.state, first.written, first.prepared, first.committed, first.descriptor, first.native],
      mode === 'rollback-create' ? ['Refused', 0, 2, false, false, 'Absent'] : ['Unknown', 10, 10, true, false, 'Unchanged'], mode);
    assert.deepEqual([recovered.ready, recovered.recovered, recovered.pending, recovered.native, recovered.lease], [true, true, false, 'Unchanged', 'Released'], mode);
    assert.equal(row(rows, 'recoveredOwner').same, mode === 'commit-before-ack');
    assert.deepEqual([row(rows, 'removed').state, row(rows, 'removed').registration, row(rows, 'removed').rootAbsent], ['Removed', 'Deleted', true]);
  }
  passed++;
});

test('fresh consent removes an exact pending entry and preserves a pending entry edited after commit', windows, async () => {
  for (const mode of ['pending-remove', 'pending-edited']) {
    const rows = await setup().run(mode), removed = row(rows, 'removed'), edited = mode === 'pending-edited';
    assert.equal(row(rows, 'interrupted').pending, true);
    assert.deepEqual([removed.state, removed.registration, removed.rootAbsent, removed.lease], ['Removed', edited ? 'Kept' : 'Deleted', true, 'Released']);
    assert.equal(row(rows, 'kept').exists, edited);
    if (edited) { assert.equal(row(rows, 'kept').display, 'Owned fixture manual edit'); assert.match(removed.detail, /Windows app entry was kept for review/); }
  }
  passed++;
});

test('rolled back registration removal retains journal and root tools, then fresh consent completes removal', windows, async () => {
  const rows = await setup().run('remove-interrupted'), first = row(rows, 'removeInterrupted'), removed = row(rows, 'removed');
  assert.deepEqual(first, { step: 'removeInterrupted', state: 'Partial', code: 'REGISTRATION', registration: 'Kept', registrationCode: 'INTERRUPTED',
    journal: true, record: true, launcher: true, uninstaller: true, native: 'Unchanged', lease: 'Released' });
  assert.deepEqual([removed.state, removed.registration, removed.rootAbsent, removed.lease], ['Removed', 'Deleted', true, 'Released']);
  passed++;
});

test('a committed pending entry is reconciled before applying a newer engine plan to the same owner', windows, async () => {
  const rows = await setup().run('pending-new-plan'), recovered = row(rows, 'recovered');
  assert.equal(row(rows, 'interrupted').pending, true);
  assert.deepEqual([recovered.ready, recovered.recovered, recovered.state, recovered.pending, recovered.native], [true, true, 'Updated', false, 'Unchanged']);
  assert.equal(row(rows, 'recoveredOwner').same, true);
  assert.equal(row(rows, 'upgradedRegistration').version, '0.2.0');
  assert.deepEqual([row(rows, 'removed').state, row(rows, 'removed').registration, row(rows, 'removed').rootAbsent], ['Removed', 'Deleted', true]);
  passed++;
});

test('an unprovable registration target stops removal with journal and root tools retained, then fresh consent completes it', windows, async () => {
  const rows = await setup().run('target-marker-loss'), lost = row(rows, 'targetLost'), removed = row(rows, 'removed');
  assert.deepEqual(row(rows, 'registered'), { step: 'registered', ready: true, code: null, state: 'Created', journal: 'Saved', lease: 'Released', retainedLock: null });
  assert.deepEqual([lost.state, lost.code, lost.registration, lost.registrationCode, lost.journal, lost.record, lost.launcher, lost.uninstaller, lost.lease, lost.nativeWhileLost],
    ['Partial', 'REGISTRATION', 'Kept', 'TARGET', true, true, true, true, 'Released', 'Kept'], 'TARGET is unknown, not proven foreign: authority is retained');
  assert.deepEqual(row(rows, 'targetRestored'), { step: 'targetRestored', native: 'Unchanged' }, 'the recorded entry was untouched');
  assert.deepEqual([removed.state, removed.registration, removed.rootAbsent, removed.lease], ['Removed', 'Deleted', true, 'Released']);
  assert.equal(row(rows, 'kept').exists, false); passed++;
});
