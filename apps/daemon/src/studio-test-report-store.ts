import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { types } from 'node:util';
import { z } from 'zod';
import { bindingSchema, codes, digest, freeze, logSummarySchema, proposalSchema } from '../../../packages/studio-test-controller/src/contracts.js';
import { scenarioEvidenceIssue, scenarioReviewSchema, type ScenarioCapture } from '../../../packages/studio-test-controller/src/scenario.js';
import type { ConsentDisplay } from '../../../packages/studio-test-controller/src/ledger.js';
import type { TestReview } from '../../../packages/studio-test-controller/src/controller.js';

export const STUDIO_TEST_REPORT_LIMITS = Object.freeze({ reports: 256, reportBytes: 256 * 1024, totalBytes: 64 * 1024 * 1024,
  pageSize: 8, listBytes: 32 * 1024, responseBytes: 272 * 1024, databaseBytes: 80 * 1024 * 1024, protectedJobs: 64 });
export const STUDIO_TEST_REPORT_ARCHIVE_CODES = ['ARCHIVE_UNAVAILABLE','ARCHIVE_WRITE','ARCHIVE_CORRUPT','ARCHIVE_LIMIT','ARCHIVE_INPUT','ARCHIVE_CONFLICT'] as const;
export type StudioTestReportArchiveCode = typeof STUDIO_TEST_REPORT_ARCHIVE_CODES[number];
export type StudioTestReportArchiveStatus = Readonly<{state:'ready';code:null}|{state:'degraded'|'unavailable';code:StudioTestReportArchiveCode}>;
export type StudioTestReportArchiveResult = Readonly<{stored:true}|{stored:false;code:StudioTestReportArchiveCode}>;
export interface StudioTestHistoricalReport {
  readonly schemaVersion:1; readonly kind:'studio-playtest-report'; readonly projectId:string; readonly jobId:string; readonly taskId:string|null;
  readonly createdAt:string; readonly observedAt:string; readonly snapshot:'admission'|'terminal'; readonly targetName:string;
  readonly observedState:'needs_approval'|'running'|'complete'|'cancelled'; readonly display:Readonly<ConsentDisplay>; readonly displayDigest:string;
  readonly review:Readonly<TestReview>; readonly evidence:'fixture'|'native'; readonly nativeAcceptance:false; readonly historicalDigest:string;
}
export type StudioTestReportSummary = Readonly<Pick<StudioTestHistoricalReport,'jobId'|'taskId'|'createdAt'|'observedAt'|'snapshot'|'targetName'|'observedState'|'evidence'|'nativeAcceptance'|'historicalDigest'> & {
  outcome:TestReview['outcome']; code:TestReview['code']; cleanup:TestReview['cleanup'];
}>;
export interface StudioTestReportPage {
  readonly schemaVersion:1; readonly projectId:string; readonly archive:StudioTestReportArchiveStatus; readonly reports:readonly StudioTestReportSummary[];
  readonly nextCursor:string|null; readonly omittedReports:number;
}
export interface StudioTestReportCursor {readonly version:1;readonly projectId:string;readonly beforeSequence:number}
export interface StudioTestReportWriter {
  readonly projectId:string;
  recordAdmission(snapshot:unknown,protectedJobIds:readonly string[]):StudioTestReportArchiveResult;
  recordTerminal(snapshot:unknown):StudioTestReportArchiveResult;
  noteFailure(code:StudioTestReportArchiveCode):void;
}
export interface StudioTestReportStore extends StudioTestReportWriter {
  status():StudioTestReportArchiveStatus;
  list(input:unknown,guard:()=>void):StudioTestReportPage;
  get(jobId:string,guard:()=>void):StudioTestHistoricalReport|null;
  captureDescriptor(jobId:string,guard:()=>void):ScenarioCapture|null;
  close():void;
}
export class StudioTestReportError extends Error {
  constructor(readonly code:StudioTestReportArchiveCode|'CURSOR_INVALID'){super(code);this.name='StudioTestReportError';}
}
const fail=(code:StudioTestReportArchiveCode|'CURSOR_INVALID'):never=>{throw new StudioTestReportError(code);};
const hash=z.string().regex(/^[a-f0-9]{64}(?![\s\S])/), uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/);
const time=z.string().datetime(), integer=z.number().int().nonnegative().safe();
const displaySchema=z.strictObject({proposal:proposalSchema,cleanupGraceMs:z.number().int().min(1).max(15000),requestTimeoutMs:z.number().int().min(1).max(15000),
  proofMaxAgeMs:z.number().int().min(1).max(15000),consentExpiresAt:integer,guarantee:z.literal('observed-non-atomic'),
  actions:z.union([z.tuple([z.literal('start'),z.literal('observe-state-and-console'),z.literal('stop-owned-play')]),
    z.tuple([z.literal('start'),z.literal('execute-approved-scenario'),z.literal('observe-state-and-console'),z.literal('capture-viewport'),z.literal('stop-owned-play'),z.literal('restore-temporary-changes')])]),
  raceDisclosure:z.literal('Observed checks cannot atomically fence the native call.')});
const reviewSchema=z.strictObject({runId:z.string().min(1).max(128).nullable(),evidence:z.enum(['fixture','native']),nativeAcceptance:z.literal(false),binding:bindingSchema.nullable(),scopeDigest:hash.nullable(),
  phase:z.enum(['idle','admitting','starting','observing','waiting','stopping','done']),outcome:z.enum(['succeeded','failed','cancelled','timed_out','rejected']).nullable(),code:z.enum(codes),
  cleanup:z.enum(['not_started','running','complete','unknown']),startedAt:integer.nullable(),deadline:integer.nullable(),cleanupDeadline:integer.nullable(),
  watchdog:z.strictObject({armed:z.boolean(),fired:z.boolean(),reason:z.enum(codes).nullable()}),observations:integer.max(128),logs:z.array(logSummarySchema).max(128),logsTruncated:z.boolean(),
  requiresHumanReview:z.boolean(),canStartAnotherOperation:z.boolean(),scenario:scenarioReviewSchema.optional()});
const contentSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('studio-playtest-report'),projectId:hash,jobId:uuid,taskId:uuid.nullable(),createdAt:time,observedAt:time,
  snapshot:z.enum(['admission','terminal']),targetName:z.string().min(1).max(512),observedState:z.enum(['needs_approval','running','complete','cancelled']),
  display:displaySchema,displayDigest:hash,review:reviewSchema,evidence:z.enum(['fixture','native']),nativeAcceptance:z.literal(false)});
const reportSchema=contentSchema.extend({historicalDigest:hash});

/** Descriptor-only bounded copy before any schema reads. No caller iterator/toJSON/getter is invoked. */
function data(value:unknown):unknown {
  let nodes=0,bytes=0;const seen=new Set<object>();
  const charge=(n:number)=>{bytes+=n;if(bytes>STUDIO_TEST_REPORT_LIMITS.reportBytes)fail('ARCHIVE_LIMIT');};
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>32768||depth>32)fail('ARCHIVE_INPUT');
    if(v===null||typeof v==='boolean'){charge(JSON.stringify(v).length);return v;}
    if(typeof v==='number'){if(!Number.isFinite(v))fail('ARCHIVE_INPUT');charge(JSON.stringify(v).length);return v;}
    if(typeof v==='string'){if(v.length>16384)fail('ARCHIVE_LIMIT');charge(Buffer.byteLength(JSON.stringify(v)));return v;}
    if(typeof v!=='object'||types.isProxy(v)||seen.has(v))fail('ARCHIVE_INPUT');
    const proto=Object.getPrototypeOf(v),array=Array.isArray(v);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('ARCHIVE_INPUT');
    seen.add(v);charge(2);
    const keys=Reflect.ownKeys(v),out:Record<string,unknown>=Object.create(null);
    if(array){
      const ld=Object.getOwnPropertyDescriptor(v,'length');if(!ld||!Object.hasOwn(ld,'value')||!Number.isSafeInteger(ld.value)||ld.value<0||ld.value>256||keys.length!==ld.value+1)fail('ARCHIVE_INPUT');
      const result:unknown[]=[];
      for(let i=0;i<ld.value;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('ARCHIVE_INPUT');charge(1);result.push(copy(d.value,depth+1));}
      seen.delete(v);return result;
    }
    if(keys.length>128)fail('ARCHIVE_INPUT');
    for(const key of keys){if(typeof key!=='string'||key.length>128||['__proto__','prototype','constructor'].includes(key))fail('ARCHIVE_INPUT');
      const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('ARCHIVE_INPUT');charge(Buffer.byteLength(JSON.stringify(key))+2);out[key]=copy(d.value,depth+1);}
    seen.delete(v);return out;
  };
  return copy(value,0);
}
function domain(r:StudioTestHistoricalReport):void {
  if(Date.parse(r.observedAt)<Date.parse(r.createdAt)||digest(r.display)!==r.displayDigest||r.evidence!==r.review.evidence)fail('ARCHIVE_INPUT');
  const {durationMs,observationIntervalMs}=r.display.proposal,maximumObservations=Math.ceil(durationMs/observationIntervalMs);
  if(observationIntervalMs>durationMs||maximumObservations>128||r.review.observations>maximumObservations||r.snapshot==='admission'&&r.review.observations!==0)fail('ARCHIVE_INPUT');
  if(r.review.binding&&digest(r.review.binding)!==digest(r.display.proposal.binding)||r.review.scopeDigest!==null&&r.review.scopeDigest!==r.displayDigest)fail('ARCHIVE_INPUT');
  if(r.review.runId===null){if(r.review.binding!==null||r.review.scopeDigest!==null||r.review.startedAt!==null||r.review.deadline!==null||r.review.cleanupDeadline!==null)fail('ARCHIVE_INPUT');}
  else if(r.review.binding===null||r.review.scopeDigest!==r.displayDigest||r.review.startedAt===null||r.review.deadline===null||r.review.cleanupDeadline===null||r.review.deadline!==r.review.startedAt+r.display.proposal.durationMs||
    r.review.cleanupDeadline!==r.review.deadline+r.display.cleanupGraceMs)fail('ARCHIVE_INPUT');
  const plan=r.display.proposal.scenario,scenario=r.review.scenario;
  if(!!plan!==!!scenario||!!plan!==(r.display.actions.length===6)||!!plan!==(r.display.proposal.subjectDigest!==undefined))fail('ARCHIVE_INPUT');
  if(plan&&scenario){
    if(scenario.scenarioDigest!==digest(plan)||scenario.subjectDigest!==r.display.proposal.subjectDigest||
      scenarioEvidenceIssue(plan,scenario.steps,scenario.state==='passed',scenario.inputRelease,r.review.code)!==null||
      scenario.capture!==null&&(!plan.capture.required||scenario.capture.id!==r.review.runId))fail('ARCHIVE_INPUT');
    if(r.review.outcome==='succeeded'&&(scenario.state!=='passed'||plan.capture.required))fail('ARCHIVE_INPUT');
  }
  if(r.review.canStartAnotherOperation&&(r.review.phase!=='done'||r.review.requiresHumanReview||r.review.cleanup!=='complete'))fail('ARCHIVE_INPUT');
  if(r.review.outcome==='succeeded'&&r.review.code!=='OK')fail('ARCHIVE_INPUT');
  if(r.snapshot==='admission'&&(r.observedState!=='needs_approval'||r.review.runId!==null||r.review.phase!=='idle'||r.review.outcome!==null||r.review.cleanup!=='not_started'))fail('ARCHIVE_INPUT');
}
export function parseStudioTestHistoricalReport(value:unknown):StudioTestHistoricalReport {
  const p=reportSchema.safeParse(data(value));if(!p.success)fail('ARCHIVE_INPUT');
  const {historicalDigest,...content}=p.data;if(digest(content)!==historicalDigest)fail('ARCHIVE_INPUT');
  const {scenario,...review}=p.data.review;
  const report:StudioTestHistoricalReport={...p.data,review:scenario===undefined?review:{...review,scenario}};
  domain(report);return freeze(report);
}
export function createStudioTestHistoricalReport(value:unknown):StudioTestHistoricalReport {
  const p=contentSchema.safeParse(data(value));if(!p.success)fail('ARCHIVE_INPUT');
  return parseStudioTestHistoricalReport({...p.data,historicalDigest:digest(p.data)});
}
/** The raw retained decoder rejects duplicates before they can become a normalized valid report. */
function json(raw:string):unknown {
  if(Buffer.byteLength(raw)>STUDIO_TEST_REPORT_LIMITS.reportBytes)fail('ARCHIVE_CORRUPT');
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{fail('ARCHIVE_CORRUPT');}
  let i=0,nodes=0;const ws=()=>{while(/[\x20\t\r\n]/.test(raw[i]??'!'))i++;};
  const string=():string=>{const start=i++;while(i<raw.length){const c=raw[i++];if(c==='\\'){i++;continue;}if(c==='"'){const s:unknown=JSON.parse(raw.slice(start,i));if(typeof s!=='string')fail('ARCHIVE_CORRUPT');return s;}}return fail('ARCHIVE_CORRUPT');};
  const walk=(depth:number):void=>{if(++nodes>32768||depth>32)fail('ARCHIVE_CORRUPT');ws();const c=raw[i];
    if(c==='"'){string();return;}if(c==='{'){i++;ws();const names=new Set<string>();if(raw[i]==='}'){i++;return;}
      for(;;){ws();if(raw[i]!=='"')fail('ARCHIVE_CORRUPT');const key=string();if(names.has(key))fail('ARCHIVE_CORRUPT');names.add(key);ws();if(raw[i++]!==':')fail('ARCHIVE_CORRUPT');walk(depth+1);ws();const end=raw[i++];if(end==='}')return;if(end!==',')fail('ARCHIVE_CORRUPT');}}
    if(c==='['){i++;ws();if(raw[i]===']'){i++;return;}for(;;){walk(depth+1);ws();const end=raw[i++];if(end===']')return;if(end!==',')fail('ARCHIVE_CORRUPT');}}
    while(i<raw.length&&!/[\s,}\]]/.test(raw[i]!))i++;
  };walk(0);ws();if(i!==raw.length)fail('ARCHIVE_CORRUPT');return parsed;
}
export function parseStudioTestReportCursor(value:unknown,projectId:string):StudioTestReportCursor|null {
  if(!hash.safeParse(projectId).success)fail('CURSOR_INVALID');if(value===null)return null;
  if(typeof value!=='string'||value.length>100)fail('CURSOR_INVALID');
  const m=/^1\.([a-f0-9]{64})\.([1-9][0-9]{0,15})(?![\s\S])/.exec(value);if(!m||m[1]!==projectId)fail('CURSOR_INVALID');
  const sequence=Number(m[2]);if(!Number.isSafeInteger(sequence)||sequence<1)fail('CURSOR_INVALID');return Object.freeze({version:1,projectId,beforeSequence:sequence});
}
const APP_ID=0x41525054;
const META='CREATE TABLE report_meta(id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,next_sequence INTEGER NOT NULL,omitted_reports INTEGER NOT NULL) STRICT';
const RECORDS='CREATE TABLE report_records(job_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE,task_id TEXT,historical_digest TEXT NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=262144)) STRICT';
const live=new Set<string>();
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function directoryCheck(directory:string):void {
  if(!isAbsolute(directory)||directory.length>2048||/[\u0000-\u001f]/.test(directory)||!samePath(resolve(directory),directory))fail('ARCHIVE_UNAVAILABLE');
  const segments=directory.slice(parse(directory).root.length).split(/[\\/]/);
  if(segments.some(s=>!s||s==='.'||s==='..'||/[:*?"<>|]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))fail('ARCHIVE_UNAVAILABLE');
  const chain:string[]=[];for(let p=directory;;p=dirname(p)){chain.push(p);if(p===dirname(p))break;}
  for(const p of chain.reverse()){try{const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())fail('ARCHIVE_UNAVAILABLE');}catch(e){if(!(e instanceof Error&&'code'in e&&e.code==='ENOENT'))throw e;}}
}
function filesCheck(directory:string):void {
  directoryCheck(directory);if(!samePath(realpathSync(directory),directory))fail('ARCHIVE_UNAVAILABLE');
  const names=readdirSync(directory);if(names.length>2||names.some(n=>n!=='reports.sqlite'&&n!=='reports.sqlite-journal'))fail('ARCHIVE_CORRUPT');
  for(const n of names){const s=lstatSync(join(directory,n));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>STUDIO_TEST_REPORT_LIMITS.databaseBytes)fail('ARCHIVE_CORRUPT');}
}
type Row=ReturnType<ReturnType<DatabaseSync['prepare']>['all']>[number];
function parsedRow(row:Row,projectId:string):{sequence:number;report:StudioTestHistoricalReport;bytes:number} {
  if(typeof row.payload!=='string'||typeof row.sequence!=='number'||!Number.isSafeInteger(row.sequence)||row.sequence<1)fail('ARCHIVE_CORRUPT');
  let report:StudioTestHistoricalReport;try{report=parseStudioTestHistoricalReport(json(row.payload));}catch{fail('ARCHIVE_CORRUPT');}
  if(report.projectId!==projectId||report.jobId!==row.job_id||report.taskId!==row.task_id||report.historicalDigest!==row.historical_digest)fail('ARCHIVE_CORRUPT');
  return {sequence:row.sequence,report,bytes:Buffer.byteLength(row.payload)};
}
function metadata(db:DatabaseSync,projectId:string):{next:number;omitted:number} {
  const row=db.prepare('SELECT * FROM report_meta').get();
  if(!row||row.id!==1||row.project_id!==projectId||typeof row.next_sequence!=='number'||!Number.isSafeInteger(row.next_sequence)||row.next_sequence<1||
    typeof row.omitted_reports!=='number'||!Number.isSafeInteger(row.omitted_reports)||row.omitted_reports<0||db.prepare('SELECT COUNT(*) AS n FROM report_meta').get()?.n!==1)fail('ARCHIVE_CORRUPT');
  return {next:row.next_sequence,omitted:row.omitted_reports};
}
function validateDatabase(db:DatabaseSync,projectId:string,readRecords=true):void {
  if(db.prepare('PRAGMA application_id').get()?.application_id!==APP_ID||db.prepare('PRAGMA user_version').get()?.user_version!==1||db.prepare('PRAGMA page_size').get()?.page_size!==4096)fail('ARCHIVE_CORRUPT');
  const schema=db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
  if(schema.length!==2||schema[0]?.name!=='report_meta'||schema[0]?.type!=='table'||schema[0]?.tbl_name!=='report_meta'||schema[0]?.sql!==META||
    schema[1]?.name!=='report_records'||schema[1]?.type!=='table'||schema[1]?.tbl_name!=='report_records'||schema[1]?.sql!==RECORDS)fail('ARCHIVE_CORRUPT');
  const meta=metadata(db,projectId),count=db.prepare('SELECT COUNT(*) AS n FROM report_records').get()?.n;
  if(typeof count!=='number'||count>STUDIO_TEST_REPORT_LIMITS.reports)fail('ARCHIVE_CORRUPT');
  if(!readRecords)return;
  if(db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check!=='ok')fail('ARCHIVE_CORRUPT');
  let bytes=0;for(const row of db.prepare('SELECT * FROM report_records ORDER BY sequence').all()){const p=parsedRow(row,projectId);if(p.sequence>=meta.next)fail('ARCHIVE_CORRUPT');bytes+=p.bytes;}
  if(bytes>STUDIO_TEST_REPORT_LIMITS.totalBytes)fail('ARCHIVE_CORRUPT');
}
class ReportStore implements StudioTestReportStore {
  readonly projectId:string;#db:DatabaseSync;#directory:string;#key:string;#writer:()=>boolean;#closed=false;
  #identity:{dev:number;ino:number};
  #protected:readonly string[]=[];
  #status:StudioTestReportArchiveStatus=Object.freeze({state:'ready',code:null});
  constructor(db:DatabaseSync,directory:string,projectId:string,writer:()=>boolean,key:string){this.#db=db;this.#directory=directory;this.#writer=writer;this.#key=key;
    const stat=lstatSync(join(directory,'reports.sqlite'));this.#identity={dev:stat.dev,ino:stat.ino};
    this.projectId=projectId;Object.defineProperty(this,'projectId',{value:projectId,writable:false,configurable:false,enumerable:true});}
  status():StudioTestReportArchiveStatus{return this.#status;}
  noteFailure(code:StudioTestReportArchiveCode):void{this.#status=Object.freeze({state:'degraded',code:STUDIO_TEST_REPORT_ARCHIVE_CODES.find(value=>value===code)??'ARCHIVE_WRITE'});}
  #check():void{if(this.#closed)fail('ARCHIVE_UNAVAILABLE');filesCheck(this.#directory);const stat=lstatSync(join(this.#directory,'reports.sqlite'));
    if(stat.dev!==this.#identity.dev||stat.ino!==this.#identity.ino)fail('ARCHIVE_CORRUPT');validateDatabase(this.#db,this.projectId,false);}
  #read<T>(guard:()=>void,read:()=>T):T{guard();let result:T;try{this.#check();validateDatabase(this.#db,this.projectId);result=read();}catch(e){if(e instanceof StudioTestReportError&&e.code==='CURSOR_INVALID')throw e;
      const code=e instanceof StudioTestReportError?e.code:'ARCHIVE_CORRUPT';this.noteFailure(code);throw new StudioTestReportError(code);}
    guard();return result;}
  #write(snapshot:unknown,kind:'admission'|'terminal',protectedJobIds:readonly string[]):StudioTestReportArchiveResult {
    let transaction=false;
    try{
      this.#check();if(!this.#writer())fail('ARCHIVE_UNAVAILABLE');
      const report=parseStudioTestHistoricalReport(snapshot);if(report.projectId!==this.projectId||report.snapshot!==kind)fail('ARCHIVE_INPUT');
      const pins=z.array(uuid).max(STUDIO_TEST_REPORT_LIMITS.protectedJobs).safeParse(data(kind==='admission'?protectedJobIds:this.#protected));if(!pins.success||new Set(pins.data).size!==pins.data.length)fail('ARCHIVE_INPUT');
      if(kind==='admission')this.#protected=Object.freeze([...pins.data]);
      const payload=JSON.stringify(report),bytes=Buffer.byteLength(payload);if(bytes>STUDIO_TEST_REPORT_LIMITS.reportBytes)fail('ARCHIVE_LIMIT');
      this.#db.exec('BEGIN IMMEDIATE');transaction=true;validateDatabase(this.#db,this.projectId);
      const meta=metadata(this.#db,this.projectId),row=this.#db.prepare('SELECT * FROM report_records WHERE job_id=?').get(report.jobId);
      if(row){const before=parsedRow(row,this.projectId).report;
        if(before.historicalDigest===report.historicalDigest){this.#db.exec('COMMIT');transaction=false;return Object.freeze({stored:true});}
        if(before.snapshot==='terminal'||kind==='admission'||before.taskId!==report.taskId||before.createdAt!==report.createdAt||before.displayDigest!==report.displayDigest||
          before.targetName!==report.targetName||before.evidence!==report.evidence)fail('ARCHIVE_CONFLICT');
        this.#db.prepare('UPDATE report_records SET historical_digest=?,payload=? WHERE job_id=?').run(report.historicalDigest,payload,report.jobId);
      }else{
        if(meta.next>=Number.MAX_SAFE_INTEGER)fail('ARCHIVE_LIMIT');
        const rows=this.#db.prepare('SELECT job_id,task_id FROM report_records ORDER BY sequence').all();
        if(rows.length>=STUDIO_TEST_REPORT_LIMITS.reports){
          const old=rows.find(r=>r.task_id===null&&typeof r.job_id==='string'&&!pins.data.includes(r.job_id));
          if(!old||typeof old.job_id!=='string'||meta.omitted>=Number.MAX_SAFE_INTEGER)fail('ARCHIVE_LIMIT');
          this.#db.prepare('DELETE FROM report_records WHERE job_id=? AND task_id IS NULL').run(old.job_id);
          this.#db.prepare('UPDATE report_meta SET omitted_reports=omitted_reports+1 WHERE id=1').run();
        }
        this.#db.prepare('INSERT INTO report_records VALUES(?,?,?,?,?)').run(report.jobId,meta.next,report.taskId,report.historicalDigest,payload);
        this.#db.prepare('UPDATE report_meta SET next_sequence=? WHERE id=1').run(meta.next+1);
      }
      if(Number(this.#db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM report_records').get()?.n)>STUDIO_TEST_REPORT_LIMITS.totalBytes)fail('ARCHIVE_LIMIT');
      this.#db.exec('COMMIT');transaction=false;return Object.freeze({stored:true});
    }catch(e){if(transaction)try{this.#db.exec('ROLLBACK');}catch{/* Original archive refusal remains separate from native evidence. */}
      const code=e instanceof StudioTestReportError&&e.code!=='CURSOR_INVALID'?e.code:'ARCHIVE_WRITE';this.noteFailure(code);return Object.freeze({stored:false,code});}
  }
  recordAdmission(snapshot:unknown,protectedJobIds:readonly string[]):StudioTestReportArchiveResult{return this.#write(snapshot,'admission',protectedJobIds);}
  recordTerminal(snapshot:unknown):StudioTestReportArchiveResult{return this.#write(snapshot,'terminal',[]);}
  get(jobId:string,guard:()=>void):StudioTestHistoricalReport|null{return this.#read(guard,()=>{if(!uuid.safeParse(jobId).success)fail('ARCHIVE_INPUT');
    const row=this.#db.prepare('SELECT * FROM report_records WHERE job_id=?').get(jobId);return row?parsedRow(row,this.projectId).report:null;});}
  captureDescriptor(jobId:string,guard:()=>void):ScenarioCapture|null{return this.get(jobId,guard)?.review.scenario?.capture??null;}
  list(input:unknown,guard:()=>void):StudioTestReportPage{return this.#read(guard,()=>{
    const args=z.strictObject({cursor:z.string().max(100).nullable()}).safeParse(data(input));if(!args.success)fail('CURSOR_INVALID');
    const cursor=parseStudioTestReportCursor(args.data.cursor,this.projectId),meta=metadata(this.#db,this.projectId);
    if(cursor&&!this.#db.prepare('SELECT 1 AS n FROM report_records WHERE sequence=?').get(cursor.beforeSequence))fail('CURSOR_INVALID');
    const rows=this.#db.prepare('SELECT * FROM report_records WHERE sequence<? ORDER BY sequence DESC LIMIT ?').all(cursor?.beforeSequence??meta.next,STUDIO_TEST_REPORT_LIMITS.pageSize+1);
    const shown=rows.slice(0,STUDIO_TEST_REPORT_LIMITS.pageSize).map(r=>parsedRow(r,this.projectId)),reports:StudioTestReportSummary[]=shown.map(({report:r})=>Object.freeze({
      jobId:r.jobId,taskId:r.taskId,createdAt:r.createdAt,observedAt:r.observedAt,snapshot:r.snapshot,targetName:r.targetName,observedState:r.observedState,evidence:r.evidence,
      nativeAcceptance:false,historicalDigest:r.historicalDigest,outcome:r.review.outcome,code:r.review.code,cleanup:r.review.cleanup}));
    const last=shown.at(-1),page:StudioTestReportPage=freeze({schemaVersion:1,projectId:this.projectId,archive:this.status(),reports,
      nextCursor:rows.length>STUDIO_TEST_REPORT_LIMITS.pageSize&&last?`1.${this.projectId}.${last.sequence}`:null,omittedReports:meta.omitted});
    if(Buffer.byteLength(JSON.stringify(page))>STUDIO_TEST_REPORT_LIMITS.listBytes)fail('ARCHIVE_LIMIT');return page;
  });}
  close():void{if(this.#closed)return;this.#closed=true;try{this.#db.close();live.delete(this.#key);}catch{
      this.#status=Object.freeze({state:'unavailable',code:'ARCHIVE_WRITE'});throw new StudioTestReportError('ARCHIVE_WRITE');}}
}
export async function openStudioTestReportStore(options:{directory:string;projectId:string;exclusiveWriter:()=>boolean}):Promise<StudioTestReportStore> {
  let db:DatabaseSync|undefined,key:string|undefined,claimed=false;
  try{
    if(!hash.safeParse(options.projectId).success||typeof options.exclusiveWriter!=='function'||!options.exclusiveWriter())fail('ARCHIVE_UNAVAILABLE');
    const directory=resolve(options.directory);directoryCheck(options.directory);mkdirSync(directory,{recursive:true,mode:0o700});filesCheck(directory);
    key=process.platform==='win32'?directory.toLowerCase():directory;if(live.has(key))fail('ARCHIVE_UNAVAILABLE');live.add(key);claimed=true;
    const path=join(directory,'reports.sqlite'),exists=readdirSync(directory).includes('reports.sqlite');
    if(readdirSync(directory).includes('reports.sqlite-journal'))fail('ARCHIVE_CORRUPT');
    if(exists){const read=new DatabaseSync(path,{readOnly:true});try{validateDatabase(read,options.projectId);}finally{read.close();}}
    if(!options.exclusiveWriter())fail('ARCHIVE_UNAVAILABLE');filesCheck(directory);db=new DatabaseSync(path);
    if(!exists)db.exec('PRAGMA page_size=4096;');
    db.exec('PRAGMA busy_timeout=0;PRAGMA trusted_schema=OFF;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA max_page_count=20480;');
    if(!exists){db.exec('BEGIN IMMEDIATE');try{db.exec(META);db.exec(RECORDS);db.prepare('INSERT INTO report_meta VALUES(1,?,1,0)').run(options.projectId);
      db.exec(`PRAGMA application_id=${APP_ID};PRAGMA user_version=1;`);db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}
    validateDatabase(db,options.projectId);filesCheck(directory);return new ReportStore(db,directory,options.projectId,options.exclusiveWriter,key);
  }catch{let closed=true;try{db?.close();}catch{closed=false;}if(claimed&&key!==undefined&&closed)live.delete(key);fail('ARCHIVE_UNAVAILABLE');}
}
