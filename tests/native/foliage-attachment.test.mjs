import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded, workerEnvironment } from '../../dist/packages/asset-pipeline/src/process.js';
import { atomicAssetJson } from '../../dist/packages/asset-pipeline/src/atomic-json.js';
import { noLinks, readRegularFile, regularFile } from '../../dist/packages/asset-pipeline/src/paths.js';
import { decodeMaterialPng, materialPngPixels } from '../../dist/packages/asset-pipeline/src/material-png.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceNames = ['workers/blender/procedural.py', 'workers/blender/textures.py', 'tests/native/foliage-attachment.py',
  'workers/blender/asset_worker.py', 'workers/blender/audit.py'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readRegularFile(join(repository, name), 512 * 1024))])));

function originalTextures(bytes) {
  // Exact inverse to a FULL reviewed original module, never a projected algorithm.
  let text = bytes.toString('utf8');
  const newline = text.includes('\r') ? '\r\n' : '\n';
  if (newline === '\r\n') assert.ok(!text.replaceAll('\r\n', '').includes('\r') && !text.replaceAll('\r\n', '').includes('\n'));
  const replacements = [
    [[
      '    for number, (points, w) in enumerate(shoots):',
      "        # Only the painted basal endpoint follows the card's fixed UV root.",
      '        # Keep generated shoots and their random consumers unchanged.',
      '        painted = [np.array(p) for p in points]',
      '        if number == 0:',
      '            painted[0] = np.array((width * .5, 2.0))',
      '        canvas.twig(painted, [w * (1 - .55 * k / (len(points) - 1)) for k in range(len(points))], bark)',
    ], [
      '    for points, w in shoots:',
      '        canvas.twig([np.array(p) for p in points], [w * (1 - .55 * k / (len(points) - 1)) for k in range(len(points))], bark)',
    ]],
    [[
      '        # Do not alter points: their arc length controls seeded needle counts.',
      '        painted = [(width * .5, 2.0), *points[1:]] if number == 0 else points',
      '        marks.append((0.0, "twig", (painted, widths)))',
    ], ['        marks.append((0.0, "twig", (points, widths)))']],
  ];
  for (const [after, before] of replacements) {
    const fragment = after.join(newline);
    assert.equal(text.split(fragment).length, 2, 'Original inverse requires one exact reviewed paint edit.');
    text = text.replace(fragment, before.join(newline));
  }
  const original = Buffer.from(text, 'utf8');
  assert.ok(['166392242ea95622b92f0cf51d14c9dbe433381f4f3d161921cc1ef030f62cd2',
    '37aabeae667a63db3e608293b2268356aff5cdc216a2bb2d3394837e331eae4d'].includes(sha(original)), 'Complete original module must match its reviewed LF/CRLF pin.');
  return original;
}

function model(bytes) {
  assert.ok(bytes.length >= 28 && bytes.length <= 20_000_000);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const size = bytes.readUInt32LE(12); assert.ok(size > 0 && size <= 1024 * 1024 && size % 4 === 0);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a); assert.ok(28 + size <= bytes.length);
  const doc = JSON.parse(bytes.subarray(20, 20 + size).toString('utf8'));
  assert.equal(bytes.readUInt32LE(24 + size), 0x004e4942); assert.equal(bytes.readUInt32LE(20 + size), bytes.length - 28 - size);
  const binary = bytes.subarray(28 + size); assert.equal(doc.buffers.length, 1);
  assert.ok(doc.buffers[0].byteLength <= binary.length && binary.length - doc.buffers[0].byteLength <= 3);
  return { doc, binary };
}

function floats(data, index, components) {
  const a = data.doc.accessors[index], view = data.doc.bufferViews[a.bufferView];
  assert.equal(a.componentType, 5126); assert.equal(a.type, components === 3 ? 'VEC3' : 'VEC2'); assert.equal(a.sparse, undefined);
  assert.equal(view.buffer, 0); assert.ok(Number.isSafeInteger(a.count) && a.count > 0 && a.count <= 1024);
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? components * 4;
  assert.ok(stride >= components * 4 && stride <= 252 && stride % 4 === 0);
  assert.ok(start >= (view.byteOffset ?? 0) && start + (a.count - 1) * stride + components * 4 <= (view.byteOffset ?? 0) + view.byteLength);
  assert.ok((view.byteOffset ?? 0) + view.byteLength <= data.binary.length);
  return Array.from({ length: a.count }, (_, n) => Array.from({ length: components }, (_, c) => {
    const value = data.binary.readFloatLE(start + n * stride + c * 4); assert.ok(Number.isFinite(value)); return value;
  }));
}

function alphaPixels(data, imageIndex) {
  const image = data.doc.images[imageIndex]; assert.equal(image.mimeType, 'image/png'); assert.equal(image.uri, undefined);
  const view = data.doc.bufferViews[image.bufferView]; assert.equal(view.buffer, 0);
  const start = view.byteOffset ?? 0; assert.ok(start >= 0 && view.byteLength > 0 && view.byteLength <= 8 * 1024 * 1024 && start + view.byteLength <= data.binary.length);
  const encoded = data.binary.subarray(start, start + view.byteLength), decoded = decodeMaterialPng(encoded);
  assert.equal(decoded.width, 512); assert.equal(decoded.height, 512); assert.equal(encoded[24], 8); assert.equal(encoded[25], 6);
  const pixels = materialPngPixels(decoded), alpha = Uint8Array.from({ length: 512 * 512 }, (_, i) => pixels[i * 4 + 3]);
  return alpha;
}

function linear(alpha, u, v) {
  const x = u * 512 - .5, y = v * 512 - .5, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  assert.ok(ix >= 0 && iy >= 0 && ix + 1 < 512 && iy + 1 < 512);
  return (alpha[iy * 512 + ix] * (1-fx) * (1-fy) + alpha[iy * 512 + ix+1] * fx * (1-fy)
    + alpha[(iy+1) * 512 + ix] * (1-fx) * fy + alpha[(iy+1) * 512 + ix+1] * fx * fy) / 255;
}

function probeExport(data, probe) {
  const nodes = data.doc.nodes.filter(node => node.name === probe.name && node.mesh !== undefined); assert.equal(nodes.length, 1);
  const primitives = data.doc.meshes[nodes[0].mesh].primitives; assert.equal(primitives.length, 1);
  const primitive = primitives[0], positions = floats(data, primitive.attributes.POSITION, 3), uv = floats(data, primitive.attributes.TEXCOORD_0, 2);
  assert.equal(positions.length, uv.length);
  const corners = probe.basalPoints.map(([x, y, z]) => {
    const expected = [x, z, -y], found = positions.flatMap((point, i) => Math.hypot(...point.map((v, k) => v-expected[k])) <= 4e-6 ? [uv[i]] : []);
    assert.ok(found.length > 0, 'Read actual exported basal positions; never assume export vertex order.');
    assert.ok(found.every(value => value.every((v, k) => Math.abs(v-found[0][k]) <= 1e-7))); return found[0];
  });
  const root = [0, 1].map(k => (corners[0][k]+corners[1][k]) / 2), expected = [probe.rootUv[0], 1-probe.rootUv[1]];
  assert.ok(root.every((v, i) => Math.abs(v-expected[i]) <= 1e-7), 'Actual glTF UV must match its own declared card root, including V orientation.');
  const material = data.doc.materials[primitive.material]; assert.equal(material.name, probe.materialName);
  assert.equal(material.alphaMode, 'MASK'); assert.equal(material.alphaCutoff ?? .5, .5); assert.equal(material.pbrMetallicRoughness.baseColorFactor?.[3] ?? 1, 1);
  const info = material.pbrMetallicRoughness.baseColorTexture; assert.equal(info.texCoord ?? 0, 0); assert.equal(info.extensions, undefined);
  const texture = data.doc.textures[info.index], sampler = data.doc.samplers[texture.sampler];
  assert.equal(sampler.magFilter, 9729); assert.ok([9729, 9987].includes(sampler.minFilter));
  assert.equal(sampler.wrapS ?? 10497, 10497); assert.equal(sampler.wrapT ?? 10497, 10497);
  const alpha = alphaPixels(data, texture.source);
  assert.equal(sha(alpha), probe.pngAlphaTopDownSha256, 'Full native PNG alpha readback must match actual embedded top-down PNG orientation.');
  const value = linear(alpha, ...root); assert.ok(value >= 1-1/255); assert.ok(Math.abs(value-probe.rootAlpha) <= 1/255);
  const distal = [(probe.column*128+probe.firstDistalPixel[0])/512, 1-(probe.row*256+probe.firstDistalPixel[1])/512];
  const steps = Math.max(1, Math.ceil(Math.hypot(...distal.map((v, i) => (v-root[i])*512))*2));
  let minimum = 1;
  for (let n = 0; n <= steps; n++) minimum = Math.min(minimum, linear(alpha, ...root.map((v, i) => v+(distal[i]-v)*n/steps)));
  assert.ok(minimum >= .5); assert.ok(Math.abs(minimum-probe.minimumContinuousAlpha) <= 1/255);
  assert.ok(linear(alpha, root[0] + 20/512, root[1]) < .5, 'Transparent basal card outside the stalk is not an opaque bridge.');
  return { name: probe.name, rootUv: root, rootAlpha: value, minimumContinuousAlpha: minimum, material: primitive.material, texture: info.index, minFilter: sampler.minFilter };
}

// Separate mandatory hosted test: the original conversion acceptance inventory,
// deadlines, source fixtures, supervisor and evidence names are untouched.
test('real Blender preserves a cupped foliage card declared root through native save/reopen', { timeout: 210000 }, async t => {
  const configured = process.env.ARCANE_TEST_BLENDER_EXECUTABLE;
  assert.ok(typeof configured === 'string' && isAbsolute(configured), 'Explicit owned pinned Blender is required; this native regression cannot skip.');
  assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const executable = await realpath(configured); await regularFile(executable, 512 * 1024 * 1024);
  const before = await sourceHashes(), base = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(base, 'arcane-foliage-attachment-')));
  await mkdir(join(root, '.worker')); await noLinks(root);
  const evidence = join(repository, 'runtime', 'ci-foliage-attachment-artifacts');
  await mkdir(evidence); // Exclusive fresh evidence set, matching conversion's no-reuse boundary.
  const supervision = { spawned: false, pid: null, closed: false };
  let outcome = { exitCode: null, signal: null, errorCode: null }, native = null, checked = false, alphaReadback = null;
  const cleanup = { temporaryDataRemoved: false, retainedForUnprovedClosure: false };
  const persist = complete => {
    const json = JSON.stringify({ schemaVersion: 1, expectedVersion: '5.2.3', sourceHashes: before, supervision, outcome, native, alphaReadback, complete, cleanup,
      studioOperations: 0, inferenceStarted: false, nativeStudioVerified: false }) + '\n';
    assert.ok(Buffer.byteLength(json) <= 65536, 'Retained diagnostic JSON stays bounded.');
    return atomicAssetJson(evidence, 'foliage-attachment.json', json);
  };
  await persist(false);
  t.after(async () => {
    try {
      try {
        native = JSON.parse((await readRegularFile(join(root, 'native-foliage.json'), 65536)).toString('utf8'));
      } catch { native = null; }
      for (const name of ['foliage-front.png', 'foliage-side.png', 'foliage-alpha-front.png', 'foliage-alpha-oblique.png']) {
        try {
          const encoded = await readRegularFile(join(root, name), 8 * 1024 * 1024);
          const decoded = decodeMaterialPng(encoded); assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
          assert.equal(encoded[24], 8, 'Native PNG must retain 8-bit samples.');
          assert.equal(encoded[25], 6, 'Native PNG must retain the requested RGBA channels.');
          assert.equal(encoded[28], 0, 'Native PNG must be noninterlaced for the production decoder.');
          const pixels = materialPngPixels(decoded); assert.ok(pixels.some((value, index) => index % 4 < 3 && value !== pixels[index % 4]), 'Contact render must contain actual geometry contrast.');
          await writeFile(join(evidence, name), encoded, { flag: 'wx' });
        } catch (error) { if (error?.code !== 'ENOENT' || checked) throw error; }
      }
      if (supervision.closed) {
        const actual = await realpath(root), child = relative(base, actual);
        assert.ok(!isAbsolute(child) && child.startsWith('arcane-foliage-attachment-') && !child.includes(sep) && !child.includes('..'));
        await noLinks(actual); await rm(actual, { recursive: true, force: true }); cleanup.temporaryDataRemoved = true;
      } else { cleanup.retainedForUnprovedClosure = true; t.diagnostic('Owned data retained because child closure was not observed.'); }
    } finally { await persist(checked && supervision.closed && cleanup.temporaryDataRemoved); }
  });
  const original = originalTextures(await readRegularFile(join(repository, 'workers/blender/textures.py'), 512 * 1024));
  await writeFile(join(root, 'baseline-textures.py'), original, { flag: 'wx' });
  let result;
  try {
    result = await runBounded({ executable, cwd: root, env: workerEnvironment(join(root, '.worker')),
      args: ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1',
        '--python', join(repository, 'tests', 'native', 'foliage-attachment.py'), '--', '--directory', root,
        '--worker-sha256', before['workers/blender/procedural.py'], '--textures-sha256', before['workers/blender/textures.py'],
        '--baseline-sha256', sha(original), '--exporter-sha256', before['workers/blender/asset_worker.py'], '--audit-sha256', before['workers/blender/audit.py']] },
    { deadlineMs: 180000, maxOutputBytes: 2 * 1024 * 1024, supervise: {
      spawned: async info => { supervision.spawned = true; supervision.pid = info.pid ?? null; await persist(false); return 'continue'; },
      closed: () => { supervision.closed = true; },
    } });
    outcome = { exitCode: result.exitCode, signal: result.signal, errorCode: null };
  } catch (error) { outcome.errorCode = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'NATIVE_TEST_FAILED'; throw error; }
  assert.equal(supervision.closed, true, 'Only the observed owned close permits cleanup.');
  assert.equal(result.exitCode, 0, result.stdout + '\n' + result.stderr); assert.equal(result.signal, null);
  assert.deepEqual(await sourceHashes(), before, 'Actual imported production sources must remain unchanged.');
  native = JSON.parse((await readRegularFile(join(root, 'native-foliage.json'), 65536)).toString('utf8'));
  assert.equal(native.schemaVersion, 1); assert.deepEqual(native.versionTuple, [5, 2, 3]);
  assert.match(native.version, /^5\.2\.3(?: LTS)?$/); assert.equal(native.complete, true);
  assert.equal(native.workerSha256, before['workers/blender/procedural.py']); assert.equal(native.texturesSha256, before['workers/blender/textures.py']);
  assert.equal(native.cases.length, 39); assert.deepEqual(native.failures, []); assert.equal(native.savedSceneReopened, true);
  assert.ok(native.cases.every(item => item.vertices === 8 && item.triangles === 12 && item.nativeRootErrorMeters <= 4e-6));
  assert.ok(native.contactGapMeters <= 4e-6); assert.equal(native.atlasDiagnostics.length, 24);
  const alpha = native.alphaContact;
  assert.equal(alpha.baselineSha256, sha(original)); assert.equal(alpha.baseline.length, 24);
  assert.ok(alpha.baseline.some(probe => probe.filteredRootAlpha < .5), 'Full original module control must refuse visible-root attachment.');
  assert.equal(alpha.rawChecks, 96); assert.equal(alpha.upperAndRngChecks, 12); assert.ok(alpha.minimumContinuousAlpha >= .5); assert.equal(alpha.probes.length, 24);
  assert.equal(alpha.renderedContactGapsMeters.length, 3); assert.ok(alpha.renderedContactGapsMeters.every(gap => Number.isFinite(gap) && gap <= 4e-6));
  const bytes = await readRegularFile(join(root, 'alpha-contact.glb'), 20_000_000), data = model(bytes);
  const probes = alpha.probes.map(probe => probeExport(data, probe));
  const first = alpha.probes[0], row = probes[0];
  const opaque = JSON.parse(JSON.stringify(data.doc)); opaque.materials[row.material].alphaMode = 'OPAQUE';
  assert.throws(() => probeExport({ doc: opaque, binary: data.binary }, first), 'An opaque card cannot certify cutout contact.');
  const flipped = Buffer.from(data.binary), node = data.doc.nodes.find(value => value.name === first.name);
  const primitive = data.doc.meshes[node.mesh].primitives[0], accessor = data.doc.accessors[primitive.attributes.TEXCOORD_0], view = data.doc.bufferViews[accessor.bufferView];
  for (let n = 0; n < accessor.count; n++) {
    const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + n * (view.byteStride ?? 8) + 4;
    flipped.writeFloatLE(1-flipped.readFloatLE(at), at);
  }
  assert.throws(() => probeExport({ doc: data.doc, binary: flipped }, first), 'A second V flip in the actual exported accessor cannot certify the declared root.');
  const swapped = JSON.parse(JSON.stringify(data.doc));
  swapped.textures[row.texture].source = swapped.textures[swapped.materials[row.material].normalTexture.index].source;
  assert.throws(() => probeExport({ doc: swapped, binary: data.binary }, first), 'Another actual image cannot substitute for the mapped atlas.');
  alphaReadback = { glbSha256: sha(bytes), glbBytes: bytes.length, probes, negativeChecks: 3, imported: false, nativeStudioVerified: false };
  assert.equal(native.nativeStudioVerified, false);
  checked = true;
});
