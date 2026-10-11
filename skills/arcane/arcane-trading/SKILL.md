---
name: arcane-trading
description: "Design Roblox trading and gifting with explicit consent, ownership, durable recovery and no false multi-record atomicity claims."
license: MIT
---

# Recoverable item trading

## Define the transaction
Specify participants, eligible items, offer versions, confirmation and cancellation states. Changing an offer invalidates prior confirmation. The server resolves actual ownership and values; the client cannot supply a trusted balance or item record.

A trade spanning player records needs an explicit durable intent/recovery protocol and a reconciliation policy. Do not describe separate saves as one atomic transaction. Prevent replay, double spending and simultaneous transfer of the same owned item.

Protect disconnect/rejoin, expired sessions and storage failure. Keep both participants informed without falsely reporting success before the chosen durable commit criterion. Audit only necessary transaction facts.

## Verification
Exercise offer edits after confirmation, concurrent trades, invalid/NaN values, disconnect at each transition and interrupted save/restart. Assert no duplicated or silently lost ownership and recovery is deterministic. Use isolated profiles/test stores. If the project cannot support safe durable transfer yet, disable trading rather than ship a cosmetic success flow.
