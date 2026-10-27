import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, link, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parseCustomerCheckArgs,customerCheckEnvironment,assertCustomerCheckReceipt,assertCustomerCheckCompletion,readCustomerCheckJson,hashCustomerCheckFile} from '../../scripts/check-packaged-customer-chat.mjs';
// Synthetic port tests only: no application, provider, SQLite or Studio is launched.
const hash=v=>createHash('sha256').update(v).digest('hex');
const ID='12345678-1234-4234-8234-123456789abc', H='a'.repeat(64);
const intent={schemaVersion:1,runId:ID,provider:'codex',model:'reported-model',effort:'low',nonce:'b'.repeat(32),bundleManifestSha256:H,executableSha256:H,authorizedOneTurn:true};
const args=()=>['--human-authorized-one-turn','--bundle',resolve('fixture-bundle'),'--manifest-sha256',H,'--provider','codex','--model','reported-model','--effort','low'];
const receipt=(extra={})=>({schemaVersion:1,kind:'arcane-packaged-customer-chat-diagnostic',runId:ID,provider:'codex',phase:'first',processId:42,intentSha256:H,bundleManifestSha256:H,executableSha256:H,requestedModel:intent.model,requestedEffort:'low',fullProductVerified:false,nativeAcceptance:false,studioOperations:0,previousReceiptSha256:null,outcome:'ready',dispatch:'not-armed',...extra});
test('customer check requires literal opt-in, one explicit provider/model/effort and pinned bundle',()=>{
  assert.equal(parseCustomerCheckArgs(args()).model,'reported-model');
  for(const a of [[],args().slice(1),[...args(),'--retry'],args().map(x=>x==='codex'?'auto':x),args().map(x=>x===H?'latest':x),args().map(x=>x==='low'?'':x)])assert.throws(()=>parseCustomerCheckArgs(a));
});
test('customer environment preserves OS account discovery without injected runtime/config/proxy/API overrides',()=>{
  const e=customerCheckEnvironment({PATH:'os',APPDATA:'account',LOCALAPPDATA:'local',USERPROFILE:'profile',HOME:'home',NODE_OPTIONS:'inject',ELECTRON_RUN_AS_NODE:'1',OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',CLAUDE_CODE_SETTINGS:'inject',ARCANE_TEST:'inject',HTTPS_PROXY:'proxy'});
  assert.deepEqual(e,{PATH:'os',APPDATA:'account',LOCALAPPDATA:'local',USERPROFILE:'profile',HOME:'home'});assert.ok(!JSON.stringify(e).includes('secret'));
});
test('diagnostic receipt rejects forged scope, credentials, fixture provenance, hidden/accessor/proxy values without execution',()=>{
  assert.equal(assertCustomerCheckReceipt(receipt(),intent,'first',H).nativeAcceptance,false);
  for(const patch of [{runId:'other'},{provider:'claude'},{phase:'reopen'},{nativeAcceptance:true},{fullProductVerified:true},{bearer:'secret'},{provenance:'spawned-node-fixture'},{nativeModel:'fallback'},{studioOperations:1},{code:'private account text'}])assert.throws(()=>assertCustomerCheckReceipt(receipt(patch),intent,'first',H));
  let invoked=0;const getter=receipt();Object.defineProperty(getter,'outcome',{get(){invoked++;throw Error('executed');},enumerable:true});
  const proxy=new Proxy(receipt(),{getPrototypeOf(){invoked++;throw Error('executed');}});
  for(const hostile of [getter,proxy,Object.defineProperty(receipt(),'hidden',{value:1}),{...receipt(),[Symbol('extra')]:1}])assert.throws(()=>assertCustomerCheckReceipt(hostile,intent,'first',H));assert.equal(invoked,0);
});
test('reopen acceptance requires native completion, durable same identities and complete native history; never whole-product proof',()=>{
  const first={...receipt(),outcome:'completed',dispatch:'completed',uiSelectionVerified:true,nativeTurnVerified:true,requestedSelectionAcknowledged:true,persistedLibraryVerified:true,auth:'subscription',provenance:'installed-cli',isolation:'arcane-only-verified',nativeModel:intent.model,nativeEffort:'low',requestSha256:H,threadSha256:H,turnSha256:H,conversationSha256:H,promptSha256:H,replySha256:H};
  const second={...first,phase:'reopen',nativeHistoryVerified:true};const result=assertCustomerCheckCompletion(first,second);assert.equal(result.fullProductVerified,false);assert.equal(result.providerDescendantCleanup,'unobserved');
  for(const patch of [{nativeTurnVerified:false},{nativeHistoryVerified:false},{turnSha256:'c'.repeat(64)},{requestedModel:'fallback'},{dispatch:'armed-unknown'},{auth:'signed-out'},{persistedLibraryVerified:false}])assert.throws(()=>assertCustomerCheckCompletion(first,{...second,...patch}));
});
test('bounded report reader refuses oversized/indirect files and never follows a caller descriptor',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'arcane-customer-check-fixture-'));
  try{const file=join(root,'report.json');await writeFile(file,JSON.stringify(receipt()));assert.equal((await readCustomerCheckJson(file)).runId,ID);await writeFile(file,'x'.repeat(16385));await assert.rejects(readCustomerCheckJson(file),/FILE_LIMIT/);
    const target=join(root,'real.json'),hardlink=join(root,'hardlink.json');await writeFile(target,'{}');assert.equal(await hashCustomerCheckFile(target),hash('{}'));await link(target,hardlink);await assert.rejects(readCustomerCheckJson(hardlink),/FILE_TYPE/);await assert.rejects(hashCustomerCheckFile(target),/FILE_TYPE/);
  }finally{await rm(root,{recursive:true,force:true});}
});

const hostSource=await readFile(new URL('../../apps/desktop/electron/main.cjs',import.meta.url),'utf8');
const hostBlock=hostSource.split('// ARCANE_CUSTOMER_CHAT_CHECK_V1_BEGIN')[1].split('// ARCANE_CUSTOMER_CHAT_CHECK_V1_END')[0];
function hostFixture({provider='codex',phase='first',provenance='installed-cli',isolation='arcane-only-verified',readMutation=null,onDescriptorClose=()=>{},responseFactory=null}={}) {
  const root=resolve('arcane-customer-check-'+ID),bundle=resolve('synthetic-bundle'),profile=join(root,'profile'),exe=join(bundle,'Arcane.exe'),manifest=join(bundle,'windows-manifest.json');
  const files=new Map([[exe,Buffer.from('fixture executable')],[manifest,Buffer.from('fixture manifest')]]),dirs=new Set([root]);let interval,quit=0,profileSet=null;
  const i={...intent,provider,executableSha256:hash(files.get(exe)),bundleManifestSha256:hash(files.get(manifest))};files.set(join(root,'intent.json'),Buffer.from(JSON.stringify(i)+'\n'));
  const read=name=>JSON.parse(files.get(join(root,name)).toString());
  const prompt='Reply with exactly ARCANE_CUSTOMER_CHAT_OK '+i.nonce+'. Do not use tools, files, network or Roblox Studio.',reply='ARCANE_CUSTOMER_CHAT_OK '+i.nonce;
  const snapshot={connectionId:'native-connection',ready:true,connected:true,account:{auth:'subscription'},provenance,mcpIsolation:isolation,models:[{model:i.model,efforts:['low']}],selection:{model:i.model,effort:'low'},thread:null,approvals:[],events:[],droppedEvents:0};
  const state={snapshot,actions:[],submittedMessages:{threadId:'thread1',messages:[]}};const history={recorded:{provenance:'installed-cli',result:{completeness:'complete',truncated:false,gaps:[],entries:[]}}};
  const ui={model:i.model,effort:'low',prefs:{preferences:{provider,tabs:[{localId:'tab',modelId:i.model,effort:'low'}],activeTabId:'tab'}},library:{preferences:{conversations:[]}},body:''};
  const frame={url:'http://127.0.0.1:1234/'},contents={mainFrame:frame,isLoading:()=>false,on:()=>{},executeJavaScript:async expression=>{assert.ok(!/\.send\(|\.save\(|\.login\(|\.click\(/.test(expression));return ui;}};
  const window={isDestroyed:()=>false,webContents:contents};
  const descriptors=new Map();let nextFd=10;
  const fs={lstatSync:p=>({isSymbolicLink:()=>false,isDirectory:()=>dirs.has(p)||!files.has(p),isFile:()=>files.has(p),nlink:1,size:files.get(p)?.length??0}),realpathSync:p=>p,readFileSync:(p,encoding)=>{if(!files.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'});return encoding?files.get(p).toString():files.get(p);},existsSync:p=>files.has(p)||dirs.has(p),mkdirSync:p=>{if(dirs.has(p))throw Error('existing');dirs.add(p);},writeFileSync:(p,bytes,options)=>{assert.equal(options.flag,'wx');if(files.has(p))throw Error('existing');files.set(p,Buffer.from(bytes));}};
  fs.openSync=p=>{if(!files.has(p))throw Error('missing');const fd=nextFd++;descriptors.set(fd,p);return fd;};fs.fstatSync=fd=>fs.lstatSync(descriptors.get(fd));fs.readSync=(fd,target,offset,length,position)=>{const bytes=files.get(descriptors.get(fd));const n=Math.min(length,Math.max(0,bytes.length-position));bytes.copy(target,offset,position,position+n);readMutation?.(files,descriptors.get(fd));return n;};fs.closeSync=fd=>{assert.ok(descriptors.delete(fd));onDescriptorClose();};
  if(phase==='reopen'){dirs.add(profile);files.set(join(root,'first-closed.json'),Buffer.from(JSON.stringify({outcome:'completed',rootExit:'normal',daemonClean:true,runId:ID})));}
  const require=createRequire(import.meta.url);const context=vm.createContext({require,app:{isPackaged:true,setPath:(_name,value)=>{profileSet=value;},quit:()=>{quit++;}},process:{platform:'win32',execPath:exe,pid:4242},fs,createHash,Buffer,window,projectSession:{},child:{exitCode:null,signalCode:null},origin:frame.url.slice(0,-1),token:'private-host-bearer',switching:false,closing:false,projectPath:join(profile,'projects','Untitled'),policy:{navigationAllowed:()=>true},setInterval:fn=>{interval=fn;return {unref(){}};},clearInterval(){},AbortSignal,TextDecoder,fetch:async url=>responseFactory?responseFactory(url):new Response(JSON.stringify(url.endsWith('/state')?{state}:url.endsWith('/sessions')?{sessions:[]}:{nativeHistory:history}),{headers:{'Content-Type':'application/json; charset=utf-8'}}),claudeChat:{customerCheckEvidence:async()=>({nativeIsolationVerified:false,catalogue:{source:'cli-help'}})}});
  const parseLengths=[];context.recordParse=text=>parseLengths.push(Buffer.byteLength(text));vm.runInContext('const savedParse=JSON.parse;JSON.parse=function(text){recordParse(text);return savedParse(text);};',context);
  vm.runInContext(hostBlock+'\nglobalThis.factory=createCustomerCheck;',context);const host=context.factory(['--arcane-customer-check',root,phase]);
  const flush=async()=>{await new Promise(done=>setImmediate(done));};
  return {root,profile,files,read,i,ui,state,parseLengths,snapshot,history,prompt,reply,host,context,quit:()=>quit,profileSet:()=>profileSet,async tick(){interval();await flush();},async start(){host.start();await flush();},arm(){files.set(join(root,'armed.json'),Buffer.from(JSON.stringify({runId:ID,promptSha256:hash(prompt)})));},complete(){state.submittedMessages.messages=[{requestId:'request1',turnId:'turn1',text:prompt,model:i.model,effort:'low',state:'acknowledged'}];state.actions=[{requestId:'request1',turnId:'turn1',threadId:'thread1',action:'turn-start',model:i.model,effort:'low',state:'acknowledged'}];snapshot.thread={threadId:'thread1',turnId:'turn1',configured:true,writeGranted:false,selection:snapshot.selection,turnStatus:'completed'};snapshot.events=[{type:'delta',turnId:'turn1',text:reply}];ui.library.preferences.conversations=[{id:'conversation1',messages:[{provider,role:'user',text:prompt},{provider,role:'assistant',text:reply}]}];ui.body=prompt+' '+reply;history.recorded.result.entries=[{role:'user',text:prompt,ids:{threadId:'thread1',turnId:'turn1'}},{role:'assistant',text:reply,ids:{threadId:'thread1',turnId:'turn1'}}];}};
}
test('closed host mode keeps ordinary args inert and uses only its fresh profile; genuine missing isolation refuses before arming',async()=>{
  const f=hostFixture({isolation:'native-config'});assert.equal(f.context.factory([]),null);assert.equal(f.profileSet(),f.profile);await f.start();assert.equal(f.read('first-result.json').code,'NATIVE_ISOLATION_UNAVAILABLE');assert.equal(f.read('first-result.json').dispatch,'not-armed');assert.ok(!f.files.has(join(f.root,'armed.json')));
});
test('real host observer requires native ACK+completion and persisted GUI evidence, emits chained diagnostic receipts and only-owned normal close',async()=>{
  const f=hostFixture();await f.start();assert.equal(f.read('first-ready.json').outcome,'ready');f.arm();f.complete();f.state.actions=[];await f.tick();assert.ok(!f.files.has(join(f.root,'first-result.json')));f.state.actions=[{requestId:'request1',turnId:'turn1',threadId:'thread1',action:'turn-start',model:f.i.model,effort:'low',state:'acknowledged'}];await f.tick();const result=f.read('first-result.json');assert.equal(result.outcome,'completed');assert.equal(result.previousReceiptSha256,hash(f.files.get(join(f.root,'first-ready.json'))));assert.ok(!JSON.stringify(result).includes('private-host-bearer'));f.files.set(join(f.root,'first-close.json'),Buffer.from(JSON.stringify({runId:ID,phase:'first'})));await f.tick();assert.equal(f.quit(),1);await f.host.closed(true);assert.equal(f.read('first-closed.json').previousReceiptSha256,hash(f.files.get(join(f.root,'first-result.json'))));assert.equal(f.read('first-closed.json').providerDescendantCleanup,'unobserved');
});
test('host refuses fixture native provenance, any extra prompt or tool activity and never retries dispatch',async()=>{
  for(const mutate of [f=>{f.snapshot.provenance='spawned-node-fixture';},f=>{f.state.submittedMessages.messages=[{text:'different'}];},f=>{f.snapshot.events=[{type:'item',itemType:'mcpToolCall',tool:{server:'arcane'}}];}]){const f=hostFixture();mutate(f);await f.start();assert.equal(f.read('first-result.json').outcome,'unsupported');assert.ok(!f.files.has(join(f.root,'armed.json')));}
});
test('Claude policy intent cannot masquerade as independently observed native isolation',async()=>{
  const f=hostFixture({provider:'claude'});await f.start();assert.equal(f.read('first-result.json').code,'CLAUDE_ISOLATION_UNAVAILABLE');assert.equal(f.read('first-result.json').dispatch,'not-armed');
});
test('reopen is read-only and cannot pass without complete actual native history of the same turn',async()=>{
  const f=hostFixture({phase:'reopen'});f.complete();f.history.recorded.result.completeness='incomplete';await f.start();assert.ok(!f.files.has(join(f.root,'reopen-result.json')));f.history.recorded.result.completeness='complete';await f.tick();assert.equal(f.read('reopen-result.json').nativeHistoryVerified,true);assert.ok(!f.files.has(join(f.root,'armed.json')));
});

test('actual private Claude evidence does not expose fallback models or turn host policy into native verification',async()=>{
  const source=await readFile(new URL('../../apps/desktop/electron/claude-chat.cjs',import.meta.url),'utf8');
  const body=source.split('customerCheckEvidence:{value:async()=>{')[1].split('}}, dispose:')[0];
  assert.ok(body);const catalogue=Object.freeze({source:'cli-help',models:Object.freeze([]),aliases:Object.freeze(['sonnet']),efforts:Object.freeze(['low'])});
  const terminal=Object.freeze({model:'sonnet',reportedModel:null,strictOwnedMcp:true,builtInToolsDisabled:true,closed:true,ok:true});
  const context=vm.createContext({status:async()=>({installed:true,signedIn:true,resolved:{sonnet:'maintained-fallback'}}),customerCatalogue:catalogue,customerTerminal:terminal,turns:new Map(),customerTurns:new WeakMap()});
  const value=await vm.runInContext('(async()=>{'+body+'})()',context);
  assert.equal(value.nativeIsolationVerified,false);assert.equal(value.catalogue.models.length,0);assert.equal(value.terminal.reportedModel,null);assert.ok(!JSON.stringify(value).includes('maintained-fallback'));
});
test('retired main context and native connection cannot be resurrected by matching serialized UI',async()=>{
  const f=hostFixture();await f.start();f.arm();f.complete();f.snapshot.connectionId='replacement-native-connection';await f.tick();assert.equal(f.read('first-result.json').code,'NATIVE_CONTEXT_CHANGED');assert.equal(f.read('first-result.json').dispatch,'armed-unknown');
  const g=hostFixture();await g.start();g.context.projectSession={};await g.tick();assert.equal(g.read('first-result.json').code,'OBSERVATION_UNAVAILABLE');
});

test('actual host opened-handle reader bounds a growing intent and always closes its descriptor',()=>{
  let changed=false,closed=0;
  assert.throws(()=>hostFixture({readMutation(files,path){if(!changed&&path.endsWith('intent.json')){changed=true;files.set(path,Buffer.alloc(20000,120));}},onDescriptorClose(){closed++;}}),/Customer check unavailable/);
  assert.equal(changed,true);assert.equal(closed,1);
});
test('actual host streamed executable hash refuses post-open byte changes without granting a profile',()=>{
  let changed=false,closed=0;
  assert.throws(()=>hostFixture({readMutation(files,path){if(!changed&&path.endsWith('Arcane.exe')){changed=true;files.set(path,Buffer.from('changed executable bytes'));}},onDescriptorClose(){closed++;}}),/Customer check unavailable/);
  assert.equal(changed,true);assert.equal(closed,2); // Intent and executable handles, including the refused one.
});

test('actual host observation bounds oversized streamed metadata, cancels/releases its reader and never parses or arms it',async()=>{
  let cancelled=0;let stream;
  const f=hostFixture({responseFactory(){stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4*1024*1024+1).fill(120));},cancel(){cancelled++;}});return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8'}});}});
  await f.start();assert.equal(f.read('first-result.json').code,'OBSERVATION_UNAVAILABLE');assert.equal(f.read('first-result.json').dispatch,'not-armed');assert.equal(cancelled,1);assert.equal(stream.locked,false);assert.ok(f.parseLengths.every(n=>n<=16384));assert.ok(!f.files.has(join(f.root,'armed.json')));assert.ok(!f.files.has(join(f.root,'first-ready.json')));
});
test('actual host refuses oversized declared metadata before reading and still cancels/releases the owned reader',async()=>{
  let reads=0,cancelled=0;let stream;
  const f=hostFixture({responseFactory(){stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([123]));},cancel(){cancelled++;}});const original=stream.getReader.bind(stream);stream.getReader=()=>{const reader=original(),read=reader.read.bind(reader);reader.read=()=>{reads++;return read();};return reader;};return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':String(4*1024*1024+1)}});}});
  await f.start();assert.equal(f.read('first-result.json').dispatch,'not-armed');assert.equal(reads,0);assert.equal(cancelled,1);assert.equal(stream.locked,false);assert.ok(!f.files.has(join(f.root,'first-ready.json')));
});
test('actual host rejects invalid UTF-8 before JSON parsing and releases the exhausted reader',async()=>{
  let stream;const f=hostFixture({responseFactory(){stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([255]));controller.close();}});return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8'}});}});
  await f.start();assert.equal(f.read('first-result.json').code,'OBSERVATION_UNAVAILABLE');assert.equal(stream.locked,false);assert.ok(!f.parseLengths.includes(1));assert.ok(!f.files.has(join(f.root,'armed.json')));
});

test('a scope retired during stream read still cancels/releases that owned reader and cannot arm',async()=>{
  let f,stream,cancelled=0,pulls=0;
  f=hostFixture({responseFactory(){stream=new ReadableStream({pull(controller){pulls++;f.context.projectSession={};controller.enqueue(new Uint8Array([123,125]));},cancel(){cancelled++;}},{highWaterMark:0});return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8'}});}});
  await f.start();assert.equal(pulls,1);assert.equal(cancelled,1);assert.equal(stream.locked,false);assert.equal(f.read('first-result.json').code,'OBSERVATION_UNAVAILABLE');assert.ok(!f.parseLengths.includes(2));assert.ok(!f.files.has(join(f.root,'armed.json')));
});
