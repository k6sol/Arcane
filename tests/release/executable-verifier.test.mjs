import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedChild } from '../../scripts/check-windows-executable.mjs';
test('bounded verifier child waits for actual normal exit', async () => {
  const r=await runBoundedChild(process.execPath,['-e',"process.stdout.write('fixture');"]);
  assert.equal(r.code,0);assert.equal(r.output,'fixture');assert.equal(r.outputBytes,7);assert.equal(r.signal,null);
});
test('bounded verifier child preserves nonzero terminal state',async()=>{
  assert.equal((await runBoundedChild(process.execPath,['-e','process.exit(7)'])).code,7);
});
test('bounded verifier child rejects missing executable without shell fallback',async()=>{
  await assert.rejects(runBoundedChild('arcane-verifier-no-such-executable',[]),/could not be launched/);
});
test('bounded verifier child bounds diagnostics and acknowledges termination',async()=>{
  await assert.rejects(runBoundedChild(process.execPath,['-e',"process.stdout.write('x'.repeat(32768));setTimeout(()=>{},10000)"],{maxOutputBytes:1024}),
    e=>/diagnostics exceeded/.test(e.message)&&/exit acknowledged/.test(e.message));
});
test('bounded verifier child has a hard owned-process deadline',async()=>{
  await assert.rejects(runBoundedChild(process.execPath,['-e','setTimeout(()=>{},10000)'],{deadlineMs:100}),
    e=>/deadline exceeded/.test(e.message)&&/exit acknowledged/.test(e.message));
});
test('bounded verifier child checks limits before spawning',async()=>{
  for(const o of [{deadlineMs:0},{deadlineMs:180001},{maxOutputBytes:0},{maxOutputBytes:262145}])
    await assert.rejects(runBoundedChild(process.execPath,[],o),/Invalid child-process bounds/);
});
test('private IPC parent loss observes actual graceful child exit',async()=>{
  let ready=false;
  const r=await runBoundedChild(process.execPath,['-e',"process.send({type:'fixture-ready'});process.once('disconnect',()=>process.exit(0));"],
    {ipc:true,onMessage:(m,c)=>{assert.equal(m.type,'fixture-ready');ready=true;c.disconnect();}});
  assert.equal(ready,true);assert.equal(r.code,0);
});

test('a proved timely exit cancels deadline before delayed IPC drain',async()=>{
  const {EventEmitter}=await import('node:events'),{runInNewContext}=await import('node:vm');
  const child=new EventEmitter(); let kills=0;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};child.connected=false;child.pid=123;child.kill=()=>kills++;
  const timers=[],cleared=new Set();
  const run=runInNewContext('('+runBoundedChild.toString()+')',{spawn:()=>child,process:{env:{}},
    setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>cleared.add(t)});
  const pending=run('fixture',[],{deadlineMs:150,env:{}});
  child.emit('exit',0,null);
  assert.equal(cleared.has(timers[0]),true,'deadline disarmed by actual exit');
  for(const t of timers)if(!cleared.has(t))t.fn();
  assert.equal((await pending).code,0);assert.equal(kills,0);
});
