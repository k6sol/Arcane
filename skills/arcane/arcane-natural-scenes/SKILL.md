---
name: arcane-natural-scenes
description: "Build coherent original forests, caves and spawn landmarks with grounded foliage, continuous paths, natural scatter and visual review."
license: MIT
---

# Natural scenes: forests, caves and spawn landmarks

## Plan and source
Keep every clause of the brief. For a forest with caves and a detailed spawn pillar, plan the landmark, accessible cave entrances/interiors, approach, visible safe zone, foliage layers and lighting together. Use existing project style and sensible scale; 800-2500 parts is a planning example, not a target to fill with debris.
Original assets by default. For trees, rocks, foliage, fallen logs, stumps and columns use assets_procedural (local Blender), assets_jobs, assets_preview, then assets_prepare_studio_import -> assets_stage_studio_import -> assets_reconstruct_studio_import -> assets_place_studio_import. Do not stop after rendering/exporting: place the actual meshes. Session-only meshes disappear in Play unless uploaded; report it. Only if the user explicitly requests Toolbox models and enables Settings may studio_asset_search/studio_asset_insert supply them; realism grants neither.

## Ground and caves
Preserve usable ground in local edits; for landforms run terrain_generate first (seeded, gentle amplitude on player routes). Never use a flat Part disc as a substitute for requested natural terrain; a circular architectural platform is valid.
Use terrain features to `flatten` the clearing; `path` bends gently with useful width; `river` follows low ground and avoids the spawn. Match material transitions to slope, dampness and shoreline.
A cave needs an entrance, roof, continuous floor and traversable interior. Use terrain_generate `caves` {at: outcrop centre outside the clearing, entrances, chambers}: it raises a rock outcrop and carves winding tunnels with hillside mouths and Slate-floored chambers, never under pads or keep-outs. scene_build result.caves.fixtures (stalactites, dim lights); keep mouths open with forest `paths`. A rock arch or unenterable dark opening is not a completed cave. Inspect each mouth and chamber route.

## Original foliage
For realism use authored meshes with branch structure, irregular crowns and coherent bark/leaf materials. Prepare several mature/young silhouettes and a few dead snags. Visible cylinder tiers, overlapping Balls or moss-capped Blocks are not a realistic finish.
Stylized/blockout only: multi-part prototypes for Pine (tapered trunk, layered crown), Oak (branching trunk, broad crown), Birch (slender pale trunk, dark marks).
Keep trunks collidable and decorative foliage non-colliding; small leaves CastShadow false. Use original fern, grass, log and rock variants for realistic undergrowth, concentrated by ecology and routes rather than uniform debris.

## Tree anatomy review
Review the leafless model alone (no people or scale figures) in front, side and three-quarter views plus root/fork closeups: a tapered, crooked trunk, staggered boughs, intermediate branches, fine twigs, continuous thickness through forks and grounded root flares. Fix junction lips, cone bases, repeated tiers and hair-thin branches at their source before leaves or bark. Then review the textured canopy and exported mesh at viewing distance; validation and nice lighting do not prove reference fidelity.

## Placement
Use scene_build prototypes/templates + scatter (Poisson-disk) per layer and a fixed seed; fields: `arcane-natural-scenes:scene-build`. Group Trees, Undergrowth and Rocks separately; budget includes every clone's contents.
Landmark forest: scene_build kits plinth (SpawnLocation on top) + forest (species/cover use, share, spacing; paths); terrain_generate plateau base = plinth radius, plus a matching `path`. Originals: an assets_procedural variant family per species, `<use>-<n>` = `variant` [n, count], family seed = kit seed x 100 + 1 (oak-1..4; a blockout kit's `recipe` lists all). The user approves each preview; agents never approve. Place ONE approved copy each in a hidden template Folder; templates {"oak-1": ref} make use "oak" clone its `<use>-<n>` variants. Else the kit reports `blockouts`; say so and never call that forest realistic.
Never use rings, grids, rows, evenly stepped angles or one shared radius.
Tree variation: scale [0.75,1.25], random yaw, subtle tint. Match minSpacing to real crown sizes and clusters to grove scale; preserve foreground/midground/background depth.
Set clearing inner to the protected landmark radius and outer to a gentle density transition; avoid reserves circular obstacles. Copy continuous approach/river polylines into every layer as avoidPaths: [{points: [[x,z], ...], width: 8}] using the intended full width. footprintRadius (scale-1 canopy/prop radius) scales clearance around paths, circles and clearings. ground:true lands copies on the surface.
Compare placed/requested counts; if crowded reduce density or widen the open area, never fill a protected route.

## Finish
Light, ClockTime, atmosphere: environment_apply preset forest-morning (or another forest-*); kit `life`: motes, sound hooks. Inspect the landmark/forest composition, player approach and cave access with studio_viewport_capture. Repair floating props, stair/rail gaps, repetitive silhouettes and clipped foliage. Safe zone: plinth `safeZone` {radius >= plinth radius + 2.5, style glow|stone} grounds a ring; install report safeZone.script via scene_create Script in the plinth, script_read, script_update, script_set_enabled. Floating labels are no substitute. Verify spawn and damage protection in a playtest. State actual results and limits; do not claim photographic indistinguishability.

Read arcane-photoreal for materials/light and arcane-architectural-features for connected landmark geometry.

## Blender authoring boundary
- Models, UVs, textures and PBR are authored in local Blender. Do not use Studio AI generation. Check the actual exported materials and preview before import; on a failure give its stage and reason. A local export, flat color or reconstructed mesh alone does not prove a finished textured Studio asset.
