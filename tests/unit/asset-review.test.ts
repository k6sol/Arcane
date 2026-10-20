import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm,rename,symlink,unlink,rmdir} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {IncomingMessage,createServer} from 'node:http';
import {Socket} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {AssetReviewStore} from '../../apps/daemon/src/asset-review-store.js';
import {createAssetReviewHost} from '../../apps/daemon/src/asset-review-host.js';
import {assetReviewRoutes} from '../../apps/daemon/src/asset-review-routes.js';
import {assetReviewCanonical,assetReviewDigest,snapshotAssetReviewScope,snapshotAssetReviewSubject,type AssetReviewReceiptAuthority,type AssetReviewSubject} from '../../apps/daemon/src/asset-review.js';
import {createAssetReviewReceiptAuthority} from '../../apps/daemon/src/workflow-host.js';

const JOB='11111111-1111-4111-8111-111111111111',H='a'.repeat(64),CONTROL='human-control-fixture',AGENT='agent-fixture';
const refused=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
function authority(directory:string):AssetReviewReceiptAuthority {
  const key=Buffer.from('only-owned-test-fixture-signing-key');
  const sign=(value:unknown)=>createHmac('sha256',key).update('fixture-asset-review\0').update(assetReviewCanonical(value)).digest('hex');
  return {directory,sign,verify:(value,signature)=>typeof signature==='string'&&signature===sign(value),withSnapshot:evaluate=>evaluate(),close(){}};
}
async function fixture(t:test.TestContext,provider:AssetReviewSubject['conversation']['provider']='codex'){
  const boundary=await realpath(tmpdir()),directory=await mkdtemp(join(boundary,'arcane-asset-review-')),project=workflowProjectIdentity(directory);
  const privateDirectory=join(directory,'private');await mkdir(privateDirectory,{mode:0o700});
  const receiptAuthority=authority(privateDirectory),proof=Symbol('fixture-human');
  const cleanups:(()=>void|Promise<void>)[]=[];
  let permit=false;
  const store=()=>new AssetReviewStore({projectPath:project.projectPath,authority:receiptAuthority,authorizeHuman:(_command,actual)=>permit&&actual===proof});
  let selected=store();
  const subject=snapshotAssetReviewSubject({schemaVersion:1,projectId:project.projectId,conversation:{provider,threadId:provider==='codex'?'native-fixture':'app:'+JOB,sessionId:null},
    jobId:JOB,manifestSha256:H,sourceRequestSha256:'b'.repeat(64),artifacts:[{path:'asset.glb',sha256:'c'.repeat(64),bytes:100},{path:'collision.glb',sha256:'d'.repeat(64),bytes:80}]});
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();selected.close();const path=relative(boundary,directory);assert.ok(path.startsWith('arcane-asset-review-')&&!isAbsolute(path)&&!path.includes('..'));await rm(directory,{recursive:true,force:true});});
  return {directory,project,subject,authority:receiptAuthority,get store(){return selected;},
    cleanup(callback:()=>void|Promise<void>){cleanups.push(callback);},
    restart(){selected.close();selected=store();},
    decide(reviewId:string,decision:'approved'|'rejected',idempotencyKey=randomUUID(),fresh=subject){permit=true;try{return selected.decide({reviewId,decision,idempotencyKey},fresh,proof);}finally{permit=false;}},
  };
}

test('model review stays pending without a real human permit; signed approval survives restart without creating a native capability',async t=>{
  const f=await fixture(t),pending=f.store.prepare(f.subject);
  assert.equal(pending.status,'pending');assert.equal(pending.revision,0);assert.ok(Object.isFrozen(pending.subject.artifacts));
  assert.throws(()=>f.store.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  assert.throws(()=>f.store.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},f.subject,{approved:true}),refused('ASSET_REVIEW_HUMAN_REQUIRED'));
  const approved=f.decide(pending.reviewId,'approved');assert.equal(approved.review.status,'approved');assert.equal(approved.retry,false);
  const reference=f.store.assertApproved(f.subject);assert.ok(Object.isFrozen(reference));
  f.restart();assert.deepEqual(f.store.assertApproved(f.subject),reference);
  assert.equal('actor'in reference,false);assert.equal('target'in reference,false);assert.equal('permission'in reference,false);
});

for(const replacement of ['directory','junction'] as const)test('effect witness rejects private '+replacement+' replacement while an approval is live',async t=>{
  const f=await fixture(t),pending=f.store.prepare(f.subject);f.decide(pending.reviewId,'approved');const reference=f.store.assertApproved(f.subject);
  const directory=f.authority.directory,held=directory+'-held';
  try{await rename(directory,held);}catch(error){if(process.platform==='win32'&&['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('Windows does not allow renaming this owned open SQLite directory.');return;}throw error;}
  let created=false;
  try{
    if(replacement==='junction'){
      try{await symlink(held,directory,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('Owned directory link creation is unavailable.');return;}throw error;}
    }else await mkdir(directory,{mode:0o700});
    created=true;assert.throws(()=>f.store.assertReference(f.subject,reference),refused('ASSET_REVIEW_STORAGE'));
  }finally{if(created){if(replacement==='junction')await unlink(directory);else await rmdir(directory);}await rename(held,directory);}
});

test('every project, provider, thread, nullable session, job, manifest, request and export binding participates in approval',async t=>{
  const f=await fixture(t),pending=f.store.prepare(f.subject);f.decide(pending.reviewId,'approved');
  const changes:((value:any)=>void)[]=[v=>v.projectId='f'.repeat(64),v=>v.conversation.provider='claude-code',v=>v.conversation.threadId='other',
    v=>v.conversation.sessionId='now-real',v=>v.jobId='22222222-2222-4222-8222-222222222222',v=>v.manifestSha256='e'.repeat(64),
    v=>v.sourceRequestSha256='e'.repeat(64),v=>v.artifacts[0].sha256='e'.repeat(64),v=>v.artifacts[1].sha256='e'.repeat(64),v=>v.artifacts[1].bytes++];
  for(const change of changes){const value=structuredClone(f.subject);change(value);assert.throws(()=>f.store.assertApproved(value));}
  assert.equal(f.store.assertApproved(f.subject).reviewId,pending.reviewId);
});

test('changed source gets a fresh pending review and cannot inherit a historical approval after changing back',async t=>{
  const f=await fixture(t),first=f.store.prepare(f.subject);f.decide(first.reviewId,'approved');const reference=f.store.assertApproved(f.subject);
  const changed=snapshotAssetReviewSubject({...f.subject,manifestSha256:'e'.repeat(64)}),second=f.store.prepare(changed);
  assert.notEqual(second.reviewId,first.reviewId);assert.equal(second.status,'pending');
  assert.throws(()=>f.store.assertReference(f.subject,reference),refused('ASSET_REVIEW_REQUIRED'));
  const restored=f.store.prepare(f.subject);assert.notEqual(restored.reviewId,first.reviewId);assert.equal(restored.status,'pending');
});

test('rejection revokes the exact immutable revision and lost acknowledgement is inspected without repeating a decision',async t=>{
  const f=await fixture(t),pending=f.store.prepare(f.subject),key=randomUUID(),approved=f.decide(pending.reviewId,'approved',key);
  const reference=f.store.assertApproved(f.subject);assert.deepEqual(f.decide(pending.reviewId,'approved',key),approved);
  assert.deepEqual(f.store.decisionReceipt(pending.reviewId,key),approved);
  const rejected=f.decide(pending.reviewId,'rejected');assert.equal(rejected.review.revision,2);
  assert.throws(()=>f.store.assertReference(f.subject,reference),refused('ASSET_REVIEW_REJECTED'));
  assert.equal(f.store.decisionReceipt(pending.reviewId,key)!.review.status,'rejected','old command receipt never reports an old approval as current');
  assert.throws(()=>f.decide(pending.reviewId,'approved'),refused('ASSET_REVIEW_DECIDED'));
  assert.throws(()=>f.decide(pending.reviewId,'rejected',key),refused('ASSET_REVIEW_IDEMPOTENCY'));
  f.restart();assert.throws(()=>f.store.assertApproved(f.subject),refused('ASSET_REVIEW_REJECTED'));
});

test('plain record forgery and forged serialized approval references do not acquire a signed durable decision',async t=>{
  const f=await fixture(t),pending=f.store.prepare(f.subject);
  assert.throws(()=>f.store.assertApproved(f.subject,{reviewId:pending.reviewId,subjectDigest:pending.subjectDigest,revision:1}),refused('ASSET_REVIEW_REQUIRED'));
  f.store.close();const db=new DatabaseSync(join(f.authority.directory,'asset-model-reviews-v1.sqlite'));
  const row=db.prepare('SELECT payload FROM asset_reviews WHERE id=?').get(pending.reviewId) as {payload:string};
  const forged=JSON.parse(row.payload);forged.status='approved';forged.revision=1;forged.decidedAt=new Date().toISOString();
  db.prepare('UPDATE asset_reviews SET payload=? WHERE id=?').run(assetReviewCanonical(forged),pending.reviewId);db.close();
  assert.throws(()=>new AssetReviewStore({projectPath:f.project.projectPath,authority:f.authority}),refused('ASSET_REVIEW_STORAGE'));
});

test('subject intake rejects getters, proxies, sparse arrays and synthetic authority flags without invoking them',async t=>{
  const f=await fixture(t);let calls=0;
  const getter={...f.subject};Object.defineProperty(getter,'jobId',{enumerable:true,get(){calls++;return JOB;}});
  assert.throws(()=>snapshotAssetReviewSubject(getter));
  const array=structuredClone(f.subject.artifacts);Object.defineProperty(array,0,{enumerable:true,get(){calls++;return f.subject.artifacts[0];}});
  assert.throws(()=>snapshotAssetReviewSubject({...f.subject,artifacts:array}));
  assert.throws(()=>snapshotAssetReviewSubject(new Proxy(f.subject,{})));
  assert.throws(()=>snapshotAssetReviewSubject({...f.subject,approved:true}));assert.equal(calls,0);
});

test('production receipt helper uses private storage and a distinct model-review signing domain',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),real=createAssetReviewReceiptAuthority(f.directory,f.project.projectId);t.after(()=>real.close());
  const value={reviewId:randomUUID(),decision:'approved'},tag=real.sign(value);
  assert.equal(real.verify(value,tag),true);assert.equal(real.verify({...value,decision:'rejected'},tag),false);
  assert.equal(real.verify(value,'0'.repeat(64)),false);assert.ok(real.directory.startsWith(f.directory));
});

function request(origin:string,token=CONTROL):IncomingMessage {
  const req=new IncomingMessage(new Socket()),host=new URL(origin).host;
  req.method='POST';req.headers={host,origin,authorization:'Bearer '+token,'content-type':'application/json'};
  req.rawHeaders=['Host',host,'Origin',origin,'Authorization','Bearer '+token,'Content-Type','application/json'];return req;
}
async function hostFixture(t:test.TestContext,provider:AssetReviewSubject['conversation']['provider']='codex'){
  const f=await fixture(t,provider);f.store.close();
  const work=new ConversationWorkStore({directory:join(f.directory,'work'),projectPath:f.project.projectPath});
  work.bind({conversation:{...f.subject.conversation},kind:'asset-job',id:JOB});let current=true,source=f.subject,reads=0;
  let hold:(()=>Promise<void>)|undefined;
  const host=createAssetReviewHost({directory:f.directory,projectPath:f.project.projectPath,workAssociations:work,receiptAuthority:f.authority,
    bindingHuman:jobId=>current?work.binding('asset-job',jobId):null,async readSubject(_job,scope,guard){reads++;guard();assert.deepEqual(scope.conversation,source.conversation);await hold?.();guard();return source;}});
  f.cleanup(()=>{host.close();work.close();});
  return {...f,host,get current(){return current;},set current(value:boolean){current=value;},get reads(){return reads;},get source(){return source;},set source(value:AssetReviewSubject){source=value;},get hold(){return hold;},set hold(value:(()=>Promise<void>)|undefined){hold=value;}};
}

test('human host refuses provider, native and general agent bearers and caller-selected authority before reading files',async t=>{
  const f=await hostFixture(t),origin='http://127.0.0.1:12345',auth={controlToken:CONTROL,agentToken:AGENT,origin};
  for(const token of [AGENT,'f'.repeat(64),'unknown-provider'])await assert.rejects(f.host.prepare({jobId:JOB},request(origin,token),auth));
  for(const key of ['approved','projectId','conversation','manifestSha256','target'])await assert.rejects(f.host.prepare({jobId:JOB,[key]:true},request(origin),auth),refused('ASSET_REVIEW_INPUT'));
  assert.equal(f.reads,0);
  const prepared=await f.host.prepare({jobId:JOB},request(origin),auth);assert.equal(prepared.review!.status,'pending');
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  const result=await f.host.decide({reviewId:prepared.review!.reviewId,decision:'approved',idempotencyKey:randomUUID()},request(origin),auth);
  assert.equal(result.review.status,'approved');assert.equal(f.host.assertApproved(f.subject).reviewId,result.review.reviewId);
});

test('human decision rechecks canonical bytes and current UI conversation around its awaited source read',async t=>{
  const f=await hostFixture(t),origin='http://127.0.0.1:12345',auth={controlToken:CONTROL,agentToken:AGENT,origin};
  const prepared=await f.host.prepare({jobId:JOB},request(origin),auth),input={reviewId:prepared.review!.reviewId,decision:'approved',idempotencyKey:randomUUID()};
  f.source=snapshotAssetReviewSubject({...f.subject,manifestSha256:'e'.repeat(64)});
  await assert.rejects(f.host.decide(input,request(origin),auth),refused('ASSET_REVIEW_STALE'));
  f.source=f.subject;f.hold=async()=>{f.current=false;};
  await assert.rejects(f.host.decide(input,request(origin),auth),refused('ASSET_REVIEW_NOT_FOUND'));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});

test('real human HTTP routes cannot be bypassed by direct native or generic agent requests',async t=>{
  const f=await hostFixture(t);let origin='';const route=assetReviewRoutes(f.host);
  const server=createServer((req,res)=>{void route(req,res,new URL(req.url!,origin),CONTROL,origin,AGENT).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{res.writeHead(500);res.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const post=(endpoint:string,value:unknown,token=CONTROL)=>fetch(origin+'/v1/assets/review/'+endpoint,{method:'POST',headers:{authorization:'Bearer '+token,origin,'content-type':'application/json'},body:JSON.stringify(value)});
  for(const token of [AGENT,'f'.repeat(64)])assert.ok((await post('prepare',{jobId:JOB},token)).status>=400);
  assert.equal(f.reads,0);
  const preparedResponse=await post('prepare',{jobId:JOB});assert.equal(preparedResponse.status,200);
  const prepared=await preparedResponse.json() as any;assert.equal(prepared.review.status,'pending');
  const key=randomUUID(),input={reviewId:prepared.review.reviewId,decision:'approved',idempotencyKey:key};
  assert.ok((await post('decide',input,AGENT)).status>=400);assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  const approved=await post('decide',input);assert.equal(approved.status,200);
  const recorded=await(await post('receipt',{reviewId:input.reviewId,idempotencyKey:key})).json() as any;
  assert.equal(recorded.state,'recorded');assert.equal(recorded.review.status,'approved');assert.equal(recorded.retry,false);
  const reject=await post('decide',{...input,idempotencyKey:randomUUID(),decision:'rejected'});assert.equal(reject.status,200);
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REJECTED'));
});

for(const provider of ['claude-code','arcane'] as const)test(provider+' review approval retains exact app attribution, source and human boundaries',async t=>{
  const f=await fixture(t,provider),pending=f.store.prepare(f.subject);
  assert.deepEqual(f.subject.conversation,{provider,threadId:'app:'+JOB,sessionId:null});
  assert.equal(pending.status,'pending');
  assert.throws(()=>f.store.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},f.subject,{approved:true}),refused('ASSET_REVIEW_HUMAN_REQUIRED'));
  assert.throws(()=>f.store.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  f.decide(pending.reviewId,'approved');const reference=f.store.assertApproved(f.subject);
  const changed:AssetReviewSubject[]=[
    {...f.subject,projectId:'f'.repeat(64)},
    {...f.subject,conversation:{...f.subject.conversation,provider:provider==='arcane'?'claude-code':'arcane'}},
    {...f.subject,conversation:{...f.subject.conversation,threadId:'app:22222222-2222-4222-8222-222222222222'}},
    {...f.subject,conversation:{...f.subject.conversation,sessionId:'native-observation'}},
    {...f.subject,jobId:'22222222-2222-4222-8222-222222222222'},
    {...f.subject,manifestSha256:'e'.repeat(64)},
    {...f.subject,sourceRequestSha256:'e'.repeat(64)},
    {...f.subject,artifacts:f.subject.artifacts.map((artifact,index)=>index===0?{...artifact,sha256:'e'.repeat(64)}:artifact)},
    {...f.subject,artifacts:f.subject.artifacts.map((artifact,index)=>index===1?{...artifact,sha256:'e'.repeat(64)}:artifact)},
    {...f.subject,artifacts:f.subject.artifacts.map((artifact,index)=>index===1?{...artifact,bytes:artifact.bytes+1}:artifact)},
  ];
  for(const value of changed)assert.throws(()=>f.store.assertReference(snapshotAssetReviewSubject(value),reference));
  f.restart();assert.deepEqual(f.store.assertApproved(f.subject),reference);
  assert.deepEqual(f.store.read(pending.reviewId).subject.conversation,f.subject.conversation);
  for(const authority of ['actor','target','permission','credential'])assert.equal(authority in reference,false);
});

for(const provider of ['claude-code','arcane'] as const)test(provider+' human review host rechecks actual job scope and source without admitting agent decisions',async t=>{
  const f=await hostFixture(t,provider),origin='http://127.0.0.1:12345',auth={controlToken:CONTROL,agentToken:AGENT,origin};
  for(const token of [AGENT,'f'.repeat(64),provider])await assert.rejects(f.host.prepare({jobId:JOB},request(origin,token),auth));
  await assert.rejects(f.host.prepare({jobId:JOB,conversation:f.subject.conversation},request(origin),auth),refused('ASSET_REVIEW_INPUT'));
  await assert.rejects(f.host.prepare({jobId:'22222222-2222-4222-8222-222222222222'},request(origin),auth),refused('ASSET_REVIEW_NOT_FOUND'));
  assert.equal(f.reads,0);
  const prepared=await f.host.prepare({jobId:JOB},request(origin),auth);
  assert.deepEqual(prepared.subject.conversation,{provider,threadId:'app:'+JOB,sessionId:null});
  const input={reviewId:prepared.review!.reviewId,decision:'approved',idempotencyKey:randomUUID()};
  await assert.rejects(f.host.decide(input,request(origin,AGENT),auth));
  assert.throws(()=>f.host.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  f.source=snapshotAssetReviewSubject({...f.subject,sourceRequestSha256:'e'.repeat(64)});
  await assert.rejects(f.host.decide(input,request(origin),auth),refused('ASSET_REVIEW_STALE'));
  f.source=f.subject;f.hold=async()=>{f.current=false;};
  await assert.rejects(f.host.decide(input,request(origin),auth),refused('ASSET_REVIEW_NOT_FOUND'));
  f.current=true;f.hold=undefined;
  const approved=await f.host.decide(input,request(origin),auth);
  assert.equal(approved.review.status,'approved');
  assert.deepEqual(approved.review.subject.conversation,f.subject.conversation);
  assert.equal(f.host.assertApproved(f.subject).reviewId,prepared.review!.reviewId);
});

test('Arcane review intake adds only its exact provider value and never evaluates supplied authority fields',()=>{
  const conversation={provider:'arcane',threadId:'app:'+JOB,sessionId:null},scope={projectId:H,conversation};
  const snapshot=snapshotAssetReviewScope(scope);assert.deepEqual(snapshot,scope);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.conversation));
  for(const provider of ['Arcane','arcane ','arcane\n','gateway','unknown'])assert.throws(()=>snapshotAssetReviewScope({...scope,conversation:{...conversation,provider}}),refused('ASSET_REVIEW_INPUT'));
  assert.throws(()=>snapshotAssetReviewScope({...scope,conversation:{...conversation,approved:true}}),refused('ASSET_REVIEW_INPUT'));
  assert.throws(()=>snapshotAssetReviewScope({...scope,credential:'not-authority'}),refused('ASSET_REVIEW_INPUT'));
  let reads=0;const getter={...conversation};
  Object.defineProperty(getter,'provider',{enumerable:true,get(){reads++;return 'arcane';}});
  assert.throws(()=>snapshotAssetReviewScope({...scope,conversation:getter}),refused('ASSET_REVIEW_INPUT'));
  assert.throws(()=>snapshotAssetReviewScope({...scope,conversation:new Proxy(conversation,{get(){reads++;return 'arcane';}})}),refused('ASSET_REVIEW_INPUT'));
  assert.equal(reads,0);
});
