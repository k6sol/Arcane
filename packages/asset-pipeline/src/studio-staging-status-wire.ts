import {types} from 'node:util';
import {z} from 'zod';
import {ArcaneError} from '../../protocol/src/providers.js';

/** Data evidence only. Scope hashes, queue states and CPU intake never grant
 * upload, insertion, rights or retry authority. Null stage means no retained run. */
export const NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES = 64 * 1024;
const uuid = z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const hash = z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/);
const receipt = z.strictObject({transferDigest: hash, packetCount: z.number().int().min(1).max(512),
  byteLength: z.number().int().min(1).max(8 * 1024 * 1024), state: z.enum(['receiving', 'sealed']),
  engineVerification: z.literal('pending')});
const command = z.strictObject({ordinal: z.number().int().min(0).max(511), commandId: uuid,
  state: z.enum(['queued', 'dispatched', 'succeeded', 'failed', 'cancelled', 'needs_reconciliation'])});
const stage = z.strictObject({runId: uuid, phase: z.enum(['running', 'cpu-staged', 'stopped', 'needs_reconciliation']),
  transferDigest: hash, plannedPacketCount: z.number().int().min(1).max(512),
  plannedEnvelopeBytes: z.number().int().min(1).max(8 * 1024 * 1024), commands: z.array(command).max(512),
  receipt: receipt.nullable(), receiptScope: z.literal('historical-cpu'), currentBuffers: z.literal('unobserved'),
  engineVerification: z.literal('pending'), imported: z.literal(false), retry: z.literal(false),
}).refine(value => {
  if (value.commands.some((c, i) => c.ordinal !== i)
    || new Set(value.commands.map(c => c.commandId)).size !== value.commands.length
    || value.commands.length > value.plannedPacketCount) return false;
  if (value.plannedEnvelopeBytes < value.plannedPacketCount) return false;
  const r = value.receipt;
  if (r && (r.transferDigest !== value.transferDigest || r.packetCount > value.commands.length
    || r.byteLength < r.packetCount || r.byteLength > value.plannedEnvelopeBytes
    || value.commands.slice(0, r.packetCount).some(c => c.state !== 'succeeded')
    || (r.state === 'sealed' && r.packetCount !== value.plannedPacketCount))) return false;
  return value.phase !== 'cpu-staged' || !!r && r.state === 'sealed'
    && value.commands.length === value.plannedPacketCount && value.commands.every(c => c.state === 'succeeded');
}, 'Contradictory staging status evidence.');
const envelope = z.strictObject({jobId: uuid, projectId: hash, stage: stage.nullable()});
const OUTER = ['jobId', 'projectId', 'stage'];
const STAGE = ['runId', 'phase', 'transferDigest', 'plannedPacketCount', 'plannedEnvelopeBytes',
  'commands', 'receipt', 'receiptScope', 'currentBuffers', 'engineVerification', 'imported', 'retry'];
const RECEIPT = ['transferDigest', 'packetCount', 'byteLength', 'state', 'engineVerification'];

function record(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if (proto !== Object.prototype && proto !== null || keys.length !== fields.length
    || keys.some(k => typeof k !== 'string' || !fields.includes(k))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = {};
  for (const field of fields) {
    const d = descriptors[field];
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return null;
    out[field] = d.value as unknown;
  }
  return out;
}
function scalars(value: Record<string, unknown>, excluded: readonly string[] = []): boolean {
  return Object.entries(value).every(([k, v]) => excluded.includes(k) || v === null
    || typeof v === 'string' && v.length <= 64 || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v));
}
function snapshot(value: unknown): unknown {
  const out = record(value, OUTER);
  if (!out || !scalars(out, ['stage'])) return null;
  if (out.stage !== null) {
    const s = record(out.stage, STAGE);
    if (!s || !scalars(s, ['commands', 'receipt'])) return null;
    const list = s.commands;
    if (types.isProxy(list) || !Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length > 512) return null;
    const descriptors = Object.getOwnPropertyDescriptors(list);
    if (Reflect.ownKeys(list).length !== list.length + 1) return null;
    const commands: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return null;
      const c = record(d.value, ['ordinal', 'commandId', 'state']);
      if (!c || !scalars(c)) return null;
      commands.push(c);
    }
    s.commands = commands;
    if (s.receipt !== null) {
      const r = record(s.receipt, RECEIPT);
      if (!r || !scalars(r)) return null;
      s.receipt = r;
    }
    out.stage = s;
  }
  return Buffer.byteLength(JSON.stringify(out)) <= NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES ? out : null;
}
export const nativeStudioStagingStatusResponse = z.preprocess(snapshot, envelope);
export type NativeStudioStagingStatusResponse = z.output<typeof nativeStudioStagingStatusResponse>;
/** Optional project expectation is trusted host scope, never a tool input. */
export function parseNativeStudioStagingStatusResponse(value: unknown, expectedJobId: string, expectedProjectId?: string): NativeStudioStagingStatusResponse {
  const parsed = nativeStudioStagingStatusResponse.safeParse(value);
  if (!parsed.success || parsed.data.jobId !== expectedJobId
    || expectedProjectId !== undefined && parsed.data.projectId !== expectedProjectId) {
    throw new ArcaneError('STUDIO_STAGE_STATUS_RESPONSE', 'Native staging status is invalid, changed or exceeds its bound.');
  }
  return parsed.data;
}
