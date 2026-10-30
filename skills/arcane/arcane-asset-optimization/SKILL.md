---
name: arcane-asset-optimization
description: "Optimize Roblox-bound original assets against measured scene bottlenecks while preserving silhouette, UV/PBR quality, collision, deformation and actual LOD behavior."
license: MIT
---

# Optimize the cost that is actually limiting play

## Establish a representative baseline
Identify asset purpose, gameplay distance, target device and expected visible population. Count evaluated/exported triangles, instances, material slots, unique texture bytes, transparency coverage and animated complexity. Distinguish a manifest count from measured engine frame/load cost; fewer triangles alone do not prove faster play.

For a full environment, test a representative dense encounter or traversal view rather than one isolated mesh. For a single prop, define its share of the existing scene budget. Use explicit project targets and record the measurement conditions; do not invent universal Roblox hard limits or fill a budget just because it exists.

## Reduce with a preservation contract
Keep original Blender source and a reversible revision. Remove accidental duplicate/loose/interior geometry and unused slots first. Reduce subdivisions or bevel segments where they no longer affect the player-view silhouette. Compare hard edges, shading and UV seams after every destructive reduction; automatic decimation must not collapse attachment points, moving pivots or important deformation loops.

Reuse compatible material families/atlases and original templates when useful. Atlasing can trade draw/material cost for larger textures, padding and reimport complexity; evaluate the whole trade. Alpha foliage can be overdraw-bound even with few triangles. Remove unnecessary transparent layers, but preserve card/stalk attachment, canopy silhouette and supported alpha behavior.

Keep collision separate from visual detail. Make simple stable contact surfaces and clearance for movement, wheels, raycasts and interactions as required. Do not optimize a doorway by closing its passage or an interactable by removing its collision target.

LOD variants need actual supported consumption and switching. Choose transitions by projected detail and the player camera, retain roots/pivots/material compatibility, and inspect popping. A file named LOD1 or an arbitrary 50-percent triangle reduction is not a functioning distance system. If no switching route exists, report the variants as authored only.

## Verify after export and integration
Check evaluated normals, scale, axes, stable IDs, UV distortion/padding, map assignments and material factors on the real export. Original geometry, UVs and PBR remain Blender-authored; do not replace difficult content with unrequested Toolbox/free assets. Preserve separately owned runtime children on reimport.

Compare before/after at matched close, gameplay and distant views. Exercise collision and moving parts; play deformation extremes for rigs. Measure the same representative engine state/device before and after, including loading/memory or transparency cost where relevant. Check each advertised LOD appears under its intended conditions and survives state changes. Report numerical savings alongside any visible loss and unresolved bottleneck. A render-only audit can establish geometry observations, never mobile readiness or runtime performance.
