import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { makeFixtureDirectory } from './windows-fixture-paths.js';

test('product serves only fixed offline viewer modules with same-origin and owned blob CSP', async t => {
  const directory = makeFixtureDirectory('arcane-viewer-routes-');
  const studioStore = new StudioStore({ directory: join(directory, 'studio') });
  const workStore = new WorkStore({ directory: join(directory, 'work'), projectPath: directory });
  const app = await createConnectionLab({ cwd: resolve('.'), projectPath: directory, stateDirectory: join(directory, 'preferences'), studioStore, workStore, probe: async () => [] });
  t.after(async () => { await app.close(); workStore.close(); studioStore.close(); });
  const paths = ['/asset-viewer.js', '/glb-preflight.js', '/asset-viewer-runtime.mjs',
    '/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
    '/vendor/three/examples/jsm/loaders/GLTFLoader.js', '/vendor/three/examples/jsm/controls/OrbitControls.js',
    '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three/examples/jsm/utils/SkeletonUtils.js'];
  for (const path of paths) {
    const response = await fetch(app.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type')!, /^text\/javascript/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const csp = response.headers.get('content-security-policy')!;
    assert.match(csp, /script-src 'self';/); assert.match(csp, /connect-src 'self' blob:;/);
    assert.match(csp, /img-src 'self' blob:;/); assert.match(csp, /object-src 'none';/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:|\*/);
    assert.ok((await response.text()).length > 100);
  }
  for (const path of ['/vendor/three/manifest.json', '/vendor/three/LICENSE', '/vendor/three/examples/jsm/loaders/DRACOLoader.js', '/vendor/three/build/three.module.js.map', '/asset-viewer.ts']) {
    const response = await fetch(app.origin + path); assert.notEqual(response.status, 200, path); await response.body?.cancel();
  }
});
