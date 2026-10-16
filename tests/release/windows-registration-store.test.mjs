import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/Registration.cs, RegistrationPlan.cs, SetupOwnership.cs, OwnedFiles.cs, InstalledRecord.cs,
// OperationLease.cs and PayloadArchive.cs via the in-box csc.exe into a SEPARATE owned op-script harness. Installed roots come
// from the ACTUAL engine with a labelled SCRIPTED small-inventory verifier; root files come from the ACTUAL OwnedFiles and the
// journal from the ACTUAL SetupOwnership, so the RegistrationPlanner input is real. REGISTRY SCOPE: each harness run creates
// ONLY one fresh, exclusively created VOLATILE HKCU\Software\ArcaneInstallerStoreTest-<UUID> parent marked ArcaneFixtureOwner=<GUID>
// and passes it through RegistrationTarget.OwnedFixture. CurrentUser() is never called. Fixture changes use exact owned handles;
// cleanup opens only known child names, verifies ownership markers and deletes nonrecursively through those handles. Nothing
// is enumerated. Own relative fixture names are recorded for cleanup; native object names, SIDs and other user data are not printed. Windows-only.
// ATOMIC INTENT API: Prepare is read-only and returns an intent; Apply writes all values in ONE native registry transaction; the
// production host saves the intent to journal v4 first, while this component fixture keeps a clearly labelled IN-MEMORY intent.
// Interruptions are owned exceptions thrown from the Barrier hooks; no ordinary handle reads or edits the key inside Apply.
// Cleanup admits a store-owned key only by an intent or descriptor owner captured BEFORE the mutation (fixture evidence only).
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.IO; using System.Runtime.InteropServices; using System.Security.Cryptography; using System.Text;
using System.Web.Script.Serialization; using Microsoft.Win32.SafeHandles; using Arcane.Installer;
internal static class Harness {
  const uint Query = 1, Set = 2, CreateSub = 4, ReadControl = 0x20000, Delete = 0x10000, View = 0x100, Volatile = 1;
  const uint Owned = ReadControl | Set | CreateSub | Query | Delete | View;
  static readonly IntPtr HKCU = new IntPtr(unchecked((int)0x80000001));
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegOpenKeyExW(IntPtr parent, string name, uint options, uint access, out SafeRegistryHandle key);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegOpenKeyExW(SafeRegistryHandle parent, string name, uint options, uint access, out SafeRegistryHandle key);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegCreateKeyExW(SafeRegistryHandle parent, string name, uint reserved, string cls, uint options, uint access, IntPtr security, out SafeRegistryHandle key, out uint disposition);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegSetValueExW(SafeRegistryHandle key, string name, uint reserved, uint type, byte[] data, uint size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegDeleteKeyExW(SafeRegistryHandle key, string name, uint view, uint reserved);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int RegRenameKey(SafeRegistryHandle key, string name, string newName);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  static byte[] Sz(string text) { return Encoding.Unicode.GetBytes(text + "\0"); }
  static string ReadSz(SafeRegistryHandle key, string name) { uint type; byte[] bytes = RegistryNative.Value(key, name, out type); return type == 1 ? RegistryNative.Text(bytes) : null; }

  static string root, fixtureMarker, childMarker = Guid.NewGuid().ToString("D"), subMarker = Guid.NewGuid().ToString("D");
  static SafeRegistryHandle parent; static string parentName; static bool parentCreated;
  static InstalledRecordSnapshot record; static SetupOwnershipSnapshot ownership; static OwnedFileResult launcherPlacement, uninstallerPlacement;
  static RegistrationPlan plan; static RegistrationDescriptor descriptor; static RegistrationTarget target;
  // IN-MEMORY intent (component fixture only): the production host saves it to journal v4 BEFORE Apply.
  static RegistrationIntent intent;
  static readonly HashSet<string> owners = new HashSet<string>();
  // Owned deliberate hook interruption; thrown only from the fixture Barrier.
  sealed class FixtureInterrupt : IOException { public FixtureInterrupt() : base("fixture interrupt") { } }

  // ---- fixture child operations: ONLY the known child names under the owned parent, exact handles ----
  static SafeRegistryHandle Child(string name, uint access) { SafeRegistryHandle key; int rc = RegOpenKeyExW(parent, name, 0, access, out key); if (rc != 0) { if (key != null) key.Dispose(); return null; } return key; }
  static int Mutate(string action) {
    if (action == "rename-child" || action == "rename-parent") {
      if (action == "rename-parent") { int rc = RegRenameKey(parent, null, parentName + "-moved"); if (rc == 0) parentName += "-moved"; return rc; }
      using (SafeRegistryHandle child = Child("Arcane", Owned)) return child == null ? -2 : RegRenameKey(child, null, "Arcane-moved");
    }
    if (action == "create-unrecorded" || action == "replace-child") {
      SafeRegistryHandle child; uint disposition;
      int rc = RegCreateKeyExW(parent, "Arcane", 0, null, Volatile, Owned, IntPtr.Zero, out child, out disposition);
      if (rc != 0 || disposition != 1) { if (child != null) child.Dispose(); return rc != 0 ? rc : -3; }
      using (child) {
        RegSetValueExW(child, "FixtureChildOwner", 0, 1, Sz(childMarker), (uint)Sz(childMarker).Length);
        // Plan-shaped content: never adopted merely because its fields match.
        foreach (RegistrationValue value in plan.Values)
          if (value.Kind == RegistrationKind.DWord) RegSetValueExW(child, value.Name, 0, 4, BitConverter.GetBytes(value.Number), 4);
          else RegSetValueExW(child, value.Name, 0, 1, Sz(value.Text), (uint)Sz(value.Text).Length);
      }
      return 0;
    }
    if (action == "parent-marker") { byte[] other = Sz(Guid.NewGuid().ToString("D")); return RegSetValueExW(parent, RegistrationTarget.FixtureMarker, 0, 1, other, (uint)other.Length); }
    using (SafeRegistryHandle child = Child("Arcane", Owned)) {
      if (child == null) return -2;
      if (action == "add-value") { byte[] b = Sz("fixture extra"); return RegSetValueExW(child, "FixtureExtra", 0, 1, b, (uint)b.Length); }
      if (action == "edit-value") { byte[] b = Sz("Edited by fixture"); return RegSetValueExW(child, "DisplayName", 0, 1, b, (uint)b.Length); }
      if (action == "retype-value") { byte[] b = Sz("1"); return RegSetValueExW(child, "NoModify", 0, 1, b, (uint)b.Length); }
      if (action == "add-subkey") {
        SafeRegistryHandle sub; uint disposition; int rc = RegCreateKeyExW(child, "FixtureSub", 0, null, Volatile, Owned, IntPtr.Zero, out sub, out disposition);
        if (rc != 0 || disposition != 1) { if (sub != null) sub.Dispose(); return rc != 0 ? rc : -3; }
        using (sub) RegSetValueExW(sub, "FixtureSubOwner", 0, 1, Sz(subMarker), (uint)Sz(subMarker).Length);
        return 0;
      }
      if (action == "delete-owned-child") {
        // Simulates an absent owned key: only a key whose store marker is one this harness observed is deleted, by its handle.
        if (!owners.Contains(ReadSz(child, RegistrationStore.OwnerMarker) ?? "")) return -4;
        return RegDeleteKeyExW(child, string.Empty, View, 0);
      }
    }
    return -9;
  }
  static Dictionary<string, object> ChildState() {
    Dictionary<string, object> v = new Dictionary<string, object>();
    using (SafeRegistryHandle child = Child("Arcane", Query | View)) {
      v["present"] = child != null;
      if (child != null) { uint subkeys, values; ulong time; RegistryNative.Info(child, out subkeys, out values, out time); v["values"] = values; v["subkeys"] = subkeys;
        v["extra"] = ReadSz(child, "FixtureExtra") != null; v["displayName"] = ReadSz(child, "DisplayName"); v["displayVersion"] = ReadSz(child, "DisplayVersion");
        v["fixtureChild"] = ReadSz(child, "FixtureChildOwner") == childMarker; string owner = ReadSz(child, RegistrationStore.OwnerMarker); v["storeOwnerKnown"] = owner != null && owners.Contains(owner); }
    }
    using (SafeRegistryHandle moved = Child("Arcane-moved", Query | View)) v["movedPresent"] = moved != null;
    return v;
  }
  static void Report(Dictionary<string, object> v, RegistrationResult r) {
    v["state"] = r.State.ToString(); v["code"] = r.Code; v["created"] = r.KeyCreated; v["written"] = r.ValuesWritten; v["descriptor"] = r.Descriptor != null;
    v["prepared"] = r.ValuesPrepared; v["committed"] = r.Committed;
    if (r.Descriptor != null) {
      // Models the host acknowledging a confirmed descriptor: it replaces the prior one and clears the pending intent.
      v["sameOwner"] = descriptor != null && r.Descriptor.OwnerId == descriptor.OwnerId; descriptor = r.Descriptor; owners.Add(r.Descriptor.OwnerId); intent = null;
    }
  }
  // Fixture accountability: an intent's owner nonce is captured BEFORE any mutation (cleanup evidence only, never adoption).
  static void Prepared(Dictionary<string, object> v, RegistrationPreparation p) {
    intent = p.Intent; v["intent"] = intent != null; if (intent != null) owners.Add(intent.OwnerId);
    v["sameIntentOwner"] = intent != null && descriptor != null && intent.OwnerId == descriptor.OwnerId;
  }

  // ---- bounded nonrecursive cleanup of exactly what this run owns ----
  static List<object> Cleanup() {
    List<object> retained = new List<object>();
    if (parent == null || !parentCreated) return retained;
    foreach (string name in new[] { "Arcane", "Arcane-moved" }) {
      using (SafeRegistryHandle child = Child(name, Owned)) {
        if (child == null) continue;
        using (SafeRegistryHandle sub = OpenSub(child)) {
          if (sub != null) { if (ReadSz(sub, "FixtureSubOwner") == subMarker && RegDeleteKeyExW(sub, string.Empty, View, 0) == 0) { } else { retained.Add("HKCU\\Software\\" + parentName + "\\" + name + "\\FixtureSub"); continue; } }
        }
        string store = ReadSz(child, RegistrationStore.OwnerMarker), fixture = ReadSz(child, "FixtureChildOwner"), installation = ReadSz(child, RegistrationPlanner.MarkerName);
        bool ours = (store != null && owners.Contains(store)) || fixture == childMarker;
        if (!ours || RegDeleteKeyExW(child, string.Empty, View, 0) != 0) retained.Add("HKCU\\Software\\" + parentName + "\\" + name);
      }
    }
    // The parent is deleted only through its own creation handle (its marker may have been deliberately edited by a test).
    if (retained.Count > 0 || RegDeleteKeyExW(parent, string.Empty, View, 0) != 0) retained.Add("HKCU\\Software\\" + parentName);
    parent.Dispose(); return retained;
  }
  static SafeRegistryHandle OpenSub(SafeRegistryHandle child) { SafeRegistryHandle sub; int rc = RegOpenKeyExW(child, "FixtureSub", 0, Query | Delete | View, out sub); if (rc != 0) { if (sub != null) sub.Dispose(); return null; } return sub; }

  static int Main(string[] a) {
    root = a[0]; List<object> retained = null; int exit = 0;
    try {
      for (int i = 1; i < a.Length; i++) {
        Dictionary<string, object> v = new Dictionary<string, object>(); v["op"] = a[i];
        switch (a[i]) {
          case "fixture": {
            SafeRegistryHandle software; int rc = RegOpenKeyExW(HKCU, "Software", 0, CreateSub | View, out software); v["openSoftware"] = rc;
            using (software) {
              uint disposition; string name = "ArcaneInstallerStoreTest-" + Guid.NewGuid().ToString("N");
              rc = RegCreateKeyExW(software, name, 0, null, Volatile, Owned, IntPtr.Zero, out parent, out disposition);
              v["create"] = rc; v["disposition"] = disposition;
              if (rc != 0 || disposition != 1) { if (parent != null) parent.Dispose(); parent = null; throw new IOException("fixture parent unavailable"); }
              parentCreated = true; parentName = name; fixtureMarker = Guid.NewGuid().ToString("D");
              v["relativeParent"] = parentName; v["fixtureOwner"] = fixtureMarker;
              v["marker"] = RegSetValueExW(parent, RegistrationTarget.FixtureMarker, 0, 1, Sz(fixtureMarker), (uint)Sz(fixtureMarker).Length);
              target = RegistrationTarget.OwnedFixture(parent, fixtureMarker); v["target"] = true;
            }
            break; }
          case "plan": {
            // Actual record, actual root-file placements and journal, then the actual planner.
            byte[] l = File.ReadAllBytes(a[++i]), u = File.ReadAllBytes(a[++i]);
            record = InstalledRecord.Read(root); ownership = SetupOwnership.Read(record).Snapshot;
            launcherPlacement = OwnedFiles.Place(root, SetupOwnership.LauncherName, l, Sha(l), ownership.Launcher);
            uninstallerPlacement = OwnedFiles.Place(root, SetupOwnership.UninstallerName, u, Sha(u), ownership.Uninstaller);
            if (!ownership.Present) { SetupOwnership.Save(ownership, launcherPlacement.Descriptor, uninstallerPlacement.Descriptor); ownership = SetupOwnership.Read(record).Snapshot; }
            RegistrationPlanResult r = RegistrationPlanner.Create(record, ownership, uninstallerPlacement, launcherPlacement);
            v["ok"] = r.Ok; v["code"] = r.Code; plan = r.Plan; if (plan != null) v["version"] = plan.Values[1].Text; break; }
          // "place" = Prepare then (only with an intent) Apply: the former one-call Place, now two-phase.
          case "place": case "place-unrecorded": {
            RegistrationPreparation p = RegistrationStore.Prepare(plan, a[i] == "place" ? descriptor : null, target); Prepared(v, p);
            Report(v, intent == null ? p.Observation : RegistrationStore.Apply(plan, a[i] == "place" ? descriptor : null, intent, target)); break; }
          case "prepare": { RegistrationPreparation p = RegistrationStore.Prepare(plan, descriptor, target); Report(v, p.Observation); Prepared(v, p); break; } // the observation is not an acknowledgement: keep the intent
          case "apply": Report(v, RegistrationStore.Apply(plan, descriptor, intent, target)); break;
          case "apply-forged": {
            // Exact-intent refusal: the same plan with an intent whose hash or owner does not match it.
            string how = a[++i]; v["how"] = how;
            RegistrationIntent forged = how == "hash" ? new RegistrationIntent(intent.OwnerId, new string('0', 64)) : new RegistrationIntent(Guid.NewGuid().ToString("D"), intent.ValuesSha256);
            owners.Add(forged.OwnerId); Report(v, RegistrationStore.Apply(plan, descriptor, forged, target)); break; }
          case "place-malformed": {
            List<RegistrationValue> bad = new List<RegistrationValue>(plan.Values); bad[0] = new RegistrationValue("DisplayName", "Not Arcane");
            RegistrationPreparation p = RegistrationStore.Prepare(new RegistrationPlan(plan.InstallationId, plan.Root, plan.RecordSha256, plan.Uninstaller, plan.Launcher, bad.AsReadOnly()), descriptor, target);
            Prepared(v, p); Report(v, p.Observation); break; }
          case "verify": Report(v, RegistrationStore.Verify(descriptor, record.InstallationId, target)); break;
          case "reconcile": Report(v, RegistrationStore.Reconcile(descriptor, intent, record.InstallationId, target)); break;
          case "remove": Report(v, RegistrationStore.Remove(descriptor, record.InstallationId, target)); break;
          case "remove-pending": Report(v, RegistrationStore.Remove(descriptor, intent, record.InstallationId, target)); break;
          case "forget-intent": intent = null; break; // models a host with no durable pending record
          case "query-without-access": {
            // Open only our known fixture child with SET_VALUE, without changing its ACL or values. Native queries
            // through this handle must fail; the store must report unreadability rather than a proved manual edit.
            using (SafeRegistryHandle restricted = Child("Arcane", RegistryNative.Set | View)) {
              if (restricted == null) throw new IOException("Restricted fixture handle unavailable.");
              uint subkeys, values, type; ulong time; int error;
              v["info"] = RegistryNative.Info(restricted, out subkeys, out values, out time);
              v["value"] = RegistryNative.Value(restricted, RegistrationStore.OwnerMarker, out type, out error) != null;
              v["valueError"] = error;
              try {
                typeof(RegistrationStore).GetMethod("Read", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
                  .Invoke(null, new object[] { restricted, 10, (ulong)0, false });
                v["read"] = "returned";
              } catch (System.Reflection.TargetInvocationException e) { v["read"] = e.InnerException.GetType().Name; }
            }
            break; }
          case "mutate": v["action"] = a[++i]; v["rc"] = Mutate((string)v["action"]); break;
          // One-shot deliberate hook exception at the nth occurrence of a stage. No ordinary handle touches the key inside Apply.
          case "interrupt": { string stage = a[++i]; int nth = int.Parse(a[++i]), seen = 0; bool fired = false;
            RegistrationStore.Barrier = delegate(string s) { if (!fired && s == stage && ++seen == nth) { fired = true; throw new FixtureInterrupt(); } };
            continue; }
          // Ordinary fixture edit at Remove's before-delete hook, which runs BEFORE its transaction exists (never inside Apply).
          case "edit-before-delete": { string action = a[++i]; bool fired = false;
            RegistrationStore.Barrier = delegate(string s) { if (!fired && s == "before-delete") { fired = true; Out(new Dictionary<string, object> { { "op", "barrier" }, { "stage", s }, { "action", action }, { "rc", Mutate(action) } }); } };
            continue; }
          case "wait": Out(v); Console.In.ReadLine(); continue;
          case "child": foreach (KeyValuePair<string, object> e in ChildState()) v[e.Key] = e.Value; break;
        }
        Out(v);
      }
    }
    catch (Exception e) { exit = 3; Out(new Dictionary<string, object> { { "op", "error" }, { "type", e.GetType().Name } }); }
    finally {
      RegistrationStore.Barrier = null;
      try { retained = Cleanup(); } catch (Exception) { retained = new List<object> { "cleanup-exception" }; }
      Out(new Dictionary<string, object> { { "op", "cleanup" }, { "parentCreated", parentCreated }, { "retained", retained } });
    }
    return retained.Count == 0 ? exit : 4;
  } }`;

let shared, nativeFailure = false;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), owner = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-registration-store-test-')));
  process.on('exit', () => { const p = relative(boundary, owner); if (!nativeFailure && !process.exitCode && p.startsWith('arcane-registration-store-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(owner, { recursive: true, force: true }); else console.error('Retained owned registry fixture artifacts: ' + owner); });
  const build = join(owner, 'build'); fs.mkdirSync(build);
  const sources = ['Registration.cs', 'RegistrationPlan.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['systemroot', 'windir', 'temp', 'tmp', 'path'].includes(k.toLowerCase())));
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', env: environment });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0, runCount = 0;
  const owned = name => { const dir = join(owner, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED small-inventory verifier (fixture hashes only); the actual engine writes each record.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(sha(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = version => {
    const dir = owned('bundle'); fs.mkdirSync(join(dir, 'resources', 'node'), { recursive: true }); const files = [];
    for (const [path, text] of [['Arcane.exe', 'fixture app ' + version], ['resources/node/node.exe', 'fixture node']]) { fs.writeFileSync(join(dir, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) }); }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version, platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  const launcher = join(build, 'launcher.bin'), uninstaller = join(build, 'uninstaller.bin');
  fs.writeFileSync(launcher, 'owned launcher fixture'); fs.writeFileSync(uninstaller, 'owned uninstaller fixture');
  const installed = async (version = '0.1.0') => { const target = join(owned('install'), 'Arcane'); await engine.install({ bundle: bundle(version), installRoot: target }); return target; };
  /** Runs an op script; observes the actual child close; stdout bounded; never kills or retries. */
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', seen = 0, chain = Promise.resolve();
    child.stdout.on('data', d => {
      out += d; if (out.length > 1_000_000) reject(new Error('stdout bound exceeded'));
      const lines = out.split(/\r?\n/); lines.pop();
      for (const line of lines.slice(seen)) { seen++; if (line && JSON.parse(line).op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(action).then(() => child.stdin.write('go\n'), reject); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => chain.then(() => {
      child.stdin.destroy(); const rows = out.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), cleanup = rows.find(r => r.op === 'cleanup');
      fs.writeFileSync(join(owner, 'native-run-' + (++runCount) + '.json'), JSON.stringify({ code, err, rows }) + '\n');
      if (code !== 0 || err || !cleanup || cleanup.retained.length) { nativeFailure = true; reject(new Error('harness ' + code + ' ' + err + ' retained=' + JSON.stringify(cleanup?.retained) + ' rows=' + JSON.stringify(rows))); }
      else resolve({ code, rows: rows.filter(r => r.op !== 'wait') });
    }));
  });
  shared = { engine, bundle, installed, run, launcher, uninstaller };
  return shared;
}
const ops = (...items) => items;
const by = (rows, op) => rows.filter(r => r.op === op);
const result = r => [r.state, r.code, r.created, r.written, r.descriptor];
const atomic = r => [r.state, r.code, r.created, r.written, r.prepared, r.committed, r.descriptor];

test('atomic create, exact verify and an unchanged repeat write nothing; a new actual plan updates the same owner', windows, async () => {
  const s = setup(), target = await s.installed('0.1.0');
  let { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'verify', 'place', 'child', 'wait', 'plan', s.launcher, s.uninstaller, 'place', 'child'),
    [() => s.engine.install({ bundle: s.bundle('0.2.0'), installRoot: target })]);
  assert.equal(code, 0); assert.deepEqual(by(rows, 'plan')[0].ok, true);
  const [created, repeat, updated] = by(rows, 'place');
  assert.deepEqual([...atomic(created), created.intent], ['Created', null, true, 10, 10, true, true, true], 'one committed transaction of 10 values');
  assert.deepEqual(result(by(rows, 'verify')[0]), ['Unchanged', null, false, 0, true]);
  assert.deepEqual([...result(repeat), repeat.sameOwner, repeat.intent], ['Unchanged', null, false, 0, true, true, false], 'exact unchanged: no intent, nothing written');
  assert.deepEqual([by(rows, 'child')[0].values, by(rows, 'child')[0].displayVersion, by(rows, 'child')[0].storeOwnerKnown], [10, '0.1.0', true]);
  // The actual engine upgraded the same installation at the wait step; the new actual plan updates the recorded key in place.
  assert.deepEqual([by(rows, 'plan')[1].ok, by(rows, 'plan')[1].version], [true, '0.2.0']);
  assert.deepEqual([...atomic(updated), updated.sameOwner, updated.sameIntentOwner], ['Updated', null, false, 10, 10, true, true, true, true], 'same owner preserved');
  assert.equal(by(rows, 'child')[1].displayVersion, '0.2.0');
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'mutate', 'delete-owned-child', 'place', 'child')));
  assert.equal(code, 0);
  const [first, recreated] = by(rows, 'place');
  assert.deepEqual(result(first), ['Created', null, true, 10, true]);
  assert.deepEqual([...result(recreated), recreated.sameOwner], ['Created', null, true, 10, true, false], 'an absent owned key is recreated with a fresh owner');
  assert.equal(by(rows, 'child')[0].displayVersion, '0.2.0');
});

test('Remove deletes the exact recorded key through its handle and then reports Absent', windows, async () => {
  const s = setup(), target = await s.installed('0.1.0');
  const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'remove', 'child', 'remove'));
  assert.equal(code, 0);
  assert.deepEqual(result(by(rows, 'remove')[0]), ['Deleted', null, false, 0, false]);
  assert.equal(by(rows, 'child')[0].present, false);
  assert.deepEqual(result(by(rows, 'remove')[1]), ['Absent', null, false, 0, false], 'a second removal reports Absent');
});

test('an unrecorded existing key is never written or adopted, even when every field matches the plan', windows, async () => {
  const s = setup();
  let target = await s.installed();
  let { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'mutate', 'create-unrecorded', 'child', 'place-unrecorded', 'reconcile', 'child'));
  assert.equal(code, 0); assert.equal(by(rows, 'mutate')[0].rc, 0);
  let [before, after] = by(rows, 'child');
  assert.deepEqual([...result(by(rows, 'place-unrecorded')[0]), by(rows, 'place-unrecorded')[0].intent], ['Kept', 'UNRECORDED', false, 0, false, false]);
  // The fixture's own FixtureChildOwner value makes the shape differ (11 values), so it is CHANGED before the UNRECORDED distinction.
  assert.deepEqual(result(by(rows, 'reconcile')[0]), ['Kept', 'CHANGED', false, 0, false], 'no prior and no pending intent admits nothing');
  assert.deepEqual(after, before, 'not one value written'); assert.equal(after.fixtureChild, true);
  // A key that appears after Prepare saw absence is still never adopted by Apply's creation path.
  target = await s.installed();
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'prepare', 'mutate', 'create-unrecorded', 'child', 'apply', 'child')));
  assert.equal(code, 0);
  const prepared = by(rows, 'prepare')[0], applied = by(rows, 'apply')[0];
  assert.deepEqual([prepared.state, prepared.intent], ['Absent', true]);
  assert.deepEqual([applied.state, applied.created, applied.written, applied.committed, applied.descriptor], ['Kept', false, 0, false, false], 'appeared key kept: ' + applied.code);
  [before, after] = by(rows, 'child');
  assert.deepEqual(after, before, 'the appeared key is untouched'); assert.equal(after.fixtureChild, true);
});

test('added, edited and wrongly typed values and added subkeys keep the key for Verify, Place and Remove', windows, async () => {
  const s = setup();
  for (const action of ['add-value', 'edit-value', 'retype-value', 'add-subkey']) {
    const target = await s.installed();
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'mutate', action, 'child', 'verify', 'place', 'remove', 'child'));
    assert.equal(code, 0, action); assert.equal(by(rows, 'mutate')[0].rc, 0, action);
    const [before, after] = by(rows, 'child');
    assert.deepEqual(result(by(rows, 'verify')[0]), ['Kept', 'CHANGED', false, 0, false], action + ' verify');
    assert.deepEqual([...result(by(rows, 'place')[1]), by(rows, 'place')[1].intent], ['Kept', 'CHANGED', false, 0, false, false], action + ' place');
    assert.deepEqual(result(by(rows, 'remove')[0]), ['Kept', 'CHANGED', false, 0, false], action + ' remove');
    assert.deepEqual(after, before, action + ': retained untouched');
  }
});

test('a manual change between Prepare and Apply keeps the recorded key untouched', windows, async () => {
  const s = setup();
  for (const action of ['edit-value', 'add-value', 'add-subkey']) {
    const target = await s.installed('0.1.0');
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'wait', 'plan', s.launcher, s.uninstaller, 'prepare', 'mutate', action, 'child', 'apply', 'child'),
      [() => s.engine.install({ bundle: s.bundle('0.2.0'), installRoot: target })]);
    assert.equal(code, 0, action);
    assert.deepEqual([by(rows, 'prepare')[0].state, by(rows, 'prepare')[0].intent], ['Unchanged', true], action + ': a legitimate update was prepared');
    const applied = by(rows, 'apply')[0];
    assert.deepEqual([applied.state, applied.created, applied.written, applied.committed, applied.descriptor], ['Kept', false, 0, false, false], action + ': ' + applied.code);
    const [before, after] = by(rows, 'child');
    assert.deepEqual(after, before, action + ': untouched'); assert.equal(after.displayVersion, '0.1.0');
  }
});

test('an Apply with an intent that does not exactly match the plan is refused before any key is created', windows, async () => {
  const s = setup();
  for (const how of ['hash', 'owner']) {
    const target = await s.installed();
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'prepare', 'apply-forged', how, 'child'));
    assert.equal(code, 0, how);
    const applied = by(rows, 'apply-forged')[0];
    assert.deepEqual([applied.state, applied.created, applied.written, applied.prepared, applied.descriptor], ['Refused', false, 0, 0, false], how + ': ' + applied.code);
    assert.equal(by(rows, 'child')[0].present, false, how);
  }
});

test('fixture parent marker or name changes and child rename or replacement are retained', windows, async () => {
  const s = setup();
  for (const action of ['parent-marker', 'rename-parent']) {
    const target = await s.installed();
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'mutate', action, 'verify', 'place', 'remove'));
    assert.equal(code, 0, action);
    assert.deepEqual(result(by(rows, 'verify')[0]), ['Kept', 'TARGET', false, 0, false], action);
    assert.deepEqual(result(by(rows, 'place')[1]), ['Refused', 'TARGET', false, 0, false], action);
    assert.deepEqual(result(by(rows, 'remove')[0]), ['Kept', 'TARGET', false, 0, false], action);
  }
  let target = await s.installed();
  let { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'mutate', 'rename-child', 'remove', 'child'));
  assert.equal(code, 0);
  assert.deepEqual(result(by(rows, 'remove')[0]), ['Absent', null, false, 0, false], 'nothing at the fixed name to remove');
  assert.deepEqual([by(rows, 'child')[0].present, by(rows, 'child')[0].movedPresent], [false, true], 'the renamed owned key is not followed or deleted');
  target = await s.installed();
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'mutate', 'rename-child', 'mutate', 'replace-child', 'remove', 'verify', 'child')));
  assert.equal(code, 0);
  assert.deepEqual(result(by(rows, 'remove')[0]), ['Kept', 'CHANGED', false, 0, false], 'a replacement at the fixed name is kept');
  assert.deepEqual(result(by(rows, 'verify')[0]), ['Kept', 'CHANGED', false, 0, false]);
  assert.deepEqual([by(rows, 'child')[0].fixtureChild, by(rows, 'child')[0].movedPresent], [true, true]);
});

test('a malformed plan is refused before any key is created', windows, async () => {
  const s = setup(), target = await s.installed();
  const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place-malformed', 'child'));
  assert.equal(code, 0);
  assert.deepEqual([...result(by(rows, 'place-malformed')[0]), by(rows, 'place-malformed')[0].intent], ['Refused', 'PLAN', false, 0, false, false]);
  assert.equal(by(rows, 'child')[0].present, false);
});

test('creation interrupted mid-write or before commit rolls back: no key, honest prepared count, nothing committed', windows, async () => {
  const s = setup();
  for (const [stage, nth, prepared] of [['before-value', 2, 1], ['before-value', 5, 4], ['before-commit', 1, 10]]) {
    const target = await s.installed();
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'interrupt', stage, String(nth), 'place', 'child', 'reconcile'));
    assert.equal(code, 0, stage + nth);
    assert.deepEqual(atomic(by(rows, 'place')[0]), ['Refused', 'INTERRUPTED', false, 0, prepared, false, false], stage + nth);
    assert.equal(by(rows, 'child')[0].present, false, stage + nth + ': rolled back, no half key');
    assert.deepEqual(result(by(rows, 'reconcile')[0]), ['Absent', null, false, 0, false], stage + nth + ': pending intent resolves to proven absence');
    assert.match(by(rows, 'fixture')[0].relativeParent, /^ArcaneInstallerStoreTest-[a-f0-9]{32}$/);
    assert.deepEqual(by(rows, 'cleanup')[0].retained, []);
  }
});

test('an update interrupted mid-write or before commit keeps the confirmed values and descriptor', windows, async () => {
  const s = setup();
  for (const [stage, nth, prepared] of [['before-value', 3, 2], ['before-commit', 1, 10]]) {
    const target = await s.installed('0.1.0');
    const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'child', 'wait', 'plan', s.launcher, s.uninstaller, 'interrupt', stage, String(nth), 'place', 'child', 'verify', 'reconcile'),
      [() => s.engine.install({ bundle: s.bundle('0.2.0'), installRoot: target })]);
    assert.equal(code, 0, stage);
    assert.deepEqual(atomic(by(rows, 'place')[1]), ['Refused', 'INTERRUPTED', false, 0, prepared, false, false], stage);
    const [before, after] = by(rows, 'child');
    assert.deepEqual(after, before, stage + ': original values restored'); assert.equal(after.displayVersion, '0.1.0');
    assert.deepEqual(result(by(rows, 'verify')[0]), ['Unchanged', null, false, 0, true], stage + ': the prior descriptor (incl. last-write time) still matches');
    assert.deepEqual(result(by(rows, 'reconcile')[0]), ['Unchanged', null, false, 0, true], stage + ': reconciles to the prior confirmed state');
  }
});

test('a commit before acknowledgement is reconciled only through the exact pending intent, then removed', windows, async () => {
  const s = setup();
  let target = await s.installed();
  // Committed, then the deliberate after-commit exception: no descriptor reaches the caller.
  let { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'interrupt', 'after-commit', '1', 'place', 'child', 'reconcile', 'remove', 'child'));
  assert.equal(code, 0);
  assert.deepEqual(atomic(by(rows, 'place')[0]), ['Unknown', 'IO', true, 10, 10, true, false], 'committed but not acknowledged');
  assert.deepEqual([by(rows, 'child')[0].present, by(rows, 'child')[0].values, by(rows, 'child')[0].storeOwnerKnown], [true, 10, true]);
  assert.deepEqual(result(by(rows, 'reconcile')[0]), ['Unchanged', null, false, 0, true], 'exact pending owner + typed hash admits the committed key');
  assert.deepEqual(result(by(rows, 'remove')[0]), ['Deleted', null, false, 0, false]);
  assert.equal(by(rows, 'child')[1].present, false);
  // Removal can resolve the pending intent itself.
  target = await s.installed();
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'interrupt', 'after-commit', '1', 'place', 'remove-pending', 'child')));
  assert.equal(code, 0);
  assert.deepEqual(result(by(rows, 'remove-pending')[0]), ['Deleted', null, false, 0, false]);
  assert.equal(by(rows, 'child')[0].present, false);
  // Without the durable intent the committed key is unrecorded; changed data is never admitted by its owner alone.
  target = await s.installed();
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'interrupt', 'after-commit', '1', 'place', 'mutate', 'edit-value', 'child',
    'reconcile', 'remove-pending', 'forget-intent', 'reconcile', 'child')));
  assert.equal(code, 0);
  const [edited, unrecorded] = by(rows, 'reconcile');
  assert.deepEqual(result(edited), ['Kept', 'CHANGED', false, 0, false], 'pending owner matches but the typed hash does not');
  assert.deepEqual(result(by(rows, 'remove-pending')[0]), ['Kept', 'CHANGED', false, 0, false]);
  assert.deepEqual(result(unrecorded), ['Kept', 'UNRECORDED', false, 0, false]);
  const [before, after] = by(rows, 'child');
  assert.deepEqual(after, before, 'edited committed key retained untouched'); assert.equal(after.displayName, 'Edited by fixture');
});

test('an update committed before acknowledgement reconciles to the new descriptor with the same owner', windows, async () => {
  const s = setup(), target = await s.installed('0.1.0');
  const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'wait', 'plan', s.launcher, s.uninstaller,
    'interrupt', 'after-commit', '1', 'place', 'verify', 'reconcile', 'verify', 'child'), [() => s.engine.install({ bundle: s.bundle('0.2.0'), installRoot: target })]);
  assert.equal(code, 0);
  assert.deepEqual(atomic(by(rows, 'place')[1]), ['Unknown', 'IO', false, 10, 10, true, false]);
  const [stale, confirmed] = by(rows, 'verify');
  assert.deepEqual(result(stale), ['Kept', 'CHANGED', false, 0, false], 'the old descriptor no longer matches the committed update');
  assert.deepEqual([...result(by(rows, 'reconcile')[0]), by(rows, 'reconcile')[0].sameOwner], ['Unchanged', null, false, 0, true, true]);
  assert.deepEqual(result(confirmed), ['Unchanged', null, false, 0, true], 'the reconciled descriptor verifies');
  assert.equal(by(rows, 'child')[0].displayVersion, '0.2.0');
});

test('Remove: an edit at before-delete is caught by the transacted reread; an interruption after the staged delete rolls back', windows, async () => {
  const s = setup();
  let target = await s.installed();
  let { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'edit-before-delete', 'edit-value', 'remove', 'child'));
  assert.equal(code, 0); assert.equal(by(rows, 'barrier')[0].rc, 0);
  assert.deepEqual(atomic(by(rows, 'remove')[0]), ['Kept', 'CHANGED', false, 0, 0, false, false], 'owned key edited just before the delete transaction is kept');
  assert.deepEqual([by(rows, 'child')[0].present, by(rows, 'child')[0].displayName], [true, 'Edited by fixture']);
  target = await s.installed();
  ({ code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'child', 'interrupt', 'before-delete-commit', '1', 'remove', 'child', 'verify', 'remove', 'child')));
  assert.equal(code, 0);
  const [interrupted, removed] = by(rows, 'remove'), [before, after, gone] = by(rows, 'child');
  assert.deepEqual(atomic(interrupted), ['Kept', 'INTERRUPTED', false, 0, 0, false, false], 'staged deletion rolled back');
  assert.deepEqual(after, before, 'the key and its values survive the rolled-back delete');
  assert.deepEqual(result(by(rows, 'verify')[0]), ['Unchanged', null, false, 0, true], 'the descriptor still verifies after rollback');
  assert.deepEqual(atomic(removed), ['Deleted', null, false, 0, 0, true, false]);
  assert.equal(gone.present, false);
});

test('native query failures stay unreadable and preserve the confirmed entry', windows, async () => {
  const s = setup(), target = await s.installed();
  const { code, rows } = await s.run(target, ops('fixture', 'plan', s.launcher, s.uninstaller, 'place', 'child', 'query-without-access', 'child', 'verify', 'remove'));
  assert.equal(code, 0);
  const queried = by(rows, 'query-without-access')[0];
  assert.deepEqual([queried.info, queried.value, queried.valueError, queried.read], [false, false, 5, 'IOException']);
  assert.deepEqual(by(rows, 'child')[1], by(rows, 'child')[0], 'restricted observation changes no values');
  assert.deepEqual(result(by(rows, 'verify')[0]), ['Unchanged', null, false, 0, true]);
  assert.deepEqual(result(by(rows, 'remove')[0]), ['Deleted', null, false, 0, false]);
});
