---
type: bug
project: Arcane
tags: [arcane, blender, foliage, geometry]
---
# Tree canopy attachments

The exact seed-31 oak disproved complete tip-queue starvation: its 322 cards included 126 tip, 120 shell and 76 interior cards. Source fitting instead discarded all 48 initially retained tertiary branches under a fixed wood partition. In the retained actual GLB, all 2,576 leaf positions matched the pure plan; 110 card roots were over 10 cm from the nearest outward-oriented bark surface. This is geometry evidence, not visible alpha-contact or artistic acceptance.

The correction jointly reserves bounded foliage and union capacity, then allocates wood detail per axis before pruning. It retains trunk/scaffold detail and real smaller branches. Canopy selection uses a bounded interleaved prefix so restoring branching does not consume the entire leaf budget at tips. Cards bind to actual outer branch-ring vertices and retain those identities through one original variant deformation and complete-card damage. A bounded native check projects against this same build's final union/fallback bark; all local adjustments must pass before any card changes.

Exact pure result: 33 retained tertiary branches, 322 emitted-skin roots, conservative 14,322/16,000 triangles; tip/shell/interior cards 66/191/65. The 24-side trunk is preserved. Existing bare/conifer fitting and unrelated generators keep their routes. No invented connecting rods or global trunk snap is added.

Verification: six focused cases, four existing quality cases and seven existing variation cases passed. The full 38-case generator run passed every functional coverage/contact/budget/UV/species assertion; two methods exposed intentional positive-tree count baselines and the new import spelling. Only those count literals/import spelling were corrected, then both affected methods passed. All assertions remain. Parent compilation passes 644 sources; 19 error/reporting cases and three Python classifier cases pass. `FOLIAGE_ATTACHMENT` is a finite stage-aware failure in local recovery and the central diagnostics contract.

Native union/BVH, exported geometry, visible alpha contact and art acceptance remain pending. The separate hosted Blender 5.2 mesh-audit failure in [[Bugs/Original Model Review Coverage]] is not yet diagnosed or claimed fixed by these pure results. Studio remains untouched.

## Actual local production and export verification

Signed `34863c1` completed the exact CI tree request in local Blender 4.5.3: 10,252 bark and 3,864 leaf triangles, 14,116 total within the unchanged 16,000 budget. Original union/fallback attachment, UV/PBR, all three previews, GLB/FBX, round-trip/reopen and host validation passed, with three observed original worker closures. A separate deep check reproduced the saved scene's exact audit. Hero, side and leafless structure images were inspected.

Independent actual-export inspection proved 322-card UV/geometry/topology bijections before and after, without exporter-order assumptions and with the native per-card translation accounted for. Previously 110 roots were over 10 cm outside bark; now all 322 exported basal midpoints are within 1 micrometre of actual bark (maximum 0.142 micrometres). Before/after GLB digests end `7719a96` and `8029ef5`. Both bark meshes have closed, consistently oriented edge incidences, one component and positive volume. Three agreeing non-edge ray parities established outside status; unsigned interior distances are not called floating.

This proves the measured geometry contact, not visible alpha/petiole contact or artistic acceptance. The new model retains seven folded bark faces and angle/stretch/density warnings, with zero mirrored bark faces; no gate was relaxed. The earlier Blender 5.2 failure remains unproved until fresh hosted verification. No Studio operation, import, upload, app restart or model approval occurred.
