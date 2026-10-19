import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createStudioImportManifestAuthority, type HostGeneratedStudioImport, type PreparedStudioImport } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import { decodeStudioImportPayload, StudioImportPayloadError, STUDIO_IMPORT_PAYLOAD_LIMITS, type StudioImportPayload, type StudioImportPayloadBuffer } from '../../packages/asset-pipeline/src/studio-import-payload.js';
import { adaptCompletedStudioImport } from '../../apps/daemon/src/asset-import-adapter.js';
import { createStudioImportTransfer } from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import type { AssetManifest } from '../../packages/asset-pipeline/src/types.js';

type Doc = Record<string, any>;
const JOB = '11111111-1111-4111-8111-111111111111';
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const H = sha('owned-source'), R = 'arcane_' + sha('render'), C = 'arcane_' + sha('collision'), A = 'arcane_' + sha('anchor');
const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function canonical(v: any): string {
  if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if (v!==null&&typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
function pack(doc: Doc, bin: Buffer): Buffer {
  const j=Buffer.from(JSON.stringify(doc)), n=Math.ceil(j.length/4)*4, b=Math.ceil(bin.length/4)*4;
  const out=Buffer.alloc(28+n+b); out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(n,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(32,20,20+n);j.copy(out,20);
  out.writeUInt32LE(b,20+n);out.writeUInt32LE(0x004e4942,24+n);bin.copy(out,28+n);return out;
}
function fixture() {
  const doc:Doc={asset:{version:'2.0',generator:'Khronos glTF Blender I/O v4.5.48'},buffers:[{byteLength:0}],bufferViews:[],accessors:[],meshes:[],nodes:[],scene:0,scenes:[{nodes:[0,1]}]};
  let bin:Buffer=Buffer.alloc(0);
  const add=(values:number[],type:string,componentType=5126)=>{
    const size=type==='VEC3'?3:type==='VEC2'?2:1, width=componentType===5126?4:2, raw=Buffer.alloc(values.length*width);
    values.forEach((n,i)=>componentType===5126?raw.writeFloatLE(n,i*width):raw.writeUInt16LE(n,i*width));
    const offset=Math.ceil(bin.length/4)*4, vi=doc.bufferViews.length, ai=doc.accessors.length;
    bin=Buffer.concat([bin,Buffer.alloc(offset-bin.length),raw]);doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:raw.length,target:type==='SCALAR'?34963:34962});
    const a:Doc={bufferView:vi,componentType,type,count:values.length/size};
    if(type==='VEC3'){a.min=[0,1,2].map(c=>Math.min(...values.filter((_,i)=>i%3===c)));a.max=[0,1,2].map(c=>Math.max(...values.filter((_,i)=>i%3===c)));}
    doc.accessors.push(a);return ai;
  };
  const pos=add([0,0,0,1,0,0,0,1,0,0,0,1],'VEC3'), normal=add([1,0,0,1,0,0,1,0,0,1,0,0],'VEC3'), uv=add([0,0,1,0,1,1,0,1],'VEC2'), indices=add([0,2,1,0,1,3,0,3,2,1,2,3],'SCALAR',5123);
  doc.materials=[{name:'owned-PBR',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.2,0.4,0.6,1],metallicFactor:0.3,roughnessFactor:0.7},emissiveFactor:[0.1,0.2,0.3]}];
  const objects:HostGeneratedStudioImport['models'][number]['objects']=[];
  for(const [i,id,role,key] of [[0,R,'render','body'],[1,C,'collision','body-proxy']] as const){
    const collisionFor=role==='render'?[]:[R];
    doc.meshes.push({name:key,primitives:[{attributes:{POSITION:pos,NORMAL:normal,...(role==='render'?{TEXCOORD_0:uv}:{})},indices,...(role==='render'?{material:0}:{})}]});
    doc.nodes.push({mesh:i,name:key,extras:{arcane_identity_scheme:'arcane-semantic-v1',arcane_source_object_id:id,arcane_role:role,arcane_source_key:key,arcane_pivot:[0,0,0],arcane_collision_for:JSON.stringify(collisionFor),retained_semantic:'authored'}});
    objects.push({sourceObjectId:id,nodeIndex:i,role,pivot:[0,0,0],collisionFor});
  }
  doc.nodes[0].children=[2];doc.nodes.push({name:'SOCK_tip',translation:[1,0,0],extras:{arcane_identity_scheme:'arcane-semantic-v1',arcane_source_anchor_id:A,arcane_source_object_id:R,arcane_source_key:'tip',arcane_socket_kind:'socket'}});
  doc.buffers[0].byteLength=bin.length;
  const generated=():HostGeneratedStudioImport=>{const bytes=pack(doc,bin);return {schemaVersion:1,projectId:H,assetId:'arcane_'+H,revisionId:JOB,sourceSha256:H,
    producer:{blenderVersion:'4.5.3 LTS',exporterVersion:'Khronos glTF Blender IO v4.5.48'},target:{sessionId:'offline',placeId:0,universeId:0,root:'Workspace',parentRef:'parent',creator:{kind:'user',id:'1'}},placement:{mode:'origin'},studsPerMeter:3.5,
    files:[{fileId:'export',contentType:'model/gltf-binary',sha256:sha(bytes),bytes}],models:[{fileId:'export',resources:[],objects}],anchors:[{sourceAnchorId:A,sourceObjectId:R,kind:'socket',transform:[...I.slice(0,12),1,0,0,1]}],baseline:null};};
  return {doc,get bin(){return bin;},set bin(v:Buffer){bin=v;doc.buffers[0].byteLength=v.length;},generated};
}
async function prepare(input:HostGeneratedStudioImport):Promise<PreparedStudioImport> {
  const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>input});
  try{return authority.prepare(await authority.admit(input.revisionId));}finally{authority.close();}
}
function seal(p:Doc):PreparedStudioImport {
  const {digest:_digest,...content}=p.manifest;p.manifest.digest=sha(canonical(content));p.delta.nextDigest=p.manifest.digest;
  p.delta.geometry.prepare=[...new Set<string>(p.manifest.objects.map((o:Doc)=>o.meshExportSha256))].sort();
  p.digest=sha(canonical({manifestDigest:p.manifest.digest,delta:p.delta}));return p as PreparedStudioImport;
}
function replaceExport(p:PreparedStudioImport,doc:Doc,bin:Buffer) {
  const bytes=pack(doc,bin), next=structuredClone(p) as unknown as Doc;
  next.manifest.files[0].sha256=sha(bytes);next.manifest.files[0].byteLength=bytes.length;
  return {prepared:seal(next),files:new Map([['export',bytes]])};
}
function refuse(run:()=>unknown,code?:StudioImportPayloadError['code'],message?:RegExp):void {
  assert.throws(run,e=>e instanceof StudioImportPayloadError&&(!code||e.code===code)&&(!message||message.test(e.message)));
}
function streams(p:StudioImportPayload):StudioImportPayloadBuffer[]{return p.objects.flatMap(o=>o.primitives.flatMap(p=>[...Object.values(p.attributes),p.indices]));}
function verifyChunks(payload:StudioImportPayload) {
  let binary=0,count=0;
  for(const b of streams(payload)){
    assert.equal(sha(b.bytes),b.sha256);assert.equal(b.bytes.byteLength,b.byteLength);binary+=b.byteLength;
    let offset=0;const parts:Buffer[]=[];
    for(const c of b.chunks){
      assert.ok(Object.isFrozen(c));assert.equal(c.formatVersion,1);assert.equal(c.manifestDigest,payload.manifestDigest);assert.equal(c.bufferSha256,b.sha256);assert.equal(c.semantic,b.semantic);
      assert.equal(c.offset,offset);const raw=Buffer.from(c.data,'base64');assert.equal(raw.length,c.byteLength);assert.equal(sha(raw),c.sha256);
      assert.ok(Buffer.byteLength(JSON.stringify(c))<=STUDIO_IMPORT_PAYLOAD_LIMITS.encodedChunkBytes);assert.ok(Buffer.byteLength(JSON.stringify(c))<256*1024);
      offset+=raw.length;count++;parts.push(raw);
    }
    assert.equal(offset,b.byteLength);assert.deepEqual(Buffer.concat(parts),Buffer.from(b.bytes));
  }
  assert.equal(binary,payload.binaryByteLength);assert.equal(count,payload.chunkCount);assert.ok(payload.aggregateEncodedByteLength<=STUDIO_IMPORT_PAYLOAD_LIMITS.encodedBytes);
  return {binary,count};
}
test('owned tiny GLB: stable objects, binary attributes, scalar emission and exact pending metadata',async()=>{
  const f=fixture(),g=f.generated(),p=await prepare(g),payload=decodeStudioImportPayload(p,new Map([['export',g.files[0]!.bytes]]));
  assert.equal(payload.formatVersion,1);assert.equal(payload.engineVerification,'pending');assert.equal(payload.preparedDigest,p.digest);assert.equal(payload.manifestDigest,p.manifest.digest);
  assert.deepEqual(payload.anchors,p.manifest.anchors);assert.deepEqual(payload.conversion,p.manifest.conversion);assert.deepEqual(payload.placement,p.manifest.placement);assert.deepEqual(payload.files,p.manifest.files);
  assert.deepEqual(payload.objects.map(o=>o.object),p.manifest.objects);assert.deepEqual(payload.objects.find(o=>o.object.role==='render')!.material,p.manifest.materials[0]);
  assert.deepEqual(payload.objects.find(o=>o.object.role==='render')!.material!.emission!.factor,[0.1,0.2,0.3]);
  assert.equal((payload.objects[0]!.provenance.node.extras as Doc).retained_semantic,'authored');verifyChunks(payload);
  assert.ok(Object.isFrozen(payload));assert.ok(Object.isFrozen(payload.objects[0]!.object));assert.ok(Object.isFrozen(payload.objects[0]!.primitives[0]!.attributes));
  assert.ok(!('hostAuthority' in payload));assert.ok(!('engineAuthority' in payload));
});
test('input, plan, output streams and immutable chunks never alias; detached/shared/proxy/getter inputs fail safely',async()=>{
  const f=fixture(),g=f.generated(),p=await prepare(g),input=Buffer.from(g.files[0]!.bytes),payload=decodeStudioImportPayload(p,new Map([['export',input]]));
  const all=streams(payload), first=all[0]!, hash=first.sha256, bytes=Buffer.from(first.bytes), encoded=first.chunks.map(c=>c.data);
  input.fill(0);assert.deepEqual(Buffer.from(first.bytes),bytes);
  first.bytes.fill(255);assert.equal(first.sha256,hash);assert.deepEqual(first.chunks.map(c=>c.data),encoded);assert.notEqual(sha(first.bytes),hash);
  assert.ok(all.slice(1).every(b=>b.bytes.buffer!==first.bytes.buffer));assert.notEqual(payload.objects[0]!.object,p.manifest.objects[0]);
  const valid=new Map([['export',g.files[0]!.bytes]]);let calls=0;
  const evil=Object.defineProperty({},'manifest',{get(){calls++;throw new Error('getter');}});
  refuse(()=>decodeStudioImportPayload(evil as PreparedStudioImport,valid),'SCHEMA');assert.equal(calls,0);
  refuse(()=>decodeStudioImportPayload(p,new Proxy(valid,{})),'SCHEMA');
  refuse(()=>decodeStudioImportPayload(p,new Map([['export',new Uint8Array(new SharedArrayBuffer(input.length))]])),'SCHEMA');
  const detached=new Uint8Array(new ArrayBuffer(input.length));structuredClone(detached.buffer,{transfer:[detached.buffer]});
  refuse(()=>decodeStudioImportPayload(p,new Map([['export',detached]])));
  const poisoned=Buffer.from(g.files[0]!.bytes);Object.defineProperty(poisoned,'byteLength',{get(){throw new Error('shadow');}});
  verifyChunks(decodeStudioImportPayload(p,new Map([['export',poisoned]])));
});
test('exact prepared/file checksums and export set checked before decoding',async()=>{
  const f=fixture(),g=f.generated(),p=await prepare(g),valid=g.files[0]!.bytes;
  const bad=Buffer.from(valid);bad[bad.length-1]=bad[bad.length-1]!^1;
  refuse(()=>decodeStudioImportPayload(p,new Map([['export',bad]])),'CHECKSUM');
  refuse(()=>decodeStudioImportPayload(p,new Map([['export',valid.subarray(0,valid.length-4)]])),'CHECKSUM');
  refuse(()=>decodeStudioImportPayload(p,new Map()),'CHECKSUM');
  refuse(()=>decodeStudioImportPayload(p,new Map([['wrong',valid]])),'SCHEMA');
  refuse(()=>decodeStudioImportPayload(p,new Map([['export',valid],['extra',valid]])),'CHECKSUM');
  const invalid=structuredClone(p) as unknown as Doc;invalid.manifest.digest=H;
  refuse(()=>decodeStudioImportPayload(invalid as PreparedStudioImport,new Map([['export',valid]])),'SCHEMA');
});
const attacks:readonly [string,(d:Doc,b:Buffer)=>void][]=[
  ['view overflow',d=>{d.bufferViews[0].byteOffset=Number.MAX_SAFE_INTEGER;}],
  ['view overrun',d=>{d.bufferViews[0].byteLength=d.buffers[0].byteLength+1;}],
  ['negative view',d=>{d.bufferViews[0].byteOffset=-4;}],
  ['accessor overrun',d=>{d.accessors[0].byteOffset=4;}],
  ['component alignment',d=>{d.accessors[0].byteOffset=1;}],
  ['fractional offset',d=>{d.accessors[0].byteOffset=0.5;}],
  ['unsafe count',d=>{d.accessors[0].count=Number.MAX_SAFE_INTEGER;}],
  ['empty count',d=>{d.accessors[0].count=0;}],
  ['count mismatch',d=>{d.accessors[1].count=3;}],
  ['stride underflow',d=>{d.bufferViews[0].byteStride=8;}],
  ['stride alignment',d=>{d.bufferViews[0].byteStride=14;}],
  ['index stride',d=>{d.bufferViews[3].byteStride=4;}],
  ['wrong component',d=>{d.accessors[0].componentType=5123;}],
  ['normalized float',d=>{d.accessors[0].normalized=true;}],
  ['dense missing view',d=>{delete d.accessors[0].bufferView;}],
  ['sparse accessor',d=>{d.accessors[0].sparse={count:1,indices:{bufferView:3,componentType:5123},values:{bufferView:0}};}],
  ['nonfinite position',(d,b)=>{b.writeFloatLE(NaN,d.bufferViews[0].byteOffset);}],
  ['nonfinite normal',(d,b)=>{b.writeFloatLE(Infinity,d.bufferViews[1].byteOffset);}],
  ['nonfinite UV',(d,b)=>{b.writeFloatLE(NaN,d.bufferViews[2].byteOffset);}],
  ['UV magnitude',(d,b)=>{b.writeFloatLE(1_000_001,d.bufferViews[2].byteOffset);}],
  ['index outside vertices',(d,b)=>{b.writeUInt16LE(4,d.bufferViews[3].byteOffset);}],
  ['index restart',(d,b)=>{b.writeUInt16LE(65535,d.bufferViews[3].byteOffset);}],
  ['nontriangle count',d=>{d.accessors[3].count=11;}],
  ['changed finite geometry',(d,b)=>{b.writeFloatLE(0.25,d.bufferViews[0].byteOffset+12);}],
  ['node index mapping',d=>{d.nodes[0].extras.arcane_source_object_id=C;}],
  ['role mapping',d=>{d.nodes[0].extras.arcane_role='collision';}],
  ['collision mapping',d=>{d.nodes[1].extras.arcane_collision_for='[]';}],
  ['anchor mapping',d=>{d.nodes[2].extras.arcane_source_anchor_id=R;}],
  ['anchor transform',d=>{d.nodes[2].translation[0]=2;}],
  ['source transform',d=>{d.nodes[0].translation=[1,0,0];}],
  ['shear',d=>{d.nodes[0].matrix=[...I];d.nodes[0].matrix[4]=0.5;}],
  ['mirror',d=>{d.nodes[0].scale=[-1,1,1];}],
  ['singular',d=>{d.nodes[0].scale=[0,1,1];}],
  ['external URI',d=>{d.buffers[0].uri='file.bin';}],
  ['animation',d=>{d.animations=[{samplers:[],channels:[]}];}],
  ['skin',d=>{d.skins=[{joints:[0]}];}],
  ['unknown material',d=>{d.materials[0].unsupported='lost';}],
  ['alpha',d=>{d.materials[0].alphaMode='BLEND';}],
  ['unknown attribute',d=>{d.meshes[0].primitives[0].attributes._CUSTOM=1;}],
];
for(const [name,change] of attacks)test('reject '+name+' even with resigned export/manifest checksums',async()=>{
  const f=fixture(),p=await prepare(f.generated());change(f.doc,f.bin);const next=replaceExport(p,f.doc,f.bin);
  refuse(()=>decodeStudioImportPayload(next.prepared,next.files));
});
test('supported preparation attributes TANGENT/COLOR_0 are explicitly refused instead of dropped',async()=>{
  for(const semantic of ['TANGENT','COLOR_0']){
    const f=fixture(),p=await prepare(f.generated());let accessor=1;
    if(semantic==='TANGENT'){
      const raw=Buffer.alloc(64);Array.from({length:4},()=>[1,0,0,1]).flat().forEach((v,i)=>raw.writeFloatLE(v,i*4));
      const vi=f.doc.bufferViews.length,offset=f.bin.length;f.bin=Buffer.concat([f.bin,raw]);
      f.doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:64,target:34962});accessor=f.doc.accessors.length;
      f.doc.accessors.push({bufferView:vi,componentType:5126,type:'VEC4',count:4});
    }
    f.doc.meshes[0].primitives[0].attributes[semantic]=accessor;
    const n=replaceExport(p,f.doc,f.bin);refuse(()=>decodeStudioImportPayload(n.prepared,n.files),'UNSUPPORTED_ATTRIBUTE',new RegExp(semantic));
  }
});
test('unprepared embedded textures fail exact prepared-image identity before any effects',async()=>{
  const f=fixture(),p=await prepare(f.generated());
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
  const offset=Math.ceil(f.bin.length/4)*4, view=f.doc.bufferViews.length;
  f.doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:png.length});f.bin=Buffer.concat([f.bin,Buffer.alloc(offset-f.bin.length),png]);
  f.doc.images=[{bufferView:view,mimeType:'image/png'}];f.doc.textures=[{source:0}];f.doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
  const n=replaceExport(p,f.doc,f.bin);refuse(()=>decodeStudioImportPayload(n.prepared,n.files),'CHECKSUM',/prepared|identity/i);
});
test('finite tiled UV0 preserved exactly; engine sampling remains pending',async()=>{
  const f=fixture(),p=await prepare(f.generated()), next=structuredClone(p) as unknown as Doc;
  const tiled=[-2,3,4,0,1,1,0,1], offset=f.doc.bufferViews[2].byteOffset;
  tiled.forEach((v,i)=>f.bin.writeFloatLE(v,offset+i*4));
  const g=f.generated();next.manifest.files[0].sha256=g.files[0]!.sha256;
  const position=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],normal=Array.from({length:4},()=>[1,0,0]);
  const geometry=[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:Array.from({length:4},(_,i)=>tiled.slice(i*2,i*2+2))},indices:[0,2,1,0,1,3,0,3,2,1,2,3],mode:4}];
  next.manifest.objects.find((o:Doc)=>o.role==='render').meshExportSha256=sha(canonical(geometry));
  const payload=decodeStudioImportPayload(seal(next),new Map([['export',g.files[0]!.bytes]])), uv=payload.objects.find(o=>o.object.role==='render')!.primitives[0]!.attributes.TEXCOORD_0!;
  assert.deepEqual([...new Float32Array(uv.bytes.buffer)],tiled);assert.equal(payload.engineVerification,'pending');verifyChunks(payload);
});
test('interleaved stride/offset and normalized integer UV preserve original packed samples',async()=>{
  for(const componentType of [5126,5123,5121]){
    const f=fixture();
    if(componentType===5126){
      const start=f.bin.length, raw=Buffer.alloc(4*32);
      for(let i=0;i<4;i++){f.bin.copy(raw,i*32,i*12,i*12+12);f.bin.copy(raw,i*32+12,48+i*12,48+i*12+12);f.bin.copy(raw,i*32+24,96+i*8,96+i*8+8);}
      f.bin=Buffer.concat([f.bin,raw]);const vi=f.doc.bufferViews.length;f.doc.bufferViews.push({buffer:0,byteOffset:start,byteLength:raw.length,byteStride:32,target:34962});
      for(const [i,offset] of [[0,0],[1,12],[2,24]]){f.doc.accessors[i!].bufferView=vi;f.doc.accessors[i!].byteOffset=offset;}
    }else{
      const raw=Buffer.alloc(componentType===5123?16:14), stride=4;
      [0,0,1,0,1,1,0,1].forEach((v,i)=>componentType===5123?raw.writeUInt16LE(v*65535,Math.floor(i/2)*stride+i%2*2):raw.writeUInt8(v*255,Math.floor(i/2)*stride+i%2));
      const start=f.bin.length;f.bin=Buffer.concat([f.bin,raw]);const vi=f.doc.bufferViews.length;f.doc.bufferViews.push({buffer:0,byteOffset:start,byteLength:raw.length,...(componentType===5121?{byteStride:stride}:{}),target:34962});
      Object.assign(f.doc.accessors[2],{bufferView:vi,componentType,normalized:true});
    }
    const g=f.generated(),p=await prepare(g),payload=decodeStudioImportPayload(p,new Map([['export',g.files[0]!.bytes]]));verifyChunks(payload);
    const uv=payload.objects.find(o=>o.object.role==='render')!.primitives[0]!.attributes.TEXCOORD_0!;
    assert.equal(uv.componentType,componentType);assert.equal(uv.normalized,componentType!==5126);assert.equal(uv.byteLength,componentType===5126?32:componentType===5123?16:8);
  }
});
test('unindexed primitives produce bounded sequential indices with explicit implicit provenance',async()=>{
  const f=fixture();f.doc.meshes.forEach((m:Doc)=>delete m.primitives[0].indices);
  // Four vertices cannot represent triangles: parser must reject instead of trimming.
  const p=await prepare(fixture().generated()),n=replaceExport(p,f.doc,f.bin);refuse(()=>decodeStudioImportPayload(n.prepared,n.files),'EXPORT');
});
test('budgets only tighten; binary/encoded aggregate, chunk count and vertices bound independently',async()=>{
  const f=fixture(),g=f.generated(),p=await prepare(g),files=new Map([['export',g.files[0]!.bytes]]);
  for(const limits of [{binaryBytes:1},{encodedBytes:1},{chunks:1},{meshVertices:1},{encodedChunkBytes:1},{chunkBytes:0},{chunkBytes:STUDIO_IMPORT_PAYLOAD_LIMITS.chunkBytes+1}])refuse(()=>decodeStudioImportPayload(p,files,limits),'BUDGET');
  const payload=decodeStudioImportPayload(p,files,{chunkBytes:5});verifyChunks(payload);assert.ok(payload.chunkCount>20);
});
test('real default chunk ceiling: 60000 vertices/20000 triangles preserve ordered bytes and reserve bridge overhead',async()=>{
  const f=fixture(),parts:Buffer[]=[],accessors:Doc[]=[],views:Doc[]=[];let offset=0;
  for(const [type,components,componentType] of [['VEC3',3,5126],['VEC3',3,5126],['VEC2',2,5126],['SCALAR',1,5125]] as const){
    const raw=Buffer.alloc(60_000*components*4),index=accessors.length;
    for(let i=0;i<60_000;i++)for(let c=0;c<components;c++){
      const value=index===0?[[0,0,0],[1,0,0],[0,1,0],[0,0,1]][i%4]![c]!:index===1?Number(c===0):index===2?Number(i%2===c):i;
      if(componentType===5125)raw.writeUInt32LE(value,(i*components+c)*4);else raw.writeFloatLE(value,(i*components+c)*4);
    }
    views.push({buffer:0,byteOffset:offset,byteLength:raw.length,target:index===3?34963:34962});
    accessors.push({bufferView:index,componentType,type,count:60_000,...(index===0?{min:[0,0,0],max:[1,1,1]}:{})});parts.push(raw);offset+=raw.length;
  }
  f.doc.accessors=accessors;f.doc.bufferViews=views;f.bin=Buffer.concat(parts);
  const g=f.generated(),p=await prepare(g),payload=decodeStudioImportPayload(p,new Map([['export',g.files[0]!.bytes]]));verifyChunks(payload); const transfer=createStudioImportTransfer(p,payload);assert.ok(transfer.packets.every(packet=>packet.byteLength<=256*1024));
  assert.equal(payload.binaryByteLength,3_840_000);assert.ok(streams(payload).some(b=>b.chunks.length>1));
  const full=streams(payload).flatMap(b=>b.chunks).filter(c=>c.byteLength===STUDIO_IMPORT_PAYLOAD_LIMITS.chunkBytes);
  assert.ok(full.length>0);assert.ok(full.every(c=>Buffer.byteLength(JSON.stringify({chunk:c}))<256*1024));
});
const actualReport=process.env.ARCANE_STUDIO_IMPORT_PAYLOAD_ACTUAL_REPORT;
test('private retained Blender GLBs: independently compare every packed stream to unchanged actual bytes',{skip:!actualReport},async()=>{
  const report=JSON.parse(readFileSync(actualReport!,'utf8')) as Doc;
  const exports=new Map<'asset.glb'|'collision.glb',Buffer>();
  for(const name of ['asset.glb','collision.glb'] as const){const f=report.outputFiles.find((f:Doc)=>f.relativePath===name), bytes=readFileSync(f.path);assert.equal(sha(bytes),f.sha256);assert.equal(bytes.length,f.bytes);exports.set(name,bytes);}
  const s=report.offlineSelection;
  const generated=adaptCompletedStudioImport(report.manifest as AssetManifest,exports,H,{target:s.target,placement:s.placement,studsPerMeter:s.studsPerMeter},null);
  const p=await prepare(generated),payload=decodeStudioImportPayload(p,new Map(generated.files.map(f=>[f.fileId,f.bytes])));verifyChunks(payload);
  assert.equal(payload.objects.length,12);assert.equal(payload.anchors.length,2);
  assert.equal(payload.objects.filter(o=>o.object.role==='render').reduce((s,o)=>s+o.object.triangles,0),1102);
  assert.equal(payload.objects.filter(o=>o.object.role==='collision').reduce((s,o)=>s+o.object.triangles,0),56);
  assert.ok(payload.objects.some(o=>o.material?.emission?.factor.some(n=>n>0)));
  for(const o of payload.objects){
    const f=generated.files.find(f=>f.fileId===o.object.exportFileId)!, bytes=Buffer.from(f.bytes), jsonSize=bytes.readUInt32LE(12), doc=JSON.parse(bytes.subarray(20,20+jsonSize).toString()),bin=bytes.subarray(28+jsonSize);
    assert.equal(doc.nodes[o.object.nodeIndex].extras.arcane_source_object_id,o.object.sourceObjectId);
    for(const primitive of o.primitives)for(const stream of [...Object.values(primitive.attributes),primitive.indices]){
      if(!stream.source){assert.equal(stream.semantic,'indices');continue;}
      const a=doc.accessors[stream.source.accessorIndex],v=doc.bufferViews[a.bufferView],width={5121:1,5123:2,5125:4,5126:4}[a.componentType as 5126]!,size={SCALAR:1,VEC2:2,VEC3:3}[a.type as 'VEC3']!*width;
      const chunks=Array.from({length:a.count},(_,i)=>bin.subarray((v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??size),(v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??size)+size));
      assert.deepEqual(Buffer.concat(chunks),Buffer.from(stream.bytes));
    }
  }
});
