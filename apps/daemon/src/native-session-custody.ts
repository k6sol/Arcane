import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {CodexClientError,type NativeConnectionLifecycle} from '../../../packages/codex-client/src/types.js';

const TABLE=`CREATE TABLE native_session_custody(
  id TEXT PRIMARY KEY, connection_id TEXT UNIQUE, allocated INTEGER NOT NULL CHECK(allocated IN (0,1)),
  writes_possible INTEGER NOT NULL CHECK(writes_possible IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('reserved','bound','closed')),
  created_at TEXT NOT NULL, closed_at TEXT,
  close_proof TEXT CHECK(close_proof IN ('factory-cleanup','owned-transport')),
  CHECK((state='reserved' AND connection_id IS NULL AND writes_possible=0 AND closed_at IS NULL AND close_proof IS NULL)
    OR (state='bound' AND connection_id IS NOT NULL AND closed_at IS NULL AND close_proof IS NULL)
    OR (state='closed' AND closed_at IS NOT NULL AND close_proof IS NOT NULL)),
  CHECK(close_proof IS NULL OR close_proof!='factory-cleanup' OR connection_id IS NULL)
) STRICT`;
const REQUESTS=`CREATE TABLE native_session_requests(request_id TEXT PRIMARY KEY,lease_id TEXT NOT NULL REFERENCES native_session_custody(id),kind TEXT NOT NULL CHECK(kind IN ('allocated','reused'))) STRICT`;
const row=z.strictObject({id:z.string().uuid(),connection_id:z.string().uuid().nullable(),allocated:z.union([z.literal(0),z.literal(1)]),
  writes_possible:z.union([z.literal(0),z.literal(1)]),state:z.enum(['reserved','bound','closed']),
  created_at:z.string().datetime(),closed_at:z.string().datetime().nullable(),close_proof:z.enum(['factory-cleanup','owned-transport']).nullable()});
type Row=z.infer<typeof row>;
type Client={close():Promise<void>};
type Binding={id:string;connectionId:string;recorded:boolean;close:()=>Promise<void>;completion:Promise<void>|null};
export interface NativeSessionLeaseView {readonly id:string;readonly connectionId:string|null;readonly requestId:string|null;readonly requestIds?:readonly string[];readonly state:'reserved'|'bound'|'closed'}
const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
function fail(message:string):never{throw new CodexClientError('JOURNAL_FAILURE',message);}

/** Host-private evidence only. A closed native transport does not settle a
 * proposal worker, descendant process, Studio custody or Blender job. */
export class NativeSessionCustody {
  readonly #db:DatabaseSync;
  readonly #bindings=new WeakMap<object,Binding>();
  #faulted=false;
  #firstFailure:CodexClientError|null=null;
  #requests=false;
  get faulted():boolean{return this.#faulted;}
  get firstFailure():CodexClientError|null{return this.#firstFailure;}
  #guard<T>(operation:()=>T):T{try{return operation();}catch(error){
    const failure=error instanceof CodexClientError?error:new CodexClientError('JOURNAL_FAILURE','Native session custody could not be saved or verified.');
    if(failure!==error)Object.defineProperty(failure,'cause',{value:error});
    this.#firstFailure??=failure;this.#faulted=true;throw failure;
  }}
  constructor(db:DatabaseSync,requireExisting=false){
    this.#db=db;
    const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='native_session_custody'").get() as {sql:string}|undefined;
    if(!schema&&requireExisting)fail('Native session custody is missing from this journal version.');
    if(schema&&normalize(schema.sql)!==normalize(TABLE))fail('Native session custody schema requires inspection.');
    if(!schema)db.exec(TABLE);
    const rows=db.prepare('SELECT * FROM native_session_custody LIMIT 4097').all();
    if(rows.length>4096)fail('Native session custody exceeds its retained bound.');
    for(const value of rows)this.#parse(value);
  }
  /** Host migration transaction only; v6 preflight requires this table to exist. */
  initializeRequests(requireExisting=false):void{
    const schema=this.#db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='native_session_requests'").get()as{sql:string}|undefined;
    if(!schema&&requireExisting)fail('Native request custody is missing from this journal version.');
    if(schema&&normalize(schema.sql)!==normalize(REQUESTS))fail('Native request custody schema requires inspection.');
    if(!schema)this.#db.exec(REQUESTS);
    const mappings=this.#db.prepare('SELECT r.request_id,r.lease_id,r.kind,c.id AS found FROM native_session_requests r LEFT JOIN native_session_custody c ON c.id=r.lease_id LIMIT 4097').all();
    if(mappings.length>4096)fail('Native request custody exceeds its retained bound.');
    const allocated=new Set<string>();
    for(const mapping of mappings){
      if(!z.string().uuid().safeParse(mapping.request_id).success||!z.string().uuid().safeParse(mapping.lease_id).success||mapping.found!==mapping.lease_id||!['allocated','reused'].includes(String(mapping.kind)))fail('Native request custody binding is invalid.');
      if(mapping.kind==='allocated'){if(allocated.has(String(mapping.lease_id)))fail('Native allocation custody is ambiguous.');allocated.add(String(mapping.lease_id));}
    }
    this.#requests=true;
  }
  snapshot():readonly NativeSessionLeaseView[]{
    return this.#guard(()=>{
      const values=this.#db.prepare('SELECT * FROM native_session_custody LIMIT 4097').all();
      if(values.length>4096)fail('Native session custody exceeds its retained bound.');
      const mappings=new Map<string,{requestId:string|null;requestIds:string[]}>();let count=0;
      if(this.#requests)for(const value of this.#db.prepare('SELECT request_id,lease_id,kind FROM native_session_requests LIMIT 4097').all()){
        if(++count>4096||!z.string().uuid().safeParse(value.request_id).success||!z.string().uuid().safeParse(value.lease_id).success||!['allocated','reused'].includes(String(value.kind)))fail('Native request custody is invalid.');
        const mapping=mappings.get(String(value.lease_id))??{requestId:null,requestIds:[]};
        if(value.kind==='allocated'){if(mapping.requestId!==null)fail('Native allocation custody is ambiguous.');mapping.requestId=String(value.request_id);}
        else mapping.requestIds.push(String(value.request_id));
        mappings.set(String(value.lease_id),mapping);
      }
      const result=values.map(value=>{const v=this.#parse(value),mapping=mappings.get(v.id);mappings.delete(v.id);return Object.freeze({id:v.id,connectionId:v.connection_id,requestId:mapping?.requestId??null,state:v.state,...(mapping?.requestIds.length?{requestIds:Object.freeze(mapping.requestIds.sort())}:{})});});
      if(mappings.size)fail('Native request custody lost its original lease.');
      return Object.freeze(result);
    });
  }
  #parse(value:unknown):Row{
    const parsed=row.safeParse(value);if(!parsed.success)return fail('Native session custody is invalid.');
    const v=parsed.data;
    if(v.state==='reserved'&&(v.connection_id!==null||v.writes_possible!==0||v.closed_at!==null||v.close_proof!==null)||
       v.state==='bound'&&(v.connection_id===null||v.closed_at!==null||v.close_proof!==null)||
       v.state==='closed'&&(v.closed_at===null||v.close_proof===null)||
       v.close_proof==='factory-cleanup'&&v.connection_id!==null||v.writes_possible===1&&v.connection_id===null)
      return fail('Native session custody binding is invalid.');
    return v;
  }
  #read(id:string):Row{return this.#guard(()=>this.#parse(this.#db.prepare('SELECT * FROM native_session_custody WHERE id=?').get(id)));}
  #update(sql:string,args:readonly(string|number|null)[]):void{
    this.#guard(()=>{if(this.#db.prepare(sql).run(...args).changes!==1)fail('The original native session custody changed.');});
  }
  /** Reserve before invoking even an async factory. Failed injected factories
   * without the actual low-level witness remain reserved across reopen. */
  async open<T extends Client>(factory:(lifecycle:NativeConnectionLifecycle)=>Promise<T>,connectionId:(client:T)=>string,requestId?:string):Promise<T>{
    if(this.#faulted)fail('Native session custody requires inspection before new allocation.');
    const count=this.#guard(()=>Number((this.#db.prepare('SELECT count(*) AS n FROM native_session_custody').get() as {n:number}).n));
    if(count>=4096)throw new CodexClientError('JOURNAL_LIMIT','Native session custody is full. No new process was started.');
    if(requestId!==undefined&&(!this.#requests||!z.string().uuid().safeParse(requestId).success))fail('Native allocation requires initialized exact request custody.');
    const id=randomUUID();
    this.#guard(()=>{
      this.#db.exec('SAVEPOINT native_session_reservation');
      try{
        if(requestId!==undefined&&Number((this.#db.prepare('SELECT count(*) AS n FROM native_session_requests').get()as{n:number}).n)>=4096)throw new CodexClientError('JOURNAL_LIMIT','Native request custody is full. No process was started.');
        this.#db.prepare("INSERT INTO native_session_custody VALUES(?,NULL,0,0,'reserved',?,NULL,NULL)").run(id,new Date().toISOString());
        if(requestId!==undefined)this.#db.prepare("INSERT INTO native_session_requests VALUES(?,?,'allocated')").run(requestId,id);
        this.#db.exec('RELEASE native_session_reservation');
      }catch(error){try{this.#db.exec('ROLLBACK TO native_session_reservation;RELEASE native_session_reservation');}catch{/* Retain the original reserve failure. */}throw error;}
    });
    let active=true,factoryClosed=false;
    const lifecycle:NativeConnectionLifecycle=Object.freeze({
      beforeProcessAllocation:()=>{
        if(!active||factoryClosed)fail('Native allocation no longer belongs to this factory.');
        this.#update("UPDATE native_session_custody SET allocated=1 WHERE id=? AND state='reserved'",[id]);
      },
      failedInitializationClosed:()=>{
        if(!active||factoryClosed)fail('Native initialization cleanup no longer belongs to this factory.');
        this.#update("UPDATE native_session_custody SET state='closed',closed_at=?,close_proof='factory-cleanup' WHERE id=? AND state='reserved'",[new Date().toISOString(),id]);
        factoryClosed=true;
      },
    });
    let owned:T;
    try{owned=await factory(lifecycle);}finally{active=false;}
    // Capture the actual returned owner before fallible snapshot/persistence,
    // so even binding failure can still join its original physical close.
    if(!owned||typeof owned!=='object'||typeof owned.close!=='function'||this.#bindings.has(owned))
      return fail('Native factory did not return a fresh owned client.');
    const binding:Binding={id,connectionId:'',recorded:false,close:owned.close.bind(owned),completion:null};
    this.#bindings.set(owned,binding);
    try{
      if(factoryClosed)fail('A closed initialization cannot publish a native client.');
      binding.connectionId=z.string().uuid().parse(connectionId(owned));
      this.#update("UPDATE native_session_custody SET state='bound',connection_id=? WHERE id=? AND state='reserved'",[binding.connectionId,id]);
      binding.recorded=true;
    }catch(error){try{await this.close(owned);}catch{/* Preserve the binding failure; custody stays held if close/save failed. */}throw error;}
    return owned;
  }
  /** Exact current human turn can reuse its original connected owner without
   * pretending that the turn allocated another factory or proving closure. */
  bindRequest(owned:object,requestId:string):void{
    if(!this.#requests||!z.string().uuid().safeParse(requestId).success||this.#faulted)fail('Native turn request custody is unavailable.');
    const binding=this.#bindings.get(owned);if(!binding||binding.completion||!binding.recorded)fail('Native turn request requires its original bound owner.');
    this.#guard(()=>{
      const current=this.#read(binding.id);if(current.state!=='bound'||current.connection_id!==binding.connectionId)fail('Native turn request custody changed.');
      const prior=this.#db.prepare('SELECT lease_id FROM native_session_requests WHERE request_id=?').get(requestId);
      if(prior){if(prior.lease_id!==binding.id)fail('Native request already belongs to another owner.');return;}
      const count=Number((this.#db.prepare('SELECT count(*) AS n FROM native_session_requests').get()as{n:number}).n);
      if(count>=4096)throw new CodexClientError('JOURNAL_LIMIT','Native request custody is full. No turn was dispatched.');
      this.#db.prepare("INSERT INTO native_session_requests VALUES(?,?,'reused')").run(requestId,binding.id);
    });
  }
  /** Call before every effective workspace-write escalation, not after ACK. */
  writesPossible(owned:object):void{
    if(this.#faulted)fail('Native session custody requires inspection before write admission.');
    const binding=this.#bindings.get(owned);if(!binding||binding.completion)fail('No current native write custody.');
    const record=this.#read(binding.id);
    if(record.state!=='bound'||record.connection_id!==binding.connectionId)fail('Native write custody changed.');
    this.#update("UPDATE native_session_custody SET writes_possible=1 WHERE id=? AND state='bound' AND connection_id=?",[binding.id,binding.connectionId]);
  }
  /** Cached before calling the original owner, including reentrant Stop. */
  close(owned:object):Promise<void>{
    const binding=this.#bindings.get(owned);if(!binding)throw new CodexClientError('TASK_SCOPE','Native close requires its original factory owner.');
    if(binding.completion)return binding.completion;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    const completion=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});binding.completion=completion;void completion.catch(()=>{});
    const finish=async()=>{
      await binding.close();
      // No task label, normal retirement or snapshot can enter this path.
      this.#update("UPDATE native_session_custody SET state='closed',connection_id=?,closed_at=?,close_proof='owned-transport' WHERE id=? AND state=? AND connection_id IS ?",
        [binding.connectionId||null,new Date().toISOString(),binding.id,binding.recorded?'bound':'reserved',binding.recorded?binding.connectionId:null]);
    };
    void finish().then(resolve,reject);return completion;
  }
}
