---
type: bug
project: Arcane
tags: [arcane, blender, geometry]
---
# Foliage card attachment

Status: native geometry regressions passed on both platforms; bounded artifacts and Windows contact renders inspected. Full-tree quality remains outstanding.
Related goal: [[Delivery/G05 Blender Quality]].

The production curved-card constructor applies its cup displacement at the base as well as the tip. Its two basal corners therefore have a midpoint displaced from the declared attachment root by cup × width. A half-metre-wide oak card is shifted six centimetres, birch four and pine five. These are exact source-derived counterexamples, not new rendered measurements.

Fade only the cup term from zero at the root to its original strength at the middle station. The two basal corners move onto their declared anchor. The middle and tip geometry, apexes, eight vertices, twelve triangles, UVs, atlas selection and budgets stay unchanged.

The separate mandatory hosted Blender fixture imports the full real worker, builds actual meshes for 39 species/frame/scale/control cases, checks measured root error, topology/UVs and unchanged distal shape, then saves and reopens the actual scene. A native BVH check measures contact with a capped stem. Bounded JSON and two neutral contact renders are retained; no people or live Studio work are involved. Existing conversion tests and deadlines stay intact.

## Acceptance

- [x] Trace the actual production tree route and identify the displaced root invariant.
- [x] Prepare the narrow geometry correction and real Blender representation/contact tests.
- [x] Independently review exact worker/mesh/atlas/process/workflow contracts.
- [x] Exact hosted native fixture passes on Windows and Linux.
- [x] Inspect the actual Windows front/side contact renders and verify both platforms' measured artifacts.
- [ ] Real trees pass complete branch/leaf attachment and reference-led quality review.

This fixes a card's declared geometric anchor only. Some canopy roots still lie on virtual or pruned twig chains; texture stalks can be laterally offset inside the atlas. Neither full physical foliage connection, alpha-visible petiole contact, rock quality nor whole-tree realism is established by this change. The card fixture is a geometry regression, not a finished-tree showcase.

Verified `1f87ea3` in [run 41002979268](https://github.com/k6sol/Arcane/actions/runs/41002979268): all 39 cases, native save/reopen and observed owned closure passed on each platform. Maximum root error was about `6.15e-8 m`; the measured capped-stem gap was about `1.87e-9 m`, both within the existing `4e-6 m` fixture bound. Authenticated artifact digests and actual source bytes were checked, including the exact Windows CRLF checkout transform for Python. Windows front/side views show geometric contact without an apparent gap; these are neutral component tests, not finished-tree showcases.

The distinct alpha-visible stalk offset is now addressed by [[Bugs/Foliage Texture Attachment]] for hosted validation. Its production change is paint-only; the geometric anchor evidence above remains separate and does not certify a complete tree.
