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
const modules = ['Sha256Stream', 'Validation', 'Registry', 'Properties', 'AssetMaterials','Operations'];

// Engine doubles owned by this harness: float32 RGB8 colour storage and YXZ orientation
// (as in properties.test.mjs), plus CFrame.new, a Terrain recorder, Raycast and Lighting values.
const engineFixture = `
local colorScratch = buffer.create(4)
local function colorFloat32(value: number): number
  buffer.writef32(colorScratch, 0, value)
  return buffer.readf32(colorScratch, 0)
end
Color3.new = triple
Color3.fromRGB = function(r: number, g: number, b: number): any return Color3.new(r / 255, g / 255, b / 255) end
local function storedColor(value: any): any
  return Color3.fromRGB(math.floor(colorFloat32(value.R * 255)), math.floor(colorFloat32(value.G * 255)), math.floor(colorFloat32(value.B * 255)))
end
local CFrame: any = {}
function CFrame.fromOrientation(x: number, y: number, z: number): any
  local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
  local components = {0, 0, 0, cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
  for index = 4, 12 do components[index] = colorFloat32(components[index]) end
  return {GetComponents = function(_self: any): ...number return table.unpack(components) end, rotation = {x, y, z}}
end
function CFrame.new(x: number, y: number, z: number): any
  return setmetatable({position = {x, y, z}}, {__mul = function(a: any, b: any): any return {position = a.position, rotation = b.rotation} end})
end
local engineIndex = instanceMetatable.__index
instanceMetatable.__index = function(self: any, key: string): any
  if key == "CFrame" and self:IsA("BasePart") then
    return CFrame.fromOrientation(math.rad(self.Orientation.X), math.rad(self.Orientation.Y), math.rad(self.Orientation.Z))
  end
  return engineIndex(self, key)
end
local engineSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if key == "Color" and self:IsA("BasePart") then value = storedColor(value) end
  if fixture.coerce and fixture.coerce[key] ~= nil and self.ClassName == "Lighting" then value = fixture.coerce[key] end
  if key == "Orientation" and self:IsA("BasePart") and fixture.orientationReadback then value = fixture.orientationReadback end
  engineSetter(self, key, value)
end
local engineNew = Instance.new
Instance.new = function(className: string): any
  fixture.allocations = (fixture.allocations or 0) + 1
  if fixture.failAllocationAt and fixture.allocations >= fixture.failAllocationAt then error("injected allocation failure") end
  local instance = engineNew(className)
  if instance:IsA("BasePart") then instance._properties.Color = storedColor(instance.Color) end
  return instance
end
for index, name in ipairs({"Air", "Water", "Glacier", "Salt", "CrackedLava"}) do
  materials[name] = table.freeze({Name = name, Value = 100 + index, EnumType = materials, _enumItem = true})
end
-- Cooperative build slices: a counting frame yield that can simulate a lease lost while yielded.
fixture.yields = 0
task.wait = function(): ()
  fixture.yields += 1
  if fixture.failAfterYields and fixture.yields >= fixture.failAfterYields then error({code = "LEASE", message = "Command lease has expired."}, 0) end
end
`;

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-scene-build-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z][A-Za-z0-9_]*)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'scene-build.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
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
    assert.ok(path.basename(directory).startsWith('arcane-scene-build-'));
    await rm(directory, { recursive: true, force: true });
  }
}

/** Seeded wire-form forest (the shape the MCP compiler emits): 200 seven-part trees in one command. */
function forestArgs(count) {
  let seed = 7; const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const v = value => ({ type: 'Vector3', value }), c = value => ({ type: 'Color3', value });
  const parts = [
    { className: 'Part', name: 'TrunkLow', tint: false, properties: { Shape: 'Cylinder', Size: v([5, 1.6, 1.6]), Position: v([2, 2.5, 0]), Orientation: v([0, 0, 90]), Material: 'Wood', Color: c([0.35, 0.25, 0.19]), Anchored: true } },
    { className: 'Part', name: 'TrunkHigh', tint: false, properties: { Shape: 'Cylinder', Size: v([5, 1.1, 1.1]), Position: v([0, 7.5, 0]), Orientation: v([0, 0, 90]), Material: 'Wood', Color: c([0.35, 0.25, 0.19]), Anchored: true } },
    ...[0, 1, 2, 3, 4].map(i => ({ className: i === 4 ? 'WedgePart' : 'Part', name: 'Tier' + i, tint: true, properties: { ...(i === 4 ? {} : { Shape: 'Cylinder' }),
      Size: v([1.4, 9 - i * 1.6, 9 - i * 1.6]), Position: v([0, 6 + i * 2.2, 0]), Orientation: v([0, i * 23, 90]), Material: 'LeafyGrass',
      Color: c([0.18, 0.36, 0.2]), Anchored: true, CanCollide: false, CastShadow: i < 2 } })),
  ];
  const items = [{ kind: 'group', className: 'Model', name: 'Trees', parent: 0, key: 'Trees' }];
  for (let i = 0; i < count; i++) items.push({ kind: 'place', template: 1, name: 'Pine', parent: 1,
    at: [Number(((random() - 0.5) * 500).toFixed(2)), 0, Number(((random() - 0.5) * 500).toFixed(2))], yaw: i === 0 ? 90 : Number(((random() - 0.5) * 360).toFixed(1)),
    scale: i === 0 ? 1 : Number((0.75 + random() * 0.5).toFixed(3)), tint: [1, Number((0.9 + random() * 0.2).toFixed(3)), 1], ...(i === 1 ? { ground: true, key: 'Grounded' } : {}) });
  return { parent: '__PARENT__', container: { className: 'Model', name: 'Forest' }, prototypes: [{ name: 'Pine', weld: false, parts }], items };
}

const checks = (args) => `
local V, P = Validation, Validation.geometryProperties(Properties)
fixture.encode = function(data: any): string return V.encode(data, http) end
local checks, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local workspace = game:GetService("Workspace")
local lighting = game:GetService("Lighting")
for key, value in pairs({ClockTime = 14, Brightness = 1, ExposureCompensation = 0, EnvironmentDiffuseScale = 1, EnvironmentSpecularScale = 1, ShadowSoftness = 0.2,
  FogStart = 0, FogEnd = 100000, GlobalShadows = true}) do lighting._properties[key] = value end
for _, key in ipairs({"Ambient", "OutdoorAmbient", "ColorShift_Top", "FogColor"}) do lighting._properties[key] = Color3.new(0.5, 0.5, 0.5) end
local terrain = Instance.new("Terrain"); terrain.Parent = workspace
local fills = {}
for _, method in ipairs({"FillBlock", "FillBall", "FillCylinder", "FillWedge"}) do
  terrain._properties[method] = function(_self: any, ...: any): () table.insert(fills, {method, ...}) end
end
workspace._properties.Raycast = function(_self: any, origin: any, direction: any): any
  check(direction.Y < 0, "ground probe casts downward")
  return {Position = Vector3.new(origin.X, 3, origin.Z)}
end
local ops = Operations.new({sessionId = "scene-build-session", allowedRoots = {"Workspace", "Lighting"}}, game, http)
-- Zero slice budget: a deterministic frame yield every SLICE_CHECK built instances.
ops.sliceSeconds = 0
local guards = 0
local function run(method: string, args: any): (any, string)
  serial += 1
  local id = "build-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() guards += 1 end), id
end
local function refuses(code: string, callback: () -> any): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err) .. " raw " .. (if type(err) == "table" then V.encode(err, http) else tostring(err)))
  return err
end
local function forest(): any
  local args = V.decode(${JSON.stringify(JSON.stringify(args))}, http)
  args.parent = ops.registry:ref(workspace)
  return args
end
local baseline = #workspace:GetChildren()

-- 1. A 200-tree forest is one command, one undo recording, one receipt.
local committed, created = fixture.committed, #fixture.created
fixture.yields, guards = 0, 0
local result, buildId = run("scene.build", forest())
check(fixture.committed == committed + 1, "exactly one ChangeHistory recording")
check(fixture.yields == math.floor((2 + 200 * 8) / Operations.SLICE_CHECK) and guards >= fixture.yields, "detached construction yields every slice and re-guards after each yield")
check(result.created.count == 1 + 1 + 200 * 8 and result.mutation.after.count == result.created.count, "receipt counts root, group and 200 x (model + 7 parts)")
check(result.created.classes.Model == 202 and result.created.classes.Part == 200 * 6 and result.created.classes.WedgePart == 200, "class histogram")
check(#fixture.created - created == result.created.count, "allocations match the receipt exactly")
check(result.mutation.kind == "scene.build" and result.mutation.before == V.NULL, "creation receipt")
check(#workspace:GetChildren() == baseline + 1, "one new root under Workspace")
local root = ops.registry:resolve(result.ref)
check(root.Name == "Forest" and root.Parent == workspace, "root parented once")
local trees = root:GetChildren()[1]
check(trees.Name == "Trees" and #trees:GetChildren() == 200, "200 tree models in the keyed group")
check(ops.registry:resolve(result.refs.Trees) == trees, "keyed group ref resolves")
local first = trees:GetChildren()[1]
check(#first:GetChildren() == 7 and first.PrimaryPart == first:GetChildren()[1], "each tree is a Model with PrimaryPart")
local trunk = first:GetChildren()[1]
check(math.abs(trunk.Position.X - (first.PrimaryPart.Position.X)) < 1e-9, "primary part is the trunk")
-- yaw 90 rotates the relative offset (2,0,0) to (0,0,-2); Orientation Y gains the yaw.
local at = {${args.items[1].at.join(", ")}}
check(math.abs(trunk.Position.X - at[1]) < 1e-3 and math.abs(trunk.Position.Z - (at[3] - 2)) < 1e-3 and math.abs(trunk.Position.Y - 2.5) < 1e-6, "placement rotates relative offsets")
check(math.abs(first:GetChildren()[3].Orientation.Y - 90) < 1e-4, "orientation yaw composes")
local grounded = ops.registry:resolve(result.refs.Grounded)
check(math.abs(grounded:GetChildren()[1].Position.Y - (3 + 2.5 * ${args.items[2].scale})) < 1e-3, "ground placement snaps to the surface")
check(not first:GetChildren()[3].CanCollide and first:GetChildren()[1].Anchored, "foliage non-colliding, all anchored")

-- 2. Restore removes the whole unchanged build in one recording; changed builds are refused.
local restored = run("scene.restore", {receiptCommandId = buildId, mutation = result.mutation})
check(restored.restored and root.Parent == nil and #workspace:GetChildren() == baseline, "restore removes the build")
local again, againId = run("scene.build", forest())
local againRoot = ops.registry:resolve(again.ref)
againRoot:GetChildren()[1]:GetChildren()[5]:GetChildren()[4].Color = Color3.new(1, 0, 0)
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = againId, mutation = again.mutation}) end)
check(againRoot.Parent == workspace, "conflicting restore leaves the build")

-- 3. Atomic rollback: a failure deep in the batch leaves the place untouched.
local before, cancelled, commits = #workspace:GetChildren(), fixture.cancelled, fixture.committed
fixture.allocations, fixture.failAllocationAt = 0, 1500
local mark = #fixture.created
local okFailure, failure = pcall(function() return run("scene.build", forest()) end)
check(not okFailure and type(failure) == "string" and string.find(failure, "injected allocation failure", 1, true) ~= nil, "mid-batch engine failure surfaces")
fixture.failAllocationAt = nil
check(#workspace:GetChildren() == before, "nothing parented after a mid-batch failure")
check(fixture.cancelled == cancelled and fixture.committed == commits, "construction fails before any undo recording opens")
local orphans = 0
for index = mark + 1, #fixture.created do if fixture.created[index]:IsDescendantOf(workspace) then orphans += 1 end end
check(orphans == 0, "no partial instance reached Workspace")
check(fixture.allocations >= 1500, "failure happened deep in the batch")
local leaked = 0
for index = mark + 1, #fixture.created do if not fixture.created[index]._destroyed then leaked += 1 end end
check(leaked == 0, "every detached allocation destroyed")

-- 3b. A lease lost while yielded between slices: nothing parented, nothing recorded, all destroyed.
mark, cancelled, commits = #fixture.created, fixture.cancelled, fixture.committed
fixture.yields, fixture.failAfterYields = 0, 10
refuses("LEASE", function() return run("scene.build", forest()) end)
fixture.failAfterYields = nil
leaked = 0
for index = mark + 1, #fixture.created do if not fixture.created[index]._destroyed then leaked += 1 end end
check(#workspace:GetChildren() == before and leaked == 0 and #fixture.created - mark >= 10 * Operations.SLICE_CHECK, "lease lost mid-construction destroys the detached tree")
check(fixture.cancelled == cancelled and fixture.committed == commits, "lease lost mid-construction records nothing")

-- 3c. ChangeHistory refusing the recording after construction: detached tree destroyed, nothing parented.
mark = #fixture.created
fixture.failBegin = true
refuses("HISTORY", function() return run("scene.build", forest()) end)
fixture.failBegin = nil
leaked = 0
for index = mark + 1, #fixture.created do if not fixture.created[index]._destroyed then leaked += 1 end end
check(#workspace:GetChildren() == before and leaked == 0, "refused recording destroys the detached tree")

-- 4. Verification failure (engine coercion) is also atomic.
local bad = forest()
fixture.orientationReadback = Vector3.new(0, 0, 0)
refuses("VERIFY", function() return run("scene.build", bad) end)
fixture.orientationReadback = nil
check(#workspace:GetChildren() == before, "verification failure parents nothing")

-- 5. Bounds are enforced before any allocation.
local huge = forest()
for _ = 1, 400 do table.insert(huge.items, huge.items[2]) end
local allocations = #fixture.created
refuses("BODY_LIMIT", function() return run("scene.build", huge) end)
check(#fixture.created == allocations, "over-limit build allocates nothing")
local evil = forest(); evil.items[2].kind = "script"
refuses("INPUT", function() return run("scene.build", evil) end)
local source = forest(); source.prototypes[1].parts[1].properties.Source = "print(1)"
refuses("PROPERTY", function() return run("scene.build", source) end)

-- 6. Environment: verified lighting, created atmosphere and bounded terrain in one recording.
commits = fixture.committed
local env = run("environment.apply", V.decode(${JSON.stringify(JSON.stringify({
  terrain: [{ shape: 'Block', material: 'Grass', center: [0, -2, 0], size: [600, 4, 600] }, { shape: 'Ball', material: 'LeafyGrass', center: [80, -30, 40], radius: 40 },
    { shape: 'Cylinder', material: 'Pebble', center: [0, 0, 60], radius: 4, height: 2, orientation: [0, 0, 90] }, { shape: 'Wedge', material: 'Ground', center: [20, 2, 0], size: [10, 4, 10] }],
  lighting: { ClockTime: 15, Ambient: [0.27, 0.29, 0.3] }, atmosphere: { Density: 0.3, Haze: 2 } }))}, http))
check(fixture.committed == commits + 1 and #fills == 4 and fills[1][1] == "FillBlock" and fills[2][1] == "FillBall" and fills[3][1] == "FillCylinder" and fills[4][1] == "FillWedge", "terrain fills in order")
check(fills[1][4] == Enum.Material.Grass and fills[2][4] == Enum.Material.LeafyGrass, "terrain materials")
check(lighting.ClockTime == 15 and env.mutation.before.lighting.ClockTime == 14, "lighting applied with prior value in receipt")
local atmosphere = nil
for _, child in ipairs(lighting:GetChildren()) do if child.ClassName == "Atmosphere" then atmosphere = child end end
check(atmosphere and math.abs(atmosphere.Density - 0.3) < 1e-6 and env.mutation.before.atmosphere == "created", "atmosphere created under Lighting")
fixture.coerce = {ClockTime = 3}
local fillCount = #fills
refuses("VERIFY", function() return run("environment.apply", {lighting = {ClockTime = 16, Brightness = 2}, terrain = V.array({{shape = "Ball", material = "Grass", center = V.array({0, 0, 0}), radius = 5}})}) end)
fixture.coerce = nil
check(#fills == fillCount and lighting.Brightness == 1, "lighting failure reverts and never writes terrain")
refuses("INPUT", function() return run("environment.apply", {terrain = V.array({{shape = "Ball", material = "Grass", center = V.array({0, 0, 0}), radius = 5000}})}) end)
refuses("PROPERTY", function() return run("environment.apply", {terrain = V.array({{shape = "Ball", material = "Plastic", center = V.array({0, 0, 0}), radius = 5}})}) end)
print("Arcane scene build checks passed: " .. checks)
`;

test('scene build sources compile with the official Luau compiler', { skip: !compile }, async () => {
  const result = spawnSync(compile, ['--null', path.join(repository, 'plugin/src/Operations.luau')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('real Luau: a 200-tree forest builds in one atomic command with exact counts, receipt, restore and rollback; environment op is bounded', { skip: !runtime }, async () => {
  await runLuau(checks(forestArgs(200)), /Arcane scene build checks passed: \d+/);
});
