import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';
import { parseConvertedGlbCreation, makeConvertedGlbCreation, parseConvertedGlbJobMetadata, type ConvertedGlbCreation } from '../../packages/asset-pipeline/src/converted-glb-creation.js';
import { parseConvertedGlbRequest } from '../../packages/asset-pipeline/src/converted-glb.js';
import { parseConvertedGlbJson } from '../../packages/asset-pipeline/src/converted-glb-manifest.js';

const JOB = '11111111-1111-4111-8111-111111111111', PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
function creation(): ConvertedGlbCreation {
  return { schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId: JOB, parentJobId: PARENT,
    parentManifestSha256: 'a'.repeat(64), name: 'forest-card', collision: 'none', renderResolution: 256, renderSamples: 8 };
}
function request() {
  const c = creation();
  return { schemaVersion: 2, kind: 'converted-glb', fidelityPolicy: 'arcane-static-fidelity-v1', jobId: c.jobId,
    parentJobId: c.parentJobId, parentManifestSha256: c.parentManifestSha256, name: c.name, collision: c.collision,
    renderResolution: c.renderResolution, renderSamples: c.renderSamples, sourceSha256: 'b'.repeat(64), sourceBytes: 256,
    importSha256: 'c'.repeat(64), importBytes: 512, sourceMapSha256: 'd'.repeat(64) };
}
function journal(fields: Record<string, unknown> = {}) {
  return { schemaVersion: 1, kind: 'converted-glb', jobId: JOB, state: 'failed', request: null, creation: creation(), ...fields };
}
const refused = (error: unknown) => error instanceof AssetError && error.code === 'ASSET_CONVERSION_CREATION' &&
  error.message === 'Conversion creation metadata is missing, malformed or inconsistent.';

test('creation is a detached frozen nine-scalar descriptor, not a complete conversion request or authority record', () => {
  const original = creation(), parsed = parseConvertedGlbCreation(original);
  assert.notEqual(parsed, original); assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(Object.keys(parsed).sort(), ['schemaVersion', 'kind', 'jobId', 'parentJobId', 'parentManifestSha256',
    'name', 'collision', 'renderResolution', 'renderSamples'].sort());
  assert.ok(Object.values(parsed).every(value => typeof value === 'string' || typeof value === 'number'));
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) <= 1024);
  assert.throws(() => parseConvertedGlbRequest(parsed), AssetError);
  assert.throws(() => parseConvertedGlbCreation({ ...request(), schemaVersion: 1 }), refused);
  const seed = { parentJobId: parsed.parentJobId, parentManifestSha256: parsed.parentManifestSha256, name: parsed.name,
    collision: parsed.collision, renderResolution: parsed.renderResolution, renderSamples: parsed.renderSamples };
  assert.deepEqual(makeConvertedGlbCreation(OTHER, seed), { ...parsed, jobId: OTHER });
  assert.throws(() => makeConvertedGlbCreation(PARENT, seed), refused);
});

test('exported maker accepts only an own scalar seed and never evaluates proxy/getter or caller identity fields', () => {
  let calls = 0;
  const c = creation(), seed = { parentJobId: c.parentJobId, parentManifestSha256: c.parentManifestSha256, name: c.name,
    collision: c.collision, renderResolution: c.renderResolution, renderSamples: c.renderSamples };
  const proxy = new Proxy(seed, { ownKeys() { calls++; throw Error('private trap'); }, get() { calls++; throw Error('private trap'); } });
  const getter = Object.defineProperty({ ...seed }, 'parentJobId', { enumerable: true, get() { calls++; throw Error('private getter'); } });
  assert.throws(() => makeConvertedGlbCreation(JOB, proxy), refused);
  assert.throws(() => makeConvertedGlbCreation(JOB, getter), refused);
  for (const extra of [{ jobId: OTHER }, { sourceGlb: Buffer.alloc(20) }, { approved: true }])
    assert.throws(() => makeConvertedGlbCreation(JOB, { ...seed, ...extra }), refused);
  assert.equal(calls, 0); assert.deepEqual(makeConvertedGlbCreation(JOB, seed), c);
});

test('creation refuses missing/unknown authority and source fields instead of manufacturing prepared evidence', () => {
  for (const key of Object.keys(creation())) {
    const changed: Record<string, unknown> = { ...creation() }; delete changed[key];
    assert.throws(() => parseConvertedGlbCreation(changed), refused, key);
  }
  for (const key of ['path', 'sourceGlb', 'sourceSha256', 'importSha256', 'sourceMapSha256', 'runtime', 'workers',
    'approved', 'ownedProcessClosed', 'conversation', 'projectId', 'permission', 'fidelityPolicy'])
    assert.throws(() => parseConvertedGlbCreation({ ...creation(), [key]: 'private-value' }), refused, key);
});

test('creation rejects proxies/accessors/prototypes/symbols/hidden fields without invoking caller code', () => {
  let calls = 0;
  const proxy = new Proxy({}, { ownKeys() { calls++; throw Error('private trap'); }, getPrototypeOf() { calls++; throw Error('private trap'); } });
  assert.throws(() => parseConvertedGlbCreation(proxy), refused);
  const getter = Object.defineProperty({ ...creation() }, 'name', { enumerable: true, get() { calls++; throw Error('private getter'); } });
  assert.throws(() => parseConvertedGlbCreation(getter), refused);
  assert.throws(() => parseConvertedGlbCreation(Object.assign(Object.create({ inherited: true }) as object, creation())), refused);
  assert.throws(() => parseConvertedGlbCreation({ ...creation(), [Symbol('private')]: true }), refused);
  const hidden = Object.defineProperty({ ...creation() }, 'name', { enumerable: false, value: 'forest-card' });
  assert.throws(() => parseConvertedGlbCreation(hidden), refused);
  assert.equal(calls, 0);
  assert.deepEqual(parseConvertedGlbCreation(Object.assign(Object.create(null) as object, creation())), creation());
});

test('creation enforces exact lowercase identities, slug and finite render bounds', () => {
  const mutations: Record<string, unknown>[] = [
    { schemaVersion: 2 }, { kind: 'converted-glb' }, { jobId: PARENT }, { jobId: JOB + '\n' }, { parentJobId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { parentManifestSha256: 'A'.repeat(64) }, { parentManifestSha256: 'a'.repeat(64) + '\n' },
    { name: 'forest-card\n' }, { name: 'con' }, { name: '../forest' }, { name: 'a'.repeat(49) },
    { renderResolution: 127 }, { renderResolution: 1025 }, { renderResolution: 128.5 }, { renderResolution: Infinity },
    { renderSamples: 0 }, { renderSamples: 65 }, { renderSamples: NaN }, { collision: 'caller-proxy' },
  ];
  for (const changed of mutations) assert.throws(() => parseConvertedGlbCreation({ ...creation(), ...changed }), refused);
  assert.equal(parseConvertedGlbCreation({ ...creation(), renderResolution: 128, renderSamples: 1 }).renderResolution, 128);
  assert.equal(parseConvertedGlbCreation({ ...creation(), collision: 'convex-hull', renderResolution: 1024, renderSamples: 64 }).renderSamples, 64);
});

test('metadata discriminates real pending/prepared and both explicit legacy absences without backfill', () => {
  const pending = parseConvertedGlbJobMetadata(journal());
  assert.equal(pending.form, 'new-pending'); assert.equal(pending.name, 'forest-card'); assert.equal(pending.request, null);
  assert.ok(Object.isFrozen(pending) && Object.isFrozen(pending.creation));
  const prepared = parseConvertedGlbJobMetadata(journal({ request: request() }));
  assert.equal(prepared.form, 'new-prepared'); assert.ok(Object.isFrozen(prepared.request));
  const legacyPending = journal(); delete (legacyPending as Record<string, unknown>).creation;
  const before = JSON.stringify(legacyPending), parsedPending = parseConvertedGlbJobMetadata(legacyPending);
  assert.equal(parsedPending.form, 'legacy-pending'); assert.equal(parsedPending.name, null);
  assert.equal(parsedPending.creation, null); assert.equal(parsedPending.request, null);
  assert.equal(JSON.stringify(legacyPending), before); assert.equal(Object.hasOwn(legacyPending, 'creation'), false);
  const legacyPrepared = { ...legacyPending, request: request(), state: 'succeeded' };
  const parsedPrepared = parseConvertedGlbJobMetadata(legacyPrepared);
  assert.equal(parsedPrepared.form, 'legacy-prepared'); assert.equal(parsedPrepared.creation, null); assert.equal(parsedPrepared.name, 'forest-card');
});

test('present malformed creation and succeeded/null request never fall through to legacy', () => {
  for (const invalid of [null, undefined, {}, { ...creation(), schemaVersion: 2 }, { ...creation(), approved: true }])
    assert.throws(() => parseConvertedGlbJobMetadata(journal({ creation: invalid })), refused);
  for (const fields of [{ request: null, state: 'succeeded' }, { jobId: OTHER }, { kind: 'adopted-glb' }, { name: 'wrong-name' }])
    assert.throws(() => parseConvertedGlbJobMetadata(journal(fields)), refused);
  const missing: Record<string, unknown> = journal(); delete missing.request;
  assert.throws(() => parseConvertedGlbJobMetadata(missing), refused);
  const legacy: Record<string, unknown> = journal({ state: 'succeeded' }); delete legacy.creation;
  assert.throws(() => parseConvertedGlbJobMetadata(legacy), refused);
});

test('every prepared overlap and outer job/name identity must agree with immutable creation', () => {
  for (const change of [{ jobId: OTHER }, { parentJobId: OTHER }, { parentManifestSha256: 'e'.repeat(64) }, { name: 'other' },
    { collision: 'convex-hull' }, { renderResolution: 512 }, { renderSamples: 16 }])
    assert.throws(() => parseConvertedGlbJobMetadata(journal({ request: { ...request(), ...change } })), refused);
  assert.throws(() => parseConvertedGlbJobMetadata(journal({ request: { ...request(), schemaVersion: 1 } })), refused);
  assert.throws(() => parseConvertedGlbJobMetadata(journal({ request: { ...request(), fidelityPolicy: 'caller-policy' } })), refused);
  assert.equal(parseConvertedGlbJobMetadata(journal({ request: request(), name: 'forest-card' })).form, 'new-prepared');
});

test('metadata refuses nested traps and oversized escaped journal data without obtaining worker authority', () => {
  let calls = 0;
  const worker = Object.defineProperty({}, 'state', { enumerable: true, get() { calls++; throw Error('private getter'); } });
  const proxy = new Proxy({}, { ownKeys() { calls++; throw Error('private trap'); } });
  for (const fields of [{ workers: [worker] }, { request: proxy }, { creation: proxy }])
    assert.throws(() => parseConvertedGlbJobMetadata(journal(fields)), refused);
  assert.equal(calls, 0);
  assert.throws(() => parseConvertedGlbJobMetadata(journal({ workers: [{ note: '\u0000'.repeat(100000) }] })), refused);
  const sparse = new Array<unknown>(1); Object.defineProperty(sparse, '0\n', { enumerable: true, value: null });
  assert.throws(() => parseConvertedGlbJobMetadata(journal({ workers: sparse })), refused);
  const unresolved = { schemaVersion: 1, role: 'generate', state: 'reserved', reservationId: OTHER };
  const value = parseConvertedGlbJobMetadata(journal({ workers: [unresolved] }));
  assert.deepEqual(Object.keys(value).sort(), ['form', 'jobId', 'name', 'creation', 'request'].sort());
  assert.equal('ownedProcessClosed' in value, false); assert.equal('workers' in value, false);
});

test('raw metadata reads require duplicate-safe bytes and never accept overwritten creation or request keys', () => {
  const raw = JSON.stringify(journal());
  for (const changed of [raw.replace('"creation":', '"creation":null,"creation":'),
    raw.replace('"request":null', '"request":{},"request":null')])
    assert.throws(() => parseConvertedGlbJobMetadata(parseConvertedGlbJson(Buffer.from(changed))), AssetError);
});
