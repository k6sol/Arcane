import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatTabs, connectChatTabPreferences, workspacePreferencesAdapter, type ChatTabPreferences, type StartChatTabsOptions } from '../../apps/desktop/src/chat-tabs.js';
import type { ChatState, ChatStateView } from '../../apps/desktop/src/codex-chat.js';

// Local controller fixtures only: no provider, Electron profile, Studio or inference.
const project='/fixture/performance';
const state=(projectPath=project):ChatState=>({provider:'codex',use:'personal-local',projectPath,connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeThreads:[],nativeHistory:null,nativeTools:{configured:true,verified:false}});
const callbacks={select:async()=>true,close:async()=>true,newChat:async()=>true,openSaved:async()=>true};
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
class NodeFixture extends EventTarget {
  children:NodeFixture[]=[];dataset:Record<string,string>={};textContent='';title='';className='';type='';disabled=false;tabIndex=0;rebuilds=0;
  private attributes=new Map<string,string>();
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  getAttribute(key:string){return this.attributes.get(key)??null;}
  append(...nodes:NodeFixture[]){this.children.push(...nodes);}
  replaceChildren(...nodes:NodeFixture[]){this.rebuilds++;this.children=nodes;}
  querySelectorAll(){return [];}
  after(..._nodes:NodeFixture[]){}remove(){}focus(){}
}
class DocFixture extends EventTarget {
  defaultView={CustomEvent};activeElement=null;
  mount=new NodeFixture();create=new NodeFixture();created:NodeFixture[]=[];
  constructor(){super();this.mount.setAttribute('role','tablist');}
  getElementById(id:string){return id==='workspace-chat-tabs'?this.mount:id==='workspace-new-chat'?this.create:null;}
  createElement(){const node=new NodeFixture();this.created.push(node);return node;}
  get document(){return this as unknown as Document;}
}
function fixture(t:test.TestContext) {
  const doc=new DocFixture(),data=new Map<string,string>();let writes=0,cleans=0;
  const tabs=new ChatTabs(doc.document,value=>{cleans++;return value;},callbacks,{storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>{writes++;data.set(key,value);}}});
  tabs.sync(state());t.after(()=>tabs.stop());
  const saved=(path=project)=>JSON.parse(data.get('arcane.chat-tabs.v1:'+encodeURIComponent(path))!) as {activeKey:string;tabs:{key:string;draft:string}[]};
  return {tabs,doc,saved,get writes(){return writes;},get cleans(){return cleans;}};
}

test('typing saves the leading and latest drafts; no-op input/polls do not reset debounce or serialize preferences',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),start=f.writes;
  f.tabs.updateDraft('a');assert.equal(f.writes,start+1);assert.equal(f.tabs.preferencesSaved(),true);
  f.tabs.updateDraft('ab');f.tabs.updateDraft('abc');assert.equal(f.tabs.active()!.draft,'abc');assert.equal(f.tabs.preferencesSaved(),false);
  const cleans=f.cleans;
  for(let i=0;i<50;i++){f.tabs.updateDraft('abc');f.tabs.sync(state());f.tabs.render(false);}
  assert.equal(f.writes,start+1);assert.equal(f.cleans,cleans);
  t.mock.timers.tick(150);assert.equal(f.writes,start+2);assert.equal(f.saved().tabs[0]!.draft,'abc');assert.equal(f.tabs.preferencesSaved(),true);
  t.mock.timers.tick(1000);assert.equal(f.writes,start+2);
});

test('tab creation, selection, presentation, provider and stop flush the latest draft before debounce',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),first=f.tabs.active()!.key;
  const edit=(text:string)=>{f.tabs.updateDraft(text+' first');f.tabs.updateDraft(text);};
  const hasDraft=(key:string,text:string)=>assert.equal(f.saved().tabs.find(row=>row.key===key)!.draft,text);
  edit('before new tab');const second=f.tabs.createDraft()!.key;hasDraft(first,'before new tab');
  edit('before selection');f.tabs.activate(first);hasDraft(second,'before selection');
  edit('before preview');f.tabs.updatePresentation({previewOpen:true});hasDraft(first,'before preview');
  edit('before provider');f.tabs.setProviderPreference('claude');hasDraft(first,'before provider');
  edit('before lifecycle stop');f.tabs.stop();hasDraft(first,'before lifecycle stop');
  const writes=f.writes;t.mock.timers.tick(1000);assert.equal(f.writes,writes);
});

test('project boundaries flush outgoing text and switching back restores exact per-tab draft',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
  f.tabs.updateDraft('first');f.tabs.updateDraft('exact outgoing draft\n  ');f.tabs.sync(state(project+'-other'));
  assert.equal(f.saved().tabs[0]!.draft,'exact outgoing draft\n  ');
  f.tabs.updateDraft('other first');f.tabs.updateDraft('other latest');f.tabs.sync(state());
  assert.equal(f.tabs.active()!.draft,'exact outgoing draft\n  ');assert.equal(f.saved(project+'-other').tabs[0]!.draft,'other latest');
});

test('selection-only catalogue changes preserve tab/menu nodes; ownership loss and blocking render immediately',t=>{
  const f=fixture(t),s=state();s.nativeThreads=[{provider:'codex',projectPath:project,threadId:'owned',sessionId:'session-a',selection:{model:'fixture-model',effort:'low'}}];
  f.tabs.sync(s);const native=f.tabs.ensureSaved('owned')!;f.tabs.activate(native.key);f.tabs.mount();f.tabs.render(false);
  const button=f.doc.mount.children[0]!.children[0],menu=f.doc.created.find(node=>node.className==='chat-tabs-history')!;
  const rebuilds=f.doc.mount.rebuilds,menuRebuilds=menu.rebuilds;
  s.nativeThreads[0]!.selection!.effort='high';f.tabs.sync(s);f.tabs.render(false);
  assert.equal(f.doc.mount.rebuilds,rebuilds);assert.equal(menu.rebuilds,menuRebuilds);assert.equal(f.tabs.active()!.selection!.effort,'high');
  f.tabs.render(true);assert.equal(f.doc.mount.rebuilds,rebuilds+1);assert.equal(menu.rebuilds,menuRebuilds+1);
  s.nativeThreads[0]!.sessionId='session-b';f.tabs.sync(s);f.tabs.render(true);
  assert.equal(f.tabs.active()!.kind,'draft');assert.equal(f.tabs.owns(native),false);assert.notEqual(f.doc.mount.children[0]!.children[0],button);
});

test('native save ACK cannot mark a newer debounced draft saved; latest text queues on stop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const doc=new DocFixture();
  const writes:ChatTabPreferences[]=[],acks:(()=>void)[]=[];
  const tabs=new ChatTabs(doc.document,value=>value,callbacks,{preferences:{read:async()=>null,save:value=>{writes.push(value);return new Promise<void>(resolve=>acks.push(resolve));}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(project);tabs.sync(state());acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),true);
  tabs.updateDraft('leading');tabs.updateDraft('latest');assert.equal(tabs.preferencesSaved(),false);
  acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),false,'leading ACK does not cover the newer in-memory edit');
  tabs.stop();assert.equal(writes.at(-1)!.tabs[0]!.draft,'latest');assert.equal(tabs.preferencesSaved(),false);
  acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),true);const count=writes.length;
  t.mock.timers.tick(1000);assert.equal(writes.length,count);
});

test('overlapping project reads and stale save failures never apply to the new native scope',async t=>{
  const doc=new DocFixture(),reads:((value:unknown)=>void)[]=[],saves:ChatTabPreferences[]=[];
  let failOld!:(reason:Error)=>void;
  const tabs=new ChatTabs(doc.document,value=>value,callbacks,{preferences:{read:()=>new Promise(resolve=>reads.push(resolve)),save:value=>{saves.push(value);return value.projectPath===project?new Promise((_resolve,reject)=>{failOld=reject;}):Promise.resolve();}}});
  t.after(()=>tabs.stop());const initial=tabs.initializePreferences(project);reads.shift()!(null);await initial;tabs.sync(state());
  tabs.updateDraft('outgoing');tabs.sync(state(project+'-new'));assert.ok(saves.every(value=>value.projectPath===project));
  const older=tabs.initializePreferences(project),newer=tabs.initializePreferences(project+'-new');reads[1]!(null);await newer;reads[0]!(null);await older;
  tabs.reloadPreferences(state(project+'-new'));assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.preferencesSaved(),false);
  failOld(new Error('Fixture stale failure'));await flush();assert.equal(saves.at(-1)!.projectPath,project+'-new');assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.preferencesSaved(),true);
});

test('returning to an acknowledged value still waits for an older in-flight write and corrective ACK',async t=>{
  const doc=new DocFixture(),acks:(()=>void)[]=[];
  const tabs=new ChatTabs(doc.document,text=>text,callbacks,{preferences:{read:async()=>null,save:()=>new Promise<void>(resolve=>acks.push(resolve))}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(project);tabs.sync(state());acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),true);
  tabs.updateDraft('changed');tabs.updateDraft('');tabs.stop();assert.equal(tabs.preferencesSaved(),false);
  acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),false,'the older write can still overwrite the acknowledged empty draft');
  acks.shift()!();await flush();assert.equal(tabs.preferencesSaved(),true);
});

test('returning to a previously read project after a scope change still requires a fresh native read',async t=>{
  const doc=new DocFixture(),tabs=new ChatTabs(doc.document,text=>text,callbacks,{preferences:{read:async()=>null,save:async()=>{}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(project);tabs.sync(state());await flush();
  tabs.sync(state(project+'-other'));tabs.sync(state());assert.equal(tabs.persistenceStatus(),'native-loading');assert.equal(tabs.needsNativePreferences(project),true);
  await tabs.initializePreferences(project);tabs.reloadPreferences(state());await flush();assert.equal(tabs.persistenceStatus(),'native');
});

test('new project read restores its acknowledged draft rather than overwriting it with the temporary loading tab',async t=>{
  const doc=new DocFixture(),saves:ChatTabPreferences[]=[];let value:ChatTabPreferences|null=null;
  const tabs=new ChatTabs(doc.document,text=>text,callbacks,{preferences:{read:async()=>value,save:async saved=>{saves.push(saved);}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(project);tabs.sync(state());await flush();tabs.sync(state(project+'-new'));
  const localId=crypto.randomUUID();value={version:1,projectPath:project+'-new',provider:'claude',activeTabId:localId,tabs:[{localId,title:'Draft',provider:'codex',threadId:null,sessionId:null,draft:'Acknowledged project draft',modelId:null,effort:null,tool:'all',previewOpen:false}]};
  await tabs.initializePreferences(project+'-new');tabs.reloadPreferences(state(project+'-new'));await flush();
  assert.equal(tabs.active()!.draft,'Acknowledged project draft');assert.equal(tabs.providerPreference(),'claude');assert.equal(saves.at(-1)!.tabs[0]!.draft,'Acknowledged project draft');
});

test('debounced native persistence still requires an exact successful bridge ACK',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const doc=new DocFixture();let ack:unknown={saved:true};
  const preferences=workspacePreferencesAdapter(doc.document,{nativeBridge:Object.freeze({version:1,read:async()=>({available:true,preferences:null}),save:async()=>ack})})!;
  const tabs=new ChatTabs(doc.document,text=>text,callbacks,{preferences});t.after(()=>tabs.stop());await tabs.initializePreferences(project);tabs.sync(state());await flush();
  assert.equal(tabs.preferencesSaved(),true);tabs.updateDraft('leading');await flush();tabs.updateDraft('latest');ack={saved:true,extra:'fixture-invalid'};
  t.mock.timers.tick(150);await flush();assert.equal(tabs.persistenceStatus(),'native-error');assert.equal(tabs.preferencesSaved(),false);assert.equal(tabs.active()!.draft,'latest');
});

test('provider restoration reads one public view per window and cancels queued reads on lifecycle stop',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const doc=new DocFixture(),listeners=new Set<()=>void>();let reads=0,events=0;
  let view={state:state(),fresh:true,persistence:'browser-origin',preferredProvider:'codex'} as ChatStateView;
  const chat={enableChatTabs:async()=>{},currentStateView:()=>{reads++;return view;},setChatProviderPreference:()=>{},subscribeStateChange:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}} satisfies StartChatTabsOptions['chat'];
  doc.addEventListener('workspace:preferencesrestored',()=>events++);const controller=connectChatTabPreferences(doc.document,chat);t.after(()=>controller.cleanup());
  assert.equal(reads,1);assert.equal(events,1);for(let i=0;i<120;i++)for(const listener of listeners)listener();
  assert.equal(reads,1);t.mock.timers.tick(100);assert.equal(reads,2);assert.equal(events,1);
  for(const listener of listeners)listener();controller.stop();t.mock.timers.tick(100);assert.equal(reads,2);
  controller.resume();assert.equal(reads,3);assert.equal(events,1);
  view={...view,fresh:false};for(const listener of listeners)listener();t.mock.timers.tick(100);assert.equal(events,1,'stale views cannot restore preferences');
});
