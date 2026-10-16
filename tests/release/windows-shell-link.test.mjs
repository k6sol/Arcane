import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';

// Compiles the ACTUAL installer/ShellLink.cs (+ InstalledRecord.cs and PayloadArchive.cs, read-only helpers) with the
// in-box .NET Framework csc.exe into a SEPARATE owned console harness (MTA main, so the component's own STA thread is
// exercised). Shortcut bytes are created and inspected in memory; the test only writes them to owned temp files for
// round trips. A separately declared harness-only interop writes a hostile link with arguments. No Resolve, no Start
// Menu, registry, user Programs/profile, process launch, providers or Studio. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.IO; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
using System.Threading; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetShortPathNameW(string p, StringBuilder b, uint n);
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class Link { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")] private interface IShellLinkW {
    void GetPath(StringBuilder f, int c, IntPtr d, uint g); void GetIDList(out IntPtr p); void SetIDList(IntPtr p); void GetDescription(StringBuilder n, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n); void GetWorkingDirectory(StringBuilder d, int c); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
    void GetArguments(StringBuilder a, int c); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a); void GetHotkey(out ushort h); void SetHotkey(ushort h);
    void GetShowCmd(out int s); void SetShowCmd(int s); void GetIconLocation(StringBuilder p, int c, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint r); void Resolve(IntPtr w, uint f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f); }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")] private interface IPersistFile {
    void GetClassID(out Guid g); [PreserveSig] int IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string f, int m); void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f); void GetCurFile(out IntPtr f); }
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static void Print(ShellLinkResult r, string launcher, string root) {
    Dictionary<string, object> v = new Dictionary<string, object>(); v["ok"] = r.Ok; v["code"] = r.Code; v["bytes"] = r.Bytes == null ? 0 : r.Bytes.Length;
    if (r.Fields != null) { Dictionary<string, object> f = new Dictionary<string, object>(); f["target"] = r.Fields.Target; f["workingDirectory"] = r.Fields.WorkingDirectory;
      f["arguments"] = r.Fields.Arguments; f["description"] = r.Fields.Description; f["iconPath"] = r.Fields.IconPath; f["iconIndex"] = r.Fields.IconIndex;
      f["showCommand"] = r.Fields.ShowCommand; f["hotKey"] = (int)r.Fields.HotKey; v["fields"] = f;
      if (launcher != null) v["describes"] = ArcaneShellLink.Describes(r.Fields, launcher, root); }
    Console.WriteLine(Json.Serialize(v)); }
  [MTAThread] private static int Main(string[] a) {
    switch (a[0]) {
      case "short": { StringBuilder s = new StringBuilder(1024); GetShortPathNameW(a[1], s, 1024); Console.WriteLine(Json.Serialize(s.ToString())); return 0; }
      case "create": { ShellLinkResult r = ArcaneShellLink.Create(a[1], a[2]); if (r.Ok) File.WriteAllBytes(a[3], r.Bytes); Print(r, a[1], a[2]); return 0; }
      case "inspect": { ShellLinkResult r = ArcaneShellLink.Inspect(File.ReadAllBytes(a[1])); Print(r, a.Length > 3 ? a[2] : null, a.Length > 3 ? a[3] : null); return 0; }
      case "hostile": {
        // Harness-only interop: a link to the same target WITH arguments and another description, saved to an owned file.
        Thread t = new Thread(delegate() { object link = new Link(); IShellLinkW s = (IShellLinkW)link; s.SetPath(a[1]); s.SetWorkingDirectory(a[2]);
          s.SetArguments("--root C:\\elsewhere"); s.SetDescription("Not Arcane"); s.SetIconLocation(a[1], 3); s.SetShowCmd(3); ((IPersistFile)link).Save(a[3], true); Marshal.FinalReleaseComObject(link); });
        t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join(); Console.WriteLine("{}"); return 0; }
    }
    return 2; } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-shell-link-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-shell-link-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['ShellLink.cs', 'InstalledRecord.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  const call = args => { const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.stderr, ''); return JSON.parse(r.stdout.trim()); };
  const install = () => { const dir = owned('install'), launcher = join(dir, 'Arcane.exe'); fs.writeFileSync(launcher, 'owned dummy launcher, never executed'); return { dir, launcher }; };
  shared = { root, owned, call, install };
  return shared;
}
const exact = (launcher, dir) => ({ target: launcher, workingDirectory: dir, arguments: '', description: 'Arcane', iconPath: launcher, iconIndex: 0, showCommand: 1, hotKey: 0 });

test('the fixed Arcane shortcut is built in memory and round-trips to exactly its fields', windows, () => {
  const s = setup(), { dir, launcher } = s.install(), before = hash(fs.readFileSync(launcher)), out = join(s.owned('out'), 'Arcane.lnk');
  const created = s.call(['create', launcher, dir, out]);
  assert.deepEqual([created.ok, created.code, created.describes], [true, null, true]); assert.deepEqual(created.fields, exact(launcher, dir));
  assert.ok(created.bytes >= 76 && created.bytes <= 65536);
  const bytes = fs.readFileSync(out); assert.equal(bytes.length, created.bytes);
  assert.equal(bytes.readUInt32LE(0), 0x4c, 'ShellLinkHeader size'); assert.equal(bytes.subarray(4, 20).toString('hex'), '0114020000000000c000000000000046', 'CLSID_ShellLink');
  const inspected = s.call(['inspect', out, launcher, dir]);
  assert.deepEqual([inspected.ok, inspected.describes], [true, true]); assert.deepEqual(inspected.fields, exact(launcher, dir));
  assert.equal(s.call(['inspect', out, join(dir, 'Other.exe'), dir]).describes, false); assert.equal(s.call(['inspect', out, launcher, s.owned('other')]).describes, false);
  assert.equal(hash(fs.readFileSync(launcher)), before, 'the target is never modified'); assert.deepEqual(fs.readdirSync(dir), ['Arcane.exe'], 'nothing is written beside it');
});

test('unsafe, redirected, aliased, nested or missing targets and roots are refused', windows, () => {
  const s = setup(), { dir, launcher } = s.install(), out = join(s.owned('out'), 'x.lnk');
  const refused = (target, root, code) => { const r = s.call(['create', target, root, out]); assert.deepEqual([r.ok, r.code, r.bytes], [false, code, 0], target + ' | ' + root); };
  refused(launcher, dir + '\\', 'PATH'); refused(launcher, 'relative\\dir', 'PATH'); refused(launcher, dir.replaceAll('\\', '/'), 'PATH'); refused(launcher, '\\\\?\\' + dir, 'PATH');
  const junction = join(s.owned('j'), 'root'); fs.symlinkSync(dir, junction, 'junction'); refused(join(junction, 'Arcane.exe'), junction, 'REDIRECT');
  refused(join(dir, 'Missing.exe'), dir, 'TARGET'); refused(join(s.owned('sibling'), 'Arcane.exe'), dir, 'TARGET');
  fs.mkdirSync(join(dir, 'sub')); fs.writeFileSync(join(dir, 'sub', 'Arcane.exe'), 'x'); refused(join(dir, 'sub', 'Arcane.exe'), dir, 'TARGET');
  fs.mkdirSync(join(dir, 'Folder.exe')); refused(join(dir, 'Folder.exe'), dir, 'TARGET');
  fs.writeFileSync(join(dir, '%TEMP%.exe'), 'x'); refused(join(dir, '%TEMP%.exe'), dir, 'TARGET');
  const away = s.owned('away'); fs.symlinkSync(away, join(dir, 'Linked.exe'), 'junction'); refused(join(dir, 'Linked.exe'), dir, 'TARGET');
  const long = join(dir, 'Arcane Launcher Long Name.exe'); fs.writeFileSync(long, 'x'); const alias = s.call(['short', long]);
  if (alias && alias.toLowerCase() !== long.toLowerCase()) refused(alias, dir, 'TARGET');
  assert.equal(fs.existsSync(out), false, 'no bytes produced on refusal');
});

test('inspection is bounded, refuses malformed bytes and reports hostile fields without forwarding or resolving them', windows, () => {
  const s = setup(), { dir, launcher } = s.install(), work = s.owned('bytes'), good = join(work, 'good.lnk');
  assert.equal(s.call(['create', launcher, dir, good]).ok, true);
  const valid = fs.readFileSync(good), file = name => join(work, name);
  const cases = [['empty', Buffer.alloc(0), 'SIZE'], ['short', valid.subarray(0, 75), 'SIZE'], ['oversize', Buffer.concat([valid, Buffer.alloc(65537 - valid.length)]), 'SIZE'],
    ['random', Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff)), 'MALFORMED'], ['header', Buffer.concat([Buffer.from([0x4d, 0, 0, 0]), valid.subarray(4)]), 'MALFORMED'],
    ['clsid', Buffer.concat([valid.subarray(0, 4), Buffer.alloc(16), valid.subarray(20)]), 'MALFORMED']];
  for (const [name, bytes, code] of cases) { fs.writeFileSync(file(name), bytes); const r = s.call(['inspect', file(name)]); assert.deepEqual([r.ok, r.code], [false, code], name); }
  const hostile = file('hostile.lnk'); s.call(['hostile', launcher, dir, hostile]);
  const r = s.call(['inspect', hostile, launcher, dir]);
  assert.deepEqual([r.ok, r.describes], [true, false], 'a link with arguments is never the Arcane shortcut');
  assert.deepEqual([r.fields.arguments, r.fields.description, r.fields.iconIndex, r.fields.showCommand], ['--root C:\\elsewhere', 'Not Arcane', 3, 3], 'reported as data only');
  const other = s.install(); fs.unlinkSync(other.launcher);
  const missing = s.call(['inspect', good, other.launcher, other.dir]); assert.deepEqual([missing.ok, missing.describes], [true, false], 'no target access is needed to inspect');
});
