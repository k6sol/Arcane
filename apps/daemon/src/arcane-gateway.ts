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
/** Credits per million tokens as the account is charged (markup included); null when the gateway does not say. */
export interface GatewayPricing { inputPerMTok: number; outputPerMTok: number }
export interface GatewayModel { id: string; label: string; pricing?: GatewayPricing | null; tools?: boolean }
/**
 * Function calling in the gateway's provider-neutral shape (docs/ARCANE_CREDITS.md): the gateway translates it to the
 * model provider's own format and back, and never runs a tool itself. The desktop runs the loop and the tools.
 */
export interface GatewayTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface GatewayToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type GatewayMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: GatewayToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; isError?: boolean };
export interface GatewayChatRequest { model: string; messages: GatewayMessage[]; conversationId?: string; turnId?: string; tools?: GatewayTool[]; maxTokens?: number }
export type GatewayStopReason = 'end' | 'tool_use' | 'max_tokens';
export type GatewayChunk = { type: 'delta'; text: string } | { type: 'tool_call'; call: GatewayToolCall } |
  { type: 'done'; creditsUsed: number | null; actionsUsed?: number; stopReason?: GatewayStopReason; inputTokens?: number; outputTokens?: number } | { type: 'error'; message: string };
/** Why a gateway call was refused, for callers that show a specific next step (Buy credits, Sign in again). */
export type GatewayErrorCode = 'unavailable' | 'signed-out' | 'insufficient-credits' | 'rate-limited';

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
  readonly code: GatewayErrorCode;
  constructor(message = 'Arcane Credits are not connected yet.', code: GatewayErrorCode = 'unavailable') { super(message); this.name = 'GatewayUnavailable'; this.code = code; }
}

const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_JSON_BYTES = 64 * 1024, MAX_STREAM_BYTES = 4 * 1024 * 1024, TIMEOUT_MS = 10000, STREAM_TIMEOUT_MS = 5 * 60000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/, TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
/** JSON size of a value, or Infinity when it cannot be serialised. */
const jsonSize = (value: unknown) => { try { return JSON.stringify(value).length; } catch { return Infinity; } };
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

export interface ArcaneGatewayOptions {
  config: PlansConfig; vault: ArcaneCredentialVault | null; fetch?: typeof fetch; localUrl?: string | null;
  /**
   * Desktop main process: the signed-in account's {base, token} from billing.cjs `accountCredential()` (already bound to
   * an allowlisted https origin). When given it replaces `config`/`localUrl`/`vault`; null means signed out or disabled.
   */
  credential?: () => Promise<{ base: string; token: string } | null>;
  /** Overall bound of one streamed chat request (default 5 minutes). */
  streamTimeoutMs?: number;
}

/** An https base URL without userinfo, query or fragment; null otherwise. */
function credentialBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.origin + url.pathname.replace(/\/+$/, '') : null; } catch { return null; }
}
/** Validated outgoing chat request; throws the fixed refusal when anything is out of bounds. */
function chatBody(request: GatewayChatRequest): Record<string, unknown> {
  const refuse = () => { throw new GatewayUnavailable('That chat request cannot be sent.'); };
  if (!text(request.model, 96) || (request.turnId !== undefined && !(text(request.turnId, 128) && /^[A-Za-z0-9._:-]+$/.test(request.turnId))) || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 200) refuse();
  const tools = request.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 64 || new Set(tools.map(tool => tool?.name)).size !== tools.length || jsonSize(tools) > 262144 ||
      tools.some(tool => !tool || !TOOL_NAME.test(tool.name) || typeof tool.description !== 'string' || tool.description.length > 4096 || !plainObject(tool.inputSchema) || jsonSize(tool.inputSchema) > 32768)) refuse();
  for (const message of request.messages) {
    if (!message || !['user', 'assistant', 'system', 'tool'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 200000 || /[\u0000-\u0008]/.test(message.content)) refuse();
    if (message.role === 'tool' && (!tools.length || !TOOL_CALL_ID.test(message.toolCallId) || !(message.isError === undefined || typeof message.isError === 'boolean'))) refuse();
    if (message.role === 'assistant' && message.toolCalls !== undefined && (!tools.length || !Array.isArray(message.toolCalls) || !message.toolCalls.length || message.toolCalls.length > 32 ||
        message.toolCalls.some(call => !TOOL_CALL_ID.test(call?.id) || !TOOL_NAME.test(call?.name) || !plainObject(call.arguments) || jsonSize(call.arguments) > 65536))) refuse();
  }
  if (request.maxTokens !== undefined && !(Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0 && request.maxTokens <= 1_000_000)) refuse();
  return { model: request.model, messages: request.messages, ...(tools.length ? { tools } : {}), ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}), ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}) };
}
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
/** One `data:` event of the chat stream as a chunk; null for unknown or malformed events. */
function chatChunk(chunk: Record<string, unknown>): GatewayChunk | null {
  if (chunk.type === 'delta') return text(chunk.text, 65536) ? { type: 'delta', text: chunk.text as string } : null;
  if (chunk.type === 'tool_call') {
    return typeof chunk.id === 'string' && TOOL_CALL_ID.test(chunk.id) && typeof chunk.name === 'string' && TOOL_NAME.test(chunk.name) && plainObject(chunk.arguments) && jsonSize(chunk.arguments) <= 262144
      ? { type: 'tool_call', call: { id: chunk.id, name: chunk.name, arguments: chunk.arguments } } : { type: 'error', message: 'The Arcane gateway sent an unreadable tool call.' };
  }
  if (chunk.type === 'done') {
    const reason = ['end', 'tool_use', 'max_tokens'].includes(chunk.stopReason as string) ? chunk.stopReason as GatewayStopReason : undefined;
    return { type: 'done', creditsUsed: finite(chunk.creditsUsed) ? chunk.creditsUsed as number : null, ...(count(chunk.actionsUsed) ? { actionsUsed: chunk.actionsUsed as number } : {}),
      ...(reason ? { stopReason: reason } : {}), ...(count(chunk.inputTokens) ? { inputTokens: chunk.inputTokens as number } : {}), ...(count(chunk.outputTokens) ? { outputTokens: chunk.outputTokens as number } : {}) };
  }
  if (chunk.type === 'error') return { type: 'error', message: text(chunk.message, 512) ? chunk.message as string : 'The Arcane gateway stopped.' };
  return null;
}
function readPricing(value: unknown): GatewayPricing | null {
  const row = plainObject(value) ? value : null;
  return row && Number.isSafeInteger(row.inputPerMTok) && Number.isSafeInteger(row.outputPerMTok) && (row.inputPerMTok as number) >= 0 && (row.outputPerMTok as number) >= 0 &&
    (row.inputPerMTok as number) <= 1e9 && (row.outputPerMTok as number) <= 1e9 ? { inputPerMTok: row.inputPerMTok as number, outputPerMTok: row.outputPerMTok as number } : null;
}

export function createArcaneGateway(options: ArcaneGatewayOptions): ArcaneGatewayProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const ready = async (): Promise<{ base: string; token: string }> => {
    if (options.credential) {
      const credential = await options.credential().catch(() => null), base = credentialBase(credential?.base);
      if (!credential || !base) throw new GatewayUnavailable('Sign in to your Arcane account to use credits.', 'signed-out');
      if (!TOKEN.test(credential.token)) throw new GatewayUnavailable('Sign in to your Arcane account to use credits.', 'signed-out');
      return { base, token: credential.token };
    }
    const base = gatewayBase(options.config, options.localUrl);
    if (!base) throw new GatewayUnavailable();
    const token = await options.vault?.read() ?? null;
    if (!token || !TOKEN.test(token)) throw new GatewayUnavailable('Sign in to your Arcane account to use credits.', 'signed-out');
    return { base, token };
  };
  const call = async (path: string, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Response> => {
    const { base, token } = await ready();
    const url = new URL(base + path);
    if (url.origin !== new URL(base).origin) throw new GatewayUnavailable();
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await doFetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw response.status === 401 ? new GatewayUnavailable('Your Arcane sign-in expired. Sign in again.', 'signed-out')
        : response.status === 402 ? new GatewayUnavailable('You are out of Arcane Credits.', 'insufficient-credits')
        : response.status === 429 ? new GatewayUnavailable('Too many Arcane requests right now. Try again in a minute.', 'rate-limited')
        : new GatewayUnavailable('The Arcane gateway is unavailable.');
    }
    return response;
  };
  const json = async (path: string): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(await readBounded(await call(path), MAX_JSON_BYTES));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayUnavailable('The Arcane gateway reply was not understood.');
    return value as Record<string, unknown>;
  };
  return {
    id: ARCANE_PROVIDER_ID,
    async status() {
      if (options.credential) {
        const signedIn = !!credentialBase((await options.credential().catch(() => null))?.base);
        return signedIn ? { provider: ARCANE_PROVIDER_ID, state: 'ready', showInModelPicker: true, message: 'Arcane Credits are ready.' }
          : { provider: ARCANE_PROVIDER_ID, state: 'signed-out', showInModelPicker: false, message: 'Sign in to your Arcane account to use credits.' };
      }
      return gatewayStatus(options.config, !!(await options.vault?.read().catch(() => null)), options.localUrl);
    },
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
        // Older gateways send only id and label; pricing and tool support are optional additions.
        const pricing = readPricing(row.pricing);
        return { id: row.id as string, label: row.label as string, ...(pricing ? { pricing } : {}), ...(typeof row.tools === 'boolean' ? { tools: row.tools } : {}) };
      });
    },
    async *streamChat(request, signal) {
      const body = chatBody(request);
      const response = await call('/v1/chat/stream', { method: 'POST', body: JSON.stringify(body) }, signal, options.streamTimeoutMs ?? STREAM_TIMEOUT_MS);
      if (!response.body) throw new GatewayUnavailable();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength; if (bytes > MAX_STREAM_BYTES) { await reader.cancel(); yield { type: 'error', message: 'The Arcane gateway stream was too large.' }; return; }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let raw: Record<string, unknown>;
          try { raw = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const chunk = raw && typeof raw === 'object' && !Array.isArray(raw) ? chatChunk(raw) : null;
          if (!chunk) continue;
          yield chunk;
          if (chunk.type === 'done' || chunk.type === 'error') { await reader.cancel(); return; }
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
