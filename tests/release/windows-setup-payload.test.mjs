import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createWindowsSetupPayload, WINDOWS_SETUP_KIT_FILES } from '../../scripts/windows-setup-payload.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
// Actual streaming ZIP writer and owned files; this verifier and the tiny
// bundle/kit are SCRIPTED. Native extraction and full package acceptance differ.
async function fixture(t) {
  const boundary = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(boundary, 'arcane-setup-zip-'));
  t.after(async () => { const part = relative(boundary, root); assert.ok(part.startsWith('arcane-setup-zip-') && !isAbsolute(part) && !part.includes(sep)); await fs.rm(root, { recursive: true, force: true }); });
  const bundle = join(root, 'bundle'), kitRoot = join(root, 'kit'), output = join(root, 'payload.zip');
  await fs.mkdir(join(bundle, 'resources/node'), { recursive: true }); await fs.mkdir(join(kitRoot, 'scripts'), { recursive: true });
  const files = [];
  for (const [path, text] of [['Arcane.exe', 'fixture app'], ['resources/node/node.exe', 'fixture node']]) {
    const bytes = Buffer.from(text); await fs.writeFile(join(bundle, path), bytes); files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = { files, totalBytes: files.reduce((n, x) => n + x.bytes, 0) };
  await fs.writeFile(join(bundle, 'windows-manifest.json'), JSON.stringify(manifest));
  for (const path of WINDOWS_SETUP_KIT_FILES) await fs.writeFile(join(kitRoot, path), '// fixture ' + path);
  const verifyBundle = async directory => { const bytes = await fs.readFile(join(directory, 'windows-manifest.json')); return { manifestSha256: sha(bytes), files: files.length, bytes: manifest.totalBytes }; };
  return { root, bundle, kitRoot, output, verifyBundle };
}
function readZip(bytes) {
  const end = bytes.subarray(-22); assert.equal(end.readUInt32LE(), 0x06054b50);
  const count = end.readUInt16LE(10), entries = new Map(); let offset = end.readUInt32LE(16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), name = bytes.subarray(offset + 46, offset + 46 + length).toString();
    const local = bytes.readUInt32LE(offset + 42), start = local + 30 + bytes.readUInt16LE(local + 26), size = bytes.readUInt32LE(offset + 24), content = bytes.subarray(start, start + size);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50); assert.equal(bytes.readUInt32LE(offset + 16), crc32(content));
    assert.equal(bytes.readUInt32LE(start + size), 0x08074b50); assert.equal(bytes.readUInt32LE(start + size + 8), size);
    entries.set(name, content); offset += 46 + length;
  }
  assert.equal(offset, bytes.length - 22); return entries;
}
test('payload ZIP streams exact bundle and fixed installer kit with independent byte pins', async t => {
  const f = await fixture(t), result = await createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build(f), bytes = await fs.readFile(f.output), entries = readZip(bytes);
  assert.equal(result.payloadSha256, sha(bytes)); assert.equal(result.bytes, bytes.length); assert.equal(result.files, 9);
  const manifest = JSON.parse(entries.get('kit-manifest.json')); assert.equal(sha(entries.get('kit-manifest.json')), result.kitManifestSha256);
  assert.equal(manifest.node.sha256, sha(entries.get('bundle/resources/node/node.exe')));
  assert.deepEqual(manifest.files.map(x => x.path), WINDOWS_SETUP_KIT_FILES.map(path => 'kit/' + path));
  for (const file of manifest.files) { assert.equal(file.sha256, sha(entries.get(file.path))); assert.equal(file.bytes, entries.get(file.path).length); }
  const second = join(f.root, 'second.zip'); await createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build({ ...f, output: second });
  assert.deepEqual(await fs.readFile(second), bytes, 'same reviewed inputs produce identical ZIP bytes');
});
test('source verification, fixed kit closure and exclusive output are admitted before writing', async t => {
  const f = await fixture(t), builder = createWindowsSetupPayload({ verifyBundle: async () => { throw new Error('fixture refused'); } });
  await assert.rejects(builder.build(f), /fixture refused/); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  await fs.unlink(join(f.kitRoot, WINDOWS_SETUP_KIT_FILES[0]));
  await assert.rejects(createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build(f), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  await fs.writeFile(join(f.kitRoot, WINDOWS_SETUP_KIT_FILES[0]), 'fixture'); await fs.writeFile(f.output, 'keep');
  await assert.rejects(createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build(f), { code: 'EEXIST' }); assert.equal(await fs.readFile(f.output, 'utf8'), 'keep');
});
test('changed source bytes retain a failed payload rather than rehashing or retrying them', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.bundle, 'Arcane.exe'), 'tampered');
  await assert.rejects(createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build(f), error => /changed/.test(error.message) && error.retainedPayload === f.output);
  assert.ok((await fs.stat(f.output)).size > 0);
});
test('an output replaced before final acceptance is retained and never reported as the verified payload', async t => {
  const f = await fixture(t); let calls = 0;
  const builder = createWindowsSetupPayload({ verifyBundle: async directory => {
    const proof = await f.verifyBundle(directory);
    if (++calls === 2) { await fs.rename(f.output, join(f.root, 'retained.zip')); await fs.writeFile(f.output, 'another writer'); }
    return proof;
  } });
  await assert.rejects(builder.build(f), /changed/);
  assert.equal(await fs.readFile(f.output, 'utf8'), 'another writer'); assert.ok((await fs.stat(join(f.root, 'retained.zip'))).size > 0);
});
test('bundle overlap and redirected or hardlinked kit files refuse before output', async t => {
  const f = await fixture(t), builder = createWindowsSetupPayload({ verifyBundle: f.verifyBundle });
  await assert.rejects(builder.build({ ...f, output: join(f.bundle, 'payload.zip') }), /output/);
  const kitFile = join(f.kitRoot, WINDOWS_SETUP_KIT_FILES[0]); await fs.link(kitFile, join(f.root, 'linked-source'));
  await assert.rejects(builder.build(f), /path/); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('the actual C# payload reader extracts the streamed data-descriptor ZIP', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), receipt = await createWindowsSetupPayload({ verifyBundle: f.verifyBundle }).build(f);
  // Separate console harness; the production setup gains no fixture flags.
  await fs.copyFile(new URL('../../installer/PayloadArchive.cs', import.meta.url), join(f.root, 'PayloadArchive.cs'));
  await fs.writeFile(join(f.root, 'Harness.cs'), 'using System; using Arcane.Installer; class Harness { static int Main(string[] a) { try { var r=PayloadArchive.VerifyAndExtract(a[0],a[1],a[2]); Console.WriteLine(r.Files); return 0; } catch(PayloadException e) { Console.Error.WriteLine(e.Code); return 2; } } }');
  const executable = join(f.root, 'extract.exe'), csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.IO.Compression.dll', '/out:' + executable, join(f.root, 'PayloadArchive.cs'), join(f.root, 'Harness.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const zip = await fs.readFile(f.output), prefix = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]), trailer = Buffer.alloc(64);
  Buffer.from('ARCANE-SETUP-V1\0').copy(trailer); trailer.writeBigUInt64LE(BigInt(prefix.length), 16); trailer.writeBigUInt64LE(BigInt(zip.length), 24); Buffer.from(receipt.payloadSha256, 'hex').copy(trailer, 32);
  const self = join(f.root, 'fixture-setup.exe'), stage = join(f.root, 'extracted'); await fs.writeFile(self, Buffer.concat([prefix, zip, trailer]));
  const extracted = spawnSync(executable, [self, stage, receipt.payloadSha256], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr); assert.equal(Number(extracted.stdout.trim()), receipt.files);
  const entries = readZip(zip);
  for (const [name, content] of entries) assert.deepEqual(await fs.readFile(join(stage, ...name.split('/'))), content, name);
});
