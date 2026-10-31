---
type: bug
project: Arcane
tags: [arcane, assets, uv]
---
# UV chart fallback

The exact retained oak from [[Sessions/2026-10-31 Native Asset Dispatch]] exposed an unsafe UV-engine fallback while investigating its authored bark warnings. The original authored mapping is still used; it was not replaced and its warnings remain open.

## Reproduction and correction

When centroid-based splitting cannot partition a rejected chart, the old fallback returns an unchecked planar projection. A retained 11-vertex, 15-triangle branch junction reproduces four reversed triangles through this path. The regression retains its actual coordinates and winding, verifies complete face coverage and unchanged geometry, and requires every returned chart to preserve orientation.

The correction partitions the rejected chart by stable face order when the geometric split fails. Both halves shrink until the normal single-face base case is reached. Freeform maps with any reversed triangle are rejected for subdivision; two-face maps no longer receive an unchecked projection. Valid chart paths, mesh geometry, material pixels and validation thresholds are unchanged.

All 22 local UV-engine cases pass, with no skips. The regression also passes with NumPy disabled. Native CI now runs this exact regression on both platforms, with fixture and UV-test changes included in workflow triggers. Fresh exact-source hosted/native acceptance is required before delivery.

## Whole-mesh measurements and remaining limitation

One original headless comparison reads the saved scene without changing it: geometry equality and original scene hash are retained. The old engine mapping produces 210 folded faces after float32 storage. A separate diagnostic preserves its original wrapper failure, then continues from the captured immutable mesh arrays. It identifies 205 folds before float32 storage across 20 freeform charts, establishing chart construction as the primary failure rather than precision alone.

With the correction, the same full bark mesh has zero double-precision folds. Float32 output retains five folded faces, zero mirrored faces, angle distortion 0.101727, P95 0.20553, density CV 0.11685 and stretched share 0.00757. Chart count rises from 316 to 673; smooth seam ratio is 0.161706 and visible seam share 0.479032. The five remaining precision failures still violate the unchanged periodic policy. This mapping is **not accepted or adopted** for oak, and no artistic acceptance is claimed without a later valid mapping and rendered material/normal-map review.

The original authored warning causes are separate: inlet-based repeats do not follow changing taper/flare/collar circumference, thin axes have excessive density, and ground caps use another projection. Exact exported-mesh analysis reproduces the original four warnings; junction-only fairing cannot solve the dominant scale mismatch. Continue the physical-scale mapping and final float32 investigation without weakening gates or replaying the completed native job. Studio was not operated.

[[Delivery/G05 Blender Quality]] · [[Operations/Current State]] · [[Operations/Next Session]]
