'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {realpathSync,lstatSync}=require('node:fs');
const {types}=require('node:util');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const HASH=/^[a-f0-9]{64}(?![\s\S])/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
const CODES=new Set(['INPUT','SCOPE','CLOSED','CONFLICT','STALE','RETIRED','LIMIT','REJECTED']);
const CLEANUP=new Set(['ended','cancel','retire','transport-closed','retire-issue']);
const LIMITS=Object.freeze({pending:32,contexts:128,messageBytes:8192});
class AppAssetHostError extends Error {
 constructor(code){super('Private app asset operation '+(code==='UNKNOWN'?'has an unknown outcome.':'was refused.'));this.name='AppAssetHostError';this.code=code;}
}
function error(code){return new AppAssetHostError(code);}
function fields(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))throw error('INPUT');
 const proto=Object.getPrototypeOf(value),own=Reflect.ownKeys(value);
 if((proto!==Object.prototype&&proto!==null)||own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))throw error('INPUT');
 const out={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw error('INPUT');out[key]=d.value;}return out;
}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))throw error('INPUT');return value;}
function actionOf(value){if(!value||typeof value!=='object'||types.isProxy(value))throw error('INPUT');const d=Object.getOwnPropertyDescriptor(value,'outcome');if(!d||!Object.hasOwn(d,'value'))throw error('INPUT');return d.value;}
function snapshotReply(value){
 const outcome=actionOf(value),r=fields(value,['type','protocolVersion','sequence','requestId','projectId','epoch',...(outcome==='ok'?['outcome','result']:['outcome','code'])]);
 if(r.type!=='arcane-app-asset-reply'||r.protocolVersion!==1||!Number.isSafeInteger(r.sequence)||r.sequence<1||typeof r.projectId!=='string'||!HASH.test(r.projectId))throw error('INPUT');
 uuid(r.requestId);uuid(r.epoch);
 if(outcome==='rejected'){if(!CODES.has(r.code))throw error('INPUT');return r;}
 if(outcome!=='ok')throw error('INPUT');
 if(!r.result||typeof r.result!=='object'||types.isProxy(r.result))throw error('INPUT');
 const d=Object.getOwnPropertyDescriptor(r.result,'action');if(!d||!Object.hasOwn(d,'value'))throw error('INPUT');
 if(d.value==='issue'){
  const a=fields(r.result,['action','issueSequence','issueRequestId','credential']);
  if(a.issueSequence!==r.sequence||a.issueRequestId!==r.requestId||typeof a.credential!=='string'||!HASH.test(a.credential))throw error('INPUT');r.result=a;
 }else{const a=fields(r.result,['action']);if(!['open','bind','grant-next','dispatched',...CLEANUP].includes(a.action))throw error('INPUT');r.result=a;}
 if(Buffer.byteLength(JSON.stringify(r))>LIMITS.messageBytes)throw error('INPUT');return r;
}
function transport(provider,value){
 if(provider==='claude-code'){
  const a=fields(value,['kind','incarnationId','nativeSessionId']);
  if(a.kind!=='claude-code-process'||a.nativeSessionId!==null&&(typeof a.nativeSessionId!=='string'||!ID.test(a.nativeSessionId)))throw error('INPUT');
  return{kind:a.kind,incarnationId:uuid(a.incarnationId),nativeSessionId:a.nativeSessionId};
 }
 const a=fields(value,['kind','incarnationId']);if(a.kind!=='arcane-gateway-loop')throw error('INPUT');return{kind:a.kind,incarnationId:uuid(a.incarnationId)};
}
/** Main-process closure only. The caller supplies its exact owned daemon ChildProcess,
 * never a renderer-selected process, PID, token, project or arbitrary RPC name. */
function createAppAssetHost({child,projectPath,timeoutMs=1000}){
 if(!child||typeof child.on!=='function'||typeof child.off!=='function'||typeof child.send!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000)throw error('INPUT');
 const physical=realpathSync(projectPath);if(!lstatSync(physical).isDirectory())throw error('INPUT');
 const projectId=createHash('sha256').update(process.platform==='win32'?physical.toLowerCase():physical).digest('hex'),epoch=randomUUID();
 let sequence=0,closed=false,fenced=false;
 const pending=new Map(),contexts=new Map(),issueCleanupSent=new WeakSet();
 function next(){if(sequence>=Number.MAX_SAFE_INTEGER){fenced=true;throw error('LIMIT');}return++sequence;}
 function make(command){return{type:'arcane-app-asset-request',protocolVersion:1,sequence:next(),requestId:randomUUID(),projectId,epoch,command};}
 function settle(p,value,failure){if(pending.get(p.request.sequence)!==p)return;pending.delete(p.request.sequence);clearTimeout(p.timer);if(failure)p.reject(failure);else p.resolve(value);}
 function sendUnobserved(command){
  if(closed||child.connected===false)return;
  try{const request=make(command);child.send(request,()=>{});}catch{/* No acknowledgement or closure is inferred. */}
 }
 function request(command,prepared){
  if(closed||child.connected===false)return Promise.reject(error('CLOSED'));
  if(fenced&&!CLEANUP.has(command.action))return Promise.reject(error('CLOSED'));
  if(pending.size>=LIMITS.pending){
   if(!CLEANUP.has(command.action))return Promise.reject(error('LIMIT'));
   // Cleanup is admitted at pressure. The displaced receipt becomes UNKNOWN;
   // no live authority/context is evicted and its action is never replayed.
   settle(pending.values().next().value,null,error('UNKNOWN'));
  }
  let r;try{r=make(command);}catch(e){return Promise.reject(e);}
  if(prepared)prepared(r);
  return new Promise((resolve,reject)=>{
   const p={request:r,resolve,reject,timer:null};pending.set(r.sequence,p);
   p.timer=setTimeout(()=>settle(p,null,error('UNKNOWN')),timeoutMs);
   try{child.send(r,e=>{if(e)settle(p,null,error('UNKNOWN'));});}catch{settle(p,null,error('UNKNOWN'));}
  });
 }
 function onMessage(value){
  if(closed)return;let r;try{r=snapshotReply(value);}catch{return;}
  if(r.projectId!==projectId||r.epoch!==epoch)return;
  const p=pending.get(r.sequence);if(!p||r.requestId!==p.request.requestId)return;
  if(r.outcome==='ok'&&r.result.action!==p.request.command.action)return;
  if(r.outcome==='rejected')settle(p,null,error('REJECTED'));else settle(p,r.result,null);
 }
 function fence(){
  if(fenced||closed)return;fenced=true;
  for(const p of [...pending.values()]){
   if(p.request.command.action==='issue'){issueCleanupSent.add(p.request);sendUnobserved({action:'retire-issue',issueSequence:p.request.sequence,issueRequestId:p.request.requestId});}
   settle(p,null,error('UNKNOWN'));
  }
  for(const context of contexts.values())context.fence();
 }
 function close(){
  if(closed)return;fence();closed=true;
  child.off('message',onMessage);child.off('disconnect',close);child.off('exit',close);child.off('error',close);
  for(const p of [...pending.values()])settle(p,null,error('UNKNOWN'));
 }
 child.on('message',onMessage);child.on('disconnect',close);child.on('exit',close);child.on('error',close);
 const opened=request({action:'open'}).then(()=>undefined);
 // Expose failure through ready/issue; never create an unhandled rejection at construction.
 void opened.catch(()=>{});
 async function issue(value){
  const a=fields(value,['provider','conversationId','connectionId']);if(a.provider!=='claude-code'&&a.provider!=='arcane')throw error('INPUT');
  const conversationId=uuid(a.conversationId),connectionId=uuid(a.connectionId);await opened;
  if(fenced||closed)throw error('CLOSED');if(contexts.size>=LIMITS.contexts)throw error('LIMIT');
  // Reserve synchronously across the RPC await; concurrent calls cannot exceed128.
  const reservation={};contexts.set(reservation,{fence(){}});
  let result,issuedRequest;
  try{result=await request({action:'issue',provider:a.provider,conversationId,connectionId},r=>{issuedRequest=r;});}
  catch(failure){
   contexts.delete(reservation);
   // Never retry issue. A NEW command spends the original issue identity;
   // no launch context escaped, so this is a definitive no-child cleanup.
   if(failure?.code==='UNKNOWN'&&issuedRequest&&!closed&&!issueCleanupSent.has(issuedRequest)){
    issueCleanupSent.add(issuedRequest);
    try{await request({action:'retire-issue',issueSequence:issuedRequest.sequence,issueRequestId:issuedRequest.requestId});}
    catch{fence();}
   }
   throw failure;
  }
  if(fenced||closed){contexts.delete(reservation);sendUnobserved({action:'retire-issue',issueSequence:result.issueSequence,issueRequestId:result.issueRequestId});throw error('UNKNOWN');}
  let credential=result.credential,bound=null,bindingKey=null,retired=false,active=null;
  const ref={issueSequence:result.issueSequence,issueRequestId:result.issueRequestId};
  const localRetire=()=>{retired=true;credential=null;};
  const invoke=async(command)=>{
   if(!CLEANUP.has(command.action)&&(retired||fenced||closed))throw error('CLOSED');
   try{const result=await request({...command,...ref});
    if(!CLEANUP.has(command.action)&&(retired||fenced||closed))throw error('UNKNOWN');
    return result;
   }catch(failure){
    if(!CLEANUP.has(command.action)){localRetire();sendUnobserved({action:'retire',...ref});}throw failure;
   }
  };
  contexts.set(reservation,{fence(){localRetire();sendUnobserved({action:'retire',...ref});}});
  const context=Object.freeze({
   launchEnvironment(){if(retired||fenced||closed||typeof credential!=='string')throw error('CLOSED');return Object.freeze(Object.defineProperty(Object.create(null),'ARCANE_ASSET_TOKEN',{value:credential,enumerable:false}));},
   async bind(value){
    const b={kind:'app-conversation',provider:a.provider,conversationId,connectionId,transport:transport(a.provider,value)},encoded=JSON.stringify(b);
    if(bindingKey!==null&&bindingKey!==encoded){localRetire();sendUnobserved({action:'retire',...ref});throw error('CONFLICT');}
    bindingKey=encoded;await invoke({action:'bind',binding:b});bound=encoded;
   },
   async grantNextIntent(){if(bound===null)throw error('INPUT');await invoke({action:'grant-next'});},
   async dispatched(operationId){uuid(operationId);if(bound===null||active!==null)throw error('INPUT');active=operationId;await invoke({action:'dispatched',operationId});},
   async ended(operationId){uuid(operationId);await invoke({action:'ended',operationId});if(active===operationId)active=null;},
   async cancelWork(scope){if(scope!=='active-operation'&&scope!=='incarnation')throw error('INPUT');await invoke({action:'cancel',scope});active=null;},
   async retire(){localRetire();await invoke({action:'retire'});},
   async transportClosed(){localRetire();await invoke({action:'transport-closed'});contexts.delete(reservation);}
  });
  return context;
 }
 return Object.freeze({ready:()=>opened,issue,fence,close});
}
module.exports={createAppAssetHost,AppAssetHostError,APP_ASSET_HOST_LIMITS:LIMITS};
