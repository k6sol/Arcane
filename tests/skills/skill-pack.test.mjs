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
  assert.equal(result.skills, 55);
  assert.equal(result.references, 17);
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

test('scene recipes are prescriptive: terrain ground, natural Poisson placement, anti-ring rule and batch tools', async () => {
  const read = async id => (await readContained(ROOT, `skills/arcane/${id}/SKILL.md`)).text;
  const nature = await read('arcane-natural-scenes'), architecture = await read('arcane-architectural-features'), world = await read('arcane-world-building');
  for (const text of ['environment_apply', 'terrain', 'terrain_generate', '`flatten` the clearing', '`river`', '`path`', 'Never use a flat Part disc', 'Poisson-disk', 'scatter', 'clearing', 'Never use rings, grids, rows',
    'Pine', 'Oak', 'Birch', 'tint', 'scale [0.75,1.25]', 'CastShadow false', 'ClockTime', 'atmosphere', '800-2500']) assert.ok(nature.includes(text), text);
  for (const text of ['Blender', 'UVs, textures and PBR', 'assets_preview', 'scene_delete', 'SpawnLocation', 'scene_update', 'Add a spiral stair only when requested', 'exact failing stage'])
    assert.ok(architecture.includes(text), text);
  assert.match(world, /Never place foliage in rings, grids or rows/);
  assert.match(world, /Poisson-disk/);
});

test('DataStore safety skill encodes the non-destructive persistence rules', async () => {
  const text = (await readContained(ROOT, 'skills/arcane/arcane-datastore-safety/SKILL.md')).text;
  for (const rule of ['Never wipe, rename', 'pcall', 'GetRequestBudgetForRequestType', 'UpdateAsync, not SetAsync', 'Session lock', 'BindToClose',
    'Never run data-mutating code', 'Studio Access to API Services', 'must never be saved over with defaults']) assert.ok(text.includes(rule), rule);
  const pack = await packSkills(['arcane-datastore-safety'], { root: ROOT, allowExperimental: true });
  assert.ok(pack.context.includes('## Loaded skill: arcane-datastore-safety'));
});

const readSkill = async id => (await readContained(ROOT, `skills/arcane/${id}/SKILL.md`)).text;
// Built-in particle textures verified in a Studio install's content/textures/particles folder.
const BUILT_IN_PARTICLES = new Set(['fire_main.dds', 'fire_sparks_main.dds', 'smoke_main.dds', 'sparkles_main.dds', 'explosion01_smoke_main.dds',
  'explosion01_core_main.dds', 'explosion01_shockwave_main.dds', 'forcefield_glow_main.dds', 'forcefield_vortex_main.dds', 'SquareParticle.png']);

test('VFX skill gives exact emitter presets, verified built-in textures and runtime verification', async () => {
  const vfx = await readSkill('arcane-vfx');
  for (const text of ['scene_build', 'script_update', 'script_set_enabled', 'playtest_request', 'Never invent rbxassetid', 'Fire core', 'Embers', 'Smoke',
    'Impact sparks', 'Magic aura', 'Waterfall sheet', 'Waterfall mist', 'Dust motes', 'Fireflies', 'Falling leaves', 'LightEmission', 'Spread', 'Drag',
    'NumberSequence', 'ColorSequence', 'Attachment0', 'fx', 'creates effect instances directly', 'scene_create', 'frame {ref, views}',
    'Beam', 'Trail', 'PointLight', 'SpotLight', 'Highlight', 'Emit(', 'arcane-photoreal']) assert.ok(vfx.includes(text), text);
  assert.doesNotMatch(vfx, /cannot create|builds them from script|Arcane builds parts, not effect/i, 'effects are no longer script-built');
  for (const name of ['fire_main.dds', 'smoke_main.dds', 'sparkles_main.dds', 'fire_sparks_main.dds', 'SquareParticle.png']) assert.ok(vfx.includes(name), name);
  for (const skill of (await loadRegistry(ROOT)).skills) {
    for (const item of [skill, ...skill.references]) {
      const text = (await readContained(ROOT, item.path)).text;
      assert.doesNotMatch(text, /rbxassetid:\/\/\d/, `${item.path} must not invent asset ids`);
      for (const [, file] of text.matchAll(/rbxasset:\/\/textures\/particles\/([\w.]+)/g)) assert.ok(BUILT_IN_PARTICLES.has(file), file);
    }
  }
});

test('photoreal skill encodes mood presets with exact environment_apply fields, scale and imperfection rules', async () => {
  const text = await readSkill('arcane-photoreal');
  for (const mood of ['Clear day', 'Golden hour', 'Foggy forest', 'Night', 'Horror', 'Sci-fi']) assert.ok(text.includes(`| ${mood} |`), mood);
  for (const field of ['ClockTime', 'ExposureCompensation', 'OutdoorAmbient', 'ColorShift_Top', 'ShadowSoftness', 'EnvironmentDiffuseScale', 'EnvironmentSpecularScale',
    'Density', 'Haze', 'Decay', 'TintColor', 'Technology = Future', 'Decoration = true', 'MaterialVariant', 'SurfaceAppearance', 'DepthOfFieldEffect',
    'FogStart/FogEnd are ignored', 'avatar 5.5 studs', 'Door 4 x 7.5', 'No identical neighbours', 'studio_viewport_capture', 'environment_apply', 'terrain_generate` first',
    'preset', 'technology: "Future"', 'terrainDecoration: true', 'materials: [', 'clear_day', 'golden_hour', 'foggy_forest', 'night', 'horror', 'sci_fi']) assert.ok(text.includes(field), field);
  assert.doesNotMatch(text, /Arcane cannot set/, 'Technology, Decoration and MaterialVariants are direct');
  assert.doesNotMatch(text, /\bExposure \d/);
});

test('interface skill is a design system with tokens, responsive rules, accessible contrast and declared recipes', async () => {
  const text = await readSkill('arcane-interface');
  for (const rule of ['UICorner', 'UIStroke', 'UIGradient', 'UIPadding', 'UIListLayout', 'UIGridLayout', 'UIAspectRatioConstraint', 'UIScale', 'UISizeConstraint',
    'UITextSizeConstraint', 'BuilderSans', 'Activated', '44 px', '4.5:1', 'ResetOnSpawn false', 'CoreUISafeInsets', 'script_set_enabled', 'click-gui', 'arcane-interface:recipes'])
    assert.ok(text.includes(rule), rule);
  for (const rule of ['scene_build', 'container: "ScreenGui"', 'scene.gui', 'prototypes', 'use` + `ui` overrides', 'script_update', 'cannot show a ScreenGui in Edit mode', 'SurfaceGui'])
    assert.ok(text.includes(rule), rule);
  assert.doesNotMatch(text, /cannot create GuiObjects|built at runtime by code/, 'GUI trees are built directly, not by scripts');
  const pack = await packSkills(['arcane-interface'], { root: ROOT, allowExperimental: true, references: ['arcane-interface:recipes'] });
  for (const recipe of ['## Main menu', '## HUD with health and stamina', '## Shop', '## Inventory grid', '## Notifications', '## Loading screen', '## Settings panel'])
    assert.ok(pack.context.includes(recipe), recipe);
});

test('scripting, security and systems skills are prescriptive and cross-linked instead of duplicated', async () => {
  const luau = await readSkill('arcane-luau-architecture'), security = await readSkill('arcane-remote-security'), systems = await readSkill('arcane-gameplay-systems');
  for (const rule of ['--!strict', 'Never trust the client', 'script_set_enabled', 'playtest_request', 'CollectionService', 'TweenService', 'RunService', 'task.wait',
    'arcane-datastore-safety', 'arcane-remote-security', 'arcane-luau-architecture:patterns']) assert.ok(luau.includes(rule), rule);
  const patterns = await packSkills(['arcane-luau-architecture'], { root: ROOT, allowExperimental: true, references: ['arcane-luau-architecture:patterns'] });
  for (const code of ['GetInstanceAddedSignal', 'OnServerEvent', 'os.clock()', 'task.cancel', 'Disconnect()', 'PlayerRemoving']) assert.ok(patterns.context.includes(code), code);
  for (const rule of ['Rate limit', 'NaN', 'Proximity', 'Server-derived values', 'Idempotence', 'SetNetworkOwner(nil)', 'Anti-exploit']) assert.ok(security.includes(rule), rule);
  for (const recipe of ['## Checkpoints', '## Round loop', '## Leaderstats', '## Doors and keys', '## NPC dialogue', '## Pathfinding NPC', 'scene_build',
    'assert-player-attribute', 'arcane-rounds', 'arcane-npc', 'arcane-datastore-safety', 'ComputeAsync', 'leaderstats']) assert.ok(systems.includes(recipe), recipe);
  for (const id of ['arcane-natural-scenes', 'arcane-architectural-features', 'arcane-world-building']) assert.ok((await readSkill(id)).includes('arcane-photoreal'), id);
});

test('characters skill covers rigs, verifiable default animations, pathfinding, states, dialogue and authority, and is cross-linked', async () => {
  const text = await readSkill('arcane-characters'), systems = await readSkill('arcane-gameplay-systems');
  for (const rule of ['CreateHumanoidModelFromDescription', 'HumanoidDescription', 'HumanoidRigType.R15', 'scene.characters', 'studio_asset_search', 'R15 rig',
    'AnimationController', 'Animator', 'LoadAnimation', 'Never invent animation ids', 'character.Animate', 'TweenService', 'PathfindingService', 'AgentRadius',
    'ComputeAsync', 'PathStatus.Success', 'PathWaypointAction.Jump', 'MoveToFinished', 'path.Blocked', 'Stuck detection', '| Idle |', '| Patrol |', '| Chase |',
    '| Flee |', 'ProximityPrompt', 'scene_build', 'arcane-interface', 'SetNetworkOwner(nil)', 'server decides', 'script_set_enabled', 'playtest_request',
    'assert-player-attribute', 'arcane-gameplay-systems', 'arcane-npc']) assert.ok(text.includes(rule), rule);
  // Only the standard Animate defaults are named, never as a ready-made asset URL.
  for (const [, id] of text.matchAll(/\b(\d{6,})\b/g)) assert.ok(['507766666', '507777826', '507767714', '507765000', '507767968', '507765644'].includes(id), id);
  assert.ok(systems.includes('arcane-characters'));
  const registry = await loadRegistry(ROOT), entry = registry.skills.find(skill => skill.id === 'arcane-characters');
  for (const keyword of ['npc', 'character', 'enemy', 'animation', 'rig', 'pathfinding', 'ai']) assert.ok(entry.keywords.includes(keyword), keyword);
});

test('skill entrypoints stay lean enough for the default router budget', async () => {
  for (const skill of (await loadRegistry(ROOT)).skills) {
    const bytes = (await readContained(ROOT, skill.path)).bytes.length;
    assert.ok(bytes <= 7 * 1024, `${skill.id} is ${bytes} bytes`);
  }
});
