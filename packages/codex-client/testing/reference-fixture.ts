/** Synthetic image bytes for offline input-boundary tests. No image/provider API. */
import {deflateSync} from 'node:zlib';
import {pngCrc} from '../../asset-pipeline/src/validation.js';
export function referencePng(width=128,height=128,totalBytes?:number):Buffer{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>8_388_608)throw new Error('Fixture pixel bound.');
  const chunk=(kind:string,data:Buffer)=>{const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(kind,4);data.copy(bytes,8);bytes.writeUInt32BE(pngCrc(bytes.subarray(4,-4)),bytes.length-4);return bytes;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const parts=[Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))];
  const initial=Buffer.concat(parts);
  if(totalBytes===undefined)return initial;
  if(!Number.isSafeInteger(totalBytes)||totalBytes<initial.length+12||totalBytes>524289)throw new Error('Fixture byte bound.');
  // Valid unknown ancillary/private chunk; codec ignores it, real frame does not.
  return Buffer.concat([...parts.slice(0,-1),chunk('raNd',Buffer.alloc(totalBytes-initial.length-12,97)),parts.at(-1)!]);
}
export const referenceInput=(bytes=referencePng(),name='reference.png')=>({name,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});
