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
const modules = ['Validation', 'Registry', 'Properties', 'TerrainGen', 'AssetMaterials','Operations'];

// Engine doubles owned by this harness: Region3 boxes, the terrain Enum.Material items MockEngine lacks,
// a recording Terrain:WriteVoxels and a counting task.wait. They do not certify Roblox behaviour.
const engineFixture = `
for index, name in ipairs({"Air", "Water", "Glacier", "Salt", "CrackedLava"}) do
  materials[name] = table.freeze({Name = name, Value = 100 + index, EnumType = materials, _enumItem = true})
end
Region3 = {new = function(low: any, high: any): any return {low = low, high = high} end}
fixture.yields = 0
task.wait = function(): ()
  fixture.yields += 1
  if fixture.failAfterYields and fixture.yields >= fixture.failAfterYields then error({code = "LEASE", message = "Command lease has expired."}, 0) end
end
`;

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-terrain-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'terrain.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, marker);
    process.stdout.write(result.stdout);
  } finally {
    assert.ok(path.basename(directory).startsWith('arcane-terrain-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const prelude = `
local V, T = Validation, TerrainGen
fixture.encode = function(data: any): string return V.encode(data, http) end
local checks = 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local function refuses(code: string, callback: () -> any, text: string?): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
  if text then check(string.find(err.message, text, 1, true) ~= nil, "message names: " .. text .. " / " .. err.message) end
  return err
end
local function near(a: number, b: number): boolean return math.abs(a - b) < 1e-6 end
local function column(plan: any, x: number, z: number): number
  return math.floor((z - plan.z0) / 4) * plan.nx + math.floor((x - plan.x0) / 4) + 1
end
local function centre(plan: any, i: number): (number, number)
  local ix, iz = (i - 1) % plan.nx, (i - 1) // plan.nx
  return plan.x0 + (ix + 0.5) * 4, plan.z0 + (iz + 0.5) * 4
end
`;

const pure = prelude + `
-- 1. Bounds: the region snaps to the 4-stud grid; every limit refuses before any computation.
local snapped = T.plan({center = {10, -6}, size = {100, 60}, height = 66, baseHeight = 10, seed = 1})
check(snapped.x0 == -40 and snapped.z0 == -36 and snapped.nx == 25 and snapped.nz == 15 and snapped.ny == 17 and snapped.height == 68 and snapped.y0 == 0, "region snaps to the voxel grid")
check(snapped.voxels == 25 * 17 * 15, "voxel count")
local full = T.plan({center = {0, 0}, size = {2048, 2048}, height = 512, baseHeight = 0, seed = 0})
check(full.voxels == T.LIMITS.voxels and T.LIMITS.chunkColumns ^ 2 * (T.LIMITS.height / 4) == T.LIMITS.chunkVoxels, "full region fits the total and per-chunk budgets")
check(T.LIMITS.chunkVoxels <= 8 * 1024 * 1024, "each WriteVoxels call stays under 8M voxels")
local base = {center = {0, 0}, size = {256, 256}, height = 64, baseHeight = 20, seed = 7}
local function with(patch: any): any local args = table.clone(base); for k, v in pairs(patch) do args[k] = v end; return args end
refuses("INPUT", function() return T.plan(with({size = {4096, 64}})) end)
refuses("INPUT", function() return T.plan(with({size = {8, 64}})) end)
refuses("INPUT", function() return T.plan(with({height = 1024})) end)
refuses("INPUT", function() return T.plan(with({baseHeight = 70})) end)
refuses("INPUT", function() return T.plan(with({seed = 1.5})) end, "seed must be an integer")
refuses("INPUT", function() return T.plan(with({script = "x"})) end)
refuses("INPUT", function() return T.plan(with({noise = {type = "perlin"}})) end, "fbm or ridged")
refuses("INPUT", function() return T.plan(with({noise = {octaves = 9}})) end)
refuses("INPUT", function() return T.plan(with({features = {{kind = "volcano", center = {0, 0}, radius = 10, height = 5}}})) end, "feature kind")
refuses("INPUT", function() return T.plan(with({features = {{kind = "plateau", center = {0, 0}, radius = 10}}})) end, "plateau needs level")
refuses("INPUT", function() return T.plan(with({features = {{kind = "river", points = {{0, 0}}, width = 8}}})) end, "2..32 points")
refuses("PROPERTY", function() return T.plan(with({features = {{kind = "path", points = {{0, 0}, {9, 9}}, width = 8, material = "Water"}}})) end)
refuses("PROPERTY", function() return T.plan(with({materials = {rules = {{material = "Air"}}}})) end)
local many = {}
for index = 1, 33 do many[index] = {kind = "hill", center = {0, 0}, radius = 10, height = 5} end
refuses("INPUT", function() return T.plan(with({features = many})) end)

-- 2. Determinism: same seed, same field; another seed differs. Heights stay inside the region.
local rolling = {center = {0, 0}, size = {512, 384}, height = 128, baseHeight = 40, seed = 1234, edge = 64,
  noise = {type = "ridged", octaves = 6, frequency = 5, amplitude = 30}, features = {{kind = "mountain", center = {100, 50}, radius = 120, height = 70},
  {kind = "crater", center = {-150, -100}, radius = 50, height = 20}, {kind = "plateau", center = {-120, 120}, radius = 60, level = 90}, {kind = "valley", center = {150, -120}, radius = 80, height = 25}}}
local first, second = T.field(T.plan(rolling)), T.field(T.plan(rolling))
local other = table.clone(rolling); other.seed = 1235
local third = T.field(T.plan(other))
local identical, differs, inside = true, false, true
for i = 1, #first.heights do
  if first.heights[i] ~= second.heights[i] or first.materials[i] ~= second.materials[i] or first.water[i] ~= second.water[i] then identical = false end
  if first.heights[i] ~= third.heights[i] then differs = true end
  if first.heights[i] < 0 or first.heights[i] > 128 then inside = false end
end
check(identical, "same seed produces the identical field")
check(differs, "another seed changes the field")
check(inside and first.low >= 0 and first.high <= 128 and first.high > first.low, "heights stay within the region")
local rp = T.plan(rolling)
check(near(first.heights[1], 40) or math.abs(first.heights[1] - 40) < 1, "edge fade returns to baseHeight at the border")
local top = first.heights[column(rp, -120, 120)]
check(near(top, 90), "plateau top is flat at its level")

-- 3. Flatten blending: exact pad inside the radius, monotonic blend in the ring, untouched outside.
local noisy = {center = {0, 0}, size = {256, 256}, height = 128, baseHeight = 40, seed = 99, noise = {type = "fbm", octaves = 5, frequency = 8, amplitude = 25}}
local pad = table.clone(noisy); pad.features = {{kind = "flatten", center = {0, 0}, radius = 40, level = 50, blend = 24, material = "Ground"}}
local pp, rough, flat = T.plan(pad), T.field(T.plan(noisy)), T.field(T.plan(pad))
local inner, ring, outer, blended = 0, 0, 0, 0
for i = 1, #flat.heights do
  local x, z = centre(pp, i)
  local d = math.sqrt(x * x + z * z)
  if d <= 40 then
    check(near(flat.heights[i], 50) and flat.materials[i] == "Ground", "clearing is level and uses its material")
    inner += 1
  elseif d < 64 then
    check(math.abs(flat.heights[i] - 50) <= math.abs(rough.heights[i] - 50) + 1e-9, "blend ring moves toward the pad level")
    if not near(flat.heights[i], rough.heights[i]) and not near(flat.heights[i], 50) then blended += 1 end
    ring += 1
  elseif d > 64 then
    check(flat.heights[i] == rough.heights[i], "terrain beyond the blend radius is untouched")
    outer += 1
  end
end
check(inner > 250 and ring > 100 and blended > 50 and outer > 1000, "flatten covers pad, ring and outside")
local default = table.clone(noisy); default.features = {{kind = "flatten", center = {0, 0}, radius = 30}}
local defaultField = T.field(T.plan(default))
check(near(defaultField.heights[column(pp, 1, 1)], defaultField.heights[column(pp, -20, 10)]), "flatten without level uses the ground at its centre")

-- 4. River carving: level bed, water surface, banks blend back, Pebble bed and Sand shores.
local river = {center = {0, 0}, size = {400, 200}, height = 64, baseHeight = 40, seed = 3,
  features = {{kind = "river", points = {{-300, 0}, {300, 0}}, width = 20, depth = 8}}}
local rv = T.plan(river)
local rf = T.field(rv)
local bedOk, bankOk, dryOk, sand = 0, 0, 0, 0
for i = 1, #rf.heights do
  local x, z = centre(rv, i)
  local d = math.abs(z)
  if d <= 10 then
    check(near(rf.heights[i], 32) and near(rf.water[i], 37.6) and rf.materials[i] == "Pebble", "river core: bed at depth, water above, Pebble bed")
    bedOk += 1
  elseif d < 30 then
    check(rf.heights[i] > 32 and rf.heights[i] < 40, "river bank slopes back up")
    bankOk += 1
  else
    check(rf.heights[i] == 40 and rf.water[i] == -1, "outside the river is untouched and dry")
    dryOk += 1
  end
  if rf.water[i] < 0 and rf.near[i] > 0 and rf.near[i] <= 6 then
    check(rf.materials[i] == "Sand", "shore columns are Sand")
    sand += 1
  end
end
check(bedOk == 6 * 100 and bankOk > 0 and dryOk > 0 and sand > 0 and rf.wet >= 600, "river regions are present")
local path = {center = {0, 0}, size = {200, 200}, height = 64, baseHeight = 30, seed = 5, noise = {amplitude = 12, frequency = 6},
  features = {{kind = "path", points = {{-90, -40}, {0, 0}, {90, 30}}, width = 8, depth = 0.5}}}
local ph = T.plan(path)
local pf = T.field(ph)
local onPath = pf.materials[column(ph, 0, 0)]
check(onPath == "Ground" and pf.water[column(ph, 0, 0)] == -1, "path uses Ground and holds no water")
local a, b = pf.heights[column(ph, 0, 3)], pf.heights[column(ph, 0, -3)]
check(math.abs(a - b) < 1.5, "path cross-section is near level")

-- 5. Slope and height materials from the default rules.
local hill = {center = {0, 0}, size = {768, 768}, height = 256, baseHeight = 20, seed = 11, snowLine = 200,
  features = {{kind = "hill", center = {0, 0}, radius = 300, height = 220}}}
local hp = T.plan(hill)
local hf = T.field(hp)
local seen: {[string]: number} = {}
for i = 1, #hf.heights do
  local h, s, m = hf.heights[i], hf.slope[i], hf.materials[i]
  seen[m] = (seen[m] or 0) + 1
  local expected = if h >= 200 and s <= 42 then "Snow" elseif s >= 40 then "Rock" elseif s >= 32 then "Slate" elseif s >= 22 then "Ground" else nil
  if expected then check(m == expected, "slope/height rule " .. expected .. " got " .. m)
  else check(m == "Grass" or m == "LeafyGrass", "gentle slopes are grass") end
end
check((seen.Snow or 0) > 0 and (seen.Rock or 0) > 0 and (seen.Slate or 0) > 0 and (seen.Grass or 0) > 0 and (seen.LeafyGrass or 0) > 0, "all default bands appear")
local custom = table.clone(hill); custom.materials = {rules = {{material = "Basalt", minSlope = 30}, {material = "Sandstone", maxHeight = 40}}, fallback = "Mud", deep = "Granite"}
local cp = T.plan(custom)
local cf = T.field(cp)
for i = 1, #cf.heights do
  local expected = if cf.slope[i] >= 30 then "Basalt" elseif cf.heights[i] <= 40 then "Sandstone" else "Mud"
  check(cf.materials[i] == expected, "custom rules: first match wins, then fallback")
end
check(cp.deep == "Granite", "deep material override")

-- 6. Lake: a carved basin filled to the water level with a Mud bed and a raised rim.
local lake = {center = {0, 0}, size = {320, 320}, height = 96, baseHeight = 30, seed = 21, features = {{kind = "lake", center = {0, 0}, radius = 80, level = 34}}}
local lp = T.plan(lake)
local lf = T.field(lp)
local mid = column(lp, 1, 1)
check(near(lf.water[mid], 34) and near(lf.heights[mid], 34 - 12 * (1 - (math.sqrt(8) / 80) ^ 2)) and lf.materials[mid] == "Mud", "lake centre: water level, carved bed, Mud")
for i = 1, #lf.heights do
  local x, z = centre(lp, i)
  local t = math.sqrt(x * x + z * z) / 80
  if t >= 1 and t < 1.1 then check(lf.heights[i] >= 34 and lf.water[i] == -1, "lake rim holds the water") end
end

-- 7. Chunked voxel arrays: aligned bounded regions covering the box, one yield per chunk, exact occupancies.
local flatArgs = {center = {0, 0}, size = {600, 300}, height = 64, floor = 10, baseHeight = 41, seed = 1,
  features = {{kind = "lake", center = {200, 0}, radius = 40, level = 44, depth = 6}}}
local fp = T.plan(flatArgs)
local ff = T.field(fp)
local writes, yields, columns = {}, 0, 0
local chunks = T.write(fp, ff, {resolve = function(name: string): string return name end,
  write = function(low: any, high: any, mats: any, occs: any): () table.insert(writes, {low = low, high = high, mats = mats, occs = occs}) end,
  yield = function(): () yields += 1 end})
check(chunks == 6 and #writes == 6 and yields == 6, "600x300 region writes 3x2 chunks with a yield after each")
for _, w in ipairs(writes) do
  local sx, sy, sz = w.high[1] - w.low[1], w.high[2] - w.low[2], w.high[3] - w.low[3]
  check(w.low[1] % 4 == 0 and w.low[2] % 4 == 0 and w.low[3] % 4 == 0 and sy == 64 and w.low[2] == 12, "chunk region aligned to the grid at the snapped floor")
  check((sx / 4) * (sy / 4) * (sz / 4) <= T.LIMITS.chunkVoxels and #w.mats == sx / 4 and #w.mats[1] == sy / 4 and #w.mats[1][1] == sz / 4, "chunk arrays are [x][y][z] within budget")
  columns += (sx / 4) * (sz / 4)
end
check(columns == fp.nx * fp.nz, "chunks cover every column exactly once")
local w1 = writes[1]
local m, o = w1.mats[1], w1.occs[1]
check(m[1][1] == "Rock" and o[1][1] == 1 and m[7][1] == "Rock" and m[8][1] == ff.materials[1] and o[10][1] == 1, "deep voxels are Rock, the top 12 studs carry the surface")
check(m[11][1] == ff.materials[1] and near(o[11][1], 0.25) and m[12][1] == "Air" and o[12][1] == 0, "fractional surface occupancy, air above")
local wetIndex = column(fp, 201, 1)
local li = wetIndex
local lx, lz = (li - 1) % fp.nx, (li - 1) // fp.nx
local wetChunk = writes[(lz // 64) * 3 + (lx // 64) + 1]
local cx, cz = lx - (wetChunk.low[1] - fp.x0) / 4 + 1, lz - (wetChunk.low[3] - fp.z0) / 4 + 1
local surfaceTop = ff.heights[li]
local waterY = math.floor(surfaceTop / 4) + 2
check(wetChunk.mats[cx][waterY][cz] == "Water" and wetChunk.occs[cx][waterY][cz] > 0, "water voxels fill above the lake bed")
local summary = T.summary(fp, ff, chunks)
check(summary.voxels == fp.voxels and summary.chunks == 6 and summary.waterColumns == ff.wet and summary.region.size[1] == 600, "receipt summary")
print("Arcane terrain generator checks passed: " .. checks)
`;

const operations = prelude + `
local workspace = game:GetService("Workspace")
local ops = Operations.new({sessionId = "terrain-session", allowedRoots = {"Workspace"}}, game, http)
ops.sliceSeconds = math.huge -- Deterministic counts: only chunk-boundary yields until the slicing section.
local serial = 0
local function run(args: any): any
  serial += 1
  return ops:execute({id = "terrain-" .. serial, method = "terrain.generate", args = args}, function() end)
end
local args = {center = {0, 0}, size = {300, 140}, height = 64, baseHeight = 24, seed = 8, noise = {type = "fbm", octaves = 4, frequency = 6, amplitude = 10},
  features = {{kind = "river", points = {{-150, -20}, {150, 20}}, width = 12, depth = 6}, {kind = "flatten", center = {60, 40}, radius = 16, blend = 10}}}

-- No Terrain object: refused before any recording.
local committed, cancelled = fixture.committed, fixture.cancelled
refuses("TERRAIN", function() return run(args) end)
check(fixture.committed == committed and fixture.cancelled == cancelled, "missing Terrain never opens a recording")
local terrain = Instance.new("Terrain"); terrain.Parent = workspace
local voxelWrites = {}
terrain._properties.WriteVoxels = function(_self: any, region: any, resolution: number, mats: any, occs: any): ()
  check(resolution == 4, "WriteVoxels at resolution 4")
  table.insert(voxelWrites, {region = region, mats = mats, occs = occs})
end
refuses("INPUT", function() return run({center = {0, 0}, size = {9000, 10}, height = 64, baseHeight = 1, seed = 1}) end)
refuses("PROPERTY", function() local bad = table.clone(args); bad.materials = {rules = {{material = "Plastic"}}}; return run(bad) end)
check(fixture.committed == committed and #voxelWrites == 0, "invalid arguments write nothing")

-- One recording, chunked writes with a yield between chunks, Terrain receipt with a null baseline.
local result = run(args)
check(fixture.committed == committed + 1 and fixture.cancelled == cancelled, "exactly one ChangeHistory recording is committed")
check(#voxelWrites == 2 and fixture.yields == 2, "two chunks, one yield after each")
check(voxelWrites[1].mats[1][1][1] == Enum.Material.Rock or voxelWrites[1].mats[1][1][1].EnumType == Enum.Material, "engine receives Enum.Material items")
local mutation = result.mutation
check(mutation.kind == "terrain.generate" and mutation.before == V.NULL and mutation.ref.className == "Terrain", "receipt names the Terrain with a null baseline")
check(mutation.after.voxels == 75 * 16 * 35 and mutation.after.chunks == 2 and mutation.after.seed == 8 and mutation.after.features == 2 and mutation.after.waterColumns > 0, "receipt counts")
check(voxelWrites[1].region.low.X == -148 and voxelWrites[1].region.low.Y == 0 and voxelWrites[1].region.high.Y == 64, "regions are snapped Region3 boxes")
local again = run(args)
check(V.equal(again.mutation.after, mutation.after), "same seed, same receipt")
refuses("RECEIPT", function() return ops:execute({id = "terrain-restore", method = "scene.restore", args = {receiptCommandId = "terrain-4", mutation = mutation}}, function() end) end, "Unsupported mutation receipt")

-- A lease lost between chunks leaves a committed (undoable) partial write and reports PARTIAL.
fixture.yields = 0
fixture.failAfterYields = 1
local before = fixture.committed
local err = refuses("PARTIAL", function() return run(args) end)
check(err.recovery.partial == true and fixture.committed == before + 1, "partial write keeps one undo recording for Studio Undo")

-- Cooperative slicing: with a zero budget the field synthesis yields between rows BEFORE the recording
-- opens (and chunk preparation between x-slices), re-running the guard after each yield.
fixture.failAfterYields = nil
ops.sliceSeconds = 0
fixture.yields = 0
local slicesBefore = ops.slices
local sliced = run(args)
check(V.equal(sliced.mutation.after, mutation.after) and fixture.yields > 2 and ops.slices - slicesBefore == fixture.yields, "sliced generation yields between rows and keeps the same receipt")
-- A lease lost during field slicing writes nothing and opens no recording.
local writesBefore, committedBefore, cancelledBefore = #voxelWrites, fixture.committed, fixture.cancelled
fixture.yields = 0; fixture.failAfterYields = 1
refuses("LEASE", function() return run(args) end)
check(#voxelWrites == writesBefore and fixture.committed == committedBefore and fixture.cancelled == cancelledBefore, "lease lost while slicing the field writes nothing and opens no recording")
fixture.failAfterYields = nil
print("Arcane terrain operation checks passed: " .. checks)
`;

test('TerrainGen: bounds, determinism, flatten blending, river carving, slope materials and chunked voxels', { skip: !runtime && 'Set ARCANE_LUAU_BIN to run the Luau VM checks.' }, async () => {
  await runLuau(pure, /Arcane terrain generator checks passed: \d+/);
});

test('Operations terrain.generate: one recording, chunked WriteVoxels with yields, Terrain receipt, partial recovery', { skip: !runtime && 'Set ARCANE_LUAU_BIN to run the Luau VM checks.' }, async () => {
  await runLuau(operations, /Arcane terrain operation checks passed: \d+/);
});
