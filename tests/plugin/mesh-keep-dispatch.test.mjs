import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const runtime=process.env.ARCANE_LUAU_BIN;
const names=['Validation','Registry','Properties','Sha256Stream','AssetMesh','AssetTransfer','AssetUpload','AssetPlacement','TerrainGen','AssetMaterials','Operations'];

// Isolated dispatcher boundary: real operation ownership and real engine binding, with a receiver and upload sink double.
// AssetPlacement/AssetUpload behavior has separate VM coverage. This test never invokes a native upload service.
test('mesh keep dispatch binds the uploader module to the retained reconstruction', {skip:!runtime}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-mesh-dispatch-'));
  try{
    const engine=await readFile(join(root,'plugin/fixtures/MockEngine.luau'),'utf8');
    const sources=await Promise.all(names.map(name=>readFile(join(root,'plugin/src',name+'.luau'),'utf8')));
    const loader=`
local factories, modules = {}, {}
local script: any = {Parent = {}}
local function require(reference: any): any
  local name = reference.Name
  if modules[name] == nil then modules[name] = factories[name]() end
  return modules[name]
end
`+names.map((name,index)=>`script.Parent.${name} = {Name = "${name}"}\nfactories.${name} = function()\n${sources[index]}\nend\n`).join('');
    const checks=`
local V = require(script.Parent.Validation)
local AssetUpload = require(script.Parent.AssetUpload)
local placement = table.clone(require(script.Parent.AssetPlacement))
local bind = placement.keepEngine
local calls = 0
placement.keepSupported = function(): boolean return true end
placement.keepEngine = function(ops: any, uploader: any): any
  assert(uploader == AssetUpload and type(uploader.new) == "function", "keep handler must bind its imported uploader")
  return bind(ops, uploader)
end
placement.keep = function(_ops: any, owner: any, _digest: string, _args: any, guard: any, binding: any): any
  guard()
  assert(owner.finished and owner.keeping and binding.AssetUpload == AssetUpload)
  calls += 1
  return {state = "dispatch-checked"}
end
modules.AssetPlacement = placement
local Operations = require(script.Parent.Operations)
local ops = Operations.new({sessionId = "dispatch-session", allowedRoots = {"Workspace"}}, game, http)
local digest = string.rep("a", 64)
local identity = {digest = digest, payloadDigest = string.rep("b",64), manifestDigest = string.rep("c",64)}
local target, continuity = {}, {}
local source = {sourceObjectId = "mesh-one", meshExportSha256 = string.rep("d",64), vertexCount = 3, triangleCount = 1}
local mesh = {Destroy = function() end}
ops.assetTargetGuard = function(): any return function() end end
ops.assetTransfers[digest] = {expected = identity, target = target, continuity = continuity, receiver = {
  status = function(): any return {state = "sealed", packetCount = 1, byteLength = 10} end,
  reconstructionPlan = function(): any return {source} end,
  reconstruct = function(): any return {{mesh = {editableMesh = mesh, vertexCount = 3, triangleCount = 1}, object = source}} end,
}}
ops:reconstructAsset({runId = "11111111-2222-4333-8444-555555555555", expected = identity, target = target,
  continuity = continuity, packetCount = 1, byteLength = 10, objects = V.array({source})}, function() end)
local result = ops:keepReconstruction({source = "editable-" .. digest}, function() end)
assert(result.state == "dispatch-checked" and calls == 1)
ops:cancelAssetTransfers()
print("Mesh keep dispatcher binding passed")
`;
    const path=join(directory,'dispatch.luau');await writeFile(path,engine+loader+checks);
    const result=spawnSync(runtime,[path],{encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:1048576});
    assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/Mesh keep dispatcher binding passed/);
  }finally{
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('arcane-mesh-dispatch-'));
    await rm(directory,{recursive:true,force:true});
  }
});
