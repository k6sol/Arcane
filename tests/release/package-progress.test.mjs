import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackageProgress } from '../../scripts/package-progress.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const capture = async promise => { try { return { rejected: false, value: await promise }; } catch (value) { return { rejected: true, value }; } };
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const path = index => 'resources/product/node_modules/example/file-' + index + '.js';

test('phase observations expose only frozen fixed diagnostic fields', async () => {
  const records = [], progress = createPackageProgress(record => { records.push(record); assert.ok(Object.isFrozen(record)); }, () => 0);
  await progress.phase('validate-inputs'); await progress.phase('validate-inputs');
  await progress.phase('copy-dependencies'); await progress.finish(false);
  assert.deepEqual(records, [
    { phase: 'validate-inputs', completedFiles: 0, completedBytes: 0, relativePath: null },
    { phase: 'copy-dependencies', completedFiles: 0, completedBytes: 0, relativePath: null },
  ]);
  await assert.rejects(progress.phase('caller supplied phase'), TypeError);
});

test('dependency observations require both 64 completions and one elapsed second', async () => {
  let now = 0; const records = [], progress = createPackageProgress(record => records.push(record), () => now);
  await progress.phase('copy-dependencies');
  for (let index = 0; index < 64; index++) await progress.copied(path(index), 2);
  assert.equal(records.length, 1);
  now = 1000; await progress.copied(path(64), 2); assert.equal(records.length, 2);
  assert.deepEqual(records[1], { phase: 'copy-dependencies', completedFiles: 65, completedBytes: 130, relativePath: path(64) });
  now = 5000;
  for (let index = 65; index < 128; index++) await progress.copied(path(index), 2);
  assert.equal(records.length, 2);
  await progress.copied(path(128), 2); assert.equal(records.length, 3);
  await progress.finish(false);
});

test('invalid diagnostic paths and byte counts never reach the callback', async () => {
  const records = [], progress = createPackageProgress(record => records.push(record), () => 0);
  await progress.phase('copy-dependencies');
  for (const invalid of ['/absolute', 'C:/absolute', '../escape', 'a/../escape', 'a\\source', '', 'x'.repeat(1025)]) {
    await assert.rejects(progress.copied(invalid, 1), TypeError);
  }
  for (const bytes of [-1, NaN, 512 * 1024 ** 2 + 1]) await assert.rejects(progress.copied(path(0), bytes), TypeError);
  assert.equal(records.length, 1); await progress.finish(false);
});

test('observations and their writes serialize and drain before the reported outcome', async () => {
  const gates = [deferred(), deferred()], starts = [], writes = [];
  let active = 0, peak = 0, returned = false;
  const progress = createPackageProgress(async record => {
    const index = starts.length; starts.push(record.phase); active++; peak = Math.max(peak, active);
    await gates[index].promise;
    assert.equal(returned, false); writes.push(record.phase); active--;
  });
  const first = progress.phase('validate-inputs'), second = progress.phase('resolve-dependencies');
  const final = progress.finish(false).then(() => { returned = true; });
  await flush(); assert.deepEqual(starts, ['validate-inputs']); assert.equal(returned, false);
  gates[0].resolve(); await flush(); assert.deepEqual(starts, ['validate-inputs', 'resolve-dependencies']); assert.equal(returned, false);
  gates[1].resolve(); await Promise.all([first, second, final]);
  assert.equal(peak, 1); assert.equal(active, 0); assert.deepEqual(writes, starts);
  await flush(); assert.deepEqual(writes, starts);
});

test('first progress failure disables later callbacks and preserves exact thrown values', async () => {
  for (const reason of [undefined, null, false, 0, 'write refused', Object.freeze(new Error('frozen')), Object.freeze({ reason: 'frozen' })]) {
    let calls = 0;
    const progress = createPackageProgress(() => { calls++; throw reason; });
    await progress.phase('validate-inputs'); await progress.phase('resolve-dependencies');
    const outcome = await capture(progress.finish(false));
    assert.equal(outcome.rejected, true); assert.equal(outcome.value, reason); assert.equal(calls, 1);
  }
});

test('original package failure wins over an earlier diagnostic failure unchanged', async () => {
  for (const original of [undefined, null, false, 0, 'package refused', Object.freeze(new Error('frozen package')), Object.freeze({ reason: 'frozen package' })]) {
    const progress = createPackageProgress(() => { throw new Error('diagnostic write refused'); });
    await progress.phase('validate-inputs');
    const outcome = await capture(progress.finish(true, original));
    assert.equal(outcome.rejected, true); assert.equal(outcome.value, original);
  }
});

test('a late diagnostic failure drains before the original package error returns', async () => {
  const gate = deferred(), original = Object.freeze(new Error('copy refused'));
  let returned = false;
  const progress = createPackageProgress(async () => { await gate.promise; assert.equal(returned, false); throw new Error('write refused'); });
  const observation = progress.phase('copy-dependencies');
  const final = capture(progress.finish(true, original)).then(value => { returned = true; return value; });
  await flush(); assert.equal(returned, false); gate.resolve();
  const outcome = await final; await observation;
  assert.equal(outcome.rejected, true); assert.equal(outcome.value, original);
});

test('progress is optional and callback type validation stays local to the trusted API', async () => {
  const progress = createPackageProgress();
  await progress.phase('validate-inputs'); await progress.phase('copy-dependencies');
  await progress.copied(path(0), 1); await progress.finish(false);
  for (const invalid of [null, true, {}, 'callback']) assert.throws(() => createPackageProgress(invalid), TypeError);
});
