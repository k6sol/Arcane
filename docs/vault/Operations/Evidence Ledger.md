---
type: evidence
project: Arcane
tags: [arcane]
---
# Evidence ledger

## Current verified baseline · 30 October 2026

| Claim | Evidence | Scope |
|---|---|---|
| Signed source promoted to main | [Commit 9a69619](https://github.com/k6sol/Arcane/commit/9a69619696b620c502daabf4a5ce7c3ff09ea0a4) | GitHub reports valid SSH signature; source signing is separate from executable signing |
| Seven jobs passed | [run 40988115669](https://github.com/k6sol/Arcane/actions/runs/40988115669) | Six Windows/Linux component lanes and real Windows packaged startup/shutdown |
| Downloaded desktop archive verified | Portable artifact 12948598951 from the same run | Exact 214,809,678 bytes and SHA-256 `44c34d3ed30a06c94a98f618203898813487f492c13ee8c620e3dfd672745be4` matched the authenticated artifact record |
| Full payload verified | 4,657 manifest files, 531,932,053 bytes | Every streamed file hash/size, closed ZIP inventory and actual archive layout checked; no extraction/execution needed |
| Provenance correlated | Same-run evidence artifact 12949500454 and distribution sidecar | Evidence digest, receipt hashes, source script/package/lock fingerprints, Node and Electron identity agree |
| Lifecycle regressions passed | Same exact seven-job run | Held adoption I/O/publication/persistence, intentional Stop provenance, genuine close failures and captured final-save behavior; controlled peers/files/SQLite |
| Developer vault stays source-only | Source-release regression and actual packaged job | Vault filenames no longer block packaging; existing strict package path rules remain |

Payload manifest: `fdcfb20752403dee220a469eab293a661cf1b5d9f5be3060aeefc41904762edb`. Bundle layout: `windows/arcane-win32-x64-xz4Fp2/...` plus `ci-desktop-distribution/distribution.json`. Node 24.22.1; Electron 44.9.1. Artifacts expire after seven days; source and public run links preserve attribution beyond retention.

## Remaining evidence

- Installed app/plugin matching the intended release and supported update/reopen preserving user state.
- Authenticated customer send and complete prompt → review → approved import → task/test/report workflow.
- Native Studio rendering, upload, placement and gameplay acceptance; this agent must not operate Studio.
- Normal retirement, original settlement and later human-review handoff acceptance.
- Configured commercial hosting/auth/payment services and distributable signing/installer acceptance.
- Actual rendered original-model geometry, UV and material quality against references.

The active installation is still the 20 October build. The verified download does not install it, launch it or show its update banner. No provider inference or Studio operation occurred during artifact inspection.

## Subsequent verification

The same source promoted to main and the later notes commit passed every unit lane and Linux release, but Windows release hit [[Bugs/Key Navigation Timeout]]. Those later runs are not green and their package jobs were skipped. The original exact seven-job success and independently inspected artifact remain valid evidence at their stated scope.

Original-authoring candidate `b72cdb9` passed real native Blender conversion on both platforms in [run 40992537597](https://github.com/k6sol/Arcane/actions/runs/40992537597). Its component failures identified corrected instruction/reference companions; [[Bugs/Model Review Observation]] records a separate browser lifetime correction. [[Bugs/Foliage Card Attachment]] is prepared for native validation and does not yet establish tree quality.

## Historical failures

[[Bugs/Converted Import Timeout]], [[Bugs/Cleanup Observation Window]] and [[Bugs/Development Vault Packaging]] retain their distinct original failures and corrections. Earlier failures are not erased by the new passing baseline.

## Evidence levels

`Proposed → Implemented → Controlled test → Packaged smoke → Authenticated customer → Native engine acceptance`

Record the level explicitly; one cannot substitute for another. Use [[Templates/Evidence]] and [[Playbooks/Release Verification]].
