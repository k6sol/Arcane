import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createNativeRecoveryQuarantine,NativeRecoveryError,NATIVE_RECOVERY_OWNER_CAPACITY,
  type NativeRecoveryAction,type NativeRecoveryTask,type NativeRecoveryLease,type NativeRecoverySnapshot} from '../../apps/daemon/src/native-recovery-quarantine.js';

const id=(number:number)=>'00000000-0000-4000-8000-'+number.toString(16).padStart(12,'0');
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const action=(number:number,fields:Partial<NativeRecoveryAction>={}):NativeRecoveryAction=>({id:id(number),fingerprint:hash('action:'+number),
  action:'select',state:'acknowledged',connectionId:id(100),threadId:'thread:original',...fields});
const task=(number:number,fields:Partial<NativeRecoveryTask>={}):NativeRecoveryTask=>({id:id(number),fingerprint:hash('task:'+number),connectionId:id(100),threadId:'thread:original',...fields});
const lease=(number:number,fields:Partial<NativeRecoveryLease>={}):NativeRecoveryLease=>({id:id(number),connectionId:null,state:'reserved',...fields});
const snapshot=(fields:Partial<NativeRecoverySnapshot>={}):NativeRecoverySnapshot=>({projectPath:resolve('.'),actions:[],tasks:[],leases:[],unclosedProposalIds:[],...fields});
const originals=(value:NativeRecoverySnapshot)=>({actions:value.actions.map(({id,fingerprint})=>({id,fingerprint})),tasks:value.tasks.map(({id,fingerprint})=>({id,fingerprint}))});
const rejects=(code:NativeRecoveryError['code'])=>(error:unknown)=>error instanceof NativeRecoveryError&&error.code===code;

test('all original task states are accounted by connection, not interpreted as closure',()=>{
  // These are the exact metadata projections of seven independently retained
  // task records; no state/evidence/prompt is passed as a settlement proof.
  const states=['working','verified','failed','cancelled','paused','unknown','awaiting_verification'];
  const tasks=states.map((state,index)=>task(index+1,{connectionId:id(100+index),threadId:'thread:'+state,fingerprint:hash(state)}));
  const value=snapshot({tasks}),sealed=createNativeRecoveryQuarantine(value);
  assert.equal(sealed.nativeReservationCount,states.length);assert.deepEqual(sealed.legacyTaskIds,tasks.map(row=>row.id).sort());
  for(const row of tasks){assert.equal(sealed.quarantinesTask(row.id),true);assert.equal(sealed.quarantinesThread(row.threadId),true);}
  sealed.assertUnchanged(originals(value));assert.equal(NATIVE_RECOVERY_OWNER_CAPACITY,128);
});

test('connection aliases deduplicate actions, task-only owners and known next connections without merging a rotation source',()=>{
  const value=snapshot({actions:[action(1),action(2),action(3,{action:'turn-start',nextConnectionId:id(101)}),
    action(4,{action:'task-focus',nextConnectionId:id(102),threadId:'thread:focused'})],
    tasks:[task(10),task(11,{connectionId:id(101)}),task(12,{connectionId:id(103),threadId:'thread:task-only'})],
    leases:[lease(20,{connectionId:id(101),requestId:id(3),state:'bound'})]});
  const sealed=createNativeRecoveryQuarantine(value);assert.equal(sealed.nativeReservationCount,4);
  assert.equal(sealed.quarantinesAction(id(3)),true);assert.equal(sealed.quarantinesThread('thread:task-only'),true);
  sealed.assertNativeAdmission(value.leases);
});

test('unbound connect and failed/acknowledged unmapped rotations retain distinct factory reservations',()=>{
  const rows=[action(1,{action:'connect',state:'rejected',connectionId:null,threadId:null}),
    action(2,{action:'turn-start',state:'rejected'}),action(3,{action:'turn-start',state:'acknowledged'}),action(4,{action:'turn-start',state:'unknown'})];
  const sealed=createNativeRecoveryQuarantine(snapshot({actions:rows}));
  assert.equal(sealed.nativeReservationCount,5,'four possible factories plus one original connection');
  for(const row of rows)assert.equal(sealed.quarantinesAction(row.id),true);
});

test('closed exact connection and request mappings spare only their owners; failed rotation debt survives old closure',()=>{
  const value=snapshot({actions:[action(1,{action:'connect',connectionId:id(100)}),
    action(2,{action:'connect',state:'rejected',connectionId:null,threadId:null}),
    action(3,{action:'turn-start',state:'rejected',threadId:'thread:failed-rotation'}),
    action(4,{action:'turn-start',nextConnectionId:id(101),threadId:'thread:closed-rotation'})],
    tasks:[task(10),task(11,{connectionId:id(101),threadId:'thread:closed-rotation'}),task(12,{connectionId:id(102),threadId:'thread:unsafe'})],
    leases:[lease(20,{connectionId:id(100),requestId:id(1),state:'closed'}),lease(21,{requestId:id(2),state:'closed'}),
      lease(22,{connectionId:id(101),requestId:id(4),state:'closed'})]});
  const sealed=createNativeRecoveryQuarantine(value);assert.equal(sealed.nativeReservationCount,2);
  assert.equal(sealed.quarantinesAction(id(1)),false);assert.equal(sealed.quarantinesAction(id(2)),false);
  assert.equal(sealed.quarantinesAction(id(3)),true);assert.equal(sealed.quarantinesAction(id(4)),false);
  assert.equal(sealed.quarantinesTask(id(10)),false);assert.equal(sealed.quarantinesTask(id(11)),false);assert.equal(sealed.quarantinesTask(id(12)),true);
  assert.equal(sealed.quarantinesThread('thread:closed-rotation'),false);assert.equal(sealed.quarantinesThread('thread:failed-rotation'),true);
  assert.deepEqual(sealed.legacyTaskIds,[id(12)]);sealed.assertNativeAdmission(value.leases);
});

test('unresolved leases count even without actions or tasks, and duplicate current aliases are not extra owners',()=>{
  const value=snapshot({actions:[action(1,{action:'connect',connectionId:null,threadId:null})],
    leases:[lease(10,{requestId:id(1)}),lease(11,{connectionId:id(101),state:'bound'}),lease(12)]});
  const sealed=createNativeRecoveryQuarantine(value);assert.equal(sealed.nativeReservationCount,3);
  const current=[lease(10,{requestId:id(1),connectionId:id(102),state:'bound'}),value.leases[1]!,value.leases[2]!];
  sealed.assertNativeAdmission(current);assert.equal(sealed.nativeReservationCount,3,'later metadata never changes the sealed baseline');
});

test('integrity requires every original hash even when closure avoids quarantine; unrelated new rows are permitted',()=>{
  const value=snapshot({actions:[action(1),action(2)],tasks:[task(3)],leases:[lease(10,{connectionId:id(100),state:'closed'})]});
  const sealed=createNativeRecoveryQuarantine(value),current=originals(value);assert.equal(sealed.nativeReservationCount,0);
  sealed.assertUnchanged({actions:[...current.actions,{id:id(4),fingerprint:hash('new')}],tasks:[...current.tasks,{id:id(5),fingerprint:hash('new task')}]});
  assert.throws(()=>sealed.assertUnchanged({...current,actions:current.actions.slice(1)}),rejects('CHANGED'));
  assert.throws(()=>sealed.assertUnchanged({...current,tasks:[]}),rejects('CHANGED'));
  assert.throws(()=>sealed.assertUnchanged({...current,actions:[{...current.actions[0]!,fingerprint:hash('changed')},current.actions[1]!]}),rejects('CHANGED'));
  assert.throws(()=>sealed.assertUnchanged({...current,tasks:[{...current.tasks[0]!,fingerprint:hash('changed')}] }),rejects('CHANGED'));
  assert.throws(()=>sealed.assertUnchanged({...current,actions:[...current.actions,current.actions[0]!]}),rejects('INPUT'));
});

test('reconstructing a startup seal is stable across row ordering and unrelated live admission',()=>{
  const value=snapshot({actions:[action(2),action(1,{action:'connect'})],tasks:[task(4),task(3)],
    leases:[lease(5,{connectionId:id(100),requestId:id(1),state:'bound'})],unclosedProposalIds:[id(8),id(7)]});
  const before=JSON.stringify(value),first=createNativeRecoveryQuarantine(value),reopened=createNativeRecoveryQuarantine(snapshot({
    ...value,actions:[...value.actions].reverse(),tasks:[...value.tasks].reverse(),unclosedProposalIds:[...value.unclosedProposalIds].reverse()}));
  assert.equal(first.fingerprint,reopened.fingerprint);assert.deepEqual(first.view(),reopened.view());
  first.assertNativeAdmission([...value.leases,lease(6,{connectionId:id(101),state:'bound'})]);assert.equal(JSON.stringify(value),before);
  assert.deepEqual(first.view(),reopened.view());assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first.view()),true);
  assert.equal(Object.isFrozen(first.legacyTaskIds),true);assert.equal(Object.isFrozen(first.legacyProposalIds),true);
  assert.deepEqual(Object.keys(first.view()).sort(),['version','fingerprint','nativeReservations','legacyActions','legacyTasks','legacyThreads','legacyProposals'].sort());
  assert.equal(JSON.stringify(first.view()).includes('thread:'),false);assert.equal(JSON.stringify(first.view()).includes(value.projectPath),false);
});

test('mutating input objects after capture cannot change private quarantine identity or counts',()=>{
  const row={...action(1)},job={...task(2)},native={...lease(3)},proposals=[id(4)];
  const value=snapshot({actions:[row],tasks:[job],leases:[native],unclosedProposalIds:proposals}),sealed=createNativeRecoveryQuarantine(value),view=sealed.view();
  row.connectionId=id(200);row.threadId='thread:changed';job.connectionId=id(201);native.state='closed';proposals.push(id(5));
  assert.equal(sealed.quarantinesThread('thread:original'),true);assert.equal(sealed.quarantinesThread('thread:changed'),false);
  assert.equal(sealed.nativeReservationCount,2);assert.deepEqual(sealed.legacyProposalIds,[id(4)]);assert.equal(sealed.view(),view);
});

test('127 reservations permit exactly one further allocation; 128 and over-cap snapshots refuse without releasing evidence',()=>{
  const held=Array.from({length:127},(_,index)=>lease(index+1));
  const sealed=createNativeRecoveryQuarantine(snapshot({leases:held}));sealed.assertNativeAdmission(held);
  const oneMore=[...held,lease(128)];assert.throws(()=>sealed.assertNativeAdmission(oneMore),rejects('CAPACITY'));
  const full=createNativeRecoveryQuarantine(snapshot({leases:oneMore}));assert.equal(full.nativeReservationCount,128);
  assert.throws(()=>full.assertNativeAdmission(oneMore),rejects('CAPACITY'));
  // Genuine later closure is not invented into a replacement startup proof.
  assert.throws(()=>full.assertNativeAdmission(oneMore.map(row=>({...row,state:'closed' as const}))),rejects('CAPACITY'));
  const over=[...oneMore,lease(129)],overSeal=createNativeRecoveryQuarantine(snapshot({leases:over}));
  assert.equal(overSeal.nativeReservationCount,129);assert.throws(()=>overSeal.assertNativeAdmission(over),rejects('CAPACITY'));
});

test('current new leases sharing a factory request are charged once against an original unbound reservation',()=>{
  const rows=Array.from({length:126},(_,index)=>lease(index+1));
  const value=snapshot({actions:[action(1000,{action:'connect',connectionId:null,threadId:null})],leases:rows});
  const sealed=createNativeRecoveryQuarantine(value);assert.equal(sealed.nativeReservationCount,127);
  sealed.assertNativeAdmission([...rows,lease(1001,{requestId:id(1000),connectionId:id(1002),state:'bound'})]);
  assert.throws(()=>sealed.assertNativeAdmission([...rows,lease(1003,{connectionId:id(1004),state:'bound'})]),rejects('CAPACITY'));
});

test('current original mappings cannot disappear, rebind or reopen a known closed owner',()=>{
  const bound=lease(1,{connectionId:id(100),requestId:id(10),state:'bound'}),closed=lease(2,{connectionId:id(101),state:'closed'});
  const sealed=createNativeRecoveryQuarantine(snapshot({leases:[bound,closed]}));
  for(const rows of [[bound],[{...bound,connectionId:id(102)},closed],[{...bound,requestId:id(11)},closed],
    [lease(1,{requestId:id(10)}),closed],[bound,{...closed,state:'bound' as const}],[bound,closed,lease(3,{requestId:id(10)})]]){
    assert.throws(()=>sealed.assertNativeAdmission(rows),error=>error instanceof NativeRecoveryError);
  }
  assert.equal(sealed.nativeReservationCount,1);
});

test('duplicate IDs, contradictory factory mappings and ambiguous closed aliases refuse instead of hiding debt',()=>{
  const a=action(1,{action:'connect',connectionId:id(100)}),t=task(2),l=lease(3,{connectionId:id(100),requestId:id(1),state:'closed'});
  for(const value of [snapshot({actions:[a,a]}),snapshot({tasks:[t,t]}),snapshot({leases:[l,l]}),snapshot({unclosedProposalIds:[id(4),id(4)]}),
    snapshot({actions:[a],leases:[{...l,connectionId:id(101)}]}),snapshot({actions:[a],leases:[{...l,connectionId:null}]}),
    snapshot({leases:[l,lease(4,{connectionId:id(100),state:'bound'})]}),
    snapshot({leases:[l,lease(4,{requestId:id(1)})]})])assert.throws(()=>createNativeRecoveryQuarantine(value),rejects('INPUT'));
});

test('snapshot boundaries reject accessors, proxies, sparse arrays, inherited fields and oversized input without invoking hooks',()=>{
  let reads=0;const accessor={...action(1)};Object.defineProperty(accessor,'fingerprint',{enumerable:true,get(){reads++;return hash('unexpected');}});
  const coercion={toString(){reads++;return 'unknown';}};
  const revoked=Proxy.revocable([],{get(){reads++;throw Error('must not read');}});revoked.revoke();
  const sparse:NativeRecoveryAction[]=[];sparse.length=1;
  for(const value of [snapshot({actions:[accessor]}),snapshot({actions:[{...action(1),state:coercion} as unknown as NativeRecoveryAction]}),
    snapshot({actions:new Proxy([action(1)],{get(){reads++;throw Error('must not read');}})}),snapshot({actions:revoked.proxy as NativeRecoveryAction[]}),snapshot({actions:sparse}),
    Object.assign(Object.create({projectPath:resolve('.')}),{actions:[],tasks:[],leases:[],unclosedProposalIds:[]}),
    snapshot({actions:Array.from({length:4097},(_,index)=>action(index+1))}),snapshot({tasks:Array.from({length:257},(_,index)=>task(index+1))}),
    snapshot({leases:Array.from({length:4097},(_,index)=>lease(index+1))}),snapshot({unclosedProposalIds:Array.from({length:1025},(_,index)=>id(index+1))})]){
    assert.throws(()=>createNativeRecoveryQuarantine(value),rejects('INPUT'));
  }
  assert.equal(reads,0);
});

test('proposal uncertainty is retained as its own category and adds no invented native owner',()=>{
  const sealed=createNativeRecoveryQuarantine(snapshot({unclosedProposalIds:[id(1),id(2),id(3)]}));
  assert.equal(sealed.nativeReservationCount,0);assert.equal(sealed.view().legacyProposals,3);sealed.assertNativeAdmission([]);
  assert.deepEqual(sealed.legacyProposalIds,[id(1),id(2),id(3)]);
});

test('healthy connect and reused first turns share one exact closed owner without permanent thread quarantine',()=>{
  const value=snapshot({actions:[action(1,{action:'connect'}),action(2,{action:'turn-start'}),action(3,{action:'turn-start'})],tasks:[task(4)],
    leases:[lease(10,{connectionId:id(100),requestId:id(1),requestIds:[id(3),id(2)],state:'closed'})]});
  const sealed=createNativeRecoveryQuarantine(value);assert.equal(sealed.nativeReservationCount,0);assert.deepEqual(sealed.legacyTaskIds,[]);
  for(const row of value.actions)assert.equal(sealed.quarantinesAction(row.id),false);
  assert.equal(sealed.quarantinesTask(id(4)),false);assert.equal(sealed.quarantinesThread('thread:original'),false);
  sealed.assertUnchanged(originals(value));sealed.assertNativeAdmission(value.leases);
  const reopened=createNativeRecoveryQuarantine({...value,leases:[{...value.leases[0]!,requestIds:[id(2),id(3)]}]});
  assert.equal(reopened.fingerprint,sealed.fingerprint);
});

test('reused turns add no factory debt while an unmapped failed rotation remains separately reserved after closure',()=>{
  const actions=[action(1,{action:'connect'}),action(2,{action:'turn-start'}),action(3,{action:'turn-start',state:'rejected'})];
  const bound=lease(10,{connectionId:id(100),requestId:id(1),requestIds:[id(2)],state:'bound'});
  const held=createNativeRecoveryQuarantine(snapshot({actions,leases:[bound]}));assert.equal(held.nativeReservationCount,2);
  const closed=createNativeRecoveryQuarantine(snapshot({actions,leases:[{...bound,state:'closed'}]}));
  assert.equal(closed.nativeReservationCount,1);assert.equal(closed.quarantinesAction(id(2)),false);
  assert.equal(closed.quarantinesAction(id(3)),true);assert.equal(closed.quarantinesThread('thread:original'),true);
});

test('reused aliases require an actual matching turn-start and refuse missing, foreign, rotating or duplicate mappings',()=>{
  const original=lease(10,{connectionId:id(100),requestId:id(1),requestIds:[id(2)],state:'closed'});
  const connect=action(1,{action:'connect'}),turn=action(2,{action:'turn-start'});
  for(const value of [snapshot({actions:[connect,turn],leases:[{...original,requestIds:[]}]}),
    snapshot({actions:[connect],leases:[original]}),
    snapshot({actions:[connect,action(2)],leases:[original]}),
    snapshot({actions:[connect,{...turn,connectionId:id(101)}],leases:[original]}),
    snapshot({actions:[connect,{...turn,nextConnectionId:id(101)}],leases:[original]}),
    snapshot({actions:[connect,turn],leases:[{...original,requestIds:[id(2),id(2)]}]}),
    snapshot({actions:[connect,turn],leases:[{...original,requestIds:[id(1)]}]}),
    snapshot({actions:[connect,turn],leases:[original,lease(11,{connectionId:id(101),requestIds:[id(2)],state:'bound'})]}),
    snapshot({actions:[turn],leases:[lease(10,{requestIds:[id(2)]})]})]){
    assert.throws(()=>createNativeRecoveryQuarantine(value),rejects('INPUT'));
  }
});

test('every original reused alias is immutable during admission, with order independent capture and no rebound',()=>{
  const value=snapshot({actions:[action(1,{action:'connect'}),action(2,{action:'turn-start'}),action(3,{action:'turn-start'}),action(4,{action:'turn-start'})],
    leases:[lease(10,{connectionId:id(100),requestId:id(1),requestIds:[id(2),id(3)],state:'bound'})]});
  const sealed=createNativeRecoveryQuarantine(value),original=value.leases[0]!;
  sealed.assertNativeAdmission([{...original,requestIds:[id(3),id(2)]}]);
  for(const requestIds of [[id(2)],[id(2),id(4)],[id(2),id(3),id(4)]]){
    assert.throws(()=>sealed.assertNativeAdmission([{...original,requestIds}]),rejects('CHANGED'));
  }
  const {requestIds:omitted,...without}=original;assert.ok(omitted);
  assert.throws(()=>sealed.assertNativeAdmission([without]),rejects('CHANGED'));
  assert.throws(()=>sealed.assertNativeAdmission([{...original,requestIds:[id(2)]},
    lease(11,{connectionId:id(101),requestIds:[id(3)],state:'bound'})]),error=>error instanceof NativeRecoveryError);
  assert.equal(sealed.nativeReservationCount,2,'rejected alias changes cannot release the unmapped original rotation');
});

test('only new runtime leases can append reused aliases; input aliases are captured privately',()=>{
  const aliases=[id(2)],value=snapshot({actions:[action(1,{action:'connect'}),action(2,{action:'turn-start'})],
    leases:[lease(10,{connectionId:id(100),requestId:id(1),requestIds:aliases,state:'bound'})]});
  const sealed=createNativeRecoveryQuarantine(value),fingerprint=sealed.fingerprint;
  const fresh=lease(20,{connectionId:id(200),requestId:id(21),requestIds:[id(22)],state:'bound'});
  sealed.assertNativeAdmission([...value.leases,fresh]);
  sealed.assertNativeAdmission([...value.leases,{...fresh,requestIds:[id(22),id(23)]}]);
  aliases.push(id(3));assert.equal(sealed.fingerprint,fingerprint);assert.equal(sealed.nativeReservationCount,1);
  assert.throws(()=>sealed.assertNativeAdmission(value.leases),rejects('CHANGED'));
});

test('allocated and reused aliases share the unchanged 4096-request snapshot bound',()=>{
  const actions=Array.from({length:4096},(_,index)=>action(index+1,{action:'turn-start'}));
  const original=lease(10000,{connectionId:id(100),requestIds:actions.map(row=>row.id),state:'bound'});
  const sealed=createNativeRecoveryQuarantine(snapshot({actions,leases:[original]}));assert.equal(sealed.nativeReservationCount,1);
  sealed.assertNativeAdmission([original]);
  assert.throws(()=>createNativeRecoveryQuarantine(snapshot({actions,leases:[{...original,requestId:id(10001)}]})),rejects('INPUT'));
  assert.throws(()=>createNativeRecoveryQuarantine(snapshot({actions,leases:[{...original,requestIds:[...original.requestIds!,id(10001)]}]})),rejects('INPUT'));
});

test('reused alias descriptors and arrays are validated without reading accessor or proxy hooks',()=>{
  let reads=0;const original=lease(10,{connectionId:id(100),state:'bound'}),accessor={...original};
  Object.defineProperty(accessor,'requestIds',{enumerable:true,get(){reads++;return[id(1)];}});
  const aliasGetter=[id(1)];Object.defineProperty(aliasGetter,'0',{enumerable:true,get(){reads++;return id(1);}});
  const proxied=new Proxy([id(1)],{get(){reads++;throw Error('must not read');}});
  for(const row of [accessor,{...original,requestIds:aliasGetter},{...original,requestIds:proxied},{...original,requestIds:['invalid']}]){
    assert.throws(()=>createNativeRecoveryQuarantine(snapshot({actions:[action(1,{action:'turn-start'})],leases:[row]})),rejects('INPUT'));
  }
  assert.equal(reads,0);
});
