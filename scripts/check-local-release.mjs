/** Real clean-package daemon acceptance; no Studio/Blender/provider calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyLocalRelease, BRAND_BITMAP_PATH, validateBrandBitmap } from './create-local-release.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Supply one absolute generated package directory.');
const directory = await realpath(process.argv[2]);
const path = relative(join(repository, 'runtime', 'releases'), directory);
if (!/^arcane-local-[A-Za-z0-9_-]+$/.test(path) || path.includes(sep) || (await lstat(directory)).isSymbolicLink()) throw new Error('Acceptance is limited to one generated Arcane release directory.');
const integrity = await verifyLocalRelease(directory);
const { productDoctor } = await import(pathToFileURL(join(directory, 'scripts', 'product-doctor.mjs')));
assert.equal((await productDoctor({ repository: directory })).readyToLaunch, true, 'Install this package dependencies and build it first.');
const child = spawn(process.execPath, [join(directory, 'dist/apps/daemon/src/product-main.js')], {
  cwd: directory, env: { ...process.env, ARCANE_PROJECT: directory, ARCANE_PORT: '0' }, shell: false, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let stdout = '', bytes = 0, lastError = '', terminal = false;
child.stdout.on('data', raw => { bytes += raw.length; if (bytes > 256 * 1024) child.kill(); else stdout += raw.toString('utf8'); });
child.stderr.on('data', raw => { bytes += raw.length; if (bytes > 256 * 1024) child.kill(); });
const closed = new Promise(resolve => { child.once('close', (code, signal) => { terminal = true; resolve({ code, signal }); }); child.once('error', () => { terminal = true; lastError = 'spawn-failed'; resolve({ code: null, signal: null }); }); });
const report = { schemaVersion: 1, evidenceKind: 'actual-clean-package-loopback-daemon', observedAt: new Date().toISOString(),
  directory, manifestSha256: integrity.manifestSha256, checks: [], passed: false, studioCalls: 0, providerInferenceRuns: 0, blenderRuns: 0,
  limitations: ['No installed Studio plugin, native model turn, asset import or signed-desktop verification.', 'Static UI route checks do not prove browser rendering or interactions.'] };
let origin = '', token = '', agent = '', studioKey = '';
async function request(route, { method = 'GET', body, bearer = token, browserOrigin = origin, binary = false } = {}) {
  const response = await fetch(origin + route, { method, redirect: 'error', headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
    ...(browserOrigin ? { Origin: browserOrigin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, text: binary ? '' : bytes.toString('utf8') };
}
function check(label) { report.checks.push({ label, passed: true }); }
function publicSafeHeaders(response, contentType) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), contentType);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /img-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}
try {
  for (let attempt = 0; attempt < 100 && !terminal; attempt++) {
    const match = /Open locally: (http:\/\/127\.0\.0\.1:\d+)\/studio#([a-f0-9]{64})/.exec(stdout);
    if (match) { [, origin, token] = match; break; }
    await sleep(100);
  }
  assert.ok(origin && token, 'Own daemon did not start; no credential output is included. ' + lastError); check('private-loopback-launch');
  const html = await request('/studio'); assert.equal(html.status, 200); assert.match(html.text, /Arcane/); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/); check('actual-workbench-static-route-and-csp');
  const workspaceModule = await request('/workspace-shell.js', { bearer: '', browserOrigin: '' });
  publicSafeHeaders(workspaceModule, 'text/javascript; charset=utf-8');
  assert.ok(workspaceModule.bytes.equals(await readFile(join(directory, 'dist/apps/desktop/src/workspace-shell.js'))), 'Workspace module must match the integrity-checked package bytes.');
  assert.ok(!workspaceModule.text.includes(token)); check('workspace-shell-public-module-and-safe-headers');
  const brand = await request('/brand/arcane-ridges.png', { bearer: '', browserOrigin: '', binary: true });
  publicSafeHeaders(brand, 'image/png'); validateBrandBitmap(brand.bytes);
  assert.ok(brand.bytes.equals(await readFile(join(directory, BRAND_BITMAP_PATH))), 'Brand PNG must match the integrity-checked package bytes.');
  assert.equal(brand.bytes.indexOf(Buffer.from(token)), -1); check('brand-png-public-bytes-and-safe-headers');
  for (const route of ['/workspace-shell.js.map', '/brand/unlisted.png', '/brand/arcane-ridges.png.extra']) assert.equal((await request(route)).status, 404);
  check('workspace-static-routes-are-exact');
  const state = await request('/v1/product/state'); assert.equal(state.status, 200); const product = JSON.parse(state.text); assert.equal(product.projectPath, directory); assert.deepEqual(product.studioSessions, []); check('isolated-sqlite-product-state');
  assert.equal((await request('/v1/product/state', { browserOrigin: 'https://untrusted.invalid' })).status, 403); check('cross-origin-refused');
  const issue = await request('/v1/studio/keys', { method: 'POST', body: { allowedRoots: ['Workspace'], allowWrites: false } });
  assert.equal(issue.status, 200); const issued = JSON.parse(issue.text); studioKey = issued.apiKey; assert.match(issued.apiKey, /^arcane_local_v1_\d+_[a-f0-9]{64}$/);
  assert.equal(issued.allowWrites, false);
  const keys = await request('/v1/studio/keys'); assert.equal(keys.status, 200); assert.ok(!keys.text.includes(issued.apiKey)); check('actual-readonly-key-issue-and-redacted-list');
  const handoff = await request('/v1/product/mcp-token', { method: 'POST', body: {} }); assert.equal(handoff.status, 200); agent = JSON.parse(handoff.text).token; assert.notEqual(agent, token);
  assert.equal((await request('/v1/studio/keys', { bearer: agent })).status, 403); check('agent-cannot-grant-access');
  const revoke = await request('/v1/studio/keys/revoke', { method: 'POST', body: { keyId: issued.keyId } }); assert.equal(revoke.status, 200); check('actual-local-key-revocation');
  const chatModule = await request('/codex-chat.js'); assert.equal(chatModule.status, 200); assert.match(chatModule.headers.get('content-type'), /javascript/); check('native-chat-compiled-static-module');
  const chatState = await request('/v1/codex/state'); assert.equal(chatState.status, 200); const chat = JSON.parse(chatState.text).state;
  assert.equal(chat.provider, 'codex'); assert.equal(chat.use, 'personal-local'); assert.equal(chat.projectPath, directory); assert.equal(chat.snapshot, null); assert.deepEqual(chat.actions, []); assert.equal(chat.connecting, false); assert.deepEqual(chat.nativeTools, { configured: true, verified: false }); check('native-chat-inert-default-and-exact-project');
  assert.equal((await request('/v1/codex/state', { bearer: agent })).status, 403);
  assert.equal((await request('/v1/codex/action', { method: 'POST', bearer: agent, body: { requestId: '00000000-0000-4000-8000-000000000001', connectionId: null, action: 'connect' } })).status, 403);
  assert.equal((await request('/v1/codex/action', { method: 'POST', browserOrigin: 'https://untrusted.invalid', body: { requestId: '00000000-0000-4000-8000-000000000002', connectionId: null, action: 'connect' } })).status, 403); check('native-chat-agent-and-cross-origin-denied-before-launch');
  assert.deepEqual(JSON.parse((await request('/v1/codex/state')).text).state.actions, []);
  report.passed = true;
} catch (error) {
  report.error = String(error.message).replaceAll(token || '___NO_TOKEN___', '[redacted]').replaceAll(agent || '___NO_AGENT___', '[redacted]').replaceAll(studioKey || '___NO_STUDIO_KEY___', '[redacted]');
  process.exitCode = 1;
} finally {
  if (!terminal) {
    if (child.connected) child.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => { if (error && !terminal) child.kill(); });
    else child.kill();
  }
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); });
  const outcome = await Promise.race([closed, timeout]); clearTimeout(timer);
  if (!outcome) { child.kill(); await closed; report.passed = false; report.error = 'Owned daemon did not finish within the shutdown deadline.'; process.exitCode = 1; }
  else { report.shutdown = outcome; if (outcome.code !== 0) { report.passed = false; process.exitCode = 1; } }
  const output = join(repository, 'docs', 'research'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'local-release-checks.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
