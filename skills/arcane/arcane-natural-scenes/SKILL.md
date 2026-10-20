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
Preserve usable ground during local edits. When landforms are needed, terrain_generate first: seeded terrain and controlled amplitude at player routes. Never use a flat Part disc as a substitute for requested natural terrain; a circular architectural platform is valid.
Use terrain features to `flatten` the clearing; `path` bends gently with useful width; `river` follows low ground and avoids the spawn. Match material transitions to slope, dampness and shoreline.
A cave needs an entrance, roof, continuous floor and traversable interior. terrain_generate alone does not supply caves: use bounded overlapping Air fills through environment_apply inside a sufficiently thick hillside, then original rock forms to finish the entrance/interior. A rock arch or unenterable dark opening is not a completed cave. Inspect the entrance and interior route.

## Original foliage
For realism use authored meshes with branch structure, irregular crowns and coherent bark/leaf materials. Prepare several mature/young silhouettes and a few dead snags. Visible cylinder tiers, overlapping Balls or moss-capped Blocks are not a realistic finish.
For explicitly stylized/blockout work, multi-part prototypes can express Pine (tapered trunk, layered crown), Oak (branching trunk, broad irregular crown), and Birch (slender pale trunk, dark marks, light crown).
Keep trunks collidable and decorative foliage non-colliding; small leaves CastShadow false. Use original fern, grass, log and rock variants for realistic undergrowth, concentrated by ecology and routes rather than uniform debris.

## Tree anatomy review
Review the leafless model in neutral front, side and three-quarter views, plus root and fork closeups. Match the reference silhouette with a gradually tapered, crooked trunk, staggered boughs, intermediate branches and finer terminal twigs. Keep branch thickness continuous through forks and blend grounded, uneven root flares into the trunk. Repair sharp junction lips, abrupt cone bases, repeated tiers and hair-thin branches at their source before adding leaves or bark detail.
Keep the tree alone in these previews; do not add people, mannequins or human scale figures. Then review the actual textured canopy and exported mesh at the intended viewing distance. Technical validation and attractive lighting do not establish reference fidelity.

## Placement
Use scene_build prototypes/templates + scatter (Poisson-disk) per layer and a fixed seed. Group Trees, Undergrowth and Rocks separately; budget includes every clone's contents.
Landmark forest: scene_build kits plinth (SpawnLocation on top) + forest (species/cover use, share, spacing; paths); terrain_generate plateau base = plinth radius, plus a matching `path`. Originals: assets_procedural `<use>-<n>`, seed = kit seed x 100 + n (pine-1..3, oak-1..3, birch-1..2, bush-1..2, fern-1..2, rock-1..3, log-1..2; a blockout kit's `recipe` lists them). The user approves each preview; agents never approve. Place ONE approved copy each in a hidden template Folder; templates {"oak-1": ref} make use "oak" clone its `<use>-<n>` variants. Else the kit reports `blockouts`; say so and never call that forest realistic.
Never use rings, grids, rows, evenly stepped angles or one shared radius.
Tree variation: scale [0.75,1.25], random yaw, subtle tint. Match minSpacing to real crown sizes and clusters to grove scale; preserve foreground/midground/background depth.
Set clearing inner to the protected landmark radius and outer to a gentle density transition; avoid reserves circular obstacles. Copy continuous approach/river polylines into every layer as avoidPaths: [{points: [[x,z], ...], width: 8}] using the intended full width. footprintRadius is the conservative scale-1 canopy/prop radius; it scales clearance around paths, circles and clearings. ground:true lands copies on the surface.
Compare scatter placed/requested counts. Reduce density or expand the unprotected area if crowded; never fill a protected route to hit a count.

## Finish
Light, ClockTime, atmosphere: environment_apply preset forest-morning (or another forest-*); kit `life`: motes, sound hooks. Inspect the landmark/forest composition, player approach and cave access with studio_viewport_capture. Repair floating props, stair/rail gaps, repetitive silhouettes and clipped foliage. Give the safe zone a grounded perimeter or material boundary; oversized floating labels are not a substitute. Verify spawn function and any claimed damage protection separately. State actual results and limits; do not claim photographic indistinguishability.

Read arcane-photoreal for materials/light and arcane-architectural-features for connected landmark geometry.

## Blender authoring boundary
- Models, UVs, textures and PBR are authored in local Blender. Do not use Studio AI generation. Check the actual exported materials and preview before import; on a failure give its stage and reason. A local export, flat color or reconstructed mesh alone does not prove a finished textured Studio asset.
