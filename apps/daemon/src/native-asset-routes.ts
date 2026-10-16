import type {IncomingMessage,ServerResponse} from 'node:http';
import {isIP} from 'node:net';
import {isDeepStrictEqual} from 'node:util';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {parseAdoptGlbInput} from '../../../packages/asset-pipeline/src/adopted-glb.js';
import {normalizeRequest,AssetError} from '../../../packages/asset-pipeline/src/index.js';
import type {AssetService} from './asset-service.js';
import type {createStudioImportStagingController} from './studio-import-staging-controller.js';
import type {NativeAssetConversationHost} from './asset-conversation-host.js';
import {nativeAssetConversationJobPageAsync} from './asset-conversation-page.js';
import {assertNativeAssetActor,nativeAssetActorScope,type NativeAssetRegistry} from './native-asset-authority.js';
import {parseNativeStudioImportResponse} from '../../../packages/asset-pipeline/src/studio-import-wire.js';
import {parseNativeStudioStagingResponse} from '../../../packages/asset-pipeline/src/studio-staging-wire.js';
import {parseNativeStudioStagingStatusResponse} from '../../../packages/asset-pipeline/src/studio-staging-status-wire.js';
import {parseNativeStudioReconstructionResponse,parseNativeStudioReconstructionStatusResponse} from '../../../packages/asset-pipeline/src/studio-reconstruction-wire.js';
export {NATIVE_STUDIO_IMPORT_RESPONSE_BYTES,parseNativeStudioImportResponse} from '../../../packages/asset-pipeline/src/studio-import-wire.js';
import {readAssetJson,discardRejectedAssetBody} from './asset-routes.js';
const PREFIX='/v1/assets/native/';
const METHODS=new Map([['start','POST'],['adopt-glb','POST'],['cancel','POST'],['prepare-studio-import','POST'],['stage-studio-import','POST'],['studio-staging-status','GET'],['reconstruct-studio-import','POST'],['studio-reconstruction-status','GET'],['probe','POST'],['jobs','GET'],['manifest','GET']]);
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
function fail(code:string):never {throw new ArcaneError(code,'Native chat asset request refused.');}
function jobId(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))fail('INPUT');return value;}
function body(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))fail('INPUT');const a=value as Record<string,unknown>;
 if(Object.keys(a).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(a,k)))fail('INPUT');return a;
}
function ingress(request:IncomingMessage,url:URL,origin:string):string {
 const expected=new URL(origin);
 if(expected.protocol!=='http:'||expected.hostname!=='127.0.0.1'||!expected.port||expected.origin!==origin||url.origin!==origin||request.headers.host!==expected.host)fail('HOST');
 const remote=request.socket.remoteAddress;
 if(remote&&!(isIP(remote)===4&&remote==='127.0.0.1')&&remote!=='::ffff:127.0.0.1')fail('HOST');
 const counts=new Map<string,number>();for(let i=0;i<request.rawHeaders.length;i+=2){const name=request.rawHeaders[i]!.toLowerCase();counts.set(name,(counts.get(name)??0)+1);}
 for(const name of ['host','authorization','origin','content-type','content-length','transfer-encoding'])if((counts.get(name)??0)>1)fail('AUTH');
 if(request.headers.origin!==undefined||request.headers['sec-fetch-site']!==undefined)fail('ORIGIN');
 // Native SDK uses a credential header and canonical relative path, never browser identity/Origin.
 const raw=request.url??'';if(!raw.startsWith(PREFIX)||raw.includes('#')||raw.split('?')[0]!==url.pathname||url.username||url.password)fail('INPUT');
 const authorization=request.headers.authorization;const match=typeof authorization==='string'?/^Bearer ([a-f0-9]{64})(?![\s\S])/.exec(authorization):null;
 if(!match)fail('AUTH');return match[1]!;
}
/** Dedicated native audience. Generic/human bearers cannot acquire registry captures.
 * Caller payloads contain bounded recipe/job/page data only, never authority. */
export function nativeAssetRoutes(service:AssetService,host:NativeAssetConversationHost,registry:NativeAssetRegistry,staging?: Pick<ReturnType<typeof createStudioImportStagingController>, 'stage'> & Partial<Pick<ReturnType<typeof createStudioImportStagingController>, 'status'|'reconstruct'|'reconstructionStatus'>>) {
 return async(request:IncomingMessage,response:ServerResponse,url:URL,origin:string):Promise<boolean>=>{
  if(!url.pathname.startsWith(PREFIX))return false;
  const send=async(status:number,payload:unknown,serialized?:string)=>{
   const drained=status<400||await discardRejectedAssetBody(request);if(response.headersSent||response.destroyed)return;
   if(!drained)response.setHeader('Connection','close');response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});response.end(serialized??JSON.stringify(payload));
  };
  try {
   const credential=ingress(request,url,origin),route=url.pathname.slice(PREFIX.length),method=METHODS.get(route);
   if(!method){await send(404,{error:'NOT_FOUND',message:'Unknown native asset route.'});return true;}
   if(request.method!==method){response.setHeader('Allow',method);await send(405,{error:'METHOD',message:'Wrong native asset method.'});return true;}
   const mutation=route==='start'||route==='adopt-glb'||route==='cancel'||route==='prepare-studio-import'||route==='stage-studio-import'||route==='reconstruct-studio-import';
   // Capture BEFORE body reads/queue waits. Never resolve again into a fresh generation.
   const actor=registry.capture(credential,mutation?'mutate':'read');
   const allowed=route==='manifest'||route==='studio-staging-status'||route==='studio-reconstruction-status'?['jobId']:route==='jobs'?['limit','after']:[];
   const seen=new Set<string>();for(const[key]of url.searchParams){if(!allowed.includes(key)||seen.has(key))fail('INPUT');seen.add(key);}
   if(route==='jobs'){
    const text=url.searchParams.get('limit');if(text!==null&&!/^[1-9][0-9]?$/.test(text))fail('INPUT');const limit=text===null?32:Number(text);
    const page=await nativeAssetConversationJobPageAsync(service,host,actor,{limit,after:url.searchParams.get('after')});assertNativeAssetActor(actor,'read');await send(200,page);return true;
   }
   if(route==='manifest'){
    const id=jobId(url.searchParams.get('jobId'));if(!host.bindingNative(actor,id))fail('NOT_FOUND');
    const manifest=await service.manifest(id);assertNativeAssetActor(actor,'read');
    if(!host.bindingNative(actor,id)||manifest.jobId!==id)fail('NOT_FOUND');await send(200,{manifest});return true;
   }
   if(route==='studio-staging-status'){
    const id=jobId(url.searchParams.get('jobId')),binding=host.bindingNative(actor,id);if(!binding)fail('NOT_FOUND');
    if(!staging?.status)fail('STUDIO_STAGE_UNAVAILABLE');
    const scope=nativeAssetActorScope(actor),result=await staging.status(id,actor);
    assertNativeAssetActor(actor,'read');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    const envelope=parseNativeStudioStagingStatusResponse(result,id,scope.projectId),serialized=JSON.stringify(envelope);
    if(serialized.includes(credential))fail('STUDIO_STAGE_RESPONSE');
    assertNativeAssetActor(actor,'read');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    await send(200,envelope,serialized);return true;
   }
   if(route==='studio-reconstruction-status'){
    const id=jobId(url.searchParams.get('jobId')),binding=host.bindingNative(actor,id);if(!binding)fail('NOT_FOUND');
    if(!staging?.reconstructionStatus)fail('STUDIO_RECONSTRUCT_UNAVAILABLE');
    const scope=nativeAssetActorScope(actor),result=await staging.reconstructionStatus(id,actor);
    assertNativeAssetActor(actor,'read');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    const envelope=parseNativeStudioReconstructionStatusResponse(result,id,scope.projectId),serialized=JSON.stringify(envelope);
    if(serialized.includes(credential))fail('STUDIO_RECONSTRUCT_RESPONSE');
    assertNativeAssetActor(actor,'read');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    await send(200,envelope,serialized);return true;
   }
   const input=await readAssetJson(request,route==='start');assertNativeAssetActor(actor,mutation?'mutate':'read');
   if(route==='adopt-glb'){
    const checked=parseAdoptGlbInput(input);if(!host.adoptNative)fail('ASSET_ADOPT_UNAVAILABLE');
    const result=await host.adoptNative(actor,checked);
    await send(result.association==='bound'&&result.creation==='created'?200:202,result);return true;
   }
   if(route==='start'){
    // Shared pure normalization rejects added scope/identity/callback fields before creation.
    normalizeRequest(input);const result=await host.startNative(actor,input);
    await send(result.association==='bound'&&result.creation==='created'?200:202,result);return true;
   }
   if(route==='cancel'){
    const id=jobId(body(input,['jobId']).jobId);if(!host.bindingNative(actor,id))fail('NOT_FOUND');assertNativeAssetActor(actor,'mutate');
    // cancel() performs its mutation synchronously before its first await. Accepted
    // work retains original scope even if revocation happens while completion drains.
    try {await send(200,{job:await service.cancel(id)});}
    catch {await send(202,{jobId:id,state:'unknown',retry:false});}return true;
   }
   if(route==='prepare-studio-import'){
    const id=jobId(body(input,['jobId']).jobId),binding=host.bindingNative(actor,id);if(!binding)fail('NOT_FOUND');
    assertNativeAssetActor(actor,'mutate');
    const prepared=await service.prepareStudioImport(id,actor);
    assertNativeAssetActor(actor,'mutate');
    if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    const result=parseNativeStudioImportResponse({prepared},id,nativeAssetActorScope(actor).projectId),serialized=JSON.stringify(result);
    if(serialized.includes(credential))fail('STUDIO_IMPORT_RESPONSE');
    // No await between this final fence and the synchronous successful send.
    assertNativeAssetActor(actor,'mutate');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    await send(200,result,serialized);return true;
   }
   if(route==='stage-studio-import'){
    const id=jobId(body(input,['jobId']).jobId),binding=host.bindingNative(actor,id);if(!binding)fail('NOT_FOUND');
    if(!staging)fail('STUDIO_STAGE_UNAVAILABLE');
    const scope=nativeAssetActorScope(actor);
    const result=await staging.stage(id,actor);
    assertNativeAssetActor(actor,'mutate');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    // Pending CPU intake is not upload/insertion. No caller supplies target,
    // packet bytes, account IDs, permissions or baseline claims to this route.
    const envelope=parseNativeStudioStagingResponse({jobId:id,projectId:scope.projectId,staged:result},id,scope.projectId);
    const serialized=JSON.stringify(envelope);if(serialized.includes(credential))fail('STUDIO_STAGE_RESPONSE');
    // Scope fields come from the original native capture, never its request.
    // Parsing is followed by a final fence before the synchronous successful send.
    assertNativeAssetActor(actor,'mutate');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    await send(200,envelope,serialized);return true;
   }
   if(route==='reconstruct-studio-import'){
    const id=jobId(body(input,['jobId']).jobId),binding=host.bindingNative(actor,id);if(!binding)fail('NOT_FOUND');
    if(!staging?.reconstruct)fail('STUDIO_RECONSTRUCT_UNAVAILABLE');
    const scope=nativeAssetActorScope(actor),result=await staging.reconstruct(id,actor);
    assertNativeAssetActor(actor,'mutate');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    const envelope=parseNativeStudioReconstructionResponse({jobId:id,projectId:scope.projectId,reconstructed:result},id,scope.projectId),serialized=JSON.stringify(envelope);
    if(serialized.includes(credential))fail('STUDIO_RECONSTRUCT_RESPONSE');
    assertNativeAssetActor(actor,'mutate');if(!isDeepStrictEqual(binding,host.bindingNative(actor,id)))fail('NOT_FOUND');
    await send(200,envelope,serialized);return true;
   }
   body(input,[]);assertNativeAssetActor(actor,'read');
   // Probe is an admitted metadata read, not generation or native write permission.
   const probe=await service.probe();assertNativeAssetActor(actor,'read');await send(200,{probe});return true;
  }catch(error){
   const code=error instanceof ArcaneError||error instanceof AssetError?error.code:'NATIVE_ASSET_UNAVAILABLE';
   const status=code==='HOST'||code==='ORIGIN'||code==='AUTH'||code==='NATIVE_ASSET_AUTHORITY'?403:code==='NOT_FOUND'?404:code==='BODY_LIMIT'?413:code==='BODY_TIMEOUT'?408:code==='ASSET_ADOPT_GLB'?422:code==='ASSET_ADOPT_INPUT'||code==='ASSET_ADOPT_PATH'||code==='INPUT'||code==='CONTENT_TYPE'||code==='JSON'||code==='BODY'?400:503;
   await send(status,{error:code,message:'Native chat asset request refused or unavailable.'});return true;
  }
 };
}
