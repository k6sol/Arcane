import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { assertLearningHumanRequest, LearningHttpError, type LearningAction, type LearningService } from './learning-service.js';

const MAX_BODY = 32 * 1024, BODY_TIMEOUT_MS = 2000;
const ACTIONS = new Set<LearningAction>(['consent', 'propose', 'review', 'disable', 'erase']);
const STORE_STATUS: Record<string, number> = {
  LEARNING_INPUT: 400, LEARNING_SECRET: 400, LEARNING_EVIDENCE: 400,
  LEARNING_HUMAN_REQUIRED: 403, LEARNING_CONSENT: 409, LEARNING_REVIEW: 409,
  LEARNING_RECORD: 404, LEARNING_IDEMPOTENCY: 409, LEARNING_CAPACITY: 429,
  LEARNING_CLOSED: 503, LEARNING_PATH: 503, LEARNING_SCOPE: 503,
  LEARNING_MIGRATION: 503, LEARNING_CORRUPT: 503,
};
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || request.headers['content-encoding'] !== undefined) {
    throw new LearningHttpError('CONTENT_TYPE', 415);
  }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new LearningHttpError('BODY_LIMIT', 413);
  // Event listeners allow a deadline response before closing a stalled socket.
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('error', failed); request.off('aborted', failed);
    };
    const fail = (error: LearningHttpError) => { cleanup(); request.pause(); reject(error); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { fail(new LearningHttpError('BODY_LIMIT', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const failed = () => fail(new LearningHttpError('BODY_ABORTED', 400));
    const timer = setTimeout(() => fail(new LearningHttpError('BODY_TIMEOUT', 408)), BODY_TIMEOUT_MS);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new LearningHttpError('JSON', 400); }
}
async function refuseBody(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.complete || request.destroyed) return;
  // Drain at most one bounded body for reliable error delivery. Slow/excessive
  // rejected streams get a deadline and a nonreusable connection.
  const reusable = await new Promise<boolean>(resolve => {
    let bytes = 0, done = false;
    const finish = (value: boolean) => {
      if (done) return; done = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed);
      if (!value) request.pause(); resolve(value);
    };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BODY) finish(false); };
    const end = () => finish(true), failed = () => finish(false);
    const timer = setTimeout(() => finish(false), 100);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
    request.resume();
  });
  if (!reusable) {
    response.setHeader('Connection', 'close');
    response.once('finish', () => { setTimeout(() => request.socket.destroy(), 25).unref(); });
  }
}

export function learningRoutes(service: LearningService) {
  return async (
    request: IncomingMessage, response: ServerResponse, url: URL,
    controlToken: string, origin: string, agentToken: string,
  ): Promise<boolean> => {
    if (url.pathname !== '/v1/learning' && !url.pathname.startsWith('/v1/learning/')) return false;
    const send = (status: number, value: unknown) => {
      if (response.destroyed || response.headersSent) return;
      let text = JSON.stringify(value);
      for (const secret of [controlToken, agentToken]) if (secret) text = text.replaceAll(secret, '[REDACTED]');
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      response.end(text);
    };
    try {
      assertLearningHumanRequest(request, controlToken, origin, agentToken);
      if (url.origin !== origin || url.username || url.password || url.hash) throw new LearningHttpError('ORIGIN', 403);
      if (url.search) throw new LearningHttpError('QUERY', 400);
      const endpoint = url.pathname.slice('/v1/learning/'.length);
      if (endpoint === 'state') {
        if (request.method !== 'GET') throw new LearningHttpError('METHOD', 405);
        send(200, service.state()); return true;
      }
      if (endpoint !== 'context' && !ACTIONS.has(endpoint as LearningAction)) throw new LearningHttpError('NOT_FOUND', 404);
      if (request.method !== 'POST') throw new LearningHttpError('METHOD', 405);
      const input = await body(request);
      const serialized = JSON.stringify(input);
      if ([controlToken, agentToken].some(secret => secret && serialized.includes(secret))) throw new ArcaneError('LEARNING_SECRET', 'Credential-like content is forbidden.');
      const result = endpoint === 'context' ? service.context(input) : service.mutate(endpoint as LearningAction, input, request, controlToken, origin, agentToken);
      send(200, result);
    } catch (error) {
      await refuseBody(request, response);
      const status = error instanceof LearningHttpError ? error.status : error instanceof ArcaneError ? STORE_STATUS[error.code] ?? 503 : 503;
      const code = error instanceof LearningHttpError ? error.code : error instanceof ArcaneError && Object.hasOwn(STORE_STATUS, error.code) ? error.code : 'LEARNING_UNAVAILABLE';
      send(status, { error: code, message: 'Learning request was refused or local storage is unavailable.' });
    }
    return true;
  };
}
