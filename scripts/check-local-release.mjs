/** Real clean-package daemon acceptance; no Studio/Blender/provider calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyLocalRelease } from './create-local-release.mjs';
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
  limitations: ['No installed Studio plugin, native model turn, asset import or signed-desktop verification.'] };
let origin = '', token = '', agent = '';
async function request(route, { method = 'GET', body, bearer = token, browserOrigin = origin } = {}) {
  const response = await fetch(origin + route, { method, redirect: 'error', headers: { Authorization: 'Bearer ' + bearer,
    ...(browserOrigin ? { Origin: browserOrigin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
function check(label) { report.checks.push({ label, passed: true }); }
try {
  for (let attempt = 0; attempt < 100 && !terminal; attempt++) {
    const match = /Open locally: (http:\/\/127\.0\.0\.1:\d+)\/studio#([a-f0-9]{64})/.exec(stdout);
    if (match) { [, origin, token] = match; break; }
    await sleep(100);
  }
  assert.ok(origin && token, 'Own daemon did not start; no credential output is included. ' + lastError); check('private-loopback-launch');
  const html = await request('/studio'); assert.equal(html.status, 200); assert.match(html.text, /Arcane/); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/); check('actual-workbench-static-route-and-csp');
  const state = await request('/v1/product/state'); assert.equal(state.status, 200); const product = JSON.parse(state.text); assert.equal(product.projectPath, directory); assert.deepEqual(product.studioSessions, []); check('isolated-sqlite-product-state');
  assert.equal((await request('/v1/product/state', { browserOrigin: 'https://untrusted.invalid' })).status, 403); check('cross-origin-refused');
  const issue = await request('/v1/studio/keys', { method: 'POST', body: { allowedRoots: ['Workspace'], allowWrites: false } });
  assert.equal(issue.status, 200); const issued = JSON.parse(issue.text); assert.match(issued.apiKey, /^arcane_local_v1_\d+_[a-f0-9]{64}$/);
  assert.equal(issued.key.allowWrites, false);
  const keys = await request('/v1/studio/keys'); assert.equal(keys.status, 200); assert.ok(!keys.text.includes(issued.apiKey)); check('actual-readonly-key-issue-and-redacted-list');
  const handoff = await request('/v1/product/mcp-token', { method: 'POST', body: {} }); assert.equal(handoff.status, 200); agent = JSON.parse(handoff.text).token; assert.notEqual(agent, token);
  assert.equal((await request('/v1/studio/keys', { bearer: agent })).status, 403); check('agent-cannot-grant-access');
  const revoke = await request('/v1/studio/keys/revoke', { method: 'POST', body: { keyId: issued.key.keyId } }); assert.equal(revoke.status, 200); check('actual-local-key-revocation');
  report.passed = true;
} catch (error) {
  report.error = String(error.message).replaceAll(token || '___NO_TOKEN___', '[redacted]').replaceAll(agent || '___NO_AGENT___', '[redacted]');
  process.exitCode = 1;
} finally {
  if (!terminal) {
    if (child.connected) child.send({ type: 'arcane-shutdown', protocolVersion: 1 });
    else child.kill();
  }
  const outcome = await Promise.race([closed, sleep(15000).then(() => null)]);
  if (!outcome) { child.kill(); await closed; report.passed = false; report.error = 'Owned daemon did not finish within the shutdown deadline.'; process.exitCode = 1; }
  else { report.shutdown = outcome; if (outcome.code !== 0) { report.passed = false; process.exitCode = 1; } }
  const output = join(repository, 'docs', 'research'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'local-release-checks.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
