import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {scenarioPng} from '../../packages/studio-test-controller/src/scenario-image.js';
import {createStudioTestCaptureStore} from '../../apps/daemon/src/studio-test-captures.js';
import {png} from '../../packages/asset-pipeline/testing/fixture.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';
import {createStudioTestService} from '../../apps/daemon/src/studio-test-service.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {TestLedger,readTestLedger} from '../../packages/studio-test-controller/src/ledger.js';

test('bounded standard PNG validation checks bytes without treating visual content as gameplay proof',()=>{
  assert.deepEqual(scenarioPng(png()),{width:128,height:128});assert.deepEqual(scenarioPng(png(true)),{width:128,height:128});
  const crc=png();crc[40]=crc[40]!^1;
  for(const bytes of [Buffer.from('not an image'),png().subarray(0,50),Buffer.concat([png(),Buffer.from('trailing')]),crc,Buffer.alloc(2*1024*1024+1)])assert.throws(()=>scenarioPng(bytes));
});

test('capture store retains immutable unattested bytes and refuses corruption, replay and bounded-history overflow',async t=>{
  const root=makeFixtureDirectory('arcane-scenario-capture-');
  t.after(()=>{const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&!tail.startsWith('..')&&tail.startsWith('arcane-scenario-capture-'));rmSync(root,{recursive:true,force:true});});
  const store=await createStudioTestCaptureStore(root),bytes=png(),dimensions=scenarioPng(bytes),first=await store.save('owned-capture-0',bytes,dimensions);
  assert.equal(first.context,'unattested');assert.equal(first.nativeAcceptance,false);assert.deepEqual(await store.read(first),bytes);
  await assert.rejects(store.save('owned-capture-0',bytes,dimensions));
  writeFileSync(join(root,'captures','owned-capture-0.png'),png(true));await assert.rejects(store.read(first));
  // A failed allocation also consumes a slot; no retry can extend retained work.
  for(let index=2;index<64;index++)await store.save('owned-capture-'+index,bytes,dimensions);
  await assert.rejects(store.save('owned-capture-64',bytes,dimensions),/capacity/);
  const reopened=await createStudioTestCaptureStore(root);await reopened.save('last-retained-slot',bytes,dimensions);await assert.rejects(reopened.save('overflow-slot',bytes,dimensions),/capacity/);
});

test('capture initialization failure closes only its acquired healthy ledger and retains original evidence and failure',async t=>{
  for(const closeFailure of [false,true])await t.test(closeFailure?'close failure retains its writer fence':'healthy close permits legitimate ledger reopen',async sub=>{
    const root=makeFixtureDirectory('arcane-scenario-init-'),directory=join(root,'playtests'),ledgerPath=join(directory,'ledger'),lock=join(ledgerPath,'writer.lock');
    const ledgers=new Set<TestLedger>();let store:StudioStore|undefined;
    sub.after(async()=>{
      const errors:unknown[]=[];for(const ledger of ledgers){try{await ledger.close();}catch(error){errors.push(error);}}
      try{store?.close();}catch(error){errors.push(error);}
      if(errors.length||existsSync(lock))throw new AggregateError(errors,'Fixture cleanup remains fenced; temporary evidence retained.');
      const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&!tail.startsWith('..')&&tail.startsWith('arcane-scenario-init-'));rmSync(root,{recursive:true,force:true});
    });
    mkdirSync(join(directory,'captures'),{recursive:true});store=new StudioStore({directory:join(root,'store')});
    const seed=await TestLedger.open(ledgerPath,directory);ledgers.add(seed);const now=Date.now();await seed.grant('b'.repeat(64),now+60000,now,'fixture');await seed.close();
    const journal=readFileSync(join(ledgerPath,'00001.json')),retained=join(directory,'captures','retained-evidence.txt');writeFileSync(retained,'Retained capture evidence.');
    let connects=0,failedOwner:TestLedger|undefined;
    const mock=closeFailure?sub.mock.method(TestLedger.prototype,'close',async function(this:TestLedger){failedOwner=this;ledgers.add(this);throw new Error('Fixture close unavailable.');}):undefined;
    try{
      await assert.rejects(createStudioTestService({directory,store,pluginArtifactHash:'a'.repeat(64),connect:async()=>{connects++;throw new Error('No native connection during initialization.');}}),/Capture storage requires review/);
    }finally{mock?.mock.restore();}
    assert.equal(connects,0);assert.equal(readFileSync(retained,'utf8'),'Retained capture evidence.');assert.deepEqual(readFileSync(join(ledgerPath,'00001.json')),journal);
    assert.equal(existsSync(lock),closeFailure);
    if(closeFailure){assert.ok(failedOwner);await failedOwner.close();}
    const reopened=await TestLedger.open(ledgerPath,directory);ledgers.add(reopened);assert.equal((await readTestLedger(ledgerPath,directory)).length,1);await reopened.close();
  });
});
