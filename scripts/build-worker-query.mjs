import {readFile,writeFile,mkdir,mkdtemp,lstat,realpath,rename,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBoundedChild} from './check-windows-executable.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32')throw Error('Build the worker query with the Windows .NET compiler.');
const source=join(root,'workers/windows/WorkerIdentity.cs'),output=join(root,'apps/desktop/host-tools/worker-query');
const direct=async(path,directory=false,singleLink=true)=>{const info=await lstat(path);if(info.isSymbolicLink()||(!directory&&(!info.isFile()||singleLink&&info.nlink!==1))||(directory&&!info.isDirectory())||resolve(path).toLowerCase()!==(await realpath(path)).toLowerCase())throw Error('Indirect helper build input/output.');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await direct(source);const input=await readFile(source);
await mkdir(output,{recursive:true});await direct(output,true);
const stage=await mkdtemp(join(output,'.build-'));await direct(stage,true);
const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');// Windows servicing hard-links its reviewed system compiler; generated payloads remain single-link.
await direct(compiler,false,false);
const executable=join(stage,'ArcaneWorkerQuery.exe');
const result=await runBoundedChild(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/out:'+executable,source],{cwd:stage,env:{SystemRoot:process.env.SystemRoot,TEMP:stage,TMP:stage},deadlineMs:120000});
if(result.code!==0)throw Error('Worker query compilation failed; original build output: '+result.output.slice(0,4096));
await direct(executable);const bytes=await readFile(executable);if(bytes.length<1024||bytes.length>1024*1024||bytes[0]!==77||bytes[1]!==90)throw Error('Invalid compiled worker query.');
if(hash(await readFile(source))!==hash(input))throw Error('Worker source changed during compilation.');
const manifest={schemaVersion:1,kind:'arcane-windows-worker-query',sourceSha256:hash(Buffer.from(input.toString('utf8').replace(/\r\n/g,'\n'))),sha256:hash(bytes),bytes:bytes.length};
await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
for(const name of ['ArcaneWorkerQuery.exe','manifest.json']){try{await direct(join(output,name));}catch(error){if(error.code!=='ENOENT')throw error;}await rename(join(stage,name),join(output,name));}
await rmdir(stage);console.log(JSON.stringify(manifest));
