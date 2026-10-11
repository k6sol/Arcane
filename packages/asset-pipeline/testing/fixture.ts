/** Synthetic unit-test bytes only. This fixture never invokes Blender. */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {normalizeRequest,sha256,pngCrc} from '../src/validation.js';
import type {AssetAudit,AssetManifest,MeshMetrics,Artifact} from '../src/types.js';
const request=()=>normalizeRequest({template:'environment-kit',name:'test-kit',renderResolution:128});
function mesh(name: string, role: MeshMetrics['role'], triangles: number): MeshMetrics {
  return {name,role,vertices:4,edges:6,faces:4,triangles,nonManifoldEdges:0,looseVertices:0,looseEdges:0,duplicateVertices:0,duplicateFaces:0,degenerateFaces:0,inconsistentNormals:0,invertedComponents:0,finitePositions:true,uvLayers:role==='collision'?0:1,uvLoops:role==='collision'?0:12,invalidUVs:0,degenerateUVFaces:0,dimensions:[1,1,1],scale:[1,1,1],rotation:[0,0,0],materials:role==='collision'?[]:['MAT_Test'],errors:[]};
}
export function audit(): AssetAudit {
  return {schemaVersion:1,template:'environment-kit',meshes:[mesh('SM_Test','render',4),mesh('COL_Test','collision',4)],totals:{renderTriangles:4,lod1Triangles:0,collisionTriangles:4,materials:1},renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:128,height:128,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:0.5,standardDeviation:0.2})),exports:[{path:'asset.glb',objects:1,triangles:4,materials:1,finitePositions:true},{path:'asset.fbx',objects:1,triangles:4,materials:1,finitePositions:true},{path:'collision.glb',objects:1,triangles:4,materials:0,finitePositions:true}],savedSceneReopened:true,errors:[],warnings:['Synthetic fixture, never native integration evidence.']};
}

export function glb(change?: (doc: Record<string,unknown>, bin: Buffer) => void): Buffer {
  const bin=Buffer.alloc(112);
  const positions=[0,0,0,1,0,0,0,1,0,0,0,1], normals=Array.from({length:4},()=>[0,0,1]).flat(), indices=[0,2,1,0,1,3,1,2,3,2,0,3];
  positions.forEach((v,i)=>bin.writeFloatLE(v,i*4)); normals.forEach((v,i)=>bin.writeFloatLE(v,48+i*4)); indices.forEach((v,i)=>bin.writeUInt8(v,96+i));
  const doc:Record<string,unknown>={asset:{version:'2.0'},buffers:[{byteLength:108}],bufferViews:[{buffer:0,byteOffset:0,byteLength:48},{buffer:0,byteOffset:48,byteLength:48},{buffer:0,byteOffset:96,byteLength:12}],accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3'},{bufferView:1,componentType:5126,count:4,type:'VEC3'},{bufferView:2,componentType:5121,count:12,type:'SCALAR'}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}]};
  // BIN padding is at most three bytes; 108 is already aligned.
  const actual=bin.subarray(0,108);change?.(doc,actual);
  const raw=Buffer.from(JSON.stringify(doc)), json=Buffer.alloc(Math.ceil(raw.length/4)*4,0x20);raw.copy(json);
  const out=Buffer.alloc(12+8+json.length+8+actual.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(json.length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);const at=20+json.length;out.writeUInt32LE(actual.length,at);out.writeUInt32LE(0x004e4942,at+4);actual.copy(out,at+8);return out;
}

export function png(uniform=false): Buffer {
  const n=128,raw=Buffer.alloc((n*3+1)*n);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++) {const c=uniform?50:(x<64?25:210);raw.fill(c,y*(n*3+1)+1+x*3,y*(n*3+1)+1+(x+1)*3);}
  const header=Buffer.alloc(13);header.writeUInt32BE(n,0);header.writeUInt32BE(n,4);header[8]=8;header[9]=2;
  const chunk=(kind:string,data:Buffer)=>{const c=Buffer.alloc(12+data.length);c.writeUInt32BE(data.length,0);c.write(kind,4);data.copy(c,8);c.writeUInt32BE(pngCrc(c.subarray(4,8+data.length)),8+data.length);return c;};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

export async function manifestFixture(directory:string):Promise<AssetManifest> {
  const a=audit(),req=request(),files:Record<string,Buffer|string>={'asset.blend':'synthetic scene fixture','blockout.blend':'synthetic checkpoint','asset.glb':glb(),'asset.fbx':'synthetic fbx fixture','collision.glb':glb(),'preview-hero.png':png(),'preview-side.png':png(),'audit.json':JSON.stringify(a),'request.json':JSON.stringify(req),'asset_worker.py':'# not executed\n','audit.py':'# not executed\n','probe.py':'# not executed\n'};
  const artifacts:Artifact[]=[];
  for(const [path,value] of Object.entries(files)) {const bytes=Buffer.from(value);await writeFile(join(directory,path),bytes);const role: Artifact['role'] = path.endsWith('.blend') ? (path.startsWith('blockout') ? 'checkpoint' : 'scene') : path.endsWith('.glb') || path.endsWith('.fbx') ? 'export' : path.endsWith('.png') ? 'preview' : path.endsWith('.py') ? 'worker' : path === 'request.json' ? 'request' : 'audit'; artifacts.push({path,role,bytes:bytes.length,sha256:sha256(bytes)});}
  const m:AssetManifest={schemaVersion:1,jobId:'11111111-1111-4111-8111-111111111111',createdAt:'2026-01-01T00:00:00Z',request:req,runtime:{executable:'synthetic-not-run',version:'synthetic',pythonVersion:'synthetic',background:true,capabilities:{glbExport:true,glbImport:true,fbxExport:true,fbxImport:true,cycles:true}},templateSha256:sha256(Buffer.from(['asset_worker.py','audit.py','probe.py'].map(n=>artifacts.find(x=>x.path===n)!.sha256).join('\n'))),coordinateSystem:{units:'meters',sceneUp:'Z',glbUp:'Y',fbxUp:'Y',pivot:'floor',robloxScaleVerified:false},validation:a,artifacts,limitations:['Synthetic unit fixture. No Blender invocation or integration evidence.']};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(m));return m;
}
