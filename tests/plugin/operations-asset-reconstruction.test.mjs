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
