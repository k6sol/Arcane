import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,realpath,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDesktopInstaller} from '../../scripts/install-desktop.mjs';
const repository=fileURLToPath(new URL('../..',import.meta.url));
async function fixture(t){
 const owner=await realpath(await mkdtemp(join(tmpdir(),'arcane-desktop-install-')));t.after(()=>rm(owner,{recursive:true,force:true}));
 const root=join(owner,'installed'),built=join(owner,'launcher.exe');await writeFile(built,Buffer.concat([Buffer.from('MZ'),Buffer.alloc(100)]));
 let installs=0,builds=0;const shortcuts=[];
 const installer=createDesktopInstaller({sourceRoot:repository,engine:{install:async()=>{installs++;await mkdir(root,{recursive:true});return {state:'installed',launched:false};}},
  launcherBuilder:async()=>{builds++;return built;},shortcut:async target=>{shortcuts.push(target);return join(owner,'Desktop','Arcane.lnk');}});
 return {owner,root,built,installer,shortcuts,installs:()=>installs,builds:()=>builds};
}
test('desktop deployments retain one stable launcher while each verified release can advance',async t=>{
 const f=await fixture(t),request={bundle:join(f.owner,'bundle'),installRoot:f.root};
 const first=await f.installer.install(request),bytes=await readFile(first.launcher);
 const second=await f.installer.install(request);
 assert.equal(f.installs(),2);assert.equal(f.builds(),1);assert.equal(first.launcher,second.launcher);
 assert.deepEqual(await readFile(second.launcher),bytes);assert.deepEqual(f.shortcuts,[first.launcher,first.launcher]);
 assert.equal(second.shortcuts,true);assert.equal(second.launched,false,'Installing an update never closes or launches the user app.');
});
test('an unowned, changed or linked stable launcher is retained and blocks publication',async t=>{
 for(const kind of ['unowned','changed','linked-record','bad-record','null-record'])await t.test(kind,async sub=>{
  const f=await fixture(sub),request={bundle:join(f.owner,'bundle'),installRoot:f.root};
  if(kind==='unowned'){await mkdir(f.root);await writeFile(join(f.root,'Arcane.exe'),'user file');}
  else{await f.installer.install(request);f.shortcuts.length=0;
   if(kind==='changed')await writeFile(join(f.root,'Arcane.exe'),'changed');
   if(kind==='linked-record')await link(join(f.root,'desktop-launcher.json'),join(f.owner,'other.json'));
   if(kind==='bad-record')await writeFile(join(f.root,'desktop-launcher.json'),'{}');
   if(kind==='null-record')await writeFile(join(f.root,'desktop-launcher.json'),'null');
  }
  const before=await readFile(join(f.root,'Arcane.exe')),installs=f.installs();
  await assert.rejects(f.installer.install(request));assert.equal(f.installs(),installs,'No new active release is published.');
  assert.deepEqual(await readFile(join(f.root,'Arcane.exe')),before);assert.deepEqual(f.shortcuts,[]);
 });
});
