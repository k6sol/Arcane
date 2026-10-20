import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkedDirectory, checkedEntries, checkedFile, FILE_LIMITS } from './paths.js';
import { codes, digest, fail, fingerprint, freeze, identifier, parse, type TestCode } from './contracts.js';
import { SCENARIO_ACTIONS, scenarioReviewSchema } from './scenario.js';

export const eventSchema = z.strictObject({
  kind: z.enum(['consent', 'consume', 'admit', 'start_intent', 'start_result', 'observe', 'watchdog',
    'stop_intent', 'stop_result', 'terminal', 'cleanup', 'setup_intent', 'setup_result', 'scenario_intent', 'scenario_result', 'capture_intent', 'capture_result', 'restore_intent', 'restore_result']),
  id: identifier, at: z.number().int().nonnegative(), scopeDigest: fingerprint,
  evidence: z.enum(['fixture', 'native']), code: z.enum(codes),
  expiresAt: z.number().int().nonnegative().optional(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'rejected']).optional(),
  cleanup: z.enum(['complete', 'unknown']).optional(),
  logs: z.array(z.strictObject({ idDigest: fingerprint, digest: fingerprint,
    level: z.enum(['info', 'warning', 'error']), bytes: z.number().int().min(0).max(8192) })).max(8).optional(),
  logsTruncated: z.boolean().optional(),
  scenario: scenarioReviewSchema.optional(),
});
export type TestEvent = z.infer<typeof eventSchema>;
const recordSchema = z.strictObject({ seq: z.number().int().positive(), previous: z.string().max(64), hash: fingerprint, event: eventSchema });
export type TestRecord = z.infer<typeof recordSchema>;
/** The writer lock names its owner so a later start can recognise its own shape. */
const LOCK_BYTES = 1024;
const lockSchema = z.strictObject({ schemaVersion: z.literal(1), writerId: z.string().uuid() });
/** Directories held by a live ledger in this process; never recovered from under it. */
const liveLedgers = new Set<string>();
const liveKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
export interface TestLedgerOpenOptions {
  /** Trusted host proof that no other process can be this ledger's writer (for example the
   * project's exclusive workspace lock). Only then may an abandoned writer lock be cleared. */
  exclusiveWriter?: () => boolean;
}
/** Why a start is fenced, without revealing journal contents. */
export type TestLedgerFence = 'none' | 'live-writer' | 'unresolved-run' | 'unreadable';
interface LockPin { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
const sameLock = (a: LockPin, b: LockPin) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function lockShapeIsOurs(lockPath: string): Promise<LockPin | null> {
  const stat = await lstat(lockPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(LOCK_BYTES)) return null;
  const file = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameLock(stat, await file.stat({ bigint: true }))) return null;
    const bytes = Buffer.alloc(LOCK_BYTES + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (BigInt(length) !== stat.size || !sameLock(stat, await file.stat({ bigint: true })) || !sameLock(stat, await lstat(lockPath, { bigint: true }))) return null;
    // A zero-length file is a crash between creation and first write (or an older build's lock).
    if (length && !lockSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))).success) return null;
    return stat;
  } catch { return null; } finally { await file.close(); }
}
function unresolvedIn(records: readonly TestRecord[]): boolean {
  for (const r of records.filter(r => r.event.kind === 'admit')) {
    const events = records.filter(x => x.event.id === r.event.id).map(x => x.event);
    if (events.filter(e => e.kind === 'terminal').length !== 1 || events.at(-1)?.kind !== 'cleanup' || events.at(-1)?.cleanup !== 'complete') return true;
  }
  return false;
}
const exclusiveProof = (options: TestLedgerOpenOptions): boolean => { try { return options.exclusiveWriter?.() === true; } catch { return false; } };
/** One host-wide ledger/lock, shared by every controller. A new run directory or
 * process cannot bypass an unresolved run. Only a proved abandoned, resolved lock can be recovered. */
export class TestLedger {
  readonly #directory: string; readonly #root: string; readonly #records: TestRecord[];
  #closed = false; #broken = false; #busyRun: string | null = null;
  #tail: Promise<void> = Promise.resolve(); #queued = 0;
  #closing: Promise<void> | null = null;
  private constructor(directory: string, root: string, records: TestRecord[]) {
    this.#directory = directory; this.#root = root; this.#records = records;
  }
  static async open(directory: string, existingTrustedRoot: string, options: TestLedgerOpenOptions = {}): Promise<TestLedger> {
    const path = await checkedDirectory(directory, existingTrustedRoot);
    const key = liveKey(path); if (liveLedgers.has(key)) fail('FENCED');
    liveLedgers.add(key); // Reserve before any recovery/open awaits, including a still-empty new lock.
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await checkedDirectory(path, existingTrustedRoot); await checkedEntries(path);
      const lockPath = await checkedFile(path, 'writer.lock', true);
      await recoverAbandonedLock(path, existingTrustedRoot, lockPath, options);
      const file = await open(lockPath, 'wx', 0o600).catch(() => fail('FENCED'));
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, writerId: randomUUID() }), 'utf8'); await file.sync(); } finally { await file.close(); }
      // Read failures leave the lock intact. Recovery is an authenticated host action.
      const records = await readTestLedger(path, existingTrustedRoot);
      const ledger = new TestLedger(path, existingTrustedRoot, records);
      if (ledger.unresolved()) fail('FENCED');
      return ledger;
    } catch (error) { liveLedgers.delete(key); throw error; }
  }
  /** Read-only: why a start would be fenced right now (for the host's repair prompt). */
  static async fence(directory: string, existingTrustedRoot: string): Promise<TestLedgerFence> {
    let path: string;
    try { path = await checkedDirectory(directory, existingTrustedRoot); } catch { return 'unreadable'; }
    if (liveLedgers.has(liveKey(path))) return 'live-writer';
    try { await lstat(path); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable'; }
    let records: TestRecord[];
    try { records = await readTestLedger(path, existingTrustedRoot); } catch { return 'unreadable'; }
    if (unresolvedIn(records)) return 'unresolved-run';
    try { await lstat(join(path, 'writer.lock')); return 'live-writer'; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable'; }
  }
  /** Human repair: move the whole retained journal (records and lock) aside, unchanged, so a fresh
   * journal can start. Nothing is deleted. The caller must hold the person's confirmation that
   * Studio is back in Edit mode, plus the trusted exclusive-writer proof. Returns the retained path. */
  static async retainForRepair(directory: string, existingTrustedRoot: string, retainedRoot: string,
    options: TestLedgerOpenOptions & { now?: () => number } = {}): Promise<string> {
    if (!exclusiveProof(options)) fail('FENCED');
    const path = await checkedDirectory(directory, existingTrustedRoot);
    const key = liveKey(path); if (liveLedgers.has(key)) fail('BUSY');
    liveLedgers.add(key);
    try {
      const retained = await checkedDirectory(retainedRoot, dirname(existingTrustedRoot));
      const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
      await mkdir(retained, { recursive: true, mode: 0o700 });
      await checkedDirectory(retained, dirname(existingTrustedRoot));
      const target = join(retained, 'ledger-' + stamp + '-' + randomUUID().slice(0, 8));
      await checkedDirectory(path, existingTrustedRoot);
      if (!exclusiveProof(options)) fail('FENCED');
      await rename(path, target);
      return target;
    } finally { liveLedgers.delete(key); }
  }
  records(): readonly TestRecord[] { return freeze(structuredClone(this.#records)); }
  unresolved(): boolean {
    if (this.#broken) return true;
    for (const r of this.#records.filter(r => r.event.kind === 'admit')) {
      const events = this.#records.filter(x => x.event.id === r.event.id).map(x => x.event);
      if (events.filter(e => e.kind === 'terminal').length !== 1 || events.at(-1)?.kind !== 'cleanup' || events.at(-1)?.cleanup !== 'complete') return true;
    }
    return false;
  }
  claimRun(runId: string): void {
    if (this.#busyRun) fail('BUSY');
    if (this.#closed || this.#broken || this.unresolved()) fail('FENCED');
    this.#busyRun = runId;
  }
  releaseRun(runId: string): void {
    if (this.#busyRun === runId && !this.unresolved()) this.#busyRun = null;
  }
  /** Append-only grants and consumption: consume is fsynced before admission. */
  async grant(scopeDigest: string, expiresAt: number, at: number, evidence: 'fixture' | 'native'): Promise<string> {
    if (this.#busyRun || this.unresolved()) fail('BUSY');
    const id = randomUUID();
    await this.append({ kind: 'consent', id, at, scopeDigest, expiresAt, evidence, code: 'OK' }); return id;
  }
  async consume(id: string, scopeDigest: string, at: number, evidence: 'fixture' | 'native'): Promise<void> {
    const grant = this.#records.find(r => r.event.kind === 'consent' && r.event.id === id)?.event;
    if (!grant || grant.scopeDigest !== scopeDigest || grant.evidence !== evidence || this.#records.some(r => r.event.id === id && r.event.kind === 'consume')) fail('HUMAN_AUTH_REQUIRED');
    if (grant.at > at || !grant.expiresAt || grant.expiresAt <= at) fail('CONSENT_EXPIRED');
    await this.append({ kind: 'consume', id, at, scopeDigest, evidence, code: 'OK' });
  }
  async append(input: TestEvent): Promise<void> {
    if (this.#closed || this.#broken || this.#queued >= 16) fail('JOURNAL_FAILED');
    const event = freeze(parse(eventSchema, input, 'JOURNAL_FAILED')); this.#queued++;
    const work = this.#tail.then(async () => {
      if (this.#broken) fail('JOURNAL_FAILED');
      await checkedDirectory(this.#directory, this.#root); await checkedEntries(this.#directory);
      if (this.#records.length >= FILE_LIMITS.records) fail('JOURNAL_FAILED');
      const seq = this.#records.length + 1, previous = this.#records.at(-1)?.hash ?? 'genesis';
      const record = freeze({ seq, previous, event, hash: digest({ seq, previous, event }) });
      const text = JSON.stringify(record) + '\n'; if (Buffer.byteLength(text) > FILE_LIMITS.recordBytes) fail('JOURNAL_FAILED');
      const path = await checkedFile(this.#directory, `${String(seq).padStart(5, '0')}.json`, true);
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
      this.#records.push(record);
    });
    this.#tail = work.catch(() => { this.#broken = true; });
    try { await work; } catch { this.#broken = true; fail('JOURNAL_FAILED'); } finally { this.#queued--; }
  }
  close(): Promise<void> {
    return this.#closing ??= this.finishClose();
  }
  private async finishClose(): Promise<void> {
    this.#closed = true; await this.#tail;
    if (this.#busyRun || this.unresolved()) { liveLedgers.delete(liveKey(this.#directory)); return; } // retain the durable crash/reconciliation fence
    await checkedDirectory(this.#directory, this.#root);
    await unlink(await checkedFile(this.#directory, 'writer.lock', false));
    liveLedgers.delete(liveKey(this.#directory));
  }
}
/** A daemon that is killed (or loses power) never runs close(), so its writer lock outlives it and
 * every later start is fenced although no test may ever have run. The lock is cleared only when the
 * host proves it is the sole possible writer, no ledger in this process holds it, the file is this
 * ledger's own lock shape, and every retained record verifies with no unresolved run. Anything else
 * keeps the fence and leaves the evidence untouched. */
async function recoverAbandonedLock(path: string, root: string, lockPath: string, options: TestLedgerOpenOptions): Promise<void> {
  if (!exclusiveProof(options)) return;
  let before: LockPin | null;
  try { before = await lockShapeIsOurs(lockPath); } catch { return; }
  if (!before) return;
  let records: TestRecord[];
  try { records = await readTestLedger(path, root); } catch { return; }
  if (unresolvedIn(records)) return;
  let after: LockPin | null;
  try { after = await lockShapeIsOurs(lockPath); } catch { return; }
  if (!after || !sameLock(after, before)) return;
  await checkedDirectory(path, root);
  if (!exclusiveProof(options)) return;
  try { await unlink(lockPath); } catch { /* Exclusive creation below still decides. */ }
}
export async function readTestLedger(directory: string, existingTrustedRoot: string): Promise<TestRecord[]> {
  const path = await checkedDirectory(directory, existingTrustedRoot);
  const names = (await checkedEntries(path)).filter(name => /^\d{5}\.json$/.test(name)).sort();
  const records: TestRecord[] = [];
  try {
    for (const name of names) {
      const bytes = await readFile(await checkedFile(path, name, false));
      if (bytes.length > FILE_LIMITS.recordBytes) fail('JOURNAL_FAILED');
      const r = parse(recordSchema, JSON.parse(bytes.toString('utf8')), 'JOURNAL_FAILED');
      if (r.seq !== records.length + 1 || name !== `${String(r.seq).padStart(5, '0')}.json` ||
          r.previous !== (records.at(-1)?.hash ?? 'genesis') || r.hash !== digest({ seq: r.seq, previous: r.previous, event: r.event })) fail('JOURNAL_FAILED');
      records.push(r);
    }
    const terminals = new Set<string>();
    for (const r of records) if (r.event.kind === 'terminal') {
      if (terminals.has(r.event.id)) fail('JOURNAL_FAILED'); terminals.add(r.event.id);
    }
  } catch { fail('JOURNAL_FAILED'); }
  return records;
}
export interface ConsentDisplay {
  proposal: import('./contracts.js').TestProposal; cleanupGraceMs: number; requestTimeoutMs: number;
  proofMaxAgeMs: number; consentExpiresAt: number; guarantee: 'observed-non-atomic';
  actions: readonly ['start', 'observe-state-and-console', 'stop-owned-play'] | typeof SCENARIO_ACTIONS;
  raceDisclosure: 'Observed checks cannot atomically fence the native call.';
}
/** Authenticate a HUMAN control audience and verify confirmation of this exact
 * frozen display, including its digest. Agent/model/conversation credentials are
 * insufficient. There is deliberately no Boolean/caller-asserted-human fallback. */
export interface HumanTestVerifier {
  confirm(context: unknown, display: Readonly<ConsentDisplay>, displayDigest: string, signal: AbortSignal): Promise<boolean>;
}
export async function recordHumanConsent(ledger: TestLedger, verifier: HumanTestVerifier, context: unknown,
  display: Readonly<ConsentDisplay>, at: number, evidence: 'fixture' | 'native', signal: AbortSignal): Promise<string> {
  if (!await verifier.confirm(context, display, digest(display), signal) || signal.aborted) fail('HUMAN_AUTH_REQUIRED');
  return ledger.grant(digest(display), display.consentExpiresAt, at, evidence);
}
export function terminalCode(records: readonly TestRecord[], runId: string): TestCode | null {
  return records.find(r => r.event.kind === 'terminal' && r.event.id === runId)?.event.code ?? null;
}
