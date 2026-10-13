import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const VERSION='0.186.1';
const INTEGRITY='sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==';
const MODULES=['build/three.module.js','build/three.core.js','examples/jsm/loaders/GLTFLoader.js','examples/jsm/controls/OrbitControls.js','examples/jsm/utils/BufferGeometryUtils.js','examples/jsm/utils/SkeletonUtils.js'];
const SOURCE=join(root,'node_modules/three'),DEST=join(root,'apps/desktop/public/vendor/three');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function direct(file,kind){
 for(let current=file;;current=dirname(current)){
  const info=await lstat(current),actual=await realpath(current);
  if(info.isSymbolicLink()||actual.toLowerCase()!==current.toLowerCase()||(current===file&&kind==='file'? !info.isFile()||info.nlink!==1:!info.isDirectory()))throw Error('Viewer vendor paths must be direct, regular and owned.');
  if(dirname(current)===current)break;
 }
}
async function bytes(file){await direct(file,'file');const value=await readFile(file);if(value.length>4*1024*1024)throw Error('Vendor file budget exceeded.');return value;}
function transformed(path,source){
 const text=source.toString('utf8');
 const output=text.replace(/(\bfrom\s*)['"]three['"]/g,"$1'/vendor/three/build/three.module.js'");
 // The six pinned modules have only static module edges. Check this closed graph
 // before copying; no executable dependency/callback/network source is accepted.
 for(const match of output.matchAll(/^(?:import\s+[^;]*?|export\s+\{[^}]*\})\s+from\s*['"]([^'"]+)['"]\s*;/gm)){
  const edge=match[1];
  if(edge==='/vendor/three/build/three.module.js')continue;
  if(!edge.startsWith('.'))throw Error('Unknown bare/external viewer dependency.');
  const target=resolve(dirname(join(SOURCE,path)),edge).slice(SOURCE.length+1).replaceAll('\\','/');
  if(!MODULES.includes(target))throw Error('Unknown viewer dependency edge.');
 }
 return Buffer.from(output);
}
export async function buildAssetViewerVendor({check=false}={}){
 const lock=JSON.parse(await bytes(join(root,'package-lock.json'))),pkg=JSON.parse(await bytes(join(SOURCE,'package.json')));
 if(lock.packages?.['node_modules/three']?.version!==VERSION||lock.packages['node_modules/three'].integrity!==INTEGRITY||pkg.version!==VERSION||pkg.name!=='three'||pkg.license!=='MIT')throw Error('Viewer dependency differs from the explicitly reviewed official pin.');
 const rows=[];
 for(const path of [...MODULES,'LICENSE']){
  const original=await bytes(join(SOURCE,path)),output=path==='LICENSE'?original:transformed(path,original);
  rows.push({path,original,output,sourceSha256:hash(original),sha256:hash(output),bytes:output.length});
 }
 const manifest=Buffer.from(JSON.stringify({version:1,library:'three',libraryVersion:VERSION,license:'MIT',npmIntegrity:INTEGRITY,
  transform:'Only static bare from-three imports become the same-origin pinned module; no minification or runtime CDN.',files:rows.map(({path,sourceSha256,sha256,bytes})=>({path,sourceSha256,sha256,bytes}))},null,2)+'\n');
 if(!check){await mkdir(DEST,{recursive:true});await direct(DEST,'directory');}
 for(const row of [...rows,{path:'manifest.json',output:manifest}]){
  const target=join(DEST,row.path);
  if(check){if(!(await bytes(target)).equals(row.output))throw Error('Viewer vendor build is stale: '+row.path);}
  else{await mkdir(dirname(target),{recursive:true});await direct(dirname(target),'directory');try{await direct(target,'file');}catch(error){if(error.code!=='ENOENT')throw error;}await writeFile(target,row.output);}
 }
 for(const row of rows)if(hash(await bytes(join(SOURCE,row.path)))!==row.sourceSha256)throw Error('Viewer dependency changed during the vendor build.');
 return {checked:check,version:VERSION,files:rows.length+1,bytes:rows.reduce((n,row)=>n+row.output.length,manifest.length),noNetwork:true};
}
if(process.argv[1]&&isAbsolute(process.argv[1])&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length>3||(process.argv.length===3&&process.argv[2]!=='--check'))throw Error('Only --check is accepted.');
 console.log(JSON.stringify(await buildAssetViewerVendor({check:process.argv[2]==='--check'})));
}
