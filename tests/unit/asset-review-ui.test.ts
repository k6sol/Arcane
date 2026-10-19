import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssetReviewApi, AssetReviewRequestError, readAssetReviewStatus } from '../../apps/desktop/src/asset-review.js';
const JOB = '11111111-1111-4111-8111-111111111111', REVIEW = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333', TOKEN = 'a'.repeat(64), ORIGIN = 'http://127.0.0.1:32123';
const viewed = { jobId: JOB, sha256: 'd'.repeat(64), bytes: 256 };
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ?
  '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function status(change: (subject: any) => void = () => {}) {
  const subject: any = { schemaVersion: 1, projectId: 'b'.repeat(64), conversation: { provider: 'codex', threadId: 'owned-thread', sessionId: null },
    jobId: JOB, manifestSha256: 'c'.repeat(64), sourceRequestSha256: 'e'.repeat(64),
    artifacts: [{ path: 'asset.glb', sha256: viewed.sha256, bytes: 256 }, { path: 'collision.glb', sha256: 'f'.repeat(64), bytes: 128 }] };
  change(subject);
  const subjectDigest = createHash('sha256').update(canonical(subject)).digest('hex');
  const review = { reviewId: REVIEW, subject, subjectDigest, status: 'pending', revision: 0, preparedAt: '2026-10-19T00:00:00.000Z', decidedAt: null };
  return { subject, subjectDigest, review, retry: false };
}
test('review subject is bound to the viewed render bytes and canonical host digest', async () => {
  const good = await readAssetReviewStatus(status(), viewed); assert.equal(good.review!.status, 'pending');
  for (const mutate of [
    (s: any) => { s.jobId = REVIEW; }, (s: any) => { s.artifacts[0].sha256 = '0'.repeat(64); },
    (s: any) => { s.artifacts[0].bytes++; }, (s: any) => { s.artifacts.reverse(); },
    (s: any) => { s.conversation.provider = 'native-agent'; }, (s: any) => { s.target = 'Studio'; },
  ]) await assert.rejects(readAssetReviewStatus(status(mutate), viewed));
  const altered = status(); altered.subjectDigest = '0'.repeat(64); await assert.rejects(readAssetReviewStatus(altered, viewed));
  const mismatched = status(); mismatched.review.subject = status(s => { s.artifacts[1].sha256 = '0'.repeat(64); }).subject;
  await assert.rejects(readAssetReviewStatus(mismatched, viewed));
});
test('pending and decided review revisions and exact response shapes are validated', async () => {
  for (const change of [
    (s: any) => { s.retry = true; }, (s: any) => { s.review.revision = 1; },
    (s: any) => { s.review.status = 'approved'; }, (s: any) => { s.review.decidedAt = '2026-10-19T00:00:00Z'; },
    (s: any) => { s.review.reviewId = '../review'; }, (s: any) => { s.review.raw = '<script>'; },
  ]) { const s: any = status(); change(s); await assert.rejects(readAssetReviewStatus(s, viewed)); }
  const approved: any = status(); Object.assign(approved.review, { status: 'approved', revision: 1, decidedAt: '2026-10-19T00:01:00Z' });
  assert.equal((await readAssetReviewStatus(approved, viewed)).review!.status, 'approved');
});
test('human transport is POST-only, token-origin bound, bounded and cache-free', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (path, init) => { calls.push({ path: String(path), init: init! }); return Response.json(status()); });
  await api.request('prepare', { jobId: JOB }, new AbortController().signal);
  const request = calls[0]!; assert.equal(request.path, '/v1/assets/review/prepare'); assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(request.init.body)), { jobId: JOB });
  assert.deepEqual(request.init.headers, { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' });
  assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.referrerPolicy, 'no-referrer');
  let attempts = 0; const transport: typeof fetch = async () => { attempts++; return Response.json(status()); };
  await assert.rejects(new AssetReviewApi(TOKEN, ORIGIN, () => 'http://127.0.0.1:9', transport).request('prepare', { jobId: JOB }, new AbortController().signal));
  await assert.rejects(new AssetReviewApi('invalid', ORIGIN, () => ORIGIN, transport).request('prepare', { jobId: JOB }, new AbortController().signal));
  assert.equal(attempts, 0);
});
test('unknown decision acknowledgements are classified without any transport replay', async () => {
  for (const make of [
    () => Promise.reject(new TypeError('PRIVATE_NETWORK_SENTINEL')),
    () => Promise.resolve(Response.json({ state: 'unknown', retry: false }, { status: 202 })),
    () => Promise.resolve(new Response('PRIVATE_HTML_SENTINEL', { headers: { 'Content-Type': 'text/html' } })),
    () => Promise.resolve(new Response('broken json', { headers: { 'Content-Type': 'application/json' } })),
    () => Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' } })),
  ]) {
    let calls = 0; const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async () => { calls++; return make(); });
    await assert.rejects(api.request('decide', { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY }, new AbortController().signal),
      (e: unknown) => e instanceof AssetReviewRequestError && e.unknownOutcome && !/PRIVATE/.test(e.message));
    assert.equal(calls, 1);
  }
});
test('client decision and observation routes reject caller hashes, targets and extra fields before dispatch', async () => {
  let calls = 0;
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async () => { calls++; return Response.json({}); });
  for (const body of [
    { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY, sha256: viewed.sha256 },
    { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY, target: 'Studio' },
    { jobId: JOB }, { reviewId: REVIEW, decision: 'approve', idempotencyKey: KEY },
  ]) await assert.rejects(api.request('decide', body as any, new AbortController().signal));
  await assert.rejects(api.request('../start' as any, { jobId: JOB }, new AbortController().signal));
  await assert.rejects(api.request('status', { jobId: JOB, subjectDigest: viewed.sha256 } as any, new AbortController().signal));
  assert.equal(calls, 0);
});
test('decision timeout aborts the original request, and receipt/status reads never replay it', async () => {
  let signal: AbortSignal | undefined, calls = 0;
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (_path, init) => { calls++; signal = init!.signal!; return new Promise<Response>(() => {}); }, 10);
  await assert.rejects(api.request('decide', { reviewId: REVIEW, decision: 'rejected', idempotencyKey: KEY }, new AbortController().signal),
    (e: unknown) => e instanceof AssetReviewRequestError && e.unknownOutcome);
  assert.equal(signal!.aborted, true); assert.equal(calls, 1);
  const seen: string[] = [], reads = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (path, init) => { seen.push(String(path)); assert.equal(init!.method, 'POST'); return Response.json({}); });
  await reads.request('receipt', { reviewId: REVIEW, idempotencyKey: KEY }, new AbortController().signal);
  await reads.request('status', { jobId: JOB }, new AbortController().signal);
  assert.deepEqual(seen, ['/v1/assets/review/receipt', '/v1/assets/review/status']);
});
