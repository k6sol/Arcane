import type { SkillRegistry } from './skills.js';
import { createClass, properties } from './schemas.js';
import { BASE_PART_CLASSES, PART_SHAPE_CLASSES, SHAPES, BUILD_GROUP_CLASSES, BUILD_PART_CLASSES, TERRAIN_SHAPES } from '../../../packages/core/src/studio-policy.js';
import { SCENE_BUILD_LIMITS, ENVIRONMENT_LIMITS } from '../../../packages/protocol/src/studio.js';
import { ARCANE_GUIDANCE } from '../../../packages/protocol/src/arcane-tools.js';

/** Shared with the native profile's exact MCP inventory; this tool stays local/read-only. */
export const SKILLS_RECOMMEND_TOOL = 'skills_recommend' as const;

export const SKILL_ROUTER_LIMITS = Object.freeze({ requestCharacters: 2000, skills: 8, references: 2,
  catalogue: 100, defaultBytes: 10_240, maximumBytes: 128 * 1024 });

/** Product-owner opt-in to authored guidance; never a registry promotion or a write grant. */
export const BUNDLED_GUIDANCE_POLICY = Object.freeze({ allowExperimental: true, approvalChanged: false });

export function physicalCreationClasses(): string[] {
  return createClass.options.filter(name => (BASE_PART_CLASSES as readonly string[]).includes(name));
}
export function sceneCreateDescription(): string {
  return `Write: create one instance under scene_children.parentRef or another genuinely returned parent ref in this session (for one or two isolated objects; use scene_build for more). Assemblies: a Model container, then physical children. Physical properties apply to ${physicalCreationClasses().join(', ')}; Shape (${SHAPES.join(', ')}) only on ${createClass.options.filter(name => (PART_SHAPE_CLASSES as readonly string[]).includes(name)).join(', ')}. Use tagged Size/Position/Orientation/Color. Script/LocalScript start disabled. No Source, Parent, CFrame, arbitrary properties or evaluation. Needs task authorization, the write grant and Studio edit mode; do not re-ask permission per in-scope part. Keep the commandId/receipt; on ambiguity use receipt_status, never auto-retry.`;
}
export function sceneUpdateDescription(): string {
  return `Write: update an observed ref with the schema fields its native class supports. expected must hold the changed keys plus linked GUI font/constraint keys, with exact baselines from scene_inspect. Shape only on Part-shape classes; Orientation is a tagged Vector3 in -360..360 degrees. No CFrame, reparent, deletion, service rename or raw calls. Needs task authorization, the write grant and Studio edit mode. GUI edits need scene.gui.edit: copy exact tagged dimensions, colors, sequences and full Font observations from scene_inspect into expected; requested values use the scene_create GUI limits. For Font or FontFace edits, expected includes both Font and FontFace; for either constraint bound, expected includes both bounds. Receipts retain those linked values. Keep the receipt and verify; on ambiguity use receipt_status, never auto-retry.`;
}
export function sceneBuildDescription(): string {
  // Field meanings: the arcane-natural-scenes:scene-build skill reference (kept out of the per-turn tool list).
  return `Write: one atomic hierarchy (one undo step/receipt) under a returned parent ref; container ${BUILD_GROUP_CLASSES.join("/")}, or ScreenGui (parent StarterGui; GUI items; screen = its props). prototypes: reusable parts local to a ground-level origin, or ui trees. items: groups, parts, placements (use/at/yaw/scale/tint/ground), effects (className + fx in a part/Attachment) or GUI (scene.gui; className + ui; use stamps a ui prototype), fx/ui as on scene_create (refs = item keys); key = local id, in = earlier key. scatter: seeded Poisson spacing, clusters, clearings, keep-out routes; Wild growth uses Poisson-disk placement; ordered rows only when requested. Forest layers require declared intended prototypes/templates (numbered variants supported); unresolved sources refuse with FOREST_SOURCES_REQUIRED before writes, never implicit substitutes. Generate/review/import original models first when required; declaring a template alone does not prove Blender provenance. Explicit primitive blockouts use explicit prototypes. Fields: skills_get arcane-natural-scenes:scene-build. Anchored defaults true. Limits: ${SCENE_BUILD_LIMITS.items} items, ${SCENE_BUILD_LIMITS.prototypes} prototypes x ${SCENE_BUILD_LIMITS.prototypeParts} parts, ${SCENE_BUILD_LIMITS.instances} instances, 250 KiB. Verified before parenting. Returns counts/root/keyed refs; receipt_restore removes an unchanged build. Plugin 0.2.0+, write grant, edit mode. Never auto-retry; receipt_status on ambiguity.`;
}
export function environmentDescription(): string {
  return `Write: in one undo step, fill Workspace.Terrain with ordered ${TERRAIN_SHAPES.join('/')} shapes (Air carves; later shapes overwrite earlier) and/or set Lighting plus Atmosphere, Bloom, ColorCorrection, SunRays, DepthOfField and the built-in Sky (reused or created under Lighting; Sky textures are never set). Colors are [r,g,b] or "#rrggbb". Terrain needs the Workspace grant; lighting/effects need the Lighting grant. Max ${ENVIRONMENT_LIMITS.terrainShapes} shapes, ${ENVIRONMENT_LIMITS.extent}-stud extent. Lighting is verified and rolled back on failure before terrain is written. Revert with Studio Undo (receipt_restore is refused; the receipt lists prior lighting values). For natural landforms, clearings and rivers use terrain_generate. Needs plugin 0.2.0+. Never auto-retry.`;
}

/**
 * initialize.instructions: a tool-discovery head (its first 512 characters name the build tools), the canonical
 * ARCANE_GUIDANCE shared with the managed hosts, then the exact scene contracts. Kept under the 4096-character bound
 * Claude Code applies to MCP server instructions, so no client sees it truncated.
 */
export function productInstructions(): string {
  return `This Arcane server registers scene_build, scene_create, scene_update, environment_apply and script_update; a client may load MCP tools on demand, so a tool not yet visible can be unloaded rather than unavailable. Use tool search before concluding it is missing. Only if search is unavailable or fails, report that actual boundary; never fabricate a call or claim an edit.
${ARCANE_GUIDANCE}
scene_children returns parentRef for the requested granted root/parent, including an empty Workspace; never synthesize a ref. Creation classes: ${createClass.options.join(', ')}. Update properties: ${Object.keys(properties.shape).join(', ')}. Create a cylinder with scene_create className:"Part", properties.Shape:"Cylinder". No reparent or arbitrary properties; CFrame remains unavailable.`;
}

type Metadata = Awaited<ReturnType<SkillRegistry['list']>>['items'][number];
export interface SkillRecommendationInput { request: string; limit: number; byteBudget: number; allowExperimental: boolean;
  /** Learned-preference boosts (skill id -> 1..4) from the user's feedback; only lift skills the request already matches. */
  boosts?: Readonly<Record<string, number>> }

const CORE = ['arcane-studio-context', 'arcane-safe-edits', 'arcane-project-director', 'arcane-quality-review'] as const;
const STOP = new Set('a an the and or of for to in on with my this that it is be as at by from please roblox game make build create help use want need existing current actual implement requested'.split(' '));
function tokens(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .map(term => term.length > 4 && term.endsWith('s') && !term.endsWith('ss') && !['physics', 'analytics'].includes(term) ? term.slice(0, -1) : term)
    .filter(term => !STOP.has(term)));
}
// Small domain hints supplement the registry's real titles/descriptions. They
// route all eligible entries; they cannot supply bodies, references or approval.
const HINTS: Record<string, string> = {
  'arcane-level-design': 'scene room corridor platform obstacle obby layout arena tower building parkour',
  'arcane-world-building': 'scene environment world terrain biome forest city building modular foliage',
  'arcane-art-direction': 'scene visual style palette silhouette tower prop reference',
  'arcane-luau-architecture': 'script scripting luau module modulescript feature code refactor system strict typed janitor maid cleanup collectionservice tween tweenservice runservice heartbeat',
  'arcane-networking': 'multiplayer remote remoteevent remotefunction replication combat damage',
  'arcane-remote-security': 'remote remoteevent remotefunction combat damage trading purchase shop buy exploit exploiter anti-exploit cheat cheater hacker secure security validation validate rate-limit throttle spam flood',
  'arcane-combat': 'combat weapon attack hitbox damage melee ranged projectile parry',
  'arcane-inventory': 'inventory hotbar item equip equipment consumable loot',
  'arcane-npc': 'npc ai enemy bot pathfinding navigation perception',
  'arcane-physics': 'physics vehicle constraint conveyor mechanism collision',
  'arcane-performance': 'performance streaming memory fps lag optimization',
  'arcane-accessibility': 'accessibility contrast motion readability caption',
  'arcane-materials': 'uv texture material pbr bake atlas',
  'arcane-audio': 'audio sound sounds music voice ambience ambient soundscape mix sfx footstep footsteps reverb soundtrack soundgroup',
  'arcane-vfx': 'vfx particle particleemitter effect impact trail beam fire flame smoke spark magic waterfall dust firefly fireflies leaves explosion glow highlight torch lamp light',
  'arcane-debugging': 'debug fix broken error failure repro diagnose',
  'arcane-playtest-qa': 'test playtest verify regression behavior gameplay',
  'arcane-blender-props': 'blender prop cylinder mesh geometry machine',
  'arcane-interface': 'hud menu ui gui screengui billboardgui surfacegui button shop notification toast loading settings health-bar stamina panel',
  // Prescriptive DataStore safety leads save/load work; the general persistence skill covers migrations and schema design.
  'arcane-persistence': 'persistence migration migrate schema profileservice profilestore',
  'arcane-datastore-safety': 'datastore datastores data-store data saving save saved persist persistent updateasync session-lock budget wipe corrupt bindtoclose profile',
  'arcane-natural-scenes': 'forest tree trees wood woods jungle foliage nature grass bush rock terrain hill meadow park garden biome undergrowth flower clearing',
  'arcane-architectural-features': 'pillar column plinth pedestal spawn spawnlocation statue arch temple monument fountain stair railing detail detailed classical',
  'arcane-photoreal': 'realistic realism photoreal photorealistic lighting mood atmosphere fog foggy golden sunset night horror sci-fi scifi cinematic bloom post-processing depth-of-field future shadow materialvariant surfaceappearance pbr imperfection weathering',
  'arcane-gameplay-systems': 'system mechanic checkpoint leaderstats leaderboard round intermission door key dialogue dialog talk quest pathfinding patrol chase shop currency cash money inventory sprint sprinting stamina health damage heal regen team teammate respawn',
  'arcane-rig-animation': 'animation animate rig walk idle motor6d',
  'arcane-characters': 'npc npcs character characters enemy enemies animation rig pathfinding ai humanoid creature creatures mob mobs monster zombie guard villager shopkeeper merchant flee',
  'arcane-genre-adaptation': 'obby obstacle platformer parkour horror tycoon simulator shooter rpg cozy social racing strategy party puzzle roleplay adventure',
  // Genre kits: prescriptive whole-game blueprints; genre words plus each genre's signature mechanics.
  'arcane-tycoon-kit': 'tycoon dropper conveyor collector plot rebirth factory',
  'arcane-obby-kit': 'obby obstacle course stage checkpoint kill brick killbrick kill-brick moving platform difficulty skip',
  'arcane-simulator-kit': 'simulator pet pets egg eggs hatch backpack sell rebirth clicker farming',
  'arcane-horror-kit': 'horror scary spooky creepy jumpscare jump-scare scare stalker haunted stinger',
  'arcane-arena-kit': 'pvp arena round round-based rounds deathmatch fps shooter map vote battle lobby elimination',
  'arcane-racing-kit': 'racing race racer track lap laps kart car vehicle drift timing',
  'arcane-rpg-kit': 'rpg adventure quest quests xp level-up leveling experience boss dungeon',
};
// Code references loaded with a selected domain skill when the budget allows (otherwise listed in deferredReferences).
const CODE_REFERENCES: Record<string, string> = { 'arcane-gameplay-systems': 'recipes', 'arcane-datastore-safety': 'template',
  'arcane-luau-architecture': 'patterns', 'arcane-natural-scenes': 'scene-build' };
const GENRES: Record<string, string> = { platformer: 'obby', obstacle: 'obby', parkour: 'obby', rpg: 'melee-rpg',
  melee: 'melee-rpg', cozy: 'cozy-social', social: 'cozy-social', race: 'racing' };
const NPC_CONTEXT = tokens('npc npcs enemy enemies character characters mob mobs monster zombie guard villager shopkeeper creature');
const SCRIPT_CONTEXT = tokens('script scripting luau module modulescript code');
const DEBUG_CONTEXT = tokens(HINTS['arcane-debugging'] ?? '');
const SHOP_FUNCTION_CONTEXT = tokens('work working functional functionality');
const SHOP_UI_CONTEXT = tokens('ui gui hud menu screen screengui panel button layout interface');
const PET_FOLLOW_CONTEXT = tokens('follow following follower');
const PET_PRESENTATION_CONTEXT = tokens('ui gui hud menu screen screengui panel button layout interface thumbnail static model-only');
function followingPet(request: string): boolean {
  const terms = tokens(request);
  if (!terms.has('pet') || ![...terms].some(term => PET_FOLLOW_CONTEXT.has(term))) return false;
  const primary = tokens(request.normalize('NFKC').toLowerCase().split(/[,;.!?\n]|\b(?:with|for|using)\b/, 1)[0]!);
  const inventoryOnly = primary.has('inventory') && ![...primary].some(term => PET_FOLLOW_CONTEXT.has(term));
  return !inventoryOnly && ![...primary].some(term => PET_PRESENTATION_CONTEXT.has(term)) &&
    !(primary.has('model') && (primary.has('only') || primary.has('just')));
}
function rank(skill: Metadata, terms: Set<string>, petFollower: boolean): number {
  const identity = tokens(skill.id.replace(/^arcane-/, '').replaceAll('-', ' '));
  const npcJob = [...terms].some(term => NPC_CONTEXT.has(term));
  const functionalShop = terms.has('shop') && [...terms].some(term => SHOP_FUNCTION_CONTEXT.has(term)) &&
    ![...terms].some(term => SHOP_UI_CONTEXT.has(term) || DEBUG_CONTEXT.has(term));
  const title = tokens(skill.title), description = tokens(skill.description), hints = tokens((HINTS[skill.id] ?? '') +
    (skill.id === 'arcane-characters' && npcJob ? ' patrol chase' : '') +
    (skill.id === 'arcane-gameplay-systems' && functionalShop ? ' work working functional functionality' : ''));
  // A whole-genre blueprint needs a genre or signature-mechanic match. Generic
  // description words such as "building" must not introduce an unrelated kit.
  if (GAME_GENRES.some(genre => genre.kit === skill.id) && ![...terms].some(term => hints.has(term))) return 0;
  let score = 0;
  for (const term of terms) score += hints.has(term) ? 12 : identity.has(term) ? 8 : title.has(term) ? 4 : description.has(term) ? 1 : 0;
  // Follower behavior needs the character contract below the primary pet/system hints, not a walking-rig promise.
  if (skill.id === 'arcane-characters' && petFollower) score = Math.max(score, 6);
  // Script diagnosis needs verification guidance below the debug/Luau hints, even when QA metadata has no lexical match.
  if (score === 0 && skill.id === 'arcane-playtest-qa' && [...terms].some(term => SCRIPT_CONTEXT.has(term)) &&
      [...terms].some(term => DEBUG_CONTEXT.has(term))) return 6;
  // A functional shop also needs a verification reader; explicit GUI/debug requests keep their ordinary routing.
  if (score === 0 && skill.id === 'arcane-playtest-qa' && functionalShop) return 6;
  return score;
}
/** Lead a requested habitat, without treating a feature merely located there as a habitat build. */
function primaryHabitat(request: string): boolean {
  let action = request.normalize('NFKC').toLowerCase().trim();
  for (let pass = 0; pass < 3; pass++) action = action.replace(/^(?:please|can you|could you|help me|i want you to|i want to|i need you to|i would like you to)\s+/, '');
  const creation = /^(?:build|create|make|design|generate|assemble|add)\s+(.+)/s.exec(action);
  if (!creation) return false;
  const target = creation[1]!.split(/[,;.!?\n]|\b(?:with|featuring|including|for|inside|within|using|of|in|to)\b/, 1)[0]!.trim();
  return /^(?:(?:a|an|the|my|our|full|whole|complete|detailed|natural|realistic|photorealistic|lush|dense|small|large|outdoor)\s+){0,8}(?:forests?|caves?|caverns?|woodlands?|jungles?|environments?)(?:\s+(?:scene|environment))?$/.test(target);
}

type GameGenre = 'obby' | 'tycoon' | 'simulator' | 'horror' | 'shooter' | 'melee-rpg' | 'racing' | 'cozy-social' | 'strategy' | 'party' | 'puzzle' | 'roleplay' | 'adventure';
type Phase = 'design' | 'systems' | 'content' | 'presentation' | 'verification';
interface Composition {
  intent: 'whole-game' | 'focused'; primaryGenre: GameGenre | null;
  initialCoverage: 'director-and-genre' | 'partial' | 'unavailable' | null;
  /** Bounded metadata for later skills_get calls, not loaded bodies or authority. */
  phases: { phase: Phase; ids: string[] }[];
  guidanceOnly: true;
}
const GAME_GENRES: readonly { name: GameGenre; match: RegExp; kit?: string }[] = [
  { name: 'obby', match: /\b(?:obby|platformer|parkour|obstacle course)\b/, kit: 'arcane-obby-kit' },
  { name: 'tycoon', match: /\btycoon\b/, kit: 'arcane-tycoon-kit' },
  { name: 'simulator', match: /\b(?:simulator|clicker)\b/, kit: 'arcane-simulator-kit' },
  { name: 'horror', match: /\b(?:horror|scary|spooky|haunted)\b/, kit: 'arcane-horror-kit' },
  { name: 'shooter', match: /\b(?:shooter|pvp|arena|deathmatch|fps)\b/, kit: 'arcane-arena-kit' },
  { name: 'melee-rpg', match: /\b(?:rpg|role-playing|roleplaying|melee)\b/, kit: 'arcane-rpg-kit' },
  { name: 'racing', match: /\b(?:racing|race|racer|karting)\b/, kit: 'arcane-racing-kit' },
  { name: 'cozy-social', match: /\b(?:cozy|social)\b/ },
  { name: 'strategy', match: /\b(?:strategy|rts|tower defense)\b/ },
  { name: 'party', match: /\b(?:party|minigame)\b/ },
  { name: 'puzzle', match: /\b(?:puzzle|educational)\b/ },
  { name: 'roleplay', match: /\broleplay\b/ },
  { name: 'adventure', match: /\b(?:adventure|exploration)\b/ },
];
function gameIntent(request: string): { brief: string; genre: typeof GAME_GENRES[number] | undefined } | null {
  const text = request.normalize('NFKC').toLowerCase().trim();
  let action = text;
  for (let n = 0; n < 4; n++) {
    const next = action.replace(/^(?:please|can you|could you|help me|i want you to|i want to|i need you to|i would like you to)\s+/, '');
    if (next === action) break; action = next;
  }
  const creation = /^(?:build|create|make|develop|design|deliver)\s+(.+)/s.exec(action)
    ?? /^(?:i want|i need|give me)\s+(.+)/s.exec(action);
  if (!creation) return null;
  const target = creation[1]!.split(/[,;.!?\n]|\b(?:with|featuring|including|for|inside|within|using|of|in|to)\b/, 1)[0]!
    .replace(/\b(?:don['’]t|do not|never|not|without|except|rather than|instead of)\b.*$/, '').trim();
  // The object being requested matters: a HUD/track/asset for a full game is a focused task.
  const gameNoun = /\b(?:games?|experiences?)\b/.exec(target);
  const focusedObject = /\b(?:scenes?|assets?|meshes?|models?|props?|tracks?|circuits?|courses?|vehicles?|cars?|karts?|characters?|npcs?|rigs?|animations?|vfx|sfx|sounds?|audio|music|ui|gui|huds?|menus?|screens?|scripts?|modules?|systems?|mechanics?|features?|lighting|forests?|terrain|rooms?|worlds?|levels?|maps?|dungeons?)\b/;
  if (focusedObject.test(gameNoun ? target.slice(gameNoun.index + gameNoun[0].length) : target)) return null;
  if (/\b(?:prototype|demo|blockout|vertical slice|starter)\b/.test(target)) return null;
  if (!/\b(?:games?|experiences?|obby|tycoon|simulator|rpg|platformer|shooter|roleplay)\b/.test(target)
      && !/\b(?:pvp arena|round-based arena|arena battle)\b/.test(target)) return null;
  // Examples and negated alternatives must not silently select the genre.
  const brief = text.replace(/\be\.g\./g, 'for example').replace(/\b(?:for example|such as)\b[^;.!?\n]*/g, '').split(/[,;.!?\n]+/)
    .map(clause => /\bexample\b/.test(clause) ? ''
      : clause.replace(/\b(?:don['’]t|do not|never|not|without|except|rather than|instead of)\b.*$/, ''))
    .join(' ');
  const genre = GAME_GENRES.map(value => ({ value, at: brief.search(value.match) })).filter(row => row.at >= 0)
    .sort((a, b) => a.at - b.at)[0]?.value;
  return { brief, genre };
}
const SYSTEM_PHASES: Record<GameGenre, readonly string[]> = {
  racing: ['arcane-physics', 'arcane-rounds', 'arcane-input-camera', 'arcane-gameplay-systems', 'arcane-networking', 'arcane-remote-security', 'arcane-luau-architecture'],
  obby: ['arcane-gameplay-systems', 'arcane-physics', 'arcane-input-camera', 'arcane-luau-architecture', 'arcane-datastore-safety'],
  tycoon: ['arcane-economy', 'arcane-gameplay-systems', 'arcane-datastore-safety', 'arcane-remote-security', 'arcane-luau-architecture'],
  simulator: ['arcane-gameplay-systems', 'arcane-inventory', 'arcane-economy', 'arcane-datastore-safety', 'arcane-remote-security', 'arcane-luau-architecture'],
  horror: ['arcane-npc', 'arcane-gameplay-systems', 'arcane-input-camera', 'arcane-rounds', 'arcane-luau-architecture'],
  shooter: ['arcane-combat', 'arcane-rounds', 'arcane-networking', 'arcane-remote-security', 'arcane-input-camera', 'arcane-luau-architecture'],
  'melee-rpg': ['arcane-gameplay-systems', 'arcane-npc', 'arcane-inventory', 'arcane-combat', 'arcane-economy', 'arcane-datastore-safety', 'arcane-luau-architecture'],
  'cozy-social': ['arcane-social-moderation', 'arcane-gameplay-systems', 'arcane-inventory', 'arcane-persistence', 'arcane-input-camera'],
  strategy: ['arcane-gameplay-systems', 'arcane-rounds', 'arcane-npc', 'arcane-economy', 'arcane-networking', 'arcane-luau-architecture'],
  party: ['arcane-rounds', 'arcane-gameplay-systems', 'arcane-networking', 'arcane-social-moderation', 'arcane-input-camera'],
  puzzle: ['arcane-gameplay-systems', 'arcane-input-camera', 'arcane-luau-architecture', 'arcane-onboarding'],
  roleplay: ['arcane-social-moderation', 'arcane-gameplay-systems', 'arcane-inventory', 'arcane-networking', 'arcane-persistence'],
  adventure: ['arcane-gameplay-systems', 'arcane-npc', 'arcane-inventory', 'arcane-input-camera', 'arcane-persistence'],
};
function gamePhases(catalogue: readonly Metadata[], genre: GameGenre | null): Composition['phases'] {
  const eligible = new Set(catalogue.map(skill => skill.id));
  const groups: { phase: Phase; ids: readonly string[] }[] = [
    { phase: 'design', ids: ['arcane-project-director', 'arcane-game-design', 'arcane-genre-adaptation'] },
    { phase: 'systems', ids: genre ? SYSTEM_PHASES[genre] : ['arcane-gameplay-systems', 'arcane-luau-architecture', 'arcane-rounds', 'arcane-inventory', 'arcane-economy', 'arcane-npc', 'arcane-physics', 'arcane-remote-security'] },
    { phase: 'content', ids: ['arcane-level-design', 'arcane-world-building', 'arcane-art-direction', 'arcane-blender-props', 'arcane-characters', 'arcane-materials', 'arcane-asset-integration', 'arcane-asset-optimization'] },
    { phase: 'presentation', ids: ['arcane-interface', 'arcane-rig-animation', 'arcane-vfx', 'arcane-audio', 'arcane-accessibility', 'arcane-onboarding', 'arcane-gameplay-feel'] },
    { phase: 'verification', ids: ['arcane-playtest-qa', 'arcane-quality-review', 'arcane-debugging', 'arcane-performance', 'arcane-release'] },
  ];
  return groups.map(group => ({ phase: group.phase, ids: [...new Set(group.ids)].filter(id => eligible.has(id)).slice(0, SKILL_ROUTER_LIMITS.skills) }))
    .filter(group => group.ids.length > 0);
}
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }

/** Pure local retrieval: no daemon call, model invocation, project scan or registry write. */
export async function recommendSkills(registry: SkillRegistry, input: SkillRecommendationInput) {
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.includes('\0') || input.request.length > SKILL_ROUTER_LIMITS.requestCharacters ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > SKILL_ROUTER_LIMITS.skills ||
      !Number.isInteger(input.byteBudget) || input.byteBudget < 256 || input.byteBudget > SKILL_ROUTER_LIMITS.maximumBytes || typeof input.allowExperimental !== 'boolean') {
    fail('SKILL_ROUTE_INPUT', 'Expected a bounded task brief, 1–8 skills, byte budget and explicit guidance policy.');
  }
  const catalogue = await registry.list({ limit: SKILL_ROUTER_LIMITS.catalogue, allowExperimental: input.allowExperimental });
  if (catalogue.truncated) fail('SKILL_CATALOGUE_LIMIT', 'Bundled skill catalogue exceeds the bounded router inventory.');
  const game = gameIntent(input.request), terms = tokens(game?.brief ?? input.request), petFollower = followingPet(input.request);
  const primary = !game && primaryHabitat(input.request) ? 'arcane-natural-scenes' : null;
  const ranked = catalogue.items.filter(skill => !CORE.includes(skill.id as typeof CORE[number]))
    .map(skill => { const score = rank(skill, terms, petFollower) + (skill.id === primary ? 1 : 0), boost = input.boosts?.[skill.id]; return { skill, score: score > 0 && typeof boost === 'number' && boost > 0 ? score + Math.min(4, boost) : score }; })
    .filter(row => row.score > 0)
    .sort((a, b) => Number(b.skill.id === primary) - Number(a.skill.id === primary) || b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  // Preserve domain space for small budgets/limits; core process is also always
  // delivered in initialize.instructions, even when no eligible registry skill exists.
  const coreSlots = ranked.length ? Math.min(CORE.length, Math.max(0, input.limit - Math.min(2, ranked.length))) : input.limit;
  const core = CORE.map(id => catalogue.items.find(skill => skill.id === id)).filter((skill): skill is Metadata => !!skill).slice(0, coreSlots);
  // Most relevant first: domain skills lead and core process (also in the instructions) trails,
  // so a tight budget defers core bodies before task-specific guidance; skills_get loads them on demand.
  const partnerId = game?.genre?.kit ?? 'arcane-genre-adaptation';
  const initial = game ? ['arcane-project-director', partnerId].map(id => catalogue.items.find(skill => skill.id === id))
    .filter((skill): skill is Metadata => !!skill) : [];
  const selected = game ? initial.slice(0, input.limit) : [...ranked.slice(0, input.limit - core.length).map(row => row.skill), ...core];
  const ids = selected.map(skill => skill.id);
  const references: string[] = [];
  const genre = selected.find(skill => skill.id === 'arcane-genre-adaptation');
  if (game && genre) {
    const name = game.genre?.name ?? 'genres';
    if (genre.references.includes(name)) references.push(`${genre.id}:${name}`);
  }
  else if (genre) for (const term of terms) {
    const name = GENRES[term] ?? term;
    const reference = `${genre.id}:${name}`;
    if (genre.references.includes(name) && !references.includes(reference) && references.length < SKILL_ROUTER_LIMITS.references) references.push(reference);
  }
  for (const skill of selected) {
    const name = skill.id === 'arcane-characters' && petFollower ? 'pets' : CODE_REFERENCES[skill.id];
    if (name && skill.references.includes(name) && references.length < SKILL_ROUTER_LIMITS.references) references.push(`${skill.id}:${name}`);
  }
  const deferredIds: string[] = initial.slice(input.limit).map(skill => skill.id), deferredReferences: string[] = [];
  let pack: Awaited<ReturnType<SkillRegistry['get']>> | undefined;
  while (ids.length) {
    try { pack = await registry.get({ ids: [...ids], references: [...references], byteBudget: input.byteBudget, allowExperimental: input.allowExperimental }); break; }
    catch (error) {
      // Budget is the sole recoverable case. Integrity/status/path failures are
      // never converted into successful partial guidance or "approved" fallback.
      if ((error as { code?: unknown }).code !== 'BUDGET_EXCEEDED') throw error;
      if (game && references.length) deferredReferences.unshift(references.pop()!);
      else if (game && ids.length > 1) deferredIds.unshift(ids.pop()!);
      else if (!game && ids.length > 1 && CORE.includes(ids.at(-1) as typeof CORE[number])) deferredIds.unshift(ids.pop()!);
      else if (references.length) deferredReferences.unshift(references.pop()!);
      else if (ids.length > 1) deferredIds.unshift(ids.pop()!);
      else throw error;
    }
  }
  const coverage = !pack ? 'unavailable' : ids.includes('arcane-project-director') && ids.includes(partnerId) ? 'director-and-genre' : 'partial';
  const composition: Composition = { intent: game ? 'whole-game' : 'focused', primaryGenre: game?.genre?.name ?? null,
    initialCoverage: game ? coverage : null, phases: game ? gamePhases(catalogue.items, game.genre?.name ?? null) : [], guidanceOnly: true };
  const limitation = !pack ? 'No eligible bundled skills under the requested policy; core product instructions still apply.'
    : game && coverage === 'partial' ? 'Only partial initial whole-game guidance is available under this count, byte budget or policy. Use eligible deferred/phase guidance with skills_get; no complete game or authority is implied.' : null;
  return {
    tool: SKILLS_RECOMMEND_TOOL, selection: 'deterministic-task-relevance',
    allowExperimental: input.allowExperimental, defaultLoadPolicy: catalogue.defaultLoadPolicy, approvalChanged: false,
    verification: 'Bundled integrity checks only; experimental content is not behavior-verified or production-approved.',
    selected: selected.filter(skill => ids.includes(skill.id)).map(skill => ({ id: skill.id, status: skill.status, approved: skill.approved,
      reason: CORE.includes(skill.id as typeof CORE[number]) ? 'Core inspect/plan/build/verify process' : 'Task relevance in bundled metadata and domain hints' })),
    ids, references, deferredIds, deferredReferences, bytes: pack?.bytes ?? 0, byteBudget: input.byteBudget,
    context: pack?.context ?? '', available: !!pack, composition,
    ...(limitation ? { limitation } : {}),
  };
}
