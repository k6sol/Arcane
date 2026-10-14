import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// Private nonpersistent headless Edge. No app server, shared compilation,
// provider, native bridge, Blender, Studio, inference, or user browser profile.
// Run: node --test tests/browser/asset-viewer-renderer.test.mjs
// Optional: ARCANE_VIEWER_BROWSER=<Chromium executable>,
// ARCANE_VIEWER_PROOF_DIR=<private directory for screenshots/report>.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18749'; // Routed in memory; nothing listens here.
const vendorPaths = [
  '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js',
  '/vendor/three/examples/jsm/controls/OrbitControls.js',
  '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  '/vendor/three/examples/jsm/utils/SkeletonUtils.js',
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); name.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), chunk.length - 4);
  return chunk;
}
function embeddedPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 230, 80, 35, 255, 25, 140, 200, 255, 0, 30, 190, 90, 255, 240, 200, 45, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

function glb(options = {}) {
  const geometry = new BoxGeometry(2, 1, .7).toNonIndexed();
  const chunks = [], bufferViews = [], accessors = [];
  let offset = 0;
  function view(bytes) {
    const data = Buffer.from(bytes), padding = (4 - data.length % 4) % 4;
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    chunks.push(data, Buffer.alloc(padding)); offset += data.length + padding;
    return index;
  }
  function accessor(array, type, componentType = 5126, bounds) {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const index = accessors.length;
    accessors.push({ bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType, count: array.length / size, type, ...bounds });
    return index;
  }
  const positions = geometry.attributes.position.array.slice();
  if (options.nanVertex) positions[0] = NaN;
  const position = accessor(positions, 'VEC3', 5126, { min: [-1, -.5, -.35], max: [1, .5, .35] });
  const normal = accessor(geometry.attributes.normal.array, 'VEC3');
  const uv = accessor(geometry.attributes.uv.array, 'VEC2');
  const primitive = { attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, material: 0 };
  const nodes = [{ name: 'FixtureAsset', mesh: 0, scale: options.scale ?? [options.units ?? 1, options.units ?? 1, options.units ?? 1], translation: options.translation ?? [0, 0, 0], ...(options.rotation ? { rotation: options.rotation } : {}) }];
  const sceneNodes = [0];
  const json = {
    asset: { version: '2.0', generator: 'Arcane owned renderer fixture' },
    scene: 0, scenes: [{ nodes: sceneNodes }], nodes,
    meshes: [{ primitives: [primitive] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.8, .3, .08, 1], metallicFactor: options.metal ? 1 : .3, roughnessFactor: .32 } }],
    accessors, bufferViews,
  };
  if (options.texture || options.externalImage) {
    json.images = options.externalImage ? [{ uri: options.externalImage }] : [{ bufferView: view(embeddedPng()), mimeType: 'image/png' }];
    json.textures = [{ source: 0 }];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  if (options.materials) json.materials = Array.from({ length: options.materials }, () => structuredClone(json.materials[0]));
  if (options.doubleSided) json.materials[0].doubleSided = true;
  if (options.transparent) json.materials[0].alphaMode = 'BLEND';
  if (options.transmission) {
    json.extensionsUsed = ['KHR_materials_transmission'];
    json.materials[0].extensions = { KHR_materials_transmission: { transmissionFactor: 1 } };
  }
  if (options.draws) {
    while (nodes.length < options.draws) { sceneNodes.push(nodes.length); nodes.push({ mesh: 0 }); }
  }
  if (options.invalidPrimitive) json.meshes[0].primitives.push({ ...structuredClone(primitive), attributes: { POSITION: 9999 } });
  if (options.tooManyTriangles) {
    const indices = new Uint16Array(6_000_003);
    for (let i = 0; i < indices.length; i++) indices[i] = i % positions.length / 3 | 0;
    primitive.indices = accessor(indices, 'SCALAR', 5123);
  }
  if (options.morph) {
    const delta = new Float32Array(positions.length);
    for (let i = 1; i < delta.length; i += 3) if (positions[i] > 0) delta[i] = .6;
    primitive.targets = [{ POSITION: accessor(delta, 'VEC3', 5126, { min: [0, 0, 0], max: [0, .6, 0] }) }];
    json.meshes[0].weights = [0];
  }
  if (options.skin) {
    const joints = new Uint16Array(positions.length / 3 * 4), weights = new Float32Array(joints.length);
    for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
    primitive.attributes.JOINTS_0 = accessor(joints, 'VEC4', 5123);
    primitive.attributes.WEIGHTS_0 = accessor(weights, 'VEC4');
    nodes[0].skin = 0;
    nodes.push({ name: 'FixtureJoint' }); sceneNodes.push(1);
    json.skins = [{ joints: [1] }];
  }
  if (options.animation || options.morph || options.skin) {
    const times = accessor(new Float32Array([0, 1, 2]), 'SCALAR', 5126, { min: [0], max: [2] });
    let values = new Float32Array([0, 0, 0, 1, 0, .8660254, 0, .5, 0, 0, 0, 1]), type = 'VEC4', node = 0, path = 'rotation';
    if (options.morph) { values = new Float32Array([0, 1, 0]); type = 'SCALAR'; path = 'weights'; }
    if (options.skin) { values = new Float32Array([0, 0, 0, 0, .8, 0, 0, 0, 0]); type = 'VEC3'; node = 1; path = 'translation'; }
    if (options.invalidAnimation) values[0] = NaN;
    json.animations = [{ name: 'Fixture motion', samplers: [{ input: times, output: accessor(values, type), interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node, path } }] }];
    if (options.multipleAnimations) {
      const input = accessor(new Float32Array([0, 1, 3]), 'SCALAR', 5126, { min: [0], max: [3] });
      const output = accessor(new Float32Array([0, 0, 0, .3, .4, 0, 0, 0, 0]), 'VEC3');
      json.animations.push({ name: 'Alternate translation', samplers: [{ input, output, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] });
    }
    if (options.zeroDuration) {
      json.animations[0].samplers[0].input = accessor(new Float32Array([0]), 'SCALAR', 5126, { min: [0], max: [0] });
      json.animations[0].samplers[0].output = accessor(new Float32Array([0, 0, 0, 1]), 'VEC4');
    }
    // The normalizing parent magnifies this otherwise bounded source animation.
    // Seeking must enforce the same world-transform limit as advancing frames.
    if (options.unboundedPose) {
      json.animations[0].samplers[0].output = accessor(new Float32Array([0, 0, 0, 1e12, 0, 0, 0, 0, 0]), 'VEC3');
      json.animations[0].channels[0].target.path = 'translation';
    }
  }
  json.buffers = [{ byteLength: offset, ...(options.externalBuffer ? { uri: options.externalBuffer } : {}) }];
  const text = Buffer.from(JSON.stringify(json)), jsonLength = Math.ceil(text.length / 4) * 4;
  const jsonBytes = Buffer.alloc(jsonLength, 0x20); text.copy(jsonBytes);
  const binary = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonLength + binary.length, 8);
  jsonHeader.writeUInt32LE(jsonLength); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  geometry.dispose();
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binary]).toString('base64');
}

// Decode real browser screenshot PNGs to prove visible model pixels, rather than
// accepting a WebGL context, canvas element, or renderer counter as visual proof.
function screenshotPixels(png) {
  let width, height, channels, offset = 8;
  const chunks = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : 3; assert.ok([2, 6].includes(data[9])); }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(width * height * channels);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= channels ? pixels[i - channels] : 0, up = y ? pixels[i - stride] : 0, upperLeft = y && x >= channels ? pixels[i - stride - channels] : 0;
      const predict = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      assert.notEqual(predict, undefined);
      pixels[i] = (raw[y * (stride + 1) + x + 1] + predict) & 255;
    }
  }
  let modelPixels = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  const colors = new Set(), background = [...pixels.subarray(0, 3)];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels, color = [...pixels.subarray(i, i + 3)];
    if (color.some((value, c) => Math.abs(value - background[c]) > 15)) {
      modelPixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); colors.add(color.join(','));
    }
  }
  return { modelPixels, distinctColors: colors.size, width, height, bounds: { minX, minY, maxX, maxY } };
}

async function fixture(browser, t, sources, options = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: options.dpr ?? 1, reducedMotion: 'no-preference' });
  t.after(() => context.close());
  const page = await context.newPage(), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); requests.push(url.href);
    if (url.origin !== origin || !sources.has(url.pathname)) { await route.abort(); return; }
    await route.fulfill({ contentType: url.pathname === '/' ? 'text/html' : 'text/javascript', body: sources.get(url.pathname), headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' blob:" } });
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    window.meter = { contexts: 0, contextHandles: new Set(), fetches: [], urls: new Set(), pendingFrames: new Set(), disposed: { geometries: 0, materials: 0, textures: 0, skeletons: 0, bitmaps: 0 }, observers: new Set(), listeners: new Map(), geometries: new Set(), materials: new Set(), textures: new Set(), skeletons: new Set(), creation: new Map() };
    const meter = window.meter;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { if (kind === 'webgl2') meter.contexts++; const context = getContext.call(this, kind, ...args); if (kind === 'webgl2' && context) meter.contextHandles.add(context); return context; };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); meter.urls.add(url); return url; };
    URL.revokeObjectURL = url => { meter.urls.delete(url); return revoke(url); };
    const fetch = window.fetch.bind(window);
    window.fetch = (url, ...args) => { meter.fetches.push(String(url)); return fetch(url, ...args); };
    const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { const id = raf(time => { meter.pendingFrames.delete(id); callback(time); }); meter.pendingFrames.add(id); return id; };
    window.cancelAnimationFrame = id => { meter.pendingFrames.delete(id); return cancel(id); };
    for (const name of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver']) {
      const Constructor = window[name];
      window[name] = class extends Constructor { constructor(...args) { super(...args); if (new Error().stack.includes('/asset-viewer-runtime.mjs')) meter.observers.add(this); } disconnect() { meter.observers.delete(this); return super.disconnect(); } };
    }
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (!/\/(asset-viewer-runtime\.mjs|vendor\/three\/)/.test(new Error().stack)) return add.call(this, type, fn, opts);
      const entries = meter.listeners.get(this) ?? []; meter.listeners.set(this, entries);
      const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      if (!entries.some(entry => entry.type === type && entry.fn === fn && entry.capture === capture)) entries.push({ type, fn, capture });
      return add.call(this, type, fn, opts);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opts) {
      const entries = meter.listeners.get(this) ?? [], capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      meter.listeners.set(this, entries.filter(entry => entry.type !== type || entry.fn !== fn || entry.capture !== capture));
      return remove.call(this, type, fn, opts);
    };
    window.THREE = await import('/vendor/three/build/three.module.js');
    // Observe the real scene/camera without substituting any rendering logic.
    const update = THREE.Scene.prototype.updateMatrixWorld;
    THREE.Scene.prototype.updateMatrixWorld = function (...args) {
      if (this.background?.isColor) {
        meter.scene = this;
        this.traverse(object => {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) meter.materials.add(material);
        });
      }
      return update.apply(this, args);
    };
    const updateCamera = THREE.Camera.prototype.updateMatrixWorld;
    THREE.Camera.prototype.updateMatrixWorld = function (...args) { meter.camera = this; return updateCamera.apply(this, args); };
    for (const [name, key] of [['BufferGeometry', 'geometries'], ['Material', 'materials'], ['Texture', 'textures'], ['Skeleton', 'skeletons']]) {
      const prototype = THREE[name].prototype, dispose = prototype.dispose;
      prototype.dispose = function () { meter.disposed[key]++; meter[key].delete(this); return dispose.call(this); };
    }
    // RenderTarget.dispose releases its attachments through renderer listeners;
    // Three does not call Texture.dispose on each render-target attachment.
    const disposeTarget = THREE.RenderTarget.prototype.dispose;
    THREE.RenderTarget.prototype.dispose = function () { this.textures.forEach(texture => meter.textures.delete(texture)); return disposeTarget.call(this); };
    for (const [name, method, key] of [['BufferGeometry', 'computeBoundingBox', 'geometries'], ['Material', 'clone', 'materials'], ['Texture', 'clone', 'textures'], ['Skeleton', 'computeBoneTexture', 'skeletons']]) {
      const original = THREE[name].prototype[method];
      THREE[name].prototype[method] = function (...args) {
        if (method !== 'clone') meter[key].add(this);
        const result = original.apply(this, args), stack = new Error().stack;
        // WebGLShadowMap builds an unused internal shader even with shadows off.
        // It is renderer-owned; native context teardown below covers internals.
        if ((result?.isTexture || result?.isMaterial) && !stack.includes('new WebGLShadowMap')) { meter[key].add(result); meter.creation.set(result, stack); }
        return result;
      };
    }
    const close = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function () { meter.disposed.bitmaps++; return close.call(this); };
    window.viewerModule = await import('/asset-viewer-runtime.mjs');
    window.statuses = [];
    window.decodeGlb = data => Uint8Array.fromBase64(data).buffer;
    window.start = async data => {
      window.controller = new AbortController();
      window.viewer = await viewerModule.createAssetViewer({ host: document.querySelector('#host'), bytes: decodeGlb(data), label: 'Owned fixture GLB', signal: controller.signal, onStatus: message => statuses.push(message) });
      return viewer.stats();
    };
  });
  return { page, requests, errors };
}
const stats = page => page.evaluate(() => viewer.stats());
async function idleFrames(page) {
  await page.waitForTimeout(100);
  const before = await stats(page);
  const animation = await page.evaluate(() => viewer.animationState());
  await page.waitForTimeout(200);
  assert.equal((await stats(page)).renderFrames, before.renderFrames, 'no idle render loop');
  assert.deepEqual(await page.evaluate(() => viewer.animationState()), animation, 'suspended animation time does not advance');
  assert.equal(await page.evaluate(() => meter.pendingFrames.size), 0, 'no idle pending RAF');
}
async function clean(page) {
  await page.waitForTimeout(80);
  const state = await page.evaluate(() => ({ canvases: document.querySelectorAll('#host canvas').length, frames: meter.pendingFrames.size, urls: meter.urls.size, observers: meter.observers.size, geometry: meter.geometries.size, materials: meter.materials.size, textures: meter.textures.size, skeletons: meter.skeletons.size,
    listeners: [...meter.listeners.values()].reduce((total, entries) => total + entries.length, 0), disposed: meter.disposed,
    contextsLost: [...meter.contextHandles].every(context => context.isContextLost()),
    remaining: [...meter.materials, ...meter.textures].map(value => ({ type: value.type, name: value.name, stack: meter.creation.get(value) })) }));
  for (const key of ['canvases', 'frames', 'urls', 'observers', 'geometry', 'materials', 'textures', 'skeletons', 'listeners']) assert.equal(state[key], 0, `${key} released ${JSON.stringify(state.remaining)}`);
  assert.equal(state.contextsLost, true, 'native context teardown releases renderer internals');
  return state;
}

test('real Three.js GLB renderer in isolated headless WebGL2', { timeout: 120_000 }, async t => {
  const sources = new Map(await Promise.all(['/asset-viewer-runtime.mjs', ...vendorPaths].map(async path => [path, await readFile(resolve(root, 'apps/desktop/public', '.' + path))])));
  sources.set('/', '<!doctype html><html><head><title>Owned asset renderer fixture</title></head><body style="margin:0;background:#181b20"><div id="host" style="width:640px;height:480px"></div></body></html>');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_VIEWER_BROWSER ? { executablePath: process.env.ARCANE_VIEWER_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'],
  });
  t.after(() => browser.close());
  const proof = { browser: await browser.version(), fixture: 'owned GLBs / generated local vendor / nonpersistent headless WebGL2', checks: [] };
  const proofDir = process.env.ARCANE_VIEWER_PROOF_DIR ? resolve(process.env.ARCANE_VIEWER_PROOF_DIR) : null;
  if (proofDir) await mkdir(proofDir, { recursive: true });

  await t.test('lazy context, visible PBR pixels, orbit, zoom, keyboard, wireframe, idle and disposal', async t => {
    const { page, requests, errors } = await fixture(browser, t, sources);
    assert.equal(await page.evaluate(() => meter.contexts), 0, 'import allocates no WebGL context');
    const initial = await page.evaluate(data => start(data), glb({ metal: true }));
    assert.deepEqual(initial, { triangles: 12, meshes: 1, materials: 1, animations: 0, renderFrames: 0,
      dimensions: { x: 2, y: 1, z: Math.fround(.7) }, bounds: { min: { x: -1, y: -.5, z: -Math.fround(.35) }, max: { x: 1, y: .5, z: Math.fround(.35) } }, units: 'meters' });
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    const canvas = page.locator('#host canvas');
    assert.equal(await canvas.getAttribute('role'), 'img');
    assert.match(await canvas.getAttribute('aria-label'), /Owned fixture GLB/);
    const first = await canvas.screenshot(), pixels = screenshotPixels(first);
    assert.ok(pixels.modelPixels > 15_000, JSON.stringify(pixels));
    assert.ok(pixels.distinctColors > 100, 'PBR lighting has visible shaded pixels');
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 260, bounds.y + 220); await page.mouse.down();
    await page.mouse.move(bounds.x + 400, bounds.y + 255, { steps: 8 }); await page.mouse.up();
    const orbit = await canvas.screenshot(); assert.ok(!orbit.equals(first), 'mouse orbit changes rendered screenshot');
    await page.mouse.wheel(0, -220); await page.waitForTimeout(80);
    const zoom = await canvas.screenshot(); assert.ok(!zoom.equals(orbit), 'wheel zoom changes rendered screenshot');
    await canvas.focus(); await page.keyboard.press('ArrowLeft');
    const keyboard = await canvas.screenshot(); assert.ok(!keyboard.equals(zoom), 'keyboard orbits');
    await page.keyboard.press('Home');
    await page.evaluate(() => document.querySelector('canvas').blur());
    const reset = await canvas.screenshot(); assert.ok(reset.equals(first), 'reset restores exact fitted view');
    await page.evaluate(() => viewer.setWireframe(true));
    const wireframe = await canvas.screenshot(); assert.ok(!wireframe.equals(first));
    await idleFrames(page);
    await page.evaluate(() => { const unrelated = document.createElement('p'); document.body.append(unrelated); for (let i = 0; i < 30; i++) unrelated.textContent = String(i); unrelated.remove(); });
    await idleFrames(page);
    const renderer = await page.evaluate(() => ({ context: document.querySelector('canvas').getContext('webgl2').getParameter(WebGL2RenderingContext.VERSION), fetches: meter.fetches }));
    assert.match(renderer.context, /WebGL 2/); assert.deepEqual(renderer.fetches, []);
    assert.ok(requests.every(url => url.startsWith(origin + '/')));
    assert.deepEqual(errors, []);
    await page.evaluate(() => viewer.dispose()); const disposal = await clean(page);
    assert.ok(disposal.disposed.geometries > 0 && disposal.disposed.materials > 0 && disposal.disposed.textures > 0);
    if (proofDir) for (const [name, bytes] of [['rendered', first], ['orbit', orbit], ['zoom', zoom], ['wireframe', wireframe]]) await writeFile(resolve(proofDir, name + '.png'), bytes);
    proof.checks.push({ name: 'visible PBR + mouse/keyboard controls + idle/dispose', pixels, renderer, disposal });
  });

  await t.test('axis views, bounded programmatic and pointer pan/orbit/zoom, modes and local lighting', async t => {
    const { page, requests, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => start(data), glb({ texture: true, metal: true }));
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    const canvas = page.locator('canvas'), initial = await canvas.screenshot();
    const change = async (method, ...args) => {
      const frames = await page.evaluate(({ method, args }) => { const frames = viewer.stats().renderFrames; viewer[method](...args); return frames; }, { method, args });
      await page.waitForFunction(frames => viewer.stats().renderFrames > frames, frames);
      return canvas.screenshot();
    };
    const views = new Map([['perspective', initial]]);
    for (const view of ['front', 'side', 'top', 'perspective']) {
      const shot = await change('setView', view), pixels = screenshotPixels(shot);
      views.set(view, shot);
      assert.ok(pixels.modelPixels > 10_000, view);
      assert.ok(pixels.bounds.minX > 5 && pixels.bounds.minY > 5 && pixels.bounds.maxX < pixels.width - 5 && pixels.bounds.maxY < pixels.height - 5, `fitted ${view}`);
      const camera = await page.evaluate(() => ({ type: meter.camera.type, position: meter.camera.position.toArray(), up: meter.camera.up.toArray() }));
      assert.equal(camera.type, view === 'perspective' ? 'PerspectiveCamera' : 'OrthographicCamera');
      if (view !== 'perspective') {
        const axis = { front: 2, side: 0, top: 1 }[view];
        assert.ok(camera.position[axis] > 0);
        for (const i of [0, 1, 2].filter(i => i !== axis)) assert.ok(Math.abs(camera.position[i]) < .0001, view);
      }
      if (view === 'top') assert.deepEqual(camera.up, [0, 0, -1]);
    }
    assert.ok(views.get('perspective').equals(initial), 'perspective restored');
    assert.ok(!views.get('front').equals(views.get('side')) && !views.get('top').equals(views.get('front')));
    const orbited = await change('orbit', .3, .15); assert.ok(!orbited.equals(initial));
    const panned = await change('pan', 50, 25); assert.ok(!panned.equals(orbited));
    const zoomed = await change('zoom', 1.2); assert.ok(!zoomed.equals(panned));
    assert.ok((await change('reset')).equals(initial));
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 280, bounds.y + 220); await page.mouse.down({ button: 'right' });
    await page.mouse.move(bounds.x + 330, bounds.y + 240, { steps: 4 }); await page.mouse.up({ button: 'right' });
    assert.ok(!(await canvas.screenshot()).equals(initial), 'right drag pans');
    await change('reset');
    await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
    assert.ok(!(await canvas.screenshot()).equals(initial), 'Shift-arrow pans');
    await page.evaluate(() => document.querySelector('canvas').blur()); await change('reset');
    await page.evaluate(() => { window.sourceMaterial = meter.scene.getObjectByName('FixtureAsset').material; });
    const clay = await change('setMode', 'clay'); assert.ok(!clay.equals(initial));
    assert.deepEqual(await page.evaluate(() => { const material = meter.scene.getObjectByName('FixtureAsset').material; window.clayMaterial = material; return { type: material.type, map: material.map, metalness: material.metalness }; }), { type: 'MeshStandardMaterial', map: null, metalness: 0 });
    const wireframe = await change('setMode', 'wireframe'); assert.ok(!wireframe.equals(clay));
    assert.equal(await page.evaluate(() => meter.scene.getObjectByName('FixtureAsset').material === sourceMaterial && sourceMaterial.wireframe), true);
    assert.ok((await change('setWireframe', false)).equals(initial), 'legacy false restores source rendering');
    await change('setMode', 'clay');
    assert.equal(await page.evaluate(() => meter.scene.getObjectByName('FixtureAsset').material === clayMaterial), true, 'bounded clay cache');
    await change('setMode', 'rendered');
    const soft = await change('setLighting', 'soft'), dramatic = await change('setLighting', 'dramatic');
    assert.ok(!soft.equals(initial) && !dramatic.equals(soft));
    assert.ok((await change('setLighting', 'studio')).equals(initial), 'studio restored');
    await change('setView', 'front');
    await change('zoom', 10); await change('zoom', 10); await page.evaluate(() => viewer.zoom(10));
    assert.ok(await page.evaluate(() => meter.camera.zoom <= 50), 'orthographic zoom cap');
    await change('pan', 10_000, 10_000);
    assert.ok(await page.evaluate(() => meter.camera.position.length() < 20), 'pan target bounded');
    await change('reset');
    await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:180px;height:560px'; });
    await page.waitForTimeout(100);
    for (const view of ['front', 'side', 'top']) {
      const pixels = screenshotPixels(await change('setView', view));
      assert.ok(pixels.modelPixels > 500 && pixels.bounds.minX > 3 && pixels.bounds.maxX < pixels.width - 3, `portrait ${view}`);
    }
    await idleFrames(page);
    assert.ok(requests.every(url => url.startsWith(origin + '/')));
    assert.ok((await page.evaluate(() => meter.fetches)).every(url => url.startsWith('blob:')));
    assert.deepEqual(errors, []);
    await page.evaluate(() => viewer.dispose()); await clean(page);
    proof.checks.push({ name: 'real fitted orthographic axes, pan/orbit/zoom caps, reversible clay/wireframe, local lighting and portrait fit' });
  });

  await t.test('source bounds and dimensions include node world transforms in glTF meters before normalization', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => start(data), glb({ scale: [3, 4, 5], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [10, 20, 30] }));
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    const source = await stats(page);
    assert.equal(source.units, 'meters');
    for (const [axis, extent, center] of [['x', 4, 10], ['y', 6, 20], ['z', Math.fround(.7) * 5, 30]]) {
      assert.ok(Math.abs(source.dimensions[axis] - extent) < 1e-6);
      assert.ok(Math.abs(source.bounds.min[axis] - (center - extent / 2)) < 1e-6);
      assert.ok(Math.abs(source.bounds.max[axis] - (center + extent / 2)) < 1e-6);
    }
    const detached = await page.evaluate(() => {
      const snapshot = viewer.stats(); snapshot.dimensions.x = -999; snapshot.bounds.min.x = -999;
      viewer.setView('top'); viewer.setMode('clay'); viewer.pan(20, 20);
      return viewer.stats();
    });
    assert.deepEqual(detached.dimensions, source.dimensions); assert.deepEqual(detached.bounds, source.bounds);
    await page.evaluate(() => viewer.dispose()); await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'source/world AABB, nonuniform scale, rotation, translated origin, glTF meters, detached stats' });
  });

  await t.test('alternate clips, exact seconds seek, speed, looping, nonloop end, paused poses and detached snapshots', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => start(data), glb({ animation: true, multipleAnimations: true }));
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    const source = await stats(page), canvas = page.locator('canvas'), initial = await canvas.screenshot();
    assert.deepEqual(await page.evaluate(() => viewer.animations()), [{ index: 0, name: 'Fixture motion', duration: 2 }, { index: 1, name: 'Alternate translation', duration: 3 }]);
    assert.deepEqual(await page.evaluate(() => viewer.animationState()), { index: 0, time: 0, duration: 2, playing: false, speed: 1, loop: true });
    await page.evaluate(() => { const clips = viewer.animations(); clips[0].duration = 999; viewer.animationState().time = 999; viewer.setAnimationSpeed(2); viewer.seekAnimation(1); });
    await page.waitForFunction(() => viewer.stats().renderFrames > 1);
    assert.equal(await page.evaluate(() => viewer.animationState().time), 1, 'seek seconds independent of speed');
    assert.ok(!(await canvas.screenshot()).equals(initial), 'seek renders real rotated pose');
    await idleFrames(page);
    await page.evaluate(() => viewer.selectAnimation(1));
    assert.deepEqual(await page.evaluate(() => viewer.animationState()), { index: 1, time: 0, duration: 3, playing: false, speed: 2, loop: true });
    assert.equal(await page.evaluate(() => meter.scene.getObjectByName('FixtureAsset').quaternion.angleTo(new THREE.Quaternion())), 0, 'alternate clip restores previous rotation track');
    await page.evaluate(() => viewer.seekAnimation(1));
    assert.deepEqual(await page.evaluate(() => meter.scene.getObjectByName('FixtureAsset').position.toArray()), [Math.fround(.3), Math.fround(.4), 0]);
    await page.evaluate(() => { viewer.seekAnimation(2.9); viewer.setAnimationPlaying(true); });
    await page.waitForFunction(() => viewer.animationState().time < 1);
    assert.equal(await page.evaluate(() => viewer.animationState().playing), true, 'loop wraps');
    await page.evaluate(() => { viewer.setAnimationLoop(false); viewer.seekAnimation(2.9); });
    await page.waitForFunction(() => !viewer.animationState().playing);
    assert.equal(await page.evaluate(() => viewer.animationState().time), 3, 'nonloop clamps at duration');
    await idleFrames(page);
    await page.evaluate(() => viewer.setAnimationPlaying(true));
    assert.ok(await page.evaluate(() => viewer.animationState().time < 3), 'playing at end restarts');
    await page.evaluate(() => { viewer.selectAnimation(0); viewer.setAnimationSpeed(.25); });
    assert.equal(await page.evaluate(() => viewer.animationState().index), 0);
    assert.equal(await page.evaluate(() => viewer.animationState().playing), true, 'selection preserves playback intent');
    await page.waitForFunction(() => viewer.animationState().time > 0);
    await page.evaluate(() => viewer.setAnimationPlaying(false));
    const paused = await page.evaluate(() => viewer.animationState()); await idleFrames(page);
    assert.deepEqual(await page.evaluate(() => viewer.animationState()), paused);
    assert.deepEqual((await stats(page)).dimensions, source.dimensions);
    await page.evaluate(() => viewer.dispose()); await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'real alternate clips, exact paused seek, speed range, loop wrap, nonloop completion/restart and immutable metadata' });
  });

  await t.test('strict validation, no-animation and zero-duration states, disposed mutators are no-ops', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => start(data), glb({ animation: true }));
    await idleFrames(page);
    const invalid = await page.evaluate(() => {
      const calls = [() => viewer.setView('diagonal'), () => viewer.setMode('solid'), () => viewer.setLighting('__proto__'),
        () => viewer.setWireframe(1), () => viewer.setAnimationPlaying('true'), () => viewer.setAnimationLoop(null),
        () => viewer.selectAnimation(-1), () => viewer.selectAnimation(.5), () => viewer.selectAnimation(1),
        () => viewer.seekAnimation(-1), () => viewer.seekAnimation(2.01), () => viewer.seekAnimation(NaN),
        () => viewer.setAnimationSpeed(.24), () => viewer.setAnimationSpeed(2.01), () => viewer.setAnimationSpeed('1'),
        () => viewer.orbit(Infinity, 0), () => viewer.orbit(0, 7), () => viewer.pan(10_001, 0), () => viewer.pan(0, NaN),
        () => viewer.zoom(0), () => viewer.zoom(11), () => viewer.zoom(undefined)];
      const before = viewer.animationState(), frames = viewer.stats().renderFrames;
      const failures = calls.map(call => { try { call(); return 'accepted'; } catch (error) { return error.name; } });
      const after = viewer.animationState();
      viewer.dispose();
      const disposed = calls.map(call => { try { call(); return 'no-op'; } catch { return 'threw'; } });
      viewer.reset(); viewer.dispose();
      return { before, after, frames, finalFrames: viewer.stats().renderFrames, failures, disposed };
    });
    assert.deepEqual(invalid.after, invalid.before); assert.equal(invalid.frames, invalid.finalFrames);
    assert.ok(invalid.failures.every(name => name === 'TypeError' || name === 'RangeError'));
    assert.ok(invalid.disposed.every(result => result === 'no-op')); await clean(page);
    await page.evaluate(data => start(data), glb());
    assert.deepEqual(await page.evaluate(() => { viewer.setAnimationPlaying(true); viewer.seekAnimation(0); return { clips: viewer.animations(), state: viewer.animationState(), has: viewer.hasAnimations }; }),
      { clips: [], state: { index: -1, time: 0, duration: 0, playing: false, speed: 1, loop: true }, has: false });
    await idleFrames(page); await page.evaluate(() => viewer.dispose()); await clean(page);
    await page.evaluate(data => start(data), glb({ animation: true, zeroDuration: true }));
    assert.deepEqual(await page.evaluate(() => { viewer.setAnimationPlaying(true); viewer.seekAnimation(0); return viewer.animationState(); }), { index: 0, time: 0, duration: 0, playing: false, speed: 1, loop: true });
    await idleFrames(page); await page.evaluate(() => viewer.dispose()); await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'strict input validation before mutation, no/zero-duration animation, invalid disposed calls harmless' });
  });

  await t.test('play/pause, host visibility, zero size, intersection, reduced motion and document visibility', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => start(data), glb({ animation: true }));
    assert.equal(await page.evaluate(() => viewer.hasAnimations), true); await idleFrames(page);
    await page.evaluate(() => viewer.setAnimationPlaying(true));
    await page.waitForFunction(() => viewer.stats().renderFrames > 4);
    const first = await stats(page); await page.waitForTimeout(180); assert.ok((await stats(page)).renderFrames > first.renderFrames);
    await page.evaluate(() => viewer.setAnimationPlaying(false)); await idleFrames(page);
    await page.evaluate(() => viewer.setAnimationPlaying(true));
    for (const hiddenStyle of ['display:none', 'visibility:hidden', 'opacity:0', 'width:0px;height:0px', 'position:absolute;top:1600px']) {
      await page.evaluate(style => { document.querySelector('#host').style.cssText = 'width:640px;height:480px;' + style; }, hiddenStyle);
      await idleFrames(page);
      const hidden = await stats(page);
      await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:640px;height:480px'; });
      await page.waitForFunction(count => viewer.stats().renderFrames > count + 1, hidden.renderFrames);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await idleFrames(page);
    const reduced = await stats(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(count => viewer.stats().renderFrames > count + 1, reduced.renderFrames);
    await page.evaluate(() => {
      window.clipHost = document.createElement('div'); clipHost.style.cssText = 'height:0;overflow:hidden';
      document.body.append(clipHost); clipHost.append(document.querySelector('#host'));
    });
    await idleFrames(page);
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await idleFrames(page);
    const clipped = await stats(page);
    await page.evaluate(() => { clipHost.style.height = '480px'; });
    await page.waitForFunction(count => viewer.stats().renderFrames > count + 1, clipped.renderFrames);
    await page.evaluate(() => { document.body.append(document.querySelector('#host')); clipHost.remove(); });
    // Headless tabs stay foreground. Drive the document visibility event contract
    // explicitly; host/intersection/zero-size/reduced-motion checks above are native.
    await page.evaluate(() => { window.fixtureVisibility = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => fixtureVisibility }); document.dispatchEvent(new Event('visibilitychange')); });
    await idleFrames(page); const hiddenDocument = await stats(page);
    await page.evaluate(() => { fixtureVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(count => viewer.stats().renderFrames > count + 1, hiddenDocument.renderFrames);
    await page.evaluate(() => { window.detachedHost = document.querySelector('#host'); detachedHost.remove(); });
    await idleFrames(page);
    const detached = await stats(page);
    await page.evaluate(() => document.body.append(detachedHost));
    await page.waitForFunction(count => viewer.stats().renderFrames > count + 1, detached.renderFrames);
    await page.evaluate(() => controller.abort()); await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'animation frames stop/resume on native host visibility, intersection, size, reduced motion; simulated document visibility event', frames: (await stats(page)).renderFrames });
  });

  await t.test('embedded texture, morph animation and skin animation render and release ImageBitmaps', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    for (const options of [{ texture: true, morph: true }, { texture: true, skin: true }]) {
      await page.evaluate(data => start(data), glb(options));
      await page.waitForFunction(() => viewer.stats().renderFrames > 0);
      const canvas = page.locator('canvas'), before = await canvas.screenshot();
      assert.ok(screenshotPixels(before).modelPixels > 10_000);
      await page.evaluate(() => viewer.setMode('clay'));
      const clay = await canvas.screenshot();
      await page.evaluate(() => viewer.seekAnimation(1));
      assert.ok(!(await canvas.screenshot()).equals(clay), `clay preserves native deformation ${JSON.stringify(options)}`);
      await page.evaluate(() => { viewer.setMode('rendered'); viewer.seekAnimation(0); });
      assert.ok((await canvas.screenshot()).equals(before), 'source material and initial deformation restored');
      await page.evaluate(() => viewer.setAnimationPlaying(true)); await page.waitForTimeout(320);
      const after = await canvas.screenshot(); assert.ok(!before.equals(after), JSON.stringify(options));
      await page.evaluate(() => viewer.dispose());
      const disposal = await clean(page); assert.ok(disposal.disposed.bitmaps > 0, 'ImageBitmap.close called');
      if (options.skin) assert.ok(disposal.disposed.skeletons > 0, 'skeleton bone textures disposed');
    }
    const fetches = await page.evaluate(() => meter.fetches); assert.ok(fetches.length >= 2); assert.ok(fetches.every(url => url.startsWith('blob:' )));
    assert.deepEqual(errors, []); proof.checks.push({ name: 'native embedded textures / morphs / skins / bitmap close', blobFetches: fetches.length });
  });

  await t.test('camera fitting across units, translated origins, narrow hosts and pixel budgets', async t => {
    const { page } = await fixture(browser, t, sources, { dpr: 3 });
    for (const units of [1e-6, 1, 1e6]) {
      await page.evaluate(data => start(data), glb({ units, translation: [units * 100, -units * 40, units * 12] }));
      await page.waitForFunction(() => viewer.stats().renderFrames > 0);
      const pixels = screenshotPixels(await page.locator('canvas').screenshot());
      assert.ok(pixels.modelPixels > 15_000, `${units}: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.bounds.minX > 5 && pixels.bounds.minY > 5 && pixels.bounds.maxX < pixels.width - 5 && pixels.bounds.maxY < pixels.height - 5, 'whole box fits');
      const dimensions = await page.evaluate(() => ({ width: document.querySelector('canvas').width, height: document.querySelector('canvas').height }));
      assert.equal(dimensions.width, 960); assert.equal(dimensions.height, 720);
    }
    await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:180px;height:560px'; }); await page.waitForTimeout(100);
    const narrow = screenshotPixels(await page.locator('canvas').screenshot());
    assert.ok(narrow.modelPixels > 1000); assert.ok(narrow.bounds.minX > 3 && narrow.bounds.maxX < narrow.width - 3);
    await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:6000px;height:4000px'; }); await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.querySelector('canvas').width * document.querySelector('canvas').height <= 4_000_000));
    await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:1000000px;height:2px'; }); await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => { const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2'); return canvas.width <= gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) && canvas.width * canvas.height <= 4_000_000; }), 'thin hosts respect GPU dimension limits as well as area');
    await page.evaluate(() => viewer.dispose()); await clean(page);
    proof.checks.push({ name: 'full-box fitting at 1e-6 / 1 / 1e6 units, translated origin, portrait resize, DPR 1.5 and 4M pixel caps' });
  });

  await t.test('reject URLs, malformed vertices, bounds and post-load complexity limits without fetch', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    const cases = [
      [{ externalImage: 'https://forbidden.invalid/texture.png' }, /external URLs/],
      [{ externalImage: 'blob:http://127.0.0.1/unowned' }, /external URLs/],
      [{ externalImage: 'data:image/png;base64,AAAA' }, /external URLs/],
      [{ externalBuffer: '/forbidden.bin' }, /external URLs/],
      [{ nanVertex: true }, /invalid vertex/],
      [{ translation: [1e14, 0, 0] }, /world transforms/],
      [{ materials: 65 }, /64 material/],
      [{ draws: 257 }, /preview limits/],
      [{ draws: 129, transparent: true, doubleSided: true }, /preview limits/],
      [{ draws: 129, transmission: true }, /256 draw-call/],
      [{ tooManyTriangles: true }, /preview limits/],
      [{ animation: true, invalidAnimation: true }, /invalid animation/],
    ];
    for (const [options, pattern] of cases) {
      const result = await page.evaluate(async data => { try { await start(data); return 'accepted'; } catch (error) { return error.message; } }, glb(options));
      assert.match(result, pattern, JSON.stringify(options)); await clean(page);
    }
    assert.deepEqual(await page.evaluate(() => meter.fetches), []); assert.deepEqual(errors, []);
    const partial = await page.evaluate(async data => { try { await start(data); return 'accepted'; } catch (error) { return error.message; } }, glb({ invalidPrimitive: true }));
    assert.notEqual(partial, 'accepted');
    const partialCleanup = await clean(page); assert.ok(partialCleanup.disposed.geometries > 0, 'successful primitive siblings are disposed on parse failure');
    proof.checks.push({ name: 'rejected remote / unowned blob / data / relative URLs, NaN, huge world transforms, 65 materials, 257 draws, >2M triangles' });
  });

  await t.test('abort during real bitmap decoding rejects promptly and disposes late parse', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => {
      const decode = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (...args) => { const bitmap = await decode(...args); window.bitmapReady = true; await new Promise(resolve => { window.releaseBitmap = resolve; }); return bitmap; };
      window.pending = start(data).then(() => 'accepted', error => error.name);
    }, glb({ texture: true }));
    await page.waitForFunction(() => bitmapReady);
    const result = await page.evaluate(async () => { controller.abort(); return pending; }); assert.equal(result, 'AbortError');
    await page.evaluate(() => releaseBitmap());
    await page.waitForFunction(() => meter.disposed.bitmaps === 1);
    await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'abort pending native decode, immediate AbortError, late bitmap close, no canvas/RAF/listener/observer/blob leak' });
  });

  await t.test('a new host owner cancels a slow parse and releases its late embedded bitmap', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    await page.evaluate(data => {
      const decode = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (...args) => { const bitmap = await decode(...args); window.bitmapReady = true; await new Promise(resolve => { window.releaseBitmap = resolve; }); return bitmap; };
      window.pending = start(data).then(() => 'accepted', error => error.name);
    }, glb({ texture: true }));
    await page.waitForFunction(() => bitmapReady);
    await page.evaluate(data => start(data), glb());
    assert.equal(await page.evaluate(() => pending), 'AbortError', 'replaced parse settles promptly');
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    await page.evaluate(() => releaseBitmap());
    await page.waitForFunction(() => meter.disposed.bitmaps === 1);
    assert.equal(await page.locator('#host canvas').count(), 1);
    await page.evaluate(() => viewer.dispose()); await clean(page); assert.deepEqual(errors, []);
    proof.checks.push({ name: 'slow parse host replacement, prompt cancellation, late native bitmap disposal, surviving new owner' });
  });

  await t.test('status callbacks expose only human-safe reasons for loader/render errors and unsafe sought poses', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    const marker = 'C:/private/project/secret.glb?token=fixture-private';
    const failure = await page.evaluate(async ({ data, marker }) => {
      const compute = THREE.BufferGeometry.prototype.computeBoundingBox;
      THREE.BufferGeometry.prototype.computeBoundingBox = () => { throw new Error(marker); };
      try { await start(data); return 'accepted'; } catch (error) { return error.message; }
      finally { THREE.BufferGeometry.prototype.computeBoundingBox = compute; }
    }, { data: glb(), marker });
    assert.equal(failure, marker);
    assert.equal(await page.evaluate(() => statuses.at(-1)), '3D preview unavailable: The asset could not be displayed safely.');
    await clean(page);
    await page.evaluate(data => start(data), glb());
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    await page.evaluate(marker => {
      window.updateScene = THREE.Scene.prototype.updateMatrixWorld;
      THREE.Scene.prototype.updateMatrixWorld = function (...args) { if (this === meter.scene) throw new Error(marker); return updateScene.apply(this, args); };
      viewer.setLighting('soft');
    }, marker);
    await page.waitForFunction(() => statuses.some(message => message === '3D preview stopped: The asset could not be displayed safely.'));
    await page.evaluate(() => { THREE.Scene.prototype.updateMatrixWorld = updateScene; });
    await clean(page);
    await page.evaluate(data => start(data), glb({ animation: true, units: 1e-6, unboundedPose: true }));
    await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    const unsafe = await page.evaluate(() => { try { viewer.seekAnimation(1); return 'accepted'; } catch (error) { return error.message; } });
    assert.match(unsafe, /world transforms/);
    assert.equal(await page.evaluate(() => viewer.animationState().playing), false);
    await clean(page);
    assert.ok((await page.evaluate(() => statuses)).every(message => !message.includes(marker) && !message.includes('private') && !message.includes('token=')));
    assert.deepEqual(errors, []);
    proof.checks.push({ name: 'raw loader/render path redaction, synchronous seek world-bound enforcement, full failure cleanup' });
  });

  await t.test('owned host replacement, already aborted signals and WebGL context loss', async t => {
    const { page, errors } = await fixture(browser, t, sources);
    const data = glb({ animation: true });
    await page.evaluate(data => start(data), data); await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    await page.evaluate(data => { window.previous = viewer; return start(data); }, data);
    assert.equal(await page.locator('#host canvas').count(), 1);
    const before = await page.evaluate(() => previous.stats().renderFrames);
    await page.waitForTimeout(100); assert.equal(await page.evaluate(() => previous.stats().renderFrames), before);
    await page.evaluate(() => viewer.setAnimationPlaying(true));
    await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.waitForFunction(() => statuses.some(message => /context lost/i.test(message)));
    await clean(page);
    const cancelled = await page.evaluate(async data => {
      const signal = AbortSignal.abort(); const contexts = meter.contexts;
      try { await viewerModule.createAssetViewer({ host: document.querySelector('#host'), bytes: decodeGlb(data), label: 'Cancelled', signal }); return 'accepted'; }
      catch (error) { return { error: error.name, contexts: meter.contexts - contexts }; }
    }, data);
    assert.deepEqual(cancelled, { error: 'AbortError', contexts: 0 }); assert.deepEqual(errors, []);
    await page.evaluate(data => start(data), data); await page.waitForFunction(() => viewer.stats().renderFrames > 0);
    await page.evaluate(() => { document.querySelector('#host').remove(); viewer.dispose(); });
    await clean(page);
    proof.checks.push({ name: 'replacement disposes prior host owner, pre-abort allocates no context, native context loss reports and stops' });
  });
  if (proofDir) await writeFile(resolve(proofDir, 'report.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
});
