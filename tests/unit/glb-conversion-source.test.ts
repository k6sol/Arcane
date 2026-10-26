import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateGlb,GLB_PREFLIGHT_LIMITS} from '../../apps/desktop/src/glb-preflight.js';
import {prepareGlbConversionSource,GLB_CONVERSION_ORIGIN} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {AssetError} from '../../packages/asset-pipeline/src/types.js';
import {STUDIO_IMPORT_LIMITS} from '../../packages/asset-pipeline/src/studio-import-manifest.js';

// Real bounded GLB containers/accessors/images; pure source preparation only.
// No Blender process, producer receipt, human approval or Studio result is fabricated.
type AccessorType='SCALAR'|'VEC2'|'VEC3'|'VEC4'|'MAT4';
type Component=5121|5123|5126;
interface Accessor {bufferView:number;componentType:Component;count:number;type:AccessorType;min?:number[];max?:number[];normalized?:boolean;extras?:Record<string,unknown>}
interface Primitive {attributes:Record<string,number>;indices?:number;material?:number;mode?:number;targets?:Record<string,number>[];extras?:Record<string,unknown>}
interface Mesh {name?:string;primitives:Primitive[];weights?:number[];extras?:Record<string,unknown>}
interface Node {name?:string;mesh?:number;children?:number[];matrix?:number[];translation?:number[];rotation?:number[];scale?:number[];
  skin?:number;weights?:number[];camera?:number;extensions?:Record<string,unknown>;extras?:Record<string,unknown>}
interface Doc {asset:{version:string;generator?:string;extras?:Record<string,unknown>};buffers:{byteLength:number}[];
  bufferViews:{buffer:number;byteOffset:number;byteLength:number;extras?:Record<string,unknown>}[];accessors:Accessor[];
  meshes:Mesh[];nodes:Node[];scenes:{nodes:number[];extras?:Record<string,unknown>}[];scene?:number;
  materials:Record<string,unknown>[];images:{bufferView:number;mimeType:string;extras?:Record<string,unknown>}[];
  textures:{source:number;sampler?:number;extras?:Record<string,unknown>}[];samplers:Record<string,unknown>[];
  skins?:{joints:number[];skeleton?:number}[];animations?:{samplers:{input:number;output:number;interpolation:string}[];channels:{sampler:number;target:{node:number;path:string}}[]}[];
  cameras?:Record<string,unknown>[];extensionsUsed?:string[];extensions?:Record<string,unknown>;extras?:Record<string,unknown>}
interface Builder {doc:Doc;view(bytes:Uint8Array):number;accessor(values:number[],type:AccessorType,component?:Component,extra?:Partial<Accessor>):number;finish():Buffer}
const digest=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');

// Same valid baseline grayscale JPEG construction used by glb-preflight.test:
// a zero-DC/EOB block, with actual quantization/Huffman/frame/scan data.
function jpeg():Buffer {
  const segment=(marker:number,data:number[]):number[]=>[255,marker,(data.length+2)>>>8,(data.length+2)&255,...data];
  const counts=[1,...Array<number>(15).fill(0)];
  return Buffer.from([255,216,...segment(0xdb,[0,...Array<number>(64).fill(1)]),
    ...segment(0xc0,[8,0,1,0,1,1,1,0x11,0]),...segment(0xc4,[0,...counts,0,0x10,...counts,0]),
    ...segment(0xda,[1,1,0,0,63,0]),0x3f,255,217]);
}

function glb(doc:Doc,bin:Buffer):Buffer {
  const text=Buffer.from(JSON.stringify(doc)),jsonBytes=(text.length+3)&~3,binBytes=(bin.length+3)&~3;
  const bytes=Buffer.alloc(28+jsonBytes+binBytes);
  bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);
  bytes.writeUInt32LE(jsonBytes,12);bytes.writeUInt32LE(0x4e4f534a,16);bytes.fill(32,20,20+jsonBytes);text.copy(bytes,20);
  bytes.writeUInt32LE(binBytes,20+jsonBytes);bytes.writeUInt32LE(0x004e4942,24+jsonBytes);bin.copy(bytes,28+jsonBytes);
  return bytes;
}
function read(bytes:Buffer):{doc:Doc;bin:Buffer;tail:Buffer} {
  validateGlb(bytes);
  const n=bytes.readUInt32LE(12),tail=bytes.subarray(20+n);
  return {doc:JSON.parse(bytes.subarray(20,20+n).toString('utf8')) as Doc,bin:tail.subarray(8),tail};
}
function builder():Builder {
  const doc:Doc={asset:{version:'2.0',generator:'Fixture source; no Blender producer claim'},buffers:[{byteLength:0}],
    bufferViews:[],accessors:[],meshes:[],nodes:[],scenes:[{nodes:[0]}],scene:0,materials:[],images:[],textures:[],samplers:[]};
  const chunks:Buffer[]=[];let length=0;
  function view(value:Uint8Array):number {
    const padding=(4-length%4)%4;if(padding){chunks.push(Buffer.alloc(padding));length+=padding;}
    const bytes=Buffer.from(value),index=doc.bufferViews.length;
    doc.bufferViews.push({buffer:0,byteOffset:length,byteLength:bytes.length});chunks.push(bytes);length+=bytes.length;return index;
  }
  function accessor(values:number[],type:AccessorType,component:Component=5126,extra:Partial<Accessor>={}):number {
    const components:Record<AccessorType,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
    const widths:Record<Component,number>={5121:1,5123:2,5126:4},width=widths[component],raw=Buffer.alloc(values.length*width);
    assert.equal(values.length%components[type],0);
    values.forEach((value,index)=>{if(component===5126)raw.writeFloatLE(value,index*width);
      else if(component===5123)raw.writeUInt16LE(value,index*width);else raw.writeUInt8(value,index);});
    const index=doc.accessors.length;doc.accessors.push({bufferView:view(raw),componentType:component,count:values.length/components[type],type,...extra});return index;
  }
  return {doc,view,accessor,finish(){doc.buffers[0]!.byteLength=length;return glb(doc,Buffer.concat(chunks,length));}};
}
function fixture():Builder {
  const f=builder(),position=f.accessor([0,0,0,1,0,0,0,1,0],'VEC3',5126,{min:[0,0,0],max:[1,1,0]}),
    normal=f.accessor([0,0,1,0,0,1,0,0,1],'VEC3'),uv=f.accessor([0,0,1,0,0,1],'VEC2'),indices=f.accessor([0,1,2],'SCALAR',5123);
  f.doc.materials=[{name:'plain',pbrMetallicRoughness:{baseColorFactor:[0.2,0.4,0.6,1],metallicFactor:0.1,roughnessFactor:0.7}}];
  f.doc.meshes=[{name:'source',primitives:[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv},indices,material:0}]}];
  f.doc.nodes=[{mesh:0,name:'source'}];return f;
}
function rich():Builder {
  const f=builder(),position=f.accessor([0,0,0,1,0,0,0,1,0,0,0,0,0,1,0,-1,0,0],'VEC3',5126,{min:[-1,0,0],max:[1,1,0]}),
    normal=f.accessor(Array.from({length:6},()=>[0,0,1]).flat(),'VEC3'),uv=f.accessor([0,0,1,0,0,1,0.5,0.5,1,1,0,1],'VEC2'),
    tangent=f.accessor(Array.from({length:6},()=>[1,0,0,1]).flat(),'VEC4'),
    color=f.accessor(Array.from({length:6},()=>[255,128,64,255]).flat(),'VEC4',5121,{normalized:true});
  const first=f.accessor([0,1,2],'SCALAR',5123),second=f.accessor([3,4,5],'SCALAR',5123),both=f.accessor([0,1,2,3,4,5],'SCALAR',5123);
  f.doc.images=[{bufferView:f.view(PNG),mimeType:'image/png'},{bufferView:f.view(jpeg()),mimeType:'image/jpeg'}];
  f.doc.samplers=[{magFilter:9729,minFilter:9987,wrapS:10497,wrapT:33648}];
  f.doc.textures=[{source:0,sampler:0},{source:1,sampler:0}];
  f.doc.materials=[
    {name:'bark',pbrMetallicRoughness:{baseColorFactor:[0.4,0.25,0.1,1],baseColorTexture:{index:0,texCoord:0},metallicFactor:0.2,roughnessFactor:0.8,metallicRoughnessTexture:{index:1}},
      normalTexture:{index:0,scale:0.75},occlusionTexture:{index:1,strength:0.4},emissiveFactor:[0.1,0.2,0.3],emissiveTexture:{index:1}},
    {name:'open leaves',doubleSided:true,alphaMode:'MASK',alphaCutoff:0.42,pbrMetallicRoughness:{baseColorFactor:[0.2,0.7,0.15,1],
      baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:0.6,metallicRoughnessTexture:{index:1}},normalTexture:{index:1,scale:0.5}},
  ];
  const attributes={POSITION:position,NORMAL:normal,TEXCOORD_0:uv,TANGENT:tangent,COLOR_0:color};
  f.doc.meshes=[{name:'duplicate name',primitives:[{attributes:{...attributes},indices:first,material:0},{attributes:{...attributes},indices:second,material:1}]},
    {name:'duplicate name',primitives:[{attributes:{...attributes},indices:both,material:1}]}];
  f.doc.nodes=[
    {name:'root',translation:[10,20,30],rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,3,4],children:[1,3,4]},
    {name:'branch',matrix:[1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1],children:[2]},
    {name:'duplicate name',mesh:0,translation:[5,-1,2]},
    {name:'duplicate name',mesh:1,matrix:[0,0,-1,0,0,1,0,0,1,0,0,0,-2,1,0,1]},
    {name:'duplicate name',mesh:0},
  ];return f;
}
function codeIs(code:string):(error:unknown)=>boolean {
  return (error:unknown):boolean=>{assert.ok(error instanceof AssetError);assert.equal(error.code,code);return true;};
}
function refused(f:Builder,code:string):void {
  const bytes=f.finish(),before=Buffer.from(bytes);assert.doesNotThrow(()=>validateGlb(bytes),'The unsupported feature fixture must be a valid preview GLB.');
  assert.throws(()=>prepareGlbConversionSource(bytes,digest(bytes)),codeIs(code));assert.deepEqual(bytes,before);
}
function close(actual:readonly number[],expected:readonly number[]):void {
  assert.equal(actual.length,expected.length);actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index]!)<1e-10,'world matrix entry '+index));
}
function withoutExtras(value:unknown):unknown {
  if(Array.isArray(value))return value.map(withoutExtras);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='extras').map(([key,item])=>[key,withoutExtras(item)]));
  return value;
}

test('conversion source preserves real multimesh/material/instance data, open foliage and seam vertices',()=>{
  const f=rich(),source=f.finish(),before=Buffer.from(source),original=read(source),result=prepareGlbConversionSource(source,digest(source)),prepared=read(result.importBytes);
  assert.deepEqual(source,before);assert.equal(result.sourceSha256,digest(before));assert.equal(result.sourceBytes,before.length);
  assert.equal(result.importSha256,digest(result.importBytes));assert.equal(result.sourceSceneIndex,0);assert.equal(result.declaredSceneCount,1);
  assert.equal(result.parts.length,5);assert.deepEqual(result.parts.map(part=>[part.sourceNodeIndex,part.sourceMeshIndex,part.sourcePrimitiveIndex,part.sourceMaterialIndex,part.triangles]),
    [[2,0,0,0,1],[2,0,1,1,1],[3,1,0,1,2],[4,0,0,0,1],[4,0,1,1,1]]);
  assert.deepEqual(prepared.tail,original.tail,'Every BIN byte, including UV seams, colors, tangents and embedded JPEG/PNG, remains unchanged.');
  for(const field of ['accessors','bufferViews','materials','images','textures','samplers','buffers'] as const)assert.deepEqual(prepared.doc[field],original.doc[field]);
  assert.equal(prepared.doc.asset.generator,original.doc.asset.generator,'Source preparation does not replace the source generator with invented Blender evidence.');
  assert.equal(prepared.doc.materials[1]!.doubleSided,true);assert.equal(prepared.doc.materials[1]!.alphaMode,'MASK');
  const distinctNodes=new Set<number>(),markers=new Set<string>(),keys=new Set<string>();
  for(const part of result.parts){const node=prepared.doc.nodes[part.importNodeIndex]!;assert.ok(node);assert.notEqual(node.mesh,undefined);
    const mesh=prepared.doc.meshes[node.mesh!]!;assert.equal(mesh.primitives.length,1);
    assert.deepEqual(mesh.primitives[0],original.doc.meshes[part.sourceMeshIndex]!.primitives[part.sourcePrimitiveIndex]);
    assert.deepEqual(node.extras,{[GLB_CONVERSION_ORIGIN]:part.originMarker});
    distinctNodes.add(part.importNodeIndex);markers.add(part.originMarker);keys.add(part.sourceKey);
  }
  assert.equal(distinctNodes.size,5);assert.equal(markers.size,5);assert.equal(keys.size,5);
  assert.equal(prepared.doc.nodes.length,original.doc.nodes.length+5);assert.deepEqual(prepared.doc.scenes,[{nodes:[0]}]);
  assert.equal(Object.hasOwn(result,'producer'),false);assert.equal(Object.hasOwn(result,'approved'),false);assert.equal(Object.hasOwn(result,'engineVerification'),false);
});

test('conversion source retains ancestry and literal measured world correspondence through primitive splitting',()=>{
  const f=rich(),source=f.finish(),result=prepareGlbConversionSource(source,digest(source)),prepared=read(result.importBytes).doc;
  const expected:Record<number,number[]>={
    2:[0,2,0,0,-3,0,0,0,0,0,4,0,7,32,50,1],
    3:[0,0,-4,0,-3,0,0,0,0,2,0,0,7,16,30,1],
    4:[0,2,0,0,-3,0,0,0,0,0,4,0,10,20,30,1],
  };
  for(let index=0;index<f.doc.nodes.length;index++){
    const node=prepared.nodes[index]!,original=f.doc.nodes[index]!;
    assert.equal(node.mesh,undefined);assert.equal(node.name,original.name);
    for(const field of ['matrix','translation','rotation','scale'] as const)assert.deepEqual(node[field],original[field]);
    const children=[...(original.children??[]),...result.parts.filter(part=>part.sourceNodeIndex===index).map(part=>part.importNodeIndex)];
    assert.deepEqual(node.children??[],children);
  }
  for(const part of result.parts){close(part.worldMatrix,expected[part.sourceNodeIndex]!);
    const child=prepared.nodes[part.importNodeIndex]!;assert.equal(child.matrix,undefined);assert.equal(child.translation,undefined);
    assert.equal(child.rotation,undefined);assert.equal(child.scale,undefined,'Split parts inherit, rather than apply the source transform a second time.');}
});

test('conversion source selects the declared scene and preserves original indices while remapping only selected hierarchy',()=>{
  const f=fixture();f.doc.nodes=[{mesh:0,name:'not selected'},{name:'selected root',translation:[4,5,6],children:[2]},
    {mesh:0,name:'selected leaf',translation:[1,2,3]}];f.doc.scenes=[{nodes:[0]},{nodes:[1]}];f.doc.scene=1;
  const source=f.finish(),result=prepareGlbConversionSource(source,digest(source)),prepared=read(result.importBytes);
  assert.equal(result.sourceSceneIndex,1);assert.equal(result.declaredSceneCount,2);assert.equal(result.parts.length,1);
  const part=result.parts[0]!;assert.equal(part.sourceNodeIndex,2);assert.equal(part.sourceMeshIndex,0);assert.equal(part.importNodeIndex,2);
  assert.equal(prepared.doc.scene,0);assert.deepEqual(prepared.doc.scenes,[{nodes:[0]}]);assert.equal(prepared.doc.nodes[0]!.name,'selected root');
  assert.deepEqual(prepared.doc.nodes[0]!.children,[1]);assert.deepEqual(prepared.doc.nodes[1]!.children,[2]);
  close(part.worldMatrix,[1,0,0,0,0,1,0,0,0,0,1,0,5,7,9,1]);assert.deepEqual(prepared.tail,read(source).tail);
  delete f.doc.scene;const fallback=f.finish(),selected=prepareGlbConversionSource(fallback,digest(fallback));
  assert.equal(selected.sourceSceneIndex,0);assert.equal(selected.declaredSceneCount,2);assert.equal(selected.parts[0]!.sourceNodeIndex,0);
});

test('conversion source strips nested spoofed extras and installs only unique host origin markers',()=>{
  const f=rich(),spoof={ [GLB_CONVERSION_ORIGIN]:'forged origin',arcane_source_object_id:'arcane_'+'a'.repeat(64),arcane_role:'collision',
    arcane_identity_scheme:'arcane-semantic-v1',approval:'approved',nested:{extras:{permission:'granted'}}};
  f.doc.extras=structuredClone(spoof);f.doc.asset.extras=structuredClone(spoof);f.doc.scenes[0]!.extras=structuredClone(spoof);
  for(const node of f.doc.nodes)node.extras=structuredClone(spoof);
  for(const mesh of f.doc.meshes){mesh.extras=structuredClone(spoof);for(const primitive of mesh.primitives)primitive.extras=structuredClone(spoof);}
  for(const material of f.doc.materials)material.extras=structuredClone(spoof);
  for(const image of f.doc.images)image.extras=structuredClone(spoof);
  for(const accessor of f.doc.accessors)accessor.extras=structuredClone(spoof);
  const source=f.finish(),before=Buffer.from(source),result=prepareGlbConversionSource(source,digest(source)),prepared=read(result.importBytes);
  const allowed=new Set<unknown>(result.parts.map(part=>prepared.doc.nodes[part.importNodeIndex]));let extrasCount=0;
  function inspect(value:unknown):void {
    if(Array.isArray(value)){value.forEach(inspect);return;}
    if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value))if(key==='extras'){
      assert.ok(allowed.has(value),'Only the actual split mesh nodes may have prepared extras.');
      assert.deepEqual(Object.keys(item as Record<string,unknown>),[GLB_CONVERSION_ORIGIN]);extrasCount++;
    }else inspect(item);
  }
  inspect(prepared.doc);assert.equal(extrasCount,result.parts.length);assert.deepEqual(source,before);
  assert.deepEqual(prepared.doc.materials,withoutExtras(f.doc.materials));assert.deepEqual(prepared.tail,read(source).tail);
  assert.ok(result.parts.every(part=>part.originMarker!=='forged origin'));
});

test('conversion source returns detached caller-owned import copies and frozen lineage records',()=>{
  const source=fixture().finish(),retained=Buffer.from(source),first=prepareGlbConversionSource(source,digest(source)),second=prepareGlbConversionSource(source,digest(source));
  assert.notEqual(first.importBytes,second.importBytes);assert.deepEqual(first.importBytes,second.importBytes);
  assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first.parts),true);
  assert.equal(Object.isFrozen(first.parts[0]),true);assert.equal(Object.isFrozen(first.parts[0]!.worldMatrix),true);
  assert.equal(Reflect.set(first,'sourceSha256','changed'),false);assert.equal(Reflect.set(first.parts[0]!,'originMarker','changed'),false);
  assert.equal(Reflect.set(first.parts[0]!.worldMatrix,'0',999),false);
  first.importBytes.fill(0);assert.deepEqual(source,retained);assert.equal(digest(second.importBytes),second.importSha256);
  source.fill(0);assert.equal(second.sourceSha256,digest(retained));assert.equal(digest(second.importBytes),second.importSha256);
});

test('conversion origins remain bound to exact retained bytes even when only stripped metadata differs',()=>{
  const f=fixture(),firstSource=f.finish(),first=prepareGlbConversionSource(firstSource,digest(firstSource));
  f.doc.extras={note:'A different retained source with the same geometry.'};
  const secondSource=f.finish(),second=prepareGlbConversionSource(secondSource,digest(secondSource));
  assert.notEqual(first.sourceSha256,second.sourceSha256);assert.deepEqual(read(firstSource).tail,read(secondSource).tail);
  assert.equal(first.parts[0]!.sourceNodeIndex,second.parts[0]!.sourceNodeIndex);
  assert.equal(first.parts[0]!.sourceKey,second.parts[0]!.sourceKey);
  assert.notEqual(first.parts[0]!.originMarker,second.parts[0]!.originMarker);assert.notEqual(first.importSha256,second.importSha256);
});

test('conversion source preserves BLEND, additional PBR channels and absent material slots without claiming engine support',()=>{
  const f=rich();f.doc.materials[1]!.alphaMode='BLEND';const source=f.finish(),result=prepareGlbConversionSource(source,digest(source));
  assert.deepEqual(read(result.importBytes).doc.materials,f.doc.materials);assert.deepEqual(read(result.importBytes).tail,read(source).tail);
  const plain=fixture();delete plain.doc.meshes[0]!.primitives[0]!.material;
  const noMaterial=plain.finish(),prepared=prepareGlbConversionSource(noMaterial,digest(noMaterial));
  assert.equal(prepared.parts[0]!.sourceMaterialIndex,null);
  assert.equal(read(prepared.importBytes).doc.meshes[0]!.primitives[0]!.material,undefined);
});

for(const mode of [4,5,6])test('conversion source retains topology mode '+mode+' and the actual indexed triangle count',()=>{
  const f=fixture(),position=f.accessor([0,0,0,1,0,0,0,1,0,1,1,0],'VEC3',5126,{min:[0,0,0],max:[1,1,0]}),
    normal=f.accessor([0,0,1,0,0,1,0,0,1,0,0,1],'VEC3'),uv=f.accessor([0,0,1,0,0,1,1,1],'VEC2'),
    indices=f.accessor(mode===4?[0,1,2,2,1,3]:[0,1,2,3],'SCALAR',5123);
  f.doc.meshes[0]!.primitives=[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv},indices,material:0,mode}];
  const source=f.finish(),result=prepareGlbConversionSource(source,digest(source));assert.equal(result.parts[0]!.triangles,2);
  assert.deepEqual(read(result.importBytes).doc.meshes[0]!.primitives[0],f.doc.meshes[0]!.primitives[0]);
});

for(const mode of [0,1,2,3])test('conversion source explicitly refuses point/line topology mode '+mode+' without losing the source',()=>{
  const f=fixture();f.doc.meshes[0]!.primitives[0]!.mode=mode;
  if(mode===1)f.doc.meshes[0]!.primitives[0]!.indices=f.accessor([0,1],'SCALAR',5123);
  refused(f,'ASSET_CONVERSION_TOPOLOGY');
});

test('conversion source refuses a genuine skinned mesh instead of flattening joint/weight data',()=>{
  const f=fixture(),primitive=f.doc.meshes[0]!.primitives[0]!;
  primitive.attributes.JOINTS_0=f.accessor(Array<number>(12).fill(0),'VEC4',5121);
  primitive.attributes.WEIGHTS_0=f.accessor([1,0,0,0,1,0,0,0,1,0,0,0],'VEC4');
  f.doc.nodes[0]!.skin=0;f.doc.nodes.push({name:'joint'});f.doc.scenes[0]!.nodes.push(1);f.doc.skins=[{joints:[1],skeleton:1}];
  refused(f,'ASSET_CONVERSION_ANIMATION');
});

test('conversion source refuses actual morph target/weight data instead of silently choosing a pose',()=>{
  const f=fixture(),delta=f.accessor(Array<number>(9).fill(0),'VEC3',5126,{min:[0,0,0],max:[0,0,0]});
  f.doc.meshes[0]!.primitives[0]!.targets=[{POSITION:delta}];f.doc.meshes[0]!.weights=[0];f.doc.nodes[0]!.weights=[0];
  refused(f,'ASSET_CONVERSION_ANIMATION');
});

test('conversion source refuses real translation animation channels instead of discarding time samples',()=>{
  const f=fixture(),time=f.accessor([0,1],'SCALAR',5126,{min:[0],max:[1]}),output=f.accessor([0,0,0,1,2,3],'VEC3');
  f.doc.animations=[{samplers:[{input:time,output,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}];
  refused(f,'ASSET_CONVERSION_ANIMATION');
});

test('conversion source explicitly refuses valid camera scene data',()=>{
  const f=fixture();f.doc.cameras=[{type:'perspective',perspective:{yfov:0.7,znear:0.1,zfar:100,aspectRatio:1}}];
  f.doc.nodes.push({camera:0});f.doc.scenes[0]!.nodes.push(1);refused(f,'ASSET_CONVERSION_SCENE');
});

test('conversion source does not bypass preview admission for unsupported light extensions or invalid GLB data',()=>{
  const f=fixture();f.doc.extensionsUsed=['KHR_lights_punctual'];f.doc.extensions={KHR_lights_punctual:{lights:[{type:'directional'}]}};
  f.doc.nodes[0]!.extensions={KHR_lights_punctual:{light:0}};
  const lights=f.finish();assert.throws(()=>prepareGlbConversionSource(lights,digest(lights)),codeIs('ASSET_CONVERSION_GLB'));
  const valid=fixture().finish();
  for(const mutate of [(bytes:Buffer):void=>{bytes.writeUInt32LE(bytes.length+4,8);},(bytes:Buffer):void=>{bytes[0]=0;}]){
    const invalid=Buffer.from(valid);mutate(invalid);assert.throws(()=>prepareGlbConversionSource(invalid,digest(invalid)),codeIs('ASSET_CONVERSION_GLB'));
  }
});

test('conversion source refuses an empty selected scene and does not silently select another scene',()=>{
  const f=fixture();f.doc.scenes=[{nodes:[]},{nodes:[0]}];f.doc.scene=0;refused(f,'ASSET_CONVERSION_EMPTY');
  f.doc.scenes=[];delete f.doc.scene;refused(f,'ASSET_CONVERSION_SCENE');
});

test('conversion source enforces exact retained digest, actual Buffer ownership and nonshared source memory',()=>{
  const valid=fixture().finish(),retained=Buffer.from(valid);
  for(const expected of ['0'.repeat(64),digest(valid).toUpperCase(),'not-a-hash'])assert.throws(()=>prepareGlbConversionSource(valid,expected),codeIs('ASSET_CONVERSION_SOURCE'));
  assert.throws(()=>prepareGlbConversionSource(new Uint8Array(valid) as unknown as Buffer,digest(valid)),codeIs('ASSET_CONVERSION_SOURCE'));
  let observed=0;const proxy=new Proxy(valid,{get(){observed++;throw new Error('Source proxy must not be observed.');}});
  assert.throws(()=>prepareGlbConversionSource(proxy,digest(valid)),codeIs('ASSET_CONVERSION_SOURCE'));assert.equal(observed,0);
  const shared=Buffer.from(new SharedArrayBuffer(valid.length));valid.copy(shared);
  assert.throws(()=>prepareGlbConversionSource(shared,digest(valid)),codeIs('ASSET_CONVERSION_SOURCE'));assert.deepEqual(valid,retained);
  const changed=Buffer.from(valid);changed[changed.length-1]=changed[changed.length-1]!^1;
  assert.throws(()=>prepareGlbConversionSource(changed,digest(valid)),codeIs('ASSET_CONVERSION_SOURCE'));
});

function instances(count:number,triangles=1):Builder {
  const f=fixture();f.doc.meshes[0]!.primitives[0]!.indices=f.accessor(Array.from({length:triangles*3},(_,index)=>index%3),'SCALAR',5123);
  f.doc.nodes=Array.from({length:count},()=>({mesh:0,name:'same name'}));f.doc.scenes[0]!.nodes=Array.from({length:count},(_,index)=>index);return f;
}
test('conversion source bounds selected part count without capping unique source meshes or confusing instances',()=>{
  const accepted=instances(STUDIO_IMPORT_LIMITS.objects),source=accepted.finish(),result=prepareGlbConversionSource(source,digest(source));
  assert.equal(result.parts.length,128);assert.equal(new Set(result.parts.map(part=>part.originMarker)).size,128);
  assert.ok(result.parts.every(part=>part.sourceMeshIndex===0));refused(instances(STUDIO_IMPORT_LIMITS.objects+1),'ASSET_CONVERSION_BUDGET');
});

test('conversion source enforces per-part and aggregate submitted triangle budgets at their exact boundaries',()=>{
  const one=instances(1,STUDIO_IMPORT_LIMITS.meshTriangles),source=one.finish();
  assert.equal(prepareGlbConversionSource(source,digest(source)).parts[0]!.triangles,20_000);
  refused(instances(1,STUDIO_IMPORT_LIMITS.meshTriangles+1),'ASSET_CONVERSION_BUDGET');
  const five=instances(5,STUDIO_IMPORT_LIMITS.meshTriangles),all=five.finish(),result=prepareGlbConversionSource(all,digest(all));
  assert.equal(result.parts.reduce((sum,part)=>sum+part.triangles,0),100_000);
  refused(instances(6,STUDIO_IMPORT_LIMITS.meshTriangles),'ASSET_CONVERSION_BUDGET');
});

test('conversion source accounts for added correspondence nodes in the bounded import-copy inventory',()=>{
  const f=fixture();f.doc.nodes=[{children:Array.from({length:GLB_PREFLIGHT_LIMITS.nodes-1},(_,index)=>index+1)},
    {mesh:0},...Array.from({length:GLB_PREFLIGHT_LIMITS.nodes-2},()=>({}))];
  assert.equal(f.doc.nodes.length,4096);refused(f,'ASSET_CONVERSION_BUDGET');
});


test('conversion lineage remains valid embedded data for every leading SHA-256 hex digit',()=>{
  const f=fixture(),seen=new Set<string>();
  for(let attempt=0;attempt<4096&&seen.size<16;attempt++){
    f.doc.asset.generator=`marker-custody-${attempt}`;
    const source=f.finish(),hash=digest(source),leading=hash[0]!;
    if(seen.has(leading))continue;
    const result=prepareGlbConversionSource(source,hash);
    validateGlb(Uint8Array.from(result.importBytes).buffer);
    for(const part of result.parts)assert.equal(part.originMarker,`glb_${hash}:${part.sourceNodeIndex}:${part.sourcePrimitiveIndex}`);
    seen.add(leading);
  }
  assert.equal(seen.size,16);
});
