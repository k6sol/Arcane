---
type: bug
project: Arcane
tags: [arcane, playtest, ui]
---
# Playtest history presentation

The customer questioned the always-visible Saved playtest reports block, Archive ready and Current source unobserved wording in ordinary chat. Previous results are useful for inspecting an earlier failure, not as an empty status panel or proof that current changes pass.

History now starts as a collapsed Previous playtests disclosure. View reports is an explicit human GET; mounting does not scan the archive. When that checked archive is ready, empty and has no continuation page, its section is removed from chat. Nonempty pages keep actionable Open report controls, Older reports pagination, Refresh reports and the number of reports no longer available. Copy says that these are previous results and a new test checks current changes. Archive failure stays visible as a readable refresh message. Actual report details retain the original review, failures, cleanup and historical-scope evidence; no historical report grants current execution authority.

The final176-case focused UI run passes, including history parser/pagination/scope tests, real Edge report/capture behavior and a new empty-archive case. The first run exposed a fixture selecting the newly introduced outer details instead of the actual report details, and pagination waiting for old omission wording. The selector was narrowed to the report details; the omission count was retained with clearer copy. No deadline, archive scope check or live-authority assertion was weakened.

The source/controlled-browser checks pass. Thef8 package is now installed and reopened; its new startup connection failure prevents full customer workflow acceptance. See [[Sessions/2026-11-02 Local Chat Desktop Delivery]].

[[Bugs/Zero Action Chat]] ? [[Operations/Next Session]]
