# Sentinel camera custom assembly QA

**Current craft verdict: SHIP WITH NOTES for the corrected local static prop.** Attempt-03 resolves the known concave-cap and within-part UV overlap defects. This is a reviewed custom assembly with actual scene, mesh exports and renders. Target-engine/Roblox acceptance, animation and premium release certification remain unverified.

Both actual attempt-03 hero/profile PNGs were opened with the image tool. The inset round lens and red status light remain clear; graphite housing, warm gray frame, purposeful fasteners, visor and open mounting bracket retain the accepted silhouette. The rear cap, connector and angular cable provide a distinct side profile. The parent independently reviewed both attempt-02 PNGs and, on 13 October, both final attempt-03 files (`preview-hero.png` and `preview-side.png`). They retain a clear compact static-prop silhouette and distinct side detail. This is not a numerical quality score, reference-matching guarantee, rig/animation test, or target-engine import acceptance.

## Exact measured budgets

| Measure | Actual | Limit | Result |
|---|---:|---:|---|
| Width, X | 0.297999978 m | 0.55 m | Pass |
| Depth, Y | 0.391998127 m | Compact brief | Recorded |
| Height, Z | 0.322999984 m | Compact brief | Recorded |
| Render triangles | 5,300 | 6,000 | Pass |
| LOD triangles | 408 | 500 | Pass |
| Collision triangles | 60 | 150 | Pass |
| Asset materials | 6 | 6 | Pass |
| Sockets | 2 | Same two requested | Pass |

Measured counts agree between the saved scene and real exported GLB accessors: 40 render meshes, 13 LOD meshes and five convex collision meshes. Conservative preflight remains 5,460 / 408 / 60 triangles. The preview ground material is excluded from all asset exports and material budgets.

## Terminal real-job evidence and outputs

Attempt-03 job `5814c698-2b62-4229-9cf2-4d0208129970` reached **succeeded**. Generation worker PID 34828 exited 0 at `2026-10-13T13:48:51.978Z`; host manifest validation completed at `2026-10-13T13:48:53.584Z`. There was exactly one new generation job in this separately authorized follow-up. The capability probe and generation were sequential, with at most one active Blender process.

- Final data-only JSON recipe (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/camera-recipe.json`, local evidence, not committed)
- Actual manifest (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/manifest.json`, local evidence, not committed) and native audit (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/audit.json`, local evidence, not committed)
- Saved Blender scene (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/asset.blend`, local evidence, not committed)
- Render GLB (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/asset.glb`, local evidence, not committed) and render FBX (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/asset.fbx`, local evidence, not committed)
- LOD GLB (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/asset-lod1.glb`, local evidence, not committed) and collision GLB (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/collision.glb`, local evidence, not committed)
- Actual hero PNG (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/preview-hero.png`, local evidence, not committed) and actual profile PNG (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/jobs/sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970/preview-side.png`, local evidence, not committed)
- Terminal run proof (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/run-proof.json`, local evidence, not committed) and final review receipt (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/final-review.json`, local evidence, not committed)

Both review images are actual 768 x 768 Cycles CPU renders at 32 samples, with finite pixel checks and validated artifact hashes. Absolute Windows paths for parent review:

```text
C:\Users\alexk\OneDrive\Documents\GitHub\Arcane\runtime\verification\custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c\attempt-03\jobs\sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970\preview-hero.png
C:\Users\alexk\OneDrive\Documents\GitHub\Arcane\runtime\verification\custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c\attempt-03\jobs\sentinel-camera-5814c698-2b62-4229-9cf2-4d0208129970\preview-side.png
```

## Corrected caps and unchanged style

The literal new repair purpose is **correct concave yoke cap triangulation by robust ear clipping**, separately authorized after the completed original one-repair task. Each seven-vertex coplanar outline is triangulated into five ears; the existing cap center is inserted into its strictly containing ear, yielding the same seven triangles per cap. Filled cap area matches polygon area within 1e-12 m2. Original vertices, center positions, outlines, side triangles, dimensions, materials, sockets, LOD and collision remain unchanged.

Recipe comparison proves that only the two render yoke arms' cap index buffers changed. Native exported geometry hashes also change only for `SM_yoke-arm-left` and `SM_yoke-arm-right`; every mesh's triangle count and bounds remain identical to attempt-02. Evidence: recipe delta (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/recipe-delta.json`, local evidence, not committed) and exported geometry delta (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/exported-geometry-delta.json`, local evidence, not committed).

The independent cap checker reports **zero positive-area coplanar cap overlaps at the original >1e-12 m2 threshold**. The independent UV checker reports **zero positive-area within-part UV overlaps across every render and LOD part at the original >1e-10 unit-UV-area threshold**. Checker algorithms were reused unchanged; only paths were redirected and strict zero-finding assertions appended. Both checks exited 0. No tolerance was widened. Evidence: cap verification (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/yoke-cap-verification.json`, local evidence, not committed), export/UV verification (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/export-verification.json`, local evidence, not committed), checker provenance (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/checker-provenance.json`, local evidence, not committed), cap terminal log (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/cap-check.log`, local evidence, not committed) and export terminal log (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/export-check.log`, local evidence, not committed).

## Geometry, UV, PBR, export and socket checks

Native structural audit passes with zero non-manifold edges, loose geometry, duplicate vertices/faces, degenerate faces, inconsistent normals or inverted components, plus finite positions and applied transforms. The independent GLB checker confirms finite positions, unit normals, winding/normal agreement, exact triangle counts, named roles, asset bounds and support-base floor origins. The known coplanar cap defect is now explicitly checked and resolved; an exhaustive arbitrary self-intersection/inter-part penetration audit is still outside these checks.

All render/LOD meshes have finite, complete, nondegenerate UVs in 0-1. Per-part UV area occupancy is approximately 23.48%-96.59%; there is no texture atlas or controlled texel-density specification. Separate parts intentionally share UV space because this asset uses constant PBR factors.

All six actual GLB PBR factors and the lamp emission match the recipe. Graphite/warm-gray surfaces are dielectric painted finishes, steel is metallic, rubber is matte, and the lens is an opaque coated-optic approximation. No textures or external asset dependencies are used. The recipe does not express glass transmission or advanced shader/custom-normal control.

Actual render GLB, FBX, collision GLB and LOD GLB are reimported by the fixed worker with matching triangle counts and finite positions. The saved scene is reopened and re-audited; all four export round trips and saved-scene checks pass. Host validation and finalization recheck every manifest artifact's size and SHA-256 hash.

All five collision meshes are independently convex. None contains the checked open-yoke point `(0, 0.025, 0.12)` metres. LOD retains a real front cavity, with the lens face approximately 0.011 m behind the front frame. LOD/collision receive numeric checks; the two fixed renders depict the render model.

| Node | Parent | Scene position, metres | Meaning |
|---|---|---|---|
| `SOCK_swivel-axis` | `SM_tapered-housing` | `(0, 0.025, 0.219)` | Transverse swivel axis |
| `ATT_lens-axis` | `SM_coated-lens` | `(0, -0.137, 0.230)` | Forward lens attachment |

Both sockets pass saved-scene and GLB/FBX evidence checks. Independent GLB parent and world-transform checks have maximum matrix delta approximately 1.344e-7. Scene units are metres, Z up; GLB/FBX are Y up. Sockets are metadata; no rig or animation was created.

## Retained history and authorization bounds

The original task had two generation attempts and exactly one permitted repair. Attempt-01 succeeded at 5,300 / 308 / 36 triangles. Its one repair produced attempt-02 at 5,300 / 408 / 60 by replacing the broad yoke collision volume with separate proxies and authoring the LOD lens recess. That original repair limit remains exhausted.

The parent then explicitly authorized **ONE new bounded follow-up asset iteration** solely for the known cap defect. Attempt-03 is that one job, with zero further follow-up repairs. The admission record (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/admission.json`, local evidence, not committed) and follow-up brief (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/followup-brief.md`, local evidence, not committed) preserve this distinction. Total asset generation attempts across both authorizations: three. Nothing in the original task's limits, failure receipts or final review was overwritten.

Attempt-02's first independent export checker failed its UV assertion `2 !== 0`, exit 1; its later diagnostic found two UV-overlap pairs on each arm and 12 coplanar cap-overlap pairs. That was a host verification failure, not a native export failure. All earlier native jobs succeeded. The separate pre-job host preparation failure is also retained. Historical evidence:

- First export-check failure (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/export-check-failure-01.json`, local evidence, not committed)
- Attempt-02 UV/PBR/export evidence (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/export-verification.json`, local evidence, not committed)
- Attempt-02 cap defect evidence (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/yoke-cap-verification.json`, local evidence, not committed)
- Original attempt-01 run proof (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/run-proof.json`, local evidence, not committed) and original repair run proof (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/repair-01-run-proof.json`, local evidence, not committed)
- Original final review receipt (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/final-review.json`, local evidence, not committed)
- Pre-job host preparation failure (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/host-preparation-failure.txt`, local evidence, not committed)
- Literal prior QA document snapshot (`runtime/verification/custom-camera-c7d52bd6-880c-4a9b-8551-3c8001e5f40c/attempt-03/prior-CUSTOM_CAMERA_QA.md`, local evidence, not committed)

## Scope and craft notes

The current trusted pipeline/worker source hashes and existing compiled host-runtime hashes matched the prior verified runtime before launch and remained unchanged. Blender 4.5.3 LTS / Python 3.11.11 ran the bundled fixed worker with `--background --factory-startup --disable-autoexec --threads 2 --python-exit-code 1`, Cycles CPU, sanitized environment and no concurrent Blender process. Spawn arguments, stdout/stderr, process IDs and terminal exits are retained.

This follow-up wrote only its owned runtime tree and this QA document. No production worker/API/tests/TypeScript source, board, scripts or bundles changed. No GUI, Studio, network/API call, provider inference, upload or installation ran. The data-only recipe contains indexed geometry and parameters; no arbitrary Python was submitted.

**SHIP WITH NOTES applies to the local static custom prop and its exported geometry.** The compact industrial silhouette, inset lens, red lamp, mount and rear profile remain readable in both actual renders. The angular cable and restrained faceting fit the established game-stylized direction. Notes: opaque lens approximation, untextured PBR factors, per-part UVs without a texture atlas, numeric-only LOD/collision review, and no target-engine material/scale/collision/motion validation. The earlier cap/UV NO-SHIP reason is resolved. Roblox import, animation and premium release acceptance are not claimed; the automatic manifest's artistic/Roblox fields remain unchanged.
