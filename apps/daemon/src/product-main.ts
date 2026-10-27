import { workflowCodeHostConfiguration } from './workflow-code-host.js';
import { createLearningService } from './learning-service.js';
import { resolve, join, isAbsolute, basename, dirname } from 'node:path';
import { mkdir, writeFile, unlink, readFile, lstat } from 'node:fs/promises';
import { directStateDirectory, validatedStateDirectory } from './state-directory-validation.js';
import { reportStartupFailure, type StartupPhase } from './startup-failure.js';
import { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../../packages/storage/src/work-store.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { createConnectionLab } from './lab-server.js';
import { createAssetService } from './asset-service.js';
import {routeAppAssetMessage} from './app-asset-control.js';
import {createDiagnosticReporter} from './diagnostic-reporter.js';
const diagnosticReporter=createDiagnosticReporter();
import {createAssetReviewHost,type AssetReviewHost} from './asset-review-host.js';
import {assetReviewFailure,type AssetReviewGate} from './asset-review.js';
import { createStudioImportHost } from './studio-import-host.js';
import {createStudioImportStagingController} from './studio-import-staging-controller.js';
import { createStudioImportPreparationStore } from './studio-import-preparation-store.js';
import { studioImportPluginArtifactHash } from './studio-import-plugin-artifact.js';
async function cleanupStartup(services: Array<() => void | Promise<void>>): Promise<void> {
  // Preserve the startup error, but do not leave another owned store locked
  // merely because one earlier service failed to close.
  for (const close of services) { try { await close(); } catch { /* Keep the original startup failure. */ } }
}
async function startupFailed(phase: StartupPhase, error: unknown, services: Array<() => void | Promise<void>> = []): Promise<void> {
  // Close owned services first, then send only a fixed code. Callers rethrow the original error.
  await cleanupStartup(services);
  await reportStartupFailure(phase, error);
  diagnosticReporter.close();
}
// The desktop host keeps immutable application resources separate from its owned writable cwd.
// These environment values come only from a trusted local launcher, never HTTP/MCP input.
const runtimeRoot = resolve(process.cwd());
const workflowCodeVerification = workflowCodeHostConfiguration(process.env);
const resourceOverride = process.env.ARCANE_RESOURCE_DIRECTORY;
const cwd = resourceOverride === undefined ? runtimeRoot : resolve(resourceOverride);
const stateOverride = process.env.ARCANE_STATE_DIRECTORY;
if (resourceOverride !== undefined) {
  try {
    if (!isAbsolute(resourceOverride) || /[\x00-\x1f\x7f]/.test(resourceOverride) || /^(?:\\\\|\/\/)/.test(resourceOverride)) throw new Error('Arcane resource directory must be an absolute local installation.');
    await directStateDirectory(cwd);
    const entry = await lstat(join(cwd, 'dist/apps/daemon/src/product-main.js'));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Arcane resource installation is unavailable.');
  } catch (error) { await startupFailed('resources', error); throw error; }
}
let directory: string;
try { directory = stateOverride === undefined ? join(runtimeRoot, 'runtime', 'product') : await validatedStateDirectory(stateOverride, runtimeRoot); }
catch (error) { await startupFailed('state', error); throw error; }
const connectionDirectory = stateOverride === undefined ? join(runtimeRoot, 'runtime', 'connection-lab') : join(directory, 'connection-lab');
const portText = process.env.ARCANE_PORT;
const port = portText ? Number(portText) : 45871;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  const error = new Error('ARCANE_PORT must be an integer 0..65535.'); await startupFailed('services', error); throw error;
}
let store: StudioStore;
try { store = new StudioStore({ directory }); } catch (error) { await startupFailed('services', error); throw error; }
const projectPath = resolve(process.env.ARCANE_PROJECT ?? cwd);
let work: WorkStore;
try { work = new WorkStore({ directory, projectPath }); } catch (error) { await startupFailed('services', error, [() => store.close()]); throw error; }
let associations: ConversationWorkStore;
try {
  associations = new ConversationWorkStore({ directory: join(connectionDirectory, 'conversation-work'), projectPath });
} catch (error) { await startupFailed('services', error, [() => work.close(), () => store.close()]); throw error; }
let assets: Awaited<ReturnType<typeof createAssetService>>;
let modelReviewHost:AssetReviewHost|null=null;
const modelReview:AssetReviewGate={assertApproved(subject,expected){if(!modelReviewHost)assetReviewFailure('REQUIRED');return modelReviewHost.assertApproved(subject,expected);},assertReference(subject,reference){if(!modelReviewHost)assetReviewFailure('REQUIRED');modelReviewHost.assertReference(subject,reference);}};
let preparations: Awaited<ReturnType<typeof createStudioImportPreparationStore>>;
let importHost: ReturnType<typeof createStudioImportHost>;
let importStaging: ReturnType<typeof createStudioImportStagingController>;
let pluginArtifactHash: string;
try {
  pluginArtifactHash = await studioImportPluginArtifactHash(cwd);
  preparations = await createStudioImportPreparationStore({ projectPath: associations.projectPath,
    directory: join(directory, 'studio-import-preparations'), workAssociations: associations, studio: store });
  try {
    importHost = createStudioImportHost({ projectPath: associations.projectPath, workAssociations: associations, studio: store,
      pluginArtifactHash, persistPreparation: (...args) => preparations.save(...args),
      readPreparation:(actor,jobId,guard,attemptId)=>preparations.get(actor,jobId,guard,attemptId) });
  } catch (error) { await cleanupStartup([() => preparations.close()]); throw error; }
} catch (error) { await startupFailed('services', error, [() => associations.close(), () => work.close(), () => store.close()]); throw error; }
try {assets=await createAssetService({reportFailure:diagnosticReporter.report,cwd:runtimeRoot,workerRoot:join(cwd,'workers','blender'),projectPath:associations.projectPath,modelReview,modelReviewAssociations:associations,studioImport:importHost.hooks,retentionPins:{preparationRecord:jobId=>preparations.hasRecordForJob(jobId),pendingStage:jobId=>store.hasPendingStageWork(associations.projectId,jobId),importCaptured:jobId=>importHost.hasCapturedJob(jobId)},...((stateOverride === undefined && resourceOverride === undefined) ? {} : {outputRoot:join(directory,'assets')})});}catch(error){await startupFailed('services', error, [() => importHost.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]);throw error;}
try {importStaging=createStudioImportStagingController({projectPath: associations.projectPath, workAssociations: associations, studio: store,
  assets, host: importHost.hooks, pluginArtifactHash});}
catch(error){await startupFailed('services', error, [() => importHost.close(), () => assets.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]);throw error;}
// The desktop gives each project <userRoot>/runtime/projects/<key>; the user-wide learned layer sits beside them.
function learnedGlobalDirectory(state: string): string { return basename(dirname(state)) === 'projects' ? join(dirname(dirname(state)), 'learned-preferences') : join(state, 'learned-preferences-global'); }
let learning: ReturnType<typeof createLearningService>;
try { learning = createLearningService({ directory: join(directory, 'learning'), projectPath }); }
catch (error) { await startupFailed('services', error, [() => importStaging.close(), () => importHost.close(), () => assets.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]); throw error; }
let app: Awaited<ReturnType<typeof createConnectionLab>>;
try { app = await createConnectionLab({ cwd, codexReportFailure:diagnosticReporter.report, stateDirectory: connectionDirectory, studioStore: store, workStore: work, conversationWorkStore: associations, assetService: assets, studioImportStaging: importStaging, assetReviewHostFactory:(conversation,selectionEpoch)=>{
  const host=createAssetReviewHost({directory:join(directory,'asset-reviews'),projectPath:associations.projectPath,workAssociations:associations,bindingHuman:jobId=>conversation.bindingHuman(jobId),selectionEpoch,readSubject:(jobId,scope,guard)=>assets.modelReviewSubject(jobId,scope,guard)});
  modelReviewHost=host;let release:()=>void;
  try{release=store.bindAssetModelReview(intent=>{if(!intent.modelReview)assetReviewFailure('REQUIRED');assets.assertReviewedImport(intent.jobId,{projectId:intent.projectId,conversation:intent.conversation},intent.modelReview);});}
  catch(error){modelReviewHost=null;host.close();throw error;}
  return Object.freeze({...host,close(){release();host.close();if(modelReviewHost===host)modelReviewHost=null;}});
}, learningService: learning, projectPath:associations.projectPath, port, preferenceGlobalDirectory: learnedGlobalDirectory(directory), ...(workflowCodeVerification ? {workflowCodeVerification} : {}) }); }
catch (error) { await startupFailed('listen', error, [() => importStaging.close(), () => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]); throw error; }
const descriptor = join(directory, 'daemon.json');
try {
  await mkdir(directory, { recursive: true });
  await writeFile(descriptor, JSON.stringify({ origin: app.origin, pid: process.pid, protocolVersion: 1 }) + '\n', { mode: 0o600 });
} catch (error) {
  await startupFailed('descriptor', error, [() => app.close(), () => importStaging.close(), () => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]);
  throw error;
}
console.log('Arcane local Studio workbench. An explicit Studio API-key connection and write grant are required before edits.');
if (process.send) process.send({ type: 'arcane-ready', protocolVersion: 1, origin: app.origin, token: app.token });
console.log('Open locally: ' + app.origin + '/studio#' + app.token);
console.log('Provider metadata: ' + app.url);
console.log('Plugin daemon URL: ' + app.origin);
console.log('Native MCP: obtain the scoped agent token in the workbench. Set ARCANE_DAEMON_URL and ARCANE_LOCAL_TOKEN in your own terminal. Never use a provider credential.');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Fence private admissions synchronously, before asynchronous resource cleanup.
  app.appAssets?.close();
  const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
  let failed = false;
  // Each resource closes even if an earlier cleanup fails. Never remove another
  // daemon's descriptor or promise a rollback for an interrupted Studio write.
  for (const close of [() => app.close(), () => importStaging.close(), () => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close(), () => diagnosticReporter.close()]) {
    try { await close(); } catch { failed = true; }
  }
  try {
    const current = JSON.parse(await readFile(descriptor, 'utf8')) as { pid?: unknown; origin?: unknown };
    if (current.pid === process.pid && current.origin === app.origin) await unlink(descriptor);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
  if (failed) console.error('Arcane cleanup had an error. Retained runtime state must be inspected before recovery.');
  process.exit(failed ? 1 : 0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
// Private Node parent-child IPC for local wrappers/tests; no HTTP shutdown route,
// shell evaluation, public listener, or browser-controlled process message.
if (process.send) process.once('disconnect', () => { void shutdown(); });
if (process.send && !process.connected) void shutdown();
// Keep this mesh: the desktop main process (the only holder of this channel) delivers the person's trusted-dialog
// consent here; the renderer and agents cannot reach it, so they can never start an upload.
if (process.send) app.meshKeep?.enableConsentChannel();
// Imports: the same private channel carries the desktop host's single-use import consent (asset-import.cjs).
if (process.send) app.imports?.enableConsentChannel();
if (process.send) process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && 'protocolVersion' in message &&
      message.type === 'arcane-shutdown' && message.protocolVersion === 1) void shutdown();
  else if (!closing) {
    if(routeAppAssetMessage(app.appAssets,message,reply=>{
      if(!process.send||!process.connected){app.appAssets?.close();return;}
      process.send(reply,error=>{if(error)app.appAssets?.close();});
    }))return;
    if (app.imports?.acceptConsent(message)) return;
    app.meshKeep?.acceptConsent(message);
  }
});
