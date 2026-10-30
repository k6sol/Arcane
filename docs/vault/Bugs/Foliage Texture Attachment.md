---
type: bug
project: Arcane
tags: [arcane, blender, quality]
---
# Foliage texture attachment

Goal: [[Delivery/G05 Blender Quality]]. Related: [[Bugs/Foliage Card Attachment]].

## Observed defect

The card's declared UV root is fixed at the tile centre, while the painted main stalk previously started at a seeded lateral offset. A mesh can meet its input anchor and still show a transparent gap at that point. The earlier geometric card correction and opaque contact renders do not prove alpha-visible attachment.

## Change

Paint the main stalk from the declared UV root in the existing oak, birch and pine atlas generators. Use a copied paint endpoint: retain the original shoot points, random draws/order, pine arc length and needle count, branch widths and later points. No UV, mesh, material-support or import authority change.

The mandatory native fixture retains its original 39 geometry cases, save/reopen checks and two opaque contact views. Additional checks use the complete original texture module as a pinned negative control, compare real seeded upper texture/RNG results, and inspect the actual production-authored material and exported GLB. Filtered alpha is read from embedded PNG bytes at UVs matched to exported basal positions; actual sampler and MASK settings remain part of the proof. Opaque, double-V-flipped and substituted-image controls must refuse. Two additional cutout contact views require visual inspection.

## Acceptance

- [ ] Exact source passes component/package gates and native Blender on both supported CI platforms.
- [x] The complete original module fails filtered-root attachment while the candidate passes actual root and continuous-stalk checks.
- [x] Actual embedded PNG bytes, exported UV orientation and sampler/material settings agree with native readback.
- [x] Original 39 geometry cases, source preservation, original limits and owned process closure pass.
- [x] Actual cutout front and oblique images are inspected and their visual limitations recorded.
- [ ] Complete tree branch/leaf connectivity and appearance are evaluated separately.

The native positive checks below passed, while overall component/package and visual acceptance remain incomplete. The child remains bounded at 180 seconds, the test at 210 seconds and the workflow at 25 minutes. Virtual or pruned twig-to-rendered-wood chains, minified foliage LOD, complete tree realism and Studio/customer acceptance remain separate requirements.

[[Operations/Current State]] · [[Operations/Evidence Ledger]]

## Actual native evidence · 30 October 2026

[Run 41010961594](https://github.com/k6sol/Arcane/actions/runs/41010961594) passed both Windows and Linux native Blender jobs on exact `9151892`. Both authenticated evidence archives were downloaded and their closed inventories, SHA-256 digests, five actual source fingerprints, measurements and four PNG headers verified. Native inputs remain byte-identical at `499261b`; the Windows files use the exact expected CRLF checkout transform.

Both platforms passed the original 39 geometry cases, 96 filtered atlas probes, 12 original-versus-candidate RNG/upper-canvas comparisons, 24 actual exported-image/UV probes and three real-data tamper negatives. The complete original-module control had minimum root alpha zero; the candidate's minimum exported root alpha is 1 and continuous-stalk alpha is approximately 0.999856. All three measured native contact gaps are zero. Saved-scene reopening, actual owned child closure and temporary-data cleanup were confirmed. These are bounded component results, not a complete tree assessment.

### Visual result still requires work

All four actual cutout views were inspected. The oblique views show three brown stem ends meeting dark stalks. In both front views, the upper pine sprig appears disconnected; foliage is also dark and cropped. The source/composition/material/occlusion cause needs a focused follow-up. Keep this visible finding open even though the numerical root checks pass. No whole-tree, virtual-twig, photorealism or Studio acceptance is implied.
