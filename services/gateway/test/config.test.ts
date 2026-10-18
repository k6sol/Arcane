import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { migrate, MIGRATIONS, openDatabase } from '../src/db.ts';
import { ARCANE_PLANS } from '../../../packages/protocol/src/plans.ts';
import { testConfig } from './helpers.ts';

const base = { PUBLIC_URL: 'https://gateway.example.com', AUTH_SECRET: 'y'.repeat(32) };

test('default catalog grants match the app plans config', () => {
  const config = testConfig();
  for (const plan of ARCANE_PLANS.plans) assert.equal(config.catalog.find(o => o.id === plan.id)?.actionsPerMonth, plan.actionsPerMonth, plan.id);
  for (const pack of ARCANE_PLANS.packs) assert.equal(config.catalog.find(o => o.id === pack.id)?.actions, pack.actions, pack.id);
  for (const offer of ARCANE_PLANS.credits.offers) assert.equal(config.catalog.find(o => o.id === offer.id)?.credits, offer.credits, offer.id);
  assert.equal(config.catalog.find(o => o.id === 'pro')?.price, 'price_pro_test');
  assert.equal(config.catalog.find(o => o.id === 'studio')?.price, null);
});

test('config refuses unsafe settings', () => {
  assert.throws(() => loadConfig({ ...base, AUTH_SECRET: 'short' }), /AUTH_SECRET/);
  assert.throws(() => loadConfig({ ...base, PUBLIC_URL: 'http://gateway.example.com', NODE_ENV: 'production' }), /https/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /required in production/);
  assert.throws(() => loadConfig({ ...base, MAIL_MODE: 'log', NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abcdefgh123', STRIPE_WEBHOOK_SECRET: 'whsec_' + 'z'.repeat(20) }), /MAIL_MODE=log/);
  assert.throws(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abcdefgh123' }), /live payment keys/);
  assert.throws(() => loadConfig({ ...base, CORS_ORIGINS: 'https://app.example.com/' }), /CORS_ORIGINS/);
  assert.throws(() => loadConfig({ ...base, MODELS_JSON: JSON.stringify([{ id: 'm', provider: 'mock', upstream: 'x', inputPerMTok: 1, outputPerMTok: 1 }]), NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_live_abcdefgh123', STRIPE_WEBHOOK_SECRET: 'whsec_' + 'z'.repeat(20) }), /mock/);
  assert.throws(() => loadConfig({ ...base, MARKUP_BPS: '9000' }), /MARKUP_BPS/);
  const ok = loadConfig({ ...base, CORS_ORIGINS: 'https://app.example.com' });
  assert.deepEqual(ok.corsOrigins, ['https://app.example.com']); assert.equal(ok.markupBps, 12000);
});

test('migrations are forward-only and idempotent', () => {
  const db = openDatabase(':memory:');
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
  db.exec('PRAGMA user_version = ' + (MIGRATIONS.length + 1));
  assert.throws(() => migrate(db), /newer/);
  db.close();
});

test('production requires managed identity and exact account origin', () => {
  const production = { ...base, NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_reference0000', STRIPE_WEBHOOK_SECRET: 'whsec_test_reference_secret_value' };
  assert.throws(() => loadConfig(production), /managed accounts are required/);
  const managed = { ...production, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'p'.repeat(24), ACCOUNTS_SESSION_KEY: Buffer.alloc(32, 42).toString('base64url') };
  assert.ok(loadConfig(managed).accounts);
  assert.throws(() => loadConfig({ ...managed, PUBLIC_URL: base.PUBLIC_URL + '/app' }), /exact origin/);
});
