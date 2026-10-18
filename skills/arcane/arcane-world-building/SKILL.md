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
- Trees, rocks, foliage and props: `studio_asset_search` free Creator Store models, `studio_asset_insert` one per kind into a template Folder (scripts stripped), then clone them with `scene_build` templates + scatter. Generate a mesh only when nothing fits; use primitive prototypes for exact-dimension architecture, blocky styles or when assets are unavailable.
- Repeated objects: `scene_build` prototypes and scatter, a few calls rather than one per part. Natural placement only: Poisson-disk spacing with clusters and clearing falloff, scale jitter around ±25% and random yaw. Never place foliage in rings, grids or rows.
- Check the result with `studio_viewport_capture`. Concrete recipes: `arcane-natural-scenes` and `arcane-architectural-features`; lighting moods, materials and real-world scale: `arcane-photoreal`.

## Verification
Traverse critical routes at avatar scale, inspect landmark readability and performance under representative density. Test terrain transitions, collision, stuck points and streaming boundaries.
