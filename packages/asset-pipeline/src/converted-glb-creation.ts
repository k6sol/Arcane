import { types } from 'node:util';
import { assetName } from './paths.js';
import { JOB_JOURNAL_BYTES } from './recipe.js';
import { parseConvertedGlbRequest, type ConvertedGlbRequest } from './converted-glb.js';
import { AssetError, type AssetJob } from './types.js';

/** Display/lineage metadata only: no source fidelity, persistence, worker-close,
 * ownership, review or import authority is established by this descriptor. */
export interface ConvertedGlbCreation {
  readonly schemaVersion: 1;
  readonly kind: 'arcane-glb-conversion-creation';
  readonly jobId: string;
  readonly parentJobId: string;
  readonly parentManifestSha256: string;
  readonly name: string;
  readonly collision: 'none' | 'convex-hull';
  readonly renderResolution: number;
  readonly renderSamples: number;
}
export interface ConvertedGlbJob extends Readonly<AssetJob> { readonly creation: ConvertedGlbCreation }
export type ConvertedGlbJobMetadata =
  | Readonly<{ form: 'new-pending'; jobId: string; name: string; creation: ConvertedGlbCreation; request: null }>
  | Readonly<{ form: 'new-prepared'; jobId: string; name: string; creation: ConvertedGlbCreation; request: ConvertedGlbRequest }>
  | Readonly<{ form: 'legacy-pending'; jobId: string; name: null; creation: null; request: null }>
  | Readonly<{ form: 'legacy-prepared'; jobId: string; name: string; creation: null; request: ConvertedGlbRequest }>;

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const CREATION_FIELDS = ['schemaVersion', 'kind', 'jobId', 'parentJobId', 'parentManifestSha256',
  'name', 'collision', 'renderResolution', 'renderSamples'] as const;
function fail(): never { throw new AssetError('ASSET_CONVERSION_CREATION', 'Conversion creation metadata is missing, malformed or inconsistent.'); }
function ownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string' || key.length > 64)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') fail();
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    out[key] = descriptor.value as unknown;
  }
  return out;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 48 || value.trim() !== value) fail();
  return assetName(value);
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
export function parseConvertedGlbCreation(value: unknown): ConvertedGlbCreation {
  try {
    const data = ownRecord(value), keys = Object.keys(data);
    if (keys.length !== CREATION_FIELDS.length || keys.some(key => !CREATION_FIELDS.some(field => field === key)) ||
        data.schemaVersion !== 1 || data.kind !== 'arcane-glb-conversion-creation') fail();
    const jobId = uuid(data.jobId), parentJobId = uuid(data.parentJobId);
    if (jobId === parentJobId || typeof data.parentManifestSha256 !== 'string' || !HASH.test(data.parentManifestSha256) ||
        (data.collision !== 'none' && data.collision !== 'convex-hull')) fail();
    const creation: ConvertedGlbCreation = { schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId, parentJobId,
      parentManifestSha256: data.parentManifestSha256, name: name(data.name), collision: data.collision,
      renderResolution: integer(data.renderResolution, 128, 1024), renderSamples: integer(data.renderSamples, 1, 64) };
    if (Buffer.byteLength(JSON.stringify(creation)) > 1024) fail();
    return Object.freeze(creation);
  } catch { fail(); }
}
export function makeConvertedGlbCreation(jobId: string, captured: unknown): ConvertedGlbCreation {
  const data = ownRecord(captured), fields = ['parentJobId', 'parentManifestSha256', 'name', 'collision', 'renderResolution', 'renderSamples'];
  if (Object.keys(data).length !== fields.length || Object.keys(data).some(key => !fields.includes(key))) fail();
  return parseConvertedGlbCreation({ schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId,
    parentJobId: data.parentJobId, parentManifestSha256: data.parentManifestSha256, name: data.name,
    collision: data.collision, renderResolution: data.renderResolution, renderSamples: data.renderSamples });
}

/** Bound/copy a journal as plain data before reading metadata. Worker fields are
 * preserved only in the caller's original journal; this parser proves no closure. */
function journalSnapshot(input: unknown): Record<string, unknown> {
  let nodes = 0, bytes = 0;
  const charge = (count: number) => { bytes += count; if (bytes > JOB_JOURNAL_BYTES) fail(); };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 16) fail();
    if (value === null || typeof value === 'boolean') { charge(JSON.stringify(value).length); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); charge(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (typeof value === 'string') {
      if (value.length > JOB_JOURNAL_BYTES || Buffer.from(value).toString('utf8') !== value) fail();
      charge(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value)) fail();
    const array = Array.isArray(value), proto: unknown = Object.getPrototypeOf(value);
    if ((array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    charge(2); let entries = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      if (entries) charge(1);
      if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      out[key] = copy(descriptor.value, depth + 1); entries++;
    }
    if (!array) return out;
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) ||
        length.value !== entries || Object.keys(out).some(key => !/^(0|[1-9][0-9]*)(?![\s\S])/.test(key) || Number(key) >= length.value)) fail();
    return Array.from({ length: length.value as number }, (_, at) => out[String(at)]);
  }
  return ownRecord(copy(input, 0));
}

/** Explicit legacy absence is distinct from a malformed present descriptor.
 * Raw readers must first use the bounded duplicate-key-safe JSON decoder. */
export function parseConvertedGlbJobMetadata(value: unknown): ConvertedGlbJobMetadata {
  try {
    const journal = journalSnapshot(value);
    if (journal.schemaVersion !== 1 || journal.kind !== 'converted-glb' ||
        !['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].some(state => state === journal.state) ||
        !Object.hasOwn(journal, 'request')) fail();
    const jobId = uuid(journal.jobId);
    const creation = Object.hasOwn(journal, 'creation') ? parseConvertedGlbCreation(journal.creation) : null;
    const request = journal.request === null ? null : parseConvertedGlbRequest(journal.request);
    if ((creation && creation.jobId !== jobId) || (request && request.jobId !== jobId) || (journal.state === 'succeeded' && !request)) fail();
    if (request) name(request.name);
    if (creation && request && (creation.parentJobId !== request.parentJobId || creation.parentManifestSha256 !== request.parentManifestSha256 ||
        creation.name !== request.name || creation.collision !== request.collision || creation.renderResolution !== request.renderResolution ||
        creation.renderSamples !== request.renderSamples)) fail();
    const display = creation?.name ?? request?.name ?? null;
    if (Object.hasOwn(journal, 'name') && (name(journal.name) !== display && display !== null)) fail();
    if (creation) return request
      ? Object.freeze({ form: 'new-prepared', jobId, name: creation.name, creation, request })
      : Object.freeze({ form: 'new-pending', jobId, name: creation.name, creation, request: null });
    return request ? Object.freeze({ form: 'legacy-prepared', jobId, name: request.name, creation: null, request })
      : Object.freeze({ form: 'legacy-pending', jobId, name: null, creation: null, request: null });
  } catch { fail(); }
}
