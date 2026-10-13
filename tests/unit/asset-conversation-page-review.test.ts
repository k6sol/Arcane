import test from 'node:test';
import assert from 'node:assert/strict';
import { assetConversationJobPage, type AssetConversationJobPage } from '../../apps/daemon/src/asset-conversation-page.js';
import type { AssetConversationHost, AssetConversationListing } from '../../apps/daemon/src/asset-conversation-host.js';
import { HISTORY_PAGE_BYTES, type AssetJobRecord, type AssetService } from '../../apps/daemon/src/asset-service.js';
import type { ConversationWorkBinding, NativeConversation } from '../../packages/storage/src/conversation-work-store.js';

const native: NativeConversation = {
  provider: 'codex', threadId: 'Review:Thread.Exact', sessionId: 'Review:Session.Exact',
};
const scope = {
  projectId: '1'.repeat(64), projectPath: 'C:/synthetic/review-project', conversation: native,
};
const cursor = (sequence: number) => 'c'.repeat(64) + ':' + sequence;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
type Query = { limit: number; after?: string };

function job(jobId: string): AssetJobRecord {
  return {
    schemaVersion: 1, jobId, directory: 'synthetic/output/' + jobId, manifestPath: null,
    request: {
      schemaVersion: 1, template: 'hero-prop', name: 'fixture-' + jobId, seed: 1,
      sizeMeters: [1, 1, 1], color: [0.1, 0.2, 0.3], triangleBudget: 5000,
      renderResolution: 384, renderSamples: 16,
    },
    state: 'failed', stage: 'Synthetic retained evidence: café 🌿',
    startedAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:01.000Z',
    events: [], manifestAvailable: false, error: { code: 'FIXTURE', message: 'Retain the complete failed record.' },
  };
}

function page(jobs: AssetJobRecord[], nextCursor: string | null): AssetConversationJobPage {
  return { ...scope, conversation: { ...native }, jobs, nextCursor, byteLimit: HISTORY_PAGE_BYTES };
}

function fixture(nonterminal: boolean) {
  const exact = job('exact');
  exact.stage += 'x'.repeat(HISTORY_PAGE_BYTES - bytes(page([exact], cursor(9))));
  assert.equal(bytes(page([exact], cursor(9))), HISTORY_PAGE_BYTES);
  assert.equal(bytes(page([exact], cursor(10))), HISTORY_PAGE_BYTES + 1);

  const later = job('later'), tail = job('tail');
  const records = nonterminal ? [exact, later, tail] : [exact, later];
  const entries = [
    { id: exact.jobId, sequence: 9 },
    { id: 'orphan', sequence: 10 },
    { id: later.jobId, sequence: 20 },
    ...(nonterminal ? [{ id: tail.jobId, sequence: 21 }] : []),
  ];
  const bindings: ConversationWorkBinding[] = entries.map(entry => ({
    projectId: scope.projectId, kind: 'asset-job', id: entry.id, conversation: { ...native },
  }));
  const calls: Query[] = [];
  let jobReads = 0;
  const host: AssetConversationHost = {
    listHuman(input: unknown = {}) {
      const query = input as Query;
      calls.push({ ...query });
      const previous = query.after === undefined ? -1
        : entries.findIndex(entry => cursor(entry.sequence) === query.after);
      assert.ok(query.after === undefined || previous >= 0, 'Use only an authoritative storage cursor');
      const start = previous + 1, items = bindings.slice(start, start + query.limit);
      const end = start + items.length;
      const output: AssetConversationListing = {
        ...scope, conversation: { ...native }, items,
        nextCursor: end < entries.length ? cursor(entries[end - 1]!.sequence) : null,
      };
      return output;
    },
    startHuman() { assert.fail('A history read must not start work'); },
    startAgent() { assert.fail('A history read must not start work'); },
    bindingHuman() { assert.fail('A history read must not infer conversation from a live binding'); },
  };
  const service = new Proxy({
    jobs() { jobReads++; return structuredClone(records); },
  }, {
    get(target, key, receiver) {
      assert.equal(key, 'jobs', 'Use only the trusted service snapshot');
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as AssetService;
  return { exact, later, tail, calls, host, service, get jobReads() { return jobReads; } };
}

// Pure metadata/service fixtures, with gapped sequences as allowed by the store.
// The first record fits exactly with :9; consuming its following orphan changes
// the cursor to :10 and adds one byte. A valid cut must leave that orphan for the
// next page instead of throwing HISTORY_LIMIT. No journals or providers are read.
for (const nonterminal of [false, true]) {
  test('review: exact 512 KiB record survives orphan cursor digit growth on a '
    + (nonterminal ? 'nonterminal' : 'terminal') + ' captured page', () => {
    const baseline = fixture(nonterminal);
    const single = assetConversationJobPage(baseline.service, baseline.host, { limit: 1, after: null });
    assert.deepEqual(single, page([baseline.exact], cursor(9)));
    assert.equal(bytes(single), HISTORY_PAGE_BYTES);
    assert.equal(single.jobs[0]!.state, 'failed');
    assert.equal(single.jobs[0]!.manifestAvailable, false);
    assert.equal(single.jobs[0]!.manifestPath, null);
    assert.deepEqual(baseline.calls, [{ limit: 1 }]);
    assert.equal(baseline.jobReads, 1);

    const f = fixture(nonterminal);
    const result = assetConversationJobPage(f.service, f.host, { limit: 3, after: null });

    assert.equal(bytes(result), HISTORY_PAGE_BYTES);
    assert.deepEqual(result, page([f.exact], cursor(9)));
    assert.equal(result.jobs[0]!.state, 'failed');
    assert.equal(result.jobs[0]!.manifestAvailable, false);
    assert.equal(result.jobs[0]!.manifestPath, null);
    assert.equal(f.jobReads, 1);
    assert.deepEqual(f.calls[0], { limit: 3 });
    assert.ok(f.calls.length === 2,
      'Exactly one regular read and one prefix metadata read');
    assert.ok(f.calls.slice(1).every(query => query.limit < 3 && query.after === undefined));
    assert.ok(f.calls.slice(1).some(query => query.limit === 1),
      'Verify the cursor before the orphan when consuming it would overflow');

    const previousCalls = f.calls.length;
    const next = assetConversationJobPage(f.service, f.host, { limit: 3, after: result.nextCursor });
    assert.deepEqual(next, page(nonterminal ? [f.later, f.tail] : [f.later], null));
    assert.equal(f.calls.length, previousCalls + 1, 'The continuation counts the orphan within its binding limit');
    assert.deepEqual(f.calls.at(-1), { limit: 3, after: cursor(9) });
    assert.equal(f.jobReads, 2);
  });
}
