import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {NativeSessionCustody} from '../../apps/daemon/src/native-session-custody.js';
import {createCodexService,type CodexHostClient} from '../../apps/daemon/src/codex-service.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';
import {CodexClientError,type Snapshot} from '../../packages/codex-client/src/types.js';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const rows=(db:DatabaseSync)=>db.prepare('SELECT * FROM native_session_custody ORDER BY rowid').all();
const memory=(t:test.TestContext)=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());return db;};

test('native custody reserves before the factory and retains exact ownership through a held physical close',async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db),allocated=deferred(),factoryGate=deferred(),closeGate=deferred();let closes=0;
  const client={id:randomUUID(),close:()=>{closes++;return closeGate.promise;}};
  const opening=custody.open(async lifecycle=>{
    assert.equal(rows(db)[0]!.state,'reserved');assert.equal(rows(db)[0]!.allocated,0);
    lifecycle.beforeProcessAllocation();assert.equal(rows(db)[0]!.allocated,1);allocated.resolve();await factoryGate.promise;return client;
  },value=>value.id);
  await allocated.promise;assert.equal(rows(db)[0]!.connection_id,null);factoryGate.resolve();assert.equal(await opening,client);
  assert.equal(rows(db)[0]!.state,'bound');custody.writesPossible(client);assert.equal(rows(db)[0]!.writes_possible,1);
  const original=custody.close(client);assert.equal(custody.close(client),original);assert.equal(closes,1);assert.equal(rows(db)[0]!.state,'bound');
  closeGate.resolve();await original;assert.equal(rows(db)[0]!.state,'closed');assert.equal(rows(db)[0]!.close_proof,'owned-transport');
  assert.equal(rows(db)[0]!.writes_possible,1,'Closure never erases earlier write capability');
  assert.throws(()=>custody.writesPossible(client));assert.equal(custody.close(client),original);
});

test('failed injected allocation stays held; only the original factory cleanup port records its closure',async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db),original=Object.freeze({failure:'original'});
  await assert.rejects(custody.open(async()=>{throw original;},()=>randomUUID()),error=>error===original);
  assert.equal(rows(db)[0]!.state,'reserved');assert.equal(rows(db)[0]!.close_proof,null);
  await assert.rejects(custody.open(async lifecycle=>{lifecycle.beforeProcessAllocation();lifecycle.failedInitializationClosed();throw original;},()=>randomUUID()),error=>error===original);
  assert.equal(rows(db)[1]!.state,'closed');assert.equal(rows(db)[1]!.close_proof,'factory-cleanup');
  assert.equal(rows(db)[1]!.connection_id,null);
});

test('native close failure is cached without replacing falsy original errors or releasing custody',async t=>{
  for(const failure of [undefined,null,false,0])await t.test(String(failure),async t=>{
    const db=memory(t),custody=new NativeSessionCustody(db);let closes=0;
    const client=await custody.open(async()=>({id:randomUUID(),close:async()=>{closes++;throw failure;}}),value=>value.id);
    const original=custody.close(client);await original.then(()=>assert.fail('Physical close must fail'),error=>assert.equal(error,failure));
    assert.equal(custody.close(client),original);assert.equal(closes,1);assert.equal(rows(db)[0]!.state,'bound');
  });
});

test('a later close-method replacement cannot take over the original native owner',async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db);let originalCloses=0,replacementCloses=0;
  const client=await custody.open(async()=>({id:randomUUID(),close:async()=>{originalCloses++;}}),value=>value.id);
  client.close=async()=>{replacementCloses++;throw Error('Unrelated replacement');};
  await custody.close(client);assert.equal(originalCloses,1);assert.equal(replacementCloses,0);assert.equal(rows(db)[0]!.close_proof,'owned-transport');
});

test('failed cleanup observation retains the first factory error and fences later allocation',async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db),original=Error('Original initialization failure');let starts=0;
  db.exec("CREATE TRIGGER refuse_custody_cleanup BEFORE UPDATE OF state ON native_session_custody WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'controlled cleanup save refusal'); END");
  await assert.rejects(custody.open(async lifecycle=>{
    lifecycle.beforeProcessAllocation();try{lifecycle.failedInitializationClosed();}catch{/* Real adapter preserves original error too. */}throw original;
  },()=>randomUUID()),error=>error===original);
  assert.equal(custody.faulted,true);assert.equal(rows(db)[0]!.state,'reserved');
  const firstFault=custody.firstFailure;assert.ok(firstFault);assert.equal(firstFault.code,'JOURNAL_FAILURE');assert.match(String(firstFault.cause),/controlled cleanup save refusal/);
  await assert.rejects(custody.open(async()=>{starts++;return{id:randomUUID(),close:async()=>{}};},value=>value.id));assert.equal(starts,0);
  assert.equal(custody.firstFailure,firstFault,'Later admission faults cannot replace the original custody fault');
});

test('physical close cannot certify a changed persisted connection binding',async t=>{
  for(const change of ['connection','reservation']as const)await t.test(change,async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db);let closes=0;
  const client=await custody.open(async()=>({id:randomUUID(),close:async()=>{closes++;}}),value=>value.id),changed=randomUUID();
  if(change==='connection')db.prepare('UPDATE native_session_custody SET connection_id=?').run(changed);
  else db.exec("UPDATE native_session_custody SET state='reserved',connection_id=NULL");
  const before=rows(db);
  await assert.rejects(custody.close(client),/custody changed/);
  assert.equal(closes,1);assert.equal(custody.faulted,true);assert.deepEqual(rows(db),before);
  });
});

test('a genuine binding-save refusal still joins its original client and records confirmed physical cleanup',async t=>{
  const db=memory(t),custody=new NativeSessionCustody(db);let closes=0;const id=randomUUID();
  db.exec("CREATE TRIGGER refuse_custody_binding BEFORE UPDATE OF state ON native_session_custody WHEN NEW.state='bound' BEGIN SELECT RAISE(ABORT,'controlled binding refusal'); END");
  await assert.rejects(custody.open(async()=>({id,close:async()=>{closes++;}}),value=>value.id),error=>
    error instanceof CodexClientError&&error.code==='JOURNAL_FAILURE'&&String(error.cause).includes('controlled binding refusal'));
  assert.equal(closes,1);assert.equal(custody.faulted,true);assert.equal(rows(db)[0]!.state,'closed');assert.equal(rows(db)[0]!.connection_id,id);assert.equal(rows(db)[0]!.close_proof,'owned-transport');
});

test('legacy-version custody metadata is rejected before migration changes the journal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-legacy-custody-')),path=sqliteTransportPath(join(directory,'codex-actions.sqlite'));
  t.after(()=>rm(directory,{recursive:true,force:true}));const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA user_version=4;CREATE TABLE native_session_custody(id TEXT)');
    const before=db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    assert.throws(()=>createCodexService({directory,projectPath:resolve('.'),connect:async()=>{throw Error('Must not allocate');}}),/unexpected custody/);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,4);assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),before);
  }finally{db.close();}
});

test('custody survives SQLite reopen without changing legacy action bytes or interpreting task outcomes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-native-custody-')),path=sqliteTransportPath(join(directory,'journal.sqlite'));
  t.after(()=>rm(directory,{recursive:true,force:true}));let db=new DatabaseSync(path);
  db.exec('CREATE TABLE actions(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;CREATE TABLE chat_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT');
  const payload='{"state":"unknown","reason":"application_closed"}';db.prepare('INSERT INTO actions VALUES(?,?)').run('legacy-action',payload);db.prepare('INSERT INTO chat_tasks VALUES(?,?)').run('legacy-task',payload);
  const custody=new NativeSessionCustody(db),client=await custody.open(async()=>({id:randomUUID(),close:async()=>{}}),value=>value.id);
  custody.writesPossible(client);await custody.close(client);const before=rows(db);db.close();db=new DatabaseSync(path);
  try{new NativeSessionCustody(db);assert.deepEqual(rows(db),before);assert.equal(db.prepare('SELECT payload FROM actions').get()!.payload,payload);assert.equal(db.prepare('SELECT payload FROM chat_tasks').get()!.payload,payload);}
  finally{db.close();}
});

test('real controlled stdio closure is committed to SQLite and survives reopening',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-stdio-custody-')),path=sqliteTransportPath(join(directory,'journal.sqlite'));
  t.after(()=>rm(directory,{recursive:true,force:true}));let db=new DatabaseSync(path);const custody=new NativeSessionCustody(db);
  const client=await custody.open(async lifecycle=>{
    lifecycle.beforeProcessAllocation();
    const session=new CodexSession({command:process.execPath,args:[resolve('packages/codex-client/fixtures/protocol.mjs'),'normal',join(directory,'stdio.jsonl')],cwd:resolve('.'),env:nativeEnvironment()},limits({requestTimeoutMs:3000}),'spawned-node-fixture');
    try{await session.initialize();return session;}catch(error){await session.close();lifecycle.failedInitializationClosed();throw error;}
  },session=>session.snapshot().connectionId);
  try{
    assert.equal(client.snapshot().connected,true);assert.equal(rows(db)[0]!.state,'bound');await custody.close(client);
    assert.equal(client.snapshot().connected,false);const retained=rows(db);assert.equal(retained[0]!.close_proof,'owned-transport');
    db.close();db=new DatabaseSync(path);new NativeSessionCustody(db);assert.deepEqual(rows(db),retained);
  }finally{try{await custody.close(client);}finally{db.close();}}
});

test('native custody validates its schema and retains the original4096-entry bound without evicting evidence',async t=>{
  const bad=memory(t);bad.exec('CREATE TABLE native_session_custody(id TEXT)');assert.throws(()=>new NativeSessionCustody(bad),/schema/);
  const db=memory(t),custody=new NativeSessionCustody(db),insert=db.prepare("INSERT INTO native_session_custody VALUES(?,NULL,0,0,'closed',?,?,'factory-cleanup')"),stamp=new Date().toISOString();
  db.exec('BEGIN');for(let i=0;i<4096;i++)insert.run(randomUUID(),stamp,stamp);db.exec('COMMIT');let starts=0;
  await assert.rejects(custody.open(async()=>{starts++;return{id:randomUUID(),close:async()=>{}};},value=>value.id),/full/);
  assert.equal(starts,0);assert.equal(rows(db).length,4096);
});

async function serviceFixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'arcane-custody-service-')),connectionId=randomUUID(),threadId='controlled-thread';let closes=0,grants=0,turns=0;
  const snapshot:Snapshot={connectionId,provenance:'spawned-node-fixture',connected:true,ready:true,
    mcpIsolation:'arcane-only-verified',account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:null,thread:null,approvals:[],operations:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
  let db:DatabaseSync;
  const client:CodexHostClient={snapshot:()=>structuredClone(snapshot),selectModel:action=>({model:action.model,effort:action.effort}),startThread:async()=>snapshot.thread!,resumeThread:async()=>snapshot.thread!,
    grantThreadWrites:()=>{assert.equal(rows(db)[0]!.writes_possible,1,'Durable write evidence precedes the native grant');grants++;snapshot.thread!.writeGranted=true;return snapshot.thread!;},
    revokeThreadWrites:()=>{},startTurn:async()=>{assert.equal(rows(db)[0]!.writes_possible,1,'Durable write evidence precedes the native turn');turns++;return snapshot.thread!;},interruptTurn:async()=>{},respondApproval:()=>{},close:async()=>{closes++;snapshot.connected=false;snapshot.ready=false;}};
  const service=createCodexService({directory,projectPath:resolve('.'),connect:async()=>client});db=new DatabaseSync(sqliteTransportPath(join(directory,'codex-actions.sqlite')));
  t.after(async()=>{try{await service.close();}finally{db.close();await rm(directory,{recursive:true,force:true});}});
  const connected=await service.action({requestId:randomUUID(),action:'connect',connectionId:null});assert.equal(connected.record.state,'acknowledged');
  // Controlled attested thread; no provider, native process or Studio is used.
  snapshot.selection={model:'fixture',effort:'low'};snapshot.thread={threadId,sessionId:null,configured:true,writeGranted:false,turnStatus:'idle',turnId:null,selection:snapshot.selection};
  return{service,db,directory,connectionId,threadId,counts:()=>({closes,grants,turns})};
}

test('service journals effective write capability before grants and writable turn dispatch',async t=>{
  const f=await serviceFixture(t);
  const turn=await f.service.action({requestId:randomUUID(),action:'turn-start',connectionId:f.connectionId,threadId:f.threadId,text:'Controlled test',allowWorkspaceWrites:true});
  assert.equal(turn.record.state,'acknowledged');assert.equal(f.counts().turns,1);
  const grant=await f.service.action({requestId:randomUUID(),action:'grant-writes',connectionId:f.connectionId,threadId:f.threadId});
  assert.equal(grant.record.state,'acknowledged');assert.equal(f.counts().grants,1);
  await f.service.close();assert.equal(rows(f.db)[0]!.close_proof,'owned-transport');assert.equal(f.counts().closes,1);
});

test('write-custody persistence failure stops native escalation and fences future admission',async t=>{
  const f=await serviceFixture(t);
  f.db.exec("CREATE TRIGGER refuse_write_custody BEFORE UPDATE OF writes_possible ON native_session_custody BEGIN SELECT RAISE(ABORT,'controlled write receipt refusal'); END");
  const refused=await f.service.action({requestId:randomUUID(),action:'grant-writes',connectionId:f.connectionId,threadId:f.threadId});
  assert.equal(refused.record.state,'rejected');assert.equal(f.counts().grants,0);assert.equal(f.counts().closes,1);
  await assert.rejects(f.service.action({requestId:randomUUID(),action:'connect',connectionId:null}),/journal|custody/i);
});

test('v4 migration preserves unknown action bytes and creates no guessed closure evidence',async t=>{
  const f=await serviceFixture(t);await f.service.close();
  const saved=f.db.prepare('SELECT id,payload FROM actions').get()!,payload=JSON.parse(String(saved.payload));
  payload.state='unknown';payload.errorCode='FRAME_LIMIT';payload.connectionId=null;
  f.db.prepare('UPDATE actions SET payload=? WHERE id=?').run(JSON.stringify(payload),String(saved.id));
  f.db.exec('DROP TABLE native_session_custody;PRAGMA user_version=4;');
  const original=f.db.prepare('SELECT id,hash,payload FROM actions').all();let starts=0;
  // Exact existing project/database, without touching a customer profile.
  const migrated=createCodexService({directory:f.directory,projectPath:resolve('.'),connect:async()=>{starts++;throw Error('No allocation during migration');}});
  try{assert.deepEqual(f.db.prepare('SELECT id,hash,payload FROM actions').all(),original);assert.deepEqual(rows(f.db),[]);assert.equal(starts,0);assert.equal(migrated.state().actions[0]!.state,'unknown');}
  finally{await migrated.close();}
});
