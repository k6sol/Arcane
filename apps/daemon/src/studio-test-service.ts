import {randomUUID} from 'node:crypto';
import {mkdir,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {discoverNativeStudioExecutable} from '../../../packages/studio-adapter/src/discovery.js';
import {StudioStore,type StudioTestReservation,type StudioNativeCustodyPort,type StudioNativeCustodyOperation} from '../../../packages/storage/src/studio-store.js';
import {validateCommandArgs} from '../../../packages/core/src/studio-policy.js';
import {createStudioTestControl,NativeTestAdapter,TestLedger,digest,StudioTestError,type ConsentDisplay,type TestBinding,type TestReview,type Scheduler} from '../../../packages/studio-test-controller/src/index.js';
import {decodeTestInventory,decodeTestState,decodeTestMode,decodeTestLogs,decodeTestFocus} from './studio-test-decoders.js';
import {scenarioPlanSchema,SCENARIO_LIMITS} from '../../../packages/studio-test-controller/src/scenario.js';
import {createStudioTestCaptureStore} from './studio-test-captures.js';
import {scenarioSubjectDigest,scenarioSubjectProgram} from './studio-test-subjects.js';
import {captureEditViewport,viewportRequestSchema,VIEWPORT_LIMITS} from '../../../packages/studio-test-controller/src/viewport.js';
import {createNativeAssetRequests} from './studio-native-assets.js';
import type {StudioTestTaskPort,StudioTestTaskOrigin,StudioTestTaskSettled,StudioTestTaskWork,StudioTestTaskWorkRegistration} from '../../../packages/protocol/src/chat-task-playtest.js';
import {createStudioTestOwnedClose} from './studio-test-owned-close.js';
import {createStudioTestNativeCustody,closeAfterStudioTestNativeConnectFailure,type StudioTestNativeConnectAttempt} from './studio-test-native-custody.js';
import {createStudioTestHistoricalReport,StudioTestReportError,STUDIO_TEST_REPORT_ARCHIVE_CODES,type StudioTestReportWriter,type StudioTestReportArchiveStatus} from './studio-test-report-store.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hash=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.strictObject({sessionId:id,nativeStudioId:id.optional(),durationMs:z.number().int().min(5000).max(60000).default(15000),observationIntervalMs:z.number().int().min(250).max(2000).default(1000),failOnRuntimeError:z.boolean().default(true),scenario:scenarioPlanSchema.optional()});
const approval=z.strictObject({id,displayDigest:hash});
const witnessSchema=z.strictObject({placeId:z.number().int().nonnegative(),universeId:z.number().int().nonnegative(),placeName:z.string().max(512),sessionId:id,clientLifetimeId:id,pluginArtifactHash:hash});
type Witness=z.infer<typeof witnessSchema>;
export interface NativeTestConnection {client:Client;evidence:'native'|'fixture';witness(studioId:string,markerName:string,mode:'Edit'|'Play',signal:AbortSignal):Promise<Witness>;close():Promise<void>}
interface Options {directory:string;store:StudioStore;pluginArtifactHash:string;connect?:()=>Promise<NativeTestConnection>;taskPort?:StudioTestTaskPort;
  revokeModelSource?:(sessionId:string)=>void;
  /** Original fixed-project StudioStore custody port. Absence never permits native dispatch. */
  custody?:StudioNativeCustodyPort;
  /** Actual original LAB project identity guard; never supplied by HTTP. */
  assertProject?:()=>void;
  /** Trusted host proof that this process is the only possible journal writer (the project workspace lock). Never HTTP input. */
  exclusiveWriter?:()=>boolean;
  /** Trusted fixture clock only; never request data and never accepted for a native connection. */
  fixtureScheduler?:Scheduler;
  /** Optional fixed-project historical writer; no live/native authority is recovered from its records. */
  reports?:StudioTestReportWriter}
export interface StudioTestView {id:string;targetName:string;actor:string;state:'needs_approval'|'running'|'complete'|'cancelled';display:Readonly<ConsentDisplay>;displayDigest:string;review:Readonly<TestReview>;evidence:'fixture'|'native';nativeAcceptance:false}
type Deferred<T>={promise:Promise<T>;resolve:(value:T)=>void;reject:(error:unknown)=>void};
function deferred<T>():Deferred<T>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject};}
/** Keep original SDK ownership/this binding. Only new reader dispatches use this private view;
 * original raw close and controller compensation retain their original client. */
function taskReadClient(client:Client,admit:()=>void):Client{return new Proxy(client,{get(target,key){
  const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(key==='callTool'||key==='listTools')return(...args:unknown[])=>{admit();return Reflect.apply(value,target,args);};
  return value.bind(target);
}});}
interface TaskLifetime {work:StudioTestTaskWork;completion:Promise<void>;succeeded:boolean;observeCustody:(join:Promise<void>)=>void;allocationFailed:(error:unknown,classification:'not-admitted'|'ownership-uncertain'|null)=>void;observeJobClose:(join:Promise<void>)=>void;requestExited:()=>void;notAllocated:()=>void}
function registerTaskLifetime(port:StudioTestTaskPort,origin:StudioTestTaskOrigin,kind:Readonly<{kind:'prepare'}|{kind:'revalidate';jobId:string;reportDigest:string}>,cancel:()=>Promise<void>):TaskLifetime{
  const completion=deferred<void>();let requestDone=false,custodySeen=false,resourceDone=false,jobDone=true,settled=false,resourceFailed=false,resourceFailure:unknown,jobFailed=false,jobFailure:unknown;
  const finish=()=>{if(settled||!requestDone||!resourceDone||!jobDone)return;settled=true;if(jobFailed)completion.reject(jobFailure);else if(resourceFailed)completion.reject(resourceFailure);else completion.resolve();};
  const keepResource=(error:unknown)=>{if(!resourceFailed){resourceFailed=true;resourceFailure=error;}};
  const registration:StudioTestTaskWorkRegistration=Object.freeze({...kind,completion:completion.promise,cancel});
  const work=port.registerWork(origin,registration);
  return {work,completion:completion.promise,succeeded:false,observeCustody(join){if(custodySeen)throw Error('Original custody join was already registered.');custodySeen=true;void join.then(()=>{resourceDone=true;finish();},error=>{keepResource(error);resourceDone=true;finish();});},
    allocationFailed(error,classification){if(custodySeen)return;resourceDone=true;if(classification!=='not-admitted')keepResource(error);finish();},
    observeJobClose(join){jobDone=false;void join.then(()=>{jobDone=true;finish();},error=>{jobFailed=true;jobFailure=error;jobDone=true;finish();});},
    requestExited(){requestDone=true;finish();},notAllocated(){if(!custodySeen){resourceDone=true;finish();}}};
}

type Job={view:StudioTestView;control:ReturnType<typeof createStudioTestControl>;connection:NativeTestConnection;proposalId:string;expiry:ReturnType<typeof setTimeout>;closing:Promise<void>|null;cancelled:boolean;reserved:boolean;reservation:StudioTestReservation|null;verifySubjects:((signal:AbortSignal)=>Promise<void>)|null;
  origin:StudioTestTaskOrigin|null;taskLifetime:TaskLifetime|null;taskBound:boolean;closeJoin:Deferred<void>;terminalSent:boolean;reportDigest:string|null;historyCreatedAt:string;subjects:'current'|'changed'|'unobserved';revalidate:((signal:AbortSignal)=>Promise<'current'|'changed'|'unobserved'>)|null};
/** At most 30 viewport captures per rolling ten minutes; one at a time. */
export const VIEWPORT_RATE=Object.freeze({captures:30,deadlineMs:20_000});
function rejected(code:'INVALID_REQUEST'|'BINDING_CHANGED'|'BUSY'|'PLACE_DENIED'|'STALE_PROOF'|'HUMAN_AUTH_REQUIRED'|'FENCED'|'BAD_NATIVE_RESPONSE'):never{throw new StudioTestError(code);}

/** Dedicated vetted SDK client. The only additional execution is this fixed
 * read-only metadata witness; no caller Luau, paths, flags or URLs are accepted. */
async function connectNativeTest(attempt:StudioTestNativeConnectAttempt,maxBufferSize:number=SCENARIO_LIMITS.wireBytes):Promise<NativeTestConnection>{
  let launched=false,ownedClose:ReturnType<typeof createStudioTestOwnedClose>|undefined;
  try{
  const executable=await discoverNativeStudioExecutable();
  attempt.assertCurrent();
  const transport=new StdioClientTransport({command:executable.path,args:[],cwd:dirname(executable.path),stderr:'ignore',maxBufferSize});
  const client=new Client({name:'arcane-owned-playtest',version:'0.1.0'},{capabilities:{}});
  const close=createStudioTestOwnedClose(client,transport);ownedClose=close;
  attempt.observePhysicalClose(close.physicalClosed);
  attempt.launchAttempted();launched=true;
    await client.connect(transport,{timeout:10000,maxTotalTimeout:10000});
    attempt.assertCurrent();
    if(client.getServerVersion()?.name!=='RobloxStudio')rejected('BAD_NATIVE_RESPONSE');
    // Query the real advertised witness schema before ever using privileged code.
    const inventory=await client.listTools({}, {timeout:5000,maxTotalTimeout:5000});
    attempt.assertCurrent();
    const tool=inventory.tools.find(t=>t.name==='execute_luau');
    if(inventory.nextCursor||inventory.tools.length>128||!tool||tool.inputSchema.type!=='object'||!['code','studio_id','datamodel_type'].every(k=>tool.inputSchema.required?.includes(k)))rejected('BAD_NATIVE_RESPONSE');
    return {client,evidence:'native',async witness(studioId,markerName,mode,signal){
      if(!id.safeParse(studioId).success||!/^ArcaneTestProof_[A-Za-z0-9_-]{1,128}$/.test(markerName))rejected('INVALID_REQUEST');
      const q=JSON.stringify(markerName);
      const code=`local f=game:GetService("ServerStorage"):FindFirstChild(${q}); assert(f and f:IsA("Folder"),"Arcane mapping witness unavailable"); return {placeId=game.PlaceId,universeId=game.GameId,placeName=game.Name,sessionId=f:GetAttribute("SessionId"),clientLifetimeId=f:GetAttribute("ClientLifetimeId"),pluginArtifactHash=f:GetAttribute("PluginArtifactHash")}`;
      const result=CallToolResultSchema.parse(await client.callTool({name:'execute_luau',arguments:{studio_id:studioId,datamodel_type:mode==='Edit'?'Edit':'Server',code}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000,resetTimeoutOnProgress:false}));
      if(result.isError||result.content.length!==1||result.content[0]?.type!=='text'||Buffer.byteLength(result.content[0].text)>4096)rejected('BAD_NATIVE_RESPONSE');
      try{return witnessSchema.parse(JSON.parse(result.content[0].text));}catch{rejected('BAD_NATIVE_RESPONSE');}
    },close:()=>close.close()};
  }catch(error){
    if(!launched){attempt.noStart();throw error;}
    if(ownedClose)return closeAfterStudioTestNativeConnectFailure(attempt,ownedClose,error);
    throw error;
  }
}

/** Real product lifecycle, not a fixture-only controller. Human approval is a
 * separate port; neither pairing writes nor model JSON can create that consent.
 * Current native safety admission remains unpublished local places only. */
export async function createStudioTestService(options:Options){
  if(!hash.safeParse(options.pluginArtifactHash).success)rejected('INVALID_REQUEST');
  if(options.fixtureScheduler&&!options.connect)rejected('INVALID_REQUEST');
  const custody=createStudioTestNativeCustody(options.custody,options.assertProject);
  const connectOwned=(operation:StudioNativeCustodyOperation,maximum:number=SCENARIO_LIMITS.wireBytes,observeWorkJoin?:((join:Promise<void>)=>void))=>custody.connect(operation,options.connect?'fixture':'native',
    attempt=>options.connect?options.connect():connectNativeTest(attempt,maximum),
    connection=>{if(options.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');},observeWorkJoin);
  await mkdir(options.directory,{recursive:true,mode:0o700});const root=await realpath(options.directory);
  const ledger=await TestLedger.open(join(root,'ledger'),root,options.exclusiveWriter?{exclusiveWriter:options.exclusiveWriter}:{});
  const captures=await createStudioTestCaptureStore(root).catch(async error=>{
    // Construction has not admitted a run. Close only the ledger we acquired;
    // retained capture evidence and any failed-close fence remain untouched.
    try{await ledger.close();}catch{/* Preserve the original capture failure. */}
    throw error;
  });
  let current:Job|null=null, preparing=false,closed=false,viewing=false;const viewportTimes:number[]=[];
  const taskWorks=new Set<TaskLifetime>(),taskJobs=new Map<string,Job>(),workJobs=new Map<TaskLifetime,Job>();
  const retainWork=(life:TaskLifetime)=>{taskWorks.add(life);const release=()=>{const job=workJobs.get(life);if(life.succeeded&&(!job||!job.taskBound||life.work.signal.aborted)){taskWorks.delete(life);workJobs.delete(life);life.work.signal.removeEventListener('abort',release);if(job)taskJobs.delete(job.view.id);}};void life.completion.then(()=>{life.succeeded=true;release();},()=>{});life.work.signal.addEventListener('abort',release,{once:true});};
  const jobs=new Map<string,Job>();const humanContexts=new WeakSet<object>();
  const identity=(s:ReturnType<StudioStore['session']>)=>digest({sessionId:s.id,clientLifetimeId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,name:s.name,roots:s.allowedRoots,writes:s.allowWrites,revoked:s.revokedAt});
  const eligible=(sessionId:string)=>{const s=options.store.session(sessionId);if(s.placeId!==0||s.universeId!==0||!s.allowWrites)rejected('PLACE_DENIED');return s;};
  const view=(j:Job)=>structuredClone({...j.view,review:j.control.requests.status()});
  let reportFault:StudioTestReportArchiveStatus=options.reports?Object.freeze({state:'ready',code:null}):Object.freeze({state:'unavailable',code:'ARCHIVE_UNAVAILABLE'});
  const archiveFailure=(code:unknown)=>{
    const fixed=STUDIO_TEST_REPORT_ARCHIVE_CODES.find(value=>value===code)??'ARCHIVE_WRITE';
    reportFault=Object.freeze({state:'degraded',code:fixed});
    try{options.reports?.noteFailure(fixed);}catch{/* A broken archive recorder cannot replace the original native/task error. */}
  };
  const archive=(j:Job,snapshot:'admission'|'terminal'):void=>{
    if(!options.reports)return;
    try{
      if(j.origin&&j.origin.projectId!==options.reports.projectId)throw new StudioTestReportError('ARCHIVE_INPUT');
      const report=view(j),historical=createStudioTestHistoricalReport({schemaVersion:1,kind:'studio-playtest-report',projectId:options.reports.projectId,
        jobId:report.id,taskId:j.origin?.taskId??null,createdAt:j.historyCreatedAt,observedAt:new Date().toISOString(),snapshot,targetName:report.targetName,
        observedState:report.state,display:report.display,displayDigest:report.displayDigest,review:report.review,evidence:report.evidence,nativeAcceptance:false});
      const result=snapshot==='admission'?options.reports.recordAdmission(historical,[...jobs.keys()]):options.reports.recordTerminal(historical);
      if(!result.stored)archiveFailure(result.code);
    }catch(error){archiveFailure(error instanceof StudioTestReportError&&error.code!=='CURSOR_INVALID'?error.code:'ARCHIVE_WRITE');}
  };
  const owned=(jobId:string,actor:string)=>{const j=jobs.get(jobId);if(!j||!(actor==='human'||j.view.actor===actor))rejected('HUMAN_AUTH_REQUIRED');return j;};
  const closeJob=(j:Job):Promise<void>=>{
    if(j.closing)return j.closing;
    const outcome=deferred<void>();j.closing=outcome.promise;
    void (async()=>{
      custody.beginClosing(j.connection);clearTimeout(j.expiry);
      let failed=false,failure:unknown;
      const keep=(error:unknown)=>{if(!failed){failed=true;failure=error;}};
      try{await j.control.lifecycle.shutdown();}catch(error){keep(error);}
      try{const review=j.control.requests.status();if(j.reserved&&review.cleanup==='complete'){if(j.reservation)options.store.releaseTestReservation(j.reservation);else options.store.releaseTest(j.view.display.proposal.binding.pairedSessionId,j.view.id);j.reserved=false;}}catch(error){keep(error);}
      try{await j.connection.close();}catch(error){keep(error);}finally{archive(j,'terminal');}
      if(failed)throw failure;
      if(j.origin&&j.taskBound&&j.taskLifetime&&options.taskPort&&!j.terminalSent){
        options.assertProject?.();
        const report=view(j),review=report.review,scenario=review.scenario,plan=report.display.proposal.scenario;
        const packet:StudioTestTaskSettled={jobId:report.id,displayDigest:report.displayDigest,scenarioDigest:scenario?.scenarioDigest??null,subjectDigest:scenario?.subjectDigest??null,reportDigest:digest(report),review,
          scenario:scenario&&plan?{outcome:scenario.state==='passed'&&review.outcome==='succeeded'?'passed':scenario.state==='failed'&&review.code==='ASSERTION_FAILED'?'failed':'incomplete',
            requiredEvidence:!plan.capture.required&&scenario.steps.length===plan.steps.length&&scenario.steps.some(step=>step.outcome!=='not_run')?'complete':'missing',
            inputRelease:scenario.inputRelease==='unknown'?'unknown':'complete',restoration:!plan.temporaryEdits?.length?'not_required':scenario.temporary==='restored'?'complete':'unknown',subjects:j.subjects}:null};
        j.terminalSent=true;j.reportDigest=packet.reportDigest;await options.taskPort.terminal(j.origin,packet,j.taskLifetime.work);
      }
    })().then(()=>{j.closeJoin.resolve();outcome.resolve();},error=>{j.closeJoin.reject(error);outcome.reject(error);});return j.closing;
  };
  const prepare=async(input:unknown,actor:string):Promise<StudioTestView>=>{
    custody.assertReady();
    if(closed||preparing||viewing||nativeAssets.active()||current&&(current.reserved||current.view.state==='needs_approval'||current.view.state==='running')||ledger.unresolved())rejected('BUSY');
    if(!id.safeParse(actor).success)rejected('HUMAN_AUTH_REQUIRED');
    const origin=options.taskPort?.capture(actor)??null;if(origin){options.taskPort!.assert(origin);if(origin.projectId!==options.custody?.projectId)rejected('BINDING_CHANGED');}
    const a=request.parse(input),session=eligible(a.sessionId),p=session.proof;
    for(const edit of a.scenario?.temporaryEdits??[])validateCommandArgs('scene.update',{ref:edit.ref,expected:edit.expected,properties:edit.properties},session);
    if(!p||!p.connected||!p.continuitySupported||p.pluginArtifactHash!==options.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    let connection:NativeTestConnection|undefined,failed=false,allocatedJob:Job|undefined,taskLifetime:TaskLifetime|null=null,allocationStarted=false;
    const requestExit=deferred<void>();
    const cancelPreparation=async()=>{if(allocatedJob){allocatedJob.cancelled=true;if(allocatedJob.view.state==='needs_approval')allocatedJob.view.state='cancelled';await closeJob(allocatedJob);}else if(connection)await connection.close();await requestExit.promise;if(taskLifetime)await taskLifetime.completion;};
    if(origin){taskLifetime=registerTaskLifetime(options.taskPort!,origin,{kind:'prepare'},cancelPreparation);retainWork(taskLifetime);}
    preparing=true;
    const assertPreparing=()=>{if(!allocatedJob){if(closed)rejected('FENCED');taskLifetime?.work.assertActive();}};
    try{
      taskLifetime?.work.assertActive();
      allocationStarted=true;try{connection=await connectOwned('playtest-prepare',SCENARIO_LIMITS.wireBytes,taskLifetime?.observeCustody);}catch(error){taskLifetime?.allocationFailed(error,custody.preEntryRefusal(error));throw error;}
      assertPreparing();
      custody.assertConnection(connection);
      if(options.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');
      assertPreparing();
      const result=await connection.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{timeout:5000,maxTotalTimeout:5000});
      custody.assertConnection(connection);
      assertPreparing();
      const inventory=decodeTestInventory(result) as {id:string;name:string}[];
      const candidates=a.nativeStudioId?inventory.filter(s=>s.id===a.nativeStudioId):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const binding:TestBinding={nativeStudioId:candidates[0]!.id,pairedSessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:p.pluginArtifactHash,scopeRevision:identity(session),placeId:0};
      const native=connection;let lastWitness:Witness|null=null;
      const createProofReader=(readerNative:NativeTestConnection,admit:()=>void=assertPreparing)=>({async read(wanted:TestBinding,signal:AbortSignal){
        admit();
        const deadline=Date.now()+5000;
        let s=options.store.session(wanted.pairedSessionId,false),proof=s.proof;
        // Wait for the actual authenticated plugin heartbeat after a native mode
        // transition. Never manufacture an epoch from sampled state booleans.
        const stateResult=await readerNative.client.callTool({name:'get_studio_state',arguments:{studio_id:wanted.nativeStudioId}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000});
        admit();const state=decodeTestMode(stateResult);
        while(proof&&proof.mode!==state.mode&&Date.now()<deadline&&!signal.aborted){await new Promise(r=>setTimeout(r,50));s=options.store.session(wanted.pairedSessionId,false);proof=s.proof;}
        if(signal.aborted||!proof||proof.mode!==state.mode||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==wanted.clientLifetimeId||proof.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('STALE_PROOF');
        const before=digest(proof);admit();const witness=await readerNative.witness(wanted.nativeStudioId,proof.markerName,proof.mode,signal);
        admit();if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==wanted.pluginArtifactHash)rejected('BINDING_CHANGED');
        const after=options.store.session(s.id,false),fresh=after.proof;
        if(!fresh||digest({...fresh,observedAt:proof.observedAt,expiresAt:proof.expiresAt})!==before)rejected('BINDING_CHANGED');
        lastWitness=witness;
        return {binding:{...wanted,scopeRevision:identity(after)},observedAt:Date.parse(fresh.observedAt),expiresAt:Date.parse(fresh.expiresAt),connected:fresh.connected,revoked:!!after.revokedAt,protectedPlace:after.placeId!==0||after.universeId!==0,testActionsAllowed:after.allowWrites,playEpoch:fresh.playEpoch,continuitySupported:fresh.continuitySupported};
      }});const proofReader=createProofReader(native);
      let control:ReturnType<typeof createStudioTestControl>;
      const receiptPins=options.store.commands(session.id).filter(command=>command.state==='succeeded'&&['script.update','script.set_enabled'].includes(command.method)).map(command=>command.id);
      const appliedReceipts=()=>receiptPins.map(id=>options.store.command(id)).map(command=>({id:command.id,method:command.method,result:command.result}));
      const readSubjects=async(wanted:TestBinding,signal:AbortSignal,readerNative=native,readerProof=proofReader,admit:()=>void=assertPreparing)=>{
        admit();
        await readerProof.read(wanted,signal);
        const before=eligible(session.id),proof=before.proof,receipts=appliedReceipts();
        if(!proof||proof.mode!=='Edit'||identity(before)!==wanted.scopeRevision||proof.markerName!==p.markerName)rejected('BINDING_CHANGED');
        admit();const result=CallToolResultSchema.parse(await readerNative.client.callTool({name:'execute_luau',arguments:{studio_id:wanted.nativeStudioId,datamodel_type:'Edit',code:scenarioSubjectProgram(proof.markerName,before.allowedRoots)}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000,resetTimeoutOnProgress:false}));
        admit();await readerProof.read(wanted,signal);admit();
        const after=eligible(session.id),fresh=after.proof;
        if(!fresh||fresh.mode!=='Edit'||fresh.playEpoch!==proof.playEpoch||identity(after)!==wanted.scopeRevision||digest(receipts)!==digest(appliedReceipts()))rejected('BINDING_CHANGED');
        try{return scenarioSubjectDigest(result,{sessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:options.pluginArtifactHash,allowedRoots:before.allowedRoots},receipts);}catch{rejected('BAD_NATIVE_RESPONSE');}
      };
      const adapter=new NativeTestAdapter({client:taskLifetime?taskReadClient(native.client,assertPreparing):native.client,evidence:native.evidence,pairedProof:proofReader,requestTimeoutMs:5000,proofMaxAgeMs:6000,captureStore:captures,subjectReader:{read:readSubjects},admissionGuard:()=>{custody.assertConnection(native);if(origin){options.taskPort!.assert(origin);taskLifetime?.work.assertActive();}},onDisconnect:()=>control?.lifecycle.onDisconnect(),decoder:{inventory:decodeTestInventory,state:(r,studioId)=>{if(!lastWitness||lastWitness.placeId!==0)rejected('BAD_NATIVE_RESPONSE');return decodeTestState(r,{nativeStudioId:studioId,placeId:lastWitness.placeId});},logs:decodeTestLogs,focus:decodeTestFocus}});
      let subjectDigest:string|undefined;
      if(a.scenario){const signal=taskLifetime?.work.signal??new AbortController().signal;await adapter.prepareScenario(a.scenario,signal);assertPreparing();subjectDigest=await adapter.readScenarioSubjects(binding,signal);assertPreparing();}
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
          async setup(signal:AbortSignal){try{for(const edit of a.scenario!.temporaryEdits??[]){signal.throwIfAborted();custody.assertConnection(native);if(j.origin){options.taskPort!.assert(j.origin);j.taskLifetime?.work.assertActive();}if(!j.reservation)rejected('FENCED');const command=options.store.enqueueTestSetup(j.reservation,edit.id);setupCommands.push(command.id);await waitCommand(command.id,signal);}}catch(error){if(j.reservation)options.store.cancelTestSetup(j.reservation);throw error;}},
          async restore(signal:AbortSignal){if(!j.reservation)rejected('FENCED');options.store.cancelTestSetup(j.reservation);let unknown=false;for(const commandId of [...setupCommands].reverse()){try{let original=options.store.command(commandId);if(original.state==='cancelled')continue;if(original.state==='dispatched')original=await waitCommand(commandId,signal);if(original.state!=='succeeded'){unknown=true;continue;}const restore=options.store.enqueueTestRestore(j.reservation,commandId);await waitCommand(restore.id,signal);}catch{unknown=true;}}if(unknown)throw new StudioTestError('EFFECT_UNKNOWN');},
          verifySubjects,
          release(){if(!j.reservation)rejected('FENCED');options.store.releaseTestReservation(j.reservation);j.reserved=false;},
        }}:{}),humanVerifier:{async confirm(context,display,displayDigest,signal){return typeof context==='object'&&context!==null&&humanContexts.has(context)&&digest(display)===displayDigest&&!signal.aborted;}},onStatus(status){if(current?.control===control&&status.phase==='done')current.view.state=current.cancelled?'cancelled':'complete';}});
      const prepared=await control.requests.prepare({binding,durationMs:a.durationMs,observationIntervalMs:a.observationIntervalMs,failOnRuntimeError:a.failOnRuntimeError,...(a.scenario?{scenario:a.scenario,subjectDigest}:{})});
      custody.assertConnection(native);assertPreparing();
      const jobId=randomUUID(),closeJoin=deferred<void>();taskLifetime?.observeJobClose(closeJoin.promise);
      j={view:{id:jobId,targetName:session.name,actor,state:'needs_approval',display:prepared.display,displayDigest:prepared.displayDigest,review:control.requests.status(),evidence:native.evidence,nativeAcceptance:false},control,connection:native,proposalId:prepared.proposalId,expiry:setTimeout(()=>{if(j.view.state==='needs_approval'){j.cancelled=true;j.view.state='cancelled';void closeJob(j).catch(()=>{});}},60000),closing:null,cancelled:false,reserved:false,reservation:null,verifySubjects:a.scenario?verifySubjects:null,
        origin,taskLifetime,taskBound:false,closeJoin,terminalSent:false,reportDigest:null,historyCreatedAt:new Date().toISOString(),subjects:'unobserved',revalidate:a.scenario?async(signal)=>{
          let fresh:NativeTestConnection|undefined,revalidation:TaskLifetime|null=null,allocationStarted=false;const requestDone=deferred<void>();
          const cancel=async()=>{if(fresh)await fresh.close();await requestDone.promise;if(revalidation)await revalidation.completion;};
          if(j.origin){if(!j.reportDigest)rejected('HUMAN_AUTH_REQUIRED');revalidation=registerTaskLifetime(options.taskPort!,j.origin,{kind:'revalidate',jobId:j.view.id,reportDigest:j.reportDigest},cancel);retainWork(revalidation);}
          const admit=()=>{if(closed)rejected('FENCED');revalidation?.work.assertActive();};
          try{admit();allocationStarted=true;try{fresh=await connectOwned('playtest-revalidate',SCENARIO_LIMITS.wireBytes,revalidation?.observeCustody);}catch(error){revalidation?.allocationFailed(error,custody.preEntryRefusal(error));throw error;}admit();custody.assertConnection(fresh);if(fresh.evidence!==native.evidence)return 'unobserved';
            const reader=fresh,proof=createProofReader(reader,admit),check=new NativeTestAdapter({client:revalidation?taskReadClient(reader.client,admit):reader.client,evidence:reader.evidence,pairedProof:proof,requestTimeoutMs:5000,proofMaxAgeMs:6000,captureStore:captures,
              subjectReader:{read:(wanted,local)=>readSubjects(wanted,local,reader,proof,admit)},decoder:{inventory:decodeTestInventory,state:(r,studioId)=>decodeTestState(r,{nativeStudioId:studioId,placeId:0}),logs:decodeTestLogs,focus:decodeTestFocus}});
            await check.prepareScenario(a.scenario!,signal);admit();custody.assertConnection(reader);const observed=await check.readScenarioSubjects(binding,signal);admit();custody.assertConnection(reader);return subjectDigest===observed?'current':'changed';
          }catch{if(!allocationStarted)revalidation?.notAllocated();return 'unobserved';}finally{try{await fresh?.close();}finally{requestDone.resolve();revalidation?.requestExited();}}
        }:null};
      // Internal preparation identity is deliberately not request-controlled.
      allocatedJob=j;if(taskLifetime){taskJobs.set(jobId,j);workJobs.set(taskLifetime,j);}
      current=j;jobs.set(jobId,j);if(jobs.size>64)jobs.delete(jobs.keys().next().value!);connection=undefined;
      archive(j,'admission');
      if(origin){try{options.taskPort!.assert(origin);options.taskPort!.prepared(origin,{jobId,displayDigest:j.view.displayDigest,scenarioDigest:j.view.review.scenario?.scenarioDigest??null,subjectDigest:subjectDigest??null},taskLifetime!.work);j.taskBound=true;}catch(error){j.cancelled=true;j.view.state='cancelled';try{await closeJob(j);}catch{/* Preserve the original task admission error. */}throw error;}}
      return view(j);
    }catch(error){if(!allocationStarted)taskLifetime?.notAllocated();failed=true;throw error;}finally{try{if(connection)await connection.close();}catch(error){if(!failed)throw error;}finally{preparing=false;requestExit.resolve();taskLifetime?.requestExited();}}
  };
  /** Read-only Edit viewport image for the exact paired, unpublished, Edit-mode
   * session through the built-in Studio MCP screen_capture tool. Never starts
   * Play, sends input, reserves the place, or accepts caller Luau. */
  const viewport=async(input:unknown,actor:string)=>{
    custody.assertReady();
    if(!id.safeParse(actor).success)rejected('HUMAN_AUTH_REQUIRED');
    const now=Date.now();while(viewportTimes.length&&now-viewportTimes[0]!>600_000)viewportTimes.shift();
    if(closed||preparing||viewing||nativeAssets.active()||current?.view.state==='running'||current?.reserved||viewportTimes.length>=VIEWPORT_RATE.captures)rejected('BUSY');
    const a=viewportRequestSchema.parse(input),session=eligible(a.sessionId),p=session.proof;
    if(!p||!p.connected||p.pluginArtifactHash!==options.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    if(p.mode!=='Edit')throw new StudioTestError('MODE_MISMATCH');
    viewing=true;viewportTimes.push(now);let connection:NativeTestConnection|undefined,failed=false;
    try{
      connection=await connectOwned('viewport',VIEWPORT_LIMITS.wireBytes);
      custody.assertConnection(connection);
      if(options.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');
      const native=connection;
      const inventory=decodeTestInventory(await native.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{timeout:5000,maxTotalTimeout:5000})) as {id:string;name:string}[];
      custody.assertConnection(native);
      const candidates=a.nativeStudioId?inventory.filter(s=>s.id===a.nativeStudioId):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const nativeStudioId=candidates[0]!.id,scope=identity(session);
      const verifyBinding=async(signal:AbortSignal)=>{
        custody.assertConnection(native);
        const s=eligible(session.id),proof=s.proof;
        if(!proof||!proof.connected||proof.mode!=='Edit'||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==p.clientLifetimeId||proof.pluginArtifactHash!==options.pluginArtifactHash||proof.markerName!==p.markerName||identity(s)!==scope)rejected('BINDING_CHANGED');
        const witness=await native.witness(nativeStudioId,proof.markerName,'Edit',signal);
        custody.assertConnection(native);
        if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==options.pluginArtifactHash)rejected('BINDING_CHANGED');
        return digest({scope,nativeStudioId,clientLifetimeId:proof.clientLifetimeId,playEpoch:proof.playEpoch,markerName:proof.markerName});
      };
      const image=await captureEditViewport({client:native.client,nativeStudioId,captureId:'ArcaneViewport_'+randomUUID().replaceAll('-',''),maxDimension:a.maxDimension,
        ...(a.camera?{camera:a.camera}:{}),...(a.sheet?{sheet:a.sheet}:{}),verifyBinding,admissionGuard:()=>custody.assertConnection(native),decodeMode:decodeTestMode,...(options.fixtureScheduler?{scheduler:options.fixtureScheduler}:{})},AbortSignal.timeout(VIEWPORT_RATE.deadlineMs));
      custody.assertConnection(native);
      return {viewport:{sessionId:session.id,nativeStudioId,mode:'Edit' as const,mimeType:'image/png' as const,width:image.width,height:image.height,
        originalWidth:image.originalWidth,originalHeight:image.originalHeight,downscaled:image.downscaled,bytes:image.bytes,sha256:image.sha256,camera:image.camera,evidence:native.evidence},
        data:image.png.toString('base64')};
    }catch(error){failed=true;throw error;}finally{try{if(connection)await connection.close();}catch(error){if(!failed)throw error;}finally{viewing=false;}}
  };
  /** Native asset search/insert/generation: same exact-session Edit binding as the viewport. */
  const nativeAssets=createNativeAssetRequests({store:options.store,pluginArtifactHash:options.pluginArtifactHash,connect:operation=>connectOwned(operation),assertCurrent:connection=>custody.assertConnection(connection),assertReady:()=>custody.assertReady(),
    ...(options.fixtureScheduler?{fixtureScheduler:options.fixtureScheduler}:{}),...(options.revokeModelSource?{revokeModelSource:options.revokeModelSource}:{}),eligible,identity,busy:()=>closed||preparing||viewing||current?.view.state==='running'||!!current?.reserved});
  let serviceClosing:Promise<void>|null=null;
  return Object.freeze({
    reportArchiveStatus:()=>reportFault,
    async cancelExact(jobId:string,origin:StudioTestTaskOrigin){const j=taskJobs.get(jobId)??jobs.get(jobId);if(!j||j.origin!==origin)rejected('HUMAN_AUTH_REQUIRED');j.cancelled=true;if(j.view.state==='needs_approval')j.view.state='cancelled';const review=j.control.requests.status();if(review.runId&&review.phase!=='done')await j.control.requests.stop({runId:review.runId});await closeJob(j);const final=j.control.requests.status();if(j.reserved||final.runId!==null&&final.cleanup!=='complete'||final.scenario?.inputRelease==='unknown')rejected('FENCED');},
    async revalidateExact(jobId:string,origin:StudioTestTaskOrigin,reportDigest:string):Promise<'current'|'changed'|'unobserved'>{if(closed)rejected('FENCED');const j=taskJobs.get(jobId)??jobs.get(jobId);if(!j||j.origin!==origin||j.reportDigest!==reportDigest||!j.revalidate)rejected('HUMAN_AUTH_REQUIRED');if(j.reserved||j.control.requests.status().cleanup!=='complete')return 'unobserved';return j.revalidate(AbortSignal.timeout(15000));},
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
      custody.assertReady();custody.assertConnection(j.connection);
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
        custody.assertConnection(j.connection);
        j.reservation=options.store.reserveTest(j.view.display.proposal.binding.pairedSessionId,j.view.id,j.view.display.proposal.scenario?.temporaryEdits);j.reserved=true;clearTimeout(j.expiry);
        try{await j.control.requests.start({proposalId:j.proposalId,consentId});}
        catch(error){j.view.state='complete';try{await closeJob(j);}catch{/* Preserve the original start error. */}throw error;}
        j.view.state='running';
        void j.control.requests.wait({runId:j.control.requests.status().runId!}).finally(()=>closeJob(j)).catch(()=>{});
        return view(j);
      }finally{humanContexts.delete(context);}
    }}),
    lifecycle:Object.freeze({close():Promise<void>{
      if(serviceClosing)return serviceClosing;const outcome=deferred<void>();serviceClosing=outcome.promise;
      void (async()=>{
        closed=true;let failed=false,failure:unknown;
        const keep=(error:unknown)=>{if(!failed){failed=true;failure=error;}};
        try{custody.retireAdmissions();}catch(error){keep(error);}
        try{nativeAssets.close();}catch(error){keep(error);}
        const originalJobs=[...new Set([...taskJobs.values(),...(current?[current]:[])])];
        const closes=originalJobs.map(job=>{const pending=closeJob(job);void pending.catch(()=>{});return pending;});
        const custodyClose=custody.close();void custodyClose.catch(()=>{});
        for(const pending of closes)try{await pending;}catch(error){keep(error);}
        // No new registration can allocate after retirement. Existing held
        // factories stay joined until their original request and cleanup finish.
        for(const life of [...taskWorks])try{await life.completion;}catch(error){keep(error);}
        try{await custodyClose;}catch(error){keep(error);}
        try{await ledger.close();}catch(error){keep(error);}
        if(failed)throw failure;
      })().then(()=>outcome.resolve(),error=>outcome.reject(error));return serviceClosing;
    }}),
  });
}
type CreatedStudioTestService=Awaited<ReturnType<typeof createStudioTestService>>;
/** Capture is an optional extension for older trusted host/test integrations. */
export type StudioTestService=Omit<CreatedStudioTestService,'requests'|'humanControl'|'cancelExact'|'revalidateExact'|'reportArchiveStatus'>&Partial<Pick<CreatedStudioTestService,'cancelExact'|'revalidateExact'|'reportArchiveStatus'>>&{humanControl:Omit<CreatedStudioTestService['humanControl'],'toolboxPolicy'>&Partial<Pick<CreatedStudioTestService['humanControl'],'toolboxPolicy'>>;requests:Omit<CreatedStudioTestService['requests'],'capture'|'viewport'|'nativeAssets'>&Partial<Pick<CreatedStudioTestService['requests'],'capture'|'viewport'|'nativeAssets'>>};
