import nodeTest,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';

const test=(name:string,run:(t:TestContext)=>void|Promise<void>)=>nodeTest(name,{timeout:10_000},run);

const PROJECT='C:/synthetic/current-project',OTHER='C:/synthetic/other-project';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
type Selection=null|{provider:string;conversationId?:string};
type Scope=null|{provider:string;threadId:string;sessionId:string|null;projectPath:string};
const studio=await readFile(join(process.cwd(),'apps/desktop/src/studio.ts'),'utf8');
const coordinator=await readFile(join(process.cwd(),'apps/desktop/src/asset-conversation-selection.ts'),'utf8');
const review=await readFile(join(process.cwd(),'apps/desktop/src/asset-review.ts'),'utf8');
function section(source:string,start:string,end:string):string{
  const begin=source.indexOf(start);assert.ok(begin>=0&&source.indexOf(start,begin+start.length)<0,'Production start anchor must be unique');
  const finish=source.indexOf(end,begin+start.length);assert.ok(finish>begin,'Production end anchor must follow its start');
  return source.slice(begin,finish);
}
function local(source:string,declaration:string):string{
  const emitted=stripTypeScriptTypes(source,{mode:'transform'}),needle='export '+declaration;
  assert.equal(emitted.split(needle).length,2,'Remove only the expected export declaration');
  const result=emitted.replace(needle,declaration);assert.doesNotMatch(result,/^\s*(?:import|export)\b/m);
  return result;
}
const mount=section(studio,'  // Bind review to the actual provider transcript, never the shared library row.','  if (chatLink &&');
const workbench=section(studio,'  const workbench = new StudioWorkbench(','  // Script-editor drafts:');
const arcane=section(studio,'    const chat = arcaneChat = new module.ArcaneChat(document);','    // The sign-in card offers Arcane Credits');
const registry=section(review,'const documentSelections = new WeakMap','\ninterface Session {');
const coordinatorJs=local(coordinator,'class AssetConversationSelection');
const registryJs=local(registry,'function installAssetReviewSelection');

// Every peer, bridge reply and state object is created INSIDE the actual VM
// realm. The strict coordinator must not reject a host-realm fixture object.
// We execute production mount/options/registry/coordinator code, not actual
// provider constructors, the complete workbench or the model-review card DOM.
const harness=String.raw`
var selectionCalls=[],surfaceListeners=new Set(),projectListeners=new Set(),pageListeners=new Map();
var contextChanges=0,reviewPrepares=0,arcaneConstructed=0,savedScope=null,workbenchOptions=null;
var activeProvider=initial.provider||'claude';
var activeProject=Object.hasOwn(initial,'project')?initial.project:'C:/synthetic/current-project';
function makePeer(name,defaults){
  var state={...defaults,...(initial[name]||{})},listeners=new Set();
  return {
    recordedTranscript(){return state.transcript;},
    isDraftConversation(){return state.draft;},
    workflowConversation(){return state.native||null;},
    subscribeTranscriptChange(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    subscribeWorkflowContextChange(){return()=>{};},
    replace(json){state={...state,...JSON.parse(json)};for(var listener of [...listeners])listener();},
    tokens(count){for(var at=0;at<count;at++){state.transcript={...state.transcript,tokens:at};for(var listener of [...listeners])listener();}},
  };
}
var peers={
  codex:makePeer('codex',{draft:false,transcript:{provider:'codex',projectPath:'C:/synthetic/current-project',conversationId:'native-codex-thread',sessionId:'native-codex-session'},
    native:{provider:'codex',projectPath:'C:/synthetic/current-project',threadId:'native-codex-thread',sessionId:'native-codex-session'}}),
  claude:makePeer('claude',{draft:false,transcript:{provider:'claude-code',projectPath:'C:/synthetic/current-project',conversationId:'11111111-1111-4111-8111-111111111111',sessionId:'observed-native-Claude-session',sharedTabId:'never-an-app-anchor'}}),
  arcane:makePeer('arcane',{draft:false,transcript:{provider:'arcane',projectPath:'C:/synthetic/current-project',conversationId:'33333333-3333-4333-8333-333333333333',sessionId:null,sharedTabId:'never-an-app-anchor'}})
};
var codexChat=peers.codex,claudeChat=peers.claude,arcaneChat=null;
var providerSetup={
  chatSurface(){return activeProvider;},
  subscribeChatSurface(listener){surfaceListeners.add(listener);return()=>surfaceListeners.delete(listener);},
  isSignedIn(){return true;},subscribeSignInChange(){return()=>{};}
};
var window={
  location:{origin:'http://127.0.0.1:45871'},
  arcaneDesktop:{runtime:'desktop',selectAssetConversation(selection){
    return new Promise((resolve,reject)=>selectionCalls.push({selection,resolve,reject}));
  }},
  addEventListener(name,listener){if(!pageListeners.has(name))pageListeners.set(name,new Set());pageListeners.get(name).add(listener);}
};
if(initial.missingBridge)delete window.arcaneDesktop.selectAssetConversation;
var document={defaultView:window},token='synthetic-workspace-control';
class StudioApi{constructor(){}}
class StudioWorkbench{
  constructor(doc,api,origin,control,options){
    workbenchOptions=options;options.subscribeContextChange(()=>{contextChanges++;});
  }
  historyProjectPath(){return activeProject;}
  subscribeProjectChange(listener){projectListeners.add(listener);return()=>projectListeners.delete(listener);}
}
var module={ArcaneChat:class{
  constructor(doc){if(doc!==document)throw Error('Unexpected fixture document');arcaneConstructed++;return peers.arcane;}
}};
`;
interface MountControl {
  calls():string;scope():string;notifyCount():number;prepares():number;constructorCount():number;
  ack(index:number,json:string):void;reject(index:number):void;settleAll():void;
  provider(value:string):void;peer(name:string,json:string):void;tokens(name:string,count:number):void;
  project(json:string):void;page(name:string,persisted:boolean):void;
  mark():void;sameScope():boolean;beginReview():Promise<boolean>;
}
async function drain(){for(let at=0;at<20;at++)await Promise.resolve();}
function fixture(t:TestContext,initial:Record<string,unknown>={}){
  const context=createContext({});
  runInContext('var initial=JSON.parse('+JSON.stringify(JSON.stringify(initial))+');\n'+coordinatorJs+'\n'+registryJs+'\n'+harness+'\n'+stripTypeScriptTypes(mount,{mode:'transform'})+'\n'+stripTypeScriptTypes(workbench,{mode:'transform'}),context,{timeout:1000});
  const control=runInContext(`({
    calls(){return JSON.stringify(selectionCalls.map(call=>call.selection));},
    scope(){return JSON.stringify(workbenchOptions.getNativeConversation());},
    notifyCount(){return contextChanges;},prepares(){return reviewPrepares;},constructorCount(){return arcaneConstructed;},
    ack(index,json){selectionCalls[index].resolve(JSON.parse(json));},
    reject(index){selectionCalls[index].reject(Error('Synthetic selection refusal'));},
    settleAll(){for(var call of selectionCalls)call.resolve({state:'unavailable'});},
    provider(value){activeProvider=value;for(var listener of [...surfaceListeners])listener();},
    peer(name,json){peers[name].replace(json);},tokens(name,count){peers[name].tokens(count);},
    project(json){activeProject=JSON.parse(json);for(var listener of [...projectListeners])listener();},
    page(name,persisted){for(var listener of [...(pageListeners.get(name)||[])])listener({persisted});},
    mark(){savedScope=workbenchOptions.getNativeConversation();},
    sameScope(){return savedScope===workbenchOptions.getNativeConversation();},
    async beginReview(){
      var selection=documentSelections.get(document);if(!selection)throw Error('No mounted human selection');
      var current=await selection.ready();if(!current())throw Error('Obsolete human selection');
      reviewPrepares++;return current();
    }
  })`,context,{timeout:1000}) as MountControl;
  t.after(async()=>{control.page('pagehide',false);for(let at=0;at<3;at++){control.settleAll();await drain();}});
  return {
    control,calls:()=>JSON.parse(control.calls()) as Selection[],scope:()=>JSON.parse(control.scope()) as Scope,
    ack(index:number,state:'selected'|'unavailable'='selected'){control.ack(index,JSON.stringify({state}));},
    peer(name:string,value:Record<string,unknown>){control.peer(name,JSON.stringify(value));},
    project(value:string|null){control.project(JSON.stringify(value));},
    mountArcane(){runInContext(stripTypeScriptTypes(arcane,{mode:'transform'}),context,{timeout:1000});},
    beginReview(){const pending=control.beginReview();void pending.catch(()=>{});return pending;},
  };
}

test('production Codex mount waits for the native ACK and publishes the real workflow scope',async t=>{
  const f=fixture(t,{provider:'codex'});await drain();
  assert.deepEqual(f.calls(),[{provider:'codex'}]);assert.equal(f.scope(),null);
  const pending=f.beginReview();assert.equal(f.control.prepares(),0);
  f.ack(0);await drain();assert.equal(await pending,true);
  assert.deepEqual(f.scope(),{provider:'codex',projectPath:PROJECT,threadId:'native-codex-thread',sessionId:'native-codex-session'});
});

test('production Claude mount uses the durable app CID rather than native session or shared library identity',async t=>{
  const f=fixture(t);await drain();assert.deepEqual(f.calls(),[{provider:'claude-code',conversationId:A}]);
  assert.equal(f.scope(),null);f.ack(0);await drain();
  assert.deepEqual(f.scope(),{provider:'claude-code',threadId:'app:'+A,sessionId:null,projectPath:PROJECT});
});

test('the exact lazy Arcane constructor-wiring prefix subscribes and publishes the durable Arcane anchor after ACK',async t=>{
  const f=fixture(t,{provider:'arcane'});await drain();assert.deepEqual(f.calls(),[null]);assert.equal(f.scope(),null);
  f.ack(0);await drain();f.mountArcane();await drain();
  assert.equal(f.control.constructorCount(),1);assert.deepEqual(f.calls()[1],{provider:'arcane',conversationId:C});
  assert.equal(f.scope(),null);f.ack(1);await drain();
  assert.deepEqual(f.scope(),{provider:'arcane',threadId:'app:'+C,sessionId:null,projectPath:PROJECT});
  const changes=f.control.notifyCount();f.control.tokens('arcane',100);await drain();
  assert.equal(f.control.notifyCount(),changes);assert.equal(f.calls().length,2);
});

for(const peer of ['claude','arcane'] as const)test(peer+' empty draft never inherits an available Codex workflow scope',async t=>{
  const initial:Record<string,unknown>={provider:peer,[peer]:{draft:true,transcript:null}};
  const f=fixture(t,initial);if(peer==='arcane')f.mountArcane();await drain();
  assert.deepEqual(f.calls(),[null]);f.ack(0);await drain();assert.equal(f.scope(),null);
  await assert.rejects(f.beginReview());assert.equal(f.control.prepares(),0);
});

test('a held old ACK cannot publish scope or prepare a scripted human review after the provider switches',async t=>{
  const f=fixture(t);await drain();const old=f.beginReview(),refused=assert.rejects(old);
  f.control.provider('codex');assert.equal(f.scope(),null);await refused;assert.equal(f.control.prepares(),0);
  f.ack(0);await drain();assert.equal(f.scope(),null);assert.deepEqual(f.calls()[1],{provider:'codex'});
  const latest=f.beginReview();f.ack(1);await drain();assert.equal(await latest,true);assert.equal(f.control.prepares(),1);
  assert.equal(f.scope()!.provider,'codex');
});

test('a late Codex acknowledgement cannot publish over the latest Claude app anchor',async t=>{
  const f=fixture(t,{provider:'codex'});await drain();const old=f.beginReview(),refused=assert.rejects(old);
  f.control.provider('claude');await refused;f.ack(0);await drain();assert.equal(f.scope(),null);
  assert.deepEqual(f.calls()[1],{provider:'claude-code',conversationId:A});
  const latest=f.beginReview();assert.equal(f.control.prepares(),0);f.ack(1);await drain();assert.equal(await latest,true);
  assert.deepEqual(f.scope(),{provider:'claude-code',threadId:'app:'+A,sessionId:null,projectPath:PROJECT});
});

test('the actual Codex peer thread and session change require another ACK even though the wire provider stays Codex',async t=>{
  const f=fixture(t,{provider:'codex'});await drain();f.ack(0);await drain();assert.ok(f.scope());
  f.peer('codex',{draft:false,transcript:{provider:'codex',projectPath:PROJECT,conversationId:'native-new-thread',sessionId:'native-new-session'},
    native:{provider:'codex',projectPath:PROJECT,threadId:'native-new-thread',sessionId:'native-new-session'}});
  assert.equal(f.scope(),null);await drain();assert.deepEqual(f.calls()[1],{provider:'codex'});
  f.ack(1);await drain();assert.deepEqual(f.scope(),{provider:'codex',projectPath:PROJECT,threadId:'native-new-thread',sessionId:'native-new-session'});
});

test('switching an acknowledged app conversation clears scope before the next native acknowledgement',async t=>{
  const f=fixture(t);await drain();f.ack(0);await drain();assert.ok(f.scope());
  const changes=f.control.notifyCount();f.control.provider('codex');
  assert.equal(f.scope(),null);assert.ok(f.control.notifyCount()>changes);await drain();assert.equal(f.scope(),null);
  f.ack(1);await drain();assert.equal(f.scope()!.provider,'codex');
});

test('one hundred token-only peer notifications neither refetch nor reset the acknowledged asset scope',async t=>{
  const f=fixture(t);await drain();f.ack(0);await drain();f.control.mark();
  const changes=f.control.notifyCount(),calls=f.calls().length;f.control.tokens('claude',100);await drain();
  assert.equal(f.control.notifyCount(),changes);assert.equal(f.calls().length,calls);assert.equal(f.control.sameScope(),true);
});

for(const state of [
  {project:OTHER},
  {project:null},
  {claude:{draft:false,transcript:{provider:'claude-code',conversationId:A,projectPath:''}}},
  {claude:{draft:false,transcript:{provider:'claude-code',projectPath:PROJECT}}},
])test('production mount refuses wrong or absent project/CID '+JSON.stringify(state),async t=>{
  const f=fixture(t,state);await drain();assert.deepEqual(f.calls(),[null]);
  f.ack(0);await drain();assert.equal(f.scope(),null);await assert.rejects(f.beginReview());assert.equal(f.control.prepares(),0);
});

test('Codex native project disagreement remains empty even when its transcript names the current project',async t=>{
  const f=fixture(t,{provider:'codex',codex:{native:{provider:'codex',threadId:'foreign-thread',sessionId:'foreign-session',projectPath:OTHER}}});
  await drain();assert.deepEqual(f.calls(),[null]);f.ack(0);await drain();assert.equal(f.scope(),null);
});

test('a real project-change notification fences a held old ACK and only a fresh matching app scope can publish',async t=>{
  const f=fixture(t);await drain();f.project(OTHER);assert.equal(f.scope(),null);
  f.ack(0);await drain();assert.deepEqual(f.calls()[1],null);assert.equal(f.scope(),null);f.ack(1);await drain();
  f.peer('claude',{draft:false,transcript:{provider:'claude-code',projectPath:OTHER,conversationId:B,sessionId:'observed-session'}});
  await drain();assert.deepEqual(f.calls()[2],{provider:'claude-code',conversationId:B});assert.equal(f.scope(),null);
  f.ack(2);await drain();assert.deepEqual(f.scope(),{provider:'claude-code',threadId:'app:'+B,sessionId:null,projectPath:OTHER});
});

test('persisted pagehide clears immediately and pageshow needs a fresh acknowledgement before restoring scope',async t=>{
  const f=fixture(t);await drain();f.ack(0);await drain();assert.ok(f.scope());
  f.control.page('pagehide',true);assert.equal(f.scope(),null);await drain();assert.deepEqual(f.calls()[1],null);
  f.control.page('pageshow',true);assert.equal(f.scope(),null);f.ack(1);await drain();
  assert.deepEqual(f.calls()[2],{provider:'claude-code',conversationId:A});assert.equal(f.scope(),null);
  f.ack(2);await drain();assert.equal(f.scope()!.threadId,'app:'+A);
});

test('nonpersisted pagehide unbinds review and preserves only the requested null cleanup',async t=>{
  const f=fixture(t);await drain();f.control.page('pagehide',false);assert.equal(f.scope(),null);
  await assert.rejects(f.beginReview());f.ack(0);await drain();assert.deepEqual(f.calls(),[{provider:'claude-code',conversationId:A},null]);
  f.ack(1);f.control.provider('codex');f.control.tokens('claude',10);await drain();
  assert.equal(f.calls().length,2);assert.equal(f.scope(),null);assert.equal(f.control.prepares(),0);
});

test('a missing native bridge acknowledgement leaves the actual mounted workbench scope unavailable',async t=>{
  const f=fixture(t,{missingBridge:true});await drain();assert.deepEqual(f.calls(),[]);assert.equal(f.scope(),null);
  await assert.rejects(f.beginReview());assert.equal(f.control.prepares(),0);
});
