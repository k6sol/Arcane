import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BASE_PART_CLASSES, CREATE_CLASSES, GEOMETRY_CREATE_CLASSES, SAFE_CREATE_CLASSES, PART_SHAPE_CLASSES, SHAPES, MATERIALS, canonical, engineProperties, validateCommandArgs, validateProperties } from '../../packages/core/src/studio-policy.js';
import { createClass, properties as propertySchema } from '../../apps/mcp/src/schemas.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { READ_METHODS, WRITE_METHODS, type InstanceRef, type StudioSession } from '../../packages/protocol/src/studio.js';

const vector = (x: number, y: number, z: number) => ({ type: 'Vector3', value: [x, y, z] });
const session: StudioSession = {
  id: 'geometry-session', protocolVersion: 1, clientSessionId: 'geometry-client', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.1.0',
  allowedRoots: ['Workspace'], allowWrites: true, capabilities: [...READ_METHODS, ...WRITE_METHODS], connectedAt: '', lastSeenAt: '', revokedAt: null,
};
const reference = (className: string, root = false): InstanceRef => ({ instanceId: 'opaque-' + className, sessionId: session.id, root: 'Workspace', pathSegments: root ? [] : [className], className });
const physical = { Size: vector(1, 24, 24), Position: vector(0, 1, 0), Orientation: vector(0, 0, 90), Color: { type: 'Color3', value: [0.2, 0.3, 0.4] }, Anchored: true, CanCollide: true, CastShadow: false, Transparency: 0, Reflectance: 0.25, Material: 'SmoothPlastic' };

test('legacy six creation classes remain stable; effective MCP/policy/plugin allowlists align', () => {
  assert.deepEqual(CREATE_CLASSES, ['Folder', 'Model', 'Part', 'Script', 'LocalScript', 'ModuleScript']);
  assert.deepEqual(GEOMETRY_CREATE_CLASSES, ['WedgePart', 'CornerWedgePart', 'SpawnLocation']);
  assert.deepEqual(createClass.options, SAFE_CREATE_CLASSES);
  const plugin = readFileSync(resolve('plugin/src/Validation.luau'), 'utf8');
  const list = (name: string) => [...plugin.match(new RegExp(`Validation\\.${name} = table\\.freeze\\(\\{([^}]+)\\}\\)`))![1]!.matchAll(/"([^\"]+)"/g)].map(match => match[1]);
  assert.deepEqual(list('CREATE_CLASSES'), SAFE_CREATE_CLASSES);
  assert.deepEqual(list('BASE_PART_CLASSES'), BASE_PART_CLASSES);
  assert.deepEqual(list('PART_SHAPE_CLASSES'), PART_SHAPE_CLASSES);
  assert.deepEqual(list('SHAPES'), SHAPES);
});

test('script content search enforces literal UTF-8 limits, exact roots/refs and a read-only capability', () => {
  const readOnly = { ...session, allowWrites: false };
  for (const query of ['literal .* [x]', ' ', '🧩'.repeat(64), 'é']) {
    const args = { root: 'Workspace', query, ref: reference('Folder'), limit: 100, caseSensitive: false };
    assert.deepEqual(validateCommandArgs('script.search', args, readOnly), args);
  }
  for (const patch of [{ query: '' }, { query: 'x\n' }, { query: 'x\r' }, { query: '\0' }, { query: '\u007f' }, { query: '\ud800' }, { query: '\udc00' }, { query: '🧩'.repeat(65) }, { limit: 101 }, { limit: 0 }, { limit: 1.5 }, { caseSensitive: 1 }, { regex: true }, { source: 'return 1' }, { ref: false }, { ref: null }]) {
    assert.throws(() => validateCommandArgs('script.search', { root: 'Workspace', query: 'literal', ...patch }, readOnly), { code: 'INPUT' });
  }
  assert.throws(() => validateCommandArgs('script.search', { root: 'ServerStorage', query: 'x' }, readOnly));
  assert.throws(() => validateCommandArgs('script.search', { root: 'Workspace', query: 'x', ref: { ...reference('Folder'), sessionId: 'other' } }, readOnly), { code: 'SCOPE' });
  assert.throws(() => validateCommandArgs('script.search', { root: 'Workspace', query: 'x' }, { ...readOnly, capabilities: readOnly.capabilities.filter(m => m !== 'script.search') }), { code: 'CAPABILITY' });
});

test('output reading is a closed read-only method with bounded levels, literal query, cursor and limit', () => {
  const readOnly = { ...session, allowWrites: false };
  for (const args of [{}, { levels: ['error', 'warning'], query: 'attempt to index nil', after: 0, limit: 100 }, { levels: ['output', 'info', 'warning', 'error'], after: 2_147_483_647 }, { query: '🧩'.repeat(25) }]) {
    assert.deepEqual(validateCommandArgs('output.read', args, readOnly), args);
  }
  for (const patch of [{ levels: [] }, { levels: ['error', 'error'] }, { levels: ['debug'] }, { levels: 'error' }, { query: '' }, { query: 'x\n' }, { query: '\ud800' }, { query: 'x'.repeat(101) },
    { after: -1 }, { after: 1.5 }, { after: 2_147_483_648 }, { limit: 0 }, { limit: 101 }, { root: 'Workspace' }, { source: 'print(1)' }]) {
    assert.throws(() => validateCommandArgs('output.read', patch, readOnly), { code: 'INPUT' }, JSON.stringify(patch));
  }
  assert.throws(() => validateCommandArgs('output.read', {}, { ...readOnly, capabilities: readOnly.capabilities.filter(m => m !== 'output.read') }), { code: 'CAPABILITY' });
});

test('scene search filters by one class name only when the plugin advertises class search', () => {
  const capable = { ...session, allowWrites: false, capabilities: [...session.capabilities, 'scene.search.class'] };
  for (const args of [{ root: 'Workspace', className: 'BasePart' }, { root: 'Workspace', className: 'PointLight', query: 'lamp', limit: 200 }, { root: 'Workspace', query: 'Door' }]) {
    assert.deepEqual(validateCommandArgs('scene.search', args, capable), args);
  }
  for (const patch of [{ className: 'basePart' }, { className: 'Base.Part' }, { className: 'A'.repeat(65) }, { className: 7 }, { className: 'Part', query: '' }])
    assert.throws(() => validateCommandArgs('scene.search', { root: 'Workspace', ...patch }, capable), { code: 'INPUT' }, JSON.stringify(patch));
  assert.throws(() => validateCommandArgs('scene.search', { root: 'Workspace' }, capable), { code: 'INPUT' });
  assert.throws(() => validateCommandArgs('scene.search', { root: 'Workspace', className: 'Script' }, { ...capable, capabilities: session.capabilities }), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.deepEqual(validateCommandArgs('scene.search', { root: 'Workspace', query: 'Door' }, session), { root: 'Workspace', query: 'Door' }, 'name-only search stays available on older plugins');
});

test('all physical property fields including full twelve-property update fit the bounded schema/policy', () => {
  const full = { ...physical, Shape: 'Cylinder', Name: 'CircularSpawn' };
  assert.equal(Object.keys(full).length, 12);
  assert.deepEqual(propertySchema.parse(full), full);
  assert.deepEqual(validateProperties(full, 'Part', true), full);
  assert.throws(() => validateProperties(full, 'Part', false), /not writable/);
});

for (const className of SAFE_CREATE_CLASSES) test(`${className} creation preserves class-specific safe properties`, () => {
  const isPhysical = (BASE_PART_CLASSES as readonly string[]).includes(className);
  const values = isPhysical ? { ...physical, ...((PART_SHAPE_CLASSES as readonly string[]).includes(className) ? { Shape: 'Cylinder' } : {}) } : {};
  assert.equal(createClass.parse(className), className);
  const result = validateCommandArgs('scene.create', { parent: reference('Workspace', true), className, name: className, properties: values }, session);
  assert.deepEqual(result.properties, engineProperties(validateProperties(values, className, false)));
  if (!isPhysical) assert.throws(() => validateProperties({ Orientation: vector(0, 0, 0) }, className, false), /not writable/);
});

test('Orientation, CastShadow and Reflectance are allowed across every concrete non-service BasePart', () => {
  for (const className of BASE_PART_CLASSES) {
    const result = validateCommandArgs('scene.update', { ref: reference(className), expected: { Orientation: vector(0, 0, 0), CastShadow: true, Reflectance: 0 }, properties: { Orientation: vector(-360, 90, 360), CastShadow: false, Reflectance: 1 } }, session);
    assert.deepEqual(result.properties, { Orientation: vector(-360, 90, 360), CastShadow: false, Reflectance: 1 });
  }
});

test('Shape only applies to reflected Part subclasses and bounded strings', () => {
  for (const className of PART_SHAPE_CLASSES) for (const Shape of SHAPES) assert.deepEqual(validateProperties({ Shape }, className, false), { Shape });
  for (const className of [...BASE_PART_CLASSES.filter(name => !(PART_SHAPE_CLASSES as readonly string[]).includes(name)), 'Folder', 'Model', 'Workspace', 'Terrain']) {
    assert.throws(() => validateProperties({ Shape: 'Cylinder' }, className, false), /Shape requires|not writable/);
  }
});

test('MCP and store policy reject identical invalid property values and unknown fields', () => {
  for (const values of [
    { Shape: 'Wedge' }, { Shape: 'Enum.PartType.Cylinder' }, { Shape: null }, { Shape: { Name: 'Cylinder' } },
    { Orientation: vector(361, 0, 0) }, { Orientation: vector(0, -361, 0) }, { Orientation: vector(Infinity, 0, 0) }, { Orientation: vector(NaN, 0, 0) },
    { Orientation: { type: 'Color3', value: [0, 0, 0] } }, { Orientation: { type: 'Vector3', value: [0, 0] } }, { Orientation: { type: 'Vector3', value: [0, 0, 0], extra: true } },
    { CastShadow: 0 }, { CastShadow: null }, { Reflectance: -0.01 }, { Reflectance: 1.01 }, { Reflectance: Infinity }, { Reflectance: NaN },
    { Material: 'Water' }, { Material: null }, { Source: 'print(1)' }, { Parent: 'Workspace' }, { Disabled: false }, { CFrame: {} }, { Enabled: true }, { Neutral: true },
  ]) {
    assert.equal(propertySchema.safeParse(values).success, false);
    assert.throws(() => validateProperties(values, 'Part', true));
  }
  for (const Shape of SHAPES) assert.equal(propertySchema.safeParse({ Shape }).success, true);
  for (const Material of MATERIALS) assert.equal(propertySchema.safeParse({ Material }).success, true);
});

test('new properties preserve float32 engine representations and false values', () => {
  const value = validateProperties({ Orientation: vector(12.123456789, -45.123456789, 0), Reflectance: 0.123456789, CastShadow: false, Shape: 'Cylinder' }, 'Part', false);
  assert.deepEqual(engineProperties(value), { Orientation: vector(Math.fround(12.123456789), Math.fround(-45.123456789), 0), Reflectance: Math.fround(0.123456789), CastShadow: false, Shape: 'Cylinder' });
});

test('every added property requires exact same-key expected baseline, validated before enqueue', () => {
  const ref = reference('Part');
  const proposed = { Shape: 'Cylinder', Orientation: vector(0, 0, 90), CastShadow: false, Reflectance: 0.25 };
  const expected = { Shape: 'Block', Orientation: vector(0, 0, 0), CastShadow: true, Reflectance: 0 };
  assert.deepEqual(validateCommandArgs('scene.update', { ref, expected, properties: proposed }, session).properties, proposed);
  for (const name of Object.keys(expected)) {
    const missing = { ...expected } as Record<string, unknown>; delete missing[name];
    assert.throws(() => validateCommandArgs('scene.update', { ref, expected: missing, properties: proposed }, session), /every changed/);
  }
  assert.throws(() => validateCommandArgs('scene.update', { ref, expected: { ...expected, Name: 'Part' }, properties: proposed }, session), /every changed/);
  assert.throws(() => validateCommandArgs('scene.update', { ref, expected: { ...expected, Shape: null }, properties: proposed }, session), /Shape requires/);
});

test('root references are readable and creatable parents but cannot rename or mutate services', () => {
  const parent = reference('Workspace', true);
  assert.deepEqual(validateCommandArgs('scene.children', { root: 'Workspace', ref: parent }, session).ref, parent);
  assert.deepEqual(validateCommandArgs('scene.create', { parent, className: 'Part', name: 'CircularSpawn', properties: { Shape: 'Cylinder' } }, session).parent, parent);
  for (const values of [{ Name: 'Changed' }, { Orientation: vector(0, 0, 0) }, { CastShadow: false }, { Reflectance: 0 }]) {
    assert.throws(() => validateCommandArgs('scene.update', { ref: parent, expected: values, properties: values }, session), /not writable/);
  }
  assert.throws(() => validateCommandArgs('scene.children', { root: 'Workspace', ref: { ...parent, sessionId: 'other' } }, session), /scope/);
  assert.throws(() => validateCommandArgs('scene.create', { parent: { ...parent, root: 'ServerStorage' }, className: 'Part', name: 'Wrong' }, session), /scope/);
});

function storeFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-geometry-policy-'));
  const store = new StudioStore({ directory });
  t.after(() => { store.close(); assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'), true); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'geometry-store', placeId: 0, universeId: 0, name: 'Geometry fixture', pluginVersion: '0.1.0' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  return { store, pair, ref: { ...reference('Part'), sessionId: pair.sessionId } };
}

test('shared store validates typed geometry receipts and builds immutable exact restoration', t => {
  const { store, pair, ref } = storeFixture(t);
  const before = { Shape: 'Block', Orientation: vector(0, 0, 0), CastShadow: true, Reflectance: 0 };
  const after = { Shape: 'Cylinder', Orientation: vector(0, 0, 90), CastShadow: false, Reflectance: 0.25 };
  const command = store.enqueue({ sessionId: pair.sessionId, requestId: 'geometry-update', method: 'scene.update', args: { ref, expected: before, properties: after } });
  store.poll(pair.sessionId);
  const mutation = { kind: 'scene.update', ref, before: { properties: before }, after: { properties: after } };
  for (const wrong of [
    { ...mutation, after: { properties: { ...after, Shape: 'Ball' } } },
    { ...mutation, before: { properties: { ...before, Orientation: vector(0, 0, 1) } } },
    { ...mutation, after: { properties: { ...after, Material: 'Plastic' } } },
  ]) assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: { ref, mutation: wrong } }), /intended change/);
  store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: { ref, mutation } });
  const restored = store.restore({ commandId: command.id, requestId: 'geometry-restore' });
  assert.equal(restored.method, 'scene.restore');
  assert.equal(canonical(restored.args.mutation), canonical(mutation));
  assert.throws(() => store.enqueue({ sessionId: pair.sessionId, requestId: 'geometry-inverse', method: 'scene.restore', args: restored.args }), /arbitrary inverse/);
});

test('shared store rejects shape-class mismatch and invalid degrees without recording a command', t => {
  const { store, pair, ref } = storeFixture(t);
  for (const className of ['WedgePart', 'CornerWedgePart', 'MeshPart', 'Model']) assert.throws(() => store.enqueue({ sessionId: pair.sessionId, requestId: 'bad-' + className, method: 'scene.update', args: { ref: { ...ref, className }, expected: { Shape: 'Block' }, properties: { Shape: 'Cylinder' } } }), /Shape requires|not writable/);
  assert.throws(() => store.enqueue({ sessionId: pair.sessionId, requestId: 'bad-angle', method: 'scene.update', args: { ref, expected: { Orientation: vector(0, 0, 0) }, properties: { Orientation: vector(0, 361, 0) } } }), /degrees/);
  assert.equal(store.commands().length, 0);
});

test('write grants, capabilities, unsupported creation classes and raw evaluation remain fenced', () => {
  const args = { parent: reference('Workspace', true), className: 'Part', name: 'Spawn', properties: { Shape: 'Cylinder' } };
  assert.throws(() => validateCommandArgs('scene.create', args, { ...session, allowWrites: false }), /read-only/);
  assert.throws(() => validateCommandArgs('scene.create', args, { ...session, capabilities: [...READ_METHODS] }), /does not support/);
  for (const className of ['MeshPart', 'RemoteEvent', 'Workspace', 'DataStoreService']) {
    assert.equal(createClass.safeParse(className).success, false);
    assert.throws(() => validateCommandArgs('scene.create', { ...args, className }, session), /creation class/);
  }
  assert.throws(() => validateCommandArgs('scene.create', { ...args, code: 'return 1' }, session), /Unexpected/);
});
