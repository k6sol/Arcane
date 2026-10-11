/** Real installed-Blender acceptance runner. Unit-test synthetic fixtures are never loaded here. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compiled = join(root, 'packages', 'asset-pipeline', '.runtime', 'compiled');
const { createAssetPipeline, AssetError } = await import(pathToFileURL(join(compiled, 'packages/asset-pipeline/src/index.js')));
const { createAssetService } = await import(pathToFileURL(join(compiled, 'apps/daemon/src/asset-service.js')));
const { assetRoutes } = await import(pathToFileURL(join(compiled, 'apps/daemon/src/asset-routes.js')));
const outputRoot = join(root, 'packages', 'asset-pipeline', '.runtime', 'verification-' + randomUUID());
await mkdir(outputRoot);
const pipeline = createAssetPipeline({ workspaceRoot: root, outputRoot });
const evidence = { schemaVersion: 1, observedAt: new Date().toISOString(), outputRoot, probe: await pipeline.probe(), generated: [], checks: {} };
assert.equal(evidence.probe.available, true, 'An installed Blender runtime is required for native acceptance.');
console.log(JSON.stringify({ stage: 'native-probe', blender: evidence.probe.blender }));
for (const template of ['hero-prop', 'environment-kit', 'hero-prop']) {
  const job = pipeline.start({ template, name: template + '-verified', renderResolution: 256, renderSamples: 8 }, { onEvent: e => console.log(JSON.stringify(e)) });
  const result = await job.completion;
  assert.equal(result.state, 'succeeded', JSON.stringify(result.error));
  const manifest = await pipeline.validate(result.manifestPath, { deep: true });
  evidence.generated.push({ ...result, totals: manifest.validation.totals, runtime: manifest.runtime,
    artifacts: manifest.artifacts, deepSceneAudit: 'passed', exportedBytesReimported: true });
}
for (const path of ['asset.glb', 'collision.glb', 'asset-lod1.glb']) {
  const original = evidence.generated[0].artifacts.find(a => a.path === path), repeat = evidence.generated[2].artifacts.find(a => a.path === path);
  assert.equal(original.sha256, repeat.sha256, 'Same template request must reproduce GLB geometry bytes: ' + path);
}
evidence.checks.deterministicGlb = true;
evidence.checks.binaryDeterminismLimits = 'BLEND/FBX files include per-run paths or metadata; their bit identity is not claimed.';
let cancelling;
cancelling = pipeline.start({ template: 'hero-prop', name: 'cancel-native', renderResolution: 1024, renderSamples: 64 }, { onEvent: e => {
  console.log(JSON.stringify(e));
  if (e.stage === 'review-render') cancelling.cancel();
} });
assert.throws(() => pipeline.start({ template: 'hero-prop', name: 'busy-native' }), e => e instanceof AssetError && e.code === 'BUSY');
const cancelled = await cancelling.completion;
assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.manifestPath, null);
const recovered = await pipeline.recover(cancelling.directory);
assert.equal(recovered.result.state, 'cancelled'); assert.ok(recovered.checkpointPath);
evidence.checks.nativeCancellation = cancelled; evidence.checks.cancelledCheckpointRecovery = recovered;
const timeout = await pipeline.start({ template: 'hero-prop', name: 'deadline-native' }, { deadlineMs: 50 }).completion;
assert.equal(timeout.state, 'timed_out'); evidence.checks.nativeDeadline = timeout;
const budget = await pipeline.start({ template: 'hero-prop', name: 'over-budget-native', triangleBudget: 100 }).completion;
assert.equal(budget.state, 'failed'); assert.equal(budget.manifestPath, null);
const failedAudit = JSON.parse(await readFile(join(budget.directory, 'audit.json'), 'utf8'));
assert.ok(failedAudit.errors.some(e => e.includes('budget')));
evidence.checks.nativeBudgetGate = { ...budget, auditErrors: failedAudit.errors };
const service = await createAssetService({ cwd: root, projectPath: resolve(root, '..', 'unselected-project'), outputRoot });
const routes = assetRoutes(service), controlToken = randomBytes(32).toString('hex'), agentToken = randomBytes(32).toString('hex');
let origin = '';
const server = createServer(async (req, res) => {
  if (!await routes(req, res, new URL(req.url ?? '/', origin), controlToken, origin, agentToken)) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
const call = (route, method = 'GET', body, token = agentToken) => fetch(origin + '/v1/assets/' + route, { method,
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
try {
  assert.equal((await fetch(origin + '/v1/assets/jobs')).status, 401);
  const probe = await call('probe', 'POST', {}); assert.equal(probe.status, 200); assert.equal((await probe.json()).probe.available, true);
  const started = await call('start', 'POST', { template: 'environment-kit', name: 'http-native', renderResolution: 128, renderSamples: 4 });
  assert.equal(started.status, 202); const { job } = await started.json();
  const end = Date.now() + 180000;
  let current;
  while (Date.now() < end) {
    const listed = await call('jobs'); assert.equal(listed.status, 200);
    current = (await listed.json()).jobs.find(j => j.jobId === job.jobId);
    if (current.state !== 'running') break;
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(current.state, 'succeeded'); assert.equal(current.manifestAvailable, true);
  const manifestResponse = await call('manifest?jobId=' + job.jobId); assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()).manifest; assert.equal(manifest.jobId, job.jobId);
  for (const token of [controlToken, agentToken]) {
    const png = await call('preview?jobId=' + job.jobId + '&path=preview-hero.png', 'GET', undefined, token);
    assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), await readFile(join(current.directory, 'preview-hero.png')));
  }
  const changedPath = join(current.directory, 'preview-hero.png'), original = await readFile(changedPath);
  try {
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1; await writeFile(changedPath, corrupt);
    assert.equal((await call('preview?jobId=' + job.jobId + '&path=preview-hero.png')).status, 422);
  } finally { await writeFile(changedPath, original); }
  evidence.checks.nativeHttp = { jobId: job.jobId, manifestPath: current.manifestPath, observedEvents: current.events, controlAndAgentPngBytesMatched: true, changedPreviewRefused: true };
} finally {
  server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await service.close();
}
const restarted = await createAssetService({ cwd: root, outputRoot });
try {
  assert.equal(restarted.jobs().filter(j => j.state === 'succeeded').length, 4);
  assert.equal(restarted.jobs().find(j => j.jobId === evidence.checks.nativeHttp.jobId).events.length, evidence.checks.nativeHttp.observedEvents.length);
  evidence.checks.indexedRestart = { jobs: restarted.jobs().length, verifiedSucceededJobs: 4, observedEventsRetained: true };
} finally { await restarted.close(); }
await writeFile(join(outputRoot, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ nativeAcceptance: 'passed', evidencePath: join(outputRoot, 'acceptance.json') }));
