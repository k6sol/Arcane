---
type: bug
project: Arcane
tags: [arcane, blender, chat, quality]
---
# Forest Blender workflow

Regression input: **make a small forest with a well in and a small building**.

The user supplied the actual result on 30 October 2026: repeated simple tree canopies and trunks scattered over a checker baseplate, sparse props/ground detail and a simple building. Ground/grass and coherent scene finishing were absent. The user also reported that the models were not authored/imported through Blender.

## Observed in the running app

Computer-use inspection identified the installed release directory beginning `66f74350`, rather than the newer verified main. Platform selection was GPT-6.1 Sol, low. The recorded task showed six steps, one retry and two remaining failures: skill selection, an initial scene build, then successful scene build and failed viewport capture. Its heading nevertheless said Built. The final assistant message called the vegetation basic blockout geometry. The Blender panel reported no session-only meshes placed in a connected Studio; older ready jobs alone are not evidence of new generation/import. Expanding the failed skill selection exposed identifiers only, so its exact cause is not established.

The user has authorized prompt testing in the open app and designated baseplate test place. Preserve existing scene content and active user work. Do not infer that newly committed source is installed.

## Required correction and acceptance

- [ ] Retrieve actual skill/tool error information and correct the demonstrated failure; do not guess a budget or permission cause from IDs.
- [ ] Route original asset work through actual Blender generation, UV/material/PBR authoring, preview and verified conversion/import.
- [ ] Do not silently replace failed/missing asset authoring with primitive or stock scene kits. A requested blockout is a different explicit scope.
- [ ] Include intentional ground/grass, paths, varied vegetation and ground cover, well/building detail and integrated lighting/composition.
- [ ] Surface unsupported or failed operations as incomplete with an actionable reason; no misleading complete-success heading.
- [ ] Inspect the actual imported meshes and scene in the designated test place, then exercise relevant gameplay/collision paths.
- [ ] Repeat the regression on the actual updated installed build and retain revision, tool/asset provenance, checks and remaining limits.

Related: [[Skills/Production Upgrade]], [[Bugs/Original Asset Authoring]], [[Delivery/G05 Blender Quality]], [[Delivery/G06 Connected Import]], [[Delivery/G08 Diagnostics]].
