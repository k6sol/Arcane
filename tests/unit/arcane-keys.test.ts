import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {READ_METHODS,WRITE_METHODS,ROOTS,jsonObject} from '../../packages/protocol/src/studio.js';
import {engineProperties} from '../../packages/core/src/studio-policy.js';
function setup(t:test.TestContext){
 const directory=mkdtempSync(join(tmpdir(),'arcane-key-test-'));const store=new StudioStore({directory});
 t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'\\')||resolve(directory).startsWith(resolve(tmpdir())+'/'));rmSync(directory,{recursive:true,force:true});});
 const connect={protocolVersion:1,identity:{clientSessionId:'key-window-A',placeId:0,universeId:0,name:'Disposable fixture',pluginVersion:'test'},capabilities:[...READ_METHODS,...WRITE_METHODS]};return{directory,store,connect};
}
test('Arcane key grants survive daemon restart; no plaintext key is persisted or returned in listings',t=>{
 const f=setup(t);const key=f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871);
 assert.match(key.apiKey,/^arcane_local_v1_45871_[a-f0-9]{64}$/);assert.equal(JSON.stringify(f.store.keys()).includes(key.apiKey),false);
 const pair=f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871);assert.equal(f.store.authenticate(pair.sessionId,pair.token).allowWrites,false);
 const content=Buffer.concat(readdirSync(f.directory).filter(n=>n.startsWith('studio.sqlite')).map(n=>readFileSync(join(f.directory,n))));assert.equal(content.includes(key.apiKey),false);assert.equal(content.includes(pair.token),false);
 f.store.close();const reopened=new StudioStore({directory:f.directory});t.after(()=>reopened.close());
 assert.throws(()=>reopened.authenticate(pair.sessionId,pair.token),/revoked/);const next=reopened.connectWithKey({...f.connect,apiKey:key.apiKey},45871);assert.notEqual(next.sessionId,pair.sessionId);assert.equal(reopened.keys()[0]?.keyId,key.keyId);reopened.close();
});
test('revoking an Arcane key revokes exact attached sessions; wrong endpoint and foreign keys are rejected',t=>{
 const f=setup(t);const key=f.store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871);
 assert.throws(()=>f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45872),/another local endpoint/);
 assert.throws(()=>f.store.connectWithKey({...f.connect,apiKey:'ropilot_not_an_arcane_key'},45871),/invalid/);
 const pair=f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871);
 const c=f.store.enqueue({sessionId:pair.sessionId,requestId:'key-revoke-command',method:'scene.children',args:{root:'Workspace'}});f.store.poll(pair.sessionId);
 f.store.revokeKey(key.keyId);assert.equal(f.store.command(c.id).state,'needs_reconciliation');assert.throws(()=>f.store.authenticate(pair.sessionId,pair.token),/revoked/);assert.throws(()=>f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871),/revoked/);
});

test('rotation replaces every active key with one full writable key and revokes only their attached sessions', t => {
 const f = setup(t);
 const prior = [
  f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871),
  f.store.issueKey({allowedRoots:['ServerStorage'],allowWrites:true},45871),
  f.store.issueKey({allowedRoots:['Lighting'],allowWrites:false},45872),
 ];
 const pairs = prior.map((key, i) => f.store.connectWithKey({...f.connect,identity:{...f.connect.identity,clientSessionId:'rotate-window-'+i},apiKey:key.apiKey},i === 2 ? 45872 : 45871));
 const grant = f.store.createGrant({allowedRoots:['StarterGui'],allowWrites:false});
 const unrelated = f.store.pair({...f.connect,identity:{...f.connect.identity,clientSessionId:'independent-grant-window'},code:grant.code});
 const dispatched = f.store.enqueue({sessionId:pairs[0]!.sessionId,requestId:'rotate-dispatched',method:'selection.read',args:{}});
 const queued = f.store.enqueue({sessionId:pairs[0]!.sessionId,requestId:'rotate-undelivered',method:'selection.read',args:{}});
 f.store.poll(pairs[0]!.sessionId);
 const replacement = f.store.rotateKey({},45871);
 assert.deepEqual(replacement.allowedRoots,[...ROOTS]);
 assert.equal(replacement.allowWrites,true);
 assert.equal(replacement.revokedAt,null);
 assert.equal(replacement.lastUsedAt,null);
 assert.match(replacement.apiKey,/^arcane_local_v1_45871_[a-f0-9]{64}$/);
 assert.deepEqual(f.store.keys().filter(key => !key.revokedAt).map(key => key.keyId),[replacement.keyId]);
 for (const [i, key] of prior.entries()) {
  assert.throws(() => f.store.connectWithKey({...f.connect,apiKey:key.apiKey},i === 2 ? 45872 : 45871),/revoked/);
  assert.throws(() => f.store.authenticate(pairs[i]!.sessionId,pairs[i]!.token),/revoked/);
 }
 assert.equal(f.store.command(dispatched.id).state,'needs_reconciliation');
 assert.equal(f.store.command(queued.id).state,'cancelled');
 assert.equal(f.store.authenticate(unrelated.sessionId,unrelated.token).revokedAt,null);
 const connected = f.store.connectWithKey({...f.connect,apiKey:replacement.apiKey},45871);
 assert.deepEqual(connected.allowedRoots,[...ROOTS]);
 assert.equal(connected.allowWrites,true);
 for (const root of ROOTS) f.store.enqueue({sessionId:connected.sessionId,requestId:'rotate-root-'+root,method:'scene.children',args:{root}});
 const parent = {instanceId:'full-root',sessionId:connected.sessionId,root:'ServerStorage',pathSegments:[],className:'ServerStorage'};
 assert.equal(f.store.enqueue({sessionId:connected.sessionId,requestId:'rotate-writable',method:'scene.create',args:{parent,className:'Folder',name:'Fixture'}}).state,'queued');
 assert.throws(() => f.store.enqueue({sessionId:connected.sessionId,requestId:'rotate-foreign-root',method:'scene.children',args:{root:'DataStoreService'}}),/grant/);
 assert.throws(() => f.store.enqueue({sessionId:connected.sessionId,requestId:'rotate-foreign-ref',method:'scene.inspect',args:{ref:{...parent,sessionId:unrelated.sessionId}}}),/scope/);
 assert.throws(() => f.store.connectWithKey({...f.connect,apiKey:replacement.apiKey},45872),/another local endpoint/);
 const foreign = setup(t).store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871);
 assert.throws(() => f.store.connectWithKey({...f.connect,apiKey:foreign.apiKey},45871),/invalid/);
 const visible = JSON.stringify({keys:f.store.keys(),sessions:f.store.sessions(),events:f.store.events()});
 for (const secret of [...prior.map(key => key.apiKey),replacement.apiKey,...pairs.map(pair => pair.token),connected.token]) assert.equal(visible.includes(secret),false);
 const content = Buffer.concat(readdirSync(f.directory).filter(n => n.startsWith('studio.sqlite')).map(n => readFileSync(join(f.directory,n))));
 assert.equal(content.includes(replacement.apiKey),false);
 f.store.close();
 const reopened = new StudioStore({directory:f.directory});
 t.after(() => reopened.close());
 assert.deepEqual(reopened.keys().filter(key => !key.revokedAt).map(key => key.keyId),[replacement.keyId]);
 for (const [i, key] of prior.entries()) assert.throws(() => reopened.connectWithKey({...f.connect,apiKey:key.apiKey},i === 2 ? 45872 : 45871),/revoked/);
 assert.deepEqual(reopened.connectWithKey({...f.connect,apiKey:replacement.apiKey},45871).allowedRoots,[...ROOTS]);
 reopened.close();
});

test('rotation works at the active key cap and revokes attached sessions beyond the display limit', t => {
 const f = setup(t);
 const keys = Array.from({length:32},() => f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871));
 assert.throws(() => f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871),/32 active/);
 const pairs = Array.from({length:101},(_,i) => f.store.connectWithKey({...f.connect,identity:{...f.connect.identity,clientSessionId:'many-rotate-'+i},apiKey:keys[0]!.apiKey},45871));
 assert.equal(f.store.sessions().length,100);
 const replacement = f.store.rotateKey({},45871);
 assert.equal(f.store.keys().filter(key => !key.revokedAt).length,1);
 for (const key of keys) assert.throws(() => f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871),/revoked/);
 for (const pair of pairs) assert.throws(() => f.store.authenticate(pair.sessionId,pair.token),/revoked/);
 assert.equal(f.store.connectWithKey({...f.connect,apiKey:replacement.apiKey},45871).allowWrites,true);
});

test('rotation accepts only an empty object and valid port without changing prior state on invalid input', t => {
 const f = setup(t);
 const key = f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871);
 const pair = f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871);
 const before = {keys:f.store.keys(),sessions:f.store.sessions(),events:f.store.events()};
 for (const input of [null,[],true,'',undefined,{allowedRoots:['Workspace']},{allowWrites:false},{apiKey:key.apiKey},{keyId:key.keyId},{unexpected:true},JSON.parse('{"__proto__":{}}')]) assert.throws(() => f.store.rotateKey(input,45871),/object/);
 for (const port of [0,-1,65536,1.5,NaN]) assert.throws(() => f.store.rotateKey({},port),/valid local port/);
 assert.deepEqual({keys:f.store.keys(),sessions:f.store.sessions(),events:f.store.events()},before);
 assert.equal(f.store.authenticate(pair.sessionId,pair.token).revokedAt,null);
});

for (const [stage, sql] of [
 ['session revocation',"CREATE TRIGGER fail_rotation BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'injected rotation failure'); END"],
 ['replacement insert',"CREATE TRIGGER fail_rotation BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT,'injected rotation failure'); END"],
 ['replacement audit',"CREATE TRIGGER fail_rotation BEFORE INSERT ON events WHEN NEW.kind='arcane_key_issued' BEGIN SELECT RAISE(ABORT,'injected rotation failure'); END"],
] as const) test('rotation rolls back keys, sessions, command states and audit after failure during '+stage, t => {
 const f = setup(t);
 const keys = Array.from({length:2},() => f.store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871));
 const pairs = keys.map((key,i) => f.store.connectWithKey({...f.connect,identity:{...f.connect.identity,clientSessionId:'failure-window-'+i},apiKey:key.apiKey},45871));
 f.store.enqueue({sessionId:pairs[0]!.sessionId,requestId:'failure-dispatched',method:'selection.read',args:{}});
 f.store.enqueue({sessionId:pairs[0]!.sessionId,requestId:'failure-undelivered',method:'selection.read',args:{}});
 f.store.poll(pairs[0]!.sessionId);
 const db = new DatabaseSync(join(f.directory,'studio.sqlite'));
 const snapshot = () => ['api_keys','sessions','commands','events','grants'].map(table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 try {
  const before = snapshot();
  db.exec(sql);
  assert.throws(() => f.store.rotateKey({},45871),/injected rotation failure/);
  assert.deepEqual(snapshot(),before);
  for (const pair of pairs) assert.equal(f.store.authenticate(pair.sessionId,pair.token).revokedAt,null);
  db.exec('DROP TRIGGER fail_rotation');
  for (const key of keys) assert.equal(f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871).allowWrites,true);
  const replacement = f.store.rotateKey({},45871);
  assert.equal(f.store.connectWithKey({...f.connect,apiKey:replacement.apiKey},45871).allowWrites,true);
 } finally { db.close(); }
});

test('key issuance also rolls back its inserted key if durable audit persistence fails', t => {
 const f = setup(t);
 const db = new DatabaseSync(join(f.directory,'studio.sqlite'));
 try {
  const before = f.store.events();
  db.exec("CREATE TRIGGER fail_issue BEFORE INSERT ON events WHEN NEW.kind='arcane_key_issued' BEGIN SELECT RAISE(ABORT,'injected issue failure'); END");
  assert.throws(() => f.store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871),/injected issue failure/);
  assert.deepEqual(f.store.keys(),[]);
  assert.deepEqual(f.store.events(),before);
 } finally { db.close(); }
});

test('failed COMMIT rolls back rotation and preserves previously connected sessions without retry', t => {
 const f = setup(t);
 const key = f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871);
 const pair = f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871);
 const before = {keys:f.store.keys(),sessions:f.store.sessions(),events:f.store.events()};
 // Inject the failure at the store connection's commit boundary after every write.
 const db = (f.store as unknown as {db:DatabaseSync}).db;
 const exec = db.exec.bind(db);
 let commits = 0;
 const mocked = t.mock.method(db,'exec',(sql:string) => {
  if (sql === 'COMMIT') { commits++; throw new Error('injected commit failure'); }
  return exec(sql);
 });
 assert.throws(() => f.store.rotateKey({},45871),/injected commit failure/);
 assert.equal(commits,1);
 assert.deepEqual({keys:f.store.keys(),sessions:f.store.sessions(),events:f.store.events()},before);
 assert.equal(f.store.authenticate(pair.sessionId,pair.token).revokedAt,null);
 mocked.mock.restore();
 assert.equal(f.store.connectWithKey({...f.connect,apiKey:key.apiKey},45871).allowWrites,false);
 assert.equal(f.store.rotateKey({},45871).allowWrites,true);
});

for (const stage of ['after revocations','after replacement insert']) test('process exit '+stage+' but before rotation COMMIT leaves the prior durable keys active', t => {
 const f = setup(t);
 const keys = Array.from({length:2},() => f.store.issueKey({allowedRoots:['Workspace'],allowWrites:false},45871));
 const before = f.store.keys();
 f.store.close();
 const moduleUrl = new URL('../../packages/storage/src/studio-store.js',import.meta.url).href;
 const child = spawnSync(process.execPath,['--input-type=module','-e',`
  import { StudioStore } from ${JSON.stringify(moduleUrl)};
  const store = new StudioStore({directory:process.env.ARCANE_ROTATION_CRASH_DIRECTORY});
  const insert = store.insertKey.bind(store);
  store.insertKey = (...args) => {
   if (process.env.ARCANE_ROTATION_CRASH_STAGE === 'after replacement insert') insert(...args);
   process.exit(17);
  };
  store.rotateKey({},45871);
 `],{env:{...process.env,ARCANE_ROTATION_CRASH_DIRECTORY:f.directory,ARCANE_ROTATION_CRASH_STAGE:stage},windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(child.error,undefined);
 assert.equal(child.status,17,child.stderr);
 const reopened = new StudioStore({directory:f.directory});
 t.after(() => reopened.close());
 assert.deepEqual(reopened.keys(),before);
 for (const key of keys) assert.equal(reopened.connectWithKey({...f.connect,apiKey:key.apiKey},45871).allowWrites,false);
 assert.equal(reopened.events().some(e => e && typeof e === 'object' && !Array.isArray(e) && e.kind === 'arcane_key_revoked'),false);
 reopened.close();
});
test('JSON argument normalization is a snapshot and engine properties use deterministic float32 values',()=>{
 const value={properties:{Transparency:0.3,Size:{type:'Vector3',value:[0.1,2.3,4.5]}}};const copied=jsonObject(value);(copied.properties as any).Transparency=0.4;assert.equal(value.properties.Transparency,0.3);
 const properties=engineProperties(value.properties);assert.equal(properties.Transparency,Math.fround(0.3));assert.equal((properties.Size as any).value[0],Math.fround(0.1));assert.equal(value.properties.Size.value[0],0.1);
});
