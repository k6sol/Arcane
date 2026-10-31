---
type: bug
project: Arcane
tags: [arcane, assets, performance, verification]
---
# Artifact read admission

Generated-model review performs two complete manifest verifications around captured source fingerprints. Each artifact previously received an outside regular-file/ancestor check and the same check again inside its bounded reader. The reader still checks ancestors after reading, and review still freshly validates each approval and import boundary.

The bounded reader now admits the actual opened size synchronously before allocation or content reads. Manifest size and aggregate-byte checks run there, removing only the duplicate outside path walk. Both internal ancestor checks, inode/device/link checks, final timestamps, bounded read, hash, GLB/PNG checks and both full review passes remain. Per-file128MiB and aggregate256MiB caps are unchanged; no cache or parallel allocation is introduced. Admission denial awaits the original handle close and preserves its thrown identity, including falsy values.

Stable size mismatch diagnostics keep the original MANIFEST text and artifact annotation. A raced invalid opened file can now fail ARTIFACT before a stale pathname-size mismatch; actual opened bytes govern the aggregate bound. This is intentional stronger admission, not a guessed file witness.

## Verification

Strict compilation covers659 sources. A final frozen-input selection passes57 file-admission, artifact-diagnostic and HTTP cases without skips. It proves refusal before allocation/read, original captured-handle close with fd=-1, exact Error/falsy denial identity, unchanged hash checks, replaced-path and hard-link rejection, initial ancestor junction rejection and sparse oversized-file refusal without large allocation. The initial Windows junction fixture attempted an OS-forbidden open-directory rename; its corrected case creates the actual junction before reading. Post-read ancestor replacement is not claimed exercised on Windows.

## Remaining handoff failure

Original hosted Windows job124527115688 in run41197702915 times out the composed normal plan/asset handoff at its20-second limit. The original local execution reproduces it. Elapsed diagnostics show cumulative review/import work, not one missing context reply or a proven resource leak. Reducing the fixture's100 durable empty polls per second to enqueue-triggered actual poll/proof/result handling and its normal2-second heartbeat does not by itself resolve it. Exact queued/succeeded context IDs are compared; proof and operation deadlines remain unchanged.

The fixture now also approves its originally opened human model-review witness after task retirement, rather than replacing that opening. Decide still freshly verifies current subject, human scope and selection epoch. This strengthens continuity coverage while removing a redundant opening.

The final composed selection reports43 passes and one cancellation, with no skips. Approved payload preparation completes before the deadline; the case then exceeds20 seconds during the subsequent terminal/handoff section. The whole original case remains unaccepted. Do not increase its deadline, replay completed native operations, infer closure or report a green release. The next action is to instrument the remaining normal-entry/join/retained-state/third-Send witnesses and improve the actual remaining cost or ordering.

[[Delivery/G04 Task Lifetimes]] · [[Delivery/G05 Blender Quality]] · [[Delivery/G06 Connected Import]] · [[Bugs/Normal Task Handoff]]
