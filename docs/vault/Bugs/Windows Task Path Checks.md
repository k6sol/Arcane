---
type: bug
project: Arcane
tags: [arcane, windows, tasks, performance]
---
# Windows task path checks

The retained local handoff exceeded its original 20-second deadline despite steady progress through model review and import preparation. CPU sampling identified repeated synchronous `lstat` and canonical-path resolution in task-store guards, including the native-plan observer's existing 50 ms polling. Grouped artifact reads alone did not resolve that local timeout. The same original handoff passed on hosted Windows at `b09b092` in 3,051.5476 ms; keep that evidence separate from local attempts.

Task-store directory and SQLite-file checks now use the existing conversation-store Windows pattern. A fresh native canonical lookup supplies positive proof only when its result matches the checked path. A different result or native lookup error falls through to the original resolver. Every ancestor stat, directory/type/symlink check, file link count, main-file device/inode check, ownership/version guard and case comparison remains. Constructor canonicalization stays unchanged. No filesystem authority is cached, no polling interval changes, and no resource or operation deadline grows.

## Verification

The fresh-native-probe regression first fails against the retained original compiled task store. After the change, strict compilation covers 660 sources. A frozen-input selection passes all 156 cases without skips or cancellations: task/conversation storage, original normal handoff and Stop companions, automatic grants, plan observation/integration and recovery quarantine.

The exact local handoff now completes in **14,395.5174 ms** under its unchanged **20,000 ms** limit, including original human review, approved payload, original worker cleanup, retained host state and third Send. All original semantic assertions complete. This is one measured controlled run, not a universal speed guarantee.

Windows tests prove that summaries/get/update freshly probe every directory ancestor and present SQLite main/sidecar on each original fence. Different native spellings and `EBUSY` preserve actual legacy acceptance. Actual junctions, missing project directories and a hard-linked sidecar remain refused; unrelated marker bytes remain intact. Existing journal corruption, ownership, restart, permission and missing-main-file cases remain unchanged.

Fresh exact-source hosted/package checks and authenticated customer acceptance remain required. This does not settle historical unknown tasks or native process custody, complete the task/test/repair goal, or verify Studio. All earlier failures and CPU evidence remain retained.

[[Delivery/G04 Task Lifetimes]] · [[Delivery/G07 Test and Repair]] · [[Bugs/Artifact Read Admission]] · [[Bugs/Normal Task Handoff]]
