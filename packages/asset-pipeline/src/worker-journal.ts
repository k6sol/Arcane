import { randomUUID } from 'node:crypto';
import { AssetError } from './types.js';
import { WORKER_ROLES, attestRecordedWorker, canonicalTimestamp, captureWorkerIdentity, defaultProcessQueryHost, parseWorkerIdentity,
  type AttestationReason, type ProcessQueryHost, type WorkerIdentity, type WorkerRole, type WorkerVerdict } from './worker-identity.js';

/** Per-job worker supervision journal (`workers` in job.json).
 * Every stage is RESERVED durably before its process is spawned. A reservation is resolved only by an
 * exact captured identity or by the supervisor observing its own child's close (or that it never started).
 * An unresolved reservation keeps the job unknown/fenced. Records are bounded and never evicted. */
export const MAX_WORKER_RECORDS = 6;
type Base = { readonly schemaVersion: 1; readonly role: WorkerRole; readonly reservationId: string; readonly reservedAt: string };
export type WorkerRecord =
  | (Base & { readonly state: 'reserved' })
  | (Base & { readonly state: 'captured'; readonly identity: WorkerIdentity })
  | (Base & { readonly state: 'closed'; readonly closure: 'exit-observed' | 'not-started'; readonly closedAt: string; readonly identity: WorkerIdentity | null });
export type JobReason = AttestationReason | 'reservation-unresolved' | 'records-invalid' | 'no-workers-recorded';
export interface JobAttestation { readonly verdict: WorkerVerdict; readonly reason: JobReason }

const RESERVATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keysOf = (value: object) => Object.keys(value).sort().join(',');
/** Seven-digit canonical UTC instant for journal timestamps. */
export const journalTimestamp = (date = new Date()) => date.toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');

function parseRecord(value: unknown): WorkerRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let d: Record<string, PropertyDescriptor>;
  try { d = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.values(d).some(x => !('value' in x))) return null;
  const v = (key: string) => d[key]?.value;
  const base = { schemaVersion: v('schemaVersion'), role: v('role'), reservationId: v('reservationId'), reservedAt: v('reservedAt') };
  if (base.schemaVersion !== 1 || !(WORKER_ROLES as readonly unknown[]).includes(base.role) || typeof base.reservationId !== 'string' ||
      !RESERVATION.test(base.reservationId) || !canonicalTimestamp(base.reservedAt)) return null;
  const state = v('state'), keys = keysOf(d);
  if (state === 'reserved' && keys === 'reservationId,reservedAt,role,schemaVersion,state') return Object.freeze({ ...base, state }) as WorkerRecord;
  if (state === 'captured' && keys === 'identity,reservationId,reservedAt,role,schemaVersion,state') {
    const identity = parseWorkerIdentity(v('identity'));
    return identity && identity.role === base.role ? Object.freeze({ ...base, state, identity }) as WorkerRecord : null;
  }
  if (state === 'closed' && keys === 'closedAt,closure,identity,reservationId,reservedAt,role,schemaVersion,state') {
    const closure = v('closure'), closedAt = v('closedAt'), raw = v('identity');
    const identity = raw === null ? null : parseWorkerIdentity(raw);
    if ((closure !== 'exit-observed' && closure !== 'not-started') || !canonicalTimestamp(closedAt) || (raw !== null && (!identity || identity.role !== base.role))) return null;
    if (closure === 'not-started' && identity !== null) return null;
    return Object.freeze({ ...base, state, closure, closedAt, identity }) as WorkerRecord;
  }
  return null;
}

/** Strict, frozen copy of a persisted journal. Any invalid record invalidates the whole list (fail closed). */
export function parseWorkerRecords(value: unknown): readonly WorkerRecord[] | null {
  if (!Array.isArray(value) || value.length > MAX_WORKER_RECORDS) return null;
  const records: WorkerRecord[] = [], ids = new Set<string>();
  for (const item of value) {
    const record = parseRecord(item);
    if (!record || ids.has(record.reservationId)) return null;
    ids.add(record.reservationId); records.push(record);
  }
  return Object.freeze(records);
}

const unresolved = (r: WorkerRecord) => r.state !== 'closed';
export function reserveWorker(records: readonly WorkerRecord[], role: WorkerRole, reservationId: string, reservedAt: string): readonly WorkerRecord[] {
  if (records.length >= MAX_WORKER_RECORDS) throw new AssetError('SUPERVISION_BOUND', 'Worker supervision record bound reached; no further worker was started.');
  if (records.some(r => r.role === role && unresolved(r))) throw new AssetError('SUPERVISION_STATE', 'An unresolved worker of this role already exists.');
  const next = parseWorkerRecords([...records, { schemaVersion: 1, role, reservationId, reservedAt, state: 'reserved' }]);
  if (!next) throw new AssetError('SUPERVISION_STATE', 'Invalid worker reservation.');
  return next;
}
function replace(records: readonly WorkerRecord[], reservationId: string, make: (r: WorkerRecord) => object): readonly WorkerRecord[] {
  const index = records.findIndex(r => r.reservationId === reservationId);
  if (index < 0) throw new AssetError('SUPERVISION_STATE', 'Unknown worker reservation.');
  const next = parseWorkerRecords(records.map((r, i) => i === index ? make(r) : r));
  if (!next) throw new AssetError('SUPERVISION_STATE', 'Invalid worker journal transition.');
  return next;
}
export function recordCaptured(records: readonly WorkerRecord[], reservationId: string, identity: WorkerIdentity): readonly WorkerRecord[] {
  return replace(records, reservationId, r => {
    if (r.state !== 'reserved' || identity.role !== r.role) throw new AssetError('SUPERVISION_STATE', 'Only a matching reservation can capture an identity.');
    return { schemaVersion: 1, role: r.role, reservationId: r.reservationId, reservedAt: r.reservedAt, state: 'captured', identity };
  });
}
export function recordClosed(records: readonly WorkerRecord[], reservationId: string, closure: 'exit-observed' | 'not-started', closedAt: string): readonly WorkerRecord[] {
  return replace(records, reservationId, r => {
    if (r.state === 'closed') throw new AssetError('SUPERVISION_STATE', 'Worker already closed.');
    if (closure === 'not-started' && r.state !== 'reserved') throw new AssetError('SUPERVISION_STATE', 'A captured worker started.');
    return { schemaVersion: 1, role: r.role, reservationId: r.reservationId, reservedAt: r.reservedAt, state: 'closed', closure, closedAt,
      identity: 'identity' in r ? r.identity : null };
  });
}

/** Job-level host evidence. `recorded-worker-gone` only when EVERY record is closed by the supervisor or
 * attests gone; any reservation, running worker, invalid journal or query fault keeps the job fenced. */
export async function attestJobWorkers(value: unknown, host: ProcessQueryHost = defaultProcessQueryHost): Promise<JobAttestation> {
  if (value === undefined || value === null) return { verdict: 'unknown', reason: 'no-workers-recorded' };
  const records = parseWorkerRecords(value); // Frozen copy before any await.
  if (!records) return { verdict: 'unknown', reason: 'records-invalid' };
  if (!records.length) return { verdict: 'unknown', reason: 'no-workers-recorded' };
  if (records.some(r => r.state === 'reserved')) return { verdict: 'unknown', reason: 'reservation-unresolved' };
  let unknownReason: JobReason | null = null;
  for (const record of records) {
    if (record.state !== 'captured') continue; // Closed by the supervisor (reserved was refused above).
    const result = await attestRecordedWorker(record.identity, host);
    if (result.verdict === 'same-worker-running') return result;
    if (result.verdict === 'unknown') unknownReason ??= result.reason;
  }
  return unknownReason ? { verdict: 'unknown', reason: unknownReason } : { verdict: 'recorded-worker-gone', reason: 'pid-absent' };
}

/** Runner-side hooks: `spawned` immediately after the process is created; `closed` only on the child's own
 * close event, before the runner settles. A runner must settle only after `closed` once a PID existed. */
export interface WorkerSupervisionHooks {
  spawned(info: { pid: number | undefined; exited(): boolean }): Promise<'continue' | 'stop'>;
  closed(): void;
}
export interface WorkerSupervisionOptions {
  persist(records: readonly WorkerRecord[]): Promise<void>;
  /** false: reservation/closure only (scratch probes); identity is never queried or recorded. */
  capture?: boolean;
  host?: ProcessQueryHost;
  now?: () => string;
  newId?: () => string;
}

/** Owns one job's journal. Records always describe what the supervisor actually did, and a failed or
 * uncertain persistence write blocks every later launch for the job. */
export class WorkerSupervision {
  #records: readonly WorkerRecord[];
  #broken = false;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #options: Required<Omit<WorkerSupervisionOptions, 'capture'>> & { capture: boolean };
  constructor(options: WorkerSupervisionOptions, initial: unknown = []) {
    const records = parseWorkerRecords(initial); // Validated, frozen copy; never the caller's array.
    if (!records) throw new AssetError('SUPERVISION_STATE', 'Worker supervision journal is invalid; no worker may start.');
    this.#records = records;
    this.#options = { capture: options.capture ?? true, host: options.host ?? defaultProcessQueryHost, now: options.now ?? (() => journalTimestamp()),
      newId: options.newId ?? randomUUID, persist: options.persist };
  }
  get records(): readonly WorkerRecord[] { return this.#records; }
  get broken(): boolean { return this.#broken; }
  /** Room for another launch while keeping `reserveSlots` records free (e.g. one for generation). */
  hasRoom(reserveSlots = 0): boolean { return this.#records.length + 1 + reserveSlots <= MAX_WORKER_RECORDS; }
  /** Serialize every transition+persist so an older journal can never be written after a newer one. */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }
  async #write(next: readonly WorkerRecord[]): Promise<void> {
    if (this.#broken) throw new AssetError('PERSISTENCE', 'Worker supervision journal is uncertain; no further worker may start.');
    // Adopt the truthful intended state first: if the write is ambiguous, later writes keep it.
    this.#records = next;
    try { await this.#options.persist(next); }
    catch { this.#broken = true; throw new AssetError('PERSISTENCE', 'Worker supervision journal could not be saved; no further worker may start.'); }
  }
  /** Durably reserve a stage BEFORE spawning. Throws (and nothing may be spawned) if the reservation is not saved. */
  begin(role: WorkerRole, executable: string): Promise<StageLaunch> {
    return this.#exclusive(async () => {
      const reservationId = this.#options.newId();
      await this.#write(reserveWorker(this.#records, role, reservationId, this.#options.now()));
      return new StageLaunch(this, reservationId, role, executable);
    });
  }
  /** @internal */ async captureFor(launch: StageLaunch, pid: number): Promise<'captured' | 'unsupported' | 'uncertain'> {
    // Durable PID+creation-time capture is Windows-specific. POSIX workers
    // retain their reservation until this supervisor observes their own close;
    // feeding a POSIX executable into the Windows identity parser would instead
    // stop an otherwise valid owned child as an invalid Windows identity.
    if (!this.#options.capture || this.#options.host.platform !== 'win32') return 'unsupported';
    const result = await captureWorkerIdentity({ pid, role: launch.role, executable: launch.executable }, this.#options.host);
    if (result.status !== 'captured') return result.reason === 'platform-unsupported' ? 'unsupported' : 'uncertain';
    return this.#exclusive(async () => {
      try { await this.#write(recordCaptured(this.#records, launch.reservationId, result.identity)); return 'captured' as const; }
      catch { return 'uncertain' as const; }
    });
  }
  /** @internal */ closeFor(launch: StageLaunch, closure: 'exit-observed' | 'not-started'): Promise<void> {
    return this.#exclusive(async () => {
      const next = recordClosed(this.#records, launch.reservationId, closure, this.#options.now());
      if (this.#broken) { this.#records = next; throw new AssetError('PERSISTENCE', 'Worker closure was observed but the supervision journal is uncertain.'); }
      await this.#write(next);
    });
  }
}

/** One reserved stage. Its hooks go to the runner; `finish()` runs after the runner settles and records
 * closure for THIS reservation only when the runner reported the child's close (or that none started). */
export class StageLaunch {
  #spawnReported = false;
  #pid: number | undefined;
  #closedObserved = false;
  #stopRequested = false;
  constructor(private readonly supervision: WorkerSupervision, readonly reservationId: string, readonly role: WorkerRole, readonly executable: string) {}
  get stopRequested(): boolean { return this.#stopRequested; }
  readonly hooks: WorkerSupervisionHooks = {
    spawned: async ({ pid, exited }) => {
      this.#spawnReported = true; this.#pid = pid;
      if (pid === undefined) return 'continue'; // No process; the runner reports the spawn failure.
      const outcome = await this.supervision.captureFor(this, pid);
      // Unsupported OS: the stage stays reserved while it runs; only the observed close can resolve it.
      // Windows: an owned worker that exited before capture is fine (close resolves it); a live worker
      // whose exact identity cannot be recorded is stopped, and its closure is still awaited, not assumed.
      if (outcome === 'captured' || outcome === 'unsupported' || exited()) return 'continue';
      this.#stopRequested = true; return 'stop';
    },
    closed: () => { this.#closedObserved = true; },
  };
  /** Call exactly once after the runner settled (resolved or rejected). */
  async finish(): Promise<void> {
    if (this.#closedObserved) return this.supervision.closeFor(this, this.#pid === undefined ? 'not-started' : 'exit-observed');
    if (!this.#spawnReported) return this.supervision.closeFor(this, 'not-started'); // Runner never created a process.
    // A PID existed but no close was reported: never claim closure; the reservation/identity stays unresolved.
    throw new AssetError('SUPERVISION_UNRESOLVED', 'Worker closure was not observed; the job remains fenced for inspection.');
  }
}
