---
name: arcane-datastore-safety
description: "Protect existing Roblox player data while implementing loads, ownership, budgeted writes, migrations and shutdown; use for storage safety, not promises of loss-free persistence."
license: MIT
---

# Protect data before adding save behavior

## Establish the real storage boundary
Search existing source for GetDataStore/GetOrderedDataStore and profile libraries before changing anything. Preserve store names, scopes, key format, field meaning and the single writer. Do not wipe, rename, re-key, remove or migrate existing data without the user's explicit request for that operation. A new default field and a destructive schema migration are different changes.

Author storage code without executing live writes by default. Studio API access can reach the experience's real data; do not enable a writer or run a live-data test merely to check syntax. Use an authorized separate test experience or isolated test keys, and state which namespace is touched. A fake/in-memory adapter is useful but is not a live persistence test.

## Make profile state explicit
Use loading, ready, load-failed, closing and ownership-lost states. Only ready, legitimately owned profiles may grant/spend value or save. Distinguish a confirmed absent key from a failed read: failed load must never produce a default profile that later overwrites real data. UI should show loading/failure honestly and withhold purchases/rewards while unavailable.

Use the existing tested profile library when present. For custom ownership, acquire in UpdateAsync using a unique session token, renew while owned, and verify that exact token on every save/release. A timestamp or game.JobId alone is not a sufficient takeover protocol. Define lease expiry, heartbeat delay, stale-owner fencing and what happens if a server resumes after takeover. Do not select a universal timeout or steal a lock merely because a player rejoined.

## Make each write retry-safe
Wrap storage calls, respect current request budgets, and use bounded backoff with jitter and an overall deadline. Do not issue a write after its budget wait has expired. Retry only classified transient failures and stop on lost ownership, invalid data or an unsupported schema. Surface unresolved saves rather than reporting success from pcall alone.

UpdateAsync transforms may be invoked again: keep them non-yielding and free of external effects. Return nil to cancel deliberately; inspect the returned value and application result so a cancelled transform is not treated as a committed save. Serialize/coalesce per-profile writes; prevent a delayed old snapshot from overwriting newer progress. Mark a dirty revision clean only after its actual commit.

Persist receipt/reward deduplication with the value it protects. Multi-key trades are not atomic just because each key uses UpdateAsync. Bound processed-ID retention according to the operation's recovery requirements, not a blanket truncation that permits replay.

## Migrate and close deliberately
Validate stored types, sizes and versions. Migrate known old shapes through pure copy-based transforms, preserve compatible unknown fields and refuse future versions rather than downgrading them. Keep a rollback/backup plan appropriate to the requested migration.

Autosave on a staggered measured schedule; shutdown is an additional opportunity, not the sole save path. Player removal and BindToClose must share the same owned close/save operation and bounded join. A timeout or rejected write remains unresolved; do not clear the profile and announce Saved prematurely.

[Template](references/template.md) is a starting example, not a verified persistence library. Review its lock policy, callback cancellation results, concurrent saves, schema handling and retry deadlines before use; do not copy its constants as platform guarantees.

Accept only with fixtures for absent/failed load, concurrent sessions, stale writer, repeated receipt, save retry/cancellation, old/future schema and shutdown. Real storage checks need their own authorized namespace. Report actual committed results and unresolved risk without a no-data-loss promise.
