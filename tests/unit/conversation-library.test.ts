import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationLibrary,readConversationLibrary,type LibraryTranscript,type LibraryDraftSource,type ConversationLibrarySnapshot} from '../../apps/desktop/src/conversation-library.js';
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

test('first native send binds its exact persisted draft row across reload without adding a fourth row',()=>{
  const library=fixture(),first={provider:'codex',localId:'draft:1'} as const,second={provider:'codex',localId:'draft:2'} as const,third={provider:'codex',localId:'draft:3'} as const;
  const ids=[library.newConversation(first),library.newConversation(second),library.newConversation(third)];
  const folder=library.createFolder('Trees');library.move(ids[2]!,folder);
  const restored=new ConversationLibrary(project,library.snapshot());
  assert.equal(restored.draftConversation(third)!.id,ids[2]);
  assert.equal(restored.observe(transcript('codex','native-third','Exact third prompt'),false,third),true);
  const result=restored.snapshot();assert.deepEqual(result.conversations.map(c=>c.id),ids);assert.equal(result.activeId,ids[2]);
  assert.equal(result.conversations[2]!.folderId,folder);assert.equal(result.conversations[2]!.messages[0]!.text,'Exact third prompt');
  assert.deepEqual(result.draftLinks?.map(link=>link.localId),['draft:1','draft:2']);
  assert.equal(restored.draftConversation(third),null);assert.equal(restored.draftConversation(first)!.id,ids[0]);
  // The source owns its original row even after another empty row is selected.
  restored.observe(transcript('codex','native-first','First draft late acknowledgement'),false,first);
  assert.equal(restored.active()!.id,ids[0]);assert.equal(restored.snapshot().conversations.length,3);
});

test('native binding wins over a different linked draft and source presence never falls back to the active row',()=>{
  const library=fixture();library.observe(transcript('codex','known-native','Original'));
  const known=library.active()!.id,source={provider:'codex',localId:'draft:linked'} as const,empty=library.newConversation(source);
  library.observe(transcript('codex','known-native','Updated'),true,source);
  assert.equal(library.active()!.id,known);assert.equal(library.draftConversation(source)!.id,empty);
  assert.equal(library.snapshot().conversations.length,2);
  library.observe(transcript('codex','known-native','Native binding still wins'),false,{provider:'claude',localId:'irrelevant-provider-draft'});
  assert.equal(library.active()!.id,known);assert.equal(library.draftConversation(source)!.id,empty);
  library.select(empty);library.observe(transcript('codex','unrelated-native','Separate history'),true,{provider:'codex',localId:'draft:unlinked'});
  assert.notEqual(library.active()!.id,empty);assert.equal(library.draftConversation(source)!.id,empty);
  assert.equal(library.snapshot().conversations.find(c=>c.id===empty)!.bindings.length,0);
});

test('draft link mutations reject collisions and malformed sources atomically and return detached row copies',()=>{
  const library=fixture(),source:LibraryDraftSource={provider:'codex',localId:'draft:one'},first=library.newConversation(source),second=library.newConversation();
  source.localId='late-caller-mutation';
  const stable={provider:'codex',localId:'draft:one'} as const;
  assert.equal(library.draftConversation(stable)!.id,first);
  library.linkDraft(first,stable);const before=library.snapshot();
  for(const action of[()=>library.linkDraft(second,stable),()=>library.linkDraft(first,{provider:'codex',localId:'other'}),()=>library.linkDraft('missing',stable),()=>library.newConversation(stable)]){
    assert.throws(action);assert.deepEqual(library.snapshot(),before);
  }
  for(const invalid of[{provider:'other',localId:'draft:one'},{provider:'codex',localId:'bad\n'},{provider:'codex',localId:'x'.repeat(129)},{provider:'codex',localId:'draft:one',libraryId:first}]){
    assert.throws(()=>library.linkDraft(second,invalid as LibraryDraftSource));assert.deepEqual(library.snapshot(),before);
  }
  let calls=0;const getter={provider:'codex',get localId(){calls++;return'draft:getter';}};
  assert.throws(()=>library.newConversation(getter as LibraryDraftSource));assert.equal(calls,0);assert.deepEqual(library.snapshot(),before);
  const copy=library.draftConversation(stable)!;copy.title='Changed copy';assert.equal(library.draftConversation(stable)!.title,'New chat');
});

test('binding prunes only its provider draft link, dismissal prunes all row links, and empty metadata is omitted',()=>{
  const library=fixture(),codex={provider:'codex',localId:'draft:codex'} as const,claude={provider:'claude',localId:'draft:claude'} as const,row=library.newConversation(codex);
  library.linkDraft(row,claude);library.observe(transcript('codex','bound-codex','Codex text'),false,codex);
  assert.deepEqual(library.snapshot().draftLinks,[{...claude,libraryId:row}]);
  assert.throws(()=>library.linkDraft(row,codex));assert.equal(library.dismissEmpty(row),false);
  library.observe(transcript('claude','bound-claude','Claude text'),false,claude);assert.equal(Object.hasOwn(library.snapshot(),'draftLinks'),false);
  const empty=library.newConversation({provider:'codex',localId:'discarded'});library.linkDraft(empty,{provider:'claude',localId:'discarded'});
  assert.equal(library.dismissEmpty(empty),true);assert.equal(Object.hasOwn(library.snapshot(),'draftLinks'),false);
  library.observe(transcript('codex','late-native','Retain real native history'),true,{provider:'codex',localId:'discarded'});
  assert.ok(library.snapshot().conversations.every(c=>c.id!==empty),'a stale acknowledgement cannot recreate the dismissed row');
});

test('draft source observation cannot cross unknown or foreign project scope or mismatched provider',()=>{
  const library=fixture(),source={provider:'codex',localId:'scoped-draft'} as const;library.newConversation(source);const before=library.snapshot();
  for(const projectPath of[null,'C:/OtherProject'])assert.equal(library.observe({...transcript('codex','foreign-native','Foreign'),projectPath},false,source),false);
  assert.throws(()=>library.observe(transcript('claude','wrong-provider','Wrong provider'),false,source));assert.deepEqual(library.snapshot(),before);
  assert.throws(()=>new ConversationLibrary('C:/OtherProject',before));
  assert.equal(library.observe({...transcript('codex','native','Correct'),conversationId:null},false,source),false);assert.deepEqual(library.snapshot(),before);
});

test('strict persisted draft links reject duplicate sources, duplicate row providers, unknown fields and invalid targets',()=>{
  const library=fixture(),source={provider:'codex',localId:'draft:one'} as const,id=library.newConversation(source),other=library.newConversation(),value=library.snapshot(),link=value.draftLinks![0]!;
  const invalid:unknown[]=[[],{},[{...link,permission:true}],[{...link,provider:'unknown'}],[{...link,localId:'bad\n'}],[{...link,localId:'x'.repeat(129)}],[{...link,libraryId:'missing'}],[link,{...link,libraryId:other}],[link,{...link,localId:'different'}]];
  for(const draftLinks of invalid)assert.throws(()=>readConversationLibrary({...value,draftLinks},project));
  const bound=structuredClone(value);bound.conversations.find(c=>c.id===id)!.bindings.push({provider:'codex',conversationId:'already-bound',sessionId:null});assert.throws(()=>readConversationLibrary(bound,project));
  let calls=0;const accessor={...value};Object.defineProperty(accessor,'draftLinks',{enumerable:true,get(){calls++;return value.draftLinks;}});assert.throws(()=>readConversationLibrary(accessor,project));assert.equal(calls,0);
  const old={...value};delete old.draftLinks;assert.equal(Object.hasOwn(readConversationLibrary(old,project),'draftLinks'),false);
});

test('the 768-link bound accepts all provider slots and failed capacity mutations preserve the original snapshot',()=>{
  const providers=['codex','claude','arcane'] as const;
  const conversations=Array.from({length:256},(_,i)=>({id:'row-'+i,title:'New chat',folderId:null,bindings:[],messages:[]}));
  const draftLinks=conversations.flatMap(row=>providers.map(provider=>({provider,localId:'draft:'+row.id,libraryId:row.id})));
  const value:ConversationLibrarySnapshot={version:1,projectPath:project,activeId:null,folders:[],conversations,draftLinks};
  assert.equal(readConversationLibrary(value,project).draftLinks!.length,768);
  assert.throws(()=>readConversationLibrary({...value,draftLinks:[...draftLinks,{provider:'codex',localId:'overflow',libraryId:'row-0'}]},project));
  const library=new ConversationLibrary(project,value,()=> 'overflow-row'),before=library.snapshot();
  assert.throws(()=>library.newConversation({provider:'codex',localId:'overflow'}));assert.deepEqual(library.snapshot(),before);
  assert.throws(()=>library.linkDraft('row-0',{provider:'codex',localId:'overflow'}));assert.deepEqual(library.snapshot(),before);
});
