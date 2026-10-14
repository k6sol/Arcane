import test from 'node:test';
import {run, options} from './helpers/asset-transfer-fixture.mjs';

test('actual sender packets reconstruct each declared object only after exact seal',options,async t=>run(t,`
local r=receiver()
feed(r)
assert(r:status().state=='sealed' and r:status().engineVerification=='pending' and creates==0)
local objects=r:reconstruct(service)
assert(#objects==8 and creates==8 and destroyed==0 and r:status().state=='taken')
for _,o in ipairs(objects) do assert(o.mesh.vertexCount==4 and o.mesh.triangleCount==4 and o.mesh.engineVerification=='pending') end
rejects(function() r:reconstruct(service) end,'STATE')
r:cancel(); assert(destroyed==0,'caller-owned resources must survive receiver cancellation')
`));
test('out-of-order/repeated packets cancel without allocation or blind replay',options,async t=>run(t,`
local r=receiver()
rejects(function() r:accept(packets[2]) end,'IDENTITY')
assert(r:status().state=='cancelled' and creates==0)
r=receiver();r:accept(packets[1]);rejects(function() r:accept(packets[1]) end,'IDENTITY')
rejects(function() r:accept(packets[2]) end,'STATE')
`));
test('missing chunks refuse seal and incomplete transfers cannot reconstruct',options,async t=>run(t,`
local r=receiver();r:accept(packets[1])
rejects(function() r:reconstruct(service) end,'STATE')
rejects(function() r:accept(packets[#packets]) end,'IDENTITY')
assert(creates==0)
`));
test('JSON callback aliases cannot alter admitted object declarations',options,async t=>run(t,`
local r=receiver()
for _,p in ipairs(packets) do
 r:accept(p)
 if decoded[p].kind=='object' then decoded[p].primitives[1].vertexCount=999 end
end
local objects=r:reconstruct(service);assert(#objects==8 and creates==8)
for _,o in ipairs(objects) do assert(o.mesh.vertexCount==4) end
`));
test('scope retirement during packet decoding cancels before resource creation',options,async t=>run(t,`
local r=AssetTransfer.new(expected,function(s) allowed=false;return decode(s) end,guard,yieldBatch)
rejects(function() r:accept(packets[1]) end,'CANCELLED')
assert(creates==0 and r:status().state=='cancelled')
`));
test('changed chunk data is rejected against its declaration before allocation',options,async t=>run(t,`
local r=receiver()
local attacked=false
for _,p in ipairs(packets) do
 if decoded[p].kind=='chunk' then
  local data=decoded[p].data
  decoded[p].data=(if string.sub(data,1,4)=='AAAA' then 'AQAA' else 'AAAA')..string.sub(data,5)
  rejects(function() r:accept(p) end,'CHECKSUM')
  attacked=true;break
 end
 r:accept(p)
end
assert(attacked and creates==0 and r:status().state=='cancelled')
`));
test('changed revision and declared chunk coverage cannot enter receiving state',options,async t=>run(t,`
local original=decoded[packets[1]].manifestDigest
decoded[packets[1]].manifestDigest=string.rep('0',64)
local r=receiver();rejects(function() r:accept(packets[1]) end,'IDENTITY');assert(creates==0)
decoded[packets[1]].manifestDigest=original
r=receiver();r:accept(packets[1])
local declaration=decoded[packets[2]].primitives[1].attributes.POSITION
declaration.chunks[1].offset=1
rejects(function() r:accept(packets[2]) end,'CHECKSUM');assert(creates==0)
`));
test('failed reconstruction destroys only meshes allocated by this receiver',options,async t=>run(t,`
local r=receiver();feed(r)
local allocate=service.CreateEditableMesh
function service:CreateEditableMesh()
 local mesh=allocate(self)
 if creates==2 then allowed=false end
 return mesh
end
rejects(function() r:reconstruct(service) end,'CANCELLED')
assert(creates==2 and destroyed==2 and r:status().state=='cancelled')
`));
test('cleanup failure is explicit and is never presented as verified rollback',options,async t=>run(t,`
local r=receiver();feed(r)
local allocate=service.CreateEditableMesh
function service:CreateEditableMesh()
 local mesh=allocate(self)
 if creates==1 then function mesh:Destroy() error('owned resource destruction failed') end end
 if creates==2 then allowed=false end
 return mesh
end
rejects(function() r:reconstruct(service) end,'CLEANUP')
assert(r:status().state=='cancelled' and r:status().engineVerification=='pending')
assert(resources[1].destroyed==0 and resources[2].destroyed==1)
`));
