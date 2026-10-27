import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StudioStore,type StudioNativeCustodyPort} from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {createStudioTestNativeCustody,closeAfterStudioTestNativeConnectFailure,captureStudioTestNativeProject} from '../../apps/daemon/src/studio-test-native-custody.js';
import type {NativeTestConnection} from '../../apps/daemon/src/studio-test-service.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';
// Actual SQLite/custodian; all native events/SDK handles below are controlled
// scheduling fixtures. No process or Studio is launched and no physical proof claimed.
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject};}
function fixture(t:TestContext,wrap?:(port:StudioNativeCustodyPort)=>StudioNativeCustodyPort,scopeProject=false){
 const root=makeFixtureDirectory('arcane-custody-work-'),directory=join(root,'store'),store=new StudioStore({directory});
 const projectPath=scopeProject?join(root,'project'):root;if(scopeProject)mkdirSync(projectPath);
 const port=store.bindNativeCustody(workflowProjectIdentity(projectPath).projectId,directory),project=scopeProject?captureStudioTestNativeProject(projectPath):null;
 const custody=createStudioTestNativeCustody(wrap?wrap(port):port,project?.assertCurrent);let refuses=false;
 t.after(async()=>{try{if(refuses)await assert.rejects(custody.close(),{code:'SDK_CUSTODY_UNCONFIRMED'});else await custody.close();}finally{store.close();const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&tail.startsWith('arcane-custody-work-')&&!tail.startsWith('..'));rmSync(root,{recursive:true,force:true});}});
 return{custody,store,projectPath,root,rows(){const db=new DatabaseSync(sqliteTransportPath(join(directory,'studio.sqlite')),{readOnly:true});try{return db.prepare('SELECT state,payload FROM studio_native_custody').all();}finally{db.close();}},expectRefusal(){refuses=true;}};
}
function raw(close:()=>Promise<void>,evidence:'fixture'|'native'='fixture'):NativeTestConnection{return{client:new Client({name:'controlled-custody',version:'fixture'}),evidence,async witness(){throw Error('No Studio witness in this storage fixture');},close};}
async function pending(promise:Promise<unknown>){let done=false;void promise.then(()=>{done=true;},()=>{done=true;});await Promise.resolve();await Promise.resolve();assert.equal(done,false);}
for(const requestError of [Error('original request'),null,undefined])test('positive original no-start joins independently of request error '+String(requestError),async t=>{
 const f=fixture(t);let join:Promise<void>|undefined,observers=0,calls=0;
 await assert.rejects(f.custody.connect('playtest-prepare','native',async attempt=>{calls++;attempt.noStart();throw requestError;},()=>{},value=>{observers++;join=value;}),error=>error===requestError);
 assert.ok(join);await join;assert.equal(observers,1);assert.equal(calls,1);f.custody.assertReady();
});
test('returned original resource closes once before its request failure can join',async t=>{
 const f=fixture(t),release=deferred<void>(),entered=deferred<void>(),requestError=Error('A');let closes=0,join:Promise<void>|undefined;
 const request=f.custody.connect('playtest-prepare','fixture',async()=>raw(async()=>{closes++;entered.resolve();await release.promise;}),()=>{throw requestError;},value=>{join=value;});
 void request.catch(()=>{});await entered.promise;assert.ok(join);await pending(join);release.resolve();await assert.rejects(request,error=>error===requestError);await join;assert.equal(closes,1);
});
for(const cleanupError of [Error('cleanup B'),null,undefined])test('request A remains caller error while original cleanup B rejects join '+String(cleanupError),async t=>{
 const f=fixture(t),requestError=Error('A');f.expectRefusal();let join:Promise<void>|undefined,closes=0;
 await assert.rejects(f.custody.connect('playtest-prepare','fixture',async()=>raw(async()=>{closes++;throw cleanupError;}),()=>{throw requestError;},value=>{join=value;}),error=>error===requestError);
 assert.ok(join);await assert.rejects(join,error=>error===cleanupError);assert.equal(closes,1);assert.throws(()=>f.custody.assertReady(),{code:'SDK_CUSTODY_UNCONFIRMED'});
});
test('default failed-connect cleanup carries exact B separately from original A',async t=>{
 const f=fixture(t),a=Error('connect A'),b=Error('close B');f.expectRefusal();let join:Promise<void>|undefined;
 await assert.rejects(f.custody.connect('playtest-prepare','native',async attempt=>{
   attempt.launchAttempted();return closeAfterStudioTestNativeConnectFailure(attempt,{physicalClosed:new Promise<void>(()=>{}),async close(){throw b;}},a);
 },()=>{},value=>{join=value;}),error=>error===a);
 assert.ok(join);await assert.rejects(join,error=>error===b);
});
test('opaque rejected fixture factory stays quarantined rather than inventing no-start',async t=>{
 const f=fixture(t),a=Error('opaque factory');f.expectRefusal();let join:Promise<void>|undefined;
 await assert.rejects(f.custody.connect('playtest-prepare','fixture',async()=>{throw a;},()=>{},value=>{join=value;}),error=>error===a);
 assert.ok(join);await assert.rejects(join,{code:'SDK_CUSTODY_UNCONFIRMED'});
});
for(const callbackError of [Error('observer'),undefined])test('throwing observer invokes no factory and joins genuine pre-factory no-start '+String(callbackError),async t=>{
 const f=fixture(t);let join:Promise<void>|undefined,calls=0;
 await assert.rejects(f.custody.connect('playtest-prepare','fixture',async()=>{calls++;return raw(async()=>{});},()=>{},value=>{join=value;throw callbackError;}),error=>error===callbackError);
 assert.ok(join);await join;assert.equal(calls,0);f.custody.assertReady();
});
test('only exact original BUSY-before-reserve error is classified not-admitted',async t=>{
 const f=fixture(t),release=deferred<void>();let calls=0,observed=0;
 const first=f.custody.connect('playtest-prepare','fixture',async()=>{await release.promise;return raw(async()=>{});});
 let busy:unknown;try{await f.custody.connect('viewport','fixture',async()=>{calls++;return raw(async()=>{});},()=>{},()=>{observed++;});}catch(error){busy=error;}
 assert.equal(f.custody.preEntryRefusal(busy),'not-admitted');assert.equal(f.custody.preEntryRefusal(Object.assign(Error('BUSY'),{code:'BUSY'})),null);
 for(const value of [null,undefined,false,{},new Proxy({}, {})])assert.equal(f.custody.preEntryRefusal(value),null);
 assert.equal(calls,0);assert.equal(observed,0);release.resolve();await (await first).close();
});
test('reserve uncertainty preserves actual committed pending row and issues no observer',async t=>{
 const f=fixture(t,port=>Object.freeze({...port,reserve(operation:Parameters<StudioNativeCustodyPort['reserve']>[0],evidence:Parameters<StudioNativeCustodyPort['reserve']>[1]){port.reserve(operation,evidence);throw Error('after actual commit');}}));f.expectRefusal();let observed=0,calls=0,failure:unknown;
 try{await f.custody.connect('viewport','fixture',async()=>{calls++;return raw(async()=>{});},()=>{},()=>{observed++;});}catch(error){failure=error;}
 assert.equal(f.custody.preEntryRefusal(failure),'ownership-uncertain');assert.equal(observed,0);assert.equal(calls,0);assert.equal(f.rows().length,1);assert.equal(f.rows()[0]?.state,'pending');
});
test('physical callback before raw close failure cannot fulfill original join or erase B',async t=>{
 const f=fixture(t),physical=deferred<void>(),b=Error('late raw close B');f.expectRefusal();let join:Promise<void>|undefined;
 const connection=await f.custody.connect('viewport','native',async attempt=>{attempt.observePhysicalClose(physical.promise);attempt.launchAttempted();return raw(async()=>{throw b;},'native');},()=>{},value=>{join=value;});
 physical.resolve();await Promise.resolve();assert.ok(join);await pending(join);await assert.rejects(connection.close(),error=>error===b);await assert.rejects(join,error=>error===b);
});
test('late contradictory observation still fences after a completed original no-start join',async t=>{
 const f=fixture(t),physical=deferred<void>(),a=Error('no launch');let join:Promise<void>|undefined;
 await assert.rejects(f.custody.connect('viewport','native',async attempt=>{attempt.observePhysicalClose(physical.promise);attempt.noStart();throw a;},()=>{},value=>{join=value;}),error=>error===a);
 assert.ok(join);await join;physical.reject(Error('late contradictory event'));await Promise.resolve();f.expectRefusal();assert.throws(()=>f.custody.assertReady(),{code:'SDK_CUSTODY_UNCONFIRMED'});
});

test('late contradictory positive event fences even after original no-start join fulfilled',async t=>{
 const f=fixture(t),physical=deferred<void>(),a=Error('no launch');let join:Promise<void>|undefined;
 await assert.rejects(f.custody.connect('viewport','native',async attempt=>{attempt.observePhysicalClose(physical.promise);attempt.noStart();throw a;},()=>{},value=>{join=value;}),error=>error===a);
 assert.ok(join);await join;physical.resolve();await Promise.resolve();f.expectRefusal();assert.throws(()=>f.custody.assertReady(),{code:'SDK_CUSTODY_UNCONFIRMED'});
});

test('finished raw close without native confirmation refuses; a late event cannot repair that join',async t=>{
 const f=fixture(t),physical=deferred<void>();f.expectRefusal();let join:Promise<void>|undefined,closes=0;
 const connection=await f.custody.connect('viewport','native',async attempt=>{attempt.observePhysicalClose(physical.promise);attempt.launchAttempted();return raw(async()=>{closes++;},'native');},()=>{},value=>{join=value;});
 await assert.rejects(connection.close(),{code:'SDK_CUSTODY_UNCONFIRMED'});assert.ok(join);await assert.rejects(join,{code:'SDK_CUSTODY_UNCONFIRMED'});
 physical.resolve();await Promise.resolve();await assert.rejects(join,{code:'SDK_CUSTODY_UNCONFIRMED'});assert.throws(()=>f.custody.assertReady(),{code:'SDK_CUSTODY_UNCONFIRMED'});assert.equal(closes,1);
});

test('original readiness refusal is classified uncertain without synthetic observer or factory',async t=>{
 const f=fixture(t);f.custody.retireAdmissions();let observer=0,factory=0,failure:unknown;
 try{await f.custody.connect('viewport','fixture',async()=>{factory++;return raw(async()=>{});},()=>{},()=>{observer++;});}catch(error){failure=error;}
 assert.equal(f.custody.preEntryRefusal(failure),'ownership-uncertain');assert.equal(observer,0);assert.equal(factory,0);assert.equal(f.rows().length,0);
});

test('original scope loss rejects accounting while its held factory and positive late close remain joined',async t=>{
 const f=fixture(t,undefined,true),factoryRelease=deferred<void>(),closeEntered=deferred<void>(),closeRelease=deferred<void>();f.expectRefusal();
 let custodyJoin:Promise<void>|undefined,closes=0,scopeFailure:unknown;
 const request=f.custody.connect('playtest-prepare','fixture',async()=>{await factoryRelease.promise;return raw(async()=>{closes++;closeEntered.resolve();await closeRelease.promise;});},()=>{},value=>{custodyJoin=value;});void request.catch(()=>{});
 assert.ok(custodyJoin);renameSync(f.projectPath,join(f.root,'original-project'));mkdirSync(f.projectPath);
 try{f.custody.assertReady();assert.fail('Actual original project replacement must refuse');}catch(error){scopeFailure=error;}
 assert.ok(scopeFailure instanceof Error);assert.equal('code'in scopeFailure&&scopeFailure.code,'SDK_CUSTODY_UNCONFIRMED');
 await assert.rejects(custodyJoin,error=>error===scopeFailure);assert.equal(f.rows()[0]?.state,'quarantined');
 const payload=f.rows()[0]?.payload;assert.equal(typeof payload,'string');assert.equal(JSON.parse(String(payload)).reason,'scope-lost');await pending(request);
 factoryRelease.resolve();await closeEntered.promise;await pending(request);assert.equal(closes,1);
 closeRelease.resolve();await assert.rejects(request,{code:'SDK_CUSTODY_UNCONFIRMED'});await assert.rejects(custodyJoin,error=>error===scopeFailure);
 assert.equal(f.rows()[0]?.state,'settled','original positive fixture close may settle its ticket without clearing sticky scope failure');
 assert.throws(()=>f.custody.assertReady(),{code:'SDK_CUSTODY_UNCONFIRMED'});
});
