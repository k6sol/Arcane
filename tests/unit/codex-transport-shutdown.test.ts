import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';

const LIBRARY=fileURLToPath(new URL('../../packages/codex-client/src/',import.meta.url));
// Only the spawn boundary is synthetic. The production transport/session code,
// timers and close promises run unchanged in a separate owned Node process.
const BOUNDARY=String.raw`
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
export const events=[];
export function spawn(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=signal=>{
    events.push({event:'kill',signal:signal??'SIGTERM'});
    if(globalThis.scenario==='kill-throws')throw Error('Synthetic kill refusal');
    const close=()=>{events.push({event:'child-close'});child.emit('close',0,null);};
    if(globalThis.scenario==='graceful')setTimeout(close,20);
    if(signal==='SIGKILL'&&globalThis.scenario==='forced')setTimeout(close,30);
    if(globalThis.scenario==='exit-only'&&!signal)setTimeout(()=>{events.push({event:'child-exit'});child.emit('exit',0,null);},20);
    return true;
  };
  return child;
}
`;
const HARNESS=String.raw`
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [root,library,scenario,kind]=process.argv.slice(2);globalThis.scenario=scenario;
const prefix=pathToFileURL(library).href,boundary=pathToFileURL(join(root,'boundary.mjs')).href;
registerHooks({resolve(specifier,context,next){
  if(specifier==='node:child_process'&&context.parentURL?.startsWith(prefix))return{url:boundary,shortCircuit:true};
  return next(specifier,context);
}});
const {events}=await import(boundary);
const {limits}=await import(prefix+'validation.js');
const {JsonlTransport}=await import(prefix+'transport.js');
const {CodexSession}=await import(prefix+'session.js');
const spec={command:process.execPath,args:[],cwd:root,env:{}};
const owned=kind==='session'?new CodexSession(spec,limits(),'spawned-node-fixture'):
  new JsonlTransport(spec,limits(),()=>{},error=>events.push({event:'disconnect',code:error.code}));
const settle=async()=>{try{await owned.close();events.push({event:'returned',confirmed:true});}
  catch(error){events.push({event:'returned',confirmed:false,code:error.code});}};
await Promise.all([settle(),settle()]);await settle();
console.log(JSON.stringify(events));
`;

async function fixture(t:test.TestContext,scenario:string,kind='transport'){
  const root=await mkdtemp(join(tmpdir(),'arcane-transport-shutdown-'));
  t.after(async()=>{const actual=await realpath(root),base=await realpath(tmpdir()),child=relative(base,actual);
    assert.ok(!isAbsolute(child)&&child.startsWith('arcane-transport-shutdown-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(actual,{recursive:true,force:true});});
  await writeFile(join(root,'boundary.mjs'),BOUNDARY);await writeFile(join(root,'harness.mjs'),HARNESS);
  const stdout=await new Promise<string>((accept,reject)=>{
    const child=spawn(process.execPath,[join(root,'harness.mjs'),root,LIBRARY,scenario,kind],{cwd:root,env:nativeEnvironment(),shell:false,windowsHide:true,stdio:'pipe'});
    let output='',diagnostics='';
    child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{diagnostics+=String(chunk);});
    const deadline=setTimeout(()=>{child.kill();reject(Error('Synthetic shutdown harness timed out.'));},10000);
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('close',code=>{clearTimeout(deadline);code===0?accept(output):reject(Error(diagnostics||'Synthetic harness failed.'));});
  });
  return JSON.parse(stdout) as {event:string;signal?:string;confirmed?:boolean;code?:string}[];
}

for(const scenario of ['graceful','forced'])test('native transport joins '+scenario+' closure across concurrent and repeated close calls',async t=>{
  const events=await fixture(t,scenario),closed=events.findIndex(e=>e.event==='child-close');
  assert.ok(closed>=0);assert.equal(events.filter(e=>e.event==='returned').length,3);
  assert.ok(events.filter(e=>e.event==='returned').every(e=>e.confirmed===true));
  assert.ok(events.findIndex(e=>e.event==='returned')>closed);
  assert.deepEqual(events.filter(e=>e.event==='kill').map(e=>e.signal),scenario==='forced'?['SIGTERM','SIGKILL']:['SIGTERM']);
  assert.equal(events.filter(e=>e.event==='disconnect').length,1);
});
for(const scenario of ['never-closes','exit-only','kill-throws'])test('native transport reports unconfirmed '+scenario+' without claiming shutdown',async t=>{
  const events=await fixture(t,scenario),returned=events.filter(e=>e.event==='returned');
  assert.equal(returned.length,3);assert.ok(returned.every(e=>e.confirmed===false&&e.code==='PROCESS_EXIT_UNCONFIRMED'));
  assert.equal(events.filter(e=>e.event==='child-close').length,0);
  assert.equal(events.filter(e=>e.signal==='SIGKILL').length,scenario==='exit-only'?0:1);
});
test('native session propagates unconfirmed transport shutdown to its host',async t=>{
  const events=await fixture(t,'never-closes','session');
  assert.ok(events.filter(e=>e.event==='returned').every(e=>e.confirmed===false&&e.code==='PROCESS_EXIT_UNCONFIRMED'));
  assert.equal(events.filter(e=>e.signal==='SIGKILL').length,1);
});
