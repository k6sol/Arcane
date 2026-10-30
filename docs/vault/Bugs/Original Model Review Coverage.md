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

Implemented candidate:

1. During the original tree job, render one bounded structure sheet from its finalized mesh objects. Do not create another job, rebuild the tree, change the seed, or replace it with a leaf-density-zero generation.
2. Resolve exact expected source identities/roles, hide only the validated leaves render object, keep actual bark visible and collision/LOD/helpers hidden. Add no synthetic twigs or people.
3. Snapshot and restore visibility and camera state in `finally`; verify unchanged geometry, UV/material and source identities before original save/export. Membership or restoration failure must be explicit.
4. Retain the sheet and bounded metadata in the original manifest, tied to final request/geometry/export hashes. Serve through the existing retained-read/hash path and a fixed view enum. Old or unsupported jobs report unavailable; never regenerate their source implicitly.
5. Verify genuine multi-angle/root/fork images plus negative membership, visibility, image/metadata-hash, old-job and size-limit cases. These views inform human review; they confer no approval, attachment proof or import authority.

Status: same-job renderer, strict manifest/file binding, fixed preview API and desktop display are implemented as a candidate. All 644 product sources compile; 98 affected TypeScript cases, nine controlled worker cases, 40 skill cases and two generated-tool-document checks pass. Native rendering/color/framing and hosted acceptance remain pending. The provider authoring capability gap remains open. No Studio operation or artistic approval is established.

New natural-tree production jobs must emit the structure view before publication. Historical jobs can remain two-view jobs; a read never regenerates them. Rendering failures retain the review-render stage and fixed structure filename in the existing finite diagnostic protocol. The nature skill requests the view without changing its experimental status or context budget. Hosted native verification now includes the real original tree pipeline and retained review images on both platforms.

## Headless rendering correction

The first actual original job on `6bb9336` failed at the structure render; its three original workers closed with observed exits. A read-only diagnostic against an existing completed tree reproduced the specific Blender 4.5.3 behavior: rendering succeeded while Render Result exposed zero dimensions/channels/pixels through Python. The candidate now transfers each tile through one owned scene-linear FLOAT RGBA OpenEXR, with bounded size/header/dimensions, exact temporary-file identity and settings restoration/cleanup. It applies the display transform once when saving the final sheet. See [Blender Image API](https://docs.blender.org/api/4.5/bpy.types.Image.html) and [color-management implementation](https://developer.blender.org/docs/features/render_pipeline/color_management/).

All 13 controlled review tests and three safe-classifier tests pass. The corrected read-only native diagnostic produced a real 512-square four-view sheet; it was visually inspected. That verifies the render bridge, not a newly completed original job. Full original generation/export/reopen and hosted Blender 5.2 Windows/Linux checks remain pending. Existing models still lack artistic acceptance; the structure view exposes remaining branch/canopy problems rather than fixing them by itself.

Related: [[Delivery/G05 Blender Quality]], [[Bugs/Original Asset Authoring]], [[Bugs/Forest Blender Workflow]].
