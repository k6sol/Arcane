import { ArcaneError } from './providers.js';

export const STUDIO_PROTOCOL = 1 as const;
export const ROOTS = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'] as const;
export type StudioRoot = typeof ROOTS[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface InstanceRef { instanceId: string; sessionId: string; root: StudioRoot; pathSegments: string[]; className: string }
export interface StudioIdentity { clientSessionId: string; placeId: number; universeId: number; name: string; pluginVersion: string }
export interface StudioSession extends StudioIdentity {
  id: string; protocolVersion: 1; allowedRoots: StudioRoot[]; allowWrites: boolean;
  capabilities: string[]; connectedAt: string; lastSeenAt: string; revokedAt: string | null;
  proof?: StudioContinuityProof;
}
/** Authenticated plugin heartbeat, timestamped by the host on receipt. It is
 * continuity/mapping evidence, never human playtest consent by itself. */
export interface StudioContinuityProof {
  sessionId: string; clientLifetimeId: string; pluginArtifactHash: string;
  markerName: string; placeId: number; universeId: number; placeName: string;
  mode: 'Edit' | 'Play'; playEpoch: number; continuitySupported: boolean;
  connected: boolean; observedAt: string; expiresAt: string;
}
export const READ_METHODS = ['scene.children', 'scene.inspect', 'scene.search', 'selection.read', 'script.read', 'script.search', 'scene.import_context', 'scene.upload_context', 'scene.asset_watch', 'output.read'] as const;
/** output.read: the plugin keeps a bounded ring of this Studio's Output lines (seeded from LogService history, then
 * MessageOut), numbered by a per-pairing sequence so `after` is an exact cursor. Place-wide, read-only, untrusted text. */
export const OUTPUT_READ_LIMITS = Object.freeze({ buffer: 500, entries: 100, messageBytes: 1024, queryBytes: 100, cursor: 2_147_483_647 });
export const OUTPUT_LEVELS = ['output', 'info', 'warning', 'error'] as const;
export const WRITE_METHODS = ['scene.create', 'scene.update', 'script.update', 'script.set_enabled', 'scene.restore', 'scene.remove', 'scene.build', 'environment.apply', 'scene.place_asset', 'scene.apply_material', 'terrain.generate'] as const;
/** Native asset adoption (plugin side). scene.asset_watch arms a one-shot Workspace insertion watch;
 * scene.place_asset adopts exactly one natively inserted/generated instance, strips scripts by default,
 * fits, grounds, anchors and parents it under one receipt; scene.apply_material applies a generated
 * MaterialVariant to bounded parts under one receipt. scene.build clone items copy a script-free template. */
export const ASSET_PLACE_LIMITS = Object.freeze({ descendants: 5000, templateDescendants: 2000, templates: 16, materialTargets: 64, watchSeconds: 600, arrivalSeconds: 10 });
/** One atomic hierarchy per scene.build command: one undo recording and one receipt.
 * instances counts every created Instance, including the root, placement Models and welds. */
export const SCENE_REMOVE_LIMITS = Object.freeze({ targets: 64, topLevel: 10000, descendants: 100000 });
export const SCENE_BUILD_LIMITS = Object.freeze({ items: 2000, prototypes: 32, prototypeParts: 64, instances: 4000, keys: 32 });
/** environment.apply: bounded terrain fills plus Lighting/effect settings in one undo recording.
 * Terrain is undone with Studio Undo; receipts record the prior lighting values. */
export const ENVIRONMENT_LIMITS = Object.freeze({ terrainShapes: 128, extent: 2048, volume: 400_000_000 });
/** terrain.generate: one seeded heightfield (noise + landform/water features + material rules) written to
 * a 4-stud-grid region in bounded WriteVoxels chunks, one undo recording. Reverted with Studio Undo only. */
export const TERRAIN_LIMITS = Object.freeze({ extent: 2048, minExtent: 16, height: 512, minHeight: 8, coordinate: 100000, floor: 10000,
  features: 32, points: 32, rules: 16, octaves: 8, voxel: 4, voxels: 33_554_432, chunkVoxels: 524_288 });
/** Non-method plugin capability: effects classes in scene.create/scene.build, environment presets,
 * Lighting.Technology, Terrain.Decoration, MaterialVariants and scene.inspect bounds. Older plugins never advertise it. */
export const STUDIO_EFFECTS_CAPABILITY = 'scene.effects' as const;
export const EFFECT_LIMITS = Object.freeze({ properties: 32, keypoints: 20, materials: 8 });
/** Non-method plugin capability: GUI classes (ScreenGui/SurfaceGui/BillboardGui, GuiObjects and UI modifiers) in
 * scene.create/scene.build, ScreenGui build roots and GUI prototypes stamped by scene.build. Older plugins never advertise it. */
export const STUDIO_GUI_CAPABILITY = 'scene.gui' as const;
/** Non-method feature capability: UIFlexItem and flex/wrap properties on UIListLayout. */
export const STUDIO_GUI_FLEX_CAPABILITY = 'scene.gui.flex' as const;
/** Non-method feature: exact native GUI observations, bounded edits and receipt restoration. */
export const STUDIO_GUI_EDIT_CAPABILITY = 'scene.gui.edit' as const;
/** Non-method plugin capability: character classes (Humanoid, HumanoidDescription, AnimationController, Animator) with typed,
 * bounded properties in scene.create/scene.build. Rig parts, joints and animations stay with server Scripts. Older plugins never advertise it. */
export const STUDIO_CHARACTERS_CAPABILITY = 'scene.characters' as const;
/** Non-method feature capability: scene.search filters by className (IsA), with or without a name query. */
export const STUDIO_SEARCH_CLASS_CAPABILITY = 'scene.search.class' as const;
/** Non-method feature capability: environment.apply forest looks (forest-* presets), the depthOfField and sky
 * Lighting-child sections and Lighting.GeographicLatitude. Older plugins never advertise it. */
export const STUDIO_ENVIRONMENT_FOREST_CAPABILITY = 'environment.forest' as const;
/** Most capability strings one pairing may advertise (methods + feature capabilities + diagnostics), with headroom
 * so a new method or feature never makes pairing reject a current plugin. */
export const STUDIO_PAIRING_CAPABILITY_LIMIT = 64;
/** Every non-method feature capability a plugin may advertise at pairing (anything else must be a known method). */
export const STUDIO_FEATURE_CAPABILITIES: readonly string[] = Object.freeze([STUDIO_EFFECTS_CAPABILITY, STUDIO_GUI_CAPABILITY, STUDIO_GUI_FLEX_CAPABILITY, STUDIO_GUI_EDIT_CAPABILITY, STUDIO_CHARACTERS_CAPABILITY, 'asset.mesh_parts', STUDIO_SEARCH_CLASS_CAPABILITY, STUDIO_ENVIRONMENT_FOREST_CAPABILITY]);
/** GUI value bounds: Text/PlaceholderText UTF-8 bytes, UDim scale magnitude and integer pixel-offset magnitude. */
export const GUI_LIMITS = Object.freeze({ textBytes: 2000, udimScale: 10, udimOffset: 10000 });
/** Host-owned intake and detached reconstruction. Neither is a generic agent
 * scene command or reversible mutation. */
export const ASSET_STAGE_METHODS = ['asset.stage_packet', 'asset.reconstruct'] as const;
/** Raw serialized sender packets and COMPLETE staging arguments are independent
 * budgets. The envelope allowance uses 4096 bytes per possible packet, matching
 * the chunk encoder's reserve; metadata/escaping still requires actual measured
 * per-packet and aggregate checks. A near-limit raw transfer may not fit. */
export const STUDIO_ASSET_TRANSFER_LIMITS = Object.freeze({packets:512,packetBytes:256*1024,
  rawBytes:48*1024*1024,envelopeReserveBytes:4096,envelopeBytes:48*1024*1024+512*4096});
/** "Keep this mesh": uploads the retained procedural EditableMeshes of one placement to the signed-in Studio user's own
 * Roblox account (AssetService:CreateAssetAsync) and swaps the session MeshParts for persistent ones. Host-owned only:
 * the store admits it solely from the mesh-keep service after a human-confirmed trusted-dialog consent (docs/build/MESH_KEEP.md).
 * Plugins advertise it only when their capability probe finds the upload API in the running Studio. */
export const MESH_KEEP_METHODS = ['asset.keep_mesh'] as const;
export const MESH_KEEP_LIMITS = Object.freeze({ meshes: 16, nameChars: 50, descriptionChars: 1000 });
export type StudioMethod = typeof READ_METHODS[number] | typeof WRITE_METHODS[number] | typeof ASSET_STAGE_METHODS[number] | typeof MESH_KEEP_METHODS[number];
export interface StudioAssetStageArgs {
  expected: { digest: string; payloadDigest: string; manifestDigest: string };
  packet: string;
  target: { sessionId: string; placeId: number; universeId: number; root: 'Workspace'; parentRef: string; creator: { kind: 'user' | 'group'; id: string } };
  continuity: { clientLifetimeId: string; pluginArtifactHash: string; playEpoch: number };
}
export interface StudioAssetStageReceipt {
  transferDigest: string; packetCount: number; byteLength: number;
  state: 'receiving' | 'sealed'; engineVerification: 'pending';
}
/** Detached reconstruction only. These bounds are per owned transfer; the
 * plugin retains at most two transfers and never evicts a live owner. */
export const STUDIO_RECONSTRUCTION_LIMITS = Object.freeze({objects:128,vertices:120000,triangles:40000});
export interface StudioAssetReconstructedObject {
  sourceObjectId:string;meshExportSha256:string;vertexCount:number;triangleCount:number;
}
export interface StudioAssetReconstructArgs {
  runId:string;expected:StudioAssetStageArgs['expected'];
  packetCount:number;byteLength:number;target:StudioAssetStageArgs['target'];continuity:StudioAssetStageArgs['continuity'];
  objects:StudioAssetReconstructedObject[];
}
export interface StudioAssetReconstructReceipt {
  runId:string;transferDigest:string;state:'reconstructed';objects:StudioAssetReconstructedObject[];
  imported:false;engineVerification:'pending';
}
export type CommandState = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'needs_reconciliation';
export interface StudioCommand {
  protocolVersion: 1; id: string; requestId: string; sessionId: string; clientSessionId: string;
  method: StudioMethod; args: Record<string, Json>; allowedRoots: StudioRoot[]; allowWrites: boolean;
  leaseEpoch: number; expiresAt: string; state: CommandState; createdAt: string;
  finishedAt: string | null; result: Json | null; error: string | null;
}
/** Observations from the paired plugin, not upload authority or import acceptance.
 * Keep the raw nonnegative creator ID: only three observed zero IDs permit the
 * separate local Studio user observation. Never substitute that user for an owner. */
export type StudioPlaceCreatorObservation =
  | { status: 'available'; kind: 'user' | 'group'; id: number; provenance: 'game.CreatorType/CreatorId' }
  | { status: 'unavailable'; kind: null; id: number; provenance: 'game.CreatorType/CreatorId' };
export type StudioUserObservation =
  | { status: 'available'; id: number; provenance: 'StudioService:GetUserId' }
  | { status: 'unavailable' | 'not_applicable'; id: null; provenance: 'StudioService:GetUserId' };
export interface StudioImportContextObservation {
  sessionId: string; root: 'Workspace'; parentRef: InstanceRef;
  placeId: number; universeId: number; mode: 'Edit' | 'Play';
  modeProvenance: 'StudioTestService.EditModeActive';
  creator: StudioPlaceCreatorObservation; studioUser: StudioUserObservation;
}
/** Uploader is observed separately even for published places. A place creator
 * is never assumed to be the signed-in user, or evidence of upload permission. */
export interface StudioUploadContextObservation extends StudioImportContextObservation {
  uploader: {status: 'available'; id: number; provenance: 'StudioService:GetUserId'}
    | {status: 'unavailable'; id: null; provenance: 'StudioService:GetUserId'};
}
export interface MutationReceipt {
  kind: 'scene.remove' | 'scene.create' | 'scene.update' | 'script.update' | 'script.set_enabled' | 'scene.build' | 'environment.apply' | 'scene.place_asset' | 'scene.apply_material' | 'terrain.generate'; ref: InstanceRef;
  before: Record<string, Json> | null; after: Record<string, Json>;
}
export interface PluginPairInput { code: string; protocolVersion: 1; identity: StudioIdentity; capabilities: string[] }
export interface PairingGrant { code: string; expiresAt: string; protocolVersion: 1; allowedRoots: StudioRoot[]; allowWrites: boolean }
export interface PairResult { sessionId: string; token: string; protocolVersion: 1; allowedRoots: StudioRoot[]; allowWrites: boolean }

export function object(value: unknown, label = 'input'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArcaneError('INPUT', `${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function textField(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) throw new ArcaneError('INPUT', `Invalid ${label}.`);
  return value;
}
export function roots(value: unknown): StudioRoot[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROOTS.length || value.some(r => !ROOTS.includes(r))) throw new ArcaneError('INPUT', 'Choose explicit supported Studio roots.');
  return [...new Set(value)] as StudioRoot[];
}
export function isWrite(method: StudioMethod): boolean { return ([...WRITE_METHODS, ...ASSET_STAGE_METHODS, ...MESH_KEEP_METHODS] as readonly string[]).includes(method); }
export function methodField(value: unknown): StudioMethod {
  if (![...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS, ...MESH_KEEP_METHODS].includes(value as StudioMethod)) throw new ArcaneError('METHOD', 'Unsupported Studio method. Raw Luau execution is not exposed.');
  return value as StudioMethod;
}
export function instanceRef(value: unknown): InstanceRef {
  const r = object(value, 'instance reference');
  if (!ROOTS.includes(r.root as StudioRoot) || !Array.isArray(r.pathSegments) || r.pathSegments.length > 64 || r.pathSegments.some(p => typeof p !== 'string' || p.length > 256)) throw new ArcaneError('INPUT', 'Invalid instance reference.');
  return { instanceId: textField(r.instanceId, 'instance ID'), sessionId: textField(r.sessionId, 'session ID'), root: r.root as StudioRoot, pathSegments: r.pathSegments as string[], className: textField(r.className, 'class name') };
}
/** Closed decoder for host-owned receipt consumers. Display paths never resolve
 * Instances; the plugin Registry owns the opaque parentRef.instanceId. */
export function studioImportContextObservation(value: unknown): StudioImportContextObservation {
  function closed(value: unknown, fields: string[], label: string): Record<string, unknown> {
    const result = object(value, label), prototype = Object.getPrototypeOf(result);
    const names = Reflect.ownKeys(result);
    if ((prototype !== Object.prototype && prototype !== null) || names.length !== fields.length
      || names.some(key => typeof key !== 'string' || !fields.includes(key))
      || fields.some(key => !Object.hasOwn(result, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(result, key)!, 'value'))) {
      throw new ArcaneError('INPUT', `Invalid ${label} fields.`);
    }
    return result;
  }
  function id(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ArcaneError('INPUT', `Invalid ${label}.`);
    return value;
  }
  const a = closed(value, ['sessionId', 'root', 'parentRef', 'placeId', 'universeId', 'mode', 'modeProvenance', 'creator', 'studioUser'], 'import context');
  const parent = instanceRef(closed(a.parentRef, ['instanceId', 'sessionId', 'root', 'pathSegments', 'className'], 'Workspace reference'));
  const sessionId = textField(a.sessionId, 'session ID');
  if (a.root !== 'Workspace' || parent.root !== 'Workspace' || parent.className !== 'Workspace'
    || parent.pathSegments.length !== 0 || parent.sessionId !== sessionId) throw new ArcaneError('SCOPE', 'Import context requires the exact session Workspace root reference.');
  if ((a.mode !== 'Edit' && a.mode !== 'Play') || a.modeProvenance !== 'StudioTestService.EditModeActive') throw new ArcaneError('INPUT', 'Invalid observed Studio mode.');
  const placeId = id(a.placeId, 'place ID'), universeId = id(a.universeId, 'universe ID');
  const creator = closed(a.creator, ['status', 'kind', 'id', 'provenance'], 'place creator');
  const creatorId = id(creator.id, 'creator ID');
  if (creator.provenance !== 'game.CreatorType/CreatorId'
    || !(creator.status === 'available' && creatorId > 0 && (creator.kind === 'user' || creator.kind === 'group')
      || creator.status === 'unavailable' && creator.kind === null)) throw new ArcaneError('INPUT', 'Invalid place creator observation.');
  const user = closed(a.studioUser, ['status', 'id', 'provenance'], 'Studio user');
  const local = placeId === 0 && universeId === 0 && creatorId === 0;
  if (user.provenance !== 'StudioService:GetUserId'
    || !(local
      ? user.status === 'available' && id(user.id, 'Studio user ID') > 0 || user.status === 'unavailable' && user.id === null
      : user.status === 'not_applicable' && user.id === null)) throw new ArcaneError('INPUT', 'Invalid local Studio user observation.');
  return { sessionId, root: 'Workspace', parentRef: { ...parent, pathSegments: [...parent.pathSegments] }, placeId, universeId, mode: a.mode,
    modeProvenance: 'StudioTestService.EditModeActive',
    creator: { status: creator.status, kind: creator.kind, id: creatorId, provenance: creator.provenance } as StudioPlaceCreatorObservation,
    studioUser: { status: user.status, id: user.id, provenance: user.provenance } as StudioUserObservation };
}
export function studioUploadContextObservation(value: unknown): StudioUploadContextObservation {
  const fields = ['sessionId', 'root', 'parentRef', 'placeId', 'universeId', 'mode', 'modeProvenance', 'creator', 'studioUser', 'uploader'];
  const input = object(value, 'upload context'), prototype = Object.getPrototypeOf(input);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(input).length !== fields.length
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))) throw new ArcaneError('INPUT', 'Unexpected upload context fields.');
  const base: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new ArcaneError('INPUT', 'Upload context must contain plain observation data.');
    if (field !== 'uploader') base[field] = descriptor.value;
  }
  const observation = studioImportContextObservation(base), uploader = object(Object.getOwnPropertyDescriptor(input, 'uploader')!.value, 'uploader');
  const up = Object.getPrototypeOf(uploader), names = Reflect.ownKeys(uploader);
  if ((up !== Object.prototype && up !== null) || names.length !== 3 || names.some(key => typeof key !== 'string' || !['status', 'id', 'provenance'].includes(key))
    || names.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(uploader, key)!, 'value'))
    || uploader.provenance !== 'StudioService:GetUserId'
    || !(uploader.status === 'available' && Number.isSafeInteger(uploader.id) && (uploader.id as number) > 0
      || uploader.status === 'unavailable' && uploader.id === null)) throw new ArcaneError('INPUT', 'Invalid actual uploader observation.');
  return {...observation, uploader: {status: uploader.status, id: uploader.id, provenance: uploader.provenance} as StudioUploadContextObservation['uploader']};
}
export function jsonObject(value: unknown, maxBytes = 256 * 1024): Record<string, Json> {
  const o = object(value);
  const serialized = JSON.stringify(o);
  if (Buffer.byteLength(serialized) > maxBytes) throw new ArcaneError('BODY_LIMIT', 'JSON payload exceeds its byte limit.');
  function validate(v: unknown, depth: number): void {
    if (depth > 80) throw new ArcaneError('INPUT', 'JSON nesting is too deep.');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) { for (const item of v) validate(item, depth + 1); return; }
    if (v && typeof v === 'object') { for (const [k, item] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new ArcaneError('INPUT', 'Reserved JSON key.'); validate(item, depth + 1); } return; }
    throw new ArcaneError('INPUT', 'Command contains a non-JSON value.');
  }
  validate(o, 0); return JSON.parse(serialized) as Record<string, Json>;
}
