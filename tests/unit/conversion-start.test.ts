import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConvertGlbInput } from '../../apps/daemon/src/conversion-start.js';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';

const valid = () => ({ parentJobId: '11111111-1111-4111-8111-111111111111', name: 'forest-oak',
  collision: 'none', renderResolution: 384, renderSamples: 16 });
function refused(value: unknown): void {
  assert.throws(() => parseConvertGlbInput(value), error => error instanceof AssetError && error.code === 'ASSET_CONVERT_INPUT');
}

test('conversion options detach and freeze exactly the supplied scalar settings', () => {
  const input = valid(), parsed = parseConvertGlbInput(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  input.name = 'changed'; input.renderSamples = 64;
  assert.equal(parsed.name, 'forest-oak'); assert.equal(parsed.renderSamples, 16);
  assert.throws(() => { (parsed as { name: string }).name = 'changed'; }, TypeError);
  assert.deepEqual(parseConvertGlbInput(Object.assign(Object.create(null), valid())), valid());
});

test('conversion accepts both collision modes and the exact inclusive preview limits', () => {
  for (const collision of ['none', 'convex-hull']) for (const renderResolution of [128, 1024]) for (const renderSamples of [1, 64]) {
    const value = { ...valid(), collision, renderResolution, renderSamples, name: 'a'.repeat(48) };
    assert.deepEqual(parseConvertGlbInput(value), value);
  }
});

test('conversion requires all five fields and refuses authority, paths, bytes and wait options', () => {
  for (const key of Object.keys(valid())) {
    const input: Record<string, unknown> = valid(); delete input[key]; refused(input);
  }
  for (const key of ['path', 'sourceGlb', 'sourceSha256', 'parentManifestSha256', 'actor', 'scope', 'signal', 'permission', 'policy', 'executable', 'wait', 'template', 'jobId']) {
    refused({ ...valid(), [key]: 'caller-supplied' });
  }
});

test('conversion refuses non-data containers and proxy traps without executing them', () => {
  for (const value of [null, undefined, false, 1, 'options', [], Buffer.alloc(1), new Date(), new (class Options {})()]) refused(value);
  let traps = 0;
  const proxy = new Proxy(valid(), {
    get() { traps++; throw new Error('get'); }, ownKeys() { traps++; throw new Error('keys'); },
    getPrototypeOf() { traps++; throw new Error('prototype'); }, getOwnPropertyDescriptor() { traps++; throw new Error('descriptor'); },
  });
  refused(proxy); assert.equal(traps, 0);
});

test('conversion never invokes getters or accepts hidden, symbolic or inherited fields', () => {
  let calls = 0;
  for (const key of Object.keys(valid())) {
    const input = valid();
    Object.defineProperty(input, key, { enumerable: true, get() { calls++; throw new Error('getter'); } });
    refused(input);
    const hidden = valid(); Object.defineProperty(hidden, key, { enumerable: false }); refused(hidden);
  }
  refused({ ...valid(), [Symbol('scope')]: true });
  refused(Object.create(valid()));
  refused(Object.assign(Object.create({ scope: 'inherited' }), valid()));
  assert.equal(calls, 0);
});

test('conversion refuses unsafe names and noncanonical parent identities', () => {
  for (const name of ['', 'Tree', 'a\n', ' tree', 'tree ', 'a/b', '../tree', 'a'.repeat(49), 'nul', 'con-tree', 'lpt1']) refused({ ...valid(), name });
  for (const parentJobId of ['', '11111111-1111-4111-8111-111111111111\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '../parent', null, 1]) refused({ ...valid(), parentJobId });
  for (const collision of ['', 'hull', 'None', null, 1]) refused({ ...valid(), collision });
});

test('conversion refuses numeric coercion, fractions, nonfinite and out-of-range previews', () => {
  let coercions = 0;
  const objectNumber = { valueOf() { coercions++; return 384; } };
  for (const renderResolution of [127, 1025, 128.5, NaN, Infinity, -Infinity, '384', null, objectNumber]) refused({ ...valid(), renderResolution });
  for (const renderSamples of [0, 65, 1.5, NaN, Infinity, '16', null, objectNumber]) refused({ ...valid(), renderSamples });
  assert.equal(coercions, 0);
});

test('conversion refusal contains a fixed explanation without submitted content', () => {
  const sensitive = 'private-content-not-for-diagnostics';
  assert.throws(() => parseConvertGlbInput({ ...valid(), path: sensitive }), error => {
    assert.ok(error instanceof AssetError);
    assert.equal(error.code, 'ASSET_CONVERT_INPUT');
    assert.equal(error.message.includes(sensitive), false);
    return true;
  });
});
