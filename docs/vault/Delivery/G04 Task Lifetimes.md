---
type: goal
project: Arcane
tags: [arcane]
---
# Finish task lifetimes and parallel work

Status: **In progress**. Priority: P0.

Deliver: planning, Blender generation and placement preparation can overlap within existing resource limits; cancellation joins original work; normal completion does not cancel accepted work; ordinary interruption is distinguished from genuine cleanup failure; lost acknowledgements remain inspectable without replay.

Done when: held allocation, publication, persistence, repair and shutdown races settle correctly; Stop remains effective during retirement; unrelated conversations remain usable; completed tasks release only resources proven safe to release; unknown work remains retained. Retain original work identity and actual closure rather than inferring success from presentation state.

Depends on: 1. Owner: task/runtime integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [x] Evidence and remaining limitations recorded below.
- [ ] New connected handoff regressions pass on their exact published revision.

## Evidence

[[Architecture/Native Session Custody]] adds durable native allocation, possible write capability and original physical-close records. Strict654 compilation passes; a pinned405-case integration run and169 final binding-focused cases pass with zero skips. Hash comparison limits the intervening production change to the custody module. Old rows receive no guessed closure, normal retirement does not settle the native lease, and failed persistence fences admission. Hosted/package/customer acceptance and useful recovery of legacy task/resource debt remain open.

Adoption work registration, deliberate-close request provenance and captured final-save joins passed controlled regressions on both platforms in the exact seven-job baseline. [[Bugs/Normal Task Handoff]] now connects non-cancelling retirement, original work joins, read-only later review and fresh Send for hosted validation. The prior passing lifecycle regressions remain distinct evidence. Full settlement/human acceptance, bounded archival and customer acceptance remain incomplete. See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]].

## Next action

Verify the exact connected handoff, its held-operation/Stop schedules and manual-grant companion in hosted compilation and complete regressions. Preserve unknown outcomes and no-replay guarantees; then continue actual customer and full durable settlement/archival requirements.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
