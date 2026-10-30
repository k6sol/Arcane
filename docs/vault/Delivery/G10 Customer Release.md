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
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

[[Bugs/Development Vault Packaging]] fixes a source-release blocker without loosening path policy. [[Bugs/Portable Desktop Delivery]] adds retention of the exact component-tested app directory and same-run provenance. Hosted artifact and installation acceptance remain pending; the active local bundle is still the 20 October build.

## Next action

Verify the corrected package and portable artifact from one exact revision, then exercise the supported installation/update path in an authorized environment while preserving the user's current app and state. Native/customer acceptance remains separate.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
