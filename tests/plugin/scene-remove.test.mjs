import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const runtime=process.env.ARCANE_LUAU_BIN;
async function run(t,body){
 const dir=await mkdtemp(path.join(tmpdir(),'arcane-remove-'));
 t.after(async()=>{assert.ok(path.basename(dir).startsWith('arcane-remove-'));await rm(dir,{recursive:true,force:true});});
 let source=await readFile('plugin/fixtures/MockEngine.luau','utf8');
 for(const name of ['Validation','Registry','Properties','Operations'])source+='\nlocal '+name+'=(function()\n'+(await readFile('plugin/src/'+name+'.luau','utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'$1')+'\nend)()\n';
 source+=String.raw`
function methods:GetDescendants()
 local result={};local function visit(node) for _,child in ipairs(node:GetChildren()) do result[#result+1]=child;visit(child) end end;visit(self);return result
end
function methods:FindFirstChildOfClass(name) for _,child in ipairs(self:GetChildren()) do if child:IsA(name) then return child end end;return nil end
fixture.recordings=0
local history=game:GetService('ChangeHistoryService');local originalBegin=history.TryBeginRecording
history.TryBeginRecording=function(...) fixture.recordings+=1;return originalBegin(...) end
fixture.encode=function(data) return Validation.encode(data,http) end
task.wait=function() end
local workspace=game:GetService('Workspace')
local terrain=Instance.new('Terrain');terrain.Parent=workspace
local clears=0;terrain.Clear=function() clears+=1 end
local camera=Instance.new('Camera');camera.Parent=workspace;workspace.CurrentCamera=camera
local ops=Operations.new({sessionId='remove-session',allowedRoots={'Workspace','ServerStorage'}},game,http)
local function node(name,parent) local n=Instance.new('Model');n.Name=name;n.Parent=parent;return n end
local function guard() end
local function remove(args) return ops:execute({id='remove-command',method='scene.remove',args=args},guard) end
local function rejects(fn,code) local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e)) end
`+body;
 const file=path.join(dir,'remove.luau');await writeFile(file,source);const r=spawnSync(runtime,[file],{encoding:'utf8',timeout:30000,windowsHide:true});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
}
const options={skip:!runtime&&'Standalone Luau runtime not configured.'};
test('delete exact existing subtree through one recording, without requiring Arcane ownership',options,t=>run(t,String.raw`
local old=node('Existing',workspace);node('Child',old)
local result=remove({mode='refs',refs={ops.registry:ref(old)}})
assert(old.Parent==nil and result.removed==1 and result.descendants==2 and result.undo=='studio' and not result.terrainCleared)
assert(result.mutation.kind=='scene.remove' and #result.ref.pathSegments==0 and fixture.recordings==1 and fixture.committed==1 and clears==0)
`));
test('workspace reset removes scene children and clears terrain while preserving engine state',options,t=>run(t,String.raw`
node('Scene',workspace);node('Baseplate',workspace)
local result=remove({mode='workspace'})
assert(result.removed==2 and result.terrainCleared and clears==1 and camera.Parent==workspace and terrain.Parent==workspace)
assert(#workspace:GetChildren()==2 and fixture.committed==1)
`));
test('roots, camera, Terrain, duplicate/overlapping targets and connection witnesses refuse before mutation',options,t=>run(t,String.raw`
local model=node('Existing',workspace);local child=node('Child',model)
for _,target in ipairs({workspace,camera,terrain}) do rejects(function() remove({mode='refs',refs={ops.registry:ref(target)}}) end,'PROTECTED') end
rejects(function() remove({mode='refs',refs={ops.registry:ref(model),ops.registry:ref(model)}}) end,'INPUT')
rejects(function() remove({mode='refs',refs={ops.registry:ref(model),ops.registry:ref(child)}}) end,'INPUT')
local witness=Instance.new('Folder');witness.Name='ArcaneTestProof_fixture';witness.Parent=model
rejects(function() remove({mode='workspace'}) end,'PROTECTED')
assert(model.Parent==workspace and child.Parent==model and clears==0 and fixture.recordings==0)
`));
test('non-Workspace grants delete scoped targets without resolving Workspace',options,t=>run(t,String.raw`
local scoped=Operations.new({sessionId='storage-session',allowedRoots={'ServerStorage'}},game,http)
local target=node('Existing',game:GetService('ServerStorage'))
local result=scoped:execute({id='storage-remove',method='scene.remove',args={mode='refs',refs={scoped.registry:ref(target)}}},guard)
assert(target.Parent==nil and result.ref.root=='ServerStorage' and clears==0)
`));
test('moving a target before recording refuses without deleting it',options,t=>run(t,String.raw`
local target=node('Existing',workspace);local ref=ops.registry:ref(target)
fixture.historyHook=function() target.Parent=game:GetService('ServerStorage') end
rejects(function() remove({mode='refs',refs={ref}}) end,'CONFLICT')
assert(target.Parent~=nil and not target._destroyed and clears==0 and fixture.committed==0)
`));
test('partial engine failure remains unsafe and never claims successful deletion',options,t=>run(t,String.raw`
local first=node('First',workspace);local second=node('Second',workspace)
local destroy=methods.Destroy
methods.Destroy=function(self) if self==second then error('injected destruction failure') end;return destroy(self) end
local ok,e=pcall(function() remove({mode='refs',refs={ops.registry:ref(first),ops.registry:ref(second)}}) end)
assert(not ok and e.code=='PARTIAL' and e.unsafe==true and first.Parent==nil and second.Parent==workspace and clears==0)
`));
