import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import { ArcaneError } from '../../protocol/src/providers.js';
import { isWrite, instanceRef, jsonObject, methodField, object, roots, textField, ROOTS, STUDIO_PROTOCOL, type Json, type PairingGrant, type PairResult, type StudioCommand, type StudioSession } from '../../protocol/src/studio.js';
import { canonical, validateCommandArgs } from '../../core/src/studio-policy.js';
import { nativePropertiesMatch } from '../../core/src/native-property-outcomes.js';
import type { ScriptSourceVerifier, ScriptSourceVerification } from '../../core/src/script-source-verifier.js';
import type { StudioAssetStageArgs, StudioAssetStageReceipt } from '../../protocol/src/studio.js';
import type { NativeConversation } from './conversation-work-store.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface Options { directory: string; now?: () => number }
export interface ArcaneKeySummary {keyId:string;allowedRoots:StudioSession['allowedRoots'];allowWrites:boolean;issuedAt:string;revokedAt:string|null;lastUsedAt:string|null}
export type ArcaneKeyIssue = ArcaneKeySummary & { apiKey: string };
export interface AssetUploadIntent {
  projectId: string; jobId: string; sourceId: string; sourceSha256: string; assetType: 'Mesh' | 'Image';
  sessionId: string; clientLifetimeId: string; pluginArtifactHash: string; playEpoch: number;
  placeId: number; universeId: number; creator: {kind: 'user' | 'group'; id: number}; uploaderId: number;
  rightsGrantId: string; name: string; description: string;
}
export interface AssetUploadJournalRecord {
  attemptId: string; resourceKey: string; intent: AssetUploadIntent; intentSha256: string;
  state: 'intent' | 'succeeded' | 'needs_reconciliation'; assetId: number | null; createdAt: string; updatedAt: string;
}
/** Opaque host fact-recording handle. It is NOT permission to upload. */
export interface AssetUploadJournalTicket {readonly kind: 'asset-upload-journal-ticket'}
/** Original queue-time continuity facts, not upload permission or current proof. */
export interface AssetUploadContextPin {
  readonly sessionId:string;readonly clientLifetimeId:string;readonly pluginArtifactHash:string;
  readonly playEpoch:number;readonly placeId:number;readonly universeId:number;
}
export const STUDIO_STAGE_RUN_LIMITS = Object.freeze({packets:512,envelopeBytes:8*1024*1024,argumentBytes:256*1024,runs:64});
export interface StageRunHandle {readonly kind:'studio-stage-run-handle'}
export interface StageRunIntent {
  projectId:string;jobId:string;conversation:Readonly<NativeConversation>;
  transferDigest:string;payloadDigest:string;manifestDigest:string;preparedDigest:string;
  target:StudioAssetStageArgs['target'];continuity:StudioAssetStageArgs['continuity'];
  preparationAttemptId?:string;
  plan:readonly {ordinal:number;argsSha256:string;packetByteLength:number;envelopeByteLength:number;expectedReceipt:StudioAssetStageReceipt}[];
}
export interface StageRunCommandAssociation {
  ordinal:number;commandId:string;requestId:string;leaseEpoch:number;fingerprint:string;command:StudioCommand;
}
export interface StageRunRecord {
  attempt:number;previousRunId:string|null;
  runId:string;intent:StageRunIntent;intentSha256:string;createdAt:string;updatedAt:string;closedAt:string|null;
  phase:'running'|'cpu-staged'|'stopped'|'needs_reconciliation';
  commands:StageRunCommandAssociation[];receipt:StudioAssetStageReceipt|null;
}
export type StageRunBeginResult =
  | {created:true;runId:string;handle:StageRunHandle;record:StageRunRecord}
  | {created:false;runId:string;handle:null;record:StageRunRecord};
type StageRunStored = Omit<StageRunRecord,'phase'|'commands'|'receipt'|'attempt'|'previousRunId'>;
const stageHash=z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/);
const stageJob=z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const stageId=z.string().min(1).max(256).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const stageNumber=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uploadContextPinSchema=z.strictObject({sessionId:stageId,clientLifetimeId:stageId,pluginArtifactHash:stageHash,
  playEpoch:stageNumber,placeId:stageNumber,universeId:stageNumber});
const stageReceiptSchema=z.strictObject({transferDigest:stageHash,packetCount:z.number().int().min(1).max(512),
  byteLength:z.number().int().min(1).max(8*1024*1024),state:z.enum(['receiving','sealed']),engineVerification:z.literal('pending')});
const stageIntentSchema=z.strictObject({projectId:stageHash,jobId:stageJob,
  preparationAttemptId:stageJob.optional(),
  conversation:z.strictObject({provider:z.literal('codex'),threadId:stageId,sessionId:stageId.nullable()}),
  transferDigest:stageHash,payloadDigest:stageHash,manifestDigest:stageHash,preparedDigest:stageHash,
  target:z.strictObject({sessionId:stageId,placeId:stageNumber,universeId:stageNumber,root:z.literal('Workspace'),parentRef:stageId,
    creator:z.strictObject({kind:z.enum(['user','group']),id:z.string().regex(/^[1-9][0-9]{0,15}(?![\s\S])/).refine(v=>Number.isSafeInteger(Number(v)))})}),
  continuity:z.strictObject({clientLifetimeId:stageId,pluginArtifactHash:stageHash,playEpoch:stageNumber}),
  plan:z.array(z.strictObject({ordinal:z.number().int().min(0).max(511),argsSha256:stageHash,
    packetByteLength:z.number().int().min(1).max(256*1024),envelopeByteLength:z.number().int().min(1).max(256*1024),expectedReceipt:stageReceiptSchema})).min(1).max(512),
});
/** Reject accessors/proxies before serializing host facts; never invoke caller code. */
function stageSnapshot(value:unknown):unknown {
  let nodes=0;
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>20000||depth>12)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal exceeds its bounded structure.');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){if(Buffer.byteLength(v)>8*1024*1024)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage field exceeds its bound.');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v))throw new ArcaneError('STUDIO_STAGE_INPUT','Expected plain stage facts.');
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new ArcaneError('STUDIO_STAGE_INPUT','Expected plain stage facts.');
    const descriptors=Object.getOwnPropertyDescriptors(v),out:Record<string,unknown>={};
    if(keys.length>513)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage structure exceeds its bound.');
    for(const key of keys){
      if(array&&key==='length')continue;
      const d=typeof key==='string'?descriptors[key]:undefined;
      if(!d||!Object.hasOwn(d,'value')||!d.enumerable||key==='__proto__')throw new ArcaneError('STUDIO_STAGE_INPUT','Expected data-only stage facts.');
      out[key as string]=copy(d.value,depth+1);
    }
    if(array){if(keys.length!==(v as unknown[]).length+1||Object.keys(out).some((key,i)=>key!==String(i)))throw new ArcaneError('STUDIO_STAGE_INPUT','Expected dense stage arrays.');return Object.values(out);}
    return out;
  };
  return copy(value,0);
}
function stageIntent(value:unknown):StageRunIntent {
  const parsed=stageIntentSchema.safeParse(stageSnapshot(value));
  if(!parsed.success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid bounded stage intent.');
  const {preparationAttemptId,...rest}=parsed.data;
  const intent:StageRunIntent=preparationAttemptId===undefined?rest:{...rest,preparationAttemptId};let packets=0,envelopes=0;
  for(const [ordinal,p]of intent.plan.entries()){
    packets+=p.packetByteLength;envelopes+=p.envelopeByteLength;
    if(p.ordinal!==ordinal||p.envelopeByteLength<p.packetByteLength||p.expectedReceipt.transferDigest!==intent.transferDigest
      ||p.expectedReceipt.packetCount!==ordinal+1||p.expectedReceipt.byteLength!==packets
      ||p.expectedReceipt.state!==(ordinal===intent.plan.length-1?'sealed':'receiving'))throw new ArcaneError('STUDIO_STAGE_INPUT','Stage accounting is inconsistent.');
  }
  if(envelopes>STUDIO_STAGE_RUN_LIMITS.envelopeBytes)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage envelopes exceed 8 MiB.');
  return intent;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stageContinuityKey = (intent:StageRunIntent) => hash(canonical({sessionId:intent.target.sessionId,clientLifetimeId:intent.continuity.clientLifetimeId,playEpoch:intent.continuity.playEpoch}));
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
  #assetStageAdmissions = new WeakSet<object>();
  #uploadTickets = new WeakMap<object, string>();
  #stageRunHandles = new WeakMap<object,string>();
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
      if (Number(version.user_version) > 4) throw new ArcaneError('MIGRATION', 'Database is newer than this Arcane build; refusing to overwrite.');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS grants (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, token_hash TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), fingerprint TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS commands_session ON commands(session_id,created);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS asset_uploads (attempt_id TEXT PRIMARY KEY,resource_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS asset_upload_context_pins (command_id TEXT PRIMARY KEY REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS asset_stage_runs (run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,job_id TEXT NOT NULL,intent_sha256 TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(project_id,job_id)) STRICT;
        CREATE TABLE IF NOT EXISTS asset_stage_commands (run_id TEXT NOT NULL REFERENCES asset_stage_runs(run_id),ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<512),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_id,ordinal)) STRICT;
        CREATE TABLE IF NOT EXISTS asset_stage_attempts (run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,job_id TEXT NOT NULL,intent_sha256 TEXT NOT NULL,payload TEXT NOT NULL,attempt_no INTEGER NOT NULL CHECK(attempt_no>0),previous_run_id TEXT REFERENCES asset_stage_attempts(run_id),continuity_key TEXT NOT NULL,UNIQUE(project_id,job_id,attempt_no),UNIQUE(project_id,job_id,continuity_key)) STRICT;
        CREATE TABLE IF NOT EXISTS asset_stage_attempt_commands (run_id TEXT NOT NULL REFERENCES asset_stage_attempts(run_id),ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<512),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_id,ordinal)) STRICT;`);
      this.transaction(() => {
        if (Number(version.user_version) < 4) {
          const old = this.db.prepare('SELECT * FROM asset_stage_runs LIMIT 65').all() as Row[];
          if (old.length > STUDIO_STAGE_RUN_LIMITS.runs) throw new ArcaneError('STUDIO_STAGE_BUDGET','Retained stage history exceeds its cap.');
          for (const row of old) {
            const stored = JSON.parse(row.payload as string) as StageRunStored, intent = stageIntent(stored.intent);
            if (stored.runId !== row.run_id || intent.projectId !== row.project_id || intent.jobId !== row.job_id || stored.intentSha256 !== row.intent_sha256 || hash(canonical(intent)) !== stored.intentSha256) throw new ArcaneError('STUDIO_STAGE_RECEIPT','Legacy stage identity differs.');
            this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,1,NULL,?)').run(row.run_id!,row.project_id!,row.job_id!,row.intent_sha256!,row.payload!,stageContinuityKey(intent));
          }
          this.db.exec('INSERT INTO asset_stage_attempt_commands SELECT * FROM asset_stage_commands;');
        }
        this.db.exec('PRAGMA user_version=4;');
      });
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Row[];
      if (!columns.some(c=>c.name==='key_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN key_id TEXT');
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT payload FROM sessions').all() as Row[]) { const session=JSON.parse(row.payload as string) as StudioSession; if (!session.revokedAt) this.revoke(session.id, 'daemon_restart'); }
        this.db.prepare('DELETE FROM grants').run();
        for (const row of this.db.prepare('SELECT payload FROM asset_uploads').all() as Row[]) {
          const record = JSON.parse(row.payload as string) as AssetUploadJournalRecord;
          if (record.state === 'intent') {
            record.state = 'needs_reconciliation'; record.updatedAt = this.iso();
            this.db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(record), record.attemptId);
          }
        }
        for(const row of this.db.prepare('SELECT payload FROM asset_stage_attempts').all() as Row[]){
          const run=JSON.parse(row.payload as string) as StageRunStored;
          if(run.closedAt===null){run.closedAt=this.iso();run.updatedAt=run.closedAt;this.saveStageRun(run);}
        }
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
    // Before idempotent lookup: a model cannot read/reuse a host staging receipt
    // by guessing its request ID, even if its JSON is structurally identical.
    if (method === 'asset.stage_packet' && (!admission || !this.#assetStageAdmissions.has(admission))) throw new ArcaneError('ASSET_STAGE_AUTHORITY', 'Binary staging requires the trusted native import controller.');
    const fingerprint = hash(canonical({ sessionId, method, args: a.args }));
    return this.transaction(() => this.enqueueInTransaction(a,sessionId,requestId,method,fingerprint,internalRestore,admission));
  }
  /** Already inside a transaction. No callback, await or second commit here. */
  private enqueueInTransaction(a:ReturnType<typeof object>,sessionId:string,requestId:string,method:StudioCommand['method'],fingerprint:string,internalRestore:boolean,admission?:object):StudioCommand {
      if(method==='asset.stage_packet'&&(!admission||!this.#assetStageAdmissions.has(admission)))throw new ArcaneError('ASSET_STAGE_AUTHORITY','Binary staging requires trusted host admission.');
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
      if(method==='scene.upload_context'){
        const p=s.proof;
        // Missing/stale legacy proof remains a plain read; it gains no synthetic pin.
        if(p&&p.sessionId===s.id&&p.clientLifetimeId===s.clientSessionId&&p.placeId===s.placeId&&p.universeId===s.universeId
          &&p.mode==='Edit'&&p.connected&&p.continuitySupported&&Number.isFinite(Date.parse(p.observedAt))&&Date.parse(p.observedAt)<=this.now()
          &&Number.isFinite(Date.parse(p.expiresAt))&&Date.parse(p.expiresAt)>this.now()){
          const pin=uploadContextPinSchema.safeParse({sessionId:s.id,clientLifetimeId:p.clientLifetimeId,pluginArtifactHash:p.pluginArtifactHash,
            playEpoch:p.playEpoch,placeId:p.placeId,universeId:p.universeId});
          if(!pin.success)throw new ArcaneError('UPLOAD_CONTEXT_PIN','Actual upload context continuity is invalid.');
          this.db.prepare('INSERT INTO asset_upload_context_pins(command_id,request_id,lease_epoch,fingerprint,payload) VALUES(?,?,?,?,?)')
            .run(c.id,c.requestId,c.leaseEpoch,fingerprint,JSON.stringify(pin.data));
        }
      }
      if (verification) this.event('script_syntax_verified', c.id, { ...verification });
      this.event('command_queued', c.id, { sessionId, method, leaseEpoch: c.leaseEpoch }); return c;
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
    if(method==='asset.stage_packet')throw new ArcaneError('ASSET_STAGE_AUTHORITY','Asset intake requires private host admission, including idempotent lookup.');
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
  /** Durable intent before an irreversible engine call. Admission/rights are
   * checked by the trusted native controller, never inferred from these fields.
   * Only a FRESH insertion receives an opaque, process-owned outcome ticket. */
  beginAssetUpload(attemptId: string, value: AssetUploadIntent, guard: () => void): {fresh: boolean; record: AssetUploadJournalRecord; ticket: AssetUploadJournalTicket | null} {
    guard();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId)) throw new ArcaneError('INPUT', 'Expected a fixed upload attempt UUID.');
    const input = jsonObject(value, 8192);
    const fields = ['projectId', 'jobId', 'sourceId', 'sourceSha256', 'assetType', 'sessionId', 'clientLifetimeId', 'pluginArtifactHash', 'playEpoch', 'placeId', 'universeId', 'creator', 'uploaderId', 'rightsGrantId', 'name', 'description'];
    if (Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k))) throw new ArcaneError('INPUT', 'Expected exact upload intent fields.');
    for (const field of ['projectId', 'sourceSha256', 'pluginArtifactHash']) if (typeof input[field] !== 'string' || !/^[a-f0-9]{64}$/.test(input[field])) throw new ArcaneError('INPUT', 'Expected upload intent SHA-256 fields.');
    if (typeof input.jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.jobId)
      || input.assetType !== 'Mesh' && input.assetType !== 'Image') throw new ArcaneError('INPUT', 'Invalid upload job or resource type.');
    for (const field of ['sourceId', 'sessionId', 'clientLifetimeId', 'rightsGrantId']) textField(input[field], field, 256);
    textField(input.name, 'asset name', 100);
    if (typeof input.description !== 'string' || input.description.length > 1000 || input.description.includes('\0')) throw new ArcaneError('INPUT', 'Invalid asset description.');
    for (const field of ['placeId', 'universeId', 'playEpoch', 'uploaderId']) if (!Number.isSafeInteger(input[field]) || (input[field] as number) < (field === 'uploaderId' ? 1 : 0)) throw new ArcaneError('INPUT', 'Invalid upload identity.');
    const creator = object(input.creator);
    if (Object.keys(creator).length !== 2 || Object.keys(creator).some(k => !['kind', 'id'].includes(k)) || creator.kind !== 'user' && creator.kind !== 'group'
      || !Number.isSafeInteger(creator.id) || (creator.id as number) < 1) throw new ArcaneError('INPUT', 'Invalid observed upload creator.');
    // Detached snapshot before callback boundaries. Changing target/account
    // cannot hide an unknown prior upload of this same job/source resource.
    const intent = JSON.parse(JSON.stringify(input)) as AssetUploadIntent;
    const resourceKey = hash(canonical({projectId: intent.projectId, jobId: intent.jobId, sourceId: intent.sourceId, sourceSha256: intent.sourceSha256, assetType: intent.assetType}));
    const intentSha256 = hash(canonical(intent));
    let fresh = false;
    const record = this.transaction(() => {
      guard();
      const prior = this.db.prepare('SELECT payload FROM asset_uploads WHERE attempt_id=? OR resource_key=?').get(attemptId, resourceKey) as Row | undefined;
      if (prior) {
        const record = JSON.parse(prior.payload as string) as AssetUploadJournalRecord;
        if (record.attemptId !== attemptId || record.resourceKey !== resourceKey || record.intentSha256 !== intentSha256) throw new ArcaneError('UPLOAD_CONFLICT', 'This resource already has an upload outcome to inspect; do not create another attempt.');
        return record;
      }
      const time = this.iso();
      const record: AssetUploadJournalRecord = {attemptId, resourceKey, intent, intentSha256, state: 'intent', assetId: null, createdAt: time, updatedAt: time};
      this.db.prepare('INSERT INTO asset_uploads(attempt_id,resource_key,payload) VALUES(?,?,?)').run(attemptId, resourceKey, JSON.stringify(record));
      this.event('asset_upload_intent', attemptId, {resourceKey, intentSha256}); guard(); fresh = true; return record;
    });
    if (!fresh) return {fresh: false, record, ticket: null};
    const ticket = Object.freeze({kind: 'asset-upload-journal-ticket' as const}); this.#uploadTickets.set(ticket, attemptId);
    return {fresh: true, record, ticket};
  }
  /** Record only the outcome of a host-owned ticket. This logging may retain a
   * known asset ID after native authority retires; it authorizes no new effect. */
  finishAssetUpload(ticket: AssetUploadJournalTicket, outcome: {state: 'succeeded'; assetId: number} | {state: 'needs_reconciliation'; assetId: null}): AssetUploadJournalRecord {
    const attemptId = this.#uploadTickets.get(ticket);
    if (!attemptId) throw new ArcaneError('UPLOAD_TICKET', 'Upload outcome requires the original host-owned recording handle.');
    if (!outcome || Object.keys(outcome).length !== 2 || Object.keys(outcome).some(k => !['state', 'assetId'].includes(k))
      || !(outcome.state === 'succeeded' && Number.isSafeInteger(outcome.assetId) && outcome.assetId > 0 || outcome.state === 'needs_reconciliation' && outcome.assetId === null)) throw new ArcaneError('INPUT', 'Invalid observed upload outcome.');
    return this.transaction(() => {
      const record = this.assetUpload(attemptId);
      if (record.state !== 'intent') {
        if (record.state !== outcome.state || record.assetId !== outcome.assetId) throw new ArcaneError('UPLOAD_CONFLICT', 'Observed upload outcomes are immutable.');
        return record;
      }
      record.state = outcome.state; record.assetId = outcome.assetId; record.updatedAt = this.iso();
      this.db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(record), attemptId);
      this.event('asset_upload_' + outcome.state, attemptId, {assetId: record.assetId}); return record;
    });
  }
  assetUpload(attemptId: string): AssetUploadJournalRecord {
    const row = this.db.prepare('SELECT payload FROM asset_uploads WHERE attempt_id=?').get(attemptId) as Row | undefined;
    if (!row) throw new ArcaneError('UPLOAD_NOT_FOUND', 'Unknown upload attempt.');
    return JSON.parse(row.payload as string) as AssetUploadJournalRecord;
  }
  /** Detached historical pin. Never rebind it to a newer poll proof/epoch. */
  assetUploadContextPin(commandId:string):AssetUploadContextPin|null {
    if(this.closed||!stageJob.safeParse(commandId).success)throw new ArcaneError('UPLOAD_CONTEXT_PIN','Upload context pin lookup is unavailable or invalid.');
    const row=this.db.prepare('SELECT p.*,c.payload AS command_payload,c.session_id AS command_session_id,c.fingerprint AS command_fingerprint FROM asset_upload_context_pins p LEFT JOIN commands c ON c.id=p.command_id WHERE p.command_id=?').get(commandId) as Row|undefined;
    if(!row)return null;
    if(typeof row.payload!=='string'||Buffer.byteLength(row.payload)>2048||typeof row.command_payload!=='string')throw new ArcaneError('UPLOAD_CONTEXT_PIN','Original upload context command is unavailable.');
    let pin:AssetUploadContextPin,command:StudioCommand;
    try{pin=uploadContextPinSchema.parse(JSON.parse(row.payload));command=JSON.parse(row.command_payload) as StudioCommand;}
    catch{throw new ArcaneError('UPLOAD_CONTEXT_PIN','Stored upload context pin is invalid.');}
    const session=this.session(pin.sessionId,false);
    if(command.id!==commandId||command.method!=='scene.upload_context'||command.sessionId!==pin.sessionId||row.command_session_id!==pin.sessionId
      ||command.clientSessionId!==pin.clientLifetimeId||session.clientSessionId!==pin.clientLifetimeId||session.placeId!==pin.placeId||session.universeId!==pin.universeId
      ||command.requestId!==row.request_id||command.leaseEpoch!==row.lease_epoch||row.command_fingerprint!==row.fingerprint
      ||hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}))!==row.fingerprint
      ||!command.args||typeof command.args!=='object'||Array.isArray(command.args)||Reflect.ownKeys(command.args).length!==0)
      throw new ArcaneError('UPLOAD_CONTEXT_PIN','Pin does not name the original upload context role, session and lifetime.');
    return {...pin};
  }
  private saveStageRun(run:StageRunStored):void {
    this.db.prepare('UPDATE asset_stage_attempts SET payload=? WHERE run_id=?').run(JSON.stringify(run),run.runId);
  }
  private stageGuard(guard:()=>void):void {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(typeof guard!=='function'||types.isProxy(guard)||types.isAsyncFunction(guard)||types.isGeneratorFunction(guard))throw new ArcaneError('STUDIO_STAGE_GUARD','Expected a synchronous host scope guard.');
    const result:unknown=guard();
    // Never await inside a transaction. Observe an unexpected native Promise's
    // rejection, then refuse it; it cannot become deferred admission.
    if(types.isPromise(result))void Promise.prototype.then.call(result,()=>undefined,()=>undefined);
    if(result!==undefined)throw new ArcaneError('STUDIO_STAGE_GUARD','Expected a synchronous host scope guard.');
  }
  private stageTarget(intent:StageRunIntent):void {
    const session=this.session(intent.target.sessionId);
    validateCommandArgs('asset.stage_packet',{expected:{digest:intent.transferDigest,payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest},
      packet:JSON.stringify({formatVersion:1,ordinal:0,kind:'begin',payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest}),
      target:intent.target,continuity:intent.continuity},session);
    if(!session.proof||!Number.isFinite(Date.parse(session.proof.expiresAt))||Date.parse(session.proof.expiresAt)<=this.now())throw new ArcaneError('STUDIO_STAGE_SCOPE','Stage continuity has expired.');
  }
  /** Host-only facts. The trusted guard owns actual actor/job attribution. */
  beginStageRun(input:StageRunIntent,guard:()=>void):StageRunBeginResult {
    this.stageGuard(guard);const intent=stageIntent(input),intentSha256=hash(canonical(intent));
    let fresh=false;
    const record=this.transaction(()=>{
      this.stageGuard(guard);
      const prior=this.readStageRun(intent.projectId,intent.jobId);
      if(prior){if(prior.intentSha256!==intentSha256)throw new ArcaneError('STUDIO_STAGE_CONFLICT','This job already has a pinned stage run.');return prior;}
      this.stageTarget(intent);
      if(Number((this.db.prepare('SELECT count(*) AS n FROM asset_stage_attempts').get() as Row).n)>=STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal capacity is full; no history was evicted.');
      const at=this.iso(),run:StageRunStored={runId:randomUUID(),intent,intentSha256,createdAt:at,updatedAt:at,closedAt:null};
      this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,1,NULL,?)').run(run.runId,intent.projectId,intent.jobId,intentSha256,JSON.stringify(run),stageContinuityKey(intent));
      this.event('asset_stage_started',run.runId,{projectId:intent.projectId,jobId:intent.jobId});this.stageGuard(guard);fresh=true;
      return this.stageRunById(run.runId);
    });
    if(!fresh)return {created:false,runId:record.runId,handle:null,record};
    const handle=Object.freeze({kind:'studio-stage-run-handle' as const});this.#stageRunHandles.set(handle,record.runId);
    return {created:true,runId:record.runId,handle,record};
  }
  /** A new CPU attempt, never a replay of old command or upload authority. */
  beginStageAttempt(input:StageRunIntent,previousRunId:string,guard:()=>void):StageRunBeginResult {
    this.stageGuard(guard);const intent=stageIntent(input),intentSha256=hash(canonical(intent));
    if(!stageJob.safeParse(previousRunId).success||!intent.preparationAttemptId)throw new ArcaneError('STUDIO_STAGE_INPUT','A fresh witnessed preparation attempt is required.');
    const record=this.transaction(()=>{
      this.stageGuard(guard);this.stageTarget(intent);
      const prior=this.readStageRun(intent.projectId,intent.jobId);
      if(!prior||prior.runId!==previousRunId||prior.closedAt===null)throw new ArcaneError('STUDIO_STAGE_STATE','The exact preceding attempt must be closed.');
      if(canonical(prior.intent.conversation)!==canonical(intent.conversation))throw new ArcaneError('STUDIO_STAGE_CONFLICT','Native conversation changed.');
      if(prior.intent.target.sessionId===intent.target.sessionId&&prior.intent.continuity.clientLifetimeId===intent.continuity.clientLifetimeId&&intent.continuity.playEpoch<=prior.intent.continuity.playEpoch)throw new ArcaneError('STUDIO_STAGE_EXISTS','This live continuity cannot repeat its attempt.');
      for(const row of this.db.prepare('SELECT payload FROM asset_stage_attempts WHERE project_id=? AND job_id=? LIMIT 65').iterate(intent.projectId,intent.jobId)){
        const old=JSON.parse(row.payload as string) as StageRunStored;
        if(old.intent.preparationAttemptId===intent.preparationAttemptId)throw new ArcaneError('STUDIO_STAGE_CONFLICT','A historical preparation cannot be upgraded into a new attempt.');
      }
      if(this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? AND continuity_key=?').get(intent.projectId,intent.jobId,stageContinuityKey(intent)))throw new ArcaneError('STUDIO_STAGE_EXISTS','This continuity already has retained evidence.');
      if(Number((this.db.prepare('SELECT count(*) AS n FROM asset_stage_attempts').get() as Row).n)>=STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal capacity is full; no history was evicted.');
      const at=this.iso(),run:StageRunStored={runId:randomUUID(),intent,intentSha256,createdAt:at,updatedAt:at,closedAt:null};
      this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,?,?,?)').run(run.runId,intent.projectId,intent.jobId,intentSha256,JSON.stringify(run),prior.attempt+1,prior.runId,stageContinuityKey(intent));
      this.event('asset_stage_started',run.runId,{projectId:intent.projectId,jobId:intent.jobId,previousRunId:prior.runId});this.stageGuard(guard);
      return this.stageRunById(run.runId);
    });
    const handle=Object.freeze({kind:'studio-stage-run-handle' as const});this.#stageRunHandles.set(handle,record.runId);
    return {created:true,runId:record.runId,handle,record};
  }
  private stageHandle(handle:StageRunHandle):string {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    const id=handle&&typeof handle==='object'?this.#stageRunHandles.get(handle):undefined;
    if(!id)throw new ArcaneError('STUDIO_STAGE_HANDLE','Stage entry requires the original process-owned handle.');return id;
  }
  enqueueStagePacket(handle:StageRunHandle,ordinal:number,input:StudioAssetStageArgs,guard:()=>void):StudioCommand {
    const runId=this.stageHandle(handle);this.stageGuard(guard);
    const args=stageSnapshot(input) as unknown as StudioAssetStageArgs,text=JSON.stringify(args);
    if(Buffer.byteLength(text)>STUDIO_STAGE_RUN_LIMITS.argumentBytes)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage arguments exceed 256 KiB.');
    const admission=Object.freeze({});this.#assetStageAdmissions.add(admission);
    try{return this.transaction(()=>{
      this.stageGuard(guard);const run=this.stageRunById(runId),intent=run.intent,plan=intent.plan[ordinal];
      if(run.closedAt!==null||!Number.isInteger(ordinal)||!plan||plan.ordinal!==ordinal)throw new ArcaneError('STUDIO_STAGE_STATE','Stage run is closed or ordinal is invalid.');
      this.stageTarget(intent);
      if(hash(text)!==plan.argsSha256||Buffer.byteLength(text)!==plan.envelopeByteLength
        ||canonical(args.target)!==canonical(intent.target)||canonical(args.continuity)!==canonical(intent.continuity)
        ||canonical(args.expected)!==canonical({digest:intent.transferDigest,payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest})
        ||typeof args.packet!=='string'||Buffer.byteLength(args.packet)!==plan.packetByteLength)throw new ArcaneError('STUDIO_STAGE_CONFLICT','Stage arguments differ from the pinned plan.');
      const packet=object(JSON.parse(args.packet));
      if(packet.ordinal!==ordinal||plan.expectedReceipt.state!==(packet.kind==='seal'?'sealed':'receiving'))throw new ArcaneError('STUDIO_STAGE_CONFLICT','Stage packet accounting differs from its plan.');
      const associated=run.commands.find(c=>c.ordinal===ordinal);
      if(associated)return associated.command; // Exact original command only; never replay.
      if(run.phase==='needs_reconciliation'||ordinal!==run.commands.length||run.commands.some(c=>c.command.state!=='succeeded'))throw new ArcaneError('STUDIO_STAGE_STATE','Finish the preceding original packet before enqueueing the next.');
      const requestId='assetstage_'+hash(canonical({runId,ordinal,intentSha256:run.intentSha256}));
      if(this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId))throw new ArcaneError('STUDIO_STAGE_CONFLICT','An unassociated command cannot be adopted.');
      const sessionId=intent.target.sessionId,method='asset.stage_packet' as const,a=object({sessionId,requestId,method,args});
      const fingerprint=hash(canonical({sessionId,method,args}));
      const command=this.enqueueInTransaction(a,sessionId,requestId,method,fingerprint,false,admission);
      this.db.prepare('INSERT INTO asset_stage_attempt_commands(run_id,ordinal,command_id,request_id,lease_epoch,fingerprint) VALUES(?,?,?,?,?,?)').run(runId,ordinal,command.id,command.requestId,command.leaseEpoch,fingerprint);
      const stored:StageRunStored={runId,intent,intentSha256:run.intentSha256,createdAt:run.createdAt,updatedAt:this.iso(),closedAt:null};this.saveStageRun(stored);
      this.stageGuard(guard);return command;
    });}finally{this.#assetStageAdmissions.delete(admission);}
  }
  /** Outcome recording survives actor retirement; this handle permits no new effect. */
  closeStageRun(handle:StageRunHandle):StageRunRecord {
    const runId=this.stageHandle(handle);
    return this.transaction(()=>{
      const run=this.stageRunById(runId);
      if(run.closedAt===null){
        for(const {command}of run.commands){
          if(command.state!=='queued'&&command.state!=='dispatched')continue;
          command.state=command.state==='queued'?'cancelled':'needs_reconciliation';command.error='Native stage run stopped. No automatic replay.';
          command.finishedAt=this.iso();this.saveCommand(command);this.event('command_'+command.state,command.id,{sessionId:command.sessionId,method:command.method});
        }
        const at=this.iso();this.saveStageRun({runId,intent:run.intent,intentSha256:run.intentSha256,createdAt:run.createdAt,updatedAt:at,closedAt:at});
      }
      return this.stageRunById(runId);
    });
  }
  /** Local historical evidence only. Caller scope must be checked by the host. */
  readStageRun(projectId:string,jobId:string,runId?:string):StageRunRecord|null {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(!stageHash.safeParse(projectId).success||!stageJob.safeParse(jobId).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid stage lookup.');
    if(runId!==undefined&&!stageJob.safeParse(runId).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid run identity.');
    const row=(runId===undefined?this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(projectId,jobId)
      :this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? AND run_id=?').get(projectId,jobId,runId)) as Row|undefined;
    return row?this.stageRunById(row.run_id as string):null;
  }
  private stageRunById(runId:string):StageRunRecord {
    const row=this.db.prepare('SELECT * FROM asset_stage_attempts WHERE run_id=?').get(runId) as Row|undefined;
    if(!row)throw new ArcaneError('STUDIO_STAGE_NOT_FOUND','Unknown stage run.');
    const run=JSON.parse(row.payload as string) as StageRunStored,intent=stageIntent(run.intent);
    if(run.runId!==runId||intent.projectId!==row.project_id||intent.jobId!==row.job_id||run.intentSha256!==row.intent_sha256||hash(canonical(intent))!==run.intentSha256)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage journal identity differs.');
    if(!Number.isSafeInteger(row.attempt_no)||Number(row.attempt_no)<1||Number(row.attempt_no)>64||row.continuity_key!==stageContinuityKey(intent)
      ||(row.attempt_no===1?row.previous_run_id!==null:typeof row.previous_run_id!=='string'||!stageJob.safeParse(row.previous_run_id).success
        ||!this.db.prepare('SELECT 1 FROM asset_stage_attempts WHERE run_id=? AND project_id=? AND job_id=? AND attempt_no=?').get(row.previous_run_id,intent.projectId,intent.jobId,Number(row.attempt_no)-1)))throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage attempt metadata differs.');
    const rows=this.db.prepare('SELECT * FROM asset_stage_attempt_commands WHERE run_id=? ORDER BY ordinal LIMIT 513').all(runId) as Row[];
    if(rows.length>intent.plan.length)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage association exceeds its plan.');
    let invalidReceipt=false;
    const commands:StageRunCommandAssociation[]=rows.map((member,ordinal)=>{
      const command=this.command(member.command_id as string),plan=intent.plan[ordinal]!;
      const original=this.db.prepare('SELECT fingerprint,state FROM commands WHERE id=?').get(command.id) as Row;
      const fingerprint=hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}));
      if(member.ordinal!==ordinal||command.id!==member.command_id||command.requestId!==member.request_id||command.leaseEpoch!==member.lease_epoch
        ||command.method!=='asset.stage_packet'||command.sessionId!==intent.target.sessionId||command.clientSessionId!==intent.continuity.clientLifetimeId
        ||fingerprint!==member.fingerprint||original.fingerprint!==member.fingerprint||original.state!==command.state||hash(JSON.stringify(command.args))!==plan.argsSha256)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original stage command differs from the pinned association.');
      if(command.state==='succeeded'&&canonical(command.result)!==canonical(plan.expectedReceipt))invalidReceipt=true;
      return {ordinal,commandId:command.id,requestId:command.requestId,leaseEpoch:command.leaseEpoch,fingerprint,command};
    });
    const complete=!invalidReceipt&&commands.length===intent.plan.length&&commands.every(c=>c.command.state==='succeeded');
    const unresolved=invalidReceipt||commands.some(c=>c.command.state==='needs_reconciliation'||run.closedAt!==null&&(c.command.state==='dispatched'||c.command.state==='succeeded'));
    const phase=complete?'cpu-staged':unresolved?'needs_reconciliation':run.closedAt!==null||commands.some(c=>['failed','cancelled'].includes(c.command.state))?'stopped':'running';
    return {...run,intent,attempt:Number(row.attempt_no),previousRunId:row.previous_run_id as string|null,phase,commands,receipt:complete?structuredClone(intent.plan.at(-1)!.expectedReceipt):null};
  }
  /** Host-only queue entry. Routes and generic MCP commands use enqueue(), which
   * cannot mint this capability. The controller owns SAME-actor/job checks. */
  enqueueAssetStage(input: unknown, guard: () => void): StudioCommand {
    guard();
    const a = object(input);
    if (a.method !== 'asset.stage_packet') throw new ArcaneError('METHOD', 'Expected the fixed asset staging method.');
    const admission = Object.freeze({}); this.#assetStageAdmissions.add(admission);
    try { return this.enqueue(a, false, admission); }
    finally { this.#assetStageAdmissions.delete(admission); }
  }
  /** Retiring a native caller never replays a delivered packet. Preserve unknown
   * plugin outcomes; a queued packet can be cancelled before delivery. */
  abandonAssetStage(commandId: string): void {
    this.transaction(() => {
      const command = this.command(commandId);
      if (command.method !== 'asset.stage_packet') throw new ArcaneError('METHOD', 'Expected an owned asset staging receipt.');
      if (command.state !== 'queued' && command.state !== 'dispatched') return;
      command.state = command.state === 'queued' ? 'cancelled' : 'needs_reconciliation';
      command.error = 'Native asset staging stopped. No automatic replay.';
      command.finishedAt = this.iso(); this.saveCommand(command);
      this.event('command_' + command.state, command.id, {sessionId: command.sessionId, method: command.method});
    });
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
      if (a.state === 'succeeded' && c.method === 'asset.stage_packet') {
        const receipt = object(result), packet = object(JSON.parse(c.args.packet as string));
        if (Object.keys(receipt).length !== 5 || Object.keys(receipt).some(k => !['transferDigest', 'packetCount', 'byteLength', 'state', 'engineVerification'].includes(k))
          || receipt.transferDigest !== object(c.args.expected).digest || receipt.packetCount !== Number(packet.ordinal) + 1
          || !Number.isSafeInteger(receipt.byteLength) || (receipt.byteLength as number) < Buffer.byteLength(c.args.packet as string) || (receipt.byteLength as number) > 48 * 1024 * 1024
          || receipt.state !== (packet.kind === 'seal' ? 'sealed' : 'receiving') || receipt.engineVerification !== 'pending') throw new ArcaneError('RECEIPT', 'Asset staging receipt differs from its exact packet.');
      }
      if (a.state === 'succeeded' && isWrite(c.method) && c.method !== 'scene.restore' && c.method !== 'asset.stage_packet') {
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
    if (prior.state !== 'succeeded' || !isWrite(prior.method) || prior.method === 'scene.restore' || prior.method === 'asset.stage_packet') throw new ArcaneError('RESTORE', 'This receipt does not contain a succeeded reversible mutation.');
    const mutation = jsonObject(object(prior.result).mutation);
    return { sessionId: prior.sessionId, requestId: textField(a.requestId, 'request ID'), method: 'scene.restore', args: { receiptCommandId: prior.id, mutation } };
  }
  counts(): Record<string, number> { return Object.fromEntries((this.db.prepare('SELECT state,count(*) AS n FROM commands GROUP BY state').all() as Row[]).map(r => [r.state, Number(r.n)])); }
  events(limit = 100): Json[] { return (this.db.prepare('SELECT sequence,occurred_at,kind,entity_id,detail FROM events ORDER BY sequence DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))) as Row[]).map(r => ({ sequence: Number(r.sequence), occurredAt: r.occurred_at as string, kind: r.kind as string, entityId: r.entity_id as string, detail: JSON.parse(r.detail as string) as Json })); }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); closeSync(this.lockFd); unlinkSync(this.lockPath); } }
}
