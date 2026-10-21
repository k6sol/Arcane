import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createNativeAssetRegistry,nativeAssetActorScope,acquireNativeAssetWork,type NativeAssetIncarnation} from '../../apps/daemon/src/native-asset-authority.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {assertStudioImportJobScope} from '../../apps/daemon/src/asset-import-adapter.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import type {AppAssetConversationBinding} from '../../packages/protocol/src/asset-conversation.js';

// Actual Claude host/store and real volatile asset authority. Only owned child
// events/IPC receipts are scripted. No provider, MCP child, Studio or inference
// is launched; explicit final-CLI environment custody is not MCP inheritance proof.
const require=createRequire(join(process.cwd(),'package.json'));
interface Message {role:string;text:string;tool?:{name:string;input?:string;result?:string}}
interface Reply {turnId:string;conversationId:string;messageId:string}
interface ChatEvent {turnId:string;conversationId:string;type:string;text?:string;ok?:boolean;error?:string|null;message?:Message}
interface Host {send(value:unknown):Promise<Reply>;history(id:string):Promise<{messages:Message[]}>;stop(id:string):Promise<boolean>;steer(value:unknown):Promise<unknown>;dispose():Promise<void>;activeTurns():number}
const {createClaudeChat}=require(join(process.cwd(),'apps/desktop/electron/claude-chat.cjs')) as {createClaudeChat(options:unknown):Host};
const CORE='C'.repeat(43),SESSION='18242a29-6d33-4477-8247-a08f685e2c29';
const HELP="Usage: claude\n  --effort <level> Effort level (low, medium, high)\n  --model <model> Provide an alias ('sonnet') or full name.\n  --print Print response\n";
const wire=(value:unknown)=>JSON.stringify(value)+'\n';
const assistant=(text:string)=>wire({type:'assistant',message:{content:[{type:'text',text}]}});
const result=(extra:Record<string,unknown>={})=>wire({type:'result',subtype:'success',is_error:false,result:'OK',session_id:SESSION,...extra});
const delta=(text:string)=>wire({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function until(check:()=>boolean|Promise<boolean>){const deadline=Date.now()+5000;while(!await check()){assert.ok(Date.now()<deadline,'Synthetic host boundary did not settle.');await new Promise<void>(resolve=>setImmediate(resolve));}}
class Child extends EventEmitter {
  stdout=new EventEmitter();stderr=new EventEmitter();pid=4242;exitCode:number|null=null;signalCode:string|null=null;killed=0;input:string[]=[];ended=false;
  stdin=Object.assign(new EventEmitter(),{write:(text:string,_encoding?:string,callback?:(error?:Error|null)=>void)=>{this.input.push(text);callback?.();return true;},end:()=>{this.ended=true;}});
  output(text:string){this.stdout.emit('data',Buffer.from(text));}
  close(code:number|null=0){if(this.exitCode!==null||this.signalCode)return;this.exitCode=code;this.signalCode=code===null?'SIGTERM':null;this.emit('close',code,this.signalCode);}
  kill(){this.killed++;return true;} // A kill request deliberately does NOT manufacture close.
}
type Step='issue'|'bind'|'grant'|'dispatch';
interface AssetRecord {conversationId:string;connectionId:string;handle:NativeAssetIncarnation;token:string;calls:string[];binding:AppAssetConversationBinding|null;operationId:string|null}
async function fixture(t:TestContext,options:{assets?:boolean;autoSpawn?:boolean;throwSpawn?:boolean;failAt?:Step;nullIssue?:boolean;failPersistence?:boolean;cleanup?:'throw'|'hold';limits?:Record<string,number>}={}){
  const boundary=await nativeFs.realpath(tmpdir()),root=await nativeFs.realpath(await nativeFs.mkdtemp(join(boundary,'arcane-claude-assets-')));
  const project=join(root,'project'),state=join(root,'state');await nativeFs.mkdir(project);await nativeFs.mkdir(state);
  const beforeCleanup:(()=>void)[]=[];
  const registry=createNativeAssetRegistry({projectPath:project}),records:AssetRecord[]=[],events:ChatEvent[]=[],children:Child[]=[],spawnEnvs:Record<string,string>[]=[],spawnArgs:string[][]=[],gates=new Map<Step,ReturnType<typeof gate>>();
  let current=true,issues=0,host:Host|undefined;const cleanupGate=gate();
  const cleanupAck=async()=>{if(options.cleanup==='throw')throw Error('private '+CORE);if(options.cleanup==='hold')await cleanupGate.promise;};
  const invoke=async(r:AssetRecord,step:Step,effect:()=>void)=>{r.calls.push(step);effect();if(options.failAt===step)throw Error(r.token+' private bridge failure');await gates.get(step)?.promise;};
  const appAssets={isCurrent:()=>current,async issue(value:{conversationId:string;connectionId:string}){
    issues++;
    const durable=await host!.history(value.conversationId);assert.equal(durable.messages[0]?.role,'user','durable user receipt precedes asset issue');
    const handle=registry.issue(),r:AssetRecord={...value,handle,token:handle.credential(),calls:['issue'],binding:null,operationId:null};records.push(r);
    if(options.failAt==='issue'){handle.retire();handle.transportClosed();throw Error(r.token+' unknown issue delivery');}
    await gates.get('issue')?.promise;
    if(options.nullIssue){handle.retire();handle.transportClosed();return null;}
    return Object.freeze({
      launchEnvironment(){return Object.freeze(Object.defineProperty(Object.create(null),'ARCANE_ASSET_TOKEN',{value:r.token,enumerable:false}));},
      async bind(transport:Extract<AppAssetConversationBinding,{provider:'claude-code'}>['transport']){await invoke(r,'bind',()=>{r.binding={kind:'app-conversation',provider:'claude-code',conversationId:r.conversationId,connectionId:r.connectionId,transport};handle.bindAppConversation(r.binding);});},
      async grantNextIntent(){await invoke(r,'grant',()=>handle.grantNextIntent({connectionId:r.connectionId,threadId:'app:'+r.conversationId,sessionId:null}));},
      async dispatched(id:string){await invoke(r,'dispatch',()=>{r.operationId=id;handle.dispatched({connectionId:r.connectionId,threadId:'app:'+r.conversationId,operationId:id});});},
      async ended(id:string){r.calls.push('ended');assert.equal(id,r.operationId);handle.ended(id);},
      async cancelWork(scope:'active-operation'|'incarnation'){r.calls.push('cancel:'+scope);handle.cancelWork(scope);},
      async retire(){r.calls.push('retire');handle.retire();await cleanupAck();},
      async transportClosed(){r.calls.push('closed');handle.transportClosed();await cleanupAck();},
    });
  }};
  const spawn=(_command:string,args:string[],spawnOptions:{env?:Record<string,string>})=>{
    if(args[0]==='-p'&&options.throwSpawn)throw Error('synchronous owned launch refusal');
    const child=new Child();
    if(args[0]==='-p'){
      children.push(child);spawnEnvs.push(spawnOptions.env??{});spawnArgs.push([...args]);
      if(options.autoSpawn!==false)setImmediate(()=>child.emit('spawn'));
    }else setImmediate(()=>{
      if(args[0]==='--version')child.output('2.1.301 (Claude Code)\n');
      else if(args[0]==='auth')child.output(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));
      else if(args[0]==='--help')child.output(HELP);
      child.close();
    });
    return child;
  };
  const receipt={handoffId:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString(),configPath:join(root,'fixed.mcp.json')};
  Object.defineProperty(receipt,'env',{value:Object.freeze({ARCANE_DAEMON_URL:'http://127.0.0.1:45871',ARCANE_LOCAL_TOKEN:CORE}),enumerable:false});
  host=createClaudeChat({projectPath:project,stateDirectory:state,spawn,locate:async()=>join(root,'claude'+(process.platform==='win32'?'.exe':'')),
    getWindow:()=>({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send(_channel:string,event:ChatEvent){events.push(structuredClone(event));}}}),
    env:{PATH:'',ARCANE_ASSET_TOKEN:'inherited-never',ARCANE_ASSET_AUDIENCE:'generic'},permissions:{claudeTools:async()=>true},
    handoff:{prepare:async()=>receipt,release:async()=>true},instructions:async()=>'',
    ...(options.assets===false?{}:{appAssets}),...(options.limits?{limits:options.limits}:{}),
    ...(options.failPersistence?{fs:{...nativeFs,rename:async()=>{throw Error('controlled durable-store refusal');}}}:{}),
  });
  const chat=host;
  t.after(async()=>{
    cleanupGate.release();for(const held of gates.values())held.release();await chat.dispose();for(const child of children)child.close(null);
    await until(()=>chat.activeTurns()===0);for(const close of beforeCleanup)close();registry.close();
    const part=relative(boundary,root);assert.ok(!isAbsolute(part)&&part.startsWith('arcane-claude-assets-')&&!part.startsWith('..'));
    await nativeFs.rm(root,{recursive:true,force:true});
  });
  const input=(conversationId:string|null=null)=>({conversationId,text:'Create an original model',model:'sonnet',effort:'low'});
  const done=(id:string)=>until(()=>events.some(e=>e.turnId===id&&e.type==='done'));
  const complete=(child:Child)=>{child.output(assistant('Original model request acknowledged.'));child.output(result());child.close();};
  return{host:chat,root,project,state,registry,records,events,children,spawnEnvs,spawnArgs,gates,input,done,complete,
    current(value:boolean){current=value;},beforeCleanup(close:()=>void){beforeCleanup.push(close);},issues:()=>issues};
}

for(const stage of ['bind','grant','dispatch'] as const)test('Claude assets await '+stage+' acknowledgement before first prompt input',{timeout:15000},async t=>{
  const f=await fixture(t),held=gate();f.gates.set(stage,held);const reply=await f.host.send(f.input());
  await until(()=>f.records[0]?.calls.includes(stage)===true);const child=f.children[0]!;
  assert.equal(child.input.length,0);assert.equal(f.records[0]!.conversationId,reply.conversationId);
  held.release();await until(()=>child.input.length===1);
  assert.deepEqual(f.records[0]!.calls.slice(0,4),['issue','bind','grant','dispatch']);assert.equal(f.records[0]!.operationId,reply.turnId);
  assert.equal(f.spawnEnvs[0]!.ARCANE_LOCAL_TOKEN,CORE);assert.equal(f.spawnEnvs[0]!.ARCANE_ASSET_TOKEN,f.records[0]!.token);assert.equal(f.spawnEnvs[0]!.ARCANE_ASSET_AUDIENCE,'native-session');
  assert.ok(!JSON.stringify(f.spawnArgs).includes(f.records[0]!.token));assert.ok(!JSON.stringify(reply).includes(f.records[0]!.token));
  f.complete(child);await f.done(reply.turnId);
});
test('Claude asset binding requires the actual owned spawn event, not an allocated child object or resumed session',{timeout:15000},async t=>{
  const f=await fixture(t,{autoSpawn:false}),reply=await f.host.send(f.input());await until(()=>f.children.length===1);
  assert.deepEqual(f.records[0]!.calls,['issue']);assert.equal(f.children[0]!.input.length,0);
  f.children[0]!.emit('spawn');await until(()=>f.children[0]!.input.length===1);
  const binding=f.records[0]!.binding;assert.equal(binding?.provider,'claude-code');assert.equal(binding?.transport.kind,'claude-code-process');
  if(binding?.provider==='claude-code')assert.equal(binding.transport.nativeSessionId,null);
  f.complete(f.children[0]!);await f.done(reply.turnId);
});
test('Claude does not issue asset authority before the user transcript is durably saved',{timeout:15000},async t=>{
  const f=await fixture(t,{failPersistence:true});await assert.rejects(f.host.send(f.input()));assert.equal(f.issues(),0);assert.equal(f.children.length,0);
});
for(const nullIssue of [false,true])test('Claude '+(nullIssue?'null':'unknown')+' asset issue fails closed without fallback, launch or replay',{timeout:15000},async t=>{
  const f=await fixture(t,nullIssue?{nullIssue:true}:{failAt:'issue'}),reply=await f.host.send(f.input());await f.done(reply.turnId);
  assert.equal(f.issues(),1);assert.equal(f.children.length,0);assert.equal(f.events.find(e=>e.type==='done')?.ok,false);
  assert.equal((await f.host.history(reply.conversationId)).messages[0]?.text,f.input().text);
  assert.ok(!JSON.stringify(f.events).includes(f.records[0]!.token));
});
for(const stage of ['issue','bind','grant','dispatch'] as const)test('Claude Stop during held '+stage+' retains exact lifecycle and never sends the pending prompt',{timeout:15000},async t=>{
  const f=await fixture(t),held=gate();f.gates.set(stage,held);const reply=await f.host.send(f.input());
  await until(()=>f.records[0]?.calls.includes(stage)===true);await f.host.stop(reply.turnId);held.release();await f.done(reply.turnId);
  assert.equal(f.issues(),1);assert.ok(f.children.every(child=>child.input.length===0));
  const r=f.records[0]!;assert.equal(r.calls.filter(c=>c==='cancel:incarnation').length,1);
  if(stage==='issue')assert.equal(r.handle.status().released,true,'No launch was ever attempted.');
  else {assert.equal(r.calls.includes('closed'),false,'Kill request is not closure.');f.children[0]!.close(null);await until(()=>r.calls.includes('closed'));}
});
for(const transition of ['dispose','epoch'] as const)test('Claude '+transition+' during bind acknowledgement fences input without cancelling accepted asset work',{timeout:15000},async t=>{
  const f=await fixture(t),held=gate();f.gates.set('bind',held);const reply=await f.host.send(f.input());await until(()=>f.records[0]?.calls.includes('bind')===true);
  if(transition==='dispose')await f.host.dispose();else f.current(false);
  held.release();await f.done(reply.turnId);assert.equal(f.children[0]!.input.length,0);assert.equal(f.records[0]!.calls.some(c=>c.startsWith('cancel:')),false);
  assert.equal(f.records[0]!.calls.includes('closed'),false);f.children[0]!.close(null);await until(()=>f.records[0]!.calls.includes('closed'));
});
test('Claude synchronous launch refusal closes only its definite no-child context',{timeout:15000},async t=>{
  const f=await fixture(t,{throwSpawn:true}),reply=await f.host.send(f.input());await f.done(reply.turnId);
  assert.equal(f.children.length,0);assert.deepEqual(f.records[0]!.calls,['issue','retire','closed']);assert.equal(f.records[0]!.handle.status().released,true);
});
test('Claude post-spawn error retires admission but independently waits for actual close and ignores late stdout',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,r=f.records[0]!;child.output(assistant('late '+r.token).trimEnd());child.emit('error',Error(r.token+' private runtime fault'));
  await f.done(reply.turnId);const saved=JSON.stringify(await f.host.history(reply.conversationId)),count=f.events.length;
  assert.equal(r.calls.includes('closed'),false);assert.equal(r.handle.status().released,false);assert.equal(r.calls.some(c=>c.startsWith('cancel:')),false);
  child.output(assistant('must not appear'));child.close(1);await until(()=>r.calls.includes('closed'));
  assert.equal(f.events.length,count);assert.equal(JSON.stringify(await f.host.history(reply.conversationId)),saved);assert.ok(!saved.includes(r.token));
  assert.equal(r.calls.filter(c=>c==='closed').length,1);
});
test('Claude result and timeout are not transport closure or implicit cancellation',{timeout:15000},async t=>{
  const f=await fixture(t,{limits:{turnTimeoutMs:1000}}),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,r=f.records[0]!;child.output(result());assert.equal(child.ended,true);assert.equal(r.calls.includes('closed'),false);
  await until(()=>child.killed>0);assert.equal(r.calls.includes('closed'),false);assert.equal(r.calls.some(c=>c.startsWith('cancel:')),false);
  child.close(null);await f.done(reply.turnId);assert.equal(r.calls.filter(c=>c==='closed').length,1);
});
test('Claude explicit Stop cancels the exact accepted incarnation while normal completion preserves another conversation work lease',{timeout:15000},async t=>{
  const f=await fixture(t),one=await f.host.send(f.input()),two=await f.host.send(f.input());await until(()=>f.children.length===2&&f.children.every(child=>child.input.length===1));
  const a=f.records.find(r=>r.conversationId===one.conversationId)!,b=f.records.find(r=>r.conversationId===two.conversationId)!;
  const first=acquireNativeAssetWork(f.registry.capture(a.token,'mutate'),'generation'),second=acquireNativeAssetWork(f.registry.capture(b.token,'mutate'),'generation');
  await f.host.stop(one.turnId);assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,false);
  f.children[0]!.close(null);f.complete(f.children[1]!);await f.done(two.turnId);
  assert.equal(b.handle.status().released,false);assert.equal(second.signal.aborted,false);first.finish('closed');second.finish('closed');
  assert.equal(a.handle.status().released,true);assert.equal(b.handle.status().released,true);
});
test('Claude fresh process contexts retain same app conversation job history and import scope without adopting old actor authority',{timeout:15000},async t=>{
  const f=await fixture(t),work=new ConversationWorkStore({projectPath:f.project,directory:join(f.root,'bindings')});f.beforeCleanup(()=>work.close());
  const host=createAssetConversationHost({projectPath:work.projectPath,workAssociations:work,conversation:()=>null,start:()=>{throw Error('No generation in this fixture.');}});
  const first=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);const a=f.records[0]!,old=f.registry.capture(a.token,'mutate'),scope=nativeAssetActorScope(old),job=randomUUID();
  work.bind({conversation:scope.conversation,kind:'asset-job',id:job});f.complete(f.children[0]!);await f.done(first.turnId);assert.throws(()=>f.registry.capture(a.token,'read'));
  const next=await f.host.send(f.input(first.conversationId));await until(()=>f.children[1]?.input.length===1);const b=f.records[1]!,actor=f.registry.capture(b.token,'mutate');
  assert.notEqual(a.token,b.token);assert.notDeepEqual(a.binding?.transport,b.binding?.transport);assert.deepEqual(nativeAssetActorScope(actor),scope);
  assert.equal(b.binding?.provider,'claude-code');if(b.binding?.provider==='claude-code')assert.equal(b.binding.transport.nativeSessionId,null);
  assert.ok(f.spawnArgs[1]!.includes('--resume'));assert.ok(f.spawnArgs[1]!.includes(SESSION));
  assert.deepEqual(host.listNative(actor).items.map(item=>item.id),[job]);assert.doesNotThrow(()=>assertStudioImportJobScope(work.projectPath,work,actor,job));
  assert.throws(()=>assertStudioImportJobScope(work.projectPath,work,old,job));
  const foreign=await f.host.send(f.input());await until(()=>f.children[2]?.input.length===1);assert.throws(()=>assertStudioImportJobScope(work.projectPath,work,f.registry.capture(f.records[2]!.token,'mutate'),job));
  f.complete(f.children[1]!);f.complete(f.children[2]!);await f.done(next.turnId);await f.done(foreign.turnId);
});
test('Claude protects both bearers across split live deltas, assistant/tool details, public failures and persisted messages',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);const c=f.children[0]!,token=f.records[0]!.token;
  c.output(delta('safe '.repeat(40)+token.slice(0,27)));c.output(delta(token.slice(27)+' '+CORE.slice(0,19)));c.output(delta(CORE.slice(19)+' end'));
  c.output(assistant('Do not publish '+token));
  c.output(wire({type:'assistant',message:{content:[{type:'tool_use',id:'one',name:'mcp__arcane__'+token,input:{secret:CORE}},{type:'tool_use',id:'two',name:'mcp__arcane__assets_jobs',input:{secret:token}}]}}));
  const encoded=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from(token)]).toString('base64');
  c.output(wire({type:'user',message:{content:[{type:'tool_result',tool_use_id:'one',content:JSON.stringify({secret:token})},{type:'tool_result',tool_use_id:'two',content:[{type:'text',text:'private '+CORE},{type:'image',mimeType:'image/png',data:encoded}]}]}}));
  c.stderr.emit('data',Buffer.from(token+CORE));c.output(result({subtype:'error_during_execution',is_error:true,result:token+' '+CORE}));c.close(1);await f.done(reply.turnId);
  const files=await nativeFs.readdir(f.state,{recursive:true}),saved=(await Promise.all(files.filter(n=>n.endsWith('.json')).map(n=>nativeFs.readFile(join(f.state,n),'utf8')))).join('\n');
  const eventText=f.events.filter(e=>e.type==='delta').map(e=>e.text??'').join('');assert.match(eventText,/redacted/);assert.ok(!JSON.stringify(f.events).includes(encoded));
  for(const text of [eventText,JSON.stringify(f.events),saved])for(const secret of [token,CORE])assert.ok(!text.includes(secret));
});
test('Claude optional asset seam leaves legacy prompt flow intact when absent',{timeout:15000},async t=>{
  const f=await fixture(t,{assets:false,autoSpawn:false}),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  assert.equal(f.issues(),0);assert.equal(Object.hasOwn(f.spawnEnvs[0]!,'ARCANE_ASSET_TOKEN'),false);assert.equal(Object.hasOwn(f.spawnEnvs[0]!,'ARCANE_ASSET_AUDIENCE'),false);
  f.complete(f.children[0]!);await f.done(reply.turnId);assert.equal(f.events.find(e=>e.type==='done')?.ok,true);
});

for(const cleanup of ['throw','hold'] as const)test('Claude '+cleanup+' asset cleanup cannot block or change its actual reply outcome',{timeout:15000},async t=>{
  const f=await fixture(t,{cleanup}),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  f.complete(f.children[0]!);await f.done(reply.turnId);const r=f.records[0]!;
  assert.equal(f.events.find(e=>e.type==='done')?.ok,true);assert.equal(r.calls.filter(c=>c==='retire').length,1);assert.equal(r.calls.filter(c=>c==='closed').length,1);
  assert.ok(!JSON.stringify(f.events).includes(CORE));assert.ok(!JSON.stringify(f.events).includes(r.token));
});

for(const failAt of ['bind','grant','dispatch'] as const)test('Claude rejected '+failAt+' admission cannot send input or imply child closure',{timeout:15000},async t=>{
  const f=await fixture(t,{failAt}),reply=await f.host.send(f.input());await f.done(reply.turnId);const r=f.records[0]!;
  assert.equal(f.issues(),1);assert.equal(f.children[0]!.input.length,0);assert.equal(r.calls.includes('closed'),false);assert.equal(r.calls.some(c=>c.startsWith('cancel:')),false);
  assert.equal(f.events.find(e=>e.type==='done')?.ok,false);assert.ok(!JSON.stringify(f.events).includes(r.token));assert.equal((await f.host.history(reply.conversationId)).messages[0]?.text,f.input().text);
  f.children[0]!.close(1);await until(()=>r.calls.includes('closed'));assert.equal(r.calls.filter(c=>c==='closed').length,1);
});

test('Claude terminal provider output while binding cannot be followed by first prompt input',{timeout:15000},async t=>{
  const f=await fixture(t),held=gate();f.gates.set('bind',held);const reply=await f.host.send(f.input());await until(()=>f.records[0]?.calls.includes('bind')===true);
  f.children[0]!.output(result({subtype:'error_during_execution',is_error:true}));held.release();await f.done(reply.turnId);
  assert.equal(f.children[0]!.input.length,0);assert.equal(f.records[0]!.calls.includes('grant'),false);assert.equal(f.records[0]!.calls.includes('closed'),false);
  f.children[0]!.close(1);await until(()=>f.records[0]!.calls.includes('closed'));
});

test('Claude explicit steering stays in its original granted context and refuses a later epoch without replay',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);const r=f.records[0]!,c=f.children[0]!;
  await f.host.steer({turnId:reply.turnId,text:'Keep the original silhouette'});assert.equal(c.input.length,2);
  assert.equal(r.calls.filter(step=>step==='grant').length,1);assert.equal(r.calls.filter(step=>step==='dispatch').length,1);assert.equal(r.operationId,reply.turnId);assert.equal(f.issues(),1);
  f.current(false);await assert.rejects(f.host.steer({turnId:reply.turnId,text:'Must remain unsent'}));assert.equal(c.input.length,2);f.complete(c);await f.done(reply.turnId);
});
test('Claude supplied malformed or accessor asset ports fail closed without reading a getter',{timeout:15000},async t=>{
  const f=await fixture(t);let reads=0;
  const getter=Object.defineProperty({isCurrent:()=>true},'issue',{enumerable:true,get(){reads++;throw Error('Do not invoke.');}});
  for(const appAssets of [null,false,0,getter,new Proxy({issue:async()=>null,isCurrent:()=>true},{get(){reads++;throw Error('Do not invoke.');}})])
    assert.throws(()=>createClaudeChat({projectPath:f.project,stateDirectory:f.state,getWindow:()=>null,handoff:{prepare:async()=>null,release:async()=>true},appAssets}),/Claude chat is unavailable/);
  assert.equal(reads,0);assert.equal(f.issues(),0);
});


async function persistedJson(directory:string){
  const files=await nativeFs.readdir(directory,{recursive:true});
  return (await Promise.all(files.filter(name=>name.endsWith('.json')).sort().map(name=>nativeFs.readFile(join(directory,name),'utf8')))).join('\n');
}
for(const transition of ['stop','dispose','epoch','stdin-error'] as const)test('Claude asset '+transition+' ignores late output and drops secret carry before actual child close',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,r=f.records[0]!,marker='LATE OUTPUT MUST STAY PRIVATE';
  child.output(wire({type:'assistant',message:{content:[{type:'tool_use',id:'accepted',name:'mcp__arcane__assets_jobs',input:{kind:'read'}}]}}));
  child.output(delta('Visible before stop. '+r.token.slice(0,27)));
  child.output(assistant(marker).trimEnd()); // buffer a complete JSON value without its NDJSON newline before the fence
  await f.host.history(reply.conversationId);const before=await persistedJson(f.state),count=f.events.length;
  if(transition==='stop')assert.equal(await f.host.stop(reply.turnId),true);
  else if(transition==='dispose')await f.host.dispose();
  else if(transition==='epoch')f.current(false);
  else child.stdin.emit('error',Error('controlled input closure'));
  assert.equal(r.calls.includes('closed'),false,'Neither retirement nor a kill request is physical closure.');
  child.output(delta(r.token.slice(27)+' '+marker));child.output(assistant(marker));
  child.output(wire({type:'assistant',message:{content:[{type:'tool_use',id:'late',name:'mcp__arcane__assets_generate',input:{hint:marker}}]}}));
  child.output(wire({type:'user',message:{content:[{type:'tool_result',tool_use_id:'accepted',content:marker}]}}));
  child.output(result({result:marker,session_id:randomUUID()}));
  assert.equal(f.events.length,count);assert.equal(await persistedJson(f.state),before);
  assert.equal(f.events.some(event=>event.type==='done'),false);assert.equal(r.calls.includes('closed'),false);
  child.close(null);await f.done(reply.turnId);await until(()=>r.calls.includes('closed'));
  const deltas=f.events.filter(event=>event.type==='delta').map(event=>event.text??'').join('');
  assert.equal(deltas,'Visible before stop. ');assert.equal(r.calls.filter(step=>step==='closed').length,1);
  assert.equal(r.calls.filter(step=>step==='cancel:incarnation').length,transition==='stop'?1:0);
  for(const publicBytes of [JSON.stringify(f.events),await persistedJson(f.state)]){
    assert.ok(!publicBytes.includes(marker));for(const secret of [r.token,CORE,r.token.slice(0,27)])assert.ok(!publicBytes.includes(secret));
  }
});
for(const kind of ['asset','core'] as const)test('Claude '+kind+' bearer split across an assistant boundary stays private',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,token=f.records[0]!.token,secret=kind==='asset'?token:CORE,split=kind==='asset'?27:19;
  child.output(delta('Public opening. '+secret.slice(0,split)));
  child.output(assistant('Intermediate status.'));
  child.output(delta(secret.slice(split)+' Public ending.'));
  child.output(result());child.close();await f.done(reply.turnId);
  const deltas=f.events.filter(event=>event.type==='delta').map(event=>event.text??'').join('');
  assert.equal(deltas,'Public opening. [redacted] Public ending.');
  assert.ok(f.events.some(event=>event.type==='message'&&event.message?.text==='Intermediate status.'));
  const history=await f.host.history(reply.conversationId);assert.ok(history.messages.some(message=>message.role==='assistant'&&message.text==='Intermediate status.'));
  for(const publicBytes of [deltas,JSON.stringify(f.events),JSON.stringify(history),await persistedJson(f.state)])
    for(const privateValue of [token,CORE])assert.ok(!publicBytes.includes(privateValue));
});
test('Claude final incomplete63-character asset prefix is discarded while normal final assistant text remains exact',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,token=f.records[0]!.token,prefix=token.slice(0,63),text='Final model summary, with exact spacing.  \nSecond line.';
  child.output(delta('Public opening. '+prefix));child.output(assistant(text));child.output(result());child.close();await f.done(reply.turnId);
  const deltas=f.events.filter(event=>event.type==='delta').map(event=>event.text??'').join('');assert.equal(deltas,'Public opening. ');
  const history=await f.host.history(reply.conversationId);assert.ok(history.messages.some(message=>message.role==='assistant'&&message.text===text));
  assert.ok(f.events.some(event=>event.type==='message'&&event.message?.text===text));
  for(const publicBytes of [deltas,JSON.stringify(f.events),JSON.stringify(history),await persistedJson(f.state)])
    for(const privateValue of [prefix,token,CORE])assert.ok(!publicBytes.includes(privateValue));
});

for(const kind of ['asset','core'] as const)test('Claude '+kind+' bearer split across a result before queued follow-up output stays private',{timeout:15000},async t=>{
  const f=await fixture(t),reply=await f.host.send(f.input());await until(()=>f.children[0]?.input.length===1);
  const child=f.children[0]!,r=f.records[0]!,token=r.token,secret=kind==='asset'?token:CORE,split=kind==='asset'?27:19;
  // Queue this input before the first result: the existing host contract allows
  // already-accepted steering output to continue before the actual process exits.
  await f.host.steer({turnId:reply.turnId,text:'Finish the queued follow-up safely.'});assert.equal(child.input.length,2);
  child.output(delta('Public opening. '+secret.slice(0,split)));
  child.output(result()); // The result is strictly BETWEEN the secret fragments.
  assert.equal(child.ended,true);assert.equal(r.calls.includes('closed'),false);
  assert.equal(f.events.some(event=>event.type==='done'),false);
  assert.equal(f.events.filter(event=>event.type==='delta').map(event=>event.text??'').join(''),'Public opening. ');
  child.output(delta(secret.slice(split)+' Public ending.'));
  child.output(assistant('Queued follow-up finished exactly.'));
  child.output(result());child.close();await f.done(reply.turnId);
  const deltas=f.events.filter(event=>event.type==='delta').map(event=>event.text??'').join('');
  assert.equal(deltas,'Public opening. [redacted] Public ending.');
  const history=await f.host.history(reply.conversationId);
  assert.ok(history.messages.some(message=>message.role==='assistant'&&message.text==='Queued follow-up finished exactly.'));
  for(const publicBytes of [deltas,JSON.stringify(f.events),JSON.stringify(history),await persistedJson(f.state)])
    for(const privateValue of [token,CORE,secret.slice(0,split)])assert.ok(!publicBytes.includes(privateValue));
  assert.equal(r.calls.filter(step=>step==='grant').length,1);assert.equal(r.calls.filter(step=>step==='dispatch').length,1);assert.equal(f.issues(),1);
});
