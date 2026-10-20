---
name: arcane-blender-props
description: "Author game-ready Blender props and mechanical models from references with controlled silhouette, scale, moving parts and engine validation."
license: MIT
---

# Reference-driven Blender props

## Define a modelable brief
Read references, intended use, dimensions, viewpoint and moving/interactable components. Mark essential silhouette and proportion relationships; resolve missing dimensions with transparent assumptions rather than silently inventing a complex design.

Create primary/secondary blockout forms and fixed review views before small fasteners/wear. Build mechanical separations as actual named geometry with sensible pivots, not texture illusions. Bevels/normals and material variation must work at expected game scale.

Use reproducible scripts or modifiers where they improve iteration; preserve a source file/checkpoints. Validate transforms, degenerate geometry, names, UV requirements and chosen budgets. A material-only change does not fix poor geometry.

## Verification
Render multiple controlled views and check measured dimensions. Export through a verified target route, inspect axis/scale/materials in Studio and test interaction clearance. Keep approved geometry stable during revisions. Do not call a beautiful render an imported, usable asset.

## Model specs in Arcane
For an original object without a dedicated generator, describe it as a part graph: `assets_procedural` with `generator.kind:"spec"`. Load the format first (`skills_get` arcane-blender-props with reference `arcane-blender-props:model-spec`). Build, read the review sheet and metrics from `assets_preview`, adjust the spec and rebuild; the compiler handles welds, budget, normals, pivot, UVs and PBR.
