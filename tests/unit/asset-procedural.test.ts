import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { audit, glb, png } from '../../packages/asset-pipeline/testing/fixture.js';
import { AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { normalizeProcedural, proceduralSize, PROCEDURAL_LIMITS } from '../../packages/asset-pipeline/src/procedural.js';
import { sha256, validateAudit, validateManifestFiles, workerScripts } from '../../packages/asset-pipeline/src/validation.js';
import type { AssetAudit, AssetManifest, Artifact } from '../../packages/asset-pipeline/src/types.js';
import { assetInput, assetRequest, assetManifest } from '../../apps/mcp/src/asset-schemas.js';
import { proceduralInput, proceduralStartBody, registerProceduralTools, registerProceduralPlaceTool, MESH_PARTS_CAPABILITY } from '../../apps/mcp/src/procedural-tools.js';
import { ARCANE_NATIVE_TOOL_NAMES, ARCANE_TOOL_NAMES, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from '../../apps/mcp/src/daemon-client.js';

const code = (expected: string) => (e: unknown): boolean => e instanceof AssetError && e.code === expected;
const tree = (extra: Record<string, unknown> = {}) => normalizeRequest({ template: 'procedural', name: 'oak-tree', procedural: { kind: 'tree', species: 'oak', ...extra } });

test('procedural requests normalize canonically with derived size, colour and bounded budget', () => {
  const request = tree();
  assert.deepEqual(request.procedural, { kind: 'tree', species: 'oak', height: 9, trunkTaper: 0.55, branchLevels: 2, leafDensity: 0.7, trunkRadius: null, secondaryColor: [0.12, 0.25, 0.06] });
  assert.equal(request.triangleBudget, 16000); assert.equal(request.renderResolution, 512);
  assert.deepEqual(request.sizeMeters, proceduralSize(request.procedural!));
  assert.deepEqual(request.color, [0.22, 0.18, 0.14]);
  // Stored requests re-normalize to themselves (manifest/request provenance relies on it).
  assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(request))), request);
  for (const kind of ['rock', 'column', 'foliage', 'log', 'stump'] as const) {
    const r = normalizeRequest({ template: 'procedural', name: kind + '-a', procedural: { kind } });
    assert.equal(r.procedural!.kind, kind); assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(r))), r);
    assert.equal(r.triangleBudget, PROCEDURAL_LIMITS.defaultTriangles[kind]);
  }
});

test('procedural parameters reject code, unknown fields, out-of-range values and impossible budgets', () => {
  const bad: unknown[] = [
    { kind: 'tree', python: 'import os' }, { kind: 'tree', species: 'baobab' }, { kind: 'tree', height: 40 }, { kind: 'tree', branchLevels: 1.5 },
    { kind: 'tree', leafDensity: -1 }, { kind: 'rock', size: [1, 1] }, { kind: 'rock', size: [1, 1, 30] }, { kind: 'column', flutes: 4 },
    { kind: 'column', radius: 1, height: 2 }, { kind: 'foliage', style: 'cactus' }, { kind: 'teapot' }, { kind: 'tree', script: 'x' },
    { kind: 'log', species: 'pine' }, { kind: 'log', length: 30 }, { kind: 'log', ends: 'chewed' }, { kind: 'log', moss: 'yes' }, { kind: 'log', top: 'cut' },
    { kind: 'stump', top: 'split' }, { kind: 'stump', radius: 3 }, { kind: 'stump', height: 0 }, { kind: 'stump', ends: 'cut' },
    { kind: 'rock', form: 'arch' }, { kind: 'rock', form: 'boulder', moss: 'yes' }, { kind: 'rock', species: 'oak' },
  ];
  for (const procedural of bad) assert.throws(() => normalizeRequest({ template: 'procedural', name: 'bad', procedural }), code('INPUT'), JSON.stringify(procedural));
  assert.throws(() => normalizeRequest({ template: 'procedural', name: 'big', triangleBudget: 20001 }), code('INPUT'));
  assert.throws(() => normalizeRequest({ template: 'procedural', name: 'small', triangleBudget: 2499 }), code('INPUT'));
  assert.throws(() => normalizeRequest({ template: 'procedural', name: 'ornate', triangleBudget: 5000, procedural: { kind: 'column', flutes: 32 } }), /triangleBudget >= /);
  assert.throws(() => normalizeRequest({ template: 'procedural', name: 'sized', sizeMeters: [1, 1, 1] }), /generator parameters/);
  assert.throws(() => normalizeRequest({ template: 'hero-prop', name: 'prop', procedural: { kind: 'rock' } }), code('INPUT'));
  assert.throws(() => normalizeProcedural([]), code('INPUT'));
});

function proceduralAudit(): AssetAudit {
  const base = audit(), render = base.meshes[0]!, collision = base.meshes[1]!;
  return { ...base, template: 'procedural', meshes: [{ ...render, name: 'SM_oak-tree_bark', materials: ['MAT_Bark'] }, { ...render, name: 'SM_oak-tree_leaves', materials: ['MAT_Leaves'] }, { ...collision, name: 'COL_oak-tree' }],
    totals: { renderTriangles: 8, lod1Triangles: 0, collisionTriangles: 4, materials: 2 },
    exports: [{ path: 'asset.glb', objects: 2, triangles: 8, materials: 2, finitePositions: true }, { path: 'asset.fbx', objects: 2, triangles: 8, materials: 2, finitePositions: true }, { path: 'collision.glb', objects: 1, triangles: 4, materials: 0, finitePositions: true }] };
}

test('procedural audits require one mesh per material with the generator part names', () => {
  const request = { ...tree(), renderResolution: 128 };
  assert.doesNotThrow(() => validateAudit(proceduralAudit(), request));
  const renamed = proceduralAudit(); renamed.meshes[1]!.name = 'SM_oak-tree_canopy';
  assert.throws(() => validateAudit(renamed, request), /generator contract/);
  const mixed = proceduralAudit(); mixed.meshes[0]!.materials = ['MAT_Bark', 'MAT_Leaves'];
  assert.throws(() => validateAudit(mixed, request), /one material each/);
  const rock = normalizeRequest({ template: 'procedural', name: 'oak-tree', renderResolution: 128, procedural: { kind: 'rock' } });
  assert.throws(() => validateAudit(proceduralAudit(), rock), /generator contract/);
});

for (const { schemaVersion, leafDensity } of [{ schemaVersion: 1, leafDensity: .7 }, { schemaVersion: 1, leafDensity: 0 },
  { schemaVersion: 2, leafDensity: 0 }, { schemaVersion: 2, leafDensity: .7 }] as const)
test(`procedural manifest v${schemaVersion}/density${leafDensity} reads exact membership and hashes its bundled generator`, async t => {
  const root = join(resolve(process.cwd()), 'packages', 'asset-pipeline', '.runtime', 'tests'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'procedural-manifest-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const request = normalizeRequest({ template: 'procedural', name: 'oak-tree', renderResolution: 128, procedural: { kind: 'tree', species: 'oak', leafDensity } });
  assert.deepEqual(workerScripts(request), ['asset_worker.py', 'audit.py', 'probe.py', 'procedural.py']);
  const a = proceduralAudit();
  if (schemaVersion === 2 && leafDensity === 0) a.meshes = a.meshes.filter(m => m.name !== 'SM_oak-tree_leaves');
  const render = a.meshes.filter(m => m.role === 'render');
  const files: Record<string, Buffer | string> = { 'asset.blend': 'scene', 'blockout.blend': 'checkpoint', 'asset.glb': glb(), 'asset.fbx': 'fbx', 'collision.glb': glb(),
    'preview-hero.png': png(), 'preview-side.png': png(), 'audit.json': JSON.stringify(a), 'request.json': JSON.stringify(request), 'input.json': JSON.stringify(request),
    'asset_worker.py': '#', 'audit.py': '#', 'probe.py': '#', 'procedural.py': '# generator' };
  // The synthetic GLB holds 4 triangles; align the export audit to the real bytes.
  a.totals = { renderTriangles: 4, lod1Triangles: 0, collisionTriangles: 4, materials: render.length };
  render.forEach(mesh => { mesh.triangles = 4 / render.length; });
  a.exports = a.exports.map(e => ({ ...e, triangles: 4, objects: e.path === 'collision.glb' ? 1 : render.length,
    materials: e.path === 'collision.glb' ? 0 : render.length })); files['audit.json'] = JSON.stringify(a);
  const artifacts: Artifact[] = [];
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.from(value); await writeFile(join(dir, path), bytes);
    const role: Artifact['role'] = path.endsWith('.blend') ? (path.startsWith('blockout') ? 'checkpoint' : 'scene') : /\.(glb|fbx)$/.test(path) ? 'export' : path.endsWith('.png') ? 'preview' : path.endsWith('.py') ? 'worker' : path.endsWith('.json') && path !== 'audit.json' ? 'request' : 'audit';
    artifacts.push({ path, role, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const digest = (names: string[]) => sha256(Buffer.from(names.map(n => artifacts.find(x => x.path === n)!.sha256).join('\n')));
  const manifest: AssetManifest = { schemaVersion, jobId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-01-01T00:00:00Z', request,
    runtime: { executable: 'synthetic', version: 'synthetic', pythonVersion: 'synthetic', background: true, capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } },
    templateSha256: digest(workerScripts(request)), sourceRequestSha256: artifacts.find(x => x.path === 'input.json')!.sha256,
    coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', fbxUp: 'Y', pivot: 'floor', robloxScaleVerified: false }, validation: a, artifacts, limitations: ['Synthetic.'] };
  await validateManifestFiles(dir, manifest);
  assert.equal(assetManifest.safeParse(manifest).success, true, 'MCP accepts retained and new manifest response versions');
  assert.equal(assetManifest.safeParse({ ...manifest, schemaVersion: 3 }).success, false);
  if (leafDensity === 0) await assert.rejects(() => validateManifestFiles(dir, { ...manifest, schemaVersion: schemaVersion === 1 ? 2 : 1 }), /generator contract/);
  await assert.rejects(() => validateManifestFiles(dir, { ...manifest, templateSha256: digest(['asset_worker.py', 'audit.py', 'probe.py']) }), code('HASH'));
  await assert.rejects(() => validateManifestFiles(dir, { ...manifest, artifacts: artifacts.filter(x => x.path !== 'procedural.py') }), /procedural\.py/);
  assert.equal(assetRequest.safeParse(request).success, true, 'MCP request schema accepts normalized procedural requests');
});

test('assets_procedural maps typed generator input onto the shared start body', () => {
  const input = proceduralInput.parse({ name: 'pine-a', generator: { kind: 'tree', species: 'pine', height: 14, leafDensity: 0.9 }, seed: 3 });
  const body = proceduralStartBody(input);
  assert.deepEqual(body, { template: 'procedural', name: 'pine-a', seed: 3, procedural: { kind: 'tree', finish: 'natural', species: 'pine', height: 14, leafDensity: 0.9 } });
  assert.equal(assetInput.safeParse(body).success, true);
  assert.equal(normalizeRequest(body).procedural!.kind, 'tree');
  assert.equal(normalizeRequest(body).procedural!.finish, 'natural');
  assert.equal(proceduralInput.parse({name:'plain-rock',generator:{kind:'rock',finish:'flat'}}).generator.finish,'flat');
  // Fallen log / stump: typed deadwood parameters with canonical defaults.
  const log = normalizeRequest(proceduralStartBody(proceduralInput.parse({ name: 'log-1', generator: { kind: 'log', species: 'birch', length: 4, moss: true }, seed: 5 })));
  assert.deepEqual(log.procedural, { kind: 'log', species: 'birch', length: 4, radius: 0.25, ends: 'mixed', moss: true, finish: 'natural' });
  assert.equal(log.triangleBudget, 4000); assert.deepEqual(log.color, [0.82, 0.8, 0.75]);
  const stump = normalizeRequest({ template: 'procedural', name: 'stump-1', procedural: { kind: 'stump', top: 'broken' } });
  assert.deepEqual(stump.procedural, { kind: 'stump', species: 'oak', radius: 0.35, height: 0.5, top: 'broken', moss: false });
  for (const generator of [{ kind: 'log', species: 'palm' }, { kind: 'stump', top: 'sawn' }, { kind: 'log', length: 13 }])
    assert.equal(proceduralInput.safeParse({ name: 'x', generator }).success, false, JSON.stringify(generator));
  assert.equal(proceduralInput.safeParse({name:'external-rock',generator:{kind:'rock',finish:'download'}}).success,false);
  // Rock forms: the tool defaults to the natural boulder; stored requests without a form keep the legacy rock bytes.
  const boulder = normalizeRequest(proceduralStartBody(proceduralInput.parse({ name: 'rock-1', generator: { kind: 'rock' }, seed: 2 })));
  assert.deepEqual(boulder.procedural, { kind: 'rock', size: [1.6, 1.2, 0.9], roughness: 0.5, form: 'boulder', moss: false, finish: 'natural' });
  assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(boulder))), boulder);
  const cave = normalizeRequest(proceduralStartBody(proceduralInput.parse({ name: 'cave-1', generator: { kind: 'rock', form: 'cave', size: [6, 3, 4.5], moss: true } })));
  assert.deepEqual(cave.procedural, { kind: 'rock', size: [6, 3, 4.5], roughness: 0.5, form: 'cave', moss: true, finish: 'natural' });
  assert.equal(cave.triangleBudget, 6000);
  assert.deepEqual(normalizeRequest({ template: 'procedural', name: 'rock-2', procedural: { kind: 'rock' } }).procedural, { kind: 'rock', size: [1.6, 1.2, 0.9], roughness: 0.5 });
  assert.equal((normalizeRequest({ template: 'procedural', name: 'rock-3', procedural: { kind: 'rock', moss: true } }).procedural as { form?: string }).form, 'boulder');
  assert.equal(proceduralInput.safeParse({ name: 'x', generator: { kind: 'rock', form: 'arch' } }).success, false);
  for (const bad of [{ name: 'x', generator: { kind: 'tree', code: 'import os' } }, { name: 'x', generator: { kind: 'python' } }, { name: 'x', generator: { kind: 'rock' }, triangleBudget: 30000 }])
    assert.equal(proceduralInput.safeParse(bad).success, false, JSON.stringify(bad));
});

test('procedural tools are in the reviewed surface and registered per audience', async () => {
  for (const name of ['assets_procedural', 'assets_preview']) { assert.ok(ARCANE_TOOL_NAMES.includes(name as never)); assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes(name as never)); }
  assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes('assets_place_studio_import' as never)); assert.ok(!ARCANE_TOOL_NAMES.includes('assets_place_studio_import' as never));
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Original assets by default/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Author models, UVs and PBR in Blender/);
  assert.equal(MESH_PARTS_CAPABILITY, 'asset.mesh_parts');
  for (const audience of ['generic', 'native-session'] as const) {
    const server = new McpServer({ name: 'fixture', version: '0' });
    const stub = { assetAudience: audience, redact: (v: unknown) => v } as unknown as DaemonClient;
    registerProceduralTools(server, stub); registerProceduralPlaceTool(server, stub);
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'c', version: '0' });
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), audience === 'native-session' ? ['assets_place_studio_import', 'assets_preview', 'assets_procedural'] : ['assets_preview', 'assets_procedural']);
    for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations?.readOnlyHint, tool.name === 'assets_preview'); assert.doesNotMatch(tool.description!, /publish(?!ation or asset)/i); }
    await client.close(); await server.close();
  }
});

test('assets_place_studio_import uses the host-recorded transfer digest and refuses old plugins', async () => {
  const digest = 'ab'.repeat(32), calls: unknown[] = [];
  let capabilities = ['scene.place_asset', MESH_PARTS_CAPABILITY];
  const fake = { assetAudience: 'native-session', redact: (v: unknown) => v,
    assetsStudioReconstructionStatus: async () => ({ jobId: 'x', projectId: 'y', reconstruction: { runId: 'r', commandId: 'c', state: 'succeeded', receipt: { transferDigest: digest } } }),
    sessions: async () => ({ sessions: [{ id: 'session-1', capabilities }] }),
    execute: async (sessionId: string, method: string, args: unknown) => { calls.push({ sessionId, method, args }); return { commandId: 'c1', requestId: 'q', state: 'succeeded', terminal: true, ambiguous: false, wait: 'done', command: { result: { ref: { instanceId: 'm' } } } }; },
  };
  const server = new McpServer({ name: 'fixture', version: '0' }); registerProceduralPlaceTool(server, fake as unknown as DaemonClient);
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'c', version: '0' }); await server.connect(a); await client.connect(b);
  const parent = { instanceId: 'folder', sessionId: 'session-1', root: 'Workspace', pathSegments: ['Templates'], className: 'Folder' };
  const args = { jobId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', parent, name: 'OakTemplate', position: [0, 0, 0] };
  const placed = await client.callTool({ name: 'assets_place_studio_import', arguments: args });
  assert.equal(placed.isError, undefined);
  assert.deepEqual(calls, [{ sessionId: 'session-1', method: 'scene.place_asset', args: { watch: 'editable-' + digest, parent, name: 'OakTemplate', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false } }]);
  assert.equal((placed.structuredContent as { uploaded: boolean }).uploaded, false);
  capabilities = ['scene.place_asset'];
  const old = await client.callTool({ name: 'assets_place_studio_import', arguments: args });
  assert.equal(old.isError, true); assert.match(JSON.stringify(old.structuredContent), /PLUGIN_UPDATE_REQUIRED/); assert.equal(calls.length, 1);
  await client.close(); await server.close();
});
