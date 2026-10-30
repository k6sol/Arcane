---
type: goal
project: Arcane
tags: [arcane]
---
# Ship and prove the customer release

Status: **In progress**. Priority: P0 release gate.

Deliver: attributable Windows desktop/plugin package, supported desktop shortcut/update flow, distributable signing and installer requirements, version compatibility, rollback/recovery, and retained acceptance evidence from the same revision shipped.

Done when: exact-revision checks and isolated packaged tests pass, a clean installation/update/reopen is demonstrated, and an authenticated customer completes prompt → model review → approved import → task/test/report without data loss. Keep controlled fixtures, actual packaged smoke, authenticated customer evidence and native Studio evidence explicitly separate. Studio must remain untouched by this agent; native acceptance stays outstanding until separately authorized evidence exists. Public launch additionally requires 9.

Depends on: 2–8; 9 for public commercial release. Owner: release integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [x] Evidence and remaining limitations recorded below.
- [x] Relevant regression checks passed for the published revision.

## Evidence

Actual Windows packaged startup/shutdown and portable export passed. The independently downloaded artifact passed every payload hash, closed inventory, source fingerprint and same-run receipt check. The active local bundle is unchanged; signed distribution, customer update/reopen and native acceptance remain incomplete. See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]].

## Next action

Use the independently verified portable build through the supported installation path after resource/ownership checks. Demonstrate user-state preservation and customer reopen separately; do not operate Studio.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
