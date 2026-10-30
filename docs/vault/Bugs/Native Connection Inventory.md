---
type: bug
project: Arcane
tags: [arcane, chat, diagnostics]
---
# Native connection inventory

A fresh, original read-only native connection reproduced an inbound `FRAME_LIMIT` during `discovery-inventory`: at least 1,062,180 bytes against the existing 1,048,576-byte limit. Only `mcpServerStatus/list` was pending. The original native process closed cleanly; no thread, model turn, login or Studio write occurred. This is a new controlled native reproduction, not retrospective attribution of the older installed app's retained unknown acknowledgement.

The correction requests one server per page rather than four. At most 32 pages/servers preserves the former effective four-by-eight server capacity, with the existing 2,048 aggregate tool bound. Frame/output/request limits, complete inventory validation, duplicate/cursor checks and isolation requirements remain. No server filter, user configuration edit, automatic retry or larger message cap is added. A single server with an oversized catalogue still fails explicitly.

The changed actual native discovery succeeded with all seven servers and 357 tools, and confirmed original process closure. This verifies discovery feasibility; final Arcane authority, a model turn, installed-app recovery and Studio import remain separate acceptance checks. The old app's retained prompt was not resent or acknowledged manually.

- [x] Reproduce and locate the original bounded native inventory failure.
- [x] Verify the changed one-server pagination in a fresh actual native discovery.
- [ ] Pass regression fixtures and hosted verification on the published correction.
- [ ] Install the attributable release and verify the actual chat journey.
- [ ] Verify reviewed original asset import in the designated Studio place.

Related: [[Delivery/G02 Reliable Chat]], [[Delivery/G08 Diagnostics]], [[Bugs/Forest Blender Workflow]], [[Bugs/Windows Model Supervision]].

Local verification: all 643 product sources compiled, and 330 focused chat, inventory, isolation, lifetime and diagnostic tests passed. Hosted verification of this correction and installed-app acceptance remain pending.

## Verification follow-up

The `105de62` full hosted run exposed three separate unit failures, so it was not promoted. The strengthened lifecycle fixture observes genuine dispatch and peer-held turns; all 36 lifecycle cases pass locally. Four joint chat/playtest cases pass with unchanged deadlines and new finite timing diagnostics; the original hosted timeout phase is still unproved. [[Bugs/Studio Packet Poll Fairness]] addresses the measured large-PBR freshness expiry. Fresh full hosted verification is required before customer acceptance.
