---
name: arcane-remote-security
description: "Networking security checklist: design and validate Roblox remotes, prompts, purchases, damage and rewards with server authority, type checks and rate limits; not a promise of exploit-free games."
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

## Remote contract (decide before writing code)
- Per remote: name, direction, payload types, rate limit, server checks, reply. Example: `BuyItem(itemId: string)` client to server, 2/s burst 4, reply `ShopResult(itemId, ok, reason)`.
- RemoteEvent for intent; reply with a separate server-to-client event. RemoteFunction only for quick client-to-server queries; never `InvokeClient` from the server (a client can yield forever); client `InvokeServer` goes in pcall. UnreliableRemoteEvent only for cosmetic, droppable updates.
- The server creates remotes at start; clients `WaitForChild(name, 10)` and handle nil. One remote per action, not a generic "DoAction(name, ...)" dispatcher.

## Never accept from the client
Prices, currency amounts, damage, hit results, rewards, cooldowns, timestamps, item stats, team, health, or "I won". The client may send ids, on/off intent, a unit aim direction, or a target Instance that the server checks for type, container and distance. Client-side checks (disabled buttons, cooldown rings) are UX only.

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
Exercise malformed payloads, oversized data, NaN/inf, stale state, distant requests, replay and flooding in an isolated fixture. Assert balances, items and damage stay valid and legitimate play still works. Then run the `arcane-playtest-qa` script check loop: fix only your handlers' errors, at most 3 fixes, stop the run.
