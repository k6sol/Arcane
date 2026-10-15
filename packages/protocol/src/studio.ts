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
export const READ_METHODS = ['scene.children', 'scene.inspect', 'scene.search', 'selection.read', 'script.read', 'script.search', 'scene.import_context', 'scene.upload_context'] as const;
export const WRITE_METHODS = ['scene.create', 'scene.update', 'script.update', 'script.set_enabled', 'scene.restore'] as const;
/** Host-owned intake and detached reconstruction. Neither is a generic agent
 * scene command or reversible mutation. */
export const ASSET_STAGE_METHODS = ['asset.stage_packet', 'asset.reconstruct'] as const;
export type StudioMethod = typeof READ_METHODS[number] | typeof WRITE_METHODS[number] | typeof ASSET_STAGE_METHODS[number];
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
  kind: 'scene.create' | 'scene.update' | 'script.update' | 'script.set_enabled'; ref: InstanceRef;
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
export function isWrite(method: StudioMethod): boolean { return [...WRITE_METHODS, ...ASSET_STAGE_METHODS].includes(method as typeof WRITE_METHODS[number] | typeof ASSET_STAGE_METHODS[number]); }
export function methodField(value: unknown): StudioMethod {
  if (![...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS].includes(value as StudioMethod)) throw new ArcaneError('METHOD', 'Unsupported Studio method. Raw Luau execution is not exposed.');
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
