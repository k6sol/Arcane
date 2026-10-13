import test from 'node:test';
import assert from 'node:assert/strict';
import { assetConversationJobPage, type AssetConversationJobPage } from '../../apps/daemon/src/asset-conversation-page.js';
import type { AssetConversationHost, AssetConversationListing } from '../../apps/daemon/src/asset-conversation-host.js';
import { HISTORY_PAGE_BYTES, type AssetJobRecord, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import type { ConversationWorkBinding, NativeConversation } from '../../packages/storage/src/conversation-work-store.js';

const NATIVE: NativeConversation = { provider: 'codex', threadId: 'Page:Thread.Exact', sessionId: 'Page:Session.Exact' };
const SCOPE = { projectId: '1'.repeat(64), projectPath: 'C:/synthetic/project', conversation: NATIVE };
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
const cursor = (sequence: number) => 'c'.repeat(64) + ':' + sequence;
type Query = { limit: number; after?: string };

function job(jobId: string, padding = ''): AssetJobRecord {
  return {
    schemaVersion: 1, jobId, directory: 'synthetic/output/' + jobId, manifestPath: null,
    request: { schemaVersion: 1, template: 'hero-prop', name: 'fixture-' + jobId, seed: 1,
      sizeMeters: [1, 1, 1], color: [0.1, 0.2, 0.3], triangleBudget: 5000, renderResolution: 384, renderSamples: 16 },
    state: 'failed', stage: 'fixture' + padding, startedAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:01.000Z', events: [], manifestAvailable: false,
    error: { code: 'FIXTURE', message: 'Synthetic retained evidence: café 🌿' },
  };
}
function binding(id: string): ConversationWorkBinding {
  return { projectId: SCOPE.projectId, kind: 'asset-job', id, conversation: { ...NATIVE } };
}
function page(jobs: AssetJobRecord[], nextCursor: string | null, scope = SCOPE): AssetConversationJobPage {
  return { projectId: scope.projectId, projectPath: scope.projectPath, conversation: { ...scope.conversation },
    jobs, nextCursor, byteLimit: HISTORY_PAGE_BYTES };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function sizedJob(id: string, size: number): AssetJobRecord {
  const record = job(id), extra = size - bytes(record);
  assert.ok(Number.isSafeInteger(extra) && extra >= 0);
  record.stage += 'x'.repeat(extra);
  assert.equal(bytes(record), size);
  return record;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

// Deterministic attested metadata and service snapshots only. No stores, journals,
// listeners, filesystem access, native history, worker or provider turns are used.
function fixture(ids: string[], records: AssetJobRecord[], sequences = ids.map((_, i) => i + 1)) {
  const bindings = ids.map(binding), cursors = sequences.map(cursor);
  const scope = { ...SCOPE, conversation: { ...NATIVE } };
  const calls: Query[] = [];
  let jobReads = 0;
  let onPage: ((page: AssetConversationListing, call: number) => AssetConversationListing) | undefined;
  let onJobs: (() => void) | undefined;
  const host: AssetConversationHost = {
    listHuman(input: unknown = {}) {
      const query = input as Query; calls.push({ ...query });
      const start = query.after === undefined ? 0 : cursors.indexOf(query.after) + 1;
      if (query.after !== undefined && start === 0) throw new ArcaneError('CONVERSATION_WORK_INPUT', 'Synthetic unknown cursor.');
      const items = bindings.slice(start, start + query.limit), end = start + items.length;
      const output: AssetConversationListing = { ...scope, items, nextCursor: end < bindings.length ? cursors[end - 1]! : null };
      return onPage ? onPage(output, calls.length) : output;
    },
    startHuman() { assert.fail('A page cannot start human work'); },
    startAgent() { assert.fail('A page cannot start agent work'); },
    bindingHuman() { assert.fail('A page cannot look up live individual bindings'); },
  };
  const service = new Proxy({
    jobs() { jobReads++; onJobs?.(); return records; },
  }, { get(target, key, receiver) {
    assert.equal(key, 'jobs', 'The helper may only read the trusted jobs snapshot');
    return Reflect.get(target, key, receiver) as unknown;
  } }) as AssetService;
  return {
    host, service, calls, bindings, scope, cursors,
    get jobReads() { return jobReads; },
    onPage(callback: typeof onPage) { onPage = callback; },
    onJobs(callback: typeof onJobs) { onJobs = callback; },
    read(limit = 32, after: string | null = null) { return assetConversationJobPage(service, host, { limit, after }); },
  };
}

test('one host page hydrates complete matching records in binding order with the exact response shape', () => {
  const first = frozen(job('first')), second = frozen(job('second')), foreign = job('foreign');
  const f = fixture(['first', 'second'], [foreign, second, first]);
  const result = f.read(2);
  assert.deepEqual(result, page([first, second], null));
  assert.deepEqual(Object.keys(result).sort(), ['byteLimit', 'conversation', 'jobs', 'nextCursor', 'projectId', 'projectPath']);
  assert.equal(result.byteLimit, 524288); assert.equal(f.jobReads, 1);
  assert.deepEqual(f.calls, [{ limit: 2 }]);
  assert.equal(result.jobs[0], first); assert.equal(result.jobs[1], second);
});

test('every regular count from 1 through 64 costs one host page and one service snapshot', () => {
  const records = Array.from({ length: 65 }, (_, i) => job('job-' + i)), ids = records.map(record => record.jobId);
  for (let limit = 1; limit <= 64; limit++) {
    const f = fixture(ids, records.toReversed()), result = f.read(limit);
    assert.deepEqual(result.jobs.map(record => record.jobId), ids.slice(0, limit));
    assert.equal(result.nextCursor, f.cursors[limit - 1]);
    assert.deepEqual(f.calls, [{ limit }]); assert.equal(f.jobReads, 1);
    assert.ok(bytes(result) <= HISTORY_PAGE_BYTES);
  }
});

test('orphans count as consumed bindings instead of inventing records or scanning to fill the job count', () => {
  const first = job('first'), second = job('second');
  const f = fixture(['orphan-start', 'first', 'orphan-end', 'second'], [second, first], [11, 29, 87, 203]);
  const result = f.read(3);
  assert.deepEqual(result.jobs, [first]); assert.equal(result.nextCursor, f.cursors[2]);
  assert.deepEqual(f.calls, [{ limit: 3 }]);
  const next = f.read(3, result.nextCursor);
  assert.deepEqual(next.jobs, [second]); assert.equal(next.nextCursor, null);
  assert.deepEqual(f.calls[1], { limit: 3, after: f.cursors[2] });
});

test('empty and orphan-only pages keep the authoritative end/continuation cursor without extra reads', () => {
  const empty = fixture([], [job('global')]);
  assert.deepEqual(empty.read(), page([], null)); assert.equal(empty.calls.length, 1);
  const missing = fixture(['missing-1', 'missing-2', 'missing-3'], [job('global')], [100, 210, 509]);
  assert.deepEqual(missing.read(2), page([], missing.cursors[1]!)); assert.equal(missing.calls.length, 1);
  assert.deepEqual(missing.read(2, missing.cursors[1]!), page([], null)); assert.equal(missing.calls.length, 2);
});

test('unbound/foreign service records are never serialized, even with hostile serialization data', () => {
  const foreign = job('foreign') as AssetJobRecord & { toJSON?: () => never; cycle?: unknown };
  foreign.toJSON = () => { assert.fail('Foreign job was serialized'); };
  foreign.cycle = foreign;
  const own = job('own'), f = fixture(['own', 'orphan'], [foreign, own]);
  assert.deepEqual(f.read(2), page([own], null)); assert.equal(f.calls.length, 1);
});

test('byte cuts return the host cursor after the last consumed orphan with at most two calls', () => {
  const first = sizedJob('first', 240000), second = sizedJob('second', 240000), third = sizedJob('third', 240000);
  const f = fixture(['orphan-0', 'first', 'orphan-1', 'second', 'orphan-2', 'third'],
    [third, first, second], [4, 21, 101, 304, 905, 1703]);
  const result = f.read(6);
  assert.deepEqual(result.jobs, [first, second]); assert.equal(result.nextCursor, f.cursors[4]);
  assert.deepEqual(f.calls, [{ limit: 6 }, { limit: 5 }]); assert.equal(f.jobReads, 1);
  assert.ok(bytes(result) <= HISTORY_PAGE_BYTES);
  const next = f.read(6, result.nextCursor);
  assert.deepEqual(next.jobs, [third]); assert.equal(next.nextCursor, null);
  assert.deepEqual(f.calls.slice(2), [{ limit: 6, after: f.cursors[4] }]);
});

test('an overflow prefix read reuses the original after cursor and never the full-page cursor', () => {
  const records = [job('prior'), sizedJob('first', 300000), sizedJob('second', 300000), job('later')];
  const f = fixture(['prior', 'first', 'orphan', 'second', 'later'], records, [9, 37, 151, 701, 2301]);
  const after = f.cursors[0]!, result = f.read(3, after);
  assert.deepEqual(result.jobs, [records[1]]); assert.equal(result.nextCursor, f.cursors[2]);
  assert.deepEqual(f.calls, [{ limit: 3, after }, { limit: 2, after }]);
});

test('UTF-8 job and wrapper bytes include Unicode, JSON escaping and the returned cursor', () => {
  const first = job('first', '🌿é\n"\\'.repeat(24000)), second = job('second', '🌿é\n"\\'.repeat(24000));
  const f = fixture(['first', 'second'], [first, second]);
  f.scope.projectPath = 'C:/synthetic/项目/é🌿';
  const result = f.read(2);
  assert.deepEqual(result.jobs, [first]); assert.equal(result.nextCursor, f.cursors[0]);
  assert.ok(bytes(result) <= HISTORY_PAGE_BYTES);
  assert.ok(bytes(page([first, second], null, f.scope)) > HISTORY_PAGE_BYTES);
  assert.equal(f.calls.length, 2);
});

test('an exactly full terminal page stays one read and does not reserve a nonexistent cursor', () => {
  const overhead = bytes(page([], null)), record = sizedJob('exact', HISTORY_PAGE_BYTES - overhead);
  const f = fixture(['exact'], [record]), result = f.read(1);
  assert.equal(bytes(result), HISTORY_PAGE_BYTES); assert.equal(result.nextCursor, null);
  assert.deepEqual(result.jobs, [record]); assert.deepEqual(f.calls, [{ limit: 1 }]);
});

test('an exactly full nonterminal page accounts for its real cursor in the one-read fast path', () => {
  const overhead = bytes(page([], cursor(1))), record = sizedJob('exact', HISTORY_PAGE_BYTES - overhead);
  const f = fixture(['exact', 'later'], [record, job('later')]), result = f.read(1);
  assert.equal(bytes(result), HISTORY_PAGE_BYTES); assert.equal(result.nextCursor, f.cursors[0]);
  assert.equal(f.calls.length, 1);
});

test('a first job near the cap is checked against its exact prefix cursor instead of rejected by cursor reservation', () => {
  const overhead = bytes(page([], cursor(1))), record = sizedJob('exact', HISTORY_PAGE_BYTES - overhead);
  const f = fixture(['exact', 'later'], [record, job('later')]), result = f.read(2);
  assert.equal(bytes(result), HISTORY_PAGE_BYTES); assert.deepEqual(result.jobs, [record]);
  assert.equal(result.nextCursor, f.cursors[0]); assert.deepEqual(f.calls, [{ limit: 2 }, { limit: 1 }]);
});

test('single oversized records throw HISTORY_LIMIT without retry or a prefix read', () => {
  const f = fixture(['orphan', 'huge', 'later'], [sizedJob('huge', HISTORY_PAGE_BYTES), job('later')]);
  assert.throws(() => f.read(3), code('HISTORY_LIMIT'));
  assert.deepEqual(f.calls, [{ limit: 3 }]); assert.equal(f.jobReads, 1);
});

test('a record that fits only with terminal null still fails if its required real cursor exceeds the cap', () => {
  const overhead = bytes(page([], null)), record = sizedJob('exact', HISTORY_PAGE_BYTES - overhead);
  const f = fixture(['exact', 'later'], [record, job('later')]);
  assert.throws(() => f.read(2), code('HISTORY_LIMIT')); assert.equal(f.calls.length, 1);
});

test('a first record in cursor uncertainty fails closed when the actual prefix cursor is still too large', () => {
  const overhead = bytes(page([], cursor(102))), record = sizedJob('almost', HISTORY_PAGE_BYTES - overhead + 1);
  const f = fixture(['almost', 'later'], [record, job('later')], [102, 205]);
  assert.throws(() => f.read(2), code('HISTORY_LIMIT')); assert.equal(f.calls.length, 2);
});

test('the captured one-page scope survives a later live change without another host attestation read', () => {
  const record = job('own'), f = fixture(['own'], [record]);
  f.onJobs(() => {
    f.scope.conversation.threadId = 'Later:Thread'; f.bindings[0]!.conversation.threadId = 'Later:Thread';
    f.scope.projectPath = 'C:/later/project';
  });
  const result = f.read(1);
  assert.deepEqual(result, page([record], null)); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('Later:Thread'));
});

test('second reads reject every exact project/native change with ASSET_CONVERSATION_STALE', () => {
  const changes = [
    { projectId: '2'.repeat(64) }, { projectPath: 'C:/Synthetic/project' },
    { conversation: { ...NATIVE, provider: 'claude-code' as const } },
    { conversation: { ...NATIVE, threadId: 'Another:Thread' } },
    { conversation: { ...NATIVE, threadId: NATIVE.threadId.toLowerCase() } },
    { conversation: { ...NATIVE, sessionId: null } },
    { conversation: { ...NATIVE, sessionId: 'Another:Session' } },
    { conversation: { ...NATIVE, sessionId: NATIVE.sessionId!.toLowerCase() } },
  ];
  for (const change of changes) {
    const f = fixture(['first', 'second'], [sizedJob('first', 300000), sizedJob('second', 300000)]);
    f.onPage((output, n) => n === 1 ? output : {
      ...output, ...change, items: output.items.map(item => ({ ...item,
        projectId: change.projectId ?? item.projectId, conversation: change.conversation ?? item.conversation })),
    });
    assert.throws(() => f.read(2), code('ASSET_CONVERSATION_STALE'));
    assert.equal(f.calls.length, 2); assert.equal(f.jobReads, 1);
  }
});

test('second reads require each exact captured binding field and ordered prefix', () => {
  const mutations: ((items: ConversationWorkBinding[]) => ConversationWorkBinding[])[] = [
    items => items.map((item, i) => i ? item : { ...item, id: 'changed' }),
    items => items.map((item, i) => i ? item : { ...item, projectId: '2'.repeat(64) }),
    items => items.map((item, i) => i ? item : { ...item, kind: 'workflow' }),
    items => items.map((item, i) => i ? item : { ...item, conversation: { ...NATIVE, sessionId: null } }),
    items => items.toReversed(), items => items.slice(1), items => [...items, binding('extra')],
  ];
  for (const mutate of mutations) {
    const f = fixture(['orphan', 'first', 'second'], [sizedJob('first', 300000), sizedJob('second', 300000)]);
    f.onPage((output, n) => n === 1 ? output : { ...output, items: mutate(output.items) });
    assert.throws(() => f.read(3), code('ASSET_CONVERSATION_STALE'));
    assert.deepEqual(f.calls, [{ limit: 3 }, { limit: 2 }]);
  }
});

test('prefix mutation of reused original objects cannot hide stale binding or scope changes', () => {
  const f = fixture(['first', 'second'], [sizedJob('first', 300000), sizedJob('second', 300000)]);
  f.onPage((output, n) => {
    if (n === 2) f.bindings[0]!.id = 'changed-original-object';
    return output;
  });
  assert.throws(() => f.read(2), code('ASSET_CONVERSATION_STALE')); assert.equal(f.calls.length, 2);
});

test('prefix cursor absence, non-advancement or failed observation cannot trigger a third read', () => {
  for (const issue of ['null', 'same-after', 'throw'] as const) {
    const f = fixture(['prior', 'first', 'second'], [job('prior'), sizedJob('first', 300000), sizedJob('second', 300000)]);
    const after = f.cursors[0]!;
    f.onPage((output, n) => {
      if (n === 1) return output;
      if (issue === 'throw') throw new ArcaneError('CONVERSATION_WORK_INPUT', 'Synthetic context change.');
      return { ...output, nextCursor: issue === 'null' ? null : after };
    });
    assert.throws(() => f.read(2, after), code('ASSET_CONVERSATION_STALE')); assert.equal(f.calls.length, 2);
  }
});

test('native object key order does not substitute for exact tuple comparison on the prefix read', () => {
  const f = fixture(['first', 'second'], [sizedJob('first', 300000), sizedJob('second', 300000)]);
  f.onPage((output, n) => n === 1 ? output : { ...output,
    conversation: { sessionId: NATIVE.sessionId, threadId: NATIVE.threadId, provider: NATIVE.provider } });
  const result = f.read(2);
  assert.deepEqual(result.conversation, NATIVE); assert.deepEqual(result.jobs.map(record => record.jobId), ['first']);
  assert.equal(f.calls.length, 2);
});

test('corrupt first-page counts, holes, duplicates, namespaces and foreign metadata fail before hydration', () => {
  const mutations: ((output: AssetConversationListing) => AssetConversationListing)[] = [
    output => ({ ...output, items: [...output.items, binding('extra')] }),
    output => ({ ...output, items: [] }),
    output => ({ ...output, items: [output.items[0]!] }),
    output => ({ ...output, items: [output.items[0]!, output.items[0]!] }),
    output => ({ ...output, items: [binding('first'), { ...binding('second'), kind: 'workflow' }] }),
    output => ({ ...output, items: [binding('first'), { ...binding('second'), projectId: '2'.repeat(64) }] }),
    output => ({ ...output, items: [binding('first'), { ...binding('second'), conversation: { ...NATIVE, sessionId: null } }] }),
    output => ({ ...output, items: Array(2) as ConversationWorkBinding[] }),
  ];
  for (const mutate of mutations) {
    const f = fixture(['first', 'second', 'later'], [job('first'), job('second')]);
    f.onPage(output => mutate(output));
    assert.throws(() => f.read(2), code('ASSET_CONVERSATION_STALE'));
    assert.equal(f.calls.length, 1); assert.equal(f.jobReads, 0);
  }
});

test('invalid count/after/options data refuse all host and service calls without accessor evaluation', () => {
  const f = fixture([], []); let reads = 0;
  const values: unknown[] = [null, [], {}, { limit: 1 }, { limit: 1, after: undefined },
    { limit: 0, after: null }, { limit: 65, after: null }, { limit: 1.5, after: null },
    { limit: Infinity, after: null }, { limit: NaN, after: null }, { limit: '1', after: null },
    { limit: 1n, after: null }, { limit: 1, after: false }, { limit: 1, after: null, conversation: NATIVE },
    { get limit() { reads++; return 1; }, after: null },
    Object.create({ limit: 1, after: null }),
    new Proxy({ limit: 1, after: null }, { get() { reads++; return 1; } }),
  ];
  for (const options of values) {
    assert.throws(() => assetConversationJobPage(f.service, f.host, options as { limit: number; after: string | null }), code('INPUT'));
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, 0); assert.equal(f.jobReads, 0);
});

test('initial host cursor/scope failures propagate without service reads or live inference', () => {
  const f = fixture([], []), error = new ArcaneError('ASSET_CONVERSATION_REQUIRED', 'Synthetic missing native context.');
  f.onPage(() => { throw error; });
  assert.throws(() => f.read(1), caught => caught === error);
  assert.equal(f.calls.length, 1); assert.equal(f.jobReads, 0);
  const other = fixture(['first'], [job('first')]);
  assert.throws(() => other.read(1, 'unrecognized-cursor'), code('CONVERSATION_WORK_INPUT'));
  assert.equal(other.calls.length, 1); assert.equal(other.jobReads, 0);
});

test('pagination is deterministic with gapped storage cursors and no input/record mutation', () => {
  const records = frozen([job('first'), job('second'), job('third')]);
  const f = fixture(['first', 'orphan', 'second', 'third'], records, [10, 45, 304, 801]);
  frozen(f.bindings); frozen(f.scope);
  const options = frozen({ limit: 2, after: null });
  const first = assetConversationJobPage(f.service, f.host, options);
  const second = assetConversationJobPage(f.service, f.host, options);
  assert.deepEqual(first, second); assert.equal(first.nextCursor, f.cursors[1]);
  assert.deepEqual(first.jobs, [records[0]]); assert.deepEqual(f.calls, [{ limit: 2 }, { limit: 2 }]);
});
