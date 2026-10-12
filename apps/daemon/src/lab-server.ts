import { learningRoutes } from './learning-routes.js';
import type { LearningService } from './learning-service.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArcaneError, type Connection, type Selection } from '../../../packages/protocol/src/providers.js';
import { validateSelection, SelectionStore } from '../../../packages/core/src/selection.js';
import { discoverProviders } from '../../../packages/model-adapters/src/discovery.js';
import type { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { studioRoutes } from './studio-routes.js';
import type { WorkStore } from '../../../packages/storage/src/work-store.js';
import type { AssetService } from './asset-service.js';
import { assetRoutes } from './asset-routes.js';
import { nativeRoutes } from './native-routes.js';
import { createCodexService, type CodexService } from './codex-service.js';
import { codexRoutes } from './codex-routes.js';

interface Options {
  cwd: string;
  stateDirectory: string;
  probe?: (cwd: string) => Promise<Connection[]>;
  studioStore?: StudioStore;
  workStore?: WorkStore;
  projectPath?: string;
  port?: number;
  assetService?: AssetService;
  /** Owned by the product launcher; absent in metadata-only labs. */
  learningService?: LearningService;
  /** Test-only service seam. Production creates the trusted personal-local service. */
  codexService?: CodexService;
}
export async function createConnectionLab(options: Options) {
  const token = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  const bridge = options.studioStore ? studioRoutes(options.studioStore, options.cwd, options.workStore, options.projectPath, agentToken) : null;
  const native = options.studioStore ? nativeRoutes() : null;
  const learning = options.learningService ? learningRoutes(options.learningService) : null;
  const assets = options.assetService ? assetRoutes(options.assetService) : null;
  const store = new SelectionStore(options.stateDirectory);
  let connections: Connection[] = [];
  let selection: Selection | null = null;
  const stateWarnings: string[] = [];
  let savedStateFailed = false;
  try { selection = await store.read(); } catch { savedStateFailed = true; stateWarnings.push('Saved preference unreadable; original file has not been overwritten. Repair or back it up before saving a new preference.'); }
  let busy = false;
  let origin = '';
  let shuttingDown = false;
  const codex = options.codexService ?? (options.studioStore ? createCodexService({
    directory: join(options.stateDirectory, 'native-codex'), projectPath: options.projectPath ?? options.cwd,
    arcaneMcp: () => ({ nodeExecutable: process.execPath, serverEntry: join(options.cwd,'dist','apps','mcp','src','main.js'),
      projectRoot: options.projectPath ?? options.cwd, daemonUrl: origin, agentToken }),
  }) : null);
  const nativeChat = codex ? codexRoutes(codex) : null;
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  const server = createServer(async (request, response) => {
    if (shuttingDown) { response.writeHead(503, {'Connection': 'close'}); response.end(); return; }
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) throw new ArcaneError('HOST', 'Unexpected local host.');
      const url = new URL(request.url ?? '/', origin);
      const publicRoutes = new Map<string, [string, string]>([
        ['/', [join(options.cwd, 'apps/desktop/public/index.html'), 'text/html']],
        ['/lab.css', [join(options.cwd, 'apps/desktop/public/lab.css'), 'text/css']],
        ['/lab.js', [join(options.cwd, 'dist/apps/desktop/src/lab.js'), 'text/javascript']],
        ...(bridge ? [
          ['/studio', [join(options.cwd, 'apps/desktop/public/studio.html'), 'text/html']],
          ['/studio.css', [join(options.cwd, 'apps/desktop/public/studio.css'), 'text/css']],
          ['/studio.js', [join(options.cwd, 'dist/apps/desktop/src/studio.js'), 'text/javascript']],
          ['/codex-chat.js', [join(options.cwd, 'dist/apps/desktop/src/codex-chat.js'), 'text/javascript']],
          ['/workspace-shell.js', [join(options.cwd, 'dist/apps/desktop/src/workspace-shell.js'), 'text/javascript']],
          ['/asset-downloads.js', [join(options.cwd, 'dist/apps/desktop/src/asset-downloads.js'), 'text/javascript']],
          ['/learning-panel.js', [join(options.cwd, 'dist/apps/desktop/src/learning-panel.js'), 'text/javascript']],
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
      if (learning && await learning(request,response,url,token,origin,agentToken)) return;
      if (nativeChat && await nativeChat(request,response,url,token,origin,agentToken)) return;
      if (native && await native(request,response,url,token,origin)) return;
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
  catch (error) { await codex?.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new ArcaneError('SERVER', 'Local server did not bind.');
  origin = 'http://127.0.0.1:' + address.port;
  return {
    server, origin, token, agentToken, url: origin + '/#' + token,
    async close() {
      shuttingDown = true;
      // Quiesce the listener and sockets before awaiting native child cleanup.
      const listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())).catch(error => error as Error);
      server.closeAllConnections();
      try { await codex?.close(); } finally { const error = await listenerClosed; if (error) throw error; }
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


