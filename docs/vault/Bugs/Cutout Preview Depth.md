---
type: bug
project: Arcane
tags: [arcane, blender, preview, foliage]
---
# Cutout preview depth

The retained oak preview had black patches among overlapping leaf sprays. A single-thread CPU comparison in actual Blender4.5.3 isolated two candidate causes without saving the retained scene. Original process exit and both pipe EOFs are observed; the source scene hash remains unchanged. No Studio operation occurred.

## Measured cause and correction

Changing authored normals to geometric or hemisphere-oriented normals did not visibly remove the clumps, so production normals remain unchanged. A separate comparison held geometry, UVs, normals, materials, camera, lights,512px resolution and16 samples fixed while varying transparent-ray depth8/32/64. Closed cards consume front and back intersections. At the default depth8, layered cutouts turn black before rays reach the sky. Depth32 visibly reduces those patches; the32-to64 comparison changes only21 pixels by more than30 summed RGB byte levels, versus3,892 for8-to32. This is evidence for the bounded preview setting, not a universal convergence guarantee.

Before, depth8:

![[Assets/Reviews/2026-11-02 Cutout Depth 8.png]]

After, depth32:

![[Assets/Reviews/2026-11-02 Cutout Depth 32.png]]

Production `asset_worker.lookdev` now uses32 transparent bounces only when an authored `Arcane_AlphaClip` node is connected to an Alpha socket. Opaque previews and unused cutout nodes use8. The full-module native policy test passes connected-cutout, unused-node and opaque-reset cases while preserving source geometry, requested samples and resolution. The existing material-slot, diagnostic and four oak-spray cases also pass in local Blender4.5.3. New hosted Blender5.2.3 and packaged checks are still required for this follow-up.

## Scope

The controlled renders use the retained6m seed73129 scene, not a new export of the current generator. The image comparison changes one render setting and preserves the source file; it does not fix geometry or prove whole-tree quality. Leaf scale, crown distribution, branch detail, rock realism and final stalk-surface checks remain open. Converted-model previews now independently select32 only from MASK/BLEND materials referenced by the exact source-to-part mapping. Default/explicit OPAQUE, unassigned and unused materials stay at8; invalid references refuse rather than guessing. All73 conversion fidelity policy cases pass. A full-module Blender4.5.3 fixture exercises both actual conversion preview renders at128px/four samples for each policy, retaining geometry and material graphs. This is actual renderer evidence, not a new complete conversion/import or hosted5.2 acceptance. Model-spec review retains a separate policy and remains open. No global triangle, sample, file, request, worker or timeout cap changes.

The preceding signede66 source has all seven original component jobs passing in [run41368322342](https://github.com/k6sol/Arcane/actions/runs/41368322342), plus both native jobs in [run41368322324](https://github.com/k6sol/Arcane/actions/runs/41368322324). Those results do not verify this newer preview-policy edit. The separate prepared chat7d update still awaits sufficient installation memory.

[[Sessions/2026-11-02 Native Foliage Review]] ? [[Delivery/G05 Blender Quality]] ? [[Operations/Current State]]

Shared review PNGs omit text/EXIF metadata; original evidence remains private. Pixel and color-management chunks are exact. Current copies do not include source-path tags. Earlier Git commits were not rewritten.
