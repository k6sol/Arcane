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
Choose the route from the requested geometry, proportions, materials and moving parts. Use `assets_start` custom assemblies/closed meshes or `assets_procedural` generators/specs when their bounded representation can faithfully express the brief. A missing dedicated generator does not make a stock assembly or a different scene an acceptable substitute.

For a faithful part graph, use `assets_procedural` with `generator.kind:"spec"`. Load its declared format first with `skills_get`, ids `["arcane-blender-props"]`, references `["arcane-blender-props:model-spec"]` and `allowExperimental:true`. This is the bundled recommendation policy's explicit opt-in to experimental guidance, not skill approval or execution permission. Build, inspect the review sheet and measured metrics from `assets_preview`, then refine the geometry/spec; material tweaks alone do not fix a wrong silhouette.

When the actual native client has filesystem/process capabilities, current workspace permission for authoring, and advertised native GLB tools, author original geometry, UVs and PBR in Blender from the brief/references. Retain the original source/checkpoints and export an owned project-relative GLB with embedded resources. Use `assets_adopt_glb` for that file, then `assets_convert_glb` for the managed adopted parent. Preserve the original workspace/conversation scope and unsupported-conversion refusals; do not weaken validation, re-adopt or replay after an unknown acknowledgement. Inspect `assets_jobs` in the same scope instead. Conversion completion is neither human approval nor Studio acceptance; follow exact-model human review and the existing host-scoped delivery flow.

MCP-only clients do not gain shell, Python or Blender execution from this skill. If no faithful bounded recipe and no permitted native authoring route are available, report that concrete capability limit. Do not silently replace the requested object with a forest, template or Toolbox asset; Toolbox models still require an explicit user request. Preview and actual engine evidence must support any quality or import claim.
