import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {createNativeAssetRegistry,assertNativeAssetActor,nativeAssetActorScope,nativeAssetOperationSignal,assertNativeAssetStageOperationAvailable,claimNativeAssetStageOperation,assertNativeAssetRevisionOperationAvailable,claimNativeAssetRevisionOperation,acquireNativeAssetWork,type NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import type {AppAssetConversationBinding} from '../../packages/protocol/src/asset-conversation.js';
const refused={code:'NATIVE_ASSET_AUTHORITY'};
function fixture(t:test.TestContext) {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'arcane-native-assets-'))),registry=createNativeAssetRegistry({projectPath:directory});
  t.after(()=>{registry.close();const part=relative(resolve(tmpdir()),resolve(directory));assert.ok(part.startsWith('arcane-native-assets-')&&!part.includes(sep)&&!isAbsolute(part));assert.ok(!lstatSync(directory).isSymbolicLink());rmSync(directory,{recursive:true,force:true});});
  const incarnation=registry.issue(),token=incarnation.credential();
  const seal={connectionId:'connection-a',provider:'codex' as const,threadId:'thread-a',sessionId:null};
  const bound={connectionId:seal.connectionId,threadId:seal.threadId};
  const ready=()=>{incarnation.seal(seal);incarnation.grant(bound);incarnation.dispatched({...bound,operationId:'intent-a'});};
  return {directory,registry,incarnation,token,seal,bound,ready};
}

function appBinding(provider:'claude-code'|'arcane'):AppAssetConversationBinding {
  const anchor={kind:'app-conversation' as const,connectionId:'connection-app',conversationId:'11111111-1111-4111-8111-111111111111'};
  return provider==='claude-code'?{...anchor,provider,transport:{kind:'claude-code-process',incarnationId:'owned-process',nativeSessionId:'observed-session'}}
    :{...anchor,provider,transport:{kind:'arcane-gateway-loop',incarnationId:'owned-loop'}};
}
for(const provider of ['claude-code','arcane'] as const)test(provider+' app binding retains the actual provider and independent dispatch, human grant and cancellation fences',t=>{
  const f=fixture(t),value=appBinding(provider),bound={connectionId:value.connectionId,threadId:'app:'+value.conversationId};
  assert.throws(()=>f.registry.capture(f.token,'read'),refused);
  f.incarnation.bindAppConversation(value);
  const read=f.registry.capture(f.token,'read');
  assert.deepEqual(nativeAssetActorScope(read).conversation,{provider,threadId:bound.threadId,sessionId:null});
  assert.equal(JSON.stringify(nativeAssetActorScope(read)).includes(value.transport.incarnationId),false);
  f.incarnation.dispatched({...bound,operationId:'no-human-send'});assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);f.incarnation.ended('no-human-send');
  f.incarnation.grantNextIntent({...bound,sessionId:null});f.incarnation.dispatched({...bound,operationId:'human-send'});
  const actor=f.registry.capture(f.token,'mutate'),signal=nativeAssetOperationSignal(actor);
  f.incarnation.bindAppConversation(structuredClone(value));assertNativeAssetActor(actor,'mutate');
  claimNativeAssetStageOperation(actor,'22222222-2222-4222-8222-222222222222');
  assert.throws(()=>claimNativeAssetStageOperation(actor,'22222222-2222-4222-8222-222222222222'),refused);
  f.incarnation.ended('human-send');assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);assert.equal(signal.aborted,false);
  f.incarnation.retire();assert.equal(signal.aborted,false);assert.throws(()=>f.registry.capture(f.token,'read'),refused);
  f.incarnation.cancelWork('incarnation');assert.equal(signal.aborted,true);
});
test('app transport binding cannot impersonate a Codex seal, cross providers or overwrite an observed binding',t=>{
  const f=fixture(t),value=appBinding('claude-code');let reads=0;
  assert.ok(value.provider==='claude-code');
  for(const bad of [{...value,provider:'codex'},{...value,provider:'arcane'},
    {...value,conversationId:value.conversationId+'\n'},{...value,transport:{...value.transport,extra:true}},
    Object.defineProperty({...value},'transport',{enumerable:true,get(){reads++;return value.transport;}}),
    new Proxy(value,{get(){reads++;throw Error('Never inspect a proxy.');}})])
    assert.throws(()=>f.incarnation.bindAppConversation(bad as never),refused);
  assert.equal(reads,0);assert.equal(f.incarnation.status().sealed,false);
  assert.throws(()=>f.incarnation.seal({...f.seal,provider:'claude-code'} as never),refused);
  f.incarnation.bindAppConversation(value);const actor=f.registry.capture(f.token,'read');
  assert.throws(()=>f.incarnation.bindAppConversation({...value,transport:{...value.transport,incarnationId:'different-process'}}),refused);
  assert.equal(f.incarnation.status().retired,true);assert.throws(()=>assertNativeAssetActor(actor,'read'),refused);
});
test('an app binding cannot replace an exact Codex acknowledgement',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');
  assert.throws(()=>f.incarnation.bindAppConversation(appBinding('arcane')),refused);
  assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);assert.equal(f.incarnation.status().retired,true);
});

test('stage claims require whole bounded job IDs and retain per-operation/per-job one-use ownership',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');
  const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
  for(const value of [first+'\n',first+'\r\n',first+'\u2028',first+'\0','../job',''])
    for(const check of [assertNativeAssetStageOperationAvailable,claimNativeAssetStageOperation])assert.throws(()=>check(actor,value),refused);
  assertNativeAssetStageOperationAvailable(actor,first);assertNativeAssetStageOperationAvailable(actor,first);
  claimNativeAssetStageOperation(actor,first);
  for(const check of [assertNativeAssetStageOperationAvailable,claimNativeAssetStageOperation])
    assert.throws(()=>check(f.registry.capture(f.token,'mutate'),first),refused);
  assertNativeAssetStageOperationAvailable(actor,second);claimNativeAssetStageOperation(actor,second);
  f.incarnation.ended('intent-a');f.incarnation.dispatched({...f.bound,operationId:'intent-b'});
  assert.throws(()=>claimNativeAssetStageOperation(actor,first),refused);
  assert.doesNotThrow(()=>claimNativeAssetStageOperation(f.registry.capture(f.token,'mutate'),first));
});

test('new native key is private, unbound and admits no operation or generic classification',t=>{
  const f=fixture(t);assert.match(f.token,/^[a-f0-9]{64}$/);assert.equal(f.registry.recognizes(f.token),false);
  for(const op of ['read','mutate'] as const)assert.throws(()=>f.registry.capture(f.token,op),refused);
  for(const value of [f.incarnation,f.registry,f.incarnation.status()])assert.equal(JSON.stringify(value).includes(f.token),false);
});

test('human next-intent grant opens only the actual dispatched operation and never upgrades old captures',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);const old=f.registry.capture(f.token,'read');
  f.incarnation.dispatched({...f.bound,operationId:'ungranted'});assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);f.incarnation.ended('ungranted');
  f.incarnation.grantNextIntent({...f.bound,sessionId:null});assert.equal(f.incarnation.status().granted,false);
  assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
  f.incarnation.dispatched({...f.bound,operationId:'human-send'});const actor=f.registry.capture(f.token,'mutate');
  assert.equal(f.incarnation.status().granted,true);assert.throws(()=>assertNativeAssetActor(old,'mutate'),refused);
  f.incarnation.ended('ungranted');assert.doesNotThrow(()=>assertNativeAssetActor(actor,'mutate'));
  f.incarnation.ended('human-send');assert.equal(f.incarnation.status().granted,false);assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);
  f.incarnation.dispatched({...f.bound,operationId:'later-no-send'});assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
});

test('late old end cannot clear a newly armed or active human Send grant',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);
  for(const id of ['first','second']){
    f.incarnation.grantNextIntent({...f.bound,sessionId:null});
    if(id==='second')f.incarnation.ended('first');
    f.incarnation.dispatched({...f.bound,operationId:id});const actor=f.registry.capture(f.token,'mutate');
    f.incarnation.ended('old');assert.doesNotThrow(()=>assertNativeAssetActor(actor,'mutate'));
    if(id==='second'){f.incarnation.ended('first');assert.doesNotThrow(()=>assertNativeAssetActor(actor,'mutate'));}
    f.incarnation.ended(id);assert.equal(f.incarnation.status().granted,false);
  }
});

test('manual persistent grant survives the exact automatic intent ending',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);f.incarnation.grant(f.bound);f.incarnation.grantNextIntent({...f.bound,sessionId:null});
  f.incarnation.dispatched({...f.bound,operationId:'mixed'});f.incarnation.ended('mixed');
  assert.equal(f.incarnation.status().granted,true);assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
  f.incarnation.dispatched({...f.bound,operationId:'manual-next'});assert.doesNotThrow(()=>f.registry.capture(f.token,'mutate'));
});

test('next-intent grant is exact host/session data; failed dispatch and revoke cannot lend it to another start',t=>{
  const f=fixture(t);f.incarnation.seal({...f.seal,sessionId:'exact-session'});const valid={...f.bound,sessionId:'exact-session'};let reads=0;
  for(const bad of [{...valid,sessionId:null},{...valid,sessionId:'foreign'},{...valid,threadId:'foreign'},{...valid,connectionId:'foreign'},{...valid,allowAssets:true},
    Object.defineProperty({...valid},'sessionId',{enumerable:true,get(){reads++;return 'exact-session';}})])
    assert.throws(()=>f.incarnation.grantNextIntent(bad as never),refused);
  assert.equal(reads,0);f.incarnation.grantNextIntent(valid);
  assert.throws(()=>f.incarnation.dispatched({...f.bound,operationId:'bad\n'}),refused);
  f.incarnation.dispatched({...f.bound,operationId:'after-failure'});assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);f.incarnation.ended('after-failure');
  f.incarnation.grantNextIntent(valid);f.incarnation.revokeGrant();f.incarnation.dispatched({...f.bound,operationId:'after-revoke'});
  assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
});
test('host seal grants readonly association scope only; mutation needs separate human grant AND local dispatch',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);assert.equal(f.registry.recognizes(f.token),true);
  const actor=f.registry.capture(f.token,'read');assert.deepEqual(nativeAssetActorScope(actor).conversation,{provider:'codex',threadId:'thread-a',sessionId:null});
  assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);f.incarnation.grant(f.bound);assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
  f.incarnation.dispatched({...f.bound,operationId:'intent-a'});assert.doesNotThrow(()=>assertNativeAssetActor(f.registry.capture(f.token,'mutate'),'mutate'));
});
test('a read capture cannot become a mutation capture after a later grant',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);const actor=f.registry.capture(f.token,'read');f.incarnation.grant(f.bound);f.incarnation.dispatched({...f.bound,operationId:'intent-a'});
  assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);
  const freshRead=f.registry.capture(f.token,'read');assert.throws(()=>assertNativeAssetActor(freshRead,'mutate'),refused);
});
test('opaque actor cannot be forged, cloned, inherited, proxied or restored from JSON',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');let reads=0;
  const getter=Object.defineProperty({},'kind',{get(){reads++;return 'native-asset-actor';}});
  for(const value of [{kind:'native-asset-actor'},JSON.parse(JSON.stringify(actor)),{...actor},Object.create(actor),getter,new Proxy(actor,{get(){reads++;throw Error('never');}}),null,()=>actor]){
    assert.throws(()=>assertNativeAssetActor(value as NativeAssetActor,'read'),refused);
  }
  assert.equal(reads,0);assert.ok(Object.isFrozen(actor));
});
test('captured scope is deeply frozen and exact project/thread/session, with no credential',t=>{
  const f=fixture(t);f.ready();const scope=nativeAssetActorScope(f.registry.capture(f.token,'mutate'));
  assert.equal(scope.projectPath,f.directory);assert.match(scope.projectId,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(scope)&&Object.isFrozen(scope.conversation));assert.equal(JSON.stringify(scope).includes(f.token),false);
});
test('revocation during a queued operation denies the original generation and cannot upgrade on regrant',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');f.incarnation.revokeGrant();
  assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);
  f.incarnation.grant(f.bound);f.incarnation.dispatched({...f.bound,operationId:'intent-b'});
  assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);assert.doesNotThrow(()=>assertNativeAssetActor(f.registry.capture(f.token,'mutate'),'mutate'));
});
test('terminal-before-ACK closes pending admission; duplicate dispatch cannot resurrect it',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');f.incarnation.ended('intent-a');
  assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);assert.throws(()=>f.registry.capture(f.token,'mutate'),refused);assert.throws(()=>f.incarnation.dispatched({...f.bound,operationId:'intent-a'}),refused);
  f.incarnation.seal(f.seal);assert.equal(f.incarnation.status().admissionOpen,false);
});
test('late old terminal cannot close a later independently dispatched admission',t=>{
  const f=fixture(t);f.ready();f.incarnation.ended('intent-a');f.incarnation.dispatched({...f.bound,operationId:'intent-b'});const actor=f.registry.capture(f.token,'mutate');f.incarnation.ended('intent-a');assert.doesNotThrow(()=>assertNativeAssetActor(actor,'mutate'));
});
test('already-captured requests are fenced across two intents in one connection',t=>{
  const f=fixture(t);f.ready();const old=f.registry.capture(f.token,'mutate');f.incarnation.ended('intent-a');f.incarnation.dispatched({...f.bound,operationId:'intent-b'});assert.throws(()=>assertNativeAssetActor(old,'mutate'),refused);
});
test('local admission deliberately does not claim provider-originating-turn provenance',t=>{
  const f=fixture(t);f.ready();f.incarnation.ended('intent-a');f.incarnation.dispatched({...f.bound,operationId:'intent-b'});
  // A previous request delivered for the FIRST time now cannot be correlated to its
  // originating native turn by an environment credential. It has valid CHAT scope.
  const late=f.registry.capture(f.token,'mutate');assert.doesNotThrow(()=>assertNativeAssetActor(late,'mutate'));assert.equal(nativeAssetActorScope(late).conversation.threadId,'thread-a');
});
for(const changed of [{threadId:'thread-b'},{connectionId:'connection-b'},{sessionId:'session-a'}])test('a changed sealed identity permanently retires authority: '+JSON.stringify(changed),t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');assert.throws(()=>f.incarnation.seal({...f.seal,...changed}),refused);assert.throws(()=>assertNativeAssetActor(actor,'read'),refused);assert.equal(f.registry.recognizes(f.token),false);assert.throws(()=>f.incarnation.seal(f.seal),refused);
});
test('A to B to A reconnect uses distinct retired capabilities, never retargets a key',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');f.incarnation.retire();const b=f.registry.issue(),bToken=b.credential();b.seal({...f.seal,connectionId:'connection-b',threadId:'thread-b'});b.retire();const a=f.registry.issue(),aToken=a.credential();a.seal({...f.seal,connectionId:'connection-c'});assert.notEqual(aToken,f.token);assert.notEqual(aToken,bToken);assert.throws(()=>assertNativeAssetActor(actor,'read'),refused);assert.throws(()=>f.registry.capture(f.token,'read'),refused);assert.equal(nativeAssetActorScope(f.registry.capture(aToken,'read')).conversation.threadId,'thread-a');
});
test('foreign, malformed and case-changed credentials cannot acquire scope',t=>{
  const f=fixture(t);f.ready();for(const key of ['',f.token.toUpperCase(),'0'.repeat(64),'f'.repeat(63),f.token+' ',f.token+'\n'])assert.throws(()=>f.registry.capture(key,'read'),refused);
});
test('host seal and dispatch accept only exact own data, never callback getters or role claims',t=>{
  const f=fixture(t);let reads=0;const getter=Object.defineProperty({...f.seal},'threadId',{enumerable:true,get(){reads++;return 'thread-a';}});
  for(const value of [getter,{...f.seal,role:'human'},Object.create(f.seal),new Proxy(f.seal,{ownKeys(){reads++;throw Error('never');}}),{...f.seal,provider:'claude-code'},{...f.seal,sessionId:''}])assert.throws(()=>f.incarnation.seal(value as never),refused);
  assert.equal(reads,0);f.incarnation.seal(f.seal);assert.throws(()=>f.incarnation.grant({...f.bound,role:'human'} as never),refused);assert.throws(()=>f.incarnation.dispatched({...f.bound,operationId:'bad\n'}),refused);
});
test('unknown operation/foreign connection cannot open admission; duplicate concurrent start refuses',t=>{
  const f=fixture(t);f.incarnation.seal(f.seal);f.incarnation.grant(f.bound);assert.throws(()=>f.incarnation.dispatched({...f.bound,connectionId:'foreign',operationId:'intent-a'}),refused);f.incarnation.dispatched({...f.bound,operationId:'intent-a'});assert.throws(()=>f.incarnation.dispatched({...f.bound,operationId:'intent-b'}),refused);
});
test('128 incarnations and local intents are bounded without implicit recycling/reconnect',t=>{
  const f=fixture(t);for(let i=1;i<128;i++)f.registry.issue().retire();assert.throws(()=>f.registry.issue(),refused);
  f.incarnation.seal(f.seal);f.incarnation.grant(f.bound);for(let i=0;i<128;i++){f.incarnation.dispatched({...f.bound,operationId:'intent-'+i});f.incarnation.ended('intent-'+i);}assert.throws(()=>f.incarnation.dispatched({...f.bound,operationId:'intent-overflow'}),refused);
});
test('shutdown retires every admitted actor synchronously and is idempotent',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate');f.registry.close();f.registry.close();assert.throws(()=>assertNativeAssetActor(actor,'read'),refused);assert.equal(f.registry.recognizes(f.token),false);assert.throws(()=>f.registry.issue(),refused);assert.throws(()=>f.incarnation.credential(),refused);
});


test('incarnation cancellation still aborts accepted work after registry shutdown',t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate'),signal=nativeAssetOperationSignal(actor);
  f.registry.close();assert.throws(()=>assertNativeAssetActor(actor,'mutate'),refused);
  assert.doesNotThrow(()=>f.incarnation.cancelWork('incarnation'));assert.equal(signal.aborted,true);
  assert.doesNotThrow(()=>f.incarnation.cancelWork('active-operation'));assert.throws(()=>f.registry.issue(),refused);
});

test('close fences all entries when the first epoch is saturated',t=>{
 const f=fixture(t);f.incarnation.seal(f.seal);
 for(let i=1;i<65535;i++) f.incarnation.revokeGrant();
 const saturated=f.registry.capture(f.token,'read');
 const second=f.registry.issue(),token=second.credential();second.seal({...f.seal,connectionId:'connection-second'});
 const other=f.registry.capture(token,'read');
 assert.doesNotThrow(()=>f.registry.close());
 assert.throws(()=>assertNativeAssetActor(saturated,'read'),refused);
 assert.throws(()=>assertNativeAssetActor(other,'read'),refused);
 assert.equal(f.registry.recognizes(token),false);
});

test('revision claim is once per original operation and independent of its completed CPU stage',async t=>{
  const f=fixture(t);f.ready();const actor=f.registry.capture(f.token,'mutate'),job='22222222-2222-4222-8222-222222222222';
  claimNativeAssetStageOperation(actor,job);assert.doesNotThrow(()=>assertNativeAssetRevisionOperationAvailable(actor,job));claimNativeAssetRevisionOperation(actor,job);
  assert.throws(()=>claimNativeAssetRevisionOperation(actor,job),refused);assert.throws(()=>assertNativeAssetRevisionOperationAvailable(actor,job),refused);
  const lease=acquireNativeAssetWork(actor,'revision');let work=0;await lease.run(()=>{work++;});assert.equal(work,1);lease.finish('closed');
  f.incarnation.ended('intent-a');f.incarnation.dispatched({...f.bound,operationId:'intent-b'});
  assert.throws(()=>claimNativeAssetRevisionOperation(actor,job),refused);
  const fresh=f.registry.capture(f.token,'mutate');assert.doesNotThrow(()=>claimNativeAssetRevisionOperation(fresh,job));
  for(const malformed of [job+'\n','not-a-job'])assert.throws(()=>claimNativeAssetRevisionOperation(fresh,malformed),refused);
});
