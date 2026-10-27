import {createHash} from 'node:crypto';
import {types,isDeepStrictEqual} from 'node:util';
import {AssetError,type Artifact} from '../../../packages/asset-pipeline/src/types.js';
import {parseConvertedGlbManifest,parseConvertedGlbJson,CONVERTED_GLB_ARTIFACT_LIMITS} from '../../../packages/asset-pipeline/src/converted-glb-manifest.js';
import {parseConvertedGlbRequest,parseConvertedGlbSourceMap,parseConvertedGlbAudit,convertedGlbAssetId} from '../../../packages/asset-pipeline/src/converted-glb.js';
import {buildConvertedGraph} from '../../../packages/asset-pipeline/src/studio-import-graph.js';
import {CONVERTED_STUDIO_IMPORT_FILE_IDS,snapshotStudioImportSelection,snapshotConvertedStudioImportBaseline,
  type HostConvertedStudioImportV2,type StudioImportSelection,type ConvertedStudioImportBaselineV2} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';

const REQUIRED=['request.json','source-map.json','conversion-audit.json','source.glb','import-source.glb','asset.glb'] as const;
export type ConvertedImportRetainedPath=typeof REQUIRED[number]|'collision.glb';
/** Exactly six retained inputs, plus collision.glb only for convex-hull. This
 * ordinary in-memory map is host-owned; it is never a public request shape. */
export type ConvertedImportRetainedFiles=ReadonlyMap<ConvertedImportRetainedPath,Buffer>;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fail():never {
  throw new AssetError('STUDIO_IMPORT_CONVERTED_EVIDENCE','Converted import inputs differ from their fixed retained byte evidence or host selection.');
}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
/** Read intrinsic storage slots, not caller-defined buffer/length/iterator data. */
function copyBuffer(value:unknown,maximum:number):Buffer {
  if(!value||types.isProxy(value)||!Buffer.isBuffer(value)||Object.getPrototypeOf(value)!==Buffer.prototype)fail();
  try{
    const slot=(name:string):unknown=>Object.getOwnPropertyDescriptor(typedArrayPrototype,name)!.get!.call(value);
    const buffer=slot('buffer'),length=slot('byteLength') as number,offset=slot('byteOffset') as number;
    if(types.isSharedArrayBuffer(buffer)||length<1||length>maximum)fail();
    return Buffer.from(new Uint8Array(buffer as ArrayBuffer,offset,length));
  }catch{fail();}
}
function retained(value:unknown,artifacts:readonly Artifact[],collision:boolean):Map<ConvertedImportRetainedPath,Buffer> {
  if(!value||types.isProxy(value)||!types.isMap(value)||Object.getPrototypeOf(value)!==Map.prototype||Reflect.ownKeys(value).length)fail();
  const paths:readonly ConvertedImportRetainedPath[]=[...REQUIRED,...(collision?['collision.glb' as const]:[])];
  const size=Object.getOwnPropertyDescriptor(Map.prototype,'size')!.get!.call(value) as number;
  if(size!==paths.length)fail();
  const result=new Map<ConvertedImportRetainedPath,Buffer>();let total=0;
  for(const path of paths){
    // Exact size plus the complete fixed key set also rules out extra keys. No
    // supplied Map iterator, get or has method is ever invoked.
    if(!Map.prototype.has.call(value,path))fail();
    const role:Artifact['role']=path==='conversion-audit.json'?'audit':path==='asset.glb'||path==='collision.glb'?'export':'request';
    const artifact=artifacts.find(a=>a.path===path);
    if(!artifact||artifact.role!==role)fail();
    const maximum=path==='source.glb'||path==='import-source.glb'?CONVERTED_GLB_ARTIFACT_LIMITS.sourceBytes:
      role==='export'?CONVERTED_GLB_ARTIFACT_LIMITS.exportBytes:CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes;
    const bytes=copyBuffer(Map.prototype.get.call(value,path),maximum);
    total+=bytes.length;
    if(total>CONVERTED_GLB_ARTIFACT_LIMITS.totalBytes||bytes.length!==artifact.bytes||sha(bytes)!==artifact.sha256)fail();
    result.set(path,bytes);
  }
  return result;
}
function freezeMetadata<T>(value:T):T {
  // File storage is detached above, then snapshotted again by the preparation
  // compiler. Typed arrays cannot be frozen; no original buffer is returned.
  if(value&&typeof value==='object'&&!types.isUint8Array(value)){
    for(const child of Object.values(value))freezeMetadata(child);Object.freeze(value);
  }
  return value;
}

/** Pure host adapter. Call only after service ownership/scope, the FULL retained
 * manifest files and actual worker closure were independently validated. This
 * repeats the six/seven byte lineage checks; metadata grants no native or human
 * authority. No filesystem, target discovery, upload or process action occurs. */
export function adaptCompletedConvertedStudioImport(
  manifestValue:unknown,
  fixedRetainedFilesMap:ConvertedImportRetainedFiles,
  projectId:string,
  hostSelection:StudioImportSelection,
  observedV2Baseline:ConvertedStudioImportBaselineV2|null,
):HostConvertedStudioImportV2 {
  if(typeof projectId!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(projectId))fail();
  const manifest=parseConvertedGlbManifest(manifestValue),files=retained(fixedRetainedFilesMap,manifest.artifacts,manifest.request.collision==='convex-hull');
  const get=(path:ConvertedImportRetainedPath):Buffer=>{const bytes=files.get(path);if(!bytes)fail();return bytes;};
  const requestBytes=get('request.json'),sourceMapBytes=get('source-map.json'),auditBytes=get('conversion-audit.json');
  const request=parseConvertedGlbRequest(parseConvertedGlbJson(requestBytes)),sourceMap=parseConvertedGlbSourceMap(parseConvertedGlbJson(sourceMapBytes),request);
  const audit=parseConvertedGlbAudit(parseConvertedGlbJson(auditBytes),request,sourceMap,sha(requestBytes));
  if(!isDeepStrictEqual(request,manifest.request)||!isDeepStrictEqual(sourceMap,manifest.sourceMap)||!isDeepStrictEqual(audit,manifest.validation))fail();
  const graph=buildConvertedGraph({requestBytes,sourceMapBytes,auditBytes,sourceBytes:get('source.glb'),importBytes:get('import-source.glb'),
    renderBytes:get('asset.glb'),...(request.collision==='convex-hull'?{collisionBytes:get('collision.glb')}:{})});
  const selection=snapshotStudioImportSelection(hostSelection),baseline=observedV2Baseline===null?null:snapshotConvertedStudioImportBaseline(observedV2Baseline);
  const assetId=convertedGlbAssetId(request.sourceSha256);
  if(baseline&&(baseline.manifest.projectId!==projectId||baseline.manifest.assetId!==assetId||
    baseline.manifest.sourceSha256!==request.sourceSha256||!isDeepStrictEqual(baseline.manifest.target,selection.target)))fail();
  const paths=['asset.glb',...(request.collision==='convex-hull'?['collision.glb' as const]:[])] as const;
  const models:HostConvertedStudioImportV2['models']=[],exports:HostConvertedStudioImportV2['files']=[];
  for(const path of paths){
    const model=audit.models.find(m=>m.path===path);if(!model)fail();
    const fileId=path==='asset.glb'?CONVERTED_STUDIO_IMPORT_FILE_IDS.render:CONVERTED_STUDIO_IMPORT_FILE_IDS.collision;
    exports.push({fileId,contentType:'model/gltf-binary',sha256:model.sha256,bytes:get(path)});
    models.push({fileId,resources:[],objects:model.objects.map(object=>({sourceObjectId:object.sourceObjectId,sourceKey:object.sourceKey,
      nodeIndex:object.nodeIndex,role:object.role,pivot:[...object.pivot],collisionFor:[...object.collisionFor]}))});
  }
  const result:HostConvertedStudioImportV2={schemaVersion:2,origin:'converted-glb',identityScheme:'arcane-converted-v2',
    projectId,assetId,revisionId:request.jobId,sourceSha256:request.sourceSha256,conversionRequest:request,graph,
    producer:{blenderVersion:audit.blenderVersion,exporterVersion:audit.models[0]!.generator},
    target:selection.target,placement:selection.placement,studsPerMeter:selection.studsPerMeter,
    files:exports,models,anchors:[],baseline};
  return freezeMetadata(result);
}
