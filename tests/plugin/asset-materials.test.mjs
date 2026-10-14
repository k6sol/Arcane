import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modulePath = path.join(root, 'plugin/src/AssetMaterials.luau');
const runtime = process.env.ARCANE_LUAU_BIN;
const compiler = process.env.ARCANE_LUAU_COMPILE ?? (runtime
  ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile')
  : undefined);
const options = {skip: !runtime && 'Standalone Luau runtime not configured.'};

function run(binary, args) {
  const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 15_000, windowsHide: true});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

const doubles = `
local unexpected = 0
local function forbidden(): never unexpected += 1; error("forbidden real engine access") end
local blocked = setmetatable({}, {__index=forbidden, __newindex=forbidden})
local game, workspace, plugin, Instance, Color3, Content, Enum, AssetService, task, Vector2 = blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked
local require = forbidden
local function alive(): boolean return true end
local function close(actual: number, expected: number): ()
 assert(math.abs(actual-expected) < 1e-12, "scalar differs")
end
local function fixture(): any
 return {baseColor={0.3,0.4,0.5,1}, metallic=0.15, roughness=0.7, alphaMode="OPAQUE", alphaCutoff=0.5,
  doubleSided=false, normalScale=1, sha256=string.rep("a",64)}
end
local function factories(options: any?): (any, any)
 options = options or {}
 local state: any = {creates=0, colors=0, destroyed=0, writes={}, reads={}, resources={},
  imageCreates=0,imageDestroyed=0,imageWrites={},images={},contentCalls=0,vectorCalls=0,events={}}
 local function event(name: string): () state.events[#state.events+1]=name end
 local function read(name: string): ()
  state.reads[name] = (state.reads[name] or 0) + 1
  if options.onRead then options.onRead(name,state) end
  if options.readFails == name then error("opaque injected detail") end
 end
 local result: any = {}
 result.colorFromLinear = function(r: number,g: number,b: number): any
  state.colors += 1; state.rgb = {r,g,b}
  if options.onColor then options.onColor(state) end
  if options.colorFails then error(options.errorValue or "opaque injected detail") end
  if options.colorNil then return nil end
  -- Test adapter encodes glTF linear RGB; this is not an invented engine method.
  local function encode(v: number): number
   return if v <= 0.0031308 then 12.92*v else 1.055*v^(1/2.4)-0.055
  end
  return table.freeze({R=encode(r),G=encode(g),B=encode(b)})
 end
 result.vector2 = function(x: number,y: number): any
  state.vectorCalls+=1; event("vector")
  if options.onVector then options.onVector(state) end
  if options.vectorFails then error(options.errorValue or "opaque vector detail") end
  return table.freeze({X=x,Y=y})
 end
 result.createEditableImage = function(imageOptions: any): any
  state.imageCreates+=1
  local ordinal=state.imageCreates
  event("image-create-"..ordinal)
  assert(imageOptions.Size.X==1 and imageOptions.Size.Y==1)
  local keys=0; for k in pairs(imageOptions) do assert(k=="Size"); keys+=1 end; assert(keys==1)
  if options.imageCreateFails==ordinal then error(options.errorValue or "opaque image detail") end
  if options.imageNil==ordinal then return nil end
  if options.reuseImage and ordinal==2 then return state.images[1] end
  local size=if options.badSize==ordinal then table.freeze({X=2,Y=1}) else imageOptions.Size
  local imageState: any = {destroyed=0,ordinal=ordinal}
  local image: any = setmetatable({}, {
   __index=function(_self: any,key: string): any
    if key=="Size" then return size end
    if key=="WritePixelsBuffer" then return function(_self: any,origin: any,extent: any,pixels: buffer): ()
     assert(origin.X==0 and origin.Y==0 and extent.X==1 and extent.Y==1)
     assert(typeof(pixels)=="buffer" and buffer.len(pixels)==4)
     local bytes={buffer.readu8(pixels,0),buffer.readu8(pixels,1),buffer.readu8(pixels,2),buffer.readu8(pixels,3)}
     assert(bytes[1]==bytes[2] and bytes[2]==bytes[3] and bytes[4]==255)
     state.imageWrites[#state.imageWrites+1]={image=_self,bytes=bytes,buffer=pixels}
     imageState.bytes=bytes; event("image-write-"..ordinal)
     if options.onImageWrite then options.onImageWrite(ordinal,state,pixels) end
     if options.imageWriteFails==ordinal then error(options.errorValue or "opaque pixel detail") end
    end end
    if key=="Destroy" then return function(): ()
     imageState.destroyed+=1; state.imageDestroyed+=1; event("image-destroy-"..ordinal)
     if options.imageDestroyFails==ordinal then error("opaque cleanup detail") end
    end end
    if key=="proof" then return imageState end
    error("unexpected EditableImage member: "..key) -- Object, never Parent/IsA
   end,
   __newindex=function() error("EditableImage property writes forbidden") end,
  })
  state.images[#state.images+1]=image
  if options.onImageCreate then options.onImageCreate(ordinal,state) end
  return image
 end
 result.contentFromObject = function(image: any): any
  state.contentCalls+=1; event("content-"..state.contentCalls)
  assert(image==state.images[state.contentCalls])
  if options.onContent then options.onContent(state.contentCalls,state) end
  if options.contentFails==state.contentCalls then error(options.errorValue or "opaque content detail") end
  if options.contentNil==state.contentCalls then return nil end
  return table.freeze({Object=image})
 end
 result.createSurfaceAppearanceAsync = function(maps: any): any
  state.creates += 1
  event("surface-create")
  local count=0
  for key in pairs(maps) do assert(key=="MetalnessMap" or key=="RoughnessMap"); count+=1 end
  assert(count==2 and #state.imageWrites==state.imageCreates and maps.MetalnessMap.Object==state.images[state.imageCreates-1]
   and maps.RoughnessMap.Object==state.images[state.imageCreates] and maps.MetalnessMap.Object~=maps.RoughnessMap.Object)
  state.maps=maps
  if options.createFails then error(options.errorValue or "opaque injected detail") end
  if options.createNil then return nil end
  local fields: any = {EmissiveStrength=17}
  if options.parented then fields.Parent = {} end
  local appearance: any = setmetatable({}, {
   __index=function(_self: any,key: string): any
    read(key)
    if key == "Parent" then return fields.Parent end
    if key == "IsA" then return function(_self: any,class: string): boolean
     assert(class == "SurfaceAppearance"); return not options.wrongClass
    end end
    if key == "Destroy" then return function(): ()
     state.destroyed += 1
     event("surface-destroy")
     if options.destroyFails then error("opaque cleanup detail") end
    end end
    assert(fields[key] ~= nil, "unexpected SurfaceAppearance member: " .. key)
    return fields[key]
   end,
   __newindex=function(_self: any,key: string,value: any): ()
    assert(key == "EmissiveStrength", "unexpected property write: " .. key)
    state.writes[#state.writes+1] = {key,value}
    if options.onWrite then options.onWrite(key,state) end
    if options.writeFails then error(options.errorValue or "opaque injected detail") end
    fields[key] = value
   end,
  })
  state.resources[#state.resources+1] = appearance
  if options.onCreate then options.onCreate(state) end
  return appearance
 end
 return result,state
end
`;

async function vm(name, body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-asset-materials-'));
  try {
    const source = await readFile(modulePath, 'utf8');
    const harness = path.join(directory, 'proof.luau');
    // Exact production source, lexical doubles only: no preprocessing/builder,
    // engine package, decoded images, provider, services, app or Studio session.
    await writeFile(harness, `${doubles}\nlocal AssetMaterials = (function()\n${source}\nend)()\n
local function rejects(material: any, code: string, field: string?, injected: any?, guard: any?): (any, any)
 local f,s = factories(injected)
 local ok,e = pcall(AssetMaterials.create,material,f,guard or alive)
 assert(not ok and type(e)=="table" and e.code==code, "expected " .. code)
 assert(table.isfrozen(e) and type(e.message)=="string")
 if field then assert(e.field==field,"error field differs: " .. tostring(e.field)) end
 if code=="UNSUPPORTED_MATERIAL" or code=="UNSUPPORTED_TEXTURE" then
  assert(s.creates==0 and s.colors==0 and s.imageCreates==0, "unsupported mapping must precede constructors")
 end
 return s,e
end
${body}\nassert(unexpected==0)\nprint("asset-materials ${name} passed")\n`);
    if (compiler) run(compiler, ['--null', harness]);
    assert.ok(run(runtime, [harness]).includes(`asset-materials ${name} passed`));
  } finally {
    // Validate the absolute target before a single-shell-independent deletion.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-asset-materials-'));
    await rm(directory, {recursive: true, force: true});
  }
}

test('standalone compiler accepts exact module', {skip: !compiler}, () => {
  run(compiler, ['--null', modulePath]);
});

test('sidecar has no live services, attachment, upload or import dependencies; only injected constant maps', async () => {
  const source = await readFile(modulePath, 'utf8');
  assert.ok(source.startsWith('--!strict\n'));
  const code = source.replace(/--[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
  assert.doesNotMatch(code, /\b(?:game|workspace|plugin|Instance|AssetService|task|require)\b/);
  assert.doesNotMatch(code, /\b(?:Vector2|Color3|Content)\s*\.|CreateAsset|HttpService|Parent\s*=/);
  assert.doesNotMatch(code, /\.Metalness\s*=|\.Roughness\s*=|\.Reflectance\s*=|\.Material\s*=/);
});

test('pure plan preserves scalar data in detached deeply frozen snapshots', options, async () => {
  await vm('snapshot', `
assert(table.isfrozen(AssetMaterials))
local m = fixture(); m.doubleSided=true; m.normalScale=-2; m.alphaCutoff=0.75
m.emission={factor={0.1,0.2,0.3},strength=0}
local p = AssetMaterials.plan(m)
assert(p.engineVerification=="pending" and p.requiresSurfaceAppearance)
assert(p.metallic==0.15 and p.roughness==0.7 and p.transparency==0 and p.emissiveStrength==0 and p.doubleSided)
assert(p.supported and p.emissionSupport=="zero-only" and #p.limitations==3)
assert(p.source.sha256==m.sha256 and p.source.alphaCutoff==0.75 and p.source.normalScale==-2)
assert(p.source.emission.strength==0 and p.source.emission.factor[2]==0.2)
for _,v in ipairs({p,p.source,p.source.baseColor,p.baseColorLinear,p.source.emission,p.source.emission.factor,
 p.constantMaps,p.constantMaps.MetalnessMap,p.constantMaps.MetalnessMap.rgba,p.constantMaps.RoughnessMap,p.limitations,AssetMaterials.LIMITS}) do assert(table.isfrozen(v)) end
assert(p.source~=m and p.source.baseColor~=m.baseColor and p.source.emission~=m.emission)
m.baseColor[1]=1; m.emission.factor[2]=1; m.doubleSided=false
assert(p.baseColorLinear[1]==0.3 and p.source.baseColor[1]==0.3 and p.source.emission.factor[2]==0.2 and p.doubleSided)
assert(not pcall(function() p.metallic=1 end))
`);
});

test('detached creation uses only documented properties and injected color conversion', options, async () => {
  await vm('properties', `
local m=fixture(); m.doubleSided=true
local f,s=factories()
local result=AssetMaterials.create(m,f,alive)
assert(s.creates==1 and s.colors==1 and s.destroyed==0 and #s.writes==1)
assert(s.imageCreates==2 and s.imageDestroyed==0 and #s.imageWrites==2 and s.contentCalls==2)
assert(result.editableImages.MetalnessMap==s.images[1] and result.editableImages.RoughnessMap==s.images[2])
assert(s.imageWrites[1].bytes[1]==38 and s.imageWrites[2].bytes[1]==179)
assert(s.imageWrites[1].buffer~=s.imageWrites[2].buffer)
assert(s.maps.MetalnessMap.Object==result.editableImages.MetalnessMap and s.maps.RoughnessMap.Object==result.editableImages.RoughnessMap)
assert(s.writes[1][1]=="EmissiveStrength" and s.writes[1][2]==0)
assert(result.surfaceAppearance==s.resources[1] and result.surfaceAppearance.Parent==nil)
assert(result.meshPartProperties.Transparency==0 and result.meshPartProperties.DoubleSided)
close(s.rgb[1],0.3); close(s.rgb[2],0.4); close(s.rgb[3],0.5)
close(result.meshPartProperties.Color.R,0.5838314900602575)
close(result.meshPartProperties.Color.G,0.6651850846308363)
close(result.meshPartProperties.Color.B,0.7353569830524495)
assert(result.engineVerification=="pending" and result.plan.engineVerification=="pending")
assert(table.isfrozen(result) and table.isfrozen(result.meshPartProperties) and table.isfrozen(result.editableImages))
local count=0; for _ in pairs(result.meshPartProperties) do count+=1 end; assert(count==3)
`);
});

test('black, white, low intensity and fractional channels reach adapter without quantization', options, async () => {
  await vm('channels', `
for _,rgb in ipairs({{0,0,0},{1,1,1},{0.0031308,0.0001,0.1234567890123}}) do
 local m=fixture(); m.baseColor={rgb[1],rgb[2],rgb[3],1}
 local f,s=factories(); AssetMaterials.create(m,f,alive)
 for i=1,3 do assert(s.rgb[i]==rgb[i]) end
end
`);
});

for (const [metallic, roughness, metalByte, roughByte] of [[0, 0, 0, 0], [1, 1, 255, 255], [0.15, 0.7, 38, 179], [0.5, 0.25, 128, 64], [1e-300, 0.999, 0, 255]]) {
  test(`constant maps encode metallic=${metallic}, roughness=${roughness} with explicit RGBA8 evidence`, options, async () => {
    await vm(`factors-${metalByte}-${roughByte}`, `
local m=fixture(); m.metallic=${metallic}; m.roughness=${roughness}
local f,s=factories(); local r=AssetMaterials.create(m,f,alive)
assert(r.plan.source.metallic==${metallic} and r.plan.source.roughness==${roughness})
for index,pair in ipairs({{r.plan.constantMaps.MetalnessMap,${metalByte},${metallic}},{r.plan.constantMaps.RoughnessMap,${roughByte},${roughness}}}) do
 local p,byte,source=pair[1],pair[2],pair[3]
 assert(p.width==1 and p.height==1 and p.format=="RGBA8" and p.rounding=="nearest-half-up")
 assert(p.sourceFactor==source and p.redByte==byte and p.engineVerification=="pending")
 assert(p.normalizedFactor==byte/255 and p.quantizationError==byte/255-source)
 for channel=1,3 do assert(p.rgba[channel]==byte and s.imageWrites[index].bytes[channel]==byte) end
 assert(p.rgba[4]==255 and s.imageWrites[index].bytes[4]==255)
end
assert(AssetMaterials.LIMITS.editableImages==2 and AssetMaterials.LIMITS.pixelBytes==8)
`);
  });
}

test('nil/default glTF material creates white opaque metalness=1 and roughness=1 constant maps', options, async () => {
  await vm('default', `
local f,s=factories(); local r=AssetMaterials.create(nil,f,alive)
assert(r.plan.source.metallic==1 and r.plan.source.roughness==1 and r.plan.source.doubleSided==false)
for i=1,3 do assert(r.plan.source.baseColor[i]==1 and s.rgb[i]==1) end
assert(r.plan.source.baseColor[4]==1 and r.meshPartProperties.Transparency==0)
assert(s.imageWrites[1].bytes[1]==255 and s.imageWrites[2].bytes[1]==255 and s.imageCreates==2)
`);
});

test('all byte levels and a dense factor sweep satisfy quantization bounds; planning creates no resources', options, async () => {
  await vm('factor-sweep', `
for byte=0,255 do
 local m=fixture(); m.metallic=byte/255; m.roughness=(255-byte)/255
 local p=AssetMaterials.plan(m)
 assert(p.constantMaps.MetalnessMap.redByte==byte and p.constantMaps.RoughnessMap.redByte==255-byte)
 assert(p.constantMaps.MetalnessMap.quantizationError==0)
end
for step=0,1024 do
 local m=fixture(); m.metallic=step/1024; m.roughness=1-step/1024
 local p=AssetMaterials.plan(m)
 for _,map in pairs(p.constantMaps) do
  assert(map.redByte>=0 and map.redByte<=255 and map.redByte%1==0 and math.abs(map.quantizationError)<=0.5/255+1e-15)
 end
end
`);
});

for (const field of ['colorMap', 'normalMap', 'metalnessMap', 'roughnessMap']) {
  test(`rejects ${field} references including false; image decoding remains out of scope`, options, async () => {
    await vm(field, `for _,v in ipairs({false,{},"synthetic-texture"}) do local m=fixture(); m.${field}=v; rejects(m,"UNSUPPORTED_TEXTURE","${field}") end`);
  });
}

test('rejects nonzero emission, even black albedo, tiny underflow and high strength', options, async () => {
  await vm('emission-reject', `
for _,e in ipairs({{factor={1,0,0},strength=1},{factor={0,0.5,0},strength=1000},
 {factor={0,0,1},strength=0.1},{factor={1e-300,0,0},strength=1e-300}}) do
 local m=fixture(); m.baseColor={0,0,0,1}; m.emission=e
 local plan=AssetMaterials.plan(m)
 assert(not plan.supported and plan.emissiveStrength==nil and plan.emissionSupport=="zero-only")
 assert(plan.source.emission.strength==e.strength and string.find(plan.limitations[2],"Nonzero additive glTF emission"))
 rejects(m,"UNSUPPORTED_MATERIAL","emission")
end
local m=fixture(); m.emission={factor={0,0,0},strength=0,map=false}
rejects(m,"UNSUPPORTED_TEXTURE","emission.map")
`);
});

test('maps absent, black or zero-strength emission to explicit zero without losing source factors', options, async () => {
  await vm('emission-zero', `
local variants={fixture(),fixture(),fixture()}
variants[2].emission={factor={0,0,0},strength=1000}
variants[3].emission={factor={1,0.25,0.5},strength=0}
for _,m in ipairs(variants) do
 local f,s=factories(); local r=AssetMaterials.create(m,f,alive)
 assert(r.surfaceAppearance.EmissiveStrength==0)
 if m.emission then
  assert(r.plan.source.emission.strength==m.emission.strength)
  for i=1,3 do assert(r.plan.source.emission.factor[i]==m.emission.factor[i]) end
 else assert(r.plan.source.emission==nil) end
end
`);
});

test('rejects MASK, BLEND, unsupported alpha and fractional opaque alpha', options, async () => {
  await vm('alpha', `
for _,mode in ipairs({"MASK","BLEND","other"}) do local m=fixture(); m.alphaMode=mode; rejects(m,"UNSUPPORTED_MATERIAL","alphaMode") end
for _,alpha in ipairs({0,0.5,0.999999999}) do local m=fixture(); m.baseColor[4]=alpha; rejects(m,"UNSUPPORTED_MATERIAL","alphaMode") end
`);
});

test('validates finite ranges and required scalars before constructors', options, async () => {
  await vm('validation', `
for _,field in ipairs({"metallic","roughness","alphaCutoff"}) do
 for _,value in ipairs({0/0,math.huge,-math.huge,-0.001,1.00001,false,"0"}) do
  local m=fixture(); m[field]=value; local s=rejects(m,"INPUT",field); assert(s.creates==0 and s.colors==0)
 end
 local m=fixture(); m[field]=nil; local s=rejects(m,"INPUT",field); assert(s.creates==0)
end
for _,value in ipairs({0/0,math.huge,-math.huge,-1,1.1,"0",false}) do
 local m=fixture(); m.baseColor[1]=value; rejects(m,"INPUT","baseColor")
end
for _,value in ipairs({0/0,math.huge,-1,1000.1,"0",false}) do
 local m=fixture(); m.emission={factor={0,0,0},strength=value}; rejects(m,"INPUT","emission.strength")
end
for _,value in ipairs({0/0,math.huge,-1,1.1,"0",false}) do
 local m=fixture(); m.emission={factor={value,0,0},strength=0}; rejects(m,"INPUT","emission.factor")
end
for _,value in ipairs({0/0,math.huge,-math.huge,1000001,"1",false}) do
 local m=fixture(); m.normalScale=value; rejects(m,"INPUT","normalScale")
end
local m=fixture(); m.doubleSided=1; rejects(m,"INPUT","doubleSided")
`);
});

test('rejects sparse, oversized, keyed and metatable color records', options, async () => {
  await vm('array-shapes', `
for _,array in ipairs({{}, {[1]=0,[3]=0,[4]=1},{0,0,0,1,0},{0,0,0,1,x=0},{[0]=0,0,0,0,1},
 setmetatable({0,0,0,1},{__index=function() error("must not run") end})}) do
 local m=fixture(); m.baseColor=array; local s=rejects(m,"INPUT","baseColor"); assert(s.colors==0)
end
local m=fixture(); m.emission={factor={0,0},strength=0}; rejects(m,"INPUT","emission.factor")
`);
});

test('rejects unknown extensions, claims, malformed digests and executable material tables', options, async () => {
  await vm('records', `
for _,field in ipairs({"extensions","verified","engineVerification","provider","emissiveFactor","Metalness"}) do
 local m=fixture(); m[field]=true; rejects(m,"UNSUPPORTED_MATERIAL","material")
end
for _,hash in ipairs({"bad",string.rep("A",64),string.rep("g",64),string.rep("a",65),true}) do
 local m=fixture(); m.sha256=hash; rejects(m,"INPUT","sha256")
end
local m=fixture(); m.emission={factor={0,0,0},strength=1,unexpected=0}; rejects(m,"UNSUPPORTED_MATERIAL","emission")
rejects({},"INPUT","baseColor")
for _,m in ipairs({false,"text",setmetatable(fixture(),{__index=function() error("must not run") end}),
 setmetatable(fixture(),{__metatable=false})}) do
 rejects(m,"INPUT","material")
end
`);
});

test('snapshot survives mutating/yielding injected color callback and changing factory references', options, async () => {
  await vm('callback-snapshot', `
local m=fixture(); m.doubleSided=true
local f,s
f,s=factories({onColor=function()
 m.baseColor[1]=0; m.roughness=1; m.doubleSided=false
 f.createSurfaceAppearanceAsync=forbidden; f.createEditableImage=forbidden; f.contentFromObject=forbidden; f.vector2=forbidden
 coroutine.yield("color paused")
end})
local result
local thread=coroutine.create(function() result=AssetMaterials.create(m,f,alive) end)
local ok,pause=coroutine.resume(thread); assert(ok and pause=="color paused" and s.creates==0)
assert(coroutine.resume(thread)); assert(coroutine.status(thread)=="dead")
assert(s.creates==1 and result.plan.source.baseColor[1]==0.3 and result.plan.roughness==0.7 and result.meshPartProperties.DoubleSided)
assert(s.imageWrites[1].bytes[1]==38 and s.imageWrites[2].bytes[1]==179)
`);
});

test('guard accepts nil/true only; rejects revoked ownership before callbacks', options, async () => {
  await vm('guard-entry', `
for _,guard in ipairs({function() return false end,function() return 1 end,function() return "yes" end,function() error("revoked") end}) do
 local s=rejects(fixture(),"CANCELLED","guard",nil,guard); assert(s.creates==0 and s.colors==0)
end
local f,s=factories(); AssetMaterials.create(fixture(),f,function() end); assert(s.creates==1)
for _,f in ipairs({{}, {colorFromLinear=forbidden,createSurfaceAppearanceAsync=forbidden}}) do
 local ok,e=pcall(AssetMaterials.create,fixture(),f,alive); assert(not ok and e.code=="INPUT")
end
local f,s=factories(); local ok,e=pcall(AssetMaterials.create,fixture(),f,nil); assert(not ok and e.code=="INPUT" and s.creates==0)
`);
});

for (const point of ['color', 'create', 'read', 'write', 'image-create-1', 'image-create-2', 'image-write-1', 'image-write-2', 'content-1', 'content-2', 'vector']) {
  test(`revocation during ${point} checks ownership and cleans only its appearance`, options, async () => {
    const hooks = {
      color: 'onColor=function() allowed=false end',
      create: 'onCreate=function() allowed=false end',
      read: 'onRead=function(name) if name=="IsA" then allowed=false end end',
      write: 'onWrite=function() allowed=false end',
      'image-create-1': 'onImageCreate=function(n) if n==1 then allowed=false end end',
      'image-create-2': 'onImageCreate=function(n) if n==2 then allowed=false end end',
      'image-write-1': 'onImageWrite=function(n) if n==1 then allowed=false end end',
      'image-write-2': 'onImageWrite=function(n) if n==2 then allowed=false end end',
      'content-1': 'onContent=function(n) if n==1 then allowed=false end end',
      'content-2': 'onContent=function(n) if n==2 then allowed=false end end',
      vector: 'onVector=function() allowed=false end',
    };
    const appearanceCount = ['create', 'read', 'write'].includes(point) ? 1 : 0;
    const imageCount = ['color', 'vector'].includes(point) ? 0 : point.endsWith('-1') ? 1 : 2;
    await vm(`cancel-${point}`, `
local allowed=true
local f,s=factories({${hooks[point]}})
local ok,e=pcall(AssetMaterials.create,fixture(),f,function() return allowed end)
assert(not ok and e.code=="CANCELLED")
assert(s.creates==${appearanceCount} and s.destroyed==s.creates and s.imageDestroyed==${imageCount})
assert(#s.writes==${point === 'write' ? 1 : 0})
`);
  });
}

test('nil allocation and color results reject; failed writes/reads destroy owned resource', options, async () => {
  await vm('failures', `
local s=rejects(fixture(),"MEMORY","surfaceAppearance",{createNil=true}); assert(s.creates==1 and s.destroyed==0 and s.imageDestroyed==2)
s=rejects(fixture(),"INPUT","colorFromLinear",{colorNil=true}); assert(s.creates==0)
s=rejects(fixture(),"ENGINE","create",{colorFails=true}); assert(s.creates==0)
s=rejects(fixture(),"ENGINE","create",{createFails=true}); assert(s.destroyed==0 and s.imageDestroyed==2)
s=rejects(fixture(),"ENGINE","create",{writeFails=true}); assert(s.destroyed==1 and s.imageDestroyed==2)
s=rejects(fixture(),"ENGINE","create",{readFails="IsA"}); assert(s.destroyed==1 and #s.writes==0 and s.imageDestroyed==2)
s=rejects(fixture(),"INPUT","surfaceAppearance",{wrongClass=true}); assert(s.destroyed==1)
s=rejects(fixture(),"INPUT","surfaceAppearance",{parented=true}); assert(s.destroyed==1 and #s.writes==0)
`);
});

for (const stage of ['imageNil', 'imageCreateFails', 'imageWriteFails', 'contentNil', 'contentFails', 'badSize']) {
  test(`failure at either ${stage} cleans every allocated image and creates no appearance`, options, async () => {
    const code = stage === 'imageNil' ? 'MEMORY' : ['contentNil', 'badSize'].includes(stage) ? 'INPUT' : 'ENGINE';
    await vm(`failure-${stage}`, `
for ordinal=1,2 do
 local s=rejects(fixture(),"${code}",nil,{${stage}=ordinal})
 local allocated=if "${stage}"=="imageNil" or "${stage}"=="imageCreateFails" then ordinal-1 else ordinal
 assert(s.creates==0 and s.destroyed==0 and s.imageDestroyed==allocated)
 for _,image in ipairs(s.images) do assert(image.proof.destroyed==1) end
end
`);
  });
}

test('cleanup failure reports ENGINE without echoing injected private diagnostics or forged structured errors', options, async () => {
  await vm('private-errors', `
local s,e=rejects(fixture(),"ENGINE","cleanup",{writeFails=true,destroyFails=true,imageDestroyFails=2})
assert(s.destroyed==1 and s.imageDestroyed==2 and s.images[1].proof.destroyed==1)
assert(s.events[#s.events-2]=="surface-destroy" and s.events[#s.events-1]=="image-destroy-2" and s.events[#s.events]=="image-destroy-1")
assert(not string.find(e.message,"opaque"))
local forged=table.freeze({code="INPUT",field="forged",message="opaque injected detail"})
for _,opts in ipairs({{colorFails=true,errorValue=forged},{createFails=true,errorValue=forged},{writeFails=true,errorValue=forged}}) do
 local _,err=rejects(fixture(),"ENGINE","create",opts)
 assert(err~=forged and not string.find(err.message,"opaque"))
end
`);
});

test('success transfers distinct resources; a later failure does not destroy an earlier result', options, async () => {
  await vm('ownership', `
local f,s=factories(); local a=AssetMaterials.create(fixture(),f,alive); local b=AssetMaterials.create(fixture(),f,alive)
assert(a.surfaceAppearance~=b.surfaceAppearance and a.plan~=b.plan and s.destroyed==0)
assert(a.editableImages.MetalnessMap~=b.editableImages.MetalnessMap and a.editableImages.RoughnessMap~=b.editableImages.RoughnessMap)
local s2=rejects(fixture(),"ENGINE","create",{writeFails=true}); assert(s2.destroyed==1 and s2.imageDestroyed==2 and s.destroyed==0 and s.imageDestroyed==0)
`);
});

test('reused image resource rejects and is destroyed once without allocating an appearance', options, async () => {
  await vm('image-alias', `
local s=rejects(fixture(),"INPUT","RoughnessMap",{reuseImage=true})
assert(s.imageCreates==2 and #s.images==1 and s.imageDestroyed==1 and s.creates==0 and #s.imageWrites==1)
`);
});

test('yielding surface factory transfers resources only after guard recheck; cancellation destroys all three', options, async () => {
  await vm('surface-yield', `
local allowed=true
local f,s=factories({onCreate=function() coroutine.yield("appearance paused") end})
local err
local thread=coroutine.create(function()
 local ok,e=pcall(AssetMaterials.create,fixture(),f,function() return allowed end); assert(not ok); err=e
end)
local ok,pause=coroutine.resume(thread); assert(ok and pause=="appearance paused")
assert(s.creates==1 and s.imageCreates==2 and s.destroyed==0 and s.imageDestroyed==0)
allowed=false; assert(coroutine.resume(thread)); assert(coroutine.status(thread)=="dead")
assert(err.code=="CANCELLED" and s.destroyed==1 and s.imageDestroyed==2 and #s.writes==0)
`);
});
