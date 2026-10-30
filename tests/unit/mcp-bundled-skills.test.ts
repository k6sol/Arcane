import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { SkillRegistry } from '../../apps/mcp/src/skills.js';

// Offline SDK/stdio and relocated-code fixtures only. No daemon, native Studio,
// provider CLI, inference, installation or host credential/configuration reads.
const ROOT = resolve(process.cwd());
const TEMP = join(ROOT, 'tests/.tmp');
const ENTRY = fileURLToPath(new URL('../../apps/mcp/src/main.js', import.meta.url));
const SKILLS_MODULE = new URL('../../apps/mcp/src/skills.js', import.meta.url);
const TOKEN = 'bundled-skills-synthetic-bearer';
const STUDIO = 'arcane-studio-context';
const LIST = { limit: 100, allowExperimental: false };
const GET = { ids: [STUDIO], byteBudget: 128 * 1024, allowExperimental: false, references: [] as string[] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface Entry {
  id: string; title: string; description: string; keywords: string[]; path: string; sha256: string;
  status: 'approved' | 'experimental' | 'quarantined' | 'deprecated'; approved: boolean;
  evaluationRuns: { outcome: string; evidence: string }[];
  references: { name: string; path: string; sha256: string }[];
}
interface Registry { defaultLoadPolicy: 'approved-only'; skills: Entry[] }
const registryAt = async (root = ROOT): Promise<Registry> => JSON.parse(await readFile(join(root, 'skills/registry.json'), 'utf8')) as Registry;
const metadata = (entry: Entry) => ({ id: entry.id, title: entry.title, description: entry.description,
  status: entry.status, approved: entry.approved, references: entry.references.map(reference => reference.name) });

const cleanups = new WeakMap<test.TestContext, (() => Promise<unknown>)[]>();
function after(t: test.TestContext, action: () => Promise<unknown>) {
  let actions = cleanups.get(t);
  if (!actions) {
    actions = []; cleanups.set(t, actions);
    t.after(async () => {
      const failures: unknown[] = [];
      for (const cleanup of actions!.reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed.');
    });
  }
  actions.push(action);
}
async function directory(t: test.TestContext) {
  await mkdir(TEMP, { recursive: true });
  const base = await realpath(TEMP), root = await mkdtemp(join(base, 'bundled-skills-'));
  after(t, async () => {
    const child = relative(base, resolve(root));
    assert.ok(child.startsWith('bundled-skills-') && !child.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function linked(t: test.TestContext, projectRoot: string, skillRegistry?: SkillRegistry) {
  const server = createMcpServer({ projectRoot, client: new DaemonClient({ url: 'http://127.0.0.1:1', token: TOKEN }),
    ...(skillRegistry ? { skillRegistry } : {}) });
  const client = new Client({ name: 'bundled-skills-fixture', version: '1.0.0' });
  after(t, async () => { try { await client.close(); } finally { await server.close(); } });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const item = result.content.find(content => content.type === 'text');
  assert.ok(item && item.type === 'text');
  return { result, data: JSON.parse(item.text) as Record<string, any> };
}
async function authentic(client: Client) {
  const registry = await registryAt();
  const listed = await call(client, 'skills_list', { limit: 100 });
  assert.notEqual(listed.result.isError, true);
  assert.equal(listed.data.defaultLoadPolicy, 'approved-only');
  assert.equal(listed.data.allowExperimental, false);
  assert.deepEqual(listed.data.items, registry.skills.filter(entry => entry.approved).map(metadata));
  const optedIn = await call(client, 'skills_list', { allowExperimental: true, limit: 100 });
  assert.deepEqual(optedIn.data.items, registry.skills.filter(entry => entry.approved || entry.status === 'experimental').map(metadata));
  const entry = registry.skills.find(entry => entry.id === STUDIO)!;
  assert.equal(entry.status, 'experimental');
  assert.equal((await call(client, 'skills_get', { ids: [STUDIO] })).data.error.code, 'UNAPPROVED');
  const source = await readFile(join(ROOT, entry.path), 'utf8');
  assert.equal(hash(source), entry.sha256);
  const packed = await call(client, 'skills_get', { ids: [STUDIO], allowExperimental: true });
  assert.notEqual(packed.result.isError, true);
  assert.ok(packed.data.context.includes(`## Loaded skill: ${STUDIO}\n${source}`));
  assert.match(packed.data.context, /Experimental content/);
  assert.match(packed.data.context, /does not grant tools, permissions, publishing or provider spend/);
  assert.equal(packed.data.bytes, Buffer.byteLength(packed.data.context, 'utf8'));
  assert.equal(packed.data.approvalChanged, false);
  assert.deepEqual(packed.data.ids, [STUDIO]);
  assert.deepEqual(packed.data.references, []);
}
async function hostileProject(project: string) {
  await mkdir(join(project, 'scripts'), { recursive: true });
  await mkdir(join(project, 'skills'), { recursive: true });
  const spoof = { id: 'arcane-spoof', title: 'Workspace spoof', description: 'Untrusted project content', keywords: [],
    status: 'approved', approved: true, references: [], evaluationRuns: [{ outcome: 'passed', evidence: 'untrusted' }] };
  await writeFile(join(project, 'skills/registry.json'), JSON.stringify({ schemaVersion: 1, defaultLoadPolicy: 'approved-only', skills: [spoof] }));
  await writeFile(join(project, 'scripts/skill-pack.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../EXECUTED', import.meta.url), 'untrusted module executed');
export async function loadRegistry() { return ${JSON.stringify({ defaultLoadPolicy: 'approved-only', skills: [spoof] })}; }
export async function packSkills() { return { context: 'workspace spoof' }; }
`);
}
async function notExecuted(project: string) { await assert.rejects(readFile(join(project, 'EXECUTED')), { code: 'ENOENT' }); }
async function dataFixture(t: test.TestContext) {
  const parent = await directory(t), root = join(parent, 'data');
  await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  return { root, registry: await registryAt(root), save: (registry: Registry) => writeFile(join(root, 'skills/registry.json'), JSON.stringify(registry)) };
}

test('bundled MCP skills load authentic approved-only metadata and selected content in a fresh empty project', async t => {
  const project = await directory(t);
  assert.deepEqual(await readdir(project), []);
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Skill tools must stay offline.'); });
  await authentic(await linked(t, project));
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(await readdir(project), []);
});

test('project skill registry and malicious skill-pack module never supply data or execute', async t => {
  const project = await directory(t); await hostileProject(project);
  await authentic(await linked(t, project));
  await notExecuted(project);
});

test('fresh official stdio MCP with --project and cwd at a hostile project uses the bundled pack', async t => {
  const project = await directory(t); await hostileProject(project);
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, '--project', project], cwd: project,
    env: { ARCANE_DAEMON_URL: 'http://127.0.0.1:1', ARCANE_LOCAL_TOKEN: TOKEN }, stderr: 'pipe' });
  const client = new Client({ name: 'bundled-skills-stdio-fixture', version: '1.0.0' });
  after(t, async () => { await client.close(); });
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  await client.connect(transport);
  await authentic(client);
  await notExecuted(project);
  assert.equal(diagnostics, '');
});

test('relocated Windows product layout resolves its own parser and registry, including paths with URL characters', async t => {
  const temporary = await directory(t), bundle = join(temporary, 'portable # % bundle/resources/product');
  const target = join(bundle, 'dist/apps/mcp/src/skills.js');
  await mkdir(join(bundle, 'dist/apps/mcp/src'), { recursive: true });
  await mkdir(join(bundle, 'scripts'));
  await writeFile(join(bundle, 'package.json'), '{"type":"module"}');
  await copyFile(SKILLS_MODULE, target);
  await copyFile(join(ROOT, 'scripts/skill-pack.mjs'), join(bundle, 'scripts/skill-pack.mjs'));
  await cp(join(ROOT, 'skills'), join(bundle, 'skills'), { recursive: true });
  const registry = await registryAt(bundle), approved = registry.skills[0]!;
  approved.status = 'approved'; approved.approved = true;
  approved.evaluationRuns = [{ outcome: 'passed', evidence: 'explicit-relocated-fixture-only' }];
  await writeFile(join(bundle, 'skills/registry.json'), JSON.stringify(registry));
  const relocated = await import(pathToFileURL(target).href) as { SkillRegistry: typeof SkillRegistry };
  const skills = new relocated.SkillRegistry();
  assert.deepEqual((await skills.list(LIST)).items, [metadata(approved)]);
  const packed = await skills.get(GET);
  const source = await readFile(join(bundle, approved.path), 'utf8');
  assert.equal(hash(source), approved.sha256);
  assert.ok(packed.context.includes(source));
  assert.equal(packed.approvalChanged, false);
  await writeFile(join(bundle, approved.path), source + '\nchanged fixture\n');
  await assert.rejects(() => skills.get(GET), { code: 'INTEGRITY' });
});

test('compiled MCP stdio smoke from a disposable resources/product bundle serves skills to a hostile workspace', async t => {
  const temporary = await directory(t), bundle = join(temporary, 'resources/product'), project = await directory(t);
  await hostileProject(project);
  // Copy the compiled application closure into the shipped root layout. SDK
  // dependencies resolve from this trusted checkout; no install or accepted
  // release mutation is part of this layout regression smoke.
  const compiled = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  await mkdir(join(bundle, 'dist/apps'), { recursive: true });
  await cp(join(compiled, 'apps/mcp'), join(bundle, 'dist/apps/mcp'), { recursive: true });
  await cp(join(compiled, 'apps/daemon'), join(bundle, 'dist/apps/daemon'), { recursive: true });
  // Prepared asset wire validation shares the shipped GLB preflight module.
  // Use the same compiled application closure as the actual desktop package.
  await cp(join(compiled, 'apps/desktop'), join(bundle, 'dist/apps/desktop'), { recursive: true });
  await cp(join(compiled, 'packages'), join(bundle, 'dist/packages'), { recursive: true });
  await mkdir(join(bundle, 'scripts'));
  await copyFile(join(ROOT, 'scripts/skill-pack.mjs'), join(bundle, 'scripts/skill-pack.mjs'));
  await cp(join(ROOT, 'skills'), join(bundle, 'skills'), { recursive: true });
  await writeFile(join(bundle, 'package.json'), '{"type":"module"}');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(bundle, 'dist/apps/mcp/src/main.js'), '--project', project], cwd: project,
    env: { ARCANE_DAEMON_URL: 'http://127.0.0.1:1', ARCANE_LOCAL_TOKEN: TOKEN }, stderr: 'pipe' });
  const client = new Client({ name: 'packaged-layout-skills-smoke', version: '1.0.0' });
  after(t, async () => { await client.close(); });
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Packaged MCP fixture startup failed: ${diagnostics}`, { cause: error }); }
  await authentic(client); await notExecuted(project);
  assert.equal(diagnostics, '');
});

test('bundled executable/parser and registry files reject hardlinks and parser directory junctions/symlinks', async t => {
  for (const kind of ['parser-hardlink', 'module-hardlink', 'registry-hardlink', 'parser-directory-link']) {
    await t.test(kind, async t => {
      const temporary = await directory(t), bundle = join(temporary, 'product'), target = join(bundle, 'dist/apps/mcp/src/skills.js');
      await mkdir(join(bundle, 'dist/apps/mcp/src'), { recursive: true });
      await mkdir(join(bundle, 'parser-storage'));
      await writeFile(join(bundle, 'package.json'), '{"type":"module"}');
      const parser = join(bundle, 'parser-storage/skill-pack.mjs');
      await copyFile(join(ROOT, 'scripts/skill-pack.mjs'), parser);
      if (kind === 'module-hardlink') {
        const original = join(temporary, 'original-skills.js');
        await copyFile(SKILLS_MODULE, original); await link(original, target);
      } else await copyFile(SKILLS_MODULE, target);
      if (kind === 'parser-directory-link') {
        await symlink(join(bundle, 'parser-storage'), join(bundle, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await mkdir(join(bundle, 'scripts'));
        if (kind === 'parser-hardlink') await link(parser, join(bundle, 'scripts/skill-pack.mjs'));
        else await copyFile(parser, join(bundle, 'scripts/skill-pack.mjs'));
      }
      await cp(join(ROOT, 'skills'), join(bundle, 'skills'), { recursive: true });
      if (kind === 'registry-hardlink') {
        const registryPath = join(bundle, 'skills/registry.json'), original = join(temporary, 'original-registry.json');
        await copyFile(registryPath, original); await rm(registryPath); await link(original, registryPath);
      }
      const relocated = await import(pathToFileURL(target).href) as { SkillRegistry: typeof SkillRegistry };
      await assert.rejects(() => new relocated.SkillRegistry().list(LIST), { code: 'BUNDLE_INTEGRITY' });
    });
  }
});

test('missing same-bundle parser or registry fails closed without selecting another root', async t => {
  const root = await directory(t); await hostileProject(root);
  const bundle = join(root, 'nested-bundle'), target = join(bundle, 'dist/apps/mcp/src/skills.js');
  await mkdir(join(bundle, 'dist/apps/mcp/src'), { recursive: true });
  await writeFile(join(bundle, 'package.json'), '{"type":"module"}');
  await copyFile(SKILLS_MODULE, target);
  const relocated = await import(pathToFileURL(target).href) as { SkillRegistry: typeof SkillRegistry };
  await assert.rejects(() => new relocated.SkillRegistry().list(LIST), { code: 'ENOENT' });
  await mkdir(join(bundle, 'scripts'));
  await copyFile(join(ROOT, 'scripts/skill-pack.mjs'), join(bundle, 'scripts/skill-pack.mjs'));
  await assert.rejects(() => new relocated.SkillRegistry().list(LIST), { code: 'ENOENT' });
  await notExecuted(root);
});

test('explicit data fixture retains existing experimental opt-in, byte budget and checksum scenarios', async t => {
  const fixture = await dataFixture(t), project = await directory(t);
  // A fixture data root never changes which module executes.
  await mkdir(join(fixture.root, 'scripts'));
  await writeFile(join(fixture.root, 'scripts/skill-pack.mjs'), "throw new Error('Fixture modules must never execute');\n");
  const client = await linked(t, project, new SkillRegistry({ fixtureRoot: fixture.root }));
  assert.deepEqual((await call(client, 'skills_list')).data.items, []);
  assert.equal((await call(client, 'skills_get', { ids: [STUDIO] })).data.error.code, 'UNAPPROVED');
  assert.ok((await call(client, 'skills_list', { allowExperimental: true, query: 'studio' })).data.items.length > 0);
  const packed = await call(client, 'skills_get', { ids: [STUDIO], allowExperimental: true });
  assert.match(packed.data.context, /Experimental content/); assert.equal(packed.data.approvalChanged, false);
  assert.equal((await call(client, 'skills_get', { ids: [STUDIO], allowExperimental: true, byteBudget: 256 })).data.error.code, 'BUDGET_EXCEEDED');
  const path = join(fixture.root, fixture.registry.skills[0]!.path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\nchanged\n');
  assert.equal((await call(client, 'skills_get', { ids: [STUDIO], allowExperimental: true })).data.error.code, 'INTEGRITY');
});

test('explicit approved fixture retains quarantined/deprecated rejection and recorded-evidence requirement', async t => {
  const fixture = await dataFixture(t), project = await directory(t), [approved, quarantined, deprecated] = fixture.registry.skills;
  assert.ok(approved && quarantined && deprecated);
  approved.status = 'approved'; approved.approved = true;
  approved.evaluationRuns = [{ outcome: 'passed', evidence: 'non-native-test-fixture-only' }];
  quarantined.status = 'quarantined'; deprecated.status = 'deprecated';
  await fixture.save(fixture.registry);
  const client = await linked(t, project, new SkillRegistry({ fixtureRoot: fixture.root }));
  assert.deepEqual((await call(client, 'skills_list')).data.items.map((item: Entry) => item.id), [STUDIO]);
  assert.equal((await call(client, 'skills_get', { ids: [STUDIO] })).data.approvalChanged, false);
  for (const entry of [quarantined, deprecated]) {
    assert.equal((await call(client, 'skills_get', { ids: [entry.id], allowExperimental: true })).data.error.code, 'UNAPPROVED');
    assert.ok(!(await call(client, 'skills_list', { allowExperimental: true, limit: 100 })).data.items.some((item: Entry) => item.id === entry.id));
  }
  approved.evaluationRuns = []; await fixture.save(fixture.registry);
  assert.equal((await call(client, 'skills_list')).data.error.code, 'REGISTRY');
});

test('bundled parser keeps selected references, checksums and contained-file boundaries in explicit fixtures', async t => {
  const fixture = await dataFixture(t), skills = new SkillRegistry({ fixtureRoot: fixture.root });
  const options = { ...GET, ids: ['arcane-genre-adaptation'], allowExperimental: true, references: ['arcane-genre-adaptation:obby'] };
  const packed = await skills.get(options);
  assert.match(packed.context, /# Obby \/ platformer/);
  assert.ok(!packed.context.includes('# Shooter / tactical combat'));
  await assert.rejects(() => skills.get({ ...options, references: ['arcane-genre-adaptation:../../outside'] }), { code: 'REFERENCES' });
  const skill = fixture.registry.skills.find(entry => entry.id === options.ids[0])!, reference = skill.references.find(entry => entry.name === 'obby')!;
  const source = await readFile(join(fixture.root, reference.path), 'utf8');
  await writeFile(join(fixture.root, reference.path), source + '\nchanged\n');
  await assert.rejects(() => skills.get(options), { code: 'INTEGRITY' });
  const outside = 'Synthetic outside text. No credentials.';
  await writeFile(join(fixture.root, '../outside-' + skill.id + '.md'), outside);
  // The outside file remains inside this test's owned temporary directory.
  reference.path = '../outside-' + skill.id + '.md'; reference.sha256 = hash(outside);
  await fixture.save(fixture.registry);
  await assert.rejects(() => skills.get(options), { code: 'PATH_ESCAPE' });
  const entry = fixture.registry.skills[0]!; entry.path = reference.path; entry.sha256 = reference.sha256;
  await fixture.save(fixture.registry);
  await assert.rejects(() => skills.get({ ...GET, allowExperimental: true }), { code: 'PATH_ESCAPE' });
});

test('MCP schemas expose no fixture, module, path or root selectors', async t => {
  const project = await directory(t); await hostileProject(project);
  const client = await linked(t, project), tools = (await client.listTools()).tools;
  for (const [name, args, keys] of [
    ['skills_list', {}, ['allowExperimental', 'limit', 'query']],
    ['skills_get', { ids: [STUDIO], allowExperimental: true }, ['allowExperimental', 'byteBudget', 'ids', 'references']],
  ] as const) {
    const schema = tools.find(tool => tool.name === name)!.inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...keys].sort());
    for (const key of ['root', 'projectRoot', 'fixtureRoot', 'module', 'path', 'skillRegistry']) {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args, [key]: project } }));
      assert.equal(result.isError, true, `${name} must reject ${key}`);
    }
  }
  await notExecuted(project);
});

test('actual bundled whole-game composition progressively loads intact presentation bodies without approval or network effects', async t => {
  const project = await directory(t), network = t.mock.method(globalThis, 'fetch', async () => { throw Error('Skill composition must stay offline.'); });
  const client = await linked(t, project), registry = await registryAt(), original = await readFile(join(ROOT, 'skills/registry.json'));
  const reply = await call(client, 'skills_recommend', { request: 'Create a complete puzzle game with a coherent player journey.' });
  assert.notEqual(reply.result.isError, true); assert.equal(reply.data.available, true);
  assert.deepEqual(reply.data.ids, ['arcane-project-director', 'arcane-genre-adaptation']);
  assert.equal(reply.data.composition.intent, 'whole-game'); assert.equal(reply.data.composition.primaryGenre, 'puzzle');
  assert.equal(reply.data.composition.initialCoverage, 'director-and-genre'); assert.equal(reply.data.composition.guidanceOnly, true);
  assert.equal(reply.data.byteBudget, 10_240); assert.ok(reply.data.bytes <= 10_240);
  assert.equal(reply.data.bytes, Buffer.byteLength(reply.data.context)); assert.equal(reply.data.approvalChanged, false);
  for (const id of reply.data.ids) {
    const entry = registry.skills.find(entry => entry.id === id); assert.ok(entry);
    const source = await readFile(join(ROOT, entry.path), 'utf8'); assert.equal(hash(source), entry.sha256);
    assert.ok(reply.data.context.includes(`## Loaded skill: ${id}\n${source}`));
  }
  const presentation = reply.data.composition.phases.find((phase: { phase: string; ids: string[] }) => phase.phase === 'presentation');
  assert.ok(presentation); assert.ok(presentation.ids.length <= 8);
  assert.deepEqual(presentation.ids, ['arcane-interface', 'arcane-rig-animation', 'arcane-vfx', 'arcane-audio', 'arcane-accessibility', 'arcane-onboarding', 'arcane-gameplay-feel']);
  // A phase is not a silently oversized pack: the real reader refuses it whole.
  const oversized = await call(client, 'skills_get', { ids: presentation.ids, allowExperimental: true, byteBudget: 10_240 });
  assert.equal(oversized.result.isError, true); assert.equal(oversized.data.error.code, 'BUDGET_EXCEEDED');
  for (const id of presentation.ids) {
    assert.ok(!reply.data.ids.includes(id)); assert.ok(!reply.data.context.includes(`## Loaded skill: ${id}\n`));
    const refused = await call(client, 'skills_get', { ids: [id], byteBudget: 10_240 });
    assert.equal(refused.result.isError, true); assert.equal(refused.data.error.code, 'UNAPPROVED');
    const loaded = await call(client, 'skills_get', { ids: [id], allowExperimental: true, byteBudget: 10_240 });
    const entry = registry.skills.find(entry => entry.id === id); assert.ok(entry);
    const source = await readFile(join(ROOT, entry.path), 'utf8'); assert.equal(hash(source), entry.sha256);
    assert.notEqual(loaded.result.isError, true); assert.deepEqual(loaded.data.ids, [id]); assert.deepEqual(loaded.data.references, []);
    assert.ok(loaded.data.context.includes(`## Loaded skill: ${id}\n${source}`));
    assert.equal(loaded.data.bytes, Buffer.byteLength(loaded.data.context)); assert.ok(loaded.data.bytes <= 10_240);
    assert.equal(loaded.data.approvalChanged, false);
  }
  assert.deepEqual((await call(client, 'skills_list')).data.items, []);
  assert.deepEqual(await readFile(join(ROOT, 'skills/registry.json')), original);
  assert.equal(network.mock.callCount(), 0); assert.deepEqual(await readdir(project), []);
});

test('staged eligibility does not bypass actual deferred content integrity or direct-reader policy', async t => {
  const fixture = await dataFixture(t), project = await directory(t), skills = new SkillRegistry({ fixtureRoot: fixture.root });
  const client = await linked(t, project, skills), sourceRegistry = await readFile(join(fixture.root, 'skills/registry.json'));
  const audio = fixture.registry.skills.find(entry => entry.id === 'arcane-audio'); assert.ok(audio);
  const source = await readFile(join(fixture.root, audio.path), 'utf8');
  await writeFile(join(fixture.root, audio.path), source + '\nTampered deferred presentation fixture.\n');
  const routed = await call(client, 'skills_recommend', { request: 'Build a complete racing game.' });
  assert.notEqual(routed.result.isError, true); assert.ok(!routed.data.ids.includes(audio.id));
  assert.ok(routed.data.composition.phases.some((phase: { ids: string[] }) => phase.ids.includes(audio.id)));
  const refused = await call(client, 'skills_get', { ids: [audio.id] });
  assert.equal(refused.result.isError, true); assert.equal(refused.data.error.code, 'UNAPPROVED');
  const checked = await call(client, 'skills_get', { ids: [audio.id], allowExperimental: true });
  assert.equal(checked.result.isError, true); assert.equal(checked.data.error.code, 'INTEGRITY');
  assert.deepEqual(await readFile(join(fixture.root, 'skills/registry.json')), sourceRegistry);
});
