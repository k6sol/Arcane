import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePrivateReceiptDescriptor} from '../../apps/daemon/src/workflow-private-storage.js';

const descriptor = () => ({version:1,created:false,directoryPrivate:true,keyPrivate:true,ancestorsSafe:true});
test('private receipt descriptor requires exact native positive proof without truthy/coerced fields',()=>{
  assert.deepEqual(parsePrivateReceiptDescriptor(descriptor(),false,true),descriptor());
  assert.deepEqual(parsePrivateReceiptDescriptor({...descriptor(),created:true},true,true),{...descriptor(),created:true});
  assert.deepEqual(parsePrivateReceiptDescriptor({...descriptor(),keyPrivate:false},true,false),{...descriptor(),keyPrivate:false});
  for(const value of [null,[],true,'private',{},Object.create({version:1}),{...descriptor(),extra:true},{...descriptor(),version:'1'},{...descriptor(),created:1},{...descriptor(),directoryPrivate:1},{...descriptor(),keyPrivate:1},{...descriptor(),ancestorsSafe:false},{...descriptor(),created:true}]) {
    assert.throws(()=>parsePrivateReceiptDescriptor(value,false,true),{code:'WORKFLOW_RECEIPT_STORAGE'});
  }
  assert.throws(()=>parsePrivateReceiptDescriptor({...descriptor(),keyPrivate:false},true,true),{code:'WORKFLOW_RECEIPT_STORAGE'});
});
test('accessor descriptor is refused without evaluating its private diagnostic getter',()=>{
  let reads=0;const input=descriptor();Object.defineProperty(input,'keyPrivate',{enumerable:true,get(){reads++;throw Error('PRIVATE-DIAGNOSTIC');}});
  assert.throws(()=>parsePrivateReceiptDescriptor(input,false,true),error=>{
    assert.equal((error as Error).message.includes('PRIVATE-DIAGNOSTIC'),false);return (error as {code:string}).code==='WORKFLOW_RECEIPT_STORAGE';
  });
  assert.equal(reads,0);
});
