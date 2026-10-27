import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readAssetReviewStatus,AssetReviewCard} from '../../apps/desktop/src/asset-review.js';
import {assetReviewDigest,snapshotAssetReviewSubject} from '../../apps/daemon/src/asset-review.js';
import {LearningDocument,learningTick} from './learning-ui-fixture.js';
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222',REVIEW='33333333-3333-4333-8333-333333333333',WITNESS='44444444-4444-4444-8444-444444444444';
const h=(text:string)=>createHash('sha256').update(text).digest('hex'),viewed={jobId:JOB,sha256:h('render'),bytes:32};
function status(collision:'none'|'convex-hull'='none'){
  const subject={schemaVersion:2 as const,kind:'converted-glb' as const,projectId:h('project'),conversation:{provider:'codex' as const,threadId:'converted-review',sessionId:null},jobId:JOB,parentJobId:PARENT,
    manifestSha256:h('manifest'),requestSha256:h('request'),parentManifestSha256:h('parent'),sourceSha256:h('source'),sourceMapSha256:h('source map'),auditSha256:h('audit'),collision,
    artifacts:[{path:'asset.glb' as const,sha256:viewed.sha256,bytes:viewed.bytes},...(collision==='convex-hull'?[{path:'collision.glb' as const,sha256:h('collision'),bytes:24}]:[])]};
  const subjectDigest=assetReviewDigest(subject),review={reviewId:REVIEW,subject,subjectDigest,status:'pending',revision:0,preparedAt:'2026-10-27T00:00:00Z',decidedAt:null as string|null};
  return {subject,subjectDigest,review,openWitness:WITNESS,retry:false};
}
for(const collision of ['none','convex-hull'] as const)test('converted browser review matches daemon canonical '+collision+' subject and exact viewed export',async()=>{
  const value=status(collision),measured=await readAssetReviewStatus(value,viewed);
  assert.deepEqual(measured.subject,snapshotAssetReviewSubject(value.subject));assert.equal(measured.subjectDigest,assetReviewDigest(measured.subject));
  assert.equal('sourceRequestSha256'in measured.subject,false);assert.equal(measured.review!.status,'pending');
  assert.ok(Object.isFrozen(measured.subject)&&Object.isFrozen(measured.subject.conversation)&&Object.isFrozen(measured.subject.artifacts));
  await assert.rejects(readAssetReviewStatus(value,{...viewed,bytes:viewed.bytes+1}));
  await assert.rejects(readAssetReviewStatus(value,{...viewed,sha256:h('other render')}));
});
test('converted browser refuses lineage digest changes, malformed collision inventory and generated-schema fields',async()=>{
  const changes:((value:any)=>void)[]=[v=>v.subject.parentJobId=JOB,v=>v.subject.kind='generated',v=>v.subject.sourceRequestSha256=h('invented'),
    v=>v.subject.artifacts.push({path:'collision.glb',sha256:h('collision'),bytes:24}),v=>v.subject.requestSha256='invalid',v=>v.subject.auditSha256='A'.repeat(64),
    v=>v.subject.artifacts[0].bytes=20_000_001,v=>v.subject.artifacts[0].path='source.glb',v=>v.review.subject={...v.subject,parentManifestSha256:h('other')},
    v=>v.subjectDigest=h('wrong'),v=>v.subject.sourceMapSha256=h('changed without digest'),v=>v.subject.conversation.provider='other'];
  for(const change of changes){const value=status();change(value);await assert.rejects(readAssetReviewStatus(value,viewed));}
  const hull=status('convex-hull');hull.subject.artifacts.reverse();await assert.rejects(readAssetReviewStatus(hull,viewed));
});
test('converted browser descriptor validation refuses getters, hidden fields, symbols, custom prototypes and sparse exports without evaluating accessors',async()=>{
  let reads=0;
  for(const field of ['schemaVersion','requestSha256','conversation'] as const){const value=status();Object.defineProperty(value.subject,field,{enumerable:true,get(){reads++;return null;}});await assert.rejects(readAssetReviewStatus(value,viewed));}
  const row=status();Object.defineProperty(row.subject.artifacts,0,{enumerable:true,get(){reads++;return null;}});await assert.rejects(readAssetReviewStatus(row,viewed));
  const sparse=status();delete sparse.subject.artifacts[0];await assert.rejects(readAssetReviewStatus(sparse,viewed));
  const hidden=status();Object.defineProperty(hidden.subject,'authority',{value:true});await assert.rejects(readAssetReviewStatus(hidden,viewed));
  const symbol=status();Object.defineProperty(symbol.subject,Symbol('authority'),{value:true});await assert.rejects(readAssetReviewStatus(symbol,viewed));
  const prototype=status();Object.setPrototypeOf(prototype.subject,{authority:true});await assert.rejects(readAssetReviewStatus(prototype,viewed));
  assert.equal(reads,0);
});
test('converted review card preserves human-only decisions and fences a receipt for a different audit',async t=>{
  const origin='http://127.0.0.1:32123',doc=new LearningDocument(origin),calls:string[]=[];
  const card=new AssetReviewCard(doc.asDocument(),'a'.repeat(64),{tokenOrigin:origin,transport:async(path,init)=>{
    calls.push(String(path));const value=status('convex-hull');if(String(path).endsWith('/prepare'))return Response.json(value);
    const command=JSON.parse(String(init!.body));assert.deepEqual(Object.keys(command).sort(),['decision','idempotencyKey','openWitness','reviewId']);
    const review={...value.review,subject:{...value.subject,auditSha256:h('foreign audit')},status:'approved',revision:1,decidedAt:'2026-10-27T00:00:01Z'};
    return Response.json({state:'recorded',review,command:{idempotencyKey:command.idempotencyKey,decision:'approved',revision:1},retry:false});
  }});t.after(()=>card.clear());
  await card.show(doc.root as unknown as HTMLElement,viewed,new AbortController().signal,()=>true);
  const approve=doc.root.querySelectorAll('button').find(node=>node.textContent==='Approve model')!;assert.equal(approve.disabled,false);
  approve.dispatchEvent(new Event('click'));await learningTick();assert.deepEqual(calls,['/v1/assets/review/prepare']);
  approve.trustedClick();const deadline=Date.now()+2000;while(!/Decision not confirmed/.test(doc.root.textContent)&&Date.now()<deadline)await learningTick();
  assert.match(doc.root.textContent,/Decision not confirmed/);assert.equal(approve.disabled,true);assert.deepEqual(calls,['/v1/assets/review/prepare','/v1/assets/review/decide']);
});
