import {types} from 'node:util';
import {z} from 'zod';
import {ArcaneError} from '../../protocol/src/providers.js';

// Shared data-only wire gate. The route supplies job/project from its captured
// native actor and canonical binding; these strings do not establish authority.
// Neither parsing nor a sealed CPU receipt admits uploads, insertion or rights.
export const NATIVE_STUDIO_STAGING_RESPONSE_BYTES = 64 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const ENVELOPE_FIELDS = ['jobId', 'projectId', 'staged'] as const;
const RECEIPT_FIELDS = ['status', 'imported', 'runId', 'transferDigest', 'packetCount', 'byteLength',
  'state', 'engineVerification', 'commandIds'] as const;
const receipt = z.strictObject({
  status: z.literal('staged'), imported: z.literal(false), engineVerification: z.literal('pending'),
  runId: z.string().length(36).regex(UUID),
  state: z.literal('sealed'), transferDigest: z.string().length(64).regex(HASH),
  packetCount: z.number().int().min(1).max(512),
  byteLength: z.number().int().min(1).max(8 * 1024 * 1024),
  commandIds: z.array(z.string().length(36).regex(UUID)).min(1).max(512),
}).refine(value => value.commandIds.length === value.packetCount
  && new Set(value.commandIds).size === value.commandIds.length && value.byteLength >= value.packetCount,
  'Invalid sealed staging receipt accounting.');
const envelope = z.strictObject({jobId: z.string().length(36).regex(UUID),
  projectId: z.string().length(64).regex(HASH), staged: receipt});

function closedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length
    || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), copy: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    copy[field] = descriptor.value as unknown;
  }
  return copy;
}

function snapshot(value: unknown): unknown {
  const outer = closedRecord(value, ENVELOPE_FIELDS);
  if (!outer || typeof outer.jobId !== 'string' || outer.jobId.length !== 36
    || typeof outer.projectId !== 'string' || outer.projectId.length !== 64) return null;
  const inner = closedRecord(outer.staged, RECEIPT_FIELDS);
  if (!inner) return null;
  for (const field of RECEIPT_FIELDS) {
    const item = inner[field];
    if (field !== 'commandIds') {
      if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'string' && item.length > 64)) return null;
      continue;
    }
    if (types.isProxy(item) || !Array.isArray(item) || Object.getPrototypeOf(item) !== Array.prototype
      || item.length < 1 || item.length > 512) return null;
    const elements = Object.getOwnPropertyDescriptors(item), arrayKeys = Reflect.ownKeys(item);
    if (arrayKeys.length !== item.length + 1) return null;
    const commandIds: string[] = [];
    for (let index = 0; index < item.length; index++) {
      const element = elements[String(index)];
      if (!element || !Object.hasOwn(element, 'value') || !element.enumerable || typeof element.value !== 'string' || element.value.length !== 36) return null;
      commandIds.push(element.value);
    }
    inner.commandIds = commandIds;
  }
  const copy = {jobId: outer.jobId, projectId: outer.projectId, staged: inner};
  return Buffer.byteLength(JSON.stringify(copy)) <= NATIVE_STUDIO_STAGING_RESPONSE_BYTES ? copy : null;
}

export const nativeStudioStagingResponse = z.preprocess(snapshot, envelope);
export type NativeStudioStagingResponse = z.output<typeof nativeStudioStagingResponse>;

/** Verify and detach response evidence. expectedProjectId is an optional trusted
 * host expectation, never a caller tool argument or a grant of native authority. */
export function parseNativeStudioStagingResponse(value: unknown, expectedJobId: string, expectedProjectId?: string): NativeStudioStagingResponse {
  const parsed = nativeStudioStagingResponse.safeParse(value);
  if (!parsed.success || parsed.data.jobId !== expectedJobId
    || (expectedProjectId !== undefined && parsed.data.projectId !== expectedProjectId)) {
    throw new ArcaneError('STUDIO_STAGE_RESPONSE', 'Native staging response is invalid, changed or exceeds its bound.');
  }
  return parsed.data;
}
