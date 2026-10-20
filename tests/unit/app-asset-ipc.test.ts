import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppAssetControl,routeAppAssetMessage,type AppAssetRequest,type AppAssetReply} from '../../apps/daemon/src/app-asset-control.js';
import {createNativeAssetRegistry,nativeAssetActorScope,nativeAssetOperationSignal,acquireNativeAssetWork} from '../../apps/daemon/src/native-asset-authority.js';
interface Context {
 launchEnvironment():Record<string,string>;bind(value:unknown):Promise<void>;grantNextIntent():Promise<void>;dispatched(id:string):Promise<void>;
 ended(id:string):Promise<void>;cancelWork(scope:'active-operation'|'incarnation'):Promise<void>;retire():Promise<void>;transportClosed():Promise<void>;
}
interface Host {ready():Promise<void>;issue(value:{provider:'claude-code'|'arcane';conversationId:string;connectionId:string}):Promise<Context>;fence():void;close():void}
const require=createRequire(join(process.cwd(),'package.json'));
const {createAppAssetHost}=require(join(process.cwd(),'apps/desktop/electron/app-asset-host.cjs')) as {createAppAssetHost(value:{child:EventEmitter;projectPath:string;timeoutMs?:number}):Host};
function fixture(t:test.TestContext){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'arcane-app-ipc-'))),registry=createNativeAssetRegistry({projectPath:directory}),control=createAppAssetControl({projectPath:directory,registry});
 class Child extends EventEmitter{
  connected=true;sent:AppAssetRequest[]=[];replies:AppAssetReply[]=[];hold=new Set<string>();drop=new Set<string>();
  send(request:AppAssetRequest,callback:(error:Error|null)=>void){
   this.sent.push(structuredClone(request));this.emit('sent');
   routeAppAssetMessage(control,request,reply=>{if(this.drop.has(request.command.action))return;if(this.hold.has(request.command.action))this.replies.push(reply);else this.emit('message',reply);});callback(null);return true;
  }
 }
 const child=new Child(),host=createAppAssetHost({child,projectPath:directory,timeoutMs:50});
 t.after(()=>{host.close();control.close();registry.close();rmSync(directory,{recursive:true,force:true});});
 const binding=(provider:'claude-code'|'arcane')=>provider==='claude-code'?{kind:'claude-code-process',incarnationId:randomUUID(),nativeSessionId:null}:{kind:'arcane-gateway-loop',incarnationId:randomUUID()};
 const waitFor=(action:string,count:number)=>new Promise<void>(resolve=>{const check=()=>{if(child.sent.filter(r=>r.command.action===action).length>=count){child.off('sent',check);resolve();}};child.on('sent',check);check();});
 return{directory,registry,control,child,host,binding,waitFor};
}

for(const provider of ['claude-code','arcane'] as const)test(provider+' end-to-end private channel retains exact app anchor without public credential serialization',{timeout:5000},async t=>{
 const f=fixture(t),conversationId=randomUUID(),context=await f.host.issue({provider,conversationId,connectionId:randomUUID()}),env=context.launchEnvironment(),token=env.ARCANE_ASSET_TOKEN!;
 assert.match(token,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(env),[]);assert.equal(JSON.stringify(env),'{}');assert.equal(JSON.stringify(context),'{}');assert.equal(Object.hasOwn(context,'credential'),false);
 assert.throws(()=>f.registry.capture(token,'read'));await context.bind(f.binding(provider));
 assert.deepEqual(nativeAssetActorScope(f.registry.capture(token,'read')).conversation,{provider,threadId:'app:'+conversationId,sessionId:null});
 await context.grantNextIntent();const operation=randomUUID();await context.dispatched(operation);const actor=f.registry.capture(token,'mutate'),signal=nativeAssetOperationSignal(actor),lease=acquireNativeAssetWork(actor,'generation');
 await context.ended(operation);await context.retire();assert.equal(signal.aborted,false);assert.throws(()=>context.launchEnvironment());
 await context.cancelWork('incarnation');assert.equal(signal.aborted,true);await context.transportClosed();lease.finish('closed');
});

test('lost issue ACK cleans exact original identity once, drops late secrets and never silently reissues',{timeout:5000},async t=>{
 const f=fixture(t);f.child.hold.add('issue');
 const issued=f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});await assert.rejects(issued,{code:'UNKNOWN'});
 const issues=f.child.sent.filter(r=>r.command.action==='issue'),cleanups=f.child.sent.filter(r=>r.command.action==='retire-issue');assert.equal(issues.length,1);assert.equal(cleanups.length,1);
 const original=issues[0]!,cleanup=cleanups[0]!;assert.equal(cleanup.command.action,'retire-issue');if(cleanup.command.action!=='retire-issue')assert.fail();
 assert.equal(cleanup.command.issueSequence,original.sequence);assert.equal(cleanup.command.issueRequestId,original.requestId);assert.ok(cleanup.sequence>original.sequence);assert.notEqual(cleanup.requestId,original.requestId);
 const late=f.child.replies[0]!;assert.equal(late.outcome,'ok');if(late.outcome!=='ok')assert.fail();const token=late.result.credential!;assert.throws(()=>f.registry.capture(token,'read'));
 f.child.emit('message',late);f.child.hold.clear();const next=await f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});assert.notEqual(next.launchEnvironment().ARCANE_ASSET_TOKEN,token);
});

test('lost dispatch ACK is unknown, retires admission and preserves accepted work for explicit Stop',{timeout:5000},async t=>{
 const f=fixture(t),context=await f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()}),token=context.launchEnvironment().ARCANE_ASSET_TOKEN!;
 await context.bind(f.binding('arcane'));await context.grantNextIntent();f.child.hold.add('dispatched');const operation=randomUUID(),dispatch=context.dispatched(operation);
 const actor=f.registry.capture(token,'mutate'),signal=nativeAssetOperationSignal(actor),lease=acquireNativeAssetWork(actor,'generation');
 await assert.rejects(dispatch,{code:'UNKNOWN'});assert.equal(f.child.sent.filter(r=>r.command.action==='dispatched').length,1);assert.equal(signal.aborted,false);assert.throws(()=>f.registry.capture(token,'read'));
 f.child.emit('message',f.child.replies[0]);await context.cancelWork('incarnation');assert.equal(signal.aborted,true);await context.transportClosed();lease.finish('closed');
});

test('reordered replies correlate by exact sequence UUID epoch; other child and stale epoch cannot complete calls',{timeout:5000},async t=>{
 const f=fixture(t);f.child.hold.add('issue');
 const one=f.host.issue({provider:'claude-code',conversationId:randomUUID(),connectionId:randomUUID()}),two=f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});
 await f.waitFor('issue',2);assert.equal(f.child.replies.length,2);
 const a=f.child.replies[0]!,b=f.child.replies[1]!;const foreign=new EventEmitter();foreign.emit('message',a);
 f.child.emit('message',{...a,epoch:randomUUID()});f.child.emit('message',{...a,requestId:b.requestId});
 f.child.emit('message',b);f.child.emit('message',a);const [ca,cb]=await Promise.all([one,two]);assert.notEqual(ca.launchEnvironment().ARCANE_ASSET_TOKEN,cb.launchEnvironment().ARCANE_ASSET_TOKEN);
});

test('fence before issue ACK returns no launch context, cleans once, rejects late replies and detaches only owned listeners',{timeout:5000},async t=>{
 const f=fixture(t);f.child.hold.add('issue');let outside=0;const observer=()=>{outside++;};f.child.on('message',observer);
 const pending=f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()});await f.waitFor('issue',1);assert.equal(f.child.replies.length,1);
 f.host.fence();await assert.rejects(pending,{code:'UNKNOWN'});assert.equal(f.child.sent.filter(r=>r.command.action==='retire-issue').length,1);await assert.rejects(f.host.issue({provider:'arcane',conversationId:randomUUID(),connectionId:randomUUID()}),{code:'CLOSED'});
 f.host.close();assert.equal(f.child.listenerCount('message'),1);const before=outside;f.child.emit('message',f.child.replies[0]);assert.equal(outside,before+1);f.child.off('message',observer);
});

test('product composition routes only private Node IPC and fences before asynchronous shutdown without changing mesh consent',()=>{
 const product=readFileSync(join(process.cwd(),'apps/daemon/src/product-main.ts'),'utf8'),lab=readFileSync(join(process.cwd(),'apps/daemon/src/lab-server.ts'),'utf8');
 assert.match(product,/if\(routeAppAssetMessage\(app\.appAssets,message,reply=>/);assert.match(product,/app\.meshKeep\?\.acceptConsent\(message\)/);
 assert.ok(product.indexOf('app.appAssets?.close();')<product.indexOf('const deadline = setTimeout'));
 assert.match(lab,/appAssets\?\.close\(\); handoffs\?\.close\(\); nativeAssetRegistry\?\.close\(\)/);
 assert.doesNotMatch(product,/arcane-ready[^\n]*appAssets|arcane-ready[^\n]*credential/);assert.doesNotMatch(lab,/JSON\.stringify\([^\n]*appAssets/);
});
