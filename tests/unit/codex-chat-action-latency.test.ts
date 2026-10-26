/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, type ChatAction, type ChatState,type ChatQueueRow } from '../../apps/desktop/src/codex-chat.js';
import { startChatAttachments, claimChatAttachments } from '../../apps/desktop/src/chat-attachments.js';
import { referenceInput, referencePng } from '../../packages/codex-client/testing/reference-fixture.js';
import { referenceImageMetadata } from '../../packages/codex-client/src/reference-images.js';

class Element extends EventTarget {
  tagName=''; value=''; checked=false; disabled=false; hidden=false; open=false; type=''; className='';
  dataset:Record<string,string>={}; children:Element[]=[]; scrollHeight=0;scrollTop=0;clientHeight=0;
  files:File[]=[];multiple=false;accept='';src='';width=0;height=0;naturalWidth=128;naturalHeight=128;style:Record<string,string>={};
  private trustedListeners=new Map<string,Set<EventListenerOrEventListenerObject>>();
  private content='';private attributes=new Map<string,string>();
  get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.content=value;this.children=[];}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  removeAttribute(name:string){this.attributes.delete(name);}
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:AddEventListenerOptions|boolean):void{
    super.addEventListener(type,callback,options);if(!callback)return;
    const set=this.trustedListeners.get(type)??new Set<EventListenerOrEventListenerObject>();set.add(callback);this.trustedListeners.set(type,set);
  }
  override removeEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:EventListenerOptions|boolean):void{
    super.removeEventListener(type,callback,options);if(callback)this.trustedListeners.get(type)?.delete(callback);
  }
  emitTrusted(type:string):void{
    const event={type,isTrusted:true,preventDefault(){},stopImmediatePropagation(){}} as unknown as Event;
    for(const listener of this.trustedListeners.get(type)??[])if(typeof listener==='function')listener(event);else listener.handleEvent(event);
  }
  click(){} async decode(){}
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
      turnId:state.snapshot!.thread?.turnId??null,model:'latency-fixture',effort:'low',createdAt:stamp,finishedAt:stamp,
      ...(input.action==='turn-start'&&input.references?{references:referenceImageMetadata(input.references)}:{})};
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
  // One recovery card carries the request (details collapsed); the composer only says why Send waits, with no second set of controls.
  const readiness=f.doc.getElementById('codex-readiness'),card=f.doc.getElementById('codex-unknown'),review=f.doc.getElementById('codex-acknowledge');
  assert.equal(readiness.hidden,false);assert.equal(readiness.dataset.reason,'recovery');assert.equal(readiness.children.length,1,'the composer has no recovery buttons');
  assert.doesNotMatch(readiness.textContent,/TIMEOUT|[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(card.hidden,false);assert.equal(card.dataset.state,'unconfirmed','read, still unknown on the live connection');assert.match(f.doc.getElementById('codex-unknown-requests').textContent,new RegExp(requestId+' · turn-start · unknown · TIMEOUT'));
  assert.doesNotMatch(f.doc.getElementById('codex-unknown-title').textContent+f.doc.getElementById('codex-unknown-body').textContent,/TIMEOUT|[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(f.doc.getElementById('codex-model').disabled,true);assert.equal(f.doc.getElementById('codex-submit').disabled,true);
  assert.equal(review.disabled,true);
  f.state.actions[0]!.state='rejected';f.state.actions[0]!.errorCode='REMOTE_REJECTED';await f.chat.refresh();
  assert.equal(card.dataset.state,'checked');assert.equal(review.disabled,false);review.dispatchEvent(new Event('click'));assert.equal(card.hidden,true);assert.equal(readiness.hidden,true);
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
  if(change==='files')f.chat.enableTextAttachments({prepareText:(message:string)=>message,prepareReferences:()=>[],selectionRevision:()=>revision,beginSend:()=>({unchanged:()=>true,finish(){}}),syncScope(){},clear(){cleared++;},stop(){},resume(){},cleanup(){}});
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

/** Real attachment/controller + CodexChat path; only DOM image decoding is a synthetic 128x128 witness. */
async function referenceFixture(t:test.TestContext,mode:'acknowledged'|'unknown'|'transport'='acknowledged'){
  const f=await fixture(t,mode);
  f.state.snapshot!.thread={threadId:'latency-thread',sessionId:null,configured:true,writeGranted:false,
    selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
  await f.chat.refresh();
  const controller=startChatAttachments(f.doc.asDocument(),{getScope:()=>f.chat.textAttachmentScope(),imageInputAvailable:()=>true,
    onChange:()=>f.chat.attachmentPresentationChanged()});
  f.chat.enableTextAttachments(controller);t.after(()=>controller.cleanup());
  const choose=async(name:string)=>{
    f.doc.getElementById('workspace-add-context').emitTrusted('click');
    const picker=f.doc.getElementById('codex-attachment-input');
    picker.files=[new File([Uint8Array.from(referencePng()).buffer],name,{type:'image/png'})];picker.emitTrusted('change');
    for(let i=0;i<20;i++){
      await settle();try{if(controller.prepareReferences().some(image=>image.name===name))return;}catch{/* The actual controller still owns its read. */}
    }
    assert.fail('The synthetic reference did not finish the real attachment controller intake.');
  };
  await choose('original.png');
  return {...f,attachments:controller,choose};
}
function holdReferenceDigest(t:test.TestContext,reject=false){
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(done=>entered=done),gate=new Promise<void>(done=>release=done),digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{entered();await gate;if(reject)throw new Error('Synthetic digest refusal');return digest(...args);});
  t.after(()=>release());return{started,release};
}

test('local PNG verification rejection retains exact caption and original reference, then one explicit retry sends once',{timeout:10_000},async t=>{
  const f=await referenceFixture(t),caption='Exact reference caption\nwith trailing spaces.  ',original=f.attachments.prepareReferences();
  const input=f.doc.getElementById('codex-composer');input.value=caption;
  const prepared=f.attachments.prepareText(caption),digest=crypto.subtle.digest.bind(crypto.subtle);let first=true;
  t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{if(first){first=false;throw new Error('Synthetic digest refusal');}return digest(...args);});
  await f.controller.submitMessage();
  assert.equal(f.posts.length,0,'verification refused before any POST');
  assert.equal(input.value,caption);assert.deepEqual(f.attachments.prepareReferences(),original);
  assert.ok(f.doc.getElementById('codex-attachments').textContent.includes('original.png'),'the original reference chip stays available');
  await settle();assert.equal(f.posts.length,0,'recovery never resends automatically');
  await f.controller.submitMessage();
  assert.equal(f.posts.length,1);const posted=f.posts[0]!;assert.equal(posted.action,'turn-start');
  if(posted.action!=='turn-start')assert.fail('Expected explicit turn start');
  assert.equal(posted.text,prepared);assert.deepEqual(posted.references,original);
  assert.deepEqual(f.attachments.prepareReferences(),[],'accepted delivery consumes the original selection');
});

test('cancelling held PNG verification before POST preserves caption and validated references',{timeout:10_000},async t=>{
  const f=await referenceFixture(t),held=holdReferenceDigest(t),caption='Cancel preparation, keep my files',original=f.attachments.prepareReferences();
  f.doc.getElementById('codex-composer').value=caption;
  const sending=f.controller.submitMessage();await held.started;
  const image=(f.chat as unknown as {imageRequest:AbortController|null}).imageRequest;assert.ok(image);image.abort();held.release();await sending;
  assert.equal(f.posts.length,0);assert.equal(f.doc.getElementById('codex-composer').value,caption);
  assert.deepEqual(f.attachments.prepareReferences(),original);assert.ok(f.doc.getElementById('codex-attachments').textContent.includes('original.png'));
});

for(const newerCaption of ['', 'Newer caption, keep it'])test('failed PNG send does not associate its old caption with newer references: '+(newerCaption?'nonempty':'empty'),{timeout:10_000},async t=>{
  const f=await referenceFixture(t),held=holdReferenceDigest(t,true),input=f.doc.getElementById('codex-composer');
  input.value='Old caption';const sending=f.controller.submitMessage();await held.started;
  f.attachments.clear();await f.choose('newer.png');input.value=newerCaption;
  const newer=f.attachments.prepareReferences();held.release();await sending;
  assert.equal(f.posts.length,0);assert.equal(input.value,newerCaption,'even an empty new draft must not inherit the old caption');
  assert.deepEqual(f.attachments.prepareReferences(),newer);assert.deepEqual(newer.map(image=>image.name),['newer.png']);
});

for(const change of ['project','chat','provider','provider-back'] as const)test('late local PNG refusal cannot recover into a changed '+change+' scope',{timeout:10_000},async t=>{
  const f=await referenceFixture(t),held=holdReferenceDigest(t,true),input=f.doc.getElementById('codex-composer');
  input.value='Original scoped caption';const sending=f.controller.submitMessage();await held.started;
  if(change==='project'){f.state.projectPath=resolve('synthetic-other-project');await f.chat.refresh();}
  else if(change==='chat'){f.state.snapshot!.thread!.threadId='other-thread';await f.chat.refresh();}
  else {
    f.chat.yieldSurface(true);
    claimChatAttachments(f.doc.asDocument(),{getScope:()=> 'synthetic-claude-tab',imageInputAvailable:()=>true});
    if(change==='provider-back'){claimChatAttachments(f.doc.asDocument(),null);f.chat.yieldSurface(false);}
  }
  f.attachments.syncScope();await f.choose('same-name-new-scope.png');input.value='';
  const newer=f.attachments.prepareReferences();held.release();await sending;
  assert.equal(f.posts.length,0);assert.equal(input.value,'');assert.deepEqual(f.attachments.prepareReferences(),newer);
  assert.deepEqual(newer.map(image=>image.name),['same-name-new-scope.png']);
  claimChatAttachments(f.doc.asDocument(),null);
});

test('accepted reference send consumes only its original objects and retains newer same-scope files and caption',{timeout:10_000},async t=>{
  const f=await referenceFixture(t),input=f.doc.getElementById('codex-composer'),revoked:string[]=[],revoke=URL.revokeObjectURL.bind(URL);
  t.mock.method(URL,'revokeObjectURL',(url:string)=>{revoked.push(url);revoke(url);});
  const previews=():string[]=>{
    const walk=(node:Element):Element[]=>[node,...node.children.flatMap(walk)];
    return walk(f.doc.getElementById('codex-attachments')).map(node=>node.src).filter(src=>src.startsWith('blob:'));
  };
  const originalPreview=previews()[0];assert.ok(originalPreview);input.value='Sent caption';f.holdAction();
  const sending=f.controller.submitMessage();for(let i=0;i<20&&!f.posts.length;i++)await settle();
  assert.equal(f.posts.length,1);await f.choose('next.png');input.value='Next caption';
  const nextPreview=previews().find(value=>value!==originalPreview);assert.ok(nextPreview);
  f.releaseAction();await sending;
  assert.equal(input.value,'Next caption');assert.deepEqual(f.attachments.prepareReferences(),[referenceInput(referencePng(),'next.png')]);
  assert.equal(revoked.filter(value=>value===originalPreview).length,1,'the sent preview is released exactly once');
  assert.equal(revoked.includes(nextPreview),false,'the next draft still owns its preview');
  f.attachments.cleanup();assert.equal(revoked.filter(value=>value===nextPreview).length,1,'final cleanup releases the remaining preview once');
});

for(const mode of ['unknown','transport'] as const)test('ambiguous reference delivery consumes its original selection and never replays: '+mode,{timeout:10_000},async t=>{
  const f=await referenceFixture(t,mode);f.doc.getElementById('codex-composer').value='Unconfirmed caption';
  await f.controller.submitMessage();assert.equal(f.posts.length,1);
  assert.equal(f.doc.getElementById('codex-composer').value,'');assert.deepEqual(f.attachments.prepareReferences(),[]);
  await settle();await f.controller.submitMessage();assert.equal(f.posts.length,1,'unconfirmed delivery remains fenced without automatic or blind retry');
});

for(const mode of ['bound','draft','attaching-disabled'] as const)test('plain text keeps its existing send path with the real attachment controller: '+mode,async t=>{
  const f=await fixture(t);
  if(mode!=='draft'){
    f.state.snapshot!.thread={threadId:'latency-thread',sessionId:null,configured:true,writeGranted:false,
      selection:{model:'latency-fixture',effort:'low'},turnId:null,turnStatus:'idle'};
    await f.chat.refresh();
  }
  const attachments=startChatAttachments(f.doc.asDocument(),{getScope:()=>mode==='attaching-disabled'?null:f.chat.textAttachmentScope()});
  f.chat.enableTextAttachments(attachments);t.after(()=>attachments.cleanup());
  const caption='Plain text with its exact whitespace.  ';f.doc.getElementById('codex-composer').value=caption;
  await f.controller.submitMessage();
  assert.deepEqual(f.posts.map(post=>post.action),mode==='draft'?['thread-start','turn-start']:['turn-start']);
  const posted=f.posts.at(-1);assert.ok(posted&&posted.action==='turn-start');assert.equal(posted.text,caption);assert.equal(posted.references,undefined);
});
