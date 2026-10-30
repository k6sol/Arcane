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
- [x] Evidence and remaining limitations recorded below.
- [x] Relevant regression checks passed for the published revision.

## Evidence

Adoption work registration, deliberate-close request provenance and captured final-save joins passed controlled regressions on both platforms in the exact seven-job baseline. Normal non-cancelling retirement, full settlement/human acceptance and bounded archival remain incomplete. See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]].

## Next action

Connect normal retirement and correct later human review/fresh-Send handoff while retaining original work identity, unknown outcomes and no-replay guarantees.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
