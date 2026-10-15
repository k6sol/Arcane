import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateGlb } from '../../desktop/src/glb-preflight.js';
import { AssetError, type AssetManifest, type AssetRequest } from '../../../packages/asset-pipeline/src/types.js';
import { STUDIO_IMPORT_LIMITS, type HostGeneratedStudioImport, type StudioImportBaseline, type StudioImportSelection } from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { assertNativeAssetActor, nativeAssetActorScope, type NativeAssetActor, type NativeAssetScope } from './native-asset-authority.js';

export interface StudioImportHostOptions {
  /** Borrowed canonical project store. No generic bearer or request identity can substitute. */
  workAssociations: ConversationWorkStore;
  /** Fresh controller-owned preparation identity, never a request argument. */
  beginPreparationAttempt?(scope: NativeAssetScope, jobId: string, actor: NativeAssetActor, guard: () => void): StudioImportPreparationAttempt;
  /** Host selects an observed Studio target/placement, without editor discovery here.
   * Never construct this callback from HTTP target/session/project fields. */
  selectTarget(scope: NativeAssetScope, jobId: string, actor: NativeAssetActor, guard: () => void): StudioImportSelection | Promise<StudioImportSelection>;
  /** Synchronous continuity check after every awaited read once a target exists. */
  validateTarget?(scope: NativeAssetScope, jobId: string, target: StudioImportSelection): void;
  /** Optional HOST ONLY durable, observed engine receipt lookup. No request-body baseline.
   * Absence means an initial preparation, never an invented prior mapping. */
  loadObservedBaseline?(scope: NativeAssetScope, assetId: string, target: StudioImportSelection['target']): StudioImportBaseline | null | Promise<StudioImportBaseline | null>;
  /** Commit pending metadata only, never import authority or an engine baseline. */
  recordPrepared?(scope: NativeAssetScope, jobId: string, prepared: import('../../../packages/asset-pipeline/src/studio-import-manifest.js').PreparedStudioImport,
    actor: NativeAssetActor, guard: () => void, attempt?: StudioImportPreparationAttempt): void | Promise<void>;
  /** Release only this host capture, even when its native actor has retired. */
  releaseTarget?(scope: NativeAssetScope, jobId: string): void;
}
/** The producing host also checks the exact object/actor in its WeakMap. */
export interface StudioImportPreparationAttempt { readonly kind: 'studio-import-preparation-attempt'; readonly id: string }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stable = z.string().regex(/^arcane_[a-f0-9]{64}$/);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const num = z.number().finite().min(-1_000_000).max(1_000_000);
const vec = z.tuple([num, num, num]);
const affine = z.array(num).length(16).refine(m => m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1);
const object = z.strictObject({ sourceObjectId: stable, sourceKey: key, nodeIndex: z.number().int().min(0).max(4095),
  role: z.enum(['render', 'collision']), pivot: vec, collisionFor: z.array(stable).max(128) });
const anchor = z.strictObject({ sourceAnchorId: stable, sourceKey: key, sourceObjectId: stable,
  nodeIndex: z.number().int().min(0).max(4095), kind: z.enum(['socket', 'attachment']), transform: affine });
const evidenceSchema = z.strictObject({ schemaVersion: z.literal(1), identityScheme: z.literal('arcane-semantic-v1'),
  assetId: stable, blenderVersion: z.string().regex(/^[A-Za-z0-9 .+_-]{1,128}$/), requestSha256: hash,
  models: z.array(z.strictObject({ path: z.enum(['asset.glb', 'collision.glb']), sha256: hash,
    byteLength: z.number().int().min(1).max(STUDIO_IMPORT_LIMITS.fileBytes),
    generator: z.string().regex(/^Khronos glTF Blender I\/O v[0-9]+(?:\.[0-9]+){1,3}$/),
    objects: z.array(object).min(1).max(128), anchors: z.array(anchor).max(64) })).length(2) });
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function evidenceFailure(): never { throw new AssetError('STUDIO_IMPORT_EVIDENCE', 'Worker import identity/export evidence disagrees with the completed job.'); }
/** Verify an emitted ID; this never manufactures fallback identities for old exports. */
function expectedId(request: AssetRequest, role: string, sourceKey: string): string {
  return 'arcane_' + sha(['arcane-semantic-v1', request.template, request.name, role, sourceKey].join('\0'));
}
/** Recheck SAME native capture and exact durable job attribution, including null session. */
export function assertStudioImportJobScope(projectPath: string, store: ConversationWorkStore, actor: NativeAssetActor, jobId: string): NativeAssetScope {
  assertNativeAssetActor(actor, 'mutate');
  const scope = nativeAssetActorScope(actor);
  if (!(store instanceof ConversationWorkStore) || store.projectPath !== projectPath || scope.projectPath !== projectPath || scope.projectId !== store.projectId) {
    throw new ArcaneError('STUDIO_IMPORT_SCOPE', 'Studio import preparation requires the exact native project scope.');
  }
  const binding = store.binding('asset-job', jobId);
  if (!binding || binding.projectId !== scope.projectId || binding.conversation.provider !== scope.conversation.provider ||
      binding.conversation.threadId !== scope.conversation.threadId || binding.conversation.sessionId !== scope.conversation.sessionId) {
    throw new ArcaneError('NOT_FOUND', 'No completed asset job is bound to this native conversation.');
  }
  return scope;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
type Node = { mesh?: number; name?: string; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; extras?: Record<string, unknown> };
function local(n: Node): number[] {
  if (n.matrix) return n.matrix;
  const [x = 0, y = 0, z = 0, w = 1] = n.rotation ?? [], [sx = 1, sy = 1, sz = 1] = n.scale ?? [];
  return [(1 - 2 * (y*y + z*z))*sx, 2*(x*y + z*w)*sx, 2*(x*z - y*w)*sx, 0,
    2*(x*y - z*w)*sy, (1 - 2*(x*x + z*z))*sy, 2*(y*z + x*w)*sy, 0,
    2*(x*z + y*w)*sz, 2*(y*z - x*w)*sz, (1 - 2*(x*x + y*y))*sz, 0, ...(n.translation ?? [0, 0, 0]), 1];
}
function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((sum, k) => sum + a[k*4 + i%4]! * b[Math.floor(i/4)*4 + k]!, 0));
}
function sourceKeys(request: AssetRequest, role: 'render' | 'collision'): string[] {
  if (request.recipe) return request.recipe.parts.filter(p => p.role === role).map(p => p.name).sort();
  if (request.template === 'environment-kit') return ['floor', 'pillar', 'step', 'wall'];
  return role === 'collision' ? ['body_proxy'] : ['body', 'handle', 'handle_support0', 'handle_support1', 'lid', 'plaque', 'post0', 'post1', 'post2', 'post3'];
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Pure adaptation of already service-verified job bytes. The service owns reading,
 * ownership and rechecks; this adapter never accepts paths or obtains bytes from HTTP. */
export function adaptCompletedStudioImport(manifest: AssetManifest, exports: ReadonlyMap<'asset.glb' | 'collision.glb', Buffer>,
  projectId: string, selection: StudioImportSelection, baseline: StudioImportBaseline | null): HostGeneratedStudioImport {
  if (!manifest.validation.studioImport) throw new AssetError('STUDIO_IMPORT_UNSUPPORTED', 'This completed job predates producer import identities; generate a new owned job.');
  const parsed = evidenceSchema.safeParse(manifest.validation.studioImport);
  if (!parsed.success) evidenceFailure();
  const evidence = parsed.data, request = manifest.request;
  const req = manifest.artifacts.find(a => a.path === 'request.json' && a.role === 'request');
  const input = manifest.artifacts.find(a => a.path === 'input.json' && a.role === 'request');
  const scene = manifest.artifacts.find(a => a.path === 'asset.blend' && a.role === 'scene');
  if (!req || !input || !scene || input.sha256 !== manifest.sourceRequestSha256 || evidence.requestSha256 !== req.sha256 ||
      evidence.blenderVersion !== manifest.runtime.version || evidence.assetId !== expectedId(request, 'asset', 'root') ||
      new Set(evidence.models.map(m => m.path)).size !== 2) evidenceFailure();
  const files: HostGeneratedStudioImport['files'] = [], models: HostGeneratedStudioImport['models'] = [], anchors: HostGeneratedStudioImport['anchors'] = [];
  let total = 0;
  for (const model of evidence.models) {
    const bytes = exports.get(model.path), artifact = manifest.artifacts.find(a => a.path === model.path && a.role === 'export');
    if (!bytes || !artifact || bytes.length !== artifact.bytes || bytes.length !== model.byteLength || sha(bytes) !== artifact.sha256 || model.sha256 !== artifact.sha256) evidenceFailure();
    total += bytes.length;
    if (bytes.length > STUDIO_IMPORT_LIMITS.fileBytes || total > STUDIO_IMPORT_LIMITS.totalBytes) evidenceFailure();
    const jsonSize = bytes.length >= 20 ? bytes.readUInt32LE(12) : 0;
    if (jsonSize > STUDIO_IMPORT_LIMITS.jsonBytes) evidenceFailure();
    validateGlb(bytes);
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonSize))) as { asset: { generator?: string }; nodes?: Node[] };
    if (doc.asset.generator !== model.generator || evidence.models.some(m => m.generator !== model.generator)) evidenceFailure();
    const nodes = doc.nodes ?? [], role = model.path === 'asset.glb' ? 'render' : 'collision';
    if (!same(model.objects.map(o => o.sourceKey).sort(), sourceKeys(request, role)) ||
        nodes.filter(n => n.mesh !== undefined).length !== model.objects.length || new Set(model.objects.map(o => o.nodeIndex)).size !== model.objects.length) evidenceFailure();
    const renderIds = sourceKeys(request, 'render').map(k => expectedId(request, 'render', k)).sort();
    for (const obj of model.objects) {
      const node = nodes[obj.nodeIndex], extra = node?.extras;
      const collisions = role === 'render' ? [] : request.template === 'environment-kit' ? [expectedId(request, 'render', obj.sourceKey)] : renderIds;
      if (!node || node.mesh === undefined || !extra || obj.role !== role || obj.sourceObjectId !== expectedId(request, role, obj.sourceKey) ||
          extra.arcane_identity_scheme !== evidence.identityScheme || extra.arcane_source_key !== obj.sourceKey || extra.arcane_role !== obj.role ||
          extra.arcane_source_object_id !== obj.sourceObjectId || !same(obj.pivot, [0, 0, 0]) || !same(extra.arcane_pivot, obj.pivot) ||
          !same(obj.collisionFor, collisions) || extra.arcane_collision_for !== JSON.stringify(collisions)) evidenceFailure();
    }
    const parents = new Map<number, number>();
    nodes.forEach((n, i) => n.children?.forEach(c => parents.set(c, i)));
    const world = (i: number): number[] => {
      const parent = parents.get(i); return multiply(parent === undefined ? IDENTITY : world(parent), local(nodes[i]!));
    };
    const expectedSockets = role === 'render' ? request.recipe?.sockets ?? [] : [];
    if (model.anchors.length !== expectedSockets.length || new Set(model.anchors.map(a => a.sourceKey)).size !== model.anchors.length ||
        nodes.filter(n => n.extras?.arcane_source_anchor_id !== undefined).length !== model.anchors.length) evidenceFailure();
    for (const a of model.anchors) {
      const socket = expectedSockets.find(s => s.name === a.sourceKey), node = nodes[a.nodeIndex], extra = node?.extras;
      const measured = node ? world(a.nodeIndex) : [];
      const parent = parents.get(a.nodeIndex);
      if (!socket || !node || node.mesh !== undefined || !extra || a.kind !== socket.kind ||
          a.sourceAnchorId !== expectedId(request, 'anchor', socket.name) || a.sourceObjectId !== expectedId(request, 'render', socket.part) ||
          extra.arcane_identity_scheme !== evidence.identityScheme || extra.arcane_source_key !== a.sourceKey ||
          extra.arcane_source_anchor_id !== a.sourceAnchorId || extra.arcane_source_object_id !== a.sourceObjectId ||
          parent === undefined || !model.objects.some(o => o.nodeIndex === parent && o.sourceObjectId === a.sourceObjectId) ||
          measured.some((n, i) => Math.abs(n - a.transform[i]!) > 1e-5)) evidenceFailure();
      anchors.push({ sourceAnchorId: a.sourceAnchorId, sourceObjectId: a.sourceObjectId, kind: a.kind, transform: a.transform });
    }
    const fileId = role === 'render' ? 'render-export' : 'collision-export';
    files.push({ fileId, contentType: 'model/gltf-binary', bytes, sha256: artifact.sha256 });
    models.push({ fileId, resources: [], objects: model.objects.map(({ sourceKey: _key, ...o }) => o) });
  }
  // Pin actual input, scene and bundled worker bytes without exposing executable or paths.
  return { schemaVersion: 1, projectId, assetId: evidence.assetId, revisionId: manifest.jobId,
    sourceSha256: sha([input.sha256, req.sha256, scene.sha256, manifest.templateSha256].join('\n')),
    producer: { blenderVersion: evidence.blenderVersion, exporterVersion: evidence.models[0]!.generator.replace('I/O', 'IO') },
    ...selection, files, models, anchors, baseline };
}
