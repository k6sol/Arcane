import test from 'node:test';
import assert from 'node:assert/strict';
import type { Json } from '../../packages/protocol/src/studio.js';
import { nativePropertiesMatch } from '../../packages/core/src/native-property-outcomes.js';
import { BASE_PART_CLASSES, MATERIALS, PART_SHAPE_CLASSES, SHAPES, canonical, engineProperties } from '../../packages/core/src/studio-policy.js';

const vector = (x: number, y: number, z: number): Json => ({ type: 'Vector3', value: [x, y, z] });
const color = (r: number, g: number, b: number): Json => ({ type: 'Color3', value: [r, g, b] });
const match = (requested: unknown, observed: unknown, className = 'Part') => nativePropertiesMatch(requested as Record<string, Json>, observed, className);

// Fixed native readback from the supplied 2026-10-14 engine regression.
// studio-colour-fix-acceptance-20261014.json records 357 probes / 0 mismatches.
const NATIVE_COLOR = color(0.14901961386203766, 0.4470588266849518, 0.800000011920929);

test('legal native RGB8 color readback is accepted for raw and float32 requests', () => {
  const requested = { Color: color(0.15, 0.45, 0.8) };
  assert.equal(match(requested, { Color: NATIVE_COLOR }), true);
  assert.equal(match(engineProperties(requested), { Color: NATIVE_COLOR }), true);
  assert.notEqual(canonical(engineProperties(requested)), canonical({ Color: NATIVE_COLOR }));
});

test('RGB8 requires truncation rather than nearest-byte rounding', () => {
  const requested = { Color: color(0.1, 0.5, 0.999) };
  const observed = { Color: color(0.09803921729326248, 0.49803921580314636, 0.9960784316062927) };
  assert.equal(match(requested, observed), true);
  assert.equal(match(requested, { Color: color(Math.fround(26 / 255), Math.fround(128 / 255), 1) }), false);
});

test('all 256 canonical RGB8 bytes survive float32 multiplication, including byte seven', () => {
  for (let byte = 0; byte <= 255; byte++) {
    const channel = Math.fround(byte / 255);
    const values = { Color: color(channel, channel, channel) };
    assert.equal(match(values, values), true, `byte ${byte}`);
  }
  const seven = 0.027450980618596077;
  const belowSeven = 7 / 255 - 1e-12;
  assert.equal(Math.trunc(belowSeven * 255), 6);
  assert.equal(match({ Color: color(seven, seven, seven) }, { Color: color(seven, seven, seven) }), true);
  assert.equal(match({ Color: color(belowSeven, belowSeven, belowSeven) }, { Color: color(seven, seven, seven) }), true);
});

test('one-byte-wrong color receipts are rejected on each channel', () => {
  const correct = [38, 114, 204];
  for (let index = 0; index < 3; index++) for (const delta of [-1, 1]) {
    const bytes = [...correct]; bytes[index]! += delta;
    assert.equal(match({ Color: color(0.15, 0.45, 0.8) }, {
      Color: color(Math.fround(bytes[0]! / 255), Math.fround(bytes[1]! / 255), Math.fround(bytes[2]! / 255)),
    }), false);
  }
});

test('unquantized and non-float32 color observations are rejected', () => {
  assert.equal(match({ Color: color(0.15, 0.45, 0.8) }, { Color: color(0.15, 0.45, 0.8) }), false);
  assert.equal(match({ Color: color(0.15, 0.45, 0.8) }, engineProperties({ Color: color(0.15, 0.45, 0.8) })), false);
  assert.equal(match({ Color: color(0.15, 0.45, 0.8) }, { Color: color(38 / 255, 114 / 255, 204 / 255) }), false);
});

test('full-turn Orientation wraps are legal native outcomes', () => {
  for (const requested of [[360, 0, 0], [0, -360, 0], [0, 0, 360], [-360, 360, -360]]) {
    assert.equal(match({ Orientation: vector(requested[0]!, requested[1]!, requested[2]!) }, { Orientation: vector(0, 0, 0) }), true);
  }
  assert.equal(match({ Orientation: vector(0, 270, 0) }, { Orientation: vector(0, -90, 0) }), true);
});

test('YXZ equivalent canonical Euler and both gimbal representations are accepted', () => {
  for (const [requested, observed] of [
    [[120, 25, -40], [60, -155, 140]],
    [[-120, 25, -40], [-60, -155, 140]],
    [[90, 40, 10], [90, 30, 0]],
    [[-90, 40, 10], [-90, 50, 0]],
    [[90, -170, 20], [90, 170, 0]],
  ]) {
    assert.equal(match({ Orientation: vector(requested![0]!, requested![1]!, requested![2]!) }, {
      Orientation: vector(observed![0]!, observed![1]!, observed![2]!),
    }), true, JSON.stringify({ requested, observed }));
  }
});

test('non-equivalent rotations, axis swaps and incorrect gimbal signs are rejected', () => {
  for (const [requested, observed] of [
    [[0, 0, 0], [0, 0, 1]],
    [[90, 40, 10], [90, 50, 0]],
    [[-90, 40, 10], [-90, 30, 0]],
    [[120, 25, -40], [60, 25, -40]],
    [[10, 20, 30], [30, 20, 10]],
    [[90, 90, 0], [0, 90, 90]],
  ]) {
    assert.equal(match({ Orientation: vector(requested![0]!, requested![1]!, requested![2]!) }, {
      Orientation: vector(observed![0]!, observed![1]!, observed![2]!),
    }), false, JSON.stringify({ requested, observed }));
  }
});

test('rotation tolerance applies to all matrix elements with a strict 1e-6 bound', () => {
  assert.equal(match({ Orientation: vector(0, 0, 0) }, { Orientation: vector(0, 0, Math.fround(0.00005)) }), true);
  const small = Math.fround(0.00005);
  assert.equal(match({ Orientation: vector(0, 0, 0) }, { Orientation: vector(small, small, small) }), true);
  assert.equal(match({ Orientation: vector(0, 0, 0) }, { Orientation: vector(0, 0, Math.fround(0.00006)) }), false);
  for (let index = 0; index < 3; index++) {
    const angles = [0, 0, 0]; angles[index] = Math.fround(0.001);
    assert.equal(match({ Orientation: vector(0, 0, 0) }, { Orientation: vector(angles[0]!, angles[1]!, angles[2]!) }), false);
  }
});

test('Orientation requires observed float32 values even for equivalent tiny differences', () => {
  assert.equal(match({ Orientation: vector(0, 0, 0) }, { Orientation: vector(0, 0, 0.00000001) }), false);
  const requested = { Orientation: vector(12.123456789, -45.123456789, 78.123456789) };
  assert.equal(match(requested, engineProperties(requested)), true);
  assert.equal(match(requested, requested), false);
});

test('other numeric properties match exactly the requested float32 engine values', () => {
  const requested = { Position: vector(0.1, -0.2, 123.456789), Size: vector(0.1, 0.3, 2048), Transparency: 0.3, Reflectance: 0.123456789 };
  assert.equal(match(requested, engineProperties(requested)), true);
  assert.equal(match(engineProperties(requested), engineProperties(requested)), true);
  assert.equal(match(requested, requested), false);
  for (const key of ['Transparency', 'Reflectance']) {
    assert.equal(match({ [key]: 0.3 }, { [key]: 0.3 }), false);
    assert.equal(match({ [key]: 0.3 }, { [key]: Math.fround(0.3) + 1e-12 }), false);
    assert.equal(match({ [key]: 1 }, { [key]: Math.fround(1 - 2 ** -24) }), false);
  }
});

test('positions and sizes have no fuzzy numeric tolerance', () => {
  for (const key of ['Size', 'Position']) for (let index = 0; index < 3; index++) {
    const components = [1, 1, 1]; components[index] = Math.fround(1 + 2 ** -23);
    assert.equal(match({ [key]: vector(1, 1, 1) }, { [key]: vector(components[0]!, components[1]!, components[2]!) }), false);
  }
});

test('exact names, material names, shape names and false booleans are preserved', () => {
  const requested = { Name: 'Exact Part', Material: 'SmoothPlastic', Shape: 'Cylinder', Anchored: false, CanCollide: false, CastShadow: true };
  assert.equal(match(requested, { ...requested }), true);
  for (const observed of [
    { ...requested, Name: 'exact Part' }, { ...requested, Name: 'Exact Part ' },
    { ...requested, Material: 'Plastic' }, { ...requested, Material: 'Enum.Material.SmoothPlastic' },
    { ...requested, Shape: 'Ball' }, { ...requested, Anchored: true }, { ...requested, CastShadow: false },
  ]) assert.equal(match(requested, observed), false);
  for (const Material of MATERIALS) assert.equal(match({ Material }, { Material }), true);
  for (const Shape of SHAPES) assert.equal(match({ Shape }, { Shape }), true);
});

test('physical outcomes use the existing class allowlists', () => {
  for (const className of BASE_PART_CLASSES) {
    assert.equal(match({ Color: color(0.15, 0.45, 0.8), Orientation: vector(0, 360, 0) }, {
      Color: NATIVE_COLOR, Orientation: vector(0, 0, 0),
    }, className), true);
    assert.equal(match({ Shape: 'Cylinder' }, { Shape: 'Cylinder' }, className),
      (PART_SHAPE_CLASSES as readonly string[]).includes(className));
  }
  for (const className of ['Folder', 'Model', 'Script', 'Workspace', 'Terrain', 'part', 'BasePart']) {
    assert.equal(match({ Position: vector(0, 0, 0) }, { Position: vector(0, 0, 0) }, className), false);
  }
  for (const className of ['Folder', 'Model', 'Script', 'LocalScript', 'ModuleScript']) {
    assert.equal(match({ Name: 'Renamed' }, { Name: 'Renamed' }, className), true);
    assert.equal(match({}, {}, className), true);
  }
});

test('complete twelve-property outcomes require the exact property key set, independent of order', () => {
  const requested = {
    Name: 'Outcome', Size: vector(1, 2, 3), Position: vector(4, 5, 6), Orientation: vector(0, 360, 0), Color: color(0.15, 0.45, 0.8),
    Anchored: true, CanCollide: false, CastShadow: false, Transparency: 0.3, Reflectance: 0.2, Material: 'Plastic', Shape: 'Ball',
  };
  const observed: Record<string, Json> = { ...engineProperties(requested), Orientation: vector(0, 0, 0), Color: NATIVE_COLOR };
  assert.equal(Object.keys(requested).length, 12);
  assert.equal(match(requested, Object.fromEntries(Object.entries(observed).reverse())), true);
  for (const key of Object.keys(requested)) {
    const missing = { ...observed }; delete missing[key];
    assert.equal(match(requested, missing), false, key);
  }
  assert.equal(match({ Anchored: true }, { Anchored: true, CastShadow: false }), false);
  assert.equal(match({ Anchored: true }, { CanCollide: true }), false);
  assert.equal(match(requested, { ...observed, extra: true }), false);
  assert.equal(match({}, { Name: 'Unexpected' }), false);
});

test('unsupported fields and thirteen-property records fail even when identical', () => {
  for (const key of ['Disabled', 'Source', 'Parent', 'CFrame', 'Enabled', 'Neutral', 'extra']) {
    assert.equal(match({ [key]: false }, { [key]: false }), false);
  }
  const tooMany = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`field${index}`, 0]));
  assert.equal(match(tooMany, tooMany), false);
});

test('non-object, array, boxed and truthy property records are rejected on both sides', () => {
  for (const value of [null, undefined, true, false, 1, 0, 'properties', [], new Map(), new Date(), new Boolean(true), () => ({})]) {
    assert.equal(match({}, value), false);
    assert.equal(match(value, {}), false);
  }
  assert.equal(match({}, {}, true as unknown as string), false);
});

test('boolean values reject truthy and falsy substitutes', () => {
  for (const key of ['Anchored', 'CanCollide', 'CastShadow']) for (const invalid of [0, 1, '', 'true', 'false', null, undefined, [], {}, new Boolean(true)]) {
    assert.equal(match({ [key]: true }, { [key]: invalid }), false);
    assert.equal(match({ [key]: invalid }, { [key]: invalid }), false);
  }
});

test('names and enums reject invalid types, lengths, NUL and unsupported strings', () => {
  for (const Name of ['', 'x'.repeat(101), 'a\0b', null, 1, true, {}, new String('Part')]) {
    assert.equal(match({ Name }, { Name }), false);
  }
  const Name = 'x'.repeat(100);
  assert.equal(match({ Name }, { Name }), true);
  for (const key of ['Material', 'Shape']) for (const invalid of [null, 0, false, {}, [], 'Water', 'Enum.Material.Plastic']) {
    assert.equal(match({ [key]: invalid }, { [key]: invalid }), false);
  }
});

test('non-finite, non-number and out-of-bound scalar values are rejected on both sides', () => {
  for (const key of ['Transparency', 'Reflectance']) for (const invalid of [NaN, Infinity, -Infinity, -0.001, 1.001, '0.3', null, true, {}, new Number(0.3)]) {
    assert.equal(match({ [key]: 0.3 }, { [key]: invalid }), false);
    assert.equal(match({ [key]: invalid }, { [key]: invalid }), false);
  }
  for (const key of ['Transparency', 'Reflectance']) for (const value of [0, 1]) assert.equal(match({ [key]: value }, { [key]: value }), true);
});

test('each tagged vector/color component is strictly typed, finite and bounded', () => {
  for (const [key, tag, valid, invalids] of [
    ['Color', 'Color3', 0.5, [-0.001, 1.001]],
    ['Size', 'Vector3', 1, [0.049, 2048.001]],
    ['Position', 'Vector3', 0, [-100001, 100001]],
    ['Orientation', 'Vector3', 0, [-361, 361]],
  ] as const) for (let index = 0; index < 3; index++) {
    for (const invalid of [...invalids, NaN, Infinity, -Infinity, '0', null, true, {}, new Number(0)]) {
      const components: unknown[] = [valid, valid, valid]; components[index] = invalid;
      const malformed = { [key]: { type: tag, value: components } };
      assert.equal(match(malformed, malformed), false, `${key}[${index}]`);
      assert.equal(match({ [key]: { type: tag, value: [valid, valid, valid] } }, malformed), false);
    }
  }
});

test('tagged values reject incorrect tags, missing fields and extra fields', () => {
  for (const key of ['Color', 'Size', 'Position', 'Orientation']) {
    const tag = key === 'Color' ? 'Color3' : 'Vector3';
    for (const malformed of [
      null, 1, 'Vector3', [], { type: tag }, { value: [1, 1, 1] },
      { type: tag, value: [1, 1, 1], extra: false },
      { type: key === 'Color' ? 'Vector3' : 'Color3', value: [1, 1, 1] },
      { type: tag, value: [1, 1] }, { type: tag, value: [1, 1, 1, 1] },
      { type: tag, value: { 0: 1, 1: 1, 2: 1, length: 3 } },
    ]) {
      assert.equal(match({ [key]: malformed }, { [key]: malformed }), false);
      assert.equal(match({ [key]: { type: tag, value: [1, 1, 1] } }, { [key]: malformed }), false);
    }
  }
});

test('tagged triples reject holes, array subclasses and all extra own fields', () => {
  class Components extends Array<number> {}
  const sparse = [1, , 1];
  const extra = Object.assign([1, 1, 1], { extra: true });
  const symbol = Object.assign([1, 1, 1], { [Symbol('extra')]: true });
  const hidden = Object.defineProperty([1, 1, 1], 'extra', { value: false });
  const inherited = Object.setPrototypeOf([1, 1, 1], Object.create(Array.prototype));
  for (const components of [sparse, extra, symbol, hidden, inherited, new Components(1, 1, 1)]) {
    const malformed = { Position: { type: 'Vector3', value: components } };
    assert.equal(match(malformed, malformed), false);
    assert.equal(match({ Position: vector(1, 1, 1) }, malformed), false);
  }
});

test('custom prototypes and reserved keys are rejected at property and tagged levels', () => {
  for (const properties of [Object.create({ Anchored: true }), Object.assign(Object.create({ extra: true }), { Anchored: true })]) {
    assert.equal(match(properties, properties), false);
    assert.equal(match({ Anchored: true }, properties), false);
  }
  const inheritedTag = Object.assign(Object.create({ extra: true }), { type: 'Vector3', value: [1, 1, 1] });
  assert.equal(match({ Position: inheritedTag }, { Position: inheritedTag }), false);
  for (const reserved of ['__proto__', 'prototype', 'constructor']) {
    const properties = Object.defineProperty({ Anchored: true }, reserved, { value: false, enumerable: true });
    assert.equal(match(properties, properties), false);
    const tagged = Object.defineProperty({ type: 'Vector3', value: [1, 1, 1] }, reserved, { value: false, enumerable: true });
    assert.equal(match({ Position: vector(1, 1, 1) }, { Position: tagged }), false);
  }
});

test('nonenumerable and symbol fields are rejected rather than silently omitted', () => {
  for (const properties of [
    Object.defineProperty({}, 'Anchored', { value: true }),
    Object.defineProperty({ Anchored: true }, 'extra', { value: false }),
    Object.assign({ Anchored: true }, { [Symbol('extra')]: false }),
  ]) {
    assert.equal(match(properties, properties), false);
    assert.equal(match({ Anchored: true }, properties), false);
  }
  const tagged = Object.defineProperty({ type: 'Vector3', value: [1, 1, 1] }, 'extra', { value: false });
  assert.equal(match({ Position: vector(1, 1, 1) }, { Position: tagged }), false);
});

test('accessors and toJSON are refused without executing user code', () => {
  let calls = 0;
  const getter = () => { calls++; throw new Error('must not run'); };
  const top = Object.defineProperty({}, 'Anchored', { get: getter, enumerable: true });
  const tag = Object.defineProperty({ value: [1, 1, 1] }, 'type', { get: getter, enumerable: true });
  const value = Object.defineProperty({ type: 'Vector3' }, 'value', { get: getter, enumerable: true });
  const components = Object.defineProperty([1, 1, 1], '1', { get: getter, enumerable: true });
  const serialization = { Anchored: true, toJSON: getter };
  for (const properties of [top, { Position: tag }, { Position: value }, { Position: { type: 'Vector3', value: components } }, serialization]) {
    assert.equal(match(properties, properties), false);
    assert.equal(match({}, properties), false);
  }
  assert.equal(calls, 0);
});

test('proxies, including revoked and nested proxies, fail without running traps', () => {
  let calls = 0;
  const proxy = new Proxy({ Anchored: true }, { getPrototypeOf() { calls++; throw new Error('must not run'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const tagged = new Proxy({ type: 'Vector3', value: [1, 1, 1] }, { ownKeys() { calls++; throw new Error('must not run'); } });
  const components = new Proxy([1, 1, 1], { get() { calls++; throw new Error('must not run'); } });
  for (const properties of [proxy, revoked.proxy, { Position: tagged }, { Position: { type: 'Vector3', value: components } }]) {
    assert.equal(match(properties, properties), false);
    assert.equal(match({}, properties), false);
  }
  assert.equal(calls, 0);
});

test('ordinary frozen and null-prototype JSON records work without mutation', () => {
  const requested = Object.freeze({ Position: Object.freeze({ type: 'Vector3', value: Object.freeze([1, 2, 3]) }) });
  const observed = Object.freeze({ Position: Object.freeze({ type: 'Vector3', value: Object.freeze([1, 2, 3]) }) });
  assert.equal(match(requested, observed), true);
  const nullPrototype = Object.assign(Object.create(null), { Anchored: false, Name: 'Exact' });
  assert.equal(match(nullPrototype, nullPrototype), true);
  assert.deepEqual(requested, observed);
  assert.equal(Object.isFrozen(requested.Position.value), true);
});

test('legal bounds are accepted after the exact native conversions', () => {
  const requested = { Size: vector(0.05, 2048, 1), Position: vector(-100000, 100000, 0), Color: color(0, 1, 0), Orientation: vector(-360, 360, -360) };
  assert.equal(match(requested, { ...engineProperties(requested), Orientation: vector(0, 0, 0) }), true);
});

test('postconditions do not change strict canonical expected-baseline comparisons', () => {
  const requested = { Orientation: vector(360, 0, 0), Color: color(0.15, 0.45, 0.8) };
  const observed = { Orientation: vector(0, 0, 0), Color: NATIVE_COLOR };
  assert.equal(match(requested, observed), true);
  assert.equal(canonical(engineProperties(requested)) === canonical(observed), false);
});
