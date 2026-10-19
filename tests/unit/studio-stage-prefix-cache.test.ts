import test from 'node:test';
import assert from 'node:assert/strict';
import crypto,{randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import {canonical} from '../../packages/core/src/studio-policy.js';
import type {StudioAssetStageArgs,StudioCommand} from '../../packages/protocol/src/studio.js';

// Real disposable SQLite histories and synthetic paired ACKs. The hash spy is
// test-local builtin instrumentation; production has no observer/verification port.
const projectId='a'.repeat(64),modelReview={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:'9'.repeat(64),revision:1},guard=()=>{};
const sha=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t:test.TestContext){
 const directory=mkdtempSync(join(tmpdir(),'arcane-prefix-cache-'));let store=new StudioStore({directory});
 const bind=()=>store.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,modelReview);});bind();
 const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet'],identity:{clientSessionId:'prefix-plugin',pluginVersion:'0.1.9',name:'Prefix fixture',placeId:12,universeId:34}});
 const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'prefix-plugin',pluginArtifactHash:'b'.repeat(64),markerName:'ArcaneTestProof_prefix',placeId:12,universeId:34,placeName:'Prefix fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});store.poll(pair.sessionId,proof());
 t.after(()=>{store.close();const part=relative(tmpdir(),directory);assert.ok(part.startsWith('arcane-prefix-cache-')&&!part.includes('..')&&!isAbsolute(part));rmSync(directory,{recursive:true,force:true});});
 function plan(count=3,padding=1024){
  const jobId=randomUUID(),marker='memo-content-'+jobId,expected={digest:'c'.repeat(64),payloadDigest:'d'.repeat(64),manifestDigest:'e'.repeat(64)},target:StudioAssetStageArgs['target']={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace',parentRef:'prefix-parent',creator:{kind:'group',id:'56'}},continuity={clientLifetimeId:'prefix-plugin',pluginArtifactHash:'b'.repeat(64),playEpoch:0};
  const args:StudioAssetStageArgs[]=Array.from({length:count},(_,ordinal)=>({expected,target,continuity,packet:JSON.stringify({formatVersion:1,ordinal,kind:ordinal===0?'begin':ordinal===count-1?'seal':'chunk',payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,padding:marker+'x'.repeat(padding)})}));
  let bytes=0;const intent:StageRunIntent={projectId,jobId,conversation:{provider:'codex',threadId:'prefix-fixture',sessionId:null},modelReview,...{transferDigest:expected.digest,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest},preparedDigest:'f'.repeat(64),target,continuity,plan:args.map((a,ordinal)=>{const packetByteLength=Buffer.byteLength(a.packet);bytes+=packetByteLength;return {ordinal,argsSha256:sha(JSON.stringify(a)),packetByteLength,envelopeByteLength:Buffer.byteLength(JSON.stringify(a)),expectedReceipt:{transferDigest:expected.digest,packetCount:ordinal+1,byteLength:bytes,state:ordinal===count-1?'sealed':'receiving',engineVerification:'pending'}};})};
  const begin=store.beginStageRun(intent,guard);assert.ok(begin.created);
  return {jobId,marker,args,intent,begin,ids:[] as string[]};
 }
 function append(p:ReturnType<typeof plan>,ordinal:number){const c=store.enqueueStagePacket(p.begin.handle,ordinal,p.args[ordinal]!,guard);assert.equal(store.poll(pair.sessionId,proof())[0]?.id,c.id);store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:p.intent.plan[ordinal]!.expectedReceipt});p.ids.push(c.id);return c;}
 return {directory,pair,plan,append,get store(){return store;},read(p:ReturnType<typeof plan>){return store.readStageRun(projectId,p.jobId)!;},restart(){store.close();store=new StudioStore({directory});bind();}};
}
function hashSpy(t:test.TestContext,marker:string){
 let calls=0,bytes=0;const original=crypto.createHash;
 const mock=t.mock.method(crypto,'createHash',(...args:Parameters<typeof crypto.createHash>)=>{
  const value=original(...args),update=value.update.bind(value);
  t.mock.method(value,'update',(...parts:Parameters<typeof value.update>)=>{if(typeof parts[0]==='string'&&parts[0].includes(marker)){calls++;bytes+=Buffer.byteLength(parts[0]);}return Reflect.apply(update,value,parts);});return value;
 });syncBuiltinESMExports();
 return {get calls(){return calls;},get bytes(){return bytes;},reset(){calls=0;bytes=0;},restore(){mock.mock.restore();syncBuiltinESMExports();}};
}

test('warm exact rows reuse only hashes while returned commands stay detached and freshly parsed',t=>{
 const f=fixture(t),p=f.plan();f.append(p,0);f.append(p,1);f.plan();const spy=hashSpy(t,p.marker);
 try{f.read(p);assert.equal(spy.calls,4);spy.reset();const current=f.read(p);assert.equal(spy.calls,0);current.commands[0]!.command.args.packet='caller changed';current.commands[0]!.command.result=null;current.intent.plan[0]!.argsSha256='0'.repeat(64);const next=f.read(p);assert.equal(spy.calls,0);assert.equal(next.commands[0]!.command.args.packet,p.args[0]!.packet);assert.deepEqual(next.commands[0]!.command.result,p.intent.plan[0]!.expectedReceipt);t.diagnostic(JSON.stringify({coldContentHashes:4,warmContentHashes:spy.calls,returnedRecord:'fresh detached parse'}));}finally{spy.restore();}
});

for(const mutation of ['args','args-and-fingerprint','member','fingerprint','state','lease','request','method'] as const)test('warmed earlier packet refuses persisted '+mutation+' tamper',t=>{
 const f=fixture(t),p=f.plan();f.append(p,0);f.append(p,1);f.read(p);f.read(p);
 const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
 try{
  const id=p.ids[0]!,row=db.prepare('SELECT * FROM commands WHERE id=?').get(id)!,c=JSON.parse(row.payload as string) as StudioCommand;
  if(mutation==='member')db.prepare('UPDATE asset_stage_attempt_commands SET fingerprint=? WHERE command_id=?').run('0'.repeat(64),id);
  else if(mutation==='fingerprint')db.prepare('UPDATE commands SET fingerprint=? WHERE id=?').run('0'.repeat(64),id);
  else if(mutation==='state')db.prepare('UPDATE commands SET state=? WHERE id=?').run('queued',id);
  else{
   if(mutation==='args'||mutation==='args-and-fingerprint')c.args.packet=(c.args.packet as string).replace('memo-content-','Memo-content-');
   if(mutation==='lease')c.leaseEpoch++;
   if(mutation==='request')c.requestId='foreign-request';
   if(mutation==='method')c.method='scene.import_context';
   const fingerprint=mutation==='args-and-fingerprint'?sha(canonical({sessionId:c.sessionId,method:c.method,args:c.args})):row.fingerprint;
   db.prepare('UPDATE commands SET payload=?,fingerprint=? WHERE id=?').run(JSON.stringify(c),fingerprint as string,id);
   if(mutation==='args-and-fingerprint')db.prepare('UPDATE asset_stage_attempt_commands SET fingerprint=? WHERE command_id=?').run(fingerprint as string,id);
  }
  assert.throws(()=>f.read(p),{code:'STUDIO_STAGE_RECEIPT'});assert.throws(()=>f.store.enqueueStagePacket(p.begin.handle,2,p.args[2]!,guard));
  assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get()?.n,2);
 }finally{db.close();}
});

test('an external payload write between snapshot and fingerprint reads cannot poison the next cached hash',t=>{
 const f=fixture(t),p=f.plan();f.append(p,0);f.append(p,1);f.read(p);const db=new DatabaseSync(join(f.directory,'studio.sqlite')),internal=(f.store as unknown as {db:DatabaseSync}).db,prepare=internal.prepare.bind(internal);let changed=false;
 const c=JSON.parse(db.prepare('SELECT payload FROM commands WHERE id=?').get(p.ids[0]!)!.payload as string) as StudioCommand;c.args.packet=(c.args.packet as string).replace('memo-content-','Memo-content-');
 t.mock.method(internal,'prepare',(sql:string)=>{const statement=prepare(sql);if(sql==='SELECT fingerprint,state FROM commands WHERE id=?'){const get=statement.get.bind(statement);t.mock.method(statement,'get',(...args:Parameters<typeof statement.get>)=>{if(!changed&&(args as unknown[])[0]===p.ids[0]){changed=true;db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(c),p.ids[0]!);}return Reflect.apply(get,statement,args);});}return statement;});
 try{f.read(p);assert.equal(changed,true);assert.throws(()=>f.read(p),{code:'STUDIO_STAGE_RECEIPT'});}finally{db.close();}
});

test('receipt and unknown state remain fresh on a hash hit, never become a sealed receipt',t=>{
 const f=fixture(t),p=f.plan();f.append(p,0);f.append(p,1);f.read(p);const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
 try{const c=JSON.parse(db.prepare('SELECT payload FROM commands WHERE id=?').get(p.ids[0]!)!.payload as string) as StudioCommand;c.result={...p.intent.plan[0]!.expectedReceipt,byteLength:p.intent.plan[0]!.expectedReceipt.byteLength+1};db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(c),c.id);assert.equal(f.read(p).phase,'needs_reconciliation');assert.equal(f.read(p).receipt,null);assert.throws(()=>f.store.enqueueStagePacket(p.begin.handle,2,p.args[2]!,guard),{code:'STUDIO_STAGE_STATE'});
 c.state='needs_reconciliation';db.prepare('UPDATE commands SET payload=?,state=? WHERE id=?').run(JSON.stringify(c),c.state,c.id);assert.equal(f.read(p).phase,'needs_reconciliation');assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get()?.n,2);
 }finally{db.close();}
});

test('rollback clears warm hashes; switching runs evicts the prior run without refusing either history',t=>{
 const f=fixture(t),p=f.plan();f.append(p,0);f.append(p,1);f.read(p);const spy=hashSpy(t,p.marker),db=new DatabaseSync(join(f.directory,'studio.sqlite'));
 try{
  f.read(p);assert.equal(spy.calls,0);db.exec("CREATE TRIGGER fixture_prefix_rollback BEFORE INSERT ON asset_stage_attempt_commands BEGIN SELECT RAISE(ABORT,'prefix rollback'); END;");assert.throws(()=>f.store.enqueueStagePacket(p.begin.handle,2,p.args[2]!,guard),/prefix rollback/);db.exec('DROP TRIGGER fixture_prefix_rollback');spy.reset();f.read(p);assert.equal(spy.calls,4);spy.reset();f.read(p);assert.equal(spy.calls,0);
  const q=f.plan();f.append(q,0);spy.reset();f.read(p);assert.equal(spy.calls,4);spy.reset();f.read(p);assert.equal(spy.calls,0);
 }finally{spy.restore();db.close();}
});

test('closing and restarting preserve original receipts but never preserve a cached authority or handle',t=>{
 const f=fixture(t),p=f.plan(2);f.append(p,0);f.append(p,1);f.read(p);const spy=hashSpy(t,p.marker);
 try{f.store.closeStageRun(p.begin.handle);spy.reset();const closed=f.read(p);assert.equal(closed.phase,'cpu-staged');assert.equal(spy.calls,4);f.restart();spy.reset();assert.equal(f.read(p).phase,'cpu-staged');assert.equal(spy.calls,4);assert.throws(()=>f.store.enqueueStagePacket(p.begin.handle,0,p.args[0]!,guard),{code:'STUDIO_STAGE_HANDLE'});assert.equal(f.store.commands().length,2);}finally{spy.restore();}
});

test('expiry still mutates the original queued command and its pre-expiry raw string is never memoized',t=>{
 const f=fixture(t),p=f.plan(),c=f.store.enqueueStagePacket(p.begin.handle,0,p.args[0]!,guard);f.read(p);
 const db=new DatabaseSync(join(f.directory,'studio.sqlite')),stored=JSON.parse(db.prepare('SELECT payload FROM commands WHERE id=?').get(c.id)!.payload as string) as StudioCommand;
 stored.expiresAt='2000-01-01T00:00:00.000Z';db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(stored),c.id);db.close();
 const spy=hashSpy(t,p.marker);
 try{const expired=f.read(p);assert.equal(expired.commands[0]!.command.state,'cancelled');assert.equal(expired.phase,'stopped');assert.equal(spy.calls,2);spy.reset();assert.equal(f.read(p).commands[0]!.command.id,c.id);assert.equal(spy.calls,2,'the expiry path cannot pin old raw to a re-read/mutated record');spy.reset();f.read(p);assert.equal(spy.calls,0);assert.deepEqual(f.store.poll(f.pair.sessionId),[]);}finally{spy.restore();}
});

test('UTF16 byte-budget eviction is a verified cold path for a valid bounded synthetic durable history',t=>{
 const f=fixture(t),p=f.plan(170,200*1024),db=new DatabaseSync(join(f.directory,'studio.sqlite')),session=f.store.session(f.pair.sessionId),at=new Date().toISOString();
 // Deliberately synthesize HISTORY, not host/engine admission. beginStageRun
 // validates the actual bounded plan; every stored row is then independently
 // checked by the public historical reader. No plugin effect is dispatched.
 try{db.exec('BEGIN IMMEDIATE');for(const [ordinal,args]of p.args.entries()){
  const id=randomUUID(),requestId='history_'+ordinal+'_'+randomUUID(),fingerprint=sha(canonical({sessionId:session.id,method:'asset.stage_packet',args}));
  const c:StudioCommand={protocolVersion:1,id,requestId,sessionId:session.id,clientSessionId:session.clientSessionId,method:'asset.stage_packet',args:args as unknown as StudioCommand['args'],allowedRoots:session.allowedRoots,allowWrites:session.allowWrites,leaseEpoch:ordinal+1,expiresAt:new Date(Date.now()+180000).toISOString(),state:'succeeded',createdAt:at,finishedAt:at,result:p.intent.plan[ordinal]!.expectedReceipt as unknown as StudioCommand['result'],error:null};
  db.prepare('INSERT INTO commands(id,request_id,session_id,fingerprint,state,payload,created) VALUES(?,?,?,?,?,?,?)').run(id,requestId,session.id,fingerprint,c.state,JSON.stringify(c),Date.now());db.prepare('INSERT INTO asset_stage_attempt_commands VALUES(?,?,?,?,?,?)').run(p.begin.runId,ordinal,id,requestId,c.leaseEpoch,fingerprint);
 }db.exec('COMMIT');}finally{db.close();}
 const spy=hashSpy(t,p.marker);
 try{const first=f.read(p);assert.equal(first.phase,'cpu-staged');assert.equal(first.commands.length,170);spy.reset();const second=f.read(p);assert.equal(second.phase,'cpu-staged');assert.ok(spy.calls>0,'old entries must actually evict above64MiB UTF16+headers');assert.deepEqual(second.receipt,first.receipt);t.diagnostic(JSON.stringify({historyPackets:170,rawPlanBytes:p.intent.plan.reduce((n,x)=>n+x.packetByteLength,0),minimumUtf16Bytes:2*p.args.reduce((n,x)=>n+JSON.stringify(x).length,0),contentHashCallsAfterEviction:spy.calls}));}finally{spy.restore();}
});
