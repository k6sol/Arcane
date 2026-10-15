import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {nativeStudioReconstructionResponse,nativeStudioReconstructionStatusResponse,parseNativeStudioReconstructionResponse} from '../../packages/asset-pipeline/src/studio-reconstruction-wire.js';
import {ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';

// Actual in-memory MCP SDK and production client/codec. HTTP responses and all
// identities are synthetic; no listening socket, real plugin, engine or provider.
const JOB='11111111-1111-4111-8111-111111111111',RUN='22222222-2222-4222-8222-222222222222',COMMAND='33333333-3333-4333-8333-333333333333';
const PROJECT='a'.repeat(64),TOOL='assets_reconstruct_studio_import';
const receipt=()=>({runId:RUN,transferDigest:'b'.repeat(64),state:'reconstructed' as const,objects:[{sourceObjectId:'fixture-mesh',meshExportSha256:'c'.repeat(64),vertexCount:4,triangleCount:4}],imported:false as const,engineVerification:'pending' as const});
const response=()=>({jobId:JOB,projectId:PROJECT,reconstructed:{...receipt(),commandId:COMMAND}});
function fixture(t:test.TestContext,native=true){
  const calls:{url:string;body:unknown;method:string;redirect:RequestRedirect|undefined}[]=[];
  let respond:()=>Response=()=>new Response(JSON.stringify(response()),{status:200,headers:{'content-type':'application/json'}});
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null,method:init?.method??'GET',redirect:init?.redirect});return respond();
  });
  const daemon=new DaemonClient({url:'http://127.0.0.1:12345',token:'synthetic-unit-token',assetAudience:native?'native-session':'generic'});
  return {daemon,calls,setRespond(value:()=>Response){respond=value;}};
}
async function linked(t:test.TestContext,daemon:DaemonClient){
  const server=createMcpServer({client:daemon,projectRoot:process.cwd()}),client=new Client({name:'synthetic-reconstruction',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});return client;
}
test('closed detached receipt preserves exact scope/counts and rejects authority or acceptance claims',()=>{
  const input=response(),parsed=parseNativeStudioReconstructionResponse(input,JOB,PROJECT);input.reconstructed.objects[0]!.vertexCount=99;
  assert.equal(parsed.reconstructed.objects[0]!.vertexCount,4);
  for(const patch of [{imported:true},{engineVerification:'verified'},{editableMesh:{}},{rights:true},{objects:[]},
    {objects:[receipt().objects[0]!,receipt().objects[0]!]},{objects:[{...receipt().objects[0]!,vertexCount:60001}]}]){
    assert.equal(nativeStudioReconstructionResponse.safeParse({...response(),reconstructed:{...response().reconstructed,...patch}}).success,false);
  }
  assert.throws(()=>parseNativeStudioReconstructionResponse(response(),JOB,'d'.repeat(64)),{code:'STUDIO_RECONSTRUCT_RESPONSE'});
  let reads=0;const value=response();Object.defineProperty(value.reconstructed,'objects',{enumerable:true,get(){reads++;throw Error('never');}});
  assert.equal(nativeStudioReconstructionResponse.safeParse(value).success,false);assert.equal(reads,0);
  const proxy=new Proxy({},{ownKeys(){throw Error('proxy traps must not run');}});
  assert.equal(nativeStudioReconstructionResponse.safeParse(proxy).success,false);
});
test('native MCP advertises the actual reconstruction tools and submits only original jobId once',async t=>{
  const f=fixture(t),sdk=await linked(t,f.daemon),names=(await sdk.listTools()).tools.map(tool=>tool.name);
  assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes(TOOL));assert.ok(names.includes(TOOL));assert.ok(names.includes('assets_studio_reconstruction_status'));
  const result=CallToolResultSchema.parse(await sdk.callTool({name:TOOL,arguments:{jobId:JOB}}));assert.notEqual(result.isError,true);
  assert.deepEqual(result.structuredContent,response());assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0]!.body,{jobId:JOB});
  assert.ok(f.calls[0]!.url.endsWith('/v1/assets/native/reconstruct-studio-import'));assert.equal(f.calls[0]!.redirect,'error');
  for(const extra of [{target:{}},{rights:true},{runId:RUN},{source:{}},{permission:true}]){
    const refused=await sdk.callTool({name:TOOL,arguments:{jobId:JOB,...extra}});assert.equal(refused.isError,true);
  }
  assert.equal(f.calls.length,1);
});
test('generic audience cannot acquire reconstruction from a JSON argument or direct client method',async t=>{
  const f=fixture(t,false),sdk=await linked(t,f.daemon);assert.ok(!(await sdk.listTools()).tools.some(tool=>tool.name===TOOL));
  await assert.rejects(f.daemon.assetsReconstructStudioImport(JOB),{code:'ASSET_AUDIENCE'});
  await assert.rejects(f.daemon.assetsStudioReconstructionStatus(JOB),{code:'ASSET_AUDIENCE'});assert.equal(f.calls.length,0);
});
test('post-send rejection, malformed evidence and lost acknowledgement remain unknown without replay',async t=>{
  const f=fixture(t);
  for(const respond of [()=>new Response(JSON.stringify({error:'NATIVE_ASSET_AUTHORITY',message:'retired after execution'}),{status:403,headers:{'content-type':'application/json'}}),
    ()=>new Response(JSON.stringify({...response(),reconstructed:{...response().reconstructed,imported:true}}),{headers:{'content-type':'application/json'}}),
    ()=>{throw Error('lost response');}]){
    f.setRespond(respond);const before=f.calls.length,result=await f.daemon.assetsReconstructStudioImport(JOB);
    assert.equal('state'in result?result.state:null,'unknown');assert.equal('retry'in result?result.retry:null,false);assert.equal(f.calls.length,before+1);
    assert.ok(!('reconstructed'in result));assert.match('nextStep'in result?String(result.nextStep):'',/never repeat automatically/);
  }
});
test('status is a scoped read that cannot convert historical facts into current resources or another allocation',async t=>{
  const f=fixture(t),status={jobId:JOB,projectId:PROJECT,reconstruction:{runId:RUN,commandId:COMMAND,state:'succeeded',receipt:receipt(),
    receiptScope:'historical-reconstruction',currentResources:'unobserved',imported:false,engineVerification:'pending',retry:false}};
  f.setRespond(()=>new Response(JSON.stringify(status),{headers:{'content-type':'application/json'}}));
  assert.deepEqual(await f.daemon.assetsStudioReconstructionStatus(JOB),status);assert.equal(f.calls[0]!.method,'GET');assert.equal(f.calls[0]!.body,null);
  for(const patch of [{currentResources:'present'},{imported:true},{retry:true},{state:'needs_reconciliation'},{receipt:null}]){
    assert.equal(nativeStudioReconstructionStatusResponse.safeParse({...status,reconstruction:{...status.reconstruction,...patch}}).success,false);
  }
  assert.equal(f.calls.length,1);
});
