import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { scenarioPng } from '../../studio-test-controller/src/scenario-image.js';
import { CodexClientError } from './types.js';

/** Application bounds, below the native 1 MiB frame including base64 and text. */
export const REFERENCE_IMAGE_LIMITS = Object.freeze({ count:4, bytes:512*1024, dimension:4096, pixels:8_000_000, actionBytes:1_000_000 });
export interface ReferenceImage { readonly name:string; readonly dataUrl:string }
export interface ReferenceImageMetadata { readonly name:string; readonly bytes:number; readonly width:number; readonly height:number; readonly sha256:string }
const PREFIX='data:image/png;base64,';
function reject():never{throw new CodexClientError('REFERENCE_IMAGE','Use up to 4 PNG references totaling 512 KiB, at most 4096 pixels per side and 8 megapixels total.');}
function own(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))reject();
  const ds=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(value);
  if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!ds[k]?.enumerable||!Object.hasOwn(ds[k]!,'value')))reject();
  return Object.fromEntries(keys.map(k=>[k,ds[k]!.value as unknown]));
}
/** Bytes only: no URL fetch, filesystem paths, file IDs, decode plugin or authority. */
export function snapshotReferenceImages(value:unknown):readonly ReferenceImage[]{
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>REFERENCE_IMAGE_LIMITS.count)reject();
  if(Reflect.ownKeys(value).length!==value.length+1)reject();
  let total=0,pixels=0;const names=new Set<string>();const result:ReferenceImage[]=[];
  for(let i=0;i<value.length;i++){
    const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))reject();
    const a=own(d.value,['name','dataUrl']),name=a.name,url=a.dataUrl;
    if(typeof name!=='string'||!name||name.length>128||name.trim()!==name||!name.toLowerCase().endsWith('.png')||
      /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\ud800-\udfff\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(name)||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)||names.has(name)||typeof url!=='string'||
      url.length>PREFIX.length+4*Math.ceil((REFERENCE_IMAGE_LIMITS.bytes-total)/3)||!url.startsWith(PREFIX))reject();
    const encoded=url.slice(PREFIX.length);
    if(!encoded||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))reject();
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||(total+=bytes.length)>REFERENCE_IMAGE_LIMITS.bytes)reject();
    let size:{width:number;height:number};try{size=scenarioPng(bytes);}catch{return reject();}
    if(size.width>REFERENCE_IMAGE_LIMITS.dimension||size.height>REFERENCE_IMAGE_LIMITS.dimension||(pixels+=size.width*size.height)>REFERENCE_IMAGE_LIMITS.pixels)reject();
    names.add(name);result.push(Object.freeze({name,dataUrl:url}));
  }
  return Object.freeze(result);
}
export function referenceImageMetadata(images:readonly ReferenceImage[]):readonly ReferenceImageMetadata[]{
  return Object.freeze(images.map(image=>{const bytes=Buffer.from(image.dataUrl.slice(PREFIX.length),'base64'),size=scenarioPng(bytes);
    return Object.freeze({name:image.name,bytes:bytes.length,...size,sha256:createHash('sha256').update(bytes).digest('hex')});}));
}
