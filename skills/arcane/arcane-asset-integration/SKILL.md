---
name: arcane-asset-integration
description: "Validate and import Roblox models, textures, audio and animations while preserving ownership, stable mappings and gameplay children."
license: MIT
---

# Ownership-aware assets and reimport

## Prove the actual route
Inspect format, creator context, target universe and supported upload/import capabilities. Model/package return values and raw mesh IDs are not interchangeable. Use a small asymmetric fixture to prove hierarchy, axes, scale and materials before processing a large batch. In live Studio, Creator Store models go through `studio_asset_search` + `studio_asset_insert` (free only, scripts stripped, fitted, grounded, one receipt); local meshes only through the advertised `assets_*` import tools and their returned proofs.

Record source/export hashes, logical object IDs, pivots, moving pieces, collision data and licences in a manifest. Reuse unchanged uploads only within valid ownership/permission scope. Do not consider operation completion equivalent to moderation approval or actual loading.

Update the existing mapping; preserve separately owned scripts, attachments and constraints. Removed source objects require deliberate handling, not blind deletion. Quarantine/review inserted marketplace scripts before enabling them.

## Verification
Inspect measured bounds and multi-view engine captures, interact with the imported object and test a changed-only reimport. Simulate permission failure, interrupted operation and deleted/reparented children. Reconcile existing operation IDs before retry. Publishing follows the user's policy and required rights certification.
