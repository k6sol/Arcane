import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';
const{createRuntimeRecovery}=createRequire(import.meta.url)('../../apps/desktop/electron/runtime-recovery.cjs');
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture({enabled=true,confirm=true,startError=false,ready=true}={}){
 const calls=[],handlers=new Map(),timers=new Map();let timerId=0,running=false;
 const frame={url:'http://127.0.0.1:45871/studio#fixture'},contents={mainFrame:frame,isDestroyed:()=>false,send:(channel,payload)=>calls.push(['send',channel,structuredClone(payload)])};
 const owner={webContents:contents,isDestroyed:()=>false},context={window:owner,project:Object.freeze({projectId:'a'.repeat(64),projectPath:'C:\\Project',stateRoot:'C:\\Profile\\runtime\\projects\\'+'a'.repeat(64)}),userRoot:'C:\\Profile',origin:'http://127.0.0.1:45871',closing:false,switching:false};
 const recovery=createRuntimeRecovery({enabled,getContext:()=>context,setBusy:value=>{context.switching=value;calls.push(['busy',value]);},
  retire:async()=>{context.origin='';running=false;calls.push(['retire']);},delay:async ms=>calls.push(['delay',ms]),confirm:async()=>{calls.push(['confirm']);return confirm;},
  start:async()=>{calls.push(['start']);if(startError)throw Error('Private startup detail');running=true;},reload:async()=>calls.push(['reload']),running:()=>running,
  setTimer:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
 recovery.installIpc({handle:(channel,handler)=>handlers.set(channel,handler)},event=>event.sender===contents&&event.senderFrame===frame);
 const event={sender:contents,senderFrame:frame};if(!ready)frame.url='';if(ready)void handlers.get('arcane:runtime-recovery-status')(event);
 const invoke=(kind,...args)=>handlers.get('arcane:runtime-recovery-'+kind)(event,...args);
 const request=()=>calls.filter(row=>row[0]==='send'&&row[1]==='arcane:runtime-recovery-checkpoint').at(-1)?.[2];
 const acknowledge=saved=>invoke('saved',{requestId:request().requestId,saved});
 return{calls,context,recovery,handlers,timers,event,contents,frame,owner,invoke,request,acknowledge,stop:info=>recovery.stopped({code:1,signal:null,uptimeMs:120000,...info})};
}
const named=(f,name)=>f.calls.filter(row=>row[0]===name);
test('healthy abnormal exits checkpoint before a single automatic restart, with no replay',async()=>{
 const f=fixture(),done=f.stop();await settle();assert.equal(named(f,'start').length,0);assert.equal(named(f,'confirm').length,0);assert.deepEqual(named(f,'delay'),[['delay',2000]]);
 assert.equal(f.recovery.status().state,'saving');assert.equal(f.recovery.preferences().origin,'http://127.0.0.1:45871');assert.equal(Object.hasOwn(f.recovery.preferences(),'token'),false);
 await f.acknowledge(true);await done;assert.equal(named(f,'start').length,1);assert.equal(named(f,'reload').length,1);assert.equal(f.context.switching,false);assert.equal(f.recovery.status().state,'ready');assert.equal(f.recovery.preferences(),null);assert.equal(f.timers.size,0);
});
test('a failed checkpoint retains the window and encrypted-save scope without starting a service',async()=>{
 const f=fixture(),done=f.stop();await settle();await f.acknowledge(false);await done;
 assert.equal(named(f,'start').length,0);assert.equal(named(f,'reload').length,0);assert.equal(f.recovery.status().state,'stopped');assert.match(f.recovery.status().message,/could not be saved/);assert.equal(f.context.window,f.owner);assert.ok(f.recovery.preferences());assert.equal(f.context.switching,false);
});
test('declining manual recovery keeps the exact document open and never starts anything',async()=>{
 for(const info of[{code:0},{uptimeMs:5000}]){const f=fixture({confirm:false});await f.stop(info);assert.equal(named(f,'confirm').length,1);assert.equal(named(f,'delay').length,0);assert.equal(named(f,'start').length,0);assert.equal(f.context.window,f.owner);assert.equal(f.recovery.status().state,'stopped');}
});
test('checkpoint timeout rejects late acknowledgements and preserves the document',async()=>{
 const f=fixture(),done=f.stop();await settle();const request=f.request();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,10000);[...f.timers.values()][0].fn();await done;
 await assert.rejects(f.invoke('saved',{requestId:request.requestId,saved:true}),/unavailable/);assert.equal(named(f,'reload').length,0);assert.ok(f.recovery.preferences());
});
test('only an exact current-frame nonce and boolean can acknowledge a checkpoint',async()=>{
 const f=fixture(),done=f.stop();await settle();const request=f.request(),handler=f.handlers.get('arcane:runtime-recovery-saved');
 for(const value of[{requestId:'wrong',saved:true},{requestId:request.requestId,saved:'yes'},{requestId:request.requestId,saved:true,token:'x'}])await assert.rejects(f.invoke('saved',value),/unavailable/);
 for(const event of[{sender:{},senderFrame:f.frame},{sender:f.contents,senderFrame:{url:f.frame.url}}])await assert.rejects(handler(event,{requestId:request.requestId,saved:true}),/unavailable/);
 assert.equal(named(f,'start').length,0);await f.acknowledge(true);await done;await assert.rejects(f.acknowledge(true),/unavailable/);
});
test('navigation invalidation cancels the checkpoint and retires presentation scope',async()=>{
 const f=fixture(),done=f.stop();await settle();f.recovery.invalidate();await done;assert.equal(f.timers.size,0);assert.equal(f.recovery.preferences(),null);assert.equal(named(f,'start').length,0);
});

test('completed same-document navigation retains draft saves and rotates the preference epoch',async()=>{
 const f=fixture({confirm:false});await f.stop({code:0});const previous=f.recovery.preferences();
 f.frame.url='http://127.0.0.1:45871/studio#settings';
 assert.equal(f.recovery.preferences(),null,'A changed URL is not trusted before the native completion event.');
 assert.equal(f.recovery.navigatedInPage({},f.frame.url),false,'Another window cannot update the scope.');
 assert.equal(f.recovery.navigatedInPage(f.owner,f.frame.url),true);
 const next=f.recovery.preferences();assert.ok(next);assert.notEqual(next.epoch,previous.epoch,'Earlier asynchronous preference operations must recheck ownership.');
 assert.equal(next.projectPath,previous.projectPath);assert.equal(next.origin,previous.origin);assert.equal(Object.hasOwn(next,'token'),false);
 assert.equal(f.recovery.navigatedInPage(f.owner,f.frame.url),true);assert.equal(f.recovery.preferences().epoch,next.epoch,'Duplicate completion does not invalidate new saves.');
});

test('same-document completion keeps the exact checkpoint usable without authorizing another frame',async()=>{
 const f=fixture(),done=f.stop();await settle();const request=f.request();f.frame.url='http://127.0.0.1:45871/studio#chat';
 assert.equal(f.recovery.navigatedInPage(f.owner,f.frame.url),true);
 await assert.rejects(f.handlers.get('arcane:runtime-recovery-saved')({sender:f.contents,senderFrame:{url:f.frame.url}},{requestId:request.requestId,saved:true}),/unavailable/);
 await f.acknowledge(true);await done;assert.equal(named(f,'reload').length,1);
});

test('same-document events cannot adopt a different frame, project, profile or disallowed URL',async()=>{
 for(const mutate of[f=>f.contents.mainFrame={url:f.frame.url},f=>f.context.project={...f.context.project,projectPath:'C:\\Other'},f=>f.context.userRoot='C:\\Other',f=>f.context.closing=true,
  f=>f.frame.url='https://example.com/studio',f=>f.frame.url='http://127.0.0.1:45871/v1/other',f=>f.frame.url='http://127.0.0.1:45871/studio?other=1']){
  const f=fixture({confirm:false});await f.stop({code:0});mutate(f);assert.equal(f.recovery.navigatedInPage(f.owner,f.frame.url),false);assert.equal(f.recovery.preferences(),null);await assert.rejects(f.invoke('retry'),/unavailable/);
 }
 const f=fixture({confirm:false});await f.stop({code:0});assert.equal(f.recovery.navigatedInPage(f.owner,'http://127.0.0.1:45871/studio#not-the-frame'),false);assert.equal(f.recovery.preferences(),null,'A completion URL must match the actual main frame.');
});
test('retained presentation scope rejects changed owner, frame, project, profile and closing',async()=>{
 for(const mutate of[f=>f.context.window=null,f=>f.contents.mainFrame={url:f.frame.url},f=>f.frame.url+='x',f=>f.context.project={...f.context.project,projectId:'b'.repeat(64)},f=>f.context.userRoot='C:\\Other',f=>f.context.closing=true]){
  const f=fixture({confirm:false});await f.stop({code:0});assert.ok(f.recovery.preferences());mutate(f);assert.equal(f.recovery.preferences(),null);await assert.rejects(f.invoke('retry'),/unavailable/);
 }
});
test('failed replacement startup keeps the original draft document and exposes only a generic error',async()=>{
 const f=fixture({startError:true}),done=f.stop();await settle();await f.acknowledge(true);await done;assert.equal(named(f,'reload').length,0);assert.equal(f.recovery.status().state,'stopped');assert.doesNotMatch(f.recovery.status().message,/Private/);assert.ok(f.recovery.preferences());
});
test('disabled recovery stays inert and retry always needs a fresh native decision',async()=>{
 const disabled=fixture({enabled:false});await disabled.stop();assert.deepEqual(disabled.calls,[]);assert.deepEqual(await disabled.invoke('status'),{version:1,state:'unavailable',message:''});await assert.rejects(disabled.invoke('retry'),/unavailable/);
 const f=fixture(),first=f.stop();await settle();await f.acknowledge(false);await first;await f.invoke('retry');await settle();assert.equal(named(f,'confirm').length,1);assert.equal(named(f,'start').length,0);await f.acknowledge(true);await settle();assert.equal(named(f,'start').length,1);
});

 test('an unopened workspace is returned to startup handling without pretending a checkpoint exists',async()=>{
 const f=fixture({ready:false});assert.equal(await f.stop(),false);assert.equal(named(f,'start').length,0);assert.equal(f.request(),undefined);assert.equal(f.recovery.preferences(),null);
});
 test('navigation in a different staging window does not cancel the retained document checkpoint',async()=>{
 const f=fixture(),done=f.stop();await settle();f.recovery.invalidate({});await f.acknowledge(true);await done;assert.equal(named(f,'reload').length,1);
});


test('replacement readiness is a separate trusted-frame signal and can be cancelled without navigating',async()=>{
 const f=fixture(),ready=f.recovery.waitForRenderer(f.owner);let finished=false;ready.then(()=>finished=true);await settle();assert.equal(finished,false);
 await assert.rejects(f.invoke('ready','extra'),/unavailable/);await assert.rejects(f.handlers.get('arcane:runtime-recovery-ready')({sender:{},senderFrame:f.frame}),/unavailable/);
 assert.deepEqual(await f.invoke('ready'),{ready:true});assert.equal(await ready,true);
 const cancelled=f.recovery.waitForRenderer(f.owner);f.recovery.cancelRenderer(f.owner);assert.equal(await cancelled,false);
 const changed=f.recovery.waitForRenderer(f.owner);f.context.project={...f.context.project,projectPath:'C:\\Other'};await assert.rejects(f.invoke('ready'),/unavailable/);f.recovery.cancelRenderer(f.owner);assert.equal(await changed,false);
});
