import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex } from './native-fixture-refusal.js';
import { READ_METHODS, WRITE_METHODS, type StudioCommand } from '../../packages/protocol/src/studio.js';
import type { ScriptSourceVerifier, ScriptSourceVerification } from '../../packages/core/src/script-source-verifier.js';

const proof = (source: string): ScriptSourceVerification => ({sourceSha256:createHash('sha256').update(source).digest('hex'),compilerSha256:'a'.repeat(64),syntaxVerified:true,elapsedMs:1});
async function fixture(t: test.TestContext, verifier?: ScriptSourceVerifier) {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'arcane-script-http-'));
  const store = new StudioStore({ directory });
  const app = await createConnectionLab({cwd:resolve('.'),stateDirectory:join(directory,'preferences'),studioStore:store,probe:async()=>[],codexConnect:refuseNativeCodex,...(verifier ? {scriptSourceVerifier:verifier} : {})});
  t.after(async()=>{await app.close();store.close();const p=relative(parent,directory);assert.ok(p.startsWith('arcane-script-http-')&&!p.includes(sep));await rm(directory,{recursive:true,force:true});});
  const grant = store.createGrant({allowedRoots:['Workspace'],allowWrites:true});
  const pair = store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'synthetic-http-not-native-Studio',placeId:0,universeId:0,name:'TEST FIXTURE',pluginVersion:'fixture'},capabilities:[...READ_METHODS,...WRITE_METHODS]});
  const ref = {instanceId:'opaque-script',sessionId:pair.sessionId,root:'Workspace',pathSegments:['Script'],className:'Script'};
  const input = {sessionId:pair.sessionId,requestId:'activation-http-001',method:'script.set_enabled',args:{ref,expectedSource:'print("fixture")',expectedEnabled:false,enabled:true}};
  const post = (path:string,body:unknown,token=app.agentToken,signal?:AbortSignal) => fetch(app.origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),...(signal ? {signal} : {})});
  return {store,app,pair,ref,input,post};
}

test('HTTP refuses caller syntax claims and unavailable verifier; disable needs no compiler', async t=>{
  const f = await fixture(t);
  for(const args of [f.input.args,{...f.input.args,syntaxVerified:true}]) {
    const response = await f.post('/v1/studio/commands',{...f.input,args});
    assert.equal(response.status,400); assert.equal(f.store.commands().length,0);
  }
  const disabled = await f.post('/v1/studio/commands',{...f.input,args:{...f.input.args,expectedEnabled:true,enabled:false}});
  assert.equal(disabled.status,200); assert.equal(f.store.commands().length,1);
});

test('HTTP routes exact verified source through durable queue, receipt and restore without a second compile', async t=>{
  let calls = 0;
  const f = await fixture(t,{verify:async source=>{calls++;return proof(source);},dispose(){}});
  const response = await f.post('/v1/studio/commands',f.input); assert.equal(response.status,200);
  const command = (await response.json() as {command:StudioCommand}).command;
  assert.equal(command.method,'script.set_enabled');assert.equal(calls,1);
  assert.equal((await f.post('/v1/studio/commands',f.input)).status,200);assert.equal(calls,1);
  const polled = await f.post('/v1/plugin/poll',{sessionId:f.pair.sessionId},f.pair.token);
  assert.equal((await polled.json() as {commands:StudioCommand[]}).commands[0]?.id,command.id);
  const result = {ref:f.ref,mutation:{kind:'script.set_enabled',ref:f.ref,before:{source:f.input.args.expectedSource,enabled:false},after:{source:f.input.args.expectedSource,enabled:true}}};
  const acknowledged = await f.post('/v1/plugin/result',{sessionId:f.pair.sessionId,commandId:command.id,state:'succeeded',result},f.pair.token);
  assert.equal(acknowledged.status,200);
  const restore = await f.post('/v1/studio/restore',{commandId:command.id,requestId:'restore-http-001'});
  assert.equal(restore.status,200);assert.equal(calls,1);assert.equal((await restore.json() as {command:StudioCommand}).command.method,'scene.restore');
  assert.ok(f.store.events().some(e=>e&&typeof e==='object'&&!Array.isArray(e)&&e.kind==='script_syntax_verified'));
});

test('HTTP syntax failure publishes neither command nor raw diagnostics', async t=>{
  const f = await fixture(t,{verify:async()=>{throw new Error('private source/compiler/token diagnostic');},dispose(){}});
  const response = await f.post('/v1/studio/commands',f.input);
  assert.equal(response.status,400);assert.equal(f.store.commands().length,0);
  assert.ok(!(await response.text()).includes('private source/compiler/token'));
});

test('HTTP authority revoked during awaited verification cannot activate', async t=>{
  let finish!:()=>void, entered!:()=>void;
  const ready = new Promise<void>(r=>{entered=r;}), pending = new Promise<void>(r=>{finish=r;});
  t.after(()=>finish());
  const f = await fixture(t,{verify:async source=>{entered();await pending;return proof(source);},dispose(){}});
  const activation = f.post('/v1/studio/commands',f.input); await ready;
  assert.equal(f.store.commands().length,0);
  assert.equal((await f.post('/v1/studio/revoke',{sessionId:f.pair.sessionId},f.app.token)).status,200);
  finish();assert.equal((await activation).status,409);assert.equal(f.store.commands().length,0);
});

test('HTTP disconnected caller cannot publish a later activation', async t=>{
  let finish!:()=>void, entered!:()=>void;
  const ready = new Promise<void>(r=>{entered=r;}), pending = new Promise<void>(r=>{finish=r;});
  t.after(()=>finish());
  const f = await fixture(t,{verify:async source=>{entered();await pending;return proof(source);},dispose(){}});
  const abort = new AbortController();
  const activation = f.post('/v1/studio/commands',f.input,f.app.agentToken,abort.signal).catch(()=>null);
  await ready;abort.abort();await activation;
  // Allow the actual socket close event to reach the route guard.
  await new Promise(r=>setTimeout(r,40));finish();await new Promise(r=>setTimeout(r,40));
  assert.equal(f.store.commands().length,0);
});
