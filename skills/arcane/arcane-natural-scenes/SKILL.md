---
name: arcane-natural-scenes
description: "Build original natural environments with believable plant and rock structure, ecological content layers, usable routes and inspected in-engine composition."
license: MIT
---

# Natural environments with structure and usable space

## Compose the requested habitat
Identify terrain, focal landmarks, routes, activity areas, sightlines and biome conditions from the brief. Preserve every requested feature without making every natural scene a forest, cave or spawn plinth. A full-game environment needs useful destinations and coherent transitions around its actual objectives; a local vegetation edit stays local.

Block traversable ground and silhouette first. Use terrain_generate for requested landforms, flatten only intended activity areas, and reserve continuous path/river polylines before scatter. Preserve existing ground in local edits. A flat Part disc does not stand in for natural terrain, while an intentional architectural platform is valid.

For caves, inspect an entrance, roof, continuous floor, interior route and exit/dead-end design at player scale. Supported terrain_generate caves raise/carve an outcrop; read [scene-build](references/scene-build.md) for actual fields and fixtures. A dark hole or rock arch is not an explored cave. Do not carve beneath protected structures or fill entrances with scatter.

## Tool plan and source bindings
For `terrain_generate`, use `features` in order: `flatten` with `level`/`blend` for a clearing, `river` or `path` with continuous `points`, full `width` and intentional `depth`/`bank`. Heights are above `floor`, not absolute Y. Use `environment_apply` for the relevant lighting/atmosphere; `ClockTime`, haze and exposure must preserve the actual route's readability (arcane-photoreal).

In `scene_build`, bind imported refs in `templates`; explicit blockout parts belong in `prototypes`. Resolve every forest layer before a write: missing sources refuse with `FOREST_SOURCES_REQUIRED`. A template name is not Blender provenance. The optional forest kit's family seed is `(kitSeed * 100 + 1) % 2**31`; author each family member with the same generator/seed and `variant: [i,n]`, named `<use>-<n>` (for example oak-1..4). Inspect every member; an agent cannot approve it.

Scatter uses Poisson-disk `minSpacing`, optional `clusters`/`clusterSpread`, `clearing`, `avoid`, `avoidPaths`, `footprintRadius` and `seed`. Use `ground: true` where surface placement is intended. Generic prototypes may use scale/yaw/tint ranges; managed original templates keep their authored colour (no tint). Choose variation and counts from measured bounds, not a universal forest part quota. Consider `CastShadow: false` only for small decorative fill after checking its visual effect.

## Author convincing natural families
Use original Blender geometry, UVs, textures and PBR. Choose assets_procedural only for faithfully supported forms; use the permitted native authoring route for other forms. Review assets_jobs and assets_preview, obtain the exact model's human approval, then follow the supported import flow. Toolbox/free models require an express request and the human-controlled setting. Unsupported authoring/import is a stated limitation, never permission to substitute.

For trees, inspect a leafless front/side/three-quarter view and root/fork closeups: taper, crooked growth, unequal bough spacing, connected intermediate branches, fine twigs, sensible fork thickness and grounded root flare. Then inspect the textured canopy. Check actual visible petiole/card roots meet branches, not merely card bounds or a virtual guide; UV/alpha numbers alone do not prove visible attachment. Use mature/young/dead variants when the habitat benefits, not tiers of identical cylinders or balls for a requested realistic finish.

For rocks, establish geological mass, bedding/fracture direction, stable contact and a few large broken planes before fine roughness. Avoid inflated cubes, melted blobs, uniform noise, razor spikes, repeated silhouettes and paint-only moss caps. Review untextured form and a neutral textured view separately.

## Place layers with purpose
Reuse approved originals as hidden templates and scene_build clones/scatter; declared scene-build guidance covers variant families, footprints and counts. Human review cannot be supplied by an agent. Wild habitats use clustered spacing, varied age/scale and foreground/midground/background layers; planted rows are appropriate when the brief calls for cultivation.

Separate canopy, shrubs, ground cover, rocks and deadwood. Density follows moisture, slope, light and gameplay access rather than a uniform debris field. Copy full route widths into every layer's avoidPaths; choose footprintRadius from conservative scale-1 crown/prop bounds so clearance scales with clones. Check placed versus requested counts and reduce crowding instead of blocking routes. Keep decorative foliage non-colliding and collision purposeful.

## Acceptance
Inspect the player approach, focal composition, ground contacts, leaf/branch joins and cave mouths/interiors in actual engine views. Traverse critical paths, entrances and interaction areas; measure relevant stuck points, sightline loss and dense-area cost on target devices. Add appropriate light, ambient life or audio only when within the requested experience and available rights/capabilities. Verify any requested spawn/safe-zone gameplay server-side; decoration is not protection. Report blockouts, missing persistence and untested features honestly: session meshes and their editable image maps do not become durable published assets through placement or a pretty preview.
