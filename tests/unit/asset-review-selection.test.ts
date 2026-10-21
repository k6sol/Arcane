import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm,readdir} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {isDeepStrictEqual} from 'node:util';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {ConversationWorkStore,type NativeConversation} from '../../packages/storage/src/conversation-work-store.js';
import {createAssetReviewHost,type AssetReviewStatus} from '../../apps/daemon/src/asset-review-host.js';
import {assetReviewCanonical,snapshotAssetReviewSubject,type AssetReviewReceiptAuthority,type AssetReviewSubject} from '../../apps/daemon/src/asset-review.js';

const JOB='11111111-1111-4111-8111-111111111111',H='a'.repeat(64),ORIGIN='http://127.0.0.1:12345';
const AUTH={controlToken:'human-selection-fixture',agentToken:'agent-selection-fixture',origin:ORIGIN};
const refused=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
function request():IncomingMessage {
  const req=new IncomingMessage(new Socket()),host=new URL(ORIGIN).host;
  req.method='POST';req.headers={host,origin:ORIGIN,authorization:'Bearer '+AUTH.controlToken,'content-type':'application/json'};
  req.rawHeaders=['Host',host,'Origin',ORIGIN,'Authorization','Bearer '+AUTH.controlToken,'Content-Type','application/json'];return req;
}
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return {pending,release};}
function command(prepared:AssetReviewStatus,decision:'approved'|'rejected'='approved',idempotencyKey=randomUUID()){
  assert.ok(prepared.review);assert.ok(prepared.openWitness);
  return {reviewId:prepared.review.reviewId,decision,idempotencyKey,openWitness:prepared.openWitness};
}
async function fixture(t:test.TestContext,provider:NativeConversation['provider']='claude-code'){
  const boundary=await realpath(tmpdir()),directory=await mkdtemp(join(boundary,'arcane-review-selection-')),project=workflowProjectIdentity(directory);
  const privateDirectory=join(directory,'private');await mkdir(privateDirectory,{mode:0o700});
  const sign=(value:unknown)=>createHmac('sha256','owned-selection-fixture-key').update(assetReviewCanonical(value)).digest('hex');
  const authority:AssetReviewReceiptAuthority={directory:privateDirectory,sign,verify:(value,signature)=>signature===sign(value),withSnapshot:evaluate=>evaluate(),close(){}};
  const work=new ConversationWorkStore({directory:join(directory,'work'),projectPath:project.projectPath});
  const conversation:NativeConversation={provider,threadId:provider==='codex'?'native-review-selection':'app:'+JOB,sessionId:null};
  let selected:NativeConversation|null={...conversation},epoch:object={},hold:(()=>Promise<void>)|undefined,reads=0;
  const subjects=new Map<string,AssetReviewSubject>();
  function addJob(id=JOB):AssetReviewSubject {
    const subject=snapshotAssetReviewSubject({schemaVersion:1,projectId:project.projectId,conversation,jobId:id,
      manifestSha256:H,sourceRequestSha256:'b'.repeat(64),
      artifacts:[{path:'asset.glb',sha256:'c'.repeat(64),bytes:100},{path:'collision.glb',sha256:'d'.repeat(64),bytes:80}]});
    subjects.set(id,subject);work.bind({conversation,kind:'asset-job',id});return subject;
  }
  const subject=addJob();
  const host=createAssetReviewHost({directory,projectPath:project.projectPath,workAssociations:work,receiptAuthority:authority,
    selectionEpoch:()=>epoch,
    bindingHuman(jobId){const binding=work.binding('asset-job',jobId);return binding&&selected&&isDeepStrictEqual(binding.conversation,selected)?binding:null;},
    async readSubject(jobId){
      reads++;const source=subjects.get(jobId);assert.ok(source);
      // Deliberately do not call the supplied guard: these cases exercise the host's own fences.
      await hold?.();return source;
    }});
  t.after(async()=>{host.close();work.close();const owned=relative(boundary,directory);assert.ok(owned.startsWith('arcane-review-selection-')&&!isAbsolute(owned)&&!owned.includes('..'));await rm(directory,{recursive:true,force:true});});
  return {host,subject,conversation,addJob,get reads(){return reads;},files:()=>readdir(privateDirectory),
    select(value:NativeConversation|null){selected=value?{...value}:null;epoch={};},
    setSource(value:AssetReviewSubject){subjects.set(value.jobId,value);},
    set hold(value:(()=>Promise<void>)|undefined){hold=value;},
    prepare(jobId=JOB){return host.prepare({jobId},request(),AUTH);},
    status(jobId=JOB){return host.status({jobId},request(),AUTH);},
    decide(input:unknown){return host.decide(input,request(),AUTH);},
    receipt(reviewId:string,idempotencyKey:string){return host.receipt({reviewId,idempotencyKey},request(),AUTH);},
  };
}

for(const provider of ['codex','claude-code','arcane'] as const){
  test(provider+' held human prepare refuses A to empty to A even when exact conversation returns',async t=>{
    const f=await fixture(t,provider),entered=gate(),held=gate();
    f.hold=()=>{entered.release();return held.pending;};
    const pending=f.prepare();await entered.pending;
    try{f.select(null);f.select(f.conversation);}finally{held.release();}
    await assert.rejects(pending,refused('ASSET_REVIEW_SCOPE'));
    assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
    f.hold=undefined;const fresh=await f.prepare();assert.equal(fresh.review!.status,'pending');assert.ok(fresh.openWitness);
  });
  test(provider+' held human decision refuses a retired selection before signing any approval',async t=>{
    const f=await fixture(t,provider),prepared=await f.prepare(),entered=gate(),held=gate();
    f.hold=()=>{entered.release();return held.pending;};
    const pending=f.decide(command(prepared));await entered.pending;
    try{f.select(null);f.select(f.conversation);}finally{held.release();}
    await assert.rejects(pending,refused('ASSET_REVIEW_SCOPE'));
    assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
    f.hold=undefined;
    assert.equal((await f.status()).review!.revision,0,'The failed decision did not write a signed revision');
  });
}

test('another provider cannot complete a held human open for the original app',async t=>{
  const f=await fixture(t),entered=gate(),held=gate();f.hold=()=>{entered.release();return held.pending;};
  const pending=f.prepare();await entered.pending;
  try{f.select({...f.conversation,provider:'arcane'});}finally{held.release();}
  await assert.rejects(pending,refused('ASSET_REVIEW_SCOPE'));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});

test('reopening the same pending review after A to empty to A never rearms its old button',async t=>{
  const f=await fixture(t),old=await f.prepare();
  f.select(null);f.select(f.conversation);const fresh=await f.prepare();
  assert.equal(fresh.review!.reviewId,old.review!.reviewId);
  assert.notEqual(fresh.openWitness,old.openWitness);
  await assert.rejects(f.decide(command(old)),refused('ASSET_REVIEW_STALE'));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  assert.equal((await f.decide(command(fresh))).review.status,'approved');
});

test('each current human open supersedes its prior witness and a status read manufactures none',async t=>{
  const f=await fixture(t),old=await f.prepare(),status=await f.status(),fresh=await f.prepare();
  assert.equal(status.openWitness,null);assert.equal(fresh.review!.reviewId,old.review!.reviewId);
  await assert.rejects(f.decide(command(old)),refused('ASSET_REVIEW_STALE'));
  await assert.rejects(f.decide({...command(fresh),openWitness:status.openWitness}),refused('ASSET_REVIEW_INPUT'));
  assert.equal((await f.decide(command(fresh))).review.status,'approved');
});

test('a fresh open during an awaited decision fences the older open even without a focus change',async t=>{
  const f=await fixture(t),old=await f.prepare(),entered=gate(),held=gate();f.hold=()=>{entered.release();return held.pending;};
  const pending=f.decide(command(old));await entered.pending;
  f.hold=undefined;
  let fresh:AssetReviewStatus;
  try{fresh=await f.prepare();}finally{held.release();}
  await assert.rejects(pending,refused('ASSET_REVIEW_STALE'));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  assert.equal((await f.decide(command(fresh))).review.status,'approved');
});

test('an unknown open is refused before model-review storage is opened or written',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.files(),[]);
  await assert.rejects(f.decide({reviewId:randomUUID(),decision:'approved',idempotencyKey:randomUUID(),openWitness:randomUUID()}),refused('ASSET_REVIEW_STALE'));
  assert.equal(f.reads,0);assert.deepEqual(await f.files(),[]);
});

test('missing malformed foreign and accessor witnesses cannot read subjects or create a signed decision',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),valid=command(prepared),reads=f.reads;
  const missing={reviewId:valid.reviewId,decision:valid.decision,idempotencyKey:valid.idempotencyKey};
  for(const input of [missing,{...valid,openWitness:null},{...valid,openWitness:'not-a-uuid'},{...valid,openWitness:randomUUID()},
    {...valid,openWitness:valid.openWitness,approved:true}]){
    await assert.rejects(f.decide(input));assert.equal(f.reads,reads);
  }
  let getters=0;const accessor={...valid};Object.defineProperty(accessor,'openWitness',{enumerable:true,get(){getters++;return valid.openWitness;}});
  await assert.rejects(f.decide(accessor),refused('ASSET_REVIEW_INPUT'));assert.equal(getters,0);assert.equal(f.reads,reads);
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});

test('a witness cannot authorize a foreign job provider conversation or nullable session',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),input=command(prepared),otherJob=f.addJob(randomUUID()),other=await f.prepare(otherJob.jobId);
  await assert.rejects(f.decide({...command(other),openWitness:input.openWitness}),refused('ASSET_REVIEW_STALE'));
  for(const conversation of [{...f.conversation,provider:'arcane' as const},{...f.conversation,threadId:'app:'+randomUUID()},{...f.conversation,sessionId:'foreign-native-session'}]){
    f.select(conversation);await assert.rejects(f.decide(input),refused('ASSET_REVIEW_STALE'));
  }
  f.select(f.conversation);
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});

test('fresh subject and exact project checks still fence a valid current witness',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),input=command(prepared);
  f.setSource(snapshotAssetReviewSubject({...f.subject,manifestSha256:'e'.repeat(64)}));
  await assert.rejects(f.decide(input),refused('ASSET_REVIEW_STALE'));
  f.setSource(snapshotAssetReviewSubject({...f.subject,projectId:'f'.repeat(64)}));
  await assert.rejects(f.decide(input),refused('ASSET_REVIEW_SCOPE'));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});

test('selection alone preserves an approved receipt and a fresh reopened model can still be explicitly rejected',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),input=command(prepared);
  const approved=await f.decide(input),reference=f.host.assertApproved(f.subject);
  assert.deepEqual(await f.decide(input),approved,'Exact acknowledged recovery remains idempotent while this open is current');
  f.select(null);f.select(f.conversation);
  assert.doesNotThrow(()=>f.host.assertReference(f.subject,reference),'Focus alone must not revoke an immutable approved revision');
  await assert.rejects(f.decide(input),refused('ASSET_REVIEW_STALE'));
  const recorded=await f.receipt(input.reviewId,input.idempotencyKey);
  assert.equal(recorded.state,'recorded');
  const reopened=await f.prepare();assert.equal(reopened.review!.status,'approved');assert.ok(reopened.openWitness);
  assert.equal((await f.decide(command(reopened,'rejected'))).review.status,'rejected');
  assert.throws(()=>f.host.assertReference(f.subject,reference),refused('ASSET_REVIEW_REJECTED'));
});

test('the bounded open cache invalidates old UI witnesses without revoking accepted model receipts',async t=>{
  const f=await fixture(t),first=await f.prepare();await f.decide(command(first));const reference=f.host.assertApproved(f.subject);
  for(let index=0;index<128;index++){const subject=f.addJob(randomUUID());await f.prepare(subject.jobId);}
  await assert.rejects(f.decide(command(first,'rejected')),refused('ASSET_REVIEW_STALE'));
  assert.doesNotThrow(()=>f.host.assertReference(f.subject,reference));
  const fresh=await f.prepare();assert.notEqual(fresh.openWitness,first.openWitness);
  assert.equal((await f.decide(command(fresh,'rejected'))).review.status,'rejected');
});

test('closing the host retires every open without manufacturing a decision',async t=>{
  const f=await fixture(t),prepared=await f.prepare();f.host.close();
  await assert.rejects(f.decide(command(prepared)),refused('ASSET_REVIEW_CLOSED'));
});
