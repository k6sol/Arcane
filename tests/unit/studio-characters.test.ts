import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { validateCommandArgs, CHARACTER_CLASSES, EFFECT_CLASSES, EFFECT_PROPERTIES, EFFECT_HOSTS, EFFECT_HOST_CLASSES, hostKind } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, STUDIO_EFFECTS_CAPABILITY, STUDIO_CHARACTERS_CAPABILITY, STUDIO_FEATURE_CAPABILITIES, type InstanceRef, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, sceneBuildShape, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';

const SESSION = 'characters-session';
const session = (characters = true): StudioSession => ({
  id: SESSION, protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true,
  capabilities: [...READ_METHODS, ...WRITE_METHODS, STUDIO_EFFECTS_CAPABILITY, ...(characters ? [STUDIO_CHARACTERS_CAPABILITY] : [])],
  connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const ref = (className: string, root = false): InstanceRef => ({ instanceId: 'opaque-' + className, sessionId: SESSION, root: 'Workspace', pathSegments: root ? [] : [className], className });
const create = (className: string, properties: Record<string, Json>, parent = ref('Model'), s = session()) =>
  validateCommandArgs('scene.create', { parent, className, name: className, properties } as unknown as Record<string, Json>, s);
const c3 = (...value: number[]) => ({ type: 'Color3', value });

test('character classes: typed bounded Humanoid/HumanoidDescription properties, container-only AnimationController/Animator', () => {
  assert.deepEqual([...CHARACTER_CLASSES], ['Humanoid', 'HumanoidDescription', 'AnimationController', 'Animator']);
  for (const className of CHARACTER_CLASSES) assert.ok(EFFECT_CLASSES.includes(className), className);
  assert.deepEqual(Object.keys(EFFECT_PROPERTIES.Humanoid).sort(), ['AutoRotate', 'DisplayDistanceType', 'DisplayName', 'Health', 'HipHeight', 'JumpPower', 'MaxHealth', 'RigType', 'UseJumpPower', 'WalkSpeed']);
  assert.deepEqual(Object.keys(EFFECT_PROPERTIES.AnimationController), []);
  assert.deepEqual(Object.keys(EFFECT_PROPERTIES.Animator), []);
  for (const key of Object.keys(EFFECT_PROPERTIES.HumanoidDescription)) assert.match(key, /Color$|Scale$/, key);
  assert.ok(STUDIO_FEATURE_CAPABILITIES.includes(STUDIO_CHARACTERS_CAPABILITY));
  assert.match(readFileSync('plugin/src/Validation.luau', 'utf8'), /FEATURE_CAPABILITIES = table\.freeze\(\{[^}]*"scene\.characters"/);
  assert.equal(hostKind('Humanoid'), 'humanoid'); assert.equal(hostKind('AnimationController'), 'animationController');
  assert.deepEqual({ ...EFFECT_HOST_CLASSES }, { Attachment: 'attachment', Sound: 'sound', SoundGroup: 'soundGroup', Humanoid: 'humanoid', AnimationController: 'animationController' });

  const npc = { WalkSpeed: 12, JumpPower: 40, UseJumpPower: true, DisplayName: 'Mira the Smith', MaxHealth: 250, Health: 250, HipHeight: 2,
    AutoRotate: true, RigType: 'R15', DisplayDistanceType: 'Viewer' };
  assert.deepEqual(create('Humanoid', npc).properties, npc);
  const look = { HeadColor: c3(0.8, 0.6, 0.45), TorsoColor: c3(0.2, 0.3, 0.6), HeightScale: 1.05, WidthScale: 0.9, BodyTypeScale: 0.3, ProportionScale: 0 };
  assert.deepEqual(create('HumanoidDescription', look, ref('Humanoid')).properties, look);
  assert.ok(create('HumanoidDescription', look, ref('Folder')), 'stored description for CreateHumanoidModelFromDescription');
  assert.ok(create('AnimationController', {}));
  assert.ok(create('Animator', {}, ref('Humanoid'))); assert.ok(create('Animator', {}, ref('AnimationController')));

  for (const [className, parent] of [['Humanoid', ref('Part')], ['Humanoid', ref('Humanoid')], ['Animator', ref('Model')], ['Animator', ref('Part')],
    ['HumanoidDescription', ref('Part')], ['AnimationController', ref('Attachment')]] as const)
    assert.throws(() => create(className, {}, parent), { code: 'CLASS' }, `${className} in ${parent.className}`);
  for (const bad of [{ WalkSpeed: 500 }, { WalkSpeed: -1 }, { JumpPower: 1e6 }, { MaxHealth: 0 }, { Health: -5 }, { HipHeight: 99 }, { RigType: 'R20' },
    { DisplayDistanceType: 'Always' }, { DisplayName: 'line\nbreak' }, { DisplayName: 'x'.repeat(2001) }, { Health: 300, MaxHealth: 100 },
    { WalkSpeed: Number.NaN }, { Parent: 'x' }, { Source: 'print(1)' }, { Name: 'x' }, { BreakJointsOnDeath: false }])
    assert.throws(() => create('Humanoid', bad as Record<string, Json>), { code: /PROPERTY|INPUT/ }, JSON.stringify(bad));
  for (const bad of [{ HeightScale: 5 }, { BodyTypeScale: 2 }, { Shirt: 123 }, { Face: 1 }, { HeadColor: c3(2, 0, 0) }, { IdleAnimation: 1 }])
    assert.throws(() => create('HumanoidDescription', bad as Record<string, Json>, ref('Humanoid')), { code: /PROPERTY|INPUT/ }, JSON.stringify(bad));
  assert.throws(() => create('Animator', { PreferLodEnabled: true }, ref('Humanoid')), { code: 'PROPERTY' });
  assert.throws(() => create('Humanoid', { WalkSpeed: 10 }, ref('Model'), session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.ok(create('PointLight', { Brightness: 1 }, ref('Part'), session(false)), 'older plugins keep every other effect class');
});

test('scene_build compiles a stationary NPC: Model + parts + Humanoid hosting a description and an Animator, one capability-gated build', () => {
  const compiled = compileSceneBuild(z.strictObject(sceneBuildShape).parse({ name: 'Shopkeeper', items: [
    { key: 'Npc', className: 'Model', name: 'Shopkeeper' },
    { in: 'Npc', name: 'HumanoidRootPart', props: { Size: [2, 2, 1], Position: [0, 3, 0], Transparency: 1 } },
    { key: 'Hum', in: 'Npc', className: 'Humanoid', name: 'Humanoid', fx: { DisplayName: 'Shopkeeper', WalkSpeed: 0, MaxHealth: 500, Health: 500, DisplayDistanceType: 'Viewer' } },
    { in: 'Hum', className: 'HumanoidDescription', name: 'Look', fx: { TorsoColor: '#3a5a8c', HeadColor: [0.85, 0.65, 0.5], HeightScale: 1 } },
    { in: 'Hum', className: 'Animator', name: 'Animator', fx: {} },
    { key: 'Crab', className: 'Model', name: 'Crab' },
    { key: 'Ctl', in: 'Crab', className: 'AnimationController', name: 'AnimationController', fx: {} },
    { in: 'Ctl', className: 'Animator', name: 'Animator', fx: {} },
  ] }) as SceneBuildInput, ref('Workspace', true) as unknown as Json);
  const items = compiled.args.items as Record<string, Json>[];
  const humanoid = items.findIndex(item => item.className === 'Humanoid') + 1;
  assert.ok(humanoid > 0);
  assert.equal(items.find(item => item.className === 'HumanoidDescription')!.parent, humanoid);
  assert.deepEqual((items.find(item => item.className === 'HumanoidDescription')!.properties as Record<string, Json>).HeadColor, { type: 'Color3', value: [0.85, 0.65, 0.5] });
  assert.ok(validateCommandArgs('scene.build', compiled.args, session()));
  assert.throws(() => validateCommandArgs('scene.build', compiled.args, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  const bad = (items: unknown[]) => compileSceneBuild(z.strictObject(sceneBuildShape).parse({ name: 'X', items }) as SceneBuildInput, null);
  assert.throws(() => bad([{ key: 'M', className: 'Model', name: 'M' }, { in: 'M', className: 'Animator', name: 'A', fx: {} }]), /Animator must be inside a humanoid or animationController/);
  assert.throws(() => bad([{ key: 'P', name: 'P', props: {} }, { in: 'P', className: 'Humanoid', name: 'H', fx: {} }]), /Humanoid must be inside a group/);
  assert.throws(() => bad([{ key: 'M', className: 'Model', name: 'M' }, { in: 'M', className: 'Humanoid', name: 'H', fx: { Health: 200, MaxHealth: 100 } }]), /Health must not exceed MaxHealth/);
});

test('characters allowlist: the plugin mirrors the exact class/property/kind/bound table and hosts', { skip: !process.env.ARCANE_LUAU_BIN }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-characters-parity-'));
  try {
    const wrap = (name: string) => `local ${name} = (function()\n${readFileSync(`plugin/src/${name}.luau`, 'utf8').replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`;
    const dump = `
local function encode(value: any): string
  if type(value) == "string" then return string.format("%q", value) end
  if type(value) == "number" or type(value) == "boolean" then return tostring(value) end
  if next(value) == nil then return "{}" end
  if #value > 0 then
    if #value == 1 and type(value[1]) == "string" then return encode(value[1]) end
    local parts = {}
    for _, item in ipairs(value) do table.insert(parts, encode(item)) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do table.insert(keys, key) end
  table.sort(keys)
  local parts = {}
  for _, key in ipairs(keys) do table.insert(parts, string.format("%q", key) .. ":" .. encode(value[key])) end
  return "{" .. table.concat(parts, ",") .. "}"
end
print(encode({specs = Properties.EFFECT_SPECS, hosts = Properties.EFFECT_HOSTS, provides = Properties.EFFECT_HOST_CLASSES}))`;
    const harness = join(directory, 'parity.luau');
    writeFileSync(harness, wrap('Validation') + wrap('Properties') + dump);
    const result = spawnSync(process.env.ARCANE_LUAU_BIN!, [harness], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const plugin = JSON.parse(result.stdout.trim());
    const sorted = (value: unknown): unknown => Array.isArray(value) ? (value.length === 1 && typeof value[0] === 'string' ? value[0] : value.map(sorted))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sorted(v)])) : value;
    // Every effect class (audio, light, particle and character) is mirrored exactly, not just the new ones.
    assert.deepEqual(plugin.specs, sorted(JSON.parse(JSON.stringify(EFFECT_PROPERTIES))));
    assert.deepEqual(plugin.hosts, sorted(JSON.parse(JSON.stringify(EFFECT_HOSTS))));
    assert.deepEqual(plugin.provides, sorted({ ...EFFECT_HOST_CLASSES }));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});
