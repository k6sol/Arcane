import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

// Actual C# verifier in a separate console harness. Fixtures contain synthetic
// PE bytes and scripts; nothing from the extracted kit or runtime is executed.
const windows = process.platform === 'win32', sha = value => createHash('sha256').update(value).digest('hex');
const modules = ['windows-install-cli.mjs', 'windows-installation.mjs', 'package-windows.mjs', 'create-local-release.mjs', 'managed-luau-compiler.mjs'];
let root, harness;
test.before(async () => {
  if (!windows) return;
  const boundary = await fs.realpath(tmpdir()); root = await fs.mkdtemp(join(boundary, 'arcane-kit-test-'));
  await fs.copyFile(new URL('../../installer/KitVerifier.cs', import.meta.url), join(root, 'KitVerifier.cs'));
  await fs.writeFile(join(root, 'Harness.cs'), 'using System; using Arcane.Installer; class Harness { static int Main(string[] a) { try { var r=KitVerifier.Verify(a[0],a[1]); Console.WriteLine(r.BundleManifestSha256); return 0; } catch(KitException e) { Console.WriteLine(e.Code); return 2; } } }');
  harness = join(root, 'verify.exe');
  const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + harness, join(root, 'KitVerifier.cs'), join(root, 'Harness.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test.after(async () => {
  if (!root) return; const boundary = await fs.realpath(tmpdir()), part = relative(boundary, root);
  assert.ok(part.startsWith('arcane-kit-test-') && !isAbsolute(part) && !part.includes(sep)); await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const stage = await fs.mkdtemp(join(root, 'stage-')); await fs.mkdir(join(stage, 'kit/scripts'), { recursive: true }); await fs.mkdir(join(stage, 'bundle/resources/node'), { recursive: true });
  const files = [];
  for (const module of modules) { const path = 'kit/scripts/' + module, bytes = Buffer.from('// synthetic kit'); await fs.writeFile(join(stage, path), bytes); files.push({ path, bytes: bytes.length, sha256: sha(bytes) }); }
  const node = Buffer.alloc(256); node.write('MZ'); node.writeUInt32LE(128, 0x3c); node.writeUInt32LE(0x00004550, 128); node.writeUInt16LE(0x8664, 132);
  await fs.writeFile(join(stage, 'bundle/resources/node/node.exe'), node); await fs.writeFile(join(stage, 'bundle/windows-manifest.json'), '{}');
  const manifest = { schemaVersion: 1, kind: 'arcane-windows-installer-kit', bundleManifestSha256: sha('{}'), node: { path: 'bundle/resources/node/node.exe', bytes: node.length, sha256: sha(node) }, files };
  const pin = async () => { const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(join(stage, 'kit-manifest.json'), bytes); return sha(bytes); };
  return { stage, manifest, pin, node };
}
function run(stage, pin) {
  const result = spawnSync(harness, [stage, pin], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined); assert.ok(result.status === 0 || result.status === 2, result.stderr); return { code: result.status, value: result.stdout.trim() };
}
test('the actual verifier pins the fixed module closure, Node PE and bundle manifest before execution', { skip: !windows }, async () => {
  const f = await fixture(); assert.deepEqual(run(f.stage, await f.pin()), { code: 0, value: f.manifest.bundleManifestSha256 });
});
test('manifest, module, runtime and bundle-manifest tampering each refuse independently', { skip: !windows }, async () => {
  for (const [path, code] of [['kit-manifest.json', 'MANIFEST_HASH'], ['kit/scripts/windows-installation.mjs', 'MODULE_HASH'], ['bundle/resources/node/node.exe', 'NODE_HASH'], ['bundle/windows-manifest.json', 'BUNDLE_MANIFEST']]) {
    const f = await fixture(), pin = await f.pin(); await fs.writeFile(join(f.stage, path), 'tampered'); assert.deepEqual(run(f.stage, pin), { code: 2, value: code }, path);
  }
});
test('even repinned manifests cannot widen paths, module closure, version or runtime architecture', { skip: !windows }, async () => {
  const cases = [
    [f => { f.manifest.files[0].path = '../outside.mjs'; }, 'MODULES'],
    [f => { f.manifest.files[1].path = f.manifest.files[0].path; }, 'MODULES'],
    [f => { f.manifest.node.path = 'bundle/another.exe'; }, 'NODE'],
    [f => { f.manifest.schemaVersion = 2; }, 'MANIFEST'],
    [f => { f.manifest.files[0].bytes = '16'; }, 'MANIFEST'],
    [f => { f.manifest.node.sha256 = 'A'.repeat(64); }, 'HASH'],
    [f => { f.manifest.extra = true; }, 'MANIFEST'],
  ];
  for (const [change, code] of cases) { const f = await fixture(); change(f); assert.deepEqual(run(f.stage, await f.pin()), { code: 2, value: code }); }
  const f = await fixture(); f.node.writeUInt16LE(0x14c, 132); await fs.writeFile(join(f.stage, 'bundle/resources/node/node.exe'), f.node); f.manifest.node.sha256 = sha(f.node);
  assert.deepEqual(run(f.stage, await f.pin()), { code: 2, value: 'NODE_PE' });
});
test('extra kit or outer entries and redirected module ancestors refuse without changing their targets', { skip: !windows }, async () => {
  for (const extra of ['unlisted.txt', 'kit/other', 'kit/scripts/extra.mjs']) {
    const f = await fixture(), pin = await f.pin(); await fs.writeFile(join(f.stage, extra), 'keep'); const result = run(f.stage, pin);
    assert.equal(result.code, 2); assert.ok(['LAYOUT', 'MODULES'].includes(result.value)); assert.equal(await fs.readFile(join(f.stage, extra), 'utf8'), 'keep');
  }
  const f = await fixture(), pin = await f.pin(), moved = join(root, 'redirect-target'); await fs.rename(join(f.stage, 'kit/scripts'), moved); await fs.symlink(moved, join(f.stage, 'kit/scripts'), 'junction');
  assert.deepEqual(run(f.stage, pin), { code: 2, value: 'REDIRECT' }); assert.equal((await fs.readdir(moved)).length, 5);
});
