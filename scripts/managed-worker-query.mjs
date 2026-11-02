import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
export const WORKER_QUERY_FILES=Object.freeze(['workers/windows/WorkerIdentity.cs','apps/desktop/host-tools/worker-query/ArcaneWorkerQuery.exe','apps/desktop/host-tools/worker-query/manifest.json']);
export const WORKER_QUERY_PIN=Object.freeze({"schemaVersion":1,"kind":"arcane-windows-worker-query","sourceSha256":"da17f3d8a510a2734c6d1594e9bba0ea4ad480f3936214a0985927b287f7e43d","sha256":"a9477cf439f90dacc0330fc18fec93f9843cd779bbfd3c7c80ee6c81824960bb","bytes":5632});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateWorkerQueryFiles(files){
  const get=path=>files.find(file=>file.path===path)?.bytes;
  const declared=WORKER_QUERY_FILES.some(path=>get(path)!==undefined)||get('packages/asset-pipeline/src/worker-identity.ts')?.includes(Buffer.from('NATIVE_WORKER_QUERY_PIN'));
  if(!declared)return;
  const [source,binary,receipt]=WORKER_QUERY_FILES.map(get);
  if(!Buffer.isBuffer(source)||!Buffer.isBuffer(binary)||!Buffer.isBuffer(receipt)||source.length>65536||binary.length!==WORKER_QUERY_PIN.bytes||receipt.length>4096)throw Error('Worker-query source, executable and receipt are required together.');
  let manifest;try{manifest=JSON.parse(receipt);}catch{throw Error('Invalid worker-query receipt.');}
  if(JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify(Object.keys(WORKER_QUERY_PIN).sort())||Object.keys(WORKER_QUERY_PIN).some(key=>manifest[key]!==WORKER_QUERY_PIN[key])||hash(Buffer.from(source.toString('utf8').replace(/\r\n/g,'\n')))!==WORKER_QUERY_PIN.sourceSha256||hash(binary)!==WORKER_QUERY_PIN.sha256||binary[0]!==77||binary[1]!==90)throw Error('Worker query differs from its reviewed source/binary pins.');
}
export function verifyWorkerQuery(root){
  const files=WORKER_QUERY_FILES.map(path=>{
    const full=join(resolve(root),path),stat=fs.lstatSync(full);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024||fs.realpathSync(full).toLowerCase()!==full.toLowerCase())throw Error('Worker query must use direct source-bound files.');
    return {path,bytes:fs.readFileSync(full)};
  });validateWorkerQueryFiles(files);return {sha256:WORKER_QUERY_PIN.sha256,sourceSha256:WORKER_QUERY_PIN.sourceSha256,bytes:WORKER_QUERY_PIN.bytes};
}
