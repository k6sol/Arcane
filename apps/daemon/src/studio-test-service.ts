import {randomUUID} from 'node:crypto';
import {mkdir,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {discoverNativeStudioExecutable} from '../../../packages/studio-adapter/src/discovery.js';
import {StudioStore,type StudioTestReservation} from '../../../packages/storage/src/studio-store.js';
import {validateCommandArgs} from '../../../packages/core/src/studio-policy.js';
import {createStudioTestControl,NativeTestAdapter,TestLedger,digest,StudioTestError,type ConsentDisplay,type TestBinding,type TestReview,type Scheduler} from '../../../packages/studio-test-controller/src/index.js';
import {decodeTestInventory,decodeTestState,decodeTestMode,decodeTestLogs,decodeTestFocus} from './studio-test-decoders.js';
import {scenarioPlanSchema,SCENARIO_LIMITS} from '../../../packages/studio-test-controller/src/scenario.js';
import {createStudioTestCaptureStore} from './studio-test-captures.js';
import {scenarioSubjectDigest,scenarioSubjectProgram} from './studio-test-subjects.js';
import {captureEditViewport,viewportRequestSchema,VIEWPORT_LIMITS} from '../../../packages/studio-test-controller/src/viewport.js';
import {createNativeAssetRequests} from './studio-native-assets.js';
import type {StudioTestTaskPort,StudioTestTaskOrigin,StudioTestTaskSettled} from '../../../packages/protocol/src/chat-task-playtest.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hash=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.strictObject({sessionId:id,nativeStudioId:id.optional(),durationMs:z.number().int().min(5000).max(60000).default(15000),observationIntervalMs:z.number().int().min(250).max(2000).default(1000),failOnRuntimeError:z.boolean().default(true),scenario:scenarioPlanSchema.optional()});
const approval=z.strictObject({id,displayDigest:hash});
const witnessSchema=z.strictObject({placeId:z.number().int().nonnegative(),universeId:z.number().int().nonnegative(),placeName:z.string().max(512),sessionId:id,clientLifetimeId:id,pluginArtifactHash:hash});
type Witness=z.infer<typeof witnessSchema>;
export interface NativeTestConnection {client:Client;evidence:'native'|'fixture';witness(studioId:string,markerName:string,mode:'Edit'|'Play',signal:AbortSignal):Promise<Witness>;close():Promise<void>}
interface Options {directory:string;store:StudioStore;pluginArtifactHash:string;connect?:()=>Promise<NativeTestConnection>;taskPort?:StudioTestTaskPort;
  /** Trusted fixture clock only; never request data and never accepted for a native connection. */
  fixtureScheduler?:Scheduler}
export interface StudioTestView {id:string;targetName:string;actor:string;state:'needs_approval'|'running'|'complete'|'cancelled';display:Readonly<ConsentDisplay>;displayDigest:string;review:Readonly<TestReview>;evidence:'fixture'|'native';nativeAcceptance:false}
type Job={view:StudioTestView;control:ReturnType<typeof createStudioTestControl>;connection:NativeTestConnection;proposalId:string;expiry:ReturnType<typeof setTimeout>;closing:Promise<void>|null;cancelled:boolean;reserved:boolean;reservation:StudioTestReservation|null;verifySubjects:((signal:AbortSignal)=>Promise<void>)|null;
  origin:StudioTestTaskOrigin|null;terminalSent:boolean;reportDigest:string|null;subjects:'current'|'changed'|'unobserved';revalidate:((signal:AbortSignal)=>Promise<'current'|'changed'|'unobserved'>)|null};
/** At most 30 viewport captures per rolling ten minutes; one at a time. */
export const VIEWPORT_RATE=Object.freeze({captures:30,deadlineMs:20_000});
function rejected(code:'INVALID_REQUEST'|'BINDING_CHANGED'|'BUSY'|'PLACE_DENIED'|'STALE_PROOF'|'HUMAN_AUTH_REQUIRED'|'FENCED'|'BAD_NATIVE_RESPONSE'):never{throw new StudioTestError(code);}

/** Dedicated vetted SDK client. The only additional execution is this fixed
 * read-only metadata witness; no caller Luau, paths, flags or URLs are accepted. */
async function connectNativeTest(maxBufferSize:number=SCENARIO_LIMITS.wireBytes):Promise<NativeTestConnection>{
  const executable=await discoverNativeStudioExecutable();
  const transport=new StdioClientTransport({command:executable.path,args:[],cwd:dirname(executable.path),stderr:'ignore',maxBufferSize});
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
  if(options.fixtureScheduler&&!options.connect)rejected('INVALID_REQUEST');
  await mkdir(options.directory,{recursive:true,mode:0o700});const root=await realpath(options.directory);
  const ledger=await TestLedger.open(join(root,'ledger'),root);
  const captures=await createStudioTestCaptureStore(root).catch(async error=>{
    // Construction has not admitted a run. Close only the ledger we acquired;
    // retained capture evidence and any failed-close fence remain untouched.
    try{await ledger.close();}catch{/* Preserve the original capture failure. */}
    throw error;
  });
  let current:Job|null=null, preparing=false,closed=false,viewing=false;const viewportTimes:number[]=[];
  const jobs=new Map<string,Job>();const humanContexts=new WeakSet<object>();
  const identity=(s:ReturnType<StudioStore['session']>)=>digest({sessionId:s.id,clientLifetimeId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,name:s.name,roots:s.allowedRoots,writes:s.allowWrites,revoked:s.revokedAt});
  const eligible=(sessionId:string)=>{const s=options.store.session(sessionId);if(s.placeId!==0||s.universeId!==0||!s.allowWrites)rejected('PLACE_DENIED');return s;};
  const view=(j:Job)=>structuredClone({...j.view,review:j.control.requests.status()});
  const owned=(jobId:string,actor:string)=>{const j=jobs.get(jobId);if(!j||!(actor==='human'||j.view.actor===actor))rejected('HUMAN_AUTH_REQUIRED');return j;};
  const closeJob=(j:Job):Promise<void>=>{
    if(j.closing)return j.closing;clearTimeout(j.expiry);
    j.closing=(async()=>{try{await j.control.lifecycle.shutdown();}finally{try{const review=j.control.requests.status();if(j.reserved&&review.cleanup==='complete'){if(j.reservation)options.store.releaseTestReservation(j.reservation);else options.store.releaseTest(j.view.display.proposal.binding.pairedSessionId,j.view.id);j.reserved=false;}}finally{await j.connection.close();}}
      if(j.origin&&options.taskPort&&!j.terminalSent){
        const report=view(j),review=report.review,scenario=review.scenario,plan=report.display.proposal.scenario;
        const packet:StudioTestTaskSettled={jobId:report.id,displayDigest:report.displayDigest,scenarioDigest:scenario?.scenarioDigest??null,subjectDigest:scenario?.subjectDigest??null,reportDigest:digest(report),review,
          scenario:scenario&&plan?{outcome:scenario.state==='passed'&&review.outcome==='succeeded'?'passed':scenario.state==='failed'&&review.code==='ASSERTION_FAILED'?'failed':'incomplete',
            requiredEvidence:!plan.capture.required&&scenario.steps.length===plan.steps.length&&scenario.steps.some(step=>step.outcome!=='not_run')?'complete':'missing',
            inputRelease:scenario.inputRelease==='unknown'?'unknown':'complete',restoration:!plan.temporaryEdits?.length?'not_required':scenario.temporary==='restored'?'complete':'unknown',subjects:j.subjects}:null};
        j.terminalSent=true;j.reportDigest=packet.reportDigest;await options.taskPort.terminal(j.origin,packet);
      }
    })();return j.closing;
  };
  const prepare=async(input:unknown,actor:string):Promise<StudioTestView>=>{
    if(closed||preparing||viewing||nativeAssets.active()||current&&(current.reserved||current.view.state==='needs_approval'||current.view.state==='running')||ledger.unresolved())rejected('BUSY');
    if(!id.safeParse(actor).success)rejected('HUMAN_AUTH_REQUIRED');
    const origin=options.taskPort?.capture(actor)??null;if(origin)options.taskPort!.assert(origin);
    const a=request.parse(input),session=eligible(a.sessionId),p=session.proof;
    for(const edit of a.scenario?.temporaryEdits??[])validateCommandArgs('scene.update',{ref:edit.ref,expected:edit.expected,properties:edit.properties},session);
    if(!p||!p.connected||!p.continuitySupported||p.pluginArtifactHash!==options.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    preparing=true;let connection:NativeTestConnection|undefined;
    try{
      connection=await(options.connect??connectNativeTest)();
      if(options.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');
      const result=await connection.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{timeout:5000,maxTotalTimeout:5000});
      const inventory=decodeTestInventory(result) as {id:string;name:string}[];
      const candidates=a.nativeStudioId?inventory.filter(s=>s.id===a.nativeStudioId):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const binding:TestBinding={nativeStudioId:candidates[0]!.id,pairedSessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:p.pluginArtifactHash,scopeRevision:identity(session),placeId:0};
      const native=connection;let lastWitness:Witness|null=null;
      const createProofReader=(readerNative:NativeTestConnection)=>({async read(wanted:TestBinding,signal:AbortSignal){
        const deadline=Date.now()+5000;
        let s=options.store.session(wanted.pairedSessionId,false),proof=s.proof;
        // Wait for the actual authenticated plugin heartbeat after a native mode
        // transition. Never manufacture an epoch from sampled state booleans.
        const stateResult=await readerNative.client.callTool({name:'get_studio_state',arguments:{studio_id:wanted.nativeStudioId}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000});
        const state=decodeTestMode(stateResult);
        while(proof&&proof.mode!==state.mode&&Date.now()<deadline&&!signal.aborted){await new Promise(r=>setTimeout(r,50));s=options.store.session(wanted.pairedSessionId,false);proof=s.proof;}
        if(signal.aborted||!proof||proof.mode!==state.mode||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==wanted.clientLifetimeId||proof.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('STALE_PROOF');
        const before=digest(proof);const witness=await readerNative.witness(wanted.nativeStudioId,proof.markerName,proof.mode,signal);
        if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('BINDING_CHANGED');
        const after=options.store.session(s.id,false),fresh=after.proof;
        if(!fresh||digest({...fresh,observedAt:proof.observedAt,expiresAt:proof.expiresAt})!==before)rejected('BINDING_CHANGED');
        lastWitness=witness;
        return {binding:{...wanted,scopeRevision:identity(after)},observedAt:Date.parse(fresh.observedAt),expiresAt:Date.parse(fresh.expiresAt),connected:fresh.connected,revoked:!!after.revokedAt,protectedPlace:after.placeId!==0||after.universeId!==0,testActionsAllowed:after.allowWrites,playEpoch:fresh.playEpoch,continuitySupported:fresh.continuitySupported};
      }});const proofReader=createProofReader(native);
      let control:ReturnType<typeof createStudioTestControl>;
      const receiptPins=options.store.commands(session.id).filter(command=>command.state==='succeeded'&&['script.update','script.set_enabled'].includes(command.method)).map(command=>command.id);
      const appliedReceipts=()=>receiptPins.map(id=>options.store.command(id)).map(command=>({id:command.id,method:command.method,result:command.result}));
      const readSubjects=async(wanted:TestBinding,signal:AbortSignal,readerNative=native,readerProof=proofReader)=>{
        await readerProof.read(wanted,signal);
        const before=eligible(session.id),proof=before.proof,receipts=appliedReceipts();
        if(!proof||proof.mode!=='Edit'||identity(before)!==wanted.scopeRevision||proof.markerName!==p.markerName)rejected('BINDING_CHANGED');
        const result=CallToolResultSchema.parse(await readerNative.client.callTool({name:'execute_luau',arguments:{studio_id:wanted.nativeStudioId,datamodel_type:'Edit',code:scenarioSubjectProgram(proof.markerName,before.allowedRoots)}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000,resetTimeoutOnProgress:false}));
        await readerProof.read(wanted,signal);
        const after=eligible(session.id),fresh=after.proof;
        if(!fresh||fresh.mode!=='Edit'||fresh.playEpoch!==proof.playEpoch||identity(after)!==wanted.scopeRevision||digest(receipts)!==digest(appliedReceipts()))rejected('BINDING_CHANGED');
        try{return scenarioSubjectDigest(result,{sessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:options.pluginArtifactHash,allowedRoots:before.allowedRoots},receipts);}catch{rejected('BAD_NATIVE_RESPONSE');}
      };
      const adapter=new NativeTestAdapter({client:native.client,evidence:native.evidence,pairedProof:proofReader,requestTimeoutMs:5000,proofMaxAgeMs:6000,captureStore:captures,subjectReader:{read:readSubjects},admissionGuard:()=>{if(origin)options.taskPort!.assert(origin);},onDisconnect:()=>control?.lifecycle.onDisconnect(),decoder:{inventory:decodeTestInventory,state:(r,studioId)=>{if(!lastWitness||lastWitness.placeId!==0)rejected('BAD_NATIVE_RESPONSE');return decodeTestState(r,{nativeStudioId:studioId,placeId:lastWitness.placeId});},logs:decodeTestLogs,focus:decodeTestFocus}});
      let subjectDigest:string|undefined;
      if(a.scenario){await adapter.prepareScenario(a.scenario,new AbortController().signal);subjectDigest=await adapter.readScenarioSubjects(binding,new AbortController().signal);}
      let j:Job;
      const setupCommands:string[]=[];
      const waitCommand=async(commandId:string,signal:AbortSignal)=>{
        while(!signal.aborted){const command=options.store.command(commandId);if(command.state==='succeeded')return command;if(['failed','cancelled','needs_reconciliation'].includes(command.state))throw new StudioTestError('EFFECT_UNKNOWN');await new Promise(resolve=>setTimeout(resolve,25));}
        throw new StudioTestError('CANCELLED');
      };
      const verifySubjects=async(signal:AbortSignal)=>{const final=control.requests.status().phase==='stopping';if(final)j.subjects='unobserved';if(subjectDigest!==await adapter.readScenarioSubjects(binding,signal)){if(final)j.subjects='changed';rejected('BINDING_CHANGED');}if(final)j.subjects='current';};
      control=createStudioTestControl({adapter,ledger,requestTimeoutMs:15000,cleanupGraceMs:15000,proofMaxAgeMs:6000,
        ...(options.fixtureScheduler?{scheduler:options.fixtureScheduler}:{}),
        ...(a.scenario?{temporary:{
          async setup(signal:AbortSignal){try{for(const edit of a.scenario!.temporaryEdits??[]){signal.throwIfAborted();if(j.origin)options.taskPort!.assert(j.origin);if(!j.reservation)rejected('FENCED');const command=options.store.enqueueTestSetup(j.reservation,edit.id);setupCommands.push(command.id);await waitCommand(command.id,signal);}}catch(error){if(j.reservation)options.store.cancelTestSetup(j.reservation);throw error;}},
          async restore(signal:AbortSignal){if(!j.reservation)rejected('FENCED');options.store.cancelTestSetup(j.reservation);let unknown=false;for(const commandId of [...setupCommands].reverse()){try{let original=options.store.command(commandId);if(original.state==='cancelled')continue;if(original.state==='dispatched')original=await waitCommand(commandId,signal);if(original.state!=='succeeded'){unknown=true;continue;}const restore=options.store.enqueueTestRestore(j.reservation,commandId);await waitCommand(restore.id,signal);}catch{unknown=true;}}if(unknown)throw new StudioTestError('EFFECT_UNKNOWN');},
          verifySubjects,
          release(){if(!j.reservation)rejected('FENCED');options.store.releaseTestReservation(j.reservation);j.reserved=false;},
        }}:{}),humanVerifier:{async confirm(context,display,displayDigest,signal){return typeof context==='object'&&context!==null&&humanContexts.has(context)&&digest(display)===displayDigest&&!signal.aborted;}},onStatus(status){if(current?.control===control&&status.phase==='done')current.view.state=current.cancelled?'cancelled':'complete';}});
      const prepared=await control.requests.prepare({binding,durationMs:a.durationMs,observationIntervalMs:a.observationIntervalMs,failOnRuntimeError:a.failOnRuntimeError,...(a.scenario?{scenario:a.scenario,subjectDigest}:{})});
      const jobId=randomUUID();
      j={view:{id:jobId,targetName:session.name,actor,state:'needs_approval',display:prepared.display,displayDigest:prepared.displayDigest,review:control.requests.status(),evidence:native.evidence,nativeAcceptance:false},control,connection:native,proposalId:prepared.proposalId,expiry:setTimeout(()=>{if(j.view.state==='needs_approval'){j.cancelled=true;j.view.state='cancelled';void closeJob(j).catch(()=>{});}},60000),closing:null,cancelled:false,reserved:false,reservation:null,verifySubjects:a.scenario?verifySubjects:null,
        origin,terminalSent:false,reportDigest:null,subjects:'unobserved',revalidate:a.scenario?async(signal)=>{
          let fresh:NativeTestConnection|undefined;
          try{fresh=await(options.connect??connectNativeTest)();if(fresh.evidence!==native.evidence)return 'unobserved';
            const reader=fresh,proof=createProofReader(reader),check=new NativeTestAdapter({client:reader.client,evidence:reader.evidence,pairedProof:proof,requestTimeoutMs:5000,proofMaxAgeMs:6000,captureStore:captures,
              subjectReader:{read:(wanted,local)=>readSubjects(wanted,local,reader,proof)},decoder:{inventory:decodeTestInventory,state:(r,studioId)=>decodeTestState(r,{nativeStudioId:studioId,placeId:0}),logs:decodeTestLogs,focus:decodeTestFocus}});
            await check.prepareScenario(a.scenario!,signal);return subjectDigest===await check.readScenarioSubjects(binding,signal)?'current':'changed';
          }catch{return 'unobserved';}finally{await fresh?.close();}
        }:null};
      // Internal preparation identity is deliberately not request-controlled.
      current=j;jobs.set(jobId,j);if(jobs.size>64)jobs.delete(jobs.keys().next().value!);connection=undefined;
      if(origin){try{options.taskPort!.assert(origin);options.taskPort!.prepared(origin,{jobId,displayDigest:j.view.displayDigest,scenarioDigest:j.view.review.scenario?.scenarioDigest??null,subjectDigest:subjectDigest??null});}catch(error){j.cancelled=true;j.view.state='cancelled';await closeJob(j);throw error;}}
      return view(j);
    }finally{preparing=false;if(connection)await connection.close();}
  };
  /** Read-only Edit viewport image for the exact paired, unpublished, Edit-mode
   * session through the built-in Studio MCP screen_capture tool. Never starts
   * Play, sends input, reserves the place, or accepts caller Luau. */
  const viewport=async(input:unknown,actor:string)=>{
    if(!id.safeParse(actor).success)rejected('HUMAN_AUTH_REQUIRED');
    const now=Date.now();while(viewportTimes.length&&now-viewportTimes[0]!>600_000)viewportTimes.shift();
    if(closed||preparing||viewing||nativeAssets.active()||current?.view.state==='running'||current?.reserved||viewportTimes.length>=VIEWPORT_RATE.captures)rejected('BUSY');
    const a=viewportRequestSchema.parse(input),session=eligible(a.sessionId),p=session.proof;
    if(!p||!p.connected||p.pluginArtifactHash!==options.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    if(p.mode!=='Edit')throw new StudioTestError('MODE_MISMATCH');
    viewing=true;viewportTimes.push(now);let connection:NativeTestConnection|undefined;
    try{
      connection=await(options.connect??(()=>connectNativeTest(VIEWPORT_LIMITS.wireBytes)))();
      if(options.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');
      const native=connection;
      const inventory=decodeTestInventory(await native.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{timeout:5000,maxTotalTimeout:5000})) as {id:string;name:string}[];
      const candidates=a.nativeStudioId?inventory.filter(s=>s.id===a.nativeStudioId):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const nativeStudioId=candidates[0]!.id,scope=identity(session);
      const verifyBinding=async(signal:AbortSignal)=>{
        const s=eligible(session.id),proof=s.proof;
        if(!proof||!proof.connected||proof.mode!=='Edit'||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==p.clientLifetimeId||proof.pluginArtifactHash!==options.pluginArtifactHash||proof.markerName!==p.markerName||identity(s)!==scope)rejected('BINDING_CHANGED');
        const witness=await native.witness(nativeStudioId,proof.markerName,'Edit',signal);
        if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==options.pluginArtifactHash)rejected('BINDING_CHANGED');
        return digest({scope,nativeStudioId,clientLifetimeId:proof.clientLifetimeId,playEpoch:proof.playEpoch,markerName:proof.markerName});
      };
      const image=await captureEditViewport({client:native.client,nativeStudioId,captureId:'ArcaneViewport_'+randomUUID().replaceAll('-',''),maxDimension:a.maxDimension,
        ...(a.camera?{camera:a.camera}:{}),...(a.sheet?{sheet:a.sheet}:{}),verifyBinding,decodeMode:decodeTestMode,...(options.fixtureScheduler?{scheduler:options.fixtureScheduler}:{})},AbortSignal.timeout(VIEWPORT_RATE.deadlineMs));
      return {viewport:{sessionId:session.id,nativeStudioId,mode:'Edit' as const,mimeType:'image/png' as const,width:image.width,height:image.height,
        originalWidth:image.originalWidth,originalHeight:image.originalHeight,downscaled:image.downscaled,bytes:image.bytes,sha256:image.sha256,camera:image.camera,evidence:native.evidence},
        data:image.png.toString('base64')};
    }finally{viewing=false;if(connection)await connection.close().catch(()=>{});}
  };
  /** Native asset search/insert/generation: same exact-session Edit binding as the viewport. */
  const nativeAssets=createNativeAssetRequests({store:options.store,pluginArtifactHash:options.pluginArtifactHash,connect:options.connect??(()=>connectNativeTest()),
    ...(options.fixtureScheduler?{fixtureScheduler:options.fixtureScheduler}:{}),eligible,identity,busy:()=>closed||preparing||viewing||current?.view.state==='running'||!!current?.reserved});
  return Object.freeze({
    async cancelExact(jobId:string,origin:StudioTestTaskOrigin){const j=jobs.get(jobId);if(!j||j.origin!==origin)rejected('HUMAN_AUTH_REQUIRED');j.cancelled=true;if(j.view.state==='needs_approval')j.view.state='cancelled';const review=j.control.requests.status();if(review.runId&&review.phase!=='done')await j.control.requests.stop({runId:review.runId});await closeJob(j);const final=j.control.requests.status();if(j.reserved||final.runId!==null&&final.cleanup!=='complete'||final.scenario?.inputRelease==='unknown')rejected('FENCED');},
    async revalidateExact(jobId:string,origin:StudioTestTaskOrigin,reportDigest:string):Promise<'current'|'changed'|'unobserved'>{const j=jobs.get(jobId);if(!j||j.origin!==origin||j.reportDigest!==reportDigest||!j.revalidate)rejected('HUMAN_AUTH_REQUIRED');if(j.reserved||j.control.requests.status().cleanup!=='complete')return 'unobserved';return j.revalidate(AbortSignal.timeout(15000));},
    requests:Object.freeze({
      prepare,status:(jobId:string,actor:string)=>view(owned(jobId,actor)),
      list:(actor:string)=>[...jobs.values()].filter(j=>actor==='human'||j.view.actor===actor).map(view),
      viewport,
      nativeAssets:Object.freeze({search:nativeAssets.search,insert:nativeAssets.insert,generate:nativeAssets.generate,job:nativeAssets.job}),
      async capture(jobId:string,actor:string){const j=owned(jobId,actor),image=j.control.requests.status().scenario?.capture;if(!image)rejected('INVALID_REQUEST');return {image,bytes:await captures.read(image)};},
      async cancel(jobId:string,actor:string){
        const j=owned(jobId,actor);j.cancelled=true;
        if(j.view.state==='needs_approval')j.view.state='cancelled';
        const runId=j.control.requests.status().runId;
        if(runId&&j.control.requests.status().phase!=='done')await j.control.requests.stop({runId});
        await closeJob(j);return view(j);
      },
    }),
    humanControl:Object.freeze({toolboxPolicy:nativeAssets.toolboxPolicy,async approve(input:unknown,guard:()=>void){
      guard();const a=approval.parse(input),j=owned(a.id,'human');
      if(closed||j!==current||j.cancelled||j.view.state!=='needs_approval'||a.displayDigest!==j.view.displayDigest)rejected('HUMAN_AUTH_REQUIRED');
      if(j.origin)options.taskPort!.assert(j.origin);
      const session=eligible(j.view.display.proposal.binding.pairedSessionId);
      if(identity(session)!==j.view.display.proposal.binding.scopeRevision)rejected('BINDING_CHANGED');
      if(!session.proof?.connected||Date.parse(session.proof.expiresAt)<=Date.now())rejected('STALE_PROOF');
      const context=Object.freeze({});humanContexts.add(context);
      try{
        if(j.verifySubjects){await j.verifySubjects(new AbortController().signal);guard();if(j.cancelled)rejected('HUMAN_AUTH_REQUIRED');}
        const consentId=await j.control.humanControl.confirm(j.proposalId,context);guard();
        if(j.verifySubjects){await j.verifySubjects(new AbortController().signal);guard();}
        if(j.origin)options.taskPort!.assert(j.origin);
        if(j.cancelled)rejected('HUMAN_AUTH_REQUIRED');
        j.reservation=options.store.reserveTest(j.view.display.proposal.binding.pairedSessionId,j.view.id,j.view.display.proposal.scenario?.temporaryEdits);j.reserved=true;clearTimeout(j.expiry);
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
type CreatedStudioTestService=Awaited<ReturnType<typeof createStudioTestService>>;
/** Capture is an optional extension for older trusted host/test integrations. */
export type StudioTestService=Omit<CreatedStudioTestService,'requests'|'humanControl'|'cancelExact'|'revalidateExact'>&Partial<Pick<CreatedStudioTestService,'cancelExact'|'revalidateExact'>>&{humanControl:Omit<CreatedStudioTestService['humanControl'],'toolboxPolicy'>&Partial<Pick<CreatedStudioTestService['humanControl'],'toolboxPolicy'>>;requests:Omit<CreatedStudioTestService['requests'],'capture'|'viewport'|'nativeAssets'>&Partial<Pick<CreatedStudioTestService['requests'],'capture'|'viewport'|'nativeAssets'>>};
