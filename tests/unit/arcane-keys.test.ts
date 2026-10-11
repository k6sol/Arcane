import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {READ_METHODS,WRITE_METHODS,jsonObject} from '../../packages/protocol/src/studio.js';
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
test('JSON argument normalization is a snapshot and engine properties use deterministic float32 values',()=>{
 const value={properties:{Transparency:0.3,Size:{type:'Vector3',value:[0.1,2.3,4.5]}}};const copied=jsonObject(value);(copied.properties as any).Transparency=0.4;assert.equal(value.properties.Transparency,0.3);
 const properties=engineProperties(value.properties);assert.equal(properties.Transparency,Math.fround(0.3));assert.equal((properties.Size as any).value[0],Math.fround(0.1));assert.equal(value.properties.Size.value[0],0.1);
});
