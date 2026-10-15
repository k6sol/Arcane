import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StudioTestService } from './studio-test-service.js';
import {scenarioPlanSchema,SCENARIO_LIMITS,type ScenarioPlan} from '../../../packages/studio-test-controller/src/scenario.js';

export interface StudioTestPrepareInput {
  sessionId: string;
  nativeStudioId?: string;
  durationMs: number;
  observationIntervalMs: number;
  failOnRuntimeError: boolean;
  scenario?: ScenarioPlan;
}
export interface StudioTestApprovalInput { id: string; displayDigest: string }
/** Structural test seam with the parent's exact method arguments and opaque
 * results. Importing the parent's type never loads native/provider dependencies.
 * The host derives binding/artifact/scope evidence; HTTP cannot supply it.
 */
export interface StudioTestRouteService {
  requests: {
    prepare(...args: Parameters<StudioTestService['requests']['prepare']>): Promise<unknown>;
    status(...args: Parameters<StudioTestService['requests']['status']>): unknown;
    list(...args: Parameters<StudioTestService['requests']['list']>): unknown;
    cancel(...args: Parameters<StudioTestService['requests']['cancel']>): Promise<unknown>;
    capture?: NonNullable<StudioTestService['requests']['capture']>;
  };
  humanControl: { approve(...args: Parameters<StudioTestService['humanControl']['approve']>): Promise<unknown> };
  lifecycle: { close(...args: Parameters<StudioTestService['lifecycle']['close']>): Promise<void> };
}
/** The human label is reserved for service-wide human visibility. Agent labels
 * must be stable, identifier-safe public hashes and must never equal 'human'. */
export type StudioTestActor = Readonly<{ kind: 'human' | 'agent'; id: string }>;
export type StudioTestActorResolver = (request: IncomingMessage) => StudioTestActor | null;

export const STUDIO_TEST_HTTP_LIMITS = Object.freeze({ bodyBytes: 16 * 1024, responseBytes: 128 * 1024, deadlineMs: 8_000 });
const PREFIX = '/v1/playtests';
const ID = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const METHODS = new Map([[PREFIX, 'GET'], [PREFIX + '/capture','GET'], [PREFIX + '/prepare', 'POST'], [PREFIX + '/approve', 'POST'], [PREFIX + '/cancel', 'POST']]);
const ERRORS: Readonly<Record<string, readonly [number, string]>> = {
  AUTH: [401, 'An authenticated local caller is required.'],
  HOST: [403, 'The exact configured loopback host is required.'],
  ORIGIN: [403, 'The exact local panel Origin is required.'],
  HUMAN_AUTH_REQUIRED: [403, 'Approval requires the authenticated human panel.'],
  SCOPE: [403, 'The authenticated caller changed before the operation.'],
  METHOD: [405, 'This endpoint does not support that method.'],
  NOT_FOUND: [404, 'The playtest endpoint or job was not found.'],
  QUERY: [400, 'Unexpected or duplicate query parameter.'],
  INVALID_REQUEST: [400, 'Supply only the bounded fields for this endpoint.'],
  CONTENT_TYPE: [415, 'Expected unencoded UTF-8 application/json.'],
  BODY_LIMIT: [413, 'The JSON body exceeds 16 KiB.'],
  BODY: [400, 'The request body is incomplete or invalid JSON.'],
  BODY_TIMEOUT: [408, 'The JSON body exceeded its 8 second deadline.'],
  RESPONSE_LIMIT: [502, 'The playtest response exceeds 128 KiB.'],
  TIMEOUT: [504, 'The playtest request exceeded its 8 second deadline.'],
  BUSY: [409, 'A playtest operation is already in progress.'],
  CONSENT_EXPIRED: [409, 'The displayed approval has expired.'],
  BINDING_CHANGED: [409, 'The Studio binding changed.'],
  STALE_PROOF: [409, 'Fresh Studio evidence is required.'],
  PLACE_DENIED: [403, 'The selected place is not eligible for testing.'],
  MODE_MISMATCH: [409, 'The Studio play mode changed.'],
  NOT_OWNED_PLAY: [409, 'This play session is not owned by the test.'],
  FENCED: [409, 'The previous test requires human reconciliation.'],
  DISCONNECTED: [503, 'The Studio connection is unavailable.'],
  SHUTDOWN: [503, 'The playtest service is closing.'],
  JOURNAL_FAILED: [503, 'The playtest journal is unavailable.'],
  UNAVAILABLE: [503, 'The playtest operation is unavailable.'],
};
class RouteError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new RouteError(code); }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_REQUEST');
  return value;
}
function record(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(input, key))) fail('INVALID_REQUEST');
  return input;
}
function prepareInput(value: unknown): StudioTestPrepareInput {
  const input = record(value, ['sessionId', 'nativeStudioId', 'durationMs', 'observationIntervalMs', 'failOnRuntimeError','scenario'], ['sessionId']);
  const duration = input.durationMs === undefined ? 15_000 : input.durationMs;
  const interval = input.observationIntervalMs === undefined ? 1_000 : input.observationIntervalMs;
  const failOnRuntimeError = input.failOnRuntimeError === undefined ? true : input.failOnRuntimeError;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 5_000 || duration > 60_000 ||
      typeof interval !== 'number' || !Number.isInteger(interval) || interval < 250 || interval > 2_000 ||
      typeof failOnRuntimeError !== 'boolean') fail('INVALID_REQUEST');
  const scenario=input.scenario===undefined?undefined:scenarioPlanSchema.safeParse(input.scenario);
  if(scenario&&!scenario.success)fail('INVALID_REQUEST');
  return { sessionId: identifier(input.sessionId),
    ...(input.nativeStudioId === undefined ? {} : { nativeStudioId: identifier(input.nativeStudioId) }),
    durationMs: duration, observationIntervalMs: interval, failOnRuntimeError,...(scenario?.success?{scenario:scenario.data}:{}) };
}
function approvalInput(value: unknown): StudioTestApprovalInput {
  const input = record(value, ['id', 'displayDigest']);
  if (typeof input.displayDigest !== 'string' || !DIGEST.test(input.displayDigest)) fail('INVALID_REQUEST');
  return { id: identifier(input.id), displayDigest: input.displayDigest };
}
function ingress(request: IncomingMessage, url: URL, origin: string): void {
  let expected: URL;
  try { expected = new URL(origin); } catch { fail('HOST'); }
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port || expected.origin !== origin ||
      request.headers.host !== expected.host || url.origin !== origin || url.username || url.password || url.hash ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) fail('HOST');
  const counts = new Map<string, number>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of ['host', 'authorization', 'origin', 'content-type', 'content-encoding', 'content-length', 'transfer-encoding'])
    if ((counts.get(name) ?? 0) > 1) fail(name === 'authorization' ? 'AUTH' : 'INVALID_REQUEST');
  const target = request.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#') ||
      target.split('?')[0] !== url.pathname || url.pathname.includes('%')) fail('INVALID_REQUEST');
  if (request.headers.origin !== undefined && request.headers.origin !== origin) fail('ORIGIN');
  const browser = request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined ||
    request.headers['sec-fetch-user'] !== undefined || /^Mozilla\//i.test(request.headers['user-agent'] ?? '');
  if (request.method === 'POST' && browser && request.headers.origin !== origin) fail('ORIGIN');
}

/** JSON.parse validates syntax; this second pass rejects duplicate object keys
 * (including escaped spellings) before a last-key-wins value can reach the service.
 */
function strictJson(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  const value: unknown = JSON.parse(text);
  let position = 0;
  const whitespace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    fail('BODY');
  };
  const scan = (depth: number): void => {
    if (depth > 16) fail('BODY');
    whitespace();
    const character = text[position];
    if (character === '"') { string(); return; }
    if (character === '{') {
      position++; whitespace(); const keys = new Set<string>();
      while (text[position] !== '}') {
        const key = string(); if (keys.has(key)) fail('BODY'); keys.add(key);
        whitespace(); position++; scan(depth + 1); whitespace();
        if (text[position] !== ',') break;
        position++; whitespace();
      }
      position++; return;
    }
    if (character === '[') {
      position++; whitespace();
      while (text[position] !== ']') {
        scan(depth + 1); whitespace(); if (text[position] !== ',') break;
        position++; whitespace();
      }
      position++; return;
    }
    while (position < text.length && !/[\s,}\]]/.test(text[position]!)) position++;
  };
  scan(0);
  return value;
}
async function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      request.headers['content-encoding'] !== undefined) fail('CONTENT_TYPE');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > STUDIO_TEST_HTTP_LIMITS.bodyBytes)) fail('BODY_LIMIT');
  const raw = await new Promise<Buffer>((resolve, reject) => {
    let bytes = 0, done = false; const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('error', aborted); request.off('aborted', aborted);
      signal.removeEventListener('abort', expired);
    };
    const finish = (code?: string) => {
      if (done) return; done = true; cleanup();
      if (code) { request.pause(); reject(new RouteError(code)); } else resolve(Buffer.concat(chunks, bytes));
    };
    const data = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); bytes += chunk.length;
      if (bytes > STUDIO_TEST_HTTP_LIMITS.bodyBytes) finish('BODY_LIMIT'); else chunks.push(chunk);
    };
    const end = () => finish(), aborted = () => finish('BODY'), expired = () => finish('BODY_TIMEOUT');
    request.on('data', data); request.once('end', end); request.once('error', aborted); request.once('aborted', aborted);
    signal.addEventListener('abort', expired, { once: true });
    if (signal.aborted) expired(); else if (request.aborted || request.destroyed || request.readableEnded) aborted();
  });
  try { return strictJson(raw); } catch { fail('BODY'); }
}

/** Mount as handler(request, response, url, origin). The resolver belongs to the
 * trusted daemon and must distinguish its human control audience from agents.
 * The service MUST invoke the approval guard after each await before consent/start.
 */
export function studioTestRoutes(service: StudioTestRouteService, resolveActor: StudioTestActorResolver) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL, origin: string): Promise<boolean> => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    const authorization = request.headers.authorization;
    const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    let expired = false, disconnected = false, readingBody = false;
    const controller = new AbortController();
    const send = (status: number, payload: unknown) => {
      if (response.destroyed || response.writableEnded || response.headersSent) return;
      let json = JSON.stringify(payload);
      if (json === undefined || Buffer.byteLength(json) > STUDIO_TEST_HTTP_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
      if (credential) json = json.replaceAll(JSON.stringify(credential).slice(1, -1), '[REDACTED]');
      if (Buffer.byteLength(json) > STUDIO_TEST_HTTP_LIMITS.responseBytes) fail('RESPONSE_LIMIT');
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        ...(status >= 400 ? { Connection: 'close' } : {}) });
      response.end(json);
    };
    const actor = (): StudioTestActor => {
      const current = resolveActor(request);
      if (!current || !['human', 'agent'].includes(current.kind) || typeof current.id !== 'string' ||
          !ID.test(current.id) ||
          (credential && current.id.includes(credential))) fail('AUTH');
      if ((current.kind === 'human' && current.id !== 'human') || (current.kind === 'agent' && current.id === 'human')) fail('HUMAN_AUTH_REQUIRED');
      return { kind: current.kind, id: current.id };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose: (() => void) | undefined;
    try {
      ingress(request, url, origin);
      const initial = actor();
      const method = METHODS.get(url.pathname);
      if (!method) fail('NOT_FOUND');
      if (request.method !== method) { response.setHeader('Allow', method); fail('METHOD'); }
      const allowed = url.pathname === PREFIX || url.pathname===PREFIX+'/capture' ? ['id'] : [];
      const seen = new Set<string>();
      for (const key of url.searchParams.keys()) {
        if (!allowed.includes(key) || seen.has(key)) fail('QUERY');
        seen.add(key);
      }
      const approving = url.pathname === PREFIX + '/approve';
      if (approving && initial.kind !== 'human') fail('HUMAN_AUTH_REQUIRED');
      if (approving && request.headers.origin !== origin) fail('ORIGIN');
      const guard = () => {
        if (expired || disconnected || response.destroyed || response.writableEnded || response.headersSent || request.aborted) fail('SCOPE');
        ingress(request, url, origin);
        const current = actor();
        if (current.kind !== initial.kind || current.id !== initial.id) fail('SCOPE');
        if (approving && (current.kind !== 'human' || request.headers.origin !== origin)) fail('HUMAN_AUTH_REQUIRED');
      };
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true; controller.abort(); reject(new RouteError(readingBody ? 'BODY_TIMEOUT' : 'TIMEOUT'));
        }, STUDIO_TEST_HTTP_LIMITS.deadlineMs);
        onClose = () => { disconnected = true; controller.abort(); reject(new RouteError('SCOPE')); };
        response.once('close', onClose);
      });
      const operation = (async () => {
        guard();
        if (method === 'GET') {
          if (request.headers['transfer-encoding'] !== undefined ||
              (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) fail('INVALID_REQUEST');
          const id = url.searchParams.get('id');
          if(url.pathname===PREFIX+'/capture'){
            if(!service.requests.capture||id===null)fail('NOT_FOUND');
            const capture=await service.requests.capture(identifier(id),initial.id);guard();
            if(!Buffer.isBuffer(capture.bytes)||capture.bytes.length>SCENARIO_LIMITS.imageBytes||capture.image.mimeType!=='image/png')fail('RESPONSE_LIMIT');
            response.writeHead(200,{'Content-Type':'image/png','Content-Length':capture.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox"});
            response.end(capture.bytes);return {captureDelivered:true};
          }
          return id === null ? { jobs: service.requests.list(initial.id) } : { job: service.requests.status(identifier(id), initial.id) };
        }
        readingBody = true;
        const value = await readJson(request, controller.signal);
        readingBody = false; guard();
        let job: unknown;
        if (url.pathname === PREFIX + '/prepare') job = await service.requests.prepare(prepareInput(value), initial.id);
        else if (approving) job = await service.humanControl.approve(approvalInput(value), guard);
        else job = await service.requests.cancel(identifier(record(value, ['id']).id), initial.id);
        guard();
        return { job };
      })();
      send(200, await Promise.race([operation, deadline]));
    } catch (error) {
      request.pause();
      const candidate = error instanceof Error && 'code' in error ? error.code : undefined;
      const code = typeof candidate === 'string' && Object.hasOwn(ERRORS, candidate) ? candidate : 'UNAVAILABLE';
      const [status, message] = ERRORS[code]!;
      send(status, { error: code, message });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onClose) response.off('close', onClose);
    }
    return true;
  };
}
