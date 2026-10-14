import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { object, textField } from '../../../packages/protocol/src/studio.js';
import type { StudioStore } from '../../../packages/storage/src/studio-store.js';
import type { WorkStore } from '../../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import type { ScriptSourceVerifier } from '../../../packages/core/src/script-source-verifier.js';

export function studioRoutes(store: StudioStore, cwd: string, work?: WorkStore, projectPath = cwd, agentToken: string | ((request: IncomingMessage) => string) = '', sourceVerifier: ScriptSourceVerifier | null = null) {
  // Canonical host identity, never supplied by a browser/model or inferred from UI text.
  const project = workflowProjectIdentity(projectPath);
  let attempts: number[] = [];
  return async (request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> => {
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
      if (agent && ['/v1/studio/pairing', '/v1/studio/revoke', '/v1/studio/keys', '/v1/studio/keys/rotate', '/v1/studio/keys/revoke', '/v1/work/review', '/v1/product/mcp-token'].includes(url.pathname)) throw new ArcaneError('SCOPE', 'Agent bearer cannot grant Studio access, revoke human sessions or approve work. Use the human panel.');
      if (request.method === 'GET' && !plugin) {
        if (work && url.pathname === '/v1/work/runs') { send(200, { runs: work.runs() }); return true; }
        if (work && url.pathname === '/v1/work/ready') { send(200, { tasks: work.ready(url.searchParams.get('runId') ?? undefined) }); return true; }
        if (url.pathname === '/v1/studio/keys') { send(200, {keys:store.keys()}); return true; }
        if (url.pathname === '/v1/studio/sessions') { send(200, { sessions: store.sessions() }); return true; }
        if (url.pathname === '/v1/studio/commands') { send(200, { commands: store.commands(url.searchParams.get('sessionId') ?? undefined) }); return true; }
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
      if (['/v1/plugin/pair','/v1/plugin/connect','/v1/plugin/status'].includes(url.pathname)) {
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
        const sessionId = textField(a.sessionId, 'session ID'); store.authenticate(sessionId, bearer);
        if (url.pathname === '/v1/plugin/poll') send(200, { commands: store.poll(sessionId, a.observation) });
        else if (url.pathname === '/v1/plugin/result') { store.result(a); send(200, { accepted: true }); }
        else if (url.pathname === '/v1/plugin/disconnect') { store.revoke(sessionId); send(200, { revoked: true }); }
        else send(404, { error: 'NOT_FOUND', message: 'Unknown plugin endpoint.' });
        return true;
      }
      if (work && url.pathname.startsWith('/v1/work/')) {
        if (url.pathname === '/v1/work/create') send(200, { run: work.create(a) });
        else if (url.pathname === '/v1/work/claim') send(200, work.claim(a));
        else if (url.pathname === '/v1/work/progress') send(200, { task: work.progress(a) });
        else if (url.pathname === '/v1/work/submit') send(200, { task: work.submit(a) });
        else if (url.pathname === '/v1/work/review') send(200, { task: work.review(a) });
        else send(404, { error: 'NOT_FOUND', message: 'Unknown work endpoint.' });
        return true;
      }
      if (url.pathname === '/v1/studio/keys') send(200,store.issueKey(a,Number(new URL(origin).port)));
      else if (url.pathname === '/v1/studio/keys/rotate') send(200,store.rotateKey(a,Number(new URL(origin).port)));
      else if (url.pathname === '/v1/studio/keys/revoke') {store.revokeKey(textField(a.keyId,'key ID'));send(200,{revoked:true});}
      else if (url.pathname === '/v1/studio/pairing') send(200, store.createGrant(a));
      else if (url.pathname === '/v1/studio/revoke') { store.revoke(textField(a.sessionId, 'session ID')); send(200, { revoked: true }); }
      else if (url.pathname === '/v1/studio/commands') send(200, { command: await store.enqueueVerified(a, sourceVerifier, activationGuard) });
      else if (url.pathname === '/v1/studio/restore') send(200, { command: await store.restoreVerified(a, sourceVerifier, activationGuard) });
      else send(404, { error: 'NOT_FOUND', message: 'Unknown bridge endpoint.' });
    } catch (error) {
      const known = error instanceof ArcaneError; const code = known ? error.code : 'INTERNAL';
      const status = ['AUTH','KEY_REJECTED'].includes(code) ? 401 : ['ORIGIN', 'SCOPE', 'READ_ONLY'].includes(code) ? 403 : code === 'BUSY' ? 429 : ['RECEIPT_CONFLICT', 'IDEMPOTENCY', 'RECONCILIATION', 'REVOKED', 'COMMAND_STATE'].includes(code) ? 409 : known ? 400 : 500;
      if (!response.destroyed && !response.headersSent) send(status, { error: code, message: known ? error.message : 'Local bridge operation failed; inspect local receipts. Provider credentials are not involved.' });
    }
    return true;
  };
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

