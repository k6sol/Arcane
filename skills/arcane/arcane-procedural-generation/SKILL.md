---
name: arcane-procedural-generation
description: "Build Roblox procedural layouts or encounters with reproducible seeds, validity constraints and meaningful controlled variation."
license: MIT
---

# Seeded procedural content

## Define what may vary
Separate stable rules and geometry from seeded choices. Specify connectivity, fairness, reachability, budgets and prohibited combinations. Different random numbers do not guarantee different decisions or fun.

Generate from a validated grammar/modules, then check constraints. Keep a bounded retry/fallback path; never loop indefinitely searching for a valid map. Save seed, generator version and relevant config for reproducing failures.

Authority and player state remain server-owned where needed. Clients can render deterministic cosmetic variation but cannot select a rewarding layout or claim outcomes. Avoid regenerating underneath active players without a designed transition.

## Verification
Test ordinary and adversarial seeds, tiny/full player counts and budget extremes. Assert reachable objectives/spawns, collision clearance and valid encounter pacing. Preserve failing seeds as regression cases. Compare actual decisions across runs, not just screenshot variation. A hand-reviewed sample is not proof every possible seed works.
