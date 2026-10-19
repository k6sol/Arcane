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
    viewport?: NonNullable<StudioTestService['requests']['viewport']>;
    nativeAssets?: NonNullable<StudioTestService['requests']['nativeAssets']>;
  };
  humanControl: { toolboxPolicy?: StudioTestService['humanControl']['toolboxPolicy']; approve(...args: Parameters<StudioTestService['humanControl']['approve']>): Promise<unknown> };
  lifecycle: { close(...args: Parameters<StudioTestService['lifecycle']['close']>): Promise<void> };
}
/** The human label is reserved for service-wide human visibility. Agent labels
 * must be stable, identifier-safe public hashes and must never equal 'human'. */
export type StudioTestActor = Readonly<{ kind: 'human' | 'agent'; id: string }>;
export type StudioTestActorResolver = (request: IncomingMessage) => StudioTestActor | null;

export const STUDIO_TEST_HTTP_LIMITS = Object.freeze({ bodyBytes: 16 * 1024, responseBytes: 128 * 1024, deadlineMs: 8_000 });
/** The viewport endpoint returns one bounded base64 PNG and needs a native round trip. */
export const STUDIO_VIEWPORT_HTTP_LIMITS = Object.freeze({ responseBytes: 960 * 1024, deadlineMs: 25_000 });
const PREFIX = '/v1/playtests';
/** Native Studio asset tools (search, insert, generate, job): bounded JSON, longer native round trips. */
const NATIVE_ASSET_PREFIX = '/v1/studio-native';
const NATIVE_ASSET_ROUTES = new Map([
  [NATIVE_ASSET_PREFIX + '/asset-search', { kind: 'search', keys: ['sessionId', 'nativeStudioId', 'query', 'category', 'page', 'pageSize', 'verifiedOnly'], required: ['sessionId', 'query'] }],
  [NATIVE_ASSET_PREFIX + '/asset-insert', { kind: 'insert', keys: ['sessionId', 'nativeStudioId', 'assetId', 'category', 'watch'], required: ['sessionId', 'assetId', 'watch'] }],
  [NATIVE_ASSET_PREFIX + '/asset-generate', { kind: 'generate', keys: ['sessionId', 'nativeStudioId', 'kind', 'prompt', 'size', 'maxTriangles', 'baseMaterial', 'pattern', 'target', 'watch'], required: ['sessionId', 'kind', 'prompt'] }],
  [NATIVE_ASSET_PREFIX + '/asset-job', { kind: 'job', keys: ['jobId'], required: ['jobId'] }],
] as const);
export const STUDIO_NATIVE_ASSET_HTTP_LIMITS = Object.freeze({ deadlineMs: 32_000 });
const ID = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const METHODS = new Map([[PREFIX, 'GET'], [PREFIX + '/capture','GET'], [PREFIX + '/prepare', 'POST'], [PREFIX + '/approve', 'POST'], [PREFIX + '/cancel', 'POST'], [PREFIX + '/viewport', 'POST'], [NATIVE_ASSET_PREFIX + '/toolbox-policy', 'POST'], ...[...NATIVE_ASSET_ROUTES.keys()].map(path => [path, 'POST'] as [string, string])]);
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
  RESPONSE_LIMIT: [502, 'The playtest response exceeds its byte bound.'],
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
  // Settled preparation refusals only (see prepareRefusal): no job exists, so these are definite.
  TEST_TOOL_UNSUPPORTED: [422, 'Native Studio does not support this playtest; no playtest job was created.'],
  NATIVE_RESPONSE_INVALID: [424, 'Native Studio returned unusable test evidence; no playtest job was created.'],
  SESSION_NOT_FOUND: [404, 'The paired Studio session was not found; no playtest job was created.'],
  SESSION_REVOKED: [409, 'The paired Studio session was revoked; no playtest job was created.'],
  SCENARIO_DENIED: [422, 'The scenario is outside the paired Studio safe scope; no playtest job was created.'],
  PREPARE_FAILED: [424, 'Playtest preparation failed; no playtest job was created.'],
  // Viewport refusals: read-only, so every refusal is definite and nothing changed in Studio.
  VIEWPORT_TOOL_UNSUPPORTED: [422, 'Native Studio does not advertise the reviewed screen capture tool; no viewport image was taken.'],
  VIEWPORT_INVALID: [424, 'Native Studio returned an unusable viewport image; nothing was changed.'],
  VIEWPORT_FAILED: [424, 'The viewport capture failed; nothing was changed.'],
  VIEWPORT_CAMERA_UNKNOWN: [409, 'The Studio camera could not be confirmed restored after a framed capture; check the Edit camera.'],
  // Native asset refusals: fixed host messages; native response text is never relayed.
  NATIVE_ASSET_TOOL_UNSUPPORTED: [422, 'This Roblox Studio does not advertise the reviewed asset tool shape; nothing was searched, inserted or generated. Update Roblox Studio and enable its built-in MCP server.'],
  NATIVE_ASSET_INVALID: [424, 'Roblox Studio returned an asset response Arcane cannot read; nothing further was done.'],
  NATIVE_ASSET_FAILED: [424, 'The Roblox Studio asset operation failed; nothing further was done.'],
  NATIVE_ASSET_UNKNOWN: [409, 'The Roblox Studio operation may have applied but could not be confirmed. Inspect the scene (scene_search or studio_viewport_capture) before trying again.'],
  NATIVE_SIGN_IN: [424, 'Roblox Studio refused the request: sign in to Studio with an account that can use the Creator Store and AI generation, then retry once.'],
  NATIVE_QUOTA: [429, 'Roblox Studio refused the request because a usage limit was reached. Wait before retrying, or reuse already inserted assets.'],
  NATIVE_UNAVAILABLE: [424, 'This Roblox Studio session cannot use the requested built-in tool (feature disabled, terms not accepted, or account/place not eligible). Enable the Studio Assistant features, or use assets_procedural for original local Blender geometry.'],
  NATIVE_REJECTED: [424, 'Roblox Studio rejected this request (for example a moderated prompt or unsupported parameters). Rephrase plainly or use the original local asset pipeline.'],
  ASSET_INSERT_REFUSED: [424, 'Roblox Studio refused the insertion (the asset may be private, paid, removed or not insertable). Nothing was adopted; choose another free result.'],
  TOOLBOX_MODELS_DISABLED: [403, 'Toolbox models are off. Build original geometry with assets_procedural in Blender, inspect assets_preview, then prepare, stage, reconstruct and place the result. Only the user can enable Toolbox models in Settings > Tools for this Studio session. Do not substitute free models.'],
  ASSET_NOT_SEARCHED: [409, 'Only free assets returned by studio_asset_search for this session in the last 30 minutes can be inserted. Search first.'],
  ASSET_WATCH_REQUIRED: [409, 'Insertion needs a fresh Arcane plugin watch for this session; use studio_asset_insert or studio_asset_generate, which arm it automatically.'],
  ASSET_JOB_NOT_FOUND: [404, 'The generation job is unknown, expired or owned by another caller.'],
  NATIVE_PLACE_DENIED: [403, 'Native Studio asset tools work only for the exact paired, unpublished, write-granted place in Edit mode.'],
  RATE_LIMITED: [429, 'The native asset budget for the last 10 minutes is used up. Reuse inserted templates with scene_build clone items instead of inserting or generating again.'],
};
/** Fences only this route raises; a service error reusing one of these names is not that fence. */
const ROUTE_ONLY = new Set(['AUTH', 'HOST', 'ORIGIN', 'SCOPE', 'METHOD', 'QUERY', 'CONTENT_TYPE', 'BODY_LIMIT', 'BODY', 'BODY_TIMEOUT', 'RESPONSE_LIMIT']);
const SCENARIO_POLICY = new Set(['INPUT', 'PROPERTY', 'SCOPE', 'READ_ONLY', 'CAPABILITY', 'TEST_BUDGET', 'TEST_SETUP']);
class RouteError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new RouteError(code); }
/** The service's prepare() rejects only after it has settled: a job is never
 * returned and any partially built job is closed before rethrowing. Its refusals
 * are therefore definite (4xx), except an explicit unknown effect. The route's
 * own deadline (TIMEOUT) and disconnect fences are raised elsewhere and stay 5xx. */
function prepareRefusal(error: unknown): unknown {
  if (error instanceof RouteError) return error;
  if (error instanceof Error && error.name === 'ZodError') return new RouteError('INVALID_REQUEST');
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'EFFECT_UNKNOWN') return error;
  if (code === 'UNSUPPORTED_TOOL') return new RouteError('TEST_TOOL_UNSUPPORTED');
  if (code === 'BAD_NATIVE_RESPONSE') return new RouteError('NATIVE_RESPONSE_INVALID');
  if (code === 'SESSION') return new RouteError('SESSION_NOT_FOUND');
  if (code === 'REVOKED') return new RouteError('SESSION_REVOKED');
  if (code !== undefined && SCENARIO_POLICY.has(code)) return new RouteError('SCENARIO_DENIED');
  if (code !== undefined && Object.hasOwn(ERRORS, code) && !ROUTE_ONLY.has(code)) return error;
  return new RouteError('PREPARE_FAILED');
}
/** Native asset refusals. Only fixed host codes cross the route; an unconfirmed native effect stays unknown. */
function nativeAssetRefusal(error: unknown): unknown {
  if (error instanceof RouteError) return error;
  if (error instanceof Error && error.name === 'ZodError') return new RouteError('INVALID_REQUEST');
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'EFFECT_UNKNOWN') return new RouteError('NATIVE_ASSET_UNKNOWN');
  if (code === 'PLACE_DENIED') return new RouteError('NATIVE_PLACE_DENIED');
  if (code === 'UNSUPPORTED_TOOL') return new RouteError('NATIVE_ASSET_TOOL_UNSUPPORTED');
  if (code === 'BAD_NATIVE_RESPONSE') return new RouteError('NATIVE_ASSET_INVALID');
  if (code === 'SESSION') return new RouteError('SESSION_NOT_FOUND');
  if (code === 'REVOKED') return new RouteError('SESSION_REVOKED');
  if (code !== undefined && Object.hasOwn(ERRORS, code) && !ROUTE_ONLY.has(code)) return new RouteError(code);
  return new RouteError('NATIVE_ASSET_FAILED');
}
/** Viewport capture is read-only: refusals are definite, except an unconfirmed camera restore. */
function viewportRefusal(error: unknown): unknown {
  if (error instanceof RouteError) return error;
  if (error instanceof Error && error.name === 'ZodError') return new RouteError('INVALID_REQUEST');
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'EFFECT_UNKNOWN') return new RouteError('VIEWPORT_CAMERA_UNKNOWN');
  if (code === 'UNSUPPORTED_TOOL') return new RouteError('VIEWPORT_TOOL_UNSUPPORTED');
  if (code === 'BAD_NATIVE_RESPONSE') return new RouteError('VIEWPORT_INVALID');
  if (code === 'SESSION') return new RouteError('SESSION_NOT_FOUND');
  if (code === 'REVOKED') return new RouteError('SESSION_REVOKED');
  if (code !== undefined && Object.hasOwn(ERRORS, code) && !ROUTE_ONLY.has(code)) return error;
  return new RouteError('VIEWPORT_FAILED');
}
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
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/') && !url.pathname.startsWith(NATIVE_ASSET_PREFIX + '/')) return false;
    const authorization = request.headers.authorization;
    const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    let expired = false, disconnected = false, readingBody = false;
    const viewing = url.pathname === PREFIX + '/viewport';
    const nativeAsset = NATIVE_ASSET_ROUTES.get(url.pathname);
    const controller = new AbortController();
    const send = (status: number, payload: unknown) => {
      if (response.destroyed || response.writableEnded || response.headersSent) return;
      let json = JSON.stringify(payload);
      const responseBytes = viewing && status === 200 ? STUDIO_VIEWPORT_HTTP_LIMITS.responseBytes : STUDIO_TEST_HTTP_LIMITS.responseBytes;
      if (json === undefined || Buffer.byteLength(json) > responseBytes) fail('RESPONSE_LIMIT');
      if (credential) json = json.replaceAll(JSON.stringify(credential).slice(1, -1), '[REDACTED]');
      if (Buffer.byteLength(json) > responseBytes) fail('RESPONSE_LIMIT');
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
      const policy = url.pathname === NATIVE_ASSET_PREFIX + '/toolbox-policy';
      const approving = url.pathname === PREFIX + '/approve' || policy;
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
        }, viewing ? STUDIO_VIEWPORT_HTTP_LIMITS.deadlineMs : nativeAsset ? STUDIO_NATIVE_ASSET_HTTP_LIMITS.deadlineMs : STUDIO_TEST_HTTP_LIMITS.deadlineMs);
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
        if (policy) {
          if(!service.humanControl.toolboxPolicy)fail('UNAVAILABLE');
          const input=record(value,['sessionId','allowModels'],['sessionId']);
          try{return service.humanControl.toolboxPolicy(input,guard);}catch(error){throw nativeAssetRefusal(error);}
        }
        if (nativeAsset) {
          if (!service.requests.nativeAssets) fail('UNAVAILABLE');
          const input = record(value, nativeAsset.keys, nativeAsset.required);
          let result: unknown;
          try { result = await service.requests.nativeAssets[nativeAsset.kind](input, initial.id); } catch (error) { throw nativeAssetRefusal(error); }
          guard();
          return result;
        }
        if (viewing) {
          if (!service.requests.viewport) fail('UNAVAILABLE');
          const input = record(value, ['sessionId', 'nativeStudioId', 'maxDimension', 'camera'], ['sessionId']);
          let captured: unknown;
          try { captured = await service.requests.viewport(input, initial.id); } catch (error) { throw viewportRefusal(error); }
          guard();
          return captured;
        }
        let job: unknown;
        if (url.pathname === PREFIX + '/prepare') {
          const input = prepareInput(value);
          try { job = await service.requests.prepare(input, initial.id); } catch (error) { throw prepareRefusal(error); }
        }
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
