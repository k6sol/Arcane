import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DaemonClient, BridgeError } from '../../apps/mcp/src/daemon-client.js';

// Synthetic bearer strings and an owned ephemeral loopback server only.
const CORE = 'fixture-core-project-bearer', ASSET = 'b'.repeat(64);
const JOB = '11111111-1111-4111-8111-111111111111';
async function fixture(t: TestContext) {
  const calls: { path: string; method: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url!, method: req.method!, auth: req.headers.authorization });
    req.resume();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Rejected ' + CORE + ' / ' + ASSET }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { calls, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port };
}
const refused = (error: unknown) => error instanceof BridgeError && error.code === 'FORBIDDEN' && error.rejected &&
  !error.message.includes(CORE) && !error.message.includes(ASSET);

test('separate asset bearer stays private and requires an explicit native audience', () => {
  for (const token of ['', ASSET + '\n', ASSET.toUpperCase(), 'b'.repeat(63), 'b'.repeat(65), CORE, null, 123]) {
    assert.throws(() => new DaemonClient({ url: 'http://127.0.0.1:1', token: CORE, assetAudience: 'native-session', assetToken: token as string }),
      (error: unknown) => error instanceof BridgeError && error.code === 'CONFIG_ASSET_TOKEN' && !error.message.includes(ASSET));
  }
  assert.throws(() => new DaemonClient({ url: 'http://127.0.0.1:1', token: CORE, assetToken: ASSET }), /separate asset bearer/);
  assert.throws(() => new DaemonClient({ url: 'http://127.0.0.1:1', token: ASSET, assetAudience: 'native-session', assetToken: ASSET }), /separate asset bearer/);
  const client = new DaemonClient({ url: 'http://127.0.0.1:1', token: CORE, assetAudience: 'native-session', assetToken: ASSET });
  assert.equal(client.assetAudience, 'native-session');
  assert.ok(!JSON.stringify(client).includes(CORE) && !JSON.stringify(client).includes(ASSET));
  assert.deepEqual(client.redact({ core: CORE, asset: ASSET, text: CORE + ' ' + ASSET }),
    { core: '[redacted]', asset: '[redacted]', text: '[redacted] [redacted]' });
});

test('environment asset credentials require fixed audience and preserve legacy single-bearer clients', () => {
  const env = { ARCANE_DAEMON_URL: 'http://127.0.0.1:1', ARCANE_LOCAL_TOKEN: CORE };
  assert.equal(DaemonClient.fromEnvironment(env).assetAudience, 'generic');
  assert.equal(DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_AUDIENCE: 'native-session' }).assetAudience, 'native-session');
  assert.throws(() => DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_TOKEN: ASSET }), /separate asset bearer/);
  assert.throws(() => DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_AUDIENCE: 'generic', ARCANE_ASSET_TOKEN: ASSET }), /ARCANE_ASSET_AUDIENCE/);
  const client = DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_AUDIENCE: 'native-session', ARCANE_ASSET_TOKEN: ASSET });
  assert.deepEqual(client.redact([CORE, ASSET]), ['[redacted]', '[redacted]']);
});

test('native JSON and preview routes use only the asset bearer and never retry with the project bearer', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const client = new DaemonClient({ url: f.url, token: CORE, assetAudience: 'native-session', assetToken: ASSET });
  await assert.rejects(client.assetsProbe(), refused);
  await assert.rejects(client.assetsStart({ template: 'hero-prop', name: 'fixture' }), refused);
  await assert.rejects(client.assetsJobs({ limit: 3 }), refused);
  await assert.rejects(client.assetsPreview(JOB, 'preview-hero.png'), refused);
  assert.deepEqual(f.calls, [
    { path: '/v1/assets/native/probe', method: 'POST', auth: 'Bearer ' + ASSET },
    { path: '/v1/assets/native/start', method: 'POST', auth: 'Bearer ' + ASSET },
    { path: '/v1/assets/native/jobs?limit=3', method: 'GET', auth: 'Bearer ' + ASSET },
    { path: '/v1/assets/native/preview?jobId=' + JOB + '&path=preview-hero.png', method: 'GET', auth: 'Bearer ' + ASSET },
  ]);
});

test('an import rejection preserves unknown work without credential fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const client = new DaemonClient({ url: f.url, token: CORE, assetAudience: 'native-session', assetToken: ASSET });
  const result = await client.assetsStageStudioImport(JOB);
  assert.ok('state' in result && 'ambiguous' in result);
  assert.equal(result.state, 'unknown');
  assert.equal(result.ambiguous, true);
  assert.ok(!JSON.stringify(result).includes(CORE) && !JSON.stringify(result).includes(ASSET));
  assert.deepEqual(f.calls, [{ path: '/v1/assets/native/stage-studio-import', method: 'POST', auth: 'Bearer ' + ASSET }]);
});

test('separate asset credentials cannot substitute for ordinary project authority', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const client = new DaemonClient({ url: f.url, token: CORE, assetAudience: 'native-session', assetToken: ASSET });
  await assert.rejects(client.sessions(), refused);
  await assert.rejects(client.workRuns(), refused);
  assert.deepEqual(f.calls, [
    { path: '/v1/studio/sessions', method: 'GET', auth: 'Bearer ' + CORE },
    { path: '/v1/work/runs', method: 'GET', auth: 'Bearer ' + CORE },
  ]);
});

test('legacy generic and native single-bearer routing remains unchanged', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const generic = new DaemonClient({ url: f.url, token: CORE });
  const native = new DaemonClient({ url: f.url, token: CORE, assetAudience: 'native-session' });
  await assert.rejects(generic.assetsProbe(), (error: unknown) => error instanceof BridgeError && error.code === 'FORBIDDEN');
  await assert.rejects(native.assetsProbe(), (error: unknown) => error instanceof BridgeError && error.code === 'FORBIDDEN');
  assert.deepEqual(f.calls, [
    { path: '/v1/assets/probe', method: 'POST', auth: 'Bearer ' + CORE },
    { path: '/v1/assets/native/probe', method: 'POST', auth: 'Bearer ' + CORE },
  ]);
});
