import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticAssetPreviews, type AutomaticAssetPreviewJob } from '../../apps/desktop/src/automatic-asset-previews.js';

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
const T2 = '2026-10-14T10:02:00.000Z';
const T3 = '2026-10-14T10:03:00.000Z';
const T4 = '2026-10-14T10:04:00.000Z';
const job = (jobId: string, startedAt = T1, state = 'running', manifestAvailable = state === 'succeeded'): AutomaticAssetPreviewJob =>
  ({ jobId, startedAt, state, manifestAvailable });
const choices = (previews: AutomaticAssetPreviews) => ({ pending: previews.pending(), ready: previews.ready() });
const none = { pending: null, ready: null };
const established = () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('baseline', T1, 'succeeded')]);
  return previews;
};

test('first HEAD establishes a baseline; existing completions never autoload, including delayed manifests', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('old', T0, 'succeeded'), job('newest', T2, 'succeeded', false)]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('newest', T2, 'succeeded'), job('old', T0, 'succeeded')]);
  previews.markReady('newest');
  assert.deepEqual(choices(previews), none);
  previews.observe([job('between-polls', T3, 'succeeded')]);
  assert.equal(previews.ready(), 'between-polls');
});

test('initial HEAD running jobs remain eligible even when older than the baseline maximum', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('old-running', T0), job('history', T4, 'succeeded')]);
  assert.equal(previews.pending(), 'old-running');
  previews.markPending('old-running');
  assert.deepEqual(choices(previews), none);
  previews.observe([job('history', T4, 'succeeded')]); // Absence does not forget a running identity.
  previews.observe([job('old-running', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'old-running');
});

test('empty HEAD is a baseline and admits an instant completion on the next HEAD', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([]);
  previews.observe([job('instant', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'instant');
});

test('baseline maximum is fixed across subsequent HEAD polls, gaps and backfill', () => {
  const previews = established();
  previews.observe([job('later-running', T4)]);
  previews.observe([job('future-backfill', '2099-01-01T00:00:00Z', 'succeeded')], true);
  previews.observe([]);
  previews.observe([job('missed-completion', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'missed-completion');
});

test('unseen HEAD completions must start strictly after baseline, with IDs supplying no authority', () => {
  const previews = established();
  previews.observe([job('z-older', T0, 'succeeded'), job('z-equal', T1, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('a-newer', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'a-newer');
});

test('Date.parse instants, rather than textual dates or local time, order and admit jobs', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('baseline', '2026-10-14T11:01:00+01:00', 'succeeded')]);
  previews.observe([
    job('z-equal', T1, 'succeeded'),
    job('later-text-earlier-instant', '2026-10-14T12:00:00+02:00', 'succeeded'),
    job('a-newer', '2026-10-14T05:02:00-05:00', 'succeeded'),
  ]);
  assert.equal(previews.ready(), 'a-newer');
  previews.markReady('a-newer');
  assert.deepEqual(choices(previews), none);
});

test('unseen HEAD running jobs are eligible regardless of their startedAt age', () => {
  const previews = established();
  previews.observe([job('older-running', T0)]);
  assert.equal(previews.pending(), 'older-running');
  previews.observe([job('older-running', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'older-running');
});

test('succeeded jobs wait for a manifest without losing initial running admission', () => {
  const previews = established();
  previews.observe([job('running', T0)]);
  previews.markPending('running');
  previews.observe([job('running', T0, 'succeeded', false)]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('running', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'running');
});

test('instant completion admission also survives a delayed manifest', () => {
  const previews = established();
  previews.observe([job('instant', T2, 'succeeded', false)]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('instant', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'instant');
});

test('MORE before HEAD cannot establish the baseline or admit a backfill job', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([], true);
  previews.observe([job('backfill-running', T0), job('backfill-ready', T4, 'succeeded')], true);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('head-history', T1, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('instant', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'instant');
});

test('first HEAD admits its running rows even if those identities were first seen in MORE', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('running', T0), job('completed', T1, 'succeeded')], true);
  previews.observe([job('running', T0), job('completed', T1, 'succeeded')]);
  assert.equal(previews.pending(), 'running');
  assert.equal(previews.ready(), null);
});

test('MORE identities cannot gain eligibility by reappearing or completing on later HEAD', () => {
  const previews = established();
  previews.observe([job('backfill-running', T2), job('backfill-ready', T3, 'succeeded')], true);
  previews.observe([job('backfill-running', T2), job('backfill-ready', T3, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('backfill-running', T2, 'succeeded'), job('backfill-ready', T3, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('MORE may update an already eligible running job but cannot create eligibility', () => {
  const previews = established();
  previews.observe([job('head-running', T0)]);
  previews.observe([job('head-running', T0, 'succeeded'), job('backfill', T3, 'succeeded')], true);
  assert.equal(previews.ready(), 'head-running');
  previews.markReady('head-running');
  previews.observe([job('backfill', T3, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('pending and ready selection are newest first and independent of snapshot order', () => {
  const previews = established();
  previews.observe([job('older-running', T0), job('newer-running', T3), job('middle-running', T2)]);
  assert.equal(previews.pending(), 'newer-running');
  previews.markPending('newer-running');
  assert.equal(previews.pending(), 'middle-running');
  previews.markPending('middle-running');
  assert.equal(previews.pending(), 'older-running');
  previews.observe([job('middle-running', T2, 'succeeded'), job('newer-running', T3, 'succeeded')]);
  assert.equal(previews.ready(), 'newer-running');
});

test('IDs only provide stable presentation ties; equal instants are not considered older', () => {
  for (const reverse of [false, true]) {
    const previews = established();
    const rows = [job('a', T2), job('z', '2026-10-14T11:02:00+01:00')];
    previews.observe(reverse ? rows.reverse() : rows);
    assert.equal(previews.pending(), 'z');
    previews.markPending('z');
    assert.equal(previews.pending(), 'a');
    previews.observe([job('a', T2, 'succeeded'), job('z', '2026-10-14T11:02:00+01:00', 'succeeded')]);
    assert.equal(previews.ready(), 'z');
    previews.markReady('z');
    assert.equal(previews.ready(), 'a');
  }
});

test('markPending notices once across repeated polls without blocking the ready transition', () => {
  const previews = established();
  previews.observe([job('live', T2)]);
  for (let i = 0; i < 4; i++) assert.equal(previews.pending(), 'live');
  previews.markPending('live');
  for (let i = 0; i < 4; i++) {
    previews.observe([job('live', T2)]);
    assert.deepEqual(choices(previews), none);
  }
  previews.observe([job('live', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'live');
});

test('markReady before loading consumes one attempt, including a failed load', () => {
  const previews = established();
  const attempts: string[] = [];
  previews.observe([job('instant', T2, 'succeeded')]);
  for (let i = 0; i < 4; i++) {
    const ready = previews.ready();
    if (ready) {
      previews.markReady(ready);
      attempts.push(ready); // Simulated loader failure deliberately makes no completion acknowledgement.
    }
    previews.observe([job('instant', T2, 'succeeded')]);
  }
  assert.deepEqual(attempts, ['instant']);
  assert.deepEqual(choices(previews), none);
});

test('attempting the newest ready job suppresses older ready and later-completing pending jobs', () => {
  const previews = established();
  previews.observe([job('old-pending', T0), job('old-ready', T2, 'succeeded'), job('new-ready', T3, 'succeeded')]);
  assert.equal(previews.ready(), 'new-ready');
  previews.markReady('new-ready');
  assert.deepEqual(choices(previews), none);
  previews.observe([job('old-pending', T0, 'succeeded'), job('old-ready', T2, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('newer-still', T4, 'succeeded')]);
  assert.equal(previews.ready(), 'newer-still');
});

test('preview watermark also suppresses older jobs first encountered after selection', () => {
  const previews = established();
  previews.observe([job('selected', T3, 'succeeded')]);
  previews.markReady('selected');
  previews.observe([job('late-old-running', T0), job('late-old-ready', T2, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('late-old-running', T0, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('unknown, historical, premature or malformed marks cannot claim a future job or advance the watermark', () => {
  const previews = established();
  for (const id of ['future', 'baseline', '../invalid', '']) {
    previews.markPending(id);
    previews.markReady(id);
  }
  previews.observe([job('future', T2)]);
  previews.markReady('future');
  assert.equal(previews.pending(), 'future');
  previews.observe([job('future', T2, 'succeeded', false)]);
  previews.markReady('future');
  previews.observe([job('future', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'future');
});

test('manual selection mutes every known eligible job, including noticed and manifest-delayed jobs', () => {
  const previews = established();
  previews.observe([job('noticed', T0), job('pending', T2), job('ready', T3, 'succeeded'), job('waiting-manifest', T4, 'succeeded', false)]);
  previews.markPending('noticed');
  previews.muteObserved();
  assert.deepEqual(choices(previews), none);
  previews.observe([
    job('noticed', T0, 'succeeded'), job('pending', T2, 'succeeded'),
    job('ready', T3, 'succeeded'), job('waiting-manifest', T4, 'succeeded'),
  ]);
  previews.markReady('ready');
  assert.deepEqual(choices(previews), none);
  previews.observe([job('future-new', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'future-new', 'Manual mute is per observed identity, not a timestamp cutoff.');
});

test('mute before any observation leaves future jobs eligible', () => {
  const previews = new AutomaticAssetPreviews();
  previews.muteObserved();
  previews.observe([job('fresh', T0)]);
  assert.equal(previews.pending(), 'fresh');
  previews.observe([job('fresh', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'fresh');
});

test('fresh running jobs after manual mute still receive pending then ready', () => {
  const previews = established();
  previews.observe([job('muted', T3)]);
  previews.muteObserved();
  previews.observe([job('fresh', T0)]);
  assert.equal(previews.pending(), 'fresh');
  previews.markPending('fresh');
  previews.observe([job('fresh', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'fresh');
});

for (const state of ['failed', 'cancelled', 'timed_out', 'interrupted']) {
  test(`${state} jobs never offer ready, even with a manifest; their terminal outcome remains valid`, () => {
    const previews = established();
    previews.observe([job('live', T0)]);
    previews.observe([job('live', T0, state, true), job('unseen-terminal', T2, state, true)]);
    assert.deepEqual(choices(previews), none);
    previews.observe([job('live', T0, state, false), job('unseen-terminal', T2, state, true), job('healthy', T3)]);
    assert.equal(previews.pending(), 'healthy');
  });
}

test('baseline maximum includes unsuccessful terminal jobs', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('failed-history', T3, 'failed')]);
  previews.observe([job('earlier-completion', T2, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('exactly 256 identities are allowed; repeated polls and marks do not consume more capacity', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([]);
  const rows = Array.from({ length: 256 }, (_, i) => job('job-' + i.toString().padStart(3, '0'), T2));
  for (let i = 0; i < 4; i++) previews.observe(rows);
  assert.equal(previews.pending(), 'job-255');
  previews.markPending('job-255');
  previews.observe([job('job-255', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'job-255');
  previews.markReady('job-255');
  assert.equal(previews.pending(), 'job-254');
});

test('cumulative cap counts disappeared, muted, attempted and MORE identities and freezes until reset', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([]);
  previews.observe([job('attempted', T2, 'succeeded')]);
  previews.markReady('attempted');
  previews.observe([job('muted', T3)]);
  previews.muteObserved();
  for (let i = 0; i < 253; i++) previews.observe([job('backfill-' + i, T0, 'succeeded')], true);
  previews.observe([job('last-slot', T4)]);
  assert.equal(previews.pending(), 'last-slot');
  previews.observe([job('overflow', T4)]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('last-slot', T4, 'succeeded')]);
  previews.observe([]);
  assert.deepEqual(choices(previews), none, 'Overflow cannot clear identities or silently start a new baseline.');
  previews.reset();
  previews.observe([job('last-slot', T4, 'succeeded')]);
  assert.deepEqual(choices(previews), none, 'Reset establishes a fresh baseline rather than replaying completion.');
  previews.observe([job('fresh', '2026-10-14T10:05:00Z', 'succeeded')]);
  assert.equal(previews.ready(), 'fresh');
});

test('a batch that crosses cumulative capacity freezes before admitting any of its jobs', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([]);
  previews.observe(Array.from({ length: 255 }, (_, i) => job('known-' + i, T0, 'succeeded')));
  previews.observe([job('fits-alone', T3), job('exceeds', T4, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.markPending('fits-alone');
  previews.markReady('exceeds');
  previews.observe([job('known-0', T0, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('oversized rows are bounded and freeze the epoch rather than truncating or replaying', () => {
  const previews = established();
  previews.observe(Array.from({ length: 257 }, (_, i) => job('oversized-' + i, T3)));
  previews.observe([job('fresh', T4, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('reset clears baseline, watermark, marks, manual mutes and identity capacity', () => {
  const previews = established();
  previews.observe([job('selected', T4, 'succeeded')]);
  previews.markReady('selected');
  previews.observe([job('muted', T4)]);
  previews.muteObserved();
  previews.reset();
  previews.observe([job('muted', T0)]); // Same ID, new epoch and immutable timestamp.
  assert.equal(previews.pending(), 'muted');
  previews.markPending('muted');
  previews.observe([job('muted', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'muted');
  previews.markReady('muted');
  previews.reset();
  previews.observe([]);
  previews.observe([job('selected', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'selected');
});

for (const more of [false, true]) {
  test(`identity startedAt conflicts quarantine a whole ${more ? 'MORE' : 'HEAD'} batch until reset`, () => {
    const previews = established();
    previews.observe([job('known', T2)]);
    previews.observe([job('valid-new', T4, 'succeeded'), job('known', T3)], more);
    assert.deepEqual(choices(previews), none);
    previews.observe([job('known', T2, 'succeeded'), job('later-valid', T4)]);
    assert.deepEqual(choices(previews), none, 'A corrected later poll cannot restore a conflicted identity.');
    previews.reset();
    previews.observe([job('known', T3)]);
    assert.equal(previews.pending(), 'known');
  });
}

test('startedAt identity is immutable even for an equivalent timestamp spelling', () => {
  const previews = established();
  previews.observe([job('known', T2)]);
  previews.observe([job('known', '2026-10-14T11:02:00.000+01:00')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('known', T2, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

for (const terminal of ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']) {
  for (const more of [false, true]) {
    test(`${terminal} -> running on ${more ? 'MORE' : 'HEAD'} quarantines the entire epoch`, () => {
      const previews = established();
      previews.observe([job('terminal', T2, terminal)]);
      previews.observe([job('valid-new', T4, 'succeeded'), job('terminal', T2)], more);
      assert.deepEqual(choices(previews), none);
      previews.observe([job('terminal', T2, terminal), job('future', T4)]);
      assert.deepEqual(choices(previews), none);
    });
  }
}

test('terminal-to-terminal changes are accepted without establishing new eligibility', () => {
  const terminals = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  for (const before of terminals) {
    for (const after of terminals) {
      const previews = new AutomaticAssetPreviews();
      previews.observe([job('historical', T2, before)]);
      previews.observe([job('historical', T2, after)]);
      assert.deepEqual(choices(previews), none);
      previews.observe([job('fresh', T4)]);
      assert.equal(previews.pending(), 'fresh', `${before} -> ${after} must not quarantine the epoch.`);
    }
  }
});

for (const more of [false, true]) {
  test(`interrupted -> succeeded recovery on ${more ? 'MORE' : 'HEAD'} retains older running admission`, () => {
    const previews = new AutomaticAssetPreviews();
    previews.observe([job('live', T0), job('history', T4, 'succeeded')]);
    previews.markPending('live');
    previews.observe([job('live', T0, 'interrupted')]);
    assert.deepEqual(choices(previews), none);
    previews.observe([job('live', T0, 'succeeded', false)], more);
    assert.deepEqual(choices(previews), none);
    previews.observe([job('live', T0, 'succeeded')], more);
    assert.equal(previews.ready(), 'live');
    previews.markReady('live');
    previews.observe([job('live', T0, 'interrupted')]);
    previews.observe([job('live', T0, 'succeeded')], more);
    assert.deepEqual(choices(previews), none, 'Terminal recovery cannot replay an attempted preview.');
  });
}

test('recovering an interrupted backfill job cannot admit it on later HEAD', () => {
  const previews = established();
  previews.observe([job('backfill', T3, 'interrupted')], true);
  previews.observe([job('backfill', T3, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('fresh', T4, 'succeeded')]);
  assert.equal(previews.ready(), 'fresh');
});

test('manual mutes and the selected preview watermark survive terminal recovery', () => {
  const previews = established();
  previews.observe([job('muted', T4)]);
  previews.observe([job('muted', T4, 'interrupted')]);
  previews.muteObserved();
  previews.observe([job('muted', T4, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('old', T0), job('selected', T3, 'succeeded')]);
  previews.markReady('selected');
  previews.observe([job('old', T0, 'interrupted')]);
  previews.observe([job('old', T0, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('terminal recovery still requires an immutable job startedAt timestamp', () => {
  const previews = established();
  previews.observe([job('live', T0)]);
  previews.observe([job('live', T0, 'interrupted')]);
  previews.observe([job('valid-new', T4, 'succeeded'), job('live', T2, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('live', T0, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
});

test('identical duplicate and conflicting duplicate IDs reject a whole batch without consuming baseline', () => {
  for (const conflicting of [false, true]) {
    const previews = new AutomaticAssetPreviews();
    previews.observe([job('valid', T0), job('duplicate', T1), job('duplicate', conflicting ? T2 : T1)]);
    assert.deepEqual(choices(previews), none);
    previews.observe([job('history', T1, 'succeeded')]);
    assert.deepEqual(choices(previews), none, 'The first valid HEAD must remain historical.');
    previews.observe([job('valid', T0)]);
    assert.equal(previews.pending(), 'valid');
  }
});

test('duplicate batches do not partially complete known jobs or admit fresh jobs', () => {
  const previews = established();
  previews.observe([job('known', T0)]);
  previews.observe([job('known', T0, 'succeeded'), job('fresh', T3), job('fresh', T3)]);
  assert.equal(previews.pending(), 'known');
  assert.equal(previews.ready(), null);
  previews.observe([job('known', T0, 'succeeded')]);
  assert.equal(previews.ready(), 'known');
});

const invalidRows: [string, unknown][] = [
  ['empty ID', job('')], ['oversized ID', job('x'.repeat(65))], ['path ID', job('../job')],
  ['space ID', job(' job')], ['control ID', job('job\n')], ['non-ASCII ID', job('jób')],
  ['non-string ID', { ...job('valid'), jobId: 1 }], ['missing date', { jobId: 'invalid', state: 'running', manifestAvailable: false }],
  ['unparseable date', job('invalid', 'not-a-date')], ['date without timezone', job('invalid', '2026-10-14T10:01:00')],
  ['date without time', job('invalid', '2026-10-14')], ['short numeric date', job('invalid', '0')],
  ['oversized date', job('invalid', T1 + ' '.repeat(65))], ['control date', job('invalid', T1 + '\n')],
  ['non-string date', { ...job('invalid'), startedAt: 0 }], ['normalized invalid day', job('invalid', '2026-02-30T00:00:00Z')],
  ['invalid leap day', job('invalid', '2025-02-29T00:00:00Z')], ['invalid month', job('invalid', '2026-13-01T00:00:00Z')],
  ['invalid hour', job('invalid', '2026-10-14T24:00:00Z')], ['invalid timezone', job('invalid', '2026-10-14T10:01:00+25:00')],
  ['unsupported state', job('invalid', T1, 'completed')], ['non-string state', { ...job('invalid'), state: {} }],
  ['missing manifest flag', { jobId: 'invalid', startedAt: T1, state: 'running' }],
  ['non-boolean manifest flag', { ...job('invalid'), manifestAvailable: 'true' }],
  ['null row', null], ['array row', []], ['primitive row', 'invalid'], ['missing fields', {}],
];

for (const [label, invalid] of invalidRows) {
  test(`malformed ${label} rejects an entire snapshot without partial mutation`, () => {
    const previews = established();
    previews.observe([job('known', T0)]);
    previews.observe([job('known', T0, 'succeeded'), job('fresh', T3), invalid] as readonly AutomaticAssetPreviewJob[]);
    assert.equal(previews.pending(), 'known');
    assert.equal(previews.ready(), null);
    previews.observe([job('known', T0, 'succeeded')]);
    assert.equal(previews.ready(), 'known');
    previews.markReady('known');
    previews.observe([job('fresh', T3)]);
    assert.equal(previews.pending(), 'fresh');
  });
}

test('invalid initial HEAD cannot establish baseline or retain preceding valid rows', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([job('preceding', T4), job('invalid', 'not-a-date')]);
  previews.observe([job('history', T1, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('instant', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'instant');
});

test('malformed batches do not consume cumulative identity slots', () => {
  const previews = established();
  const rows = Array.from({ length: 255 }, (_, i) => job('valid-' + i.toString().padStart(3, '0'), T2));
  previews.observe([...rows, job('invalid', 'not-a-date')]);
  assert.deepEqual(choices(previews), none);
  previews.observe(rows);
  assert.equal(previews.pending(), 'valid-254');
});

test('invalid container, sparse array, mode and throwing fields do not establish baseline', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe(null as unknown as readonly AutomaticAssetPreviewJob[]);
  previews.observe({ length: 0 } as unknown as readonly AutomaticAssetPreviewJob[]);
  previews.observe(new Array<AutomaticAssetPreviewJob>(1));
  previews.observe([job('ignored', T4)], 'true' as unknown as boolean);
  const throwing = { get jobId(): string { throw new Error('Invalid snapshot getter'); } };
  assert.doesNotThrow(() => previews.observe([job('ignored', T4), throwing as AutomaticAssetPreviewJob]));
  previews.observe([job('history', T1, 'succeeded')]);
  assert.deepEqual(choices(previews), none);
  previews.observe([job('instant', T2, 'succeeded')]);
  assert.equal(previews.ready(), 'instant');
});

test('bounded valid IDs and leap timestamps are accepted', () => {
  const previews = new AutomaticAssetPreviews();
  previews.observe([]);
  const id = 'A_-' + 'x'.repeat(61);
  previews.observe([job(id, '2024-02-29T23:59:59.123Z', 'succeeded')]);
  assert.equal(previews.ready(), id);
});

test('stored snapshots belong to the coordinator, and input arrays and rows are never mutated', () => {
  const previews = new AutomaticAssetPreviews();
  const mutable = { ...job('owned', T0) }, rows = [mutable];
  previews.observe(rows);
  mutable.jobId = 'rewritten'; mutable.startedAt = T4; mutable.state = 'succeeded'; mutable.manifestAvailable = true;
  rows.splice(0);
  assert.equal(previews.pending(), 'owned');
  assert.equal(previews.ready(), null);
  previews.observe(Object.freeze([Object.freeze(job('owned', T0, 'succeeded'))]));
  assert.equal(previews.ready(), 'owned');
  const snapshot = Object.freeze([Object.freeze(job('new', T2))]);
  previews.observe(snapshot);
  previews.markPending('new');
  previews.muteObserved();
  previews.reset();
  assert.deepEqual(snapshot, [job('new', T2)]);
});

test('independent coordinator epochs cannot affect one another', () => {
  const first = established(), second = established();
  const snapshot = Object.freeze([Object.freeze(job('same-id', T2))]);
  first.observe(snapshot); second.observe(snapshot);
  first.markPending('same-id'); first.muteObserved();
  assert.equal(second.pending(), 'same-id');
  first.observe([job('same-id', T2, 'succeeded')]);
  second.observe([job('same-id', T2, 'succeeded')]);
  assert.equal(first.ready(), null);
  assert.equal(second.ready(), 'same-id');
  first.reset();
  assert.equal(second.ready(), 'same-id');
});
