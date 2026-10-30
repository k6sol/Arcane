---
type: bug
project: Arcane
tags: [arcane, blender, geometry]
---
# Foliage card attachment

Status: original geometry correction and mandatory native regressions prepared; execution and visual review pending.
Related goal: [[Delivery/G05 Blender Quality]].

The production curved-card constructor applies its cup displacement at the base as well as the tip. Its two basal corners therefore have a midpoint displaced from the declared attachment root by cup × width. A half-metre-wide oak card is shifted six centimetres, birch four and pine five. These are exact source-derived counterexamples, not new rendered measurements.

Fade only the cup term from zero at the root to its original strength at the middle station. The two basal corners move onto their declared anchor. The middle and tip geometry, apexes, eight vertices, twelve triangles, UVs, atlas selection and budgets stay unchanged.

The separate mandatory hosted Blender fixture imports the full real worker, builds actual meshes for 39 species/frame/scale/control cases, checks measured root error, topology/UVs and unchanged distal shape, then saves and reopens the actual scene. A native BVH check measures contact with a capped stem. Bounded JSON and two neutral contact renders are retained; no people or live Studio work are involved. Existing conversion tests and deadlines stay intact.

## Acceptance

- [x] Trace the actual production tree route and identify the displaced root invariant.
- [x] Prepare the narrow geometry correction and real Blender representation/contact tests.
- [x] Independently review exact worker/mesh/atlas/process/workflow contracts.
- [ ] Exact hosted native fixture passes on Windows and Linux.
- [ ] Inspect the actual retained contact renders.
- [ ] Real trees pass complete branch/leaf attachment and reference-led quality review.

This fixes a card's declared geometric anchor only. Some canopy roots still lie on virtual or pruned twig chains; texture stalks can be laterally offset inside the atlas. Neither full physical foliage connection, alpha-visible petiole contact, rock quality nor whole-tree realism is established by this change. The card fixture is a geometry regression, not a finished-tree showcase.
