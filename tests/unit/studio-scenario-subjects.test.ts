import test from 'node:test';
import assert from 'node:assert/strict';
import {scenarioSubjectDigest,scenarioSubjectProgram} from '../../apps/daemon/src/studio-test-subjects.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';

const expected={sessionId:'paired-subjects',clientLifetimeId:'plugin-original',pluginArtifactHash:'a'.repeat(64),allowedRoots:['Workspace','ServerStorage']as const};
const entry=(identity:string)=>({root:'Workspace',path:['GameScript'],identity,className:'Script',enabled:true,source:'print("persisted")',editorSource:'print("editor buffer")'});
const snapshot=()=>({schemaVersion:1,sessionId:expected.sessionId,clientLifetimeId:expected.clientLifetimeId,pluginArtifactHash:expected.pluginArtifactHash,nodes:4,sourceCount:2,sources:{s1:entry('original-script-one'),s2:entry('original-script-two')}});
const result=(value:unknown):CallToolResult=>({content:[{type:'text',text:JSON.stringify(value)}]});

test('host subject digest binds exact persisted/editor bytes, observed identities, enable state and applied receipts independently of traversal order',()=>{
  const original=snapshot(),receipts=[{id:'applied-command',method:'script.update',result:{afterSourceHash:'b'.repeat(64)}}];
  const hash=scenarioSubjectDigest(result(original),expected,receipts),reordered={...original,sources:{s1:original.sources.s2,s2:original.sources.s1}};
  assert.equal(scenarioSubjectDigest(result(reordered),expected,receipts),hash);
  for(const change of [
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.editorSource+=' -- unsaved';},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.source+=' -- saved';},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.enabled=false;},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.identity='replacement-script';},
  ]){const value=snapshot();change(value);assert.notEqual(scenarioSubjectDigest(result(value),expected,receipts),hash);}
  assert.notEqual(scenarioSubjectDigest(result(original),expected,[]),hash);
});

test('host subject decoding refuses missing mapping, impossible counts, duplicate identities, out-of-scope roots and oversized source evidence',()=>{
  const mutations=[
    (value:ReturnType<typeof snapshot>)=>{value.clientLifetimeId='replacement-plugin';},
    (value:ReturnType<typeof snapshot>)=>{value.sourceCount=1;},
    (value:ReturnType<typeof snapshot>)=>{value.nodes=1;},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s2.identity=value.sources.s1.identity;},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.root='ServerScriptService';},
    (value:ReturnType<typeof snapshot>)=>{value.sources.s1.editorSource='a'.repeat(32769);},
    (value:ReturnType<typeof snapshot>)=>{Object.assign(value.sources.s1,{verified:true});},
  ];
  for(const mutate of mutations){const value=snapshot();mutate(value);assert.throws(()=>scenarioSubjectDigest(result(value),expected,[]));}
  assert.throws(()=>scenarioSubjectDigest({isError:true,...result(snapshot())},expected,[]));
  assert.throws(()=>scenarioSubjectDigest({content:[...result(snapshot()).content,{type:'text',text:'unbound source'}]},expected,[]));
  assert.throws(()=>scenarioSubjectProgram('ArcaneTestProof_valid\n',['Workspace']));
  assert.throws(()=>scenarioSubjectProgram('ArcaneTestProof_valid',[]));
});
