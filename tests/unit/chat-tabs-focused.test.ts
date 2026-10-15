import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ChatTabs, nativeChatKey, validateSavedThreads, CHAT_TAB_LIMITS, startChatTabs, readWorkspacePreferencesBridge, type ChatTabPreferences } from '../../apps/desktop/src/chat-tabs.js';
import { CodexChat, CodexChatApi, readCodexState, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { createCodexService, type CodexHostClient, type CodexService } from '../../apps/daemon/src/codex-service.js';
import { CodexClientError, type Snapshot, type ThreadState } from '../../packages/codex-client/src/types.js';

// Controlled SDK/document fixtures only. No CLI, browser install, Studio or inference.
const TOKEN='a'.repeat(64), PROJECT=resolve('.');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class Element extends EventTarget {
  tagName:string; id=''; children:Element[]=[]; value=''; checked=false; disabled=false; hidden=false; open=false;
  className=''; type=''; title=''; tabIndex=0; scrollHeight=0; scrollTop=0; clientHeight=0;
  dataset:Record<string,string>={}; private content=''; private attributes=new Map<string,string>();
  constructor(tag='div'){super();this.tagName=tag.toUpperCase();}
  get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.content=value;this.children=[];}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.content='';this.children=children;}
  after(..._children:Element[]){} remove(){} focus(_options?:unknown){} contains(_value:unknown){return false;}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  getAttribute(key:string){return this.attributes.get(key)??null;}
  querySelectorAll(selector:string):Element[]{return this.children.flatMap(child=>[...(selector==='[role=tab]'&&child.getAttribute('role')==='tab'?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(){return null;} showModal(){this.open=true;} close(){this.open=false;}
}
class DocumentFixture extends EventTarget {
  hidden=false; activeElement:Element|null=null; private elements=new Map<string,Element>();
  constructor(){super();this.getElementById('workspace-chat-tabs').setAttribute('role','tablist');}
  getElementById(id:string):Element {let el=this.elements.get(id);if(!el){el=new Element(id==='codex-composer'?'textarea':'div');el.id=id;this.elements.set(id,el);}return el;}
  createElement(tag:string){return new Element(tag);}
  asDocument(){return this as unknown as Document;}
}
function memoryStorage(){const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};}
function snapshot():Snapshot{return {connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,
  account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},models:[
    {model:'fixture-sol',id:'sol',displayName:'Fixture Sol',efforts:['low','high'],defaultEffort:'low',entitlement:'unverified'},
    {model:'fixture-alt',id:'alt',displayName:'Fixture Alt',efforts:['high'],defaultEffort:'high',entitlement:'unverified'},
  ],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};}
function state(projectPath=PROJECT):ChatState{return {provider:'codex',use:'personal-local',projectPath,connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeThreads:[],nativeHistory:null,nativeTools:{configured:true,verified:false}};}
function controller(initial=state(),storage=memoryStorage()) {
  const doc=new DocumentFixture(),calls:string[]=[];let observed=initial,failed=false;
  const api=new CodexChatApi(TOKEN,async(path,init)=>{calls.push(String(path)+':'+init?.method);if(failed)throw new Error('Fixture unavailable');assert.equal(init?.method,'GET','Presentation tests must never perform native actions');return Response.json({state:observed});});
  const chat=new CodexChat(doc.asDocument(),api);
  return {doc,chat,storage,calls,set:(value:ChatState)=>{observed=value;},fail:()=>{failed=true;}};
}
const callbacks={select:async()=>true,close:async()=>true,newChat:async()=>true,openSaved:async()=>true};

function newChatShortcut(doc:DocumentFixture, modifiers:Partial<Pick<KeyboardEvent,'ctrlKey'|'metaKey'|'altKey'|'shiftKey'|'isComposing'|'repeat'>>={ctrlKey:true}, key='n'):Event {
  const event=new Event('keydown',{cancelable:true});
  Object.defineProperty(event,'key',{value:key});
  for(const [name,value]of Object.entries(modifiers))Object.defineProperty(event,name,{value});
  doc.dispatchEvent(event);return event;
}

test('sidebar and Ctrl/Cmd+N create actual local chats through one navigation hook without sending drafts',async t=>{
  const f=controller();let navigations=0;t.after(()=>f.chat.stop());
  await f.chat.enableChatTabs({storage:f.storage,captureLegacyNewChat:true,beforeNewChat:()=>{navigations++;}});
  await f.chat.start();const first=f.chat.chatTabsView()[0]!;
  f.doc.getElementById('codex-composer').value='Keep this unsent draft.\n  ';
  f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  const button=f.doc.getElementById('new-chat');assert.equal(button.disabled,false);
  const click=new Event('click',{cancelable:true});button.dispatchEvent(click);await tick();
  assert.equal(click.defaultPrevented,true);assert.equal(f.chat.chatTabsView().length,2);assert.equal(navigations,1);
  assert.equal(f.chat.chatTabsView().find(row=>row.key===first.key)!.draft,'Keep this unsent draft.\n  ');
  assert.equal(newChatShortcut(f.doc).defaultPrevented,true);await tick();
  assert.equal(newChatShortcut(f.doc,{metaKey:true},'N').defaultPrevented,true);await tick();
  assert.equal(f.chat.chatTabsView().length,4);assert.equal(navigations,3);
  for(const modifiers of [{ctrlKey:true,isComposing:true},{ctrlKey:true,repeat:true},{ctrlKey:true,shiftKey:true},{ctrlKey:true,altKey:true},{}])
    assert.equal(newChatShortcut(f.doc,modifiers).defaultPrevented,false);
  const handled=new Event('keydown',{cancelable:true});Object.defineProperties(handled,{key:{value:'n'},ctrlKey:{value:true}});handled.preventDefault();f.doc.dispatchEvent(handled);
  assert.equal(f.chat.chatTabsView().length,4);assert.equal(navigations,3);
  assert.ok(f.calls.every(call=>call==='/v1/codex/state:GET'));
  f.chat.stop();assert.equal(newChatShortcut(f.doc).defaultPrevented,false);assert.equal(navigations,3);
});

test('busy and uncertain native work disables both New chat buttons and the shortcut without navigation',async t=>{
  for(const mode of ['busy','unknown']as const){
    const initial=state();initial.snapshot=snapshot();
    if(mode==='busy')initial.busy=true;
    else initial.actions=[{requestId:randomUUID(),action:'thread-start',connectionId:initial.snapshot.connectionId,state:'unknown',errorCode:'FIXTURE_UNKNOWN',threadId:null,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:null}];
    const f=controller(initial);let navigations=0;t.after(()=>f.chat.stop());
    await f.chat.enableChatTabs({storage:f.storage,captureLegacyNewChat:true,beforeNewChat:()=>{navigations++;}});
    const count=f.chat.chatTabsView().length;
    for(const id of ['new-chat','workspace-new-chat']){assert.equal(f.doc.getElementById(id).disabled,true);f.doc.getElementById(id).dispatchEvent(new Event('click',{cancelable:true}));}
    assert.equal(newChatShortcut(f.doc).defaultPrevented,true);await tick();
    assert.equal(f.chat.chatTabsView().length,count);assert.equal(navigations,0);assert.ok(f.calls.every(call=>call.endsWith(':GET')));
  }
});

test('tab limit and lifecycle keep one shortcut owner and never navigate after stop',()=>{
  const doc=new DocumentFixture();let created=0,navigations=0;
  const tabs=new ChatTabs(doc.asDocument(),value=>value,{...callbacks,newChat:async()=>{created++;return true;}},
    {storage:memoryStorage(),captureLegacyNewChat:true,beforeNewChat:()=>{navigations++;}});
  tabs.sync(state());tabs.mount();tabs.mount();tabs.render(false);
  newChatShortcut(doc);assert.equal(created,1);assert.equal(navigations,1);
  tabs.stop();assert.equal(newChatShortcut(doc).defaultPrevented,false);
  tabs.mount();tabs.render(false);newChatShortcut(doc);assert.equal(created,2);
  while(tabs.views().length<CHAT_TAB_LIMITS.open)tabs.createDraft();tabs.render(false);
  assert.equal(doc.getElementById('new-chat').disabled,true);assert.equal(doc.getElementById('workspace-new-chat').disabled,true);
  newChatShortcut(doc);assert.equal(created,2);assert.equal(navigations,2);
  tabs.stop();newChatShortcut(doc);assert.equal(created,2);
});

test('empty native inventory opens local drafts; each draft and selection is separate; no automatic native calls',async t=>{
  const f=controller();t.after(()=>f.chat.stop());await f.chat.enableChatTabs({storage:f.storage});await f.chat.start();
  const first=f.chat.chatTabsView()[0]!;assert.equal(first.kind,'draft');assert.equal(first.threadId,null);
  f.doc.getElementById('codex-composer').value='First draft 🧩';f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(await f.chat.newChat(),true);const second=f.chat.chatTabsView()[1]!;
  assert.notEqual(first.key,second.key);assert.equal(f.doc.getElementById('codex-composer').value,'');
  f.doc.getElementById('codex-composer').value='Second draft';f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(await f.chat.selectChat(first.key),true);assert.equal(f.doc.getElementById('codex-composer').value,'First draft 🧩');
  assert.equal(await f.chat.selectChat(second.key),true);assert.equal(f.doc.getElementById('codex-composer').value,'Second draft');
  assert.equal(f.chat.workflowConversation(),null);assert.equal(f.chat.currentStateView().nativeBoundToActiveChat,false);
  assert.ok(f.calls.every(call=>call==='/v1/codex/state:GET'));assert.equal(f.doc.getElementById('codex-submit').disabled,true);
  const reloaded=controller(state(),f.storage);t.after(()=>reloaded.chat.stop());await reloaded.chat.enableChatTabs({storage:f.storage});
  assert.equal(reloaded.chat.chatTabsView().length,2);assert.equal(reloaded.doc.getElementById('codex-composer').value,'Second draft');
  assert.equal(await reloaded.chat.selectChat(first.key),true);assert.equal(reloaded.doc.getElementById('codex-composer').value,'First draft 🧩');
});

test('preference rows are bounded and advisory; foreign project/provider/IDs and credential fields never become tabs',()=>{
  const doc=new DocumentFixture(),storage=memoryStorage(),tabs=new ChatTabs(doc.asDocument(),value=>new CodexChatApi(TOKEN).safe(value),callbacks,{storage});
  tabs.sync(state());tabs.updateDraft(`Keep public text. Bearer privateCredential api_key=sk-fakeFixtureSecret123 ${TOKEN}`);
  const stored=[...storage.data.values()].join('');assert.doesNotMatch(stored,/privateCredential|sk-fakeFixtureSecret123|a{64}/);assert.match(stored,/Keep public text/);
  for(let i=0;i<CHAT_TAB_LIMITS.open+4;i++)tabs.createDraft();assert.equal(tabs.views().length,CHAT_TAB_LIMITS.open);assert.equal(tabs.createDraft(),null);
  const row={provider:'codex',projectPath:PROJECT,threadId:'owned',sessionId:null,selection:null};
  assert.throws(()=>validateSavedThreads([{...row,projectPath:PROJECT+'-other'}],PROJECT));
  assert.throws(()=>validateSavedThreads([{...row,provider:'claude'}],PROJECT));
  assert.throws(()=>validateSavedThreads([row,row],PROJECT));
  assert.throws(()=>validateSavedThreads([{...row,threadId:'../owned'}],PROJECT));
  assert.throws(()=>validateSavedThreads([{...row,title:'authority'}],PROJECT));
  const only=state();only.nativeThreads=[row as NonNullable<ChatState['nativeThreads']>[number]];
  const nativeKey=nativeChatKey(row);const fake={...JSON.parse([...storage.data.values()][0]!),activeKey:nativeKey,tabs:[{...tabs.views()[0],key:nativeKey,kind:'native',threadId:'owned',sessionId:null}]};
  storage.data.set('arcane.chat-tabs.v1:'+encodeURIComponent(PROJECT),JSON.stringify(fake));
  const restored=new ChatTabs(doc.asDocument(),value=>value,callbacks,{storage});restored.sync(state());
  assert.equal(restored.views()[0]!.kind,'draft','saved browser IDs do not authorize unknown native threads');
});

test('freshness, active turns, unknown operations, pending receipts, approvals and grants block switching without hiding attention',async t=>{
  const base=state();base.snapshot=snapshot();base.snapshot.selection={model:'fixture-sol',effort:'low'};
  base.snapshot.thread={threadId:'owned',sessionId:null,selection:{model:'fixture-sol',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};
  base.nativeThreads=[{provider:'codex',projectPath:PROJECT,threadId:'owned',sessionId:null,selection:{model:'fixture-sol',effort:'low'}}];
  base.nativeHistory={projectPath:PROJECT,threadId:'owned',sessionId:null,recorded:null};
  const f=controller(base);t.after(()=>f.chat.stop());await f.chat.enableChatTabs({storage:f.storage});const native=f.chat.chatTabsView()[0]!;
  assert.equal(await f.chat.newChat(),true);const draft=f.chat.chatTabsView()[1]!;assert.equal(f.chat.workflowConversation(),null);
  const active=structuredClone(base);active.snapshot!.thread!.turnStatus='inProgress';active.snapshot!.thread!.turnId='active-turn';f.set(active);await f.chat.refresh();
  assert.equal(f.chat.currentStateView().activeChat!.key,native.key,'an externally active bound turn becomes visible even from a local draft');
  assert.equal(await f.chat.selectChat(draft.key),false);assert.equal(await f.chat.closeChat(native.key),false);
  const patches:((value:ChatState)=>void)[]=[
    value=>{value.snapshot!.thread!.turnStatus='unknown';},
    value=>{value.snapshot!.operations=[{operationId:'op',method:'turn/start',requestId:1,threadId:'owned',turnId:null,state:'unknown',errorCode:null}];},
    value=>{value.snapshot!.operations=[{operationId:'op',method:'turn/start',requestId:1,threadId:'owned',turnId:null,state:'pending',errorCode:null}];},
    value=>{value.busy=true;},value=>{value.snapshot!.thread!.writeGranted=true;},
    value=>{value.nativeAssets={available:true,sealed:true,granted:true,admissionOpen:false};},
    value=>{value.displayLimited=true;},
    value=>{value.snapshot!.approvals=[{handle:'approval',connectionId:value.snapshot!.connectionId,threadId:'owned',turnId:'turn',itemId:'command',serverRequestId:1,method:'item/commandExecution/requestApproval',reason:null,command:'fixture',cwd:PROJECT,changes:null,canAccept:false,expiresAt:Date.now()+10000}];},
  ];
  for(const patch of patches){const next=structuredClone(base);patch(next);f.set(next);await f.chat.refresh();assert.equal(await f.chat.selectChat(draft.key),false);assert.equal(await f.chat.newChat(),false);assert.equal(f.chat.currentStateView().activeChat!.key,native.key);}
  f.set(base);await f.chat.refresh();assert.equal(await f.chat.selectChat(draft.key),true);
  f.fail();await f.chat.refresh();assert.equal(await f.chat.selectChat(native.key),false);assert.equal(f.chat.currentStateView().fresh,false);
});

test('validated snapshot/context subscriptions are read-only, redact keys, isolate listener faults and make no native calls',async t=>{
  const initial=state();initial.snapshot=snapshot();initial.snapshot.account!.plan='Bearer fixturePrivateKey '+TOKEN;
  const f=controller(initial);t.after(()=>f.chat.stop());let snapshots=0,contexts=0;
  const unsubscribe=f.chat.subscribeStateChange(()=>snapshots++);f.chat.subscribeStateChange(()=>{throw new Error('Fixture listener');});f.chat.subscribeWorkflowContextChange(()=>contexts++);
  await f.chat.enableChatTabs({storage:f.storage});const before=contexts;await f.chat.newChat();assert.ok(contexts>before);
  const calls=f.calls.length,view=f.chat.currentStateView();assert.ok(Object.isFrozen(view));assert.ok(Object.isFrozen(view.state!.snapshot));
  assert.doesNotMatch(JSON.stringify(view),/fixturePrivateKey|a{64}/);assert.throws(()=>{view.state!.snapshot!.connected=false;});
  for(let i=0;i<5;i++)f.chat.currentStateView();assert.equal(f.calls.length,calls);assert.ok(snapshots>0);unsubscribe();
  const changed=state(PROJECT+'-other');f.set(changed);await f.chat.refresh();assert.equal(f.chat.currentStateView().activeChat!.projectPath,changed.projectPath);assert.equal(f.chat.workflowConversation(),null);
  assert.throws(()=>readCodexState({...changed,nativeThreads:[{provider:'codex',projectPath:PROJECT,threadId:'foreign',sessionId:null,selection:null}]}));
});

test('native preference restoration awaits read acknowledgement, fences canonical project and does not use origin storage',async()=>{
  const doc=new DocumentFixture(),localId=randomUUID(),saved:ChatTabPreferences={version:1,projectPath:PROJECT,provider:'codex',activeTabId:localId,tabs:[{localId,title:'Restored draft',provider:'codex',threadId:null,sessionId:null,draft:'Native saved draft',modelId:'fixture-alt',effort:'high',tool:'all',previewOpen:true}]};
  let release!:(value:unknown)=>void;const writes:ChatTabPreferences[]=[];
  const tabs=new ChatTabs(doc.asDocument(),value=>value,callbacks,{preferences:{read:()=>new Promise(resolve=>{release=resolve;}),save:async value=>{writes.push(value);}}});
  const pending=tabs.initializePreferences(PROJECT);assert.equal(tabs.persistenceStatus(),'native-loading');assert.equal(writes.length,0);
  release(saved);await pending;tabs.sync(state());assert.equal(tabs.active()!.draft,'Native saved draft');assert.equal(tabs.active()!.previewOpen,true);assert.equal(tabs.persistenceStatus(),'native');
  await tick();assert.equal(writes.at(-1)!.projectPath,PROJECT);
  tabs.sync(state(PROJECT+'-other'));await tick();assert.ok(writes.every(value=>value.projectPath===PROJECT),'never save a new project before its native preferences acknowledgement');
  const wrong=new ChatTabs(doc.asDocument(),value=>value,callbacks,{preferences:{read:async()=>({...saved,projectPath:PROJECT+'-foreign'}),save:async()=>assert.fail('invalid native restore must not overwrite preferences')}});
  await wrong.initializePreferences(PROJECT);wrong.sync(state());assert.equal(wrong.persistenceStatus(),'native-error');assert.equal(wrong.active()!.draft,'');
});

test('native boot unwraps exact bridge acknowledgements and restores Claude presentation without native chat parity, probes or recursive events',async t=>{
  const f=controller();t.after(()=>f.chat.stop());Object.defineProperty(f.doc,'defaultView',{value:{CustomEvent}});
  const localId=randomUUID(),preferences:ChatTabPreferences={version:1,projectPath:PROJECT,provider:'claude',activeTabId:localId,tabs:[{localId,title:'Draft',provider:'codex',threadId:null,sessionId:null,draft:'Restored native draft',modelId:null,effort:null,tool:'all',previewOpen:false}]};
  let reads=0;const saves:ChatTabPreferences[]=[];
  const native=Object.freeze({version:1,read:async()=>{reads++;return {available:true,preferences};},save:async(value:ChatTabPreferences)=>{saves.push(value);return {saved:true};}});
  let providerEvents=0,restoreEvents=0;f.doc.addEventListener('workspace:providerpreference',()=>providerEvents++);f.doc.addEventListener('workspace:preferencesrestored',()=>restoreEvents++);
  const tabs=await startChatTabs(f.doc.asDocument(),{chat:f.chat,nativeBridge:native});t.after(()=>tabs.cleanup());await tick();
  assert.equal(reads,1);assert.equal(providerEvents,1);assert.equal(restoreEvents,1);assert.equal(f.chat.currentStateView().preferredProvider,'claude');assert.equal(f.chat.currentStateView().activeChat!.provider,'codex');assert.equal(f.chat.currentStateView().persistence,'native');assert.equal(f.chat.currentStateView().preferencesSaved,true);
  f.doc.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'codex'}}));await tick();assert.equal(providerEvents,2,'choice is not re-emitted recursively');assert.equal(restoreEvents,1);assert.equal(saves.at(-1)!.provider,'codex');
  let invoked=0;const malicious={};Object.defineProperty(malicious,'provider',{enumerable:true,get(){invoked++;return 'claude';}});f.doc.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:malicious}));assert.equal(invoked,0);assert.equal(f.chat.currentStateView().preferredProvider,'codex');
  assert.ok(f.calls.every(call=>call.endsWith(':GET')));assert.equal(f.chat.workflowConversation(),null);
  tabs.stop();f.doc.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'claude'}}));assert.equal(f.chat.currentStateView().preferredProvider,'codex');tabs.resume();
});

test('native bridge detection never invokes getters; unavailable, malformed read and unverified save acknowledgements cannot claim persistence',async t=>{
  const doc=new DocumentFixture();let invoked=0;const bad={version:1,save:async()=>({saved:true})};Object.defineProperty(bad,'read',{enumerable:true,get(){invoked++;return async()=>null;}});Object.freeze(bad);
  assert.equal(readWorkspacePreferencesBridge(doc.asDocument(),{nativeBridge:bad}),null);assert.equal(invoked,0);
  assert.equal(readWorkspacePreferencesBridge(doc.asDocument(),{nativeBridge:Object.freeze({version:2,read:async()=>null,save:async()=>null})}),null);
  for(const response of [{available:false,preferences:null},{version:1,available:true,preferences:null},{available:true,preferences:null,auth:true}]) {
    const f=controller();t.after(()=>f.chat.stop());let saved=0;
    const boot=await startChatTabs(f.doc.asDocument(),{chat:f.chat,nativeBridge:Object.freeze({version:1,read:async()=>response,save:async()=>{saved++;return {saved:true};}})});t.after(()=>boot.cleanup());await tick();
    assert.equal(f.chat.currentStateView().persistence,'native-error');assert.equal(f.chat.currentStateView().preferencesSaved,false);assert.equal(saved,0);
  }
  const f=controller();t.after(()=>f.chat.stop());const boot=await startChatTabs(f.doc.asDocument(),{chat:f.chat,nativeBridge:Object.freeze({version:1,read:async()=>({available:true,preferences:null}),save:async()=>({saved:false})})});t.after(()=>boot.cleanup());await tick();
  assert.equal(f.chat.currentStateView().persistence,'native-error');assert.equal(f.chat.currentStateView().preferencesSaved,false);
});

test('Claude presentation disables actual Codex form/keyboard Send, preserves owned history and draft, and explicit Codex choice restores normal controls',async t=>{
  const initial=state();initial.snapshot=snapshot();initial.snapshot.selection={model:'fixture-sol',effort:'low'};
  initial.snapshot.thread={threadId:'send-thread',sessionId:null,selection:{model:'fixture-sol',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};
  initial.nativeThreads=[{provider:'codex',projectPath:PROJECT,threadId:'send-thread',sessionId:null,selection:{model:'fixture-sol',effort:'low'}}];
  initial.nativeHistory={projectPath:PROJECT,threadId:'send-thread',sessionId:null,recorded:null};
  const f=controller(initial);t.after(()=>f.chat.stop());await f.chat.start();await f.chat.enableChatTabs({storage:f.storage});
  f.doc.getElementById('codex-composer').value='Preserve this real unsent Codex draft';f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(f.doc.getElementById('codex-submit').disabled,false);
  const before=f.calls.length;f.doc.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'claude'}}));
  assert.equal(f.doc.getElementById('codex-submit').disabled,true);assert.equal(f.chat.workflowConversation(),null);assert.equal(f.chat.currentStateView().activeChat!.threadId,'send-thread');
  f.doc.getElementById('codex-compose').dispatchEvent(new Event('submit',{cancelable:true}));await tick();
  assert.equal(f.calls.length,before,'form/keyboard Send cannot dispatch any Codex action while Claude is selected');assert.equal(f.doc.getElementById('codex-composer').value,'Preserve this real unsent Codex draft');
  f.doc.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'codex'}}));assert.equal(f.doc.getElementById('codex-submit').disabled,false);assert.equal(f.chat.workflowConversation()!.threadId,'send-thread');assert.equal(f.chat.currentStateView().preferredProvider,'codex');
});

test('pending or unknown journal receipts cannot be bypassed by new draft, close, local preference reload or raw IDs',async t=>{
  for(const receiptState of ['pending','unknown'] as const) {
    const initial=state();initial.snapshot=snapshot();initial.actions=[{requestId:randomUUID(),action:'thread-start',connectionId:initial.snapshot.connectionId,state:receiptState,errorCode:receiptState==='unknown'?'FIXTURE_UNKNOWN':null,threadId:null,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:null}];
    const f=controller(initial);t.after(()=>f.chat.stop());await f.chat.enableChatTabs({storage:f.storage});const key=f.chat.chatTabsView()[0]!.key;
    assert.equal(await f.chat.newChat(),false);assert.equal(await f.chat.closeChat(key),false);assert.equal(await f.chat.openSavedChat('unknown'),false);assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.ok(f.calls.every(call=>call.endsWith(':GET')));
  }
});

test('optional native token reports and duration events survive state projection exactly; invalid telemetry stays unavailable',async t=>{
  const initial=state();initial.snapshot=snapshot();initial.snapshot.selection={model:'fixture-sol',effort:'low'};
  initial.snapshot.thread={threadId:'usage-thread',sessionId:null,configured:true,writeGranted:false,selection:{model:'fixture-sol',effort:'low'},turnId:'usage-turn',turnStatus:'completed',durationMs:3210};
  const total={totalTokens:150,inputTokens:100,cachedInputTokens:20,outputTokens:50,reasoningOutputTokens:10};
  const last={totalTokens:15,inputTokens:10,cachedInputTokens:2,outputTokens:5,reasoningOutputTokens:1};
  const usage={source:'thread/tokenUsage/updated' as const,continuity:'reported' as const,total,last,modelContextWindow:128000};
  initial.snapshot.events=[{type:'usage',seq:1,threadId:'usage-thread',turnId:'usage-turn',usage},{type:'turn',seq:2,threadId:'usage-thread',turnId:'usage-turn',status:'completed',durationMs:3210}];initial.snapshot.lastEventSeq=2;
  initial.snapshot.usage={...usage,threadId:'usage-thread',turnId:'usage-turn',seq:1};
  assert.deepEqual(readCodexState(initial).snapshot!.usage,initial.snapshot.usage);
  const f=controller(initial);t.after(()=>f.chat.stop());await f.chat.refresh();assert.deepEqual(f.chat.currentStateView().state!.snapshot!.usage,initial.snapshot.usage);assert.equal(f.chat.currentStateView().state!.snapshot!.thread!.durationMs,3210);
  for(const patch of [{total:{...total,totalTokens:-1}},{total:{...total,extraCredential:'private'}},{total:{...total,cachedInputTokens:101}},{last:{...last,outputTokens:501}},{modelContextWindow:Infinity},{continuity:'invented'},{threadId:'foreign'},{seq:3}])assert.throws(()=>readCodexState({...initial,snapshot:{...initial.snapshot,usage:{...initial.snapshot!.usage,...patch}}}));
  assert.throws(()=>readCodexState({...initial,snapshot:{...initial.snapshot,thread:{...initial.snapshot!.thread,durationMs:-1}}}));
  assert.throws(()=>readCodexState({...initial,snapshot:{...initial.snapshot,events:[{type:'usage',seq:1,threadId:'usage-thread',turnId:'usage-turn',usage,auth:'bad'}]}}));
  let invoked=0;const counts={...total};Object.defineProperty(counts,'totalTokens',{enumerable:true,get(){invoked++;return 150;}});
  assert.throws(()=>readCodexState({...initial,snapshot:{...initial.snapshot,usage:{...initial.snapshot!.usage,total:counts}}}));assert.equal(invoked,0);
});

async function serviceFixture(t:test.TestContext) {
  const temp=await realpath(tmpdir()),directory=await mkdtemp(join(temp,'arcane-chat-tabs-fixture-')),project=join(directory,'project');await mkdir(project);const projectPath=await realpath(project);
  const actual=new Map<string,ThreadState>(),calls:string[]=[],services:CodexService[]=[];let current:Snapshot|null=null,number=0,live=0,maxLive=0;
  const factory=async():Promise<CodexHostClient>=>{
    live++;maxLive=Math.max(maxLive,live);const s=snapshot();current=s;let closed=false;
    return {snapshot:()=>structuredClone(s),selectModel:action=>{s.selection={model:action.model,effort:action.effort};if(s.thread){s.thread.selection={...s.selection};s.thread.writeGranted=false;}return {...s.selection};},
      startThread:async()=>{const n=++number;const thread:ThreadState={threadId:'fixture-thread-'+n,sessionId:'fixture-session-'+n,selection:{...s.selection!},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};actual.set(thread.threadId,structuredClone(thread));s.thread=thread;return structuredClone(thread);},
      resumeThread:async action=>{const owned=actual.get(action.threadId);if(!owned)throw new CodexClientError('THREAD','Unknown fixture thread');s.thread={...structuredClone(owned),selection:{...s.selection!},writeGranted:false};return structuredClone(s.thread);},
      readThreadHistory:async action=>({entries:[{role:'user',text:'Public question for '+action.threadId,ids:{threadId:action.threadId,sessionId:action.sessionId??null,turnId:'turn-'+action.threadId,itemId:'user'}},{role:'assistant',text:'Public answer for '+action.threadId,ids:{threadId:action.threadId,sessionId:action.sessionId??null,turnId:'turn-'+action.threadId,itemId:'answer'}}],completeness:'complete',gaps:[],truncated:false,marker:null,excludedItems:0,droppedGaps:0,redacted:false}),
      grantThreadWrites:()=>{s.thread!.writeGranted=true;return structuredClone(s.thread!);},revokeThreadWrites:()=>{s.thread!.writeGranted=false;},
      startTurn:async()=>{assert.fail('No automatic turn is permitted');},interruptTurn:async()=>{},respondApproval:()=>{},
      close:async()=>{if(!closed){closed=true;live--;}s.connected=false;s.ready=false;if(s.thread)s.thread.writeGranted=false;},};
  };
  const open=()=>{const service=createCodexService({directory:join(directory,'journal'),projectPath,connect:factory});services.push(service);return service;};
  const service=open(),act=async(value:Record<string,unknown>)=>{calls.push(value.action as string);return service.action({requestId:randomUUID(),...value});};
  const seed=async(model='fixture-sol',effort='low')=>{const connected=await act({action:'connect',connectionId:null}),connectionId=connected.state.snapshot!.connectionId;await act({action:'select',connectionId,model,effort});const started=await act({action:'thread-start',connectionId});assert.equal(started.record.state,'acknowledged');const threadId=started.record.threadId!;await act({action:'history-load',connectionId,threadId});await act({action:'disconnect',connectionId});return threadId;};
  t.after(async()=>{for(const owned of services)await owned.close();const target=resolve(directory),child=relative(temp,target);assert.ok(!isAbsolute(child)&&child.startsWith('arcane-chat-tabs-fixture-')&&!child.includes('..'));await rm(target,{recursive:true,force:true});});
  return {service,open,seed,calls,actual,projectPath,directory,current:()=>current,maxLive:()=>maxLive};
}

test('real service journal preserves multiple public histories across reload; explicit idle switches resume only exact owned chats and separate models/drafts',async t=>{
  const f=await serviceFixture(t),a=await f.seed(),b=await f.seed('fixture-alt','high');f.calls.length=0;
  const doc=new DocumentFixture(),storage=memoryStorage();
  const api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(path==='/v1/codex/state')return Response.json({state:f.service.state()});
    const input=JSON.parse(String(init?.body));f.calls.push(input.action);const result=await f.service.action(input);
    return Response.json(result,{status:result.record.state==='acknowledged'?200:result.record.state==='rejected'?409:202});
  });
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.enableChatTabs({storage});await chat.start();
  assert.equal(f.calls.length,0);assert.equal(chat.chatTabsView()[0]!.threadId,b);assert.match(doc.getElementById('codex-messages').textContent,new RegExp('Public answer for '+b));
  assert.equal(await chat.openSavedChat(a),true);assert.equal(chat.currentStateView().conversation!.threadId,a);assert.equal(chat.currentStateView().nativeBoundToActiveChat,true);
  assert.match(doc.getElementById('codex-messages').textContent,new RegExp('Public answer for '+a));assert.doesNotMatch(doc.getElementById('codex-messages').textContent,new RegExp('Public answer for '+b));
  const aTab=chat.chatTabsView().find(row=>row.threadId===a)!;doc.getElementById('codex-composer').value='Draft A';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(await chat.openSavedChat(b),true);const bTab=chat.chatTabsView().find(row=>row.threadId===b)!;assert.equal(doc.getElementById('codex-model').value,'fixture-alt');assert.equal(doc.getElementById('codex-composer').value,'');
  doc.getElementById('codex-composer').value='Draft B';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(await chat.selectChat(aTab.key),true);assert.equal(doc.getElementById('codex-composer').value,'Draft A');assert.equal(doc.getElementById('codex-model').value,'fixture-sol');
  assert.equal(await chat.closeChat(bTab.key),true);assert.equal(f.service.state().nativeThreads!.length,2);
  assert.equal(await chat.openSavedChat('not-owned'),false);assert.ok(!f.calls.includes('turn-start'));assert.equal(f.maxLive(),1);
  const reader=new DatabaseSync(join(f.directory,'journal','codex-actions.sqlite'));assert.equal((reader.prepare('SELECT count(*) AS n FROM native_threads WHERE payload IS NOT NULL').get() as {n:number}).n,2);reader.close();
  await f.service.close();const reopened=f.open();assert.equal(reopened.state().nativeThreads!.length,2);assert.equal(reopened.state().snapshot,null);assert.equal(reopened.state().nativeHistory!.threadId,a);
  const connected=await reopened.action({requestId:randomUUID(),connectionId:null,action:'connect'}),connectionId=connected.state.snapshot!.connectionId;
  await reopened.action({requestId:randomUUID(),connectionId,action:'select',model:'fixture-sol',effort:'low'});
  const foreign=await reopened.action({requestId:randomUUID(),connectionId,action:'thread-resume',threadId:'not-owned'});assert.equal(foreign.record.state,'rejected');assert.equal(foreign.record.errorCode,'HISTORY_SCOPE');
});

test('explicit start binds only its local draft to a real acknowledged native thread; draft creation and selection never send it',async t=>{
  const f=await serviceFixture(t),old=await f.seed();f.calls.length=0;
  const doc=new DocumentFixture(),api=new CodexChatApi(TOKEN,async(path,init)=>{if(path==='/v1/codex/state')return Response.json({state:f.service.state()});const input=JSON.parse(String(init?.body));f.calls.push(input.action);const outcome=await f.service.action(input);return Response.json(outcome,{status:outcome.record.state==='acknowledged'?200:outcome.record.state==='rejected'?409:202});});
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.enableChatTabs({storage:memoryStorage()});await chat.start();await chat.openSavedChat(old);const oldKey=chat.currentStateView().activeChat!.key;
  doc.getElementById('codex-composer').value='Old unsent draft';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  const before=f.calls.length;assert.equal(await chat.newChat(),true);doc.getElementById('codex-composer').value='New unsent draft';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  doc.getElementById('codex-model').value='fixture-alt';doc.getElementById('codex-effort').value='high';doc.getElementById('codex-select').dispatchEvent(new Event('click'));await tick();
  assert.equal(f.calls.length,before,'staging a draft or pair cannot alter the existing native chat');assert.equal(chat.currentStateView().activeChat!.threadId,null);
  assert.equal(await chat.startCurrentChat(),true);const fresh=chat.currentStateView().activeChat!;assert.equal(fresh.kind,'native');assert.notEqual(fresh.threadId,old);assert.ok(f.actual.has(fresh.threadId!));
  assert.equal(doc.getElementById('codex-composer').value,'New unsent draft');assert.equal(f.service.state().snapshot!.thread!.writeGranted,false);assert.ok(!f.calls.includes('turn-start'));
  assert.equal(await chat.selectChat(oldKey),true);assert.equal(doc.getElementById('codex-composer').value,'Old unsent draft');assert.equal(doc.getElementById('codex-model').value,'fixture-sol');
});

