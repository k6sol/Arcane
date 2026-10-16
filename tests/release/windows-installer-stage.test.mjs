import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

// Compiles the ACTUAL installer/PayloadArchive.cs and installer/StageDirectory.cs with the in-box .NET Framework csc.exe
// into a SEPARATE owned console harness and drives it with tiny synthetic approved setup files (fake PE prefix + ZIP +
// trailer). Owned temp directories only; mutations between extraction and cleanup are made by this test inside its own
// root. No installation, GUI, user Programs/profile, registry, providers or Studio. Windows-only (actual csc/Win32 contract).
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const HARNESS = String.raw`using System; using System.Text; using System.Runtime.InteropServices; using Arcane.Installer;
internal static class Harness {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetShortPathNameW(string path, StringBuilder buffer, uint length);
  private static string J(string v) { return v == null ? "null" : "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  private static string B(bool v) { return v ? "true" : "false"; }
  private static string R(StageCleanupReceipt c) { return "{\"complete\":" + B(c.Complete) + ",\"rootDeleted\":" + B(c.RootDeleted) + ",\"filesDeleted\":" + c.FilesDeleted +
    ",\"filesRetained\":" + c.FilesRetained + ",\"directoriesDeleted\":" + c.DirectoriesDeleted + ",\"directoriesRetained\":" + c.DirectoriesRetained + ",\"code\":" + J(c.Code) + "}"; }
  private static int Main(string[] a) {
    try {
      switch (a[0]) {
        case "short": { StringBuilder s = new StringBuilder(1024); uint n = GetShortPathNameW(a[1], s, 1024); Console.WriteLine("{\"ok\":" + B(n > 0) + ",\"value\":" + J(s.ToString()) + "}"); return 0; }
        case "parent": Console.WriteLine("{\"ok\":true,\"value\":" + J(a.Length > 2 ? StageDirectory.CanonicalParent(a[1], int.Parse(a[2])) : StageDirectory.CanonicalParent(a[1])) + "}"); return 0;
        case "temp": Console.WriteLine("{\"ok\":true,\"value\":" + J(a.Length > 1 ? StageDirectory.CanonicalTempParent(int.Parse(a[1])) : StageDirectory.CanonicalTempParent()) + "}"); return 0;
        case "reserve": Console.WriteLine("{\"ok\":true,\"value\":" + J(a.Length > 2 ? StageDirectory.Reserve(a[1], int.Parse(a[2])) : StageDirectory.Reserve(a[1])) + "}"); return 0;
        case "extract": {
          PayloadReceipt r = PayloadArchive.VerifyAndExtract(a[1], a[2], a[3]); string mode = a[4];
          Console.WriteLine("{\"ok\":true,\"stage\":" + J(r.StagePath) + ",\"files\":" + r.Files + ",\"directories\":" + r.Directories + "}"); Console.Out.Flush();
          if (mode == "none") return 0;
          if (mode == "null") { Console.WriteLine(R(StageDirectory.Cleanup(null))); return 0; }
          if (mode == "wait") Console.In.ReadLine();
          if (mode == "redirect") r.StagePath = a[5];
          Console.WriteLine(R(StageDirectory.Cleanup(r)));
          if (mode == "twice") Console.WriteLine(R(StageDirectory.Cleanup(r)));
          return 0; }
      }
    }
    catch (StageException e) { Console.WriteLine("{\"ok\":false,\"code\":" + J(e.Code) + "}"); return 2; }
    catch (PayloadException e) { Console.WriteLine("{\"ok\":false,\"code\":" + J(e.Code) + ",\"stage\":" + J(e.RetainedStage) + "}"); return 2; }
    return 3;
  } }`;
const sha = bytes => createHash('sha256').update(bytes).digest();

/** Minimal ZIP writer (stored or deflate), as in the payload suite. */
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data ?? Buffer.alloc(0), method = e.method ?? 0, body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw), size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function setupBytes(payload) {
  const prefix = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]), trailer = Buffer.alloc(64); Buffer.from('ARCANE-SETUP-V1\0', 'ascii').copy(trailer, 0);
  trailer.writeBigUInt64LE(BigInt(prefix.length), 16); trailer.writeBigUInt64LE(BigInt(payload.length), 24); sha(payload).copy(trailer, 32);
  return Buffer.concat([prefix, payload, trailer]);
}
// 4 owned files; 5 created directories (bundle, bundle\resources, bundle\resources\node, kit, kit\scripts).
const ENTRIES = [{ name: 'bundle/' }, { name: 'bundle/Arcane.exe', data: Buffer.from('fixture app') },
  { name: 'bundle/resources/node/node.exe', data: Buffer.from('fixture node'), method: 8 },
  { name: 'kit/scripts/windows-install-cli.mjs', data: Buffer.from('export {}') }, { name: 'kit-manifest.json', data: Buffer.from('{}') }];

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-installer-stage-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-installer-stage-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['PayloadArchive.cs', 'StageDirectory.cs']) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'stage-harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + harness, '/reference:System.IO.Compression.dll',
    join(build, 'PayloadArchive.cs'), join(build, 'StageDirectory.cs'), join(build, 'Harness.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  const payload = zip(ENTRIES), file = join(owned('setup'), 'Arcane-Setup.exe'); fs.writeFileSync(file, setupBytes(payload));
  const call = (args, env) => { const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...(env ? { env } : {}) });
    assert.equal(r.stderr, ''); return r.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)); };
  const hash = sha(payload).toString('hex');
  /** Extract, let the test mutate the owned stage, then clean up through the receipt. */
  const interactive = (mutate) => new Promise((resolve, reject) => {
    const stage = join(owned('stage'), 'fresh'), child = spawn(harness, ['extract', file, stage, hash, 'wait'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', mutated = false;
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Owned harness exceeded its deadline.')); }, 60000);
    child.stdout.on('data', data => {
      out += data;
      if (!mutated && out.includes('\n')) { mutated = true; try { mutate(stage); child.stdin.end('go\n'); } catch (error) { child.stdin.end('go\n'); reject(error); } }
    });
    child.stderr.on('data', data => { err += data; });
    child.on('close', () => { clearTimeout(deadline); try { assert.equal(err, ''); const [extracted, cleanup] = out.trim().split(/\r?\n/).map(line => JSON.parse(line)); resolve({ stage, extracted, cleanup }); } catch (error) { reject(error); } });
  });
  shared = { root, harness, owned, file, hash, payload, call, interactive };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const counts = c => [c.filesDeleted, c.filesRetained, c.directoriesDeleted, c.directoriesRetained, c.rootDeleted, c.complete, c.code];

test('canonical parent expands an existing 8.3 alias, refuses redirects and enforces the explicit path budget', windows, async t => {
  const s = setup(), base = s.owned('parent'), long = join(base, 'Arcane Long Name Directory Test'); fs.mkdirSync(long);
  const junction = join(base, 'junction'); fs.symlinkSync(long, junction, 'junction');
  assert.deepEqual(s.call(['parent', long, '60']), [{ ok: true, value: long }]);
  assert.deepEqual(s.call(['parent', long + '\\', '60']), [{ ok: true, value: long }], 'trailing separator removed');
  for (const [candidate, code] of [[junction, 'REPARSE'], [join(junction, 'missing'), 'UNAVAILABLE'], [join(base, 'missing'), 'UNAVAILABLE'], ['relative\\dir', 'PATH'],
    [long.replaceAll('\\', '/'), 'PATH'], ['C:\\', 'PATH'], [long + ':stream', 'PATH']]) assert.deepEqual(s.call(['parent', candidate, '60']), [{ ok: false, code }], candidate);
  // Budget: parent + '\' + 44-character stage name + '\' + maximum relative payload path <= 259.
  assert.deepEqual(s.call(['parent', long, String(259 - 46 - long.length)]), [{ ok: true, value: long }]);
  assert.deepEqual(s.call(['parent', long, String(259 - 46 - long.length + 1)]), [{ ok: false, code: 'PATH_TOO_LONG' }]);
  assert.deepEqual(s.call(['parent', long, '0']), [{ ok: false, code: 'PATH_TOO_LONG' }]);
  if (long.length > 259 - 46 - 134) assert.deepEqual(s.call(['parent', long]), [{ ok: false, code: 'PATH_TOO_LONG' }], 'default budget reserves 134 characters');
  const reserved = s.call(['reserve', long, '60'])[0];
  assert.match(reserved.value, /\\ArcaneSetup-[0-9a-f]{32}$/); assert.equal(reserved.value.length, long.length + 1 + 44); assert.equal(exists(reserved.value), false, 'reservation creates nothing');
  assert.deepEqual(s.call(['reserve', long + '\\', '60']), [{ ok: false, code: 'PATH' }], 'reservation requires the exact canonical spelling');
  const alias = s.call(['short', long])[0].value;
  if (!alias || alias.toLowerCase() === long.toLowerCase()) { t.diagnostic('8.3 aliases unavailable on this volume; alias cases skipped'); return; }
  assert.deepEqual(s.call(['parent', alias, '60']), [{ ok: true, value: long }], '8.3 alias expanded to the long canonical path');
  assert.deepEqual(s.call(['reserve', alias, '60']), [{ ok: false, code: 'PATH' }], 'an alias spelling is never reserved directly');
  assert.deepEqual(s.call(['temp', '60'], { SystemRoot: process.env.SystemRoot, TMP: alias, TEMP: alias }), [{ ok: true, value: long }], 'TEMP alias expanded');
});

test('a confirmed cleanup deletes exactly the unchanged owned stage; authority is consumed once and never taken from StagePath', windows, () => {
  const s = setup();
  let stage = join(s.owned('stage'), 'fresh'), [extracted, cleanup] = s.call(['extract', s.file, stage, s.hash, 'clean']);
  assert.deepEqual([extracted.ok, extracted.files, extracted.directories], [true, 4, 5]);
  assert.deepEqual(counts(cleanup), [4, 0, 5, 0, true, true, null]); assert.equal(exists(stage), false);
  stage = join(s.owned('stage'), 'fresh'); const [, first, second] = s.call(['extract', s.file, stage, s.hash, 'twice']);
  assert.equal(first.complete, true); assert.deepEqual(counts(second), [0, 0, 0, 0, false, false, 'CONSUMED']);
  stage = join(s.owned('stage'), 'fresh'); const [, none] = s.call(['extract', s.file, stage, s.hash, 'null']);
  assert.deepEqual(counts(none), [0, 0, 0, 0, false, false, 'NO_AUTHORITY']); assert.equal(exists(join(stage, 'kit-manifest.json')), true);
  // A caller-editable StagePath grants nothing: cleanup uses the recorded root only.
  const other = s.owned('other'); fs.writeFileSync(join(other, 'kit-manifest.json'), '{}');
  stage = join(s.owned('stage'), 'fresh'); const [, redirected] = s.call(['extract', s.file, stage, s.hash, 'redirect', other]);
  assert.equal(redirected.complete, true); assert.equal(exists(stage), false); assert.equal(fs.readFileSync(join(other, 'kit-manifest.json'), 'utf8'), '{}');
  // Unknown outcome: the caller does not request cleanup and the whole stage is retained.
  stage = join(s.owned('stage'), 'fresh'); s.call(['extract', s.file, stage, s.hash, 'none']);
  for (const path of ['bundle\\Arcane.exe', 'bundle\\resources\\node\\node.exe', 'kit\\scripts\\windows-install-cli.mjs', 'kit-manifest.json']) assert.equal(exists(join(stage, path)), true);
});

test('changed, added, hardlinked and replaced entries are retained with their parents; everything else owned is removed', windows, async () => {
  const s = setup();
  let r = await s.interactive(stage => fs.writeFileSync(join(stage, 'bundle\\Arcane.exe'), 'FIXTURE APP'));
  assert.deepEqual(counts(r.cleanup), [3, 1, 4, 1, false, false, 'RETAINED']); assert.equal(fs.readFileSync(join(r.stage, 'bundle\\Arcane.exe'), 'utf8'), 'FIXTURE APP');
  assert.deepEqual(fs.readdirSync(r.stage), ['bundle']);
  r = await s.interactive(stage => fs.writeFileSync(join(stage, 'kit\\scripts\\added.txt'), 'user note'));
  assert.deepEqual(counts(r.cleanup), [4, 0, 3, 2, false, false, 'RETAINED']); assert.equal(fs.readFileSync(join(r.stage, 'kit\\scripts\\added.txt'), 'utf8'), 'user note');
  assert.equal(exists(join(r.stage, 'kit\\scripts\\windows-install-cli.mjs')), false);
  const outside = s.owned('outside'), link = join(outside, 'linked.exe');
  r = await s.interactive(stage => fs.linkSync(join(stage, 'bundle\\Arcane.exe'), link));
  assert.deepEqual(counts(r.cleanup), [3, 1, 4, 1, false, false, 'RETAINED']); assert.equal(fs.readFileSync(link, 'utf8'), 'fixture app');
  assert.equal(fs.statSync(link).nlink, 2, 'the hardlinked owned file was preserved');
  r = await s.interactive(stage => { fs.unlinkSync(join(stage, 'kit-manifest.json')); fs.writeFileSync(join(stage, 'kit-manifest.json'), '{}'); });
  assert.deepEqual(counts(r.cleanup), [3, 1, 5, 0, false, false, 'RETAINED']); assert.deepEqual(fs.readdirSync(r.stage), ['kit-manifest.json']);
});

test('replaced or redirected directories and roots are never followed; moved originals stay intact', windows, async () => {
  const s = setup();
  let moved = join(s.owned('moved'), 'kit');
  let r = await s.interactive(stage => { fs.renameSync(join(stage, 'kit'), moved); fs.mkdirSync(join(stage, 'kit\\scripts'), { recursive: true });
    fs.writeFileSync(join(stage, 'kit\\scripts\\windows-install-cli.mjs'), 'export {}'); });
  assert.deepEqual(counts(r.cleanup), [3, 1, 3, 2, false, false, 'RETAINED']);
  assert.equal(fs.readFileSync(join(moved, 'scripts\\windows-install-cli.mjs'), 'utf8'), 'export {}'); assert.equal(exists(join(r.stage, 'kit\\scripts\\windows-install-cli.mjs')), true);
  moved = join(s.owned('moved'), 'bundle');
  r = await s.interactive(stage => { fs.renameSync(join(stage, 'bundle'), moved); fs.symlinkSync(moved, join(stage, 'bundle'), 'junction'); });
  assert.deepEqual(counts(r.cleanup), [2, 2, 2, 3, false, false, 'RETAINED']);
  assert.equal(fs.readFileSync(join(moved, 'Arcane.exe'), 'utf8'), 'fixture app'); assert.equal(fs.readFileSync(join(moved, 'resources\\node\\node.exe'), 'utf8'), 'fixture node');
  assert.equal(fs.lstatSync(join(r.stage, 'bundle')).isSymbolicLink(), true, 'the junction itself is retained, never followed');
  for (const replace of [(stage, away) => fs.mkdirSync(stage), (stage, away) => fs.symlinkSync(away, stage, 'junction')]) {
    const away = join(s.owned('moved'), 'stage');
    r = await s.interactive(stage => { fs.renameSync(stage, away); replace(stage, away); });
    assert.deepEqual(counts(r.cleanup), [0, 4, 0, 5, false, false, 'ROOT_CHANGED']);
    for (const path of ['bundle\\Arcane.exe', 'bundle\\resources\\node\\node.exe', 'kit\\scripts\\windows-install-cli.mjs', 'kit-manifest.json']) assert.equal(exists(join(away, path)), true);
    assert.equal(exists(r.stage), true);
  }
});

test('a failed extraction retains its stage and yields no cleanup authority', windows, () => {
  const s = setup();
  const payload = zip([...ENTRIES.slice(0, 4), { name: 'kit-manifest.json', data: Buffer.alloc(64, 0x41), method: 8, declaredSize: 16 }]);
  const file = join(s.owned('bomb'), 'Arcane-Setup.exe'); fs.writeFileSync(file, setupBytes(payload));
  const stage = join(s.owned('stage'), 'fresh'), [out] = s.call(['extract', file, stage, sha(payload).toString('hex'), 'clean']);
  assert.deepEqual([out.ok, out.code, out.stage], [false, 'ENTRY_SIZE', stage]);
  assert.equal(exists(join(stage, 'bundle\\Arcane.exe')), true, 'failed stage retained for inspection');
});
