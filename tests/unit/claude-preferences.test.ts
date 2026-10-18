import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudePreferenceStore,readClaudePreferenceSnapshot,type ClaudePreferenceSnapshot,type ClaudePreferenceBridge} from '../../apps/desktop/src/claude-preferences.js';
const project='C:\\Project';
const snapshot=(draft='  keep this text\n\n🧩  '):ClaudePreferenceSnapshot=>({version:1,projectPath:project,provider:'claude',activeTabId:'claude-tab-1',tabs:[{
 localId:'claude-tab-1',title:'Draft',provider:'claude',threadId:null,sessionId:null,draft,modelId:'opus',effort:'low',tool:'all',previewOpen:false,
}]});
const readable=(preferences:ClaudePreferenceSnapshot|null=null)=>({available:true,projectPath:project,preferences});

test('Claude native preference parsing preserves raw drafts and rejects foreign or augmented state',()=>{
 const value=snapshot();assert.deepEqual(readClaudePreferenceSnapshot(value,project),value);
 for(const bad of [{...value,projectPath:'C:\\Other'},{...value,credentials:'forbidden'},{...value,tabs:[{...value.tabs[0],provider:'codex'}]},
   {...value,tabs:[{...value.tabs[0],sessionId:'foreign'}]},{...value,activeTabId:'missing'},{...value,tabs:[value.tabs[0],value.tabs[0]]}])assert.throws(()=>readClaudePreferenceSnapshot(bad,project));
});

test('native Claude save acknowledgement is exact and input is copied before await',async t=>{
 const saved:ClaudePreferenceSnapshot[]=[],store=new ClaudePreferenceStore({read:async()=>readable(),save:async value=>{saved.push(value);return{saved:true};}});t.after(()=>store.dispose());
 await store.read();const input=snapshot(),pending=store.flush(input);input.tabs[0]!.draft='later caller edit';await pending;
 assert.equal(saved[0]!.tabs[0]!.draft,snapshot().tabs[0]!.draft);assert.equal(store.error(),false);
});

test('a failed Claude save is retried without dropping the draft or exposing error text',async t=>{
 let refuse=true;const saved:ClaudePreferenceSnapshot[]=[],store=new ClaudePreferenceStore({read:async()=>readable(),save:async value=>{if(refuse)throw Error('private provider detail');saved.push(value);return{saved:true};}});t.after(()=>store.dispose());
 await store.read();const value=snapshot();await assert.rejects(store.flush(value),error=>error instanceof Error&&/Keep this window open/.test(error.message)&&!error.message.includes('private provider detail'));
 assert.equal(store.error(),true);refuse=false;await store.flush(value);assert.deepEqual(saved,[value]);assert.equal(store.error(),false);
});

test('serial Claude writes never let an older acknowledgement mark a newer draft saved',async t=>{
 let finish:(value:unknown)=>void=()=>assert.fail('First write was not started');const saved:ClaudePreferenceSnapshot[]=[];
 const bridge:ClaudePreferenceBridge={read:async()=>readable(),save:value=>{saved.push(value);return saved.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({saved:true});}};
 const store=new ClaudePreferenceStore(bridge);t.after(()=>store.dispose());await store.read();
 const old=store.flush(snapshot('first')).then(()=>false,()=>true),latest=store.flush(snapshot('latest'));
 finish({saved:true});assert.equal(await old,true);await latest;assert.deepEqual(saved.map(value=>value.tabs[0]!.draft),['first','latest']);
});

test('malformed native save replies never acknowledge a Claude draft',async t=>{
 for(const reply of [{saved:false},{saved:true,extra:true},null]){
  const store=new ClaudePreferenceStore({read:async()=>readable(),save:async()=>reply});t.after(()=>store.dispose());await store.read();await assert.rejects(store.flush(snapshot()));
 }
});

test('returning to a previously saved draft while another write is pending restores the latest desired value',async t=>{
 let finish:(value:unknown)=>void=()=>assert.fail('Write was not started');const values:string[]=[];
 const store=new ClaudePreferenceStore({read:async()=>readable(snapshot('original')),save:value=>{values.push(value.tabs[0]!.draft);return values.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({saved:true});}});t.after(()=>store.dispose());await store.read();
 const first=store.flush(snapshot('changed')).then(()=>false,()=>true),restored=store.flush(snapshot('original'));finish({saved:true});
 assert.equal(await first,true);await restored;assert.deepEqual(values,['changed','original']);
});

test('disposing a Claude preference read prevents late hydration and further writes',async()=>{
 let finish:(value:unknown)=>void=()=>assert.fail('Read was not started');let writes=0;
 const store=new ClaudePreferenceStore({read:()=>new Promise(resolve=>{finish=resolve;}),save:async()=>{writes++;return{saved:true};}});
 const pending=store.read();store.dispose();finish(readable(snapshot()));assert.equal(await pending,null);assert.equal(store.available(),false);
 store.queue(snapshot());assert.equal(writes,0);await assert.rejects(store.flush(snapshot()));
});

test('unavailable Claude storage remains unavailable without a plaintext fallback',async()=>{
 const store=new ClaudePreferenceStore({read:async()=>({available:false,projectPath:null,preferences:null}),save:async()=>assert.fail('Disabled storage must not write')});
 assert.equal(await store.read(),null);assert.equal(store.available(),false);await assert.rejects(store.flush(snapshot()));store.dispose();
});
