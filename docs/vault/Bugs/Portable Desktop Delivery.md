---
type: delivery
project: Arcane
tags: [arcane, desktop, release]
---
# Portable desktop delivery

Status: hosted export, actual portable download and full payload/provenance inspection passed; installation pending.
Related goals: [[Delivery/G03 Persistent Sessions]], [[Delivery/G10 Customer Release]].

## Gap

The packaged CI job tests a full desktop directory but originally retained only twelve small evidence files. The running app watches the local installation record; it does not download GitHub source changes. A successful source push therefore did not deliver a new local release or display its update banner.

## Connected implementation

After all six component lanes and the original executable smoke succeed, export the exact already-tested directory with a bounded same-run provenance sidecar. Recheck source, receipt hashes and the entire immutable payload inventory; do not rebuild or relaunch the app. Preserve the original always-retained diagnostic artifact.

The portable artifact contains `windows/<actual bundle>/...` and `ci-desktop-distribution/distribution.json`. Hidden payload files such as `.github` are retained only after inventory verification. Developer vault notes remain outside the desktop package. The sidecar binds source/run/attempt, manifest and evidence hashes, runtime versions and honest unsigned/component-only limits.

## Acceptance

- [x] Original packaging, verification, artifact and installation paths traced.
- [x] Success-only export/workflow implementation and bounded integrity regressions authored.
- [x] Hosted release tests and exact executable/package checks pass.
- [x] Downloaded artifact inventory, digest, provenance and archive layout verified.
- [ ] Separately authorized installation/update/reopen demonstrates retained user state.

A downloadable artifact does not itself install anything or display the banner. Use the existing supported installation engine only after independent publisher/payload verification. It activates an immutable local release; the user controls restart through the existing draft-safe flow. No remote updater, installer signing, silent restart, provider inference or Studio/customer acceptance is claimed by this slice.

Verified 30 October on `9a69619` in [run 40988115669](https://github.com/k6sol/Arcane/actions/runs/40988115669). See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]] for scope and remaining acceptance.
