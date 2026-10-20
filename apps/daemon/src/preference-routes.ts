/**
 * Learned preference routes. Feedback, edits and the on/off switch are human desktop only (bearer + local panel origin);
 * the read-only chat context and tool defaults are also readable by this project's agent credentials (the MCP server).
 *
 * GET  /v1/preferences            snapshot {enabled, project[], global[], context, warnings}            human
 * POST /v1/preferences/signal     {source, polarity?, text?, previous?, reason?, tools[]} -> learning note human
 * POST /v1/preferences/edit       {layer, id, action: like|dislike|clear|delete}                         human
 * POST /v1/preferences/forget     {confirm: true}                                                         human
 * POST /v1/preferences/enabled    {enabled}                                                               human
 * GET  /v1/preferences/context    {text} (<= 600 chars)                                                   human, agent
 * GET  /v1/preferences/bias       {enabled, prefer, avoid, boosts}                                        human, agent
 *
 * Classification runs here, locally and deterministically; message text is never stored, only the parameter weights.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { classifyFeedback, extractObservations, PREFERENCE_LIMITS, requestSimilarity, type Aspect, type FeedbackSignal, type ToolCall } from '../../../packages/core/src/preference-learning.js';
import { PreferenceStoreError, type PreferenceStore } from '../../../packages/core/src/preference-store.js';

export const PREFERENCE_PATHS = Object.freeze(['/v1/preferences', '/v1/preferences/signal', '/v1/preferences/edit', '/v1/preferences/forget',
  '/v1/preferences/enabled', '/v1/preferences/context', '/v1/preferences/bias']);
const AGENT_READABLE = new Set(['/v1/preferences/context', '/v1/preferences/bias']);
const BODY_BYTES = 320 * 1024;
const SOURCES = new Set(['explicit', 'message', 'undo', 'reask', 'keep', 'review']);

const equal = (a: string, b: string) => !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Parses and bounds one signal request; null when malformed. Exported for tests. */
export function preferenceSignal(value: unknown): { signal: FeedbackSignal; tools: ToolCall[]; classification: { polarity: string; confidence: number } } | null {
  const body = rec(value); if (!body) return null;
  const allowed = ['source', 'polarity', 'text', 'previous', 'reason', 'tools'];
  if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.source !== 'string' || !SOURCES.has(body.source)) return null;
  for (const key of ['text', 'previous', 'reason'] as const) if (body[key] !== undefined && (typeof body[key] !== 'string' || (body[key] as string).length > PREFERENCE_LIMITS.textChars)) return null;
  if (body.polarity !== undefined && body.polarity !== 'positive' && body.polarity !== 'negative') return null;
  if (!Array.isArray(body.tools) || body.tools.length > PREFERENCE_LIMITS.tools) return null;
  const tools: ToolCall[] = [];
  for (const raw of body.tools) {
    const row = rec(raw);
    if (!row || typeof row.name !== 'string' || row.name.length > 128 || typeof row.input !== 'string' || row.input.length > PREFERENCE_LIMITS.toolInputChars) return null;
    tools.push({ name: row.name, input: row.input });
  }
  const source = body.source as FeedbackSignal['source'];
  let polarity: FeedbackSignal['polarity'], confidence: number, aspects: Aspect[] = [];
  if (source === 'message') {
    const read = classifyFeedback(body.text);
    polarity = read.polarity; confidence = read.confidence; aspects = read.aspects;
    // Asking for the same thing again (with no clear praise) is weak negative evidence about the last result.
    if (polarity === 'neutral' && typeof body.previous === 'string' && requestSimilarity(body.text, body.previous) >= 0.6)
      return { signal: { source: 'reask', polarity: 'negative', confidence: 0.6, aspects: [] }, tools, classification: { polarity: 'negative', confidence: 0.6 } };
  } else if (source === 'explicit' || source === 'review') {
    if (!body.polarity) return null;
    polarity = body.polarity as 'positive' | 'negative'; confidence = 1;
    const read = typeof body.reason === 'string' ? classifyFeedback(body.reason.slice(0, PREFERENCE_LIMITS.reasonChars)) : null;
    // A reason names what was good or bad ("too plain", "love the golden hour"); its aspects carry their own direction.
    if (read) aspects = read.aspects;
  } else if (source === 'keep') { polarity = 'positive'; confidence = 1; }
  else if (source === 'undo') { polarity = 'negative'; confidence = 0.9; }
  else { polarity = 'negative'; confidence = 0.6; }
  return { signal: { source, polarity, confidence, aspects }, tools, classification: { polarity, confidence } };
}

export function preferenceRoutes(options: { store: PreferenceStore; agent: (request: IncomingMessage) => boolean }) {
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  async function body(request: IncomingMessage): Promise<unknown> {
    if (!request.headers['content-type']?.startsWith('application/json')) return undefined;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length; if (bytes > BODY_BYTES) return undefined; chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
  }
  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, token: string, origin: string): Promise<boolean> {
    const path = url.pathname;
    if (!PREFERENCE_PATHS.includes(path)) return false;
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const human = equal(supplied, token);
    if (!human && !(AGENT_READABLE.has(path) && options.agent(request))) { send(response, 401, { error: 'AUTH', message: 'Learned preferences are available to this desktop only.' }); return true; }
    if (request.headers.origin && request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Cross-origin access refused.' }); return true; }
    const read = path === '/v1/preferences' || AGENT_READABLE.has(path);
    if (request.method !== (read ? 'GET' : 'POST')) { send(response, 405, { error: 'METHOD' }); return true; }
    if (path === '/v1/preferences/context') { send(response, 200, { text: await options.store.context() }); return true; }
    if (path === '/v1/preferences/bias') { send(response, 200, await options.store.bias()); return true; }
    if (path === '/v1/preferences') { send(response, 200, await options.store.snapshot()); return true; }
    if (request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Changes require the local panel origin.' }); return true; }
    const input = await body(request), row = rec(input);
    const invalid = () => send(response, 400, { error: 'INPUT', message: 'Unexpected learned-preference request.' });
    try {
      if (path === '/v1/preferences/signal') {
        const parsed = preferenceSignal(input); if (!parsed) { invalid(); return true; }
        const observations = extractObservations(parsed.tools);
        const result = await options.store.record(parsed.signal, observations);
        send(response, 200, { enabled: result.enabled, learned: result.changes.length > 0, message: result.message,
          changes: result.changes.slice(0, 8), classification: parsed.classification, observations: observations.length });
        return true;
      }
      if (path === '/v1/preferences/edit') {
        if (!row || Object.keys(row).length !== 3 || (row.layer !== 'project' && row.layer !== 'global') || typeof row.id !== 'string' || row.id.length > PREFERENCE_LIMITS.idChars ||
            !['like', 'dislike', 'clear', 'delete'].includes(row.action as string)) { invalid(); return true; }
        send(response, 200, await options.store.edit(row.layer, row.id, row.action as 'like' | 'dislike' | 'clear' | 'delete')); return true;
      }
      if (path === '/v1/preferences/forget') {
        if (!row || Object.keys(row).length !== 1 || row.confirm !== true) { invalid(); return true; }
        send(response, 200, await options.store.forget()); return true;
      }
      if (!row || Object.keys(row).length !== 1 || typeof row.enabled !== 'boolean') { invalid(); return true; }
      send(response, 200, await options.store.setEnabled(row.enabled)); return true;
    } catch (error) {
      if (!(error instanceof PreferenceStoreError)) throw error;
      send(response, 409, { error: error.code, message: error.message }); return true;
    }
  }
  return { handle };
}
