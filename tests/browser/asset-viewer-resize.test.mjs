import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// Window resize regression for the 3D preview inside the real studio.html/studio.css
// preview panel. Private nonpersistent headless Edge, files routed in memory; no app
// server, shared build, provider, daemon or user profile.
// Run: node --test tests/browser/asset-viewer-resize.test.mjs
// Optional: ARCANE_VIEWER_BROWSER=<Chromium executable>.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18761'; // Routed in memory; nothing listens here.
const files = ['/studio.html', '/studio.css', '/asset-viewer-runtime.mjs', '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js', '/vendor/three/examples/jsm/controls/OrbitControls.js',
  '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three/examples/jsm/utils/SkeletonUtils.js'];

function glb() {
  const geometry = new BoxGeometry(2, 1, .7).toNonIndexed();
  const chunks = [], bufferViews = [], accessors = []; let offset = 0;
  const view = bytes => { const data = Buffer.from(bytes), pad = (4 - data.length % 4) % 4; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length }); chunks.push(data, Buffer.alloc(pad)); offset += data.length + pad; return bufferViews.length - 1; };
  const accessor = (array, bounds) => { accessors.push({ bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType: 5126, count: array.length / 3, type: 'VEC3', ...bounds }); return accessors.length - 1; };
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: accessor(geometry.attributes.position.array, { min: [-1, -.5, -.35], max: [1, .5, .35] }), NORMAL: accessor(geometry.attributes.normal.array) }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.85, .25, .08, 1], metallicFactor: .2, roughnessFactor: .4 } }], accessors, bufferViews };
  json.buffers = [{ byteLength: offset }];
  const text = Buffer.from(JSON.stringify(json)), jsonLength = Math.ceil(text.length / 4) * 4, jsonBytes = Buffer.alloc(jsonLength, 0x20); text.copy(jsonBytes);
  const binary = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonLength + binary.length, 8);
  jsonHeader.writeUInt32LE(jsonLength); jsonHeader.writeUInt32LE(0x4e4f534a, 4); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  geometry.dispose();
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binary]).toString('base64');
}

// Pixels that differ from the viewer background (#181b20) in a screenshot PNG.
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
  for (let i = 0; i < width * height; i++) if (Math.abs(pixels[i * channels] - 0x18) + Math.abs(pixels[i * channels + 1] - 0x1b) + Math.abs(pixels[i * channels + 2] - 0x20) > 60) count++;
  return count;
}

// Mounts the runtime into #asset-viewer exactly as AssetViewerPanel.show()/controls()
// and AssetReviewCard.show() do, plus the two verified 2D preview figures studio.ts adds.
const page = String.raw`
const meter = window.meter = { contexts: 0, draws: 0, clears: 0, blank: 0, pending: false, frame: 0, trace: [] };
const everPresented = new WeakSet();
let pendingCanvas = null, lastPresentation = null, lastDrawFrame = -1;
function canvasPresentation(canvas) {
  let opacity = 1, allowed = document.visibilityState === 'visible' && !!canvas?.isConnected;
  if (canvas) for (let node = canvas; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    opacity *= Number(style.opacity);
    if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') allowed = false;
  }
  const clip = canvas ? visible(canvas) : { x: 0, y: 0, width: 0, height: 0 };
  return { canPresent: allowed && opacity > 0 && clip.width > 0 && clip.height > 0,
    rect: [clip.x, clip.y, clip.width, clip.height], opacity,
    viewport: [innerWidth, innerHeight], buffer: canvas ? [canvas.width, canvas.height] : [0, 0] };
}
function trace(kind, canvas) {
  // Fixed fixture geometry only; never labels, model data or human content.
  meter.trace.push({ kind, frame: meter.frame, ...canvasPresentation(canvas) });
  if (meter.trace.length > 64) meter.trace.shift();
}
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (kind, ...args) { const context = getContext.call(this, kind, ...args); if (kind === 'webgl2' && context && !this.counted) { this.counted = true; meter.contexts++; } return context; };
for (const property of ['width', 'height']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
  Object.defineProperty(HTMLCanvasElement.prototype, property, { configurable: true, get: descriptor.get,
    set(value) {
      // Assigning even the same width/height resets a canvas backing store.
      const cleared = this.counted;
      descriptor.set.call(this, value);
      if (cleared) {
        meter.clears++;
        // Initial allocation has no prior image to lose; trace every clear.
        if (everPresented.has(this)) { meter.pending = true; pendingCanvas = this; }
        trace('clear', this);
      }
    } });
}
for (const name of ['drawArrays', 'drawElements']) {
  const original = WebGL2RenderingContext.prototype[name];
  WebGL2RenderingContext.prototype[name] = function (...args) {
    // Environment/texture render-target draws do not restore the canvas image.
    const canvasDraw = this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null;
    const result = original.apply(this, args);
    const count = name === 'drawArrays' ? args[2] : args[1];
    if (canvasDraw && count > 0) {
      meter.draws++; everPresented.add(this.canvas);
      if (pendingCanvas === this.canvas) { meter.pending = false; pendingCanvas = null; }
      if (lastDrawFrame !== meter.frame) { lastDrawFrame = meter.frame; trace('draw', this.canvas); }
    }
    return result;
  };
}
// First callback of a frame inspects the previous paint's uncleared backing
// resize. Hidden/clipped canvases cannot present a blank; keep their pending
// clear until an actual draw, rather than erasing the evidence while hidden.
const tick = () => {
  meter.frame++;
  const canvas = pendingCanvas ?? document.querySelector('#asset-viewer .viewer-canvas canvas');
  const state = canvasPresentation(canvas), key = state.canPresent;
  if (key !== lastPresentation) { lastPresentation = key; trace('visibility', canvas); }
  if (meter.pending && state.canPresent) { meter.blank++; trace('visible-blank', canvas); }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
const THREE = await import('/vendor/three/build/three.module.js');
const updateCamera = THREE.Camera.prototype.updateMatrixWorld;
THREE.Camera.prototype.updateMatrixWorld = function (...args) { meter.camera = this; return updateCamera.apply(this, args); };
const make = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const open = () => { document.getElementById('artifact-panel').hidden = false; document.getElementById('workspace-stage').classList.add('preview-open'); };
window.mount = async (base64, openAfter) => {
  document.getElementById('workspace-stage').classList.remove('provider-required');
  if (!openAfter) open();
  const viewerRoot = document.getElementById('asset-viewer');
  const status = make('p', 'Loading 3D preview…', 'viewer-status'), host = make('div', undefined, 'viewer-canvas');
  viewerRoot.append(host, status); viewerRoot.hidden = false;
  const module = await import('/asset-viewer-runtime.mjs');
  window.controller = new AbortController();
  window.viewer = await module.createAssetViewer({ host, bytes: Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer, label: 'Resize fixture', signal: controller.signal, onStatus: () => {} });
  const bar = make('div', undefined, 'viewer-toolbar');
  for (const label of ['View', 'Display', 'Lighting']) { const select = make('select'); select.append(make('option', label)); bar.append(select); }
  bar.append(make('button', 'Reset view')); viewerRoot.insertBefore(bar, host);
  viewerRoot.append(make('p', '2.00 × 1.00 × 0.70 m · 12 triangles', 'viewer-metrics'));
  const review = make('section', undefined, 'viewer-review'), actions = make('div', undefined, 'viewer-animation');
  for (const label of ['Approve model', 'Reject model', 'Refresh review']) actions.append(make('button', label));
  review.append(make('h3', 'Model review', 'viewer-status'), make('strong', 'Pending', 'viewer-status'), make('p', 'Review this model before approving it.', 'viewer-status'), actions);
  viewerRoot.append(review);
  for (const name of ['preview-hero.png', 'preview-side.png']) {
    const figure = make('figure'), canvas = make('canvas'); canvas.width = 1024; canvas.height = 768; canvas.getContext('2d').fillRect(0, 0, 1024, 768);
    figure.append(canvas, make('figcaption', name)); document.getElementById('asset-previews').append(figure);
  }
  if (openAfter) open(); // workspace-shell setOpen(true) after workspace:assetactivity
};
function visible(element) {
  const box = element.getBoundingClientRect(); let x0 = box.left, y0 = box.top, x1 = box.right, y1 = box.bottom;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    if (style.overflowX !== 'visible') { x0 = Math.max(x0, r.left + node.clientLeft); x1 = Math.min(x1, r.left + node.clientLeft + node.clientWidth); }
    if (style.overflowY !== 'visible') { y0 = Math.max(y0, r.top + node.clientTop); y1 = Math.min(y1, r.top + node.clientTop + node.clientHeight); }
  }
  x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, innerWidth); y1 = Math.min(y1, innerHeight);
  return { x: Math.ceil(x0), y: Math.ceil(y0), width: Math.max(0, Math.floor(x1 - x0)), height: Math.max(0, Math.floor(y1 - y0)) };
}
window.present = () => canvasPresentation(document.querySelector('#asset-viewer .viewer-canvas canvas'));
window.probe = () => {
  const card = document.getElementById('asset-viewer'), host = card.querySelector('.viewer-canvas'), canvas = host.querySelector('canvas'), stage = document.getElementById('artifact-stage');
  const w = host.clientWidth, h = host.clientHeight, gl = canvas.getContext('webgl2');
  const dpr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(4e6 / (w * h)));
  const camera = meter.camera;
  return { host: [w, h], buffer: [canvas.width, canvas.height], expectedBuffer: [Math.max(1, Math.floor(w * dpr)), Math.max(1, Math.floor(h * dpr))],
    hostAspect: w / h, cameraAspect: camera.isPerspectiveCamera ? camera.aspect : (camera.right - camera.left) / (camera.top - camera.bottom),
    cardClipped: card.scrollHeight - card.clientHeight, stageHeight: stage.clientHeight, visible: visible(canvas),
    camera: camera.position.toArray(), cameraZoom: camera.zoom, cameraType: camera.type,
    frames: viewer.stats().renderFrames, lost: gl.isContextLost(), contexts: meter.contexts, blank: meter.blank, clears: meter.clears, pending: meter.pending, trace: meter.trace.slice() };
};
window.ready = true;
`;

test('3D preview survives window resizes across the studio breakpoints', { timeout: 180_000 }, async t => {
  const sources = new Map(await Promise.all(files.map(async path => [path, await readFile(resolve(root, 'apps/desktop/public', '.' + path))])));
  sources.set('/studio.html', Buffer.from(sources.get('/studio.html').toString().replace(/<script type="module" src="\/studio\.js"><\/script>/, '<script type="module" src="/resize-fixture.mjs"></script>')));
  sources.set('/resize-fixture.mjs', Buffer.from(page));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_VIEWER_BROWSER ? { executablePath: process.env.ARCANE_VIEWER_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'] });
  t.after(() => browser.close());
  const data = glb();
  async function open(t, openAfter, reveal = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, reducedMotion: 'no-preference' });
    t.after(() => context.close());
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname === '/' ? '/studio.html' : url.pathname;
      if (url.origin !== origin || !sources.has(path)) { await route.abort(); return; }
      await route.fulfill({ contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', body: sources.get(path) });
    });
    await tab.goto(origin + '/');
    await tab.waitForFunction(() => window.ready === true);
    if (reveal) await tab.addStyleTag({ content: '#artifact-panel:not([hidden]){animation:resize-fixture-reveal 80ms linear both}@keyframes resize-fixture-reveal{from{opacity:0}to{opacity:1}}' });
    await tab.evaluate(([base64, after]) => mount(base64, after), [data, openAfter]);
    // Let the panel entrance (if any) finish, then require a drawn frame without any nudge.
    await tab.waitForFunction(() => !document.getElementById('artifact-panel').getAnimations()
      .some(animation => animation.pending || animation.playState === 'running'), null, { timeout: 5000 });
    await tab.waitForTimeout(250);
    assert.ok(await tab.evaluate(() => viewer.stats().renderFrames) > 0, 'preview draws after the panel opens, without a resize');
    return { tab, errors };
  }
  const settle = async tab => { await tab.waitForTimeout(120); await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); };
  const scrollHost = async tab => tab.evaluate(() => document.querySelector('#asset-viewer .viewer-canvas').scrollIntoView({ block: 'nearest', inline: 'nearest' }));

  await t.test('panel opened after the viewer is created draws its first frame', async t => { const {errors}=await open(t, true); assert.deepEqual(errors, []); });

  await t.test('an ancestor opacity entrance settles without leaving the viewer blank', async t => { const {errors}=await open(t, true, true); assert.deepEqual(errors, []); });

  await t.test('orthographic pan and zoom survive resizing with the correct projection', async t => {
    const {tab,errors}=await open(t, false);
    await tab.evaluate(() => { viewer.setView('front'); viewer.pan(50, 30); viewer.zoom(1.4); }); await scrollHost(tab); await settle(tab);
    const before=await tab.evaluate(() => probe());
    assert.equal(before.cameraType, 'OrthographicCamera');
    await tab.setViewportSize({width: 1280, height: 720}); await scrollHost(tab); await settle(tab);
    const after=await tab.evaluate(() => probe());
    assert.equal(after.cameraType, 'OrthographicCamera'); assert.equal(after.cameraZoom, before.cameraZoom);
    after.camera.forEach((value,i) => assert.ok(Math.abs(value-before.camera[i])<1e-6, 'orthographic camera position kept'));
    assert.ok(Math.abs(after.cameraAspect-after.hostAspect)<.01, 'orthographic projection matches resized container');
    assert.deepEqual(errors, []);
  });

  await t.test('hidden resizes retain the backing image and re-entry applies the measured size before presenting', async t => {
    const { tab, errors } = await open(t, false);
    await tab.evaluate(() => { viewer.orbit(.4, .2); viewer.zoom(1.2); }); await settle(tab);
    const blank = await tab.evaluate(() => meter.blank);
    // Move outside all clipping ancestors without changing the layout size.
    // Re-entry then depends on IntersectionObserver, rather than a size event.
    await tab.evaluate(() => { document.querySelector('#asset-viewer .viewer-canvas').style.transform = 'translateX(-5000px)'; });
    await settle(tab);
    const snapshot = () => tab.evaluate(() => {
      const host = document.querySelector('#asset-viewer .viewer-canvas'), canvas = host.querySelector('canvas');
      return { host: [host.clientWidth, host.clientHeight], buffer: [canvas.width, canvas.height],
        clears: meter.clears, pending: meter.pending, blank: meter.blank, frames: viewer.stats().renderFrames, camera: meter.camera.position.toArray(),
        cameraAspect: meter.camera.aspect, presentation: present(), trace: meter.trace.slice() };
    });
    const before = await snapshot(); assert.equal(before.presentation.canPresent, false, 'fixture is actually clipped before resizing');
    await tab.setViewportSize({ width: 1280, height: 720 }); await settle(tab);
    const hidden = await snapshot(), evidence = JSON.stringify(hidden);
    assert.equal(hidden.presentation.canPresent, false, 'canvas remains clipped ' + evidence);
    assert.notDeepEqual(hidden.host, before.host, 'hidden host really resized');
    assert.deepEqual(hidden.buffer, before.buffer, 'hidden resize never clears the last backing image ' + evidence);
    assert.equal(hidden.clears, before.clears, 'no hidden backing-store resize ' + evidence);
    assert.equal(hidden.frames, before.frames, 'hidden viewer stays suspended');
    assert.ok(Math.abs(hidden.cameraAspect - hidden.host[0] / hidden.host[1]) < .01, 'projection still tracks hidden dimensions');
    await tab.evaluate(() => { document.querySelector('#asset-viewer .viewer-canvas').style.removeProperty('transform'); });
    await scrollHost(tab); await settle(tab);
    const resumed = await tab.evaluate(() => probe()), resumedEvidence = JSON.stringify(resumed);
    assert.equal(await tab.evaluate(() => present().canPresent), true, 'canvas is actually visible after re-entry');
    assert.deepEqual(resumed.buffer, resumed.expectedBuffer, 're-entry applies the deferred backing size ' + resumedEvidence);
    assert.ok(resumed.frames > hidden.frames, 're-entry draws without an additional resize');
    assert.equal(resumed.pending, false, 'real re-entry leaves no lost image pending');
    resumed.camera.forEach((value, i) => assert.ok(Math.abs(value - before.camera[i]) < 1e-6, 'edited camera survives hidden resize'));
    assert.equal(resumed.blank - blank, 0, 'no visible blank frame across hidden resize/re-entry ' + resumedEvidence);
    assert.ok(resumed.trace.length <= 64, 'trace stays bounded');
    // Only after the real resize/re-entry assertions: isolate the instrumentation
    // control while hidden. Do not present this deliberately invalidated image.
    await tab.evaluate(() => { document.querySelector('#asset-viewer .viewer-canvas').style.transform = 'translateX(-5000px)'; });
    await settle(tab);
    const controlBefore = await snapshot();
    assert.equal(controlBefore.presentation.canPresent, false, 'artificial control starts actually clipped');
    await tab.evaluate(() => { const canvas = document.querySelector('#asset-viewer .viewer-canvas canvas'); canvas.width += 1; });
    await settle(tab);
    const pending = await snapshot();
    assert.equal(pending.pending, true, 'previously drawn hidden clear remains pending without an actual draw');
    assert.equal(pending.blank, controlBefore.blank, 'the artificial clipped clear is not a visible blank');
    assert.equal(pending.frames, controlBefore.frames, 'artificial control finishes hidden without drawing');
    assert.deepEqual(errors, []);
  });

  await t.test('canvas matches its container, stays reachable and renders at every breakpoint', async t => {
    const { tab, errors } = await open(t, false);
    const sizes = [[1440, 900], [1100, 800], [1099, 800], [900, 760], [899, 760], [761, 700], [760, 700], [521, 800], [520, 800], [360, 740], [1280, 600], [1280, 440], [1440, 900]];
    for (const [width, height] of sizes) {
      await tab.setViewportSize({ width, height }); await scrollHost(tab); await settle(tab);
      const p = await tab.evaluate(() => probe()), at = `${width}x${height} ${JSON.stringify(p)}`;
      assert.deepEqual(p.buffer, p.expectedBuffer, 'backing store follows the container and capped DPR ' + at);
      assert.ok(Math.abs(p.cameraAspect - p.hostAspect) < .01, 'camera aspect ' + at);
      assert.ok(p.cardClipped <= 1, 'the viewer card never clips its canvas, status or review ' + at);
      assert.ok(p.visible.width >= p.host[0] - 2 && p.visible.height >= Math.min(p.host[1], p.stageHeight) - 2, 'canvas reachable in the preview stage ' + at);
      assert.equal(p.lost, false); assert.equal(p.contexts, 1, 'one renderer, one context');
      if (p.visible.height >= p.host[1] - 2) {
        const pixels = modelPixels(await tab.screenshot({ clip: p.visible }));
        assert.ok(pixels > p.visible.width * p.visible.height * .05, `model visible ${pixels} ${at}`);
      }
    }
    assert.deepEqual(errors, []);
  });

  await t.test('resizing keeps a user camera and never presents a blank frame', async t => {
    const { tab, errors } = await open(t, false);
    await tab.evaluate(() => { viewer.orbit(1.1, .35); viewer.zoom(1.6); }); await scrollHost(tab); await settle(tab);
    const before = await tab.evaluate(() => probe());
    await tab.setViewportSize({ width: 1400, height: 880 }); await scrollHost(tab); await settle(tab);
    const after = await tab.evaluate(() => probe());
    after.camera.forEach((value, i) => assert.ok(Math.abs(value - before.camera[i]) < 1e-6, 'orbit/zoom kept across resize'));
    assert.ok(Math.abs(after.cameraAspect - after.hostAspect) < .01);
    await tab.evaluate(() => viewer.reset()); await scrollHost(tab); await settle(tab);
    const blank = await tab.evaluate(() => meter.blank), frames = await tab.evaluate(() => viewer.stats().renderFrames);
    for (let i = 1; i <= 24; i++) { await tab.setViewportSize({ width: 1400 - i * 20, height: 880 - i * 8 }); await tab.waitForTimeout(16); }
    await scrollHost(tab); await settle(tab);
    const blankEvidence = await tab.evaluate(() => ({ blank: meter.blank, trace: meter.trace.slice() }));
    assert.equal(blankEvidence.blank - blank, 0, 'no cleared canvas is visibly presented while the window is dragged ' + JSON.stringify(blankEvidence.trace));
    assert.ok(await tab.evaluate(() => viewer.stats().renderFrames) > frames);
    const end = await tab.evaluate(() => probe());
    assert.deepEqual(end.buffer, end.expectedBuffer); assert.equal(end.lost, false); assert.equal(end.contexts, 1);
    await tab.evaluate(() => controller.abort());
    assert.equal(await tab.evaluate(() => document.querySelectorAll('#asset-viewer canvas').length), 0, 'abort disposes the canvas');
    assert.deepEqual(errors, []);
  });
});
