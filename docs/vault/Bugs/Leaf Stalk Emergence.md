---
type: bug
project: Arcane
tags: [arcane, blender, foliage, quality]
---
# Leaf stalk emergence

A read-only review of the retained native oak confirms opaque stalk penetration while the existing root-contact protection remains intact. The exact GLB hash is `3ad6218d111f8819e9b40d636678154ab50a55fd049d2d99e098f562750ddbaa`; retained/current procedural source both hash to `fdf316586f8b57d127c424fa84908ba5a76940092fabaa59ab09901ce7567939`.

The mesh contains322 separate leaf cards. At1% card height,14 have both actual front/back center-stalk points opaque and inside bark by three agreeing ray parities. Independent solid-angle winding and nearest-triangle checks confirm card38: root distance is zero, but opaque points7.76mm along the stalk lie3.89–3.91mm inside closed, consistently oriented bark. Card122 independently shows0.57–0.66mm penetration. Texture-V and far-outside winding controls distinguish this result from sampling or open-mesh artifacts. These measurements do not establish how much of a rendered gap they cause, and do not prove full asset quality.

Source trace: the fan direction in `workers/blender/procedural.py` uses tangent/shell targets without an outward-skin constraint. Final attachment checks root distance and applies an atomic translation; the final bark BVH query discards its returned normal. Existing emitted-skin, rebind, local-displacement, topology, UV and budget protections must remain. Do not revive the already-fixed virtual-root diagnosis.

No tracked generator edit, model job, Blender run or Studio operation was performed. The internal Sol reviewer confirmed STARTED/FINISHED; the second private fixture task also confirmed FINISHED. The exact closed-bark/card/alpha fixture rejects wrong texture-V, open/inverted bark and detached roots. A roughly174-degree basal-edge rotation supplies a diagnostic outward positive control while preserving root contact and pairwise geometry, but is too large to adopt as a production correction. Next implement the smallest normal-aware emergence constraint, carrying the actual bark BVH normal and retaining the atomic contact protections. Preserve RNG draws, counts, UV/PBR data and budgets. Native closeup and whole-tree visual acceptance remain required; the current release candidate stays frozen.
