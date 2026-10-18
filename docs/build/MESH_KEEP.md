# Keep this mesh

Procedural Blender meshes (`assets_procedural` → stage → `assets_reconstruct_studio_import` → `assets_place_studio_import`) become MeshParts built from in-memory `EditableMesh`es (`AssetService:CreateMeshPartAsync(Content.fromObject(mesh))`). They exist only in that Studio session and vanish on reconnect, Play or reopening. Keeping one needs an asset ID owned by the person. **Keep this mesh** does that, only on the person's click and confirmation.

## Route chosen

Studio's own plugin upload API, not Open Cloud:

- `AssetService:CreateAssetAsync(editableMesh, Enum.AssetType.Mesh, {CreatorId, CreatorType = User, Name, Description})` uploads each retained `EditableMesh` to the account signed in to Studio (`StudioService:GetUserId`). This reuses the existing `plugin/src/AssetUpload.luau` uploader (latched attempts, never retried, IDs kept even when later steps fail).
- `AssetService:CreateMeshPartAsync(Content.fromAssetId(id))` (fallback `Content.fromUri("rbxassetid://id")`) creates the persistent MeshPart; Arcane copies name, size, CFrame, anchoring, collision, shadow, transparency, material and colour from the session part and swaps it in one undo recording.

Why: no API key to create, store or leak; the upload goes to the account the person is already signed in with; nothing calls Roblox web APIs from Arcane; the uploaded bytes are exactly the meshes already in Studio. Open Cloud (user API key, GLB/FBX upload, operation polling) stays unbuilt.

API shapes were checked against the official [AssetService reference](https://create.roblox.com/docs/reference/engine/classes/AssetService) on 2026-10-18 but **not** observed in a native Studio run. The plugin therefore probes them (`AssetPlacement.keepSupported`: both AssetService methods, the three enums and `Content.fromAssetId`/`fromUri`) and advertises the `asset.keep_mesh` capability only when every one exists. Without it the daemon refuses with "update Roblox Studio and the Arcane plugin; nothing was uploaded".

## Consent flow

1. The card button (chat asset card or Blender panel › Keep procedural meshes) sends one placed mesh id (transfer digest + Studio session) to the desktop host (`apps/desktop/electron/mesh-keep.cjs`) through `window.arcaneDesktop.meshKeep.keep`.
2. The host asks the daemon to prepare it (`POST /v1/mesh-keep/prepare`, human desktop bearer only; agent bearers are refused). The daemon reads a fresh `scene.upload_context` from the plugin for the signed-in user ID.
3. The host shows the trusted Arcane decision window (`trusted-dialog.cjs`): account (Roblox user ID), asset name, number of mesh uploads, place, and that it uses the person's upload quota, may wait for moderation and cannot be undone. Buttons: Cancel / Upload and keep.
4. Only on "Upload and keep" the host sends a fresh 32-byte single-use consent to the daemon over the private child-process IPC channel (`product-main.ts`), then calls `POST /v1/mesh-keep/start` with it. The renderer and models cannot reach that channel, so neither can start an upload. Consents expire after two minutes and are consumed on first use.
5. The daemon writes a durable intent receipt (`<state>/mesh-keep/receipts.json`, atomic write) **before** queueing `asset.keep_mesh`. The store admits that method only from `enqueueMeshKeep` (`MESH_KEEP_AUTHORITY` otherwise, including for MCP/agents and idempotent lookups); restore is refused.
6. The plugin re-checks that the signed-in Studio user is still the confirmed account, uploads each mesh (≤16), then swaps parts only when every mesh has an ID.

The AI can only suggest the button (`assets_place_studio_import` text). There is no auto-keep, no setting to make it automatic, and no retry.

The receipt file retains every recorded attempt within an 8 MiB / 8,192-record storage bound; saving never discards older outcomes. Reads validate the complete versioned record shape and reject oversized, linked, duplicate or malformed history. Writes use the existing checked atomic asset-state replacement. A storage failure leaves the previous file intact and prevents a new upload from being queued without its durable intent. A failed delivered command remains unknown until the person checks it. Confirmation expiry is checked again after asynchronous reads and immediately before queue admission.

## States shown on the card

| State | Meaning |
| --- | --- |
| Session only | Not kept; disappears on reconnect, Play or reopening. |
| Uploading / Swapping | Command in flight. |
| Kept | Uploaded and swapped; asset IDs listed. Save the place. |
| Uploaded | IDs exist but Studio could not load the mesh yet (processing/moderation). **Finish keeping** swaps without uploading again. |
| Partial | Some meshes uploaded, then a later one failed; model stays on session meshes. Needs "I checked my inventory". |
| Failed | Nothing kept. Roblox's own `CreateAssetResult` name is shown; quota/limit and moderation names get specific wording. |
| Unknown | Studio disconnected or did not answer during an upload. Check Creator Hub; "I checked my inventory" allows a new keep. |

## Limits

- One upload per mesh part (procedural assets are usually 2–4); at most 16 per keep. Each uses Roblox upload quota.
- Assets are owned by the signed-in **user**, never a group. In a group-owned experience the group may need permission to use them.
- Only the placed model whose session parts still exist is swapped. Clones already made from it with `scene_build` templates keep session meshes; re-clone after keeping.
- The Studio session that reconstructed the mesh must still be connected (Edit mode). After reconnecting the meshes are gone and must be regenerated and placed again.
- A receipt is what Studio reported. It does not prove Roblox finished processing or moderation.

## Verification status

Automated only, with fakes: store/policy/receipt validation and the daemon service with a real `StudioStore` and a simulated plugin; the desktop host with a fake dialog/fetch/IPC; the Luau keep path in the standalone VM with engine doubles (`tests/plugin/mesh-keep.test.mjs`); the renderer module in the browser UI suite. No Roblox API was called. A native Studio run (real upload, moderation and reload after reopen) has **not** been performed and remains the acceptance gate.

The plugin operation explicitly imports `AssetUpload` before binding the uploader to a retained reconstruction. `tests/plugin/mesh-keep-dispatch.test.mjs` exercises reconstruction ownership through the production operation and checks the module passed into its engine binding, using a simulated receiver and upload sink. It reproduces a missing import independently of the lower-level uploader tests. Standalone transfer fixtures also reject unloaded module references instead of silently substituting `nil`.
