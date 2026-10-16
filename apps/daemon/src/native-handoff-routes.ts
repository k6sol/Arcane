import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { types } from 'node:util';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import { NativeHandoffError, NativeHandoffRegistry, type NativeHandoffLease } from './native-handoff-registry.js';

/** Daemon control for human-launched external native handoffs. No native client is launched here.
 * Human endpoints mint, seal, revoke and list handoff credentials for exactly this project. `agentToken`
 * returns a handoff bearer only after fresh live recognition and only for a fixed method/path allowlist;
 * every other request gets '' (no alternate grant and never the core token). Real StudioRoutes still
 * enforces Studio grants, human-only actions and bound original-task authority. Owns no processes. */
export const NATIVE_HANDOFF_ROUTE_LIMITS = Object.freeze({ bodyBytes: 8192, bodyTimeoutMs: 8000, responseBytes: 131072, spentRequests: 256 } as const);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const HANDOFF_BEARER = /^Bearer ([A-Za-z0-9_-]{43})(?![\s\S])/;
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RUN_PATH = /^\/v1\/work\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GET_PATHS = new Set(['/v1/product/state', '/v1/work/runs', '/v1/work/ready', '/v1/studio/sessions', '/v1/studio/commands']);
const POST_PATHS = new Set(['/v1/work/create', '/v1/work/claim', '/v1/work/progress', '/v1/work/submit', '/v1/studio/commands', '/v1/studio/restore']);
const QUERY_KEYS: Readonly<Record<string, string>> = Object.freeze({ '/v1/work/ready': 'runId', '/v1/studio/commands': 'sessionId' });

class RouteError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AUTH: 'Open the local launcher panel.', HOST: 'Local host check failed.', ORIGIN: 'Use the local panel origin.', QUERY: 'Native handoff routes take no query.',
  COOKIE: 'Cookies are not accepted.', METHOD: 'Method not allowed.', NOT_FOUND: 'Unknown native handoff endpoint.', BODY: 'Expected one bounded exact JSON object.',
  BODY_LIMIT: 'Request body is too large.', BODY_TIMEOUT: 'Request body did not arrive in time.', PROJECT: 'This handoff belongs to another project.',
  HANDOFF_SPENT: 'This begin request was already used. Revoke the handoff and start a new request.', REQUEST_LIMIT: 'The handoff request record limit is reached. Restart Arcane to clear it.',
  UNKNOWN: 'Unknown native handoff.', STATE: 'The native handoff is not in a state that allows this action.', CAPACITY: 'Too many native handoffs are active. Revoke one first.',
  RETENTION: 'The handoff record limit is reached. Restart Arcane to clear it.', CLOCK: 'The local clock is unavailable.', CLOSED: 'Native handoffs are closed.',
  RESPONSE_LIMIT: 'The handoff list cannot be displayed.', UNAVAILABLE: 'Native handoff is unavailable.',
});
const fail = (code: string, status: number): never => { throw new RouteError(code, status); };
const same = (left: string, right: string) => left.length > 0 && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function plainOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INPUT', 500);
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value as object);
  if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== 'string' || !['projectPath', 'now', 'lifetimeMs'].includes(key))) fail('INPUT', 500);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT', 500);
    if (field!.value !== undefined) out[key] = field!.value;
  }
  return out;
}
/** Exact JSON object, bounded bytes, fatal UTF-8 and a finite deadline. */
function readJson(request: IncomingMessage, keys: readonly string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false;
    const finish = (error: RouteError | null, value?: Record<string, unknown>) => {
      if (done) return; done = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed);
      if (error) reject(error); else resolve(value!);
    };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > NATIVE_HANDOFF_ROUTE_LIMITS.bodyBytes) finish(new RouteError('BODY_LIMIT', 413)); else chunks.push(chunk); };
    const failed = () => finish(new RouteError('BODY', 400));
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return finish(new RouteError('BODY', 400));
        const own = Object.keys(value).sort();
        if (own.join(',') !== [...keys].sort().join(',') || own.some(key => typeof (value as Record<string, unknown>)[key] !== 'string')) return finish(new RouteError('BODY', 400));
        finish(null, value as Record<string, unknown>);
      } catch { finish(new RouteError('BODY', 400)); }
    };
    const timer = setTimeout(() => finish(new RouteError('BODY_TIMEOUT', 408)), NATIVE_HANDOFF_ROUTE_LIMITS.bodyTimeoutMs);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
  });
}

export function createNativeHandoffRoutes(options: { projectPath: string; now?: () => number; lifetimeMs?: number }) {
  const o = plainOptions(options);
  if (typeof o.projectPath !== 'string') fail('INPUT', 500);
  const projectId = workflowProjectIdentity(o.projectPath as string).projectId;
  const registry = new NativeHandoffRegistry({ projectPath: o.projectPath, ...(o.now !== undefined ? { now: o.now } : {}), ...(o.lifetimeMs !== undefined ? { lifetimeMs: o.lifetimeMs } : {}) });
  // Private bookkeeping: opaque leases and spent begin request IDs only; never a raw credential.
  const leases = new Map<string, NativeHandoffLease>();
  const spent = new Set<string>();
  let closed = false;

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> {
    if (url.pathname !== '/v1/native-handoffs' && !url.pathname.startsWith('/v1/native-handoffs/')) return false;
    const send = (status: number, value: unknown): void => {
      if (response.destroyed || response.headersSent) return;
      let text = JSON.stringify(value);
      if (Buffer.byteLength(text) > NATIVE_HANDOFF_ROUTE_LIMITS.responseBytes) { status = 500; text = JSON.stringify({ error: 'RESPONSE_LIMIT', message: MESSAGES.RESPONSE_LIMIT }); }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(text);
    };
    try {
      const human = () => {
        if (closed) fail('CLOSED', 503);
        if (request.headers.host !== new URL(origin).host) fail('HOST', 403);
        const value = request.headers.authorization, bearer = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
        if (!same(bearer, controlToken)) fail('AUTH', 401);
        if (request.headers.origin !== undefined && request.headers.origin !== origin) fail('ORIGIN', 403);
        if (request.headers.cookie !== undefined) fail('COOKIE', 400);
        if (url.search || url.hash) fail('QUERY', 400);
      };
      human();
      const action = url.pathname === '/v1/native-handoffs' ? 'list' : url.pathname.slice('/v1/native-handoffs/'.length);
      if (!['list', 'begin', 'seal', 'revoke'].includes(action)) fail('NOT_FOUND', 404);
      if (action === 'list') {
        if (request.method !== 'GET') fail('METHOD', 405);
        send(200, { projectId, handoffs: registry.list() }); return true;
      }
      if (request.method !== 'POST') fail('METHOD', 405);
      if (request.headers.origin !== origin) fail('ORIGIN', 403);
      const input = await readJson(request, action === 'begin' ? ['requestId', 'projectId'] : ['handoffId', 'projectId']);
      // Every await is followed by a fresh human, project, closed and response check.
      human(); if (response.destroyed) return true;
      if (!PROJECT_ID.test(input.projectId as string)) fail('BODY', 400);
      if (input.projectId !== projectId) fail('PROJECT', 409);
      if (action === 'begin') {
        const requestId = input.requestId as string;
        if (!UUID.test(requestId)) fail('BODY', 400);
        if (spent.has(requestId)) fail('HANDOFF_SPENT', 409);
        if (spent.size >= NATIVE_HANDOFF_ROUTE_LIMITS.spentRequests) fail('REQUEST_LIMIT', 429);
        spent.add(requestId); // spent before minting: a lost response is never recovered by replaying this ID
        const receipt = registry.begin();
        leases.set(receipt.handoffId, receipt.lease);
        // The one trusted human response carrying this credential; nothing else ever does.
        send(200, { handoff: registry.status(receipt.lease), credential: receipt.credential }); return true;
      }
      const handoffId = input.handoffId as string;
      if (!UUID.test(handoffId)) fail('BODY', 400);
      const lease = leases.get(handoffId); if (!lease) fail('UNKNOWN', 404);
      // Seal is a trusted human-host acknowledgement only; it does not claim a native provider connected.
      send(200, { handoff: action === 'seal' ? registry.seal(lease!) : registry.revoke(lease!) }); return true;
    } catch (error) {
      let code = 'UNAVAILABLE', status = 500;
      if (error instanceof RouteError) { code = error.code; status = error.status; }
      else if (error instanceof NativeHandoffError) {
        code = error.code === 'LEASE' ? 'UNKNOWN' : error.code;
        status = ({ STATE: 409, PROJECT: 409, CAPACITY: 429, RETENTION: 429, CLOCK: 503, CLOSED: 503, INPUT: 400 } as Record<string, number>)[error.code] ?? 404;
      }
      if (!MESSAGES[code]) code = 'UNAVAILABLE';
      if (status === 408 || status === 413) response.setHeader('Connection', 'close');
      send(status, { error: code, message: MESSAGES[code] });
      return true;
    }
  }

  /** Fresh live recognition per call; '' unless the exact allowed method/path, Host and Origin. */
  function agentToken(request: IncomingMessage, origin: string): string {
    try {
      if (closed) return '';
      const header = request.headers.authorization, match = typeof header === 'string' ? HANDOFF_BEARER.exec(header) : null;
      if (!match || request.headers.host !== new URL(origin).host || request.headers.origin !== undefined && request.headers.origin !== origin) return '';
      const url = new URL(request.url ?? '', origin);
      if (url.origin !== origin || url.hash || url.username || url.password) return '';
      const path = url.pathname, method = request.method;
      let allowed = method === 'GET' && (GET_PATHS.has(path) || RUN_PATH.test(path) ||
        path.startsWith('/v1/studio/commands/') && COMMAND_ID.test(path.slice('/v1/studio/commands/'.length))) || method === 'POST' && POST_PATHS.has(path);
      const keys = [...url.searchParams.keys()], queryKey = method === 'GET' ? QUERY_KEYS[path] : undefined;
      if (keys.length && !(queryKey && keys.length === 1 && keys[0] === queryKey && url.searchParams.getAll(queryKey).length === 1)) allowed = false;
      if (!allowed) return '';
      const authorization = registry.recognize(match[1]!);
      if (!authorization || authorization.projectId !== projectId || authorization.audience !== 'external-handoff') return '';
      const scope = path.startsWith('/v1/work/') ? 'work-coordination' : path.startsWith('/v1/studio/') ? 'studio-granted-commands' : null;
      if (scope && !authorization.scopes.includes(scope)) return '';
      return match[1]!;
    } catch { return ''; }
  }

  function close(): void { if (closed) return; closed = true; registry.close(); leases.clear(); }
  return Object.freeze({ handle, agentToken, close, projectId });
}
