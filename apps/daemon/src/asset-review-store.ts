import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,realpathSync,type Stats,type BigIntStats} from 'node:fs';
import {isAbsolute,join,parse,resolve,sep} from 'node:path';
import {sqliteTransportPath} from '../../../packages/storage/src/sqlite-path.js';
import {workflowProjectIdentity} from '../../../packages/storage/src/workflow-store.js';
import {ASSET_REVIEW_LIMITS,assetReviewCanonical,assetReviewDigest,assetReviewFailure,assetReviewFields,
  assetReviewFreeze,assetReviewUuid,snapshotAssetReviewDecision,snapshotAssetReviewReference,snapshotAssetReviewSubject,
  type AssetReviewDecisionInput,type AssetReviewDecisionReceipt,type AssetReviewGate,type AssetReviewReceiptAuthority,
  type AssetReviewReference,type AssetReviewSubject,type AssetReviewView} from './asset-review.js';

export interface AssetReviewHumanCommand extends AssetReviewDecisionInput {
  readonly projectId:string;readonly subjectDigest:string;readonly revision:number;
}
export interface AssetReviewStoreOptions {
  projectPath:string;authority:AssetReviewReceiptAuthority;
  /** Host permit only. A JSON object, truthy result, exception or Promise denies. */
  authorizeHuman?:(command:Readonly<AssetReviewHumanCommand>,proof:unknown)=>boolean;
  now?:()=>number;
}
type Row=Record<string,string|number|null>;
interface SignedCommand {projectId:string;reviewId:string;subjectDigest:string;idempotencyKey:string;decision:'approved'|'rejected';revision:number}
const owners=new Set<string>();
const APPLICATION_ID=0x41524d52;
function direct(path:string,directory:boolean):Stats {
  if(!isAbsolute(path)||path.startsWith('\\\\')||path.startsWith('//'))assetReviewFailure('STORAGE');
  const absolute=resolve(path);let current=parse(absolute).root;
  for(const part of absolute.slice(current.length).split(sep).filter(Boolean)){
    current=join(current,part);if(!existsSync(current))continue;
    const stat=lstatSync(current);
    const actual=realpathSync(current),same=process.platform==='win32'?actual.toLowerCase()===current.toLowerCase():actual===current;
    if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1||!same)assetReviewFailure('STORAGE');
  }
  const stat=lstatSync(absolute);
  if(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)assetReviewFailure('STORAGE');
  return stat;
}
function stamp(stat:BigIntStats):string {return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');}
function jobKey(subject:AssetReviewSubject):string {return assetReviewDigest({projectId:subject.projectId,conversation:subject.conversation,jobId:subject.jobId});}
function view(input:unknown):AssetReviewView {
  const a=assetReviewFields(input,['reviewId','subject','subjectDigest','status','revision','preparedAt','decidedAt']);
  const subject=snapshotAssetReviewSubject(a.subject);
  if(a.subjectDigest!==assetReviewDigest(subject)||!['pending','approved','rejected'].includes(String(a.status))
    ||typeof a.revision!=='number'||!Number.isSafeInteger(a.revision)||a.revision<0||a.revision>4096
    ||typeof a.preparedAt!=='string'||!Number.isFinite(Date.parse(a.preparedAt))
    ||a.status==='pending'&&(a.revision!==0||a.decidedAt!==null)
    ||a.status!=='pending'&&(a.revision<1||typeof a.decidedAt!=='string'||!Number.isFinite(Date.parse(a.decidedAt))))assetReviewFailure('STORAGE');
  return assetReviewFreeze({reviewId:assetReviewUuid(a.reviewId),subject,subjectDigest:a.subjectDigest,
    status:a.status,revision:a.revision,preparedAt:a.preparedAt,decidedAt:a.decidedAt} as AssetReviewView);
}
function command(input:unknown):SignedCommand {
  const a=assetReviewFields(input,['projectId','reviewId','subjectDigest','idempotencyKey','decision','revision']);
  const decision=snapshotAssetReviewDecision({reviewId:a.reviewId,decision:a.decision,idempotencyKey:a.idempotencyKey});
  const reference=snapshotAssetReviewReference({reviewId:a.reviewId,subjectDigest:a.subjectDigest,revision:a.revision});
  if(typeof a.projectId!=='string'||!/^[a-f0-9]{64}$/.test(a.projectId))assetReviewFailure('STORAGE');
  return {...decision,...reference,projectId:a.projectId};
}
/** One private host writer. Signed durable decisions survive restart; native
 * capabilities never do. Current immutable witnesses make effect checks cheap
 * and synchronous without caching authority across a mutable decision revision. */
export class AssetReviewStore implements AssetReviewGate {
  readonly projectId:string;readonly projectPath:string;
  private readonly db:DatabaseSync;private readonly file:string;private readonly directory:string;private readonly directoryIdentity:string;private readonly owner=randomUUID();private readonly ownerKey:string;
  private readonly reviews=new Map<string,AssetReviewView>();private readonly latest=new Map<string,string>();private readonly commands=new Map<string,SignedCommand>();
  private readonly files=new Map<string,string>();private readonly now:()=>number;private closed=false;private uncertain=false;
  constructor(private readonly options:AssetReviewStoreOptions){
    const project=workflowProjectIdentity(options.projectPath);this.projectId=project.projectId;this.projectPath=project.projectPath;this.now=options.now??Date.now;
    const authority=options.authority;
    if(!authority||typeof authority.sign!=='function'||typeof authority.verify!=='function'||typeof authority.withSnapshot!=='function'||typeof authority.close!=='function')assetReviewFailure('CONFIGURATION');
    direct(authority.directory,true);this.directory=realpathSync(authority.directory);const directory=lstatSync(this.directory,{bigint:true});this.directoryIdentity=[directory.dev,directory.ino].join(':');
    this.file=join(this.directory,'asset-model-reviews-v1.sqlite');this.ownerKey=this.file.toLowerCase();
    if(owners.has(this.ownerKey))assetReviewFailure('OWNER');
    for(const suffix of ['','-wal','-shm'])if(existsSync(this.file+suffix))direct(this.file+suffix,false);
    this.db=new DatabaseSync(sqliteTransportPath(this.file),{timeout:2000,allowExtension:false});
    try{
      const application=Number((this.db.prepare('PRAGMA application_id').get() as Row).application_id);
      const version=Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if(application!==0&&application!==APPLICATION_ID||version>1)assetReviewFailure('STORAGE');
      this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;'+
        'CREATE TABLE IF NOT EXISTS asset_review_meta(id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT;'+
        'CREATE TABLE IF NOT EXISTS asset_review_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL) STRICT;'+
        'CREATE TABLE IF NOT EXISTS asset_reviews(id TEXT PRIMARY KEY,job_key TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL) STRICT;'+
        'CREATE TABLE IF NOT EXISTS asset_review_latest(job_key TEXT PRIMARY KEY,review_id TEXT NOT NULL REFERENCES asset_reviews(id)) STRICT;'+
        'CREATE TABLE IF NOT EXISTS asset_review_commands(key TEXT PRIMARY KEY,payload TEXT NOT NULL,signature TEXT NOT NULL) STRICT;'+
        'PRAGMA application_id='+APPLICATION_ID+';PRAGMA user_version=1;');
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const meta=this.db.prepare('SELECT * FROM asset_review_meta WHERE id=1').get() as Row|undefined;
        if(meta&&(meta.project_id!==this.projectId||meta.project_path!==this.projectPath))assetReviewFailure('SCOPE');
        if(!meta)this.db.prepare('INSERT INTO asset_review_meta VALUES(1,?,?)').run(this.projectId,this.projectPath);
        const prior=this.db.prepare('SELECT pid FROM asset_review_owner WHERE id=1').get() as Row|undefined;
        if(prior){let live=true;try{process.kill(Number(prior.pid),0);}catch(error){live=(error as NodeJS.ErrnoException).code!=='ESRCH';}if(live)assetReviewFailure('OWNER');}
        this.db.prepare('INSERT OR REPLACE INTO asset_review_owner VALUES(1,?,?)').run(process.pid,this.owner);
        if(authority.withSnapshot(()=>this.load())!==undefined)assetReviewFailure('CONFIGURATION');this.db.exec('COMMIT');
      }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
      this.capture();owners.add(this.ownerKey);
    }catch(error){this.db.close();throw error;}
  }
  private load():void {
    let bytes=0;
    for(const row of this.db.prepare('SELECT * FROM asset_reviews').all() as Row[]){
      if(this.reviews.size>=ASSET_REVIEW_LIMITS.reviews||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>ASSET_REVIEW_LIMITS.recordBytes)assetReviewFailure('CAPACITY');
      bytes+=Buffer.byteLength(row.payload);const item=view(JSON.parse(row.payload));
      if(item.reviewId!==row.id||item.subject.projectId!==this.projectId||jobKey(item.subject)!==row.job_key||this.options.authority.verify(item,row.signature)!==true)assetReviewFailure('STORAGE');
      this.reviews.set(item.reviewId,item);
    }
    for(const row of this.db.prepare('SELECT * FROM asset_review_latest').all() as Row[]){
      const item=this.reviews.get(String(row.review_id));if(!item||jobKey(item.subject)!==row.job_key)assetReviewFailure('STORAGE');this.latest.set(String(row.job_key),item.reviewId);
    }
    for(const row of this.db.prepare('SELECT * FROM asset_review_commands').all() as Row[]){
      if(this.commands.size>=ASSET_REVIEW_LIMITS.commands||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>ASSET_REVIEW_LIMITS.recordBytes)assetReviewFailure('CAPACITY');
      bytes+=Buffer.byteLength(row.payload);const item=command(JSON.parse(row.payload)),review=this.reviews.get(item.reviewId);
      if(row.key!==item.idempotencyKey||item.projectId!==this.projectId||!review||review.subjectDigest!==item.subjectDigest
        ||item.revision>review.revision||this.options.authority.verify(item,row.signature)!==true)assetReviewFailure('STORAGE');
      this.commands.set(item.idempotencyKey,assetReviewFreeze(item));
    }
    if(bytes>ASSET_REVIEW_LIMITS.totalBytes)assetReviewFailure('CAPACITY');
  }
  private capture():void {this.files.clear();for(const suffix of ['','-wal','-shm'])if(existsSync(this.file+suffix)){direct(this.file+suffix,false);this.files.set(suffix,stamp(lstatSync(this.file+suffix,{bigint:true})));}}
  private check():void {
    if(this.closed||this.uncertain)assetReviewFailure(this.uncertain?'UNKNOWN':'CLOSED');
    // Full ancestor traversal is retained on admission and every write/capture.
    // Effects check the same directory identity/realpath once, then its fixed
    // direct SQLite children. This preserves replacement/link/tamper fences
    // without repeatedly walking the same ancestors for every packet.
    try{
      const directory=lstatSync(this.directory,{bigint:true}),actual=process.platform==='win32'?realpathSync.native(this.directory):realpathSync(this.directory);
      const same=process.platform==='win32'?actual.toLowerCase()===this.directory.toLowerCase():actual===this.directory;
      if(!directory.isDirectory()||directory.isSymbolicLink()||!same||[directory.dev,directory.ino].join(':')!==this.directoryIdentity)assetReviewFailure('STORAGE');
      for(const suffix of ['','-wal','-shm']){
        const saved=this.files.get(suffix),present=existsSync(this.file+suffix);
        if(present!==(saved!==undefined))assetReviewFailure('STORAGE');
        if(present){const file=lstatSync(this.file+suffix,{bigint:true});if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1n||stamp(file)!==saved)assetReviewFailure('STORAGE');}
      }
    }catch{assetReviewFailure('STORAGE');}
  }
  private write(work:()=>void):void {
    this.check();direct(this.directory,true);
    try{if(this.options.authority.withSnapshot(()=>{this.db.exec('BEGIN IMMEDIATE');try{work();this.db.exec('COMMIT');}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}})!==undefined)assetReviewFailure('CONFIGURATION');this.capture();}
    catch{this.uncertain=true;assetReviewFailure('UNKNOWN');}
  }
  prepare(input:AssetReviewSubject,guard:()=>void=()=>{}):AssetReviewView {
    this.check();guard();const subject=snapshotAssetReviewSubject(input);if(subject.projectId!==this.projectId)assetReviewFailure('SCOPE');
    const key=jobKey(subject),current=this.latest.get(key),existing=current?this.reviews.get(current):undefined,digest=assetReviewDigest(subject);
    if(existing?.subjectDigest===digest)return existing;
    if(this.reviews.size>=ASSET_REVIEW_LIMITS.reviews)assetReviewFailure('CAPACITY');
    const next=assetReviewFreeze({reviewId:randomUUID(),subject,subjectDigest:digest,status:'pending' as const,revision:0,preparedAt:new Date(this.now()).toISOString(),decidedAt:null});
    guard();this.write(()=>{guard();const signature=this.options.authority.sign(next);this.db.prepare('INSERT INTO asset_reviews VALUES(?,?,?,?)').run(next.reviewId,key,assetReviewCanonical(next),signature);this.db.prepare('INSERT OR REPLACE INTO asset_review_latest VALUES(?,?)').run(key,next.reviewId);});
    this.reviews.set(next.reviewId,next);this.latest.set(key,next.reviewId);guard();return next;
  }
  status(input:AssetReviewSubject):AssetReviewView|null {
    this.check();const subject=snapshotAssetReviewSubject(input);if(subject.projectId!==this.projectId)assetReviewFailure('SCOPE');
    const id=this.latest.get(jobKey(subject)),value=id?this.reviews.get(id):null;
    return value?.subjectDigest===assetReviewDigest(subject)?value:null;
  }
  read(reviewId:string):AssetReviewView {this.check();const item=this.reviews.get(assetReviewUuid(reviewId));if(!item)assetReviewFailure('NOT_FOUND');return item;}
  decide(input:AssetReviewDecisionInput,freshSubject:AssetReviewSubject,proof:unknown,guard:()=>void=()=>{}):AssetReviewDecisionReceipt {
    this.check();guard();const request=snapshotAssetReviewDecision(input),subject=snapshotAssetReviewSubject(freshSubject),current=this.read(request.reviewId);
    if(subject.projectId!==this.projectId||assetReviewCanonical(subject)!==assetReviewCanonical(current.subject)||this.latest.get(jobKey(subject))!==current.reviewId)assetReviewFailure('STALE');
    const saved=this.commands.get(request.idempotencyKey);
    const revision=saved?.revision??current.revision+1;
    const intent:AssetReviewHumanCommand=assetReviewFreeze({...request,projectId:this.projectId,subjectDigest:current.subjectDigest,revision});
    let allowed=false;try{allowed=this.options.authorizeHuman?.(intent,proof)===true;}catch{}if(!allowed)assetReviewFailure('HUMAN_REQUIRED');
    if(saved){if(saved.reviewId!==request.reviewId||saved.decision!==request.decision||saved.subjectDigest!==current.subjectDigest)assetReviewFailure('IDEMPOTENCY');return this.receipt(saved,current);}
    if(current.status==='rejected'||current.status===request.decision)assetReviewFailure('DECIDED');
    if(this.commands.size>=ASSET_REVIEW_LIMITS.commands)assetReviewFailure('CAPACITY');
    const next=assetReviewFreeze({...current,status:request.decision,revision,decidedAt:new Date(this.now()).toISOString()});
    const persisted:SignedCommand=assetReviewFreeze({...intent});
    guard();this.write(()=>{guard();const reviewSignature=this.options.authority.sign(next),commandSignature=this.options.authority.sign(persisted);
      this.db.prepare('UPDATE asset_reviews SET payload=?,signature=? WHERE id=?').run(assetReviewCanonical(next),reviewSignature,next.reviewId);
      this.db.prepare('INSERT INTO asset_review_commands VALUES(?,?,?)').run(request.idempotencyKey,assetReviewCanonical(persisted),commandSignature);});
    this.reviews.set(next.reviewId,next);this.commands.set(request.idempotencyKey,persisted);guard();return this.receipt(persisted,next);
  }
  private receipt(saved:SignedCommand,review:AssetReviewView):AssetReviewDecisionReceipt {
    return assetReviewFreeze({state:'recorded',review,command:{idempotencyKey:saved.idempotencyKey,decision:saved.decision,revision:saved.revision},retry:false});
  }
  decisionReceipt(reviewId:string,idempotencyKey:string):AssetReviewDecisionReceipt|null {
    this.check();const review=this.read(reviewId),saved=this.commands.get(assetReviewUuid(idempotencyKey));
    if(!saved)return null;if(saved.reviewId!==review.reviewId)assetReviewFailure('IDEMPOTENCY');return this.receipt(saved,review);
  }
  assertApproved(input:AssetReviewSubject,expected?:AssetReviewReference):AssetReviewReference {
    const current=this.status(input);if(!current||current.status!=='approved')assetReviewFailure(current?.status==='rejected'?'REJECTED':'REQUIRED');
    const reference=Object.freeze({reviewId:current.reviewId,subjectDigest:current.subjectDigest,revision:current.revision});
    if(expected&&assetReviewCanonical(snapshotAssetReviewReference(expected))!==assetReviewCanonical(reference))assetReviewFailure('STALE');return reference;
  }
  assertReference(subject:AssetReviewSubject,reference:AssetReviewReference):void {this.assertApproved(subject,reference);}
  close():void {
    if(this.closed)return;this.closed=true;
    try{this.db.prepare('DELETE FROM asset_review_owner WHERE id=1 AND token=?').run(this.owner);}finally{this.db.close();owners.delete(this.ownerKey);this.reviews.clear();this.latest.clear();this.commands.clear();}
  }
}
