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
import { ARCANE_GUIDANCE, ARCANE_GUIDANCE_START, ARCANE_MANAGED_TAIL_START, ARCANE_TASK_INSTRUCTIONS, ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES, missingArcaneTools } from '../../packages/protocol/src/arcane-tools.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

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
interface BundledSkillSource { id: string; path: string; sha256: string; references: { name: string; path: string; sha256: string }[] }
async function intactSkillGet(client: Client, id: string, references: string[] = []): Promise<string> {
  const reply = await call(client, 'skills_get', { ids: [id], references, allowExperimental: true, byteBudget: 16_384 });
  assert.notEqual(reply.result.isError, true); assert.deepEqual(reply.data.ids, [id]); assert.deepEqual(reply.data.references, references);
  const context: unknown = reply.data.context; assert.ok(typeof context === 'string');
  assert.equal(reply.data.bytes, Buffer.byteLength(context)); assert.ok(reply.data.bytes <= 16_384);
  const registry = JSON.parse(await readFile(join(ROOT, 'skills/registry.json'), 'utf8')) as { skills: BundledSkillSource[] };
  const entry: BundledSkillSource | undefined = registry.skills.find(skill => skill.id === id); assert.ok(entry);
  for (const source of [entry, ...references.map(reference => {
    const [owner, name] = reference.split(':'); assert.equal(owner, id);
    const found = entry.references.find(item => item.name === name); assert.ok(found); return found;
  })]) {
    const bytes = await readFile(join(ROOT, source.path)); assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    assert.ok(context.includes(bytes.toString('utf8')), source.path);
  }
  return context;
}
async function dataFixture(t: test.TestContext) {
  const root = await directory(t); await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  return { root, registry: new SkillRegistry({ fixtureRoot: root }) };
}

test('SDK initialize supplies automatic planning and exact scene contracts while write annotations remain unchanged', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Metadata must not contact a daemon.'); });
  const client = await linked(t), instructions = client.getInstructions()!;
  assert.equal(instructions, productInstructions());
  // Deferred discovery: the first 512 characters name the build tools and tell clients to search/load before claiming absence.
  const head = instructions.slice(0, 512);
  for (const text of ['scene_create', 'scene_update', 'script_update', 'tool search', 'unloaded rather than unavailable', 'before concluding it is missing']) assert.ok(head.includes(text), text);
  assert.match(head, /Only if search is unavailable or fails, report that actual boundary; never fabricate a call or claim an edit\./);
  assert.doesNotMatch(instructions, /report that exact inventory mismatch/);
  // A standalone server cannot claim a host preflight; only managed-host instructions may.
  assert.doesNotMatch(instructions, /verified before (?:the|every) turn|host verified/i);
  assert.match(instructions,/playtest_request.*scenario/);assert.match(instructions,/one same-thread repair followed by one reverify/);
  assert.match(instructions,/no Client datamodel attestation/);assert.match(instructions,/assets_reconstruct_studio_import/);
  assert.doesNotMatch(instructions,/exposes no viewport capture, playtest|Script enabling and arbitrary executable-class creation are not exposed|exposes no Studio asset-import tool/);
  assert.match(instructions, /Automatically plan from the user's brief/);
  assert.match(instructions, /[Cc]all skills_recommend/);
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
  assert.ok(data.ids.includes('arcane-level-design')); assert.ok([...data.ids, ...data.deferredIds].includes('arcane-genre-adaptation'));
  assert.ok([...data.references, ...data.deferredReferences].includes('arcane-genre-adaptation:obby'));
  assert.equal(data.composition.intent, 'focused'); assert.deepEqual(data.composition.phases, []);
  // Larger authored bodies may defer this exact profile; actual retrieval still
  // supplies its complete integrity-checked bytes without relaxing the default.
  const profile = await call(client, 'skills_get', { ids: ['arcane-genre-adaptation'], references: ['arcane-genre-adaptation:obby'], allowExperimental: true, byteBudget: 16_384 });
  assert.notEqual(profile.result.isError, true); assert.deepEqual(profile.data.references, ['arcane-genre-adaptation:obby']);
  assert.match(profile.data.context, /# Obby \/ platformer/); assert.equal(profile.data.bytes, Buffer.byteLength(profile.data.context));
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

test('custom Blender brief receives the actual hash-bound props guidance and deferred reference only with experimental opt-in', async t => {
  // This exercises instruction delivery/integrity, not model obedience or asset quality.
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Guidance must not call a daemon or model.'); });
  const f = await dataFixture(t), client = await linked(t, f.registry);
  const request = 'Create one original Blender mesh prop: a cast-iron water pump with an asymmetric curved housing and separate mechanical handle. Preserve its source and measured dimensions.';
  const registryPath = join(f.root, 'skills/registry.json'), originalRegistry = await readFile(registryPath);
  const registry = JSON.parse(originalRegistry.toString()) as { runtimeIntegrated: boolean; defaultLoadPolicy: string;
    skills: { id: string; path: string; sha256: string; status: string; approved: boolean; references: { name: string; path: string; sha256: string }[] }[] };
  const props = registry.skills.find(row => row.id === 'arcane-blender-props'); assert.ok(props);
  const body = await readFile(join(f.root, props.path)), reference = props.references.find(row => row.name === 'model-spec'); assert.ok(reference);
  assert.equal(createHash('sha256').update(body).digest('hex'), props.sha256);
  assert.equal(registry.runtimeIntegrated, false); assert.equal(registry.defaultLoadPolicy, 'approved-only');
  const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
  assert.notEqual(result.isError, true); assert.equal(data.available, true); assert.equal(data.approvalChanged, false);
  assert.equal(data.allowExperimental, true); assert.ok(data.ids.includes(props.id));
  assert.ok(data.context.includes(body.toString())); assert.equal(data.bytes, Buffer.byteLength(data.context));
  assert.ok(data.bytes <= data.byteBudget); assert.ok(!data.references.includes('arcane-blender-props:model-spec'));
  const selected = data.selected.find((row: { id: string }) => row.id === props.id); assert.ok(selected);
  assert.equal(selected.status, 'experimental'); assert.equal(selected.approved, false);
  const referenceArgs = { ids: [props.id], references: ['arcane-blender-props:model-spec'], byteBudget: 32768 };
  const refused = await call(client, 'skills_get', referenceArgs);
  assert.equal(refused.result.isError, true); assert.equal(refused.data.error.code, 'UNAPPROVED');
  const loaded = await call(client, 'skills_get', { ...referenceArgs, allowExperimental: true });
  const referenceBytes = await readFile(join(f.root, reference.path));
  assert.equal(createHash('sha256').update(referenceBytes).digest('hex'), reference.sha256);
  assert.notEqual(loaded.result.isError, true); assert.equal(loaded.data.approvalChanged, false);
  assert.deepEqual(loaded.data.references, referenceArgs.references);
  assert.ok(loaded.data.context.includes(body.toString())); assert.ok(loaded.data.context.includes(referenceBytes.toString()));
  assert.equal(loaded.data.bytes, Buffer.byteLength(loaded.data.context)); assert.ok(loaded.data.bytes <= referenceArgs.byteBudget);
  const approvedOnly = await call(client, SKILLS_RECOMMEND_TOOL, { request, allowExperimental: false });
  assert.equal(approvedOnly.data.available, false); assert.equal(approvedOnly.data.context, '');
  assert.equal(approvedOnly.data.approvalChanged, false); assert.deepEqual((await call(client, 'skills_list')).data.items, []);
  assert.deepEqual(await readFile(registryPath), originalRegistry);
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), originalRegistry);
  await writeFile(join(f.root, props.path), Buffer.concat([body, Buffer.from('\nTampered custom-asset guidance.\n')]));
  const tampered = await call(client, 'skills_get', { ...referenceArgs, allowExperimental: true });
  assert.equal(tampered.result.isError, true); assert.equal(tampered.data.error.code, 'INTEGRITY');
  assert.deepEqual(await readFile(registryPath), originalRegistry); assert.equal(network.mock.callCount(), 0);
});

test('real tool inventories retain closed authority while the procedural description exposes the capability-dependent route', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Tool metadata must stay local.'); });
  const generic = await linked(t), native = await linked(t, undefined, ROOT, new DaemonClient({
    url: 'http://127.0.0.1:1', token: 'synthetic-native-guidance-bearer', assetAudience: 'native-session' }));
  const genericTools = (await generic.listTools()).tools, nativeTools = (await native.listTools()).tools;
  assert.deepEqual(genericTools.map(tool => tool.name), [...ARCANE_TOOL_NAMES]);
  assert.deepEqual(nativeTools.map(tool => tool.name), [...ARCANE_NATIVE_TOOL_NAMES]);
  for (const name of ['assets_start', 'assets_procedural', 'skills_recommend', 'skills_list', 'skills_get']) {
    const tool = genericTools.find(row => row.name === name), nativeTool = nativeTools.find(row => row.name === name);
    assert.ok(tool); assert.ok(nativeTool);
    assert.deepEqual(nativeTool.inputSchema, tool.inputSchema); assert.deepEqual(nativeTool.annotations, tool.annotations);
  }
  for (const tools of [genericTools, nativeTools]) {
    const description = tools.find(tool => tool.name === 'assets_procedural')?.description; assert.ok(description);
    assert.match(description, /no code accepted/); assert.match(description, /faithfully expressible as a bounded declarative part graph/);
    assert.doesNotMatch(description, /ANY other original object/);
    assert.match(description, /actual native filesystem\/process capabilities, current workspace permission and advertised native GLB tools/);
    assert.match(description, /otherwise report the capability limit, never substitute a different asset/);
    assert.match(description, /unsupported-conversion refusals and original scopes/);
    assert.match(description, /Toolbox models require an explicit user request/); assert.match(description, /Never auto-retry/);
  }
  const instructions = generic.getInstructions(); assert.equal(instructions, productInstructions()); assert.ok(instructions);
  assert.match(instructions, /Use assets_start\/assets_procedural only if faithful/);
  assert.match(instructions, /With native file\/process tools, current workspace permission and advertised tools/);
  assert.match(instructions, /owned project-relative embedded GLB → assets_adopt_glb → assets_convert_glb/);
  assert.match(instructions, /Else report the limit; never substitute/);
  assert.match(instructions, /original scopes\/unsupported-conversion refusals/);
  assert.equal(native.getInstructions(), instructions); assert.equal(network.mock.callCount(), 0);
});

test('router combines combat and server security rather than routing a multi-domain task to generic scene guidance', async t => {
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT,
    request: 'Implement melee combat weapon attacks and damage with RemoteEvent server validation and datastore saves.' });
  assert.ok(result.ids.includes('arcane-combat')); assert.ok(result.ids.includes('arcane-remote-security'));
  assert.ok([...result.ids, ...result.deferredIds].includes('arcane-networking')); assert.ok([...result.ids, ...result.deferredIds].includes('arcane-datastore-safety'));
  assert.ok(!result.ids.includes('arcane-blender-props'));
  assert.ok(result.bytes <= SKILL_ROUTER_LIMITS.defaultBytes);
  const client = await linked(t);
  for (const id of ['arcane-networking', 'arcane-datastore-safety']) await intactSkillGet(client, id);
});

test('router maps everyday VFX, GUI, scripting, systems, data and realism phrasing to the prescriptive skill first', async () => {
  const cases: [string, string, string[]][] = [
    ['Add a campfire with fire, smoke and sparks particles', 'arcane-vfx', []],
    ['Make some cool vfx for my sword', 'arcane-vfx', []],
    ['Make a magic waterfall with fireflies and falling leaves', 'arcane-vfx', []],
    ['Design a main menu GUI', 'arcane-interface', []],
    ['Build a modern ui with a hud, health bar and shop', 'arcane-interface', []],
    ['Make a settings menu and notifications ui', 'arcane-interface', []],
    ['Write a script for a coin system', 'arcane-luau-architecture', ['arcane-gameplay-systems']],
    ['Refactor my scripts to use ModuleScripts and CollectionService tags', 'arcane-luau-architecture', []],
    ['Add obby checkpoints and leaderstats', 'arcane-gameplay-systems', []],
    ['Make a round system with intermission', 'arcane-gameplay-systems', ['arcane-luau-architecture']],
    ['Add doors that need keys', 'arcane-gameplay-systems', []],
    ['Add NPC dialogue with quests', 'arcane-gameplay-systems', ['arcane-npc']],
    ['Save player coins with a datastore', 'arcane-datastore-safety', ['arcane-persistence']],
    ['Migrate our old save schema to a new version', 'arcane-persistence', []],
    ['Stop exploiters from cheating my shop remote', 'arcane-remote-security', []],
    ['Make the scene look realistic', 'arcane-photoreal', []],
    ['photoreal lighting at golden hour', 'arcane-photoreal', []],
    ['spooky horror lighting with fog', 'arcane-photoreal', []],
    ['Add ambience, footstep sfx and background music', 'arcane-audio', []],
    ['Make realistic sound for my forest with birds and a river', 'arcane-audio', []],
    ['Add an enemy NPC that patrols and chases players', 'arcane-characters', ['arcane-npc', 'arcane-gameplay-systems']],
    ['Make zombie mobs with pathfinding ai', 'arcane-characters', ['arcane-npc']],
    ['Spawn a shopkeeper character with an idle animation', 'arcane-characters', []],
    ['Create a creature rig that walks around', 'arcane-characters', ['arcane-rig-animation']],
  ];
  for (const [request, first, alsoIncluded] of cases) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    const domain = result.selected.filter(row => row.reason.startsWith('Task relevance')).map(row => row.id);
    assert.equal(domain[0], first, request);
    for (const id of alsoIncluded) assert.ok([...result.ids, ...result.deferredIds].includes(id), `${request}: ${id}`);
    assert.ok(result.bytes <= result.byteBudget, request);
    assert.ok(result.context.includes(`## Loaded skill: ${first}\n`), request);
  }
  const ui = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Design a main menu GUI' });
  assert.ok(!ui.ids.includes('arcane-vfx')); assert.ok(!ui.ids.includes('arcane-photoreal'));
});

test('approved-only router result stays empty and explicit; no manufactured approval or skill content', async () => {
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT, allowExperimental: false });
  assert.equal(result.available, false); assert.deepEqual(result.ids, []); assert.equal(result.context, '');
  assert.equal(result.approvalChanged, false); assert.equal(result.bytes, 0); assert.match(result.limitation!, /No eligible bundled skills/);
});

test('router adapts a small context budget with explicit deferrals and never truncates a loaded body', async () => {
  const registry = new SkillRegistry();
  const first = await recommendSkills(registry, { ...INPUT, limit: 1, byteBudget: SKILL_ROUTER_LIMITS.maximumBytes });
  const budget = (await registry.get({ ids: first.ids, references: [], allowExperimental: true, byteBudget: SKILL_ROUTER_LIMITS.maximumBytes })).bytes;
  const result = await recommendSkills(registry, { ...INPUT, byteBudget: budget });
  assert.equal(result.available, true); assert.ok(result.bytes <= budget);
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

test('default routing is token-lean: the most relevant skill loads first and the rest stay deferred for skills_get', async () => {
  assert.equal(SKILL_ROUTER_LIMITS.defaultBytes, 10_240);
  const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Make a magic waterfall with fireflies and falling leaves' });
  assert.equal(result.ids[0], 'arcane-vfx', 'domain guidance leads');
  assert.ok(result.context.indexOf('## Loaded skill: arcane-vfx\n') >= 0);
  assert.ok(result.bytes <= 10_240 && result.bytes === Buffer.byteLength(result.context));
  // Core process is also in initialize.instructions, so it is deferred before task-specific guidance.
  const core = ['arcane-studio-context', 'arcane-safe-edits', 'arcane-project-director', 'arcane-quality-review'];
  for (const id of core) assert.ok(result.ids.includes(id) || result.deferredIds.includes(id), id);
  const firstCore = result.ids.findIndex(id => core.includes(id));
  if (firstCore >= 0) assert.ok(result.ids.slice(firstCore).every(id => core.includes(id)), 'core trails domain skills');
  assert.ok(result.deferredIds.length > 0, 'remaining guidance is listed for on-demand skills_get');
});

test('router maps genre phrasing to the matching prescriptive genre kit first', async () => {
  const cases: [string, string][] = [
    ['Make a tycoon with droppers, conveyors and rebirths', 'arcane-tycoon-kit'],
    ['Build an obby with stages, kill bricks and moving platforms', 'arcane-obby-kit'],
    ['Make a pet simulator with eggs and a sell area', 'arcane-simulator-kit'],
    ['Create a scary horror game with jump scares and a stalker', 'arcane-horror-kit'],
    ['Build a pvp arena with a map vote', 'arcane-arena-kit'],
    ['Make a round-based arena battle with a lobby', 'arcane-arena-kit'],
    ['Build a racing game with a track and laps', 'arcane-racing-kit'],
    ['Make an rpg with quests, xp and a boss dungeon', 'arcane-rpg-kit'],
    ['Add a quest chain with xp rewards to my adventure', 'arcane-rpg-kit'],
  ];
  for (const [request, first] of cases) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    const domain = result.selected.filter(row => row.reason.startsWith('Task relevance')).map(row => row.id);
    assert.equal(domain[0], first, request);
    assert.ok(result.context.includes(`## Loaded skill: ${first}\n`), request);
    assert.ok(result.bytes <= result.byteBudget, request);
  }
});

test('router sends everyday gameplay-code briefs to the prescriptive systems, DataStore and security skills with their code references', async t => {
  // Pinned in the reviewer catalogue (tests/skills/evaluations.json routingCases) so routing and behavior definitions stay in step.
  const catalogue = JSON.parse(await readFile(join(ROOT, 'tests/skills/evaluations.json'), 'utf8')) as
    { routingCases: { id: string; request: string; firstSkill: string; alsoIncluded: string[]; references: string[] }[] };
  assert.ok(catalogue.routingCases.length >= 10);
  const client = await linked(t);
  for (const { request, firstSkill: first, alsoIncluded, references } of catalogue.routingCases) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    const domain = result.selected.filter(row => row.reason.startsWith('Task relevance')).map(row => row.id);
    assert.equal(domain[0], first, request);
    assert.ok(result.context.includes(`## Loaded skill: ${first}\n`), request);
    if (request === 'make a checkpoint obby') {
      assert.equal(result.composition.intent, 'whole-game'); assert.equal(result.composition.primaryGenre, 'obby');
      assert.deepEqual(result.ids, ['arcane-project-director', first]);
      const systems = result.composition.phases.find(phase => phase.phase === 'systems'); assert.ok(systems);
      for (const id of alsoIncluded) assert.ok(systems.ids.includes(id), `${request}: ${id}`);
      await intactSkillGet(client, 'arcane-gameplay-systems', ['arcane-gameplay-systems:recipes']);
    } else for (const id of alsoIncluded) assert.ok([...result.ids, ...result.deferredIds].includes(id), `${request}: ${id}`);
    // Code references load when they fit, otherwise they are named for skills_get; never silently dropped.
    for (const reference of references) assert.ok([...result.references, ...result.deferredReferences].includes(reference), `${request}: ${reference}`);
    for (const reference of result.deferredReferences) await intactSkillGet(client, reference.split(':')[0]!, [reference]);
    assert.ok(result.bytes <= result.byteBudget && result.bytes === Buffer.byteLength(result.context), request);
  }
  const roomy = await recommendSkills(new SkillRegistry(), { ...INPUT, byteBudget: SKILL_ROUTER_LIMITS.maximumBytes, request: 'make a shop with DataStore saving' });
  assert.deepEqual(roomy.references, ['arcane-datastore-safety:template', 'arcane-gameplay-systems:recipes']);
  for (const code of ['GetRequestBudgetForRequestType', 'BindToClose', 'UpdateAsync', 'OnServerEvent', 'Net.allow']) assert.ok(roomy.context.includes(code), code);
});

test('script diagnosis includes authentic QA guidance without redirecting non-code repairs or widening the default budget', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Routing and progressive guidance must stay offline.'); });
  const client = await linked(t), registry = new SkillRegistry();
  const original = await readFile(join(ROOT, 'skills/registry.json'));
  for (const [request, first] of [
    ['my sword script errors when I click', 'arcane-debugging'],
    ['my module code has an error', 'arcane-luau-architecture'],
  ] as const) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true); assert.equal(data.ids[0], first, request);
    assert.ok([...(data.ids as string[]), ...(data.deferredIds as string[])].includes('arcane-playtest-qa'), request);
    assert.equal(data.byteBudget, SKILL_ROUTER_LIMITS.defaultBytes);
    assert.ok(data.bytes <= 10_240 && data.bytes === Buffer.byteLength(data.context));
    assert.equal(data.composition.intent, 'focused'); assert.equal(data.approvalChanged, false);
    // Read the real integrity-checked body even if byte trimming deferred it; metadata is not loaded guidance.
    await intactSkillGet(client, 'arcane-playtest-qa');
    for (const reference of data.deferredReferences as string[]) await intactSkillGet(client, reference.split(':')[0]!, [reference]);
  }
  const primary = await registry.get({ ids: ['arcane-debugging'], references: [], byteBudget: SKILL_ROUTER_LIMITS.maximumBytes, allowExperimental: true });
  const { result: tightResult, data: tight } = await call(client, SKILLS_RECOMMEND_TOOL,
    { request: 'my sword script errors when I click', byteBudget: primary.bytes });
  assert.notEqual(tightResult.isError, true); assert.deepEqual(tight.ids, ['arcane-debugging']);
  assert.equal(tight.context, primary.context); assert.equal(tight.bytes, primary.bytes);
  assert.ok((tight.deferredIds as string[]).includes('arcane-playtest-qa'));
  for (const request of [
    'Fix the inventory GUI close button error.',
    'Build a small forest with river errors.',
    'Diagnose an error.',
    'Create a ModuleScript.',
  ]) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true);
    assert.ok(![...(data.ids as string[]), ...(data.deferredIds as string[])].includes('arcane-playtest-qa'), request);
    assert.ok(data.bytes <= SKILL_ROUTER_LIMITS.defaultBytes);
  }
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), original);
  assert.equal(network.mock.callCount(), 0);
});

test('functional shops load systems and verification progressively while GUI and debugging requests keep their domains', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Shop guidance must stay offline.'); });
  const client = await linked(t), registry = new SkillRegistry(), original = await readFile(join(ROOT, 'skills/registry.json'));
  for (const request of ['add a shop and make sure it works', 'Make a functional shop.']) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true); assert.equal(data.ids[0], 'arcane-gameplay-systems', request);
    for (const id of ['arcane-playtest-qa', 'arcane-remote-security']) {
      assert.ok([...(data.ids as string[]), ...(data.deferredIds as string[])].includes(id), request + ': ' + id);
    }
    const reference = 'arcane-gameplay-systems:recipes';
    assert.ok([...(data.references as string[]), ...(data.deferredReferences as string[])].includes(reference));
    await intactSkillGet(client, 'arcane-gameplay-systems', [reference]);
    await intactSkillGet(client, 'arcane-playtest-qa');
    assert.equal(data.byteBudget, SKILL_ROUTER_LIMITS.defaultBytes);
    assert.ok(data.bytes <= 10_240 && data.bytes === Buffer.byteLength(data.context));
    assert.equal(data.composition.intent, 'focused'); assert.equal(data.approvalChanged, false);
  }
  const primary = await registry.get({ ids: ['arcane-gameplay-systems'], references: [],
    byteBudget: SKILL_ROUTER_LIMITS.maximumBytes, allowExperimental: true });
  const { result: tightResult, data: tight } = await call(client, SKILLS_RECOMMEND_TOOL,
    { request: 'add a shop and make sure it works', byteBudget: primary.bytes });
  assert.notEqual(tightResult.isError, true); assert.deepEqual(tight.ids, ['arcane-gameplay-systems']);
  assert.equal(tight.context, primary.context); assert.equal(tight.bytes, primary.bytes);
  assert.ok((tight.deferredIds as string[]).includes('arcane-playtest-qa'));
  assert.ok((tight.deferredReferences as string[]).includes('arcane-gameplay-systems:recipes'));
  for (const [request, first] of [
    ['Create a working functional shop GUI.', 'arcane-interface'],
    ['create a shop menu screen with item cards, prices and a buy button that works on phones and PC', 'arcane-interface'],
    ['Debug and diagnose my functional shop code that stopped working.', 'arcane-debugging'],
    ['make a shop with DataStore saving', 'arcane-datastore-safety'],
  ] as const) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true); assert.equal(data.ids[0], first, request);
    assert.ok(data.bytes <= SKILL_ROUTER_LIMITS.defaultBytes);
  }
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), original);
  assert.equal(network.mock.callCount(), 0);
});

test('physical following pets receive authentic character and animation guidance without expanding presentation-only scope', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Follower guidance must stay offline.'); });
  const client = await linked(t), registry = new SkillRegistry(), original = await readFile(join(ROOT, 'skills/registry.json'));
  for (const [request, first] of [
    ['add a pet that follows me', 'arcane-simulator-kit'],
    ['Add a pet that follows me with an inventory.', 'arcane-gameplay-systems'],
    ['Add a pet model that follows me.', 'arcane-simulator-kit'],
    ['Add a following pet.', 'arcane-simulator-kit'],
  ] as const) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true); assert.equal(data.ids[0], first, request);
    assert.ok([...(data.ids as string[]), ...(data.deferredIds as string[])].includes('arcane-characters'), request);
    const reference = 'arcane-characters:pets';
    assert.ok([...(data.references as string[]), ...(data.deferredReferences as string[])].includes(reference), request);
    const context = await intactSkillGet(client, 'arcane-characters', [reference]);
    for (const contract of ['Animator:LoadAnimation', 'verified clips', 'arcane-rig-animation']) assert.ok(context.includes(contract), contract);
    assert.equal(data.byteBudget, SKILL_ROUTER_LIMITS.defaultBytes);
    assert.ok(data.bytes <= 10_240 && data.bytes === Buffer.byteLength(data.context));
    assert.equal(data.composition.intent, 'focused'); assert.equal(data.approvalChanged, false);
  }
  const primary = await registry.get({ ids: ['arcane-simulator-kit'], references: [],
    byteBudget: SKILL_ROUTER_LIMITS.maximumBytes, allowExperimental: true });
  const { result: tightResult, data: tight } = await call(client, SKILLS_RECOMMEND_TOOL,
    { request: 'add a pet that follows me', byteBudget: primary.bytes });
  assert.notEqual(tightResult.isError, true); assert.deepEqual(tight.ids, ['arcane-simulator-kit']);
  assert.equal(tight.context, primary.context); assert.equal(tight.bytes, primary.bytes);
  assert.ok((tight.deferredIds as string[]).includes('arcane-characters'));
  assert.ok((tight.deferredReferences as string[]).includes('arcane-characters:pets'));
  for (const request of [
    'Create a pet inventory GUI with a follow button.',
    'Create a pet inventory with a follow toggle.',
    'Create a static pet model in a following pose.',
    'Create a model-only pet in a follower pose.',
    'Create only a pet model in a following pose.',
  ]) {
    const { result, data } = await call(client, SKILLS_RECOMMEND_TOOL, { request });
    assert.notEqual(result.isError, true);
    assert.ok(![...(data.references as string[]), ...(data.deferredReferences as string[])].includes('arcane-characters:pets'), request);
    assert.equal(data.composition.intent, 'focused'); assert.ok(data.bytes <= SKILL_ROUTER_LIMITS.defaultBytes);
  }
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), original);
  assert.equal(network.mock.callCount(), 0);
});

test('habitat creation leads with natural guidance while a local feature merely in a habitat remains focused', async () => {
  for (const request of ['Build a full forest with caves and a detailed spawn pillar.', 'Make a cave environment with a traversable interior.', 'Create a natural environment with clearings and routes.']) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    assert.equal(result.composition.intent, 'focused'); assert.equal(result.ids[0], 'arcane-natural-scenes', request);
    assert.ok(result.bytes <= SKILL_ROUTER_LIMITS.defaultBytes && result.bytes === Buffer.byteLength(result.context));
  }
  for (const [request, first] of [
    ['Add a detailed pillar in an existing forest.', 'arcane-architectural-features'],
    ['Fix an enemy NPC that patrols and chases players in the forest.', 'arcane-characters'],
    ['Add NPCs that patrol and chase players.', 'arcane-characters'],
    ['Add enemies that patrol and chase players.', 'arcane-characters'],
    ['Make realistic sound for my forest with birds and a river.', 'arcane-audio'],
    ['Create environment settings UI.', 'arcane-interface'],
    ['Create a forest ambience soundtrack.', 'arcane-audio'],
  ] as const) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    assert.equal(result.composition.intent, 'focused'); assert.equal(result.ids[0], first, request);
    assert.ok(result.bytes <= SKILL_ROUTER_LIMITS.defaultBytes);
  }
  const patrol = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Add a patrol timer system.' });
  assert.notEqual(patrol.ids[0], 'arcane-characters', 'patrol alone is not an NPC request');
});

test('script_update attaches advisory Luau findings without blocking or altering the forwarded write', async t => {
  const daemon = new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-luau-lint-bearer' });
  const forwarded: Record<string, unknown>[] = [];
  // Handler fixture only; not a plugin execution or receipt.
  t.mock.method(daemon, 'execute', async (_session: string, method: string, args: Record<string, unknown>) => { forwarded.push({ method, ...args }); return { fixtureForwarded: true }; });
  const client = await linked(t, undefined, ROOT, daemon);
  const ref = { instanceId: 'fixture-script', sessionId: 'fixture-session', root: 'ServerScriptService', pathSegments: ['Shop'], className: 'Script' };
  const risky = 'buy.OnServerEvent:Connect(function(player, itemId, price)\n\tstore:SetAsync(player.UserId, price)\n\twait(1)\nend)\n';
  const flagged = await call(client, 'script_update', { sessionId: ref.sessionId, ref, expectedSource: '', source: risky });
  assert.notEqual(flagged.result.isError, true);
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0]!.source, risky); assert.equal(forwarded[0]!.method, 'script.update');
  assert.equal(flagged.data.fixtureForwarded, true); assert.equal(flagged.data.luauAdvisories.advisoryOnly, true);
  const found = new Set((flagged.data.luauAdvisories.items as { rule: string }[]).map(item => item.rule));
  for (const rule of ['client-trusted-value', 'remote-unvalidated', 'datastore-pcall', 'datastore-setasync', 'datastore-bindtoclose', 'deprecated-scheduler', 'strict-mode']) assert.ok(found.has(rule), rule);
  const clean = await call(client, 'script_update', { sessionId: ref.sessionId, ref, expectedSource: risky, source: '--!strict\nreturn {}\n' });
  assert.equal(clean.data.luauAdvisories, undefined); assert.equal(forwarded.length, 2);
});

test('one canonical guidance block: MCP instructions stay whole in Claude Code and managed chats send it once', () => {
  const instructions = productInstructions();
  // Claude Code cuts MCP server instructions above 4096 characters by default; the canonical text must arrive whole.
  assert.ok(instructions.length <= 4096, `MCP instructions fit Claude Code's bound (${instructions.length} chars)`);
  assert.ok(instructions.includes('\n' + ARCANE_GUIDANCE + '\n'));
  assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('\n' + ARCANE_GUIDANCE + '\n' + ARCANE_MANAGED_TAIL_START));
  assert.ok(ARCANE_GUIDANCE.startsWith(ARCANE_GUIDANCE_START));
  assert.doesNotMatch(ARCANE_GUIDANCE, /verified before (?:the|every) turn|host verified|arcane-choices/i, 'the shared block holds no host-only claim or chat block');
  const host = createRequire(join(ROOT, 'package.json'))(join(ROOT, 'apps/desktop/electron/claude-chat.cjs')) as {
    appendedSystemPrompt(text: string): string; withoutSharedGuidance(text: string): string; GUIDANCE_START: string; MANAGED_TAIL_START: string };
  assert.equal(host.GUIDANCE_START, ARCANE_GUIDANCE_START); assert.equal(host.MANAGED_TAIL_START, ARCANE_MANAGED_TAIL_START);
  // Claude Code adds the server instructions itself, so the appended prompt keeps only the managed header and tail.
  const appended = host.appendedSystemPrompt(ARCANE_TASK_INSTRUCTIONS);
  assert.ok(!appended.includes(ARCANE_GUIDANCE_START) && !appended.includes('Original assets by default'));
  assert.equal(host.withoutSharedGuidance(ARCANE_TASK_INSTRUCTIONS), ARCANE_TASK_INSTRUCTIONS.replace('\n' + ARCANE_GUIDANCE, ''));
  for (const text of ['The user should not choose a tool or workflow', 'This managed host verified before the turn', 'arcane-choices', 'arcane-plan',
    'an explicit in-scope build request needs no plan approval', 'Playtest setting', 'PLUGIN_UPDATE_REQUIRED']) assert.ok(appended.includes(text), text);
  assert.equal(appended, host.appendedSystemPrompt(ARCANE_TASK_INSTRUCTIONS), 'byte-stable across turns');
  // Combined, the Claude chat's system additions stay well under the earlier duplicated size.
  assert.ok(appended.length + instructions.length < 6400, `combined ${appended.length + instructions.length} chars`);
});

test('whole-game routing loads the actual director and one matching genre within the unchanged default budget', async () => {
  const registry = new SkillRegistry(), catalogue = await registry.list({ limit: 100, allowExperimental: true });
  const cases = [
    ['Build a complete racing game with distinct courses and a finished race flow.', 'racing', 'arcane-racing-kit'],
    ['Create a full horror game with objectives, escape and a resolution.', 'horror', 'arcane-horror-kit'],
    ['Make an RPG with quests, useful items and a complete adventure.', 'melee-rpg', 'arcane-rpg-kit'],
    ['Build a complete tycoon with useful production choices.', 'tycoon', 'arcane-tycoon-kit'],
    ['Make a pet simulator with a complete gather and upgrade loop.', 'simulator', 'arcane-simulator-kit'],
    ['Build an obby with varied challenges and a finish.', 'obby', 'arcane-obby-kit'],
    ['Create a PvP arena game with full match transitions.', 'shooter', 'arcane-arena-kit'],
    ['Create a complete puzzle game with discoverable rules.', 'puzzle', 'arcane-genre-adaptation'],
    ['Build a full strategy game with meaningful counters.', 'strategy', 'arcane-genre-adaptation'],
    ['Create a cozy social game with useful shared activities.', 'cozy-social', 'arcane-genre-adaptation'],
    ['Develop a roleplay game with functioning places and roles.', 'roleplay', 'arcane-genre-adaptation'],
    ['Create a complete exploration game with discoveries.', 'adventure', 'arcane-genre-adaptation'],
    ['Make a complete party game with distinct activities.', 'party', 'arcane-genre-adaptation'],
  ] as const;
  for (const [request, genre, partner] of cases) {
    const result = await recommendSkills(registry, { ...INPUT, request });
    assert.deepEqual(result.ids, ['arcane-project-director', partner], request);
    assert.equal(result.composition.intent, 'whole-game'); assert.equal(result.composition.primaryGenre, genre);
    assert.equal(result.composition.initialCoverage, 'director-and-genre'); assert.equal(result.composition.guidanceOnly, true);
    assert.ok(result.bytes <= 10_240 && result.bytes === Buffer.byteLength(result.context));
    assert.ok(result.references.length <= 2); assert.ok(result.ids.length <= 8); assert.equal(result.approvalChanged, false);
    for (const id of result.ids) {
      const entry = catalogue.items.find(item => item.id === id); assert.ok(entry);
      assert.equal(result.selected.find(item => item.id === id)?.approved, entry.approved);
      assert.ok(result.context.includes(`## Loaded skill: ${id}\n`));
    }
    assert.deepEqual(result.composition.phases.map(phase => phase.phase), ['design', 'systems', 'content', 'presentation', 'verification']);
    for (const phase of result.composition.phases) {
      assert.ok(phase.ids.length <= 8 && phase.ids.length === new Set(phase.ids).size);
      assert.ok(phase.ids.every(id => catalogue.items.some(item => item.id === id)), `${request}: eligible phase IDs only`);
    }
    const presentation = result.composition.phases.find(phase => phase.phase === 'presentation'); assert.ok(presentation);
    for (const id of ['arcane-interface', 'arcane-rig-animation', 'arcane-vfx', 'arcane-audio']) {
      assert.ok(presentation.ids.includes(id)); assert.ok(!result.ids.includes(id));
      assert.ok(!result.context.includes(`## Loaded skill: ${id}\n`), 'phase metadata does not silently load bodies');
    }
    if (partner === 'arcane-genre-adaptation') {
      const reference = `arcane-genre-adaptation:${genre}`;
      assert.ok([...result.references, ...result.deferredReferences].includes(reference));
      const profile = await registry.get({ ids: [partner], references: [reference], byteBudget: 16_384, allowExperimental: true });
      assert.deepEqual(profile.references, [reference]); assert.equal(profile.bytes, Buffer.byteLength(profile.context));
    }
  }
});

test('a generic complete game and example-only racing mention never become a racing default', async () => {
  const requests = [
    'Build a complete game with a coherent player journey.',
    'Create a full game; racing is only an example, not a default.',
    'Build a complete game, not just a starter track; racing is only an example.',
    'Build a complete game, for example, racing. Choose the actual genre deliberately.',
    'Make a whole game such as racing, but use the actual brief to choose.',
  ];
  for (const request of requests) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    assert.equal(result.composition.intent, 'whole-game'); assert.equal(result.composition.primaryGenre, null);
    assert.deepEqual(result.ids, ['arcane-project-director', 'arcane-genre-adaptation']);
    assert.ok(!result.composition.phases.some(phase => phase.ids.includes('arcane-racing-kit')));
    assert.ok(![...result.references, ...result.deferredReferences].includes('arcane-genre-adaptation:racing'));
  }
  const puzzle = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Create a complete puzzle game; do not make a racing game.' });
  assert.equal(puzzle.composition.primaryGenre, 'puzzle'); assert.ok(!puzzle.ids.includes('arcane-racing-kit'));
});

test('focused mechanics, UI, scenes, custom assets and prototypes retain focused routing without game phases', async () => {
  const requests = [
    'Fix the checkpoint system in my full obby game.',
    'Create one track for my complete racing game.',
    'Design a main menu GUI.',
    'Create a game HUD with readable health.',
    'Create a game physics system.',
    'Build a small forest scene.',
    'Create one Blender mesh prop for a complete RPG.',
    'Make a horror lighting setup.',
    'Add animation and VFX to my existing game.',
    'Make a racing game prototype.',
  ];
  for (const request of requests) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    assert.equal(result.composition.intent, 'focused', request); assert.equal(result.composition.initialCoverage, null);
    assert.deepEqual(result.composition.phases, []); assert.ok(result.bytes <= result.byteBudget);
  }
  const ui = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Design a main menu GUI.' });
  assert.equal(ui.ids[0], 'arcane-interface'); assert.ok(!ui.ids.includes('arcane-rig-animation'));
  const hud = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Create a game HUD with readable health.' });
  assert.ok([...hud.ids, ...hud.deferredIds].includes('arcane-interface'));
  const forest = await recommendSkills(new SkillRegistry(), { ...INPUT, request: 'Build a small forest scene.' });
  assert.ok([...forest.ids, ...forest.deferredIds].includes('arcane-natural-scenes')); assert.ok(!forest.ids.includes('arcane-racing-kit'));
});

test('SDK focused habitats do not acquire unrelated genre blueprints from generic description words', async t => {
  const client = await linked(t);
  const request = 'make a small forest with a well in and a small building';
  const { result, data } = await call(client, 'skills_recommend', { request });
  assert.notEqual(result.isError, true); assert.equal(data.available, true);
  assert.equal(data.ids[0], 'arcane-natural-scenes');
  assert.equal(data.byteBudget, SKILL_ROUTER_LIMITS.defaultBytes); assert.ok(data.bytes <= data.byteBudget);
  assert.deepEqual([...data.ids, ...data.deferredIds].filter(id => id.endsWith('-kit')), []);
  const boosted = await recommendSkills(new SkillRegistry(), { ...INPUT, request, boosts: { 'arcane-racing-kit': 4 } });
  assert.ok(![...boosted.ids, ...boosted.deferredIds].includes('arcane-racing-kit'), 'preferences cannot turn an unrelated description match into racing intent');
  for (const [brief, expected] of [
    ['Add a drivable car with laps and checkpoints.', 'arcane-racing-kit'],
    ['Build ordered checkpoints for an obstacle course.', 'arcane-obby-kit'],
    ['Create a haunted forest with scares.', 'arcane-horror-kit'],
  ] as const) {
    const reply = await call(client, 'skills_recommend', { request: brief });
    assert.notEqual(reply.result.isError, true);
    assert.ok([...reply.data.ids, ...reply.data.deferredIds].includes(expected), brief);
  }
});

test('whole-game count and byte pressure keep the director and report actual partial guidance without truncation', async () => {
  const registry = new SkillRegistry(), request = 'Build a complete racing game.';
  const one = await recommendSkills(registry, { ...INPUT, request, limit: 1 });
  assert.deepEqual(one.ids, ['arcane-project-director']); assert.ok(one.deferredIds.includes('arcane-racing-kit'));
  assert.equal(one.composition.initialCoverage, 'partial'); assert.match(one.limitation!, /partial initial whole-game guidance/);
  const original = await registry.get({ ids: ['arcane-project-director'], references: [], byteBudget: SKILL_ROUTER_LIMITS.maximumBytes, allowExperimental: true });
  const tight = await recommendSkills(registry, { ...INPUT, request, byteBudget: original.bytes });
  assert.deepEqual(tight.ids, ['arcane-project-director']); assert.equal(tight.context, original.context); assert.equal(tight.bytes, original.bytes);
  assert.ok(tight.deferredIds.includes('arcane-racing-kit')); assert.equal(tight.composition.initialCoverage, 'partial');
  assert.match(tight.limitation!, /count, byte budget or policy/);
  await assert.rejects(() => recommendSkills(registry, { ...INPUT, request, byteBudget: 256 }), { code: 'BUDGET_EXCEEDED' });
  for (const invalid of [{ limit: 9 }, { limit: 0 }, { byteBudget: SKILL_ROUTER_LIMITS.maximumBytes + 1 }]) {
    await assert.rejects(() => recommendSkills(registry, { ...INPUT, request, ...invalid }), { code: 'SKILL_ROUTE_INPUT' });
  }
});

test('whole-game policy, integrity and contained-file failures never become approved or successful fallback guidance', async t => {
  const request = 'Create a complete racing game.', approvedOnly = await recommendSkills(new SkillRegistry(), { ...INPUT, request, allowExperimental: false });
  assert.equal(approvedOnly.available, false); assert.deepEqual(approvedOnly.ids, []); assert.equal(approvedOnly.context, '');
  assert.equal(approvedOnly.composition.initialCoverage, 'unavailable'); assert.deepEqual(approvedOnly.composition.phases, []);
  assert.equal(approvedOnly.approvalChanged, false);
  const f = await dataFixture(t), registryPath = join(f.root, 'skills/registry.json');
  const rawRegistry = await readFile(registryPath), registry = JSON.parse(rawRegistry.toString()) as {
    skills: { id: string; path: string; status: string; approved: boolean }[] };
  const director = registry.skills.find(entry => entry.id === 'arcane-project-director'); assert.ok(director);
  const sourcePath = join(f.root, director.path), source = await readFile(sourcePath);
  await writeFile(sourcePath, Buffer.concat([source, Buffer.from('\nTampered whole-game fixture.\n')]));
  await assert.rejects(() => recommendSkills(f.registry, { ...INPUT, request, byteBudget: 256 }), { code: 'INTEGRITY' });
  assert.deepEqual(await readFile(registryPath), rawRegistry); await writeFile(sourcePath, source);
  const originalPath = director.path; director.path = '../not-a-bundled-source.md'; await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(() => recommendSkills(f.registry, { ...INPUT, request }), { code: 'PATH_ESCAPE' });
  director.path = originalPath; director.status = 'quarantined';
  registry.skills.find(entry => entry.id === 'arcane-audio')!.status = 'quarantined';
  registry.skills.find(entry => entry.id === 'arcane-rig-animation')!.status = 'deprecated';
  await writeFile(registryPath, JSON.stringify(registry)); const before = await readFile(registryPath);
  const partial = await recommendSkills(f.registry, { ...INPUT, request });
  assert.deepEqual(partial.ids, ['arcane-racing-kit']); assert.equal(partial.composition.initialCoverage, 'partial');
  assert.match(partial.limitation!, /policy/); assert.equal(partial.approvalChanged, false);
  const phaseIds = partial.composition.phases.flatMap(phase => phase.ids);
  for (const id of ['arcane-project-director', 'arcane-audio', 'arcane-rig-animation']) assert.ok(!phaseIds.includes(id));
  assert.deepEqual(await readFile(registryPath), before);
});

test('actual scene_build metadata describes declared forest sources and pre-write refusal without a provenance claim', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Metadata must stay offline.'); });
  const client = await linked(t), tool = (await client.listTools()).tools.find(row => row.name === 'scene_build'); assert.ok(tool);
  assert.match(tool.description!, /Forest layers require declared intended prototypes\/templates/);
  assert.match(tool.description!, /FOREST_SOURCES_REQUIRED before writes, never implicit substitutes/);
  assert.match(tool.description!, /Generate\/review\/import original models first when required/);
  assert.match(tool.description!, /declaring a template alone does not prove Blender provenance/);
  assert.match(tool.description!, /Explicit primitive blockouts use explicit prototypes/);
  assert.equal(client.getInstructions(), productInstructions()); assert.ok(productInstructions().length <= 4096);
  assert.equal(network.mock.callCount(), 0);
});
