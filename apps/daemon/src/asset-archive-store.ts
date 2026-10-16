import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {lstat,opendir,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {atomicAssetJson,AtomicJsonFailure} from '../../../packages/asset-pipeline/src/atomic-json.js';
import {assetName,noLinks,readRegularFile} from '../../../packages/asset-pipeline/src/paths.js';
import {JOB_JOURNAL_BYTES} from '../../../packages/asset-pipeline/src/recipe.js';
import {RESOLUTION_RECORD_BYTES} from '../../../packages/asset-pipeline/src/worker-resolution.js';
import {ACTIVE_LIMIT,LEDGER_FILE,LEDGER_MAX_BYTES,LEDGER_MAX_ENTRIES,archiveBatch,assessEligibility,copyLedger,
  fingerprintOf,parseLedger,planRestore,sameFingerprint,serializeLedger,validateArchived,type ArchiveHostFacts,type ArchivedStatus,
  type Ledger,type LedgerEntry} from '../../../packages/asset-pipeline/src/archive-ledger.js';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const MARKER='worker-resolution.json';
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const errno=(error:unknown)=>error&&typeof error==='object'&&'code'in error?error.code:null;
function fail(code:string):never{throw new ArcaneError('ASSET_ARCHIVE_'+code,'Retained asset history needs inspection before its classification can change.');}
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameFile=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function syncGuard(guard:()=>void):void{
  const value:unknown=guard();
  if(value!==undefined)fail('GUARD');
}
export interface AssetJobDirectory {readonly jobId:string;readonly name:string;readonly directory:string}
export interface ArchivedJobSummary extends AssetJobDirectory {
  readonly entry:LedgerEntry;readonly status:ArchivedStatus;
}
export interface AssetArchiveScan {
  readonly active:readonly AssetJobDirectory[];
  readonly unclassified:readonly AssetJobDirectory[];
  readonly archived:readonly ArchivedJobSummary[];
  readonly degraded:boolean;
  readonly reasons:readonly ('ledger-invalid'|'ledger-changed'|'scan-limit'|'directory-invalid'|'duplicate-job'|'active-limit'|'archived-evidence'|'commit-uncertain')[];
}
interface JobBytes {readonly journal:Buffer;readonly marker:Buffer|null;readonly stat:BigIntStats}
interface Candidate {readonly entry:LedgerEntry;readonly files:JobBytes;readonly directory:AssetJobDirectory}
/** A durable classification index. Journals and artifacts never move or get deleted.
 * The host owns operation admission and supplies current lease/engine facts. Digests detect drift;
 * they cannot authenticate a same-user process able to replace every matching record. */
export class AssetArchiveStore {
  #ledger:Ledger=copyLedger({schemaVersion:1,kind:'arcane-asset-archive',entries:[]});
  #ledgerDigest:string|null=null;
  #invalid=false;#uncertain=false;#busy=false;#closed=false;
  #directories=new Map<string,AssetJobDirectory>();
  #pins=new Map<string,number>();
  private constructor(readonly root:string,private readonly rootIdentity:BigIntStats,
    private readonly write:(directory:string,filename:string,text:string)=>Promise<void>){ }
  static async open(options:{root:string;writer?:(directory:string,filename:string,text:string)=>Promise<void>}):Promise<AssetArchiveStore>{
    if(!isAbsolute(options.root)||resolve(options.root)!==options.root)fail('PATH');
    await noLinks(options.root);const actual=await realpath(options.root),stat=await lstat(options.root,{bigint:true});
    if(!equalPath(actual,options.root)||!stat.isDirectory()||stat.isSymbolicLink())fail('PATH');
    const store=new AssetArchiveStore(options.root,stat,options.writer??atomicAssetJson);
    try{
      const bytes=await readRegularFile(join(options.root,LEDGER_FILE),LEDGER_MAX_BYTES),parsed=parseLedger(bytes);
      if(!parsed.ok)store.#invalid=true;
      else{store.#ledger=parsed.ledger;store.#ledgerDigest=digest(bytes);}
    }catch(error){if(errno(error)!=='ENOENT')store.#invalid=true;}
    return store;
  }
  #ensureOpen():void{if(this.#closed)fail('CLOSED');}
  async #rootUnchanged():Promise<void>{
    this.#ensureOpen();await noLinks(this.root);const current=await lstat(this.root,{bigint:true});
    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==this.rootIdentity.dev||current.ino!==this.rootIdentity.ino||
      !equalPath(await realpath(this.root),this.root))fail('PATH');
    this.#ensureOpen();
  }
  async #stored():Promise<{bytes:Buffer;ledger:Ledger}|null>{
    await this.#rootUnchanged();
    try{const bytes=await readRegularFile(join(this.root,LEDGER_FILE),LEDGER_MAX_BYTES),parsed=parseLedger(bytes);
      if(!parsed.ok)fail('LEDGER');return{bytes,ledger:parsed.ledger};
    }catch(error){if(errno(error)==='ENOENT')return null;throw error;}
  }
  async #unchangedLedger():Promise<boolean>{
    if(this.#invalid)return false;
    try{const stored=await this.#stored();return(stored?digest(stored.bytes):null)===this.#ledgerDigest;}catch{return false;}
  }
  async #commit(next:Ledger):Promise<void>{
    this.#ensureOpen();
    const text=serializeLedger(next),priorDigest=this.#ledgerDigest;let writeError:unknown=null;
    try{await this.write(this.root,LEDGER_FILE,text);}catch(error){writeError=error;}
    // A write has begun. Join it and inspect its actual outcome even if the caller retired.
    let stored:{bytes:Buffer;ledger:Ledger}|null=null;
    try{stored=await this.#stored();}catch{this.#uncertain=true;fail('UNCERTAIN');}
    const observedDigest=stored===null?null:digest(stored.bytes),expected=observedDigest===digest(text);
    if(expected){this.#ledger=stored!.ledger;this.#ledgerDigest=observedDigest;}
    if(writeError!==null){
      if(!expected&&observedDigest===priorDigest&&writeError instanceof AtomicJsonFailure&&writeError.phase!=='replace')fail('PERSISTENCE');
      this.#uncertain=true;fail('UNCERTAIN');
    }
    if(!expected){this.#uncertain=true;fail('UNCERTAIN');}
  }
  async #directory(ref:AssetJobDirectory):Promise<void>{
    await this.#rootUnchanged();
    if(!UUID.test(ref.jobId)||assetName(ref.name)!==ref.name||ref.directory!==join(this.root,ref.name+'-'+ref.jobId))fail('PATH');
    const stat=await lstat(ref.directory,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('PATH');
    await noLinks(ref.directory);
  }
  async #files(ref:AssetJobDirectory):Promise<JobBytes>{
    await this.#directory(ref);
    const path=join(ref.directory,'job.json'),before=await lstat(path,{bigint:true});
    const journal=await readRegularFile(path,JOB_JOURNAL_BYTES);
    let marker:Buffer|null=null;
    try{marker=await readRegularFile(join(ref.directory,MARKER),RESOLUTION_RECORD_BYTES);}catch(error){if(errno(error)!=='ENOENT')throw error;}
    const after=await lstat(path,{bigint:true});if(!sameFile(before,after))fail('CHANGED');
    await this.#directory(ref);return{journal,marker,stat:after};
  }
  async #checkpoint(entry:LedgerEntry,ref:AssetJobDirectory|undefined):Promise<ArchivedStatus>{
    if(!ref)return'missing';
    try{
      // scan() pins the canonical root/ancestor chain before and after the whole pass.
      // Pin each direct child around its metadata; full content reads retain #directory().
      const before=await lstat(ref.directory,{bigint:true});
      if(!before.isDirectory()||before.isSymbolicLink())return'conflict';
      const stat=await lstat(join(ref.directory,'job.json'),{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size<1n||stat.size>BigInt(JOB_JOURNAL_BYTES))return'conflict';
      if(!sameFingerprint(entry.journal,fingerprintOf(stat)))return'changed';
      // Resolved interrupted jobs additionally retain their exact marker. No journal/artifact read at startup.
      if(entry.resolutionMarkerSha256!==null){
        const marker=await readRegularFile(join(ref.directory,MARKER),RESOLUTION_RECORD_BYTES);
        if(digest(marker)!==entry.resolutionMarkerSha256)return'conflict';
      }else{
        try{await lstat(join(ref.directory,MARKER));return'conflict';}catch(error){if(errno(error)!=='ENOENT')return'conflict';}
      }
      const after=await lstat(ref.directory,{bigint:true});
      if(!after.isDirectory()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.mode!==after.mode)return'conflict';
      return'archived';
    }catch(error){return errno(error)==='ENOENT'?'missing':'conflict';}
  }
  /** Bounded name/metadata scan. Archived journals and artifacts are not opened.
   * Invalid or over-cap history remains readable as summaries and refuses admission. */
  async scan():Promise<AssetArchiveScan>{
    await this.#rootUnchanged();
    const reasons=new Set<AssetArchiveScan['reasons'][number]>();
    if(this.#invalid)reasons.add('ledger-invalid');
    else if(!await this.#unchangedLedger())reasons.add('ledger-changed');
    if(this.#uncertain)reasons.add('commit-uncertain');
    const ledgerEntries=new Map(this.#ledger.entries.map(entry=>[entry.jobId,entry]));
    const directories=new Map<string,AssetJobDirectory>(),duplicates=new Set<string>();
    const maximum=ACTIVE_LIMIT+(this.#invalid?LEDGER_MAX_ENTRIES:this.#ledger.entries.length)+64;
    let inspected=0;const stream=await opendir(this.root);
    for await(const dirent of stream){
      if(++inspected>maximum){reasons.add('scan-limit');break;}
      const match=/^([a-z][a-z0-9-]{0,47})-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?![\s\S])/.exec(dirent.name);
      if(!match)continue;
      const name=match[1]!,jobId=match[2]!,ref=Object.freeze({jobId,name,directory:join(this.root,dirent.name)});
      try{assetName(name);}catch{reasons.add('directory-invalid');continue;}
      if(!dirent.isDirectory()||dirent.isSymbolicLink()){reasons.add('directory-invalid');continue;}
      if(directories.has(jobId)){duplicates.add(jobId);reasons.add('duplicate-job');continue;}
      directories.set(jobId,ref);
    }
    for(const jobId of duplicates)directories.delete(jobId);
    const active:AssetJobDirectory[]=[],unclassified:AssetJobDirectory[]=[],archived:ArchivedJobSummary[]=[];
    for(const ref of directories.values()){
      const entry=ledgerEntries.get(ref.jobId);
      if(entry){if(entry.name!==ref.name)reasons.add('directory-invalid');continue;}
      if(active.length<ACTIVE_LIMIT)active.push(ref);else{unclassified.push(ref);reasons.add('active-limit');}
    }
    for(const entry of this.#ledger.entries){
      const ref=directories.get(entry.jobId),exact=ref?.name===entry.name?ref:undefined;
      const status=await this.#checkpoint(entry,exact);
      if(status!=='archived')reasons.add('archived-evidence');
      archived.push(Object.freeze({jobId:entry.jobId,name:entry.name,directory:join(this.root,entry.name+'-'+entry.jobId),entry,status}));
    }
    await this.#rootUnchanged();this.#directories=directories;
    return Object.freeze({active:Object.freeze(active),unclassified:Object.freeze(unclassified),archived:Object.freeze(archived),
      degraded:reasons.size>0,reasons:Object.freeze([...reasons])});
  }
  isArchived(jobId:string):boolean{this.#ensureOpen();return this.#ledger.entries.some(entry=>entry.jobId===jobId);}
  /** Read lease survives asynchronous service consumers. Releasing twice is harmless. */
  pin(jobIds:readonly string[]):()=>void{
    this.#ensureOpen();if(!Array.isArray(jobIds)||jobIds.length>64||jobIds.some(id=>!UUID.test(id)))fail('INPUT');
    const ids=[...new Set(jobIds)];for(const id of ids)this.#pins.set(id,(this.#pins.get(id)??0)+1);
    let released=false;return()=>{if(released)return;released=true;for(const id of ids){const n=(this.#pins.get(id)??1)-1;if(n)this.#pins.set(id,n);else this.#pins.delete(id);}};
  }
  /** Full current-byte lookup; never substitutes a stale cache or NOT_FOUND for a retained UUID. */
  async read(jobId:string):Promise<{entry:LedgerEntry;directory:string;status:ArchivedStatus;journal:Buffer|null;marker:Buffer|null}>{
    this.#ensureOpen();if(!UUID.test(jobId))fail('INPUT');
    const entry=this.#ledger.entries.find(e=>e.jobId===jobId);if(!entry)fail('NOT_ARCHIVED');
    const release=this.pin([jobId]);
    try{
      if(!await this.#unchangedLedger())fail('LEDGER');
      const directory=join(this.root,entry.name+'-'+jobId);
      try{const files=await this.#files({jobId,name:entry.name,directory});
        this.#ensureOpen();
        return{entry,directory,status:validateArchived(entry,files.journal,files.marker),journal:Buffer.from(files.journal),marker:files.marker===null?null:Buffer.from(files.marker)};
      }catch(error){this.#ensureOpen();return{entry,directory,status:errno(error)==='ENOENT'?'missing':'conflict',journal:null,marker:null};}
    }finally{release();}
  }
  /** Host must serialize admission and provide current facts for every candidate.
   * A batch is reserved in memory before any await; one atomic ledger replacement commits all classifications. */
  async archive(input:{jobIds:readonly string[];activeCount:number;facts:(jobId:string)=>Promise<ArchiveHostFacts>;guard:()=>void}):Promise<readonly string[]>{
    this.#ensureOpen();if(this.#busy)fail('BUSY');
    const {activeCount,facts:readFacts,guard}=input;
    const ids=Array.isArray(input.jobIds)?[...input.jobIds]:[];
    if(!ids.length||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id))||
      !Number.isSafeInteger(activeCount)||activeCount<ids.length||activeCount>ACTIVE_LIMIT)fail('INPUT');
    this.#busy=true;
    try{
      syncGuard(guard);const scan=await this.scan();syncGuard(guard);if(scan.degraded)fail('DEGRADED');
      if(scan.active.length!==activeCount)fail('CHANGED');
      const candidates:Candidate[]=[];
      for(const jobId of ids){
        const ref=this.#directories.get(jobId);if(!ref||this.isArchived(jobId)||this.#pins.has(jobId))fail('LEASED');
        const facts=await readFacts(jobId);syncGuard(guard);
        if(this.#pins.has(jobId))fail('LEASED');
        const files=await this.#files(ref);syncGuard(guard);
        const eligibility=assessEligibility({jobId,name:ref.name,journal:files.journal,marker:files.marker,facts});
        if(!eligibility.eligible)fail('INELIGIBLE');
        candidates.push({directory:ref,files,entry:{...eligibility.entry,journal:fingerprintOf(files.stat),archivedAt:new Date().toISOString()}});
      }
      const next=archiveBatch(this.#ledger,candidates.map(c=>c.entry),activeCount);
      for(const candidate of candidates){
        const facts=await readFacts(candidate.entry.jobId);syncGuard(guard);
        if(this.#pins.has(candidate.entry.jobId))fail('LEASED');
        const files=await this.#files(candidate.directory);syncGuard(guard);
        const eligibility=assessEligibility({jobId:candidate.entry.jobId,name:candidate.entry.name,journal:files.journal,marker:files.marker,facts});
        if(!eligibility.eligible||!sameFile(candidate.files.stat,files.stat)||digest(files.journal)!==candidate.entry.journalSha256||
          (files.marker===null?null:digest(files.marker))!==candidate.entry.resolutionMarkerSha256)fail('CHANGED');
      }
      if(!await this.#unchangedLedger())fail('LEDGER');syncGuard(guard);
      if(candidates.some(c=>this.#pins.has(c.entry.jobId)))fail('LEASED');
      await this.#commit(next);
      return Object.freeze(ids);
    }finally{this.#busy=false;}
  }
  /** A full-capacity restore swaps one eligible active job in the same ledger replacement. */
  async restore(input:{jobId:string;activeCount:number;swapJobId?:string;facts:(jobId:string)=>Promise<ArchiveHostFacts>;guard:()=>void}):Promise<{jobId:string;swappedOut:string|null;activeAfter:number}>{
    this.#ensureOpen();if(this.#busy)fail('BUSY');
    const {jobId,activeCount,swapJobId,facts,guard}=input;
    if(!UUID.test(jobId)||!Number.isSafeInteger(activeCount)||activeCount<0||activeCount>ACTIVE_LIMIT||
      swapJobId!==undefined&&(!UUID.test(swapJobId)||swapJobId===jobId))fail('INPUT');
    this.#busy=true;
    try{
      syncGuard(guard);const scan=await this.scan();syncGuard(guard);
      if(scan.degraded)fail('DEGRADED');if(scan.active.length!==activeCount)fail('CHANGED');
      if(this.#pins.has(jobId))fail('LEASED');
      const restored=await this.read(jobId);syncGuard(guard);if(restored.status!=='archived')fail('CHANGED');
      let swap:Candidate|null=null;
      if(swapJobId!==undefined){
        const ref=this.#directories.get(swapJobId);if(!ref||this.isArchived(swapJobId)||this.#pins.has(swapJobId))fail('LEASED');
        const host=await facts(swapJobId);syncGuard(guard);const files=await this.#files(ref);syncGuard(guard);
        const eligibility=assessEligibility({jobId:swapJobId,name:ref.name,journal:files.journal,marker:files.marker,facts:host});
        if(!eligibility.eligible||this.#pins.has(swapJobId))fail('INELIGIBLE');
        swap={directory:ref,files,entry:{...eligibility.entry,journal:fingerprintOf(files.stat),archivedAt:new Date().toISOString()}};
      }
      const plan=planRestore(this.#ledger,jobId,activeCount,swap?.entry??null);if(!plan.ok)fail('CAPACITY');
      if(swap){
        const host=await facts(swap.entry.jobId);syncGuard(guard);const files=await this.#files(swap.directory);syncGuard(guard);
        const eligibility=assessEligibility({jobId:swap.entry.jobId,name:swap.entry.name,journal:files.journal,marker:files.marker,facts:host});
        if(!eligibility.eligible||!sameFile(swap.files.stat,files.stat)||digest(files.journal)!==swap.entry.journalSha256||
          (files.marker===null?null:digest(files.marker))!==swap.entry.resolutionMarkerSha256)fail('CHANGED');
      }
      const current=await this.read(jobId);syncGuard(guard);if(current.status!=='archived')fail('CHANGED');
      if(!await this.#unchangedLedger())fail('LEDGER');syncGuard(guard);
      if(this.#pins.has(jobId)||swap&&this.#pins.has(swap.entry.jobId))fail('LEASED');
      await this.#commit(plan.ledger);
      return{jobId,swappedOut:plan.swappedOut,activeAfter:plan.activeAfter};
    }finally{this.#busy=false;}
  }
  /** Explicit host/human inspection can confirm an uncertain commit from the exact current bytes.
   * This does not repair a corrupt/foreign ledger or accept changed/missing job evidence. */
  async confirm(guard:()=>void):Promise<void>{
    this.#ensureOpen();if(this.#busy)fail('BUSY');this.#busy=true;
    try{
      syncGuard(guard);if(!await this.#unchangedLedger())fail('LEDGER');
      for(const entry of this.#ledger.entries){
        const current=await this.read(entry.jobId);syncGuard(guard);if(current.status!=='archived')fail('CHANGED');
      }
      if(!await this.#unchangedLedger())fail('LEDGER');syncGuard(guard);this.#uncertain=false;
    }finally{this.#busy=false;}
  }
  /** The service joins in-flight archive operations before closing this owner. */
  close():void{this.#closed=true;}
}
