import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// C30 viewer in the real studio.html + studio.css preview panel, mounted by the real AssetViewerPanel and drawn by the
// real runtime (Three on SwiftShader): resize behaviour (backing store, camera aspect, layout and HUD containment at
// docked, compact and full widths), real display-mode switching, the turntable under both motion preferences, and
// absent-data hiding. Private nonpersistent headless Edge; every request is routed in memory (no server, daemon,
// provider, Studio, user profile or credential). The review routes answer 503, so no decision can be made.
// Run: ARCANE_VIEWER_PRODUCT_EMIT=<private tsc outDir with apps/desktop/src/*.js> node --test tests/browser/asset-viewer-c30.test.mjs
// Optional: ARCANE_VIEWER_BROWSER=<Chromium executable>.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18771'; // Routed in memory; nothing listens here.
const JOB = '11111111-1111-4111-8111-111111111111', TOKEN = 'a'.repeat(64);
const files = [...(await readdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/public/fonts'))).filter(name => name.endsWith('.woff2')).map(name => '/fonts/' + name), '/studio.html', '/studio.css', '/asset-viewer-runtime.mjs', '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js', '/vendor/three/examples/jsm/controls/OrbitControls.js',
  '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three/examples/jsm/utils/SkeletonUtils.js'];
const modules = ['asset-viewer', 'asset-downloads', 'glb-preflight', 'asset-review'];

function glb({ uv = true } = {}) {
  const geometry = new BoxGeometry(2, 1, .7).toNonIndexed();
  const chunks = [], bufferViews = [], accessors = []; let offset = 0;
  const view = bytes => { const data = Buffer.from(bytes), pad = (4 - data.length % 4) % 4; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length }); chunks.push(data, Buffer.alloc(pad)); offset += data.length + pad; return bufferViews.length - 1; };
  const accessor = (array, type, bounds = {}) => { accessors.push({ bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType: 5126, count: array.length / (type === 'VEC2' ? 2 : 3), type, ...bounds }); return accessors.length - 1; };
  const attributes = { POSITION: accessor(geometry.attributes.position.array, 'VEC3', { min: [-1, -.5, -.35], max: [1, .5, .35] }), NORMAL: accessor(geometry.attributes.normal.array, 'VEC3') };
  if (uv) attributes.TEXCOORD_0 = accessor(geometry.attributes.uv.array, 'VEC2');
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.85, .25, .08, 1], metallicFactor: .2, roughnessFactor: .4 } }], accessors, bufferViews };
  json.buffers = [{ byteLength: offset }];
  const text = Buffer.from(JSON.stringify(json)), jsonLength = Math.ceil(text.length / 4) * 4, jsonBytes = Buffer.alloc(jsonLength, 0x20); text.copy(jsonBytes);
  const binary = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonLength + binary.length, 8);
  jsonHeader.writeUInt32LE(jsonLength); jsonHeader.writeUInt32LE(0x4e4f534a, 4); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  geometry.dispose();
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binary]);
}
const manifestFor = (bytes, validation) => ({ jobId: JOB, request: { name: 'c30-fixture', template: 'hero-prop', ...(validation ? { triangleBudget: 20000 } : {}) },
  artifacts: [{ path: 'asset.glb', role: 'export', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], ...(validation ? { validation } : {}) });

// Pixels that differ from the stage ground (#141012) by a clear margin.
function modelPixels(png) {
  let width, height, channels, offset = 8; const chunks = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(width * height * channels);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= channels ? pixels[i - channels] : 0, up = y ? pixels[i - stride] : 0, upperLeft = y && x >= channels ? pixels[i - stride - channels] : 0;
      pixels[i] = (raw[y * (stride + 1) + x + 1] + [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter]) & 255;
    }
  }
  let count = 0;
  for (let i = 0; i < width * height; i++) if (Math.abs(pixels[i * channels] - 0x14) + Math.abs(pixels[i * channels + 1] - 0x10) + Math.abs(pixels[i * channels + 2] - 0x12) > 60) count++;
  return { count, area: width * height };
}

const page = String.raw`
const meter = window.meter = { draws: 0 };
for (const name of ['drawArrays', 'drawElements']) {
  const original = WebGL2RenderingContext.prototype[name];
  WebGL2RenderingContext.prototype[name] = function (...args) { if (this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) meter.draws++; return original.apply(this, args); };
}
const THREE = await import('/vendor/three/build/three.module.js');
const updateCamera = THREE.Camera.prototype.updateMatrixWorld;
THREE.Camera.prototype.updateMatrixWorld = function (...args) { meter.camera = this; return updateCamera.apply(this, args); };
const { AssetViewerPanel } = await import('/asset-viewer.js');
window.mount = async manifest => {
  document.getElementById('workspace-stage').classList.remove('provider-required');
  document.getElementById('artifact-panel').hidden = false; document.getElementById('workspace-stage').classList.add('preview-open');
  window.panel = new AssetViewerPanel(document, '${TOKEN}');
  await panel.show(manifest, '${JOB}', () => true);
  return document.querySelector('#asset-viewer .vw')?.dataset.phase;
};
const rect = element => { const box = element.getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom].map(Math.round); };
window.probe = () => {
  const viewer = document.getElementById('asset-viewer'), vw = viewer.querySelector('.vw'), stage = vw.querySelector('.vw-stage'), inspector = vw.querySelector('.vw-inspector');
  const host = stage.querySelector('.viewer-canvas'), canvas = host.querySelector('canvas'), w = host.clientWidth, h = host.clientHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(4e6 / (w * h))), camera = meter.camera, s = stage.getBoundingClientRect();
  const hudOutside = [...stage.querySelectorAll('.vw-hud .vw-glass, .vw-hud .vw-camera')].filter(node => node.getClientRects().length > 0).filter(node => {
    const b = node.getBoundingClientRect(); return b.left < s.left - 1 || b.right > s.right + 1 || b.top < s.top - 1 || b.bottom > s.bottom + 1;
  }).map(node => node.className);
  return { container: viewer.clientWidth, host: [w, h], css: [canvas.clientWidth, canvas.clientHeight], buffer: [canvas.width, canvas.height],
    expected: [Math.max(1, Math.floor(w * dpr)), Math.max(1, Math.floor(h * dpr))], hostAspect: w / h,
    cameraAspect: camera.isPerspectiveCamera ? camera.aspect : (camera.right - camera.left) / (camera.top - camera.bottom), camera: camera.position.toArray(),
    stage: rect(stage), inspector: rect(inspector), direction: getComputedStyle(vw).flexDirection, vwOverflow: vw.scrollWidth - vw.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - innerWidth, hudOutside, draws: meter.draws, lost: canvas.getContext('webgl2').isContextLost(),
    tabs: getComputedStyle(vw.querySelector('.vw-tabs')).display !== 'none', visible: (() => { const b = canvas.getBoundingClientRect();
      const x0 = Math.max(0, Math.ceil(b.left)), y0 = Math.max(0, Math.ceil(b.top)), x1 = Math.min(innerWidth, Math.floor(b.right)), y1 = Math.min(innerHeight, Math.floor(b.bottom));
      return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }; })() };
};
window.ready = true;
`;

test('C30 viewer: real panel, real runtime, real studio.css', { skip: !process.env.ARCANE_VIEWER_PRODUCT_EMIT, timeout: 240_000 }, async t => {
  const emit = resolve(process.env.ARCANE_VIEWER_PRODUCT_EMIT);
  const sources = new Map(await Promise.all(files.map(async path => [path, await readFile(resolve(root, 'apps/desktop/public', '.' + path))])));
  for (const name of modules) sources.set('/' + name + '.js', await readFile(resolve(emit, 'apps/desktop/src', name + '.js')));
  sources.set('/studio.html', Buffer.from(sources.get('/studio.html').toString().replace(/<script type="module" src="\/studio\.js"><\/script>/, '<script type="module" src="/c30-fixture.mjs"></script>')));
  sources.set('/c30-fixture.mjs', Buffer.from(page));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_VIEWER_BROWSER ? { executablePath: process.env.ARCANE_VIEWER_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'] });
  t.after(() => browser.close());

  async function open(t, { bytes = glb(), validation = null, width = 1440, height = 900, reducedMotion = 'no-preference' } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5, reducedMotion, colorScheme: 'dark' });
    t.after(() => context.close());
    const tab = await context.newPage(), errors = [], forbidden = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname === '/' ? '/studio.html' : url.pathname;
      if (url.origin !== origin) { forbidden.push(path); await route.abort(); return; }
      if (path === '/v1/assets/artifact') {
        assert.equal(route.request().headers().authorization, 'Bearer ' + TOKEN); assert.equal(url.searchParams.get('path'), 'asset.glb');
        await route.fulfill({ body: bytes, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'Content-Disposition': 'attachment; filename="c30-fixture-asset.glb"' } }); return;
      }
      if (path.startsWith('/v1/assets/review/')) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"FIXTURE"}' }); return; }
      if (!sources.has(path)) { forbidden.push(path); await route.abort(); return; }
      await route.fulfill({ contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: sources.get(path) });
    });
    await tab.goto(origin + '/');
    await tab.waitForFunction(() => window.ready === true);
    assert.equal(await tab.evaluate(manifest => mount(manifest), manifestFor(bytes, validation)), 'ready');
    await tab.waitForFunction(() => document.querySelector('#asset-viewer canvas')?.width > 0);
    await settle(tab);
    return { tab, errors, forbidden };
  }
  const settle = async tab => { await tab.waitForTimeout(150); await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); };
  const stagePixels = async tab => { const p = await tab.evaluate(() => probe()); return modelPixels(await tab.screenshot({ clip: p.visible })); };

  await t.test('the stage keeps a matching backing store, camera and layout at every size', async t => {
    const { tab, errors, forbidden } = await open(t);
    const sizes = [[1440, 900], [1100, 800], [900, 760], [760, 700], [520, 800], [420, 1000], [360, 740], [1280, 600], [2200, 1100], [1440, 900]];
    let previousHost = null;
    for (const [width, height] of sizes) {
      const before = await tab.evaluate(() => meter.draws);
      await tab.setViewportSize({ width, height });
      await tab.evaluate(() => document.querySelector('#asset-viewer .vw-stage').scrollIntoView({ block: 'nearest' })); await settle(tab);
      const p = await tab.evaluate(() => probe()), at = width + 'x' + height + ' ' + JSON.stringify(p);
      assert.deepEqual(p.buffer, p.expected, 'backing store follows the stage at the capped DPR ' + at);
      assert.ok(Math.abs(p.css[0] - p.host[0]) <= 1 && Math.abs(p.css[1] - p.host[1]) <= 1, 'canvas fills its host without stretching ' + at);
      assert.ok(Math.abs(p.cameraAspect - p.hostAspect) < .01, 'camera aspect follows the stage ' + at);
      assert.ok(p.host[1] >= 238, 'the stage keeps a usable height ' + at);
      assert.ok(p.vwOverflow <= 1 && p.pageOverflow <= 1, 'no horizontal overflow ' + at);
      assert.deepEqual(p.hudOutside, [], 'every floating control stays inside the stage ' + at);
      if (p.container >= 880) { assert.equal(p.direction, 'row', at); assert.equal(p.tabs, false, at); }
      else { assert.equal(p.direction, 'column', at); assert.ok(p.inspector[1] >= p.stage[3], 'inspector sits under the stage ' + at); }
      assert.equal(p.lost, false);
      if (previousHost && (previousHost[0] !== p.host[0] || previousHost[1] !== p.host[1])) assert.ok(p.draws > before, 'a stage resize redraws it ' + at);
      previousHost = p.host;
      if (p.visible.height >= 120) { const pixels = await stagePixels(tab); assert.ok(pixels.count > pixels.area * .03, 'model visible after the resize ' + JSON.stringify(pixels) + ' ' + at); }
    }
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  });

  await t.test('dragging the window edge never leaves a blank or stretched stage', async t => {
    const { tab, errors } = await open(t, { width: 1400, height: 880 });
    await tab.evaluate(() => document.querySelector('#asset-viewer canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    for (let i = 1; i <= 24; i++) { await tab.setViewportSize({ width: 1400 - i * 40, height: 880 - i * 6 }); await tab.waitForTimeout(16); }
    await settle(tab);
    const p = await tab.evaluate(() => probe()), at = JSON.stringify(p);
    assert.deepEqual(p.buffer, p.expected, at); assert.ok(Math.abs(p.cameraAspect - p.hostAspect) < .01, at);
    const pixels = await stagePixels(tab); assert.ok(pixels.count > pixels.area * .03, 'model visible after the drag ' + JSON.stringify(pixels));
    assert.deepEqual(errors, []);
  });

  await t.test('display modes switch real materials; the UV checker needs a UV map', async t => {
    const { tab, errors } = await open(t, { width: 1100, height: 800 });
    const modes = await tab.locator('#asset-viewer .vw-modes button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.deepEqual(modes, ['Shaded', 'Textured', 'Wireframe', 'UV checker', 'Normals']);
    let previous = await tab.screenshot({ clip: (await tab.evaluate(() => probe())).visible });
    for (const mode of ['Shaded', 'Wireframe', 'UV checker', 'Normals', 'Textured']) {
      await tab.getByRole('button', { name: mode, exact: true }).click(); await settle(tab);
      assert.equal(await tab.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true', mode);
      assert.equal(await tab.locator('#asset-viewer .vw-modes [aria-pressed=true]').count(), 1, mode);
      const image = await tab.screenshot({ clip: (await tab.evaluate(() => probe())).visible });
      assert.notDeepEqual(image, previous, mode + ' changes the rendered materials'); previous = image;
    }
    const plain = await open(t, { bytes: glb({ uv: false }), width: 1100, height: 800 });
    assert.deepEqual(await plain.tab.locator('#asset-viewer .vw-modes button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Shaded', 'Textured', 'Wireframe', 'Normals']);
    assert.deepEqual(errors, []); assert.deepEqual(plain.errors, []);
  });

  await t.test('the turntable turns the camera, and stays still under reduced motion', async t => {
    for (const [reducedMotion, moves] of [['no-preference', true], ['reduce', false]]) {
      const { tab, errors } = await open(t, { width: 1100, height: 800, reducedMotion });
      const before = (await tab.evaluate(() => probe())).camera;
      await tab.getByRole('button', { name: 'Turntable', exact: true }).click();
      assert.equal(await tab.getByRole('button', { name: 'Turntable', exact: true }).getAttribute('aria-pressed'), 'true');
      await tab.waitForTimeout(500); await settle(tab);
      const after = (await tab.evaluate(() => probe())).camera, moved = after.some((value, i) => Math.abs(value - before[i]) > 1e-4);
      assert.equal(moved, moves, reducedMotion + ' ' + JSON.stringify({ before, after }));
      assert.deepEqual(errors, []);
    }
  });

  await t.test('absent data is not shown; audited data is', async t => {
    const bare = await open(t, { width: 1100, height: 800 });
    const text = await bare.tab.locator('#asset-viewer .vw-inspector').innerText();
    assert.doesNotMatch(text, /Textures|UV quality|studs|undefined|NaN|\/ \d/);
    assert.equal(await bare.tab.locator('#asset-viewer .vw-meter').count(), 0);
    assert.equal(await bare.tab.locator('#asset-viewer .vw-tabs').isVisible(), false, 'one section needs no tabs');
    assert.deepEqual(await bare.tab.locator('#asset-viewer .vw-tile dt').allInnerTexts(), ['Materials']);
    const audited = await open(t, { width: 1100, height: 800, validation: { totals: { renderTriangles: 12, materials: 1 }, warnings: ['Roblox import, scale mapping and collision behavior are unverified.'], errors: [], meshes: [] } });
    assert.match(await audited.tab.locator('#asset-viewer .vw-stat').first().innerText(), /12\s*\/ 20,000/);
    assert.equal(await audited.tab.locator('#asset-viewer .vw-meter').count(), 1);
    await audited.tab.getByRole('tab', { name: 'Checks', exact: true }).click();
    assert.match(await audited.tab.locator('#asset-viewer .vw-note').innerText(), /scale mapping/);
    assert.deepEqual(bare.errors, []); assert.deepEqual(audited.errors, []);
  });
});
