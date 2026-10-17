import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { validateCommandArgs, ENVIRONMENT_PRESETS, ENVIRONMENT_PRESET_NAMES, EFFECT_CLASSES, EFFECT_PROPERTIES, contentId, sceneBuildInstanceCount } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, STUDIO_EFFECTS_CAPABILITY, type InstanceRef, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, compileEnvironment, compileEffectProps, sceneBuildShape, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';
import { composeViewportSheet, frameCamera, VIEWPORT_FRAMING, VIEWPORT_VIEWS, viewportRequestSchema } from '../../packages/studio-test-controller/src/viewport.js';
import { decodeViewportPng, encodeRgbPng, VIEWPORT_LIMITS } from '../../packages/studio-test-controller/src/viewport-image.js';

const SESSION = 'effects-session';
const session = (effects = true, roots: StudioSession['allowedRoots'] = ['Workspace', 'Lighting']): StudioSession => ({
  id: SESSION, protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: roots, allowWrites: true, capabilities: [...READ_METHODS, ...WRITE_METHODS, ...(effects ? [STUDIO_EFFECTS_CAPABILITY] : [])],
  connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const ref = (className: string, root = false): InstanceRef => ({ instanceId: 'opaque-' + className, sessionId: SESSION, root: 'Workspace', pathSegments: root ? [] : [className], className });
const seq = (value: number[][]) => ({ type: 'NumberSequence', value });
const create = (className: string, properties: Record<string, Json>, parent = ref('Part'), s = session()) =>
  validateCommandArgs('scene.create', { parent, className, name: className, properties } as unknown as Record<string, Json>, s);

test('effects allowlist: every class has properties and the plugin mirrors the same class list', async () => {
  const { readFileSync } = await import('node:fs');
  const plugin = readFileSync('plugin/src/Properties.luau', 'utf8');
  assert.equal(EFFECT_CLASSES.length, 13);
  for (const className of EFFECT_CLASSES) {
    assert.ok(Object.keys(EFFECT_PROPERTIES[className]).length > 0);
    assert.match(plugin, new RegExp(`\\b${className} = `), className);
  }
  assert.equal(EFFECT_CLASSES.includes('SurfaceAppearance' as never), false, 'SurfaceAppearance maps are not plugin-settable; it stays manual');
});

test('scene.create effects: typed sequences, ranges, enums and content ids validate; hosts and capability are enforced', () => {
  const emitter = { Rate: 30, Lifetime: { type: 'NumberRange', value: [1, 2] }, Size: seq([[0, 1], [0.5, 2, 0.5], [1, 0]]),
    Color: { type: 'ColorSequence', value: [[0, 1, 0.5, 0], [1, 0.2, 0.1, 0]] }, Orientation: 'VelocityParallel', Texture: 'rbxassetid://123', SpreadAngle: { type: 'Vector2', value: [10, 10] } };
  assert.deepEqual(create('ParticleEmitter', emitter).properties, emitter);
  assert.ok(create('ParticleEmitter', { Rate: 5 }, ref('Attachment')));
  assert.ok(create('Highlight', { FillTransparency: 0.5 }, ref('Workspace', true)));
  assert.throws(() => create('Attachment', {}, ref('Model')), { code: 'CLASS' });
  assert.throws(() => create('Decal', {}, ref('Attachment')), { code: 'CLASS' });
  assert.throws(() => create('ParticleEmitter', { Rate: 5 }, ref('Part'), session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  for (const bad of [{ Size: seq([[0.2, 1], [1, 1]]) }, { Size: seq([[0, 1]]) }, { Size: seq(Array.from({ length: 21 }, (_, i) => [i / 20, 1])) },
    { Size: seq([[0, 1], [0.5, 1], [0.4, 1], [1, 1]]) }, { Transparency: seq([[0, 2], [1, 0]]) }, { Lifetime: { type: 'NumberRange', value: [3, 1] } },
    { Orientation: 'Sideways' }, { Rate: 1e6 }, { Source: 'print(1)' }, { Parent: 'x' }, { Color: { type: 'Color3', value: [1, 0, 0] } }])
    assert.throws(() => create('ParticleEmitter', bad as Record<string, Json>), { code: /PROPERTY|INPUT/ }, JSON.stringify(bad));
  assert.throws(() => create('Beam', { Segments: 2.5 }), { code: 'PROPERTY' });
});

test('content ids: only numeric rbxassetid or built-in rbxasset://textures paths, never URLs', () => {
  for (const good of ['rbxassetid://1', 'rbxassetid://1234567890123', 'rbxasset://textures/particles/sparkles_main.dds', 'rbxasset://textures/terrain/a_b-c.png'])
    assert.equal(contentId(good, 'Texture'), good);
  for (const bad of ['http://example.com/x.png', 'https://www.roblox.com/asset/?id=1', 'rbxassetid://0', 'rbxassetid://12a', 'rbxassetid://1 ', ' rbxassetid://1',
    'rbxasset://textures/../../secret.png', 'rbxasset://fonts/a.ttf', 'rbxasset://textures/a.exe', 'rbxthumb://type=Asset&id=1&w=150&h=150', 'file:///C:/x.png',
    'rbxassetid://12345678901234567890', 'RBXASSETID://1', 'rbxasset://textures/', 'rbxasset://textures/a.png\n'])
    assert.throws(() => contentId(bad, 'Texture'), { code: 'PROPERTY' }, bad);
  assert.throws(() => create('Decal', { Texture: 'https://evil.example/x.png' }), { code: 'PROPERTY' });
  assert.throws(() => validateCommandArgs('environment.apply', { materials: [{ name: 'Moss', baseMaterial: 'Slate', ColorMap: 'http://x/y.png' }] }, session()), { code: 'PROPERTY' });
});

test('Beam/Trail Attachment refs: scene.create needs an Attachment ref in this session; scene.build needs an earlier Attachment item', () => {
  assert.ok(create('Beam', { Attachment0: { type: 'Ref', ref: ref('Attachment') as unknown as Json }, Width0: 1 }, ref('Model')));
  assert.throws(() => create('Beam', { Attachment0: { type: 'Ref', ref: ref('Part') as unknown as Json } }, ref('Model')), { code: 'PROPERTY' });
  assert.throws(() => create('Beam', { Attachment0: { type: 'Ref', ref: { ...ref('Attachment'), sessionId: 'other' } as unknown as Json } }, ref('Model')), { code: 'SCOPE' });
  const items: Json[] = [
    { kind: 'part', className: 'Part', name: 'Post', parent: 0, properties: {} },
    { kind: 'effect', className: 'Attachment', name: 'A0', parent: 1, properties: {} },
    { kind: 'effect', className: 'Attachment', name: 'A1', parent: 1, properties: {} },
    { kind: 'effect', className: 'Beam', name: 'Beam', parent: 1, properties: { Attachment0: { type: 'Ref', item: 2 }, Attachment1: { type: 'Ref', item: 3 } } },
    { kind: 'effect', className: 'ParticleEmitter', name: 'Sparks', parent: 2, properties: { Rate: 4 } },
  ];
  const args = { parent: ref('Workspace', true) as unknown as Json, container: { className: 'Model', name: 'Torch' }, items };
  const result = validateCommandArgs('scene.build', args, session());
  assert.equal(sceneBuildInstanceCount(result), 6);
  const patch = (index: number, change: Record<string, Json>) => ({ ...args, items: items.map((item, i) => i === index ? { ...(item as object), ...change } : item) as Json[] });
  assert.throws(() => validateCommandArgs('scene.build', patch(3, { properties: { Attachment0: { type: 'Ref', item: 1 } } }), session()), /earlier Attachment/);
  assert.throws(() => validateCommandArgs('scene.build', patch(3, { properties: { Attachment0: { type: 'Ref', item: 4 } } }), session()), /earlier Attachment/);
  assert.throws(() => validateCommandArgs('scene.build', patch(1, { parent: 0 }), session()), /Attachment must be inside a part/);
  assert.throws(() => validateCommandArgs('scene.build', { ...args, items: [...items, { kind: 'part', className: 'Part', name: 'Bad', parent: 2, properties: {} }] }, session()), /Only group items/);
  assert.throws(() => validateCommandArgs('scene.build', args, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
});

test('MCP compact effects compile to the tagged wire form that the policy accepts', () => {
  const input = z.strictObject(sceneBuildShape).parse({ name: 'Campfire', items: [
    { key: 'Log', name: 'Log', props: { Size: [4, 1, 1], Position: [0, 0.5, 0] } },
    { key: 'Top', in: 'Log', className: 'Attachment', name: 'Top', fx: { Position: [0, 2, 0] } },
    { key: 'Low', in: 'Log', className: 'Attachment', name: 'Low', fx: { Position: [0, 0, 0] } },
    { in: 'Top', className: 'ParticleEmitter', name: 'Embers', fx: { Rate: 20, Size: [0.4, 1, 0], Transparency: 0.2, Lifetime: [1, 2], Speed: 3,
      Color: ['#ffcc55', '#ff3300'], SpreadAngle: [20, 20], Texture: 'rbxasset://textures/particles/fire_main.dds' } },
    { in: 'Log', className: 'Beam', name: 'Heat', fx: { Attachment0: 'Top', Attachment1: 'Low', Color: '#ffaa00', Width0: 1 } },
    { in: 'Log', className: 'PointLight', name: 'Glow', fx: { Color: [1, 0.6, 0.3], Range: 16, Brightness: 2 } },
  ] }) as SceneBuildInput;
  const compiled = compileSceneBuild(input, ref('Workspace', true) as unknown as Json);
  const items = compiled.args.items as Record<string, Json>[];
  const embers = items[3]!.properties as Record<string, Json>;
  assert.deepEqual(embers.Size, { type: 'NumberSequence', value: [[0, 0.4], [0.5, 1], [1, 0]] });
  assert.deepEqual(embers.Transparency, { type: 'NumberSequence', value: [[0, 0.2], [1, 0.2]] });
  assert.deepEqual(embers.Speed, { type: 'NumberRange', value: [3, 3] });
  assert.equal((embers.Color as { type: string }).type, 'ColorSequence');
  assert.deepEqual((items[4]!.properties as Record<string, Json>).Attachment0, { type: 'Ref', item: 2 });
  assert.equal(items[1]!.parent, 1); assert.equal(items[3]!.parent, 2);
  assert.ok(validateCommandArgs('scene.build', compiled.args, session()));
  const bad = (fx: Record<string, unknown>, className = 'Beam') => compileSceneBuild(z.strictObject(sceneBuildShape).parse({ name: 'X', items: [
    { key: 'P', name: 'P', props: {} }, { key: 'A', in: 'P', className: 'Attachment', name: 'A', fx: {} }, { in: 'P', className, name: 'E', fx }] }) as SceneBuildInput, null);
  assert.throws(() => bad({ Attachment0: 'P' }), /earlier Attachment/);
  assert.throws(() => bad({ Texture: 'https://x/y.png' }), /rbxassetid/);
  assert.throws(() => bad({ Wobble: 1 }), /not an allowed effect property/);
  assert.throws(() => compileEffectProps('Fire', { Heat: 99 }, () => null), /Fire.Heat/);
});

test('environment presets expand host-side to exact values; explicit values override; extras are capability-gated', () => {
  for (const name of ENVIRONMENT_PRESET_NAMES) {
    const result = validateCommandArgs('environment.apply', { preset: name }, session());
    assert.equal(Object.hasOwn(result, 'preset'), false);
    assert.deepEqual(result, structuredClone(ENVIRONMENT_PRESETS[name]));
  }
  assert.deepEqual(ENVIRONMENT_PRESET_NAMES, ['clear_day', 'golden_hour', 'foggy_forest', 'night', 'horror', 'sci_fi']);
  const tuned = validateCommandArgs('environment.apply', { preset: 'golden_hour', lighting: { ClockTime: 18.2 }, technology: 'Future', terrainDecoration: true }, session());
  assert.equal((tuned.lighting as Record<string, Json>).ClockTime, 18.2);
  assert.equal((tuned.lighting as Record<string, Json>).Brightness, ENVIRONMENT_PRESETS.golden_hour.lighting.Brightness);
  assert.equal(tuned.technology, 'Future'); assert.equal(tuned.terrainDecoration, true);
  assert.throws(() => validateCommandArgs('environment.apply', { preset: 'sunny' }, session()), /preset must be one of/);
  assert.throws(() => validateCommandArgs('environment.apply', { preset: 'night' }, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => validateCommandArgs('environment.apply', { technology: 'Raytraced' }, session()), { code: 'PROPERTY' });
  assert.throws(() => validateCommandArgs('environment.apply', { technology: 'Future' }, session(true, ['Workspace'])), { code: 'SCOPE' });
  assert.throws(() => validateCommandArgs('environment.apply', { materials: [{ name: 'A', baseMaterial: 'Slate' }, { name: 'A', baseMaterial: 'Rock' }] }, session()), /unique/);
  assert.throws(() => validateCommandArgs('environment.apply', { materials: [{ name: 'A', baseMaterial: 'Water' }] }, session()), { code: 'PROPERTY' });
  assert.ok(validateCommandArgs('environment.apply', { materials: [{ name: 'Moss Slate', baseMaterial: 'Slate', studsPerTile: 8, override: true, ColorMap: 'rbxassetid://9', NormalMap: 'rbxasset://textures/terrain/slate.png' }] }, session()));
  assert.deepEqual(compileEnvironment({ preset: 'night', technology: 'Future', materials: [{ name: 'M', baseMaterial: 'Rock', studsPerTile: undefined }] }),
    { preset: 'night', technology: 'Future', materials: [{ name: 'M', baseMaterial: 'Rock' }] });
  assert.ok(validateCommandArgs('scene.inspect', { ref: ref('Model') as unknown as Json, bounds: true }, session()));
  assert.throws(() => validateCommandArgs('scene.inspect', { ref: ref('Model') as unknown as Json, bounds: true }, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
});

test('framing math: every named view keeps the whole bounding box inside the vertical field of view', () => {
  const half = VIEWPORT_FRAMING.fovDegrees / 2 * Math.PI / 180;
  for (const bounds of [{ center: [0, 5, 0], size: [10, 10, 10] }, { center: [120, 3, -40], size: [60, 6, 8] }, { center: [0, 40, 0], size: [0.2, 80, 0.2] }]) {
    const box = { ...bounds, space: 'world-aabb' as const } as Parameters<typeof frameCamera>[0];
    for (const view of VIEWPORT_VIEWS) {
      const camera = frameCamera(box, view);
      const forward = camera.lookAt.map((v, i) => v - camera.position[i]!), length = Math.hypot(...forward);
      assert.ok(length >= VIEWPORT_FRAMING.minDistance && length <= VIEWPORT_LIMITS.maxCameraDistance);
      for (const corner of [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z])))) {
        const point = corner.map((sign, i) => box.center[i]! + sign * box.size[i]! / 2), ray = point.map((v, i) => v - camera.position[i]!);
        const angle = Math.acos(Math.min(1, ray.reduce((sum, v, i) => sum + v * forward[i]!, 0) / (Math.hypot(...ray) * length)));
        assert.ok(angle <= half + 1e-6, `${view} corner ${corner} at ${(angle * 180 / Math.PI).toFixed(1)} degrees`);
      }
      if (view === 'top') assert.ok(camera.position[1]! > box.center[1]! + box.size[1]! / 2);
      if (view === 'low_angle') assert.ok(camera.position[1]! < box.center[1]! && camera.lookAt[1]! > box.center[1]!);
      if (view === 'front') assert.ok(camera.position[2]! < box.center[2]!, 'Roblox Front faces -Z');
    }
  }
  const radius = Math.hypot(10, 10, 10) / 2, front = frameCamera({ center: [0, 0, 0], size: [10, 10, 10], space: 'world-aabb' }, 'front');
  assert.ok(Math.abs(Math.hypot(...front.position) - radius * VIEWPORT_FRAMING.padding / Math.sin(half)) < 0.01);
  assert.throws(() => frameCamera({ center: [0, 0, 0], size: [9000, 9000, 9000], space: 'world-aabb' }, 'front'));
  assert.throws(() => frameCamera({ center: [0, 0, 0], size: [1, 1, 1], space: 'world-aabb' }, 'side' as never));
});

test('multi-view sheet: 2–4 small tiles in one PNG within the dimension and byte bounds', () => {
  const frame = (width: number, height: number, noise = false) => {
    const rgb = noise ? randomBytes(width * height * 3) : Buffer.alloc(width * height * 3, 90);
    return encodeRgbPng(rgb, width, height);
  };
  for (const [count, maxDimension] of [[2, 768], [3, 512], [4, 1024], [4, 256]] as const) {
    const sheet = composeViewportSheet(Array.from({ length: count }, () => frame(1280, 720)), maxDimension);
    assert.ok(sheet.width <= maxDimension && sheet.height <= maxDimension, `${sheet.width}x${sheet.height}`);
    assert.ok(sheet.bytes <= VIEWPORT_LIMITS.outputBytes);
    const decoded = decodeViewportPng(sheet.png);
    assert.equal(decoded.width, sheet.width);
    if (count > 2) assert.ok(sheet.height > sheet.width / 2, 'two rows');
  }
  const noisy = composeViewportSheet(Array.from({ length: 4 }, () => frame(1280, 720, true)), 1024);
  assert.ok(noisy.bytes <= VIEWPORT_LIMITS.outputBytes);
  assert.throws(() => composeViewportSheet([frame(64, 64)], 768));
  assert.throws(() => composeViewportSheet(Array.from({ length: 5 }, () => frame(64, 64)), 768));
  const camera = { position: [10, 10, 10], lookAt: [0, 0, 0] };
  assert.ok(viewportRequestSchema.safeParse({ sessionId: 's', sheet: [camera, camera] }).success);
  assert.equal(viewportRequestSchema.safeParse({ sessionId: 's', sheet: [camera] }).success, false);
  assert.equal(viewportRequestSchema.safeParse({ sessionId: 's', sheet: Array(5).fill(camera) }).success, false);
  assert.equal(viewportRequestSchema.safeParse({ sessionId: 's', camera, sheet: [camera, camera] }).success, false);
});
