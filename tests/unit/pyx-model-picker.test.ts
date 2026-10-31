import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {readPyxModels,type PyxModelsView,type PyxModelResult} from '../../apps/desktop/src/pyx-bar.js';
import {startPyxLink,capturePyxModels,type PyxHostBridge,type PyxModelCapture} from '../../apps/desktop/src/pyx-link.js';
import type {ComposerPickerCapture} from '../../apps/desktop/src/codex-chat.js';

const model={provider:'codex' as const,id:'fixture-model',label:'Fixture model',efforts:['low','high']};
const view=():PyxModelsView=>({revision:randomUUID(),selectable:true,message:null,selected:{provider:'codex',model:model.id,effort:'low'},models:[model]});
test('Pyx catalogue is exact bounded display data, with no authority, foreign selected pair or truncated IDs',()=>{
  const value=view();assert.deepEqual(readPyxModels(value),value);
  for(const bad of [{...value,token:'forged'},{...value,revision:'-'.repeat(36)},{...value,selectable:1},{...value,models:[{...model,path:'C:\\other'}]},
    {...value,models:[model,model]},{...value,models:[{...model,efforts:[]}]},{...value,models:[{...model,id:'x'.repeat(257)}]},
    {...value,selected:{...value.selected!,effort:'ultra'}},{...value,selected:{...value.selected!,provider:'claude'}},
    {...value,models:Array.from({length:769},(_,i)=>({...model,id:'fixture-'+i}))}])assert.equal(readPyxModels(bad),null);
  let accessed=false;const getter={...value};Object.defineProperty(getter,'models',{enumerable:true,get(){accessed=true;return[];}});assert.equal(readPyxModels(getter),null);assert.equal(accessed,false);
});
function fixture(t:test.TestContext){
  let listener:(v:unknown)=>void=()=>{},invalidate=()=>{},current=true,selection:'applied'|'unknown'='applied';const calls:unknown[]=[],answers:{id:string;result:unknown}[]=[];
  const capture:PyxModelCapture={models:[model],selected:{provider:'codex',model:model.id,effort:'low'},selectable:true,current:()=>current,
    select:async choice=>{calls.push(choice);return selection;}};
  const bridge:PyxHostBridge={version:1,open(){},publish(){},onRequest(fn){listener=fn;return()=>{listener=()=>{};};},answer(){assert.fail('Picker cannot answer a Send');},answerModels(id,result){answers.push({id,result});}};
  const doc={getElementById:()=>null,defaultView:null} as unknown as Document;
  const link=startPyxLink(doc,{bridge,surface:()=>'codex',models:()=>capture,subscribeModelScope(fn){invalidate=fn;return()=>{};}});t.after(()=>link.stop());
  return {calls,answers,request:(value:unknown)=>listener(value),invalidate:()=>invalidate(),setCurrent:(value:boolean)=>{current=value;},unknown:()=>{selection='unknown';}};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('Pyx revision selects only its actual private current capture and a consumed handle cannot replay',async t=>{
  const f=fixture(t);f.request({type:'models-read',id:'read-1'});const catalog=f.answers.at(-1)!.result as PyxModelsView;
  assert.equal(f.calls.length,0);f.request({type:'models-select',id:'select-1',revision:catalog.revision,provider:'codex',model:model.id,effort:'high'});await tick();
  assert.deepEqual(f.calls,[{provider:'codex',model:model.id,effort:'high'}]);assert.equal((f.answers.at(-1)!.result as PyxModelResult).state,'applied');
  f.request({type:'models-select',id:'select-2',revision:catalog.revision,provider:'codex',model:model.id,effort:'high'});await tick();assert.equal(f.calls.length,1);assert.equal((f.answers.at(-1)!.result as PyxModelResult).state,'rejected');
});
for(const kind of ['new-read','private-scope','private-current','foreign-row','foreign-revision'] as const)test('Pyx refuses stale catalogue selection: '+kind,async t=>{
  const f=fixture(t);f.request({type:'models-read',id:'read-1'});const catalog=f.answers.at(-1)!.result as PyxModelsView;
  if(kind==='new-read')f.request({type:'models-read',id:'read-2'});else if(kind==='private-scope')f.invalidate();else if(kind==='private-current')f.setCurrent(false);
  f.request({type:'models-select',id:'select-1',revision:kind==='foreign-revision'?randomUUID():catalog.revision,provider:kind==='foreign-row'?'claude':'codex',model:model.id,effort:'high'});await tick();
  assert.equal(f.calls.length,0);assert.equal((f.answers.at(-1)!.result as PyxModelResult).state,'rejected');
});
test('Pyx retains an actual unknown model selection and never retries it',async t=>{
  const f=fixture(t);f.unknown();f.request({type:'models-read',id:'read-1'});const catalog=f.answers.at(-1)!.result as PyxModelsView;
  f.request({type:'models-select',id:'select-1',revision:catalog.revision,provider:'codex',model:model.id,effort:'high'});await tick();
  assert.equal((f.answers.at(-1)!.result as PyxModelResult).state,'unknown');assert.equal(f.calls.length,1);
  f.request({type:'models-select',id:'select-2',revision:catalog.revision,provider:'codex',model:model.id,effort:'high'});await tick();assert.equal(f.calls.length,1);
});

test('Pyx close fences a held private selection before provider handoff without replaying it',async t=>{
  let request:(value:unknown)=>void=()=>{},release!:()=>void,dispatched=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),answers:{id:string;result:unknown}[]=[];
  const capture:PyxModelCapture={models:[model],selected:null,selectable:true,current:()=>true,async select(_choice,owns){await gate;if(!owns())return'rejected';dispatched++;return'applied';}};
  const link=startPyxLink({getElementById:()=>null,defaultView:null}as unknown as Document,{surface:()=>'codex',models:()=>capture,bridge:{version:1,open(){},publish(){},answer(){assert.fail('No Send');},onRequest(fn){request=fn;return()=>{};},answerModels(id,result){answers.push({id,result});}}});t.after(()=>link.stop());
  request({type:'models-read',id:'read-1'});const catalog=answers.at(-1)!.result as PyxModelsView;
  request({type:'models-select',id:'select-1',revision:catalog.revision,provider:'codex',model:model.id,effort:'high'});request({type:'models-close'});release();await tick();
  assert.equal(dispatched,0);assert.equal((answers.at(-1)!.result as PyxModelResult).state,'rejected');
});

test('actual Pyx preload exposes only bounded model intents and an unreadable result remains unknown without retry',async()=>{
  const invoked:unknown[][]=[],sent:unknown[][]=[];let published:Record<string,unknown>|null=null,refuse=false;
  const context=createContext({require:(name:string)=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld(_name:string,value:Record<string,unknown>){published=value;}},ipcRenderer:{on(){},removeListener(){},send(...args:unknown[]){sent.push(args);},async invoke(...args:unknown[]){invoked.push(args);if(refuse)throw Error('lost reply');return args[0]==='arcane:pyx-models'?view():{state:'applied'};}}};}});
  runInContext(readFileSync('apps/desktop/electron/pyx-preload.cjs','utf8'),context);assert.ok(published);
  const call=async(expression:string)=>JSON.parse(JSON.stringify(await runInContext(expression,context)));
  runInContext('globalThis.bridge=undefined',context);context.bridge=(published as Record<string,unknown>).pyx;
  assert.equal(runInContext('typeof bridge.openModelPicker',context),'undefined');
  const choice={revision:randomUUID(),provider:'codex',model:model.id,effort:'high'};context.encoded=JSON.stringify(choice);
  assert.deepEqual(await call('bridge.selectModel(JSON.parse(encoded))'),{state:'applied'});assert.equal(invoked.length,1);assert.equal(invoked[0]![0],'arcane:pyx-select-model');
  for(const bad of [{...choice,credential:'forged'},{...choice,revision:'-'.repeat(36)},{...choice,provider:'other'},{...choice,model:'model\n'}]){context.encoded=JSON.stringify(bad);assert.equal((await call('bridge.selectModel(JSON.parse(encoded))')).state,'rejected');}
  assert.equal(invoked.length,1);runInContext('bridge.pickerOpen({height:9000});bridge.pickerOpen(true)',context);assert.deepEqual(sent,[['arcane:pyx-picker-open',true]]);
  context.encoded=JSON.stringify(choice);refuse=true;assert.equal((await call('bridge.selectModel(JSON.parse(encoded))')).state,'unknown');assert.equal(invoked.length,2);
  assert.deepEqual(Object.keys(published).sort(),['platform','pyx','runtime','version']);
});

for(const fault of ['none','project-aba','catalogue-aba','closed','foreign-target'] as const)test('actual Pyx boot capture preserves prepared-target identity across handoff: '+fault,async()=>{
  let provider:'codex'|'claude'='codex',projectEpoch=0,catalogueEpoch=0,targetLocal='prior-draft',owned=true,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),selected:string[]=[];
  const peer=(who:'codex'|'claude')=>({captureModelPicker():ComposerPickerCapture{
    const local=targetLocal,atProvider=provider,atCatalogue=catalogueEpoch;
    const current=()=>provider===atProvider&&(who==='codex'||local===targetLocal)&&atCatalogue===catalogueEpoch;
    return{provider:who,models:[{id:who+'-fixture',label:who+' fixture',efforts:['low','high']}],selected:{model:who+'-fixture',effort:'low'},selectable:provider===who,current,catalogueCurrent:()=>atCatalogue===catalogueEpoch,
      async select(model,effort){if(provider!==who||!current()||model!==who+'-fixture'||effort!=='high')return'rejected';selected.push(who+':'+local);return'applied';}};
  }});
  const capture=capturePyxModels({project:()=>'same-project',epoch:()=>projectEpoch,provider:()=>provider,peers:{codex:peer('codex'),claude:peer('claude'),arcane:null},
    async handoff(_provider,_model,_effort,owns){targetLocal='prepared-draft';await gate;if(!owns())return false;provider='claude';return true;}})!;
  const pending=capture.select({provider:'claude',model:'claude-fixture',effort:'high'},()=>owned);await tick();
  if(fault==='project-aba')projectEpoch+=2;if(fault==='catalogue-aba')catalogueEpoch+=2;if(fault==='closed')owned=false;if(fault==='foreign-target')provider='claude';release();
  assert.equal(await pending,fault==='none'?'applied':'rejected');assert.deepEqual(selected,fault==='none'?['claude:prepared-draft']:[]);
});
