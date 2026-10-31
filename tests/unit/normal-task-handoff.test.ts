import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {createCodexService} from '../../apps/daemon/src/codex-service.js';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';
import type {NativeTaskContinuation} from '../../packages/codex-client/src/types.js';
import {createNativeAssetRegistry,acquireNativeAssetWork,assertNativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {WorkStore} from '../../packages/storage/src/work-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {createAssetService} from '../../apps/daemon/src/asset-service.js';
import {createAssetReviewHost} from '../../apps/daemon/src/asset-review-host.js';
import {assetReviewCanonical,type AssetReviewReceiptAuthority} from '../../apps/daemon/src/asset-review.js';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {createStudioImportHost} from '../../apps/daemon/src/studio-import-host.js';
import {createStudioImportPreparationStore} from '../../apps/daemon/src/studio-import-preparation-store.js';
import {READ_METHODS,WRITE_METHODS,ASSET_STAGE_METHODS} from '../../packages/protocol/src/studio.js';
import {ChatTaskCoordinator,type ChatTaskOwner} from '../../apps/daemon/src/chat-task-coordinator.js';
import type {Snapshot} from '../../packages/codex-client/src/types.js';

const THREAD='handoff.thread',SESSION='handoff.session',JOB='11111111-1111-4111-8111-111111111111',PLUGIN='a'.repeat(64);
const ORIGIN='http://127.0.0.1:12345',AUTH={controlToken:'handoff-human-fixture',agentToken:'handoff-agent-fixture',origin:ORIGIN};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
function humanRequest(){const request=new IncomingMessage(new Socket());request.method='POST';request.headers={host:new URL(ORIGIN).host,origin:ORIGIN,authorization:'Bearer '+AUTH.controlToken,'content-type':'application/json'};
  request.rawHeaders=['Host',new URL(ORIGIN).host,'Origin',ORIGIN,'Authorization','Bearer '+AUTH.controlToken,'Content-Type','application/json'];return request;}
// Actual main session/transport/service/coordinator/SQLite/file readers. Proposal
// suggestions and authenticated plugin read results are controlled fixture data;
// no provider inference, worker/native artifact proof, Keep upload or Studio runs.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let turns=0,currentThread=s.thread;
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),{id,method,params={}}=m;appendFileSync(audit,JSON.stringify({process:s.index,...m})+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:s.email,planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]}],nextCursor:null});
 if(method==='thread/start'||method==='thread/resume'){currentThread=params.threadId??s.thread;return reply(id,{thread:{id:currentThread,sessionId:'handoff.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});}
 if(method==='mcpServerStatus/list')return reply(id,{data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(n=>[n,{}]))}],nextCursor:null});
 if(method==='turn/start'){turns++;const turn={id:'handoff.turn:'+s.index+':'+turns,status:turns===1?'inProgress':'completed'};reply(id,{turn});
  if(turns===1){const timer=setInterval(()=>{if(existsSync(s.finish)){clearInterval(timer);send({method:'turn/completed',params:{threadId:currentThread,turn:{...turn,status:'completed'}}});}},5);}return;}
 if(method==='turn/interrupt')return reply(id,{});
});`;
type Wire={process:number;method?:string;params?:Record<string,unknown>};
async function fixture(t:test.TestContext,options:{planning?:boolean;closeFailure?:{value:unknown};newThread?:(index:number)=>string;email?:(index:number)=>string}={}){
  const started=Date.now();
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-normal-handoff-'))),project=join(root,'project');await mkdir(project);
  const projectPath=await realpath(project),registry=createNativeAssetRegistry({projectPath}),work=new WorkStore({directory:join(root,'work'),projectPath});
  const associations=new ConversationWorkStore({directory:join(root,'associations'),projectPath}),conversation={provider:'codex' as const,threadId:THREAD,sessionId:SESSION};
  associations.bind({conversation,kind:'asset-job',id:JOB});
  const output=join(root,'outputs');await mkdir(join(output,'test-kit-'+JOB),{recursive:true});await saveStudioFixture(join(output,'test-kit-'+JOB),JOB);
  const events:string[]=[],tokens:string[]=[],clients:CodexSession[]=[],normalEntered:ReturnType<typeof gate>[]=[],normalJoined:Promise<void>[]=[];
  const audit=join(root,'wire.jsonl');let expectedClose:{value:unknown}|null=null,proposalClosed=0;
  const service=createCodexService({directory:join(root,'codex'),projectPath,assetRegistry:registry,workStore:work,automaticTaskPlanning:options.planning!==false,
    proposalWorker:async input=>{input.owner.assertActive();return{async propose(){input.owner.assertActive();return{threadId:'controlled-proposal',sessionId:null,turnId:randomUUID(),text:'A bounded controlled suggestion; not native evidence.'};},async close(){proposalClosed++;}};},
    connect:async hooks=>{
      assert.ok(hooks);const index=clients.length;events.push('connect:'+index);tokens.push(hooks.finalCredential());const entered=gate();normalEntered.push(entered);
      class ObservedSession extends CodexSession {
        override retireManagedTask(token:NativeTaskContinuation):Promise<void>{
          const original=super.retireManagedTask(token);normalJoined[index]=original;entered.resolve();events.push('normal:'+index);return original;
        }
        override close():Promise<void>{
          events.push('close:'+index);const original=super.close();
          return original.then(()=>{if(options.closeFailure&&index===0)throw options.closeFailure.value;});
        }
      }
      const client=new ObservedSession({command:process.execPath,args:['-e',PEER,JSON.stringify({index,tools:ARCANE_NATIVE_TOOL_NAMES,finish:join(root,'finish-'+index),thread:options.newThread?.(index)??THREAD,email:options.email?.(index)??'handoff@example.invalid'}),audit],cwd:projectPath,env:nativeEnvironment()},
        limits({requestTimeoutMs:2500}),'spawned-node-fixture','arcane-only',hooks);
      clients.push(client);await client.initialize();return client;
    }});
  service.attachPlaytestCancellation(Object.freeze({async cancelExact(){assert.fail('No fixture verification job allocated.');},async revalidateExact(){return'current' as const;}}));
  let requestContextPoll=()=>{};
  const queuedContextIds=new Set<string>(),completedContextIds=new Set<string>();
  class ControlledStudioStore extends StudioStore {
    override enqueue(...input:Parameters<StudioStore['enqueue']>) {
      const command=super.enqueue(...input);
      if(command.method==='scene.import_context'){queuedContextIds.add(command.id);requestContextPoll();}
      return command;
    }
  }
  const studio=new ControlledStudioStore({directory:join(root,'studio')}),grant=studio.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=studio.pair({code:grant.code,protocolVersion:1,capabilities:[...READ_METHODS,...WRITE_METHODS,...ASSET_STAGE_METHODS],identity:{clientSessionId:'handoff-plugin',pluginVersion:'0.1.9',name:'Controlled import target',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'handoff-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_handoff',placeId:12,universeId:34,placeName:'Controlled import target',mode:'Edit' as const,playEpoch:0,continuitySupported:true,connected:true});
  studio.poll(pair.sessionId,proof());
  const parent={instanceId:'handoff-workspace',sessionId:pair.sessionId,root:'Workspace' as const,pathSegments:[],className:'Workspace'};
  const context={sessionId:pair.sessionId,root:'Workspace' as const,parentRef:parent,placeId:12,universeId:34,mode:'Edit' as const,modeProvenance:'StudioTestService.EditModeActive' as const,
    creator:{status:'available' as const,kind:'group' as const,id:56,provenance:'game.CreatorType/CreatorId' as const},studioUser:{status:'not_applicable' as const,id:null,provenance:'StudioService:GetUserId' as const}};
  const preparation=await createStudioImportPreparationStore({projectPath,directory:join(root,'preparations'),workAssociations:associations,studio});
  const importHost=createStudioImportHost({projectPath,workAssociations:associations,studio,pluginArtifactHash:PLUGIN,persistPreparation:(...args)=>preparation.save(...args)});
  const privateDirectory=join(root,'private');await mkdir(privateDirectory,{mode:0o700});
  const sign=(value:unknown)=>createHmac('sha256','controlled-handoff-human-review').update(assetReviewCanonical(value)).digest('hex');
  const authority:AssetReviewReceiptAuthority={directory:privateDirectory,sign,verify:(value,digest)=>sign(value)===digest,withSnapshot:evaluate=>evaluate(),close(){}};
  let assets!:Awaited<ReturnType<typeof createAssetService>>,selection:object={};
  const reviews=createAssetReviewHost({directory:root,projectPath,workAssociations:associations,receiptAuthority:authority,selectionEpoch:()=>selection,
    bindingHuman(jobId){const current=service.state().nativeHistory,binding=associations.binding('asset-job',jobId);return current?.threadId===THREAD&&current.sessionId===SESSION?binding:null;},
    readSubject:(jobId,scope,guard)=>assets.modelReviewSubject(jobId,scope,guard)});
  assets=await createAssetService({cwd:root,projectPath,outputRoot:output,studioImport:importHost.hooks,modelReview:reviews});
  const errors:unknown[]=[];
  const pollContext=()=>{try{for(const command of studio.poll(pair.sessionId,proof())){
    assert.equal(command.method,'scene.import_context');studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:context});
    assert.equal(studio.command(command.id).state,'succeeded');completedContextIds.add(command.id);
  }}catch(error){errors.push(error);}};
  // Match the plugin's 2s heartbeat inside the unchanged 6s proof lifetime.
  // Real enqueue schedules the controlled response; avoid FULL-sync empty polls
  // every 10ms competing with the actual retained-file and review validation.
  let contextPoll:ReturnType<typeof setImmediate>|null=null;
  requestContextPoll=()=>{if(!contextPoll)contextPoll=setImmediate(()=>{contextPoll=null;pollContext();});};
  const pump=setInterval(pollContext,2000);
  t.after(async()=>{clearInterval(pump);if(contextPoll)clearImmediate(contextPoll);requestContextPoll=()=>{};try{
    if(expectedClose)await assert.rejects(service.close(),error=>Object.is(error,expectedClose!.value));else await service.close();
  }finally{importHost.close();await assets.close();await preparation.close();reviews.close();registry.close();work.close();associations.close();studio.close();
    const part=relative(boundary,root);assert.ok(part.startsWith('arcane-normal-handoff-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);assert.deepEqual(completedContextIds,queuedContextIds);}});
  const action=(action:string,fields:Record<string,unknown>={})=>service.action({requestId:randomUUID(),connectionId:action==='connect'?null:service.state().snapshot!.connectionId,action,...fields});
  const ready=async()=>{for(const [name,fields]of [['connect',{}],['select',{model:'fixture',effort:'low'}],['thread-start',{}]]as const)assert.equal((await action(name,fields)).record.state,'acknowledged');};
  const send=(text='Original task')=>action('turn-start',{threadId:service.state().snapshot!.thread!.threadId,text,allowAssets:true,allowWorkspaceWrites:true});
  const wire=async():Promise<Wire[]>=>{const text=await readFile(audit,'utf8'),end=text.lastIndexOf('\n');return end<0?[]:text.slice(0,end).split('\n').map(line=>JSON.parse(line)as Wire);};
  const actor=(index:number)=>registry.capture(tokens[index]!,'mutate');
  const currentTask=()=>service.state().chatTasks!.at(-1)!;
  const waitNormal=async(index:number)=>{
    t.diagnostic('Handoff '+(Date.now()-started)+'ms: waiting for normal entry '+index);
    await normalEntered[index]!.promise;
    t.diagnostic('Handoff '+(Date.now()-started)+'ms: waiting for original session join '+index);
    await normalJoined[index];
    t.diagnostic('Handoff '+(Date.now()-started)+'ms: waiting for host retained projection '+index);
    // The session join precedes the host's asset join and cached normal state.
    // Observe that complete original host handoff rather than one producer tail.
    await until(()=>!registry.recognizes(tokens[index]!)&&service.state().chatTasks!.some(row=>row.connectionId===clients[index]!.snapshot().connectionId&&row.retained===true));
    t.diagnostic('Handoff '+(Date.now()-started)+'ms: original host handoff complete '+index);
  };
  const finish=(index:number)=>writeFile(join(root,'finish-'+index),'complete',{flag:'wx'});
  const plan=(taskId:string)=>service.taskPlan({connectionId:service.state().snapshot!.connectionId,threadId:THREAD,taskId});
  const until=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+6000;while(!await check()){assert.ok(Date.now()<deadline,'Actual handoff fixture event missing.');assert.deepEqual(errors,[]);await delay(5);}};
  return{root,project:projectPath,registry,work,associations,service,clients,tokens,events,normalEntered,waitNormal,ready,send,action,actor,currentTask,finish,wire,plan,until,assets,reviews,
    proposalClosed:()=>proposalClosed,expectClose:(value:unknown)=>{expectedClose={value};},
    scope:{projectId:associations.projectId,conversation},
    openReview:()=>reviews.prepare({jobId:JOB},humanRequest(),AUTH),
    readReview:()=>reviews.status({jobId:JOB},humanRequest(),AUTH),
    async approveModel(opened:Awaited<ReturnType<typeof reviews.prepare>>){assert.ok(opened.review);assert.ok(opened.openWitness);
      return reviews.decide({reviewId:opened.review.reviewId,decision:'approved',idempotencyKey:randomUUID(),openWitness:opened.openWitness},humanRequest(),AUTH);},
    async approveWork(runId:string){for(const task of work.runById(runId).tasks){const claimed=work.claim({taskId:task.id,worker:'controlled evidence submitter'}),path='evidence-'+task.key+'.txt';
      await writeFile(join(projectPath,path),'actual evidence '+task.key);work.submit({taskId:task.id,leaseToken:claimed.leaseToken,evidence:[{path,note:'Controlled actual file'}]});work.review({taskId:task.id,approved:true,note:'Controlled genuine human review path'});}},
  };
}

test('normal plan/asset handoff retains human review and fresh same-chat Send without cancelling original work',{timeout:20000},async t=>{
  const body=gate(),cleanup=gate(),inCleanup=gate();let run:Promise<void>|null=null,stage='fixture allocation';
  const started=Date.now(),enter=(next:string)=>{stage=next;t.diagnostic('Handoff '+(Date.now()-started)+'ms: '+stage);};
  // Release only the test-owned holds before fixture shutdown, including after
  // an assertion failure. Otherwise teardown can hide the original failure by
  // joining work whose release sits later in this same failed test body.
  t.after(async()=>{t.diagnostic('Handoff teardown stage: '+stage);body.resolve();cleanup.resolve();if(run)await run;});
  const f=await fixture(t);await f.ready();await f.send();const a=f.currentTask().taskId,old=f.actor(0),lease=acquireNativeAssetWork(old,'generation');
  run=lease.run(async()=>{await body.promise;await writeFile(join(f.project,'asset-final-write.txt'),'retained original');inCleanup.resolve();await cleanup.promise;f.events.push('asset-closed');});lease.finish('closed');
  stage='original model review';
  const pendingReview=await f.openReview();assert.equal(pendingReview.review!.status,'pending');
  stage='original native terminal and normal retirement entry';
  await f.finish(0);await f.normalEntered[0]!.promise;assert.equal(lease.signal.aborted,false);assert.equal(f.registry.recognizes(f.tokens[0]!),false);
  stage='following Send and original asset cleanup';
  const b=f.send('Following task');body.resolve();await inCleanup.promise;assert.equal(lease.signal.aborted,false);cleanup.resolve();await run;
  stage='following native acknowledgement';
  assert.equal((await b).record.state,'acknowledged');assert.equal(f.clients.length,2);
  assert.ok(f.events.indexOf('close:0')>f.events.indexOf('asset-closed'));assert.equal(lease.signal.aborted,false);
  assert.throws(()=>assertNativeAssetActor(old,'mutate'),{code:'NATIVE_ASSET_AUTHORITY'});assertNativeAssetActor(f.actor(1),'mutate');
  enter('read retained original plan before evidence submission');
  const prior=await f.plan(a);assert.equal(prior.plan!.state,'awaiting_review');assert.equal(prior.plan!.review!.state,'pending_submission');
  enter('submit and approve original work evidence');
  await f.approveWork(prior.plan!.review!.runId!);
  enter('read retained original plan after evidence approval');
  assert.equal((await f.plan(a)).plan!.review!.state,'accepted');
  enter('read pending model review after work approval');
  const stillPending=await f.readReview();assert.equal(stillPending.review!.status,'pending','Work approval cannot approve a model.');
  enter('prepare Studio import metadata through controlled context pump');
  const metadata=await f.assets.prepareStudioImport(JOB,f.actor(1));assert.equal(metadata.status,'prepared');
  enter('read pending model review after metadata preparation');
  assert.equal((await f.readReview()).review!.status,'pending','Metadata preparation cannot approve a model or authorize native payload staging.');
  enter('refuse payload preparation before model approval');
  await assert.rejects(f.assets.prepareStudioImportPayload(JOB,f.actor(1)),{code:'ASSET_REVIEW_REQUIRED'});
  enter('approve originally opened model review through human receipt');
  // Decide freshly verifies the subject and human scope. Keep the original
  // opening across task retirement instead of replacing its witness here.
  await f.approveModel(pendingReview);
  enter('prepare approved import payload through controlled context pump');
  const {prepared}=await f.assets.prepareStudioImportPayload(JOB,f.actor(1));assert.equal(prepared.status,'prepared');assert.equal(prepared.manifest.revisionId,JOB);
  enter('refuse payload preparation by retired original actor');
  await assert.rejects(f.assets.prepareStudioImportPayload(JOB,old),{code:'NATIVE_ASSET_AUTHORITY'});
  enter('mutate original evidence after human review');
  await writeFile(join(f.project,'evidence-implementation.txt'),'changed after human review');
  enter('read original plan with changed evidence');
  assert.equal((await f.plan(a)).plan!.review!.state,'unavailable');
  enter('following terminal signal');
  const bId=f.currentTask().taskId;await f.finish(1);enter('following normal retirement');await f.waitNormal(1);
  enter('third native acknowledgement');assert.equal((await f.send('Third task')).record.state,'acknowledged');
  assert.equal((await f.plan(a)).plan!.state,'awaiting_review');assert.equal((await f.plan(bId)).plan!.state,'awaiting_review');
  assert.equal(f.events.filter(value=>value==='close:0').length,1);assert.equal(f.events.filter(value=>value==='close:1').length,1);
  stage='all semantic assertions completed';
});

test('Stop during the original normal asset join aborts it once and suppresses a waiting fresh Send',{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false});await f.ready();await f.send();const id=f.currentTask().taskId,lease=acquireNativeAssetWork(f.actor(0),'generation'),aborted=gate();let releases=0;
  const run=lease.run(()=>new Promise<void>(resolve=>lease.signal.addEventListener('abort',()=>{releases++;aborted.resolve();resolve();},{once:true})));lease.finish('closed');
  await f.finish(0);await f.normalEntered[0]!.promise;const waiting=f.send('Must not dispatch');
  const stopped=await f.action('task-stop',{threadId:THREAD,taskId:id});await aborted.promise;await run;
  assert.equal(stopped.record.state,'acknowledged');assert.equal((await waiting).record.errorCode,'STALE_CONNECTION');
  assert.equal(releases,1);assert.equal(f.clients.length,1);assert.equal(f.events.filter(value=>value==='close:0').length,1);
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('local model selection during a pending normal join preserves original accepted work and the next Send choice',{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false});await f.ready();await f.send();
  const original=f.actor(0),lease=acquireNativeAssetWork(original,'generation'),held=gate(),run=lease.run(()=>held.promise);lease.finish('closed');
  await f.finish(0);await f.normalEntered[0]!.promise;
  assert.throws(()=>assertNativeAssetActor(original,'mutate'),{code:'NATIVE_ASSET_AUTHORITY'},'The actual ended callback already retired that operation scope.');
  assert.equal((await f.action('select',{model:'fixture',effort:'medium'})).record.state,'acknowledged');assert.equal(lease.signal.aborted,false);
  assert.throws(()=>f.actor(0),{code:'NATIVE_ASSET_AUTHORITY'});
  held.resolve();await run;await f.waitNormal(0);
  const next=await f.send('Use the new local choice');assert.equal(next.record.state,'acknowledged');assert.equal(next.record.effort,'medium');
  assert.equal(f.clients[1]!.snapshot().thread!.selection.effort,'medium');
});

test('saved-task focus after normal completion is read-only on the exact original client before fresh Send',{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false,newThread:index=>index?'other.saved.thread':THREAD});await f.ready();await f.send();const id=f.currentTask().taskId;
  await f.finish(0);await f.waitNormal(0);assert.equal(f.service.state().chatTasks!.find(row=>row.taskId===id)!.retained,true);
  await f.action('disconnect',{preserveAssetWork:true});await f.ready();const before=(await f.wire()).filter(row=>row.method==='turn/start').length;
  const focus=await f.action('task-focus',{taskId:id,threadId:THREAD});assert.equal(focus.record.state,'acknowledged');assert.equal(focus.record.nextConnectionId,f.clients[0]!.snapshot().connectionId);
  assert.equal(f.service.state().nativeHistory!.threadId,THREAD);assert.equal(f.clients[0]!.snapshot().connected,true);assert.equal(f.clients[1]!.snapshot().connected,false);
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,before);assert.throws(()=>f.actor(0),{code:'NATIVE_ASSET_AUTHORITY'});
  assert.equal((await f.send('A new human Send after read-only focus')).record.state,'acknowledged');assert.equal(f.clients.length,3);
  assert.equal(f.clients[0]!.snapshot().connected,false);assertNativeAssetActor(f.actor(2),'mutate');
});

test('normal saved-task focus cannot cross the selected actual native account',{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false,email:index=>index?'other@example.invalid':'handoff@example.invalid'});await f.ready();await f.send();const id=f.currentTask().taskId;
  await f.finish(0);await f.waitNormal(0);await f.action('disconnect',{preserveAssetWork:true});await f.ready();
  const focus=await f.action('task-focus',{taskId:id,threadId:THREAD});assert.equal(focus.record.state,'rejected');assert.equal(focus.record.errorCode,'ACCOUNT_IDENTITY');
  assert.equal(f.clients[0]!.snapshot().connected,true);assert.equal(f.clients[1]!.snapshot().connected,true);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('a scoped unresolved asset join stays held and cannot be rearmed by another Send',{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false});await f.ready();await f.send();const lease=acquireNativeAssetWork(f.actor(0),'generation');lease.finish('unresolved');
  await f.finish(0);await f.normalEntered[0]!.promise;const attempt=await f.send('No replay');assert.equal(attempt.record.state,'rejected');assert.equal(attempt.record.errorCode,'NATIVE_ERROR');
  assert.equal(f.clients.length,1);assert.equal(f.registry.recognizes(f.tokens[0]!),false);
  let failure:unknown;await assert.rejects(f.service.close(),error=>{failure=error;assert.ok(error&&typeof error==='object'&&'code'in error&&error.code==='NATIVE_ASSET_UNRESOLVED');return true;});
  f.expectClose(failure);await assert.rejects(f.service.close(),error=>error===failure);
});

for(const original of [new Error('controlled original close'),null,undefined,false,0])test('later planned close preserves exact original failure '+String(original),{timeout:15000},async t=>{
  const f=await fixture(t,{planning:false,closeFailure:{value:original}});await f.ready();await f.send();await f.finish(0);await f.waitNormal(0);
  const next=await f.send('No dispatch after failed owned close');assert.equal(next.record.state,'rejected');assert.equal(f.clients.length,1);
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
  f.expectClose(original);await assert.rejects(f.service.close(),error=>Object.is(error,original));await assert.rejects(f.service.close(),error=>Object.is(error,original));
  assert.equal(f.events.filter(value=>value==='close:0').length,1);
});

// Controlled original owner ports isolate scheduling/error semantics below;
// their completions are never labelled physical provider/native evidence.
async function coordinatorFixture(t:test.TestContext){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-normal-slot-')));
  const coordinator=new ChatTaskCoordinator({directory:join(root,'journal'),projectPath:root});
  coordinator.attachCancellation(Object.freeze({async cancelExact(){assert.fail('No published job in this schedule.');},async revalidateExact(){return'current' as const;}}));
  const snapshot:Snapshot={connectionId:randomUUID(),provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,
    account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},selection:{model:'fixture',effort:'low'},models:[],approvals:[],operations:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null,
    thread:{threadId:'slot.thread',sessionId:'slot.session',configured:true,selection:{model:'fixture',effort:'low'},turnStatus:'inProgress',turnId:'slot.turn',writeGranted:false}};
  const id=randomUUID(),operationId=randomUUID(),started=gate(),counts={normal:0,cancel:0};
  const hooks:{normal?:()=>Promise<void>;cancel?:()=>Promise<void>}={};let closeFailure:{value:unknown}|null=null;
  const owner:ChatTaskOwner={snapshot:()=>snapshot,accountIdentity:()=> 'b'.repeat(64),revoke(){},async repair(){assert.fail('No repair in this schedule.');},
    retire(){counts.normal++;started.resolve();return hooks.normal?.()??Promise.resolve();},
    async cancel(){counts.cancel++;await hooks.cancel?.();}};
  coordinator.begin({id,actorId:'slot-'+id,snapshot,allowWorkspaceWrites:false,allowAssets:false,accountIdentity:'b'.repeat(64),owner});
  coordinator.dispatched(id,operationId);snapshot.operations.push({operationId,method:'turn/start',requestId:1,threadId:'slot.thread',turnId:'slot.turn',state:'acknowledged',errorCode:null});
  const origin=coordinator.playtests.capture('slot-'+id);assert.ok(origin);
  const complete=()=>{snapshot.thread!.turnStatus='completed';coordinator.acknowledged(id);};
  t.after(async()=>{try{if(closeFailure)await assert.rejects(coordinator.close(),error=>Object.is(error,closeFailure!.value));else await coordinator.close();}
    finally{const part=relative(boundary,root);assert.ok(part.startsWith('arcane-normal-slot-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});}});
  return{coordinator,id,origin,complete,started,counts,hooks,expectClose:(value:unknown)=>{closeFailure={value};}};
}

test('original task registration before publication prevents premature normal fencing',async t=>{
  const f=await coordinatorFixture(t),work=gate();
  f.coordinator.playtests.registerWork(f.origin,Object.freeze({kind:'prepare',completion:work.promise,cancel:async()=>{work.resolve();}}));
  f.complete();await f.coordinator.drain();assert.equal(f.counts.normal,0);
  f.coordinator.playtests.assert(f.origin);work.resolve();await f.started.promise;await f.coordinator.drain();
  assert.equal(f.counts.normal,1);assert.equal(f.counts.cancel,0);assert.throws(()=>f.coordinator.playtests.assert(f.origin));
});

test('reentrant exact Stop starts its original owner before joining the same normal slot',async t=>{
  const f=await coordinatorFixture(t),normal=gate();let stopped:Promise<void>|null=null;
  f.hooks.normal=()=>{stopped=f.coordinator.cancel(f.id,'reentrant exact Stop');return normal.promise;};
  f.hooks.cancel=async()=>{normal.resolve();};f.complete();await f.started.promise;
  assert.ok(stopped);await stopped;await f.coordinator.drain();assert.equal(f.counts.normal,1);assert.equal(f.counts.cancel,1);
  await f.coordinator.cancel(f.id,'same original Stop');assert.equal(f.counts.cancel,1);
});

test('unexpected original retirement after normal settlement fences followup and keeps its original failure',async t=>{
  const f=await coordinatorFixture(t);f.complete();await f.started.promise;await f.coordinator.drain();
  f.coordinator.uncertain(f.id,'unexpected_original_retirement');let failure:unknown;
  await assert.rejects(f.coordinator.prepareFollowup('slot.thread','slot.session'),error=>{
    failure=error;return error instanceof Error&&error.message==='unexpected_original_retirement';
  });
  assert.equal(f.counts.normal,1);assert.equal(f.counts.cancel,1);f.expectClose(failure);
  await assert.rejects(f.coordinator.close(),error=>error===failure);
});

for(const first of [new Error('original scoped failure'),null,undefined,false,0])test('normal failure keeps exact first identity before later cleanup '+String(first),async t=>{
  const f=await coordinatorFixture(t),later=new Error('later original close failure');
  f.hooks.normal=()=>Promise.reject(first);f.hooks.cancel=()=>Promise.reject(later);f.complete();await f.started.promise;
  await assert.rejects(f.coordinator.prepareFollowup('slot.thread','slot.session'),error=>Object.is(error,first));
  assert.equal(f.counts.cancel,0);await assert.rejects(f.coordinator.cancel(f.id,'explicit Stop'),error=>Object.is(error,first));assert.equal(f.counts.cancel,1);
  f.expectClose(first);await assert.rejects(f.coordinator.close(),error=>Object.is(error,first));await assert.rejects(f.coordinator.close(),error=>Object.is(error,first));
});
