import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRegistry, validatePack, refreshIntegrity, searchSkills, packSkills, readContained } from '../../scripts/skill-pack.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TEMP_ROOT = path.join(ROOT, 'tests', 'skills', '.tmp');
const hash = x => createHash('sha256').update(x).digest('hex');
const rejects = (work, code) => assert.rejects(work, error => error.code === code);

async function fixture(t) {
  // Use the authorized checkout rather than a host-specific redirected sandbox TEMP.
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const temp = await fs.realpath(TEMP_ROOT);
  const root = await fs.mkdtemp(path.join(temp, 'arcane-skills-test-'));
  t.after(async () => {
    const relative = path.relative(temp, path.resolve(root));
    assert.ok(relative.startsWith('arcane-skills-test-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = 'arcane-fixture';
  const description = 'Inspect a disposable test fixture; not a real behavioral skill.';
  const body = `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\nlicense: MIT\n---\n\n# Fixture\n\n${'Disposable implementation fixture with Unicode café 🧩 and no external actions. '.repeat(4)}\n`;
  const ref = '# Explicit reference\nThis is only loaded on a deliberate request.\n';
  await fs.mkdir(path.join(root, 'skills', 'arcane', id), { recursive: true });
  await fs.writeFile(path.join(root, 'skills', 'arcane', id, 'SKILL.md'), body);
  await fs.writeFile(path.join(root, 'skills', 'arcane', id, 'reference.md'), ref);
  const registry = { schemaVersion: 1, defaultLoadPolicy: 'approved-only', skills: [{ id, title: 'Fixture', description, keywords: ['fixture'], path: `skills/arcane/${id}/SKILL.md`, sha256: hash(body), status: 'experimental', approved: false, evaluationRuns: [], references: [{ name: 'sample', path: `skills/arcane/${id}/reference.md`, sha256: hash(ref) }] }] };
  const save = () => fs.writeFile(path.join(root, 'skills', 'registry.json'), JSON.stringify(registry));
  await save();
  return { root, id, registry, save, body };
}

test('real authored pack validates without claiming behavioral approval', async () => {
  const result = await validatePack(ROOT);
  assert.equal(result.skills, 62);
  assert.equal(result.references, 35);
  assert.equal(result.approved, 0);
  assert.equal(result.behaviorRuns, 0);
  assert.equal(result.verification, 'offline-structure-and-integrity-only');
});

test('packaged text uses stable LF bytes rather than checkout-dependent CRLF', async () => {
  const registry = await loadRegistry(ROOT);
  for (const skill of registry.skills) {
    for (const item of [skill, ...skill.references]) {
      assert.ok(!(await readContained(ROOT, item.path)).text.includes('\r'), item.path);
    }
  }
  const attributes = await fs.readFile(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.ok(attributes.includes('*.md text eol=lf'));
  assert.ok(attributes.includes('*.json text eol=lf'));
});

test('experimental skills are not loaded by default', async () => {
  await rejects(() => packSkills(['arcane-combat'], { root: ROOT }), 'UNAPPROVED');
});

test('explicit experimental opt-in packs only selected skills', async () => {
  const result = await packSkills(['arcane-combat', 'arcane-remote-security'], { root: ROOT, allowExperimental: true });
  assert.deepEqual(result.ids, ['arcane-combat', 'arcane-remote-security']);
  assert.deepEqual(result.references, []);
  assert.equal(result.approvalChanged, false);
  assert.equal(result.tokenCount, null);
  assert.ok(!result.context.includes('## Loaded skill: arcane-monetization'));
});

test('one genre reference does not load the entire genre catalogue', async () => {
  const result = await packSkills(['arcane-genre-adaptation'], { root: ROOT, allowExperimental: true, references: ['arcane-genre-adaptation:obby'] });
  assert.deepEqual(result.references, ['arcane-genre-adaptation:obby']);
  assert.ok(result.context.includes('# Obby / platformer'));
  assert.ok(!result.context.includes('# Shooter / tactical combat'));
});

test('byte budget includes headers and multibyte Unicode', async t => {
  const f = await fixture(t);
  const result = await packSkills([f.id], { root: f.root, allowExperimental: true });
  assert.equal(result.bytes, Buffer.byteLength(result.context, 'utf8'));
  assert.ok(result.bytes > result.context.length);
  await rejects(() => packSkills([f.id], { root: f.root, allowExperimental: true, byteBudget: result.bytes - 1 }), 'BUDGET_EXCEEDED');
  const exact = await packSkills([f.id], { root: f.root, allowExperimental: true, byteBudget: result.bytes });
  assert.equal(exact.context, result.context);
});

test('unknown skill ID fails rather than selecting a substitute', async () => {
  await rejects(() => packSkills(['arcane-nonexistent'], { root: ROOT, allowExperimental: true }), 'UNKNOWN_SKILL');
});
test('duplicate selection is rejected', async () => {
  await rejects(() => packSkills(['arcane-combat', 'arcane-combat'], { root: ROOT, allowExperimental: true }), 'IDS');
});
test('unbounded full-pack selection is rejected', async () => {
  const ids = (await loadRegistry(ROOT)).skills.slice(0, 9).map(s => s.id);
  await rejects(() => packSkills(ids, { root: ROOT, allowExperimental: true }), 'IDS');
});
test('undeclared reference cannot read an arbitrary path', async () => {
  await rejects(() => packSkills(['arcane-combat'], { root: ROOT, allowExperimental: true, references: ['arcane-combat:../../LICENSE'] }), 'REFERENCES');
});
test('reference from an unselected skill is rejected', async () => {
  await rejects(() => packSkills(['arcane-combat'], { root: ROOT, allowExperimental: true, references: ['arcane-genre-adaptation:obby'] }), 'REFERENCES');
});
test('duplicate references are rejected', async () => {
  await rejects(() => packSkills(['arcane-genre-adaptation'], { root: ROOT, allowExperimental: true, references: ['arcane-genre-adaptation:obby', 'arcane-genre-adaptation:obby'] }), 'REFERENCES');
});
test('targeted search returns candidates, not approval', async () => {
  const result = await searchSkills('combat hitbox', { root: ROOT });
  assert.equal(result[0].id, 'arcane-combat');
  assert.equal(result[0].candidateOnly, true);
  assert.equal(result[0].status, 'experimental');
});
test('unrelated or empty query does not recommend the whole library', async () => {
  assert.deepEqual(await searchSkills('souffle dinner recipe', { root: ROOT }), []);
  assert.deepEqual(await searchSkills('please help my roblox game', { root: ROOT }), []);
});
test('entrypoint tampering is detected on actual read', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, f.registry.skills[0].path), '\nChanged after indexing.');
  await rejects(() => packSkills([f.id], { root: f.root, allowExperimental: true }), 'INTEGRITY');
});
test('reference tampering is detected when selected', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, f.registry.skills[0].references[0].path), '\nChanged reference.');
  await rejects(() => packSkills([f.id], { root: f.root, allowExperimental: true, references: [`${f.id}:sample`] }), 'INTEGRITY');
});
test('duplicate registry identifiers are rejected', async t => {
  const f = await fixture(t);
  f.registry.skills.push(structuredClone(f.registry.skills[0]));
  await f.save();
  await rejects(() => loadRegistry(f.root), 'REGISTRY');
});
test('path traversal and absolute paths are rejected', async t => {
  const f = await fixture(t);
  await rejects(() => readContained(f.root, '../outside.txt'), 'PATH_ESCAPE');
  await rejects(() => readContained(f.root, path.join(f.root, 'skills', 'registry.json')), 'INVALID_PATH');
});
test('directory symlink/junction cannot escape repository', async t => {
  const f = await fixture(t);
  const temp = await fs.realpath(TEMP_ROOT);
  const outside = await fs.mkdtemp(path.join(temp, 'arcane-skills-test-'));
  t.after(async () => {
    const relative = path.relative(temp, path.resolve(outside));
    assert.ok(relative.startsWith('arcane-skills-test-') && !relative.includes(path.sep));
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'Fixture outside the selected repository.');
  try { await fs.symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Platform denied symlink fixture creation.'); throw error; }
  await rejects(() => readContained(f.root, 'escape/secret.txt'), 'PATH_ESCAPE');
});
test('approval flag cannot contradict status', async t => {
  const f = await fixture(t);
  f.registry.skills[0].approved = true;
  await f.save();
  await rejects(() => loadRegistry(f.root), 'REGISTRY');
});
test('approved status without any behavior evidence is rejected', async t => {
  const f = await fixture(t);
  Object.assign(f.registry.skills[0], { approved: true, status: 'approved' });
  await f.save();
  await rejects(() => loadRegistry(f.root), 'REGISTRY');
});
test('integrity refresh cannot silently alter approved content', async t => {
  const f = await fixture(t);
  Object.assign(f.registry.skills[0], { approved: true, status: 'approved', evaluationRuns: [{ outcome: 'passed', evidence: 'TEST FIXTURE ONLY' }] });
  await f.save();
  await rejects(() => refreshIntegrity(f.root), 'APPROVAL_REVIEW');
});
test('explicit experimental rehash does not promote a skill', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, f.registry.skills[0].path), '\nLocal reviewed edit for fixture.');
  const result = await refreshIntegrity(f.root);
  assert.equal(result.approved, 0);
  assert.equal(result.behaviorRuns, 0);
  assert.equal((await loadRegistry(f.root)).skills[0].status, 'experimental');
});

test('integrity refresh never deletes a temporary file it did not create', async t => {
  const f = await fixture(t);
  const temporary = path.join(f.root, 'skills', `registry.json.${process.pid}.tmp`);
  const sentinel = 'Pre-existing file owned by another invocation or user.';
  await fs.writeFile(temporary, sentinel);
  const before = await fs.readFile(path.join(f.root, 'skills', 'registry.json'), 'utf8');
  await rejects(() => refreshIntegrity(f.root), 'EEXIST');
  assert.equal(await fs.readFile(temporary, 'utf8'), sentinel);
  assert.equal(await fs.readFile(path.join(f.root, 'skills', 'registry.json'), 'utf8'), before);
});
test('entrypoint/registry identity mismatch is rejected', async t => {
  const f = await fixture(t);
  const body = f.body.replace('name: arcane-fixture', 'name: arcane-other');
  await fs.writeFile(path.join(f.root, f.registry.skills[0].path), body);
  f.registry.skills[0].sha256 = hash(body);
  await f.save();
  await rejects(() => validatePack(f.root), 'REGISTRY');
});
test('oversized file is rejected before context packing', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'huge.txt'), 'x'.repeat(129 * 1024));
  await rejects(() => readContained(f.root, 'huge.txt'), 'FILE_LIMIT');
});
test('non-finite and fractional budgets are rejected', async () => {
  for (const byteBudget of [NaN, Infinity, 512.5]) {
    await rejects(() => packSkills(['arcane-combat'], { root: ROOT, allowExperimental: true, byteBudget }), 'BUDGET');
  }
});
test('quarantined entries cannot be loaded through experimental opt-in', async t => {
  const f = await fixture(t);
  f.registry.skills[0].status = 'quarantined';
  await f.save();
  await rejects(() => packSkills([f.id], { root: f.root, allowExperimental: true }), 'UNAPPROVED');
  assert.deepEqual(await searchSkills('fixture', { root: f.root }), []);
});


// Entrypoints carry selection/safety contracts; explicitly declared references
// carry detailed field guides and recipes. Check both without loading unrelated
// skills or treating technical examples as a completed game.
async function readGuidance(id) {
  const entry = (await loadRegistry(ROOT)).skills.find(skill => skill.id === id);
  assert.ok(entry, id);
  return [(await readContained(ROOT, entry.path)).text,
    ...await Promise.all(entry.references.map(async ref => (await readContained(ROOT, ref.path)).text))].join('\n');
}
function containsGuidance(text, rules, label = '') {
  for (const rule of rules) assert.ok(text.toLowerCase().includes(rule.toLowerCase()), `${label}: ${rule}`);
}

test('scene recipes are prescriptive: terrain ground, natural Poisson placement, anti-ring rule and batch tools', async () => {

  const nature = await readGuidance('arcane-natural-scenes'), architecture = await readGuidance('arcane-architectural-features'), world = await readGuidance('arcane-world-building');
  containsGuidance(nature, ['Blender', 'UV', 'PBR', 'terrain_generate', 'environment_apply', 'Poisson', 'scatter', 'clearing', 'avoidPaths', 'footprintRadius', 'grass', 'branch', 'assets_preview']);
  containsGuidance(nature, ['FOREST_SOURCES_REQUIRED', 'before', 'explicit primitive prototypes']);
  assert.match(nature, /not proof of Blender authorship|does not prove Blender provenance/i);
  assert.doesNotMatch(nature, /else a blockout \(reported\)/, 'missing sources must not silently create primitive trees');
  containsGuidance(architecture, ['Blender', 'UV', 'PBR', 'assets_preview', 'SpawnLocation', 'scene_update', 'spiral', 'requested']);
  containsGuidance(world, ['Poisson', 'ground', 'route', 'original', 'Blender']);
  assert.ok((await readSkill('arcane-natural-scenes')).includes('references/scene-build.md'), 'detailed placement guidance remains discoverable');
});

test('DataStore safety skill encodes the non-destructive persistence rules', async () => {

  const text = await readSkill('arcane-datastore-safety');
  containsGuidance(text, ['Never wipe, rename', 'explicit request', 'pcall', 'GetRequestBudgetForRequestType', 'UpdateAsync, not SetAsync', 'unique session token', 'BindToClose', 'Studio Access to API Services', 'failed load', 'overwrites real data', 'cancelled transform', 'future versions']);
  const pack = await packSkills(['arcane-datastore-safety'], { root: ROOT, allowExperimental: true });
  assert.ok(pack.context.includes('## Loaded skill: arcane-datastore-safety'));
});

async function readSkill(id) { return (await readContained(ROOT, `skills/arcane/${id}/SKILL.md`)).text; }
// Built-in particle textures verified in a Studio install's content/textures/particles folder.
const BUILT_IN_PARTICLES = new Set(['fire_main.dds', 'fire_sparks_main.dds', 'smoke_main.dds', 'sparkles_main.dds', 'explosion01_smoke_main.dds',
  'explosion01_core_main.dds', 'explosion01_shockwave_main.dds', 'forcefield_glow_main.dds', 'forcefield_vortex_main.dds', 'SquareParticle.png']);

test('VFX skill gives exact emitter presets, verified built-in textures and runtime verification', async () => {

  const vfx = await readGuidance('arcane-vfx');
  containsGuidance(vfx, ['scene_build', 'scene_create', 'script_update', 'script_set_enabled', 'playtest_request', 'playtest_status', 'Beam', 'Trail', 'Attachment', 'NumberSequence', 'ColorSequence', 'LightEmission', 'Drag', 'fire', 'smoke', 'waterfall', 'burst', 'cleanup']);
  const entry = await readSkill('arcane-vfx');
  containsGuidance(entry, ['references/recipes.md', 'rate', 'lifetime', 'actual', 'server', 'reduced', 'not invent']);
  const recipes = await packSkills(['arcane-vfx'], { root: ROOT, allowExperimental: true, references: ['arcane-vfx:recipes'] });
  containsGuidance(recipes.context, ['## Campfire', '## Waterfall', '## Bursts', '## Beams and trails', '## Attachment placement', '## Performance budgets', ':Emit(count)']);
  for (const skill of (await loadRegistry(ROOT)).skills) for (const item of [skill, ...skill.references]) {
    const text = (await readContained(ROOT, item.path)).text;
    assert.doesNotMatch(text, /rbxassetid:\/\/\d/, `${item.path} must not invent asset ids`);
    for (const [, file] of text.matchAll(/rbxasset:\/\/textures\/particles\/([\w.]+)/g)) assert.ok(BUILT_IN_PARTICLES.has(file), file);
  }
});

test('photoreal skill encodes mood presets with exact environment_apply fields, scale and imperfection rules', async () => {

  const text = await readGuidance('arcane-photoreal');
  containsGuidance(text, ['ClockTime', 'ExposureCompensation', 'OutdoorAmbient', 'Density', 'Haze', 'Decay', 'TintColor', 'MaterialVariant', 'SurfaceAppearance', 'environment_apply', 'terrain_generate', 'studio_viewport_capture', 'PBR', 'scale', 'roughness']);
  containsGuidance(await readSkill('arcane-photoreal'), ['reference', 'actual', 'not', 'geometry']);
  assert.doesNotMatch(text, /Arcane cannot set|\bExposure \d/);
});

test('interface skill is a design system with tokens, responsive rules, accessible contrast and declared recipes', async () => {

  const text = await readGuidance('arcane-interface');
  containsGuidance(text, ['UICorner', 'UIStroke', 'UIPadding', 'UIListLayout', 'UIGridLayout', 'UIAspectRatioConstraint', 'UIScale', 'UISizeConstraint', 'UITextSizeConstraint', 'Activated', '44', 'contrast', 'ResetOnSpawn', 'script_set_enabled', 'scene_build', 'ScreenGui', 'scene.gui', 'prototypes', 'script_update', 'SurfaceGui', 'AnchorPoint', 'FontFace']);
  containsGuidance(await readSkill('arcane-interface'), ['server', 'pending', 'denied', 'respawn', 'focus', 'references/recipes.md', 'references/controller.md']);
  const pack = await packSkills(['arcane-interface'], { root: ROOT, allowExperimental: true, references: ['arcane-interface:recipes'] });
  containsGuidance(pack.context, ['## Main menu', '## HUD with health and stamina', '## Shop', '## Inventory grid', '## Notifications', '## Loading screen', '## Settings panel']);
  const kit = await packSkills(['arcane-interface'], { root: ROOT, allowExperimental: true, references: ['arcane-interface:controller'] });
  containsGuidance(kit.context, ['TweenService', 'MouseEnter', 'InputBegan', 'SelectionGained', 'GroupTransparency', 'AbsoluteSize', 'Disconnect()']);
  assert.doesNotMatch(text, /cannot create GuiObjects|built at runtime by code/);
});

test('scripting, security and systems skills are prescriptive and cross-linked instead of duplicated', async () => {

  const luau = await readGuidance('arcane-luau-architecture'), security = await readSkill('arcane-remote-security'), systems = await readSkill('arcane-gameplay-systems');
  containsGuidance(luau, ['--!strict', 'script_update', 'script_set_enabled', 'CollectionService', 'TweenService', 'RunService', 'task.wait', 'arcane-datastore-safety', 'arcane-luau-architecture:patterns']);
  const patterns = await packSkills(['arcane-luau-architecture'], { root: ROOT, allowExperimental: true, references: ['arcane-luau-architecture:patterns'] });
  containsGuidance(patterns.context, ['GetInstanceAddedSignal', 'OnServerEvent', 'os.clock()', 'task.cancel', 'Disconnect()', 'PlayerRemoving']);
  containsGuidance(security, ['Rate-limit', 'NaN', 'distance', 'server', 'replay', 'SetNetworkOwner(nil)', 'legitimate', 'InvokeClient', 'UnreliableRemoteEvent']);
  containsGuidance(systems, ['server', 'scene_build', 'script_update', 'script_set_enabled', 'arcane-remote-security', 'arcane-luau-architecture', 'arcane-npc', 'arcane-datastore-safety']);
});

test('characters skill covers rigs, verifiable default animations, pathfinding, states, dialogue and authority, and is cross-linked', async () => {

  const text = await readGuidance('arcane-characters'), entryText = await readSkill('arcane-characters');
  containsGuidance(text, ['CreateHumanoidModelFromDescription', 'HumanoidDescription', 'HumanoidRigType.R15', 'Animator', 'LoadAnimation', 'PathfindingService', 'AgentRadius', 'ComputeAsync', 'PathStatus.Success', 'PathWaypointAction.Jump', 'ProximityPrompt', 'SetNetworkOwner', 'arcane-npc']);
  containsGuidance(entryText, ['Blender', 'UV', 'PBR', 'actual', 'server', 'character.Animate', 'never guess', 'not', 'references/npc-rig.md', 'references/npc-ai.md', 'references/dialogue.md', 'references/pets.md']);
  const registry = await loadRegistry(ROOT), entry = registry.skills.find(skill => skill.id === 'arcane-characters');
  for (const keyword of ['npc', 'character', 'enemy', 'animation', 'rig', 'pathfinding', 'ai', 'pet', 'shopkeeper']) assert.ok(entry.keywords.includes(keyword), keyword);
  assert.deepEqual(entry.references.map(r => r.name), ['npc-rig', 'npc-ai', 'dialogue', 'pets']);
  const code = {
    'npc-rig': ['CreateHumanoidModelFromDescription', 'AnimationPriority.Movement', 'AdjustWeight', 'SetNetworkOwner', 'ModelStreamingMode.Atomic', 'Heartbeat', 'Died:Once'],
    'npc-ai': ['CreatePath', 'AgentRadius', 'ComputeAsync', 'Blocked:Connect', 'PathWaypointAction.Jump', 'TakeDamage'],
    dialogue: ['ProximityPrompt', 'Triggered', 'OnServerEvent', 'typeof(', 'MAX_DISTANCE', 'MaxVisibleGraphemes'],
    pets: ['PlayerData.get', 'PlayerData.changed', 'GenerateGUID', 'MAX_EQUIPPED', 'AlignPosition', 'typeof('] };
  for (const [name, needles] of Object.entries(code)) {
    const pack = await packSkills(['arcane-characters'], { root: ROOT, allowExperimental: true, references: [`arcane-characters:${name}`] });
    assert.ok(pack.context.includes('--!strict'), name); containsGuidance(pack.context, needles, name);
    assert.doesNotMatch(pack.context, /rbxassetid:\/\/\d|:SetAsync\(|(?<![\w.:])wait\s*\(/, name);
  }
  const pair = await packSkills(['arcane-characters', 'arcane-gameplay-systems'], { root: ROOT, allowExperimental: true });
  assert.ok(pair.bytes <= 10_240, `characters + systems load is ${pair.bytes} bytes`);
});

test('blender props model-spec reference teaches the whole part graph within the default load', async () => {
  const pack = await packSkills(['arcane-blender-props'], { root: ROOT, allowExperimental: true, references: ['arcane-blender-props:model-spec'] });
  assert.ok(pack.bytes <= 16_384, `blender props + model-spec is ${pack.bytes} bytes`);
  for (const text of ['kind:"spec"', '`revolve`', '`extrude`', '`loft`', '`sweep`', '`sdf`', '`mirror`', '`radial`', '`array`', '`scatter`', 'csg:"union"', '`flutes`', '`noise`', 'review',
    'Lantern', 'Barrel', 'Park bench', 'Chair', 'Stone arch', 'Fountain', 'Sword', 'Crate', 'Fluted column', 'spec -> build -> look -> adjust']) assert.ok(pack.context.includes(text), text);
});

test('skill entrypoints stay lean enough for the default router budget', async () => {
  for (const skill of (await loadRegistry(ROOT)).skills) {
    const bytes = (await readContained(ROOT, skill.path)).bytes.length;
    assert.ok(bytes <= 7 * 1024, `${skill.id} is ${bytes} bytes`);
  }
});

test('genre kits are complete, lean, cross-linked blueprints with declared code references', async () => {

  const kits = { tycoon: ['dropper', 'conveyor', 'collector', 'claim', 'rebirth', 'arcane-economy'], obby: ['checkpoint', 'hazard', 'platform', 'stage', 'death'],
    simulator: ['sell', 'bag', 'egg', 'pet', 'zone', 'arcane-economy'], horror: ['threat', 'stalker', 'audio', 'recovery'],
    arena: ['lobby', 'intermission', 'epoch', 'hit', 'arcane-rounds', 'arcane-combat'], racing: ['checkpoint', 'lap', 'VehicleSeat', 'HingeConstraint', 'GetServerTimeNow', 'arcane-physics'],
    rpg: ['quest', 'dialogue', 'inventory', 'XP', 'level', 'arcane-inventory', 'arcane-characters'] };
  const registry = await loadRegistry(ROOT);
  for (const [genre, needles] of Object.entries(kits)) {
    const id = `arcane-${genre}-kit`, entry = registry.skills.find(s => s.id === id);
    assert.ok(entry && entry.status === 'experimental' && !entry.approved, id); assert.deepEqual(entry.references.map(r => r.name), ['patterns'], id);
    const pack = await packSkills([id], { root: ROOT, allowExperimental: true, references: [`${id}:patterns`] });
    const text = await readSkill(id); assert.ok(Buffer.byteLength(text) <= 6 * 1024, `${id} leaves router room`);
    containsGuidance(text, ['complete', 'scene_build', 'script_update', 'script_set_enabled', 'playtest_request', 'playtest_status', 'arcane-playtest-qa', 'arcane-datastore-safety', 'patterns', 'actual', 'failure'], id);
    containsGuidance(pack.context, ['UpdateAsync', 'session lock', ...needles], id);
    assert.ok(pack.context.includes('```lua') && pack.context.includes('--!strict'), `${id} retains actual code fragments`);
    const tuning = pack.context.split('## Conditional tuning examples')[1]; assert.ok(tuning, `${id} retains a tuning section`);
    assert.match(tuning, /not universal limits/i, `${id} values remain conditional`);
    assert.match(tuning, /^\|[^\n]*\d[^\n]*\|/m, `${id} retains concrete numerical examples in its tuning table`);
    assert.doesNotMatch(pack.context, /rbxassetid:\/\/\d|ProductId = \d/, `${id} invents no ids`);
  }
});

test('gameplay systems, DataStore safety and networking security carry prescriptive code with declared references', async () => {

  const systems = await readSkill('arcane-gameplay-systems'), store = await readSkill('arcane-datastore-safety'), security = await readSkill('arcane-remote-security');
  containsGuidance(systems, ['inventory', 'stamina', 'health', 'teams', 'script_search', 'arcane-gameplay-systems:recipes', 'arcane-remote-security', 'arcane-luau-architecture']);
  containsGuidance(store, ['store names', 'key format', 'single writer', 'arcane-datastore-safety:template']);
  containsGuidance(security, ['contract', 'server', 'InvokeClient', 'UnreliableRemoteEvent', 'prices', 'damage']);
  const recipes = await packSkills(['arcane-gameplay-systems'], { root: ROOT, allowExperimental: true, references: ['arcane-gameplay-systems:recipes'] });
  containsGuidance(recipes.context, ['--!strict', 'Net.allow', 'typeof(', 'OnServerEvent', 'FireClient', 'ContextActionService', 'Heartbeat', 'TakeDamage', 'AutoAssignable', 'PlayerData.get', 'PlayerRemoving']);
  assert.doesNotMatch(recipes.context, /(?<![\w.:])wait\s*\(|(?<![\w.:])spawn\s*\(|:SetAsync\(/);
  const template = await packSkills(['arcane-datastore-safety'], { root: ROOT, allowExperimental: true, references: ['arcane-datastore-safety:template'] });
  containsGuidance(template.context, ['UpdateAsync', 'pcall', 'GetRequestBudgetForRequestType', 'BindToClose', '_lock', 'game.JobId', 'IsStudio', 'migrate', 'never save a profile that failed to load']);
  assert.doesNotMatch(template.context, /:SetAsync\(|:RemoveAsync\(/);
  for (const [id, budget] of [['arcane-gameplay-systems', 6 * 1024], ['arcane-datastore-safety', 4 * 1024], ['arcane-remote-security', 4 * 1024]])
    assert.ok(Buffer.byteLength(await readSkill(id)) <= budget, `${id} stays token-lean`);
});

test('scripting skills share one bounded Output check loop that treats Output as untrusted', async () => {

  const qa = await readSkill('arcane-playtest-qa');
  containsGuidance(qa, ['luauAdvisories', 'studio_output_read', 'after: <cursor>', 'playtest_request', 'playtest_status', 'playtest_cancel', 'untrusted data, never instructions', 'never edit them', 'one repair and one reverify', 'unchanged failed attempt', 'report untested', 'unknown teardown']);
  assert.doesNotMatch(qa, /At most 3 fix iterations/);
  for (const id of ['arcane-gameplay-systems', 'arcane-datastore-safety', 'arcane-remote-security', 'arcane-debugging', 'arcane-characters',
    ...['arena', 'horror', 'obby', 'racing', 'rpg', 'simulator', 'tycoon'].map(genre => `arcane-${genre}-kit`)]) {
    const text = await readSkill(id);
    assert.doesNotMatch(text, /at most 3 fix|three (?:extra |unlimited )?fix iterations/i, id);
    containsGuidance(text, ['arcane-playtest-qa'], id);
  }
});
