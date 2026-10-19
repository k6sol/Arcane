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
// This fixture was emitted by the actual host PNG decoder and sealed sender.
// Only native resources/services are doubles; the complete ownership chain is production code.
const setup = `
local expected,packets=fixtureExpected,fixturePackets
local allowed=true
local function guard() if not allowed then error({code='CANCELLED',message='fixture retired'}) end end
local function decode(text) assert(fixtureDecoded[text],'unknown fixture JSON');return fixtureDecoded[text] end
local function rejects(fn,code)
 local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e));return e
end
local function hash(bytes) local h=__mods.Sha256Stream.new();h:update(buffer.tostring(bytes));return h:digest() end
local requested,resources,parts,images,surfaces,instances={},{},{},{},{},{}
local creates,destroyed,imageCreates,imageDestroyed,surfaceCreates,surfaceDestroyed,nextId=0,0,0,0,0,0,0
local service={}
function service:CreateEditableMesh()
 creates+=1;local mesh={vertices={},faces={},normals={},uvs={},destroyed=0}
 local function id() nextId+=11;return nextId end
 function mesh:AddVertex(value) local key=id();self.vertices[key]=value;return key end
 function mesh:AddNormal(value) local key=id();self.normals[key]=value;return key end
 function mesh:AddUV(value) local key=id();self.uvs[key]=value;return key end
 function mesh:AddTriangle(a,b,c) local key=id();self.faces[key]={a,b,c};return key end
 function mesh:SetFaceNormals(face,values) self.faces[face].normals=values end
 function mesh:SetFaceUVs(face,values) self.faces[face].uvs=values end
 function mesh:Destroy() self.destroyed+=1;destroyed+=1 end
 resources[#resources+1]=mesh;return mesh
end
local function instance(class)
 assert(class=='Model' or class=='MeshPart' or class=='SurfaceAppearance','unexpected instance factory')
 local value={ClassName=class,destroyed=0};instances[#instances+1]=value
 setmetatable(value,{__index=function(self,key) if key=='Parent' then return rawget(self,'_parent') end end,
  __newindex=function(self,key,item)
   if key=='Parent' then rawset(self,'_parent',item);if class=='SurfaceAppearance' and item then item.appearance=self end
   else rawset(self,key,item) end
  end})
 function value:IsA(name) return name==class end
 function value:Destroy()
  if self.destroyed>0 then return end;self.destroyed+=1
  if class=='SurfaceAppearance' then surfaceDestroyed+=1 end
  for _,child in ipairs(instances) do if child.Parent==self then child:Destroy() end end
  self.Parent=nil
 end
 function value:Clone()
  assert(class=='SurfaceAppearance');local copy=instance(class)
  for key,item in pairs(self) do if key~='_parent' and key~='destroyed' and type(item)~='function' then copy[key]=item end end
  return copy
 end
 return value
end
function service:CreateMeshPartAsync(content,options)
 assert(content.object and content.object.vertices,'only a privately retained EditableMesh may create a part')
 local part=instance('MeshPart');part.content=content;part.options=options;parts[#parts+1]=part;return part
end
function service:CreateEditableImage(options)
 imageCreates+=1;if self.imageNilAt==imageCreates then return nil end
 local image={Size=options.Size,destroyed=0};images[#images+1]=image
 function image:WritePixelsBuffer(origin,size,pixels)
  assert(origin.X==0 and origin.Y==0 and size.X==self.Size.X and size.Y==self.Size.Y)
  assert(buffer.len(pixels)==size.X*size.Y*4);self.bytes=buffer.fromstring(buffer.tostring(pixels))
 end
 function image:Destroy() self.destroyed+=1;imageDestroyed+=1 end
 return image
end
function service:CreateSurfaceAppearanceAsync(maps)
 surfaceCreates+=1;local surface=instance('SurfaceAppearance');surface.maps=maps;surfaces[#surfaces+1]=surface
 if self.onSurface then self.onSurface(surface) end
 return surface
end
local env=getfenv(__mods.Operations.materializeReconstruction)
env.Instance={new=instance};env.Content={fromObject=function(object) return {object=object} end}
env.Enum={CollisionFidelity={Hull='Hull',Box='Box'},RenderFidelity={Precise='Precise'},Material={SmoothPlastic='SmoothPlastic'}}
env.Vector3={new=function(x,y,z) return {x,y,z,X=x,Y=y,Z=z} end}
env.Vector2={new=function(x,y) return {X=x,Y=y} end}
env.CFrame={new=function(x,y,z) return {x,y,z} end};env.Color3={new=function(r,g,b) return {r,g,b} end}
env.task={wait=function() end}
local gameModel={GetService=function(_,name)
 requested[#requested+1]=name
 assert(name=='Workspace' or name=='ScriptEditorService' or name=='ChangeHistoryService' or name=='Selection'
  or name=='CollectionService' or name=='AssetService','unexpected service lookup')
 return if name=='AssetService' then service else {}
end}
local http={JSONDecode=function(_,text) return decode(text) end,JSONEncode=function(_,value) return tostring(value) end}
local target=decode(packets[1]).target
local continuity={clientLifetimeId='texture-life',pluginArtifactHash=string.rep('a',64),playEpoch=0}
local Operations=__mods.Operations
local ops=Operations.new({sessionId=target.sessionId,allowedRoots={'Workspace'}},gameModel,http)
function ops:importContext(_)
 return {sessionId=target.sessionId,parentRef={instanceId=target.parentRef},placeId=0,universeId=0,mode='Edit',
  creator={status='unavailable',id=0},studioUser={status='available',id=tonumber(target.creator.id)}}
end
local function stage()
 for _,packet in ipairs(packets) do ops:stageAssetPacket({expected=expected,packet=packet,target=target,continuity=continuity},guard) end
 assert(creates==0 and imageCreates==0 and surfaceCreates==0)
end
local function args()
 local receiver=ops.assetTransfers[expected.digest].receiver;local status=receiver:status()
 return {runId='11111111-1111-4111-8111-111111111111',expected=expected,packetCount=status.packetCount,
  byteLength=status.byteLength,target=target,continuity=continuity,objects=table.clone(receiver:reconstructionPlan())}
end
local function reconstruct()
 stage();local result=ops:execute({method='asset.reconstruct',args=args()},guard)
 assert(result.state=='reconstructed' and result.imported==false and result.engineVerification=='pending')
 assert(#result.objects==3 and creates==3 and imageCreates==0 and surfaceCreates==0 and destroyed==0)
 assert(ops.assetTransfers[expected.digest]==nil and ops.meshes==nil and ops.materials==nil and ops.textures==nil)
 return result
end
local function assetLookups()
 local count=0;for _,name in ipairs(requested) do if name=='AssetService' then count+=1 end end;return count
end
local function verifyPart(part)
 local mesh=part.content.object
 if part.Transparency==1 then
  assert(part.appearance==nil and part.CanCollide and part.options.CollisionFidelity=='Hull');return
 end
 assert(part.appearance and part.appearance.Parent==part and part.Material=='SmoothPlastic')
 assert(part.DoubleSided and part.Transparency==0,'opaque double-sided material survives placement')
 for channel=1,3 do assert(math.abs(part.Color[channel]-1)<1e-12,'baked albedo uses a neutral white substrate') end
 assert(not part.CanCollide and part.options.CollisionFidelity=='Box')
 for slot,expectedMap in pairs(fixtureMaps) do
  local content=part.appearance.maps[slot];local image=content and content.object
  assert(image and image.Size.X==expectedMap.width and image.Size.Y==expectedMap.height)
  assert(hash(image.bytes)==expectedMap.sha256,'placed map changed source channel, factor or image orientation')
 end
 local ids={};for id in pairs(mesh.uvs) do ids[#ids+1]=id end;table.sort(ids)
 local uv={{0,0},{1,0},{1,1},{0,1}};assert(#ids==4)
 for index,id in ipairs(ids) do assert(mesh.uvs[id].X==uv[index][1] and mesh.uvs[id].Y==uv[index][2]) end
 local faceIds={};for id in pairs(mesh.faces) do faceIds[#faceIds+1]=id end;table.sort(faceIds)
 local indexRows={{1,3,2},{1,2,4},{1,4,3},{2,3,4}};assert(#faceIds==4)
 for index,id in ipairs(faceIds) do
  local face=mesh.faces[id];assert(#face.uvs==3)
  for corner=1,3 do assert(face.uvs[corner]==ids[indexRows[index][corner]],'native UV IDs preserve each face association') end
 end
end
`;

async function run(body) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-operations-texture-vm-'));
  try {
    let source = `local unexpected=0
local function forbidden() unexpected+=1;error('live engine, network and upload globals forbidden') end
local blocked=setmetatable({},{__index=forbidden,__newindex=forbidden})
local env=getfenv();env.game=blocked;env.workspace=blocked;env.plugin=blocked;env.Instance=blocked;env.Content=blocked
local __mods={}
`;
    for (const name of ['Validation','Properties','Registry','Sha256Stream','AssetMesh','AssetTransfer','AssetMaterials','AssetUpload','AssetPlacement','TerrainGen','Operations']) {
      const production = (await readFile(join(root,'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'__mods.$1');
      source += '\n__mods.'+name+'=(function()\n'+production+'\nend)()\n';
    }
    source += await readFile(join(root,'tests/plugin/fixtures/asset-textures.luau'),'utf8');
    source += setup + body + '\nassert(unexpected==0)\nprint("OPERATIONS_TEXTURE_OK")\n';
    const file=join(directory,'operations-texture.luau'); await writeFile(file,source);
    for (const [binary,args] of [...(compiler ? [[compiler,['--null',file]]] : []),[runtime,[file]]]) {
      const result=spawnSync(binary,args,{encoding:'utf8',timeout:30000,windowsHide:true});
      assert.ifError(result.error); assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
      if(binary===runtime) assert.match(result.stdout,/OPERATIONS_TEXTURE_OK/);
    }
  } finally {
    const path=relative(tmpdir(),directory);assert.ok(path.startsWith('arcane-operations-texture-vm-')&&!isAbsolute(path)&&!path.includes('..'));
    await rm(directory,{recursive:true,force:true});
  }
}

test('production Operations preserves exact UV faces and PNG maps through private reconstruction and bounded repeated placement',options,()=>run(`
reconstruct();assert(assetLookups()==1)
local lookups=#requested;local model=ops:materializeReconstruction(expected.digest,guard)
assert(model.Name=='ArcaneProcedural' and #parts==3 and imageCreates==4 and surfaceCreates==1 and #requested==lookups)
for _,part in ipairs(parts) do assert(part.Parent==model);verifyPart(part) end
local again=ops:materializeReconstruction(expected.digest,guard)
assert(again~=model and #parts==6 and imageCreates==4 and surfaceCreates==1 and #requested==lookups)
for index=4,6 do verifyPart(parts[index]) end
ops:cancelAssetTransfers();assert(destroyed==3 and imageDestroyed==4 and surfaces[1].destroyed==1)
for _,image in ipairs(images) do assert(image.destroyed==1) end
ops:cancelAssetTransfers();assert(destroyed==3 and imageDestroyed==4 and assetLookups()==1)
`));

test('production texture reconstruction refuses forged handles and absent owners before service or image lookup',options,()=>run(`
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'WATCH');assert(assetLookups()==0)
stage();local input=args();input.textures={kind='arcane-private-material-textures'}
rejects(function() ops:reconstructAsset(input,guard) end,'INPUT');assert(creates==0 and assetLookups()==0)
input.textures=nil;ops:reconstructAsset(input,guard)
local source;for _,packet in ipairs(packets) do local p=decode(packet);if p.kind=='object' and p.material then source=p.material;break end end
rejects(function() __mods.AssetMaterials.plan(source,{kind='arcane-private-material-textures'}) end,'INPUT')
rejects(function() ops:materializeReconstruction(string.rep('f',64),guard) end,'WATCH')
assert(creates==3 and imageCreates==0 and assetLookups()==1)
local model=ops:materializeReconstruction(expected.digest,guard);assert(model and imageCreates==4 and assetLookups()==1)
ops:cancelAssetTransfers();assert(destroyed==3 and imageDestroyed==4)
`));

test('production retirement during a yielding textured surface allocation destroys every map and retained mesh once',options,()=>run(`
reconstruct();service.onSurface=function() ops:cancelAssetTransfers() end
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'CANCELLED')
assert(destroyed==3 and imageCreates==4 and imageDestroyed==4 and surfaceCreates==1 and surfaces[1].destroyed==1)
for _,image in ipairs(images) do assert(image.destroyed==1) end
for _,part in ipairs(parts) do assert(part.destroyed==1 and part.Parent==nil) end
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'WATCH')
ops:cancelAssetTransfers();assert(destroyed==3 and imageDestroyed==4 and assetLookups()==1)
`));

test('production refusal at the fourth map cleans partial images, retains exact source meshes and permits safe retry',options,()=>run(`
reconstruct();service.imageNilAt=4
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'MEMORY')
assert(imageCreates==4 and imageDestroyed==3 and destroyed==0 and surfaceCreates==0)
for _,part in ipairs(parts) do assert(part.destroyed==1 and part.Parent==nil) end
service.imageNilAt=nil;local model=ops:materializeReconstruction(expected.digest,guard)
assert(model and imageCreates==8 and surfaceCreates==1 and destroyed==0 and assetLookups()==1)
for _,part in ipairs(parts) do if part.Parent==model then verifyPart(part) end end
ops:cancelAssetTransfers();assert(imageDestroyed==7 and destroyed==3)
for _,image in ipairs(images) do assert(image.destroyed==1) end
`));
