import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveScenarioFixtureRuntime} from '../../packages/studio-test-controller/testing/luau-runtime.js';

test('scenario VM resolution requires one explicit matching verified runtime/compiler installation',()=>{
  const runtime=process.env.ARCANE_LUAU_BIN,compiler=process.env.ARCANE_LUAU_COMPILE;
  assert.ok(runtime,'Acquire the mandatory VM with scripts/luau-test-runtime.mjs --install.');assert.ok(compiler);
  assert.equal(resolveScenarioFixtureRuntime({ARCANE_LUAU_BIN:runtime,ARCANE_LUAU_COMPILE:compiler}),runtime);
  for(const env of [{},{ARCANE_LUAU_BIN:runtime},{ARCANE_LUAU_BIN:basename(runtime),ARCANE_LUAU_COMPILE:compiler},
    {ARCANE_LUAU_BIN:runtime,ARCANE_LUAU_COMPILE:join(dirname(compiler),'foreign',basename(compiler))}])
    assert.throws(()=>resolveScenarioFixtureRuntime(env),/VM\/compiler are required/);
});

test('scenario VM resolution checks compiler content as well as interpreter content before execution',t=>{
  const runtime=process.env.ARCANE_LUAU_BIN,compiler=process.env.ARCANE_LUAU_COMPILE;
  assert.ok(runtime,'Acquire the mandatory VM with scripts/luau-test-runtime.mjs --install.');assert.ok(compiler);
  const root=realpathSync(tmpdir()),owned=mkdtempSync(join(root,'arcane-luau-resolver-'));
  t.after(()=>{const tail=relative(root,owned);assert.ok(!isAbsolute(tail)&&tail.startsWith('arcane-luau-resolver-')&&!tail.includes('..'));rmSync(owned,{recursive:true,force:true});});
  const localRuntime=join(owned,basename(runtime)),localCompiler=join(owned,basename(compiler));
  copyFileSync(runtime,localRuntime);copyFileSync(compiler,localCompiler);
  const env={ARCANE_LUAU_BIN:localRuntime,ARCANE_LUAU_COMPILE:localCompiler};
  assert.equal(resolveScenarioFixtureRuntime(env),localRuntime);
  const changed=readFileSync(localCompiler);changed[changed.length-1]!^=1;writeFileSync(localCompiler,changed);
  assert.throws(()=>resolveScenarioFixtureRuntime(env),/hash differs/);
  assert.equal(resolveScenarioFixtureRuntime({ARCANE_LUAU_BIN:runtime,ARCANE_LUAU_COMPILE:compiler}),runtime);
});
