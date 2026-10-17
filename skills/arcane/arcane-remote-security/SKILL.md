---
name: arcane-remote-security
description: "Review or implement server validation for Roblox remotes, prompts, purchases, damage and rewards; not a promise of exploit-free games."
license: MIT
---

# Remote validation and abuse resistance

## Server checklist for every remote, prompt and touch
1. Rate limit per player and action (token bucket, e.g. 2/s burst 4 for purchases, 10/s for combat input). Drop silently over the limit.
2. Type and shape: `typeof` each argument, reject NaN/inf (`v == v`, bounded magnitude), cap string length (ids <= 32 chars, `[%w_-]` only) and table size. Never accept Instances outside expected containers.
3. State: the player is alive, in the right round or zone, owns the item, and the cooldown has passed (server clock).
4. Proximity: `(target.Position - root.Position).Magnitude <= limit` (interaction 10-12 studs plus a small latency margin).
5. Server-derived values: price, damage, reward and drop tables come from server definitions. The client sends only ids and intent.
6. Idempotence: action ids or authoritative state so a replayed request cannot grant twice.
A ready-made guard (rate limiter + validators) is in reference `arcane-luau-architecture:patterns`.

## Anti-exploit basics
- Clients fully control their own character physics and any LocalScript. Client-side checks and obfuscation are UX, not protection.
- Movement sanity on the server (10 Hz): horizontal speed above WalkSpeed x 1.5 for over 1 s, or a jump in position beyond 3x expected, resets the player to the last valid position. Log it; do not ban on one sample.
- Unanchored server-owned parts that matter (doors, loot, NPCs): `SetNetworkOwner(nil)`.
- Touched rewards: handle on the server, debounce per player, and check the toucher's distance and state.
- Keep secrets, admin lists and server modules in ServerScriptService or ServerStorage, never ReplicatedStorage.
- Never use client-provided text for anything without `TextService` filtering when other players will see it.
- Security logging is rate limited too, so it cannot become a memory or spam attack.

## Trade-offs
Do not reject normal latency or invent broad bans from one anomalous packet. Explain residual risks. Persistence safety: `arcane-datastore-safety`.

## Verification
Exercise malformed payloads, oversized data, NaN/inf, stale state, distant requests, replay and flooding in an isolated fixture. Assert balances, items and damage stay valid and legitimate play still works.
