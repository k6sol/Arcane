import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

// Compiles the ACTUAL installer/PayloadArchive.cs with the in-box .NET Framework csc.exe into a SEPARATE owned console
// fixture harness (not the production setup GUI) and drives it with tiny synthetic setup files: a fake PE prefix, a ZIP
// payload built here, and the fixed 64-byte trailer. Owned temp directories only: no installation, registry, shortcuts,
// GUI, downloads, native provider or Studio. Windows-only because the real csc/.NET Framework contract is under test.
const windows = process.platform === 'win32';
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const source = new URL('../../installer/PayloadArchive.cs', import.meta.url);
const HARNESS = String.raw`using System; using Arcane.Installer;
internal static class Harness {
  private static string J(string v) { return v == null ? "null" : "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  private static int Main(string[] a) {
    try { PayloadReceipt r = PayloadArchive.VerifyAndExtract(a[0], a[1], a[2]);
      Console.WriteLine("{\"ok\":true,\"stage\":" + J(r.StagePath) + ",\"sha256\":" + J(r.PayloadSha256) + ",\"files\":" + r.Files + ",\"directories\":" + r.Directories + ",\"bytes\":" + r.Bytes + "}"); return 0; }
    catch (PayloadException e) { Console.WriteLine("{\"ok\":false,\"code\":" + J(e.Code) + ",\"stage\":" + J(e.RetainedStage) + "}"); return 2; }
  } }`;
const sha = bytes => createHash('sha256').update(bytes).digest();
let root = null, harness = null;

/** Minimal ZIP writer (stored or deflate) with optional header overrides for hostile fixtures. */
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data ?? Buffer.alloc(0), method = e.method ?? 0, body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.crc ?? crc32(raw), size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.unix ? (3 << 8) | 20 : 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((e.external ?? 0) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** Synthetic setup: fake PE prefix + payload + trailer (magic, u64 offset, u64 length, raw SHA-256). */
function setup(payload, { prefix = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]), offset, length, hash, magic = 'ARCANE-SETUP-V1\0' } = {}) {
  const trailer = Buffer.alloc(64); Buffer.from(magic, 'ascii').copy(trailer, 0);
  trailer.writeBigUInt64LE(BigInt(offset ?? prefix.length), 16); trailer.writeBigUInt64LE(BigInt(length ?? payload.length), 24); (hash ?? sha(payload)).copy(trailer, 32);
  return Buffer.concat([prefix, payload, trailer]);
}
const goodEntries = () => [
  { name: 'bundle/' }, { name: 'bundle/Arcane.exe', data: Buffer.from('fixture app') }, { name: 'bundle/resources/node/node.exe', data: Buffer.from('fixture node'), method: 8 },
  { name: 'kit/install-cli.mjs', data: Buffer.from('export {}') }, { name: 'kit-manifest.json', data: Buffer.from('{}') }];
async function owned(name) { const dir = await fs.mkdtemp(join(root, name + '-')); return dir; }
async function run(file, stage, expected) {
  const result = spawnSync(harness, [file, stage, expected], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined, String(result.error)); return JSON.parse(result.stdout.trim());
}
async function writeSetup(bytes) { const dir = await owned('setup'), file = join(dir, 'Arcane-Setup.exe'); await fs.writeFile(file, bytes); return file; }

test.before(async () => {
  if (!windows) return;
  const boundary = await fs.realpath(tmpdir()); root = await fs.realpath(await fs.mkdtemp(join(boundary, 'arcane-payload-test-')));
  const build = join(root, 'harness'); await fs.mkdir(build); await fs.writeFile(join(build, 'Harness.cs'), HARNESS);
  await fs.copyFile(source, join(build, 'PayloadArchive.cs')); harness = join(build, 'payload-harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + harness, '/reference:System.IO.Compression.dll', join(build, 'PayloadArchive.cs'), join(build, 'Harness.cs')],
    { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
});
test.after(async () => {
  if (!root) return; const boundary = await fs.realpath(tmpdir()), p = relative(boundary, root);
  assert.ok(p.startsWith('arcane-payload-test-') && !isAbsolute(p) && !p.includes(sep)); await fs.rm(root, { recursive: true, force: true });
});

test('a valid pinned payload is stream-verified and extracted exactly into a fresh stage', { skip: !windows }, async () => {
  const payload = zip(goodEntries()), file = await writeSetup(setup(payload)), stage = join(await owned('stage'), 'fresh');
  const out = await run(file, stage, sha(payload).toString('hex'));
  assert.deepEqual([out.ok, out.stage, out.sha256, out.files, out.bytes], [true, stage, sha(payload).toString('hex'), 4, 'fixture app'.length + 'fixture node'.length + 'export {}'.length + 2]);
  assert.equal(await fs.readFile(join(stage, 'bundle', 'resources', 'node', 'node.exe'), 'utf8'), 'fixture node', 'deflate entry streamed');
  assert.equal(await fs.readFile(join(stage, 'kit-manifest.json'), 'utf8'), '{}');
  assert.deepEqual((await fs.readdir(stage)).sort(), ['bundle', 'kit', 'kit-manifest.json']);
});

test('trailer corruption, truncation, range overflow/overlap and hash mismatches refuse before any stage exists', { skip: !windows }, async () => {
  const payload = zip(goodEntries()), hex = sha(payload).toString('hex'), parentFor = async () => join(await owned('stage'), 'fresh');
  const flipped = Buffer.from(setup(payload)); flipped[600] ^= 0xff;
  const cases = [
    ['payload byte flipped', flipped, hex, 'PAYLOAD_HASH'],
    ['trailer hash differs from pinned', setup(payload, { hash: Buffer.alloc(32, 7) }), hex, 'TRAILER_HASH'],
    ['pinned hash differs', setup(payload), 'a'.repeat(64), 'TRAILER_HASH'],
    ['bad magic', setup(payload, { magic: 'ARCANE-SETUP-V2\0' }), hex, 'TRAILER_MAGIC'],
    ['truncated file', Buffer.from('MZ' + 'x'.repeat(40)), hex, 'TRAILER_MISSING'],
    ['truncated trailer', setup(payload).subarray(0, setup(payload).length - 10), hex, 'TRAILER_MAGIC'],
    ['offset past payload', setup(payload, { offset: 1 << 30 }), hex, 'TRAILER_RANGE'],
    ['length overlaps trailer', setup(payload, { length: payload.length + 1 }), hex, 'TRAILER_RANGE'],
    ['u64 overflow', setup(payload, { offset: 512, length: 0xffffffffffffffffn }), hex, 'TRAILER_RANGE'],
    ['zero offset (no PE prefix)', setup(payload, { offset: 0 }), hex, 'TRAILER_RANGE'],
    ['zero length', setup(payload, { length: 0 }), hex, 'TRAILER_RANGE'],
    ['malformed pinned hash', setup(payload), 'XYZ', 'EXPECTED_HASH'],
  ];
  for (const [what, bytes, expected, code] of cases) {
    const stage = await parentFor(), out = await run(await writeSetup(bytes), stage, expected);
    assert.deepEqual([out.ok, out.code, out.stage], [false, code, null], what); assert.equal(existsSync(stage), false, what + ': no stage');
  }
});

test('hostile entry names, links, duplicates, layout and bounds refuse before any stage exists', { skip: !windows }, async () => {
  const base = goodEntries();
  const cases = [
    ['parent segment', { name: 'bundle/../evil.txt' }, 'ENTRY_NAME'], ['leading parent', { name: '../evil.txt' }, 'ENTRY_NAME'], ['absolute', { name: '/bundle/x' }, 'ENTRY_NAME'],
    ['drive', { name: 'C:/x' }, 'ENTRY_NAME'], ['backslash', { name: 'bundle\\x' }, 'ENTRY_NAME'], ['ADS', { name: 'bundle/a.txt:stream' }, 'ENTRY_NAME'],
    ['device', { name: 'bundle/CON.txt' }, 'ENTRY_NAME'], ['trailing dot', { name: 'bundle/x.' }, 'ENTRY_NAME'], ['dot segment', { name: 'bundle/./x' }, 'ENTRY_NAME'],
    ['control char (refused by .NET ZipArchive itself or by name validation)', { name: 'bundle/a\u0001b' }, ['ENTRY_NAME', 'ZIP_INVALID']], ['case duplicate', { name: 'bundle/arcane.EXE', data: Buffer.from('x') }, 'ENTRY_DUPLICATE'],
    ['case-variant top level (exact outer names only)', { name: 'BUNDLE/other.bin', data: Buffer.from('x') }, 'ENTRY_UNEXPECTED'],
    ['file/dir prefix conflict', { name: 'bundle/Arcane.exe/inner', data: Buffer.from('x') }, 'ENTRY_DUPLICATE'],
    ['unexpected top level', { name: 'other/x', data: Buffer.from('x') }, 'ENTRY_UNEXPECTED'], ['unix symlink', { name: 'bundle/link', data: Buffer.from('/etc/passwd'), unix: true, external: 0o120777 << 16 }, 'ENTRY_LINK'],
    ['reparse attribute', { name: 'bundle/junction', external: 0x400 | 0x10 }, 'ENTRY_LINK'],
    ['declared oversize', { name: 'bundle/big.bin', data: Buffer.from('x'), declaredSize: 600 * 1024 * 1024 }, 'ENTRY_SIZE'],
    ['path too long', { name: 'bundle/' + 'd'.repeat(120) + '/' + 'f'.repeat(140), data: Buffer.from('x') }, 'PATH_TOO_LONG'],
  ];
  for (const [what, entry, code] of cases) {
    const payload = zip([...base, entry]), stage = join(await owned('stage'), 'fresh'), out = await run(await writeSetup(setup(payload)), stage, sha(payload).toString('hex'));
    assert.equal(out.ok, false, what); assert.ok((Array.isArray(code) ? code : [code]).includes(out.code), what + ': ' + out.code); assert.equal(out.stage, null, what);
    assert.equal(existsSync(stage), false, what + ': no stage');
  }
  const noManifest = zip(base.filter(e => e.name !== 'kit-manifest.json')), stage = join(await owned('stage'), 'fresh');
  assert.equal((await run(await writeSetup(setup(noManifest)), stage, sha(noManifest).toString('hex'))).code, 'ENTRY_UNEXPECTED', 'kit-manifest.json required');
  const many = zip([...base, ...Array.from({ length: 40001 }, (_, i) => ({ name: 'bundle/m/' + i }))]), manyStage = join(await owned('stage'), 'fresh');
  assert.equal((await run(await writeSetup(setup(many)), manyStage, sha(many).toString('hex'))).code, 'LIMIT', 'entry count bound'); assert.equal(existsSync(manyStage), false);
});

test('stage must be fresh, direct and owned: pre-existing, missing parent and junction parents refuse', { skip: !windows }, async () => {
  const payload = zip(goodEntries()), file = await writeSetup(setup(payload)), hex = sha(payload).toString('hex');
  const existing = await owned('existing'); await fs.writeFile(join(existing, 'keep.txt'), 'user');
  assert.equal((await run(file, existing, hex)).code, 'STAGE_EXISTS'); assert.deepEqual(await fs.readdir(existing), ['keep.txt'], 'pre-existing content untouched');
  assert.equal((await run(file, join(root, 'missing-parent', 'stage'), hex)).code, 'STAGE_PARENT');
  const real = await owned('real'), junction = join(root, 'junction-' + Date.now()); await fs.symlink(real, junction, 'junction');
  const out = await run(file, join(junction, 'stage'), hex); assert.equal(out.code, 'REPARSE'); assert.deepEqual(await fs.readdir(real), [], 'nothing written through the junction');
  for (const bad of ['relative\\stage', '\\\\server\\share\\stage', 'C:/forward/slash', join(root, 'x') + ':ads']) assert.match((await run(file, bad, hex)).code, /^STAGE_PATH$/, bad);
});

test('a deflate entry that expands beyond its declared size fails during extraction and RETAINS the stage', { skip: !windows }, async t => {
  const bomb = { name: 'bundle/bomb.bin', data: Buffer.alloc(200000, 0x61), method: 8, declaredSize: 16 };
  const payload = zip([...goodEntries(), bomb]), stage = join(await owned('stage'), 'fresh'), out = await run(await writeSetup(setup(payload)), stage, sha(payload).toString('hex'));
  t.diagnostic('expanding entry refused with ' + out.code);
  assert.equal(out.ok, false); assert.equal(out.code, 'ENTRY_SIZE', 'refused by the declared-size bound'); assert.equal(out.stage, stage, 'retained stage reported');
  assert.ok(existsSync(stage), 'failed stage retained for inspection');
  const partial = existsSync(join(stage, 'bundle', 'bomb.bin')) ? (await fs.stat(join(stage, 'bundle', 'bomb.bin'))).size : 0;
  assert.ok(partial <= 16, 'never more than the declared bytes written: ' + partial);
});
