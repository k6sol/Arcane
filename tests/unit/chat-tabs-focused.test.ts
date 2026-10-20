import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ChatTabs, nativeChatKey, validateSavedThreads, CHAT_TAB_LIMITS, startChatTabs, readWorkspacePreferencesBridge, type ChatTabPreferences } from '../../apps/desktop/src/chat-tabs.js';
import { CodexChat, CodexChatApi, readCodexState, type ChatAction, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { createCodexService, type CodexActionOutcome, type CodexHostClient, type CodexService } from '../../apps/daemon/src/codex-service.js';
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
  const actual=new Map<string,ThreadState>(),calls:string[]=[],services:CodexService[]=[],cleanup:(()=>void)[]=[];let current:Snapshot|null=null,number=0,live=0,maxLive=0,historyHook:((threadId:string)=>Promise<void>)|null=null;
  const factory=async():Promise<CodexHostClient>=>{
    live++;maxLive=Math.max(maxLive,live);const s=snapshot();current=s;let closed=false;
    return {snapshot:()=>structuredClone(s),selectModel:action=>{s.selection={model:action.model,effort:action.effort};if(s.thread){s.thread.selection={...s.selection};s.thread.writeGranted=false;}return {...s.selection};},
      startThread:async()=>{const n=++number;const thread:ThreadState={threadId:'fixture-thread-'+n,sessionId:'fixture-session-'+n,selection:{...s.selection!},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};actual.set(thread.threadId,structuredClone(thread));s.thread=thread;return structuredClone(thread);},
      resumeThread:async action=>{const owned=actual.get(action.threadId);if(!owned)throw new CodexClientError('THREAD','Unknown fixture thread');s.thread={...structuredClone(owned),selection:{...s.selection!},writeGranted:false};return structuredClone(s.thread);},
      readThreadHistory:async action=>{await historyHook?.(action.threadId);return {entries:[{role:'user',text:'Public question for '+action.threadId,ids:{threadId:action.threadId,sessionId:action.sessionId??null,turnId:'turn-'+action.threadId,itemId:'user'}},{role:'assistant',text:'Public answer for '+action.threadId,ids:{threadId:action.threadId,sessionId:action.sessionId??null,turnId:'turn-'+action.threadId,itemId:'answer'}}],completeness:'complete',gaps:[],truncated:false,marker:null,excludedItems:0,droppedGaps:0,redacted:false};},
      grantThreadWrites:()=>{s.thread!.writeGranted=true;return structuredClone(s.thread!);},revokeThreadWrites:()=>{s.thread!.writeGranted=false;},
      startTurn:async()=>{assert.fail('No automatic turn is permitted');},interruptTurn:async()=>{},respondApproval:()=>{},
      close:async()=>{if(!closed){closed=true;live--;}s.connected=false;s.ready=false;if(s.thread)s.thread.writeGranted=false;},};
  };
  const open=()=>{const service=createCodexService({directory:join(directory,'journal'),projectPath,connect:factory});services.push(service);return service;};
  const service=open(),act=async(value:Record<string,unknown>)=>{calls.push(value.action as string);return service.action({requestId:randomUUID(),...value});};
  const seed=async(model='fixture-sol',effort='low')=>{const connected=await act({action:'connect',connectionId:null}),connectionId=connected.state.snapshot!.connectionId;await act({action:'select',connectionId,model,effort});const started=await act({action:'thread-start',connectionId});assert.equal(started.record.state,'acknowledged');const threadId=started.record.threadId!;await act({action:'history-load',connectionId,threadId});await act({action:'disconnect',connectionId});return threadId;};
  t.after(async()=>{for(const close of cleanup)close();for(const owned of services)await owned.close();const target=resolve(directory),child=relative(temp,target);assert.ok(!isAbsolute(child)&&child.startsWith('arcane-chat-tabs-fixture-')&&!child.includes('..'));await rm(target,{recursive:true,force:true});});
  return {service,open,seed,calls,actual,projectPath,directory,current:()=>current,maxLive:()=>maxLive,setHistoryHook:(hook:typeof historyHook)=>{historyHook=hook;},onCleanup:(close:()=>void)=>cleanup.push(close)};
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

test('starting a fresh conversation does not read stored history before the user writes a message',async t=>{
  const f=await serviceFixture(t);
  const connected=await f.service.action({requestId:randomUUID(),connectionId:null,action:'connect'});
  const connectionId=connected.state.snapshot!.connectionId;
  await f.service.action({requestId:randomUUID(),connectionId,action:'select',model:'fixture-sol',effort:'low'});
  const historyReads:string[]=[];
  f.setHistoryHook(async id=>{historyReads.push(id);throw new CodexClientError('REMOTE_REJECTED','Synthetic new conversation has no stored history.',true);});
  const doc=new DocumentFixture(),api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(path==='/v1/codex/state')return Response.json({state:f.service.state()});
    const input=JSON.parse(String(init?.body));f.calls.push(input.action);
    const outcome=await f.service.action(input);
    return Response.json(outcome,{status:outcome.record.state==='acknowledged'?200:outcome.record.state==='rejected'?409:202});
  });
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());
  await chat.enableChatTabs({storage:memoryStorage()});await chat.start();
  doc.getElementById('codex-model').value='fixture-sol';doc.getElementById('codex-effort').value='low';
  doc.getElementById('codex-select').dispatchEvent(new Event('click'));await tick();
  assert.equal(await chat.startCurrentChat(),true);
  assert.equal(chat.currentStateView().nativeBoundToActiveChat,true);
  assert.deepEqual(historyReads,[]);
  assert.equal(f.service.state().nativeHistory!.recorded,null,'No history recording is invented for a new chat.');
  const before=f.calls.length;
  doc.getElementById('codex-composer').value='My first message';
  doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(doc.getElementById('codex-composer').disabled,false);
  assert.equal(doc.getElementById('codex-submit').disabled,false);
  assert.equal(f.calls.length,before,'Typing preserves the draft without a native request.');
  assert.doesNotMatch(doc.getElementById('codex-notice').textContent,/history-load|rejected/);
  assert.equal(f.calls.includes('turn-start'),false);
});

test('explicit start binds only its local draft to a real acknowledged native thread; draft creation and selection never send it',async t=>{
  const f=await serviceFixture(t),old=await f.seed();f.calls.length=0;
  const doc=new DocumentFixture(),api=new CodexChatApi(TOKEN,async(path,init)=>{if(path==='/v1/codex/state')return Response.json({state:f.service.state()});const input=JSON.parse(String(init?.body));f.calls.push(input.action);const outcome=await f.service.action(input);return Response.json(outcome,{status:outcome.record.state==='acknowledged'?200:outcome.record.state==='rejected'?409:202});});
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.enableChatTabs({storage:memoryStorage()});await chat.start();await chat.openSavedChat(old);const oldKey=chat.currentStateView().activeChat!.key;
  const oldTranscript=chat.recordedTranscript();assert.equal(oldTranscript.conversationId,old);assert.ok(oldTranscript.messages.some(message=>message.text.includes('Public question for '+old)));
  doc.getElementById('codex-composer').value='Old unsent draft';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  const before=f.calls.length;assert.equal(await chat.newChat(),true);doc.getElementById('codex-composer').value='New unsent draft';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(f.service.state().snapshot!.thread!.threadId,old,'The prior native thread remains present while the local draft is active.');
  assert.deepEqual(chat.recordedTranscript(),{provider:'codex',projectPath:f.projectPath,conversationId:null,sessionId:null,earlierCount:0,messages:[]},'A draft publishes no previous native prompt or invented binding.');
  assert.equal(doc.getElementById('codex-composer').value,'New unsent draft','Reading the draft transcript retains the raw composer.');
  doc.getElementById('codex-model').value='fixture-alt';doc.getElementById('codex-effort').value='high';doc.getElementById('codex-select').dispatchEvent(new Event('click'));await tick();
  assert.equal(f.calls.length,before,'staging a draft or pair cannot alter the existing native chat');assert.equal(chat.currentStateView().activeChat!.threadId,null);
  assert.equal(await chat.startCurrentChat(),true);const fresh=chat.currentStateView().activeChat!;assert.equal(fresh.kind,'native');assert.notEqual(fresh.threadId,old);assert.ok(f.actual.has(fresh.threadId!));
  assert.equal(doc.getElementById('codex-composer').value,'New unsent draft');assert.equal(f.service.state().snapshot!.thread!.writeGranted,false);assert.ok(!f.calls.includes('turn-start'));
  assert.equal(await chat.selectChat(oldKey),true);assert.equal(doc.getElementById('codex-composer').value,'Old unsent draft');assert.equal(doc.getElementById('codex-model').value,'fixture-sol');
  assert.deepEqual(chat.recordedTranscript(),oldTranscript,'The prior native recording remains intact when reopened.');
});


async function historyNavigationFixture(t:test.TestContext,options:{timers?:boolean}={}) {
  const f=await serviceFixture(t),a=await f.seed(),b=await f.seed('fixture-alt','high'),doc=new DocumentFixture(),posts:ChatAction[]=[];
  let stateTransform=(value:ChatState)=>value,replyTransform=(value:CodexActionOutcome,_input:ChatAction)=>value,getHook:(()=>Promise<void>)|null=null,settleHook:((input:ChatAction)=>Promise<void>)|null=null;
  // Mocked before the chat exists, so its 1500 ms background poll fires only on an explicit tick.
  if(options.timers)t.mock.timers.enable({apis:['setTimeout']});
  const api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(path==='/v1/codex/state'){await getHook?.();return Response.json({state:stateTransform(f.service.state())});}
    const input=JSON.parse(String(init?.body))as ChatAction;posts.push(input);
    const acknowledged=await f.service.action(input);
    await settleHook?.(input); // The service journal has settled; only the HTTP reply is held.
    const outcome=replyTransform(acknowledged,input);
    return Response.json({...outcome,state:stateTransform(outcome.state)},{status:outcome.record.state==='acknowledged'?200:outcome.record.state==='rejected'?409:202});
  });
  const chat=new CodexChat(doc.asDocument(),api);f.onCleanup(()=>chat.stop());await chat.enableChatTabs({storage:memoryStorage()});await chat.start();
  assert.equal(await chat.openSavedChat(a),true);posts.length=0;
  const source=chat.currentStateView().activeChat!,reader=new DatabaseSync(join(f.directory,'journal','codex-actions.sqlite'));
  const recording=()=>((reader.prepare('SELECT payload FROM native_threads WHERE thread_id=?').get(a)as {payload:string|null}).payload);
  const originalRecording=recording();f.onCleanup(()=>reader.close());
  return {...f,a,b,doc,chat,posts,source,reader,recording,originalRecording,
    transformState:(transform:typeof stateTransform)=>{stateTransform=transform;},
    transformReply:(transform:typeof replyTransform)=>{replyTransform=transform;},
    beforeGet:(hook:typeof getHook)=>{getHook=hook;},
    holdReply:(hook:typeof settleHook)=>{settleHook=hook;},
    limit:()=>f.setHistoryHook(async id=>{if(id===a)throw new CodexClientError('FRAME_LIMIT','Synthetic bounded history response.',true);})};
}
function historyGate(t:test.TestContext) {
  let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  t.after(()=>release());return{wait,started,release,entered};
}
const HISTORY_LIMIT_NOTICE='Opened this conversation. The previous conversation\u2019s history exceeded the display limit; its earlier recording and unsent draft were retained.';

for(const source of ['native','draft']as const)test('exact terminal history FRAME_LIMIT permits only scoped outgoing navigation from a '+source+' while retaining prior recording and edits',async t=>{
  const gate=historyGate(t),f=await historyNavigationFixture(t);
  if(source==='draft')assert.equal(await f.chat.newChat(),true);
  const sourceTab=f.chat.currentStateView().activeChat!;
  f.doc.getElementById('codex-composer').value='Original unsent '+source;f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  f.setHistoryHook(async id=>{if(id===f.a){gate.entered();await gate.wait;throw new CodexClientError('FRAME_LIMIT','Synthetic large history.',true);}});
  const switching=f.chat.openSavedChat(f.b);await gate.started;
  // Same-tab text edits are retained; they do not change navigation authority.
  f.doc.getElementById('codex-composer').value='Edited while history awaited';f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));gate.release();
  assert.equal(await switching,true);assert.equal(f.chat.currentStateView().conversation!.threadId,f.b);
  assert.deepEqual(f.posts.map(row=>row.action),['history-load','disconnect','connect','select','thread-resume','history-load']);
  assert.equal((f.posts[1]as Extract<ChatAction,{action:'disconnect'}>).preserveAssetWork,true);
  assert.equal(f.doc.getElementById('codex-notice').textContent,HISTORY_LIMIT_NOTICE);
  assert.equal(f.recording(),f.originalRecording);
  assert.equal(f.chat.chatTabsView().find(row=>row.localId===sourceTab.localId)!.draft,'Edited while history awaited');
  const rejection=f.service.state().actions.find(row=>row.action==='history-load'&&row.threadId===f.a&&row.state==='rejected')!;
  assert.equal(rejection.errorCode,'FRAME_LIMIT');assert.ok(rejection.finishedAt);
  const stored=JSON.parse((f.reader.prepare('SELECT payload FROM actions WHERE id=?').get(rejection.requestId)as {payload:string}).payload);
  assert.equal(stored.state,'rejected');assert.equal(stored.errorCode,'FRAME_LIMIT');assert.equal(f.maxLive(),1);
  assert.equal(f.posts.some(row=>['turn-start','grant-assets','grant-writes'].includes(row.action)),false);
});

for(const change of ['active','unknown','operation','approval','writes','assets','busy','limited','connection','session','selection','account','binding','saved','receipt','stale']as const)
test('fresh '+change+' evidence after held history refusal blocks disconnect',async t=>{
  const gate=historyGate(t),f=await historyNavigationFixture(t);
  f.setHistoryHook(async id=>{if(id===f.a){gate.entered();await gate.wait;throw new CodexClientError('FRAME_LIMIT','Synthetic large history.',true);}});
  const switching=f.chat.openSavedChat(f.b);await gate.started;
  if(change==='stale')f.beforeGet(async()=>{throw new Error('Synthetic unavailable current state');});
  else f.transformState(value=>{
    const next=structuredClone(value),s=next.snapshot!,thread=s.thread!;
    if(change==='active'){thread.turnStatus='inProgress';thread.turnId='live-turn';}
    if(change==='unknown')thread.turnStatus='unknown';
    if(change==='operation')s.operations=[{operationId:'pending-op',method:'turn/start',requestId:9,threadId:f.a,turnId:null,state:'pending',errorCode:null}];
    if(change==='approval')s.approvals=[{handle:'pending-review',connectionId:s.connectionId,threadId:f.a,turnId:'review-turn',itemId:'command',serverRequestId:7,method:'item/commandExecution/requestApproval',reason:null,command:'synthetic',cwd:f.projectPath,changes:null,canAccept:false,expiresAt:Date.now()+10000}];
    if(change==='writes')thread.writeGranted=true;
    if(change==='assets')next.nativeAssets={available:true,sealed:true,granted:true,admissionOpen:false};
    if(change==='busy')next.busy=true;
    if(change==='limited')next.displayLimited=true;
    if(change==='connection')s.connectionId='11111111-1111-4111-8111-111111111111';
    if(change==='session')thread.sessionId='foreign-session';
    if(change==='selection')thread.selection={model:'fixture-alt',effort:'high'};
    if(change==='account')s.account={auth:'signed-out',plan:null,requiresOpenaiAuth:true};
    if(change==='binding')next.nativeHistory=null;
    if(change==='saved')next.nativeThreads=next.nativeThreads!.filter(row=>row.threadId!==f.a);
    if(change==='receipt')next.actions=next.actions.filter(row=>row.action!=='history-load'||row.threadId!==f.a);
    return next;
  });
  gate.release();assert.equal(await switching,false);assert.deepEqual(f.posts.map(row=>row.action),['history-load']);assert.equal(f.recording(),f.originalRecording);
});

for(const reply of ['pending','unknown','TIMEOUT','JOURNAL_FAILURE','PROTOCOL','wrong-thread','wrong-connection','wrong-request','unfinished','lost']as const)
test('outgoing history '+reply+' reply cannot become a successful lifecycle action',async t=>{
  const f=await historyNavigationFixture(t);f.limit();
  f.transformReply((outcome,input)=>{
    if(input.action!=='history-load'||input.threadId!==f.a)return outcome;
    if(reply==='lost')throw new Error('Synthetic lost HTTP acknowledgement');
    const value=structuredClone(outcome);
    if(reply==='pending'||reply==='unknown')value.record.state=reply;
    else if(reply==='wrong-thread')value.record.threadId='foreign-thread';
    else if(reply==='wrong-connection')value.record.connectionId=randomUUID();
    else if(reply==='wrong-request')value.record.requestId=randomUUID();
    else if(reply==='unfinished')value.record.finishedAt=null;
    else value.record.errorCode=reply;
    return value;
  });
  assert.equal(await f.chat.openSavedChat(f.b),false);assert.deepEqual(f.posts.map(row=>row.action),['history-load']);assert.equal(f.recording(),f.originalRecording);
});

for(const phase of ['initial-refresh','held-history']as const)for(const change of ['project-away-back','provider-away-back','stop','source-tab']as const)
test(phase+' cannot regain navigation authority after '+change,async t=>{
  const gate=historyGate(t),f=await historyNavigationFixture(t);
  if(phase==='initial-refresh')f.beforeGet(async()=>{gate.entered();await gate.wait;});
  else f.setHistoryHook(async id=>{if(id===f.a){gate.entered();await gate.wait;throw new CodexClientError('FRAME_LIMIT','Synthetic large history.',true);}});
  const switching=f.chat.openSavedChat(f.b);await gate.started;
  if(change==='project-away-back'){
    const internal=f.chat as unknown as {applyState(value:ChatState):void},baseline=f.service.state();
    internal.applyState(state(f.projectPath+'-away'));internal.applyState(baseline);
  }else if(change==='provider-away-back'){f.chat.setChatProviderPreference('claude');f.chat.setChatProviderPreference('codex');}
  else if(change==='stop')f.chat.stop();
  else (f.chat as unknown as {tabs:ChatTabs}).tabs.createDraft();
  gate.release();assert.equal(await switching,false);
  assert.deepEqual(f.posts.map(row=>row.action),phase==='initial-refresh'?[]:['history-load']);
  assert.equal(f.recording(),f.originalRecording);
});

test('a failed durable history rejection commit blocks navigation and retains the unresolved receipt',async t=>{
  const f=await historyNavigationFixture(t);f.limit();
  f.reader.exec("CREATE TRIGGER reject_history_receipt BEFORE UPDATE OF payload ON actions WHEN json_extract(NEW.payload,'$.action')='history-load' BEGIN SELECT RAISE(FAIL,'synthetic journal rejection'); END");
  try{
    assert.equal(await f.chat.openSavedChat(f.b),false);assert.deepEqual(f.posts.map(row=>row.action),['history-load']);assert.equal(f.recording(),f.originalRecording);
    const row=f.reader.prepare("SELECT payload FROM actions WHERE json_extract(payload,'$.state')='pending'").get()as {payload:string};
    assert.ok(row);assert.equal(JSON.parse(row.payload).action,'history-load');
  }finally{f.reader.exec('DROP TRIGGER reject_history_receipt');}
});

test('target history failure keeps its own truthful notice after outgoing FRAME_LIMIT navigation',async t=>{
  const f=await historyNavigationFixture(t);
  f.setHistoryHook(async id=>{throw new CodexClientError(id===f.a?'FRAME_LIMIT':'TIMEOUT','Synthetic isolated history failure.',true);});
  assert.equal(await f.chat.openSavedChat(f.b),true);assert.equal(f.chat.currentStateView().conversation!.threadId,f.b);
  const notice=f.doc.getElementById('codex-notice').textContent;
  assert.match(notice,/history-load.*rejected/);assert.notEqual(notice,HISTORY_LIMIT_NOTICE);assert.equal(f.recording(),f.originalRecording);
});

test('FRAME_LIMIT on disconnect remains a rejected lifecycle action and prevents reconnect',async t=>{
  const f=await historyNavigationFixture(t);f.limit();
  f.transformReply((outcome,input)=>input.action==='disconnect'?{...outcome,record:{...outcome.record,state:'rejected',errorCode:'FRAME_LIMIT'}}:outcome);
  assert.equal(await f.chat.openSavedChat(f.b),false);assert.deepEqual(f.posts.map(row=>row.action),['history-load','disconnect']);
  assert.notEqual(f.doc.getElementById('codex-notice').textContent,HISTORY_LIMIT_NOTICE);
});

test('outgoing history limit with no prior recording does not invent saved history or claim a successful read',async t=>{
  const f=await historyNavigationFixture(t);
  f.reader.prepare('UPDATE native_threads SET payload=NULL WHERE thread_id=?').run(f.a);
  f.reader.prepare('UPDATE native_history SET payload=NULL WHERE thread_id=?').run(f.a);
  await f.chat.refresh();assert.equal(f.service.state().nativeHistory!.recorded,null);
  f.doc.getElementById('codex-composer').value='Keep the unhydrated draft';f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));f.limit();
  assert.equal(await f.chat.openSavedChat(f.b),true);assert.equal(f.recording(),null);
  const oldTab=f.chat.chatTabsView().find(row=>row.threadId===f.a)!;assert.equal(oldTab.draft,'Keep the unhydrated draft');
  const recording=(f.chat as unknown as {tabs:ChatTabs}).tabs.recording(oldTab);assert.ok(recording);assert.equal(recording.recorded,null);
  assert.equal(f.doc.getElementById('codex-notice').textContent,'Opened this conversation. The previous conversation\u2019s history exceeded the display limit; no earlier recording was available. Your unsent draft was retained.');
  const failure=f.service.state().actions.find(row=>row.action==='history-load'&&row.threadId===f.a&&row.state==='rejected')!;
  assert.equal(failure.errorCode,'FRAME_LIMIT');assert.equal(failure.state,'rejected');
});

// D4-111: a background poll must not fence a tab transition's own acknowledged receipt.
const WAITING='Waiting for confirmation\u2026',drain=async()=>{for(let i=0;i<20;i++)await tick();};
async function stagedDraft(f:Awaited<ReturnType<typeof historyNavigationFixture>>,text='') {
  assert.equal(await f.chat.newChat(),true);
  f.doc.getElementById('codex-model').value='fixture-alt';f.doc.getElementById('codex-effort').value='high';f.doc.getElementById('codex-select').dispatchEvent(new Event('click'));await tick();
  if(text){f.doc.getElementById('codex-composer').value=text;f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));}
  f.posts.length=0;
}
for(const path of ['resume-from-draft','resume-from-native','start-from-draft','first-send-from-draft']as const)
test('a scheduled poll observing the held acknowledged '+path+' receipt cannot fence the transition',async t=>{
  const gate=historyGate(t),f=await historyNavigationFixture(t,{timers:true}),held=path.startsWith('resume')?'thread-resume':'thread-start';
  if(path==='resume-from-draft'||path==='start-from-draft')await stagedDraft(f);
  if(path==='first-send-from-draft')await stagedDraft(f,'Build a simple cube');
  let gets=0;f.beforeGet(async()=>{gets++;});
  f.holdReply(async input=>{if(input.action===held){gate.entered();await gate.wait;}});
  const running=path.startsWith('resume')?f.chat.openSavedChat(f.b):path==='start-from-draft'?f.chat.startCurrentChat():
    (f.chat as unknown as {submitMessage():Promise<void>}).submitMessage().then(()=>true);
  await gate.started;
  // The service journal already acknowledged the thread; only its HTTP reply is held.
  const acknowledged=f.service.state().snapshot!.thread!;assert.equal(acknowledged.configured,true);
  if(held==='thread-resume')assert.equal(acknowledged.threadId,f.b);
  gets=0;t.mock.timers.tick(1500);await drain();const polled=gets;
  gate.release();assert.equal(await running,true);
  const expected=['history-load','disconnect','connect','select',held];
  if(held==='thread-resume')expected.push('history-load');
  if(path==='first-send-from-draft')expected.push('turn-start');
  assert.deepEqual(f.posts.map(row=>row.action),expected);
  assert.equal(f.chat.currentStateView().nativeBoundToActiveChat,true);
  assert.equal(f.chat.currentStateView().conversation!.threadId,acknowledged.threadId);
  if(held==='thread-resume')assert.match(f.doc.getElementById('codex-messages').textContent,new RegExp('Public answer for '+f.b));
  if(path==='first-send-from-draft'){const sent=f.posts.at(-1) as Extract<ChatAction,{action:'turn-start'}>;assert.equal(sent.threadId,acknowledged.threadId);assert.equal(sent.text,'Build a simple cube');}
  else assert.notEqual(f.doc.getElementById('codex-notice').textContent,WAITING);
  assert.equal(polled,0,'the scheduled background poll is suppressed during the transition');
  // Background polling resumes after the transition (an open panel keeps the idle poll active).
  f.doc.getElementById('codex-panel').open=true;gets=0;t.mock.timers.tick(1500);await drain();assert.ok(gets>0,'the scheduled poll keeps rescheduling');
});

test('a background poll already in flight when a saved-chat transition begins cannot apply its late state',async t=>{
  const initial=historyGate(t),poll=historyGate(t),resume=historyGate(t),f=await historyNavigationFixture(t,{timers:true});
  await stagedDraft(f);f.doc.getElementById('codex-panel').open=true;
  let gets=0;f.beforeGet(async()=>{gets++;if(gets===1){initial.entered();await initial.wait;}else if(gets===2){poll.entered();await poll.wait;}});
  f.holdReply(async input=>{if(input.action==='thread-resume'){resume.entered();await resume.wait;}});
  const switching=f.chat.openSavedChat(f.b);await initial.started;
  t.mock.timers.tick(1500);await poll.started; // The scheduled poll is now in flight before the transition starts.
  initial.release();await resume.started;
  poll.release();await drain(); // Its GET now reads the acknowledged resume.
  resume.release();assert.equal(await switching,true);
  assert.deepEqual(f.posts.map(row=>row.action),['history-load','disconnect','connect','select','thread-resume','history-load']);
  assert.equal(f.chat.currentStateView().conversation!.threadId,f.b);assert.equal(f.chat.currentStateView().nativeBoundToActiveChat,true);
  assert.notEqual(f.doc.getElementById('codex-notice').textContent,WAITING);
});

for(const change of ['project-away-back','stop','explicit-foreign-connection']as const)
test('a held acknowledged resume is still fenced by '+change,async t=>{
  const gate=historyGate(t),f=await historyNavigationFixture(t,{timers:true});await stagedDraft(f);
  f.holdReply(async input=>{if(input.action==='thread-resume'){gate.entered();await gate.wait;}});
  const switching=f.chat.openSavedChat(f.b);await gate.started;
  if(change==='project-away-back'){
    const internal=f.chat as unknown as {applyState(value:ChatState):void},baseline=f.service.state();
    internal.applyState(state(f.projectPath+'-away'));internal.applyState(baseline);
  }else if(change==='stop')f.chat.stop();
  else {f.transformState(value=>({...value,snapshot:{...value.snapshot!,connectionId:'11111111-1111-4111-8111-111111111111'}}));await f.chat.refresh();}
  gate.release();assert.equal(await switching,false);
  assert.deepEqual(f.posts.map(row=>row.action),['history-load','disconnect','connect','select','thread-resume']);
  assert.notEqual(f.chat.currentStateView().nativeBoundToActiveChat,true);
});

test('F2: while the Claude surface is active, sidebar New chat and Ctrl/Cmd+N start a Claude chat instead of a Codex draft',()=>{
  const doc=new DocumentFixture();let surface:'codex'|'claude'='claude',created=0,claude=0,navigations=0;
  const options={storage:memoryStorage(),captureLegacyNewChat:true,beforeNewChat:()=>{navigations++;},
    alternateNewChat:{active:()=>surface==='claude',start:()=>{claude++;}}};
  const tabs=new ChatTabs(doc.asDocument(),value=>value,{...callbacks,newChat:async()=>{created++;return true;}},options);
  tabs.sync(state());tabs.mount();tabs.render(false);
  const click=new Event('click',{cancelable:true});doc.getElementById('new-chat').dispatchEvent(click);
  assert.equal(click.defaultPrevented,true);assert.equal(claude,1);assert.equal(created,0);assert.equal(navigations,1);
  assert.equal(newChatShortcut(doc).defaultPrevented,true);assert.equal(newChatShortcut(doc,{metaKey:true},'N').defaultPrevented,true);
  assert.equal(claude,3);assert.equal(created,0);assert.equal(tabs.views().length,1,'no Codex draft tab is created');
  // A busy Codex chat or a full tab strip never blocks the Claude surface's New chat.
  tabs.render(true);assert.equal(doc.getElementById('new-chat').disabled,false);
  doc.getElementById('new-chat').dispatchEvent(new Event('click',{cancelable:true}));assert.equal(claude,4);
  surface='codex';tabs.render(true);assert.equal(doc.getElementById('new-chat').disabled,true);
  newChatShortcut(doc);assert.equal(claude,4);assert.equal(created,0,'busy Codex still blocks its own New chat');
  tabs.render(false);
  doc.getElementById('new-chat').dispatchEvent(new Event('click',{cancelable:true}));newChatShortcut(doc);
  assert.equal(created,2);assert.equal(claude,4,'Codex surface behaviour is unchanged');assert.equal(navigations,6);
  tabs.stop();surface='claude';newChatShortcut(doc);assert.equal(claude,4,'never routes after stop');
});

test('F2: a throwing surface probe falls back to the Codex New chat',()=>{
  const doc=new DocumentFixture();let created=0;
  const options={storage:memoryStorage(),captureLegacyNewChat:true,alternateNewChat:{active:():boolean=>{throw new Error('probe');},start:()=>{assert.fail('not routed');}}};
  const tabs=new ChatTabs(doc.asDocument(),value=>value,{...callbacks,newChat:async()=>{created++;return true;}},options);
  tabs.sync(state());tabs.mount();tabs.render(false);newChatShortcut(doc);assert.equal(created,1);tabs.stop();
});

test('new chats inherit model and effort across tab closure and persisted workspace reloads',async()=>{
  const storage=memoryStorage(),doc=new DocumentFixture();
  const tabs=new ChatTabs(doc.asDocument(),value=>value,callbacks,{storage});
  tabs.sync(state());
  const choice={model:'gpt-6.1-sol',effort:'low'};
  tabs.updateDraft('Unsent text stays in its own chat',choice);
  const first=tabs.active()!;
  assert.deepEqual(tabs.createDraft()!.selection,choice);
  assert.equal(tabs.active()!.draft,'');
  assert.equal(tabs.views().find(row=>row.key===first.key)!.draft,'Unsent text stays in its own chat');
  tabs.remove(first.key);
  const restored=new ChatTabs(new DocumentFixture().asDocument(),value=>value,callbacks,{storage});
  restored.sync(state());
  assert.deepEqual(restored.createDraft()!.selection,choice);
  const other={model:'fixture-alt',effort:'high'};
  restored.updateDraft('',other);
  assert.deepEqual(restored.createDraft()!.selection,other);
  restored.sync(state('C:/fixture/other-project'));
  assert.equal(restored.active()!.selection,null,'project preferences stay separate');
  tabs.stop();restored.stop();
});
