import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modulePath = path.join(repository, 'plugin/src/AssetMesh.luau');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const runtimeOptions = { skip: !runtime && 'Standalone Luau runtime not configured.' };
const sha = value => createHash('sha256').update(value).digest('hex');
const literalBytes = bytes => `buffer.fromstring("${Array.from(bytes, byte => `\\${String(byte).padStart(3, '0')}`).join('')}")`;

// Node packs independent little-endian fixtures; the module must read exact bytes.
function descriptor(semantic, type, componentType, values, normalized = false) {
  const width = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4;
  const size = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
  const bytes = Buffer.alloc(values.length * width);
  for (let index = 0; index < values.length; index++) {
    if (componentType === 5126) bytes.writeFloatLE(values[index], index * width);
    else if (width === 1) bytes.writeUInt8(values[index], index);
    else if (width === 2) bytes.writeUInt16LE(values[index], index * width);
    else bytes.writeUInt32LE(values[index], index * width);
  }
  return `{semantic="${semantic}", type="${type}", componentType=${componentType}, count=${values.length / size}, normalized=${normalized}, byteLength=${bytes.length}, bytes=${literalBytes(bytes)}, sha256="${sha(bytes)}", chunks={}, streamId="fixture-${semantic}"}`;
}

const positions = [-1.5, 2.25, 0.125, 3.5, -4, 5.75, 0, 1, -2, -1.5, 2.25, 0.125, -5, 7.25, -7.625];
const normals = [0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, -1, 0, -1, 0];
const uvs = [-2, 4, 0.5, 0.25, 1, 1, 0.75, -0.5, -0.25, 0.75];
// Two nondegenerate quad faces meet at the coincident 0/3 seam vertices.
const exactPrimitive = `{mode=4, vertexCount=5, triangleCount=2, attributes={
 POSITION=${descriptor('POSITION', 'VEC3', 5126, positions)},
 NORMAL=${descriptor('NORMAL', 'VEC3', 5126, normals)},
 TEXCOORD_0=${descriptor('TEXCOORD_0', 'VEC2', 5126, uvs)}},
 indices=${descriptor('indices', 'SCALAR', 5123, [2, 0, 1, 3, 2, 4])}}`;

const doubles = `
local function forbidden(): never error("unexpected engine/service/global access") end
local game, workspace, Instance, Enum, Content, plugin = setmetatable({}, {__index=forbidden}), nil, nil, nil, nil, nil
local require = forbidden
local vectorCalls = 0
local Vector3 = {new = function(x: number, y: number, z: number): any
 vectorCalls += 1; return {x, y, z}
end}
local Vector2 = {new = function(x: number, y: number): any
 vectorCalls += 1; return {x, y}
end}

local function equal(actual: any, expected: any): ()
 if type(expected) == "table" then
  assert(type(actual) == "table" and #actual == #expected, "array length differs")
  for index, value in ipairs(expected) do equal(actual[index], value) end
 elseif type(expected) == "number" then
  assert(type(actual) == "number" and math.abs(actual - expected) <= 1e-7, "value differs: " .. tostring(actual) .. " vs " .. tostring(expected))
 else assert(actual == expected, "value differs") end
end

local function service(options: any?): any
 options = options or {}
 local state: any = {creates=0, calls=0, resources={}, counts={}, sinceYield=0, maxSinceYield=0}
 local function touch(name: string): ()
  state.calls += 1; state.sinceYield += 1
  state.maxSinceYield = math.max(state.maxSinceYield, state.sinceYield)
  state.counts[name] = (state.counts[name] or 0) + 1
  if options.onCall then options.onCall(name, state) end
  if options.failAt == name then error("injected " .. name .. " failure") end
 end
 function state:CreateEditableMesh(...: any): any
  assert(select("#", ...) == 0, "blank standard EditableMesh creation only")
  self.creates += 1; touch("CreateEditableMesh")
  if options.memoryNil then return nil end
  local mesh: any = {destroyed=0, vertices={}, normals={}, uvs={}, faces={}, faceNormals={}, faceUVs={}, totals={}}
  table.insert(self.resources, mesh)
  local methods: any = {}
  local function add(name: string, target: string, value: any, base: number, stride: number): number?
   touch(name)
   mesh.totals[name] = (mesh.totals[name] or 0) + 1
   local id = base + mesh.totals[name] * stride
   if options.nilAt == name then return nil end
   if not options.compact then mesh[target][id] = value end
   mesh["last" .. target] = value
   return id
  end
  function methods:AddVertex(value: any): number? return add("AddVertex", "vertices", value, 1000, 19) end
  function methods:AddNormal(value: any): number? return add("AddNormal", "normals", value, 2000, 13) end
  function methods:AddUV(value: any): number? return add("AddUV", "uvs", value, 3000, 11) end
  function methods:AddTriangle(a: number, b: number, c: number): number?
   return add("AddTriangle", "faces", {a, b, c}, 9000, 7)
  end
  function methods:SetFaceNormals(face: number, ids: {number}): ()
   touch("SetFaceNormals"); assert(#ids == 3)
   if not options.compact then mesh.faceNormals[face] = ids end
   mesh.lastFaceNormals = ids
  end
  function methods:SetFaceUVs(face: number, ids: {number}): ()
   touch("SetFaceUVs"); assert(#ids == 3)
   if not options.compact then mesh.faceUVs[face] = ids end
   mesh.lastFaceUVs = ids
  end
  function methods:Destroy(): ()
   mesh.destroyed += 1
   if options.destroyFails then error("injected Destroy failure") end
  end
  setmetatable(mesh, {__index=function(_self: any, key: string): any
   if methods[key] then return methods[key] end
   error("unexpected EditableMesh member " .. key) -- Parent/IsA/GetService also fail.
  end, __newindex=function(self: any, key: string, value: any): ()
   assert(key ~= "Parent", "parenting is forbidden"); rawset(self, key, value)
  end})
  if options.onCreated then options.onCreated(mesh, state) end
  return mesh
 end
 return state
end

local function packed(semantic: string, componentType: number, size: number, count: number, normalized: boolean?): any
 local width = if componentType == 5121 then 1 elseif componentType == 5123 then 2 else 4
 return {semantic=semantic, componentType=componentType, type=if size == 1 then "SCALAR" elseif size == 2 then "VEC2" else "VEC3",
  count=count, normalized=normalized or false, byteLength=count * width * size, bytes=buffer.create(count * width * size)}
end
local function fixture(vertices: number?, triangles: number?, attributes: boolean?): any
 vertices, triangles = vertices or 3, triangles or 1
 local point = packed("POSITION", 5126, 3, vertices)
 local indices = packed("indices", 5125, 1, triangles * 3)
 for index = 0, vertices - 1 do
  buffer.writef32(point.bytes, index * 12, index + 0.5)
  -- Every consecutive triple is a real positive-area XY face, including the
  -- large-index fixture. Keep distinct x coordinates and the old last sample.
  buffer.writef32(point.bytes, index * 12 + 4, -index - (if index % 3 == 1 then 1 else 0))
  buffer.writef32(point.bytes, index * 12 + 8, 2.25)
 end
 for index = 0, triangles * 3 - 1 do buffer.writeu32(indices.bytes, index * 4, index % vertices) end
 local attrs: any = {POSITION=point}
 if attributes then
  attrs.NORMAL = packed("NORMAL", 5126, 3, vertices)
  attrs.TEXCOORD_0 = packed("TEXCOORD_0", 5126, 2, vertices)
  for index = 0, vertices - 1 do buffer.writef32(attrs.NORMAL.bytes, index * 12 + 8, 1) end
 end
 return {primitives={{mode=4, vertexCount=vertices, triangleCount=triangles, attributes=attrs, indices=indices}}}
end
local function alive(): boolean return true end
local function noYield(): () end
local function rejects(data: any, code: string, state: any?, guard: any?, yieldBatch: any?): any
 state = state or service()
 local beforeVectors = vectorCalls
 local ok, result = pcall(AssetMesh.create, data, state, guard or alive, yieldBatch or noYield)
 assert(not ok and type(result) == "table" and result.code == code, "expected " .. code .. ": " .. tostring(result))
 if state.creates == 0 then assert(vectorCalls == beforeVectors, "validation must precede vector constructors") end
 return state, result
end
`;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function runFixture(name, checks) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-asset-mesh-proof-'));
  const source = await readFile(modulePath, 'utf8');
  const harness = path.join(directory, `${name}.luau`);
  // Lexically inject value doubles; embed exact, unchanged production source.
  // No engine package, real services, datamodel, builder, or generated plugin.
  const body = `${doubles.split('local function rejects')[0]}\nlocal AssetMesh = (function()\n${source}\nend)()\nlocal function rejects${doubles.split('local function rejects')[1]}\n${checks}\nprint("asset-mesh ${name} passed")\n`;
  try {
    await writeFile(harness, body);
    if (compile) run(compile, ['--null', harness]);
    const output = run(runtime, [harness]);
    assert.ok(output.includes(`asset-mesh ${name} passed`));
    if (process.env.ARCANE_ASSET_MESH_KEEP_PROOF === '1') {
      await writeFile(path.join(directory, 'proof.json'), JSON.stringify({
        name, modulePath, moduleSha256: sha(source), harnessSha256: sha(body), runtime, compile,
        output, engineVerification: 'pending', verification: 'standalone Luau VM with injected doubles',
      }, null, 2) + '\n');
      process.stdout.write(`private proof: ${harness}\n`);
    }
  } finally {
    if (process.env.ARCANE_ASSET_MESH_KEEP_PROOF !== '1') {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
      assert.ok(path.basename(directory).startsWith('arcane-asset-mesh-proof-'));
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test('AssetMesh compiles offline without resolving services at module load', { skip: !compile }, () => {
  run(compile, ['--null', modulePath]);
});

test('actual resource, exact face winding, normal/UV seams, meters and separate primitive mappings', runtimeOptions, async () => {
  await runFixture('exact-seams', `
assert(table.isfrozen(AssetMesh) and table.isfrozen(AssetMesh.LIMITS))
assert(vectorCalls == 0, "module load must not construct engine values")
local data: any = {object={exportTransform={999}, pivot={100}, scale={7}, engineVerification="verified"}, material={}, provenance={},
 primitives={${exactPrimitive}, ${exactPrimitive}}}
local state = service()
local result = AssetMesh.create(data, state, alive, noYield)
assert(result.editableMesh == state.resources[1] and state.creates == 1)
assert(result.editableMesh.destroyed == 0 and result.engineVerification == "pending")
assert(result.coordinateSpace == "export-meters" and result.vertexCount == 10 and result.triangleCount == 4)
assert(result.verified == nil and result.primitives[1] ~= result.primitives[2])
local expectedPoints = {{-1.5,2.25,0.125},{3.5,-4,5.75},{0,1,-2},{-1.5,2.25,0.125},{-5,7.25,-7.625}}
local expectedNormals = {{0,0,1},{0,1,0},{1,0,0},{0,0,-1},{0,-1,0}}
local expectedUVs = {{-2,4},{0.5,0.25},{1,1},{0.75,-0.5},{-0.25,0.75}}
for index, mapping in ipairs(result.primitives) do
 assert(#mapping.vertexIds == 5 and #mapping.faceIds == 2 and #mapping.normalIds == 5 and #mapping.uvIds == 5)
 for vertex = 1, 5 do
  equal(result.editableMesh.vertices[mapping.vertexIds[vertex]], expectedPoints[vertex])
  equal(result.editableMesh.normals[mapping.normalIds[vertex]], expectedNormals[vertex])
  equal(result.editableMesh.uvs[mapping.uvIds[vertex]], expectedUVs[vertex])
 end
 local corners = {{3,1,2},{4,3,5}}
 for face, order in ipairs(corners) do
  equal(result.editableMesh.faces[mapping.faceIds[face]], {mapping.vertexIds[order[1]],mapping.vertexIds[order[2]],mapping.vertexIds[order[3]]})
  equal(result.editableMesh.faceNormals[mapping.faceIds[face]], {mapping.normalIds[order[1]],mapping.normalIds[order[2]],mapping.normalIds[order[3]]})
  equal(result.editableMesh.faceUVs[mapping.faceIds[face]], {mapping.uvIds[order[1]],mapping.uvIds[order[2]],mapping.uvIds[order[3]]})
 end
 assert(mapping.vertexIds[1] ~= mapping.vertexIds[4], "coincident seam vertices must not merge")
end
assert(result.primitives[1].vertexIds[1] ~= result.primitives[2].vertexIds[1])
assert(result.primitives[1].normalIds[1] ~= result.primitives[2].normalIds[1])
assert(result.primitives[1].uvIds[1] ~= result.primitives[2].uvIds[1])
assert(state.counts.SetFaceNormals == 4 and state.counts.SetFaceUVs == 4)
-- Maps are invocation-owned, including optional empty attributes.
local second = AssetMesh.create(fixture(), state, alive, noYield)
assert(second.editableMesh ~= result.editableMesh)
assert(#second.primitives[1].normalIds == 0 and #second.primitives[1].uvIds == 0)
assert(state.counts.SetFaceNormals == 4 and state.counts.SetFaceUVs == 4)
`);
});

test('planar XY faces retain exact zero thickness and distinct UV seam vertices', runtimeOptions, async () => {
  const points = [0,0,0, 2,0,0, 2,1,0, 0,1,0, 0,0,0];
  const planar = `{mode=4,vertexCount=5,triangleCount=2,attributes={
 POSITION=${descriptor('POSITION','VEC3',5126,points)},
 NORMAL=${descriptor('NORMAL','VEC3',5126,[0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1])},
 TEXCOORD_0=${descriptor('TEXCOORD_0','VEC2',5126,[0,0, 1,0, 1,1, 0,1, 0.25,0.5])}},
 indices=${descriptor('indices','SCALAR',5123,[0,1,2,4,2,3])}}`;
  await runFixture('planar-seams', `
local state=service()
local result=AssetMesh.create({primitives={${planar}}},state,alive,noYield)
local m=result.primitives[1]
assert(state.creates==1 and state.counts.AddVertex==5 and state.counts.AddTriangle==2)
assert(result.vertexCount==5 and result.triangleCount==2 and result.coordinateSpace=='export-meters' and result.engineVerification=='pending')
local expected={{0,0,0},{2,0,0},{2,1,0},{0,1,0},{0,0,0}}
for i,id in ipairs(m.vertexIds) do equal(result.editableMesh.vertices[id],expected[i]);assert(result.editableMesh.vertices[id][3]==0,'no physical-size padding may alter source vertices') end
assert(m.vertexIds[1]~=m.vertexIds[5] and m.uvIds[1]~=m.uvIds[5],'UV seam vertices remain distinct')
equal(result.editableMesh.uvs[m.uvIds[1]],{0,0});equal(result.editableMesh.uvs[m.uvIds[5]],{0.25,0.5})
equal(result.editableMesh.faces[m.faceIds[1]],{m.vertexIds[1],m.vertexIds[2],m.vertexIds[3]})
equal(result.editableMesh.faces[m.faceIds[2]],{m.vertexIds[5],m.vertexIds[3],m.vertexIds[4]})
equal(result.editableMesh.faceUVs[m.faceIds[2]],{m.uvIds[5],m.uvIds[3],m.uvIds[4]})
assert(result.editableMesh.destroyed==0)
`);
});

test('true zero-area and below-policy faces refuse before allocating even after a valid primitive', runtimeOptions, async () => {
  const cases = [
    {points:[0,0,0, 1,1,1, 2,2,2],indices:[0,1,2]}, // Positive AABB extents do not prove area.
    {points:[0,0,0, 1,0,0, 0,0,0],indices:[0,1,2]},
    {points:[0,0,0, 1,0,0, 0,1,0],indices:[0,1,1]},
    {points:[0,0,0, 1,0,0, 0,1e-11,0],indices:[0,1,2]},
  ];
  const checks = cases.map(({points,indices}) => `do
 local invalid={mode=4,vertexCount=3,triangleCount=1,attributes={POSITION=${descriptor('POSITION','VEC3',5126,points)}},indices=${descriptor('indices','SCALAR',5123,indices)}}
 local state,err=rejects({primitives={fixture().primitives[1],invalid}},'INPUT')
 assert(state.creates==0 and state.calls==0 and #state.resources==0,'all face-area checks precede the first engine call')
 assert(string.find(err.message,'doubled area',1,true),'refusal must come from actual triangle area')
end`).join('\n');
  await runFixture('triangle-area', `${checks}
-- The policy does not reject every thin triangle: a small positive area above
-- 1e-10 survives its actual float32 input without widening or geometry repair.
local small={mode=4,vertexCount=3,triangleCount=1,attributes={POSITION=${descriptor('POSITION','VEC3',5126,[0,0,0, 1,0,0, 0,1e-9,0])}},indices=${descriptor('indices','SCALAR',5123,[0,1,2])}}
local result=AssetMesh.create({primitives={small}},service(),alive,noYield)
local y=result.editableMesh.vertices[result.primitives[1].vertexIds[3]][2]
assert(y>1e-10 and y<2e-9 and result.editableMesh.destroyed==0)
`);
});

test('little-endian uint8/16/32 indices, generated uint32 and normalized uint8/16 UVs', runtimeOptions, async () => {
  const indexChecks = [5121, 5123, 5125].map(component => `
do
 local data = fixture(${component === 5121 ? 3 : 300})
 data.primitives[1].indices = ${descriptor('indices', 'SCALAR', component, component === 5121 ? [2, 0, 1] : [256, 1, 299])}
 local state = service(); local result = AssetMesh.create(data, state, alive, noYield)
 local m = result.primitives[1]
 equal(result.editableMesh.faces[m.faceIds[1]], {m.vertexIds[${component === 5121 ? 3 : 257}],m.vertexIds[${component === 5121 ? 1 : 2}],m.vertexIds[${component === 5121 ? 2 : 300}]})
end`).join('\n');
  const uvChecks = [5121, 5123].map(component => {
    const maximum = component === 5121 ? 255 : 65535;
    const middle = component === 5121 ? 128 : 32768;
    return `do
 local data = fixture(); data.primitives[1].attributes.TEXCOORD_0 = ${descriptor('TEXCOORD_0', 'VEC2', component, [0, maximum, middle, 0, maximum, middle], true)}
 local result = AssetMesh.create(data, service(), alive, noYield); local m = result.primitives[1]
 equal(result.editableMesh.uvs[m.uvIds[1]], {0,1})
 equal(result.editableMesh.uvs[m.uvIds[2]], {${middle / maximum},0})
 equal(result.editableMesh.uvs[m.uvIds[3]], {1,${middle / maximum}})
 equal(result.editableMesh.faceUVs[m.faceIds[1]], {m.uvIds[1],m.uvIds[2],m.uvIds[3]})
end`;
  }).join('\n');
  await runFixture('integer-formats', `${indexChecks}\n${uvChecks}
local data = fixture(6,2); data.primitives[1].indices.source = nil -- host-generated dense 5125
local result = AssetMesh.create(data, service(), alive, noYield); local m = result.primitives[1]
equal(result.editableMesh.faces[m.faceIds[2]], {m.vertexIds[4],m.vertexIds[5],m.vertexIds[6]})
`);
});

test('all descriptors, dense ranges, counts and unsupported formats fail before allocation', runtimeOptions, async () => {
  await runFixture('descriptor-errors', `
local cases = {
 {"INPUT", function(d) d.primitives[1].attributes.POSITION = nil end},
 {"INPUT", function(d) d.primitives[1].indices = nil end},
 {"INPUT", function(d) d.primitives[1].attributes.NORMAL = false end},
 {"INPUT", function(d) d.primitives[1].attributes = setmetatable({}, {__index=function() error("must not run") end}) end},
 {"INPUT", function(d) d.primitives[1] = nil end},
 {"INPUT", function(d) d.primitives[2] = d.primitives[1]; d.primitives[1] = nil end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.count = 2 end},
 {"INPUT", function(d) d.primitives[1].indices.count = 2 end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.byteLength = 35 end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.bytes = buffer.create(35) end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.bytes = buffer.create(37) end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.bytes = "serialized base64" end},
 {"INPUT", function(d) d.primitives[1].attributes.POSITION.bytes = {} end},
 {"BUDGET", function(d) d.primitives[1].vertexCount = 60001 end},
 {"BUDGET", function(d) d.primitives[1].triangleCount = 20001 end},
 {"BUDGET", function(d) d.primitives[1].vertexCount = 0 end},
 {"BUDGET", function(d) d.primitives[1].vertexCount = 2.5 end},
 {"BUDGET", function(d) d.primitives[1].triangleCount = math.huge end},
 {"BUDGET", function(d) d.primitives[1].indices.count = 0/0 end},
 {"BUDGET", function(d) d.primitives.extra = d.primitives[1] end},
 {"BUDGET", function(d) d.primitives[20001] = d.primitives[1] end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].mode = 5 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TANGENT = {} end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TEXCOORD_1 = {} end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.COLOR_0 = {} end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.semantic = "NORMAL" end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.type = "VEC2" end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.byteOffset = 4 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.byteStride = 16 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.componentType = 5123 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.POSITION.normalized = true end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].indices.normalized = true end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].indices.componentType = 5126 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].indices.type = "VEC3" end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.NORMAL.normalized = nil end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.NORMAL.componentType = 5122 end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TEXCOORD_0.normalized = true end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TEXCOORD_0 = packed("TEXCOORD_0",5121,2,3) end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TEXCOORD_0 = packed("TEXCOORD_0",5123,2,3) end},
 {"UNSUPPORTED_ATTRIBUTE", function(d) d.primitives[1].attributes.TEXCOORD_0 = packed("TEXCOORD_0",5125,2,3,true) end},
}
for _, case in ipairs(cases) do
 local data = fixture(3,1,true); case[2](data)
 local state = rejects(data, case[1]); assert(state.creates == 0 and #state.resources == 0)
end
rejects(nil, "INPUT"); rejects({}, "INPUT"); rejects({primitives={}}, "INPUT")
rejects(setmetatable({}, {__index=function() error("must not execute") end}), "INPUT")
local data = fixture(); local ok, err = pcall(AssetMesh.create, data, service(), nil, noYield)
assert(not ok and err.code == "INPUT")
ok, err = pcall(AssetMesh.create, data, service(), alive, nil); assert(not ok and err.code == "INPUT")
`);
});

test('last-stream nonfinite values, coordinate bounds and triangle index errors precede every engine call', runtimeOptions, async () => {
  await runFixture('value-errors', `
for _, semantic in ipairs({"POSITION","NORMAL","TEXCOORD_0"}) do
 for _, value in ipairs({0/0, math.huge, -math.huge, 1000000.0625, -1000000.0625}) do
  local data = fixture(300,1,true); table.insert(data.primitives, fixture(3,1,true).primitives[1])
  local input = data.primitives[2].attributes[semantic]
  buffer.writef32(input.bytes, input.byteLength - 4, value)
  local state = rejects(data,"INPUT"); assert(state.creates == 0)
 end
end
for _, component in ipairs({5121,5123,5125}) do
 local data = fixture(300)
 local input = packed("indices",component,1,3); data.primitives[1].indices = input
 local width = if component == 5121 then 1 elseif component == 5123 then 2 else 4
 local writer = if width == 1 then buffer.writeu8 elseif width == 2 then buffer.writeu16 else buffer.writeu32
 writer(input.bytes,0,0); writer(input.bytes,width,1); writer(input.bytes,width*2,2^(8*width)-1)
 local state = rejects(data,"INPUT"); assert(state.creates == 0)
end
local data = fixture(); buffer.writeu32(data.primitives[1].indices.bytes,8,3)
assert(rejects(data,"INPUT").creates == 0)
-- Inclusive +/-1e6 bounds and tiled finite UVs pass without clamping/conversion.
data = fixture(3,1,true)
for _, semantic in ipairs({"POSITION","NORMAL","TEXCOORD_0"}) do
 buffer.writef32(data.primitives[1].attributes[semantic].bytes,0,-1000000)
 buffer.writef32(data.primitives[1].attributes[semantic].bytes,4,1000000)
end
local result = AssetMesh.create(data,service(),alive,noYield); local m = result.primitives[1]
equal(result.editableMesh.vertices[m.vertexIds[1]],{-1000000,1000000,2.25})
equal(result.editableMesh.normals[m.normalIds[1]],{-1000000,1000000,1})
equal(result.editableMesh.uvs[m.uvIds[1]],{-1000000,1000000})
`);
});

test('nil allocation, engine exceptions and malformed returned IDs clean up only the owned resource', runtimeOptions, async () => {
  await runFixture('engine-cleanup', `
local state = service({memoryNil=true}); rejects(fixture(),"MEMORY",state)
assert(state.creates == 1 and #state.resources == 0)
state = service({failAt="CreateEditableMesh"}); rejects(fixture(),"ENGINE",state)
assert(state.creates == 1 and #state.resources == 0)
for _, method in ipairs({"AddVertex","AddNormal","AddUV","AddTriangle","SetFaceNormals","SetFaceUVs"}) do
 state = service({failAt=method}); rejects(fixture(3,1,true),"ENGINE",state)
 assert(#state.resources == 1 and state.resources[1].destroyed == 1, "owned cleanup required for " .. method)
end
for _, method in ipairs({"AddVertex","AddNormal","AddUV","AddTriangle"}) do
 state = service({nilAt=method}); rejects(fixture(3,1,true),"BUDGET",state)
 assert(state.resources[1].destroyed == 1)
end
state = service({failAt="AddVertex",destroyFails=true})
local _, err = rejects(fixture(),"ENGINE",state)
assert(state.resources[1].destroyed == 1 and string.find(err.message,"destruction also failed",1,true))
local unrelated = AssetMesh.create(fixture(),service(),alive,noYield)
state = service({failAt="AddUV"}); rejects(fixture(3,1,true),"ENGINE",state)
assert(unrelated.editableMesh.destroyed == 0)
local recovered = AssetMesh.create(fixture(),service(),alive,noYield)
assert(recovered.editableMesh.destroyed == 0 and recovered.primitives[1].vertexIds ~= unrelated.primitives[1].vertexIds)
`);
});

test('guards before/after creation and mutation, and both sides of real coroutine yields', runtimeOptions, async () => {
  await runFixture('cancellation', `
for _, guard in ipairs({function() return false end,function() return 1 end,function() error("guard died") end}) do
 local state = rejects(fixture(),"CANCELLED",nil,guard); assert(state.creates == 0)
end
-- Small fixtures do not yield: the second check is immediately before allocation.
local checks=0; local preCreate=service()
rejects(fixture(),"CANCELLED",preCreate,function() checks+=1; return checks<2 end)
assert(preCreate.creates==0)
checks=0; local preYield=service(); local callbackCalls=0
rejects(fixture(600),"CANCELLED",preYield,function() checks+=1; return checks<2 end,function() callbackCalls+=1 end)
assert(preYield.creates==0 and callbackCalls==0, "guard before yield must prevent callback")
for _, method in ipairs({"CreateEditableMesh","AddVertex","AddNormal","AddUV","AddTriangle","SetFaceNormals","SetFaceUVs"}) do
 local allowed = true
 local state = service({onCall=function(name) if name == method then allowed=false end end})
 rejects(fixture(3,1,true),"CANCELLED",state,function() return allowed end)
 assert(state.resources[1].destroyed == 1, "post-creation guard must retain resource for cleanup")
 assert(state.counts[method] == 1)
end
-- A callback may really suspend; revoke while suspended in validation/engine pass.
for _, enginePass in ipairs({false,true}) do
 local state = service(); local allowed = true; local yielded = 0
 local thread = coroutine.create(function()
  return AssetMesh.create(fixture(600,2,true),state,function() return allowed end,function()
   yielded += 1; state.sinceYield=0; coroutine.yield()
  end)
 end)
 local ok, result = coroutine.resume(thread); assert(ok and coroutine.status(thread) == "suspended")
 if enginePass then
  while state.creates == 0 do ok,result=coroutine.resume(thread); assert(ok and coroutine.status(thread)=="suspended") end
 end
 allowed=false; ok,result=coroutine.resume(thread)
 assert(not ok and result.code=="CANCELLED" and coroutine.status(thread)=="dead")
 assert(yielded > 0)
 if enginePass then assert(state.resources[1].destroyed == 1) else assert(state.creates == 0) end
end
-- Also handle an injected creation that itself suspends before returning its resource.
local allowedDuringCreate=true
local yieldingFactory=service({onCreated=function() coroutine.yield() end})
local creationThread=coroutine.create(function()
 return AssetMesh.create(fixture(),yieldingFactory,function() return allowedDuringCreate end,noYield)
end)
local resumed, creationResult=coroutine.resume(creationThread)
assert(resumed and coroutine.status(creationThread)=="suspended" and yieldingFactory.resources[1].destroyed==0)
allowedDuringCreate=false; resumed,creationResult=coroutine.resume(creationThread)
assert(not resumed and creationResult.code=="CANCELLED" and yieldingFactory.resources[1].destroyed==1)
-- Before-yield guard revocation must prevent invoking the callback at all.
local allowed=true; local yields=0
local state=service({onCall=function(name,s) if name=="AddVertex" and s.counts.AddVertex==255 then allowed=false end end})
rejects(fixture(600),"CANCELLED",state,function() return allowed end,function() yields+=1 end)
assert(state.resources[1].destroyed==1 and state.counts.AddVertex==255)
-- Throwing injected yield callback after allocation also destroys the resource.
state=service()
rejects(fixture(600),"ENGINE",state,alive,function() if state.creates>0 then error("yield failed") end end)
assert(state.resources[1].destroyed==1)
`);
});

test('validated values are private snapshots across yields and primitive descriptor mutation', runtimeOptions, async () => {
  await runFixture('snapshot', `
local data=fixture(600,2,true); local state=service(); local mutated=false
local result=AssetMesh.create(data,state,alive,function()
 if state.creates>0 and not mutated then
  mutated=true
  for _, input in pairs(data.primitives[1].attributes) do
   for at=0,input.byteLength-4,4 do buffer.writef32(input.bytes,at,0/0) end
   input.count=1; input.componentType=5121
  end
  buffer.writeu32(data.primitives[1].indices.bytes,0,4294967295)
  data.primitives[1].attributes.TANGENT={}; data.primitives[1].vertexCount=1
  data.primitives[1]=nil
 end
end)
assert(mutated and result.editableMesh.destroyed==0)
local m=result.primitives[1]
equal(result.editableMesh.vertices[m.vertexIds[600]],{599.5,-599,2.25})
equal(result.editableMesh.normals[m.normalIds[600]],{0,0,1})
equal(result.editableMesh.faces[m.faceIds[1]],{m.vertexIds[1],m.vertexIds[2],m.vertexIds[3]})
equal(result.editableMesh.faceUVs[m.faceIds[2]],{m.uvIds[4],m.uvIds[5],m.uvIds[6]})
-- Captured buffers cannot change even during validation's batch yields.
data=fixture(600); state=service(); mutated=false
local captured=AssetMesh.create(data,state,function() end,function()
 mutated=true
 buffer.writef32(data.primitives[1].attributes.POSITION.bytes,599*12,0/0)
end)
assert(mutated and captured.editableMesh.destroyed==0)
equal(captured.editableMesh.vertices[captured.primitives[1].vertexIds[600]],{599.5,-599,2.25})
-- Later primitive buffers not yet captured are still validated before allocation.
data={primitives=table.create(300,fixture().primitives[1])}; state=service()
rejects(data,"INPUT",state,alive,function()
 buffer.writef32(data.primitives[300].attributes.POSITION.bytes,0,0/0)
end)
assert(state.creates==0)
assert(state.creates==0)
`);
});

test('inclusive 60000 vertices/20000 triangles and aggregate budgets with bounded work', runtimeOptions, async () => {
  await runFixture('max-budget', `
local data=fixture(60000,20000,true); local state=service({compact=true}); local yields=0
local result=AssetMesh.create(data,state,alive,function() yields+=1; state.sinceYield=0 end)
assert(result.vertexCount==60000 and result.triangleCount==20000 and yields>1000)
assert(state.maxSinceYield<=AssetMesh.LIMITS.batch*3+1, "engine work between yields must be bounded")
assert(state.counts.AddVertex==60000 and state.counts.AddTriangle==20000)
assert(state.counts.AddNormal==60000 and state.counts.AddUV==60000)
assert(state.counts.SetFaceNormals==20000 and state.counts.SetFaceUVs==20000)
local m=result.primitives[1]
assert(#m.vertexIds==60000 and #m.faceIds==20000 and #m.normalIds==60000 and #m.uvIds==60000)
equal(result.editableMesh.lastvertices,{59999.5,-59999,2.25})
equal(result.editableMesh.lastfaces,{m.vertexIds[59998],m.vertexIds[59999],m.vertexIds[60000]})
equal(result.editableMesh.lastFaceNormals,{m.normalIds[59998],m.normalIds[59999],m.normalIds[60000]})
equal(result.editableMesh.lastFaceUVs,{m.uvIds[59998],m.uvIds[59999],m.uvIds[60000]})
assert(result.editableMesh.destroyed==0 and result.engineVerification=="pending")
table.insert(data.primitives,fixture().primitives[1])
assert(rejects(data,"BUDGET").creates==0)
data=fixture(30000,10000); table.insert(data.primitives,fixture(30000,10000).primitives[1])
local split=AssetMesh.create(data,service({compact=true}),alive,noYield)
assert(split.vertexCount==60000 and split.triangleCount==20000 and #split.primitives==2)
assert(split.primitives[1].vertexIds[1] ~= split.primitives[2].vertexIds[1])
data=fixture(3,20000); table.insert(data.primitives,fixture().primitives[1])
assert(rejects(data,"BUDGET").creates==0)
data=fixture(60000); table.insert(data.primitives,fixture().primitives[1])
assert(rejects(data,"BUDGET").creates==0)
-- Maximum descriptor cardinality also stays bounded and preserves every primitive.
data={primitives=table.create(20000,fixture().primitives[1])}
state=service({compact=true})
local many=AssetMesh.create(data,state,alive,function() state.sinceYield=0 end)
assert(#many.primitives==20000 and many.vertexCount==60000 and many.triangleCount==20000)
assert(many.primitives[1].vertexIds[1] ~= many.primitives[20000].vertexIds[1])
assert(state.maxSinceYield<=AssetMesh.LIMITS.batch*3+1)
`);
});


test('existing throwing void operation guards work and fence revocation without boolean consent', runtimeOptions, async () => {
  await runFixture('void-guard', `
local state=service()
local result=AssetMesh.create(fixture(),state,function() end,noYield)
assert(result.editableMesh==state.resources[1] and result.engineVerification=="pending")
local allowed=true
state=service({onCall=function(name) if name=="AddTriangle" then allowed=false end end})
rejects(fixture(),"CANCELLED",state,function() if not allowed then error("ownership retired") end end)
assert(state.resources[1].destroyed==1)
`);
});
