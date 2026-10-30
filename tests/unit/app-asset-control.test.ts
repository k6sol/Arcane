import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppAssetControl,type AppAssetRequest,type AppAssetReply} from '../../apps/daemon/src/app-asset-control.js';
import {createNativeAssetRegistry,nativeAssetActorScope,nativeAssetOperationSignal,acquireNativeAssetWork,assertNativeModelSource} from '../../apps/daemon/src/native-asset-authority.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import type {AppAssetConversationBinding} from '../../packages/protocol/src/asset-conversation.js';
import {createAppAssetHumanSelection,type AppAssetHumanSelectionHost} from '../../apps/daemon/src/app-asset-human-selection.js';

function fixture(t:test.TestContext,humanSelection?:AppAssetHumanSelectionHost,modelSourceBinding?:(sessionId:string)=>()=>void){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'arcane-app-assets-'))),project=workflowProjectIdentity(directory),registry=createNativeAssetRegistry({projectPath:directory,...(modelSourceBinding?{modelSourceBinding}:{})});
 const control=createAppAssetControl({projectPath:directory,registry,...(humanSelection?{humanSelection}:{})}),epoch=randomUUID();let sequence=0;
 t.after(()=>{control.close();registry.close();rmSync(directory,{recursive:true,force:true});});
 function envelope(command:AppAssetRequest['command'],overrides:Partial<AppAssetRequest>={}):AppAssetRequest{return{type:'arcane-app-asset-request',protocolVersion:1,sequence:++sequence,requestId:randomUUID(),projectId:project.projectId,epoch,command,...overrides};}
 function accept(request:AppAssetRequest):AppAssetReply{const reply=control.accept(request);assert.ok(reply);return reply;}
 function send(command:AppAssetRequest['command']){return accept(envelope(command));}
 function ok(reply:AppAssetReply){assert.equal(reply.outcome,'ok');if(reply.outcome!=='ok')assert.fail();return reply.result;}
 ok(send({action:'open'}));
 function issue(provider:'claude-code'|'arcane'='claude-code'){
  const conversationId=randomUUID(),connectionId=randomUUID(),request=envelope({action:'issue',provider,conversationId,connectionId}),result=ok(accept(request));
  assert.equal(typeof result.credential,'string');const credential=result.credential!;
  const ref={issueSequence:request.sequence,issueRequestId:request.requestId};
  const binding:AppAssetConversationBinding=provider==='claude-code'?{kind:'app-conversation',provider,conversationId,connectionId,transport:{kind:'claude-code-process',incarnationId:randomUUID(),nativeSessionId:null}}:{kind:'app-conversation',provider,conversationId,connectionId,transport:{kind:'arcane-gateway-loop',incarnationId:randomUUID()}};
  return{request,credential,ref,binding};
 }
 return{directory,project,registry,control,epoch,envelope,accept,send,ok,issue};
}

test('parent human selection changes only the review scope and never binds or grants a native actor',t=>{
 const selection=createAppAssetHumanSelection({codexConversation:()=>({provider:'codex',threadId:'owned-thread',sessionId:null})});
 const f=fixture(t,selection),a=f.issue('claude-code'),conversationId=a.binding.conversationId;
 assert.throws(()=>f.registry.capture(a.credential,'read'));
 f.ok(f.send({action:'select-human',selection:{provider:'claude-code',conversationId}}));
 assert.deepEqual(selection.current(),{provider:'claude-code',threadId:'app:'+conversationId,sessionId:null});
 assert.throws(()=>f.registry.capture(a.credential,'read'),'human selection does not replace an owned transport binding');
 f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));
 assert.throws(()=>f.registry.capture(a.credential,'mutate'),'human selection does not grant a native mutation');
 const epoch=selection.epoch();f.ok(f.send({action:'select-human',selection:null}));assert.notEqual(selection.epoch(),epoch);assert.equal(selection.current(),null);
 f.ok(f.send({action:'select-human',selection:{provider:'codex'}}));assert.equal(selection.current()?.threadId,'owned-thread');
});

for(const provider of ['claude-code','arcane']as const)test(provider+' original human model-source command cannot grant a later issue or revive a retired turn',t=>{
 let grants=0;const f=fixture(t,undefined,sessionId=>{assert.equal(sessionId,'studio-a');grants++;return()=>{};}),a=f.issue(provider);
 f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));
 const command=f.envelope({action:'model-source',...a.ref,sessionId:'studio-a'});f.ok(f.accept(command));f.ok(f.accept(command));assert.equal(grants,1,'exact IPC replay returns the original receipt without regranting');
 f.ok(f.send({action:'grant-next',...a.ref}));const operationId=randomUUID();f.ok(f.send({action:'dispatched',...a.ref,operationId}));
 const actor=f.registry.capture(a.credential,'mutate');assertNativeModelSource(actor,'studio-a');
 const b=f.issue(provider);f.ok(f.send({action:'bind',...b.ref,binding:b.binding}));f.ok(f.send({action:'grant-next',...b.ref}));f.ok(f.send({action:'dispatched',...b.ref,operationId:randomUUID()}));
 assert.throws(()=>assertNativeModelSource(f.registry.capture(b.credential,'mutate'),'studio-a'));
 f.ok(f.send({action:'ended',...a.ref,operationId}));f.ok(f.send({action:'retire',...a.ref}));assert.throws(()=>assertNativeModelSource(actor,'studio-a'));
 assert.equal(f.send({action:'model-source',...a.ref,sessionId:'studio-a'}).outcome,'rejected');assert.equal(grants,1);
 const invalid=f.envelope({action:'model-source',...b.ref,sessionId:'studio-a'});
 assert.equal(f.control.accept({...invalid,command:{...invalid.command,sessionId:'studio-a\n'}}),null);
 assert.equal(f.control.accept({...invalid,command:{...invalid.command,grant:true}}),null);
 assert.equal(grants,1);
});

test('human selection retains parent project/epoch/high-water validation and refuses unavailable ports',t=>{
 const selection=createAppAssetHumanSelection({codexConversation:()=>null}),f=fixture(t,selection);
 const request=f.envelope({action:'select-human',selection:{provider:'arcane',conversationId:randomUUID()}}),before=selection.epoch();
 assert.equal(f.accept({...request,projectId:'f'.repeat(64)}).outcome,'rejected');
 assert.equal(f.accept({...request,epoch:randomUUID()}).outcome,'rejected');
 assert.equal(selection.epoch(),before);
 f.ok(f.accept(request));const selected=selection.epoch();assert.notEqual(selected,before);
 const duplicate=f.accept(request);assert.equal(duplicate.outcome,'rejected');assert.equal(selection.epoch(),selected,'spent selection is never replayed');
 const unavailable=fixture(t);assert.equal(unavailable.send({action:'select-human',selection:null}).outcome,'rejected');
 let reads=0;
 const invalid={...f.envelope({action:'select-human',selection:null}),command:{action:'select-human',selection:Object.defineProperty({},'provider',{enumerable:true,get(){reads++;return 'codex';}})}};
 assert.equal(f.control.accept(invalid),null);assert.equal(reads,0);assert.equal(selection.epoch(),selected);
});

for(const provider of ['claude-code','arcane'] as const)test(provider+' private app binding keeps actual scope and requires a separate human dispatch grant',t=>{
 const f=fixture(t),a=f.issue(provider);assert.throws(()=>f.registry.capture(a.credential,'read'));
 f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));
 assert.deepEqual(nativeAssetActorScope(f.registry.capture(a.credential,'read')).conversation,{provider,threadId:'app:'+a.binding.conversationId,sessionId:null});
 const operationId=randomUUID();f.ok(f.send({action:'dispatched',...a.ref,operationId}));assert.throws(()=>f.registry.capture(a.credential,'mutate'));
 f.ok(f.send({action:'ended',...a.ref,operationId}));f.ok(f.send({action:'grant-next',...a.ref}));
 const granted=randomUUID();f.ok(f.send({action:'dispatched',...a.ref,operationId:granted}));const actor=f.registry.capture(a.credential,'mutate'),signal=nativeAssetOperationSignal(actor);
 f.ok(f.send({action:'ended',...a.ref,operationId:granted}));assert.equal(signal.aborted,false);assert.throws(()=>f.registry.capture(a.credential,'mutate'));
 f.ok(f.send({action:'retire',...a.ref}));assert.equal(signal.aborted,false);
 f.ok(f.send({action:'cancel',...a.ref,scope:'incarnation'}));assert.equal(signal.aborted,true);
});

test('wrong project/epoch and malformed frames cannot poison the next legitimate sequence or invoke getters',t=>{
 const f=fixture(t),request=f.envelope({action:'issue',provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});let reads=0;
 const getter=Object.defineProperty({...request},'command',{enumerable:true,get(){reads++;throw Error('never read');}});
 assert.equal(f.control.accept(getter),null);assert.equal(f.control.accept(new Proxy(request,{get(){reads++;throw Error('never read');}})),null);
 assert.equal(f.accept({...request,sequence:10000,projectId:'f'.repeat(64)}).outcome,'rejected');
 assert.equal(f.accept({...request,sequence:10000,epoch:randomUUID()}).outcome,'rejected');
 assert.equal(f.control.accept({...request,sequence:10000,command:{action:'issue',provider:'arcane',conversationId:'x'.repeat(9000),connectionId:randomUUID()}}),null);
 assert.equal(reads,0);f.ok(f.accept(request));
});

test('cleanup spends missing earlier issues and sequence gaps without allocating or replaying authority',t=>{
 const f=fixture(t),missing=f.envelope({action:'issue',provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});
 const cleanup=f.envelope({action:'retire-issue',issueSequence:missing.sequence,issueRequestId:missing.requestId});f.ok(f.accept(cleanup));
 assert.deepEqual(f.accept(missing),{type:'arcane-app-asset-reply',protocolVersion:1,sequence:missing.sequence,requestId:missing.requestId,projectId:f.project.projectId,epoch:f.epoch,outcome:'rejected',code:'STALE'});
 const a=f.issue();assert.equal(f.accept({...a.request,sequence:cleanup.sequence}).outcome,'rejected');
});

test('exact cached duplicate is detached; conflicting sequence or UUID retires only its live owner',t=>{
 const f=fixture(t),a=f.issue(),b=f.issue('arcane'),first=f.accept(a.request);f.ok(first);
 if(first.outcome==='ok')first.result.credential='0'.repeat(64);
 assert.equal(f.ok(f.accept(a.request)).credential,a.credential);
 const conflict=f.accept({...a.request,requestId:randomUUID()});assert.equal(conflict.outcome,'rejected');
 assert.equal(f.accept(a.request).outcome,'rejected');
 f.ok(f.send({action:'bind',...b.ref,binding:b.binding}));
 const reused=f.envelope({action:'ended',...b.ref,operationId:randomUUID()},{requestId:b.request.requestId});assert.equal(f.accept(reused).outcome,'rejected');assert.throws(()=>f.registry.capture(b.credential,'read'));
});

test('cached receipt eviction spends old sequences without evicting live binding or imposing a cumulative command fence',t=>{
 const f=fixture(t),a=f.issue();
 for(let i=0;i<4100;i++)f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));
 const old=f.accept(a.request);assert.equal(old.outcome,'rejected');if(old.outcome==='rejected')assert.equal(old.code,'STALE');
 f.ok(f.send({action:'grant-next',...a.ref}));f.ok(f.send({action:'dispatched',...a.ref,operationId:randomUUID()}));assert.doesNotThrow(()=>f.registry.capture(a.credential,'mutate'));
});

test('conflicting provider/chat/process binding refuses and cannot replace another conversation',t=>{
 const f=fixture(t),a=f.issue(),b=f.issue('arcane');f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));f.ok(f.send({action:'bind',...b.ref,binding:b.binding}));
 const bad=f.send({action:'bind',...a.ref,binding:{...a.binding,conversationId:b.binding.conversationId}});assert.equal(bad.outcome,'rejected');assert.throws(()=>f.registry.capture(a.credential,'read'));
 assert.equal(nativeAssetActorScope(f.registry.capture(b.credential,'read')).conversation.provider,'arcane');
});

test('retire-issue cannot falsely close a bound transport; real lease closure controls compaction',t=>{
 const f=fixture(t),a=f.issue();f.ok(f.send({action:'bind',...a.ref,binding:a.binding}));f.ok(f.send({action:'grant-next',...a.ref}));f.ok(f.send({action:'dispatched',...a.ref,operationId:randomUUID()}));
 const actor=f.registry.capture(a.credential,'mutate'),lease=acquireNativeAssetWork(actor,'generation');
 assert.equal(f.send({action:'retire-issue',...a.ref}).outcome,'rejected');assert.equal(lease.signal.aborted,false);
 f.ok(f.send({action:'transport-closed',...a.ref}));assert.equal(lease.signal.aborted,false);lease.finish('closed');
 // More than128 sequential actual closures must be possible; no cumulative fence.
 for(let i=0;i<140;i++){const next=f.issue('arcane');f.ok(f.send({action:'retire-issue',...next.ref}));}
 assert.equal(f.accept(a.request).outcome,'rejected');
});

test('context pressure still admits exact unknown-issue cleanup without evicting live entries',t=>{
 const f=fixture(t),live=Array.from({length:128},()=>f.issue());
 assert.equal(f.send({action:'issue',provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()}).outcome,'rejected');
 const a=live[0]!;f.ok(f.send({action:'retire-issue',...a.ref}));assert.doesNotThrow(()=>f.issue('arcane'));
 const b=live[1]!;f.ok(f.send({action:'bind',...b.ref,binding:b.binding}));assert.doesNotThrow(()=>f.registry.capture(b.credential,'read'));
});

test('foreign registry composition is refused after exact binding and close never invents transport closure',t=>{
 const f=fixture(t),other=fixture(t),control=createAppAssetControl({projectPath:f.directory,registry:other.registry});
 f.ok(control.accept(f.envelope({action:'open'}))!);
 const request=f.envelope({action:'issue',provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()}),result=control.accept(request);assert.ok(result);f.ok(result);
 const command=request.command;assert.equal(command.action,'issue');if(command.action!=='issue')assert.fail();
 const binding:AppAssetConversationBinding={kind:'app-conversation',provider:'arcane',connectionId:command.connectionId,conversationId:command.conversationId,transport:{kind:'arcane-gateway-loop',incarnationId:randomUUID()}};
 assert.equal(control.accept(f.envelope({action:'bind',issueSequence:request.sequence,issueRequestId:request.requestId,binding}))?.outcome,'rejected');control.close();
 assert.equal(control.accept(f.envelope({action:'issue',provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()}))?.outcome,'rejected');
});
