import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ARTIFACT_LIMIT, ArtifactDownloads, readDownloadArtifacts, fetchVerifiedArtifact } from '../../apps/desktop/src/asset-downloads.js';
const JOB='11111111-1111-4111-8111-111111111111', TOKEN='a'.repeat(64), bytes=new Uint8Array([103,108,84,70,2,0,0,0]);
const hash=createHash('sha256').update(bytes).digest('hex');
const manifest=(rows:unknown[]=[{path:'asset.glb',role:'export',bytes:bytes.length,sha256:hash}])=>({jobId:JOB,request:{name:'crate'},artifacts:rows});
const descriptor=()=>readDownloadArtifacts(manifest(),JOB)[0]!;
const response=(body:Uint8Array=bytes,headers:Record<string,string>={})=>new Response(new Uint8Array(body).buffer,{headers:{'Content-Type':'model/gltf-binary','Content-Length':String(bytes.length),'Content-Disposition':'attachment; filename="crate-asset.glb"',...headers}});

test('export descriptors bind exact job, role, safe basename, size, hash and display filename',()=>{
 const rows=readDownloadArtifacts(manifest([{path:'asset.glb',role:'export',bytes:8,sha256:hash},{path:'preview-hero.png',role:'preview',bytes:8,sha256:hash}]),JOB);
 assert.equal(rows.length,1);assert.equal(rows[0]!.filename,'crate-asset.glb');assert.equal(rows[0]!.contentType,'model/gltf-binary');
 assert.throws(()=>readDownloadArtifacts(manifest(),'22222222-2222-4222-8222-222222222222'),/exact/);
 for(const override of [{role:'worker'},{bytes:ARTIFACT_LIMIT+1},{bytes:0},{sha256:'x'.repeat(64)}])assert.throws(()=>readDownloadArtifacts(manifest([{path:'asset.glb',role:'export',bytes:8,sha256:hash,...override}]),JOB),/Invalid/);
 assert.throws(()=>readDownloadArtifacts({...manifest(),request:{name:'../escape'}},JOB));
 assert.throws(()=>readDownloadArtifacts(manifest([{path:'asset.glb',role:'export',bytes:8,sha256:hash},{path:'asset.glb',role:'export',bytes:8,sha256:hash}]),JOB));
 assert.deepEqual(readDownloadArtifacts(manifest([{path:'../asset.glb',role:'export',bytes:8,sha256:hash}]),JOB),[]);
});
test('download is exact GET, scoped bearer, no credentials/referrer/redirect and SHA-256 verified',async()=>{
 let calls=0;const transport=async(input:RequestInfo|URL,init?:RequestInit)=>{calls++;assert.equal(input,'/v1/assets/artifact?jobId='+JOB+'&path=asset.glb');assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.referrerPolicy,'no-referrer');assert.equal(init?.redirect,'error');assert.deepEqual(init?.headers,{Authorization:'Bearer '+TOKEN});return response();};
 const blob=await fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,transport as typeof fetch);
 assert.equal(calls,1);assert.equal(blob.size,bytes.length);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
});
test('invalid token, non-manifest path, header mismatch and checksum change fail without a retry',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return response();};await assert.rejects(fetchVerifiedArtifact(descriptor(),'bad',new AbortController().signal,fetcher as typeof fetch));assert.equal(calls,0);
 await assert.rejects(fetchVerifiedArtifact({...descriptor(),path:'../asset.glb'},TOKEN,new AbortController().signal,fetcher as typeof fetch));assert.equal(calls,0);
 for(const headers of [{'Content-Type':'text/html'},{'Content-Length':'100'},{'Content-Disposition':'inline'}]){calls=0;await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,(async()=>{calls++;return response(bytes,headers);}) as typeof fetch),/headers/);assert.equal(calls,1);}
 await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,(async()=>response(new Uint8Array([1,2,3,4,5,6,7,8]))) as typeof fetch),/checksum/);
});
test('short, oversized, refused and already-aborted downloads do not yield a saved artifact',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,controller.signal,(async()=>response()) as typeof fetch),/cancelled/);
 await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,(async()=>response(new Uint8Array([1]))) as typeof fetch),/incomplete/);
 await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,(async()=>response(new Uint8Array(9))) as typeof fetch),/bound/);
 await assert.rejects(fetchVerifiedArtifact(descriptor(),TOKEN,new AbortController().signal,(async()=>new Response('secret should not be echoed',{status:401})) as typeof fetch),error=>error instanceof Error&&error.message.includes('401')&&!error.message.includes('secret'));
});
test('render-only panel tolerates absent optional DOM and never fetches automatically',()=>{
 const doc={getElementById:()=>null} as unknown as Document;const panel=new ArtifactDownloads(doc,TOKEN);panel.clear();panel.show(manifest(),JOB);panel.clear();
});
