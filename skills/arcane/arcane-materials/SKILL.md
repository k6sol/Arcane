---
name: arcane-materials
description: "Author and validate original Blender UV layouts, texture sets and PBR materials with correct channel semantics, useful detail scale and actual Roblox import checks."
license: MIT
---

# Surface authoring with a verified material contract

## Inspect the actual asset
Read geometry, units, UV layers, material slots, target camera distances and style before painting. A material-only request preserves approved geometry unless a concrete UV/topology defect prevents the result. Retain editable Blender sources and texture revisions.

Assign material families by construction: exposed metal, paint, wood end-grain, stone faces, cloth or foliage should respond differently for a reason. Choose resolution and material count from visible size and measured budgets, not maximum maps on every object. Do not cover wrong proportions with grime.

## Build UVs and useful maps
Choose seams at construction boundaries or less-visible regions, consistent orientation for directional grain, and intentional mirrored/repeated islands. Check distortion with a known-size checker and compare pixels across a UV span to the corresponding world length. Shared atlases need padding appropriate to filtering and the actual target distance. Smart projection is an available starting point, not proof that important faces have usable UVs.

Models, UVs, textures and PBR are original Blender work. Bake supported procedural shading into exportable images when needed. A free/downloaded material or texture set requires an express user request; do not invent asset IDs or source licences.

Declare each channel's meaning and colour space: base colour uses colour interpretation; roughness, metalness and tangent normal data must not be colour-corrected as albedo. For glTF packed metallic/roughness, verify roughness in G and metallic in B and the actual material factors. Avoid applying those factors twice when a route converts maps. Check the target normal convention and tangent basis instead of fixing inverted dents with arbitrary strength.

Keep albedo separate from strong painted lighting unless the chosen style deliberately requires it. Wear follows edges, use, moisture and material layers; roughness variation should explain surface behavior rather than generate uniform noise. For foliage/cutouts, check the intended alpha mode, tile orientation, filtered edges, root coverage and atlas bleed.

## Integrate and review
Use only the actual advertised material/import capabilities and bounded supported map formats. An unsupported shader channel is a precise limitation, not a reason to claim the missing effect survived. A reconstructed mesh or flat material factor alone does not prove a textured engine asset. Editable image maps can remain session resources even when geometry is kept; do not imply durable PBR publication.

Compare a neutral-lit exported object with representative engine lighting, then inspect close and gameplay-distance views. Detect UV stretching, seams, mirrored normal errors, wrong grain scale, metallic non-metals, lost alpha, tiling repetition and map/factor mismatch. Read actual exported resources and mapped UVs, not just filenames or a shader screenshot. Report texture/material cost, supported channels, visible results and remaining import/persistence limits.
