import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRAND_BITMAP_PATH, REQUIRED_FRONTEND_FILES, createLocalRelease, verifyLocalRelease } from '../../scripts/create-local-release.mjs';
import { productDoctor } from '../../scripts/product-doctor.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWooAAAAASUVORK5CYII=', 'base64');
const shellSource = 'export const fixtureShell = true;\n';
const firstRunFiles = ['scripts/setup-arcane.ps1', 'scripts/launch-arcane.cmd', 'docs/build/FIRST_RUN.md'];

async function fixture({ omit, bitmap = png, daemon = '// Offline fixture only.\n' } = {}) {
  // Retain this task's disposable fixtures in Temp; no checkout files are deleted.
  const root = await mkdtemp(join(tmpdir(), 'arcane-ui-release-test-'));
  const write = async (path, bytes) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); };
  const put = async (path, bytes) => { if (path !== omit) await write(path, bytes); };
  for (const path of ['apps', 'packages', 'workers', 'plugin', 'scripts', 'skills', 'docs', 'tests', 'dist', '.github']) await mkdir(join(root, path));
  await write('package.json', JSON.stringify({ name: 'arcane', version: '0.1.0', type: 'module', scripts: { 'setup:arcane': 'powershell -File scripts/setup-arcane.ps1' } }));
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'arcane', version: '0.1.0' } } }));
  await write('tsconfig.json', '{}');
  for (const path of ['README.md', 'LICENSE']) await write(path, 'Offline fixture.\n');
  for (const path of REQUIRED_FRONTEND_FILES) {
    const bytes = path === BRAND_BITMAP_PATH ? bitmap : path.endsWith('.ts') || path.endsWith('workspace-shell.js') || path.endsWith('asset-downloads.js') || path.endsWith('learning-panel.js') ? shellSource : path.endsWith('.map') ? JSON.stringify({ version: 3, sources: ['../../../../apps/desktop/src/' + path.split('/').at(-1).replace('.js.map', '.ts')], sourcesContent: [shellSource] }) : path.endsWith('.html') ? '<!doctype html><title>Arcane fixture</title>' : '// Offline fixture only.\n';
    await put(path, bytes);
  }
  for (const path of firstRunFiles) await put(path, 'Offline first-run fixture; never executed.\n');
  await write('dist/apps/daemon/src/product-main.js', daemon);
  await write('dist/apps/daemon/src/codex-service.js', '// Offline fixture only.\n');
  await write('dist/apps/mcp/src/main.js', '// Offline fixture only.\n');
  await write('workers/blender/asset_worker.py', '# Offline fixture only.\n');
  await write('skills/registry.json', '{}');
  const plugin = '--!strict\n-- Offline fixture only.\n';
  await write('plugin/src/Main.server.luau', plugin);
  await write('plugin/build/ArcaneLocalBridge.lua', plugin);
  await write('plugin/build/manifest.json', JSON.stringify({ schemaVersion: 1, preferredArtifact: 'ArcaneLocalBridge.lua', sources: [{ path: 'src/Main.server.luau', sha256: hash(plugin) }], artifacts: [{ name: 'ArcaneLocalBridge.lua', bytes: Buffer.byteLength(plugin), sha256: hash(plugin) }] }));
  // Local resolution stubs prove doctor scope without installing dependencies.
  await write('node_modules/@modelcontextprotocol/sdk/package.json', JSON.stringify({ name: '@modelcontextprotocol/sdk', exports: { './client/index.js': './client/index.js' } }));
  await write('node_modules/@modelcontextprotocol/sdk/client/index.js', '// Resolution stub.\n');
  await write('node_modules/zod/package.json', JSON.stringify({ name: 'zod', main: 'index.cjs' }));
  await write('node_modules/zod/index.cjs', '// Resolution stub.\n');
  return { root, write };
}

test('controlled brand PNG and named setup scripts are integrity-listed; unrelated bitmaps and executables are excluded', async () => {
  const { root, write } = await fixture();
  const excluded = ['apps/desktop/public/brand/other.png', 'docs/private.png', 'packages/model/preview.png', 'workers/asset.png', 'scripts/other.ps1', 'scripts/other.cmd', 'scripts/nested/setup-arcane.ps1', 'docs/launch-arcane.cmd', 'scripts/setup-arcane.PS1', 'scripts/tool.exe'];
  for (const path of excluded) await write(path, png);
  const release = await createLocalRelease({ repository: root });
  const manifest = JSON.parse(await readFile(join(release.directory, 'release-manifest.json'), 'utf8'));
  const listed = new Set(manifest.files.map(file => file.path));
  for (const path of [...REQUIRED_FRONTEND_FILES, ...firstRunFiles]) assert.ok(listed.has(path), path);
  for (const path of excluded) assert.equal(listed.has(path), false, path);
  assert.deepEqual(manifest.files.find(file => file.path === BRAND_BITMAP_PATH), { path: BRAND_BITMAP_PATH, bytes: png.length, sha256: hash(png) });
  assert.ok((await readFile(join(release.directory, BRAND_BITMAP_PATH))).equals(png));
  assert.equal((await verifyLocalRelease(release.directory)).runtimeVerified, false);
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  await writeFile(join(release.directory, BRAND_BITMAP_PATH), changed);
  await assert.rejects(verifyLocalRelease(release.directory), /checksum mismatch/);
});

test('manifest verification uses the same exact bitmap and executable allowlist as collection', async () => {
  const { root } = await fixture();
  const { directory } = await createLocalRelease({ repository: root });
  const manifestPath = join(directory, 'release-manifest.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const path of ['docs/arcane-ridges.png', 'apps/desktop/public/brand/other.png', 'scripts/nested/launch-arcane.cmd', 'scripts/other.ps1', 'scripts/other.cmd', 'scripts/tool.exe']) {
    const manifest = structuredClone(original);
    manifest.files.push({ path, bytes: png.length, sha256: hash(png) }); manifest.fileCount++; manifest.totalBytes += png.length;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyLocalRelease(directory), /outside the release allowlist/, path);
  }
});

test('each required frontend file is checked before a release can be emitted', async t => {
  for (const omit of REQUIRED_FRONTEND_FILES) await t.test(omit, async () => {
    const { root } = await fixture({ omit });
    await assert.rejects(createLocalRelease({ repository: root }), error => error.message.includes('missing ' + omit));
  });
});

test('a declared first-run command requires all three named first-run files', async t => {
  for (const omit of firstRunFiles) await t.test(omit, async () => {
    const { root } = await fixture({ omit });
    await assert.rejects(createLocalRelease({ repository: root }), error => error.message.includes('missing ' + omit));
  });
});

test('doctor requires the workspace module, source map, CSS and valid bounded PNG without credentials or network', async () => {
  const { root, write } = await fixture();
  const report = await productDoctor({ repository: root, nodeVersion: '24.0.0' });
  assert.equal(report.readyToLaunch, true);
  assert.equal(report.credentialsRead, false); assert.equal(report.networkUsed, false); assert.equal(report.installsPerformed, false);
  for (const id of ['workspace-shell-source', 'workspace-shell-entry', 'workspace-shell-map', 'workbench-css', 'workbench-brand-bitmap']) assert.equal(report.checks.find(check => check.id === id).status, 'pass');
  const missing = await fixture({ omit: 'dist/apps/desktop/src/workspace-shell.js' });
  const failed = await productDoctor({ repository: missing.root, nodeVersion: '24.0.0' });
  assert.equal(failed.readyToLaunch, false); assert.equal(failed.checks.find(check => check.id === 'workspace-shell-entry').status, 'fail');
  await write(BRAND_BITMAP_PATH, 'Not a PNG');
  assert.equal((await productDoctor({ repository: root, nodeVersion: '24.0.0' })).checks.find(check => check.id === 'workbench-brand-bitmap').status, 'fail');
  await assert.rejects(createLocalRelease({ repository: root }), /Invalid PNG signature/);
});

test('credential stores stay excluded and safe redacted evidence cannot mask real credentials in controlled files', async () => {
  const { root, write } = await fixture();
  for (const path of ['apps/desktop/public/brand/auth.json', 'scripts/credentials.json', 'scripts/.env.local', 'apps/mcp/generated/session.json', 'packages/model/.runtime/session.json']) await write(path, JSON.stringify({ token: 'never-copy-me' }));
  await write('docs/redacted-evidence.json', JSON.stringify({ token: null, apiKey: null, credentialDisplay: '[redacted]' }));
  const release = await createLocalRelease({ repository: root });
  const manifest = JSON.parse(await readFile(join(release.directory, 'release-manifest.json'), 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes('never-copy-me'));
  assert.ok(manifest.files.some(file => file.path === 'docs/redacted-evidence.json'));
  assert.ok(!manifest.files.some(file => /auth\.json|credentials\.json|\.env|session\.json/.test(file.path)));
  const credential = 'arcane_local_v1_45871_' + 'a'.repeat(64);
  await write('scripts/setup-arcane.ps1', credential);
  await assert.rejects(createLocalRelease({ repository: root }), error => /credential/.test(error.message) && !error.message.includes(credential));
  await write('scripts/setup-arcane.ps1', 'Redacted fixture');
  await write('scripts/launch-arcane.cmd', 'http://127.0.0.1:45871/studio#' + 'b'.repeat(64));
  await assert.rejects(createLocalRelease({ repository: root }), /credential/);
  await write('scripts/launch-arcane.cmd', 'Redacted fixture');
  await write('docs/redacted-evidence.json', JSON.stringify({ refresh_token: 'private-value' }));
  await assert.rejects(createLocalRelease({ repository: root }), error => /Credential-like/.test(error.message) && !error.message.includes('private-value'));
});

test('UI packaging still refuses stale source maps and stale dependency locks', async () => {
  const { root, write } = await fixture();
  await write('apps/desktop/src/workspace-shell.ts', 'export const fixtureShell = false;\n');
  await assert.rejects(createLocalRelease({ repository: root }), /Compiled source is stale/);
  await write('apps/desktop/src/workspace-shell.ts', shellSource);
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { zod: '0.0.0' } } } }));
  await assert.rejects(createLocalRelease({ repository: root }), /out of sync/);
});

async function syntheticDaemon({ failWithCredentials = false, unsafePngHeaders = false }) {
  // Deliberate HTTP double: no native runtime, model, Studio, or SQLite is used.
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const human = 'b'.repeat(64), agent = 'c'.repeat(64), studioKey = 'arcane_local_v1_45871_' + 'd'.repeat(64);
  const root = process.cwd();
  let origin;
  const routes = new Map([
    ['/studio', ['apps/desktop/public/studio.html', 'text/html; charset=utf-8']],
    ['/codex-chat.js', ['dist/apps/desktop/src/codex-chat.js', 'text/javascript; charset=utf-8']],
    ['/workspace-shell.js', ['dist/apps/desktop/src/workspace-shell.js', 'text/javascript; charset=utf-8']],
    ['/brand/arcane-ridges.png', ['apps/desktop/public/brand/arcane-ridges.png', 'image/png']],
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    const route = routes.get(request.url);
    if (route) {
      if (['/workspace-shell.js', '/brand/arcane-ridges.png'].includes(request.url) && (request.headers.authorization || request.headers.origin)) return send(400, { error: 'Fixture requires a credential-free public request.' });
      if (unsafePngHeaders && request.url.endsWith('.png')) response.setHeader('X-Content-Type-Options', 'unsafe');
      response.writeHead(200, { 'Content-Type': route[1] }); response.end(await readFile(join(root, route[0]))); return;
    }
    if (request.headers.authorization !== 'Bearer ' + human || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: 'DENIED' });
    if (request.url === '/v1/product/state') return send(200, { projectPath: root, studioSessions: [] });
    if (request.url === '/v1/studio/keys') return send(200, request.method === 'POST' ? { apiKey: studioKey, keyId: 'fixture-key', allowWrites: false } : [{ keyId: 'fixture-key', allowWrites: false }]);
    if (request.url === '/v1/product/mcp-token') return send(200, { token: agent });
    if (request.url === '/v1/studio/keys/revoke') return send(200, { revoked: true });
    if (request.url === '/v1/codex/state') return send(200, { state: { provider: failWithCredentials ? [human, agent, studioKey].join(' ') : 'codex', use: 'personal-local', projectPath: root, snapshot: null, actions: [], connecting: false, nativeTools: { configured: true, verified: false } } });
    return send(404, { error: 'NOT_FOUND' });
  });
  server.listen(0, '127.0.0.1', () => { origin = 'http://127.0.0.1:' + server.address().port; console.log('Open locally: ' + origin + '/studio#' + human); });
  process.on('message', message => { if (message.type === 'arcane-shutdown' && message.protocolVersion === 1) { server.close(() => { if (process.connected) process.disconnect(); }); } });
}

async function runAcceptance(options = {}) {
  const { root, write } = await fixture({ daemon: '(' + syntheticDaemon.toString() + ')(' + JSON.stringify(options) + ');\n' });
  for (const file of ['create-local-release.mjs', 'product-doctor.mjs', 'check-local-release.mjs']) await write('scripts/' + file, await readFile(new URL('../../scripts/' + file, import.meta.url)));
  const release = await createLocalRelease({ repository: root });
  for (const path of ['node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/@modelcontextprotocol/sdk/client/index.js', 'node_modules/zod/package.json', 'node_modules/zod/index.cjs']) {
    const target = join(release.directory, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(join(root, path)));
  }
  assert.equal((await productDoctor({ repository: release.directory })).readyToLaunch, true, 'Synthetic package must have its own resolution stubs.');
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-local-release.mjs'), release.directory], { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 25000, maxBuffer: 64 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'docs/research/local-release-checks.json'), 'utf8')), report);
  return { result, report };
}

test('acceptance HTTP double expects thirteen checks including credential-free exact UI routes and public safe headers', async () => {
  const { result, report } = await runAcceptance();
  assert.equal(result.status, 0); assert.equal(report.passed, true); assert.equal(report.checks.length, 13);
  for (const label of ['workspace-shell-public-module-and-safe-headers', 'brand-png-public-bytes-and-safe-headers', 'workspace-static-routes-are-exact']) assert.ok(report.checks.some(check => check.label === label && check.passed));
  assert.equal(report.studioCalls, 0); assert.equal(report.providerInferenceRuns, 0); assert.equal(report.blenderRuns, 0);
  assert.deepEqual(report.shutdown, { code: 0, signal: null });
});

test('acceptance rejects unsafe PNG headers and redacts human, agent and Studio credentials from failures', async () => {
  const unsafe = await runAcceptance({ unsafePngHeaders: true });
  assert.equal(unsafe.result.status, 1); assert.equal(unsafe.report.passed, false);
  assert.ok(!unsafe.report.checks.some(check => check.label === 'brand-png-public-bytes-and-safe-headers'));
  const failed = await runAcceptance({ failWithCredentials: true });
  assert.equal(failed.result.status, 1); assert.equal(failed.report.passed, false);
  assert.match(failed.report.error, /\[redacted\]/);
  for (const credential of ['b'.repeat(64), 'c'.repeat(64), 'arcane_local_v1_45871_' + 'd'.repeat(64)]) assert.ok(!failed.result.stdout.includes(credential));
});
