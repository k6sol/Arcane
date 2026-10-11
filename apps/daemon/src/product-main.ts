import { resolve, join } from 'node:path';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../../packages/storage/src/work-store.js';
import { createConnectionLab } from './lab-server.js';
import { createAssetService } from './asset-service.js';
const cwd = resolve(process.cwd());
const directory = join(cwd, 'runtime', 'product');
const portText = process.env.ARCANE_PORT;
const port = portText ? Number(portText) : 45871;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ARCANE_PORT must be an integer 0..65535.');
const store = new StudioStore({ directory });
const projectPath = resolve(process.env.ARCANE_PROJECT ?? cwd);
let work: WorkStore;
try { work = new WorkStore({ directory, projectPath }); } catch (error) { store.close(); throw error; }
let assets: Awaited<ReturnType<typeof createAssetService>>;
try {assets=await createAssetService({cwd,projectPath});}catch(error){work.close();store.close();throw error;}
let app;
try { app = await createConnectionLab({ cwd, stateDirectory: join(cwd, 'runtime', 'connection-lab'), studioStore: store, workStore: work, assetService: assets, projectPath, port }); }
catch (error) { await assets.close(); work.close(); store.close(); throw error; }
await mkdir(directory, { recursive: true });
const descriptor = join(directory, 'daemon.json');
await writeFile(descriptor, JSON.stringify({ origin: app.origin, pid: process.pid, protocolVersion: 1 }) + '\n', { mode: 0o600 });
console.log('Arcane local Studio workbench. An explicit Studio API-key connection and write grant are required before edits.');
console.log('Open locally: ' + app.origin + '/studio#' + app.token);
console.log('Provider metadata: ' + app.url);
console.log('Plugin daemon URL: ' + app.origin);
console.log('Native MCP: obtain the scoped agent token in the workbench. Set ARCANE_DAEMON_URL and ARCANE_LOCAL_TOKEN in your own terminal. Never use a provider credential.');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  let failed = false;
  // Each resource closes even if an earlier cleanup fails. Never remove another
  // daemon's descriptor or promise a rollback for an interrupted Studio write.
  for (const close of [() => app.close(), () => assets.close(), () => work.close(), () => store.close()]) {
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
if (process.send) process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && 'protocolVersion' in message &&
      message.type === 'arcane-shutdown' && message.protocolVersion === 1) void shutdown();
});
