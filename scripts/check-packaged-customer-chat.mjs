import {types} from 'node:util';
import {createHash, randomUUID, randomBytes} from 'node:crypto';
import {lstat, realpath, writeFile, mkdir, open} from 'node:fs/promises';
import {resolve, join, dirname, isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyWindowsBundle} from './package-windows.mjs';

// Operator-assisted diagnostic only. This script has no send/login/approval transport.
export const CUSTOMER_CHECK_LIMITS=Object.freeze({jsonBytes:16384,phaseMs:20*60_000,closeMs:40_000});
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function parseCustomerCheckArgs(args) {
  if(!Array.isArray(args)||args.length!==11||args[0]!=='--human-authorized-one-turn')throw Error('OPT_IN_REQUIRED');
  const names=['--bundle','--manifest-sha256','--provider','--model','--effort'];
  const result={};for(let i=0;i<names.length;i++){if(args[i*2+1]!==names[i])throw Error('ARGUMENTS');result[names[i].slice(2)]=args[i*2+2];}
  if(!isAbsolute(result.bundle)||resolve(result.bundle)!==result.bundle||!/^[0-9a-f]{64}$/.test(result['manifest-sha256'])||!['codex','claude'].includes(result.provider)||
    ![result.model,result.effort].every(v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(v)))throw Error('ARGUMENTS');
  return Object.freeze(result);
}
export function customerCheckEnvironment(source) {
  // Preserve OS credential discovery. Strip injected runtime/config/API credentials and proxy overrides.
  return Object.fromEntries(Object.entries(source).filter(([key,value])=>typeof value==='string'&&!/^(?:NODE_|ELECTRON_|VSCODE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|ARCANE_|GOOGLE_API|AWS_|AZURE_|ALL_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|LD_PRELOAD$|DYLD_|.*(?:_TOKEN|_SECRET|_KEY|_PASSWORD|_CREDENTIALS)$)/i.test(key)));
}
export async function directCustomerCheckPath(file,directory=false) {
  let cursor=resolve(file);
  for(;;){const st=await lstat(cursor);if(st.isSymbolicLink())throw Error('INDIRECT_PATH');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  const st=await lstat(file);if(directory?!st.isDirectory():!st.isFile()||st.nlink!==1)throw Error('FILE_TYPE');
  if((await realpath(file)).toLowerCase()!==resolve(file).toLowerCase())throw Error('INDIRECT_PATH');return st;
}
const sameFile=(a,b)=>['dev','ino','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
async function withCustomerFile(file,max,consume) {
  const before=await directCustomerCheckPath(file);if(before.size>max)throw Error('FILE_LIMIT');
  let handle;
  try {
    handle=await open(file,'r');const opened=await handle.stat();
    if(!sameFile(before,opened)||opened.nlink!==1||!opened.isFile())throw Error('FILE_CHANGED');
    const value=await consume(handle);
    const after=await handle.stat(),pathAfter=await directCustomerCheckPath(file);
    if(!sameFile(opened,after)||!sameFile(after,pathAfter))throw Error('FILE_CHANGED');return value;
  }finally{await handle?.close();}
}
export async function readCustomerCheckBytes(file,max) {
  if(!Number.isSafeInteger(max)||max<1||max>1024*1024)throw Error('FILE_LIMIT');
  return withCustomerFile(file,max,async handle=>{
    const bytes=Buffer.alloc(max+1);let length=0;
    while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);if(!bytesRead)break;length+=bytesRead;}
    if(length>max)throw Error('FILE_LIMIT');return bytes.subarray(0,length);
  });
}
export async function readCustomerCheckJson(file) {
  return JSON.parse((await readCustomerCheckBytes(file,CUSTOMER_CHECK_LIMITS.jsonBytes)).toString('utf8'));
}
export async function hashCustomerCheckFile(file,max=512*1024*1024) {
  if(!Number.isSafeInteger(max)||max<1||max>512*1024*1024)throw Error('FILE_LIMIT');
  return withCustomerFile(file,max,async handle=>{
    const bytes=Buffer.alloc(65536),hash=createHash('sha256');let length=0;
    for(;;){const {bytesRead}=await handle.read(bytes,0,Math.min(bytes.length,max-length+1),length);if(!bytesRead)break;length+=bytesRead;if(length>max)throw Error('FILE_LIMIT');hash.update(bytes.subarray(0,bytesRead));}
    return hash.digest('hex');
  });
}
export function assertCustomerCheckReceipt(v,intent,phase,intentHash) {
  const allowed=['schemaVersion','kind','runId','provider','phase','processId','intentSha256','bundleManifestSha256','executableSha256','requestedModel','requestedEffort','fullProductVerified','nativeAcceptance','studioOperations',
    'previousReceiptSha256','outcome','code','dispatch','catalogueVerified','uiSelectionVerified','provenance','isolation','nativeModel','nativeEffort','requestSha256','threadSha256','turnSha256','conversationSha256','promptSha256','replySha256',
    'requestedSelectionAcknowledged','nativeTurnVerified','persistedLibraryVerified','nativeHistoryVerified','auth','reauthenticationAction','providerDescendantCleanup','rootExit','daemonClean'];
  if(!v||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.getOwnPropertyDescriptor(v,k)?.enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value')))throw Error('RECEIPT_SHAPE');
  if(!Number.isSafeInteger(v.processId)||v.processId<1||v.schemaVersion!==1||v.kind!=='arcane-packaged-customer-chat-diagnostic'||v.runId!==intent.runId||v.provider!==intent.provider||v.phase!==phase||
    v.intentSha256!==intentHash||v.bundleManifestSha256!==intent.bundleManifestSha256||v.executableSha256!==intent.executableSha256||v.requestedModel!==intent.model||v.requestedEffort!==intent.effort||v.fullProductVerified!==false||v.nativeAcceptance!==false||v.studioOperations!==0||
    !['ready','completed','unsupported','unresolved'].includes(v.outcome)||!['not-armed','armed-unknown','acknowledged','completed'].includes(v.dispatch))throw Error('RECEIPT_SCOPE');
  if(v.code!==undefined&&!/^[A-Z_]{1,64}$/.test(v.code))throw Error('RECEIPT_CODE');
  for(const [key,value]of Object.entries(v))if(key.endsWith('Sha256')&&!(key==='previousReceiptSha256'&&value===null)&&!/^[0-9a-f]{64}$/.test(value))throw Error('RECEIPT_DIGEST');
  for(const k of ['catalogueVerified','uiSelectionVerified','requestedSelectionAcknowledged','nativeTurnVerified','persistedLibraryVerified','nativeHistoryVerified','daemonClean'])if(k in v&&typeof v[k]!=='boolean')throw Error('RECEIPT_VALUE');
  for(const [k,values]of Object.entries({provenance:['installed-cli'],isolation:['arcane-only-verified'],auth:['subscription'],reauthenticationAction:['unobserved'],providerDescendantCleanup:['unobserved'],rootExit:['normal']}))if(k in v&&!values.includes(v[k]))throw Error('RECEIPT_VALUE');
  if('nativeModel'in v&&v.nativeModel!==null&&v.nativeModel!==intent.model||'nativeEffort'in v&&v.nativeEffort!==null&&v.nativeEffort!==intent.effort)throw Error('RECEIPT_SELECTION');
  return v;
}
export function assertCustomerCheckCompletion(first,reopen) {
  const verified=v=>v.outcome==='completed'&&v.dispatch==='completed'&&v.uiSelectionVerified===true&&v.nativeTurnVerified===true&&v.requestedSelectionAcknowledged===true&&v.persistedLibraryVerified===true&&v.auth==='subscription'&&v.provenance==='installed-cli'&&v.isolation==='arcane-only-verified';
  if(first.phase!=='first'||reopen.phase!=='reopen'||first.nativeAcceptance!==false||reopen.nativeAcceptance!==false||first.fullProductVerified!==false||reopen.fullProductVerified!==false||!verified(first)||!verified(reopen)||reopen.nativeHistoryVerified!==true)throw Error('JOURNEY_UNVERIFIED');
  for(const k of ['runId','provider','bundleManifestSha256','executableSha256','intentSha256','requestSha256','threadSha256','turnSha256','conversationSha256','promptSha256','replySha256','requestedModel','requestedEffort'])if(!first[k]||first[k]!==reopen[k])throw Error('PERSISTENCE_MISMATCH');
  return Object.freeze({outcome:'completed-with-limitations',fullProductVerified:false,nativeAcceptance:false,studioOperations:0,rootExit:'observed-zero',daemonCleanup:'observed-clean',providerDescendantCleanup:'unobserved',reauthenticationAction:'unobserved',executedBackendModelIdentity:'unreported'});
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function optional(file){try{return await readCustomerCheckJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function runPackagedCustomerChat(args,{announce=console.log}={}) {
  const options=parseCustomerCheckArgs(args);if(process.platform!=='win32'||process.arch!=='x64')throw Error('WINDOWS_X64_REQUIRED');
  const manifest=join(options.bundle,'windows-manifest.json'),exe=join(options.bundle,'Arcane.exe');
  const pin=async()=>{await directCustomerCheckPath(options.bundle,true);await directCustomerCheckPath(exe);await directCustomerCheckPath(manifest);if((await hashCustomerCheckFile(manifest,16*1024*1024))!==options['manifest-sha256'])throw Error('MANIFEST_CHANGED');await verifyWindowsBundle(options.bundle);return hashCustomerCheckFile(exe);};
  const executableSha256=await pin();
  const main=join(options.bundle,'resources/app/main.cjs');await directCustomerCheckPath(main);
  if(!(await readCustomerCheckBytes(main,1024*1024)).toString('utf8').includes('ARCANE_CUSTOMER_CHAT_CHECK_V1_BEGIN'))throw Error('PACKAGE_MODE_UNSUPPORTED');
  const runId=randomUUID(),root=join(tmpdir(),'arcane-customer-check-'+runId);await directCustomerCheckPath(tmpdir(),true);await mkdir(root,{mode:0o700});await directCustomerCheckPath(root,true);
  const intent={schemaVersion:1,runId,provider:options.provider,model:options.model,effort:options.effort,nonce:randomBytes(16).toString('hex'),bundleManifestSha256:options['manifest-sha256'],executableSha256,authorizedOneTurn:true};
  const intentHash=sha256(JSON.stringify(intent)),prompt='Reply with exactly ARCANE_CUSTOMER_CHAT_OK '+intent.nonce+'. Do not use tools, files, network or Roblox Studio.';
  await writeFile(join(root,'intent.json'),JSON.stringify(intent)+'\n',{flag:'wx',mode:0o600});
  let armed=false,active=null,interrupted=false,previousReceiptSha256=null;
  const chain=async(name,value)=>{if(value.previousReceiptSha256!==previousReceiptSha256)throw Error('RECEIPT_CHAIN');previousReceiptSha256=await hashCustomerCheckFile(join(root,name),CUSTOMER_CHECK_LIMITS.jsonBytes);};const interrupt=()=>{interrupted=true;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  const close=async phase=>{if(!active)return null;await writeFile(join(root,phase+'-close.json'),JSON.stringify({runId,phase})+'\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});const end=Date.now()+CUSTOMER_CHECK_LIMITS.closeMs;while(!active.exited&&Date.now()<end)await delay(250);if(!active.exited){active.child.unref();active=null;return null;}const info=await optional(join(root,phase+'-closed.json'));if(info){if(info.processId!==active.child.pid)throw Error('PROCESS_SCOPE');assertCustomerCheckReceipt(info,intent,phase,intentHash);await chain(phase+'-closed.json',info);}const clean=active.code===0&&info?.rootExit==='normal'&&info.daemonClean===true;active=null;if(await pin()!==executableSha256)throw Error('EXECUTABLE_CHANGED');return clean?info:null;};
  const phase=async name=>{
    const child=spawn(exe,['--arcane-customer-check',root,name],{shell:false,windowsHide:false,stdio:'ignore',env:customerCheckEnvironment(process.env)});
    const owned={child,phase:name,exited:false,code:null};active=owned;child.once('exit',code=>{owned.exited=true;owned.code=code;});child.once('error',()=>{owned.exited=true;owned.code=-1;});
    announce(name==='first'?'Use the opened Arcane window to sign in and select '+intent.model+' / '+intent.effort+'. Do not send yet.':'Open the saved chat in the reopened window. Do not send or change its model.');
    const end=Date.now()+CUSTOMER_CHECK_LIMITS.phaseMs;let result;
    while(Date.now()<end&&!interrupted){
      result=await optional(join(root,name+'-result.json'));if(result){if(result.processId!==owned.child.pid)throw Error('PROCESS_SCOPE');assertCustomerCheckReceipt(result,intent,name,intentHash);await chain(name+'-result.json',result);break;}
      if(owned.exited)break;
      if(name==='first'&&!armed){const ready=await optional(join(root,'first-ready.json'));if(ready){if(ready.processId!==owned.child.pid)throw Error('PROCESS_SCOPE');assertCustomerCheckReceipt(ready,intent,name,intentHash);await chain('first-ready.json',ready);if(ready.outcome!=='ready'||ready.dispatch!=='not-armed'||ready.catalogueVerified!==true||ready.isolation!=='arcane-only-verified')throw Error('READY_UNVERIFIED');await writeFile(join(root,'armed.json'),JSON.stringify({runId,promptSha256:sha256(prompt)})+'\n',{flag:'wx',mode:0o600});armed=true;announce('Send this exact prompt ONCE through the Arcane composer:\n'+prompt);}}
      await delay(500);
    }
    const closed=await close(name);if(!closed||result?.outcome==='completed'&&closed.outcome!=='completed')throw Error('OWNED_CLEANUP_UNRESOLVED');if(!result)throw Error(armed?'DISPATCH_UNKNOWN':'CHECK_UNAVAILABLE');return result;
  };
  try{
    const first=await phase('first');if(first.outcome!=='completed')return {runId,provider:intent.provider,outcome:first.outcome,code:first.code,dispatch:first.dispatch,fullProductVerified:false,nativeAcceptance:false};
    const reopened=await phase('reopen'),summary=assertCustomerCheckCompletion(first,reopened);
    const receipt={schemaVersion:1,runId,provider:intent.provider,bundleManifestSha256:intent.bundleManifestSha256,executableSha256,...summary};await writeFile(join(root,'summary.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});return receipt;
  }catch(error){const outcome={schemaVersion:1,runId,provider:intent.provider,outcome:'unresolved',code:/^[A-Z_]{1,64}$/.test(error.message)?error.message:'CHECK_UNAVAILABLE',dispatch:armed?'armed-unknown':'not-armed',fullProductVerified:false,nativeAcceptance:false,studioOperations:0};await close(active?.phase??'first').catch(()=>{});await writeFile(join(root,'unresolved.json'),JSON.stringify(outcome)+'\n',{flag:'wx',mode:0o600});return outcome;}
  finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const receipt=await runPackagedCustomerChat(process.argv.slice(2));console.log(JSON.stringify(receipt,null,2));process.exitCode=receipt.outcome==='completed-with-limitations'?0:1;}
  catch{console.error('Packaged customer chat check refused before launch.');process.exitCode=1;}
}
