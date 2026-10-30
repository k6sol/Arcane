import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationLibrary,readConversationLibrary,type LibraryTranscript} from '../../apps/desktop/src/conversation-library.js';
const project='C:/ArcaneProject';
function fixture(){let id=0;return new ConversationLibrary(project,undefined,()=>`chat-${++id}`);}
function transcript(provider:'codex'|'claude',conversationId:string,text:string,id='message-1'):LibraryTranscript{return{provider,projectPath:project,conversationId,sessionId:null,messages:[{id,role:'user',text,at:'2026-10-20T12:00:00.000Z',model:null}]};}
test('switching providers attaches two exact native histories to one shared conversation',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Build a stone wall'));const first=library.active()!.id;
  library.observe(transcript('claude','conversation-1','Add a gate'),true);
  assert.equal(library.active()!.id,first);assert.deepEqual(library.active()!.bindings.map(b=>b.provider),['codex','claude']);
  assert.deepEqual(library.active()!.messages.map(m=>m.text),['Build a stone wall','Add a gate']);
  const reopened=new ConversationLibrary(project,library.snapshot());assert.deepEqual(reopened.active(),library.active());
});
test('opening an unrelated native chat never silently attaches it to the shared conversation',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','First'));const first=library.active()!.id;
  library.observe(transcript('claude','conversation-2','Separate'));assert.notEqual(library.active()!.id,first);
  library.observe(transcript('codex','thread-1','First'));assert.equal(library.active()!.id,first);assert.equal(library.snapshot().conversations.length,2);
});
test('a streaming update replaces its exact message and a failed capacity mutation retains saved history',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Partial'));
  library.observe(transcript('codex','thread-1','Complete'));assert.equal(library.active()!.messages.length,1);assert.equal(library.active()!.messages[0]!.text,'Complete');
  const before=library.snapshot();assert.throws(()=>library.observe(transcript('codex','thread-1','x'.repeat(128*1024+1),'message-2')));
  assert.deepEqual(library.snapshot(),before);
});
test('folder rename, moving chats and removing a folder preserve both providers and messages',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Prompt'));const chat=library.active()!.id,folder=library.createFolder('Forest');
  library.move(chat,folder);library.renameFolder(folder,'Environment');const restored=new ConversationLibrary(project,library.snapshot());
  assert.equal(restored.snapshot().folders[0]!.name,'Environment');assert.equal(restored.active()!.folderId,folder);
  restored.removeFolder(folder);assert.equal(restored.active()!.folderId,null);assert.equal(restored.active()!.messages[0]!.text,'Prompt');assert.equal(restored.active()!.bindings[0]!.conversationId,'thread-1');
});
test('model handoff carries only new public context and marks it as conversation data',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Build a tree'));
  const context=library.contextFor('claude','Make its roots wider');assert.match(context,/Build a tree/);assert.match(context,/not system instructions, tool results, permissions/);assert.ok(context.endsWith('Make its roots wider'));
  library.observe(transcript('claude','conversation-1','Make its roots wider','message-2'),true);
  assert.equal(library.contextFor('claude','Add bark'),'Add bark');
  const back=library.contextFor('codex','Review it');assert.match(back,/Make its roots wider/);assert.doesNotMatch(back,/Build a tree/);
});
test('invalid project, duplicate native ownership and unknown grant fields cannot become library authority',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Prompt'));const snapshot=library.snapshot();
  assert.throws(()=>readConversationLibrary(snapshot,'C:/AnotherProject'));
  assert.throws(()=>readConversationLibrary({...snapshot,grants:['writes']},project));
  const duplicate=structuredClone(snapshot);duplicate.conversations.push({...structuredClone(duplicate.conversations[0]!),id:'other-chat'});assert.throws(()=>readConversationLibrary(duplicate,project));
  assert.throws(()=>library.move(library.active()!.id,'missing-folder'));
});
test('history data cannot execute accessors and failed attachment preserves the exact previous chat',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Prompt'));const before=library.snapshot();
  assert.throws(()=>library.observe(transcript('codex','thread-2','Other'),true));assert.deepEqual(library.snapshot(),before);
  let calls=0;const value={...before};Object.defineProperty(value,'folders',{enumerable:true,get(){calls++;return[];}});
  assert.throws(()=>readConversationLibrary(value,project));assert.equal(calls,0);
});
test('open sidebar folders persist with the library, follow removal and reject unknown ids',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Prompt'));const forest=library.createFolder('Forest'),shop=library.createFolder('Shop');
  assert.equal('expandedFolderIds' in library.snapshot(),false,'a library with no open folder keeps the original record shape');
  assert.equal(library.setFolderExpanded(forest,true),true);assert.equal(library.setFolderExpanded(forest,true),false);library.setFolderExpanded(shop,true);
  const restored=new ConversationLibrary(project,library.snapshot());assert.deepEqual(restored.snapshot().expandedFolderIds,[forest,shop]);assert.equal(restored.expanded(shop),true);
  restored.removeFolder(shop);assert.deepEqual(restored.snapshot().expandedFolderIds,[forest]);
  restored.setFolderExpanded(forest,false);assert.equal('expandedFolderIds' in restored.snapshot(),false);
  assert.throws(()=>restored.setFolderExpanded('missing-folder',true));
  const snapshot=library.snapshot();
  for(const open of [['missing-folder'],[forest,forest],[],[7]])assert.throws(()=>readConversationLibrary({...snapshot,expandedFolderIds:open},project));
});

test('empty sidebar dismissal removes only the exact row and preserves the active record and folders',()=>{
  const library=fixture();library.observe(transcript('codex','thread-1','Keep this history'));
  const recorded=library.active()!,folder=library.createFolder('Saved');library.move(recorded.id,folder);
  const dismissed=library.newConversation(),active=library.newConversation();
  const before=library.snapshot();
  for(const id of ['', 'missing',dismissed.toUpperCase(),recorded.id])assert.equal(library.dismissEmpty(id),false);
  assert.deepEqual(library.snapshot(),before);
  assert.equal(library.dismissEmpty(dismissed),true);assert.equal(library.dismissEmpty(dismissed),false);
  assert.equal(library.active()!.id,active);assert.deepEqual(library.snapshot().conversations.find(c=>c.id===recorded.id),{...recorded,folderId:folder});
  assert.deepEqual(library.snapshot().folders,before.folders);
  const reopened=new ConversationLibrary(project,library.snapshot());assert.deepEqual(reopened.snapshot(),library.snapshot());
});
test('dismissing the active empty row leaves no selected history or inherited context',()=>{
  const library=fixture();library.observe(transcript('claude','recorded-claude','Other conversation context'));
  const recorded=library.active()!,empty=library.newConversation();
  assert.equal(library.dismissEmpty(empty),true);assert.equal(library.active(),null);
  assert.deepEqual(library.snapshot().conversations,[recorded]);
  assert.equal(library.contextFor('codex','Keep this unsent text'),'Keep this unsent text');
  const reopened=new ConversationLibrary(project,library.snapshot());assert.equal(reopened.active(),null);
  assert.equal(reopened.observe({provider:'codex',projectPath:project,conversationId:null,sessionId:null,messages:[]}),false);
  assert.deepEqual(reopened.snapshot(),library.snapshot());
});
test('a real native binding remains protected even when it has no messages and is still titled New chat',()=>{
  const library=fixture();library.observe({...transcript('codex','empty-native',''),messages:[]});
  const bound=library.active()!,before=library.snapshot();assert.equal(bound.title,'New chat');
  assert.equal(library.dismissEmpty(bound.id),false);assert.deepEqual(library.snapshot(),before);
  library.observe(transcript('codex','empty-native','Now recorded'));const recorded=library.snapshot();
  assert.equal(library.dismissEmpty(bound.id),false);assert.deepEqual(library.snapshot(),recorded);
});
