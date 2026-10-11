import { resolve, join } from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
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
console.log('Arcane local Studio workbench. Explicit Studio pairing is required before edits.');
console.log('Open locally: ' + app.origin + '/studio#' + app.token);
console.log('Provider metadata: ' + app.url);
console.log('Plugin daemon URL: ' + app.origin);
console.log('Native MCP: obtain the scoped agent token in the workbench. Set ARCANE_DAEMON_URL and ARCANE_LOCAL_TOKEN in your own terminal. Never use a provider credential.');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (closing) return; closing = true;
  void app.close().finally(async () => { await assets.close(); work.close(); store.close(); await unlink(descriptor).catch(() => {}); process.exit(0); });
});
