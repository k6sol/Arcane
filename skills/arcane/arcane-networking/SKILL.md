---
name: arcane-networking
description: "Design and implement Roblox multiplayer protocols, replication and responsive prediction with authoritative state, bounded traffic and reconnect behavior."
license: MIT
---

# Treat multiplayer as an explicit protocol

## Define the contract at the feature boundary
For each action, record direction, payload shape, stable content IDs, ownership, permitted states, sequence/request identity, expected response and timeout behavior. Identify what must be authoritative, what each player may see, and what is disposable presentation. Extend the existing protocol instead of adding a second inventory, match or combat truth.

Clients submit intent; servers derive consequential values and validate them through `arcane-remote-security`. Model the UI path too: ready, pending, accepted, denied and disconnected must be distinguishable. A disabled button is not a server lock, and a slow response is not a denial. Choose RemoteEvents with correlated replies for asynchronous actions. A RemoteFunction is appropriate only for a bounded query whose yielding and failure behavior is understood; do not make server progress depend on an untrusted client's reply.

## Replicate enough to reconstruct state
Use a versioned snapshot for initial/late join and compact deltas for changes. Define how a client detects a missed revision, replaces stale state and requests a fresh view. Apply updates in their intended entity/session scope so an old round or respawn packet cannot overwrite the new one. Bound pending requests and retain idempotence for the actual value-granting operation, not an arbitrary client-generated success flag.

Send private results to their owner and relevant public state to interested observers. Avoid whole inventories on every click or per-frame global broadcasts. Derive rates and sizes from player count, active entities and tested bandwidth; batch compatible state without delaying critical feedback. Reliable traffic carries required state transitions. Loss-tolerant cosmetic samples may use a supported unreliable channel only if omission/reordering is harmless.

## Make responsiveness compatible with truth
Predict local presentation when it has a correction policy: input sequence, authoritative acknowledgement, reconciliation and bounded visual smoothing. Keep rewards, collisions that decide scoring, and scarce ownership server-controlled. Separate immediate animation/audio feedback from a confirmed result so a rejected action does not leave a false reward or equipped item. Do not synchronize entire animation/VFX instances when a small validated state/event suffices.

Handle late dependencies, streaming disappearance, disconnect and reconnect explicitly. Remove per-player queues/listeners and expire obsolete request scopes; do not replay an ambiguous purchase or teleport as an ordinary network retry.

## Verify the multiplayer path
Exercise simultaneous conflicting actions, duplicate requests, delayed acknowledgement, stale revisions, late join, respawn and disconnect during a pending action. Check both authoritative state and what each client actually sees, including denial feedback and correction. A single-client injected fixture can validate a reducer or schema, but not real latency, ownership or replication. State the available client/server observations and remaining native tests.
