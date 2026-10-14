import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { SkillRegistry } from '../../apps/mcp/src/skills.js';
import { productInstructions, recommendSkills, SKILLS_RECOMMEND_TOOL, SKILL_ROUTER_LIMITS } from '../../apps/mcp/src/skill-router.js';
import { properties, createClass } from '../../apps/mcp/src/schemas.js';
import { ARCANE_TOOL_NAMES, missingArcaneTools } from '../../packages/protocol/src/arcane-tools.js';

const ROOT = resolve(process.cwd());
const ENTRY = fileURLToPath(new URL('../../apps/mcp/src/main.js', import.meta.url));
const REQUEST = 'Build a compact visually coherent scene blockout for an obstacle course obby.';
const INPUT = { request: REQUEST, limit: 8, byteBudget: SKILL_ROUTER_LIMITS.defaultBytes, allowExperimental: true };
const cleanups = new WeakMap<test.TestContext, (() => Promise<unknown>)[]>();
function after(t: test.TestContext, action: () => Promise<unknown>) {
  let actions = cleanups.get(t);
  if (!actions) {
    actions = []; cleanups.set(t, actions);
    t.after(async () => { const failures: unknown[] = []; for (const cleanup of actions!.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    } if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed.'); });
  }
  actions.push(action);
}

async function directory(t: test.TestContext) {
  const parent = makeFixtureDirectory('arcane-mcp-skill-router-');
  after(t, async () => {
    const part = relative(fixtureTempDirectory(), resolve(parent));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    await rm(parent, { recursive: true, force: true });
  });
  return parent;
}
async function linked(t: test.TestContext, skillRegistry?: SkillRegistry, projectRoot = ROOT, daemon?: DaemonClient) {
  const server = createMcpServer({ client: daemon ?? new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-router-test-bearer' }),
    projectRoot, ...(skillRegistry ? { skillRegistry } : {}) });
  const client = new Client({ name: 'arcane-skill-router-fixture', version: '1.0.0' });
  after(t, async () => { try { await client.close(); } finally { await server.close(); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const item = result.content.find(block => block.type === 'text'); assert.ok(item && item.type === 'text');
  return { result, data: JSON.parse(item.text) as Record<string, any> };
}
async function dataFixture(t: test.TestContext) {
  const root = await directory(t); await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  return { root, registry: new SkillRegistry({ fixtureRoot: root }) };
}

test('SDK initialize supplies automatic planning and exact scene contracts while write annotations remain unchanged', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Metadata must not contact a daemon.'); });
  const client = await linked(t), instructions = client.getInstructions()!;
  assert.equal(instructions, productInstructions());
  assert.match(instructions, /Automatically plan from the user's brief/);
  assert.match(instructions, /call skills_recommend/);
  assert.match(instructions, /not behavior-verified or production-approved/);
  assert.match(instructions, /do not ask for repeated conversational permission/);
  assert.match(instructions, /Honor native approval requests/);
  assert.match(instructions, /Studio edit mode/);
  assert.match(instructions, /parentRef for the requested granted root\/parent, including an empty Workspace/);
  assert.match(instructions, /Create a cylinder with scene_create/);
  assert.match(instructions, /CFrame remains unavailable/);
  assert.match(instructions, /never repeat a mutation automatically/i);
  assert.ok(instructions.includes(createClass.options.join(', ')));
  assert.ok(instructions.includes(Object.keys(properties.shape).join(', ')));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [...ARCANE_TOOL_NAMES]);
  assert.deepEqual(missingArcaneTools(tools.map(tool => tool.name)), []);
  const router = tools.find(tool => tool.name === SKILLS_RECOMMEND_TOOL)!;
  assert.deepEqual(router.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal((router.inputSchema.properties!.allowExperimental as { default: boolean }).default, true);
  for (const [name, destructive] of [['scene_create', false], ['scene_update', true], ['script_update', true]] as const) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false });
  }
  assert.equal(network.mock.callCount(), 0);
});

test('automatic task routing loads authentic relevant experimental bodies and declared obby guidance offline', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('No daemon/model calls permitted.'); });
  const client = await linked(t);
  const original = await readFile(join(ROOT, 'skills/registry.json'));
  const registry = JSON.parse(original.toString()) as { skills: { id: string; path: string; status: string; approved: boolean }[] };
  const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request: REQUEST });
  assert.notEqual(result.isError, true);
  assert.equal(data.available, true); assert.equal(data.allowExperimental, true); assert.equal(data.approvalChanged, false);
  assert.ok(data.ids.includes('arcane-level-design')); assert.ok(data.ids.includes('arcane-genre-adaptation'));
  assert.ok(data.references.includes('arcane-genre-adaptation:obby'));
  assert.ok(data.ids.length <= 8); assert.equal(data.bytes, Buffer.byteLength(data.context)); assert.ok(data.bytes <= data.byteBudget);
  assert.match(data.context, /Experimental content/);
  for (const selected of data.selected) {
    const entry = registry.skills.find(row => row.id === selected.id)!;
    assert.equal(selected.status, entry.status); assert.equal(selected.approved, entry.approved);
    assert.ok(data.context.includes(await readFile(join(ROOT, entry.path), 'utf8')));
  }
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), original);
  assert.deepEqual((await call(client, 'skills_list')).data.items, []);
  assert.equal((await call(client, 'skills_get', { ids: ['arcane-studio-context'] })).data.error.code, 'UNAPPROVED');
  assert.equal(network.mock.callCount(), 0);
});

test('router combines combat and server security rather than routing a multi-domain task to generic scene guidance', async () => {
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT,
    request: 'Implement melee combat weapon attacks and damage with RemoteEvent server validation and datastore saves.' });
  assert.ok(result.ids.includes('arcane-combat')); assert.ok(result.ids.includes('arcane-remote-security'));
  assert.ok(result.ids.includes('arcane-networking')); assert.ok(result.ids.includes('arcane-persistence'));
  assert.ok(!result.ids.includes('arcane-blender-props'));
});

test('approved-only router result stays empty and explicit; no manufactured approval or skill content', async () => {
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT, allowExperimental: false });
  assert.equal(result.available, false); assert.deepEqual(result.ids, []); assert.equal(result.context, '');
  assert.equal(result.approvalChanged, false); assert.equal(result.bytes, 0); assert.match(result.limitation!, /No eligible bundled skills/);
});

test('router adapts a small context budget with explicit deferrals and never truncates a loaded body', async () => {
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT, byteBudget: 2400 });
  assert.equal(result.available, true); assert.ok(result.bytes <= 2400);
  assert.ok(result.deferredIds.length > 0); assert.ok(result.deferredReferences.length > 0);
  assert.equal(result.bytes, Buffer.byteLength(result.context));
  for (const id of result.ids) assert.ok(result.context.includes(`## Loaded skill: ${id}\n`));
  await assert.rejects(() => recommendSkills(new SkillRegistry(), { ...INPUT, byteBudget: 256 }), { code: 'BUDGET_EXCEEDED' });
});

test('router refuses tampered selected content and excludes quarantined/deprecated entries without repair', async t => {
  const f = await dataFixture(t);
  const registryFile = join(f.root, 'skills/registry.json');
  const registry = JSON.parse(await readFile(registryFile, 'utf8')) as { skills: { id: string; path: string; status: string; approved: boolean }[] };
  const context = registry.skills.find(row => row.id === 'arcane-studio-context')!;
  const contextFile = join(f.root, context.path), original = await readFile(contextFile, 'utf8');
  await writeFile(contextFile, original + '\nTampered test fixture.\n');
  await assert.rejects(() => recommendSkills(f.registry, INPUT), { code: 'INTEGRITY' });
  await writeFile(contextFile, original);
  context.status = 'quarantined';
  registry.skills.find(row => row.id === 'arcane-safe-edits')!.status = 'deprecated';
  await writeFile(registryFile, JSON.stringify(registry));
  const before = await readFile(registryFile);
  const result = await recommendSkills(f.registry, INPUT);
  assert.ok(!result.ids.includes('arcane-studio-context')); assert.ok(!result.ids.includes('arcane-safe-edits'));
  assert.deepEqual(await readFile(registryFile), before);
});

test('canonical fixture data reaches routing while raw Windows TEMP aliases retain the bundle guard', async t => {
  const f = await dataFixture(t);
  assert.equal(f.root, await realpath(f.root));
  const expected = await recommendSkills(f.registry, INPUT);
  assert.equal(expected.available, true);
  const rawRoot = join(tmpdir(), basename(f.root));
  const rawRegistry = new SkillRegistry({ fixtureRoot: rawRoot });
  const samePath = process.platform === 'win32' ? rawRoot.toLowerCase() === f.root.toLowerCase() : rawRoot === f.root;
  if (!samePath) {
    assert.equal(await realpath(rawRoot), f.root);
    await assert.rejects(() => recommendSkills(rawRegistry, INPUT), { code: 'BUNDLE_INTEGRITY' });
    t.diagnostic('Actual TEMP canonical alias rejected by the bundle guard.');
  } else {
    assert.deepEqual(await recommendSkills(rawRegistry, INPUT), expected);
    t.diagnostic('TEMP already has its physical spelling; canonical fixture routing validated.');
  }
});

test('official stdio startup advertises mutation tools and router, uses only bundled guidance in a hostile workspace', { timeout: 20_000 }, async t => {
  const root = await directory(t);
  await mkdir(join(root, 'skills')); await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'skills/registry.json'), '{"skills":[{"id":"arcane-hostile","approved":true}]}');
  await writeFile(join(root, 'scripts/skill-pack.mjs'), 'throw Error("Workspace parser must never execute");');
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, '--project', root], cwd: root,
    env: { ARCANE_DAEMON_URL: 'http://127.0.0.1:1', ARCANE_LOCAL_TOKEN: 'synthetic-stdio-router-bearer' }, stderr: 'pipe' });
  const client = new Client({ name: 'arcane-router-stdio-probe', version: '1.0.0' });
  after(t, async () => { try { await client.close(); } finally { await transport.close(); } });
  let diagnostic = ''; transport.stderr?.on('data', chunk => { diagnostic += String(chunk); });
  await client.connect(transport);
  assert.equal(client.getInstructions(), productInstructions());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [...ARCANE_TOOL_NAMES]);
  assert.deepEqual(missingArcaneTools(tools.map(tool => tool.name)), []);
  const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request: REQUEST });
  assert.notEqual(result.isError, true); assert.ok(data.ids.includes('arcane-level-design'));
  assert.ok(!data.context.includes('arcane-hostile')); assert.equal(diagnostic, '');
});

test('router tool rejects authority/path injection fields and unsupported scene geometry before any daemon call', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Invalid inputs must not contact a daemon.'); });
  const client = await linked(t);
  const invalid = CallToolResultSchema.parse(await client.callTool({ name: SKILLS_RECOMMEND_TOOL,
    arguments: { request: REQUEST, allowWrites: true, fixtureRoot: '../../' } }));
  assert.equal(invalid.isError, true);
  assert.equal(properties.safeParse({ Shape: 'Cylinder' }).success, true);
  assert.equal(properties.safeParse({ Orientation: { type: 'Vector3', value: [0, 0, 90] } }).success, true);
  assert.equal(properties.safeParse({ Orientation: { type: 'Vector3', value: [0, 0, 361] } }).success, false);
  assert.equal(properties.safeParse({ CFrame: [0, 0, 0] }).success, false);
  assert.equal(createClass.safeParse('MeshPart').success, false);
  await assert.rejects(() => recommendSkills(new SkillRegistry(), { ...INPUT, request: '   ' }), { code: 'SKILL_ROUTE_INPUT' });
  assert.equal(network.mock.callCount(), 0);
});

test('actual scene_create handler forwards bounded cylinder/wedge/spawn recipes and refuses class/property mismatches', async t => {
  const daemon = new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-scene-preflight-bearer' });
  const forwarded: { method: string; args: Record<string, unknown> }[] = [];
  // Handler/preflight fixture only. This is not an engine execution or receipt.
  t.mock.method(daemon, 'execute', async (_session: string, method: string, args: Record<string, unknown>) => {
    forwarded.push({ method, args }); return { fixtureForwarded: true };
  });
  const client = await linked(t, undefined, ROOT, daemon);
  const parent = { instanceId: 'fixture-root', sessionId: 'fixture-session', root: 'Workspace', pathSegments: [], className: 'Workspace' };
  const physical = { Size: { type: 'Vector3', value: [8, 4, 4] }, Position: { type: 'Vector3', value: [0, 4, 0] },
    Orientation: { type: 'Vector3', value: [0, 0, 90] }, Anchored: true, CanCollide: true, CastShadow: true, Reflectance: 0.1 };
  for (const className of ['Part', 'WedgePart', 'CornerWedgePart', 'SpawnLocation']) {
    const recipe = { sessionId: parent.sessionId, parent, className, name: 'Fixture-' + className,
      properties: { ...physical, ...(className === 'Part' ? { Shape: 'Cylinder' } : {}) } };
    const reply = await call(client, 'scene_create', recipe);
    assert.notEqual(reply.result.isError, true, JSON.stringify(reply.data));
    assert.equal(forwarded.at(-1)!.method, 'scene.create');
    assert.deepEqual(forwarded.at(-1)!.args.properties, recipe.properties);
  }
  const count = forwarded.length;
  for (const [className, props] of [['WedgePart', { Shape: 'Cylinder' }], ['Folder', physical], ['Script', physical]] as const) {
    const reply = await call(client, 'scene_create', { sessionId: parent.sessionId, parent, className, name: 'RefusedFixture', properties: props });
    assert.equal(reply.result.isError, true); assert.equal(reply.data.error.code, 'PROPERTY');
  }
  assert.equal(forwarded.length, count);
});
