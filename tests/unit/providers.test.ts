import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { ReadonlyCodexRpc } from '../../packages/model-adapters/src/codex-rpc.js';
import { boundedCommand, spawnNative } from '../../packages/model-adapters/src/process.js';
import { normalizeCodexModels, normalizeCodexAuth, normalizeClaudeAuth, claudeModelsFromHelp, emptyConnection, featuresFor, reconcileFeatureStates } from '../../packages/model-adapters/src/catalogue.js';
import { SelectionStore, validateSelection, atomicPreferenceReplace } from '../../packages/core/src/selection.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import type { Connection } from '../../packages/protocol/src/providers.js';

const ROOT = resolve(process.cwd());
const TEMP = join(ROOT, 'tests', '.tmp');
async function directory(t: test.TestContext) {
  await mkdir(TEMP, { recursive: true }); const dir = await mkdtemp(join(TEMP, 'arcane-provider-test-'));
  t.after(async () => { const r = relative(TEMP, dir); assert.ok(r.startsWith('arcane-provider-test-') && !r.includes(sep)); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
function connection(): Connection {
  return { ...emptyConnection('codex'), installed: true, auth: 'subscription', revision: 'revision-1',
    models: [{ id: 'gpt-6.1-sol', label: 'Sol 6.1', efforts: ['low', 'ultra'], defaultEffort: 'low', source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text','image'] }] };
}
const request = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', connectionRevision: 'revision-1' };
const catalogue = { data: [{ model: 'gpt-6.1-sol', displayName: 'Sol 6.1', supportedReasoningEfforts: [{reasoningEffort:'low'},{reasoningEffort:'ultra'}], defaultReasoningEffort:'low', inputModalities:['text','image'] }], nextCursor: null };
const rejectCode = (run: () => Promise<unknown>, code: string) => assert.rejects(run, (error: unknown) => (error as {code?:string}).code === code);

test('runtime catalogue retains exact Sol model and Ultra effort without entitlement claims', () => {
  const result = normalizeCodexModels(catalogue); assert.equal(result.models[0]?.id, 'gpt-6.1-sol'); assert.deepEqual(result.models[0]?.efforts, ['low','ultra']); assert.equal(result.models[0]?.entitlement, 'unverified');
});
test('hidden models are not offered and duplicate identifiers fail', () => {
  assert.deepEqual(normalizeCodexModels({data:[{hidden:true}],nextCursor:null}).models, []);
  assert.throws(() => normalizeCodexModels({...catalogue,data:[...catalogue.data,...catalogue.data]}), {code:'CATALOGUE'});
});
test('unknown effort fails explicitly instead of becoming a lower effort', () => {
  assert.throws(() => normalizeCodexModels({data:[{...catalogue.data[0],supportedReasoningEfforts:[{reasoningEffort:'future-ultra'}]}]}), {code:'CATALOGUE'});
});
test('missing or duplicate effort catalogue is not guessed', () => {
  assert.throws(() => normalizeCodexModels({data:[{model:'custom'}]}), {code:'CATALOGUE'});
  assert.throws(() => normalizeCodexModels({data:[{...catalogue.data[0],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'low'}]}]}), {code:'CATALOGUE'});
});
test('sanitized Codex auth never contains account email or tokens', () => {
  const result=normalizeCodexAuth({account:{type:'chatgpt',planType:'pro',email:'dummy@example.test',access_token:'DUMMY-SECRET'}});
  assert.deepEqual(result,{auth:'subscription',plan:'pro'}); assert.ok(!JSON.stringify(result).includes('DUMMY'));
});
test('API and cloud accounts are not labelled as subscriptions', () => {
  assert.equal(normalizeCodexAuth({account:{type:'apiKey'}}).auth,'api-or-cloud');
  assert.equal(normalizeCodexAuth({account:{type:'amazonBedrock'}}).auth,'api-or-cloud');
  assert.equal(normalizeClaudeAuth({loggedIn:true,authMethod:'api-key',apiProvider:'firstParty'}).auth,'api-or-cloud');
});
test('Claude status is sanitized and signed-out remains signed-out', () => {
  assert.deepEqual(normalizeClaudeAuth({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'dummy@example.test'}),{auth:'subscription',plan:'max'});
  assert.equal(normalizeClaudeAuth({loggedIn:false}).auth,'signed-out');
});
test('Claude aliases and effort flags come from installed help, not invented model entitlement', () => {
  const help="  --effort <level> (low, medium, high, xhigh, max)\n  --model <model> Alias e.g. 'fable', 'opus', 'sonnet', or full 'claude-fable-5'.\n  --name <name>";
  const models=claudeModelsFromHelp(help); assert.deepEqual(models.map(m=>m.id),['fable','opus','sonnet']); assert.equal(models[0]?.source,'native-cli-alias'); assert.ok(!models[0]?.efforts.includes('ultra')); assert.equal(models[0]?.entitlement,'unverified');
  assert.deepEqual(claudeModelsFromHelp('unknown CLI version'),[]);
});
test('features do not claim image/design/voice tools are embedded or unrestricted', () => {
  for(const provider of ['codex','claude'] as const) {
    const features=featuresFor(provider,true);
    for(const id of ['image-generation','design','voice-video','plugins']) assert.notEqual(features.find(f=>f.id===id)?.state,'available');
  }
});
test('failed native discovery removes available selection/auth claims', () => {
  const c=emptyConnection('codex'); c.installed=true; c.features=featuresFor('codex',true); reconcileFeatureStates(c);
  assert.equal(c.features.find(f=>f.id==='auth-status')?.state,'unverified');
  assert.equal(c.features.find(f=>f.id==='model-selection')?.state,'requires-setup');
});
test('selection saves requested Ultra without pretending it ran', () => {
  const selected=validateSelection(request,[connection()]); assert.equal(selected.model,'gpt-6.1-sol'); assert.equal(selected.effort,'ultra'); assert.equal(selected.applied,false);
});
test('unknown model or unsupported effort cannot silently fall back', () => {
  for(const input of [{...request,model:'gpt-unknown'},{...request,effort:'max'}]) assert.throws(()=>validateSelection(input,[connection()]),{code:'SELECTION'});
});
test('stale catalogue and disconnected provider cannot accept selection', () => {
  assert.throws(()=>validateSelection({...request,connectionRevision:'old'},[connection()]),{code:'STALE_CONNECTION'});
  assert.throws(()=>validateSelection(request,[{...connection(),installed:false}]),{code:'STALE_CONNECTION'});
});
test('API billing mode and invalid payloads are refused by subscription-first preference save', () => {
  assert.throws(()=>validateSelection(request,[{...connection(),auth:'api-or-cloud'}]),{code:'BILLING_MODE'});
  for(const input of [null,[],{...request,provider:'unknown'},{...request,model:'\n'}]) assert.throws(()=>validateSelection(input,[connection()]));
});
test('preference storage round-trips and serializes concurrent writes', async t => {
  const dir=await directory(t), store=new SelectionStore(dir); assert.equal(await store.read(),null);
  const first=validateSelection(request,[connection()]), second={...first,effort:'low' as const};
  await Promise.all([store.save(first),store.save(second)]); assert.deepEqual(await store.read(),second);
});
test('corrupt and oversized preference state is not reset by read', async t => {
  const dir=await directory(t), store=new SelectionStore(dir), file=join(dir,'selection.json');
  await writeFile(file,'not JSON'); await rejectCode(()=>store.read(),'STATE'); assert.equal(await readFile(file,'utf8'),'not JSON');
  await writeFile(file,'x'.repeat(9000)); await rejectCode(()=>store.read(),'STATE');
});

const worker = `
const readline=require('node:readline'); const mode=process.argv[1];
const lines=readline.createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
lines.on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 if(mode==='timeout')return;
 if(mode==='invalid'){process.stdout.write('not-json\\n');return;}
 if(mode==='huge'){process.stdout.write('x'.repeat(4096));return;}
 if(mode==='disconnect'){process.exit(0);return;}
 if(mode==='action' && m.method==='model/list'){send({id:77,method:'item/commandExecution/requestApproval',params:{command:'DO-NOT-EXECUTE'}});return;}
 if(m.id===77){send({id:2,result:{refused:m.error?.code===-32601}});return;}
 if(mode==='error'){send({id:m.id,error:{code:-1,message:'DUMMY-SECRET'}});return;}
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'fixture'}});return;}
 if(mode==='chunk'){const b=Buffer.from(JSON.stringify({id:m.id,result:{text:'café 🧩'}})+'\\n');const p=b.indexOf(Buffer.from('🧩'))+1;process.stdout.write(b.subarray(0,p));setTimeout(()=>process.stdout.write(b.subarray(p)),5);return;}
 send({id:m.id,result:{method:m.method,params:m.params}});
});`;
function rpc(t:test.TestContext, mode='normal', timeout=1000, limit=1048576) {
  const client=new ReadonlyCodexRpc({command:process.execPath,args:['-e',worker,mode],cwd:ROOT},timeout,limit);
  t.after(()=>client.close()); return client;
}
test('read-only RPC initializes and matches request IDs', async t => {
  const client=rpc(t); await client.initialize(); const result=await client.request('model/list',{limit:20}) as {method:string}; assert.equal(result.method,'model/list');
});
test('RPC cannot run inference, edits, login, tools or token refresh', async t => {
  const client=rpc(t);
  for(const method of ['turn/start','thread/start','account/login/start','config/value/write','fs/writeFile']) await rejectCode(()=>client.request(method,{}),'READ_ONLY');
  await rejectCode(()=>client.request('account/read',{refreshToken:true}),'READ_ONLY');
});
test('provider-initiated tool approvals are refused rather than granted', async t => {
  const client=rpc(t,'action'); await client.initialize(); const result=await client.request('model/list',{}) as {refused:boolean}; assert.equal(result.refused,true);
});
test('RPC decodes Unicode safely across chunk boundaries', async t => {
  const client=rpc(t,'chunk'); const result=await client.request('model/list',{}) as {text:string}; assert.equal(result.text,'café 🧩');
});
test('RPC timeout closes and rejects subsequent work', async t => {
  const client=rpc(t,'timeout',100); await rejectCode(()=>client.request('model/list',{}),'RPC_TIMEOUT'); await rejectCode(()=>client.request('model/list',{}),'RPC_CLOSED');
});
test('malformed or oversized RPC frames fail closed', async t => {
  await rejectCode(()=>rpc(t,'invalid').request('model/list',{}),'RPC_PROTOCOL');
  await rejectCode(()=>rpc(t,'huge',1000,512).request('model/list',{}),'RPC_LIMIT');
});
test('disconnect and remote errors never expose raw account diagnostics', async t => {
  await rejectCode(()=>rpc(t,'disconnect').request('model/list',{}),'RPC_CLOSED');
  await assert.rejects(()=>rpc(t,'error').request('model/list',{}),(e:unknown)=> (e as Error).message==='Native CLI rejected the discovery request.');
});
test('process runner rejects relative executable paths and bounds metadata output', async () => {
  assert.throws(()=>spawnNative({command:'node',args:[],cwd:ROOT}),{code:'PROCESS_PATH'});
  await rejectCode(()=>boundedCommand({command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(9000))"],cwd:ROOT},1000,512),'PROCESS_LIMIT');
});
test('process runner times out and does not invoke a shell', async () => {
  await rejectCode(()=>boundedCommand({command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],cwd:ROOT},100),'PROCESS_TIMEOUT');
  const result=await boundedCommand({command:process.execPath,args:['-e',"console.log(process.argv[1])",'literal & no-shell'],cwd:ROOT}); assert.equal(result.stdout.trim(),'literal & no-shell');
});
async function lab(t:test.TestContext) {
  const dir=await directory(t);
  const l=await createConnectionLab({cwd:ROOT,stateDirectory:dir,probe:async()=>[connection()]});t.after(()=>l.close());
  const headers={Authorization:'Bearer '+l.token,Origin:l.origin,'Content-Type':'application/json'};
  const post=(route:string,body:unknown)=>fetch(l.origin+route,{method:'POST',headers,body:JSON.stringify(body)});
  return {...l,dir,headers,post};
}
test('local API refuses missing bearer and cross-origin/host access', async t => {
  const l=await lab(t);
  assert.equal((await fetch(l.origin+'/v1/state')).status,401);
  assert.equal((await fetch(l.origin+'/v1/state',{headers:{...l.headers,Origin:'https://outside.example'}})).status,403);
  // Node fetch normalizes Host; use a real HTTP request to exercise a forged header.
  const forgedHost = await new Promise<number>((resolve,reject)=>{
    const req=httpRequest(l.origin+'/v1/state',{headers:{...l.headers,Host:'evil.example'}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode??0));
    });req.on('error',reject);req.end();
  });
  assert.equal(forgedHost,403);
  assert.equal((await fetch(l.origin+'/v1/probe',{method:'POST',headers:{Authorization:'Bearer '+l.token,'Content-Type':'application/json'},body:'{}'})).status,403);
});
test('public panel does not contain session token and has restrictive security headers', async t => {
  const l=await lab(t), response=await fetch(l.origin+'/'); const html=await response.text();
  assert.ok(!html.includes(l.token)); assert.match(response.headers.get('content-security-policy')??'',/frame-ancestors 'none'/); assert.equal(response.headers.get('referrer-policy'),'no-referrer');
});
test('metadata probe then exact selection works without launching any inference', async t => {
  const l=await lab(t); assert.equal((await l.post('/v1/probe',{})).status,200);
  const response=await l.post('/v1/selection',request); assert.equal(response.status,200);
  const state=await(await fetch(l.origin+'/v1/state',{headers:l.headers})).json() as {selection:{effort:string,applied:boolean},inferenceRuns:number};
  assert.equal(state.selection.effort,'ultra');assert.equal(state.selection.applied,false);assert.equal(state.inferenceRuns,0);
});
test('local API rejects stale pairs, invalid JSON, oversized requests and arbitrary routes', async t => {
  const l=await lab(t); await l.post('/v1/probe',{});
  assert.equal((await l.post('/v1/selection',{...request,connectionRevision:'stale'})).status,409);
  assert.equal((await fetch(l.origin+'/v1/selection',{method:'POST',headers:l.headers,body:'not-json'})).status,400);
  assert.equal((await l.post('/v1/selection',{huge:'x'.repeat(17000)})).status,400);
  assert.equal((await l.post('/v1/inference',{})).status,404);
  assert.equal((await fetch(l.origin+'/constructor',{headers:l.headers})).status,404);
  assert.equal((await fetch(l.origin+'/__proto__',{headers:l.headers})).status,404);
});
test('corrupt saved preference remains untouched even when save is requested', async t => {
  const dir=await directory(t); await writeFile(join(dir,'selection.json'),'DO NOT OVERWRITE');
  const l=await createConnectionLab({cwd:ROOT,stateDirectory:dir,probe:async()=>[connection()]});t.after(()=>l.close());
  const headers={Authorization:'Bearer '+l.token,Origin:l.origin,'Content-Type':'application/json'};
  await fetch(l.origin+'/v1/probe',{method:'POST',headers,body:'{}'});
  assert.equal((await fetch(l.origin+'/v1/selection',{method:'POST',headers,body:JSON.stringify(request)})).status,400);
  assert.equal(await readFile(join(dir,'selection.json'),'utf8'),'DO NOT OVERWRITE');
});
test('parallel metadata probes are bounded instead of starting duplicate subprocesses', async t => {
  const dir=await directory(t); let finish:(v:Connection[])=>void=()=>{};
  let signalStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{signalStarted=resolve;});
  const l=await createConnectionLab({cwd:ROOT,stateDirectory:dir,probe:()=>new Promise(resolve=>{finish=resolve;signalStarted();})});t.after(()=>l.close());
  const headers={Authorization:'Bearer '+l.token,Origin:l.origin,'Content-Type':'application/json'};
  const first=fetch(l.origin+'/v1/probe',{method:'POST',headers,body:'{}'});
  await started;
  const second=await fetch(l.origin+'/v1/probe',{method:'POST',headers,body:'{}'});
  assert.equal(second.status,409); finish([connection()]); assert.equal((await first).status,200);
});

test('completed request body deadline does not interrupt native metadata discovery', async t => {
  const dir=await directory(t);
  let finish:(v:Connection[])=>void=()=>{}, signalStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{signalStarted=resolve;});
  const l=await createConnectionLab({cwd:ROOT,stateDirectory:dir,probe:()=>new Promise(resolve=>{finish=resolve;signalStarted();})});t.after(()=>l.close());
  let incoming:IncomingMessage|undefined;
  l.server.on('request', req=>{incoming=req;});
  const pending=fetch(l.origin+'/v1/probe',{method:'POST',headers:{Authorization:'Bearer '+l.token,Origin:l.origin,'Content-Type':'application/json'},body:'{}'});
  await started;
  assert.equal(incoming?.socket.timeout,0);
  finish([connection()]);assert.equal((await pending).status,200);
});



test('Windows preference replacement retries transient locks with bounded backoff and keeps atomic rename',async t=>{
  const dir=await directory(t),target=join(dir,'selection.json');let attempts=0;const waits:number[]=[];
  const move:typeof rename=async(source,dest)=>{assert.equal(await readFile(target,'utf8'),'original');if(attempts++<2)throw Object.assign(new Error('Fixture sharing lock'),{code:'EPERM'});await rename(source,dest);};
  await writeFile(target,'original');const store=new SelectionStore(dir,(source,dest)=>atomicPreferenceReplace(source,dest,move,'win32',async ms=>{waits.push(ms);}));
  const next=validateSelection(request,[connection()]);await store.save(next);assert.deepEqual(await store.read(),next);assert.equal(attempts,3);assert.deepEqual(waits,[25,50]);assert.deepEqual(await readdir(dir),['selection.json']);
});

test('persistent replacement lock preserves original and later queued writes recover without deleting it',async t=>{
  const dir=await directory(t),target=join(dir,'selection.json'),original=validateSelection(request,[connection()]);await new SelectionStore(dir).save(original);
  let locked=true,attempts=0;const waits:number[]=[];const move:typeof rename=async(source,dest)=>{attempts++;if(locked)throw Object.assign(new Error('Fixture lock'),{code:'EACCES'});await rename(source,dest);};
  const store=new SelectionStore(dir,(source,dest)=>atomicPreferenceReplace(source,dest,move,'win32',async ms=>{waits.push(ms);})),next={...original,effort:'low' as const};
  await assert.rejects(store.save(next),{code:'EACCES'});assert.deepEqual(await store.read(),original);assert.equal(attempts,7);assert.deepEqual(waits,[25,50,100,200,400,800]);assert.deepEqual(await readdir(dir),['selection.json']);
  locked=false;await store.save(next);assert.deepEqual(await store.read(),next);
});

test('preference replacement never retries unrelated errors or changes non-Windows permission semantics',async()=>{
  for(const [platform,errorCode] of [['win32','ENOENT'],['linux','EPERM']] as const){let attempts=0;await assert.rejects(atomicPreferenceReplace('fixture-source','fixture-target',async()=>{attempts++;throw Object.assign(new Error('Fixture refusal'),{code:errorCode});},platform,async()=>assert.fail('Should not back off')),{code:errorCode});assert.equal(attempts,1);}
});
