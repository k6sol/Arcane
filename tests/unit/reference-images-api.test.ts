import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexChatApi,CodexHttpError,type ChatAction,type ChatActionRecord,type ChatState} from '../../apps/desktop/src/codex-chat.js';
import {referenceInput,referencePng} from '../../packages/codex-client/testing/reference-fixture.js';
import {referenceImageMetadata} from '../../packages/codex-client/src/reference-images.js';
const connectionId=randomUUID(),threadId='reference.thread',pair={model:'fixture',effort:'low'};
const state:ChatState={provider:'codex',use:'personal-local',projectPath:'/synthetic/reference-project',connecting:false,closing:false,busy:false,actions:[],lastSnapshot:null,nativeTools:{configured:false,verified:false},
  snapshot:{connectionId,provenance:'spawned-node-fixture',connected:true,ready:true,account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},
    selection:pair,models:[{id:'fixture',model:'fixture',displayName:'Fixture',efforts:['low'],defaultEffort:'low',entitlement:'unverified'}],
    thread:{threadId,sessionId:null,selection:pair,configured:true,writeGranted:false,turnId:null,turnStatus:'idle'},operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null}};
function input():Extract<ChatAction,{action:'turn-start'}>{return{action:'turn-start',requestId:randomUUID(),connectionId,threadId,text:'Review this reference',references:[referenceInput()]};}
function record(input:Extract<ChatAction,{action:'turn-start'}>):ChatActionRecord{return{requestId:input.requestId,action:input.action,connectionId,state:'acknowledged',errorCode:null,
  threadId,turnId:'reference.turn',model:pair.model,effort:pair.effort,createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),references:referenceImageMetadata(input.references!)};}

test('API checks exact PNG byte hash, dimensions, length and order, with no raw media in state',async()=>{
  const original=input();let sent=0;
  const api=new CodexChatApi('a'.repeat(64),(async(url,init)=>{sent++;assert.equal(url,'/v1/codex/reference-turn');assert.deepEqual(JSON.parse(String(init?.body)),original);
    return Response.json({record:record(original),state,replayed:false});})as typeof fetch);
  const result=await api.action(original);assert.equal(sent,1);assert.deepEqual(result.record.references,referenceImageMetadata(original.references!));
  assert.ok(!JSON.stringify(result).includes('data:image/'));
});
for(const key of ['sha256','bytes','width','height','order']as const)test('same-name image ACK with wrong '+key+' remains unknown',async()=>{
  const original=input();original.references=[...original.references!,referenceInput(referencePng(64,128),'second.png')];
  const receipt=structuredClone(record(original)),rows=receipt.references! as {name:string;sha256:string;bytes:number;width:number;height:number}[];
  if(key==='order'){const first=rows[0]!,second=rows[1]!;[first.sha256,second.sha256]=[second.sha256,first.sha256];}
  else if(key==='sha256')rows[0]!.sha256='f'.repeat(64);else rows[0]![key]++;
  const api=new CodexChatApi('a'.repeat(64),(async()=>Response.json({record:receipt,state,replayed:false}))as typeof fetch);
  await assert.rejects(()=>api.action(original),error=>error instanceof CodexHttpError&&error.unknown&&/original reference bytes/.test(error.message));
});

test('original PNG metadata cannot validate a foreign-thread acknowledgement',async()=>{
  const original=input(),receipt={...record(original),threadId:'foreign.thread'};
  const api=new CodexChatApi('a'.repeat(64),(async()=>Response.json({record:receipt,state,replayed:false}))as typeof fetch);
  await assert.rejects(()=>api.action(original),error=>error instanceof CodexHttpError&&error.unknown&&/exact thread/.test(error.message));
});
test('input mutation during WebCrypto cannot alter original submitted reference bytes or scope',async()=>{
  const original=input(),expected=structuredClone(original);
  const api=new CodexChatApi('a'.repeat(64),(async(_url,init)=>{assert.deepEqual(JSON.parse(String(init?.body)),expected);return Response.json({record:record(expected),state,replayed:false});})as typeof fetch);
  const pending=api.action(original);(original.references![0]as {name:string;dataUrl:string}).dataUrl='file:///foreign.png';original.text='changed after Send';original.threadId='foreign';
  assert.equal((await pending).record.state,'acknowledged');
});
test('cancelled image hash preparation sends no HTTP request',async()=>{
  const controller=new AbortController();controller.abort();let sent=0;
  const api=new CodexChatApi('a'.repeat(64),(async()=>{sent++;throw new Error('No HTTP permitted');})as typeof fetch);
  await assert.rejects(()=>api.action(input(),controller.signal),error=>error instanceof CodexHttpError&&!error.unknown&&/No message was sent/.test(error.message));
  assert.equal(sent,0);
});

test('cancellation while the actual image digest awaits never reaches HTTP',async t=>{
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{entered();await gate;return digest(...args);});
  let sent=0;const controller=new AbortController();
  const api=new CodexChatApi('a'.repeat(64),(async()=>{sent++;throw new Error('No HTTP permitted');})as typeof fetch);
  const pending=api.action(input(),controller.signal);await started;controller.abort();release();
  await assert.rejects(pending,error=>error instanceof CodexHttpError&&!error.unknown&&/No message was sent/.test(error.message));
  assert.equal(sent,0);
});
