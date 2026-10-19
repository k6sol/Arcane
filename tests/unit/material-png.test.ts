import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeMaterialPng, materialPngPixels, MaterialPngError, MATERIAL_PNG_LIMITS } from '../../packages/asset-pipeline/src/material-png.js';

function chunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]); let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
function png(raw: number[], colour = 6, width = 1, height = 1, extra: Buffer[] = [], packed = deflateSync(Buffer.from(raw))): Buffer {
  const header = Buffer.from([0,0,0,0,0,0,0,0,8,colour,0,0,0]); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extra, chunk('IDAT', packed), chunk('IEND', Buffer.alloc(0))]);
}
const error = (code: MaterialPngError['code']) => (value: unknown) => value instanceof MaterialPngError && value.code === code;

test('material PNG preserves exact straight alpha and copies channels for engine PBR maps', () => {
  const bytes = png([0,12,34,56,78]), image = decodeMaterialPng(bytes);
  assert.equal(image.width, 1); assert.equal(image.height, 1); assert.equal(Object.isFrozen(image), true);
  assert.equal(image.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...materialPngPixels(image)], [12,34,56,78]);
  assert.equal(image.rgbaSha256, createHash('sha256').update(Buffer.from([12,34,56,78])).digest('hex'));
  assert.deepEqual([...materialPngPixels(image, 'rgb')], [12,34,56,255]);
  assert.deepEqual([...materialPngPixels(image, 'g')], [34,34,34,255], 'glTF roughness green becomes an engine red-channel map');
  assert.deepEqual([...materialPngPixels(image, 'b')], [56,56,56,255], 'glTF metalness blue becomes an engine red-channel map');
  assert.deepEqual([...materialPngPixels(image, 'r')], [12,12,12,255]);
  assert.deepEqual([...materialPngPixels(image, 'a')], [78,78,78,255]);
  materialPngPixels(image).fill(0); bytes.fill(0);
  assert.deepEqual([...materialPngPixels(image)], [12,34,56,78], 'source and consumer mutations cannot change retained pixels');
  assert.throws(() => materialPngPixels({ ...image }), error('HANDLE'));
  let traps = 0; const proxy = new Proxy(image, { get() { traps++; throw Error('read'); } });
  assert.throws(() => materialPngPixels(proxy), error('HANDLE')); assert.equal(traps, 0);
});

test('8-bit grey, grey-alpha, RGB and tRNS samples retain their actual pixel values', () => {
  assert.deepEqual([...materialPngPixels(decodeMaterialPng(png([0,42], 0)))], [42,42,42,255]);
  assert.deepEqual([...materialPngPixels(decodeMaterialPng(png([0,40,0,200,128], 4, 2)))], [40,40,40,0,200,200,200,128]);
  assert.deepEqual([...materialPngPixels(decodeMaterialPng(png([0,12,34,56], 2)))], [12,34,56,255]);
  assert.deepEqual([...materialPngPixels(decodeMaterialPng(png([0,42], 0, 1, 1, [chunk('tRNS', Buffer.from([0,42]))])))], [42,42,42,0]);
  assert.deepEqual([...materialPngPixels(decodeMaterialPng(png([0,12,34,56], 2, 1, 1, [chunk('tRNS', Buffer.from([0,12,0,34,0,56]))])))], [12,34,56,0]);
});

test('all five scanline filters decode known RGB rows, including Paeth left/up/corner selection', () => {
  const top = [10,20,30,40,50,60], bottom = [15,25,35,45,55,65];
  const encoded = [[15,25,35,45,55,65], [15,25,35,30,30,30], [5,5,5,5,5,5], [10,15,20,18,18,18], [5,5,5,5,5,5]];
  for (let filter = 0; filter < 5; filter++) {
    const image = decodeMaterialPng(png([0,...top,filter,...encoded[filter]!], 2, 2, 2));
    const expected = [...top, ...bottom].flatMap((_, index, all) => index % 3 === 0 ? [all[index]!,all[index + 1]!,all[index + 2]!,255] : []);
    assert.deepEqual([...materialPngPixels(image)], expected, String(filter));
  }
  const paeth = decodeMaterialPng(png([0,50,50,10,20,50,60,4,30,20,20,40,80,246], 2, 2, 2));
  assert.deepEqual([...materialPngPixels(paeth)].slice(8), [80,70,30,255,90,150,50,255]);
});

test('material PNG rejects corrupt, animated, ambiguous and unsupported encodings before producing a handle', () => {
  const valid = png([0,1,2,3,255]); const corrupt = Buffer.from(valid); corrupt[corrupt.length - 5]! ^= 1;
  const unknown = chunk('ABCD', Buffer.alloc(0)), animation = chunk('acTL', Buffer.alloc(8));
  for (const bytes of [corrupt, valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]),
    png([5,1,2,3,4]), png([0,1,2,3]), png([0,1,2,3,4,5]), png([0,1,2,3,4], 6, 1, 1, [unknown]),
    png([0,1,2,3,4], 6, 1, 1, [animation]), png([0,1,2,3,4], 6, 1, 1, [chunk('tRNS', Buffer.alloc(2))]),
    png([0,1,2,3,4], 6, 1, 1, [], Buffer.concat([deflateSync(Buffer.from([0,1,2,3,4])), Buffer.from([1])])),
    png([0,1,2,3,4], 3), png([0,1,2,3,4], 6, 1, 1, [], deflateSync(Buffer.alloc(1_000_000))),
  ]) assert.throws(() => decodeMaterialPng(bytes), error('PNG'));
  const header = Buffer.from([0,0,0,1,0,0,0,1,16,6,0,0,0]);
  assert.throws(() => decodeMaterialPng(Buffer.concat([valid.subarray(0,8), chunk('IHDR', header), valid.subarray(33)])), error('PNG'));
});

test('pixel, dimension and byte budgets apply before decompression; ancillary metadata does not alter samples', () => {
  assert.throws(() => decodeMaterialPng(png([0], 6, MATERIAL_PNG_LIMITS.dimension + 1)), error('LIMIT'));
  assert.throws(() => decodeMaterialPng(Buffer.alloc(MATERIAL_PNG_LIMITS.bytes + 1)), error('LIMIT'));
  const original = png([0,9,8,7,6]), tagged = png([0,9,8,7,6], 6, 1, 1, [chunk('tEXt', Buffer.from('source\0original'))]);
  const a = decodeMaterialPng(original), b = decodeMaterialPng(tagged);
  assert.notEqual(a.sourceSha256, b.sourceSha256); assert.equal(a.rgbaSha256, b.rgbaSha256);
});
