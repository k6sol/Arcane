import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute,sep} from 'node:path';
import {createCodexService,type CodexHostClient} from '../../apps/daemon/src/codex-service.js';
import {createNativeAssetRegistry,assertNativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import type {Snapshot,NativeAssetHooks} from '../../packages/codex-client/src/index.js';

// Actual SQLite locks + service/registry; labelled fake provider only, no CLI/Studio.
async function fixture(t:test.TestContext) {
 const boundary=realpathSync(tmpdir()),root=mkdtempSync(join(boundary,'arcane-native-journal-fault-')),project=join(root,'project'),directory=join(root,'codex');mkdirSync(project);
 const registry=createNativeAssetRegistry({projectPath:project}),connectionId=randomUUID(),threadId='journal-fixture-thread';
 let hooks:NativeAssetHooks|undefined,token='',closes=0,lockAt:'thread'|'turn'|null=null,locked=false;
 const snapshot:Snapshot={connectionId,provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
 let locker:DatabaseSync;
 const lock=()=>{locker.exec('BEGIN IMMEDIATE');locked=true;};
 const client:CodexHostClient={snapshot:()=>structuredClone(snapshot),selectModel:()=>({model:'fixture',effort:'low'}),
  async startThread(){snapshot.thread={threadId,sessionId:null,selection:{model:'fixture',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};if(lockAt==='thread')lock();return structuredClone(snapshot.thread);},
  async resumeThread(){return this.startThread({initiatedBy:'human'});},grantThreadWrites(){throw Error('No file grants in fixture');},revokeThreadWrites(){},
  async startTurn(){hooks!.dispatched({connectionId,threadId,operationId:randomUUID()});snapshot.thread!.turnStatus='inProgress';snapshot.thread!.turnId='fixture-turn';if(lockAt==='turn')lock();return structuredClone(snapshot.thread!);},
  async interruptTurn(){hooks!.retired();},respondApproval(){throw Error('No approvals in fixture');},
  async close(){closes++;hooks?.retired();snapshot.connected=false;snapshot.ready=false;},
 };
 const service=createCodexService({directory,projectPath:project,assetRegistry:registry,connect:async h=>{hooks=h;token=h!.finalCredential();return client;}});
 locker=new DatabaseSync(join(directory,'codex-actions.sqlite'),{timeout:0,allowExtension:false});
 const action=(action:string,fields:Record<string,unknown>={})=>service.action({requestId:randomUUID(),connectionId:action==='connect'?null:connectionId,action,...fields});
 const ready=async()=>{assert.equal((await action('connect')).record.state,'acknowledged');assert.equal((await action('thread-start')).record.state,'acknowledged');assert.equal((await action('grant-assets',{threadId})).record.state,'acknowledged');};
 t.after(async()=>{if(locked)locker.exec('ROLLBACK');locker.close();await service.close();registry.close();const part=relative(boundary,resolve(root));assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep));assert.ok(!lstatSync(root).isSymbolicLink());rmSync(root,{recursive:true,force:true});});
 return {registry,service,threadId,connectionId,snapshot,action,ready,lock,setLockAt:(v:'thread'|'turn')=>lockAt=v,get token(){return token;},get closes(){return closes;},failReceiptUpdate:()=>locker.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT,'owned fixture update refused'); END;"),journal:()=>({history:locker.prepare('SELECT count(*) AS n FROM native_history').get(),rows:locker.prepare('SELECT payload FROM actions').all()})};
}
const journalFault=(error:unknown)=>error instanceof Error && 'code' in error && error.code==='JOURNAL_FAILURE';
const denied=(error:unknown)=>error instanceof Error && 'code' in error && error.code==='NATIVE_ASSET_AUTHORITY';
for(const safety of ['revoke-assets','disconnect','turn-interrupt','revoke-writes'])test('locked pending receipt fences exact '+safety+' before the failed action settles',{timeout:12000},async t=>{
 const f=await fixture(t);await f.ready();await f.action('turn-start',{threadId:f.threadId,text:'Synthetic dispatch'});
 const actor=f.registry.capture(f.token,'mutate');f.lock();
 const fields=safety==='disconnect'?{}:safety==='turn-interrupt'?{threadId:f.threadId,turnId:'fixture-turn'}:{threadId:f.threadId};
 await assert.rejects(f.action(safety,fields),journalFault);
 assert.throws(()=>assertNativeAssetActor(actor,'mutate'),denied);assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);assert.equal(f.registry.recognizes(f.token),false);assert.equal(f.closes,1);
 await assert.rejects(f.action('connect'),journalFault);assert.equal(f.closes,1,'No retry/reconnect after a failed journal');
});
test('lock acquired after native dispatch makes final BEGIN fail and retires authority',{timeout:12000},async t=>{
 const f=await fixture(t);await f.ready();const read=f.registry.capture(f.token,'read');f.setLockAt('turn');
 await assert.rejects(f.action('turn-start',{threadId:f.threadId,text:'Synthetic ACK after lock'}),journalFault);
 assert.throws(()=>assertNativeAssetActor(read,'read'),denied);assert.equal(f.registry.recognizes(f.token),false);assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);assert.equal(f.closes,1);
});
test('configured native metadata cannot seal when its durable receipt BEGIN fails',{timeout:12000},async t=>{
 const f=await fixture(t);await f.action('connect');f.setLockAt('thread');
 await assert.rejects(f.action('thread-start'),journalFault);
 assert.equal(f.registry.recognizes(f.token),false);assert.throws(()=>f.registry.capture(f.token,'read'),denied);assert.equal(f.closes,1);assert.equal(f.service.state().nativeAssets?.sealed,false);
});

test('failed receipt UPDATE rolls back staged native identity and cannot seal or replay',{timeout:12000},async t=>{
 const f=await fixture(t);await f.action('connect');f.failReceiptUpdate();
 await assert.rejects(f.action('thread-start'),journalFault);
 assert.equal(f.registry.recognizes(f.token),false);assert.equal(f.closes,1);assert.equal(f.journal().history!.n,0);
 const rows=f.journal().rows.map(row=>JSON.parse(String(row.payload)));assert.equal(rows.find(row=>row.action==='thread-start').state,'pending','Uncommitted receipt is retained, not called acknowledged');
 await assert.rejects(f.action('turn-start',{threadId:f.threadId,text:'must not run'}),journalFault);
});
