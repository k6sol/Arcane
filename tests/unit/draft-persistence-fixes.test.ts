import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ChatTabs, type ChatTabPreferences } from '../../apps/desktop/src/chat-tabs.js';
import { CodexChat, CodexChatApi, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import type { Snapshot } from '../../packages/codex-client/src/types.js';

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
