---
type: bug
project: Arcane
tags: [arcane, assets, preview]
---
# Orthographic preview floor

The exact retained Windows boulder artifact from signed8475cd9 passes native mesh, UV/PBR, export/reopen and worker-closure checks. Its side view contains a black horizontal strip near the image bottom. Visual QA remains NO-SHIP for the requested realistic boulder: the material reads smooth with shallow repeated cracks. Passing native geometry checks does not accept that art direction.

The generic side camera previously placed the lower orthographic ray origins below PreviewGround. For the original1.6m span and0.45m target height, the bottom origin lies at about-0.179m, below the floor box. The worker now moves the camera backward along its existing view axis until the complete frame clears the floor. Orthographic direction, apparent scale, lighting and model geometry remain unchanged. Near clipping scales down for small assets; the far plane follows camera distance plus asset extent. The established hero camera stays in place.

A single isolated factory-startup Blender4.5 process rendered both views with the actual production lookdev and a bounded box fixture. The original reproduced the strip; the correction removed it. The original bottom pixel is0/0/0 and the corrected pixel146/152/160. Asset-region differences are at most one RGB level; geometry hashes remain identical. The process exited0 with both output streams complete. No customer scene, provider or Studio operation occurred. This is a Blender4.5 fixture comparison, not the actual boulder rerender or Blender5.2 customer acceptance.

Original fixture:
![[Assets/Reviews/2026-11-02 Preview Floor Original.png]]

Corrected fixture:
![[Assets/Reviews/2026-11-02 Preview Floor Corrected.png]]

All17 focused camera, failure-classification and Windows-path cases pass. Camera cases cover original under-floor geometry, multiple scales and pitches, unchanged view direction, unchanged hero position and invalid plans. The first camera run exposed an assumed fixed far-plane range at a much shallower pitch; the caller now derives far clipping from its actual camera distance. No operation deadline, budget or native acceptance requirement changes. The mandatory native workflow adds this camera check and now declares26 source input paths. Actual Blender5.2 boulder and broader model/material quality remain open.

[[Delivery/G05 Blender Quality]] - [[Operations/Next Session]] - [[Bugs/Pinned Blender Archive Cache]]

## Delivery verification

The completed original8545 native run passes both OSes. Its actual Blender5.2 boulder side image removes the band; old/new exported GLB hashes and bounds are identical. This accepts the camera correction on the generated boulder, while material realism stays unaccepted. See [[Sessions/2026-11-02 Verified Preview Desktop Delivery]].
