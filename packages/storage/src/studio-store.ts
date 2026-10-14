import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ArcaneError } from '../../protocol/src/providers.js';
import { isWrite, instanceRef, jsonObject, methodField, object, roots, textField, ROOTS, STUDIO_PROTOCOL, type Json, type PairingGrant, type PairResult, type StudioCommand, type StudioSession } from '../../protocol/src/studio.js';
import { canonical, validateCommandArgs } from '../../core/src/studio-policy.js';
import { nativePropertiesMatch } from '../../core/src/native-property-outcomes.js';
import type { ScriptSourceVerifier, ScriptSourceVerification } from '../../core/src/script-source-verifier.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface Options { directory: string; now?: () => number }
export interface ArcaneKeySummary {keyId:string;allowedRoots:StudioSession['allowedRoots'];allowWrites:boolean;issuedAt:string;revokedAt:string|null;lastUsedAt:string|null}
export type ArcaneKeyIssue = ArcaneKeySummary & { apiKey: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Paths are display metadata: a rename is not a different opaque Instance.
// Both references still require valid bounded paths and exact scope/class/ID.
const sameReceiptRef = (a: unknown, b: unknown): boolean => {
  const x=instanceRef(a), y=instanceRef(b);
  return x.instanceId===y.instanceId && x.sessionId===y.sessionId && x.root===y.root && x.className===y.className;
};

/** Durable queue. Exactly-once outcomes cannot be promised across process/engine crashes.
 * Unknown outcomes are preserved for reconciliation, never automatically replayed. */
export class StudioStore {
  private db!: DatabaseSync;
  private lockPath: string;
  private lockFd: number;
  private now: () => number;
  private closed = false;
  // Only trusted host verification can mint this one-use authority. JSON claims
  // (including those in a restoration receipt) never authorize execution.
  #activationAdmissions = new WeakMap<object, ScriptSourceVerification>();
  #testOwners = new Map<string, string>();
  constructor(options: Options) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.directory, { recursive: true });
    this.lockPath = join(options.directory, 'studio.lock');
    if (existsSync(this.lockPath)) {
      let stale = false;
      try {
        const prior = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number };
        if (!Number.isInteger(prior.pid) || prior.pid < 1) throw new Error('Invalid lock');
        try { process.kill(prior.pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      } catch { /* Unknown lock state is not safe to remove automatically. */ }
      if (!stale) throw new ArcaneError('LOCKED', 'This workspace daemon is already running, or its lock needs manual inspection.');
      unlinkSync(this.lockPath);
    }
    try { this.lockFd = openSync(this.lockPath, 'wx', 0o600); }
    catch { throw new ArcaneError('LOCKED', 'Another daemon acquired this workspace.'); }
    writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, openedAt: this.iso() }));
    try {
      this.db = new DatabaseSync(join(options.directory, 'studio.sqlite'), { timeout: 2000, allowExtension: false });
      const version = this.db.prepare('PRAGMA user_version').get() as Row;
      if (Number(version.user_version) > 2) throw new ArcaneError('MIGRATION', 'Database is newer than this Arcane build; refusing to overwrite.');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS grants (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, token_hash TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), fingerprint TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS commands_session ON commands(session_id,created);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT;
        PRAGMA user_version=2;`);
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Row[];
      if (!columns.some(c=>c.name==='key_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN key_id TEXT');
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT payload FROM sessions').all() as Row[]) { const session=JSON.parse(row.payload as string) as StudioSession; if (!session.revokedAt) this.revoke(session.id, 'daemon_restart'); }
        this.db.prepare('DELETE FROM grants').run();
        this.event('daemon_started', 'local', { protocolVersion: STUDIO_PROTOCOL });
      });
    } catch (error) { try { this.db!.close(); } catch {} closeSync(this.lockFd); unlinkSync(this.lockPath); throw error; }
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(kind: string, entityId: string, detail: unknown): void {
    this.db.prepare('INSERT INTO events(occurred_at,kind,entity_id,detail) VALUES(?,?,?,?)').run(this.iso(), kind, entityId, JSON.stringify(detail));
  }
  private saveSession(s: StudioSession): void { this.db.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(s), s.id); }
  private saveCommand(c: StudioCommand): void { this.db.prepare('UPDATE commands SET state=?,payload=? WHERE id=?').run(c.state, JSON.stringify(c), c.id); }
  sessions(): StudioSession[] { return (this.db.prepare('SELECT payload FROM sessions ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => JSON.parse(r.payload as string) as StudioSession); }
  /** Host selection must inspect every live pairing, never a display-limited page. */
  activeSessions(): StudioSession[] {
    return (this.db.prepare("SELECT payload FROM sessions WHERE json_extract(payload,'$.revokedAt') IS NULL ORDER BY rowid DESC").all() as Row[])
      .map(row => JSON.parse(row.payload as string) as StudioSession);
  }
  session(id: string, live = true): StudioSession {
    const row = this.db.prepare('SELECT payload FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new ArcaneError('SESSION', 'Unknown Studio session.');
    const s = JSON.parse(row.payload as string) as StudioSession;
    if (live && s.revokedAt) throw new ArcaneError('REVOKED', 'Studio session has been revoked. Re-pair explicitly.');
    return s;
  }
  createGrant(input: unknown): PairingGrant {
    const a = object(input); const allowedRoots = roots(a.allowedRoots);
    if (typeof a.allowWrites !== 'boolean') throw new ArcaneError('INPUT', 'Explicit write permission flag required.');
    const code = randomBytes(12).toString('hex'); const expires = this.now() + 120000;
    const grant: PairingGrant = { code, allowedRoots, allowWrites: a.allowWrites, expiresAt: new Date(expires).toISOString(), protocolVersion: 1 };
    this.db.prepare('DELETE FROM grants WHERE expires<? OR used=1').run(this.now());
    if (Number((this.db.prepare('SELECT count(*) AS n FROM grants').get() as Row).n) > 32) throw new ArcaneError('BUSY', 'Too many active pairing grants. Wait for expiry.');
    this.db.prepare('INSERT INTO grants(hash,payload,expires) VALUES(?,?,?)').run(hash(code), JSON.stringify({ allowedRoots, allowWrites: a.allowWrites }), expires);
    this.event('pairing_granted', 'local', { allowedRoots, allowWrites: a.allowWrites }); return grant;
  }
  pair(input: unknown, apiKeyId: string | null = null): PairResult {
    const a = object(input); const code = textField(a.code, 'pairing code', 100);
    if (a.protocolVersion !== 1) throw new ArcaneError('PROTOCOL', 'Plugin protocol mismatch.');
    const identity = object(a.identity);
    const clientSessionId = textField(identity.clientSessionId, 'client session', 100);
    const name = textField(identity.name, 'Studio name', 200); const pluginVersion = textField(identity.pluginVersion, 'plugin version', 80);
    for (const f of ['placeId', 'universeId']) if (typeof identity[f] !== 'number' || !Number.isSafeInteger(identity[f]) || (identity[f] as number) < 0) throw new ArcaneError('IDENTITY', 'Invalid place/universe identity.');
    if (!Array.isArray(a.capabilities) || a.capabilities.length > 20 || a.capabilities.some(c => typeof c !== 'string')) throw new ArcaneError('CAPABILITY', 'Invalid plugin capabilities.');
    const capabilities = [...new Set(a.capabilities)].map(methodField);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grants WHERE hash=?').get(hash(code)) as Row | undefined;
      if (!row || row.used || Number(row.expires) <= this.now()) throw new ArcaneError('PAIRING', 'Pairing code is invalid, expired or already used.');
      const scope = JSON.parse(row.payload as string) as Pick<StudioSession, 'allowedRoots' | 'allowWrites'>;
      // One plugin lifetime cannot acquire overlapping identities without revoking the prior pairing.
      for (const oldRow of this.db.prepare('SELECT payload FROM sessions').all() as Row[]) {const old=JSON.parse(oldRow.payload as string) as StudioSession;if(old.clientSessionId===clientSessionId&&!old.revokedAt)this.revoke(old.id,'repaired');}
      if(Number((this.db.prepare("SELECT count(*) AS n FROM sessions WHERE json_extract(payload,'$.revokedAt') IS NULL").get() as Row).n)>=128)throw new ArcaneError('BUSY','Too many active Studio sessions; revoke an unused connection first.');
      const session: StudioSession = { id: randomUUID(), clientSessionId, placeId: identity.placeId as number, universeId: identity.universeId as number, name, pluginVersion, capabilities, ...scope, connectedAt: this.iso(), lastSeenAt: this.iso(), revokedAt: null, protocolVersion: 1 };
      const token = randomBytes(32).toString('hex');
      this.db.prepare('UPDATE grants SET used=1 WHERE hash=?').run(hash(code));
      this.db.prepare('INSERT INTO sessions(id,payload,token_hash,key_id) VALUES(?,?,?,?)').run(session.id, JSON.stringify(session), hash(token), apiKeyId);
      this.event('studio_paired', session.id, { clientSessionId, placeId: session.placeId, universeId: session.universeId, ...scope });
      return { sessionId: session.id, token, protocolVersion: 1, ...scope };
    });
  }
  keys(): ArcaneKeySummary[] {
    return (this.db.prepare("SELECT payload FROM api_keys ORDER BY (json_extract(payload,'$.revokedAt') IS NOT NULL),rowid DESC LIMIT 100").all() as Row[]).map(r=>JSON.parse(r.payload as string) as ArcaneKeySummary);
  }
  issueKey(input: unknown, port: number): ArcaneKeyIssue {
    return this.transaction(() => this.insertKey(input, port));
  }
  rotateKey(input: unknown, port: number): ArcaneKeyIssue {
    const a = object(input);
    if (Object.keys(a).length) throw new ArcaneError('INPUT', 'Key rotation requires an empty object.');
    return this.transaction(() => {
      // Do not use keys(): its display limit must never leave an old key active.
      const active = this.db.prepare("SELECT id FROM api_keys WHERE json_extract(payload,'$.revokedAt') IS NULL").all() as Row[];
      for (const row of active) this.revokeKeyInTransaction(row.id as string);
      // The plaintext replacement is returned only after the durable COMMIT.
      return this.insertKey({ allowedRoots: [...ROOTS], allowWrites: true }, port);
    });
  }
  private insertKey(input: unknown, port: number): ArcaneKeyIssue {
    const a=object(input); const allowedRoots=roots(a.allowedRoots);
    if(typeof a.allowWrites!=='boolean'||!Number.isInteger(port)||port<1||port>65535)throw new ArcaneError('INPUT','Explicit key grants and a valid local port are required.');
    if(Number((this.db.prepare("SELECT count(*) AS n FROM api_keys WHERE json_extract(payload,'$.revokedAt') IS NULL").get() as Row).n)>=32)throw new ArcaneError('BUSY','Revoke an unused key before issuing more than 32 active keys.');
    const key:ArcaneKeySummary={keyId:randomUUID(),allowedRoots,allowWrites:a.allowWrites,issuedAt:this.iso(),revokedAt:null,lastUsedAt:null};
    const apiKey='arcane_local_v1_'+port+'_'+randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO api_keys(id,hash,payload) VALUES(?,?,?)').run(key.keyId,hash(apiKey),JSON.stringify(key));
    this.event('arcane_key_issued',key.keyId,{allowedRoots,allowWrites:key.allowWrites});
    return {...key,apiKey};
  }
  revokeKey(keyId: string): void {
    this.transaction(() => this.revokeKeyInTransaction(keyId));
  }
  private revokeKeyInTransaction(keyId: string): void {
    const row=this.db.prepare('SELECT payload FROM api_keys WHERE id=?').get(keyId) as Row|undefined;
    if(!row)throw new ArcaneError('KEY','Unknown Arcane key.');
    const key=JSON.parse(row.payload as string) as ArcaneKeySummary;
    if(key.revokedAt)return;key.revokedAt=this.iso();this.db.prepare('UPDATE api_keys SET payload=? WHERE id=?').run(JSON.stringify(key),keyId);
    for(const r of this.db.prepare('SELECT id FROM sessions WHERE key_id=?').all(keyId) as Row[])this.revoke(r.id as string,'arcane_key_revoked');
    this.event('arcane_key_revoked',keyId,{});
  }
  connectWithKey(input: unknown, port: number): PairResult {
    const a=object(input); const apiKey=textField(a.apiKey,'Arcane API key',160);
    const match=/^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(apiKey);
    if(!match||Number(match[1])!==port||port>65535)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const row=this.db.prepare('SELECT id,payload FROM api_keys WHERE hash=?').get(hash(apiKey)) as Row|undefined;
    if(!row)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const key=JSON.parse(row.payload as string) as ArcaneKeySummary;
    if(key.revokedAt)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    // Synchronous exchange: no asynchronous gap in which a key revocation can race this grant.
    const grant=this.createGrant({allowedRoots:key.allowedRoots,allowWrites:key.allowWrites});
    const result=this.pair({code:grant.code,protocolVersion:a.protocolVersion,identity:a.identity,capabilities:a.capabilities},key.keyId);
    key.lastUsedAt=this.iso();this.db.prepare('UPDATE api_keys SET payload=? WHERE id=?').run(JSON.stringify(key),key.keyId);
    this.event('arcane_key_connected',key.keyId,{sessionId:result.sessionId});return result;
  }
  /** Key-authenticated metadata only. It cannot pair, renew a lease, return a
   * bearer, clear unknown effects or dispatch/replay a command. */
  connectionStatusWithKey(input:unknown,port:number): {protocolVersion:1;identity:Record<string,unknown>;state:'absent'|'active'|'lost'|'reconciliation';sessionId?:string} {
    const a=object(input);
    if(Object.keys(a).some(k=>!['protocolVersion','apiKey','identity','sessionId'].includes(k))||a.protocolVersion!==1)throw new ArcaneError('INPUT','Invalid plugin status envelope.');
    const apiKey=textField(a.apiKey,'Arcane API key',160),match=/^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(apiKey);
    if(!match||Number(match[1])!==port||port>65535)throw new ArcaneError('KEY_REJECTED','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const keyRow=this.db.prepare('SELECT id,payload FROM api_keys WHERE hash=?').get(hash(apiKey)) as Row|undefined;
    if(!keyRow||(JSON.parse(keyRow.payload as string) as ArcaneKeySummary).revokedAt)throw new ArcaneError('KEY_REJECTED','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const identity=object(a.identity),fields=['clientSessionId','placeId','universeId','name','pluginVersion'];
    if(Object.keys(identity).length!==fields.length||Object.keys(identity).some(k=>!fields.includes(k)))throw new ArcaneError('IDENTITY','Invalid exact plugin identity.');
    const clientSessionId=textField(identity.clientSessionId,'client session',100);
    textField(identity.name,'Studio name',200);textField(identity.pluginVersion,'plugin version',80);
    for(const k of ['placeId','universeId'])if(!Number.isSafeInteger(identity[k])||(identity[k] as number)<0)throw new ArcaneError('IDENTITY','Invalid place/universe identity.');
    const requested=a.sessionId===undefined?null:textField(a.sessionId,'session ID',256);
    const rows=this.db.prepare("SELECT id,payload FROM sessions WHERE key_id=? AND json_extract(payload,'$.clientSessionId')=? ORDER BY rowid DESC").all(keyRow.id as string,clientSessionId) as Row[];
    if(requested&&!rows.some(row=>row.id===requested))throw new ArcaneError('AUTH','Requested status is not owned by this key and client lifetime.');
    const scoped=rows.filter(row=>!requested||row.id===requested);
    for(const row of scoped){const s=JSON.parse(row.payload as string) as StudioSession;
      if(fields.some(k=>s[k as keyof StudioSession]!==identity[k]))throw new ArcaneError('IDENTITY','The recorded session has another exact place identity.');
    }
    const base={protocolVersion:1 as const,identity:{...identity}};
    if(!scoped.length)return {...base,state:'absent'};
    // Do not use the display-limited commands()/sessions() catalogues here.
    for(const row of scoped)if(this.#testOwners.has(row.id as string)||this.db.prepare("SELECT 1 FROM commands WHERE session_id=? AND state IN ('queued','dispatched','needs_reconciliation') LIMIT 1").get(row.id as string))return {...base,state:'reconciliation',sessionId:row.id as string};
    const active=scoped.find(row=>!(JSON.parse(row.payload as string) as StudioSession).revokedAt);
    if(active)return {...base,state:'active',sessionId:active.id as string};
    return {...base,state:'lost',sessionId:scoped[0]!.id as string};
  }
  authenticate(sessionId: string, token: string): StudioSession {
    const row = this.db.prepare('SELECT token_hash FROM sessions WHERE id=?').get(sessionId) as Row | undefined;
    if (!row || !equal(row.token_hash as string, hash(token))) throw new ArcaneError('AUTH', 'Invalid plugin session bearer.');
    return this.session(sessionId);
  }
  revoke(id: string, reason = 'user_revoked'): void {
    const s = this.session(id, false); if (s.revokedAt) return;
    s.revokedAt = this.iso(); this.saveSession(s);
    const active = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state IN ('queued','dispatched')").all(id) as Row[];
    for (const row of active) {
      const c = JSON.parse(row.payload as string) as StudioCommand;
      if (c.state === 'queued' || c.state === 'dispatched') {
        c.state = c.state === 'dispatched' ? 'needs_reconciliation' : 'cancelled';
        c.error = 'Session ended: ' + reason + '. No automatic replay.'; c.finishedAt = this.iso(); this.saveCommand(c);
      }
    }
    this.event('studio_revoked', id, { reason });
  }
  enqueue(input: unknown, internalRestore = false, admission?: object): StudioCommand {
    const a = object(input); const sessionId = textField(a.sessionId, 'session ID');
    const requestId = textField(a.requestId, 'request ID', 128);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new ArcaneError('INPUT', 'Request ID must be 8..128 safe characters.');
    const method = methodField(a.method);
    const fingerprint = hash(canonical({ sessionId, method, args: a.args }));
    return this.transaction(() => {
      const old = this.db.prepare('SELECT fingerprint,payload FROM commands WHERE request_id=?').get(requestId) as Row | undefined;
      if (old) {
        if (!equal(old.fingerprint as string, fingerprint)) throw new ArcaneError('IDEMPOTENCY', 'Request ID was already used with different input.');
        return JSON.parse(old.payload as string) as StudioCommand;
      }
      const s = this.session(sessionId);
      if (this.#testOwners.has(sessionId)) throw new ArcaneError('BUSY', 'An owned playtest fences the Studio command queue until verified cleanup.');
      const args = validateCommandArgs(method, a.args, s, internalRestore);
      const activating = this.activationSource(method, args);
      const verification = admission ? this.#activationAdmissions.get(admission) : undefined;
      if (activating !== null && (!verification || verification.sourceSha256 !== hash(activating)))
        throw new ArcaneError('SOURCE_VERIFICATION', 'Activating a script requires the trusted host syntax verifier. No command was queued.');
      if (admission) this.#activationAdmissions.delete(admission);
      const pending = this.db.prepare("SELECT count(*) AS n FROM commands WHERE session_id=? AND state IN ('queued','dispatched')").get(sessionId) as Row;
      if (Number(pending.n) >= 100) throw new ArcaneError('BUSY', 'Studio queue is full.');
      if (this.db.prepare("SELECT id FROM commands WHERE session_id=? AND state='needs_reconciliation' LIMIT 1").get(sessionId)) throw new ArcaneError('RECONCILIATION', 'Unknown previous outcome blocks new commands. Inspect receipts and re-pair; do not retry the mutation blindly.');
      const row = this.db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=? RETURNING epoch').get(sessionId) as Row;
      const c: StudioCommand = { protocolVersion: 1, id: randomUUID(), requestId, sessionId, clientSessionId: s.clientSessionId, method, args, allowedRoots: s.allowedRoots, allowWrites: s.allowWrites, leaseEpoch: Number(row.epoch), expiresAt: new Date(this.now() + 180000).toISOString(), state: 'queued', createdAt: this.iso(), finishedAt: null, result: null, error: null };
      this.db.prepare('INSERT INTO commands(id,request_id,session_id,fingerprint,state,payload,created) VALUES(?,?,?,?,?,?,?)').run(c.id, requestId, sessionId, fingerprint, c.state, JSON.stringify(c), this.now());
      if (verification) this.event('script_syntax_verified', c.id, { ...verification });
      this.event('command_queued', c.id, { sessionId, method, leaseEpoch: c.leaseEpoch }); return c;
    });
  }
  private activationSource(method: StudioCommand['method'], args: Record<string, Json>): string | null {
    if (method === 'script.set_enabled' && args.enabled === true) return args.expectedSource as string;
    if (method === 'scene.restore') {
      const mutation = object(args.mutation);
      if (mutation.kind === 'script.set_enabled' && object(mutation.before).enabled === true) {
        const source = object(mutation.before).source;
        if (typeof source !== 'string') throw new ArcaneError('RECEIPT', 'Activation restoration has no exact source baseline.');
        return source;
      }
    }
    return null;
  }
  /** Normal command entry point. Awaited compilation never holds a SQLite
   * transaction; caller authority and the exact session are fenced afterwards. */
  async enqueueVerified(input: unknown, verifier: ScriptSourceVerifier | null, guard: () => void = () => {}, internalRestore = false): Promise<StudioCommand> {
    guard();
    const a = jsonObject(input, 600 * 1024);
    const sessionId = textField(a.sessionId, 'session ID');
    const requestId = textField(a.requestId, 'request ID', 128);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new ArcaneError('INPUT', 'Request ID must be 8..128 safe characters.');
    const method = methodField(a.method);
    const fingerprint = hash(canonical({ sessionId, method, args: a.args }));
    const old = this.db.prepare('SELECT fingerprint,payload FROM commands WHERE request_id=?').get(requestId) as Row | undefined;
    if (old) {
      if (!equal(old.fingerprint as string, fingerprint)) throw new ArcaneError('IDEMPOTENCY', 'Request ID was already used with different input.');
      return JSON.parse(old.payload as string) as StudioCommand;
    }
    const session = this.session(sessionId);
    const args = validateCommandArgs(method, a.args, session, internalRestore);
    const source = this.activationSource(method, args);
    if (source === null) return this.enqueue(a, internalRestore);
    if (!verifier) throw new ArcaneError('SOURCE_VERIFICATION', 'The trusted Luau syntax verifier is unavailable. No script was activated.');
    const identity = (s: StudioSession) => canonical({id:s.id,clientSessionId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,allowedRoots:s.allowedRoots,allowWrites:s.allowWrites,capabilities:s.capabilities,pluginVersion:s.pluginVersion,revokedAt:s.revokedAt});
    let proof: ScriptSourceVerification;
    try { proof = await verifier.verify(source); }
    catch { throw new ArcaneError('SOURCE_VERIFICATION', 'Script syntax verification failed. Correct the source or repair the trusted compiler; no activation was queued.'); }
    guard();
    if (this.closed || identity(this.session(sessionId)) !== identity(session)) throw new ArcaneError('SCOPE', 'Studio authority changed during verification.');
    if (!proof || proof.syntaxVerified !== true || proof.sourceSha256 !== hash(source) || !/^[a-f0-9]{64}$/.test(proof.compilerSha256) || !Number.isFinite(proof.elapsedMs) || proof.elapsedMs < 0)
      throw new ArcaneError('SOURCE_VERIFICATION', 'The trusted verifier did not attest this exact source.');
    const admission = Object.freeze({});
    this.#activationAdmissions.set(admission, Object.freeze({...proof}));
    try { return this.enqueue(a, internalRestore, admission); }
    finally { this.#activationAdmissions.delete(admission); }
  }
  command(id: string): StudioCommand {
    const row = this.db.prepare('SELECT payload FROM commands WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new ArcaneError('COMMAND', 'Unknown command receipt.'); return JSON.parse(row.payload as string) as StudioCommand;
  }
  /** Host-only coordination, never a request-provided lock or permission. */
  reserveTest(sessionId: string, owner: string): void {
    const s=this.session(sessionId);if (!s.allowWrites) throw new ArcaneError('READ_ONLY','Playtesting requires a writable paired target and separate human test consent.');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner) || this.#testOwners.has(sessionId) || this.db.prepare("SELECT id FROM commands WHERE session_id=? AND state IN ('queued','dispatched','needs_reconciliation') LIMIT 1").get(sessionId)) throw new ArcaneError('BUSY','Finish or reconcile existing Studio work before starting a playtest.');
    this.#testOwners.set(sessionId,owner);
  }
  releaseTest(sessionId: string, owner: string): void { if (this.#testOwners.get(sessionId)===owner) this.#testOwners.delete(sessionId); }
  commands(sessionId?: string): StudioCommand[] {
    const q = sessionId ? this.db.prepare('SELECT payload FROM commands WHERE session_id=? ORDER BY created DESC,rowid DESC LIMIT 100').all(sessionId) : this.db.prepare('SELECT payload FROM commands ORDER BY created DESC,rowid DESC LIMIT 100').all();
    return (q as Row[]).map(r => JSON.parse(r.payload as string) as StudioCommand);
  }
  poll(sessionId: string, observation?: unknown): StudioCommand[] {
    return this.transaction(() => {
      const s = this.session(sessionId); s.lastSeenAt = this.iso(); this.saveSession(s);
      if (observation !== undefined) {
        if (!s.allowWrites || !s.allowedRoots.includes('ServerStorage')) throw new ArcaneError('SCOPE','A continuity marker requires explicit writable ServerStorage scope.');
        const p = jsonObject(observation, 4096);
        const fields = ['sessionId','clientLifetimeId','pluginArtifactHash','markerName','placeId','universeId','placeName','mode','playEpoch','continuitySupported','connected'];
        if (Object.keys(p).length !== fields.length || Object.keys(p).some(k=>!fields.includes(k)) || p.sessionId !== s.id || p.clientLifetimeId !== s.clientSessionId || p.placeId !== s.placeId || p.universeId !== s.universeId || p.placeName !== s.name || typeof p.pluginArtifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.pluginArtifactHash) || typeof p.markerName !== 'string' || !/^ArcaneTestProof_[A-Za-z0-9_-]{1,128}$/.test(p.markerName) || !['Edit','Play'].includes(p.mode as string) || !Number.isSafeInteger(p.playEpoch) || (p.playEpoch as number)<0 || typeof p.continuitySupported !== 'boolean' || typeof p.connected !== 'boolean') throw new ArcaneError('IDENTITY','Plugin continuity proof does not match this exact authenticated lifetime.');
        if (s.proof && (p.playEpoch as number)<s.proof.playEpoch) throw new ArcaneError('IDENTITY','Plugin play epoch moved backwards; inspect and reconnect.');
        if (s.proof && p.pluginArtifactHash !== s.proof.pluginArtifactHash) throw new ArcaneError('IDENTITY','Loaded plugin source changed inside this lifetime.');
        if (s.proof && (p.markerName !== s.proof.markerName || p.mode !== s.proof.mode && (p.playEpoch as number)<=s.proof.playEpoch)) throw new ArcaneError('IDENTITY','Marker or mode continuity changed without a latched play transition.');
        s.proof={sessionId:s.id,clientLifetimeId:s.clientSessionId,pluginArtifactHash:p.pluginArtifactHash,markerName:p.markerName,placeId:s.placeId,universeId:s.universeId,placeName:s.name,mode:p.mode as 'Edit'|'Play',playEpoch:p.playEpoch as number,continuitySupported:p.continuitySupported,connected:p.connected,observedAt:this.iso(),expiresAt:new Date(this.now()+6000).toISOString()};
        this.saveSession(s);
      }
      const active = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state IN ('dispatched','needs_reconciliation') ORDER BY created,rowid LIMIT 1").get(sessionId) as Row | undefined;
      if (active) {
        const c = JSON.parse(active.payload as string) as StudioCommand;
        if (c.state === 'dispatched' && Date.parse(c.expiresAt) <= this.now()) { c.state = 'needs_reconciliation'; c.error = 'Delivery expired with unknown engine outcome. No automatic replay.'; c.finishedAt = this.iso(); this.saveCommand(c); this.event('command_unknown', c.id, {}); }
        return [];
      }
      for (;;) {
        const row = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state='queued' ORDER BY created,rowid LIMIT 1").get(sessionId) as Row | undefined;
        if (!row) return [];
        const c = JSON.parse(row.payload as string) as StudioCommand;
        if (Date.parse(c.expiresAt) <= this.now()) { c.state = 'cancelled'; c.error = 'Undelivered command expired.'; c.finishedAt = this.iso(); this.saveCommand(c); continue; }
        c.state = 'dispatched'; this.saveCommand(c); this.event('command_dispatched', c.id, { sessionId }); return [c];
      }
    });
  }
  result(input: unknown): void {
    const a = object(input); const sessionId = textField(a.sessionId, 'session ID'); const commandId = textField(a.commandId, 'command ID');
    if (a.state !== 'succeeded' && a.state !== 'failed') throw new ArcaneError('INPUT', 'Invalid completion state.');
    const completedState = a.state;
    // The validation wrapper is exactly ten bytes; the actual result limit below
    // remains 512 KiB, including JSON escaping. It must not reject a legal ACK.
    const result = a.result === undefined ? null : jsonObject({ value: a.result }, 512 * 1024 + 10).value ?? null;
    const error = a.state === 'failed' ? textField(a.error ?? 'Plugin operation failed.', 'plugin error', 2000) : null;
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new ArcaneError('BODY_LIMIT', 'Plugin result exceeds 512 KiB.');
    this.transaction(() => {
      const c = this.command(commandId);
      if (c.sessionId !== sessionId) throw new ArcaneError('SCOPE', 'Receipt belongs to another Studio session.');
      if (['succeeded', 'failed'].includes(c.state)) {
        if (c.state !== a.state || canonical(c.result) !== canonical(result) || c.error !== error) throw new ArcaneError('RECEIPT_CONFLICT', 'Completed receipt is immutable.'); return;
      }
      if (c.state !== 'dispatched' && c.state !== 'needs_reconciliation') throw new ArcaneError('COMMAND_STATE', 'Command was not delivered.');
      if (a.state === 'succeeded' && isWrite(c.method) && c.method !== 'scene.restore') {
        const mutation = object(object(result).mutation, 'mutation receipt');
        if (mutation.kind !== c.method) throw new ArcaneError('RECEIPT', 'Mutation receipt kind mismatch.');
        const r = object(mutation.ref);
        if (r.sessionId !== sessionId || !c.allowedRoots.includes(r.root as StudioSession['allowedRoots'][number])) throw new ArcaneError('RECEIPT', 'Mutation receipt reference out of scope.');
        const after = jsonObject(mutation.after);
        if ((c.method === 'script.update' || c.method === 'scene.update') && !sameReceiptRef(mutation.ref, c.args.ref)) throw new ArcaneError('RECEIPT', 'Mutation receipt does not name the exact changed reference.');
        if (c.method === 'script.update' && (after.source !== c.args.source || object(mutation.before).source !== c.args.expectedSource)) throw new ArcaneError('RECEIPT', 'Script receipt does not match the intended baseline/change.');
        if (c.method === 'scene.update' && (!nativePropertiesMatch(object(c.args.properties) as Record<string, Json>, after.properties, r.className as string) || canonical(object(mutation.before).properties) !== canonical(c.args.expected))) throw new ArcaneError('RECEIPT', 'Property receipt does not match the intended change.');
        if (c.method === 'script.set_enabled' && (!sameReceiptRef(mutation.ref,c.args.ref) || canonical(mutation.before) !== canonical({ source:c.args.expectedSource,enabled:c.args.expectedEnabled }) || canonical(after) !== canonical({source:c.args.expectedSource,enabled:c.args.enabled}))) throw new ArcaneError('RECEIPT', 'Execution-state receipt does not match the exact source/state baseline.');
        if (c.method === 'scene.create' && mutation.before !== null) throw new ArcaneError('RECEIPT', 'Creation receipt must have a null baseline.');
      }
      c.state = completedState === 'failed' && result && typeof result === 'object' && !Array.isArray(result) && result.partial === true ? 'needs_reconciliation' : completedState;
      c.result = result; c.error = error; c.finishedAt = this.iso(); this.saveCommand(c);
      this.event('command_' + c.state, c.id, { sessionId, method: c.method });
    });
  }
  restore(input: unknown): StudioCommand {
    return this.enqueue(this.restoreInput(input), true);
  }
  async restoreVerified(input: unknown, verifier: ScriptSourceVerifier | null, guard: () => void = () => {}): Promise<StudioCommand> {
    return this.enqueueVerified(this.restoreInput(input), verifier, guard, true);
  }
  private restoreInput(input: unknown): Record<string, Json> {
    const a = object(input); const prior = this.command(textField(a.commandId, 'command ID'));
    if (prior.state !== 'succeeded' || !isWrite(prior.method) || prior.method === 'scene.restore') throw new ArcaneError('RESTORE', 'This receipt does not contain a succeeded reversible mutation.');
    const mutation = jsonObject(object(prior.result).mutation);
    return { sessionId: prior.sessionId, requestId: textField(a.requestId, 'request ID'), method: 'scene.restore', args: { receiptCommandId: prior.id, mutation } };
  }
  counts(): Record<string, number> { return Object.fromEntries((this.db.prepare('SELECT state,count(*) AS n FROM commands GROUP BY state').all() as Row[]).map(r => [r.state, Number(r.n)])); }
  events(limit = 100): Json[] { return (this.db.prepare('SELECT sequence,occurred_at,kind,entity_id,detail FROM events ORDER BY sequence DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))) as Row[]).map(r => ({ sequence: Number(r.sequence), occurredAt: r.occurred_at as string, kind: r.kind as string, entityId: r.entity_id as string, detail: JSON.parse(r.detail as string) as Json })); }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); closeSync(this.lockFd); unlinkSync(this.lockPath); } }
}
