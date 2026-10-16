import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {READ_METHODS,WRITE_METHODS} from '../../packages/protocol/src/studio.js';
import {createConnectionLab} from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';

const identity={clientSessionId:'status-fixture-client',placeId:0,universeId:0,name:'Synthetic status fixture',pluginVersion:'0.1.7'};
async function fixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'arcane-plugin-status-')),store=new StudioStore({directory});
  t.after(async()=>{store.close();const rel=relative(tmpdir(),directory);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(directory,{recursive:true,force:true});});
  const key=store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871);
  const request={protocolVersion:1,apiKey:key.apiKey,identity};
  const connect=()=>store.connectWithKey({...request,capabilities:[...READ_METHODS,...WRITE_METHODS]},45871);
  return {directory,store,key,request,connect};
}
test('status never creates sessions, updates key use, renews heartbeats or returns a bearer',async t=>{
  const f=await fixture(t);const events=f.store.events(),keys=f.store.keys();
  assert.deepEqual(f.store.connectionStatusWithKey(f.request,45871),{protocolVersion:1,identity,state:'absent'});
  assert.deepEqual(f.store.sessions(),[]);assert.deepEqual(f.store.events(),events);assert.deepEqual(f.store.keys(),keys);
  const pair=f.connect(),before=f.store.session(pair.sessionId),beforeEvents=f.store.events(),beforeKeys=f.store.keys();
  const result=f.store.connectionStatusWithKey({...f.request,sessionId:pair.sessionId},45871);
  assert.equal(result.state,'active');assert.equal(result.sessionId,pair.sessionId);
  assert.deepEqual(f.store.session(pair.sessionId),before);assert.deepEqual(f.store.events(),beforeEvents);assert.deepEqual(f.store.keys(),beforeKeys);
  assert.ok(!JSON.stringify(result).includes(pair.token)&&!JSON.stringify(result).includes(f.key.apiKey));
  f.store.revoke(pair.sessionId);
  assert.equal(f.store.connectionStatusWithKey({...f.request,sessionId:pair.sessionId},45871).state,'lost');
});
test('exact key, endpoint, lifetime, identity and strict fields prevent foreign status recovery',async t=>{
  const f=await fixture(t),pair=f.connect(),foreign=f.store.issueKey({allowedRoots:['Workspace'],allowWrites:true},45871);
  for(const change of [{apiKey:foreign.apiKey,sessionId:pair.sessionId},{identity:{...identity,clientSessionId:'other'},sessionId:pair.sessionId},
    {identity:{...identity,placeId:1}},{identity:{...identity,name:'another place'}},{identity:{...identity,pluginVersion:'another version'}},
    {identity:{...identity,extra:true}},{verified:true},{protocolVersion:2},{apiKey:'invalid'},{sessionId:'missing'}])
    assert.throws(()=>f.store.connectionStatusWithKey({...f.request,...change},45871));
  assert.throws(()=>f.store.connectionStatusWithKey(f.request,45872));
  f.store.revokeKey(f.key.keyId);assert.throws(()=>f.store.connectionStatusWithKey(f.request,45871),/invalid, revoked/);
});
test('pending work and unknown effects block recovery without dispatch or replay, beyond display limits',async t=>{
  const f=await fixture(t),pair=f.connect();
  const pending=f.store.enqueue({sessionId:pair.sessionId,requestId:'status-queued-fixture',method:'scene.children',args:{root:'Workspace'}});
  assert.equal(f.store.connectionStatusWithKey(f.request,45871).state,'reconciliation');assert.equal(f.store.command(pending.id).state,'queued');
  f.store.poll(pair.sessionId);f.store.revoke(pair.sessionId);
  const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try {
    for(let index=0;index<110;index++){
      const old={...f.store.session(pair.sessionId,false),id:'status-history-'+index,revokedAt:new Date().toISOString()};
      db.prepare('INSERT INTO sessions(id,payload,token_hash,key_id) VALUES(?,?,?,?)').run(old.id,JSON.stringify(old),'not-a-bearer',f.key.keyId);
    }
  } finally { db.close(); }
  assert.equal(f.store.sessions().some(s=>s.id===pair.sessionId),false,'Old unknown record is beyond UI history limit');
  const result=f.store.connectionStatusWithKey(f.request,45871);
  assert.equal(result.state,'reconciliation');assert.equal(result.sessionId,pair.sessionId);
  assert.equal(f.store.command(pending.id).state,'needs_reconciliation');
});
test('real HTTP status contract authenticates exact keys and refuses cross-origin, GET and secret disclosure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arcane-plugin-status-http-')),store=new StudioStore({directory});
  const app=await createConnectionLab({cwd:resolve('.'),stateDirectory:join(directory,'host'),studioStore:store,probe:async()=>[],codexConnect:refuseNativeCodex});
  t.after(async()=>{await app.close();store.close();const rel=relative(tmpdir(),directory);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(directory,{recursive:true,force:true});});
  const key=store.issueKey({allowedRoots:['Workspace'],allowWrites:true},Number(new URL(app.origin).port));
  const body={protocolVersion:1,apiKey:key.apiKey,identity};
  const post=(payload:unknown,origin?:string)=>fetch(app.origin+'/v1/plugin/status',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(payload)});
  const absent=await post(body);assert.equal(absent.status,200);assert.equal((await absent.json() as {state:string}).state,'absent');
  assert.equal((await post(body,'https://attacker.invalid')).status,403);
  assert.equal((await post({...body,apiKey:'wrong'})).status,401);
  assert.equal((await fetch(app.origin+'/v1/plugin/status')).status,405);
  assert.equal((await post({...body,token:'injected'})).status,400);
  const paired=store.connectWithKey({...body,capabilities:[...READ_METHODS,...WRITE_METHODS]},Number(new URL(app.origin).port));
  const response=await post({...body,sessionId:paired.sessionId});assert.equal(response.status,200);
  const raw=await response.text();assert.match(raw,/"state":"active"/);assert.ok(!raw.includes(key.apiKey)&&!raw.includes(paired.token));
  assert.equal(store.sessions().length,1);assert.equal(store.commands().length,0);
  assert.equal(response.headers.get('cache-control'),'no-store');
});
