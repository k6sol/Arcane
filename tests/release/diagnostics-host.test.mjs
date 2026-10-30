import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import * as report from '../../packages/diagnostics/src/report.ts';
const require=createRequire(import.meta.url),{createDiagnosticsHost}=require('../../apps/desktop/electron/diagnostics-host.cjs');
// Execute the real outbox through Node's TS transform; only its relative import URL is remapped.
const source=stripTypeScriptTypes(readFileSync(new URL('../../packages/diagnostics/src/outbox.ts',import.meta.url),'utf8'),{mode:'transform'})
 .replace("'./report.js'",JSON.stringify(new URL('../../packages/diagnostics/src/report.ts',import.meta.url).href));
const queue=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=1792500000000,base='https://diagnostics.example';
const input=()=>({schemaVersion:1,eventId:randomUUID(),occurredAt:now,component:'blender',stage:'texture-authoring',code:'MEMORY_LIMIT',context:{exceptionType:'MemoryError',triangleBudget:16000}});
function safeStorage(){const key=randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString(text){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},
 decryptString(bytes){const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};}
async function fixture(t,overrides={}){
 const db=new DatabaseSync(':memory:');let privateReady=true,current=null;const calls=[];const storage={db,assertReady(){if(!privateReady)throw Error('private storage failure');}};
 const opts={enabled:true,storage,safeStorage:safeStorage(),loadRuntime:async()=>({...report,...queue}),allowedOrigins:[],credential:async()=>current,now:()=>now,
  fetch:async(url,init)=>{calls.push({url,init});return String(url).endsWith('/identity')?Response.json({accountId:'acct_'+'a'.repeat(32)}):Response.json({accepted:true,eventId:JSON.parse(init.body).eventId});},...overrides};
 const host=await createDiagnosticsHost(opts);t.after(async()=>{assert.equal(await host.close(),true);db.close();});
 return{host,db,opts,calls,current:value=>{current=value;},privateReady:value=>{privateReady=value;}};
}
test('missing endpoint still commits encrypted local evidence, survives a host reload and sends nothing',async t=>{
 const f=await fixture(t),event=input();const ack=await f.host.report(event);assert.deepEqual(ack,{stored:true,eventId:event.eventId,state:'local-only'});
 assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM diagnostic_outbox').all()).includes('MEMORY_LIMIT'));
 assert.equal((await f.host.flush()).state,'disabled');assert.equal(f.calls.length,0);
 assert.equal(await f.host.close(),true);const next=await createDiagnosticsHost(f.opts);t.after(()=>next.close());
 const reports=next.list().events;assert.equal(reports.length,1);assert.equal(reports[0].event.code,'MEMORY_LIMIT');assert.equal(reports[0].event.stage,'texture-authoring');assert.equal(reports[0].state,'local-only');
});
test('preaccount reports never rebind automatically; only reports under verified current account are delivered',async t=>{
 const f=await fixture(t,{allowedOrigins:[base]}),local=input();await f.host.report(local);
 f.current({base,token:'arc_'+'t'.repeat(43)});assert.equal((await f.host.refresh()).state,'ready');const online=input();assert.equal((await f.host.report(online)).state,'queued');
 assert.equal((await f.host.flush()).sent,1);const sent=f.calls.filter(call=>call.url.endsWith('/events')).map(call=>JSON.parse(call.init.body).eventId);
 assert.deepEqual(sent,[online.eventId]);assert.deepEqual(f.host.list().events.map(row=>row.event.eventId),[local.eventId]);
 assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM diagnostic_outbox').all()).includes('arc_'));
});
test('unavailable encryption, private-storage guard and failed database commits never acknowledge a stored report',async t=>{
 const f=await fixture(t);f.privateReady(false);assert.deepEqual(await f.host.report(input()),{stored:false,state:'unavailable'});f.privateReady(true);
 f.db.exec("CREATE TRIGGER reject_diagnostic BEFORE INSERT ON diagnostic_outbox BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
 assert.equal((await f.host.report(input())).stored,false);assert.equal(f.host.list().events.length,0);
 const disabled=await createDiagnosticsHost({...f.opts,safeStorage:{isEncryptionAvailable:()=>false}});assert.equal((await disabled.report(input())).stored,false);await disabled.close();
});
test('private child acknowledgements follow a durable commit and stale child lifetimes cannot write or receive callbacks',async t=>{
 const f=await fixture(t),child=new EventEmitter(),acks=[];child.connected=true;child.send=(value,callback)=>{acks.push(value);callback(null);return true;};let current=true;
 const detach=f.host.attach(child,()=>current),event=input(),requestId=randomUUID();child.emit('message',{type:'arcane-diagnostic-report',protocolVersion:1,requestId,event});
 await new Promise(done=>setImmediate(done));assert.equal(acks.length,1);assert.equal(acks[0].stored,true);assert.equal(acks[0].eventId,event.eventId);assert.equal(f.host.list().events.length,1);
 current=false;child.emit('message',{type:'arcane-diagnostic-report',protocolVersion:1,requestId:randomUUID(),event:input()});await new Promise(done=>setImmediate(done));
 assert.equal(acks.length,1);assert.equal(f.host.list().events.length,1);detach();assert.equal(child.listenerCount('message'),0);
});
test('an account switch while identity is being verified cannot bind later reports to the previous account',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});
 const f=await fixture(t,{allowedOrigins:[base],fetch:async()=>{await held;return Response.json({accountId:'acct_'+'a'.repeat(32)});}});
 f.current({base,token:'arc_'+'a'.repeat(43)});const refreshing=f.host.refresh();await Promise.resolve();
 f.current({base,token:'arc_'+'b'.repeat(43)});release();assert.equal((await refreshing).state,'unavailable');assert.equal((await f.host.report(input())).state,'local-only');
});
test('local support reads and offline flush prune expired reports without making a request',async t=>{
 let clock=now;const f=await fixture(t,{now:()=>clock});await f.host.report(input());clock+=30*86400000+1;
 assert.equal(f.host.list().events.length,0);await f.host.report({...input(),occurredAt:clock});clock+=30*86400000+1;
 assert.equal((await f.host.flush()).state,'disabled');assert.equal(f.host.list().events.length,0);assert.equal(f.calls.length,0);
});

test('closed staging context survives encrypted local outbox and host reload without account or remote delivery',async t=>{
 const f=await fixture(t),event={...input(),component:'studio',stage:'studio-import',code:'STUDIO_STAGE_CONTINUITY',context:{stagingPhase:'packet-receipt',stagingReason:'proof-expired',packetOrdinal:12}};
 assert.deepEqual(await f.host.report(event),{stored:true,eventId:event.eventId,state:'local-only'});
 assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM diagnostic_outbox').all()),/STUDIO_STAGE_CONTINUITY|packet-receipt|proof-expired/);
 assert.equal(await f.host.close(),true);const next=await createDiagnosticsHost(f.opts);t.after(()=>next.close());
 const rows=next.list().events;assert.equal(rows.length,1);assert.equal(rows[0].event.code,'STUDIO_STAGE_CONTINUITY');assert.deepEqual(rows[0].event.context,event.context);assert.equal(rows[0].state,'local-only');
 assert.equal((await next.flush()).state,'disabled');assert.equal(f.calls.length,0,'An encrypted local record does not claim configured hosted delivery.');
});

test('actual child staging acknowledgements reflect successful versus rejected SQLite storage', {timeout:5000}, async t=>{
 const f=await fixture(t),child=new EventEmitter(),acks=[];let acceptAck;child.connected=true;
 child.send=(value,callback)=>{acks.push(value);acceptAck?.(value);callback(null);return true;};
 const detach=f.host.attach(child,()=>true);t.after(detach);
 const event=()=>({...input(),component:'studio',stage:'studio-import',code:'STUDIO_STAGE_CONTINUITY',context:{stagingPhase:'seal-check',stagingReason:'edit-epoch-changed'}});
 const emit=async value=>{const pending=new Promise(resolve=>{acceptAck=resolve;});child.emit('message',{type:'arcane-diagnostic-report',protocolVersion:1,requestId:randomUUID(),event:value});return pending;};
 const first=event(),stored=await emit(first);assert.equal(stored.stored,true);assert.equal(stored.eventId,first.eventId);assert.equal(f.host.list().events.length,1);
 f.db.exec("CREATE TRIGGER reject_staging_diagnostic BEFORE INSERT ON diagnostic_outbox BEGIN SELECT RAISE(ABORT,'controlled write refusal'); END;");
 const rejected=await emit(event());assert.equal(rejected.stored,false);assert.equal(f.host.list().events.length,1);assert.equal(acks.length,2);
 const invalid={...event(),context:{stagingPhase:'packet-receipt',stagingReason:'proof-expired',packetOrdinal:512}};
 assert.deepEqual(await f.host.report(invalid),{stored:false,state:'unavailable'});assert.equal(f.host.list().events.length,1);assert.equal(f.calls.length,0);
});


test('closed native-frame evidence survives encrypted local reload without remote configuration or replay',async t=>{
 const f=await fixture(t),context={operationId:randomUUID(),nativeFrameDirection:'inbound',nativeFramePhase:'discovery-inventory',
  nativeFrameByteKind:'at-least',nativeFrameBytes:1048577,nativeFrameLimit:1048576,nativeFramePendingMask:512,nativeFramePendingCount:1};
 const event={...input(),component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',context};
 assert.deepEqual(await f.host.report(event),{stored:true,eventId:event.eventId,state:'local-only'});
 const raw=JSON.stringify(f.db.prepare('SELECT * FROM diagnostic_outbox').all());
 assert.ok(!raw.includes(context.operationId));assert.doesNotMatch(raw,/NATIVE_FRAME_LIMIT|discovery-inventory/);
 assert.equal(await f.host.close(),true);const next=await createDiagnosticsHost(f.opts);t.after(()=>next.close());
 const rows=next.list().events;assert.equal(rows.length,1);assert.equal(rows[0].event.code,'NATIVE_FRAME_LIMIT');assert.deepEqual(rows[0].event.context,context);
 assert.equal((await next.flush()).state,'disabled');assert.equal(f.calls.length,0);
 for(const bad of [{...event,component:'studio'},{...event,context:{...context,server:'private'}},
  {...event,context:{...context,nativeFramePendingMask:1024}},{...event,context:{...context,nativeFrameByteKind:'exact'}}])
  assert.deepEqual(await next.report({...bad,eventId:randomUUID()}),{stored:false,state:'unavailable'});
 assert.equal(next.list().events.length,1);assert.equal(f.calls.length,0);
});
