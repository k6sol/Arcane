import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { validateCommandArgs } from '../../packages/core/src/studio-policy.js';
import { TERRAIN_SURFACE_MATERIALS, TERRAIN_FEATURE_KINDS, terrainVoxelCount } from '../../packages/core/src/terrain-policy.js';
import { READ_METHODS, WRITE_METHODS, TERRAIN_LIMITS, type Json, type StudioCommand, type StudioSession } from '../../packages/protocol/src/studio.js';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { terrainShape, compileTerrain, TERRAIN_TOOL } from '../../apps/mcp/src/terrain-tool.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { productInstructions } from '../../apps/mcp/src/skill-router.js';

const session = (capabilities: string[] = [...READ_METHODS, ...WRITE_METHODS], roots: StudioSession['allowedRoots'] = ['Workspace']): StudioSession => ({
  id: 'terrain-session', protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: roots, allowWrites: true, capabilities, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const parse = (input: Record<string, unknown>) => compileTerrain(z.strictObject(terrainShape).parse(input) as Record<string, unknown>);
/** Forest valley brief: rolling ground, a ridge, a river, a path, a lake and a flattened clearing for a pillar. */
const valley = {
  center: [0, 0], size: [1024, 1024], height: 256, baseHeight: 40, seed: 42, edge: 96, snowLine: 150,
  noise: { type: 'fbm', octaves: 5, frequency: 3, amplitude: 18 },
  features: [
    { kind: 'mountain', center: [-300, -320], radius: 220, height: 140 },
    { kind: 'river', points: [[-500, 200], [-120, 120], [180, 160], [500, 60]], width: 22, depth: 9 },
    { kind: 'path', points: [[0, -480], [10, -200], [0, 0]], width: 8 },
    { kind: 'lake', center: [320, -260], radius: 90, level: 38 },
    { kind: 'flatten', center: [0, 0], radius: 40, blend: 24, material: 'Grass' },
  ],
};

test('policy: typed bounded terrain.generate args, Workspace grant, plugin capability and voxel budget', () => {
  const args = parse(valley);
  assert.deepEqual(validateCommandArgs('terrain.generate', args, session()), args);
  assert.equal(terrainVoxelCount(args), 256 * 64 * 256);
  const full = parse({ center: [0, 0], size: [2048, 2048], height: 512, baseHeight: 0 });
  assert.equal(terrainVoxelCount(full), TERRAIN_LIMITS.voxels);
  assert.ok(validateCommandArgs('terrain.generate', full, session()));
  assert.throws(() => validateCommandArgs('terrain.generate', args, session(READ_METHODS.concat(WRITE_METHODS.filter(m => m !== 'terrain.generate') as never[]))), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => validateCommandArgs('terrain.generate', args, session(undefined, ['Lighting'])), /Workspace grant/);
  const bad = (patch: Record<string, unknown>) => validateCommandArgs('terrain.generate', { ...args, ...patch } as Record<string, Json>, session());
  assert.throws(() => bad({ size: [4096, 100] }), /Terrain size/);
  assert.throws(() => bad({ height: 1024 }), /Terrain height/);
  assert.throws(() => bad({ baseHeight: 300 }), /baseHeight/);
  assert.throws(() => bad({ seed: 1.5 }), /seed/);
  assert.throws(() => bad({ noise: { type: 'perlin' } }), /fbm or ridged/);
  assert.throws(() => bad({ features: [{ kind: 'volcano', center: [0, 0], radius: 5, height: 5 }] }), /feature kind/);
  assert.throws(() => bad({ features: [{ kind: 'plateau', center: [0, 0], radius: 50 }] }), /plateau needs level/);
  assert.throws(() => bad({ features: [{ kind: 'river', points: [[0, 0]], width: 8 }] }), /2\.\.32 points/);
  assert.throws(() => bad({ features: [{ kind: 'path', points: [[0, 0], [5, 5]], width: 8, material: 'Water' }] }), { code: 'PROPERTY' });
  assert.throws(() => bad({ features: Array.from({ length: 33 }, () => ({ kind: 'hill', center: [0, 0], radius: 10, height: 5 })) }), /at most 32/);
  assert.throws(() => bad({ materials: { rules: [{ material: 'Air' }] } }), { code: 'PROPERTY' });
  assert.throws(() => bad({ materials: { rules: [{ minSlope: 30 }] } }), /needs material/);
  assert.throws(() => bad({ script: 'x' }), /Unexpected/);
});

test('MCP schema: compact typed input with defaults; plugin and daemon share the material/feature lists', () => {
  const args = parse({ center: [10, 20], size: [256, 256] });
  assert.deepEqual(args, { center: [10, 20], size: [256, 256], floor: 0, height: 256, baseHeight: 32, seed: 1 });
  assert.equal(z.strictObject(terrainShape).safeParse({ center: [0, 0], size: [8, 8] }).success, false);
  assert.equal(z.strictObject(terrainShape).safeParse({ ...valley, features: [{ kind: 'lake', center: [0, 0], radius: 50 }] }).success, false, 'lake needs level');
  const lua = readFileSync(join(process.cwd(), 'plugin/src/TerrainGen.luau'), 'utf8');
  const list = (name: string) => [...new RegExp(`TerrainGen\\.${name} = table\\.freeze\\(\\{([^}]+)\\}\\)`).exec(lua)![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(list('MATERIALS'), [...TERRAIN_SURFACE_MATERIALS]);
  assert.deepEqual(list('FEATURES'), [...TERRAIN_FEATURE_KINDS]);
  for (const [key, value] of Object.entries({ extent: 2048, height: 512, features: 32, points: 32, rules: 16, voxels: 33554432, chunkVoxels: 524288 }))
    assert.equal((TERRAIN_LIMITS as Record<string, number>)[key], value, key);
  assert.ok(lua.includes('voxels = 33554432, chunkVoxels = 524288'), 'plugin limits match the protocol');
});

test('tool surface: terrain_generate is a reviewed build tool and the instructions put terrain first', () => {
  assert.ok(ARCANE_TOOL_NAMES.includes(TERRAIN_TOOL as never) && ARCANE_NATIVE_TOOL_NAMES.includes(TERRAIN_TOOL as never));
  assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('terrain_generate for natural Terrain ground'));
  assert.ok(productInstructions().includes('terrain_generate for natural Terrain ground'));
  const fixture = readFileSync(join(process.cwd(), 'packages/codex-client/fixtures/protocol.mjs'), 'utf8');
  assert.ok(fixture.includes('"terrain_generate"'), 'codex fixture inventory lists the tool');
});

test('store: terrain receipt must match the requested region; receipt_restore is refused (Studio Undo)', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-terrain-'));
  const store = new StudioStore({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'terrain-window', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const args = parse(valley);
  const command = store.enqueue({ sessionId: pair.sessionId, requestId: 'terrain-1', method: 'terrain.generate', args });
  assert.equal(store.poll(pair.sessionId)[0]!.id, command.id);
  const ref = { instanceId: 'opaque-terrain', sessionId: pair.sessionId, root: 'Workspace', pathSegments: ['Terrain'], className: 'Terrain' };
  const receipt = (voxels: number, className = 'Terrain') => ({ ref: { ...ref, className }, mutation: { kind: 'terrain.generate', ref: { ...ref, className }, before: null,
    after: { region: { origin: [-512, 0, -512], size: [1024, 256, 1024] }, voxels, chunks: 16, seed: 42, features: 5, waterColumns: 900, surfaceRange: [12, 180], surface: { Grass: 60000 } } } });
  assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: receipt(1) }), /requested region/);
  assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: receipt(terrainVoxelCount(args), 'Part') }), /requested region/);
  store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: receipt(terrainVoxelCount(args)) });
  assert.equal(store.command(command.id).state, 'succeeded');
  assert.throws(() => store.restore({ commandId: command.id, requestId: 'terrain-restore' }), /Studio Undo/);
});

async function body(request: IncomingMessage): Promise<Record<string, Json>> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, Json>;
}

test('MCP terrain_generate: one command with the compiled wire args; compact advertised schema', async t => {
  const posted: Record<string, Json>[] = [];
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path === '/v1/studio/commands') {
      const input = await body(request); posted.push(input);
      const command: StudioCommand = { protocolVersion: 1, id: randomUUID(), requestId: String(input.requestId), sessionId: 'terrain-session', clientSessionId: 'lifetime',
        method: input.method as StudioCommand['method'], args: input.args as Record<string, Json>, allowedRoots: ['Workspace'], allowWrites: true, leaseEpoch: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(), state: 'succeeded', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        result: { voxels: terrainVoxelCount(input.args as Record<string, Json>) }, error: null };
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ command })); return;
    }
    response.writeHead(404); response.end('{}');
  })(); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const mcp = createMcpServer({ client: new DaemonClient({ url: 'http://127.0.0.1:' + address.port, token: 'synthetic-terrain-bearer', pollIntervalMs: 10 }), projectRoot: process.cwd() });
  const client = new Client({ name: 'terrain-fixture', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await mcp.close(); });
  const result = CallToolResultSchema.parse(await client.callTool({ name: TERRAIN_TOOL, arguments: { sessionId: 'terrain-session', ...valley } }));
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.method, 'terrain.generate');
  assert.deepEqual(posted[0]!.args, parse(valley));
  const tool = (await client.listTools()).tools.find(item => item.name === TERRAIN_TOOL)!;
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description!, /Studio Undo/);
  const advertised = JSON.stringify(tool.inputSchema).length + tool.description!.length;
  assert.ok(advertised < 6000, `token-lean tool listing (${advertised} chars)`);
  const rejected = CallToolResultSchema.parse(await client.callTool({ name: TERRAIN_TOOL, arguments: { sessionId: 'terrain-session', center: [0, 0], size: [9000, 10] } }));
  assert.equal(rejected.isError, true);
  assert.equal(posted.length, 1, 'schema rejection never reaches the daemon');
});
