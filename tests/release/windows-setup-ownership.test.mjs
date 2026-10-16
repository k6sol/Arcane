import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/SetupOwnership.cs with OwnedFiles.cs, InstalledRecord.cs and PayloadArchive.cs (read-only
// helpers) via the in-box .NET Framework csc.exe into a SEPARATE owned op-script harness, so one journal snapshot can be
// carried across steps while the test changes the owned root in between. Installed roots come from the ACTUAL engine with
// a labelled SCRIPTED small verifier. Races use OwnedFiles' existing trusted Barrier seam (assigned only by this harness).
// No launcher binaries are run; no user Programs, registry, shortcuts, providers or Studio. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.IO; using System.Collections.Generic; using System.Security.Cryptography; using System.Text; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static object D(OwnedFileDescriptor d) { if (d == null) return null; Dictionary<string, object> v = new Dictionary<string, object>();
    v["root"] = d.Root; v["name"] = d.Name; v["bytes"] = d.Bytes; v["sha256"] = d.Sha256; v["volume"] = d.Identity.Volume.ToString("x8"); v["index"] = d.Identity.Index.ToString("x16"); return v; }
  private static object SD(OwnedFileDescriptor d) { if (d == null) return null; Dictionary<string, object> v = new Dictionary<string, object>();
    v["root"] = d.Root; v["rootVolume"] = d.RootIdentity.Volume.ToString("x8"); v["rootIndex"] = d.RootIdentity.Index.ToString("x16"); v["name"] = d.Name; v["bytes"] = d.Bytes; v["sha256"] = d.Sha256;
    v["volume"] = d.Identity.Volume.ToString("x8"); v["index"] = d.Identity.Index.ToString("x16"); return v; }
  private static OwnedFileDescriptor Shortcut(string spec) {
    if (spec == "null") return null;
    int colon = spec.IndexOf(':'); string kind = spec.Substring(0, colon), root = spec.Substring(colon + 1);
    FileIdentity rootId = new FileIdentity(); rootId.Volume = 0x11; rootId.Index = 0x22; FileIdentity id = new FileIdentity(); id.Volume = 0x33; id.Index = 0x44;
    string sha = Sha(Encoding.UTF8.GetBytes("lnk"));
    if (kind == "badname") return new OwnedFileDescriptor(root, rootId, "Other.lnk", 2336, sha, id);
    if (kind == "small") return new OwnedFileDescriptor(root, rootId, SetupOwnership.ShortcutName, 75, sha, id);
    if (kind == "large") return new OwnedFileDescriptor(root, rootId, SetupOwnership.ShortcutName, 65537, sha, id);
    if (kind == "badsha") return new OwnedFileDescriptor(root, rootId, SetupOwnership.ShortcutName, 2336, sha.ToUpperInvariant(), id);
    return new OwnedFileDescriptor(root, rootId, SetupOwnership.ShortcutName, 2336, sha, id);
  }
  private static object RD(RegistrationDescriptor d) { return d == null ? null : (object)new Dictionary<string, object> { { "ownerId", d.OwnerId }, { "valuesSha256", d.ValuesSha256 }, { "lastWriteTime", d.LastWriteTime.ToString("x16") } }; }
  private static RegistrationDescriptor Registration(string spec) {
    if (spec == "null") return null;
    return new RegistrationDescriptor(spec == "bad-owner" ? "../other" : "d6b2b661-c7bf-4e40-94e0-4c26096c5c15",
      spec == "bad-sha" ? "BAD" : Sha(Encoding.UTF8.GetBytes("typed-registration")), spec == "zero" ? 0UL : 0x0123456789abcdefUL);
  }
  private static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  private static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  private static int Main(string[] a) {
    string root = a[0]; SetupOwnershipSnapshot S = null; OwnedFileDescriptor L = null, U = null;
    InstalledRecordSnapshot R = null; OperationLease A = null;
    for (int i = 1; i < a.Length; i++) {
      Dictionary<string, object> v = new Dictionary<string, object>(); v["op"] = a[i];
      switch (a[i]) {
        case "read": {
          try { R = InstalledRecord.Read(root); OwnershipRead r = SetupOwnership.Read(R); S = r.Snapshot; v["state"] = r.State.ToString(); v["code"] = r.Code;
            v["present"] = S == null ? (object)null : S.Present; v["launcher"] = S == null ? null : D(S.Launcher); v["uninstaller"] = S == null ? null : D(S.Uninstaller); v["shortcut"] = S == null ? null : SD(S.Shortcut); v["registration"] = S == null ? null : RD(S.Registration); }
          catch (InstalledRecordException e) { v["state"] = "RecordError"; v["code"] = e.Code; S = null; }
          break; }
        case "acquire": case "acquire-other": {
          LeaseResult result = OperationLease.Acquire(a[i] == "acquire" ? R : InstalledRecord.Read(a[++i])); A = result.Lease;
          v["state"] = result.State.ToString(); v["code"] = result.Code; break; }
        case "release": { LeaseRelease result = A.Release(); v["state"] = result.State.ToString(); v["code"] = result.Code; break; }
        case "dispose": A.Dispose(); v["retained"] = A.Retained; break;
        case "journal-read-old": case "read-with-lease": case "read-null-lease": {
          OwnershipRead result = a[i] == "journal-read-old" ? SetupOwnership.Read(R) : SetupOwnership.Read(R, a[i] == "read-null-lease" ? null : A);
          v["state"] = result.State.ToString(); v["code"] = result.Code;
          if (result.Snapshot != null) S = result.Snapshot; break; }
        case "place-launcher": case "place-uninstaller": {
          bool launcher = a[i] == "place-launcher"; byte[] bytes = File.ReadAllBytes(a[++i]);
          OwnedFileResult r = OwnedFiles.Place(root, launcher ? SetupOwnership.LauncherName : SetupOwnership.UninstallerName, bytes, Sha(bytes), launcher ? (L ?? (S == null ? null : S.Launcher)) : (U ?? (S == null ? null : S.Uninstaller)));
          if (launcher) L = r.Descriptor; else U = r.Descriptor; v["state"] = r.State.ToString(); v["code"] = r.Code; break; }
        case "save": case "save-with-lease": case "save-null-lease": {
          string operation = a[i];
          OwnedFileDescriptor l = Pick(a[++i], L, S == null ? null : S.Launcher, S), u = Pick(a[++i], U, S == null ? null : S.Uninstaller, S);
          OwnershipSave r = operation == "save" ? SetupOwnership.Save(S, l, u) : SetupOwnership.Save(S, l, u, operation == "save-null-lease" ? null : A);
          v["state"] = r.State.ToString(); v["code"] = r.Code;
          v["placement"] = r.Placement == null ? null : (object)new Dictionary<string, object> { { "state", r.Placement.State.ToString() }, { "code", r.Placement.Code }, { "backup", r.Placement.RetainedBackup } };
          if (r.Snapshot != null) S = r.Snapshot; break; }
        case "save-shortcut": case "save-shortcut-null-lease": {
          OwnershipSave r = SetupOwnership.SaveShortcut(S, Shortcut(a[++i]), a[i - 1] == "save-shortcut-null-lease" ? null : A);
          v["state"] = r.State.ToString(); v["code"] = r.Code; v["shortcut"] = r.Snapshot == null ? null : SD(r.Snapshot.Shortcut);
          v["placement"] = r.Placement == null ? null : (object)new Dictionary<string, object> { { "state", r.Placement.State.ToString() }, { "code", r.Placement.Code }, { "backup", r.Placement.RetainedBackup } };
          if (r.Snapshot != null) S = r.Snapshot; break; }
        case "save-registration": case "save-registration-null-lease": {
          string operation = a[i]; RegistrationDescriptor d = Registration(a[++i]);
          OwnershipSave r = SetupOwnership.SaveRegistration(S, d, operation == "save-registration-null-lease" ? null : A);
          v["state"] = r.State.ToString(); v["code"] = r.Code; v["registration"] = r.Snapshot == null ? null : RD(r.Snapshot.Registration);
          v["placement"] = r.Placement == null ? null : (object)new object[] { r.Placement.State.ToString(), r.Placement.Code };
          if (r.Snapshot != null) S = r.Snapshot; break; }
        case "wait": Out(v); Console.In.ReadLine(); continue;
        case "barrier": OwnedFiles.Barrier = delegate(string stage) { Dictionary<string, object> b = new Dictionary<string, object>(); b["op"] = "barrier"; b["stage"] = stage; Out(b); Console.In.ReadLine(); }; continue;
      }
      Out(v);
    }
    return 0;
  }
  private static OwnedFileDescriptor Pick(string token, OwnedFileDescriptor placed, OwnedFileDescriptor kept, SetupOwnershipSnapshot s) {
    if (token == "placed") return placed; if (token == "keep") return kept; if (token == "null") return null;
    FileIdentity other = new FileIdentity(); other.Volume = 1; other.Index = 2;
    if (placed == null) placed = kept;
    if (token == "foreign") return new OwnedFileDescriptor(placed.Root, other, placed.Name, placed.Bytes, placed.Sha256, placed.Identity);
    if (token == "badname") return new OwnedFileDescriptor(placed.Root, placed.RootIdentity, "Other.exe", placed.Bytes, placed.Sha256, placed.Identity);
    throw new ArgumentException(token);
  } }`;

let shared;
async function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-ownership-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-ownership-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['SetupOwnership.cs', 'OwnedFiles.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine writes the record the journal binds to.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(hash(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = tag => {
    const dir = owned('bundle'); fs.mkdirSync(join(dir, 'resources', 'node'), { recursive: true }); const files = [];
    for (const [path, text] of [['Arcane.exe', 'fixture app ' + tag], ['resources/node/node.exe', 'fixture node']]) { fs.writeFileSync(join(dir, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: hash(text) }); }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  const installed = async () => { const target = join(owned('install'), 'Arcane'); await engine.install({ bundle: bundle('one'), installRoot: target }); return target; };
  const bytesFile = text => { const file = join(owned('bytes'), 'file.bin'); fs.writeFileSync(file, text); return file; };
  /** Runs an op script; at each wait/barrier line the next action (sync or async) runs before the harness continues. */
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = []; let out = '', err = '', chain = Promise.resolve();
    child.stdout.on('data', d => {
      out += d; const parts = out.split(/\r?\n/); out = parts.pop();
      for (const line of parts) {
        const value = JSON.parse(line); lines.push(value);
        if (value.op === 'wait' || value.op === 'barrier') { const action = actions.shift() ?? (() => {}); chain = chain.then(() => action(value)).then(() => child.stdin.write('go\n'), reject); }
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => chain.then(() => { if (err || code !== 0) reject(new Error('harness ' + code + ' ' + err)); else { child.stdin.destroy(); resolve(lines.filter(l => l.op !== 'wait' && l.op !== 'barrier')); } }));
  });
  shared = { root, owned, engine, bundle, installed, bytesFile, run };
  return shared;
}
const journalOf = target => join(target, 'setup-ownership.json');
const pick = (lines, op) => lines.filter(l => l.op === op);

test('absent journal is created exclusively; saved descriptors round-trip exactly; identical saves are unchanged; updates use the observed journal', windows, async () => {
  const s = await setup(), target = await s.installed(), launcher = s.bytesFile('launcher bytes'), uninstaller = s.bytesFile('uninstaller bytes');
  let lines = await s.run(target, ['read', 'place-launcher', launcher, 'save', 'placed', 'null']);
  assert.deepEqual([lines[0].state, lines[0].present], ['Absent', false]); assert.deepEqual([lines[1].state, lines[2].state, lines[2].code], ['Placed', 'Saved', null]);
  const text = fs.readFileSync(journalOf(target), 'utf8'), journal = JSON.parse(text), record = JSON.parse(fs.readFileSync(join(target, 'installation.json'), 'utf8'));
  assert.equal(text, JSON.stringify(journal) + '\n', 'canonical bytes');
  assert.deepEqual(Object.keys(journal), ['schemaVersion', 'kind', 'installationId', 'root', 'rootVolume', 'rootIndex', 'launcher', 'uninstaller', 'shortcut', 'registration']);
  assert.deepEqual([journal.installationId, journal.root, journal.uninstaller, journal.shortcut, journal.registration], [record.installationId, target, null, null, null]);
  assert.match(journal.rootVolume, /^[0-9a-f]{8}$/); assert.match(journal.rootIndex, /^[0-9a-f]{16}$/); assert.match(journal.launcher.volume, /^[0-9a-f]{8}$/); assert.match(journal.launcher.index, /^[0-9a-f]{16}$/);
  assert.deepEqual([journal.launcher.name, journal.launcher.bytes, journal.launcher.sha256], ['Arcane.exe', 14, hash('launcher bytes')]);
  assert.equal(text.includes(hash(text)), false, 'no self-reference');
  const ino = fs.statSync(journalOf(target), { bigint: true }).ino;
  lines = await s.run(target, ['read', 'save', 'keep', 'keep']);
  assert.equal(lines[0].state, 'Valid'); assert.deepEqual(lines[0].launcher, { root: target, name: 'Arcane.exe', bytes: 14, sha256: hash('launcher bytes'), volume: journal.launcher.volume, index: journal.launcher.index });
  assert.deepEqual([lines[1].state, lines[1].placement], ['Unchanged', { state: 'Unchanged', code: null, backup: null }], 'verified through OwnedFiles, not from the old hash');
  assert.equal(fs.statSync(journalOf(target), { bigint: true }).ino, ino);
  lines = await s.run(target, ['read', 'place-uninstaller', uninstaller, 'save', 'keep', 'placed', 'read']);
  assert.deepEqual([lines[2].state, lines[2].placement.state], ['Saved', 'Replaced']);
  assert.deepEqual([lines[3].launcher.name, lines[3].uninstaller.name, lines[3].uninstaller.sha256], ['Arcane.exe', 'Uninstall Arcane.exe', hash('uninstaller bytes')]);
  // Descriptors are metadata only: an edited launcher stays recorded; the journal never claims fresh integrity.
  fs.writeFileSync(join(target, 'Arcane.exe'), 'edited by hand');
  lines = await s.run(target, ['read', 'save', 'keep', 'keep']);
  assert.deepEqual([lines[0].launcher.sha256, lines[1].state], [hash('launcher bytes'), 'Unchanged']);
  lines = await s.run(target, ['read', 'place-launcher', launcher, 'save', 'foreign', 'keep', 'save', 'badname', 'keep']);
  assert.deepEqual([lines[1].state, lines[1].code], ['Kept', 'CHANGED'], 'the edited launcher is kept by OwnedFiles');
  for (const save of pick(lines, 'save')) assert.deepEqual([save.state, save.code, save.placement], ['Refused', 'DESCRIPTOR', null], 'foreign root identity or wrong role name');
  assert.deepEqual(JSON.parse(fs.readFileSync(journalOf(target), 'utf8')).launcher.sha256, hash('launcher bytes'));
});

test('malformed, foreign, oversize, linked and redirected journals are kept byte-identical with no writes', windows, async () => {
  const s = await setup(), target = await s.installed();
  await s.run(target, ['read', 'place-launcher', s.bytesFile('launcher'), 'save', 'placed', 'null']);
  const valid = fs.readFileSync(journalOf(target), 'utf8'), j = JSON.parse(valid);
  const reorder = { kind: j.kind, ...j };
  const variants = [
    ['MALFORMED', '{'], ['MALFORMED', JSON.stringify(j, null, 2) + '\n'], ['MALFORMED', JSON.stringify(j)], ['MALFORMED', valid + ' '],
    ['MALFORMED', JSON.stringify({ ...j, extra: 1 }) + '\n'], ['MALFORMED', JSON.stringify(reorder) + '\n'],
    ['MALFORMED', valid.replace('"kind":', '"kind":"x","kind":')], ['MALFORMED', JSON.stringify({ ...j, rootVolume: j.rootVolume.toUpperCase() === j.rootVolume ? 'ABCDEF12' : j.rootVolume.toUpperCase() }) + '\n'],
    ['MALFORMED', JSON.stringify({ ...j, rootIndex: parseInt(j.rootIndex.slice(-6), 16) }) + '\n'], ['MALFORMED', JSON.stringify({ ...j, shortcut: {} }) + '\n'],
    ['MALFORMED', JSON.stringify({ ...j, launcher: { ...j.launcher, name: 'Other.exe' } }) + '\n'], ['MALFORMED', JSON.stringify({ ...j, launcher: { ...j.launcher, bytes: -1 } }) + '\n'],
    ['MALFORMED', JSON.stringify({ ...j, launcher: { ...j.launcher, sha256: j.launcher.sha256 + '\n' } }) + '\n'],
    ['MALFORMED', JSON.stringify({ ...j, rootVolume: j.rootVolume + '\n' }) + '\n'],
    ['MALFORMED', JSON.stringify({ ...j, launcher: { ...j.launcher, index: j.launcher.index + '\n' } }) + '\n'],
    ['MALFORMED', 'x'.repeat(9000)], ['MALFORMED', JSON.stringify({ ...j, schemaVersion: 2 }) + '\n'],
    ['FOREIGN', JSON.stringify({ ...j, installationId: '00000000-0000-4000-8000-000000000000' }) + '\n'], ['FOREIGN', JSON.stringify({ ...j, rootIndex: '0000000000000001' }) + '\n'],
    ['FOREIGN', JSON.stringify({ ...j, root: j.root.toUpperCase() }) + '\n'],
  ];
  for (const [code, text] of variants) {
    fs.writeFileSync(journalOf(target), text);
    const lines = await s.run(target, ['read', 'save', 'null', 'null']);
    assert.deepEqual([lines[0].state, lines[0].code], ['Kept', code], text.slice(0, 80));
    assert.deepEqual([lines[1].state, lines[1].code], ['Refused', 'SNAPSHOT']); assert.equal(fs.readFileSync(journalOf(target), 'utf8'), text);
  }
  fs.writeFileSync(journalOf(target), valid);
  const link = join(s.owned('link'), 'journal.json'); fs.linkSync(journalOf(target), link);
  assert.deepEqual(Object.values((await s.run(target, ['read']))[0]).slice(1, 3), ['Kept', 'LINKED']); fs.unlinkSync(link);
  fs.unlinkSync(journalOf(target)); const away = s.owned('away'); fs.symlinkSync(away, journalOf(target), 'junction');
  assert.deepEqual(Object.values((await s.run(target, ['read', 'save', 'null', 'null']))[0]).slice(1, 3), ['Kept', 'REDIRECT']);
  assert.deepEqual(fs.readdirSync(away), []); assert.equal(fs.lstatSync(journalOf(target)).isSymbolicLink(), true);
});

test('a stale snapshot never overwrites a newer journal, and installation changes fence saves before and after publication', windows, async () => {
  const s = await setup(); let target = await s.installed();
  await s.run(target, ['read', 'place-launcher', s.bytesFile('one'), 'save', 'placed', 'null']);
  let lines = await s.run(target, ['read', 'wait', 'save', 'null', 'null'], [async () => { await s.run(target, ['read', 'save', 'keep', 'keep']); const text = fs.readFileSync(journalOf(target)); fs.unlinkSync(journalOf(target)); fs.writeFileSync(journalOf(target), text); }]);
  const newer = fs.readFileSync(journalOf(target), 'utf8');
  assert.deepEqual([lines[1].state, lines[1].code], ['Kept', 'CHANGED']); assert.equal(fs.readFileSync(journalOf(target), 'utf8'), newer);
  // Stale idempotence: a no-change save after the journal was replaced (same bytes, new identity) or edited is not Unchanged.
  for (const mutate of [() => { const text = fs.readFileSync(journalOf(target)); fs.unlinkSync(journalOf(target)); fs.writeFileSync(journalOf(target), text); },
    () => fs.writeFileSync(journalOf(target), fs.readFileSync(journalOf(target), 'utf8').replace('"registration":null', '"registration":null '))]) {
    lines = await s.run(target, ['read', 'wait', 'save', 'keep', 'keep'], [mutate]);
    const current = fs.readFileSync(journalOf(target), 'utf8');
    assert.equal(lines[0].state, 'Valid'); assert.deepEqual([lines[1].state, lines[1].code], ['Kept', 'CHANGED'], 'no Unchanged from a stale snapshot');
    assert.equal(fs.readFileSync(journalOf(target), 'utf8'), current);
    if (!current.endsWith('}\n')) fs.writeFileSync(journalOf(target), current.replace('"registration":null ', '"registration":null'));
  }
  for (const change of [t => fs.writeFileSync(join(t, 'installation.lock'), 'fixture'), async t => { await s.engine.install({ bundle: s.bundle('two'), installRoot: t }); }]) {
    target = await s.installed(); await s.run(target, ['read', 'place-launcher', s.bytesFile('one'), 'save', 'placed', 'null']); const before = fs.readFileSync(journalOf(target), 'utf8');
    lines = await s.run(target, ['read', 'wait', 'save', 'null', 'null'], [() => change(target)]);
    assert.deepEqual([lines[1].state, lines[1].code, lines[1].placement], ['Refused', 'RECORD_CHANGED', null]); assert.equal(fs.readFileSync(journalOf(target), 'utf8'), before);
  }
  target = await s.installed();
  lines = await s.run(target, ['read', 'place-launcher', s.bytesFile('one'), 'barrier', 'save', 'placed', 'null'],
    [async () => { await s.engine.install({ bundle: s.bundle('two'), installRoot: target }); }]);
  assert.deepEqual([lines[2].state, lines[2].code, lines[2].placement.state], ['Unknown', 'RECORD_CHANGED', 'Placed'], 'published under a changed installation is not a confirmed save');
});

test('OwnedFiles kept and unknown placements pass through without claiming a save', windows, async () => {
  const s = await setup(); let target = await s.installed();
  let lines = await s.run(target, ['read', 'place-launcher', s.bytesFile('one'), 'barrier', 'save', 'placed', 'null'], [() => fs.writeFileSync(journalOf(target), 'manual journal')]);
  assert.deepEqual([lines[2].state, lines[2].code, lines[2].placement.state], ['Kept', 'TARGET_APPEARED', 'Kept']); assert.equal(fs.readFileSync(journalOf(target), 'utf8'), 'manual journal');
  target = await s.installed(); await s.run(target, ['read', 'place-launcher', s.bytesFile('one'), 'save', 'placed', 'null']); const before = fs.readFileSync(journalOf(target));
  lines = await s.run(target, ['read', 'barrier', 'save', 'null', 'null'], [() => {}, () => fs.writeFileSync(journalOf(target), 'manual during replace')]);
  assert.deepEqual([lines[1].state, lines[1].code, lines[1].placement.state], ['Unknown', 'INTERRUPTED', 'Unknown']);
  assert.equal(fs.readFileSync(journalOf(target), 'utf8'), 'manual during replace'); assert.deepEqual(fs.readFileSync(lines[1].placement.backup), before);
  const after = await s.run(target, ['read']); assert.deepEqual([after[0].state, after[0].code], ['Kept', 'MALFORMED'], 'the manual file is never adopted');
});

test('only the matching live operation lease can read and save while ordinary journal access remains excluded', windows, async () => {
  const s = await setup(), target = await s.installed();
  const rows = await s.run(target, ['read', 'acquire', 'journal-read-old', 'read-with-lease', 'place-launcher', s.bytesFile('lease launcher'),
    'save', 'placed', 'null', 'save-with-lease', 'placed', 'null', 'save-with-lease', 'keep', 'null', 'release', 'save-with-lease', 'keep', 'null', 'read']);
  assert.deepEqual(rows.map(row => [row.state, row.code]), [
    ['Absent', null], ['Acquired', null], ['Kept', 'RECORD_CHANGED'], ['Absent', null], ['Placed', null],
    ['Refused', 'RECORD_CHANGED'], ['Saved', null], ['Unchanged', null], ['Released', null], ['Refused', 'RECORD_CHANGED'], ['Valid', null],
  ]);
  assert.equal(JSON.parse(fs.readFileSync(journalOf(target), 'utf8')).launcher.sha256, hash('lease launcher'));
  assert.equal(fs.existsSync(join(target, 'installation.lock')), false);
});

test('null and foreign leases never grant journal access or publication', windows, async () => {
  const s = await setup(), target = await s.installed(), other = await s.installed();
  let rows = await s.run(target, ['read', 'read-null-lease', 'save-null-lease', 'null', 'null']);
  assert.deepEqual(rows.slice(1).map(row => [row.state, row.code]), [['Kept', 'RECORD_CHANGED'], ['Refused', 'RECORD_CHANGED']]);
  assert.equal(fs.existsSync(journalOf(target)), false);
  rows = await s.run(target, ['read', 'acquire-other', other, 'read-with-lease', 'save-with-lease', 'null', 'null', 'release']);
  assert.deepEqual(rows.slice(1).map(row => [row.state, row.code]), [['Acquired', null], ['Kept', 'RECORD_CHANGED'], ['Refused', 'RECORD_CHANGED'], ['Released', null]]);
  assert.equal(fs.existsSync(journalOf(target)), false); assert.equal(fs.existsSync(journalOf(other)), false);
});

test('released or disposed leases cannot be reused for journal operations', windows, async () => {
  const s = await setup();
  for (const end of ['release', 'dispose']) {
    const target = await s.installed();
    const rows = await s.run(target, ['read', 'acquire', end, 'read-with-lease', 'save-with-lease', 'null', 'null']);
    assert.deepEqual(rows.slice(3).map(row => [row.state, row.code]), [['Kept', 'RECORD_CHANGED'], ['Refused', 'RECORD_CHANGED']]);
    assert.equal(fs.existsSync(journalOf(target)), false); assert.equal(fs.existsSync(join(target, 'installation.lock')), end === 'dispose');
    if (end === 'dispose') assert.equal(rows[2].retained, true);
  }
});

test('a live lease preserves journal compare-and-swap when manual content appears', windows, async () => {
  const s = await setup();
  for (const [timing, code] of [['wait', 'UNRECORDED'], ['barrier', 'TARGET_APPEARED']]) {
    const target = await s.installed();
    const rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'place-launcher', s.bytesFile('one'), timing,
      'save-with-lease', 'placed', 'null', 'release'], [() => fs.writeFileSync(journalOf(target), 'manual while leased')]);
    assert.deepEqual([rows[4].state, rows[4].code, rows[4].placement.state], ['Kept', code, 'Kept']);
    assert.equal(fs.readFileSync(journalOf(target), 'utf8'), 'manual while leased');
  }
});

test('changed record identity fences a leased save before and after journal publication', windows, async () => {
  const s = await setup();
  const replaceRecord = target => {
    const record = join(target, 'installation.json'), replacement = join(target, 'replacement-record.json');
    fs.copyFileSync(record, replacement); fs.renameSync(replacement, record);
  };
  let target = await s.installed();
  let rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'wait', 'save-with-lease', 'null', 'null', 'read-with-lease', 'release'], [() => replaceRecord(target)]);
  assert.deepEqual(rows.slice(3, 5).map(row => [row.state, row.code]), [['Refused', 'RECORD_CHANGED'], ['Kept', 'RECORD_CHANGED']]);
  assert.equal(fs.existsSync(journalOf(target)), false);
  target = await s.installed();
  rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'place-launcher', s.bytesFile('one'), 'barrier', 'save-with-lease', 'placed', 'null', 'release'], [() => replaceRecord(target)]);
  assert.deepEqual([rows[4].state, rows[4].code, rows[4].placement.state], ['Unknown', 'RECORD_CHANGED', 'Placed']);
  assert.equal(fs.existsSync(journalOf(target)), true, 'publication is retained without claiming a saved outcome');
});

// Bounded external shortcut entry (v2). Shortcut descriptors here are SYNTHETIC metadata: no .lnk is created or opened, and
// the external directory deliberately does not exist (the journal never requires it).
const SHORTCUT_KEYS = ['root', 'rootVolume', 'rootIndex', 'name', 'bytes', 'sha256', 'volume', 'index'];
const external = (s, name = 'Programs') => join(s.root, 'external-missing', name);
const rewrite = (target, mutate) => { const value = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')); mutate(value); fs.writeFileSync(journalOf(target), JSON.stringify(value) + '\n'); };

test('a v2 shortcut entry round-trips under the live lease, legacy saves preserve it and null clears back to exact v1', windows, async () => {
  const s = await setup(), target = await s.installed(), launcher = s.bytesFile('launcher bytes'), uninstaller = s.bytesFile('uninstaller bytes'), programs = external(s);
  let lines = await s.run(target, ['read', 'place-launcher', launcher, 'save', 'placed', 'null']);
  const v1 = fs.readFileSync(journalOf(target), 'utf8'), v1Value = JSON.parse(v1);
  assert.deepEqual([v1Value.schemaVersion, v1Value.shortcut, v1Value.registration], [1, null, null], 'no shortcut stays canonical v1');
  lines = await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-shortcut', 'valid:' + programs, 'release', 'read']);
  const saved = pick(lines, 'save-shortcut')[0];
  assert.deepEqual([saved.state, saved.code, saved.placement.state], ['Saved', null, 'Replaced']);
  const text = fs.readFileSync(journalOf(target), 'utf8'), journal = JSON.parse(text);
  assert.equal(text, JSON.stringify(journal) + '\n', 'canonical bytes');
  assert.deepEqual([journal.schemaVersion, journal.registration, Object.keys(journal.shortcut)], [2, null, SHORTCUT_KEYS]);
  assert.deepEqual(journal.shortcut, { root: programs, rootVolume: '00000011', rootIndex: '0000000000000022', name: 'Arcane.lnk', bytes: 2336, sha256: hash('lnk'), volume: '00000033', index: '0000000000000044' });
  assert.deepEqual(journal.launcher, v1Value.launcher, 'the launcher descriptor is preserved');
  assert.equal(fs.existsSync(programs), false, 'the external directory was never created or required');
  const read = pick(lines, 'read').at(-1);
  assert.deepEqual([read.state, read.shortcut], ['Valid', { root: programs, rootVolume: '00000011', rootIndex: '0000000000000022', name: 'Arcane.lnk', bytes: 2336, sha256: hash('lnk'), volume: '00000033', index: '0000000000000044' }]);
  // Legacy Save overloads (ordinary and leased) carry the observed shortcut through unchanged.
  lines = await s.run(target, ['read', 'save', 'keep', 'keep', 'place-uninstaller', uninstaller, 'save', 'keep', 'placed', 'acquire', 'read-with-lease', 'save-with-lease', 'keep', 'keep', 'release', 'read']);
  assert.deepEqual(pick(lines, 'save').map(l => l.state), ['Unchanged', 'Saved']); assert.equal(pick(lines, 'save-with-lease')[0].state, 'Unchanged');
  const after = JSON.parse(fs.readFileSync(journalOf(target), 'utf8'));
  assert.deepEqual([after.schemaVersion, after.shortcut, after.uninstaller.sha256], [2, journal.shortcut, hash('uninstaller bytes')]);
  // Null under the live lease clears the entry and returns to canonical v1, preserving launcher and uninstaller.
  lines = await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-shortcut', 'null', 'release']);
  assert.equal(pick(lines, 'save-shortcut')[0].state, 'Saved');
  const cleared = fs.readFileSync(journalOf(target), 'utf8'), clearedValue = JSON.parse(cleared);
  assert.deepEqual([clearedValue.schemaVersion, clearedValue.shortcut, clearedValue.launcher, clearedValue.uninstaller], [1, null, after.launcher, after.uninstaller]);
  assert.equal(cleared, JSON.stringify({ ...clearedValue }) + '\n');
});

test('invalid shortcut descriptors and roots are refused before any write; malformed v1/v2 journals are kept byte-identical', windows, async () => {
  const s = await setup(), target = await s.installed(), launcher = s.bytesFile('launcher bytes'), good = external(s);
  await s.run(target, ['read', 'place-launcher', launcher, 'save', 'placed', 'null']);
  const before = fs.readFileSync(journalOf(target));
  const long = 'C:\\' + 'a'.repeat(250);
  const roots = ['relative\\Programs', 'C:\\', 'C:\\Programs\\', 'C:\\a\\..\\b', 'C:\\a\\.\\b', 'C:\\a\\b.', 'C:\\a\\b ', 'C:\\a\\b:stream', 'C:\\PROGRA~1\\x', 'C:\\arcane-d4079-absent\\LONGNA~1','C:\\a\\con', 'C:\\a\\c\u0001d',
    'C:/a/b', 'C:\\a\\\\b', long, '\\\\server\\share\\x'];
  const specs = [...roots.map(r => 'valid:' + r), 'badname:' + good, 'small:' + good, 'large:' + good, 'badsha:' + good];
  const ops = ['read', 'acquire', 'read-with-lease']; for (const spec of specs) ops.push('save-shortcut', spec); ops.push('release');
  const lines = await s.run(target, ops);
  for (const [i, save] of pick(lines, 'save-shortcut').entries()) assert.deepEqual([save.state, save.code, save.placement], ['Refused', 'DESCRIPTOR', null], specs[i]);
  assert.deepEqual(fs.readFileSync(journalOf(target)), before, 'nothing written');
  // A valid v2 journal, then hand edits that are each refused on read and left untouched.
  await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-shortcut', 'valid:' + good, 'release']);
  const v2 = fs.readFileSync(journalOf(target), 'utf8');
  for (const [name, mutate] of [
    ['v1 carrying a shortcut', v => { v.schemaVersion = 1; }], ['v2 without a shortcut', v => { v.shortcut = null; }], ['registration present', v => { v.registration = {}; }],
    ['extra shortcut key', v => { v.shortcut.extra = 1; }], ['missing shortcut key', v => { delete v.shortcut.rootIndex; }], ['traversal root', v => { v.shortcut.root = 'C:\\a\\..\\b'; }],
    ['ADS root', v => { v.shortcut.root = 'C:\\a:b'; }], ['short alias root', v => { v.shortcut.root = 'C:\\PROGRA~1'; }], ['absent short alias root', v => { v.shortcut.root = 'C:\\arcane-d4079-absent\\LONGNA~1'; }],['wrong name', v => { v.shortcut.name = 'Other.lnk'; }],
    ['too small', v => { v.shortcut.bytes = 75; }], ['uppercase hash', v => { v.shortcut.sha256 = v.shortcut.sha256.toUpperCase(); }], ['schema 3', v => { v.schemaVersion = 3; }]]) {
    fs.writeFileSync(journalOf(target), v2); rewrite(target, mutate); const edited = fs.readFileSync(journalOf(target));
    const [r] = await s.run(target, ['read']);
    assert.deepEqual([r.state, r.code], ['Kept', 'MALFORMED'], name); assert.deepEqual(fs.readFileSync(journalOf(target)), edited, name + ': untouched');
  }
  fs.writeFileSync(journalOf(target), v2.replace('"bytes":2336', '"bytes": 2336'));
  assert.deepEqual((await s.run(target, ['read']))[0].code, 'MALFORMED', 'non-canonical whitespace');
});

test('shortcut saves need the matching live lease and keep journal compare-and-swap: no adoption or overwrite', windows, async () => {
  const s = await setup(), target = await s.installed(), other = await s.installed(), launcher = s.bytesFile('launcher bytes'), good = external(s);
  await s.run(target, ['read', 'place-launcher', launcher, 'save', 'placed', 'null']);
  const before = fs.readFileSync(journalOf(target));
  let lines = await s.run(target, ['read', 'save-shortcut-null-lease', 'valid:' + good]);
  assert.deepEqual([lines[1].state, lines[1].code], ['Refused', 'RECORD_CHANGED'], 'no lease');
  lines = await s.run(target, ['read', 'acquire-other', other, 'save-shortcut', 'valid:' + good]);
  assert.deepEqual([pick(lines, 'save-shortcut')[0].state, pick(lines, 'save-shortcut')[0].code], ['Refused', 'RECORD_CHANGED'], 'a foreign lease');
  fs.rmSync(join(other, 'installation.lock'), { force: true });
  lines = await s.run(target, ['read', 'acquire', 'read-with-lease', 'release', 'save-shortcut', 'valid:' + good]);
  assert.deepEqual([pick(lines, 'save-shortcut')[0].state, pick(lines, 'save-shortcut')[0].code], ['Refused', 'RECORD_CHANGED'], 'a released lease');
  assert.deepEqual(fs.readFileSync(journalOf(target)), before);
  // The journal replaced (same bytes, new identity) after the leased read: the observed-journal CAS keeps it.
  lines = await s.run(target, ['read', 'acquire', 'read-with-lease', 'wait', 'save-shortcut', 'valid:' + good, 'release'],
    [() => { const b = fs.readFileSync(journalOf(target)); fs.unlinkSync(journalOf(target)); fs.writeFileSync(journalOf(target), b); }]);
  assert.deepEqual([pick(lines, 'save-shortcut')[0].state, pick(lines, 'save-shortcut')[0].code], ['Kept', 'CHANGED']);
  assert.deepEqual(fs.readFileSync(journalOf(target)), before, 'the replaced journal is never overwritten or adopted');
  // The record changed after the leased read: fenced before publication.
  lines = await s.run(target, ['read', 'acquire', 'read-with-lease', 'wait', 'save-shortcut', 'valid:' + good, 'release'],
    [() => { const p = join(target, 'installation.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"releases"', '"releases" ')); }]);
  assert.deepEqual([pick(lines, 'save-shortcut')[0].state, pick(lines, 'save-shortcut')[0].code], ['Refused', 'RECORD_CHANGED']);
  assert.deepEqual(fs.readFileSync(journalOf(target)), before);
});


// Registration descriptors below are synthetic metadata. No registry operation occurs in this journal fixture.
test('v3 registration metadata round-trips and survives root-tool and shortcut saves, with exact v1/v2 compatibility', windows, async () => {
  const s = await setup(), target = await s.installed(), programs = external(s);
  await s.run(target, ['read', 'save', 'null', 'null']); const v1 = fs.readFileSync(journalOf(target), 'utf8');
  let rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-registration', 'valid', 'release', 'read']);
  assert.deepEqual([pick(rows, 'save-registration')[0].state, pick(rows, 'read').at(-1).state], ['Saved', 'Valid']);
  let j = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')); const registration = j.registration;
  assert.deepEqual([j.schemaVersion, j.shortcut, registration], [3, null, { ownerId: 'd6b2b661-c7bf-4e40-94e0-4c26096c5c15', valuesSha256: hash('typed-registration'), lastWriteTime: '0123456789abcdef' }]);
  assert.deepEqual(pick(rows, 'read').at(-1).registration, registration);
  rows = await s.run(target, ['read', 'save', 'keep', 'keep', 'acquire', 'read-with-lease', 'save-shortcut', 'valid:' + programs, 'save-with-lease', 'keep', 'keep', 'save-registration', 'valid', 'release']);
  assert.equal(pick(rows, 'save')[0].state, 'Unchanged'); assert.equal(pick(rows, 'save-with-lease')[0].state, 'Unchanged');
  assert.equal(pick(rows, 'save-registration')[0].state, 'Unchanged');
  j = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')); assert.equal(j.schemaVersion, 3); assert.deepEqual(j.registration, registration); assert.equal(j.shortcut.root, programs);
  await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-registration', 'null', 'release']);
  j = JSON.parse(fs.readFileSync(journalOf(target), 'utf8')); assert.equal(j.schemaVersion, 2); assert.equal(j.registration, null); assert.equal(j.shortcut.root, programs);
  await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-shortcut', 'null', 'release']);
  assert.equal(fs.readFileSync(journalOf(target), 'utf8'), v1, 'clearing both optional roles returns exact original v1');
});

test('registration metadata requires canonical bounded fields and a matching live operation lease', windows, async () => {
  const s = await setup(), target = await s.installed(), other = await s.installed();
  await s.run(target, ['read', 'save', 'null', 'null']); const before = fs.readFileSync(journalOf(target));
  for (const ops of [
    ['read', 'save-registration-null-lease', 'valid'],
    ['read', 'acquire-other', other, 'save-registration', 'valid', 'release'],
    ['read', 'acquire', 'read-with-lease', 'release', 'save-registration', 'valid']]) {
    const r = pick(await s.run(target, ops), ops.includes('save-registration-null-lease') ? 'save-registration-null-lease' : 'save-registration')[0];
    assert.deepEqual([r.state, r.code, r.placement], ['Refused', 'RECORD_CHANGED', null]); assert.deepEqual(fs.readFileSync(journalOf(target)), before);
  }
  const rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-registration', 'bad-owner', 'save-registration', 'bad-sha', 'save-registration', 'zero', 'release']);
  for (const r of pick(rows, 'save-registration')) assert.deepEqual([r.state, r.code, r.placement], ['Refused', 'DESCRIPTOR', null]);
  assert.deepEqual(fs.readFileSync(journalOf(target)), before);
  await s.run(target, ['read', 'acquire', 'read-with-lease', 'save-registration', 'valid', 'release']); const valid = fs.readFileSync(journalOf(target), 'utf8');
  for (const edit of [v => { v.schemaVersion = 2; }, v => { v.registration = null; }, v => { v.registration.extra = 1; }, v => { delete v.registration.ownerId; },
    v => { v.registration.lastWriteTime = 1; }, v => { v.registration.lastWriteTime = '0000000000000000'; }, v => { v.registration.ownerId = v.registration.ownerId.toUpperCase(); },
    v => { v.registration.valuesSha256 = v.registration.valuesSha256.toUpperCase(); }, v => { v.registration.keyPath = 'other'; }]) {
    fs.writeFileSync(journalOf(target), valid); rewrite(target, edit); const malformed = fs.readFileSync(journalOf(target));
    assert.deepEqual((await s.run(target, ['read'])).map(r => [r.state, r.code]), [['Kept', 'MALFORMED']]); assert.deepEqual(fs.readFileSync(journalOf(target)), malformed);
  }
});

test('registration saves retain journal and record compare-and-swap, including changes after publication', windows, async () => {
  const s = await setup();
  let target = await s.installed(); await s.run(target, ['read', 'save', 'null', 'null']); const before = fs.readFileSync(journalOf(target));
  let rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'wait', 'save-registration', 'valid', 'release'], [() => {
    fs.unlinkSync(journalOf(target)); fs.writeFileSync(journalOf(target), before);
  }]);
  assert.deepEqual([pick(rows, 'save-registration')[0].state, pick(rows, 'save-registration')[0].code], ['Kept', 'CHANGED']); assert.deepEqual(fs.readFileSync(journalOf(target)), before);
  target = await s.installed();
  rows = await s.run(target, ['read', 'acquire', 'read-with-lease', 'barrier', 'save-registration', 'valid', 'release'], [() => {
    const record = join(target, 'installation.json'); fs.writeFileSync(record, fs.readFileSync(record, 'utf8').replace('"releases"', '"releases" '));
  }]);
  const r = pick(rows, 'save-registration')[0]; assert.deepEqual([r.state, r.code, r.placement[0]], ['Unknown', 'RECORD_CHANGED', 'Placed']);
  assert.equal(JSON.parse(fs.readFileSync(journalOf(target), 'utf8')).schemaVersion, 3, 'published metadata retained without claiming a confirmed save');
});
