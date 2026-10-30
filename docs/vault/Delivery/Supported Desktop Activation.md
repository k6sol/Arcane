---
type: playbook
project: Arcane
tags: [arcane, desktop, release]
---
# Supported desktop activation

Status: source path and existing launcher compatibility verified; local activation has not run.
Related goals: [[Delivery/G03 Persistent Sessions]], [[Delivery/G10 Customer Release]].

## Verified prerequisites

- [x] Authenticate the passing portable archive and independently verify its closed payload, source fingerprints and same-run evidence.
- [x] Extract into a fresh separate build directory and recheck every payload hash.
- [x] Compare the existing stable launcher with its receipt and exact release source digest; the launcher is compatible and needs no rebuild.
- [x] Trace the supported install engine and local-only watcher without starting either.
- [x] Fresh resource observation permits local runtime work under the unchanged physical/commit requirements; installation remains separately unverified.
- [ ] Supported installation selects and verifies the new immutable release.
- [ ] A separately chosen restart preserves drafts, authentication and customer state.

## Supported operation

The existing bundled `windows-install-cli.mjs` verifies source and copied inventory, creates an immutable release and atomically changes the owned installation record. Existing releases, stable launcher, shortcuts, profiles and running release bytes remain untouched. It does not close or launch the app. The convenience desktop installer may compile a missing launcher and rewrite shortcuts, so it is unnecessary for this already compatible installation.

The parent must own the actual child and all redirected pipes, keep stdin open through actual process exit and terminal drain, and parse bounded exact result frames. Stdin EOF means parent loss; there is no heartbeat. Quiet verification is not a hang. Unknown publication or closure must remain unknown, with no retry, lock deletion, manual record edit or process-kill shortcut.

The existing watcher reads the local installation record and verifies the selected payload after the installer lock is gone. It does not download source pushes. A banner and human restart are separate acceptance steps; artifact retention alone does not demonstrate either.

## Current resource boundary · 30 October 2026

One fresh read-only preflight passed the existing physical-memory minimum but failed the unchanged available-commit requirement. No installer, local build or downloaded code started. Retain the verified build and continue source/hosted work; do not repeat activation until a meaningful resource change. Disk space and successful extraction do not establish memory headroom.

This note records a verified supported path and an actual blocker, not installation or customer acceptance. See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]].

## Later resource change and focused execution

A later read-only observation found materially improved memory and disk headroom. Both original physical and available-commit thresholds passed before execution. An isolated detached checkout then compiled 642 actual sources and passed the focused Windows query, routing and connection-diagnostic checks. This supersedes the earlier local-runtime resource blocker; it does not imply installation, app closure, restart, Blender generation or Studio acceptance. Preserve the original install verification and parent/child ownership requirements.
