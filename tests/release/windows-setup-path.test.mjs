import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { crc32 } from 'node:zlib';

// Compiles the ACTUAL installer/SetupPath.cs (and the unmodified PayloadArchive.cs for one composition case) with the
// in-box .NET Framework csc.exe into a SEPARATE owned console harness. Owned long-named temp folders provide real 8.3
// aliases (GetShortPathNameW); alias cases are skipped only if the volume has none. The composition case uses a tiny
// SYNTHETIC setup whose placeholder pin is its own payload hash. Nothing is launched; no user folders or registry.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const HARNESS = String.raw`using System; using System.Text; using System.Runtime.InteropServices; using Arcane.Installer;
internal static class Harness {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetShortPathNameW(string p, StringBuilder b, uint n);
  private static string J(string v) { return v == null ? "null" : "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t") + "\""; }
  private static int Main(string[] a) {
    if (a[0] == "short") { StringBuilder s = new StringBuilder(1024); GetShortPathNameW(a[1], s, 1024); Console.WriteLine(J(s.ToString())); return 0; }
    if (a[0] == "canon") {
      try { Console.WriteLine("{\"ok\":true,\"value\":" + J(SetupPath.CanonicalExecutable(Decode(a[1]))) + "}"); }
      catch (SetupPathException e) { Console.WriteLine("{\"ok\":false,\"code\":" + J(e.Code) + ",\"io\":" + (e is System.IO.IOException ? "true" : "false") + ",\"message\":" + J(e.Message) + "}"); }
      return 0; }
    // verify <observed> <stage> <pin> <raw|canonical>: the GUI composition (helper result into the unmodified extractor).
    try { string self = a[4] == "canonical" ? SetupPath.CanonicalExecutable(a[1]) : a[1]; PayloadArchive.VerifyAndExtract(self, a[2], a[3]); Console.WriteLine("{\"ok\":true}"); }
    catch (PayloadException e) { Console.WriteLine("{\"ok\":false,\"code\":" + J(e.Code) + "}"); }
    return 0;
  }
  // Arguments are hex-encoded UTF-16 so control characters reach the API unchanged.
  private static string Decode(string hex) { byte[] b = new byte[hex.Length / 2]; for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16); return Encoding.Unicode.GetString(b); }
}`;
const encode = text => Buffer.from(text, 'utf16le').toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest();

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-setup-path-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-setup-path-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['SetupPath.cs', 'PayloadArchive.cs']) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + harness, '/reference:System.IO.Compression.dll',
    ...['SetupPath.cs', 'PayloadArchive.cs', 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  const call = args => { const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.stderr, ''); return JSON.parse(r.stdout.trim()); };
  const canon = path => call(['canon', encode(path)]);
  const short = path => call(['short', path]);
  // A downloaded-setup-like owned folder with spaces, so 8.3 aliases exist when the volume generates them.
  const folder = join(root, 'Downloaded Arcane Setup Folder'); fs.mkdirSync(folder);
  const executable = join(folder, 'Arcane Setup Long Name.exe');
  shared = { root, folder, executable, call, canon, short };
  return shared;
}
/** Tiny synthetic setup: fake PE prefix + stored ZIP (bundle/, kit-manifest.json) + trailer; its pin is its own payload hash. */
function syntheticSetup(file) {
  const entries = [{ name: 'bundle/' }, { name: 'bundle/Arcane.exe', data: Buffer.from('fixture') }, { name: 'kit-manifest.json', data: Buffer.from('{}') }];
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = e.data ?? Buffer.alloc(0), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, raw); centrals.push(central, name); offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const payload = Buffer.concat([...locals, cd, end]), prefix = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]), trailer = Buffer.alloc(64);
  Buffer.from('ARCANE-SETUP-V1\0').copy(trailer); trailer.writeBigUInt64LE(BigInt(prefix.length), 16); trailer.writeBigUInt64LE(BigInt(payload.length), 24); sha(payload).copy(trailer, 32);
  fs.writeFileSync(file, Buffer.concat([prefix, payload, trailer]));
  return sha(payload).toString('hex');
}

test('long, 8.3 and mixed spellings of an existing setup canonicalize to its exact long path', windows, t => {
  const s = setup(); fs.writeFileSync(s.executable, 'owned fixture, never executed');
  assert.deepEqual(s.canon(s.executable), { ok: true, value: s.executable });
  const alias = s.short(s.executable);
  if (!alias || alias.toLowerCase() === s.executable.toLowerCase()) { t.diagnostic('8.3 aliases unavailable on this volume; alias cases skipped'); return; }
  assert.deepEqual(s.canon(alias), { ok: true, value: s.executable }, 'full alias expanded');
  const mixed = join(s.short(s.folder), 'Arcane Setup Long Name.exe');
  assert.deepEqual(s.canon(mixed), { ok: true, value: s.executable }, 'aliased parent with a long leaf expanded');
  const lowerDrive = s.executable[0].toLowerCase() + s.executable.slice(1);
  assert.deepEqual(s.canon(lowerDrive), { ok: true, value: lowerDrive }, 'drive letter case is preserved, not rewritten');
});

test('composition: the raw alias is refused by the unmodified extractor; the canonical helper result is accepted', windows, t => {
  const s = setup(), file = join(s.folder, 'Arcane Composition Setup.exe'), pin = syntheticSetup(file), alias = s.short(file);
  if (!alias || alias.toLowerCase() === file.toLowerCase()) { t.diagnostic('8.3 aliases unavailable; composition alias case skipped'); return; }
  assert.deepEqual(s.call(['verify', alias, join(s.root, 'stage-raw'), pin, 'raw']), { ok: false, code: 'SELF_PATH' }, 'G1: raw alias');
  assert.deepEqual(s.call(['verify', alias, join(s.root, 'stage-canonical'), pin, 'canonical']), { ok: true }, 'helper result accepted');
  assert.equal(fs.existsSync(join(s.root, 'stage-raw')), false, 'no stage before admission');
});

test('relative, UNC, device, malformed, missing, directory, redirected and over-length paths are refused with fixed codes', windows, () => {
  const s = setup(); fs.writeFileSync(s.executable, 'owned fixture');
  const refused = (path, code) => { const r = s.canon(path); assert.deepEqual([r.ok, r.code, r.io, r.message], [false, code, true, 'Setup path unavailable.'], JSON.stringify(path)); };
  for (const path of ['Arcane-Setup.exe', '.\\Arcane-Setup.exe', '\\\\server\\share\\Arcane-Setup.exe', '\\\\?\\' + s.executable, '\\\\.\\' + s.executable,
    s.executable.replaceAll('\\', '/'), s.executable + '"', s.executable + '\t', s.executable.replace('Arcane', 'Arc\nane'), s.executable + ':stream',
    s.executable + '.', s.executable + ' ', s.folder + '\\', 'C:', 'C:\\', s.executable + '*', 'x'.repeat(1025)]) refused(path, 'PATH');
  refused(join(s.folder, 'Missing Setup.exe'), 'MISSING'); refused(join(s.root, 'missing-folder', 'Arcane-Setup.exe'), 'MISSING');
  refused(s.folder, 'NOT_FILE');
  const away = join(s.root, 'away'); fs.mkdirSync(away); fs.writeFileSync(join(away, 'Arcane-Setup.exe'), 'x');
  const junction = join(s.root, 'junction-parent'); fs.symlinkSync(away, junction, 'junction'); refused(join(junction, 'Arcane-Setup.exe'), 'REDIRECT');
  fs.mkdirSync(join(s.root, 'leaf-target')); fs.symlinkSync(join(s.root, 'leaf-target'), join(s.folder, 'Linked Setup.exe'), 'junction'); refused(join(s.folder, 'Linked Setup.exe'), 'REDIRECT');
  let deep = s.folder; while (deep.length < 230) { deep = join(deep, 'd'.repeat(20)); }
  refused(join(deep, 'x'.repeat(40) + '.exe'), 'MISSING');
  refused(s.executable.slice(0, 3) + 'y'.repeat(300) + '.exe', 'MISSING');
  // A volume-root parent is not excluded by policy: a nonexistent root-level setup name is MISSING, not PATH (existence probe only).
  refused(s.executable.slice(0, 3) + 'arcane-setup-path-probe-' + randomUUID() + '.exe', 'MISSING');
});
