import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {NATIVE_STUDIO_RECONSTRUCTION_RESPONSE_BYTES,nativeStudioReconstructionResponse,nativeStudioReconstructionStatusResponse,
  parseNativeStudioReconstructionResponse,parseNativeStudioReconstructionStatusResponse} from '../../packages/asset-pipeline/src/studio-reconstruction-wire.js';

// Production codecs/SDK/in-memory MCP; responses and logical graph summaries
// are synthetic. No HTTP server, native engine, allocation, Studio or provider.
const JOB='11111111-1111-4111-8111-111111111111',RUN='22222222-2222-4222-8222-222222222222',COMMAND='33333333-3333-4333-8333-333333333333';
const PROJECT='a'.repeat(64),OBJECT='arcane_'+'b'.repeat(64),COLLISION='arcane_'+'c'.repeat(64);
type Doc=Record<string,any>;
function receipt(collision=false):Doc{return {runId:RUN,transferDigest:'d'.repeat(64),state:'reconstructed',objects:[{sourceObjectId:OBJECT,meshExportSha256:'e'.repeat(64),vertexCount:4,triangleCount:2},
  ...(collision?[{sourceObjectId:COLLISION,meshExportSha256:'f'.repeat(64),vertexCount:4,triangleCount:4}]:[])],imported:false,engineVerification:'pending',formatVersion:2,graphDigest:'1'.repeat(64),nodeCount:4,
  nodes:[{nodeKey:'node0',parentKey:null,sourceObjectId:null},{nodeKey:'node1',parentKey:'node0',sourceObjectId:null},
    {nodeKey:'node1_primitive0',parentKey:'node1',sourceObjectId:OBJECT},{nodeKey:'node2',parentKey:null,sourceObjectId:null}]};}
function response(collision=false):Doc{return {jobId:JOB,projectId:PROJECT,reconstructed:{...receipt(collision),commandId:COMMAND}};}
function status(collision=false):Doc{return {jobId:JOB,projectId:PROJECT,reconstruction:{runId:RUN,commandId:COMMAND,state:'succeeded',receipt:receipt(collision),
  receiptScope:'historical-reconstruction',currentResources:'unobserved',imported:false,engineVerification:'pending',retry:false}};}
for(const collision of [false,true])test('converted '+(collision?'derived-mesh':'selected-only')+' receipt execution and history retain logical summaries without observed instances',()=>{
  const input=response(collision),parsed=parseNativeStudioReconstructionResponse(input,JOB,PROJECT);assert.deepEqual(parsed,input);
  input.reconstructed.nodes[0].nodeKey='mutated';assert.equal('nodes'in parsed.reconstructed?parsed.reconstructed.nodes[0]!.nodeKey:null,'node0');
  const historical=status(collision),decoded=parseNativeStudioReconstructionStatusResponse(historical,JOB,PROJECT);assert.deepEqual(decoded,historical);
  assert.equal(decoded.reconstruction!.currentResources,'unobserved');assert.equal(decoded.reconstruction!.imported,false);
  assert.equal('instanceRef'in receipt(collision).nodes[0],false);
});
test('legacy receipt bytes and null historical status remain compatible without v2 backfill',()=>{
  const {formatVersion:_version,graphDigest:_digest,nodeCount:_count,nodes:_nodes,...legacy}=receipt();
  const input={jobId:JOB,projectId:PROJECT,reconstructed:{...legacy,commandId:COMMAND}},parsed=parseNativeStudioReconstructionResponse(input,JOB,PROJECT);
  assert.equal(JSON.stringify(parsed),JSON.stringify(input));assert.equal('formatVersion'in parsed.reconstructed,false);assert.equal('nodes'in parsed.reconstructed,false);
  const missing={jobId:JOB,projectId:PROJECT,reconstruction:null};assert.deepEqual(parseNativeStudioReconstructionStatusResponse(missing,JOB,PROJECT),missing);
  const mixed={...legacy,graphDigest:'1'.repeat(64)};assert.equal(nativeStudioReconstructionResponse.safeParse({jobId:JOB,projectId:PROJECT,reconstructed:{...mixed,commandId:COMMAND}}).success,false);
});
test('v2 requires every versioned field and rejects malformed, cyclic, duplicate, reordered or foreign logical nodes',()=>{
  const changes:((value:Doc)=>void)[]=[v=>delete v.formatVersion,v=>v.formatVersion=1,v=>delete v.graphDigest,v=>delete v.nodeCount,v=>delete v.nodes,
    v=>v.graphDigest+='\n',v=>v.nodeCount++,v=>v.nodes[0].parentKey='node1',v=>v.nodes[1].parentKey='node1',
    v=>v.nodes[2].nodeKey='node0',v=>[v.nodes[1],v.nodes[2]]=[v.nodes[2],v.nodes[1]],v=>v.nodes[2].parentKey='node0',
    v=>v.nodes[0].sourceObjectId=OBJECT,v=>v.nodes[2].sourceObjectId=null,v=>v.nodes[2].sourceObjectId=COLLISION,
    v=>{v.nodes.push({...v.nodes[2],nodeKey:'node1_primitive1'});v.nodeCount++;},v=>v.nodes[1].instanceRef='unobserved',
    v=>v.nodes[2].sourceObjectId+='\n',v=>v.nodes[1].localMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
    v=>v.nodes[2].nodeKey='node1_primitive0\n',v=>v.imported=true,v=>v.engineVerification='verified'];
  for(const change of changes){const value=receipt();change(value);assert.equal(nativeStudioReconstructionResponse.safeParse({jobId:JOB,projectId:PROJECT,reconstructed:{...value,commandId:COMMAND}}).success,false);}
  const extra=receipt(true);extra.objects.push({sourceObjectId:'arcane_'+'2'.repeat(64),meshExportSha256:'3'.repeat(64),vertexCount:4,triangleCount:1});
  assert.equal(nativeStudioReconstructionResponse.safeParse({jobId:JOB,projectId:PROJECT,reconstructed:{...extra,commandId:COMMAND}}).success,false);
});
test('valid complete 128-node summaries fit the unchanged 64KiB/3000-value/depth limits',()=>{
  const value=receipt();value.nodes=[];value.objects=[];
  for(let i=0;i<64;i++){const sourceObjectId='arcane_'+i.toString(16).padStart(64,'0');value.nodes.push({nodeKey:'node'+i,parentKey:null,sourceObjectId:null},
    {nodeKey:'node'+i+'_primitive0',parentKey:'node'+i,sourceObjectId});value.objects.push({sourceObjectId,meshExportSha256:'f'.repeat(64),vertexCount:3,triangleCount:1});}
  value.nodeCount=128;const input={jobId:JOB,projectId:PROJECT,reconstructed:{...value,commandId:COMMAND}};
  assert.ok(Buffer.byteLength(JSON.stringify(input))<NATIVE_STUDIO_RECONSTRUCTION_RESPONSE_BYTES);assert.equal(NATIVE_STUDIO_RECONSTRUCTION_RESPONSE_BYTES,65536);
  assert.equal(nativeStudioReconstructionResponse.safeParse(input).success,true);
  value.nodes.push({nodeKey:'node9999',parentKey:null,sourceObjectId:null});value.nodeCount=129;assert.equal(nativeStudioReconstructionResponse.safeParse(input).success,false);
});
test('historical receipt2 remains exact, run-bound, unobserved and unavailable for retry',()=>{
  for(const change of [(v:Doc)=>v.currentResources='present',(v:Doc)=>v.imported=true,(v:Doc)=>v.retry=true,(v:Doc)=>v.state='needs_reconciliation',
    (v:Doc)=>v.receipt=null,(v:Doc)=>v.receipt.runId=COMMAND,(v:Doc)=>v.receipt.nodes[0].ownedStateSha256='a'.repeat(64)]){
    const value=status();change(value.reconstruction);assert.equal(nativeStudioReconstructionStatusResponse.safeParse(value).success,false);
  }
  for(const state of ['queued','dispatched','failed','cancelled','needs_reconciliation']){const value=status();value.reconstruction.state=state;value.reconstruction.receipt=null;assert.equal(nativeStudioReconstructionStatusResponse.safeParse(value).success,true);}
  assert.throws(()=>parseNativeStudioReconstructionResponse(response(),COMMAND,PROJECT),{code:'STUDIO_RECONSTRUCT_RESPONSE'});
  assert.throws(()=>parseNativeStudioReconstructionStatusResponse(status(),JOB,'f'.repeat(64)),{code:'STUDIO_RECONSTRUCT_STATUS_RESPONSE'});
});
test('descriptor/proxy/symbol/hidden/prototype/sparse fences reject hostile metadata without invoking accessors',()=>{
  let calls=0;const getter=response();Object.defineProperty(getter.reconstructed,'nodes',{enumerable:true,get(){calls++;throw Error('getter');}});
  const proxy=new Proxy(response(),{getPrototypeOf(){calls++;throw Error('trap');},ownKeys(){calls++;throw Error('trap');}}),array=response();Object.defineProperty(array.reconstructed.nodes,0,{enumerable:true,get(){calls++;throw Error('array getter');}});
  const hidden=response();Object.defineProperty(hidden.reconstructed.nodes[0],'observed',{value:true});const symbols=response();symbols.reconstructed.nodes[0][Symbol('authority')]=true;
  const prototype=response();Object.setPrototypeOf(prototype.reconstructed.nodes[0],{observed:true});const sparse=response();delete sparse.reconstructed.nodes[1];
  for(const value of [getter,proxy,array,hidden,symbols,prototype,sparse])assert.equal(nativeStudioReconstructionResponse.safeParse(value).success,false);
  assert.equal(calls,0);
});
async function linked(t:test.TestContext){
  const calls:{url:string;method:string;body:unknown}[]=[];let value:unknown=response(true);
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});return Response.json(value);});
  const daemon=new DaemonClient({url:'http://127.0.0.1:12345',token:'synthetic-converted-codec-bearer',assetAudience:'native-session'}),server=createMcpServer({client:daemon,projectRoot:process.cwd()}),client=new Client({name:'converted-codec-fixture',version:'1'});
  const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});return {daemon,client,calls,set(valueNext:unknown){value=valueNext;}};
}
test('actual native SDK/MCP executes one original-job POST and reads receipt2 historical status without altering summaries',async t=>{
  const f=await linked(t),execution=CallToolResultSchema.parse(await f.client.callTool({name:'assets_reconstruct_studio_import',arguments:{jobId:JOB}}));
  assert.notEqual(execution.isError,true);assert.deepEqual(execution.structuredContent,response(true));assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.method,'POST');assert.deepEqual(f.calls[0]!.body,{jobId:JOB});
  f.set(status(true));const historical=CallToolResultSchema.parse(await f.client.callTool({name:'assets_studio_reconstruction_status',arguments:{jobId:JOB}}));
  assert.notEqual(historical.isError,true);assert.deepEqual(historical.structuredContent,status(true));assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.method,'GET');assert.equal(f.calls[1]!.body,null);
  const malformed=response(true);malformed.reconstructed.nodes[2].sourceObjectId='arcane_'+'9'.repeat(64);f.set(malformed);
  const unknown=await f.daemon.assetsReconstructStudioImport(JOB);assert.equal('state'in unknown?unknown.state:null,'unknown');assert.equal('retry'in unknown?unknown.retry:null,false);assert.equal(f.calls.length,3);assert.equal('reconstructed'in unknown,false);
});
