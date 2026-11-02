---
type: bug
project: Arcane
tags: [arcane, assets, import]
---
# Mesh keep preparation

The procedural keep path previously cloned each appearance inside the placed-model swap loop. When the second appearance clone failed, the first mesh had already been replaced and the undo recording was committed. A two-mesh standalone Luau regression reproduces that failure against the original implementation.

All replacement properties and appearance clones are now prepared while the replacements remain detached. Each clone is owned before its next scope guard, and all preparation completes before opening the placement recording. A later clone failure or revocation after allocation leaves every original part, appearance and ownership record intact. Existing cleanup retires detached replacements and their appearance copies. Uploaded geometry IDs remain available for an explicit Finish keeping operation, which reuses them without another upload.

All 23 focused standalone Luau/compiler cases pass, including procedural keep/dispatch and converted/general placement. The new schedules cover second-clone failure, cleanup of an earlier prepared appearance, revocation after the final clone and explicit finish without reupload. These tests use engine doubles; no Studio operation or Roblox upload occurred. This change does not prove rollback after arbitrary publication failures or native upload/moderation/reload behavior.

## Publication rollback

A further two-mesh regression reproduces a second replacement parenting failure after the first replacement was already published. The procedural transaction now pins the original parts, appearances, mesh IDs and parents, checks them again after asynchronous preparation, and restores that exact ownership when synchronous publication fails. A source property edit during preparation refuses publication and preserves the person's edit.

Rollback checks the entire replacement set for changed ownership and unexpected children before restoring any part. If those checks or restoration fail, replacements are retained and the existing cleanup-failure fence blocks further commands; cleanup does not erase newly authored content. A failed recording close is never retried or reported as a successful keep. Safe rollback retains uploaded IDs for explicit Finish keeping without reupload.

The expanded 23-case standalone Luau/compiler selection passes without skips: it now includes the original publication counterexample, successful finish after rollback, failed recording close, an unexpected authored attachment and source editing during allocation. These controlled schedules strengthen publication failure handling; arbitrary native event ordering, recording behavior and native Studio/customer acceptance remain unverified.

## Remaining persistence work

Generated PBR images still remain session-only. The official [AssetService reference](https://create.roblox.com/docs/reference/engine/classes/AssetService/CreateEditableMesh) lists EditableImage with Image as a supported CreateAssetAsync pair. Extending Keep requires an exact image upload plan, explicit image counts in trusted consent, durable per-image outcome attribution and persistent appearance rebinding. The current geometry-only consent must not silently authorize additional uploads. Native engine availability and customer acceptance remain unverified.

[[Delivery/G06 Connected Import]] · [[Operations/Current State]]
