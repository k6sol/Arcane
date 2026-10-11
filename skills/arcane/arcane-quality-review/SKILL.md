---
name: arcane-quality-review
description: "Review a Roblox slice against brief, function, feel, visual coherence and device budgets using evidence rather than self-awarded scores."
license: MIT
---

# Independent quality gates

## Use the actual deliverable
Compare the requested outcome with current code, engine captures, interaction traces and source assets. Separate functional correctness, usability, feel, visual consistency, performance and production readiness. A failure in one axis cannot be hidden by an impressive render in another.

Prioritize blockers that prevent intended play, then readability/response issues and coherence. Suggest the smallest changes with explicit evidence and acceptance. Do not rewrite the brief or invent a universal AAA style.

Use automated measurements for what they measure: bounds, budgets, logs and state. Art/fun verdicts need human/player review and clearly stated uncertainty. An arbitrary 10/10 score or presumed top-100 ranking is not a test result.

## Verification
Inspect a complete start/action/failure/retry loop at normal use scale and advertised devices. Check that acceptance stayed fixed across repair attempts. A review report names inspected revisions, unresolved problems and limitations. Recommendations do not by themselves mark fixes implemented or approved.
