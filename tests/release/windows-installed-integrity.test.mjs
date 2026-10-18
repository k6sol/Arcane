import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,link} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createWindowsInstallation,verifyInstalledRelease} from '../../scripts/windows-installation.mjs';
const require=createRequire(import.meta.url),{createDesktopUpdates}=require('../../apps/desktop/electron/desktop-updates.cjs');
const repository=fileURLToPath(new URL('../..',import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Real installation engine and files; a labelled newer-producer verifier admits this small future-format fixture.
// Its executable bytes are inert placeholders, and its extra host module throws if anyone tries to execute it.
async function fixture(t){
 const owner=await realpath(await mkdtemp(join(tmpdir(),'arcane-inventory-')));t.after(()=>rm(owner,{recursive:true,force:true}));
 const bundle=join(owner,'bundle'),root=join(owner,'installed'),running=join(owner,'running');
 const payload=new Map([['Arcane.exe',Buffer.from('MZ inert executable fixture')],['resources/node/node.exe',Buffer.from('MZ inert node fixture')],
  ['resources/app/future-module.cjs',Buffer.from('throw Error("Fixture code must never execute during verification");')]]);
 for(const [name,bytes] of payload){await mkdir(dirname(join(bundle,name)),{recursive:true});await writeFile(join(bundle,name),bytes);}
 const files=[...payload].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}));
 const manifest={schemaVersion:1,kind:'arcane-windows-directory',platform:'win32',arch:'x64',version:'0.2.0',fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0),files};
 const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(bundle,'windows-manifest.json'),bytes);
 const producer=createWindowsInstallation({verifyBundle:async()=>({manifestSha256:hash(bytes),files:files.length,bytes:manifest.totalBytes})});
 const installed=await producer.install({bundle,installRoot:root});await mkdir(running);await writeFile(join(running,'windows-manifest.json'),'older installed release');
 return {owner,root,running,directory:installed.releaseDirectory,id:installed.activeReleaseId,manifestSha256:hash(bytes)};
}
test('an older updater verifies a published inventory with new host modules without importing target code',async t=>{
 const f=await fixture(t),proof=await verifyInstalledRelease({installRoot:f.root,expectedReleaseId:f.id});
 assert.equal(proof.manifestSha256,f.manifestSha256);assert.equal(proof.files,3);
 const starts=[];const host=createDesktopUpdates({installRoot:f.root,currentDirectory:f.running,productRoot:repository,restart:async path=>{starts.push(path);return false;}});
 assert.equal((await host.status()).state,'available');assert.deepEqual(starts,[],'Observation starts no application.');
 assert.equal((await host.restart()).state,'refused');assert.deepEqual(starts,[join(f.directory,'Arcane.exe')],'Only the fixed, freshly verified executable reaches the lifecycle port.');
});
test('installed integrity rejects changed, absent, unlisted and linked payloads while retaining the active record',async t=>{
 for(const kind of ['changed','missing','unlisted','empty-directory','hardlink','wrong-release','locked'])await t.test(kind,async sub=>{
  const f=await fixture(sub),record=await readFile(join(f.root,'installation.json')),file=join(f.directory,'resources/app/future-module.cjs');
  if(kind==='changed')await writeFile(file,'changed');
  if(kind==='missing')await rm(file);
  if(kind==='unlisted')await writeFile(join(f.directory,'extra.cjs'),'unlisted');
  if(kind==='empty-directory')await mkdir(join(f.directory,'extra'));
  if(kind==='hardlink')await link(file,join(f.owner,'alias.cjs'));
  if(kind==='locked')await writeFile(join(f.root,'installation.lock'),'busy');
  await assert.rejects(verifyInstalledRelease({installRoot:f.root,expectedReleaseId:kind==='wrong-release'?'wrong':f.id}));
  assert.deepEqual(await readFile(join(f.root,'installation.json')),record);
 });
});
