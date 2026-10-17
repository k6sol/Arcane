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

// Engine doubles owned by this harness. They model the documented value types (Vector2, NumberRange,
// NumberSequence, ColorSequence), typed enums, Attachment-only Beam/Trail links, Studio refusing a
// plugin write (fixture.refuse) and engine coercion (fixture.coerceEffect). They do not certify Roblox.
const engineFixture = `
local function f32(value: number): number
  local scratch = buffer.create(4)
  buffer.writef32(scratch, 0, value)
  return buffer.readf32(scratch, 0)
end
local function typed(kind: string, value: any): any rawset(value, "_type", kind); return value end
Vector3 = {new = function(x: number, y: number, z: number): any return typed("Vector3", triple(x, y, z)) end}
Color3 = {new = function(r: number, g: number, b: number): any return typed("Color3", triple(r, g, b)) end}
local Vector2: any = {new = function(x: number, y: number): any
  return setmetatable({X = f32(x), Y = f32(y), _type = "Vector2"}, {__eq = function(a: any, b: any): boolean return a.X == b.X and a.Y == b.Y end})
end}
local NumberRange: any = {new = function(low: number, high: number): any
  assert(low <= high, "NumberRange: invalid range")
  return {Min = f32(low), Max = f32(high), _type = "NumberRange"}
end}
local NumberSequenceKeypoint: any = {new = function(t: number, v: number, e: number?): any return {Time = f32(t), Value = f32(v), Envelope = f32(e or 0)} end}
local ColorSequenceKeypoint: any = {new = function(t: number, c: any): any return {Time = f32(t), Value = c} end}
local function sequence(kind: string, points: {any}): any
  assert(#points >= 2 and points[1].Time == 0 and points[#points].Time == 1, kind .. ": keypoints must span 0..1")
  return {Keypoints = points, _type = kind}
end
local NumberSequence: any = {new = function(points: {any}): any return sequence("NumberSequence", points) end}
local ColorSequence: any = {new = function(points: {any}): any return sequence("ColorSequence", points) end}
local function typeof(value: any): string
  if type(value) == "table" and value._enumItem == true then return "EnumItem" end
  if type(value) == "table" and type(rawget(value, "_type")) == "string" then return rawget(value, "_type") end
  return nativeTypeof(value)
end
Enum.NormalId = enumCategory({"Right", "Top", "Back", "Left", "Bottom", "Front"})
Enum.ParticleOrientation = enumCategory({"FacingCamera", "FacingCameraWorldUp", "VelocityParallel", "VelocityPerpendicular"})
Enum.ParticleEmitterShape = enumCategory({"Box", "Sphere", "Cylinder", "Disc"})
Enum.ParticleEmitterShapeStyle = enumCategory({"Volume", "Surface"})
Enum.ParticleEmitterShapeInOut = enumCategory({"Outward", "Inward", "InAndOut"})
Enum.TextureMode = enumCategory({"Stretch", "Wrap", "Static"})
Enum.HighlightDepthMode = enumCategory({"AlwaysOnTop", "Occluded"})
Enum.Technology = enumCategory({"Legacy", "Voxel", "Compatibility", "ShadowMap", "Future"})
local function rotation(o: any): {number}
  local x, y, z = math.rad(o.X), math.rad(o.Y), math.rad(o.Z)
  local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
  return {cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
end
local CFrame: any = {}
function CFrame.new(x: number, y: number, z: number, ...: number): any
  local r = {...}
  if #r == 0 then r = {1, 0, 0, 0, 1, 0, 0, 0, 1} end
  return {GetComponents = function(_self: any): ...number return x, y, z, table.unpack(r) end}
end
local effectClasses = {"Attachment", "ParticleEmitter", "Beam", "Trail", "PointLight", "SpotLight", "SurfaceLight", "Highlight", "Fire", "Smoke", "Sparkles", "Decal", "Texture", "MaterialVariant"}
local engineIndex = instanceMetatable.__index
instanceMetatable.__index = function(self: any, key: string): any
  if key == "CFrame" and table.find(basePartClasses, rawget(self, "_properties").ClassName) then
    local p = self.Position
    return CFrame.new(p.X, p.Y, p.Z, table.unpack(rotation(self.Orientation)))
  end
  if key == "WorldPosition" and rawget(self, "_properties").ClassName == "Attachment" then
    local host, offset = self.Parent.Position, self.Position
    return Vector3.new(host.X + offset.X, host.Y + offset.Y, host.Z + offset.Z)
  end
  if key == "GetBoundingBox" and rawget(self, "_properties").ClassName == "Model" then
    return function(model: any): (any, any)
      local low, high = {math.huge, math.huge, math.huge}, {-math.huge, -math.huge, -math.huge}
      for _, part in ipairs(model:GetChildren()) do
        if part:IsA("BasePart") then
          local c, s = {part.Position.X, part.Position.Y, part.Position.Z}, {part.Size.X, part.Size.Y, part.Size.Z}
          for axis = 1, 3 do low[axis] = math.min(low[axis], c[axis] - s[axis] / 2); high[axis] = math.max(high[axis], c[axis] + s[axis] / 2) end
        end
      end
      if low[1] == math.huge then error("Model has no parts") end
      return CFrame.new((low[1] + high[1]) / 2, (low[2] + high[2]) / 2, (low[3] + high[3]) / 2), Vector3.new(high[1] - low[1], high[2] - low[2], high[3] - low[3])
    end
  end
  return engineIndex(self, key)
end
local engineSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if string.sub(key, 1, 1) == "_" then rawset(self, key, value); return end
  local className = rawget(self, "_properties").ClassName
  if fixture.refuse and fixture.refuse[className .. "." .. key] then error("The current thread cannot set '" .. key .. "' (lacking capability Plugin)") end
  if (key == "Attachment0" or key == "Attachment1") and value ~= nil and value.ClassName ~= "Attachment" then error("Attachment expected") end
  if fixture.coerceEffect and fixture.coerceEffect[key] ~= nil and table.find(effectClasses, className) then value = fixture.coerceEffect[key] end
  if className == "Attachment" and key == "Orientation" then
    -- The engine stores a normalized equivalent; verification must compare rotations, not triples.
    local function wrap(angle: number): number return (angle + 180) % 360 - 180 end
    value = Vector3.new(wrap(value.X), wrap(value.Y), wrap(value.Z))
  end
  if table.find(effectClasses, className) and (key == "Orientation" or key == "Shape" or key == "Material") then
    fixture.writes += 1
    rawget(self, "_properties")[key] = value
    return
  end
  engineSetter(self, key, value)
end
`;

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-effects-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'effects.luau');
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
    assert.ok(path.basename(directory).startsWith('arcane-effects-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const json = value => JSON.stringify(JSON.stringify(value));
const c3 = value => ({ type: 'Color3', value }), v3 = value => ({ type: 'Vector3', value });
const emitter = {
  Rate: 40, Lifetime: { type: 'NumberRange', value: [1, 2.5] }, Speed: { type: 'NumberRange', value: [2, 6] }, SpreadAngle: { type: 'Vector2', value: [15, 15] },
  Size: { type: 'NumberSequence', value: [[0, 0.4], [0.5, 1.2, 0.2], [1, 0]] }, Transparency: { type: 'NumberSequence', value: [[0, 0.2], [1, 1]] },
  Color: { type: 'ColorSequence', value: [[0, 1, 0.8, 0.3], [1, 1, 0.2, 0.05]] }, Orientation: 'VelocityParallel', EmissionDirection: 'Top',
  Acceleration: v3([0, 4, 0]), LightEmission: 1, Texture: 'rbxasset://textures/particles/sparkles_main.dds', Enabled: true,
};
/** Wire-form build: a part with two attachments, a Beam and Trail bound to them, plus lights and particles. */
const effectBuild = {
  parent: '__PARENT__', container: { className: 'Model', name: 'Torch' }, prototypes: [],
  items: [
    { kind: 'part', className: 'Part', name: 'Post', parent: 0, key: 'Post', properties: { Size: v3([1, 6, 1]), Position: v3([10, 3, -4]), Anchored: true } },
    { kind: 'effect', className: 'Attachment', name: 'Top', parent: 1, key: 'Top', properties: { Position: v3([0, 3, 0]), Orientation: v3([0, 270, 0]) } },
    { kind: 'effect', className: 'Attachment', name: 'Base', parent: 1, properties: { Position: v3([0, -3, 0]) } },
    { kind: 'effect', className: 'Beam', name: 'Glow', parent: 1, key: 'Glow', properties: { Attachment0: { type: 'Ref', item: 2 }, Attachment1: { type: 'Ref', item: 3 },
      Color: { type: 'ColorSequence', value: [[0, 0.3, 0.7, 1], [1, 0.9, 0.95, 1]] }, Width0: 0.5, Width1: 0.2, Segments: 12, FaceCamera: true, TextureMode: 'Wrap', Texture: 'rbxassetid://1234567' } },
    { kind: 'effect', className: 'Trail', name: 'Wake', parent: 0, properties: { Attachment0: { type: 'Ref', item: 2 }, Attachment1: { type: 'Ref', item: 3 }, Lifetime: 0.6,
      WidthScale: { type: 'NumberSequence', value: [[0, 1], [1, 0]] } } },
    { kind: 'effect', className: 'ParticleEmitter', name: 'Embers', parent: 2, properties: emitter },
    { kind: 'effect', className: 'PointLight', name: 'Light', parent: 2, properties: { Brightness: 2, Range: 14, Color: c3([1, 0.7, 0.4]), Shadows: true } },
    { kind: 'effect', className: 'Fire', name: 'Flame', parent: 1, properties: { Size: 4, Heat: 9, Color: c3([1, 0.5, 0.1]), SecondaryColor: c3([0.6, 0.1, 0]) } },
    { kind: 'effect', className: 'Decal', name: 'Sign', parent: 1, properties: { Texture: 'rbxassetid://987654321', Face: 'Front', Transparency: 0.1 } },
    { kind: 'effect', className: 'Highlight', name: 'Outline', parent: 0, properties: { FillColor: c3([1, 0.9, 0.5]), DepthMode: 'Occluded', FillTransparency: 0.7 } },
  ],
};

const checks = `
local V = Validation
local checks, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local workspace = game:GetService("Workspace")
local lighting = game:GetService("Lighting")
lighting._properties.Technology = Enum.Technology.ShadowMap
lighting._properties.ClockTime = 14
local terrain = Instance.new("Terrain"); terrain.Parent = workspace
terrain._properties.Decoration = false
local materialService = game:GetService("MaterialService")
local overrides = {}
materialService._properties.GetBaseMaterialOverride = function(_self: any, material: any): string return overrides[material.Name] or "" end
materialService._properties.SetBaseMaterialOverride = function(_self: any, material: any, name: string): () overrides[material.Name] = name end
local ops = Operations.new({sessionId = "effects-session", allowedRoots = {"Workspace", "Lighting"}}, game, http)
local function run(method: string, args: any): (any, string)
  serial += 1
  local id = "fx-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function refuses(code: string, callback: () -> any, text: string?): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
  if text then check(string.find(err.message, text, 1, true) ~= nil, "message names: " .. text .. " / " .. err.message) end
  return err
end
local function near(a: number, b: number): boolean return math.abs(a - b) < 1e-4 end
local host = Instance.new("Part"); host.Name = "Host"; host.Parent = workspace
host.Position = Vector3.new(0, 5, 0); host.Size = Vector3.new(4, 2, 6)
local hostRef = ops.registry:ref(host)
local function create(className: string, properties: any, parent: any?): any
  return run("scene.create", {parent = parent or hostRef, className = className, name = className, properties = properties})
end

-- 1. scene.create ParticleEmitter: sequences, ranges, enums and a built-in texture assigned and read back.
local emitterArgs = V.decode(${json(emitter)}, http)
local committed = fixture.committed
local created = create("ParticleEmitter", emitterArgs)
check(fixture.committed == committed + 1 and created.mutation.kind == "scene.create" and created.mutation.before == V.NULL, "one recording, create receipt")
local fx = ops.registry:resolve(created.ref)
check(fx.Parent == host and fx.ClassName == "ParticleEmitter", "emitter parented to the part")
check(typeof(fx.Size) == "NumberSequence" and #fx.Size.Keypoints == 3 and near(fx.Size.Keypoints[2].Value, 1.2) and near(fx.Size.Keypoints[2].Envelope, 0.2), "NumberSequence with envelope")
check(typeof(fx.Color) == "ColorSequence" and near(fx.Color.Keypoints[2].Value.G, 0.2), "ColorSequence")
check(near(fx.Lifetime.Min, 1) and near(fx.Lifetime.Max, 2.5) and near(fx.SpreadAngle.X, 15), "NumberRange and Vector2")
check(fx.Orientation == Enum.ParticleOrientation.VelocityParallel and fx.EmissionDirection == Enum.NormalId.Top, "typed enums")
check(fx.Texture == "rbxasset://textures/particles/sparkles_main.dds" and fx.Rate == 40, "content id and number")

-- 2. Content ids: only numeric rbxassetid or built-in rbxasset://textures. Nothing is allocated on refusal.
local allocations = #fixture.created
for _, bad in ipairs({"http://example.com/a.png", "https://www.roblox.com/asset/?id=1", "rbxassetid://abc", "rbxassetid://0123", "rbxasset://textures/../../x.png",
  "rbxasset://fonts/arial.ttf", "rbxasset://textures/a.exe", "rbxthumb://type=Asset&id=1", "rbxassetid://1 ", "rbxassetid://12345678901234567890"}) do
  refuses("PROPERTY", function() return create("Decal", {Texture = bad}) end)
end
check(#fixture.created == allocations, "rejected content ids allocate nothing")
refuses("PROPERTY", function() return run("environment.apply", {materials = V.decode(${json([{ name: 'Bad', baseMaterial: 'Slate', ColorMap: 'http://x/y.png' }])}, http)}) end)

-- 3. Sequence, enum and allowlist bounds.
refuses("PROPERTY", function() return create("ParticleEmitter", V.decode(${json({ Size: { type: 'NumberSequence', value: [[0.1, 1], [1, 1]] } })}, http)) end, "rise from 0 to 1")
refuses("INPUT", function() return create("ParticleEmitter", V.decode(${json({ Transparency: { type: 'NumberSequence', value: [[0, 2], [1, 0]] } })}, http)) end, "Transparency")
refuses("INPUT", function() return create("ParticleEmitter", V.decode(${json({ Size: { type: 'NumberSequence', value: Array.from({ length: 21 }, (_, i) => [i / 20, 1]) } })}, http)) end)
refuses("PROPERTY", function() return create("ParticleEmitter", {Orientation = "Sideways"}) end)
refuses("PROPERTY", function() return create("ParticleEmitter", {Parent = workspace}) end)
refuses("PROPERTY", function() return create("Beam", {Source = "print(1)"}) end)
refuses("CLASS", function() return run("scene.create", {parent = ops.registry:ref(workspace), className = "Attachment", name = "Loose", properties = {}}) end)
check(#fixture.created == allocations, "invalid effect payloads allocate nothing")

-- 4. Engine coercion is a clean VERIFY failure and the detached instance never reaches the place.
fixture.coerceEffect = {Rate = 7}
local children = #host:GetChildren()
refuses("VERIFY", function() return create("ParticleEmitter", {Rate = 40}) end)
fixture.coerceEffect = nil
check(#host:GetChildren() == children, "coerced effect is not parented")

-- 5. Attachment references in scene.create resolve through the Registry and must be Attachments.
local a0 = ops.registry:resolve(create("Attachment", V.decode(${json({ Position: v3([0, 1, 0]), Orientation: v3([0, -360, 270]) })}, http)).ref)
local a1 = ops.registry:resolve(create("Attachment", V.decode(${json({ Position: v3([0, -1, 0]) })}, http)).ref)
check(near(a0.Orientation.Z, -90), "engine-normalized Attachment orientation verified as the same rotation")
local beam = ops.registry:resolve(create("Beam", {Attachment0 = {type = "Ref", ref = ops.registry:ref(a0)}, Attachment1 = {type = "Ref", ref = ops.registry:ref(a1)}, Width0 = 1}).ref)
check(beam.Attachment0 == a0 and beam.Attachment1 == a1, "Beam binds the referenced Attachments")
refuses("PROPERTY", function() return create("Beam", {Attachment0 = {type = "Ref", ref = hostRef}}) end)

-- 6. scene.build: effects, attachments and Ref items in one atomic hierarchy.
local function build(): any
  local args = V.decode(${json(effectBuild)}, http)
  args.parent = ops.registry:ref(workspace)
  return args
end
committed = fixture.committed
local built, buildId = run("scene.build", build())
check(fixture.committed == committed + 1 and built.created.count == 11, "one recording for root + 10 items")
check(built.created.classes.Attachment == 2 and built.created.classes.Beam == 1 and built.created.classes.ParticleEmitter == 1, "class histogram includes effects")
local root = ops.registry:resolve(built.ref)
local post = ops.registry:resolve(built.refs.Post)
local top = ops.registry:resolve(built.refs.Top)
local glow = ops.registry:resolve(built.refs.Glow)
check(root.Parent == workspace and post.Parent == root and top.Parent == post, "hierarchy parented once")
check(glow.Attachment0 == top and glow.Attachment1 ~= nil and glow.Attachment1.Name == "Base" and glow.Attachment1.Parent == post, "Beam Ref items bind attachments of this build")
check(glow.Segments == 12 and glow.TextureMode == Enum.TextureMode.Wrap and glow.Texture == "rbxassetid://1234567", "Beam values verified")
local trail
for _, child in ipairs(root:GetChildren()) do if child.ClassName == "Trail" then trail = child end end
check(trail and trail.Attachment0 == top, "Trail under the root binds the same attachment")
local embers = top:GetChildren()[1]
check(embers.ClassName == "ParticleEmitter" and near(embers.Size.Keypoints[3].Value, 0) and top:GetChildren()[2].ClassName == "PointLight", "particles and light inside the Attachment")
local bounds = run("scene.inspect", {ref = built.refs.Post, bounds = true}).bounds
check(near(bounds.center[1], 10) and near(bounds.center[2], 3) and near(bounds.size[2], 6), "part bounds")
local modelBounds = run("scene.inspect", {ref = built.ref, bounds = true}).bounds
check(near(modelBounds.size[1], 1) and near(modelBounds.center[3], -4), "model bounds")
local attachmentBounds = run("scene.inspect", {ref = built.refs.Top, bounds = true}).bounds
check(near(attachmentBounds.center[2], 6) and near(attachmentBounds.size[1], 1), "attachment bounds")
check(run("scene.inspect", {ref = built.ref}).bounds == nil, "bounds only on request")
local folder = Instance.new("Folder"); folder.Parent = workspace
refuses("BOUNDS", function() return run("scene.inspect", {ref = ops.registry:ref(folder), bounds = true}) end)
local restored = run("scene.restore", {receiptCommandId = buildId, mutation = built.mutation})
check(restored.restored and root.Parent == nil, "restore removes the unchanged effects build")

-- 7. Build refusals happen before any allocation.
allocations = #fixture.created
local forward = build(); forward.items[4].properties.Attachment1 = {type = "Ref", item = 5}
refuses("INPUT", function() return run("scene.build", forward) end)
local notAttachment = build(); notAttachment.items[4].properties.Attachment0 = {type = "Ref", item = 1}
refuses("INPUT", function() return run("scene.build", notAttachment) end, "earlier Attachment")
local looseAttachment = build(); looseAttachment.items[2].parent = 0
refuses("INPUT", function() return run("scene.build", looseAttachment) end)
local badTexture = build(); badTexture.items[9].properties.Texture = "https://example.com/x.png"
refuses("PROPERTY", function() return run("scene.build", badTexture) end)
check(#fixture.created == allocations, "refused builds allocate nothing")
fixture.coerceEffect = {Heat = 1}
local before = #workspace:GetChildren()
refuses("VERIFY", function() return run("scene.build", build()) end, "Fire.Heat")
fixture.coerceEffect = nil
check(#workspace:GetChildren() == before, "a coerced effect leaves the place untouched")

-- 8. Environment extras: technology, decoration and material variants in one recording with a receipt.
committed = fixture.committed
local env = run("environment.apply", V.decode(${json({ technology: 'Future', terrainDecoration: true, lighting: { ClockTime: 17 },
  materials: [{ name: 'Mossy Slate', baseMaterial: 'Slate', studsPerTile: 8, override: true, ColorMap: 'rbxassetid://555', NormalMap: 'rbxasset://textures/terrain/slate_normal.png' }] })}, http))
check(fixture.committed == committed + 1, "one recording")
check(lighting.Technology == Enum.Technology.Future and terrain.Decoration == true and lighting.ClockTime == 17, "technology, decoration and lighting applied")
check(env.mutation.before.technology == "ShadowMap" and env.mutation.after.technology == "Future" and env.mutation.before.terrainDecoration == false, "receipt records prior studio settings")
local variant = materialService:GetChildren()[1]
check(variant and variant.ClassName == "MaterialVariant" and variant.Name == "Mossy Slate" and variant.BaseMaterial == Enum.Material.Slate and variant.ColorMap == "rbxassetid://555" and variant.StudsPerTile == 8, "variant created")
check(overrides.Slate == "Mossy Slate" and env.mutation.after.materials[1] == "Mossy Slate", "base material override set")
refuses("CONFLICT", function() return run("environment.apply", V.decode(${json({ materials: [{ name: 'Mossy Slate', baseMaterial: 'Slate' }] })}, http)) end)

-- 9. Studio refusing a plugin write rolls everything back and names the Properties-window step.
lighting._properties.Technology = Enum.Technology.ShadowMap
fixture.refuse = {["Lighting.Technology"] = true}
refuses("STUDIO_SETTING", function() return run("environment.apply", V.decode(${json({ lighting: { ClockTime: 9 }, technology: 'Future' })}, http)) end, "set Technology to Future in the Properties window")
check(lighting.ClockTime == 17 and lighting.Technology == Enum.Technology.ShadowMap, "lighting rolled back; technology untouched")
fixture.refuse = {["MaterialVariant.ColorMap"] = true}
local variants = #materialService:GetChildren()
refuses("STUDIO_SETTING", function() return run("environment.apply", V.decode(${json({ terrainDecoration: false, materials: [{ name: 'Wet Rock', baseMaterial: 'Rock', override: true, ColorMap: 'rbxassetid://9' }] })}, http)) end, "MaterialVariant.ColorMap")
check(#materialService:GetChildren() == variants and terrain.Decoration == true and overrides.Rock == nil, "variant destroyed, decoration and overrides reverted")
fixture.refuse = nil
refuses("PROPERTY", function() return run("environment.apply", {technology = "Raytraced"}) end)
print("Arcane effects checks passed: " .. checks)
`;

test('effects sources compile with the official Luau compiler', { skip: !compile }, async () => {
  for (const name of ['Properties', 'Operations']) {
    const result = spawnSync(compile, ['--null', path.join(repository, `plugin/src/${name}.luau`)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau: effects classes with sequences, Attachment refs, content-id refusal, environment extras and framing bounds', { skip: !runtime }, async () => {
  await runLuau(checks, /Arcane effects checks passed: \d+/);
});
