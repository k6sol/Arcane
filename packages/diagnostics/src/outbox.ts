import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {diagnosticEvent, type DiagnosticEvent} from './report.js';

export interface DiagnosticCodec {seal(id: string, value: string): string; open(id: string, value: string): string}
export interface DiagnosticCredential {scope: string; base: string; token: string}
export interface DiagnosticDelivery {state: 'idle' | 'disabled' | 'signed-out' | 'sent' | 'retry' | 'blocked' | 'busy'; sent: number; pending: number}
export class DiagnosticOutboxError extends Error {constructor() {super('The local diagnostic queue is unavailable.');}}
const DAY = 86400000, RETENTION = 30 * DAY, CAP = 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validScope = (value: string) => /^[a-f0-9]{64}$/.test(value);
/** Stable account/origin binding; never use the rotating bearer token as a scope. */
export function diagnosticScope(origin: string, accountId: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !/^acct_[a-f0-9]{32}$/.test(accountId)) throw new DiagnosticOutboxError();
  return digest(origin + '\0' + accountId);
}
interface Queued {scope: string; event_id: string; payload: string; digest: string; attempts: number}

/** Caller owns a dedicated, private SQLite connection and an OS-backed encryption codec. No credential is persisted.
 * One explicit flush does bounded work; the host owns scheduling. Closing/reopening the DB retains retries and leases. */
export class DiagnosticOutbox {
  private readonly owner = randomUUID();
  private busy = false;
  constructor(private readonly options: {db: DatabaseSync; codec: DiagnosticCodec; allowedOrigins: readonly string[];
    credential: () => Promise<DiagnosticCredential | null>; fetch?: typeof fetch; now?: () => number}) {
    try {
      for (const origin of options.allowedOrigins) {const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw Error();}
      if (options.allowedOrigins.length > 8) throw Error();
      options.db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS diagnostic_outbox (scope TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,
          queued_at INTEGER NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,event_id)) STRICT;
        CREATE INDEX IF NOT EXISTS diagnostic_outbox_ready ON diagnostic_outbox(scope,blocked,next_at,lease_until);`);
    } catch {throw new DiagnosticOutboxError();}
  }
  private now(): number {const value = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) throw new DiagnosticOutboxError(); return value;}
  private transaction<T>(work: () => T): T {
    const db = this.options.db; db.exec('BEGIN IMMEDIATE');
    try {const result = work(); db.exec('COMMIT'); return result;} catch (error) {try {db.exec('ROLLBACK');} catch {} throw error;}
  }
  private expire(now: number): void {this.options.db.prepare('DELETE FROM diagnostic_outbox WHERE queued_at<=?').run(now - RETENTION);}
  pending(): number {try {return Number(this.options.db.prepare('SELECT count(*) AS n FROM diagnostic_outbox').get()!.n);} catch {throw new DiagnosticOutboxError();}}
  enqueue(scope: string, input: unknown): string {
    try {
      if (!validScope(scope)) throw Error();
      const event = diagnosticEvent(input), body = JSON.stringify(event), hash = digest(body), now = this.now();
      return this.transaction(() => {
        this.expire(now);
        const old = this.options.db.prepare('SELECT digest FROM diagnostic_outbox WHERE scope=? AND event_id=?').get(scope, event.eventId);
        if (old) {if (old.digest !== hash) throw Error(); return event.eventId;}
        if (this.pending() >= CAP || event.occurredAt < now - RETENTION || event.occurredAt > now + 300000) throw Error();
        const id = scope + '\0' + event.eventId, payload = this.options.codec.seal(id, body);
        if (typeof payload !== 'string' || !payload || payload.length > 45000 || this.options.codec.open(id, payload) !== body) throw Error();
        this.options.db.prepare('INSERT INTO diagnostic_outbox(scope,event_id,payload,digest,queued_at,next_at) VALUES(?,?,?,?,?,?)')
          .run(scope, event.eventId, payload, hash, now, now);
        return event.eventId;
      });
    } catch {throw new DiagnosticOutboxError();}
  }
  private claim(scope: string, now: number): Queued | null {
    return this.transaction(() => {
      this.expire(now);
      const row = this.options.db.prepare('SELECT scope,event_id,payload,digest,attempts FROM diagnostic_outbox WHERE scope=? AND blocked=0 AND next_at<=? AND lease_until<=? ORDER BY queued_at,event_id LIMIT 1').get(scope, now, now) as unknown as Queued | undefined;
      if (!row) return null;
      this.options.db.prepare('UPDATE diagnostic_outbox SET lease_owner=?,lease_until=?,attempts=attempts+1 WHERE scope=? AND event_id=?')
        .run(this.owner, now + 30000, scope, row.event_id);
      return {...row, attempts: row.attempts + 1};
    });
  }
  private settle(row: Queued, outcome: 'sent' | 'retry' | 'blocked', now: number): void {
    if (outcome === 'sent') {
      this.options.db.prepare('DELETE FROM diagnostic_outbox WHERE scope=? AND event_id=? AND lease_owner=?').run(row.scope, row.event_id, this.owner);
    } else {
      const delay = Math.min(3600000, 1000 * 2 ** Math.min(12, row.attempts - 1));
      this.options.db.prepare('UPDATE diagnostic_outbox SET blocked=?,next_at=?,lease_owner=NULL,lease_until=0 WHERE scope=? AND event_id=? AND lease_owner=?')
        .run(outcome === 'blocked' ? 1 : 0, now + delay, row.scope, row.event_id, this.owner);
    }
  }
  async flush(): Promise<DiagnosticDelivery> {
    const result = (state: DiagnosticDelivery['state'], sent = 0): DiagnosticDelivery => ({state, sent, pending: this.pending()});
    if (this.busy) return result('busy');
    if (!this.options.allowedOrigins.length) return result('disabled');
    this.busy = true;
    try {
      const credential = await this.options.credential();
      if (!credential) return result('signed-out');
      const url = new URL(credential.base);
      if (!validScope(credential.scope) || url.origin !== credential.base || !this.options.allowedOrigins.includes(url.origin) ||
          url.protocol !== 'https:' || !/^arc_[A-Za-z0-9_-]{43}$/.test(credential.token)) return result('disabled');
      let sent = 0;
      for (let count = 0; count < 5; count++) {
        const row = this.claim(credential.scope, this.now()); if (!row) return result(sent ? 'sent' : 'idle', sent);
        let outcome: 'sent' | 'retry' | 'blocked' = 'retry';
        try {
          const decoded = this.options.codec.open(row.scope + '\0' + row.event_id, row.payload);
          if (decoded.length > 8192) throw Error();
          const event: DiagnosticEvent = diagnosticEvent(JSON.parse(decoded));
          if (event.eventId !== row.event_id || digest(JSON.stringify(event)) !== row.digest) throw Error();
          // Recheck account binding immediately before each request, including after a previous request awaited.
          const current = await this.options.credential();
          if (!current || current.scope !== credential.scope || current.base !== credential.base) {this.settle(row, 'retry', this.now()); return result('signed-out', sent);}
          if (!/^arc_[A-Za-z0-9_-]{43}$/.test(current.token)) throw Error();
          const response = await (this.options.fetch ?? fetch)(url.origin + '/v1/diagnostics/events', {method: 'POST', redirect: 'error', credentials: 'omit',
            signal: AbortSignal.timeout(5000), headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + current.token}, body: JSON.stringify(event)});
          if (response.ok) {
            const reader = response.body?.getReader(); if (!reader) throw Error();
            let bytes = 0; const chunks: Uint8Array[] = [];
            try {for (;;) {const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1024) throw Error(); chunks.push(next.value);}}
            finally {await reader.cancel().catch(() => {});}
            const ack: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (ack && typeof ack === 'object' && Object.keys(ack).sort().join(',') === 'accepted,eventId' &&
                (ack as {accepted?: unknown}).accepted === true && (ack as {eventId?: unknown}).eventId === row.event_id) outcome = 'sent';
          } else {
            await response.body?.cancel().catch(() => {});
            if ([400, 404, 409, 410, 413, 415, 422].includes(response.status)) outcome = 'blocked';
          }
        } catch { /* No raw exception text, server body or credentials enter queue state. */ }
        this.settle(row, outcome, this.now());
        if (outcome !== 'sent') return result(outcome, sent);
        sent++;
      }
      return result('sent', sent);
    } catch {return result('retry');}
    finally {this.busy = false;}
  }
}
