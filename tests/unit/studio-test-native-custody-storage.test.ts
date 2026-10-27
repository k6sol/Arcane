import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore,type StudioNativeCustodyTicket} from '../../packages/storage/src/studio-store.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';

// Real temporary SQLite/filesystem custody fixtures. Calling this host storage
// port records synthetic facts; it does not attest an SDK/native process close.
const refused={code:'SDK_CUSTODY_UNCONFIRMED'};
function fixture(t:test.TestContext){
  const temporary=realpathSync(tmpdir()),root=mkdtempSync(join(temporary,'arcane-native-custody-'));
  const directory=join(root,'state'),project=join(root,'project');mkdirSync(project);let now=1793000000000;
  const projectId=workflowProjectIdentity(project).projectId;let store=new StudioStore({directory,now:()=>now});
  t.after(()=>{try{store.close();}finally{const path=relative(temporary,root);assert.ok(path&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('../')&&!path.startsWith('..\\'));rmSync(root,{recursive:true,force:true});}});
  const inspect=<T>(work:(db:DatabaseSync)=>T,readOnly=true):T=>{const db=new DatabaseSync(sqliteTransportPath(join(directory,'studio.sqlite')),{readOnly});try{return work(db);}finally{db.close();}};
  const rows=()=>inspect(db=>db.prepare('SELECT * FROM studio_native_custody ORDER BY slot').all());
  const bind=()=>store.bindNativeCustody(projectId,directory);
  return {root,directory,projectId,bind,rows,inspect,advance:(ms:number)=>{now+=ms;},get store(){return store;},
    reopen(){store.close();store=new StudioStore({directory,now:()=>now});return bind();}};
}

for(const operation of ['playtest-prepare','viewport','playtest-revalidate','asset-search','asset-insert','asset-job'] as const)
  for(const evidence of ['native','fixture'] as const)test(operation+' stores closed '+evidence+' custody without self-fencing its live owner',t=>{
    const f=fixture(t),port=f.bind(),ticket=port.reserve(operation,evidence);
    assert.equal(Object.isFrozen(port),true);assert.equal(Object.isFrozen(ticket),true);port.assertReady();
    const row=f.rows()[0];assert.ok(row&&typeof row.payload==='string');
    const record:unknown=JSON.parse(row.payload);assert.deepEqual(record,{schemaVersion:1,slot:1,custodyId:row.custody_id,projectId:f.projectId,ownerEpoch:port.ownerEpoch,
      operation,evidence,state:'pending',createdAt:new Date(1793000000000).toISOString(),settledAt:null,settlement:null,reason:null});
    if(evidence==='native')port.settleNativeClosed(ticket);else port.settleFixtureClosed(ticket);
    port.assertReady();assert.equal(f.rows()[0]?.state,'settled');
  });

test('serialized, foreign-port and cross-evidence tickets cannot settle another original owner',t=>{
  const f=fixture(t),port=f.bind(),native=port.reserve('viewport','native'),foreign=f.bind();
  const copied=structuredClone(native),forged:StudioNativeCustodyTicket={kind:'studio-native-custody-ticket'};
  const before=f.rows();
  for(const ticket of [copied,forged])assert.throws(()=>port.settleNativeClosed(ticket),refused);
  assert.throws(()=>foreign.settleNativeClosed(native),refused);assert.throws(()=>port.settleFixtureClosed(native),refused);
  assert.throws(()=>foreign.assertReady(),refused);assert.deepEqual(f.rows(),before);
  port.settleNativeClosed(native);foreign.assertReady();
  const fixtureTicket=foreign.reserve('asset-job','fixture');assert.throws(()=>foreign.settleNativeClosed(fixtureTicket),refused);
  foreign.settleFixtureClosed(fixtureTicket);
});

test('retirement and quarantine fence admissions but allow the original late closure without rearming',t=>{
  const f=fixture(t),port=f.bind(),ticket=port.reserve('playtest-prepare','native');
  port.quarantine(ticket,'close-unconfirmed');const quarantined=f.rows();
  assert.equal(quarantined[0]?.state,'quarantined');assert.throws(()=>port.assertReady(),refused);
  assert.throws(()=>port.reserve('viewport','native'),refused);port.retireAdmissions();
  port.settleNativeClosed(ticket);assert.equal(f.rows()[0]?.state,'settled');
  assert.throws(()=>port.assertReady(),refused);const next=f.bind();next.assertReady();
  const noStart=next.reserve('asset-search','native');next.retireAdmissions();next.settleNoStart(noStart);
  const row=f.rows().at(-1);assert.ok(row&&typeof row.payload==='string');assert.equal(JSON.parse(row.payload).settlement,'no-start');
});

test('a later close failure fences the original port without rewriting an already truthful native settlement',t=>{
  const f=fixture(t),port=f.bind(),ticket=port.reserve('viewport','native');port.settleNativeClosed(ticket);const settled=f.rows();
  port.quarantine(ticket,'close-unconfirmed');assert.deepEqual(f.rows(),settled);assert.throws(()=>port.assertReady(),refused);
  f.bind().assertReady();
});

test('retained pending work blocks another epoch and project, and cannot be adopted after reopen',t=>{
  const f=fixture(t),original=f.bind(),ticket=original.reserve('asset-insert','native');
  mkdirSync(join(f.root,'other-project'));const otherProject=workflowProjectIdentity(join(f.root,'other-project')).projectId;
  assert.throws(()=>f.store.bindNativeCustody(otherProject,f.directory).assertReady(),refused);
  const before=f.rows(),reopened=f.reopen();assert.throws(()=>reopened.assertReady(),refused);
  assert.throws(()=>reopened.settleNativeClosed(ticket),refused);assert.throws(()=>original.settleNativeClosed(ticket),refused);
  assert.deepEqual(f.rows(),before);
});

test('64 unresolved slots refuse allocation; only settled slots are reused, by actual settlement time',t=>{
  const f=fixture(t),port=f.bind(),tickets=Array.from({length:64},()=>port.reserve('asset-job','fixture'));
  const full=f.rows();assert.equal(full.length,64);assert.throws(()=>port.reserve('asset-search','fixture'),refused);assert.deepEqual(f.rows(),full);
  port.settleFixtureClosed(tickets[20]!);f.advance(1);port.settleFixtureClosed(tickets[3]!);
  const replacement=port.reserve('viewport','fixture'),after=f.rows();assert.equal(after.length,64);
  assert.notEqual(after[20]?.custody_id,full[20]?.custody_id);assert.equal(after[3]?.custody_id,full[3]?.custody_id);
  const beforeReplay=f.rows();assert.throws(()=>port.settleFixtureClosed(tickets[20]!),refused);assert.deepEqual(f.rows(),beforeReplay);
  port.assertReady();port.settleFixtureClosed(replacement);
  for(const [i,ticket]of tickets.entries())if(i!==20&&i!==3)port.settleFixtureClosed(ticket);
});

test('many genuinely settled operations retain at most64 records, with deterministic timestamp/UUID tie order',t=>{
  const f=fixture(t),port=f.bind();for(let i=0;i<64;i++)port.settleNoStart(port.reserve('asset-search','native'));
  const before=f.rows(),oldest=before.map(row=>String(row.custody_id)).sort((a,b)=>a.localeCompare(b))[0];
  port.settleNoStart(port.reserve('asset-search','native'));assert.equal(f.rows().some(row=>row.custody_id===oldest),false);
  for(let i=0;i<70;i++)port.settleNoStart(port.reserve('asset-search','native'));
  assert.equal(f.rows().length,64);f.reopen().assertReady();
});

for(const fault of ['unknown-field','duplicate-key','column-mismatch','oversize','invalid-settlement'] as const)
  test('malformed retained '+fault+' refuses before recovery and preserves original rows/schema/version',t=>{
    const f=fixture(t),port=f.bind();port.reserve('viewport','native');f.store.close();
    const snapshot=(db:DatabaseSync)=>({version:db.prepare('PRAGMA user_version').get(),identity:db.prepare('PRAGMA application_id').get(),
      schema:db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(),rows:db.prepare('SELECT * FROM studio_native_custody').all(),events:db.prepare('SELECT * FROM events').all()});
    let before:ReturnType<typeof snapshot>|null=null;
    f.inspect(db=>{const row=db.prepare('SELECT * FROM studio_native_custody').get();assert.ok(row&&typeof row.payload==='string');
      let payload=row.payload;
      if(fault==='unknown-field')payload=payload.replace(/}$/,',"callerAuthority":true}');
      if(fault==='duplicate-key')payload=payload.replace('{','{"state":"settled",');
      if(fault==='column-mismatch')db.prepare('UPDATE studio_native_custody SET project_id=?').run('f'.repeat(64));
      if(fault==='oversize'){db.exec('PRAGMA ignore_check_constraints=ON');payload=JSON.stringify({padding:'x'.repeat(2049)});}
      if(fault==='invalid-settlement')payload=payload.replace('"settlement":null','"settlement":"fixture-close"');
      db.prepare('UPDATE studio_native_custody SET payload=?').run(payload);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');before=snapshot(db);
    },false);
    const bytes=readFileSync(join(f.directory,'studio.sqlite'));
    assert.throws(()=>new StudioStore({directory:f.directory}),{code:'MIGRATION'});
    assert.ok(before);assert.deepEqual(f.inspect(snapshot),before);assert.deepEqual(readFileSync(join(f.directory,'studio.sqlite')),bytes);
  });

test('a foreign or no-longer-original workspace cannot bind, and lock replacement causes a sticky fence',t=>{
  const f=fixture(t);assert.throws(()=>f.store.bindNativeCustody(f.projectId,f.root),refused);
  const port=f.bind(),lock=join(f.directory,'studio.lock'),retained=join(f.directory,'original-lock');renameSync(lock,retained);writeFileSync(lock,readFileSync(retained));
  const replacement=readFileSync(lock);assert.throws(()=>port.reserve('viewport','native'),refused);assert.equal(f.rows().length,0);
  unlinkSync(lock);renameSync(retained,lock);assert.throws(()=>port.assertReady(),refused);
  // A foreign replacement lock is never unlinked by this store's close path.
  renameSync(lock,retained);writeFileSync(lock,replacement);f.store.close();assert.equal(existsSync(lock),true);
});

test('database hardlink and redirected workspace ancestry refuse custody without deleting the replacement',t=>{
  const f=fixture(t),port=f.bind(),database=join(f.directory,'studio.sqlite'),link=join(f.root,'database-hardlink');
  linkSync(database,link);assert.throws(()=>port.reserve('viewport','native'),refused);unlinkSync(link);assert.throws(()=>port.assertReady(),refused);
  const destination=join(f.root,'ordinary-destination'),redirect=join(f.root,'redirected-state');mkdirSync(destination);
  symlinkSync(destination,redirect,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>new StudioStore({directory:redirect}),refused);assert.equal(existsSync(join(destination,'studio.lock')),false);
});

for(const replacement of ['database','directory'] as const)test('original physical '+replacement+' replacement refuses custody before SQL access',t=>{
  const f=fixture(t),port=f.bind(),prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close;
  const owned:{database:DatabaseSync|null}={database:null};
  const capture=t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){owned.database=this;return prepare.call(this,sql);});
  try{port.assertReady();}finally{capture.mock.restore();}
  assert.ok(owned.database);owned.database.close();
  // Retire the actual SQLite connection first, so Windows' SQLite file sharing
  // does not prevent this injected filesystem replacement. Original store file
  // and lock descriptors remain open and must reject the replacement identity.
  if(replacement==='database'){
    const file=join(f.directory,'studio.sqlite');renameSync(file,join(f.root,'retained-database'));writeFileSync(file,Buffer.alloc(0));
  }else{
    const bytes=readFileSync(join(f.directory,'studio.lock'));renameSync(f.directory,join(f.root,'retained-state'));mkdirSync(f.directory);
    writeFileSync(join(f.directory,'studio.lock'),bytes);writeFileSync(join(f.directory,'studio.sqlite'),Buffer.alloc(0));
  }
  const failure=Error('Synthetic already-closed original database.');
  const fault=t.mock.method(DatabaseSync.prototype,'close',function(this:DatabaseSync){if(this===owned.database)throw failure;return close.call(this);});
  try{assert.throws(()=>port.reserve('viewport','native'),refused);assert.throws(()=>f.store.close(),error=>error===failure);}
  finally{fault.mock.restore();}
  if(replacement==='directory')assert.equal(existsSync(join(f.directory,'studio.lock')),true);
});

test('write/commit uncertainty leaves no positive settlement and fences later ports',t=>{
  const f=fixture(t),port=f.bind(),ticket=port.reserve('viewport','native'),before=f.rows();
  const original=DatabaseSync.prototype.exec;
  const fault=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){if(sql==='COMMIT')throw Error('Synthetic custody commit failure.');return original.call(this,sql);});
  try{assert.throws(()=>port.settleNativeClosed(ticket),refused);}finally{fault.mock.restore();}
  assert.deepEqual(f.rows(),before);assert.throws(()=>port.assertReady(),refused);assert.throws(()=>f.bind().assertReady(),refused);
  assert.throws(()=>f.reopen().assertReady(),refused);
});

test('a successful reserve followed by physical-ownership loss retains the committed pending row',t=>{
  const f=fixture(t),port=f.bind(),lock=join(f.directory,'studio.lock'),originalBytes=readFileSync(lock),original=DatabaseSync.prototype.exec;
  const fault=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){const value=original.call(this,sql);if(sql==='COMMIT')writeFileSync(lock,'changed after commit');return value;});
  try{assert.throws(()=>port.reserve('asset-insert','native'),refused);}finally{fault.mock.restore();writeFileSync(lock,originalBytes);}
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0]?.state,'pending');assert.throws(()=>port.assertReady(),refused);
});

test('close attempts all original cleanup after a database-close failure, preserving the first error',t=>{
  const f=fixture(t),port=f.bind();port.reserve('viewport','native');const failure=Error('Synthetic database close failure.'),original=DatabaseSync.prototype.close;let calls=0;
  const fault=t.mock.method(DatabaseSync.prototype,'close',function(this:DatabaseSync){calls++;original.call(this);throw failure;});
  try{assert.throws(()=>f.store.close(),error=>error===failure);}finally{fault.mock.restore();}
  assert.equal(calls,1);assert.equal(existsSync(join(f.directory,'studio.lock')),false);assert.throws(()=>port.assertReady(),refused);
  // Actual reopen succeeds structurally but the genuine unresolved row remains.
  assert.throws(()=>f.reopen().assertReady(),refused);
});
