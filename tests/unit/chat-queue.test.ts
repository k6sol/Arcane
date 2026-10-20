import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAT_QUEUE_LIMITS,readChatQueueSnapshot,readChatQueueRead,type ChatQueueBridge,type ChatQueueSnapshot,type StoredChatQueueRow} from '../../packages/protocol/src/chat-queue.js';
import {ChatQueueJournal,storedChatQueueRows,type ChatQueueRow,mergeSubmittedMessages} from '../../apps/desktop/src/codex-chat.js';
const project='C:\\Project',provider='codex' as const;
const stored=(id=1,extra:Partial<StoredChatQueueRow>={}):StoredChatQueueRow=>({id,localId:'local-'+id,conversationId:'thread-'+id,sessionId:null,text:'Queued prompt '+id,modelId:'gpt-6.1-sol',effort:'low',connectionId:null,requestId:null,createdAt:'2026-10-20T12:00:00.000Z',state:'pending',attachmentState:'none',...extra});
const snapshot=(rows=[stored()]):ChatQueueSnapshot=>({version:1,projectPath:project,provider,rows});
const row=(target=stored()):ChatQueueRow=>({id:target.id,text:target.text,scope:'own-scope',state:'paused',notice:null,target});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('queue schema validates exact original context and rejects authority, accessors, sparse rows and invalid states',()=>{
  assert.deepEqual(readChatQueueSnapshot(snapshot(),provider,project),snapshot());
  for(const value of [{...snapshot(),grants:['writes']},{...snapshot(),provider:'arcane'},{...snapshot(),rows:[{...stored(),state:'sending'}]},{...snapshot(),rows:[{...stored(),connectionId:'wrong'}]},{...snapshot(),rows:[stored(),stored()]},{...snapshot(),rows:Array(1)}])assert.throws(()=>readChatQueueSnapshot(value));
  let accessed=false;const value={...snapshot()};Object.defineProperty(value,'rows',{get(){accessed=true;return[];},enumerable:true});assert.throws(()=>readChatQueueSnapshot(value));assert.equal(accessed,false);
  assert.throws(()=>readChatQueueSnapshot(snapshot(),'claude'));assert.throws(()=>readChatQueueSnapshot(snapshot(),provider,'C:\\Other'));
  const polluted=Object.assign([],{grants:true});assert.throws(()=>readChatQueueRead({available:false,projectPath:null,rows:polluted},provider));
});
test('queue budgets count UTF-8, per-conversation rows and complete serialized provider data without truncation',()=>{
  assert.throws(()=>readChatQueueSnapshot(snapshot([stored(1,{text:'🧩'.repeat(32769)})])));
  assert.throws(()=>readChatQueueSnapshot(snapshot(Array.from({length:6},(_,i)=>stored(i+1,{conversationId:'same'})))));
  assert.throws(()=>readChatQueueSnapshot(snapshot(Array.from({length:9},(_,i)=>stored(i+1,{text:'a'.repeat(125*1024)})))));
  const five=snapshot(Array.from({length:5},(_,i)=>stored(i+1,{text:'a'.repeat(125*1024),conversationId:'same'})));assert.equal(readChatQueueSnapshot(five).rows.length,5);
});
test('queue journal recovery supplies original rows once and never sends or saves during hydration',async()=>{
  const writes:ChatQueueSnapshot[]=[],restored:StoredChatQueueRow[][]=[];const journal=new ChatQueueJournal();
  const port:ChatQueueBridge={version:1,read:async()=>({available:true,projectPath:project,rows:[stored(1,{state:'unknown'}),stored(2,{attachmentState:'missing'})]}),save:async input=>{writes.push(input);return{saved:true};}};
  await journal.attach(port,provider,rows=>restored.push(rows),()=>{});assert.equal(journal.available(project),true);assert.equal(journal.available('C:\\Other'),false);assert.equal(writes.length,0);assert.equal(restored[0]![0]!.state,'unknown');assert.equal(restored[0]![1]!.attachmentState,'missing');
});
test('queued checkpoint records unknown delivery before dispatch and retains text on save failure without automatic retry',async()=>{
  const writes:ChatQueueSnapshot[]=[];let refuse=true;const journal=new ChatQueueJournal(),item=row();
  await journal.attach({version:1,read:async()=>({available:true,projectPath:project,rows:[]}),save:async input=>{writes.push(structuredClone(input));if(refuse)throw Error('disk unavailable');return{saved:true};}},provider,()=>{},()=>{});
  item.state='sending';assert.equal(await journal.save([item],project),false);assert.equal(item.text,'Queued prompt 1');assert.equal(writes[0]!.rows[0]!.state,'unknown');assert.match(journal.notice()!,/retained/);
  await journal.save([item],project);await tick();assert.equal(writes.length,1,'rendering unchanged failed data cannot retry it');
  refuse=false;assert.equal(await journal.save([item],project,true),true);assert.equal(writes.length,2);assert.equal(journal.notice(),null);
});
test('failed or wrong-project recovery cannot overwrite an existing encrypted queue; serialized edits retain ordering',async()=>{
  const journal=new ChatQueueJournal();let saves=0;
  await journal.attach({version:1,read:async()=>{throw Error('corrupt record');},save:async()=>{saves++;return{saved:true};}},provider,()=>assert.fail('must not restore'),()=>{});
  assert.equal(await journal.save([row()],project,true),false);assert.equal(saves,0);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),writes:ChatQueueSnapshot[]=[];
  await journal.attach({version:1,read:async()=>({available:true,projectPath:project,rows:[]}),save:async value=>{writes.push(value);if(writes.length===1)await gate;return{saved:true};}},provider,()=>{},()=>{});
  const first=journal.save([row()],project);const second=journal.save([row(stored(1,{text:'Edited prompt'}))],project);await tick();assert.equal(writes.length,1);release();assert.equal(await first,true);assert.equal(await second,true);assert.deepEqual(writes.map(value=>value.rows[0]!.text),['Queued prompt 1','Edited prompt']);
});
test('sending rows retain exact request identity; pending and paused rows persist as unsubmitted',()=>{
  const item=row();item.requestId='fcb61d3a-fd0a-42df-958e-a3de7d378504';item.state='sending';assert.equal(storedChatQueueRows([item])[0]!.state,'unknown');assert.equal(storedChatQueueRows([item])[0]!.requestId,item.requestId);
  item.state='paused';assert.equal(storedChatQueueRows([item])[0]!.state,'pending');
});

test('multiple steering receipts share a turn without collapsing or text-based history matching',()=>{
  const stamp='2026-10-20T12:00:00.000Z';
  const receipt=(requestId:string,kind?:'steer')=>({...(kind?{kind}:{}),requestId,turnId:'turn-1',text:'Same text',model:'gpt-6.1-sol',effort:'low',state:'acknowledged' as const,createdAt:stamp,finishedAt:stamp,errorCode:null,contextIncluded:false,transmittedBytes:9});
  const submitted={provider:'codex' as const,projectPath:project,threadId:'thread-1',sessionId:null,earlierCount:0,messages:[receipt('start'),receipt('steer-1','steer'),receipt('steer-2','steer')]};
  const native=[{key:'thread-1\0turn-1\0original-user',role:'human' as const,threadId:'thread-1',scope:'native',text:'Same text'},{key:'thread-1\0turn-1\0steer-1',role:'human' as const,threadId:'thread-1',scope:'native',text:'Same text'}];
  const merged=mergeSubmittedMessages(native,submitted);assert.equal(merged.length,3);assert.deepEqual(merged.map(row=>row.receipt?.requestId),['start','steer-1','steer-2']);assert.equal(merged.filter(row=>row.steered).length,2);
  const uncorrelated=mergeSubmittedMessages([{...native[0]!,key:'thread-1\0turn-1\0different-item'}],{...submitted,messages:[receipt('steer-1','steer')]});assert.equal(uncorrelated.length,2,'equal prompt text and turn ID cannot prove steering identity');
});

test('removing a row while its save is in flight persists the empty queue after that save',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),writes:ChatQueueSnapshot[]=[],journal=new ChatQueueJournal();
  await journal.attach({version:1,read:async()=>({available:true,projectPath:project,rows:[]}),save:async value=>{writes.push(value);if(writes.length===1)await gate;return{saved:true};}},provider,()=>{},()=>{});
  const adding=journal.save([row()],project);await tick();const removing=journal.save([],project);release();await adding;assert.equal(await removing,true);assert.deepEqual(writes.map(value=>value.rows.length),[1,0]);
});


test('queue schema rejects malformed row and array descriptors without invoking accessors',()=>{
  let accessed=0;
  const rowAccessor=stored();Object.defineProperty(rowAccessor,'text',{enumerable:true,get(){accessed++;return 'Untrusted getter';}});
  const arrayAccessor=[stored()];Object.defineProperty(arrayAccessor,'0',{enumerable:true,get(){accessed++;return stored();}});
  const disguisedHole:unknown[]=[];disguisedHole.length=1;Object.defineProperty(disguisedHole,Symbol('gap'),{value:true,enumerable:true});
  const expected={message:'Queued messages could not be saved securely. They are retained in this window.'};
  for(const rows of [[rowAccessor],arrayAccessor,disguisedHole])assert.throws(()=>readChatQueueSnapshot({...snapshot(),rows}),expected);
  assert.equal(accessed,0,'schema examines data descriptors without reading getters');
});

test('queue text rejects every unpaired UTF-16 surrogate and preserves valid pairs exactly',()=>{
  const malformed=['\ud800','\udbff','\udc00','\udfff','\ud800x','x\udfff','\ud800\ud800','\udc00\ud800','\ud83d\ude00\udc00','\ud800\ud83d\ude00'];
  for(const text of malformed){
    assert.throws(()=>readChatQueueSnapshot(snapshot([stored(1,{text})])),/Queued messages could not be saved securely/);
    assert.throws(()=>readChatQueueSnapshot({...snapshot(),projectPath:project+text}),/Queued messages could not be saved securely/);
  }
  const text='\ud800\udc00 / \udbff\udfff / 🧩 / 日本語 / e\u0301';
  assert.equal(readChatQueueSnapshot(snapshot([stored(1,{text})])).rows[0]!.text,text,'no replacement, normalization or loss of valid Unicode');
});

test('queue accepts valid emoji exactly at its UTF-8 byte limit and rejects one additional byte',()=>{
  const text='🧩'.repeat(CHAT_QUEUE_LIMITS.textBytes/4);
  assert.equal(new TextEncoder().encode(text).length,CHAT_QUEUE_LIMITS.textBytes);
  assert.equal(readChatQueueSnapshot(snapshot([stored(1,{text})])).rows[0]!.text,text);
  assert.throws(()=>readChatQueueSnapshot(snapshot([stored(1,{text:text+'a'})])),/Queued messages could not be saved securely/);
});

test('queue recovery is optional at boot and a missing codec cannot read or overwrite secure records',async()=>{
  let loads=0,reads=0,writes=0,changes=0;
  const journal=new ChatQueueJournal(async()=>{loads++;throw Error('Synthetic queue module unavailable');});
  await journal.attach(null,provider,()=>assert.fail('no queue bridge'),()=>{changes++;});
  assert.equal(loads,0,'ordinary chat boot does not load the queue schema');
  assert.equal(journal.available(project),false);
  await journal.attach({version:1,read:async()=>{reads++;return{available:true,projectPath:project,rows:[]};},save:async()=>{writes++;return{saved:true};}},provider,()=>assert.fail('no recovered data'),()=>{changes++;});
  assert.equal(loads,1);assert.equal(reads,0);assert.equal(journal.available(project),false);
  assert.match(journal.notice()!,/Existing records were kept/);
  assert.equal(await journal.save([row()],project,true),false);assert.equal(writes,0);assert.equal(changes,2);
});

test('a late queue codec cannot read a retired bridge or replace a newer project recovery',async()=>{
  const codec={readChatQueueSnapshot,readChatQueueRead};
  let resolveCodec!:(value:typeof codec)=>void,loads=0,oldReads=0,newReads=0;
  const delayed=new Promise<typeof codec>(resolve=>{resolveCodec=resolve;});
  const journal=new ChatQueueJournal(()=>++loads===1?delayed:Promise.resolve(codec));
  const first=journal.attach({version:1,read:async()=>{oldReads++;return{available:true,projectPath:project,rows:[stored()]};},save:async()=>({saved:true})},provider,()=>assert.fail('retired recovery'),()=>assert.fail('retired callback'));
  const newer=project+'-new',writes:ChatQueueSnapshot[]=[],restored:string[]=[];
  await journal.attach({version:1,read:async()=>{newReads++;return{available:true,projectPath:newer,rows:[]};},save:async value=>{writes.push(value);return{saved:true};}},provider,(_rows,path)=>restored.push(path),()=>{});
  resolveCodec(codec);await first;
  assert.equal(oldReads,0);assert.equal(newReads,1);assert.deepEqual(restored,[newer]);
  assert.equal(journal.projectPath,newer);assert.equal(journal.available(project),false);assert.equal(journal.available(newer),true);
  assert.equal(await journal.save([row()],newer),true);assert.equal(writes[0]!.projectPath,newer);
});
