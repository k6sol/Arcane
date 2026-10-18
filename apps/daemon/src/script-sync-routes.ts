/**
 * Script sync routes (human desktop bearer only; agent and scoped credentials are refused). See docs/script-sync.md.
 *
 * GET  /v1/script-sync            status: switch, last sync, counts, conflicts, deletions and skipped files.
 * PUT  /v1/script-sync            {enabled} switches sync for this project (off by default).
 * POST /v1/script-sync/run        {} runs one full sync now.
 * POST /v1/script-sync/resolve    {file, keep: 'studio'|'file'} resolves one listed conflict.
 * POST /v1/script-sync/deletion   {file, action} decides one listed deletion ('restore'|'ignore' or 'delete-file'|'recreate').
 *
 * Paths never come from a request beyond choosing one already listed sync file; the engine maps it under the project folder.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { createScriptSync, type ScriptSync, type ScriptSyncOptions } from './script-sync.js';

export const SCRIPT_SYNC_PATHS = Object.freeze(['/v1/script-sync', '/v1/script-sync/run', '/v1/script-sync/resolve', '/v1/script-sync/deletion']);
const BODY_BYTES = 4096;
const BODY_KEYS: Record<string, string[]> = {
  '/v1/script-sync': ['enabled'], '/v1/script-sync/run': [], '/v1/script-sync/resolve': ['file', 'keep'], '/v1/script-sync/deletion': ['file', 'action'],
};

export function scriptSyncRoutes(options: ScriptSyncOptions | { sync: ScriptSync }) {
  const sync = 'sync' in options ? options.sync : createScriptSync(options);
  // A project that had sync switched on resumes it when Arcane starts; otherwise nothing runs.
  if (!('sync' in options)) void sync.status().catch(() => undefined);
  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  const human = (request: IncomingMessage, token: string) => {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    return Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };
  async function body(request: IncomingMessage, keys: string[]): Promise<Record<string, unknown> | null> {
    if (!request.headers['content-type']?.startsWith('application/json')) return null;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length; if (bytes > BODY_BYTES) return null; chunks.push(chunk);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const names = Object.keys(value);
    return names.length === keys.length && names.every(name => keys.includes(name)) ? value as Record<string, unknown> : null;
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, token: string, origin: string): Promise<boolean> {
    const path = url.pathname;
    if (!SCRIPT_SYNC_PATHS.includes(path)) return false;
    if (!human(request, token)) { send(response, 401, { error: 'AUTH', message: 'Script sync is available to the signed-in desktop only.' }); return true; }
    if (request.headers.origin && request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Cross-origin access refused.' }); return true; }
    const method = path === '/v1/script-sync' ? (request.method === 'GET' ? 'GET' : 'PUT') : 'POST';
    if (request.method !== method || url.search) { send(response, 405, { error: 'METHOD' }); return true; }
    try {
      if (method === 'GET') { send(response, 200, await sync.status()); return true; }
      if (request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Changes require the local panel origin.' }); return true; }
      const input = await body(request, BODY_KEYS[path]!);
      if (!input || (method === 'PUT' && typeof input.enabled !== 'boolean')) { send(response, 400, { error: 'INPUT', message: 'Unexpected script sync request.' }); return true; }
      if (path === '/v1/script-sync') send(response, 200, await sync.setEnabled(input.enabled as boolean));
      else if (path === '/v1/script-sync/run') send(response, 200, await sync.syncNow());
      else if (path === '/v1/script-sync/resolve') send(response, 200, await sync.resolve(input.file, input.keep));
      else send(response, 200, await sync.deletion(input.file, input.action));
    } catch (error) {
      if (!(error instanceof ArcaneError)) { send(response, 500, { error: 'INTERNAL', message: 'Script sync failed. Your files and Studio were not changed further.' }); return true; }
      send(response, error.code === 'SYNC_INPUT' ? 400 : 409, { error: error.code, message: error.message.slice(0, 300) });
    }
    return true;
  }
  return { handle, close: () => sync.close() };
}
