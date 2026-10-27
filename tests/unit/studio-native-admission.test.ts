import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {NativeTestAdapter,reviewedTestTools} from '../../packages/studio-test-controller/src/native-adapter.js';
import {digest,type TestBinding} from '../../packages/studio-test-controller/src/contracts.js';
import {scenarioPlanSchema} from '../../packages/studio-test-controller/src/scenario.js';

// Actual SDK peers and production adapter/bounded calls. Mode/proof/scenario
// bodies below are controlled fixture evidence, never native Studio acceptance.
const STUDIO='dispatch-fixture',RUN='dispatch-run';
const binding:TestBinding={nativeStudioId:STUDIO,pairedSessionId:'paired-fixture',clientLifetimeId:'plugin-fixture',pluginArtifactHash:'a'.repeat(64),scopeRevision:'b'.repeat(64),placeId:0};
const signal=()=>new AbortController().signal;
const deadline=()=>Date.now()+10000;
const reply=(text:string):CallToolResult=>({content:[{type:'text',text}]});
const code=(expected:string)=>(error:unknown)=>error instanceof Error&&'code' in error&&error.code===expected;
const extraTools:Tool[]=[
  {name:'execute_luau',inputSchema:{type:'object',properties:{studio_id:{type:'string'},datamodel_type:{type:'string',enum:['Client','Edit','Server']},code:{type:'string'}},required:['studio_id','datamodel_type','code']}},
  {name:'screen_capture',inputSchema:{type:'object',properties:{studio_id:{type:'string'},capture_id:{type:'string'}},required:['studio_id','capture_id']}},
];

async function fixture(t:TestContext,capture=false){
  const plan=scenarioPlanSchema.parse({version:1,runtimeBudgetMs:100,targets:[],steps:[{id:'distance',kind:'assert-displacement',minimumStuds:0.1}],capture:{required:capture}});
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'dispatch-client-fixture',version:'1'},{capabilities:{}}),server=new Server({name:'fixture-not-RobloxStudio',version:'1'},{capabilities:{tools:{}}});
  let mode:'Edit'|'Play'='Edit',epoch=0,retired=false,armed=false,queued=false,guards=0,nackStart=false,saved=0;
  const original=new Error('fixed original dispatch-guard refusal'),calls:{name:string;args:Record<string,unknown>}[]=[];
  server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone([...reviewedTestTools,...extraTools])}));
  server.setRequestHandler(CallToolRequestSchema,request=>{
    const name=request.params.name,args=request.params.arguments??{};calls.push({name,args:structuredClone(args)});
    if(name==='list_roblox_studios')return reply(JSON.stringify([{id:STUDIO,name:'Dispatch fixture'}]));
    assert.equal(args.studio_id,STUDIO);
    if(name==='get_studio_state')return reply(JSON.stringify({nativeStudioId:STUDIO,placeId:0,mode,datamodels:mode==='Edit'?['Edit']:['Client','Server']}));
    if(name==='get_console_output')return reply(JSON.stringify({entries:[],truncated:false}));
    if(name==='start_stop_play'){
      assert.equal(typeof args.is_start,'boolean');mode=args.is_start?'Play':'Edit';epoch++;
      return args.is_start&&nackStart?{...reply('Controlled post-dispatch failure.'),isError:true}:reply('Controlled acknowledgement.');
    }
    if(name==='execute_luau'){
      assert.equal(args.datamodel_type,'Client');assert.equal(typeof args.code,'string');
      return reply(JSON.stringify({version:1,runId:RUN,scenarioDigest:digest(plan),outcome:'passed',code:'OK',inputRelease:'not_started',
        steps:[{id:'distance',kind:'assert-displacement',outcome:'passed',expected:0.1,observed:1}]}));
    }
    assert.equal(name,'screen_capture');assert.fail('The retired capture must never reach the SDK peer.');
  });
  await server.connect(b);await client.connect(a);
  t.after(async()=>{try{await client.close();}finally{await server.close();}});
  const read=(result:CallToolResult):unknown=>{const item=result.content[0];assert.equal(item?.type,'text');if(item?.type!=='text')assert.fail();return JSON.parse(item.text);};
  const adapter=new NativeTestAdapter({client,evidence:'fixture',requestTimeoutMs:5000,
    pairedProof:{async read(wanted){assert.deepEqual(wanted,binding);return {binding,observedAt:Date.now(),expiresAt:Date.now()+10000,connected:true,revoked:false,protectedPlace:false,testActionsAllowed:true,playEpoch:epoch,continuitySupported:true};}},
    decoder:{inventory:read,state:read,logs:read,focus:()=>mode==='Play'?'Client':'Edit'},
    subjectReader:{async read(){return 'c'.repeat(64);}},captureStore:{async save(){saved++;assert.fail('No image may be saved from a rejected pre-dispatch capture.');}},
    admissionGuard(){
      guards++;if(retired)throw original;
      // This is queued by the OUTER guard before bounded queues its SDK action.
      // The inner guard must observe the genuine intervening retirement.
      if(armed&&!queued){queued=true;queueMicrotask(()=>{retired=true;});}
    },
  });
  return {adapter,plan,original,calls,mode:()=>mode,saved:()=>saved,guards:()=>guards,
    retireBetweenGuards(){guards=0;retired=false;queued=false;armed=true;},
    freshGuard(){guards=0;retired=false;queued=false;armed=false;},retireNow(){retired=true;},
    failDispatchedStart(){nackStart=true;},effects:()=>calls.filter(call=>['start_stop_play','execute_luau','screen_capture'].includes(call.name))};
}

test('start retirement in the actual bounded microtask prevents SDK dispatch without inventing unknown effect',{timeout:30000},async t=>{
  const f=await fixture(t);f.retireBetweenGuards();
  await assert.rejects(f.adapter.start(binding,RUN,deadline(),signal()),error=>error===f.original);
  assert.equal(f.guards(),2);assert.deepEqual(f.effects(),[]);
  // Edit-mode cleanup remains available under the retired guard. A pre-dispatch
  // refusal must not have set the start adapter's effectUnknown fence.
  await f.adapter.stop(binding,RUN,deadline(),signal());assert.deepEqual(f.effects(),[]);assert.equal(f.guards(),2);
  // An explicit fresh operation is distinct from automatically replaying RUN.
  f.freshGuard();await f.adapter.start(binding,'fresh-explicit-run',deadline(),signal());
  assert.equal(f.mode(),'Play');assert.equal(f.guards(),2);f.retireNow();
  await f.adapter.stop(binding,'fresh-explicit-run',deadline(),signal());
  assert.deepEqual(f.effects().map(call=>[call.name,call.args.is_start]),[['start_stop_play',true],['start_stop_play',false]]);
  assert.equal(f.mode(),'Edit');assert.equal(f.guards(),2,'Owned stop never calls the new-effect admission guard.');
});

test('scenario retirement before actual SDK dispatch preserves original error and one-shot consumption',{timeout:30000},async t=>{
  const f=await fixture(t);await f.adapter.prepareScenario(f.plan,signal());await f.adapter.start(binding,RUN,deadline(),signal());
  f.retireBetweenGuards();await assert.rejects(f.adapter.runScenario(binding,RUN,f.plan,deadline(),signal()),error=>error===f.original);
  assert.equal(f.guards(),2);assert.equal(f.calls.filter(call=>call.name==='execute_luau').length,0);
  f.freshGuard();await assert.rejects(f.adapter.runScenario(binding,RUN,f.plan,deadline(),signal()),code('FENCED'));
  assert.equal(f.calls.filter(call=>call.name==='execute_luau').length,0);assert.equal(f.guards(),0);
  f.retireNow();await f.adapter.stop(binding,RUN,deadline(),signal());assert.equal(f.mode(),'Edit');
  assert.deepEqual(f.effects().map(call=>[call.name,call.args.is_start]),[['start_stop_play',true],['start_stop_play',false]]);
});

test('capture retirement before actual SDK dispatch cannot create an image and cannot replay the capture',{timeout:30000},async t=>{
  const f=await fixture(t,true);await f.adapter.prepareScenario(f.plan,signal());await f.adapter.start(binding,RUN,deadline(),signal());
  const report=await f.adapter.runScenario(binding,RUN,f.plan,deadline(),signal());assert.equal(report.outcome,'passed');
  assert.equal(f.calls.filter(call=>call.name==='execute_luau').length,1);
  f.retireBetweenGuards();await assert.rejects(f.adapter.captureScenario(binding,RUN,signal()),error=>error===f.original);
  assert.equal(f.guards(),2);assert.equal(f.calls.filter(call=>call.name==='screen_capture').length,0);assert.equal(f.saved(),0);
  f.freshGuard();await assert.rejects(f.adapter.captureScenario(binding,RUN,signal()),code('FENCED'));
  assert.equal(f.calls.filter(call=>call.name==='screen_capture').length,0);assert.equal(f.saved(),0);assert.equal(f.guards(),0);
  f.retireNow();await f.adapter.stop(binding,RUN,deadline(),signal());assert.equal(f.mode(),'Edit');
});

test('a genuinely dispatched start failure still retains unknown effect and cannot send an invented owned stop',{timeout:30000},async t=>{
  const f=await fixture(t);f.failDispatchedStart();
  await assert.rejects(f.adapter.start(binding,RUN,deadline(),signal()),code('EFFECT_UNKNOWN'));
  assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,1);assert.equal(f.mode(),'Play');assert.equal(f.guards(),2);
  f.retireNow();await assert.rejects(f.adapter.stop(binding,RUN,deadline(),signal()),code('EFFECT_UNKNOWN'));
  assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,1);assert.equal(f.guards(),2);
});
