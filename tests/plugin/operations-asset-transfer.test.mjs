import test from 'node:test';
import {run, options} from './helpers/asset-transfer-fixture.mjs';

const setup = `
local requested={}
local gameModel={GetService=function(_,name) requested[#requested+1]=name;return {} end}
local http={JSONDecode=function(_,s) return decode(s) end}
local function operations() return Operations.new({sessionId='synthetic-session',allowedRoots={'Workspace'}},gameModel,http) end
`;
test('production Operations owns a sealed internal transfer without allocating or exposing a public command', options, async t=>run(t,setup+`
local ops=operations()
for _,p in ipairs(packets) do local result=ops:receiveAssetPacket(expected,p,guard);assert(result.engineVerification=='pending') end
assert(ops.assetTransfers[expected.digest].receiver:status().state=='sealed' and creates==0)
ops:cancelAssetTransfers();assert(next(ops.assetTransfers)==nil and creates==0)
for _,name in ipairs(requested) do assert(name~='AssetService','staging must not resolve an engine allocation service') end
`,true));
test('production Operations refuses changed identity without overwriting its owned receiver', options, async t=>run(t,setup+`
local ops=operations();ops:receiveAssetPacket(expected,packets[1],guard)
local altered={digest=expected.digest,payloadDigest=string.rep('0',64),manifestDigest=expected.manifestDigest}
rejects(function() ops:receiveAssetPacket(altered,packets[2],guard) end,'SCOPE')
assert(ops.assetTransfers[expected.digest].receiver:status().packetCount==1 and creates==0)
ops:cancelAssetTransfers()
`,true));
test('production Operations clears a late-retired transfer rather than returning a success', options, async t=>run(t,setup+`
local ops=operations();local calls=0
local function lateGuard() calls+=1;if calls==5 then error({code='CANCELLED',message='late retirement'}) end end
rejects(function() ops:receiveAssetPacket(expected,packets[1],lateGuard) end,'CANCELLED')
assert(next(ops.assetTransfers)==nil and creates==0)
`,true));
test('production Operations bounds retained transfers and rejects replay before another allocation', options, async t=>run(t,setup+`
local ops=operations()
ops.assetTransfers['one']={receiver={cancel=function() end}}
ops.assetTransfers['two']={receiver={cancel=function() end}}
rejects(function() ops:receiveAssetPacket(expected,packets[1],guard) end,'BUSY')
assert(creates==0);ops:cancelAssetTransfers();assert(next(ops.assetTransfers)==nil)
ops:receiveAssetPacket(expected,packets[1],guard)
rejects(function() ops:receiveAssetPacket(expected,packets[1],guard) end,'IDENTITY')
assert(next(ops.assetTransfers)==nil and creates==0)
`,true));

const stageSetup = setup+`
local ops=operations()
local target=decode(packets[1]).target
local creatorId=123
function ops:importContext(_)
 return {sessionId=target.sessionId,root='Workspace',parentRef={instanceId=target.parentRef},placeId=0,universeId=0,mode='Edit',
 creator={status='unavailable',id=0},studioUser={status='available',id=creatorId}}
end
local function args(packet) return {expected=expected,packet=packet,target=target,continuity={}} end
`;
test('typed Operations packet intake returns exact cumulative pending receipts with no engine allocations', options, async t=>run(t,stageSetup+`
local total=0
for index,packet in ipairs(packets) do
 total+=#packet
 local result=ops:stageAssetPacket(args(packet),guard)
 assert(result.transferDigest==expected.digest and result.packetCount==index and result.byteLength==total)
 assert(result.engineVerification=='pending' and result.state==(if index==#packets then 'sealed' else 'receiving'))
end
assert(creates==0);ops:cancelAssetTransfers();assert(next(ops.assetTransfers)==nil)
`,true));
test('typed Operations refuses a changed observed creator before consuming another packet', options, async t=>run(t,stageSetup+`
ops:stageAssetPacket(args(packets[1]),guard);creatorId=124
rejects(function() ops:stageAssetPacket(args(packets[2]),guard) end,'SCOPE')
assert(ops.assetTransfers[expected.digest].receiver:status().packetCount==1 and creates==0)
ops:cancelAssetTransfers()
`,true));
test('typed Operations rejects a first packet targeting a different Workspace before retaining buffers', options, async t=>run(t,stageSetup+`
local input=args(packets[1]);input.target=table.clone(target);input.target.parentRef='different-parent'
rejects(function() ops:stageAssetPacket(input,guard) end,'SCOPE')
assert(next(ops.assetTransfers)==nil and creates==0)
`,true));

test('uploader observation reads the current Studio account independently of published group ownership', options, async t=>run(t,stageSetup+`
function gameModel:GetService(name)
 assert(name=='StudioService');return {GetUserId=function() return 987 end}
end
function ops:importContext(_)
 return {sessionId='synthetic-session',root='Workspace',parentRef={instanceId='synthetic-parent'},placeId=12,universeId=34,mode='Edit',
 creator={status='available',kind='group',id=56},studioUser={status='not_applicable'}}
end
local result=ops:uploadContext({})
assert(result.creator.id==56 and result.creator.kind=='group')
assert(result.uploader.status=='available' and result.uploader.id==987 and result.uploader.provenance=='StudioService:GetUserId')
assert(result.studioUser.status=='not_applicable' and result.uploadAllowed==nil and creates==0)
`,true));
test('uploader change during context observation refuses the receipt rather than substituting place ownership', options, async t=>run(t,stageSetup+`
local calls=0
function gameModel:GetService(name)
 assert(name=='StudioService');return {GetUserId=function() calls+=1;return if calls==1 then 987 else 988 end}
end
rejects(function() ops:uploadContext({}) end,'CONTEXT_CHANGED')
assert(creates==0)
`,true));
test('unavailable uploader stays unavailable even when a local place creator can be selected', options, async t=>run(t,stageSetup+`
function gameModel:GetService(name) assert(name=='StudioService');return {GetUserId=function() return 0 end} end
local result=ops:uploadContext({})
assert(result.studioUser.id==123 and result.uploader.status=='unavailable' and creates==0)
`,true));
