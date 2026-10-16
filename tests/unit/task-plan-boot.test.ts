/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexChatApi, CodexHttpError, type ChatStateView } from '../../apps/desktop/src/codex-chat.js';
import { startTaskPlanCard } from '../../apps/desktop/src/task-plan-boot.js';
import {StudioApi} from '../../apps/desktop/src/studio.js';

const scope=()=>({connectionId:randomUUID(),threadId:'thread:plan',taskId:randomUUID()}),TOKEN='a'.repeat(64);
test('exact recorded-run navigation permits one UUID GET and refuses mutation or query expansion',async()=>{
  const runId=randomUUID(),calls:string[]=[];
  const api=new StudioApi(TOKEN,(async(url,options)=>{calls.push(String(url));assert.equal(options?.method,'GET');return Response.json({run:{id:runId}});}) as typeof fetch);
  assert.equal((await api.run(runId)).run.id,runId);assert.deepEqual(calls,['/v1/work/runs/'+runId]);
  await assert.rejects(api.request('/v1/work/runs/'+runId,{}));
  await assert.rejects(api.request('/v1/work/runs/'+runId+'?runId=other'));
  assert.throws(()=>api.run('../other'));assert.equal(calls.length,1);
});
test('task status uses a bounded raw GET, preserves JSON text and never retries an unreadable response',async()=>{
  const selected=scope(),raw=' {"taskId":"'+selected.taskId+'","plan":null} ',calls:{url:string;options:RequestInit}[]=[];
  const api=new CodexChatApi(TOKEN,(async(url,options)=>{calls.push({url:String(url),options:options!});return new Response(raw,{headers:{'Content-Type':'application/json; charset=utf-8'}});}) as typeof fetch);
  assert.equal(await api.taskPlan(selected),raw);
  assert.equal(calls.length,1);assert.equal(calls[0]!.options.method,'GET');assert.equal(calls[0]!.options.body,undefined);
  const url=new URL(calls[0]!.url,'http://fixture');assert.equal(url.pathname,'/v1/codex/task-plan');assert.deepEqual(Object.fromEntries(url.searchParams),selected);
  assert.equal((calls[0]!.options.headers as Record<string,string>).Authorization,'Bearer '+TOKEN);
  assert.equal(calls[0]!.options.redirect,'error');assert.equal(calls[0]!.options.cache,'no-store');
  let badReads=0;
  for(const response of [new Response(' '.repeat(65537),{headers:{'Content-Type':'application/json'}}),new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}}),new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}),new Response('{}',{headers:{'Content-Type':'text/html'}})]){
    const bad=new CodexChatApi(TOKEN,(async()=>{badReads++;return response;}) as typeof fetch);
    await assert.rejects(bad.taskPlan(selected),error=>error instanceof CodexHttpError&&error.unknown===false);
  }
  assert.equal(badReads,4,'each refused read has exactly one request');
});

test('raw task reads observe caller cancellation, including a response held across navigation',async()=>{
  const selected=scope(),controller=new AbortController();let requests=0,seen:AbortSignal|null=null,release!:(response:Response)=>void;
  const api=new CodexChatApi(TOKEN,((_,options)=>{requests++;seen=options!.signal!;return new Promise<Response>(done=>{release=done;});}) as typeof fetch);
  controller.abort();await assert.rejects(api.taskPlan(selected,controller.signal));assert.equal(requests,0);
  const next=new AbortController(),pending=api.taskPlan(selected,next.signal);next.abort();
  assert.equal((seen as unknown as AbortSignal).aborted,true);release(new Response('{}',{headers:{'Content-Type':'application/json'}}));await assert.rejects(pending);
  assert.equal(requests,1);
});

class Element extends EventTarget{
  hidden=false;className='';id='';type='';title='';disabled=false;dataset:Record<string,string>={};children:Element[]=[];value='';#text='';
  constructor(readonly tagName:string){super();}
  get textContent():string{return this.#text+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.#text=value;this.children=[];}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.#text='';this.children=children;}
  setAttribute(_name:string,_value:string){}
  all(tag:string):Element[]{return[...(this.tagName===tag?[this]:[]),...this.children.flatMap(child=>child.all(tag))];}
}
function fixture(){
  const selected=scope(),host=new Element('section'),listeners=new Set<()=>void>();
  let view={fresh:true,switching:false,nativeBoundToActiveChat:true,preferredProvider:'codex',activeChat:{key:'chat-one'},state:{projectPath:'fixture/project',
    snapshot:{connected:true,ready:true,connectionId:selected.connectionId,mcpIsolation:'arcane-only-verified',account:{auth:'subscription'},
      thread:{configured:true,threadId:selected.threadId,sessionId:'session:one',selection:{model:'fixture',effort:'low'}}},
    chatTasks:[{...selected,sessionId:'session:one'}]}} as unknown as ChatStateView;
  const doc={getElementById:(id:string)=>id==='codex-task-plan'?host:null,createElement:(tag:string)=>new Element(tag)} as unknown as Document;
  const chat={currentStateView:()=>view,subscribeStateChange:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
  return{selected,host,doc,chat,listeners,view:()=>view,change:(next:ChatStateView)=>{view=next;for(const listener of listeners)listener();}};
}
test('the real boot composition cancels and clears context, ignores held data and releases subscriptions on stop',async()=>{
  const f=fixture(),reads:{signal:AbortSignal;done:(text:string)=>void}[]=[];
  const lifecycle=startTaskPlanCard(f.doc,{chat:f.chat,api:{safe:text=>text,taskPlan:async(_scope,signal)=>new Promise<string>(done=>reads.push({signal:signal!,done}))},openReview:async()=>{assert.fail('no trusted activation');}});
  assert.equal(reads.length,1);assert.equal(f.listeners.size,1);assert.equal(f.host.hidden,false);
  f.change({...f.view(),switching:true});assert.equal(reads[0]!.signal.aborted,true);assert.equal(f.host.hidden,true);
  reads[0]!.done(JSON.stringify({taskId:f.selected.taskId,plan:null}));await delay(0);assert.equal(f.host.hidden,true);
  f.change({...f.view(),switching:false});assert.equal(reads.length,2);
  lifecycle.stop();assert.equal(reads[1]!.signal.aborted,true);assert.equal(f.listeners.size,0);assert.equal(f.host.hidden,true);
  lifecycle.resume();assert.equal(f.listeners.size,1);assert.equal(reads.length,3);lifecycle.resume();assert.equal(f.listeners.size,1);
  f.change({...f.view(),preferredProvider:'claude'});assert.equal(f.host.hidden,true);assert.equal(reads[2]!.signal.aborted,true);
  lifecycle.stop();
});

test('unchanged status polling preserves the focused review control and a disconnected chat clears it',async()=>{
  const f=fixture(),runId=randomUUID(),planId=randomUUID();let calls=0;
  const raw=JSON.stringify({taskId:f.selected.taskId,plan:{planId,state:'active',reason:null,steps:[{seq:1,kind:'evidence',round:2,index:0,state:'acknowledged',terminal:null,reason:null}],review:{runId,state:'pending_submission',reason:null,tasks:[]}}});
  const lifecycle=startTaskPlanCard(f.doc,{chat:f.chat,api:{safe:text=>text,taskPlan:async()=>{calls++;return raw;}},openReview:async()=>{}});
  await delay(0);const button=f.host.all('button')[0];assert.ok(button);
  for(let index=0;index<50;index++)f.change(f.view());await delay(0);assert.equal(calls,1,'typing notifications do not amplify evidence reads');
  await delay(1050);assert.equal(calls,2);assert.equal(f.host.all('button')[0],button,'unchanged polling retains the same focusable node');
  f.change({...f.view(),nativeBoundToActiveChat:false});assert.equal(f.host.hidden,true);lifecycle.stop();
});
