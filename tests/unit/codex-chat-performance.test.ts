/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, CODEX_DRAFT_SAVE_DELAY_MS, CODEX_INPUT_BYTES, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import type { ChatTabs } from '../../apps/desktop/src/chat-tabs.js';

// Deterministic work counts instead of machine-dependent timing thresholds.
class Element extends EventTarget {
  tagName=''; value=''; checked=false; disabled=false; hidden=false; open=false; type=''; className='';
  dataset:Record<string,string>={}; children:Element[]=[]; scrollHeight=0;scrollTop=0;clientHeight=0;
  private content='';private attributes=new Map<string,string>();
  get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.content=value;this.children=[];}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.content='';this.children=children;}
  querySelectorAll(){return [];}
  after(){} remove(){} focus(){} close(){this.open=false;} showModal(){this.open=true;}
}
class DocumentFixture extends EventTarget {
  hidden=false;activeElement=null;
  defaultView=new EventTarget();
  private elements=new Map<string,Element>();
  getElementById(id:string):Element {
    let element=this.elements.get(id);
    if(!element){element=new Element();if(id==='codex-composer')element.tagName='TEXTAREA';this.elements.set(id,element);}
    return element;
  }
  createElement(){return new Element();}
  asDocument(){return this as unknown as Document;}
}
function reportedState():ChatState {
  return {provider:'codex',use:'personal-local',projectPath:resolve('.'),connecting:false,closing:false,busy:false,
    actions:[],lastSnapshot:null,nativeTools:{configured:true,verified:false},snapshot:{
      connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,
      account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},
      models:[{model:'reported-fixture',id:'reported-id',displayName:'Reported fixture',efforts:['low','ultra'],defaultEffort:'low',entitlement:'unverified'}],
      selection:{model:'reported-fixture',effort:'low'},thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null}};
}
function memoryStorage(){
  const data=new Map<string,string>();let writes=0;
  return {data,get writes(){return writes;},getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{writes++;data.set(key,value);}};
}
async function fixture(t:test.TestContext,storage=memoryStorage(),tabs=true,initial=reportedState()) {
  const doc=new DocumentFixture(),calls:string[]=[];doc.getElementById('workspace-chat-tabs').setAttribute('role','tablist');
  let observed=initial;
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi('a'.repeat(64),async(_path,init)=>{
    calls.push(init?.method??'GET');assert.equal(init?.method,'GET','Draft work never invokes a native action');return Response.json({state:observed});
  }));
  await chat.start();if(tabs)await chat.enableChatTabs({storage});t.after(()=>chat.stop());
  const input=(value:string)=>{doc.getElementById('codex-composer').value=value;doc.getElementById('codex-composer').dispatchEvent(new Event('input'));};
  return {chat,doc,calls,storage,input,set:(value:ChatState)=>{observed=value;}};
}

test('typing bursts do no catalogue/tab rendering, persistence serialization or state publication',async t=>{
  const loaded=reportedState();
  for(let i=1;i<512;i++)loaded.snapshot!.models.push({model:'reported-fixture-'+i,id:'reported-id-'+i,displayName:'Reported fixture '+i,efforts:['low','ultra'],defaultEffort:'low',entitlement:'unverified'});
  loaded.snapshot!.events=Array.from({length:128},(_,index)=>({type:'delta',seq:index+1,threadId:'fixture-thread',turnId:'fixture-turn',itemId:'item-'+index,text:'Public fixture text. '.repeat(400)}));
  loaded.snapshot!.lastEventSeq=128;
  const f=await fixture(t,memoryStorage(),true,loaded);t.mock.timers.enable({apis:['setTimeout']});
  const internals=f.chat as unknown as {tabs:ChatTabs;render:()=>void;renderControls:()=>void;renderPicker:()=>void};
  let renders=0,tabUpdates=0,publications=0,serializations=0;
  for(const method of ['render','renderControls','renderPicker'] as const){const original=internals[method].bind(f.chat);internals[method]=()=>{renders++;original();};}
  const originalRender=internals.tabs.render.bind(internals.tabs);internals.tabs.render=blocked=>{renders++;originalRender(blocked);};
  const originalUpdate=internals.tabs.updateDraft.bind(internals.tabs);internals.tabs.updateDraft=(...args)=>{tabUpdates++;originalUpdate(...args);};
  f.chat.subscribeStateChange(()=>publications++);
  const writes=f.storage.writes,requests=f.calls.length,originalStringify=JSON.stringify;
  JSON.stringify=((...args:Parameters<typeof JSON.stringify>)=>{serializations++;return originalStringify(...args);}) as typeof JSON.stringify;
  const prefix='Exact draft 🧩\n'+'x'.repeat(32768);
  try{for(let i=0;i<100;i++)f.input(prefix+i+'  ');}finally{JSON.stringify=originalStringify;}
  assert.equal(renders,0);assert.equal(tabUpdates,0);assert.equal(publications,0);assert.equal(serializations,0);
  assert.equal(f.storage.writes,writes);assert.equal(f.calls.length,requests);
  assert.equal(f.chat.currentStateView().activeChat!.draft,prefix+'99  ');
  assert.equal(f.chat.chatTabsView()[0]!.draft,prefix+'99  ');
  assert.equal(f.chat.currentStateView().preferencesSaved,false);
  t.mock.timers.tick(CODEX_DRAFT_SAVE_DELAY_MS-1);assert.equal(tabUpdates,0);
  t.mock.timers.tick(1);assert.equal(tabUpdates,1);assert.equal(publications,1);assert.equal(renders,0);
  assert.equal(f.storage.writes,writes+1);assert.equal(f.calls.length,requests);
});

test('typing in a saved chat copies its large draft only for the public active view, not binding checks',async t=>{
  const initial=reportedState(),selection={model:'reported-fixture',effort:'low'};
  initial.snapshot!.thread={threadId:'fixture-thread',sessionId:'fixture-session',configured:true,writeGranted:false,
    selection,turnId:null,turnStatus:'idle'};
  initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId:'fixture-thread',sessionId:'fixture-session',selection}];
  const f=await fixture(t,memoryStorage(),true,initial);t.mock.timers.enable({apis:['setTimeout']});
  const tabs=(f.chat as unknown as {tabs:ChatTabs}).tabs;
  assert.equal(tabs.bound(initial),true);
  const draft='Saved draft 🧩\n'+'x'.repeat(CODEX_INPUT_BYTES-512);
  f.input(draft);t.mock.timers.tick(CODEX_DRAFT_SAVE_DELAY_MS);
  assert.equal(tabs.active()!.draft,draft);
  let copies=0,copiedBytes=0;
  const originalClone=globalThis.structuredClone,requests=f.calls.length,writes=f.storage.writes;
  globalThis.structuredClone=((value:unknown,options?:StructuredSerializeOptions)=>{
    if(value&&typeof value==='object'&&'draft' in value&&typeof value.draft==='string'){
      copies++;copiedBytes+=Buffer.byteLength(value.draft,'utf8');
    }
    return originalClone(value,options);
  }) as typeof structuredClone;
  try{for(let i=0;i<100;i++)f.input(draft+i);}finally{globalThis.structuredClone=originalClone;}
  t.diagnostic('100 saved-chat edits: draft copies='+copies+'; copied UTF-8 bytes='+copiedBytes);
  assert.equal(copies,100,'Boolean binding checks must not copy the saved draft on each keystroke.');
  assert.equal(copiedBytes,100*Buffer.byteLength(draft,'utf8'));
  assert.equal(f.calls.length,requests);assert.equal(f.storage.writes,writes);
  assert.equal(f.doc.getElementById('codex-submit').disabled,false);
  assert.equal(f.chat.currentStateView().activeChat!.draft,draft+'99');
  t.mock.timers.tick(CODEX_DRAFT_SAVE_DELAY_MS);
  assert.equal(tabs.active()!.draft,draft+'99');

  // Binding still checks canonical project, ownership and exact configured identity.
  const detached=tabs.active()!;Object.assign(detached,{threadId:'changed',draft:'changed'});
  assert.equal(tabs.bound(initial),true);assert.equal(tabs.active()!.draft,draft+'99');
  assert.equal(tabs.bound(null),false);
  assert.equal(tabs.bound({...initial,projectPath:initial.projectPath+'-other'}),false);
  for(const patch of [{threadId:'other'},{sessionId:'other'},{configured:false}]){
    const next=structuredClone(initial);Object.assign(next.snapshot!.thread!,patch);assert.equal(tabs.bound(next),false);
  }
  const unowned=structuredClone(initial);unowned.nativeThreads=[];tabs.sync(unowned);
  assert.equal(tabs.bound(initial),false);
});

test('an immediate chat switch and stop/reload preserve every draft byte before debounce fires',async t=>{
  const storage=memoryStorage(),f=await fixture(t,storage);t.mock.timers.enable({apis:['setTimeout']});
  const first=f.chat.chatTabsView()[0]!.key,draft='First chat 🧩\n\tTrailing spaces.  ';
  f.input(draft);assert.equal(await f.chat.newChat(),true);const second=f.chat.currentStateView().activeChat!.key;
  const next='Second chat\nNo lost IME text 漢字.  ';f.input(next);
  assert.equal(await f.chat.selectChat(first),true);assert.equal(f.doc.getElementById('codex-composer').value,draft);
  assert.equal(await f.chat.selectChat(second),true);assert.equal(f.doc.getElementById('codex-composer').value,next);
  const latest=next+'Last keystroke.';f.input(latest);f.chat.stop();
  const reloaded=await fixture(t,storage);assert.equal(reloaded.doc.getElementById('codex-composer').value,latest);
  assert.equal(await reloaded.chat.selectChat(first),true);assert.equal(reloaded.doc.getElementById('codex-composer').value,draft);
  assert.ok([...f.calls,...reloaded.calls].every(method=>method==='GET'));
});

test('pagehide and hidden-page transitions synchronously flush a pending draft',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const before=f.storage.writes;f.input('Immediate reload 🧩  ');
  f.doc.defaultView.dispatchEvent(new Event('pagehide'));
  assert.equal(f.storage.writes,before+1);assert.ok([...f.storage.data.values()].some(value=>JSON.parse(value).tabs[0].draft==='Immediate reload 🧩  '));
  f.input('Hidden page exact draft\n');f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.storage.writes,before+2);assert.ok([...f.storage.data.values()].some(value=>JSON.parse(value).tabs[0].draft==='Hidden page exact draft\n'));
});

test('state/project changes fence a pending draft into its outgoing project before restoration',async t=>{
  const initial=reportedState(),f=await fixture(t,memoryStorage(),true,initial);t.mock.timers.enable({apis:['setTimeout']});
  const draft='Outgoing project text 🧩  ';f.input(draft);
  const next=structuredClone(initial);next.projectPath+='-other';f.set(next);await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-composer').value,'');
  f.input('Different project draft');f.set(initial);await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-composer').value,draft);
});

test('input validation is immediate at exact UTF-8 limits and never submits on composition/input',async t=>{
  const initial=reportedState();initial.snapshot!.thread={threadId:'fixture-thread',sessionId:null,configured:true,writeGranted:false,
    selection:{model:'reported-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
  const f=await fixture(t,memoryStorage(),false,initial);t.mock.timers.enable({apis:['setTimeout']});const requests=f.calls.length;
  f.input(' \n\t');assert.equal(f.doc.getElementById('codex-submit').disabled,true);
  f.input('🧩'.repeat(CODEX_INPUT_BYTES/4));assert.equal(f.doc.getElementById('codex-submit').disabled,false);
  assert.match(f.doc.getElementById('codex-input-size').textContent,/^131072 \/ 131072/);
  f.input(f.doc.getElementById('codex-composer').value+'x');assert.equal(f.doc.getElementById('codex-submit').disabled,true);
  f.doc.getElementById('codex-composer').dispatchEvent(new Event('compositionend'));
  assert.equal(f.calls.length,requests);assert.equal(f.doc.getElementById('codex-composer').value.length,CODEX_INPUT_BYTES/2+1);
});

test('edits made while a saved-chat resume is pending stay in the outgoing draft',async t=>{
  const initial=reportedState(),selection={model:'reported-fixture',effort:'low'};
  initial.snapshot!.thread={threadId:'thread-a',sessionId:null,selection,configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};
  initial.nativeHistory={projectPath:initial.projectPath,threadId:'thread-a',sessionId:null,recorded:null};
  initial.nativeThreads=['thread-a','thread-b'].map(threadId=>({provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection}));
  const f=await fixture(t,memoryStorage(),true,initial);t.mock.timers.enable({apis:['setTimeout']});
  assert.equal(await f.chat.newChat(),true);const outgoing=f.chat.currentStateView().activeChat!.key;
  const controller=f.chat as unknown as {tabs:ChatTabs;bindNativeChat:()=>Promise<boolean>};
  const target=controller.tabs.ensureSaved('thread-b')!;let release!:()=>void;
  const receipt=new Promise<void>(done=>{release=done;});controller.bindNativeChat=async()=>{await receipt;return true;};
  f.input('Before resume');const switching=f.chat.selectChat(target.key);
  const bound=structuredClone(initial);bound.snapshot!.thread!.threadId='thread-b';bound.nativeHistory!.threadId='thread-b';
  f.set(bound);await f.chat.refresh();
  const latest='Last edit during resume 🧩\nTrailing spaces.  ';f.input(latest);release();
  assert.equal(await switching,true);assert.equal(f.doc.getElementById('codex-composer').value,'');
  assert.equal(await f.chat.selectChat(outgoing),true);assert.equal(f.doc.getElementById('codex-composer').value,latest);
});
