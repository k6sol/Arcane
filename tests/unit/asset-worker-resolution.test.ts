import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { QUERY_WATCHDOG_MS, type ProcessQueryHost, type WorkerIdentity, type WorkerRole } from '../../packages/asset-pipeline/src/worker-identity.js';
import { parseWorkerRecords, reserveWorker, type WorkerRecord } from '../../packages/asset-pipeline/src/worker-journal.js';
import { MAX_CONCURRENT_QUERIES, RESOLUTION_RECORD_BYTES, assessJobForResolution, canonicalJson, parseResolutionRecord,
  validateResolution, workersDigest, type WorkerResolutionRecord } from '../../packages/asset-pipeline/src/worker-resolution.js';
import { JOB_JOURNAL_BYTES } from '../../packages/asset-pipeline/src/recipe.js';
import { parseConvertedGlbCreation } from '../../packages/asset-pipeline/src/converted-glb-creation.js';

// Synthetic query host only: no PowerShell/CIM, Blender, product process, provider or Studio. No writes.
const JOB = '22222222-2222-4222-8222-222222222222';
const BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
const T = (n: number) => '2026-10-16T01:' + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') + '.0000000Z';
const rid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = () => T(59);
type Behaviour = 'absent' | 'reused' | 'live' | 'malformed' | 'stall' | 'manual';

function identity(n: number, role: WorkerRole = 'generate'): WorkerIdentity { return { schemaVersion: 2, role, pid: 5000 + n, processCreatedAt: T(n), executable: BLENDER }; }
/** `closedFirst` closed records, then `count` captured ones (distinct ids; roles cycle). Built as persisted JSON so
 * up to six captured records can exercise the query bound; the writer itself keeps one unresolved record per role. */
function captured(count: number, closedFirst = 0): readonly WorkerRecord[] {
  const roles: WorkerRole[] = ['probe', 'python-probe', 'generate'], raw: unknown[] = [];
  for (let i = 1; i <= closedFirst + count; i++) {
    const role = roles[(i - 1) % 3]!, base = { schemaVersion: 1, role, reservationId: rid(i), reservedAt: T(i) };
    raw.push(i <= closedFirst
      ? { ...base, state: 'closed', closure: i % 2 ? 'exit-observed' : 'not-started', closedAt: T(i + 1), identity: null }
      : { ...base, state: 'captured', identity: identity(i, role) });
  }
  const parsed = parseWorkerRecords(raw); assert.ok(parsed); return parsed;
}
const NO_WORKERS = Symbol('no workers');
const journal = (fields: Record<string, unknown> = {}, workers: unknown = captured(1)) => Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: JOB,
  directory: 'C:\\assets\\crate-' + JOB, manifestPath: null, state: 'interrupted', error: { code: 'SUPERVISION_LOST', message: 'x' }, request: {}, startedAt: T(0),
  ...(workers === NO_WORKERS ? {} : { workers }), ...fields }));

function host(behaviour: (pid: number) => Behaviour) {
  const stats = { calls: 0, inflight: 0, max: 0, pending: new Map<number, () => void>(), late: [] as (() => void)[] };
  const value: ProcessQueryHost = { platform: 'win32', systemRoot: 'C:\\Windows', execFile: (_f, _a, options, callback) => {
    const pid = Number(options.env.ARCANE_WORKER_PID), mode = behaviour(pid), n = pid - 5000;
    stats.calls++; stats.inflight++; stats.max = Math.max(stats.max, stats.inflight);
    const reply = (out: unknown) => { stats.inflight--; callback(null, typeof out === 'string' ? out : JSON.stringify(out), ''); };
    const answer = () => {
      if (mode === 'absent' || mode === 'manual') reply({ v: 2, found: false });
      else if (mode === 'reused') reply({ v: 2, found: true, pid, created: T(n + 30), executable: 'C:\\Windows\\notepad.exe' });
      else if (mode === 'live') reply({ v: 2, found: true, pid, created: T(n), executable: BLENDER });
      else if (mode === 'malformed') reply('not json C:\\Users\\private');
    };
    if (mode === 'stall') { stats.late.push(() => reply({ v: 2, found: false })); return { kill() { stats.inflight--; return true; } }; }
    if (mode === 'manual') stats.pending.set(pid, answer); else queueMicrotask(answer);
    return undefined;
  } };
  return { value, stats };
}
const assess = (bytes: Uint8Array, h: ProcessQueryHost, signal?: AbortSignal) => assessJobForResolution({ jobId: JOB, journal: bytes, host: h, now: NOW, ...(signal ? { signal } : {}) });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('canonical digest is deterministic and order-independent for object keys only', () => {
  const records = captured(2, 1);
  const reordered = JSON.parse(JSON.stringify(records)).map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).reverse()));
  assert.equal(canonicalJson(reordered), canonicalJson(records));
  assert.equal(workersDigest(reordered as never), workersDigest(records));
  assert.notEqual(workersDigest([...records].reverse()), workersDigest(records), 'array order is significant');
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
});

test('all closed: resolvable with zero queries and closed basis', async () => {
  const records = captured(0, 3), h = host(() => 'live');
  const result = await assess(journal({}, records), h.value);
  assert.equal(h.stats.calls, 0);
  assert.equal(result.status, 'resolvable');
  const record = (result as { record: WorkerResolutionRecord }).record;
  assert.deepEqual(record.basis.map(b => b.evidence), ['closed-exit-observed', 'closed-not-started', 'closed-exit-observed']);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.basis) && Object.isFrozen(record.basis[0]));
  assert.equal(record.authority, 'human-control'); assert.equal(record.assessedAt, NOW());
});

test('creation-only journal changes invalidate a resolution marker while unchanged legacy bytes retain it', async () => {
  const creation = { schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId: JOB,
    parentJobId: '33333333-3333-4333-8333-333333333333', parentManifestSha256: 'a'.repeat(64),
    name: 'forest-card', collision: 'none', renderResolution: 256, renderSamples: 8 };
  assert.deepEqual(parseConvertedGlbCreation(creation), creation);
  const records = captured(0, 1), bytes = journal({ kind: 'converted-glb', request: null, creation }, records), h = host(() => 'live');
  const result = await assess(bytes, h.value); assert.equal(result.status, 'resolvable'); assert.equal(h.stats.calls, 0);
  const record = Buffer.from(JSON.stringify((result as { record: WorkerResolutionRecord }).record));
  assert.equal(validateResolution({ jobId: JOB, journal: bytes, record }).valid, true);
  const changed = journal({ kind: 'converted-glb', request: null, creation: { ...creation, name: 'other-card' } }, records);
  assert.deepEqual(validateResolution({ jobId: JOB, journal: changed, record }), { valid: false, reason: 'resolution-stale' });
  const legacy = journal({ kind: 'converted-glb', request: null }, records), legacyResult = await assess(legacy, h.value);
  assert.equal(legacyResult.status, 'resolvable');
  const legacyRecord = Buffer.from(JSON.stringify((legacyResult as { record: WorkerResolutionRecord }).record));
  assert.equal(validateResolution({ jobId: JOB, journal: legacy, record: legacyRecord }).valid, true);
  assert.deepEqual(validateResolution({ jobId: JOB, journal: bytes, record: legacyRecord }), { valid: false, reason: 'resolution-stale' });
});

test('a valid pending creation cannot resolve missing worker records or an unclosed reservation', async () => {
  const creation = { schemaVersion: 1, kind: 'arcane-glb-conversion-creation', jobId: JOB,
    parentJobId: '33333333-3333-4333-8333-333333333333', parentManifestSha256: 'a'.repeat(64),
    name: 'forest-card', collision: 'none', renderResolution: 256, renderSamples: 8 };
  assert.deepEqual(parseConvertedGlbCreation(creation), creation);
  const h = host(() => 'absent'), fields = { kind: 'converted-glb', request: null, creation };
  for (const workers of [[], NO_WORKERS])
    assert.deepEqual(await assess(journal(fields, workers), h.value), { status: 'refused', reason: 'no-workers-recorded' });
  assert.deepEqual(await assess(journal(fields, reserveWorker([], 'generate', rid(1), T(1))), h.value),
    { status: 'refused', reason: 'reservation-unresolved' });
  assert.equal(h.stats.calls, 0);
});

test('absent and reused identities are evidence; a live identity or unknown query refuses', async () => {
  const one = journal({}, captured(1));
  assert.equal(((await assess(one, host(() => 'absent').value)) as { record: WorkerResolutionRecord }).record.basis[0]!.evidence, 'pid-absent');
  assert.equal(((await assess(one, host(() => 'reused').value)) as { record: WorkerResolutionRecord }).record.basis[0]!.evidence, 'pid-reused');
  assert.deepEqual(await assess(one, host(() => 'live').value), { status: 'refused', reason: 'same-worker-running' });
  assert.deepEqual(await assess(one, host(() => 'malformed').value), { status: 'refused', reason: 'output-malformed' });
});

test('invalid journals, identities, jobs and states refuse with zero queries', async () => {
  const h = host(() => 'absent');
  const reserved = reserveWorker([], 'generate', rid(1), T(1));
  const cases: [Uint8Array, string][] = [
    [Buffer.alloc(JOB_JOURNAL_BYTES + 1, 0x20), 'journal-oversized'],
    [Buffer.from([0xff, 0xfe, 0x7b]), 'journal-malformed'], [Buffer.from('[]'), 'journal-malformed'], [Buffer.from('{"schemaVersion":1'), 'journal-malformed'],
    [journal({ schemaVersion: 2 }), 'journal-malformed'], [journal({ jobId: 'nope' }), 'journal-malformed'],
    [journal({ jobId: '33333333-3333-4333-8333-333333333333' }), 'job-mismatch'],
    [journal({ state: 'failed' }), 'not-interrupted'], [journal({ state: 'running' }), 'not-interrupted'], [journal({ state: 'succeeded' }), 'not-interrupted'],
    [journal({}, NO_WORKERS), 'no-workers-recorded'], [journal({}, []), 'no-workers-recorded'],
    [journal({}, [{ bogus: true }]), 'records-invalid'], [journal({}, 'workers'), 'records-invalid'],
    [journal({}, [{ ...captured(1)[0]!, identity: { ...identity(1), processCreatedAt: '2026-02-30T00:00:00.0000000Z' } }]), 'records-invalid'],
    [journal({}, reserved), 'reservation-unresolved'],
  ];
  for (const [bytes, reason] of cases) assert.deepEqual(await assess(bytes, h.value), { status: 'refused', reason }, reason);
  assert.deepEqual(await assessJobForResolution({ jobId: 'bad', journal: journal(), host: h.value }), { status: 'refused', reason: 'job-mismatch' });
  assert.equal(h.stats.calls, 0);
});

test('legacy timestamp disagreement cannot mint PID-reuse resolution evidence', async () => {
  const legacy = captured(1).map(record => record.state === 'captured'
    ? { ...record, identity: { ...record.identity, schemaVersion: 1 } } : record);
  assert.ok(parseWorkerRecords(legacy));
  assert.deepEqual(await assess(journal({}, legacy), host(() => 'reused').value), { status: 'refused', reason: 'identity-conflict' });
  assert.deepEqual(await assess(journal({}, legacy), host(() => 'live').value), { status: 'refused', reason: 'same-worker-running' });
  const absent = await assess(journal({}, legacy), host(() => 'absent').value); assert.ok(absent.status === 'resolvable');
  assert.equal(absent.record.basis[0]!.evidence, 'pid-absent');
});

test('the assessment copies the journal bytes before awaiting: later caller mutation cannot change the record', async () => {
  const bytes = journal({}, captured(1)), original = Buffer.from(bytes), h = host(() => 'manual');
  const pending = assess(bytes, h.value);
  bytes.fill(0x20); // Caller scribbles over its buffer while the query is pending.
  await flush(); for (const answer of h.stats.pending.values()) answer();
  const result = await pending;
  assert.equal(result.status, 'resolvable');
  assert.equal(validateResolution({ jobId: JOB, journal: original, record: Buffer.from(JSON.stringify((result as { record: WorkerResolutionRecord }).record)) }).valid, true);
});

test('at most two fixed-PID queries run concurrently across six captured records', async () => {
  assert.equal(MAX_CONCURRENT_QUERIES, 2);
  const records = captured(6), h = host(() => 'manual');
  const pending = assess(journal({}, records), h.value);
  const capturedCount = records.filter(r => r.state === 'captured').length;
  for (let released = 0; released < capturedCount; released++) {
    await flush();
    assert.ok(h.stats.inflight <= 2, 'inflight ' + h.stats.inflight);
    const [pid, answer] = [...h.stats.pending.entries()][0]!; h.stats.pending.delete(pid); answer();
  }
  const result = await pending;
  assert.equal(result.status, 'resolvable'); assert.equal(h.stats.max, Math.min(2, capturedCount)); assert.equal(h.stats.calls, capturedCount);
});

test('after a live or unknown result no further query is scheduled, but owned queries are awaited', async () => {
  const records = captured(6), capturedPids = records.filter(r => r.state === 'captured').map(r => (r as { identity: WorkerIdentity }).identity.pid);
  const first = capturedPids[0]!;
  for (const bad of ['live', 'malformed'] as const) {
    const h = host(pid => pid === first ? bad : 'manual');
    let settled = false;
    const pending = assess(journal({}, records), h.value).then(r => { settled = true; return r; });
    await flush();
    assert.equal(settled, false, 'the second owned query is still awaited');
    for (const answer of h.stats.pending.values()) answer();
    const result = await pending;
    assert.deepEqual(result, { status: 'refused', reason: bad === 'live' ? 'same-worker-running' : 'output-malformed' });
    assert.equal(h.stats.calls, 2, 'no query scheduled after uncertainty');
  }
});

test('stalled and late callbacks: the adapter watchdog bounds the query; a late answer cannot create evidence', async t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const h = host(() => 'stall');
  const pending = assess(journal({}, captured(1)), h.value);
  await flush(); mock.timers.tick(QUERY_WATCHDOG_MS); await flush();
  assert.deepEqual(await pending, { status: 'refused', reason: 'query-unsettled' });
  for (const late of h.stats.late) late();
  assert.deepEqual(await pending, { status: 'refused', reason: 'query-unsettled' });
});

test('abort: before start runs nothing; mid-flight schedules nothing new, awaits owned queries and never yields evidence', async () => {
  const before = new AbortController(); before.abort();
  const h0 = host(() => 'absent');
  assert.deepEqual(await assess(journal({}, captured(6)), h0.value, before.signal), { status: 'refused', reason: 'cancelled' });
  assert.equal(h0.stats.calls, 0);
  const controller = new AbortController(), h = host(() => 'manual');
  let settled = false;
  const pending = assess(journal({}, captured(6)), h.value, controller.signal).then(r => { settled = true; return r; });
  await flush(); const owned = h.stats.calls;
  controller.abort(); await flush();
  assert.equal(settled, false, 'owned queries are awaited after abort');
  for (const answer of h.stats.pending.values()) answer(); // Every owned query reports gone...
  assert.deepEqual(await pending, { status: 'refused', reason: 'cancelled' }); // ...but an abort never yields evidence.
  assert.equal(h.stats.calls, owned, 'no query scheduled after abort');
});

test('resolution validation binds exact journal bytes, workers digest, job and one-to-one basis', async () => {
  const records = captured(2, 1), bytes = journal({}, records);
  const result = await assess(bytes, host(() => 'absent').value);
  assert.equal(result.status, 'resolvable');
  const record = (result as { record: WorkerResolutionRecord }).record, stored = (value: unknown) => Buffer.from(JSON.stringify(value));
  assert.deepEqual(validateResolution({ jobId: JOB, journal: bytes, record: stored(record) }), { valid: true, record });
  const check = (journalBytes: Uint8Array, value: unknown, jobId = JOB) => validateResolution({ jobId, journal: journalBytes, record: stored(value) });
  assert.deepEqual(check(Buffer.concat([bytes, Buffer.from(' ')]), record), { valid: false, reason: 'resolution-stale' }, 'one changed byte');
  assert.deepEqual(check(bytes, { ...record, workersSha256: 'a'.repeat(64) }), { valid: false, reason: 'resolution-stale' });
  assert.deepEqual(check(journal({ state: 'failed' }, records), record), { valid: false, reason: 'not-interrupted' });
  assert.deepEqual(check(journal({}, captured(1)), record), { valid: false, reason: 'resolution-stale' });
  assert.deepEqual(check(bytes, record, '33333333-3333-4333-8333-333333333333'), { valid: false, reason: 'job-mismatch' });
  assert.deepEqual(check(bytes, { ...record, jobId: '33333333-3333-4333-8333-333333333333' }), { valid: false, reason: 'resolution-mismatch' });
  const basis = record.basis.map(b => ({ ...b }));
  assert.deepEqual(check(bytes, { ...record, basis: [...basis, { ...basis[0]!, reservationId: rid(99) }] }), { valid: false, reason: 'resolution-mismatch' }, 'extra basis');
  assert.deepEqual(check(bytes, { ...record, basis: basis.slice(1) }), { valid: false, reason: 'resolution-mismatch' }, 'missing basis');
  assert.deepEqual(check(bytes, { ...record, basis: [basis[0], basis[0], basis[2]] }), { valid: false, reason: 'record-malformed' }, 'duplicate basis');
  assert.deepEqual(check(bytes, { ...record, basis: [{ ...basis[0]!, role: 'generate' }, ...basis.slice(1)] }), { valid: false, reason: 'resolution-mismatch' }, 'role');
  assert.deepEqual(check(bytes, { ...record, basis: [{ ...basis[0]!, evidence: 'pid-absent' }, ...basis.slice(1)] }), { valid: false, reason: 'resolution-mismatch' }, 'closed claimed as pid');
  assert.deepEqual(check(bytes, { ...record, basis: [...basis.slice(0, 1), { ...basis[1]!, evidence: 'closed-exit-observed' }, ...basis.slice(2)] }), { valid: false, reason: 'resolution-mismatch' }, 'captured claimed closed');
  for (const bad of [{ ...record, extra: 1 }, { ...record, authority: 'model' }, { ...record, kind: 'other' }, { ...record, assessedAt: '2026-02-30T00:00:00.0000000Z' },
    { ...record, basis: [] }, { ...record, basis: [{ ...basis[0]!, evidence: 'elapsed-time' }] }, { ...record, journalSha256: 'XYZ' }]) {
    assert.deepEqual(check(bytes, bad), { valid: false, reason: 'record-malformed' });
  }
  assert.deepEqual(validateResolution({ jobId: JOB, journal: bytes, record: Buffer.alloc(RESOLUTION_RECORD_BYTES + 1, 0x20) }), { valid: false, reason: 'record-oversized' });
  assert.deepEqual(validateResolution({ jobId: JOB, journal: bytes, record: Buffer.from('{') }), { valid: false, reason: 'record-malformed' });
  const accessor = { ...record } as Record<string, unknown>; Object.defineProperty(accessor, 'jobId', { enumerable: true, get: () => JOB });
  assert.equal(parseResolutionRecord(accessor), null);
});

test('reentrant retirement while producing the assessment timestamp cannot release evidence',async()=>{
  const controller=new AbortController();
  const result=await assessJobForResolution({jobId:JOB,journal:journal(),host:host(()=>'absent').value,signal:controller.signal,
    now:()=>{controller.abort();return '2026-10-16T00:00:00.0000000Z';}});
  assert.deepEqual(result,{status:'refused',reason:'cancelled'});
});

test('refusals and records never carry raw PIDs, paths, exception text or query output', async () => {
  const bytes = journal({}, captured(1));
  const outputs = [await assess(bytes, host(() => 'malformed').value), await assess(bytes, host(() => 'live').value), await assess(journal({ state: 'failed' }), host(() => 'absent').value)];
  for (const output of outputs) assert.doesNotMatch(JSON.stringify(output), /private|Users|Blender|notepad|500\d|\\\\/);
  const ok = await assess(bytes, host(() => 'absent').value);
  assert.doesNotMatch(JSON.stringify(ok), /Blender|500\d|\\\\/);
});
