---
name: arcane-asset-optimization
description: "Validate and optimize Roblox-bound Blender assets for measured budgets, collision, material cost and verified LOD consumption."
license: MIT
---

# Asset QA, collision and LODs

## Optimize the relevant bottleneck
Read asset purpose, silhouette importance, target devices and measured scene load. Count geometry, materials, textures, transparency and animated complexity, but do not treat one number as overall performance.

Preserve primary forms and important deformation when reducing detail. Author simple collision proxies/clearance independently of render mesh. LOD levels need a supported engine switching path; names or exported files alone are not runtime integration.

Check normals, UVs, transforms, stable IDs and moving pivots after optimization. Avoid destroying hand-authored textures or animation compatibility during automatic decimation. Retain the source and compare revisions.

## Verification
Inspect silhouette and material appearance at actual gameplay distances. Traverse/interact against collision and measure representative engine cost. Verify each advertised LOD appears under the intended conditions. Report budgets as project targets, not invented Roblox hard limits, and never claim mobile readiness from a render alone.
