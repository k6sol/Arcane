/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, type ChatAction, type ChatState,type ChatQueueRow } from '../../apps/desktop/src/codex-chat.js';

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

type QueueInternals={queue:ChatQueueRow[];queueGesture():string;queueAction(action:'steer'|'next'|'remove'|'edit'|'up'|'down',row:ChatQueueRow,gesture:string,text?:string):boolean;renderControls():void};
const queueController=(f:Awaited<ReturnType<typeof fixture>>)=>f.chat as unknown as QueueInternals;
const queueStore=()=>({version:1 as const,read:async()=>({available:true,projectPath:resolve('.'),rows:[]}),save:async()=>({saved:true as const})});
const enter=(node:Element,extra:Record<string,unknown>={})=>node.dispatchEvent(Object.assign(new Event('keydown',{cancelable:true}),{key:'Enter',isComposing:false,shiftKey:false,ctrlKey:false,altKey:false,metaKey:false,...extra}));

test('Codex Enter queues visible prompts and explicit Steer uses the exact running turn without starting another',async t=>{
  const f=await fixture(t);await f.chat.setQueuePersistence(queueStore());f.doc.getElementById('codex-composer').value='First';await f.controller.submitMessage();
  const input=f.doc.getElementById('codex-composer');input.value='Guidance';enter(input);assert.equal(input.value,'Guidance','the original composer remains until its queue checkpoint succeeds');await settle();await settle();assert.deepEqual(f.chat.queued().map(row=>row.text),['Guidance']);assert.equal(input.value,'');assert.equal(f.posts.length,2);
  const queue=queueController(f),item={...queue.queue[0]!};assert.equal(queue.queueAction('steer',item,queue.queueGesture()),true);await settle();await settle();
  assert.deepEqual(f.posts.map(row=>row.action),['thread-start','turn-start','turn-steer']);const action=f.posts[2]!;assert.equal(action.action,'turn-steer');if(action.action==='turn-steer'){assert.equal(action.expectedTurnId,'latency-turn');assert.equal(action.threadId,'latency-thread');assert.equal(action.text,'Guidance');}
  assert.deepEqual(f.chat.queued(),[]);assert.equal(f.state.snapshot!.thread!.turnId,'latency-turn');
});
test('Codex Send next waits for successful completion and leaves a separate composer draft intact',async t=>{
  const f=await fixture(t);await f.chat.setQueuePersistence(queueStore());const input=f.doc.getElementById('codex-composer');input.value='First';await f.controller.submitMessage();
  input.value='Second';enter(input);await settle();await settle();input.value='Third';enter(input);await settle();await settle();const queue=queueController(f),third={...queue.queue[1]!};
  assert.equal(queue.queueAction('next',third,queue.queueGesture()),true);assert.equal(f.posts.length,2);input.value='Unsent draft';
  f.state.snapshot!.thread!.turnStatus='completed';await f.chat.refresh();await settle();await settle();
  assert.equal(f.posts.length,3);assert.equal(f.posts[2]!.action,'turn-start');if(f.posts[2]!.action==='turn-start')assert.equal(f.posts[2]!.text,'Third');assert.equal(input.value,'Unsent draft');assert.deepEqual(f.chat.queued().map(row=>row.text),['Second']);
});
test('Codex queue actions reject stale gestures and preserve the original text when checkpointing fails',async t=>{
  const f=await fixture(t);let refuse=false;await f.chat.setQueuePersistence({...queueStore(),save:async()=>{if(refuse)throw Error('disk unavailable');return{saved:true as const};}});
  const input=f.doc.getElementById('codex-composer');input.value='First';await f.controller.submitMessage();input.value='Original queued prompt';enter(input);await settle();await settle();
  const queue=queueController(f),row={...queue.queue[0]!},gesture=queue.queueGesture();f.state.snapshot!.thread!.selection.effort='low';f.chat.yieldSurface(true);assert.equal(queue.queueAction('remove',row,gesture),false);f.chat.yieldSurface(false);
  refuse=true;assert.equal(queue.queueAction('steer',{...queue.queue[0]!},queue.queueGesture()),true);await settle();await settle();assert.equal(f.posts.length,2);assert.equal(f.chat.queued()[0]!.text,'Original queued prompt');assert.equal(queue.queue[0]!.state,'paused');
  const ime=input.value='IME text';enter(input,{isComposing:true});assert.equal(input.value,ime);assert.equal(f.chat.queued().length,1);enter(input,{shiftKey:true});assert.equal(input.value,ime);
  refuse=false;assert.equal(queue.queueAction('steer',{...queue.queue[0]!},queue.queueGesture()),true);await settle();await settle();assert.equal(f.posts.length,3,'an explicit retry dispatches only after checkpoint saving succeeds');assert.deepEqual(f.chat.queued(),[]);assert.equal(input.value,ime);
});

test('Codex enqueue waits for secure saving, rejects repeated Enter and retains its composer after a lost save response',async t=>{
  const f=await fixture(t);let release!:()=>void;const gate=new Promise<void>(done=>release=done);t.after(()=>release());let writes=0,fail=false,hold=false;
  await f.chat.setQueuePersistence({...queueStore(),save:async()=>{writes++;if(hold)await gate;if(fail)throw Error('save acknowledgement lost');return{saved:true as const};}});
  const input=f.doc.getElementById('codex-composer');input.value='First';await f.controller.submitMessage();input.value='Earlier queued prompt';enter(input);await settle();await settle();
  const queue=queueController(f);assert.equal(queue.queueAction('edit',{...queue.queue[0]!},queue.queueGesture(),'Earlier queued prompt'),true);
  hold=true;writes=0;input.value='Keep this exact draft  ';
  enter(input);enter(input);assert.equal(input.value,'Keep this exact draft  ');assert.equal(f.chat.queued().length,2);assert.equal(f.posts.length,2);
  const host=f.doc.getElementById('codex-chat-queue'),rows=host.children.filter(node=>node.className==='queue-row');
  assert.equal(host.hidden,false);assert.equal(host.getAttribute('aria-busy'),'true');assert.deepEqual(rows.map(row=>row.children.find(node=>node.className==='queue-text')!.textContent),['Earlier queued prompt','Keep this exact draft']);
  assert.equal(host.children.find(node=>node.className==='queue-busy-notice')!.textContent,'Saving queued messages…');
  const descendants=(node:Element):Element[]=>[node,...node.children.flatMap(descendants)];
  const buttons=rows.flatMap(descendants).filter(node=>['queue-steer','queue-remove','queue-menu-toggle','queue-edit','queue-up','queue-down','queue-next','queue-save','queue-cancel'].includes(node.className));
  assert.equal(buttons.length,18);assert.ok(buttons.every(node=>node.disabled));
  await settle();assert.equal(writes,1);fail=true;release();await settle();await settle();
  assert.equal(input.value,'Keep this exact draft  ');assert.deepEqual(f.chat.queued().map(row=>row.text),['Earlier queued prompt']);assert.equal(f.posts.length,2);assert.equal(host.hidden,false);assert.equal(host.getAttribute('aria-busy'),'false');
  f.state.snapshot!.thread!.turnStatus='completed';await f.chat.refresh();await f.controller.submitMessage();
  assert.equal(f.posts.length,3,'a failed queue checkpoint does not block ordinary Send');
  assert.equal(f.posts[2]!.action,'turn-start');if(f.posts[2]!.action==='turn-start')assert.equal(f.posts[2]!.text,'Keep this exact draft  ');
});

for(const change of ['edit','edit-back','model','provider','files','finished'] as const)test('Codex enqueue pauses after '+change+' during its checkpoint without clearing a current draft',async t=>{
  const f=await fixture(t);let release!:()=>void;const gate=new Promise<void>(done=>release=done);t.after(()=>release());let revision=0,cleared=0;
  await f.chat.setQueuePersistence({...queueStore(),save:async()=>{await gate;return{saved:true as const};}});
  const input=f.doc.getElementById('codex-composer');input.value='First';await f.controller.submitMessage();
  if(change==='files')f.chat.enableTextAttachments({prepareText:(message:string)=>message,prepareReferences:()=>[],selectionRevision:()=>revision,syncScope(){},clear(){cleared++;},stop(){},resume(){},cleanup(){}});
  input.value='Queued original';enter(input);await settle();
  if(change==='edit')input.value='Edited while saving';
  if(change==='edit-back'){input.value='Temporary edit';input.dispatchEvent(new Event('input'));input.value='Queued original';input.dispatchEvent(new Event('input'));}
  if(change==='model'){f.state.snapshot!.models[0]!.efforts.push('high');f.state.snapshot!.thread!.selection.effort='high';await f.chat.refresh();}
  if(change==='provider'){f.chat.yieldSurface(true);input.value='Other provider draft';}
  if(change==='files')revision++;
  if(change==='finished'){f.state.snapshot!.thread!.turnStatus='completed';await f.chat.refresh();}
  release();await settle();await settle();
  assert.equal(input.value,change==='edit'?'Edited while saving':change==='provider'?'Other provider draft':'Queued original');
  assert.equal(queueController(f).queue[0]!.state,'paused');assert.equal(f.posts.length,2);assert.equal(cleared,0);
});
