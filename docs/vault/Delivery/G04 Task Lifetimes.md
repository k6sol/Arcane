---
type: goal
project: Arcane
tags: [arcane]
---
# Finish task lifetimes and parallel work

Status: **In progress**. Priority: P0.

Deliver: planning, Blender generation and placement preparation can overlap within existing resource limits; cancellation joins original work; normal completion does not cancel accepted work; ordinary interruption is distinguished from genuine cleanup failure; lost acknowledgements remain inspectable without replay.

Done when: held allocation, publication, persistence, repair and shutdown races settle correctly; Stop remains effective during retirement; unrelated conversations remain usable; completed tasks release only resources proven safe to release; unknown work remains retained. Review C252/C255 rather than publishing unfinished drafts.

Depends on: 1. Owner: task/runtime integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

30 October: [[Bugs/Adoption Work Lifetime]] has a connected original host/service implementation with held file-read, publication, persistence and Stop-after-registry-close cases prepared for hosted validation. Deliberate client-close provenance is still being completed separately. No whole-goal or native acceptance claim yet.

## Next action

Review, publish and verify the original adoption lifetime and deliberate-close provenance changes. Then connect normal retirement and preserve independent later human review/import paths.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
