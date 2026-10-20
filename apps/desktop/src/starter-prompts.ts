// Quick-start prompts shown on the empty chat. Edit freely: this is plain data, rendered by starter-gallery.ts.
// Each prompt is filled into the composer (never sent automatically) and is written to be short and tool-directed:
// load the matching skill, create original assets; Toolbox models only when explicitly requested, build in scene_build batches, then look and fix.

export type StarterCategory = 'Scene' | 'Gameplay' | 'Interface' | 'Systems';
export type StarterIcon = 'tree' | 'flag' | 'coins' | 'loop' | 'ghost' | 'layout' | 'target' | 'store' | 'chat' | 'flask';
export interface StarterPrompt {
  /** Stable id (lowercase, hyphenated). */
  readonly id: string;
  readonly title: string;
  /** One line shown under the title. */
  readonly description: string;
  readonly category: StarterCategory;
  readonly icon: StarterIcon;
  /** Text placed in the composer. */
  readonly prompt: string;
}

/** Shared closing line: look at the result, fix the worst issues, and only playtest when the Playtest switch is on. */
const VERIFY = 'Then studio_viewport_capture 2 angles, critique, fix the top 3 issues. If Playtest is on, playtest_request once to check it.';

export const STARTER_PROMPTS: readonly StarterPrompt[] = Object.freeze([
  {
    id: 'forest-clearing', title: 'Realistic forest clearing', category: 'Scene', icon: 'tree',
    description: 'Terrain, procedural trees, undergrowth and soft fog.',
    prompt: `Build a realistic forest clearing (~200x200 studs) in Workspace.ForestClearing. Load skills arcane-natural-scenes and arcane-photoreal.
1. environment_apply preset foggy_forest; terrain: grass floor, gentle hills, a small pond, rock outcrops.
2. Hero trees with assets_procedural (oak + pine, 4 variants, varied seed/height); scatter ~40, denser at the edges, open centre.
3. Logs, stumps, mushrooms: original meshes; assets_procedural foliage (fern/bush) around trunks and rocks.
4. Place in scene_build batches; anchor all, CanCollide off on small foliage, stay under 60k triangles.
${VERIFY}`,
  },
  {
    id: 'obby-checkpoints', title: 'Obby with checkpoints', category: 'Gameplay', icon: 'flag',
    description: '12 stages, kill bricks, moving platforms, saved progress.',
    prompt: `Build a 12-stage obby with checkpoints. Load skills arcane-obby-kit and arcane-level-design.
1. scene_build one batch per 3 stages under Workspace.Obby: jumps, kill bricks (Neon red), 2 moving platforms (PrismaticConstraint), difficulty ramps up.
2. A SpawnLocation checkpoint per stage; server Script sets leaderstats.Stage and respawns players at their highest stage.
3. Decor via original meshes; environment_apply clear_day.
4. Keep logic server-side; no client trust for stage changes.
${VERIFY}`,
  },
  {
    id: 'tycoon-starter', title: 'Tycoon starter', category: 'Gameplay', icon: 'coins',
    description: 'Claimable plot, droppers, conveyor and purchase buttons.',
    prompt: `Build a tycoon starter. Load skills arcane-tycoon-kit and arcane-economy.
1. scene_build a claimable plot: claim pad, 2 droppers, conveyor, collector, 6 purchase buttons that reveal hidden items in order.
2. ModuleScript config (prices, income/sec) in ReplicatedStorage; server Script owns cash in leaderstats and validates every purchase.
3. Props from original meshes; keep parts anchored and cheap.
4. Support 4 plots by cloning one template.
${VERIFY}`,
  },
  {
    id: 'simulator-loop', title: 'Simulator loop', category: 'Gameplay', icon: 'loop',
    description: 'Collect, fill the bag, sell, upgrade and rebirth.',
    prompt: `Build a simulator core loop. Load skills arcane-simulator-kit and arcane-gameplay-feel.
1. scene_build a spawn hub, 3 collect zones (rising value), a sell pad and an upgrade shop pad.
2. Server Script: click or touch to collect into a capped bag; sell converts to Coins; upgrades raise capacity and speed; rebirth resets for a multiplier.
3. Small HUD in StarterGui: coins, bag fill bar, rebirths.
4. Pickup and sell feedback with ParticleEmitter + Sparkles; collectibles from original meshes.
${VERIFY}`,
  },
  {
    id: 'horror-corridor', title: 'Horror corridor with VFX', category: 'Scene', icon: 'ghost',
    description: 'Dark hallway, flicker lights, fog and a jump scare.',
    prompt: `Build a horror corridor (~120 studs, 2 side rooms) in Workspace.Corridor. Load skills arcane-horror-kit, arcane-vfx and arcane-audio.
1. environment_apply preset horror; dense fog, low ambient.
2. scene_build walls, doors and ceiling lights; a server Script flickers 3 PointLights at random.
3. VFX: ParticleEmitter dust, Smoke at a vent, a red Highlight on a figure revealed by a Touched trigger once per player.
4. Furniture and debris via original meshes; no scripts kept from inserted assets.
${VERIFY}`,
  },
  {
    id: 'menu-hud', title: 'Main menu + HUD', category: 'Interface', icon: 'layout',
    description: 'Title screen, settings panel and an in-game HUD.',
    prompt: `Build a main menu and HUD in StarterGui. Load skills arcane-interface and arcane-accessibility.
1. MenuGui: title, Play, Settings (music volume, camera sensitivity), Credits; Play hides it and shows HUD.
2. HudGui: health bar, coin counter bound to leaderstats, objective text; respects mobile safe area.
3. UIScale + UIAspectRatioConstraint so it fits phone to 4K; 4.5:1 text contrast; gamepad selection works.
4. One LocalScript per Gui; no polling loops.
Then studio_viewport_capture and fix layout issues. If Playtest is on, playtest_request clicking Play once.`,
  },
  {
    id: 'round-arena', title: 'Round-based arena', category: 'Gameplay', icon: 'target',
    description: 'Lobby, intermission timer, arena rounds and winners.',
    prompt: `Build a round-based arena. Load skills arcane-arena-kit and arcane-rounds.
1. scene_build a lobby and a separate arena with cover and 8 spawn points.
2. Server round loop: intermission 15s, teleport players, 90s round, last alive or most KOs wins, return to lobby; handle leaves mid-round.
3. Status text in StarterGui driven by a StringValue in ReplicatedStorage.
4. Arena props via original meshes; environment_apply golden_hour.
${VERIFY}`,
  },
  {
    id: 'shop-datastore', title: 'Shop + DataStore', category: 'Systems', icon: 'store',
    description: 'Server-checked shop with safe saving.',
    prompt: `Build a shop with saved data. Load skills arcane-datastore-safety, arcane-persistence and arcane-remote-security.
1. ModuleScript catalog (id, name, price) in ReplicatedStorage; shop Gui in StarterGui.
2. One RemoteFunction; the server validates price, balance and ownership, rate-limits calls.
3. Data: UpdateAsync with retries, session lock, autosave every 60s, save on PlayerRemoving and BindToClose; versioned schema with defaults.
4. Never trust client values.
Then script_read the server script and review it for data-loss paths. If Playtest is on, playtest_request one purchase.`,
  },
  {
    id: 'npc-village', title: 'NPC dialogue village', category: 'Scene', icon: 'chat',
    description: 'Small village with talking NPCs and quests.',
    prompt: `Build a small village with 3 talking NPCs. Load skills arcane-rpg-kit, arcane-npc and arcane-world-building.
1. Houses, fences and a well via original meshes; assets_procedural trees and bushes around them.
2. Place in scene_build batches; dirt paths with terrain; environment_apply golden_hour.
3. Each NPC: ProximityPrompt opens a dialogue Gui with branching choices from a ModuleScript; one gives a fetch quest.
4. Keep NPCs anchored, no pathfinding yet.
${VERIFY}`,
  },
  {
    id: 'scifi-lab', title: 'Sci-fi lab with lighting', category: 'Scene', icon: 'flask',
    description: 'Clean lab, neon strips, glass and glowing beams.',
    prompt: `Build a sci-fi research lab (~80x60 studs) in Workspace.Lab. Load skills arcane-materials and arcane-vfx.
1. environment_apply preset sci_fi, Future lighting, MaterialVariants for floor and walls.
2. scene_build rooms, glass partitions, Neon strips with SurfaceLights.
3. Consoles and crates via original meshes; if none fit, studio_asset_generate one hero console mesh.
4. VFX: a Beam between two emitters on a reactor core, soft ParticleEmitter sparks.
${VERIFY}`,
  },
]);
