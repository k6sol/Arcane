import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,realpath,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createAssetService,type AssetService} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {nativeAssetRoutes} from '../../apps/daemon/src/native-asset-routes.js';
import {ConversationWorkStore,type NativeConversation} from '../../packages/storage/src/conversation-work-store.js';
import {AssetPipeline,AssetError,makeConvertedGlbCreation,type GlbConversionInput,type ConvertedGlbJob,type AssetJobResult,type JobOptions} from '../../packages/asset-pipeline/src/index.js';
import {parseConvertedGlbCreation,parseConvertedGlbJobMetadata} from '../../packages/asset-pipeline/src/converted-glb-creation.js';
import {sha256} from '../../packages/asset-pipeline/src/validation.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {nativeAssetJobPage,nativeAssetStart} from '../../apps/mcp/src/asset-schemas.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';

// Actual MCP/SDK/loopback HTTP, registry, service, SQLite and managed adopted
// parent files. Only the fixed pipeline producer is controlled: it writes real
// pending/failed journals, never a successful native manifest or runtime proof.
const CHAT='11111111-1111-4111-8111-111111111111',AT='2026-10-27T06:00:00.000Z';
function triangleGlb():Buffer {
  const bin=Buffer.alloc(80);
  [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0,1].forEach((v,i)=>bin.writeFloatLE(v,i*4));
  [0,1,2].forEach((v,i)=>bin.writeUInt16LE(v,72+i*2));
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}],
    buffers:[{byteLength:78}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,count:3,type:'VEC3'},{bufferView:2,componentType:5123,count:3,type:'SCALAR'}]};
  const text=Buffer.from(JSON.stringify(doc)),size=(text.length+3)&~3,out=Buffer.alloc(28+size+bin.length,0x20);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(size,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);
  out.writeUInt32LE(bin.length,20+size);out.writeUInt32LE(0x004e4942,24+size);bin.copy(out,28+size);return out;
}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()&&Date.now()<end)await new Promise(done=>setTimeout(done,5));assert.ok(check(),'Controlled completion reached its real service state');}
type Control={id:string;directory:string;input:GlbConversionInput;options:JobOptions;finish():void};
async function fixture(t:test.TestContext,provider:NativeConversation['provider']='codex'){
  const boundary=await realpath(tmpdir()),directory=await realpath(await mkdtemp(join(boundary,'arcane-native-conversion-'))),project=join(directory,'project');
  await mkdir(project);const canonical=await realpath(project),source=triangleGlb();await writeFile(join(project,'source.glb'),source);
  const store=new ConversationWorkStore({directory:join(directory,'bindings'),projectPath:canonical}),registry=createNativeAssetRegistry({projectPath:canonical});
  const controls:Control[]=[],posts:unknown[]=[],statuses:number[]=[],failures:unknown[]=[],peers:{client:Client;server:ReturnType<typeof createMcpServer>}[]=[];
  let service:AssetService|undefined,listener:ReturnType<typeof createServer>|undefined,origin='',selected=0,reads=0,sequence=0,refuse=false;
  const spawn=t.mock.method(childProcess,'spawn',()=>{throw Error('Native conversion fixture cannot launch a process.');});syncBuiltinESMExports();
  t.after(async()=>{
    try{for(const control of controls)control.finish();for(const peer of peers){await peer.client.close();await peer.server.close();}
      if(listener){listener.closeAllConnections();await new Promise<void>(done=>listener!.close(()=>done()));}await service?.close();}
    finally{registry.close();store.close();spawn.mock.restore();syncBuiltinESMExports();
      const part=relative(boundary,directory);assert.ok(!isAbsolute(part)&&part.startsWith('arcane-native-conversion-')&&!part.includes(sep)&&!part.includes('..'));
      assert.equal((await lstat(directory)).isSymbolicLink(),false);await rm(directory,{recursive:true,force:true});assert.deepEqual(failures,[]);}
  });
  function owner(kind:NativeConversation['provider']=provider,chat=CHAT){
    const incarnation=registry.issue(),credential=incarnation.credential(),connectionId='conversion-connection-'+(++sequence);
    const conversation:NativeConversation={provider:kind,threadId:kind==='codex'?'owned-thread-'+chat:'app:'+chat,sessionId:null};
    if(kind==='codex')incarnation.seal({connectionId,provider:kind,threadId:conversation.threadId,sessionId:null});
    else if(kind==='claude-code')incarnation.bindAppConversation({kind:'app-conversation',provider:kind,connectionId,conversationId:chat,
      transport:{kind:'claude-code-process',incarnationId:'controlled-process-'+sequence,nativeSessionId:null}});
    else incarnation.bindAppConversation({kind:'app-conversation',provider:kind,connectionId,conversationId:chat,
      transport:{kind:'arcane-gateway-loop',incarnationId:'controlled-loop-'+sequence}});
    const binding={connectionId,threadId:conversation.threadId};incarnation.grantNextIntent({...binding,sessionId:null});incarnation.dispatched({...binding,operationId:'conversion-operation-'+sequence});
    return{incarnation,credential,conversation,actor:()=>registry.capture(credential,'mutate')};
  }
  const current=owner(),outputRoot=join(directory,'assets');
  service=await createAssetService({cwd:directory,projectPath:canonical,outputRoot,studioImport:{workAssociations:store,
    selectTarget(){selected++;throw Error('No Studio target is permitted by this conversion fixture.');}}});
  const actualService=service;
  const host=createAssetConversationHost({projectPath:canonical,workAssociations:store,conversation:()=>current.conversation,
    start:async()=>{throw Error('No generated asset route in conversion fixture.');},
    adoptNative:async(input,actor,admission)=>(await actualService.adoptProjectGlb(input,actor,admission)).jobId,
    convertNative:async(input,actor,admission)=>(await actualService.convertProjectGlb(input,actor,admission)).jobId});
  t.mock.method(AssetPipeline.prototype,'startConversion',(input:GlbConversionInput,options:JobOptions={}):ConvertedGlbJob=>{
    if(refuse)throw new AssetError('BUSY','Controlled refusal before any pipeline job allocation.');
    const id=randomUUID(),target=join(outputRoot,input.name+'-'+id),parent=JSON.parse(input.parentManifest.toString('utf8')) as {jobId:string};
    const creation=makeConvertedGlbCreation(id,{parentJobId:parent.jobId,parentManifestSha256:input.parentManifestSha256,name:input.name,
      collision:input.collision,renderResolution:input.renderResolution,renderSamples:input.renderSamples});
    assert.deepEqual(parseConvertedGlbCreation(creation),creation);mkdirSync(target);
    const initial={schemaVersion:1,kind:'converted-glb',jobId:id,directory:target,manifestPath:null,creation,request:null,state:'running',startedAt:AT,workers:[],error:null};
    writeFileSync(join(target,'job.json'),JSON.stringify(initial)+'\n');let resolve!:(value:AssetJobResult)=>void,settled=false;
    const pending=new Promise<AssetJobResult>(done=>{resolve=done;});
    const control:Control={id,directory:target,input,options,finish(){if(settled)return;settled=true;
      const error={code:'ASSET_FAILED',message:'Controlled worker refusal; no native conversion success.'};
      writeFileSync(join(target,'job.json'),JSON.stringify({...initial,state:'failed',error,finishedAt:AT})+'\n');
      resolve({jobId:id,directory:target,state:'failed',manifestPath:null,error});}};
    controls.push(control);const abort=()=>control.finish();options.signal?.addEventListener('abort',abort,{once:true});
    return Object.freeze({id,directory:target,creation,completion:pending.finally(()=>options.signal?.removeEventListener('abort',abort)),cancel:abort});
  });
  const route=nativeAssetRoutes(actualService,host,registry);
  listener=createServer((request,response)=>{
    const url=new URL(request.url??'/',origin);
    if(request.method==='POST'&&url.pathname==='/v1/assets/native/convert-glb'){
      const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(Buffer.from(chunk)));request.once('end',()=>posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      response.once('finish',()=>statuses.push(response.statusCode));
    }
    if(request.method==='GET')reads++;
    void route(request,response,url,origin).then(handled=>{if(!handled){response.writeHead(404);response.end('{}');}}).catch(error=>{failures.push(error);response.destroy();});
  });
  await new Promise<void>(done=>listener!.listen(0,'127.0.0.1',done));const address=listener.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
  const sdk=(credential=current.credential)=>new DaemonClient({url:origin,token:provider==='codex'?credential:'c'.repeat(43),assetAudience:'native-session',...(provider==='codex'?{}:{assetToken:credential})});
  async function mcp(){const server=createMcpServer({client:sdk(),projectRoot:canonical}),client=new Client({name:'actual-native-conversion-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    peers.push({client,server});await Promise.all([server.connect(a),client.connect(b)]);return client;}
  const call=(input:unknown,credential=current.credential)=>fetch(origin+'/v1/assets/native/convert-glb',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
  const adopted=nativeAssetStart.parse(await sdk().assetsAdoptGlb({name:'original-card',path:'source.glb'}));assert.equal(adopted.association,'bound');assert.equal(adopted.creation,'created');assert.ok(adopted.jobId);
  const parentId=adopted.jobId,parentDirectory=join(outputRoot,'original-card-'+parentId),parentManifest=await readFile(join(parentDirectory,'manifest.json'));
  return{directory,project:canonical,source,store,registry,current,owner,service:actualService,host,controls,posts,statuses,reads:()=>reads,sdk,mcp,call,parentId,parentDirectory,parentManifest,
    selected:()=>selected,spawns:()=>spawn.mock.callCount(),refuse(){refuse=true;},
    input:()=>({parentJobId:parentId,name:'derived-card',collision:'none' as const,renderResolution:256,renderSamples:8})};
}

for(const provider of ['codex','claude-code','arcane'] as const)test(provider+' MCP conversion reaches actual managed-parent custody and exposes truthful child history',{timeout:15000},async t=>{
  const f=await fixture(t,provider),client=await f.mcp();
  const tool=(await client.listTools()).tools.find(row=>row.name==='assets_convert_glb');assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,false);assert.equal(tool.annotations?.idempotentHint,false);
  await writeFile(join(f.project,'source.glb'),Buffer.from('changed borrowed original source'));
  const before=f.reads(),result=await client.callTool({name:'assets_convert_glb',arguments:f.input()});assert.notEqual(result.isError,true);
  const ack=nativeAssetStart.parse(result.structuredContent);assert.ok(ack.jobId);assert.equal(ack.association,'bound');assert.equal(ack.creation,'created');assert.equal(ack.retry,false);
  assert.deepEqual(ack.conversation,f.current.conversation);assert.equal(ack.projectId,f.store.projectId);assert.deepEqual(f.posts,[f.input()]);assert.equal(f.reads(),before,'Creation never polls history automatically');
  assert.deepEqual(f.statuses,[200]);
  assert.equal(f.controls.length,1);const control=f.controls[0]!;assert.equal(control.id,ack.jobId);assert.deepEqual(control.input.sourceGlb,f.source);assert.deepEqual(control.input.parentManifest,f.parentManifest);
  assert.equal(control.input.parentManifestSha256,sha256(f.parentManifest));assert.equal(control.options.signal?.aborted,false);
  const child=f.service.jobs().find(job=>job.jobId===ack.jobId);assert.ok(child&&child.kind==='converted-glb'&&child.form==='new-pending');assert.equal(child.form,'new-pending');assert.equal(child.request,null);assert.equal(child.manifestAvailable,false);
  assert.equal(child.state,'running');
  assert.equal(child.creation.parentJobId,f.parentId);assert.equal(child.creation.parentManifestSha256,sha256(f.parentManifest));assert.deepEqual(parseConvertedGlbCreation(child.creation),child.creation);
  assert.deepEqual(f.store.binding('asset-job',ack.jobId)?.conversation,f.current.conversation);
  const metadata=parseConvertedGlbJobMetadata(JSON.parse(await readFile(join(control.directory,'job.json'),'utf8')));assert.equal(metadata.form,'new-pending');assert.equal(metadata.request,null);
  const pending=nativeAssetJobPage.parse(await f.sdk().assetsJobs());const visible=pending.jobs.find(job=>job.jobId===ack.jobId);assert.ok(visible&&visible.kind==='converted-glb');assert.equal(visible.request,null);assert.equal(visible.form,'new-pending');
  await assert.rejects(f.service.modelReviewSubject(ack.jobId,{projectId:f.store.projectId,conversation:f.current.conversation}),{code:'ASSET_REVIEW_JOB_STATE'});
  await assert.rejects(f.service.prepareStudioImport(ack.jobId,f.current.actor()),{code:'JOB_STATE'});assert.equal(f.selected(),0);
  control.finish();await until(()=>f.service.jobs().find(job=>job.jobId===ack.jobId)?.state==='failed');
  const ended=nativeAssetJobPage.parse(await f.sdk().assetsJobs()).jobs.find(job=>job.jobId===ack.jobId);assert.ok(ended&&ended.kind==='converted-glb');assert.equal(ended.request,null);assert.equal(ended.state,'failed');assert.equal(ended.error?.code,'ASSET_FAILED');
  assert.equal(ended.manifestAvailable,false);assert.equal(f.spawns(),0);assert.deepEqual(await readFile(join(f.parentDirectory,'asset.glb')),f.source);assert.equal(f.posts.length,1);
});

test('a committed child binding with an uncertain ACK returns202 and never replays conversion',{timeout:15000},async t=>{
  const f=await fixture(t),client=await f.mcp(),bind=f.store.bind.bind(f.store);let writes=0;
  t.mock.method(f.store,'bind',(...args:Parameters<ConversationWorkStore['bind']>)=>{bind(...args);writes++;throw new Error('Controlled lost return after actual SQLite binding commit.');});
  const before=f.reads(),result=await client.callTool({name:'assets_convert_glb',arguments:f.input()});assert.notEqual(result.isError,true);const ack=nativeAssetStart.parse(result.structuredContent);
  assert.deepEqual(f.statuses,[202]);assert.equal(f.reads(),before);
  assert.ok(ack.jobId);assert.equal(ack.creation,'unknown');assert.equal(ack.association,'unknown');assert.equal(ack.retry,false);assert.equal(writes,1);assert.equal(f.posts.length,1);assert.equal(f.controls.length,1);
  assert.deepEqual(f.store.binding('asset-job',ack.jobId)?.conversation,f.current.conversation);assert.equal(f.service.jobs().filter(job=>job.kind==='converted-glb').length,1);
  const visible=nativeAssetJobPage.parse(await f.sdk().assetsJobs()).jobs.find(job=>job.jobId===ack.jobId);assert.ok(visible&&visible.kind==='converted-glb');assert.equal(visible.request,null);assert.equal(f.posts.length,1);
  f.controls[0]!.finish();await until(()=>f.service.jobs().find(job=>job.jobId===ack.jobId)?.state==='failed');assert.equal(writes,1);assert.equal(f.posts.length,1);assert.equal(f.spawns(),0);
});

test('actual parent conversation and registry project scope refuse before child allocation',{timeout:15000},async t=>{
  const f=await fixture(t),foreign=f.owner('codex','22222222-2222-4222-8222-222222222222');
  const denied=await f.call(f.input(),foreign.credential);assert.equal(denied.status,503);assert.equal((await denied.json() as {error:string}).error,'ASSET_CONVERT_SCOPE');
  const otherProject=join(f.directory,'other-project');await mkdir(otherProject);const other=createNativeAssetRegistry({projectPath:await realpath(otherProject)});t.after(()=>other.close());
  const unknown=other.issue(),binding={connectionId:'other-project-connection',threadId:'other-project-thread'};
  unknown.seal({...binding,provider:'codex',sessionId:null});unknown.grant(binding);unknown.dispatched({...binding,operationId:'other-project-operation'});
  assert.ok(other.capture(unknown.credential(),'mutate'));
  const wrongProject=await f.call(f.input(),unknown.credential());assert.equal(wrongProject.status,403);assert.equal((await wrongProject.json() as {error:string}).error,'NATIVE_ASSET_AUTHORITY');
  assert.equal(f.controls.length,0);assert.equal(f.service.jobs().length,1);assert.deepEqual(f.store.list(foreign.conversation,'asset-job').items,[]);assert.equal(f.spawns(),0);
});

test('a controlled pipeline allocation refusal remains an uncertain single attempt without invented child metadata',{timeout:15000},async t=>{
  const f=await fixture(t);f.refuse();const before=f.reads();
  const ack=nativeAssetStart.parse(await f.sdk().assetsConvertGlb(f.input(),{timeoutMs:2000}));
  assert.equal(ack.creation,'unknown');assert.equal(ack.association,'unknown');assert.equal(ack.jobId,null);assert.equal(ack.retry,false);
  assert.deepEqual(f.posts,[f.input()]);assert.equal(f.reads(),before);assert.equal(f.controls.length,0);assert.equal(f.service.jobs().length,1);assert.equal(f.store.list(f.current.conversation,'asset-job').items.length,1);assert.equal(f.spawns(),0);
});
