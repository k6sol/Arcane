---
name: arcane-world-building
description: "Build coherent Roblox terrain, biomes and modular environments with landmarks, traversal and measured runtime budgets."
license: MIT
---

# Terrain and modular world building

## Establish scale and composition
Define traversable area, movement/camera, focal landmarks, boundary treatment and art direction. Use a blockout and representative scene before large procedural scatter. Tie terrain and architecture to intended play rather than decorating an empty square.

Create reusable modules with compatible grids, pivots and material scale. Vary form and silhouette purposefully; random rotations of the same asset do not create identity. Foliage/debris density follows sightlines, paths and target-device measurements.

Keep interactive collision separate from visual detail. Streaming and distant representation need actual engine behavior tests; a file named LOD does not make automatic switching happen. Preserve editable source and placement seeds/manifests.

## Build fast in Studio
- Ground: `terrain_generate` (seeded landforms, a flattened clearing under landmarks, paths, rivers, lakes); `environment_apply` only for simple fills, lighting and atmosphere.
- Original assets by default: authored Blender/procedural geometry, previewed before adoption. Only if the user explicitly requests Toolbox models may `studio_asset_search`/`studio_asset_insert` supply them. Reuse original templates with `scene_build` + scatter. Primitive prototypes suit architecture or explicit stylized/blockout work; they are not a silent substitute for a requested realistic finish.
- Repeated objects: `scene_build` prototypes and scatter, a few calls rather than one per part. Natural placement only: Poisson-disk spacing with clusters and clearing falloff, scale jitter around ±25% and random yaw. Never place foliage in rings, grids or rows.
- Check the result with `studio_viewport_capture`. Concrete recipes: `arcane-natural-scenes` and `arcane-architectural-features`; lighting moods, materials and real-world scale: `arcane-photoreal`.

## Verification
Traverse critical routes at avatar scale, inspect landmark readability and performance under representative density. Test terrain transitions, collision, stuck points and streaming boundaries.

## Complete the requested build
Keep a short internal acceptance list for each clause. A raised circular spawn needs a functional spawn, a circular visual treatment and supporting platform, a usable approach, and surrounding forest composition. Preserve the existing baseplate and project style unless terrain changes are requested. Reserve continuous routes with `scatter.avoidPaths` (`points: [[x,z], ...]`, full `width` in studs). Set `footprintRadius` from a conservative object/canopy extent at scale 1; clearance scales with each copy around the clearing, keep-out circles and paths. Check returned requested/placed counts; do not report a full forest from an underfilled scatter. Inspect at player approach height and in a wider composition view; repair floating props, clipping and blocked access before adding detail.

## Blender authoring boundary
- Models, UVs, textures and PBR are authored in local Blender. Do not use Studio AI generation. Check the actual exported materials and preview before import; on a failure give its stage and reason. A local export, flat color or reconstructed mesh alone does not prove a finished textured Studio asset.
