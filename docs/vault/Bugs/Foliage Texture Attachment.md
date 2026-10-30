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
- [ ] The complete original module fails filtered-root attachment while the candidate passes actual root and continuous-stalk checks.
- [ ] Actual embedded PNG bytes, exported UV orientation and sampler/material settings agree with native readback.
- [ ] Original 39 geometry cases, source preservation, original limits and owned process closure pass.
- [ ] Actual cutout front and oblique images are inspected and their visual limitations recorded.
- [ ] Complete tree branch/leaf connectivity and appearance are evaluated separately.

Implementation and fixtures are prepared; no native positive result or quality verdict is claimed before execution. The child remains bounded at 180 seconds, the test at 210 seconds and the workflow at 25 minutes. Virtual or pruned twig-to-rendered-wood chains, minified foliage LOD, complete tree realism and Studio/customer acceptance remain separate requirements.

[[Operations/Current State]] · [[Operations/Evidence Ledger]]
