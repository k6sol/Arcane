import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StudioStore, STUDIO_TEST_RESERVATION_LIMITS, type StudioTestReservation, type StudioTestTemporaryEdit } from '../../packages/storage/src/studio-store.js';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';
import { READ_METHODS, WRITE_METHODS, type StudioCommand } from '../../packages/protocol/src/studio.js';

function fixture(t:test.TestContext,capabilities:string[]=[...READ_METHODS,...WRITE_METHODS],allowWrites=true){
  const directory=mkdtempSync(join(tmpdir(),'arcane-test-reservation-'));let now=Date.now(),retain=false;
  let store=new StudioStore({directory,now:()=>now});
  t.after(()=>{store.close();if(retain){t.diagnostic('Retained owned fixture after uncertain child termination: '+directory);return;}const inside=relative(tmpdir(),directory);assert.ok(inside&&!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..\\')&&!inside.startsWith('../'));rmSync(directory,{recursive:true,force:true});});
  const pair=(clientSessionId='reservation-client')=>{const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites});return store.pair({code:grant.code,protocolVersion:1,
    identity:{clientSessionId,placeId:12,universeId:34,name:'Fixture',pluginVersion:'0.1.7'},capabilities});};
  const paired=pair();
  const edit:StudioTestTemporaryEdit={id:'temporary-color',ref:{sessionId:paired.sessionId,instanceId:'private-part',root:'Workspace',className:'Part',pathSegments:['Part']},
    expected:{Transparency:0},properties:{Transparency:0.5}};
  const observe=(mode:'Edit'|'Play'='Edit',playEpoch=0,sessionId=paired.sessionId)=>store.poll(sessionId,{sessionId,clientLifetimeId:'reservation-client',pluginArtifactHash:'a'.repeat(64),
    markerName:'ArcaneTestProof_reservation',placeId:12,universeId:34,placeName:'Fixture',mode,playEpoch,continuitySupported:true,connected:true});
  const ackSetup=(command:StudioCommand)=>store.result({sessionId:command.sessionId,commandId:command.id,state:'succeeded',result:{ref:command.args.ref,
    mutation:{kind:'scene.update',ref:command.args.ref,before:{properties:command.args.expected},after:{properties:command.args.properties}}}});
  const ackRestore=(command:StudioCommand)=>store.result({sessionId:command.sessionId,commandId:command.id,state:'succeeded',result:{restored:true,ref:edit.ref}});
  return {directory,get store(){return store;},paired,pair,edit,observe,ackSetup,ackRestore,advance:(ms:number)=>{now+=ms;},
    retain:()=>{retain=true;},reopen:()=>{store.close();store=new StudioStore({directory,now:()=>now});return store;}};
}
const forged=():StudioTestReservation=>({kind:'studio-test-reservation'});

test('private reservation seals finite setup, derives exact inverse, and releases only after matching restoration',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'owned-job',[f.edit]);
  f.edit.properties.Transparency=0.9;f.edit.ref.pathSegments.push('caller-mutation');
  assert.throws(()=>f.store.enqueueTestSetup(forged(),'temporary-color'),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueueTestSetup(JSON.parse(JSON.stringify(owner)) as StudioTestReservation,'temporary-color'),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueueTestSetup(owner,'unapproved'),{code:'TEST_SETUP'});
  const command=f.store.enqueueTestSetup(owner,'temporary-color');assert.equal(command.method,'scene.update');assert.equal(command.args.properties&&typeof command.args.properties==='object'&&!Array.isArray(command.args.properties)?command.args.properties.Transparency:null,0.5);
  assert.deepEqual((command.args.ref as unknown as {pathSegments:string[]}).pathSegments,['Part']);
  assert.equal(f.store.enqueueTestSetup(owner,'temporary-color').id,command.id);
  const db=new DatabaseSync(sqliteTransportPath(join(f.directory,'studio.sqlite')));
  try{assert.equal(db.prepare("SELECT count(*) AS n FROM studio_test_reservations WHERE state='active'").get()?.n,1);assert.equal(db.prepare('SELECT command_id FROM studio_test_commands').get()?.command_id,command.id);assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,6);}finally{db.close();}
  assert.throws(()=>f.store.enqueue({sessionId:command.sessionId,requestId:command.requestId,method:command.method,args:command.args}),{code:'BUSY'});
  assert.throws(()=>f.store.releaseTest(command.sessionId,'owned-job'),{code:'TEST_RESERVATION'});
  assert.equal(f.observe()[0]?.id,command.id);f.ackSetup(command);
  assert.throws(()=>f.store.releaseTestReservation(owner),{code:'RECONCILIATION'});
  assert.throws(()=>f.store.restore({commandId:command.id,requestId:'generic-restore-01'}),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueueTestRestore(forged(),command.id),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueueTestRestore(owner,'another-command'),{code:'RESTORE'});
  f.observe('Play',1);assert.throws(()=>f.store.enqueueTestRestore(owner,command.id),{code:'SCOPE'});
  f.observe('Edit',2);
  const restore=f.store.enqueueTestRestore(owner,command.id);assert.equal(restore.method,'scene.restore');assert.equal(restore.args.receiptCommandId,command.id);
  assert.deepEqual((restore.args.mutation as unknown as {before:unknown}).before,{properties:{Transparency:0}});
  assert.deepEqual((restore.args.mutation as unknown as {after:unknown}).after,{properties:{Transparency:0.5}});
  assert.equal(f.store.enqueueTestRestore(owner,command.id).id,restore.id);
  assert.equal(f.observe('Edit',2)[0]?.id,restore.id);
  assert.throws(()=>f.store.result({sessionId:restore.sessionId,commandId:restore.id,state:'succeeded',result:{restored:true}}),/restoration/);
  assert.throws(()=>f.store.result({sessionId:restore.sessionId,commandId:restore.id,state:'succeeded',result:{restored:true,ref:{...f.edit.ref,instanceId:'other-part'}}}),/restoration/);
  f.ackRestore(restore);f.store.releaseTestReservation(owner);
  assert.throws(()=>f.store.releaseTestReservation(owner),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.restore({commandId:command.id,requestId:'generic-restore-02'}),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueue({sessionId:command.sessionId,requestId:command.requestId,method:command.method,args:command.args}),{code:'BUSY'});
  assert.equal(f.store.enqueue({sessionId:command.sessionId,requestId:'after-restoration',method:'selection.read',args:{}}).state,'queued');
});

test('release cancels only undelivered setup and legacy smoke ownership cannot release a newer incarnation',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'queued-job',[f.edit]);
  const queued=f.store.enqueueTestSetup(owner,f.edit.id);f.store.releaseTestReservation(owner);assert.equal(f.store.command(queued.id).state,'cancelled');
  assert.deepEqual(f.observe(),[]);
  const old=f.store.reserveTest(f.paired.sessionId,'smoke-job');f.store.releaseTest(f.paired.sessionId,'smoke-job');
  const current=f.store.reserveTest(f.paired.sessionId,'smoke-job');assert.throws(()=>f.store.releaseTestReservation(old),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.enqueue({sessionId:f.paired.sessionId,requestId:'still-owned-smoke',method:'selection.read',args:{}}),{code:'BUSY'});
  f.store.releaseTestReservation(current);
  assert.equal(f.store.enqueue({sessionId:f.paired.sessionId,requestId:'after-owned-smoke',method:'selection.read',args:{}}).state,'queued');
});

test('setup issuance retains existing property, scope, capability and current proof policy',t=>{
  const f=fixture(t);assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'missing-proof',[f.edit]),{code:'SCOPE'});
  f.observe();
  for(const edits of [Array.from({length:5},(_,i)=>({...f.edit,id:'edit-'+i})),[f.edit,f.edit]])assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'bad-count',edits));
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'bad-property',[{...f.edit,properties:{Source:'print(1)'},expected:{Source:''}}]),{code:'PROPERTY'});
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'bad-baseline',[{...f.edit,expected:{Name:'Part'}}]),{code:'BASELINE'});
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'wrong-session',[{...f.edit,ref:{...f.edit.ref,sessionId:'foreign'}}]),{code:'SCOPE'});
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'wrong-root',[{...f.edit,ref:{...f.edit.ref,root:'Lighting'}}]),{code:'SCOPE'});
  let invoked=0;const accessor={...f.edit};Object.defineProperty(accessor,'properties',{enumerable:true,get(){invoked++;return f.edit.properties;}});
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'accessor',[accessor]));assert.equal(invoked,0);
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'proxy',[new Proxy(f.edit,{get(){invoked++;throw new Error('must not read');}})]));assert.equal(invoked,0);
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'over-budget',[{...f.edit,properties:{Name:'x'.repeat(STUDIO_TEST_RESERVATION_LIMITS.argumentBytes+1)}}]),{code:'TEST_BUDGET'});
  f.advance(6001);assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'expired-proof',[f.edit]),{code:'SCOPE'});
  f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'valid-after-rejections',[f.edit]);f.store.releaseTestReservation(owner);
  const readOnly=fixture(t,undefined,false);assert.throws(()=>readOnly.store.reserveTest(readOnly.paired.sessionId,'read-only',[readOnly.edit]),{code:'READ_ONLY'});
  const noRestore=fixture(t,['scene.update']);noRestore.observe();assert.throws(()=>noRestore.store.reserveTest(noRestore.paired.sessionId,'no-restore',[noRestore.edit]),{code:'CAPABILITY'});
});

test('stale queued setup never dispatches, partial or failed delivered work retains the global fence across re-pair',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'partial-job',[f.edit]);f.advance(6001);
  assert.throws(()=>f.store.enqueueTestSetup(owner,f.edit.id),{code:'SCOPE'});f.observe();
  const command=f.store.enqueueTestSetup(owner,f.edit.id);f.advance(6001);assert.deepEqual(f.store.poll(f.paired.sessionId),[]);assert.equal(f.store.command(command.id).state,'queued');
  assert.equal(f.observe()[0]?.id,command.id);
  f.store.result({sessionId:command.sessionId,commandId:command.id,state:'failed',error:'Owned rollback cannot be proven',result:{partial:true}});
  assert.equal(f.store.command(command.id).state,'needs_reconciliation');
  assert.throws(()=>f.store.releaseTestReservation(owner),{code:'RECONCILIATION'});assert.throws(()=>f.store.enqueueTestRestore(owner,command.id),{code:'RESTORE'});
  f.store.revoke(f.paired.sessionId);const replacement=f.pair();f.observe('Edit',0,replacement.sessionId);
  assert.throws(()=>f.store.enqueue({sessionId:replacement.sessionId,requestId:'repaired-new-work',method:'selection.read',args:{}}),{code:'BUSY'});
  assert.throws(()=>f.store.reserveTest(replacement.sessionId,'repaired-job'),{code:'BUSY'});
  assert.throws(()=>f.store.enqueueTestSetup(owner,f.edit.id),{code:'REVOKED'});
});

test('delivered setup cannot be released by failed restoration or a receipt from another reservation',t=>{
  const f=fixture(t);f.observe();const first=f.store.reserveTest(f.paired.sessionId,'first-job',[f.edit]);f.store.releaseTestReservation(first);
  const owner=f.store.reserveTest(f.paired.sessionId,'second-job',[f.edit]);const command=f.store.enqueueTestSetup(owner,f.edit.id);f.observe();f.ackSetup(command);
  assert.throws(()=>f.store.enqueueTestRestore(first,command.id),{code:'TEST_RESERVATION'});
  const restore=f.store.enqueueTestRestore(owner,command.id);f.observe();f.store.result({sessionId:restore.sessionId,commandId:restore.id,state:'failed',error:'Current after-state changed',result:{partial:false}});
  assert.equal(f.store.enqueueTestRestore(owner,command.id).id,restore.id);assert.throws(()=>f.store.releaseTestReservation(owner),{code:'RECONCILIATION'});
});

test('withheld dispatch commits a newly observed Play epoch and never revives the earlier Edit proof',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'transition-job',[f.edit]);const command=f.store.enqueueTestSetup(owner,f.edit.id);
  assert.deepEqual(f.observe('Play',1),[]);assert.equal(f.store.session(f.paired.sessionId).proof?.mode,'Play');
  assert.deepEqual(f.store.poll(f.paired.sessionId),[]);assert.equal(f.store.command(command.id).state,'queued');
  assert.deepEqual(f.observe('Edit',2),[]);assert.equal(f.store.session(f.paired.sessionId).proof?.playEpoch,2);
  assert.throws(()=>f.store.enqueueTestSetup(owner,f.edit.id),{code:'SCOPE'});f.store.releaseTestReservation(owner);assert.equal(f.store.command(command.id).state,'cancelled');
});

test('private setup stop cancels queued work and denies late dispatch while preserving exact succeeded restoration',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'stop-job',[f.edit,{...f.edit,id:'not-yet-queued'}]);
  const command=f.store.enqueueTestSetup(owner,f.edit.id);f.observe();
  const queued=f.store.enqueueTestSetup(owner,'not-yet-queued');f.advance(6001);
  assert.throws(()=>f.store.cancelTestSetup(forged()),{code:'TEST_RESERVATION'});f.store.cancelTestSetup(owner);f.store.cancelTestSetup(owner);
  const db=new DatabaseSync(sqliteTransportPath(join(f.directory,'studio.sqlite')));
  try{assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind='test_setup_stopped'").get()?.n,1);}finally{db.close();}
  assert.equal(f.store.command(command.id).state,'dispatched');assert.equal(f.store.command(queued.id).state,'cancelled');
  assert.throws(()=>f.store.enqueueTestSetup(owner,f.edit.id),{code:'TEST_RESERVATION'});assert.throws(()=>f.store.enqueueTestSetup(owner,'not-yet-queued'),{code:'TEST_RESERVATION'});
  assert.throws(()=>f.store.releaseTestReservation(owner),{code:'RECONCILIATION'});
  f.ackSetup(command);f.observe();const restore=f.store.enqueueTestRestore(owner,command.id);assert.equal(f.observe()[0]?.id,restore.id);f.ackRestore(restore);f.store.releaseTestReservation(owner);
  assert.deepEqual(f.observe(),[]);
});

test('temporary setup cannot overlap a smoke reservation in another paired session',t=>{
  const f=fixture(t);f.observe();const other=f.pair('another-reservation-client'),smoke=f.store.reserveTest(other.sessionId,'other-smoke');
  assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'overlap',[f.edit]),{code:'BUSY'});f.store.releaseTestReservation(smoke);
  const owner=f.store.reserveTest(f.paired.sessionId,'after-smoke',[f.edit]);f.store.cancelTestSetup(owner);f.store.releaseTestReservation(owner);
});

test('retained reservation capacity rejects before allocation without evicting or changing existing history',t=>{
  const f=fixture(t);f.observe();
  for(let i=0;i<STUDIO_TEST_RESERVATION_LIMITS.reservations;i++){const owner=f.store.reserveTest(f.paired.sessionId,'retained-'+i,[f.edit]);f.store.releaseTestReservation(owner);}
  const db=new DatabaseSync(sqliteTransportPath(join(f.directory,'studio.sqlite')));
  try{
    const before=db.prepare('SELECT * FROM studio_test_reservations ORDER BY id').all(),events=db.prepare('SELECT count(*) AS n FROM events').get()?.n;
    assert.equal(before.length,STUDIO_TEST_RESERVATION_LIMITS.reservations);
    assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'over-capacity',[f.edit]),{code:'TEST_BUDGET'});
    assert.deepEqual(db.prepare('SELECT * FROM studio_test_reservations ORDER BY id').all(),before);assert.equal(db.prepare('SELECT count(*) AS n FROM studio_test_commands').get()?.n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()?.n,events);
  }finally{db.close();}
  const smoke=f.store.reserveTest(f.paired.sessionId,'existing-smoke-compatible');f.store.releaseTestReservation(smoke);
});

test('synthetic retained command capacity is checked before creating a new reservation or command',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'capacity-fixture',[f.edit]);
  const command=f.store.enqueueTestSetup(owner,f.edit.id);f.store.cancelTestSetup(owner);f.store.releaseTestReservation(owner);
  const db=new DatabaseSync(sqliteTransportPath(join(f.directory,'studio.sqlite')));
  try{
    // This fixture represents retained history at its bound. It never grants
    // private authority or claims that any synthetic engine effect occurred.
    const association=db.prepare('SELECT * FROM studio_test_commands').get()!;
    db.exec('BEGIN IMMEDIATE');
    try{
      for(let i=1;i<STUDIO_TEST_RESERVATION_LIMITS.commands;i++){
        const id='retained-command-'+i,requestId='retained-request-'+i,payload={...command,id,requestId,state:'cancelled'};
        db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?)').run(id,requestId,command.sessionId,'synthetic-retained-fingerprint','cancelled',JSON.stringify(payload),i);
        db.prepare('INSERT INTO studio_test_commands VALUES(?,?,?,?,?,?,?)').run(association.reservation_id!, 'retained-edit-'+i,'setup',id,requestId,i,'synthetic-retained-fingerprint');
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const before=db.prepare('SELECT * FROM studio_test_commands ORDER BY command_id').all(),reservations=db.prepare('SELECT * FROM studio_test_reservations ORDER BY id').all();
    assert.equal(before.length,STUDIO_TEST_RESERVATION_LIMITS.commands);
    assert.throws(()=>f.store.reserveTest(f.paired.sessionId,'command-capacity',[f.edit]),{code:'TEST_BUDGET'});
    assert.deepEqual(db.prepare('SELECT * FROM studio_test_commands ORDER BY command_id').all(),before);assert.deepEqual(db.prepare('SELECT * FROM studio_test_reservations ORDER BY id').all(),reservations);
  }finally{db.close();}
});

test('restart and an actual new process cannot recover private authority or replay an uncertain setup',t=>{
  const f=fixture(t);f.observe();const owner=f.store.reserveTest(f.paired.sessionId,'restart-job',[f.edit]);const command=f.store.enqueueTestSetup(owner,f.edit.id);f.observe();f.store.close();
  const moduleUrl=new URL('../../packages/storage/src/studio-store.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {StudioStore} from ${JSON.stringify(moduleUrl)};
    const store=new StudioStore({directory:process.argv[1]});
    const code=fn=>{try{fn();return 'UNEXPECTED_SUCCESS';}catch(e){return e.code;}};
    try{
      const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
      const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'new-process-lifetime',placeId:12,universeId:34,name:'Fixture',pluginVersion:'0.1.7'},capabilities:['selection.read','scene.update','scene.restore']});
      console.log(JSON.stringify({state:store.command(process.argv[2]).state,
        forged:code(()=>store.enqueueTestRestore({kind:'studio-test-reservation'},process.argv[2])),
        legacyRelease:code(()=>store.releaseTest(process.argv[3],'restart-job')),
        queue:code(()=>store.enqueue({sessionId:pair.sessionId,requestId:'new-process-work',method:'selection.read',args:{}})),
        reserve:code(()=>store.reserveTest(pair.sessionId,'restart-job')),
        oldPoll:code(()=>store.poll(process.argv[3]))}));
    }finally{store.close();}
  `,f.directory,command.id,f.paired.sessionId],{encoding:'utf8',windowsHide:true,timeout:10_000,maxBuffer:64*1024});
  if(child.status===null&&child.signal===null)f.retain();
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{state:'needs_reconciliation',forged:'TEST_RESERVATION',legacyRelease:'TEST_RESERVATION',queue:'BUSY',reserve:'BUSY',oldPoll:'REVOKED'});
  f.reopen();assert.throws(()=>f.store.enqueueTestRestore(owner,command.id),{code:'TEST_RESERVATION'});assert.equal(f.store.command(command.id).state,'needs_reconciliation');
});

test('v5 migration adds private journals without changing receipts and future versions remain untouched',t=>{
  const f=fixture(t);const command=f.store.enqueue({sessionId:f.paired.sessionId,requestId:'migration-read-01',method:'selection.read',args:{}});f.store.poll(f.paired.sessionId);f.store.result({sessionId:f.paired.sessionId,commandId:command.id,state:'succeeded',result:{items:[]}});
  const before=f.store.command(command.id);f.store.close();const filename=sqliteTransportPath(join(f.directory,'studio.sqlite'));
  let db=new DatabaseSync(filename);try{db.exec('DROP TABLE studio_test_commands; DROP TABLE studio_test_reservations; PRAGMA user_version=5;');}finally{db.close();}
  f.reopen();assert.deepEqual(f.store.command(command.id),before);f.store.close();
  db=new DatabaseSync(filename);try{assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,6);assert.equal(db.prepare('SELECT count(*) AS n FROM studio_test_reservations').get()?.n,0);db.exec('PRAGMA user_version=7;');}finally{db.close();}
  assert.throws(()=>new StudioStore({directory:f.directory}),{code:'MIGRATION'});
  db=new DatabaseSync(filename);try{assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,7);assert.equal(db.prepare('SELECT payload FROM commands WHERE id=?').get(command.id)?.payload,JSON.stringify(before));}finally{db.close();}
});
