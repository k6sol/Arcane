import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, relative, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN, compiler = process.env.ARCANE_LUAU_COMPILE;
const options = {skip: !runtime && 'Owned standalone Luau runtime required.'};
const doubles = `
local unexpected=0
local function forbidden() unexpected+=1;error('live engine access forbidden') end
local blocked=setmetatable({},{__index=forbidden,__newindex=forbidden})
local game,workspace,plugin,Instance,Content=blocked,blocked,blocked,blocked,blocked
local Vector3={new=function(x,y,z) return {X=x,Y=y,Z=z} end}
local Vector2={new=function(x,y) return {X=x,Y=y} end}
`;
const setup = `
local allowed=true
local function guard() if not allowed then error('retired') end end
local function yieldBatch() end
local function rejects(fn,code)
 local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e));return e
end
local function receiver(decode)
 return AssetTransfer.new(fixtureExpected,decode or function(s) assert(fixtureDecoded[s]);return fixtureDecoded[s] end,guard,yieldBatch)
end
local function feed(r) for _,packet in ipairs(fixturePackets) do r:accept(packet) end end
local creates,destroyed,nextId=0,0,0
local service={}
function service:CreateEditableMesh()
 creates+=1;local m={vertices={},uvs={},faces={},normals={},destroyed=0}
 local function id() nextId+=11;return nextId end
 function m:AddVertex(v) local n=id();self.vertices[n]=v;return n end
 function m:AddUV(v) local n=id();self.uvs[n]=v;return n end
 function m:AddNormal(v) local n=id();self.normals[n]=v;return n end
 function m:AddTriangle(a,b,c) local n=id();self.faces[n]={a,b,c};return n end
 function m:SetFaceUVs(face,uvs) self.faces[face].uvs=uvs end
 function m:SetFaceNormals(face,normals) self.faces[face].normals=normals end
 function m:Destroy() self.destroyed+=1;destroyed+=1 end
 return m
end
local function hash(bytes)
 local h=Sha256Stream.new();h:update(buffer.tostring(bytes));return h:digest()
end
local function factories(options)
 options=options or {};local state={images={},appearances={},destroyed=0,writes=0}
 local f={}
 f.vector2=Vector2.new
 f.colorFromLinear=function(r,g,b) return {R=r,G=g,B=b} end
 f.createEditableImage=function(opts)
  local ordinal=#state.images+1
  if options.nilAt==ordinal then return nil end
  local image={Size=opts.Size,destroyed=0}
  function image:WritePixelsBuffer(origin,size,pixels)
   assert(origin.X==0 and origin.Y==0 and size.X==self.Size.X and size.Y==self.Size.Y and buffer.len(pixels)==size.X*size.Y*4)
   self.pixels=buffer.fromstring(buffer.tostring(pixels));state.writes+=1
  end
  function image:Destroy()
   self.destroyed+=1;state.destroyed+=1
   if options.destroyFails==ordinal then error('private cleanup detail') end
  end
  state.images[ordinal]=image
  if options.revokeAt==ordinal then allowed=false end
  return image
 end
 f.contentFromObject=function(image) return {Object=image} end
 f.createSurfaceAppearanceAsync=function(maps)
  local surface={maps=maps,destroyed=0}
  function surface:IsA(class) return class=='SurfaceAppearance' end
  function surface:Destroy() self.destroyed+=1;state.destroyed+=1 end
  state.appearances[#state.appearances+1]=surface
  if options.revokeSurface then allowed=false end
  return surface
 end
 return f,state
end
local function reconstruct()
 local r=receiver();feed(r);assert(creates==0)
 local entries=r:reconstruct(service,AssetMaterials.admitTextures)
 assert(#entries==3 and creates==3 and destroyed==0)
 return entries,r
end
`;

async function run(body) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-texture-vm-'));
  try {
    let source = doubles;
    for (const name of ['Sha256Stream','AssetMesh','AssetTransfer','AssetMaterials']) {
      const production = (await readFile(join(root,'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'$1');
      source += '\nlocal '+name+'=(function()\n'+production+'\nend)()\n';
    }
    source += await readFile(join(root,'tests/plugin/fixtures/asset-textures.luau'),'utf8');
    source += setup + body + '\nassert(unexpected==0)\nprint("TEXTURE_DELIVERY_OK")\n';
    const file=join(directory,'texture.luau'); await writeFile(file,source);
    for (const [binary,args] of [...(compiler ? [[compiler,['--null',file]]] : []),[runtime,[file]]]) {
      const result=spawnSync(binary,args,{encoding:'utf8',timeout:30000,windowsHide:true});
      assert.ifError(result.error); assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
      if(binary===runtime) assert.match(result.stdout,/TEXTURE_DELIVERY_OK/);
    }
  } finally {
    const path=relative(tmpdir(),directory);assert.ok(path.startsWith('arcane-texture-vm-')&&!isAbsolute(path)&&!path.includes('..'));
    await rm(directory,{recursive:true,force:true});
  }
}

test('sealed PNG maps become private shared material handles, exact pixel images and native UV associations',options,()=>run(`
local r=receiver();feed(r);assert(r:status().state=='sealed' and creates==0)
local function intake(material,maps,check)
 local handle=AssetMaterials.admitTextures(material,maps,check)
 for _,map in pairs(maps) do buffer.fill(map.bytes,0,0,buffer.len(map.bytes)) end
 return handle
end
local entries=r:reconstruct(service,intake)
local renders={};for _,entry in ipairs(entries) do if entry.object.role=='render' then table.insert(renders,entry) else assert(entry.textures==nil) end end
assert(#renders==2 and renders[1].textures==renders[2].textures and creates==3)
local entry=renders[1]
rejects(function() AssetMaterials.plan(entry.material,{kind='arcane-private-material-textures'}) end,'INPUT')
rejects(function() AssetMaterials.plan(entry.material,table.clone(entry.textures)) end,'INPUT')
local original=entry.material.roughness;entry.material.roughness=.8
rejects(function() AssetMaterials.plan(entry.material,entry.textures) end,'INPUT');entry.material.roughness=original
local f,state=factories();local made=AssetMaterials.create(entry.material,f,guard,entry.textures)
assert(#state.images==4 and #state.appearances==1 and state.writes==4)
assert(made.meshPartProperties.Color.R==1 and made.meshPartProperties.Color.G==1 and made.meshPartProperties.Color.B==1)
assert(made.surfaceAppearance.Color.R==1 and made.plan.source.baseColor[1]==.5)
for slot,expected in pairs(fixtureMaps) do
 local image=made.editableImages[slot];assert(image and image.Size.X==expected.width and image.Size.Y==expected.height)
 assert(hash(image.pixels)==expected.sha256,'native image write changed channel/orientation/factor bytes')
 assert(made.surfaceAppearance.maps[slot].Object==image)
end
for _,entry in ipairs(renders) do
 local uvs=entry.mesh.editableMesh.uvs;local count=0;for _,uv in pairs(uvs) do assert((uv.X==0 or uv.X==1) and (uv.Y==0 or uv.Y==1));count+=1 end
 assert(count==4);for _,face in pairs(entry.mesh.editableMesh.faces) do assert(#face.uvs==3) end
end
r:cancel();assert(destroyed==0 and state.destroyed==0,'transferred owners survive receiver cancellation')
`));

test('texture chunk corruption is refused before mesh or image allocation',options,()=>run(`
local r=receiver();local attacked=false
for _,packet in ipairs(fixturePackets) do
 local p=fixtureDecoded[packet]
 if p.kind=='chunk' and p.primitiveIndex==-1 then
  p.data=(if string.sub(p.data,1,4)=='AAAA' then 'AQAA' else 'AAAA')..string.sub(p.data,5)
  rejects(function() r:accept(packet) end,'CHECKSUM');attacked=true;break
 end
 r:accept(packet)
end
assert(attacked and creates==0 and r:status().state=='cancelled')
`));

test('binding a verified image to another material cannot pass the exact seal',options,()=>run(`
local r=receiver();local attacked=false
for _,packet in ipairs(fixturePackets) do
 local p=fixtureDecoded[packet]
 if p.kind=='object' and p.textureBindings then p.material.sha256=string.rep('0',64);attacked=true end
 if p.kind=='seal' then rejects(function() r:accept(packet) end,'IDENTITY');break else r:accept(packet) end
end
assert(attacked and creates==0)
`));

test('textured reconstruction requires its trusted intake before any engine allocation',options,()=>run(`
local r=receiver();feed(r);rejects(function() r:reconstruct(service) end,'INPUT');assert(creates==0)
`));

test('nil image and cancellation after yielding allocations destroy exactly new resources',options,()=>run(`
local entries=reconstruct();local entry;for _,e in ipairs(entries) do if e.textures then entry=e;break end end
for _,options in ipairs({{nilAt=2},{revokeAt=3},{revokeSurface=true}}) do
 allowed=true;local f,state=factories(options)
 local code=if options.nilAt then 'MEMORY' else 'CANCELLED'
 rejects(function() AssetMaterials.create(entry.material,f,guard,entry.textures) end,code)
 assert(state.destroyed==#state.images+#state.appearances)
end
assert(destroyed==0,'failed material creation preserves caller-owned source meshes')
`));

test('texture cleanup failures stay explicit while every newly allocated resource is attempted',options,()=>run(`
local entries=reconstruct();local entry;for _,e in ipairs(entries) do if e.textures then entry=e;break end end
local f,state=factories({revokeSurface=true,destroyFails=2})
local e=rejects(function() AssetMaterials.create(entry.material,f,guard,entry.textures) end,'ENGINE')
assert(e.field=='cleanup' and state.destroyed==5 and destroyed==0)
`));

test('glTF MASK admits binary ColorMap coverage only and creates a Transparency-mode appearance',options,()=>run(`
local D=function(c) return string.rep(c,64) end
local function material(mode)
 return {baseColor={1,1,1,1},metallic=1,roughness=1,alphaMode=mode,alphaCutoff=.5,doubleSided=true,normalScale=1,sha256=D('c'),
  colorMap={sha256=D('1'),channel='rgba',texCoord=0},normalMap={sha256=D('2'),channel='rgb',texCoord=0}}
end
local function map(slot,source,alphas)
 local bytes=buffer.create(#alphas*4)
 for i,a in ipairs(alphas) do buffer.writeu8(bytes,(i-1)*4,200);buffer.writeu8(bytes,(i-1)*4+1,128);buffer.writeu8(bytes,(i-1)*4+2,64);buffer.writeu8(bytes,(i-1)*4+3,a) end
 return {imageId=D(source=='1' and '3' or '4'),sourceSha256=D(source),sourceRgbaSha256=D('5'),sha256=D('6'),materialSha256=D('c'),
  semantic=slot,channel=slot=='ColorMap' and 'rgba' or 'rgb',orientation='top-left',colorSpace=slot=='ColorMap' and 'srgb' or 'linear',
  normalConvention=slot=='NormalMap' and 'OpenGL' or nil,width=#alphas,height=1,bytes=bytes,byteLength=#alphas*4,factors=slot=='ColorMap' and {1,1,1} or {1}}
end
local function maps(colorAlphas,normalAlphas) return {ColorMap=map('ColorMap','1',colorAlphas),NormalMap=map('NormalMap','2',normalAlphas)} end
-- Opaque materials still require alpha 255 everywhere; MASK relaxes only ColorMap to {0,255}.
rejects(function() AssetMaterials.admitTextures(material('OPAQUE'),maps({0,255},{255,255}),guard) end,'INPUT')
rejects(function() AssetMaterials.admitTextures(material('MASK'),maps({128,255},{255,255}),guard) end,'INPUT')
rejects(function() AssetMaterials.admitTextures(material('MASK'),maps({0,255},{0,255}),guard) end,'INPUT')
rejects(function() AssetMaterials.admitTextures(material('BLEND'),maps({255,255},{255,255}),guard) end,'UNSUPPORTED_MATERIAL')
local opaque=material('OPAQUE');local opaqueHandle=AssetMaterials.admitTextures(opaque,maps({255,255},{255,255}),guard)
local f0,s0=factories();local plain=AssetMaterials.create(opaque,f0,guard,opaqueHandle)
assert(plain.plan.alphaMode=='OPAQUE' and s0.appearances[1].AlphaMode==nil,'opaque appearances keep the engine default alpha mode')
local m=material('MASK');local handle=AssetMaterials.admitTextures(m,maps({0,255},{255,255}),guard)
Enum={AlphaMode={Transparency='AlphaMode.Transparency'}}
local f,state=factories();local made=AssetMaterials.create(m,f,guard,handle)
Enum=nil
assert(made.plan.alphaMode=='MASK' and made.surfaceAppearance.AlphaMode=='AlphaMode.Transparency')
assert(made.meshPartProperties.Transparency==0 and made.meshPartProperties.DoubleSided==true)
local pixels=made.editableImages.ColorMap.pixels;assert(buffer.readu8(pixels,3)==0 and buffer.readu8(pixels,7)==255,'binary coverage is written unchanged')
`));
