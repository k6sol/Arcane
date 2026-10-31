import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const enabled = !!process.env.ARCANE_UI_MODULE_ROOT;
const JOB = '11111111-1111-4111-8111-111111111111', NEXT = '33333333-3333-4333-8333-333333333333';
const THIRD = '44444444-4444-4444-8444-444444444444', WRONG = '55555555-5555-4555-8555-555555555555';
const OLD = '66666666-6666-4666-8666-666666666666', LATEST = '77777777-7777-4777-8777-777777777777';
const WITNESS = '88888888-8888-4888-8888-888888888888';
const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const canonical = (v: any): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ?
  '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function glb(): Buffer {
  const binary = Buffer.from(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer);
  const doc = { asset: { version: '2.0', generator: 'Arcane owned browser fixture' }, buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const text = Buffer.from(JSON.stringify(doc)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(json);
  const out = Buffer.alloc(28 + json.length + binary.length); out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20); out.writeUInt32LE(binary.length, 20 + json.length);
  out.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(out, 28 + json.length); return out;
}
const FIXTURE = String.raw`
import {AssetViewerPanel} from '/modules/apps/desktop/src/asset-viewer.js';
const JOB='11111111-1111-4111-8111-111111111111',hash='__HASH__',size=__SIZE__;
let epoch=0,runtimeCalls=0,releaseRuntime;
const calls=[],transport=(path,init)=>{calls.push({path:String(path),body:init?.body,signal:init?.signal});return fetch(path,init);};
const runtime={createAssetViewer:async({host})=>{
  runtimeCalls++;if(location.hash==='#hold'&&runtimeCalls===1)await new Promise(done=>{releaseRuntime=done;});
  const canvas=document.createElement('canvas');canvas.width=500;canvas.height=220;host.append(canvas);
  const c=canvas.getContext('2d');c.fillStyle='#172237';c.fillRect(0,0,500,220);c.fillStyle='#87c7b0';c.beginPath();c.moveTo(150,160);c.lineTo(330,160);c.lineTo(220,45);c.fill();
  return {reset(){},setView(){},setMode(){},setLighting(){},setAnimationPlaying(){},animations(){return[];},animationState(){return{index:0,time:0,duration:0,playing:false,speed:1,loop:true};},
  selectAnimation(){},seekAnimation(){},setAnimationSpeed(){},setAnimationLoop(){},stats(){return{triangles:1,materials:1,dimensions:{x:2,y:1,z:0}};},hasAnimations:false,dispose(){canvas.remove();}};
}};
const panel=new AssetViewerPanel(document,'a'.repeat(64),{transport,loadRuntime:async()=>runtime,tokenOrigin:location.origin});
const manifest=jobId=>({jobId,request:{name:'review-fixture'},artifacts:[{path:'asset.glb',role:'export',bytes:size,sha256:hash}]});
const show=jobId=>{const selected=++epoch;return panel.show(manifest(jobId),jobId,()=>selected===epoch);};
window.reviewFixture={show,clear(){epoch++;panel.clear();},calls,runtimeCalls:()=>runtimeCalls,release:()=>releaseRuntime?.()};
void show(JOB);
`;

test('owned Edge model review: exact bytes, trusted decisions, unknown receipts and epoch fencing', { skip: !enabled, timeout: 90000 }, async t => {
  const modules = resolve(process.env.ARCANE_UI_MODULE_ROOT!), bytes = glb(), digest = hash(bytes), errors: string[] = [];
  const reviews = new Map<string, any>(), commands = new Map<string, any>();
  const calls: { route: string; body: any; authorization: string; origin: string | undefined; site: string | undefined }[] = [];
  const state = { mode: 'normal', mismatch: false, tampered: false, statusFailure: false, heldJob: '', held: null as null | (() => void) };
  let origin = '', nextId = 20;
  const subject = (jobId: string) => ({ schemaVersion: 1, projectId: 'c'.repeat(64), conversation: { provider: 'codex', threadId: 'owned-review-thread', sessionId: null },
    jobId, manifestSha256: 'e'.repeat(64), sourceRequestSha256: 'f'.repeat(64),
    artifacts: [{ path: 'asset.glb', sha256: state.mismatch ? '0'.repeat(64) : digest, bytes: bytes.length }, { path: 'collision.glb', sha256: 'd'.repeat(64), bytes: 128 }] });
  const selected = (jobId: string) => {
    const s = subject(jobId), d = hash(canonical(s)); let review = reviews.get(jobId);
    if (!review || review.subjectDigest !== d) { review = { reviewId: String(nextId++).padStart(8, '0') + '-2222-4222-8222-222222222222', subject: s, subjectDigest: d,
      status: 'pending', revision: 0, preparedAt: '2026-10-19T00:00:00Z', decidedAt: null }; reviews.set(jobId, review); }
    return { subject: s, subjectDigest: d, review, openWitness: WITNESS, retry: false };
  };
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), route = url.pathname;
    const send = (code: number, value: unknown) => { if (response.destroyed) return; const body = JSON.stringify(value); response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); response.end(body); };
    if (route === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (route === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><title>Owned model review fixture</title><style>body{margin:0;background:#101724;color:#e5edf6;font:15px Arial}main{display:grid;grid-template-columns:320px 1fr;gap:24px;max-width:1100px;margin:32px auto}textarea{width:280px;height:120px;background:#192537;color:inherit;padding:12px;border:1px solid #435269;border-radius:10px}section{min-width:0}.viewer-canvas canvas{width:100%;height:220px}.viewer-toolbar,.viewer-animation{display:flex;gap:8px;flex-wrap:wrap;padding:12px}button,select{padding:9px;background:#24364a;color:inherit;border:1px solid #53677b;border-radius:8px}button:disabled{opacity:.45}.viewer-status,.viewer-metrics{margin:12px}.viewer-review{border-top:1px solid #435269}.viewer-review strong{display:block;font-size:18px}</style></head><body><main><section aria-label="Chat"><h2>Asset conversation</h2><p>Review the model while keeping your draft open.</p><textarea aria-label="Chat draft">Keep this draft available.</textarea></section><section id="asset-viewer" hidden></section></main><script type="module" src="/fixture.js"></script></body></html>'); return;
    }
    if (route === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(FIXTURE.replace('__HASH__', digest).replace('__SIZE__', String(bytes.length))); return; }
    const allowed = ['user-errors.js', 'asset-viewer.js', 'asset-review.js', 'asset-downloads.js', 'glb-preflight.js'];
    if (route.startsWith('/modules/apps/desktop/src/') && allowed.includes(route.slice('/modules/apps/desktop/src/'.length))) {
      const file = resolve(modules, '.' + route.slice('/modules'.length)), child = relative(modules, file);
      if (isAbsolute(child) || child.startsWith('..')) throw Error('Outside private module tree');
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(await readFile(file)); return;
    }
    if (route === '/v1/assets/artifact') {
      if (request.method !== 'GET' || request.headers.authorization !== 'Bearer ' + HUMAN) { send(401, { error: 'AUTH' }); return; }
      const payload = Buffer.from(bytes); if (state.tampered) payload[payload.indexOf('Arcane')] = 66;
      response.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': payload.length, 'Content-Disposition': 'attachment; filename="review-fixture-asset.glb"' }); response.end(payload); return;
    }
    if (!route.startsWith('/v1/assets/review/')) { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = []; for await (const part of request) { chunks.push(Buffer.from(part)); if (chunks.reduce((n, b) => n + b.length, 0) > 16384) throw Error('Oversized owned request'); }
    const body: any = JSON.parse(Buffer.concat(chunks).toString()), authorization = request.headers.authorization ?? '';
    calls.push({ route, body, authorization, origin: request.headers.origin, site: request.headers['sec-fetch-site'] as string | undefined });
    if (authorization === 'Bearer ' + AGENT) { send(403, { error: 'HUMAN_ONLY', retry: false }); return; }
    if (request.method !== 'POST' || authorization !== 'Bearer ' + HUMAN || request.headers.origin !== origin || request.headers['sec-fetch-site'] !== 'same-origin') { send(403, { error: 'AUTH', retry: false }); return; }
    if (route.endsWith('/prepare') || route.endsWith('/status')) {
      assert.deepEqual(Object.keys(body), ['jobId']);
      if (route.endsWith('/status') && state.statusFailure) { send(503, { error: 'UNAVAILABLE', retry: false }); return; }
      if (state.heldJob === body.jobId) { state.heldJob = ''; await new Promise<void>(done => { state.held = done; }); }
      const result=selected(body.jobId);
      send(200, route.endsWith('/status') ? {...result,openWitness:null} : result); return;
    }
    const review = [...reviews.values()].find(value => value.reviewId === body.reviewId);
    if (!review) { send(404, { error: 'NOT_FOUND', retry: false }); return; }
    if (route.endsWith('/decide')) {
      assert.deepEqual(Object.keys(body).sort(), ['decision', 'idempotencyKey', 'openWitness', 'reviewId']);
      assert.equal(body.openWitness,WITNESS);
      assert.match(body.idempotencyKey, /^[a-f0-9-]{36}$/); assert.ok(['approved', 'rejected'].includes(body.decision));
      if (state.mode !== 'lost-unrecorded') { review.status = body.decision; review.revision++; review.decidedAt = '2026-10-19T00:01:00Z'; commands.set(body.idempotencyKey, { idempotencyKey: body.idempotencyKey, decision: body.decision, revision: review.revision }); }
      if (state.mode.startsWith('lost-')) { response.destroy(); return; }
      send(200, { state: 'recorded', review, command: commands.get(body.idempotencyKey), retry: false }); return;
    }
    if (route.endsWith('/receipt')) {
      assert.deepEqual(Object.keys(body).sort(), ['idempotencyKey', 'reviewId']);
      const command = commands.get(body.idempotencyKey); send(200, command ? { state: 'recorded', review, command, retry: false } : { state: 'not-recorded', review, retry: false }); return;
    }
    send(404, { error: 'NOT_FOUND', retry: false });
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => { state.held?.(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const boundary = await realpath(tmpdir()), profile = await mkdtemp(join(boundary, 'arcane-review-browser-'));
  const { chromium } = await import('playwright-core');
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', args: ['--disable-gpu'] });
  t.after(async () => { await context.close(); const child = relative(boundary, await realpath(profile)); assert.ok(!isAbsolute(child) && child.startsWith('arcane-review-browser-') && !child.includes('..')); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  const shown = async (jobId: string) => { await page.evaluate(id => (window as any).reviewFixture.show(id), jobId); };
  const prepared = () => page.locator('[aria-label="Model review status"]').getByText('Pending', { exact: true }).waitFor();
  const decisionCalls = () => calls.filter(call => call.route.endsWith('/decide') && call.authorization === 'Bearer ' + HUMAN);
  await page.goto(origin + '/#hold'); await page.waitForFunction(() => (window as any).reviewFixture?.runtimeCalls() === 1);
  assert.equal(calls.length, 0, 'no preparation before verified renderer becomes ready');
  await page.evaluate(() => (window as any).reviewFixture.release()); await prepared();
  assert.deepEqual(calls.map(call => call.route), ['/v1/assets/review/prepare']);
  const approve = page.getByRole('button', { name: 'Approve model', exact: true }), reject = page.getByRole('button', { name: 'Reject model', exact: true });
  await approve.evaluate(node => (node as HTMLButtonElement).click()); await page.waitForTimeout(50); assert.equal(decisionCalls().length, 0, 'scripted click cannot approve');
  state.statusFailure = true; await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByLabel('Model review status').getByText('Review unavailable', { exact: true }).waitFor();
  assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isDisabled(), true);
  state.statusFailure = false; await page.getByRole('button', { name: 'Refresh review', exact: true }).click(); await prepared();
  const denied = await page.evaluate(async ({ token, reviewId }) => (await fetch('/v1/assets/review/decide', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId, decision: 'approved', idempotencyKey: crypto.randomUUID() }) })).status, { token: AGENT, reviewId: reviews.get(JOB).reviewId });
  assert.equal(denied, 403); assert.equal(reviews.get(JOB).status, 'pending');
  await approve.focus(); await page.keyboard.press('Enter'); await page.getByLabel('Model review status').getByText('Approved', { exact: true }).waitFor();
  assert.equal(decisionCalls().length, 1); assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isEnabled(), true);
  await page.getByRole('textbox', { name: 'Chat draft' }).fill('Chat remains available while reviewing.');
  await page.screenshot({ path: resolve('runtime/asset-review-ui/browser-proof.png'), fullPage: true });
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click(); await page.waitForTimeout(30); assert.ok(calls.some(call => call.route.endsWith('/status')));
  await reject.click(); await page.getByLabel('Model review status').getByText('Rejected', { exact: true }).waitFor();
  assert.equal(decisionCalls().length, 2); assert.notEqual(decisionCalls()[0]!.body.idempotencyKey, decisionCalls()[1]!.body.idempotencyKey);
  assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isDisabled(), true);
  state.mode = 'lost-recorded'; await shown(NEXT); await prepared(); await approve.click();
  await page.locator('[data-review-state="unknown"]').waitFor(); assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isDisabled(), true);
  const count = decisionCalls().length; await page.waitForTimeout(80); assert.equal(decisionCalls().length, count);
  await page.getByRole('button', { name: 'Check review status', exact: true }).click(); await page.getByLabel('Model review status').getByText('Approved', { exact: true }).waitFor();
  assert.equal(decisionCalls().length, count); assert.ok(calls.some(call => call.route.endsWith('/receipt')));
  state.mode = 'lost-unrecorded'; await shown(THIRD); await prepared(); await reject.click(); await page.locator('[data-review-state="unknown"]').waitFor();
  const unknownCount = decisionCalls().length; await shown(THIRD); await page.locator('[data-review-state="unknown"]').waitFor();
  await page.getByRole('button', { name: 'Check review status', exact: true }).click(); await page.waitForTimeout(40);
  assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isDisabled(), true); assert.equal(decisionCalls().length, unknownCount);
  state.mode = 'normal'; state.mismatch = true; await shown(WRONG); await page.getByLabel('Model review status').getByText('Review unavailable', { exact: true }).waitFor();
  assert.equal(await approve.isDisabled(), true); assert.equal(await reject.isDisabled(), true);
  state.mismatch = false; state.heldJob = OLD; await shown(OLD);
  await page.waitForFunction(id => (window as any).reviewFixture.calls.some((c: any) => c.path.endsWith('/prepare') && JSON.parse(c.body).jobId === id), OLD);
  await shown(LATEST); await prepared(); state.held?.(); await page.waitForTimeout(50);
  assert.equal(await page.locator('.viewer-review').getAttribute('data-review-job-id'), LATEST);
  assert.equal(await page.evaluate(id => (window as any).reviewFixture.calls.find((c: any) => c.path.endsWith('/prepare') && JSON.parse(c.body).jobId === id).signal.aborted, OLD), true);
  await page.evaluate(() => (window as any).reviewFixture.clear()); assert.equal(await page.locator('.viewer-review').count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Chat draft' }).inputValue(), 'Chat remains available while reviewing.');
  state.tampered = true; const before = calls.length; await page.goto(origin + '/'); await page.waitForFunction(() => !!(window as any).reviewFixture);
  await page.getByText('3D preview unavailable.', { exact: false }).waitFor(); assert.equal(calls.length, before); assert.equal(await page.locator('.viewer-review').count(), 0);
  assert.deepEqual(errors, []);
  const humanCalls = calls.filter(call => call.authorization === 'Bearer ' + HUMAN);
  assert.ok(humanCalls.every(call => call.origin === origin && call.site === 'same-origin'));
});
