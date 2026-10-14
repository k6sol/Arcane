import { workflowCodeHostConfiguration } from './workflow-code-host.js';
import { createLearningService } from './learning-service.js';
import { resolve, join, dirname, relative, isAbsolute, sep, parse } from 'node:path';
import { mkdir, writeFile, unlink, readFile, lstat, realpath, opendir } from 'node:fs/promises';
import { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../../packages/storage/src/work-store.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { createConnectionLab } from './lab-server.js';
import { createAssetService } from './asset-service.js';
import { createStudioImportHost } from './studio-import-host.js';
import { createStudioImportPreparationStore } from './studio-import-preparation-store.js';
import { studioImportPluginArtifactHash } from './studio-import-plugin-artifact.js';
async function cleanupStartup(services: Array<() => void | Promise<void>>): Promise<void> {
  // Preserve the startup error, but do not leave another owned store locked
  // merely because one earlier service failed to close.
  for (const close of services) { try { await close(); } catch { /* Keep the original startup failure. */ } }
}
// The desktop host keeps immutable application resources separate from its owned writable cwd.
// These environment values come only from a trusted local launcher, never HTTP/MCP input.
const runtimeRoot = resolve(process.cwd());
const workflowCodeVerification = workflowCodeHostConfiguration(process.env);
const resourceOverride = process.env.ARCANE_RESOURCE_DIRECTORY;
const cwd = resourceOverride === undefined ? runtimeRoot : resolve(resourceOverride);
const stateOverride = process.env.ARCANE_STATE_DIRECTORY;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
};
async function directStateDirectory(path: string): Promise<void> {
  let current = path;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
        throw new Error('ARCANE_STATE_DIRECTORY cannot contain links or redirected directories.');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function validatedStateDirectory(value: string): Promise<string> {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) {
    throw new Error('ARCANE_STATE_DIRECTORY must be an absolute local directory inside Arcane/runtime.');
  }
  const root = parse(value).root;
  const parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (parts.some(part => part === '.' || part === '..') || (process.platform === 'win32' &&
      (!/^[a-z]:[\\/]$/i.test(root) || parts.some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw new Error('ARCANE_STATE_DIRECTORY contains an unsafe path segment.');
  }
  const path = resolve(value), runtime = join(runtimeRoot, 'runtime');
  if (!inside(runtime, path)) throw new Error('ARCANE_STATE_DIRECTORY must stay strictly inside Arcane/runtime.');
  await directStateDirectory(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await directStateDirectory(path);
  const physicalRuntime = await realpath(runtime), physicalPath = await realpath(path);
  if (!inside(physicalRuntime, physicalPath)) throw new Error('ARCANE_STATE_DIRECTORY resolves outside Arcane/runtime.');
  // Inspect only owned state metadata, never project files or credential contents.
  // Reject nested links, non-regular files and hardlinked databases/descriptors too.
  let entries = 0;
  async function inspect(directory: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Arcane runtime state exceeds the validation depth limit.');
    for await (const entry of await opendir(directory)) {
      if (++entries > 4096) throw new Error('Arcane runtime state exceeds the validation entry limit.');
      const child = join(directory, entry.name), info = await lstat(child);
      if (info.isSymbolicLink() || !samePath(await realpath(child), child) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
        throw new Error('Arcane runtime state cannot contain links or non-regular files.');
      }
      if (info.isDirectory()) await inspect(child, depth + 1);
    }
  }
  await inspect(physicalPath, 0);
  return physicalPath;
}
if (resourceOverride !== undefined) {
  if (!isAbsolute(resourceOverride) || /[\x00-\x1f\x7f]/.test(resourceOverride) || /^(?:\\\\|\/\/)/.test(resourceOverride)) throw new Error('Arcane resource directory must be an absolute local installation.');
  await directStateDirectory(cwd);
  const entry = await lstat(join(cwd, 'dist/apps/daemon/src/product-main.js'));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Arcane resource installation is unavailable.');
}
const directory = stateOverride === undefined ? join(runtimeRoot, 'runtime', 'product') : await validatedStateDirectory(stateOverride);
const connectionDirectory = stateOverride === undefined ? join(runtimeRoot, 'runtime', 'connection-lab') : join(directory, 'connection-lab');
const portText = process.env.ARCANE_PORT;
const port = portText ? Number(portText) : 45871;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ARCANE_PORT must be an integer 0..65535.');
const store = new StudioStore({ directory });
const projectPath = resolve(process.env.ARCANE_PROJECT ?? cwd);
let work: WorkStore;
try { work = new WorkStore({ directory, projectPath }); } catch (error) { await cleanupStartup([() => store.close()]); throw error; }
let associations: ConversationWorkStore;
try {
  associations = new ConversationWorkStore({ directory: join(connectionDirectory, 'conversation-work'), projectPath });
} catch (error) { await cleanupStartup([() => work.close(), () => store.close()]); throw error; }
let assets: Awaited<ReturnType<typeof createAssetService>>;
let preparations: Awaited<ReturnType<typeof createStudioImportPreparationStore>>;
let importHost: ReturnType<typeof createStudioImportHost>;
try {
  const pluginArtifactHash = await studioImportPluginArtifactHash(cwd);
  preparations = await createStudioImportPreparationStore({ projectPath: associations.projectPath,
    directory: join(directory, 'studio-import-preparations'), workAssociations: associations, studio: store });
  try {
    importHost = createStudioImportHost({ projectPath: associations.projectPath, workAssociations: associations, studio: store,
      pluginArtifactHash, persistPreparation: (...args) => preparations.save(...args) });
  } catch (error) { await cleanupStartup([() => preparations.close()]); throw error; }
} catch (error) { await cleanupStartup([() => associations.close(), () => work.close(), () => store.close()]); throw error; }
try {assets=await createAssetService({cwd:runtimeRoot,workerRoot:join(cwd,'workers','blender'),projectPath:associations.projectPath,studioImport:importHost.hooks,...((stateOverride === undefined && resourceOverride === undefined) ? {} : {outputRoot:join(directory,'assets')})});}catch(error){await cleanupStartup([() => importHost.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]);throw error;}
let learning: ReturnType<typeof createLearningService>;
try { learning = createLearningService({ directory: join(directory, 'learning'), projectPath }); }
catch (error) { await cleanupStartup([() => importHost.close(), () => assets.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]); throw error; }
let app: Awaited<ReturnType<typeof createConnectionLab>>;
try { app = await createConnectionLab({ cwd, stateDirectory: connectionDirectory, studioStore: store, workStore: work, conversationWorkStore: associations, assetService: assets, learningService: learning, projectPath:associations.projectPath, port, ...(workflowCodeVerification ? {workflowCodeVerification} : {}) }); }
catch (error) { await cleanupStartup([() => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]); throw error; }
const descriptor = join(directory, 'daemon.json');
try {
  await mkdir(directory, { recursive: true });
  await writeFile(descriptor, JSON.stringify({ origin: app.origin, pid: process.pid, protocolVersion: 1 }) + '\n', { mode: 0o600 });
} catch (error) {
  await cleanupStartup([() => app.close(), () => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]);
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
  const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
  let failed = false;
  // Each resource closes even if an earlier cleanup fails. Never remove another
  // daemon's descriptor or promise a rollback for an interrupted Studio write.
  for (const close of [() => app.close(), () => importHost.close(), () => assets.close(), () => learning.close(), () => preparations.close(), () => associations.close(), () => work.close(), () => store.close()]) {
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
if (process.send) process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && 'protocolVersion' in message &&
      message.type === 'arcane-shutdown' && message.protocolVersion === 1) void shutdown();
});
