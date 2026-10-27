import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Production Operations/placement/mesh math in a standalone Luau VM. The
// controlled sealed-receiver seam and every Engine object/service are doubles,
// not native or Studio acceptance. C129 separately exercises original sender
// bytes through the actual receiver. This harness NEVER implicitly recenters a
// mesh: the actual AssetMesh v2 delivery path must author centered vertices.
const runtime=process.env.ARCANE_LUAU_BIN;
const options={skip:!runtime&&'Standalone Luau runtime not configured.'};
const modules=['Sha256Stream','Validation','Properties','Registry','AssetMesh','AssetTransfer','AssetUpload','AssetPlacement','TerrainGen','Operations'];
const engine=String.raw`
local CFrame: any={};local cf: any={};cf.__index=cf
local function frame(c: any): any return setmetatable({c=c},cf) end
function CFrame.new(...: number): any
 local v={...};return frame(if #v==12 then v else {v[1] or 0,v[2] or 0,v[3] or 0,1,0,0,0,1,0,0,0,1})
end
function cf:GetComponents(): ...number return table.unpack(self.c) end
cf.__mul=function(a: any,b: any): any
 local x,y=a.c,b.c;local out={x[1]+x[4]*y[1]+x[5]*y[2]+x[6]*y[3],x[2]+x[7]*y[1]+x[8]*y[2]+x[9]*y[3],x[3]+x[10]*y[1]+x[11]*y[2]+x[12]*y[3]}
 for r=0,2 do for c=0,2 do out[4+r*3+c]=x[4+r*3]*y[4+c]+x[5+r*3]*y[7+c]+x[6+r*3]*y[10+c] end end
 return frame(out)
end
function cf:Inverse(): any
 local a=self.c;return frame({-a[4]*a[1]-a[7]*a[2]-a[10]*a[3],-a[5]*a[1]-a[8]*a[2]-a[11]*a[3],-a[6]*a[1]-a[9]*a[2]-a[12]*a[3],a[4],a[7],a[10],a[5],a[8],a[11],a[6],a[9],a[12]})
end
function CFrame.Angles(x: number,y: number,z: number): any
 local cx,sx,cy,sy,cz,sz=math.cos(x),math.sin(x),math.cos(y),math.sin(y),math.cos(z),math.sin(z)
 return frame({0,0,0,cy*cz,cy*-sz,sy,sx*sy*cz+cx*sz,-sx*sy*sz+cx*cz,-sx*cy,-cx*sy*cz+sx*sz,cx*sy*sz+sx*cz,cx*cy})
end
function methods:GetAttribute(key: string): any return self._attributes[key] end
function methods:SetAttribute(key: string,value: any): () self._attributes[key]=value end
function methods:GetDescendants(): any
 local out,queue={},self:GetChildren();local at=1
 while at<=#queue do local item=queue[at];at+=1;out[#out+1]=item;for _,child in ipairs(item:GetChildren()) do queue[#queue+1]=child end end
 return out
end
function methods:GetPivot(): any return if self:IsA('Model') then self.WorldPivot else self.CFrame*self.PivotOffset end
function methods:Clone(): any
 local copy=Instance.new(self.ClassName)
 for key,value in pairs(self._properties) do if key~='Parent' then copy._properties[key]=value end end
 copy._attributes=table.clone(self._attributes);copy._tags=table.clone(self._tags or {})
 for _,child in ipairs(self:GetChildren()) do child:Clone().Parent=copy end
 return copy
end
local originalNew=Instance.new
Instance.new=function(class: string): any
 fixture.allocations=(fixture.allocations or 0)+1
 if fixture.failAllocation==fixture.allocations then error('controlled allocation refusal') end
 local item=originalNew(class)
 if item:IsA('BasePart') then
  item.CFrame=CFrame.new();item.PivotOffset=CFrame.new();item.CanQuery=true;item.CanTouch=true;item.DoubleSided=false
  item.MaterialVariant='';item.Reflectance=0;item.Massless=false;item.CollisionGroup='Default';item.Locked=false;item.RootPriority=0
 elseif class=='Model' then item.WorldPivot=CFrame.new() end
 return item
end
services.CollectionService.AddTag=function(_,item,tag) item._tags=item._tags or {};table.insert(item._tags,tag) end
local function category(family: string,names: any): any
 local c=setmetatable({},{__tostring=function() return 'Enum.'..family end})
 for _,name in ipairs(names) do c[name]={Name=name,EnumType=c,_enumItem=true} end;return c
end
Enum.AssetType=category('AssetType',{'Mesh','Image'});Enum.AssetCreatorType=category('AssetCreatorType',{'User','Group'})
Enum.CreateAssetResult=category('CreateAssetResult',{'Success','UploadLimitExceeded'})
Enum.CollisionFidelity={Hull='Hull',Box='Box'};Enum.RenderFidelity={Precise='Precise'}
local Content={fromObject=function(value) return {object=value} end}
task.wait=function() end
http.GenerateGUID=function() fixture.guid+=1;return string.format('00000000-0000-4000-8000-%012d',fixture.guid) end
local service: any={meshes={},parts={},uploads={},ids={},partCalls=0}
function service:CreateEditableMesh(): any
 local mesh: any={ClassName='EditableMesh',vertices={},faces={}}
 function mesh:IsA(c) return c=='EditableMesh' end
 function mesh:AddVertex(p) self.vertices[#self.vertices+1]=p;return #self.vertices end
 function mesh:AddTriangle(a,b,c) self.faces[#self.faces+1]={a,b,c};return #self.faces end
 function mesh:Destroy() self.destroyed=true end
 self.meshes[#self.meshes+1]=mesh;return mesh
end
local function meshSize(mesh: any): any
 local lo,hi={math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge}
 for _,p in ipairs(mesh.vertices) do for axis,key in ipairs({'X','Y','Z'}) do lo[axis]=math.min(lo[axis],p[key]);hi[axis]=math.max(hi[axis],p[key]) end end
 return Vector3.new(hi[1]-lo[1],hi[2]-lo[2],hi[3]-lo[3])
end
function service:CreateMeshPartAsync(content: any,_options: any): any
 self.partCalls+=1
 if fixture.partFailsAt==self.partCalls then error('controlled MeshPart refusal') end
 local mesh=content.object or self.ids[content.assetId]
 assert(mesh,'only actual retained/successfully uploaded fixture meshes')
 local part=Instance.new('MeshPart');part.MeshSize=meshSize(mesh);part._carrier=mesh
 if fixture.badMeshSize then part.MeshSize=Vector3.new(99,99,99) end
 self.parts[#self.parts+1]=part
 if fixture.partHook then fixture.partHook(part) end
 return part
end
function service:CreateAssetAsync(mesh: any,_type: any,_parameters: any): (any,any)
 self.uploads[#self.uploads+1]=mesh
 if fixture.rejectUpload==#self.uploads then return Enum.CreateAssetResult.UploadLimitExceeded,'controlled refusal' end
 local id=9000+#self.uploads;self.ids[id]=mesh;return Enum.CreateAssetResult.Success,id
end
services.AssetService=service
game.PlaceId=0;game.GameId=0
`;
const setup=String.raw`
local V=__mods.Validation;local Operations=__mods.Operations;local AssetPlacement=__mods.AssetPlacement;local AssetTransfer=__mods.AssetTransfer
local function close(a: number,b: number) assert(math.abs(a-b)<1e-5,tostring(a)..' != '..tostring(b)) end
local function same(a: any,b: any) local x,y={a:GetComponents()},{b:GetComponents()};for i=1,12 do close(x[i],y[i]) end end
local function rejects(code: string,fn: any): any local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..' got '..tostring(if type(e)=='table' then e.code else e));return e end
local workspace=game:GetService('Workspace')
workspace.Raycast=function() return {Position=Vector3.new(0,7,0)} end
local ops=Operations.new({sessionId='converted-session',allowedRoots={'Workspace'}},game,http)
local parent=ops.registry:ref(workspace)
local target={sessionId='converted-session',placeId=0,universeId=0,root='Workspace',parentRef=parent.instanceId,creator={kind='user',id='123'}}
local continuity={clientLifetimeId='fixture-life',pluginArtifactHash=string.rep('a',64),playEpoch=0}
local allowed=true
local function guard() if not allowed then V.fail('SCOPE','controlled stale scope') end end
function ops:importContext(_) return {sessionId=target.sessionId,parentRef=parent,placeId=0,universeId=0,mode='Edit',creator={status='unavailable',id=0},studioUser={status='available',id=123}} end
local function matrix(c: any): any local v={c:GetComponents()};return {v[4],v[7],v[10],0,v[5],v[8],v[11],0,v[6],v[9],v[12],0,v[1],v[2],v[3],1} end
local function bounds(points: any,transform: any): any
 local lo,hi={math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge}
 for _,p in ipairs(points) do local v={ (transform*CFrame.new(p[1],p[2],p[3])):GetComponents() };for a=1,3 do lo[a]=math.min(lo[a],v[a]);hi[a]=math.max(hi[a],v[a]) end end
 return {min=lo,max=hi}
end
local rootFrame=CFrame.new(2,3,4)*CFrame.Angles(0,math.pi/2,0)
local childFrame=CFrame.new(0,2,0)*CFrame.Angles(math.pi/2,0,0)
local a=rootFrame*childFrame;local b=CFrame.new(-5,0,2)
local positions={{3,1,0},{5,1,0},{5,2,0},{3,1,0},{5,2,0},{3,2,0}}
local nodeRows={{nodeKey='node0',localMatrix=matrix(rootFrame),name='Root'},
 {nodeKey='node1',parentKey='node0',localMatrix=matrix(childFrame),name='Empty ancestor'},
 {nodeKey='node2',parentKey='node1',localMatrix=matrix(CFrame.new()),name='Mesh group'},
 {nodeKey='node2_primitive0',parentKey='node2',localMatrix=matrix(CFrame.new()),name='Authored mesh'},
 {nodeKey='node3',parentKey='node0',localMatrix=matrix(CFrame.new(0,2^-40,0))},
 {nodeKey='node4',localMatrix=matrix(b),name='Second root'},
 {nodeKey='node4_primitive0',parentKey='node4',localMatrix=matrix(CFrame.new()),name='Second mesh'}}
local source={formatVersion=2,graph={schemaVersion=1,sourceSceneIndex=0,nodes=nodeRows,meshes={},digest=string.rep('d',64)},conversionRequest={schemaVersion=2,kind='converted-glb'},conversionRequestDigest=string.rep('e',64),
 conversion={sourceUnits='meters',sourceUp='Y',exportUnits='meters',exportUp='Y',targetUnits='studs',targetUp='Y',studsPerMeter=2}}
local seeds={}
local function add(role: string,key: any,transform: any,points: any,faces: any): ()
 local id='arcane_'..string.rep(tostring(#seeds+1),64)
 local association={sourceObjectId=id,nodeKey=key,sourcePivot={0,0,0},correspondenceSha256=if role=='render' then string.rep('c',64) else nil}
 local object={sourceObjectId=id,sourceKey=key or 'proxy',role=role,name=if role=='render' then 'Synthetic render' else 'Derived collision',
  bounds=bounds(points,CFrame.new()),worldBounds=bounds(points,transform),exportTransform=matrix(transform),scale={1,1,1},meshExportSha256=string.rep('f',64)}
 local p=buffer.create(#points*12);for i,v in ipairs(points) do for axis=1,3 do buffer.writef32(p,(i-1)*12+(axis-1)*4,v[axis]) end end
 local indices=buffer.create(#faces*2);for i,v in ipairs(faces) do buffer.writeu16(indices,(i-1)*2,v) end
 local data={primitives={{mode=4,vertexCount=#points,triangleCount=#faces/3,attributes={POSITION={semantic='POSITION',componentType=5126,type='VEC3',count=#points,normalized=false,byteLength=buffer.len(p),bytes=p}},
  indices={semantic='indices',componentType=5123,type='SCALAR',count=#faces,normalized=false,byteLength=buffer.len(indices),bytes=indices}}}}
 local plan=AssetTransfer.meshPartPlan(object,source.conversion,2)
 seeds[#seeds+1]={formatVersion=2,association=association,object=object,nativePlan=plan,data=data,conversion=source.conversion}
 source.graph.meshes[#source.graph.meshes+1]=association
end
add('render','node2_primitive0',a,positions,{0,1,2,3,4,5});add('render','node4_primitive0',b,positions,{0,1,2,3,4,5})
if collision then add('collision',nil,CFrame.new(),{{0,0,0},{2,0,0},{0,2,0},{0,0,2}},{0,2,1,0,1,3,0,3,2,1,2,3}) end
local expected={digest=string.rep('a',64),payloadDigest=string.rep('b',64),manifestDigest=string.rep('c',64)}
local summary={};for _,seed in ipairs(seeds) do summary[#summary+1]={sourceObjectId=seed.object.sourceObjectId,meshExportSha256=seed.object.meshExportSha256,vertexCount=seed.data.primitives[1].vertexCount,triangleCount=seed.data.primitives[1].triangleCount} end
local receiver={}
function receiver:status() return {state='sealed',packetCount=12,byteLength=1000} end
function receiver:graphPlan() return source end
function receiver:reconstructionPlan() return summary end
function receiver:cancel() end
function receiver:reconstruct(s: any,_admit: any): any
 local result={}
 for _,seed in ipairs(seeds) do
  local item=table.clone(seed);item.mesh=__mods.AssetMesh.create(seed.data,s,guard,function() end,seed.nativePlan.localBoundsCentre);result[#result+1]=item
 end
 return result
end
ops.assetTransfers[expected.digest]={receiver=receiver,expected=expected,target=target,continuity=continuity}
local nodes=V.array({})
for _,node in ipairs(nodeRows) do local id=V.NULL;for _,mesh in ipairs(source.graph.meshes) do if mesh.nodeKey==node.nodeKey then id=mesh.sourceObjectId end end;nodes[#nodes+1]={nodeKey=node.nodeKey,parentKey=node.parentKey or V.NULL,sourceObjectId=id} end
local reconstruct={formatVersion=2,graphDigest=source.graph.digest,nodeCount=#nodeRows,nodes=nodes,runId='11111111-1111-4111-8111-111111111111',expected=expected,packetCount=12,byteLength=1000,objects=summary,target=target,continuity=continuity}
local function prepare()
 -- The real Transport uses this strict codec; marked JSON arrays and null
 -- parents must reach the production operation rather than plain-table seeds.
 return ops:reconstructAsset(V.decode(V.encode(reconstruct,http),http),guard)
end
local serial=0
local function place(extra: any?): any
 serial+=1;local args={watch='editable-'..expected.digest,parent=parent,name='Converted placement',position={10,20,30},yaw=90,ground=false,anchor=true,allowScripts=false}
 for k,v in pairs(extra or {}) do args[k]=v end
 return ops:execute({id='place-'..serial,method='scene.place_asset',args=args},guard)
end
local function node(root: any,key: string): any for _,item in ipairs(root:GetDescendants()) do if item:GetAttribute('ArcaneConvertedNodeKey')==key then return item end end;error('missing node '..key) end
local function keep(extra: any?): any
 serial+=1;local args={source='editable-'..expected.digest,attemptId=string.format('00000000-0000-4000-8001-%012d',serial),name='Kept graph',description='',creatorId=123,continuity=continuity,finish=false}
 for k,v in pairs(extra or {}) do args[k]=v end
 ops.keepEngineDouble={service=service,AssetUpload=__mods.AssetUpload,enums={AssetType=Enum.AssetType,AssetCreatorType=Enum.AssetCreatorType,CreateAssetResult=Enum.CreateAssetResult},content=function(id) return {assetId=id} end,userId=function() return 123 end}
 return ops:keepReconstruction(args,guard)
end
`;
async function run(t,body,collision=false){
 const boundary=tmpdir(),directory=await mkdtemp(join(boundary,'arcane-converted-revision-'));
 t.after(async()=>{const r=relative(boundary,directory);assert.ok(r.startsWith('arcane-converted-revision-')&&!r.includes('..')&&!isAbsolute(r));await rm(directory,{recursive:true,force:true});});
 let source=(await readFile(join(resolve('.'),'plugin/fixtures/MockEngine.luau'),'utf8'))+'\n'+engine+'\n'+revisionEngine+'\nlocal __mods: any={}\n';
 for(const name of modules){
  if(name==='Operations')source+=`__mods.AssetMaterials={plan=function() return {supported=true} end,create=function() return {editableImages={},surfaceAppearance=Instance.new('SurfaceAppearance'),meshPartProperties={Color=Color3.new(.2,.4,.6),Transparency=0,DoubleSided=true}} end}\n`;
  source+='__mods.'+name+'=(function()\n'+(await readFile(join(resolve('.'),'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'__mods.$1')+'\nend)()\n';
 }
 source+='local collision='+collision+'\n'+setup+'\n'+revisionSetup+'\n'+body+'\nprint("CONVERTED_REVISION_OK")\n';
 const file=join(directory,'placement.luau');await writeFile(file,source);
 const result=spawnSync(runtime,[file],{encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:4*1024*1024});
 assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/CONVERTED_REVISION_OK/);
}

// Controlled sealed receiver metadata is the unit-test seam. The production
// AssetTransfer/raw packet chain has separate sender/receiver/bridge coverage;
// these cases exercise actual Operations + placement transactions and native
// object identity. All engine APIs, upload IDs and source pins below are doubles.
const revisionEngine=String.raw`
local Vector2: any={new=function(x: number,y: number): any return {X=x,Y=y} end}
function service:CreateEditableMesh(): any
 local mesh={ClassName="EditableMesh",next=0,vertices={},faces={},normals={},uvs={},colors={},alphas={},faceNormals={},faceUVs={},faceColors={},defaults={},destroyed=false}
 local function ids(values: any): any local out={};for id in pairs(values) do out[#out+1]=id end;table.sort(out);return out end
 local function allocate(self: any): number self.next+=1;return self.next end
 local function triangleNormal(self: any,vertices: any): any
  local a,b,c=self.vertices[vertices[1]],self.vertices[vertices[2]],self.vertices[vertices[3]]
  local ux,uy,uz=b.X-a.X,b.Y-a.Y,b.Z-a.Z;local vx,vy,vz=c.X-a.X,c.Y-a.Y,c.Z-a.Z
  return {X=uy*vz-uz*vy,Y=uz*vx-ux*vz,Z=ux*vy-uy*vx}
 end
 local function updateDefaults(self: any): ()
  for vertex,d in pairs(self.defaults) do
   local x,y,z=0,0,0
   for _,face in pairs(self.faces) do if table.find(face,vertex) then local n=triangleNormal(self,face);x+=n.X;y+=n.Y;z+=n.Z end end
   local length=math.sqrt(x*x+y*y+z*z)
   self.normals[d.normal]=if length>0 then Vector3.new(x/length,y/length,z/length) else Vector3.new(0,1,0)
  end
 end
 function mesh:AddVertex(value: any): number local id=allocate(self);self.vertices[id]=value;return id end
 function mesh:AddNormal(value: any): number local id=allocate(self);self.normals[id]=value;return id end
 function mesh:AddUV(value: any): number local id=allocate(self);self.uvs[id]=value;return id end
 function mesh:AddColor(value: any,alpha: number?): number local id=allocate(self);self.colors[id]=value;self.alphas[id]=if alpha==nil then 1 else alpha;return id end
 function mesh:AddTriangle(a: number,b: number,c: number): number
  assert(self.vertices[a] and self.vertices[b] and self.vertices[c],'triangle uses actual allocated vertices')
  local face=allocate(self);self.faces[face]={a,b,c};local normals,uvs,colors={}, {}, {}
  for _,vertex in ipairs(self.faces[face]) do
   local d=self.defaults[vertex]
   if not d then d={normal=self:AddNormal(Vector3.new(0,1,0)),uv=self:AddUV(Vector2.new(0,0)),color=self:AddColor(Color3.new(1,1,1),1)};self.defaults[vertex]=d end
   normals[#normals+1]=d.normal;uvs[#uvs+1]=d.uv;colors[#colors+1]=d.color
  end
  self.faceNormals[face]=normals;self.faceUVs[face]=uvs;self.faceColors[face]=colors;updateDefaults(self);return face
 end
 function mesh:SetFaceNormals(face: number,values: any): () assert(self.faces[face] and #values==3);for _,id in ipairs(values) do assert(self.normals[id],'actual normal ID') end;self.faceNormals[face]=table.clone(values) end
 function mesh:SetFaceUVs(face: number,values: any): () assert(self.faces[face] and #values==3);for _,id in ipairs(values) do assert(self.uvs[id],'actual UV ID') end;self.faceUVs[face]=table.clone(values) end
 function mesh:SetFaceColors(face: number,values: any): () assert(self.faces[face] and #values==3);for _,id in ipairs(values) do assert(self.colors[id],'actual color ID') end;self.faceColors[face]=table.clone(values) end
 function mesh:GetVertices(): any return ids(self.vertices) end
 function mesh:GetFaces(): any return ids(self.faces) end
 function mesh:GetBones(): any return {} end -- The fixture creates no bones.
 function mesh:GetPosition(id: number): any assert(self.vertices[id]);return self.vertices[id] end
 function mesh:GetFaceVertices(id: number): any assert(self.faces[id]);return table.clone(self.faces[id]) end
 function mesh:GetFaceNormals(id: number): any assert(self.faceNormals[id]);return table.clone(self.faceNormals[id]) end
 function mesh:GetFaceUVs(id: number): any assert(self.faceUVs[id]);return table.clone(self.faceUVs[id]) end
 function mesh:GetFaceColors(id: number): any assert(self.faceColors[id]);return table.clone(self.faceColors[id]) end
 function mesh:GetNormals(): any return ids(self.normals) end
 function mesh:GetNormal(id: number): any assert(self.normals[id]);return self.normals[id] end
 function mesh:GetUVs(): any return ids(self.uvs) end
 function mesh:GetUV(id: number): any assert(self.uvs[id]);return self.uvs[id] end
 function mesh:GetColors(): any return ids(self.colors) end
 function mesh:GetColor(id: number): any assert(self.colors[id]);return self.colors[id] end
 function mesh:GetColorAlpha(id: number): number assert(self.alphas[id]~=nil);return self.alphas[id] end
 function mesh:Destroy(): () assert(not self.destroyed,'resource must be released once');self.destroyed=true;self._destroyed=true end
 function mesh:IsA(class: string): boolean return class=='EditableMesh' end
 self.meshes[#self.meshes+1]=mesh
 return mesh
end
Content.fromObject=function(value: any): any return {object=value,Object=value} end
local createCarrier=service.CreateMeshPartAsync
function service:CreateMeshPartAsync(content: any,options: any): any
 local part=createCarrier(self,content,options)
 part.MeshContent=if content.assetId then {assetId=content.assetId,Uri='rbxassetid://'..content.assetId} else content;part.MeshId=if content.assetId then 'rbxassetid://'..content.assetId else ''
 part.TextureContent='none';part.RenderFidelity=options.RenderFidelity;part.CollisionFidelity=options.CollisionFidelity;part.FluidFidelity='Automatic'
 return part
end
function methods:ApplyMesh(other: any): ()
 assert(self:IsA('MeshPart') and other:IsA('MeshPart'))
 fixture.applyCalls=(fixture.applyCalls or 0)+1
 for _,key in ipairs({'MeshContent','MeshId','TextureContent','RenderFidelity','CollisionFidelity','FluidFidelity','MeshSize'}) do self[key]=other[key] end
 self._carrier=other.MeshContent.Object or service.ids[other.MeshContent.assetId]
 if fixture.applyHook then fixture.applyHook(self,other) end
 if fixture.applyFailsOnce then fixture.applyFailsOnce=false;error('controlled ApplyMesh post-effect failure') end
 if fixture.applyAlwaysFails then error('controlled ApplyMesh and rollback failure') end
end
`;
const revisionSetup=String.raw`
local function uuid(n: number): string return string.format('10000000-0000-4000-8000-%012d',n) end
local function copy(value: any): any
 if type(value)~='table' or value==V.NULL then return value end
 local result={};for key,item in pairs(value) do result[key]=copy(item) end
 return result
end
local function hash(text: string): string local digest=__mods.Sha256Stream.new();digest:update(text);return digest:digest() end
source.source={projectId=string.rep('1',64),jobId=reconstruct.runId,assetId='arcane_'..string.rep('2',64),sourceSha256=string.rep('3',64),preparedDigest=string.rep('4',64),
 manifestDigest=expected.manifestDigest,payloadDigest=expected.payloadDigest,transferDigest=expected.digest,graphDigest=source.graph.digest,conversionRequestDigest=source.conversionRequestDigest}
source.placement={mode='origin'}
source.conversionRequest.jobId=reconstruct.runId
source.delta={observation=nil}
local root: any=nil
local function begin(): any
 prepare();local placed=place();root=ops.registry:resolve(placed.ref);return placed
end
local function observe(n: number,pins: any?): any
 local src=pins or source.source
 local args={formatVersion=2,observationId=uuid(100+n),source=src,target=target,continuity=continuity,modelRef=ops.registry:ref(root)}
 local command={id=uuid(200+n),method='scene.observe_import',args=args}
 local observation=ops:execute(V.decode(V.encode(command,http),http),guard)
 -- The host canonical digest is metadata here; private command/body/cache are
 -- independently required by the actual plugin, never this hash alone.
 return {commandId=command.id,receiptSha256=hash('synthetic host canonical digest '..n),observation=observation}
end
local function cframe(m: any): any return CFrame.new(m[13],m[14],m[15],m[1],m[5],m[9],m[2],m[6],m[10],m[3],m[7],m[11]) end
local function change(n: number,observation: any,edits: any?): any
 local edit=edits or {};local nextSource=copy(source);local nextSeeds={}
 for _,seed in ipairs(seeds) do local value=copy(seed);value.data={primitives={}}
  for _,primitive in ipairs(seed.data.primitives) do local p=copy(primitive);p.attributes.POSITION.bytes=buffer.fromstring(buffer.tostring(primitive.attributes.POSITION.bytes));value.data.primitives[#value.data.primitives+1]=p end
  nextSeeds[#nextSeeds+1]=value
 end
 local changedNodes={};local changedObjects={}
 if edit.name then nextSource.graph.nodes[2].name='Exact revised name';changedNodes.node1={'name'} end
 if edit.reparent then nextSource.graph.nodes[5].parentKey='node4';changedNodes.node3={'parent','matrix'} end
 if edit.geometry then
  local resource=nextSeeds[1];local stream=resource.data.primitives[1].attributes.POSITION.bytes
  for i=0,5 do local x=buffer.readf32(stream,i*12);if x==5 then buffer.writef32(stream,i*12,6) end end
  resource.object.meshExportSha256=string.rep('9',64);changedObjects[resource.object.sourceObjectId]={'geometry'}
 end
 if edit.material then nextSeeds[1].object.materialSha256=string.rep('8',64);nextSeeds[1].material={sha256=string.rep('8',64)};changedObjects[nextSeeds[1].object.sourceObjectId]={'material'} end
 if edit.remove then
  table.remove(nextSeeds,2);table.remove(nextSource.graph.meshes,2)
  table.remove(nextSource.graph.nodes,7);table.remove(nextSource.graph.nodes,6)
 end
 if edit.create then
  nextSource.graph.nodes[#nextSource.graph.nodes+1]={nodeKey='node9',localMatrix=matrix(CFrame.new(7,2,-3)),name='New exact group'}
  nextSource.graph.nodes[#nextSource.graph.nodes+1]={nodeKey='node9_primitive0',parentKey='node9',localMatrix=matrix(CFrame.new()),name='New exact mesh'}
  local resource=copy(nextSeeds[1]);resource.object.sourceObjectId='arcane_'..string.rep('7',64);resource.object.sourceKey='node9_primitive0';resource.association.sourceObjectId=resource.object.sourceObjectId;resource.association.nodeKey='node9_primitive0'
  nextSeeds[#nextSeeds+1]=resource;nextSource.graph.meshes[#nextSource.graph.meshes+1]=resource.association
 end
 local worlds={};local pending=#nextSource.graph.nodes
 while pending>0 do local advanced=false
  for _,row in ipairs(nextSource.graph.nodes) do if not worlds[row.nodeKey] and (not row.parentKey or worlds[row.parentKey]) then
   worlds[row.nodeKey]=(worlds[row.parentKey] or CFrame.new())*cframe(row.localMatrix);pending-=1;advanced=true
  end end
  assert(advanced)
 end
 for _,resource in ipairs(nextSeeds) do
  local transform=if resource.object.role=='render' then worlds[resource.association.nodeKey] else cframe(resource.object.exportTransform)
  resource.object.exportTransform=matrix(transform)
  local points={};local bytes=resource.data.primitives[1].attributes.POSITION.bytes
  for i=0,resource.data.primitives[1].vertexCount-1 do points[#points+1]={buffer.readf32(bytes,i*12),buffer.readf32(bytes,i*12+4),buffer.readf32(bytes,i*12+8)} end
  resource.object.bounds=bounds(points,CFrame.new());resource.object.worldBounds=bounds(points,transform);resource.nativePlan=AssetTransfer.meshPartPlan(resource.object,nextSource.conversion,2)
 end
 local graphChanged=edit.name or edit.reparent or edit.remove or edit.create
 if graphChanged then nextSource.graph.digest=hash('synthetic reviewed graph '..n) end
 local expectedNext={digest=hash('synthetic sealed transfer '..n),payloadDigest=hash('synthetic payload '..n),manifestDigest=hash('synthetic manifest '..n)}
 nextSource.source=copy(source.source);nextSource.source.jobId=uuid(300+n);nextSource.source.preparedDigest=hash('synthetic prepared '..n);nextSource.source.manifestDigest=expectedNext.manifestDigest
 nextSource.source.payloadDigest=expectedNext.payloadDigest;nextSource.source.transferDigest=expectedNext.digest;nextSource.source.graphDigest=nextSource.graph.digest
 local delta={previousDigest=source.source.manifestDigest,nextDigest=expectedNext.manifestDigest,receiptSha256=observation.receiptSha256,modelRef=observation.observation.modelRef.instanceId,modelAssetId=V.NULL,placementChanged=false,
  objects={},nodes={},reviewRemovals={},reviewNodeRemovals={},reviewAnchors={},geometry={prepare={},reuse={}},textures={prepare={},reuse={}},preservation='preserve-all-scripts-attachments-constraints',
  graph={previousDigest=source.graph.digest,nextDigest=nextSource.graph.digest,changed=graphChanged==true},observation=observation}
 local function mapping(rows: any,key: string,value: string): any for _,row in ipairs(rows) do if row[key]==value then return row end end;return nil end
 for _,row in ipairs(nextSource.graph.nodes) do
  local old=mapping(source.graph.nodes,'nodeKey',row.nodeKey);local observed=mapping(observation.observation.nodes,'nodeKey',row.nodeKey);local changes=changedNodes[row.nodeKey] or {}
  delta.nodes[#delta.nodes+1]={nodeKey=row.nodeKey,action=if not old then 'create' elseif #changes>0 then 'update-in-place' else 'reuse',changed=changes,instanceRef=if observed then observed.instanceRef else V.NULL,
   expectedOwnedStateSha256=if observed then observed.ownedStateSha256 else V.NULL,preserveChildren=if observed then observed.authoredChildren else {},replaceInstance=false,deleteInstance=false}
 end
 for _,resource in ipairs(nextSeeds) do local id=resource.object.sourceObjectId;local observed=mapping(observation.observation.objects,'sourceObjectId',id);local changes=changedObjects[id] or {}
  delta.objects[#delta.objects+1]={sourceObjectId=id,action=if not observed then 'create' elseif #changes>0 then 'update-in-place' else 'reuse',changed=changes,instanceRef=if observed then observed.instanceRef else V.NULL,
   meshAssetId=if observed then observed.meshAssetId else V.NULL,expectedOwnedStateSha256=if observed then observed.ownedStateSha256 else V.NULL,preserveChildren=if observed then observed.authoredChildren else {},replaceInstance=false,deleteInstance=false}
 end
 for _,observed in ipairs(observation.observation.nodes) do if not mapping(nextSource.graph.nodes,'nodeKey',observed.nodeKey) then local row=copy(observed);row.action='retain-for-review';delta.reviewNodeRemovals[#delta.reviewNodeRemovals+1]=row end end
 for _,observed in ipairs(observation.observation.objects) do if not mapping(nextSource.graph.meshes,'sourceObjectId',observed.sourceObjectId) then local row=copy(observed);row.action='retain-for-review';delta.reviewRemovals[#delta.reviewRemovals+1]=row end end
 nextSource.delta=delta
 local summaryNext={};for _,seed in ipairs(nextSeeds) do local p=seed.data.primitives[1];summaryNext[#summaryNext+1]={sourceObjectId=seed.object.sourceObjectId,meshExportSha256=seed.object.meshExportSha256,vertexCount=p.vertexCount,triangleCount=p.triangleCount} end
 local receiverNext={}
 function receiverNext:status() return {state='sealed',packetCount=15,byteLength=1234} end
 function receiverNext:graphPlan() return nextSource end
 function receiverNext:reconstructionPlan() return summaryNext end
 function receiverNext:cancel() end
 function receiverNext:reconstruct(s: any,_admit: any): any
  local result={};for _,seed in ipairs(nextSeeds) do local item=table.clone(seed);item.mesh=__mods.AssetMesh.create(seed.data,s,guard,function() end,seed.nativePlan.localBoundsCentre);result[#result+1]=item end;return result
 end
 ops.assetTransfers[expectedNext.digest]={receiver=receiverNext,expected=expectedNext,target=target,continuity=continuity}
 local children={};for _,row in ipairs(nextSource.graph.nodes) do local key=row.parentKey or '';children[key]=children[key] or {};table.insert(children[key],row) end
 for _,rows in pairs(children) do table.sort(rows,function(a,b) return a.nodeKey<b.nodeKey end) end
 local logical=V.array({});local stack={};for i=#(children[''] or {}),1,-1 do stack[#stack+1]=children[''][i] end
 while #stack>0 do local row=table.remove(stack);local objectId=V.NULL;for _,mesh in ipairs(nextSource.graph.meshes) do if mesh.nodeKey==row.nodeKey then objectId=mesh.sourceObjectId end end
  logical[#logical+1]={nodeKey=row.nodeKey,parentKey=row.parentKey or V.NULL,sourceObjectId=objectId}
  for i=#(children[row.nodeKey] or {}),1,-1 do stack[#stack+1]=children[row.nodeKey][i] end
 end
 local args={formatVersion=2,graphDigest=nextSource.graph.digest,nodeCount=#logical,nodes=logical,runId=uuid(400+n),expected=expectedNext,packetCount=15,byteLength=1234,objects=summaryNext,target=target,continuity=continuity}
 ops:reconstructAsset(V.decode(V.encode(args,http),http),guard)
 return {source=nextSource,seeds=nextSeeds,args={formatVersion=2,runId=args.runId,expected=expectedNext,packetCount=15,byteLength=1234,source=nextSource.source,target=target,continuity=continuity,observation=observation}}
end
local function apply(n: number,next: any,fresh: any): any
 local args=table.clone(next.args);args.currentObservation=fresh
 return ops:execute(V.decode(V.encode({id=uuid(500+n),method='asset.apply_revision',args=args},http),http),guard)
end
local function accept(next: any): () source=next.source;seeds=next.seeds;expected={digest=source.source.transferDigest,payloadDigest=source.source.payloadDigest,manifestDigest=source.source.manifestDigest} end
local function grow(count: number): ()
 while #nodeRows<count do nodeRows[#nodeRows+1]={nodeKey='node'..(100+#nodeRows),localMatrix=matrix(CFrame.new()),name='Boundary EMPTY '..#nodeRows} end
 local children={};for _,row in ipairs(nodeRows) do local key=row.parentKey or '';children[key]=children[key] or {};table.insert(children[key],row) end
 for _,rows in pairs(children) do table.sort(rows,function(a,b) return a.nodeKey<b.nodeKey end) end
 table.clear(nodes);local stack={};for i=#children[''],1,-1 do stack[#stack+1]=children[''][i] end
 while #stack>0 do local row=table.remove(stack);local id=V.NULL;for _,mesh in ipairs(source.graph.meshes) do if mesh.nodeKey==row.nodeKey then id=mesh.sourceObjectId end end
  nodes[#nodes+1]={nodeKey=row.nodeKey,parentKey=row.parentKey or V.NULL,sourceObjectId=id}
  for i=#(children[row.nodeKey] or {}),1,-1 do stack[#stack+1]=children[row.nodeKey][i] end
 end
 reconstruct.nodeCount=#nodes
end
`;

for(const collision of [false,true])test(`converted ${collision?'hull':'none'} revision consumes a new live observation and reuses the same graph Instances`,options,t=>run(t,String.raw`
begin();local originalRoot=root;local original=node(root,'node2_primitive0');local pivot=root.WorldPivot
local first=observe(1);local next=change(1,first);local fresh=observe(2)
local count=#service.parts;local result=apply(1,next,fresh)
assert(result.state=='applied' and result.receiptScope=='live-import-revision' and result.observationId==fresh.observation.observationId)
assert(result.source.transferDigest==next.source.source.transferDigest and result.modelRef.instanceId==first.observation.modelRef.instanceId)
assert(root==originalRoot and node(root,'node2_primitive0')==original and #service.parts==count and (fixture.applyCalls or 0)==0)
same(root.WorldPivot,pivot);assert(result.imported==false and result.engineVerification=='pending' and #result.nodes==7 and #result.objects==#seeds)
assert(result.objects[1].meshAssetId==V.NULL)
rejects('STATE',function() apply(2,next,fresh) end)
accept(next);local second=observe(3);assert(second.observation.source.transferDigest==result.source.transferDigest)
`,collision));

test('same-instance geometry, material, reparent/name/create and retain-for-review preserve authored children and source-zero pivots',options,t=>run(t,String.raw`
begin();local original=node(root,'node2_primitive0');local oldGroup=node(root,'node1');local removed=node(root,'node4');local rootPivot=root.WorldPivot
local script=Instance.new('Script');script.Source='return "authored"';script.Parent=oldGroup
local attachment=Instance.new('Attachment');attachment.CFrame=CFrame.new(1,2,3);attachment.Parent=original
local first=observe(1);assert(#first.observation.nodes[2].authoredChildren==1)
local next=change(1,first,{geometry=true,name=true,remove=true,create=true})
local fresh=observe(2);local result=apply(1,next,fresh)
assert(node(root,'node2_primitive0')==original and node(root,'node1')==oldGroup and oldGroup.Name=='Exact revised name')
assert(removed.Parent==root and not removed._destroyed and node(root,'node9_primitive0').Parent==node(root,'node9'))
assert(script.Parent==oldGroup and script.Source=='return "authored"' and attachment.Parent==original and not script._destroyed and not attachment._destroyed)
same(attachment.CFrame,CFrame.new(1,2,3));same(root.WorldPivot,rootPivot)
assert(fixture.applyCalls==1 and original._carrier.vertices[2].X==1.5,'Actual centered new carrier is applied, not the original off-centre source')
assert(result.objects[1].meshAssetId==V.NULL and #result.nodes==7)
accept(next);local beforeMaterial=observe(3);local material=change(2,beforeMaterial,{material=true});local currentMaterial=observe(4)
local oldAppearance=original:GetChildren()[1];local materialResult=apply(2,material,currentMaterial)
assert(node(root,'node2_primitive0')==original and fixture.applyCalls==1 and attachment.Parent==original and materialResult.state=='applied')
assert(oldAppearance==attachment or oldAppearance._destroyed,'Only owned appearances may be replaced')
`));

test('direct-parent revision changes the exact EMPTY edge without recursively moving authored children',options,t=>run(t,String.raw`
begin();local leaf=node(root,'node3');local first=observe(1);local next=change(1,first,{reparent=true});local fresh=observe(2)
local result=apply(1,next,fresh);assert(result.state=='applied' and leaf.Parent==node(root,'node4') and node(root,'node3')==leaf and (fixture.applyCalls or 0)==0)
`));

for(const fault of ['old-witness','foreign-copy','owned-change','authored-change','scope','source'])test(`converted revision ${fault} refuses before allocating revision carriers`,options,t=>run(t,`
begin();local child=Instance.new('Attachment');child.CFrame=CFrame.new();child.Parent=node(root,'node1')
local first=observe(1);local next=change(1,first,{geometry=true});local fresh=observe(2);local count=#service.parts
${fault==='old-witness'?'fresh=first':fault==='foreign-copy'?'fresh=copy(fresh);fresh.commandId=uuid(999)':fault==='owned-change'?'node(root,"node1").Name="Human changed"':fault==='authored-change'?'child.CFrame=CFrame.new(1,2,3)':fault==='scope'?'allowed=false':'next.args.source=copy(next.args.source);next.args.source.sourceSha256=string.rep("0",64)'}
local ok=pcall(function() apply(1,next,fresh) end);assert(not ok and #service.parts==count and root.Parent==workspace and not child._destroyed)
`));

for(const fault of ['apply','recording','late-child'])test(`converted ${fault} failure rolls back same-instance state and never replays the consumed revision`,options,t=>run(t,`
begin();local original=node(root,'node2_primitive0');local oldCarrier=original._carrier;local pivot=original.PivotOffset;local parentBefore=original.Parent;local name=node(root,'node1').Name
local first=observe(1);local next=change(1,first,{geometry=true,name=true});local fresh=observe(2)
${fault==='apply'?'fixture.applyFailsOnce=true':fault==='recording'?'fixture.failFinish=true':'fixture.partHook=function() local child=Instance.new("Attachment");child.CFrame=CFrame.new();child.Parent=node(root,"node1");fixture.lateChild=child end'}
local ok=pcall(function() apply(1,next,fresh) end);assert(not ok)
fixture.failFinish=false;fixture.partHook=nil
assert(node(root,'node2_primitive0')==original and original._carrier==oldCarrier and original.Parent==parentBefore and node(root,'node1').Name==name)
same(original.PivotOffset,pivot)
if fixture.lateChild then assert(fixture.lateChild.Parent==node(root,'node1') and not fixture.lateChild._destroyed) end
local calls=service.partCalls;local again=pcall(function() apply(2,next,fresh) end);assert(not again and service.partCalls==calls)
`));

test('failed ApplyMesh rollback becomes an unsafe permanent fence without deleting authored children',options,t=>run(t,String.raw`
begin();local child=Instance.new('Attachment');child.CFrame=CFrame.new();child.Parent=node(root,'node1')
local first=observe(1);local next=change(1,first,{geometry=true});local fresh=observe(2)
fixture.applyAlwaysFails=true;local failed=rejects('CLEANUP',function() apply(1,next,fresh) end)
assert(ops.assetCleanupFailed and child.Parent~=nil and not child._destroyed and root.Parent==workspace)
fixture.applyAlwaysFails=false;rejects('CLEANUP',function() ops:stageAssetPacket({expected=expected,packet='{}',target=target,continuity=continuity},guard) end)
`));

for(const collision of [false,true])test(`a full128 final ${collision?'hull':'none'} graph may revise with separately bounded detached carriers`,options,t=>run(t,`
grow(${collision?126:127});begin();local first=observe(1);local next=change(1,first,{geometry=true});local fresh=observe(2)
local original=node(root,'node2_primitive0');local result=apply(1,next,fresh)
local count=1;for _,item in ipairs(root:GetDescendants()) do if item:IsA('Model') or item:IsA('MeshPart') then count+=1 end end
assert(result.state=='applied' and count==128 and original==node(root,'node2_primitive0') and fixture.applyCalls==1)
local detachedGeometry=0;for _,item in ipairs(fixture.created) do if item:IsA('MeshPart') and item.Parent==nil and not item._destroyed then detachedGeometry+=1 end end
assert(detachedGeometry==0,'Every carrier and rollback MeshPart is retired after commit')
`,collision));

test('retained review removals count toward the128 final graph cap before any revision allocation',options,t=>run(t,String.raw`
grow(126);begin();local first=observe(1);local next=change(1,first,{remove=true,create=true});local fresh=observe(2)
local parts=#service.parts;local allocations=fixture.allocations
rejects('BODY_LIMIT',function() apply(1,next,fresh) end)
assert(#service.parts==parts and fixture.allocations==allocations and node(root,'node4').Parent==root)
`));

for(const fault of ['action','children','model-id','placement'])test(`sealed converted delta ${fault} inconsistency refuses before native allocation`,options,t=>run(t,`
begin();local child=Instance.new('Attachment');child.CFrame=CFrame.new();child.Parent=node(root,'node1')
local first=observe(1);local next=change(1,first,{name=true});local fresh=observe(2)
${fault==='action'?'next.source.delta.nodes[2].action="reuse"':fault==='children'?'next.source.delta.nodes[2].preserveChildren={}':fault==='model-id'?'next.source.delta.modelAssetId="123"':'next.source.delta.placementChanged=true'}
local parts=#service.parts;local allocations=fixture.allocations;local ok=pcall(function() apply(1,next,fresh) end)
assert(not ok and #service.parts==parts and fixture.allocations==allocations and child.Parent==node(root,'node1'))
`));

test('real returned keep IDs survive geometry reuse; changed geometry becomes live and can be kept without losing authored children',options,t=>run(t,String.raw`
begin();local kept=keep();assert(kept.state=='kept' and kept.meshes[1].assetId==9001)
local original=node(root,'node2_primitive0');local first=observe(1);assert(first.observation.objects[1].meshAssetId=='9001')
local next=change(1,first,{name=true});local fresh=observe(2);local reused=apply(1,next,fresh)
assert(node(root,'node2_primitive0')==original and reused.objects[1].meshAssetId=='9001')
accept(next);local child=Instance.new('Attachment');child.CFrame=CFrame.new(2,3,4);child.Parent=original
local second=observe(3);local geometry=change(2,second,{geometry=true});local current=observe(4);local changed=apply(2,geometry,current)
assert(changed.objects[1].meshAssetId==V.NULL and node(root,'node2_primitive0')==original)
accept(geometry);local keptAgain=keep();assert(keptAgain.state=='kept' and keptAgain.converted.objects[1].meshAssetId~=nil)
local persistent=node(root,'node2_primitive0');assert(child.Parent==persistent and not child._destroyed);same(child.CFrame,CFrame.new(2,3,4))
local observed=observe(5);assert(observed.observation.objects[1].meshAssetId==keptAgain.converted.objects[1].meshAssetId)
`));

test('fresh observation rejects a substituted live mesh or invented persistent ID without a usable witness',options,t=>run(t,String.raw`
begin();local part=node(root,'node2_primitive0');local original=part.MeshContent
part.MeshContent={Object={}};rejects('CONFLICT',function() observe(1) end);part.MeshContent=original
local read=observe(2);assert(read.observation.objects[1].meshAssetId==V.NULL)
local kept=keep();assert(kept.state=='kept');local current=node(root,'node2_primitive0');current.MeshId='rbxassetid://999999'
rejects('CONFLICT',function() observe(3) end)
`));

for(const mutation of ['position','topology','normal','uv','color'])test(`fresh observation reads actual native ${mutation} data instead of trusting the retained Content pointer`,options,t=>run(t,`
begin();local original=observe(1);local mesh=node(root,'node2_primitive0').MeshContent.Object
${mutation==='position'?'local id=mesh:GetVertices()[2];local p=mesh:GetPosition(id);mesh.vertices[id]=Vector3.new(p.X-.125,p.Y,p.Z)':mutation==='topology'?'local face=mesh:GetFaces()[1];mesh.faces[face][1],mesh.faces[face][2]=mesh.faces[face][2],mesh.faces[face][1]':mutation==='normal'?'mesh.normals[mesh:GetNormals()[1]]=Vector3.new(1,0,0)':mutation==='uv'?'local id=mesh:GetUVs()[1];mesh.uvs[id]={X=.125,Y=0}':'mesh.colors[mesh:GetColors()[1]]=Color3.new(.5,1,1)'}
local before=#service.parts;rejects('CONFLICT',function() observe(2) end);assert(#service.parts==before and root.Parent==workspace)
`));

