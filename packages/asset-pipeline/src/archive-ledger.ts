import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { assetName } from './paths.js';
import { JOB_JOURNAL_BYTES } from './recipe.js';
import { parseWorkerRecords } from './worker-journal.js';
import { RESOLUTION_RECORD_BYTES, validateResolution } from './worker-resolution.js';

/** Logical archive classification for asset jobs (pure core; no filesystem writes).
 * Files never move and each job's journal stays its only state authority. The ledger classifies jobs the host
 * checked as archivable; restore and lookup re-validate. Persistence belongs to the service via atomicAssetJson.
 *
 * Two separate properties:
 * - Drift detection: digests and stat fingerprints notice host races, crashes and accidental changes.
 * - Authorization: NOT provided. A same-user writer able to forge the ledger, journal, marker and file metadata
 *   together may evade detection; digests do not authenticate that writer. */
export const LEDGER_FILE = 'archive-ledger.json';
export const LEDGER_MAX_ENTRIES = 4096;
/** Measured worst case for 4096 entries (48-char names, 25-digit fingerprints, marker digests): 2,740,286 B. */
export const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
export const ACTIVE_LIMIT = 256;
export type ArchivedState = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type ArchivedTemplate = 'hero-prop' | 'environment-kit' | 'custom-assembly' | 'adopted-glb';
/** Bounded canonical decimal strings from a bigint stat. dev/ino may be 0 on some filesystems. */
export interface Fingerprint { readonly dev: string; readonly ino: string; readonly size: string; readonly mtimeNs: string; readonly ctimeNs: string }
export interface LedgerEntry {
  readonly jobId: string; readonly name: string; readonly template: ArchivedTemplate; readonly state: ArchivedState;
  /** True only when the host had already verified the manifest for a succeeded job; never inferred from state. */
  readonly manifestAvailable: boolean;
  readonly startedAt: string | null; readonly finishedAt: string | null; readonly archivedAt: string;
  readonly journalSha256: string; readonly journal: Fingerprint; readonly resolutionMarkerSha256: string | null;
}
export interface Ledger { readonly schemaVersion: 1; readonly kind: 'arcane-asset-archive'; readonly entries: readonly LedgerEntry[] }
export type LedgerParse = { readonly ok: true; readonly ledger: Ledger } | { readonly ok: false; readonly reason: 'oversized' | 'malformed' | 'invalid-entry' | 'duplicate' | 'too-many' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const SHA = /^[a-f0-9]{64}(?![\s\S])/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,24})(?![\s\S])/;
const STATES: readonly string[] = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const TEMPLATES: readonly string[] = ['hero-prop', 'environment-kit', 'custom-assembly', 'adopted-glb'];
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Date.prototype.toISOString form only, and a real instant. */
export const isoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
/** The asset pipeline's own slug rule (lowercase, ≤48 chars, no device names). Repeated names across different
 * UUIDs are legitimate; directory identity is `<name>-<jobId>`, unique by jobId. */
const safeName = (value: unknown): value is string => { try { assetName(value); return typeof value==='string'&&/^[a-z][a-z0-9-]{0,47}(?![\s\S])/.test(value); } catch { return false; } };

function dataObject(value: unknown, keys: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let d: Record<string, PropertyDescriptor>;
  try { d = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.keys(d).sort().join(',') !== keys || Object.values(d).some(x => !('value' in x))) return null;
  return Object.fromEntries(Object.entries(d).map(([k, x]) => [k, x.value]));
}
function parseFingerprint(value: unknown): Fingerprint | null {
  const v = dataObject(value, 'ctimeNs,dev,ino,mtimeNs,size');
  if (!v || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => typeof v[k] === 'string' && DECIMAL.test(v[k] as string))) return null;
  return Object.freeze({ dev: v.dev as string, ino: v.ino as string, size: v.size as string, mtimeNs: v.mtimeNs as string, ctimeNs: v.ctimeNs as string });
}
/** Strict, data-property-only, frozen copy of one entry. */
export function parseLedgerEntry(value: unknown): LedgerEntry | null {
  const v = dataObject(value, 'archivedAt,finishedAt,jobId,journal,journalSha256,manifestAvailable,name,resolutionMarkerSha256,startedAt,state,template');
  if (!v) return null;
  const journal = parseFingerprint(v.journal);
  if (typeof v.jobId !== 'string' || !UUID.test(v.jobId) || !safeName(v.name) ||
      !TEMPLATES.includes(v.template as string) || !STATES.includes(v.state as string) || typeof v.manifestAvailable !== 'boolean' ||
      !(v.startedAt === null || isoTimestamp(v.startedAt)) || !(v.finishedAt === null || isoTimestamp(v.finishedAt)) || !isoTimestamp(v.archivedAt) ||
      typeof v.journalSha256 !== 'string' || !SHA.test(v.journalSha256) || !journal ||
      !(v.resolutionMarkerSha256 === null || (typeof v.resolutionMarkerSha256 === 'string' && SHA.test(v.resolutionMarkerSha256)))) return null;
  // Interrupted entries exist only with the exact resolution-marker digest; only succeeded may claim a manifest.
  if ((v.state === 'interrupted') !== (v.resolutionMarkerSha256 !== null) || (v.manifestAvailable && v.state !== 'succeeded')) return null;
  if (v.template === 'adopted-glb' && v.state === 'interrupted') return null; // Adopted jobs start no worker.
  return Object.freeze({ jobId: v.jobId, name: v.name as string, template: v.template as ArchivedTemplate, state: v.state as ArchivedState,
    manifestAvailable: v.manifestAvailable, startedAt: v.startedAt as string | null, finishedAt: v.finishedAt as string | null, archivedAt: v.archivedAt as string,
    journalSha256: v.journalSha256, journal, resolutionMarkerSha256: v.resolutionMarkerSha256 as string | null });
}
function freezeLedger(entries: readonly unknown[]): LedgerParse {
  if (entries.length > LEDGER_MAX_ENTRIES) return { ok: false, reason: 'too-many' };
  const parsed: LedgerEntry[] = [], ids = new Set<string>();
  for (const raw of entries) {
    const entry = parseLedgerEntry(raw);
    if (!entry) return { ok: false, reason: 'invalid-entry' };
    if (ids.has(entry.jobId)) return { ok: false, reason: 'duplicate' };
    ids.add(entry.jobId); parsed.push(entry);
  }
  return { ok: true, ledger: Object.freeze({ schemaVersion: 1, kind: 'arcane-asset-archive', entries: Object.freeze(parsed) }) };
}
/** Strict, frozen, bounded parse of stored bytes. Any invalid entry invalidates the whole ledger. */
export function parseLedger(bytes: Uint8Array): LedgerParse {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'malformed' };
  if (bytes.byteLength > LEDGER_MAX_BYTES) return { ok: false, reason: 'oversized' };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return { ok: false, reason: 'malformed' }; }
  const v = dataObject(value, 'entries,kind,schemaVersion');
  if (!v || v.schemaVersion !== 1 || v.kind !== 'arcane-asset-archive' || !Array.isArray(v.entries)) return { ok: false, reason: 'malformed' };
  return freezeLedger(v.entries);
}
/** Validated, frozen copy of an in-memory ledger value (accepts caller-owned objects; never retains them). */
export function copyLedger(value: unknown): Ledger {
  const v = dataObject(value, 'entries,kind,schemaVersion');
  if (!v || v.schemaVersion !== 1 || v.kind !== 'arcane-asset-archive' || !Array.isArray(v.entries)) throw new Error('Invalid archive ledger.');
  const result = freezeLedger(v.entries);
  if (!result.ok) throw new Error('Invalid archive ledger: ' + result.reason);
  return result.ledger;
}
/** Canonical bytes for the service's atomicAssetJson write; re-validated and bounded. */
export function serializeLedger(value: unknown): string {
  const text = JSON.stringify(copyLedger(value)) + '\n';
  if (Buffer.byteLength(text) > LEDGER_MAX_BYTES) throw new Error('Archive ledger exceeds its byte bound.');
  return text;
}

export const fingerprintOf = (stat: BigIntStats): Fingerprint => {
  const fp = parseFingerprint({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
  if (!fp) throw new Error('Unsupported file metadata for a fingerprint.');
  return fp;
};
export const sameFingerprint = (a: Fingerprint, b: Fingerprint) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Host-only leases, latches and verified facts (never caller or model input). */
export interface ArchiveHostFacts {
  readonly active: boolean; readonly readPinned: boolean; readonly importCaptured: boolean;
  readonly preparationRecord: boolean; readonly pendingStage: boolean; readonly uncertainLatch: boolean;
  /** The service already verified this succeeded job's manifest (e.g. its active record's manifestAvailable). */
  readonly manifestVerified: boolean;
}
export type EligibilityRefusal = 'journal-oversized' | 'journal-malformed' | 'job-mismatch' | 'name-mismatch' | 'unsupported-template' | 'running'
  | 'workers-invalid' | 'workers-unresolved' | 'interrupted-unresolved' | 'resolution-invalid' | 'unexpected-marker' | 'uncertain-latch' | 'leased' | 'marker-oversized';
export type Eligibility = { readonly eligible: true; readonly entry: Omit<LedgerEntry, 'journal' | 'archivedAt'> } | { readonly eligible: false; readonly reason: EligibilityRefusal };

/** Decide from the exact journal (and optional marker) BYTES whether a job may be classified archived.
 * Proves a safe classification only: never that artifacts exist or validate. */
export function assessEligibility(input: { jobId: string; name: string; journal: Uint8Array; marker: Uint8Array | null; facts: ArchiveHostFacts }): Eligibility {
  const refuse = (reason: EligibilityRefusal): Eligibility => ({ eligible: false, reason });
  const f = input.facts;
  if (f.active || f.readPinned || f.importCaptured || f.preparationRecord || f.pendingStage) return refuse('leased');
  if (f.uncertainLatch) return refuse('uncertain-latch');
  if (!(input.journal instanceof Uint8Array) || input.journal.byteLength > JOB_JOURNAL_BYTES) return refuse('journal-oversized');
  if (input.marker !== null && (!(input.marker instanceof Uint8Array) || input.marker.byteLength > RESOLUTION_RECORD_BYTES)) return refuse('marker-oversized');
  const journalBytes = Buffer.from(input.journal), markerBytes = input.marker === null ? null : Buffer.from(input.marker);
  let journal: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(journalBytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('journal-malformed');
    journal = value as Record<string, unknown>;
  } catch { return refuse('journal-malformed'); }
  if (journal.schemaVersion !== 1 || typeof journal.jobId !== 'string' || !UUID.test(journal.jobId)) return refuse('journal-malformed');
  if (journal.jobId !== input.jobId) return refuse('job-mismatch');
  const request = journal.request && typeof journal.request === 'object' && !Array.isArray(journal.request) ? journal.request as Record<string, unknown> : null;
  if (!request || !safeName(input.name) || request.name !== input.name) return refuse('name-mismatch');
  if (!TEMPLATES.includes(request.template as string)) return refuse('unsupported-template');
  const state = journal.state;
  if (state === 'running') return refuse('running');
  if (!STATES.includes(state as string)) return refuse('journal-malformed');
  if (Object.hasOwn(journal, 'workers')) {
    const records = parseWorkerRecords(journal.workers);
    if (!records) return refuse('workers-invalid');
    if (state !== 'interrupted' && records.some(r => r.state !== 'closed')) return refuse('workers-unresolved');
  }
  let markerSha: string | null = null;
  if (state === 'interrupted') {
    if (request.template === 'adopted-glb' || markerBytes === null) return refuse('interrupted-unresolved');
    if (!validateResolution({ jobId: input.jobId, journal: journalBytes, record: markerBytes }).valid) return refuse('resolution-invalid');
    markerSha = sha256(markerBytes);
  } else if (markerBytes !== null) return refuse('unexpected-marker');
  const time = (value: unknown) => isoTimestamp(value) ? value : null;
  return { eligible: true, entry: Object.freeze({ jobId: input.jobId, name: input.name, template: request.template as ArchivedTemplate, state: state as ArchivedState,
    manifestAvailable: state === 'succeeded' && f.manifestVerified === true, startedAt: time(journal.startedAt), finishedAt: time(journal.finishedAt),
    journalSha256: sha256(journalBytes), resolutionMarkerSha256: markerSha }) };
}

/** Startup checkpoint per archived entry: stat only. A fast drift check, not exit evidence or authentication. */
export type Checkpoint = 'archived' | 'needs-validation' | 'missing';
export const checkpoint = (entry: LedgerEntry, current: Fingerprint | null): Checkpoint =>
  current === null ? 'missing' : sameFingerprint(entry.journal, current) ? 'archived' : 'needs-validation';
/** Full validation on lookup/restore or after a fingerprint change. A conflict re-joins the fence. */
export type ArchivedStatus = 'archived' | 'changed' | 'conflict' | 'missing';
const NO_LEASES: ArchiveHostFacts = Object.freeze({ active: false, readPinned: false, importCaptured: false, preparationRecord: false, pendingStage: false, uncertainLatch: false, manifestVerified: false });
export function validateArchived(entryValue: unknown, journal: Uint8Array | null, marker: Uint8Array | null): ArchivedStatus {
  const entry = parseLedgerEntry(entryValue);
  if (!entry) throw new Error('Invalid archive ledger entry.');
  if (journal === null) return 'missing';
  // Bounds BEFORE hashing: an oversized or non-byte input cannot be validated, so it re-joins the fence.
  if (!(journal instanceof Uint8Array) || journal.byteLength > JOB_JOURNAL_BYTES) return 'conflict';
  if (marker !== null && (!(marker instanceof Uint8Array) || marker.byteLength > RESOLUTION_RECORD_BYTES)) return 'conflict';
  const again = assessEligibility({ jobId: entry.jobId, name: entry.name, journal, marker, facts: { ...NO_LEASES, manifestVerified: entry.manifestAvailable } });
  if (!again.eligible) return 'conflict';
  const exact = again.entry.journalSha256 === entry.journalSha256 && again.entry.resolutionMarkerSha256 === entry.resolutionMarkerSha256 &&
    again.entry.state === entry.state && again.entry.template === entry.template;
  return exact ? 'archived' : 'changed';
}

const validCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
/** One ledger value for an atomic archive batch. Inputs are validated into frozen copies. */
export function archiveBatch(ledgerValue: unknown, additionValues: readonly unknown[], activeCount: number): Ledger {
  const ledger = copyLedger(ledgerValue);
  if (!Array.isArray(additionValues) || !additionValues.length) throw new Error('Archive batch needs at least one entry.');
  if (!validCount(activeCount, ACTIVE_LIMIT) || additionValues.length > activeCount) throw new Error('Invalid active job count.');
  const additions = additionValues.map(value => { const entry = parseLedgerEntry(value); if (!entry) throw new Error('Invalid archive entry.'); return entry; });
  const ids = new Set(ledger.entries.map(e => e.jobId));
  if (additions.some(e => ids.has(e.jobId)) || new Set(additions.map(e => e.jobId)).size !== additions.length) throw new Error('Duplicate archive entry.');
  if (ledger.entries.length + additions.length > LEDGER_MAX_ENTRIES) throw new Error('Archive ledger is full.');
  return copyLedger({ schemaVersion: 1, kind: 'arcane-asset-archive', entries: [...ledger.entries, ...additions] });
}
export type RestorePlan = { readonly ok: true; readonly ledger: Ledger; readonly swappedOut: string | null; readonly activeAfter: number }
  | { readonly ok: false; readonly reason: 'not-archived' | 'capacity' };
/** Restore one job. At full active capacity the given eligible active job is swapped out in the SAME ledger.
 * Never more than 256 active or 4096 archived, and never a duplicated identity. */
export function planRestore(ledgerValue: unknown, jobId: string, activeCount: number, swapValue: unknown | null): RestorePlan {
  const ledger = copyLedger(ledgerValue);
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new Error('Invalid job id.');
  if (!validCount(activeCount, ACTIVE_LIMIT)) throw new Error('Invalid active job count.');
  if (!ledger.entries.some(e => e.jobId === jobId)) return { ok: false, reason: 'not-archived' };
  const remaining = ledger.entries.filter(e => e.jobId !== jobId);
  if (activeCount < ACTIVE_LIMIT) return { ok: true, ledger: copyLedger({ schemaVersion: 1, kind: 'arcane-asset-archive', entries: remaining }), swappedOut: null, activeAfter: activeCount + 1 };
  const swap = swapValue === null ? null : parseLedgerEntry(swapValue);
  if (!swap || swap.jobId === jobId || remaining.some(e => e.jobId === swap.jobId)) return { ok: false, reason: 'capacity' };
  return { ok: true, ledger: copyLedger({ schemaVersion: 1, kind: 'arcane-asset-archive', entries: [...remaining, swap] }), swappedOut: swap.jobId, activeAfter: ACTIVE_LIMIT };
}
