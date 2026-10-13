import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { writeVerificationProgress } from '../../scripts/check-windows-executable.mjs';
async function owned(t) {
  const base=await fs.realpath(tmpdir()),root=await fs.mkdtemp(join(base,'arcane-progress-fixture-'));
  t.after(async()=>{const p=relative(base,root);assert.ok(p&&!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep));assert.equal((await fs.lstat(root)).isSymbolicLink(),false);await fs.rm(root,{recursive:true,force:true});});
  return root;
}
test('verifier progress replaces exact records without a reused fixed partial name',async t=>{
  const root=await owned(t);await fs.writeFile(join(root,'progress.partial'),'original retained failed snapshot');
  await writeVerificationProgress(root,{phase:'verify-before',status:'running'});
  await writeVerificationProgress(root,{phase:'launch',status:'running'});
  assert.deepEqual(JSON.parse(await fs.readFile(join(root,'progress.json'),'utf8')),{phase:'launch',status:'running'});
  assert.equal(await fs.readFile(join(root,'progress.partial'),'utf8'),'original retained failed snapshot');
  assert.deepEqual((await fs.readdir(root)).sort(),['progress.json','progress.partial']);
});
test('sharing lock does not turn a diagnostic update into an EEXIST replay',async t=>{
  const root=await owned(t);await writeVerificationProgress(root,{phase:'before'});
  const original=fs.rename;let calls=0;
  fs.rename=async(...args)=>{calls++;if(calls<3)throw Object.assign(new Error('synthetic lock'),{code:'EPERM'});return original(...args);};syncBuiltinESMExports();
  t.after(()=>{fs.rename=original;syncBuiltinESMExports();});
  if(process.platform==='win32'){
    await writeVerificationProgress(root,{phase:'launch'});assert.equal(calls,3);
    assert.deepEqual(JSON.parse(await fs.readFile(join(root,'progress.json'),'utf8')),{phase:'launch'});
  }else{
    await assert.rejects(()=>writeVerificationProgress(root,{phase:'launch'}),e=>e.phase==='replace'&&e.code==='EPERM');assert.equal(calls,1);
  }
});
test('non-sharing failure preserves the prior progress and uncommitted unique snapshot',async t=>{
  const root=await owned(t);await writeVerificationProgress(root,{phase:'before'});
  const original=fs.rename;let calls=0;
  fs.rename=async()=>{calls++;throw Object.assign(new Error('synthetic denial'),{code:'EACCES'});};syncBuiltinESMExports();
  t.after(()=>{fs.rename=original;syncBuiltinESMExports();});
  await assert.rejects(()=>writeVerificationProgress(root,{phase:'launch'}),e=>e.phase==='replace'&&e.code==='EACCES');
  assert.equal(calls,1);assert.deepEqual(JSON.parse(await fs.readFile(join(root,'progress.json'),'utf8')),{phase:'before'});
  const pending=(await fs.readdir(root)).filter(n=>n.startsWith('state-'));assert.equal(pending.length,1);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root,pending[0]),'utf8')),{phase:'launch'});
});
