import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {join, relative, isAbsolute, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {saveStudioFixture} from '../../../dist/packages/asset-pipeline/testing/studio-import-fixture.js';
import {adaptCompletedStudioImport} from '../../../dist/apps/daemon/src/asset-import-adapter.js';
import {createStudioImportManifestAuthority} from '../../../dist/packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../../dist/packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../../dist/packages/asset-pipeline/src/studio-import-transfer.js';

const runtime = process.env.ARCANE_LUAU_BIN;
export const options = {skip: !runtime && 'Standalone Luau runtime not configured.'};
const root = resolve('.'), JOB = '11111111-1111-4111-8111-111111111111';
const sha = data => createHash('sha256').update(data).digest('hex');
const literal = value => {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return '"' + [...Buffer.from(value)].map(b => '\\' + String(b).padStart(3, '0')).join('') + '"';
  if (Array.isArray(value)) return '{' + value.map(literal).join(',') + '}';
  return '{' + Object.entries(value).map(([k,v]) => '[' + literal(k) + ']=' + literal(v)).join(',') + '}';
};
export async function run(t, body, operations = false) {
  const boundary = tmpdir(), directory = await mkdtemp(join(boundary, 'arcane-transfer-vm-'));
  t.after(async () => {const r=relative(boundary,directory);assert.ok(r.startsWith('arcane-transfer-vm-')&&!isAbsolute(r)&&!r.includes('..'));await rm(directory,{recursive:true,force:true});});
  const manifest = await saveStudioFixture(directory, JOB);
  const exports = new Map();
  for (const path of ['asset.glb','collision.glb']) exports.set(path,await readFile(join(directory,path)));
  const generated=adaptCompletedStudioImport(manifest,exports,sha('project'),{target:{sessionId:'synthetic-session',placeId:0,universeId:0,root:'Workspace',parentRef:'synthetic-parent',creator:{kind:'user',id:'123'}},placement:{mode:'origin'},studsPerMeter:1/0.28},null);
  const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>generated});
  t.after(()=>authority.close());
  const prepared=authority.prepare(await authority.admit(JOB));
  const payload=decodeStudioImportPayload(prepared,new Map(generated.files.map(f=>[f.fileId,f.bytes])));
  const transfer=createStudioImportTransfer(prepared,payload);
  let source='local __mods: any = setmetatable({}, {__index = function(_, name) error("Unloaded fixture module: " .. tostring(name)) end})\n';
  for (const name of (operations ? ['Validation','Properties','Registry','Sha256Stream','AssetMesh','AssetTransfer','AssetUpload','AssetPlacement','TerrainGen','Operations'] : ['Sha256Stream','AssetMesh','AssetTransfer'])) {
    const text=(await readFile(join(root,'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'__mods.$1');
    source+='__mods.'+name+'=(function()\n'+text+'\nend)()\n';
  }
  source+=`local Vector3 = {new=function(x,y,z) return {x,y,z} end}
local Vector2 = {new=function(x,y) return {x,y} end}
-- Module functions resolve these globals, not services or real Roblox objects.
getfenv(__mods.AssetMesh.create).Vector3=Vector3
getfenv(__mods.AssetMesh.create).Vector2=Vector2
local AssetTransfer=__mods.AssetTransfer
local packets=${literal(transfer.packets.map(p=>p.json))}
local decoded={}
`;
  for (const p of transfer.packets) source+='decoded['+literal(p.json)+']='+literal(JSON.parse(p.json))+'\n';
  source+=`local expected=${literal({payloadDigest:transfer.payloadDigest,manifestDigest:prepared.manifest.digest,digest:transfer.digest})}
local creates, destroyed, nextId = 0, 0, 0
local resources = {}
local service={}
function service:CreateEditableMesh()
 creates+=1
 local mesh={vertices={},faces={},normals={},uvs={},destroyed=0}
 function mesh:AddVertex(v) nextId+=11; self.vertices[nextId]=v; return nextId end
 function mesh:AddNormal(v) nextId+=11; self.normals[nextId]=v; return nextId end
 function mesh:AddUV(v) nextId+=11; self.uvs[nextId]=v; return nextId end
 function mesh:AddTriangle(a,b,c) nextId+=11; self.faces[nextId]={a,b,c}; return nextId end
 function mesh:SetFaceNormals(_,_) end
 function mesh:SetFaceUVs(_,_) end
 function mesh:Destroy() self.destroyed+=1; destroyed+=1 end
 resources[#resources+1]=mesh
 return mesh
end
local allowed=true
local function guard() if not allowed then error('scope revoked') end end
local function yieldBatch() end
local function decode(s) assert(decoded[s], 'unknown fixture JSON'); return decoded[s] end
local function receiver() return AssetTransfer.new(expected,decode,guard,yieldBatch) end
local function feed(r) for _,p in ipairs(packets) do r:accept(p) end end
local function rejects(fn,code)
 local ok,e=pcall(fn); assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e))
end
`+body;
  if (operations) source=source.replace('local AssetTransfer=__mods.AssetTransfer', 'local AssetTransfer=__mods.AssetTransfer\nlocal Operations=__mods.Operations\nlocal task={wait=function() end}\ngetfenv(Operations.receiveAssetPacket).task=task');
  const file=join(directory,'receiver.luau');await writeFile(file,source);
  const result=spawnSync(runtime,[file],{encoding:'utf8',timeout:120000,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
}
