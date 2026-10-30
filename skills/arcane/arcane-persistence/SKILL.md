---
name: arcane-persistence
description: "Design game progress, inventory and economy persistence across rejoin, migrations and interrupted transactions; integrate durable state with honest player-facing save behavior."
license: MIT
---

# Make game progress recoverable

## Define what persists and why
Inventory the current profile owner, schema, key layout, libraries and callers. Classify fields as durable progression, derived view, session-only state or transient coordination. Specify stable content IDs and the behavior when a definition is removed or renamed. Keep inventory/equipment, quests, unlocks and currency consistent with the game's actual loop; a leaderstats display is not a database.

Route storage ownership, API budgets and live-data safeguards through `arcane-datastore-safety`. This skill owns the domain contract: which action is committed, how it is recovered, and what the player sees. Extend a tested existing system instead of adding a second save script.

## Model mutations, not just snapshots
Expose one server-owned interface for reads and consequential mutations. Refuse actions until the profile is ready. Validate against current definitions and retain a revision/transaction identity where replay matters. Keep check and mutation together; asynchronous validation needs reservation and revalidation before commit.

For a reward, purchase or quest claim, specify the durable result and idempotence record together. For operations across players/keys, define intent, reservation, commit and reconciliation, including crashes between steps. Do not promise multi-key atomicity or compensate by granting twice. Where the product can avoid a distributed trade, prefer a simpler single-owner transaction.

Keep server state, client projection and durable confirmation distinct. The HUD may show immediate pending feedback, but a Saved badge requires an actual observed write. Retry unresolved work according to the transaction's semantics; a reconnect should reconstruct committed progress rather than replay every client request.

## Evolve content and schema together
Version schema and content independently when they change at different rates. Migrations must define defaults, removed fields, unknown/future versions and invalid records. Run transformations on copies, preserve recoverable source and test representative real shapes without exposing personal data. Source rollback cannot undo spent currency or a migrated record; explain that boundary before production migration.

Handle loading failure, ownership loss, full inventory, unavailable item definitions, interrupted grant and shutdown explicitly. Persist only the data needed to recover; caches, MemoryStore and OrderedDataStore leaderboards are not substitutes for the authoritative profile. Clear temporary references on player departure without discarding an unresolved owned save silently.

## Acceptance follows the player journey
Test first join, return join, session overlap, repeated claim, disconnect at each transaction boundary, write failure and old/future schemas. Verify inventory/equipment/HUD agree after rejoin and a failed load never becomes default progress. Include a content update where an old saved ID is still handled deliberately. Distinguish deterministic adapter tests from actual authorized DataStore behavior and list unresolved saves separately.
