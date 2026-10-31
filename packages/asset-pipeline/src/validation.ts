import { isDeepStrictEqual, types as utilTypes } from 'node:util';
import { jsonSnapshot, normalizeRecipe, preflightRecipe, preflightPart, checkSockets, CUSTOM_REQUEST_BYTES } from './recipe.js';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AssetError } from './types.js';
import { normalizeProcedural, proceduralColor, proceduralDefaultBudget, proceduralMinimumTriangles, proceduralRenderSourceKeys, proceduralSize, proceduralSurfaceMaterials, proceduralSurfacePattern, PROCEDURAL_LIMITS, PROCEDURAL_SURFACE_RESOLUTION } from './procedural.js';
import type { AssemblyMaterial, AssetAudit, AssetManifest, AssetRequest, TreeStructureReview } from './types.js';
import { assetName, artifactPath, regularFile, readRegularFile } from './paths.js';
import { decodeMaterialPng } from './material-png.js';
import { MODEL_WORKER_SCRIPTS } from './model-spec.js';

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetError('VALIDATION', `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function integer(v: unknown, low: number, high: number, label: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < low || v > high) throw new AssetError('INPUT', `Invalid ${label}.`);
  return v;
}
function vector(v: unknown, low: number, high: number, label: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < low || n > high)) throw new AssetError('INPUT', `Invalid ${label}.`);
  return [...v] as [number, number, number];
}
export function normalizeRequest(value: unknown): AssetRequest {
  const r = record(jsonSnapshot(value), 'asset request');
  const allowed = ['schemaVersion', 'template', 'name', 'seed', 'sizeMeters', 'color', 'triangleBudget', 'renderResolution', 'renderSamples', 'recipe', 'procedural'];
  if (Object.keys(r).some(k => !allowed.includes(k)) || (r.schemaVersion !== undefined && r.schemaVersion !== 1)) throw new AssetError('INPUT', 'Unsupported asset request field.');
  if (!['hero-prop', 'environment-kit', 'custom-assembly', 'procedural'].includes(String(r.template))) throw new AssetError('INPUT', 'Choose a fixed template, custom-assembly or procedural.');
  if (r.template === 'procedural') return normalizeProceduralRequest(r);
  if (r.procedural !== undefined) throw new AssetError('INPUT', 'Only the procedural template accepts procedural parameters.');
  const budget = integer(r.triangleBudget ?? (r.template === 'custom-assembly' ? 15000 : 5000), 100, 50000, 'triangle budget');
  const recipe = r.template === 'custom-assembly' ? normalizeRecipe(r.recipe, budget) : undefined;
  if (!recipe && r.recipe !== undefined) throw new AssetError('INPUT', 'Only custom-assembly accepts a recipe.');
  const info = recipe ? preflightRecipe(recipe, budget) : undefined;
  const size = info ? info.bounds.max.map((n, i) => n - info.bounds.min[i]!) as [number, number, number] : undefined;
  if (recipe && (r.sizeMeters !== undefined || r.color !== undefined) && (r.schemaVersion !== 1 || !isDeepStrictEqual(r.sizeMeters, size) || !isDeepStrictEqual(r.color, recipe.materials[0]!.color))) throw new AssetError('INPUT', 'Custom geometry size and color come from the recipe.');
  const request: AssetRequest =
  { schemaVersion: 1, template: r.template as AssetRequest['template'], name: assetName(r.name), seed: integer(r.seed ?? 1, 0, 2147483647, 'seed'),
    sizeMeters: vector(size ?? r.sizeMeters ?? (r.template === 'hero-prop' ? [1, 0.65, 0.7] : [3, 3, 2.8]), recipe ? 0.01 : 0.1, recipe ? 40 : 20, 'size in meters'),
    color: vector(recipe?.materials[0]!.color ?? r.color ?? [0.12, 0.32, 0.27], 0, 1, 'color'), triangleBudget: budget,
    renderResolution: integer(r.renderResolution ?? 384, 128, 1024, 'render resolution'), renderSamples: integer(r.renderSamples ?? 16, 4, 64, 'render samples'), ...(recipe ? { recipe } : {}) };
  if (Buffer.byteLength(JSON.stringify(request)) > CUSTOM_REQUEST_BYTES) throw new AssetError('INPUT', 'Normalized recipe exceeds 256 KiB.');
  return request;
}
/** Procedural size is derived from its parameters; colour defaults per kind/species. */
function normalizeProceduralRequest(r: Record<string, unknown>): AssetRequest {
  if (r.recipe !== undefined) throw new AssetError('INPUT', 'Only custom-assembly accepts a recipe.');
  const procedural = normalizeProcedural(r.procedural ?? {}), size = proceduralSize(procedural);
  if (r.sizeMeters !== undefined && !isDeepStrictEqual(r.sizeMeters, size)) throw new AssetError('INPUT', 'Procedural size comes from its generator parameters.');
  const budget = integer(r.triangleBudget ?? proceduralDefaultBudget(procedural), PROCEDURAL_LIMITS.minTriangles, PROCEDURAL_LIMITS.maxTriangles, 'procedural triangle budget (2500..20000)');
  if (budget < proceduralMinimumTriangles(procedural)) throw new AssetError('INPUT', 'This column needs triangleBudget >= ' + proceduralMinimumTriangles(procedural) + ' (or fewer flutes).');
  return { schemaVersion: 1, template: 'procedural', name: assetName(r.name), seed: integer(r.seed ?? 1, 0, 2147483647, 'seed'), sizeMeters: size,
    color: vector(r.color ?? proceduralColor(procedural), 0, 1, 'color'), triangleBudget: budget,
    renderResolution: integer(r.renderResolution ?? 512, 128, 1024, 'render resolution'), renderSamples: integer(r.renderSamples ?? 16, 4, 64, 'render samples'), procedural };
}
export async function readJson(path: string, max = 1024 * 1024): Promise<unknown> {
  await regularFile(path, max);
  try { return JSON.parse((await readRegularFile(path, max)).toString('utf8')); }
  catch { throw new AssetError('VALIDATION', 'Artifact contains invalid JSON.'); }
}
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const TREE_STRUCTURE_WORKER_SCRIPTS: readonly string[] = ['tree_structure_review.py'];
export function isNaturalTreeRequest(request: AssetRequest): boolean {
  return request.template === 'procedural' && request.procedural?.kind === 'tree' && request.procedural.finish === 'natural';
}
function treeStructureRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new AssetError('RENDER', 'Tree structure evidence requires plain data.');
  const descriptors = Object.getOwnPropertyDescriptors(value), ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors, key) || !descriptors[key]!.enumerable || !('value' in descriptors[key]!)))
    throw new AssetError('RENDER', 'Tree structure evidence has unsupported or missing fields.');
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function treeStructureArray(value: unknown, count: number): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== count)
    throw new AssetError('RENDER', 'Tree structure evidence has invalid fixed membership.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== count + 1 || Array.from({ length: count }, (_, index) => String(index)).some(key =>
      !Object.hasOwn(descriptors, key) || !descriptors[key]!.enumerable || !('value' in descriptors[key]!)))
    throw new AssetError('RENDER', 'Tree structure arrays require exact data items.');
  return Array.from({ length: count }, (_, index) => descriptors[String(index)]!.value);
}
/** Decode fixed producer metadata and bind it to the original request and finalized bark audit. */
export function readTreeStructureReview(value: unknown, request: AssetRequest, meshes: readonly unknown[], expectedRequestSha256?: string): TreeStructureReview {
  if (!isNaturalTreeRequest(request)) throw new AssetError('RENDER', 'Tree structure evidence is only supported for natural trees.');
  const review = treeStructureRecord(value, ['schemaVersion', 'path', 'requestSha256', 'sourceObjects', 'views']);
  const [rawSource] = treeStructureArray(review.sourceObjects, 1), source = treeStructureRecord(rawSource, ['sourceKey', 'sourceObjectId', 'geometrySha256']);
  const views = treeStructureArray(review.views, 4), expectedViews = ['front', 'side', 'oblique', 'roots'];
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
  const sourceObjectId = 'arcane_' + sha256(Buffer.from(['arcane-semantic-v1', request.template, request.name, 'render', 'bark'].join('\0')));
  const bark = meshes.map(mesh => record(mesh, 'tree structure source')).filter(mesh => mesh.role === 'render' && mesh.name === 'SM_' + request.name + '_bark');
  if (review.schemaVersion !== 1 || review.path !== 'preview-structure.png' || !hash(review.requestSha256) ||
      expectedRequestSha256 !== undefined && review.requestSha256 !== expectedRequestSha256 ||
      source.sourceKey !== 'bark' || source.sourceObjectId !== sourceObjectId || !hash(source.geometrySha256) ||
      bark.length !== 1 || bark[0]!.geometrySha256 !== source.geometrySha256 || views.some((view, index) => view !== expectedViews[index]))
    throw new AssetError('RENDER', 'Tree structure source, request or fixed views differ from the audited tree.');
  return { schemaVersion: 1, path: 'preview-structure.png', requestSha256: review.requestSha256,
    sourceObjects: [{ sourceKey: 'bark', sourceObjectId, geometrySha256: source.geometrySha256 }], views: ['front', 'side', 'oblique', 'roots'] };
}

export function validateAudit(value: unknown, request: AssetRequest, manifestVersion: AssetManifest['schemaVersion'] = 2, expectedRequestSha256?: string): AssetAudit {
  const audit = record(value, 'asset audit');
  if (audit.schemaVersion !== 1 || audit.template !== request.template || audit.savedSceneReopened !== true || !Array.isArray(audit.errors) || audit.errors.length || !Array.isArray(audit.warnings)) throw new AssetError('MESH', 'Audit did not pass or saved scene was not reopened.');
  if (!Array.isArray(audit.meshes) || audit.meshes.length < 1 || audit.meshes.length > 128) throw new AssetError('MESH', 'Missing bounded mesh metrics.');
  const totals = { renderTriangles: 0, lod1Triangles: 0, collisionTriangles: 0, materials: 0 };
  const materials = new Set<string>(), names = new Set<string>();
  for (const [meshIndex, raw] of audit.meshes.entries()) {
    const m = record(raw, 'mesh');
    if (typeof m.name !== 'string' || names.has(m.name) || !['render', 'lod1', 'collision'].includes(String(m.role)) || !m.name.startsWith(m.role === 'collision' ? 'COL_' : 'SM_')) throw new AssetError('MESH', 'Invalid or duplicate mesh identity.');
    names.add(m.name);
    for (const field of ['vertices', 'edges', 'faces', 'triangles']) integer(m[field], 1, 200000, 'mesh ' + field);
    for (const field of ['nonManifoldEdges', 'looseVertices', 'looseEdges', 'duplicateVertices', 'duplicateFaces', 'degenerateFaces', 'inconsistentNormals', 'invertedComponents', 'invalidUVs', 'degenerateUVFaces']) {
      if (m[field] !== 0) throw new AssetError('MESH', `audit.json mesh[${meshIndex}]: ${field} is ${measuredNumber(m[field])}; required 0.`);
    }
    if (m.finitePositions !== true || !Array.isArray(m.errors) || m.errors.length) throw new AssetError('MESH', `audit.json mesh[${meshIndex}]: Mesh reported structural errors or nonfinite positions.`);
    if (m.uvQuality !== undefined) validateUvQuality(m.uvQuality, m.role, meshIndex);
    vector(m.dimensions, 1e-6, 100, 'mesh dimensions');
    if (vector(m.scale, 0, 2, 'mesh scale').some(n => Math.abs(n - 1) > 1e-5) || vector(m.rotation, -7, 7, 'mesh rotation').some(n => Math.abs(n) > 1e-5)) throw new AssetError('MESH', 'Mesh transforms were not applied.');
    if (!Array.isArray(m.materials) || m.materials.some(s => typeof s !== 'string' || !s.startsWith('MAT_'))) throw new AssetError('MESH', 'Invalid named mesh materials.');
    for (const mat of m.materials as string[]) materials.add(mat);
    if (m.role !== 'collision') {
      integer(m.uvLayers, 1, 8, 'UV layers'); integer(m.uvLoops, Number(m.faces) * 3, 600000, 'UV loops');
      if (m.materials.length < 1 || m.materials.length > 3) throw new AssetError('MESH', 'Material count exceeded the budget.');
    } else if (m.materials.length) throw new AssetError('MESH', 'Collision should not carry materials.');
    const key = m.role === 'render' ? 'renderTriangles' : m.role === 'lod1' ? 'lod1Triangles' : 'collisionTriangles';
    totals[key] += m.triangles as number;
  }
  totals.materials = materials.size;
  const reported = record(audit.totals, 'audit totals');
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) if (reported[key] !== totals[key]) throw new AssetError('MESH', `audit.json: ${key} total ${measuredNumber(reported[key])} must equal measured mesh sum ${totals[key]}.`);
  if (!totals.renderTriangles || totals.renderTriangles > request.triangleBudget) throw new AssetError('MESH', `audit.json: Render triangles ${totals.renderTriangles} must be within 1..${request.triangleBudget}.`);
  if (!totals.collisionTriangles || totals.collisionTriangles > (request.recipe?.collisionTriangleBudget ?? 256)) throw new AssetError('MESH', `audit.json: Collision triangles ${totals.collisionTriangles} must be within 1..${request.recipe?.collisionTriangleBudget ?? 256}.`);
  if (totals.materials > (request.recipe ? 8 : 3)) throw new AssetError('MESH', `audit.json: Material count ${totals.materials} exceeds ${request.recipe ? 8 : 3}.`);
  if (request.procedural) {
    const keys = proceduralRenderSourceKeys(request.procedural, manifestVersion);
    const render = (audit.meshes as Record<string, unknown>[]).filter(m => m.role === 'render').map(m => m.name).sort();
    if (!isDeepStrictEqual(render, keys.map(k => 'SM_' + request.name + '_' + k).sort()) || totals.lod1Triangles !== 0 || totals.renderTriangles > PROCEDURAL_LIMITS.maxTriangles) throw new AssetError('MESH', 'Procedural parts differ from the generator contract.');
    for (const raw of audit.meshes as Record<string, unknown>[]) if (raw.role === 'render' && (raw.materials as unknown[]).length !== 1) throw new AssetError('MESH', 'Procedural parts are joined per material (one material each).');
    for (const wanted of proceduralSurfaceMaterials(request.procedural, request.color, manifestVersion)) {
      const mesh = (audit.meshes as Record<string, unknown>[]).find(raw => raw.role === 'render' && isDeepStrictEqual(raw.materials, ['MAT_' + wanted.id]));
      if (!mesh || !Array.isArray(mesh.materialProperties) || mesh.materialProperties.length !== 1) throw new AssetError('MESH', 'Procedural surface material evidence is missing.');
      const actual = record(mesh.materialProperties[0], 'procedural material'), emission = record(actual.emission, 'procedural emission');
      if (actual.name !== 'MAT_' + wanted.id || !vector(actual.color, 0, 1, 'procedural color').every((n, i) => Math.abs(n - wanted.color[i]!) <= .00001) ||
          typeof actual.metallic !== 'number' || Math.abs(actual.metallic - wanted.metallic!) > .00001 || typeof actual.roughness !== 'number' || Math.abs(actual.roughness - wanted.roughness!) > .00001 ||
          emission.strength !== 0 || !isDeepStrictEqual(vector(emission.color, 0, 1, 'procedural emission color'), [1, 1, 1]))
        throw new AssetError('MESH', 'Measured procedural PBR values differ from the selected finish.');
      validateGeneratedSurface(actual.surface, wanted, proceduralSurfacePattern(request.procedural, wanted.id));
    }
  }
  if (request.template === 'hero-prop' && (!totals.lod1Triangles || totals.lod1Triangles >= totals.renderTriangles)) throw new AssetError('MESH', 'Hero LOD must reduce geometry.');
  const structureDescriptor = Object.getOwnPropertyDescriptor(audit, 'treeStructure');
  if ('treeStructure' in audit && (!structureDescriptor || !structureDescriptor.enumerable || !('value' in structureDescriptor)))
    throw new AssetError('RENDER', 'Tree structure evidence must be an own data field.');
  const treeStructure = structureDescriptor ? readTreeStructureReview(structureDescriptor.value, request, audit.meshes, expectedRequestSha256) : undefined;
  const renderPaths = ['preview-hero.png', 'preview-side.png', ...(treeStructure ? ['preview-structure.png'] : [])];
  if (!Array.isArray(audit.renders) || audit.renders.length !== renderPaths.length) throw new AssetError('RENDER', 'Required review render membership differs.');
  const renderNames = new Set<string>();
  for (const raw of audit.renders) {
    const r = record(raw, 'render');
    if (!renderPaths.includes(String(r.path)) || r.width !== request.renderResolution || r.height !== request.renderResolution || r.finitePixels !== true) throw new AssetError('RENDER', 'Invalid review render metrics.');
    if (renderNames.has(String(r.path))) throw new AssetError('RENDER', 'Duplicate review render.'); renderNames.add(String(r.path));
    for (const field of ['minLuminance', 'maxLuminance', 'meanLuminance', 'standardDeviation']) if (typeof r[field] !== 'number' || !Number.isFinite(r[field])) throw new AssetError('RENDER', 'Nonfinite render measurements.');
    if (Number(r.maxLuminance) - Number(r.minLuminance) < 0.05 || Number(r.standardDeviation) < 0.005) throw new AssetError('RENDER', 'Review render is uniform or empty.');
  }
  const expected = new Map([['asset.glb', totals.renderTriangles], ['asset.fbx', totals.renderTriangles], ['collision.glb', totals.collisionTriangles]]);
  if (totals.lod1Triangles) expected.set('asset-lod1.glb', totals.lod1Triangles);
  if (!Array.isArray(audit.exports) || audit.exports.length !== expected.size) throw new AssetError('EXPORT', 'Export round-trip evidence is incomplete.');
  for (const raw of audit.exports) {
    const e = record(raw, 'export');
    if (!expected.has(String(e.path)) || e.triangles !== expected.get(String(e.path)) || e.finitePositions !== true) throw new AssetError('EXPORT', 'Export round-trip triangle count or coordinates failed.');
    integer(e.objects, 1, 128, 'export objects'); integer(e.materials, 0, request.recipe ? 8 : 3, 'export materials'); expected.delete(String(e.path));
  }
  if (request.recipe) {
    const recipe = request.recipe, expectedParts = new Map(recipe.parts.map(p => [(p.role === 'collision' ? 'COL_' : 'SM_') + p.name, p]));
    if (audit.meshes.length !== expectedParts.size) throw new AssetError('MESH', 'Recipe part audit is incomplete.');
    for (const raw of audit.meshes) {
      const mesh = record(raw, 'recipe mesh'), part = expectedParts.get(String(mesh.name));
      if (typeof mesh.geometrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mesh.geometrySha256)) throw new AssetError('MESH', 'Custom part geometry digest is missing.');
      const bounds = record(mesh.bounds, 'custom part bounds'), minimum = vector(bounds.min, -60, 60, 'part min'), maximum = vector(bounds.max, -60, 60, 'part max');
      if (vector(mesh.position, -60, 60, 'part origin').some(n => Math.abs(n) > 0.00001)) throw new AssetError('MESH', 'Custom part origin must remain at the assembly floor pivot.');
      if (part) {
        const predicted = preflightPart(part);
        if (minimum.some((n, i) => n < predicted.bounds.min[i]! - 0.0001) || maximum.some((n, i) => n > predicted.bounds.max[i]! + 0.0001 || n <= minimum[i]!) ||
            (!part.bevel && (minimum.some((n, i) => Math.abs(n - predicted.bounds.min[i]!) > 0.0001) || maximum.some((n, i) => Math.abs(n - predicted.bounds.max[i]!) > 0.0001))) ||
            Number(mesh.triangles) > predicted.triangles || (!part.bevel && mesh.triangles !== predicted.triangles)) throw new AssetError('MESH', 'Custom part topology or transformed bounds differ from recipe.');
        const actualMaterials = mesh.materialProperties;
        if (!Array.isArray(actualMaterials) || actualMaterials.length !== (part.material ? 1 : 0)) throw new AssetError('MESH', 'Custom PBR evidence is incomplete.');
        if (part.material) {
          const wanted = recipe.materials.find(m => m.id === part.material)!, actual = record(actualMaterials[0], 'PBR material'), emission = record(actual.emission, 'PBR emission');
          const close = (a: number, b: number) => Math.abs(a - b) <= 0.00001;
          if (actual.name !== 'MAT_' + wanted.id || !vector(actual.color, 0, 1, 'PBR color').every((n, i) => close(n, wanted.color[i]!)) ||
              typeof actual.metallic !== 'number' || !close(actual.metallic, wanted.metallic!) || typeof actual.roughness !== 'number' || !close(actual.roughness, wanted.roughness!) ||
              !vector(emission.color, 0, 1, 'PBR emission').every((n, i) => close(n, (wanted.emission?.color ?? [1, 1, 1])[i]!)) ||
              typeof emission.strength !== 'number' || !close(emission.strength, wanted.emission?.strength ?? 0)) throw new AssetError('MESH', 'Measured custom PBR values differ from recipe.');
          if (wanted.surface) {
            const surface = record(actual.surface, 'generated surface');
            if (surface.profile !== wanted.surface.profile || surface.resolution !== wanted.surface.resolution || surface.generator !== 'arcane-tile-v1' || surface.texCoord !== 0 ||
                !Array.isArray(surface.images) || surface.images.length !== 3) throw new AssetError('MESH', 'Generated surface differs from the requested profile.');
            const roles = new Set<string>();
            for (const rawImage of surface.images) {
              const image = record(rawImage, 'generated texture'), suffix = ({baseColor:'BaseColor',normal:'Normal',metallicRoughness:'MetallicRoughness'} as Record<string,string>)[String(image.role)];
              if (!suffix || roles.has(String(image.role)) || image.name !== `T_${wanted.id}_${suffix}` || image.width !== surface.resolution || image.height !== surface.resolution ||
                  image.colorSpace !== (image.role === 'baseColor' ? 'sRGB' : 'Non-Color') || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256))
                throw new AssetError('MESH', 'Generated texture evidence is incomplete.');
              roles.add(String(image.role));
            }
          } else if (actual.surface !== undefined) throw new AssetError('MESH', 'Flat recipe material unexpectedly contains generated textures.');
        }
      }
      if (!part || mesh.role !== part.role || !isDeepStrictEqual(mesh.materials, part.material ? ['MAT_' + part.material] : [])) throw new AssetError('MESH', 'Recipe mesh identity, role or material differs.');
    }
    if (totals.lod1Triangles > recipe.lodTriangleBudget! || (totals.lod1Triangles && totals.lod1Triangles >= totals.renderTriangles)) throw new AssetError('MESH', 'Custom LOD budget/reduction failed.');
    const evidence = record(audit.assembly, 'assembly evidence'), estimate = preflightRecipe(recipe, request.triangleBudget);
    if (evidence.recipeSha256 !== sha256(Buffer.from(JSON.stringify(recipe))) || !isDeepStrictEqual(evidence.estimatedTriangles, estimate.estimatedTriangles) || evidence.artisticFidelity !== 'unverified' || evidence.robloxImport !== 'unverified') throw new AssetError('MESH', 'Assembly provenance or preflight evidence differs.');
    checkSockets(evidence.sockets, recipe);
    const bounds = record(evidence.bounds, 'assembly bounds'), minimum = vector(bounds.min, -60, 60, 'bounds'), maximum = vector(bounds.max, -60, 60, 'bounds');
    if (Math.abs(minimum[2]) > 0.0001 || minimum.some((n,i) => n < estimate.bounds.min[i]! - 0.0001) || maximum.some((n,i) => n > estimate.bounds.max[i]! + 0.0001 || n <= minimum[i]!)) throw new AssetError('MESH', 'Measured assembly bounds differ from recipe.');
    for (const raw of audit.exports) {
      const exported = record(raw, 'custom export');
      if (exported.path === 'asset.glb' || exported.path === 'asset.fbx') checkSockets(exported.sockets, recipe);
      const role = exported.path === 'collision.glb' ? 'collision' : exported.path === 'asset-lod1.glb' ? 'lod1' : 'render';
      const parts = recipe.parts.filter(p => p.role === role);
      if (exported.objects !== parts.length || exported.materials !== new Set(parts.flatMap(p => p.material ? [p.material] : [])).size) throw new AssetError('EXPORT', 'Custom export part/material counts differ from recipe.');
    }
  }
  return value as AssetAudit;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface GlbMetrics { triangles: number; primitives: number; vertices: number }
/** Add host-owned locations without replacing domain errors or exposing native filesystem messages. */
function artifactFailure(error: unknown, name: string): never {
  if (error instanceof AssetError) {
    if (!error.message.startsWith(name + ':')) error.message = `${name}: ${error.message}`;
    throw error;
  }
  const missing = error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
  const failure = new AssetError('ARTIFACT', `${name}: ${missing ? 'Required artifact is missing.' : 'Artifact could not be read safely.'}`);
  Object.defineProperty(failure, 'cause', { value: error });
  throw failure;
}
const measuredNumber = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'invalid';
/** Parse the actual GLB buffers, not just extension or exporter metadata. */
export function inspectGlb(bytes: Buffer): GlbMetrics {
  let location = 'GLB';
  const bad = (reason: string, cause?: unknown): never => {
    const error = new AssetError('EXPORT', `${location}: ${reason}`);
    if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
    throw error;
  };
  const object = (value: unknown, label: string) => { try { return record(value, label); } catch (error) { return artifactFailure(error, location); } };
  if (bytes.length < 28 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) bad(`Invalid version-2 header or declared file length; observed ${bytes.length} bytes.`);
  let offset = 12, json: Record<string, unknown> | undefined, binary: Buffer | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) bad('Truncated chunk header.');
    const length = bytes.readUInt32LE(offset), kind = bytes.readUInt32LE(offset + 4); offset += 8;
    if (!length || length % 4 || offset + length > bytes.length) bad(`Chunk at byte ${offset - 8} has invalid length ${length}; it must be nonzero, aligned and within the file.`);
    const chunk = bytes.subarray(offset, offset + length); offset += length;
    if (kind === 0x4e4f534a && !json && !binary) { try { json = record(JSON.parse(chunk.toString('utf8').trim()), 'GLB JSON'); } catch (error) { bad('JSON chunk is not a valid object.', error); } }
    else if (kind === 0x004e4942 && json && !binary) binary = chunk;
    else bad('Expected one JSON chunk followed by one embedded BIN chunk.');
  }
  if (!json || !binary) bad('Required JSON or embedded BIN chunk is missing.');
  const doc = json!, bin = binary!;
  if (object(doc.asset, 'GLB asset').version !== '2.0' || !Array.isArray(doc.buffers) || doc.buffers.length !== 1) bad('Requires glTF 2.0 and exactly one embedded buffer.');
  const buffer = object((doc.buffers as unknown[])[0], 'GLB buffer');
  if (buffer.uri !== undefined || typeof buffer.byteLength !== 'number' || buffer.byteLength > bin.length || bin.length - buffer.byteLength > 3) bad(`Buffer must be embedded with at most 3 padding bytes; declared ${measuredNumber(buffer.byteLength)}, BIN ${bin.length} bytes.`);
  if (!Array.isArray(doc.accessors) || !Array.isArray(doc.bufferViews) || !Array.isArray(doc.meshes) || doc.meshes.length < 1 || doc.meshes.length > 128) bad('Requires accessor and buffer-view arrays and 1..128 meshes.');
  const accessors = doc.accessors as unknown[], views = doc.bufferViews as unknown[];
  const accessor = (index: unknown, type: 'VEC3' | 'VEC2' | 'SCALAR', allowed: number[], attribute: string): { count: number; values: number[][] } => {
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= accessors.length) return bad(`${attribute} accessor is missing or outside 0..${accessors.length - 1}.`);
    const a = object(accessors[Number(index)], `${attribute} accessor[${Number(index)}]`), label = `${attribute} accessor[${Number(index)}]`;
    if (a.type !== type || a.sparse !== undefined || !allowed.includes(Number(a.componentType)) || a.normalized === true || !Number.isSafeInteger(a.count) || Number(a.count) < 1 || Number(a.count) > 200000) return bad(`${label} requires dense, unnormalized ${type}, component type ${allowed.join('/')}, count 1..200000; observed count ${measuredNumber(a.count)}.`);
    if (!Number.isSafeInteger(a.bufferView) || Number(a.bufferView) < 0 || Number(a.bufferView) >= views.length) return bad(`${label} buffer view is missing or outside 0..${views.length - 1}.`);
    const view = object(views[Number(a.bufferView)], `${label} buffer view`);
    if (view.buffer !== 0) return bad(`${label} must reference embedded buffer 0.`);
    const width = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
    const components = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
    const start = Number(view.byteOffset ?? 0) + Number(a.byteOffset ?? 0), stride = Number(view.byteStride ?? width * components);
    const viewStart = Number(view.byteOffset ?? 0), viewLength = Number(view.byteLength), localStart = Number(a.byteOffset ?? 0), count = Number(a.count);
    if (![start, stride, viewStart, viewLength, localStart].every(n => Number.isSafeInteger(n) && n >= 0) || stride < width * components || stride > 252 || stride % width || localStart + stride * (count - 1) + width * components > viewLength || viewStart + viewLength > Number(buffer.byteLength)) return bad(`${label} byte range or stride is invalid; count ${count}, stride ${measuredNumber(stride)}, view length ${measuredNumber(viewLength)} bytes.`);
    const values: number[][] = [];
    for (let i = 0; i < count; i++) {
      const row: number[] = [];
      for (let c = 0; c < components; c++) {
        const p = start + i * stride + c * width;
        const n = a.componentType === 5126 ? bin.readFloatLE(p) : width === 4 ? bin.readUInt32LE(p) : width === 2 ? bin.readUInt16LE(p) : bin.readUInt8(p);
        if (!Number.isFinite(n)) bad(`${label} element[${i}] component[${c}] must be finite.`); row.push(n);
      }
      values.push(row);
    }
    return { count, values };
  };
  let triangles = 0, primitives = 0, vertices = 0;
  for (const [meshIndex, raw] of (doc.meshes as unknown[]).entries()) {
    location = `GLB mesh[${meshIndex}]`;
    const mesh = object(raw, 'GLB mesh'); if (!Array.isArray(mesh.primitives) || mesh.primitives.length < 1 || mesh.primitives.length > 16) bad('Requires 1..16 primitives.');
    for (const [primitiveIndex, rawPrimitive] of (mesh.primitives as unknown[]).entries()) {
      location = `GLB mesh[${meshIndex}] primitive[${primitiveIndex}]`;
      const p = object(rawPrimitive, 'GLB primitive'), attributes = object(p.attributes, 'GLB attributes');
      if ((p.mode ?? 4) !== 4 || p.extensions !== undefined || p.targets !== undefined) bad('Requires TRIANGLES mode 4 without primitive extensions or morph targets.');
      const position = accessor(attributes.POSITION, 'VEC3', [5126], 'POSITION');
      const normal = accessor(attributes.NORMAL, 'VEC3', [5126], 'NORMAL');
      if (position.count !== normal.count) bad(`NORMAL count ${normal.count} must match POSITION count ${position.count}.`);
      const invalidNormal = normal.values.findIndex(n => Math.abs(Math.hypot(...n) - 1) > 0.05);
      if (invalidNormal !== -1) bad(`NORMAL element[${invalidNormal}] length ${Math.hypot(...normal.values[invalidNormal]!)} must be within 0.05 of 1.`);
      if (attributes.TEXCOORD_0 !== undefined) {
        const uv = accessor(attributes.TEXCOORD_0, 'VEC2', [5126], 'TEXCOORD_0');
        if (uv.count !== position.count) bad(`TEXCOORD_0 count ${uv.count} must match POSITION count ${position.count}.`);
        const invalidUv = uv.values.findIndex(row => row.some(n => n < -1e-5 || n > 1.00001));
        if (invalidUv !== -1) bad(`TEXCOORD_0 element[${invalidUv}] is outside -0.00001..1.00001; observed ${uv.values[invalidUv]!.join(', ')}.`);
      }
      const indices = accessor(p.indices, 'SCALAR', [5121, 5123, 5125], 'indices');
      if (indices.count % 3) bad(`Index count ${indices.count} must be divisible by 3.`);
      const invalidIndex = indices.values.findIndex(n => n[0]! >= position.count);
      if (invalidIndex !== -1) bad(`Index element[${invalidIndex}] is ${indices.values[invalidIndex]![0]}; required 0..${position.count - 1}.`);
      for (let i = 0; i < indices.count; i += 3) {
        const a = position.values[indices.values[i]![0]!]!, b = position.values[indices.values[i + 1]![0]!]!, c = position.values[indices.values[i + 2]![0]!]!;
        const u = b.map((n, k) => n - a[k]!), v = c.map((n, k) => n - a[k]!);
        const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        if (Math.hypot(...cross) <= 1e-10) bad(`Triangle[${i / 3}] is degenerate; doubled area must exceed 1e-10.`);
      }
      triangles += indices.count / 3; vertices += position.count; primitives++;
    }
  }
  return { triangles, primitives, vertices };
}

/** Decode the worker's 8-bit RGB/RGBA PNGs and reject empty/uniform previews. */
export function inspectPng(bytes: Buffer, expectedResolution: number): void {
  const bad = (reason = 'Malformed, empty or uniform review PNG.', cause?: unknown): never => {
    const error = new AssetError('RENDER', `Review PNG: ${reason}`);
    if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
    throw error;
  };
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) bad('Invalid PNG signature.');
  let offset = 8, width = 0, height = 0, channels = 0, ended = false;
  const chunks: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) bad();
    const chunkOffset = offset;
    const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8); offset += 8;
    if (offset + size + 4 > bytes.length) bad();
    if (pngCrc(bytes.subarray(chunkOffset + 4, offset + size)) !== bytes.readUInt32BE(offset + size)) bad(`Chunk at byte ${chunkOffset} failed CRC integrity.`);
    if (!width && kind !== 'IHDR') bad();
    const data = bytes.subarray(offset, offset + size); offset += size + 4;
    if (kind === 'IHDR') {
      if (width || size !== 13) bad(); width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]!) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) bad('Requires noninterlaced 8-bit RGB or RGBA.');
      channels = data[9] === 6 ? 4 : 3;
    } else if (kind === 'IDAT') chunks.push(data);
    else if (kind === 'IEND') { if (size !== 0) bad(); ended = true; break; }
    else if (/^[A-Z]/.test(kind) && kind !== 'PLTE') bad();
  }
  if (!ended || offset !== bytes.length || width !== expectedResolution || height !== expectedResolution || !channels || !chunks.length) bad(`Incomplete image or dimensions differ; observed ${width}x${height}, required ${expectedResolution}x${expectedResolution}.`);
  const stride = width * channels;
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height }); } catch (error) { return bad('Pixel data failed bounded decompression.', error); }
  if (decoded.length !== (stride + 1) * height) bad(`Decoded pixel bytes ${decoded.length} must equal ${(stride + 1) * height}.`);
  let previous = Buffer.alloc(stride), min = 255, max = 0;
  for (let row = 0; row < height; row++) {
    const filter = decoded[row * (stride + 1)]!, line = Buffer.from(decoded.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    if (filter > 4) bad(`Row[${row}] filter ${filter} must be 0..4.`);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0, b = previous[i]!, c = i >= channels ? previous[i - channels]! : 0;
      const paeth = () => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      line[i] = (line[i]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth() : 0)) & 255;
    }
    for (let i = 0; i < stride; i += channels) { const lum = 0.2126 * line[i]! + 0.7152 * line[i + 1]! + 0.0722 * line[i + 2]!; min = Math.min(min, lum); max = Math.max(max, lum); }
    previous = line;
  }
  if (max - min < 12) bad(`Image is uniform or empty; luminance range ${max - min} must be at least 12.`);
}

/** Measured UV quality (workers/blender/uv uv_metrics.report): a passing verdict with finite metrics. */
export function validateUvQuality(value: unknown, role: unknown, meshIndex: number): void {
  const q = record(value, 'UV quality'), where = `audit.json mesh[${meshIndex}]: uvQuality`;
  if (role === 'collision' || !['unique', 'periodic', 'tiled', 'atlas'].includes(String(q.intent))) throw new AssetError('MESH', `${where} has an unsupported intent.`);
  if (!Array.isArray(q.errors) || q.errors.length) throw new AssetError('MESH', `${where} failed: ${Array.isArray(q.errors) ? q.errors.slice(0, 4).map(e => String(e).slice(0, 120)).join('; ') : 'missing verdict'}.`);
  if (!Array.isArray(q.warnings) || q.warnings.length > 32 || q.warnings.some(w => typeof w !== 'string' || w.length > 256)) throw new AssetError('MESH', `${where} warnings are invalid.`);
  for (const key of ['angleDistortion', 'angleDistortionP95', 'areaDistortion', 'densityCV', 'texelsPerMetre', 'seamRatio']) {
    if (typeof q[key] !== 'number' || !Number.isFinite(q[key]) || (q[key] as number) < 0) throw new AssetError('MESH', `${where}.${key} must be a finite non-negative measurement.`);
  }
  for (const key of ['faces', 'islands', 'foldedFaces', 'mirroredFaces']) integer(q[key], 0, 200000, 'UV quality ' + key);
}
/** General UV engine modules (workers/blender/uv), bundled flat for natural-finish and model-spec jobs. */
export const UV_WORKER_SCRIPTS: readonly string[] = ['uv_engine.py', 'uv_metrics.py', 'uv_stage.py'];
/** Procedural PBR material library modules (workers/blender/materials), bundled flat for library materials. */
export const MATERIAL_WORKER_SCRIPTS: readonly string[] = ['mat_noise.py', 'mat_core.py', 'mat_families.py', 'mat_metrics.py', 'mat_bake.py', 'mat_library.py', 'mat_blender.py'];
/** Worker subpackages: every module of workers/blender/<directory> is staged flat beside asset_worker.py
 * in a job (the worker puts the directories on sys.path in the repository). A directory holding one
 * package __init__.py is staged as <directory>.py. tests/unit/worker-modules.test.ts holds these lists
 * equal to the directories, so a new worker module or subpackage cannot be left out of jobs. */
export const WORKER_PACKAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  uv: UV_WORKER_SCRIPTS, grammar: MODEL_WORKER_SCRIPTS, materials: MATERIAL_WORKER_SCRIPTS, variation: ['variation.py'] });
/** Repository path segments (under workers/blender) of a bundled worker file name. */
export function workerSourcePath(name: string): string[] {
  for (const [directory, names] of Object.entries(WORKER_PACKAGES)) {
    if (names.includes(name)) return name === directory + '.py' ? [directory, '__init__.py'] : [directory, name];
  }
  return [name];
}
/** Library materials (materials/mat_library) are requested by name on a recipe material; a natural-finish
 * model spec always may use them (the worker infers a family for unnamed slots), so the host stages them. */
export function usesMaterialLibrary(request: AssetRequest): boolean {
  const named = (materials: unknown) => Array.isArray(materials) && materials.some(material =>
    !!material && typeof material === 'object' && (material as { library?: unknown }).library !== undefined);
  const procedural = request.procedural as { kind?: string; finish?: string; materials?: unknown } | undefined;
  return named(request.recipe?.materials) || (procedural?.kind === 'spec' && (procedural.finish !== 'flat' || named(procedural.materials)));
}
/** Bundled worker files hashed into a job's template digest, in fixed order. */
export function workerScripts(request: AssetRequest): string[] {
  return ['asset_worker.py', 'audit.py', 'probe.py', ...(request.recipe ? ['assembly.py'] : []), ...(request.procedural ? ['procedural.py'] : []), ...(request.procedural?.variant ? ['variation.py'] : []),
    ...(request.recipe?.materials.some(material => material.surface) || request.procedural?.finish === 'natural' ? ['textures.py'] : []),
    ...(request.procedural?.finish === 'natural' || request.procedural?.kind === 'spec' ? UV_WORKER_SCRIPTS : []), ...(isNaturalTreeRequest(request) ? TREE_STRUCTURE_WORKER_SCRIPTS : []), ...(request.procedural?.kind === 'spec' ? MODEL_WORKER_SCRIPTS : []),
    ...(usesMaterialLibrary(request) ? MATERIAL_WORKER_SCRIPTS : [])];
}
function validateGeneratedSurface(value: unknown, wanted: AssemblyMaterial, pattern?: string): void {
  const surface = record(value, 'generated procedural surface'), expected = { ...wanted.surface! };
  // Natural oak/birch/pine assets made before the species patterns keep their plain 256 px tiles.
  if (pattern !== undefined && surface.pattern === undefined && surface.resolution === PROCEDURAL_SURFACE_RESOLUTION) { expected.resolution = PROCEDURAL_SURFACE_RESOLUTION; pattern = undefined; }
  const alphaMode = pattern?.endsWith('-leaves') ? 'MASK' : 'OPAQUE';
  if (surface.profile !== expected.profile || surface.resolution !== expected.resolution || surface.generator !== 'arcane-tile-v1' || surface.texCoord !== 0 ||
      surface.pattern !== pattern || (pattern === undefined ? surface.alphaMode !== undefined : surface.alphaMode !== alphaMode) ||
      !Array.isArray(surface.images) || surface.images.length !== 3) throw new AssetError('MESH', 'Generated procedural surface differs from the selected finish.');
  const roles = new Set<string>();
  for (const raw of surface.images) {
    const image = record(raw, 'procedural PNG'), suffix = ({baseColor:'BaseColor',normal:'Normal',metallicRoughness:'MetallicRoughness'} as Record<string,string>)[String(image.role)];
    if (!suffix || roles.has(String(image.role)) || image.name !== `T_${wanted.id}_${suffix}` || image.width !== expected.resolution || image.height !== expected.resolution ||
        image.colorSpace !== (image.role === 'baseColor' ? 'sRGB' : 'Non-Color') || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256))
      throw new AssetError('MESH', 'Generated procedural PNG evidence is incomplete.');
    roles.add(String(image.role));
  }
}
/** Textured authoring must survive export as the same embedded PNG pixels and UV0 PBR bindings. */
export function validateSurfaceGlb(bytes: Buffer, request: AssetRequest, audit: AssetAudit, role: 'render' | 'lod1' = 'render', manifestVersion: AssetManifest['schemaVersion'] = 2): void {
  const used = new Set(request.recipe?.parts.filter(part => part.role === role).map(part => part.material));
  const wanted = request.recipe?.materials.filter(material => material.surface && used.has(material.id)) ??
    (request.procedural && role === 'render' ? proceduralSurfaceMaterials(request.procedural, request.color, manifestVersion) : []);
  if (!wanted.length) return;
  const artifact = role === 'render' ? 'asset.glb' : 'asset-lod1.glb';
  try { inspectGlb(bytes); } catch (error) { artifactFailure(error, artifact); }
  const size = bytes.readUInt32LE(12), doc = record(JSON.parse(bytes.toString('utf8', 20, 20 + size).trim()), 'textured GLB'), bin = bytes.subarray(28 + size);
  let location = 'Generated texture export';
  const fail = (reason: string, cause?: unknown): never => {
    const error = new AssetError('EXPORT', `${artifact}: ${location}: ${reason}`);
    if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
    throw error;
  };
  const object = (value: unknown, label: string) => { try { return record(value, label); } catch (error) { return artifactFailure(error, `${artifact}: ${location}`); } };
  const list = (value: unknown, maximum: number, label: string): unknown[] => { if (!Array.isArray(value) || value.length > maximum) return fail(`${label} must be an array with at most ${maximum} entries.`); return value; };
  const materials = list(doc.materials, 8, 'materials'), textures = list(doc.textures, 24, 'textures'), images = list(doc.images, 24, 'images'), views = list(doc.bufferViews, 4096, 'bufferViews'), samplers = list(doc.samplers ?? [], 24, 'samplers');
  const at = (values: unknown[], index: unknown, label: string): Record<string, unknown> => {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= values.length) return fail(`${label} index ${measuredNumber(index)} must be within 0..${values.length - 1}.`);
    return object(values[index], label);
  };
  for (const [wantedIndex, material] of wanted.entries()) {
    location = `Requested generated material[${wantedIndex}]`;
    const raw = materials.find(raw => object(raw, 'GLB material').name === 'MAT_' + material.id);
    if (!raw) fail('Named material from the request is missing.');
    const materialIndex = materials.indexOf(raw);
    location = `Generated material[${materialIndex}]`;
    const actual = object(raw, 'textured material'), pbr = object(actual.pbrMetallicRoughness, 'textured PBR');
    for (const [meshIndex, rawMesh] of list(doc.meshes, 128, 'meshes').entries()) for (const [primitiveIndex, rawPrimitive] of list(object(rawMesh, 'textured mesh').primitives, 16, 'primitives').entries()) {
      const primitive = object(rawPrimitive, 'textured primitive');
      if (primitive.material === materialIndex && object(primitive.attributes, 'textured attributes').TEXCOORD_0 === undefined) fail(`Mesh[${meshIndex}] primitive[${primitiveIndex}] is missing required TEXCOORD_0.`);
    }
    if (!isDeepStrictEqual(pbr.baseColorFactor ?? [1,1,1,1], [1,1,1,1])) fail('baseColorFactor must equal [1,1,1,1] for baked PNG values.');
    if ((pbr.metallicFactor ?? 1) !== 1) fail(`metallicFactor ${measuredNumber(pbr.metallicFactor)} must equal 1 for the packed PNG.`);
    if ((pbr.roughnessFactor ?? 1) !== 1) fail(`roughnessFactor ${measuredNumber(pbr.roughnessFactor)} must equal 1 for the packed PNG.`);
    const evidence = audit.meshes.flatMap(mesh => mesh.materialProperties ?? []).find(item => item.name === actual.name)?.surface;
    if (!evidence) fail('Generated surface audit evidence is missing.');
    // Leaf-spray atlases are alpha cutouts (MASK at the default 0.5 cutoff); every other surface is opaque.
    const alphaMode = (evidence as { alphaMode?: string }).alphaMode ?? 'OPAQUE';
    if ((actual.alphaMode ?? 'OPAQUE') !== alphaMode || (alphaMode === 'MASK' && (actual.alphaCutoff ?? .5) !== .5)) fail(`alphaMode ${String(actual.alphaMode ?? "OPAQUE").slice(0, 16)} must be ${alphaMode} as audited.`);
    for (const [role, rawUse] of [['baseColor', pbr.baseColorTexture], ['normal', actual.normalTexture], ['metallicRoughness', pbr.metallicRoughnessTexture]] as const) {
      location = `Generated material[${materialIndex}] ${role} map`;
      const use = object(rawUse, 'generated texture binding');
      if ((use.texCoord ?? 0) !== 0) fail(`texCoord ${measuredNumber(use.texCoord)} must be 0 (TEXCOORD_0).`);
      if (use.extensions !== undefined) fail('Texture binding extensions or transforms are unsupported.');
      if (role === 'normal' && (use.scale ?? 1) !== 1) fail(`Normal scale ${measuredNumber(use.scale)} must equal 1.`);
      const texture = at(textures, use.index, 'texture'), image = at(images, texture.source, 'image');
      if (texture.sampler !== undefined) { const sampler = at(samplers, texture.sampler, 'sampler'); if ((sampler.wrapS ?? 10497) !== 10497 || (sampler.wrapT ?? 10497) !== 10497 ||
          (sampler.magFilter ?? 9729) !== 9729 || ![9729,9987].includes(Number(sampler.minFilter ?? 9987))) fail('Sampler requires REPEAT (10497), linear magFilter (9729) and linear minFilter (9729 or 9987).'); }
      if (image.uri !== undefined || image.mimeType !== 'image/png') fail('Image must be an embedded image/png; external images are forbidden.');
      const view = at(views, image.bufferView, 'image buffer view'), start = Number(view.byteOffset ?? 0), length = Number(view.byteLength);
      if (view.buffer !== 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || start + length > bin.length) fail('PNG byte range must be nonempty and within embedded buffer 0.');
      const encoded = bin.subarray(start, start + length), expected = evidence!.images.find(image => image.role === role);
      let decoded; try { decoded = decodeMaterialPng(encoded); } catch (error) { return fail('Embedded PNG failed bounded image decoding.', error); }
      if (!expected) fail('PNG audit evidence is missing.');
      if (decoded.width !== expected!.width || decoded.height !== expected!.height) fail(`PNG dimensions ${decoded.width}x${decoded.height} must match audit ${expected!.width}x${expected!.height}.`);
      if (decoded.sourceSha256 !== expected!.sha256) fail('PNG SHA-256 differs from the audited image bytes.');
      if (image.name !== expected!.name) fail('PNG identity differs from the audited image name.');
    }
  }
}
export async function validateManifestFiles(directory: string, value: unknown): Promise<AssetManifest> {
  const m = record(value, 'manifest');
  if ((m.schemaVersion !== 1 && m.schemaVersion !== 2) || typeof m.jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.jobId) || typeof m.templateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.templateSha256)) throw new AssetError('MANIFEST', 'Unsupported manifest or worker digest.');
  const runtime = record(m.runtime, 'runtime'), capabilities = record(runtime.capabilities, 'runtime capabilities'), coordinates = record(m.coordinateSystem, 'coordinates');
  if (typeof runtime.executable !== 'string' || runtime.executable.length > 4096 || typeof runtime.version !== 'string' || runtime.version.length > 128 || typeof runtime.pythonVersion !== 'string' || runtime.pythonVersion.length > 128 || runtime.background !== true || ['glbExport', 'glbImport', 'fbxExport', 'fbxImport', 'cycles'].some(key => capabilities[key] !== true)) throw new AssetError('MANIFEST', 'Invalid runtime evidence.');
  if (coordinates.units !== 'meters' || coordinates.sceneUp !== 'Z' || coordinates.glbUp !== 'Y' || coordinates.fbxUp !== 'Y' || coordinates.pivot !== 'floor' || coordinates.robloxScaleVerified !== false) throw new AssetError('MANIFEST', 'Invalid coordinate-system evidence.');
  if (!Array.isArray(m.limitations) || m.limitations.length > 32 || m.limitations.some(line => typeof line !== 'string' || line.length > 2048)) throw new AssetError('MANIFEST', 'Invalid limitations.');
  const request = normalizeRequest(m.request), audit = validateAudit(m.validation, request, m.schemaVersion);
  if (!Array.isArray(m.artifacts) || m.artifacts.length < 10 || m.artifacts.length > 64) throw new AssetError('MANIFEST', 'Invalid artifact list.');
  const roles: Record<string, string> = { 'asset.blend': 'scene', 'blockout.blend': 'checkpoint', 'asset.glb': 'export', 'asset.fbx': 'export', 'collision.glb': 'export', 'asset-lod1.glb': 'export', 'preview-hero.png': 'preview', 'preview-side.png': 'preview', ...(audit.treeStructure ? { 'preview-structure.png': 'preview', ...Object.fromEntries(TREE_STRUCTURE_WORKER_SCRIPTS.map(name => [name, 'worker'])) } : {}), 'audit.json': 'audit', 'request.json': 'request', 'asset_worker.py': 'worker', 'audit.py': 'worker', 'probe.py': 'worker', 'assembly.py': 'worker', 'procedural.py': 'worker', ...Object.fromEntries(MODEL_WORKER_SCRIPTS.map(name => [name, 'worker'])), 'variation.py': 'worker', 'textures.py': 'worker', ...Object.fromEntries([...UV_WORKER_SCRIPTS, ...MATERIAL_WORKER_SCRIPTS].map(name => [name, 'worker'])), 'input.json': 'request', 'assembly.json': 'audit' };
  if (typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) throw new AssetError('MANIFEST', 'Invalid manifest timestamp.');
  const names = new Set<string>(), hashes = new Map<string, string>();
  let totalBytes = 0;
  for (const raw of m.artifacts) {
    const a = record(raw, 'artifact'), path = artifactPath(directory, a.path);
    if (names.has(String(a.path)) || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new AssetError('MANIFEST', 'Duplicate artifact or invalid hash.');
    if (roles[String(a.path)] !== a.role || !roles[String(a.path)]) throw new AssetError('MANIFEST', 'Artifact name/role is outside the fixed templates.');
    // Only fixed own filenames may be reflected into a diagnostic.
    const name = Object.hasOwn(roles, String(a.path)) ? String(a.path) : 'Artifact';
    names.add(String(a.path));
    try {
      const bytes = await readRegularFile(path, 128 * 1024 * 1024, size => {
        totalBytes += size;
        if (totalBytes > 256 * 1024 * 1024 || a.bytes !== size) throw new AssetError('MANIFEST', `Artifact size changed or exceeded 268435456 total bytes; observed ${size}, manifest ${measuredNumber(a.bytes)}, total ${totalBytes}.`);
      }), hash = sha256(bytes); hashes.set(String(a.path), hash);
      if (a.sha256 !== hash) throw new AssetError('HASH', 'Artifact SHA-256 no longer matches its manifest.');
      if (String(a.path).endsWith('.glb')) {
        const geometry = inspectGlb(bytes), expected = audit.exports.find(e => e.path === a.path);
        if (!expected || geometry.triangles !== expected.triangles) throw new AssetError('EXPORT', `GLB triangle count ${geometry.triangles} disagrees with export audit ${measuredNumber(expected?.triangles)}.`);
        if (a.path === 'asset.glb' || a.path === 'asset-lod1.glb') validateSurfaceGlb(bytes, request, audit, a.path === 'asset-lod1.glb' ? 'lod1' : 'render', m.schemaVersion);
      } else if (String(a.path).endsWith('.png')) inspectPng(bytes, request.renderResolution);
    } catch (error) { artifactFailure(error, name); }
  }
  if ((request.recipe?.materials.some(material => material.surface) || request.procedural?.finish === 'natural') && !names.has('textures.py')) throw new AssetError('MANIFEST', 'Generated surface worker artifact is missing.');
  for (const required of ['asset.blend', 'blockout.blend', 'asset.glb', 'asset.fbx', 'collision.glb', 'preview-hero.png', 'preview-side.png', 'audit.json', 'request.json', 'asset_worker.py', 'audit.py', 'probe.py', ...(audit.totals.lod1Triangles ? ['asset-lod1.glb'] : []), ...(request.recipe ? ['assembly.py', 'assembly.json', 'input.json'] : []), ...(request.procedural ? ['procedural.py', 'input.json'] : []), ...(request.procedural?.variant ? ['variation.py'] : []), ...(request.procedural?.kind === 'spec' ? MODEL_WORKER_SCRIPTS : []), ...(usesMaterialLibrary(request) ? MATERIAL_WORKER_SCRIPTS : [])]) {
    if (!names.has(required)) throw new AssetError('MANIFEST', 'Required artifact is missing: ' + required);
  }
  if (audit.treeStructure) {
    if (audit.treeStructure.requestSha256 !== hashes.get('request.json')) throw new AssetError('MANIFEST', 'Tree structure request hash differs from the original request artifact.');
    for (const required of ['preview-structure.png', ...workerScripts(request)]) {
      if (!names.has(required)) throw new AssetError('MANIFEST', 'Required tree structure artifact is missing: ' + required);
    }
  }
  // Historical jobs may predate the UV engine or the same-job tree structure renderer.
  if (sha256(Buffer.from(workerScripts(request).filter(name => ![...UV_WORKER_SCRIPTS, ...TREE_STRUCTURE_WORKER_SCRIPTS].includes(name) || names.has(name)).map(name => hashes.get(name)).join('\n'))) !== m.templateSha256) throw new AssetError('HASH', 'Worker template digest does not match.');
  if (JSON.stringify(normalizeRequest(await readJson(artifactPath(directory, 'request.json')))) !== JSON.stringify(request) || JSON.stringify(await readJson(artifactPath(directory, 'audit.json'))) !== JSON.stringify(m.validation)) throw new AssetError('MANIFEST', 'Manifest request/audit differs from the original evidence.');
  if (m.sourceRequestSha256 !== undefined || request.recipe || request.procedural) {
    if (m.sourceRequestSha256 !== hashes.get('input.json') || !isDeepStrictEqual(normalizeRequest(await readJson(artifactPath(directory, 'input.json'), CUSTOM_REQUEST_BYTES)), request)) throw new AssetError('MANIFEST', 'Original input provenance differs from normalized request.');
  }
  if (request.recipe && (!isDeepStrictEqual(m.assembly, audit.assembly) || !isDeepStrictEqual(await readJson(artifactPath(directory, 'assembly.json')), audit.assembly))) throw new AssetError('MANIFEST', 'Assembly evidence disagrees with saved artifacts.');
  return value as AssetManifest;
}
