import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AssetConversationSelection,type AssetConversationSelectionValue} from '../../apps/desktop/src/asset-conversation-selection.js';

type Ack={state:'selected'|'unavailable'};
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const app=(conversationId=A):AssetConversationSelectionValue=>({provider:'claude-code',conversationId});
const refused=/not ready for model review/;
function gate<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const pending=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {pending,resolve,reject};}
async function drain(){for(let turn=0;turn<12;turn++)await Promise.resolve();}
function waiting(controller:AssetConversationSelection){const pending=controller.ready();void pending.catch(()=>{});return pending;}
function fixture(t:TestContext){
  const calls:{selection:AssetConversationSelectionValue;gate:ReturnType<typeof gate<Ack>>}[]=[];
  const controller=new AssetConversationSelection({select(selection){const held=gate<Ack>();calls.push({selection,gate:held});return held.pending;}});
  t.after(async()=>{controller.dispose();for(let turn=0;turn<3;turn++){for(const call of calls)call.gate.resolve({state:'unavailable'});await drain();}});
  return {controller,calls};
}

test('no initial or empty focus can become review-ready even if the null clear is acknowledged',async t=>{
  const f=fixture(t);await assert.rejects(f.controller.ready(),refused);assert.equal(f.calls.length,0);
  f.controller.update(null,'empty draft');await assert.rejects(f.controller.ready(),refused);await drain();
  assert.deepEqual(f.calls.map(call=>call.selection),[null]);
  f.calls[0]!.gate.resolve({state:'selected'});await drain();await assert.rejects(f.controller.ready(),refused);
});

test('Codex requires a genuine peer focus key instead of silently inheriting an earlier thread',async t=>{
  const f=fixture(t);f.controller.update({provider:'codex'},null);await drain();
  assert.equal(f.calls[0]!.selection,null);await assert.rejects(f.controller.ready(),refused);
  f.calls[0]!.gate.resolve({state:'unavailable'});await drain();
  f.controller.update({provider:'codex'},'peer-thread-A/session-A');await drain();
  assert.deepEqual(f.calls[1]!.selection,{provider:'codex'});
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await f.controller.ready())(),true);
});

test('fixed wire snapshots contain no focus key and cannot be changed through caller mutation',async t=>{
  const f=fixture(t),selection={provider:'claude-code' as const,conversationId:A};
  f.controller.update(selection,'genuine peer identity');selection.conversationId=B;await drain();
  const wire=f.calls[0]!.selection;assert.deepEqual(wire,{provider:'claude-code',conversationId:A});
  assert.ok(Object.isFrozen(wire));assert.deepEqual(Object.keys(wire!),['provider','conversationId']);
});

test('canonical unchanged focus deduplicates without invalidating an acknowledged review',async t=>{
  const f=fixture(t);let invalidations=0;f.controller.subscribeInvalidate(()=>{invalidations++;});
  f.controller.update(app(),'peer-A');await drain();f.calls[0]!.gate.resolve({state:'selected'});
  const current=await f.controller.ready();assert.equal(current(),true);assert.equal(invalidations,1);
  f.controller.update({conversationId:A,provider:'claude-code'},'peer-A');await drain();
  assert.equal(f.calls.length,1);assert.equal(invalidations,1);assert.equal(current(),true);
});

test('a Codex thread change invalidates synchronously despite an identical wire selection',async t=>{
  const f=fixture(t);f.controller.update({provider:'codex'},'actual-thread-A');await drain();
  f.calls[0]!.gate.resolve({state:'selected'});const old=await f.controller.ready();
  f.controller.update({provider:'codex'},'actual-thread-B');assert.equal(old(),false);
  const fresh=waiting(f.controller);await drain();assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls[1]!.selection,{provider:'codex'});
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await fresh)(),true);
});

test('A to empty to A needs a fresh acknowledgement and cannot reuse the first A receipt',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();
  const old=waiting(f.controller),oldRejected=assert.rejects(old,refused);
  f.controller.update(null,'new draft');f.controller.update(app(),'peer-A');await oldRejected;
  let ready=false;const fresh=waiting(f.controller).then(current=>{ready=true;return current;});void fresh.catch(()=>{});
  f.calls[0]!.gate.resolve({state:'selected'});await drain();
  assert.equal(ready,false);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1]!.selection,app());
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await fresh)(),true);
});

test('one active call and one latest pending focus bound a long burst without losing the final focus',async t=>{
  const f=fixture(t);f.controller.update(app(),'original');await drain();
  let last=app();
  for(let index=0;index<1000;index++){
    last=app('44444444-4444-4444-8444-'+index.toString(16).padStart(12,'0'));
    f.controller.update(last,'peer-'+index);
  }
  assert.equal(f.calls.length,1);
  const fresh=waiting(f.controller);f.calls[0]!.gate.resolve({state:'unavailable'});await drain();
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1]!.selection,last);
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await fresh)(),true);
});

test('an acknowledged promise continuation cannot arm an obsolete focus',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();
  const old=waiting(f.controller),oldRejected=assert.rejects(old,refused);
  f.calls[0]!.gate.resolve({state:'selected'});
  f.controller.update(app(B),'peer-B');await oldRejected;await drain();
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await f.controller.ready())(),true);
});

test('unavailable acknowledgement never retries on ready or unchanged focus updates',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();f.calls[0]!.gate.resolve({state:'unavailable'});
  await assert.rejects(f.controller.ready(),refused);
  f.controller.update(app(),'peer-A');await assert.rejects(f.controller.ready(),refused);await drain();
  assert.equal(f.calls.length,1);
  f.controller.update(app(B),'peer-B');await drain();assert.equal(f.calls.length,2);
});

test('rejected obsolete transport releases the slot for the latest pending focus without a retry',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();
  f.controller.update(app(B),'peer-B');f.controller.update(app(C),'peer-C');const fresh=waiting(f.controller);
  f.calls[0]!.gate.reject(new Error('synthetic private transport failure'));await drain();
  assert.deepEqual(f.calls.map(call=>call.selection),[app(),app(C)]);
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await fresh)(),true);
});

test('synchronous select refusal and reentrant update still service the latest focus serially',async()=>{
  const calls:AssetConversationSelectionValue[]=[];let controller!:AssetConversationSelection;
  controller=new AssetConversationSelection({select(selection){
    calls.push(selection);
    if(calls.length===1){controller.update(app(B),'peer-B');throw new Error('synthetic synchronous refusal');}
    return Promise.resolve<Ack>({state:'selected'});
  }});
  try{
    controller.update(app(),'peer-A');await drain();assert.deepEqual(calls,[app(),app(B)]);
    assert.equal((await controller.ready())(),true);
  }finally{controller.dispose();}
});

test('unknown and accessor acknowledgements fail closed without evaluating their fields',async t=>{
  for(const make of [()=>({state:'selected',permission:true}),()=>({state:'unknown'}),()=>null] as (()=>unknown)[]){
    const f=fixture(t);f.controller.update(app(),'peer-A');await drain();
    f.calls[0]!.gate.resolve(make() as Ack);await assert.rejects(f.controller.ready(),refused);
  }
  const f=fixture(t);let getters=0;f.controller.update(app(),'peer-A');await drain();
  const reply=Object.defineProperty({},'state',{enumerable:true,get(){getters++;return 'selected';}});
  f.calls[0]!.gate.resolve(reply as Ack);await assert.rejects(f.controller.ready(),refused);assert.equal(getters,0);
});

test('obsolete acknowledgement data is not inspected and cannot arm the next selection',async t=>{
  const f=fixture(t);let getters=0;f.controller.update(app(),'peer-A');await drain();f.controller.update(app(B),'peer-B');
  const reply=Object.defineProperty({},'state',{enumerable:true,get(){getters++;return 'selected';}});
  f.calls[0]!.gate.resolve(reply as Ack);await drain();assert.equal(getters,0);
  f.calls[1]!.gate.resolve({state:'selected'});assert.equal((await f.controller.ready())(),true);
});

test('malformed versions variants trailing newlines and caller authority fields clear rather than select a scope',async t=>{
  const invalid:unknown[]=[
    {provider:'claude-code',conversationId:'11111111-1111-0111-8111-111111111111'},
    {provider:'claude-code',conversationId:'11111111-1111-4111-7111-111111111111'},
    {provider:'claude-code',conversationId:A+'\n'},
    {provider:'claude-code',conversationId:A+'\r\n'},
    {provider:'claude-code',conversationId:'shared-tab'},
    {provider:'arcane',conversationId:A,permission:true},
    {provider:'codex',conversationId:A},
    Object.defineProperty({provider:'codex'},'__proto__',{enumerable:true,value:{permission:true}}),
  ];
  for(const value of invalid){
    const f=fixture(t);f.controller.update(value as AssetConversationSelectionValue,'peer');await drain();
    assert.deepEqual(f.calls.map(call=>call.selection),[null]);await assert.rejects(f.controller.ready(),refused);
  }
});

test('invalid focus keys and getter selections cannot preserve or smuggle a prior acknowledged focus',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();f.calls[0]!.gate.resolve({state:'selected'});const old=await f.controller.ready();
  let getters=0;const getter=Object.defineProperty({},'provider',{enumerable:true,get(){getters++;return 'codex';}});
  f.controller.update(getter as AssetConversationSelectionValue,'peer-B');assert.equal(old(),false);await drain();
  assert.equal(getters,0);assert.equal(f.calls[1]!.selection,null);await assert.rejects(f.controller.ready(),refused);
  f.calls[1]!.gate.resolve({state:'selected'});await drain();
  f.controller.update(app(B),'peer-B');await drain();f.calls[2]!.gate.resolve({state:'selected'});const current=await f.controller.ready();
  f.controller.update(app(),'\n');assert.equal(current(),false);await drain();assert.equal(f.calls[3]!.selection,null);
});

test('invalidation is synchronous listener errors are isolated and unsubscribe removes the callback',async t=>{
  const f=fixture(t);let calls=0;
  const unsubscribe=f.controller.subscribeInvalidate(()=>{throw new Error('synthetic view cleanup failure');});
  const remove=f.controller.subscribeInvalidate(()=>{calls++;});
  f.controller.update(app(),'peer-A');assert.equal(calls,1);assert.equal(f.calls.length,0);
  unsubscribe();remove();f.controller.update(app(B),'peer-B');assert.equal(calls,1);await drain();
  assert.deepEqual(f.calls.map(call=>call.selection),[app(B)]);
});

test('reentrant invalidation keeps the new focus instead of restoring the outer pending selection',async t=>{
  const f=fixture(t);let first=true;
  f.controller.subscribeInvalidate(()=>{if(first){first=false;f.controller.update(app(B),'peer-B');}});
  f.controller.update(app(),'peer-A');await drain();assert.deepEqual(f.calls.map(call=>call.selection),[app(B)]);
  f.calls[0]!.gate.resolve({state:'selected'});assert.equal((await f.controller.ready())(),true);
});

test('dispose rejects pending readiness drops queued app focus and ignores late acknowledgements',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();f.controller.update(app(B),'peer-B');
  const pending=waiting(f.controller),rejected=assert.rejects(pending,refused);let invalidations=0;
  f.controller.subscribeInvalidate(()=>{invalidations++;});f.controller.dispose();assert.equal(invalidations,1);await rejected;
  f.controller.update(app(C),'peer-C');f.calls[0]!.gate.resolve({state:'selected'});await drain();
  assert.equal(f.calls.length,1);await assert.rejects(f.controller.ready(),refused);
});

test('dispose preserves only an already-requested null clear and never treats its acknowledgement as ready',async t=>{
  const f=fixture(t);f.controller.update(app(),'peer-A');await drain();
  f.controller.update(null,'pagehide');f.controller.dispose();
  f.calls[0]!.gate.resolve({state:'selected'});await drain();
  assert.deepEqual(f.calls.map(call=>call.selection),[app(),null]);
  f.calls[1]!.gate.resolve({state:'selected'});await drain();assert.equal(f.calls.length,2);
  await assert.rejects(f.controller.ready(),refused);
});

test('disposing an acknowledged focus invalidates the returned guard immediately and remains idempotent',async t=>{
  const f=fixture(t);f.controller.update({provider:'arcane',conversationId:A},null);await drain();
  f.calls[0]!.gate.resolve({state:'selected'});const current=await f.controller.ready();assert.equal(current(),true);
  f.controller.dispose();assert.equal(current(),false);f.controller.dispose();
  let invoked=false;const remove=f.controller.subscribeInvalidate(()=>{invoked=true;});remove();
  f.controller.update(null,null);await drain();assert.equal(invoked,false);assert.equal(f.calls.length,1);
});
