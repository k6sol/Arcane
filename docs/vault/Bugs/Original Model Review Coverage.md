---
type: bug
project: Arcane
tags: [arcane, blender, quality, previews]
---
# Original model review coverage

Source audit on `771b31d` found two distinct gaps. Neither establishes the cause of the original Sol forest failure.

## Authoring capabilities differ by provider

The in-app Claude adapter launches with no general native tools (`apps/desktop/electron/claude-chat.cjs`, actual `--tools ''` launch); Arcane Credits exposes Arcane MCP tools rather than file/process tools (`arcane-chat.cjs`). Their authoring inputs are bounded generator/spec/recipe data. Adopting and converting an existing project GLB does not author a missing original source. Regular native Codex retains workspace file/process capabilities and has a different route.

Required outcome: original asset work must have a real authoring capability appropriate to each provider. A clearer refusal is not the finished capability. Keep native process/code authority explicit; do not turn untrusted model text into unrestricted host execution or claim that a recipe can express any requested object.

## Exact-job tree structure review

The nature skill asks for leafless multi-angle, root and fork inspection, but production `workers/blender/asset_worker.py` renders hero and side only. The fixed `assets_preview` enum and daemon retained-read allowlist expose those two manifest-hashed images. Native foliage harness views do not certify the full generated tree's actual branch structure.

Proposed next implementation:

1. During the original tree job, render one bounded structure sheet from its finalized mesh objects. Do not create another job, rebuild the tree, change the seed, or replace it with a leaf-density-zero generation.
2. Resolve exact expected source identities/roles, hide only the validated leaves render object, keep actual bark visible and collision/LOD/helpers hidden. Add no synthetic twigs or people.
3. Snapshot and restore visibility and camera state in `finally`; verify unchanged geometry, UV/material and source identities before original save/export. Membership or restoration failure must be explicit.
4. Retain the sheet and bounded metadata in the original manifest, tied to final request/geometry/export hashes. Serve through the existing retained-read/hash path and a fixed view enum. Old or unsupported jobs report unavailable; never regenerate their source implicitly.
5. Verify genuine multi-angle/root/fork images plus negative membership, visibility, image/metadata-hash, old-job and size-limit cases. These views inform human review; they confer no approval, attachment proof or import authority.

Status: source audit and implementation proposal only. No new review renderer, provider authoring capability or actual Studio acceptance was implemented by this audit.

Related: [[Delivery/G05 Blender Quality]], [[Bugs/Original Asset Authoring]], [[Bugs/Forest Blender Workflow]].
