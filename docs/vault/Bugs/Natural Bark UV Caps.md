---
type: bug
project: Arcane
tags: [arcane, blender, uv]
---
# Natural bark UV caps

The general planar projection did not account for cap handedness. A reversed natural tube bottom cap could therefore keep mirrored UVs even though its geometry and area were valid. The correction changes only negative-winding natural wood cap UVs; general/legacy face projection, geometry, normals and side/apex UVs remain.

- [x] Pass all 38 pure generator cases, including fourteen signed cap orientation/taper subcases and unchanged-geometry controls.
- [x] Run the same original oak inputs through actual Blender 4.5.3 LTS: 10,310 render triangles, UV/PBR, GLB/FBX, round-trip/reopen and all three original worker roles closed.
- [x] Measure bark mirrored faces changing from 22 to 0; exported geometry is identical. The 22 corresponding ground-band UV triangles change orientation without changing their positions.
- [x] Inspect both actual new review renders.
- [ ] Resolve remaining bark angle/stretch warnings and two folded faces.
- [ ] Accept canopy/branch structure and atlas-aware coverage against references.
- [ ] Verify reviewed engine import, appearance, collision and appropriate LODs.

The new bark angle distortion is 0.611, its P95 is 2.24 and stretched share is about 5.96%; these still exceed their original thresholds. The local tree and rock remain artistically unaccepted. This cap correction is not a whole-model, Studio or universal realism pass.

Related: [[Delivery/G05 Blender Quality]], [[Bugs/Forest Blender Workflow]], [[Bugs/Windows Model Supervision]].
