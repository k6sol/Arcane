import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppAssetHumanSelection,snapshotAppAssetHumanSelection} from '../../apps/daemon/src/app-asset-human-selection.js';
import type {NativeConversation} from '../../packages/storage/src/conversation-work-store.js';

const conversationId='5238120b-424e-4ada-82fd-04f242d1e873';
test('human selection accepts only empty, owned Codex lookup or a whole app conversation identity',()=>{
 assert.equal(snapshotAppAssetHumanSelection(null),null);
 assert.deepEqual(snapshotAppAssetHumanSelection({provider:'codex'}),{provider:'codex'});
 assert.deepEqual(snapshotAppAssetHumanSelection({provider:'claude-code',conversationId}),{provider:'claude-code',conversationId});
 let getterReads=0,proxyReads=0;
 const getter=Object.defineProperty({},'provider',{enumerable:true,get(){getterReads++;return 'codex';}});
 const proxy=new Proxy({provider:'codex'},{getOwnPropertyDescriptor(){proxyReads++;throw Error('must not run');}});
 for(const value of [undefined,{},[],getter,proxy,{provider:'codex',conversationId},{provider:'claude-code',conversationId:null},{provider:'arcane',conversationId:conversationId+'\n'},{provider:'claude',conversationId},{provider:'arcane',conversationId,permission:true}])assert.throws(()=>snapshotAppAssetHumanSelection(value));
 assert.equal(getterReads,0);assert.equal(proxyReads,0);
});

test('an empty draft never inherits Codex and A-empty-A always has a distinct private epoch',()=>{
 const codex:NativeConversation={provider:'codex',threadId:'owned-thread',sessionId:null};
 const selection=createAppAssetHumanSelection({codexConversation:()=>codex});
 assert.deepEqual(selection.current(),codex);
 selection.select({provider:'claude-code',conversationId});const first=selection.epoch();
 assert.deepEqual(selection.current(),{provider:'claude-code',threadId:'app:'+conversationId,sessionId:null});
 selection.select(null);const empty=selection.epoch();assert.equal(selection.current(),null);assert.notEqual(empty,first);
 selection.select({provider:'claude-code',conversationId});assert.notEqual(selection.epoch(),first);assert.notEqual(selection.epoch(),empty);
 const latest=selection.epoch();selection.select({provider:'claude-code',conversationId});assert.notEqual(selection.epoch(),latest,'a new explicit intent never reuses an old epoch');
 selection.select({provider:'arcane',conversationId});assert.equal(selection.current()?.provider,'arcane');
});

test('Codex identity comes from the trusted reader and invalid input cannot change the current selection',()=>{
 let current:NativeConversation|null={provider:'codex',threadId:'first-thread',sessionId:'first-session'};
 const selection=createAppAssetHumanSelection({codexConversation:()=>current});
 selection.select({provider:'codex'});assert.deepEqual(selection.current(),current);
 current={provider:'codex',threadId:'other-thread',sessionId:null};assert.deepEqual(selection.current(),current);
 current=null;assert.equal(selection.current(),null);
 selection.select({provider:'arcane',conversationId});const epoch=selection.epoch(),scope=selection.current();
 assert.throws(()=>selection.select({provider:'codex',threadId:'forged'}));assert.equal(selection.epoch(),epoch);assert.deepEqual(selection.current(),scope);
 assert.equal(Object.isFrozen(scope),true);
});

test('closing selection invalidates held guards and cannot revive context',()=>{
 const selection=createAppAssetHumanSelection({codexConversation:()=>({provider:'codex',threadId:'owned',sessionId:null})});
 const held=selection.epoch();selection.close();assert.notEqual(selection.epoch(),held);assert.equal(selection.current(),null);
 const closedEpoch=selection.epoch();selection.close();assert.equal(selection.epoch(),closedEpoch);
 assert.throws(()=>selection.select({provider:'arcane',conversationId}));assert.equal(selection.current(),null);
});
