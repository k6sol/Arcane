import { createHash } from 'node:crypto';
import { JOB_JOURNAL_BYTES } from './recipe.js';
import { attestRecordedWorker, canonicalTimestamp, defaultProcessQueryHost, WORKER_ROLES,
  type Attestation, type AttestationReason, type ProcessQueryHost, type WorkerRole } from './worker-identity.js';
import { journalTimestamp, parseWorkerRecords, type WorkerRecord } from './worker-journal.js';

/** Resolution evidence core for one interrupted asset job (no filesystem writes, no admission state).
 * Evidence exists only when every exact recorded worker of the job was observed closed by its supervisor
 * or is proven gone by an exact PID + creation-time comparison. It is never success, acceptance, import,
 * publication or replay; the job stays `interrupted`. Digests bind a record to the exact journal bytes it
 * assessed (freshness/integrity); they do not authenticate the writer. A same-user process able to write
 * the job directory could forge both files; this is trusted local host state, never model-supplied input. */
export const RESOLUTION_RECORD_BYTES = 8 * 1024;
export const MAX_CONCURRENT_QUERIES = 2;
export type ResolutionEvidence = 'closed-exit-observed' | 'closed-not-started' | 'pid-absent' | 'pid-reused';
export interface ResolutionBasis { readonly reservationId: string; readonly role: WorkerRole; readonly evidence: ResolutionEvidence }
export interface WorkerResolutionRecord {
  readonly schemaVersion: 1;
  readonly kind: 'arcane-worker-resolution';
  readonly jobId: string;
  readonly journalSha256: string;
  readonly workersSha256: string;
  readonly assessedAt: string;
  readonly basis: readonly ResolutionBasis[];
  readonly authority: 'human-control';
}
/** Fixed, privacy-safe refusal codes (no PIDs, paths, exception text or query output). */
export type ResolutionReason = AttestationReason
  | 'journal-oversized' | 'journal-malformed' | 'job-mismatch' | 'not-interrupted'
  | 'no-workers-recorded' | 'records-invalid' | 'reservation-unresolved' | 'same-worker-running' | 'cancelled';
export type ResolutionAssessment =
  | { readonly status: 'resolvable'; readonly record: WorkerResolutionRecord }
  | { readonly status: 'refused'; readonly reason: ResolutionReason };
export type ResolutionValidity =
  | { readonly valid: true; readonly record: WorkerResolutionRecord }
  | { readonly valid: false; readonly reason: 'record-oversized' | 'record-malformed' | 'resolution-stale' | 'resolution-mismatch' | ResolutionReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason: ResolutionReason): ResolutionAssessment => Object.freeze({ status: 'refused', reason });

/** Deterministic JSON: object keys sorted at every depth; arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
export const workersDigest = (records: readonly WorkerRecord[]) => sha256(canonicalJson(records));

type ParsedJournal = { journalSha256: string; records: readonly WorkerRecord[] };
/** Strict parse of the exact job.json bytes for one expected job; copies the bytes before anything else. */
export function parseInterruptedJournal(jobId: string, journal: Uint8Array): ParsedJournal | ResolutionReason {
  if (!(journal instanceof Uint8Array)) return 'journal-malformed';
  if (journal.byteLength > JOB_JOURNAL_BYTES) return 'journal-oversized';
  const bytes = Buffer.from(journal); // Immutable private copy.
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return 'journal-malformed'; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'journal-malformed';
  const journalRecord = value as Record<string, unknown>;
  if (journalRecord.schemaVersion !== 1 || typeof journalRecord.jobId !== 'string' || !UUID.test(journalRecord.jobId)) return 'journal-malformed';
  if (!UUID.test(jobId) || journalRecord.jobId !== jobId) return 'job-mismatch';
  if (journalRecord.state !== 'interrupted') return 'not-interrupted';
  if (!Object.hasOwn(journalRecord, 'workers')) return 'no-workers-recorded';
  const records = parseWorkerRecords(journalRecord.workers);
  if (!records) return 'records-invalid';
  if (!records.length) return 'no-workers-recorded';
  if (records.some(r => r.state === 'reserved')) return 'reservation-unresolved';
  return { journalSha256: sha256(bytes), records };
}

const closedEvidence = (r: WorkerRecord): ResolutionEvidence | null =>
  r.state === 'closed' ? (r.closure === 'exit-observed' ? 'closed-exit-observed' : 'closed-not-started') : null;

/** Read-only assessment from exact journal bytes. At most MAX_CONCURRENT_QUERIES fixed-PID queries run at
 * once (≤6 records). After an abort, an unknown result or a live worker no further query is scheduled;
 * already-owned queries are awaited. An abort never yields evidence. Nothing is written. */
export async function assessJobForResolution(input: { jobId: string; journal: Uint8Array; host?: ProcessQueryHost; signal?: AbortSignal; now?: () => string }): Promise<ResolutionAssessment> {
  const signal = input.signal, host = input.host ?? defaultProcessQueryHost;
  if (signal?.aborted) return refused('cancelled');
  const parsed = parseInterruptedJournal(input.jobId, input.journal);
  if (typeof parsed === 'string') return refused(parsed);
  const { records, journalSha256 } = parsed, jobId = input.jobId;
  const results = new Map<string, Attestation>();
  const pending = records.filter(r => r.state === 'captured') as Extract<WorkerRecord, { state: 'captured' }>[];
  const inflight = new Set<Promise<void>>();
  let halted = false;
  const schedule = () => {
    while (!halted && !signal?.aborted && inflight.size < MAX_CONCURRENT_QUERIES && pending.length) {
      const record = pending.shift()!;
      const owned: Promise<void> = attestRecordedWorker(record.identity, host)
        .catch((): Attestation => ({ verdict: 'unknown', reason: 'query-failed' }))
        .then(result => { results.set(record.reservationId, result); if (result.verdict !== 'recorded-worker-gone') halted = true; })
        .finally(() => { inflight.delete(owned); schedule(); });
      inflight.add(owned);
    }
  };
  schedule();
  while (inflight.size) await Promise.race(inflight);
  if (signal?.aborted) return refused('cancelled');
  const live = [...results.values()].find(r => r.verdict === 'same-worker-running');
  if (live) return refused('same-worker-running');
  for (const record of records) {
    const result = results.get(record.reservationId);
    if (result && result.verdict === 'unknown') return refused(result.reason);
  }
  const basis: ResolutionBasis[] = [];
  for (const record of records) {
    const closed = closedEvidence(record);
    if (closed) { basis.push(Object.freeze({ reservationId: record.reservationId, role: record.role, evidence: closed })); continue; }
    const result = results.get(record.reservationId);
    if (!result || result.verdict !== 'recorded-worker-gone') return refused('query-failed'); // Never scheduled: no evidence.
    basis.push(Object.freeze({ reservationId: record.reservationId, role: record.role, evidence: result.reason === 'pid-reused' ? 'pid-reused' : 'pid-absent' }));
  }
  const assessedAt = (input.now ?? (() => journalTimestamp()))();
  if (signal?.aborted) return refused('cancelled');
  if (!canonicalTimestamp(assessedAt)) return refused('query-failed');
  return Object.freeze({ status: 'resolvable', record: Object.freeze({ schemaVersion: 1, kind: 'arcane-worker-resolution', jobId, journalSha256,
    workersSha256: workersDigest(records), assessedAt, basis: Object.freeze(basis), authority: 'human-control' }) as WorkerResolutionRecord });
}

/** Strict, data-property-only, frozen copy of a stored resolution record (shape only). */
export function parseResolutionRecord(value: unknown): WorkerResolutionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let d: Record<string, PropertyDescriptor>;
  try { d = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.keys(d).sort().join(',') !== 'assessedAt,authority,basis,jobId,journalSha256,kind,schemaVersion,workersSha256' ||
      Object.values(d).some(x => !('value' in x))) return null;
  const v = (key: string) => d[key]!.value;
  if (v('schemaVersion') !== 1 || v('kind') !== 'arcane-worker-resolution' || v('authority') !== 'human-control' ||
      typeof v('jobId') !== 'string' || !UUID.test(v('jobId')) || typeof v('journalSha256') !== 'string' || !SHA.test(v('journalSha256')) ||
      typeof v('workersSha256') !== 'string' || !SHA.test(v('workersSha256')) || !canonicalTimestamp(v('assessedAt'))) return null;
  const rawBasis = v('basis');
  if (!Array.isArray(rawBasis) || rawBasis.length < 1 || rawBasis.length > 6) return null;
  const basis: ResolutionBasis[] = [], ids = new Set<string>();
  for (const item of rawBasis) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const b = Object.getOwnPropertyDescriptors(item);
    if (Object.keys(b).sort().join(',') !== 'evidence,reservationId,role' || Object.values(b).some(x => !('value' in x))) return null;
    const reservationId = b.reservationId!.value, role = b.role!.value, evidence = b.evidence!.value;
    if (typeof reservationId !== 'string' || !UUID.test(reservationId) || ids.has(reservationId) || !(WORKER_ROLES as readonly unknown[]).includes(role) ||
        !['closed-exit-observed', 'closed-not-started', 'pid-absent', 'pid-reused'].includes(evidence)) return null;
    ids.add(reservationId); basis.push(Object.freeze({ reservationId, role, evidence }));
  }
  return Object.freeze({ schemaVersion: 1, kind: 'arcane-worker-resolution', jobId: v('jobId'), journalSha256: v('journalSha256'),
    workersSha256: v('workersSha256'), assessedAt: v('assessedAt'), basis: Object.freeze(basis), authority: 'human-control' });
}

/** Validate stored resolution bytes against the exact current journal bytes (no query, no write).
 * Any change to the journal, its workers, the job identity or a basis entry invalidates the record. */
export function validateResolution(input: { jobId: string; journal: Uint8Array; record: Uint8Array }): ResolutionValidity {
  if (!(input.record instanceof Uint8Array)) return { valid: false, reason: 'record-malformed' };
  if (input.record.byteLength > RESOLUTION_RECORD_BYTES) return { valid: false, reason: 'record-oversized' };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input.record))); } catch { return { valid: false, reason: 'record-malformed' }; }
  const record = parseResolutionRecord(value);
  if (!record) return { valid: false, reason: 'record-malformed' };
  const parsed = parseInterruptedJournal(input.jobId, input.journal);
  if (typeof parsed === 'string') return { valid: false, reason: parsed };
  if (record.jobId !== input.jobId) return { valid: false, reason: 'resolution-mismatch' };
  if (record.journalSha256 !== parsed.journalSha256 || record.workersSha256 !== workersDigest(parsed.records)) return { valid: false, reason: 'resolution-stale' };
  if (record.basis.length !== parsed.records.length) return { valid: false, reason: 'resolution-mismatch' };
  for (const [index, worker] of parsed.records.entries()) {
    const basis = record.basis[index]!;
    if (basis.reservationId !== worker.reservationId || basis.role !== worker.role) return { valid: false, reason: 'resolution-mismatch' };
    const closed = closedEvidence(worker);
    if (closed ? basis.evidence !== closed : worker.state !== 'captured' || (basis.evidence !== 'pid-absent' && basis.evidence !== 'pid-reused')) {
      return { valid: false, reason: 'resolution-mismatch' };
    }
  }
  return { valid: true, record };
}
