import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { meshKeepStatus, readMeshKeepView } from '../../apps/desktop/src/mesh-keep.js';

const candidate = { digest: 'ab'.repeat(32), sessionId: '11111111-2222-4333-8444-555555555555', placeName: 'Place', name: 'OakTemplate', jobId: 'job-1', meshCount: 2,
  placedAt: '2026-10-18T10:00:00.000Z', live: true, capable: true, action: 'keep', receipt: null };

test('mesh keep view reader is strict and keeps only display fields', () => {
  const view = readMeshKeepView({ available: true, consentChannel: true, candidates: [candidate], receipts: [] });
  assert.deepEqual(view?.candidates[0], { digest: candidate.digest, sessionId: candidate.sessionId, placeName: 'Place', name: 'OakTemplate', jobId: 'job-1', meshCount: 2, live: true, capable: true, action: 'keep', receipt: null });
  const receipt = { attemptId: '00000000-0000-4000-8000-000000000001', state: 'uploaded', message: 'Uploaded.', acknowledged: false, assets: [{ assetId: 5 }, { assetId: null }] };
  assert.deepEqual(readMeshKeepView({ available: true, consentChannel: true, candidates: [{ ...candidate, action: 'finish', receipt }] })?.candidates[0]?.receipt,
    { attemptId: receipt.attemptId, state: 'uploaded', message: 'Uploaded.', acknowledged: false, assetIds: [5] });
  for (const bad of [null, [], { available: true, consentChannel: true, candidates: [{ ...candidate, digest: 'x' }] }, { available: true, consentChannel: true, candidates: [{ ...candidate, action: 'upload' }] },
    { available: true, consentChannel: true, candidates: [{ ...candidate, receipt: { ...receipt, state: 'done' } }] }, { available: true, candidates: [] }])
    assert.equal(readMeshKeepView(bad), null);
});

test('mesh keep status explains why a mesh cannot be kept yet, in plain words', () => {
  const c = readMeshKeepView({ available: true, consentChannel: true, candidates: [candidate] })!.candidates[0]!;
  assert.match(meshKeepStatus(c, { consentChannel: true }), /disappears on reconnect, Play or reopening/);
  assert.match(meshKeepStatus(c, { consentChannel: false }), /desktop app/);
  assert.match(meshKeepStatus({ ...c, live: false }, { consentChannel: true }), /Open this place in Studio/);
  assert.match(meshKeepStatus({ ...c, capable: false }, { consentChannel: true }), /update Studio and the Arcane plugin/);
});

test('real Edge mesh cards settle after rendering and follow external chat changes without requesting uploads',
  { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 30000 }, async t => {
    const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE });
    t.after(() => browser.close());
    const source = await readFile(join(process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist'), 'apps/desktop/src/mesh-keep.js'));
    const server = createServer((request, response) => {
      if (request.url === '/mesh-keep.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(source); }
      else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><section id="chat-assets"><article class="chat-asset-card" data-job-id="job-1"></article></section>'); }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const page = await browser.newPage(), errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port);
    await page.evaluate(async (candidate: Record<string, unknown>) => {
      const w = window as any, NativeObserver = window.MutationObserver;
      w.observerCallbacks = 0; w.runaway = false; w.requests = [];
      // Bound a broken observer's delivery so a regression fails instead of starving the browser event loop.
      window.MutationObserver = class extends NativeObserver {
        constructor(callback: MutationCallback) {
          super((records, observer) => {
            if (++w.observerCallbacks > 12) { w.runaway = true; observer.disconnect(); return; }
            callback(records, observer);
          });
        }
      };
      w.meshView = { available: true, consentChannel: true, candidates: [candidate] };
      const modulePath: string = '/mesh-keep.js', module = await import(modulePath);
      w.meshKeep = module.startMeshKeep(document, { token: () => 'fixture-token', desktop: null,
        fetch: async (path: string, init: RequestInit) => { w.requests.push({ path, method: init.method }); return new Response(JSON.stringify(w.meshView)); } });
    }, candidate);
    const settled = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.locator('.mesh-keep-inline').waitFor(); await settled();
    assert.equal(await page.evaluate(() => (window as any).runaway), false, 'Own card mutations must not repeatedly schedule another render.');
    assert.ok(await page.evaluate(() => (window as any).observerCallbacks <= 2));
    assert.equal(await page.locator('.mesh-keep-inline').count(), 1);
    await page.evaluate(() => {
      (window as any).observerCallbacks = 0;
      document.getElementById('chat-assets')!.innerHTML = '<article class="chat-asset-card" data-job-id="job-1"></article>';
    });
    await page.locator('.mesh-keep-inline').waitFor(); await settled();
    assert.equal(await page.evaluate(() => (window as any).runaway), false);
    assert.ok(await page.evaluate(() => (window as any).observerCallbacks <= 2), 'External chat rendering reattaches controls once.');
    await page.evaluate(async () => {
      const w = window as any;
      w.meshView.candidates[0] = { ...w.meshView.candidates[0], action: 'none', receipt: {
        attemptId: '00000000-0000-4000-8000-000000000001', state: 'kept', message: 'Kept. Save the place.', acknowledged: false, assets: [{ assetId: 5 }],
      } };
      await w.meshKeep.reload();
    });
    await settled();
    assert.equal(await page.locator('.mesh-keep-inline').count(), 1);
    assert.equal(await page.locator('.mesh-keep-status').textContent(), 'Kept. Save the place.');
    assert.deepEqual(await page.evaluate(() => (window as any).requests), [
      { path: '/v1/mesh-keep/state', method: 'GET' }, { path: '/v1/mesh-keep/state', method: 'GET' },
    ]);
    await page.evaluate(() => (window as any).meshKeep.stop());
    assert.deepEqual(errors, []);
  });
