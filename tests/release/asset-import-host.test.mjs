import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

// Main-process import host and the preload contract, from source: no Electron, build, network or user files.
const require = createRequire(import.meta.url);
const { createAssetImportHost, prepareImport, ASSET_IMPORT_LIMITS, ASSET_IMPORT_CHANNELS } = require('../../apps/desktop/electron/asset-import.cjs');
const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const origin = 'http://127.0.0.1:45871', token = 'a'.repeat(64);

function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } })), length = Math.ceil(json.length / 4) * 4;
  const out = Buffer.alloc(20 + length); out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(length, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(0x20, 20); json.copy(out, 20); return out;
}
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'arcane-import-host-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('file admission: extension, first bytes, size, links and .gltf siblings', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'oak.glb'), glb());
  const ok = await prepareImport(join(dir, 'oak.glb'));
  assert.equal(ok.format, 'glb'); assert.equal(ok.name, 'oak.glb'); assert.equal(ok.body.length, glb().length);
  await writeFile(join(dir, 'renamed.glb'), Buffer.from('PK\x03\x04 not a model'));
  await assert.rejects(prepareImport(join(dir, 'renamed.glb')), /isn’t a GLB model/);
  await writeFile(join(dir, 'tree.fbx'), Buffer.from('Kaydara FBX Binary'));
  await assert.rejects(prepareImport(join(dir, 'tree.fbx')), /FBX files need converting first.*GLB/);
  await writeFile(join(dir, 'chair.obj'), 'v 0 0 0');
  await assert.rejects(prepareImport(join(dir, 'chair.obj')), /OBJ files need converting first/);
  await writeFile(join(dir, 'fx.rbxm'), Buffer.from('<roblox!\x89\xff\r\n', 'latin1'));
  await assert.rejects(prepareImport(join(dir, 'fx.rbxm')), /\.rbxmx/);
  await writeFile(join(dir, 'fake.rbxmx'), Buffer.from('<roblox!\x89\xff\r\n', 'latin1'));
  await assert.rejects(prepareImport(join(dir, 'fake.rbxmx')), /\.rbxmx/);
  await writeFile(join(dir, 'page.rbxmx'), '<html></html>');
  await assert.rejects(prepareImport(join(dir, 'page.rbxmx')), /isn’t a Roblox model file/);
  await writeFile(join(dir, 'notes.txt'), 'hello');
  await assert.rejects(prepareImport(join(dir, 'notes.txt')), /imports GLB and glTF models and Roblox \.rbxmx effects/);
  await writeFile(join(dir, 'empty.glb'), '');
  await assert.rejects(prepareImport(join(dir, 'empty.glb')), /empty/);
  await writeFile(join(dir, 'huge.glb'), glb()); await truncate(join(dir, 'huge.glb'), ASSET_IMPORT_LIMITS.glbBytes + 1);
  await assert.rejects(prepareImport(join(dir, 'huge.glb')), /up to 64 MB/);
  for (const bad of ['relative.glb', '\\\\server\\share\\oak.glb', dir + '\\..\\x\\..\\oak.glb', 'C:\\con\\oak.glb', 42, ''])
    await assert.rejects(prepareImport(bad), /ordinary files|can’t be opened|imports GLB/, String(bad));
  // A junction (no admin rights needed on Windows) is a link in the path: refused.
  await mkdir(join(dir, 'real')); await writeFile(join(dir, 'real', 'oak.glb'), glb());
  await symlink(join(dir, 'real'), join(dir, 'linked'), 'junction');
  await assert.rejects(prepareImport(join(dir, 'linked', 'oak.glb')), /not shortcuts, linked folders or network paths/);
  // .gltf: a sibling buffer and texture are inlined; nothing outside the folder is read.
  await mkdir(join(dir, 'scene', 'tex'), { recursive: true });
  await writeFile(join(dir, 'scene', 'scene.bin'), Buffer.alloc(36, 1));
  await writeFile(join(dir, 'scene', 'tex', 'bark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, 'scene', 'tree.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 36 }], images: [{ uri: 'tex/bark%2Epng' }] }));
  const packed = await prepareImport(join(dir, 'scene', 'tree.gltf'));
  const inlined = JSON.parse(packed.body.toString('utf8'));
  assert.equal(packed.format, 'gltf');
  assert.equal(inlined.buffers[0].uri, 'data:application/octet-stream;base64,' + Buffer.alloc(36, 1).toString('base64'));
  assert.match(inlined.images[0].uri, /^data:image\/png;base64,/);
  for (const uri of ['../oak.glb', '..%2Foak.glb', 'C:/Windows/win.ini', 'file:///C:/Windows/win.ini', '/etc/passwd', 'https://example.com/a.bin', 'sub//x.bin'])
  {
    await writeFile(join(dir, 'scene', 'escape.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 4 }] }));
    await assert.rejects(prepareImport(join(dir, 'scene', 'escape.gltf')), /outside its folder/, uri);
  }
  await writeFile(join(dir, 'scene', 'missing.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'gone.bin', byteLength: 4 }] }));
  await assert.rejects(prepareImport(join(dir, 'scene', 'missing.gltf')), /missing: gone\.bin/);
  await writeFile(join(dir, 'scene', 'gif.gltf'), JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'tex/bark.gif' }] }));
  await assert.rejects(prepareImport(join(dir, 'scene', 'gif.gltf')), /PNG or JPEG/);
});

test('import host: native picker, consent over child IPC before the upload, opaque ids back, refusals in plain words', async t => {
  const dir = await folder(t), window = {};
  await writeFile(join(dir, 'oak.glb'), glb()); await writeFile(join(dir, 'tree.fbx'), 'x');
  const run = async ({ picked = [join(dir, 'oak.glb')], canceled = false, reply = { status: 201, body: { import: { id: '0f0e0d0c-0b0a-4908-8706-050403020100', kind: 'model', name: 'oak' }, duplicate: false } }, session } = {}) => {
    const sent = [], calls = [], dialogs = [];
    const current = session === undefined ? { window, origin, token, send: message => sent.push(message) } : session;
    const host = createAssetImportHost({ getSession: () => current, randomBytes: () => Buffer.alloc(32, 9),
      dialog: { showOpenDialog: async (owner, options) => { dialogs.push({ owner, options }); return { canceled, filePaths: picked }; } },
      fetch: async (url, init) => { calls.push({ url, init, sentBefore: sent.length }); return { ok: reply.status < 300, status: reply.status, json: async () => reply.body }; } });
    return { result: await host.pick(), sent, calls, dialogs };
  };
  const ok = await run();
  assert.equal(ok.dialogs[0].owner, window, 'the picker is a native dialog owned by the workspace window');
  assert.deepEqual(ok.dialogs[0].options.properties, ['openFile', 'multiSelections', 'dontAddToRecent']);
  assert.ok(ok.dialogs[0].options.filters[0].extensions.includes('glb'));
  const consent = Buffer.alloc(32, 9).toString('hex');
  assert.deepEqual(ok.sent, [{ type: 'arcane-asset-import-consent', protocolVersion: 1, consent }]);
  assert.equal(ok.calls[0].sentBefore, 1, 'consent travels over IPC before the HTTP upload');
  assert.equal(ok.calls[0].url, origin + '/v1/imports/upload?format=glb&name=oak.glb');
  assert.deepEqual(ok.calls[0].init.headers, { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-Arcane-Import-Consent': consent });
  assert.equal(ok.calls[0].init.redirect, 'error');
  assert.deepEqual(ok.result, { state: 'imported', message: '', imported: [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', name: 'oak', kind: 'model', duplicate: false }], refused: [] });
  assert.ok(Object.isFrozen(ok.result) && Object.isFrozen(ok.result.imported[0]));
  assert.doesNotMatch(JSON.stringify(ok.result), new RegExp(dir.replaceAll('\\', '\\\\\\\\')), 'no path reaches the renderer');
  const cancelled = await run({ canceled: true });
  assert.equal(cancelled.result.state, 'cancelled'); assert.equal(cancelled.calls.length, 0); assert.deepEqual(cancelled.sent, []);
  const mixed = await run({ picked: [join(dir, 'oak.glb'), join(dir, 'tree.fbx')] });
  assert.equal(mixed.result.imported.length, 1);
  assert.deepEqual(mixed.result.refused.map(row => row.name), ['tree.fbx']); assert.match(mixed.result.refused[0].message, /FBX files need converting first/);
  const refused = await run({ reply: { status: 400, body: { error: 'MODEL', message: 'Arcane can’t preview this model safely.' } } });
  assert.equal(refused.result.state, 'refused'); assert.equal(refused.result.refused[0].message, 'Arcane can’t preview this model safely.');
  const forged = await run({ reply: { status: 201, body: { import: { id: '../../x', kind: 'model' } } } });
  assert.equal(forged.result.state, 'refused', 'a malformed daemon reply is not passed on');
  const none = await run({ session: null });
  assert.equal(none.result.state, 'unavailable'); assert.equal(none.dialogs.length, 0);
  // IPC: zero-argument pick, bounded string paths for drops, trusted workspace frame only.
  const handlers = new Map();
  createAssetImportHost({ getSession: () => null, dialog: { showOpenDialog: async () => assert.fail('untrusted') } }).installIpc({ handle: (name, fn) => handlers.set(name, fn) }, { trusted: event => event.trusted === true });
  assert.deepEqual([...handlers.keys()].sort(), [ASSET_IMPORT_CHANNELS.files, ASSET_IMPORT_CHANNELS.pick].sort());
  await assert.rejects(handlers.get(ASSET_IMPORT_CHANNELS.pick)({ trusted: false }), /unavailable/);
  await assert.rejects(handlers.get(ASSET_IMPORT_CHANNELS.pick)({ trusted: true }, 'C:\\x.glb'), /unavailable/);
  for (const args of [[], ['C:\\x.glb'], [[]], [[42]], [Array(65).fill('C:\\x.glb')], [['']]]) await assert.rejects(handlers.get(ASSET_IMPORT_CHANNELS.files)({ trusted: true }, ...args), /unavailable/);
  await assert.rejects(handlers.get(ASSET_IMPORT_CHANNELS.files)({ trusted: false }, ['C:\\x.glb']), /unavailable/);
  assert.equal((await handlers.get(ASSET_IMPORT_CHANNELS.files)({ trusted: true }, ['C:\\x.glb'])).state, 'unavailable');
});

test('preload: one frozen assetImport bridge, files become paths only through webUtils, replies are re-checked', async () => {
  const invoked = [];
  let exposed;
  vm.runInNewContext(source('apps/desktop/electron/preload.cjs'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(key, value) { exposed = value; } },
        ipcRenderer: { invoke: async (channel, ...args) => { invoked.push({ channel, args }); return { state: 'imported', message: '', imported: [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', name: 'oak', kind: 'model', duplicate: false, extra: 'dropped' }], refused: [{ name: 'tree.fbx', message: 'FBX files need converting first.' }] }; }, on() {}, removeListener() {} },
        webUtils: { getPathForFile: file => file.path ?? '' } };
    },
  });
  const bridge = exposed.assetImport;
  assert.ok(Object.isFrozen(bridge)); assert.deepEqual(Object.keys(bridge).sort(), ['importFiles', 'pick', 'version']);
  const picked = await bridge.pick();
  const last = () => JSON.parse(JSON.stringify(invoked.at(-1)));
  assert.deepEqual(last(), { channel: 'arcane:asset-import-pick', args: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(picked.imported)), [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', name: 'oak', kind: 'model', duplicate: false }]);
  await assert.rejects(bridge.pick('C:\\x.glb'), /unavailable/);
  await bridge.importFiles({ path: 'C:\\Users\\me\\oak.glb' }, { path: 'C:\\Users\\me\\fx.rbxmx' });
  assert.deepEqual(last(), { channel: 'arcane:asset-import-files', args: [['C:\\Users\\me\\oak.glb', 'C:\\Users\\me\\fx.rbxmx']] });
  const before = invoked.length;
  await assert.rejects(bridge.importFiles({ name: 'made-up' }), /from your computer/, 'a File without a real path never reaches the host');
  await assert.rejects(bridge.importFiles(), /unavailable/);
  assert.equal(invoked.length, before);
});

test('main, daemon and lab wire the import host exactly once', () => {
  const main = source('apps/desktop/electron/main.cjs'), product = source('apps/daemon/src/product-main.ts'), lab = source('apps/daemon/src/lab-server.ts');
  assert.match(main, /require\('\.\/asset-import\.cjs'\)\.createAssetImportHost\(\{ enabled: !smoke, dialog,/);
  assert.match(product, /app\.imports\?\.enableConsentChannel\(\)/);
  assert.match(product, /if \(app\.imports\?\.acceptConsent\(message\)\) return;/);
  assert.match(lab, /if\(imports&&await imports\.handle\(request,response,url,token,origin\)\)return;/);
});
