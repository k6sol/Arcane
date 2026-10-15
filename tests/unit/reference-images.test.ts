import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {snapshotReferenceImages,referenceImageMetadata,REFERENCE_IMAGE_LIMITS} from '../../packages/codex-client/src/reference-images.js';
import {referencePng,referenceInput} from '../../packages/codex-client/testing/reference-fixture.js';
const refused={code:'REFERENCE_IMAGE'};

test('reference admission derives exact PNG dimensions and byte hash from immutable copied input',()=>{
  const bytes=referencePng(),input=[referenceInput(bytes)],snapshot=snapshotReferenceImages(input);
  input[0]!.name='changed.png';input[0]!.dataUrl='file:///private.png';input.push(referenceInput());
  assert.deepEqual(snapshot,[referenceInput(bytes)]);assert.equal(Object.isFrozen(snapshot),true);assert.equal(Object.isFrozen(snapshot[0]),true);
  assert.deepEqual(referenceImageMetadata(snapshot),[{name:'reference.png',bytes:bytes.length,width:128,height:128,sha256:createHash('sha256').update(bytes).digest('hex')}]);
});
test('reference wire accepts only closed own PNG data, never paths, URLs, identifiers or accessors',()=>{
  let reads=0;const getter={name:'reference.png',get dataUrl(){reads++;return referenceInput().dataUrl;}};
  for(const value of [undefined,null,[],new Proxy([referenceInput()],{}),[getter],[new Proxy(referenceInput(),{})],
    [{...referenceInput(),path:'secret.png'}],[{name:'reference.png',path:'secret.png'}],
    ...['https://example.invalid/image.png','file:///secret.png','data:image/jpeg;base64,AAAA','data:image/png;base64, AA==','data:image/png;base64,AB=='].map(dataUrl=>[{name:'reference.png',dataUrl}]),
    ...['../image.png','NUL.png','bad\n.png','image.jpg'].map(name=>[referenceInput(undefined,name)])])assert.throws(()=>snapshotReferenceImages(value),refused);
  assert.equal(reads,0);const sparse=new Array(1);assert.throws(()=>snapshotReferenceImages(sparse),refused);
});
test('real compressed image data and all aggregate bounds are enforced before native dispatch',()=>{
  assert.equal(snapshotReferenceImages([referenceInput(referencePng(128,128,REFERENCE_IMAGE_LIMITS.bytes))]).length,1);
  assert.throws(()=>snapshotReferenceImages([referenceInput(referencePng(128,128,REFERENCE_IMAGE_LIMITS.bytes+1))]),refused);
  const exact=referenceInput(referencePng(4000,2000));assert.equal(snapshotReferenceImages([exact]).length,1);
  assert.throws(()=>snapshotReferenceImages([exact,referenceInput(referencePng(1,1),'extra.png')]),refused);
  assert.equal(snapshotReferenceImages(Array.from({length:4},(_,i)=>referenceInput(undefined,i+'.png'))).length,4);
  assert.throws(()=>snapshotReferenceImages(Array.from({length:5},(_,i)=>referenceInput(undefined,i+'.png'))),refused);
  assert.throws(()=>snapshotReferenceImages([referenceInput(),referenceInput()]),refused);
  const corrupt=referencePng();corrupt[29]=corrupt[29]!^1;assert.throws(()=>snapshotReferenceImages([referenceInput(corrupt)]),refused);
  assert.throws(()=>snapshotReferenceImages([referenceInput(referencePng(4097,1))]),refused);
});
