import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {PLUGIN_SOURCES,renderPlugin} from '../../scripts/build-plugin.mjs';
import {buildConvertedGraph} from '../../dist/packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../dist/packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../dist/packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../dist/packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority} from '../../dist/packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../dist/packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,measureStudioImportTransferArguments} from '../../dist/packages/asset-pipeline/src/studio-import-transfer.js';
const runtime=process.env.ARCANE_LUAU_BIN;
const options={skip:!runtime&&'Configure the existing standalone Luau VM; no tools or Studio are installed.'};
// Only the fixed constructed GLB factory is transcribed from C129. Assertions
// below cover actual Main/Transport/Validation/Operations bridge behavior, not
// duplicated mesh/carrier/materialization checks. Engine/HTTP are doubles.
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222';
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const json=(value)=>Buffer.from(JSON.stringify(value));
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function pack(doc,bin) {
  doc.buffers[0].byteLength=bin.length;const text=json(doc),j=(text.length+3)&~3,b=(bin.length+3)&~3,out=Buffer.alloc(28+j+b);
  out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(j,12);out.writeUInt32LE(0x4e4f534a,16);
  out.fill(32,20,20+j);text.copy(out,20);out.writeUInt32LE(b,20+j);out.writeUInt32LE(0x004e4942,24+j);bin.copy(out,28+j);return out;
}
function geometry(positions,faces){
  const p=Buffer.alloc(positions.length*12),i=Buffer.alloc(faces.length*2);
  positions.flat().forEach((v,at)=>p.writeFloatLE(v,at*4));faces.forEach((v,at)=>i.writeUInt16LE(v,at*2));
  return{doc:{asset:{version:'2.0'},buffers:[{byteLength:0}],bufferViews:[{buffer:0,byteOffset:0,byteLength:p.length},{buffer:0,byteOffset:p.length,byteLength:i.length}],
    accessors:[{bufferView:0,componentType:5126,count:positions.length,type:'VEC3',min:[0,1,2].map(a=>Math.min(...positions.map(v=>v[a]))),max:[0,1,2].map(a=>Math.max(...positions.map(v=>v[a])))},
      {bufferView:1,componentType:5123,count:faces.length,type:'SCALAR'}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],nodes:[{mesh:0}],scene:0,scenes:[{nodes:[0]}]},bin:Buffer.concat([p,i])};
}
function fixture(collision=false,affine='rigid',edit){
  const original=geometry([[3,1,0],[5,1,0],[5,2,0],[3,1,0],[5,2,0],[3,2,0]],[0,1,2,3,4,5]);
  const matrix=identity();if(affine==='scale'){matrix[0]=2;matrix[5]=3;}if(affine==='shear')matrix[4]=.25;if(affine==='reflection')matrix[0]=-1;
  original.doc.nodes=[{name:'Root',children:[1,3],translation:[2,3,4]},{name:'Empty ancestor',children:[2],matrix},{name:'Off-centre mesh',mesh:0},
    {name:'Empty leaf',translation:[0,2**-80,0]},{name:'Second root',mesh:0,translation:[-4,0,1]}];original.doc.scenes=[{nodes:[0,4]}];
  original.doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[.2,.4,.6,1],metallicFactor:.3,roughnessFactor:.7}}];original.doc.meshes[0].primitives[0].material=0;
  const add=(rows,type)=>{
    const raw=Buffer.alloc(rows.flat().length*4);rows.flat().forEach((n,i)=>raw.writeFloatLE(n,i*4));
    const offset=(original.bin.length+3)&~3,view=original.doc.bufferViews.length,index=original.doc.accessors.length;
    original.bin=Buffer.concat([original.bin,Buffer.alloc(offset-original.bin.length),raw]);
    original.doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:raw.length});
    original.doc.accessors.push({bufferView:view,componentType:5126,count:rows.length,type});return index;
  };
  original.doc.meshes[0].primitives[0].attributes.NORMAL=add(Array.from({length:6},()=>[0,0,1]),'VEC3');
  original.doc.meshes[0].primitives[0].attributes.TEXCOORD_0=add([[0,0],[1,0],[1,1],[.25,0],[1,1],[0,1]],'VEC2');
  Object.assign(original.doc.materials[0],{doubleSided:true,alphaMode:'MASK',alphaCutoff:.5});edit?.(original.doc,add);
  const source=pack(original.doc,original.bin),prepared=prepareGlbConversionSource(source,sha(source));
  const map={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,sourceSha256:sha(source),importSha256:prepared.importSha256,
    sourceSceneIndex:prepared.sourceSceneIndex,declaredSceneCount:prepared.declaredSceneCount,parts:prepared.parts,nodes:prepared.nodes};
  const request={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'converted-glb',jobId:JOB,parentJobId:PARENT,parentManifestSha256:sha('synthetic parent metadata'),
    name:'graph-model',sourceSha256:sha(source),sourceBytes:source.length,importSha256:prepared.importSha256,importBytes:prepared.importBytes.length,sourceMapSha256:'',
    collision:collision?'convex-hull':'none',renderResolution:128,renderSamples:8};
  const j=prepared.importBytes.readUInt32LE(12),output=JSON.parse(prepared.importBytes.subarray(20,20+j).toString('utf8')),
    outputBin=Buffer.from(prepared.importBytes.subarray(28+j));output.asset.generator='Synthetic graph buffer fixture; no native proof';
  for(const part of prepared.parts)Object.assign(output.nodes[part.importNodeIndex].extras,{arcane_identity_scheme:'arcane-converted-v2',
    arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),arcane_source_key:part.sourceKey,arcane_role:'render',arcane_pivot:[0,0,0],arcane_collision_for:'[]'});
  // Reorder every export node. Audit indexes must refer to actual marker matches,
  // while source-map import indexes deliberately remain the original ones.
  const count=output.nodes.length;output.nodes.reverse();
  for(const n of output.nodes)if(n.children)n.children=n.children.map((at)=>count-1-at);
  for(const scene of output.scenes)scene.nodes=scene.nodes.map((at)=>count-1-at);
  const measured=prepared.parts.map(part=>({sourceKey:part.sourceKey,originMarker:part.originMarker,sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),
    vertices:6,triangles:2,boundaryEdges:6,nonManifoldEdges:6,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:0,finitePositions:true,
    geometrySha256:sha('synthetic measured geometry'),correspondenceSha256:conversionCorrespondenceSha256([[0,1,2],[3,4,5]]),materialSha256:sha('synthetic measured material')}));
  const audit={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:PARENT,parentManifestSha256:request.parentManifestSha256,
    requestSha256:'',sourceSha256:request.sourceSha256,importSha256:request.importSha256,sourceMapSha256:'',identityScheme:'arcane-converted-v2',assetId:convertedGlbAssetId(request.sourceSha256),
    blenderVersion:'synthetic metadata',collision:request.collision,importedParts:measured,reopenedParts:structuredClone(measured),models:[],
    renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:128,height:128,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:.4,standardDeviation:.1})),
    savedSceneReopened:true,errors:[],warnings:['open-render-surfaces','delivery-support-pending',...(collision?[]:['no-collision-proxy'])]};
  const byKey=(key)=>output.nodes.find((n)=>n.extras?.[CONVERSION_NODE_KEY]===key);
  function collisionGlb(open=false) {
    const {doc,bin}=geometry([[0,0,0],[2,0,0],[0,2,0],[0,0,2]],open?[0,2,1,0,1,3,0,3,2]:[0,2,1,0,1,3,0,3,2,1,2,3]);
    doc.asset.generator=output.asset.generator;doc.nodes[0].extras={arcane_identity_scheme:'arcane-converted-v2',arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'collision','proxy'),
      arcane_source_key:'proxy',arcane_role:'collision',arcane_pivot:[0,0,0],arcane_collision_for:JSON.stringify(prepared.parts.map(p=>convertedGlbObjectId(request.sourceSha256,'render',p.sourceKey)).sort())};
    return pack(doc,bin);
  }
  let collisionBytes=collision?collisionGlb():undefined;
  function bytes() {
    const sourceMapBytes=json(map);request.sourceMapSha256=sha(sourceMapBytes);const requestBytes=json(request),renderBytes=pack(output,outputBin);
    Object.assign(audit,{requestSha256:sha(requestBytes),sourceMapSha256:request.sourceMapSha256,sourceSha256:request.sourceSha256,importSha256:request.importSha256});
    audit.models=[{path:'asset.glb',sha256:sha(renderBytes),byteLength:renderBytes.length,generator:output.asset.generator,anchors:[],objects:prepared.parts.map(part=>({
      sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),sourceKey:part.sourceKey,nodeIndex:output.nodes.indexOf(byKey(part.sourceKey)),role:'render',
      pivot:[0,0,0],collisionFor:[],originMarker:part.originMarker}))}];
    if(collisionBytes)audit.models.push({path:'collision.glb',sha256:sha(collisionBytes),byteLength:collisionBytes.length,generator:output.asset.generator,anchors:[],objects:[{
      sourceObjectId:convertedGlbObjectId(request.sourceSha256,'collision','proxy'),sourceKey:'proxy',nodeIndex:0,role:'collision',pivot:[0,0,0],originMarker:null,
      collisionFor:prepared.parts.map(p=>convertedGlbObjectId(request.sourceSha256,'render',p.sourceKey)).sort()}]});
    return{requestBytes,sourceMapBytes,auditBytes:json(audit),sourceBytes:source,importBytes:prepared.importBytes,renderBytes,...(collisionBytes?{collisionBytes}:{})};
  }
  return{map,request,audit,output,outputBin,prepared,byKey,bytes,collisionGlb,setCollision(value){collisionBytes=value;}};
}
const selection={target:{sessionId:'studio-session',placeId:0,universeId:0,root:'Workspace',parentRef:'selected-parent',creator:{kind:'user',id:'123'}},placement:{mode:'origin'},studsPerMeter:2};
function hostFixture(collision=false,affine='rigid',edit){
  const f=fixture(collision,affine,edit);
  function host(revision=JOB) {
    f.request.jobId=revision;f.audit.jobId=revision;const bytes=f.bytes(),graph=buildConvertedGraph(bytes),request=parseConvertedGlbRequest(JSON.parse(bytes.requestBytes.toString('utf8')));
    const fileId=(path)=>path==='asset.glb'?'asset-glb':'collision-glb';
    return{schemaVersion:2,origin:'converted-glb',identityScheme:'arcane-converted-v2',projectId:sha('project'),assetId:convertedGlbAssetId(request.sourceSha256),revisionId:revision,
      sourceSha256:request.sourceSha256,producer:{blenderVersion:f.audit.blenderVersion,exporterVersion:f.output.asset.generator},...structuredClone(selection),conversionRequest:request,graph,
      files:f.audit.models.map((m)=>{const data=m.path==='asset.glb'?bytes.renderBytes:bytes.collisionBytes;return{fileId:fileId(m.path),contentType:'model/gltf-binary',sha256:sha(data),bytes:data};}),
      models:f.audit.models.map((m)=>({fileId:fileId(m.path),resources:[],objects:m.objects.map((o)=>({sourceObjectId:o.sourceObjectId,sourceKey:o.sourceKey,nodeIndex:o.nodeIndex,role:o.role,pivot:o.pivot,collisionFor:o.collisionFor}))})),anchors:[],baseline:null};
  }return{...f,host};
}
async function prepare(input){const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>input});try{return authority.prepare(await authority.admit(input.revisionId));}finally{authority.close();}}
async function converted(input){const result=await prepare(input);assert.equal(result.manifest.schemaVersion,2);return result;}

const literal=value=>{
  if(value===null||value===undefined)return 'nil';
  if(typeof value==='number'||typeof value==='boolean')return String(value);
  if(typeof value==='string')return '"'+[...Buffer.from(value)].map(b=>'\\'+String(b).padStart(3,'0')).join('')+'"';
  if(Array.isArray(value))return '{'+value.map(literal).join(',')+'}';
  return '{'+Object.entries(value).map(([k,v])=>'['+literal(k)+']='+literal(v)).join(',')+'}';
};

async function run(t,checks,{collision=false}={}){
  const boundary=resolve(tmpdir()),directory=await mkdtemp(join(boundary,'arcane-converted-bridge-vm-'));
  t.after(async()=>{assert.equal(dirname(resolve(directory)),boundary);assert.ok(basename(directory).startsWith('arcane-converted-bridge-vm-'));await rm(directory,{recursive:true,force:true});});
  const sources=await Promise.all(PLUGIN_SOURCES.map(async([,,filename])=>({filename,source:await readFile(join(resolve('.'),'plugin/src',filename),'utf8')})));
  const rendered=renderPlugin(sources),continuity={clientLifetimeId:'bridge-lifetime',pluginArtifactHash:rendered.manifest.runtimeIdentity.sha256,playEpoch:0};
  const f=hostFixture(collision),input=f.host(),prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(f=>[f.fileId,f.bytes])));
  const transfer=createStudioImportTransfer(prepared,payload),measured=measureStudioImportTransferArguments(transfer,input.target,continuity);
  assert.ok(measured.byteLengths.every(n=>n<=256*1024));
  const graph=prepared.manifest.graph,byKey=new Map(graph.nodes.map(n=>[n.nodeKey,n])),ordered=[];
  const visit=parent=>{for(const n of [...byKey.values()].filter(n=>n.parentKey===parent).sort((a,b)=>a.nodeKey<b.nodeKey?-1:a.nodeKey>b.nodeKey?1:0)){ordered.push(n);visit(n.nodeKey);}};visit(null);
  const reconstruct={formatVersion:2,graphDigest:graph.digest,nodeCount:graph.nodes.length,nodes:ordered.map(n=>({nodeKey:n.nodeKey,parentKey:n.parentKey,sourceObjectId:graph.meshes.find(m=>m.nodeKey===n.nodeKey)?.sourceObjectId??null})),
    runId:JOB,expected:{digest:transfer.digest,payloadDigest:transfer.payloadDigest,manifestDigest:prepared.manifest.digest},packetCount:transfer.packets.length,byteLength:transfer.byteLength,
    objects:payload.objects.map(e=>({sourceObjectId:e.object.sourceObjectId,meshExportSha256:e.object.meshExportSha256,vertexCount:e.primitives.reduce((n,p)=>n+p.vertexCount,0),triangleCount:e.primitives.reduce((n,p)=>n+p.triangleCount,0)})),target:input.target,continuity};
  const [engine,gui]=await Promise.all([readFile(join(resolve('.'),'plugin/fixtures/MockEngine.luau'),'utf8'),readFile(join(resolve('.'),'plugin/fixtures/MockPlugin.luau'),'utf8')]);
  const capture=`
local V=__arcaneRequire('Validation')
local transportClass=__arcaneRequire('Transport')
local originalNew=transportClass.new
transportClass.new=function(...: any): any local client=originalNew(...);fixture.bridgeClient=client;return client end
`;
  const bundle=rendered.lua.replace('-- BEGIN Main.server.luau\n',capture+'\n-- BEGIN Main.server.luau\n');assert.notEqual(bundle,rendered.lua);
  let source=engine+'\n'+gui.replace('id == "ArcaneLocalBridgeFloatingV2"','id == "ArcaneLocalBridgeFloatingV4"')+`
local Vector2={new=function(x: number,y: number): any return {X=x,Y=y} end}
Enum.CreatorType={User='User',Group='Group'}
game.CreatorType=Enum.CreatorType.User;game.CreatorId=123
local guid=0
function http:GenerateGUID(_braces: boolean): string guid+=1;return if guid==1 then 'bridge-lifetime' else 'selected-parent' end
`+bundle+`
assert(fixture.bridgeClient and #fixture.workers==1,'actual Main creates one actual transport')
local client=fixture.bridgeClient
local nativeScalarDecode=http.JSONDecode
local packetValues={}
`;
  for(const p of transfer.packets)source+='packetValues['+literal(p.json)+']='+literal(JSON.parse(p.json))+'\n';
  source+=`
-- Real HttpService produces ordinary packet tables, while Transport's real
-- V.decode preserves ARRAY/null markers in outer commands. Keep them distinct.
function http:JSONDecode(text: string): any
 if string.sub(text,1,1)=='"' then return nativeScalarDecode(self,text) end
 assert(packetValues[text],'only exact original native packet JSON is configured')
 return packetValues[text]
end
fixture.encode=function(value: any): string return V.encode(value,http) end
local staged=${literal(measured.arguments.map(x=>JSON.stringify(x)))}
local reconstructJson=${literal(JSON.stringify(reconstruct))}
local continuity=${literal(continuity)}
local queued,posted,executions={}, {}, 0
local nextCommand=0
local creates,destroyed=0,0
local resources={}
local assetService={}
function assetService:CreateEditableMesh()
 creates+=1
 -- Stateful synthetic EditableMesh: inventories/readbacks preserve allocated
 -- IDs, actual geometry and face-corner associations. Default per-vertex UVs
 -- are (0,0), colors white/alpha1; geometric normals are computed from faces.
 -- This double supplies no native acceptance or rendering evidence.
 local mesh={next=0,vertices={},faces={},normals={},uvs={},colors={},alphas={},faceNormals={},faceUVs={},faceColors={},defaults={},destroyed=false}
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
 function mesh:Destroy(): () assert(not self.destroyed,'resource must be released once');self.destroyed=true;destroyed+=1 end
 resources[#resources+1]=mesh
 return mesh
end
services.AssetService=assetService
local epoch=0
fixture.httpHook=function(request: any): any
 if string.find(request.Url,'/connect',1,true) then
  return response({sessionId='studio-session',token='synthetic-bridge-token',protocolVersion=1,allowedRoots=V.array({'Workspace'}),allowWrites=true})
 elseif string.find(request.Url,'/poll',1,true) then
  local body=V.decode(request.Body,http)
  if body.executingCommand then
   return response({commands=V.array({}),progress={commandId=body.executingCommand.commandId,leaseEpoch=body.executingCommand.leaseEpoch,
    observedAt='2099-01-01T00:00:00.000Z',expiresAt='2099-01-01T00:00:06.000Z'}})
  end
  return response({commands=V.array(if #queued>0 then {table.remove(queued,1)} else {})})
 elseif string.find(request.Url,'/result',1,true) then
  local body=V.decode(request.Body,http);posted[#posted+1]=body;return response({accepted=true})
 elseif string.find(request.Url,'/disconnect',1,true) then return response({}) end
 error('unexpected fixed fixture route')
end
client:requestConnect('arcane_local_v1_45871_'..string.rep('a',64));client:cycle()
assert(client.pair and client.operations and client.clientSessionId=='bridge-lifetime')
-- Exact trusted native context witness double, tied to actual Main source hash,
-- connection and controlled Edit epoch. It is not native continuity evidence.
client.testProof={stop=function(): () end,disconnect=function(): () end,snapshot=function(): any return {sessionId=client.pair.sessionId,placeId=game.PlaceId,universeId=game.GameId,
 mode=if fixture.edit then 'Edit' else 'Play',connected=true,continuitySupported=true,clientLifetimeId=client.clientSessionId,
 pluginArtifactHash=continuity.pluginArtifactHash,playEpoch=epoch} end}
local actualExecute=client.operations.execute
client.operations.execute=function(self: any,...: any): any executions+=1;return actualExecute(self,...) end
fixture.now=1000
task.wait=function(): () end
local function command(method: string,args: any): any
 nextCommand+=1
 return {id='command-'..nextCommand,requestId='request-'..nextCommand,protocolVersion=1,sessionId=client.pair.sessionId,
  clientSessionId=client.clientSessionId,method=method,args=args,state='dispatched',allowedRoots=V.array({'Workspace'}),allowWrites=client.pair.allowWrites,
  leaseEpoch=nextCommand,expiresAt='2100-01-01T00:00:00.000Z'}
end
-- Command expiry must remain in the future; renewal observed time is exact now.
DateTime.fromIsoDate=function(value: string): any
 if value=='2099-01-01T00:00:06.000Z' then return {UnixTimestampMillis=7000} end
 if value=='2099-01-01T00:00:00.000Z' then return {UnixTimestampMillis=1000} end
 if value=='2100-01-01T00:00:00.000Z' then return {UnixTimestampMillis=20000} end
 return nil
end
local function deliver(method: string,args: any): any
 local c=command(method,args);queued[#queued+1]=c
 client:cycle();assert(client.pending and client.pending.body.commandId==c.id)
 local entry=client.pending;client:cycle();assert(client.pending==nil and entry.acknowledged)
 return entry,c
end
local function stage(): ()
 for _,json in ipairs(staged) do local entry=deliver('asset.stage_packet',V.decode(json,http));assert(entry.body.state=='succeeded',tostring(entry.body.error)) end
end
local function rejects(callback: any,code: string): () local ok,e=pcall(callback);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e)) end
`+checks;
  const path=join(directory,'bridge.luau');await writeFile(path,source);
  const result=spawnSync(runtime,[path],{encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:1024*1024});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.doesNotMatch(result.stdout+result.stderr,/synthetic-bridge-token|arcane_local_v1_/);
}

for(const collision of [false,true])test('actual Main bridge carries converted '+(collision?'hull':'none')+' staged JSON and logical reconstruction receipt once',options,async t=>run(t,`
stage();assert(creates==0)
local args=V.decode(reconstructJson,http)
assert(getmetatable(args.nodes)~=nil and V.equal(args.nodes,V.array(table.clone(args.nodes))),'actual outer ARRAY markers survive the bridge without fixture repair')
-- Use a direct dispatched command through the actual Main-wrapped transport;
-- controlled renewal uses the same guarded one-command progress callback.
local entry,c=deliver('asset.reconstruct',args)
assert(entry.body.state=='succeeded',tostring(entry.body.error))
local result=entry.body.result
assert(result.formatVersion==2 and result.graphDigest==args.graphDigest and result.nodeCount==args.nodeCount)
assert(V.equal(result.nodes,args.nodes) and #result.objects==${collision?3:2} and creates==${collision?3:2})
assert(result.imported==false and result.engineVerification=='pending')
local before=executions;client:dispatch(V.decode(V.encode(c,http),http));assert(executions==before and client.pending==entry)
client:cycle();assert(executions==before)
local last=posted[#posted];assert(last.commandId==c.id and last.sessionId=='studio-session' and V.equal(last.result.nodes,args.nodes))
epoch=1;client:cycle();assert(destroyed==creates)
client:stop();assert(destroyed==creates)
`,{collision}));
test('actual Main bridge recognizes existing keep method but refuses absent local ownership without upload authority',options,async t=>run(t,`
local entry,c=deliver('asset.keep_mesh',{source='editable-'..string.rep('f',64),continuity=continuity})
assert(entry.body.state=='failed' and string.sub(entry.body.error,1,6)=='STATE:')
assert(creates==0 and posted[#posted].commandId==c.id)
client.pair.allowWrites=false
local refused=deliver('asset.keep_mesh',{source='editable-'..string.rep('f',64),continuity=continuity})
assert(refused.body.state=='failed' and string.sub(refused.body.error,1,6)=='GRANT:')
assert(creates==0)
`));
test('actual Main bridge rejects changed Edit epoch and complete escaped argument overflow before native work',options,async t=>run(t,`
stage();epoch=1
local entry=deliver('asset.reconstruct',V.decode(reconstructJson,http))
assert(entry.body.state=='failed' and string.sub(entry.body.error,1,6)=='SCOPE:' and creates==0)
local huge=command('asset.stage_packet',{packet=string.rep('\\\\',140000),expected={},target={},continuity=continuity})
assert(#huge.args.packet<256*1024 and #V.encode(huge.args,http)>256*1024)
rejects(function() client:dispatch(huge) end,'BODY_LIMIT');assert(creates==0)
client:stop();assert(destroyed==0)
`));
test('actual Main bridge rejects foreign sessions and reused command identity before another operation',options,async t=>run(t,`
local args=V.decode(staged[1],http)
local foreign=command('asset.stage_packet',args);foreign.sessionId='another-session'
rejects(function() client:dispatch(foreign) end,'SESSION');assert(executions==0 and creates==0)
local entry,c=deliver('asset.stage_packet',args);assert(entry.body.state=='succeeded')
local changed=V.decode(V.encode(c,http),http);changed.requestId='another-request'
local before=executions;rejects(function() client:dispatch(changed) end,'RECONCILE')
assert(executions==before and creates==0);client:stop()
`));
