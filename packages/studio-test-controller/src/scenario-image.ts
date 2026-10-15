import { inflateSync } from 'node:zlib';
import { SCENARIO_LIMITS } from './scenario.js';

/** Native capture bytes stay outside text reports. Support bounded, CRC-checked
 * noninterlaced RGB/RGBA PNG, without inferring that its contents prove a test. */
export function scenarioPng(bytes: Buffer): {width: number; height: number} {
  const bad = (): never => { throw new Error('Unsupported or invalid bounded capture PNG.'); };
  if (bytes.length > SCENARIO_LIMITS.imageBytes || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) bad();
  let at = 8, width = 0, height = 0, channels = 0, ended = false, afterData = false;
  const parts: Buffer[] = [];
  const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit=0;bit<8;bit++) value=(value>>>1)^((value&1)?0xedb88320:0); } return (value^0xffffffff)>>>0; };
  for (let count = 0; at < bytes.length && count < 4096; count++) {
    if (at + 12 > bytes.length) bad();
    const length = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8), end = at + length + 12;
    if (end > bytes.length || crc(bytes.subarray(at+4,end-4)) !== bytes.readUInt32BE(end-4) || !/^[A-Za-z]{4}$/.test(kind)) bad();
    const data = bytes.subarray(at+8,end-4);
    if (!width && kind !== 'IHDR') bad();
    if (kind === 'IHDR') {
      if (width || length !== 13) bad();
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      if (!width || !height || width>SCENARIO_LIMITS.imageDimension || height>SCENARIO_LIMITS.imageDimension ||
          width*height>SCENARIO_LIMITS.imagePixels || data[8]!==8 || ![2,6].includes(data[9]!) || data[10]!==0 || data[11]!==0 || data[12]!==0) bad();
      channels=data[9]===6?4:3;
    } else if (kind === 'IDAT') { if (afterData || !length) bad(); parts.push(data); }
    else if (kind === 'IEND') { if (length || !parts.length || end!==bytes.length) bad(); ended=true;at=end;break; }
    else { if (parts.length) afterData=true; if (/^[A-Z]/.test(kind) || ['acTL','fcTL','fdAT'].includes(kind)) bad(); }
    at=end;
  }
  if (!ended || at!==bytes.length) bad();
  const stride=width*channels, size=(stride+1)*height;
  let raw: Buffer; try { raw=inflateSync(Buffer.concat(parts),{maxOutputLength:size}); } catch { return bad(); }
  if (raw.length!==size) bad();
  for(let row=0;row<height;row++) if(raw[row*(stride+1)]!>4) bad();
  return {width,height};
}
