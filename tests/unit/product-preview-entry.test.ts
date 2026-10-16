import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';

test('product root opens the exact desktop chat surface; diagnostics are explicit and entry creates no native activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-preview-entry-'));
  const store = new StudioStore({ directory: join(directory, 'bridge') });
  let probes = 0;
  const app = await createConnectionLab({ cwd: resolve('.'), stateDirectory: join(directory, 'preferences'), studioStore: store, probe: async () => { probes++; return []; }, codexConnect: refuseNativeCodex });
  t.after(async () => {
    await app.close(); store.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(boundary && !isAbsolute(boundary) && boundary !== '..' && !boundary.startsWith('..') && boundary.startsWith('arcane-preview-entry-'));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(app.origin + '/', { redirect: 'manual' });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), '/studio');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
  const preview = await fetch(app.origin + '/');
  const canonical = await fetch(app.origin + '/studio');
  const html = await readFile(resolve('apps/desktop/public/studio.html'), 'utf8');
  assert.equal(preview.url, app.origin + '/studio');
  assert.equal(preview.status, 200); assert.equal(canonical.status, 200);
  assert.equal(await preview.text(), html); assert.equal(await canonical.text(), html);
  const diagnostic = await fetch(app.origin + '/diagnostics');
  assert.equal(diagnostic.status, 200);
  assert.equal(await diagnostic.text(), await readFile(resolve('apps/desktop/public/index.html'), 'utf8'));
  assert.equal(app.url, app.origin + '/studio#' + app.token);
  assert.equal(probes, 0, 'Opening a surface does not start CLI discovery or inference.');
  assert.equal((await fetch(app.origin + '/v1/studio/sessions')).status, 401, 'Shared preview HTML does not supply authorization.');
});

test('standalone metadata lab remains available without the product Studio bridge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-preview-lab-'));
  let probes = 0;
  const app = await createConnectionLab({ cwd: resolve('.'), stateDirectory: directory, probe: async () => { probes++; return []; }, codexConnect: refuseNativeCodex });
  t.after(async () => {
    await app.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(boundary && !isAbsolute(boundary) && boundary.startsWith('arcane-preview-lab-'));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(app.origin + '/', { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(await response.text(), await readFile(resolve('apps/desktop/public/index.html'), 'utf8'));
  assert.equal(app.url, app.origin + '/#' + app.token);
  assert.equal(probes, 0);
});
