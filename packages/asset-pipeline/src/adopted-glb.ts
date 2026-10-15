import {types, isDeepStrictEqual} from 'node:util';
import {isAbsolute, resolve, relative, sep, posix} from 'node:path';
import {realpath} from 'node:fs/promises';
import {validateGlb, GLB_PREFLIGHT_LIMITS, type GlbMetadata} from '../../../apps/desktop/src/glb-preflight.js';
import {AssetError, type Artifact} from './types.js';
import {assetName, artifactPath, noLinks, readRegularFile, within} from './paths.js';
import {sha256} from './validation.js';

export interface AdoptGlbInput {name:string;path:string}
export interface AdoptedGlbRequest extends AdoptGlbInput {
 schemaVersion:1;template:'adopted-glb';sourceSha256:string;sourceBytes:number;
 // Generated-only fields never occur in adopted wire data. Optional-never keeps
 // existing consumers honest without inventing normalized generation settings.
 recipe?:never;seed?:never;sizeMeters?:never;color?:never;triangleBudget?:never;renderResolution?:never;renderSamples?:never;
}
export interface AdoptedGlbManifest {
 schemaVersion:1;jobId:string;createdAt:string;request:AdoptedGlbRequest;
 provenance:{kind:'native-project-glb';projectId:string;conversation:{provider:'codex';threadId:string;sessionId:string|null};sourceSha256:string;sourceBytes:number};
 validation:{kind:'glb-preview-preflight';metadata:GlbMetadata;imageDecode:'not-run';engineVerification:'pending'};
 engineImport:{status:'unavailable';reason:'adopted-origin-requires-safe-conversion'};
 artifacts:Artifact[];limitations:string[];
}
export const ADOPTED_GLB_LIMITS=Object.freeze({bytes:GLB_PREFLIGHT_LIMITS.bytes,pathBytes:4096,segments:64,deadlineMs:30_000});
function fail(code='ASSET_ADOPT_INPUT'):never {throw new AssetError(code,'Owned project GLB adoption refused; no import or upload was accepted.');}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))fail();
 const proto:unknown=Object.getPrototypeOf(value),own=Reflect.ownKeys(value);
 if(proto!==Object.prototype&&proto!==null||own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();
 const descriptors=Object.getOwnPropertyDescriptors(value),out:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
 for(const key of keys){const d=descriptors[key];if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail();out[key]=d.value as unknown;}
 return out;
}
export function parseAdoptGlbInput(value:unknown):AdoptGlbInput {
 const a=fields(value,['name','path']);const name=assetName(a.name),p=a.path;
 if(typeof p!=='string'||Buffer.from(p).toString('utf8')!==p||Buffer.byteLength(p)>ADOPTED_GLB_LIMITS.pathBytes||!p||isAbsolute(p)||p.includes('\\')
  ||/[\x00-\x1f\x7f<>:"|?*]/.test(p)||!p.toLowerCase().endsWith('.glb')||posix.normalize(p)!==p)fail();
 const segments=p.split('/');
 if(segments.length>ADOPTED_GLB_LIMITS.segments||segments.some(s=>!s||s==='.'||s==='..'||s==='.git'||/[. ]$/.test(s)
  ||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)))fail();
 return Object.freeze({name,path:p});
}
export function isAdoptedGlbRequest(value:unknown):value is AdoptedGlbRequest {
 return !!value&&typeof value==='object'&&!types.isProxy(value)&&Object.getOwnPropertyDescriptor(value,'template')?.value==='adopted-glb';
}
export function parseAdoptedGlbRequest(value:unknown):AdoptedGlbRequest {
 const r=fields(value,['schemaVersion','template','name','path','sourceSha256','sourceBytes']);
 if(r.schemaVersion!==1||r.template!=='adopted-glb'||!digest(r.sourceSha256)||!natural(r.sourceBytes,ADOPTED_GLB_LIMITS.bytes)||!r.sourceBytes)fail();
 return {schemaVersion:1,template:'adopted-glb',...parseAdoptGlbInput({name:r.name,path:r.path}),sourceSha256:r.sourceSha256,sourceBytes:r.sourceBytes};
}
export function isAdoptedGlbManifest(value:unknown):value is AdoptedGlbManifest {
 return !!value&&typeof value==='object'&&isAdoptedGlbRequest((value as {request?:unknown}).request);
}
/** Ordinary-file byte admission only. Caller supplies the original branded scope
 * guard. Never reads URLs, executes Python or uses file metadata as rights proof. */
export async function readOwnedProjectGlb(projectPath:string,managedRoot:string,input:AdoptGlbInput,guard:()=>void):Promise<{bytes:Buffer;metadata:GlbMetadata}> {
 const checked=parseAdoptGlbInput(input),source=resolve(projectPath,...checked.path.split('/'));
 if(!isAbsolute(projectPath)||!within(projectPath,source)||source===projectPath||within(managedRoot,source))fail('ASSET_ADOPT_PATH');
 const wait=async<T>(p:Promise<T>):Promise<T>=>{const result=await p;guard();return result;};
 guard();await wait(noLinks(projectPath));await wait(noLinks(source));
 const canonicalProject=await wait(realpath(projectPath)),canonicalSource=await wait(realpath(source));
 const part=relative(canonicalProject,canonicalSource);
 if(canonicalProject!==projectPath||canonicalSource!==source||!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part))fail('ASSET_ADOPT_PATH');
 const bytes=await wait(readRegularFile(source,ADOPTED_GLB_LIMITS.bytes));
 let metadata:GlbMetadata;
 try{metadata=validateGlb(Uint8Array.from(bytes).buffer);}catch{fail('ASSET_ADOPT_GLB');}
 guard();await wait(noLinks(source));
 if(await wait(realpath(source))!==canonicalSource)fail('ASSET_ADOPT_PATH');
 return {bytes,metadata};
}
function natural(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Closed data schema; this is provenance DATA, never native/rights admission. */
export function parseAdoptedGlbManifest(value:unknown):AdoptedGlbManifest {
 const m=fields(value,['schemaVersion','jobId','createdAt','request','provenance','validation','engineImport','artifacts','limitations']);
 const request=parseAdoptedGlbRequest(m.request),p=fields(m.provenance,['kind','projectId','conversation','sourceSha256','sourceBytes']);
 const c=fields(p.conversation,['provider','threadId','sessionId']),v=fields(m.validation,['kind','metadata','imageDecode','engineVerification']);
 const meta=fields(v.metadata,['nodeCount','meshCount','triangleEstimate','imagePixels','animations']);
 const engine=fields(m.engineImport,['status','reason']);
 const id=(x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(x);
 if(m.schemaVersion!==1||typeof m.jobId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.jobId)
  ||typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||p.kind!=='native-project-glb'||!digest(p.projectId)||!digest(p.sourceSha256)
  ||!natural(p.sourceBytes,ADOPTED_GLB_LIMITS.bytes)||!p.sourceBytes||c.provider!=='codex'||!id(c.threadId)||(c.sessionId!==null&&!id(c.sessionId))
  ||v.kind!=='glb-preview-preflight'||v.imageDecode!=='not-run'||v.engineVerification!=='pending'
  ||engine.status!=='unavailable'||engine.reason!=='adopted-origin-requires-safe-conversion'
  ||p.sourceSha256!==request.sourceSha256||p.sourceBytes!==request.sourceBytes)fail('ASSET_ADOPT_MANIFEST');
 for(const k of ['nodeCount','meshCount','triangleEstimate','imagePixels','animations'])if(!natural(meta[k]))fail('ASSET_ADOPT_MANIFEST');
 if(!Array.isArray(m.artifacts)||m.artifacts.length!==2||!Array.isArray(m.limitations)||m.limitations.length>16
  ||m.limitations.some(x=>typeof x!=='string'||x.length>2048))fail('ASSET_ADOPT_MANIFEST');
 const seen=new Set<string>();
 for(const raw of m.artifacts){const a=fields(raw,['path','role','bytes','sha256']);
  if(typeof a.path!=='string'||seen.has(a.path)||a.role!==(a.path==='asset.glb'?'export':a.path==='request.json'?'request':null)
   ||!natural(a.bytes,ADOPTED_GLB_LIMITS.bytes)||!a.bytes||!digest(a.sha256))fail('ASSET_ADOPT_MANIFEST');seen.add(a.path);
  if(a.path==='asset.glb'&&(a.sha256!==p.sourceSha256||a.bytes!==p.sourceBytes))fail('ASSET_ADOPT_MANIFEST');
 }
 return structuredClone({...m,request}) as unknown as AdoptedGlbManifest;
}
/** Revalidates the MANAGED snapshot, never the mutable original source file. */
export async function validateAdoptedGlbManifest(directory:string,value:unknown):Promise<AdoptedGlbManifest> {
 const m=parseAdoptedGlbManifest(value);
 for(const artifact of m.artifacts){
  const bytes=await readRegularFile(artifactPath(directory,artifact.path),ADOPTED_GLB_LIMITS.bytes);
  if(bytes.length!==artifact.bytes||sha256(bytes)!==artifact.sha256)fail('HASH');
  if(artifact.path==='asset.glb'){
   let metadata:GlbMetadata;try{metadata=validateGlb(Uint8Array.from(bytes).buffer);}catch{fail('ASSET_ADOPT_GLB');}
   if(!isDeepStrictEqual(metadata,m.validation.metadata))fail('ASSET_ADOPT_MANIFEST');
  }else{
   let request:unknown;try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('ASSET_ADOPT_MANIFEST');}
   if(!isDeepStrictEqual(parseAdoptedGlbRequest(request),m.request))fail('ASSET_ADOPT_MANIFEST');
  }
 }
 return m;
}
