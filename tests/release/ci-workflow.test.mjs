import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {nativeMetadataJsonSetup} from '../unit/windows-private-permission-fixture.ts';

const source=readFileSync(new URL('../../.github/workflows/verify.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
const block=source.match(/^concurrency:\n((?:[ \t]+[^\n]*\n)+)/m)?.[1]??'';
const expression=block.match(/^  group: (.+)$/m)?.[1]??'';
const group=values=>expression.replace(/\$\{\{\s*github\.(workflow|ref|sha)\s*\}\}/g,(_,name)=>values[name]);
const localTest=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).scripts.test.split(' && ');
function step(name) {
  const at=source.indexOf('      - name: '+name+'\n');assert.notEqual(at,-1,'Missing required verification step: '+name);
  const end=source.indexOf('\n      - name: ',at+1);return source.slice(at,end<0?undefined:end)+'\n';
}
function lane(name,suite,command) {
  const body=step(name);assert.ok(body.includes("        if: matrix.suite == '"+suite+"'\n"));
  assert.ok(body.includes('        run: '+command+'\n'),name+' must run its complete inventory.');
}

test('verification gives each pushed revision an independent concurrency group',()=>{
  for(const name of ['workflow','ref','sha'])assert.ok(expression.includes('${{ github.'+name+' }}'));
  const branch={workflow:'Verify Arcane local components',ref:'refs/heads/main'};
  assert.notEqual(group({...branch,sha:'a'.repeat(40)}),group({...branch,sha:'b'.repeat(40)}));
  assert.equal(group({...branch,sha:'a'.repeat(40)}),group({...branch,sha:'a'.repeat(40)}));
});

test('a new update cannot cancel an already running verification',()=>{
  assert.match(block,/^  cancel-in-progress: false$/m);
  assert.match(source,/os: \[ubuntu-latest, windows-latest\]/);
  assert.match(source,/^      fail-fast: false$/m);
  assert.deepEqual([...source.matchAll(/^    timeout-minutes: (\d+)$/gm)].map(match=>Number(match[1])),[25]);
});

test('both native unit shards and the full release lane preserve the existing verification inventory',()=>{
  assert.match(source,/^        suite: \[unit-1, unit-2, release\]$/m);
  assert.match(source,/name: Local contracts \(\$\{\{ matrix.os \}\}, \$\{\{ matrix.suite \}\}\)/);
  assert.doesNotMatch(source,/^\s*(?:exclude|continue-on-error):|--test-(?:skip|only|name-pattern)/m);
  assert.deepEqual([...source.matchAll(/--test-shard=(\S+)/g)].map(match=>match[1]),['1/2','2/2']);
  assert.equal(localTest[0],'npm run build');
  assert.equal(localTest[1],'node --test --test-concurrency=1 dist/tests/unit/*.test.js');
  for(const shard of [1,2])lane('Test complete unit inventory shard '+shard+' of 2','unit-'+shard,
    localTest[1].replace(' dist/tests/unit/',' --test-shard='+shard+'/2 dist/tests/unit/'));
  lane('Test offline skill contracts','release',localTest[2]);
  lane('Test release contracts','release',localTest[3]);
  lane('Build deterministic Studio plugin','release','npm run build:plugin');
  lane('Verify deterministic Studio plugin artifacts','release','node scripts/build-plugin.mjs --check');
  lane('Test deterministic Studio plugin','release','npm run test:plugin');
  lane('Validate actual skill file integrity','release','node scripts/skill-pack.mjs validate');
});

test('every lane builds after pinned tooling and retains the Windows private-owner preflight',()=>{
  const prerequisites=[['Install pinned dependencies without lifecycle scripts','npm ci --ignore-scripts --no-audit --no-fund'],
    ['Acquire and verify pinned standalone Luau for mandatory VM tests','node scripts/luau-test-runtime.mjs --install --github-env'],
    ['Strict type checking','npm run typecheck'],['Build product for the selected inventory','npm run build']];
  let previous=-1;
  for(const[name,command]of prerequisites){const body=step(name);assert.doesNotMatch(body,/^        if:/m);assert.ok(body.includes('        run: '+command+'\n'));
    const at=source.indexOf(body);assert.ok(at>previous);previous=at;}
  const owner=step('Verify private storage on Windows');assert.match(owner,/^        if: runner.os == 'Windows'$/m);
  assert.match(owner,/node --test --test-concurrency=1 dist\/tests\/unit\/workflow-normal-owner.test.js dist\/tests\/unit\/workflow-permission-equivalence.test.js/);
  assert.ok(source.indexOf(owner)>previous);assert.ok(source.indexOf(owner)<source.indexOf(step('Test complete unit inventory shard 1 of 2')));
  assert.equal([...source.matchAll(/^        run: npm run build$/gm)].length,1,'Each lane builds once before compiled tests.');
});

test('Windows warmup includes the exact read-only diagnostic serializer before bounded permission probes',()=>{
  const warm=step('Warm the trusted Windows permission host'),normalize=value=>value.replaceAll('"',"'").replace(/\s+/g,'');
  assert.match(warm,/^        if: runner.os == 'Windows'$/m);
  assert.ok(warm.includes('$ErrorActionPreference="Stop";'),'Native preparation errors must stop the warm process.');
  for(const line of nativeMetadataJsonSetup.trim().split('\n'))assert.ok(normalize(warm).includes(normalize(line)),'Warmup must cover diagnostic setup: '+line);
  assert.ok(warm.includes('$nativeJson.Serialize('));assert.ok(warm.includes('[Security.Principal.WindowsIdentity]::GetCurrent()'));
  assert.ok(warm.includes('[IO.Directory]::GetAccessControl($env:SystemRoot)'));assert.ok(warm.includes('$acl.GetAccessRules('));
  assert.doesNotMatch(warm,/SetAccessControl|Set-Acl|SetOwner|CreateDirectory|SetTokenInformation|AdjustTokenPrivileges/);
  assert.ok(source.indexOf(warm)<source.indexOf(step('Verify private storage on Windows')));
  assert.match(warm,/if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
});

test('bounded Windows metadata-fixture preparation follows build without replacing any native policy check',()=>{
  const prepare=step('Prepare Windows owner policy metadata fixture');
  assert.match(prepare,/^        if: runner.os == 'Windows'$/m);
  assert.match(prepare,/^        timeout-minutes: 1$/m);
  assert.match(prepare,/^        run: node scripts\/prepare-windows-owner-policy-fixture.mjs$/m);
  assert.ok(source.indexOf(prepare)>source.indexOf(step('Build product for the selected inventory')));
  assert.ok(source.indexOf(prepare)<source.indexOf(step('Verify private storage on Windows')));
  assert.equal([...source.matchAll(/run: node scripts\/prepare-windows-owner-policy-fixture.mjs/g)].length,1);
  const native=readFileSync(new URL('../../tests/unit/workflow-permission-equivalence.test.ts',import.meta.url),'utf8');
  assert.match(native,/timeout: 30_000/);
  const fixture=readFileSync(new URL('../../tests/unit/windows-owner-policy-fixture.ts',import.meta.url),'utf8');
  assert.match(fixture,/OWNER_POLICY_HOST_MS = 5_000, OWNER_POLICY_QUERY_MS = 5_000/);
  assert.equal([...native.matchAll(/await createOwnerPolicyHost\(/g)].length,1,'The metadata matrix reuses one test-only host.');
  assert.match(native,/await host.run\(scenario.value\)/);assert.match(native,/await host.run\(scenario.value,'previous'\)/);
  assert.match(native,/for \(const scenario of cases\)/);
  assert.match(native,/for \(const scenario of \[cases\[0\]!, cases\[14\]!\]\)/);
});

test('native Node shards execute a disjoint exhaustive union of the same actual fixture glob',t=>{
  const boundary=realpathSync.native(tmpdir()),directory=realpathSync.native(mkdtempSync(join(boundary,'arcane-ci-shards-'))),markers=join(directory,'cases.txt');
  t.after(()=>{assert.equal(dirname(resolve(directory)),boundary);assert.ok(directory.startsWith(join(boundary,'arcane-ci-shards-')));rmSync(directory,{recursive:true,force:true});});
  const expected=[];
  for(let file=0;file<7;file++){
    const cases=Array.from({length:file%3+1},(_,index)=>'fixture-'+file+'-'+index);expected.push(...cases);
    writeFileSync(join(directory,file+'.test.mjs'),"import test from 'node:test';import {appendFileSync} from 'node:fs';\n"+
      cases.map(id=>'test('+JSON.stringify(id)+',()=>appendFileSync('+JSON.stringify(markers)+','+JSON.stringify(id+'\n')+'));').join('\n'));
  }
  const glob=join(directory,'*.test.mjs').replaceAll('\\','/');
  // Start a real standalone CLI, not another child of the enclosing test runner.
  const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
  const execute=shard=>{writeFileSync(markers,'');const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...(shard?['--test-shard='+shard]:[]),glob],
    {cwd:directory,env:environment,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    return readFileSync(markers,'utf8').trim().split('\n').filter(Boolean).sort();};
  const complete=execute(),first=execute('1/2'),second=execute('2/2');assert.deepEqual(complete,expected.sort());
  assert.ok(first.length>0&&second.length>0);assert.deepEqual(first.filter(id=>second.includes(id)),[]);
  assert.deepEqual([...first,...second].sort(),complete,'Both native shards must cover every case once.');
});
