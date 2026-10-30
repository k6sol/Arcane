import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {SharedConversations,type SharedConversationPeer} from '../../apps/desktop/src/shared-conversations.js';
import {ConversationLibrary,type LibraryTranscript,type ConversationLibrarySnapshot} from '../../apps/desktop/src/conversation-library.js';
const project='C:/Project';
class Peer implements SharedConversationPeer {
  value:LibraryTranscript;hook:((draft:string)=>string|Promise<string>)|null=null;listeners=new Set<()=>void>();opens:string[]=[];refuse=false;notice='';draft=false;unsent='';newCalls=0;newChatGate:Promise<void>|null=null;
  constructor(provider:'codex'|'claude',conversationId:string|null){this.value={provider,projectPath:project,conversationId,sessionId:null,messages:[]};this.draft=conversationId===null;}
  recordedTranscript(){return structuredClone(this.value);}
  isDraftConversation(){return this.draft;}
  subscribeTranscriptChange(f:()=>void){this.listeners.add(f);return()=>{this.listeners.delete(f);};}
  setBeforeMessageSubmit(h:Peer['hook']){this.hook=h;}
  showConversationNotice(s:string){this.notice=s;}
  async open(id:string){this.opens.push(id);if(this.refuse)return false;this.value.conversationId=id;this.draft=false;return true;}
  async newChat(){this.newCalls++;if(this.refuse)return false;if(this.newChatGate)await this.newChatGate;this.value.conversationId=null;this.value.messages=[];this.draft=true;return true;}
  message(id:string,text:string){if(this.value.conversationId)this.draft=false;this.value.messages.push({id,role:'user',text,at:new Date(1792497600000+this.value.messages.length*1000).toISOString(),model:null});for(const f of this.listeners)f();}
}
const settle=()=>new Promise<void>(r=>setImmediate(r));
/** Controller DOM fixture only; native button semantics, not an installed-browser acceptance claim. */
class SidebarElement extends EventTarget {
  id='';children:SidebarElement[]=[];dataset:Record<string,string>={};className='';type='';title='';value='';hidden=false;open=false;selected=false;maxLength=0;tabIndex=0;
  private content='';private attributes=new Map<string,string>();
  constructor(readonly tagName:string,private readonly owner:SidebarDocument){super();}
  get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.content=value;this.children=[];}
  append(...children:SidebarElement[]){this.children.push(...children);}
  replaceChildren(...children:SidebarElement[]){this.content='';this.children=children;}
  setAttribute(name:string,value:string){this.attributes.set(name,value);if(name==='class')this.className=value;}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  removeAttribute(name:string){this.attributes.delete(name);}
  querySelectorAll(selector:string):SidebarElement[]{return this.children.flatMap(child=>{
    const matches=selector==='[data-library-focus]'?child.dataset.libraryFocus!==undefined:selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName===selector.toUpperCase();
    return[...(matches?[child]:[]),...child.querySelectorAll(selector)];
  });}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
  focus(_options?:unknown){this.owner.activeElement=this;}
  click(){this.dispatchEvent(new Event('click'));}
}
class SidebarInput extends SidebarElement {}
const originalInput=Object.getOwnPropertyDescriptor(globalThis,'HTMLInputElement');
Object.defineProperty(globalThis,'HTMLInputElement',{configurable:true,value:SidebarInput});
after(()=>{if(originalInput)Object.defineProperty(globalThis,'HTMLInputElement',originalInput);else Reflect.deleteProperty(globalThis,'HTMLInputElement');});
class SidebarDocument {
  activeElement:SidebarElement|null=null;defaultView=null;
  readonly mount=new SidebarElement('NAV',this);
  getElementById(id:string){return id==='conversation-library'?this.mount:null;}
  createElement(tag:string){return tag.toLowerCase()==='input'?new SidebarInput('INPUT',this):new SidebarElement(tag.toUpperCase(),this);}
  createElementNS(_namespace:string,tag:string){return this.createElement(tag);}
  asDocument(){return this as unknown as Document;}
  close(id:string){return this.mount.querySelectorAll('[data-library-focus]').find(node=>node.dataset.libraryFocus==='close-empty:'+id);}
}
function fixture(initial?:ConversationLibrarySnapshot,options:{sidebar?:SidebarDocument;drafts?:boolean}={}){
  let provider:'codex'|'claude'='codex',saved:ConversationLibrarySnapshot|null=initial??null,fail=false;
  const codex=new Peer('codex','thread-1'),claude=new Peer('claude','unrelated-claude');codex.message('user-1','Build a forest');
  if(options.drafts)for(const peer of[codex,claude]){peer.value.conversationId=null;peer.value.messages=[];peer.draft=true;}
  const bridge={version:1 as const,read:async()=>({available:true,projectPath:project,preferences:saved}),save:async(s:ConversationLibrarySnapshot)=>{if(fail)throw Error('Fixture unavailable');saved=structuredClone(s);return{saved:true};}};
  const doc=options.sidebar?.asDocument()??({getElementById:()=>null,defaultView:null} as unknown as Document),providerRequests:string[]=[];
  const controller=new SharedConversations(doc,{bridge,provider:()=>provider,requestProvider:p=>{providerRequests.push(p);if(p==='arcane')return false;provider=p;return true;},peers:{codex,claude}});
  return{controller,codex,claude,providerRequests,provider:()=>provider,setProvider:(p:'codex'|'claude')=>{provider=p;},saved:()=>saved,setFail:(v:boolean)=>{fail=v;}};
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

function emptyRows(){
  const library=new ConversationLibrary(project);
  library.observe({provider:'claude',projectPath:project,conversationId:'recorded-other',sessionId:null,messages:[{id:'earlier',role:'user',text:'Recorded other task',at:null,model:null}]});
  const recorded=library.active()!,inactive=library.newConversation(),active=library.newConversation();
  return{snapshot:library.snapshot(),recorded,inactive,active};
}
test('sidebar closes inactive and active empty rows during unavailable provider state without touching provider drafts or history',async t=>{
  const rows=emptyRows(),doc=new SidebarDocument(),f=fixture(rows.snapshot,{sidebar:doc,drafts:true});t.after(()=>f.controller.cleanup());await settle();
  f.codex.refuse=true;f.claude.refuse=true;f.codex.unsent='Keep my Codex draft';f.claude.unsent='Keep my Claude draft';
  const close=doc.close(rows.inactive)!;assert.ok(close);assert.equal(close.tagName,'BUTTON');assert.equal(close.type,'button');assert.equal(close.tabIndex,0);assert.equal(close.getAttribute('aria-label'),'Close empty chat: New chat');assert.equal(close.textContent,'×');
  assert.equal(doc.close(rows.recorded.id),undefined);close.focus();close.click();await settle();await f.controller.prepareForRestart();
  assert.equal(f.saved()!.activeId,rows.active);assert.deepEqual(f.saved()!.conversations.map(c=>c.id),[rows.recorded.id,rows.active]);
  doc.close(rows.active)!.click();await settle();await f.controller.prepareForRestart();
  assert.equal(f.saved()!.activeId,null);assert.deepEqual(f.saved()!.conversations,[rows.recorded]);
  assert.equal(await f.codex.hook!('A separate unsent request'),'A separate unsent request');
  assert.equal(f.codex.unsent,'Keep my Codex draft');assert.equal(f.claude.unsent,'Keep my Claude draft');
  assert.deepEqual(f.codex.opens,[]);assert.deepEqual(f.claude.opens,[]);assert.equal(f.codex.newCalls+f.claude.newCalls,0);assert.deepEqual(f.providerRequests,[]);assert.equal(f.provider(),'codex');
  assert.equal(doc.activeElement?.className,'library-chat','keyboard focus may move to a row without opening its native conversation');
});
test('refresh, provider sync, explicit provider choice and reload do not recreate dismissed empty sidebar rows',async t=>{
  const rows=emptyRows(),doc=new SidebarDocument(),f=fixture(rows.snapshot,{sidebar:doc,drafts:true});t.after(()=>f.controller.cleanup());await settle();
  doc.close(rows.inactive)!.click();doc.close(rows.active)!.click();await settle();
  for(const provider of['claude','codex','claude','codex'] as const){f.setProvider(provider);for(const listener of f.codex.listeners)listener();for(const listener of f.claude.listeners)listener();await settle();f.controller.resume();}
  await f.controller.prepareForRestart();assert.deepEqual(f.saved()!.conversations,[rows.recorded]);assert.equal(f.saved()!.activeId,null);
  assert.equal(await f.controller.beforeProviderSwitch('codex','claude'),true);f.setProvider('claude');await f.controller.prepareForRestart();
  assert.deepEqual(f.saved()!.conversations,[rows.recorded]);assert.equal(f.saved()!.activeId,null);assert.equal(f.claude.newCalls,1,'only the explicit provider choice invokes the existing provider setup');
  const reopened=fixture(f.saved()!,{sidebar:new SidebarDocument(),drafts:true});t.after(()=>reopened.controller.cleanup());await settle();await reopened.controller.prepareForRestart();
  assert.deepEqual(reopened.saved(),f.saved());assert.equal(reopened.codex.newCalls+reopened.claude.newCalls,0);assert.deepEqual(reopened.codex.opens,[]);assert.deepEqual(reopened.claude.opens,[]);
});
test('stale empty-row close control cannot dismiss a subsequently bound conversation',async t=>{
  const library=new ConversationLibrary(project),empty=library.newConversation(),doc=new SidebarDocument(),f=fixture(library.snapshot(),{sidebar:doc,drafts:true});t.after(()=>f.controller.cleanup());await settle();
  const stale=doc.close(empty)!;assert.ok(stale);
  assert.equal(await f.controller.beforeProviderSwitch('codex','claude'),true);f.setProvider('claude');f.claude.value.conversationId='new-claude';f.claude.message('new','Keep this actual recorded message');await settle();await f.controller.prepareForRestart();
  const before=f.saved()!;assert.equal(before.activeId,empty);assert.equal(before.conversations[0]!.bindings[0]!.conversationId,'new-claude');assert.equal(doc.close(empty),undefined);
  stale.click();await settle();await f.controller.prepareForRestart();assert.deepEqual(f.saved(),before);assert.deepEqual(f.providerRequests,[]);assert.deepEqual(f.codex.opens,[]);assert.deepEqual(f.claude.opens,[]);
});
test('empty-row dismissal stays blocked during provider preparation and after stop',async t=>{
  const library=new ConversationLibrary(project),empty=library.newConversation(),doc=new SidebarDocument(),f=fixture(library.snapshot(),{sidebar:doc,drafts:true});t.after(()=>f.controller.cleanup());await settle();
  let release!:()=>void;f.claude.newChatGate=new Promise<void>(resolve=>{release=resolve;});
  const switching=f.controller.beforeProviderSwitch('codex','claude');await settle();const close=doc.close(empty)!;close.click();
  release();assert.equal(await switching,true);await f.controller.prepareForRestart();assert.equal(f.saved()!.activeId,empty);
  f.controller.stop();close.click();f.controller.resume();await f.controller.prepareForRestart();assert.equal(f.saved()!.activeId,empty);assert.ok(doc.close(empty));
});
test('failed empty-row dismissal persistence keeps the existing error notice and remains restart-blocking until saved',async t=>{
  const rows=emptyRows(),doc=new SidebarDocument(),f=fixture(rows.snapshot,{sidebar:doc,drafts:true});t.after(()=>f.controller.cleanup());await settle();f.setFail(true);
  doc.close(rows.active)!.click();await settle();assert.ok(doc.mount.textContent.includes('Chat organisation has not been saved.'));assert.deepEqual(f.saved(),rows.snapshot);
  await assert.rejects(f.controller.prepareForRestart(),/could not be saved/);assert.deepEqual(f.saved(),rows.snapshot);
  f.setFail(false);await f.controller.prepareForRestart();assert.equal(f.saved()!.activeId,null);assert.deepEqual(f.saved()!.conversations.map(c=>c.id),[rows.recorded.id,rows.inactive]);
  assert.ok(!doc.mount.textContent.includes('Chat organisation has not been saved.'));assert.deepEqual(f.codex.opens,[]);assert.deepEqual(f.claude.opens,[]);assert.equal(f.codex.newCalls+f.claude.newCalls,0);assert.deepEqual(f.providerRequests,[]);
});
