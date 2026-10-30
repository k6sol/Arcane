---
name: arcane-architectural-features
description: "Author original architectural kits and landmarks with coherent construction, measured scale, continuous access, usable interiors and verified gameplay integration."
license: MIT
---

# Architecture people can use

## Resolve the design
Identify function, period/style, footprint, structural rhythm, player approach and required interiors or moving pieces. A pillar request does not imply flutes, spiral stairs, a spawn or floating labels. For a building or game environment, plan the rooms, circulation, entry/exit and associated interaction points; for a single feature, keep that scope.

Block primary load-bearing forms and openings before trim. Use consistent wall/floor thickness, column spacing, beams, supports and roof logic. Build reusable straight, corner, junction, end and height-transition modules with aligned seams, pivots and material scale. Test a representative assembled bay before multiplying it.

Author finished geometry, UVs, textures and PBR in Blender. Use assets_start/custom assembly or assets_procedural only when its representation fits the design; preserve editable source and measured exports. Review assets_preview and exact-model human approval, then the advertised prepare/stage/reconstruct/place or revision flow. Models from Toolbox/free libraries require an express request. Report unsupported stages instead of replacing a bespoke facade with primitives or claiming Studio AI authoring.

## Derive the geometry and access
Use Blender metres and the import manifest's explicit studs-per-metre conversion once. Measure final rotated bounds instead of applying a second guessed scale. A slab of thickness t on a surface at y has centre y+t/2. Derive rails from support endpoints: midpoint at their average, length from their distance with intentional joint overlap.

Select path, ramp, bridge or stairs for actual movement/camera needs. Choose riser/tread and landings from tested player capability. A radial stair requires explicit design justification; at radius R, width w and angular step a, outer tread depth must cover at least 2*(R+w/2)*tan(a/2) plus joint overlap. Include risers/support and continuous top/bottom landings; a good overhead silhouette proves no walkability.

Keep collision simpler than ornament and preserve doorway, headroom, turning and handrail clearance. Moving doors/lifts need separate pivots, authoritative activation and fail/recovery behavior from gameplay code.

## Landmarks and spawns when requested
Inspect the existing SpawnLocation before an exact-baseline update; keep it upright, anchored and correctly seated, with player headroom. Avoid duplicate spawns. scene_delete is only for authorized removals and uses Studio Undo, not receipt_restore. Derive vegetation exclusion and grading from the final footprint, and keep approaches open. A visible safe-zone boundary must correspond to actual server-side protection if that function is requested.

## Use the feature tools deliberately
For a requested plinth, `scene_build` kit fields include `at`, `radius`, `tiers`, `style`, `height`, `column`, `material` and `weathering`. Select smooth/fluted/platform to match the design; the kit is not a bespoke-building generator. Set `spawn: false` when no spawn was requested: its default is true. If included, inspect the returned `kits` spawn `top` and actual SpawnLocation bounds; use `scene_update` with the exact baseline for corrections.

A `safeZone` report includes a Script proposal, not installed protection. Review/write it through `script_update`, read it back, and use `script_set_enabled` only through the existing review flow. A `life` option supplies visual elements and silent audio hooks, not licensed sound playback. On authoring/import failure, report the exact failing stage and supported reason before deciding the next step; never replay an ambiguous mutation.

## Acceptance
Review neutral front/side/three-quarter form, actual dimensions, bevels/normals, UV seams, texture scale and material joins. In the engine inspect eye-height approaches and interiors, then traverse every advertised entrance, landing and connection. Exercise moving mechanisms and spawn/respawn where included; detect snagging, unsupported spans, floor gaps and camera clipping. Check repeated modules for cumulative drift. Record actual import/persistence limits and unresolved functionality; neither export success nor a beauty render proves a usable building.
