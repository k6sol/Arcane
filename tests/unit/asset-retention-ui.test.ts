import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioApi, StudioRequestError, readAssetConversationPage, readAssetHistoryChange, readAssetHistoryHealth, readAssetHistoryRestore } from '../../apps/desktop/src/studio.js';

// Pure parser and owned-transport fixtures; no daemon, provider, Blender or Studio.
const TOKEN = 'a'.repeat(64), JOB = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const BACKUP = 'archive-ledger.backup-0123456789abcdef-33333333-3333-4333-8333-333333333333.bin';
const health = (history: Record<string, unknown> = {}) => ({ history: { degraded: true, reasons: ['ledger-invalid', 'commit-uncertain'], active: 3, archived: 40, unclassified: 0, unavailable: 1, ...history } });
const change = (value: Record<string, unknown> = {}) => ({ active: 3, archived: 40, unavailable: 0, degraded: false, backup: BACKUP, ...value });
interface Call { path: string; method: string; body: string | undefined }
function api(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const transport = (async (path: string, init: RequestInit) => { const call = { path, method: String(init.method), body: init.body as string | undefined }; calls.push(call); return reply(call); }) as unknown as typeof fetch;
  return { client: new StudioApi(TOKEN, transport), calls };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const outcome = (expected: string) => (error: unknown) => error instanceof StudioRequestError && error.outcome === expected;

test('history health is exact, bounded and never inferred as healthy', () => {
  assert.deepEqual(readAssetHistoryHealth(health()), health().history);
  assert.deepEqual(readAssetHistoryHealth(health({ degraded: false, reasons: [], unavailable: 0 })).degraded, false);
  assert.equal(readAssetHistoryHealth(health({reasons:[],unavailable:1})).degraded,true,'unavailable active evidence keeps health degraded without a ledger error');
  assert.equal(readAssetHistoryHealth(health({ active: 4416, unclassified: 4416, reasons: ['active-limit'] })).active, 4416, 'legacy over-cap counts are reported honestly');
  const bad: Record<string, unknown>[] = [
    { degraded: false }, { degraded: true, reasons: [],unavailable:0 }, { reasons: ['ledger-invalid', 'ledger-invalid'] }, { reasons: ['unknown-reason'] },
    { reasons: Array(9).fill('scan-limit') }, { active: 4417 }, { archived: 4097 }, { unclassified: -1 }, { unavailable: 257 }, { active: 1.5 }, { active: '3' }, { extra: true },
  ];
  for (const value of bad) assert.throws(() => readAssetHistoryHealth(health(value)), /Invalid/, JSON.stringify(value));
  assert.throws(() => readAssetHistoryHealth({ ...health(), extra: 1 })); assert.throws(() => readAssetHistoryHealth({ history: { ...health().history, pad: 'x'.repeat(5000) } }));
});

test('rebuild/confirm receipts are exact and a backup is only an owned basename', () => {
  for (const key of ['rebuilt', 'confirmed'] as const) {
    assert.deepEqual(readAssetHistoryChange({ [key]: change() }, key), change());
    assert.deepEqual(readAssetHistoryChange({ [key]: change({ backup: null, degraded: true, unavailable: 2 }) }, key).backup, null);
  }
  assert.throws(() => readAssetHistoryChange({ rebuilt: change() }, 'confirmed'), 'receipt kind must match the request');
  const bad = [{ active: 257 }, { archived: 4097 }, { unavailable: 257 }, { degraded: 'no' }, { backup: 'C:\\assets\\' + BACKUP }, { backup: '../' + BACKUP },
    { backup: BACKUP.toUpperCase() }, { backup: BACKUP + '\n' }, { backup: BACKUP.replace('.bin', 'xbin') }, { backup: BACKUP.replace('ledger.backup', 'ledgerXbackup') }, { backup: 'archive-ledger.backup-0123-33333333-3333-4333-8333-333333333333.bin' }, { extra: 1 }];
  for (const value of bad) assert.throws(() => readAssetHistoryChange({ rebuilt: change(value) }, 'rebuilt'), /Invalid/, JSON.stringify(value));
});

test('restoration receipts bind the exact requested job and a different swapped job', () => {
  assert.deepEqual(readAssetHistoryRestore({ restored: { jobId: JOB, swappedOut: OTHER, activeAfter: 256 } }, JOB), { jobId: JOB, swappedOut: OTHER, activeAfter: 256 });
  for (const restored of [{ jobId: OTHER, swappedOut: null, activeAfter: 1 }, { jobId: JOB, swappedOut: JOB, activeAfter: 1 }, { jobId: JOB, swappedOut: null, activeAfter: 0 }, { jobId: JOB, swappedOut: null, activeAfter: 257 }])
    assert.throws(() => readAssetHistoryRestore({ restored }, JOB));
});

test('unavailable history rows cannot duplicate jobs, exceed the page or become selectable fakes', () => {
  const page = (unavailable: unknown) => ({ projectId: 'b'.repeat(64), projectPath: 'C:\\project', conversation: { provider: 'codex', threadId: 't', sessionId: null }, jobs: [], nextCursor: null, byteLimit: 524288, unavailable });
  assert.deepEqual(readAssetConversationPage(page([{ jobId: JOB, status: 'missing', name: 'crate' }])).unavailable, [{ jobId: JOB, status: 'missing', name: 'crate' }]);
  for (const rows of [[{ jobId: JOB, status: 'restored' }], [{ jobId: JOB, status: 'missing' }, { jobId: JOB, status: 'changed' }], [{ jobId: JOB, status: 'missing', name: 'Bad Name' }],
    [{ jobId: JOB, status: 'missing', state: 'succeeded' }], Array.from({ length: 33 }, (_, i) => ({ jobId: '11111111-1111-4111-8111-' + String(i).padStart(12, '0'), status: 'missing' }))])
    assert.throws(() => readAssetConversationPage(page(rows)));
});

test('API reads health with GET, sends exact empty change bodies once, and maps outcomes honestly', async () => {
  const a = api(call => call.path === '/v1/assets/history-status' ? json(health()) : json({ rebuilt: change() }));
  assert.equal((await a.client.assetHistoryHealth()).reasons.length, 2);
  assert.equal((await a.client.assetChangeHistory('rebuild')).backup, BACKUP);
  assert.deepEqual(a.calls.map(call => [call.method, call.path, call.body]), [['GET', '/v1/assets/history-status', undefined], ['POST', '/v1/assets/rebuild-history', '{}']]);
  await assert.rejects(a.client.request('/v1/assets/rebuild-history', { force: true }), outcome('rejected'));
  await assert.rejects(a.client.request('/v1/assets/history-status', {}), outcome('rejected'));
  assert.equal(a.calls.length, 2, 'malformed envelopes are refused before any transport');
  const cases: [string, () => Response | Promise<Response>, string][] = [
    ['integrity 409', () => json({ error: 'ASSET_ARCHIVE_CHANGED', message: 'x' }, 409), 'rejected'],
    ['uncertain 503', () => json({ error: 'ASSET_ARCHIVE_UNCERTAIN', message: 'x' }, 503), 'unknown'],
    ['lost response', () => { throw new TypeError('network lost'); }, 'unknown'],
    ['malformed receipt', () => json({ rebuilt: { ...change(), backup: '../escape' } }), 'unknown'],
    ['wrong receipt kind', () => json({ confirmed: change() }), 'unknown'],
    ['oversized receipt', () => json({ rebuilt: change(), pad: 'x'.repeat(1024 * 1024) }), 'unknown'],
  ];
  for (const [name, reply, expected] of cases) {
    const b = api(() => reply());
    await assert.rejects(b.client.assetChangeHistory('rebuild'), outcome(expected), name);
    assert.equal(b.calls.length, 1, name + ': exactly one dispatch, never replayed');
  }
  const unreadable = api(() => json({ history: { degraded: true } }));
  await assert.rejects(unreadable.client.assetHistoryHealth(), outcome('unavailable'));
});
