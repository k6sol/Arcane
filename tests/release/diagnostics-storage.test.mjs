// Execute the production adapter against deterministic Windows filesystem/SQLite doubles.
// These prove path/race/constructor/durability policy, not native NTFS ACLs or SQLite VFS acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {win32 as path} from 'node:path';
import vm from 'node:vm';
const source=readFileSync(new URL('../../apps/desktop/electron/diagnostics-storage.cjs',import.meta.url),'utf8');
const directory='C:\\Fixture\\Arcane\\diagnostics',file=path.join(directory,'outbox.sqlite');
const REFUSAL='Arcane diagnostic storage is unavailable.';
const codeError=code=>Object.assign(Error('private path or credential must not escape'),{code});
function fixture(options={}){
 const nodes=new Map(),fds=new Map(),opened=[],closed=[];let nextIno=1n,nextFd=10,prepareCalls=0;const databases=[];
 const key=value=>path.normalize(value).toLowerCase();
 const add=(name,kind='directory',fields={})=>{const row={name,kind,dev:1n,ino:nextIno++,mode:kind==='directory'?0o40700n:0o100600n,nlink:1n,...fields};nodes.set(key(name),row);return row;};
 const stats=row=>{const data={...row};return{...data,isFile:()=>data.kind==='file',isDirectory:()=>data.kind==='directory',isSymbolicLink:()=>data.kind==='link'};};
 for(const name of ['C:\\','C:\\Fixture','C:\\Fixture\\Arcane'])add(name);
 if(options.existingDirectory!==false)add(directory);
 if(options.existingDatabase)add(file,'file');
 const fs={
  lstatSync(name){options.onLstat?.(name);const row=nodes.get(key(name));if(!row)throw codeError('ENOENT');return stats(row);},
  realpathSync(name){const row=nodes.get(key(name));if(!row)throw codeError('ENOENT');return row.redirect??path.normalize(name);},
  openSync(name,flags,mode){options.onReserve?.(name);assert.equal(flags,'wx');assert.equal(mode,0o600);if(nodes.has(key(name)))throw codeError('EEXIST');const row=add(name,'file');const fd=nextFd++;fds.set(fd,row);opened.push(name);return fd;},
  fstatSync(fd){assert.ok(fds.has(fd));return stats(fds.get(fd));},
  fsyncSync(fd){assert.ok(fds.has(fd));},closeSync(fd){assert.ok(fds.delete(fd));closed.push(fd);},
 };
 class Database{
  constructor(filename,settings){this.filename=filename;this.settings=settings;this.closes=0;this.statements=[];databases.push(this);options.onDatabase?.(this);}
  exec(sql){this.statements.push(sql);options.onExec?.(this);}
  prepare(sql){const values={
   'PRAGMA journal_mode':{journal_mode:'wal'},'PRAGMA synchronous':{synchronous:2},
   'PRAGMA foreign_keys':{foreign_keys:1},'PRAGMA busy_timeout':{timeout:1000},...options.pragmas};
   assert.ok(Object.hasOwn(values,sql));return{get:()=>values[sql]};}
  close(){this.closes++;options.onClose?.(this);}
 }
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,process:{platform:'win32'},require(name){
  if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='node:sqlite')return{DatabaseSync:Database};assert.fail('Unexpected dependency '+name);
 }},{filename:'diagnostics-storage.cjs'});
 const prepareDirectory=async target=>{prepareCalls++;assert.equal(target,directory);assert.equal(databases.length,0);options.onPrepare?.();if(!nodes.has(key(directory)))add(directory);return options.preparedResult??directory;};
 return{open:(extra={})=>module.exports.openDiagnosticsStorage({directory,prepareDirectory,...extra}),nodes,key,add,databases,opened,closed,fds,
  prepareCalls:()=>prepareCalls,replace(name,changes={}){const row=nodes.get(key(name));assert.ok(row);nodes.set(key(name),{...row,ino:nextIno++,...changes});},
  snapshot:()=>new Map([...nodes].map(([k,row])=>[k,{...row}])),restore(snapshot){nodes.clear();for(const[k,row]of snapshot)nodes.set(k,{...row});}};
}
const refuses=promise=>assert.rejects(promise,error=>error.message===REFUSAL&&!error.message.includes('private path'));
test('trusted preparation precedes exclusive reservation and the fixed database opens with verified durability',async()=>{
 const f=fixture({existingDirectory:false});const store=await f.open();assert.equal(f.prepareCalls(),1);assert.deepEqual(f.opened,[file]);assert.equal(f.fds.size,0);
 assert.equal(f.databases[0].filename,'\\\\?\\'+file);assert.equal(f.databases[0].settings.timeout,1000);assert.equal(f.databases[0].settings.allowExtension,false);
 assert.match(f.databases[0].statements.join('\n'),/journal_mode=WAL/);assert.match(f.databases[0].statements.join('\n'),/synchronous=FULL/);
 assert.doesNotThrow(()=>store.assertReady());store.close();store.close();assert.equal(f.databases[0].closes,1);assert.throws(()=>store.assertReady(),{message:REFUSAL});
});
test('an existing main database retains its identity and does not get reserved or replaced',async()=>{
 const f=fixture({existingDatabase:true}),before=f.nodes.get(f.key(file)).ino,store=await f.open({sqliteTransportPath:value=>value});
 assert.equal(f.opened.length,0);assert.equal(f.nodes.get(f.key(file)).ino,before);assert.equal(f.databases[0].filename,file);store.close();
});
test('unsafe existing ancestors, redirects and linked main/WAL/SHM/journal files fail before preparation',async()=>{
 for(const[name,changes]of [
  ['C:\\Fixture',{kind:'link'}],['C:\\Fixture\\Arcane',{redirect:'C:\\Elsewhere'}],
  [file,{kind:'file',nlink:2n}],[file+'-wal',{kind:'link'}],[file+'-shm',{kind:'file',nlink:2n}],[file+'-journal',{kind:'link'}],
 ]){
  const f=fixture();if(f.nodes.has(f.key(name)))Object.assign(f.nodes.get(f.key(name)),changes);else f.add(name,changes.kind,changes);
  await refuses(f.open());assert.equal(f.prepareCalls(),0);assert.equal(f.databases.length,0);
 }
});
test('trusted preparation cannot redirect the target, replace an existing ancestor or replace the existing database',async()=>{
 let f=fixture({preparedResult:'C:\\Elsewhere'});await refuses(f.open());assert.equal(f.databases.length,0);
 for(const target of ['C:\\Fixture',directory,file]){
  f=fixture({existingDatabase:true,onPrepare(){f.replace(target);}});await refuses(f.open());assert.equal(f.databases.length,0);
 }
 f=fixture({onPrepare(){throw Error('private path or credential');}});await refuses(f.open());assert.equal(f.databases.length,0);
});
test('every ancestor and main database are pinned throughout the open connection lifetime',async()=>{
 for(const target of ['C:\\','C:\\Fixture','C:\\Fixture\\Arcane',directory,file]){
  const f=fixture(),store=await f.open(),snapshot=f.snapshot();f.replace(target);
  assert.throws(()=>store.assertReady(),{message:REFUSAL});f.restore(snapshot);assert.doesNotThrow(()=>store.assertReady());store.close();
 }
});
test('new SQLite companions must stay direct regular single-link files',async()=>{
 for(const suffix of ['-wal','-shm','-journal'])for(const fields of [{kind:'link'},{kind:'file',nlink:2n},{kind:'file',redirect:'C:\\Elsewhere'}]){
  const f=fixture(),store=await f.open(),snapshot=f.snapshot();f.add(file+suffix,fields.kind,fields);
  assert.throws(()=>store.assertReady(),{message:REFUSAL});f.restore(snapshot);store.close();
 }
});
test('database-open and pragma races refuse the adapter and close only its newly owned handle',async()=>{
 for(const point of ['onDatabase','onExec']){
  let f;f=fixture({[point](){f.replace(file);}});await refuses(f.open());assert.equal(f.databases.length,1);assert.equal(f.databases[0].closes,1);
 }
 let f;f=fixture({onDatabase(){f.replace('C:\\Fixture');}});await refuses(f.open());assert.equal(f.databases[0].closes,1);
});
test('a concurrently appearing database is retained and never adopted, removed or opened',async()=>{
 let f;f=fixture({onReserve(){f.add(file,'file',{marker:'foreign bytes'});}});await refuses(f.open());
 assert.equal(f.databases.length,0);assert.equal(f.nodes.get(f.key(file)).marker,'foreign bytes');assert.equal(f.fds.size,0);
});
test('the trusted transport conversion may only spell the fixed file, never choose another target',async()=>{
 const f=fixture();await refuses(f.open({sqliteTransportPath:()=> 'C:\\Other\\outbox.sqlite'}));assert.equal(f.databases.length,0);
 const g=fixture();await refuses(g.open({sqliteTransportPath:()=> ':memory:'}));assert.equal(g.databases.length,0);
});
test('actual pragma outcomes must confirm WAL, FULL sync, foreign keys and bounded busy timeout',async()=>{
 for(const pragmas of [{'PRAGMA journal_mode':{journal_mode:'delete'}},{'PRAGMA synchronous':{synchronous:1}},
  {'PRAGMA foreign_keys':{foreign_keys:0}},{'PRAGMA busy_timeout':{timeout:5000}}]){
  const f=fixture({pragmas});await refuses(f.open());assert.equal(f.databases[0].closes,1);
 }
});
test('relative, UNC, traversal, device and alternate-stream paths never reach preparation or SQLite',async()=>{
 for(const directory of ['relative','\\\\server\\share\\diagnostics','C:\\Fixture\\..\\diagnostics','C:\\Fixture\\diagnostics:stream',
  '\\\\?\\C:\\Fixture\\diagnostics','C:\\Fixture\\NUL','C:\\Fixture\\diagnostics.']){
  const f=fixture();await refuses(f.open({directory}));assert.equal(f.prepareCalls(),0);assert.equal(f.databases.length,0);
 }
});
