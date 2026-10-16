import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetRoutes } from '../../apps/daemon/src/asset-routes.js';
import { createAssetService, HISTORY_PAGE_BYTES, type AssetJobRecord, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { createAssetConversationHost } from '../../apps/daemon/src/asset-conversation-host.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { normalizeRequest, type AssetInput, type AssetJobEvent, type AssetRequest, type Vec3 } from '../../packages/asset-pipeline/src/index.js';
import { noLinks, within } from '../../packages/asset-pipeline/src/paths.js';
import { CUSTOM_REQUEST_BYTES } from '../../packages/asset-pipeline/src/recipe.js';
import { ConversationWorkStore, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';

const ROOT = resolve(process.cwd());
const CONTROL = 'synthetic-asset-conversation-human';
const AGENT = 'synthetic-asset-conversation-agent';
const START = '/v1/assets/conversation-start', JOBS = '/v1/assets/conversation-jobs';
const NATIVE: NativeConversation = { provider: 'codex', threadId: 'Asset:Thread.Exact', sessionId: 'Asset:Session.Exact' };
const INPUT: AssetInput = { template: 'hero-prop', name: 'conversation-crate' };
const uuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

interface Reply<T = Record<string, unknown>> { status: number; value: T; text: string; headers: IncomingHttpHeaders }
interface StartReply {
  projectId: string; projectPath: string; jobId: string; association: 'bound' | 'unknown';
  conversation: NativeConversation; retry: false; job: AssetJobRecord;
}
interface JobsReply {
  projectId: string; projectPath: string; conversation: NativeConversation;
  jobs: AssetJobRecord[]; nextCursor: string | null; byteLimit: number;
}
interface HttpOptions {
  method?: string; headers?: Record<string, string | null>; rawHeaders?: string[];
  rawBody?: string | Buffer; headersOnly?: boolean;
}
function call<T = Record<string, unknown>>(
  origin: string, path: string, input?: unknown, options: HttpOptions = {}, control = CONTROL,
  agent?: Agent,
): Promise<Reply<T>> {
  const body = options.rawBody ?? (input === undefined ? undefined : JSON.stringify(input));
  const method = options.method ?? (body === undefined ? 'GET' : 'POST');
  const diagnostic = 'method=' + method + ' path=' + new URL(path, origin).pathname +
    ' bodyBytes=' + (body === undefined ? 0 : Buffer.byteLength(body));
  if (options.headersOnly) assert.equal(body, undefined, 'A headers-only fixture must not send body bytes.');
  const headers: Record<string, string> = { Authorization: 'Bearer ' + control, Origin: origin };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)); }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[key]; else headers[key] = value;
  }
  if (headers['Transfer-Encoding'] !== undefined) delete headers['Content-Length'];
  return new Promise((done, reject) => {
    const failed = (stage: string, error?: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      reject(new Error('Owned HTTP fixture ' + stage + ': ' + diagnostic +
        (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ' code=' + code : '')));
    };
    const request = httpRequest(origin + path, {
      method, agent: agent ?? false,
      headers: options.rawHeaders ?? headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', error => failed('response-error', error));
      response.once('aborted', () => failed('response-aborted'));
      response.once('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          done({ status: response.statusCode!, value: (text ? JSON.parse(text) : {}) as T, text, headers: response.headers });
        } catch { failed('response-json'); }
      });
    });
    request.setTimeout(8000, () => request.destroy(Object.assign(new Error('Owned HTTP fixture deadline.'), { code: 'HTTP_FIXTURE_TIMEOUT' })));
    request.once('error', error => failed('request-error', error));
    if (options.headersOnly) request.flushHeaders(); else request.end(body);
  });
}
function status(reply: Reply<unknown>, expected: number, code?: string) {
  assert.equal(reply.status, expected, reply.text);
  if (code !== undefined) assert.equal((reply.value as { error?: unknown }).error, code);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function retainedSnapshot(record: AssetJobRecord, previous: AssetJobRecord) {
  const journal = JSON.parse(await readFile(join(record.directory, 'job.json'), 'utf8')) as {
    startedAt: string; finishedAt: string;
  };
  // Live completion records observation time; recovery uses the worker's saved
  // terminal time. Verify the entire recovered record against its real journal.
  assert.deepEqual(record, { ...previous, startedAt: journal.startedAt,
    updatedAt: journal.finishedAt, finishedAt: journal.finishedAt });
}
function page(reply: Reply<JobsReply>, projectId: string, projectPath: string, conversation = NATIVE): JobsReply {
  status(reply, 200);
  assert.deepEqual(Object.keys(reply.value).sort(), ['byteLimit', 'conversation', 'jobs', 'nextCursor', 'projectId', 'projectPath']);
  assert.equal(reply.value.projectId, projectId); assert.equal(reply.value.projectPath, projectPath);
  assert.deepEqual(reply.value.conversation, conversation); assert.equal(reply.value.byteLimit, 524288);
  assert.ok(Buffer.byteLength(reply.text) <= 524288);
  assert.ok(reply.value.nextCursor === null || typeof reply.value.nextCursor === 'string');
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  return reply.value;
}

interface Seed { jobId: string; request: AssetInput }
const seeds = (count: number, request = INPUT): Seed[] => Array.from({ length: count }, (_, n) => ({
  jobId: uuid(n + 1), request: { ...request, name: 'retained-asset-' + (n + 1) },
}));
async function retainedJobs(outputRoot: string, records: Seed[]) {
  await mkdir(outputRoot, { recursive: true });
  const jobs: { jobId: string; events: AssetJobEvent[] }[] = [];
  for (const { jobId, request: input } of records) {
    const request = normalizeRequest(input), directory = join(outputRoot, request.name + '-' + jobId);
    const startedAt = '2026-10-12T00:00:00.000Z', finishedAt = '2026-10-12T00:00:01.000Z';
    await mkdir(directory);
    await writeFile(join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, request,
      state: 'failed', directory, manifestPath: null, startedAt, finishedAt,
      error: { code: 'FIXTURE_FAILED', message: 'Retained synthetic evidence: café 🧪' } }));
    jobs.push({ jobId, events: [
      { jobId, at: startedAt, stage: 'starting', state: 'running' },
      { jobId, at: finishedAt, stage: 'complete', state: 'failed' },
    ] });
  }
  await writeFile(join(outputRoot, 'index.json'), JSON.stringify({ schemaVersion: 1, jobs }));
}

// Only owned temporary SQLite stores, journals and loopback listeners. Explicit
// absent runtimes prevent installed CLI/Blender/Python discovery or native work.
async function fixture(t: test.TestContext, options: { host?: boolean; equalTokens?: boolean; seeds?: Seed[] } = {}) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-asset-chat-http-'));
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  const project = join(root, 'project'), outputRoot = join(root, 'assets'), directory = join(root, 'associations');
  let server: Server | null = null, service: AssetService | null = null, store: ConversationWorkStore | null = null;
  let origin = '', current: NativeConversation | null = { ...NATIVE }, starts = 0, observations = 0;
  let beforeStart: ((request: AssetRequest) => void | Promise<void>) | null = null;
  async function shutdown() {
    const listener = server; server = null;
    try {
      if (listener) {
        const closed = new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
        listener.closeAllConnections(); await closed;
      }
    } finally {
      const selected = service; service = null;
      try { await selected?.close(); } finally { store?.close(); store = null; }
    }
  }
  t.after(async () => {
    agent.destroy();
    try { await shutdown(); }
    finally {
      const target = await realpath(root);
      assert.ok(target !== boundary && within(boundary, target)); await noLinks(root);
      await rm(target, { recursive: true, force: true });
    }
  });
  await mkdir(project);
  const projectPath = await realpath(project);
  await retainedJobs(outputRoot, options.seeds ?? []);
  async function open() {
    service = await createAssetService({ cwd: ROOT, projectPath, outputRoot,
      blenderExecutable: join(root, 'absent-blender.exe'), pythonExecutable: join(root, 'absent-python.exe') });
    store = new ConversationWorkStore({ projectPath, directory });
    const owned = service;
    const host = options.host === false ? undefined : createAssetConversationHost({
      projectPath, workAssociations: store,
      conversation: () => { observations++; return current; },
      start: async request => {
        starts++; await beforeStart?.(request);
        const job = await owned.start(request);
        // Settle actual job supervision explicitly, without wall-clock polling.
        await owned.cancel(job.jobId); return job.jobId;
      },
    });
    const routes = assetRoutes(owned, host);
    server = createServer((request, response) => {
      void routes(request, response, new URL(request.url ?? '/', origin), CONTROL, origin,
        options.equalTokens ? CONTROL : AGENT).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
      }).catch(error => response.destroy(error as Error));
    });
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    origin = 'http://127.0.0.1:' + address.port;
  }
  await open();
  return {
    root, projectPath, outputRoot, agent,
    get origin() { return origin; }, get service() { return service!; }, get store() { return store!; },
    get starts() { return starts; }, get observations() { return observations; },
    context(value: NativeConversation | null) { current = value; },
    beforeStart(callback: (request: AssetRequest) => void | Promise<void>) { beforeStart = callback; },
    call<T = Record<string, unknown>>(path: string, input?: unknown, requestOptions?: HttpOptions) {
      return call<T>(origin, path, input, requestOptions, CONTROL, agent);
    },
    async restart() { await shutdown(); await open(); },
  };
}

test('conversation HTTP requires the distinct human bearer before observing or starting work', async t => {
  const f = await fixture(t);
  for (const path of [START, JOBS]) {
    const input = path === START ? INPUT : undefined;
    for (const authorization of [null, 'Bearer wrong', 'Basic ' + CONTROL, 'Bearer ' + CONTROL + 'x']) {
      status(await f.call(path, input, { headers: { Authorization: authorization } }), 401, 'AUTH');
    }
    status(await f.call(path, input, { headers: { Authorization: 'Bearer ' + AGENT } }), 403, 'HUMAN_ONLY');
  }
  assert.equal(f.starts, 0); assert.equal(f.observations, 0); assert.deepEqual(f.service.jobs(), []);
  const equal = await fixture(t, { equalTokens: true });
  status(await equal.call(START, INPUT), 403, 'HUMAN_ONLY');
  status(await equal.call(JOBS), 403, 'HUMAN_ONLY');
  assert.equal(equal.starts, 0); assert.equal(equal.observations, 0);
});

test('conversation HTTP refuses wrong origins, hosts, fetch sites and raw duplicate authority headers', async t => {
  const f = await fixture(t);
  status(await f.call(START, INPUT, { headers: { Origin: null } }), 403, 'ORIGIN');
  for (const path of [START, JOBS]) {
    const input = path === START ? INPUT : undefined;
    for (const origin of ['null', 'https://foreign.invalid', f.origin + '/', f.origin.replace('127.0.0.1', 'localhost')]) {
      status(await f.call(path, input, { headers: { Origin: origin } }), 403);
    }
    for (const host of ['foreign.invalid', new URL(f.origin).host.replace('127.0.0.1', 'localhost')]) {
      status(await f.call(path, input, { headers: { Host: host } }), 403, 'HOST');
    }
    for (const site of ['cross-site', 'same-site', 'none']) {
      status(await f.call(path, input, { headers: { 'Sec-Fetch-Site': site } }), 403, 'FETCH_SITE');
    }
    for (const [name, value] of [
      ['Authorization', 'Bearer ' + CONTROL], ['Host', new URL(f.origin).host],
      ['Origin', f.origin], ['Sec-Fetch-Site', 'same-origin'],
    ] as const) {
      const body = input === undefined ? undefined : JSON.stringify(input);
      const rawHeaders = ['Host', new URL(f.origin).host, 'Authorization', 'Bearer ' + CONTROL, 'Origin', f.origin];
      if (name === 'Sec-Fetch-Site') rawHeaders.push(name, value);
      rawHeaders.push(name.toLowerCase(), value);
      if (body !== undefined) rawHeaders.push('Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)));
      const response = await f.call(path, input, { rawHeaders });
      assert.ok([400, 403].includes(response.status), response.text);
    }
  }
  assert.equal(f.observations, 0); assert.equal(f.starts, 0); assert.deepEqual(f.service.jobs(), []);
  // A native read may omit Origin; mutating POST requires it.
  page(await f.call<JobsReply>(JOBS, undefined, { headers: { Origin: null } }), f.store.projectId, f.projectPath);
});

test('conversation HTTP refuses body/query/method authority without creating or attributing jobs', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const reply = await f.call(START, undefined, { method }); status(reply, 405); assert.equal(reply.headers.allow, 'POST');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const reply = await f.call(JOBS, undefined, { method }); status(reply, 405); assert.equal(reply.headers.allow, 'GET');
  }
  for (const input of [null, [], {}, { ...INPUT, template: 'arbitrary' }, { ...INPUT, name: '../outside' }]) {
    status(await f.call(START, input), 400);
  }
  for (const [key, value] of Object.entries({
    projectPath: f.projectPath, projectId: f.store.projectId, conversation: NATIVE, provider: 'codex',
    threadId: NATIVE.threadId, sessionId: NATIVE.sessionId, chatId: 'client-chat', role: 'human',
    jobId: uuid(90), outputRoot: f.outputRoot, script: 'arbitrary', token: CONTROL,
  })) status(await f.call(START, { ...INPUT, [key]: value }), 400);
  for (const query of ['limit=1', 'after=x', 'projectPath=client', 'threadId=client']) status(await f.call(START + '?' + query, INPUT), 400);
  for (const query of [
    'limit=0', 'limit=65', 'limit=100', 'limit=-1', 'limit=01', 'limit=1.0', 'limit=1e1',
    'limit=', 'limit=%201', 'limit=1%0A', 'limit=1&limit=2', 'limit=1&%6cimit=2',
    'after=', 'after=../outside', 'after=x&after=y', 'after=' + uuid(1),
    'after=' + 'x'.repeat(1024), 'projectId=client', 'conversation=client', 'threadId=client', 'path=outside',
  ]) status(await f.call(JOBS + '?' + query), 400);
  status(await f.call(JOBS, {}, { method: 'GET' }), 400, 'GET_BODY');
  status(await f.call(JOBS, {}, { method: 'GET', headers: { 'Transfer-Encoding': 'chunked' } }), 400, 'GET_BODY');
  status(await f.call(START, undefined, { rawBody: '{' }), 400, 'JSON');
  status(await f.call(START, undefined, { rawBody: Buffer.from([0x7b, 0xff, 0x7d]) }), 400, 'JSON');
  status(await f.call(START, INPUT, { headers: { 'Content-Type': 'text/plain' } }), 400, 'CONTENT_TYPE');
  status(await f.call(START, INPUT, { headers: { 'Content-Encoding': 'gzip' } }), 400, 'CONTENT_TYPE');
  status(await f.call(START, undefined, { rawBody: JSON.stringify({ ...INPUT, name: 'x'.repeat(16385) }) }), 413, 'BODY_LIMIT');
  // Header admission rejects before body reading. Send no bytes into the bounded
  // reject/discard path, whose intentional close may otherwise reset the upload.
  t.diagnostic('method=POST path=' + START + ' bodyBytes=0 advertisedBodyBytes=' + (CUSTOM_REQUEST_BYTES + 1));
  const oversizedHeaders = await f.call(START, undefined, { method: 'POST', headersOnly: true,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(CUSTOM_REQUEST_BYTES + 1) } });
  status(oversizedHeaders, 413, 'BODY_LIMIT');
  assert.equal(f.starts, 0); assert.deepEqual(f.service.jobs(), []);
  t.diagnostic('method=POST path=' + START + ' bodyBytes=' + (CUSTOM_REQUEST_BYTES + 1) + ' framing=chunked');
  status(await f.call(START, undefined, { rawBody: ' '.repeat(CUSTOM_REQUEST_BYTES + 1),
    headers: { 'Transfer-Encoding': 'chunked' } }), 413, 'BODY_LIMIT');
  assert.equal(f.starts, 0); assert.deepEqual(f.service.jobs(), []);
  assert.deepEqual(f.store.list(NATIVE, 'asset-job').items, []);
});

test('missing conversation host and missing current native chat fail with distinct 409 codes', async t => {
  const unavailable = await fixture(t, { host: false });
  status(await unavailable.call(START, INPUT), 409, 'ASSET_CONVERSATION_UNAVAILABLE');
  status(await unavailable.call(JOBS), 409, 'ASSET_CONVERSATION_UNAVAILABLE');
  assert.equal(unavailable.starts, 0); assert.deepEqual(unavailable.service.jobs(), []);
  const required = await fixture(t); required.context(null);
  status(await required.call(START, INPUT), 409, 'ASSET_CONVERSATION_REQUIRED');
  status(await required.call(JOBS), 409, 'ASSET_CONVERSATION_REQUIRED');
  assert.equal(required.starts, 0); assert.deepEqual(required.service.jobs(), []);
  // Legacy global routes continue to accept an agent and do not require a chat.
  const legacy = await required.call<{ job: AssetJobRecord }>('/v1/assets/start', INPUT,
    { headers: { Authorization: 'Bearer ' + AGENT, Origin: null } });
  status(legacy, 202); assert.deepEqual(Object.keys(legacy.value), ['job']);
  await required.service.cancel(legacy.value.job.jobId);
  status(await required.call('/v1/assets/jobs', undefined, { headers: { Authorization: 'Bearer ' + AGENT, Origin: null } }), 200);
  assert.equal(required.store.binding('asset-job', legacy.value.job.jobId), null);
});

test('human start returns the real job and exact pre-start host scope, then survives service/store restart', async t => {
  const f = await fixture(t, { seeds: seeds(1) });
  const reply = await f.call<StartReply>(START, INPUT); status(reply, 202);
  const result = reply.value, projectId = f.store.projectId;
  assert.deepEqual(Object.keys(result).sort(), ['association', 'conversation', 'job', 'jobId', 'projectId', 'projectPath', 'retry']);
  assert.equal(result.projectId, projectId); assert.equal(result.projectPath, f.projectPath);
  assert.equal(result.association, 'bound'); assert.equal(result.retry, false); assert.deepEqual(result.conversation, NATIVE);
  assert.equal(result.jobId, result.job.jobId); assert.deepEqual(result.job.request, normalizeRequest(INPUT));
  assert.deepEqual(result.job, f.service.jobs().find(job => job.jobId === result.jobId));
  assert.deepEqual(f.store.binding('asset-job', result.jobId), {
    projectId, conversation: NATIVE, kind: 'asset-job', id: result.jobId,
  });
  assert.equal(f.starts, 1); assert.equal(f.observations, 1);
  const journal = JSON.parse(await readFile(join(result.job.directory, 'job.json'), 'utf8')) as { jobId: string; request: unknown; state: string };
  assert.equal(journal.jobId, result.jobId); assert.deepEqual(journal.request, result.job.request);
  assert.ok(['failed', 'cancelled'].includes(journal.state));
  const before = page(await f.call<JobsReply>(JOBS), projectId, f.projectPath);
  assert.deepEqual(before.jobs, [result.job]); assert.equal(before.nextCursor, null);
  assert.equal(f.store.binding('asset-job', uuid(1)), null);
  await f.restart();
  f.store.bind = () => assert.fail('Restarted reads must not attribute legacy work or recreate bindings.');
  const after = page(await f.call<JobsReply>(JOBS), projectId, f.projectPath);
  assert.equal(after.jobs.length, 1); await retainedSnapshot(after.jobs[0]!, result.job);
  assert.deepEqual(after.jobs, f.service.jobs().filter(job => job.jobId === result.jobId));
  assert.equal(after.nextCursor, null); assert.equal(f.starts, 1);
  const global = await f.call<{ jobs: AssetJobRecord[] }>('/v1/assets/jobs'); status(global, 200);
  assert.deepEqual(global.value.jobs.map(job => job.jobId).sort(), [uuid(1), result.jobId].sort());
});

test('a late start response keeps captured chat A when the live chat changes to B during creation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const live = { ...NATIVE }, later: NativeConversation = { ...NATIVE, threadId: 'Later:Thread', sessionId: 'Later:Session' };
  f.context(live);
  f.beforeStart(async () => { entered.resolve(); await release.promise; });
  const pending = f.call<StartReply>(START, INPUT);
  try {
    await entered.promise; assert.equal(f.observations, 1); assert.equal(f.starts, 1);
    Object.assign(live, later); f.context(later);
    const during = page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath, later);
    assert.deepEqual(during.jobs, []); assert.deepEqual(f.service.jobs(), []);
  } finally { release.resolve(); }
  const response = await pending; status(response, 202);
  assert.deepEqual(response.value.conversation, NATIVE); assert.equal(response.value.association, 'bound');
  assert.deepEqual(f.store.binding('asset-job', response.value.jobId)?.conversation, NATIVE);
  assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath, later).jobs, []);
  f.context({ ...NATIVE });
  assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath).jobs, [response.value.job]);
  assert.equal(f.starts, 1);
});

test('listing refuses a chat change across asynchronous retained-job hydration without exposing the captured page', async t => {
  const f = await fixture(t, { seeds: seeds(2) }), later = { ...NATIVE, threadId: 'Later:Thread' };
  for (const id of [uuid(1), uuid(2)]) f.store.bind({ conversation: NATIVE, kind: 'asset-job', id });
  const list = f.store.list.bind(f.store); let reads = 0;
  f.store.list = (...args) => { reads++; const result = list(...args); f.context(later); return result; };
  const one=await f.call<JobsReply>(JOBS+'?limit=1');status(one,409);assert.equal(reads,2);
  assert.equal((one.value as unknown as {error:string}).error,'ASSET_CONVERSATION_STALE');
  assert.ok(!JSON.stringify(one.value).includes(later.threadId));assert.ok(!JSON.stringify(one.value).includes(uuid(1)));
  f.context({ ...NATIVE }); reads = 0;
  f.store.bind = () => assert.fail('A changing conversation cannot trigger attribution.');
  const captured=await f.call<JobsReply>(JOBS+'?limit=2');status(captured,409);assert.equal(reads,2);
  assert.equal((captured.value as unknown as {error:string}).error,'ASSET_CONVERSATION_STALE');
  assert.ok(!JSON.stringify(captured.value).includes(later.threadId));assert.ok(!JSON.stringify(captured.value).includes(uuid(2)));assert.equal(f.starts,0);
});

test('exact provider/thread/session/case and namespace isolate actual jobs; legacy work stays global', async t => {
  const variants: NativeConversation[] = [
    NATIVE, { ...NATIVE, provider: 'claude-code' }, { ...NATIVE, threadId: 'Another:Thread' },
    { ...NATIVE, sessionId: 'Another:Session' }, { ...NATIVE, sessionId: null },
    { ...NATIVE, threadId: NATIVE.threadId.toLowerCase() }, { ...NATIVE, sessionId: NATIVE.sessionId!.toLowerCase() },
  ];
  const f = await fixture(t, { seeds: seeds(variants.length + 2) });
  for (const [n, conversation] of variants.entries()) f.store.bind({ conversation, kind: 'asset-job', id: uuid(n + 1) });
  f.store.bind({ conversation: NATIVE, kind: 'workflow', id: uuid(variants.length + 1) });
  f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: 'association-with-no-retained-job' });
  f.store.bind = () => assert.fail('HTTP reads cannot backfill or infer job attribution.');
  for (const [n, conversation] of variants.entries()) {
    f.context(conversation);
    const scoped = page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath, conversation);
    assert.deepEqual(scoped.jobs, [f.service.jobs().find(job => job.jobId === uuid(n + 1))!]);
    assert.equal(scoped.nextCursor, null);
  }
  const global = await f.call<{ jobs: AssetJobRecord[]; byteLimit: number }>('/v1/assets/jobs'); status(global, 200);
  assert.equal(global.value.jobs.length, variants.length + 2); assert.equal(global.value.byteLimit, HISTORY_PAGE_BYTES);
  assert.equal(f.starts, 0); assert.equal(f.store.binding('asset-job', uuid(variants.length + 2)), null);
  await f.restart(); f.context({ ...NATIVE });
  f.store.bind = () => assert.fail('Restart must not adopt unbound retained jobs.');
  assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath).jobs.map(job => job.jobId), [uuid(1)]);
});

test('pagination uses storage opaque cursors, bounded default/max counts and complete actual records', async t => {
  const records = seeds(65), f = await fixture(t, { seeds: records });
  for (const record of records) f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: record.jobId });
  f.store.bind = () => assert.fail('Pagination is observation only.');
  const first = page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath);
  assert.equal(first.jobs.length, 32); assert.equal(first.nextCursor, f.store.list(NATIVE, 'asset-job', { limit: 32 }).nextCursor);
  // This real 64-binding read performs each store's path/schema checks; its
  // measured successful response took 14.467 seconds on the Windows fixture.
  const maximum = page(await f.call<JobsReply>(JOBS + '?limit=64'), f.store.projectId, f.projectPath);
  assert.equal(maximum.jobs.length, 64); assert.equal(maximum.nextCursor, f.store.list(NATIVE, 'asset-job', { limit: 64 }).nextCursor);
  const actual = new Map(f.service.jobs().map(job => [job.jobId, job])), seen: string[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const result = page(await f.call<JobsReply>(JOBS + '?limit=17' + (after === null ? '' : '&after=' + encodeURIComponent(after))), f.store.projectId, f.projectPath);
    assert.ok(result.jobs.length > 0 && result.jobs.length <= 17);
    for (const job of result.jobs) { assert.deepEqual(job, actual.get(job.jobId)); seen.push(job.jobId); }
    after = result.nextCursor;
    if (after !== null) { assert.ok(!cursors.has(after), 'Cursor must advance.'); cursors.add(after); }
    assert.ok(cursors.size < records.length);
  } while (after !== null);
  assert.deepEqual(seen, records.map(record => record.jobId)); assert.equal(new Set(seen).size, 65); assert.equal(f.starts, 0);
  const last = page(await f.call<JobsReply>(JOBS + '?limit=1&after=' + encodeURIComponent(maximum.nextCursor!)), f.store.projectId, f.projectPath);
  assert.deepEqual(last.jobs.map(job => job.jobId), [uuid(65)]); assert.equal(last.nextCursor, null);
});

test('foreign conversation/project/namespace cursors are refused without exposing or attributing work', async t => {
  const f = await fixture(t, { seeds: seeds(3) });
  for (const id of [uuid(1), uuid(2), uuid(3)]) {
    f.store.bind({ conversation: NATIVE, kind: 'asset-job', id });
    f.store.bind({ conversation: NATIVE, kind: 'workflow', id });
  }
  const first = page(await f.call<JobsReply>(JOBS + '?limit=1'), f.store.projectId, f.projectPath);
  assert.equal(first.nextCursor, f.store.list(NATIVE, 'asset-job', { limit: 1 }).nextCursor);
  for (const conversation of [
    { ...NATIVE, provider: 'claude-code' as const }, { ...NATIVE, threadId: 'Foreign:Thread' },
    { ...NATIVE, sessionId: 'Foreign:Session' }, { ...NATIVE, sessionId: null },
  ]) {
    f.context(conversation);
    const refused = await f.call(JOBS + '?after=' + encodeURIComponent(first.nextCursor!));
    status(refused, 400, 'CONVERSATION_WORK_INPUT'); assert.equal(refused.value.jobs, undefined);
  }
  f.context({ ...NATIVE });
  const workflowCursor = f.store.list(NATIVE, 'workflow', { limit: 1 }).nextCursor!;
  status(await f.call(JOBS + '?after=' + encodeURIComponent(workflowCursor)), 400, 'CONVERSATION_WORK_INPUT');
  const project = join(f.root, 'other-project'); await mkdir(project);
  const foreign = new ConversationWorkStore({ projectPath: await realpath(project), directory: join(f.root, 'other-associations') });
  try {
    for (const id of [uuid(1), uuid(2)]) foreign.bind({ conversation: NATIVE, kind: 'asset-job', id });
    const foreignCursor = foreign.list(NATIVE, 'asset-job', { limit: 1 }).nextCursor!;
    status(await f.call(JOBS + '?after=' + encodeURIComponent(foreignCursor)), 400, 'CONVERSATION_WORK_INPUT');
  } finally { foreign.close(); }
  // The global history's UUID cursor is not conversation authority either.
  const global = await f.call<{ nextCursor: string }>('/v1/assets/jobs?limit=1'); status(global, 200);
  status(await f.call(JOBS + '?after=' + encodeURIComponent(global.value.nextCursor)), 400, 'CONVERSATION_WORK_INPUT');
  f.store.bind = () => assert.fail('Cursor refusal cannot attribute work.');
  assert.deepEqual(page(await f.call<JobsReply>(JOBS + '?limit=1&after=' + encodeURIComponent(first.nextCursor!)), f.store.projectId, f.projectPath).jobs.map(job => job.jobId), [uuid(2)]);
  assert.equal(f.starts, 0);
});

function largeAssembly(): AssetInput {
  const vertices: Vec3[] = [], indices: number[] = [], d = 0.007123456789012345;
  for (let i = 0; i < 700; i++) {
    const offset = vertices.length, x = (i % 40) / 50 - 0.4131234567890123, y = Math.floor(i / 40) / 40 - 0.3123456789012345;
    vertices.push([x, y, 0], [x + d, y, 0], [x, y + d, 0], [x, y, d]);
    indices.push(...[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3].map(n => n + offset));
  }
  const input: AssetInput = { template: 'custom-assembly', name: 'large-conversation-assembly', triangleBudget: 50000,
    recipe: { schemaVersion: 1, materials: [{ id: 'body', color: [0.2, 0.3, 0.4] }], collisionTriangleBudget: 256,
      parts: [
        { name: 'floor-base', role: 'render', material: 'body', geometry: { kind: 'box' }, dimensions: [1, 1, 0.01], position: [0, 0, 0.005] },
        { name: 'mesh', role: 'render', material: 'body', geometry: { kind: 'mesh', vertices, indices }, dimensions: [1, 1, 1], position: [0, 0, 0.5] },
        { name: 'collider', role: 'collision', geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, 0.5] },
      ] } };
  const bytes = Buffer.byteLength(JSON.stringify(normalizeRequest(input)));
  assert.ok(bytes > HISTORY_PAGE_BYTES / 4 && bytes < CUSTOM_REQUEST_BYTES, 'Valid full recipes must force byte pagination before the count limit.');
  return input;
}

test('full recipe history respects the UTF-8 byte cap and resumes at the last included storage cursor', async t => {
  const records = seeds(5, largeAssembly()), f = await fixture(t, { seeds: records });
  for (const record of records) f.store.bind({ conversation: NATIVE, kind: 'asset-job', id: record.jobId });
  const actual = new Map(f.service.jobs().map(job => [job.jobId, job])), seen: string[] = [], cursors = new Set<string>();
  let after: string | null = null, pages = 0;
  do {
    const result = page(await f.call<JobsReply>(JOBS + '?limit=64' + (after === null ? '' : '&after=' + encodeURIComponent(after))), f.store.projectId, f.projectPath);
    pages++; assert.ok(result.jobs.length > 0 && result.jobs.length < 5);
    for (const job of result.jobs) {
      assert.deepEqual(job, actual.get(job.jobId)); assert.ok(job.request.recipe); assert.equal(job.events.length, 2);
      seen.push(job.jobId);
    }
    const expected = f.store.list(NATIVE, 'asset-job', { limit: result.jobs.length, ...(after === null ? {} : { after }) });
    assert.equal(result.nextCursor, expected.nextCursor, 'Byte continuation must not skip the first excluded binding.');
    after = result.nextCursor;
    if (after !== null) { assert.ok(!cursors.has(after)); cursors.add(after); }
    assert.ok(pages <= records.length);
  } while (after !== null);
  assert.ok(pages >= 2); assert.deepEqual(seen, records.map(record => record.jobId)); assert.equal(new Set(seen).size, 5);
  await f.restart();
  const restarted = page(await f.call<JobsReply>(JOBS + '?limit=1'), f.store.projectId, f.projectPath);
  assert.deepEqual(restarted.jobs, [actual.get(uuid(1))]); assert.equal(f.starts, 0);
});

test('conversation start accepts the same large custom body as global start and retains its complete request', async t => {
  const input = largeAssembly(), f = await fixture(t);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 16384);
  const response = await f.call<StartReply>(START, input); status(response, 202);
  assert.equal(response.value.association, 'bound'); assert.deepEqual(response.value.job.request, normalizeRequest(input));
  assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath).jobs, [response.value.job]);
  assert.equal(f.starts, 1);
});

test('near-limit custom recipe counts serialized JSON bytes without charging array index keys', async t => {
  const input = largeAssembly(); input.name = 'budget-diagnostic';
  const geometry = input.recipe!.parts.find(part => part.name === 'mesh')!.geometry;
  assert.ok(geometry.kind === 'mesh');
  const { vertices, indices } = geometry, d = 0.007123456789012345;
  // Extend the unchanged 700-tetrahedron fixture to the exact reported case.
  for (let i = 700; i < 1000; i++) {
    const offset = vertices.length, x = (i % 40) / 50 - 0.4131234567890123, y = Math.floor(i / 40) / 40 - 0.3123456789012345;
    vertices.push([x, y, 0], [x + d, y, 0], [x, y + d, 0], [x, y, d]);
    indices.push(...[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3].map(n => n + offset));
  }
  const body = JSON.stringify(input), expected = normalizeRequest(input);
  assert.equal(Buffer.byteLength(body), 251834);
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 252109);
  assert.ok(Buffer.byteLength(body) <= CUSTOM_REQUEST_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) <= CUSTOM_REQUEST_BYTES);

  const f = await fixture(t);
  const response = await f.call<StartReply>(START, undefined, { rawBody: body }); status(response, 202);
  assert.equal(response.value.association, 'bound'); assert.equal(response.value.retry, false);
  assert.equal(response.value.jobId, response.value.job.jobId);
  assert.deepEqual(response.value.job.request, expected);
  assert.deepEqual(f.store.binding('asset-job', response.value.jobId)?.conversation, NATIVE);
  assert.deepEqual(page(await f.call<JobsReply>(JOBS + '?limit=1'), f.store.projectId, f.projectPath).jobs, [response.value.job]);
  assert.equal(f.starts, 1); assert.equal(f.service.jobs().length, 1);

  await f.restart();
  f.store.bind = () => assert.fail('Reading the retained large recipe must not rebind or replay creation.');
  const retained = page(await f.call<JobsReply>(JOBS + '?limit=1'), f.store.projectId, f.projectPath);
  assert.equal(retained.jobs.length, 1); assert.equal(retained.nextCursor, null);
  assert.deepEqual(retained.jobs[0]!.request, expected);
  await retainedSnapshot(retained.jobs[0]!, response.value.job);
  assert.deepEqual(retained.jobs, f.service.jobs()); assert.equal(f.starts, 1);
});

test('unknown association returns the created real job once and read/restart never replay or adopt it', async t => {
  const f = await fixture(t); let binds = 0;
  f.store.bind = () => { binds++; throw new Error('private synthetic association failure'); };
  const response = await f.call<StartReply>(START, INPUT); status(response, 202);
  const result = response.value;
  assert.equal(result.association, 'unknown'); assert.equal(result.retry, false); assert.deepEqual(result.conversation, NATIVE);
  assert.equal(result.jobId, result.job.jobId); assert.deepEqual(f.service.jobs(), [result.job]);
  assert.equal(binds, 1); assert.equal(f.starts, 1); assert.equal(f.observations, 1);
  assert.ok(!response.text.includes('private synthetic'));
  assert.equal(f.store.binding('asset-job', result.jobId), null);
  for (let i = 0; i < 2; i++) assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath).jobs, []);
  assert.equal(binds, 1); assert.equal(f.starts, 1);
  await f.restart(); f.store.bind = () => assert.fail('An unknown association cannot be adopted on restart.');
  assert.deepEqual(page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath).jobs, []);
  const global = await f.call<{ jobs: AssetJobRecord[] }>('/v1/assets/jobs'); status(global, 200);
  assert.equal(global.value.jobs.length, 1); await retainedSnapshot(global.value.jobs[0]!, result.job);
  assert.deepEqual(global.value.jobs, f.service.jobs()); assert.equal(f.starts, 1);
});

test('a post-commit association failure stays unknown while restart reads its original binding without replay', async t => {
  const f = await fixture(t), bind = f.store.bind.bind(f.store); let binds = 0;
  f.store.bind = value => { binds++; bind(value); throw new Error('synthetic unknown commit outcome'); };
  const response = await f.call<StartReply>(START, INPUT); status(response, 202);
  assert.equal(response.value.association, 'unknown'); assert.equal(response.value.retry, false);
  assert.equal(binds, 1); assert.equal(f.starts, 1);
  await f.restart(); f.store.bind = () => assert.fail('Observation must not retry binding or creation.');
  const observed = page(await f.call<JobsReply>(JOBS), f.store.projectId, f.projectPath);
  assert.equal(observed.jobs.length, 1); await retainedSnapshot(observed.jobs[0]!, response.value.job);
  assert.deepEqual(observed.jobs, f.service.jobs()); assert.equal(observed.nextCursor, null);
  assert.deepEqual(f.store.binding('asset-job', response.value.jobId)?.conversation, NATIVE);
  assert.equal(f.starts, 1);
});

test('real lab assembly exposes unavailable/required errors without CLI, Studio or native process fixtures', async t => {
  const f = await fixture(t, { host: false });
  for (const withWork of [false, true]) {
    const work = withWork ? new WorkStore({ projectPath: f.projectPath, directory: join(f.root, 'lab-work') }) : null;
    let lab: Awaited<ReturnType<typeof createConnectionLab>> | null = null;
    try {
      lab = await createConnectionLab({ cwd: ROOT, projectPath: f.projectPath, stateDirectory: join(f.root, withWork ? 'lab-with-work' : 'lab-no-work'),
        assetService: f.service, probe: async () => [], ...(work === null ? {} : { workStore: work }) });
      const code = withWork ? 'ASSET_CONVERSATION_REQUIRED' : 'ASSET_CONVERSATION_UNAVAILABLE';
      status(await call(lab.origin, START, INPUT, {}, lab.token, f.agent), 409, code);
      status(await call(lab.origin, JOBS, undefined, {}, lab.token, f.agent), 409, code);
      status(await call(lab.origin, START, INPUT, { headers: { Authorization: 'Bearer ' + lab.agentToken } }, lab.token, f.agent), 403, 'HUMAN_ONLY');
      status(await call(lab.origin, JOBS, undefined, { headers: { Authorization: 'Bearer ' + lab.agentToken } }, lab.token, f.agent), 403, 'HUMAN_ONLY');
      assert.deepEqual(f.service.jobs(), []); assert.deepEqual(work?.runs() ?? [], []);
    } finally { try { await lab?.close(); } finally { work?.close(); } }
  }
});
