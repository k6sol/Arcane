---
type: goal
project: Arcane
tags: [arcane]
---
# Establish one reproducible release baseline

Status: **In progress**. Priority and original scope: Establish one reproducible release baseline — P0, in progress.

Deliver: identify the exact main, packaged artifact, installed app and plugin versions; compare remaining candidates against current main; retain a short, concrete blocker inventory. Preserve existing work and keep the first pass bounded to release-critical findings.

Done when: every subsequent change starts from a known source revision, each installed component has an attributable version, and the shortest failing customer journey is reproducible with retained evidence. Do not run unbounded audits before fixing a confirmed blocker.

Depends on: none. Owner: release integration.

## Acceptance record

- [x] Identify remote source revisions and exact hosted validation outcome.
- [x] Identify active installation metadata and installed plugin file fingerprint.
- [ ] Attribute the installed source to its exact release revision or documented equivalent file inventory.
- [ ] Reproduce the shortest failing customer path and retain its evidence without assuming a source-only fix is installed.
- [ ] Validate the corrected published revision and record remaining release blockers.

## Evidence

30 October: main `ee7534c`; previous green product baseline `7e52f67`. Run 40975403615 has one Windows fixture cancellation, detailed in [[Bugs/Converted Import Timeout]]. Active desktop installed 20 October; its manifest and plugin fingerprint are recorded in [[Operations/Current State]]. No app launch, plugin operation or native Studio acceptance performed. G01 remains in progress.

## Next action

Verify the targeted CI correction, then compare the active source inventory and complete original lifetime fixes before a separately verified desktop release.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
