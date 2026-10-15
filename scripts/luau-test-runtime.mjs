import {createHash} from 'node:crypto';
import {appendFile, lstat, mkdir, mkdtemp, open, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';

/** CI/developer test tooling only. Product startup never imports or downloads it.
 * Archive digests/lengths were checked against the official release API; member
 * pins were derived only after those complete archive identities matched. */
import {LUAU_TEST_RELEASE,LUAU_TEST_PINS} from '../packages/studio-test-controller/testing/luau-runtime-pins.ts';
export {LUAU_TEST_RELEASE,LUAU_TEST_PINS};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function pinFor(platform){if(!Object.hasOwn(LUAU_TEST_PINS,platform))throw new Error('Pinned standalone Luau tests require Windows or Linux x64.');return LUAU_TEST_PINS[platform];}
function nativeBytes(bytes,pin,platform){
  if(!Buffer.isBuffer(bytes)||bytes.length!==pin.bytes||hash(bytes)!==pin.sha256)throw new Error('Pinned Luau test member identity mismatch.');
  if(platform==='win32'){
    const at=bytes.readUInt32LE(0x3c);
    if(bytes.toString('ascii',0,2)!=='MZ'||at<64||at+26>bytes.length||bytes.readUInt32LE(at)!==0x4550||bytes.readUInt16LE(at+4)!==0x8664||bytes.readUInt16LE(at+24)!==0x20b||!(bytes.readUInt16LE(at+22)&2)||bytes.readUInt16LE(at+22)&0x2000)throw new Error('Expected pinned Windows x64 executable.');
  }else if(bytes.readUInt32BE(0)!==0x7f454c46||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==62||![2,3].includes(bytes.readUInt16LE(16)))throw new Error('Expected pinned Linux x64 executable.');
}

/** Extract exactly the two flat pinned members, only after the archive hash is
 * verified. No archive pathname is ever joined to the filesystem. */
export function verifyLuauTestArchive(platform,archive){
  const pin=pinFor(platform);
  if(!Buffer.isBuffer(archive)||archive.length!==pin.bytes||hash(archive)!==pin.sha256)throw new Error('Pinned Luau test archive identity mismatch.');
  let end=archive.length-22;
  for(;end>=Math.max(0,archive.length-65557);end--)if(archive.readUInt32LE(end)===0x06054b50&&end+22+archive.readUInt16LE(end+20)===archive.length)break;
  if(end<0||archive.readUInt32LE(end)!==0x06054b50||archive.readUInt16LE(end+4)!==0||archive.readUInt16LE(end+6)!==0||archive.readUInt16LE(end+8)!==4||archive.readUInt16LE(end+10)!==4)throw new Error('Invalid pinned Luau ZIP directory.');
  const start=archive.readUInt32LE(end+16),size=archive.readUInt32LE(end+12);
  if(start+size!==end)throw new Error('Invalid pinned Luau ZIP extent.');
  const names=new Set(),result={};let at=start;
  for(let index=0;index<4;index++){
    if(at+46>end||archive.readUInt32LE(at)!==0x02014b50)throw new Error('Invalid pinned Luau ZIP entry.');
    const flags=archive.readUInt16LE(at+8),method=archive.readUInt16LE(at+10),compressed=archive.readUInt32LE(at+20),uncompressed=archive.readUInt32LE(at+24),
      length=archive.readUInt16LE(at+28),extra=archive.readUInt16LE(at+30),comment=archive.readUInt16LE(at+32),offset=archive.readUInt32LE(at+42),next=at+46+length+extra+comment;
    if(next>end||flags&1||![0,8].includes(method))throw new Error('Unsupported pinned Luau ZIP entry.');
    const name=archive.toString('utf8',at+46,at+46+length);
    if(!/^(?:luau|luau-analyze|luau-ast|luau-compile)(?:\.exe)?(?![\s\S])/.test(name)||names.has(name))throw new Error('Unexpected pinned Luau ZIP member.');
    names.add(name);at=next;
    const kind=name===pin.runtime.name?'runtime':name===pin.compiler.name?'compiler':null;if(!kind)continue;
    if(offset+30>start||archive.readUInt32LE(offset)!==0x04034b50||archive.readUInt16LE(offset+8)!==method||archive.readUInt16LE(offset+6)&1)throw new Error('Invalid pinned Luau local ZIP header.');
    const nameLength=archive.readUInt16LE(offset+26),extraLength=archive.readUInt16LE(offset+28),data=offset+30+nameLength+extraLength;
    if(archive.toString('utf8',offset+30,offset+30+nameLength)!==name||data+compressed>start||uncompressed!==pin[kind].bytes)throw new Error('Invalid pinned Luau member extent.');
    const packed=archive.subarray(data,data+compressed),bytes=method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:pin[kind].bytes});
    nativeBytes(bytes,pin[kind],platform);result[kind]=bytes;
  }
  if(at!==end||!result.runtime||!result.compiler)throw new Error('Pinned Luau test members are missing.');
  return result;
}
async function directDirectory(path){
  const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path)throw new Error('Test runtime directory must be direct and owned.');
}
async function ordinaryFile(path,maximum){
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maximum||await realpath(path)!==path)throw new Error('Unsafe Luau test artifact.');
  const handle=await open(path,'r');
  try{
    const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.nlink!==1||opened.size!==stat.size)throw new Error('Luau test artifact changed while opening.');
    const bytes=Buffer.alloc(maximum+1);let length=0;
    while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
    const after=await handle.stat(),named=await lstat(path);
    if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||named.dev!==stat.dev||named.ino!==stat.ino||named.isSymbolicLink()||named.nlink!==1)throw new Error('Luau test artifact changed.');
    return bytes.subarray(0,length);
  }finally{await handle.close();}
}
const childEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&['path','pathext','systemroot','windir','temp','tmp','home','userprofile','lang','lc_all'].includes(key.toLowerCase())));
function probe(executable,args,expected){
  const result=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384,env:childEnvironment(),cwd:dirname(executable)});
  if(result.error||result.status!==0||result.signal!==null||result.stderr||(typeof expected==='string'?result.stdout.trim()!==expected:!expected.test(result.stdout.trim())))throw new Error('Pinned Luau test probe failed; owned artifacts retained, no retry.');
}
export async function verifyLuauTestInstallation(directory,platform=process.platform){
  if(!isAbsolute(directory))throw new Error('Expected absolute test runtime directory.');await directDirectory(directory);
  const pin=pinFor(platform),members=verifyLuauTestArchive(platform,await ordinaryFile(join(directory,pin.archive),pin.bytes));
  for(const kind of ['runtime','compiler']){const bytes=await ordinaryFile(join(directory,pin[kind].name),pin[kind].bytes);nativeBytes(bytes,pin[kind],platform);if(!bytes.equals(members[kind]))throw new Error('Installed Luau test member differs.');}
  return {runtime:join(directory,pin.runtime.name),compiler:join(directory,pin.compiler.name)};
}
export async function installLuauTestRuntime(){
  if(process.arch!=='x64')throw new Error('Pinned standalone Luau tests require x64.');const pin=pinFor(process.platform);
  const root=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..')),runtime=join(root,'runtime');
  await directDirectory(root);try{await mkdir(runtime,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await directDirectory(runtime);
  const directory=await mkdtemp(join(runtime,'luau-test-runtime-'));await directDirectory(directory);
  const response=await fetch('https://github.com/luau-lang/luau/releases/download/'+LUAU_TEST_RELEASE.version+'/'+pin.archive,{signal:AbortSignal.timeout(45000)});
  if(!response.ok||!response.body)throw new Error('Pinned Luau release download failed.');
  let length=0;const archive=Buffer.alloc(pin.bytes);
  for await(const chunk of response.body){if(length+chunk.length>pin.bytes)throw new Error('Pinned Luau archive exceeded its bound.');archive.set(chunk,length);length+=chunk.length;}
  if(length!==pin.bytes)throw new Error('Pinned Luau archive was incomplete.');
  const members=verifyLuauTestArchive(process.platform,archive);
  await writeFile(join(directory,pin.archive),archive,{flag:'wx',mode:0o600});
  for(const kind of ['runtime','compiler'])await writeFile(join(directory,pin[kind].name),members[kind],{flag:'wx',mode:0o700});
  const paths=await verifyLuauTestInstallation(directory),file=join(directory,'probe.luau');
  await writeFile(file,'print("ARCANE_LUAU_TEST_RUNTIME_0_742")\n',{flag:'wx',mode:0o600});
  probe(paths.runtime,[file],'ARCANE_LUAU_TEST_RUNTIME_0_742');
  probe(paths.compiler,['--null',file],/^Compiled 0 KLOC into 0 KB bytecode \(read [0-9]+\.[0-9]+s, parse [0-9]+\.[0-9]+s, compile [0-9]+\.[0-9]+s\)(?![\s\S])/);
  const proof={schemaVersion:1,kind:'arcane-standalone-luau-test-runtime',...LUAU_TEST_RELEASE,platform:process.platform,arch:'x64',directory,...paths,
    archive:{name:pin.archive,bytes:pin.bytes,sha256:pin.sha256},members:{runtime:pin.runtime,compiler:pin.compiler},vmExecuted:true,compilerExecuted:true,studioOperations:0,inferenceStarted:false};
  await writeFile(join(directory,'verification.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});return proof;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),verify=args[0]==='--verify'&&args.length===2;
  if(!verify&&(args[0]!=='--install'||args.length>2||args.length===2&&args[1]!=='--github-env'))throw new Error('Usage: node scripts/luau-test-runtime.mjs --install [--github-env] | --verify ABSOLUTE_DIRECTORY');
  const proof=verify?{version:LUAU_TEST_RELEASE.version,platform:process.platform,verified:true,executed:false,...await verifyLuauTestInstallation(args[1])}:await installLuauTestRuntime();
  if(args.includes('--github-env')){
    const target=process.env.GITHUB_ENV;if(!target||!isAbsolute(target)||/[\r\n]/.test(target)||/[\r\n]/.test(proof.runtime+proof.compiler))throw new Error('Expected the runner-owned GitHub environment file.');
    await ordinaryFile(target,1024*1024);await appendFile(target,'ARCANE_LUAU_BIN='+proof.runtime+'\nARCANE_LUAU_COMPILE='+proof.compiler+'\n');
  }
  console.log(JSON.stringify(proof));
}
