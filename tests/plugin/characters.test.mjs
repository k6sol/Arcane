import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const modules = ['Validation', 'Registry', 'Properties', 'Operations'];

// Engine doubles owned by this harness: typed Color3, typed enums, Humanoid/AnimationController class checks and the
// documented clamp of Humanoid.Health to MaxHealth. They do not certify Roblox.
const engineFixture = `
local function typed(kind: string, value: any): any rawset(value, "_type", kind); return value end
Color3 = {new = function(r: number, g: number, b: number): any return typed("Color3", triple(r, g, b)) end}
local function typeof(value: any): string
  if type(value) == "table" and value._enumItem == true then return "EnumItem" end
  if type(value) == "table" and type(rawget(value, "_type")) == "string" then return rawget(value, "_type") end
  return nativeTypeof(value)
end
Enum.HumanoidRigType = enumCategory({"R6", "R15"})
Enum.HumanoidDisplayDistanceType = enumCategory({"Viewer", "Subject", "None"})
local engineSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if string.sub(key, 1, 1) == "_" then rawset(self, key, value); return end
  local className = rawget(self, "_properties").ClassName
  if fixture.refuse and fixture.refuse[className .. "." .. key] then error("The current thread cannot set '" .. key .. "' (lacking capability Plugin)") end
  if className == "Humanoid" and key == "Health" then value = math.min(value, rawget(self, "_properties").MaxHealth or 100) end
  engineSetter(self, key, value)
end
`;

const json = value => JSON.stringify(JSON.stringify(value));
const c3 = value => ({ type: 'Color3', value }), v3 = value => ({ type: 'Vector3', value });
/** Wire-form build: a stationary NPC (root part, Humanoid hosting a description and an Animator) and a creature with an AnimationController. */
const npcBuild = {
  parent: '__PARENT__', container: { className: 'Folder', name: 'Characters' }, prototypes: [],
  items: [
    { kind: 'group', className: 'Model', name: 'Shopkeeper', parent: 0, key: 'Npc' },
    { kind: 'part', className: 'Part', name: 'HumanoidRootPart', parent: 1, properties: { Size: v3([2, 2, 1]), Position: v3([0, 3, 0]), Anchored: true } },
    { kind: 'effect', className: 'Humanoid', name: 'Humanoid', parent: 1, key: 'Hum', properties: { DisplayName: 'Shopkeeper', WalkSpeed: 0, MaxHealth: 500, Health: 450,
      RigType: 'R15', DisplayDistanceType: 'Viewer', UseJumpPower: true, JumpPower: 0 } },
    { kind: 'effect', className: 'HumanoidDescription', name: 'Look', parent: 3, properties: { TorsoColor: c3([0.2, 0.3, 0.55]), HeightScale: 1.05, BodyTypeScale: 0.3 } },
    { kind: 'effect', className: 'Animator', name: 'Animator', parent: 3, properties: {} },
    { kind: 'group', className: 'Model', name: 'Crab', parent: 0 },
    { kind: 'effect', className: 'AnimationController', name: 'AnimationController', parent: 6, properties: {} },
    { kind: 'effect', className: 'Animator', name: 'Animator', parent: 7, properties: {} },
  ],
};

const checks = `
local V = Validation
local checks, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local workspace = game:GetService("Workspace")
local ops = Operations.new({sessionId = "characters-session", allowedRoots = {"Workspace"}}, game, http)
local function run(method: string, args: any): (any, string)
  serial += 1
  local id = "chr-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function refuses(code: string, callback: () -> any, text: string?): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
  if text then check(string.find(err.message, text, 1, true) ~= nil, "message names: " .. text .. " / " .. err.message) end
  return err
end
check(table.find(V.FEATURE_CAPABILITIES, "scene.characters") ~= nil, "plugin advertises scene.characters")

-- 1. scene.build: NPC and creature in one recording; MaxHealth assigned before Health so the engine clamp keeps 450.
local args = V.decode(${json(npcBuild)}, http)
args.parent = ops.registry:ref(workspace)
local committed = fixture.committed
local built, buildId = run("scene.build", args)
check(fixture.committed == committed + 1 and built.created.count == 9, "one recording for root + 8 items")
check(built.created.classes.Humanoid == 1 and built.created.classes.Animator == 2 and built.created.classes.AnimationController == 1, "character class histogram")
local humanoid = ops.registry:resolve(built.refs.Hum)
local npc = ops.registry:resolve(built.refs.Npc)
check(humanoid.Parent == npc and humanoid.ClassName == "Humanoid", "Humanoid inside the NPC Model")
check(humanoid.MaxHealth == 500 and humanoid.Health == 450 and humanoid.WalkSpeed == 0 and humanoid.DisplayName == "Shopkeeper", "Humanoid values verified after the clamp")
check(humanoid.RigType == Enum.HumanoidRigType.R15 and humanoid.DisplayDistanceType == Enum.HumanoidDisplayDistanceType.Viewer, "typed Humanoid enums")
local kids = humanoid:GetChildren()
check(#kids == 2 and kids[1].ClassName == "HumanoidDescription" and kids[2].ClassName == "Animator", "description and Animator inside the Humanoid")
check(math.abs(kids[1].HeightScale - 1.05) < 1e-4 and math.abs(kids[1].TorsoColor.B - 0.55) < 1e-4, "description scales and colours")
local root = ops.registry:resolve(built.ref)
local restored = run("scene.restore", {receiptCommandId = buildId, mutation = built.mutation})
check(restored.restored and root.Parent == nil, "restore removes the unchanged character build")

-- 2. scene.create: a Humanoid in a Model, then an Animator and a description inside it; an AnimationController creature.
local model = Instance.new("Model"); model.Name = "Guard"; model.Parent = workspace
local modelRef = ops.registry:ref(model)
local function create(className: string, properties: any, parent: any): any
  return run("scene.create", {parent = parent, className = className, name = className, properties = properties})
end
local guard = ops.registry:resolve(create("Humanoid", {WalkSpeed = 14, MaxHealth = 150, Health = 150}, modelRef).ref)
check(guard.Parent == model and guard.MaxHealth == 150 and guard.Health == 150, "Humanoid created with MaxHealth before Health")
local animator = ops.registry:resolve(create("Animator", {}, ops.registry:ref(guard)).ref)
check(animator.Parent == guard, "Animator inside the Humanoid")
local look = ops.registry:resolve(create("HumanoidDescription", V.decode(${json({ HeadColor: c3([0.8, 0.6, 0.45]), WidthScale: 0.9 })}, http), ops.registry:ref(guard)).ref)
check(look.Parent == guard and math.abs(look.WidthScale - 0.9) < 1e-4, "HumanoidDescription inside the Humanoid")

-- 3. Refusals before any allocation: hosts, bounds, cross-field Health and unlisted properties.
local allocations = #fixture.created
local part = Instance.new("Part"); part.Parent = workspace
local partRef = ops.registry:ref(part)
allocations = #fixture.created
refuses("CLASS", function() return create("Humanoid", {}, partRef) end)
refuses("CLASS", function() return create("Animator", {}, modelRef) end)
refuses("CLASS", function() return create("HumanoidDescription", {}, partRef) end)
refuses("INPUT", function() return create("Humanoid", {WalkSpeed = 500}, modelRef) end)
refuses("PROPERTY", function() return create("Humanoid", {Health = 300, MaxHealth = 100}, modelRef) end, "Health must not exceed MaxHealth")
refuses("PROPERTY", function() return create("Humanoid", {RigType = "R20"}, modelRef) end)
refuses("PROPERTY", function() return create("Humanoid", {DisplayName = "two\\nlines"}, modelRef) end)
refuses("PROPERTY", function() return create("Humanoid", {BreakJointsOnDeath = false}, modelRef) end)
refuses("PROPERTY", function() return create("HumanoidDescription", {Shirt = 1}, modelRef) end)
refuses("PROPERTY", function() return create("Animator", {PreferLodEnabled = true}, ops.registry:ref(guard)) end)
refuses("INPUT", function() return create("HumanoidDescription", {HeightScale = 9}, modelRef) end)
local wrongHost = V.decode(${json(npcBuild)}, http); wrongHost.parent = ops.registry:ref(workspace); wrongHost.items[5].parent = 1
refuses("INPUT", function() return run("scene.build", wrongHost) end, "Animator must be inside")
check(#fixture.created == allocations, "refused character payloads allocate nothing")

-- 4. Studio refusing a write is a clean VERIFY failure; nothing reaches the place.
fixture.refuse = {["Humanoid.WalkSpeed"] = true}
local children = #model:GetChildren()
refuses("VERIFY", function() return create("Humanoid", {WalkSpeed = 10}, modelRef) end, "Humanoid.WalkSpeed")
fixture.refuse = nil
check(#model:GetChildren() == children, "refused Humanoid is not parented")
print("Arcane character checks passed: " .. checks)
`;

async function runLuau(source, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-characters-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'characters.luau');
    await writeFile(harness, sources.join('\n') + '\n' + source);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, marker);
    process.stdout.write(result.stdout);
  } finally {
    assert.ok(path.basename(directory).startsWith('arcane-characters-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('real Luau: Humanoid, HumanoidDescription, AnimationController and Animator with typed bounds, hosts and Health ordering', { skip: !runtime }, async () => {
  await runLuau(checks, /Arcane character checks passed: \d+/);
});
