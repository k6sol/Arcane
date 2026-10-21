import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createArcaneGateway} from '../../apps/daemon/src/arcane-gateway.js';

const require=createRequire(join(process.cwd(),'package.json'));
const {createArcaneChat}=require(join(process.cwd(),'apps/desktop/electron/arcane-chat.cjs')) as {createArcaneChat(options:Record<string,unknown>):any};
const CORE='C'.repeat(43),ASSET='a'.repeat(64);
type Stage='issue'|'bind'|'grantNextIntent'|'dispatched'|'ended'|'retire'|'transportClosed';
function deferred<T>(){let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
type Gate=ReturnType<typeof deferred<void>>;
const input=(text='build',conversationId:string|null=null)=>({text,conversationId,model:'fixture',effort:'standard'});
const encode=(...values:unknown[])=>values.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('');
const done={type:'done',creditsUsed:0};
interface FixtureOptions {
  absent?:boolean;autoClose?:boolean;spawnThrow?:boolean;failWrite?:boolean;pages?:number;limits?:Record<string,number>;
  gates?:Partial<Record<Stage,Gate>>;reject?:Stage;issueHook?:()=>void;
  reply?:(body:any,init:RequestInit)=>Response|Promise<Response>;
  noToolReply?:boolean;toolResult?:unknown;initializeInstructions?:string;
}
async function fixture(t:TestContext,options:FixtureOptions={}){
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'arcane-asset-host-')));
  const project=join(root,'project'),state=join(root,'state'),config=join(root,'mcp.json');
  await fs.mkdir(project);await fs.mkdir(state);
  const configBytes=JSON.stringify({mcpServers:{arcane:{type:'stdio',command:process.execPath,args:['synthetic-no-process']}}});
  await fs.writeFile(config,configBytes);
  const trace:string[]=[],events:any[]=[],calls:any[]=[],issues:any[]=[],bindings:any[]=[],children:FakeChild[]=[],spawns:any[]=[];
  const notices=new Map<string,ReturnType<typeof deferred<void>>>();
  const note=(value:string)=>{trace.push(value);notices.get(value)?.resolve();};
  const wait=(value:string)=>{if(trace.includes(value))return Promise.resolve();let signal=notices.get(value);if(!signal){signal=deferred<void>();notices.set(value,signal);}return signal.promise;};
  let current=true,chat:any,toolCalls=0,listPages=0;
  class FakeChild extends EventEmitter{
    stdout=new PassThrough();stderr=new PassThrough();closed=false;sent:any[]=[];
    stdin={write:(line:string)=>{const request=JSON.parse(line);this.sent.push(request);
      queueMicrotask(()=>{
        if(this.closed||request.id===undefined)return;
        if(request.method==='initialize')this.answer(request.id,{instructions:options.initializeInstructions??'fixture',capabilities:{}});
        else if(request.method==='tools/list'){
          listPages++;this.answer(request.id,{tools:[{name:'fixture_tool',description:'test',inputSchema:{type:'object'}}],...(listPages<(options.pages??1)?{nextCursor:'next'}:{})});
        }else if(request.method==='tools/call'){toolCalls++;note('tool:'+toolCalls);if(!options.noToolReply)this.answer(request.id,options.toolResult??{content:[{type:'text',text:'ok'}]});}
      });return true;},end:()=>{note('stdin-end');}};
    kill(){note('kill');if(options.autoClose!==false)queueMicrotask(()=>this.physicalClose());return true;}
    answer(id:number,result:unknown){this.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
    physicalClose(){if(this.closed)return;this.closed=true;this.emit('close',0,null);note('physical-close');}
  }
  async function stage(name:Stage){note(name);if(options.reject===name)throw Object.freeze({code:'UNKNOWN'});await options.gates?.[name]?.promise;}
  const appAssets={isCurrent:()=>current,async issue(value:unknown){
    await stage('issue');options.issueHook?.();issues.push(value);
    // Actual host persistence is observed through its public store read, not a fake acknowledgement.
    const v=value as {conversationId:string};assert.ok((await chat.history(v.conversationId)).messages.some((m:any)=>m.role==='user'));
    const overlay=Object.freeze(Object.defineProperty(Object.create(null),'ARCANE_ASSET_TOKEN',{value:ASSET,enumerable:false}));
    return Object.freeze({
      launchEnvironment(){return overlay;},
      async bind(value:unknown){bindings.push(value);await stage('bind');},
      async grantNextIntent(){await stage('grantNextIntent');},
      async dispatched(id:string){calls.push({dispatch:id});await stage('dispatched');},
      async ended(id:string){calls.push({ended:id});await stage('ended');},
      async cancelWork(scope:string){calls.push({cancel:scope});note('cancel');},
      async retire(){await stage('retire');},
      async transportClosed(){await stage('transportClosed');}
    });
  }};
  const fetcher=(async(url:URL|RequestInfo,init:RequestInit={})=>{
    const path=new URL(String(url)).pathname;
    if(path==='/v1/models')return Response.json({models:[{id:'fixture',label:'Fixture',tools:true}]});
    if(path==='/v1/balance')return Response.json({credits:100,actionsRemaining:10,plan:'fixture',renewsAt:null});
    if(path==='/v1/chat/stream'){
      note('gateway');const body=JSON.parse(String(init.body));calls.push({gateway:body});
      return options.reply?options.reply(body,init):new Response(encode({type:'delta',text:'ready'},done));
    }throw new Error('unexpected fixture route');
  }) as typeof fetch;
  const filesystem=options.failWrite?{...fs,async writeFile(...args:Parameters<typeof fs.writeFile>){
    if(String(args[1]).includes('"role":"user"'))throw new Error('synthetic durable-write failure');return fs.writeFile(...args);
  }}:fs;
  chat=createArcaneChat({projectPath:project,stateDirectory:state,fs:filesystem,
    getWindow:()=>({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send(_channel:string,event:any){events.push(event);note(event.type==='done'?'done:'+event.turnId:'event:'+event.type);}}}),
    env:{PATH:process.env.PATH,ARCANE_ASSET_TOKEN:'inherited-never',ARCANE_ASSET_AUDIENCE:'inherited-never',OPENAI_API_KEY:'never'},
    gateway:async()=>createArcaneGateway({config:null as never,vault:null,fetch:fetcher,credential:async()=>({base:'https://gateway.fixture.test',token:'fixture-account-credential'})}),
    permissions:{claudeTools:async()=>true},
    handoff:{async prepare(){const value:any={handoffId:randomUUID(),expiresAt:new Date(Date.now()+30*60000).toISOString(),configPath:config};
      Object.defineProperty(value,'env',{value:{ARCANE_DAEMON_URL:'http://127.0.0.1:45871',ARCANE_LOCAL_TOKEN:CORE},enumerable:false});return value;},async release(){note('core-release');return true;}},
    spawn(command:string,args:string[],spawnOptions:any){note('spawn');spawns.push({command,args,options:spawnOptions});
      if(options.spawnThrow)throw new Error('synthetic no-child');const child=new FakeChild();children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;},
    ...(options.absent?{}:{appAssets}),...(options.limits?{limits:options.limits}:{})
  });
  t.after(async()=>{for(const gate of Object.values(options.gates??{}))gate?.resolve();await chat.dispose();for(const child of children)child.physicalClose();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:10});});
  const finished=async(id:string)=>{await wait('done:'+id);return events.find(e=>e.type==='done'&&e.turnId===id);};
  const child=()=>{const selected=children[0];assert.ok(selected,'Expected the owned MCP child.');return selected;};
  return {chat,trace,calls,events,issues,bindings,spawns,children,child,wait,finished,config,configBytes,setCurrent(value:boolean){current=value;},note};
}

test('Arcane assets: absent trusted seam preserves legacy chat and never forwards inherited asset credentials',{timeout:5000},async t=>{
  const f=await fixture(t,{absent:true});const sent=await f.chat.send(input());assert.equal((await f.finished(sent.turnId)).ok,true);
  assert.equal(f.issues.length,0);assert.equal(f.spawns[0].options.env.ARCANE_ASSET_TOKEN,undefined);assert.equal(f.spawns[0].options.env.ARCANE_ASSET_AUDIENCE,undefined);
});

test('Arcane assets: durable human message and every authority ACK precede the first provider request',{timeout:5000},async t=>{
  const grant=deferred<void>(),dispatch=deferred<void>(),f=await fixture(t,{gates:{grantNextIntent:grant,dispatched:dispatch}});
  const sent=await f.chat.send(input());await f.wait('grantNextIntent');assert.ok(!f.trace.includes('gateway'));grant.resolve();
  await f.wait('dispatched');assert.ok(!f.trace.includes('gateway'));dispatch.resolve();assert.equal((await f.finished(sent.turnId)).ok,true);
  assert.deepEqual(f.trace.filter(value=>['issue','spawn','bind','grantNextIntent','dispatched','gateway'].includes(value)),['issue','spawn','bind','grantNextIntent','dispatched','gateway']);
  assert.equal(f.issues[0].conversationId,sent.conversationId);assert.deepEqual(Object.keys(f.issues[0]).sort(),['connectionId','conversationId']);
  assert.equal(f.bindings[0].kind,'arcane-gateway-loop');assert.equal(f.calls.find(c=>c.dispatch).dispatch,sent.turnId);
  await f.wait('transportClosed');assert.equal(f.trace.filter(x=>x==='transportClosed').length,1);
  assert.ok(f.trace.indexOf('done:'+sent.turnId)<f.trace.indexOf('transportClosed'),'delivery completion precedes closure');
});

test('Arcane assets: failed durable write issues no context and starts no provider or child',{timeout:5000},async t=>{
  const f=await fixture(t,{failWrite:true});await assert.rejects(f.chat.send(input()));
  assert.deepEqual(f.issues,[]);assert.deepEqual(f.spawns,[]);assert.ok(!f.trace.includes('issue')&&!f.trace.includes('gateway'));
});

for(const stage of ['issue','bind','grantNextIntent','dispatched'] as const){
  test('Arcane assets: unknown '+stage+' acknowledgement is never retried or downgraded',{timeout:5000},async t=>{
    const f=await fixture(t,{reject:stage});const sent=await f.chat.send(input());assert.equal((await f.finished(sent.turnId)).ok,false);
    assert.equal(f.trace.filter(x=>x===stage).length,1);assert.ok(!f.trace.includes('gateway'));
    if(stage!=='issue')await f.wait('transportClosed');
  });
}

for(const stage of ['issue','bind','grantNextIntent','dispatched'] as const){
  test('Arcane assets: project fence during held '+stage+' ACK prevents provider dispatch',{timeout:5000},async t=>{
    const held=deferred<void>(),f=await fixture(t,{gates:{[stage]:held}});const sent=await f.chat.send(input());await f.wait(stage);
    f.setCurrent(false);held.resolve();assert.equal((await f.finished(sent.turnId)).ok,false);assert.ok(!f.trace.includes('gateway'));
    await f.wait('transportClosed');
  });
}

test('Arcane assets: explicit final spawn env alone receives the 64hex credential and audience',{timeout:5000},async t=>{
  const f=await fixture(t);const sent=await f.chat.send(input());await f.finished(sent.turnId);
  const spawn=f.spawns[0];assert.equal(spawn.options.env.ARCANE_ASSET_TOKEN,ASSET);assert.equal(spawn.options.env.ARCANE_ASSET_AUDIENCE,'native-session');
  assert.equal(spawn.options.env.ARCANE_LOCAL_TOKEN,CORE);assert.equal(spawn.options.env.OPENAI_API_KEY,undefined);
  assert.ok(!JSON.stringify(spawn.args).includes(ASSET));assert.equal(await fs.readFile(f.config,'utf8'),f.configBytes);
  assert.ok(!JSON.stringify(f.events).includes(ASSET)&&!JSON.stringify(f.calls.filter(c=>c.gateway)).includes(ASSET));
});

test('Arcane assets: normal completion retires without cancellation and waits for actual MCP close',{timeout:5000},async t=>{
  const f=await fixture(t,{autoClose:false});const sent=await f.chat.send(input());assert.equal((await f.finished(sent.turnId)).ok,true);
  await f.wait('retire');assert.ok(!f.calls.some(c=>c.cancel));assert.ok(!f.trace.includes('transportClosed'));
  assert.deepEqual(f.calls.filter(c=>c.ended),[{ended:sent.turnId}]);f.child().physicalClose();await f.wait('transportClosed');
});

test('Arcane assets: explicit Stop uses incarnation and immediate local stop while an underlying fetch is held',{timeout:5000},async t=>{
  const response=deferred<Response>(),started=deferred<void>(),f=await fixture(t,{reply:async()=>{started.resolve();return response.promise;}});
  const sent=await f.chat.send(input());await started.promise;assert.equal(await f.chat.stop(sent.turnId),true);assert.equal((await f.finished(sent.turnId)).error,'Stopped.');
  await f.wait('physical-close');assert.deepEqual(f.calls.filter(c=>c.cancel),[{cancel:'incarnation'}]);assert.ok(!f.trace.includes('transportClosed'));
  response.resolve(new Response(encode({type:'delta',text:'late ignored'},done)));await f.wait('transportClosed');
  assert.ok(!f.events.some(e=>e.type==='delta'&&e.text.includes('late')));assert.equal(f.trace.filter(x=>x==='gateway').length,1);
  assert.equal(await f.chat.stop(sent.turnId),false);
});

test('Arcane assets: runtime dispose fences and retires without cancelling accepted daemon work',{timeout:5000},async t=>{
  const response=deferred<Response>(),started=deferred<void>(),f=await fixture(t,{reply:async()=>{started.resolve();return response.promise;}});
  const sent=await f.chat.send(input());await started.promise;await f.chat.dispose();await f.finished(sent.turnId);
  assert.ok(!f.calls.some(c=>c.cancel));assert.ok(!f.trace.includes('transportClosed'));
  response.resolve(new Response(encode(done)));await f.wait('transportClosed');
});

test('Arcane assets: MCP error and logical kill are not physical child closure',{timeout:5000},async t=>{
  const f=await fixture(t,{autoClose:false});const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('retire');
  f.child().emit('error',new Error('synthetic error'));assert.ok(!f.trace.includes('transportClosed'));
  f.child().physicalClose();await f.wait('transportClosed');
});

test('Arcane assets: synchronous no-child spawn failure can retire and close its exact context',{timeout:5000},async t=>{
  const f=await fixture(t,{spawnThrow:true});const sent=await f.chat.send(input());assert.equal((await f.finished(sent.turnId)).ok,false);
  await f.wait('transportClosed');assert.equal(f.children.length,0);assert.ok(!f.trace.includes('gateway'));
});

test('Arcane assets: timed out tool replies only drain custody and never resume the expired call',{timeout:5000},async t=>{
  let round=0;const f=await fixture(t,{autoClose:false,noToolReply:true,limits:{toolTimeoutMs:1},
    reply:()=>new Response(encode(...(round++===0?[{type:'tool_call',id:'call',name:'fixture_tool',arguments:{}},done]:[done])))});
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('retire');
  const request=f.child().sent.find((r:any)=>r.method==='tools/call');assert.ok(request);assert.ok(!f.trace.includes('transportClosed'));
  const before=JSON.stringify(f.events);f.child().answer(request.id,{content:[{type:'text',text:'late result'}]});
  assert.equal(JSON.stringify(f.events),before);f.child().physicalClose();await f.wait('transportClosed');
  assert.equal(f.trace.filter(x=>x==='gateway').length,2);
});

test('Arcane assets: exact original request budget is at most initialize plus4lists plus24calls',{timeout:5000},async t=>{
  let round=0;const f=await fixture(t,{pages:4,noToolReply:true,limits:{toolTimeoutMs:1},
    reply:()=>new Response(encode(...(round++===0?[...Array.from({length:25},(_,i)=>({type:'tool_call',id:'c'+i,name:'fixture_tool',arguments:{}})),done]:[done])))});
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('transportClosed');
  assert.equal(f.child().sent.filter((r:any)=>typeof r.id==='number').length,29);
  assert.equal(f.child().sent.filter((r:any)=>r.method==='tools/call').length,24);
});

test('Arcane assets: unresolved gateway cleanup stays pinned at the existing turn capacity',{timeout:5000},async t=>{
  const failure=Object.freeze({fixture:'cancel'}),f=await fixture(t,{limits:{turns:1},reply:()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(new TextEncoder().encode(encode(done)));},cancel(){return Promise.reject(failure);}
  }))});
  const sent=await f.chat.send(input());assert.equal((await f.finished(sent.turnId)).ok,false);await f.wait('retire');await f.wait('physical-close');
  assert.ok(!f.trace.includes('transportClosed'));await assert.rejects(f.chat.send(input('second')));
  assert.equal(f.trace.filter(x=>x==='issue').length,1);assert.equal(f.trace.filter(x=>x==='gateway').length,1);
});

test('Arcane assets: two turns keep the durable app anchor but get distinct owned loop witnesses',{timeout:5000},async t=>{
  const f=await fixture(t);const first=await f.chat.send(input());await f.finished(first.turnId);await f.wait('transportClosed');
  const second=await f.chat.send(input('continue',first.conversationId));await f.finished(second.turnId);
  assert.equal(f.issues.length,2);assert.equal(f.issues[0].conversationId,f.issues[1].conversationId);
  assert.equal(f.issues[0].connectionId,f.issues[1].connectionId);assert.notEqual(f.bindings[0].incarnationId,f.bindings[1].incarnationId);
  assert.equal(f.spawns.length,2);assert.ok(!('nativeSessionId' in f.bindings[0]));
});

test('Arcane assets: split bearer deltas never reach transcript, events or gateway',{timeout:5000},async t=>{
  const f=await fixture(t,{reply:()=>new Response(encode({type:'delta',text:'prefix '+ASSET.slice(0,31)},
    {type:'delta',text:ASSET.slice(31)+' '+CORE.slice(0,20)},{type:'delta',text:CORE.slice(20)+' safe'},done))});
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('transportClosed');
  const visible=f.events.filter(e=>e.type==='delta').map(e=>e.text).join('');assert.match(visible,/\[redacted\]/);assert.ok(visible.includes('safe'));
  for(const value of [f.events,await f.chat.history(sent.conversationId),f.calls.filter(c=>c.gateway)]){const json=JSON.stringify(value);assert.ok(!json.includes(ASSET)&&!json.includes(CORE));}
});

test('Arcane assets: stopped held issue never launches a child after late acknowledgement',{timeout:5000},async t=>{
  const held=deferred<void>(),f=await fixture(t,{gates:{issue:held}});const sent=await f.chat.send(input());await f.wait('issue');
  assert.equal(await f.chat.stop(sent.turnId),true);await f.finished(sent.turnId);held.resolve();await f.wait('transportClosed');
  assert.deepEqual(f.spawns,[]);assert.ok(!f.trace.includes('gateway'));
});



test('Arcane assets: tool arguments, results, instructions and image metadata redact both credentials',{timeout:5000},async t=>{
  let round=0;const bytes=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from(ASSET+CORE)]);
  const f=await fixture(t,{initializeInstructions:ASSET+' '+CORE,
    toolResult:{content:[{type:'text',text:ASSET+' '+CORE},{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]},
    reply:()=>new Response(encode(...(round++===0?[{type:'tool_call',id:'call',name:'fixture_tool',arguments:{hint:ASSET+' '+CORE}},done]:[done]))) });
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('transportClosed');
  const call=f.child().sent.find((r:any)=>r.method==='tools/call');assert.deepEqual(call.params.arguments,{hint:'[redacted] [redacted]'});
  for(const value of [f.events,await f.chat.history(sent.conversationId),f.calls.filter(c=>c.gateway)]){const json=JSON.stringify(value);assert.ok(!json.includes(ASSET)&&!json.includes(CORE));}
  assert.ok(f.events.filter(e=>e.type==='tool').every(e=>!e.message.tool.image),'encoded image metadata cannot carry a bearer');
});

test('Arcane assets: malformed present port and renderer asset authority fields are refused',{timeout:5000},async t=>{
  assert.throws(()=>createArcaneChat({projectPath:'fixture',stateDirectory:'fixture',getWindow:()=>null,gateway:async()=>null,
    handoff:{prepare:async()=>null,release:async()=>false},appAssets:null}));
  const f=await fixture(t);await assert.rejects(f.chat.send({...input(),assetToken:ASSET}));
  assert.deepEqual(f.issues,[]);assert.deepEqual(f.spawns,[]);
});

test('Arcane assets: retirement fences synchronously while an ended ACK remains held',{timeout:5000},async t=>{
  const ended=deferred<void>(),f=await fixture(t,{gates:{ended}});
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('ended');await f.wait('retire');await f.wait('physical-close');
  assert.ok(!f.trace.includes('transportClosed'));ended.resolve();await f.wait('transportClosed');
  assert.ok(f.trace.indexOf('ended')<f.trace.indexOf('retire'));
});

test('Arcane assets: unknown transport-closed ACK remains pinned and is never retried',{timeout:5000},async t=>{
  const f=await fixture(t,{reject:'transportClosed',limits:{turns:1}});
  const sent=await f.chat.send(input());await f.finished(sent.turnId);await f.wait('transportClosed');
  await assert.rejects(f.chat.send(input('again')));assert.equal(f.trace.filter(x=>x==='transportClosed').length,1);
  assert.deepEqual(Object.keys(f.chat),['version','status','list','history','send','rewind','stop','remove']);
  assert.equal(JSON.stringify(f.chat),'{"version":1}');
});

test('Arcane assets: Stop while tools/call is pending never revives its late reply',{timeout:5000},async t=>{
  const f=await fixture(t,{autoClose:false,noToolReply:true,reply:()=>new Response(encode({type:'tool_call',id:'call',name:'fixture_tool',arguments:{}},done))});
  const sent=await f.chat.send(input());await f.wait('tool:1');assert.equal(await f.chat.stop(sent.turnId),true);await f.finished(sent.turnId);
  assert.deepEqual(f.calls.filter(c=>c.cancel),[{cancel:'incarnation'}]);assert.ok(!f.trace.includes('transportClosed'));
  const before=JSON.stringify(f.events),request=f.child().sent.find((r:any)=>r.method==='tools/call');
  f.child().answer(request.id,{content:[{type:'text',text:'late private result'}]});
  assert.equal(JSON.stringify(f.events),before);f.child().physicalClose();await f.wait('transportClosed');
  assert.equal(f.trace.filter(x=>x==='gateway').length,1);
});
