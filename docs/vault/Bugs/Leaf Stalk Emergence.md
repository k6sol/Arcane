---
type: bug
project: Arcane
tags: [arcane, blender, foliage, quality]
---
# Leaf stalk emergence

A read-only review of the retained native oak confirms opaque stalk penetration while the existing root-contact protection remains intact. The exact GLB hash is `3ad6218d111f8819e9b40d636678154ab50a55fd049d2d99e098f562750ddbaa`; the retained procedural source hashes to `fdf316586f8b57d127c424fa84908ba5a76940092fabaa59ab09901ce7567939`.

The mesh contains322 separate leaf cards. At1% card height,14 have both actual front/back center-stalk points opaque and inside bark by three agreeing ray parities. Independent solid-angle winding and nearest-triangle checks confirm card38: root distance is zero, but opaque points7.76mm along the stalk lie3.89–3.91mm inside closed, consistently oriented bark. Card122 independently shows0.57–0.66mm penetration. Texture-V and far-outside winding controls distinguish this result from sampling or open-mesh artifacts. These measurements do not establish how much of a rendered gap they cause, and do not prove full asset quality.

Source trace: the fan direction in `workers/blender/procedural.py` uses tangent/shell targets without an outward-skin constraint. Final attachment checks root distance and applies an atomic translation; the final bark BVH query discards its returned normal. Existing emitted-skin, rebind, local-displacement, topology, UV and budget protections must remain. Do not revive the already-fixed virtual-root diagnosis.

No tracked generator edit, model job, Blender run or Studio operation was performed. The internal Sol reviewer confirmed STARTED/FINISHED; the second private fixture task also confirmed FINISHED. The exact closed-bark/card/alpha fixture rejects wrong texture-V, open/inverted bark and detached roots. A roughly174-degree basal-edge rotation supplies a diagnostic outward positive control while preserving root contact and pairwise geometry, but is too large to adopt as a production correction. Next implement the smallest normal-aware emergence constraint, carrying the actual bark BVH normal and retaining the atomic contact protections. Preserve RNG draws, counts, UV/PBR data and budgets. Native closeup and whole-tree visual acceptance remain required; the current release candidate stays frozen.

## Initial fan correction ? November 2

The generator now derives an outward direction from each actual emitted branch ring. Before card construction, it keeps a sufficiently outward fan unchanged and constrains an inward/tangential fan to the owning ring's outward cone. This reuses the original random draws; it does not rotate the finished tree or move a card to a different branch. Rebinding refreshes the stored ring direction after variant deformation.

Seven production generator cases pass, including the new independent front/back stalk half-space check for oak/birch, seeds31/73129 and heights2/6/20. The complete38-case procedural generator suite also passes, including deterministic counts, legacy routes, manifold geometry and bark-cap UV checks. A separate four-plan original-source comparison confirms exact bark geometry, leaf topology/UVs/counts/canopy scheduling and final RNG states. The two original6m oak plans had71 and76 inward front/back stalk directions; corrected plans have positive initial emergence. No new Blender run, render, import or Studio acceptance is claimed.

This is the initial placement correction only. The final BVH projection still checks root position and discards the hit normal. Final bark union, variant deformation and other branch intersections need a normal-aware native regression and visual review before stalk emergence or overall tree quality can be accepted. The verified chat release candidate7d remains separate and unchanged; this generator edit requires new source-bound native evidence.

Signed implementation **e66c315** is pushed. Both original jobs in [native Blender run41368322324](https://github.com/k6sol/Arcane/actions/runs/41368322324) pass; ten exact archives and their closure/source/image bindings are verified. The [component run41368322342](https://github.com/k6sol/Arcane/actions/runs/41368322342) now has all seven jobs passing. [[Sessions/2026-11-02 Native Foliage Review]] retains actual review images with unchanged pixel/color chunks and removed metadata and the remaining art issues. The controlled card38 projection into retained native bark has ten opaque samples outside, minimum clearance0.299mm and root error zero. It is not a new native export of that exact card or whole-tree acceptance.
