import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,isAbsolute,join,relative} from 'node:path';
import {copyFile,lstat,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {LUAU_TEST_PINS,verifyLuauTestArchive,verifyLuauTestInstallation} from '../../scripts/luau-test-runtime.mjs';
import {MANAGED_LUAU_MANIFEST} from '../../scripts/managed-luau-compiler.mjs';

test('CI interpreter pins retain the independently reviewed Windows compiler/archive identity',()=>{
  assert.equal(LUAU_TEST_PINS.win32.bytes,MANAGED_LUAU_MANIFEST.archive.bytes);
  assert.equal(LUAU_TEST_PINS.win32.sha256,MANAGED_LUAU_MANIFEST.archive.sha256);
  assert.deepEqual(LUAU_TEST_PINS.win32.compiler,{name:MANAGED_LUAU_MANIFEST.compiler.file,bytes:MANAGED_LUAU_MANIFEST.compiler.bytes,sha256:MANAGED_LUAU_MANIFEST.compiler.sha256});
});
test('archive admission rejects unsupported platforms and incorrect complete bytes before extraction',()=>{
  assert.throws(()=>verifyLuauTestArchive('darwin',Buffer.alloc(1)),/Windows or Linux/);
  for(const platform of ['win32','linux'])assert.throws(()=>verifyLuauTestArchive(platform,Buffer.alloc(LUAU_TEST_PINS[platform].bytes)),/archive identity/);
});
test('the mandatory host VM and compiler resolve only to their verified official archive members',async()=>{
  assert.ok(process.env.ARCANE_LUAU_BIN,'Acquire the mandatory VM with scripts/luau-test-runtime.mjs --install.');
  const paths=await verifyLuauTestInstallation(dirname(process.env.ARCANE_LUAU_BIN));
  assert.equal(paths.runtime,process.env.ARCANE_LUAU_BIN);assert.equal(paths.compiler,process.env.ARCANE_LUAU_COMPILE);
  assert.equal((await lstat(paths.runtime)).isFile(),true);
});
test('a changed installed member is rejected while the original pinned installation remains intact',async t=>{
  assert.ok(process.env.ARCANE_LUAU_BIN,'Acquire the mandatory VM with scripts/luau-test-runtime.mjs --install.');
  const source=dirname(process.env.ARCANE_LUAU_BIN),pin=LUAU_TEST_PINS[process.platform];
  const owned=await mkdtemp(join(tmpdir(),'arcane-luau-member-'));
  t.after(()=>{const tail=relative(tmpdir(),owned);assert.ok(!isAbsolute(tail)&&tail.startsWith('arcane-luau-member-')&&!tail.includes('..'));return rm(owned,{recursive:true,force:true});});
  for(const name of [pin.archive,pin.runtime.name,pin.compiler.name])await copyFile(join(source,name),join(owned,name));
  const runtime=join(owned,pin.runtime.name),bytes=await readFile(runtime);bytes[bytes.length-1]^=1;await writeFile(runtime,bytes);
  await assert.rejects(verifyLuauTestInstallation(owned),/member identity/);
  assert.equal((await verifyLuauTestInstallation(source)).runtime,process.env.ARCANE_LUAU_BIN);
});
