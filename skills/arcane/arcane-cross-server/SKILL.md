---
name: arcane-cross-server
description: "Implement recoverable Roblox matchmaking, parties, teleport handoff and transient coordination with authoritative reservations, leases, expiry and duplicate protection."
license: MIT
---

# Design a recoverable distributed play flow

## Assign one truth to each fact
Specify party membership/leader, queue entry, eligibility, match assignment, server reservation and durable rewards. Use stable IDs and revisions. Separate ephemeral coordination from durable player value: MemoryStore-style queues/leases are not permanent inventory, and messages are notifications rather than the only truth.

Choose a small protocol proportional to the game. A lobby that needs a single recoverable queue should not gain a general distributed framework. Integrate the actual menu/HUD states: idle, queued, reserved, transferring, partial failure and returned. Players need an exit/cancel path, clear party restrictions and a way to recover from a failed transfer.

## Reserve before dispatching
Define atomic claim/lease semantics, expiry and ownership token for queue/match records. Revalidate ownership before advancing after a yield. A stale host must not allocate the same player after a newer host has claimed them. Specify how duplicates, expired queue items, leader changes, absent players, capacity and partial parties are reconciled.

Persist or recover match assignment according to its consequence; don't rely on one message arriving. Treat duplicate/delayed notifications idempotently and read authoritative state. Bound retries, scanning, queue size and per-server work according to supported APIs and observed load. Do not assume exactly-once message delivery.

## Make teleport a handoff, not a success badge
Carry only necessary validated identifiers/metadata. Destination servers recheck the authoritative assignment, player eligibility, allowed source/destination and current match state; teleport data is not a secret or sufficient reward proof. Keep credentials and reservation authority server-side. Distinguish reserved, dispatched, arrived and abandoned members.

Handle teleport failure, disconnect during dispatch, destination timeout and server shutdown without double rewards or indefinite queue ownership. Compensation should return/requeue only members whose actual state permits it. Reconnect must reconcile an old assignment before admitting a second one. Results/awards need their own durable idempotence, especially when the match host disappears.

## Verify the failure schedules
Use deterministic coordination fixtures for competing claims, stale lease, expiry, duplicate message, partial party and host loss. Then, when authorized, use a published test universe for actual teleport/destination arrival and reconnect. Studio mocks cannot prove live teleport, reserved-server behavior or cross-server delivery. Capture both server observations and player-visible recovery; report which stages remain unverified.
