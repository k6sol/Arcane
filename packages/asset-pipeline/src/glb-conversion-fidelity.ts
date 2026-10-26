import { createHash } from 'node:crypto';
import { types, isDeepStrictEqual } from 'node:util';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { matrixFromTrs, multiplyMatrix4, transformPoint3, transformNormal3, transformVector3, normalize3, type SpatialVector3 } from '../../core/src/spatial-math.js';
import { parseConvertedGlbRequest, parseConvertedGlbSourceMap, parseConvertedGlbAudit,
  type ConvertedGlbRequest, type ConvertedGlbSourceMap, type ConvertedGlbAudit, GLB_CONVERSION_LIMITS } from './converted-glb.js';
import { AssetError } from './types.js';
import { prepareGlbConversionSource } from './glb-conversion-source.js';

type Doc = Record<string, any>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function refused(message: string): never { throw new AssetError('ASSET_CONVERSION_FIDELITY', message); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Doc)[key])).join(',') + '}';
}
/** Explicit half away from zero, shared with the fixed Blender audit. */
export function conversionMillionths(value: number): number {
  const scaled = Math.abs(value) * 1000000;
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.floor(scaled + 0.5))) refused('Conversion sample exceeds its finite precision budget.');
  const result = Math.floor(scaled + 0.5) * (value < 0 ? -1 : 1);
  return result === 0 ? 0 : result;
}
function document(input: Buffer, expected: string, limit: number): { doc: Doc; bin: Buffer } {
  if (types.isProxy(input) || !Buffer.isBuffer(input) || types.isSharedArrayBuffer(input.buffer) || input.length < 20 || input.length > limit) refused('Expected bounded ordinary conversion bytes.');
  const bytes = Buffer.from(input);
  if (sha(bytes) !== expected) refused('Conversion bytes disagree with their retained digest.');
  try { validateGlb(Uint8Array.from(bytes).buffer); } catch { refused('Conversion GLB failed independent structural validation.'); }
  const size = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, 20 + size).toString('utf8')) as Doc, bin: bytes.subarray(28 + size) };
}
function reader(doc: Doc, bin: Buffer): (index: number) => number[][] {
  const cache = new Map<number, number[][]>();
  const width: Record<number, number> = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
  const components: Record<string, number> = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
  const sample = (type: number, at: number) => {
    switch (type) {
      case 5120:return bin.readInt8(at);case 5121:return bin.readUInt8(at);case 5122:return bin.readInt16LE(at);
      case 5123:return bin.readUInt16LE(at);case 5125:return bin.readUInt32LE(at);case 5126:return bin.readFloatLE(at);
      default:return refused('Unsupported conversion component encoding.');
    }
  };
  return index => {
    const old = cache.get(index); if (old) return old;
    const a = doc.accessors[index], size = components[a.type], bytes = width[a.componentType];
    if (!size || !bytes || a.count > 60000) refused('Conversion accessor exceeds the per-part static budget.');
    const normalized = (value: number) => !a.normalized ? value : a.componentType === 5120 ? Math.max(-1,value/127) :
      a.componentType === 5121 ? value/255 : a.componentType === 5122 ? Math.max(-1,value/32767) : a.componentType === 5123 ? value/65535 : refused('Unsupported normalized conversion encoding.');
    const v = a.bufferView === undefined ? undefined : doc.bufferViews[a.bufferView];
    const rows: number[][] = Array.from({length:a.count}, (_, row) => Array.from({length:size}, (_, c) => v ?
      normalized(sample(a.componentType,(v.byteOffset??0)+(a.byteOffset??0)+row*(v.byteStride??size*bytes)+c*bytes)) : 0));
    if (a.sparse) {
      const s=a.sparse, iv=doc.bufferViews[s.indices.bufferView], vv=doc.bufferViews[s.values.bufferView];
      for(let at=0;at<s.count;at++) {
        const row=sample(s.indices.componentType,(iv.byteOffset??0)+(s.indices.byteOffset??0)+at*width[s.indices.componentType]!);
        rows[row]=Array.from({length:size},(_,c)=>normalized(sample(a.componentType,(vv.byteOffset??0)+(s.values.byteOffset??0)+(at*size+c)*bytes)));
      }
    }
    cache.set(index,rows); return rows;
  };
}
function worldMatrices(doc: Doc): Map<number, number[]> {
  const scene=doc.scenes?.[doc.scene??0];if(!scene)refused('Conversion scene is missing.');
  const world=new Map<number,number[]>(), stack=(scene.nodes??[]).map((index:number)=>({index,parent:matrixFromTrs()}));
  while(stack.length) {
    const {index,parent}=stack.pop()!,node=doc.nodes[index];
    if(world.has(index))refused('Conversion scene has ambiguous node ancestry.');
    const m=multiplyMatrix4(parent,node.matrix??matrixFromTrs(node.translation,node.rotation,node.scale));world.set(index,m);
    for(const child of node.children??[])stack.push({index:child,parent:m});
  }
  return world;
}
function hierarchy(doc: Doc): string {
  const roots:number[]=doc.scenes[doc.scene??0].nodes??[],hashes=new Map<number,string>();
  const stack=roots.map(index=>({index,finish:false}));
  while(stack.length){
    const {index,finish}=stack.pop()!,node=doc.nodes[index];
    if(!finish){stack.push({index,finish:true});for(const child of node.children??[])stack.push({index:child,finish:false});continue;}
    const local=node.matrix??matrixFromTrs(node.translation,node.rotation,node.scale);
    hashes.set(index,sha(canonical({matrix:local.map(conversionMillionths),originMarker:node.extras?.arcane_conversion_origin_v1??null,
      children:(node.children??[]).map((child:number)=>hashes.get(child)!).sort()})));
  }
  return sha(canonical(roots.map(index=>hashes.get(index)!).sort()));
}
function triangles(primitive: Doc, read: (index:number)=>number[][]): number[][] {
  const values=primitive.indices===undefined?Array.from({length:read(primitive.attributes.POSITION).length},(_,i)=>i):read(primitive.indices).map(row=>row[0]!);
  const rows:number[][]=[];const mode=primitive.mode??4;
  if(mode===4)for(let at=0;at<values.length;at+=3)rows.push(values.slice(at,at+3));
  else if(mode===5)for(let at=2;at<values.length;at++)rows.push(at%2===0?[values[at-2]!,values[at-1]!,values[at]!]:[values[at-1]!,values[at-2]!,values[at]!]);
  else if(mode===6)for(let at=2;at<values.length;at++)rows.push([values[0]!,values[at-1]!,values[at]!]);
  else refused('Conversion cannot discard non-triangle primitives.');
  if(rows.length>GLB_CONVERSION_LIMITS.meshTriangles)refused('Conversion part exceeds its triangle budget.');
  return rows;
}
const semantic = /^(POSITION|NORMAL|TANGENT|TEXCOORD_[0-7]|COLOR_[0-7])$/;
function geometry(primitive: Doc, world: number[], read: (index:number)=>number[][], required?: string[]): {hash:string;semantics:string[];triangles:number} {
  const names=Object.keys(primitive.attributes).sort();
  if(names.some(name=>!semantic.test(name)))refused('Source contains a semantic requiring an explicit faithful converter.');
  if(required && (required.some(name=>!names.includes(name)) || names.some(name=>!required.includes(name)&&name!=='NORMAL'&&name!=='TANGENT')))
    refused('Conversion lost or substituted a source attribute.');
  const selected=required??names, attributes=Object.fromEntries(selected.map(name=>[name,read(primitive.attributes[name])])), indices=triangles(primitive,read);
  const determinant=world[0]!*(world[5]!*world[10]!-world[6]!*world[9]!)-world[4]!*(world[1]!*world[10]!-world[2]!*world[9]!)+world[8]!*(world[1]!*world[6]!-world[2]!*world[5]!);
  if(!Number.isFinite(determinant)||determinant===0)refused('Conversion has a singular source transform.');
  const rows=indices.map(ids=>{
    const points=ids.map(id=>[...transformPoint3(world,attributes.POSITION![id]! as unknown as SpatialVector3)]);
    const a=points[0]!,u=points[1]!.map((v,i)=>v-a[i]!),v=points[2]!.map((n,i)=>n-a[i]!);
    if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)<=1e-10)refused('Source or converted triangle has zero or below-policy area.');
    const corners=ids.map(id=>{
      const corner:Doc={};
      for(const name of selected) {
        let row=[...attributes[name]![id]!];
        try {
          if(name==='POSITION')row=[...transformPoint3(world,row as unknown as SpatialVector3)];
          else if(name==='NORMAL')row=[...transformNormal3(world,row as unknown as SpatialVector3)];
          else if(name==='TANGENT')row=[...normalize3(transformVector3(world,row.slice(0,3) as unknown as SpatialVector3)),row[3]!*(determinant<0?-1:1)];
          else if(name.startsWith('COLOR_')&&row.length===3)row.push(1);
        } catch { refused('Conversion source directions cannot be transformed faithfully.'); }
        corner[name]=row.map(conversionMillionths);
      }
      return corner;
    });
    // Cyclic order can change; opposite winding cannot.
    return [corners,[corners[1],corners[2],corners[0]],[corners[2],corners[0],corners[1]]].map(canonical).sort()[0]!;
  }).sort();
  return {hash:sha(canonical(rows)),semantics:selected,triangles:rows.length};
}
function materialFingerprint(doc: Doc, bin: Buffer, materialIndex: number | undefined): string {
  const material=structuredClone(materialIndex===undefined?{}:doc.materials[materialIndex]),pbr=material.pbrMetallicRoughness??{};
  material.alphaMode??='OPAQUE';material.doubleSided??=false;material.emissiveFactor??=[0,0,0];
  if(material.alphaMode==='MASK')material.alphaCutoff??=0.5;else delete material.alphaCutoff;
  pbr.baseColorFactor??=[1,1,1,1];pbr.metallicFactor??=1;pbr.roughnessFactor??=1;material.pbrMetallicRoughness=pbr;
  function clean(value: any, field: string): any {
    if(typeof value==='number')return conversionMillionths(value);
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(item=>clean(item,''));
    if(field.endsWith('Texture') && Number.isInteger(value.index)) {
      const texture=doc.textures[value.index],image=doc.images[texture.source],view=doc.bufferViews[image?.bufferView];
      if(!view||image.uri!==undefined||texture.extensions)refused('Image preservation needs an explicit bounded decoder for this source representation.');
      const sampler=doc.samplers?.[texture.sampler]??{};
      // Exact embedded bytes preserve JPEG/PNG pixels without pretending a new
      // codec/re-encode has been verified. A changed encoding is refused below.
      const imageHash=sha(bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength));
      const {index:_index,...rest}=value;rest.texCoord??=0;
      if(field==='normalTexture')rest.scale??=1;if(field==='occlusionTexture')rest.strength??=1;
      return {imageSha256:imageHash,mimeType:image.mimeType,sampler:{wrapS:sampler.wrapS??10497,wrapT:sampler.wrapT??10497,
        magFilter:sampler.magFilter??null,minFilter:sampler.minFilter??null},info:clean(rest,'')};
    }
    return Object.fromEntries(Object.keys(value).filter(key=>key!=='name'&&key!=='extras').sort().map(key=>[key,clean(value[key],key)]));
  }
  return sha(canonical(clean(material,'')));
}

/** Independent source-vs-export comparison from actual GLB bytes, not a worker's
 * boolean or measured hash. Does not establish native execution or Studio fidelity. */
export function verifyGlbConversionFidelity(sourceBytes: Buffer, renderedBytes: Buffer, request: ConvertedGlbRequest,
  sourceMap: ConvertedGlbSourceMap, auditValue: ConvertedGlbAudit, requestSha256: string): readonly {sourceKey:string;geometrySha256:string;materialSha256:string}[] {
  const r=parseConvertedGlbRequest(request),map=parseConvertedGlbSourceMap(sourceMap,r),audit=parseConvertedGlbAudit(auditValue,r,map,requestSha256);
  const model=audit.models.find(model=>model.path==='asset.glb')!,source=document(sourceBytes,r.sourceSha256,GLB_CONVERSION_LIMITS.sourceBytes),
    exported=document(renderedBytes,model.sha256,GLB_CONVERSION_LIMITS.exportedBytes);
  if(sourceBytes.length!==r.sourceBytes)refused('Original source length differs from its retained request.');
  if(renderedBytes.length!==model.byteLength||exported.doc.asset.generator!==model.generator)refused('Actual export disagrees with its measured artifact.');
  if((source.doc.scene??0)!==map.sourceSceneIndex||source.doc.scenes.length!==map.declaredSceneCount)refused('Conversion source scene lineage changed.');
  const marked=prepareGlbConversionSource(sourceBytes,r.sourceSha256);
  if(marked.importSha256!==r.importSha256||marked.importBytes.length!==r.importBytes||!isDeepStrictEqual(marked.parts,map.parts))refused('Conversion marked input or primitive map differs from the actual original source.');
  const markedJsonBytes=marked.importBytes.readUInt32LE(12),markedDoc=JSON.parse(marked.importBytes.subarray(20,20+markedJsonBytes).toString('utf8')) as Doc;
  if(hierarchy(markedDoc)!==hierarchy(exported.doc))refused('Conversion flattened or changed the selected source hierarchy.');
  const sourceWorld=worldMatrices(source.doc),exportWorld=worldMatrices(exported.doc),readSource=reader(source.doc,source.bin),readExport=reader(exported.doc,exported.bin);
  if(exported.doc.nodes.filter((node:Doc)=>node.mesh!==undefined).length!==map.parts.length)refused('Export includes unmapped mesh nodes.');
  return Object.freeze(map.parts.map(part=>{
    const node=source.doc.nodes[part.sourceNodeIndex],primitive=source.doc.meshes[part.sourceMeshIndex]?.primitives[part.sourcePrimitiveIndex];
    if(node.mesh!==part.sourceMeshIndex||!primitive||(primitive.material??null)!==part.sourceMaterialIndex||!isDeepStrictEqual(sourceWorld.get(part.sourceNodeIndex),part.worldMatrix))refused('Conversion lineage disagrees with actual original node ancestry.');
    const object=model.objects.find(object=>object.sourceKey===part.sourceKey)!,out=exported.doc.nodes[object.nodeIndex],extra=out?.extras;
    if(!extra||out.mesh===undefined||extra.arcane_identity_scheme!==audit.identityScheme||extra.arcane_source_object_id!==object.sourceObjectId||
      extra.arcane_source_key!==part.sourceKey||extra.arcane_conversion_origin_v1!==part.originMarker||extra.arcane_role!=='render'||
      !isDeepStrictEqual(extra.arcane_pivot,[0,0,0])||extra.arcane_collision_for!=='[]')refused('Actual export lost mapped producer lineage.');
    const meshes=exported.doc.meshes[out.mesh].primitives;if(meshes.length!==1)refused('Actual export has ambiguous material primitive correspondence.');
    const before=geometry(primitive,part.worldMatrix,readSource),world=exportWorld.get(object.nodeIndex);
    if(!world)refused('Mapped export is outside the selected scene.');
    const after=geometry(meshes[0],world,readExport,before.semantics);
    if(before.triangles!==part.triangles||before.hash!==after.hash)refused('Conversion changed actual source triangle corners, winding, transforms or attributes.');
    const sourceMaterial=materialFingerprint(source.doc,source.bin,primitive.material),outputMaterial=materialFingerprint(exported.doc,exported.bin,meshes[0].material);
    if(sourceMaterial!==outputMaterial)refused('Conversion changed a material, texture binding, image encoding or sampler without independent pixel-preservation evidence.');
    return Object.freeze({sourceKey:part.sourceKey,geometrySha256:before.hash,materialSha256:sourceMaterial});
  }));
}
