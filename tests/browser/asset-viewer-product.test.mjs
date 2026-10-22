import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// Opt-in private emit, never the shared root build. Run with
// ARCANE_VIEWER_PRODUCT_EMIT=<private tsc outDir containing studio.js + viewer.js>
// node --test tests/browser/asset-viewer-product.test.mjs
// Optional: ARCANE_VIEWER_PRODUCT_GPU=1 (real Three/SwiftShader),
// ARCANE_VIEWER_PRODUCT_BROWSER=<Edge/Chromium executable>,
// ARCANE_VIEWER_PRODUCT_PROOF_DIR=<private screenshot/report directory>.
// ARCANE_VIEWER_PRODUCT_ASSET=<exact retained induction-press asset.glb below>
// adds a separate real Blender bytes / controlled HTTP fixture check. It is
// not a live Studio or full native generation-chain check and never generates.
// Nonpersistent headless Edge; every request is routed in memory. No server,
// user profile, credential/private file, provider, Studio, or native service.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18751'; // No process listens here.
const JOB = '11111111-1111-4111-8111-111111111111';
const NEXT_JOB = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64);
const RETAINED_JOB = 'a03b713c-da0d-4097-8bfd-8fc5e1533c42';
const RETAINED_SHA = '74bec1735c7780439736629364517facde5ea6eaf98ba95b462f8e71e6002bbf';
const retainedAsset = 'packages/asset-pipeline/.runtime/custom-verification-6ee38b20-5cd5-4f8e-bef4-1b4cd923f178/induction-press-a03b713c-da0d-4097-8bfd-8fc5e1533c42/asset.glb';
const vendorPaths = [
  '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js', '/vendor/three/examples/jsm/controls/OrbitControls.js',
  '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three/examples/jsm/utils/SkeletonUtils.js',
];
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactHeaders = bytes => ({ 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'Content-Disposition': 'attachment; filename="fixture-asset-asset.glb"' });
function png() {
  const crc = data => { let n = 0xffffffff; for (const byte of data) { n ^= byte; for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc(Buffer.concat([type, data])), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 220, 120, 35, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function glb(change = () => {}) {
  const geometry = new BoxGeometry(2, 1, .5).toNonIndexed(), chunks = [], bufferViews = [], accessors = [];
  let length = 0;
  const view = bytes => { const index = bufferViews.length, data = Buffer.from(bytes); bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length }); const padding = Buffer.alloc((4 - data.length % 4) % 4); chunks.push(data, padding); length += data.length + padding.length; return index; };
  const accessor = (array, type, extra = {}) => { const index = accessors.length; accessors.push({ bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength)), componentType: 5126, count: array.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]), type, ...extra }); return index; };
  const position = accessor(geometry.attributes.position.array, 'VEC3', { min: [-1, -.5, -.25], max: [1, .5, .25] });
  const normal = accessor(geometry.attributes.normal.array, 'VEC3'), uv = accessor(geometry.attributes.uv.array, 'VEC2');
  const times = accessor(new Float32Array([0, 2]), 'SCALAR', { min: [0], max: [2] });
  const translation = accessor(new Float32Array([0, 0, 0, 0, .2, 0]), 'VEC3');
  const image = view(png());
  const doc = {
    asset: { version: '2.0', generator: 'Arcane owned product fixture' },
    buffers: [{ byteLength: length }], bufferViews, accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: .6 } }],
    images: [{ bufferView: image, mimeType: 'image/png' }], textures: [{ source: 0 }],
    nodes: [{ mesh: 0, scale: [2, 2, 2] }], scenes: [{ nodes: [0] }], scene: 0,
    animations: [{ name: 'Fixture motion', samplers: [{ input: times, output: translation }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
  };
  change(doc);
  const json = Buffer.from(JSON.stringify(doc)), jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + length), bin = Buffer.concat(chunks);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(0x20, 20, 20 + jsonLength); json.copy(bytes, 20);
  bytes.writeUInt32LE(length, 20 + jsonLength); bytes.writeUInt32LE(0x004e4942, 24 + jsonLength); bin.copy(bytes, 28 + jsonLength); geometry.dispose(); return bytes;
}
function manifest(bytes = glb(), jobId = JOB) {
  return { schemaVersion: 1, jobId, request: { name: 'fixture-asset', template: 'hero-prop' }, artifacts: [
    { path: 'collision.glb', role: 'export', bytes: bytes.length, sha256: checksum(bytes) },
    { path: 'asset.glb', role: 'export', bytes: bytes.length, sha256: checksum(bytes) },
  ] };
}
const recorder = `export async function createAssetViewer({host, bytes, signal, label}) {
  const meter = window.viewerMeter, id = meter.renderers.length;
  const state = {index:0,time:0,duration:2,playing:false,speed:1,loop:true};
  const record = {id,calls:[],disposed:0,bytes:bytes.byteLength,aborted:signal.aborted}; meter.renderers.push(record);
  const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=400; canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',label); host.append(canvas);
  const call = (method,...args)=>record.calls.push({method,args});
  return { reset(){call('reset')},setView(value){call('setView',value)},setMode(value){call('setMode',value)},setLighting(value){call('setLighting',value)},
    hasAnimations:true,animations(){return [{index:0,name:'Fixture motion',duration:2},{index:1,name:'Second clip',duration:3}]},animationState(){return {...state}},
    selectAnimation(value){state.index=value;call('selectAnimation',value)},seekAnimation(value){state.time=value;call('seekAnimation',value)},setAnimationSpeed(value){state.speed=value;call('setAnimationSpeed',value)},setAnimationLoop(value){state.loop=value;call('setAnimationLoop',value)},setAnimationPlaying(value){state.playing=value;call('setAnimationPlaying',value)},
    stats(){return {triangles:12,materials:1,drawCalls:1,dimensions:{x:4,y:2,z:1}}},dispose(){record.disposed++;canvas.remove()}
  };
}`;

async function sources(emit) {
  const server = await readFile(resolve(root, 'apps/daemon/src/lab-server.ts'), 'utf8');
  const policy = /setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(server)?.[1];
  assert.ok(policy, 'Use the actual production response CSP');
  assert.match(policy, /script-src 'self';/); assert.match(policy, /style-src 'self';/);
  assert.match(policy, /connect-src 'self' blob:;/); assert.match(policy, /img-src 'self' blob:;/);
  assert.match(policy, /worker-src 'none';/); assert.match(policy, /object-src 'none';/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*|https?:/);
  // The shipped faces (studio.css @font-face, same-origin /fonts) are part of the product page.
  const fonts = (await readdir(resolve(root, 'apps/desktop/public/fonts'))).filter(name => name.endsWith('.woff2')).map(name => '/fonts/' + name);
  const paths = ['/studio.css', '/asset-viewer-runtime.mjs', ...vendorPaths, ...fonts];
  const result = new Map(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, 'apps/desktop/public', '.' + path))])));
  const html = (await readFile(resolve(root, 'apps/desktop/public/studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('</head>', '<link rel="stylesheet" href="/viewer-fixture.css"></head>');
  result.set('/viewer-fixture.css', '#fixture-visible{width:700px;margin:20px}');
  result.set('/', html);
  // Suppress only the page-wide startup block. Exported controllers, their
  // event wiring, integrity gates and runtime import are the actual private emit.
  const workbench = await readFile(resolve(emit, 'apps/desktop/src/studio.js'), 'utf8');
  const startup = workbench.indexOf("if (typeof window !== 'undefined' && typeof document !== 'undefined')");
  assert.ok(startup > 0, 'Identify the explicit page bootstrap before serving exports');
  result.set('/studio.js', workbench.slice(0, startup)); return { files: result, policy };
}
async function fixture(browser, t, sources, emit, options = {}) {
  const { files, policy } = sources;
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage(), network = [], forbidden = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let selectedManifest = manifest(), artifact = glb();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); network.push(url.pathname + url.search);
    if (url.origin !== origin) { forbidden.push(url.pathname); await route.abort(); return; }
    if (url.pathname === '/v1/assets/manifest' || url.pathname === '/v1/assets/artifact') {
      const jobId = url.searchParams.get('jobId');
      assert.equal(request.method(), 'GET'); assert.equal(request.headers().authorization, 'Bearer ' + TOKEN);
      assert.equal(jobId, selectedManifest.jobId);
      if (url.pathname.endsWith('/manifest')) await route.fulfill({ json: { manifest: selectedManifest } });
      else { assert.equal(url.searchParams.get('path'), 'asset.glb'); await route.fulfill({ body: artifact, headers: artifactHeaders(artifact) }); }
      return;
    }
    if (url.pathname === '/v1/assets/review/prepare') {
      assert.equal(request.method(), 'POST'); assert.equal(request.headers().authorization, 'Bearer ' + TOKEN);
      assert.equal(JSON.parse(request.postData() ?? '{}').jobId, selectedManifest.jobId, 'review prepares the exact shown job');
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"FIXTURE","message":"No review service in this fixture."}' }); return;
    }
    if (url.pathname === '/asset-viewer-runtime.mjs' && !options.gpu) { await route.fulfill({ contentType: 'text/javascript', body: recorder }); return; }
    if (files.has(url.pathname)) {
      await route.fulfill({ contentType: url.pathname === '/' ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: files.get(url.pathname), headers: { 'Content-Security-Policy': policy } }); return;
    }
    // Only emitted desktop JavaScript is readable; URL paths cannot select
    // another directory or any account, app state, manifest or credential file.
    if (/^\/(?:apps\/desktop\/src\/)?[a-z][a-z0-9-]*\.js$/.test(url.pathname)) {
      const name = url.pathname.split('/').at(-1);
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(resolve(emit, 'apps/desktop/src', name)) }); return;
    }
    forbidden.push(url.pathname); await route.abort();
  });
  await page.addInitScript(() => {
    window.fixtureCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => fixtureCspViolations.push({ directive: event.effectiveDirective }));
  });
  await page.goto(origin);
  await page.evaluate(() => {
    window.viewerMeter = { renderers: [], contexts: 0 };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { if (kind === 'webgl' || kind === 'webgl2') viewerMeter.contexts++; return getContext.call(this, kind, ...args); };
    // Fixture layout leaves the actual product DOM available to start(). Move
    // the real controls/preview to a visible test surface, retaining listeners.
    const visible = document.createElement('section'); visible.id = 'fixture-visible';
    document.body.prepend(visible);
    for (const id of ['asset-load-manifest', 'asset-job-picker', 'asset-viewer']) visible.append(document.getElementById(id));
    for (const child of document.body.children) if (child !== visible) child.hidden = true;
  });
  return { page, network, forbidden, errors, select(bytes, value) { artifact = bytes; selectedManifest = value; } };
}
async function startProduct(page, jobId = JOB, request = { template: 'hero-prop', name: 'fixture-asset' }) {
  await page.evaluate(async ({ JOB, NEXT_JOB, TOKEN, request }) => {
    const { StudioWorkbench, StudioApi } = await import('/studio.js');
    const { startWorkspaceShell } = await import('/workspace-shell.js');
    window.workbench = new StudioWorkbench(document, new StudioApi(TOKEN), location.origin, TOKEN, { assetMode: 'standalone', getProjectPath: () => '/owned-fixture/project' });
    // Suppress unrelated periodic metadata reads, preserving the actual
    // start() registration and loadAssetManifest() implementation.
    workbench.refresh = async () => {}; workbench.schedule = () => {};
    await workbench.start();
    window.shell = startWorkspaceShell(document);
    workbench.assetJobs = [JOB, NEXT_JOB].map(jobId => ({ jobId, request, state: 'succeeded', manifestAvailable: true }));
    workbench.assetAvailable = true; workbench.assetJobId = JOB;
    workbench.renderAssetPicker(); workbench.renderAssetControls();
  }, { JOB: jobId, NEXT_JOB, TOKEN, request });
}

// C30 viewer controls: the camera gizmo, the display segmented control, the lighting menu and the inspector tabs.
const viewerControl = {
  view: (page, value) => page.getByRole('button', { name: { perspective: 'Perspective', front: 'Front', side: 'Side', top: 'Top' }[value] + ' view', exact: true }).click(),
  mode: (page, value) => page.getByRole('button', { name: { rendered: 'Textured', wireframe: 'Wireframe', clay: 'Shaded' }[value], exact: true }).click(),
  async lighting(page, value) {
    await page.getByRole('button', { name: /^Lighting, / }).click();
    await page.getByRole('menuitemradio', { name: { studio: 'Studio', soft: 'Soft', dramatic: 'Dramatic' }[value], exact: true }).click();
  },
};

test('production manifest-to-viewer wiring in isolated Edge DOM', { skip: !process.env.ARCANE_VIEWER_PRODUCT_EMIT, timeout: 60_000 }, async t => {
  const emit = resolve(process.env.ARCANE_VIEWER_PRODUCT_EMIT), assets = await sources(emit);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_VIEWER_PRODUCT_BROWSER ? { executablePath: process.env.ARCANE_VIEWER_PRODUCT_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'],
  }); t.after(() => browser.close());
  const proof = { fixture: 'owned GLBs / private compiled controllers / in-memory routes / nonpersistent Edge', browser: await browser.version(), productionCsp: assets.policy, checks: [] };
  const proofDir = process.env.ARCANE_VIEWER_PRODUCT_PROOF_DIR ? resolve(process.env.ARCANE_VIEWER_PRODUCT_PROOF_DIR) : null;
  if (proofDir) await mkdir(proofDir, { recursive: true });

  await t.test('real manifest button selects exact job and controls only its current renderer', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    await startProduct(page);
    assert.equal(f.network.filter(path => path.startsWith('/v1/')).length, 0, 'no artifact or manifest fetch before explicit click');
    assert.equal(f.network.includes('/asset-viewer-runtime.mjs'), false);
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    await page.locator('#asset-load-manifest').click();
    await page.waitForFunction(() => viewerMeter.renderers.length === 1 && !workbench.assetBusy);
    assert.deepEqual(f.network.filter(path => path.startsWith('/v1/')), [
      '/v1/assets/manifest?jobId=' + JOB, '/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb', '/v1/assets/review/prepare',
    ]);
    assert.equal(await page.locator('#asset-viewer canvas[role="img"]').count(), 1);
    assert.match(await page.locator('.viewer-metrics').textContent(), /4\.00 × 2\.00 × 1\.00 m/);
    assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), 'true', 'verified 3D canvas opens workspace preview');
    for (const view of ['perspective', 'front', 'side', 'top']) await viewerControl.view(page, view);
    for (const mode of ['rendered', 'wireframe', 'clay']) await viewerControl.mode(page, mode);
    for (const lighting of ['studio', 'soft', 'dramatic']) await viewerControl.lighting(page, lighting);
    await page.getByRole('button', { name: 'Reset view' }).click();
    await page.getByRole('tab', { name: 'Animation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Animation clip' }).selectOption('1');
    await page.getByRole('slider', { name: 'Animation time' }).fill('1.25');
    await page.getByRole('combobox', { name: 'Animation speed' }).selectOption('1.5');
    await page.getByRole('checkbox', { name: 'Loop animation' }).uncheck();
    await page.getByRole('button', { name: 'Play animation' }).click();
    await page.getByRole('button', { name: 'Pause animation' }).click();
    const expected = [
      ...['perspective', 'front', 'side', 'top'].map(value => ({ method: 'setView', args: [value] })),
      ...['rendered', 'wireframe', 'clay'].map(value => ({ method: 'setMode', args: [value] })),
      ...['studio', 'soft', 'dramatic'].map(value => ({ method: 'setLighting', args: [value] })),
      { method: 'reset', args: [] }, { method: 'selectAnimation', args: [1] }, { method: 'seekAnimation', args: [1.25] },
      { method: 'setAnimationSpeed', args: [1.5] }, { method: 'setAnimationLoop', args: [false] },
      { method: 'setAnimationPlaying', args: [true] }, { method: 'setAnimationPlaying', args: [false] },
    ];
    assert.deepEqual(await page.evaluate(() => viewerMeter.renderers[0].calls), expected);
    await page.evaluate(() => { window.oldControls = [...document.querySelectorAll('#asset-viewer select,#asset-viewer input,#asset-viewer button')]; });
    await page.locator('#asset-job-picker').selectOption(NEXT_JOB);
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    f.select(glb(), manifest(glb(), NEXT_JOB));
    await page.locator('#asset-load-manifest').click();
    await page.waitForFunction(() => viewerMeter.renderers.length === 2 && !workbench.assetBusy);
    await page.evaluate(() => { for (const node of oldControls) for (const event of ['click', 'change', 'input']) node.dispatchEvent(new Event(event)); });
    await viewerControl.view(page, 'top');
    const recorded = await page.evaluate(() => viewerMeter.renderers);
    assert.deepEqual(recorded[0].calls, expected); assert.equal(recorded[0].disposed, 1);
    assert.deepEqual(recorded[1].calls, [{ method: 'setView', args: ['top'] }]);
    assert.equal(f.network.filter(path => path.startsWith('/v1/')).length, 6, 'all controls stay local (two loads: manifest, artifact and review prepare each)');
    await page.evaluate(() => { shell.cleanup(); workbench.stop(); });
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    assert.equal(await page.evaluate(() => viewerMeter.renderers[1].disposed), 1);
    assert.equal(await page.evaluate(() => viewerMeter.contexts), 0, 'recording renderer does not allocate a GPU');
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []);
    proof.checks.push({ name: 'explicit manifest click / exact job / all controls / workspace activity / stop', requests: f.network.filter(path => path.startsWith('/v1/')), calls: expected.length, contexts: 0 });
  });

  await t.test('checksum and external URI failures allocate no runtime or GPU in real DOM', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    const valid = glb(), damaged = Buffer.from(valid); damaged[damaged.indexOf('Arcane')] = 66;
    const external = glb(doc => { doc.images = [{ uri: 'https://fixture.invalid/blocked.png' }]; });
    for (const [name, bytes, value] of [['checksum', damaged, manifest(valid)], ['external URI', external, manifest(external)]]) {
      f.select(bytes, value);
      await page.evaluate(async ({ value, JOB, TOKEN }) => {
        const { AssetViewerPanel } = await import('/asset-viewer.js');
        window.panel = new AssetViewerPanel(document, TOKEN, { deadlineMs: 500 }); await panel.show(value, JOB, () => true);
      }, { value, JOB, TOKEN });
      assert.equal(await page.locator('#asset-viewer canvas').count(), 0, name);
      assert.equal(await page.evaluate(() => viewerMeter.contexts), 0, name);
      assert.equal(f.network.includes('/asset-viewer-runtime.mjs'), false, name);
      await page.evaluate(() => panel.clear());
    }
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []);
    proof.checks.push({ name: 'checksum / preflight gates', rejected: 2, runtimeImports: 0, contexts: 0 });
  });

  await t.test('delayed runtime/renderer and current=false are fenced in real DOM', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    const results = await page.evaluate(async ({ value, JOB, TOKEN }) => {
      const { AssetViewerPanel } = await import('/asset-viewer.js');
      const bytes = new Uint8Array(value.bytes), fields = value.headers, reports = [];
      const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 2)); } throw new Error('Bounded DOM fixture did not settle'); };
      for (const stage of ['import', 'create']) for (const reason of ['clear', 'callback']) {
        let done, reached = false, active = true, creates = 0, disposed = 0;
        const held = new Promise(resolve => { done = resolve; });
        const create = async ({ host }) => { creates++; reached = true; const canvas = document.createElement('canvas'); host.append(canvas); return held; };
        const panel = new AssetViewerPanel(document, TOKEN, { deadlineMs: 500,
          transport: async () => new Response(bytes, { headers: fields }),
          loadRuntime: async () => { if (stage === 'import') { reached = true; return held; } return { createAssetViewer: create }; },
        });
        const pending = panel.show(value.manifest, JOB, () => active); await wait(() => reached);
        if (reason === 'clear') panel.clear(); else active = false;
        if (stage === 'import') done({ createAssetViewer: create });
        else done({ dispose() { disposed++; document.querySelectorAll('#asset-viewer canvas').forEach(canvas => canvas.remove()); } });
        await pending; if (stage === 'create') await wait(() => disposed === 1);
        reports.push({ stage, reason, creates, disposed, canvases: document.querySelectorAll('#asset-viewer canvas').length }); panel.clear();
      }
      return reports;
    }, { value: { bytes: [...glb()], headers: artifactHeaders(glb()), manifest: manifest() }, JOB, TOKEN });
    for (const result of results) { assert.equal(result.canvases, 0); assert.equal(result.creates, result.stage === 'create' ? 1 : 0); assert.equal(result.disposed, result.stage === 'create' ? 1 : 0); }
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []);
    proof.checks.push({ name: 'DOM stale asynchronous operations', results, contexts: await page.evaluate(() => viewerMeter.contexts) });
  });

  await t.test('optional real SwiftShader renderer proves source metres, embedded texture and disposal', { skip: process.env.ARCANE_VIEWER_PRODUCT_GPU !== '1' }, async t => {
    const f = await fixture(browser, t, assets, emit, { gpu: true }), { page } = f;
    await startProduct(page);
    assert.equal(f.network.filter(path => path.startsWith('/v1/')).length, 0);
    assert.equal(f.network.includes('/asset-viewer-runtime.mjs'), false);
    assert.equal(await page.evaluate(() => viewerMeter.contexts), 0);
    await page.locator('#asset-load-manifest').click();
    const canvas = page.locator('#asset-viewer canvas[role="img"]'); await canvas.waitFor();
    await page.waitForFunction(() => !workbench.assetBusy && document.querySelector('#asset-viewer canvas').width > 0);
    assert.deepEqual(f.network.filter(path => path.startsWith('/v1/')), [
      '/v1/assets/manifest?jobId=' + JOB, '/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb', '/v1/assets/review/prepare',
    ]);
    assert.match(await page.locator('.viewer-metrics').textContent(), /4\.00 × 2\.00 × 1\.00 m/);
    const rendered = await canvas.screenshot(), pixels = visiblePixels(rendered);
    assert.ok(pixels.modelPixels > 5000, 'visible model pixels: ' + JSON.stringify(pixels));
    assert.ok(pixels.distinctColors > 30, 'shaded texture, not an empty canvas');
    await viewerControl.view(page, 'front');
    await viewerControl.mode(page, 'wireframe');
    const wireframe = await canvas.screenshot(); assert.notDeepEqual(wireframe, rendered);
    const metrics = await page.locator('.viewer-metrics').textContent(); assert.match(metrics, /4\.00 × 2\.00 × 1\.00 m/);
    await page.evaluate(() => { window.contexts = [...document.querySelectorAll('#asset-viewer canvas')].map(canvas => canvas.getContext('webgl2')); shell.cleanup(); workbench.stop(); });
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    assert.equal(await page.evaluate(() => contexts.every(context => context.isContextLost())), true);
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []);
    if (proofDir) { await writeFile(resolve(proofDir, 'product-rendered.png'), rendered); await writeFile(resolve(proofDir, 'product-wireframe.png'), wireframe); }
    proof.checks.push({ name: 'real manifest click / authenticated SHA + preflight / Three/SwiftShader / embedded PNG / source metres / disposal', pixels, artifactRequests: f.network.filter(path => path.startsWith('/v1/')), runtimeRequests: f.network.filter(path => path.startsWith('/vendor/') || path === '/asset-viewer-runtime.mjs'), contexts: await page.evaluate(() => viewerMeter.contexts), cspViolations: 0, screenshots: proofDir ? ['product-rendered.png', 'product-wireframe.png'] : [] });
  });

  await t.test('optional retained real Blender bytes over controlled HTTP fixture under production CSP', { skip: !process.env.ARCANE_VIEWER_PRODUCT_ASSET }, async t => {
    const assetPath = resolve(process.env.ARCANE_VIEWER_PRODUCT_ASSET);
    assert.equal(assetPath, resolve(root, retainedAsset), 'Read only the explicitly authorized retained GLB');
    const bytes = await readFile(assetPath);
    assert.equal(bytes.length, 70_116); assert.equal(checksum(bytes), RETAINED_SHA);
    const recorded = JSON.parse(await readFile(resolve(dirname(assetPath), 'manifest.json'), 'utf8'));
    assert.equal(recorded.jobId, RETAINED_JOB);
    const row = recorded.artifacts.find(row => row.path === 'asset.glb');
    assert.ok(row); assert.equal(row.role, 'export'); assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, RETAINED_SHA);
    // Serve just the recorded selected GLB descriptor. Preview PNGs and other
    // retained files are outside this optional controlled HTTP evidence.
    const value = { jobId: recorded.jobId, request: recorded.request, artifacts: [row] };
    const f = await fixture(browser, t, assets, emit, { gpu: true }), { page } = f;
    f.select(bytes, value); await startProduct(page, RETAINED_JOB, recorded.request);
    assert.equal(f.network.filter(path => path.startsWith('/v1/')).length, 0);
    assert.equal(await page.evaluate(() => viewerMeter.contexts), 0);
    await page.locator('#asset-load-manifest').click();
    const canvas = page.locator('#asset-viewer canvas[role="img"]'); await canvas.waitFor();
    await page.waitForFunction(() => !workbench.assetBusy && document.querySelector('#asset-viewer canvas').width > 0);
    assert.deepEqual(f.network.filter(path => path.startsWith('/v1/')), [
      '/v1/assets/manifest?jobId=' + RETAINED_JOB, '/v1/assets/artifact?jobId=' + RETAINED_JOB + '&path=asset.glb', '/v1/assets/review/prepare',
    ]);
    const rendered = await canvas.screenshot(), pixels = visiblePixels(rendered);
    assert.ok(pixels.modelPixels > 5000, 'retained model has visible geometry: ' + JSON.stringify(pixels));
    assert.ok(pixels.distinctColors > 30);
    const dimensions = await page.locator('.viewer-metrics').textContent(); assert.match(dimensions, / m · /);
    await viewerControl.view(page, 'front');
    await viewerControl.mode(page, 'wireframe');
    await viewerControl.lighting(page, 'soft');
    const wireframe = await canvas.screenshot(); assert.notDeepEqual(wireframe, rendered);
    assert.equal(await page.locator('.viewer-metrics').textContent(), dimensions);
    await page.evaluate(() => { window.contexts = [...document.querySelectorAll('#asset-viewer canvas')].map(canvas => canvas.getContext('webgl2')); shell.cleanup(); workbench.stop(); });
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    assert.equal(await page.evaluate(() => contexts.every(context => context.isContextLost())), true);
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []); assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []);
    if (proofDir) { await writeFile(resolve(proofDir, 'retained-blender-rendered.png'), rendered); await writeFile(resolve(proofDir, 'retained-blender-wireframe.png'), wireframe); }
    proof.checks.push({ name: 'retained real Blender bytes over controlled HTTP fixture; not live Studio or full native chain', jobId: RETAINED_JOB,
      byteLength: bytes.length, sha256: RETAINED_SHA, pixels, sourceDimensionsAndTriangles: dimensions, cspViolations: 0,
      artifactRequests: f.network.filter(path => path.startsWith('/v1/')), runtimeRequests: f.network.filter(path => path.startsWith('/vendor/') || path === '/asset-viewer-runtime.mjs'),
      screenshots: proofDir ? ['retained-blender-rendered.png', 'retained-blender-wireframe.png'] : [] });
  });
  if (proofDir) await writeFile(resolve(proofDir, 'asset-viewer-product-proof.json'), JSON.stringify(proof, null, 2));
  t.diagnostic(JSON.stringify(proof));
});

// Decode only owned browser screenshots to distinguish visible shaded geometry
// from the canvas background. This is optional GPU evidence, not DOM evidence.
function visiblePixels(png) {
  const parts = []; let at = 8, width, height, channels;
  while (at < png.length) { const length = png.readUInt32BE(at), name = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length); if (name === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : 3; assert.ok([2, 6].includes(data[9])); } if (name === 'IDAT') parts.push(data); at += length + 12; }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) { const i = y * stride + x, left = x >= channels ? pixels[i - channels] : 0, up = y ? pixels[i - stride] : 0, diagonal = y && x >= channels ? pixels[i - stride - channels] : 0; const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, diagonal)][raw[y * (stride + 1)]]; assert.notEqual(predictor, undefined); pixels[i] = (raw[y * (stride + 1) + x + 1] + predictor) & 255; }
  const background = [...pixels.subarray(0, 3)], colors = new Set(); let modelPixels = 0;
  for (let i = 0; i < pixels.length; i += channels) { const color = [...pixels.subarray(i, i + 3)]; if (color.some((value, channel) => Math.abs(value - background[channel]) > 15)) { modelPixels++; colors.add(color.join(',')); } }
  return { width, height, modelPixels, distinctColors: colors.size };
}
