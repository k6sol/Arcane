import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { SubmittedChatStore, type SubmittedChatMessage } from '../../packages/storage/src/submitted-chat-store.js';
import { CodexChat,CodexTranscript, mergeSubmittedMessages, codexMessageDetails, boundRecordedChatTranscript, readCodexState, type ChatMessage, type ChatSnapshot } from '../../apps/desktop/src/codex-chat.js';
import { ClaudeChat,mergeClaudeChatMessages, claudeMessageDetails, readClaudeChatMessage } from '../../apps/desktop/src/claude-chat.js';
import { createCodexService, type CodexHostClient } from '../../apps/daemon/src/codex-service.js';
import { CodexClientError, type Snapshot } from '../../packages/codex-client/src/types.js';

const stamp='2026-10-20T18:00:00.000Z';
const binding={threadId:'thread-A',sessionId:'session-A'};
const receipt=(extra:Partial<SubmittedChatMessage>={}):SubmittedChatMessage=>({requestId:randomUUID(),turnId:'turn-A',text:'Build a detailed rock',model:'fixture-model',effort:'low',state:'pending',createdAt:stamp,finishedAt:null,errorCode:null,contextIncluded:false,transmittedBytes:21,...extra});

test('submitted prompts survive a database reopen, preserve explicit outcomes, and never cross native session or provider scope',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-prompt-journal-'));
  const path=join(directory,'journal.sqlite');let db=new DatabaseSync(path);let store=new SubmittedChatStore(db,'project-A','codex');
  t.after(async()=>{db.close();const rel=relative(tmpdir(),directory);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(directory,{recursive:true});});
  const accepted=receipt({text:'Visible prompt',contextIncluded:true,transmittedBytes:1024});
  db.exec('BEGIN');store.put(binding,accepted);store.finish(accepted.requestId,{turnId:'turn-A',model:'fixture-model',effort:'low',state:'acknowledged',finishedAt:stamp,errorCode:null});db.exec('COMMIT');
  const pending=receipt({turnId:null,text:'Keep this unknown prompt'});store.put(binding,pending);
  const other=receipt({text:'Other session'});store.put({...binding,sessionId:'session-B'},other);
  const secret=receipt({text:'password=sample-secret Bearer private-bearer-value'});store.put(binding,secret);
  db.close();db=new DatabaseSync(path);store=new SubmittedChatStore(db,'project-A','codex');store.recoverPending(stamp);
  const transcript=store.read(binding);
  assert.equal(transcript.messages.length,3);assert.equal(transcript.earlierCount,0);
  assert.equal(transcript.messages[0]!.text,'Visible prompt');assert.equal(transcript.messages[0]!.contextIncluded,true);assert.equal(transcript.messages[0]!.transmittedBytes,1024);
  assert.equal(transcript.messages[1]!.state,'unknown');assert.equal(transcript.messages[1]!.errorCode,'DAEMON_RESTART');
  assert.doesNotMatch(transcript.messages[2]!.text,/sample-secret|private-bearer-value/);
  assert.equal(new SubmittedChatStore(db,'project-A','claude').read(binding).messages.length,0);
  assert.equal(new SubmittedChatStore(db,'project-B','codex').read(binding).messages.length,0);
  assert.equal(store.read({...binding,sessionId:null}).messages.length,0);
});

test('rolled-back prompt writes leave no receipt, and bounded reads disclose older retained prompts',()=>{
  const db=new DatabaseSync(':memory:');try{
    const store=new SubmittedChatStore(db,'project','codex'),first=receipt();
    db.exec('BEGIN');store.put(binding,first);db.exec('ROLLBACK');assert.equal(store.read(binding).messages.length,0);
    for(let index=0;index<70;index++)store.put(binding,receipt({text:'Prompt '+index}));
    const result=store.read(binding);assert.equal(result.messages.length,64);assert.equal(result.earlierCount,6);
    assert.equal(result.messages[0]!.text,'Prompt 6');assert.equal(result.messages.at(-1)!.text,'Prompt 69');
    const bytes=store.read(binding).messages.map(row=>row.text);assert.equal(bytes.length,64);
  }finally{db.close();}
});

test('a prompt remains visible after a long live tool stream evicts its transient echo',()=>{
  const transcript=new CodexTranscript(),connectionId=randomUUID(),r=receipt({state:'acknowledged',finishedAt:stamp});
  transcript.reset(connectionId);transcript.messages.push({key:r.requestId,threadId:binding.threadId,role:'human',scope:binding.threadId,text:r.text});
  const snapshot={connectionId,events:Array.from({length:200},(_,index)=>({seq:index+1,type:'delta',threadId:binding.threadId,turnId:'turn-A',itemId:'item-'+index,text:'Response fragment'})),lastEventSeq:200,droppedEvents:0} as unknown as ChatSnapshot;
  transcript.consume(snapshot);assert.equal(transcript.messages.some(row=>row.role==='human'),false);
  const merged=mergeSubmittedMessages(transcript.messages,{provider:'codex',projectPath:'project',...binding,earlierCount:0,messages:[r]});
  assert.equal(merged.filter(row=>row.role==='human').length,1);assert.equal(merged[0]!.text,r.text);
});

test('history merges receipts by exact turn identity, retaining repeated prompts and uncertain submissions',()=>{
  const one=receipt({text:'Again',state:'acknowledged'}),two=receipt({text:'Again',turnId:'turn-B',state:'acknowledged'}),unknown=receipt({text:'Again',turnId:null,state:'unknown'});
  const rows:ChatMessage[]=[{key:'thread-A\0turn-A\0native-user-A',threadId:'thread-A',role:'human',scope:'native',text:'Context plus Again'},
    {key:'thread-A\0turn-B\0native-user-B',threadId:'thread-A',role:'human',scope:'native',text:'Again'},
    {key:one.requestId,threadId:'thread-A',role:'human',scope:'optimistic',text:'Again'}];
  const merged=mergeSubmittedMessages(rows,{provider:'codex',projectPath:'project',...binding,earlierCount:0,messages:[one,two,unknown]});
  assert.equal(merged.length,3);assert.deepEqual(merged.map(row=>row.text),['Again','Again','Again']);
  assert.deepEqual(merged.map(row=>row.receipt?.requestId),[one.requestId,two.requestId,unknown.requestId]);
});

test('message details show recorded model, delivery, context bytes and error evidence rather than only identifiers',()=>{
  const r=receipt({state:'rejected',errorCode:'FRAME_LIMIT',contextIncluded:true,transmittedBytes:4096,finishedAt:stamp});
  const details=codexMessageDetails({key:r.requestId,threadId:'thread-A',role:'human',scope:'thread-A',text:r.text,receipt:r,source:'submission'},null);
  assert.match(details,/Model: fixture-model/);assert.match(details,/Reasoning: low/);assert.match(details,/Status: rejected/);assert.match(details,/Error code: FRAME_LIMIT/);
  assert.match(details,/4096 UTF-8 bytes/);assert.match(details,/Shared conversation context: Included/);
  const absent=codexMessageDetails({key:'thread-A\0turn-A\0item',threadId:'thread-A',role:'codex',scope:'scope',text:'Reply'},null);
  assert.match(absent,/Model: Not reported/);
});

test('late Claude history reconciles exact IDs and keeps newer live messages and terminal metadata',()=>{
  const delivery={model:'sonnet',effort:'low',turnId:'turn-A',startedAt:stamp,finishedAt:stamp,state:'completed' as const,error:null,contextIncluded:true,transmittedBytes:128};
  const saved={id:'user-A',role:'user' as const,text:'Prompt',at:stamp,delivery};
  const merged=mergeClaudeChatMessages([saved],[{...saved,delivery:{...delivery,finishedAt:null,state:'accepted'}},{id:'reply-A',role:'assistant',text:'New reply',at:stamp}]);
  assert.equal(merged.length,2);assert.equal(merged[0]!.delivery?.state,'completed');assert.equal(merged[1]!.text,'New reply');
  const restored=readClaudeChatMessage(saved)!;assert.equal(restored.delivery?.model,'sonnet');assert.match(claudeMessageDetails(restored,'Claude','conversation-A'),/Shared conversation context: Included/);
});

test('portable transcript excludes secrets and explicitly counts text outside its bounded window',()=>{
  const result=boundRecordedChatTranscript({provider:'codex',projectPath:'project',conversationId:'thread',sessionId:null,earlierCount:5,
    messages:Array.from({length:300},(_,index)=>({id:String(index),role:'user' as const,text:'password=sample-secret '+index,source:'submission' as const,at:stamp,model:null}))});
  assert.equal(result.messages.length,256);assert.equal(result.earlierCount,49);assert.doesNotMatch(JSON.stringify(result),/sample-secret/);
});

test('host send validators keep native context and visible text distinct and reject malformed display fields',()=>{
  const require=createRequire(join(process.cwd(),'package.json'));
  const claude=require(join(process.cwd(),'apps/desktop/electron/claude-chat.cjs')) as {sendInput(value:unknown):{text:string;displayText?:string}};
  const arcane=require(join(process.cwd(),'apps/desktop/electron/arcane-chat.cjs')) as typeof claude;
  for(const [host,input] of [[claude,{conversationId:null,text:'Shared context\n\nVisible prompt',displayText:'Visible prompt',model:'sonnet',effort:'low'}],
    [arcane,{conversationId:null,text:'Shared context\n\nVisible prompt',displayText:'Visible prompt',model:'fixture/model',effort:'standard'}]] as const){
    const read=host.sendInput(input);assert.equal(read.displayText,'Visible prompt');assert.match(read.text,/Shared context/);
    assert.throws(()=>host.sendInput({...input,displayText:42}));assert.throws(()=>host.sendInput({...input,displayText:''}));
    assert.throws(()=>host.sendInput({...input,displayText:'a'.repeat(100001)}));
  }
});

test('the service journals the visible prompt before dispatch, commits its exact outcome, and restores it without a provider call',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-send-receipt-')),projectPath=join(directory,'project');await mkdir(projectPath);
  const snapshot:Snapshot={connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,
    account:{auth:'subscription',requiresOpenaiAuth:true,plan:'fixture'},models:[{model:'fixture-model',id:'fixture-id',displayName:'Fixture model',efforts:['low'],defaultEffort:'low',entitlement:'unverified'}],
    selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
  let release!:()=>void,dispatched!:()=>void,mode:'success'|'unknown'|'rejected'='success',calls=0,sequence=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{dispatched=resolve;});
  const client:CodexHostClient={snapshot:()=>structuredClone(snapshot),
    selectModel:input=>{snapshot.selection={model:input.model,effort:input.effort};return structuredClone(snapshot.selection);},
    startThread:async()=>{snapshot.thread={threadId:binding.threadId,sessionId:binding.sessionId,selection:{...snapshot.selection!},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};return structuredClone(snapshot.thread);},
    resumeThread:async()=>structuredClone(snapshot.thread!),grantThreadWrites:()=>structuredClone(snapshot.thread!),revokeThreadWrites:()=>{},respondApproval:()=>{},interruptTurn:async()=>{},close:async()=>{snapshot.connected=false;},
    startTurn:async input=>{calls++;assert.equal(input.text,mode==='success'?'Shared context\n\nVisible prompt':'Later prompt');
      if(mode==='success'){dispatched();await gate;}else throw new CodexClientError('FIXTURE_FAILURE','Synthetic failure',mode==='unknown');
      snapshot.thread!.turnId='turn-'+(++sequence);snapshot.thread!.turnStatus='inProgress';return structuredClone(snapshot.thread!);}};
  const options={directory:join(directory,'state'),projectPath,connect:async()=>client};let service=createCodexService(options);
  t.after(async()=>{release();await service.close();const rel=relative(tmpdir(),directory);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(directory,{recursive:true});});
  const action=(name:string,fields:Record<string,unknown>={})=>service.action({requestId:randomUUID(),connectionId:name==='connect'?null:snapshot.connectionId,action:name,...fields});
  await action('connect');await action('select',{model:'fixture-model',effort:'low'});await action('thread-start');
  const sending=action('turn-start',{threadId:binding.threadId,text:'Shared context\n\nVisible prompt',displayText:'Visible prompt'});await started;
  const pending=service.state().submittedMessages!;assert.equal(pending.messages[0]!.state,'pending');assert.equal(pending.messages[0]!.text,'Visible prompt');assert.equal(calls,1);
  assert.doesNotThrow(()=>readCodexState(service.state()));release();const result=await sending;
  assert.equal(result.state.submittedMessages!.messages[0]!.state,'acknowledged');assert.equal(result.state.submittedMessages!.messages[0]!.turnId,'turn-1');
  for(const failure of ['unknown','rejected'] as const){mode=failure;snapshot.thread!.turnStatus='idle';const failed=await action('turn-start',{threadId:binding.threadId,text:'Later prompt'});assert.equal(failed.record.state,failure);}
  const before=calls;await service.close();service=createCodexService({...options,connect:async()=>{assert.fail('Reading receipts never reconnects a provider');}});
  const restored=service.state();assert.equal(calls,before);assert.equal(restored.snapshot,null);assert.equal(restored.submittedMessages!.messages.length,3);
  assert.deepEqual(restored.submittedMessages!.messages.map(row=>row.state),['acknowledged','unknown','rejected']);assert.doesNotThrow(()=>readCodexState(restored));
});

test('explicit draft metadata distinguishes a hydrated local draft from a null or loading native identity',()=>{
  // Presentation-only metadata fixtures. These objects do not implement any transport, grant or send methods.
  let tab:{kind:'draft'|'native';projectPath:string}|null=null,persistence='native';
  const codex={stopped:false,state:{projectPath:'project'},tabs:{active:()=>tab,persistenceStatus:()=>persistence}} as unknown as CodexChat;
  assert.equal(CodexChat.prototype.isDraftConversation.call(codex),false);
  tab={kind:'native',projectPath:'project'};assert.equal(CodexChat.prototype.isDraftConversation.call(codex),false);
  tab={kind:'draft',projectPath:'project'};assert.equal(CodexChat.prototype.isDraftConversation.call(codex),true);
  persistence='native-loading';assert.equal(CodexChat.prototype.isDraftConversation.call(codex),false);
  persistence='native-error';assert.equal(CodexChat.prototype.isDraftConversation.call(codex),false);
  persistence='native';tab.projectPath='another-project';assert.equal(CodexChat.prototype.isDraftConversation.call(codex),false);
  let claudeTab:{key:string;conversationId:string|null}|null=null;
  const claude={nativeDisposed:false,nativeHydrating:false,loading:false,turn:null,activeTab:()=>claudeTab};
  const draft=()=>ClaudeChat.prototype.isDraftConversation.call(claude as unknown as ClaudeChat);
  assert.equal(draft(),false);claudeTab={key:'local-draft',conversationId:null};assert.equal(draft(),true);
  claude.nativeHydrating=true;assert.equal(draft(),false);claude.nativeHydrating=false;
  claude.loading=true;assert.equal(draft(),false);claude.loading=false;
  claudeTab.conversationId='native-conversation';assert.equal(draft(),false);
});
