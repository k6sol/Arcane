import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, realpathSync, openSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {isDeepStrictEqual,types} from 'node:util';
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
const PLANS_DDL='CREATE TABLE chat_task_plans(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192)) STRICT';
const STEPS_DDL='CREATE TABLE chat_task_plan_steps(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,step_key TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192),UNIQUE(plan_id,step_key),UNIQUE(plan_id,seq)) STRICT';
const TABLES_V2=[...TABLES_V1,PROPOSALS_DDL];
const TABLES_V4=[...TABLES_V2,PLANS_DDL,STEPS_DDL];
const PROPOSAL_CLOSURES_DDL='CREATE TABLE chat_task_proposal_worker_closures(proposal_id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=32768)) STRICT';
const TABLES=[...TABLES_V4,PROPOSAL_CLOSURES_DDL];
const VERSION=5;

/** Durable host-authored plan journal. Rows record bounded identities and digests only; they carry no
 * capability, prompt text or acceptance. A plan or parent completion is never task acceptance. */
export const CHAT_TASK_PLAN_POLICY=Object.freeze({rounds:2,workersPerRound:3,workerAttempts:5,parentSteps:2,fanInBytes:98304} as const);
export const CHAT_TASK_PLAN_LIMITS=Object.freeze({plans:256,stepsPerPlan:16,steps:4096,payloadBytes:8192});
export const CHAT_TASK_PLAN_REASONS=Object.freeze(['task_cancelled','task_uncertain','fenced','parent_retired','repair_reserved','binding_changed',
  'budget_exhausted','no_usable_proposals','daemon_restarted','step_unknown'] as const);
export const CHAT_TASK_STEP_REASONS=Object.freeze(['not_dispatched','dispatch_uncertain','terminal_unobserved','daemon_restarted_no_replay',
  'not_requested','request_uncertain','worker_failed','worker_unknown'] as const);
export type ChatTaskPlanReason=typeof CHAT_TASK_PLAN_REASONS[number];
export type ChatTaskStepReason=typeof CHAT_TASK_STEP_REASONS[number];
export type ChatTaskStepKind='worker'|'incorporation'|'evidence';
export interface ChatTaskPlanBinding {
  readonly accountIdentity:string;readonly connectionId:string;readonly incarnationId:string;readonly threadId:string;readonly sessionId:string|null;
  readonly model:string;readonly effort:string;readonly allowWorkspaceWrites:boolean;readonly allowAssets:boolean;
}
export interface ChatTaskPlanRecord {
  readonly id:string;readonly taskId:string;readonly binding:ChatTaskPlanBinding;readonly objectiveSha256:string;readonly inputSha256:string;
  readonly policy:typeof CHAT_TASK_PLAN_POLICY;readonly state:'active'|'stopped'|'awaiting_review'|'unknown';readonly reason:ChatTaskPlanReason|null;
  readonly createdAt:string;readonly updatedAt:string;
}
export interface ChatTaskPlanStep {
  readonly id:string;readonly planId:string;readonly taskId:string;readonly key:string;readonly seq:number;readonly kind:ChatTaskStepKind;
  readonly round:number;readonly index:number;readonly state:'reserved'|'acknowledged'|'completed'|'failed'|'unknown';readonly reason:ChatTaskStepReason|null;
  readonly proposalId:string|null;readonly fanIn:{readonly proposalIds:readonly string[];readonly bytes:number;readonly sha256:string}|null;
  readonly inputSha256:string|null;
  readonly native:{readonly operationId:string;readonly turnId:string}|null;readonly terminal:'completed'|'failed'|null;readonly evidence:{readonly runId:string}|null;
  readonly createdAt:string;readonly updatedAt:string;
}
export class ChatTaskPlanError extends Error {
  constructor(readonly code:'INPUT'|'TASK_SCOPE'|'PLAN_INACTIVE'|'BINDING'|'ORDER'|'DUPLICATE'|'BUDGET'|'STATE'|'FULL'|'CORRUPT',message:string){super(message);this.name='ChatTaskPlanError';}
}
const planFail=(code:ChatTaskPlanError['code'],message:string):never=>{throw new ChatTaskPlanError(code,message);};
const planBinding=z.strictObject({accountIdentity:hash,connectionId:z.string().uuid(),incarnationId:z.string().uuid(),threadId:id,sessionId:id.nullable(),
  model:id,effort:id,allowWorkspaceWrites:z.boolean(),allowAssets:z.boolean()});
const planPolicy=z.strictObject({rounds:z.literal(2),workersPerRound:z.literal(3),workerAttempts:z.literal(5),parentSteps:z.literal(2),fanInBytes:z.literal(98304)});
const planRecord=z.strictObject({id:z.string().uuid(),taskId:z.string().uuid(),binding:planBinding,objectiveSha256:hash,inputSha256:hash,policy:planPolicy,
  state:z.enum(['active','stopped','awaiting_review','unknown']),reason:z.enum(CHAT_TASK_PLAN_REASONS).nullable(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()})
  .refine(r=>(r.state==='active'||r.state==='awaiting_review')===(r.reason===null));
const stepRecord=z.strictObject({id:z.string().uuid(),planId:z.string().uuid(),taskId:z.string().uuid(),key:z.string().max(32),seq:z.number().int().min(1).max(16),
  kind:z.enum(['worker','incorporation','evidence']),round:z.number().int().min(1).max(2),index:z.number().int().min(0).max(2),
  state:z.enum(['reserved','acknowledged','completed','failed','unknown']),reason:z.enum(CHAT_TASK_STEP_REASONS).nullable(),
  proposalId:z.string().uuid().nullable(),
  inputSha256:hash.nullable().default(null),
  fanIn:z.strictObject({proposalIds:z.array(z.string().uuid()).min(1).max(3),bytes:z.number().int().min(1).max(98304),sha256:hash}).nullable(),
  native:z.strictObject({operationId:id,turnId:id}).nullable(),terminal:z.enum(['completed','failed']).nullable(),
  evidence:z.strictObject({runId:id}).nullable(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()})
  .refine(s=>s.key===s.kind+':'+s.round+':'+s.index&&((s.state==='failed'||s.state==='unknown')===(s.reason!==null))&&
    (s.kind==='worker'?s.proposalId!==null&&s.inputSha256===null&&s.fanIn===null&&s.native===null&&s.terminal===null&&s.evidence===null&&s.state!=='acknowledged':
     s.kind==='incorporation'?s.index===0&&s.proposalId===null&&s.fanIn!==null&&s.evidence===null&&new Set(s.fanIn.proposalIds).size===s.fanIn.proposalIds.length&&
       (s.state==='completed')===(s.terminal!==null)&&(s.state==='acknowledged'||s.state==='completed'?s.native!==null:s.state==='reserved'||s.state==='failed'?s.native===null:true):
     s.index===0&&s.proposalId===null&&s.inputSha256===null&&s.fanIn===null&&s.native===null&&s.terminal===null&&(s.state==='acknowledged')===(s.evidence!==null)&&s.state!=='completed'));
/** Detached exact own data: accessors, symbol keys and unexpected fields are refused before any use. */
function ownData(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))planFail('INPUT','Expected an exact host envelope.');
  const keys=Reflect.ownKeys(value as object);
  if(keys.some(key=>typeof key!=='string'||!required.includes(key)&&!optional.includes(key))||required.some(key=>!keys.includes(key)))planFail('INPUT','Unexpected or missing field.');
  const out:Record<string,unknown>={};
  for(const key of keys as string[]){const field=Object.getOwnPropertyDescriptor(value,key);if(!field||!Object.hasOwn(field,'value'))planFail('INPUT','Fields must be plain data.');out[key]=field!.value;}
  return out;
}
function ownArray(value:unknown,max:number):unknown[]{
  if(value===null||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>max)planFail('INPUT','Expected a bounded array.');
  const items=value as unknown[],keys=Reflect.ownKeys(items);
  if(keys.length!==items.length+1)planFail('INPUT','Arrays must be plain data.');
  return Array.from({length:items.length},(_,index)=>{const field=Object.getOwnPropertyDescriptor(items,index); // descriptors only; getters are never invoked
    if(!field||!Object.hasOwn(field,'value'))planFail('INPUT','Array items must be plain data.');return field!.value;});
}
type PlanRow={id:string;task_id:string;payload:string};type StepRow={id:string;plan_id:string;step_key:string;seq:number;payload:string};

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
const proposalClosure=z.strictObject({version:z.literal(1),projectId:hash,projectPath:z.string().min(1).max(4096),
  proposalId:z.string().uuid(),taskId:z.string().uuid(),requestId:z.string().uuid(),reservationFingerprint:hash,
  kind:z.enum(['closed','not_allocated']),settledAt:z.string().datetime(),storeLifetimeId:z.string().uuid()});
declare const proposalWorkerReservation:unique symbol;
/** Original in-memory store capability, never reconstructed from a journal or request. */
export interface ChatTaskProposalWorkerReservation {readonly [proposalWorkerReservation]:true}
interface ProposalWorkerOwner {
  readonly token:ChatTaskProposalWorkerReservation;readonly proposalId:string;readonly fingerprint:string;
  invoked:boolean;closing:boolean;settled:boolean;durable:boolean;kind:'closed'|'not_allocated'|null;
  allocation:Promise<unknown>|null;worker:{receiver:object;close:()=>Promise<void>}|null;tail:Promise<void>|null;
  markerFailed:boolean;markerError:unknown;
}
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function isDirectPath(path: string): boolean {
  if (process.platform === 'win32') {
    try {
      // Native lookup avoids the JS resolver's repeated ancestor walks. Only
      // accept an unchanged result; other spellings/errors retain the legacy
      // resolver's alias and error behavior. Never retain filesystem authority.
      if (samePath(realpathSync.native(path), path)) return true;
    } catch { /* Native handle lookup can fail where the legacy resolver works. */ }
  }
  return samePath(realpathSync(path), path);
}
function directDirectories(path:string,missing=false):void{
  for(let current=path;;current=dirname(current)){
    try{const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!isDirectPath(current))throw new Error('Task state directories must be direct.');}
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
  readonly #createdProposals=new Map<string,string>();
  readonly #proposalWorkers=new WeakMap<ChatTaskProposalWorkerReservation,ProposalWorkerOwner>();
  readonly #proposalWorkerIds=new Map<string,ProposalWorkerOwner>();
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
      if(version!==0&&version!==1&&version!==2&&version!==3&&version!==4&&version!==VERSION)throw new Error('Invalid task journal version.');
      if(this.#db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Task journal integrity failed.');
      if(version===0){
        if(this.#db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()||this.#db.prepare('PRAGMA application_id').get()?.application_id!==0)throw new Error('Unversioned task journal is not empty.');
        this.#db.exec('BEGIN IMMEDIATE');try{for(const ddl of TABLES)this.#db.exec(ddl);this.#db.prepare('INSERT INTO chat_task_meta VALUES(1,?,?)').run(this.projectId,this.projectPath);this.#db.exec(`PRAGMA application_id=${APP_ID};PRAGMA user_version=${VERSION};COMMIT;`);}catch(error){this.#db.exec('ROLLBACK');throw error;}
      }
      // Validate the EXACT existing schema, application and project before any ownership claim or migration.
      const schemaFor=(expected:readonly string[])=>{
        const schema=this.#db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
        if(this.#db.prepare('PRAGMA application_id').get()?.application_id!==APP_ID||schema.length!==expected.length||schema.some(row=>!expected.includes(String(row.sql))))throw new Error('Task journal schema or project changed.');
        const meta=this.#db.prepare('SELECT project_id,project_path FROM chat_task_meta WHERE id=1').get();
        if(meta?.project_id!==this.projectId||meta.project_path!==this.projectPath)throw new Error('Task journal schema or project changed.');
      };
      const current=Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      schemaFor(current===1?TABLES_V1:current===2?TABLES_V2:current<5?TABLES_V4:TABLES);
      // Every refusal below is read-only and precedes the first write (including the WAL header switch).
      const taskRows=()=>{
        const rows=this.#db.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid LIMIT 257').all() as {id:string;payload:string}[];
        if(rows.length>256)throw new Error('Task journal retention exceeded.');
        for(const row of rows)this.#taskRow(row);
      };
      taskRows();if(current>=2)this.#allProposals();if(current>=3)this.#allPlanRows(current===3);if(current>=5)this.#allProposalClosures();
      const prior=this.#db.prepare('SELECT pid FROM chat_task_owner WHERE id=1').get();
      if(prior&&live(Number(prior.pid)))throw new Error('Task journal already has a live owner.');
      this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;PRAGMA journal_size_limit=8388608;');
      this.#db.exec('BEGIN IMMEDIATE');try{
        const owner=this.#db.prepare('SELECT pid FROM chat_task_owner WHERE id=1').get();
        if(owner&&live(Number(owner.pid)))throw new Error('Task journal already has a live owner.');
        this.#db.prepare('INSERT OR REPLACE INTO chat_task_owner VALUES(1,?,?)').run(process.pid,this.#owner);
        // Migrate only after exact validation and ownership, in the SAME transaction as the claim.
        if(current<VERSION){
          if(Number(this.#db.prepare('PRAGMA user_version').get()!.user_version)!==current)throw new Error('Task journal version changed during migration.');
          schemaFor(current===1?TABLES_V1:current===2?TABLES_V2:TABLES_V4);taskRows();if(current>=2)this.#allProposals();if(current>=3)this.#allPlanRows(current===3);
          if(current===1)this.#db.exec(PROPOSALS_DDL);
          if(current<3){this.#db.exec(PLANS_DDL);this.#db.exec(STEPS_DDL);}this.#db.exec(PROPOSAL_CLOSURES_DDL);this.#db.exec(`PRAGMA user_version=${VERSION};`);
        }
        this.#recoverPlans(); // Restart recovery is atomic with migration and the ownership claim.
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
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!isDirectPath(file)||suffix===''&&this.#fileIdentity&&(stat.dev!==this.#fileIdentity.dev||stat.ino!==this.#fileIdentity.ino))throw new Error('Task SQLite files must be direct owned regular files.');
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
      this.#writeProposal(record,null);this.#db.exec('COMMIT');
      const saved=this.#parseProposal({id:record.id,task_id:record.taskId,request_id:record.requestId,payload:JSON.stringify(proposalRecord.parse(record))});
      this.#createdProposals.set(saved.id,this.#proposalReservationFingerprint(saved));return saved;
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
  #proposalReservationFingerprint(proposal:ChatTaskProposalRecord):string {
    return createHash('sha256').update(JSON.stringify({projectId:this.projectId,projectPath:this.projectPath,proposalId:proposal.id,taskId:proposal.taskId,
      requestId:proposal.requestId,promptSha256:proposal.promptSha256,promptBytes:proposal.promptBytes,createdAt:proposal.createdAt})).digest('hex');
  }
  #proposalOwnerTask(proposal:ChatTaskProposalRecord):void {
    const row=this.#db.prepare('SELECT id,payload FROM chat_tasks WHERE id=?').get(proposal.taskId) as {id:unknown;payload:unknown}|undefined;
    if(!row||this.#taskRow(row).id!==proposal.taskId)throw new Error('Task proposal lost its original task.');
  }
  #allProposalClosures():Set<string> {
    const rows=this.#db.prepare('SELECT proposal_id,payload FROM chat_task_proposal_worker_closures ORDER BY rowid LIMIT ?').all(CHAT_TASK_PROPOSAL_LIMITS.total+1) as {proposal_id:unknown;payload:unknown}[];
    if(rows.length>CHAT_TASK_PROPOSAL_LIMITS.total)throw new Error('Task proposal closure retention exceeded.');
    const closed=new Set<string>();
    for(const row of rows){
      if(typeof row.proposal_id!=='string'||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>32768)throw new Error('Task proposal closure journal is corrupt.');
      let raw:unknown;try{raw=JSON.parse(row.payload);}catch{throw new Error('Task proposal closure journal is corrupt.');}
      const parsed=proposalClosure.safeParse(raw);if(!parsed.success)throw new Error('Task proposal closure journal is corrupt.');
      const marker=parsed.data,proposal=this.#proposalById(marker.proposalId),task=this.#db.prepare('SELECT id,payload FROM chat_tasks WHERE id=?').get(marker.taskId) as {id:unknown;payload:unknown}|undefined;
      if(marker.proposalId!==row.proposal_id||marker.projectId!==this.projectId||marker.projectPath!==this.projectPath||!proposal||!task||
        proposal.taskId!==marker.taskId||proposal.requestId!==marker.requestId||this.#proposalReservationFingerprint(proposal)!==marker.reservationFingerprint||this.#taskRow(task).id!==marker.taskId)
        throw new Error('Task proposal closure lost its exact reservation.');
      closed.add(marker.proposalId);
    }
    return closed;
  }
  #proposalWorker(token:ChatTaskProposalWorkerReservation):ProposalWorkerOwner {
    if(token===null||typeof token!=='object')throw new Error('An original proposal worker reservation is required.');
    const entry=this.#proposalWorkers.get(token);if(!entry)throw new Error('An original proposal worker reservation is required.');return entry;
  }
  reserveProposalWorker(proposalId:string):ChatTaskProposalWorkerReservation {
    this.#open();const fingerprint=this.#createdProposals.get(proposalId);
    if(!fingerprint)throw new Error('Only this store lifetime can reserve its original proposal worker.');
    const proposal=this.#proposalById(proposalId);if(!proposal||this.#proposalReservationFingerprint(proposal)!==fingerprint)throw new Error('Only this store lifetime can reserve its original proposal worker.');
    this.#proposalOwnerTask(proposal);
    const prior=this.#proposalWorkerIds.get(proposalId);if(prior)return prior.token;
    if(proposal.state!=='reserved')throw new Error('Only an original reserved proposal can receive a worker reservation.');
    const token=Object.freeze(Object.create(null)) as ChatTaskProposalWorkerReservation;
    const entry:ProposalWorkerOwner={token,proposalId,fingerprint,invoked:false,closing:false,settled:false,durable:false,kind:null,allocation:null,worker:null,tail:null,markerFailed:false,markerError:undefined};
    this.#proposalWorkers.set(token,entry);this.#proposalWorkerIds.set(proposalId,entry);return token;
  }
  async invokeProposalWorker<T extends {close():Promise<void>}>(token:ChatTaskProposalWorkerReservation,factory:()=>Promise<T>):Promise<T> {
    const entry=this.#proposalWorker(token);this.#open();const proposal=this.#proposalById(entry.proposalId);
    if(!proposal||this.#proposalReservationFingerprint(proposal)!==entry.fingerprint)throw new Error('Task proposal reservation changed.');
    this.#proposalOwnerTask(proposal);
    if(entry.invoked||entry.closing||entry.settled||typeof factory!=='function')throw new Error('Task proposal worker invocation is one-use.');
    if(proposal.state!=='reserved')throw new Error('Only an original reserved proposal can invoke its worker.');
    entry.invoked=true;let accepted!:(worker:T)=>void,failed!:(error:unknown)=>void;
    const allocation=new Promise<T>((resolve,reject)=>{accepted=resolve;failed=reject;});entry.allocation=allocation;void allocation.catch(()=>{});
    try{Promise.resolve(factory()).then(worker=>{try{
      const close=worker.close;if(typeof close!=='function')throw new Error('Proposal worker has no original close method.');
      entry.worker={receiver:worker,close};accepted(worker);
    }catch(error){failed(error);}},failed);}catch(error){failed(error);}
    return allocation;
  }
  #recordProposalClosure(entry:ProposalWorkerOwner,kind:'closed'|'not_allocated'):void {
    this.#open();let began=false;
    try{
      this.#db.exec('BEGIN IMMEDIATE');began=true;this.#allProposalClosures();
      const proposal=this.#proposalById(entry.proposalId);
      if(!proposal||this.#proposalReservationFingerprint(proposal)!==entry.fingerprint)throw new Error('Task proposal reservation changed.');
      this.#proposalOwnerTask(proposal);
      const marker=proposalClosure.parse({version:1,projectId:this.projectId,projectPath:this.projectPath,proposalId:proposal.id,taskId:proposal.taskId,requestId:proposal.requestId,
        reservationFingerprint:entry.fingerprint,kind,settledAt:new Date().toISOString(),storeLifetimeId:this.#owner});
      const payload=JSON.stringify(marker);if(Buffer.byteLength(payload)>32768)throw new Error('Task proposal closure exceeds its bound.');
      this.#db.prepare('INSERT INTO chat_task_proposal_worker_closures(proposal_id,payload) VALUES(?,?)').run(proposal.id,payload);
      this.#db.exec('COMMIT');began=false;entry.durable=true;
    }catch(error){if(began)try{this.#db.exec('ROLLBACK');}catch{/* Preserve the exact original marker fault, including falsy values. */}throw error;}
  }
  closeProposalWorker(token:ChatTaskProposalWorkerReservation):Promise<void> {
    const entry=this.#proposalWorker(token);if(entry.tail)return entry.tail;
    entry.closing=true;let accepted!:()=>void,failed!:(error:unknown)=>void;
    const tail=new Promise<void>((resolve,reject)=>{accepted=resolve;failed=reject;});entry.tail=tail;void tail.catch(()=>{});
    void(async()=>{
      if(entry.kind==='not_allocated'){if(entry.markerFailed)throw entry.markerError;return;}
      if(!entry.invoked||!entry.allocation)throw new Error('Record an uninvoked proposal worker as not allocated.');
      await entry.allocation;
      const worker=entry.worker;if(!worker)throw new Error('The original proposal worker was not captured.');
      const completion=Reflect.apply(worker.close,worker.receiver,[]);
      if(!types.isPromise(completion))throw new Error('Proposal worker close must return its original Promise.');
      await completion;
      entry.kind='closed';entry.settled=true;
      try{this.#recordProposalClosure(entry,'closed');}catch(error){entry.markerFailed=true;entry.markerError=error;throw error;}
    })().then(accepted,failed);
    return tail;
  }
  recordProposalWorkerNotAllocated(token:ChatTaskProposalWorkerReservation):void {
    const entry=this.#proposalWorker(token);
    if(entry.invoked)throw new Error('An invoked proposal factory cannot prove nonallocation.');
    if(entry.kind==='not_allocated'){if(entry.markerFailed)throw entry.markerError;return;}
    entry.closing=true;entry.kind='not_allocated';entry.settled=true;
    try{this.#recordProposalClosure(entry,'not_allocated');}catch(error){entry.markerFailed=true;entry.markerError=error;throw error;}
  }
  proposalWorkerClosure(token:ChatTaskProposalWorkerReservation):Readonly<{settled:boolean;durable:boolean}> {
    const entry=this.#proposalWorker(token);return Object.freeze({settled:entry.settled,durable:entry.durable});
  }
  unclosedProposalIds():readonly string[] {
    this.#open();const proposals=this.#allProposals(),closed=this.#allProposalClosures();return Object.freeze(proposals.filter(row=>!closed.has(row.record.id)||this.#proposalWorkerIds.get(row.record.id)?.markerFailed).map(row=>row.record.id));
  }
  #cache(task: ChatTaskRecord): void {
    this.#summaries.set(task.id, { id: task.id, threadId: task.threadId, sessionId: task.sessionId, connectionId: task.connectionId,
      state: task.state, round: task.round, reason: task.reason, reportDigest: task.evidence.at(-1)?.reportDigest ?? null });
  }
  summaries(): ChatTaskSummary[] { this.#open(); return [...this.#summaries.values()].map(value => ({ ...value })); }
  list(): ChatTaskRecord[] {
    this.#open();
    const rows = this.#db.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid LIMIT 257').all() as { id: unknown; payload: unknown }[];
    if (rows.length > 256) throw new Error('Task journal retention exceeded.');
    return rows.map(row => this.#taskRow(row));
  }
  /** Host recovery seal: validate exact original rows, hash their raw persisted bytes, expose no payload. */
  recoveryTaskFingerprints():readonly {id:string;fingerprint:string}[] {
    this.#open();const rows=this.#db.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid LIMIT 257').all() as {id:unknown;payload:unknown}[];
    if(rows.length>256)throw new Error('Task journal retention exceeded.');
    return Object.freeze(rows.map(row=>{const task=this.#taskRow(row);return Object.freeze({id:task.id,fingerprint:createHash('sha256').update(task.id+'\0'+(row.payload as string)).digest('hex')});}));
  }
  get(id: string): ChatTaskRecord {
    this.#open();
    const row = this.#db.prepare('SELECT id,payload FROM chat_tasks WHERE id=?').get(id) as { id: unknown; payload: unknown } | undefined;
    if (!row) throw new Error('Unknown task.'); return this.#taskRow(row);
  }
  /** One exact task row reader: raw types and the UTF-8 byte bound are checked BEFORE JSON.parse,
   * then the existing record schema, project and row identity. Externally altered rows refuse; nothing is repaired. */
  #taskRow(row: { id: unknown; payload: unknown }): ChatTaskRecord {
    if (!row || typeof row.id !== 'string' || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > 512 * 1024) throw new Error('Task journal record exceeds its bound or is corrupt.');
    let value: unknown; try { value = JSON.parse(row.payload); } catch { throw new Error('Task journal is corrupt.'); }
    const parsed = this.#parse(value); if (parsed.id !== row.id) throw new Error('Task journal is corrupt.');
    return parsed;
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
  // ---------------------------------------------------------------- plan journal (v3)
  #parsePlan(row:PlanRow):ChatTaskPlanRecord{
    if(!row||typeof row.id!=='string'||typeof row.task_id!=='string'||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>CHAT_TASK_PLAN_LIMITS.payloadBytes)planFail('CORRUPT','Task plan journal is corrupt.');
    let value:unknown;try{value=JSON.parse(row.payload);}catch{planFail('CORRUPT','Task plan journal is corrupt.');}
    const parsed=planRecord.safeParse(value);
    if(!parsed.success||parsed.data.id!==row.id||parsed.data.taskId!==row.task_id)planFail('CORRUPT','Task plan journal is corrupt.');
    const r=parsed.data!;return Object.freeze({...r,binding:Object.freeze({...r.binding}),policy:CHAT_TASK_PLAN_POLICY}) as ChatTaskPlanRecord;
  }
  #parseStep(row:StepRow):ChatTaskPlanStep{
    if(!row||typeof row.id!=='string'||typeof row.plan_id!=='string'||typeof row.step_key!=='string'||typeof row.seq!=='number'||typeof row.payload!=='string'||
      Buffer.byteLength(row.payload)>CHAT_TASK_PLAN_LIMITS.payloadBytes)planFail('CORRUPT','Task plan step journal is corrupt.');
    let value:unknown;try{value=JSON.parse(row.payload);}catch{planFail('CORRUPT','Task plan step journal is corrupt.');}
    const parsed=stepRecord.safeParse(value);
    if(!parsed.success||parsed.data.id!==row.id||parsed.data.planId!==row.plan_id||parsed.data.key!==row.step_key||parsed.data.seq!==row.seq)planFail('CORRUPT','Task plan step journal is corrupt.');
    const s=parsed.data!;
    return Object.freeze({...s,fanIn:s.fanIn?Object.freeze({...s.fanIn,proposalIds:Object.freeze([...s.fanIn.proposalIds])}):null,
      native:s.native?Object.freeze({...s.native}):null,evidence:s.evidence?Object.freeze({...s.evidence}):null}) as ChatTaskPlanStep;
  }
  /** Read-only validation of every plan/step row, bounded BEFORE parse, with cross-row consistency. */
  #allPlanRows(legacyV3=false):{plans:{record:ChatTaskPlanRecord;payload:string}[];steps:{record:ChatTaskPlanStep;payload:string}[]}{
    const planRows=this.#db.prepare('SELECT id,task_id,payload FROM chat_task_plans ORDER BY rowid LIMIT ?').all(CHAT_TASK_PLAN_LIMITS.plans+1) as PlanRow[];
    if(planRows.length>CHAT_TASK_PLAN_LIMITS.plans)planFail('CORRUPT','Task plan retention exceeded.');
    const stepRows=this.#db.prepare('SELECT id,plan_id,step_key,seq,payload FROM chat_task_plan_steps ORDER BY plan_id,seq LIMIT ?').all(CHAT_TASK_PLAN_LIMITS.steps+1) as StepRow[];
    if(stepRows.length>CHAT_TASK_PLAN_LIMITS.steps)planFail('CORRUPT','Task plan step retention exceeded.');
    const plans=planRows.map(row=>({record:this.#parsePlan(row),payload:row.payload})),steps=stepRows.map(row=>({record:this.#parseStep(row),payload:row.payload}));
    if(legacyV3&&stepRows.some(row=>Object.hasOwn(JSON.parse(row.payload) as object,'inputSha256')))planFail('CORRUPT','Legacy task plan contains a newer step field.');
    const byId=new Map(plans.map(p=>[p.record.id,p.record]));
    for(const plan of plans){const task=this.#db.prepare('SELECT 1 FROM chat_tasks WHERE id=?').get(plan.record.taskId);if(!task)planFail('CORRUPT','Task plan names an unknown task.');}
    const counts=new Map<string,number>();
    for(const{record:step}of steps){
      const plan=byId.get(step.planId);if(!plan||plan.taskId!==step.taskId)planFail('CORRUPT','Task plan step names an unknown plan.');
      const n=(counts.get(step.planId)??0)+1;counts.set(step.planId,n);
      if(step.seq!==n||n>CHAT_TASK_PLAN_LIMITS.stepsPerPlan)planFail('CORRUPT','Task plan step order is corrupt.');
    }
    for(const plan of plans){const own=steps.filter(step=>step.record.planId===plan.record.id).map(step=>step.record);
      if(legacyV3&&own.some((step,index)=>step.kind==='evidence'&&(index!==own.length-1||own.slice(0,index).filter(s=>s.kind==='incorporation').at(-1)?.round!==step.round)))
        planFail('CORRUPT','Legacy task plan continued outside its review order.');
      this.#validatePlanLinks(plan.record,own);}
    return{plans,steps};
  }
  /** Reconcile persisted references before recovery or live use, not just each
   * row's JSON shape. A valid-looking foreign proposal cannot supply evidence. */
  #validatePlanLinks(plan:ChatTaskPlanRecord,steps:ChatTaskPlanStep[]):void{
    const seen=new Set<string>();let workers=0,parents=0,evidence=0;
    for(let index=0;index<steps.length;index++){
      const step=steps[index]!,prior=steps.slice(0,index);
      if(step.taskId!==plan.taskId)planFail('CORRUPT','Task plan step changed its parent.');
      const review=prior.find(s=>s.kind==='evidence');
      if(review&&(step.kind!=='incorporation'||review.state!=='acknowledged'||step.round!==review.round||prior.some(s=>s.kind==='incorporation'&&s.round===step.round)))
        planFail('CORRUPT','Task plan continued outside its final evidence handoff.');
      if(step.round===2&&!prior.some(s=>s.kind==='incorporation'&&s.round===1&&s.state==='completed'&&s.terminal==='completed'))
        planFail('CORRUPT','Task plan round lacks its completed parent.');
      if(step.kind==='worker'){
        const proposal=this.#proposalById(step.proposalId!);
        if(!proposal||proposal.taskId!==plan.taskId||seen.has(proposal.id)||prior.some(s=>s.kind!=='worker'&&s.round===step.round)||
          step.state==='completed'&&proposal.state!=='proposed'||step.state==='failed'&&proposal.state!=='failed')
          planFail('CORRUPT','Task plan worker lost its exact proposal.');
        seen.add(proposal!.id);workers++;
      }else if(step.kind==='incorporation'){
        const currentWorkers=prior.filter(s=>s.kind==='worker'&&s.round===step.round);
        if(!currentWorkers.length||currentWorkers.some(s=>s.state==='reserved'||s.state==='acknowledged'))planFail('CORRUPT','Task plan parent lacks settled workers.');
        let fanIn:ChatTaskPlanStep['fanIn'];
        try{fanIn=this.#fanIn(plan,step.round,prior,step.fanIn!.proposalIds);}catch{planFail('CORRUPT','Task plan fan-in cannot be verified.');}
        if(!isDeepStrictEqual(fanIn!,step.fanIn))planFail('CORRUPT','Task plan fan-in commitment changed.');
        parents++;
      }else{
        const parent=prior.filter(s=>s.kind==='incorporation').at(-1);
        const early=parent?.round===step.round-1&&step.round===CHAT_TASK_PLAN_POLICY.rounds&&!prior.some(s=>s.kind==='incorporation'&&s.round===step.round)&&
          prior.some(s=>s.kind==='worker'&&s.round===step.round)&&prior.filter(s=>s.kind==='worker'&&s.round===step.round).every(s=>s.state==='completed'||s.state==='failed');
        if(!parent||parent.state!=='completed'||parent.terminal!=='completed'||parent.round!==step.round&&!early)planFail('CORRUPT','Task plan review lacks its completed parent.');
        evidence++;
      }
    }
    if(workers>CHAT_TASK_PLAN_POLICY.workerAttempts||parents>CHAT_TASK_PLAN_POLICY.parentSteps||evidence>1||
      plan.state==='awaiting_review'&&!steps.some(s=>s.kind==='evidence'&&s.state==='acknowledged'&&steps.some(p=>p.kind==='incorporation'&&p.round===s.round&&p.state==='completed'&&p.terminal==='completed')))
      planFail('CORRUPT','Task plan graph exceeds its policy.');
  }
  #planRow(planId:string):{record:ChatTaskPlanRecord;payload:string}{
    const row=this.#db.prepare('SELECT id,task_id,payload FROM chat_task_plans WHERE id=?').get(planId) as PlanRow|undefined;
    if(!row)planFail('TASK_SCOPE','Unknown task plan.');return{record:this.#parsePlan(row!),payload:row!.payload};
  }
  #stepRows(planId:string):{record:ChatTaskPlanStep;payload:string}[]{
    const rows=this.#db.prepare('SELECT id,plan_id,step_key,seq,payload FROM chat_task_plan_steps WHERE plan_id=? ORDER BY seq LIMIT ?').all(planId,CHAT_TASK_PLAN_LIMITS.stepsPerPlan+1) as StepRow[];
    if(rows.length>CHAT_TASK_PLAN_LIMITS.stepsPerPlan)planFail('CORRUPT','Task plan step retention exceeded.');
    const parsed=rows.map((row,i)=>{const record=this.#parseStep(row);if(record.seq!==i+1)planFail('CORRUPT','Task plan step order is corrupt.');return{record,payload:row.payload};});
    this.#validatePlanLinks(this.#planRow(planId).record,parsed.map(row=>row.record));return parsed;
  }
  #writePlan(next:ChatTaskPlanRecord,priorPayload:string|null):void{
    const parsed=planRecord.safeParse(next);if(!parsed.success)planFail('STATE','Invalid task plan record.');
    const payload=JSON.stringify(parsed.data);if(Buffer.byteLength(payload)>CHAT_TASK_PLAN_LIMITS.payloadBytes)planFail('BUDGET','Task plan record exceeds its bound.');
    if(priorPayload===null)this.#db.prepare('INSERT INTO chat_task_plans(id,task_id,payload) VALUES(?,?,?)').run(next.id,next.taskId,payload);
    else if(Number(this.#db.prepare('UPDATE chat_task_plans SET payload=? WHERE id=? AND payload=?').run(payload,next.id,priorPayload).changes)!==1)planFail('STATE','Task plan changed concurrently.');
  }
  #writeStep(next:ChatTaskPlanStep,priorPayload:string|null):void{
    const parsed=stepRecord.safeParse(next);if(!parsed.success)planFail('STATE','Invalid task plan step.');
    const payload=JSON.stringify(parsed.data);if(Buffer.byteLength(payload)>CHAT_TASK_PLAN_LIMITS.payloadBytes)planFail('BUDGET','Task plan step exceeds its bound.');
    if(priorPayload===null)this.#db.prepare('INSERT INTO chat_task_plan_steps(id,plan_id,step_key,seq,payload) VALUES(?,?,?,?,?)').run(next.id,next.planId,next.key,next.seq,payload);
    else if(Number(this.#db.prepare('UPDATE chat_task_plan_steps SET payload=? WHERE id=? AND payload=?').run(payload,next.id,priorPayload).changes)!==1)planFail('STATE','Task plan step changed concurrently.');
  }
  #planTx<T>(work:()=>T):T{this.#open();this.#db.exec('BEGIN IMMEDIATE');try{const out=work();this.#db.exec('COMMIT');return out;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  /** Restart recovery inside the ownership transaction: no surviving owner keeps automatic dispatch rights. */
  #recoverPlans():void{
    const now=new Date().toISOString(),{plans,steps}=this.#allPlanRows();
    for(const{record,payload}of steps)if(record.state==='reserved'||record.state==='acknowledged'&&record.kind==='incorporation')
      this.#writeStep({...record,state:'unknown',reason:'daemon_restarted_no_replay',updatedAt:now},payload);
    for(const{record,payload}of plans)if(record.state==='active')this.#writePlan({...record,state:'stopped',reason:'daemon_restarted',updatedAt:now},payload);
  }
  #bindingCurrent(plan:ChatTaskPlanRecord,task:ChatTaskRecord,accountIdentity:unknown):void{
    const b=plan.binding;
    if(!ACTIVE.has(task.state)||task.repairDispatch!=='not_requested')planFail('PLAN_INACTIVE','The parent task is not running or has a repair reserved.');
    if(accountIdentity!==b.accountIdentity||task.connectionId!==b.connectionId||task.incarnationId!==b.incarnationId||task.threadId!==b.threadId||
      task.sessionId!==b.sessionId||task.model!==b.model||task.effort!==b.effort||task.allowWorkspaceWrites!==b.allowWorkspaceWrites||task.allowAssets!==b.allowAssets)
      planFail('BINDING','The original task binding changed.');
  }
  /** One host-authored plan per exact running task, bound to its original identity and grants. */
  createPlan(input:{taskId:string;accountIdentity:string;objectiveSha256:string;inputSha256:string}):ChatTaskPlanRecord{
    const i=ownData(input,['taskId','accountIdentity','objectiveSha256','inputSha256']);
    if(!z.string().uuid().safeParse(i.taskId).success||![i.accountIdentity,i.objectiveSha256,i.inputSha256].every(v=>hash.safeParse(v).success))planFail('INPUT','Invalid plan identity.');
    return this.#planTx(()=>{
      const task=this.get(i.taskId as string);
      if(!ACTIVE.has(task.state)||task.repairDispatch!=='not_requested')planFail('PLAN_INACTIVE','The parent task is not running or has a repair reserved.');
      if(this.#db.prepare('SELECT 1 FROM chat_task_plans WHERE task_id=?').get(task.id))planFail('DUPLICATE','This task already has a plan.');
      if(Number((this.#db.prepare('SELECT count(*) AS n FROM chat_task_plans').get() as {n:number}).n)>=CHAT_TASK_PLAN_LIMITS.plans)planFail('FULL','Task plan journal is full.');
      const now=new Date().toISOString(),record:ChatTaskPlanRecord={id:randomUUID(),taskId:task.id,binding:{accountIdentity:i.accountIdentity as string,connectionId:task.connectionId,
        incarnationId:task.incarnationId,threadId:task.threadId,sessionId:task.sessionId,model:task.model,effort:task.effort,allowWorkspaceWrites:task.allowWorkspaceWrites,allowAssets:task.allowAssets},
        objectiveSha256:i.objectiveSha256 as string,inputSha256:i.inputSha256 as string,policy:CHAT_TASK_PLAN_POLICY,state:'active',reason:null,createdAt:now,updatedAt:now};
      this.#writePlan(record,null);return this.#planRow(record.id).record;
    });
  }
  plan(taskId:string):ChatTaskPlanRecord|null{
    this.#open();const row=this.#db.prepare('SELECT id,task_id,payload FROM chat_task_plans WHERE task_id=?').get(taskId) as PlanRow|undefined;
    return row?this.#parsePlan(row):null;
  }
  planSteps(planId:string):ChatTaskPlanStep[]{this.#open();return this.#stepRows(planId).map(row=>row.record);}
  /** Canonical fan-in: derived from exact proposed rows in worker index order, never asserted by a caller. */
  #fanIn(plan:ChatTaskPlanRecord,round:number,steps:ChatTaskPlanStep[],ids:readonly string[]):{proposalIds:string[];bytes:number;sha256:string}{
    const workers=steps.filter(s=>s.kind==='worker'&&s.round===round),selected:ChatTaskPlanStep[]=[];
    for(const id of ids){const step=workers.find(s=>s.proposalId===id);if(!step||step.state!=='completed'||selected.includes(step))planFail('ORDER','Fan-in needs unique completed workers of this round.');selected.push(step!);}
    selected.sort((a,b)=>a.index-b.index);
    const rows=selected.map(step=>{const proposal=this.#proposalById(step.proposalId!);
      if(!proposal||proposal.taskId!==plan.taskId||proposal.state!=='proposed'||!proposal.result)planFail('ORDER','Fan-in proposals must be proposed rows of this task.');
      return{proposalId:proposal!.id,textSha256:proposal!.result!.textSha256,textBytes:proposal!.result!.textBytes};});
    const bytes=rows.reduce((total,row)=>total+row.textBytes,0);
    if(bytes>CHAT_TASK_PLAN_POLICY.fanInBytes)planFail('BUDGET','Fan-in exceeds its byte budget.');
    return{proposalIds:rows.map(row=>row.proposalId),bytes,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  proposalById(id:string):ChatTaskProposalRecord|null{this.#open();return this.#proposalById(id);}
  #proposalById(id:string):ChatTaskProposalRecord|null{
    const row=this.#db.prepare('SELECT id,task_id,request_id,payload FROM chat_task_proposals WHERE id=?').get(id) as {id:string;task_id:string;request_id:string;payload:string}|undefined;
    return row?this.#parseProposal(row):null;
  }
  /** Reserve BEFORE any native or worker effect. Keys are never reused, even after failed/unknown. */
  reservePlanStep(input:{planId:string;kind:ChatTaskStepKind;round:number;index:number;live:{accountIdentity:string};proposalId?:string;proposalIds?:readonly string[];inputSha256?:string}):ChatTaskPlanStep{
    const i=ownData(input,['planId','kind','round','index','live'],['proposalId','proposalIds','inputSha256']),live=ownData(i.live,['accountIdentity']);
    const kind=i.kind,round=i.round,index=i.index;
    if(typeof i.planId!=='string'||!['worker','incorporation','evidence'].includes(kind as string)||!Number.isSafeInteger(round)||(round as number)<1||(round as number)>CHAT_TASK_PLAN_POLICY.rounds||
      !Number.isSafeInteger(index)||(index as number)<0||(index as number)>=(kind==='worker'?CHAT_TASK_PLAN_POLICY.workersPerRound:1)||
      (kind==='worker')!==(i.proposalId!==undefined)||(kind==='incorporation')!==(i.proposalIds!==undefined)||
      i.inputSha256!==undefined&&(kind!=='incorporation'||!hash.safeParse(i.inputSha256).success))planFail('INPUT','Invalid plan step reservation.');
    const proposalIds=kind==='incorporation'?ownArray(i.proposalIds,CHAT_TASK_PLAN_POLICY.workersPerRound).map(v=>{if(typeof v!=='string')planFail('INPUT','Invalid fan-in.');return v as string;}):null;
    return this.#planTx(()=>{
      const{record:plan}=this.#planRow(i.planId as string);
      if(plan.state!=='active')planFail('PLAN_INACTIVE','The plan no longer accepts reservations.');
      this.#bindingCurrent(plan,this.get(plan.taskId),live.accountIdentity);
      const steps=this.#stepRows(plan.id).map(row=>row.record),key=kind+':'+round+':'+index;
      if(steps.some(s=>s.key===key))planFail('DUPLICATE','This plan step was already reserved; it is never replayed.');
      if(steps.length>=CHAT_TASK_PLAN_LIMITS.stepsPerPlan||Number((this.#db.prepare('SELECT count(*) AS n FROM chat_task_plan_steps').get() as {n:number}).n)>=CHAT_TASK_PLAN_LIMITS.steps)planFail('FULL','Task plan step journal is full.');
      const inFlight=steps.filter(s=>s.state==='reserved'||s.state==='acknowledged'&&s.kind!=='evidence');
      const review=steps.find(s=>s.kind==='evidence');
      if(review&&(kind!=='incorporation'||review.state!=='acknowledged'||round!==review.round))planFail('ORDER','Only the final parent may consume the bound evidence handoff.');
      const incorporation=(r:number)=>steps.find(s=>s.kind==='incorporation'&&s.round===r);
      const priorOpen=(r:number)=>{const prior=incorporation(r-1);return r===1||prior?.state==='completed'&&prior.terminal==='completed';};
      let extra:Partial<ChatTaskPlanStep>={};
      if(kind==='worker'){
        if(inFlight.some(s=>s.kind!=='worker'||s.round!==round)||incorporation(round as number)||!priorOpen(round as number))planFail('ORDER','Workers run only in the current open round.');
        if(steps.filter(s=>s.kind==='worker').length>=CHAT_TASK_PLAN_POLICY.workerAttempts)planFail('BUDGET','Worker attempt budget exhausted.');
        const proposal=typeof i.proposalId==='string'?this.#proposalById(i.proposalId):null;
        if(!proposal||proposal.taskId!==plan.taskId||proposal.state!=='reserved'||steps.some(s=>s.proposalId===proposal.id)||
          this.#db.prepare("SELECT 1 FROM chat_task_plan_steps WHERE json_extract(payload,'$.proposalId')=?").get(proposal.id))
          planFail('ORDER','A worker step links one exact reserved proposal attempt of this task.');
        extra={proposalId:proposal!.id};
      }else if(kind==='incorporation'){
        const workers=steps.filter(s=>s.kind==='worker'&&s.round===round);
        if(inFlight.length||!priorOpen(round as number)||!workers.length||steps.filter(s=>s.kind==='incorporation').length>=CHAT_TASK_PLAN_POLICY.parentSteps)planFail('ORDER','Incorporation needs every worker of its round settled.');
        extra={fanIn:this.#fanIn(plan,round as number,steps,proposalIds!)};
      }else{
        const last=steps.filter(s=>s.kind==='incorporation').at(-1);
        const early=last?.round===(round as number)-1&&round===CHAT_TASK_PLAN_POLICY.rounds&&!incorporation(round as number)&&
          steps.some(s=>s.kind==='worker'&&s.round===round);
        if(inFlight.length||!last||last.round!==round&&!early||last.state!=='completed'||last.terminal!=='completed'||review)planFail('ORDER','Evidence follows a successful parent and settled workers once.');
      }
      const now=new Date().toISOString(),record:ChatTaskPlanStep={id:randomUUID(),planId:plan.id,taskId:plan.taskId,key,seq:steps.length+1,kind:kind as ChatTaskStepKind,
        round:round as number,index:index as number,state:'reserved',reason:null,proposalId:null,fanIn:null,inputSha256:typeof i.inputSha256==='string'?i.inputSha256:null,
        native:null,terminal:null,evidence:null,...extra,createdAt:now,updatedAt:now};
      this.#writeStep(record,null);
      return this.#stepRows(plan.id).find(row=>row.record.id===record.id)!.record;
    });
  }
  #stepById(stepId:unknown):{record:ChatTaskPlanStep;payload:string}{
    if(typeof stepId!=='string')planFail('INPUT','Invalid step.');
    const row=this.#db.prepare('SELECT id,plan_id,step_key,seq,payload FROM chat_task_plan_steps WHERE id=?').get(stepId as string) as StepRow|undefined;
    if(!row)planFail('TASK_SCOPE','Unknown task plan step.');
    const record=this.#parseStep(row!);this.#stepRows(record.planId);
    return{record,payload:row!.payload};
  }
  /** Exact owned native operation/turn (incorporation) or evidence-review reference (evidence). */
  acknowledgePlanStep(input:{stepId:string;native?:{operationId:string;turnId:string};evidence?:{runId:string}}):ChatTaskPlanStep{
    const i=ownData(input,['stepId'],['native','evidence']);
    const native=i.native===undefined?null:ownData(i.native,['operationId','turnId']),evidence=i.evidence===undefined?null:ownData(i.evidence,['runId']);
    return this.#planTx(()=>{
      const{record,payload}=this.#stepById(i.stepId);
      if(record.state!=='reserved'||(record.kind==='incorporation')!==(native!==null)||(record.kind==='evidence')!==(evidence!==null)||record.kind==='worker')planFail('STATE','Only a reserved parent or evidence step can be acknowledged.');
      const next:ChatTaskPlanStep={...record,state:'acknowledged',native:native as ChatTaskPlanStep['native'],evidence:evidence as ChatTaskPlanStep['evidence'],updatedAt:new Date().toISOString()};
      this.#writeStep(next,payload);
      if(record.kind==='evidence'){const plan=this.#planRow(record.planId);
        if(plan.record.state==='active'&&this.#stepRows(record.planId).some(row=>row.record.kind==='incorporation'&&row.record.round===record.round&&row.record.state==='completed'&&row.record.terminal==='completed'))
          this.#writePlan({...plan.record,state:'awaiting_review',updatedAt:next.updatedAt},plan.payload);}
      return this.#stepById(record.id).record;
    });
  }
  /** Settle only from observed outcomes. Terminal results are immutable; unknown never becomes known. */
  settlePlanStep(input:{stepId:string;outcome:{state:'completed';terminal:'completed'|'failed'}|{state:'failed'|'unknown';reason:ChatTaskStepReason}}):ChatTaskPlanStep{
    const i=ownData(input,['stepId','outcome']),outcome=ownData(i.outcome,['state'],['terminal','reason']);
    return this.#planTx(()=>{
      const{record,payload}=this.#stepById(i.stepId);
      if(record.kind==='worker')planFail('STATE','Worker steps settle from their proposal row.');
      const now=new Date().toISOString();let next:ChatTaskPlanStep;
      if(outcome.state==='completed'&&record.kind==='incorporation'&&record.state==='acknowledged'&&(outcome.terminal==='completed'||outcome.terminal==='failed')&&outcome.reason===undefined)
        next={...record,state:'completed',terminal:outcome.terminal,updatedAt:now};
      else if(outcome.state==='failed'&&record.state==='reserved'&&outcome.terminal===undefined&&(record.kind==='incorporation'?outcome.reason==='not_dispatched':outcome.reason==='not_requested'))
        next={...record,state:'failed',reason:outcome.reason as ChatTaskStepReason,updatedAt:now};
      else if(outcome.state==='unknown'&&(record.state==='reserved'||record.state==='acknowledged'&&record.kind==='incorporation')&&outcome.terminal===undefined&&
        (record.kind==='incorporation'?['dispatch_uncertain','terminal_unobserved'].includes(outcome.reason as string):outcome.reason==='request_uncertain'))
        next={...record,state:'unknown',reason:outcome.reason as ChatTaskStepReason,updatedAt:now};
      else planFail('STATE','This plan step outcome is not allowed from its current state.');
      this.#writeStep(next!,payload);
      if(next!.state==='unknown'){const plan=this.#planRow(record.planId);if(plan.record.state==='active')this.#writePlan({...plan.record,state:'unknown',reason:'step_unknown',updatedAt:now},plan.payload);}
      else if(next!.state==='completed'&&next!.terminal==='completed'){
        const plan=this.#planRow(record.planId);
        if(plan.record.state==='active'&&this.#stepRows(record.planId).some(row=>row.record.kind==='evidence'&&row.record.round===record.round&&row.record.state==='acknowledged'))
          this.#writePlan({...plan.record,state:'awaiting_review',updatedAt:now},plan.payload);
      }
      return this.#stepById(record.id).record;
    });
  }
  /** Mirror the linked proposal's terminal row; an orphan or still-reserved proposal stays unsettled. */
  syncWorkerStep(input:{stepId:string}):ChatTaskPlanStep{
    const i=ownData(input,['stepId']);
    return this.#planTx(()=>{
      const{record,payload}=this.#stepById(i.stepId);
      if(record.kind!=='worker'||record.state!=='reserved')planFail('STATE','Only a reserved worker step can be synchronized.');
      const proposal=this.#proposalById(record.proposalId!);
      if(!proposal||proposal.taskId!==record.taskId)planFail('CORRUPT','Worker step lost its proposal row.');
      if(proposal!.state==='reserved')return record;
      const next:ChatTaskPlanStep=proposal!.state==='proposed'?{...record,state:'completed',updatedAt:new Date().toISOString()}
        :{...record,state:proposal!.state==='failed'?'failed':'unknown',reason:proposal!.state==='failed'?'worker_failed':'worker_unknown',updatedAt:new Date().toISOString()};
      this.#writeStep(next,payload);
      if(next.state==='unknown'){const plan=this.#planRow(record.planId);if(plan.record.state==='active')this.#writePlan({...plan.record,state:'unknown',reason:'step_unknown',updatedAt:next.updatedAt},plan.payload);}
      return this.#stepById(record.id).record;
    });
  }
  /** Retirement, repair reservation, binding change or budget end: no further reservations. Idempotent. */
  stopPlan(input:{planId:string;reason:ChatTaskPlanReason}):ChatTaskPlanRecord{
    const i=ownData(input,['planId','reason']);
    if(!CHAT_TASK_PLAN_REASONS.includes(i.reason as ChatTaskPlanReason)||i.reason==='daemon_restarted'||i.reason==='step_unknown')planFail('INPUT','Invalid stop reason.');
    return this.#planTx(()=>{
      const{record,payload}=this.#planRow(i.planId as string);
      if(record.state!=='active')return record;
      this.#writePlan({...record,state:'stopped',reason:i.reason as ChatTaskPlanReason,updatedAt:new Date().toISOString()},payload);
      return this.#planRow(record.id).record;
    });
  }
  close(): void { if (!this.#closed) { this.#closed = true;try{this.#db.prepare('DELETE FROM chat_task_owner WHERE token=?').run(this.#owner);}finally{this.#db.close();} } }
}
