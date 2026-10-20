import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit } from '../../packages/asset-pipeline/testing/fixture.js';
import { AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { MODEL_WORKER_SCRIPTS, normalizeModelSpec } from '../../packages/asset-pipeline/src/model-spec.js';
import { proceduralRenderSourceKeys, proceduralSurfaceMaterials, proceduralSurfacePattern } from '../../packages/asset-pipeline/src/procedural.js';
import { MATERIAL_WORKER_SCRIPTS, UV_WORKER_SCRIPTS, validateAudit, workerScripts } from '../../packages/asset-pipeline/src/validation.js';
import { assetInput, assetRequest } from '../../apps/mcp/src/asset-schemas.js';
import { proceduralInput, proceduralStartBody, specReview } from '../../apps/mcp/src/procedural-tools.js';
import type { DaemonClient } from '../../apps/mcp/src/daemon-client.js';

const FIXTURES = resolve('tests/fixtures/model-specs');
const fixtures = readdirSync(FIXTURES).filter(name => name.endsWith('.json')).sort()
  .map(name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { name: string; triangleBudget: number; spec: Record<string, unknown> });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const input = (fixture: (typeof fixtures)[number]) => ({ template: 'procedural', name: fixture.name, triangleBudget: fixture.triangleBudget, procedural: clone(fixture.spec) });
const refused = (message: string) => (e: unknown): boolean => e instanceof AssetError && e.code === 'INPUT' && e.message.startsWith('Model spec: ') && e.message.includes(message);

test('the eight fixture specs normalize canonically, explicitly and idempotently', () => {
  assert.equal(fixtures.length, 8);
  for (const fixture of fixtures) {
    const request = normalizeRequest(input(fixture)), spec = request.procedural!;
    assert.equal(spec.kind, 'spec', fixture.name);
    if (spec.kind !== 'spec') continue;
    assert.equal(spec.finish, 'natural');
    assert.deepEqual(request.sizeMeters, fixture.spec.size);
    assert.deepEqual(request.color, spec.materials[0]!.color);
    for (const m of spec.materials) assert.deepEqual(Object.keys(m), ['id', 'finish', 'color', 'roughness', 'metallic', 'wear', 'cavity']);
    // Stored requests re-normalize to themselves (manifest/request provenance relies on it).
    assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(request))), request, fixture.name);
    assert.deepEqual(proceduralRenderSourceKeys(spec), spec.materials.map(m => m.id));
  }
  const lantern = normalizeRequest(input(fixtures.find(f => f.name === 'iron-lantern')!));
  const { triangleBudget: _budget, ...unbudgeted } = input(fixtures[0]!);
  assert.equal(normalizeRequest(unbudgeted).triangleBudget, 8000);
  assert.equal(lantern.triangleBudget, 9000);
});

test('spec materials bake one 512 px PBR atlas each with explicit values and spec patterns', () => {
  const sword = normalizeRequest(input(fixtures.find(f => f.name === 'runed-sword')!)), spec = sword.procedural!;
  const rows = proceduralSurfaceMaterials(spec, sword.color);
  assert.deepEqual(rows.map(r => r.id), ['Steel', 'Gold', 'Leather']);
  assert.deepEqual(rows[0], { id: 'Steel', color: [0.62, 0.63, 0.66], metallic: 1, roughness: 0.28, surface: { profile: 'weathered', resolution: 512 } });
  assert.equal(rows[2]!.surface!.profile, 'weathered');
  assert.equal(proceduralSurfacePattern(spec, 'Leather'), 'spec-leather');
  assert.equal(proceduralSurfacePattern(spec, 'Nope'), undefined);
  const flat = normalizeRequest({ ...input(fixtures[0]!), procedural: { ...clone(fixtures[0]!.spec), finish: 'flat' } });
  assert.deepEqual(proceduralSurfaceMaterials(flat.procedural!, flat.color), []);
  // Compiler modules ship flat after the shared worker files, only for spec jobs; a natural spec also ships
  // the material library (the worker infers a family for every unnamed slot), a flat one only when it names one.
  const scripts = workerScripts(sword);
  assert.deepEqual(scripts.slice(-MODEL_WORKER_SCRIPTS.length - MATERIAL_WORKER_SCRIPTS.length), [...MODEL_WORKER_SCRIPTS, ...MATERIAL_WORKER_SCRIPTS]);
  assert.ok(MODEL_WORKER_SCRIPTS.includes('model_materials.py'));
  assert.ok(!workerScripts(flat).some(name => MATERIAL_WORKER_SCRIPTS.includes(name)));
  assert.ok(UV_WORKER_SCRIPTS.every(name => scripts.includes(name)));
  assert.ok(!workerScripts(normalizeRequest({ template: 'procedural', name: 'oak', procedural: { kind: 'tree' } })).some(name => name.startsWith('model_')));
});

test('invalid specs are refused before Blender with the worker validator messages', () => {
  const base = fixtures.find(f => f.name === 'stone-arch')!.spec as { materials: Record<string, unknown>[]; parts: Record<string, unknown>[] };
  const material = (base.materials[0] as { id: string }).id;
  const cases: [(s: typeof base) => void, string][] = [
    [s => { s.parts[0]!.color = [1, 0, 0]; }, 'unsupported field'],
    [s => { s.parts[0]!.material = 'gold'; }, 'material must name'],
    [s => { s.parts[0]!.op = 'teapot'; }, '.op must be one of'],
    [s => { s.parts.push({ ...s.parts[0]! }); }, 'part ids must be unique'],
    [s => { s.parts[0]!.parent = s.parts[0]!.id; }, 'cannot name itself'],
    [s => { s.materials = [0, 1, 2, 3].map(k => ({ id: 'm' + k, finish: 'wood' })); }, 'materials needs 1..3'],
    [s => { s.parts.push({ id: 'x', op: 'box', material, size: [1, 1, 1], bevel: .6 }); }, 'bevel must be less than half'],
    [s => { s.parts.push({ id: 'x', op: 'loft', material, sections: [{ z: 1, shape: { type: 'circle', r: .1 } }, { z: 0, shape: { type: 'circle', r: .1 } }] }); }, 'strictly ascend'],
    [s => { s.parts.push({ id: 'x', op: 'sphere', material, radius: .01, mirror: 'x', scatter: { on: s.parts[0]!.id, count: 4 } }); }, 'scatter cannot combine'],
    [s => { s.parts.push({ id: 'x', op: 'box', material, size: [.01, .01, .01], array: { grid: [10, 10, 10], step: [.02, .02, .02] } }); }, 'more than 640 instances'],
    [s => { s.parts.push({ id: 'x', op: 'revolve', material, profile: [[0, 0], [.1, 0], [0, .1], [.1, .2], [0, .2]] }); }, 'interior radii'],
    [s => { s.parts.push({ id: 'x', op: 'sdf', material, shapes: [{ prim: 'sphere', r: .1, op: 'subtract' }] }); }, 'first sdf primitive'],
    [s => { s.materials.push({ id: 'spare', finish: 'metal' }); }, 'not used by any solid part'],
    [s => { s.parts[0]!.parent = 'ghost'; }, 'unknown part'],
    [s => { s.parts.push({ id: 'x', op: 'box', material, size: [1, 1, 1], radius: 2 }); }, 'does not take radius'],
  ];
  for (const [mutate, message] of cases) {
    const spec = clone(base); mutate(spec);
    assert.throws(() => normalizeModelSpec(spec), refused(message), message);
  }
  assert.throws(() => normalizeRequest({ template: 'procedural', name: 'arch', procedural: { ...clone(base), variant: [1, 3] } }), /no variant family/);
});

test('detail controls normalize canonically and refuse misuse with worker messages', () => {
  const arch = clone(fixtures.find(f => f.name === 'stone-arch')!.spec) as { materials: Record<string, unknown>[]; parts: Record<string, unknown>[]; autoDetail?: boolean };
  arch.autoDetail = false;
  arch.materials[0]!.library = 'stone-sandstone';
  arch.materials[0]!.glow = 2;
  arch.parts[0]!.blocks = { course: .3, mortar: .01 };
  arch.parts.push({ id: 'stud', op: 'sphere', material: 'granite', radius: .02, at: [0, -.32, 1], surface: { on: 'wall', protrude: .01 } });
  const spec = normalizeModelSpec(arch);
  assert.equal(spec.autoDetail, false);
  assert.deepEqual(Object.keys(spec.materials[0]!), ['id', 'finish', 'color', 'roughness', 'metallic', 'wear', 'cavity', 'library', 'glow']);
  assert.deepEqual(spec.parts[0]!.blocks, { course: .3, mortar: .01 });
  assert.deepEqual(spec.parts.at(-1)!.surface, { on: 'wall', protrude: .01 });
  assert.deepEqual(normalizeModelSpec(JSON.parse(JSON.stringify(spec))), spec);
  for (const [mutate, message] of [
    [(s: typeof arch) => { s.parts[5]!.blocks = true; }, 'blocks (masonry courses) needs a box part'],
    [(s: typeof arch) => { s.materials[0]!.library = 'Stone Ashlar'; }, 'library must be a library material name'],
    [(s: typeof arch) => { s.materials[0]!.glow = 11; }, 'glow must be a number in 0..10'],
    [(s: typeof arch) => { s.parts.at(-1)!.surface = { on: 'ghost' }; }, 'surface.on names an unknown part'],
    [(s: typeof arch) => { s.parts[0]!.surface = 'yes'; }, 'surface must be true or false'],
  ] as [(s: typeof arch) => void, string][]) {
    const bad = clone(arch); mutate(bad);
    assert.throws(() => normalizeModelSpec(bad), refused(message), message);
  }
  const lantern = fixtures.find(f => f.name === 'iron-lantern')!;
  const glowing = clone(lantern.spec) as { materials: Record<string, unknown>[] };
  glowing.materials[1]!.glow = 4;
  assert.equal(proceduralInput.safeParse({ name: 'lantern', generator: { ...glowing, autoDetail: true } }).success, true);
  // Glow is a lit look plus Neon/PointLight hints: the material contract stays non-emissive.
  const rows = proceduralSurfaceMaterials(normalizeRequest({ ...input(lantern), procedural: glowing }).procedural!, [1, 1, 1]);
  assert.ok(rows.every(r => r.emission === undefined));
});

test('assets_procedural advertises a compact spec generator that maps onto the host normalizer', () => {
  const crate = fixtures.find(f => f.name === 'supply-crate')!;
  const parsed = proceduralInput.parse({ name: crate.name, generator: clone(crate.spec), triangleBudget: crate.triangleBudget, seed: 4 });
  const body = proceduralStartBody(parsed);
  assert.equal((body.procedural as { finish: string }).finish, 'natural');
  assert.equal(assetInput.safeParse(body).success, true);
  const request = normalizeRequest(body);
  assert.equal(request.seed, 4);
  assert.equal(assetRequest.safeParse(request).success, true, 'MCP request schema accepts normalized spec requests');
  for (const generator of [{ kind: 'spec' }, { ...clone(crate.spec), extra: 1 }, { ...clone(crate.spec), materials: [] },
    { ...clone(crate.spec), materials: [{ id: 'Pine', finish: 'wood' }] }, { ...clone(crate.spec), materials: [{ id: 'pine', finish: 'unobtainium' }] }])
    assert.equal(proceduralInput.safeParse({ name: 'x', generator }).success, false, JSON.stringify(generator).slice(0, 80));
});

test('spec audits require one textured mesh per material slot and keep the review metrics', () => {
  const bench = fixtures.find(f => f.name === 'park-bench')!;
  const request = normalizeRequest({ ...input(bench), renderResolution: 128, procedural: { ...clone(bench.spec), finish: 'flat' } });
  const a = audit(), base = a.meshes[0]!;
  a.template = 'procedural';
  a.meshes = [{ ...base, name: 'SM_park-bench_teak', materials: ['MAT_Teak'] }, { ...base, name: 'SM_park-bench_iron', materials: ['MAT_Iron'] }, a.meshes[1]!];
  a.totals = { renderTriangles: 8, lod1Triangles: 0, collisionTriangles: 4, materials: 2 };
  a.exports = a.exports.map(e => e.path === 'collision.glb' ? e : { ...e, triangles: 8, objects: 2, materials: 2 });
  a.review = { watertight: true, floating: [], hints: [] };
  const checked = validateAudit(a, request);
  assert.deepEqual(checked.review, a.review);
  a.meshes = [a.meshes[0]!, a.meshes[2]!]; a.totals = { renderTriangles: 4, lod1Triangles: 0, collisionTriangles: 4, materials: 1 };
  a.exports = a.exports.map(e => e.path === 'collision.glb' ? e : { ...e, triangles: 4, objects: 1, materials: 1 });
  assert.throws(() => validateAudit(a, request), /generator contract/);
});

test('assets_preview returns a compact spec review from the manifest, never failing without one', async () => {
  const review = { size: { ratio: [1, 1, 1] }, watertight: true, floating: [{ part: 'arm#0', gap: .01 }], hints: ['move arm'], parts: { arm: { instances: 2, triangles: 300 } },
    uv: { stage: { teak: 'bundled' }, texelsPerMetre: 120, candidates: { teak: [] }, quality: { teak: {} } }, internal: 'dropped' };
  const client = (value: unknown) => ({ assetsManifest: async () => value }) as unknown as Pick<DaemonClient, 'assetsManifest'>;
  const out = await specReview(client({ manifest: { validation: { review } } }), 'job', { timeoutMs: 1000 });
  assert.deepEqual(out, { size: review.size, watertight: true, floating: review.floating, uv: { stage: { teak: 'bundled' }, texelsPerMetre: 120 }, parts: review.parts, hints: review.hints });
  assert.equal(await specReview(client({ manifest: { validation: {} } }), 'job', { timeoutMs: 1000 }), undefined);
  const broken = { assetsManifest: async () => { throw new Error('daemon down'); } } as unknown as Pick<DaemonClient, 'assetsManifest'>;
  assert.equal(await specReview(broken, 'job', { timeoutMs: 1000 }), undefined);
});
