---
type: bug
project: Arcane
tags: [arcane, assets, uv]
---
# Deep UV refinement

The follow-up to [[Bugs/UV Chart Fallback]] traces the remaining five float32 failures to real UV collapse, not just a reporting formula. All five stored triangles have exactly zero signed UV area despite nontrivial 3D area. Their double-precision UV areas are tiny positive values. They belong to one 81-face chart admitted after the engine's depth-five quality escape.

## Correction and scope

Large charts keep the existing distortion and density-spread targets beyond five subdivision levels. Useful geometric splits remain; after five levels, a split putting over three quarters of the faces into one child uses balanced face-order halves instead. This bounds further stack growth while preserving strict rejection and useful spatial cuts. It does not relax UV thresholds, inflate individual UV faces, modify geometry or change material pixels.

A retained 46-vertex, 81-triangle fixture reproduces distortion 12.90284 against the existing 0.22 target at depth five. The correction passes the target and checks final float32 orientation, complete face coverage and unchanged geometry. A worst-case valid one-face-versus-rest partition exercises the stack bound with rejected solver candidates. All 24 local UV cases pass. The exact regressions are included in both native CI jobs; fresh source-specific hosted acceptance is required.

## Measurements and rendered review

The final same-mesh array comparison has zero errors or warnings in double precision and float32. A distinct actual Blender 4.5.3 LTS comparison also completes with zero UV errors/warnings, unchanged geometry, corner normals, texture pixels and original scene hash. Its final stored metrics are angle distortion 0.045565, P95 0.183818, density CV 0.076993 and stretched share 0.000235. Folded and mirrored face counts are both zero. The 1,516 charts have smooth seam ratio 0.216967 and visible seam share 0.489951.

These results remain distinct from an earlier unbounded-depth comparison and a rejected strategy that balanced every deep split. The latter fails its original validation before rendering; it is not relabelled successful. The final strategy retains useful geometric cuts and has its own completed original process and measurements.

The original and candidate four-view textured bark sheets were opened. Direct application of the engine mapping makes bark grain too broad and shows directional changes at branches. **The replacement mapping is not adopted for oak.** The authored bark warnings, canopy/branch quality and final artistic acceptance remain open. This source improves engine chart refinement; it does not claim that the tree is photorealistic, that every small chart is storage-safe, or that Studio import has been verified.

The preceding signed source0246396 passes all seven original component/package jobs41212168024 and both original native jobs41212167974. Those results belong to that source, not this follow-up. The installed runtime remains e813.

[[Delivery/G05 Blender Quality]] · [[Operations/Current State]] · [[Operations/Next Session]]
