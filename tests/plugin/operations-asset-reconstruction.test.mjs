import test from 'node:test';
import {run,options} from './helpers/asset-transfer-fixture.mjs';

// Actual sender packets + production Operations/receiver/mesh code in offline
// Luau. Only engine services are doubles; no Studio, provider or upload calls.
const setup=`
local requested={}
local gameModel={GetService=function(_,name) requested[#requested+1]=name;if name=='AssetService' then return service end;return {} end}
local http={JSONDecode=function(_,s) return decode(s) end,JSONEncode=function(_,v) return if type(v)=='string' then string.format('%q',v) else tostring(v) end}
local ops=Operations.new({sessionId='synthetic-session',allowedRoots={'Workspace'}},gameModel,http)
local target=decode(packets[1]).target
local continuity={clientLifetimeId='fixture-life',pluginArtifactHash=string.rep('a',64),playEpoch=0}
local creatorId=123
function ops:importContext(_)
 return {sessionId=target.sessionId,parentRef={instanceId=target.parentRef},placeId=0,universeId=0,mode='Edit',
 creator={status='unavailable',id=0},studioUser={status='available',id=creatorId}}
end
local function stage()
 for _,p in ipairs(packets) do ops:stageAssetPacket({expected=expected,packet=p,target=target,continuity=continuity},guard) end
end
local function args()
 local status=ops.assetTransfers[expected.digest].receiver:status()
 return {runId='11111111-1111-4111-8111-111111111111',expected=expected,packetCount=status.packetCount,byteLength=status.byteLength,
  target=target,continuity=continuity,objects=table.clone(ops.assetTransfers[expected.digest].receiver:reconstructionPlan())}
end
`;
test('production queue operation reconstructs actual sealed bytes once and privately owns every mesh',options,t=>run(t,setup+`
stage();assert(creates==0)
local input=args();local result=ops:execute({method='asset.reconstruct',args=input},guard)
assert(result.state=='reconstructed' and result.imported==false and result.engineVerification=='pending')
assert(result.runId==input.runId and #result.objects==8 and creates==8 and destroyed==0)
assert(ops.reconstructed==nil and ops.meshes==nil,'engine references remain private')
for _,source in ipairs(result.objects) do assert(source.vertexCount==4 and source.triangleCount==4 and source.editableMesh==nil) end
rejects(function() ops:reconstructAsset(input,guard) end,'STATE');assert(creates==8)
ops:cancelAssetTransfers();assert(destroyed==8 and next(ops.assetTransfers)==nil)
ops:cancelAssetTransfers();assert(destroyed==8,'successful cleanup must not destroy twice')
`,true));
test('incomplete transfer and absent original ownership cannot allocate by supplying hashes',options,t=>run(t,setup+`
ops:stageAssetPacket({expected=expected,packet=packets[1],target=target,continuity=continuity},guard)
local input={runId='11111111-1111-4111-8111-111111111111',expected=expected,packetCount=1,byteLength=#packets[1],target=target,continuity=continuity,objects={}}
rejects(function() ops:reconstructAsset(input,guard) end,'STATE');assert(creates==0)
ops:cancelAssetTransfers();rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');assert(creates==0)
`,true));
test('changed source, counts, target and Edit continuity refuse before service resolution',options,t=>run(t,setup+`
stage();local input=args();local original=input.objects[1]
input.objects[1]=table.clone(original);input.objects[1].meshExportSha256=string.rep('b',64)
rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');input.objects[1]=original
input.packetCount+=1;rejects(function() ops:reconstructAsset(input,guard) end,'STATE');input.packetCount-=1
input.continuity=table.clone(continuity);input.continuity.playEpoch=1
rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');input.continuity=continuity
creatorId=124;rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE')
assert(creates==0);for _,name in ipairs(requested) do assert(name~='AssetService') end
ops:cancelAssetTransfers()
`,true));
test('scope loss at actual allocation releases every allocated resource and cannot replay the receiver',options,t=>run(t,setup+`
stage();local input=args();local allocate=service.CreateEditableMesh
function service:CreateEditableMesh() local mesh=allocate(self);if creates==2 then allowed=false end;return mesh end
rejects(function() ops:reconstructAsset(input,guard) end,'CANCELLED')
assert(creates==2 and destroyed==2 and next(ops.assetTransfers)==nil)
allowed=true;rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');assert(creates==2)
`,true));
test('denied initial authenticated progress prevents any service lookup or allocation for a small mesh',options,t=>run(t,setup+`
stage();local input=args();local calls=0
ops.assetProgress=function() calls+=1;error({code='SCOPE',message='stale exact-command progress acknowledgement'}) end
rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE')
assert(calls==1 and creates==0 and destroyed==0 and next(ops.assetTransfers)==nil)
for _,name in ipairs(requested) do assert(name~='AssetService') end
`,true));
test('late retirement after ownership transfer releases returned meshes before returning any success',options,t=>run(t,setup+`
stage();local input=args();local receiver=ops.assetTransfers[expected.digest].receiver
local function lateGuard() guard();if receiver:status().state=='taken' then error({code='LATE',message='retired after ownership transfer'}) end end
rejects(function() ops:reconstructAsset(input,lateGuard) end,'LATE')
assert(creates==8 and destroyed==8)
ops:cancelAssetTransfers();assert(destroyed==8)
`,true));
test('cancellation reentered from an engine allocation fences late ownership and releases each mesh once',options,t=>run(t,setup+`
stage();local input=args();local allocate=service.CreateEditableMesh
function service:CreateEditableMesh()
 local mesh=allocate(self);if creates==2 then ops:cancelAssetTransfers() end;return mesh
end
rejects(function() ops:reconstructAsset(input,guard) end,'CANCELLED')
assert(creates==2 and destroyed==2 and next(ops.assetTransfers)==nil)
for _,mesh in ipairs(resources) do assert(mesh.destroyed==1) end
ops:cancelAssetTransfers();assert(destroyed==2)
`,true));
test('failed destruction inside AssetMesh propagates an unsafe permanent fence to the production owner',options,t=>run(t,setup+`
stage();local input=args();local allocate=service.CreateEditableMesh
function service:CreateEditableMesh()
 local mesh=allocate(self)
 if creates==2 then mesh.Destroy=function() error('fixture unproven destruction') end;allowed=false end
 return mesh
end
local ok,e=pcall(function() ops:reconstructAsset(input,guard) end)
assert(not ok and e.code=='CLEANUP' and e.unsafe==true and ops.assetCleanupFailed==true)
assert(creates==2 and destroyed==1);allowed=true
rejects(function() ops:reconstructAsset(input,guard) end,'CLEANUP');assert(creates==2)
`,true));
test('Play epoch retirement destroys private reconstructed resources and retains no false current status',options,t=>run(t,setup+`
stage();local input=args();ops:reconstructAsset(input,guard)
ops:retireAssetContinuity({sessionId=target.sessionId,mode='Edit',connected=true,continuitySupported=true,
 clientLifetimeId=continuity.clientLifetimeId,pluginArtifactHash=continuity.pluginArtifactHash,playEpoch=0,placeId=target.placeId,universeId=target.universeId})
assert(destroyed==0)
ops:retireAssetContinuity({sessionId=target.sessionId,mode='Play',playEpoch=1})
assert(destroyed==8 and next(ops.assetTransfers)==nil)
rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');assert(creates==8)
`,true));
for(const field of ['placeId','universeId'])test('changed observed '+field+' retires detached resources even before another engine command',options,t=>run(t,setup+`
stage();local input=args();ops:reconstructAsset(input,guard)
local proof={sessionId=target.sessionId,mode='Edit',connected=true,continuitySupported=true,
 clientLifetimeId=continuity.clientLifetimeId,pluginArtifactHash=continuity.pluginArtifactHash,playEpoch=0,placeId=target.placeId,universeId=target.universeId}
proof.${field}+=1;ops:retireAssetContinuity(proof)
assert(destroyed==8 and next(ops.assetTransfers)==nil)
rejects(function() ops:reconstructAsset(input,guard) end,'SCOPE');assert(creates==8)
`,true));
test('cleanup failure is unsafe, attempts every owned mesh once and permanently fences this owner',options,t=>run(t,setup+`
stage();local input=args();ops:reconstructAsset(input,guard)
resources[1].Destroy=function() error('fixture failure') end
local ok,e=pcall(function() ops:cancelAssetTransfers() end)
assert(not ok and e.code=='CLEANUP' and e.unsafe==true and e.recovery.partial==true)
assert(destroyed==7 and ops.assetCleanupFailed==true)
local ok2,e2=pcall(function() ops:cancelAssetTransfers() end);assert(not ok2 and e2.code=='CLEANUP' and destroyed==7)
rejects(function() ops:reconstructAsset(input,guard) end,'CLEANUP');assert(creates==8)
`,true));
test('successful reconstruction releases its staging slot while retaining mesh ownership and continuity retirement',options,t=>run(t,setup+`
stage();local input=args();ops:reconstructAsset(input,guard)
assert(ops.assetTransfers[expected.digest]==nil,'reconstructed transfer no longer holds a staging slot')
rejects(function() ops:reconstructAsset(input,guard) end,'STATE');assert(creates==8 and destroyed==0)
rejects(function() ops:stageAssetPacket({expected=expected,packet=packets[1],target=target,continuity=continuity},guard) end,'STATE');assert(next(ops.assetTransfers)==nil)
-- One other unrelated staging transfer plus a new one must still fit the two-transfer bound.
local other={receiver={cancel=function() end,status=function() return {state='receiving'} end}}
ops.assetTransfers[string.rep('d',64)]=other
local ok,e=pcall(function() return ops:receiveAssetPacket({digest=string.rep('c',64),payloadDigest=expected.payloadDigest,manifestDigest=expected.manifestDigest},packets[1],guard) end)
assert(ok or (type(e)=='table' and e.code~='BUSY'),'released slot admits a new transfer: '..tostring(type(e)=='table' and e.code or e))
rejects(function() ops:receiveAssetPacket({digest=string.rep('e',64),payloadDigest=expected.payloadDigest,manifestDigest=expected.manifestDigest},packets[1],guard) end,'BUSY')
ops.assetTransfers[string.rep('d',64)]=nil;ops.assetTransfers[string.rep('c',64)].receiver:cancel();ops.assetTransfers[string.rep('c',64)]=nil
-- Edit continuity retirement still reaches the detached reconstructed meshes.
ops:retireAssetContinuity({sessionId=target.sessionId,mode='Play',playEpoch=1})
assert(destroyed==8)
`,true));
const meshParts=`
local made,images,surfaces,instances={},{},{},{}
local imageCreates,surfaceCreates,imageDestroyed,surfaceDestroyed=0,0,0,0
local env=getfenv(Operations.materializeReconstruction)
local function inst(class)
 local t={ClassName=class};instances[#instances+1]=t
 local meta={__index=function(self,key) if key=='Parent' then return rawget(self,'_parent') end return nil end,
  __newindex=function(self,key,value) if key=='Parent' then rawset(self,'_parent',value);if class=='SurfaceAppearance' and value then value.appearance=self end else rawset(self,key,value) end end}
 setmetatable(t,meta)
 function t:IsA(c) return c==class end
 function t:Destroy()
  if self.destroyed then return end;self.destroyed=true
  if class=='SurfaceAppearance' then surfaceDestroyed+=1 end
  for _,child in ipairs(instances) do if child.Parent==self then child:Destroy() end end
  self.Parent=nil
 end
 function t:Clone() local clone=inst(class);for k,v in pairs(self) do if k~='_parent' and k~='destroyed' and type(v)~='function' then clone[k]=v end end;return clone end
 return t
end
getfenv(Operations.materializeReconstruction).Instance={new=function(c) return inst(c) end}
env.Content={fromObject=function(o) return {object=o} end}
env.Enum={CollisionFidelity={Hull='Hull',Box='Box'},RenderFidelity={Precise='Precise'},Material={SmoothPlastic='SmoothPlastic',Wood='Wood',Grass='Grass',Slate='Slate',Marble='Marble'}}
env.Color3={new=function(r,g,b) return {r,g,b} end}
env.Vector2={new=function(x,y) return {X=x,Y=y} end}
env.CFrame={new=function(...) assert(select('#',...)==12,'all rotation components required');return {...} end}
function service:CreateMeshPartAsync(content,options) local p=inst('MeshPart');p.content=content;p.options=options;made[#made+1]=p;return p end
function service:CreateEditableImage(options)
 imageCreates+=1;if self.imageNilAt==imageCreates then return nil end
 local image={Size=options.Size};images[#images+1]=image
 function image:WritePixelsBuffer(origin,size,pixels)
  assert(origin.X==0 and origin.Y==0 and size.X==1 and size.Y==1 and buffer.len(pixels)==4)
  self.bytes={buffer.readu8(pixels,0),buffer.readu8(pixels,1),buffer.readu8(pixels,2),buffer.readu8(pixels,3)}
 end
 function image:Destroy() if not self.destroyed then self.destroyed=true;imageDestroyed+=1 end end
 return image
end
function service:CreateSurfaceAppearanceAsync(maps)
 surfaceCreates+=1;local surface=inst('SurfaceAppearance');surface.maps=maps;surfaces[#surfaces+1]=surface
 if self.onSurface then self.onSurface(surface) end
 return surface
end
`;
test('retained reconstruction becomes MeshParts once, from the exact owned meshes, with no upload',options,t=>run(t,setup+meshParts+`
stage();local input=args()
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'WATCH')
ops:reconstructAsset(input,guard);local lookups=#requested
local model,confirm=ops:materializeReconstruction(expected.digest,guard)
assert(#made==8 and model.ClassName=='Model' and model.Name=='ArcaneProcedural' and #requested==lookups,'no second service acquisition')
for index,p in ipairs(made) do
 assert(p.content.object==resources[index] and resources[index].destroyed==0,'MeshPart references the owned EditableMesh')
 assert(p.Parent==model and type(p.Size)=='table' and p.Size[2]>0 and type(p.CFrame)=='table')
 if p.Transparency==1 then assert(p.CanCollide==true and p.options.CollisionFidelity=='Hull') else assert(p.CanCollide==false and p.options.CollisionFidelity=='Box') end
end
confirm();model.Parent={}
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'STATE')
model.Parent=nil;local again=ops:materializeReconstruction(expected.digest,guard);assert(#made==16 and again~=model,'restored placement may be placed again')
rejects(function() ops:materializeReconstruction(string.rep('f',64),guard) end,'WATCH')
creatorId=124;rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'SCOPE');creatorId=123
ops:retireAssetContinuity({sessionId=target.sessionId,mode='Play',playEpoch=1})
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'WATCH');assert(#made==16)
`,true));
test('sealed nondefault units determine every placed size and transformed centre',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard);ops:materializeReconstruction(expected.digest,guard)
local originals={};for _,json in ipairs(packets) do local p=decode(json);if p.kind=='object' then originals[#originals+1]=p.object end end
assert(decode(packets[1]).conversion.studsPerMeter==2)
assert(#made==#originals)
for index,part in ipairs(made) do
 local object=originals[index];local m=object.exportTransform;local b=object.bounds
 local c={(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2,(b.min[3]+b.max[3])/2}
 for axis=1,3 do
  local at=(axis-1)*4
  local scale=math.sqrt(m[at+1]^2+m[at+2]^2+m[at+3]^2)
  assert(math.abs(part.Size[axis]-math.max(0.05,(b.max[axis]-b.min[axis])*scale*2))<1e-8)
  local centre=(m[axis]*c[1]+m[axis+4]*c[2]+m[axis+8]*c[3]+m[axis+12])*2
  assert(math.abs(part.CFrame[axis]-centre)<1e-8)
  for row=1,3 do assert(math.abs(part.CFrame[3+(row-1)*3+axis]-m[at+row]/scale)<1e-8) end
 end
 assert(#part.CFrame==12 and part.content.object==resources[index])
end
ops:cancelAssetTransfers();assert(destroyed==8)
`,true,{studsPerMeter:2}));

test('planar sizing keeps source geometry exact and separates physical padding from rotated bounds',options,t=>run(t,`
local q=math.sqrt(0.5)
local object={role='render',bounds={min={0,0,0},max={2,1,0}},
 worldBounds={min={3-3*q,5,7},max={3+4*q,5+4*q,7}},
 scale={2,3,4},exportTransform={2*q,2*q,0,0,-3*q,3*q,0,0,0,0,4,0,3,5,7,1}}
local conversion={sourceUnits='meters',sourceUp='Z',exportUnits='meters',exportUp='Y',targetUnits='studs',targetUp='Y',studsPerMeter=2}
local plan=AssetTransfer.meshPartPlan(object,conversion)
assert(table.isfrozen(plan) and table.isfrozen(plan.size) and table.isfrozen(plan.cframe) and table.isfrozen(plan.physicalPaddingStuds))
assert(math.abs(plan.size[1]-8)<1e-9 and math.abs(plan.size[2]-6)<1e-9 and plan.size[3]==0.05)
assert(plan.physicalPaddingStuds[1]==0 and plan.physicalPaddingStuds[2]==0 and plan.physicalPaddingStuds[3]==0.05)
assert(math.abs(plan.cframe[1]-(6+q))<1e-9 and math.abs(plan.cframe[2]-(10+7*q))<1e-9 and plan.cframe[3]==14)
local rotation={q,-q,0,q,q,0,0,0,1}
for i=1,9 do assert(math.abs(plan.cframe[i+3]-rotation[i])<1e-9) end
-- The asymmetric triangle's actual world AABB centre differs from the transformed local AABB centre.
assert(math.abs(plan.cframe[2]-(object.worldBounds.min[2]+object.worldBounds.max[2]))>1)
assert(object.bounds.max[3]==0 and object.exportTransform[1]==2*q and creates==0)
local bad=table.clone(conversion);bad.studsPerMeter=0
rejects(function() AssetTransfer.meshPartPlan(object,bad) end,'INPUT')
bad=table.clone(conversion);bad.exportUp='Z'
rejects(function() AssetTransfer.meshPartPlan(object,bad) end,'INPUT')
local collider=table.clone(object);collider.role='collision'
rejects(function() AssetTransfer.meshPartPlan(collider,conversion) end,'INPUT')
local shear=table.clone(object);shear.exportTransform=table.clone(object.exportTransform);shear.exportTransform[5]+=0.5
rejects(function() AssetTransfer.meshPartPlan(shear,conversion) end,'UNSUPPORTED_TRANSFORM')
local reflected=table.clone(object);reflected.exportTransform=table.clone(object.exportTransform)
for i=1,3 do reflected.exportTransform[i]=-reflected.exportTransform[i] end
rejects(function() AssetTransfer.meshPartPlan(reflected,conversion) end,'UNSUPPORTED_TRANSFORM')
assert(creates==0 and destroyed==0)
`));

test('engine failure while materializing releases the partial model and allows a later attempt',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard)
local create=service.CreateMeshPartAsync
function service:CreateMeshPartAsync(content,options) if #made==3 then error({code='ENGINE',message='fixture refusal'}) end return create(self,content,options) end
local ok,e=pcall(function() return ops:materializeReconstruction(expected.digest,guard) end)
assert(not ok and e.code=='ENGINE' and #made==3)
service.CreateMeshPartAsync=create
local model=ops:materializeReconstruction(expected.digest,guard);assert(model and #made==11)
`,true));

test('authored scalar PBR reaches placed render meshes; collision gets no surface; repeat placement shares bounded image resources',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard)
local model=ops:materializeReconstruction(expected.digest,guard)
local expectedMaterials={};local unique={};local renderCount=0
for _,json in ipairs(packets) do local p=decode(json);if p.kind=='object' and p.object.role~='collision' then
 expectedMaterials[p.object.name]=p.material or {baseColor={1,1,1,1},metallic=1,roughness=1,doubleSided=false};unique[if p.material then p.material.sha256 else 'default']=true;renderCount+=1
end end
local uniqueCount=0;for _ in pairs(unique) do uniqueCount+=1 end
assert(imageCreates==uniqueCount*2 and surfaceCreates==uniqueCount)
for _,part in ipairs(made) do
 if part.Transparency==1 then assert(part.appearance==nil)
 else
  local source=expectedMaterials[part.Name];local appearance=part.appearance
  assert(source and appearance and appearance.Parent==part and part.Material=='SmoothPlastic')
  assert(part.DoubleSided==source.doubleSided and part.Transparency==0 and appearance.EmissiveStrength==0)
  for i=1,3 do local v=source.baseColor[i];local expected=if v<=0.0031308 then v*12.92 else 1.055*v^(1/2.4)-0.055;assert(math.abs(part.Color[i]-expected)<1e-9) end
  local m=appearance.maps.MetalnessMap.object;local r=appearance.maps.RoughnessMap.object
  assert(m.bytes[1]==math.floor(source.metallic*255+0.5) and r.bytes[1]==math.floor(source.roughness*255+0.5))
  assert(m.bytes[4]==255 and r.bytes[4]==255 and m~=r)
 end
end
local again=ops:materializeReconstruction(expected.digest,guard)
assert(again~=model and imageCreates==uniqueCount*2 and surfaceCreates==uniqueCount,'restored retries do not accumulate GPU maps')
ops:cancelAssetTransfers();assert(destroyed==8 and imageDestroyed==uniqueCount*2)
for _,surface in ipairs(surfaces) do assert(surface.destroyed) end
ops:cancelAssetTransfers();assert(imageDestroyed==uniqueCount*2)
`,true));

test('PBR image budget refusal leaves no placed model, retains source meshes and allows a later attempt',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard);service.imageNilAt=2
local ok,e=pcall(function() ops:materializeReconstruction(expected.digest,guard) end)
assert(not ok and e.code=='MEMORY' and imageDestroyed==1 and destroyed==0)
for _,p in ipairs(made) do assert(p.destroyed and p.Parent==nil) end
service.imageNilAt=nil;local model=ops:materializeReconstruction(expected.digest,guard);assert(model and destroyed==0)
ops:cancelAssetTransfers();assert(destroyed==8)
`,true));

test('retirement while the surface factory yields releases both material and mesh resources',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard)
service.onSurface=function() ops:cancelAssetTransfers() end
local ok,e=pcall(function() ops:materializeReconstruction(expected.digest,guard) end)
assert(not ok and e.code=='CANCELLED' and destroyed==8 and imageDestroyed==2)
assert(surfaces[1].destroyed)
for _,p in ipairs(made) do assert(p.destroyed and p.Parent==nil) end
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'WATCH')
`,true));

test('model allocation refusal releases the materializing latch and permits a safe retry',options,t=>run(t,setup+meshParts+`
stage();ops:reconstructAsset(args(),guard)
local allocate=env.Instance.new
local refused=false
env.Instance.new=function(class) if class=='Model' and not refused then refused=true;error({code='ENGINE',message='injected allocation refusal'}) end;return allocate(class) end
rejects(function() ops:materializeReconstruction(expected.digest,guard) end,'ENGINE')
assert(#made==0 and imageCreates==0 and destroyed==0)
local model=ops:materializeReconstruction(expected.digest,guard);assert(model and #made==8)
ops:cancelAssetTransfers();assert(destroyed==8)
`,true));
