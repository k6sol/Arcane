import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parsePrivateReceiptDescriptor} from '../../apps/daemon/src/workflow-private-storage.js';
import {decodeOwnerPolicyPreparation,ownerPolicyFixture,OWNER_POLICY_FIXTURE_SHA256,prepareWindowsOwnerPolicyFixture} from './windows-owner-policy-fixture.js';

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
