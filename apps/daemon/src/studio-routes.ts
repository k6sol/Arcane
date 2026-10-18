import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { object, textField } from '../../../packages/protocol/src/studio.js';
import type { StudioStore } from '../../../packages/storage/src/studio-store.js';
import type { WorkStore, WorkTaskBinding } from '../../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import type { ScriptSourceVerifier } from '../../../packages/core/src/script-source-verifier.js';

/** Fixed loopback port the Studio plugin polls for a pending one-click pairing offer (docs/studio-pairing.md).
 * It listens only while a human-started offer is pending and answers nothing else. */
export const STUDIO_PAIRING_DISCOVERY_PORT = 45870;
export type StudioPairingDiscoveryState = { state: 'idle' | 'listening' | 'unavailable'; port: number | null };
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

function pairingDiscovery(store: StudioStore, fixedPort: number) {
  let server: Server | null = null, bound: number | null = null, daemonPort = 0, unavailable = false;
  let timer: ReturnType<typeof setTimeout> | null = null, starting: Promise<void> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer); timer = null;
    const owned = server; server = null; bound = null;
    if (owned) { owned.close(() => {}); owned.closeAllConnections(); }
  };
  // Close as soon as the offer is no longer pending; otherwise re-check at its expiry.
  const sync = () => {
    const offer = store.pairingOffer();
    // A challenged offer (its plugin is mid-pairing) also closes discovery.
    if (!offer || offer.state !== 'pending' || !store.pairingDiscovery(daemonPort)) { stop(); return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(sync, Math.max(50, Date.parse(offer.expiresAt) - Date.now() + 50)); timer.unref();
  };
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, payload: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); response.end(JSON.stringify(payload)); };
    // Only a credential-free, loopback, non-browser POST. Browsers send Origin on a cross-origin POST,
    // and a JSON content type forces a preflight this listener never approves.
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '') || request.headers.host !== '127.0.0.1:' + bound || request.headers.origin !== undefined
      || request.method !== 'POST' || request.url !== '/v1/pairing/discover' || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { request.resume(); send(404, { error: 'NOT_FOUND' }); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    request.setTimeout(4000, () => request.destroy());
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      let body: unknown = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Rejected below. */ }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'protocolVersion' || (body as { protocolVersion: unknown }).protocolVersion !== 1) { send(400, { error: 'INPUT' }); return; }
      const offer = store.pairingDiscovery(daemonPort);
      if (!offer) { send(404, { error: 'NO_OFFER' }); sync(); return; }
      send(200, offer);
    });
  };
  return {
    async start(port: number): Promise<void> {
      daemonPort = port; unavailable = false;
      if (!server) {
        starting ??= new Promise<void>(resolve => {
          const candidate = createServer(handle);
          candidate.requestTimeout = 5000; candidate.headersTimeout = 4000; candidate.maxConnections = 8;
          candidate.once('error', () => { unavailable = true; resolve(); });
          candidate.listen(fixedPort, '127.0.0.1', () => {
            const address = candidate.address();
            server = candidate; bound = address && typeof address !== 'string' ? address.port : null; candidate.unref(); resolve();
          });
        }).finally(() => { starting = null; });
        await starting;
      }
      sync();
    },
    sync, stop,
    state(): StudioPairingDiscoveryState {
      const offer = store.pairingOffer();
      if (!offer || offer.state !== 'pending') return { state: 'idle', port: null };
      return server ? { state: 'listening', port: bound } : { state: unavailable ? 'unavailable' : 'idle', port: null };
    },
  };
}

export function studioRoutes(store: StudioStore, cwd: string, work?: WorkStore, projectPath = cwd, agentToken: string | ((request: IncomingMessage) => string) = '', sourceVerifier: ScriptSourceVerifier | null = null,
  authorizeBoundWork?: (actorId:string,binding:WorkTaskBinding)=>void, pairing: { discoveryPort?: number } = {}) {
  // Canonical host identity, never supplied by a browser/model or inferred from UI text.
  const project = workflowProjectIdentity(projectPath);
  const discovery = pairingDiscovery(store, pairing.discoveryPort ?? STUDIO_PAIRING_DISCOVERY_PORT);
  let attempts: number[] = [];
  const handler = async (request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> => {
    if (!url.pathname.startsWith('/v1/studio/') && !url.pathname.startsWith('/v1/plugin/') && !url.pathname.startsWith('/v1/product/') && !url.pathname.startsWith('/v1/work/')) return false;
    const send = (status: number, payload: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(payload)); };
    try {
      if (request.headers.origin && request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Cross-origin bridge access refused.');
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const plugin = url.pathname.startsWith('/v1/plugin/');
      const matches = (token: string) => token.length > 0 && Buffer.byteLength(bearer) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(bearer), Buffer.from(token));
      const expectedAgent = () => typeof agentToken === 'function' ? agentToken(request) : agentToken;
      const human = matches(controlToken); const agent = matches(expectedAgent());
      if (!plugin && !human && !agent) throw new ArcaneError('AUTH', 'Open the local launcher session, or supply its scoped local MCP bearer.');
      const actorId='agent-'+createHash('sha256').update(bearer).digest('hex');
      const authorizeBinding=(binding:WorkTaskBinding):void=>{
        if(human)return;if(!authorizeBoundWork)throw new ArcaneError('SCOPE','Original task work authority is unavailable.');
        try{const result:unknown=authorizeBoundWork(actorId,binding);if(result instanceof Promise)void result.catch(()=>{});
          if(result!==undefined)throw new Error('asynchronous authority');
        }catch{throw new ArcaneError('SCOPE','This evidence run belongs to another original native task or is no longer active.');}
      };
      const boundAllowed=(runId:string):boolean=>{
        const binding=work!.bindingForRun(runId);if(!binding||human)return true;
        try{authorizeBinding(binding);return true;}catch{return false;}
      };
      const requireBound=(runId:string):void=>{if(!boundAllowed(runId))throw new ArcaneError('SCOPE','This evidence run belongs to another original native task or is no longer active.');};
      if (agent && ['/v1/studio/pairing', '/v1/studio/pairing-offer', '/v1/studio/pairing-offer/cancel', '/v1/studio/pairing-offer/decide', '/v1/studio/revoke', '/v1/studio/keys', '/v1/studio/keys/rotate', '/v1/studio/keys/revoke', '/v1/work/review', '/v1/product/mcp-token'].includes(url.pathname)) throw new ArcaneError('SCOPE', 'Agent bearer cannot grant Studio access, revoke human sessions or approve work. Use the human panel.');
      // Live Studio output is shown to the person in the dock; it is not an agent read surface.
      if (url.pathname === '/v1/studio/diagnostics' || url.pathname === '/v1/studio/diagnostics/clear') { if (!human) throw new ArcaneError('SCOPE', 'Studio diagnostics are available to the local launcher session only.'); }
      if (url.pathname.startsWith('/v1/studio/pairing-offer') && !human) throw new ArcaneError('SCOPE', 'Studio pairing is available to the local launcher session only.');
      // A script change view shows full before/after sources to the person only; models read scripts through their granted tools.
      if (url.pathname.startsWith('/v1/studio/script-diff/') && !human) throw new ArcaneError('SCOPE', 'Script change views are available to the local launcher session only.');
      if (request.method === 'GET' && !plugin) {
        if (work && url.pathname === '/v1/work/runs') { send(200, { runs: human?work.runs():work.runsReadOnly().filter(run=>boundAllowed(run.id)) }); return true; }
        if (work && url.pathname.startsWith('/v1/work/runs/')) {
          const runId=url.pathname.slice('/v1/work/runs/'.length);
          if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)||url.search)throw new ArcaneError('INPUT','Choose one recorded work run.');
          requireBound(runId);send(200,{run:work.runById(runId)});return true;
        }
        if (work && url.pathname === '/v1/work/ready') {
          const runId=url.searchParams.get('runId')??undefined;if(runId)requireBound(runId);
          send(200, { tasks: human?work.ready(runId):work.readyReadOnly(runId).filter(task=>boundAllowed(task.runId)) }); return true;
        }
        if (url.pathname === '/v1/studio/keys') { send(200, {keys:store.keys()}); return true; }
        if (url.pathname === '/v1/studio/pairing-offer' && !url.search) { discovery.sync(); send(200, { offer: store.pairingOffer(), discovery: discovery.state() }); return true; }
        if (url.pathname === '/v1/studio/sessions') { send(200, { sessions: store.sessions() }); return true; }
        if (url.pathname === '/v1/studio/diagnostics' && !url.search) { send(200, { diagnostics: store.diagnostics() }); return true; }
        if (url.pathname === '/v1/studio/commands') { send(200, { commands: store.commands(url.searchParams.get('sessionId') ?? undefined) }); return true; }
        if (url.pathname.startsWith('/v1/studio/script-diff/')) {
          const id = decodeURIComponent(url.pathname.slice('/v1/studio/script-diff/'.length));
          if (url.search || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ArcaneError('INPUT', 'Choose one recorded script edit.');
          send(200, { change: store.scriptChange(id) }); return true;
        }
        if (url.pathname.startsWith('/v1/studio/commands/')) { send(200, { command: store.command(textField(decodeURIComponent(url.pathname.slice('/v1/studio/commands/'.length)), 'command ID')) }); return true; }
        if (url.pathname === '/v1/product/events') { send(200, { events: store.events() }); return true; }
        if (url.pathname === '/v1/product/state') {
          let buildTasks: unknown[] = [];
          try { const board = JSON.parse(await readFile(join(cwd, 'docs/build/tasks.json'), 'utf8')) as { tasks: unknown[] }; buildTasks = board.tasks; } catch { /* Optional authored board is not a connected task runtime. */ }
          send(200, { projectPath: project.projectPath, projectId: project.projectId, protocolVersion: 1, studioSessions: store.sessions(), commandCounts: store.counts(), buildTasks,
            features: [
              { id: 'studio-bridge', state: 'implemented-local', verified: 'automated bridge/controller fixtures; native installed-plugin acceptance deferred by user' },
              { id: 'native-providers', state: 'metadata-only', verified: 'native CLI metadata probes; inference not enabled' },
              { id: 'skill-pack', state: 'experimental', verified: 'integrity tests; no behavior-approved skills' },
              { id: 'task-workflows', state: work ? 'implemented-local' : 'not-enabled', verified: 'durable graph, cooperative leases and hashed evidence; not an OS sandbox' },
              { id: 'blender', state: 'implemented-local-templates', verified: 'real installed Blender generation/export of two starter templates; custom assets/import verification remain open' }
            ] }); return true;
        }
        send(404, { error: 'NOT_FOUND', message: 'Unknown bridge endpoint.' }); return true;
      }
      if (request.method !== 'POST') { send(405, { error: 'METHOD', message: 'Expected POST.' }); return true; }
      if (['/v1/plugin/pair','/v1/plugin/connect','/v1/plugin/status','/v1/plugin/pairing/challenge','/v1/plugin/pairing/claim'].includes(url.pathname)) {
        const now = Date.now(); attempts = attempts.filter(t => now - t < 60000);
        if (attempts.length >= 30) { send(429, { error: 'RATE_LIMIT', message: 'Pairing rate limit; wait one minute.' }); return true; }
        attempts.push(now);
      }
      if (['/v1/work/review', '/v1/product/mcp-token'].includes(url.pathname) && (!human || request.headers.origin !== origin)) throw new ArcaneError('ORIGIN', 'Human review/token handoff requires the local browser panel origin.');
      const input = await readBridgeJson(request);
      if (agent && !matches(expectedAgent())) throw new ArcaneError('SCOPE', 'The native agent connection changed before its operation.');
      const a = object(input);
      const activationGuard = () => {
        if (response.destroyed || (agent && !matches(expectedAgent()))) throw new ArcaneError('SCOPE', 'The native connection changed before its operation.');
      };
      if (url.pathname === '/v1/product/mcp-token') { send(200, { token: expectedAgent(), scopes: ['studio-granted-commands', 'work-coordination', 'fixed-template-assets'], canReview: false, expires: 'daemon lifetime' }); return true; }
      if (plugin) {
        if (url.pathname === '/v1/plugin/status') {send(200,store.connectionStatusWithKey(a,Number(new URL(origin).port)));return true;}
        if (url.pathname === '/v1/plugin/connect') {send(200,store.connectWithKey(a,Number(new URL(origin).port)));return true;}
        if (url.pathname === '/v1/plugin/pair') { send(200, store.pair(a)); return true; }
        if (url.pathname === '/v1/plugin/pairing/challenge') {
          if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw new ArcaneError('ORIGIN', 'Studio pairing accepts loopback requests only.');
          // A challenged offer stops answering discovery; a second challenge burns it.
          try { send(200, store.challengePairingOffer(a, Number(new URL(origin).port), project.projectId)); } finally { discovery.sync(); }
          return true;
        }
        if (url.pathname === '/v1/plugin/pairing/claim') {
          if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw new ArcaneError('ORIGIN', 'Studio pairing accepts loopback requests only.');
          try { send(200, store.claimPairingOffer(a, Number(new URL(origin).port), project.projectId)); } finally { discovery.sync(); }
          return true;
        }
        const sessionId = textField(a.sessionId, 'session ID'); store.authenticate(sessionId, bearer);
        if (url.pathname === '/v1/plugin/poll') {
          const commands=store.poll(sessionId,a.observation,a.executingCommand);
          if(a.executingCommand!==undefined){
            const command=store.command(textField(object(a.executingCommand).commandId,'executing command ID')),proof=store.session(sessionId).proof!;
            send(200,{commands,progress:{commandId:command.id,leaseEpoch:command.leaseEpoch,observedAt:proof.observedAt,expiresAt:proof.expiresAt}});
          }else{
            // Display-only diagnostics never change dispatch, and a malformed report never fails the poll.
            if(a.diagnostics!==undefined)try{store.recordDiagnostics(sessionId,a.diagnostics);}catch{/* Dropped whole. */}
            send(200,{commands});
          }
        }
        else if (url.pathname === '/v1/plugin/result') { store.result(a); send(200, { accepted: true }); }
        else if (url.pathname === '/v1/plugin/disconnect') { store.revoke(sessionId); send(200, { revoked: true }); }
        else send(404, { error: 'NOT_FOUND', message: 'Unknown plugin endpoint.' });
        return true;
      }
      if (work && url.pathname.startsWith('/v1/work/')) {
        if(agent&&['/v1/work/claim','/v1/work/progress','/v1/work/submit'].includes(url.pathname))requireBound(work.task(textField(a.taskId,'task ID')).runId);
        if (url.pathname === '/v1/work/create') send(200, { run: work.create(a) });
        else if (url.pathname === '/v1/work/claim') send(200, work.claim(a,agent?authorizeBinding:undefined));
        else if (url.pathname === '/v1/work/progress') send(200, { task: work.progress(a,agent?authorizeBinding:undefined) });
        else if (url.pathname === '/v1/work/submit') send(200, { task: work.submit(a,agent?authorizeBinding:undefined) });
        else if (url.pathname === '/v1/work/review') send(200, { task: work.review(a) });
        else send(404, { error: 'NOT_FOUND', message: 'Unknown work endpoint.' });
        return true;
      }
      if (url.pathname === '/v1/studio/keys') send(200,store.issueKey(a,Number(new URL(origin).port)));
      else if (url.pathname === '/v1/studio/keys/rotate') send(200,store.rotateKey(a,Number(new URL(origin).port)));
      else if (url.pathname === '/v1/studio/keys/revoke') {store.revokeKey(textField(a.keyId,'key ID'));send(200,{revoked:true});}
      else if (url.pathname === '/v1/studio/pairing') send(200, store.createGrant(a));
      else if (url.pathname === '/v1/studio/pairing-offer') { const port = Number(new URL(origin).port); const offer = store.createPairingOffer(a, port, project.projectId); await discovery.start(port); send(200, { offer, discovery: discovery.state() }); }
      else if (url.pathname === '/v1/studio/pairing-offer/decide') { const offer = store.decidePairingOffer(a); discovery.sync(); send(200, { offer, discovery: discovery.state() }); }
      else if (url.pathname === '/v1/studio/pairing-offer/cancel') { if (Object.keys(a).length) throw new ArcaneError('INPUT', 'Cancelling a pairing offer requires an empty object.'); const cancelled = store.cancelPairingOffer(); discovery.sync(); send(200, { cancelled }); }
      else if (url.pathname === '/v1/studio/diagnostics/clear') { send(200, { cleared: store.clearDiagnostics(a.sessionId === undefined ? undefined : textField(a.sessionId, 'session ID')) }); }
      else if (url.pathname === '/v1/studio/revoke') { store.revoke(textField(a.sessionId, 'session ID')); send(200, { revoked: true }); }
      else if (url.pathname === '/v1/studio/commands') send(200, { command: await store.enqueueVerified(a, sourceVerifier, activationGuard) });
      else if (url.pathname === '/v1/studio/restore') send(200, { command: await store.restoreVerified(a, sourceVerifier, activationGuard) });
      else send(404, { error: 'NOT_FOUND', message: 'Unknown bridge endpoint.' });
    } catch (error) {
      const known = error instanceof ArcaneError; const code = known ? error.code : 'INTERNAL';
      const status = ['AUTH','KEY_REJECTED'].includes(code) ? 401 : ['ORIGIN', 'SCOPE', 'READ_ONLY'].includes(code) ? 403 : code === 'BUSY' ? 429 : ['RECEIPT_CONFLICT', 'IDEMPOTENCY', 'RECONCILIATION', 'REVOKED', 'COMMAND_STATE', 'SESSION_OFFLINE'].includes(code) ? 409 : known ? 400 : 500;
      if (!response.destroyed && !response.headersSent) send(status, { error: code, message: known ? error.message : 'Local bridge operation failed; inspect local receipts. Provider credentials are not involved.' });
    }
    return true;
  };
  return Object.assign(handler, { closePairing: (): void => discovery.stop() });
}
async function readBridgeJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ArcaneError('CONTENT_TYPE', 'Expected application/json.');
  request.setTimeout(8000, () => request.destroy());
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const raw of request) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string); bytes += chunk.length; if (bytes > 600 * 1024) throw new ArcaneError('BODY_LIMIT', 'Bridge body too large.'); chunks.push(chunk); }
  } finally { if (!request.socket.destroyed) request.socket.setTimeout(0); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ArcaneError('JSON', 'Invalid bridge JSON.'); }
}

