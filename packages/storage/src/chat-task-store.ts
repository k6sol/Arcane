import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, realpathSync, openSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { z } from 'zod';
import { sqliteTransportPath } from './sqlite-path.js';
import { workflowProjectIdentity } from './workflow-store.js';
import type { StudioTestTaskPrepared, StudioTestTaskSettled } from '../../protocol/src/chat-task-playtest.js';

export type ChatTaskState = 'working' | 'awaiting_verification' | 'repair_queued' | 'repairing' |
  'verified' | 'failed' | 'cancelled' | 'paused' | 'unknown';
export interface ChatTaskRecord {
  id: string; projectId: string; projectPath: string;
  provider: 'codex'; threadId: string; sessionId: string | null;
  connectionId: string; incarnationId: string; model: string; effort: string;
  allowWorkspaceWrites: boolean; allowAssets: boolean;
  state: ChatTaskState; revision: number; round: 0 | 1;
  operationId: string | null; turnId: string | null; nativeSettled: boolean; acknowledged: boolean;
  repairDispatch: 'not_requested' | 'reserved' | 'acknowledged' | 'unknown';
  prepared: StudioTestTaskPrepared | null; evidence: StudioTestTaskSettled[];
  reason: string | null; createdAt: string; updatedAt: string;
}
export type ChatTaskSummary = Pick<ChatTaskRecord, 'id'|'threadId'|'sessionId'|'connectionId'|'state'|'round'|'reason'> & { reportDigest: string | null };
const id = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const prepared = z.strictObject({ jobId: id, displayDigest: hash, scenarioDigest: hash.nullable(), subjectDigest: hash.nullable() });
const record = z.strictObject({
  id: z.string().uuid(), projectId: hash, projectPath: z.string().min(1).max(4096),
  provider: z.literal('codex'), threadId: id, sessionId: id.nullable(), connectionId: z.string().uuid(), incarnationId: z.string().uuid(),
  model: id, effort: id, allowWorkspaceWrites: z.boolean(), allowAssets: z.boolean(),
  state: z.enum(['working','awaiting_verification','repair_queued','repairing','verified','failed','cancelled','paused','unknown']),
  revision: z.number().int().min(0).max(65535), round: z.union([z.literal(0),z.literal(1)]),
  operationId: id.nullable(), turnId: id.nullable(), nativeSettled: z.boolean(), acknowledged: z.boolean(),
  repairDispatch: z.enum(['not_requested','reserved','acknowledged','unknown']), prepared: prepared.nullable(),
  evidence: z.array(z.unknown()).max(2), reason: z.string().max(256).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
const ACTIVE = new Set<ChatTaskState>(['working','awaiting_verification','repair_queued','repairing']);
const APP_ID=0x41524354;
const TABLES_V1=[
  'CREATE TABLE chat_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=524288)) STRICT',
  'CREATE TABLE chat_task_meta(id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT',
  'CREATE TABLE chat_task_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL) STRICT',
];
const PROPOSALS_DDL='CREATE TABLE chat_task_proposals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=98304)) STRICT';
const TABLES=[...TABLES_V1,PROPOSALS_DDL];
const VERSION=2;

/** Display-only proposal attempts (never acceptance, effects or a parent continuation). */
export const CHAT_TASK_PROPOSAL_LIMITS=Object.freeze({perTask:8,total:1024,promptBytes:16384,textBytes:64*1024,payloadBytes:98304});
/** A valid result whose escaped serialized record exceeds the stored bound; never truncated or substituted. */
export class ChatTaskProposalLimitError extends Error{constructor(){super('Task proposal record exceeds its serialized bound.');this.name='ChatTaskProposalLimitError';}}
export type ChatTaskProposalState='reserved'|'proposed'|'failed'|'unknown';
export const CHAT_TASK_PROPOSAL_REASONS=Object.freeze(['worker_unavailable','worker_failed_before_dispatch','dispatch_uncertain','parent_retired','output_rejected',
  'worker_close_unconfirmed','daemon_restarted_no_replay','journal_failure'] as const);
export type ChatTaskProposalReason=typeof CHAT_TASK_PROPOSAL_REASONS[number];
export interface ChatTaskProposalResult{readonly threadId:string;readonly sessionId:string|null;readonly turnId:string;readonly text:string;readonly textSha256:string;readonly textBytes:number}
export interface ChatTaskProposalRecord{
  readonly id:string;readonly taskId:string;readonly requestId:string;readonly promptSha256:string;readonly promptBytes:number;
  readonly state:ChatTaskProposalState;readonly reason:ChatTaskProposalReason|null;readonly result:ChatTaskProposalResult|null;
  readonly createdAt:string;readonly updatedAt:string;
}
const wellFormed=(value:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const proposalResult=z.strictObject({threadId:id,sessionId:id.nullable(),turnId:id,text:z.string().min(1),textSha256:hash,textBytes:z.number().int().min(1).max(CHAT_TASK_PROPOSAL_LIMITS.textBytes)})
  .refine(r=>wellFormed(r.text)&&Buffer.byteLength(r.text)===r.textBytes&&createHash('sha256').update(r.text).digest('hex')===r.textSha256);
const proposalRecord=z.strictObject({id:z.string().uuid(),taskId:z.string().uuid(),requestId:z.string().uuid(),promptSha256:hash,
  promptBytes:z.number().int().min(1).max(CHAT_TASK_PROPOSAL_LIMITS.promptBytes),state:z.enum(['reserved','proposed','failed','unknown']),
  reason:z.enum(CHAT_TASK_PROPOSAL_REASONS).nullable(),result:proposalResult.nullable(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()})
  .refine(r=>r.state==='proposed'?r.result!==null&&r.reason===null:r.result===null&&(r.state==='reserved'?r.reason===null:r.reason!==null));
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function directDirectories(path:string,missing=false):void{
  for(let current=path;;current=dirname(current)){
    try{const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(realpathSync(current),current))throw new Error('Task state directories must be direct.');}
    catch(error){if(!missing||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(current===dirname(current))return;
  }
}
function live(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}}
export class ChatTaskStore {
  readonly projectId: string; readonly projectPath: string;
  readonly #db: DatabaseSync;
  readonly #directory:string;readonly #filename:string;readonly #owner=randomUUID();
  readonly #fileIdentity:{dev:number;ino:number};
  #closed = false;
  readonly #summaries = new Map<string, ChatTaskSummary>();
  constructor(options: { directory: string; projectPath: string }) {
    const project = workflowProjectIdentity(options.projectPath);
    this.projectId = project.projectId; this.projectPath = project.projectPath;
    if (!isAbsolute(options.directory)||options.directory.length>4096||/[\x00-\x1f\x7f]/.test(options.directory)||/^(?:\\\\|\/\/)/.test(options.directory)||options.directory.split(/[\\/]/).some(part=>part==='.'||part==='..')) throw new Error('Task state directory must be a direct absolute local path.');
    const directory = resolve(options.directory);
    if(directory===parse(directory).root)throw new Error('Task state directory cannot be a filesystem root.');
    directDirectories(directory,true);directDirectories(project.projectPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#directory=realpathSync(directory);this.#filename=join(this.#directory,'chat-tasks.sqlite');this.#paths();
    try{const fd=openSync(this.#filename,'wx',0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    this.#paths();const stat=lstatSync(this.#filename);this.#fileIdentity={dev:stat.dev,ino:stat.ino};
    this.#db = new DatabaseSync(sqliteTransportPath(this.#filename), { timeout: 2000, allowExtension: false });let claimed=false;
    try {
      const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > VERSION) throw new Error('Task journal is newer than this build.');
      if(version!==0&&version!==1&&version!==VERSION)throw new Error('Invalid task journal version.');
      if(this.#db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Task journal integrity failed.');
      if(version===0){
        if(this.#db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()||this.#db.prepare('PRAGMA application_id').get()?.application_id!==0)throw new Error('Unversioned task journal is not empty.');
        this.#db.exec('BEGIN IMMEDIATE');try{for(const ddl of TABLES)this.#db.exec(ddl);this.#db.prepare('INSERT INTO chat_task_meta VALUES(1,?,?)').run(this.projectId,this.projectPath);this.#db.exec(`PRAGMA application_id=${APP_ID};PRAGMA user_version=${VERSION};COMMIT;`);}catch(error){this.#db.exec('ROLLBACK');throw error;}
      }
      // Validate the EXACT existing schema, application and project before any ownership claim or migration.
      const schemaFor=(expected:readonly string[])=>{
        const schema=this.#db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
        if(this.#db.prepare('PRAGMA application_id').get()?.application_id!==APP_ID||schema.length!==expected.length||schema.some(row=>!expected.includes(String(row.sql))))throw new Error('Task journal schema or project changed.');
        const meta=this.#db.prepare('SELECT project_id,project_path FROM chat_task_meta WHERE id=1').get();
        if(meta?.project_id!==this.projectId||meta.project_path!==this.projectPath)throw new Error('Task journal schema or project changed.');
      };
      const current=Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      schemaFor(current===1?TABLES_V1:TABLES);
      // Every refusal below is read-only and precedes the first write (including the WAL header switch).
      const taskRows=()=>{
        const rows=this.#db.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid LIMIT 257').all() as {id:string;payload:string}[];
        if(rows.length>256)throw new Error('Task journal retention exceeded.');
        for(const row of rows){let value:unknown;try{value=JSON.parse(row.payload);}catch{throw new Error('Task journal is corrupt.');}if(this.#parse(value).id!==row.id)throw new Error('Task journal is corrupt.');}
      };
      taskRows();if(current===VERSION)this.#allProposals();
      const prior=this.#db.prepare('SELECT pid FROM chat_task_owner WHERE id=1').get();
      if(prior&&live(Number(prior.pid)))throw new Error('Task journal already has a live owner.');
      this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;PRAGMA journal_size_limit=8388608;');
      this.#db.exec('BEGIN IMMEDIATE');try{
        const owner=this.#db.prepare('SELECT pid FROM chat_task_owner WHERE id=1').get();
        if(owner&&live(Number(owner.pid)))throw new Error('Task journal already has a live owner.');
        this.#db.prepare('INSERT OR REPLACE INTO chat_task_owner VALUES(1,?,?)').run(process.pid,this.#owner);
        // v1 -> v2 only after exact validation and ownership, in the SAME transaction as the claim.
        if(current===1){
          if(Number(this.#db.prepare('PRAGMA user_version').get()!.user_version)!==1)throw new Error('Task journal version changed during migration.');
          schemaFor(TABLES_V1);taskRows(); // Recheck under the write lock before any DDL.
          this.#db.exec(PROPOSALS_DDL);this.#db.exec(`PRAGMA user_version=${VERSION};`);
        }
        this.#db.exec('COMMIT');claimed=true;
      }catch(error){this.#db.exec('ROLLBACK');throw error;}
      schemaFor(TABLES);
      const tasks = this.list();
      for (const task of tasks) this.#cache(task);
      // Native handles and opaque capabilities do not survive restart. Retain
      // evidence and never redispatch a recorded/pending repair automatically.
      for (const task of tasks) if (ACTIVE.has(task.state)) this.update(task.id, value => {
        value.state = !value.nativeSettled || value.repairDispatch === 'reserved' ? 'unknown' : 'paused';
        value.reason = 'daemon_restarted_no_replay';
        if (value.repairDispatch === 'reserved') value.repairDispatch = 'unknown';
      });
      // A reserved proposal attempt has no surviving owner or worker handle: unknown, never replayed.
      this.#db.exec('BEGIN IMMEDIATE');try{
        for (const { record: proposal, payload } of this.#allProposals()) if (proposal.state === 'reserved')
          this.#writeProposal({ ...proposal, state: 'unknown', reason: 'daemon_restarted_no_replay', updatedAt: new Date().toISOString() }, payload);
        this.#db.exec('COMMIT');}catch(error){this.#db.exec('ROLLBACK');throw error;}
    } catch (error) { if(claimed)try{this.#db.prepare('DELETE FROM chat_task_owner WHERE token=?').run(this.#owner);}catch{/* Preserve the original journal failure. */}this.#db.close(); throw error; }
  }
  #parse(value: unknown): ChatTaskRecord {
    const parsed = record.parse(value);
    if (parsed.projectId !== this.projectId || parsed.projectPath !== this.projectPath) throw new Error('Task journal project changed.');
    return parsed as ChatTaskRecord;
  }
  #paths():void{
    directDirectories(this.#directory);
    for(const suffix of ['','-wal','-shm','-journal'])try{const file=this.#filename+suffix,stat=lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!samePath(realpathSync(file),file)||suffix===''&&this.#fileIdentity&&(stat.dev!==this.#fileIdentity.dev||stat.ino!==this.#fileIdentity.ino))throw new Error('Task SQLite files must be direct owned regular files.');
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||suffix===''&&this.#fileIdentity)throw error;}
  }
  #open(): void { if (this.#closed) throw new Error('Task journal is closed.');this.#paths();
    if(this.#db.prepare('PRAGMA user_version').get()?.user_version!==VERSION||this.#db.prepare('SELECT token FROM chat_task_owner WHERE id=1').get()?.token!==this.#owner)throw new Error('Task journal version or ownership changed.'); }
  #parseProposal(row:{id:string;task_id:string;request_id:string;payload:string}):ChatTaskProposalRecord{
    // Identity and byte bound BEFORE JSON.parse, independent of the SQL CHECK.
    if(typeof row.id!=='string'||typeof row.task_id!=='string'||typeof row.request_id!=='string'||typeof row.payload!=='string'||
      Buffer.byteLength(row.payload)>CHAT_TASK_PROPOSAL_LIMITS.payloadBytes)throw new Error('Task proposal journal is corrupt.');
    let value:unknown;try{value=JSON.parse(row.payload);}catch{throw new Error('Task proposal journal is corrupt.');}
    const parsed=proposalRecord.safeParse(value);
    if(!parsed.success||parsed.data.id!==row.id||parsed.data.taskId!==row.task_id||parsed.data.requestId!==row.request_id)throw new Error('Task proposal journal is corrupt.');
    const r=parsed.data;
    return Object.freeze({...r,result:r.result?Object.freeze({...r.result}):null}) as ChatTaskProposalRecord;
  }
  #allProposals():{record:ChatTaskProposalRecord;payload:string}[]{
    const rows=this.#db.prepare('SELECT id,task_id,request_id,payload FROM chat_task_proposals ORDER BY rowid LIMIT ?').all(CHAT_TASK_PROPOSAL_LIMITS.total+1) as {id:string;task_id:string;request_id:string;payload:string}[];
    if(rows.length>CHAT_TASK_PROPOSAL_LIMITS.total)throw new Error('Task proposal journal retention exceeded.');
    return rows.map(row=>({record:this.#parseProposal(row),payload:row.payload}));
  }
  /** Replace one row only from its exact stored prior payload (immutable terminal results). */
  #writeProposal(next:ChatTaskProposalRecord,priorPayload:string|null):void{
    const parsed=proposalRecord.safeParse(next);if(!parsed.success)throw new Error('Invalid task proposal record.');
    const payload=JSON.stringify(parsed.data);
    if(Buffer.byteLength(payload)>CHAT_TASK_PROPOSAL_LIMITS.payloadBytes)throw new ChatTaskProposalLimitError();
    if(priorPayload===null)this.#db.prepare('INSERT INTO chat_task_proposals(id,task_id,request_id,payload) VALUES(?,?,?,?)').run(next.id,next.taskId,next.requestId,payload);
    else{const changed=this.#db.prepare('UPDATE chat_task_proposals SET payload=? WHERE id=? AND payload=?').run(payload,next.id,priorPayload);
      if(Number(changed.changes)!==1)throw new Error('Task proposal changed concurrently.');}
  }
  proposals(taskId:string):ChatTaskProposalRecord[]{
    this.#open();
    const rows=this.#db.prepare('SELECT id,task_id,request_id,payload FROM chat_task_proposals WHERE task_id=? ORDER BY rowid LIMIT ?').all(taskId,CHAT_TASK_PROPOSAL_LIMITS.perTask+1) as {id:string;task_id:string;request_id:string;payload:string}[];
    if(rows.length>CHAT_TASK_PROPOSAL_LIMITS.perTask)throw new Error('Task proposal retention exceeded.');
    return rows.map(row=>this.#parseProposal(row));
  }
  proposalByRequest(requestId:string):ChatTaskProposalRecord|null{
    this.#open();
    const row=this.#db.prepare('SELECT id,task_id,request_id,payload FROM chat_task_proposals WHERE request_id=?').get(requestId) as {id:string;task_id:string;request_id:string;payload:string}|undefined;
    return row?this.#parseProposal(row):null;
  }
  /** Durable reservation BEFORE any worker exists. Bounded; never evicts. */
  reserveProposal(input:{id:string;taskId:string;requestId:string;promptSha256:string;promptBytes:number}):ChatTaskProposalRecord{
    this.#open();this.#db.exec('BEGIN IMMEDIATE');
    try{
      this.get(input.taskId);
      if(this.#db.prepare('SELECT 1 FROM chat_task_proposals WHERE request_id=? OR id=?').get(input.requestId,input.id))throw new Error('Task proposal request already exists.');
      if(Number((this.#db.prepare('SELECT count(*) AS n FROM chat_task_proposals WHERE task_id=?').get(input.taskId) as {n:number}).n)>=CHAT_TASK_PROPOSAL_LIMITS.perTask||
        Number((this.#db.prepare('SELECT count(*) AS n FROM chat_task_proposals').get() as {n:number}).n)>=CHAT_TASK_PROPOSAL_LIMITS.total)throw new Error('Task proposal journal is full.');
      const now=new Date().toISOString(),record:ChatTaskProposalRecord={...input,state:'reserved',reason:null,result:null,createdAt:now,updatedAt:now};
      this.#writeProposal(record,null);this.#db.exec('COMMIT');return this.#parseProposal({id:record.id,task_id:record.taskId,request_id:record.requestId,payload:JSON.stringify(proposalRecord.parse(record))});
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  /** reserved -> proposed|failed|unknown exactly once; terminal records are immutable. */
  settleProposal(id:string,outcome:{state:'proposed';result:ChatTaskProposalResult}|{state:'failed'|'unknown';reason:ChatTaskProposalReason}):ChatTaskProposalRecord{
    this.#open();this.#db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.#db.prepare('SELECT id,task_id,request_id,payload FROM chat_task_proposals WHERE id=?').get(id) as {id:string;task_id:string;request_id:string;payload:string}|undefined;
      if(!row)throw new Error('Unknown task proposal.');
      const prior=this.#parseProposal(row);
      if(prior.state!=='reserved')throw new Error('Task proposal outcome is immutable.');
      const next:ChatTaskProposalRecord=outcome.state==='proposed'?{...prior,state:'proposed',reason:null,result:outcome.result,updatedAt:new Date().toISOString()}
        :{...prior,state:outcome.state,reason:outcome.reason,result:null,updatedAt:new Date().toISOString()};
      this.#writeProposal(next,row.payload);this.#db.exec('COMMIT');
      return this.#parseProposal({...row,payload:JSON.stringify(proposalRecord.parse(next))});
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  #cache(task: ChatTaskRecord): void {
    this.#summaries.set(task.id, { id: task.id, threadId: task.threadId, sessionId: task.sessionId, connectionId: task.connectionId,
      state: task.state, round: task.round, reason: task.reason, reportDigest: task.evidence.at(-1)?.reportDigest ?? null });
  }
  summaries(): ChatTaskSummary[] { this.#open(); return [...this.#summaries.values()].map(value => ({ ...value })); }
  list(): ChatTaskRecord[] {
    this.#open();
    const rows = this.#db.prepare('SELECT payload FROM chat_tasks ORDER BY rowid LIMIT 257').all() as { payload: string }[];
    if (rows.length > 256) throw new Error('Task journal retention exceeded.');
    return rows.map(row => this.#parse(JSON.parse(row.payload)));
  }
  get(id: string): ChatTaskRecord {
    this.#open();
    const row = this.#db.prepare('SELECT payload FROM chat_tasks WHERE id=?').get(id) as { payload: string } | undefined;
    if (!row) throw new Error('Unknown task.'); return this.#parse(JSON.parse(row.payload));
  }
  create(input: Omit<ChatTaskRecord, 'projectId' | 'projectPath' | 'revision' | 'createdAt' | 'updatedAt'>): ChatTaskRecord {
    this.#open();
    if (this.#summaries.size >= 256) throw new Error('Task journal is full.');
    const now = new Date().toISOString();
    const value = this.#parse({ ...input, projectId: this.projectId, projectPath: this.projectPath, revision: 0, createdAt: now, updatedAt: now });
    this.#db.prepare('INSERT INTO chat_tasks(id,payload) VALUES(?,?)').run(value.id, JSON.stringify(value));
    this.#cache(value);
    return structuredClone(value);
  }
  update(id: string, change: (value: ChatTaskRecord) => void): ChatTaskRecord {
    this.#open(); this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = this.get(id); change(value); value.revision++; value.updatedAt = new Date().toISOString();
      const parsed = this.#parse(value), payload = JSON.stringify(parsed);
      if (Buffer.byteLength(payload) > 512 * 1024) throw new Error('Task journal record exceeds its bound.');
      this.#db.prepare('UPDATE chat_tasks SET payload=? WHERE id=?').run(payload, id); this.#db.exec('COMMIT');
      this.#cache(parsed);
      return structuredClone(parsed);
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (!this.#closed) { this.#closed = true;try{this.#db.prepare('DELETE FROM chat_task_owner WHERE token=?').run(this.#owner);}finally{this.#db.close();} } }
}
