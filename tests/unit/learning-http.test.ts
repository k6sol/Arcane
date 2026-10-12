import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLearningService, type LearningService } from '../../apps/daemon/src/learning-service.js';
import { learningRoutes } from '../../apps/daemon/src/learning-routes.js';
import { canonicalLearningProjectId, LEARNING_AUTHORITY, LearningStore } from '../../packages/storage/src/learning-store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const requestHash = () => hash(randomUUID());
const evidence = (reference = 'selected-human-evidence') => ({ source: 'human_report', reference, sha256: hash(reference) });
const proposal = (overrides: Record<string, unknown> = {}) => ({
  requestHash: requestHash(), kind: 'preference', text: 'Run focused offline checks before reviewing a change.',
  tags: ['testing'], evidence: [evidence()], ...overrides,
});
interface Reply { status: number; text: string; headers: IncomingHttpHeaders }
function json<T = Record<string, unknown>>(reply: Reply): T { return JSON.parse(reply.text) as T; }
interface WireOptions {
  method?: string; token?: string; origin?: string | null; host?: string;
  headers?: Record<string, string>; raw?: string | Buffer; chunks?: Buffer[]; target?: string;
}
async function fixture(t: test.TestContext, settings: { seed?: boolean; missingProject?: boolean; token?: string; equalTokens?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-learning-http-'));
  const projectPath = join(root, 'project'), directory = join(root, 'state');
  if (!settings.missingProject) mkdirSync(projectPath);
  const token = settings.token ?? 'fixture-human-' + randomUUID(), agentToken = settings.equalTokens ? token : 'fixture-agent-' + randomUUID();
  let seededId: string | undefined;
  if (settings.seed) {
    const proof = Symbol('offline store fixture');
    const store = new LearningStore({ directory, projectPath, authorizeHuman: (_command, supplied) => supplied === proof });
    try {
      const scope = { projectId: store.projectId };
      store.setOptInHuman({ ...scope, requestId: 'fixture-seed-consent', enabled: true }, proof);
      seededId = store.propose({ ...scope, requestId: 'fixture-seed-proposal', kind: 'preference', author: 'agent', text: 'Synthetic previously reviewed hint.', tags: ['testing'], evidence: [evidence()] }).targetHash;
      store.reviewHuman({ ...scope, requestId: 'fixture-seed-review', recordId: seededId, decision: 'approved', verifiedEvidenceHashes: [evidence().sha256] }, proof);
    } finally { store.close(); }
  }
  let service: LearningService = createLearningService({ directory, projectPath });
  let route = learningRoutes(service);
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (!await route(request, response, url, token, origin, agentToken)) { response.writeHead(404); response.end('fixture fallback'); }
    })().catch(() => { response.writeHead(500); response.end('fixture handler failed'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    service.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const target = resolve(root), boundary = resolve(tmpdir()), part = relative(boundary, target);
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    rmSync(target, { recursive: true, force: true });
  });
  const call = (path: string, input?: unknown, options: WireOptions = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const raw = options.raw ?? (input === undefined ? undefined : JSON.stringify(input));
    const request = httpRequest(origin + path, {
      method: options.method ?? (raw === undefined && !options.chunks ? 'GET' : 'POST'),
      ...(options.target ? { path: options.target } : {}),
      headers: {
        Host: options.host ?? new URL(origin).host, Authorization: 'Bearer ' + (options.token ?? token),
        ...(options.origin === null ? {} : { Origin: options.origin ?? origin }),
        ...(raw === undefined && !options.chunks ? {} : { 'Content-Type': 'application/json' }),
        ...(raw === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(raw)) }),
        ...(options.chunks ? { 'Transfer-Encoding': 'chunked' } : {}),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
      response.on('error', reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error('Fixture HTTP deadline'))); request.on('error', reject);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end(raw);
  });
  const state = async () => {
    const reply = await call('/v1/learning/state'); assert.equal(reply.status, 200, reply.text);
    return json<ReturnType<LearningService['state']>>(reply);
  };
  const consent = async (enabled = true, identifier = requestHash()) => {
    const reply = await call('/v1/learning/consent', { requestHash: identifier, enabled }); assert.equal(reply.status, 200, reply.text); return reply;
  };
  const propose = async (overrides: Record<string, unknown> = {}) => {
    const input = proposal(overrides), reply = await call('/v1/learning/propose', input);
    assert.equal(reply.status, 200, reply.text);
    return { id: json<{ targetHash: string }>(reply).targetHash, input, reply };
  };
  const review = (recordId: string, verifiedEvidenceHashes = [evidence().sha256], decision = 'approved', identifier = requestHash()) =>
    call('/v1/learning/review', { requestHash: identifier, recordId, decision, verifiedEvidenceHashes });
  const context = (tags = ['testing'], maxBytes = 16384) => call('/v1/learning/context', { tags, maxBytes });
  const restart = () => { service.close(); service = createLearningService({ directory, projectPath }); route = learningRoutes(service); };
  return { root, directory, projectPath, origin, token, agentToken, seededId, call, state, consent, propose, review, context, restart, service: () => service };
}

test('factory is synchronous/lazy; metadata GET never enables consent or creates proposals', async t => {
  const f = await fixture(t);
  assert.equal('then' in f.service(), false);
  assert.equal(existsSync(f.directory), false);
  const first = await f.state();
  assert.deepEqual(first, { settings: { projectId: canonicalLearningProjectId(f.projectPath), optIn: false, consentAt: null }, records: [] });
  assert.deepEqual(await f.state(), first);
  assert.equal(json(await f.context()).context, '');
  assert.equal((await f.call('/v1/learning/propose', proposal())).status, 409);
  assert.deepEqual(await f.state(), first);
  const reply = await f.call('/v1/learning/state');
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.equal((await f.call('/v1/unrelated')).text, 'fixture fallback');
});

test('all learning routes deny agents/credentials/cross-origin before touching storage', async t => {
  const f = await fixture(t);
  for (const endpoint of ['state', 'context', 'consent', 'propose', 'review', 'disable', 'erase', 'unknown']) {
    const input = endpoint === 'state' ? undefined : {};
    for (const options of [
      { token: f.agentToken }, { origin: 'https://evil.invalid' }, { host: 'evil.invalid' },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { headers: { 'Sec-Fetch-Site': 'same-site' } }, { headers: { 'Sec-Fetch-Site': 'none' } },
    ]) {
      const reply = await f.call('/v1/learning/' + endpoint, input, options);
      assert.equal(reply.status, 403, reply.text);
      assert.ok(!reply.text.includes(f.token) && !reply.text.includes(f.agentToken));
      assert.equal(reply.headers.location, undefined); assert.equal(reply.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await f.call('/v1/learning/' + endpoint, input, { token: 'wrong-human-token' })).status, 401);
  }
  assert.equal(existsSync(f.directory), false);
  for (const endpoint of ['context', 'consent', 'propose', 'review', 'disable', 'erase']) {
    assert.equal((await f.call('/v1/learning/' + endpoint, {}, { origin: null })).status, 403);
  }
  assert.equal((await f.call('/v1/learning/state', undefined, { origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await f.call('/v1/learning/state', {}, { method: 'GET' })).status, 400);
  assert.equal((await f.call('/v1/learning/state', undefined, { method: 'GET', chunks: [Buffer.from('{}')] })).status, 400);
  assert.equal((await f.call('/v1/learning/state?projectId=foreign')).status, 400);
  assert.equal((await f.call('/v1/learning/state', {}, { method: 'POST' })).status, 405);
  assert.equal((await f.call('/v1/learning/context')).status, 405);
  assert.equal((await f.call('/v1/learning/outcome', {})).status, 404);
  const absolute = await f.call('/v1/learning/state', undefined, { target: 'http://evil.invalid/v1/learning/state' });
  assert.equal(absolute.status, 403); assert.equal(absolute.headers.location, undefined);
});

test('duplicate authority headers and an accidental agent/human token collision fail closed', async t => {
  const f = await fixture(t);
  for (const name of ['Authorization', 'Host', 'Origin', 'Sec-Fetch-Site']) {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const headers = ['Host', new URL(f.origin).host, 'Authorization', 'Bearer ' + f.token, 'Origin', f.origin, 'Sec-Fetch-Site', 'same-origin'];
      const index = headers.indexOf(name); headers.push(name, headers[index + 1]!);
      const request = httpRequest(f.origin + '/v1/learning/state', { headers }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
        response.on('end', () => resolve({ status: response.statusCode!, text, headers: response.headers })); response.on('error', reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error('Duplicate-header fixture deadline'))); request.on('error', reject); request.end();
    });
    assert.equal(reply.status, 400); assert.equal(json(reply).error, 'HEADER');
  }
  assert.equal(existsSync(f.directory), false);
  const collision = await fixture(t, { equalTokens: true });
  assert.equal((await collision.call('/v1/learning/state')).status, 403);
  assert.equal((await collision.call('/v1/learning/consent', { requestHash: requestHash(), enabled: true })).status, 403);
  assert.equal(existsSync(collision.directory), false);
});

test('strict schemas reject browser authority/path claims and nested store fields', async t => {
  const f = await fixture(t); await f.consent();
  const p = await f.propose();
  const bodies: Record<string, Record<string, unknown>> = {
    consent: { requestHash: requestHash(), enabled: true }, context: { tags: ['testing'], maxBytes: 1024 },
    propose: proposal(), review: { requestHash: requestHash(), recordId: p.id, decision: 'approved', verifiedEvidenceHashes: [evidence().sha256] },
    disable: { requestHash: requestHash(), recordId: p.id, disabled: true },
    erase: { requestHash: requestHash(), recordId: p.id, confirmation: 'delete-learning-record' },
  };
  for (const [endpoint, input] of Object.entries(bodies)) {
    for (const field of ['projectId', 'projectPath', 'proof', 'author', 'capability', 'requestId', 'status', 'scope', 'authority', 'enabledByAgent']) {
      const reply = await f.call('/v1/learning/' + endpoint, { ...input, [field]: 'browser-controlled-value' });
      assert.equal(reply.status, 400, reply.text); assert.equal(json(reply).error, 'LEARNING_INPUT');
      assert.equal(reply.text.includes('browser-controlled-value'), false);
    }
    const missing = { ...input }; delete missing[Object.keys(input)[0]!];
    assert.equal((await f.call('/v1/learning/' + endpoint, missing)).status, 400);
    assert.equal((await f.call('/v1/learning/' + endpoint, [])).status, 400);
  }
  for (const extra of [{ verifiedAt: new Date().toISOString() }, { proof: true }, { path: f.projectPath }]) {
    assert.equal((await f.call('/v1/learning/propose', proposal({ evidence: [{ ...evidence(), ...extra }] }))).status, 400);
  }
  for (const identifier of ['raw-request-id', hash('uppercase').toUpperCase(), null, 10]) {
    assert.equal((await f.call('/v1/learning/consent', { requestHash: identifier, enabled: true })).status, 400);
  }
  const records = (await f.state()).records;
  assert.equal(records.length, 1); assert.equal(records[0]!.status, 'proposed'); assert.equal(records[0]!.author, 'user'); assert.equal(records[0]!.disabled, false);
});

test('LearningStore fixture and HTTP proposals require explicit complete evidence verification', async t => {
  const f = await fixture(t, { seed: true });
  assert.deepEqual(json<{ recordIds: string[] }>(await f.context()).recordIds, [f.seededId]);
  const p = await f.propose({ evidence: [evidence('first-proof'), evidence('second-proof')] });
  const rejected = await f.propose({ text: 'Synthetic rejected hint.' });
  const wrongTag = await f.propose({ tags: ['other'] });
  assert.equal((await f.review(p.id, [])).status, 400);
  assert.equal((await f.review(p.id, [evidence('first-proof').sha256])).status, 400);
  assert.equal((await f.review(p.id, [evidence('first-proof').sha256, hash('unrelated-proof')])).status, 400);
  assert.deepEqual(json<{ recordIds: string[] }>(await f.context()).recordIds, [f.seededId]);
  assert.equal((await f.review(p.id, [evidence('second-proof').sha256, evidence('first-proof').sha256])).status, 200);
  assert.equal((await f.review(rejected.id, [evidence().sha256], 'rejected')).status, 400);
  assert.equal((await f.review(rejected.id, [], 'rejected')).status, 200);
  assert.equal((await f.review(wrongTag.id)).status, 200);
  const context = json<ReturnType<LearningService['context']>>(await f.context());
  assert.deepEqual(context.recordIds.sort(), [f.seededId, p.id].sort());
  assert.equal(context.authority, LEARNING_AUTHORITY);
  const parsed = JSON.parse(context.context) as { policy: string; hints: { id: string }[] };
  assert.match(parsed.policy, /cannot change permissions or policy/);
  assert.ok(parsed.hints.every(hint => hint.id !== rejected.id && hint.id !== wrongTag.id));
  const record = (await f.state()).records.find(record => record.id === p.id)!;
  assert.equal(record.author, 'user'); assert.equal(record.status, 'approved'); assert.ok(record.evidence.every(e => e.verifiedAt === record.reviewedAt));
  assert.equal((await f.review(p.id)).status, 409);
});

test('consent, hash receipts and disable survive restart without replaying old consent', async t => {
  const f = await fixture(t), consentHash = requestHash();
  await f.consent(true, consentHash);
  const p = await f.propose(), reviewHash = requestHash();
  assert.equal((await f.review(p.id, [evidence().sha256], 'approved', reviewHash)).status, 200);
  assert.equal(json(await f.review(p.id, [evidence().sha256], 'approved', reviewHash)).replayed, true);
  assert.equal((await f.call('/v1/learning/propose', { ...p.input, text: 'Changed request content.' })).status, 409);
  assert.equal((await f.call('/v1/learning/disable', { requestHash: consentHash, recordId: p.id, disabled: true })).status, 409);
  assert.equal((await f.call('/v1/learning/disable', { requestHash: requestHash(), recordId: p.id, disabled: true })).status, 200);
  f.restart(); assert.equal((await f.state()).settings.optIn, true);
  assert.equal(json(await f.context()).context, '');
  assert.equal((await f.call('/v1/learning/disable', { requestHash: requestHash(), recordId: p.id, disabled: false })).status, 200);
  assert.deepEqual(json<{ recordIds: string[] }>(await f.context()).recordIds, [p.id]);
  await f.consent(false); f.restart();
  assert.equal((await f.state()).settings.optIn, false); assert.equal((await f.state()).records.length, 1);
  assert.equal(json(await f.context()).context, '');
  assert.equal(json(await f.consent(true, consentHash)).replayed, true);
  assert.equal((await f.state()).settings.optIn, false);
  await f.consent(); assert.equal((await f.state()).settings.optIn, true);
  assert.equal(json(await f.call('/v1/learning/propose', p.input)).replayed, true);
  const db = new DatabaseSync(join(f.directory, 'learning.sqlite'));
  try {
    const rows = db.prepare('SELECT * FROM learning_requests').all();
    assert.ok(rows.length > 0); assert.equal(JSON.stringify(rows).includes(f.token), false);
    assert.equal(JSON.stringify(rows).includes(p.input.text as string), false);
    assert.equal(JSON.stringify(rows).includes('selected-human-evidence'), false);
  } finally { db.close(); }
});

test('canonical host scope isolates projects, approvals and persisted database identity', async t => {
  const a = await fixture(t), b = await fixture(t); await a.consent(); await b.consent();
  const p = await a.propose();
  assert.notEqual((await a.state()).settings.projectId, (await b.state()).settings.projectId);
  assert.equal((await b.review(p.id)).status, 404);
  assert.equal((await b.call('/v1/learning/disable', { requestHash: requestHash(), recordId: p.id, disabled: true })).status, 404);
  assert.equal((await b.call('/v1/learning/erase', { requestHash: requestHash(), recordId: p.id, confirmation: 'delete-learning-record' })).status, 404);
  assert.equal((await b.call('/v1/learning/context', { tags: ['testing'], maxBytes: 16384, projectId: (await a.state()).settings.projectId })).status, 400);
  assert.equal((await a.review(p.id)).status, 200);
  assert.equal(json(await b.context()).context, ''); assert.equal((await b.state()).records.length, 0);
  const wrong = createLearningService({ directory: a.directory, projectPath: b.projectPath });
  try {
    assert.throws(() => wrong.state(), (error: unknown) => (error as { code: string }).code === 'LEARNING_SCOPE');
    assert.throws(() => wrong.state(), (error: unknown) => (error as { code: string }).code === 'LEARNING_CLOSED');
  } finally { wrong.close(); }
  assert.equal((await a.state()).records.length, 1);
});

test('credential-like text, metadata and references are rejected whole with redacted errors', async t => {
  const f = await fixture(t); await f.consent();
  const secret = 'sk-proj-' + 'f'.repeat(36);
  for (const overrides of [
    { text: 'Synthetic token: ' + secret }, { text: 'password=fixture-secret-value' },
    { text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
    { tags: [secret] }, { evidence: [evidence(secret)] },
    { evidence: [{ ...evidence(), reference: 'C:/Users/fixture/.codex/auth.json' }] },
    { evidence: [{ ...evidence(), reference: 'https://fixture.invalid/config' }] },
  ]) {
    const reply = await f.call('/v1/learning/propose', proposal(overrides)); assert.equal(reply.status, 400);
    for (const value of [secret, 'fixture-secret-value', 'abcdefghijklmnopqrstuvwxyz', 'auth.json', f.token, f.agentToken, f.projectPath]) assert.equal(reply.text.includes(value), false);
  }
  assert.equal((await f.state()).records.length, 0);
  // Also deny the actual host credentials even without a known provider-key shape.
  for (const token of [f.token, f.agentToken]) {
    const reply = await f.call('/v1/learning/propose', proposal({ text: token }));
    assert.equal(reply.status, 400); assert.equal(json(reply).error, 'LEARNING_SECRET'); assert.equal(reply.text.includes(token), false);
  }
  assert.equal((await f.state()).records.length, 0);
  const persisted = readFileSync(join(f.directory, 'learning.sqlite'));
  assert.equal(persisted.includes(Buffer.from(secret)), false);
  const escaped = await fixture(t, { token: 'fixture-human-"quoted\\credential' }); await escaped.consent();
  assert.equal((await escaped.call('/v1/learning/propose', proposal({ text: escaped.token }))).status, 400);
  assert.equal((await escaped.state()).records.length, 0);
});

test('context contains only enabled approved hints and respects whole UTF-8 budgets <=16KiB', async t => {
  const f = await fixture(t); await f.consent();
  for (let index = 0; index < 3; index++) {
    const p = await f.propose({ text: ('é漢').repeat(1300) }); assert.equal((await f.review(p.id)).status, 200);
  }
  for (const budget of [0, 1, 500, 8000, 16384]) {
    const result = json<ReturnType<LearningService['context']>>(await f.context(['testing'], budget));
    assert.equal(result.bytes, Buffer.byteLength(result.context)); assert.ok(result.bytes <= budget);
    if (result.context) { const parsed = JSON.parse(result.context) as { hints: { text: string }[] }; assert.ok(parsed.hints.every(h => h.text === ('é漢').repeat(1300))); }
  }
  assert.equal(json<{ recordIds: string[] }>(await f.context()).recordIds.length, 2);
  for (const budget of [-1, 16385, 1.5, '1024']) assert.equal((await f.call('/v1/learning/context', { tags: ['testing'], maxBytes: budget })).status, 400);
  assert.equal((await f.context([], 1024)).status, 400); assert.equal(json(await f.context(['unmatched'])).context, '');
});

test('bounded JSON rejects invalid encodings, malformed bodies, declared/chunked excess and stalled writes', async t => {
  const f = await fixture(t);
  for (const [raw, headers, status] of [
    ['{malformed-secret-value', {}, 400], ['{}', { 'Content-Type': 'text/plain' }, 415],
    ['{}', { 'Content-Encoding': 'gzip' }, 415], ['x'.repeat(32769), {}, 413],
    [Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), {}, 400],
  ] as const) {
    const reply = await f.call('/v1/learning/consent', undefined, { raw, headers });
    assert.equal(reply.status, status, reply.text); assert.equal(reply.text.includes('malformed-secret-value'), false);
  }
  assert.equal((await f.call('/v1/learning/consent', undefined, { chunks: [Buffer.alloc(16000, 0x20), Buffer.alloc(17000, 0x20)] })).status, 413);
  assert.equal(existsSync(f.directory), false);
  const started = Date.now();
  const stalled = await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest(f.origin + '/v1/learning/consent', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.token, Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': '100' },
    }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode!, text, headers: response.headers }); }); response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(6000, () => request.destroy(new Error('Stalled fixture exceeded deadline')));
    request.write('{');
  });
  assert.equal(stalled.status, 408); assert.equal(json(stalled).error, 'BODY_TIMEOUT'); assert.equal(stalled.headers.connection, 'close');
  assert.ok(Date.now() - started < 6000); assert.equal(existsSync(f.directory), false);
  assert.equal((await f.state()).settings.optIn, false);
});

test('erase needs exact explicit confirmation; retries never resurrect records or enable consent', async t => {
  const f = await fixture(t); await f.consent(); const p = await f.propose(); assert.equal((await f.review(p.id)).status, 200);
  for (const confirmation of [true, '', 'delete-project-learning', 'yes']) {
    assert.equal((await f.call('/v1/learning/erase', { requestHash: requestHash(), recordId: p.id, confirmation })).status, 400);
  }
  assert.equal((await f.state()).records.length, 1);
  const erase = { requestHash: requestHash(), recordId: p.id, confirmation: 'delete-learning-record' };
  const deleted = await f.call('/v1/learning/erase', erase); assert.equal(deleted.status, 200); assert.ok(['complete', 'pending'].includes(json<{ checkpoint: string }>(deleted).checkpoint));
  f.restart(); assert.equal((await f.state()).records.length, 0);
  assert.equal(json(await f.call('/v1/learning/erase', erase)).replayed, true);
  assert.equal(json(await f.call('/v1/learning/propose', p.input)).replayed, true); assert.equal((await f.state()).records.length, 0);
  await f.propose();
  assert.equal((await f.call('/v1/learning/erase', { requestHash: requestHash(), recordId: null, confirmation: 'delete-learning-record' })).status, 400);
  const all = { requestHash: requestHash(), recordId: null, confirmation: 'delete-project-learning' };
  assert.equal((await f.call('/v1/learning/erase', all)).status, 200);
  assert.equal((await f.state()).records.length, 0); assert.equal((await f.state()).settings.optIn, false);
  assert.equal(json(await f.call('/v1/learning/erase', all)).replayed, true);
});

test('missing project and damaged schema close storage without leaking details or resetting it', async t => {
  const missing = await fixture(t, { missingProject: true });
  const first = await missing.call('/v1/learning/state'); assert.equal(first.status, 503); assert.equal(first.text.includes(missing.projectPath), false);
  assert.equal(existsSync(missing.directory), false);
  assert.equal(json(await missing.call('/v1/learning/state')).error, 'LEARNING_CLOSED');
  const f = await fixture(t); await f.consent(); await f.propose();
  const db = new DatabaseSync(join(f.directory, 'learning.sqlite'));
  try { db.exec('PRAGMA user_version=2'); } finally { db.close(); }
  const broken = await f.call('/v1/learning/state'); assert.equal(broken.status, 503); assert.equal(json(broken).error, 'LEARNING_MIGRATION');
  assert.equal(json(await f.call('/v1/learning/state')).error, 'LEARNING_CLOSED');
  const inspect = new DatabaseSync(join(f.directory, 'learning.sqlite'));
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(inspect.prepare('SELECT count(*) AS count FROM learning_records').get()!.count, 1);
    inspect.exec('PRAGMA user_version=1');
  } finally { inspect.close(); }
  // Repairing a fixture externally does not reopen a failed service automatically.
  assert.equal((await f.call('/v1/learning/state')).status, 503);
  f.restart(); assert.equal((await f.state()).records.length, 1);
  f.service().close(); f.service().close(); assert.equal((await f.call('/v1/learning/state')).status, 503);
});
