import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
interface Request {type:string;protocolVersion:1;sequence:number;requestId:string;projectId:string;epoch:string;command:{action:string;[key:string]:unknown}}
interface Context {launchEnvironment():Record<string,string>;bind(value:unknown):Promise<void>;grantNextIntent():Promise<void>;dispatched(id:string):Promise<void>;ended(id:string):Promise<void>;cancelWork(scope:'active-operation'|'incarnation'):Promise<void>;retire():Promise<void>;transportClosed():Promise<void>}
interface Host {ready():Promise<void>;isCurrent():boolean;selectHumanConversation(value:unknown):Promise<void>;issue(value:{provider:'claude-code'|'arcane';conversationId:string;connectionId:string}):Promise<Context>;fence():void;close():void}
const require=createRequire(join(process.cwd(),'package.json'));
const {createAppAssetHost}=require(join(process.cwd(),'apps/desktop/electron/app-asset-host.cjs')) as {createAppAssetHost(value:{child:EventEmitter;projectPath:string;timeoutMs?:number}):Host};
function fixture(t:test.TestContext){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'arcane-app-host-')));let tokenNo=0;
 class Child extends EventEmitter{
  connected=true;sent:Request[]=[];hold=new Set<string>();sendError=false;throwSend=false;
  reply(r:Request,override:Record<string,unknown>={}){
   const result=r.command.action==='issue'?{action:'issue',issueSequence:r.sequence,issueRequestId:r.requestId,credential:(++tokenNo).toString(16).padStart(64,'0')}:{action:r.command.action};
   return{type:'arcane-app-asset-reply',protocolVersion:1,sequence:r.sequence,requestId:r.requestId,projectId:r.projectId,epoch:r.epoch,outcome:'ok',result,...override};
  }
  send(r:Request,callback:(error:Error|null)=>void){
   this.sent.push(structuredClone(r));this.emit('sent');if(this.throwSend)throw Error('private send error');
   if(!this.hold.has(r.command.action)&&!this.sendError)this.emit('message',this.reply(r));callback(this.sendError?Error('private callback error'):null);return false;
  }
 }
 const child=new Child(),host=createAppAssetHost({child,projectPath:directory,timeoutMs:50});
 t.after(()=>{host.close();rmSync(directory,{recursive:true,force:true});});
 const input=()=>({provider:'arcane' as const,conversationId:randomUUID(),connectionId:randomUUID()});
 const waitFor=(action:string,count:number)=>new Promise<void>(resolve=>{const check=()=>{if(child.sent.filter(r=>r.command.action===action).length>=count){child.off('sent',check);resolve();}};child.on('sent',check);check();});
 return{directory,child,host,input,waitFor};
}

test('human selection sends only a validated fixed parent command without creating native authority',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();assert.equal(f.host.isCurrent(),true);
 for(const selection of [null,{provider:'codex'},{provider:'claude-code',conversationId:randomUUID()},{provider:'arcane',conversationId:randomUUID()}]){
  await f.host.selectHumanConversation(selection);
  assert.deepEqual(f.child.sent.at(-1)!.command,{action:'select-human',selection});
 }
 assert.equal(f.child.sent.some(r=>['issue','bind','grant-next','dispatched'].includes(r.command.action)),false);
 const sent=f.child.sent.length;let getterReads=0,proxyReads=0;
 const getter=Object.defineProperty({},'provider',{enumerable:true,get(){getterReads++;return 'codex';}});
 const proxy=new Proxy({provider:'codex'},{getOwnPropertyDescriptor(){proxyReads++;throw Error('must not run');}});
 for(const selection of [undefined,{},getter,proxy,{provider:'codex',conversationId:randomUUID()},{provider:'arcane',conversationId:null},{provider:'claude-code',conversationId:randomUUID()+'\n'}])await assert.rejects(f.host.selectHumanConversation(selection),{code:'INPUT'});
 assert.equal(f.child.sent.length,sent);assert.equal(getterReads,0);assert.equal(proxyReads,0);
});

test('a held selection ACK cannot revive a fenced current-channel witness',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();f.child.hold.add('select-human');
 const pending=f.host.selectHumanConversation(null);await f.waitFor('select-human',1);
 const request=f.child.sent.find(r=>r.command.action==='select-human')!;
 f.host.fence();assert.equal(f.host.isCurrent(),false);
 await assert.rejects(pending,{code:'UNKNOWN'});f.child.emit('message',f.child.reply(request));
 assert.equal(f.host.isCurrent(),false);await assert.rejects(f.host.selectHumanConversation({provider:'codex'}),{code:'CLOSED'});
 assert.equal(f.child.sent.some(r=>r.command.action==='transport-closed'),false,'channel fencing does not invent a provider transport close');
});

test('private launch overlay is nonenumerable and never falls back to a core handoff token',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue(f.input()),env=context.launchEnvironment();
 assert.equal(Object.getPrototypeOf(env),null);assert.deepEqual(Object.keys(env),[]);assert.equal(JSON.stringify(env),'{}');assert.equal(JSON.stringify({...env}),'{}');assert.match(env.ARCANE_ASSET_TOKEN!,/^[a-f0-9]{64}$/);
 assert.equal(Object.getOwnPropertyDescriptor(env,'ARCANE_ASSET_TOKEN')?.enumerable,false);assert.equal(Object.isFrozen(env),true);assert.doesNotMatch(JSON.stringify(f.host),/[a-f0-9]{64}/);
 await context.retire();assert.throws(()=>context.launchEnvironment(),{code:'CLOSED'});assert.equal(f.child.sent.some(r=>r.command.action==='transport-closed'),false);
});

test('host rejects wrong-project/epoch/sequence/UUID/action and accessor replies without reading private fields',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();f.child.hold.add('issue');let reads=0,settled=false;
 const pending=f.host.issue(f.input()).then(value=>{settled=true;return value;});await f.waitFor('issue',1);const r=f.child.sent.find(r=>r.command.action==='issue')!;
 const valid=f.child.reply(r);for(const bad of [{...valid,projectId:'f'.repeat(64)},{...valid,epoch:randomUUID()},{...valid,sequence:r.sequence+1},{...valid,requestId:randomUUID()},{...valid,result:{action:'open'}},
  Object.defineProperty({...valid},'result',{enumerable:true,get(){reads++;throw Error('never');}}),
  {...valid,result:new Proxy({action:'issue'},{getOwnPropertyDescriptor(){reads++;throw Error('never');}})}])f.child.emit('message',bad);
 await Promise.resolve();assert.equal(reads,0);assert.equal(settled,false);f.child.emit('message',valid);await pending;
});

test('fixed validators reject provider impersonation extra fields unbounded IDs and malformed transport without dispatch',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();const before=f.child.sent.length;
 for(const bad of [{...f.input(),provider:'codex'},{...f.input(),extra:true},{...f.input(),conversationId:'x'.repeat(9000)}])await assert.rejects(f.host.issue(bad as never),{code:'INPUT'});
 assert.equal(f.child.sent.length,before);const context=await f.host.issue(f.input()),at=f.child.sent.length;
 for(const bad of [{kind:'claude-code-process',incarnationId:randomUUID(),nativeSessionId:null},{kind:'arcane-gateway-loop',incarnationId:'not-uuid'},{kind:'arcane-gateway-loop',incarnationId:randomUUID(),extra:true}])await assert.rejects(context.bind(bad),{code:'INPUT'});
 assert.equal(f.child.sent.length,at);await assert.rejects(context.dispatched('not-uuid'),{code:'INPUT'});
});

test('normal end retirement and close never forge Stop or actual transport-closed acknowledgements',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue(f.input());await context.bind({kind:'arcane-gateway-loop',incarnationId:randomUUID()});await context.grantNextIntent();const id=randomUUID();await context.dispatched(id);await context.ended(id);await context.retire();
 assert.equal(f.child.sent.some(r=>r.command.action==='cancel'||r.command.action==='transport-closed'),false);
 await context.cancelWork('incarnation');assert.equal(f.child.sent.filter(r=>r.command.action==='cancel').length,1);await context.transportClosed();assert.equal(f.child.sent.filter(r=>r.command.action==='transport-closed').length,1);
 f.host.close();assert.equal(f.child.listenerCount('message'),0);assert.equal(f.child.listenerCount('exit'),0);
});

test('acknowledged dispatch fenced before its continuation stays unknown and cannot authorize a subsequent provider send',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue(f.input());await context.bind({kind:'arcane-gateway-loop',incarnationId:randomUUID()});await context.grantNextIntent();
 // The fake channel ACKs synchronously. Fence occurs before the async method
 // can resume, exercising the required after-ACK epoch/lifecycle check.
 let providerSends=0;const dispatch=context.dispatched(randomUUID()).then(()=>{providerSends++;});f.host.fence();await assert.rejects(dispatch,{code:'UNKNOWN'});assert.equal(providerSends,0);
});

test('conflicting in-flight binding retires admission without claiming owned child closure',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue(f.input());f.child.hold.add('bind');const first=context.bind({kind:'arcane-gateway-loop',incarnationId:randomUUID()});
 await assert.rejects(context.bind({kind:'arcane-gateway-loop',incarnationId:randomUUID()}),{code:'CONFLICT'});assert.throws(()=>context.launchEnvironment(),{code:'CLOSED'});
 const request=f.child.sent.find(r=>r.command.action==='bind')!;f.child.emit('message',f.child.reply(request));await assert.rejects(first,{code:'UNKNOWN'});assert.equal(f.child.sent.some(r=>r.command.action==='transport-closed'),false);
});

test('pending cap bounds authority calls while cleanup remains admitted and displaced receipt stays unknown',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();const context=await f.host.issue(f.input());await context.bind({kind:'arcane-gateway-loop',incarnationId:randomUUID()});f.child.hold.add('issue');
 const failures:Promise<unknown>[]=[];for(let i=0;i<32;i++)failures.push(f.host.issue(f.input()).catch((e:unknown)=>e));await f.waitFor('issue',33);
 await assert.rejects(f.host.issue(f.input()),{code:'LIMIT'});await context.retire();assert.equal(f.child.sent.filter(r=>r.command.action==='retire').length,1);
 f.host.close();const outcomes=await Promise.all(failures);assert.equal(outcomes.length,32);assert.ok(outcomes.every(value=>value instanceof Error));assert.equal(f.child.sent.filter(r=>r.command.action==='issue').length,33);
});

test('context reservation cap is synchronous across awaits and releases only after explicit transport close',{timeout:5000},async t=>{
 const f=fixture(t),contexts=await Promise.all(Array.from({length:128},()=>f.host.issue(f.input())));
 // The pending cap may be lower than context capacity; this case issues only
 // after immediate fake replies, so no pending receipt is retained.
 await assert.rejects(f.host.issue(f.input()),{code:'LIMIT'});await contexts[0]!.retire();await assert.rejects(f.host.issue(f.input()),{code:'LIMIT'});
 await contexts[0]!.transportClosed();assert.ok(await f.host.issue(f.input()));
});

for(const event of ['disconnect','exit','error'] as const)test('owned '+event+' fences launch/dispatch rejects pending and detaches listeners',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue(f.input());f.child.hold.add('issue');const pending=f.host.issue(f.input());await f.waitFor('issue',2);
 if(event==='disconnect')f.child.connected=false;f.child.emit(event,...(event==='error'?[Error('private child error')]:[]));
 await assert.rejects(pending,{code:'UNKNOWN'});assert.throws(()=>context.launchEnvironment(),{code:'CLOSED'});assert.equal(f.child.listenerCount('message'),0);assert.equal(f.child.listenerCount('disconnect'),0);
});

for(const mode of ['throwSend','sendError'] as const)test(mode+' is unknown delivery never automatic issue retry and cleanup failure fences future authority',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();f.child[mode]=true;await assert.rejects(f.host.issue(f.input()),{code:'UNKNOWN'});
 assert.equal(f.child.sent.filter(r=>r.command.action==='issue').length,1);assert.equal(f.child.sent.filter(r=>r.command.action==='retire-issue').length,1);await assert.rejects(f.host.issue(f.input()),{code:'CLOSED'});
});

test('new broker epoch and captured child identity reject late replies from a previous daemon channel',{timeout:5000},async t=>{
 const f=fixture(t);await f.host.ready();const old=f.child.sent[0]!;f.host.close();
 const replacement=fixture(t);await replacement.host.ready();const current=replacement.child.sent.at(-1)!;assert.notEqual(old.epoch,current.epoch);
 replacement.child.hold.add('issue');let settled=false;const pending=replacement.host.issue(replacement.input()).then(value=>{settled=true;return value;});await replacement.waitFor('issue',1);const request=replacement.child.sent.at(-1)!;
 f.child.emit('message',replacement.child.reply(request));replacement.child.emit('message',replacement.child.reply(request,{epoch:old.epoch}));await Promise.resolve();assert.equal(settled,false);
 replacement.child.emit('message',replacement.child.reply(request));await pending;
});
