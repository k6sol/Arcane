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
const modules = ['Validation', 'Registry', 'Properties', 'AssetPlacement', 'AssetMaterials','Operations'];

// Engine doubles owned by this harness (not native proof): translation+yaw CFrames, axis-aligned
// Model bounding boxes, ScaleTo about the pivot, PivotTo, Clone, GetDescendants, FindFirstChild,
// Workspace.DescendantAdded and a Raycast that reports ground at y = 3.
const engineFixture = `
local CFrame: any = {}
local cframeMeta: any = {}
cframeMeta.__index = cframeMeta
function CFrame.new(x: number?, y: number?, z: number?): any return setmetatable({x = x or 0, y = y or 0, z = z or 0, yaw = 0}, cframeMeta) end
function CFrame.Angles(_x: number, y: number, _z: number): any return setmetatable({x = 0, y = 0, z = 0, yaw = y}, cframeMeta) end
cframeMeta.__mul = function(a: any, b: any): any return setmetatable({x = a.x + b.x, y = a.y + b.y, z = a.z + b.z, yaw = a.yaw + b.yaw}, cframeMeta) end
function cframeMeta:GetComponents(): ...number
  local c, s = math.cos(self.yaw), math.sin(self.yaw)
  return self.x, self.y, self.z, c, 0, s, 0, 1, 0, -s, 0, c
end
local added: {any} = {}
local function descendants(root: any, out: {any}): {any}
  for _, child in ipairs(root._children) do table.insert(out, child); descendants(child, out) end
  return out
end
function methods:GetDescendants(): {any} return descendants(self, {}) end
function methods:FindFirstChild(name: string, recursive: boolean?): any
  for _, child in ipairs(if recursive then self:GetDescendants() else self:GetChildren()) do if child.Name == name then return child end end
  return nil
end
function methods:Clone(): any
  local copy = Instance.new(self.ClassName)
  for key, value in pairs(self._properties) do if key ~= "Parent" then copy._properties[key] = value end end
  for _, child in ipairs(self._children) do child:Clone().Parent = copy end
  return copy
end
local function parts(model: any): {any}
  local list = {}
  for _, item in ipairs(model:GetDescendants()) do if item:IsA("BasePart") then table.insert(list, item) end end
  return list
end
function methods:GetBoundingBox(): (any, any)
  local low, high = {math.huge, math.huge, math.huge}, {-math.huge, -math.huge, -math.huge}
  for _, part in ipairs(parts(self)) do
    local p, s = part.Position, part.Size
    for axis, key in ipairs({"X", "Y", "Z"}) do
      low[axis] = math.min(low[axis], p[key] - s[key] / 2); high[axis] = math.max(high[axis], p[key] + s[key] / 2)
    end
  end
  return CFrame.new((low[1] + high[1]) / 2, (low[2] + high[2]) / 2, (low[3] + high[3]) / 2), Vector3.new(high[1] - low[1], high[2] - low[2], high[3] - low[3])
end
local function pivotOf(model: any): any
  if model._properties.WorldPivot then return model._properties.WorldPivot end
  return (model:GetBoundingBox())
end
function methods:GetScale(): number return self._properties.ModelScale or 1 end
function methods:ScaleTo(scale: number): ()
  local factor, pivot = scale / self:GetScale(), pivotOf(self)
  for _, part in ipairs(parts(self)) do
    part.Size = Vector3.new(part.Size.X * factor, part.Size.Y * factor, part.Size.Z * factor)
    part.Position = Vector3.new(pivot.x + (part.Position.X - pivot.x) * factor, pivot.y + (part.Position.Y - pivot.y) * factor, pivot.z + (part.Position.Z - pivot.z) * factor)
  end
  self._properties.ModelScale = scale
end
function methods:PivotTo(target: any): ()
  if self:IsA("BasePart") then self.Position = Vector3.new(target.x, target.y + self.Size.Y / 2, target.z); return end
  local pivot = pivotOf(self)
  for _, part in ipairs(parts(self)) do
    part.Position = Vector3.new(part.Position.X + target.x - pivot.x, part.Position.Y + target.y - pivot.y, part.Position.Z + target.z - pivot.z)
  end
  self._properties.WorldPivot = target
end
local engineSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  engineSetter(self, key, value)
  if key == "Parent" and value and fixture.workspace and (value == fixture.workspace or (value ~= game and value:IsDescendantOf(fixture.workspace))) then
    for _, listener in ipairs(added) do listener(self) end
    for _, item in ipairs(self:GetDescendants()) do for _, listener in ipairs(added) do listener(item) end end
  end
end
local engineNew = Instance.new
Instance.new = function(className: string): any
  local instance = engineNew(className)
  if instance:IsA("BasePart") then instance._properties.MaterialVariant = "" end
  return instance
end
fixture.signal = {Connect = function(_self: any, callback: any): any
  table.insert(added, callback)
  return {Disconnect = function() local index = table.find(added, callback); if index then table.remove(added, index) end end}
end}
fixture.listeners = added
`;

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-asset-placement-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'asset-placement.luau');
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
    assert.ok(path.basename(directory).startsWith('arcane-asset-placement-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const checks = `
local V = Validation
fixture.encode = function(data: any): string return V.encode(data, http) end
local count, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); count += 1 end
local workspace = game:GetService("Workspace")
fixture.workspace = workspace
workspace._properties.DescendantAdded = fixture.signal
local groundY = 3
workspace._properties.Raycast = function(_self: any, origin: any, direction: any): any
  check(direction.Y < 0, "ground probe casts downward")
  return {Position = Vector3.new(origin.X, groundY, origin.Z)}
end
local storage = game:GetService("ServerStorage")
local templates = Instance.new("Folder"); templates.Name = "Templates"; templates.Parent = storage
local ops = Operations.new({sessionId = "asset-session", allowedRoots = {"Workspace", "ServerStorage"}}, game, http)
local function run(method: string, args: any): (any, string)
  serial += 1
  local id = "asset-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function refuses(code: string, callback: () -> any): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. (if type(err) == "table" then tostring(err.code) .. " " .. V.safeError(err) else tostring(err)))
  return err
end
local function part(name: string, position: any, size: any, parent: any): any
  local p = Instance.new("Part"); p.Name = name; p.Position = position; p.Size = size; p.Parent = parent; return p
end
-- A natively inserted free model: trunk + crown at an arbitrary spot, carrying hostile scripts.
local function insertTree(name: string): any
  local model = Instance.new("Model"); model.Name = name
  part("Trunk", Vector3.new(100, 50, 100), Vector3.new(2, 16, 2), model)
  part("Crown", Vector3.new(100, 60, 100), Vector3.new(8, 4, 8), model)
  local virus = Instance.new("Script"); virus.Name = "Spread"; virus.Parent = model
  local nested = Instance.new("ModuleScript"); nested.Name = "Payload"; nested.Parent = model:GetChildren()[1]
  local localScript = Instance.new("LocalScript"); localScript.Name = "Ui"; localScript.Parent = model:GetChildren()[2]
  model.Parent = workspace
  return model
end
local function placeArgs(watch: string, overrides: any?): any
  local args: any = {watch = watch, parent = ops.registry:ref(templates), name = "PineTemplate", maxSize = V.array({10, 10, 10}),
    position = V.array({20, 40, -5}), yaw = 0, ground = true, anchor = true, allowScripts = false}
  for key, value in pairs(overrides or {}) do args[key] = value end
  return args
end

-- 1. Pure math: rotated extents swap axes, fit picks the tightest axis, bottom centre.
local extents = AssetPlacement.worldExtents({0, 0, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0}, Vector3.new(2, 3, 8))
check(math.abs(extents[1] - 8) < 1e-9 and math.abs(extents[2] - 3) < 1e-9 and math.abs(extents[3] - 2) < 1e-9, "90-degree yaw swaps x/z extents")
check(math.abs(AssetPlacement.fitScale({4, 20, 4}, {10, 10, 10}) - 0.5) < 1e-9, "fit uses the tightest axis")
check(AssetPlacement.fitScale({4, 20, 4}, nil) == 1, "no maxSize keeps scale")
refuses("ASSET", function() return AssetPlacement.fitScale({0.001, 0.001, 0.001}, {2048, 2048, 2048}) end)
local bottom = AssetPlacement.bottomCenter({5, 10, 7}, {2, 6, 2})
check(bottom[1] == 5 and bottom[2] == 7 and bottom[3] == 7, "bottom centre sits half the height below the box centre")

-- 2. Watch + adoption: name match wins over an unrelated user edit; scripts stripped; fitted, grounded, parented.
local watch = run("scene.asset_watch", {})
check(type(watch.watch) == "string" and watch.expiresInSeconds == 600, "watch token issued")
part("UserEdit", Vector3.new(0, 1, 0), Vector3.new(1, 1, 1), workspace)
local tree = insertTree("ArcaneAsset_" .. watch.watch)
local commits = fixture.committed
local placed, placeId = run("scene.place_asset", placeArgs(watch.watch, {expectName = "ArcaneAsset_" .. watch.watch}))
check(fixture.committed == commits + 1, "one undo recording")
local root = ops.registry:resolve(placed.ref)
check(root == tree and root.Name == "PineTemplate" and root.Parent == templates, "exact inserted model adopted and parented")
check(placed.removedScripts.count == 3 and placed.removedScripts.classes.Script == 1 and placed.removedScripts.classes.LocalScript == 1 and placed.removedScripts.classes.ModuleScript == 1, "every script class removed and reported")
check(table.find(placed.removedScripts.names, "Spread") ~= nil and table.find(placed.removedScripts.names, "Payload") ~= nil, "removed script names reported")
local scriptsLeft = 0
for _, item in ipairs(root:GetDescendants()) do if item:IsA("LuaSourceContainer") then scriptsLeft += 1 end end
check(scriptsLeft == 0 and placed.keptScripts == 0, "scripts nested under parts removed; nothing kept")
check(math.abs(placed.scale - 0.5) < 1e-4, "fit scales the 20-stud tree into the 10-stud box")
local _, size = root:GetBoundingBox()
check(math.abs(size.Y - 10) < 1e-3 and math.abs(size.X - 4) < 1e-3, "scaled extents match the fit")
local box = root:GetBoundingBox()
check(math.abs((box.y - size.Y / 2) - groundY) < 1e-3 and math.abs(box.x - 20) < 1e-3 and math.abs(box.z + 5) < 1e-3, "bottom centre grounded at the requested x/z")
check(placed.grounded == true and root:GetChildren()[1].Anchored and root:GetChildren()[2].Anchored, "grounded and anchored")
check(placed.mutation.kind == "scene.place_asset" and placed.mutation.before == V.NULL and placed.mutation.after.descendants == 2 and placed.mutation.after.removedScripts == 3, "receipt")
check(ops.assetWatches[watch.watch] == nil and #fixture.listeners == 0, "watch released after adoption")

-- 3. Clone templates in scene.build: full copies, scaled about the bottom pivot, grounded.
local buildArgs = {parent = ops.registry:ref(workspace), container = {className = "Model", name = "Forest"}, prototypes = V.array({}),
  templates = V.array({ops.registry:ref(root)}), items = V.array({
    {kind = "clone", template = 1, name = "Pine", parent = 0, at = V.array({0, 0, 0}), yaw = 0, scale = 1, ground = true, key = "First"},
    {kind = "clone", template = 1, name = "Pine", parent = 0, at = V.array({30, 0, 12}), yaw = 45, scale = 2},
    {kind = "clone", template = 1, name = "Pine", parent = 0, at = V.array({-30, 0, 12}), yaw = 90, scale = 0.5}})}
local built, buildId = run("scene.build", buildArgs)
local forest = ops.registry:resolve(built.ref)
check(#forest:GetChildren() == 3 and built.created.count == 1 + 3 + 3 * 2 and built.mutation.after.count == built.created.count, "receipt counts root, clones and their copied parts")
local first = ops.registry:resolve(built.refs.First)
local firstBox, firstSize = first:GetBoundingBox()
check(math.abs((firstBox.y - firstSize.Y / 2) - groundY) < 1e-3 and math.abs(firstBox.x) < 1e-3, "clone grounded on its bottom pivot")
local _, bigSize = forest:GetChildren()[2]:GetBoundingBox()
check(math.abs(bigSize.Y - 20) < 1e-3, "clone scale doubles the template")
check(root.Parent == templates and #root:GetDescendants() == 2, "template untouched")
local restoredBuild = run("scene.restore", {receiptCommandId = buildId, mutation = built.mutation})
check(restoredBuild.restored and forest.Parent == nil, "restore removes the cloned build")
local dirty = Instance.new("Script"); dirty.Parent = root
refuses("SCRIPT", function() return run("scene.build", buildArgs) end)
dirty:Destroy()

-- 4. Restore removes an unchanged placement; a moved placement is refused.
local restored = run("scene.restore", {receiptCommandId = placeId, mutation = placed.mutation})
check(restored.restored and root.Parent == nil, "restore removes the adopted asset")
local again = run("scene.asset_watch", {})
insertTree("ArcaneAsset_" .. again.watch)
local unfitted = placeArgs(again.watch, {expectName = "ArcaneAsset_" .. again.watch, allowScripts = true, ground = false, name = "KeptScripts"})
unfitted.maxSize = nil
local second, secondId = run("scene.place_asset", unfitted)
check(second.keptScripts == 3 and second.removedScripts.count == 0 and second.grounded == false and second.scale == 1, "allowScripts keeps and reports scripts")
for _, item in ipairs(ops.registry:resolve(second.ref):GetDescendants()) do
  if item:IsA("BaseScript") then check(item.Disabled == true, "kept scripts land disabled") end
end
local secondRoot = ops.registry:resolve(second.ref)
secondRoot:PivotTo(CFrame.new(1, 2, 3))
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = secondId, mutation = second.mutation}) end)
check(secondRoot.Parent == templates, "conflicting restore keeps the asset")

-- 5. Never adopt on ambiguity or absence.
local ambiguous = run("scene.asset_watch", {})
insertTree("Unnamed1"); insertTree("Unnamed2")
refuses("AMBIGUOUS", function() return run("scene.place_asset", placeArgs(ambiguous.watch)) end)
local waits = 0
task.wait = function(_seconds: number) waits += 1 end
local empty = run("scene.asset_watch", {})
local before = fixture.committed
refuses("NOT_FOUND", function() return run("scene.place_asset", placeArgs(empty.watch)) end)
check(waits == 40 and fixture.committed == before, "bounded 10 s arrival wait; nothing recorded")
refuses("WATCH", function() return run("scene.place_asset", placeArgs("unknown-watch")) end)
local scriptOnly = run("scene.asset_watch", {})
local folder = Instance.new("Folder"); folder.Name = "OnlyScripts"
local lone = Instance.new("Script"); lone.Parent = folder
folder.Parent = workspace
refuses("ASSET", function() return run("scene.place_asset", placeArgs(scriptOnly.watch)) end)
check(folder.Parent == workspace and lone.Parent == nil, "refused insert stays for inspection but its scripts are removed")
-- A script dropped next to the asset (outside it) is never left behind enabled.
local sibling = run("scene.asset_watch", {})
local siblingTree = insertTree("ArcaneAsset_" .. sibling.watch)
local loose = Instance.new("Script"); loose.Name = "Loose"; loose.Parent = workspace
refuses("AMBIGUOUS", function() return run("scene.place_asset", placeArgs(sibling.watch, {expectName = "ArcaneAsset_" .. sibling.watch})) end)
check(loose.Parent == nil and siblingTree.Parent == workspace, "sibling script removed; nothing adopted")
for _, item in ipairs(siblingTree:GetDescendants()) do check(not item:IsA("LuaSourceContainer"), "refused asset scripts removed") end
-- Package links are stripped on adoption (an auto-updating package could restore scripts).
local packaged = run("scene.asset_watch", {})
local packagedTree = insertTree("ArcaneAsset_" .. packaged.watch)
local link = Instance.new("PackageLink"); link.Parent = packagedTree
local adopted = run("scene.place_asset", placeArgs(packaged.watch, {expectName = "ArcaneAsset_" .. packaged.watch, name = "Packaged"}))
check(link.Parent == nil and adopted.removedScripts.count == 3, "package link stripped")
-- A clone copy is re-checked at instantiation, so a script added after planning never lands.
local tampered = Instance.new("Model"); part("Body", Vector3.new(0, 1, 0), Vector3.new(1, 1, 1), tampered)
local late = Instance.new("Script"); late.Parent = tampered
refuses("SCRIPT", function() return AssetPlacement.instantiate({clone = tampered, scale = 1, at = {0, 0, 0}, yaw = 0}) end)

-- 6. Generated MaterialVariant applied with a receipt and restored.
local service = game:GetService("MaterialService")
local variant = Instance.new("MaterialVariant"); variant.Name = "Arcane_MossyStone_ab12"; variant.BaseMaterial = Enum.Material.Slate; variant.Parent = service
local wall = part("Wall", Vector3.new(0, 5, 0), Vector3.new(10, 10, 1), workspace)
local applied, appliedId = run("scene.apply_material", {refs = V.array({ops.registry:ref(wall)}), material = "Slate", variant = "Arcane_MossyStone_ab12"})
check(wall.Material == Enum.Material.Slate and wall.MaterialVariant == "Arcane_MossyStone_ab12" and applied.applied == 1, "variant applied")
check(applied.mutation.before.items[1].Material == "Plastic" and applied.mutation.after.variant == "Arcane_MossyStone_ab12", "material receipt records the baseline")
local reverted = run("scene.restore", {receiptCommandId = appliedId, mutation = applied.mutation})
check(reverted.restored and wall.Material == Enum.Material.Plastic and wall.MaterialVariant == "", "material restore reverts")
refuses("MATERIAL", function() return run("scene.apply_material", {refs = V.array({ops.registry:ref(wall)}), material = "Slate", variant = "Missing_Variant"}) end)
refuses("MATERIAL", function() return run("scene.apply_material", {refs = V.array({ops.registry:ref(wall)}), material = "Brick", variant = "Arcane_MossyStone_ab12"}) end)
-- 7. editable-<digest>: the retained procedural reconstruction is materialized detached, then adopted.
local digest = string.rep("ab", 32)
local materialized, released = 0, 0
local function procedural(): any
  local model = Instance.new("Model")
  part("SM_oak_bark", Vector3.new(0, 18, 0), Vector3.new(4, 36, 4), model)
  part("SM_oak_leaves", Vector3.new(0, 30, 0), Vector3.new(30, 20, 30), model)
  return model
end
ops.materializeReconstruction = function(_self: any, source: string, _guard: any): (any, () -> ())
  check(source == digest, "plugin receives only the transfer digest")
  materialized += 1
  return procedural(), function() released += 1 end
end
local editableCommits = fixture.committed
local oak = run("scene.place_asset", placeArgs("editable-" .. digest, {name = "OakTemplate", maxSize = V.array({20, 20, 20})}))
local oakRoot = ops.registry:resolve(oak.ref)
check(materialized == 1 and released == 1 and fixture.committed == editableCommits + 1, "materialized once, one undo recording, placement confirmed")
check(oakRoot.Name == "OakTemplate" and oakRoot.Parent == templates and oak.mutation.kind == "scene.place_asset" and oak.mutation.after.descendants == 2, "detached model adopted with a receipt")
local _, oakSize = oakRoot:GetBoundingBox()
check(math.abs(oakSize.Y - 20) < 1e-3, "fit applies to materialized meshes")
local restoredOak = run("scene.restore", {receiptCommandId = "asset-" .. serial, mutation = oak.mutation})
check(restoredOak.restored and oakRoot.Parent == nil, "procedural placement restores like any adoption")
local leaked: any = nil
ops.materializeReconstruction = function(_self: any, _source: string, _guard: any): (any, () -> ())
  leaked = Instance.new("Model") -- no BaseParts: adoption refuses before any parenting
  return leaked, function() released += 1 end
end
refuses("ASSET", function() return run("scene.place_asset", placeArgs("editable-" .. digest)) end)
check(leaked ~= nil and leaked.Parent == nil and released == 1, "failed adoption never confirms placement and leaves nothing parented")
refuses("WATCH", function() return run("scene.place_asset", placeArgs("editable-XYZ")) end)
print("Arcane asset placement checks passed: " .. count)
`;

test('asset placement sources compile with the official Luau compiler', { skip: !compile }, async () => {
  const result = spawnSync(compile, ['--null', path.join(repository, 'plugin/src/AssetPlacement.luau')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('real Luau: native inserts are adopted only when unambiguous, stripped of scripts, fitted, grounded, cloned and restorable', { skip: !runtime }, async () => {
  await runLuau(checks, /Arcane asset placement checks passed: \d+/);
});
