import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  connectNativeStudio, NativeStudioError, NATIVE_STUDIO_LIMITS,
  type NativeStudioReadArgs, type NativeStudioReadMethod, type NativeStudioSession,
} from '../../../packages/studio-adapter/src/index.js';
import { parseReadArguments } from '../../../packages/studio-adapter/src/policy.js';

export type NativeHttpSession = Pick<NativeStudioSession, 'metadata' | 'listStudios' | 'read' | 'close'>;
export interface NativeRouteOptions {
  /** Test-only injection seam. The default always connects to the vetted official executable. */
  connect?: () => Promise<NativeHttpSession>;
}
export const NATIVE_HTTP_BODY_BYTES = 32 * 1024;
const BODY_TIMEOUT_MS = 8_000;
const envelope = z.strictObject({ method: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) });
// Shared by every route factory in this daemon process, including capabilities and reads.
let nativeInFlight = false;

const errorResponses: Record<string, readonly [number, string]> = {
  AUTH: [401, 'Native Studio routes require the local human control bearer.'],
  ORIGIN: [403, 'Native browser access requires the exact local panel Origin.'],
  HOST: [403, 'Native Studio routes accept only the configured loopback host.'],
  METHOD: [405, 'This native endpoint does not support that HTTP method.'],
  NOT_FOUND: [404, 'Unknown native endpoint.'],
  QUERY: [400, 'Native routes do not accept query parameters.'],
  CONTENT_TYPE: [415, 'Expected unencoded application/json.'],
  BODY_LIMIT: [413, 'Native request body exceeds 32 KiB.'],
  BODY_TIMEOUT: [408, 'Native request body did not finish within its deadline.'],
  BODY: [400, 'Native request body is incomplete or invalid JSON.'],
  BUSY: [409, 'A native capability probe or read is already in flight.'],
  STUDIO_READ_ONLY: [403, 'The native HTTP surface exposes only its fixed read allowlist.'],
  STUDIO_ARGUMENTS: [400, 'Supply exactly method and args with an explicit studio_id and bounded documented read fields.'],
  STUDIO_NOT_FOUND: [404, 'The exact requested studio_id is absent from the current native Studio inventory. No target was substituted.'],
  STUDIO_BUSY: [409, 'A native adapter operation is already in flight.'],
  STUDIO_PAYLOAD_LIMIT: [413, 'Native response exceeded its byte limit.'],
  STUDIO_SOURCE_LIMIT: [413, 'Native script response exceeded 100 KiB; request a smaller explicit line range.'],
  STUDIO_TIMEOUT: [504, 'Native Studio request timed out. No request was retried.'],
  STUDIO_REQUEST_LIMIT: [503, 'Native request budget was exhausted.'],
  STUDIO_CAPABILITY_UNAVAILABLE: [503, 'This native read is unavailable in the actual runtime capability inventory.'],
  STUDIO_CAPABILITY_SCHEMA: [503, 'The native runtime capability schema is incompatible with this request.'],
  STUDIO_CAPABILITY_LIMIT: [503, 'The native runtime capability inventory exceeded its bounds.'],
  STUDIO_INVENTORY: [502, 'The actual native Studio inventory could not be validated.'],
  STUDIO_RESPONSE: [502, 'Native Studio returned an unsupported read response.'],
  STUDIO_EXECUTABLE: [503, 'A vetted official Studio MCP executable is unavailable.'],
  STUDIO_SIGNATURE: [503, 'Official Studio MCP executable verification failed.'],
  STUDIO_PLATFORM: [503, 'Native Studio discovery is unavailable on this platform.'],
  STUDIO_CLOSED: [503, 'The native Studio connection is closed.'],
  STUDIO_REQUEST_FAILED: [502, 'Native Studio request failed. No request was retried.'],
  STUDIO_CLOSE_FAILED: [502, 'Native connection cleanup failed.'],
};

function send(response: ServerResponse, status: number, payload: unknown, controlToken: string) {
  if (response.destroyed || response.headersSent) return;
  // Never echo the local human bearer, even if untrusted read text contains its exact value.
  const encoded = JSON.stringify(payload);
  const json = controlToken ? encoded.replaceAll(controlToken, '[REDACTED]') : encoded;
  if (Buffer.byteLength(json, 'utf8') > NATIVE_STUDIO_LIMITS.resultBytes)
    throw new NativeStudioError('STUDIO_PAYLOAD_LIMIT', 'Native HTTP result is too large.');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status >= 400 ? { Connection: 'close' } : {}),
  });
  response.end(json);
}
function authorized(request: IncomingMessage, token: string) {
  if (!token) return false;
  let authorizationHeaders = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') authorizationHeaders++;
  if (authorizationHeaders !== 1) return false;
  const supplied = request.headers.authorization ?? '', expected = 'Bearer ' + token;
  return Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function validateOrigin(request: IncomingMessage, url: URL, origin: string) {
  const configured = new URL(origin);
  const remote = request.socket.remoteAddress;
  if (configured.protocol !== 'http:' || configured.hostname !== '127.0.0.1' || configured.origin !== origin ||
      configured.username || configured.password || request.headers.host !== configured.host || url.origin !== origin ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? ''))
    throw new NativeStudioError('HOST', 'Unexpected native HTTP host.');
  const supplied = request.headers.origin;
  if (supplied !== undefined && supplied !== origin) throw new NativeStudioError('ORIGIN', 'Origin mismatch.');
  // Sec-Fetch-Mode alone is also emitted by Node fetch, which is a valid native human CLI.
  const browser = request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined ||
    request.headers['sec-fetch-user'] !== undefined || /^Mozilla\//i.test(request.headers['user-agent'] ?? '');
  if (request.method === 'POST' && browser && supplied !== origin)
    throw new NativeStudioError('ORIGIN', 'Browser POST requires the exact panel Origin.');
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      ![undefined, 'identity'].includes(request.headers['content-encoding']))
    throw new NativeStudioError('CONTENT_TYPE', 'Unsupported native request content type.');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > NATIVE_HTTP_BODY_BYTES))
    throw new NativeStudioError('BODY_LIMIT', 'Native request body too large.');
  const body = await new Promise<Buffer>((resolve, reject) => {
    let bytes = 0, finished = false;
    const chunks: Buffer[] = [];
    const clean = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('aborted', aborted); request.off('error', aborted);
    };
    const fail = (code: string) => {
      if (finished) return; finished = true; clean(); request.pause();
      reject(new NativeStudioError(code, 'Native request body refused.'));
    };
    const data = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > NATIVE_HTTP_BODY_BYTES) { fail('BODY_LIMIT'); return; }
      chunks.push(chunk);
    };
    const end = () => { if (!finished) { finished = true; clean(); resolve(Buffer.concat(chunks)); } };
    const aborted = () => fail('BODY');
    const timer = setTimeout(() => fail('BODY_TIMEOUT'), BODY_TIMEOUT_MS);
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', aborted);
    if (request.aborted || request.destroyed) fail('BODY');
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
  catch { throw new NativeStudioError('BODY', 'Invalid native JSON.'); }
}

async function discardRejectedBody(request: IncomingMessage): Promise<void> {
  // Preserve a small error response on Windows without buffering/re-parsing rejected JSON.
  // Discard at most 64 KiB for at most 200ms; larger/stalled uploads still close.
  if (request.destroyed || request.readableEnded ||
      (!request.headers['transfer-encoding'] && Number(request.headers['content-length'] ?? '0') === 0)) return;
  await new Promise<void>(resolve => {
    let discarded = 0, finished = false;
    const done = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      request.off('data', data); request.off('end', done); request.off('aborted', done); request.off('error', done);
      if (!request.readableEnded && !request.destroyed) request.pause();
      resolve();
    };
    const data = (chunk: Buffer | string) => { discarded += Buffer.byteLength(chunk); if (discarded >= 64 * 1024) done(); };
    const timer = setTimeout(done, 200);
    request.on('data', data); request.once('end', done); request.once('aborted', done); request.once('error', done);
    request.resume();
  });
}

/** Parent mounts this separately from plugin routes and passes its human token, never its model/agent bearer. */
export function nativeRoutes(options: NativeRouteOptions = {}) {
  const connect = options.connect ?? (() => connectNativeStudio({ timeoutMs: 5_000, maxRequests: 16 }));
  return async (request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> => {
    if (url.pathname !== '/v1/native' && !url.pathname.startsWith('/v1/native/')) return false;
    let ownsGate = false, session: NativeHttpSession | undefined, disconnected = false;
    const onClose = () => {
      if (!response.writableFinished) {
        disconnected = true;
        if (session) void session.close().catch(() => {});
      }
    };
    try {
      if (!authorized(request, controlToken)) throw new NativeStudioError('AUTH', 'Human control bearer required.');
      validateOrigin(request, url, origin);
      if (url.pathname !== '/v1/native/capabilities' && url.pathname !== '/v1/native/read')
        throw new NativeStudioError('NOT_FOUND', 'Unknown native route.');
      const expectedMethod = url.pathname === '/v1/native/capabilities' ? 'GET' : 'POST';
      if (request.method !== expectedMethod) {
        response.setHeader('Allow', expectedMethod); throw new NativeStudioError('METHOD', 'Unexpected native HTTP method.');
      }
      if (url.search) throw new NativeStudioError('QUERY', 'Unexpected native query parameters.');
      if (request.method === 'GET' && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? '0') !== 0))
        throw new NativeStudioError('BODY', 'Native capability GET does not accept a body.');
      if (nativeInFlight) throw new NativeStudioError('BUSY', 'Native operation in progress.');
      nativeInFlight = true; ownsGate = true; response.once('close', onClose);

      let method: NativeStudioReadMethod | undefined;
      let args: (Record<string, unknown> & { studio_id: string }) | undefined;
      if (request.method === 'POST') {
        const parsed = envelope.safeParse(await readBody(request));
        if (!parsed.success) throw new NativeStudioError('STUDIO_ARGUMENTS', 'Invalid native read envelope.');
        args = parseReadArguments(parsed.data.method, parsed.data.args);
        method = parsed.data.method as NativeStudioReadMethod;
      }
      if (disconnected || response.destroyed) return true;
      session = await connect();
      let studios: Awaited<ReturnType<NativeHttpSession['listStudios']>> | undefined;
      let result: Awaited<ReturnType<NativeHttpSession['read']>> | undefined;
      try {
        if (disconnected || response.destroyed) return true;
        if (method && args) result = await session.read(method, args as NativeStudioReadArgs[typeof method]);
        else studios = await session.listStudios();
      } finally {
        try { await session.close(); }
        catch { throw new NativeStudioError('STUDIO_CLOSE_FAILED', 'Native cleanup failed.'); }
      }
      if (disconnected || response.destroyed) return true;
      const metadata = session.metadata();
      const native = {
        kind: 'built-in-studio-mcp', readOnly: true, available: true, requiresExplicitRead: true,
        provenance: metadata.provenance, metadata,
      };
      if (method && args && result) send(response, result.isError ? 502 : 200, { native, method, studio_id: args.studio_id, result, ...(result.isError ? { error: 'STUDIO_TOOL_ERROR', message: 'The official native read returned a tool error.' } : {}) }, controlToken);
      else send(response, 200, { native, studios }, controlToken);
    } catch (error) {
      const entry = error instanceof NativeStudioError && Object.hasOwn(errorResponses, error.code) ? errorResponses[error.code] : undefined;
      const code = entry && error instanceof NativeStudioError ? error.code : 'NATIVE_ERROR';
      const [status, message] = entry ?? [502, 'Native Studio operation failed; raw process errors are not exposed.'];
      if (!response.destroyed && !response.headersSent) await discardRejectedBody(request);
      if (!response.destroyed && !response.headersSent)
        send(response, status, { error: code, message, ...(code === 'BUSY' ? { native: { kind: 'built-in-studio-mcp', readOnly: true, busy: true } } : {}) }, controlToken);
    } finally {
      response.off('close', onClose);
      if (ownsGate) nativeInFlight = false;
    }
    return true;
  };
}
