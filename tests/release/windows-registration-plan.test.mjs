import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/RegistrationPlan.cs with its read-only dependencies (InstalledRecord, OwnedFiles,
// SetupOwnership, PayloadArchive) via the in-box csc.exe into a SEPARATE owned harness. Roots come from the ACTUAL engine
// (labelled SCRIPTED verifier); tiny owned fixture bytes stand in for the uninstaller and launcher and are placed and
// journaled through the actual components. The planner itself is pure: no registry, Start Menu or user folders are read
// or written by this test. String-safety probes use internal constructors as trusted-misuse inputs. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = text => createHash('sha256').update(text).digest('hex');
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.IO; using System.Security.Cryptography; using System.Text; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  static OwnedFileResult Place(string root, string name, string text, OwnedFileDescriptor prior) { byte[] b = Encoding.UTF8.GetBytes(text); return OwnedFiles.Place(root, name, b, Sha(b), prior); }
  static InstalledRecordSnapshot Copy(InstalledRecordSnapshot r, string root, string sha, string version, bool foreignRoot) {
    FileIdentity rootId = r.RootIdentity; if (foreignRoot) { rootId.Index ^= 1; }
    List<InstalledRelease> releases = new List<InstalledRelease>();
    foreach (InstalledRelease x in r.Releases) releases.Add(new InstalledRelease(x.Id, x.Id == r.ActiveReleaseId && version != null ? version : x.Version, x.ManifestSha256, x.Files, x.Bytes, x.InstalledAt));
    return new InstalledRecordSnapshot(root ?? r.Root, rootId, r.RecordIdentity, r.RecordBytes, sha ?? r.RecordSha256, r.InstallationId, r.ActiveReleaseId, releases.AsReadOnly());
  }
  static int Main(string[] a) {
    string root = a[0], mode = a[1]; JavaScriptSerializer json = new JavaScriptSerializer();
    InstalledRecordSnapshot record = InstalledRecord.Read(root);
    SetupOwnershipSnapshot absent = SetupOwnership.Read(record).Snapshot;
    OwnedFileResult u0 = Place(root, SetupOwnership.UninstallerName, "owned uninstaller fixture", null), l0 = Place(root, SetupOwnership.LauncherName, "owned launcher fixture", null);
    SetupOwnership.Save(absent, mode == "launcher-not-journaled" ? null : l0.Descriptor, u0.Descriptor);
    SetupOwnershipSnapshot journal = SetupOwnership.Read(record).Snapshot;
    // Fresh verification: placing the same approved bytes against the journal descriptors yields Unchanged.
    OwnedFileResult u = Place(root, SetupOwnership.UninstallerName, "owned uninstaller fixture", journal.Uninstaller);
    OwnedFileResult l = Place(root, SetupOwnership.LauncherName, "owned launcher fixture", journal.Launcher ?? l0.Descriptor);
    RegistrationPlanResult r;
    switch (mode) {
      case "ok": r = RegistrationPlanner.Create(record, journal, u, l); break;
      case "no-launcher": r = RegistrationPlanner.Create(record, journal, u, null); break;
      case "absent-journal": r = RegistrationPlanner.Create(record, absent, u, l); break;
      case "stale-record": r = RegistrationPlanner.Create(Copy(record, null, new string('0', 64), null, false), journal, u, l); break;
      case "foreign-root-identity": r = RegistrationPlanner.Create(Copy(record, null, null, null, true), journal, u, l); break;
      case "launcher-not-journaled": r = RegistrationPlanner.Create(record, journal, u, l); break;
      case "null-placement": r = RegistrationPlanner.Create(record, journal, null, l); break;
      case "kept-placement": r = RegistrationPlanner.Create(record, journal, new OwnedFileResult(OwnedFileState.Kept, "CHANGED", u.Descriptor, null), l); break;
      case "unknown-code": r = RegistrationPlanner.Create(record, journal, new OwnedFileResult(OwnedFileState.Unchanged, "IO", u.Descriptor, null), l); break;
      case "swapped-role": r = RegistrationPlanner.Create(record, journal, l, u); break;
      case "other-bytes": { OwnedFileDescriptor d = u.Descriptor; r = RegistrationPlanner.Create(record, journal, new OwnedFileResult(OwnedFileState.Unchanged, null, new OwnedFileDescriptor(d.Root, d.RootIdentity, d.Name, d.Bytes, new string('a', 64), d.Identity), null), l); break; }
      default: r = RegistrationPlanner.Create(Copy(record, mode.StartsWith("root:") ? Decode(mode.Substring(5)) : null, null, mode.StartsWith("version:") ? Decode(mode.Substring(8)) : null, false), journal, u, l); break;
    }
    Dictionary<string, object> o = new Dictionary<string, object>(); o["ok"] = r.Ok; o["code"] = r.Code;
    if (r.Plan != null) {
      List<object> values = new List<object>();
      foreach (RegistrationValue v in r.Plan.Values) values.Add(new object[] { v.Name, v.Kind.ToString(), v.Kind == RegistrationKind.String ? (object)v.Text : v.Number });
      o["hive"] = RegistrationPlan.Hive; o["key"] = RegistrationPlan.KeyPath; o["reverify"] = RegistrationPlan.CallerMustReverifyBeforeApply; o["values"] = values;
      o["recordSha256"] = r.Plan.RecordSha256; o["launcher"] = r.Plan.Launcher != null; o["uninstallerSha256"] = r.Plan.Uninstaller.Sha256;
      o["readOnly"] = r.Plan.Values.IsReadOnly;
    }
    Console.WriteLine(json.Serialize(o)); return 0;
  }
  static string Decode(string hex) { byte[] b = new byte[hex.Length / 2]; for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16); return Encoding.Unicode.GetString(b); }
}`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-registration-plan-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-registration-plan-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['RegistrationPlan.cs', 'InstalledRecord.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine writes the record.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = owned('bundle'); fs.mkdirSync(join(bundle, 'resources', 'node'), { recursive: true }); const files = [];
  for (const [path, text] of [['Arcane.exe', 'fixture app, never executed'], ['resources/node/node.exe', 'fixture node']]) { fs.writeFileSync(join(bundle, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) }); }
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0-preview.1', platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
  const plan = async mode => {
    const target = join(owned('install'), 'Arcane'); await engine.install({ bundle, installRoot: target });
    const r = spawnSync(harness, [target, mode], { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.stderr, '');
    return { target, ...JSON.parse(r.stdout.trim()) };
  };
  shared = { plan };
  return shared;
}
const hex = text => Buffer.from(text, 'utf16le').toString('hex');

test('the plan contains exactly the fixed current-user values for a journaled, freshly verified uninstaller and launcher', windows, async () => {
  const s = setup();
  let r = await s.plan('ok');
  const record = JSON.parse(fs.readFileSync(join(r.target, 'installation.json'), 'utf8'));
  assert.deepEqual([r.ok, r.code, r.hive, r.key, r.reverify, r.readOnly, r.launcher], [true, null, 'HKEY_CURRENT_USER', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Arcane', true, true, true]);
  assert.deepEqual(r.values, [
    ['DisplayName', 'String', 'Arcane'], ['DisplayVersion', 'String', '0.1.0-preview.1'], ['Publisher', 'String', 'Arcane'],
    ['InstallLocation', 'String', r.target], ['DisplayIcon', 'String', '"' + r.target + '\\Arcane.exe",0'],
    ['UninstallString', 'String', '"' + r.target + '\\Uninstall Arcane.exe"'], ['NoModify', 'DWord', 1], ['NoRepair', 'DWord', 1],
    ['ArcaneInstallationId', 'String', record.installationId]]);
  assert.equal(r.uninstallerSha256, sha('owned uninstaller fixture'));
  assert.equal(r.recordSha256, sha(fs.readFileSync(join(r.target, 'installation.json'))));
  r = await s.plan('no-launcher');
  assert.deepEqual([r.ok, r.launcher], [true, false]);
  assert.deepEqual(r.values.find(v => v[0] === 'DisplayIcon'), ['DisplayIcon', 'String', '"' + r.target + '\\Uninstall Arcane.exe",0'], 'icon falls back to the verified uninstaller');
  assert.equal(r.values.some(v => /Quiet|Modify|Repair/.test(v[0]) && v[1] === 'String'), false, 'no quiet or bypass string values');
});

test('absent, stale or foreign journals and unverified, kept, swapped or mismatched placements produce no plan', windows, async () => {
  const s = setup();
  for (const [mode, code] of [['absent-journal', 'JOURNAL'], ['stale-record', 'JOURNAL'], ['foreign-root-identity', 'JOURNAL'], ['launcher-not-journaled', 'JOURNAL'],
    ['null-placement', 'PLACEMENT'], ['kept-placement', 'PLACEMENT'], ['unknown-code', 'PLACEMENT'], ['swapped-role', 'PLACEMENT'], ['other-bytes', 'PLACEMENT']]) {
    const r = await s.plan(mode);
    assert.deepEqual([r.ok, r.code, r.values], [false, code, undefined], mode);
  }
});

test('unsafe root or version strings are refused rather than embedded (trusted-misuse probes)', windows, async () => {
  const s = setup();
  for (const [mode, code] of [['root:' + hex('C:\\Arc"ane'), 'ROOT'], ['root:' + hex('C:\\%TEMP%\\Arcane'), 'ROOT'], ['root:' + hex('C:\\Arc\nane'), 'ROOT'],
    ['root:' + hex('C:\\Arcane\\'), 'ROOT'], ['root:' + hex('Arcane'), 'ROOT'], ['root:' + hex('\\\\server\\share\\Arcane'), 'ROOT'], ['root:' + hex('C:\\' + 'x'.repeat(240)), 'ROOT'],
    ['version:' + hex('0.1.0\n'), 'VERSION'], ['version:' + hex('0.1.0"'), 'VERSION'], ['version:' + hex('0.1'), 'VERSION'], ['version:' + hex('%VERSION%'), 'VERSION']]) {
    const r = await s.plan(mode);
    assert.deepEqual([r.ok, r.code], [false, code], mode);
  }
});
