import { ArcaneError } from '../../protocol/src/providers.js';
import { MESH_KEEP_LIMITS, object, type Json, type StudioSession } from '../../protocol/src/studio.js';

/** Wire validation for asset.keep_mesh ("Keep this mesh"). Only the host mesh-keep service can enqueue it (store admission);
 * the plugin (AssetPlacement.keep) re-validates every field, re-checks the signed-in Studio user and owns the engine calls.
 * Nothing here is consent: consent is the trusted desktop dialog recorded by the host before this command exists. */
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIFETIME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON = /^[A-Za-z0-9_:]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export const MESH_KEEP_STATES = ['kept', 'uploaded', 'partial', 'failed'] as const;
export type MeshKeepState = typeof MESH_KEEP_STATES[number];
export const MESH_KEEP_UPLOADS = ['succeeded', 'failed', 'reconciliation', 'skipped', 'reused'] as const;

function exact(value: unknown, fields: string[], label: string): Record<string, unknown> {
  const a = object(value, label), prototype = Object.getPrototypeOf(a);
  if ((prototype !== Object.prototype && prototype !== null) || Object.keys(a).some(key => !fields.includes(key))) throw new ArcaneError('INPUT', `Unexpected ${label} field.`);
  return a;
}
function id(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ArcaneError('INPUT', `Invalid ${label}.`);
  return value;
}
/** Asset name: what the user sees in the dialog and in their Roblox inventory. */
export function meshKeepName(value: unknown): string {
  if (typeof value !== 'string' || CONTROL.test(value) || !/\S/u.test(value) || [...value].length > MESH_KEEP_LIMITS.nameChars) throw new ArcaneError('INPUT', `Asset names are 1..${MESH_KEEP_LIMITS.nameChars} visible characters.`);
  return value;
}
export function meshKeepDescription(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || [...value].length > MESH_KEEP_LIMITS.descriptionChars) throw new ArcaneError('INPUT', 'Invalid asset description.');
  return value;
}

export function validateMeshKeep(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  exact(a, ['source', 'attemptId', 'name', 'description', 'creatorId', 'continuity', 'finish', 'assetIds'], 'keep-mesh arguments');
  if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Keeping a mesh swaps parts in Workspace; it requires the Workspace grant.');
  if (typeof a.source !== 'string' || !a.source.startsWith('editable-') || !DIGEST.test(a.source.slice(9))) throw new ArcaneError('INPUT', 'Expected an editable-<transfer digest> source.');
  if (typeof a.attemptId !== 'string' || !UUID.test(a.attemptId)) throw new ArcaneError('INPUT', 'Expected a host upload attempt ID.');
  meshKeepName(a.name); meshKeepDescription(a.description); id(a.creatorId, 'creator ID');
  const continuity = exact(a.continuity, ['clientLifetimeId', 'pluginArtifactHash', 'playEpoch'], 'keep-mesh continuity');
  if (typeof continuity.clientLifetimeId !== 'string' || !LIFETIME.test(continuity.clientLifetimeId) || typeof continuity.pluginArtifactHash !== 'string'
    || !DIGEST.test(continuity.pluginArtifactHash) || !Number.isSafeInteger(continuity.playEpoch) || (continuity.playEpoch as number) < 0) throw new ArcaneError('INPUT', 'Invalid keep-mesh continuity.');
  if (typeof a.finish !== 'boolean') throw new ArcaneError('INPUT', 'finish must be a boolean.');
  if (a.finish) {
    if (!Array.isArray(a.assetIds) || a.assetIds.length < 1 || a.assetIds.length > MESH_KEEP_LIMITS.meshes) throw new ArcaneError('INPUT', 'Finishing needs the recorded asset IDs.');
    a.assetIds.forEach(value => id(value, 'asset ID'));
  } else if (a.assetIds !== undefined) throw new ArcaneError('INPUT', 'A new keep never carries asset IDs.');
  return a;
}

export interface MeshKeepMeshReceipt { index: number; name: string; assetId: number | null; upload: typeof MESH_KEEP_UPLOADS[number]; reason: string | null; swapped: boolean }
export interface MeshKeepReceipt { state: MeshKeepState; meshes: MeshKeepMeshReceipt[]; uploadsStarted: number; swapped: number; persistence: 'saved-asset' | 'studio-session-only'; creatorId: number; ref: Json | null }

/** Closed check of the plugin's keep receipt against the exact command. The receipt is evidence of what Studio reported,
 * never proof that Roblox finished processing or moderation. */
export function validateMeshKeepReceipt(args: Record<string, Json>, value: unknown): MeshKeepReceipt {
  const r = exact(value, ['state', 'meshes', 'uploadsStarted', 'swapped', 'persistence', 'creatorId', 'ref'], 'keep-mesh receipt');
  if (!(MESH_KEEP_STATES as readonly unknown[]).includes(r.state) || !Array.isArray(r.meshes) || r.meshes.length < 1 || r.meshes.length > MESH_KEEP_LIMITS.meshes
    || r.creatorId !== args.creatorId || !Number.isSafeInteger(r.uploadsStarted) || (r.uploadsStarted as number) < 0 || (r.uploadsStarted as number) > r.meshes.length
    || !Number.isSafeInteger(r.swapped) || (r.swapped as number) < 0 || (r.swapped as number) > r.meshes.length) throw new ArcaneError('RECEIPT', 'Keep-mesh receipt is malformed.');
  const meshes = r.meshes.map((raw, index) => {
    const m = exact(raw, ['index', 'name', 'assetId', 'upload', 'reason', 'swapped'], 'kept mesh');
    if (m.index !== index + 1 || typeof m.name !== 'string' || m.name.length > 100 || !(MESH_KEEP_UPLOADS as readonly unknown[]).includes(m.upload)
      || !(m.assetId === null || Number.isSafeInteger(m.assetId) && (m.assetId as number) > 0) || !(m.reason === null || typeof m.reason === 'string' && REASON.test(m.reason))
      || typeof m.swapped !== 'boolean' || (m.swapped && m.assetId === null) || ((m.upload === 'succeeded' || m.upload === 'reused') !== (m.assetId !== null))) throw new ArcaneError('RECEIPT', 'Kept mesh entry is malformed.');
    return { index: m.index as number, name: m.name, assetId: m.assetId as number | null, upload: m.upload as MeshKeepMeshReceipt['upload'], reason: m.reason as string | null, swapped: m.swapped };
  });
  const ids = meshes.filter(m => m.assetId !== null).length, swapped = meshes.filter(m => m.swapped).length;
  if (swapped !== r.swapped) throw new ArcaneError('RECEIPT', 'Keep-mesh swap count differs from its entries.');
  if (args.finish === true) {
    const expected = args.assetIds as number[];
    if (meshes.length !== expected.length || meshes.some((m, i) => m.upload !== 'reused' || m.assetId !== expected[i]) || r.uploadsStarted !== 0) throw new ArcaneError('RECEIPT', 'Finishing must reuse exactly the recorded asset IDs and upload nothing.');
  } else if (meshes.some(m => m.upload === 'reused')) throw new ArcaneError('RECEIPT', 'A new keep cannot report reused assets.');
  const expectedState: MeshKeepState = ids === 0 ? 'failed' : ids < meshes.length ? 'partial' : swapped === meshes.length ? 'kept' : 'uploaded';
  if (r.state !== expectedState || r.persistence !== (expectedState === 'kept' ? 'saved-asset' : 'studio-session-only')) throw new ArcaneError('RECEIPT', 'Keep-mesh state differs from its entries.');
  if (r.ref !== null && (typeof r.ref !== 'object' || Array.isArray(r.ref))) throw new ArcaneError('RECEIPT', 'Keep-mesh model reference is malformed.');
  return { state: expectedState, meshes, uploadsStarted: r.uploadsStarted as number, swapped, persistence: r.persistence as MeshKeepReceipt['persistence'], creatorId: r.creatorId as number, ref: r.ref as Json | null };
}
