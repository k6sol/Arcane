import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{createDesktopUpdates}=require('../../apps/desktop/electron/desktop-updates.cjs');
const sourceRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const owner=await realpath(await mkdtemp(join(tmpdir(),'arcane-updates-test-')));t.after(()=>rm(owner,{recursive:true,force:true}));
  const root=join(owner,'installed'),running=join(owner,'running'),bytes=Buffer.from('verified release fixture'),sha=hash(bytes);
  const id=sha+'-11111111-2222-4333-8444-555555555555',directory=join(root,'releases',id);
  await mkdir(directory,{recursive:true});await mkdir(running);await writeFile(join(running,'windows-manifest.json'),'previous release');
  await writeFile(join(directory,'windows-manifest.json'),bytes);await writeFile(join(directory,'Arcane.exe'),Buffer.alloc(64));
  const record={schemaVersion:1,kind:'arcane-windows-installation',installationId:'11111111-2222-4333-8444-555555555555',activeReleaseId:id,
    releases:[{id,version:'0.1.0',manifestSha256:sha,files:1,bytes:64,installedAt:'2026-10-18T00:00:00.000Z'}]};
  await writeFile(join(root,'installation.json'),JSON.stringify(record)+'\n');
  const calls=[],starts=[];
  const options={installRoot:root,currentDirectory:running,productRoot:sourceRoot,
    verifyBundle:async dir=>{calls.push(dir);return {manifestSha256:sha};},restart:async executable=>{starts.push(executable);return true;}};
  return {owner,root,running,directory,record,sha,bytes,calls,starts,options};
}
test('installed update observation verifies a new release once and never restarts it',async t=>{
  const f=await fixture(t),host=createDesktopUpdates(f.options);
  assert.equal((await host.status()).state,'available');assert.equal((await host.status()).state,'available');
  assert.deepEqual(f.calls,[f.directory]);assert.deepEqual(f.starts,[]);
  await writeFile(join(f.running,'windows-manifest.json'),f.bytes);
  assert.equal((await host.status()).state,'current');assert.deepEqual(f.starts,[]);
});
test('restart rechecks the complete package and exact active release, with no renderer path input',async t=>{
  const f=await fixture(t),host=createDesktopUpdates(f.options);
  await host.status();assert.equal((await host.restart()).state,'restarting');
  assert.equal(f.calls.length,2);assert.deepEqual(f.starts,[join(f.directory,'Arcane.exe')]);
  assert.equal((await host.restart()).state,'unavailable','An accepted restart cannot launch another copy.');
  assert.equal(f.starts.length,1);
  const handlers=new Map();host.installIpc({handle:(name,fn)=>handlers.set(name,fn)},{trusted:event=>event.ok});
  await assert.rejects(async()=>handlers.get('arcane:updates-restart')({ok:true},'C:/other.exe'),/unavailable/);
  await assert.rejects(async()=>handlers.get('arcane:updates-status')({ok:false}),/unavailable/);
});
test('changed records, manifests, linked state and an active installer never authorize restart',async t=>{
  for(const kind of ['manifest','record','hardlink','lock','verification','changed-during-check','closed'])await t.test(kind,async sub=>{
    const f=await fixture(sub),options={...f.options};
    if(kind==='manifest')await writeFile(join(f.directory,'windows-manifest.json'),'changed');
    if(kind==='record')await writeFile(join(f.root,'installation.json'),JSON.stringify({...f.record,activeReleaseId:'../../other'}));
    if(kind==='hardlink')await link(join(f.root,'installation.json'),join(f.owner,'other.json'));
    if(kind==='lock')await writeFile(join(f.root,'installation.lock'),'busy');
    if(kind==='verification')options.verifyBundle=async()=>({manifestSha256:'0'.repeat(64)});
    if(kind==='changed-during-check')options.verifyBundle=async()=>{await writeFile(join(f.root,'installation.json'),'{');return {manifestSha256:f.sha};};
    if(kind==='closed')options.available=()=>false;
    const host=createDesktopUpdates(options);
    assert.notEqual((await host.restart()).state,'restarting');assert.deepEqual(f.starts,[]);
  });
});
test('overlapping restart requests and failed shutdown do not launch another app',async t=>{
  const f=await fixture(t);let release;const wait=new Promise(done=>{release=done;});
  const host=createDesktopUpdates({...f.options,restart:async()=>{await wait;return false;}});
  const first=host.restart();await new Promise(done=>setTimeout(done,30));
  assert.equal((await host.restart()).state,'unavailable');release();
  assert.equal((await first).state,'refused');assert.deepEqual(f.starts,[]);
});
test('verification mode observes no installation and starts no update',async()=>{
  const host=createDesktopUpdates({enabled:false,verifyBundle:()=>assert.fail('no filesystem verification'),restart:()=>assert.fail('no restart')});
  assert.equal((await host.status()).state,'unavailable');assert.equal((await host.restart()).state,'unavailable');
});
test('a completed project or window change during update verification retires the original restart request',async t=>{
  for(const field of ['window','epoch','origin','token'])await t.test(field,async sub=>{
    const f=await fixture(sub),context={window:{},epoch:{},origin:'http://127.0.0.1:4000',token:'original'};
    const host=createDesktopUpdates({...f.options,getContext:()=>({...context}),verifyBundle:async()=>{
      context[field]=field==='window'||field==='epoch'?{}:'changed';return {manifestSha256:f.sha};
    }});
    assert.equal((await host.restart()).state,'refused');assert.deepEqual(f.starts,[],'An old request cannot close the new workspace.');
  });
});
test('sandboxed preload exposes only bounded zero-argument update intents',async()=>{
  let desktop;const calls=[];
  const preload=await readFile(new URL('../../apps/desktop/electron/preload.cjs',import.meta.url),'utf8');
  vm.runInNewContext(preload,{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(key,value)=>{if(key==='arcaneDesktop')desktop=value;}},
    ipcRenderer:{invoke:async channel=>{calls.push(channel);return channel.endsWith('status')?{version:1,state:'available',buildId:'a'.repeat(64)+'-11111111-2222-4333-8444-555555555555',message:'Ready',path:'SECRET'}:{state:'restarting',message:'Restarting',path:'SECRET'};},on(){},removeListener(){}}};}});
  assert.ok(Object.isFrozen(desktop.updates));
  assert.equal((await desktop.updates.status()).state,'available');assert.equal((await desktop.updates.restart()).state,'restarting');
  assert.ok(!JSON.stringify(await desktop.updates.status()).includes('SECRET'));
  const before=calls.length;await assert.rejects(desktop.updates.restart('other'));await assert.rejects(desktop.updates.status({}));assert.equal(calls.length,before);
});
