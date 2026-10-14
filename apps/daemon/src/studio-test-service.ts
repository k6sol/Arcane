import {randomUUID} from 'node:crypto';
import {mkdir,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {discoverNativeStudioExecutable} from '../../../packages/studio-adapter/src/discovery.js';
import {StudioStore} from '../../../packages/storage/src/studio-store.js';
import {createStudioTestControl,NativeTestAdapter,TestLedger,digest,StudioTestError,type ConsentDisplay,type TestBinding,type TestReview} from '../../../packages/studio-test-controller/src/index.js';
import {decodeTestInventory,decodeTestState,decodeTestMode,decodeTestLogs} from './studio-test-decoders.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hash=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.strictObject({sessionId:id,nativeStudioId:id.optional(),durationMs:z.number().int().min(5000).max(60000).default(15000),observationIntervalMs:z.number().int().min(250).max(2000).default(1000),failOnRuntimeError:z.boolean().default(true)});
const approval=z.strictObject({id,displayDigest:hash});
const witnessSchema=z.strictObject({placeId:z.number().int().nonnegative(),universeId:z.number().int().nonnegative(),placeName:z.string().max(512),sessionId:id,clientLifetimeId:id,pluginArtifactHash:hash});
type Witness=z.infer<typeof witnessSchema>;
export interface NativeTestConnection {client:Client;evidence:'native'|'fixture';witness(studioId:string,markerName:string,mode:'Edit'|'Play',signal:AbortSignal):Promise<Witness>;close():Promise<void>}
interface Options {directory:string;store:StudioStore;pluginArtifactHash:string;connect?:()=>Promise<NativeTestConnection>}
export interface StudioTestView {id:string;targetName:string;actor:string;state:'needs_approval'|'running'|'complete'|'cancelled';display:Readonly<ConsentDisplay>;displayDigest:string;review:Readonly<TestReview>;evidence:'fixture'|'native';nativeAcceptance:false}
type Job={view:StudioTestView;control:ReturnType<typeof createStudioTestControl>;connection:NativeTestConnection;proposalId:string;expiry:ReturnType<typeof setTimeout>;closing:Promise<void>|null;cancelled:boolean;reserved:boolean};
function rejected(code:'INVALID_REQUEST'|'BINDING_CHANGED'|'BUSY'|'PLACE_DENIED'|'STALE_PROOF'|'HUMAN_AUTH_REQUIRED'|'FENCED'|'BAD_NATIVE_RESPONSE'):never{throw new StudioTestError(code);}

/** Dedicated vetted SDK client. The only additional execution is this fixed
 * read-only metadata witness; no caller Luau, paths, flags or URLs are accepted. */
async function connectNativeTest():Promise<NativeTestConnection>{
  const executable=await discoverNativeStudioExecutable();
  const transport=new StdioClientTransport({command:executable.path,args:[],cwd:dirname(executable.path),stderr:'ignore',maxBufferSize:512*1024});
  const client=new Client({name:'arcane-owned-playtest',version:'0.1.0'},{capabilities:{}});
  try{
    await client.connect(transport,{timeout:10000,maxTotalTimeout:10000});
    if(client.getServerVersion()?.name!=='RobloxStudio')rejected('BAD_NATIVE_RESPONSE');
    // Query the real advertised witness schema before ever using privileged code.
    const inventory=await client.listTools({}, {timeout:5000,maxTotalTimeout:5000});
    const tool=inventory.tools.find(t=>t.name==='execute_luau');
    if(inventory.nextCursor||inventory.tools.length>128||!tool||tool.inputSchema.type!=='object'||!['code','studio_id','datamodel_type'].every(k=>tool.inputSchema.required?.includes(k)))rejected('BAD_NATIVE_RESPONSE');
    return {client,evidence:'native',async witness(studioId,markerName,mode,signal){
      if(!id.safeParse(studioId).success||!/^ArcaneTestProof_[A-Za-z0-9_-]{1,128}$/.test(markerName))rejected('INVALID_REQUEST');
      const q=JSON.stringify(markerName);
      const code=`local f=game:GetService("ServerStorage"):FindFirstChild(${q}); assert(f and f:IsA("Folder"),"Arcane mapping witness unavailable"); return {placeId=game.PlaceId,universeId=game.GameId,placeName=game.Name,sessionId=f:GetAttribute("SessionId"),clientLifetimeId=f:GetAttribute("ClientLifetimeId"),pluginArtifactHash=f:GetAttribute("PluginArtifactHash")}`;
      const result=CallToolResultSchema.parse(await client.callTool({name:'execute_luau',arguments:{studio_id:studioId,datamodel_type:mode==='Edit'?'Edit':'Server',code}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000,resetTimeoutOnProgress:false}));
      if(result.isError||result.content.length!==1||result.content[0]?.type!=='text'||Buffer.byteLength(result.content[0].text)>4096)rejected('BAD_NATIVE_RESPONSE');
      try{return witnessSchema.parse(JSON.parse(result.content[0].text));}catch{rejected('BAD_NATIVE_RESPONSE');}
    },async close(){await client.close();await transport.close();}};
  }catch(error){await client.close().catch(()=>{});await transport.close().catch(()=>{});throw error;}
}

/** Real product lifecycle, not a fixture-only controller. Human approval is a
 * separate port; neither pairing writes nor model JSON can create that consent.
 * Current native safety admission remains unpublished local places only. */
export async function createStudioTestService(options:Options){
  if(!hash.safeParse(options.pluginArtifactHash).success)rejected('INVALID_REQUEST');
  await mkdir(options.directory,{recursive:true,mode:0o700});const root=await realpath(options.directory);
  const ledger=await TestLedger.open(join(root,'ledger'),root);
  let current:Job|null=null, preparing=false,closed=false;
  const jobs=new Map<string,Job>();const humanContexts=new WeakSet<object>();
  const identity=(s:ReturnType<StudioStore['session']>)=>digest({sessionId:s.id,clientLifetimeId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,name:s.name,roots:s.allowedRoots,writes:s.allowWrites,revoked:s.revokedAt});
  const eligible=(sessionId:string)=>{const s=options.store.session(sessionId);if(s.placeId!==0||s.universeId!==0||!s.allowWrites)rejected('PLACE_DENIED');return s;};
  const view=(j:Job)=>structuredClone({...j.view,review:j.control.requests.status()});
  const owned=(jobId:string,actor:string)=>{const j=jobs.get(jobId);if(!j||!(actor==='human'||j.view.actor===actor))rejected('HUMAN_AUTH_REQUIRED');return j;};
  const closeJob=(j:Job):Promise<void>=>{
    if(j.closing)return j.closing;clearTimeout(j.expiry);
    j.closing=(async()=>{try{await j.control.lifecycle.shutdown();}finally{const review=j.control.requests.status();if(j.reserved&&review.cleanup==='complete'){options.store.releaseTest(j.view.display.proposal.binding.pairedSessionId,j.view.id);j.reserved=false;}await j.connection.close();}})();return j.closing;
  };
  const prepare=async(input:unknown,actor:string):Promise<StudioTestView>=>{
    if(closed||preparing||current&&(current.view.state==='needs_approval'||current.view.state==='running')||ledger.unresolved())rejected('BUSY');
    if(!id.safeParse(actor).success)rejected('HUMAN_AUTH_REQUIRED');
    const a=request.parse(input),session=eligible(a.sessionId),p=session.proof;
    if(!p||!p.connected||!p.continuitySupported||p.pluginArtifactHash!==options.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    preparing=true;let connection:NativeTestConnection|undefined;
    try{
      connection=await(options.connect??connectNativeTest)();
      const result=await connection.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{timeout:5000,maxTotalTimeout:5000});
      const inventory=decodeTestInventory(result) as {id:string;name:string}[];
      const candidates=a.nativeStudioId?inventory.filter(s=>s.id===a.nativeStudioId):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const binding:TestBinding={nativeStudioId:candidates[0]!.id,pairedSessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:p.pluginArtifactHash,scopeRevision:identity(session),placeId:0};
      const native=connection;let lastWitness:Witness|null=null;
      const proofReader={async read(wanted:TestBinding,signal:AbortSignal){
        const deadline=Date.now()+5000;
        let s=options.store.session(wanted.pairedSessionId,false),proof=s.proof;
        // Wait for the actual authenticated plugin heartbeat after a native mode
        // transition. Never manufacture an epoch from sampled state booleans.
        const stateResult=await native.client.callTool({name:'get_studio_state',arguments:{studio_id:wanted.nativeStudioId}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000});
        const state=decodeTestMode(stateResult);
        while(proof&&proof.mode!==state.mode&&Date.now()<deadline&&!signal.aborted){await new Promise(r=>setTimeout(r,50));s=options.store.session(wanted.pairedSessionId,false);proof=s.proof;}
        if(signal.aborted||!proof||proof.mode!==state.mode||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==wanted.clientLifetimeId||proof.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('STALE_PROOF');
        const before=digest(proof);const witness=await native.witness(wanted.nativeStudioId,proof.markerName,proof.mode,signal);
        if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('BINDING_CHANGED');
        const after=options.store.session(s.id,false),fresh=after.proof;
        if(!fresh||digest({...fresh,observedAt:proof.observedAt,expiresAt:proof.expiresAt})!==before)rejected('BINDING_CHANGED');
        lastWitness=witness;
        return {binding:{...wanted,scopeRevision:identity(after)},observedAt:Date.parse(fresh.observedAt),expiresAt:Date.parse(fresh.expiresAt),connected:fresh.connected,revoked:!!after.revokedAt,protectedPlace:after.placeId!==0||after.universeId!==0,testActionsAllowed:after.allowWrites,playEpoch:fresh.playEpoch,continuitySupported:fresh.continuitySupported};
      }};
      let control:ReturnType<typeof createStudioTestControl>;
      const adapter=new NativeTestAdapter({client:native.client,evidence:native.evidence,pairedProof:proofReader,requestTimeoutMs:5000,proofMaxAgeMs:6000,onDisconnect:()=>control?.lifecycle.onDisconnect(),decoder:{inventory:decodeTestInventory,state:(r,studioId)=>{if(!lastWitness||lastWitness.placeId!==0)rejected('BAD_NATIVE_RESPONSE');return decodeTestState(r,{nativeStudioId:studioId,placeId:lastWitness.placeId});},logs:decodeTestLogs}});
      control=createStudioTestControl({adapter,ledger,requestTimeoutMs:15000,cleanupGraceMs:15000,proofMaxAgeMs:6000,humanVerifier:{async confirm(context,display,displayDigest,signal){return typeof context==='object'&&context!==null&&humanContexts.has(context)&&digest(display)===displayDigest&&!signal.aborted;}},onStatus(status){if(current?.control===control&&status.phase==='done')current.view.state=current.cancelled?'cancelled':'complete';}});
      const prepared=await control.requests.prepare({binding,durationMs:a.durationMs,observationIntervalMs:a.observationIntervalMs,failOnRuntimeError:a.failOnRuntimeError});
      const jobId=randomUUID();
      const j:Job={view:{id:jobId,targetName:session.name,actor,state:'needs_approval',display:prepared.display,displayDigest:prepared.displayDigest,review:control.requests.status(),evidence:native.evidence,nativeAcceptance:false},control,connection:native,proposalId:prepared.proposalId,expiry:setTimeout(()=>{if(j.view.state==='needs_approval'){j.cancelled=true;j.view.state='cancelled';void closeJob(j).catch(()=>{});}},60000),closing:null,cancelled:false,reserved:false};
      // Internal preparation identity is deliberately not request-controlled.
      current=j;jobs.set(jobId,j);if(jobs.size>64)jobs.delete(jobs.keys().next().value!);connection=undefined;return view(j);
    }finally{preparing=false;if(connection)await connection.close();}
  };
  return Object.freeze({
    requests:Object.freeze({
      prepare,status:(jobId:string,actor:string)=>view(owned(jobId,actor)),
      list:(actor:string)=>[...jobs.values()].filter(j=>actor==='human'||j.view.actor===actor).map(view),
      async cancel(jobId:string,actor:string){
        const j=owned(jobId,actor);j.cancelled=true;
        if(j.view.state==='needs_approval')j.view.state='cancelled';
        const runId=j.control.requests.status().runId;
        if(runId&&j.control.requests.status().phase!=='done')await j.control.requests.stop({runId});
        await closeJob(j);return view(j);
      },
    }),
    humanControl:Object.freeze({async approve(input:unknown,guard:()=>void){
      guard();const a=approval.parse(input),j=owned(a.id,'human');
      if(closed||j!==current||j.cancelled||j.view.state!=='needs_approval'||a.displayDigest!==j.view.displayDigest)rejected('HUMAN_AUTH_REQUIRED');
      const session=eligible(j.view.display.proposal.binding.pairedSessionId);
      if(identity(session)!==j.view.display.proposal.binding.scopeRevision)rejected('BINDING_CHANGED');
      if(!session.proof?.connected||Date.parse(session.proof.expiresAt)<=Date.now())rejected('STALE_PROOF');
      const context=Object.freeze({});humanContexts.add(context);
      try{
        const consentId=await j.control.humanControl.confirm(j.proposalId,context);guard();
        if(j.cancelled)rejected('HUMAN_AUTH_REQUIRED');
        options.store.reserveTest(j.view.display.proposal.binding.pairedSessionId,j.view.id);j.reserved=true;clearTimeout(j.expiry);
        try{await j.control.requests.start({proposalId:j.proposalId,consentId});}
        catch(error){j.view.state='complete';await closeJob(j);throw error;}
        j.view.state='running';
        void j.control.requests.wait({runId:j.control.requests.status().runId!}).finally(()=>closeJob(j)).catch(()=>{});
        return view(j);
      }finally{humanContexts.delete(context);}
    }}),
    lifecycle:Object.freeze({async close(){closed=true;try{if(current)await closeJob(current);}finally{await ledger.close();}}}),
  });
}
export type StudioTestService=Awaited<ReturnType<typeof createStudioTestService>>;
