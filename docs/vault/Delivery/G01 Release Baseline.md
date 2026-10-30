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
- [x] Validate the corrected published revision and record remaining release blockers.

## Evidence

Main `9a69619` passed all seven jobs and its real portable archive passed independent checksum, closed-inventory, payload-hash and provenance checks. Active installation and plugin fingerprints are recorded, but the installed app is still the 20 October build. No customer failure reproduction or native Studio acceptance is claimed. G01 remains in progress. See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]].

## Next action

Verify supported installation identity and the shortest customer update/reopen path while preserving user state and the running app.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]

Latest exact baseline: main `1f87ea3` passed all nine component/package/native Blender jobs (runs 41002979317 and 41002979268) and was promoted by ordinary fast-forward with a valid SSH signature. Task handoff is newer validation work; installed/customer attribution and shortest customer reproduction remain outstanding.
