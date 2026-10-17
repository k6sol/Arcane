import { createNativeAssetRegistry } from './native-asset-authority.js';
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
import { join } from 'node:path';
import { ArcaneError, type Connection, type Selection } from '../../../packages/protocol/src/providers.js';
import { validateSelection, SelectionStore } from '../../../packages/core/src/selection.js';
import { discoverProviders } from '../../../packages/model-adapters/src/discovery.js';
import type { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { studioRoutes } from './studio-routes.js';
import type { WorkStore } from '../../../packages/storage/src/work-store.js';
import type { AssetService } from './asset-service.js';
import type {createStudioImportStagingController} from './studio-import-staging-controller.js';
import { assetRoutes } from './asset-routes.js';
import { nativeRoutes } from './native-routes.js';
import { createCodexService, type CodexService, type CodexServiceOptions } from './codex-service.js';
import { codexRoutes } from './codex-routes.js';
import {createStudioTestService, type StudioTestService, type NativeTestConnection} from './studio-test-service.js';
import {studioTestRoutes, STUDIO_TEST_HTTP_LIMITS, type StudioTestActorResolver, type StudioTestRouteService} from './studio-test-routes.js';
import { studioImportPluginArtifactHash } from './studio-import-plugin-artifact.js';
import { plansRoutes } from './plans-routes.js';
import { ActionsLedger } from './actions-ledger.js';

const unavailableTestMessages = {
  UNAVAILABLE: 'Playtests are unavailable because the trusted plugin source could not be verified. Repair the local plugin build artifacts and restart Arcane before requesting a test.',
  FENCED: 'Playtests are fenced because the retained test journal could not be safely opened. Have a human inspect and reconcile the retained playtest state before restarting Arcane. Do not delete the journal or writer lock to bypass this fence.',
} as const;

function unavailableStudioTestRoutes(code: keyof typeof unavailableTestMessages, resolveActor: StudioTestActorResolver) {
  const refuse = (): never => { throw new ArcaneError(code, unavailableTestMessages[code]); };
  const service: StudioTestRouteService = {
    requests: { async prepare() { refuse(); }, status: refuse, list: refuse, async cancel() { refuse(); } },
    humanControl: { async approve(_input, guard) { guard(); refuse(); } },
    lifecycle: { async close() {} },
  };
  const route = studioTestRoutes(service, resolveActor);
  const status = code === 'FENCED' ? 409 : 503;
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
  probe?: (cwd: string) => Promise<Connection[]>;
  studioStore?: StudioStore;
  workStore?: WorkStore;
  /** Borrowed canonical store shared with the product's asset service. */
  conversationWorkStore?: ConversationWorkStore;
  projectPath?: string;
  port?: number;
  assetService?: AssetService;
  studioImportStaging?: Pick<ReturnType<typeof createStudioImportStagingController>, 'stage'> & Partial<Pick<ReturnType<typeof createStudioImportStagingController>, 'status'|'reconstruct'|'reconstructionStatus'>>;
  /** Owned by the product launcher; absent in metadata-only labs. */
  learningService?: LearningService;
  /** Test-only service seam. Production creates the trusted personal-local service. */
  codexService?: CodexService;
  /** Trusted/test-only client factory for the owned service; never supplied by HTTP. */
  codexConnect?: CodexServiceOptions['connect'];
  /** Trusted owned worker injection for product composition/fixtures; never HTTP input. */
  codexProposalWorker?: CodexServiceOptions['proposalWorker'];
  /** Explicit trusted launcher configuration. Never supplied by route JSON. Missing means no compiler preflight. */
  workflowCodeVerification?: WorkflowCodeHostConfiguration;
  /** Trusted/test-only borrowed verifier. Never accepted from HTTP or agent data. */
  scriptSourceVerifier?: ScriptSourceVerifier;
  /** Borrowed trusted fixture seam; HTTP can never supply a test backend. */
  studioTestService?: StudioTestService;
  /** Owned native connection factory for trusted process/SDK fixtures only. */
  studioTestConnect?: () => Promise<NativeTestConnection>;
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
    ? createNativeAssetRegistry({projectPath:workflowProjectIdentity(options.projectPath ?? options.cwd).projectPath}) : null;
  const coreAgentToken = (request: IncomingMessage): string => {
    const handoff=handoffs?.agentToken(request,origin);if(handoff)return handoff;
    const value = request.headers.authorization;
    const bearer = typeof value==='string' && /^Bearer [a-f0-9]{64}(?![\s\S])/.test(value) ? value.slice(7) : '';
    return nativeAssetRegistry?.recognizes(bearer) ? bearer : agentToken;
  };
  let bridge: ReturnType<typeof studioRoutes> | null = null;
  let ownedSourceVerifier: ScriptSourceVerifier | null = null;
  let ownedTests: StudioTestService | null = null;
  let testApi: ReturnType<typeof studioTestRoutes> | null = null;
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
    ...(nativeAssetRegistry ? {assetRegistry:nativeAssetRegistry} : {}),
    ...(options.workStore ? {workStore:options.workStore} : {}),
    arcaneMcp: () => ({ nodeExecutable: process.execPath, serverEntry: join(options.cwd,'dist','apps','mcp','src','main.js'),
      projectRoot: options.projectPath ?? options.cwd, daemonUrl: origin, agentToken }),
  }) : null);
  const nativeChat = codex ? codexRoutes(codex, {workflowModels:true}) : null;
  // Arcane actions metering and Plans & credits (informational; never blocks work, never charges).
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
  try {
    if (options.studioStore && options.workflowCodeVerification && !options.scriptSourceVerifier) {
      const directory = join(options.stateDirectory, 'studio-source-verification');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { ownedSourceVerifier = await createScriptSourceVerifier({ compiler:options.workflowCodeVerification.compiler, directory:await realpath(directory) }); }
      catch { /* Failed trusted preflight leaves activation unavailable, never a fallback. */ }
    }
    bridge = options.studioStore ? studioRoutes(options.studioStore, options.cwd, options.workStore, options.projectPath, coreAgentToken, options.scriptSourceVerifier ?? ownedSourceVerifier,
      (actorId,binding)=>{if(!codex?.authorizeBoundWork)throw new ArcaneError('SCOPE','Original native task work authority is unavailable.');codex.authorizeBoundWork(actorId,binding);}) : null;
    if(options.studioStore){
      const resolveTestActor: StudioTestActorResolver = request => {
        const bearer=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):'';
        if(bearer===token)return {kind:'human',id:'human'};
        if(bearer.length>0&&bearer===coreAgentToken(request))return {kind:'agent',id:'agent-'+createHash('sha256').update(bearer).digest('hex')};
        return null;
      };
      let tests=options.studioTestService??null;
      if(!tests){
        let unavailableCode: keyof typeof unavailableTestMessages = 'UNAVAILABLE';
        try{
          // Match the actual loaded Script/ModuleScript identity used by the
          // plugin's continuity proof, rather than a delivery-file checksum.
          const pluginArtifactHash=await studioImportPluginArtifactHash(options.cwd);
          // Once source verification passes, any failed journal initialization
          // is unknown retained state. Never remove its lock or try a fresh ledger.
          unavailableCode='FENCED';
          ownedTests=await createStudioTestService({directory:join(options.stateDirectory,'playtests'),store:options.studioStore,pluginArtifactHash,
            ...(options.studioTestConnect?{connect:options.studioTestConnect}:{}),
            ...(codex?.playtestTasks?{taskPort:codex.playtestTasks}:{})});tests=ownedTests;
        }catch{
          stateWarnings.push(unavailableTestMessages[unavailableCode]);
          testApi=unavailableStudioTestRoutes(unavailableCode,resolveTestActor);
        }
      }
      if(tests){
        testApi=studioTestRoutes(tests,resolveTestActor);
        if(codex?.playtestTasks&&tests.cancelExact&&tests.revalidateExact)codex.attachPlaytestCancellation?.(Object.freeze({cancelExact:tests.cancelExact,revalidateExact:tests.revalidateExact}));
      }
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
      conversation: () => {
        const state = codex?.state(), thread = state?.snapshot?.thread;
        const identity = thread?.configured ? thread : state?.nativeHistory;
        return identity ? { provider: 'codex', threadId: identity.threadId, sessionId: identity.sessionId } : null;
      },
      start: async request => (await options.assetService!.start(request)).jobId,
      startNative: async (request,admission) => (await options.assetService!.start(request,admission)).jobId,
      ...(typeof options.assetService.adoptProjectGlb === 'function' ? {adoptNative: async (request,actor,admission) => (await options.assetService!.adoptProjectGlb(request,actor,admission)).jobId} satisfies Pick<import('./asset-conversation-host.js').AssetConversationHostOptions,'adoptNative'> : {}),
    }) : null;
  } catch (error) {
    // Initialization failure must close every owned resource, without closing
    // the launcher's borrowed WorkStore or masking the original failure.
    fenceTasks();
    handoffs?.close(); nativeAssetRegistry?.close();
    ownedSourceVerifier?.dispose();
    try { await ownedTests?.lifecycle.close(); } catch { /* Preserve original failure/fence. */ }
    try { workflow?.close(); } catch { /* Preserve original failure. */ }
    try { if (ownsAssociations) associations?.close(); } catch { /* Preserve original failure. */ }
    try { await codex?.close(); } catch { /* Preserve original failure. */ }
    throw error;
  }
  const assets = options.assetService ? assetRoutes(options.assetService, conversationAssets ?? undefined) : null;
  const scopedAssets = options.assetService && conversationAssets && nativeAssetRegistry
    ? nativeAssetRoutes(options.assetService,conversationAssets,nativeAssetRegistry,options.studioImportStaging) : null;
  const workflowApi = workflow ? workflowRoutes(workflow) : null;
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
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
          ['/codex-chat.js', [join(options.cwd, 'dist/apps/desktop/src/codex-chat.js'), 'text/javascript']],
          ['/codex-task-plan.js', [join(options.cwd, 'dist/apps/desktop/src/codex-task-plan.js'), 'text/javascript']],
          ['/task-plan-boot.js', [join(options.cwd, 'dist/apps/desktop/src/task-plan-boot.js'), 'text/javascript']],
          ['/studio-diagnostics.js', [join(options.cwd, 'dist/apps/desktop/src/studio-diagnostics.js'), 'text/javascript']],
          ['/arcane-dialog.js', [join(options.cwd, 'dist/apps/desktop/src/arcane-dialog.js'), 'text/javascript']],
          ['/chat-tabs.js', [join(options.cwd, 'dist/apps/desktop/src/chat-tabs.js'), 'text/javascript']],
          ['/chat-attachments.js', [join(options.cwd, 'dist/apps/desktop/src/chat-attachments.js'), 'text/javascript']],
          ['/task-usage.js', [join(options.cwd, 'dist/apps/desktop/src/task-usage.js'), 'text/javascript']],
          ['/task-usage-ui.js', [join(options.cwd, 'dist/apps/desktop/src/task-usage-ui.js'), 'text/javascript']],
          ['/workspace-shell.js', [join(options.cwd, 'dist/apps/desktop/src/workspace-shell.js'), 'text/javascript']],
          ['/asset-downloads.js', [join(options.cwd, 'dist/apps/desktop/src/asset-downloads.js'), 'text/javascript']],
          ['/asset-viewer.js', [join(options.cwd, 'dist/apps/desktop/src/asset-viewer.js'), 'text/javascript']],
          ['/automatic-asset-previews.js', [join(options.cwd, 'dist/apps/desktop/src/automatic-asset-previews.js'), 'text/javascript']],
          ['/playtest-panel.js', [join(options.cwd, 'dist/apps/desktop/src/playtest-panel.js'), 'text/javascript']],
          ['/playtest-toggle.js', [join(options.cwd, 'dist/apps/desktop/src/playtest-toggle.js'), 'text/javascript']],
          ['/glb-preflight.js', [join(options.cwd, 'dist/apps/desktop/src/glb-preflight.js'), 'text/javascript']],
          ['/asset-viewer-runtime.mjs', [join(options.cwd, 'apps/desktop/public/asset-viewer-runtime.mjs'), 'text/javascript']],
          ...[
            'build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js',
            'examples/jsm/controls/OrbitControls.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js'
          ].map(path => ['/vendor/three/' + path, [join(options.cwd, 'apps/desktop/public/vendor/three', path), 'text/javascript']] as [string, [string, string]]),
          ['/learning-panel.js', [join(options.cwd, 'dist/apps/desktop/src/learning-panel.js'), 'text/javascript']],
          ['/desktop-verification.js', [join(options.cwd, 'dist/apps/desktop/src/desktop-verification.js'), 'text/javascript']],
          ['/provider-setup.js',[join(options.cwd,'dist/apps/desktop/src/provider-setup.js'),'text/javascript']],
          ['/claude-chat.js',[join(options.cwd,'dist/apps/desktop/src/claude-chat.js'),'text/javascript']],
          ['/setup-checklist.js',[join(options.cwd,'dist/apps/desktop/src/setup-checklist.js'),'text/javascript']],
          ['/plans.js',[join(options.cwd,'dist/apps/desktop/src/plans.js'),'text/javascript']],
          ['/notifications.js',[join(options.cwd,'dist/apps/desktop/src/notifications.js'),'text/javascript']],
          ['/native-handoff.js',[join(options.cwd,'dist/apps/desktop/src/native-handoff.js'),'text/javascript']],
          ['/studio-key-settings.js',[join(options.cwd,'dist/apps/desktop/src/studio-key-settings.js'),'text/javascript']],
          ['/workflow-panel.js',[join(options.cwd,'dist/apps/desktop/src/workflow-panel.js'),'text/javascript']],
          ['/codex-history.js', [join(options.cwd, 'dist/apps/desktop/src/codex-history.js'), 'text/javascript']],
          ['/brand/arcane-ridges.png', [join(options.cwd, 'apps/desktop/public/brand/arcane-ridges.png'), 'image/png']]
        ] as [string, [string, string]][] : [])
      ]);
      const asset = publicRoutes.get(url.pathname);
      if (asset && request.method === 'GET') {
        const data = await readFile(asset[0]);
        response.writeHead(200, { 'Content-Type': asset[1] + (asset[1].startsWith('image/') ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(data); return;
      }
      if(plans&&await plans.handle(request,response,url,token,origin))return;
      if(testApi&&await testApi(request,response,url,origin))return;
      if(handoffs&&await handoffs.handle(request,response,url,token,origin))return;
      if(workflowApi&&await workflowApi(request,response,url,token,origin,agentToken))return;
      if (learning && await learning(request,response,url,token,origin,agentToken)) return;
      if (nativeChat && await nativeChat(request,response,url,token,origin,agentToken)) return;
      if (native && await native(request,response,url,token,origin)) return;
      if (scopedAssets && await scopedAssets(request,response,url,origin)) return;
      if (assets && await assets(request, response, url, token, origin, agentToken)) return;
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
    fenceTasks();
    handoffs?.close(); nativeAssetRegistry?.close();
    ownedSourceVerifier?.dispose();
    try { await ownedTests?.lifecycle.close(); } catch { /* Preserve listener failure/fence. */ }
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
    server, origin, token, agentToken, url: origin + (bridge ? '/studio#' : '/#') + token,
    close(): Promise<void> {
      if (cleanup) return cleanup;
      shuttingDown = true; const fenceErrors = fenceTasks(); handoffs?.close(); nativeAssetRegistry?.close(); ownedSourceVerifier?.dispose();
      cleanup = (async () => {
        // Quiesce the listener first; all cleanup paths still run on failure.
        const listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          .catch(error => error as Error);
        server.closeAllConnections();
        const errors: unknown[] = [...fenceErrors];
        try { await ownedTests?.lifecycle.close(); } catch (error) { errors.push(error); }
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


