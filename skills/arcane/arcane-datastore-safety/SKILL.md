---
name: arcane-datastore-safety
description: "Write or review Roblox DataStore code that never loses or overwrites player data: pcall with budgeted retries, UpdateAsync, session locking, BindToClose and Studio API-access awareness."
license: MIT
---

# DataStore safety

## Hard rules
- Never wipe, rename, re-key or migrate existing DataStore names or keys unless the user explicitly asks for that exact change. A new schema reads the old key and upgrades in memory.
- Never run data-mutating code while editing. Arcane edits source and scene only. Do not enable a script that writes DataStores, and do not start a playtest whose purpose is to write live data, without an explicit request.
- Studio writes to the real DataStores of the place's experience when "Enable Studio Access to API Services" is on. Warn about this before anything could write. Use a separate test experience or a key prefix such as "Test_" for experiments.
- A failed load must never be saved over with defaults. Mark the profile failed, kick or retry, and do not save it.

## Required patterns
- **Wrap every call**
  - Put every GetAsync/UpdateAsync/SetAsync/RemoveAsync in pcall.
  - Retry 3-5 times with exponential backoff (1, 2, 4, 8 s) plus jitter, then fail closed.
  - Before each attempt, check `DataStoreService:GetRequestBudgetForRequestType(Enum.DataStoreRequestType.X)` and wait while it is 0.
- **Use UpdateAsync, not SetAsync, for player data**
  - Read-modify-write inside the transform function.
  - Return nil to cancel.
  - Never yield inside the transform.
- **Session lock**
  - Store `{ lock = { jobId = game.JobId, time = os.time() }, version = n, data = ... }`.
  - On join, UpdateAsync to claim the lock only if it is empty or older than about 30 minutes; otherwise retry, then kick.
  - On leave, save and release in the same UpdateAsync.
- **Autosave**: every 60-120 s per player, staggered across players, respecting budget.
- **Shutdown**
  - In `game:BindToClose`, save every loaded player in parallel tasks and wait for them.
  - Allow at most about 25 s.
  - In Studio, skip or shorten this unless API access is intended.
- **Schema**
  - Store a `version` field.
  - Migrations are pure functions, old to new, and are tested on copies.
  - Keep unknown fields; never downgrade.
- **Value safety**: use idempotent receipts (processed purchase IDs) for purchases and rewards, so a retry cannot grant twice.
- **Ordered and other stores**
  - OrderedDataStore is for leaderboards only, never the source of truth.
  - MemoryStore is ephemeral.

## Review checklist
- [ ] No unconditional SetAsync on player keys.
- [ ] No save after a failed load.
- [ ] pcall, retries and budget checks on every call.
- [ ] Lock is claimed and released.
- [ ] BindToClose waits for saves.
- [ ] Studio API-access risk stated.
- [ ] No key wipe or rename.
- [ ] Code is written disabled and never executed by Arcane without explicit consent.
