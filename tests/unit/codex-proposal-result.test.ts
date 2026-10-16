import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProposalResult, PROPOSAL_OUTPUT_BYTES } from '../../packages/codex-client/src/proposal-result.js';
import type { SessionEvent, Snapshot, ThreadState } from '../../packages/codex-client/src/types.js';

const thread:ThreadState={threadId:'worker-thread',sessionId:'worker-session',selection:{model:'model',effort:'low'},configured:true,writeGranted:false,turnId:'worker-turn',turnStatus:'completed'};
function state(events:SessionEvent[]):Snapshot{return{connectionId:'worker',provenance:'spawned-node-fixture',mcpIsolation:'proposal-verified',connected:true,ready:true,
  account:{auth:'subscription',plan:'pro',requiresOpenaiAuth:true},models:[],selection:thread.selection,thread:structuredClone(thread),
  operations:[{operationId:'operation',method:'turn/start',requestId:4,threadId:thread.threadId,turnId:thread.turnId,state:'acknowledged',errorCode:null}],
  approvals:[],events,droppedEvents:0,lastEventSeq:events.at(-1)?.seq??0,failureCode:null};}
const delta=(seq:number,text:string,itemId='answer'):SessionEvent=>({seq,type:'delta',threadId:thread.threadId,turnId:thread.turnId!,itemId,text});
const completed=(seq:number):SessionEvent=>({seq,type:'turn',threadId:thread.threadId,turnId:thread.turnId!,status:'completed'});
function collect(snapshot:Snapshot,baseline=state([])){
  return collectProposalResult({snapshot:()=>snapshot,ack:structuredClone(thread),baseline,assertOwner:()=>{},signal:new AbortController().signal,deadline:Date.now()+1000});
}

test('proposal projection retains exact scope and text without an acceptance claim',async()=>{
  const result=await collect(state([delta(1,'First'),delta(2,' second'),delta(3,'Third','second-message'),completed(4)]));
  assert.deepEqual(result,{threadId:'worker-thread',sessionId:'worker-session',turnId:'worker-turn',text:'First second\n\nThird',status:'proposed'});
  assert.equal(Object.isFrozen(result),true);
});

test('proposal UTF-8 bound includes multibyte output and message separators',async()=>{
  const exact='\u{1f680}'.repeat(PROPOSAL_OUTPUT_BYTES/4);
  assert.equal((await collect(state([delta(1,exact),completed(2)]))).text,exact);
  for(const events of [[delta(1,exact+'x'),completed(2)],[delta(1,exact),delta(2,'x','another'),completed(3)]])
    await assert.rejects(collect(state(events)),{code:'PROPOSAL_OUTPUT',dispatched:true});
});

for(const [name,alter] of [
  ['dropped events',(s:Snapshot)=>{s.droppedEvents=1;}],
  ['sequence gap',(s:Snapshot)=>{s.events[1]!.seq=3;s.lastEventSeq=3;}],
  ['missing last event',(s:Snapshot)=>{s.lastEventSeq=3;}],
  ['wrong thread',(s:Snapshot)=>{s.thread!.threadId='other';}],
  ['wrong session',(s:Snapshot)=>{s.thread!.sessionId='other';}],
  ['wrong turn',(s:Snapshot)=>{s.thread!.turnId='other';}],
  ['wrong model',(s:Snapshot)=>{s.thread!.selection.model='other';}],
  ['unacknowledged operation',(s:Snapshot)=>{s.operations[0]!.state='unknown';}],
  ['second operation',(s:Snapshot)=>{s.operations.push({...s.operations[0]!});}],
  ['foreign event',(s:Snapshot)=>{s.events[0]={seq:1,type:'delta',threadId:thread.threadId,turnId:'other',itemId:'answer',text:'Foreign'};}],
  ['disconnected worker',(s:Snapshot)=>{s.connected=false;}],
  ['missing completion event',(s:Snapshot)=>{s.events.pop();s.lastEventSeq=1;}],
  ['account change',(s:Snapshot)=>{s.events[0]={seq:1,type:'account-changed'};}],
  ['turn error',(s:Snapshot)=>{s.events[0]={seq:1,type:'error',threadId:thread.threadId,turnId:thread.turnId,code:'TURN_ERROR'};}],
] as const)test('proposal projection refuses '+name+' instead of partial output',async()=>{
  const snapshot=state([delta(1,'Partial'),completed(2)]);alter(snapshot);
  await assert.rejects(collect(snapshot),{code:'PROPOSAL_INCOMPLETE',dispatched:true});
});

test('proposal projection refuses late text, empty text and an unobserved terminal turn',async()=>{
  for(const events of [[completed(1),delta(2,'late')],[delta(1,' \n'),completed(2)],[]])
    await assert.rejects(collect(state(events)),{code:'PROPOSAL_INCOMPLETE'});
});

test('proposal projection observes consecutive snapshots once and checks ownership until completion',async()=>{
  const first=state([delta(1,'First')]);first.thread!.turnStatus='inProgress';
  const second=state([delta(1,'First'),delta(2,' second'),completed(3)]);
  let reads=0,assertions=0;
  const result=await collectProposalResult({snapshot:()=>++reads===1?first:second,ack:structuredClone(thread),baseline:state([]),
    assertOwner:()=>{assertions++;},signal:new AbortController().signal,deadline:Date.now()+1000});
  assert.equal(result.text,'First second');assert.equal(reads,2);assert.ok(assertions>=3);
});

test('proposal projection deadline and retired ownership never return retained text',async()=>{
  const snapshot=state([delta(1,'Partial'),completed(2)]);
  await assert.rejects(collectProposalResult({snapshot:()=>snapshot,ack:thread,baseline:state([]),assertOwner:()=>{},
    signal:new AbortController().signal,deadline:Date.now()-1}),{code:'PROPOSAL_TIMEOUT',dispatched:true});
  await assert.rejects(collectProposalResult({snapshot:()=>snapshot,ack:thread,baseline:state([]),assertOwner:()=>{throw new Error('Retired owner');},
    signal:new AbortController().signal,deadline:Date.now()+1000}),/Retired owner/);
});
