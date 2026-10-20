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
import { ARCANE_GUIDANCE, ARCANE_GUIDANCE_START, ARCANE_MANAGED_TAIL_START, ARCANE_TASK_INSTRUCTIONS, ARCANE_TOOL_NAMES, missingArcaneTools } from '../../packages/protocol/src/arcane-tools.js';
import { createRequire } from 'node:module';

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
  assert.ok(result.ids.includes('arcane-networking')); assert.ok([...result.ids, ...result.deferredIds].includes('arcane-datastore-safety'));
  assert.ok(!result.ids.includes('arcane-blender-props'));
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

test('router sends everyday gameplay-code briefs to the prescriptive systems, DataStore and security skills with their code references', async () => {
  // Pinned in the reviewer catalogue (tests/skills/evaluations.json routingCases) so routing and behavior definitions stay in step.
  const catalogue = JSON.parse(await readFile(join(ROOT, 'tests/skills/evaluations.json'), 'utf8')) as
    { routingCases: { id: string; request: string; firstSkill: string; alsoIncluded: string[]; references: string[] }[] };
  assert.ok(catalogue.routingCases.length >= 10);
  for (const { request, firstSkill: first, alsoIncluded, references } of catalogue.routingCases) {
    const result = await recommendSkills(new SkillRegistry(), { ...INPUT, request });
    const domain = result.selected.filter(row => row.reason.startsWith('Task relevance')).map(row => row.id);
    assert.equal(domain[0], first, request);
    assert.ok(result.context.includes(`## Loaded skill: ${first}\n`), request);
    for (const id of alsoIncluded) assert.ok([...result.ids, ...result.deferredIds].includes(id), `${request}: ${id}`);
    // Code references load when they fit, otherwise they are named for skills_get; never silently dropped.
    for (const reference of references) assert.ok([...result.references, ...result.deferredReferences].includes(reference), `${request}: ${reference}`);
    assert.ok(result.bytes <= result.byteBudget && result.bytes === Buffer.byteLength(result.context), request);
  }
  const roomy = await recommendSkills(new SkillRegistry(), { ...INPUT, byteBudget: 40_000, request: 'make a shop with DataStore saving' });
  assert.deepEqual(roomy.references, ['arcane-datastore-safety:template', 'arcane-gameplay-systems:recipes']);
  for (const code of ['GetRequestBudgetForRequestType', 'BindToClose', 'UpdateAsync', 'OnServerEvent', 'Net.allow']) assert.ok(roomy.context.includes(code), code);
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
