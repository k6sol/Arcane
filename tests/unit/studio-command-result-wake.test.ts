import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../../packages/storage/src/studio-store.js';

// Disposable SQLite and synthetic paired read-command ACKs. No engine/app/provider.
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'arcane-receipt-wake-')),store=new StudioStore({directory});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['scene.import_context'],identity:{clientSessionId:'wake-plugin',pluginVersion:'0.1.9',name:'Wake fixture',placeId:12,universeId:34}});
  const enqueue=()=>store.enqueue({sessionId:pair.sessionId,requestId:'receipt_'+randomUUID(),method:'scene.import_context',args:{}});
  const ack=(id:string)=>store.result({sessionId:pair.sessionId,commandId:id,state:'succeeded',result:{fixture:true}});
  t.after(()=>{store.close();const part=relative(tmpdir(),directory);assert.ok(part.startsWith('arcane-receipt-wake-')&&!part.includes('..')&&!isAbsolute(part));rmSync(directory,{recursive:true,force:true});});
  return {directory,store,pair,enqueue,ack};
}
const microtasks=async()=>{await Promise.resolve();await Promise.resolve();};

test('committed result wakes without advancing the fallback timer and is already durable',async t=>{
  const f=fixture(t),c=f.enqueue();assert.equal(f.store.poll(f.pair.sessionId)[0]?.id,c.id);
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;assert.equal(f.store.command(c.id).state,'succeeded');});
  await microtasks();assert.equal(settled,false);f.ack(c.id);await waiting;assert.equal(settled,true);
  const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{assert.equal(db.prepare('SELECT state FROM commands WHERE id=?').get(c.id)?.state,'succeeded');}finally{db.close();}
});

test('completion before subscription is found by terminal recheck without a notification replay',async t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(f.pair.sessionId);f.ack(c.id);
  t.mock.timers.enable({apis:['setTimeout']});
  for(let i=0;i<150;i++)await f.store.waitForCommandResult(c.id,25);
  assert.equal(f.store.command(c.id).state,'succeeded');
});

test('a real receipt transaction rollback never publishes a wake or an outcome',async t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(f.pair.sessionId);
  const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;});
  try{
    db.exec("CREATE TRIGGER fixture_wake_rollback BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'fixture receipt rollback'); END;");
    assert.throws(()=>f.ack(c.id),/fixture receipt rollback/);await microtasks();
    assert.equal(settled,false);assert.equal(f.store.command(c.id).state,'dispatched');
    db.exec('DROP TRIGGER fixture_wake_rollback');f.ack(c.id);await waiting;assert.equal(settled,true);
  }finally{db.close();}
});

test('invalid receipt leaves the waiter pending; failed committed receipt wakes for a fresh refusal',async t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(f.pair.sessionId);
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;});
  assert.throws(()=>f.store.result({sessionId:f.pair.sessionId,commandId:c.id,state:'not-terminal',result:{}}));
  await microtasks();assert.equal(settled,false);
  f.store.result({sessionId:f.pair.sessionId,commandId:c.id,state:'failed',error:'fixture failure'});
  await waiting;assert.equal(f.store.command(c.id).state,'failed');assert.equal(settled,true);
});

test('non-result cancellation retains the <=25ms fallback',async t=>{
  const f=fixture(t),c=f.enqueue();t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;});
  f.store.revoke(f.pair.sessionId);await microtasks();assert.equal(settled,false);
  t.mock.timers.tick(24);await microtasks();assert.equal(settled,false);
  t.mock.timers.tick(1);await waiting;assert.equal(f.store.command(c.id).state,'cancelled');
});

test('waiter limits, timeout cleanup and close are bounded and never grant a receipt',async t=>{
  const f=fixture(t),commands=Array.from({length:16},()=>f.enqueue());t.mock.timers.enable({apis:['setTimeout']});
  const waiting=commands.flatMap(c=>Array.from({length:8},()=>f.store.waitForCommandResult(c.id,25)));
  assert.throws(()=>f.store.waitForCommandResult(commands[0]!.id,25),{code:'BUSY'});
  assert.throws(()=>f.store.waitForCommandResult(randomUUID(),25),{code:'BUSY'});
  t.mock.timers.tick(25);await Promise.all(waiting);
  const again=Array.from({length:8},()=>f.store.waitForCommandResult(commands[0]!.id,25));
  f.store.close();await Promise.all(again);
  assert.throws(()=>f.store.waitForCommandResult(commands[0]!.id,25),{code:'STUDIO_STAGE_CLOSED'});
});

test('bad wait arguments and unknown commands cannot retain waiter capacity',async t=>{
  const f=fixture(t),c=f.enqueue();
  for(const ms of [0,26,NaN,Infinity])assert.throws(()=>f.store.waitForCommandResult(c.id,ms),{code:'INPUT'});
  assert.throws(()=>f.store.waitForCommandResult(c.id+'\n',25),{code:'INPUT'});
  for(let i=0;i<150;i++)await assert.rejects(f.store.waitForCommandResult(randomUUID(),25),{code:'COMMAND'});
  f.store.close();
});

test('finite fractional fallback retains setTimeout semantics',async t=>{
  const f=fixture(t),c=f.enqueue();t.mock.timers.enable({apis:['setTimeout']});
  const waiting=f.store.waitForCommandResult(c.id,12.5);t.mock.timers.tick(13);await waiting;
  assert.equal(f.store.command(c.id).state,'queued');
});

test('unknown persisted state retains fallback and cannot create an immediate wake spin',async t=>{
  const f=fixture(t),c=f.enqueue(),db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{db.prepare('UPDATE commands SET state=? WHERE id=?').run('invalid-fixture-state',c.id);}finally{db.close();}
  t.mock.timers.enable({apis:['setTimeout']});let settled=false;
  const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;});
  await microtasks();assert.equal(settled,false);t.mock.timers.tick(24);await microtasks();assert.equal(settled,false);
  t.mock.timers.tick(1);await waiting;assert.equal(settled,true);
});

test('recognized terminal column with pending payload retains fallback instead of spinning',async t=>{
  const f=fixture(t),c=f.enqueue(),db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{db.prepare('UPDATE commands SET state=? WHERE id=?').run('succeeded',c.id);}finally{db.close();}
  t.mock.timers.enable({apis:['setTimeout']});let settled=false;
  const waiting=f.store.waitForCommandResult(c.id,25).then(()=>{settled=true;});
  await microtasks();assert.equal(settled,false);t.mock.timers.tick(24);await microtasks();assert.equal(settled,false);
  t.mock.timers.tick(1);await waiting;assert.equal(f.store.command(c.id).state,'queued');
});
