/**
 * Project memory routes (human desktop bearer only; agent and scoped credentials are refused).
 *
 * GET  /v1/project-memory          {text, bytes, limit, exists, truncated} for ARCANE.md in this project folder.
 * PUT  /v1/project-memory          {text} replaces the whole file (Settings > Project memory "Save").
 * POST /v1/project-memory/append   {text} appends one note (the chat's explicit "Save to project memory" click).
 *
 * Writes go only to ARCANE.md directly inside the daemon's own project folder; the path never comes from a request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { appendProjectMemory, PROJECT_MEMORY_MAX_BYTES, ProjectMemoryError, readProjectMemory, writeProjectMemory, type ProjectMemory } from '../../../packages/core/src/project-memory.js';

export const PROJECT_MEMORY_PATHS = Object.freeze(['/v1/project-memory', '/v1/project-memory/append']);
/** JSON escaping can grow 16 KB of text; the body bound leaves room for that and nothing more. */
const BODY_BYTES = PROJECT_MEMORY_MAX_BYTES * 6 + 64;

export function projectMemoryRoutes(options: { projectPath: string }) {
  const projectPath = options.projectPath;
  let queue: Promise<unknown> = Promise.resolve();
  /** One write at a time, so an append never interleaves with a full save. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  const human = (request: IncomingMessage, token: string) => {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    return Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };
  const view = (memory: ProjectMemory) => ({ text: memory.text, bytes: memory.bytes, limit: PROJECT_MEMORY_MAX_BYTES, exists: memory.exists, truncated: memory.truncated });
  async function body(request: IncomingMessage): Promise<string | null> {
    if (!request.headers['content-type']?.startsWith('application/json')) return null;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length; if (bytes > BODY_BYTES) return null; chunks.push(chunk);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as { text?: unknown }).text !== 'string') return null;
    return (value as { text: string }).text;
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, token: string, origin: string): Promise<boolean> {
    const path = url.pathname;
    if (!PROJECT_MEMORY_PATHS.includes(path)) return false;
    if (!human(request, token)) { send(response, 401, { error: 'AUTH', message: 'Project memory is available to the signed-in desktop only.' }); return true; }
    if (request.headers.origin && request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Cross-origin access refused.' }); return true; }
    const method = path === '/v1/project-memory/append' ? 'POST' : request.method === 'GET' ? 'GET' : 'PUT';
    if (request.method !== method) { send(response, 405, { error: 'METHOD' }); return true; }
    if (method === 'GET') { send(response, 200, view(await readProjectMemory(projectPath))); return true; }
    if (request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Writes require the local panel origin.' }); return true; }
    const text = await body(request);
    if (text === null) { send(response, 400, { error: 'INPUT', message: 'Expected {"text": "..."} as JSON.' }); return true; }
    try {
      const saved = await serial(() => method === 'PUT' ? writeProjectMemory(projectPath, text) : appendProjectMemory(projectPath, text));
      send(response, 200, view(saved));
    } catch (error) {
      if (!(error instanceof ProjectMemoryError)) throw error;
      send(response, error.code === 'MEMORY_WRITE' || error.code === 'MEMORY_PATH' ? 409 : 400, { error: error.code, message: error.message });
    }
    return true;
  }
  return { handle };
}
