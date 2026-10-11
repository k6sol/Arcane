---
name: arcane-materials
description: "Create and verify Blender-to-Roblox UVs, textures and materials at the asset's actual scale and supported engine settings."
license: MIT
---

# UVs, textures and engine look development

## Match the geometry and look
Inspect UVs, units, material slots, seams and intended lighting. Define map roles and texel density by asset importance and target devices, not maximum resolution for everything. Keep authored textures and revisions recoverable.

Procedural Blender materials may require baking before engine export. Verify channel/color-space conventions and actual supported Roblox material path. A texture generated independently of UVs is not automatically a usable texture set or seamless atlas.

Review wear/detail scale, normal strength, metal/roughness balance and alpha edges with controlled views. Do not use noisy grime to hide wrong forms or inconsistent material separation. Skin variants reuse compatible mapping where possible.

## Verification
Check distortion, overlaps when unintended, padding/bleed and resource budgets. Compare exported maps on the actual imported object under representative engine lighting. Missing channels and unsupported alpha settings are explicit limitations. Keep base geometry unchanged for a material-only task unless fixing a concrete artifact requires it.
