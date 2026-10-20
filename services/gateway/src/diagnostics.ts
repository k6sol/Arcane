import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GatewayConfig} from './config.ts';
import {AccountStore} from './account-store.ts';
import {AccountError} from './account-provider.ts';
import {tx} from './db.ts';
import {RateLimiter} from './limits.ts';
import {diagnosticEvent, diagnosticEventId} from '../../../packages/diagnostics/src/report.ts';

/** No raw text is stored: reports pass the same closed schema at the local and hosted boundary. */
export function createDiagnostics(config: GatewayConfig, db: DatabaseSync, now: () => number) {
  if (!config.diagnostics || !config.accounts) return null;
  const settings = config.diagnostics, crypto = new AccountStore(db, config.accounts), rate = new RateLimiter(settings.perMinute);
  const ipRate = new RateLimiter(240), retention = settings.retentionDays * 86400000;
  db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_events (id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL REFERENCES accounts(id),
    event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,UNIQUE(account_id,event_id)) STRICT;
    CREATE INDEX IF NOT EXISTS diagnostic_events_retention ON diagnostic_events(received_at);
    CREATE INDEX IF NOT EXISTS diagnostic_events_account ON diagnostic_events(account_id,id);`);
  function sweep(): void {db.prepare('DELETE FROM diagnostic_events WHERE received_at<=?').run(now() - retention);}
  sweep();
  function ipLimit(ip: string): void {if (!ipRate.take(crypto.hash('diagnostic-ip', ip), now())) throw new AccountError(429, 'rate_limited', 'Diagnostic requests are temporarily limited.');}
  function accept(accountId: string, input: unknown) {
    if (!rate.take(accountId, now())) throw new AccountError(429, 'rate_limited', 'Diagnostic requests are temporarily limited.');
    let event;
    try {event = diagnosticEvent(input);} catch {throw new AccountError(400, 'invalid_diagnostic', 'The diagnostic report is invalid.');}
    const canonical = JSON.stringify(event), fingerprint = createHash('sha256').update(canonical).digest('hex');
    return tx(db, () => {
      sweep();
      const old = db.prepare('SELECT fingerprint FROM diagnostic_events WHERE account_id=? AND event_id=?').get(accountId, event.eventId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AccountError(409, 'diagnostic_conflict', 'This diagnostic identifier already records a different event.');
        return {accepted: true, eventId: event.eventId};
      }
      if (event.occurredAt < now() - retention || event.occurredAt > now() + 300000) throw new AccountError(410, 'diagnostic_expired', 'This diagnostic is outside the retention window.');
      if (Number(db.prepare('SELECT count(*) AS n FROM diagnostic_events WHERE account_id=?').get(accountId)!.n) >= settings.perAccount ||
          Number(db.prepare('SELECT count(*) AS n FROM diagnostic_events').get()!.n) >= settings.maxEvents) throw new AccountError(503, 'diagnostic_capacity', 'Diagnostic storage is temporarily full.');
      const payload = crypto.seal('diagnostic', accountId + '\0' + event.eventId, event);
      db.prepare('INSERT INTO diagnostic_events(account_id,event_id,fingerprint,payload,received_at) VALUES(?,?,?,?,?)').run(accountId, event.eventId, fingerprint, payload, now());
      return {accepted: true, eventId: event.eventId};
    });
  }
  /** Caller must require a freshly authenticated owner with recent MFA before calling this method. */
  function list(query: URLSearchParams) {
    if ([...query.keys()].some(key => !['before', 'eventId', 'accountId'].includes(key))) throw new AccountError(400, 'bad_cursor', 'Invalid diagnostic filter.');
    const before = query.get('before'), eventId = query.get('eventId'), accountId = query.get('accountId');
    if (before !== null && (!/^[1-9][0-9]{0,15}$/.test(before) || !Number.isSafeInteger(Number(before))) ||
        eventId !== null && !diagnosticEventId(eventId) || accountId !== null && !/^acct_[a-f0-9]{32}$/.test(accountId)) throw new AccountError(400, 'bad_cursor', 'Invalid diagnostic filter.');
    sweep();
    const rows = db.prepare('SELECT id,account_id,event_id,payload,received_at FROM diagnostic_events WHERE id<? AND (? IS NULL OR event_id=?) AND (? IS NULL OR account_id=?) ORDER BY id DESC LIMIT 51')
      .all(before === null ? Number.MAX_SAFE_INTEGER : Number(before), eventId, eventId, accountId, accountId);
    const events = rows.slice(0, 50).map(row => ({id: Number(row.id), accountId: String(row.account_id), receivedAt: Number(row.received_at),
      event: diagnosticEvent(crypto.open('diagnostic', String(row.account_id) + '\0' + String(row.event_id), String(row.payload)))}));
    return {events, next: rows.length > 50 ? String(events.at(-1)!.id) : null, retentionDays: settings.retentionDays};
  }
  return {accept, ipLimit, list, sweep};
}
export type Diagnostics = NonNullable<ReturnType<typeof createDiagnostics>>;
