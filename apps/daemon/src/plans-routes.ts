/**
 * Plans & credits routes (human bearer only) plus daemon-side action metering.
 *
 * GET  /v1/plans/state     catalog (display only), billing/gateway connection state and local action usage.
 * POST /v1/plans/checkout  {kind,id} -> the single checkout seam. Without a configured AND verified billing service
 *                          it answers "not-connected"; nothing is charged and no balance is granted locally, ever.
 * POST /v1/actions/record  {source:'claude',turnId,conversationId} for finished Claude chat turns, which run in the
 *                          desktop host rather than this daemon. Codex turns and Studio changes are observed here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WRITE_METHODS } from '../../../packages/protocol/src/studio.js';
import { ARCANE_PLANS, publicCatalog, resolveCheckout, serviceBase, validatePlansConfig, type OfferKind, type PlansConfig } from '../../../packages/protocol/src/plans.js';
import { ActionsLedger } from './actions-ledger.js';
import { gatewayStatus } from './arcane-gateway.js';

export interface PlansRouteOptions {
  ledger: ActionsLedger;
  config?: PlansConfig;
  fetch?: typeof fetch;
  /** Trusted daemon accessors; failures are ignored because metering must never break work. */
  codexState?: () => unknown;
  studioEvents?: () => unknown[];
  /** Whether an Arcane account token is present in the host vault. */
  gatewaySignedIn?: () => boolean;
  now?: () => Date;
}

const CHARGEABLE_STUDIO = new Set<string>(WRITE_METHODS.filter(method => method !== 'scene.restore'));
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function plansRoutes(options: PlansRouteOptions) {
  const config = validatePlansConfig(options.config ?? ARCANE_PLANS);
  const now = options.now ?? (() => new Date());
  let lastObserved = 0;
  let billingCheck: { at: number; verified: boolean; base: string } | null = null;

  /** Reads trusted daemon state for newly finished Codex turns and applied Studio changes. */
  function observe(force = false): void {
    const at = Date.now();
    if (!force && at - lastObserved < 1000) return;
    lastObserved = at;
    try {
      const state = record(options.codexState?.());
      const thread = record(record(state?.snapshot)?.thread);
      if (thread && thread.turnStatus === 'completed' && typeof thread.turnId === 'string')
        options.ledger.record({ kind: 'build-turn', source: 'codex', id: thread.turnId, conversation: typeof thread.threadId === 'string' ? thread.threadId : null });
    } catch { /* Metering is informational. */ }
    try {
      for (const raw of options.studioEvents?.() ?? []) {
        const event = record(raw), detail = record(event?.detail);
        if (event?.kind !== 'command_succeeded' || typeof event.entityId !== 'string' || !CHARGEABLE_STUDIO.has(String(detail?.method))) continue;
        const when = typeof event.occurredAt === 'string' ? new Date(event.occurredAt) : undefined;
        options.ledger.record({ kind: 'studio-change', source: 'studio', id: event.entityId, conversation: typeof detail?.sessionId === 'string' ? detail.sessionId : null, ...(when ? { at: when } : {}) });
      }
    } catch { /* Metering is informational. */ }
  }

  /** A billing service counts as connected only after its health endpoint answers as an Arcane billing service. */
  async function billingVerified(): Promise<boolean> {
    const base = serviceBase(config.billing);
    if (!base) return false;
    if (billingCheck && billingCheck.base === base && Date.now() - billingCheck.at < (billingCheck.verified ? 600000 : 60000)) return billingCheck.verified;
    let verified = false;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(base + '/v1/health', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      const text = response.ok ? (await response.text()).slice(0, 4096) : '';
      const value = record(text ? JSON.parse(text) : null);
      verified = value?.service === 'arcane-billing' && value.version === 1;
    } catch { verified = false; }
    billingCheck = { at: Date.now(), verified, base };
    return verified;
  }

  async function state() {
    observe(true);
    const configured = !!serviceBase(config.billing), verified = configured && await billingVerified();
    return {
      catalog: publicCatalog(config),
      billing: { state: !configured ? 'not-configured' : verified ? 'ready' : 'unverified' as 'not-configured' | 'ready' | 'unverified',
        /** The only origin the desktop may open for checkout, and only once verified. */
        origins: verified ? [new URL(serviceBase(config.billing)!).origin] : [] },
      gateway: gatewayStatus(config, options.gatewaySignedIn?.() ?? false),
      usage: options.ledger.summary(now()),
    };
  }

  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  const human = (request: IncomingMessage, token: string) => {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    return Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };
  async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    if (!request.headers['content-type']?.startsWith('application/json')) return null;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      bytes += chunk.length; if (bytes > 2048) return null; chunks.push(chunk);
    }
    try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return null; }
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, token: string, origin: string): Promise<boolean> {
    const path = url.pathname;
    if (path !== '/v1/plans/state' && path !== '/v1/plans/checkout' && path !== '/v1/actions/record') {
      if (path.startsWith('/v1/codex/') || path.startsWith('/v1/studio/')) observe();
      return false;
    }
    if (!human(request, token)) { send(response, 401, { error: 'AUTH', message: 'Plans and usage are available to the signed-in desktop only.' }); return true; }
    if (request.headers.origin && request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Cross-origin access refused.' }); return true; }
    if (path === '/v1/plans/state') {
      if (request.method !== 'GET') { send(response, 405, { error: 'METHOD' }); return true; }
      send(response, 200, await state()); return true;
    }
    if (request.method !== 'POST') { send(response, 405, { error: 'METHOD' }); return true; }
    if (request.headers.origin !== origin) { send(response, 403, { error: 'ORIGIN', message: 'Writes require the local panel origin.' }); return true; }
    const input = await body(request);
    if (!input) { send(response, 400, { error: 'INPUT', message: 'Expected a small JSON object.' }); return true; }
    if (path === '/v1/plans/checkout') {
      const kind = input.kind, id = input.id;
      if (!['plan', 'pack', 'credits'].includes(String(kind)) || typeof id !== 'string' || Object.keys(input).length !== 2) { send(response, 400, { error: 'INPUT', message: 'Choose one offer.' }); return true; }
      const verified = await billingVerified();
      send(response, 200, resolveCheckout(config, kind as OfferKind, id, verified)); return true;
    }
    // Claude chat turns finish in the desktop host; the renderer reports each finished turn exactly once by id.
    if (input.source !== 'claude' || typeof input.turnId !== 'string' || !ID.test(input.turnId) || !(input.conversationId === null || typeof input.conversationId === 'string' && ID.test(input.conversationId)) || Object.keys(input).length !== 3) {
      send(response, 400, { error: 'INPUT', message: 'Expected one finished Claude turn.' }); return true;
    }
    const recorded = options.ledger.record({ kind: 'build-turn', source: 'claude', id: input.turnId, conversation: input.conversationId as string | null });
    send(response, 200, { recorded, usage: options.ledger.summary(now()) }); return true;
  }

  return { handle, observe, state };
}
