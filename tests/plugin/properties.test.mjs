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

// Keep fixture changes inside the owned test harness. The native probe supplied
// for this regression establishes float32 Color3 and RGB8 BasePart.Color storage.
const colorEngineFixture = `
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
-- Independent Y-X-Z rotation double, including the nine float32 matrix cells.
local CFrame: any = {}
function CFrame.fromOrientation(x: number, y: number, z: number): any
  local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
  local components = {0, 0, 0, cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
  for index = 4, 12 do components[index] = colorFloat32(components[index]) end
  return {GetComponents = function(_self: any): ...number return table.unpack(components) end}
end
local colorOriginalIndex = instanceMetatable.__index
instanceMetatable.__index = function(self: any, key: string): any
  if key == "CFrame" and self:IsA("BasePart") then
    return CFrame.fromOrientation(math.rad(self.Orientation.X), math.rad(self.Orientation.Y), math.rad(self.Orientation.Z))
  end
  return colorOriginalIndex(self, key)
end
local colorOriginalSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if key == "Color" and self:IsA("BasePart") then
    value = storedColor(value)
    if fixture.corruptColorChannel then
      local bytes = {math.round(value.R * 255), math.round(value.G * 255), math.round(value.B * 255)}
      bytes[fixture.corruptColorChannel] += 1
      value = Color3.fromRGB(bytes[1], bytes[2], bytes[3])
    end
  end
  if key == "Orientation" and self:IsA("BasePart") and fixture.orientationReadback then value = fixture.orientationReadback end
  if key == "Parent" and value ~= nil and self:IsA("BasePart") then fixture.colorParentings = (fixture.colorParentings or 0) + 1 end
  colorOriginalSetter(self, key, value)
end
local colorOriginalNew = Instance.new
Instance.new = function(className: string): any
  local instance = colorOriginalNew(className)
  if instance:IsA("BasePart") then instance._properties.Color = storedColor(instance.Color) end
  return instance
end
`;

async function runPropertyFixture(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-property-fixture-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z][A-Za-z0-9_]*)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, colorEngineFixture);
    const harness = path.join(directory, 'properties.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.ifError(compiled.error);
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, marker);
    process.stdout.write(result.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-property-fixture-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('geometry property sources and scoped fixture compile with the official Luau compiler', { skip: !compile }, async () => {
  for (const filename of [...modules.map(name => `plugin/src/${name}.luau`), 'plugin/fixtures/MockEngine.luau', 'plugin/fixtures/Properties.spec.luau']) {
    const result = spawnSync(compile, ['--null', path.join(repository, filename)], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${filename}\n${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau proves geometry mutation, enum validation, exact receipts and restoration against explicit doubles', { skip: !runtime }, async () => {
  await runPropertyFixture(await readFile(path.join(repository, 'plugin/fixtures/Properties.spec.luau'), 'utf8'), /Arcane property checks passed: \d+/);
});

const regressionFixture = `
local V, P = Validation, Validation.geometryProperties(Properties)
fixture.encode = function(data: any): string return V.encode(data, http) end
local checks, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local function refuses(code: string, callback: () -> any): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
  return err
end
local function fresh(): any
  fixture.historyHook, fixture.failProperty, fixture.corruptColorChannel, fixture.orientationReadback = nil, nil, nil, nil
  fixture.colorParentings = 0
  local workspace = game:GetService("Workspace")
  for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
  return Operations.new({sessionId = "assignment-regression", allowedRoots = {"Workspace"}}, game, http)
end
local function run(ops: any, method: string, args: any): (any, string)
  serial += 1
  local id = "assignment-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function taggedColor(values: {number}): any return {type = "Color3", value = V.array(table.clone(values))} end
local function vector(x: number, y: number, z: number): any return {type = "Vector3", value = V.array({x, y, z})} end
local function create(ops: any, properties: any, className: string?): (any, string)
  return run(ops, "scene.create", {parent = ops.registry:ref(game:GetService("Workspace")), className = className or "Part", name = "AssignmentRegression", properties = properties})
end
local function restore(ops: any, id: string, result: any): any
  return run(ops, "scene.restore", {receiptCommandId = id, mutation = result.mutation})
end
local function exactColor(tag: any, expected: {number}, label: string): ()
  check(tag.type == "Color3" and #tag.value == 3, label .. " tag")
  for index = 1, 3 do check(tag.value[index] == expected[index], label .. " channel " .. index) end
end
local regressionInput = {0.15, 0.45, 0.8}
local regressionStored = {0.14901961386203766, 0.4470588266849518, 0.800000011920929}
local function oneByteChange(instance: any, channel: number): ()
  local bytes = {math.round(instance.Color.R * 255), math.round(instance.Color.G * 255), math.round(instance.Color.B * 255)}
  bytes[channel] += 1
  instance.Color = Color3.fromRGB(bytes[1], bytes[2], bytes[3])
end
`;

// Independent JS float32 oracle plus fixed native-probe anchors. Every RGB8 byte
// is exercised in every channel, alongside nonrepresentable decimal colours and
// inputs which cross a byte boundary when Color3 first rounds them to float32.
const colorPalette = [
  [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [0.15, 0.45, 0.8], [0.2, 0.4, 0.6], [0.1, 0.5, 0.9],
  [0.001, 0.003, 0.999], [0.123456789, 0.987654321, 0.31415926],
  [0.2 - 1e-10, 0.4 - 1e-10, 0.8 - 1e-10],
  [1 / 255 - 1e-10, 128 / 255 - 1e-8, 254 / 255 - 1e-8],
  [0.49999997, 0.50000003, 0.99999997], [0.25, 0.75, 0.125],
  ...Array.from({ length: 256 }, (_, byte) => [byte / 255, (255 - byte) / 255, ((byte * 73) % 256) / 255]),
].map(input => {
  const decoded = input.map(Math.fround);
  const bytes = decoded.map(channel => Math.floor(Math.fround(channel * 255)));
  return { input, decoded, bytes, stored: bytes.map(byte => Math.fround(byte / 255)) };
});
const luauNumbers = values => '{' + values.join(', ') + '}';

test('RGB8 palette round-trips create, inspection, update and restore with exact stored channels', { skip: !runtime }, async () => {
  assert.deepEqual(colorPalette[5].bytes, [38, 114, 204]);
  assert.deepEqual(colorPalette[5].stored, [0.14901961386203766, 0.4470588266849518, 0.800000011920929]);
  assert.deepEqual(colorPalette[6].bytes, [51, 102, 153]);
  assert.deepEqual(colorPalette[10].bytes, [51, 102, 204]);
  const palette = colorPalette.map(item => `{input = ${luauNumbers(item.input)}, decoded = ${luauNumbers(item.decoded)}, stored = ${luauNumbers(item.stored)}}`).join(',\n');
  await runPropertyFixture(regressionFixture + `
local palette = {${palette}}
for _, className in ipairs({"Part", "WedgePart", "SpawnLocation"}) do
  for index, case in ipairs(palette) do
    local ops = fresh()
    local input = taggedColor(case.input)
    local decoded = P.decode("Color", input, true, true)
    check(decoded.R == case.decoded[1] and decoded.G == case.decoded[2] and decoded.B == case.decoded[3], "Color3 first stores float32 channels")
    local created, createId = create(ops, {Color = input, Size = vector(1.2, 3.4, 5.6), Position = vector(0.1, -0.2, 0.3),
      Anchored = true, CanCollide = false, Transparency = 0.25, Material = "SmoothPlastic"}, className)
    local instance = ops.registry:resolve(created.ref)
    exactColor(P.snapshot(instance, {"Color"}).Color, case.stored, "actual " .. className .. " palette " .. index)
    exactColor(created.mutation.after.properties.Color, case.stored, "created receipt")
    check(Properties.assignedMatches(instance, "Color", decoded) and P.assignedMatches(instance, "Color", decoded), "both post-write codecs accept exact engine RGB8 storage")
    check(P.compare(instance, {Color = taggedColor(case.stored)}, {"Color"}), "canonical snapshot is a strict baseline")
    local inspected = run(ops, "scene.inspect", {ref = created.ref})
    check(V.equal(inspected.properties, created.mutation.after.properties), "inspect and create receipt are actual full snapshots")
    check(instance.Size == Vector3.new(1.2, 3.4, 5.6) and instance.Position == Vector3.new(0.1, -0.2, 0.3), "vector float32 property round-trip stays exact")
    check(instance.Anchored and not instance.CanCollide and instance.Transparency == 0.25 and instance.Material == Enum.Material.SmoothPlastic, "other property round-trips stay exact")
    local wire = V.decode(V.encode(inspected.properties, http), http)
    exactColor(wire.Color, case.stored, "wire snapshot")
    check(P.compare(instance, {Color = wire.Color}, {"Color"}), "JSON snapshot remains an exact float32 baseline")
    local nextCase = palette[index % #palette + 1]
    local updated, updateId = run(ops, "scene.update", {ref = created.ref, expected = {Color = wire.Color}, properties = {Color = taggedColor(nextCase.input)}})
    exactColor(updated.mutation.before.properties.Color, case.stored, "update before")
    exactColor(updated.mutation.after.properties.Color, nextCase.stored, "update after")
    check(V.equal(P.snapshot(instance, {"Color"}), updated.mutation.after.properties), "update after is actual canonical storage")
    check(P.compare(instance, updated.mutation.after.properties, {"Color"}), "restore expected-after is exact canonical storage")
    check(restore(ops, updateId, updated).restored, "colour update restores using canonical expected-after")
    exactColor(P.snapshot(instance, {"Color"}).Color, case.stored, "restored before")
    check(restore(ops, createId, created).restored and instance._destroyed and instance.Parent == nil, "original unchanged creation restores after colour round-trip")
  end
end
print("Arcane RGB8 palette checks passed: " .. checks .. " (" .. #palette .. " colours, three classes)")
`, /Arcane RGB8 palette checks passed: \d+ \(270 colours, three classes\)/);
});

test('colour baselines stay strict for requested decimals, one-byte edits and pre-write races', { skip: !runtime }, async () => {
  await runPropertyFixture(regressionFixture + `
for channel = 1, 3 do
  local ops = fresh()
  local created = create(ops, {Color = taggedColor(regressionInput)})
  local instance = ops.registry:resolve(created.ref)
  local actual = P.snapshot(instance, {"Color"})
  check(Properties.assignedMatches(instance, "Color", Properties.decode("Color", taggedColor(regressionInput), true)), "post-write accepts canonical colour")
  check(not Properties.compare(instance, {Color = taggedColor(regressionInput)}, {"Color"}) and not P.compare(instance, {Color = taggedColor(regressionInput)}, {"Color"}), "CAS cannot canonicalize requested decimals")
  local near = table.clone(regressionStored); near[channel] += 0.000001
  check(P.assignedMatches(instance, "Color", P.decode("Color", taggedColor(near), true, true)), "nearby request has the same RGB8 output")
  check(not Properties.compare(instance, {Color = taggedColor(near)}, {"Color"}) and not P.compare(instance, {Color = taggedColor(near)}, {"Color"}), "same-byte but different float32 baseline still conflicts")
  local writes, committed, cancelled = fixture.writes, fixture.committed, fixture.cancelled
  refuses("CONFLICT", function() run(ops, "scene.update", {ref = created.ref, expected = {Color = taggedColor(near)}, properties = {Color = taggedColor({0.2, 0.4, 0.6})}}) end)
  check(fixture.writes == writes and fixture.committed == committed and fixture.cancelled == cancelled, "nearby stale baseline starts no recording or write")
  oneByteChange(instance, channel)
  local manual = P.snapshot(instance, {"Color"})
  check(manual.Color.value[channel] == colorFloat32((math.round(regressionStored[channel] * 255) + 1) / 255), "manual change is exactly one byte")
  check(not Properties.compare(instance, actual, {"Color"}) and not P.compare(instance, actual, {"Color"}), "one-byte actual edit conflicts in both baseline codecs")
  writes, committed, cancelled = fixture.writes, fixture.committed, fixture.cancelled
  refuses("CONFLICT", function() run(ops, "scene.update", {ref = created.ref, expected = actual, properties = {Color = taggedColor({0.2, 0.4, 0.6})}}) end)
  check(fixture.writes == writes and fixture.committed == committed and fixture.cancelled == cancelled and V.equal(P.snapshot(instance, {"Color"}), manual), "one-byte edit is preserved without starting mutation")
  instance.Color = Color3.new(table.unpack(regressionInput))
  fixture.historyHook = function() oneByteChange(instance, channel); fixture.historyHook = nil end
  writes, committed, cancelled = fixture.writes, fixture.committed, fixture.cancelled
  refuses("CONFLICT", function() run(ops, "scene.update", {ref = created.ref, expected = actual, properties = {Color = taggedColor({0.2, 0.4, 0.6})}}) end)
  check(fixture.writes == writes + 1 and fixture.committed == committed and fixture.cancelled == cancelled + 1, "pre-write race cancels the untouched recording")
  check(V.equal(P.snapshot(instance, {"Color"}), manual), "pre-write race preserves one-byte manual edit")
end
for _, kind in ipairs({"create", "update"}) do
  for channel = 1, 3 do
    local ops = fresh()
    local result, id = create(ops, {Color = taggedColor(regressionInput)})
    local instance = ops.registry:resolve(result.ref)
    if kind == "update" then result, id = run(ops, "scene.update", {ref = result.ref, expected = {Color = result.mutation.after.properties.Color}, properties = {Color = taggedColor({0.7, 0.3, 0.2})}}) end
    oneByteChange(instance, channel)
    local manual, writes = P.snapshot(instance, {"Color"}), fixture.writes
    refuses("CONFLICT", function() restore(ops, id, result) end)
    check(fixture.writes == writes and not instance._destroyed and not ops.restored[id], kind .. " restore preserves one-byte manual edit")
    check(V.equal(P.snapshot(instance, {"Color"}), manual), kind .. " restore never clobbers a changed canonical after-state")
  end
end
print("Arcane strict colour baseline checks passed: " .. checks)
`, /Arcane strict colour baseline checks passed: \d+/);
});

test('one-byte bad setters still fail VERIFY before parenting or PARTIAL after an update', { skip: !runtime }, async () => {
  await runPropertyFixture(regressionFixture + `
for channel = 1, 3 do
  local ops = fresh()
  ops.registry:ref(game:GetService("Workspace"))
  local count, refs, committed, cancelled, parentings = #fixture.created, ops.registry.count, fixture.committed, fixture.cancelled, fixture.colorParentings
  fixture.corruptColorChannel = channel
  local err = refuses("VERIFY", function() create(ops, {Color = taggedColor(regressionInput)}) end)
  fixture.corruptColorChannel = nil
  local instance = fixture.created[#fixture.created]
  check(#fixture.created == count + 1 and instance._destroyed and instance.Parent == nil, "failed create destroys its unparented allocation")
  check(fixture.colorParentings == parentings and #game:GetService("Workspace"):GetChildren() == 0, "failed create never parents the bad colour")
  check(ops.registry.count == refs and ops.registry.owned[instance] == nil and next(ops.mutations) == nil, "failed create issues no ref, ownership or receipt")
  check(fixture.committed == committed and fixture.cancelled == cancelled + 1 and err.recovery == nil, "unparented VERIFY cancels the untouched recording")
  ops = fresh()
  local created = create(ops, {Color = taggedColor({0.2, 0.4, 0.6})})
  instance = ops.registry:resolve(created.ref)
  committed, cancelled = fixture.committed, fixture.cancelled
  fixture.corruptColorChannel = channel
  err = refuses("PARTIAL", function() run(ops, "scene.update", {ref = created.ref, expected = {Color = created.mutation.after.properties.Color}, properties = {Color = taggedColor(regressionInput)}}) end)
  fixture.corruptColorChannel = nil
  check(string.find(err.message, "VERIFY:", 1, true) ~= nil and err.unsafe == true, "bad update setter retains the VERIFY cause")
  check(err.recovery.partial and err.recovery.needsReconciliation and err.recovery.rollbackVerified == false, "bad update requires reconciliation and claims no rollback")
  check(err.recovery.ref.instanceId == created.ref.instanceId and ops.mutations[err.recovery.commandId] == nil, "partial update retains identity without a successful receipt")
  -- The synchronous revert attempt is corrupted by the same bad setter, so the
  -- unverified baseline write remains for reconciliation (still PARTIAL).
  local corrupted = table.clone(created.mutation.after.properties.Color.value)
  corrupted[channel] = colorFloat32((math.round(corrupted[channel] * 255) + 1) / 255)
  exactColor(P.snapshot(instance, {"Color"}).Color, corrupted, "partial actual corruption")
  check(not P.assignedMatches(instance, "Color", P.decode("Color", taggedColor(regressionInput), true, true)), "post-write comparison rejects the one-byte corruption")
  check(fixture.committed == committed + 1 and fixture.cancelled == cancelled, "touched update commits its undo recording")
end
do
  local ops = fresh()
  ops.registry:ref(game:GetService("Workspace"))
  local refs, count, cancelled, parentings = ops.registry.count, #fixture.created, fixture.cancelled, fixture.colorParentings
  fixture.failProperty = "Color"
  local ok, err = pcall(function() create(ops, {Color = taggedColor(regressionInput)}) end)
  check(not ok and type(err) == "string" and string.find(err, "injected property setter failure", 1, true) ~= nil, "throwing colour setter preserves its engine failure")
  fixture.failProperty = nil
  local instance = fixture.created[#fixture.created]
  check(#fixture.created == count + 1 and instance._destroyed and instance.Parent == nil, "throwing colour setter cleans the allocation")
  check(fixture.colorParentings == parentings and ops.registry.count == refs and next(ops.mutations) == nil and fixture.cancelled == cancelled + 1, "throwing colour setter never parents or issues a receipt")
end
print("Arcane colour corruption checks passed: " .. checks)
`, /Arcane colour corruption checks passed: \d+/);
});

test('post-write matching keeps other scalar, vector and enum properties exact', { skip: !runtime }, async () => {
  await runPropertyFixture(regressionFixture + `
local ops = fresh()
local created = create(ops, {})
local instance = ops.registry:resolve(created.ref)
for _, case in ipairs({
  {name = "Name", actual = "exact", same = "exact", different = "Exact"},
  {name = "Anchored", actual = true, same = true, different = false},
  {name = "CanCollide", actual = false, same = false, different = true},
  {name = "Transparency", actual = 0.25, same = 0.25, different = 0.25000000000000006},
  {name = "Reflectance", actual = 0.5, same = 0.5, different = 0.5000000000000001},
  {name = "CastShadow", actual = false, same = false, different = true},
  {name = "Size", actual = Vector3.new(1, 2, 3), same = Vector3.new(1, 2, 3), different = Vector3.new(1.0000001192092896, 2, 3)},
  {name = "Position", actual = Vector3.new(1, 2, 3), same = Vector3.new(1, 2, 3), different = Vector3.new(1, 2.000000238418579, 3)},
  {name = "Material", actual = Enum.Material.Plastic, same = Enum.Material.Plastic, different = Enum.Material.Metal},
  {name = "Shape", actual = Enum.PartType.Block, same = Enum.PartType.Block, different = Enum.PartType.Cylinder},
}) do
  instance[case.name] = case.actual
  check(Properties.assignedMatches(instance, case.name, case.same) and P.assignedMatches(instance, case.name, case.same), case.name .. " exact match")
  check(not Properties.assignedMatches(instance, case.name, case.different) and not P.assignedMatches(instance, case.name, case.different), case.name .. " has no new tolerance")
end
print("Arcane strict property post-write checks passed: " .. checks)
`, /Arcane strict property post-write checks passed: \d+/);
});

test('Orientation post-write accepts wrapped and gimbal-equivalent matrices while baselines stay strict', { skip: !runtime }, async () => {
  await runPropertyFixture(regressionFixture + `
local cases = {
  {requested = {360, 0, 0}, stored = {0, 0, 0}},
  {requested = {0, -360, 360}, stored = {0, 0, 0}},
  {requested = {0, 270, -270}, stored = {0, -90, 90}},
  {requested = {90, 30, 60}, stored = {90, -30, 0}},
  {requested = {-90, 30, 60}, stored = {-90, 90, 0}},
}
for _, case in ipairs(cases) do
  local ops = fresh()
  local requested = Vector3.new(table.unpack(case.requested))
  local stored = Vector3.new(table.unpack(case.stored))
  fixture.orientationReadback = stored
  local created, createId = create(ops, {Orientation = vector(table.unpack(case.requested)), Color = taggedColor(regressionInput)})
  fixture.orientationReadback = nil
  local instance = ops.registry:resolve(created.ref)
  check(instance.Orientation == stored and instance.Orientation ~= requested, "fixture supplies a distinct legal Euler readback")
  check(P.assignedMatches(instance, "Orientation", requested), "rotation matrix accepts equivalent Euler post-write")
  check(not Properties.assignedMatches(instance, "Orientation", requested), "legacy matcher remains exact for Orientation")
  check(not P.compare(instance, {Orientation = vector(table.unpack(case.requested))}, {"Orientation"}), "equivalent rotation never widens CAS baseline")
  check(V.equal(created.mutation.after.properties.Orientation, P.encode("Orientation", stored)), "creation receipt records actual canonical Euler values")
  exactColor(created.mutation.after.properties.Color, regressionStored, "mixed Orientation/Color create")
  local writes, committed = fixture.writes, fixture.committed
  refuses("CONFLICT", function() run(ops, "scene.update", {ref = created.ref, expected = {Orientation = vector(table.unpack(case.requested))}, properties = {Orientation = vector(0, 0, 0)}}) end)
  check(fixture.writes == writes and fixture.committed == committed, "stale equivalent-Euler baseline starts no mutation")
  check(restore(ops, createId, created).restored and instance._destroyed, "equivalent-Euler create restores from actual receipt")

  ops = fresh()
  created = create(ops, {Orientation = vector(10, 20, 30)})
  instance = ops.registry:resolve(created.ref)
  fixture.orientationReadback = stored
  local updated, updateId = run(ops, "scene.update", {ref = created.ref,
    expected = {Orientation = created.mutation.after.properties.Orientation}, properties = {Orientation = vector(table.unpack(case.requested))}})
  fixture.orientationReadback = nil
  check(instance.Orientation == stored and P.assignedMatches(instance, "Orientation", requested), "update accepts legal wrapped/gimbal readback")
  check(V.equal(updated.mutation.after.properties.Orientation, P.encode("Orientation", stored)), "update receipt records actual Euler readback")
  check(P.compare(instance, updated.mutation.after.properties, {"Orientation"}), "restore expected-after remains the exact actual readback")
  check(restore(ops, updateId, updated).restored and instance.Orientation == Vector3.new(10, 20, 30), "Orientation update restores exact before-state")
end
-- Directly inspect every rotation cell. Translation is outside this postcondition.
local requested = Vector3.new(17, 29, 43)
local components = {CFrame.fromOrientation(math.rad(17), math.rad(29), math.rad(43)):GetComponents()}
local function matrixInstance(values: {number}): any
  return {CFrame = {GetComponents = function(_self: any): ...number return table.unpack(values) end}, Orientation = requested}
end
local translated = table.clone(components); translated[1], translated[2], translated[3] = 12, 34, 56
check(P.assignedMatches(matrixInstance(translated), "Orientation", requested), "Orientation verification ignores translation")
for index = 4, 12 do
  for _, sign in ipairs({-1, 1}) do
    local inside = table.clone(components); inside[index] += sign * 0.0000005
    check(P.assignedMatches(matrixInstance(inside), "Orientation", requested), "matrix cell inside tolerance " .. index)
    local outside = table.clone(components); outside[index] += sign * 0.000002
    check(not P.assignedMatches(matrixInstance(outside), "Orientation", requested), "matrix cell beyond tolerance " .. index)
  end
end
-- A real different rotation must fail even when the displayed Euler stub agrees.
local different = {CFrame.fromOrientation(0, math.rad(0.001), 0):GetComponents()}
local differentInstance = matrixInstance(different); differentInstance.Orientation = Vector3.new(0, 0, 0)
check(not P.assignedMatches(differentInstance, "Orientation", Vector3.new(0, 0, 0)), "different matrix is rejected despite equal displayed Euler values")
for _, method in ipairs({"create", "update"}) do
  local ops = fresh()
  local created, instance
  if method == "update" then created = create(ops, {Orientation = vector(0, 0, 0)}); instance = ops.registry:resolve(created.ref) end
  local count, committed, cancelled, parentings = #fixture.created, fixture.committed, fixture.cancelled, fixture.colorParentings
  fixture.orientationReadback = Vector3.new(0, 0.001, 0)
  local err = refuses(if method == "create" then "VERIFY" else "PARTIAL", function()
    if method == "create" then return create(ops, {Orientation = vector(0, 0, 0)}) end
    return run(ops, "scene.update", {ref = created.ref, expected = {Orientation = vector(0, 0, 0)}, properties = {Orientation = vector(0, 0, 0)}})
  end)
  fixture.orientationReadback = nil
  if method == "create" then
    instance = fixture.created[#fixture.created]
    check(#fixture.created == count + 1 and instance._destroyed and instance.Parent == nil and fixture.colorParentings == parentings, "different rotation create cleans before parenting")
    check(fixture.committed == committed and fixture.cancelled == cancelled + 1, "different rotation create cancels untouched recording")
  else
    check(string.find(err.message, "VERIFY:", 1, true) ~= nil and err.recovery.needsReconciliation and not err.recovery.rollbackVerified, "different rotation update remains partial VERIFY")
    check(instance.Orientation == Vector3.new(0, 0.001, 0) and fixture.committed == committed + 1 and fixture.cancelled == cancelled, "different actual rotation remains available for reconciliation")
  end
end
print("Arcane Orientation post-write checks passed: " .. checks)
`, /Arcane Orientation post-write checks passed: \d+/);
});

test('engine-coerced update value reverts synchronously to a clean VERIFY instead of an unsafe PARTIAL', { skip: !runtime }, async () => {
  await runPropertyFixture(regressionFixture + `
-- Test double for native Ball coercion: a Ball part keeps a uniform Size.
local ballOriginalSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if key == "Size" and self:IsA("Part") and self.Shape == Enum.PartType.Ball and not fixture.ballRevertFails then
    local side = math.min(value.X, value.Y, value.Z); value = Vector3.new(side, side, side)
  elseif key == "Size" and fixture.ballRevertFails then value = Vector3.new(9, 9, 9) end
  ballOriginalSetter(self, key, value)
end
local ops = fresh()
local created = create(ops, {Shape = "Ball", Size = vector(3, 3, 3)})
local instance = ops.registry:resolve(created.ref)
local before = P.snapshot(instance)
local committed, cancelled = fixture.committed, fixture.cancelled
local err = refuses("VERIFY", function()
  return run(ops, "scene.update", {ref = created.ref, expected = {Size = vector(3, 3, 3)}, properties = {Size = vector(4, 2, 6)}})
end)
check(err.unsafe ~= true and err.recovery == nil, "verified revert is not an unsafe partial change")
check(V.equal(P.snapshot(instance), before) and instance.Size == Vector3.new(3, 3, 3), "coerced write is reverted exactly")
check(fixture.committed == committed and fixture.cancelled == cancelled + 1 and ops.mutations["assignment-" .. serial] == nil, "reverted update cancels its recording and issues no receipt")
-- Following work is not refused: the same part accepts a later valid uniform update.
local updated = run(ops, "scene.update", {ref = created.ref, expected = {Size = vector(3, 3, 3)}, properties = {Size = vector(5, 5, 5)}})
check(instance.Size == Vector3.new(5, 5, 5) and updated.mutation.after.properties.Size.value[1] == 5, "later update succeeds")
-- A revert the engine does not honour stays PARTIAL for reconciliation.
fixture.ballRevertFails = true
err = refuses("PARTIAL", function()
  return run(ops, "scene.update", {ref = created.ref, expected = {Size = vector(5, 5, 5)}, properties = {Size = vector(4, 2, 6)}})
end)
fixture.ballRevertFails = nil
check(err.unsafe == true and err.recovery.partial and err.recovery.rollbackVerified == false and string.find(err.message, "VERIFY:", 1, true) ~= nil, "failed revert keeps PARTIAL")
print("Arcane coerced revert checks passed: " .. checks)
`, /Arcane coerced revert checks passed: \d+/);
});
