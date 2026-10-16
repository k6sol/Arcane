import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { assessJobForResolution } from '../../packages/asset-pipeline/src/worker-resolution.js';
import { ACTIVE_LIMIT, LEDGER_FILE, LEDGER_MAX_BYTES, LEDGER_MAX_ENTRIES, archiveBatch, assessEligibility, checkpoint, copyLedger, fingerprintOf,
  parseLedger, parseLedgerEntry, planRestore, sameFingerprint, serializeLedger, validateArchived,
  type ArchiveHostFacts, type Ledger, type LedgerEntry } from '../../packages/asset-pipeline/src/archive-ledger.js';

// Pure core plus owned OS-temp fixtures. The crash fixture uses a TEST-LOCAL temp+rename writer; the production
// service will persist through atomicAssetJson. No product process, system query, Blender or Studio.
const NONE: ArchiveHostFacts = { active: false, readPinned: false, importCaptured: false, preparationRecord: false, pendingStage: false, uncertainLatch: false, manifestVerified: true };
const uuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ISO = '2026-10-16T03:00:00.000Z';
const FP = Object.freeze({ dev: '1', ino: '2', size: '300', mtimeNs: '1760583600000000000', ctimeNs: '1760583600000000000' });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const closed = { schemaVersion: 1, role: 'generate', reservationId: uuid(901), reservedAt: '2026-10-16T03:00:01.0000000Z', state: 'closed', closure: 'exit-observed', closedAt: '2026-10-16T03:00:02.0000000Z', identity: null };
const captured = { schemaVersion: 1, role: 'generate', reservationId: uuid(902), reservedAt: '2026-10-16T03:00:01.0000000Z', state: 'captured',
  identity: { schemaVersion: 1, role: 'generate', pid: 9001, processCreatedAt: '2026-10-16T03:00:01.0000000Z', executable: 'C:\\B\\blender.exe' } };
function journal(n: number, state: string, workers?: unknown[], template = 'hero-prop', name = 'crate') {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: uuid(n), state, directory: '/x', manifestPath: null, error: null,
    request: { schemaVersion: 1, template, name }, startedAt: ISO, finishedAt: ISO, ...(workers ? { workers } : {}) }));
}
function entry(n: number, extra: Partial<Record<keyof LedgerEntry | 'extra', unknown>> = {}): LedgerEntry {
  return { jobId: uuid(n), name: 'crate', template: 'hero-prop', state: 'succeeded', manifestAvailable: true, startedAt: ISO, finishedAt: ISO, archivedAt: ISO,
    journalSha256: 'a'.repeat(64), journal: FP, resolutionMarkerSha256: null, ...extra } as LedgerEntry;
}
const ledgerOf = (entries: unknown[]): Ledger => ({ schemaVersion: 1, kind: 'arcane-asset-archive', entries } as unknown as Ledger);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
async function owned(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-archive-ledger-'));
  t.after(async () => { const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-archive-ledger-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true }); });
  return root;
}
async function resolvedMarker(journalBytes: Buffer, n: number) {
  const result = await assessJobForResolution({ jobId: uuid(n), journal: journalBytes, now: () => '2026-10-16T03:00:09.0000000Z' });
  assert.equal(result.status, 'resolvable'); return bytes((result as { record: unknown }).record);
}

test('round trip is frozen; serialization and copies re-validate', () => {
  const parsed = parseLedger(Buffer.from(serializeLedger(ledgerOf([entry(1), entry(2, { state: 'failed', manifestAvailable: false })]))));
  assert.ok(parsed.ok);
  assert.ok(Object.isFrozen(parsed.ledger) && Object.isFrozen(parsed.ledger.entries) && Object.isFrozen(parsed.ledger.entries[0]) && Object.isFrozen(parsed.ledger.entries[0]!.journal));
  assert.throws(() => serializeLedger(ledgerOf([entry(1), entry(1)])), /duplicate/);
  assert.throws(() => copyLedger({ ...ledgerOf([]), extra: 1 }), /Invalid archive ledger/);
});

test('every malformed, unbounded or unsafe input invalidates the whole ledger', () => {
  const good = (entries: unknown[]) => bytes(ledgerOf(entries));
  const cases: [Uint8Array, string][] = [
    [Buffer.alloc(LEDGER_MAX_BYTES + 1, 0x20), 'oversized'], [Buffer.from([0xff, 0xfe]), 'malformed'], [Buffer.from('{'), 'malformed'], [Buffer.from('[]'), 'malformed'],
    [bytes({ schemaVersion: 2, kind: 'arcane-asset-archive', entries: [] }), 'malformed'], [bytes({ schemaVersion: 1, kind: 'other', entries: [] }), 'malformed'],
    [bytes({ schemaVersion: 1, kind: 'arcane-asset-archive', entries: [], extra: 1 }), 'malformed'],
    [good(Array.from({ length: LEDGER_MAX_ENTRIES + 1 }, (_, i) => entry(i + 1))), 'too-many'],
    [good([entry(1), entry(1)]), 'duplicate'],
  ];
  for (const [input, reason] of cases) assert.deepEqual(parseLedger(input), { ok: false, reason }, reason);
  const badEntries: Partial<Record<keyof LedgerEntry | 'extra', unknown>>[] = [
    { name: '../escape' }, { name: 'a/b' }, { name: 'a\\b' }, { name: 'Crate' }, { name: '' }, { name: 'a'.repeat(49) }, { name: 'con' }, { name: 'lpt1-kit' },
    { jobId: 'not-a-uuid' }, { jobId: 'ABCDEF00-0000-4000-8000-000000000001' },
    { state: 'running' }, { state: 'interrupted' }, { template: 'shell' }, { journalSha256: 'xyz' }, { journalSha256: 'A'.repeat(64) },
    { archivedAt: '2026-02-30T00:00:00.000Z' }, { archivedAt: '2026-10-16T03:00:00Z' }, { startedAt: 'yesterday' },
    { journal: { ...FP, size: '-1' } }, { journal: { ...FP, ino: '01' } }, { journal: { ...FP, dev: '1'.repeat(26) } }, { journal: { ...FP, extra: '1' } },
    { manifestAvailable: true, state: 'failed' }, { state: 'succeeded', resolutionMarkerSha256: 'b'.repeat(64) },
    { state: 'interrupted', manifestAvailable: false, resolutionMarkerSha256: 'b'.repeat(64), template: 'adopted-glb' }, { extra: 1 },
  ];
  for (const change of badEntries) assert.deepEqual(parseLedger(good([entry(1, change)])), { ok: false, reason: 'invalid-entry' }, JSON.stringify(change));
  const accessor = { ...entry(1) } as Record<string, unknown>; Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'crate' });
  assert.equal(parseLedgerEntry(accessor), null);
  assert.ok(parseLedgerEntry(entry(1, { state: 'interrupted', manifestAvailable: false, resolutionMarkerSha256: 'b'.repeat(64) })));
});

test('repeated display names across different UUIDs are legitimate; only identity must be unique', () => {
  const parsed = parseLedger(bytes(ledgerOf([entry(1), entry(2), entry(3, { name: 'crate' })])));
  assert.ok(parsed.ok); assert.equal(parsed.ledger.entries.filter(e => e.name === 'crate').length, 3);
});

test('worst-case 4096 entries fit the measured byte bound', () => {
  const big = Object.freeze({ dev: '9'.repeat(25), ino: '9'.repeat(25), size: '9'.repeat(25), mtimeNs: '9'.repeat(25), ctimeNs: '9'.repeat(25) });
  const worst = serializeLedger(ledgerOf(Array.from({ length: LEDGER_MAX_ENTRIES }, (_, i) => entry(i + 1, { name: 'a'.repeat(48), template: 'custom-assembly',
    state: 'interrupted', manifestAvailable: false, resolutionMarkerSha256: 'b'.repeat(64), journal: big }))));
  const size = Buffer.byteLength(worst);
  assert.ok(size <= LEDGER_MAX_BYTES && size > 2 * 1024 * 1024, String(size));
  const parsed = parseLedger(Buffer.from(worst)); assert.ok(parsed.ok); assert.equal(parsed.ledger.entries.length, 4096);
});

test('eligibility: closed terminal and legacy terminal jobs are eligible; running, unresolved and leased never are', () => {
  for (const state of ['succeeded', 'failed', 'cancelled', 'timed_out']) {
    const result = assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, state, [closed]), marker: null, facts: NONE });
    assert.ok(result.eligible, state); assert.equal(result.entry.resolutionMarkerSha256, null); assert.equal(result.entry.journalSha256, sha(journal(1, state, [closed])));
  }
  assert.ok(assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed'), marker: null, facts: NONE }).eligible, 'legacy terminal');
  assert.ok(assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'succeeded', undefined, 'adopted-glb'), marker: null, facts: NONE }).eligible);
  const refusals: [Parameters<typeof assessEligibility>[0], string][] = [
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'running', [closed]), marker: null, facts: NONE }, 'running'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed', [captured]), marker: null, facts: NONE }, 'workers-unresolved'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed', [{ bogus: 1 }]), marker: null, facts: NONE }, 'workers-invalid'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'interrupted', [closed]), marker: null, facts: NONE }, 'interrupted-unresolved'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'interrupted', undefined, 'adopted-glb'), marker: null, facts: NONE }, 'interrupted-unresolved'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'succeeded', [closed]), marker: Buffer.from('{}'), facts: NONE }, 'unexpected-marker'],
    [{ jobId: uuid(2), name: 'crate', journal: journal(1, 'failed'), marker: null, facts: NONE }, 'job-mismatch'],
    [{ jobId: uuid(1), name: 'other', journal: journal(1, 'failed'), marker: null, facts: NONE }, 'name-mismatch'],
    [{ jobId: uuid(1), name: 'con', journal: journal(1, 'failed', undefined, 'hero-prop', 'con'), marker: null, facts: NONE }, 'name-mismatch'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed', undefined, 'shell'), marker: null, facts: NONE }, 'unsupported-template'],
    [{ jobId: uuid(1), name: 'crate', journal: Buffer.alloc(512 * 1024 + 1, 0x20), marker: null, facts: NONE }, 'journal-oversized'],
    [{ jobId: uuid(1), name: 'crate', journal: Buffer.from('{'), marker: null, facts: NONE }, 'journal-malformed'],
    [{ jobId: uuid(1), name: 'crate', journal: journal(1, 'paused'), marker: null, facts: NONE }, 'journal-malformed'],
  ];
  for (const [input, reason] of refusals) assert.deepEqual(assessEligibility(input), { eligible: false, reason }, reason);
  for (const lease of ['active', 'readPinned', 'importCaptured', 'preparationRecord', 'pendingStage'] as const) {
    assert.deepEqual(assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed'), marker: null, facts: { ...NONE, [lease]: true } }), { eligible: false, reason: 'leased' }, lease);
  }
  assert.deepEqual(assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed'), marker: null, facts: { ...NONE, uncertainLatch: true } }), { eligible: false, reason: 'uncertain-latch' });
});

test('manifest availability comes only from a host-verified fact, never from the succeeded state', () => {
  const unverified = assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'succeeded', [closed]), marker: null, facts: { ...NONE, manifestVerified: false } });
  assert.ok(unverified.eligible); assert.equal(unverified.entry.manifestAvailable, false, 'succeeded journal with missing/unverified manifest evidence');
  const verified = assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'succeeded', [closed]), marker: null, facts: NONE });
  assert.ok(verified.eligible); assert.equal(verified.entry.manifestAvailable, true);
  const failed = assessEligibility({ jobId: uuid(1), name: 'crate', journal: journal(1, 'failed'), marker: null, facts: NONE });
  assert.ok(failed.eligible); assert.equal(failed.entry.manifestAvailable, false, 'a verified fact cannot make a failed job available');
});

test('an interrupted job needs the exact current resolution marker', async () => {
  const j = journal(5, 'interrupted', [closed]), marker = await resolvedMarker(j, 5);
  const ok = assessEligibility({ jobId: uuid(5), name: 'crate', journal: j, marker, facts: NONE });
  assert.ok(ok.eligible); assert.equal(ok.entry.state, 'interrupted'); assert.equal(ok.entry.manifestAvailable, false); assert.equal(ok.entry.resolutionMarkerSha256, sha(marker));
  assert.deepEqual(assessEligibility({ jobId: uuid(5), name: 'crate', journal: Buffer.concat([j, Buffer.from(' ')]), marker, facts: NONE }), { eligible: false, reason: 'resolution-invalid' });
  assert.deepEqual(assessEligibility({ jobId: uuid(5), name: 'crate', journal: j, marker: Buffer.from('{"forged":1}'), facts: NONE }), { eligible: false, reason: 'resolution-invalid' });
  assert.deepEqual(assessEligibility({ jobId: uuid(5), name: 'crate', journal: j, marker: Buffer.alloc(8 * 1024 + 1, 0x20), facts: NONE }), { eligible: false, reason: 'marker-oversized' });
  assert.deepEqual(assessEligibility({ jobId: uuid(5), name: 'crate', journal: j, marker, facts: { ...NONE, uncertainLatch: true } }), { eligible: false, reason: 'uncertain-latch' });
});

test('checkpoint and full validation: missing, unchanged, changed, conflict and over-bound inputs', async t => {
  const root = await owned(t), path = join(root, 'job.json');
  const j = journal(7, 'failed', [closed]); await writeFile(path, j);
  const fp = fingerprintOf(await stat(path, { bigint: true }));
  const result = assessEligibility({ jobId: uuid(7), name: 'crate', journal: j, marker: null, facts: NONE }); assert.ok(result.eligible);
  const archived: LedgerEntry = { ...result.entry, journal: fp, archivedAt: ISO };
  assert.equal(checkpoint(archived, fp), 'archived'); assert.equal(checkpoint(archived, null), 'missing');
  await new Promise(r => setTimeout(r, 30));
  await writeFile(path, journal(7, 'failed', [{ ...closed, closedAt: '2026-10-16T03:00:03.0000000Z' }]));
  const after = fingerprintOf(await stat(path, { bigint: true }));
  assert.equal(sameFingerprint(fp, after), false); assert.equal(checkpoint(archived, after), 'needs-validation');
  assert.equal(validateArchived(archived, await readFile(path), null), 'changed');
  assert.equal(validateArchived(archived, j, null), 'archived');
  assert.equal(validateArchived(archived, journal(7, 'interrupted', [closed]), null), 'conflict');
  assert.equal(validateArchived(archived, journal(7, 'failed', [captured]), null), 'conflict');
  assert.equal(validateArchived(archived, null, null), 'missing');
  assert.equal(validateArchived(archived, Buffer.alloc(512 * 1024 + 1, 0x20), null), 'conflict', 'bounded before hashing');
  assert.equal(validateArchived(archived, j, Buffer.alloc(8 * 1024 + 1, 0x20)), 'conflict');
  assert.throws(() => validateArchived({ ...archived, extra: 1 }, j, null), /Invalid archive ledger entry/);
  const ij = journal(8, 'interrupted', [closed]), marker = await resolvedMarker(ij, 8);
  const ie = assessEligibility({ jobId: uuid(8), name: 'crate', journal: ij, marker, facts: NONE }); assert.ok(ie.eligible);
  const ientry: LedgerEntry = { ...ie.entry, journal: FP, archivedAt: ISO };
  assert.equal(validateArchived(ientry, ij, marker), 'archived');
  assert.equal(validateArchived(ientry, ij, null), 'conflict', 'marker removed: unresolved interrupted again');
});

test('archive and restore plans copy inputs, bound counts and keep 256 active / 4096 archived', () => {
  const ledger = ledgerOf([entry(1), entry(2)]);
  const additions = [entry(3) as unknown as Record<string, unknown>];
  const next = archiveBatch(ledger, additions, 10);
  additions[0]!.name = 'mutated'; (ledger.entries as unknown as Record<string, unknown>[])[0]!.name = 'mutated';
  assert.deepEqual(next.entries.map(e => e.name), ['crate', 'crate', 'crate'], 'caller mutation after the call has no effect');
  assert.ok(Object.isFrozen(next.entries[2]));
  const clean = ledgerOf([entry(1), entry(2)]);
  assert.throws(() => archiveBatch(clean, [entry(2)], 10), /Duplicate/);
  assert.throws(() => archiveBatch(clean, [], 10), /at least one/);
  assert.throws(() => archiveBatch(clean, [{ ...entry(3), extra: 1 }], 10), /Invalid archive entry/);
  for (const count of [Number.NaN, -1, 1.5, ACTIVE_LIMIT + 1, 0]) assert.throws(() => archiveBatch(clean, [entry(3)], count), /Invalid active job count/, String(count));
  assert.throws(() => archiveBatch(ledgerOf(Array.from({ length: 4096 }, (_, i) => entry(i + 1))), [entry(9999)], 10), /full/);
  assert.deepEqual(planRestore(clean, uuid(9), 10, null), { ok: false, reason: 'not-archived' });
  for (const count of [Number.NaN, -1, 2.5, ACTIVE_LIMIT + 1]) assert.throws(() => planRestore(clean, uuid(1), count, null), /Invalid active job count/, String(count));
  assert.throws(() => planRestore(clean, 'nope', 10, null), /Invalid job id/);
  const below = planRestore(clean, uuid(1), ACTIVE_LIMIT - 1, null); assert.ok(below.ok);
  assert.deepEqual(below.ledger.entries.map(e => e.jobId), [uuid(2)]); assert.equal(below.activeAfter, ACTIVE_LIMIT);
  assert.deepEqual(planRestore(clean, uuid(1), ACTIVE_LIMIT, null), { ok: false, reason: 'capacity' }, 'never more than 256 active');
  assert.deepEqual(planRestore(clean, uuid(1), ACTIVE_LIMIT, entry(2)), { ok: false, reason: 'capacity' }, 'swap target already archived');
  assert.deepEqual(planRestore(clean, uuid(1), ACTIVE_LIMIT, entry(1)), { ok: false, reason: 'capacity' }, 'swap target is the restored job');
  assert.deepEqual(planRestore(clean, uuid(1), ACTIVE_LIMIT, { ...entry(50), extra: 1 }), { ok: false, reason: 'capacity' });
  const swapEntry = entry(50) as unknown as Record<string, unknown>, swap = planRestore(clean, uuid(1), ACTIVE_LIMIT, swapEntry); assert.ok(swap.ok);
  swapEntry.name = 'mutated';
  assert.equal(swap.swappedOut, uuid(50)); assert.equal(swap.activeAfter, ACTIVE_LIMIT);
  assert.deepEqual(swap.ledger.entries.map(e => [e.jobId, e.name]), [[uuid(2), 'crate'], [uuid(50), 'crate']]);
  const full = ledgerOf(Array.from({ length: 4096 }, (_, i) => entry(i + 1)));
  const fullSwap = planRestore(full, uuid(1), ACTIVE_LIMIT, entry(5000)); assert.ok(fullSwap.ok);
  assert.equal(fullSwap.ledger.entries.length, LEDGER_MAX_ENTRIES, 'a swap at 4096 stays at 4096');
});

test('simulated crashes around archive and full-capacity swap commits leave exactly the old or new classification', async t => {
  const root = await owned(t), out = join(root, 'assets'); await mkdir(out);
  for (const n of [1, 2, 3, 4, 5, 6]) await mkdir(join(out, 'crate-' + uuid(n)));
  // Test-local stand-in for the service's atomic writer: temp write + fsync + rename, with crash injection.
  const commit = async (ledger: Ledger, crash?: 'after-temp-write' | 'after-rename') => {
    const temp = join(out, 'archive-ledger.' + randomUUID() + '.tmp'), handle = await open(temp, 'wx');
    try { await handle.writeFile(serializeLedger(ledger)); await handle.sync(); } finally { await handle.close(); }
    if (crash === 'after-temp-write') throw new Error('simulated crash');
    await rename(temp, join(out, LEDGER_FILE));
    if (crash === 'after-rename') throw new Error('simulated crash');
  };
  const classify = async () => {
    const names = (await readdir(out)).filter(n => n.startsWith('crate-')).map(n => n.slice(6));
    let ledger: Ledger = ledgerOf([]);
    try { const parsed = parseLedger(await readFile(join(out, LEDGER_FILE))); assert.ok(parsed.ok, 'ledger never corrupt after a crash'); ledger = parsed.ledger; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const archived = new Set(ledger.entries.map(e => e.jobId));
    return { archived: [...archived].sort(), active: names.filter(id => !archived.has(id)).sort(), total: names.length };
  };
  const initial = copyLedger(ledgerOf([entry(1), entry(2)])); await commit(initial);
  const before = await classify(); assert.deepEqual(before.archived, [uuid(1), uuid(2)]);
  const next = archiveBatch(initial, [entry(3), entry(4)], 4);
  await assert.rejects(commit(next, 'after-temp-write'), /simulated crash/); assert.deepEqual(await classify(), before);
  await assert.rejects(commit(next, 'after-rename'), /simulated crash/);
  const archivedNow = await classify(); assert.deepEqual(archivedNow.archived, [uuid(1), uuid(2), uuid(3), uuid(4)]);
  const plan = planRestore(next, uuid(1), ACTIVE_LIMIT, entry(5)); assert.ok(plan.ok);
  await assert.rejects(commit(plan.ledger, 'after-temp-write'), /simulated crash/); assert.deepEqual(await classify(), archivedNow);
  await commit(plan.ledger);
  const swapped = await classify();
  assert.deepEqual(swapped.archived, [uuid(2), uuid(3), uuid(4), uuid(5)]); assert.deepEqual(swapped.active, [uuid(1), uuid(6)]);
  for (const state of [before, archivedNow, swapped]) assert.equal(state.archived.length + state.active.length, state.total, 'each job in exactly one class');
  assert.ok((await readdir(out)).some(n => n.endsWith('.tmp')), 'crashed temp files remain inert and are never read as the ledger');
});
