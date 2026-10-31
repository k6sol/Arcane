import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {types} from 'node:util';

/** A NEW conservative recovery admission ceiling, not the existing task-owner
 * limit or the 4096-row custody retention limit. A reservation is not closure. */
export const NATIVE_RECOVERY_OWNER_CAPACITY=128;
const BOUNDS=Object.freeze({actions:4096,tasks:256,leases:4096,proposals:1024});
const ACTIONS=['connect','disconnect','select','thread-start','thread-resume','history-load','grant-assets','revoke-assets',
  'grant-writes','revoke-writes','turn-start','turn-steer','turn-interrupt','task-stop','task-focus','proposal-start','approval'] as const;
export interface NativeRecoveryAction {
  /** fingerprint covers the complete original stored row, not only its request/idempotency hash. */
  readonly id:string;readonly fingerprint:string;readonly action:typeof ACTIONS[number];
  readonly state:'pending'|'acknowledged'|'rejected'|'unknown';readonly connectionId:string|null;
  readonly nextConnectionId?:string|null;readonly threadId:string|null;
}
/** All task states are supplied: terminal labels never establish transport closure. */
export interface NativeRecoveryTask {readonly id:string;readonly fingerprint:string;readonly connectionId:string;readonly threadId:string}
export interface NativeRecoveryLease {
  readonly id:string;readonly connectionId:string|null;readonly requestId?:string|null;readonly state:'reserved'|'bound'|'closed';
  /** Reused turn-start requests, distinct from the original allocating requestId. */
  readonly requestIds?:readonly string[];
}
export interface NativeRecoverySnapshot {
  readonly projectPath:string;readonly actions:readonly NativeRecoveryAction[];readonly tasks:readonly NativeRecoveryTask[];
  readonly leases:readonly NativeRecoveryLease[];readonly unclosedProposalIds:readonly string[];
}
export interface NativeRecoveryOriginals {
  /** Fresh trusted complete-row hashes. Unrelated appended rows do not alter this seal. */
  readonly actions:readonly {readonly id:string;readonly fingerprint:string}[];
  readonly tasks:readonly {readonly id:string;readonly fingerprint:string}[];
}
/** Public, display-only counts. No identity, payload, capability or positive closure proof. */
export interface NativeRecoveryView {
  readonly version:1;readonly fingerprint:string;readonly nativeReservations:number;
  readonly legacyActions:number;readonly legacyTasks:number;readonly legacyThreads:number;readonly legacyProposals:number;
}
export interface NativeRecoveryQuarantine {
  /** Only unresolved-resource-linked tasks; every supplied original is integrity sealed. */
  readonly legacyTaskIds:readonly string[];readonly legacyProposalIds:readonly string[];
  readonly fingerprint:string;readonly nativeReservationCount:number;
  quarantinesAction(id:string):boolean;quarantinesTask(id:string):boolean;quarantinesThread(threadId:string):boolean;
  assertUnchanged(current:NativeRecoveryOriginals):void;
  /** Called before allocating ONE more original factory owner, not after spawn. */
  assertNativeAdmission(currentLeases:readonly NativeRecoveryLease[]):void;
  view():NativeRecoveryView;
}
export class NativeRecoveryError extends Error {
  constructor(readonly code:'INPUT'|'CHANGED'|'CAPACITY') {
    super(code==='INPUT'?'Native recovery metadata is invalid.':code==='CHANGED'?
      'Original native recovery evidence changed. No new native work was admitted.':
      'Native recovery owner capacity is reserved. No new native process was started.');
    this.name='NativeRecoveryError';
  }
}
function fail(code:'INPUT'|'CHANGED'|'CAPACITY'='INPUT'):never {throw new NativeRecoveryError(code);}
function data(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))fail();
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)fail();
  const fields=Object.getOwnPropertyDescriptors(value),allowed=new Set([...required,...optional]),out:Record<string,unknown>={};
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.has(key)))fail();
  for(const key of required)if(!Object.hasOwn(fields,key))fail();
  for(const key of Object.keys(fields)){const field=fields[key]!;if(!Object.hasOwn(field,'value')||!field.enumerable)fail();out[key]=field.value;}
  return out;
}
function list(value:unknown,max:number):unknown[] {
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail();
  const fields=Object.getOwnPropertyDescriptors(value)as Record<string,PropertyDescriptor>,length=fields.length?.value as unknown;
  if(typeof length!=='number'||!Number.isSafeInteger(length)||length>max||Reflect.ownKeys(value).length!==length+1)fail();
  const out:unknown[]=[];for(let index=0;index<length;index++){
    const field=fields[String(index)];if(!field||!Object.hasOwn(field,'value')||!field.enumerable)fail();out.push(field.value);
  }return out;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function id(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))fail();return value;}
function fingerprint(value:unknown):string {if(typeof value!=='string'||!(/^[a-f0-9]{64}$/).test(value))fail();return value;}
function thread(value:unknown):string {if(typeof value!=='string'||!value.length||value.length>256||/[\x00-\x1f\x7f]/.test(value))fail();return value;}
function unique<T extends {readonly id:string}>(rows:T[]):T[] {
  const seen=new Set<string>();for(const row of rows){if(seen.has(row.id))fail();seen.add(row.id);}return rows;
}
function actions(value:unknown):NativeRecoveryAction[] {return unique(list(value,BOUNDS.actions).map(value=>{
  const row=data(value,['id','fingerprint','action','state','connectionId','threadId'],['nextConnectionId']);
  if(!ACTIONS.includes(row.action as NativeRecoveryAction['action'])||typeof row.state!=='string'||!['pending','acknowledged','rejected','unknown'].includes(row.state))fail();
  const next=row.nextConnectionId===null?null:Object.hasOwn(row,'nextConnectionId')?id(row.nextConnectionId):undefined;
  if(next!==undefined&&next!==null&&(!['turn-start','task-focus'].includes(row.action as string)||next===row.connectionId))fail();
  return {id:id(row.id),fingerprint:fingerprint(row.fingerprint),action:row.action as NativeRecoveryAction['action'],
    state:row.state as NativeRecoveryAction['state'],connectionId:row.connectionId===null?null:id(row.connectionId),
    threadId:row.threadId===null?null:thread(row.threadId),...(next===undefined?{}:{nextConnectionId:next})};
}));}
function tasks(value:unknown):NativeRecoveryTask[] {return unique(list(value,BOUNDS.tasks).map(value=>{
  const row=data(value,['id','fingerprint','connectionId','threadId']);return{id:id(row.id),fingerprint:fingerprint(row.fingerprint),connectionId:id(row.connectionId),threadId:thread(row.threadId)};
}));}
function leases(value:unknown):NativeRecoveryLease[] {
  let aliasCount=0;
  const rows=unique(list(value,BOUNDS.leases).map(value=>{
    const row=data(value,['id','connectionId','state'],['requestId','requestIds']);
    if(typeof row.state!=='string'||!['reserved','bound','closed'].includes(row.state))fail();
    const connectionId=row.connectionId===null?null:id(row.connectionId),requestId=row.requestId===null?null:Object.hasOwn(row,'requestId')?id(row.requestId):undefined;
    if(requestId&&++aliasCount>BOUNDS.actions)fail();
    const requestIds=Object.hasOwn(row,'requestIds')?list(row.requestIds,BOUNDS.actions-aliasCount).map(id).sort():undefined;
    aliasCount+=requestIds?.length??0;
    if(requestIds&&(!requestIds.length||connectionId===null))fail();
    if(row.state==='reserved'&&connectionId!==null||row.state==='bound'&&connectionId===null)fail();
    return {id:id(row.id),connectionId,state:row.state as NativeRecoveryLease['state'],...(requestId===undefined?{}:{requestId}),...(requestIds===undefined?{}:{requestIds})};
  }));
  // Actual custody has unique connection/factory bindings. Ambiguous aliases
  // cannot turn a closed row into proof for a different original owner.
  const connections=new Set<string>(),requests=new Set<string>();
  for(const row of rows){
    if(row.connectionId){if(connections.has(row.connectionId))fail();connections.add(row.connectionId);}
    for(const key of [...(row.requestId?[row.requestId]:[]),...(row.requestIds??[])]){
      if(requests.has(key)||requests.size>=BOUNDS.actions)fail();requests.add(key);
    }
  }return rows;
}
const connection=(value:string)=>'connection:'+value,request=(value:string)=>'request:'+value,lease=(value:string)=>'lease:'+value;
class Resources {
  readonly parents=new Map<string,string>();
  add(key:string):string {if(!this.parents.has(key))this.parents.set(key,key);return key;}
  root(key:string):string {
    this.add(key);let root=key;while(this.parents.get(root)!==root)root=this.parents.get(root)!;
    while(key!==root){const parent=this.parents.get(key)!;this.parents.set(key,root);key=parent;}return root;
  }
  join(keys:readonly string[]):void {const first=keys[0];if(!first)return;const root=this.root(first);for(const key of keys.slice(1))this.parents.set(this.root(key),root);}
}
function leaseKeys(row:NativeRecoveryLease):string[] {return[lease(row.id),...(row.connectionId?[connection(row.connectionId)]:[]),
  ...(row.requestId?[request(row.requestId)]:[]),...(row.requestIds??[]).map(request)];}
function actionKeys(row:NativeRecoveryAction,resources:Resources):string[] {
  const keys=[...(row.connectionId?[connection(row.connectionId)]:[]),...(row.nextConnectionId?[connection(row.nextConnectionId)]:[])];
  for(const key of keys)resources.add(key);
  if(row.action==='connect'||row.action==='turn-start'){
    const factory=request(row.id);keys.push(factory);resources.add(factory);
    // A rotation's source connection and its new factory are DISTINCT owners.
    // No action state proves that an unmapped rotation did not allocate.
    const target=row.action==='connect'?row.connectionId:row.nextConnectionId;
    if(target)resources.join([factory,connection(target)]);
  }return keys;
}
function checkFactoryMappings(rows:readonly NativeRecoveryAction[],leases:readonly NativeRecoveryLease[],complete:boolean):void {
  const byRequest=new Map(rows.map(row=>[row.id,row]));
  for(const row of leases){
    const action=row.requestId?byRequest.get(row.requestId):undefined;
    if(action){
      if(action.action!=='connect'&&action.action!=='turn-start')fail();
      const target=action.action==='connect'?action.connectionId:action.nextConnectionId;
      if(target&&target!==row.connectionId)fail();
    }
    for(const key of row.requestIds??[]){
      const reused=byRequest.get(key);
      // New leases may carry later host-validated requests absent from the
      // startup seal. Existing lease alias membership is checked separately.
      if(!reused){if(complete)fail();continue;}
      if(reused.action!=='turn-start'||reused.connectionId!==row.connectionId||reused.nextConnectionId&&reused.nextConnectionId!==row.connectionId)fail();
    }
  }
}
const ordered=<T extends {readonly id:string}>(rows:readonly T[])=>[...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);

/** Constructed only at startup from complete trusted store projections, never
 * an HTTP/model body or live same-daemon owners. Metadata does not mint actors,
 * authorize replay, revoke legacy rights, or settle any process/effect outcome. */
export function createNativeRecoveryQuarantine(input:NativeRecoverySnapshot):NativeRecoveryQuarantine {
  const raw=data(input,['projectPath','actions','tasks','leases','unclosedProposalIds']);
  if(typeof raw.projectPath!=='string'||!raw.projectPath.length||raw.projectPath.length>4096||!isAbsolute(raw.projectPath)||/[\x00-\x1f\x7f]/.test(raw.projectPath))fail();
  const originalActions=actions(raw.actions),originalTasks=tasks(raw.tasks),originalLeases=leases(raw.leases);
  checkFactoryMappings(originalActions,originalLeases,true);
  const proposals=list(raw.unclosedProposalIds,BOUNDS.proposals).map(id);if(new Set(proposals).size!==proposals.length)fail();
  const resources=new Resources(),actionResources=new Map<string,string[]>();
  for(const row of originalActions)actionResources.set(row.id,actionKeys(row,resources));
  for(const row of originalTasks)resources.add(connection(row.connectionId));
  for(const row of originalLeases)resources.join(leaseKeys(row));
  const closed=new Set(originalLeases.filter(row=>row.state==='closed').map(row=>resources.root(lease(row.id))));
  if(originalLeases.some(row=>row.state!=='closed'&&closed.has(resources.root(lease(row.id)))))fail();
  const groups=new Map<string,string[]>();for(const key of resources.parents.keys()){
    const root=resources.root(key),keys=groups.get(root)??[];keys.push(key);groups.set(root,keys);
  }
  const unsafe=new Set([...groups.keys()].filter(root=>!closed.has(root))),count=unsafe.size;
  const quarantinedActions=new Set(originalActions.filter(row=>actionResources.get(row.id)!.some(key=>unsafe.has(resources.root(key)))).map(row=>row.id));
  const quarantinedTasks=new Set(originalTasks.filter(row=>unsafe.has(resources.root(connection(row.connectionId)))).map(row=>row.id));
  const quarantinedThreads=new Set([...originalActions.filter(row=>quarantinedActions.has(row.id)).flatMap(row=>row.threadId?[row.threadId]:[]),
    ...originalTasks.filter(row=>quarantinedTasks.has(row.id)).map(row=>row.threadId)]);
  const originalActionHashes=new Map(originalActions.map(row=>[row.id,row.fingerprint])),originalTaskHashes=new Map(originalTasks.map(row=>[row.id,row.fingerprint]));
  const hash=createHash('sha256').update(JSON.stringify({version:1,projectPath:raw.projectPath,actions:ordered(originalActions),tasks:ordered(originalTasks),
    leases:ordered(originalLeases),unclosedProposalIds:[...proposals].sort()})).digest('hex');
  const view:NativeRecoveryView=Object.freeze({version:1,fingerprint:hash,nativeReservations:count,legacyActions:quarantinedActions.size,
    legacyTasks:quarantinedTasks.size,legacyThreads:quarantinedThreads.size,legacyProposals:proposals.length});
  function checkOriginals(current:NativeRecoveryOriginals):void {
    const raw=data(current,['actions','tasks']);
    for(const [value,max,expected]of [[raw.actions,BOUNDS.actions,originalActionHashes],[raw.tasks,BOUNDS.tasks,originalTaskHashes]] as const){
      const checked=unique(list(value,max).map(value=>{const row=data(value,['id','fingerprint']);return{id:id(row.id),fingerprint:fingerprint(row.fingerprint)};}));
      const hashes=new Map(checked.map(row=>[row.id,row.fingerprint]));
      for(const [key,hash]of expected)if(hashes.get(key)!==hash)fail('CHANGED');
    }
  }
  function admission(current:readonly NativeRecoveryLease[]):void {
    const checked=leases(current),byId=new Map(checked.map(row=>[row.id,row]));
    checkFactoryMappings(originalActions,checked,false);
    for(const row of originalLeases){
      const now=byId.get(row.id);if(!now||row.connectionId!==null&&now.connectionId!==row.connectionId||(now.requestId??null)!==(row.requestId??null)||
        JSON.stringify(now.requestIds??[])!==JSON.stringify(row.requestIds??[])||
        row.state==='closed'&&(now.state!=='closed'||now.connectionId!==row.connectionId||(now.requestId??null)!==(row.requestId??null))||row.state==='bound'&&now.state==='reserved')fail('CHANGED');
    }
    const combined=new Resources();for(const keys of groups.values())combined.join(keys);
    for(const row of checked)combined.join(leaseKeys(row));
    const legacyUnsafe=new Set<string>(),legacyClosed=new Set<string>();
    for(const [root,keys]of groups){const merged=combined.root(keys[0]!);(unsafe.has(root)?legacyUnsafe:legacyClosed).add(merged);}
    const active=new Set<string>(),currentlyClosed=new Set<string>();
    for(const row of checked)(row.state==='closed'?currentlyClosed:active).add(combined.root(lease(row.id)));
    for(const root of active)if(legacyClosed.has(root)||currentlyClosed.has(root))fail('CHANGED');
    // Later metadata never releases a sealed unresolved charge. Current aliases
    // only avoid charging the SAME owner again; they cannot lower baseline debt.
    const added=[...active].filter(root=>!legacyUnsafe.has(root)).length;
    if(count+added>=NATIVE_RECOVERY_OWNER_CAPACITY)fail('CAPACITY');
  }
  return Object.freeze({legacyTaskIds:Object.freeze([...quarantinedTasks].sort()),legacyProposalIds:Object.freeze([...proposals].sort()),
    fingerprint:hash,nativeReservationCount:count,quarantinesAction:(key:string)=>quarantinedActions.has(key),
    quarantinesTask:(key:string)=>quarantinedTasks.has(key),quarantinesThread:(key:string)=>quarantinedThreads.has(key),
    assertUnchanged:checkOriginals,assertNativeAdmission:admission,view:()=>view});
}
