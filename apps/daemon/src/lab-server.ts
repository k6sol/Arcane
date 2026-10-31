import { createNativeAssetRegistry } from './native-asset-authority.js';
import {captureModelSourceBinding} from './model-source-binding.js';
import {createAppAssetControl} from './app-asset-control.js';
import {createAppAssetHumanSelection} from './app-asset-human-selection.js';
import { createNativeHandoffRoutes } from './native-handoff-routes.js';
import { nativeAssetRoutes } from './native-asset-routes.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import { createWorkflowCodeHostVerifier, type WorkflowCodeHostConfiguration } from './workflow-code-host.js';
import { createAssetConversationHost } from './asset-conversation-host.js';
import { workflowNativeModel } from './workflow-native-model.js';
import { mkdir, realpath } from 'node:fs/promises';
import { createScriptSourceVerifier, type ScriptSourceVerifier } from '../../../packages/core/src/script-source-verifier.js';
import { createWorkflowHost } from './workflow-host.js';
import { workflowRoutes } from './workflow-routes.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { learningRoutes } from './learning-routes.js';
import type { LearningService } from './learning-service.js';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openStudioTestReportStore, StudioTestReportError, type StudioTestReportStore, type StudioTestReportArchiveStatus } from './studio-test-report-store.js';
import { studioTestReportRoutes, type StudioTestReportRouteStore } from './studio-test-report-routes.js';
import { readStudioTestCapture } from './studio-test-captures.js';
import { TestLedger } from '../../../packages/studio-test-controller/src/ledger.js';
import { ArcaneError, type Connection, type Selection } from '../../../packages/protocol/src/providers.js';
import { validateSelection, SelectionStore } from '../../../packages/core/src/selection.js';
import { discoverProviders } from '../../../packages/model-adapters/src/discovery.js';
import type { StudioStore,StudioNativeCustodyPort } from '../../../packages/storage/src/studio-store.js';
import {SDK_CUSTODY_UNCONFIRMED_MESSAGE,captureStudioTestNativeProject} from './studio-test-native-custody.js';
import { studioRoutes } from './studio-routes.js';
import type { WorkStore } from '../../../packages/storage/src/work-store.js';
import type { AssetService } from './asset-service.js';
import type {createStudioImportStagingController} from './studio-import-staging-controller.js';
import { assetRoutes } from './asset-routes.js';
import {assetReviewRoutes} from './asset-review-routes.js';
import type {AssetReviewHost} from './asset-review-host.js';
import { nativeRoutes } from './native-routes.js';
import { createCodexService, type CodexService, type CodexServiceOptions } from './codex-service.js';
import { codexRoutes } from './codex-routes.js';
import {createStudioTestService, type StudioTestService, type NativeTestConnection} from './studio-test-service.js';
import {studioTestRoutes, STUDIO_TEST_HTTP_LIMITS, type StudioTestActorResolver, type StudioTestRouteService} from './studio-test-routes.js';
import { studioImportPluginArtifactHash } from './studio-import-plugin-artifact.js';
import { plansRoutes } from './plans-routes.js';
import { projectMemoryRoutes } from './project-memory-routes.js';
import { preferenceRoutes } from './preference-routes.js';
import { createPreferenceStore } from '../../../packages/core/src/preference-store.js';
import { scriptSyncRoutes } from './script-sync-routes.js';
import { ActionsLedger } from './actions-ledger.js';
import { createMeshKeep } from './mesh-keep-routes.js';
import { createImportedAssets } from './imported-assets.js';

const unavailableTestMessages = {
  SDK_CUSTODY_UNCONFIRMED: SDK_CUSTODY_UNCONFIRMED_MESSAGE,
  UNAVAILABLE: 'Playtests are unavailable because the trusted plugin source could not be verified. Repair the local plugin build artifacts and restart Arcane before requesting a test.',
  FENCED: 'Playtests, viewport capture and Studio asset tools are paused: Arcane kept the records of an earlier playtest that did not finish cleanly. Ask the user to stop any running playtest in Studio and click "Repair playtest records" in the Playtests panel, then try again. Do not delete the journal or writer lock.',
} as const;

function unavailableStudioTestRoutes(code: keyof typeof unavailableTestMessages, resolveActor: StudioTestActorResolver) {
  const refuse = (): never => { throw new ArcaneError(code, unavailableTestMessages[code]); };
  const service: StudioTestRouteService = {
    // Viewport and native asset routes share this service; refuse them with the same fixed reason instead of a generic UNAVAILABLE.
    requests: { async prepare() { refuse(); }, status: refuse, list: refuse, async cancel() { refuse(); }, viewport: (async () => { refuse(); }) as unknown as NonNullable<StudioTestRouteService['requests']['viewport']>,
      nativeAssets: { async search() { refuse(); }, async insert() { refuse(); }, async generate() { refuse(); }, async job() { refuse(); } } as unknown as NonNullable<StudioTestRouteService['requests']['nativeAssets']> },
    humanControl: { async approve(_input, guard) { guard(); refuse(); } },
    lifecycle: { async close() {} },
  };
  const route = studioTestRoutes(service, resolveActor);
  const status = code === 'FENCED'||code==='SDK_CUSTODY_UNCONFIRMED' ? 409 : 503;
  const json = JSON.stringify({ error: code, message: unavailableTestMessages[code] });
  const bytes = Buffer.byteLength(json);
  if (bytes > STUDIO_TEST_HTTP_LIMITS.responseBytes) throw new ArcaneError('RESPONSE_LIMIT', 'Playtest recovery guidance exceeds the response bound.');
  return (request: IncomingMessage, response: ServerResponse, url: URL, origin: string) => {
    // Keep all route validation and refusal contracts. Only this rejecting
    // service's fixed error gets host recovery guidance; ingress errors stay intact.
    let recovery = false;
    const presentation = new Proxy(response, {
      get(target, key) {
        if (key === 'writeHead') return (sentStatus: number, headers: OutgoingHttpHeaders) => {
          recovery = sentStatus === status;
          return target.writeHead(sentStatus, recovery ? { ...headers, 'Content-Length': bytes } : headers);
        };
        if (key === 'end') return (body: string) => target.end(recovery ? json : body);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return route(request, presentation, url, origin);
  };
}

interface Options {
  cwd: string;
  stateDirectory: string;
  /** Trusted parent composition: original directory used to construct studioStore. Never route input. */
  studioWorkspaceDirectory?: string;
  probe?: (cwd: string) => Promise<Connection[]>;
  studioStore?: StudioStore;
  workStore?: WorkStore;
  /** Borrowed canonical store shared with the product's asset service. */
  conversationWorkStore?: ConversationWorkStore;
  projectPath?: string;
  port?: number;
  assetService?: AssetService;
  /** Trusted launcher factory, created after current conversation binding exists. */
  assetReviewHostFactory?:(conversation:ReturnType<typeof createAssetConversationHost>,selectionEpoch:()=>object)=>AssetReviewHost;
  studioImportStaging?: Pick<ReturnType<typeof createStudioImportStagingController>, 'stage'> & Partial<Pick<ReturnType<typeof createStudioImportStagingController>, 'status'|'reconstruct'|'reconstructionStatus'>>;
  /** Owned by the product launcher; absent in metadata-only labs. */
  learningService?: LearningService;
  /** Test-only service seam. Production creates the trusted personal-local service. */
  codexService?: CodexService;
  /** Trusted/test-only client factory for the owned service; never supplied by HTTP. */
  codexConnect?: CodexServiceOptions['connect'];
  /** Trusted owned worker injection for product composition/fixtures; never HTTP input. */
  codexProposalWorker?: CodexServiceOptions['proposalWorker'];
  /** Trusted embedding opt-in; never accepted from HTTP. Standard chat leaves this disabled. */
  codexAutomaticTaskPlanning?: boolean;
  /** Owned product diagnostics callback; never supplied by HTTP or agent data. */
  codexReportFailure?: CodexServiceOptions['reportFailure'];
  /** Trusted product-owned asset reporting; never HTTP input or a required storage ACK. */
  assetReportFailure?: CodexServiceOptions['reportFailure'];
  /** Explicit trusted launcher configuration. Never supplied by route JSON. Missing means no compiler preflight. */
  workflowCodeVerification?: WorkflowCodeHostConfiguration;
  /** Trusted/test-only borrowed verifier. Never accepted from HTTP or agent data. */
  scriptSourceVerifier?: ScriptSourceVerifier;
  /** Borrowed trusted fixture seam; HTTP can never supply a test backend. */
  studioTestService?: StudioTestService;
  /** Owned native connection factory for trusted process/SDK fixtures only. */
  studioTestConnect?: () => Promise<NativeTestConnection>;
  /** Trusted launcher path for the user-wide learned-preference layer (owned state root); never HTTP input. */
  preferenceGlobalDirectory?: string;
}
export async function createConnectionLab(options: Options) {
  if (options.conversationWorkStore) {
    const expected = workflowProjectIdentity(options.projectPath ?? options.cwd);
    if (!options.workStore || !(options.conversationWorkStore instanceof ConversationWorkStore) ||
      options.conversationWorkStore.projectPath !== expected.projectPath ||
      options.conversationWorkStore.projectId !== expected.projectId) {
      throw new ArcaneError('CONVERSATION_WORK_SCOPE', 'The shared conversation store must belong to this exact product project.');
    }
  }
  const token = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  let origin = '';
  const handoffs=options.studioStore&&options.workStore
    ?createNativeHandoffRoutes({projectPath:options.projectPath??options.cwd}):null;
  const nativeAssetRegistry = options.assetService && options.workStore
    ? createNativeAssetRegistry({projectPath:workflowProjectIdentity(options.projectPath ?? options.cwd).projectPath,
      ...(options.studioStore?{modelSourceBinding:(sessionId:string)=>captureModelSourceBinding(options.studioStore!,sessionId)}:{})}) : null;
  // Parent-only authority port. It is deliberately absent from HTTP/state.
  const humanAssetSelection=createAppAssetHumanSelection({codexConversation:()=>{
    const state=codex?.state(),thread=state?.snapshot?.thread;
    const identity=thread?.configured?thread:state?.nativeHistory;
    return identity?{provider:'codex',threadId:identity.threadId,sessionId:identity.sessionId}:null;
  }});
  const appAssets=nativeAssetRegistry?createAppAssetControl({projectPath:options.projectPath??options.cwd,registry:nativeAssetRegistry,humanSelection:humanAssetSelection}):null;
  const coreAgentToken = (request: IncomingMessage): string => {
    const handoff=handoffs?.agentToken(request,origin);if(handoff)return handoff;
    const value = request.headers.authorization;
    const bearer = typeof value==='string' && /^Bearer [a-f0-9]{64}(?![\s\S])/.test(value) ? value.slice(7) : '';
    return nativeAssetRegistry?.recognizes(bearer) ? bearer : agentToken;
  };
  const captureModelSource=(request:IncomingMessage)=>{
    const bearer=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):'';
    // Classification is not execution authority. Audio and ordinary reads stay
    // independent; model effects require this exact captured mutation epoch.
    try{return nativeAssetRegistry?.capture(bearer,'mutate')??null;}catch{return null;}
  };
  let bridge: ReturnType<typeof studioRoutes> | null = null;
  let ownedSourceVerifier: ScriptSourceVerifier | null = null;
  let ownedTests = null as StudioTestService | null; // assigned inside openOwnedTests
  let testApi: ReturnType<typeof studioTestRoutes> | null = null;
  let testHistoryApi: ReturnType<typeof studioTestReportRoutes> | null = null;
  let testReports: StudioTestReportStore | null = null;
  // A report read belongs to this daemon incarnation. Shutdown invalidates every
  // captured read before any owned resource closes; the epoch is never reused.
  let testHistoryEpoch = 0;
  // Playtest journal repair (human only): set when the owned service is fenced by retained records.
  let testsFenced = false, repairingTests = false;
  let nativeTestCustody:StudioNativeCustodyPort|undefined;
  let assertNativeTestProject:(()=>void)|undefined;
  let openOwnedTests: (() => Promise<boolean>) | null = null, exclusiveTestWriter: (() => boolean) | null = null;
  const native = options.studioStore ? nativeRoutes() : null;
  const learning = options.learningService ? learningRoutes(options.learningService) : null;
  const store = new SelectionStore(options.stateDirectory);
  let connections: Connection[] = [];
  let selection: Selection | null = null;
  const stateWarnings: string[] = [];
  let savedStateFailed = false;
  try { selection = await store.read(); } catch { savedStateFailed = true; stateWarnings.push('Saved preference unreadable; original file has not been overwritten. Repair or back it up before saving a new preference.'); }
  let busy = false;
  let shuttingDown = false;
  const codex = options.codexService ?? (options.studioStore ? createCodexService({
    directory: join(options.stateDirectory, 'native-codex'), projectPath: options.projectPath ?? options.cwd,
    ...(options.codexConnect ? {connect:options.codexConnect} : {}),
    ...(options.codexProposalWorker ? {proposalWorker:options.codexProposalWorker} : {}),
    ...(options.codexAutomaticTaskPlanning === true ? {automaticTaskPlanning:true} : {}),
    ...(options.codexReportFailure ? {reportFailure:options.codexReportFailure} : {}),
    ...(nativeAssetRegistry ? {assetRegistry:nativeAssetRegistry} : {}),
    ...(options.workStore ? {workStore:options.workStore} : {}),
    learnedContext: async () => learnedStore ? learnedStore.context() : '',
    arcaneMcp: () => ({ nodeExecutable: process.execPath, serverEntry: join(options.cwd,'dist','apps','mcp','src','main.js'),
      projectRoot: options.projectPath ?? options.cwd, daemonUrl: origin, agentToken }),
  }) : null);
  const nativeChat = codex ? codexRoutes(codex, {workflowModels:true}) : null;
  // Arcane actions metering and Plans & credits (informational; never blocks work, never charges).
  // Project memory: ARCANE.md in this project folder, read and written by the human desktop only.
  const projectMemory = options.studioStore ? projectMemoryRoutes({ projectPath: options.projectPath ?? options.cwd }) : null;
  // Learned preferences: local feedback loop (chat context, tool defaults, skill boosts). Feedback is human-only; agents read.
  const learnedStore = options.studioStore ? createPreferenceStore({ projectDirectory: join(options.stateDirectory, 'learned-preferences'),
    globalDirectory: options.preferenceGlobalDirectory ?? join(options.stateDirectory, 'learned-preferences-global') }) : null;
  const learnedPreferences = learnedStore ? preferenceRoutes({ store: learnedStore, agent: request => {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    return (Buffer.byteLength(supplied) === Buffer.byteLength(agentToken) && timingSafeEqual(Buffer.from(supplied), Buffer.from(agentToken))) || !!handoffs?.agentToken(request, origin);
  } }) : null;
  // Script sync (opt-in per project): mirrors granted Studio scripts into <project>/src and applies file edits back. Human desktop only.
  const scriptSync = options.studioStore ? scriptSyncRoutes({ projectPath: options.projectPath ?? options.cwd, stateDirectory: options.stateDirectory, studio: options.studioStore }) : null;
  // Keep this mesh: human desktop only; uploads need a trusted-dialog consent delivered over the parent IPC (product-main).
  const meshKeep = options.studioStore ? createMeshKeep({ store: options.studioStore, stateDirectory: options.stateDirectory }) : null;
  // Imported models and effects ("Imported by you"): a separate store; uploads need the desktop host's IPC consent.
  const imports = options.studioStore ? createImportedAssets({ stateDirectory: options.stateDirectory }) : null;
  const plans = options.studioStore ? plansRoutes({ ledger: new ActionsLedger(join(options.stateDirectory, 'arcane-actions')),
    codexState: () => codex?.state(), studioEvents: () => options.studioStore?.events(100) ?? [] }) : null;
  // Quiesce every retained task before other services publish terminal evidence.
  // Cleanup still runs if an individual private lifecycle hook fails.
  const fenceTasks = (): unknown[] => {
    try { codex?.fenceTaskAdmission?.(); return []; } catch (error) { return [error]; }
  };
  let associations: ConversationWorkStore | null = null;
  let ownsAssociations = false;
  let workflow: ReturnType<typeof createWorkflowHost> | null = null;
  let conversationAssets: ReturnType<typeof createAssetConversationHost> | null = null;
  let modelReviews:AssetReviewHost|null=null;
  try {
    if (options.studioStore && options.workflowCodeVerification && !options.scriptSourceVerifier) {
      const directory = join(options.stateDirectory, 'studio-source-verification');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { ownedSourceVerifier = await createScriptSourceVerifier({ compiler:options.workflowCodeVerification.compiler, directory:await realpath(directory) }); }
      catch { /* Failed trusted preflight leaves activation unavailable, never a fallback. */ }
    }
    bridge = options.studioStore ? studioRoutes(options.studioStore, options.cwd, options.workStore, options.projectPath, coreAgentToken, options.scriptSourceVerifier ?? ownedSourceVerifier,
      (actorId,binding)=>{if(!codex?.authorizeBoundWork)throw new ArcaneError('SCOPE','Original native task work authority is unavailable.');codex.authorizeBoundWork(actorId,binding);},{},captureModelSource) : null;
    if(options.studioStore){
      const resolveTestActor: StudioTestActorResolver = request => {
        const bearer=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):'';
        if(bearer===token)return {kind:'human',id:'human'};
        if(bearer.length>0&&bearer===coreAgentToken(request))return {kind:'agent',id:'agent-'+createHash('sha256').update(bearer).digest('hex')};
        return null;
      };
      const studioStore=options.studioStore;
      // The trusted parent supplies the original store workspace for legacy sibling state layouts.
      // Other embeddings retain the nested-state convention; the exact workspace lock is still required.
      const studioWorkspaceDirectory=options.studioWorkspaceDirectory??dirname(options.stateDirectory);
      exclusiveTestWriter=()=>studioStore.holdsWorkspaceLock(studioWorkspaceDirectory);
      const testProject=captureStudioTestNativeProject(options.projectPath??options.cwd),testProjectId=testProject.projectId;
      assertNativeTestProject=testProject.assertCurrent;
      try{nativeTestCustody=studioStore.bindNativeCustody(testProjectId,studioWorkspaceDirectory);}catch{/* History remains independently readable; native admission refuses below. */}
      const archiveUnavailable=Object.freeze({state:'unavailable',code:'ARCHIVE_UNAVAILABLE'} as const);
      try {
        testReports=await openStudioTestReportStore({directory:join(options.stateDirectory,'playtest-reports'),
          projectId:testProjectId,exclusiveWriter:exclusiveTestWriter});
      } catch {
        stateWarnings.push('Saved playtest reports are unavailable; the original records have been retained.');
      }
      // Keep authenticated historical reads independent of the live safety
      // ledger. An unavailable archive is explicit, never a fabricated report.
      const historyStore:StudioTestReportRouteStore=testReports??Object.freeze({
        projectId:testProjectId,status:()=>archiveUnavailable,
        list:(input:unknown,guard:()=>void)=>{guard();
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||
            !Object.hasOwn(input,'cursor')||(input as {cursor:unknown}).cursor!==null)throw new StudioTestReportError('ARCHIVE_UNAVAILABLE');
          return Object.freeze({schemaVersion:1 as const,projectId:testProjectId,
          archive:archiveUnavailable,reports:Object.freeze([]),nextCursor:null,omittedReports:0});},
        get:(_jobId:string,guard:()=>void)=>{guard();throw new StudioTestReportError('ARCHIVE_UNAVAILABLE');},
        captureDescriptor:(_jobId:string,guard:()=>void)=>{guard();throw new StudioTestReportError('ARCHIVE_UNAVAILABLE');},
      });
      const archiveStatus=():StudioTestReportArchiveStatus=>{
        const retained=historyStore.status();
        if(retained.state!=='ready')return retained;
        const live=ownedTests??options.studioTestService;
        // A fenced live ledger does not make previously retained reports
        // unavailable. Any independently observed archive fault stays visible.
        return live?.reportArchiveStatus?.()??retained;
      };
      testHistoryApi=studioTestReportRoutes(historyStore,resolveTestActor,{
        captureScope:()=>{
          const capturedEpoch=testHistoryEpoch;
          return Object.freeze({projectId:testProjectId,assertCurrent:()=>{
            if(shuttingDown||capturedEpoch!==testHistoryEpoch)throw new StudioTestReportError('ARCHIVE_UNAVAILABLE');
          }});
        },
        readCapture:(image,guard)=>readStudioTestCapture(join(options.stateDirectory,'playtests'),image,guard),
        archiveStatus,
      });
      const attach=(tests:StudioTestService)=>{
        testApi=studioTestRoutes(tests,resolveTestActor,captureModelSource);
        if(codex?.playtestTasks&&tests.cancelExact&&tests.revalidateExact)codex.attachPlaytestCancellation?.(Object.freeze({cancelExact:tests.cancelExact,revalidateExact:tests.revalidateExact}));
      };
      openOwnedTests=async()=>{
        let unavailableCode: keyof typeof unavailableTestMessages = 'SDK_CUSTODY_UNCONFIRMED';
        try{
          const custody=nativeTestCustody;if(!custody)throw new ArcaneError('SDK_CUSTODY_UNCONFIRMED',SDK_CUSTODY_UNCONFIRMED_MESSAGE);
          testProject.assertCurrent();custody.assertReady();
          unavailableCode='UNAVAILABLE';
          // Match the actual loaded Script/ModuleScript identity used by the
          // plugin's continuity proof, rather than a delivery-file checksum.
          const pluginArtifactHash=await studioImportPluginArtifactHash(options.cwd);
          unavailableCode='SDK_CUSTODY_UNCONFIRMED';testProject.assertCurrent();custody.assertReady();
          // Once source verification passes, a failed journal initialization is
          // retained state. Only a provably abandoned writer lock with fully
          // verified, resolved records is cleared (inside TestLedger.open);
          // everything else waits for the human "Repair playtest records" action.
          unavailableCode='FENCED';
          ownedTests=await createStudioTestService({directory:join(options.stateDirectory,'playtests'),store:studioStore,pluginArtifactHash,custody,assertProject:testProject.assertCurrent,
            ...(nativeAssetRegistry?{revokeModelSource:(sessionId:string)=>nativeAssetRegistry.revokeModelSource(sessionId)}:{}),
            exclusiveWriter:exclusiveTestWriter!,
            ...(testReports?{reports:testReports}:{}),
            ...(options.studioTestConnect?{connect:options.studioTestConnect}:{}),
            ...(codex?.playtestTasks?{taskPort:codex.playtestTasks}:{})});
          testsFenced=false;attach(ownedTests);return true;
        }catch{
          if(!stateWarnings.includes(unavailableTestMessages[unavailableCode]))stateWarnings.push(unavailableTestMessages[unavailableCode]);
          testsFenced=unavailableCode==='FENCED';
          testApi=unavailableStudioTestRoutes(unavailableCode,resolveTestActor);return false;
        }
      };
      if(options.studioTestService)attach(options.studioTestService);
      else await openOwnedTests();
    }
    if (options.workStore) {
      associations = options.conversationWorkStore ?? new ConversationWorkStore({
        directory: join(options.stateDirectory, 'conversation-work'),
        projectPath: options.projectPath ?? options.cwd,
      });
      ownsAssociations = !options.conversationWorkStore;
      if (options.assetService && (process.platform === 'win32'
        ? options.assetService.projectPath.toLowerCase() !== associations.projectPath.toLowerCase()
        : options.assetService.projectPath !== associations.projectPath))
        throw new ArcaneError('ASSET_CONVERSATION_PROJECT', 'The asset service and conversation store must attest the same project.');
      const workflowDirectory = join(options.stateDirectory, 'workflows');
      await mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
      const codeVerifier = options.workflowCodeVerification
        ? await createWorkflowCodeHostVerifier(associations.projectPath, options.workflowCodeVerification) : null;
      workflow = createWorkflowHost({
        directory: workflowDirectory, projectPath: options.projectPath ?? options.cwd,
        workStore: { store: options.workStore, projectPath: options.projectPath ?? options.cwd },
        workAssociations: associations,
        ...(codeVerifier ? { verifiers: [codeVerifier] } : {}),
        conversation: () => {
          const state = codex?.state(), thread = state?.snapshot?.thread;
          const identity = thread?.configured ? thread : state?.nativeHistory;
          return identity ? { provider: 'codex', threadId: identity.threadId, sessionId: identity.sessionId } : null;
        },
        modelSelection: () => workflowNativeModel(codex?.state()??null)?.proof.selection??null,
        policyContext: () => {
          const current=workflowNativeModel(codex?.state()??null);
          return {connections:current?[current.connection,...connections.filter(c=>c.provider!=='codex')]:connections.filter(c=>c.provider!=='codex'),capabilities:[{id:'local.patch',state:'available',safety:'human-handoff'}]};
        },
      });
    }
    conversationAssets = options.assetService && associations ? createAssetConversationHost({
      projectPath: associations.projectPath, workAssociations: associations,
      conversation: humanAssetSelection.current,
      start: async request => (await options.assetService!.start(request)).jobId,
      startNative: async (request,admission) => (await options.assetService!.start(request,admission)).jobId,
      ...(typeof options.assetService.adoptProjectGlb === 'function' ? {adoptNative: async (request,actor,admission) => (await options.assetService!.adoptProjectGlb(request,actor,admission)).jobId} satisfies Pick<import('./asset-conversation-host.js').AssetConversationHostOptions,'adoptNative'> : {}),
      ...(typeof options.assetService.convertProjectGlb === 'function' ? {convertNative: async (request,actor,admission) => (await options.assetService!.convertProjectGlb(request,actor,admission)).jobId} satisfies Pick<import('./asset-conversation-host.js').AssetConversationHostOptions,'convertNative'> : {}),
    }) : null;
    if(options.assetReviewHostFactory){if(!conversationAssets)throw new ArcaneError('ASSET_REVIEW_CONFIGURATION','Model review requires the current asset conversation.');modelReviews=options.assetReviewHostFactory(conversationAssets,humanAssetSelection.epoch);}
  } catch (error) {
    // Initialization failure must close every owned resource, without closing
    // the launcher's borrowed WorkStore or masking the original failure.
    testHistoryEpoch++;
    fenceTasks();
    humanAssetSelection.close(); appAssets?.close(); handoffs?.close(); nativeAssetRegistry?.close(); scriptSync?.close();
    ownedSourceVerifier?.dispose();
    try { await ownedTests?.lifecycle.close(); } catch { /* Preserve original failure/fence. */ }
    try { testReports?.close(); } catch { /* Preserve original failure. */ }
    try { modelReviews?.close(); } catch { /* Preserve original failure. */ }
    try { workflow?.close(); } catch { /* Preserve original failure. */ }
    try { if (ownsAssociations) associations?.close(); } catch { /* Preserve original failure. */ }
    try { await codex?.close(); } catch { /* Preserve original failure. */ }
    throw error;
  }
  const assets = options.assetService ? assetRoutes(options.assetService, conversationAssets ?? undefined) : null;
  const modelReviewApi=modelReviews?assetReviewRoutes(modelReviews):null;
  const scopedAssets = options.assetService && conversationAssets && nativeAssetRegistry
    ? nativeAssetRoutes(options.assetService,conversationAssets,nativeAssetRegistry,options.studioImportStaging,options.assetReportFailure) : null;
  const workflowApi = workflow ? workflowRoutes(workflow) : null;
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  /** POST /v1/playtests/repair: the person confirms Studio is back in Edit mode; the retained journal is
   * moved aside unchanged (never deleted) and a fresh one opened. Human desktop token and Origin only. */
  const repairPlaytestRecords = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (!openOwnedTests || !exclusiveTestWriter) return false;
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      send(response, 401, { error: 'AUTH', message: 'Only the person using Arcane can repair playtest records.' }); return true;
    }
    if (request.method !== 'POST') { send(response, 405, { error: 'METHOD', message: 'Use POST.' }); return true; }
    if (request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Writes require the local panel origin.');
    const input = await readJson(request) as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'confirm' || input.confirm !== 'studio-in-edit-mode') {
      send(response, 400, { error: 'INVALID_REQUEST', message: 'Confirm that Studio is back in Edit mode.' }); return true;
    }
    const custody=nativeTestCustody,checkProject=assertNativeTestProject;
    try{if(!custody||!checkProject)throw new Error();checkProject();custody.assertReady();}
    catch{send(response,409,{error:'SDK_CUSTODY_UNCONFIRMED',message:SDK_CUSTODY_UNCONFIRMED_MESSAGE});return true;}
    if (!testsFenced) { send(response, 409, { error: 'NOT_FENCED', message: 'Playtest records are already healthy.' }); return true; }
    if (repairingTests) { send(response, 409, { error: 'BUSY', message: 'A repair is already running.' }); return true; }
    repairingTests = true;
    try {
      const root = await realpath(join(options.stateDirectory, 'playtests'));
      try{if(!checkProject||!custody)throw new Error();checkProject();custody.assertReady();}catch{send(response,409,{error:'SDK_CUSTODY_UNCONFIRMED',message:SDK_CUSTODY_UNCONFIRMED_MESSAGE});return true;}
      let retained: string;
      try { retained = await TestLedger.retainForRepair(join(root, 'ledger'), root, join(options.stateDirectory, 'playtests-retained'), { exclusiveWriter: exclusiveTestWriter }); }
      catch { send(response, 409, { error: 'FENCED', message: 'Arcane could not set the earlier playtest records aside. Close other Arcane windows for this project and try again.' }); return true; }
      const reopened = await openOwnedTests();
      if (!reopened) { send(response, 409, { error: 'FENCED', message: 'The earlier records were kept, but playtests could not restart. Restart Arcane and try again.' }); return true; }
      const kept = 'playtests-retained/' + retained.split(/[\\/]/).at(-1);
      const notice = unavailableTestMessages.FENCED, at = stateWarnings.indexOf(notice); if (at >= 0) stateWarnings.splice(at, 1);
      send(response, 200, { repaired: true, retained: kept, message: 'Playtest records repaired. The earlier records were kept in ' + kept + '.' });
      return true;
    } finally { repairingTests = false; }
  };
  const server = createServer(async (request, response) => {
    if (shuttingDown) { response.writeHead(503, {'Connection': 'close'}); response.end(); return; }
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) throw new ArcaneError('HOST', 'Unexpected local host.');
      const url = new URL(request.url ?? '/', origin);
      // The product preview must land on the same conversation surface as the
      // desktop host. The legacy metadata lab remains an explicit diagnostic.
      if (bridge && request.method === 'GET' && url.pathname === '/') {
        response.writeHead(307, { Location: '/studio', 'Cache-Control': 'no-store' });
        response.end(); return;
      }
      const publicRoutes = new Map<string, [string, string]>([
        ['/', [join(options.cwd, 'apps/desktop/public/index.html'), 'text/html']],
        ['/diagnostics', [join(options.cwd, 'apps/desktop/public/index.html'), 'text/html']],
        ['/lab.css', [join(options.cwd, 'apps/desktop/public/lab.css'), 'text/css']],
        ['/lab.js', [join(options.cwd, 'dist/apps/desktop/src/lab.js'), 'text/javascript']],
        ...(bridge ? [
          ['/studio', [join(options.cwd, 'apps/desktop/public/studio.html'), 'text/html']],
          ['/studio.css', [join(options.cwd, 'apps/desktop/public/studio.css'), 'text/css']],
          ['/studio.js', [join(options.cwd, 'dist/apps/desktop/src/studio.js'), 'text/javascript']],
          ['/pyx-bar', [join(options.cwd, 'apps/desktop/public/pyx-bar.html'), 'text/html']],
          ['/pyx-bar.css', [join(options.cwd, 'apps/desktop/public/pyx-bar.css'), 'text/css']],
          ['/pyx-bar.js', [join(options.cwd, 'dist/apps/desktop/src/pyx-bar.js'), 'text/javascript']],
          ['/pyx-sprite.js', [join(options.cwd, 'dist/apps/desktop/src/pyx-sprite.js'), 'text/javascript']],
          ['/pyx-link.js', [join(options.cwd, 'dist/apps/desktop/src/pyx-link.js'), 'text/javascript']],
          ['/codex-chat.js', [join(options.cwd, 'dist/apps/desktop/src/codex-chat.js'), 'text/javascript']],
          ['/user-errors.js', [join(options.cwd, 'dist/apps/desktop/src/user-errors.js'), 'text/javascript']],
          ['/codex-task-plan.js', [join(options.cwd, 'dist/apps/desktop/src/codex-task-plan.js'), 'text/javascript']],
          ['/task-plan-boot.js', [join(options.cwd, 'dist/apps/desktop/src/task-plan-boot.js'), 'text/javascript']],
          ['/studio-diagnostics.js', [join(options.cwd, 'dist/apps/desktop/src/studio-diagnostics.js'), 'text/javascript']],
          ['/arcane-dialog.js', [join(options.cwd, 'dist/apps/desktop/src/arcane-dialog.js'), 'text/javascript']],
          ['/chat-tabs.js', [join(options.cwd, 'dist/apps/desktop/src/chat-tabs.js'), 'text/javascript']],
          ['/conversation-library.js', [join(options.cwd, 'dist/apps/desktop/src/conversation-library.js'), 'text/javascript']],
          ['/packages/protocol/src/chat-queue.js', [join(options.cwd, 'dist/packages/protocol/src/chat-queue.js'), 'text/javascript']],
          ['/packages/asset-pipeline/src/failure-diagnostics.js', [join(options.cwd, 'dist/packages/asset-pipeline/src/failure-diagnostics.js'), 'text/javascript']],
          ['/packages/asset-pipeline/src/types.js', [join(options.cwd, 'dist/packages/asset-pipeline/src/types.js'), 'text/javascript']],
          ['/packages/asset-pipeline/src/probe-diagnostics.js', [join(options.cwd, 'dist/packages/asset-pipeline/src/probe-diagnostics.js'), 'text/javascript']],
          ['/shared-conversations.js', [join(options.cwd, 'dist/apps/desktop/src/shared-conversations.js'), 'text/javascript']],
          ['/chat-attachments.js', [join(options.cwd, 'dist/apps/desktop/src/chat-attachments.js'), 'text/javascript']],
          ['/task-usage.js', [join(options.cwd, 'dist/apps/desktop/src/task-usage.js'), 'text/javascript']],
          ['/task-usage-ui.js', [join(options.cwd, 'dist/apps/desktop/src/task-usage-ui.js'), 'text/javascript']],
          ['/workspace-shell.js', [join(options.cwd, 'dist/apps/desktop/src/workspace-shell.js'), 'text/javascript']],
          ['/asset-downloads.js', [join(options.cwd, 'dist/apps/desktop/src/asset-downloads.js'), 'text/javascript']],
          ['/asset-review.js', [join(options.cwd, 'dist/apps/desktop/src/asset-review.js'), 'text/javascript']],
          ['/asset-conversation-selection.js', [join(options.cwd, 'dist/apps/desktop/src/asset-conversation-selection.js'), 'text/javascript']],
          ['/asset-viewer.js', [join(options.cwd, 'dist/apps/desktop/src/asset-viewer.js'), 'text/javascript']],
          ['/automatic-asset-previews.js', [join(options.cwd, 'dist/apps/desktop/src/automatic-asset-previews.js'), 'text/javascript']],
          ['/playtest-panel.js', [join(options.cwd, 'dist/apps/desktop/src/playtest-panel.js'), 'text/javascript']],
          ['/toolbox-policy.js', [join(options.cwd, 'dist/apps/desktop/src/toolbox-policy.js'), 'text/javascript']],
          ['/playtest-toggle.js', [join(options.cwd, 'dist/apps/desktop/src/playtest-toggle.js'), 'text/javascript']],
          ['/starter-gallery.js', [join(options.cwd, 'dist/apps/desktop/src/starter-gallery.js'), 'text/javascript']],
          ['/starter-prompts.js', [join(options.cwd, 'dist/apps/desktop/src/starter-prompts.js'), 'text/javascript']],
          ['/welcome-tour.js', [join(options.cwd, 'dist/apps/desktop/src/welcome-tour.js'), 'text/javascript']],
          ['/glb-preflight.js', [join(options.cwd, 'dist/apps/desktop/src/glb-preflight.js'), 'text/javascript']],
          ['/asset-viewer-runtime.mjs', [join(options.cwd, 'apps/desktop/public/asset-viewer-runtime.mjs'), 'text/javascript']],
          ['/effect-viewer-runtime.mjs', [join(options.cwd, 'apps/desktop/public/effect-viewer-runtime.mjs'), 'text/javascript']],
          ...[
            'build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js',
            'examples/jsm/controls/OrbitControls.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js'
          ].map(path => ['/vendor/three/' + path, [join(options.cwd, 'apps/desktop/public/vendor/three', path), 'text/javascript']] as [string, [string, string]]),
          ['/learning-panel.js', [join(options.cwd, 'dist/apps/desktop/src/learning-panel.js'), 'text/javascript']],
          ['/desktop-verification.js', [join(options.cwd, 'dist/apps/desktop/src/desktop-verification.js'), 'text/javascript']],
          ['/provider-setup.js',[join(options.cwd,'dist/apps/desktop/src/provider-setup.js'),'text/javascript']],
          ['/claude-chat.js',[join(options.cwd,'dist/apps/desktop/src/claude-chat.js'),'text/javascript']],
          ['/claude-preferences.js',[join(options.cwd,'dist/apps/desktop/src/claude-preferences.js'),'text/javascript']],
          ['/arcane-chat.js',[join(options.cwd,'dist/apps/desktop/src/arcane-chat.js'),'text/javascript']],
          ['/setup-checklist.js',[join(options.cwd,'dist/apps/desktop/src/setup-checklist.js'),'text/javascript']],
          ['/workspace-topbar.js',[join(options.cwd,'dist/apps/desktop/src/workspace-topbar.js'),'text/javascript']],
          ['/plans.js',[join(options.cwd,'dist/apps/desktop/src/plans.js'),'text/javascript']],
          ['/notifications.js',[join(options.cwd,'dist/apps/desktop/src/notifications.js'),'text/javascript']],
          ['/runtime-recovery.js',[join(options.cwd,'dist/apps/desktop/src/runtime-recovery.js'),'text/javascript']],
    ['/desktop-update.js',[join(options.cwd,'dist/apps/desktop/src/desktop-update.js'),'text/javascript']],
          ['/mesh-keep.js',[join(options.cwd,'dist/apps/desktop/src/mesh-keep.js'),'text/javascript']],
          ['/asset-imports.js',[join(options.cwd,'dist/apps/desktop/src/asset-imports.js'),'text/javascript']],
          ['/editor-drafts.js',[join(options.cwd,'dist/apps/desktop/src/editor-drafts.js'),'text/javascript']],
          ['/project-memory.js',[join(options.cwd,'dist/apps/desktop/src/project-memory.js'),'text/javascript']],
          ['/learned-preferences.js',[join(options.cwd,'dist/apps/desktop/src/learned-preferences.js'),'text/javascript']],
          ['/script-editor-drafts.js',[join(options.cwd,'dist/apps/desktop/src/script-editor-drafts.js'),'text/javascript']],
          ['/script-sync.js',[join(options.cwd,'dist/apps/desktop/src/script-sync.js'),'text/javascript']],
          ['/script-diff.js',[join(options.cwd,'dist/apps/desktop/src/script-diff.js'),'text/javascript']],
          ['/native-handoff.js',[join(options.cwd,'dist/apps/desktop/src/native-handoff.js'),'text/javascript']],
          ['/studio-key-settings.js',[join(options.cwd,'dist/apps/desktop/src/studio-key-settings.js'),'text/javascript']],
          ['/workflow-panel.js',[join(options.cwd,'dist/apps/desktop/src/workflow-panel.js'),'text/javascript']],
          ['/codex-history.js', [join(options.cwd, 'dist/apps/desktop/src/codex-history.js'), 'text/javascript']],
          ['/brand/arcane-ridges.png', [join(options.cwd, 'apps/desktop/public/brand/arcane-ridges.png'), 'image/png']],
          ...[
            'ibm-plex-sans-latin-wght-normal.woff2', 'ibm-plex-sans-latin-ext-wght-normal.woff2',
            'archivo-latin-wght-normal.woff2', 'archivo-latin-ext-wght-normal.woff2',
            'ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-ext-400-normal.woff2',
            'ibm-plex-mono-latin-500-normal.woff2', 'ibm-plex-mono-latin-ext-500-normal.woff2'
          ].map(name => ['/fonts/' + name, [join(options.cwd, 'apps/desktop/public/fonts', name), 'font/woff2']] as [string, [string, string]])
        ] as [string, [string, string]][] : [])
      ]);
      const asset = publicRoutes.get(url.pathname);
      if (asset && request.method === 'GET') {
        const data = await readFile(asset[0]);
        response.writeHead(200, { 'Content-Type': asset[1] + (/^(?:image|font)\//.test(asset[1]) ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(data); return;
      }
      if(plans&&await plans.handle(request,response,url,token,origin))return;
      if(projectMemory&&await projectMemory.handle(request,response,url,token,origin))return;
      if(learnedPreferences&&await learnedPreferences.handle(request,response,url,token,origin))return;
      if(scriptSync&&await scriptSync.handle(request,response,url,token,origin))return;
      if(meshKeep&&await meshKeep.handle(request,response,url,token,origin))return;
      if(imports&&await imports.handle(request,response,url,token,origin))return;
      if(url.pathname==='/v1/playtests/repair'&&await repairPlaytestRecords(request,response))return;
      if(testHistoryApi&&await testHistoryApi(request,response,url,origin))return;
      if(testApi&&await testApi(request,response,url,origin))return;
      if(handoffs&&await handoffs.handle(request,response,url,token,origin))return;
      if(workflowApi&&await workflowApi(request,response,url,token,origin,agentToken))return;
      if (learning && await learning(request,response,url,token,origin,agentToken)) return;
      if (nativeChat && await nativeChat(request,response,url,token,origin,agentToken)) return;
      if (native && await native(request,response,url,token,origin)) return;
      if (scopedAssets && await scopedAssets(request,response,url,origin)) return;
      // A sealed handoff (in-app Claude chat) is admitted only on its allowlisted generic asset routes;
      // native-hook bearers stay on /v1/assets/native via scopedAssets.
      if(modelReviewApi&&await modelReviewApi(request,response,url,token,origin,handoffs?.agentToken(request,origin)||agentToken))return;
      if (assets && await assets(request, response, url, token, origin, handoffs?.agentToken(request,origin) || agentToken)) return;
      if (bridge && await bridge(request, response, url, token, origin)) return;
      const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        send(response, 401, { error: 'AUTH', message: 'Open the session link from the local launcher.' }); return;
      }
      if (request.headers.origin && request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Cross-origin access refused.');
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        send(response, 200, { connections, selection, busy, warnings: stateWarnings, inferenceRuns: 0, inferenceScope: 'metadata-lab-only' }); return;
      }
      if (request.method !== 'POST' || !['/v1/probe', '/v1/selection'].includes(url.pathname)) { send(response, 404, { error: 'NOT_FOUND' }); return; }
      if (request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Writes require the local panel origin.');
      const input = await readJson(request);
      if (url.pathname === '/v1/probe') {
        if (busy) { send(response, 409, { error: 'BUSY', message: 'A metadata probe is already running.' }); return; }
        busy = true;
        try { connections = await (options.probe ?? discoverProviders)(options.cwd); }
        finally { busy = false; }
        send(response, 200, { connections, selection, busy, warnings: stateWarnings, inferenceRuns: 0, inferenceScope: 'metadata-lab-only' }); return;
      }
      if (savedStateFailed) throw new ArcaneError('STATE', 'Saved preference needs manual repair; refusing to overwrite it.');
      const validated = validateSelection(input, connections);
      await store.save(validated); selection = validated;
      send(response, 200, { selection });
    } catch (error) {
      const known = error instanceof ArcaneError;
      const code = known ? error.code : 'INTERNAL';
      const status = code === 'HOST' || code === 'ORIGIN' ? 403 : code === 'STALE_CONNECTION' ? 409 : known ? 400 : 500;
      if (!response.headersSent && !response.destroyed) send(response, status, { error: code, message: known ? error.message : 'Local operation failed; raw account/process output was not logged.' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 32;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); }
  catch (error) {
    testHistoryEpoch++;
    fenceTasks();
    humanAssetSelection.close(); appAssets?.close(); handoffs?.close(); nativeAssetRegistry?.close(); scriptSync?.close();
    ownedSourceVerifier?.dispose();
    try { await ownedTests?.lifecycle.close(); } catch { /* Preserve listener failure/fence. */ }
    try { testReports?.close(); } catch { /* Preserve listener failure. */ }
    try { modelReviews?.close(); } catch { /* Preserve listener failure. */ }
    try { workflow?.close(); } catch { /* Preserve listener failure. */ }
    try { if (ownsAssociations) associations?.close(); } catch { /* Preserve listener failure. */ }
    try { await codex?.close(); } catch { /* Preserve listener failure. */ }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new ArcaneError('SERVER', 'Local server did not bind.');
  origin = 'http://127.0.0.1:' + address.port;
  let cleanup: Promise<void> | null = null;
  return {
    server, origin, token, agentToken, url: origin + (bridge ? '/studio#' : '/#') + token, meshKeep, imports, appAssets,
    close(): Promise<void> {
      if (cleanup) return cleanup;
      shuttingDown = true; testHistoryEpoch++; humanAssetSelection.close(); appAssets?.close(); const fenceErrors = fenceTasks(); handoffs?.close(); nativeAssetRegistry?.close(); ownedSourceVerifier?.dispose(); scriptSync?.close();
      cleanup = (async () => {
        // Quiesce the listener first; all cleanup paths still run on failure.
        const listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          .catch(error => error as Error);
        server.closeAllConnections();
        const errors: unknown[] = [...fenceErrors];
        try { await ownedTests?.lifecycle.close(); } catch (error) { errors.push(error); }
        try { testReports?.close(); } catch (error) { errors.push(error); }
        try { modelReviews?.close(); } catch (error) { errors.push(error); }
        try { await workflow?.closeAsync(); } catch (error) { errors.push(error); }
        try { if (ownsAssociations) associations?.close(); } catch (error) { errors.push(error); }
        try { await codex?.close(); } catch (error) { errors.push(error); }
        const listenerError = await listenerClosed;
        if (listenerError) errors.push(listenerError);
        if (errors.length) throw new ArcaneError('CLEANUP', 'Owned local service cleanup failed; retained state needs inspection.');
      })();
      return cleanup;
    }
  };
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ArcaneError('CONTENT_TYPE', 'Expected JSON.');
  request.setTimeout(8000, () => request.destroy());
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length;
      if (bytes > 16384) throw new ArcaneError('BODY_LIMIT', 'Request is too large.');
      chunks.push(chunk);
    }
  } finally {
    // The body deadline must not become a socket deadline for bounded native
    // metadata discovery after the request body is already complete.
    if (request.socket && !request.socket.destroyed) request.socket.setTimeout(0);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ArcaneError('JSON', 'Invalid JSON request.'); }
}


