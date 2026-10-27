import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { BoxGeometry } from 'three';

// Opt-in: ARCANE_AUTOMATIC_ASSET_EMIT=<parent's private explicit tsc emit>.
// Optional ARCANE_AUTOMATIC_ASSET_PROOF_DIR and ARCANE_AUTOMATIC_ASSET_BROWSER.
// Actual production HTML/CSS/CSP and emitted controllers/runtime, nonpersistent
// Edge/SwiftShader. Every HTTP response is synthetic and routed in memory.
// No daemon, native provider, Studio credential, paid inference or root build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const emitPath = process.env.ARCANE_AUTOMATIC_ASSET_EMIT ?? process.env.ARCANE_VIEWER_PRODUCT_EMIT;
const origin = 'http://127.0.0.1:18752'; // No process listens here.
const TOKEN = 'a'.repeat(64), PATH = 'C:\\owned-fixture\\automatic-assets', PROJECT = 'b'.repeat(64);
const NATIVE = { provider: 'codex', threadId: 'fixture-thread', sessionId: 'fixture-session' };
const OLD = '11111111-1111-4111-8111-111111111111', LIVE = '22222222-2222-4222-8222-222222222222', FRESH = '33333333-3333-4333-8333-333333333333';
const vendorPaths = [
  '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
  '/vendor/three/examples/jsm/loaders/GLTFLoader.js', '/vendor/three/examples/jsm/controls/OrbitControls.js',
  '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three/examples/jsm/utils/SkeletonUtils.js',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function glb() {
  const geometry = new BoxGeometry(2, 1, .5).toNonIndexed(), chunks = [], views = [], accessors = [];
  let length = 0;
  const accessor = (attribute, extra = {}) => {
    const bytes = Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength), index = accessors.length;
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: attribute.count, type: 'VEC3', ...extra });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4); chunks.push(bytes, padding); length += bytes.length + padding.length; return index;
  };
  const position = accessor(geometry.attributes.position, { min: [-1, -.5, -.25], max: [1, .5, .25] }), normal = accessor(geometry.attributes.normal);
  const doc = { asset: { version: '2.0', generator: 'Arcane owned automatic preview fixture' },
    buffers: [{ byteLength: length }], bufferViews: views, accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.75, .23, .08, 1], roughnessFactor: .6, metallicFactor: .1 } }],
    nodes: [{ mesh: 0, scale: [2, 2, 2] }], scenes: [{ nodes: [0] }], scene: 0 };
  const json = Buffer.from(JSON.stringify(doc)), size = Math.ceil(json.length / 4) * 4, bytes = Buffer.alloc(28 + size + length);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(size, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(0x20, 20, 20 + size); json.copy(bytes, 20);
  bytes.writeUInt32LE(length, 20 + size); bytes.writeUInt32LE(0x004e4942, 24 + size); Buffer.concat(chunks).copy(bytes, 28 + size); geometry.dispose(); return bytes;
}
function job(id = LIVE, state = 'running', time = '2026-10-14T10:01:00.000Z', manifestAvailable = state === 'succeeded') {
  return { schemaVersion: 1, jobId: id, directory: PATH + '\\assets\\' + id, manifestPath: null,
    request: { schemaVersion: 1, template: 'hero-prop', name: 'fixture-' + id.slice(0, 8), seed: 1, sizeMeters: [1, .65, .7], color: [.12, .32, .27], triangleBudget: 5000, renderResolution: 384, renderSamples: 16 },
    state, stage: state === 'running' ? 'modeling' : 'complete', startedAt: time, updatedAt: time, events: [], manifestAvailable, error: null };
}
const historical = () => job(OLD, 'succeeded', '2026-10-14T10:00:00.000Z');
function pageReply(jobs = [], nextCursor = null) { return { projectId: PROJECT, projectPath: PATH, conversation: { ...NATIVE }, jobs, nextCursor, byteLimit: 512 * 1024 }; }
const manifest = (bytes, item) => ({ schemaVersion: 1, jobId: item.jobId, request: item.request, artifacts: [{ path: 'asset.glb', role: 'export', bytes: bytes.length, sha256: sha(bytes) }] });
const artifactHeaders = bytes => ({ 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), 'Content-Disposition': 'attachment; filename="fixture-asset-asset.glb"' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function sources(emit) {
  const sourceHashes = {};
  for (const name of ['studio', 'workspace-shell', 'automatic-asset-previews']) {
    const current = await readFile(resolve(root, 'apps/desktop/src', name + '.ts'), 'utf8');
    const map = JSON.parse(await readFile(resolve(emit, 'apps/desktop/src', name + '.js.map'), 'utf8'));
    assert.ok(map.sourcesContent?.includes(current), name + ' private emit must match the current frozen source');
    sourceHashes[name] = sha(Buffer.from(current));
  }
  const server = await readFile(resolve(root, 'apps/daemon/src/lab-server.ts'), 'utf8');
  const policy = /setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(server)?.[1]; assert.ok(policy, 'actual production CSP');
  // The shipped faces (studio.css @font-face, same-origin /fonts) are part of the product page.
  const fonts = (await readdir(resolve(root, 'apps/desktop/public/fonts'))).filter(name => name.endsWith('.woff2')).map(name => '/fonts/' + name);
  const paths = ['/studio.css', '/asset-viewer-runtime.mjs', ...vendorPaths, ...fonts];
  const files = new Map(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, 'apps/desktop/public', '.' + path))])));
  for (const name of ['failure-diagnostics', 'types', 'probe-diagnostics']) {
    files.set('/packages/asset-pipeline/src/' + name + '.js', await readFile(resolve(emit, 'packages/asset-pipeline/src', name + '.js')));
  }
  const html = (await readFile(resolve(root, 'apps/desktop/public/studio.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.match(html, /id="chat-assets"/); files.set('/', html);
  // Suppress only page bootstrap; actual exported controller wiring remains.
  const source = await readFile(resolve(emit, 'apps/desktop/src/studio.js'), 'utf8');
  const startup = source.indexOf("if (typeof window !== 'undefined' && typeof document !== 'undefined')");
  assert.ok(startup > 0); files.set('/studio.js', source.slice(0, startup)); return { files, policy, sourceHashes };
}
async function fixture(browser, t, assets, emit, signedIn = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); t.after(() => context.close());
  const page = await context.newPage(), calls = [], reviews = [], forbidden = [], errors = [], jobs = new Map();
  page.setDefaultTimeout(10_000);
  let reply = pageReply(), bytes = glb(), delivered = bytes, manifestStatus = 200, manifestGate = null, artifactGate = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname + url.search;
    if (url.origin !== origin) { forbidden.push(path); await route.abort(); return; }
    // The viewer's review card asks the review service to prepare the exact verified job (human bearer); it is recorded
    // apart from the asset reads, and this fixture has no review service.
    if (url.pathname === '/v1/assets/review/prepare') {
      reviews.push({ method: request.method(), authorization: request.headers().authorization, jobId: JSON.parse(request.postData() ?? '{}').jobId });
      await route.fulfill({ status: 503, json: { error: 'FIXTURE', message: 'No review service in this fixture.' } }); return;
    }
    if (url.pathname.startsWith('/v1/')) {
      calls.push({ path, method: request.method(), authorization: request.headers().authorization });
      assert.equal(request.method(), 'GET', 'automatic flow never mutates'); assert.equal(request.headers().authorization, 'Bearer ' + TOKEN);
      if (url.pathname === '/v1/assets/conversation-jobs' || url.pathname === '/v1/assets/jobs') { await route.fulfill({ json: reply }); return; }
      if (url.pathname === '/v1/assets/manifest') {
        const item = jobs.get(url.searchParams.get('jobId')); assert.ok(item, 'exact returned job is requested');
        if (manifestGate) await manifestGate;
        await route.fulfill({ status: manifestStatus, json: manifestStatus === 200 ? { manifest: manifest(bytes, item) } : { error: 'FIXTURE_FAILURE', message: 'Synthetic manifest read failure' } }); return;
      }
      if (url.pathname === '/v1/assets/artifact') {
        assert.ok(jobs.has(url.searchParams.get('jobId'))); assert.equal(url.searchParams.get('path'), 'asset.glb');
        if (artifactGate) await artifactGate;
        await route.fulfill({ body: delivered, headers: artifactHeaders(bytes) }); return;
      }
      forbidden.push(path); await route.abort(); return;
    }
    if (assets.files.has(url.pathname)) { await route.fulfill({ contentType: url.pathname === '/' ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: assets.files.get(url.pathname), headers: { 'Content-Security-Policy': assets.policy } }); return; }
    if (/^\/[a-z][a-z0-9-]*\.js$/.test(url.pathname)) { await route.fulfill({ contentType: 'text/javascript', body: await readFile(resolve(emit, 'apps/desktop/src', url.pathname.slice(1))) }); return; }
    forbidden.push(path); await route.abort();
  });
  await page.addInitScript(() => {
    window.fixtureCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => fixtureCspViolations.push(event.effectiveDirective));
  });
  await page.goto(origin);
  await page.evaluate(async ({ TOKEN, PATH, NATIVE, signedIn }) => {
    window.gpuMeter = { contexts: 0, canvases: [] };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { if (kind === 'webgl' || kind === 'webgl2') { gpuMeter.contexts++; gpuMeter.canvases.push(this); } return getContext.call(this, kind, ...args); };
    window.fixtureNative = { ...NATIVE, projectPath: PATH }; window.fixtureProject = PATH; window.fixtureListeners = new Set();
    window.fixtureSignedIn = signedIn; window.fixtureSignInListeners = new Set();
    // Provider bootstrap is suppressed with page startup. Project the same
    // synthetic sign-in presentation as the supplied trusted fixture callback.
    document.getElementById('workspace-stage').classList.toggle('provider-required', !signedIn);
    document.getElementById('provider-login-gate').hidden = signedIn;
    const { StudioWorkbench, StudioApi } = await import('/studio.js'), { startWorkspaceShell } = await import('/workspace-shell.js');
    window.workbench = new StudioWorkbench(document, new StudioApi(TOKEN), location.origin, TOKEN, {
      getProjectPath: () => fixtureProject, getNativeConversation: () => fixtureNative,
      subscribeContextChange: fn => { fixtureListeners.add(fn); return () => fixtureListeners.delete(fn); },
      isSignedIn: () => fixtureSignedIn,
      subscribeSignInChange: fn => { fixtureSignInListeners.add(fn); return () => fixtureSignInListeners.delete(fn); },
    });
    workbench.refresh = async () => {}; workbench.schedule = () => {}; await workbench.start();
    document.getElementById('codex-messages').textContent = 'Recorded public native fixture conversation';
    document.getElementById('codex-notice').textContent = 'Synthetic connected conversation';
    window.shell = startWorkspaceShell(document);
    window.clickMeter = { manifest: 0, picker: 0, tool: 0 };
    document.getElementById('asset-load-manifest').addEventListener('click', () => clickMeter.manifest++);
    document.getElementById('asset-job-picker').addEventListener('change', () => clickMeter.picker++);
    document.querySelectorAll('[data-workspace-tool]').forEach(button => button.addEventListener('click', () => clickMeter.tool++));
  }, { TOKEN, PATH, NATIVE, signedIn });
  const setReply = value => { reply = value; for (const item of value.jobs ?? []) jobs.set(item.jobId, item); };
  return { page, calls, forbidden, errors,
    setReply,
    async poll(value, more = false) { setReply(value); await page.evaluate(async more => { await workbench.refreshAssets(more); await new Promise(resolve => setTimeout(resolve, 0)); }, more); },
    async change(next, project = PATH, nativeProject = project) { await page.evaluate(({ next, project, nativeProject }) => { fixtureProject = project; fixtureNative = next ? { ...next, projectPath: nativeProject } : null; for (const fn of fixtureListeners) fn(); }, { next, project, nativeProject }); },
    async signIn(value) { await page.evaluate(value => {
      fixtureSignedIn = value;
      document.getElementById('workspace-stage').classList.toggle('provider-required', !value);
      document.getElementById('provider-login-gate').hidden = value;
      for (const fn of fixtureSignInListeners) fn();
    }, value); },
    async idle() { await page.waitForFunction(() => !workbench.assetBusy); },
    async routed(path) {
      for (let n = 0; n < 200; n++) {
        if (calls.some(call => new URL(call.path, origin).pathname === path)) return;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert.fail('fixture route not observed: ' + path);
    },
    manifestCalls() { return calls.filter(call => call.path.startsWith('/v1/assets/manifest?')); },
    modelCalls() { return calls.filter(call => /\/v1\/assets\/(?:manifest|artifact)\?/.test(call.path)).map(call => call.path); },
    holdManifest(gate) { manifestGate = gate; }, failManifest() { manifestStatus = 503; },
    holdArtifact(gate) { artifactGate = gate; },
    corruptArtifact() { delivered = Buffer.from(bytes); delivered[delivered.indexOf('Arcane')] = 66; },
    async clean() { for (const review of reviews) { assert.equal(review.method, 'POST'); assert.equal(review.authorization, 'Bearer ' + TOKEN); assert.ok(jobs.has(review.jobId), 'review prepares only a returned job'); }
      assert.deepEqual(forbidden, []); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => fixtureCspViolations), []); assert.ok(calls.every(call => call.method === 'GET')); },
  };
}
const card = (page, id) => page.locator('#chat-assets .chat-asset-card[data-job-id="' + id + '"]');
async function rendered(f) {
  await f.page.locator('#asset-viewer canvas[role="img"]').waitFor(); await f.idle();
  await f.page.waitForFunction(() => document.querySelector('#asset-viewer canvas')?.width > 0);
}
const exact = id => ['/v1/assets/manifest?jobId=' + id, '/v1/assets/artifact?jobId=' + id + '&path=asset.glb'];

test('automatic asset flow through production controllers and real Edge software WebGL', { skip: !emitPath, timeout: 180_000 }, async t => {
  const emit = resolve(emitPath), assets = await sources(emit);
  const browser = await chromium.launch({ executablePath: process.env.ARCANE_AUTOMATIC_ASSET_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'] }); t.after(() => browser.close());
  const proofDir = process.env.ARCANE_AUTOMATIC_ASSET_PROOF_DIR ? resolve(process.env.ARCANE_AUTOMATIC_ASSET_PROOF_DIR) : null;
  if (proofDir) await mkdir(proofDir, { recursive: true });
  const proof = { fixture: 'production HTML/CSS/CSP + private controllers + real Three/SwiftShader; synthetic matched metadata and authenticated owned GLB; no native provider/Studio/full generation chain', browser: await browser.version(), productionCsp: assets.policy, sourceHashes: assets.sourceHashes, emit, checks: [] };

  await t.test('initial completed card; running auto-opens Building; ready automatically verifies/renders exactly once', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    await f.poll(pageReply([historical()])); await card(page, OLD).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#chat-assets').evaluate(node => !!node.closest('#codex-messages')), false);
    assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), 'false'); assert.deepEqual(f.modelCalls(), []);
    assert.equal(await page.evaluate(() => gpuMeter.contexts), 0);
    await f.poll(pageReply([job(), historical()]));
    assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), 'true');
    assert.match(await card(page, LIVE).textContent(), /Building/);
    assert.match(await page.locator('#artifact-stage').textContent(), /Building|building/); assert.deepEqual(f.modelCalls(), []);
    if (proofDir) await page.screenshot({ path: resolve(proofDir, 'automatic-building.png') });
    await f.poll(pageReply([job(LIVE, 'succeeded', undefined, false), historical()])); assert.deepEqual(f.modelCalls(), []);
    await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await rendered(f);
    for (let n = 0; n < 3; n++) await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
    assert.deepEqual(f.modelCalls(), exact(LIVE)); assert.equal(await page.locator('#asset-viewer canvas').count(), 1);
    assert.equal(await page.evaluate(() => gpuMeter.contexts), 1, 'one renderer/GPU allocation over repeated polls');
    assert.deepEqual(await page.evaluate(() => clickMeter), { manifest: 0, picker: 0, tool: 0 });
    assert.equal(await page.locator('#codex-messages').textContent(), 'Recorded public native fixture conversation');
    assert.match(await page.locator('.viewer-metrics').textContent(), /4\.00 × 2\.00 × 1\.00 m/);
    assert.match(await page.locator('.viewer-status').textContent(), /^Drag to orbit/);
    assert.equal(await page.locator('#artifact-files').isVisible(), false);
    await page.locator('#preview-files-tab').click();
    assert.equal(await page.locator('#artifact-stage').isVisible(), false);
    assert.equal(await page.locator('#artifact-files').isVisible(), true);
    assert.equal(await page.locator('#preview-files-tab').getAttribute('aria-selected'), 'true');
    const readsBeforeTabs = f.modelCalls().length;
    await page.locator('#preview-files-tab').press('ArrowLeft');
    assert.equal(await page.locator('#artifact-stage').isVisible(), true);
    assert.equal(await page.locator('#artifact-files').isVisible(), false);
    assert.equal(await page.locator('#preview-model-tab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#preview-model-tab').evaluate(node => node === document.activeElement), true);
    assert.equal(f.modelCalls().length, readsBeforeTabs, 'tabs allocate no additional model requests');

    const image = await page.locator('#asset-viewer canvas').screenshot(), pixels = visiblePixels(image);
    assert.ok(pixels.modelPixels > 5000, JSON.stringify(pixels)); assert.ok(pixels.distinctColors > 30, JSON.stringify(pixels));
    if (proofDir) { await writeFile(resolve(proofDir, 'automatic-model.png'), image); await page.screenshot({ path: resolve(proofDir, 'automatic-ready.png') }); }
    await page.evaluate(() => { shell.cleanup(); workbench.stop(); });
    assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    assert.equal(await page.evaluate(() => gpuMeter.canvases.every(canvas => canvas.getContext('webgl2').isContextLost())), true);
    await f.clean(); proof.checks.push({ name: 'automatic running-to-ready, no manual input, exact authenticated GETs, one GPU, visible geometry, disposal', requests: f.modelCalls(), pixels });
  });

  await t.test('new instant completion auto-loads after baseline; pagination/backfill/global never does', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    await f.poll(pageReply([historical()], 'older:page'));
    await f.poll(pageReply([job(LIVE, 'running', '2026-10-14T09:00:00.000Z')]), true);
    await f.poll(pageReply([job(LIVE, 'succeeded', '2026-10-14T09:00:00.000Z'), historical()]));
    assert.deepEqual(f.modelCalls(), []); assert.equal(await page.evaluate(() => gpuMeter.contexts), 0);
    await f.poll(pageReply([job(FRESH, 'succeeded', '2026-10-14T10:02:00.000Z'), historical()])); await rendered(f); assert.deepEqual(f.modelCalls(), exact(FRESH));
    // Switch the actual product control through its event wiring, leaving it
    // inside the settings drawer; this is deliberate global inspection.
    f.setReply({ schemaVersion: 1, jobs: [job(), historical()], total: 2, nextCursor: null, byteLimit: 512 * 1024 });
    await page.locator('#asset-history-scope').evaluate(node => { node.value = 'global'; node.dispatchEvent(new Event('change')); });
    await f.poll({ schemaVersion: 1, jobs: [job(LIVE, 'succeeded'), historical()], total: 2, nextCursor: null, byteLimit: 512 * 1024 });
    assert.deepEqual(f.modelCalls(), exact(FRESH)); assert.equal(await page.locator('#chat-assets .chat-asset-card').count(), 0);
    await f.clean(); proof.checks.push({ name: 'baseline/older pagination/global exclusions and new instant completion', requests: f.modelCalls() });
  });

  await t.test('manual card View mutes known pending jobs and future fresh work still auto-loads', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    await f.poll(pageReply([job(), historical()]));
    await card(page, OLD).getByRole('button', { name: /^View / }).click(); await rendered(f); assert.deepEqual(f.modelCalls(), exact(OLD));
    await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); assert.deepEqual(f.modelCalls(), exact(OLD));
    assert.equal(await page.evaluate(() => workbench.assetJobId), OLD);
    await f.poll(pageReply([job(FRESH, 'succeeded', '2026-10-14T10:02:00.000Z'), job(LIVE, 'succeeded'), historical()])); await rendered(f);
    assert.deepEqual(f.modelCalls(), [...exact(OLD), ...exact(FRESH)]); assert.equal(await page.evaluate(() => gpuMeter.contexts), 2);
    await f.clean(); proof.checks.push({ name: 'actual manual card View / mute known pending / future fresh auto', requests: f.modelCalls() });
  });

  await t.test('manual close stays closed after the same running job succeeds and is polled again', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f;
    await f.poll(pageReply([job(), historical()])); assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await f.idle();
    for (let n = 0; n < 2; n++) await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
    assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), 'false'); assert.deepEqual(f.modelCalls(), exact(LIVE));
    await f.clean(); proof.checks.push({ name: 'actual Close preview remains closed on same-job completion/polls', requests: f.modelCalls() });
  });

  await t.test('context switch away and back clears cards, aborts stale manifest and requires a new baseline', async t => {
    const f = await fixture(browser, t, assets, emit), { page } = f, gate = deferred(); t.after(() => gate.resolve());
    await f.poll(pageReply([job(), historical()])); f.holdManifest(gate.promise);
    await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
    await page.waitForFunction(() => workbench.assetBusy); assert.equal(f.manifestCalls().length, 1);
    // Preserve one actual detached card button to prove stale event fencing.
    await page.evaluate(() => { window.staleCardButton = document.querySelector('#chat-assets button'); });
    f.setReply(pageReply([])); await f.change({ ...NATIVE, threadId: 'other-thread' });
    assert.equal(await page.locator('#chat-assets .chat-asset-card').count(), 0); assert.equal(await page.locator('#asset-viewer canvas').count(), 0);
    await f.change(NATIVE); gate.resolve(); await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await f.idle();
    await page.evaluate(() => { staleCardButton.disabled = false; staleCardButton.click(); });
    assert.equal(await page.evaluate(() => workbench.assetJobId), ''); assert.equal(f.manifestCalls().length, 1); assert.equal(await page.evaluate(() => gpuMeter.contexts), 0);
    await f.clean(); proof.checks.push({ name: 'A/B/A + delayed manifest + detached card event fences', requests: f.modelCalls() });
  });

  await t.test('mismatched project/provider/thread/session receipts never auto-select, read or allocate', async t => {
    for (const changes of [{ projectPath: PATH.toLowerCase() }, { conversation: { ...NATIVE, provider: 'claude-code' } }, { conversation: { ...NATIVE, threadId: 'other' } }, { conversation: { ...NATIVE, sessionId: 'other' } }, { conversation: { ...NATIVE, sessionId: null } }]) {
      const f = await fixture(browser, t, assets, emit); await f.poll({ ...pageReply([job()]), ...changes });
      assert.deepEqual(f.modelCalls(), []); assert.equal(await f.page.locator('#chat-assets .chat-asset-card').count(), 0); assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 0); await f.clean();
    }
    proof.checks.push({ name: 'foreign project/provider/thread/session/null-session exclusions', rejected: 5 });
  });

  await t.test('manifest errors and SHA mismatch are single attempts with no GPU or mutations', async t => {
    for (const failure of ['manifest', 'checksum']) {
      const f = await fixture(browser, t, assets, emit); await f.poll(pageReply([job(), historical()]));
      if (failure === 'manifest') f.failManifest(); else f.corruptArtifact();
      await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await f.idle();
      for (let n = 0; n < 3; n++) await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
      assert.equal(f.manifestCalls().length, 1); assert.deepEqual(f.modelCalls(), failure === 'manifest' ? exact(LIVE).slice(0, 1) : exact(LIVE));
      assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 0); assert.equal(await f.page.locator('#asset-viewer canvas').count(), 0); await f.clean();
      proof.checks.push({ name: failure + ' rejects without mutation/retry/GPU', requests: f.modelCalls() });
    }
  });

  await t.test('cached native conversation while signed out causes no asset HTTP or GPU work', async t => {
    const f = await fixture(browser, t, assets, emit, false);
    await f.poll(pageReply([job(), historical()])); await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
    assert.deepEqual(f.calls, []); assert.equal(await f.page.locator('#chat-assets .chat-asset-card').count(), 0);
    assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 0); await f.clean();
    proof.checks.push({ name: 'signed-out cached native metadata makes zero asset requests/GPU allocations', requests: [] });
  });

  await t.test('sign-in callback auth loss fences late manifest and artifact reads, and return establishes baseline', async t => {
    for (const stage of ['manifest', 'artifact']) {
      const f = await fixture(browser, t, assets, emit), gate = deferred(); t.after(() => gate.resolve());
      await f.poll(pageReply([job(), historical()]));
      if (stage === 'manifest') f.holdManifest(gate.promise); else f.holdArtifact(gate.promise);
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === '/v1/assets/' + stage);
      await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await requested;
      // Browser request events precede the route handler. Count the already
      // admitted held read before changing auth, rather than mistaking it for
      // a new read after sign-out.
      await f.routed('/v1/assets/' + stage);
      const before = f.calls.length; await f.signIn(false);
      assert.equal(await f.page.locator('#chat-assets .chat-asset-card').count(), 0); assert.equal(await f.page.locator('#asset-viewer canvas').count(), 0);
      gate.resolve(); await f.idle(); await f.poll(pageReply([job(LIVE, 'succeeded'), historical()]));
      assert.equal(f.calls.length, before, 'auth loss cannot trigger another read'); assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 0);
      await f.signIn(true); await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await f.idle();
      assert.deepEqual(f.modelCalls(), stage === 'manifest' ? exact(LIVE).slice(0, 1) : exact(LIVE));
      assert.equal(await f.page.evaluate(() => workbench.assetJobId), ''); assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 0);
      await f.clean(); proof.checks.push({ name: 'callback auth loss during ' + stage + ' read; stale response fenced; reauth baseline', requests: f.modelCalls() });
    }
  });

  await t.test('auth loss immediately disposes an active real renderer and clears cards', async t => {
    const f = await fixture(browser, t, assets, emit); await f.poll(pageReply([job(), historical()]));
    await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); await rendered(f); assert.equal(await f.page.evaluate(() => gpuMeter.contexts), 1);
    await f.signIn(false); assert.equal(await f.page.locator('#asset-viewer canvas').count(), 0); assert.equal(await f.page.locator('#chat-assets .chat-asset-card').count(), 0);
    assert.equal(await f.page.evaluate(() => gpuMeter.canvases.every(canvas => canvas.getContext('webgl2').isContextLost())), true);
    const before = f.calls.length; await f.poll(pageReply([job(LIVE, 'succeeded'), historical()])); assert.equal(f.calls.length, before);
    await f.clean(); proof.checks.push({ name: 'callback auth loss disposes real GPU and blocks subsequent reads', requests: f.modelCalls() });
  });
  assert.equal(proof.checks.length, 12, 'save browser proof only after every scenario completed its assertions');
  proof.completedAt = new Date().toISOString();
  if (proofDir) await writeFile(resolve(proofDir, 'automatic-asset-preview-proof.json'), JSON.stringify(proof, null, 2));
  t.diagnostic(JSON.stringify(proof));
});

// Inspect only owned screenshots to reject an empty canvas as rendering proof.
function visiblePixels(png) {
  const parts = []; let at = 8, width, height, channels;
  while (at < png.length) { const length = png.readUInt32BE(at), name = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length); if (name === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : 3; assert.ok([2, 6].includes(data[9])); } if (name === 'IDAT') parts.push(data); at += length + 12; }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) { const i = y * stride + x, left = x >= channels ? pixels[i - channels] : 0, up = y ? pixels[i - stride] : 0, diagonal = y && x >= channels ? pixels[i - stride - channels] : 0; const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, diagonal)][raw[y * (stride + 1)]]; assert.notEqual(predictor, undefined); pixels[i] = (raw[y * (stride + 1) + x + 1] + predictor) & 255; }
  const colors = new Set(); let modelPixels = 0;
  // The owned GLB material is orange; the real runtime's floor/grid/background
  // are neutral. Count material pixels rather than background gradients.
  for (let i = 0; i < pixels.length; i += channels) { const color = [...pixels.subarray(i, i + 3)]; if (color[0] > 50 && color[0] > color[1] * 1.3 && color[0] > color[2] * 1.5) { modelPixels++; colors.add(color.join(',')); } }
  return { width, height, modelPixels, distinctColors: colors.size };
}
