/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, type ChatAction, type ChatState } from '../../apps/desktop/src/codex-chat.js';

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
  hidden=false;activeElement=null;defaultView=new EventTarget();private elements=new Map<string,Element>();
  getElementById(id:string):Element {
    let element=this.elements.get(id);
    if(!element){element=new Element();if(id==='codex-composer')element.tagName='TEXTAREA';this.elements.set(id,element);}
    return element;
  }
  createElement(){return new Element();}
  asDocument(){return this as unknown as Document;}
}
function initial():ChatState {
  return {provider:'codex',use:'personal-local',projectPath:resolve('.'),connecting:false,closing:false,busy:false,
    actions:[],lastSnapshot:null,nativeTools:{configured:true,verified:false},snapshot:{
      connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,
      account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},
      models:[{model:'latency-fixture',id:'latency-id',displayName:'Latency fixture',efforts:['low'],defaultEffort:'low',entitlement:'unverified'}],
      selection:{model:'latency-fixture',effort:'low'},thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null}};
}
type Internals={submitMessage():Promise<void>;dispatch(action:string,fields?:Record<string,unknown>):Promise<unknown>};
async function fixture(t:test.TestContext,mode:'acknowledged'|'rejected'|'unknown'|'transport'='acknowledged') {
  const doc=new DocumentFixture(),state=initial(),posts:ChatAction[]=[],reads:number[]=[];
  let holdReads=false,release!:()=>void;const readGate=new Promise<void>(done=>{release=done;});
  let holdAction=false,releaseAction!:()=>void;const actionGate=new Promise<void>(done=>{releaseAction=done;});
  const chat=new CodexChat(doc.asDocument(),new CodexChatApi('a'.repeat(64),async(_path,init)=>{
    if(init?.method!=='POST'){
      reads.push(posts.length);if(holdReads)await readGate;return Response.json({state});
    }
    const input=JSON.parse(String(init.body)) as ChatAction;posts.push(input);if(holdAction)await actionGate;
    if(mode==='transport')throw new Error('Synthetic transport failure');
    if(mode==='acknowledged'&&input.action==='thread-start')state.snapshot!.thread={threadId:'latency-thread',sessionId:null,
      configured:true,writeGranted:false,selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
    if(mode==='acknowledged'&&input.action==='turn-start')Object.assign(state.snapshot!.thread!,{turnId:'latency-turn',turnStatus:'inProgress'});
    const stamp=new Date().toISOString();
    const record={requestId:input.requestId,connectionId:input.connectionId,action:input.action,state:mode,
      errorCode:mode==='acknowledged'?null:'TIMEOUT',threadId:state.snapshot!.thread?.threadId??null,
      turnId:state.snapshot!.thread?.turnId??null,model:'latency-fixture',effort:'low',createdAt:stamp,finishedAt:stamp};
    state.actions.push(record as ChatState['actions'][number]);
    return Response.json({record,replayed:false,state},{status:mode==='rejected'?409:mode==='unknown'?202:200});
  }));
  await chat.start();t.after(()=>{release();releaseAction();chat.stop();});
  doc.getElementById('codex-model').value='latency-fixture';doc.getElementById('codex-effort').value='low';
  const controller=chat as unknown as Internals;
  return {chat,controller,doc,state,posts,reads,hold(){holdReads=true;},release,holdAction(){holdAction=true;},releaseAction};
}
const settle=()=>new Promise<void>(done=>setImmediate(done));

test('acknowledged thread setup sends the exact draft without waiting for a redundant state read',async t=>{
  const f=await fixture(t);f.hold();
  const draft='Exact prompt\nwith trailing spaces.  ';f.doc.getElementById('codex-composer').value=draft;
  let completed=false;const sending=f.controller.submitMessage().then(()=>{completed=true;});
  for(let i=0;i<20&&!completed;i++)await settle();
  assert.equal(completed,true,'An acknowledged setup must not wait on another GET before sending.');
  await sending;
  assert.deepEqual(f.posts.map(row=>row.action),['thread-start','turn-start']);
  const turn=f.posts[1]!;assert.equal(turn.action,'turn-start');if(turn.action!=='turn-start')return;
  assert.equal(turn.text,draft);assert.equal(turn.threadId,'latency-thread');
  assert.equal(f.reads.length,1,'Validated action state avoids serial post-action GETs.');
  assert.equal(f.doc.getElementById('codex-composer').value,'');
  assert.equal(f.state.snapshot!.thread!.turnStatus,'inProgress');
});

for(const mode of ['rejected','unknown','transport'] as const)test(mode+' setup still waits for state reconciliation and never submits a turn',async t=>{
  const f=await fixture(t,mode);f.hold();const draft='Keep this failed setup draft';f.doc.getElementById('codex-composer').value=draft;
  let completed=false;const sending=f.controller.submitMessage().then(()=>{completed=true;});
  for(let i=0;i<20&&f.reads.length<2;i++)await settle();
  assert.equal(f.reads.length,2);assert.equal(completed,false,'Failure recovery must reconcile before finishing.');
  assert.deepEqual(f.posts.map(row=>row.action),['thread-start']);
  f.release();await sending;
  assert.equal(f.doc.getElementById('codex-composer').value,draft);
  assert.deepEqual(f.posts.map(row=>row.action),['thread-start']);
});

test('a successful response fenced by a scope generation change still reconciles before any turn',async t=>{
  const f=await fixture(t);f.hold();f.holdAction();f.doc.getElementById('codex-composer').value='Preserve fenced draft';
  let completed=false;const sending=f.controller.submitMessage().then(()=>{completed=true;});
  for(let i=0;i<20&&!f.posts.length;i++)await settle();
  assert.equal(f.posts.length,1);
  (f.chat as unknown as {generation:number}).generation++;
  f.releaseAction();for(let i=0;i<20&&f.reads.length<2;i++)await settle();
  assert.equal(f.reads.length,2);assert.equal(completed,false);
  f.release();await sending;
  assert.deepEqual(f.posts.map(row=>row.action),['thread-start']);
  assert.equal(f.doc.getElementById('codex-composer').value,'Preserve fenced draft');
});

for(const mode of ['rejected','unknown','transport'] as const)test(mode+' turn recovery reconciles once and preserves duplicate-send fences',async t=>{
  const f=await fixture(t,mode);f.state.snapshot!.thread={threadId:'latency-thread',sessionId:null,configured:true,
    writeGranted:false,selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
  await f.chat.refresh();f.hold();
  const draft='Exact failed turn\nwith trailing spaces.  ';f.doc.getElementById('codex-composer').value=draft;
  let completed=false;const sending=f.controller.submitMessage().then(()=>{completed=true;});
  for(let i=0;i<20&&f.reads.length<3;i++)await settle();
  assert.equal(f.reads.length,3);assert.equal(completed,false);
  f.release();await sending;
  assert.deepEqual(f.posts.map(row=>row.action),['turn-start']);
  assert.equal(f.doc.getElementById('codex-composer').value,mode==='rejected'?draft:'',f.doc.getElementById('codex-notice').textContent);
});

test('fresh acknowledged chat state replaces the initial connect hint without clearing real failures',async t=>{
  const f=await fixture(t);f.state.snapshot!.thread={threadId:'latency-thread',sessionId:null,configured:true,writeGranted:false,
    selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
  f.doc.getElementById('codex-notice').textContent='Connected. Choose a model to continue.';await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-notice').textContent,'Continue in this conversation.');
  f.doc.getElementById('codex-notice').textContent='Mesh export failed: invalid material assignment.';await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-notice').textContent,'Mesh export failed: invalid material assignment.');
  assert.equal(f.doc.getElementById('codex-model').disabled,false);assert.equal(f.posts.length,0);
});

test('an unresolved chat request shows its exact blocker and an explicit reviewed-state recovery without replaying it',async t=>{
  const f=await fixture(t);const requestId=randomUUID(),snapshot=f.state.snapshot!;
  snapshot.thread={threadId:'latency-thread',sessionId:null,configured:true,writeGranted:false,selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
  const input={requestId,connectionId:snapshot.connectionId,action:'turn-start' as const,threadId:'latency-thread',text:'Original message'};
  (f.chat as unknown as {uncertain:Map<string,unknown>}).uncertain.set(requestId,{input,read:false});
  const at=new Date().toISOString();f.state.actions.push({requestId,connectionId:snapshot.connectionId,action:'turn-start',state:'unknown',errorCode:'TIMEOUT',threadId:'latency-thread',turnId:null,model:'latency-fixture',effort:'low',createdAt:at,finishedAt:at});
  f.doc.getElementById('codex-composer').value='Retained next draft';await f.chat.refresh();
  const readiness=f.doc.getElementById('codex-readiness');assert.match(readiness.textContent,/previous request needs review/);assert.match(readiness.textContent,/TIMEOUT/);
  assert.equal(f.doc.getElementById('codex-model').disabled,true);assert.equal(f.doc.getElementById('codex-submit').disabled,true);
  let review=readiness.children.find(child=>child.textContent==='Acknowledge reviewed state')!;assert.equal(review.disabled,true);
  f.state.actions[0]!.state='rejected';f.state.actions[0]!.errorCode='REMOTE_REJECTED';await f.chat.refresh();
  review=readiness.children.find(child=>child.textContent==='Acknowledge reviewed state')!;assert.equal(review.disabled,false);review.dispatchEvent(new Event('click'));
  assert.equal(f.doc.getElementById('codex-model').disabled,false);assert.equal(f.doc.getElementById('codex-submit').disabled,false);
  assert.equal(f.doc.getElementById('codex-composer').value,'Retained next draft');assert.equal(f.posts.length,0);
});
