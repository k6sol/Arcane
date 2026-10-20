import test from 'node:test';
import assert from 'node:assert/strict';
import { copyInBatches, COPY_BATCH_FILES, COPY_BATCH_BYTES } from '../../scripts/bounded-copy.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const descriptors = sizes => sizes.map((bytes, id) => ({ id, bytes }));
const capture = async promise => { try { return { rejected: false, value: await promise }; } catch (value) { return { rejected: true, value }; } };

test('empty input performs no work', async () => {
  assert.deepEqual(await copyInBatches([], () => assert.fail('no work expected')), { completed: 0, batches: 0 });
});

test('descriptor count and size bounds reject before admission', async () => {
  let starts = 0;
  for (const input of [Array(32769).fill({ bytes: 0 }), [{ bytes: -1 }], [{ bytes: 512 * 1024 ** 2 + 1 }], [{ bytes: NaN }], [null]]) {
    await assert.rejects(copyInBatches(input, () => starts++), TypeError);
  }
  assert.equal(starts, 0);
});

test('four active copies finish out of order and a batch drains before the next starts', async () => {
  const gates = Array.from({ length: 9 }, deferred), starts = [], finishes = [];
  let active = 0, peak = 0;
  const result = copyInBatches(descriptors(Array(9).fill(1)), async ({ id }) => {
    starts.push(id); active++; peak = Math.max(peak, active);
    try { await gates[id].promise; finishes.push(id); } finally { active--; }
  });
  assert.deepEqual(starts, [0, 1, 2, 3]);
  gates[3].resolve(); gates[1].resolve(); await flush();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  gates[0].resolve(); gates[2].resolve(); await flush();
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const id of [7, 6, 5, 4]) gates[id].resolve();
  await flush(); assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  gates[8].resolve();
  assert.deepEqual(await result, { completed: 9, batches: 3 });
  assert.equal(peak, COPY_BATCH_FILES); assert.equal(active, 0);
  assert.deepEqual([...finishes].sort((a, b) => a - b), starts);
});

test('expected byte batches never combine an oversize file with another input', async () => {
  const unit = 1024 ** 2, sizes = [10 * unit, 6 * unit, 1, 20 * unit, 3 * unit];
  const gates = sizes.map(deferred), starts = [], active = new Set();
  const result = copyInBatches(descriptors(sizes), async ({ id, bytes }) => {
    active.add(id); starts.push(id);
    const sum = [...active].reduce((total, index) => total + sizes[index], 0);
    assert.ok(sum <= COPY_BATCH_BYTES || active.size === 1 && bytes > COPY_BATCH_BYTES);
    try { await gates[id].promise; } finally { active.delete(id); }
  });
  assert.deepEqual(starts, [0, 1]);
  gates[0].resolve(); gates[1].resolve(); await flush();
  assert.deepEqual(starts, [0, 1, 2]);
  gates[2].resolve(); await flush(); assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.deepEqual([...active], [3]);
  gates[3].resolve(); await flush(); assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  gates[4].resolve();
  assert.deepEqual(await result, { completed: 5, batches: 4 });
});

test('synchronous primitive failure closes admission and preserves the thrown value', async () => {
  for (const reason of [undefined, null, false, 0, 'copy refused']) {
    const starts = [];
    const outcome = await capture(copyInBatches(descriptors([1, 1, 1, 1, 1]), ({ id }) => { starts.push(id); throw reason; }));
    assert.equal(outcome.rejected, true); assert.equal(outcome.value, reason); assert.deepEqual(starts, [0]);
  }
});

test('first asynchronous frozen error is preserved while all admitted work drains', async () => {
  const first = Object.freeze(new Error('first copy refused')), later = Object.freeze(new Error('draining copy refused'));
  const gates = Array.from({ length: 6 }, deferred), starts = [], writes = [];
  let returned = false;
  const result = capture(copyInBatches(descriptors(Array(6).fill(1)), async ({ id }) => {
    starts.push(id); await gates[id].promise;
    assert.equal(returned, false, 'no write may outlive the reported outcome'); writes.push(id);
  })).then(value => { returned = true; return value; });
  assert.deepEqual(starts, [0, 1, 2, 3]);
  gates[1].reject(first); await flush(); assert.equal(returned, false);
  assert.deepEqual(starts, [0, 1, 2, 3]);
  gates[2].reject(later); gates[0].resolve(); await flush(); assert.equal(returned, false);
  gates[3].resolve();
  const outcome = await result;
  assert.equal(outcome.rejected, true); assert.equal(outcome.value, first);
  assert.deepEqual(writes, [0, 3]); await flush(); assert.deepEqual(writes, [0, 3]);
  assert.deepEqual(starts, [0, 1, 2, 3]);
});

test('synchronous failure during admission drains the earlier active callback', async () => {
  const gate = deferred(), first = Object.freeze({ message: 'refused' }), starts = [];
  let writeFinished = false, returned = false;
  const result = capture(copyInBatches(descriptors([1, 1, 1, 1]), ({ id }) => {
    starts.push(id);
    if (id === 1) throw first;
    return gate.promise.then(() => { assert.equal(returned, false); writeFinished = true; });
  })).then(value => { returned = true; return value; });
  assert.deepEqual(starts, [0, 1]); await flush(); assert.equal(returned, false);
  gate.resolve(); const outcome = await result;
  assert.equal(writeFinished, true); assert.equal(outcome.value, first); assert.equal(outcome.rejected, true);
  assert.deepEqual(starts, [0, 1]);
});

test('failure in a later batch prevents all following admissions', async () => {
  const starts = [], reason = Symbol('later refusal');
  const outcome = await capture(copyInBatches(descriptors(Array(12).fill(1)), ({ id }) => {
    starts.push(id); if (id === 4) throw reason;
  }));
  assert.equal(outcome.rejected, true); assert.equal(outcome.value, reason);
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
});
