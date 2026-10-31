import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// Headless Edge, the real page markup and CSS, the real import UI (asset-imports.js), the real viewer and its WebGL
// runtimes on SwiftShader, the real daemon import store and routes, and the real main-process import host
// (asset-import.cjs). Only Electron itself is replaced: the native picker returns a fixture path and the private child
// IPC channel is a direct call. Run with a private emit:
//   ARCANE_IMPORT_EMIT=<tsc outDir with apps/desktop/src/*.js and apps/daemon/src/imported-assets.js>
//   optional ARCANE_IMPORT_BROWSER=<Edge executable>, ARCANE_IMPORT_SHOTS=<screenshot directory>,
//   ARCANE_IMPORT_REAL_GLB=<a real Blender GLB to import as well>.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const emit = process.env.ARCANE_IMPORT_EMIT;
const browserPath = process.env.ARCANE_IMPORT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const shots = process.env.ARCANE_IMPORT_SHOTS;
const TOKEN = 'a'.repeat(64);
const require = createRequire(import.meta.url);

function png() {
  const crc = data => { let n = 0xffffffff; for (const byte of data) { n ^= byte; for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc(Buffer.concat([type, data])), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 220, 120, 35, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
/** A real textured box, written as a GLB the way an exporter would. */
function glb() {
  const geometry = new BoxGeometry(2, 1, .5).toNonIndexed(), chunks = [], bufferViews = [], accessors = [];
  let length = 0;
  const view = bytes => { const index = bufferViews.length, data = Buffer.from(bytes); bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length }); const padding = Buffer.alloc((4 - data.length % 4) % 4); chunks.push(data, padding); length += data.length + padding.length; return index; };
  const accessor = (array, type, extra = {}) => { const index = accessors.length; accessors.push({ bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType: 5126, count: array.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[type]), type, ...extra }); return index; };
  const position = accessor(geometry.attributes.position.array, 'VEC3', { min: [-1, -.5, -.25], max: [1, .5, .25] });
  const normal = accessor(geometry.attributes.normal.array, 'VEC3'), uv = accessor(geometry.attributes.uv.array, 'VEC2'), image = view(png());
  const doc = { asset: { version: '2.0', generator: 'Arcane import fixture' }, buffers: [{ byteLength: length }], bufferViews, accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: .6 } }], images: [{ bufferView: image, mimeType: 'image/png' }], textures: [{ source: 0 }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const json = Buffer.from(JSON.stringify(doc)), jsonLength = Math.ceil(json.length / 4) * 4, bytes = Buffer.alloc(28 + jsonLength + length), bin = Buffer.concat(chunks);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(jsonLength, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonLength); json.copy(bytes, 20); bytes.writeUInt32LE(length, 20 + jsonLength); bytes.writeUInt32LE(0x004e4942, 24 + jsonLength); bin.copy(bytes, 28 + jsonLength);
  geometry.dispose(); return bytes;
}
const CFRAME = (x, y, z) => `<CoordinateFrame name="CFrame"><X>${x}</X><Y>${y}</Y><Z>${z}</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>`;
const emitter = (name, props) => `<Item class="ParticleEmitter"><Properties><string name="Name">${name}</string>${props}</Properties></Item>`;
/** The arcane-vfx campfire recipe as Roblox Studio saves it (.rbxmx): flames, embers, smoke and a glow light. */
const CAMPFIRE = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4"><Item class="Part"><Properties><string name="Name">Campfire</string>${CFRAME(0, 0, 0)}<Vector3 name="size"><X>3</X><Y>.4</Y><Z>3</Z></Vector3></Properties>
<Item class="Attachment"><Properties><string name="Name">Core</string>${CFRAME(0, .3, 0)}</Properties>
${emitter('Flames', '<float name="Rate">40</float><NumberRange name="Lifetime">0.6 1.1 </NumberRange><NumberRange name="Speed">3 5 </NumberRange><Vector2 name="SpreadAngle"><X>8</X><Y>8</Y></Vector2><NumberSequence name="Size">0 1.6 0 0.5 1.2 0 1 0.2 0 </NumberSequence><NumberSequence name="Transparency">0 1 0 0.15 0.35 0 0.7 0.55 0 1 1 0 </NumberSequence><ColorSequence name="Color">0 1 0.82 0.48 0 0.5 1 0.54 0.16 0 1 0.7 0.21 0.1 0 </ColorSequence><float name="LightEmission">1</float><float name="LightInfluence">0</float><Vector3 name="Acceleration"><X>0</X><Y>4</Y><Z>0</Z></Vector3><float name="Drag">1</float><NumberRange name="RotSpeed">-40 40 </NumberRange><Content name="Texture"><url>rbxasset://textures/particles/fire_main.dds</url></Content>')}
${emitter('Embers', '<float name="Rate">8</float><NumberRange name="Lifetime">1.5 2.5 </NumberRange><NumberRange name="Speed">4 8 </NumberRange><Vector2 name="SpreadAngle"><X>25</X><Y>25</Y></Vector2><NumberSequence name="Size">0 0.12 0 1 0 0 </NumberSequence><NumberSequence name="Transparency">0 0 0 0.8 0.2 0 1 1 0 </NumberSequence><ColorSequence name="Color">0 1 0.7 0.28 0 1 1 0.35 0.12 0 </ColorSequence><float name="LightEmission">1</float><Vector3 name="Acceleration"><X>0</X><Y>3</Y><Z>0</Z></Vector3><float name="Drag">1.5</float><Content name="Texture"><url>rbxasset://textures/particles/fire_sparks_main.dds</url></Content>')}
${emitter('Smoke', '<float name="Rate">6</float><NumberRange name="Lifetime">4 6 </NumberRange><NumberRange name="Speed">1.5 3 </NumberRange><Vector2 name="SpreadAngle"><X>12</X><Y>12</Y></Vector2><NumberSequence name="Size">0 1.5 0 1 6 0 </NumberSequence><NumberSequence name="Transparency">0 1 0 0.15 0.7 0 1 1 0 </NumberSequence><ColorSequence name="Color">0 0.35 0.33 0.31 0 1 0.54 0.52 0.5 0 </ColorSequence><Vector3 name="Acceleration"><X>1.2</X><Y>0.6</Y><Z>0.4</Z></Vector3><float name="Drag">0.4</float><Content name="Texture"><url>rbxasset://textures/particles/smoke_main.dds</url></Content>')}
<Item class="PointLight"><Properties><string name="Name">Fire glow</string><float name="Brightness">2</float><float name="Range">14</float><Color3 name="Color"><R>1</R><G>0.56</G><B>0.6</B></Color3></Properties></Item>
</Item></Item></roblox>`;

async function emitted(path) { return readFile(resolve(emit, path)); }
async function start(t, options = {}) {
  const state = await mkdtemp(join(tmpdir(), 'arcane-import-browser-')); t.after(() => rm(state, { recursive: true, force: true }));
  const files = join(state, 'my files'); await mkdir(files);
  await writeFile(join(files, 'crate.glb'), glb());
  await writeFile(join(files, 'campfire.rbxmx'), CAMPFIRE);
  await writeFile(join(files, 'statue.fbx'), 'Kaydara FBX Binary  \0');
  const { createImportedAssets } = await import(pathToFileURL(resolve(emit, 'apps/daemon/src/imported-assets.js')).href);
  const { createAssetImportHost } = require('../../apps/desktop/electron/asset-import.cjs');
  const store = createImportedAssets({ stateDirectory: join(state, 'runtime') }); store.enableConsentChannel();
  const lab = await readFile(resolve(root, 'apps/daemon/src/lab-server.ts'), 'utf8');
  const policy = /setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(lab)?.[1]; assert.ok(policy, 'serve the production CSP');
  const html = (await readFile(resolve(root, 'apps/desktop/public/studio.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('</head>', '<link rel="stylesheet" href="/import-fixture.css"></head>')
    .replace('</body>', '<script type="module" src="/import-fixture.js"></script></body>');
  const bootstrap = `import { AssetViewerPanel } from '/asset-viewer.js';
import { startAssetImports } from '/asset-imports.js';
const token = '${TOKEN}', viewer = new AssetViewerPanel(document, token);
// The preview panel alone, full window: the real markup and CSS, without the sign-in gate or chat around it.
const panel = document.getElementById('artifact-panel'); panel.hidden = false; document.body.append(panel);
document.body.classList.add('import-fixture');
const assetImport = Object.freeze({ version: 1, pick: () => window.arcanePick(), importFiles: (...files) => window.arcaneDrop(files.map(file => file.name)) });
window.arcaneImports = startAssetImports(document, { token: () => token, desktop: { assetImport },
  library: { viewer, generated: () => [], view: () => false, release: () => {} } });
window.arcaneReady = true;`;
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  let origin = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    try {
      if (await store.handle(request, response, url, TOKEN, origin)) return;
      let body = null, type = 'text/javascript';
      if (url.pathname === '/') { body = html; type = 'text/html'; }
      else if (url.pathname === '/import-fixture.js') body = bootstrap;
      else if (url.pathname === '/import-fixture.css') { body = 'body.import-fixture>*:not(#artifact-panel){display:none!important}body.import-fixture>#artifact-panel{position:fixed;inset:0;margin:0}'; type = 'text/css'; }
      else if (url.pathname === '/studio.css' || url.pathname.endsWith('-runtime.mjs') || url.pathname.startsWith('/vendor/three/') || url.pathname.startsWith('/fonts/')) {
        if (!/^\/[A-Za-z0-9/_.-]+$/.test(url.pathname) || url.pathname.includes('..')) throw new Error('path');
        const file = resolve(root, 'apps/desktop/public', '.' + url.pathname); if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
        body = await readFile(file); type = types[url.pathname.slice(url.pathname.lastIndexOf('.'))] ?? 'application/octet-stream';
      } else if (/^\/[a-z][a-z0-9-]*\.js$/.test(url.pathname)) body = await emitted('apps/desktop/src' + url.pathname);
      if (body === null) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': policy, 'Cache-Control': 'no-store' }); response.end(body);
    } catch { if (!response.headersSent) { response.writeHead(404); response.end(); } }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(done => server.close(done)));
  let picked = [];
  const session = { window: {}, origin, token: TOKEN, send: message => { assert.equal(store.acceptConsent(message), true); } };
  const host = createAssetImportHost({ getSession: () => session, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: picked }) } });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  let pickCalls = 0;
  await page.exposeFunction('arcanePick', async () => {
    pickCalls++; const result = await host.pick();
    if (options.losePickReply) throw new Error('Private bridge failure: token=private-fixture');
    return JSON.parse(JSON.stringify(result));
  });
  await page.exposeFunction('arcaneDrop', async names => JSON.parse(JSON.stringify(await host.importFiles(names.map(name => join(files, name))))));
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.arcaneReady === true);
  return { page, errors, files, store, origin, pick: paths => { picked = paths; }, pickCalls: () => pickCalls };
}
async function shot(page, name) { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }); } }
async function canvasPixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#asset-viewer canvas'); if (!canvas) return 0;
    const probe = document.createElement('canvas'); probe.width = 96; probe.height = 64; const context = probe.getContext('2d');
    context.drawImage(canvas, 0, 0, 96, 64); const data = context.getImageData(0, 0, 96, 64).data; let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - 20) + Math.abs(data[i + 1] - 16) + Math.abs(data[i + 2] - 18) > 30) lit++;
    return lit;
  });
}

test('a lost native import reply preserves the stored asset and explains its unconfirmed outcome without replay', { skip: !emit && 'set ARCANE_IMPORT_EMIT', timeout: 60000 }, async t => {
  const f = await start(t, { losePickReply: true });
  f.pick([join(f.files, 'crate.glb')]);
  await f.page.click('#preview-settings');
  await f.page.waitForSelector('.import-notice:not([hidden])');
  const records = await f.store.list();
  assert.equal(records.length, 1, 'original native import completed before its reply was lost');
  const message = await f.page.locator('.import-notice').textContent();
  assert.match(message, /Error 421/);
  assert.match(message, /could not confirm.*import/i);
  assert.match(message, /Check.*asset.*before importing/i);
  assert.doesNotMatch(message, /Nothing was changed|Private bridge|private-fixture/);
  assert.equal(f.pickCalls(), 1);
  // The explicit read-only recovery lists the original stored asset; it does not repeat the native picker/import.
  await f.page.click('#preview-settings');
  await f.page.waitForSelector('#asset-picker:not([hidden])');
  assert.match(await f.page.locator('#asset-picker .import-row').textContent(), /crate/);
  assert.equal(f.pickCalls(), 1);
  assert.deepEqual((await f.store.list()).map(row => row.id), records.map(row => row.id));
  assert.deepEqual(f.errors, []);
});

test('Choose an asset with nothing to choose opens the file picker; a real GLB imports and shows in the viewer', { skip: !emit && 'set ARCANE_IMPORT_EMIT' }, async t => {
  const f = await start(t);
  f.pick([join(f.files, 'crate.glb')]);
  await shot(f.page, 'import-empty-1440');
  await f.page.click('#preview-settings');
  await f.page.waitForSelector('#asset-viewer .vw[data-phase="ready"]', { timeout: 30000 });
  assert.equal(f.pickCalls(), 1, 'no assets: the click went straight to the native picker');
  assert.equal(await f.page.locator('#asset-picker').isHidden(), true, 'no list was shown first');
  const view = await f.page.evaluate(() => ({
    pill: document.querySelector('.vw-pill')?.textContent, chip: document.querySelector('.vw-asset-name')?.textContent, kind: document.querySelector('.vw-asset-kind')?.textContent,
    stats: [...document.querySelectorAll('.vw-stat')].map(n => n.textContent), tiles: [...document.querySelectorAll('.vw-tile')].map(n => n.textContent),
    source: document.querySelector('.vw-import-source')?.textContent, remove: document.querySelector('.vw-import-remove')?.textContent,
    review: !!document.querySelector('.viewer-review'), effects: document.querySelector('.vw-kinds .vw-seg-item:nth-child(2)')?.disabled }));
  assert.equal(view.pill, 'Imported'); assert.equal(view.chip, 'crate'); assert.equal(view.kind, 'Imported model');
  assert.ok(view.stats.some(s => /^Triangles12$/.test(s)), JSON.stringify(view.stats));
  assert.ok(view.stats.some(s => /^Size2\.00 × 1\.00 × 0\.50 m$/.test(s)), JSON.stringify(view.stats));
  assert.ok(view.tiles.includes('Materials1') && view.tiles.includes('Textures1'), JSON.stringify(view.tiles));
  assert.match(view.source, /^Imported by youcrate\.glb · \d+ KB · /);
  assert.equal(view.remove, 'Remove import'); assert.equal(view.review, false, 'imports never get the model review card'); assert.equal(view.effects, true);
  await f.page.waitForTimeout(400);
  assert.ok(await canvasPixels(f.page) > 200, 'the imported model renders');
  await shot(f.page, 'import-model-1440');
  // With an asset, Choose an asset lists it with Import from file… (opened from the viewer's asset chip).
  await f.page.click('.vw-asset');
  await f.page.waitForSelector('#asset-picker:not([hidden])');
  const rows = await f.page.locator('#asset-picker .import-row').allTextContents();
  assert.deepEqual(rows, ['crateModel · Imported · ' + (await f.page.evaluate(() => document.querySelector('.import-row-meta').textContent.split(' · ')[2]))]);
  assert.match(await f.page.locator('.import-picker-import').textContent(), /Import from file…/);
  await shot(f.page, 'import-picker-1440');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#asset-picker').isHidden(), true);
  // Refusals are explained, not hidden: an FBX gets the conversion steps.
  f.pick([join(f.files, 'statue.fbx')]);
  await f.page.click('.vw-asset'); await f.page.click('.import-picker-import');
  await f.page.waitForSelector('.import-notice:not([hidden])');
  assert.match(await f.page.locator('.import-notice').textContent(), /statue\.fbx.*FBX files need converting first.*glTF 2\.0/);
  await shot(f.page, 'import-refused-fbx-1440');
  // Remove: the record and its bytes go; the viewer clears.
  await f.page.click('.vw-import-remove');
  await f.page.waitForFunction(() => document.getElementById('asset-viewer')?.hidden === true);
  assert.deepEqual(await f.store.list(), []);
  assert.deepEqual(f.errors, []);
});

test('an imported Roblox effect plays in Effects mode with its emitters, budgets and timeline; drops import too', { skip: !emit && 'set ARCANE_IMPORT_EMIT' }, async t => {
  const f = await start(t);
  // Drag and drop: a dropped File goes to the host, which reads it by path itself.
  await f.page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['x'], 'campfire.rbxmx'));
    const target = document.getElementById('artifact-stage');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await f.page.waitForSelector('#asset-viewer .vw[data-phase="ready"][data-kind="effect"]', { timeout: 30000 });
  const view = await f.page.evaluate(() => ({
    effects: document.querySelector('.vw-kinds .vw-seg-item.is-on')?.textContent, model: document.querySelector('.vw-kinds .vw-seg-item')?.disabled,
    emitters: [...document.querySelectorAll('.vw-emitter')].map(n => n.textContent), heading: document.querySelector('[data-section="properties"] h3')?.textContent,
    props: [...document.querySelectorAll('.vw-emitter-prop')].map(n => n.textContent), meter: document.querySelector('.vw-import-meter')?.textContent,
    passed: [...document.querySelectorAll('.vw-passed li')].map(n => n.textContent), notes: [...document.querySelectorAll('.vw-import-notes li')].map(n => n.textContent),
    timeline: !!document.querySelector('.vw-timeline input[type=range]') }));
  assert.equal(view.effects, 'Effects'); assert.equal(view.model, true);
  assert.deepEqual(view.emitters, ['FlamesParticleEmitter40 /s', 'EmbersParticleEmitter8 /s', 'SmokeParticleEmitter6 /s', 'Fire glowPointLight14 studs']);
  assert.equal(view.heading, 'Flames');
  assert.ok(view.props.includes('Rate40 /s') && view.props.includes('Lifetime0.6 – 1.1 s'), JSON.stringify(view.props));
  assert.equal(view.meter, 'Particles in view100 / 600');
  assert.ok(view.passed.includes('Within the phone budget of 600 particles'), JSON.stringify(view.passed));
  assert.ok(view.notes.includes('Roblox particle textures show as stand-in sprites.'), JSON.stringify(view.notes));
  assert.equal(view.timeline, true);
  await f.page.waitForTimeout(1500);
  assert.ok(await canvasPixels(f.page) > 40, 'particles render');
  await shot(f.page, 'import-effect-1440');
  // Hide one emitter: the estimate follows.
  await f.page.click('.vw-emitter:nth-child(1) .vw-emitter-eye');
  assert.equal(await f.page.locator('.vw-import-meter').textContent(), 'Particles in view56 / 600');
  // Scrub: pauses and seeks deterministically.
  await f.page.locator('.vw-scrub').fill('2');
  assert.equal(await f.page.locator('.vw-time').first().textContent(), '2.0 s');
  await f.page.setViewportSize({ width: 420, height: 860 });
  await f.page.waitForTimeout(300);
  await shot(f.page, 'import-effect-420');
  assert.deepEqual(f.errors, []);
});
