import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { type FileHandle } from 'node:fs/promises';
import { linkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readRegularFile } from '../../packages/asset-pipeline/src/paths.js';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';
import { validateManifestFiles } from '../../packages/asset-pipeline/src/validation.js';
import { manifestFixture } from '../../packages/asset-pipeline/testing/fixture.js';

async function directory(t: test.TestContext) {
  const base=await fs.realpath(tmpdir()),root=await fs.realpath(await fs.mkdtemp(join(base,'arcane-read-admission-')));
  t.after(async()=>{const part=relative(base,root);assert.ok(part.startsWith('arcane-read-admission-')&&!isAbsolute(part)&&!part.includes(sep));await fs.rm(root,{recursive:true,force:true});});
  return root;
}
function observeOpenedReads(t: test.TestContext) {
  const opened:{handle:FileHandle;reads:()=>number;closes:()=>number}[]=[],original=fs.open;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await original(...args),read=t.mock.method(handle,'read'),close=t.mock.method(handle,'close');
    opened.push({handle,reads:()=>read.mock.callCount(),closes:()=>close.mock.callCount()});return handle;
  });
  const allocation=t.mock.method(Buffer,'alloc');
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return {opened,allocations:()=>allocation.mock.callCount()};
}

for(const refusal of [new Error('original metadata refusal'),null,undefined,false,0])
test('opened metadata refusal precedes allocation/read and closes with exact reason '+String(refusal),async t=>{
  const root=await directory(t),path=join(root,'input.bin');await fs.writeFile(path,'bounded bytes');
  const observed=observeOpenedReads(t);let admitted=false,rejected=false,actual:unknown;
  try{await readRegularFile(path,128,size=>{
    admitted=true;assert.equal(size,13);assert.equal(observed.opened.length,1);
    assert.equal(observed.allocations(),0);assert.equal(observed.opened[0]!.reads(),0);throw refusal;
  });}catch(error){rejected=true;actual=error;}
  assert.equal(admitted,true);assert.equal(rejected,true);assert.equal(actual,refusal);
  assert.equal(observed.allocations(),0);assert.equal(observed.opened[0]!.reads(),0);
  assert.equal(observed.opened[0]!.closes(),1);assert.equal(observed.opened[0]!.handle.fd,-1);
});

test('opened metadata admission preserves exact-size success and pre-admission bounds',async t=>{
  const root=await directory(t),path=join(root,'input.bin'),bytes=Buffer.from('bounded bytes');await fs.writeFile(path,bytes);
  const observed=observeOpenedReads(t);let calls=0;
  const read=await readRegularFile(path,bytes.length,size=>{
    calls++;assert.equal(size,bytes.length);assert.equal(observed.allocations(),0);assert.equal(observed.opened[0]!.reads(),0);
  });
  assert.deepEqual(read,bytes);assert.equal(calls,1);assert.ok(observed.opened[0]!.reads()>=2);
  assert.equal(observed.opened[0]!.closes(),1);assert.equal(observed.opened[0]!.handle.fd,-1);
  await assert.rejects(readRegularFile(path,bytes.length-1,()=>{assert.fail('Oversized files must be refused before admission');}),{code:'ARTIFACT'});
  assert.equal(observed.opened.length,1);
});

test('opened metadata admission cannot bypass initial hard links or post-read path replacement',async t=>{
  const root=await directory(t),path=join(root,'input.bin'),alias=join(root,'alias.bin');await fs.writeFile(path,'bounded bytes');
  await fs.link(path,alias);
  await assert.rejects(readRegularFile(path,128,()=>{assert.fail('Aliased files must be refused before admission');}),{code:'ARTIFACT'});
  await fs.unlink(alias);
  await assert.rejects(readRegularFile(path,128,()=>{renameSync(path,alias);writeFileSync(path,'bounded bytes');}),{code:'ARTIFACT'});
});

test('opened metadata admission retains post-read hard-link and pre-existing ancestor-junction proofs',async t=>{
  const root=await directory(t),inner=join(root,'inner'),elsewhere=join(root,'elsewhere');await fs.mkdir(inner);await fs.mkdir(elsewhere);
  const path=join(inner,'input.bin'),alias=join(root,'alias.bin');await fs.writeFile(path,'bounded bytes');
  await assert.rejects(readRegularFile(path,128,()=>{linkSync(path,alias);}),{code:'ARTIFACT'});
  await fs.unlink(alias);await fs.writeFile(join(elsewhere,'input.bin'),'bounded bytes');
  // Windows denies renaming a directory containing the open descriptor. Create
  // a real junction before opening instead, so OUTPUT_PATH proves the actual
  // ancestor guard rather than an OS-denied replacement attempt.
  renameSync(inner,join(root,'original'));symlinkSync(elsewhere,inner,process.platform==='win32'?'junction':'dir');
  await assert.rejects(readRegularFile(path,128,()=>{assert.fail('An ancestor junction must be refused before admission');}),{code:'OUTPUT_PATH'});
});

test('manifest opened-size admission preserves original mismatch diagnostics and hash checks',async t=>{
  const root=await directory(t),manifest=await manifestFixture(root);
  assert.equal(await validateManifestFiles(root,manifest),manifest);
  const mismatch=structuredClone(manifest),artifact=mismatch.artifacts[0]!,actualSize=artifact.bytes;artifact.bytes++;
  const observed=observeOpenedReads(t);
  let failure:unknown;
  try{await validateManifestFiles(root,mismatch);}catch(error){failure=error;}
  assert.ok(failure instanceof AssetError);assert.equal(failure.code,'MANIFEST');
  assert.ok(failure.message.includes(`Artifact size changed or exceeded 268435456 total bytes; observed ${actualSize}, manifest ${actualSize+1}, total ${actualSize}.`));
  assert.equal(observed.allocations(),0);assert.equal(observed.opened.length,1);assert.equal(observed.opened[0]!.reads(),0);
  assert.equal(observed.opened[0]!.closes(),1);assert.equal(observed.opened[0]!.handle.fd,-1);
  const changed=join(root,manifest.artifacts[0]!.path),original=await fs.readFile(changed);await fs.writeFile(changed,Buffer.alloc(original.length,0x7f));
  await assert.rejects(validateManifestFiles(root,manifest),{code:'HASH'});
});

test('manifest retains the 128MiB per-artifact cap before allocation or opened-size admission',async t=>{
  const root=await directory(t),manifest=await manifestFixture(root);
  // A sparse oversized scene needs no large fixture buffer or content read.
  await fs.truncate(join(root,manifest.artifacts[0]!.path),128*1024*1024+1);
  const observed=observeOpenedReads(t);
  await assert.rejects(validateManifestFiles(root,manifest),{code:'ARTIFACT'});
  assert.equal(observed.allocations(),0);assert.equal(observed.opened.length,0);
});
