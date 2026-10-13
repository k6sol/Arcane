import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkedDirectory, checkedEntries, checkedFile, FILE_LIMITS } from './paths.js';
import { codes, digest, fail, fingerprint, freeze, identifier, parse, type TestCode } from './contracts.js';

export const eventSchema = z.strictObject({
  kind: z.enum(['consent', 'consume', 'admit', 'start_intent', 'start_result', 'observe', 'watchdog',
    'stop_intent', 'stop_result', 'terminal', 'cleanup']),
  id: identifier, at: z.number().int().nonnegative(), scopeDigest: fingerprint,
  evidence: z.enum(['fixture', 'native']), code: z.enum(codes),
  expiresAt: z.number().int().nonnegative().optional(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'rejected']).optional(),
  cleanup: z.enum(['complete', 'unknown']).optional(),
  logs: z.array(z.strictObject({ idDigest: fingerprint, digest: fingerprint,
    level: z.enum(['info', 'warning', 'error']), bytes: z.number().int().min(0).max(8192) })).max(8).optional(),
  logsTruncated: z.boolean().optional(),
});
export type TestEvent = z.infer<typeof eventSchema>;
const recordSchema = z.strictObject({ seq: z.number().int().positive(), previous: z.string().max(64), hash: fingerprint, event: eventSchema });
export type TestRecord = z.infer<typeof recordSchema>;
/** One host-wide ledger/lock, shared by every controller. A new run directory or
 * process cannot bypass an unresolved run. Never delete a lock on crash recovery. */
export class TestLedger {
  readonly #directory: string; readonly #root: string; readonly #records: TestRecord[];
  #closed = false; #broken = false; #busyRun: string | null = null;
  #tail: Promise<void> = Promise.resolve(); #queued = 0;
  private constructor(directory: string, root: string, records: TestRecord[]) {
    this.#directory = directory; this.#root = root; this.#records = records;
  }
  static async open(directory: string, existingTrustedRoot: string): Promise<TestLedger> {
    const path = await checkedDirectory(directory, existingTrustedRoot);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await checkedDirectory(path, existingTrustedRoot); await checkedEntries(path);
    const lockPath = await checkedFile(path, 'writer.lock', true);
    const file = await open(lockPath, 'wx', 0o600).catch(() => fail('FENCED'));
    try { await file.sync(); } finally { await file.close(); }
    // Read failures leave the lock intact. Recovery is an authenticated host action.
    const records = await readTestLedger(path, existingTrustedRoot);
    const ledger = new TestLedger(path, existingTrustedRoot, records);
    if (ledger.unresolved()) fail('FENCED');
    return ledger;
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
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#tail; this.#closed = true;
    if (this.#busyRun || this.unresolved()) return; // retain the durable crash/reconciliation fence
    await checkedDirectory(this.#directory, this.#root);
    await unlink(await checkedFile(this.#directory, 'writer.lock', false));
  }
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
  actions: readonly ['start', 'observe-state-and-console', 'stop-owned-play'];
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
