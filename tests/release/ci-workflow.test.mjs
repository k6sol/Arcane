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
function jobs(document=source) {
  const starts=[...document.matchAll(/^jobs:\n/gm)];assert.equal(starts.length,1,'One explicit jobs mapping is required.');
  const body=document.slice(starts[0].index+'jobs:\n'.length);
  for(const line of body.split('\n'))if(/^  [^\s#]/.test(line))assert.match(line,/^  [a-z][a-z0-9-]*:$/,'Use explicit named job blocks.');
  const headers=[...body.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  return headers.map((header,index)=>({name:header[1],body:body.slice(header.index,headers[index+1]?.index)}));
}
function job(name,document=source) {
  const matches=jobs(document).filter(value=>value.name===name);assert.equal(matches.length,1,'Missing or duplicate job: '+name);return matches[0].body;
}
const local=job('local-contracts');
function step(name,scope=local) {
  const at=scope.indexOf('      - name: '+name+'\n');assert.notEqual(at,-1,'Missing required verification step: '+name);
  const end=scope.indexOf('\n      - name: ',at+1);return scope.slice(at,end<0?undefined:end)+'\n';
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
  assert.deepEqual([...local.matchAll(/^    timeout-minutes: (\d+)$/gm)].map(match=>Number(match[1])),[35]);
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
  assert.equal([...local.matchAll(/^        run: npm run build$/gm)].length,1,'Each lane builds once before compiled tests.');
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


function packagedContract(document) {
  assert.deepEqual(jobs(document).map(value=>value.name),['local-contracts','packaged-desktop'],'The component smoke is one additional post-matrix job.');
  const matrix=job('local-contracts',document),packaged=job('packaged-desktop',document);
  assert.match(packaged,/^    needs: local-contracts$/m);
  assert.equal([...packaged.matchAll(/^    needs:/gm)].length,1);
  assert.doesNotMatch(packaged,/^    (?:if|continue-on-error|strategy):/m,'No condition, failure bypass or extra matrix may weaken the prerequisite.');
  assert.doesNotMatch(packaged,/^\s*continue-on-error:/m);
  assert.match(packaged,/^    runs-on: windows-latest$/m);
  assert.deepEqual([...packaged.matchAll(/^    timeout-minutes: (\d+)$/gm)].map(match=>Number(match[1])),[25]);
  const names=['Check out tested source without persistent Git credentials','Install Node 24',
    'Install pinned dependencies without lifecycle scripts','Build tested product','Build modular Studio plugin artifacts',
    'Verify isolated packaged desktop startup and shutdown','Retain bounded packaged desktop evidence'];
  assert.deepEqual([...packaged.matchAll(/^      - name: ([^\n]+)$/gm)].map(match=>match[1]),names,'Tooling, fresh builds, one smoke and bounded evidence must stay in order.');
  assert.equal([...packaged.matchAll(/^      - /gm)].length,names.length,'No unnamed or replay steps.');
  for(const name of names.slice(0,-1))assert.doesNotMatch(step(name,packaged),/^        if:/m,'Mandatory packaged prerequisite: '+name);
  const checkout=step(names[0],packaged),node=step(names[1],packaged);
  for(const [body,original,pin]of [
    [checkout,step('Check out source without persistent Git credentials',matrix),'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'],
    [node,step('Install Node 24',matrix),'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'],
  ]){
    const uses=value=>[...value.matchAll(/^        uses: (\S+)(?: #.*)?$/gm)].map(match=>match[1]);
    assert.deepEqual(uses(body),[pin]);assert.deepEqual(uses(original),[pin]);
  }
  assert.match(checkout,/^          persist-credentials: false$/m);
  assert.match(node,/^          node-version: '24'$/m);assert.match(node,/^          cache-dependency-path: package-lock.json$/m);
  for(const [name,command]of [[names[2],'npm ci --ignore-scripts --no-audit --no-fund'],[names[3],'npm run build'],
    [names[4],'npm run build:plugin'],[names[5],'node scripts/check-packaged-component-ci.mjs']])
    assert.deepEqual([...step(name,packaged).matchAll(/^        run: (.+)$/gm)].map(match=>match[1]),[command]);
  assert.equal([...packaged.matchAll(/^        run: npm run build$/gm)].length,1,'The component job makes its own single fresh product build.');
  assert.equal([...packaged.matchAll(/^        run: npm run build:plugin$/gm)].length,1);
  assert.equal([...document.matchAll(/^        run: node scripts\/check-packaged-component-ci\.mjs$/gm)].length,1,'The actual native driver is invoked once, after the full matrix.');
  assert.match(step(names[5],packaged),/^        id: native-smoke$/m);
  const upload=step(names[6],packaged);
  assert.ok(upload.includes("        if: ${{ always() && steps.native-smoke.outcome != 'skipped' && steps.native-smoke.outcome != '' }}\n"));
  assert.match(upload,/^        uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7\.0\.2$/m);
  assert.equal([...packaged.matchAll(/^        uses: actions\/upload-artifact@/gm)].length,1);
  assert.ok(upload.includes('          name: arcane-windows-component-${{ github.sha }}-${{ github.run_attempt }}\n'));
  assert.equal([...upload.matchAll(/^          path:/gm)].length,1);
  const paths=upload.match(/^          path: \|\n((?:            [^\n]+\n)+)/m)?.[1];assert.ok(paths,'An explicit artifact path block is required.');
  assert.deepEqual(paths.trimEnd().split('\n').map(line=>line.slice(12)),[
    'progress.json','success.json','failure.json','toolchain.json','package-proof.json','windows-manifest.json',
    'verification.json','process-outcome.json','mcp-runtime.json','app-checks.json','workspace.png','app-error.json',
  ].map(name=>'runtime/ci-desktop-smoke-artifacts/'+name));
  assert.doesNotMatch(paths,/\*|\.\.|profile|\.zip|\.exe/);
  assert.match(upload,/^          if-no-files-found: error$/m);assert.match(upload,/^          retention-days: 7$/m);
}

test('packaged desktop observes the tested revision only after the full matrix, with bounded fixed evidence',()=>{
  packagedContract(source);
});

test('packaged workflow contract rejects prerequisite bypass, replay, reordered builds and broad evidence',()=>{
  const alterations=[
    ['    needs: local-contracts\n','    needs: []\n'],
    ['    needs: local-contracts\n','    needs: local-contracts\n    if: always()\n'],
    ['    needs: local-contracts\n','    needs: local-contracts\n    continue-on-error: true\n'],
    ['    timeout-minutes: 25\n','    timeout-minutes: 35\n'],
    ['      - name: Build tested product\n        run: npm run build\n      - name: Build modular Studio plugin artifacts\n        run: npm run build:plugin\n',
      '      - name: Build modular Studio plugin artifacts\n        run: npm run build:plugin\n      - name: Build tested product\n        run: npm run build\n'],
    ['        id: native-smoke\n','        id: native-smoke\n        if: false\n'],
    ['        run: node scripts/check-packaged-component-ci.mjs\n','        run: node scripts/check-packaged-component-ci.mjs\n        run: node scripts/check-packaged-component-ci.mjs\n'],
    ['runtime/ci-desktop-smoke-artifacts/workspace.png','runtime/ci-desktop-smoke-artifacts/**'],
    ["if: ${{ always() && steps.native-smoke.outcome != 'skipped' && steps.native-smoke.outcome != '' }}",'if: ${{ always() }}'],
    ['uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9','uses: actions/upload-artifact@v7'],
    ['          retention-days: 7\n','          retention-days: 30\n'],
  ];
  for(const [before,after]of alterations){assert.ok(source.includes(before),'Mutation must target actual workflow bytes.');
    assert.throws(()=>packagedContract(source.replace(before,after)),assert.AssertionError);}
  assert.throws(()=>packagedContract(source+'  extra-job:\n    runs-on: windows-latest\n'),assert.AssertionError);
});
