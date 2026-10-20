import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const runtime=process.env.ARCANE_LUAU_BIN;
// Production Operations source against the offline mock engine: a scripted LogService, never Studio.
async function run(t,body){
 const dir=await mkdtemp(path.join(tmpdir(),'arcane-output-'));
 t.after(async()=>{assert.ok(path.basename(dir).startsWith('arcane-output-'));await rm(dir,{recursive:true,force:true});});
 let source=await readFile('plugin/fixtures/MockEngine.luau','utf8');
 for(const name of ['Validation','Registry','Properties','Operations'])source+='\nlocal '+name+'=(function()\n'+(await readFile('plugin/src/'+name+'.luau','utf8')).replace(/require\(script\.Parent\.(\w+)\)/g,'$1')+'\nend)()\n';
 source+=String.raw`
local function messageType(name) return {Name=name} end
local OUT,INFO,WARN,ERR=messageType('MessageOutput'),messageType('MessageInfo'),messageType('MessageWarning'),messageType('MessageError')
local history={}
local listeners={}
local connections=0
services.LogService={
 GetLogHistory=function(_self) return history end,
 MessageOut={Connect=function(_self,callback) connections+=1;table.insert(listeners,callback)
  return {Disconnect=function() local i=table.find(listeners,callback);if i then table.remove(listeners,i) end end} end},
}
local function emit(message,kind) for _,callback in ipairs(table.clone(listeners)) do callback(message,kind) end end
local ops=Operations.new({sessionId='output-session',allowedRoots={'Workspace'}},game,http)
local function guard() end
local function read(args) return ops:execute({id='output-command',method='output.read',args=args or {}},guard) end
local function rejects(fn,code) local ok,e=pcall(fn);assert(not ok and type(e)=='table' and e.code==code,'expected '..code..': '..tostring(e)) end
local function messages(result) local out={};for _,entry in ipairs(result.entries) do table.insert(out,entry.seq..' '..entry.level..' '..entry.message) end;return table.concat(out,'|') end
`+body;
 const file=path.join(dir,'output.luau');await writeFile(file,source);const r=spawnSync(runtime,[file],{encoding:'utf8',timeout:30000,windowsHide:true});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
}
const options={skip:!runtime&&'Standalone Luau runtime not configured.'};

test('seeds from Output history, then follows new lines with an exact sequence cursor',options,t=>run(t,String.raw`
history={{message='Hello world',messageType=OUT,timestamp=1},{message='Infinite yield possible',messageType=WARN,timestamp=2},{message='Workspace.Door.Script:4: attempt to index nil',messageType=ERR,timestamp=3}}
local first=read()
assert(messages(first)=='1 output Hello world|2 warning Infinite yield possible|3 error Workspace.Door.Script:4: attempt to index nil',messages(first))
assert(first.latest==3 and first.omitted==0 and first.gap==false and connections==1)
emit('Loaded 4 doors',INFO);emit('Door spawned',OUT)
local newer=read({after=first.latest})
assert(messages(newer)=='4 info Loaded 4 doors|5 output Door spawned' and newer.latest==5,messages(newer))
assert(#read({after=5}).entries==0 and connections==1,'the reader connects once per pairing')
local errors=read({levels={'error','warning'}})
assert(messages(errors)=='2 warning Infinite yield possible|3 error Workspace.Door.Script:4: attempt to index nil')
local found=read({query='DOOR.SCRIPT'})
assert(messages(found)=='3 error Workspace.Door.Script:4: attempt to index nil',messages(found));assert(#read({query='door%.'}).entries==0,'queries are literal, never patterns')
local newest=read({limit=2})
assert(messages(newest)=='4 info Loaded 4 doors|5 output Door spawned' and newest.omitted==3,'newest lines win and older matches are counted')
`));

test('bounds the ring, clips long or invalid text and reports lines lost before the cursor',options,t=>run(t,String.raw`
for i=1,520 do table.insert(history,{message='line '..i,messageType=OUT}) end
local seeded=read({limit=1})
assert(seeded.latest==520 and seeded.entries[1].seq==520 and seeded.omitted==499 and seeded.gap==true,'only the last 500 history lines are kept')
assert(read({after=20,limit=1}).gap==false and read({after=19,limit=1}).gap==true)
emit(string.rep('é',600),ERR);emit('bad \255 byte\0end',ERR);emit('ignored',{Name='MessageUnknown'})
local clipped=read({levels={'error'}})
assert(#clipped.entries==2 and clipped.latest==522)
local long=clipped.entries[1]
assert(long.truncated==true and #long.message<=1024 and utf8.len(long.message)~=nil,'clipped on a UTF-8 boundary')
assert(clipped.entries[2].message=='bad ? byte?end' and clipped.entries[2].truncated==nil)
for i=1,10 do emit('more '..i,OUT) end
assert(read({after=20,limit=1}).gap==true,'eviction past the cursor is reported')
`));

test('rejects malformed arguments before reading, and retirement disconnects the reader',options,t=>run(t,String.raw`
for _,args in ipairs({{levels={}},{levels={'error','error'}},{levels={'debug'}},{levels='error'},{query=''},{query='a\nb'},{after=-1},{after=1.5},{limit=0},{limit=101},{root='Workspace'}}) do
 rejects(function() read(args) end,'INPUT')
end
assert(connections==0,'invalid input never starts the reader')
read();assert(connections==1 and #listeners==1)
ops:cancelAssetTransfers()
assert(#listeners==0 and ops.output==nil,'retirement releases the Output connection')
`));

test('scene search matches by class with IsA, alone or with a name query',options,t=>run(t,String.raw`
local workspace=game:GetService('Workspace')
local folder=Instance.new('Folder');folder.Name='Lamps';folder.Parent=workspace
local a=Instance.new('Part');a.Name='LampPost';a.Parent=folder
local b=Instance.new('WedgePart');b.Name='Ramp';b.Parent=workspace
local s=Instance.new('Script');s.Name='LampScript';s.Parent=folder
local function search(args) args.root='Workspace';return ops:execute({id='search',method='scene.search',args=args},guard) end
local function names(result) local out={};for _,item in ipairs(result.items) do table.insert(out,item.ref.pathSegments[#item.ref.pathSegments]) end;table.sort(out);return table.concat(out,',') end
assert(names(search({className='BasePart'}))=='LampPost,Ramp')
assert(names(search({className='BasePart',query='lamp'}))=='LampPost')
assert(names(search({className='LuaSourceContainer'}))=='LampScript')
assert(names(search({query='lamp'}))=='LampPost,LampScript,Lamps','name-only search is unchanged')
assert(#search({className='NotAClass'}).items==0)
rejects(function() search({}) end,'INPUT')
rejects(function() search({className='base.Part'}) end,'INPUT')
rejects(function() search({className='Part',query=''}) end,'INPUT')
`));
