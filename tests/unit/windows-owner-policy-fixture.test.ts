import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parsePrivateReceiptDescriptor} from '../../apps/daemon/src/workflow-private-storage.js';
import {createOwnerPolicyHost,decodeOwnerPolicyPreparation,decodeOwnerPolicyResult,ownerPolicyFixture,ownerPolicyRefusalSeam,OWNER_POLICY_FIXTURE_SHA256,OWNER_POLICY_HOST_MS,OWNER_POLICY_QUERY_MS,prepareWindowsOwnerPolicyFixture} from './windows-owner-policy-fixture.js';

const prepared={kind:'owner-policy-fixture-prepared',version:1,identities:1,creates:1,writes:1,directoryOwnerIsUser:true,directoryProtected:true,keyUnchanged:true} as const;
test('shared owner-policy metadata fixture retains its exact pre-extraction script bytes',()=>{
  assert.equal(createHash('sha256').update(ownerPolicyFixture).digest('hex'),OWNER_POLICY_FIXTURE_SHA256);
  assert.equal(OWNER_POLICY_FIXTURE_SHA256,'6bb99b1e9baf2dfc21c26ae3479846b8de73d702cc246f69f590b7e37b77738e');
});
test('preparation metadata requires every actual in-memory check and never grants a private receipt descriptor',()=>{
  assert.deepEqual(decodeOwnerPolicyPreparation(prepared),prepared);
  for(const value of [null,[],{...prepared,identities:0},{...prepared,creates:0},{...prepared,writes:0},{...prepared,directoryOwnerIsUser:false},{...prepared,directoryProtected:false},{...prepared,keyUnchanged:false},{...prepared,directoryPrivate:true}])
    assert.throws(()=>decodeOwnerPolicyPreparation(value));
  assert.throws(()=>parsePrivateReceiptDescriptor(prepared,true,false),{code:'WORKFLOW_RECEIPT_STORAGE'});
});
test('bounded Windows preparation executes exact typed metadata classes and validates their result',{skip:process.platform!=='win32',timeout:20000},()=>{
  assert.deepEqual(prepareWindowsOwnerPolicyFixture(),prepared);
});

const tail="} catch { [Console]::Error.WriteLine('Arcane private workflow storage unavailable.'); exit 1 }";
test('metadata host refusal seam is unique, terminal and exactly reversible',()=>{
  const source='try { throw "refusal" '+tail+'\n',seam=ownerPolicyRefusalSeam(source);
  assert.equal(seam.replace('throw [ArcaneOwnerFixtureRefusal]::new()','exit 1'),source);
  for(const value of [source+source,source+'# later\n',source.replace('exit 1','exit 2'),source.replace('exit 1','exit 1; exit 1')])
    assert.throws(()=>ownerPolicyRefusalSeam(value));
  assert.equal(OWNER_POLICY_HOST_MS,5000);assert.equal(OWNER_POLICY_QUERY_MS,5000);
});
test('metadata response parser binds the request and rejects unknown fields, invalid status and oversized output',()=>{
  const good={version:1,id:1,status:0,stdout:'{}',stderr:''};
  assert.deepEqual(decodeOwnerPolicyResult(good,1),{status:0,stdout:'{}',stderr:''});
  for(const value of [null,[],{...good,id:2},{...good,status:2},{...good,extra:true},{...good,stdout:'x'.repeat(2049)},{...good,stderr:'x'.repeat(8193)}])
    assert.throws(()=>decodeOwnerPolicyResult(value,1));
  assert.throws(()=>parsePrivateReceiptDescriptor(good,true,false),{code:'WORKFLOW_RECEIPT_STORAGE'});
});
function currentDouble() {
  const source=readFileSync('apps/daemon/src/workflow-private-storage.ts','utf8').replaceAll('\r\n','\n');
  const marker='const SCRIPT=String.raw`',start=source.indexOf(marker)+marker.length,end=source.indexOf('\n`;',start);
  assert.ok(start>=marker.length&&end>start);let doubled=source.slice(start,end)+'\n';
  for(const[native,fixture]of [['Security.Principal.WindowsIdentity','ArcaneOwnerFixtureIdentity'],['IO.Directory','ArcaneOwnerFixtureDirectory'],
    ['IO.File','ArcaneOwnerFixtureFile'],['IO.DirectoryInfo','ArcaneOwnerFixtureItem'],['IO.FileInfo','ArcaneOwnerFixtureItem']])
    doubled=doubled.replaceAll('['+native+']','['+fixture+']');
  return doubled;
}
const fresh={defaultOwner:'S-1-5-32-544',directoryOwner:'S-1-5-32-544',keyOwner:'S-1-5-32-544',existing:false,protected:false,
  directoryForeign:false,keyForeign:false,nonempty:false,unsafeAncestor:false,ancestorReparse:false,keyReparse:false,keyLength:32};
const metadata=(stderr:string)=>JSON.parse(stderr.split(/\r?\n/).find(row=>row.startsWith('OWNER_POLICY_METADATA_DOUBLE '))!.slice('OWNER_POLICY_METADATA_DOUBLE '.length));
test('one real Windows metadata host resets state after refusal and executes the next complete policy successfully',{skip:process.platform!=='win32',timeout:20000},async t=>{
  const source=currentDouble(),host=await createOwnerPolicyHost(source,source),pid=host.pid;
  t.after(async()=>assert.deepEqual(await host.close(),{code:0,signal:null}));
  const accepted=await host.run(fresh);assert.equal(accepted.status,0);
  assert.deepEqual(metadata(accepted.stderr),{identities:1,creates:1,writes:1,directoryOwnerIsUser:true,directoryProtected:true,directoryUnchanged:false,keyUnchanged:true});
  const refused=await host.run({...fresh,ancestorReparse:true});assert.equal(refused.status,1);assert.equal(refused.stdout,'');
  const refusal=metadata(refused.stderr);assert.equal(refusal.identities,1);assert.equal(refusal.creates,0);assert.equal(refusal.writes,0);
  assert.equal(refusal.directoryUnchanged,true);assert.equal(refusal.keyUnchanged,true);
  const again=await host.run(fresh);assert.deepEqual(again,accepted);assert.equal(host.pid,pid);
  await assert.rejects(host.run({...fresh,keyLength:100}));
  assert.deepEqual(await host.run(fresh),accepted,'Malformed local input cannot run a case or poison/reset a successful reply.');
  const inFlight=host.run(fresh);await assert.rejects(host.run(fresh),/busy/);
  assert.deepEqual(await inFlight,accepted);assert.deepEqual(await host.run(fresh),accepted,'Concurrent refusal cannot consume a request ID.');
});
test('unexpected metadata host errors and oversized case output fail closed with confirmed owned closure',{skip:process.platform!=='win32',timeout:20000},async()=>{
  for(const script of ['throw "unexpected fixture failure"\ntry { '+tail+'\n','try { [Console]::Write(("x"*2049)) '+tail+'\n']) {
    const host=await createOwnerPolicyHost(script,script);
    await assert.rejects(host.run(fresh));
    await host.close();
  }
});
test('a stalled owned metadata case keeps its five-second deadline and cannot be retried',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const script='try { [Threading.Thread]::Sleep(6000) '+tail+'\n',host=await createOwnerPolicyHost(script,script);
  await assert.rejects(host.run(fresh),/deadline exceeded/);
  await assert.rejects(host.run(fresh),/deadline exceeded/);
  await host.close();
});
