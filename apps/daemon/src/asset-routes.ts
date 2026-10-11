import { CUSTOM_REQUEST_BYTES } from '../../../packages/asset-pipeline/src/recipe.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { AssetError, normalizeRequest, type AssetInput } from '../../../packages/asset-pipeline/src/index.js';
import type { AssetService } from './asset-service.js';

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArcaneError('INPUT', 'Expected a JSON object.');
  return input as Record<string, unknown>;
}
function exactKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some(k => !keys.includes(k))) throw new ArcaneError('INPUT', 'Unexpected request field.');
}
/** Hard byte and elapsed-time bounds, independent of the parent server body reader. */
async function readAssetJson(request: IncomingMessage, allowRecipe = false): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ArcaneError('CONTENT_TYPE', 'Expected application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ArcaneError('CONTENT_TYPE', 'Compressed bodies are unsupported.');
  const limit = allowRecipe ? CUSTOM_REQUEST_BYTES : 16384;
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ArcaneError('BODY_LIMIT', 'Asset body exceeds ' + limit + ' bytes.');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false;
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const finish = (problem?: ArcaneError, result?: unknown) => {
      if (done) return; done = true; cleanup();
      if (problem) { request.pause(); reject(problem); } else resolve(result);
    };
    const data = (raw: Buffer | string) => { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); bytes += chunk.length; if (bytes > limit) finish(new ArcaneError('BODY_LIMIT', 'Asset body exceeds ' + limit + ' bytes.')); else chunks.push(chunk); };
    const end = () => {
      try { const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
        if (bytes > 16384 && (!allowRecipe || !parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as {template?: unknown}).template !== 'custom-assembly')) { finish(new ArcaneError('BODY_LIMIT', 'Only custom-assembly accepts bodies above 16 KiB.')); return; }
        finish(undefined, parsed); }
      catch { finish(bytes > 16384 ? new ArcaneError('BODY_LIMIT', 'Asset body exceeds its JSON limit.') : new ArcaneError('JSON', 'Invalid UTF-8 JSON request.')); }
    };
    const error = () => finish(new ArcaneError('BODY', 'Asset request body could not be read.'));
    const aborted = () => finish(new ArcaneError('BODY', 'Asset request was aborted.'));
    const timer = setTimeout(() => finish(new ArcaneError('BODY_TIMEOUT', 'Asset body exceeded its 8 second deadline.')), 8000);
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
    if (request.aborted || request.destroyed) aborted();
  });
}
/** Discard rejected bytes without parsing or retaining them before deciding socket reuse.
 * At most 64 KiB and 200 ms: stalled/large uploads still get Connection: close.
 */
async function discardRejectedAssetBody(request: IncomingMessage): Promise<boolean> {
  if (request.destroyed || request.aborted) return false;
  if (request.readableEnded || (request.complete && request.readableLength === 0)) return true;
  if (!request.headers['transfer-encoding'] && Number(request.headers['content-length'] ?? '0') === 0) return true;
  return new Promise<boolean>(resolve => {
    let remaining = 64 * 1024, done = false;
    const finish = (complete = false) => {
      if (done) return;
      done = true; clearTimeout(timer);
      request.off('readable', drain); request.off('end', ended); request.off('aborted', stopped); request.off('error', stopped);
      if (!complete && !request.destroyed) request.pause();
      resolve(complete);
    };
    const ended = () => finish(true);
    const stopped = () => finish(false);
    const drain = () => {
      while (!done && remaining > 0 && request.readableLength > 0) {
        const chunk = request.read(Math.min(remaining, 16 * 1024, request.readableLength)) as Buffer | null;
        if (!chunk) break;
        remaining -= chunk.length;
      }
      if (request.complete && request.readableLength === 0) finish(true);
      else if (remaining === 0) finish(false);
    };
    const timer = setTimeout(stopped, 200);
    request.on('readable', drain); request.once('end', ended); request.once('aborted', stopped); request.once('error', stopped);
    drain();
  });
}
export function assetRoutes(service: AssetService) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string, agentToken?: string): Promise<boolean> => {
    if (!url.pathname.startsWith('/v1/assets/')) return false;
    const send = async (status: number, payload: unknown) => {
      const drained = status < 400 || await discardRejectedAssetBody(request);
      if (response.headersSent || response.destroyed) return;
      if (!drained) response.setHeader('Connection', 'close');
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      response.end(JSON.stringify(payload));
    };
    try {
      const expected = new URL(origin);
      if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port || expected.origin !== origin || request.headers.host !== expected.host || url.origin !== origin) throw new ArcaneError('HOST', 'Asset routes require the exact literal loopback host.');
      const remote = request.socket.remoteAddress;
      if (remote && !(isIP(remote) === 4 && remote === '127.0.0.1') && remote !== '::ffff:127.0.0.1') throw new ArcaneError('HOST', 'Asset routes require a loopback peer.');
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const accepted = [controlToken, agentToken].some(token => typeof token === 'string' && token.length > 0 && Buffer.byteLength(bearer) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(bearer), Buffer.from(token)));
      if (!accepted) throw new ArcaneError('AUTH', 'Supply the local launcher control or agent bearer.');
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Cross-origin asset access refused.');
      const route = url.pathname.slice('/v1/assets/'.length);
      const method = new Map([['probe', 'POST'], ['jobs', 'GET'], ['start', 'POST'], ['cancel', 'POST'], ['manifest', 'GET'], ['preview', 'GET']]).get(route);
      if (!method) { await send(404, { error: 'NOT_FOUND', message: 'Unknown asset endpoint.' }); return true; }
      if (request.method !== method) { response.setHeader('Allow', method); await send(405, { error: 'METHOD', message: 'Expected ' + method + '.' }); return true; }
      const allowedQuery = route === 'manifest' ? ['jobId'] : route === 'preview' ? ['jobId', 'path'] : route === 'jobs' ? ['limit', 'after'] : [];
      for (const key of url.searchParams.keys()) if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ArcaneError('INPUT', 'Unexpected or duplicate query parameter.');
      if (route === 'jobs') {
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null && !/^[1-9][0-9]?$/.test(rawLimit)) throw new ArcaneError('INPUT', 'History limit must be 1..64.');
        const after = url.searchParams.get('after');
        await send(200, service.jobPage({ ...(rawLimit === null ? {} : { limit: Number(rawLimit) }), ...(after === null ? {} : { after }) }));
        return true;
      }
      if (route === 'manifest') { await send(200, { manifest: await service.manifest(url.searchParams.get('jobId')) }); return true; }
      if (route === 'preview') {
        const bytes = await service.preview(url.searchParams.get('jobId'), url.searchParams.get('path'));
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" });
        response.end(bytes); return true;
      }
      const input = object(await readAssetJson(request, route === 'start'));
      if (route === 'probe') { exactKeys(input, []); await send(200, { probe: await service.probe() }); }
      else if (route === 'start') { normalizeRequest(input); await send(202, { job: await service.start(input as unknown as AssetInput) }); }
      else { exactKeys(input, ['jobId']); await send(200, { job: await service.cancel(input.jobId) }); }
    } catch (error) {
      const known = error instanceof AssetError || error instanceof ArcaneError, code = known ? error.code : 'INTERNAL';
      const status = code === 'AUTH' ? 401 : ['HOST', 'ORIGIN'].includes(code) ? 403 : code === 'NOT_FOUND' ? 404 : code === 'BUSY' ? 409 : ['JOB_STATE', 'RECONCILIATION', 'HISTORY_LIMIT', 'CLOSED'].includes(code) ? 409 : code === 'BODY_LIMIT' ? 413 : code === 'BODY_TIMEOUT' ? 408 : ['HASH', 'MANIFEST', 'ARTIFACT', 'RECOVERY', 'PERSISTENCE'].includes(code) ? 422 : known ? 400 : 500;
      if (!response.headersSent && !response.destroyed) { await send(status, { error: code, message: known ? error.message : 'Local asset operation failed; inspect retained job evidence.' }); }
    }
    return true;
  };
}
