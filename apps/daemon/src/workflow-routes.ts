import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { assertLearningHumanRequest, LearningHttpError } from './learning-service.js';
import { WORKFLOW_HTTP_LIMITS, type WorkflowHost } from './workflow-host.js';

const PREFIX = '/v1/workflows';
const STATUS: Record<string, number> = {
  WORKFLOW_MODEL_CURRENT:409,WORKFLOW_CONVERSATION:403,WORKFLOW_ASSOCIATION_UNKNOWN:202,
  WORKFLOW_RECEIPT_CORRUPT: 503,
  WORKFLOW_INPUT: 400, WORKFLOW_SECRET: 400, WORKFLOW_HUMAN_REQUIRED: 403,
  WORKFLOW_RECORD: 404, WORKFLOW_BINDING: 409, WORKFLOW_EVIDENCE: 409,
  WORKFLOW_STATE: 409, WORKFLOW_BLOCKED: 409, WORKFLOW_MAPPING: 409,
  WORKFLOW_IDEMPOTENCY: 409, WORKFLOW_CONFLICT: 409, WORKFLOW_UNCERTAIN: 202,
  WORKFLOW_BUSY: 409, WORKFLOW_CAPACITY: 429, WORKFLOW_VERIFIER: 409,
  WORKFLOW_CLOSED: 503, WORKFLOW_CONTEXT: 503, WORKFLOW_PROJECT: 503,
  WORKFLOW_OWNER: 503, WORKFLOW_STORAGE: 503, WORKFLOW_RECEIPT_STORAGE: 503,
  MIGRATION: 503,
};
/** Parse JSON without silently accepting duplicate/escaped duplicate object keys. */
function json(text: string): unknown {
  let cursor = 0, nodes = 0;
  const bad = (): never => { throw new LearningHttpError('JSON', 400); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? '\0')) cursor++; };
  function string(): string {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++]!;
      if (char === '\\') { cursor++; continue; }
      if (char === '"') {
        try { return JSON.parse(text.slice(start, cursor)) as string; } catch { return bad(); }
      }
    }
    return bad();
  }
  function value(depth: number): unknown {
    if (++nodes > WORKFLOW_HTTP_LIMITS.nodes || depth > WORKFLOW_HTTP_LIMITS.depth) return bad();
    space();
    const char = text[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor++; space();
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[cursor] === '}') { cursor++; return object; }
      while (true) {
        if (text[cursor] !== '"') return bad();
        const key = string();
        if (Object.hasOwn(object, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return bad();
        space(); if (text[cursor++] !== ':') return bad();
        object[key] = value(depth + 1); space();
        const end = text[cursor++]; if (end === '}') return object;
        if (end !== ',') return bad(); space();
      }
    }
    if (char === '[') {
      cursor++; space(); const array: unknown[] = [];
      if (text[cursor] === ']') { cursor++; return array; }
      while (true) {
        array.push(value(depth + 1)); space();
        const end = text[cursor++]; if (end === ']') return array;
        if (end !== ',') return bad();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) return bad();
    cursor += number[0].length;
    const parsed = Number(number[0]); if (!Number.isFinite(parsed)) return bad();
    return parsed;
  }
  const result = value(0); space(); if (cursor !== text.length) return bad();
  return result;
}
function headers(request: IncomingMessage): void {
  const singleton = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding']);
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    if (singleton.has(name) && seen.has(name)) throw new LearningHttpError('HEADER', 400);
    seen.add(name);
  }
  if (request.headers['content-length'] !== undefined && request.headers['transfer-encoding'] !== undefined) {
    throw new LearningHttpError('HEADER', 400);
  }
}
async function body(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(type) ||
      request.headers['content-encoding'] !== undefined) throw new LearningHttpError('CONTENT_TYPE', 415);
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > WORKFLOW_HTTP_LIMITS.bodyBytes)) {
    throw new LearningHttpError('BODY_LIMIT', 413);
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    const cleanup = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('error', failed); request.off('aborted', failed);
    };
    const fail = (error: LearningHttpError) => {
      if (done) return; done = true; cleanup(); request.pause(); reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > WORKFLOW_HTTP_LIMITS.bodyBytes) { fail(new LearningHttpError('BODY_LIMIT', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      if (done) return; done = true; cleanup();
      if (length !== undefined && Number(length) !== size) { reject(new LearningHttpError('BODY_LENGTH', 400)); return; }
      resolve(Buffer.concat(chunks, size));
    };
    const failed = () => fail(new LearningHttpError('BODY_ABORTED', 400));
    const timer = setTimeout(() => fail(new LearningHttpError('BODY_TIMEOUT', 408)), WORKFLOW_HTTP_LIMITS.bodyTimeoutMs);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
  });
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { throw new LearningHttpError('JSON', 400); }
  return json(decoded);
}
async function refuseBody(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.complete || request.destroyed) return;
  await new Promise<void>(resolve => {
    let bytes = 0, done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      request.off('data', data); request.off('end', finish); request.off('error', finish); request.off('aborted', finish);
      request.pause(); resolve();
    };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > WORKFLOW_HTTP_LIMITS.bodyBytes) finish(); };
    const timer = setTimeout(finish, 100);
    request.on('data', data); request.once('end', finish); request.once('error', finish); request.once('aborted', finish);
    request.resume();
  });
  response.setHeader('Connection', 'close');
  response.once('finish', () => { setTimeout(() => request.socket.destroy(), 25).unref(); });
}

/** Same dispatcher signature as learningRoutes. No network listener or execution runner. */
export function workflowRoutes(host: WorkflowHost) {
  return async (
    request: IncomingMessage, response: ServerResponse, url: URL,
    controlToken: string, origin: string, agentToken: string,
  ): Promise<boolean> => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    const send = (status: number, value: unknown) => {
      if (response.destroyed || response.headersSent) return;
      // Redact decoded strings before JSON escaping, including awkward bearer characters.
      const text = JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item !== 'string') return item;
        for (const secret of [controlToken, agentToken]) if (secret) item = (item as string).replaceAll(secret, '[REDACTED]');
        return item;
      });
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      response.end(text);
    };
    try {
      assertLearningHumanRequest(request, controlToken, origin, agentToken);
      headers(request);
      if (url.origin !== origin || url.username || url.password || url.hash) throw new LearningHttpError('ORIGIN', 403);
      if (url.search || (request.url ?? '').includes('?')) throw new LearningHttpError('QUERY', 400);
      // Reject normalized/encoded aliases, absolute targets and traversal before dispatch.
      if (request.url !== url.pathname || url.pathname.length > 160) throw new LearningHttpError('TARGET', 400);
      const endpoint = url.pathname === PREFIX ? '' : url.pathname.slice(PREFIX.length + 1);
      const authority = { controlToken, origin, agentToken };
      if (endpoint === 'preview' || endpoint === 'execute' || endpoint === 'receipt' || endpoint === 'evidence' || endpoint === 'draft') {
        if (request.method !== 'POST') throw new LearningHttpError('METHOD', 405);
        const input = await body(request);
        const result = endpoint === 'preview' ? host.preview(input, request, authority) :
          endpoint === 'receipt' ? host.receipt(input, request, authority) :
          endpoint === 'evidence' ? host.prepareEvidence(input,request,authority) :
          endpoint === 'draft' ? host.prepareDraft(input,request,authority) : host.execute(input, request, authority);
        send(200, result); return true;
      }
      if (endpoint !== '' && endpoint !== 'current-flow' && !/^[a-zA-Z0-9_-]{1,64}$/.test(endpoint)) {
        throw new LearningHttpError('NOT_FOUND', 404);
      }
      if (request.method !== 'GET') throw new LearningHttpError('METHOD', 405);
      send(200, endpoint === '' ? host.list() : endpoint === 'current-flow' ? host.currentFlow() : host.get(endpoint));
    } catch (error) {
      await refuseBody(request, response);
      const status = error instanceof LearningHttpError ? error.status :
        error instanceof ArcaneError && Object.hasOwn(STATUS, error.code) ? STATUS[error.code]! : 503;
      const code = error instanceof LearningHttpError ? error.code :
        error instanceof ArcaneError && Object.hasOwn(STATUS, error.code) ? error.code : 'WORKFLOW_UNAVAILABLE';
      send(status, status === 202 ? {
        error: code, outcome: 'unknown', retry: false,
        message: 'Inspect the workflow and explicitly reconcile the observed outcome. No operation was retried.',
      } : { error: code, message: 'Workflow request was refused or local storage is unavailable.' });
    }
    return true;
  };
}
