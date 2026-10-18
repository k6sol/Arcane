/**
 * Arcane Credits provider seam: model access through a hosted Arcane gateway.
 *
 * DISABLED until both are true: a gateway URL is configured (`gateway.url` in packages/protocol/src/plans.ts, or the
 * user's local `gatewayUrl` passed in as `localUrl`) on an https origin listed in `gateway.allowedOrigins`, and a
 * signed-in Arcane account token is present in the encrypted credential vault (desktop: Settings > Plans & credits >
 * Connect Arcane account, apps/desktop/electron/billing.cjs). While disabled, the provider is
 * hidden from the model picker and no network call is made. Arcane never calls a model vendor directly and never
 * ships vendor keys: the hosted gateway (operated by the Arcane owner under their own provider terms) does that.
 * The expected gateway API is documented in docs/ARCANE_CREDITS.md.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { serviceBase, type PlansConfig } from '../../../packages/protocol/src/plans.js';

export const ARCANE_PROVIDER_ID = 'arcane' as const;
export type GatewayState = 'disabled' | 'signed-out' | 'ready';
export interface GatewayStatus { provider: typeof ARCANE_PROVIDER_ID; state: GatewayState; message: string; showInModelPicker: boolean }
export interface GatewayBalance { credits: number; actionsRemaining: number | null; plan: string | null; renewsAt: string | null }
export interface GatewayUsage { period: string; creditsUsed: number; actionsUsed: number }
export interface GatewayModel { id: string; label: string }
export interface GatewayChatRequest { model: string; messages: { role: 'user' | 'assistant' | 'system'; content: string }[]; conversationId?: string; turnId?: string }
export type GatewayChunk = { type: 'delta'; text: string } | { type: 'done'; creditsUsed: number | null } | { type: 'error'; message: string };

/** Encrypted at-rest storage for the Arcane account token (same pattern as the Studio key vault: host-supplied OS encryption). */
export interface ArcaneCredentialVault {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** The provider surface the desktop and daemon use. Every call refuses while the provider is disabled. */
export interface ArcaneGatewayProvider {
  readonly id: typeof ARCANE_PROVIDER_ID;
  status(): Promise<GatewayStatus>;
  balance(): Promise<GatewayBalance>;
  usage(): Promise<GatewayUsage>;
  models(): Promise<GatewayModel[]>;
  streamChat(request: GatewayChatRequest, signal?: AbortSignal): AsyncGenerator<GatewayChunk>;
}

export class GatewayUnavailable extends Error {
  constructor(message = 'Arcane Credits are not connected yet.') { super(message); this.name = 'GatewayUnavailable'; }
}

const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_JSON_BYTES = 64 * 1024, MAX_STREAM_BYTES = 4 * 1024 * 1024, TIMEOUT_MS = 10000;
const finite = (value: unknown, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(value);

/** Effective gateway base: a user-configured local URL wins, but only on an origin the shipped config allowlists. */
export function gatewayBase(config: PlansConfig, localUrl?: string | null): string | null {
  return serviceBase({ url: localUrl || config.gateway.url, allowedOrigins: config.gateway.allowedOrigins });
}

export function gatewayStatus(config: PlansConfig, signedIn: boolean, localUrl?: string | null): GatewayStatus {
  if (!gatewayBase(config, localUrl)) return { provider: ARCANE_PROVIDER_ID, state: 'disabled', showInModelPicker: false, message: 'Arcane Credits are not connected yet.' };
  if (!signedIn) return { provider: ARCANE_PROVIDER_ID, state: 'signed-out', showInModelPicker: false, message: 'Sign in to your Arcane account to use credits.' };
  return { provider: ARCANE_PROVIDER_ID, state: 'ready', showInModelPicker: true, message: 'Arcane Credits are ready.' };
}

async function readBounded(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength; if (bytes > max) { await reader.cancel(); throw new GatewayUnavailable('The Arcane gateway reply was too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ArcaneGatewayOptions { config: PlansConfig; vault: ArcaneCredentialVault | null; fetch?: typeof fetch; localUrl?: string | null }

export function createArcaneGateway(options: ArcaneGatewayOptions): ArcaneGatewayProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const ready = async (): Promise<{ base: string; token: string }> => {
    const base = gatewayBase(options.config, options.localUrl);
    if (!base) throw new GatewayUnavailable();
    const token = await options.vault?.read() ?? null;
    if (!token || !TOKEN.test(token)) throw new GatewayUnavailable('Sign in to your Arcane account to use credits.');
    return { base, token };
  };
  const call = async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> => {
    const { base, token } = await ready();
    const url = new URL(base + path);
    if (url.origin !== new URL(base).origin) throw new GatewayUnavailable();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await doFetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!response.ok) throw new GatewayUnavailable(response.status === 401 ? 'Your Arcane sign-in expired. Sign in again.' : response.status === 402 ? 'You are out of Arcane Credits.' : response.status === 429 ? 'Too many Arcane requests right now. Try again in a minute.' : 'The Arcane gateway is unavailable.');
    return response;
  };
  const json = async (path: string): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(await readBounded(await call(path), MAX_JSON_BYTES));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayUnavailable('The Arcane gateway reply was not understood.');
    return value as Record<string, unknown>;
  };
  return {
    id: ARCANE_PROVIDER_ID,
    async status() { return gatewayStatus(options.config, !!(await options.vault?.read().catch(() => null)), options.localUrl); },
    async balance() {
      const value = await json('/v1/balance');
      if (!finite(value.credits) || !(value.actionsRemaining === null || finite(value.actionsRemaining)) ||
          !(value.plan === null || text(value.plan, 48)) || !(value.renewsAt === null || text(value.renewsAt, 40) && !Number.isNaN(Date.parse(value.renewsAt as string))))
        throw new GatewayUnavailable('The Arcane gateway balance was not understood.');
      return { credits: value.credits as number, actionsRemaining: value.actionsRemaining as number | null, plan: value.plan as string | null, renewsAt: value.renewsAt as string | null };
    },
    async usage() {
      const value = await json('/v1/usage');
      if (!text(value.period, 16) || !finite(value.creditsUsed) || !finite(value.actionsUsed)) throw new GatewayUnavailable('The Arcane gateway usage was not understood.');
      return { period: value.period as string, creditsUsed: value.creditsUsed as number, actionsUsed: value.actionsUsed as number };
    },
    async models() {
      const value = await json('/v1/models');
      if (!Array.isArray(value.models) || value.models.length > 32) throw new GatewayUnavailable('The Arcane gateway models were not understood.');
      return value.models.map(model => {
        const row = model as Record<string, unknown>;
        if (!row || !text(row.id, 96) || !/^[A-Za-z0-9._:/-]+$/.test(row.id as string) || !text(row.label, 64)) throw new GatewayUnavailable('The Arcane gateway models were not understood.');
        return { id: row.id as string, label: row.label as string };
      });
    },
    async *streamChat(request, signal) {
      if (!text(request.model, 96) || (request.turnId !== undefined && !(text(request.turnId, 128) && /^[A-Za-z0-9._:-]+$/.test(request.turnId))) || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 200 ||
          request.messages.some(message => !['user', 'assistant', 'system'].includes(message.role) || !text(message.content, 200000)))
        throw new GatewayUnavailable('That chat request cannot be sent.');
      const response = await call('/v1/chat/stream', { method: 'POST', body: JSON.stringify({ model: request.model, messages: request.messages, ...(request.conversationId ? { conversationId: request.conversationId } : {}), ...(request.turnId ? { turnId: request.turnId } : {}) }) }, signal);
      if (!response.body) throw new GatewayUnavailable();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength; if (bytes > MAX_STREAM_BYTES) { await reader.cancel(); yield { type: 'error', message: 'The Arcane gateway stream was too large.' }; return; }
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (chunk.type === 'delta' && text(chunk.text, 65536)) yield { type: 'delta', text: chunk.text as string };
          else if (chunk.type === 'done') { yield { type: 'done', creditsUsed: finite(chunk.creditsUsed) ? chunk.creditsUsed as number : null }; await reader.cancel(); return; }
          else if (chunk.type === 'error') { yield { type: 'error', message: text(chunk.message, 512) ? chunk.message as string : 'The Arcane gateway stopped.' }; await reader.cancel(); return; }
        }
      }
      yield { type: 'error', message: 'The Arcane gateway stream ended early.' };
    },
  };
}

/**
 * File vault in the Studio key vault style: the host supplies OS-backed encrypt/decrypt (Electron safeStorage on
 * desktop). The token is never written in plain text, and a missing encryptor means no storage at all.
 */
export function createEncryptedTokenVault(options: { file: string; encrypt: (plain: string) => Buffer; decrypt: (cipher: Buffer) => string; available: () => boolean }): ArcaneCredentialVault {
  const unavailable = () => new GatewayUnavailable('Secure credential storage is unavailable on this device.');
  const plainFile = () => { try { const stat = lstatSync(options.file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192; } catch { return false; } };
  return {
    async read() {
      if (!options.available() || !plainFile()) return null;
      try { const token = options.decrypt(readFileSync(options.file)); return TOKEN.test(token) ? token : null; } catch { return null; }
    },
    async write(token) {
      if (!TOKEN.test(token)) throw new GatewayUnavailable('That Arcane sign-in token is not valid.');
      if (!options.available()) throw unavailable();
      mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
      const temporary = options.file + '.tmp', fd = openSync(temporary, 'w', 0o600);
      try { writeSync(fd, options.encrypt(token)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, options.file);
    },
    async clear() { rmSync(options.file, { force: true }); },
  };
}
