---
name: arcane-remote-security
description: "Review or implement server validation for Roblox remotes, prompts, purchases, damage and rewards; not a promise of exploit-free games."
license: MIT
---

# Remote validation and abuse resistance

## Trace the trusted decision
Start at every reachable entrypoint for the feature: remotes, prompts, touches and callbacks. Locate the authoritative state transition and its owner. Validate sender eligibility, requested action, current state, proximity where relevant, ownership and cooldown before mutating anything.

Check shape and size as well as type. Reject non-finite numbers, invalid identifiers, spoofed tables/instances and references outside permitted containers. Derive price, damage and reward definitions on the server rather than accepting them from the client. Do not confuse a client-side rate limit with server protection.

Bound expensive work with per-action/per-player limits appropriate to real play. Prevent duplicate outcomes through action IDs or authoritative state where needed. Security logging must not become a new spam/memory attack.

## Review trade-offs
Do not invent broad bans from one anomalous packet or reject normal latency without evidence. Explain residual risks and tests. No client-only anti-cheat or obfuscation replaces server validation.

## Verification
Exercise malformed payloads, oversized data, NaN/infinity, stale state, distant requests, replay and flooding in an isolated fixture. Assert authoritative balances/items/damage remain valid and legitimate interaction still works.
