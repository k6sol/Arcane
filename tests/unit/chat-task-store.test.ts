import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {existsSync,realpathSync,symlinkSync} from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, link, writeFile, lstat, unlink } from 'node:fs/promises';
import { join, relative, sep, isAbsolute,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatTaskStore } from '../../packages/storage/src/chat-task-store.js';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';

async function fixture(t:test.TestContext){const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-task-store-'))),project=join(root,'project'),directory=join(root,'state');await mkdir(project);await mkdir(directory,{mode:0o700});
 t.after(async()=>{const part=relative(boundary,root);assert.ok(part.startsWith('arcane-task-store-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});});return{root,project,directory,file:join(directory,'chat-tasks.sqlite')};}
function task(){return{id:randomUUID(),provider:'codex' as const,threadId:'thread:actual',sessionId:'session:actual',connectionId:randomUUID(),incarnationId:randomUUID(),model:'fixture',effort:'low',allowWorkspaceWrites:true,allowAssets:true,
 state:'working' as const,round:0 as const,operationId:null,turnId:null,nativeSettled:false,acknowledged:false,repairDispatch:'not_requested' as const,prepared:null,evidence:[],reason:null};}

test('Windows task summaries, get and update freshly probe every direct ancestor and SQLite file',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project}),value=store.create(task()),native=realpathSync.native,calls=new Map<string,number>();
 const probe=t.mock.method(realpathSync,'native',(path:string)=>{calls.set(path,(calls.get(path)??0)+1);return native(path);});
 try{
   for(const [operation,fences]of [[()=>store.summaries(),1],[()=>store.get(value.id),1],[()=>store.update(value.id,item=>{item.reason='fresh guarded update';}),2]]as const){
     calls.clear();operation();
     for(let current=f.directory;;current=dirname(current)){assert.equal(calls.get(current),fences,current);if(current===dirname(current))break;}
     for(const suffix of ['','-wal','-shm','-journal'])if(existsSync(f.file+suffix))assert.equal(calls.get(f.file+suffix),fences,'SQLite file '+suffix);
   }
 }finally{probe.mock.restore();store.close();}
});

test('Windows task native mismatch and lookup failure retain actual legacy acceptance and path refusals',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project}),value=store.create(task());
 try{
   for(const result of ['different-spelling','unavailable']as const){
     const probe=t.mock.method(realpathSync,'native',()=>{if(result==='unavailable')throw Object.assign(new Error('controlled native lookup unavailable'),{code:'EBUSY'});return join(f.root,'different-spelling');});
     try{
       assert.equal(store.summaries()[0]!.id,value.id);assert.equal(store.get(value.id).state,'working');
       assert.equal(store.update(value.id,item=>{item.reason=result;}).reason,result);
       const linked=join(f.root,'linked-state-'+result);symlinkSync(f.directory,linked,'junction');
       assert.throws(()=>new ChatTaskStore({directory:linked,projectPath:f.project}),/direct/);
       assert.throws(()=>new ChatTaskStore({directory:f.directory,projectPath:join(f.root,'missing-project-'+result)}),/ENOENT/);
       const marker=join(f.root,'marker-'+result),sidecar=f.file+'-journal';await writeFile(marker,'retain exact marker');await link(marker,sidecar);
       try{assert.throws(()=>store.summaries(),/direct owned regular/);assert.equal(await readFile(marker,'utf8'),'retain exact marker');}
       finally{await unlink(sidecar);}
       assert.equal(store.get(value.id).reason,result);
     }finally{probe.mock.restore();}
   }
 }finally{store.close();}
});

test('opening a newer task journal leaves database bytes and sidecar inventory unchanged',async t=>{
 const f=await fixture(t),db=new DatabaseSync(sqliteTransportPath(f.file));db.exec('PRAGMA user_version=6;CREATE TABLE future_state(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO future_state VALUES(1,\'retained\')');db.close();
 const before=await readFile(f.file),names=await readdir(f.directory);assert.throws(()=>new ChatTaskStore({directory:f.directory,projectPath:f.project}),/newer/);
 assert.deepEqual(await readFile(f.file),before);assert.deepEqual(await readdir(f.directory),names);
});

test('one live coordinator owns the real task journal and restart retains unknown work without replay',async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project}),value=store.create(task());
 assert.throws(()=>new ChatTaskStore({directory:f.directory,projectPath:f.project}),/live owner/);
 assert.equal(store.get(value.id).state,'working');store.update(value.id,item=>{item.repairDispatch='reserved';item.round=1;});store.close();
 const restarted=new ChatTaskStore({directory:f.directory,projectPath:f.project});try{const retained=restarted.get(value.id);assert.equal(retained.state,'unknown');assert.equal(retained.repairDispatch,'unknown');assert.equal(retained.reason,'daemon_restarted_no_replay');}finally{restarted.close();}
});

test('task journal rejects a linked SQLite sidecar without changing the linked file or database',async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project});store.close();const before=await readFile(f.file),target=join(f.root,'external-marker');await writeFile(target,'retain exact marker');await link(target,f.file+'-wal');
 assert.throws(()=>new ChatTaskStore({directory:f.directory,projectPath:f.project}),/direct owned regular/);assert.equal(await readFile(target,'utf8'),'retain exact marker');assert.deepEqual(await readFile(f.file),before);
});

test('task summaries retain only bounded metadata and cannot mutate durable reports',async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project});try{const value=store.create(task());const summary=store.summaries()[0]!;assert.deepEqual(Object.keys(summary).sort(),['connectionId','id','reason','reportDigest','round','sessionId','state','threadId']);summary.state='verified';assert.equal(store.get(value.id).state,'working');
   if(process.platform!=='win32')assert.equal((await lstat(f.file)).mode&0o077,0);
 }finally{store.close();}
});

test('an open task store cannot operate after its retained main pathname disappears',async t=>{
 const f=await fixture(t),store=new ChatTaskStore({directory:f.directory,projectPath:f.project});
 try{try{await unlink(f.file);}catch(error){assert.ok(['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''));t.diagnostic('The OS refused unlink of its open SQLite file; no pathname replacement occurred.');return;}
   assert.throws(()=>store.summaries(),/ENOENT|direct owned/);
 }finally{try{store.close();}catch(error){assert.match(String(error),/disk I\/O|readonly|read.only/i);}}
});
