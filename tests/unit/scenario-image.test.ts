import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioPng } from '../../packages/studio-test-controller/src/scenario-image.js';
import { png } from '../../packages/asset-pipeline/testing/fixture.js';
import { pngCrc } from '../../packages/asset-pipeline/src/validation.js';

function ancillary():Buffer {
  const data=Buffer.from('fixture\0synthetic'),chunk=Buffer.alloc(12+data.length);
  chunk.writeUInt32BE(data.length);chunk.write('teXt',4);data.copy(chunk,8);
  chunk.writeUInt32BE(pngCrc(chunk.subarray(4,-4)),chunk.length-4);
  const original=png();return Buffer.concat([original.subarray(0,33),chunk,original.subarray(33)]);
}
function changeType(original:Buffer,kind:string,index:number,value:(byte:number)=>number):Buffer {
  const bytes=Buffer.from(original);let at=8;
  for(let count=0;at<bytes.length&&count<8;count++){
    const length=bytes.readUInt32BE(at),end=at+12+length;
    if(bytes.toString('latin1',at+4,at+8)===kind){
      bytes[at+4+index]=value(bytes[at+4+index]!);
      bytes.writeUInt32BE(pngCrc(bytes.subarray(at+4,end-4)),end-4);
      return bytes;
    }
    at=end;
  }
  assert.fail('Synthetic chunk is missing.');
}

test('bounded capture parser accepts actual RGB PNG bytes and a valid ancillary chunk',()=>{
  assert.deepEqual(scenarioPng(png()),{width:128,height:128});
  assert.deepEqual(scenarioPng(ancillary()),{width:128,height:128});
});
for(const kind of ['IHDR','IDAT','IEND','teXt'])for(let index=0;index<4;index++){
  test('CRC-valid high-bit chunk type is rejected before '+kind+' byte '+index+' dispatch',()=>{
    const bytes=changeType(ancillary(),kind,index,byte=>byte|0x80);
    assert.throws(()=>scenarioPng(bytes),/Unsupported or invalid bounded capture PNG/);
  });
}
test('CRC-valid nonletter ASCII chunk types remain invalid in every byte position',()=>{
  for(const kind of ['IHDR','IDAT','IEND','teXt'])for(let index=0;index<4;index++)for(const byte of [0,0x30,0x7f])
    assert.throws(()=>scenarioPng(changeType(ancillary(),kind,index,()=>byte)),/Unsupported or invalid bounded capture PNG/);
});
