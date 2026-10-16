import {createHash,randomUUID} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {lstat,open,opendir,realpath} from 'node:fs/promises';
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
/** Explicit host/human rebuild result: bounded internal identities plus the preserved original ledger. */
export interface AssetArchiveRebuild {readonly active:readonly string[];readonly archived:readonly string[];readonly backup:string|null}
const BACKUP_PREFIX='archive-ledger.backup-',BACKUP_LIMIT=16,REBUILD_SCAN_LIMIT=ACTIVE_LIMIT+LEDGER_MAX_ENTRIES+64;
const JOB_DIRECTORY=/^([a-z][a-z0-9-]{0,47})-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?![\s\S])/;
interface RebuildWitness {
  readonly ref:AssetJobDirectory;readonly eligible:Omit<LedgerEntry,'journal'|'archivedAt'>|null;
  readonly stat:BigIntStats|null;readonly journalSha256:string|null;readonly markerSha256:string|null;
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
  /** Read-only candidate filtering. archive() independently repeats every fact before writing. */
  async eligible(jobId:string,facts:ArchiveHostFacts):Promise<boolean>{
    this.#ensureOpen();if(!UUID.test(jobId))fail('INPUT');
    const ref=this.#directories.get(jobId);if(!ref||this.isArchived(jobId)||this.#pins.has(jobId))return false;
    try{const files=await this.#files(ref);this.#ensureOpen();
      return !this.#pins.has(jobId)&&assessEligibility({jobId,name:ref.name,journal:files.journal,marker:files.marker,facts}).eligible;
    }catch{this.#ensureOpen();return false;}
  }
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
  /** Closure-independent root identity check used to inspect a commit that already began. */
  async #rootIdentity():Promise<void>{
    await noLinks(this.root);const current=await lstat(this.root,{bigint:true});
    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==this.rootIdentity.dev||current.ino!==this.rootIdentity.ino||
      !equalPath(await realpath(this.root),this.root))fail('PATH');
  }
  /** Complete inventory to the fixed bound, independent of any existing/corrupt/short ledger.
   * An incomplete prefix, linked/ambiguous entry or duplicated UUID refuses the rebuild. */
  async #inventory():Promise<{refs:Map<string,AssetJobDirectory>;names:string;backups:number}>{
    await this.#rootUnchanged();
    const refs=new Map<string,AssetJobDirectory>(),names:string[]=[];let backups=0;
    for await(const dirent of await opendir(this.root)){
      names.push(dirent.name);if(names.length>REBUILD_SCAN_LIMIT)fail('SCAN_LIMIT');
      if(dirent.name.startsWith(BACKUP_PREFIX))backups++;
      const match=JOB_DIRECTORY.exec(dirent.name);if(!match)continue;
      const name=match[1]!,jobId=match[2]!;
      try{assetName(name);}catch{fail('DIRECTORY');}
      if(!dirent.isDirectory()||dirent.isSymbolicLink())fail('DIRECTORY');
      if(refs.has(jobId))fail('DUPLICATE');
      refs.set(jobId,Object.freeze({jobId,name,directory:join(this.root,dirent.name)}));
    }
    for(const ref of refs.values())await this.#directory(ref);
    await this.#rootUnchanged();
    return{refs,names:JSON.stringify(names.sort()),backups};
  }
  /** Exact original ledger bytes (possibly invalid UTF-8/JSON) plus file identity; unsafe sources refuse intact. */
  async #source():Promise<{bytes:Buffer;stat:BigIntStats}|null>{
    await this.#rootUnchanged();const path=join(this.root,LEDGER_FILE);
    let before:BigIntStats;
    try{before=await lstat(path,{bigint:true});}catch(error){if(errno(error)==='ENOENT')return null;fail('LEDGER_SOURCE');}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(LEDGER_MAX_BYTES))fail('LEDGER_SOURCE');
    let bytes:Buffer;try{bytes=await readRegularFile(path,LEDGER_MAX_BYTES);}catch{fail('LEDGER_SOURCE');}
    const after=await lstat(path,{bigint:true});if(!sameFile(before,after))fail('LEDGER_SOURCE');
    return{bytes,stat:after};
  }
  async #witness(ref:AssetJobDirectory,readFacts:(jobId:string)=>Promise<ArchiveHostFacts>,guard:()=>void):Promise<RebuildWitness>{
    const facts=await readFacts(ref.jobId);syncGuard(guard);
    let files:JobBytes;
    try{files=await this.#files(ref);}
    catch(error){
      if(errno(error)!=='ENOENT')throw error;
      // The directory exists but its journal does not: visible and active, never archived.
      try{await this.#directory(ref);}catch{fail('CHANGED');}
      syncGuard(guard);return{ref,eligible:null,stat:null,journalSha256:null,markerSha256:null};
    }
    syncGuard(guard);
    const eligibility=assessEligibility({jobId:ref.jobId,name:ref.name,journal:files.journal,marker:files.marker,facts});
    return{ref,eligible:eligibility.eligible?eligibility.entry:null,stat:files.stat,journalSha256:digest(files.journal),markerSha256:files.marker===null?null:digest(files.marker)};
  }
  /** Never overwrites: a unique, direct, single-link file in this exact root, flushed and read back exactly. */
  async #backup(bytes:Buffer):Promise<string>{
    await this.#rootUnchanged();
    const name=BACKUP_PREFIX+digest(bytes).slice(0,16)+'-'+randomUUID()+'.bin',path=join(this.root,name);
    const handle=await open(path,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await this.#backupIntact(name,bytes);
    return name;
  }
  async #backupIntact(name:string,bytes:Buffer):Promise<void>{
    await this.#rootIdentity();let read:Buffer;
    try{read=await readRegularFile(join(this.root,name),LEDGER_MAX_BYTES);}catch{fail('BACKUP');}
    if(!read.equals(bytes))fail('BACKUP');
  }
  /** Explicit host/human rebuild for corrupt or legacy over-cap retained history. Job directories,
   * journals and artifacts are never moved, deleted or replayed; unresolved evidence stays visible or refuses. */
  async rebuild(input:{facts:(jobId:string)=>Promise<ArchiveHostFacts>;guard:()=>void}):Promise<AssetArchiveRebuild>{
    this.#ensureOpen();if(this.#busy)fail('BUSY');
    const readFacts=input?.facts,guard=input?.guard;
    if(typeof readFacts!=='function'||typeof guard!=='function')fail('INPUT');
    this.#busy=true;
    try{
      syncGuard(guard);if(this.#pins.size)fail('LEASED');
      const inventory=await this.#inventory();syncGuard(guard);
      if(inventory.backups>=BACKUP_LIMIT)fail('BACKUP_LIMIT');
      const source=await this.#source();syncGuard(guard);
      const parsed=source?parseLedger(source.bytes):null,prior=new Map((parsed?.ok?parsed.ledger.entries:[]).map(entry=>[entry.jobId,entry]));
      // A retained valid classification cannot be released by a rebuild: every prior entry needs its exact directory.
      for(const entry of prior.values()){const ref=inventory.refs.get(entry.jobId);if(!ref)fail('MISSING');if(ref.name!==entry.name)fail('DIRECTORY');}
      const witnesses:RebuildWitness[]=[];
      for(const ref of inventory.refs.values())witnesses.push(await this.#witness(ref,readFacts,guard));
      const visible=witnesses.filter(w=>!w.eligible);
      if(visible.some(w=>prior.has(w.ref.jobId)))fail('CHANGED'); // Keep the fence; fresh eligibility is required.
      const retained=witnesses.filter(w=>w.eligible&&prior.has(w.ref.jobId));
      const fresh=witnesses.filter(w=>w.eligible&&!prior.has(w.ref.jobId)).sort((a,b)=>{
        const at=(w:RebuildWitness)=>w.eligible!.finishedAt??w.eligible!.startedAt??'';
        return at(a)<at(b)?1:at(a)>at(b)?-1:a.ref.jobId<b.ref.jobId?-1:1;
      });
      const slots=ACTIVE_LIMIT-visible.length;if(slots<0)fail('CAPACITY');
      const activeFresh=fresh.slice(0,slots),archivedFresh=fresh.slice(slots);
      if(retained.length+archivedFresh.length>LEDGER_MAX_ENTRIES)fail('CAPACITY');
      const now=new Date().toISOString();
      const entries:LedgerEntry[]=[
        ...[...prior.values()].map(old=>{const w=retained.find(r=>r.ref.jobId===old.jobId)!;return{...w.eligible!,journal:fingerprintOf(w.stat!),archivedAt:old.archivedAt};}),
        ...archivedFresh.map(w=>({...w.eligible!,journal:fingerprintOf(w.stat!),archivedAt:now})),
      ];
      const next=copyLedger({schemaVersion:1,kind:'arcane-asset-archive',entries}),text=serializeLedger(next);
      const result=Object.freeze({active:Object.freeze([...visible,...activeFresh].map(w=>w.ref.jobId).sort()),archived:Object.freeze(entries.map(e=>e.jobId))});
      if(source&&digest(source.bytes)===digest(text)){
        this.#ledger=next;this.#ledgerDigest=digest(text);this.#invalid=false;this.#directories=inventory.refs;
        return Object.freeze({...result,backup:null});
      }
      const backup=source?await this.#backup(source.bytes):null;syncGuard(guard);
      // Revalidate every classification witness, host fact, the inventory, the source and its backup.
      if(this.#pins.size)fail('LEASED');
      const again=await this.#inventory();syncGuard(guard);if(again.names!==inventory.names&&
        JSON.stringify(JSON.parse(again.names).filter((n:string)=>n!==backup))!==inventory.names)fail('CHANGED');
      for(const w of witnesses){
        const now=await this.#witness(w.ref,readFacts,guard);
        if(!!now.eligible!==!!w.eligible||now.journalSha256!==w.journalSha256||now.markerSha256!==w.markerSha256||
          (now.stat===null)!==(w.stat===null)||now.stat&&w.stat&&!sameFile(now.stat,w.stat))fail('CHANGED');
      }
      const current=await this.#source();syncGuard(guard);
      if((current===null)!==(source===null)||current&&source&&(!current.bytes.equals(source.bytes)||!sameFile(current.stat,source.stat)))fail('LEDGER');
      if(source&&backup)await this.#backupIntact(backup,source.bytes);
      syncGuard(guard);if(this.#pins.size)fail('LEASED');
      // Commit has begun: join it and inspect the actual disk outcome even if the caller retires.
      let writeError:unknown=null;
      try{await this.write(this.root,LEDGER_FILE,text);}catch(error){writeError=error;}
      let observed:Buffer|null=null,inspected=true;
      try{await this.#rootIdentity();observed=await readRegularFile(join(this.root,LEDGER_FILE),LEDGER_MAX_BYTES);}
      catch(error){if(errno(error)!=='ENOENT')inspected=false;}
      const observedDigest=observed===null?null:digest(observed),landed=inspected&&observedDigest===digest(text);
      if(landed){this.#ledger=next;this.#ledgerDigest=observedDigest;this.#invalid=false;this.#directories=inventory.refs;}
      if(writeError!==null){
        if(!landed&&inspected&&observedDigest===(source?digest(source.bytes):null)&&writeError instanceof AtomicJsonFailure&&writeError.phase!=='replace')fail('PERSISTENCE');
        this.#uncertain=true;fail('UNCERTAIN');
      }
      if(!landed){this.#uncertain=true;fail('UNCERTAIN');}
      if(source&&backup){try{await this.#backupIntact(backup,source.bytes);}catch{this.#uncertain=true;fail('BACKUP');}}
      // Every retained entry was freshly validated against current host facts; this commit is the inspection.
      this.#uncertain=false;
      return Object.freeze({...result,backup});
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
