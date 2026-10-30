---
name: arcane-remote-security
description: "Validate Roblox remotes, prompts, touch interactions and value grants with server-owned rules, bounded work, replay protection and legitimate-player regression tests."
license: MIT
---

# Secure consequential actions at the authority boundary

## Enumerate what an attacker can request
For each handler, identify the asset/value/state it can change, the trusted caller identity and the most expensive work it can trigger. The Player supplied to OnServerEvent is the caller; do not accept a second client-selected player as authority. Treat prompt/touch events and client-owned physics as inputs requiring validation too.

Write the contract before the handler: direction, exact payload, server-derived fields, allowed game states, cooldown/rate budget, idempotence key and bounded reply. Prefer action-specific interfaces; if a project has a dispatcher, its allowed actions still need independent schemas and permissions. A generic function name is not validation.

## Validate cheaply before effects
1. Check types, expected keys, lengths, collection counts and finite bounded numbers, including vector components. Reject malformed or cyclic/oversized structures without recursively doing unbounded work.
2. Validate identifiers against server definitions. Check Instances for class, expected ancestry, current existence and relevance; an existing instance is not automatically an allowed target.
3. Check player/session state, ownership, team/round rules, cooldown, loaded profile and sufficient resources. Derive prices, damage, rewards, unlocks and final results on the server.
4. Check plausible distance, line of sight, timing or movement history as the mechanic requires. Calibrate allowances for latency, teleports, vehicles and knockback; a single speed ratio is not a reliable cheat verdict.
5. Commit the authoritative transition without a yielding check/use race, or reserve and revalidate around unavoidable yields. Deduplicate the actual transaction so a replay or concurrent request cannot grant twice.

Rate-limit per player/action and expensive shared resource; bound both processing and rejection logs. Choose rates from legitimate input and burst behavior, not a universal magic number. Denials should not amplify into broadcast or expensive storage work. Give normal players actionable pending/denied feedback without exposing sensitive checks.

## Keep trust boundaries intact
Clients own their presentation and may manipulate their character simulation. Server network ownership can help selected gameplay assemblies where appropriate; it does not turn all physics observations into proof. Avoid blanket bans or forced resets based on one anomaly. Keep secrets and server definitions out of replicated storage.

Filter user-authored text through the supported platform path before showing it to other players. Purchase/receipt fulfillment requires the real server receipt and durable idempotence; a client purchase-finished notification is not payment proof. Persistent multi-key trades need a recovery design, not two independent balance writes.

## Acceptance includes ordinary play
Use an isolated authorized fixture for wrong types, NaN/infinity, oversized payloads, foreign Instances, stale state, distant targets, replay, concurrency and floods. Assert unchanged protected value and bounded work on refusal. Also verify legal rapid input, latency and supported movement still succeed. Run only permitted playtests, preserve their cleanup, and describe residual risks; this checklist is not a claim of an exploit-free game.
