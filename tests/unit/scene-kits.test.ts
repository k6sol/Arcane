import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validateCommandArgs, sceneBuildInstanceCount } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, SCENE_BUILD_LIMITS, type InstanceRef, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, sceneBuildShape, CORE, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';
import { fromOrientation, toOrientation, tiltPrototype, forestOriginals, KIT_TRIANGLE_BUDGET } from '../../apps/mcp/src/scene-kits.js';
import { proceduralInput } from '../../apps/mcp/src/procedural-tools.js';
import { compileTerrain, terrainShape } from '../../apps/mcp/src/terrain-tool.js';

const ROOT_REF: InstanceRef = { instanceId: 'opaque-root', sessionId: 'kit-session', root: 'Workspace', pathSegments: [], className: 'Workspace' };
const session = (): StudioSession => ({ id: 'kit-session', protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: ['Workspace', 'Lighting'], allowWrites: true, capabilities: [...READ_METHODS, ...WRITE_METHODS], connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const parse = (input: Record<string, unknown>) => z.strictObject(sceneBuildShape).parse(input) as SceneBuildInput;
const compile = (input: Record<string, unknown>) => compileSceneBuild(parse(input), ROOT_REF as unknown as Json);
type Wire = { kind: string; name: string; parent: number; key?: string; className?: string; template?: number; at?: number[]; scale?: number; ground?: boolean;
  properties?: { Position?: { value: number[] }; Size?: { value: number[] }; Shape?: string; Orientation?: { value: number[] } } };
const items = (args: Record<string, Json>) => args.items as unknown as Wire[];
const protoNames = (args: Record<string, Json>) => (args.prototypes as { name: string }[]).map(p => p.name);

/** The benchmark brief: a detailed circular pillar with the spawn on top, in a forest clearing, with an approach path. */
const PATH = [[0, -150], [6, -80], [-4, -30], [0, -16]] as [number, number][];
const brief = (seed = 3, extra: Record<string, unknown> = {}) => ({ name: 'SpawnGrove', kits: [
  { kind: 'plinth', key: 'Pillar', at: [0, 32, 0], radius: 10, tiers: 3, height: 18, style: 'fluted', seed },
  { kind: 'forest', key: 'Woods', at: [0, 32, 0], radius: 150, trees: 90, undergrowth: 170, paths: [{ points: PATH, width: 10 }], seed, ...extra },
] });

test('plinth: round stepped tiers with trim, fluted column and a SpawnLocation centred on the very top', () => {
  const built = compile(brief());
  const list = items(built.args), kit = built.kits.find(k => k.kind === 'plinth')!;
  const spawn = list.find(i => i.className === 'SpawnLocation')!;
  assert.equal(spawn.key, 'Pillar-spawn');
  assert.equal(spawn.properties!.Shape, 'Cylinder', 'a circular spawn pad');
  assert.deepEqual(spawn.properties!.Orientation!.value, [0, 0, 90], 'upright disc');
  const [sx, sy, sz] = spawn.properties!.Position!.value, thickness = spawn.properties!.Size!.value[0]!;
  assert.deepEqual([sx, sz], [0, 0]);
  const abacus = list.find(i => i.name === 'Abacus')!, abacusTop = abacus.properties!.Position!.value[1]! + abacus.properties!.Size!.value[0]! / 2;
  assert.ok(Math.abs(sy! - thickness / 2 - abacusTop) < 0.02, `spawn bottom ${sy! - thickness / 2} sits on the capital top ${abacusTop}`);
  assert.ok(spawn.properties!.Size!.value[1]! <= abacus.properties!.Size!.value[1]!, 'spawn fits on the capital');
  assert.deepEqual(kit.spawn, { at: [0, sy, 0], top: Number((sy! + 0.5).toFixed(2)) });
  // Highest part in the plinth is the spawn: nothing pokes through the pad.
  for (const part of list.filter(i => i.kind === 'part' && i !== spawn)) {
    const p = part.properties!.Position!.value, s = part.properties!.Size!.value, half = part.properties!.Shape === 'Cylinder' && part.properties!.Orientation!.value[2] === 90 ? s[0]! / 2 : Math.max(...s) / 2;
    assert.ok(p[1]! + half <= sy! - thickness / 2 + 0.02, `${part.name} stays below the spawn`);
  }
  // Every primitive is circular in plan (Cylinder), except the small fallen fragments.
  const steps = list.filter(i => /^Step\d$/.test(i.name)), trims = list.filter(i => /^Trim\d$/.test(i.name));
  assert.equal(steps.length, 3); assert.equal(trims.length, 3);
  const diameters = steps.map(s => s.properties!.Size!.value[1]!);
  assert.ok(diameters[0]! > diameters[1]! && diameters[1]! > diameters[2]!, 'tiers step inwards');
  for (const [i, trim] of trims.entries()) assert.ok(trim.properties!.Size!.value[1]! > diameters[i]!, 'trim ring proud of its tier');
  assert.equal(list.filter(i => i.name.startsWith('Flute')).length, 16);
  assert.ok(list.filter(i => i.name.startsWith('Drum')).length >= 2);
  // Weathering: stone colours vary but stay one coherent family.
  const colours = new Set(steps.map(s => JSON.stringify((s.properties as { Color?: { value: number[] } }).Color!.value)));
  assert.equal(colours.size, 3, 'each tier is a slightly different stone');
  assert.ok(list.some(i => i.name.startsWith('Moss')) && list.some(i => i.name.startsWith('Fragment')));
  assert.ok(kit.parts > 30 && kit.parts <= 80, `detailed but bounded (${kit.parts} parts)`);
});

test('plinth: platform style, template column and impossible geometry', () => {
  const flat = compile({ name: 'Pad', kits: [{ kind: 'plinth', style: 'platform', at: [5, 10, -5], radius: 8, tiers: 2, weathering: 0 }] });
  const list = items(flat.args), spawn = list.find(i => i.className === 'SpawnLocation')!, deck = list.find(i => i.name === 'Deck')!;
  const deckTop = deck.properties!.Position!.value[1]! + deck.properties!.Size!.value[0]! / 2;
  assert.ok(Math.abs(spawn.properties!.Position!.value[1]! - 0.5 - deckTop) < 0.02, 'spawn rests on the deck');
  assert.equal(list.some(i => i.name.startsWith('Moss') || i.name.startsWith('Fragment')), false, 'weathering 0 adds no debris');
  const smooth = items(compile({ name: 'Plain', kits: [{ kind: 'plinth', at: [0, 0, 0] }] }).args);
  assert.ok(smooth.some(i => i.name === 'Abacus') && !smooth.some(i => i.name.startsWith('Flute')), 'default column is smooth; flutes only on request');
  const templated = compile({ name: 'Classic', templates: { MarbleColumn: { ...ROOT_REF, instanceId: 'opaque-column', className: 'Model' } },
    kits: [{ kind: 'plinth', at: [0, 0, 0], column: 'MarbleColumn', height: 20 }] });
  const clone = items(templated.args).find(i => i.kind === 'clone')!, spawnTop = templated.kits[0]!.spawn!.top;
  assert.equal(clone.name, 'Column');
  assert.ok(Math.abs(spawnTop - 1 - (clone.at![1]! + 20)) < 0.02, 'spawn sits on the measured template height');
  assert.equal(items(templated.args).some(i => i.name.startsWith('Flute')), false, 'no primitive shaft when a template column is used');
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'plinth', at: [0, 0, 0], radius: 4, tiers: 3 }] }), /too small for a column/);
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'plinth', at: [0, 0, 0], radius: 3, tiers: 6, style: 'platform' }] }), /too many tiers/);
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'plinth', at: [0, 0, 0], trees: 4 }] }), /does not take trees/);
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'forest', at: [0, 0, 0], radius: 50, height: 4 }] }), /does not take height/);
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'forest', at: [0, 0, 0] }] }), /needs radius/);
  assert.throws(() => compile({ name: 'Bad', kits: [{ kind: 'plinth', at: [0, 0, 0], column: 'Missing' }] }), /Unknown prototype or template "Missing"/);
});

test('forest kit: deterministic by seed and accepted by the daemon validator with exact instance counts', () => {
  const a = compile(brief(3)), b = compile(brief(3)), c = compile(brief(4));
  assert.deepEqual(a.args, b.args, 'same seed, same scene');
  assert.notDeepEqual(a.args.items, c.args.items, 'a new seed is a new layout');
  const validated = validateCommandArgs('scene.build', a.args, session());
  assert.equal(sceneBuildInstanceCount(validated), a.instances);
  assert.ok(a.instances <= SCENE_BUILD_LIMITS.instances && items(a.args).length <= SCENE_BUILD_LIMITS.items);
  assert.ok(Buffer.byteLength(JSON.stringify(a.args)) < 250 * 1024);
  const forest = a.kits.find(k => k.kind === 'forest')!;
  assert.equal(forest.requested, 260);
  assert.ok(forest.placed! >= 230, `most of the forest fits (${forest.placed})`);
  assert.ok(forest.triangles < KIT_TRIANGLE_BUDGET && forest.parts < 3000, JSON.stringify(forest));
  for (const name of ['Woods', 'Woods-trees', 'Woods-cover', 'Pillar', 'Pillar-spawn']) assert.ok(items(a.args).some(i => i.key === name), name);
});

test('forest kit: clearing, plinth footprint and approach path stay clear; every placement drops to terrain', () => {
  const built = compile(brief()), list = items(built.args);
  const trees = list.filter(i => i.kind === 'place' && i.parent === list.findIndex(x => x.key === 'Woods-trees') + 1);
  const cover = list.filter(i => i.kind === 'place' && i.parent === list.findIndex(x => x.key === 'Woods-cover') + 1);
  assert.ok(trees.length >= 80 && cover.length >= 140, `${trees.length} trees, ${cover.length} cover`);
  // Default clearing from the plinth: inner = radius + 8 = 18 (undergrowth may creep to 85%).
  for (const t of trees) assert.ok(Math.hypot(t.at![0]!, t.at![2]!) >= 18, 'trees outside the clearing');
  for (const u of cover) assert.ok(Math.hypot(u.at![0]!, u.at![2]!) >= 18 * 0.85, 'cover outside the inner clearing');
  for (const p of [...trees, ...cover]) {
    assert.ok(Math.hypot(p.at![0]!, p.at![2]!) >= 12, 'nothing on the plinth');
    assert.equal(p.ground, true, 'terrain-aware: lands on the surface below');
    for (let i = 1; i < PATH.length; i++) {
      const [a, b] = [PATH[i - 1]!, PATH[i]!], dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p.at![0]! - a[0]) * dx + (p.at![2]! - a[1]) * dz) / (dx * dx + dz * dz)));
      assert.ok(Math.hypot(p.at![0]! - a[0] - t * dx, p.at![2]! - a[1] - t * dz) >= 5, 'approach path open');
    }
  }
  // Density falls off towards the clearing: the 18..48 ring is sparser per area than 60..120.
  const density = (lo: number, hi: number) => trees.filter(t => { const d = Math.hypot(t.at![0]!, t.at![2]!); return d >= lo && d < hi; }).length / (Math.PI * (hi * hi - lo * lo));
  assert.ok(density(18, 48) < density(60, 120), `falloff ${density(18, 48)} < ${density(60, 120)}`);
  // Rim falloff: no hard circular forest edge.
  assert.ok(density(140, 150) < density(60, 120) * 0.6, 'rim thins out');
});

test('forest kit: per-species spacing, mix ratios, size/yaw jitter and tilt variants', () => {
  const built = compile(brief()), list = items(built.args), names = protoNames(built.args);
  const spacing: Record<string, number> = { pine: 9, oak: 13, birch: 7, bush: 3.2, fern: 2.4, rock: 3.6, log: 7 };
  const species = (i: Wire) => names[i.template! - 1]!.split('_')[0]!;
  const placed = list.filter(i => i.kind === 'place'), tree = (i: Wire) => ['pine', 'oak', 'birch'].includes(species(i));
  for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) {
    // Full Poisson spacing within a species and between trees; undergrowth may tuck under other canopies but keeps their core clear.
    const ra = spacing[species(a)]! * a.scale! / 2, rb = spacing[species(b)]! * b.scale! / 2;
    const need = species(a) === species(b) || (tree(a) && tree(b)) ? ra + rb : CORE * (ra + rb);
    assert.ok(Math.hypot(a.at![0]! - b.at![0]!, a.at![2]! - b.at![2]!) >= need - 0.05, `${species(a)}/${species(b)} spacing`);
  }
  const count = (s: string) => placed.filter(i => species(i) === s).length;
  assert.ok(count('pine') > count('oak') && count('oak') > count('birch') * 0.8, `mix ${count('pine')}/${count('oak')}/${count('birch')}`);
  assert.ok(count('fern') > count('log') * 2, 'cover mix follows shares');
  const scales = new Set(placed.map(i => i.scale)); assert.ok(scales.size > 150, 'size jitter');
  // Tilt: pre-tilted copies exist for trees, never for ground cover; each lean stays within the requested max.
  const tilted = names.filter(n => /^(pine|oak|birch)_4_\d$/.test(n));
  assert.equal(tilted.length, 9);
  assert.equal(names.some(n => /^(bush|fern|rock|log)_/.test(n)), false);
  const protos = built.args.prototypes as { name: string; parts: { name: string; properties: { Orientation: { value: number[] } } }[] }[];
  for (const name of tilted) {
    const trunk = protos.find(p => p.name === name)!.parts.find(p => p.name === 'Trunk')!, m = fromOrientation(trunk.properties.Orientation.value);
    const lean = Math.acos(m[1]![0]!) * 180 / Math.PI; // local X (cylinder axis) against world up
    assert.ok(lean > 0.5 && lean <= 4.01, `${name} leans ${lean.toFixed(2)} degrees`);
  }
  assert.ok(placed.some(i => /_4_\d$/.test(names[i.template! - 1]!)) && placed.some(i => names[i.template! - 1] === 'pine'), 'upright and leaning trees mix');
});

test('forest kit: undergrowth hugs tree bases and templates replace blockout species', () => {
  const nearest = (input: Record<string, unknown>) => {
    const list = items(compile(input).args), treeGroup = list.findIndex(x => x.key === 'Woods-trees') + 1, coverGroup = list.findIndex(x => x.key === 'Woods-cover') + 1;
    const trees = list.filter(i => i.kind === 'place' && i.parent === treeGroup), cover = list.filter(i => i.kind === 'place' && i.parent === coverGroup);
    return cover.reduce((sum, u) => sum + Math.min(...trees.map(t => Math.hypot(t.at![0]! - u.at![0]!, t.at![2]! - u.at![2]!))), 0) / cover.length;
  };
  const hugged = nearest(brief()), all = items(compile(brief()).args), treeGroup = all.findIndex(x => x.key === 'Woods-trees') + 1;
  const trees = all.filter(i => i.kind === 'place' && i.parent === treeGroup), samples: number[] = [];
  for (let x = -140; x <= 140; x += 7) for (let z = -140; z <= 140; z += 7) if (Math.hypot(x, z) > 20 && Math.hypot(x, z) < 140)
    samples.push(Math.min(...trees.map(t => Math.hypot(t.at![0]! - x, t.at![2]! - z))));
  const uniform = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(hugged < uniform * 0.8, `cover gathers near trunks (mean ${hugged.toFixed(1)} vs uniform ${uniform.toFixed(1)} studs)`);
  const template = (id: string) => ({ ...ROOT_REF, instanceId: id, className: 'Model' });
  const built = compile({ name: 'Real', templates: { OakTall: template('a'), PineTall: template('b'), FernA: template('c') },
    kits: [{ kind: 'forest', at: [0, 0, 0], radius: 90, trees: 40, undergrowth: 60, seed: 9,
      species: [{ use: 'PineTall', share: 2, spacing: 10, tris: 12000 }, { use: 'OakTall', spacing: 14, tris: 16000 }], cover: [{ use: 'FernA', spacing: 2.5, tris: 2500 }] }] });
  const list = items(built.args);
  assert.equal(list.filter(i => i.kind === 'place').length, 0, 'no blockout prototypes when templates are given');
  const clones = list.filter(i => i.kind === 'clone'), forest = built.kits[0]!;
  assert.equal(clones.length, forest.placed);
  assert.ok(forest.triangles > 40 * 12000 && forest.triangles < KIT_TRIANGLE_BUDGET, `template triangles counted (${forest.triangles})`);
  assert.throws(() => compile({ name: 'Heavy', templates: { Huge: template('h') }, kits: [{ kind: 'forest', at: [0, 0, 0], radius: 400, trees: 900, undergrowth: 0,
    species: [{ use: 'Huge', spacing: 4, tris: 200000 }] }] }), /triangles/);
  assert.throws(() => compile({ name: 'Unknown', kits: [{ kind: 'forest', at: [0, 0, 0], radius: 50, species: [{ use: 'willow', spacing: 5 }] }] }), /built-in species/);
});

test('forest kit: <use>-<n> Blender original templates replace built-in species; blockout fallback is reported with a seeded recipe', () => {
  const template = (id: string) => ({ ...ROOT_REF, instanceId: id, className: 'Model' });
  const kit = { kind: 'forest', at: [0, 0, 0], radius: 90, trees: 40, undergrowth: 60, seed: 7,
    species: [{ use: 'oak', share: 3, spacing: 14 }, { use: 'birch', share: 2, spacing: 8 }], cover: [{ use: 'bush', spacing: 3.2 }, { use: 'rock', spacing: 4, tris: 6000 }] };
  // Step 1 recipe: deterministic names and seeds derived from the kit seed (3 oak + 2 birch + 2 bush + 3 rock).
  const blockout = compile({ name: 'Draft', kits: [kit] }), draft = blockout.kits[0]!;
  assert.deepEqual(draft.blockouts, ['oak', 'birch', 'rock', 'bush']);
  assert.match(draft.note!, /Blockout primitives for oak, birch, rock, bush/);
  assert.match(draft.note!, /user approves/);
  assert.deepEqual(draft.recipe!.map(r => `${r.name}:${r.seed}`), ['oak-1:701', 'oak-2:702', 'oak-3:703', 'birch-1:701', 'birch-2:702', 'rock-1:701', 'rock-2:702', 'rock-3:703', 'bush-1:701', 'bush-2:702']);
  assert.deepEqual(draft.recipe![0]!.generator, { kind: 'tree', species: 'oak', height: 6 });
  assert.equal(draft.originals, undefined);
  assert.deepEqual(compile({ name: 'Draft', kits: [kit] }).kits, blockout.kits, 'recipe is deterministic');
  for (const r of draft.recipe!) assert.ok(proceduralInput.safeParse({ name: r.name, generator: r.generator, seed: r.seed }).success, `${r.name} is a valid assets_procedural call`);
  // Step 2: approved, placed copies passed as templates are cloned (instanced), never blockouts.
  const templates = Object.fromEntries(draft.recipe!.map((r, i) => [r.name, template('t' + i)]));
  const built = compile({ name: 'Real', templates, kits: [kit] }), forest = built.kits[0]!, list = items(built.args);
  assert.equal(list.filter(i => i.kind === 'place').length, 0, 'no blockout prototypes');
  assert.equal(forest.blockouts, undefined); assert.equal(forest.recipe, undefined); assert.equal(forest.note, undefined);
  assert.deepEqual(forest.originals, { oak: ['oak-1', 'oak-2', 'oak-3'], birch: ['birch-1', 'birch-2'], rock: ['rock-1', 'rock-2', 'rock-3'], bush: ['bush-1', 'bush-2'] });
  const names = built.args.templates as unknown as { instanceId: string }[], clones = list.filter(i => i.kind === 'clone');
  assert.equal(names.length, 10, 'each original is sent once');
  assert.equal(clones.length, forest.placed);
  const used = new Set(clones.map(c => c.template)); assert.equal(used.size, 10, 'every variant is scattered');
  // Budget: each original clone costs its recipe generator's assets_procedural default (tree 16k, foliage 8k); an explicit tris wins (rock 6000).
  const cost: Record<string, number> = { oak: 16000, birch: 16000, bush: 8000, rock: 6000 }, sent = Object.keys(templates);
  assert.equal(forest.triangles, clones.reduce((sum, c) => sum + cost[sent[c.template! - 1]!.replace(/-\d+$/, '')]!, 0), 'original clones are priced at their real triangle budgets');
  // Partial: only oak originals exist, so the rest stay blockouts and are named.
  const partial = compile({ name: 'Mixed', templates: { 'oak-1': template('a'), 'oak-2': template('b'), 'oak-10': template('c'), 'oaky-1': template('d') }, kits: [kit] }).kits[0]!;
  assert.deepEqual(partial.originals, { oak: ['oak-1', 'oak-2', 'oak-10'] });
  assert.deepEqual(partial.blockouts, ['birch', 'rock', 'bush']);
  assert.ok(partial.recipe!.every(r => !r.name.startsWith('oak')));
  // log has no Blender recipe; it is reported as a blockout without one.
  const logs = compile({ name: 'Logs', kits: [{ ...kit, species: [{ use: 'oak', spacing: 14 }], cover: [{ use: 'log', spacing: 7 }] }] }).kits[0]!;
  assert.deepEqual(logs.recipe!.map(r => r.name), ['oak-1', 'oak-2', 'oak-3']);
  assert.deepEqual(logs.blockouts, ['oak', 'log']);
  const twin = compile({ name: 'Twin', kits: [kit, { ...kit, key: 'East', at: [300, 0, 0] }] }).kits;
  assert.deepEqual(twin.map(k => k.blockouts), [draft.blockouts, draft.blockouts], 'a second forest still reports its blockouts');
  assert.ok(forestOriginals(2 ** 31, ['fern', 'pine']).every(r => Number.isInteger(r.seed) && r.seed >= 0 && r.seed < 2 ** 31), 'seeds stay in the assets_procedural range');
});

test('tilt helpers round-trip Roblox YXZ orientation and keep the ground pivot', () => {
  for (const o of [[0, 0, 90], [10, 35, -20], [-30, 170, 45], [0, -90, 0]]) {
    const back = toOrientation(fromOrientation(o));
    const a = fromOrientation(o), b = fromOrientation(back);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(a[i]![j]! - b[i]![j]!) < 1e-3, `${o} round-trips`);
  }
  const proto = { weld: false, parts: [{ name: 'Root', className: 'Part' as const, tint: true, props: { Position: [0, 0, 0] as [number, number, number] } },
    { name: 'Top', className: 'Part' as const, tint: true, props: { Position: [0, 10, 0] as [number, number, number] } }] };
  const tilted = tiltPrototype(proto, 10, 0);
  assert.deepEqual(tilted.parts![0]!.props!.Position, [0, 0, 0], 'pivot stays at the ground');
  const top = tilted.parts![1]!.props!.Position as number[];
  assert.ok(Math.abs(Math.hypot(top[0]!, top[1]!, top[2]!) - 10) < 0.02 && Math.abs(Math.acos(top[1]! / 10) * 180 / Math.PI - 10) < 0.1);
});

test('scatter edge falloff is opt-in: existing scatter layouts are unchanged without it', () => {
  const base = { name: 'S', prototypes: { T: { parts: [{ name: 'P', props: { Size: [1, 1, 1] } }] } } };
  const spec = { use: 'T', count: 120, center: [0, 0, 0], radius: 100, minSpacing: 4, seed: 5 };
  const plain = items(compile({ ...base, scatter: [spec] }).args), soft = items(compile({ ...base, scatter: [{ ...spec, edge: 40 }] }).args);
  const rim = (list: Wire[]) => list.filter(i => i.kind === 'place' && Math.hypot(i.at![0]!, i.at![2]!) > 80).length;
  assert.ok(rim(soft) < rim(plain) * 0.7, `rim ${rim(soft)} < ${rim(plain)}`);
  assert.deepEqual(compile({ ...base, scatter: [spec] }).args, compile({ ...base, scatter: [spec] }).args);
});

test('terrain pad base expands to grass, ground, mud and rock rings with noisy plateau edges', () => {
  const input = { center: [0, 0], size: [512, 512], baseHeight: 32, seed: 3,
    features: [{ kind: 'plateau', center: [0, 0], radius: 48, level: 32, blend: 20, base: 10 }, { kind: 'path', points: [[0, -250], [0, -14]], width: 10, material: 'Cobblestone' }] };
  const args = compileTerrain(z.strictObject(terrainShape).parse(input) as Record<string, unknown>) as { features: { kind: string; radius?: number; material?: string; level?: number }[] };
  const rings = args.features.filter(f => f.kind === 'plateau');
  assert.deepEqual(rings.map(f => f.material), ['LeafyGrass', 'Ground', 'Mud', 'Rock']);
  for (let i = 1; i < rings.length; i++) assert.ok(rings[i]!.radius! < rings[i - 1]!.radius!, 'outer to inner, later overrides earlier');
  assert.ok(rings.every(f => f.level === 32), 'one flat clearing level');
  assert.equal(rings.at(-1)!.radius, 11.5, 'rock apron just outside the plinth');
  assert.equal(args.features.at(-1)!.kind, 'path', 'path keeps its order after the rings');
  assert.deepEqual(validateCommandArgs('terrain.generate', args as unknown as Record<string, Json>, session()), args);
  const plain = { center: [0, 0], size: [256, 256], features: [{ kind: 'flatten', center: [0, 0], radius: 30 }] };
  assert.deepEqual(compileTerrain(z.strictObject(terrainShape).parse(plain) as Record<string, unknown>), JSON.parse(JSON.stringify(z.strictObject(terrainShape).parse(plain))));
  assert.throws(() => compileTerrain(z.strictObject(terrainShape).parse({ center: [0, 0], size: [256, 256],
    features: Array.from({ length: 30 }, () => ({ kind: 'plateau', center: [0, 0], radius: 40, level: 10, base: 8 })) }) as Record<string, unknown>), /max 32/);
});
