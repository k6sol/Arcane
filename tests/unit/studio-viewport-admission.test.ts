import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {captureEditViewport,cameraRestoreProgram,VIEWPORT_CAMERA_READ_PROGRAM,type ViewportCamera} from '../../packages/studio-test-controller/src/viewport.js';
import {decodeViewportPng,encodeRgbPng,VIEWPORT_LIMITS} from '../../packages/studio-test-controller/src/viewport-image.js';
import {decodeTestMode} from '../../apps/daemon/src/studio-test-decoders.js';
import {systemScheduler,type Scheduler} from '../../packages/studio-test-controller/src/contracts.js';

// Actual SDK peers/controller over in-memory transport. Cameras, PNG and lost
// host custody are controlled fixtures; no Studio/native process is exercised.
const STUDIO='viewport-admission-fixture',EDIT='- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit';
const ORIGINAL={cframe:[0,10,20,1,0,0,0,1,0,0,0,1],focus:[0,0,0,1,0,0,0,1,0,0,0,1]};
const SHEET:ViewportCamera[]=[{position:[10,10,-10],lookAt:[0,0,0]},{position:[0,20,0],lookAt:[0,0,0]},{position:[-10,5,10],lookAt:[0,0,0]}];
const READ={readOnlyHint:true,destructiveHint:false,idempotentHint:true};
const TOOLS:Tool[]=[
  {name:'get_studio_state',annotations:READ,inputSchema:{type:'object',required:['studio_id'],properties:{studio_id:{type:'string'}}}},
  {name:'execute_luau',inputSchema:{type:'object',required:['studio_id','datamodel_type','code'],properties:{studio_id:{type:'string'},datamodel_type:{type:'string',enum:['Edit']},code:{type:'string'}}}},
  {name:'screen_capture',annotations:READ,inputSchema:{type:'object',required:['studio_id','capture_id'],properties:{studio_id:{type:'string'},capture_id:{type:'string'},camera_position:{type:'array'},look_at_position:{type:'array'}}}},
];
const text=(value:string):CallToolResult=>({content:[{type:'text',text:value}]});
function gate(){let release=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function fixture(t:TestContext,options:{holdFirst?:boolean;restoreFails?:boolean}={}){
  const first=gate(),held=gate(),calls:{name:string;args:Record<string,unknown>}[]=[];
  const png=encodeRgbPng(Buffer.alloc(128*96*3,80),128,96);let camera=structuredClone(ORIGINAL),shots=0,restores=0;
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'viewport-admission-client',version:'fixture'},{capabilities:{}});
  const server=new Server({name:'viewport-admission-server',version:'fixture'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone(TOOLS)}));
  server.setRequestHandler(CallToolRequestSchema,async (request):Promise<CallToolResult>=>{
    const name=request.params.name,args=request.params.arguments??{};calls.push({name,args:structuredClone(args)});assert.equal(args.studio_id,STUDIO);
    if(name==='get_studio_state')return text(EDIT);
    if(name==='execute_luau'){
      assert.equal(args.datamodel_type,'Edit');
      if(args.code===VIEWPORT_CAMERA_READ_PROGRAM)return text(JSON.stringify(camera));
      assert.equal(args.code,cameraRestoreProgram(ORIGINAL));restores++;
      if(options.restoreFails)return {isError:true,content:[{type:'text',text:'Synthetic original camera restore failure.'}]};
      camera=structuredClone(ORIGINAL);return text('{"restored":true}');
    }
    assert.equal(name,'screen_capture');shots++;
    const position=z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]).parse(args.camera_position);
    camera={cframe:[...position,1,0,0,0,1,0,0,0,1],focus:[...ORIGINAL.focus]};
    if(shots===1){first.release();if(options.holdFirst)await held.promise;}
    return {content:[{type:'image',mimeType:'image/png',data:png.toString('base64')}]};
  });
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{held.release();try{await client.close();}finally{await server.close();}});
  return {client,calls,first:first.promise,release:held.release,shots:()=>shots,restores:()=>restores,camera:()=>structuredClone(camera)};
}
function capture(client:Client,admissionGuard?:()=>void,scheduler?:Scheduler){
  return captureEditViewport({client,nativeStudioId:STUDIO,captureId:'viewport_admission_sheet',maxDimension:256,sheet:structuredClone(SHEET),
    verifyBinding:async()=> 'original-paired-binding',decodeMode:decodeTestMode,...(admissionGuard?{admissionGuard}:{}),...(scheduler?{scheduler}:{})},new AbortController().signal);
}

test('a held first sheet capture cannot dispatch a second after admission loss; original camera restoration stays available',{timeout:20_000},async t=>{
  const f=await fixture(t,{holdFirst:true}),original=Error('Original host custody lost.');let admitted=true,guards=0;
  const pending=capture(f.client,()=>{guards++;if(!admitted)throw original;});
  const rejection=assert.rejects(pending,error=>error===original);
  await f.first;admitted=false;f.release();await rejection;
  assert.equal(guards,2);assert.equal(f.shots(),1);assert.equal(f.restores(),1);assert.deepEqual(f.camera(),ORIGINAL);
  assert.deepEqual(f.calls.map(call=>call.name),['get_studio_state','execute_luau','screen_capture','execute_luau','execute_luau','execute_luau']);
  assert.equal(f.calls.filter(call=>call.name==='screen_capture')[0]?.args.capture_id,'viewport_admission_sheet_v0');
});

test('failed original restoration retains EFFECT_UNKNOWN precedence over the exact admission error',{timeout:20_000},async t=>{
  const f=await fixture(t,{holdFirst:true,restoreFails:true}),original=Error('Original host custody lost.');let admitted=true;
  const pending=capture(f.client,()=>{if(!admitted)throw original;}),rejection=assert.rejects(pending,{code:'EFFECT_UNKNOWN'});
  await f.first;admitted=false;f.release();await rejection;
  assert.equal(f.shots(),1);assert.equal(f.restores(),1);assert.notDeepEqual(f.camera(),ORIGINAL);
});

test('first-shot admission refusal dispatches no capture while original camera observation remains allowed',{timeout:20_000},async t=>{
  const f=await fixture(t),original=Error('Admission retired before first capture.');let guards=0;
  await assert.rejects(capture(f.client,()=>{guards++;throw original;}),error=>error===original);
  assert.equal(guards,1);assert.equal(f.shots(),0);assert.equal(f.restores(),0);assert.deepEqual(f.camera(),ORIGINAL);
  assert.deepEqual(f.calls.map(call=>call.name),['get_studio_state','execute_luau','execute_luau']);
});

test('admission is checked after the bounded action microtask and immediately before SDK capture dispatch',{timeout:20_000},async t=>{
  const f=await fixture(t),original=Error('Custody lost during capture admission scheduling.');let admitted=true,guards=0;
  const scheduler:Scheduler={now:()=>systemScheduler.now(),schedule(ms,callback){
    // The unchanged default capture deadline is10000ms; other requests use5000.
    // Retire in the gap before bounded() invokes its action, without changing
    // timers, SDK transport or any camera cleanup call.
    if(ms===10_000)queueMicrotask(()=>{admitted=false;});return systemScheduler.schedule(ms,callback);
  }};
  await assert.rejects(capture(f.client,()=>{guards++;if(!admitted)throw original;},scheduler),error=>error===original);
  assert.equal(guards,1);assert.equal(f.shots(),0);assert.equal(f.restores(),0);assert.deepEqual(f.camera(),ORIGINAL);
});

test('omitting the optional host guard preserves all sheet shots, bounded PNG output and original restoration',{timeout:20_000},async t=>{
  const f=await fixture(t),image=await capture(f.client);
  assert.equal(f.shots(),3);assert.equal(f.restores(),1);assert.deepEqual(f.camera(),ORIGINAL);assert.equal(image.camera,'restored');assert.equal(image.views,3);
  assert.ok(image.width<=256&&image.height<=256&&image.bytes<=VIEWPORT_LIMITS.outputBytes);
  assert.deepEqual([decodeViewportPng(image.png).width,decodeViewportPng(image.png).height],[image.width,image.height]);
  const shots=f.calls.filter(call=>call.name==='screen_capture');assert.deepEqual(shots.map(call=>call.args.camera_position),SHEET.map(shot=>shot.position));
  assert.deepEqual(shots.map(call=>call.args.capture_id),['viewport_admission_sheet_v0','viewport_admission_sheet_v1','viewport_admission_sheet_v2']);
});
