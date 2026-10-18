import { z } from 'zod';
import { ROOTS, READ_METHODS, WRITE_METHODS, jsonObject } from '../../../packages/protocol/src/studio.js';
import { MATERIALS, SAFE_CREATE_CLASSES, SHAPES } from '../../../packages/core/src/studio-policy.js';

export function boundedText(max: number) {
  return z.string().min(1).max(max).refine(value => !value.includes('\0'), 'NUL is not allowed.');
}
export const id = boundedText(256);
export const root = z.enum(ROOTS);
export const ref = z.strictObject({
  instanceId: id, sessionId: id, root,
  pathSegments: z.array(z.string().max(256)).max(64), className: id,
}).describe('Opaque ref returned by this session, passed back unchanged; never invent one.');
export const timeoutMs = z.number().int().min(100).max(60_000).default(30_000)
  .describe('Wait limit (ms); expiry does not cancel or undo the command.');
export const target = { sessionId: id, timeoutMs };
export const source = z.string().max(100 * 1024).refine(value => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 100 * 1024,
  'Source must be NUL-free and at most 100 KiB UTF-8.');
const channel = z.number().min(-100000).max(100000);
const vector = z.strictObject({ type: z.literal('Vector3'), value: z.tuple([channel, channel, channel]) });
const degrees = z.number().min(-360).max(360);
const orientation = z.strictObject({ type: z.literal('Vector3'), value: z.tuple([degrees, degrees, degrees]) });
const color = z.strictObject({ type: z.literal('Color3'), value: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]) });
// Share daemon allowlists; the plugin still rechecks native class and edit state.
export const properties = z.strictObject({
  Name: id.max(100).optional(),
  Size: vector.refine(value => value.value.every(channel => channel >= 0.05 && channel <= 2048), 'Size channels must be 0.05–2048 studs.').optional(),
  Position: vector.optional(), Orientation: orientation.optional(), Color: color.optional(), Anchored: z.boolean().optional(), CanCollide: z.boolean().optional(), CastShadow: z.boolean().optional(),
  Transparency: z.number().min(0).max(1).optional(), Reflectance: z.number().min(0).max(1).optional(), Material: z.enum(MATERIALS).optional(), Shape: z.enum(SHAPES).optional(),
});
export const createClass = z.enum(SAFE_CREATE_CLASSES);
export const commandState = z.enum(['queued', 'dispatched', 'succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
const boundedArgs = z.record(z.string(), z.json()).superRefine((value, context) => {
  try { jsonObject(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid or oversized command arguments.' }); }
});
export const command = z.object({
  protocolVersion: z.literal(1), id, requestId: id, sessionId: id, clientSessionId: id,
  method: z.enum([...READ_METHODS, ...WRITE_METHODS]), args: boundedArgs,
  allowedRoots: z.array(root).max(ROOTS.length), allowWrites: z.boolean(), leaseEpoch: z.number().int().nonnegative(),
  expiresAt: id, state: commandState, createdAt: id, finishedAt: id.nullable(),
  result: z.json().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024, 'Result exceeds 512 KiB.').nullable(),
  error: z.string().max(8192).nullable(),
});
export const session = z.object({
  id, protocolVersion: z.literal(1), clientSessionId: id, placeId: z.number().int().nonnegative(),
  universeId: z.number().int().nonnegative(), name: id, pluginVersion: id,
  allowedRoots: z.array(root).max(ROOTS.length), allowWrites: z.boolean(), capabilities: z.array(id).max(100),
  connectedAt: id, lastSeenAt: id, revokedAt: id.nullable(), live: z.boolean().optional(),
});
