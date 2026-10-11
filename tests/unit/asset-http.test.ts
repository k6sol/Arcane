import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, link, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { assetRoutes } from '../../apps/daemon/src/asset-routes.js';
import { createAssetPipeline, AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { manifestFixture } from '../../packages/asset-pipeline/testing/fixture.js';
import { noLinks, readRegularFile, within } from '../../packages/asset-pipeline/src/paths.js';

const ROOT = resolve(process.cwd()), TEMP = join(ROOT, 'packages', 'asset-pipeline', '.runtime', 'http-tests');
const TOKEN = 'synthetic-control-token-for-unit-tests';
const AGENT_TOKEN = 'distinct-synthetic-agent-token-for-unit-tests';
const missing = (dir: string) => ({ blenderExecutable: join(dir, 'not-installed-blender.exe'), pythonExecutable: join(dir, 'not-installed-python.exe') });
async function temporary(t: test.TestContext, beforeRemove?: () => Promise<void>) {
  await mkdir(TEMP, { recursive: true });
  const dir = await mkdtemp(join(TEMP, 'asset-http-'));
  t.after(async () => { await beforeRemove?.(); assert.ok(within(TEMP, dir)); await noLinks(dir); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function fixtureJob(outputRoot: string) {
  const jobId = '11111111-1111-4111-8111-111111111111', directory = join(outputRoot, 'test-kit-' + jobId);
  await mkdir(directory, { recursive: true });
  const manifest = await manifestFixture(directory);
  await writeFile(join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, state: 'succeeded', request: manifest.request,
    directory: '/untrusted/outside', manifestPath: '/untrusted/outside/manifest.json', error: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }));
  return { jobId, directory, manifest };
}
async function harness(t: test.TestContext, withFixture = false) {
  let cleanup = async () => {};
  const dir = await temporary(t, () => cleanup()), outputRoot = join(dir, 'assets');
  const fixture = withFixture ? await fixtureJob(outputRoot) : null;
  const service = await createAssetService({ cwd: ROOT, outputRoot, projectPath: resolve(ROOT, '..', 'other-project'), ...missing(dir) });
  const route = assetRoutes(service);
  let origin = '';
  const server = createServer(async (req, res) => {
    if (!await route(req, res, new URL(req.url ?? '/', origin), TOKEN, origin, AGENT_TOKEN)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  cleanup = async () => {
    try { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
    finally { await service.close(); }
  };
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      const response = await fetch(origin + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...init.headers } });
      await response.clone().arrayBuffer();
      return response;
    } catch (cause) { throw new Error('HTTP test request failed: ' + (init.method ?? 'GET') + ' ' + path, { cause }); }
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: 'POST', body: JSON.stringify(body), headers });
  return { dir, outputRoot, fixture, service, origin, server, call, post };
}

test('asset controller requires control bearer, exact loopback Host, and matching optional Origin', async t => {
  const h = await harness(t);
  assert.equal((await fetch(h.origin + '/v1/assets/jobs')).status, 401);
  for (const auth of ['Bearer wrong', 'Basic ' + TOKEN, 'Bearer ' + TOKEN + 'x']) assert.equal((await h.call('/v1/assets/jobs', { headers: { Authorization: auth } })).status, 401);
  for (const origin of ['null', 'https://evil.invalid', h.origin + '/', h.origin.replace('127.0.0.1', 'localhost')]) assert.equal((await h.call('/v1/assets/jobs', { headers: { Origin: origin } })).status, 403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(h.origin + '/v1/assets/jobs', { headers: { Host: 'evil.invalid', Authorization: 'Bearer ' + TOKEN } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await h.call('/v1/assets/jobs', { headers: { Authorization: 'Bearer ' + AGENT_TOKEN } })).status, 200);
  assert.equal((await h.post('/v1/assets/probe', {}, { Authorization: 'Bearer ' + AGENT_TOKEN })).status, 200);
  assert.equal((await h.post('/v1/assets/probe', {}, { Authorization: 'Bearer ' + AGENT_TOKEN, Origin: 'null' })).status, 403);
  assert.equal((await h.post('/v1/assets/probe', {}, { Origin: h.origin })).status, 200);
  const native = await h.post('/v1/assets/probe', {}); assert.equal(native.status, 200); assert.equal((await native.json() as { probe: { available: boolean } }).probe.available, false);
});

test('asset routes enforce exact methods, bounded JSON, query shape, and fixed-template inputs', async t => {
  const h = await harness(t);
  for (const path of ['unknown', 'constructor', '__proto__', 'toString']) assert.equal((await h.call('/v1/assets/' + path)).status, 404);
  assert.equal((await h.call('/v1/assets/start')).status, 405);
  assert.equal((await h.post('/v1/assets/jobs', {})).status, 405);
  assert.equal((await h.post('/v1/assets/probe', { outputRoot: '/outside' })).status, 400);
  assert.equal((await h.post('/v1/assets/start', { template: 'arbitrary', name: 'no' })).status, 400);
  assert.equal((await h.post('/v1/assets/start', { template: 'hero-prop', name: 'safe', script: 'arbitrary' })).status, 400);
  assert.equal((await h.post('/v1/assets/cancel', { jobId: '../escape' })).status, 400);
  assert.equal((await h.post('/v1/assets/cancel', { jobId: randomUUID(), path: '/outside' })).status, 400);
  assert.equal((await h.call('/v1/assets/jobs?path=/outside')).status, 400);
  assert.equal((await h.call('/v1/assets/manifest?jobId=a&jobId=b')).status, 400);
  assert.equal((await h.call('/v1/assets/probe', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await h.call('/v1/assets/probe', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await h.call('/v1/assets/probe', { method: 'POST', body: '{}', headers: { 'Content-Encoding': 'gzip' } })).status, 400);
  const oversized = await h.call('/v1/assets/start', { method: 'POST', body: 'x'.repeat(16385) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as { error: string }).error, 'BODY_LIMIT');
  assert.equal(h.service.jobs().length, 0);
});

test('chunked asset bodies enforce the byte limit before JSON parsing', async t => {
  const h = await harness(t);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(h.origin + '/v1/assets/probe', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.write('x'.repeat(12000)); req.end('y'.repeat(8000));
  });
  assert.equal(status, 413);
});

test('rejected content-length and chunked bodies finish before reusable keep-alive responses', async t => {
  const h = await harness(t), agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const body = Buffer.alloc(16385, 120);
  const call = (chunked: boolean, delayed: boolean) => new Promise<{ status: number; error: string; socket: unknown; connection: string | undefined }>((resolve, reject) => {
    let socket: unknown;
    const req = httpRequest(h.origin + '/v1/assets/start', { agent, method: 'POST', headers: {
      Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
      ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(body.length) })
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.once('error', reject); res.once('aborted', () => reject(new Error('Rejected response was aborted.')));
      res.once('end', () => {
        try {
          assert.equal(req.writableFinished, true, 'A small rejected upload must be drained before replying.');
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error: string };
          resolve({ status: res.statusCode!, error: payload.error, socket, connection: res.headers.connection });
        } catch (e) { reject(e); }
      });
    });
    req.once('socket', value => { socket = value; }); req.once('error', reject);
    if (delayed) {
      h.server.once('request', () => { setTimeout(() => req.end(body), 25); });
      req.flushHeaders();
    } else req.end(body);
  });
  let firstSocket: unknown;
  for (let index = 0; index < 24; index++) {
    const response = await call(index % 2 === 1, index < 2);
    assert.equal(response.status, 413); assert.equal(response.error, 'BODY_LIMIT');
    assert.notEqual(response.connection, 'close');
    firstSocket ??= response.socket;
    assert.equal(response.socket, firstSocket, 'Every refused complete body must leave the same connection reusable.');
  }
  assert.equal(h.service.jobs().length, 0);
  assert.equal((await h.call('/v1/assets/jobs')).status, 200);
});

test('rejected stalled uploads close after a bounded discard without creating work', { timeout: 5000 }, async t => {
  const h = await harness(t), address = h.server.address(); assert.ok(address && typeof address !== 'string');
  const started = Date.now();
  const result = await new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1'); let response = '';
    socket.on('error', reject); socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('close', () => resolve(response));
    socket.once('connect', () => socket.write('POST /v1/assets/start HTTP/1.1\r\nHost: ' + new URL(h.origin).host + '\r\nAuthorization: Bearer ' + TOKEN + '\r\nContent-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n'));
  });
  assert.match(result, /HTTP\/1.1 413/); assert.match(result, /Connection: close/i); assert.match(result, /"error":"BODY_LIMIT"/);
  assert.ok(Date.now() - started < 3000, 'Rejected upload cleanup cannot wait for the normal body deadline.');
  assert.equal(h.service.jobs().length, 0);
});

test('slow body deadline is absolute even when bytes keep arriving', { timeout: 12000 }, async t => {
  const h = await harness(t), address = h.server.address(); assert.ok(address && typeof address !== 'string');
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1'); let data = '';
    socket.on('error', reject);
    socket.on('data', b => { data += b.toString(); });
    socket.on('close', () => resolve(data));
    const interval = setInterval(() => socket.write(' '), 200);
    socket.on('close', () => clearInterval(interval));
    socket.on('connect', () => socket.write('POST /v1/assets/probe HTTP/1.1\r\nHost: ' + new URL(h.origin).host + '\r\nAuthorization: Bearer ' + TOKEN + '\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{'));
  });
  assert.match(response, /HTTP\/1.1 408/);
});

test('manifest and raw PNG routes use verified indexed job identities and manifest-approved names', async t => {
  const h = await harness(t, true), f = h.fixture!;
  const jobs = await (await h.call('/v1/assets/jobs')).json() as { jobs: { jobId: string; directory: string; manifestPath: string; manifestAvailable: boolean }[] };
  assert.equal(jobs.jobs[0]!.jobId, f.jobId); assert.equal(jobs.jobs[0]!.directory, f.directory);
  assert.equal(jobs.jobs[0]!.manifestPath, join(f.directory, 'manifest.json')); assert.equal(jobs.jobs[0]!.manifestAvailable, true);
  const result = await h.call('/v1/assets/manifest?jobId=' + f.jobId); assert.equal(result.status, 200);
  assert.equal((await result.json() as { manifest: { jobId: string } }).manifest.jobId, f.jobId);
  const preview = await h.call('/v1/assets/preview?jobId=' + f.jobId + '&path=preview-hero.png');
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png'); assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), await readFile(join(f.directory, 'preview-hero.png')));
  for (const path of ['../preview-hero.png', 'C:\\outside.png', 'asset.blend', 'manifest.json', 'preview-hero.png:stream', 'preview-other.png']) assert.equal((await h.call('/v1/assets/preview?jobId=' + f.jobId + '&path=' + encodeURIComponent(path))).status, 400);
  assert.equal((await fetch(h.origin + '/v1/assets/preview?jobId=' + f.jobId + '&path=preview-hero.png')).status, 401);
  assert.equal((await h.call('/v1/assets/manifest?jobId=' + randomUUID())).status, 404);
  await writeFile(join(f.directory, 'preview-hero.png'), Buffer.alloc(f.manifest.artifacts.find(a => a.path === 'preview-hero.png')!.bytes));
  assert.equal((await h.call('/v1/assets/preview?jobId=' + f.jobId + '&path=preview-hero.png')).status, 422);
});

test('linked artifact files and linked job ancestors cannot be served', async t => {
  const h = await harness(t, true), f = h.fixture!, actual = join(f.directory, 'preview-hero.png'), saved = join(h.dir, 'outside.png');
  await rename(actual, saved); await link(saved, actual);
  assert.equal((await h.call('/v1/assets/preview?jobId=' + f.jobId + '&path=preview-hero.png')).status, 422);
  await rm(actual); await rename(saved, actual);
  const moved = join(h.dir, 'moved-job');
  await rename(f.directory, moved); await symlink(moved, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.call('/v1/assets/preview?jobId=' + f.jobId + '&path=preview-hero.png')).status, 400);
  await rm(f.directory); await rename(moved, f.directory);
});

test('service start/cancel/restart retains terminal jobs and never uses the selected project as worker root', async t => {
  const h = await harness(t);
  const response = await h.post('/v1/assets/start', { template: 'hero-prop', name: 'cancel-fixture' }); assert.equal(response.status, 202);
  const { job } = await response.json() as { job: { jobId: string } };
  const cancelled = await h.post('/v1/assets/cancel', { jobId: job.jobId }); assert.equal(cancelled.status, 200);
  const completed = await cancelled.json() as { job: { state: string; error: { code: string }; manifestPath: null; events: unknown[] } };
  assert.ok(['failed', 'cancelled'].includes(completed.job.state)); assert.equal(completed.job.manifestPath, null);
  assert.equal((await h.call('/v1/assets/manifest?jobId=' + job.jobId)).status, 409);
  await h.service.close();
  const next = await createAssetService({ cwd: ROOT, outputRoot: h.outputRoot, ...missing(h.dir) });
  try {
    const restored = next.jobs().find(j => j.jobId === job.jobId)!;
    assert.equal(restored.state, completed.job.state); assert.equal(restored.manifestAvailable, false);
    assert.deepEqual(restored.events, completed.job.events);
    assert.equal((JSON.parse(await readFile(join(h.outputRoot, 'index.json'), 'utf8')) as { jobs: unknown[] }).jobs.length, 1);
  } finally { await next.close(); }
});

test('lost supervision is recovered without automatic replay and blocks a new job in the same root', async t => {
  const dir = await temporary(t), outputRoot = join(dir, 'assets'), jobId = randomUUID(), jobDir = join(outputRoot, 'lost-' + jobId);
  await mkdir(jobDir, { recursive: true });
  const request = normalizeRequest({ template: 'hero-prop', name: 'lost' });
  await writeFile(join(jobDir, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, state: 'running', request, error: null, directory: '/outside' }));
  const service = await createAssetService({ cwd: ROOT, outputRoot, ...missing(dir) });
  try {
    assert.equal(service.jobs()[0]!.state, 'interrupted'); assert.equal(service.jobs()[0]!.error?.code, 'SUPERVISION_LOST');
    await assert.rejects(() => service.start(request), (e: unknown) => (e as { code?: string }).code === 'RECONCILIATION');
    assert.equal((JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8')) as { state: string }).state, 'interrupted');
    await assert.rejects(() => service.cancel(jobId).then(j => service.manifest(j.jobId)));
  } finally { await service.close(); }
});

test('job identity tampering fails history verification and forged index paths are never used', async t => {
  const dir = await temporary(t), outputRoot = join(dir, 'assets'), f = await fixtureJob(outputRoot);
  await writeFile(join(outputRoot, 'index.json'), JSON.stringify({ schemaVersion: 1, jobs: [{ jobId: f.jobId, directory: '/outside', state: 'succeeded', events: [] }] }));
  const wrong = { ...f.manifest, jobId: randomUUID() };
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(wrong));
  const service = await createAssetService({ cwd: ROOT, outputRoot, ...missing(dir) });
  try {
    assert.equal(service.jobs()[0]!.state, 'failed'); assert.equal(service.jobs()[0]!.error?.code, 'HISTORY_INTEGRITY');
    assert.equal(service.jobs()[0]!.directory, f.directory);
    await assert.rejects(() => service.preview(f.jobId, 'preview-hero.png'));
  } finally { await service.close(); }
});

test('supervisor busy is normal; one service owns a root and close waits for cancellation', async t => {
  const dir = await temporary(t), outputRoot = join(dir, 'assets');
  const service = await createAssetService({ cwd: ROOT, outputRoot, ...missing(dir) });
  await assert.rejects(() => createAssetService({ cwd: ROOT, outputRoot }), (e: unknown) => e instanceof AssetError && e.code === 'BUSY');
  const probe = service.probe();
  await assert.rejects(() => service.probe(), (e: unknown) => e instanceof AssetError && e.code === 'BUSY');
  await assert.rejects(() => service.start({ template: 'hero-prop', name: 'busy' }), (e: unknown) => e instanceof AssetError && e.code === 'BUSY');
  await probe;
  await service.start({ template: 'hero-prop', name: 'shutdown' });
  await service.close();
  await assert.rejects(() => service.start({ template: 'hero-prop', name: 'closed' }), (e: unknown) => (e as { code?: string }).code === 'CLOSED');
  const next = await createAssetService({ cwd: ROOT, outputRoot, ...missing(dir) });
  await next.close();
});

test('bounded regular reader rejects directories, excess size and hardlinks', async t => {
  const dir = await temporary(t), file = join(dir, 'file'), linked = join(dir, 'linked');
  await writeFile(file, Buffer.alloc(10, 4)); assert.equal((await readRegularFile(file, 10)).length, 10);
  await assert.rejects(() => readRegularFile(file, 9));
  await assert.rejects(() => readRegularFile(dir, 100));
  await link(file, linked); await assert.rejects(() => readRegularFile(file, 100));
});
