// Actual daemon startup against owned disposable state, never provider inference or Studio.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm,link,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {PassThrough} from 'node:stream';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const ENTRY=join(ROOT,'dist/apps/daemon/src/product-main.js');
const test=(name,run)=>nodeTest(name,{timeout:20000},run);
const ENVIRONMENT_NAMES=new Set(['path','systemroot','windir','systemdrive','comspec','pathext','temp','tmp','home','userprofile','appdata','localappdata','lang','lc_all','lc_ctype']);

async function fixture(t){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'arcane-startup-ipc-'));
  t.after(async()=>{
    const actual=await realpath(root),child=relative(base,actual);
    assert.ok(!isAbsolute(child)&&child.startsWith('arcane-startup-ipc-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(actual,{recursive:true,force:true});
  });
  const state=join(root,'runtime/projects','a'.repeat(64)),project=join(root,'project');
  await mkdir(state,{recursive:true});await mkdir(project);
  const portRecord=join(state,'listener-port.json'),saved='{"protocolVersion":1,"port":47831}\n';
  await writeFile(portRecord,saved);
  return{root,state,project,portRecord,saved};
}

async function start(f,{resources=ROOT,port='0'}={}){
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>ENVIRONMENT_NAMES.has(key.toLowerCase()))),
    ARCANE_RESOURCE_DIRECTORY:resolve(resources),ARCANE_STATE_DIRECTORY:f.state,ARCANE_PROJECT:f.project,ARCANE_PORT:port};
  const child=spawn(process.execPath,[ENTRY],{cwd:f.root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const messages=[];let outputBytes=0,timedOut=false;
  child.on('message',value=>{messages.push(value);if(messages.length>4)child.kill();});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>65536)child.kill();});
  const outcome=await new Promise((accept,reject)=>{
    let force,unconfirmed;
    const clear=()=>{clearTimeout(deadline);clearTimeout(force);clearTimeout(unconfirmed);};
    const deadline=setTimeout(()=>{
      timedOut=true;child.kill();
      force=setTimeout(()=>child.kill('SIGKILL'),1000);
      unconfirmed=setTimeout(()=>{clear();reject(Error('Owned fixture process closure was not confirmed.'));},2000);
    },15000);
    child.once('error',error=>{clear();reject(error);});
    child.once('close',(code,signal)=>{clear();accept({code,signal});});
  });
  assert.equal(timedOut,false,'Owned daemon must finish its failed startup within the fixture deadline.');
  assert.ok(outputBytes<=65536,'Startup diagnostics must remain bounded.');
  assert.notEqual(outcome.code,0);assert.equal(outcome.signal,null);
  assert.equal(await readFile(f.portRecord,'utf8'),f.saved);
  await assert.rejects(access(join(f.state,'daemon.json')),{code:'ENOENT'});
  return messages;
}

function reported(messages,code){
  assert.deepEqual(messages,[{type:'arcane-startup-failure',protocolVersion:1,code}]);
  assert.equal(JSON.stringify(messages).includes('token'),false);
}

test('actual daemon reports newer saved state over IPC without changing retained files',async t=>{
  const f=await fixture(t),path=join(f.state,'studio.sqlite');
  const db=new DatabaseSync(path);db.exec('PRAGMA user_version=8');db.close();
  const before=await readFile(path);
  reported(await start(f),'STATE_NEWER');assert.deepEqual(await readFile(path),before);
});

test('actual daemon reports an unsafe state link before opening the store',async t=>{
  const f=await fixture(t),path=join(f.state,'studio.sqlite'),original=join(f.root,'retained.sqlite');
  await writeFile(original,'retained fixture bytes');await link(original,path);
  reported(await start(f),'STATE_UNSAFE');
  assert.equal(await readFile(original,'utf8'),'retained fixture bytes');
});

test('actual daemon reports missing installation resources before opening project stores',async t=>{
  const f=await fixture(t),resources=join(f.root,'incomplete-app');await mkdir(resources);
  reported(await start(f,{resources}),'RESOURCE_UNAVAILABLE');
  await assert.rejects(access(join(f.state,'studio.sqlite')),{code:'ENOENT'});
});

test('actual daemon reports only a real occupied listener as a port conflict',async t=>{
  const f=await fixture(t),owner=createServer();
  await new Promise((accept,reject)=>{owner.once('error',reject);owner.listen(0,'127.0.0.1',accept);});
  t.after(()=>new Promise(accept=>owner.close(accept)));
  const address=owner.address();assert.ok(address&&typeof address==='object');
  reported(await start(f,{port:String(address.port)}),'PORT_IN_USE');
});

// A daemon that was hard-killed (or stopped after an unknown preparation write) leaves
// studio-import-preparations/preparation-owner.json behind. That once failed every later
// startup of the project with STARTUP_FAILED and no recovery path.
async function preparationLock(f,content){
  const directory=join(f.state,'studio-import-preparations'),path=join(directory,'preparation-owner.json');
  await mkdir(directory,{recursive:true});await writeFile(path,content);return path;
}
const projectId=async f=>{const real=await realpath(f.project);return createHash('sha256').update(process.platform==='win32'?real.toLowerCase():real).digest('hex');};

async function startReady(f){
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>ENVIRONMENT_NAMES.has(key.toLowerCase()))),
    ARCANE_RESOURCE_DIRECTORY:ROOT,ARCANE_STATE_DIRECTORY:f.state,ARCANE_PROJECT:f.project,ARCANE_PORT:'0'};
  const child=spawn(process.execPath,[ENTRY],{cwd:f.root,env,shell:false,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
  const messages=[];
  const closed=new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({code,signal}));});
  const deadline=setTimeout(()=>child.kill(),15000);
  child.on('message',value=>{messages.push(value);
    if(value?.type==='arcane-ready')child.send({type:'arcane-shutdown',protocolVersion:1});});
  const outcome=await closed;clearTimeout(deadline);
  return{outcome,messages,stderr};
}

test('regression: actual daemon recovers a preparation owner file abandoned by a killed daemon',async t=>{
  const f=await fixture(t);
  const path=await preparationLock(f,JSON.stringify({schemaVersion:1,projectId:await projectId(f),writerId:randomUUID()}));
  const {outcome,messages,stderr}=await startReady(f);
  assert.equal(messages[0]?.type,'arcane-ready',stderr);assert.equal(messages.length,1);
  assert.deepEqual(outcome,{code:0,signal:null},stderr);
  // The recovered owner was replaced by this daemon's own lock and released on clean shutdown.
  await assert.rejects(access(path),{code:'ENOENT'});
  await assert.rejects(access(join(f.state,'daemon.json')),{code:'ENOENT'});
});

test('regression: an empty owner file from a crash during lock creation is recovered',async t=>{
  const f=await fixture(t),path=await preparationLock(f,'');
  const {outcome,messages,stderr}=await startReady(f);
  assert.equal(messages[0]?.type,'arcane-ready',stderr);assert.deepEqual(outcome,{code:0,signal:null},stderr);
  await assert.rejects(access(path),{code:'ENOENT'});
});

test('actual daemon reports a workspace lock held by a live process as project in use and leaves the lock alone',async t=>{
  // This live test process stands in for the other open Arcane runtime; it is never signalled beyond the existence probe.
  const f=await fixture(t),lock=join(f.state,'studio.lock'),content=JSON.stringify({pid:process.pid,openedAt:new Date(0).toISOString()});
  await writeFile(lock,content);
  reported(await start(f),'PROJECT_IN_USE');
  assert.equal(await readFile(lock,'utf8'),content);
  await assert.rejects(access(join(f.state,'studio.sqlite')),{code:'ENOENT'});
});

test('an unverifiable workspace lock keeps the general startup failure',async t=>{
  const f=await fixture(t),lock=join(f.state,'studio.lock');await writeFile(lock,'{"pid":"unknown"}');
  reported(await start(f),'STARTUP_FAILED');assert.equal(await readFile(lock,'utf8'),'{"pid":"unknown"}');
});

test('foreign or other-project preparation owner files are still refused and retained unchanged',async t=>{
  for(const content of ['{"foreign":"lock"}',JSON.stringify({schemaVersion:1,projectId:'b'.repeat(64),writerId:randomUUID()})]){
    const f=await fixture(t),path=await preparationLock(f,content);
    reported(await start(f),'STARTUP_FAILED');
    assert.equal(await readFile(path,'utf8'),content);
  }
});

const policy=createRequire(import.meta.url)('../../apps/desktop/electron/policy.cjs');

test('a real startup failure leaves its stderr in the bounded state-root log',async t=>{
  const f=await fixture(t);await preparationLock(f,'{"foreign":"lock"}');
  const log=policy.daemonStderrLog(f.state);assert.ok(log);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>ENVIRONMENT_NAMES.has(key.toLowerCase()))),
    ARCANE_RESOURCE_DIRECTORY:ROOT,ARCANE_STATE_DIRECTORY:f.state,ARCANE_PROJECT:f.project,ARCANE_PORT:'0'};
  const child=spawn(process.execPath,[ENTRY],{cwd:f.root,env,shell:false,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  log.attach(child.stderr);
  await once(child,'close');
  const text=await readFile(join(f.state,policy.DAEMON_STDERR_LOG),'utf8');
  assert.match(text,/^\[Arcane local runtime stderr, started /);
  assert.match(text,/STUDIO_IMPORT_PREPARATION_LOCKED/);
});

test('daemon stderr log keeps one previous run, stays bounded and never follows a hardlink',async t=>{
  const f=await fixture(t),current=join(f.state,policy.DAEMON_STDERR_LOG),previous=join(f.state,'daemon-stderr.previous.log');
  const first=policy.daemonStderrLog(f.state,128),one=new PassThrough();first.attach(one);
  one.end('first run '+'x'.repeat(200));await once(one,'close');
  const firstText=await readFile(current,'utf8');assert.match(firstText,/\[truncated at 128 bytes\]\n$/);
  assert.ok(Buffer.byteLength(firstText)<=128+40);
  const second=policy.daemonStderrLog(f.state,128),two=new PassThrough();second.attach(two);two.end('second');await once(two,'close');
  assert.equal(await readFile(previous,'utf8'),firstText);assert.match(await readFile(current,'utf8'),/second$/);
  const outside=join(f.root,'outside.log');await writeFile(outside,'retained');await rm(current);await link(outside,current);
  assert.equal(policy.daemonStderrLog(f.state),null);assert.equal(await readFile(outside,'utf8'),'retained');
});
