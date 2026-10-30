---
name: arcane-performance
description: "Diagnose and optimize Roblox client, server, rendering, memory and replication costs on representative game workloads while preserving behavior and presentation."
license: MIT
---

# Budget the game players will actually run

## Measure a reproducible workload
Record the exact revision, target device/runtime, player/entity counts, game phase and symptom. Include representative content, HUD, animation, VFX and audio, not only an empty test map. Capture a baseline using available profiling tools; when profiling is unavailable, label the hypothesis instead of inventing measurements.

Separate client CPU, server simulation, rendering/GPU, memory and networking. Use frame-time distributions and spikes as well as averages. A low triangle count cannot explain every slowdown, and a fast desktop is not mobile acceptance. Derive budgets for the chosen devices and gameplay rather than importing universal part, particle or remote limits.

## Remove the cost that evidence identifies
- Script hot paths: reduce repeated tree searches, unnecessary per-frame work, per-object polling and avoidable allocations. Cache stable references with invalidation. Schedule noncritical work and distribute bursts; do not defer essential authority checks until after effects.
- Rendering/content: inspect visible density, transparency/overdraw, shadows, particles, texture memory and animation load. Use appropriate LOD/culling and asset variants while preserving silhouette, gameplay readability and the requested art direction.
- Replication/physics: reduce unnecessary moving assemblies, broadcast fanout and redundant snapshots. Ownership and collision simplification must preserve authoritative outcomes and actual playability.
- Memory/lifetime: track retained connections, tasks, instances, decoded assets and caches across repeated rounds and respawns. Pool only when it saves measured cost, with a complete reset contract and bounded capacity.

Change one causal group at a time and compare the same workload. Readability matters: micro-optimizations without measurable benefit often add bugs. Do not solve a spike by silently removing requested content, reducing player count or disabling essential feedback; explain the trade-off and seek an appropriate target if the requested envelope is infeasible.

## Make streaming part of the design
Client code tolerates absent, arriving and removed instances. Avoid unbounded WaitForChild chains or permanent references to streamed-away content. Rebind interactables/UI safely and keep server rules independent of what one client has loaded. Test fast travel and dense areas, not just spawn. Validate any changed streaming settings against the actual supported engine/project.

## Acceptance includes endurance
Repeat peak combat/crowd/effect scenes, join bursts, map transitions, round restarts and long sessions. Compare paces and costs after warmup, memory growth, server work and replication where observable. Recheck correct outcomes and presentation after optimization. Report measured improvements, regressions and untested devices separately; an asset budget or successful build is a planning constraint, not proof of runtime performance.
