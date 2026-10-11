---
name: arcane-networking
description: "Design client-server requests, state replication and prediction for Roblox multiplayer without trusting client-owned outcomes."
license: MIT
---

# Replication and network contracts

## Define the protocol
Identify who owns each state field, which changes need replication and which are purely cosmetic. Specify request IDs, payload schemas, bounded values, response/error semantics and lifecycle. Use current engine APIs only after verifying the selected project's supported version.

Clients request intent; the server checks permission and state before applying rewards, damage or shared transitions. Replicate compact state changes, not every rendered frame or entire inventory on each click. A reliable request needs a bounded response path; avoid recursive or indefinitely yielding remote calls.

Use prediction for responsive presentation only where correction is defined. Distinguish delayed acknowledgement from denial. Include sequence/revision handling for stale updates and clear rejoin/late-join reconstruction.

## Failure behavior
A lost client, duplicate action or out-of-order presentation update must not corrupt authoritative state. Preserve cleanup for per-player handlers. Avoid synchronized broadcast bursts and accidental per-frame fanout.

## Verification
Test simultaneous input, duplicate requests, delayed results, late join and disconnect. Record real client/server observations; bots or injected state alone do not establish network correctness. Route economic/damage payload review to the security checklist when those outcomes are involved.
