import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Keep this mesh, plugin side (AssetPlacement.keep through the real AssetUpload uploader). Engine doubles only:
// no Studio, no AssetService, no Roblox upload. Doubles do not certify native behaviour (docs/build/MESH_KEEP.md).
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const modules = ['Validation', 'Registry', 'Properties', 'AssetUpload', 'AssetPlacement'];

const checks = `
local V = Validation
local count = 0
local function check(condition: boolean, label: string): () assert(condition, label); count += 1 end
local function refuses(code: string, callback: () -> any): ()
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "refuses " .. code .. " (got " .. tostring(type(err) == "table" and err.code or err) .. ")")
end
-- Enum doubles in the shape AssetUpload checks (EnumItem typeof, exact EnumType, "Enum.<family>" name).
local function category(family: string, names: {string}): any
  local result = setmetatable({}, {__tostring = function() return "Enum." .. family end})
  for _, name in ipairs(names) do result[name] = table.freeze({Name = name, EnumType = result, _enumItem = true}) end
  return result
end
local enums = {AssetType = category("AssetType", {"Mesh", "Image"}), AssetCreatorType = category("AssetCreatorType", {"User", "Group"}),
  CreateAssetResult = category("CreateAssetResult", {"Success", "UploadLimitExceeded"})}
local function editable(): any return {ClassName = "EditableMesh", IsA = function(_self: any, name: string): boolean return name == "EditableMesh" end} end

local function setup(meshCount: number): any
  local s: any = {uploads = {}, parts = 0, freshParts = {}, commits = 0, userId = 78, nextId = 9000, rejectAt = nil, throwAt = nil, partFails = false}
  local folder = Instance.new("Folder")
  local model = Instance.new("Model"); model.Parent = folder
  local owner: any = {meshes = {}, placed = model, retired = false}
  for index = 1, meshCount do
    local part = Instance.new("MeshPart"); part.Name = "SM_oak_" .. index; part.Material = Enum.Material.Wood; part.Anchored = true; part.Parent = model
    owner.meshes[index] = {mesh = editable(), disposed = false, part = part, object = {name = "SM_oak_" .. index, meshExportSha256 = string.rep(tostring(index), 64)}}
  end
  local service = {}
  function service:CreateAssetAsync(resource: any, assetType: any, parameters: any): (any, any)
    table.insert(s.uploads, {resource = resource, assetType = assetType, parameters = parameters})
    if s.throwAt == #s.uploads then error("engine detail") end
    if s.rejectAt == #s.uploads then return enums.CreateAssetResult.UploadLimitExceeded, "Upload limit exceeded" end
    s.nextId += 1
    return enums.CreateAssetResult.Success, s.nextId
  end
  function service:CreateMeshPartAsync(content: any, options: any): any
    if s.partFails then error("asset not ready") end
    s.parts += 1
    local part = Instance.new("MeshPart"); part._properties.MeshContent = content; part._properties.Options = options
    table.insert(s.freshParts, part)
    return part
  end
  s.engine = {service = service, AssetUpload = AssetUpload, enums = enums,
    content = function(id: number): any return {uri = "rbxassetid://" .. id} end,
    userId = function(): number return s.userId end}
  s.ops = {registry = {sessionId = "11111111-2222-4333-8444-555555555555", owned = {},
      ref = function(_self: any, instance: any): any return {instanceId = if instance == model then "model" else "other"} end},
    gameModel = {PlaceId = 12, GameId = 34},
    history = {TryBeginRecording = function(): any return "recording" end, FinishRecording = function(_self: any, _r: any, operation: any): () if operation == "Commit" then s.commits += 1 end end}}
  s.owner, s.model = owner, model
  return s
end
local serial = 0
local function args(changes: any?): any
  serial += 1
  local value: any = {source = "editable-" .. string.rep("cd", 32), attemptId = string.format("00000000-0000-4000-8000-%012d", serial), name = "Old oak", description = "Kept",
    creatorId = 78, continuity = {clientLifetimeId = "client-1", pluginArtifactHash = string.rep("a", 64), playEpoch = 0}, finish = false}
  for key, item in pairs(changes or {}) do value[key] = item end
  return value
end
local guardCalls = 0
local function guard(): () guardCalls += 1 end
local digest = string.rep("cd", 32)

-- Opaque image Content values are shared resources, not image copies or uploaded image IDs.
-- The double clones a SurfaceAppearance instance while retaining those exact Content references.
local function scalarMaterial(s: any): any
  local metal, rough = Instance.new("EditableImage"), Instance.new("EditableImage")
  local maps = {MetalnessMapContent = {Object = metal}, RoughnessMapContent = {Object = rough}}
  local template = Instance.new("SurfaceAppearance")
  s.cloneCalls = 0
  local function clone(self: any): any
    s.cloneCalls += 1
    if s.failCloneAt == s.cloneCalls then error("injected appearance clone failure") end
    local copy = Instance.new("SurfaceAppearance")
    copy.MetalnessMapContent, copy.RoughnessMapContent = self.MetalnessMapContent, self.RoughnessMapContent
    copy.Clone = clone
    return copy
  end
  template.MetalnessMapContent, template.RoughnessMapContent, template.Clone = maps.MetalnessMapContent, maps.RoughnessMapContent, clone
  local material = {surfaceAppearance = template, editableImages = {MetalnessMap = metal, RoughnessMap = rough}}
  s.owner.materials = {scalar = material}
  s.model.GetDescendants = function(self: any): {any}
    local result = {}
    local function visit(instance: any): ()
      for _, child in ipairs(instance:GetChildren()) do table.insert(result, child); visit(child) end
    end
    visit(self)
    return result
  end
  for index, resource in ipairs(s.owner.meshes) do
    resource.part.DoubleSided = index % 2 == 1
    resource.appearance = template:Clone(); resource.appearance.Parent = resource.part
  end
  s.ops.registry.owned[s.model] = {parent = s.model.Parent, placed = {count = #s.model:GetDescendants()}}
  return material
end

-- 1. Both meshes upload to the confirmed user and every session part is swapped in one recording.
local s = setup(2)
local oldParts = {s.owner.meshes[1].part, s.owner.meshes[2].part}
local receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "kept" and receipt.persistence == "saved-asset" and receipt.swapped == 2 and receipt.uploadsStarted == 2, "kept")
check(#s.uploads == 2 and s.uploads[1].assetType == enums.AssetType.Mesh and s.uploads[1].parameters.CreatorId == 78
  and s.uploads[1].parameters.CreatorType == enums.AssetCreatorType.User and s.uploads[1].parameters.Name == "Old oak 1" and s.uploads[2].parameters.Name == "Old oak 2", "user-owned mesh uploads with numbered names")
check(s.uploads[1].resource == s.owner.meshes[1].mesh, "the retained EditableMesh itself is uploaded")
check(receipt.meshes[1].assetId == 9001 and receipt.meshes[2].assetId == 9002 and receipt.meshes[1].upload == "succeeded" and receipt.meshes[1].reason == V.NULL, "IDs recorded")
check(oldParts[1].Parent == nil and oldParts[2].Parent == nil and s.owner.meshes[1].part.Parent == s.model and s.owner.meshes[1].part.MeshContent.uri == "rbxassetid://9001", "persistent parts replace session parts")
check(s.owner.meshes[1].part.Name == "SM_oak_1" and s.owner.meshes[1].part.Material == Enum.Material.Wood and s.owner.meshes[1].part.Anchored == true, "part properties carried over")
check(s.commits == 1 and receipt.ref.instanceId == "model" and receipt.creatorId == 78, "one undo recording")
-- Finishing an already-kept model reuses IDs, uploads nothing and creates no new part.
local again = AssetPlacement.keep(s.ops, s.owner, digest, args({finish = true, assetIds = V.array({9001, 9002})}), guard, s.engine)
check(again.state == "kept" and #s.uploads == 2 and s.parts == 2 and again.meshes[1].upload == "reused" and again.uploadsStarted == 0, "finish is idempotent and never uploads")

-- 2. Account changed since the confirmation: nothing is uploaded.
s = setup(1); s.userId = 79
refuses("ACCOUNT", function() return AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine) end)
check(#s.uploads == 0, "no upload for another account")
-- Removed placement and released meshes refuse before any upload.
s = setup(1); s.model.Parent = nil
refuses("STATE", function() return AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine) end)
s = setup(1); s.owner.meshes[1].disposed = true
refuses("STATE", function() return AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine) end)
check(#s.uploads == 0, "nothing uploaded for released meshes")
refuses("INPUT", function() return AssetPlacement.keep(s.ops, s.owner, digest, args({assetIds = V.array({1})}), guard, s.engine) end)
refuses("INPUT", function() return AssetPlacement.keep(s.ops, s.owner, digest, args({name = string.rep("x", 51)}), guard, s.engine) end)

-- 3. Roblox rejects the second upload (quota): partial, the engine's own reason is kept, nothing is swapped or retried.
s = setup(3); s.rejectAt = 2
receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "partial" and receipt.swapped == 0 and #s.uploads == 2, "partial upload stops")
check(receipt.meshes[1].assetId == 9001 and receipt.meshes[2].upload == "failed" and receipt.meshes[2].reason == "ENGINE_REJECTED:UploadLimitExceeded", "quota reason recorded")
check(receipt.meshes[3].upload == "skipped" and receipt.meshes[3].reason == "STOPPED" and receipt.persistence == "studio-session-only", "later meshes skipped")
check(s.owner.meshes[1].part.Parent == s.model and s.parts == 0, "session parts untouched after a partial upload")

-- 4. Uploaded but Studio cannot load the new mesh yet: IDs kept, session parts stay; Finish keeping later swaps without uploading.
s = setup(2); s.partFails = true
receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "uploaded" and receipt.swapped == 0 and receipt.meshes[2].assetId == 9002 and s.commits == 0, "uploaded, swap pending")
s.partFails = false
local finished = AssetPlacement.keep(s.ops, s.owner, digest, args({finish = true, assetIds = V.array({9001, 9002})}), guard, s.engine)
check(finished.state == "kept" and #s.uploads == 2 and finished.uploadsStarted == 0 and s.parts == 2, "finish swaps without uploading")
refuses("SCOPE", function() return AssetPlacement.keep(s.ops, s.owner, digest, args({finish = true, assetIds = V.array({9001})}), guard, s.engine) end)

-- 5. The engine call throws: the outcome is unknown (reconciliation), never retried.
s = setup(2); s.throwAt = 1
receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "failed" and receipt.meshes[1].upload == "reconciliation" and receipt.meshes[1].reason == "ENGINE_OUTCOME_UNKNOWN" and receipt.uploadsStarted == 1 and #s.uploads == 1, "unknown outcome is reported, not retried")
-- The same attempt ID can never upload twice (AssetUpload latch).
s = setup(1)
local fixed = args()
AssetPlacement.keep(s.ops, s.owner, digest, fixed, guard, s.engine)
s.owner.meshes[1].keptAssetId = nil
receipt = AssetPlacement.keep(s.ops, s.owner, digest, fixed, guard, s.engine)
check(#s.uploads == 1 and receipt.meshes[1].upload == "failed" and receipt.meshes[1].reason == "ATTEMPT", "a replayed attempt never reaches the engine")

-- 6. The capability probe fails closed on a Studio without the upload API.
check(AssetPlacement.keepSupported(game) == false, "probe fails closed")
check(AssetPlacement.keepSupported({GetService = function(): any return {CreateAssetAsync = function() end} end}) == false, "partial API is not enough")

-- 7. Keeping changes geometry IDs while retaining scalar PBR resource ownership in this session.
s = setup(2)
local material = scalarMaterial(s)
local materialOwner, placedOwner = s.owner.materials, s.ops.registry.owned[s.model]
local originals = {s.owner.meshes[1].appearance, s.owner.meshes[2].appearance}
local originalParts = {s.owner.meshes[1].part, s.owner.meshes[2].part}
receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "kept" and #s.uploads == 2 and s.cloneCalls == 4, "only geometry uploads and one appearance clone per replacement")
check(s.owner.materials == materialOwner and s.owner.materials.scalar == material and s.ops.registry.owned[s.model] == placedOwner, "material and placement ownership maps remain exact")
check(placedOwner.placed.count == #s.model:GetDescendants() and placedOwner.placed.count == 4, "placement ownership counts follow appearance clones")
for index, resource in ipairs(s.owner.meshes) do
  check(s.uploads[index].assetType == enums.AssetType.Mesh and s.uploads[index].resource == resource.mesh, "no EditableImage is uploaded")
  check(resource.part.DoubleSided == (index % 2 == 1), "true and false DoubleSided survive geometry replacement")
  check(resource.appearance ~= originals[index] and resource.appearance:IsA("SurfaceAppearance") and resource.appearance.Parent == resource.part, "replacement owns a distinct appearance clone")
  check(resource.appearance.MetalnessMapContent == material.surfaceAppearance.MetalnessMapContent
    and resource.appearance.RoughnessMapContent == material.surfaceAppearance.RoughnessMapContent, "cloned appearance retains exact editable image Content")
  check(originals[index].Parent == originalParts[index] and originalParts[index].Parent == nil, "original appearance is not moved or destroyed")
end
check(not material.surfaceAppearance._destroyed and not material.editableImages.MetalnessMap._destroyed and not material.editableImages.RoughnessMap._destroyed, "template and backing images stay alive")
local clonesBeforeFinish = s.cloneCalls
AssetPlacement.keep(s.ops, s.owner, digest, args({finish = true, assetIds = V.array({9001, 9002})}), guard, s.engine)
check(#s.uploads == 2 and s.cloneCalls == clonesBeforeFinish, "finish neither uploads maps nor replaces retained appearances")

-- 8. A failed appearance clone leaves the original ownership intact and retires the detached replacement.
s = setup(1); material = scalarMaterial(s)
local oldPart, oldAppearance = s.owner.meshes[1].part, s.owner.meshes[1].appearance
materialOwner, placedOwner = s.owner.materials, s.ops.registry.owned[s.model]
s.failCloneAt = s.cloneCalls + 1
receipt = AssetPlacement.keep(s.ops, s.owner, digest, args(), guard, s.engine)
check(receipt.state == "uploaded" and receipt.swapped == 0 and receipt.meshes[1].assetId == 9001, "failed clone retains uploaded geometry ID without claiming a swap")
check(s.owner.meshes[1].part == oldPart and s.owner.meshes[1].appearance == oldAppearance and oldAppearance.Parent == oldPart and oldPart.Parent == s.model, "failed clone preserves source part and appearance")
check(s.owner.materials == materialOwner and s.ops.registry.owned[s.model] == placedOwner and placedOwner.placed.count == 2, "failed clone preserves owner records")
check(#s.uploads == 1 and s.uploads[1].assetType == enums.AssetType.Mesh and not material.editableImages.MetalnessMap._destroyed and not material.editableImages.RoughnessMap._destroyed, "failed clone never uploads or disposes backing images")
check(#s.freshParts == 1 and s.freshParts[1]._destroyed and s.freshParts[1].Parent == nil, "failed clone destroys unused replacement part")
print("Arcane mesh keep checks passed: " .. count)
`;

test('mesh keep sources compile with the official Luau compiler', { skip: !compile }, async () => {
  for (const name of ['AssetPlacement', 'Operations', 'Transport', 'Validation']) {
    const result = spawnSync(compile, ['--null', path.join(repository, `plugin/src/${name}.luau`)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `${name}\n${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau: Keep this mesh uploads to the confirmed user, keeps every ID, swaps only complete uploads and never retries', { skip: !runtime }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-mesh-keep-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    const harness = path.join(directory, 'mesh-keep.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Arcane mesh keep checks passed: \d+/);
  } finally {
    assert.ok(path.basename(directory).startsWith('arcane-mesh-keep-'));
    await rm(directory, { recursive: true, force: true });
  }
});
