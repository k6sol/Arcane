/** SYNTHETIC completed job files for production-service tests. No Blender/Studio
 * process runs and these metrics/versions are not native acceptance evidence. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audit, manifestFixture } from './fixture.js';
import { sha256 } from '../src/validation.js';
import type { AssetManifest, WorkerStudioImportEvidence } from '../src/types.js';

export const MODULE_KEYS = ['floor', 'pillar', 'step', 'wall'];
export function fixtureId(role: string, key: string): string {
  return 'arcane_' + sha256(Buffer.from(['arcane-semantic-v1', 'environment-kit', 'test-kit', role, key].join('\0')));
}
function pack(doc: Record<string, any>, bin: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.alloc(Math.ceil(raw.length/4)*4, 0x20); raw.copy(json);
  const out = Buffer.alloc(28 + json.length + bin.length);
  out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004e4942, 24 + json.length); bin.copy(out, 28 + json.length);
  return out;
}
function exported(role: 'render' | 'collision', wide: boolean, mutate: (doc: Record<string, any>) => void) {
  const bin = Buffer.alloc(MODULE_KEYS.length * 108), objects: WorkerStudioImportEvidence['models'][number]['objects'] = [];
  const doc: Record<string, any> = { asset: { version: '2.0', generator: 'Khronos glTF Blender I/O v4.5.0' },
    buffers: [{ byteLength: bin.length }], bufferViews: [], accessors: [], meshes: [], nodes: [], scenes: [{ nodes: [] }], scene: 0 };
  if (role === 'render') doc.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.5, 1], metallicFactor: 0.15, roughnessFactor: 0.7 } }];
  for (const [i, sourceKey] of MODULE_KEYS.entries()) {
    const width = wide && i === 0 ? 1.5 : 1, at = i*108;
    [0,0,0,width,0,0,0,1,0,0,0,1].forEach((n, j) => bin.writeFloatLE(n, at+j*4));
    Array.from({ length: 4 }, () => [0,0,1]).flat().forEach((n, j) => bin.writeFloatLE(n, at+48+j*4));
    [0,2,1,0,1,3,1,2,3,2,0,3].forEach((n, j) => bin.writeUInt8(n, at+96+j));
    const view = doc.bufferViews.length, accessor = doc.accessors.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: 48 }, { buffer: 0, byteOffset: at+48, byteLength: 48 }, { buffer: 0, byteOffset: at+96, byteLength: 12 });
    doc.accessors.push({ bufferView: view, componentType: 5126, count: 4, type: 'VEC3', min: [0,0,0], max: [width,1,1] },
      { bufferView: view+1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: view+2, componentType: 5121, count: 12, type: 'SCALAR' });
    doc.meshes.push({ primitives: [{ attributes: { POSITION: accessor, NORMAL: accessor+1 }, indices: accessor+2, ...(role === 'render' ? { material: 0 } : {}) }] });
    const sourceObjectId = fixtureId(role, sourceKey), collisionFor = role === 'collision' ? [fixtureId('render', sourceKey)] : [];
    doc.nodes.push({ mesh: i, name: (role === 'render' ? 'SM_' : 'COL_') + sourceKey, translation: [i*2, 0, 0], extras: {
      arcane_identity_scheme: 'arcane-semantic-v1', arcane_source_object_id: sourceObjectId, arcane_source_key: sourceKey,
      arcane_role: role, arcane_pivot: [0,0,0], arcane_collision_for: JSON.stringify(collisionFor),
    } });
    doc.scenes[0].nodes.push(i);
    objects.push({ sourceObjectId, sourceKey, nodeIndex: i, role, pivot: [0,0,0], collisionFor });
  }
  mutate(doc);
  return { bytes: pack(doc, bin), objects, generator: doc.asset.generator as string };
}
export async function saveStudioFixture(directory: string, jobId: string, options: { wide?: boolean; mutate?: (doc: Record<string, any>) => void; evidence?: boolean } = {}): Promise<AssetManifest> {
  const manifest = await manifestFixture(directory), original = audit();
  manifest.jobId = jobId; manifest.runtime.version = '4.5.0';
  const validation = manifest.validation;
  validation.meshes = MODULE_KEYS.flatMap(k => [
    { ...structuredClone(original.meshes[0]!), name: 'SM_' + k }, { ...structuredClone(original.meshes[1]!), name: 'COL_' + k },
  ]);
  validation.totals.renderTriangles = 16; validation.totals.collisionTriangles = 16;
  validation.exports.forEach(e => { e.objects = 4; e.triangles = 16; });
  const request = Buffer.from(JSON.stringify(manifest.request));
  const modelRows: WorkerStudioImportEvidence['models'] = [];
  for (const role of ['render', 'collision'] as const) {
    const value = exported(role, options.wide ?? false, role === 'render' ? options.mutate ?? (() => {}) : () => {});
    const path = role === 'render' ? 'asset.glb' : 'collision.glb';
    await writeFile(join(directory, path), value.bytes);
    const row = manifest.artifacts.find(a => a.path === path)!; row.bytes = value.bytes.length; row.sha256 = sha256(value.bytes);
    modelRows.push({ path, sha256: row.sha256, byteLength: row.bytes, generator: value.generator, objects: value.objects, anchors: [] });
  }
  if (options.evidence !== false) validation.studioImport = {
    schemaVersion: 1, identityScheme: 'arcane-semantic-v1', assetId: fixtureId('asset', 'root'),
    blenderVersion: manifest.runtime.version, requestSha256: sha256(request), models: modelRows,
  };
  manifest.sourceRequestSha256 = sha256(request);
  manifest.artifacts.push({ path: 'input.json', role: 'request', bytes: request.length, sha256: manifest.sourceRequestSha256 });
  await writeFile(join(directory, 'input.json'), request);
  await saveFixtureManifest(directory, manifest);
  await writeFile(join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, state: 'succeeded', request: manifest.request,
    error: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }));
  return manifest;
}
export async function saveFixtureManifest(directory: string, manifest: AssetManifest): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest.validation));
  const row = manifest.artifacts.find(a => a.path === 'audit.json')!; row.bytes = bytes.length; row.sha256 = sha256(bytes);
  await writeFile(join(directory, 'audit.json'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
}
