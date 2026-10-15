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
  const db=new DatabaseSync(path);db.exec('PRAGMA user_version=7');db.close();
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
