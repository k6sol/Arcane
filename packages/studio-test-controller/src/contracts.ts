import { createHash } from 'node:crypto';
import { z } from 'zod';

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const bindingSchema = z.strictObject({
  nativeStudioId: identifier, pairedSessionId: identifier, clientLifetimeId: identifier,
  pluginArtifactHash: fingerprint, scopeRevision: fingerprint, placeId: z.literal(0),
});
export type TestBinding = Readonly<z.infer<typeof bindingSchema>>;
export const proposalSchema = z.strictObject({
  binding: bindingSchema, durationMs: z.number().int().min(100).max(60_000),
  observationIntervalMs: z.number().int().min(25).max(2_000), failOnRuntimeError: z.boolean(),
});
export type TestProposal = Readonly<z.infer<typeof proposalSchema>>;
export const proofSchema = z.strictObject({
  binding: bindingSchema, observedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  connected: z.boolean(), revoked: z.boolean(), protectedPlace: z.boolean(), testActionsAllowed: z.boolean(),
  playEpoch: z.number().int().nonnegative().safe(), continuitySupported: z.boolean(),
});
export type PairedTestProof = z.infer<typeof proofSchema>;
/** A trusted host port: authenticate the paired plugin, corroborate its exact native
 * mapping, and classify protected places. Request JSON must never implement this port. */
export interface PairedProofReader { read(binding: TestBinding, signal: AbortSignal): Promise<unknown> }
export const nativeStateSchema = z.strictObject({
  nativeStudioId: identifier, placeId: z.literal(0), mode: z.enum(['Edit', 'Play']),
  datamodels: z.array(z.enum(['Edit', 'Client', 'Server'])).min(1).max(3),
});
export type NativeTestState = z.infer<typeof nativeStateSchema>;
export const logSchema = z.strictObject({
  id: identifier, level: z.enum(['info', 'warning', 'error']), message: z.string().max(2048),
});
export const logsSchema = z.strictObject({ entries: z.array(logSchema).max(128), truncated: z.boolean() });
export const logSummarySchema = z.strictObject({ idDigest: fingerprint, digest: fingerprint,
  level: z.enum(['info', 'warning', 'error']), bytes: z.number().int().min(0).max(8192) });
export type LogSummary = Readonly<z.infer<typeof logSummarySchema>>;
export const observationSchema = z.strictObject({
  binding: bindingSchema, mode: z.enum(['Edit', 'Play']), playEpoch: z.number().int().nonnegative().safe(),
  observedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  logs: z.array(logSummarySchema).max(128), logsTruncated: z.boolean(),
});
export type TestObservation = Readonly<z.infer<typeof observationSchema>>;
export interface TestAdapter {
  readonly evidence: 'fixture' | 'native';
  observe(binding: TestBinding, signal: AbortSignal, cleanup?: boolean): Promise<TestObservation>;
  start(binding: TestBinding, runId: string, deadline: number, signal: AbortSignal): Promise<void>;
  stop(binding: TestBinding, runId: string, deadline: number, signal: AbortSignal): Promise<void>;
  settle(signal: AbortSignal): Promise<boolean>;
}
export const codes = ['OK', 'INVALID_REQUEST', 'BUSY', 'HUMAN_AUTH_REQUIRED', 'CONSENT_EXPIRED',
  'BINDING_CHANGED', 'STALE_PROOF', 'PLACE_DENIED', 'MODE_MISMATCH', 'NOT_OWNED_PLAY',
  'UNSUPPORTED_TOOL', 'BAD_NATIVE_RESPONSE', 'TIMEOUT', 'CANCELLED', 'DURATION_EXPIRED',
  'DISCONNECTED', 'SHUTDOWN', 'EFFECT_UNKNOWN', 'RUNTIME_ERROR', 'JOURNAL_FAILED', 'FENCED'] as const;
export type TestCode = typeof codes[number];
export class StudioTestError extends Error {
  readonly code: TestCode;
  constructor(code: TestCode) { super(code); this.name = 'StudioTestError'; this.code = code; }
}
export function fail(code: TestCode): never { throw new StudioTestError(code); }
export function codeOf(error: unknown): TestCode { return error instanceof StudioTestError ? error.code : 'BAD_NATIVE_RESPONSE'; }
export function parse<T>(schema: z.ZodType<T>, value: unknown, code: TestCode = 'INVALID_REQUEST'): T {
  const result = schema.safeParse(value); if (!result.success) fail(code); return result.data;
}
export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function sameBinding(a: TestBinding, b: TestBinding, cleanup = false): boolean {
  return digest(cleanup ? { ...a, scopeRevision: 'cleanup' } : a) === digest(cleanup ? { ...b, scopeRevision: 'cleanup' } : b);
}
export interface Scheduler {
  now(): number;
  schedule(ms: number, callback: () => void): () => void;
}
export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  schedule(ms, callback) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};
export function bounded<T>(scheduler: Scheduler, limitMs: number, signal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new StudioTestError('CANCELLED'));
  if (limitMs <= 0) return Promise.reject(new StudioTestError('TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const local = new AbortController();
    const finish = (error: unknown, value?: T) => {
      if (finished) return; finished = true; cancelTimer(); signal.removeEventListener('abort', abort);
      if (error) { reject(error); local.abort(); } else resolve(value as T);
    };
    let finished = false;
    const abort = () => finish(new StudioTestError('CANCELLED'));
    const cancelTimer = scheduler.schedule(limitMs, () => finish(new StudioTestError('TIMEOUT')));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (finished) fail('CANCELLED'); return action(local.signal); }).then(value => finish(null, value), error => finish(error));
  });
}
export function delay(scheduler: Scheduler, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new StudioTestError('CANCELLED')); return; }
    const abort = () => { cancel(); signal.removeEventListener('abort', abort); reject(new StudioTestError('CANCELLED')); };
    const cancel = scheduler.schedule(ms, () => { signal.removeEventListener('abort', abort); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}
