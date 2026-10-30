---
name: arcane-luau-architecture
description: "Implement integrated typed Luau systems with explicit authority, lifecycle, content definitions and client presentation; extend the existing architecture rather than installing a second framework."
license: MIT
---

# Build systems that survive a complete play session

## Trace a vertical feature before splitting modules
Inspect entrypoints, framework conventions, remote contracts and saved fields. Map input -> server decision -> state transition -> replicated view -> UI/world feedback -> persistence or cleanup. Define success, denial, interruption and retry behavior. For a broad game request, deliver connected systems and meaningful content; a service skeleton, empty catalog or disconnected menu is not a finished feature. For a focused fix, keep this map limited to affected seams.

Represent important modes as explicit states and legal transitions: for example loading/ready/closing for a profile, or lobby/active/results/reset for a round. Each transition has one authority, entry/exit work and a failure path. Do not let multiple scripts independently infer the winner, spend currency or own respawn. Make timers use an authoritative deadline and cancellation identity so a delayed callback cannot modify the next round.

## Choose module boundaries by ownership
- Server services own shared rules, rewards, inventory changes and persistence. Client controllers own input, camera, HUD and cosmetic prediction. Shared modules contain non-secret types, definitions and pure logic; replication is not secrecy.
- Export typed interfaces under `--!strict`, but validate untrusted data at runtime. Keep initialization separate from `require` side effects. Resolve dependencies explicitly and make start/stop behavior clear; avoid cyclic requires and waits that can never complete.
- Separate content definitions from mechanics: stable IDs, tunable values, unlock conditions and presentation references. Validate definitions at startup and give missing assets an explicit unavailable/error state rather than invisible functionality.
- Reuse the project's service/controller conventions. A small feature may need two modules, not a dependency-injection framework. Preserve existing APIs or migrate all actual callers deliberately.

## Own asynchronous work and instances
Give each player, character, round and screen one cleanup owner. Disconnect handlers, cancel owned timers/tweens, release input and destroy temporary instances on the matching lifetime. Register existing players as well as PlayerAdded, make duplicate setup harmless, and guard callbacks that resume after death, removal or a new generation. A cleanup error must not prevent the remaining owned cleanup attempts.

Use events for state changes; schedule simulation and visual work according to the mechanic. Render callbacks are client presentation and must not yield. Do not impose a universal network send rate or manager frequency: derive budgets from participants, responsiveness and measurements. CollectionService binders need GetTagged, GetInstanceAddedSignal and GetInstanceRemovedSignal with matching cleanup. TweenService tweens and RunService connections need an owner; task.wait is a bounded scheduling choice, not an unbounded polling architecture.

## Deliver through the actual Arcane surface
Use script_search/script_read to find ownership and exact baselines. Create new scripts disabled, write complete source with script_update, then activate only through `script_set_enabled` and its syntax gate. Remotes unsupported by the scene class allowlist can be created by the game's explicit server bootstrap, not by an invented tool. Respect the advertised scene properties; tags/attributes may need runtime initialization. Keep data-mutating activation within `arcane-datastore-safety` scope.

[Patterns](references/patterns.md), loaded as `arcane-luau-architecture:patterns`, provide small examples, not a complete game, persistence implementation or performance guarantee. Adapt their ownership, validation and cleanup to the real feature; never ship a placeholder handler as the final outcome.

Acceptance requires actual entry-to-result play, denied actions, rejoin/respawn as applicable and repeated cycles without duplicate listeners or stale state. Verify UI and relevant models/animation/VFX/SFX respond to the same authoritative transitions. Record unsupported multiplayer/device tests instead of declaring them passed.
