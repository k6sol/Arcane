---
name: arcane-cross-server
description: "Design Roblox matchmaking, queues, teleport handoff and transient cross-server coordination with expiry, retries and recovery."
license: MIT
---

# Cross-server systems

## Separate durable and transient state
Define authoritative membership, queue expiry, match assignment, creator/server identity and duplicate protection. Choose supported transient coordination and durable storage according to the actual lifecycle; do not use a transient cache as permanent player inventory.

Design a claim/lease or reservation flow for a match before dispatching players. Retries must not allocate a player to two matches. Include expired hosts, partial parties, cancellation and server shutdown. Treat messages as signals that may be delayed or missed; re-read authoritative state instead of using a notification as the only truth.

Teleport handoff carries only validated session identifiers and necessary metadata. Receiving servers recheck player eligibility and assignment. Keep sensitive state server-side. Test-mode limitations must be explicit; a Studio mock cannot prove live teleport success.

## Verification
Use deterministic queue fixtures for expiry/replay and, when authorized, a published test universe for real handoff. Simulate a lost host, duplicate signal, failed transfer and reconnect. Show which checks were fixture-only versus cross-server. Prefer a small recoverable protocol over a complex distributed service for a tiny lobby.
