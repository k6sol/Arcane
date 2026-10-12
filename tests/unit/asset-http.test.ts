import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile, rm, symlink, link, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ARTIFACT_DOWNLOAD_BYTES, ARTIFACT_DOWNLOAD_TIMEOUT_MS, createAssetService } from '../../apps/daemon/src/asset-service.js';
import { assetRoutes } from '../../apps/daemon/src/asset-routes.js';
import { createAssetPipeline, AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { glb, manifestFixture } from '../../packages/asset-pipeline/testing/fixture.js';
import { noLinks, readRegularFile, within } from '../../packages/asset-pipeline/src/paths.js';
import { sha256 } from '../../packages/asset-pipeline/src/validation.js';

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

test('custom HTTP input retains recipe authority, rejects code and enforces custom byte bounds', async t => {
  const h=await harness(t);
  const input=JSON.parse(await readFile(join(ROOT,'workers/blender/custom-machine.json'),'utf8'));
  for(const field of ['python','path','url','shell']){
    const bad=structuredClone(input);bad.recipe.parts[0][field]='arbitrary';
    assert.equal((await h.post('/v1/assets/start',bad)).status,400);
  }
  const tooLarge=await new Promise<number>((resolve,reject)=>{
    const req=httpRequest(h.origin+'/v1/assets/start',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json','Content-Length':String(256*1024+1)}},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject);req.flushHeaders();
  });assert.equal(tooLarge,413);
  assert.equal(h.service.jobs().length,0);
  const response=await h.post('/v1/assets/start',input);assert.equal(response.status,202);
  const {job}=await response.json() as {job:{jobId:string;request:unknown}};
  assert.deepEqual(job.request,normalizeRequest(input));
  await h.service.cancel(job.jobId);
  const page=await (await h.call('/v1/assets/jobs?limit=1')).json() as {jobs:{request:unknown}[];nextCursor:null;total:number};
  assert.deepEqual(page.jobs[0]!.request,normalizeRequest(input));assert.equal(page.nextCursor,null);assert.equal(page.total,1);
  await h.service.close();
  const next=await createAssetService({cwd:ROOT,outputRoot:h.outputRoot,...missing(h.dir)});
  try{
    assert.deepEqual(next.jobPage().jobs[0]!.request,normalizeRequest(input));
    const index=JSON.parse(await readFile(join(h.outputRoot,'index.json'),'utf8'));
    assert.deepEqual(Object.keys(index.jobs[0]).sort(),['events','jobId']);
  }finally{await next.close();}
});
test('recipe history paginates by byte and count without dropping recipe or event evidence', async t => {
  const h=await harness(t), input=JSON.parse(await readFile(join(ROOT,'workers/blender/custom-machine.json'),'utf8'));
  // Long decimal spellings produce a large, valid data-only closed mesh recipe.
  input.recipe.parts= input.recipe.parts.filter((p:{role:string})=>p.role==='render'||p.role==='collision');
  input.recipe.parts[0].bevel=undefined;delete input.recipe.parts[0].bevel;
  const guard=input.recipe.parts.find((p:{name:string})=>p.name==='wedge-guard');
  const original=structuredClone(guard.geometry);
  guard.geometry.vertices=[];guard.geometry.indices=[];
  for(let i=0;i<1000;i++){
    const offset=guard.geometry.vertices.length, x=(i%40)/50-.4, y=Math.floor(i/40)/40-.3, d=.007123456789012345;
    guard.geometry.vertices.push([x,y,0],[x+d,y,0],[x,y+d,0],[x,y,d]);
    guard.geometry.indices.push(...[0,2,1,0,1,3,1,2,3,2,0,3].map(n=>n+offset));
  }
  guard.geometry.vertices.push(...original.vertices.map((v:number[])=>v.map(n=>n*.01+.47)));
  guard.geometry.indices.push(...original.indices.map((n:number)=>n+4000));
  input.triangleBudget=50000;
  assert.ok(Buffer.byteLength(JSON.stringify(input))>16384);
  const ids:string[]=[];
  for(let i=0;i<5;i++){
    input.name='large-recipe-'+i;const response=await h.post('/v1/assets/start',input);assert.equal(response.status,202);
    const {job}=await response.json() as {job:{jobId:string}};ids.push(job.jobId);await h.service.cancel(job.jobId);
  }
  let after:string|null=null, seen:string[]=[], pages=0;
  do{
    const response=await h.call('/v1/assets/jobs?limit=64'+(after?'&after='+after:''));
    assert.equal(response.status,200);const text=await response.text();assert.ok(Buffer.byteLength(text)<=512*1024);
    const page=JSON.parse(text) as {jobs:{jobId:string;request:{recipe:unknown};events:unknown[]}[];nextCursor:string|null;total:number};
    assert.equal(page.total,5);assert.ok(page.jobs.every(j=>j.request.recipe&&Array.isArray(j.events)));
    for(const job of page.jobs) assert.deepEqual(job.request.recipe,normalizeRequest({...input,name:'large-recipe-0'}).recipe);
    seen.push(...page.jobs.map(j=>j.jobId));after=page.nextCursor;pages++;
  }while(after);
  assert.deepEqual(seen.sort(),ids.sort());assert.ok(pages>=2,'The byte cap must force continuation before the count cap.');
  const first=await (await h.call('/v1/assets/jobs?limit=2')).json() as {jobs:unknown[];nextCursor:string};
  assert.equal(first.jobs.length,2);assert.ok(first.nextCursor);
  for(const query of ['limit=0','limit=65','limit=1.5','limit=2&limit=3','after=../x','after='+randomUUID()]){
    const response=await h.call('/v1/assets/jobs?'+query);assert.ok([400,404].includes(response.status));
  }
});

const artifactUrl = (jobId: string, path = 'asset.glb') => '/v1/assets/artifact?jobId=' + jobId + '&path=' + encodeURIComponent(path);

test('artifact GET delivers exact verified GLB, collision, FBX and completed scene bytes as attachments', async t => {
  const h = await harness(t, true), f = h.fixture!, before = h.service.jobs();
  h.service.start = async () => { throw new Error('Download must never start Blender.'); };
  h.service.probe = async () => { throw new Error('Download must never probe Blender.'); };
  for (const [path, contentType] of [['asset.glb', 'model/gltf-binary'], ['collision.glb', 'model/gltf-binary'], ['asset.fbx', 'application/octet-stream'], ['asset.blend', 'application/octet-stream']]) {
    const response = await h.call(artifactUrl(f.jobId, path));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="' + path + '"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const bytes = Buffer.from(await response.arrayBuffer()), artifact = f.manifest.artifacts.find(a => a.path === path)!;
    assert.equal(Number(response.headers.get('content-length')), artifact.bytes);
    assert.equal(sha256(bytes), artifact.sha256);
    assert.deepEqual(bytes, await readFile(join(f.directory, path!)));
  }
  assert.deepEqual(h.service.jobs(), before, 'GET cannot mutate job state or generate replacement assets.');
});

test('artifact GET requires optional LOD manifest proof and never substitutes an unlisted file', async t => {
  const h = await harness(t, true), f = h.fixture!, path = 'asset-lod1.glb', bytes = glb();
  assert.equal((await h.call(artifactUrl(f.jobId, path))).status, 404);
  await writeFile(join(f.directory, path), bytes);
  assert.equal((await h.call(artifactUrl(f.jobId, path))).status, 404, 'A current filesystem file is insufficient without manifest evidence.');
  const manifest = structuredClone(f.manifest);
  manifest.validation.meshes.push({ ...structuredClone(manifest.validation.meshes[0]!), name: 'SM_Test_LOD1', role: 'lod1' });
  manifest.validation.totals.lod1Triangles = 4;
  manifest.validation.exports.push({ path, objects: 1, triangles: 4, materials: 1, finitePositions: true });
  manifest.artifacts.push({ path, role: 'export', bytes: bytes.length, sha256: sha256(bytes) });
  const auditBytes = Buffer.from(JSON.stringify(manifest.validation)), audit = manifest.artifacts.find(a => a.path === 'audit.json')!;
  audit.bytes = auditBytes.length; audit.sha256 = sha256(auditBytes);
  await writeFile(join(f.directory, 'audit.json'), auditBytes);
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  const response = await h.call(artifactUrl(f.jobId, path));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('artifact GET accepts only human bearer and exact loopback browser context', async t => {
  const h = await harness(t, true), url = artifactUrl(h.fixture!.jobId);
  assert.equal((await fetch(h.origin + url)).status, 401);
  for (const authorization of ['Bearer ' + AGENT_TOKEN, 'Bearer wrong', 'Basic ' + TOKEN, 'Bearer ' + TOKEN + 'x']) {
    assert.equal((await h.call(url, { headers: { Authorization: authorization } })).status, 401);
  }
  for (const headers of [
    { Origin: 'null' }, { Origin: 'https://evil.invalid' }, { Origin: h.origin + '/' },
    { Referer: 'https://evil.invalid/' }, { Referer: h.origin.replace('127.0.0.1', 'localhost') + '/' },
    { Referer: 'invalid-url' }, { Referer: h.origin.replace('http://', 'http://user@') + '/' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }
  ]) assert.equal((await h.call(url, { headers: headers as Record<string, string> })).status, 403);
  for (const host of ['evil.invalid', new URL(h.origin).host.replace('127.0.0.1', 'localhost'), '127.0.0.1:1']) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(h.origin + url, { headers: { Host: host, Authorization: 'Bearer ' + TOKEN } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403);
  }
  assert.equal((await h.call(url, { headers: { Origin: h.origin, Referer: h.origin + '/workspace', 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await h.call(url, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
  assert.equal((await h.call('/v1/assets/manifest?jobId=' + h.fixture!.jobId, { headers: { Authorization: 'Bearer ' + AGENT_TOKEN } })).status, 200);
});

test('artifact GET rejects traversal, arbitrary formats, extra queries, unknown jobs and incorrect methods', async t => {
  const h = await harness(t, true), f = h.fixture!;
  for (const path of ['../asset.glb', '/asset.glb', 'C:\\asset.glb', 'asset.glb:stream', 'asset.glb\u0000', 'ASSET.GLB', 'asset.glb\r\nX-Test: injected', 'asset.obj', 'asset.mtl', 'asset.html', 'asset.js', 'blockout.blend', 'preview-hero.png', 'manifest.json', 'audit.json', 'request.json', 'asset_worker.py', 'https://evil.invalid/asset.glb', 'constructor', '__proto__']) {
    assert.equal((await h.call(artifactUrl(f.jobId, path))).status, 400, path);
  }
  for (const query of ['jobId=' + f.jobId, 'path=asset.glb', 'jobId=' + f.jobId + '&path=asset.glb&path=asset.fbx', 'jobId=' + f.jobId + '&jobId=' + f.jobId + '&path=asset.glb', 'jobId=' + f.jobId + '&path=asset.glb&token=' + TOKEN, 'jobId=../escape&path=asset.glb']) {
    assert.equal((await h.call('/v1/assets/artifact?' + query)).status, 400);
  }
  assert.equal((await h.call(artifactUrl('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'))).status, 400);
  assert.equal((await h.call(artifactUrl(randomUUID()))).status, 404);
  const method = await h.post(artifactUrl(f.jobId), {});
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  const withBody = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(h.origin + artifactUrl(f.jobId), { method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Length': '2' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(withBody, 400);
});

test('artifact GET rejects terminal failure even when unapproved export bytes exist', async t => {
  const h = await harness(t);
  const job = await h.service.start({ template: 'hero-prop', name: 'pending-export' });
  assert.equal((await h.call(artifactUrl(job.jobId))).status, 409);
  await h.service.cancel(job.jobId);
  await writeFile(join(job.directory, 'asset.glb'), 'unapproved pending bytes');
  assert.equal((await h.call(artifactUrl(job.jobId))).status, 409);
});

test('artifact GET rejects manifest role, identity, hash and byte-count tampering without a filesystem fallback', async t => {
  const h = await harness(t, true), f = h.fixture!, original = JSON.stringify(f.manifest);
  const mutations = [
    (m: typeof f.manifest) => { m.artifacts.find(a => a.path === 'asset.glb')!.role = 'preview'; },
    (m: typeof f.manifest) => { m.artifacts.find(a => a.path === 'asset.glb')!.bytes++; },
    (m: typeof f.manifest) => { m.artifacts.find(a => a.path === 'asset.glb')!.sha256 = '0'.repeat(64); },
    (m: typeof f.manifest) => { m.jobId = randomUUID(); },
    (m: typeof f.manifest) => { m.artifacts = m.artifacts.filter(a => a.path !== 'asset.glb'); }
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(f.manifest); mutate(manifest);
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(manifest));
    const response = await h.call(artifactUrl(f.jobId));
    assert.equal(response.status, 422); assert.equal(response.headers.get('content-disposition'), null);
    await writeFile(join(f.directory, 'manifest.json'), original);
  }
  const bytes = await readFile(join(f.directory, 'asset.glb'));
  const changed = Buffer.from(bytes); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await writeFile(join(f.directory, 'asset.glb'), changed);
  const hash = await h.call(artifactUrl(f.jobId));
  assert.equal(hash.status, 422); assert.equal((await hash.json() as { error: string }).error, 'HASH');
  await writeFile(join(f.directory, 'asset.glb'), bytes.subarray(0, bytes.length - 1));
  const size = await h.call(artifactUrl(f.jobId));
  assert.equal(size.status, 422); assert.equal((await size.json() as { error: string }).error, 'MANIFEST');
  await rm(join(f.directory, 'asset.glb'));
  assert.equal((await h.call(artifactUrl(f.jobId))).status, 422);
});

test('artifact GET binds the full completed request even if changed request evidence has matching hashes', async t => {
  const h = await harness(t, true), f = h.fixture!, manifest = structuredClone(f.manifest);
  manifest.request.seed++;
  const bytes = Buffer.from(JSON.stringify(manifest.request)), request = manifest.artifacts.find(a => a.path === 'request.json')!;
  request.bytes = bytes.length; request.sha256 = sha256(bytes);
  await writeFile(join(f.directory, 'request.json'), bytes);
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  // The existing complete file validator passes; download also binds the original indexed request.
  assert.equal((await h.call('/v1/assets/manifest?jobId=' + f.jobId)).status, 200);
  const response = await h.call(artifactUrl(f.jobId));
  assert.equal(response.status, 422); assert.equal((await response.json() as { error: string }).error, 'MANIFEST');
});

test('artifact GET rejects hardlinks and symlinked job ancestors', async t => {
  const h = await harness(t, true), f = h.fixture!, target = join(f.directory, 'asset.glb'), saved = join(h.dir, 'saved.glb');
  await rename(target, saved); await link(saved, target);
  assert.equal((await h.call(artifactUrl(f.jobId))).status, 422);
  await rm(target); await rename(saved, target);
  const moved = join(h.dir, 'moved-download-job');
  await rename(f.directory, moved); await symlink(moved, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.equal((await h.call(artifactUrl(f.jobId))).status, 400); }
  finally { await rm(f.directory); await rename(moved, f.directory); }
});

test('artifact GET detects artifact and manifest replacement after real validation, even with identical bytes', async t => {
  const h = await harness(t, true), f = h.fixture!, validate = h.service.manifest.bind(h.service);
  for (const path of ['asset.glb', 'manifest.json']) {
    h.service.manifest = async jobId => {
      const manifest = await validate(jobId), target = join(f.directory, path), replacement = join(f.directory, 'replacement.tmp');
      await writeFile(replacement, await readFile(target)); await rename(replacement, target);
      return manifest;
    };
    const response = await h.call(artifactUrl(f.jobId));
    assert.equal(response.status, 422); assert.equal((await response.json() as { error: string }).error, 'ARTIFACT');
    assert.equal(response.headers.get('content-disposition'), null);
  }
  h.service.manifest = validate;
  assert.equal((await h.call(artifactUrl(f.jobId))).status, 200);
});

test('artifact GET refuses oversized regular files before manifest validation or allocation', async t => {
  const h = await harness(t, true), f = h.fixture!, target = join(f.directory, 'asset.blend'), handle = await open(target, 'r+');
  try { await handle.truncate(ARTIFACT_DOWNLOAD_BYTES + 1); } finally { await handle.close(); }
  h.service.manifest = async () => { throw new Error('Oversized files must fail before the full manifest read.'); };
  const response = await h.call(artifactUrl(f.jobId, 'asset.blend'));
  assert.equal(response.status, 413); assert.equal((await response.json() as { error: string }).error, 'ARTIFACT_LIMIT');
  assert.equal(response.headers.get('content-disposition'), null);
});

test('artifact GET bounds concurrent verification and keeps timeout admission until verification settles', async t => {
  const h = await harness(t, true), f = h.fixture!, validate = h.service.manifest.bind(h.service);
  const artifact=h.service.artifact.bind(h.service);let settled!:()=>void;
  const finished=new Promise<void>(resolve=>{settled=resolve;});
  h.service.artifact=async(...args:Parameters<typeof h.service.artifact>)=>{try{return await artifact(...args);}finally{settled();}};
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.service.manifest = async jobId => { entered(); await gate; return validate(jobId); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.call(artifactUrl(f.jobId));
  await reached;
  try {
    assert.equal((await h.call(artifactUrl(f.jobId))).status, 409);
    t.mock.timers.tick(ARTIFACT_DOWNLOAD_TIMEOUT_MS);
    const timeout = await pending;
    assert.equal(timeout.status, 408); assert.equal((await timeout.json() as { error: string }).error, 'ARTIFACT_TIMEOUT');
    assert.equal((await h.call(artifactUrl(f.jobId))).status, 409, 'Timeout cannot admit more allocations while a read still runs.');
  } finally { release(); t.mock.timers.reset(); }
  h.service.manifest = validate;
  // Observe the actual owned read's terminal settlement instead of racing disk I/O
  // against an arbitrary 250 ms retry window. Production timeout/admission guards stay unchanged.
  await finished;
  const response = await h.call(artifactUrl(f.jobId));
  assert.equal(response.status, 200, 'Admission releases only after the original read settles.');
});
