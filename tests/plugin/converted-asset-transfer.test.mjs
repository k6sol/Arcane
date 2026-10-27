import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {buildConvertedGraph} from '../../dist/packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../dist/packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../dist/packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../dist/packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority} from '../../dist/packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../dist/packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../dist/packages/asset-pipeline/src/studio-import-transfer.js';
import {options} from './helpers/asset-transfer-fixture.mjs';
// Actual compiled host encoder -> original raw packets -> actual standalone
// Luau modules. GLBs/audit/runtime metadata are constructed, never native proof.
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
function resealed(transfer,change){
  const bodies=transfer.packets.map(p=>JSON.parse(p.json));change(bodies);
  const packets=[];let bytes=0;
  for(let i=0;i<bodies.length;i++){
    const body=bodies[i];body.ordinal=i;
    if(body.kind==='seal')Object.assign(body,{precedingPacketCount:i,precedingByteLength:bytes,contentDigest:sha(packets.map(p=>[p.ordinal,p.kind,p.byteLength,p.sha256].join(':')).join('\n'))});
    const json=JSON.stringify(body),byteLength=Buffer.byteLength(json);packets.push({json,byteLength,sha256:sha(json)});bytes+=byteLength;
  }
  return {...transfer,packets,digest:sha(packets.map(p=>p.sha256).join('\n'))};
}
async function run(t,body,{collision=false,edit,change,originalExpected=false}={}){
  const f=hostFixture(collision,'rigid',edit),input=f.host(),prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(f=>[f.fileId,f.bytes])));
  const original=createStudioImportTransfer(prepared,payload),transfer=change?resealed(original,change):original;
  const boundary=tmpdir(),directory=await mkdtemp(join(boundary,'arcane-converted-transfer-vm-'));
  t.after(async()=>{const r=relative(boundary,directory);assert.ok(r.startsWith('arcane-converted-transfer-vm-')&&!isAbsolute(r)&&!r.includes('..'));await rm(directory,{recursive:true,force:true});});
  let source='local __mods: any = {}\n';
  for(const name of ['Sha256Stream','AssetMesh','AssetTransfer'])source+='__mods.'+name+'=(function()\n'+(await readFile(join(resolve('.'),'plugin/src',name+'.luau'),'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'__mods.$1')+'\nend)()\n';
  source+=`local Vector3={new=function(x,y,z) return {x,y,z} end}
local Vector2={new=function(x,y) return {x,y} end}
getfenv(__mods.AssetMesh.create).Vector3=Vector3
getfenv(__mods.AssetMesh.create).Vector2=Vector2
local AssetTransfer=__mods.AssetTransfer
local packets=${literal(transfer.packets.map(p=>p.json))}
local decoded={}
`;
  for(const packet of transfer.packets)source+='decoded['+literal(packet.json)+']='+literal(JSON.parse(packet.json))+'\n';
  const expected=originalExpected?original:transfer;
  source+=`local expected=${literal({payloadDigest:expected.payloadDigest,manifestDigest:prepared.manifest.digest,digest:expected.digest})}
local expectedGraph=${literal(prepared.manifest.graph)}
local creates,destroyed,nextId=0,0,0
local resources={}
local service={}
function service:CreateEditableMesh()
 creates+=1
 local mesh={vertices={},normals={},uvs={},faces={},destroyed=0}
 function mesh:AddVertex(v) nextId+=7;self.vertices[nextId]=v;return nextId end
 function mesh:AddNormal(v) nextId+=7;self.normals[nextId]=v;return nextId end
 function mesh:AddUV(v) nextId+=7;self.uvs[nextId]=v;return nextId end
 function mesh:AddTriangle(a,b,c) nextId+=7;self.faces[nextId]={a,b,c};return nextId end
 function mesh:SetFaceNormals(_,_) end
 function mesh:SetFaceUVs(_,_) end
 function mesh:Destroy() self.destroyed+=1;destroyed+=1 end
 resources[#resources+1]=mesh
 return mesh
end
local allowed=true
local function guard() if not allowed then error('scope revoked') end end
local function yieldBatch() end
local function decode(s) assert(decoded[s],'unknown fixture JSON');return decoded[s] end
local function receiver() return AssetTransfer.new(expected,decode,guard,yieldBatch) end
local function feed(r) for _,p in ipairs(packets) do r:accept(p) end end
local function rejects(fn,code)
 local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e))
end
local function count(t) local n=0;for _ in pairs(t) do n+=1 end;return n end
`+body;
  const path=join(directory,'converted-receiver.luau');await writeFile(path,source);
  const result=spawnSync(process.env.ARCANE_LUAU_BIN,[path],{encoding:'utf8',timeout:120000,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
}

for(const collision of [false,true])test('converted receiver '+(collision?'hull':'none')+' retains actual graph, EMPTYs, source zero and separate planar physical metadata',options,async t=>{
  await run(t,`local r=receiver();feed(r)
assert(creates==0 and r:status().state=='sealed')
local g=r:graphPlan();assert(g.formatVersion==2 and g.graph.digest==expectedGraph.digest and #g.graph.nodes==7)
local roots,empty=0,0
for _,n in ipairs(g.graph.nodes) do if n.parentKey==nil then roots+=1 end;if n.name=='Empty leaf' then empty+=1;assert(n.localMatrix[14]==2^-80) end end
assert(roots==2 and empty==1 and table.isfrozen(g.graph.nodes[1].localMatrix))
assert(#r:originalPackets()==#packets)
local summaries=r:reconstructionPlan();assert(#summaries==${collision?3:2})
local out=r:reconstruct(service);assert(#out==${collision?3:2} and creates==#out and destroyed==0)
for _,e in ipairs(out) do
 assert(e.formatVersion==2 and e.association.sourceObjectId==e.object.sourceObjectId)
 assert(e.conversion.sourceUp=='Y' and e.conversion.studsPerMeter==2)
 assert(table.isfrozen(e.nativePlan) and e.nativePlan.coordinateSpace=='source-local-Y-up-meters')
 assert(e.nativePlan.carrierCoordinateSpace=='centered-carrier-meters' and e.mesh.coordinateSpace=='centered-carrier-meters')
 assert(table.isfrozen(e.mesh.sourceLocalCentre))
 if e.object.role=='render' then
  assert(e.association.nodeKey==e.object.sourceKey and e.mesh.vertexCount==6)
  assert(count(e.mesh.editableMesh.normals)==6 and count(e.mesh.editableMesh.uvs)==6)
  assert(e.material.doubleSided==true and e.material.alphaMode=='MASK')
  assert(e.nativePlan.exactSourceSizeStuds[3]==0 and e.nativePlan.size[3]==0.05 and e.nativePlan.physicalPaddingStuds[3]==0.05)
  assert(e.nativePlan.localBoundsCentre[1]==4 and e.nativePlan.pivotOffset[1]==-8)
  assert(e.mesh.sourceLocalCentre[1]==4 and e.mesh.sourceLocalCentre[2]==1.5)
  local first=e.mesh.editableMesh.vertices[e.mesh.primitives[1].vertexIds[1]]
  assert(first[1]==-1 and first[2]==-0.5 and first[3]==0)
  assert(first[1]+e.mesh.sourceLocalCentre[1]==3 and first[2]+e.mesh.sourceLocalCentre[2]==1)
  local low,high={math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge}
  for _,v in pairs(e.mesh.editableMesh.vertices) do for a=1,3 do low[a]=math.min(low[a],v[a]);high[a]=math.max(high[a],v[a]) end end
  for a=1,3 do assert(low[a]+high[a]==0) end
  assert(e.nativePlan.cframe[1]+e.nativePlan.pivotOffset[1]==e.nativePlan.sourcePivotCFrame[1])
 end
end
assert(r:status().state=='taken');rejects(function() r:reconstruct(service) end,'STATE')
r:cancel();assert(destroyed==0)
`,{collision});
});
test('converted receiver preserves noncommuting source local/world rotations without flattening',options,async t=>{
  await run(t,`local r=receiver();feed(r);local g=r:graphPlan()
local found=false;for _,n in ipairs(g.graph.nodes) do if n.nodeKey=='node1' then assert(n.localMatrix[7]==1 and n.localMatrix[10]==-1);found=true end end
assert(found);local out=r:reconstruct(service);assert(#out==2)
for _,e in ipairs(out) do assert(e.nativePlan.sourcePivotCFrame[1]==e.object.exportTransform[13]*2) end
`,{edit:doc=>{doc.nodes[0].rotation=[0,0,Math.SQRT1_2,Math.SQRT1_2];doc.nodes[1].matrix=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1];}});
});
test('converted decoder aliases cannot change the sealed graph or resources',options,async t=>{
  await run(t,`local r=receiver();feed(r)
for _,p in pairs(decoded) do if p.kind=='node' then p.node.name='changed';p.node.localMatrix[13]=999 end end
local g=r:graphPlan();for _,n in ipairs(g.graph.nodes) do assert(n.name~='changed' and n.localMatrix[13]~=999) end
assert(#r:reconstruct(service)==2)
`);
});
test('converted changed raw bytes cannot acquire the original expected hash chain',options,async t=>{
  await run(t,`local r=receiver();rejects(function() feed(r) end,'CHECKSUM');assert(creates==0 and r:status().state=='cancelled')`,{change:b=>{b[0].conversionRequest.parentManifestSha256=sha('changed parent');},originalExpected:true});
});
const structural=[
 ['omitted EMPTY',b=>{const at=b.findIndex(p=>p.kind==='node'&&p.node.name==='Empty leaf');b.splice(at,1);b[0].graph.nodeCount--;},'IDENTITY'],
 ['wrong parent',b=>{b.find(p=>p.kind==='node'&&p.node.nodeKey==='node2_primitive0').node.parentKey='node0';},'IDENTITY'],
 ['wrong actual node index',b=>{const objects=b.filter(p=>p.kind==='object');objects[0].object.nodeIndex=objects[1].object.nodeIndex;},'IDENTITY'],
 ['foreign source ID',b=>{b.find(p=>p.kind==='object').object.sourceObjectId='arcane_'+sha('foreign');},'IDENTITY'],
 ['unknown graph field',b=>{b.find(p=>p.kind==='node').node.instanceRef='invented';},'INPUT'],
 ['ID topology',b=>{b.find(p=>p.kind==='object').primitives[0].correspondence.ids[0]=999;},'CHECKSUM'],
 ['unsupported authored ID attribute',b=>{const p=b.find(p=>p.kind==='object').primitives[0];p.attributes._ARCANE_SOURCE_VERTEX_ID=p.attributes.POSITION;},'IDENTITY'],
];
for(const [name,change,code]of structural)test('converted receiver independently refuses '+name+' before allocation',options,async t=>{
  await run(t,`local r=receiver();local ok,e=pcall(function() feed(r);r:reconstruct(service) end)
assert(not ok and type(e)=='table' and e.code=='${code}');assert(creates==0)
`,{change});
});
test('converted stream byte corruption fails before any allocation',options,async t=>{
  await run(t,`local r=receiver();rejects(function() feed(r) end,'CHECKSUM');assert(creates==0)`,{change:b=>{const p=b.find(p=>p.kind==='chunk');p.data='AAAA'+p.data.slice(4);p.sha256=sha(Buffer.from(p.data,'base64'));}});
});
test('converted cancellation before native work and during second owned allocation cleans all actual resources',options,async t=>{
  await run(t,`local r=receiver();feed(r);allowed=false;rejects(function() r:reconstruct(service) end,'CANCELLED');assert(creates==0)
allowed=true;local second=receiver();feed(second)
local original=service.CreateEditableMesh
function service:CreateEditableMesh() local m=original(self);if creates==2 then allowed=false end;return m end
rejects(function() second:reconstruct(service) end,'CANCELLED');assert(creates==2 and destroyed==2)
for _,m in ipairs(resources) do assert(m.destroyed==1) end
`);
});
test('converted cleanup failure remains explicit and cannot claim full rollback',options,async t=>{
  await run(t,`local r=receiver();feed(r)
local original=service.CreateEditableMesh
function service:CreateEditableMesh()
 local m=original(self)
 if creates==1 then function m:Destroy() error('fixture destruction failure') end end
 if creates==2 then allowed=false end
 return m
end
rejects(function() r:reconstruct(service) end,'CLEANUP')
assert(r:status().state=='cancelled' and creates==2 and destroyed==1)
`);
});
test('converted all numeric geometry is checked before the first allocation',options,async t=>{
  await run(t,`local r=receiver();feed(r)
-- The SECOND object's resealed actual index bytes contain degenerate faces.
-- Its refusal must precede allocation for the otherwise valid first object.
rejects(function() r:reconstruct(service) end,'INPUT');assert(creates==0)
`,{change:b=>{
    const object=b.filter(p=>p.kind==='object')[1],descriptor=object.primitives[0].indices;
    const chunk=b.find(p=>p.kind==='chunk'&&p.streamId===descriptor.streamId),bytes=Buffer.from(chunk.data,'base64');bytes.fill(0);
    chunk.data=bytes.toString('base64');chunk.sha256=sha(bytes);chunk.bufferSha256=chunk.sha256;
    descriptor.sha256=chunk.sha256;descriptor.chunks[0].sha256=chunk.sha256;
  }});
});
test('converted graph count cannot allocate beyond the complete instance budget',options,async t=>{
  await run(t,`local r=receiver();rejects(function() feed(r) end,'BUDGET');assert(creates==0)`,{change:b=>{b[0].graph.nodeCount=129;}});
});
test('converted numeric sizing refuses nonzero thin extent instead of stretching it',options,async t=>{
  await run(t,`local r=receiver();feed(r)
local o={role='render',bounds={min={0,0,0},max={1,0.001,0}},worldBounds={min={0,0,0},max={1,0.001,0}},exportTransform={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1},scale={1,1,1}}
rejects(function() AssetTransfer.meshPartPlan(o,r:graphPlan().conversion,2) end,'UNSUPPORTED_TRANSFORM');assert(creates==0)
`);
});

for(const collision of [false,true]){
  const selectedCount=collision?126:127;
  const edit=doc=>{while(doc.nodes.length<selectedCount-2){const at=doc.nodes.length;doc.nodes.push({name:'Budget EMPTY '+at});doc.scenes[0].nodes.push(at);}};
  test(`converted receiver reserves the outer Model at its complete ${collision?'hull':'none'} boundary`,options,async t=>{
    await run(t,`local r=receiver();feed(r)
local graph=r:graphPlan().graph;assert(#graph.nodes==${selectedCount})
assert(1+#graph.nodes+${collision?1:0}==128)
local entries=r:reconstruct(service);assert(#entries==${collision?3:2} and creates==${collision?3:2})
for _,entry in ipairs(entries) do entry.mesh.editableMesh:Destroy() end
`,{collision,edit});
  });
  test(`converted receiver refuses declared ${selectedCount+1} selected nodes plus outer Model${collision?' and derived hull':''} before allocation`,options,async t=>{
    // Reseal the original raw hash chain so this reaches the independent
    // declared-allocation budget, rather than failing an old packet checksum.
    await run(t,`local r=receiver();rejects(function() feed(r) end,'BUDGET');assert(creates==0)`,
      {collision,edit,change:b=>{b[0].graph.nodeCount++;}});
  });
}

