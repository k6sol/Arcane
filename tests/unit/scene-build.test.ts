import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { validateCommandArgs, sceneBuildInstanceCount } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, type InstanceRef, type Json, type StudioCommand, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, compileEnvironment, sceneBuildShape, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { productInstructions, recommendSkills, SKILL_ROUTER_LIMITS } from '../../apps/mcp/src/skill-router.js';
import { SkillRegistry } from '../../apps/mcp/src/skills.js';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { target, ref } from '../../apps/mcp/src/schemas.js';
import { TERRAIN_TOOL, terrainShape } from '../../apps/mcp/src/terrain-tool.js';

const ROOT_REF: InstanceRef = { instanceId: 'opaque-root', sessionId: 'build-session', root: 'Workspace', pathSegments: [], className: 'Workspace' };
const session = (capabilities: string[] = [...READ_METHODS, ...WRITE_METHODS], roots: StudioSession['allowedRoots'] = ['Workspace', 'Lighting']): StudioSession => ({
  id: 'build-session', protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.1.9',
  allowedRoots: roots, allowWrites: true, capabilities, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const parse = (input: Record<string, unknown>) => z.strictObject(sceneBuildShape).parse(input) as SceneBuildInput;

/** The forest the user asked for: three archetypes, natural scatter with a clearing, plus undergrowth. */
function forestInput(count = 200): SceneBuildInput {
  const pine = { parts: [
    { name: 'Trunk1', props: { Shape: 'Cylinder', Size: [5, 1.6, 1.6], Position: [0, 2.5, 0], Orientation: [0, 0, 90], Material: 'Wood', Color: '#5a4030' }, tint: false },
    { name: 'Trunk2', props: { Shape: 'Cylinder', Size: [5, 1.2, 1.2], Position: [0, 7.5, 0], Orientation: [0, 0, 90], Material: 'Wood', Color: '#5a4030' }, tint: false },
    ...[0, 1, 2, 3, 4].map(i => ({ name: 'Tier' + i, props: { Shape: 'Cylinder', Size: [1.4, 9 - i * 1.6, 9 - i * 1.6], Position: [0, 6 + i * 2.2, 0],
      Orientation: [0, i * 23, 90], Material: 'LeafyGrass', Color: i % 2 ? '#3b6e3a' : '#2f5d34', CanCollide: false } })),
  ] };
  const oak = { parts: [
    { name: 'Trunk', props: { Shape: 'Cylinder', Size: [9, 2.4, 2.4], Position: [0, 4.5, 0], Orientation: [0, 0, 90], Material: 'Wood', Color: '#4b3626' }, tint: false },
    ...[[3, 11, 1], [-3, 12, -2], [0, 13, 3], [2, 14, -3], [-2, 15, 1], [0, 11, -4]].map((p, i) => ({ name: 'Leaf' + i,
      props: { Shape: 'Ball', Size: [7, 7, 7], Position: p, Material: 'LeafyGrass', Color: ['#4a7a3a', '#5b8c43', '#3f6b34'][i % 3], CanCollide: false } })),
  ] };
  const bush = { parts: [[0, 1, 0], [1.2, 0.8, 0.5], [-1, 0.9, -0.6]].map((p, i) => ({ name: 'Ball' + i,
    props: { Shape: 'Ball', Size: [2.2, 2.2, 2.2], Position: p, Material: 'LeafyGrass', Color: '#4f7f3c', CanCollide: false, CastShadow: false } })) };
  return parse({ name: 'Forest', prototypes: { Pine: pine, Oak: oak, Bush: bush },
    items: [{ key: 'Trees', className: 'Model', name: 'Trees' }, { key: 'Undergrowth', className: 'Model', name: 'Undergrowth' }],
    scatter: [
      { use: ['Pine', 'Pine', 'Oak'], in: 'Trees', count, center: [0, 0, 0], radius: 260, minSpacing: 8, clusters: 10, clearing: { inner: 30, outer: 65 },
        avoid: [{ at: [0, 120], radius: 6 }], tint: { min: [0.85, 0.9, 0.85], max: [1.1, 1.1, 1.05] }, seed: 7, ground: true },
      { use: 'Bush', in: 'Undergrowth', count: 120, center: [0, 0, 0], radius: 260, minSpacing: 3, clearing: { inner: 26, outer: 50 }, seed: 8 },
    ] });
}

test('compact forest compiles into one strict scene.build that the daemon accepts and counts exactly', () => {
  const compiled = compileSceneBuild(forestInput(), ROOT_REF as unknown as Json);
  assert.equal(compiled.scatter[0]!.placed, 200, 'all 200 trees placed');
  assert.ok(compiled.scatter[1]!.placed > 60);
  const validated = validateCommandArgs('scene.build', compiled.args, session());
  assert.equal(sceneBuildInstanceCount(validated), compiled.instances);
  assert.ok(compiled.instances > 1000 && compiled.instances <= 4000, String(compiled.instances));
  assert.ok(Buffer.byteLength(JSON.stringify(compiled.args)) < 250 * 1024);
  assert.deepEqual(compileSceneBuild(forestInput(), ROOT_REF as unknown as Json).args, compiled.args, 'seeded scatter is deterministic');
});

test('forest kits require explicit source geometry before compilation, while declared primitive sources remain valid', () => {
  const kit = { kind: 'forest', at: [0, 0, 0], radius: 100, trees: 12, undergrowth: 0, seed: 7, species: [{ use: 'Pine', spacing: 8 }] };
  assert.throws(() => compileSceneBuild(parse({ name: 'Missing', kits: [kit] }), ROOT_REF as unknown as Json), { code: 'FOREST_SOURCES_REQUIRED' });
  const pine = forestInput(12).prototypes!.Pine!;
  const compiled = compileSceneBuild(parse({ name: 'ExplicitBlockout', prototypes: { Pine: pine }, kits: [kit] }), ROOT_REF as unknown as Json);
  const validated = validateCommandArgs('scene.build', compiled.args, session());
  assert.equal(sceneBuildInstanceCount(validated), compiled.instances);
  assert.equal(compiled.kits[0]!.requested, 12);
  assert.equal(compiled.kits[0]!.placed, 12);
  assert.equal(compiled.kits[0]!.originals, undefined, 'explicit primitive input is not Blender provenance');
  assert.equal(compiled.kits[0]!.blockouts, undefined, 'no implicit fallback report');
  assert.equal(compiled.kits[0]!.recipe, undefined);
});

test('scatter is natural: spacing, clearing and keep-out respected, never rings', () => {
  const items = compileSceneBuild(forestInput(), ROOT_REF as unknown as Json).args.items as { kind: string; parent: number; at: number[]; yaw: number; scale: number; tint: number[] | null }[];
  const trees = items.filter(item => item.kind === 'place' && item.parent === 1);
  assert.equal(trees.length, 200);
  for (const [i, a] of trees.entries()) {
    const d = Math.hypot(a.at[0]!, a.at[2]!);
    assert.ok(d >= 30 && d <= 260, 'inside the area, outside the clearing');
    assert.ok(Math.hypot(a.at[0]!, a.at[2]! - 120) >= 6, 'keep-out circle respected');
    for (const b of trees.slice(i + 1)) assert.ok(Math.hypot(a.at[0]! - b.at[0]!, a.at[2]! - b.at[2]!) >= 4 * (a.scale + b.scale) - 0.05, 'Poisson spacing');
    assert.ok(a.scale >= 0.75 && a.scale <= 1.25 && a.tint);
  }
  // Rings would collapse radii into a few values; a natural layout spreads them.
  const radii = new Set(trees.map(t => Math.round(Math.hypot(t.at[0]!, t.at[2]!) / 5)));
  assert.ok(radii.size > 25, `radii spread over ${radii.size} 5-stud bands`);
  const yaws = new Set(trees.map(t => Math.round(t.yaw / 10)));
  assert.ok(yaws.size > 25, 'random yaw, not stepped angles');
});

test('daemon validation refuses malformed builds and oversize hierarchies', () => {
  const ok = compileSceneBuild(forestInput(10), ROOT_REF as unknown as Json).args;
  const bad = (patch: (args: any) => void) => { const args = structuredClone(ok) as any; patch(args); return () => validateCommandArgs('scene.build', args, session()); };
  assert.throws(bad(a => { a.container.className = 'Part'; }), /Model, Folder or ScreenGui/);
  assert.throws(bad(a => { a.items[2].parent = 5; }), /parent/);
  assert.throws(bad(a => { a.items[2].scale = 100; }), /scale/);
  assert.throws(bad(a => { a.items[2].template = 9; }), /prototype/);
  assert.throws(bad(a => { a.prototypes[0].parts[0].properties.Source = 'print(1)'; }), /not writable/);
  assert.throws(bad(a => { a.prototypes[0].parts[0].className = 'MeshPart'; }), /class/);
  assert.throws(bad(a => { a.items.push({ kind: 'eval', name: 'x', parent: 0 }); }), /kind/);
  const huge = { ...ok, items: Array.from({ length: 2000 }, () => ({ kind: 'place', template: 2, name: 'Oak', parent: 0, at: [0, 0, 0], yaw: 0, scale: 1, tint: null })) };
  assert.throws(() => validateCommandArgs('scene.build', huge, session()), /at most 4000 instances/);
  assert.throws(() => compileSceneBuild(parse({ name: 'X', items: [{ use: 'Missing', at: [0, 0, 0] }] }), ROOT_REF as unknown as Json), /Unknown prototype/);
  assert.throws(() => compileSceneBuild(parse({ name: 'X', items: [{ name: 'Ball', props: { Shape: 'Ball', Size: [1, 2, 3] } }] }), ROOT_REF as unknown as Json), /equal Size/);
});

test('an older plugin without scene.build/environment.apply gets an immediate update instruction, not a queued hang', () => {
  const old = session([...READ_METHODS, 'scene.create', 'scene.update', 'script.update', 'script.set_enabled', 'scene.restore']);
  const args = compileSceneBuild(forestInput(5), ROOT_REF as unknown as Json).args;
  assert.throws(() => validateCommandArgs('scene.build', args, old), (error: Error & { code?: string }) =>
    error.code === 'PLUGIN_UPDATE_REQUIRED' && /Update the Studio plugin/.test(error.message) && /scene_create/.test(error.message));
  assert.throws(() => validateCommandArgs('environment.apply', { lighting: { ClockTime: 15 } }, old), { code: 'PLUGIN_UPDATE_REQUIRED' });
});

test('environment terrain and lighting are bounded, grant-scoped and colour-compact', () => {
  const args = compileEnvironment({ terrain: [{ shape: 'Block', material: 'Grass', center: [0, -2, 0], size: [600, 4, 600] },
    { shape: 'Ball', material: 'LeafyGrass', center: [80, -30, 40], radius: 40 }, { shape: 'Cylinder', material: 'Pebble', center: [0, 0, 60], radius: 4, height: 2 }],
    lighting: { ClockTime: 15, Ambient: '#454a4d' }, atmosphere: { Density: 0.3, Haze: 2, Color: [0.78, 0.82, 0.85] } });
  assert.deepEqual(validateCommandArgs('environment.apply', args, session()), args);
  assert.deepEqual((args.lighting as any).Ambient, [0.2706, 0.2902, 0.302]);
  assert.throws(() => validateCommandArgs('environment.apply', args, session(undefined, ['Workspace'])), /Lighting grant/);
  assert.throws(() => validateCommandArgs('environment.apply', { terrain: [{ shape: 'Block', material: 'Grass', center: [0, 0, 0], size: [5000, 4, 10] }] }, session()), /Terrain size/);
  assert.throws(() => validateCommandArgs('environment.apply', { terrain: [{ shape: 'Ball', material: 'Lava', center: [0, 0, 0], radius: 5 }] }, session()), /terrain material/);
  assert.throws(() => validateCommandArgs('environment.apply', { lighting: { Technology: 'Future' } }, session()), /Unexpected/);
  assert.throws(() => validateCommandArgs('environment.apply', { lighting: { ClockTime: 25 } }, session()), /ClockTime/);
});

test('store: one build command, receipt bound to the exact hierarchy, restorable; environment restore is refused', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-scene-build-'));
  const store = new StudioStore({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'Lighting'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'build-window', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const parent: InstanceRef = { ...ROOT_REF, sessionId: pair.sessionId };
  const compiled = compileSceneBuild(forestInput(), parent as unknown as Json);
  const command = store.enqueue({ sessionId: pair.sessionId, requestId: 'forest-build-1', method: 'scene.build', args: compiled.args });
  assert.equal(store.poll(pair.sessionId)[0]!.id, command.id);
  const ref = { instanceId: 'opaque-forest', sessionId: pair.sessionId, root: 'Workspace', pathSegments: ['Forest'], className: 'Model' };
  const receipt = (count: number) => ({ ref, refs: {}, created: { count, classes: { Model: 1 } }, mutation: { kind: 'scene.build', ref, before: null, after: { count, classes: { Model: 1 } } } });
  assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: receipt(compiled.instances - 1) }), /exact requested hierarchy/);
  store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: receipt(compiled.instances) });
  assert.equal(store.command(command.id).state, 'succeeded');
  const restore = store.restore({ commandId: command.id, requestId: 'forest-restore-1' });
  assert.equal(restore.method, 'scene.restore');
  assert.equal(store.poll(pair.sessionId)[0]!.id, restore.id);
  store.result({ sessionId: pair.sessionId, commandId: restore.id, state: 'succeeded', result: { restored: true, ref } });
  const env = store.enqueue({ sessionId: pair.sessionId, requestId: 'environment-01', method: 'environment.apply', args: { lighting: { ClockTime: 15 } } });
  assert.equal(store.poll(pair.sessionId)[0]!.id, env.id);
  const lightingRef = { instanceId: 'opaque-lighting', sessionId: pair.sessionId, root: 'Lighting', pathSegments: [], className: 'Lighting' };
  store.result({ sessionId: pair.sessionId, commandId: env.id, state: 'succeeded', result: { ref: lightingRef, mutation: { kind: 'environment.apply', ref: lightingRef, before: { lighting: { ClockTime: 14 } }, after: { lighting: { ClockTime: 15 }, terrainShapes: 0 } } } });
  assert.throws(() => store.restore({ commandId: env.id, requestId: 'environment-restore' }), /Studio Undo/);
});

async function body(request: IncomingMessage): Promise<Record<string, Json>> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, Json>;
}

test('MCP scene_build: one compact call, one HTTP command, compiled arguments are not echoed back', async t => {
  const posted: Record<string, Json>[] = [];
  const commands = new Map<string, StudioCommand>();
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const send = (payload: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (request.method === 'POST' && path === '/v1/studio/commands') {
      const input = await body(request); posted.push(input);
      const command: StudioCommand = { protocolVersion: 1, id: randomUUID(), requestId: String(input.requestId), sessionId: 'build-session', clientSessionId: 'lifetime',
        method: input.method as StudioCommand['method'], args: input.args as Record<string, Json>, allowedRoots: ['Workspace'], allowWrites: true, leaseEpoch: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(), state: 'succeeded', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        result: { ref: ROOT_REF as unknown as Json, created: { count: sceneBuildInstanceCount(input.args as Record<string, Json>) } }, error: null };
      commands.set(command.id, command); send({ command }); return;
    }
    response.writeHead(404); response.end('{}');
  })(); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const mcp = createMcpServer({ client: new DaemonClient({ url: 'http://127.0.0.1:' + address.port, token: 'synthetic-build-bearer', pollIntervalMs: 10 }), projectRoot: process.cwd() });
  const client = new Client({ name: 'scene-build-fixture', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await mcp.close(); });
  const input = forestInput(), { sessionId: _, ...compact } = { sessionId: 'build-session', ...input };
  const result = CallToolResultSchema.parse(await client.callTool({ name: 'scene_build', arguments: {
    sessionId: 'build-session', parent: ROOT_REF, name: 'Forest', prototypes: compact.prototypes, items: compact.items, scatter: compact.scatter } }));
  const text = result.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text');
  const data = JSON.parse(text.text);
  assert.notEqual(result.isError, true, text.text);
  assert.equal(posted.length, 1, 'a 200-tree forest is a single command');
  assert.equal(posted[0]!.method, 'scene.build');
  assert.equal(data.command.args.compiled, true);
  assert.ok(text.text.length < 4000, `response stays small (${text.text.length} chars)`);
  assert.deepEqual(data.scatter.map((s: { placed: number }) => s.placed > 0), [true, true]);
  const tools = (await client.listTools()).tools;
  for (const name of ['scene_build', 'environment_apply']) assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, false);
  assert.match(tools.find(tool => tool.name === 'scene_build')!.description!, /Never use rings or grids/);
});

test('instructions steer to batching, terrain, natural placement and DataStore safety', () => {
  const text = productInstructions();
  for (const phrase of ['scene_build', 'environment_apply', 'Poisson-disk', 'never rings or grids', 'never re-read unchanged state', 'DataStore'])
    assert.ok(text.includes(phrase), phrase);
  assert.ok(text.slice(0, 512).includes('scene_build'));
});

test('the full forest, caves and spawn-pillar brief receives original-asset recipes within the default budget', async () => {
  const result = await recommendSkills(new SkillRegistry(), { request: 'build a full forest with caves and a spawn point on a detailed pillar in the middle. it should be super high quality. add a visible safe zone around the spawn point. it should be realistic and indistinguishable from real life. feel free to use blender if you must.',
    limit: 8, byteBudget: SKILL_ROUTER_LIMITS.defaultBytes, allowExperimental: true });
  assert.ok(result.ids.includes('arcane-natural-scenes'), result.ids.join());
  assert.ok(result.ids.includes('arcane-architectural-features'), result.ids.join());
  assert.match(result.context, /Never use rings, grids, rows/);
  assert.match(result.context, /user explicitly requests Toolbox models/);
  assert.match(result.context, /A cave needs an entrance, roof, continuous floor and traversable interior/);
  assert.ok(result.ids.includes('arcane-photoreal') || result.deferredIds.includes('arcane-photoreal'));
  const data = await recommendSkills(new SkillRegistry(), { request: 'Add coin saving with DataStores to my game', limit: 8, byteBudget: SKILL_ROUTER_LIMITS.defaultBytes, allowExperimental: true });
  assert.ok(data.ids.includes('arcane-datastore-safety'), data.ids.join());
});


test('forest keeps scaled canopies clear of the spawn, approach bends and circular obstacles', () => {
  const input = forestInput(60);
  const trees = input.scatter[0]!;
  trees.radius = 120; trees.clusters = 6; trees.scale = [0.6, 1.8];
  trees.footprintRadius = 7;
  trees.avoid = [{at: [50, -45], radius: 9}];
  trees.avoidPaths = [{points: [[-90, 0], [0, 0], [0, 0], [0, 90]], width: 12}];
  input.scatter = [trees];
  const compiled = compileSceneBuild(input, ROOT_REF as unknown as Json);
  assert.equal(compiled.scatter[0]!.placed, 60);
  assert.equal(sceneBuildInstanceCount(validateCommandArgs('scene.build', compiled.args, session())), compiled.instances);
  const placements = (compiled.args.items as any[]).filter(item => item.kind === 'place');
  assert.equal(placements.length, 60);
  const scales = new Set<number>();
  for (const item of placements) {
    const [x, , z] = item.at as number[], radius = item.scale * 7;
    scales.add(item.scale);
    assert.ok(Math.hypot(x!, z!) >= 30 + radius, 'the full canopy stays outside the circular spawn clearing');
    assert.ok(Math.hypot(x! - 50, z! + 45) >= 9 + radius, 'scaled canopy clears an existing circular obstacle');
    // Independent axis-aligned corridor checks include both rounded end caps and the repeated bend.
    const horizontal = Math.hypot(x! - Math.max(-90, Math.min(0, x!)), z!);
    const vertical = Math.hypot(x!, z! - Math.max(0, Math.min(90, z!)));
    assert.ok(horizontal >= 6 + radius && vertical >= 6 + radius, 'both route segments stay open at their full width');
  }
  assert.ok(scales.size > 40, 'clearance respects varied scales rather than forcing identical trees');
  assert.deepEqual(compileSceneBuild(input, ROOT_REF as unknown as Json).args, compiled.args);
  assert.equal(JSON.stringify(compiled.args).includes('avoidPaths'), false, 'only validated explicit placements reach the plugin');
});

test('route protection preserves clearance when crowded and bounds malformed path input', () => {
  const input = forestInput(10), trees = input.scatter[0]!;
  trees.radius = 40; trees.footprintRadius = 10;
  trees.avoidPaths = [{points: [[0, 0], [0, 0]], width: 100}];
  input.scatter = [trees];
  const compiled = compileSceneBuild(input, ROOT_REF as unknown as Json);
  assert.deepEqual(compiled.scatter, [{requested: 10, placed: 0}], 'never fill a protected route just to hit the requested count');
  assert.equal((compiled.args.items as any[]).some(item => item.kind === 'place'), false);
  for (const patch of [
    {avoidPaths: [{points: [[0, 0]], width: 8}]},
    {avoidPaths: [{points: [[0, 0], [10, 20]], width: 0}]},
    {avoidPaths: [{points: [[0, 0], [Infinity, 20]], width: 8}]},
    {avoidPaths: [{points: [[0, 0], [1_000_001, 20]], width: 8}]},
    {avoidPaths: [{points: [[0, 0], [10, 20]], width: 8, source: 'ignored?'}]},
    {footprintRadius: -1}, {footprintRadius: 513},
  ]) assert.throws(() => parse({name: 'InvalidRoute', scatter: [{use: 'Tree', count: 10, center: [0, 0, 0], radius: 80, minSpacing: 4, ...patch}]}));
});

test('advertised scene_build and terrain_generate schemas accept and refuse a corpus exactly as server validation does', async t => {
  const mcp = createMcpServer({ client: new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-corpus-bearer' }), projectRoot: process.cwd() });
  const client = new Client({ name: 'schema-corpus', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await mcp.close(); });
  const tools = (await client.listTools()).tools, validator = new AjvJsonSchemaValidator();
  const check = (name: string, strict: z.ZodType, base: Record<string, unknown>, valid: Record<string, unknown>[], invalid: Record<string, unknown>[]) => {
    const tool = tools.find(item => item.name === name)!, schema = JSON.stringify(tool.inputSchema);
    // Annotation-only "default" values that an omitted flag or list already means are not advertised.
    assert.ok(!schema.includes('"default":false') && !schema.includes('"default":[]'), name);
    const advertised = validator.getValidator(tool.inputSchema as never);
    for (const [expected, patches] of [[true, valid], [false, invalid]] as const) for (const patch of patches) {
      const input = { ...base, ...patch }, label = `${name} ${expected ? 'accepts' : 'refuses'} ${JSON.stringify(patch).slice(0, 160)}`;
      assert.equal(advertised(input).valid, expected, 'advertised ' + label);
      assert.equal(strict.safeParse(input).success, expected, 'server ' + label);
    }
  };
  const pine = { parts: [{ name: 'Trunk', props: { Shape: 'Cylinder', Size: [5, 1.6, 1.6], Position: [0, 2.5, 0], Orientation: [0, 0, 90], Color: '#5a4030', Material: 'Wood' }, tint: false },
    { name: 'Crown', className: 'WedgePart', props: { Color: [0.2, 0.4, 0.2], Transparency: 0.1, Reflectance: 0, CanCollide: false, CastShadow: false, Anchored: true } }], weld: true };
  const scatter = { use: 'Pine', in: 'Trees', count: 20, center: [0, 0, 0], radius: 50, minSpacing: 6 };
  const build = { sessionId: 'build-session', parent: ROOT_REF, name: 'Forest', defaults: { Material: 'Wood' }, prototypes: { Pine: pine },
    items: [{ key: 'Trees', className: 'Model', name: 'Trees' }, { use: 'Pine', in: 'Trees', at: [1, 2, 3], yaw: 45, scale: 1.5, tint: [1, 0.9, 1.1], ground: true }], scatter: [scatter] };
  const plinth = { kind: 'plinth', key: 'Spawn', at: [0, 0, 0], radius: 12, seed: 4, style: 'fluted', tiers: 3, height: 20, material: 'Marble', color: '#c8c1b2',
    weathering: 0.4, spawn: true, life: 'dusk', safeZone: { radius: 15, style: 'glow' } };
  const forest = { kind: 'forest', at: [0, 0, 0], radius: 200, trees: 120, undergrowth: 200, species: [{ use: 'pine', share: 2, spacing: 9, tris: 16000 }],
    cover: [{ use: 'fern', spacing: 2.4 }], paths: [{ points: [[0, 0], [50, 60]], width: 8 }], clearing: { center: [0, 0], inner: 20, outer: 50 } };
  const { radius: _radius, ...area } = scatter;
  const rich = { ...area, use: ['Pine', 'Pine', 'Oak'], innerRadius: 4, size: [80, 60], clusters: 4, clusterSpread: 20, avoid: [{ at: [5, 5], radius: 3 }],
    avoidPaths: [{ points: [[0, 0], [10, 20]], width: 8 }], footprintRadius: 3, yaw: [-180, 180], scale: [0.75, 1.25], tint: { min: [0.9, 0.9, 0.9], max: [1.1, 1.1, 1.1] },
    seed: 9, ground: true, edge: 12, tilt: 4, hug: 0.5, clearing: { inner: 10, outer: 30 } };
  const { center: _center, ...centreless } = scatter;
  const { at: _at, ...unplaced } = forest;
  check('scene_build', z.strictObject({ ...target, parent: ref, ...sceneBuildShape }), build, [
    {}, { timeoutMs: 5000, container: 'Folder' }, { kits: [plinth, forest] }, { scatter: [scatter, rich] },
    { container: 'ScreenGui', screen: { IgnoreGuiInset: true }, prototypes: { Card: { ui: [{ name: 'Root', className: 'Frame' }, { name: 'Title', className: 'TextLabel', in: 'Root', ui: { Text: 'Hi' } }] } },
      items: [{ use: 'Card', ui: { Position: [0.5, 0, 0.5, 0] } }, { key: 'Glow', className: 'PointLight', fx: { Brightness: 2 } }], scatter: [] },
  ], [
    { extra: 1 }, { parent: { ...ROOT_REF, extra: 1 } }, { container: 'Part' }, { defaults: { Material: 'Lava' } }, { defaults: { Size: [1, 5] } }, { defaults: { Color: '#zzzzzz' } },
    { defaults: { Transparency: 2 } }, { prototypes: { 'bad name': pine } }, { prototypes: { Pine: { ...pine, extra: true } } }, { prototypes: { Pine: { parts: [] } } },
    { prototypes: { Pine: { parts: [{ name: 'Trunk', className: 'Model' }] } } }, { templates: { 'a b': ROOT_REF } },
    { items: [{ use: 'Pine', yaw: 400 }] }, { items: [{ use: 'Pine', scale: 0.05 }] }, { items: [{ use: 'Pine', tint: [3, 1, 1] }] }, { items: [{ key: 'a b' }] }, { items: [{ use: 'Pine', extra: 1 }] },
    { scatter: [{ ...scatter, count: 0 }] }, { scatter: [{ ...scatter, minSpacing: 0.1 }] }, { scatter: [centreless] }, { scatter: [{ ...scatter, use: [] }] },
    { scatter: [{ ...scatter, hug: 1.5 }] }, { scatter: [{ ...scatter, tilt: 30 }] }, { scatter: [{ ...scatter, seed: -1 }] }, { scatter: [{ ...scatter, size: [10] }] },
    { scatter: [{ ...scatter, clearing: { inner: 10 } }] }, { scatter: [{ ...scatter, avoidPaths: [{ points: [[0, 0]], width: 8 }] }] }, { scatter: [{ ...scatter, avoidPaths: [{ points: [[0, 0], [1, 1]], width: 0 }] }] },
    { scatter: [{ ...scatter, tint: { min: [1, 1, 1] } }] }, { scatter: Array.from({ length: 17 }, () => scatter) },
    { kits: [{ ...plinth, kind: 'castle' }] }, { kits: [{ ...plinth, material: 'Wood' }] }, { kits: [{ ...plinth, safeZone: { radius: 15, extra: 1 } }] }, { kits: [{ ...plinth, tiers: 7 }] },
    { kits: [{ ...forest, species: [] }] }, { kits: [{ ...forest, cover: [{ use: 'fern' }] }] }, { kits: [unplaced] }, { kits: [plinth, plinth, plinth, plinth, forest] },
    { timeoutMs: 50 },
  ]);
  const valley = { sessionId: 'terrain-session', center: [0, 0], size: [512, 512] };
  const terrain = { floor: -20, height: 192, baseHeight: 32, seed: 3, noise: { type: 'ridged', octaves: 6, frequency: 3, amplitude: 20, persistence: 0.5 }, edge: 64, snowLine: 150,
    features: [{ kind: 'mountain', center: [100, 100], radius: 80, height: 120, roughness: 0.6 }, { kind: 'flatten', center: [0, 0], radius: 40, blend: 8, material: 'LeafyGrass', base: 12 },
      { kind: 'plateau', center: [60, -60], radius: 30, level: 40 }, { kind: 'lake', center: [-150, 50], radius: 60, level: 20, depth: 8, material: 'Mud' },
      { kind: 'river', points: [[-200, 0], [0, -100], [200, -50]], width: 16, depth: 6, bank: 10, material: 'Pebble' }],
    materials: { rules: [{ material: 'Rock', minSlope: 35 }, { material: 'Snow', minHeight: 150, maxHeight: 512, maxSlope: 60, minNoise: -0.5, maxNoise: 1, nearWater: 4 }], fallback: 'Grass', deep: 'Basalt' },
    caves: { at: [150, -150], radius: 90, rise: 56, entrances: 2, chambers: 2, tunnel: 6, floor: 'Slate', avoid: [[0, 0, 40]] } };
  check(TERRAIN_TOOL, z.strictObject({ ...target, ...terrainShape }), valley, [{}, terrain, { caves: { at: [0, 0] } }], [
    { extra: 1 }, { size: [9000, 10] }, { center: [0, 0, 0] }, { floor: 20000 }, { height: 4 }, { noise: { type: 'perlin' } }, { noise: { octaves: 2, extra: 1 } },
    { features: [{ kind: 'lake', center: [0, 0], radius: 60 }] }, { features: [{ kind: 'volcano', center: [0, 0], radius: 60, height: 9 }] },
    { features: [{ kind: 'river', points: [[0, 0]], width: 8 }] }, { features: [{ kind: 'hill', center: [0, 0], radius: 40, height: 9, level: 3 }] },
    { materials: { fallback: 'Lava' } }, { materials: { rules: [{ material: 'Rock', extra: 1 }] } }, { materials: { rules: [{ material: 'Rock', minNoise: -2 }] } },
    { caves: { at: [0, 0], tunnel: 20 } }, { caves: { at: [0, 0], avoid: [[0, 0]] } }, { caves: { at: [0, 0], entrances: 0 } }, { caves: {} },
  ]);
});
