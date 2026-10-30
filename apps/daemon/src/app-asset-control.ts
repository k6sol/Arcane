import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {workflowProjectIdentity} from '../../../packages/storage/src/workflow-store.js';
import type {AppAssetConversationBinding} from '../../../packages/protocol/src/asset-conversation.js';
import type {NativeAssetIncarnation,NativeAssetRegistry} from './native-asset-authority.js';
import {nativeAssetActorScope} from './native-asset-authority.js';
import {snapshotAppAssetHumanSelection,type AppAssetHumanSelection,type AppAssetHumanSelectionHost} from './app-asset-human-selection.js';

export const APP_ASSET_CONTROL_LIMITS=Object.freeze({messageBytes:8192,receiptsPerContext:64,contexts:128});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const HASH=/^[a-f0-9]{64}(?![\s\S])/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
type Provider=AppAssetConversationBinding['provider'];
type IssueReference={issueSequence:number;issueRequestId:string};
type Command=
 | {action:'open'}
 | {action:'select-human';selection:AppAssetHumanSelection}
 | {action:'issue';provider:Provider;conversationId:string;connectionId:string}
 | (IssueReference&{action:'bind';binding:AppAssetConversationBinding})
 | (IssueReference&{action:'grant-next'|'retire'|'transport-closed'|'retire-issue'})
 | (IssueReference&{action:'model-source';sessionId:string})
 | (IssueReference&{action:'dispatched'|'ended';operationId:string})
 | (IssueReference&{action:'cancel';scope:'active-operation'|'incarnation'});
export interface AppAssetRequest {
 readonly type:'arcane-app-asset-request';readonly protocolVersion:1;
 readonly sequence:number;readonly requestId:string;readonly projectId:string;readonly epoch:string;readonly command:Command;
}
type Code='INPUT'|'SCOPE'|'CLOSED'|'CONFLICT'|'STALE'|'RETIRED'|'LIMIT'|'REJECTED';
type Header={type:'arcane-app-asset-reply';protocolVersion:1;sequence:number;requestId:string;projectId:string;epoch:string};
export type AppAssetReply=Header&(
 | {outcome:'ok';result:{action:Command['action'];issueSequence?:number;issueRequestId?:string;credential?:string}}
 | {outcome:'rejected';code:Code}
);
class Refusal extends Error {constructor(readonly code:Code){super('Private app asset control refused this operation.');}}
function fail(code:Code='INPUT'):never{throw new Refusal(code);}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))fail();
 const proto=Object.getPrototypeOf(value),own=Reflect.ownKeys(value);
 if(proto!==Object.prototype&&proto!==null||own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail();
 const result:Record<string,unknown>={};
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail();result[key]=descriptor.value;}
 return result;
}
function uuid(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))fail();return value;}
function sequence(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)fail();return value;}
function issueReference(value:Record<string,unknown>):IssueReference{return{issueSequence:sequence(value.issueSequence),issueRequestId:uuid(value.issueRequestId)};}
function identifier(value:unknown):string{if(typeof value!=='string'||!ID.test(value))fail();return value;}
function provider(value:unknown):Provider{if(value!=='claude-code'&&value!=='arcane')fail();return value;}
function binding(value:unknown):AppAssetConversationBinding{
 const a=fields(value,['kind','connectionId','provider','conversationId','transport']);
 if(a.kind!=='app-conversation')fail();const p=provider(a.provider),connectionId=uuid(a.connectionId),conversationId=uuid(a.conversationId);
 if(p==='claude-code'){
  const t=fields(a.transport,['kind','incarnationId','nativeSessionId']);if(t.kind!=='claude-code-process')fail();
  return{kind:'app-conversation',connectionId,conversationId,provider:p,transport:{kind:'claude-code-process',incarnationId:uuid(t.incarnationId),nativeSessionId:t.nativeSessionId===null?null:identifier(t.nativeSessionId)}};
 }
 const t=fields(a.transport,['kind','incarnationId']);if(t.kind!=='arcane-gateway-loop')fail();
 return{kind:'app-conversation',connectionId,conversationId,provider:p,transport:{kind:'arcane-gateway-loop',incarnationId:uuid(t.incarnationId)}};
}
function command(value:unknown):Command{
 if(!value||typeof value!=='object'||types.isProxy(value))fail();const descriptor=Object.getOwnPropertyDescriptor(value,'action');
 if(!descriptor||!Object.hasOwn(descriptor,'value'))fail();const action:unknown=descriptor.value;
 if(action==='open'){fields(value,['action']);return{action};}
 if(action==='select-human'){
  const a=fields(value,['action','selection']);
  try{return{action,selection:snapshotAppAssetHumanSelection(a.selection)};}catch{return fail();}
 }
 if(action==='issue'){const a=fields(value,['action','provider','conversationId','connectionId']);return{action,provider:provider(a.provider),conversationId:uuid(a.conversationId),connectionId:uuid(a.connectionId)};}
 if(action==='bind'){const a=fields(value,['action','issueSequence','issueRequestId','binding']);return{action,...issueReference(a),binding:binding(a.binding)};}
 if(action==='model-source'){const a=fields(value,['action','issueSequence','issueRequestId','sessionId']);if(typeof a.sessionId!=='string'||!/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(a.sessionId))fail();return{action,...issueReference(a),sessionId:a.sessionId};}
 if(action==='grant-next'||action==='retire'||action==='transport-closed'||action==='retire-issue'){const a=fields(value,['action','issueSequence','issueRequestId']);return{action,...issueReference(a)};}
 if(action==='dispatched'||action==='ended'){const a=fields(value,['action','issueSequence','issueRequestId','operationId']);return{action,...issueReference(a),operationId:uuid(a.operationId)};}
 if(action==='cancel'){const a=fields(value,['action','issueSequence','issueRequestId','scope']);if(a.scope!=='active-operation'&&a.scope!=='incarnation')fail();return{action,...issueReference(a),scope:a.scope};}
 return fail();
}
export function snapshotAppAssetRequest(value:unknown):AppAssetRequest{
 const a=fields(value,['type','protocolVersion','sequence','requestId','projectId','epoch','command']);
 if(a.type!=='arcane-app-asset-request'||a.protocolVersion!==1||typeof a.projectId!=='string'||!HASH.test(a.projectId))fail();
 const snapshot:AppAssetRequest={type:a.type,protocolVersion:1,sequence:sequence(a.sequence),requestId:uuid(a.requestId),projectId:a.projectId,epoch:uuid(a.epoch),command:command(a.command)};
 if('issueSequence'in snapshot.command&&snapshot.command.issueSequence>=snapshot.sequence)fail();
 if(Buffer.byteLength(JSON.stringify(snapshot))>APP_ASSET_CONTROL_LIMITS.messageBytes)fail();return snapshot;
}
const cleanup=(action:Command['action'])=>['ended','cancel','retire','transport-closed','retire-issue'].includes(action);
interface Entry {
 issueSequence:number;issueRequestId:string;provider:Provider;conversationId:string;connectionId:string;handle:NativeAssetIncarnation;
 credential:string|null;bound:string|null;retired:boolean;activeOperation:string|null;
 receipts:Set<number>;
}
export interface AppAssetControl {accept(value:unknown):AppAssetReply|null;close():void}
/** Trusted parent-only port. No HTTP, renderer, agent, persistence or provider invocation. */
export function createAppAssetControl(options:{projectPath:string;registry:NativeAssetRegistry;humanSelection?:Pick<AppAssetHumanSelectionHost,'select'>}):AppAssetControl{
 const project=workflowProjectIdentity(options.projectPath),registry=options.registry;
 if(!registry||typeof registry.issue!=='function')fail('SCOPE');
 if(options.humanSelection!==undefined&&(!options.humanSelection||typeof options.humanSelection.select!=='function'))fail('SCOPE');
 const entries=new Map<number,Entry>();
 const history=new Map<number,{owner:Entry;digest:string;reply:AppAssetReply}>();let epoch:string|null=null,closed=false,highWater=0;
 const header=(r:Pick<AppAssetRequest,'sequence'|'requestId'|'projectId'|'epoch'>):Header=>({type:'arcane-app-asset-reply',protocolVersion:1,sequence:r.sequence,requestId:r.requestId,projectId:r.projectId,epoch:r.epoch});
 const rejected=(r:AppAssetRequest,code:Code):AppAssetReply=>({...header(r),outcome:'rejected',code});
 function retire(entry:Entry):void{
  entry.retired=true;entry.credential=null;entry.activeOperation=null;entry.handle.retire();
  // An exact issue replay cannot recover plaintext after its authority retires.
  history.delete(entry.issueSequence);entry.receipts.delete(entry.issueSequence);
 }
 function sweep():void{
  for(const [id,entry]of entries)if(entry.handle.status().released){entry.credential=null;for(const receipt of entry.receipts)history.delete(receipt);entries.delete(id);}
 }
 function perform(r:AppAssetRequest):AppAssetReply{
  const c=r.command;
  if(c.action==='open'){if(epoch!==null&&epoch!==r.epoch)fail('SCOPE');epoch=r.epoch;return{...header(r),outcome:'ok',result:{action:c.action}};}
  if(epoch===null||r.epoch!==epoch)fail('SCOPE');
  if(c.action==='select-human'){
   if(!options.humanSelection)fail('SCOPE');
   options.humanSelection.select(c.selection);
   return{...header(r),outcome:'ok',result:{action:c.action}};
  }
  if(c.action==='issue'){
   if(entries.size>=APP_ASSET_CONTROL_LIMITS.contexts)fail('LIMIT');
   const handle=registry.issue();let credential:string;
   try{credential=handle.credential();if(!HASH.test(credential))fail();}catch(error){handle.retire();handle.transportClosed();throw error;}
   entries.set(r.sequence,{issueSequence:r.sequence,issueRequestId:r.requestId,provider:c.provider,conversationId:c.conversationId,connectionId:c.connectionId,handle,credential,bound:null,retired:false,activeOperation:null,receipts:new Set()});
   return{...header(r),outcome:'ok',result:{action:c.action,issueSequence:r.sequence,issueRequestId:r.requestId,credential}};
  }
  const entry=entries.get(c.issueSequence);
  if(entry&&entry.issueRequestId!==c.issueRequestId)fail('SCOPE');
  if(c.action==='retire-issue'){
   // Issuing must finish before a launch context is returned. This cleanup is
   // definitive no-child only; a bound transport may never be declared closed.
   if(entry){retire(entry);if(entry.bound!==null)fail('CONFLICT');entry.handle.transportClosed();sweep();}
   return{...header(r),outcome:'ok',result:{action:c.action}};
  }
  if(!entry){if(cleanup(c.action))return{...header(r),outcome:'ok',result:{action:c.action}};fail('RETIRED');}
  if(entry.retired&&!cleanup(c.action))fail('RETIRED');
  switch(c.action){
   case'bind':{
    const b=c.binding;
    if(b.provider!==entry.provider||b.conversationId!==entry.conversationId||b.connectionId!==entry.connectionId){retire(entry);fail('CONFLICT');}
    const encoded=JSON.stringify(b);if(entry.bound!==null&&entry.bound!==encoded){retire(entry);fail('CONFLICT');}
    entry.handle.bindAppConversation(b);
    // The trusted composition must not accidentally lend another project's registry.
    if(entry.credential===null)fail('RETIRED');
    const scope=nativeAssetActorScope(registry.capture(entry.credential,'read'));
    if(scope.projectId!==project.projectId||scope.projectPath!==project.projectPath||scope.conversation.provider!==entry.provider||scope.conversation.threadId!=='app:'+entry.conversationId||scope.conversation.sessionId!==null)fail('SCOPE');
    entry.bound=encoded;break;
   }
   case'model-source':if(entry.bound===null)fail('SCOPE');entry.handle.grantModelSource(c.sessionId);break;
   case'grant-next':if(entry.bound===null)fail('SCOPE');entry.handle.grantNextIntent({connectionId:entry.connectionId,threadId:'app:'+entry.conversationId,sessionId:null});break;
   case'dispatched':if(entry.bound===null||entry.activeOperation!==null)fail('SCOPE');entry.handle.dispatched({connectionId:entry.connectionId,threadId:'app:'+entry.conversationId,operationId:c.operationId});entry.activeOperation=c.operationId;break;
   case'ended':if(entry.activeOperation!==null&&entry.activeOperation!==c.operationId)fail('SCOPE');entry.handle.ended(c.operationId);entry.activeOperation=null;break;
   case'cancel':entry.handle.cancelWork(c.scope);entry.activeOperation=null;break;
   case'retire':retire(entry);break;
   case'transport-closed':retire(entry);entry.handle.transportClosed();sweep();break;
  }
  return{...header(r),outcome:'ok',result:{action:c.action}};
 }
 return Object.freeze({
  accept(value:unknown):AppAssetReply|null{
   let r:AppAssetRequest;try{r=snapshotAppAssetRequest(value);}catch{return null;}
   if(closed)return rejected(r,'CLOSED');if(r.projectId!==project.projectId)return rejected(r,'SCOPE');
   if(epoch!==null&&r.epoch!==epoch)return rejected(r,'SCOPE');
   if(epoch===null&&r.command.action!=='open')return rejected(r,'SCOPE');
   sweep();
   const digest=createHash('sha256').update(JSON.stringify(r)).digest('hex'),prior=history.get(r.sequence);
   if(prior){if(prior.digest===digest)return structuredClone(prior.reply);
    retire(prior.owner);return rejected(r,'CONFLICT');}
   if(r.sequence<=highWater)return rejected(r,'STALE');
   // UUIDs are correlation identities, not a second way to repeat an admitted
   // action. Retain them only with bounded receipts and original live issues.
   const collision=[...history.values()].find(value=>value.reply.requestId===r.requestId)?.owner
    ??[...entries.values()].find(value=>value.issueRequestId===r.requestId);
   if(collision){highWater=r.sequence;retire(collision);return rejected(r,'CONFLICT');}
   // Exact schema/project/epoch validation above must precede admission. Gaps
   // are spent too, so an earlier missing issue cannot allocate after cleanup.
   highWater=r.sequence;
   let reply:AppAssetReply;
   try{reply=perform(r);}catch(error){
    if(['bind','model-source','grant-next','dispatched'].includes(r.command.action)&&'issueSequence'in r.command){const entry=entries.get(r.command.issueSequence);if(entry&&entry.issueRequestId===r.command.issueRequestId)retire(entry);}
    reply=rejected(r,error instanceof Refusal?error.code:'REJECTED');
   }
   let owner=r.command.action==='issue'?entries.get(r.sequence):'issueSequence'in r.command?entries.get(r.command.issueSequence):undefined;
   if(owner&&'issueRequestId'in r.command&&owner.issueRequestId!==r.command.issueRequestId)owner=undefined;
   if(owner){history.set(r.sequence,{owner,digest,reply:structuredClone(reply)});owner.receipts.add(r.sequence);
    while(owner.receipts.size>APP_ASSET_CONTROL_LIMITS.receiptsPerContext){const first=owner.receipts.values().next().value;if(first===undefined)break;owner.receipts.delete(first);history.delete(first);}}
   return reply;
  },
  close():void{if(closed)return;closed=true;for(const entry of entries.values())retire(entry);history.clear();}
 });
}
/** Only product-main's owned Node parent pipe calls this dispatcher. */
export function routeAppAssetMessage(control:AppAssetControl|null,value:unknown,send:(reply:AppAssetReply)=>void):boolean{
 if(!value||typeof value!=='object'||types.isProxy(value))return false;
 const tag=Object.getOwnPropertyDescriptor(value,'type');if(!tag||!Object.hasOwn(tag,'value')||tag.value!=='arcane-app-asset-request')return false;
 const reply=control?.accept(value);if(reply)try{send(reply);}catch{control?.close();}return true;
}
