// Production boundary with Windows filesystem/process doubles; no native ACL or profile operation runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {win32 as path} from 'node:path';
import vm from 'node:vm';
const source=readFileSync(new URL('../../apps/desktop/electron/diagnostics-directory.cjs',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../../apps/daemon/src/workflow-private-storage.ts',import.meta.url),'utf8');
const root='C:\\Fixture\\Arcane',target=path.join(root,'diagnostics'),executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ERROR='Arcane diagnostic storage is unavailable.';
function fixture(options={}){
 const nodes=new Map(),calls=[],writes=[];let next=1n,complete;
 const key=value=>path.normalize(value).toLowerCase();
 const add=(name,kind='directory',extra={})=>{const row={dev:1n,ino:next++,mode:kind==='file'?0o100600n:0o40700n,kind,...extra};nodes.set(key(name),row);return row;};
 for(const name of ['C:\\','C:\\Fixture',root])add(name);add(executable,'file');if(options.existing)add(target);
 const stat=row=>({...row,isDirectory:()=>row.kind==='directory',isFile:()=>row.kind==='file',isSymbolicLink:()=>row.kind==='link'});
 const fs={lstatSync(name){options.onLstat?.(name);const row=nodes.get(key(name));if(!row)throw Object.assign(Error('private path'),{code:'ENOENT'});return stat(row);},
  realpathSync:{native(name){const row=nodes.get(key(name));assert.ok(row);return row.redirect??path.normalize(name);}},
  mkdirSync(name,settings){assert.equal(name,target);assert.equal(settings.mode,0o700);options.onCreate?.();if(nodes.has(key(name)))throw Object.assign(Error('race'),{code:'EEXIST'});writes.push(name);add(name);}};
 const process={platform:options.platform??'win32',env:{SystemRoot:options.systemRoot??'C:\\Windows',SECRET:'must not reach the helper'}};
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,process,Buffer,require(name){if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='node:child_process')return{execFile(command,args,settings,callback){
  calls.push({command,args,settings});complete=()=>{options.beforeReply?.();const created=settings.env.ARCANE_DIAGNOSTIC_ACL_CREATED==='1';
   callback(options.error??null,options.output??JSON.stringify({version:1,created,directoryPrivate:true,ancestorsSafe:true}),'private native detail');};
  if(!options.hold)queueMicrotask(complete);
 }};assert.fail('Unexpected import '+name);}},{filename:'diagnostics-directory.cjs'});
 return{prepare:directory=>module.exports.createDiagnosticsDirectoryPreparer({root:options.root??root})(directory??target),calls,writes,nodes,key,add,
  release:()=>{assert.ok(complete);complete();},replace(name,extra={}){const row=nodes.get(key(name));assert.ok(row);nodes.set(key(name),{...row,ino:next++,...extra});}};
}
const refuses=promise=>assert.rejects(promise,error=>error.message===ERROR&&!error.message.includes('private path'));
test('the fixed new leaf is exclusively reserved and checked by a bounded asynchronous trusted helper',async()=>{
 const f=fixture({hold:true}),pending=f.prepare();assert.equal(f.calls.length,1);assert.deepEqual(f.writes,[target]);
 const {command,args,settings}=f.calls[0];assert.equal(command,executable);assert.deepEqual(Array.from(args.slice(0,4)),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
 assert.equal(settings.shell,false);assert.equal(settings.windowsHide,true);assert.equal(settings.timeout,5000);assert.equal(settings.maxBuffer,16384);
 assert.equal(settings.env.ARCANE_DIAGNOSTIC_ACL_ROOT,root);assert.equal(settings.env.ARCANE_DIAGNOSTIC_ACL_CREATED,'1');assert.equal(settings.env.SECRET,undefined);
 f.release();assert.equal(await pending,target);
});
test('existing fixed directories are inspected without claiming creation or changing their permissions',async()=>{
 const f=fixture({existing:true});assert.equal(await f.prepare(),target);assert.deepEqual(f.writes,[]);assert.equal(f.calls[0].settings.env.ARCANE_DIAGNOSTIC_ACL_CREATED,'0');
});
test('the existing workflow identity, rule and ancestor predicates remain byte-identical',()=>{
 const block=(text,end)=>{const start='  $identity=';assert.equal(text.split(start).length,2);assert.equal(text.split(end).length,2);const a=text.indexOf(start),b=text.indexOf(end);assert.ok(b>a);return text.slice(a,b).replaceAll('\r\n','\n');};
 const original=block(workflow,"  $dir=[IO.Path]::Combine($root,'workflow-human-receipts')"),copied=block(source,"  $dir=[IO.Path]::Combine($root,'diagnostics')");
 assert.equal(createHash('sha256').update(original).digest('hex'),'6ff366951be2e17ac463bddd7e91b654be761574905c1ae864cf81ac37c6a0f1');assert.equal(copied,original);
 const native=source.slice(source.indexOf('const SCRIPT='),source.indexOf('const refuse='));
 assert.equal(native.includes('CreateDirectory'),false,'Only the Node exclusive reservation may create the fixed leaf.');
 assert.match(native,/if\(\$created\)\{[\s\S]*?SetAccessControl/);
});
test('redirected or linked ancestors and an unsafe existing leaf never reach native execution',async()=>{
 for(const name of ['C:\\','C:\\Fixture',root,target])for(const change of [{kind:'link'},{redirect:'C:\\Elsewhere'}]){
  const f=fixture({existing:true});Object.assign(f.nodes.get(f.key(name)),change);await refuses(f.prepare());assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
 }
});
test('a concurrent leaf is retained, never adopted or permission-adjusted',async()=>{
 let f;f=fixture({onCreate:()=>f.add(target)});await refuses(f.prepare());assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.ok(f.nodes.has(f.key(target)));
});
test('all parent, leaf and helper executable identities are pinned across the asynchronous operation',async()=>{
 for(const name of ['C:\\','C:\\Fixture',root,target,executable]){
  let f;f=fixture({beforeReply:()=>f.replace(name)});await refuses(f.prepare());assert.equal(f.calls.length,1);
 }
});
test('native refusal, timeout and malformed receipts expose only the fixed unavailable error',async()=>{
 for(const options of [{error:Object.assign(Error('private details'),{code:'ETIMEDOUT'})},{error:Error('private ACL refusal')},{output:'not json'},{output:'x'.repeat(2049)},
  {output:JSON.stringify({version:1,created:false,directoryPrivate:true,ancestorsSafe:true})},
  {output:JSON.stringify({version:1,created:true,directoryPrivate:false,ancestorsSafe:true})},
  {output:JSON.stringify({version:1,created:true,directoryPrivate:true,ancestorsSafe:true,extra:'private'})}]){
  const f=fixture(options);await refuses(f.prepare());assert.equal(f.calls.length,1);
 }
});
test('only the trusted canonical root and its exact fixed leaf are accepted',async()=>{
 for(const options of [{root:'relative'},{root:'\\\\server\\share'},{root:'C:\\Fixture\\..\\Arcane'},{root:'C:\\Fixture\\Arcane:stream'},{root:'C:\\Fixture\\CON'},{platform:'linux'}]){
  const f=fixture(options);await refuses(f.prepare());assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
 }
 const f=fixture();await refuses(f.prepare(path.join(root,'other')));assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});
test('unexpected Windows roots and redirected helper binaries cannot execute a process',async()=>{
 const bad=fixture({systemRoot:'C:\\Other'});await refuses(bad.prepare());assert.equal(bad.calls.length,0);
 const linked=fixture();Object.assign(linked.nodes.get(linked.key(executable)),{kind:'link'});await refuses(linked.prepare());assert.equal(linked.calls.length,0);
});
