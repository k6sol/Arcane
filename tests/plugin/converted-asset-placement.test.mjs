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
  indices={semantic='INDICES',componentType=5123,type='SCALAR',count=#faces,normalized=false,byteLength=buffer.len(indices),bytes=indices}}}}
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
 const boundary=tmpdir(),directory=await mkdtemp(join(boundary,'arcane-converted-placement-'));
 t.after(async()=>{const r=relative(boundary,directory);assert.ok(r.startsWith('arcane-converted-placement-')&&!r.includes('..')&&!isAbsolute(r));await rm(directory,{recursive:true,force:true});});
 let source=(await readFile(join(resolve('.'),'plugin/fixtures/MockEngine.luau'),'utf8'))+'\n'+engine+'\nlocal __mods: any={}\n';
 for(const name of modules){
  if(name==='Operations')source+=`__mods.AssetMaterials={plan=function() return {supported=true} end,create=function() return {surfaceAppearance=Instance.new('SurfaceAppearance'),meshPartProperties={Color=Color3.new(.2,.4,.6),Transparency=0,DoubleSided=true}} end}\n`;
  source+='__mods.'+name+'=(function()\n'+(await readFile(join(resolve('.'),'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'__mods.$1')+'\nend)()\n';
 }
 source+='local collision='+collision+'\n'+setup+'\n'+body+'\nprint("CONVERTED_PLACEMENT_OK")\n';
 const file=join(directory,'placement.luau');await writeFile(file,source);
 const result=spawnSync(runtime,[file],{encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:4*1024*1024});
 assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/CONVERTED_PLACEMENT_OK/);
}

for(const collision of [false,true])test(`converted ${collision?'hull':'none'} materialization preserves every EMPTY/direct parent and source-zero pivot`,options,t=>run(t,String.raw`
local receipt=prepare();assert(receipt.formatVersion==2 and receipt.nodeCount==7 and #service.parts==0)
assert(receipt.nodes[1].instanceRef==nil and receipt.imported==false and receipt.engineVerification=='pending')
local result=place();local root=ops.registry:resolve(result.ref)
assert(#root:GetDescendants()==7+(if collision then 1 else 0)+2)
assert(node(root,'node1').Parent==node(root,'node0') and node(root,'node2_primitive0').Parent==node(root,'node2'))
assert(node(root,'node3').Name=='node3' and #node(root,'node3'):GetChildren()==0 and node(root,'node4').Parent==root)
local observed=result.converted;assert(#observed.nodes==7 and #observed.objects==#seeds and observed.receiptScope=='studio-session-observation')
assert(observed.imported==false and observed.engineVerification=='pending')
for _,mapping in ipairs(observed.nodes) do assert(mapping.meshAssetId==nil and #mapping.authoredChildren==0 and #mapping.ownedStateSha256==64) end
local part=node(root,'node2_primitive0');local pivot=part:GetPivot();assert(not V.equal({part.CFrame:GetComponents()},{pivot:GetComponents()}))
local carrier=part._carrier;local lo,hi=bounds({{carrier.vertices[1].X,carrier.vertices[1].Y,carrier.vertices[1].Z},{carrier.vertices[2].X,carrier.vertices[2].Y,carrier.vertices[2].Z},{carrier.vertices[3].X,carrier.vertices[3].Y,carrier.vertices[3].Z}},CFrame.new()).min,
 bounds({{carrier.vertices[1].X,carrier.vertices[1].Y,carrier.vertices[1].Z},{carrier.vertices[2].X,carrier.vertices[2].Y,carrier.vertices[2].Z},{carrier.vertices[3].X,carrier.vertices[3].Y,carrier.vertices[3].Z}},CFrame.new()).max
close((lo[1]+hi[1])/2,0);close((lo[2]+hi[2])/2,0);close(part.Size.Z,.05)
-- Independently reconstruct an off-origin source point from the centered
-- actual carrier, then compare source-origin and physical-center frames.
local p=carrier.vertices[1];same(part.CFrame*CFrame.new(p.X*2,p.Y*2,0),pivot*CFrame.new(positions[1][1]*2,positions[1][2]*2,0))
local meshMapping;for _,m in ipairs(observed.nodes) do if m.nodeKey=='node2_primitive0' then meshMapping=m end end
assert(meshMapping.instanceRef==observed.objects[1].instanceRef and meshMapping.ownedStateSha256==observed.objects[1].ownedStateSha256)
if collision then local proxy=service.parts[3];assert(proxy.Parent==root and proxy.Transparency==1 and proxy.CanCollide and proxy:GetAttribute('ArcaneConvertedNodeKey')==nil) end
rejects('STATE',function() place() end)
`,collision));

test('converted fitting and scene.build clones use source bounds and independently preserve noncommuting pivots',options,t=>run(t,String.raw`
prepare();local result=place({maxSize={40,40,40},ground=true});local original=ops.registry:resolve(result.ref)
close(original.WorldPivot.c[2],7)
local build=ops:execute({id='build-1',method='scene.build',args={parent=parent,container={className='Model',name='Clones'},templates={result.ref},items={{kind='clone',template=1,name='Copy',parent=0,at={-20,4,5},yaw=-35,scale=1.5,key='copy'}}}},guard)
assert(#build.converted==1 and #build.converted[1].observation.nodes==7)
local copy=ops.registry:resolve(build.refs.copy);local sourceMesh=node(original,'node2_primitive0');local mesh=node(copy,'node2_primitive0')
local relative=original:GetPivot():Inverse()*sourceMesh:GetPivot();local values={relative:GetComponents()};values[1]*=1.5;values[2]*=1.5;values[3]*=1.5
same(mesh:GetPivot(),copy:GetPivot()*CFrame.new(table.unpack(values)));close(mesh.Size.Z,.05)
assert(node(copy,'node1').Parent==node(copy,'node0') and node(copy,'node3').Parent==node(copy,'node0'))
local child=Instance.new('Attachment');child.Name='Human child';child.Parent=node(copy,'node1')
rejects('CONFLICT',function() ops:restore({id='restore',method='scene.restore'},{receiptCommandId='build-1',mutation=build.mutation},guard) end)
assert(child.Parent~=nil and not child._destroyed)
`));

test('converted changed transform/name/parent or authored child blocks cloning and restoration without deletion',options,t=>run(t,String.raw`
prepare();local result=place();local root=ops.registry:resolve(result.ref);local group=node(root,'node1');local old=group.WorldPivot
group.WorldPivot=CFrame.new(1,2,3)
rejects('CONFLICT',function() AssetPlacement.buildTemplates(ops,{result.ref}) end)
group.WorldPivot=old
local oldName=group.Name;group.Name='Human name';rejects('CONFLICT',function() AssetPlacement.buildTemplates(ops,{result.ref}) end);group.Name=oldName
local oldParent=group.Parent;group.Parent=node(root,'node4') -- World geometry is unchanged; direct graph parent still matters.
rejects('CONFLICT',function() AssetPlacement.buildTemplates(ops,{result.ref}) end);group.Parent=oldParent
local child=Instance.new('Attachment');child.Parent=group
rejects('CONFLICT',function() AssetPlacement.restore(ops,{id='undo'},result.mutation,root,guard) end)
assert(not child._destroyed and root.Parent==workspace)
`));

test('converted reconstruction binds marked null/array summaries and refuses caller graph edits before allocation',options,t=>run(t,String.raw`
local digest=reconstruct.graphDigest;reconstruct.graphDigest=string.rep('0',64)
rejects('SCOPE',prepare);reconstruct.graphDigest=digest
local original=nodes[1].sourceObjectId;nodes[1].sourceObjectId=seeds[1].object.sourceObjectId
rejects('SCOPE',prepare);nodes[1].sourceObjectId=original
assert(#service.meshes==0 and #service.parts==0)
local result=prepare();assert(result.nodes[1].parentKey==V.NULL and result.nodes[1].sourceObjectId==V.NULL)
`));

test('converted preflight refuses shear, reflection, grouping scale, hierarchy and thin sizes before material allocation',options,t=>run(t,String.raw`
local resources={};for _,seed in ipairs(seeds) do resources[#resources+1]=seed end
for _,change in ipairs({function(m) m[5]=.2 end,function(m) m[1]=-1 end,function(m) m[1]=2 end}) do
 local saved=nodeRows[1].localMatrix;nodeRows[1].localMatrix=table.clone(saved);change(nodeRows[1].localMatrix)
 rejects('UNSUPPORTED_TRANSFORM',function() AssetPlacement.convertedPlan(source,resources) end);nodeRows[1].localMatrix=saved
end
local saved=nodeRows[2].parentKey;nodeRows[2].parentKey='missing';rejects('IDENTITY',function() AssetPlacement.convertedPlan(source,resources) end);nodeRows[2].parentKey=saved
local planned=AssetPlacement.convertedPlan(source,resources);rejects('UNSUPPORTED_TRANSFORM',function() AssetPlacement.convertedScale(planned,{.2,.2,.2},0) end)
assert(#service.parts==0 and #service.meshes==0)
`));

for(const failure of ['allocation','scope','mesh-size'])test(`converted ${failure} refusal owns and releases every detached allocation without replay`,options,t=>run(t,`
prepare();local start=#fixture.created
${failure==='allocation'?'fixture.partFailsAt=2':failure==='scope'?'fixture.partHook=function() allowed=false end':'fixture.badMeshSize=true'}
local ok=pcall(place);assert(not ok)
allowed=true;fixture.partFailsAt=nil;fixture.partHook=nil;fixture.badMeshSize=nil
rejects('STATE',function() place() end)
ops:cancelAssetTransfers() -- Retire the deliberately retained source/material owner too.
for i=start+1,#fixture.created do assert(fixture.created[i]._destroyed,'detached allocation leaked') end
`));

test('converted keep uses genuine uploaded IDs and remaps complete graph/pivots after persistent replacement',options,t=>run(t,String.raw`
prepare();local placed=place();local root=ops.registry:resolve(placed.ref);local old=node(root,'node2_primitive0');local pivot=old:GetPivot();local offset=old.PivotOffset
local result=keep();assert(result.state=='kept' and result.swapped==2 and #service.uploads==2)
local part=node(root,'node2_primitive0');assert(part~=old and old._destroyed and part.Parent==node(root,'node2'))
same(part:GetPivot(),pivot);same(part.PivotOffset,offset)
assert(result.converted.objects[1].meshAssetId==tostring(result.meshes[1].assetId) and result.meshes[1].assetId==9001)
assert(result.converted.nodes[4].instanceRef==result.converted.objects[1].instanceRef)
assert(AssetPlacement.convertedMatches(root,ops))
local count=#service.uploads
local finish=keep({finish=true,assetIds={9001,9002}});assert(finish.state=='kept' and #service.uploads==count)
`));

test('converted partial uploads retain genuine IDs and original graph without fabricated observation',options,t=>run(t,String.raw`
prepare();local placed=place();local root=ops.registry:resolve(placed.ref);local original=node(root,'node2_primitive0')
fixture.rejectUpload=2;local partial=keep();assert(partial.state=='partial' and partial.meshes[1].assetId==9001 and partial.meshes[2].assetId==V.NULL and partial.converted==nil)
assert(node(root,'node2_primitive0')==original and not original._destroyed)
`));

test('converted failed swap rolls back full private graph and finish reuses only its returned IDs',options,t=>run(t,String.raw`
prepare();local placed=place();local root=ops.registry:resolve(placed.ref);local original=node(root,'node2_primitive0')
fixture.failFinish=true
local rolled=keep()
assert(rolled.state=='uploaded' and rolled.meshes[1].assetId==9001 and rolled.converted==nil and rolled.swapped==0)
assert(node(root,'node2_primitive0')==original and not original._destroyed and AssetPlacement.convertedMatches(root,ops))
fixture.failFinish=false
local uploads=#service.uploads;local result=keep({finish=true,assetIds={rolled.meshes[1].assetId,rolled.meshes[2].assetId}})
assert(result.state=='kept' and result.uploadsStarted==0 and #service.uploads==uploads and result.converted.objects[1].meshAssetId=='9001')
`));

test('converted keep refuses changed graph before upload and preserves a late authored child with returned IDs',options,t=>run(t,String.raw`
prepare();local placed=place();local root=ops.registry:resolve(placed.ref);local group=node(root,'node1');local originalName=group.Name
group.Name='Human rename';rejects('CONFLICT',function() keep() end);assert(#service.uploads==0);group.Name=originalName
local added
fixture.partHook=function() if not added then added=Instance.new('Attachment');added.Parent=group end end
local result=keep();assert(result.state=='uploaded' and result.converted==nil and #service.uploads==2 and result.meshes[1].assetId==9001)
assert(added.Parent==group and not added._destroyed)
`));

test('converted detached cleanup failure is unsafe and permanently fences later commands',options,t=>run(t,String.raw`
prepare();fixture.partHook=function() allowed=false;fixture.failDestroy=true end
local failure=rejects('CLEANUP',place);assert(failure.unsafe==true and ops.assetCleanupFailed==true)
allowed=true;fixture.failDestroy=false;fixture.partHook=nil
rejects('STATE',function() ops:materializeReconstruction(expected.digest,guard) end)
rejects('CLEANUP',function() ops:stageAssetPacket({expected=expected,packet='{}',target=target,continuity=continuity},guard) end)
`));

for(const collision of [false,true])for(const accepted of [true,false])test(`actual converted placement counts its outer Model (${collision?'hull':'none'}, ${accepted?'128 geometry instances':'129 refused'})`,options,t=>run(t,`
local selectedCount=${(collision?126:127)+(accepted?0:1)}
local originalRows=table.clone(nodeRows)
while #nodeRows<selectedCount do
 local key='node'..tostring(100+#nodeRows)
 nodeRows[#nodeRows+1]={nodeKey=key,localMatrix=matrix(CFrame.new()),name='Boundary EMPTY '..key}
end
-- Independently enumerate this fixture's roots and its two known subtrees in
-- bytewise sibling order; real command arrays/nulls still traverse V.decode.
local roots={originalRows[1],originalRows[6]}
for index=8,#nodeRows do roots[#roots+1]=nodeRows[index] end
table.sort(roots,function(x,y) return x.nodeKey<y.nodeKey end)
table.clear(nodes)
local function row(value)
 local id=V.NULL;for _,mesh in ipairs(source.graph.meshes) do if mesh.nodeKey==value.nodeKey then id=mesh.sourceObjectId end end
 nodes[#nodes+1]={nodeKey=value.nodeKey,parentKey=value.parentKey or V.NULL,sourceObjectId=id}
end
for _,root in ipairs(roots) do
 row(root)
 if root.nodeKey=='node0' then for index=2,5 do row(originalRows[index]) end
 elseif root.nodeKey=='node4' then row(originalRows[7]) end
end
reconstruct.nodeCount=#nodes
assert(#nodes==selectedCount)
${accepted?`prepare();local receipt=place();local root=ops.registry:resolve(receipt.ref)
local allocated=1 -- actual detached/placed outer Model
for _,item in ipairs(root:GetDescendants()) do if item:IsA('Model') or item:IsA('MeshPart') then allocated+=1 end end
assert(allocated==128 and #receipt.converted.nodes==selectedCount)
assert(#service.parts==${collision?3:2})`:`local before=#fixture.created
rejects('BODY_LIMIT',prepare)
assert(#service.parts==0 and #fixture.created==before,'No outer Model, group or MeshPart allocated')`}
`,collision));
