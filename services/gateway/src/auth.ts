import {AccountStore} from './account-store.ts';
/**
 * Account sign-in: device code + email magic link.
 *
 * 1. The app calls POST /v1/auth/device and gets a secret `deviceCode` plus a short `userCode` it shows to the user.
 * 2. The user opens `verificationUrl` in a browser, enters their email and the user code. The gateway emails a
 *    single-use link (15 minutes).
 * 3. The link opens a confirm page that shows the user code again; the user approves with a button (a POST, so mail
 *    scanners that prefetch links cannot approve).
 * 4. The app polls POST /v1/auth/token with the device code and receives an opaque bearer token exactly once.
 *
 * Only HMAC-SHA256 hashes (keyed with AUTH_SECRET) of device codes, link tokens and bearer tokens are stored.
 */
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GatewayConfig } from './config.ts';
import { accountByEmail, audit, getAccount, tx, type Account, type Row } from './db.ts';

export const DEVICE_TTL_MS = 10 * 60 * 1000, LINK_TTL_MS = 15 * 60 * 1000, POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,128}$/;
export const BEARER = /^arc_[A-Za-z0-9_-]{43}$/;

export const keyedHash = (config: GatewayConfig, kind: string, value: string) => createHmac('sha256', config.authSecret).update(kind + ':' + value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>"']{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.toUpperCase().replace(/[^A-Z]/g, '');
  const code = raw.slice(0, 4) + '-' + raw.slice(4);
  return raw.length === 8 && USER_CODE.test(code) ? code : null;
}
function newUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += (i === 4 ? '-' : '') + USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

export function startDevice(db: DatabaseSync, config: GatewayConfig, now = Date.now()) {
  const deviceCode = opaque();
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode();
    try {
      db.prepare("INSERT INTO device_requests (id, user_code, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)")
        .run(keyedHash(config, 'device', deviceCode), userCode, now, now + DEVICE_TTL_MS);
      const verificationUrl = config.publicUrl + '/v1/auth/verify';
      return { deviceCode, userCode, verificationUrl, verificationUrlComplete: verificationUrl + '?user_code=' + userCode, interval: POLL_INTERVAL_S, expiresIn: DEVICE_TTL_MS / 1000 };
    } catch (error) { if (attempt > 4) throw error; }
  }
}

export type MailSender = (message: { to: string; subject: string; text: string }) => Promise<void>;

/** Emails a magic link for a pending device request. Always resolves; the caller shows the same page either way. */
export async function requestLink(db: DatabaseSync, config: GatewayConfig, userCodeRaw: unknown, emailRaw: unknown, send: MailSender, now = Date.now()): Promise<boolean> {
  const userCode = normalizeUserCode(userCodeRaw), email = normalizeEmail(emailRaw);
  if (!userCode || !email) return false;
  const link = opaque();
  const device = tx(db, () => {
    const row = db.prepare("SELECT * FROM device_requests WHERE user_code = ? AND status = 'pending' AND expires_at > ?").get(userCode, now) as Row | undefined;
    if (!row || Number(row.emails_sent) >= 3) return null;
    const recent = Number((db.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at > ?').get(email, now - 3600_000) as Row).n);
    if (recent >= 5) return null;
    db.prepare('UPDATE device_requests SET emails_sent = emails_sent + 1 WHERE id = ?').run(row.id as string);
    db.prepare('INSERT INTO login_links (hash, device_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(keyedHash(config, 'link', link), row.id as string, email, now, now + LINK_TTL_MS);
    audit(db, null, 'auth.link_sent', { emailHash: keyedHash(config, 'email', email).slice(0, 16) });
    return row;
  });
  if (!device) return false;
  await send({ to: email, subject: 'Sign in to Arcane',
    text: 'Someone (hopefully you) asked to sign in to Arcane with the code ' + userCode + '.\n\n' +
      'Open this link to approve it. It works once and expires in 15 minutes:\n' + config.publicUrl + '/v1/auth/confirm?t=' + link + '\n\n' +
      'If you did not ask for this, ignore this email.' });
  return true;
}

function linkRow(db: DatabaseSync, config: GatewayConfig, link: unknown, now: number): Row | null {
  if (typeof link !== 'string' || !OPAQUE.test(link)) return null;
  return (db.prepare(`SELECT l.*, d.user_code, d.status FROM login_links l JOIN device_requests d ON d.id = l.device_id
    WHERE l.hash = ? AND l.used_at IS NULL AND l.expires_at > ? AND d.status = 'pending' AND d.expires_at > ?`).get(keyedHash(config, 'link', link), now, now) as Row | undefined) ?? null;
}

/** For the confirm page: the user code the link approves, or null. Does not consume the link. */
export const describeLink = (db: DatabaseSync, config: GatewayConfig, link: unknown, now = Date.now()) => (linkRow(db, config, link, now)?.user_code as string | undefined) ?? null;

/** Approves the device request behind a link. Creates the account for that email on first sign-in. */
export function confirmLink(db: DatabaseSync, config: GatewayConfig, link: unknown, now = Date.now()): boolean {
  return tx(db, () => {
    const row = linkRow(db, config, link, now);
    if (!row) return false;
    const email = row.email as string;
    let account = accountByEmail(db, email);
    if (!account) {
      const id = 'acct_' + randomUUID().replace(/-/g, '');
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(id, email, now);
      account = getAccount(db, id) as Account;
      audit(db, id, 'account.created', {});
    }
    db.prepare('UPDATE login_links SET used_at = ? WHERE hash = ?').run(now, row.hash as string);
    db.prepare("UPDATE device_requests SET status = 'approved', account_id = ? WHERE id = ?").run(account.id, row.device_id as string);
    audit(db, account.id, 'auth.device_approved', {});
    return true;
  });
}

export type PollResult = { token: string; accountId: string } | { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'invalid_grant' };

/** Device polling. The bearer token is returned exactly once; afterwards the request is consumed. */
export function pollToken(db: DatabaseSync, config: GatewayConfig, deviceCode: unknown, now = Date.now()): PollResult {
  if (typeof deviceCode !== 'string' || !OPAQUE.test(deviceCode)) return { error: 'invalid_grant' };
  return tx(db, () => {
    const id = keyedHash(config, 'device', deviceCode);
    const row = db.prepare('SELECT * FROM device_requests WHERE id = ?').get(id) as Row | undefined;
    if (!row || row.status === 'consumed') return { error: 'invalid_grant' as const };
    if (Number(row.expires_at) <= now) return { error: 'expired_token' as const };
    const tooSoon = row.last_poll_at !== null && now - Number(row.last_poll_at) < (POLL_INTERVAL_S * 1000) - 500;
    db.prepare('UPDATE device_requests SET last_poll_at = ? WHERE id = ?').run(now, id);
    if (row.status !== 'approved') return { error: tooSoon ? 'slow_down' as const : 'authorization_pending' as const };
    let managed: Row | undefined;
    if(config.accounts){
      managed=db.prepare('SELECT d.subject,d.aal,i.disabled,i.mfa_required FROM account_device_approvals d JOIN account_identities i ON i.subject=d.subject AND i.account_id=? WHERE d.device_id=? AND d.approved_at>?').get(String(row.account_id),id,now-5*60000) as Row | undefined;
      if(!managed||managed.disabled||managed.mfa_required&&managed.aal!=='aal2')return {error:'invalid_grant' as const};
    }
    const token = 'arc_' + opaque();
    db.prepare("UPDATE device_requests SET status = 'consumed' WHERE id = ?").run(id);
    db.prepare('INSERT INTO tokens (hash, account_id, created_at) VALUES (?, ?, ?)').run(keyedHash(config, 'token', token), row.account_id as string, now);
    if(managed)db.prepare('INSERT INTO account_token_access(hash,subject,aal,expires_at) VALUES(?,?,?,?)').run(keyedHash(config,'token',token),String(managed.subject),String(managed.aal),now+30*86400000);
    audit(db, row.account_id as string, 'auth.token_issued', {});
    return { token, accountId: row.account_id as string };
  });
}

/** Resolves an `Authorization: Bearer` header to an account, or null. */
export function authenticate(db: DatabaseSync, config: GatewayConfig, header: string | undefined, now = Date.now()): Account | null {
  const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
  if (!match || !BEARER.test(match[1])) return null;
  const hash = keyedHash(config, 'token', match[1]);
  const row = db.prepare('SELECT account_id, last_used_at FROM tokens WHERE hash = ? AND revoked_at IS NULL').get(hash) as Row | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - Number(row.last_used_at) > 60_000) db.prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?').run(now, hash);
  const account=getAccount(db,row.account_id as string);if(!account)return null;
  if(config.accounts){
    const managed=db.prepare('SELECT i.email_cipher,i.disabled,i.mfa_required,t.aal FROM account_token_access t JOIN account_identities i ON i.subject=t.subject AND i.account_id=? WHERE t.hash=? AND t.expires_at>?').get(account.id,hash,now) as Row | undefined;
    if(!managed||managed.disabled||managed.mfa_required&&managed.aal!=='aal2')return null;
    const email=new AccountStore(db,config.accounts).open<{email:string}>('email',account.id,String(managed.email_cipher)).email;
    return {...account,email};
  }
  return account;
}

export function revoke(db: DatabaseSync, config: GatewayConfig, header: string | undefined, now = Date.now()): boolean {
  const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
  if (!match || !BEARER.test(match[1])) return false;
  const result = db.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL').run(now, keyedHash(config, 'token', match[1]));
  return Number(result.changes) > 0;
}

/** Removes expired device requests and links (run periodically). */
export function sweepAuth(db: DatabaseSync, now = Date.now()): void {
  db.prepare('DELETE FROM account_device_approvals WHERE device_id IN (SELECT id FROM device_requests WHERE expires_at < ?)').run(now - 86_400_000);
  db.prepare('DELETE FROM login_links WHERE expires_at < ?').run(now - 86_400_000);
  db.prepare("DELETE FROM device_requests WHERE expires_at < ? AND id NOT IN (SELECT device_id FROM login_links)").run(now - 86_400_000);
}
