import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vm from 'node:vm';

// Exact main-process blocks and the actual private broker in one VM realm.
// Electron, daemon IPC receipts and filesystem project metadata are scripted;
// no app, OS child, credentials/profile, provider or Studio is opened.
const root=process.cwd(),require=createRequire(import.meta.url);
const source=readFileSync(join(root,'apps/desktop/electron/main.cjs'),'utf8').replaceAll('\r\n','\n');
const brokerSource=readFileSync(join(root,'apps/desktop/electron/app-asset-host.cjs'),'utf8');
const policy=require(join(root,'apps/desktop/electron/policy.cjs'));
const ORIGIN='http://127.0.0.1:45871',TOKEN='b'.repeat(64),ASSET='1'.repeat(64);
const CONVERSATION='18242a29-6d33-4477-8247-a08f685e2c29',CONNECTION='6f9870a0-47c8-4e32-bcaf-24f4d25d1251';
function block(begin:string,end:string){const a=source.indexOf(begin),b=source.indexOf(end,a+begin.length);assert.ok(a>=0&&b>a,'Exact named main block must exist.');return source.slice(a,b);}
function deferred<T>(){let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
interface Wire {type:string;protocolVersion:number;sequence:number;requestId:string;projectId:string;epoch:string;command:Record<string,unknown>}
class OwnedChild extends EventEmitter {
  connected=true;exitCode:number|null=null;signalCode:string|null=null;killed=0;requests:Wire[]=[];shutdowns:unknown[]=[];
  held=new Set<string>();throwShutdown=false;parse!:(text:string)=>unknown;
  send(value:Wire,callback?:(error?:Error|null)=>void){
    if(value.type==='arcane-shutdown'){if(this.throwShutdown)throw Error('controlled shutdown send failure');this.shutdowns.push(value);callback?.(null);return true;}
    this.requests.push(value);this.emit('request',value);callback?.(null);
    if(!this.held.has(String(value.command.action)))queueMicrotask(()=>this.answer(value));return true;
  }
  answer(request:Wire,rejected=false){
    const result=request.command.action==='issue'?{action:'issue',issueSequence:request.sequence,issueRequestId:request.requestId,credential:ASSET}:{action:request.command.action};
    this.emit('message',this.parse(JSON.stringify({type:'arcane-app-asset-reply',protocolVersion:1,sequence:request.sequence,requestId:request.requestId,projectId:request.projectId,epoch:request.epoch,
      ...(rejected?{outcome:'rejected',code:'REJECTED'}:{outcome:'ok',result})})));
  }
  wait(action:string,count=1):Promise<Wire>{
    const matching=this.requests.filter(request=>request.command.action===action);if(matching.length>=count)return Promise.resolve(matching[count-1]!);
    return new Promise(resolve=>{const onRequest=(request:Wire)=>{if(request.command.action===action&&this.requests.filter(value=>value.command.action===action).length>=count){this.off('request',onRequest);resolve(request);}};this.on('request',onRequest);});
  }
  kill(){this.killed++;return true;}
  exit(code=0){this.exitCode=code;this.connected=false;this.emit('exit',code,null);this.emit('close',code,null);}
}
async function fixture(t:TestContext,{switching=false,heldOpen=false}={}){
  const child=new OwnedChild(),calls:string[]=[],captures=new Map<string,Record<string,any>>(),brokers:Record<string,any>[]=[];
  if(heldOpen)child.held.add('open');
  const frame={url:ORIGIN+'/studio'},contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,mainFrame:frame});
  const owner={isDestroyed:()=>false,webContents:contents},project=Object.freeze({projectId:'fixture',projectPath:'/fixed-project',stateRoot:'/fixed-state'});
  const handlers=new Map<string,(event:unknown,...args:unknown[])=>Promise<{state:string}>>();
  const context=vm.createContext({child,window:owner,projectSession:project,appAssets:null,assetSelectionGeneration:0,assetSelectionReady:false,
    smoke:false,closing:false,switching,origin:ORIGIN,token:TOKEN,policy,URL,Buffer,process:{platform:process.platform},setTimeout,clearTimeout,
    claudeChat:null,arcaneChat:null,nativeHandoff:{prepareChat:async()=>null,releaseChat:async()=>true,dispose:async()=>null,cancelPending(){}},
    projectPermissions:null,billing:null,productRoot:'/fixed-product',dialog:{},learnedContext:async()=>'',join,
    ownedDirectory:async(path:string)=>path,providerSetup:{cancelPending(){calls.push('provider-cancel');}},retireDiagnosticChild(){calls.push('diagnostics-retire');},
    runtimeRecovery:{invalidate(){calls.push('recovery-invalidate');},navigatedInPage(){}},
    ipcMain:{handle(channel:string,handler:(event:unknown,...args:unknown[])=>Promise<{state:string}>){assert.ok(!handlers.has(channel));handlers.set(channel,handler);}},
    require(name:string){
      if(name==='./app-asset-host.cjs'){
        const module={exports:{}};const factory=vm.runInContext('(function(module,exports,require){\n'+brokerSource+'\n})',context);
        factory(module,module.exports,(id:string)=>id==='node:fs'?{realpathSync(path:string){assert.equal(path,project.projectPath);return path;},lstatSync(){return{isDirectory:()=>true};}}:require(id));
        const actual=module.exports as {createAppAssetHost(options:unknown):Record<string,any>};
        return{createAppAssetHost(options:{child:OwnedChild;projectPath:string}){
          assert.equal(options.child,child);assert.equal(options.projectPath,project.projectPath);calls.push('construct');
          const raw=actual.createAppAssetHost(options),broker=Object.freeze({...raw,fence(){calls.push('asset-fence');return raw.fence();},close(){calls.push('asset-close');return raw.close();}});
          brokers.push(broker);return broker;
        }};
      }
      if(name==='./claude-chat.cjs'||name==='./arcane-chat.cjs')return{[name==='./claude-chat.cjs'?'createClaudeChat':'createArcaneChat']:(options:Record<string,any>)=>{
        captures.set(name,options);calls.push(name);return{dispose:async()=>{calls.push('chat-dispose');}};
      }};
      throw Error('Unexpected main fixture require.');
    }
  });
  child.parse=vm.runInContext('(text)=>JSON.parse(text)',context) as (text:string)=>unknown;
  const code=block('/** Exact main-frame workspace renderer','const CODE_VERIFICATION_WARNING')+
    block('// App-asset authority belongs','// In-app Claude chat:')+
    block('function stopClaudeChat(reason)','/** Learned preferences')+
    block('async function startClaudeChat()','async function stopDaemon()')+
    block('async function stopDaemon()','async function startDaemon(');
  vm.runInContext(code,context);
  vm.runInContext(block("      ipcMain.handle('arcane:asset-conversation-select'","      require('./claude-chat.cjs').installClaudeChatIpc"),context);
  t.after(()=>{for(const broker of brokers)broker.close();if(child.exitCode===null)child.exit();});
  const event=()=>({sender:contents,senderFrame:frame});
  const realm=(value:unknown)=>{const encoded=JSON.stringify(value);assert.equal(typeof encoded,'string');return child.parse(encoded!);};
  const invoke=(value:unknown,e:unknown=event(),extra:unknown[]=[])=>handlers.get('arcane:asset-conversation-select')!(e,realm(value),...extra);
  const start=()=>context.startAppAssets(child,project) as Promise<void>;
  return{context,child,frame,contents,owner,project,calls,captures,handlers,event,realm,invoke,start,brokers};
}

test('main assets wait for actual broker-ready ACK while startup may be switching, then fix both provider ports',{timeout:10000},async t=>{
  const f=await fixture(t,{switching:true,heldOpen:true}),starting=f.start();const opening=await f.child.wait('open');
  let ready=false;void starting.then(()=>{ready=true;});assert.equal(ready,false);assert.equal(f.captures.size,0);
  f.child.answer(opening);await starting;assert.equal(ready,true);await f.context.startClaudeChat();
  const claude=f.captures.get('./claude-chat.cjs')!,arcane=f.captures.get('./arcane-chat.cjs')!;assert.ok(claude&&arcane);
  assert.equal(claude.appAssets.isCurrent(),false);assert.equal(arcane.appAssets.isCurrent(),false);f.context.switching=false;
  for(const [options,provider] of [[claude,'claude-code'],[arcane,'arcane']] as const){
    assert.equal(options.appAssets.isCurrent(),true);assert.deepEqual(Object.keys(options.appAssets).sort(),['isCurrent','issue']);
    const context=await options.appAssets.issue(f.realm({conversationId:CONVERSATION,connectionId:CONNECTION}));
    const request=f.child.requests.filter(value=>value.command.action==='issue').at(-1)!;
    assert.equal(request.command.provider,provider);assert.equal(request.command.conversationId,CONVERSATION);assert.equal(request.command.connectionId,CONNECTION);
    assert.deepEqual(Object.keys(request.command).sort(),['action','connectionId','conversationId','provider']);
    assert.deepEqual(Object.keys(context.launchEnvironment()),[]);await context.retire();await context.transportClosed();
  }
  assert.equal(f.child.requests.filter(request=>request.command.action==='grant-next').length,0,'Constructing a provider port does not grant native permission.');
});
test('main assets reject late ready ACK after owned epoch changes and fence the original broker',{timeout:10000},async t=>{
  const f=await fixture(t,{heldOpen:true}),starting=f.start(),opening=await f.child.wait('open');f.context.projectSession=Object.freeze({...f.project});
  f.child.answer(opening);await assert.rejects(starting,/App asset runtime is unavailable/);assert.ok(f.calls.includes('asset-fence'));assert.equal(f.brokers[0]!.isCurrent(),false);assert.equal(f.captures.size,0);
});
test('main provider asset ports refuse every stale runtime fence before issue and never adopt another broker',{timeout:10000},async t=>{
  const changes:[string,(f:Awaited<ReturnType<typeof fixture>>)=>void][]=[
    ['switch',f=>{f.context.switching=true;}],['closing',f=>{f.context.closing=true;}],['project',f=>{f.context.projectSession=Object.freeze({...f.project});}],
    ['broker',f=>{f.context.appAssets={isCurrent:()=>true};}],['child',f=>{f.context.child=new OwnedChild();}],['disconnect',f=>{f.child.connected=false;}],
    ['exit',f=>{f.child.exitCode=0;}],['signal',f=>{f.child.signalCode='SIGTERM';}],['origin',f=>{f.context.origin='';}],['token',f=>{f.context.token='';}],['broker-fence',f=>{f.brokers[0]!.fence();}]
  ];
  for(const [name,change] of changes){const f=await fixture(t);await f.start();await f.context.startClaudeChat();const port=f.captures.get('./claude-chat.cjs')!.appAssets;change(f);
    assert.equal(port.isCurrent(),false,name);await assert.rejects(port.issue(f.realm({conversationId:CONVERSATION,connectionId:CONNECTION})),/unavailable/,name);
    assert.equal(f.child.requests.filter(request=>request.command.action==='issue').length,0,name);
  }
});
test('main loses an epoch after issue ACK without handing out credentials and closes only its definitive no-child context',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();await f.context.startClaudeChat();const port=f.captures.get('./claude-chat.cjs')!.appAssets;
  f.child.held.add('issue');const pending=port.issue(f.realm({conversationId:CONVERSATION,connectionId:CONNECTION}));const issued=await f.child.wait('issue');
  f.context.projectSession=Object.freeze({...f.project});f.child.answer(issued);await assert.rejects(pending,error=>!!error&&typeof error==='object'&&'message' in error&&typeof error.message==='string'&&!error.message.includes(ASSET));
  assert.deepEqual(f.child.requests.map(request=>request.command.action),['open','issue','retire','transport-closed']);
  assert.equal(f.child.requests.filter(request=>request.command.action==='issue').length,1);assert.equal(f.captures.size,2);
});
test('main does not mount a stale chat when its owned directory returns after project replacement',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();const directory=deferred<string>();f.context.ownedDirectory=()=>directory.promise;
  const mounting=f.context.startClaudeChat();f.context.projectSession=Object.freeze({...f.project});directory.resolve('/fixed-state/claude-chat');await mounting;assert.equal(f.captures.size,0);
});
test('main human selection mounts one trusted mainframe IPC, validates the exact union in the actual broker and returns no secret',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();assert.deepEqual([...f.handlers.keys()],['arcane:asset-conversation-select']);
  for(const selection of [null,{provider:'codex'},{provider:'claude-code',conversationId:CONVERSATION},{provider:'arcane',conversationId:CONVERSATION}]){
    const response=await f.invoke(selection);assert.deepEqual(JSON.parse(JSON.stringify(response)),{state:'selected'});assert.equal(Object.isFrozen(response),true);
  }
  const before=f.child.requests.length;
  for(const selection of [{provider:'other'},{provider:'arcane'},{provider:'arcane',conversationId:'not-a-uuid'},{provider:'codex',conversationId:CONVERSATION},{provider:'arcane',conversationId:CONVERSATION,credential:ASSET},[]])
    assert.equal((await f.invoke(selection)).state,'unavailable');
  assert.equal(f.child.requests.length,before);assert.ok(f.child.requests.slice(1).every(request=>request.command.action==='select-human'));
  assert.equal(JSON.stringify(await f.invoke(null)).includes(ASSET),false);
});
test('main human selection refuses subframes, foreign senders, origin changes, extra args and unavailable runtime without reaching the broker',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();const before=f.child.requests.length;
  assert.equal((await f.invoke(null,{sender:{},senderFrame:f.frame})).state,'unavailable');
  assert.equal((await f.invoke(null,{sender:f.contents,senderFrame:{url:f.frame.url}})).state,'unavailable');
  assert.equal((await f.invoke(null,f.event(),['extra'])).state,'unavailable');
  f.frame.url='https://outside.invalid/studio';assert.equal((await f.invoke(null)).state,'unavailable');f.frame.url=ORIGIN+'/studio';
  f.context.switching=true;assert.equal((await f.invoke(null)).state,'unavailable');f.context.switching=false;
  f.context.smoke=true;assert.equal((await f.invoke(null)).state,'unavailable');assert.equal(f.child.requests.length,before);
});
for(const transition of ['project','window','frame','url','destroyed'] as const)test('main selection withholds an ACK after '+transition+' changes',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();f.child.held.add('select-human');const selected=f.invoke({provider:'arcane',conversationId:CONVERSATION});const request=await f.child.wait('select-human');
  if(transition==='project')f.context.projectSession=Object.freeze({...f.project});
  else if(transition==='window')f.context.window={...f.owner};
  else if(transition==='frame')f.contents.mainFrame={url:f.frame.url};
  else if(transition==='url')f.frame.url=ORIGIN+'/studio#changed';
  else f.owner.isDestroyed=()=>true;
  f.child.answer(request);assert.equal((await selected).state,'unavailable');assert.equal(f.context.assetSelectionReady,false);
});
test('main navigation clears only the current non-inPlace mainframe and stale selection ACKs cannot arm the new view',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();assert.equal((await f.invoke({provider:'codex'})).state,'selected');
  vm.runInContext(block("  window.webContents.on('did-start-navigation'","  window.webContents.on('render-process-gone'"),Object.assign(f.context,{owner:f.owner}));
  const initial=f.context.assetSelectionGeneration;f.contents.emit('did-start-navigation',{},ORIGIN+'/studio',false,false);
  f.contents.emit('did-start-navigation',{},ORIGIN+'/studio#same',true,true);assert.equal(f.context.assetSelectionGeneration,initial);assert.equal(f.context.assetSelectionReady,true);
  f.child.held.add('select-human');const old=f.invoke({provider:'arcane',conversationId:CONVERSATION}),oldRequest=await f.child.wait('select-human',2);
  f.contents.emit('did-start-navigation',{},ORIGIN+'/studio',false,true);const clearing=await f.child.wait('select-human',3);
  assert.equal(clearing.command.selection,null);assert.equal(f.context.assetSelectionReady,false);
  const latest=f.invoke({provider:'claude-code',conversationId:CONVERSATION}),latestRequest=await f.child.wait('select-human',4);
  f.child.answer(clearing,true);assert.equal(f.context.assetSelectionReady,false,'A failed/unknown clear is not a daemon acknowledgement.');
  f.child.answer(oldRequest);assert.equal((await old).state,'unavailable');assert.equal(f.context.assetSelectionReady,false);
  f.child.answer(latestRequest);assert.equal((await latest).state,'selected');assert.equal(f.context.assetSelectionReady,true);
  const count=f.child.requests.length;f.context.window={...f.owner};f.contents.emit('did-start-navigation',{},ORIGIN+'/studio',false,true);assert.equal(f.child.requests.length,count,'Inactive window cannot clear another view.');
});
test('main shutdown fences and clears app authority synchronously, requests daemon shutdown immediately and closes the broker after owned cleanup',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();const cleanup=deferred<void>();f.context.nativeHandoff={dispose(){f.calls.push('handoff-dispose');return cleanup.promise;}};
  let done=false;const stopping=(f.context.stopDaemon() as Promise<boolean>).then(value=>{done=true;return value;});
  assert.equal(f.context.appAssets,null);assert.equal(f.context.assetSelectionReady,false);assert.equal(f.brokers[0]!.isCurrent(),false);
  assert.deepEqual([f.context.child,f.context.token,f.context.origin],[null,'','']);assert.equal(f.child.shutdowns.length,1);assert.ok(f.calls.indexOf('asset-fence')<f.calls.indexOf('handoff-dispose'));assert.equal(f.calls.includes('asset-close'),false);
  f.child.exit();assert.equal(done,false);cleanup.resolve();assert.equal(await stopping,true);assert.equal(f.calls.filter(call=>call==='asset-close').length,1);
  assert.equal(f.child.requests.some(request=>request.command.action==='transport-closed'),false,'Daemon shutdown is not provider transport attestation.');
});
test('main shutdown still closes its fenced broker after a throwing shutdown send and never reports clean',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();f.child.throwShutdown=true;
  await assert.rejects(f.context.stopDaemon(),/controlled shutdown send failure/);assert.equal(f.context.appAssets,null);assert.ok(f.calls.includes('asset-fence'));assert.ok(f.calls.includes('asset-close'));
});
test('main shutdown retains the exact15-second bound and a kill request cannot become clean shutdown',{timeout:10000},async t=>{
  const f=await fixture(t);await f.start();const timeout:{fire?:(()=>void)}={};
  f.context.setTimeout=(callback:()=>void,ms:number)=>{assert.equal(ms,15000);timeout.fire=callback;return 1;};f.context.clearTimeout=()=>{};
  const stopping=f.context.stopDaemon() as Promise<boolean>;assert.equal(typeof timeout.fire,'function');timeout.fire!();assert.equal(await stopping,false);assert.equal(f.child.killed,1);assert.equal(f.child.exitCode,null);assert.ok(f.calls.includes('asset-close'));
});
test('main source constructs the asset broker after projectSession and before the unchanged native handoff block',{timeout:10000},()=>{
  const start=source.indexOf('async function startDaemon('),session=source.indexOf('  projectSession = Object.freeze(',start),assets=source.indexOf('  await startAppAssets(owned, projectSession);',session),handoff=source.indexOf("  const handoffDirectory = await ownedDirectory(join(stateRoot, 'native-handoffs'));",session);
  assert.ok(start>=0&&session>start&&assets>session&&handoff>assets);assert.equal(source.match(/ipcMain\.handle\('arcane:asset-conversation-select'/g)?.length,1);
});
