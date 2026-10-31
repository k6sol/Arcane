import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ChatTabs, type ChatTabPreferences } from '../../apps/desktop/src/chat-tabs.js';
import { CodexChat, CodexChatApi, CodexHttpError, readCodexState, type ChatState, type ChatActionRecord, type ConnectNoticeReview } from '../../apps/desktop/src/codex-chat.js';
import { createCodexService } from '../../apps/daemon/src/codex-service.js';
import { CodexClientError, type Snapshot } from '../../packages/codex-client/src/types.js';
import type { ChatQueueSnapshot, StoredChatQueueRow } from '../../packages/protocol/src/chat-queue.js';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';

// Document/transport fixtures only. No CLI, provider, Studio or UI.
const TOKEN='b'.repeat(64), PROJECT=resolve('.');
const tick=()=>new Promise<void>(done=>setImmediate(done));
const settle=async(count=12)=>{for(let i=0;i<count;i++)await tick();};
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
const callbacks={select:async()=>true,close:async()=>true,newChat:async()=>true,openSaved:async()=>true};
function snapshot():Snapshot{return {connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,
  account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},models:[
    {model:'fixture-sol',id:'sol',displayName:'Fixture Sol',efforts:['low','high'],defaultEffort:'low',entitlement:'unverified'},
  ],selection:{model:'fixture-sol',effort:'low'},thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};}
function state(withThread=false):ChatState{
  const value:ChatState={provider:'codex',use:'personal-local',projectPath:PROJECT,connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeThreads:[],nativeHistory:null,nativeTools:{configured:true,verified:false}};
  if(withThread){value.snapshot=snapshot();value.snapshot.thread={threadId:'send-thread',sessionId:null,selection:{model:'fixture-sol',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};}
  return value;
}
function plainRow(draft:string){const localId=randomUUID();return {localId,preferences:{version:1,projectPath:PROJECT,provider:'codex',activeTabId:localId,
  tabs:[{localId,title:'Draft',provider:'codex',threadId:null,sessionId:null,draft,modelId:null,effort:null,tool:'all',previewOpen:false}]} satisfies ChatTabPreferences};}

test('L1: a plain draft restored from native preferences is not treated as a workflow draft and needs no review',async t=>{
  const tabs=new ChatTabs(new DocumentFixture().asDocument(),value=>value,callbacks,{preferences:{read:async()=>plainRow('Plain typed draft').preferences,save:async()=>{}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(PROJECT);tabs.sync(state());
  assert.equal(tabs.active()!.draft,'Plain typed draft');assert.equal(tabs.active()!.workflowDraft,false);
  const doc=new DocumentFixture(),observed=state(true);
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.enableChatTabs({preferences:{read:async()=>plainRow('Plain typed draft after restart').preferences,save:async()=>{}}});await settle();
  assert.equal(doc.getElementById('codex-composer').value,'Plain typed draft after restart');
  assert.equal(chat.currentStateView().activeChat!.workflowDraft,false);
  assert.equal(doc.getElementById('codex-draft-review').hidden,true,'a plain restored draft is not blocked behind workflow review');
  assert.doesNotMatch(doc.getElementById('codex-draft-review-notice').textContent,/Restored draft/);
});

test('L2: a failed native preference save is retried on the next change instead of disabling persistence for the session',async t=>{
  let fail=true;const saves:ChatTabPreferences[]=[],attempts:string[]=[];
  const tabs=new ChatTabs(new DocumentFixture().asDocument(),value=>value,callbacks,{preferences:{read:async()=>null,save:async value=>{
    attempts.push(value.tabs[0]!.draft);await tick();if(fail)throw new Error('Synthetic transient save failure');saves.push(structuredClone(value));}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(PROJECT);tabs.sync(state());await settle();
  fail=true;tabs.updateDraft('first edit');await settle();
  assert.equal(tabs.persistenceStatus(),'native-error');assert.equal(tabs.preferencesSaved(),false,'the unsaved state is exposed');
  // An unchanged persist boundary retries the retained snapshot.
  fail=false;tabs.updatePresentation({});await settle();
  assert.equal(saves.at(-1)?.tabs[0]!.draft,'first edit','the retained snapshot is retried');
  assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.preferencesSaved(),true);
  fail=true;tabs.updateDraft('second edit');await settle();assert.equal(tabs.persistenceStatus(),'native-error');
  fail=false;tabs.updateDraft('third edit');await new Promise(done=>setTimeout(done,200));await settle();
  assert.equal(saves.at(-1)?.tabs[0]!.draft,'third edit','later edits are saved after a failure');
  assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.preferencesSaved(),true);
  assert.ok(attempts.length<=8,'no unbounded retry loop');
});

test('L2: a failed native preference save shows an unsaved notice in the chat panel',async t=>{
  const doc=new DocumentFixture(),observed=state(true);let fail=false;
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.enableChatTabs({preferences:{read:async()=>null,save:async()=>{await tick();if(fail)throw new Error('Synthetic save failure');}}});await settle();
  fail=true;chat.updateChatPresentation({tool:'blender'});await settle();
  assert.equal(chat.currentStateView().preferencesSaved,false);
  assert.match(doc.getElementById('codex-notice').textContent,/could not be saved/i);
});

for(const reply of ['rejected-409','refused-400','pending-202','unknown-500'] as const)
test('L3: turn-start '+reply+(reply.startsWith('rejected')||reply.startsWith('refused')?' restores':' does not restore')+' the composer text',async t=>{
  const doc=new DocumentFixture(),observed=state(true);let posts=0;
  const api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(init?.method==='GET')return Response.json({state:observed});
    posts++;const input=JSON.parse(String(init?.body));
    if(reply==='refused-400')return Response.json({error:'Synthetic refusal'},{status:400});
    if(reply==='unknown-500')return Response.json({error:'Synthetic outage'},{status:500});
    const recordState=reply==='rejected-409'?'rejected':'pending',now=new Date().toISOString();
    return Response.json({replayed:false,state:observed,record:{requestId:input.requestId,action:input.action,connectionId:input.connectionId,state:recordState,
      errorCode:recordState==='rejected'?'FIXTURE_REJECTED':null,threadId:input.threadId,turnId:null,model:null,effort:null,createdAt:now,finishedAt:recordState==='rejected'?now:null}},
      {status:recordState==='rejected'?409:202});
  });
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.start();await settle();
  const composer=doc.getElementById('codex-composer');composer.value='Please keep this message';composer.dispatchEvent(new Event('input'));
  assert.equal(doc.getElementById('codex-submit').disabled,false);
  doc.getElementById('codex-compose').dispatchEvent(new Event('submit',{cancelable:true}));await settle(30);
  assert.equal(posts,1,'exactly one send; never retried');
  if(reply==='rejected-409'||reply==='refused-400')assert.equal(composer.value,'Please keep this message');
  else assert.equal(composer.value,'','an uncertain send never restores text that could be sent twice');
});

// F1: the native row carries an optional workflowDraft flag. Rows are cast so legacy shapes stay expressible.
function flaggedRows(rows:Record<string,unknown>[]):ChatTabPreferences{
  const tabs=rows.map(row=>({localId:randomUUID(),title:'Draft',provider:'codex',threadId:null,sessionId:null,draft:'',modelId:null,effort:null,tool:'all',previewOpen:false,...row}));
  return {version:1,projectPath:PROJECT,provider:'codex',activeTabId:tabs[0]!.localId,tabs} as unknown as ChatTabPreferences;
}
async function restoredTabs(t:import('node:test').TestContext,value:ChatTabPreferences,saves:ChatTabPreferences[]=[]){
  const tabs=new ChatTabs(new DocumentFixture().asDocument(),text=>text,callbacks,{preferences:{read:async()=>structuredClone(value),save:async saved=>{saves.push(structuredClone(saved));}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(PROJECT);tabs.sync(state());await settle();return tabs;
}

test('F1: a workflow draft survives a native restart with its review gate',async t=>{
  const saves:ChatTabPreferences[]=[];
  const tabs=new ChatTabs(new DocumentFixture().asDocument(),value=>value,callbacks,{preferences:{read:async()=>null,save:async value=>{saves.push(structuredClone(value));}}});
  t.after(()=>tabs.stop());await tabs.initializePreferences(PROJECT);tabs.sync(state());
  tabs.updateDraft('Workflow generated draft',undefined,true);await new Promise(done=>setTimeout(done,200));await settle();
  const saved=saves.at(-1)!;
  assert.equal(saved.tabs[0]!.draft,'Workflow generated draft');
  assert.equal((saved.tabs[0] as {workflowDraft?:unknown}).workflowDraft,true,'the workflow provenance flag is written to the native row');
  const restarted=await restoredTabs(t,saved);
  assert.equal(tabs.persistenceStatus(),'native');assert.equal(restarted.persistenceStatus(),'native');
  assert.equal(restarted.active()!.workflowDraft,true);
  const doc=new DocumentFixture(),observed=state(true);
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.enableChatTabs({preferences:{read:async()=>structuredClone(saved),save:async()=>{}}});await settle();
  assert.equal(doc.getElementById('codex-composer').value,'Workflow generated draft');
  assert.equal(chat.currentStateView().activeChat!.workflowDraft,true);
  assert.equal(doc.getElementById('codex-draft-review').hidden,false,'a restored workflow draft keeps its review gate');
  assert.match(doc.getElementById('codex-draft-review-notice').textContent,/Restored draft/);
});

test('F1: plain and legacy native draft rows restore as sendable plain drafts and save an explicit false flag',async t=>{
  for(const row of [{draft:'Legacy typed draft'},{draft:'Explicit plain draft',workflowDraft:false}]){
    const saves:ChatTabPreferences[]=[];
    const tabs=await restoredTabs(t,flaggedRows([row]),saves);
    assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.active()!.draft,row.draft);assert.equal(tabs.active()!.workflowDraft,false);
    tabs.updateDraft(row.draft+'!');await settle();
    assert.equal((saves.at(-1)!.tabs[0] as {workflowDraft?:unknown}).workflowDraft,false);
  }
  const doc=new DocumentFixture(),observed=state(true);
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.enableChatTabs({preferences:{read:async()=>flaggedRows([{draft:'Plain flagged draft',workflowDraft:false}]),save:async()=>{}}});await settle();
  assert.equal(doc.getElementById('codex-composer').value,'Plain flagged draft');
  assert.equal(doc.getElementById('codex-draft-review').hidden,true);
  assert.doesNotMatch(doc.getElementById('codex-draft-review-notice').textContent,/Restored draft/,'a plain restored draft is not held behind workflow review');
});

test('F1: an unconfirmed native row becomes a Recovered draft that keeps only its stored workflow flag',async t=>{
  for(const [row,expected] of [[{threadId:'gone-thread',draft:'Recovered legacy text'},false],[{threadId:'gone-thread',draft:'Recovered plain text',workflowDraft:false},false],
    [{threadId:'gone-thread',draft:'Recovered workflow text',workflowDraft:true},true]] as const){
    const tabs=await restoredTabs(t,flaggedRows([row]));
    assert.equal(tabs.persistenceStatus(),'native');
    const active=tabs.active()!;
    assert.equal(active.title,'Recovered draft');assert.equal(active.kind,'draft');assert.equal(active.draft,row.draft);
    assert.equal(active.workflowDraft,expected,'a recovered draft is a workflow draft only when stored as one');
  }
});

test('F1: malformed workflowDraft values in native preferences are refused',async t=>{
  for(const workflowDraft of ['yes','true',1,0,null,{}]){
    const tabs=await restoredTabs(t,flaggedRows([{draft:'x',workflowDraft}]));
    assert.equal(tabs.persistenceStatus(),'native-error');
    assert.equal(tabs.active()?.draft??'','','a refused record never restores its text');
  }
});


test('desktop update waits for the newest typed draft to receive a native save acknowledgement',async t=>{
  const doc=new DocumentFixture(),observed=state(true),saves:ChatTabPreferences[]=[];let hold=false,release!:()=>void;
  const gate=new Promise<void>(done=>{release=done;});
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.start();await chat.enableChatTabs({preferences:{read:async()=>plainRow('Old saved draft').preferences,save:async value=>{if(hold)await gate;saves.push(structuredClone(value));}}});await settle();
  hold=true;const input=doc.getElementById('codex-composer');input.value='The newest unsent draft';input.dispatchEvent(new Event('input'));
  let finished=false;const pending=chat.prepareForRestart().then(()=>{finished=true;});await settle();
  assert.equal(finished,false,'Restart cannot leave while the native save is pending.');release();await pending;
  assert.equal(saves.at(-1)?.tabs[0]?.draft,'The newest unsent draft');assert.equal(chat.currentStateView().preferencesSaved,true);
});
test('desktop update keeps a failed native draft save in the current window',async t=>{
  const doc=new DocumentFixture(),observed=state(true);let fail=false,clock=1000;
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());
  await chat.start();await chat.enableChatTabs({preferences:{read:async()=>plainRow('Existing draft').preferences,save:async()=>{if(fail)throw Error('save failed');}}});await settle();
  fail=true;const input=doc.getElementById('codex-composer');input.value='Keep this draft';input.dispatchEvent(new Event('input'));
  t.mock.method(Date,'now',()=>clock);const pending=chat.prepareForRestart();const rejected=assert.rejects(pending,/draft could not be saved/);
  await settle();clock+=10001;await rejected;
  assert.equal(input.value,'Keep this draft');assert.equal(chat.currentStateView().preferencesSaved,false);
});

test('an empty workspace can update when tab preference storage is unavailable',async t=>{
  const doc=new DocumentFixture(),chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:state(true)})));t.after(()=>chat.stop());
  await chat.start();await chat.enableChatTabs({preferences:{read:async()=>{throw Error('Unavailable');},save:async()=>{throw Error('Unavailable');}}});
  await chat.prepareForRestart();assert.equal(doc.getElementById('codex-composer').value,'');
  assert.equal(chat.currentStateView().preferencesSaved,false,'allowing an empty restart does not pretend settings were saved');
});

test('restart retries a transient native save without needing another typed edit',async t=>{
  const doc=new DocumentFixture();let failures=0,clock=1000;const writes:ChatTabPreferences[]=[];
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:state(true)})));t.after(()=>chat.stop());
  await chat.start();await chat.enableChatTabs({preferences:{read:async()=>plainRow('Saved').preferences,save:async value=>{if(failures>0){failures--;throw Error('Busy');}writes.push(structuredClone(value));}}});await settle();
  failures=2;const input=doc.getElementById('codex-composer');input.value='Keep and retry this draft';input.dispatchEvent(new Event('input'));
  t.mock.method(Date,'now',()=>clock);let done=false;const pending=chat.prepareForRestart().then(()=>{done=true;});
  for(let count=0;count<8&&!done;count++){clock+=500;await new Promise<void>(resolve=>setTimeout(resolve,30));await settle();}
  await pending;assert.equal(writes.at(-1)?.tabs[0]?.draft,'Keep and retry this draft');assert.equal(chat.currentStateView().preferencesSaved,true);
});

test('host-valid legacy tab identifiers preserve drafts and selection across updates',async t=>{
  const record:ChatTabPreferences=plainRow('An older saved draft').preferences;record.tabs[0]!.localId='draft:legacy';record.activeTabId='draft:legacy';record.tabs[0]!.modelId='gpt-6.1-sol';record.tabs[0]!.effort='low';
  const tabs=await restoredTabs(t,record);
  assert.equal(tabs.persistenceStatus(),'native');assert.equal(tabs.active()!.draft,'An older saved draft');assert.deepEqual(tabs.active()!.selection,{model:'gpt-6.1-sol',effort:'low'});
});


test('runtime recovery saves drafts while stale native activity still blocks an ordinary update',async t=>{
 const doc=new DocumentFixture(),observed=state(true),writes:ChatTabPreferences[]=[];const requests:string[]=[];
 const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async input=>{requests.push(String(input));return Response.json({state:observed});}));t.after(()=>chat.stop());
 await chat.start();await chat.enableChatTabs({preferences:{read:async()=>plainRow('Earlier draft').preferences,save:async value=>{writes.push(structuredClone(value));}}});await settle();
 observed.busy=true;observed.connecting=true;await chat.refresh();const input=doc.getElementById('codex-composer');input.value='  Draft retained after service loss\n\n';input.dispatchEvent(new Event('input'));
 await assert.rejects(chat.prepareForRestart(),/Finish or stop/);await chat.prepareForRuntimeRecovery();
 assert.equal(writes.at(-1)?.tabs[0]?.draft,input.value);assert.equal(chat.currentStateView().preferencesSaved,true);assert.equal(requests.some(url=>/turn|send|resume/.test(url)),false);
});

function unknownConnectRecord():ChatActionRecord{return {requestId:randomUUID(),action:'connect',connectionId:null,state:'unknown',errorCode:'FRAME_LIMIT',
  threadId:null,turnId:null,model:null,effort:null,createdAt:'2026-10-30T12:00:00.000Z',finishedAt:'2026-10-30T12:00:01.000Z'};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

const REVIEWED_AT='2026-10-31T00:00:00.000Z';
function noticeState():ChatState {const value=state(),record=unknownConnectRecord();value.actions=[record];value.connectNotices=[{requestId:record.requestId,receiptFingerprint:'c'.repeat(64),reviewedAt:null}];return value;}
async function noticeFixture(t:test.TestContext,initial=noticeState()) {
  const doc=new DocumentFixture(),posts:{path:string;input:ConnectNoticeReview}[]=[];let observed=structuredClone(initial),reads=0;
  let reply=async(input:ConnectNoticeReview):Promise<Response>=>{const notice=observed.connectNotices!.find(row=>row.requestId===input.requestId)!;notice.reviewedAt=REVIEWED_AT;return Response.json({...input,reviewedAt:REVIEWED_AT});};
  const api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(init?.method==='POST'){assert.equal(path,'/v1/codex/review-connect','Review must not dispatch a native action.');const input=JSON.parse(String(init.body)) as ConnectNoticeReview;posts.push({path:String(path),input});return reply(input);}
    reads++;return Response.json({state:observed});
  });
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.start();
  return {doc,chat,posts,api,reads:()=>reads,observed:()=>observed,set:(value:ChatState)=>{observed=structuredClone(value);},reply:(handler:typeof reply)=>{reply=handler;},click:()=>doc.getElementById('codex-acknowledge').dispatchEvent(new Event('click'))};
}

test('actual historical notice plus three unknown tasks explains Error 412 without changing any task or sending a request',async t=>{
  const observed=noticeState();observed.chatTasks=Array.from({length:3},(_,i)=>({taskId:randomUUID(),threadId:'earlier-thread-'+i,sessionId:null,connectionId:randomUUID(),state:'unknown',round:0,reason:'daemon_restarted_no_replay',reportDigest:null,retained:false}));
  const original=structuredClone(observed),f=await noticeFixture(t,observed);
  assert.equal(f.doc.getElementById('codex-unknown-title').textContent,'Error 412 · Earlier tasks need review');
  assert.match(f.doc.getElementById('codex-unknown-body').textContent,/3 earlier tasks have an unconfirmed outcome/);
  assert.match(f.doc.getElementById('codex-error-explanation').textContent,/Reconnecting does not settle/);
  assert.doesNotMatch(f.doc.getElementById('codex-unknown-body').textContent,new RegExp(observed.actions[0]!.requestId));
  assert.match(f.doc.getElementById('codex-unknown-requests').textContent,/Error 411/);
  assert.equal(f.doc.getElementById('codex-acknowledge').disabled,true);f.click();await settle();
  assert.equal(f.posts.length,0);assert.deepEqual(f.observed(),original);
});

test('a historical frame failure explains Error 411 while preserving its exact technical reference',async t=>{
  const f=await noticeFixture(t),request=f.observed().actions[0]!.requestId;
  assert.match(f.doc.getElementById('codex-unknown-title').textContent,/^Error 411 · /);
  assert.match(f.doc.getElementById('codex-error-explanation').textContent,/exceeded the size Arcane can accept/);
  assert.match(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(request));
  assert.doesNotMatch(f.doc.getElementById('codex-unknown-title').textContent,new RegExp(request));
  assert.equal(f.doc.getElementById('codex-acknowledge').disabled,false);assert.equal(f.posts.length,0);
});

test('a delayed saved-login state read cannot connect after its original login owner changes',async t=>{
  const doc=new DocumentFixture(),observed=state(),entered=deferred(),release=deferred();let hold=false,current=true,posts=0;
  const api=new CodexChatApi(TOKEN,async(_path,init)=>{if(init?.method==='POST'){posts++;assert.fail('A stale login must not create a native connection.');}if(hold){entered.resolve();await release.promise;}return Response.json({state:observed});});
  const chat=new CodexChat(doc.asDocument(),api);t.after(()=>chat.stop());await chat.start();hold=true;
  const connecting=chat.connectForSavedLogin(()=>current);await entered.promise;current=false;release.resolve();await connecting;
  assert.equal(posts,0);
});

test('a held saved-login read cannot connect after a workspace A to B to A change',async t=>{
  const doc=new DocumentFixture(),observed=state(),entered=deferred(),release=deferred();let hold=false,posts=0;
  const before=structuredClone(observed);
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_path,init)=>{if(init?.method==='POST'){posts++;assert.fail('A retired workspace login cannot connect.');}if(hold){entered.resolve();await release.promise;}return Response.json({state:observed});}));
  t.after(()=>{release.resolve();chat.stop();});await chat.start();chat.observeWorkspaceProject(PROJECT);hold=true;
  const connecting=chat.connectForSavedLogin();await entered.promise;chat.observeWorkspaceProject('/another-workspace');chat.observeWorkspaceProject(PROJECT);release.resolve();await connecting;
  assert.equal(posts,0);assert.deepEqual(observed,before);
});

test('connection notice state is closed, bounded and refers only to exact terminal unbound FRAME_LIMIT receipts',()=>{
  const original=noticeState();assert.doesNotThrow(()=>readCodexState(original));
  for(const patch of [{requestId:randomUUID()},{receiptFingerprint:'c'.repeat(64)+'\n'},{reviewedAt:'yesterday'},{reviewedAt:REVIEWED_AT+'\n'},{extra:true}]) {
    const value=structuredClone(original);Object.assign(value.connectNotices![0]!,patch);assert.throws(()=>readCodexState(value));
  }
  for(const patch of [{state:'pending'},{errorCode:'TIMEOUT'},{finishedAt:null},{connectionId:randomUUID()},{threadId:'bound'},{turnId:'turn'},{model:'model'},{effort:'low'},{nextConnectionId:randomUUID()}]) {
    const value=structuredClone(original);Object.assign(value.actions[0]!,patch);assert.throws(()=>readCodexState(value));
  }
  const duplicate=structuredClone(original);duplicate.connectNotices!.push({...duplicate.connectNotices![0]!});assert.throws(()=>readCodexState(duplicate));
  const overflow=structuredClone(original);overflow.connectNotices=Array.from({length:101},()=>({...original.connectNotices![0]!}));assert.throws(()=>readCodexState(overflow));
  let invoked=0;const getter=structuredClone(original);Object.defineProperty(getter.connectNotices![0]!,'reviewedAt',{enumerable:true,get(){invoked++;return REVIEWED_AT;}});assert.throws(()=>readCodexState(getter));assert.equal(invoked,0);
});

test('review API snapshots exact metadata and refuses malformed or mismatched ACKs without native uncertainty',async()=>{
  const input:ConnectNoticeReview={projectPath:PROJECT,requestId:randomUUID(),receiptFingerprint:'c'.repeat(64)},submitted={...input};let release!:(value:Response)=>void;
  const api=new CodexChatApi(TOKEN,async(path,init)=>{assert.equal(path,'/v1/codex/review-connect');assert.deepEqual(JSON.parse(String(init?.body)),submitted);return new Promise(resolve=>{release=resolve;});});
  const saving=api.reviewConnectNotice(input);input.projectPath+='-changed';input.requestId=randomUUID();release(Response.json({...submitted,reviewedAt:REVIEWED_AT}));assert.deepEqual(await saving,{...submitted,reviewedAt:REVIEWED_AT});
  for(const patch of [{projectPath:PROJECT+'-foreign'},{requestId:randomUUID()},{receiptFingerprint:'d'.repeat(64)},{reviewedAt:null},{state:'acknowledged'}]) {
    const hostile=new CodexChatApi(TOKEN,async()=>Response.json({...submitted,reviewedAt:REVIEWED_AT,...patch}));
    await assert.rejects(hostile.reviewConnectNotice(submitted),error=>error instanceof CodexHttpError&&!error.unknown);
  }
  const refused=new CodexChatApi(TOKEN,async()=>Response.json({error:'Controlled metadata refusal.'},{status:409}));await assert.rejects(refused.reviewConnectNotice(submitted),error=>error instanceof CodexHttpError&&!error.unknown);
  const pending=new CodexChatApi(TOKEN,async()=>Response.json({...submitted,reviewedAt:REVIEWED_AT},{status:202}));await assert.rejects(pending.reviewConnectNotice(submitted),error=>error instanceof CodexHttpError&&!error.unknown);
});

test('explicit review awaits both durable metadata ACK and its own fresh state without changing the unknown receipt or draft',async t=>{
  const f=await noticeFixture(t),entered=deferred(),release=deferred(),retained=structuredClone(f.observed().actions[0]!);t.after(()=>release.resolve());
  f.doc.getElementById('codex-composer').value='  Exact unsent draft\n';f.reply(async input=>{entered.resolve();await release.promise;f.observed().connectNotices![0]!.reviewedAt=REVIEWED_AT;return Response.json({...input,reviewedAt:REVIEWED_AT});});
  assert.equal(f.doc.getElementById('codex-acknowledge').disabled,false);f.click();assert.equal(f.posts.length,1,'The held review reached its metadata transport.');await entered.promise;assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.equal(f.doc.getElementById('codex-acknowledge').disabled,true);f.click();assert.equal(f.posts.length,1);release.resolve();await settle();
  assert.equal(f.doc.getElementById('codex-unknown').hidden,true);assert.equal(f.doc.getElementById('codex-composer').value,'  Exact unsent draft\n');assert.deepEqual(f.observed().actions[0],retained);assert.equal(f.chat.currentStateView().state!.snapshot,null);assert.equal(f.posts.length,1);
});

for(const failure of ['refused','lost','malformed','unconfirmed-read']as const)test('connection notice review retains the original card on '+failure,async t=>{
  const f=await noticeFixture(t),retained=structuredClone(f.observed().actions[0]!);
  f.reply(async input=>{if(failure==='refused')return Response.json({error:'Controlled review refusal.'},{status:409});if(failure==='lost')throw Error('Controlled metadata ACK loss.');return Response.json({...input,reviewedAt:failure==='malformed'?null:REVIEWED_AT});});
  f.click();await settle();assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.equal(f.posts.length,1);assert.match(f.doc.getElementById('codex-notice').textContent,/review.*not confirmed/i);assert.deepEqual(f.observed().actions[0],retained);
  assert.equal(f.chat.currentStateView().state!.actions.length,1,'No synthetic native action is created by a failed metadata save.');
});

for(const change of ['workspace ABA','project ABA','provider ABA','stop/resume']as const)test('held connection review cannot apply an old response after '+change,async t=>{
  const f=await noticeFixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());f.chat.observeWorkspaceProject(PROJECT);
  f.reply(async input=>{entered.resolve();await release.promise;return Response.json({...input,reviewedAt:REVIEWED_AT});});assert.equal(f.doc.getElementById('codex-acknowledge').disabled,false);f.click();assert.equal(f.posts.length,1,'The held review reached its metadata transport.');await entered.promise;
  if(change==='workspace ABA'){f.chat.observeWorkspaceProject(PROJECT+'-other');f.chat.observeWorkspaceProject(PROJECT);}
  else if(change==='project ABA'){const original=structuredClone(f.observed()),foreign=state();foreign.projectPath=PROJECT+'-other';f.set(foreign);await f.chat.refresh();f.set(original);await f.chat.refresh();}
  else if(change==='provider ABA'){f.chat.yieldSurface(true);f.chat.yieldSurface(false);}
  else {f.chat.stop();f.chat.resume();await settle();}
  const reads=f.reads();release.resolve();await settle();assert.equal(f.reads(),reads,'The stale review response cannot request or apply a new state.');assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.equal(f.posts.length,1);
});

test('review removes only its exact original row and never clears a second uncertainty arriving during the save',async t=>{
  const f=await noticeFixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());const first=f.observed().actions[0]!.requestId;
  f.reply(async input=>{entered.resolve();await release.promise;f.observed().connectNotices![0]!.reviewedAt=REVIEWED_AT;return Response.json({...input,reviewedAt:REVIEWED_AT});});assert.equal(f.doc.getElementById('codex-acknowledge').disabled,false);f.click();assert.equal(f.posts.length,1,'The held review reached its metadata transport.');await entered.promise;
  const later=unknownConnectRecord();f.observed().actions.push(later);f.observed().connectNotices!.push({requestId:later.requestId,receiptFingerprint:'d'.repeat(64),reviewedAt:null});await f.chat.refresh();release.resolve();await settle();
  assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.doesNotMatch(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(first));assert.match(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(later.requestId));assert.equal(f.posts.length,1);
});

test('changed same-ID receipt fingerprint needs review again and cannot be cleared by a held old ACK',async t=>{
  const f=await noticeFixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());
  f.reply(async input=>{entered.resolve();await release.promise;return Response.json({...input,reviewedAt:REVIEWED_AT});});assert.equal(f.doc.getElementById('codex-acknowledge').disabled,false);f.click();assert.equal(f.posts.length,1,'The held review reached its metadata transport.');await entered.promise;
  f.observed().actions[0]!.finishedAt='2026-10-30T12:00:02.000Z';f.observed().connectNotices![0]!.receiptFingerprint='d'.repeat(64);await f.chat.refresh();release.resolve();await settle();
  assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.equal(f.observed().connectNotices![0]!.reviewedAt,null);assert.equal(f.posts.length,1);
  f.reply(async input=>{f.observed().connectNotices![0]!.reviewedAt=REVIEWED_AT;return Response.json({...input,reviewedAt:REVIEWED_AT});});f.click();await settle();assert.equal(f.doc.getElementById('codex-unknown').hidden,true);
  f.observed().actions[0]!.finishedAt='2026-10-30T12:00:03.000Z';f.observed().connectNotices![0]={...f.observed().connectNotices![0]!,receiptFingerprint:'e'.repeat(64),reviewedAt:null};await f.chat.refresh();assert.equal(f.doc.getElementById('codex-unknown').hidden,false);
});

test('exact reviewed history remains quiet during a new connection but its pending and failed receipts remain visible',async t=>{
  const initial=noticeState();initial.connectNotices![0]!.reviewedAt=REVIEWED_AT;const old=initial.actions[0]!.requestId,f=await noticeFixture(t,initial);assert.equal(f.doc.getElementById('codex-unknown').hidden,true);assert.equal(f.posts.length,0);
  const next=unknownConnectRecord();next.state='pending';next.errorCode=null;next.finishedAt=null;f.observed().actions.push(next);f.observed().connecting=true;await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-unknown').hidden,false);assert.doesNotMatch(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(old));assert.match(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(next.requestId));
  next.state='unknown';next.errorCode='FRAME_LIMIT';next.finishedAt='2026-10-31T00:00:01.000Z';f.observed().connecting=false;f.observed().connectNotices!.push({requestId:next.requestId,receiptFingerprint:'d'.repeat(64),reviewedAt:null});await f.chat.refresh();assert.match(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(next.requestId));assert.doesNotMatch(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(old));assert.equal(f.posts.length,0);
});

test('finished unknown connect survives actual journal reopen and restart checkpoints without acknowledgement or reconnect',async t=>{
  // Actual SQLite action persistence and document/ACK fixtures. No provider or physical child is started.
  const root=await realpath(await mkdtemp(join(tmpdir(),'arcane-restart-connect-')));
  let factoryCalls=0;const requestId=randomUUID(),original=new CodexClientError('FRAME_LIMIT','Controlled discovery frame refusal.',true);
  const first=createCodexService({directory:join(root,'journal'),projectPath:root,connect:async()=>{factoryCalls++;throw original;}});
  let reopened:ReturnType<typeof createCodexService>|null=null;const chats:CodexChat[]=[];
  const queueRelease=deferred(),draftRelease=deferred();
  t.after(async()=>{queueRelease.resolve();draftRelease.resolve();for(const chat of chats)chat.stop();try{await reopened?.close();}finally{try{await first.close();}finally{await rm(root,{recursive:true,force:true});}}});
  const outcome=await first.action({requestId,action:'connect',connectionId:null});
  assert.equal(outcome.record.state,'unknown');assert.equal(outcome.record.errorCode,'FRAME_LIMIT');await first.close();
  reopened=createCodexService({directory:join(root,'journal'),projectPath:root,connect:async()=>{factoryCalls++;assert.fail('Restart checkpoint must never connect.');}});
  const service=reopened,retained=structuredClone(service.state().actions[0]!);assert.equal(retained.requestId,requestId);
  const doc=new DocumentFixture(),posts:string[]=[];let reads=0;
  const api=new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST'){posts.push(String(init.body));assert.fail('No acknowledgement, connect or turn is sent.');}reads++;return Response.json({state:service.state()});});
  const chat=new CodexChat(doc.asDocument(),api);chats.push(chat);await chat.start();
  const preferences=plainRow('Earlier acknowledged draft').preferences;preferences.projectPath=root;
  const writes:ChatTabPreferences[]=[],queueWrites:ChatQueueSnapshot[]=[],queueEntered=deferred(),draftEntered=deferred();
  let holdDraft=false;
  await chat.enableChatTabs({preferences:{read:async()=>preferences,save:async value=>{if(holdDraft){draftEntered.resolve();await draftRelease.promise;}writes.push(structuredClone(value));}}});await settle();
  const queued:StoredChatQueueRow={id:1,localId:'retained-queue',conversationId:null,sessionId:null,text:'Queued text stays unsent',modelId:null,effort:null,connectionId:null,requestId:randomUUID(),
    createdAt:'2026-10-30T12:00:00.000Z',state:'unknown',attachmentState:'none'};
  await chat.setQueuePersistence({version:1,read:async()=>({available:true,projectPath:root,rows:[queued]}),save:async()=>assert.fail('Hydration does not rewrite an unchanged saved queue.')});
  // Reattaching a native bridge preserves the original local rows over its empty
  // snapshot, so this checkpoint genuinely has an unacknowledged queue write.
  await chat.setQueuePersistence({version:1,read:async()=>({available:true,projectPath:root,rows:[]}),save:async value=>{queueEntered.resolve();await queueRelease.promise;queueWrites.push(structuredClone(value));return {saved:true};}});
  assert.equal(doc.getElementById('codex-unknown').hidden,true,'Backend-quarantined history does not block a fresh connection.');
  assert.ok(service.state().nativeRecovery!.historicalActionIds.includes(requestId));
  assert.equal(doc.getElementById('codex-connect').disabled,false);assert.equal(posts.length,0,'Hydration never retries the retained connect.');
  holdDraft=true;const input=doc.getElementById('codex-composer');input.value='  Exact newest draft\n\n';input.dispatchEvent(new Event('input'));
  const readsBefore=reads;let finished=false;const checkpoint=chat.prepareForRestart().then(()=>{finished=true;});
  await Promise.race([queueEntered.promise,checkpoint.then(()=>assert.fail('Checkpoint ended before the held queue ACK.'))]);assert.equal(finished,false,'The encrypted queue ACK remains required.');queueRelease.resolve();
  await Promise.race([draftEntered.promise,checkpoint.then(()=>assert.fail('Checkpoint ended before the held draft ACK.'))]);assert.equal(finished,false,'The newest native draft ACK remains required.');draftRelease.resolve();await checkpoint;
  assert.equal(reads,readsBefore,'Host-quarantined history uses the ordinary idle checkpoint; queue and draft acknowledgements remain mandatory.');
  assert.equal(writes.at(-1)!.tabs[0]!.draft,input.value);assert.deepEqual(queueWrites.at(-1)!.rows,[queued]);
  assert.equal(chat.currentStateView().preferencesSaved,true);assert.equal(doc.getElementById('codex-unknown').hidden,true);
  assert.deepEqual(service.state().actions[0],retained,'Saving drafts never changes the unknown action receipt.');
  const restoredDoc=new DocumentFixture(),restored=new CodexChat(restoredDoc.asDocument(),api);chats.push(restored);
  await restored.start();await restored.enableChatTabs({preferences:{read:async()=>writes.at(-1)!,save:async()=>{}}});
  assert.equal(restoredDoc.getElementById('codex-composer').value,input.value);assert.equal(restoredDoc.getElementById('codex-unknown').hidden,true);
  assert.deepEqual(restored.currentStateView().state!.actions[0],retained);assert.equal(restoredDoc.getElementById('codex-connect').disabled,false);
  assert.equal(posts.length,0);assert.equal(factoryCalls,1,'Only the original controlled connection attempt existed.');
});

test('explicit durable review survives actual SQLite reopen while its unknown action stays unchanged and saved-login uses a new request',async t=>{
  // Real action/review SQLite and actual frontend/API classes; document and native factory are controlled doubles.
  const root=await realpath(await mkdtemp(join(tmpdir(),'arcane-reviewed-connect-'))),directory=join(root,'journal'),chats:CodexChat[]=[];
  let factoryCalls=0,service=createCodexService({directory,projectPath:root,connect:async()=>{factoryCalls++;throw new CodexClientError('FRAME_LIMIT','Controlled original discovery refusal.',true);}});
  t.after(async()=>{for(const chat of chats)chat.stop();try{await service.close();}finally{await rm(root,{recursive:true,force:true});}});
  const original=await service.action({requestId:randomUUID(),action:'connect',connectionId:null}),retained=structuredClone(original.record);assert.equal(retained.state,'unknown');assert.equal(service.state().connectNotices![0]!.reviewedAt,null);await service.close();
  service=createCodexService({directory,projectPath:root,connect:async()=>{factoryCalls++;throw new CodexClientError('BINARY_MISSING','Controlled later connection refusal.');}});
  const requests:{path:string;input:Record<string,unknown>}[]=[];
  const api=new CodexChatApi(TOKEN,async(path,init)=>{
    if(init?.method!=='POST')return Response.json({state:service.state()});
    const input=JSON.parse(String(init.body)) as Record<string,unknown>;requests.push({path:String(path),input});
    if(path==='/v1/codex/review-connect')return Response.json(service.reviewConnectNotice(input));
    assert.equal(path,'/v1/codex/action');const outcome=await service.action(input);return Response.json(outcome,{status:outcome.record.state==='acknowledged'?200:outcome.record.state==='rejected'?409:202});
  });
  const doc=new DocumentFixture(),chat=new CodexChat(doc.asDocument(),api);chats.push(chat);await chat.start();doc.getElementById('codex-composer').value='Retain this exact draft';
  assert.equal(doc.getElementById('codex-unknown').hidden,true);assert.equal(requests.length,0,'Hydrating quarantined history does not connect or acknowledge it.');
  // Explicit metadata review remains durable even when quarantine makes the old
  // receipt nonblocking. It never settles the original unknown native outcome.
  const candidate=service.state().connectNotices![0]!;
  await api.reviewConnectNotice({projectPath:root,requestId:candidate.requestId,receiptFingerprint:candidate.receiptFingerprint});await chat.refresh();
  assert.equal(doc.getElementById('codex-unknown').hidden,true);assert.deepEqual(service.state().actions,[retained]);assert.equal(requests.length,1);assert.equal(requests[0]!.path,'/v1/codex/review-connect');
  assert.equal(doc.getElementById('codex-composer').value,'Retain this exact draft');const marker=structuredClone(service.state().connectNotices![0]!);assert.ok(marker.reviewedAt);chat.stop();await service.close();
  service=createCodexService({directory,projectPath:root,connect:async()=>{factoryCalls++;throw new CodexClientError('BINARY_MISSING','Controlled later connection refusal.');}});
  const restoredDoc=new DocumentFixture(),restored=new CodexChat(restoredDoc.asDocument(),api);chats.push(restored);await restored.start();assert.equal(restoredDoc.getElementById('codex-unknown').hidden,true);assert.deepEqual(service.state().actions,[retained]);assert.deepEqual(service.state().connectNotices,[marker]);assert.equal(requests.length,1,'Reopening does not send a native action or repeat review.');
  await restored.connectForSavedLogin();assert.equal(factoryCalls,2);assert.equal(requests.length,2);assert.equal(requests[1]!.path,'/v1/codex/action');assert.equal(requests[1]!.input.action,'connect');assert.notEqual(requests[1]!.input.requestId,retained.requestId);assert.deepEqual(service.state().actions.find(row=>row.requestId===retained.requestId),retained);assert.equal(service.state().actions.some(row=>row.action==='turn-start'),false);
});

test('durable review is unavailable while a current native owner or lifecycle is unresolved',async t=>{
  const cases:[string,(value:ChatState)=>void][]=[['connecting',value=>{value.connecting=true;}],['closing',value=>{value.closing=true;}],['busy',value=>{value.busy=true;}],['limited',value=>{value.displayLimited=true;}],['native connection',value=>{value.snapshot=snapshot();}],['retained owner',value=>{value.chatTasks=[{taskId:randomUUID(),threadId:'retained',sessionId:null,connectionId:randomUUID(),state:'verified',round:0,reason:null,reportDigest:null,retained:true}];}],['unknown task',value=>{value.chatTasks=[{taskId:randomUUID(),threadId:'unknown',sessionId:null,connectionId:randomUUID(),state:'unknown',round:0,reason:null,reportDigest:null}];}]];
  for(const [name,change]of cases)await t.test(name,async t=>{const initial=noticeState();change(initial);const retained=structuredClone(initial),f=await noticeFixture(t,initial);assert.equal(f.doc.getElementById('codex-acknowledge').disabled,true);f.click();await settle();assert.equal(f.posts.length,0);
    // An old unbound connect does not belong to a different current connection;
    // the existing scope filter leaves that card hidden without marking it reviewed.
    assert.equal(f.doc.getElementById('codex-unknown').hidden,name==='native connection');assert.deepEqual(f.chat.currentStateView().state!.snapshot,retained.snapshot);assert.deepEqual(f.observed().actions,retained.actions);assert.deepEqual(f.observed().connectNotices,retained.connectNotices);
  });
});

test('unknown-connect checkpoint refuses stale, incomplete, mismatched and active state from the fresh read',async t=>{
  const activeTask=(state:ChatState,kind='working',retained=false)=>{state.chatTasks=[{taskId:randomUUID(),threadId:'owned-thread',sessionId:null,connectionId:randomUUID(),state:kind,round:0,reason:null,reportDigest:null,retained}];};
  const cases:[string,(state:ChatState)=>void][]=[
    ['busy',value=>{value.busy=true;}],['connecting',value=>{value.connecting=true;}],['closing',value=>{value.closing=true;}],
    ['current idle session',value=>{value.snapshot=snapshot();}],
    ['live turn',value=>{value.snapshot=state(true).snapshot;value.snapshot!.thread!.turnStatus='inProgress';value.snapshot!.thread!.turnId='owned-turn';}],
    ['active task',value=>activeTask(value)],['retained unknown task',value=>activeTask(value,'unknown',true)],
    ['unknown ownership missing',value=>{activeTask(value,'unknown');delete value.chatTasks![0]!.retained;}],
    ['retained normal owner',value=>activeTask(value,'verified',true)],
    ['missing receipt',value=>{value.actions=[];}],['unfinished receipt',value=>{value.actions[0]!.finishedAt=null;}],
    ['still pending',value=>{value.actions[0]!.state='pending';}],['different disposition',value=>{value.actions[0]!.state='rejected';}],
    ['different request',value=>{value.actions[0]!.requestId=randomUUID();}],['different action',value=>{value.actions[0]!.action='history-load';}],
    ['bound connection',value=>{value.actions[0]!.connectionId=randomUUID();}],['bound thread',value=>{value.actions[0]!.threadId='different-thread';}],
    ['bound turn',value=>{value.actions[0]!.turnId='different-turn';}],['selected model',value=>{value.actions[0]!.model='different-model';}],
    ['missing failure',value=>{value.actions[0]!.errorCode=null;}],['limited display',value=>{value.displayLimited=true;}],
    ['different project',value=>{value.projectPath=PROJECT+'-different';}],
  ];
  for(const [name,change] of cases)await t.test(name,async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];let posts=0;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST')posts++;return Response.json({state:observed});}));t.after(()=>chat.stop());
    await chat.start();change(observed);await assert.rejects(chat.prepareForRestart(),/Finish or stop|workspace changed|recorded connection changed|Check current native state/);
    assert.equal(posts,0);assert.equal(doc.getElementById('codex-unknown').hidden,false);
  });
  await t.test('failed state read',async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];let refuse=false;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>{if(refuse)throw Error('Controlled state read failure.');return Response.json({state:observed});}));t.after(()=>chat.stop());
    await chat.start();refuse=true;await assert.rejects(chat.prepareForRestart(),/Check current native state/);assert.equal(chat.currentStateView().fresh,false);
  });
});

test('unknown turns, history and grants remain blocked after their connection disappears',async t=>{
  for(const action of ['turn-start','history-load','grant-writes','grant-assets'] as const)await t.test(action,async t=>{
    const doc=new DocumentFixture(),observed=state(true),record=unknownConnectRecord();record.action=action;record.connectionId=observed.snapshot!.connectionId;record.threadId=observed.snapshot!.thread!.threadId;
    observed.actions=[record];let posts=0;const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST')posts++;return Response.json({state:observed});}));t.after(()=>chat.stop());
    await chat.start();assert.equal(doc.getElementById('codex-unknown').hidden,false);observed.snapshot=null;
    await assert.rejects(chat.prepareForRestart(),{message:'Check current native state before restarting. Your draft is retained.'});
    assert.equal(chat.currentStateView().state!.snapshot,null,'The original GET applied the disconnection and retired its prior generation.');
    assert.equal(chat.currentStateView().fresh,true);
    await assert.rejects(chat.prepareForRestart(),/Finish or stop/);assert.equal(posts,0);assert.equal(doc.getElementById('codex-unknown').hidden,false);
  });
});

test('a local pending connect still blocks restart when an unrelated finished connect is recorded',async t=>{
  const doc=new DocumentFixture(),observed=state(),entered=deferred(),release=deferred();let posts=0;
  const record=unknownConnectRecord();const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{
    if(init?.method==='POST'){posts++;entered.resolve();await release.promise;return Response.json({record:{...record,requestId:JSON.parse(String(init.body)).requestId},replayed:false,state:observed});}
    return Response.json({state:observed});
  }));t.after(()=>{release.resolve();chat.stop();});await chat.start();
  doc.getElementById('codex-connect').dispatchEvent(new Event('click'));await entered.promise;
  observed.actions=[record];await assert.rejects(chat.prepareForRestart(),/Finish or stop/);assert.equal(posts,1,'No second request is made while the original POST is held.');release.resolve();
});

test('connect checkpoint rechecks activity and project after held native draft persistence',async t=>{
  for(const change of ['busy','project','live-session','retained-task'] as const)await t.test(change,async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];const entered=deferred(),release=deferred();let hold=false,posts=0;
    if(change==='retained-task')observed.chatTasks=[{taskId:randomUUID(),threadId:'historical',sessionId:null,connectionId:randomUUID(),state:'unknown',round:0,reason:'application_closed',reportDigest:null,retained:false}];
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST')posts++;return Response.json({state:observed});}));t.after(()=>{release.resolve();chat.stop();});
    await chat.start();await chat.enableChatTabs({preferences:{read:async()=>plainRow('Saved draft').preferences,save:async()=>{if(hold){entered.resolve();await release.promise;}}}});await settle();
    hold=true;doc.getElementById('codex-composer').value='Keep the exact held draft';doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
    const checkpoint=chat.prepareForRestart();const refused=assert.rejects(checkpoint,/Finish or stop|workspace changed|Check current native state/);await Promise.race([entered.promise,checkpoint.then(()=>assert.fail('Checkpoint ended before the held draft ACK.'))]);
    if(change==='busy')observed.busy=true;else if(change==='project')observed.projectPath=PROJECT+'-changed';else if(change==='retained-task')observed.chatTasks![0]!.retained=true;else observed.snapshot=snapshot();
    release.resolve();await refused;assert.equal(posts,0);assert.equal(doc.getElementById('codex-unknown').hidden,false);
  });
});

test('connect checkpoint preserves failed queue and draft ACK refusals and original unreviewed receipt',async t=>{
  await t.test('queue save',async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];let saves=0;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());await chat.start();
    await chat.setQueuePersistence({version:1,read:async()=>({available:true,projectPath:PROJECT,rows:[{id:1,localId:'unsent',conversationId:null,sessionId:null,text:'Unsent queue text',modelId:null,effort:null,connectionId:null,requestId:null,createdAt:'2026-10-30T12:00:00.000Z',state:'pending',attachmentState:'none'}]}),save:async()=>assert.fail('Unchanged hydration does not need a save.')});
    await chat.setQueuePersistence({version:1,read:async()=>({available:true,projectPath:PROJECT,rows:[]}),save:async()=>{saves++;throw Error('Controlled queue save failure.');}});
    await assert.rejects(chat.prepareForRestart(),/Queued messages could not be saved/);assert.ok(saves>0);assert.equal(doc.getElementById('codex-unknown').hidden,false);
  });
  await t.test('draft save',async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];let fail=false,clock=1000;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async()=>Response.json({state:observed})));t.after(()=>chat.stop());await chat.start();
    await chat.enableChatTabs({preferences:{read:async()=>plainRow('Saved draft').preferences,save:async()=>{if(fail)throw Error('Controlled draft save failure.');}}});await settle();
    fail=true;const input=doc.getElementById('codex-composer');input.value='Do not lose this draft';input.dispatchEvent(new Event('input'));t.mock.method(Date,'now',()=>clock);
    const checkpoint=chat.prepareForRestart(),refused=assert.rejects(checkpoint,/draft could not be saved/);await settle();clock+=10001;await refused;
    assert.equal(input.value,'Do not lose this draft');assert.equal(chat.currentStateView().preferencesSaved,false);assert.equal(doc.getElementById('codex-unknown').hidden,false);
  });
});

test('only explicit review clears the restored connect card and refresh does not immediately recreate it',async t=>{
  const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];let posts=0;
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST')posts++;return Response.json({state:observed});}));t.after(()=>chat.stop());await chat.start();
  const retained=structuredClone(observed.actions[0]);await chat.prepareForRestart();assert.equal(doc.getElementById('codex-unknown').hidden,false);
  assert.equal(doc.getElementById('codex-acknowledge').disabled,false);doc.getElementById('codex-acknowledge').dispatchEvent(new Event('click'));
  assert.equal(doc.getElementById('codex-unknown').hidden,true,'The real review handler dismisses the card before the next GET.');await chat.refresh();
  assert.equal(doc.getElementById('codex-unknown').hidden,true);assert.deepEqual(observed.actions[0],retained);assert.equal(posts,0);
});

test('restart requires its own applied GET at both checkpoints even when another poll reads idle state',async t=>{
  for(const phase of ['initial','final'] as const)for(const replacement of ['held','complete'] as const)await t.test(phase+' / '+replacement,async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];
    const entered=deferred(),release=deferred(),pollEntered=deferred(),pollRelease=deferred();let reads=0,posts=0,target=Infinity;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{
      if(init?.method==='POST'){posts++;assert.fail('Superseded reads cannot dispatch anything.');}
      const ordinal=++reads;
      if(ordinal===target){
        const signal=init?.signal;assert.ok(signal);entered.resolve();
        await Promise.race([release.promise,new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Controlled superseded GET.','AbortError')),{once:true}))]);
      }else if(ordinal===target+1){pollEntered.resolve();if(replacement==='held')await pollRelease.promise;}
      return Response.json({state:observed});
    }));t.after(()=>{release.resolve();pollRelease.resolve();chat.stop();});
    await chat.start();const retained=structuredClone(observed.actions[0]);target=reads+(phase==='initial'?1:2);
    const checkpoint=chat.prepareForRestart(),refused=assert.rejects(checkpoint,/Check current native state/);
    await Promise.race([entered.promise,checkpoint.then(()=>assert.fail('The checkpoint did not perform its own expected GET.'))]);
    const poll=chat.refresh();await pollEntered.promise;
    await refused;assert.equal(posts,0);assert.equal(doc.getElementById('codex-unknown').hidden,false);
    assert.deepEqual(observed.actions[0],retained,'A poll cannot acknowledge or replace the original unknown receipt.');
    pollRelease.resolve();release.resolve();await poll;
    assert.equal(chat.currentStateView().fresh,true,'Even another successful idle GET cannot satisfy the superseded checkpoint.');
  });
});

test('stopped or retired read owners cannot certify a restart checkpoint',async t=>{
  for(const duringRead of [false,true])await t.test(duringRead?'stop during GET':'refresh returns while stopped',async t=>{
    const doc=new DocumentFixture(),observed=state();observed.actions=[unknownConnectRecord()];const entered=deferred(),release=deferred();let hold=false,posts=0;
    const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{
      if(init?.method==='POST'){posts++;assert.fail('Retired reads do not dispatch.');}
      if(hold){const signal=init?.signal;assert.ok(signal);entered.resolve();await Promise.race([release.promise,new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Controlled retired GET.','AbortError')),{once:true}))]);}
      return Response.json({state:observed});
    }));t.after(()=>{release.resolve();chat.stop();});await chat.start();
    if(!duringRead)chat.stop();else hold=true;
    const checkpoint=chat.prepareForRestart(),refused=assert.rejects(checkpoint,/Check current native state/);
    if(duringRead){await Promise.race([entered.promise,checkpoint.then(()=>assert.fail('Expected the original held GET.'))]);chat.stop();}
    await refused;release.resolve();assert.equal(posts,0);assert.equal(chat.currentStateView().fresh,false);assert.equal(observed.actions[0]!.state,'unknown');
  });
});

test('a new uncertain connect arriving during an ordinary held draft save cannot borrow the restart exception',async t=>{
  const doc=new DocumentFixture(),observed=state(),entered=deferred(),release=deferred();let hold=false,posts=0;
  const writes:ChatTabPreferences[]=[];
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST')posts++;return Response.json({state:observed});}));
  t.after(()=>{release.resolve();chat.stop();});await chat.start();
  await chat.enableChatTabs({preferences:{read:async()=>plainRow('Saved draft').preferences,save:async value=>{if(hold){entered.resolve();await release.promise;}writes.push(structuredClone(value));}}});await settle();
  hold=true;const input=doc.getElementById('codex-composer');input.value='Keep the draft through new uncertainty';input.dispatchEvent(new Event('input'));
  const checkpoint=chat.prepareForRestart(),refused=assert.rejects(checkpoint,/Finish or stop/);
  await Promise.race([entered.promise,checkpoint.then(()=>assert.fail('Checkpoint ended before the held draft save.'))]);
  const record=unknownConnectRecord();observed.actions=[record];await chat.refresh();
  assert.equal(chat.currentStateView().fresh,true);assert.equal(chat.currentStateView().state!.snapshot,null);
  assert.equal(doc.getElementById('codex-unknown').hidden,false);release.resolve();await refused;
  await settle();assert.equal(input.value,'Keep the draft through new uncertainty');assert.equal(writes.at(-1)!.tabs[0]!.draft,input.value);
  assert.deepEqual(observed.actions,[record]);assert.equal(posts,0);
});

test('real journal reopen quarantines nonconnect uncertainty without retrying or hiding its durable records',async t=>{
  // Constructed action metadata in the actual journal, not native/provider evidence.
  const root=await realpath(await mkdtemp(join(tmpdir(),'arcane-unconfirmed-journal-'))),directory=join(root,'journal');
  let opened:ReturnType<typeof createCodexService>|null=null;const chats:CodexChat[]=[];let connections=0;
  const initial=createCodexService({directory,projectPath:root,connect:async()=>{connections++;assert.fail('History recovery cannot connect.');}});
  t.after(async()=>{for(const chat of chats)chat.stop();try{await opened?.close();}finally{try{await initial.close();}finally{await rm(root,{recursive:true,force:true});}}});
  await initial.close();const connectionId=randomUUID(),threadId='original-unconfirmed-thread';
  const records:ChatActionRecord[]=(['turn-start','history-load','grant-writes','grant-assets'] as const).map(action=>({...unknownConnectRecord(),action,connectionId,threadId,turnId:action==='turn-start'?'original-unconfirmed-turn':null}));
  const pending:ChatActionRecord={...unknownConnectRecord(),action:'turn-start',connectionId,threadId,turnId:'original-pending-turn',state:'pending',errorCode:null,finishedAt:null};records.push(pending);
  const db=new DatabaseSync(sqliteTransportPath(join(directory,'codex-actions.sqlite')),{allowExtension:false});
  try{
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    for(const record of records){
      const input={requestId:record.requestId,action:record.action,connectionId,threadId,...(record.action==='turn-start'?{text:'Controlled recorded request'}:{})};
      db.prepare('INSERT INTO actions(id,hash,payload) VALUES(?,?,?)').run(record.requestId,createHash('sha256').update(JSON.stringify(input)).digest('hex'),JSON.stringify(record));
    }
    db.exec('COMMIT');
  }finally{db.close();}
  opened=createCodexService({directory,projectPath:root,connect:async()=>{connections++;assert.fail('Reopen cannot retry an unconfirmed request.');}});
  const service=opened,expected=structuredClone(service.state().actions),recovered=expected.find(record=>record.requestId===pending.requestId)!;
  assert.equal(recovered.state,'unknown');assert.equal(recovered.errorCode,'DAEMON_RESTART');assert.notEqual(recovered.finishedAt,null);
  for(const record of records.filter(record=>record!==pending))assert.deepEqual(expected.find(row=>row.requestId===record.requestId),record);
  let posts=0;const api=new CodexChatApi(TOKEN,async(_input,init)=>{if(init?.method==='POST'){posts++;assert.fail('Hydrated uncertainty cannot be acknowledged or replayed automatically.');}return Response.json({state:service.state()});});
  const doc=new DocumentFixture(),chat=new CodexChat(doc.asDocument(),api);chats.push(chat);await chat.start();
  assert.equal(chat.currentStateView().state!.snapshot,null);for(const record of records){
    assert.ok(service.state().nativeRecovery!.historicalActionIds.includes(record.requestId));
    assert.deepEqual(chat.currentStateView().state!.actions.find(row=>row.requestId===record.requestId),expected.find(row=>row.requestId===record.requestId));
  }
  assert.equal(doc.getElementById('codex-unknown').hidden,true);assert.equal(doc.getElementById('codex-connect').disabled,false);
  await chat.prepareForRestart();assert.equal(posts,0);assert.equal(connections,0);
  await chat.refresh();assert.equal(doc.getElementById('codex-unknown').hidden,true,'The same host quarantine remains effective without acknowledging outcomes.');
  const nextDoc=new DocumentFixture(),next=new CodexChat(nextDoc.asDocument(),api);chats.push(next);await next.start();
  assert.equal(nextDoc.getElementById('codex-unknown').hidden,true);assert.equal(nextDoc.getElementById('codex-connect').disabled,false);
  assert.deepEqual(next.currentStateView().state!.actions,expected,'A new window still exposes every durable unknown receipt in recorded state.');
  assert.equal(posts,0);assert.equal(connections,0);assert.deepEqual(service.state().actions,expected,'Quarantine never rewrites or acknowledges the journal.');
});
