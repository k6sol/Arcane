import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {snapshotConvertedMeshKeepObservation,validateMeshKeepReceipt,type ConvertedMeshKeepExpected} from '../../packages/core/src/mesh-keep-policy.js';
import type {Json} from '../../packages/protocol/src/studio.js';

// Synthetic native ACK metadata exercises actual closed host policy only. It
// proves neither live Instances, preserved engine state, upload consent nor rights.
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
  const sourceObjectId='arcane_'+sha('object'),graphDigest=sha('graph'),conversionRequestDigest=sha('request');
  const groupChildren=[{instanceRef:uuid(10),kind:'script' as const,stateSha256:sha('script')}];
  const meshChildren=[{instanceRef:uuid(11),kind:'attachment' as const,stateSha256:sha('attachment')},{instanceRef:uuid(12),kind:'constraint' as const,stateSha256:sha('constraint')}];
  const nodes=[{nodeKey:'node0',instanceRef:uuid(1),ownedStateSha256:sha('group state'),authoredChildren:groupChildren},{nodeKey:'node0_primitive0',instanceRef:uuid(2),ownedStateSha256:sha('mesh state'),authoredChildren:meshChildren}];
  const objects=[{sourceObjectId,instanceRef:uuid(2),ownedStateSha256:sha('mesh state'),authoredChildren:structuredClone(meshChildren),meshAssetId:'123'}];
  const converted={formatVersion:2 as const,receiptScope:'studio-session-observation' as const,imported:false as const,engineVerification:'pending' as const,graphDigest,conversionRequestDigest,nodes,objects};
  const expected:ConvertedMeshKeepExpected={transferDigest:sha('transfer'),graphDigest,conversionRequestDigest,nodes:[{nodeKey:'node0',parentKey:null},{nodeKey:'node0_primitive0',parentKey:'node0'}],meshes:[{sourceObjectId,nodeKey:'node0_primitive0'}]};
  const meshes=[{index:1,name:'Tree',assetId:123,upload:'succeeded' as const,reason:null,swapped:true}];
  const args:Record<string,Json>={source:'editable-'+expected.transferDigest,creatorId:7,finish:false};
  const legacy={state:'kept',meshes,uploadsStarted:1,swapped:1,persistence:'saved-asset',creatorId:7,ref:null};
  return {converted,expected,meshes,args,legacy};
}

test('converted keep preserves closed actual child rows with shared node/object observations',()=>{
  const f=fixture(),r=validateMeshKeepReceipt(f.args,{...f.legacy,converted:f.converted},f.expected);
  assert.ok('converted'in r);if(!('converted'in r))assert.fail('Expected converted branch');
  assert.deepEqual(r.converted,f.converted);assert.equal(r.converted.nodes[0]!.authoredChildren[0]!.kind,'script');
  assert.deepEqual(r.converted.nodes[1]!.authoredChildren,r.converted.objects[0]!.authoredChildren);
  assert.equal(r.converted.imported,false);assert.equal(r.converted.engineVerification,'pending');assert.equal(r.converted.objects[0]!.meshAssetId,'123');
  assert.ok(Object.isFrozen(r.converted.nodes[1]!.authoredChildren[0]));assert.notEqual(r.converted.nodes[1]!.authoredChildren,f.converted.nodes[1]!.authoredChildren);
  f.converted.nodes[0]!.authoredChildren[0]!.stateSha256=sha('later mutation');assert.notDeepEqual(r.converted,f.converted);
});

test('converted child metadata refuses unknown fields, kinds, malformed identities and state hashes',()=>{
  const f=fixture(),original=f.converted.nodes[0]!.authoredChildren[0]!;
  for(const child of [{...original,extra:true},{...original,kind:'model'},{...original,instanceRef:'not-a-ref'},{...original,stateSha256:sha('state')+'\n'},{instanceRef:original.instanceRef,kind:'script'}]){
    const value={...f.converted,nodes:[{...f.converted.nodes[0]!,authoredChildren:[child]},f.converted.nodes[1]!]};
    assert.throws(()=>snapshotConvertedMeshKeepObservation(value,f.meshes,f.expected),{code:'RECEIPT'});
  }
});

test('child refs are unique per actual owner, cannot alias managed geometry and must match shared mesh rows',()=>{
  const f=fixture(),child=f.converted.nodes[0]!.authoredChildren[0]!;
  const values=[
    {...f.converted,nodes:[{...f.converted.nodes[0]!,authoredChildren:[child,child]},f.converted.nodes[1]!]},
    {...f.converted,nodes:[{...f.converted.nodes[0]!,authoredChildren:[{...child,instanceRef:f.converted.nodes[1]!.instanceRef}]},f.converted.nodes[1]!]},
    {...f.converted,nodes:[{...f.converted.nodes[0]!,authoredChildren:[f.converted.nodes[1]!.authoredChildren[0]!] },f.converted.nodes[1]!]},
    {...f.converted,objects:[{...f.converted.objects[0]!,authoredChildren:[]}]},
    {...f.converted,objects:[{...f.converted.objects[0]!,authoredChildren:[...f.converted.objects[0]!.authoredChildren].reverse()}]},
    {...f.converted,objects:[{...f.converted.objects[0]!,authoredChildren:f.converted.objects[0]!.authoredChildren.map(child=>({...child,stateSha256:sha('changed')}))}]}
  ];
  for(const value of values)assert.throws(()=>snapshotConvertedMeshKeepObservation(value,f.meshes,f.expected),{code:'RECEIPT'});
});

test('sealed graph associations and exact saved asset IDs remain required with preserved children',()=>{
  const f=fixture();
  for(const expected of [{...f.expected,graphDigest:sha('other graph')},{...f.expected,meshes:[{...f.expected.meshes[0]!,sourceObjectId:'arcane_'+sha('other')}]},{...f.expected,meshes:[{...f.expected.meshes[0]!,nodeKey:'node0'}]}])assert.throws(()=>snapshotConvertedMeshKeepObservation(f.converted,f.meshes,expected),{code:'RECEIPT'});
  assert.throws(()=>snapshotConvertedMeshKeepObservation(f.converted,[{assetId:124,swapped:true}],f.expected),{code:'RECEIPT'});
  assert.throws(()=>validateMeshKeepReceipt({...f.args,source:'editable-'+sha('wrong transfer')},{...f.legacy,converted:f.converted},f.expected),{code:'RECEIPT'});
  assert.throws(()=>validateMeshKeepReceipt(f.args,{...f.legacy,converted:f.converted,swapped:0},f.expected),{code:'RECEIPT'});
  assert.throws(()=>validateMeshKeepReceipt(f.args,f.legacy,f.expected),{code:'RECEIPT'});
});

test('converted child snapshots reject hostile descriptors, proxies and sparse or oversized lists without execution',()=>{
  const f=fixture();let reads=0;const child={...f.converted.nodes[0]!.authoredChildren[0]!};
  Object.defineProperty(child,'stateSha256',{enumerable:true,get(){reads++;throw Error('getter');}});
  const proxy=new Proxy(child,{ownKeys(){reads++;throw Error('proxy');}});
  const hidden={...f.converted.nodes[0]!.authoredChildren[0]!};Object.defineProperty(hidden,'hidden',{value:true});
  const symbol={...f.converted.nodes[0]!.authoredChildren[0]!,[Symbol('hidden')]:true};
  const sparse=[f.converted.nodes[0]!.authoredChildren[0]!];Reflect.deleteProperty(sparse,'0');
  for(const authoredChildren of [[child],[proxy],[hidden],[symbol],sparse,Array.from({length:129},()=>f.converted.nodes[0]!.authoredChildren[0]!)]){
    const value={...f.converted,nodes:[{...f.converted.nodes[0]!,authoredChildren},f.converted.nodes[1]!]};assert.throws(()=>snapshotConvertedMeshKeepObservation(value,f.meshes,f.expected),{code:'RECEIPT'});
  }
  assert.equal(reads,0);
});

test('legacy generated keep receipt behavior and fields remain unchanged',()=>{
  const f=fixture(),r=validateMeshKeepReceipt(f.args,f.legacy);assert.deepEqual(r,f.legacy);assert.equal('converted'in r,false);
  assert.throws(()=>validateMeshKeepReceipt(f.args,{...f.legacy,unknown:true}),{code:'INPUT'});
});
