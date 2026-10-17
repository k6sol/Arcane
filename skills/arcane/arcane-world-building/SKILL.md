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
Use environment_apply for Terrain ground, hills and paths, then scene_build prototypes and scatter for repeated objects (a few calls, not one call per part). Natural placement only: Poisson-disk spacing with clusters and clearing falloff, scale jitter around ±25% and random yaw. Never place foliage in rings, grids or rows. Load arcane-natural-scenes or arcane-architectural-features for concrete recipes, and arcane-photoreal for lighting moods, materials and real-world scale.

## Verification
Traverse critical routes at avatar scale, inspect landmark readability and performance under representative density. Test terrain transitions, collision, stuck points and streaming boundaries. Do not inherit a specific abandoned-town or industrial brief when the project is a bright racing/social/cozy experience.
