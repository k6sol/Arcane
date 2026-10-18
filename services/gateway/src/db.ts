/**
 * SQLite storage (node:sqlite) with forward-only migrations tracked in PRAGMA user_version.
 * Every balance change happens inside one IMMEDIATE transaction so concurrent requests cannot double-spend.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS: string[] = [
  // 1: accounts, sign-in, billing, metering, audit.
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
     plan_id TEXT, plan_actions INTEGER NOT NULL DEFAULT 0 CHECK (plan_actions >= 0), pack_actions INTEGER NOT NULL DEFAULT 0 CHECK (pack_actions >= 0),
     renews_at TEXT, subscription_id TEXT UNIQUE, customer_id TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE tokens (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
     last_used_at INTEGER, revoked_at INTEGER);
   CREATE INDEX tokens_account ON tokens(account_id);
   CREATE TABLE device_requests (id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, status TEXT NOT NULL, account_id TEXT,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_poll_at INTEGER, emails_sent INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE login_links (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device_requests(id), email TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
   CREATE INDEX login_links_email ON login_links(email, created_at);
   CREATE TABLE webhook_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL);
   CREATE TABLE grants (key TEXT PRIMARY KEY, account_id TEXT NOT NULL, offer_id TEXT NOT NULL, credits INTEGER NOT NULL,
     actions INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, period TEXT NOT NULL, credits INTEGER NOT NULL,
     actions INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
     request_id TEXT, created_at INTEGER NOT NULL);
   CREATE INDEX usage_account_period ON usage(account_id, period);
   CREATE TABLE turns (account_id TEXT NOT NULL, turn_id TEXT NOT NULL, allowance_left INTEGER NOT NULL CHECK (allowance_left >= 0),
     created_at INTEGER NOT NULL, PRIMARY KEY (account_id, turn_id));
   CREATE TABLE holds (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, turn_id TEXT, from_allowance INTEGER NOT NULL,
     from_credits INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE idempotency (account_id TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
     created_at INTEGER NOT NULL, PRIMARY KEY (account_id, route, key));
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id TEXT, event TEXT NOT NULL, detail TEXT NOT NULL);`,
];

export type Row = Record<string, unknown>;
export interface Account {
  id: string; email: string; credits: number; plan_id: string | null; plan_actions: number; pack_actions: number;
  renews_at: string | null; subscription_id: string | null; customer_id: string | null; created_at: number;
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): number {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (current > MIGRATIONS.length) throw new Error('The database is newer than this gateway build. Upgrade the gateway.');
  for (let version = current; version < MIGRATIONS.length; version++) {
    tx(db, () => { db.exec(MIGRATIONS[version]); db.exec('PRAGMA user_version = ' + (version + 1)); });
  }
  return MIGRATIONS.length;
}

/** Runs `work` in one IMMEDIATE transaction (write lock taken up front). */
export function tx<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
}

export function audit(db: DatabaseSync, accountId: string | null, event: string, detail: Row = {}): void {
  db.prepare('INSERT INTO audit (at, account_id, event, detail) VALUES (?, ?, ?, ?)').run(Date.now(), accountId, event, JSON.stringify(detail));
}

export const getAccount = (db: DatabaseSync, id: string): Account | null => (db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined) ?? null;
export const accountByEmail = (db: DatabaseSync, email: string): Account | null => (db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as unknown as Account | undefined) ?? null;
