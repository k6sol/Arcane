import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetJob, assetJobPage, assetManifest, nativeAssetJobPage } from '../../apps/mcp/src/asset-schemas.js';
import { compactAssetJob, compactAssetJobPage } from '../../apps/mcp/src/token-lean.js';
import { readAssetJob, readAssetConversationPage, assetJobName, assetJobKind, assetManifestMatchesJob } from '../../apps/desktop/src/studio.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import { hostFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import { parseConvertedGlbCreation } from '../../packages/asset-pipeline/src/converted-glb-creation.js';
import { convertedGlbAssetId, convertedGlbObjectId, GLB_CONVERSION_WORKERS } from '../../packages/asset-pipeline/src/converted-glb.js';
import { conversionCorrespondenceSha256 } from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';

// Data-only wire fixtures. No file inventory, native process, owned close,
// human review or Studio import is established by these synthetic statements.
const JOB = '11111111-1111-4111-8111-111111111111', PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333', HASH = 'a'.repeat(64), AT = '2026-10-27T00:00:00.000Z';
const ROOT = process.platform === 'win32' ? 'C:\\synthetic-conversion' : '/synthetic-conversion';
const POLICY = 'arcane-static-fidelity-v1';
const scope = { projectId: HASH, projectPath: ROOT, conversation: { provider: 'codex', threadId: 'wire-fixture', sessionId: null } };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function creation() {
  return parseConvertedGlbCreation({ schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId: JOB,
    parentJobId: PARENT, parentManifestSha256: HASH, name: 'converted-fern', collision: 'none', renderResolution: 128, renderSamples: 8 });
}
function request() {
  const c = creation();
  return { schemaVersion: 2, fidelityPolicy: POLICY, kind: 'converted-glb', jobId: JOB, parentJobId: PARENT,
    parentManifestSha256: HASH, name: c.name, collision: c.collision, renderResolution: c.renderResolution, renderSamples: c.renderSamples,
    sourceSha256: HASH, sourceBytes: 256, importSha256: HASH, importBytes: 256, sourceMapSha256: HASH };
}
const forms = ['new-pending', 'new-prepared', 'legacy-pending', 'legacy-prepared'] as const;
function job(form: typeof forms[number] = 'new-pending') {
  return { schemaVersion: 1, jobId: JOB, directory: ROOT, manifestPath: null, error: null, state: 'failed', stage: 'input',
    startedAt: AT, updatedAt: AT, events: [], manifestAvailable: false, kind: 'converted-glb', form,
    ...(form.startsWith('new-') ? { creation: creation() } : {}), request: form.endsWith('pending') ? null : request() };
}
function manifest() {
  const r = request(), sourceKey = 'node0_primitive0', originMarker = `glb_${HASH}:0:0`;
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const objectId = convertedGlbObjectId(HASH, 'render', sourceKey);
  const part = { sourceNodeIndex: 0, sourceMeshIndex: 0, sourcePrimitiveIndex: 0, sourceMaterialIndex: null,
    sourceKey, importNodeIndex: 1, originMarker, worldMatrix: matrix, triangles: 1, vertexCount: 3 };
  const sourceMap = { schemaVersion: 2, fidelityPolicy: POLICY, sourceSha256: HASH, importSha256: HASH, sourceSceneIndex: 0,
    declaredSceneCount: 1, parts: [part], nodes: [{ nodeKey: 'node0', importNodeIndex: 0, parentKey: null, localMatrix: matrix },
      { nodeKey: sourceKey, importNodeIndex: 1, parentKey: 'node0', localMatrix: matrix }] };
  const measured = { sourceKey, originMarker, sourceObjectId: objectId, vertices: 3, triangles: 1, boundaryEdges: 3, nonManifoldEdges: 3,
    looseVertices: 0, looseEdges: 0, degenerateFaces: 0, invalidUVs: 0, uvLayers: 0, finitePositions: true,
    geometrySha256: sha('synthetic measurement, not native proof'), correspondenceSha256: conversionCorrespondenceSha256([[0, 1, 2]]), materialSha256: sha('synthetic material') };
  const validation = { schemaVersion: 2, fidelityPolicy: POLICY, kind: 'arcane-glb-conversion-audit', jobId: JOB, parentJobId: PARENT,
    parentManifestSha256: HASH, requestSha256: HASH, sourceSha256: HASH, importSha256: HASH, sourceMapSha256: HASH,
    identityScheme: 'arcane-converted-v2', assetId: convertedGlbAssetId(HASH), blenderVersion: 'synthetic-wire-fixture', collision: 'none',
    importedParts: [measured], reopenedParts: [structuredClone(measured)],
    models: [{ path: 'asset.glb', sha256: HASH, byteLength: 256, generator: 'synthetic wire fixture', objects: [
      { sourceObjectId: objectId, sourceKey, nodeIndex: 1, role: 'render', pivot: [0, 0, 0], collisionFor: [], originMarker }], anchors: [] }],
    renders: ['preview-hero.png', 'preview-side.png'].map(path => ({ path, width: 128, height: 128, finitePixels: true,
      minLuminance: 0, maxLuminance: 1, meanLuminance: .4, standardDeviation: .1 })),
    savedSceneReopened: true, errors: [], warnings: ['open-render-surfaces', 'delivery-support-pending', 'no-collision-proxy'] };
  const roles = { 'source.glb': 'request', 'import-source.glb': 'request', 'parent-manifest.json': 'request', 'source-map.json': 'request',
    'request.json': 'request', 'convert_glb.py': 'worker', 'conversion_audit.py': 'worker', 'probe.py': 'worker', 'asset.blend': 'scene',
    'asset.glb': 'export', 'conversion-audit.json': 'audit', 'preview-hero.png': 'preview', 'preview-side.png': 'preview' };
  return { schemaVersion: 2, origin: 'converted-glb', jobId: JOB, createdAt: AT, request: r,
    runtime: { executable: ROOT + '/never-launched', version: validation.blenderVersion, pythonVersion: 'synthetic', background: true,
      capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } },
    workerBundleSha256: sha(GLB_CONVERSION_WORKERS.map(() => HASH).join('\n')),
    coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', pivot: 'source', robloxScaleVerified: false }, sourceMap, validation,
    artifacts: Object.entries(roles).map(([path, role]) => ({ path, role, bytes: 256, sha256: HASH })),
    limitations: ['Synthetic wire evidence only; review and native import unavailable.'] };
}

test('all four converted forms survive MCP and browser decoding without inventing legacy creation or name', () => {
  for (const form of forms) {
    const original = job(form), parsed = assetJob.parse(original), browser = readAssetJob(original);
    assert.equal(parsed.kind, 'converted-glb'); assert.equal(browser.kind, 'converted-glb');
    assert.deepEqual(parsed.request, original.request); assert.deepEqual(JSON.parse(JSON.stringify(browser.request)), original.request);
    assert.equal(Object.hasOwn(parsed, 'creation'), form.startsWith('new-'));
    assert.equal(Object.hasOwn(browser, 'creation'), form.startsWith('new-'));
    assert.equal(Object.hasOwn(parsed, 'name'), false); assert.equal(Object.hasOwn(browser, 'name'), false);
    assert.equal(assetJobName(browser), form === 'legacy-pending' ? 'Legacy conversion' : 'converted-fern');
    assert.equal(assetJobKind(browser), 'converted-glb');
    const page = { ...scope, jobs: [original], nextCursor: null, byteLimit: 524288 };
    assert.equal(nativeAssetJobPage.parse(page).jobs[0]!.kind, 'converted-glb');
    assert.equal(readAssetConversationPage(page, 1).jobs[0]!.kind, 'converted-glb');
    assert.equal(assetJobPage.parse({ schemaVersion: 1, jobs: [original], total: 1, nextCursor: null, byteLimit: 524288 }).jobs.length, 1);
  }
});

test('converted discriminators and state cannot be stripped into a legacy job or fabricated completion', () => {
  const invalid: unknown[] = [
    { ...job(), form: 'new-prepared' }, { ...job('legacy-pending'), creation: null },
    { ...job('legacy-prepared'), creation: creation() }, { ...job(), kind: 'generated' },
    { ...job(), creation: { ...creation(), approved: true } }, { ...job(), approved: true },
    { ...job(), state: 'succeeded' }, { ...job(), manifestAvailable: true, manifestPath: ROOT + '/manifest.json' },
    { ...job('new-prepared'), state: 'succeeded', manifestAvailable: true, manifestPath: null },
    { ...job('new-prepared'), state: 'succeeded', error: { code: 'BLENDER_FAILED', message: 'Synthetic terminal failure.', diagnostic: hostFailure('export') } },
    { ...job(), reportId: OTHER },
    { ...job(), reportId: OTHER + '\n', error: { code: 'BLENDER_FAILED', message: 'Synthetic correlated failure.' } },
    { ...job(), creation: { ...creation(), jobId: OTHER } },
  ];
  const missing: Record<string, unknown> = { ...job() }; delete missing.creation; invalid.push(missing);
  const generated = normalizeRequest({ template: 'hero-prop', name: 'old-job' });
  invalid.push({ ...job(), request: generated });
  const disguised: Record<string, unknown> = { ...job('legacy-prepared'), request: { ...generated, kind: 'converted-glb' } };
  delete disguised.kind; delete disguised.form; invalid.push(disguised);
  for (const value of invalid) { assert.equal(assetJob.safeParse(value).success, false); assert.throws(() => readAssetJob(value)); }
});

test('every prepared request overlap is checked against creation and exact child identity', () => {
  for (const changed of [{ jobId: OTHER }, { parentJobId: OTHER }, { parentManifestSha256: 'b'.repeat(64) }, { name: 'other-name' },
    { collision: 'convex-hull' }, { renderResolution: 256 }, { renderSamples: 16 }, { schemaVersion: 1 }, { fidelityPolicy: 'caller-policy' }]) {
    const value = { ...job('new-prepared'), request: { ...request(), ...changed } };
    assert.equal(assetJob.safeParse(value).success, false); assert.throws(() => readAssetJob(value));
  }
});

test('converted caller getters are refused without evaluation and MCP rejects proxy records before traps', () => {
  let calls = 0;
  const getter = Object.defineProperty({ ...job() }, 'creation', { enumerable: true, get() { calls++; throw Error('private getter'); } });
  assert.equal(assetJob.safeParse(getter).success, false); assert.throws(() => readAssetJob(getter)); assert.equal(calls, 0);
  const proxy = new Proxy(job(), { ownKeys() { calls++; throw Error('private proxy'); }, get() { calls++; throw Error('private proxy'); } });
  assert.equal(assetJob.safeParse(proxy).success, false); assert.equal(calls, 0);
  for (const value of [Object.assign(Object.create({ inherited: true }) as object, job()), { ...job(), [Symbol('hidden')]: true },
    { ...job(), events: [{ jobId: OTHER, at: AT, stage: 'input', state: 'running' }] }]) {
    assert.equal(assetJob.safeParse(value).success, false); assert.throws(() => readAssetJob(value));
  }
});

test('full conversion failure diagnostics and lineage remain truthful in compact pending and prepared history', () => {
  const error = { code: 'BLENDER_FAILED', message: 'Retained conversion failed; inspect original evidence. '.repeat(5), diagnostic: hostFailure('export') };
  for (const form of forms) {
    const original = { ...job(form), error, reportId: OTHER }, parsed = assetJob.parse(original), browser = readAssetJob(original);
    assert.deepEqual(parsed.error, error); assert.deepEqual(browser.error, error); assert.equal(browser.reportId, OTHER);
    const compact = compactAssetJob(parsed) as Record<string, unknown>;
    assert.equal(compact.kind, 'converted-glb'); assert.equal(compact.form, form); assert.deepEqual(compact.error, error);
    assert.equal(compact.reportId, OTHER);
    assert.deepEqual(compact.request, original.request); assert.equal(Object.hasOwn(compact, 'creation'), form.startsWith('new-'));
    if (form.startsWith('new-')) assert.deepEqual(compact.creation, creation());
    assert.equal(compact.name, form === 'legacy-pending' ? 'Legacy conversion' : 'converted-fern');
    assert.equal(Object.hasOwn(compact, 'directory'), false); assert.equal(Object.hasOwn(compact, 'events'), false);
    const page = compactAssetJobPage({ schemaVersion: 1, jobs: [parsed], byteLimit: 524288, nextCursor: null });
    assert.deepEqual(page.jobs[0], compact);
  }
});

test('full converted manifest uses the existing strict parser and refuses weakened conversion markers', () => {
  const original = manifest(), parsed = assetManifest.parse(original);
  assert.deepEqual(parsed, original);
  assert.ok('origin' in parsed && parsed.origin === 'converted-glb');
  assert.equal(assetManifestMatchesJob(parsed, readAssetJob(job('new-prepared'))), true);
  assert.equal(assetManifestMatchesJob(parsed, readAssetJob(job('legacy-prepared'))), true);
  assert.equal(assetManifestMatchesJob(parsed, readAssetJob(job())), false);
  for (const changed of [{ ...original, schemaVersion: 1 }, { ...original, approved: true },
    { ...original, request: { ...original.request, fidelityPolicy: 'caller-policy' } },
    { ...original, sourceMap: { ...original.sourceMap, nodes: [] } }]) assert.equal(assetManifest.safeParse(changed).success, false);
  const noOrigin: Record<string, unknown> = { ...original }; delete noOrigin.origin;
  assert.equal(assetManifest.safeParse(noOrigin).success, false);
  const differingSettings = assetManifest.parse({ ...original, request: { ...original.request, renderSamples: 16 } });
  assert.equal(assetManifestMatchesJob(differingSettings, readAssetJob(job('new-prepared'))), false);
});

test('generated and adopted serialized job shapes and compact generated summaries remain unchanged', () => {
  for (const request of [normalizeRequest({ template: 'hero-prop', name: 'old-job' }),
    { schemaVersion: 1, template: 'adopted-glb', name: 'old-job', path: 'models/old.glb', sourceSha256: HASH, sourceBytes: 256 }]) {
    const value = { schemaVersion: 1, jobId: JOB, directory: ROOT, manifestPath: null, request, error: null, state: 'failed',
      stage: 'input', startedAt: AT, updatedAt: AT, events: [], manifestAvailable: false };
    const parsed = assetJob.parse(value), browser = readAssetJob(value);
    assert.deepEqual(parsed, value); assert.deepEqual(browser, value);
    for (const key of ['kind', 'form', 'creation']) { assert.equal(Object.hasOwn(parsed, key), false); assert.equal(Object.hasOwn(browser, key), false); }
    const compact = compactAssetJob(parsed) as Record<string, unknown>;
    assert.equal(compact.name, 'old-job'); assert.equal(compact.kind, request.template);
    assert.equal(Object.hasOwn(compact, 'creation'), false); assert.equal(Object.hasOwn(compact, 'request'), false);
  }
});
