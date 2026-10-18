import type { AddressInfo } from 'node:net';
import { loadConfig, type GatewayConfig } from '../src/config.ts';
import { openDatabase } from '../src/db.ts';
import type { UpstreamStreamer } from '../src/providers.ts';
import { createGatewayServer } from '../src/server.ts';

export const MODELS = [
  { id: 'arcane-default', label: 'Arcane default', provider: 'mock', upstream: 'echo-1', inputPerMTok: 300, outputPerMTok: 1500, maxOutputTokens: 1000 },
  { id: 'arcane-fast', label: 'Arcane fast', provider: 'openai', upstream: 'fast-1', inputPerMTok: 100, outputPerMTok: 400, maxOutputTokens: 1000 },
];
export const WEBHOOK_SECRET = 'whsec_test_reference_secret_value';

export function testConfig(env: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    PUBLIC_URL: 'http://127.0.0.1:9', AUTH_SECRET: 'x'.repeat(40), DATABASE_FILE: ':memory:',
    STRIPE_SECRET_KEY: 'sk_test_reference0000', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_PRO: 'price_pro_test', STRIPE_PRICE_PACK_100: 'price_pack100_test', STRIPE_PRICE_CREDITS_10: 'price_credits10_test',
    MODELS_JSON: JSON.stringify(MODELS), MARKUP_BPS: '12000', ACTION_CREDIT_ALLOWANCE: '50', MAIL_MODE: 'log', ...env,
  });
}

export interface Harness {
  base: string; config: GatewayConfig; db: ReturnType<typeof openDatabase>; mails: { to: string; text: string }[];
  stripeCalls: { url: string; headers: Record<string, string>; body: URLSearchParams }[];
  clock: { now: number }; close(): Promise<void>;
}

export async function startHarness(options: { env?: Record<string, string>; upstream?: UpstreamStreamer } = {}): Promise<Harness> {
  const config = testConfig(options.env);
  const db = openDatabase(':memory:');
  const mails: Harness['mails'] = [], stripeCalls: Harness['stripeCalls'] = [];
  const clock = { now: Date.UTC(2026, 9, 18, 12) };
  const stripeFetch = (async (url: string | URL, init?: RequestInit) => {
    stripeCalls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body)) });
    const n = stripeCalls.length;
    return new Response(JSON.stringify({ id: 'cs_test_' + n, url: 'https://checkout.stripe.com/c/pay/cs_test_' + n }), { status: 200 });
  }) as typeof fetch;
  const upstream: UpstreamStreamer = options.upstream ?? (async function* (_c, _m, messages) {
    yield { type: 'usage', inputTokens: 1000 };
    for (const part of ['Hello', ' from', ' Arcane']) yield { type: 'delta', text: part };
    yield { type: 'usage', outputTokens: 200 };
    void messages;
  });
  const { server, close } = createGatewayServer({ config, db, upstream, fetch: stripeFetch, now: () => clock.now, log: () => {},
    sendMail: async message => { mails.push({ to: message.to, text: message.text }); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { base, config, db, mails, stripeCalls, clock,
    async close() { close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); } };
}

const form = (values: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString(), redirect: 'manual' as const });
export const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Full device-code + email-link sign-in; returns the bearer token. */
export async function signIn(h: Harness, email = 'maker@example.com'): Promise<string> {
  h.clock.now += 61_000; // fresh per-IP rate window
  const device = await (await postJson(h.base + '/v1/auth/device', {})).json() as Record<string, any>;
  await fetch(h.base + '/v1/auth/verify', form({ user_code: device.userCode, email }));
  const link = /\/v1\/auth\/confirm\?t=([A-Za-z0-9_-]+)/.exec(h.mails.at(-1)?.text ?? '')?.[1];
  if (!link) throw new Error('no sign-in mail');
  await fetch(h.base + '/v1/auth/confirm', form({ t: link }));
  h.clock.now += 6000;
  const reply = await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json() as Record<string, any>;
  if (!reply.token) throw new Error('no token: ' + JSON.stringify(reply));
  return reply.token;
}
export const formPost = form;
export const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
