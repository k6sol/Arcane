import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,lstatSync,rmSync} from 'node:fs';
import { homedir } from 'node:os';
import {join,relative,resolve,isAbsolute,sep} from 'node:path';
import type {AddressInfo} from 'node:net';
import {WorkStore} from '../../packages/storage/src/work-store.js';
import {ConversationWorkStore,type NativeConversation} from '../../packages/storage/src/conversation-work-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {createWorkflowHost,workflowReceiptParent,type WorkflowPreview,type WorkflowEvidencePreparationResponse,type WorkflowDraftResponse} from '../../apps/daemon/src/workflow-host.js';
import {workflowRoutes} from '../../apps/daemon/src/workflow-routes.js';
import type {RequestedModel,WorkflowRecipeRequest} from '../../packages/core/src/workflow-recipes.js';
import type {WorkflowSnapshot} from '../../apps/daemon/src/workflow-service.js';
import type {Connection} from '../../packages/protocol/src/providers.js';

const native:NativeConversation={provider:'codex',threadId:'assistance-fixture-thread',sessionId:'assistance-fixture-session'};
const model:RequestedModel={provider:'codex',model:'assistance-fixture',effort:'high',connectionRevision:'fixture-current'};
const connection:Connection={provider:'codex',installed:true,version:'fixture-only',auth:'subscription',plan:null,
  models:[{id:model.model,label:'Synthetic metadata',efforts:['high'],defaultEffort:'high',source:'runtime-catalogue',entitlement:'unverified',inputModalities:['text']}],
  features:[{id:'coding',label:'Fixture handoff',state:'native-handoff',route:'native-client',reason:'Offline fixture only.'}],warnings:[],observedAt:'2026-10-12T00:00:00Z',revision:model.connectionRevision};
interface Reply {status:number;value:Record<string,unknown>}
async function fixture(t:test.TestContext){
  const root=makeFixtureDirectory('arcane-assistance-http-'),projectPath=join(root,'project'),directory=join(root,'state');
  mkdirSync(join(projectPath,'src'),{recursive:true});
  const work=new WorkStore({directory,projectPath}),associations=new ConversationWorkStore({directory:join(root,'associations'),projectPath});
  const receiptParent=workflowReceiptParent(directory,workflowProjectIdentity(projectPath).projectId);
  let currentNative:NativeConversation|null={...native},currentModel:RequestedModel|null={...model};
  const host=createWorkflowHost({directory,projectPath,workStore:{store:work,projectPath},workAssociations:associations,
    conversation:()=>currentNative,modelSelection:()=>currentModel,policyContext:()=>({connections:[connection],capabilities:[]})});
  const routes=workflowRoutes(host),token='fixture-human-'+randomUUID(),agent='fixture-agent-'+randomUUID();let origin='';
  const server=createServer((request,response)=>{void routes(request,response,new URL(request.url??'/',origin),token,origin,agent).then(handled=>{if(!handled){response.writeHead(404);response.end();}});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  t.after(async()=>{host.close();associations.close();work.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    const part=relative(fixtureTempDirectory(),resolve(root));assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep)&&!lstatSync(root).isSymbolicLink());
    if(process.platform==='win32'){assert.match(relative(resolve(homedir(),'.arcane-private-receipts-v1'),resolve(receiptParent)),/^[a-f0-9]{64}$/);assert.ok(!lstatSync(receiptParent).isSymbolicLink());rmSync(resolve(receiptParent),{recursive:true,force:true});}
    rmSync(resolve(root),{recursive:true,force:true});});
  const call=(path:string,input?:unknown,overrides:{token?:string;origin?:string;method?:string}={}):Promise<Reply>=>new Promise((done,reject)=>{
    const body=input===undefined?undefined:JSON.stringify(input);
    const req=httpRequest(origin+path,{method:overrides.method??(body?'POST':'GET'),headers:{Authorization:'Bearer '+(overrides.token??token),Origin:overrides.origin??origin,...(body?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}:{})}},res=>{
      const chunks:Buffer[]=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>{try{done({status:res.statusCode!,value:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>});}catch(e){reject(e);}});res.on('error',reject);});
    req.setTimeout(20000,()=>req.destroy(new Error('Owned fixture deadline')));req.on('error',reject);req.end(body);});
  const preview=async(input:unknown)=>{const r=await call('/v1/workflows/preview',input);assert.equal(r.status,200,JSON.stringify(r.value));return r.value as unknown as WorkflowPreview;};
  const execute=async(p:WorkflowPreview)=>{const r=await call('/v1/workflows/execute',{preview:p,idempotencyKey:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.value));return r.value as unknown as WorkflowSnapshot;};
  const request:WorkflowRecipeRequest={deliverable:'code-change',engine:'roblox',title:'Readonly assistance fixture',prompt:'Repair the scoped movement feature using actual evidence.',scope:['src'],model};
  const created=await execute(await preview({action:'recipe',request})),workflowId=created.workflow.id;
  let readyCalls=0;const ready=work.ready.bind(work);work.ready=(...args:Parameters<typeof work.ready>)=>{readyCalls++;return ready(...args);};
  return {root,projectPath,work,workflowId,call,preview,execute,created,agent,get readyCalls(){return readyCalls;},
    native(value:NativeConversation|null){currentNative=value;},model(value:RequestedModel|null){currentModel=value;},
    file(path:string,text:string){writeFileSync(join(projectPath,path),text);return{path,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};}};
}

test('actual files prepare exact evidence without submissions, leases, writes or fabricated quality',async t=>{
  const f=await fixture(t),actual=f.file('src/brief.txt','Actual human request: repair movement.'),before=f.work.runs(),ready=f.readyCalls;
  const r=await f.call('/v1/workflows/evidence',{workflowId:f.workflowId,stepKey:'prompt',files:[{path:actual.path,role:'brief'}]});
  assert.equal(r.status,200,JSON.stringify(r.value));const data=r.value as unknown as WorkflowEvidencePreparationResponse;
  assert.equal(data.workflowId,f.workflowId);assert.equal(data.workflowRevision,f.created.workflow.revision);assert.deepEqual(data.conversation,native);
  assert.deepEqual(data.submission,{key:'prompt',artifacts:[{...actual,role:'brief'}],subjectHashes:[],checks:[]});
  assert.equal(f.readyCalls,ready);assert.deepEqual(f.work.runs(),before);assert.equal(readFileSync(join(f.projectPath,actual.path),'utf8'),'Actual human request: repair movement.');
  const p=await f.preview({action:'handoff',workflowId:f.workflowId,submission:data.submission});await f.execute(p);
  writeFileSync(join(f.projectPath,actual.path),'Changed after submission');
  assert.equal((await f.call('/v1/workflows/evidence',{workflowId:f.workflowId,stepKey:'requirements',files:[{path:actual.path,role:'requirements'}]})).status,409);
});

test('approved native step creates only a pinned same-chat draft and stale/missing model proofs deny',async t=>{
  const f=await fixture(t),actual=f.file('src/brief.txt','Real scoped fixture input.');
  const prepared=await f.call('/v1/workflows/evidence',{workflowId:f.workflowId,stepKey:'prompt',files:[{path:actual.path,role:'brief'}]});
  await f.execute(await f.preview({action:'handoff',workflowId:f.workflowId,submission:(prepared.value as unknown as WorkflowEvidencePreparationResponse).submission}));
  await f.execute(await f.preview({action:'review',workflowId:f.workflowId,stepKey:'prompt',decision:'approved'}));
  assert.equal((await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'requirements'})).status,409,'No handoff before explicit model gate');
  await f.execute(await f.preview({action:'gate',workflowId:f.workflowId,stepKey:'requirements',gate:'model-handoff',decision:'approved'}));
  const before=f.work.runs(),ready=f.readyCalls,r=await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'requirements'});
  assert.equal(r.status,200,JSON.stringify(r.value));const data=r.value as unknown as WorkflowDraftResponse;
  assert.deepEqual(data.conversation,native);assert.deepEqual(data.model,model);assert.equal(data.requiresHumanSubmit,true);assert.equal(data.startsNativeTurn,false);
  assert.ok(data.text.includes(actual.path)&&data.text.includes(actual.sha256));assert.ok(data.text.includes('untrusted evidence'));
  assert.ok(!data.text.includes('Real scoped fixture input.'),'File contents must not be copied into the draft by the host');
  assert.equal(f.readyCalls,ready);assert.deepEqual(f.work.runs(),before);
  f.model({...model,connectionRevision:'changed-current'});assert.equal((await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'requirements'})).status,409);
  f.model(null);assert.equal((await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'requirements'})).status,409);
  f.model(model);f.native({...native,threadId:'different-native'});assert.equal((await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'requirements'})).status,403);
});

test('assistance routes retain human-only input, origin, fields, project/private paths and readonly-step guards',async t=>{
  const f=await fixture(t);f.file('src/brief.txt','Actual request');
  const evidence={workflowId:f.workflowId,stepKey:'prompt',files:[{path:'src/brief.txt',role:'brief'}]};
  for(const endpoint of ['evidence','draft']){
    const input=endpoint==='evidence'?evidence:{workflowId:f.workflowId,stepKey:'requirements'};
    assert.equal((await f.call('/v1/workflows/'+endpoint,input,{token:f.agent})).status,403);
    assert.equal((await f.call('/v1/workflows/'+endpoint,input,{origin:'https://invalid.example'})).status,403);
    assert.equal((await f.call('/v1/workflows/'+endpoint,undefined,{method:'GET'})).status,405);
    assert.equal((await f.call('/v1/workflows/'+endpoint,input,{method:'GET'})).status,400,'GET bodies are rejected by the shared human request guard');
    assert.equal((await f.call('/v1/workflows/'+endpoint,{...input,model,command:'no'})).status,400);
    assert.equal((await f.call('/v1/workflows/'+endpoint+'?scope=other',input)).status,400);
  }
  assert.equal((await f.call('/v1/workflows/evidence',{...evidence,files:[{path:'../state/workflows.sqlite',role:'brief'}]})).status,400);
  assert.equal((await f.call('/v1/workflows/evidence',{...evidence,stepKey:'verification',files:[{path:'src/brief.txt',role:'report'}]})).status,409);
  assert.equal((await f.call('/v1/workflows/draft',{workflowId:f.workflowId,stepKey:'prompt'})).status,409);
});
