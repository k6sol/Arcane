import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedConversations,type SharedConversationPeer} from '../../apps/desktop/src/shared-conversations.js';
import {ConversationLibrary,type LibraryTranscript,type ConversationLibrarySnapshot} from '../../apps/desktop/src/conversation-library.js';
const project='C:/Project';
class Peer implements SharedConversationPeer {
  value:LibraryTranscript;hook:((draft:string)=>string|Promise<string>)|null=null;listeners=new Set<()=>void>();opens:string[]=[];refuse=false;notice='';draft=false;
  constructor(provider:'codex'|'claude',conversationId:string|null){this.value={provider,projectPath:project,conversationId,sessionId:null,messages:[]};this.draft=conversationId===null;}
  recordedTranscript(){return structuredClone(this.value);}
  isDraftConversation(){return this.draft;}
  subscribeTranscriptChange(f:()=>void){this.listeners.add(f);return()=>{this.listeners.delete(f);};}
  setBeforeMessageSubmit(h:Peer['hook']){this.hook=h;}
  showConversationNotice(s:string){this.notice=s;}
  async open(id:string){this.opens.push(id);if(this.refuse)return false;this.value.conversationId=id;this.draft=false;return true;}
  async newChat(){if(this.refuse)return false;this.value.conversationId=null;this.value.messages=[];this.draft=true;return true;}
  message(id:string,text:string){if(this.value.conversationId)this.draft=false;this.value.messages.push({id,role:'user',text,at:new Date(1792497600000+this.value.messages.length*1000).toISOString(),model:null});for(const f of this.listeners)f();}
}
const settle=()=>new Promise<void>(r=>setImmediate(r));
function fixture(initial?:ConversationLibrarySnapshot){
  let provider:'codex'|'claude'='codex',saved:ConversationLibrarySnapshot|null=initial??null,fail=false;
  const codex=new Peer('codex','thread-1'),claude=new Peer('claude','unrelated-claude');codex.message('user-1','Build a forest');
  const bridge={version:1 as const,read:async()=>({available:true,projectPath:project,preferences:saved}),save:async(s:ConversationLibrarySnapshot)=>{if(fail)throw Error('Fixture unavailable');saved=structuredClone(s);return{saved:true};}};
  const doc={getElementById:()=>null,defaultView:null} as unknown as Document;
  const controller=new SharedConversations(doc,{bridge,provider:()=>provider,requestProvider:p=>{if(p==='arcane')return false;provider=p;return true;},peers:{codex,claude}});
  return{controller,codex,claude,setProvider:(p:'codex'|'claude')=>{provider=p;},saved:()=>saved,setFail:(v:boolean)=>{fail=v;}};
}
test('an explicit provider switch keeps one chat, supplies new context and resumes the original native thread',async t=>{
  const f=fixture();t.after(()=>f.controller.cleanup());await settle();
  assert.equal(await f.controller.beforeProviderSwitch('codex','claude'),true);f.setProvider('claude');
  assert.equal(f.claude.value.conversationId,null,'an unrelated Claude chat is not reused');
  assert.match(await f.claude.hook!('Add a cave'),/Build a forest/);
  f.claude.value.conversationId='claude-shared';f.claude.message('user-2','Add a cave');await settle();await f.controller.prepareForRestart();
  assert.equal(f.saved()!.conversations.length,1);assert.equal(f.saved()!.conversations[0]!.bindings.length,2);
  assert.equal(await f.controller.beforeProviderSwitch('claude','codex'),true);f.setProvider('codex');
  const back=await f.codex.hook!('Review the cave');assert.match(back,/Add a cave/);assert.doesNotMatch(back,/Build a forest/);
});
test('a refused switch keeps the current conversation and never sends or adopts the target history',async t=>{
  const f=fixture();t.after(()=>f.controller.cleanup());await settle();await f.controller.prepareForRestart();const before=f.saved();f.claude.refuse=true;
  assert.equal(await f.controller.beforeProviderSwitch('codex','claude'),false);await f.controller.prepareForRestart();
  assert.deepEqual(f.saved(),before);assert.equal(f.claude.value.conversationId,'unrelated-claude');assert.equal(f.codex.value.conversationId,'thread-1');
});
test('starting an unrelated new draft does not inherit previous shared context',async t=>{
  const library=new ConversationLibrary(project);library.observe({provider:'codex',projectPath:project,conversationId:'thread-1',sessionId:null,messages:[{id:'old',role:'user',text:'Old task',at:null,model:null}]});library.observe({provider:'claude',projectPath:project,conversationId:'claude-shared',sessionId:null,messages:[{id:'other',role:'user',text:'Another provider reply',at:null,model:null}]},true);
  const f=fixture(library.snapshot());t.after(()=>f.controller.cleanup());await settle();await f.codex.newChat();
  assert.equal(await f.codex.hook!('A separate task'),'A separate task');await f.controller.prepareForRestart();assert.equal(f.saved()!.conversations.length,2);
});
test('failed history persistence stays pending and an explicit retry checkpoints the same saved messages',async t=>{
  const f=fixture();t.after(()=>f.controller.cleanup());await settle();f.setFail(true);await assert.rejects(f.controller.prepareForRestart(),/could not be saved/);assert.equal(f.saved(),null);
  f.setFail(false);await f.controller.prepareForRestart();assert.equal(f.saved()!.conversations[0]!.messages[0]!.text,'Build a forest');
});
test('temporarily unknown native identity does not create a new conversation or discard its shared history',async t=>{
  const f=fixture();t.after(()=>f.controller.cleanup());await settle();await f.controller.prepareForRestart();const before=f.saved();
  f.codex.value.conversationId=null;for(const listener of f.codex.listeners)listener();await settle();await f.controller.prepareForRestart();
  assert.deepEqual(f.saved(),before);assert.equal(await f.codex.hook!('Continue'),'Continue');
});
