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
- [x] Attribute the selected installed source to its exact release revision or documented equivalent file inventory.
- [ ] Reproduce the shortest failing customer path and retain its evidence without assuming a source-only fix is installed.
- [x] Validate the corrected published revision and record remaining release blockers.

## Evidence

Main and selected installation are signed `5b84a41`, with seven passing component/package jobs and two pinned Blender jobs. Its authenticated archive, closed payload hashes and source/startup receipts passed before immutable installation. Original installer exit zero, both pipe EOFs and matching selected manifest establish source attribution. The older running window visibly offers Restart to update and is retained; no updated customer journey or Studio acceptance is claimed. The modular plugin artifact/source bytes are verified without installation. G01 remains in progress. See [[Operations/Evidence Ledger]].

## Next action

Verify supported installation identity and the shortest customer update/reopen path while preserving user state and the running app.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]

Historical exact baseline `1f87ea3` passed all nine jobs in runs41002979317/41002979268. Current baseline5b supersedes it with runs41087633471/41087633487 and confirmed installation. The shortest updated customer failure reproduction still needs the user-chosen restart; source attribution alone does not complete this goal.
