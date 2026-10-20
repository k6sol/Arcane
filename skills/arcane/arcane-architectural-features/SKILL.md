---
name: arcane-architectural-features
description: "Build detailed Roblox architecture such as classical columns, stepped plinths, stairs and spawn pedestals with correct SpawnLocation placement, in one batch call."
license: MIT
---

# Architectural features and spawn landmarks

## Design from the brief
- Define a distinct silhouette, proportions, palette and player approach. A pillar request does not request a spiral stair, classical column, flutes or floating labels. Do not repeat an earlier landmark as a new design.
- Author finished visual geometry in Blender with UVs, textures and PBR; keep Studio for placement, gameplay, terrain and simple collision. A primitive blockout is not a finished realistic model.
- Use assets_start/custom assembly for bespoke architecture, or assets_procedural only when its supported shape fits. Inspect assets_preview before adoption; preserve editable source and measured exports. Only if the user explicitly requests Toolbox models may studio_asset_search/studio_asset_insert supply them.
- Follow assets_jobs, then prepare, stage, reconstruct and assets_place_studio_import. A render or local GLB is not Studio placement. Do not use studio_asset_generate: models, UVs and materials belong in Blender. Report the exact failing stage; do not silently substitute engine primitives or free models.

## Spatial and traversal rules
- Use meters in Blender and the import's explicit studs-per-meter conversion once. Establish a floor pivot and measure final rotated bounds; avoid a second ad-hoc scale conversion.
- A piece of thickness t on surface y has center y+t/2. Derive rails from adjacent support endpoints, with midpoint at their average and length equal to their distance plus a small overlap.
- Choose access from gameplay: path, ramp, bridge or conventional steps. Add a spiral stair only when requested or deliberately justified by the design, never by default.
- For appropriate radial stairs derive count/rise from endpoint heights. With width w, radius R and angle a, tread depth is at least 2*(R+w/2)*tan(a/2) plus overlap. Include support, risers and a continuous landing.
- Keep collision separate from visual mesh detail. No claimed walkability from an overhead image alone.

## Spawn and surroundings
- Moving a spawn: scene_inspect then scene_update on the existing SpawnLocation with exact baselines. Keep it upright, anchored and collidable, with its bottom on the platform top and clear of rails.
- Round spawn plinth: scene_build kits plinth; fluted only if classical. Verify kits spawn.top.
- Avoid duplicate spawns; use scene_delete when removal is requested. Deletion uses Studio Undo, not receipt_restore.
- Size the clearing and foliage exclusion from the final footprint. Blend the ground around it instead of making a huge flat disc. Keep the approach and cave route unobstructed.
- Make the safe-zone boundary visible at ground/platform level. A decorative ring is not functioning protection; implement and verify server-side behavior if requested.

## Review and delivery
- Check silhouette, bevels, texture scale, UV seams, topology and collision separately. Export success does not establish visual quality or photorealism.
- Inspect studio_viewport_capture from the player approach and at eye height; fix gaps, intersections, unsupported structure and repeated shapes. Verify actual spawn height and a continuous route.
- Reuse original scene_build templates only when intended by the brief. Session-only meshes and image resources require supported persistence; state the actual import boundary rather than implying an upload occurred.
- Related guidance: arcane-photoreal for materials/scale; arcane-vfx for lighting/effects.
