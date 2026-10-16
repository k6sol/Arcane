import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';

// Compiles the ACTUAL installer/OwnedFiles.cs (+ InstalledRecord.cs and PayloadArchive.cs for their read-only helpers)
// with the in-box .NET Framework csc.exe into a SEPARATE owned console harness. Every root and file is an owned temp
// fixture; the harness assigns the internal Barrier seam only in its "wait" mode to make races deterministic. A tiny
// owned console peer stands in for a running launcher. No installation, user Programs, registry, providers or Studio.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.IO; using System.Collections.Generic; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static OwnedFileDescriptor Load(string path) {
    if (path == "-") return null;
    Dictionary<string, object> d = (Dictionary<string, object>)Json.DeserializeObject(File.ReadAllText(path));
    FileIdentity root = new FileIdentity(); root.Volume = Convert.ToUInt32(d["rootVolume"]); root.Index = Convert.ToUInt64(d["rootIndex"]);
    FileIdentity file = new FileIdentity(); file.Volume = Convert.ToUInt32(d["volume"]); file.Index = Convert.ToUInt64(d["index"]);
    return new OwnedFileDescriptor((string)d["root"], root, (string)d["name"], Convert.ToInt64(d["bytes"]), (string)d["sha256"], file);
  }
  private static string Save(OwnedFileDescriptor o) {
    if (o == null) return "null";
    Dictionary<string, object> d = new Dictionary<string, object>();
    d["root"] = o.Root; d["name"] = o.Name; d["bytes"] = o.Bytes; d["sha256"] = o.Sha256;
    d["rootVolume"] = o.RootIdentity.Volume.ToString(); d["rootIndex"] = o.RootIdentity.Index.ToString(); d["volume"] = o.Identity.Volume.ToString(); d["index"] = o.Identity.Index.ToString();
    return Json.Serialize(d);
  }
  private static void Print(OwnedFileResult r) {
    Dictionary<string, object> d = new Dictionary<string, object>();
    d["state"] = r.State.ToString(); d["code"] = r.Code; d["backup"] = r.RetainedBackup; d["descriptor"] = r.Descriptor == null ? null : Json.DeserializeObject(Save(r.Descriptor));
    Console.WriteLine(Json.Serialize(d)); Console.Out.Flush();
  }
  private static int Main(string[] a) {
    if (a[0] == "remove") { Print(OwnedFiles.Remove(Load(a[1]))); return 0; }
    // place <root> <name> <source file> <sha256> <prior descriptor file or -> [wait]
    if (a.Length > 6 && a[6] == "wait") OwnedFiles.Barrier = delegate(string stage) { Console.WriteLine("{\"barrier\":\"" + stage + "\"}"); Console.Out.Flush(); Console.In.ReadLine(); };
    if (a.Length > 6 && a[6] == "throw-after-aside") OwnedFiles.Barrier = delegate(string stage) { if (stage == "after-aside") throw new IOException("Fixture publication interruption."); };
    Print(OwnedFiles.Place(a[1], a[2], File.ReadAllBytes(a[3]), a[4], Load(a[5])));
    return 0;
  } }`;
const PEER = String.raw`using System; internal static class Peer { private static int Main() { Console.WriteLine("ready"); Console.Out.Flush(); Console.ReadLine(); return 0; } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-owned-files-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-owned-files-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['OwnedFiles.cs', 'InstalledRecord.cs', 'PayloadArchive.cs']) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS); fs.writeFileSync(join(build, 'Peer.cs'), PEER);
  const compile = (out, files, extra = []) => { const r = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + out, ...extra, ...files], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'csc failed: ' + r.stdout + r.stderr); return out; };
  const harness = compile(join(build, 'harness.exe'), ['OwnedFiles.cs', 'InstalledRecord.cs', 'PayloadArchive.cs', 'Harness.cs'].map(f => join(build, f)),
    ['/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll']);
  const peer = fs.readFileSync(compile(join(build, 'peer.exe'), [join(build, 'Peer.cs')]));
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  const source = bytes => { const file = join(owned('source'), 'bytes.bin'); fs.writeFileSync(file, bytes); return file; };
  const save = (dir, descriptor) => { const file = join(dir, 'descriptor-' + ++count + '.json'); fs.writeFileSync(file, JSON.stringify(descriptor)); return file; };
  const call = args => { const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.stderr, ''); return JSON.parse(r.stdout.trim()); };
  const place = (target, name, bytes, prior, sha = hash(bytes), mode) => call(['place', target, name, source(bytes), sha, prior ? save(owned('prior'), prior) : '-', ...(mode ? [mode] : [])]);
  const remove = descriptor => call(['remove', save(owned('prior'), descriptor)]);
  /** Place with the Barrier seam: the test acts at each named stage before the harness continues. */
  const placeWaiting = (target, name, bytes, prior, actions) => new Promise((resolve, reject) => {
    const child = spawn(harness, ['place', target, name, source(bytes), hash(bytes), prior ? save(owned('prior'), prior) : '-', 'wait'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', seen = [], result = null, failure = null;
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch (error) { failure ??= error; child.stdin.end(); continue; }
        if (value.barrier) { seen.push(value.barrier); try { (actions[value.barrier] ?? (() => {}))(); } catch (error) { failure ??= error; } child.stdin.write('go\n'); }
        else { result = value; child.stdin.end(); }
      }
    });
    child.stderr.on('data', d => { err += d; }); child.once('error', reject);
    child.once('close', (code, signal) => {
      if (failure) reject(failure);
      else if (err || code !== 0 || signal !== null || result === null) reject(new Error('Owned placement harness did not finish cleanly.'));
      else resolve({ result, seen });
    });
  });
  shared = { root, peer, owned, place, remove, placeWaiting };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const leftovers = dir => fs.readdirSync(dir).filter(name => name.startsWith('~arcane-'));
const A = Buffer.from('approved launcher A'), B = Buffer.from('approved launcher B, longer');

test('an exception after moving the previous file retains its backup in the unknown outcome', windows, () => {
  const s = setup(), target = s.owned('install'), prior = s.place(target, 'Arcane.exe', A).descriptor;
  const result = s.place(target, 'Arcane.exe', B, prior, hash(B), 'throw-after-aside');
  assert.deepEqual([result.state, result.code, result.descriptor], ['Unknown', 'IO', null]);
  assert.match(result.backup, /\\~arcane-backup-[0-9a-f]{32}\.old$/);
  assert.deepEqual(fs.readFileSync(result.backup), A);
  assert.equal(exists(join(target, 'Arcane.exe')), false);
  assert.deepEqual(leftovers(target).filter(name => name.startsWith('~arcane-place-')), []);
});

test('absent placement publishes exactly the approved bytes; unchanged is idempotent; owned files are replaced and old authority expires', windows, () => {
  const s = setup(), target = s.owned('install'), file = join(target, 'Arcane.exe');
  const first = s.place(target, 'Arcane.exe', A);
  assert.deepEqual([first.state, first.code, first.backup], ['Placed', null, null]); assert.deepEqual(fs.readFileSync(file), A);
  assert.deepEqual([first.descriptor.root, first.descriptor.name, first.descriptor.bytes, first.descriptor.sha256], [target, 'Arcane.exe', A.length, hash(A)]);
  assert.deepEqual(leftovers(target), []);
  const ino = fs.statSync(file, { bigint: true }).ino, same = s.place(target, 'Arcane.exe', A, first.descriptor);
  assert.deepEqual([same.state, same.code], ['Unchanged', null]); assert.equal(fs.statSync(file, { bigint: true }).ino, ino, 'no rewrite');
  const second = s.place(target, 'Arcane.exe', B, first.descriptor);
  assert.deepEqual([second.state, second.code, second.backup], ['Replaced', null, null]); assert.deepEqual(fs.readFileSync(file), B); assert.deepEqual(leftovers(target), []);
  assert.notEqual(second.descriptor.index, first.descriptor.index);
  assert.deepEqual([s.place(target, 'Arcane.exe', A, first.descriptor).state, s.place(target, 'Arcane.exe', A, first.descriptor).code], ['Kept', 'CHANGED'], 'a superseded descriptor grants nothing');
  assert.deepEqual(fs.readFileSync(file), B);
});

test('unrecorded, edited, same-byte replaced, hardlinked and redirected targets are kept untouched', windows, () => {
  const s = setup();
  let target = s.owned('install'); fs.writeFileSync(join(target, 'Arcane.exe'), 'manual');
  assert.deepEqual(Object.values(s.place(target, 'Arcane.exe', A)).slice(0, 2), ['Kept', 'UNRECORDED']); assert.equal(fs.readFileSync(join(target, 'Arcane.exe'), 'utf8'), 'manual');
  const cases = [
    ['CHANGED', file => fs.writeFileSync(file, Buffer.from('approved launcher Z'))],
    ['CHANGED', file => { fs.unlinkSync(file); fs.writeFileSync(file, A); }],
    ['LINKED', file => fs.linkSync(file, join(s.owned('outside'), 'linked.exe'))],
  ];
  for (const [code, mutate] of cases) {
    target = s.owned('install'); const file = join(target, 'Arcane.exe'), placed = s.place(target, 'Arcane.exe', A).descriptor;
    mutate(file); const before = fs.readFileSync(file);
    const r = s.place(target, 'Arcane.exe', B, placed);
    assert.deepEqual([r.state, r.code, r.descriptor], ['Kept', code, null]); assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(leftovers(target), []);
    assert.deepEqual([s.remove(placed).state, s.remove(placed).code], ['Kept', code]); assert.deepEqual(fs.readFileSync(file), before);
  }
  target = s.owned('install'); const placed = s.place(target, 'Arcane.exe', A).descriptor, away = join(s.owned('outside'), 'dir');
  fs.unlinkSync(join(target, 'Arcane.exe')); fs.mkdirSync(away); fs.symlinkSync(away, join(target, 'Arcane.exe'), 'junction');
  assert.deepEqual(Object.values(s.place(target, 'Arcane.exe', B, placed)).slice(0, 2), ['Kept', 'REDIRECT']);
  assert.equal(fs.lstatSync(join(target, 'Arcane.exe')).isSymbolicLink(), true); assert.deepEqual(fs.readdirSync(away), []);
  const real = s.owned('install'), junction = join(s.owned('junction'), 'root'); fs.symlinkSync(real, junction, 'junction');
  assert.deepEqual(Object.values(s.place(junction, 'Arcane.exe', A)).slice(0, 2), ['Refused', 'ROOT']); assert.deepEqual(fs.readdirSync(real), []);
});

test('source pins, names and root identity are enforced before any write', windows, () => {
  const s = setup(), target = s.owned('install');
  assert.deepEqual(Object.values(s.place(target, 'Arcane.exe', A, null, hash(B))).slice(0, 2), ['Refused', 'SOURCE']);
  assert.deepEqual(Object.values(s.place(target, 'Arcane.exe', A, null, 'not-a-hash')).slice(0, 2), ['Refused', 'SOURCE']);
  for (const name of ['..', 'a\\b', 'a/b', 'installation.json', 'Installation.Lock', 'releases', '~arcane-place-x.tmp', 'CON', 'nul.txt', 'trail.', 'trail ', 'x:y', 'x'.repeat(101)])
    assert.deepEqual(Object.values(s.place(target, name, A)).slice(0, 2), ['Refused', 'NAME'], name);
  for (const bad of [target + '\\', 'relative\\x', target.replaceAll('\\', '/')]) assert.deepEqual(Object.values(s.place(bad, 'Arcane.exe', A)).slice(0, 2), ['Refused', 'ROOT'], bad);
  assert.deepEqual(fs.readdirSync(target), []);
  // A descriptor bound to another root identity grants nothing, even at the same path.
  const placed = s.place(target, 'Arcane.exe', A).descriptor;
  assert.deepEqual(Object.values(s.place(target, 'Arcane.exe', B, { ...placed, rootIndex: '1' })).slice(0, 2), ['Kept', 'UNRECORDED']);
  const moved = join(s.owned('moved'), 'install'); fs.renameSync(target, moved); fs.mkdirSync(target); fs.copyFileSync(join(moved, 'Arcane.exe'), join(target, 'Arcane.exe'));
  assert.deepEqual(Object.values(s.remove(placed)).slice(0, 2), ['Kept', 'ROOT']); assert.equal(exists(join(target, 'Arcane.exe')), true); assert.equal(exists(join(moved, 'Arcane.exe')), true);
});

test('races: a target appearing before publication is never overwritten; a held owned file cannot change; an interrupted replacement reports its backup', windows, async () => {
  const s = setup();
  let target = s.owned('install');
  let r = await s.placeWaiting(target, 'Arcane.exe', A, null, { 'before-publish': () => fs.writeFileSync(join(target, 'Arcane.exe'), 'manual arrived') });
  assert.deepEqual([r.seen, r.result.state, r.result.code, r.result.descriptor], [['before-publish'], 'Kept', 'TARGET_APPEARED', null]);
  assert.equal(fs.readFileSync(join(target, 'Arcane.exe'), 'utf8'), 'manual arrived'); assert.deepEqual(leftovers(target), []);
  target = s.owned('install'); let placed = s.place(target, 'Arcane.exe', A).descriptor; const blocked = [];
  r = await s.placeWaiting(target, 'Arcane.exe', B, placed, { 'before-aside': () => {
    for (const act of [() => fs.writeFileSync(join(target, 'Arcane.exe'), 'edit'), () => fs.renameSync(join(target, 'Arcane.exe'), join(target, 'moved.exe'))]) {
      try { act(); blocked.push('allowed'); } catch (e) { blocked.push(e.code); }
    } } });
  assert.ok(blocked.every(code => ['EBUSY', 'EPERM', 'EACCES'].includes(code)), 'verified file is fenced: ' + blocked.join(','));
  assert.deepEqual([r.result.state, r.result.code], ['Replaced', null]); assert.deepEqual(fs.readFileSync(join(target, 'Arcane.exe')), B);
  target = s.owned('install'); placed = s.place(target, 'Arcane.exe', A).descriptor;
  r = await s.placeWaiting(target, 'Arcane.exe', B, placed, { 'after-aside': () => fs.writeFileSync(join(target, 'Arcane.exe'), 'manual during replace') });
  assert.deepEqual([r.result.state, r.result.code, r.result.descriptor], ['Unknown', 'INTERRUPTED', null]);
  assert.equal(fs.readFileSync(join(target, 'Arcane.exe'), 'utf8'), 'manual during replace', 'the concurrent file is never overwritten');
  assert.match(r.result.backup, /\\~arcane-backup-[0-9a-f]{32}\.old$/); assert.deepEqual(fs.readFileSync(r.result.backup), A, 'previous owned bytes retained privately');
  assert.deepEqual(leftovers(target).filter(n => n.startsWith('~arcane-place-')), []);
});

test('deletion goes only through ownership; a running owned file is replaced with an explicit backup outcome', windows, async t => {
  const s = setup();
  let target = s.owned('install'); const placed = s.place(target, 'Arcane.exe', A).descriptor;
  assert.deepEqual(Object.values(s.remove(placed)).slice(0, 2), ['Deleted', null]); assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(Object.values(s.remove(placed)).slice(0, 2), ['Absent', null], 'a consumed file cannot be removed again');
  target = s.owned('install'); const running = s.place(target, 'Arcane.exe', s.peer).descriptor;
  const child = spawn(join(target, 'Arcane.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned peer did not acknowledge readiness.')), 5000);
      let output = '';
      child.stdout.on('data', bytes => {
        output += bytes.toString('utf8');
        if (output === 'ready\r\n' || output === 'ready\n') { clearTimeout(timer); resolve(); }
        else if (output.length > 16) { clearTimeout(timer); reject(new Error('Unexpected owned peer readiness.')); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned peer exited before readiness.')); });
    });
    const r = s.place(target, 'Arcane.exe', A, running);
    assert.equal(r.state, 'Replaced'); assert.deepEqual(fs.readFileSync(join(target, 'Arcane.exe')), A);
    if (r.code === 'BACKUP_RETAINED') { assert.deepEqual(fs.readFileSync(r.backup), s.peer, 'mapped previous image retained privately'); }
    else assert.equal(r.code, null);
    t.diagnostic('Acknowledged running image replacement: ' + (r.code ?? 'backup removed after verified replacement'));
  } finally {
    child.stdin.end('\n'); assert.deepEqual(await exited, { code: 0, signal: null });
  }
});
