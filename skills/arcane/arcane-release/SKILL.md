---
name: arcane-release
description: "Prepare and deliver a specific Roblox game revision with feature/content readiness, asset permissions, compatible data, staged verification and truthful rollback/publication boundaries."
license: MIT
---

# Release the playable product, not just compiled source

## Identify the release unit
Record exact source/config/assets, target place/universe, creator, audience and intended change. Distinguish local save, test/staging publication and production release. Existing edit access is not blanket publication authority. Use only the actual supported publishing route and the user's authorized target.

Inspect the existing release process and preserve manual work. Inventory required models/textures/audio/animations, runtime permissions, content definitions, UI flows and server configuration. A successful local import does not prove published asset access. Missing core content, placeholder menus or unreachable mechanics must remain explicit blockers for a complete-game release.

## Verify compatibility before rollout
Check old/new server and profile versions, migration behavior, feature flags and client protocol expectations. Prevent old servers from overwriting newer data. Exercise returning players, first-time players, late join, respawn and the actual entry-to-result/replay loop. Include loading/denied/service-failure UI and relevant device/input configurations.

Use `arcane-playtest-qa` for observed behavior and `arcane-performance` for representative load. Review asset ownership/licensing and platform constraints where applicable. Verify server authority and consequential transactions, not only happy-path visuals. Do not turn an unchecked API permission, external asset or data write into an assumed success.

## Make rollout and rollback concrete
Define staging checks, rollout audience/order, stop conditions and responsible control path. Keep the previous tested artifacts/config and specify what can actually be restored. Source rollback does not undo transactions, player-created content or already-migrated data. Destructive resets/migrations need their own exact scope; they are not routine release cleanup.

A kill switch must leave the base game coherent: safe state, understandable UI and preserved progress. Do not rely on a flag alone if old servers cannot interpret the new content. Keep version/status visible enough to correlate reports without exposing secrets or private player data.

## Acceptance after the authorized publication
Check the actual published revision with start/join/rejoin, critical progression and asset loadability in the intended environment. Inspect relevant logs, recovery behavior and measured outcomes. Record build checks, staged play, publication and live observations separately. CI passing or a local screenshot is not live game acceptance, and an authored release plan is not publication. Report unresolved limits without marketing or retention guarantees.
